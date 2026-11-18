"""FastAPI app: JSON/binary API under /api, static frontend at /."""

from __future__ import annotations

import asyncio
import dataclasses
import itertools
import json
import logging
import math
import struct
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

import numpy as np

from . import archive, cache, catalogs, config, objects, processing, scene3d, system3d
from .archive import Frame, UpstreamError
from .geometry import Grid, mjd_to_jyear, npix_for, propagate, std_to_sky

log = logging.getLogger("spherex_app")
if not log.handlers:  # uvicorn only configures its own loggers
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    log.addHandler(_h)
    log.setLevel(getattr(logging, config.LOG_LEVEL, logging.INFO))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await catalogs.close()
    await archive.close()


app = FastAPI(title="SPHEREx sky viewer backend", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "OPTIONS"],
                   allow_headers=["*"])


@app.exception_handler(UpstreamError)
async def _upstream(_req: Request, exc: UpstreamError):
    return JSONResponse({"detail": f"upstream archive error: {exc}"}, status_code=502)


@app.exception_handler(catalogs.NotFound)
async def _notfound(_req: Request, exc: catalogs.NotFound):
    return JSONResponse({"detail": str(exc)}, status_code=404)


# --- validation helpers ---------------------------------------------------------------

def _bad(msg: str):
    raise HTTPException(status_code=400, detail=msg)


def _check_pos(ra: float, dec: float, what="ra/dec"):
    if not (math.isfinite(ra) and math.isfinite(dec)) or not (0 <= ra <= 360) or not (-90 <= dec <= 90):
        _bad(f"{what} out of range (0<=ra<=360, -90<=dec<=90)")
    return ra % 360.0, dec


def _parse_detectors(s: str) -> list[int]:
    try:
        dets = sorted({int(x) for x in s.replace(" ", "").split(",") if x})
    except ValueError:
        _bad("detectors must be a comma-separated list of integers 1-6")
    if not dets or any(d not in config.DETECTORS for d in dets):
        _bad("detectors must be a comma-separated list of integers 1-6")
    return dets


def _check_common(fov, scale, max_frames):
    if not config.FOV_MIN_DEG <= fov <= config.FOV_MAX_DEG:
        _bad(f"fov must be between {config.FOV_MIN_DEG} and {config.FOV_MAX_DEG} deg")
    if not config.SCALE_MIN_ARCSEC <= scale <= config.SCALE_MAX_ARCSEC:
        _bad(f"scale must be between {config.SCALE_MIN_ARCSEC} and {config.SCALE_MAX_ARCSEC} arcsec")
    npix = npix_for(fov, scale)
    if npix > config.NPIX_MAX:
        _bad(f"fov/scale gives {npix} px > {config.NPIX_MAX}; increase scale")
    if not 1 <= max_frames <= config.MAX_FRAMES_CAP:
        _bad(f"max_frames must be between 1 and {config.MAX_FRAMES_CAP}")
    return npix


def _motion(pmra, pmdec, epoch):
    if pmra is None and pmdec is None:
        return None
    return (pmra or 0.0, pmdec or 0.0, epoch if epoch is not None else 2000.0)


def _pos_at(ra, dec, motion, mjd):
    if motion is None or mjd is None:
        return ra, dec
    return propagate(ra, dec, motion[0], motion[1], motion[2], mjd)


def _mid_mjd(f: Frame):
    return 0.5 * (f.mjd + f.mjd_end)


PROGRESS_INTERVAL_S = 2.0  # /api/stream heartbeat period while frames are outstanding

_cpu_sem: asyncio.Semaphore | None = None


async def _run_cpu(fn, *args):
    """Run CPU-bound work in a worker thread, at most CPU_CONCURRENCY at a time."""
    global _cpu_sem
    if _cpu_sem is None:
        _cpu_sem = asyncio.Semaphore(config.CPU_CONCURRENCY)
    async with _cpu_sem:
        return await asyncio.to_thread(fn, *args)


_fit_sem: asyncio.Semaphore | None = None


async def _run_fit(fn, *args):
    """Run a source-model fit in a worker thread, at most FIT_CONCURRENCY at a time. Fits have
    their own limit so that queued fits never hold back the raw products of later frames."""
    global _fit_sem
    if _fit_sem is None:
        _fit_sem = asyncio.Semaphore(config.FIT_CONCURRENCY)
    async with _fit_sem:
        return await asyncio.to_thread(fn, *args)


# --- endpoints -------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/resolve")
async def resolve(q: str = Query(..., min_length=1, max_length=200)):
    return await catalogs.resolve(q)


@app.get("/api/frames")
async def frames(ra: float, dec: float):
    ra, dec = _check_pos(ra, dec)
    fr = await archive.find_frames(ra, dec)
    by_det = {str(d): 0 for d in config.DETECTORS}
    for f in fr:
        by_det[str(f.detector)] = by_det.get(str(f.detector), 0) + 1
    return {"ra": ra, "dec": dec, "count": len(fr), "frames": [f.public() for f in fr],
            "by_detector": by_det}


def _record(obj: dict, payload: bytes = b"") -> bytes:
    j = json.dumps(obj, separators=(",", ":"), allow_nan=False).encode()
    return struct.pack("<I", len(j)) + j + payload


async def _select(ra, dec, detectors, mjd_min, mjd_max, max_frames, per_visit=None):
    allf = await archive.find_frames(ra, dec)
    return archive.select_frames(allf, set(detectors), mjd_min, mjd_max, max_frames, per_visit)


def _check_per_visit(per_visit):
    if per_visit is not None and not 1 <= per_visit <= config.MAX_FRAMES_CAP:
        _bad(f"per_visit must be between 1 and {config.MAX_FRAMES_CAP}")


# --- source model (model=1) --------------------------------------------------------------

@dataclasses.dataclass
class _LocalPrior:  # same fields as sources.Prior in the contract
    x: float
    y: float
    cat: dict


def _clean(o):
    """JSON-safe copy: numpy scalars/arrays to python, NaN/inf to None."""
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return _clean(o.tolist())
    if isinstance(o, np.generic):
        o = o.item()
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return o


def prior_radius(fov: float) -> float:
    """Radius (deg) of the catalogue query that seeds the source fit of a field of view `fov`."""
    return fov * 0.7072 + 0.02


def _prior_tag(names) -> str:
    """Cache-key part naming the catalogues a fit used ("gaia+catwise", "gaia", or "none")."""
    return "+".join(c for c in config.PRIOR_CATALOGS if c in names) or "none"


def _superset_tags(names) -> list[str]:
    """Tags of every catalogue subset that contains all of `names`, largest first. A cached fit
    that used more catalogues than are available right now is still a valid result."""
    names = set(names)
    cats = config.PRIOR_CATALOGS
    return ["+".join(combo) or "none"
            for k in range(len(cats), -1, -1)
            for combo in itertools.combinations(cats, k)
            if names <= set(combo)]


def _model_key(uri, ra, dec, size, grid: Grid, tag: str) -> str:
    return cache.key_hash("model", config.MODEL_VERSION, uri, f"{ra:.7f}", f"{dec:.7f}",
                          f"{size:g}", f"{grid.ra:.7f}", f"{grid.dec:.7f}", grid.scale,
                          grid.npix, tag)


def _cached_model(ckey: str, npix: int):
    """(model, bg bytes, leftover bytes) from the disk cache, or None on miss or corrupt entry."""
    hit = cache.get_bytes("model", ckey)
    if hit is None:
        return None
    try:
        return _unpack_model(hit, npix)
    except (ValueError, struct.error):
        return None


class _StreamPriors:
    """Catalogue priors for one stream, resolved on first use (never before frames start)."""
    def __init__(self, ra, dec, fov):
        self.ra, self.dec, self.radius = ra, dec, prior_radius(fov)
        self._fut = None

    async def get(self) -> tuple[list[dict], frozenset]:
        if self._fut is None:
            self._fut = asyncio.ensure_future(self._load())
        return await asyncio.shield(self._fut)

    async def _load(self):
        got = await asyncio.gather(*(catalogs.prior_catalog(c, self.ra, self.dec, self.radius,
                                                            wait=config.PRIOR_WAIT_S)
                                     for c in config.PRIOR_CATALOGS))
        cats = {c: rows for c, rows in zip(config.PRIOR_CATALOGS, got) if rows is not None}
        return _prior_rows(cats), frozenset(cats)


def _prior_rows(cats: dict) -> list[dict]:
    """Brightness-limited catalogue rows with the fields needed for propagation."""
    rows = []
    for name, limit, label in (("gaia", config.PRIOR_GAIA_G_MAX, "Gaia DR3 "),
                               ("catwise", config.PRIOR_CATWISE_W2_MAX, "")):
        for r in cats.get(name) or []:
            mag = r.get("mag")
            pm = math.hypot(r.get("pmra") or 0.0, r.get("pmdec") or 0.0)
            fast = pm >= config.PRIOR_FAST_PM_MASYR
            if not fast and (mag is None or mag > limit):
                continue
            rows.append({"ra": r["ra"], "dec": r["dec"], "pmra": r.get("pmra") or 0.0,
                         "pmdec": r.get("pmdec") or 0.0, "epoch": r.get("epoch"),
                         "fast": fast, "mag": mag if mag is not None else 99.0,
                         "cat": {"catalog": name, "id": f"{label}{r.get('id')}", "mag": mag,
                                 "parallax_mas": r.get("plx"), "pmra": r.get("pmra"),
                                 "pmdec": r.get("pmdec")}})
    rows.sort(key=lambda r: (not r["fast"], r["mag"]))
    return rows


def _priors_at(rows: list[dict], grid: Grid, mjd: float, prior_cls) -> list:
    """Propagate catalogue rows to `mjd`, keep those inside the grid, cap at PRIOR_MAX."""
    if not rows:
        return []
    ra = np.array([r["ra"] for r in rows], float)
    dec = np.array([r["dec"] for r in rows], float)
    ep = np.array([r["epoch"] if r["epoch"] is not None else np.nan for r in rows], float)
    dt = np.where(np.isfinite(ep), mjd_to_jyear(mjd) - ep, 0.0)
    xi = np.array([r["pmra"] for r in rows]) * dt / 1000.0
    eta = np.array([r["pmdec"] for r in rows]) * dt / 1000.0
    moved = (xi != 0) | (eta != 0)
    if moved.any():
        r2, d2 = std_to_sky(xi[moved], eta[moved], ra[moved], dec[moved])
        ra[moved], dec[moved] = r2, d2
    x, y = grid.sky_to_pix(ra, dec)
    pad = config.PRIOR_PAD_PX
    keep = np.isfinite(x) & np.isfinite(y) & (x >= -pad) & (x <= grid.npix - 1 + pad) \
        & (y >= -pad) & (y <= grid.npix - 1 + pad)
    out = []
    for i in np.flatnonzero(keep)[:config.PRIOR_MAX]:  # rows are already brightest first
        out.append(prior_cls(x=float(x[i]), y=float(y[i]), cat=dict(rows[i]["cat"])))
    return out


def _psf_fwhm_px(meta: dict, detector: int, grid: Grid) -> float:
    """Effective PSF FWHM in grid px for the point-sampled Gaussian model."""
    return processing.effective_psf_px(meta.get("psf_fwhm_arcsec"), detector, grid.scale)


def _pack_model(bg: np.ndarray, left: np.ndarray, model: dict) -> bytes:
    j = json.dumps(model, separators=(",", ":")).encode()
    return struct.pack("<I", len(j)) + j + bg.astype("<f4").tobytes() + left.astype("<f4").tobytes()


def _unpack_model(blob: bytes, npix: int):
    n = struct.unpack_from("<I", blob)[0]
    model = json.loads(blob[4:4 + n])
    body = blob[4 + n:]
    plane = npix * npix * 4
    if len(body) != 2 * plane:
        raise ValueError("model cache entry has wrong size")
    return model, body[:plane], body[plane:]


def fit_model(img: np.ndarray, flags: np.ndarray, bits: dict, meta: dict, detector: int,
              grid: Grid, rows: list[dict], mjd: float, ckey: str):
    """Fit sources in one resampled frame and store it under `ckey` (callers check the cache
    first). Returns (model dict, bg bytes, leftover bytes). Never raises for fit problems: falls
    back to a flat background, which is not cached."""
    psf = _psf_fwhm_px(meta, detector, grid)
    try:
        from . import sources  # written by the source-fitting workstream
        prior_cls = getattr(sources, "Prior", None) or _LocalPrior
        priors = _priors_at(rows, grid, mjd, prior_cls) if rows else []
        bad = ((flags & processing.bad_mask(bits)) != 0) | ~np.isfinite(img)
        fm = sources.fit_frame(img, bad, psf, priors or None)
        for src in fm.sources:
            cat = src.get("cat")
            if isinstance(cat, dict) and "sep_px" in cat and "sep_arcsec" not in cat:
                cat["sep_arcsec"] = round(float(cat["sep_px"]) * grid.scale, 3)
        bg = np.asarray(fm.background, np.float32)
        left = np.asarray(fm.leftover, np.float32)
        model = _clean({"psf_fwhm_px": fm.psf_fwhm_px, "noise": fm.noise, "quality": fm.quality,
                        "sources": fm.sources})
    except Exception as e:  # noqa: BLE001
        log.warning("source fit failed (%s: %s); sending flat background", type(e).__name__, e)
        med = float(np.nanmedian(img)) if np.isfinite(img).any() else 0.0
        bg = np.full(img.shape, med, np.float32)
        left = (img - bg).astype(np.float32)
        model = {"psf_fwhm_px": psf, "noise": meta.get("noise"), "quality": None,
                 "sources": [], "error": str(e)[:200]}
        return model, bg.astype("<f4").tobytes(), left.astype("<f4").tobytes()
    cache.put_bytes("model", ckey, _pack_model(bg, left, model))
    return model, bg.astype("<f4").tobytes(), left.astype("<f4").tobytes()


def _model_mode(s: str) -> str:
    """model= query value -> "off", "inline" (model=1) or "progressive"."""
    v = (s or "").strip().lower()
    if v in ("0", "", "false", "no"):
        return "off"
    if v in ("1", "true", "yes"):
        return "inline"
    if v == "progressive":
        return "progressive"
    _bad("model must be 0, 1 or progressive")


@app.get("/api/stream")
async def stream(ra: float, dec: float, fov: float = 0.1, scale: float = config.NATIVE_SCALE_ARCSEC,
                 detectors: str = "1,2,3,4,5,6", mjd_min: float | None = None,
                 mjd_max: float | None = None, max_frames: int = config.MAX_FRAMES_DEFAULT,
                 pmra: float | None = None, pmdec: float | None = None,
                 epoch: float | None = None, per_visit: int | None = None, model: str = "0"):
    """Frames of the field as a stream of length-prefixed records (see docs/blink-architecture.md).

    model=0: raw frames only. model=1 (inline): each frame record waits for its source model and
    carries it. model=progressive: each frame record goes out as soon as its raw product is ready
    (no "model" key), and one {"type": "model", "id"} record follows it with the model."""
    mode = _model_mode(model)
    ra, dec = _check_pos(ra, dec)
    npix = _check_common(fov, scale, max_frames)
    _check_per_visit(per_visit)
    dets = _parse_detectors(detectors)
    motion = _motion(pmra, pmdec, epoch)
    sel, n_avail = await _select(ra, dec, dets, mjd_min, mjd_max, max_frames, per_visit)
    grid = Grid(ra, dec, scale, npix)
    size = archive.cutout_size_deg(fov)
    want_model = mode != "off"
    progressive = mode == "progressive"
    priors = _StreamPriors(ra, dec, fov) if want_model else None
    counts = {"cached": 0, "fitted": 0}
    used: set[str] = set()  # catalogue names that went into fits in this stream

    def work(f: Frame, data: bytes, table):
        """CPU step: the raw product, plus (model mode) the arrays the fit needs."""
        cut = processing.parse_cutout(data)
        mjd = cut.header.get("MJD-AVG", _mid_mjd(f))
        tra, tdec = _pos_at(ra, dec, motion, mjd)
        if not want_model:
            meta, payload = processing.frame_product(cut, table, grid, tra, tdec)
            return meta, payload, None
        arrs: dict = {}
        meta, payload = processing.frame_product(cut, table, grid, tra, tdec, arrays=arrs)
        fit_in = {"img": arrs["img"], "flags": arrs["flags"], "bits": cut.flag_bits,
                  "mjd": mjd, "meta": meta}
        return meta, payload, fit_in

    async def model_for(f: Frame, fit_in: dict):
        """(model, bg bytes, leftover bytes): a cached model if any, else a fit on the priors
        that are cached right now. Never waits for a missing catalogue (see _StreamPriors)."""
        full_tag = _prior_tag(config.PRIOR_CATALOGS)
        hit = _cached_model(_model_key(f.uri, ra, dec, size, grid, full_tag), npix)
        rows, names = [], None
        if hit is None:
            rows, names = await priors.get()
            for tag in _superset_tags(names):
                if tag == full_tag:
                    continue
                hit = _cached_model(_model_key(f.uri, ra, dec, size, grid, tag), npix)
                if hit is not None:
                    break
        if hit is not None:
            counts["cached"] += 1
            return hit
        mdl, bg, left = await _run_fit(
            fit_model, fit_in["img"], fit_in["flags"], fit_in["bits"], fit_in["meta"], f.detector,
            grid, rows, fit_in["mjd"],
            _model_key(f.uri, ra, dec, size, grid, _prior_tag(names)))
        counts["fitted"] += 1
        used.update(names)
        return mdl, bg, left

    def frame_rec(f: Frame, meta: dict) -> dict:
        rec = {"type": "frame", "ok": True, "id": f.id, "obsid": f.obsid,
               "detector": f.detector, **meta, "release": f.release, "version": f.version,
               "cutout_url": archive.cutout_url(f.uri, ra, dec, size),
               "file_url": archive.file_url(f.uri)}
        if rec.get("mjd") is None:
            rec["mjd"] = _mid_mjd(f)
        return rec

    # Records from the frame tasks reach gen() through this queue. A task puts its records and
    # then _DONE in its finally, so gen() knows when each frame has nothing more to send.
    q: asyncio.Queue = asyncio.Queue()
    _DONE = object()

    async def one(f: Frame):
        try:
            data, _ = await archive.fetch_cutout(f.uri, ra, dec, size)
            table = await archive.wave_table(f.uri, f.detector, ra, dec)
            meta, payload, fit_in = await _run_cpu(work, f, data, table)
            if fit_in is not None and not progressive:
                mdl, bg, left = await model_for(f, fit_in)
                meta["model"] = mdl
                payload = payload + bg + left
            q.put_nowait((True, _record(frame_rec(f, meta), payload)))
            if fit_in is not None and progressive:
                try:
                    mdl, bg, left = await model_for(f, fit_in)
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    log.warning("model for frame %s failed: %s", f.id, e)
                else:
                    q.put_nowait((None, _record({"type": "model", "id": f.id, "model": mdl},
                                                bg + left)))
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("frame %s failed: %s", f.id, e)
            q.put_nowait((False, _record({"type": "frame", "ok": False, "id": f.id,
                                          "detector": f.detector, "mjd": f.mjd,
                                          "error": str(e)[:300]})))
        finally:
            q.put_nowait(_DONE)

    async def gen():
        t0 = time.monotonic()
        st0 = dict(getattr(archive, "STATS", {}))
        st0.setdefault("cutouts", 0)
        st0.setdefault("retries", 0)
        model_hdr = {"model": True} if mode == "inline" else \
            {"model": "progressive"} if progressive else {}
        yield _record({"type": "start", "ra": ra, "dec": dec, "fov": fov, "scale_arcsec": scale,
                       "npix": npix, "total_available": n_avail, "selected": len(sel),
                       "flag_bits": dict(processing.FLAG_BITS), "detectors": dets,
                       **model_hdr})
        tasks = [asyncio.ensure_future(one(f)) for f in sel]
        sent = failed = models = finished = 0
        last_beat = time.monotonic()
        try:
            while finished < len(tasks):
                try:
                    item = await asyncio.wait_for(q.get(), timeout=PROGRESS_INTERVAL_S)
                except TimeoutError:
                    item = None
                if item is _DONE:
                    finished += 1
                elif item is not None:
                    ok, rec = item
                    if ok is None:
                        models += 1
                    elif ok:
                        sent += 1
                    else:
                        failed += 1
                    yield rec
                now = time.monotonic()
                if finished < len(tasks) and now - last_beat >= PROGRESS_INTERVAL_S:
                    # Heartbeat: lets the client show that the archive is slow/retrying
                    # rather than looking frozen, and keeps idle proxies from closing us.
                    last_beat = now
                    st = getattr(archive, "STATS", {})
                    beat = {"type": "progress", "done": sent + failed,
                            "total": len(sel), "elapsed_s": round(now - t0, 1),
                            "upstream_retries": int(st.get("retries", 0) - st0.get("retries", 0)),
                            "downloaded": int(st.get("cutouts", 0) - st0.get("cutouts", 0))}
                    if progressive:
                        beat["models"] = models
                    yield _record(beat)
        finally:
            for t in tasks:
                t.cancel()
        st = getattr(archive, "STATS", {})
        st = {"cutouts": st.get("cutouts", 0), "retries": st.get("retries", 0)}
        log.info("stream %.5f %+.5f fov=%g: %d sent, %d failed in %.1f s (%d cutouts downloaded, "
                 "%d upstream retries)", ra, dec, fov, sent, failed, time.monotonic() - t0,
                 st["cutouts"] - st0["cutouts"], st["retries"] - st0["retries"])
        end = {"type": "end", "sent": sent, "failed": failed}
        if progressive:
            end["models"] = models
        if want_model:
            end["model_stats"] = {"cached": counts["cached"], "fitted": counts["fitted"],
                                  "priors": sorted(used)}
        yield _record(end)

    return StreamingResponse(gen(), media_type="application/octet-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@app.get("/api/spectrum")
async def spectrum(ra: float, dec: float, fov: float = 0.1, pos_ra: float | None = None,
                   pos_dec: float | None = None, detectors: str = "1,2,3,4,5,6",
                   mjd_min: float | None = None, mjd_max: float | None = None,
                   max_frames: int = config.MAX_FRAMES_DEFAULT, pmra: float | None = None,
                   pmdec: float | None = None, epoch: float | None = None, aper: float = 2.0,
                   per_visit: int | None = None):
    ra, dec = _check_pos(ra, dec)
    _check_common(fov, config.NATIVE_SCALE_ARCSEC, max_frames)
    _check_per_visit(per_visit)
    dets = _parse_detectors(detectors)
    if not config.APER_MIN_PX <= aper <= config.APER_MAX_PX:
        _bad(f"aper must be between {config.APER_MIN_PX} and {config.APER_MAX_PX} px")
    if (pos_ra is None) != (pos_dec is None):
        _bad("give both pos_ra and pos_dec, or neither")
    pra, pdec = (ra, dec) if pos_ra is None else _check_pos(pos_ra, pos_dec, "pos_ra/pos_dec")
    motion = _motion(pmra, pmdec, epoch)
    sel, _n = await _select(ra, dec, dets, mjd_min, mjd_max, max_frames, per_visit)
    size = archive.cutout_size_deg(fov)

    def work(f: Frame, data: bytes, table):
        cut = processing.parse_cutout(data)
        mjd = cut.header.get("MJD-AVG", _mid_mjd(f))
        tra, tdec = _pos_at(pra, pdec, motion, mjd)
        p = processing.spectrum_point(cut, table, tra, tdec, aper)
        return {"id": f.id, "detector": f.detector, **p,
                "mjd": p["mjd"] if p["mjd"] is not None else _mid_mjd(f)}

    async def one(f: Frame):
        try:
            data, _ = await archive.fetch_cutout(f.uri, ra, dec, size)
            table = await archive.wave_table(f.uri, f.detector, ra, dec)
            return await _run_cpu(work, f, data, table)
        except Exception as e:  # noqa: BLE001
            log.warning("spectrum frame %s failed: %s", f.id, e)
            return None

    res = await asyncio.gather(*(one(f) for f in sel))
    pts = sorted((r for r in res if r is not None), key=lambda p: p["mjd"])
    return {"pos_ra": pra, "pos_dec": pdec, "aperture_px": aper, "points": pts,
            "failed": sum(r is None for r in res)}


@app.get("/api/catalog")
async def catalog(cat: str, ra: float, dec: float, radius: float = 0.05):
    ra, dec = _check_pos(ra, dec)
    if cat not in ("gaia", "catwise"):
        _bad("cat must be 'gaia' or 'catwise'")
    if not (radius > 0):
        _bad("radius must be > 0")
    radius = min(radius, config.CATALOG_RADIUS_MAX_DEG)
    # Join the shared background query for this field, if one is running (no duplicate TAP
    # query, and the result is cached even if this client goes away). Waits as long as needed.
    rows = await catalogs.prior_catalog(cat, ra, dec, radius, wait=None, ignore_failures=True)
    if rows is None:
        raise UpstreamError(f"{cat} catalogue query was cancelled")
    return {"cat": cat, "sources": rows}


@app.get("/api/coverage")
async def coverage():
    """Fields whose frame lists are cached on disk (instant to open)."""
    fields = []
    for e in cache.list_json("frames_index"):
        if isinstance(e, dict) and {"ra", "dec", "n_frames"} <= e.keys():
            fields.append({"ra": e["ra"], "dec": e["dec"], "n_frames": e["n_frames"]})
    fields.sort(key=lambda e: (e["ra"], e["dec"]))
    return {"fields": fields}


@app.get("/api/scene3d")
async def get_scene3d(ra: float, dec: float, radius: float = 3.0, limit: int = 20000,
                      mjd: float | None = None):
    if not (math.isfinite(ra) and 0 <= ra < 360):
        _bad("ra must be in [0, 360)")
    if not (math.isfinite(dec) and -90 <= dec <= 90):
        _bad("dec must be in [-90, 90]")
    if not (math.isfinite(radius) and 0.1 <= radius <= 5.0):
        _bad("radius must be between 0.1 and 5.0 deg")
    if not 100 <= limit <= 50000:
        _bad("limit must be between 100 and 50000")
    if mjd is not None and not (math.isfinite(mjd) and scene3d.MJD_MIN <= mjd <= scene3d.MJD_MAX):
        _bad("mjd must be between 15020 (1900) and 88069 (2100)")
    return _clean(await scene3d.build_scene(ra, dec, radius, limit, mjd))


@app.get("/api/objects")
async def get_objects(ra: float, dec: float, radius: float = 3.0, mjd: float | None = None,
                      kinds: str | None = None, limit: int = 2000):
    """Records for the 3D view (planets, Moon, small bodies, static datasets), schema
    space-maps.objects/1. Always 200 for valid parameters: a failing source is reported per kind."""
    if not (math.isfinite(ra) and 0 <= ra < 360):
        _bad("ra must be in [0, 360)")
    if not (math.isfinite(dec) and -90 <= dec <= 90):
        _bad("dec must be in [-90, 90]")
    if not (math.isfinite(radius) and 0.1 <= radius <= 5.0):
        _bad("radius must be between 0.1 and 5.0 deg")
    if not 1 <= limit <= 10000:
        _bad("limit must be between 1 and 10000")
    if mjd is not None and not (math.isfinite(mjd) and objects.MJD_MIN <= mjd <= objects.MJD_MAX):
        _bad("mjd must be between 15020 (1900) and 88069 (2100)")
    wanted = [k.strip() for k in (kinds or "").split(",") if k.strip()] or None
    unknown = [k for k in wanted or () if k not in objects.KINDS]
    if unknown:
        _bad(f"unknown kind(s): {', '.join(unknown)}; valid kinds: {', '.join(objects.KINDS)}")
    return _clean(await objects.build_objects(ra, dec, radius, mjd, wanted, limit))


@app.get("/api/system/{source_id}")
async def get_system(source_id: str):
    sid = source_id.strip()
    if sid.lower() == "sun":
        sid = "sun"
    elif not (sid.isascii() and sid.isdigit() and len(sid) <= 19):
        _bad("source_id must be a Gaia source id (digits) or 'sun'")
    return _clean(await system3d.get_system(sid))


# --- static frontend (served at /, tolerant of a missing directory) -------------------------

from . import movers_api  # noqa: E402  (router must be registered before the catch-all)

app.include_router(movers_api.router)


@app.api_route("/api/{rest:path}", methods=["GET"], include_in_schema=False)
async def api_404(rest: str):
    raise HTTPException(status_code=404, detail=f"unknown API endpoint /api/{rest}")


@app.get("/{path:path}", include_in_schema=False)
async def static(path: str):
    root = config.FRONTEND_DIR.resolve()
    try:
        target = (root / path).resolve()
        target.relative_to(root)
    except (ValueError, OSError):
        raise HTTPException(status_code=404, detail="not found")
    if target.is_dir():
        target = target / "index.html"
    if target.is_file():
        # Revalidate every time (a cheap 304 via the ETag) so a new deploy's JS/CSS is picked up at once,
        # instead of the browser heuristically reusing a stale module for hours.
        return FileResponse(target, headers={"Cache-Control": "no-cache"})
    if path in ("", "index.html"):
        return JSONResponse({"detail": f"frontend not built yet ({root} has no index.html); "
                                       "the API is under /api/"}, status_code=404)
    raise HTTPException(status_code=404, detail="not found")
