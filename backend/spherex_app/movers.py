"""Moving-object detection on resampled SPHEREx frames.

Three independent tools share one frame loader:

* known objects  - IMCCE SkyBoT cone search, linear prediction per frame, shift-and-stack check;
* linking        - per-frame fitted sources without a static counterpart, linked into linear tracks;
* blind search   - shift-and-stack over a velocity grid inside each visit (background job).

Conventions (see docs/blink-architecture.md): grid x = column (east is left), y = row (north is
up); rates in arcsec/hour; position angle measured north through east; times are MJD.

Geometry note: SkyBoT is queried for the geocentre (observer code 500).  SPHEREx is in low Earth
orbit, so the topocentric parallax error is ~1.4e-5 rad / (distance in AU) -> a few arcsec for
main-belt objects (about half a pixel) and more for near-Earth objects.  That is documented, not
corrected.

Everything numerical here is synchronous and pure (numpy); the async wrappers do the I/O and are
what the API layer calls.  `sources.py` is imported lazily (when it is missing or failing the
blind search falls back to a simple background model and linking reports an error).
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import threading
import time
import uuid
from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage

from . import archive, cache, config, processing
from .geometry import Grid, npix_for

log = logging.getLogger("spherex_app.movers")

VISIT_GAP_DAYS = 20.0
SKYBOT_URL = "https://ssp.imcce.fr/webservices/skybot/api/conesearch.php"
SKYBOT_TTL_S = 7 * 86400
SEARCH_VERSION = "blind-1"
LINK_VERSION = "link-2"
SKY_MAX_RATE_ARCSEC_H = 150.0

# --------------------------------------------------------------------------------------------
# parameters and shared helpers
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Params:
    ra: float
    dec: float
    fov: float = 0.1
    scale: float = config.NATIVE_SCALE_ARCSEC
    detectors: tuple[int, ...] = (1, 2, 3, 4, 5, 6)
    mjd_min: float | None = None
    mjd_max: float | None = None
    max_frames: int = config.MAX_FRAMES_DEFAULT
    per_visit: int | None = None

    @property
    def npix(self) -> int:
        return npix_for(self.fov, self.scale)

    def grid(self) -> Grid:
        return Grid(self.ra, self.dec, self.scale, self.npix)

    def key(self, *extra) -> str:
        return cache.key_hash(f"{self.ra:.6f}", f"{self.dec:.6f}", f"{self.fov:g}",
                              f"{self.scale:g}", ",".join(map(str, self.detectors)),
                              self.mjd_min, self.mjd_max, self.max_frames, self.per_visit, *extra)


@dataclass
class LoadedFrame:
    id: str
    detector: int
    mjd: float
    img: np.ndarray  # float32 npix x npix, MJy/sr (image - zodi), NaN = no data / flagged
    psf_px: float


def _mid_mjd(f) -> float:
    end = getattr(f, "mjd_end", None)
    return float(f.mjd) if not end else 0.5 * (float(f.mjd) + float(end))


def visit_groups(mjds, gap: float = VISIT_GAP_DAYS) -> list[list[int]]:
    """Indices of `mjds` grouped into visits (gap > `gap` days starts a new one), time-ordered."""
    order = sorted(range(len(mjds)), key=lambda i: mjds[i])
    groups: list[list[int]] = []
    for i in order:
        if groups and mjds[i] - mjds[groups[-1][-1]] <= gap:
            groups[-1].append(i)
        else:
            groups.append([i])
    return groups


def px_rate_to_sky(vx: float, vy: float, scale: float) -> tuple[float, float]:
    """(rate arcsec/h, position angle deg N through E) of a grid velocity in px/h."""
    east, north = -vx, -vy  # col 0 = east, row 0 = north
    return math.hypot(east, north) * scale, math.degrees(math.atan2(east, north)) % 360.0


# --------------------------------------------------------------------------------------------
# frame selection and loading
# --------------------------------------------------------------------------------------------

def _thin_per_visit(frames, per_visit: int):
    fn = getattr(archive, "thin_per_visit", None)
    if fn is not None:
        return fn(frames, per_visit)
    by_det: dict[int, list] = {}
    for f in frames:
        by_det.setdefault(f.detector, []).append(f)
    out = []
    for lst in by_det.values():
        lst.sort(key=lambda f: f.mjd)
        for g in visit_groups([f.mjd for f in lst]):
            vis = [lst[i] for i in g]
            if len(vis) > per_visit:
                idx = np.unique(np.round(np.linspace(0, len(vis) - 1, per_visit)).astype(int))
                vis = [vis[i] for i in idx]
            out.extend(vis)
    out.sort(key=lambda f: (f.mjd, f.detector))
    return out


async def select_frames_for(p: Params) -> list:
    """Same selection as /api/stream (find_frames + select_frames), per_visit applied first."""
    allf = await archive.find_frames(p.ra, p.dec)
    dets = set(p.detectors)
    try:
        sel, _n = archive.select_frames(allf, dets, p.mjd_min, p.mjd_max, p.max_frames,
                                        p.per_visit)
    except TypeError:  # select_frames without per_visit support: thin here
        pool = [f for f in allf if f.detector in dets
                and (p.mjd_min is None or f.mjd >= p.mjd_min)
                and (p.mjd_max is None or f.mjd <= p.mjd_max)]
        if p.per_visit:
            pool = _thin_per_visit(pool, p.per_visit)
        sel, _n = archive.select_frames(pool, dets, None, None, p.max_frames)
    return list(sel)


_FRAME_CACHE = cache.TTLCache(300.0, maxsize=3)
_FRAME_CACHE_MAX_BYTES = 800 * 1024 * 1024


def _psf_px(cut, detector: int, scale: float) -> float:
    """Effective PSF FWHM in grid px (same model as the source fitter in main.py)."""
    return max(processing.effective_psf_px(cut.header.get("PSF_FWHM"), detector, scale), 1.0)


def _resample_frame(f, data: bytes, grid: Grid) -> LoadedFrame:
    cut = processing.parse_cutout(data)
    res = processing.resample(cut, grid)
    img, fl = res[0], res[1]
    img = np.array(img, dtype=np.float32)
    bad = (np.asarray(fl, dtype=np.uint32) & np.uint32(processing.bad_mask(cut.flag_bits))) != 0
    img[bad] = np.nan
    mjd = cut.header.get("MJD-AVG")
    mjd = float(mjd) if mjd is not None else _mid_mjd(f)
    return LoadedFrame(f.id, f.detector, mjd, img, _psf_px(cut, f.detector, grid.scale))


async def load_frames(p: Params, sel: list, progress=None, concurrency: int | None = None
                      ) -> list[LoadedFrame]:
    """Fetch cutouts (disk-cached after /api/stream) and resample them onto the grid.
    Frames that fail are skipped.  `progress(done, total)` is called as frames complete."""
    ck = (p.key(), tuple(f.id for f in sel))
    hit = _FRAME_CACHE.get(ck)
    if hit is not None:
        return hit
    grid = p.grid()
    size = archive.cutout_size_deg(p.fov)
    sem = asyncio.Semaphore(concurrency or max(2, config.CPU_CONCURRENCY))
    done = 0

    async def one(f):
        nonlocal done
        try:
            async with sem:
                data, _ = await archive.fetch_cutout(f.uri, p.ra, p.dec, size)
                return await asyncio.to_thread(_resample_frame, f, data, grid)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("movers: frame %s failed: %s", f.id, e)
            return None
        finally:
            done += 1
            if progress:
                progress(done, len(sel))

    res = await asyncio.gather(*(one(f) for f in sel))
    out = sorted((r for r in res if r is not None), key=lambda r: (r.mjd, r.detector))
    if sum(r.img.nbytes for r in out) <= _FRAME_CACHE_MAX_BYTES:
        _FRAME_CACHE.put(ck, out)
    return out


def _get_sources():
    """The sources module (lazy; None when unavailable).  Tests monkeypatch this."""
    try:
        from . import sources  # noqa: PLC0415
        return sources
    except Exception as e:  # noqa: BLE001
        log.info("movers: sources module unavailable (%s)", e)
        return None


# --------------------------------------------------------------------------------------------
# SkyBoT (known objects)
# --------------------------------------------------------------------------------------------

def _sexa(s: str, hours: bool) -> float:
    parts = s.replace(":", " ").split()
    neg = s.strip().startswith("-")
    vals = [abs(float(x)) for x in parts]
    vals += [0.0] * (3 - len(vals))
    v = vals[0] + vals[1] / 60.0 + vals[2] / 3600.0
    v = v * 15.0 if hours else v
    return -v if neg else v


def _num(d: dict, *keys):
    for k in keys:
        v = d.get(k)
        if v is None or v == "":
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if math.isfinite(v):
            return v
    return None


def parse_skybot(text: str) -> list[dict]:
    """Parse the JSON of the SkyBoT cone search (`-mime=json -output=all`).

    Observed record: {"Num", "Name", "RA (hms)", "DEC (dms)", "Class", "VMag (mag)",
    "Err (arcsec)", "dRA (arcsec/h)", "dDEC (arcsec/h)", "ref_epoch", ...}; "Num" is absent for
    unnumbered objects.  An empty body (HTTP 204) means no object.  `dRA` is the motion in
    RA*cos(dec) (verified against positions at two epochs).  Raises ValueError otherwise."""
    text = (text or "").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except ValueError as e:
        raise ValueError(f"SkyBoT returned non-JSON: {text[:160]!r}") from e
    if isinstance(data, dict):
        if data.get("error") or data.get("Error"):
            raise ValueError(f"SkyBoT error: {data.get('error') or data.get('Error')}")
        data = data.get("data") or data.get("results") or []
    out = []
    for r in data:
        try:
            ra = _sexa(str(r["RA (hms)"]), True)
            dec = _sexa(str(r["DEC (dms)"]), False)
        except (KeyError, ValueError, IndexError):
            continue
        num = r.get("Num")
        try:
            num = int(num) if num not in (None, "") else None
        except (TypeError, ValueError):
            num = None
        out.append({
            "number": num, "name": str(r.get("Name", "")).strip(), "class": r.get("Class"),
            "vmag": _num(r, "VMag (mag)", "V"), "ra": ra, "dec": dec,
            "dra": _num(r, "dRA (arcsec/h)") or 0.0, "ddec": _num(r, "dDEC (arcsec/h)") or 0.0,
            "err_arcsec": _num(r, "Err (arcsec)"),
            # geocentric (dg) and heliocentric (dh) distances, AU (`-output=all`)
            "dg_au": _num(r, "dg (ua)"), "dh_au": _num(r, "dh (ua)"),
        })
    return out


async def _skybot_fetch(ra: float, dec: float, radius: float, jd: float) -> str:
    params = {"-ra": f"{ra:.5f}", "-dec": f"{dec:.5f}", "-rd": f"{radius:.4f}",
              "-ep": f"{jd:.4f}", "-mime": "json", "-output": "all", "-observer": "500"}
    return await archive.get_text(SKYBOT_URL, params, what="SkyBoT")


async def skybot_cone(ra: float, dec: float, radius: float, jd: float) -> list[dict]:
    """Cone search at one epoch (disk-cached).  Raises on service failure."""
    key = cache.key_hash("skybot-2", f"{ra:.4f}", f"{dec:.4f}", f"{radius:.3f}", f"{jd:.3f}")
    hit = cache.get_json("skybot", key, ttl=SKYBOT_TTL_S)
    if hit is not None:
        return hit
    objs = parse_skybot(await _skybot_fetch(ra, dec, radius, jd))
    cache.put_json("skybot", key, objs)
    return objs


def epoch_chunks(mjds: list[float], max_span: float = 2.0) -> list[list[int]]:
    """Frame indices grouped into chunks of one visit and at most `max_span` days (one SkyBoT
    query each, so the linear motion model never extrapolates more than ~1 day)."""
    chunks: list[list[int]] = []
    for g in visit_groups(mjds):
        cur: list[int] = []
        for i in g:
            if cur and mjds[i] - mjds[cur[0]] > max_span:
                chunks.append(cur)
                cur = []
            cur.append(i)
        if cur:
            chunks.append(cur)
    return chunks


def predict_radec(obj: dict, epoch_mjd: float, mjd: float) -> tuple[float, float]:
    """Linear motion from the SkyBoT epoch (dRA includes cos dec)."""
    dt_h = (mjd - epoch_mjd) * 24.0
    dec = obj["dec"] + obj["ddec"] * dt_h / 3600.0
    cosd = max(math.cos(math.radians(obj["dec"])), 1e-6)
    ra = (obj["ra"] + obj["dra"] * dt_h / 3600.0 / cosd) % 360.0
    return ra, dec


def predict_positions(obj: dict, epoch_mjd: float, frames: list[tuple[str, float]], grid: Grid,
                      margin: float = 2.0) -> list[dict]:
    """Grid positions of `obj` at every (frame_id, mjd) that falls within the grid + margin."""
    out = []
    for fid, mjd in frames:
        ra, dec = predict_radec(obj, epoch_mjd, mjd)
        x, y = grid.sky_to_pix(ra, dec)
        x, y = float(x), float(y)
        if -margin <= x <= grid.npix - 1 + margin and -margin <= y <= grid.npix - 1 + margin:
            out.append({"frame_id": fid, "mjd": round(mjd, 7), "x": round(x, 3), "y": round(y, 3)})
    return out


def _stamp(img: np.ndarray, x: float, y: float, half: int) -> np.ndarray:
    """(2*half+1)^2 bilinear stamp centred on (x, y); NaN where there is no data."""
    ax = np.arange(-half, half + 1, dtype=float)
    yy, xx = np.meshgrid(y + ax, x + ax, indexing="ij")
    valid = np.isfinite(img)
    filled = np.where(valid, img, 0.0).astype(np.float64)
    coords = np.array([yy, xx])
    num = ndimage.map_coordinates(filled, coords, order=1, mode="constant", cval=0.0)
    den = ndimage.map_coordinates(valid.astype(np.float64), coords, order=1, mode="constant",
                                  cval=0.0)
    out = np.full(yy.shape, np.nan)
    ok = den > 0.6
    out[ok] = num[ok] / den[ok]
    return out


def measure_stack(stack: np.ndarray, r_ap: float) -> tuple[float | None, int]:
    """(S/N, n_noise_apertures) of the central aperture of a stamp.  Noise is the scatter of
    equal apertures placed in the rest of the stamp, so correlated noise is accounted for;
    background is the median of the outer part of the stamp."""
    n = stack.shape[0]
    c = (n - 1) / 2.0
    yy, xx = np.mgrid[:n, :n]
    rr = np.hypot(xx - c, yy - c)
    ap = rr <= r_ap
    ring = (rr > 2 * r_ap + 1) & np.isfinite(stack)
    if ring.sum() < 10 or np.isfinite(stack[ap]).sum() < 0.7 * ap.sum():
        return None, 0
    bkg = float(np.median(stack[ring]))
    resid = np.where(np.isfinite(stack), stack - bkg, np.nan)
    area = int(ap.sum())
    fin = np.isfinite(resid[ap])
    sig = float(np.nansum(resid[ap])) * area / max(int(fin.sum()), 1)
    sums = []
    step = max(int(round(2 * r_ap)), 2)
    lo = int(math.ceil(r_ap))
    for cy in range(lo, n - lo, step):
        for cx in range(lo, n - lo, step):
            if math.hypot(cx - c, cy - c) < 2 * r_ap + 1:
                continue
            vals = resid[np.hypot(xx - cx, yy - cy) <= r_ap]
            nf = int(np.isfinite(vals).sum())
            if nf < 0.7 * area:
                continue
            sums.append(float(np.nansum(vals)) * area / nf)
    if len(sums) >= 6:
        s = np.asarray(sums)
        sd = 1.4826 * float(np.median(np.abs(s - np.median(s))))
        sd = max(sd, float(np.std(s)) * 0.5)
    else:
        sd = 1.4826 * float(np.median(np.abs(stack[ring] - bkg))) * math.sqrt(area)
    if not sd or not math.isfinite(sd):
        return None, len(sums)
    return sig / sd, len(sums)


def stack_along_path(frames: dict[str, LoadedFrame], positions: list[dict],
                     detect_snr: float = 3.5) -> dict:
    """Median shift-and-stack of the frames at the predicted positions + aperture S/N."""
    half = 14
    yy, xx = np.mgrid[:2 * half + 1, :2 * half + 1]
    rr = np.hypot(xx - half, yy - half)
    stamps, psfs = [], []
    for pos in positions:
        f = frames.get(pos["frame_id"])
        if f is None:
            continue
        n = f.img.shape[0]
        if not (0 <= pos["x"] <= n - 1 and 0 <= pos["y"] <= n - 1):
            continue
        s = _stamp(f.img, pos["x"], pos["y"], half)
        ring = (rr > 6) & np.isfinite(s)
        if ring.sum() < 20 or np.isfinite(s).mean() < 0.7:
            continue
        stamps.append(s - np.median(s[ring]))
        psfs.append(f.psf_px)
    if not stamps:
        return {"snr": None, "detected": False, "n_frames": 0}
    stack = np.nanmedian(np.array(stamps), axis=0) if len(stamps) > 1 else stamps[0]
    r_ap = max(0.75 * float(np.median(psfs)), 1.5)
    snr, _ = measure_stack(stack, r_ap)
    return {"snr": None if snr is None else round(float(snr), 2),
            "detected": bool(snr is not None and snr >= detect_snr), "n_frames": len(stamps)}


def build_known(chunk_results: list[tuple[float, list[dict]]],
                chunk_frames: list[list[tuple[str, float]]], grid: Grid) -> list[dict]:
    """Merge the per-epoch SkyBoT answers into objects with per-frame grid positions."""
    objs: dict[tuple, dict] = {}
    for (epoch, rows), frames in zip(chunk_results, chunk_frames):
        for r in rows:
            positions = predict_positions(r, epoch, frames, grid)
            if not positions:
                continue
            o = objs.setdefault((r["number"], r["name"]), {
                "name": r["name"], "number": r["number"], "class": r["class"], "vmag": r["vmag"],
                "dra": r["dra"], "ddec": r["ddec"], "err_arcsec": r["err_arcsec"],
                "positions": []})
            o["positions"].extend(positions)
    out = []
    for o in objs.values():
        o["positions"].sort(key=lambda q: q["mjd"])
        o["rate_arcsec_h"] = round(math.hypot(o["dra"], o["ddec"]), 4)
        o["pa_deg"] = round(math.degrees(math.atan2(o["dra"], o["ddec"])) % 360.0, 3)
        out.append(o)
    out.sort(key=lambda o: (o["vmag"] is None, o["vmag"] or 0.0))
    return out


async def known_objects(p: Params, sel: list, loader=None, max_objects: int = 150) -> dict:
    """Full known-object product: SkyBoT per epoch chunk, predictions, shift-and-stack."""
    grid = p.grid()
    base = {"source": "skybot", "observer": "geocentre (500)"}
    if not sel:
        return {"objects": [], **base}
    fr = [(f.id, _mid_mjd(f)) for f in sel]
    chunks = epoch_chunks([m for _, m in fr])
    half_diag = p.fov * math.sqrt(2.0) / 2.0
    sem = asyncio.Semaphore(3)
    errors: list[str] = []

    async def query(idx: list[int]):
        mjds = [fr[i][1] for i in idx]
        epoch = 0.5 * (min(mjds) + max(mjds))
        half_span_h = 0.5 * (max(mjds) - min(mjds)) * 24.0
        margin = min(max(80.0 * half_span_h / 3600.0, 0.02), 0.6)
        try:
            async with sem:
                rows = await skybot_cone(p.ra, p.dec, half_diag + margin, epoch + 2400000.5)
        except Exception as e:  # noqa: BLE001
            errors.append(str(e)[:200])
            return None
        return epoch, rows

    res = await asyncio.gather(*(query(c) for c in chunks))
    ok = [(c, r) for c, r in zip(chunks, res) if r is not None]
    if not ok:
        return {"objects": [], **base, "error": errors[0] if errors else "no response"}
    objects = build_known([r for _, r in ok], [[fr[i] for i in c] for c, _ in ok], grid)
    truncated = len(objects) > max_objects
    objects = objects[:max_objects]

    frames: dict[str, LoadedFrame] = {}
    stack_error = None
    if objects:
        try:
            loaded = await (loader or load_frames)(p, sel)
            frames = {f.id: f for f in loaded}
            for o in objects:  # true frame times where we have them
                for q in o["positions"]:
                    if q["frame_id"] in frames:
                        q["mjd"] = round(frames[q["frame_id"]].mjd, 7)
        except Exception as e:  # noqa: BLE001
            stack_error = str(e)[:200]
            log.warning("movers: frames unavailable for stacking: %s", e)

    def stack_all():
        for o in objects:
            o["stack"] = stack_along_path(frames, o["positions"]) if frames else \
                {"snr": None, "detected": False, "n_frames": 0}
    await asyncio.to_thread(stack_all)

    out = [{"name": o["name"], "number": o["number"], "class": o["class"], "vmag": o["vmag"],
            "rate_arcsec_h": o["rate_arcsec_h"], "pa_deg": o["pa_deg"],
            "err_arcsec": o["err_arcsec"], "positions": o["positions"], "stack": o["stack"]}
           for o in objects]
    result = {"objects": out, **base}
    if truncated:
        result["note"] = f"showing the {max_objects} brightest objects"
    if errors:
        result["warning"] = f"{len(errors)} SkyBoT epoch(s) failed: {errors[0]}"
    if stack_error:
        result["stack_error"] = stack_error
    return result


# --------------------------------------------------------------------------------------------
# linking of fitted sources
# --------------------------------------------------------------------------------------------

@dataclass
class Det:
    frame: int  # index into the frame list
    fid: str
    t: float  # mjd
    x: float
    y: float
    flux: float
    snr: float
    cat: bool = False


def _fit_one(sources_mod, lf: LoadedFrame) -> list[dict]:
    fm = sources_mod.fit_frame(lf.img, ~np.isfinite(lf.img), lf.psf_px, None)
    return [{"x": float(s["x"]), "y": float(s["y"]), "flux": float(s.get("flux") or 0.0),
             "snr": float(s.get("snr") or 0.0), "cat": bool(s.get("cat")),
             "saturated": bool(s.get("saturated")), "kind": s.get("kind", "point")}
            for s in fm.sources]


def fit_frames_sources(p: Params, frames: list[LoadedFrame]) -> list[list[dict]]:
    """Run sources.fit_frame on every frame (no priors; disk-cached per frame and grid)."""
    mod = _get_sources()
    if mod is None:
        raise RuntimeError("source fitting (sources.py) is not available")
    out = []
    for lf in frames:
        key = cache.key_hash(LINK_VERSION, lf.id, f"{p.ra:.6f}", f"{p.dec:.6f}", f"{p.scale:g}",
                             p.npix, f"{lf.psf_px:.3f}")
        hit = cache.get_json("movers_fit", key)
        if hit is None:
            hit = _fit_one(mod, lf)
            cache.put_json("movers_fit", key, hit)
        out.append(hit)
    return out


def detections_from_fits(frames: list[LoadedFrame], fits: list[list[dict]],
                         min_snr: float = 4.0) -> list[Det]:
    dets = []
    for i, (lf, srcs) in enumerate(zip(frames, fits)):
        for s in srcs:
            if s["snr"] < min_snr or s.get("saturated") or not (
                    math.isfinite(s["x"]) and math.isfinite(s["y"])):
                continue
            dets.append(Det(i, lf.id, lf.mjd, s["x"], s["y"], s["flux"], s["snr"], bool(s["cat"])))
    return dets


def persistent_static(dets: list[Det], det_of_frame: dict[int, int], tol: float = 0.8,
                      min_frac: float = 0.2, min_frames: int = 3) -> np.ndarray:
    """Boolean per detection: a source at this position shows up in many other frames of the
    same detector (band) at any epoch, i.e. a faint star, not a mover.  Real movers shift by
    many px between visits, so they never accumulate such a history."""
    from scipy.spatial import cKDTree
    flag = np.zeros(len(dets), bool)
    by_det: dict[int, list[int]] = {}
    for i, d in enumerate(dets):
        by_det.setdefault(det_of_frame.get(d.frame, 0), []).append(i)
    nfr: dict[int, int] = {}
    for f, dv in det_of_frame.items():
        nfr[dv] = nfr.get(dv, 0) + 1
    for dv, idx in by_det.items():
        xy = np.array([[dets[i].x, dets[i].y] for i in idx])
        tree = cKDTree(xy)
        need = max(min_frames, int(math.ceil(min_frac * nfr.get(dv, 1))))
        for k, i in enumerate(idx):
            fr = {dets[idx[j]].frame for j in tree.query_ball_point(xy[k], tol)} - {dets[i].frame}
            flag[i] = len(fr) >= need
    return flag


def unmatched_detections(dets: list[Det], visit_of_frame: dict[int, int], static_tol: float = 1.0,
                         det_of_frame: dict[int, int] | None = None) -> list[Det]:
    """Detections with no static counterpart: no catalogue match, and not seen (within
    `static_tol` px) in >= 2 other frames of the same visit (>= 1 if the visit has <= 3 frames)
    or in >= 3 other frames anywhere."""
    if not dets:
        return []
    from scipy.spatial import cKDTree
    static = persistent_static(dets, det_of_frame) if det_of_frame else np.zeros(len(dets), bool)
    xy = np.array([[d.x, d.y] for d in dets])
    tree = cKDTree(xy)
    nframes_in_visit: dict[int, int] = {}
    for v in visit_of_frame.values():
        nframes_in_visit[v] = nframes_in_visit.get(v, 0) + 1
    out = []
    for i, d in enumerate(dets):
        if d.cat or static[i]:
            continue
        v = visit_of_frame[d.frame]
        others = {dets[j].frame for j in tree.query_ball_point(xy[i], static_tol)
                  if dets[j].frame != d.frame}
        same_visit = sum(1 for f in others if visit_of_frame[f] == v)
        need = 2 if nframes_in_visit[v] > 3 else 1
        if same_visit >= need or len(others) >= 3:
            continue
        out.append(d)
    return out


def _lsq_track(t: np.ndarray, x: np.ndarray, y: np.ndarray):
    tm = t.mean()
    A = np.stack([np.ones_like(t), t - tm], axis=1)
    cx, *_ = np.linalg.lstsq(A, x, rcond=None)
    cy, *_ = np.linalg.lstsq(A, y, rcond=None)
    rms = float(np.sqrt(np.mean((x - A @ cx) ** 2 + (y - A @ cy) ** 2)))
    return tm, cx, cy, rms


def link_visit(dets: list[Det], scale: float, tol: float = 1.0, min_n: int = 3,
               max_rate: float = SKY_MAX_RATE_ARCSEC_H, min_shift_px: float = 2.0,
               max_dets: int = 1200, max_false: float = 0.5) -> list[dict]:
    """Link detections of one visit into linear tracks (>= min_n distinct frames, residual <= tol).

    Seed = every pair of detections in different frames; the velocity from the pair predicts the
    other detections, those within `tol` px vote; the track is then refit by least squares."""
    if len(dets) < min_n:
        return []
    if len(dets) > max_dets:
        dets = sorted(dets, key=lambda d: -d.snr)[:max_dets]
    dets = sorted(dets, key=lambda d: d.t)
    t = np.array([d.t for d in dets]) * 24.0  # hours
    xy = np.array([[d.x, d.y] for d in dets])
    fr = np.array([d.frame for d in dets])
    N = len(dets)
    vmax = max_rate / scale
    span = float(t.max() - t.min())
    if span <= 0:
        return []
    vmin = min_shift_px / span
    min_dt = 20.0 / 3600.0
    tracks: dict[tuple, dict] = {}
    for a in range(N):
        dt = t - t[a]
        b = np.nonzero((dt > min_dt) & (fr != fr[a]))[0]
        if b.size == 0:
            continue
        v = (xy[b] - xy[a]) / dt[b, None]
        sp = np.hypot(v[:, 0], v[:, 1])
        ok = (sp <= vmax) & (sp >= vmin)
        b, v = b[ok], v[ok]
        if b.size == 0:
            continue
        pred = xy[a][None, None, :] + v[:, None, :] * dt[None, :, None]  # B x N x 2
        dist = np.hypot(pred[..., 0] - xy[None, :, 0], pred[..., 1] - xy[None, :, 1])
        close = dist <= tol
        close[:, a] = True
        votes = np.array([len(set(fr[row])) for row in close])
        for k in np.nonzero(votes >= min_n)[0]:
            members: dict[int, int] = {}
            for j in np.nonzero(close[k])[0]:
                f = int(fr[j])
                if f not in members or dist[k, j] < dist[k, members[f]]:
                    members[f] = int(j)
            idx = np.array(sorted(members.values()))
            for _ in range(2):  # refit; re-select inliers around the fitted line
                if len(idx) < min_n:
                    break
                tm, cx, cy, rms = _lsq_track(t[idx], xy[idx, 0], xy[idx, 1])
                d2 = np.hypot(cx[0] + cx[1] * (t - tm) - xy[:, 0], cy[0] + cy[1] * (t - tm) - xy[:, 1])
                members = {}
                for j in np.nonzero(d2 <= tol)[0]:
                    f = int(fr[j])
                    if f not in members or d2[j] < d2[members[f]]:
                        members[f] = int(j)
                idx = np.array(sorted(members.values()))
            if len(idx) < min_n:
                continue
            rms = _lsq_track(t[idx], xy[idx, 0], xy[idx, 1])[3]
            if rms <= tol:
                tracks.setdefault(tuple(idx.tolist()), {"idx": idx, "rms": rms})
    chosen = []
    used: set[int] = set()
    # Significance: expected number of chance tracks with >= n members given the detection
    # density (pair seeds x binomial tail over the other frames); keep tracks with E < max_false.
    from math import comb
    nfr_v = len(set(fr.tolist()))
    area = max(float(np.ptp(xy[:, 0]) * np.ptp(xy[:, 1])), 100.0)
    p_hit = min(1.0, (N / max(nfr_v, 1)) / area * math.pi * tol ** 2)

    def false_expect(n: int) -> float:
        m = max(nfr_v - 2, 0)
        tail = sum(comb(m, k) * p_hit ** k * (1 - p_hit) ** (m - k) for k in range(max(n - 2, 0), m + 1))
        return 0.25 * N * N * tail
    for tr in sorted(tracks.values(), key=lambda q: (-len(q["idx"]), q["rms"])):
        idx = np.array([j for j in tr["idx"] if j not in used])
        if len(idx) < min_n:
            continue
        tm, cx, cy, rms = _lsq_track(t[idx], xy[idx, 0], xy[idx, 1])
        if rms > tol or math.hypot(cx[1], cy[1]) * span < min_shift_px * 0.5:
            continue
        if false_expect(len(idx)) > max_false:
            continue
        used.update(int(j) for j in idx)
        rate, pa = px_rate_to_sky(float(cx[1]), float(cy[1]), scale)
        snrs = np.array([dets[j].snr for j in idx])
        n = len(idx)
        conf = (1 - math.exp(-(n - 2) / 2.0)) * (1 - 0.5 * min(rms / tol, 1.0)) * \
            (float(snrs.mean()) / (float(snrs.mean()) + 3.0))
        chosen.append({"rate_arcsec_h": round(rate, 3), "pa_deg": round(pa, 2),
                       "confidence": round(float(min(max(conf, 0.0), 1.0)), 3),
                       "rms_px": round(rms, 3), "n": n,
                       "positions": [{"frame_id": dets[j].fid, "mjd": round(dets[j].t, 7),
                                      "x": round(dets[j].x, 3), "y": round(dets[j].y, 3),
                                      "flux": round(dets[j].flux, 5)} for j in idx]})
    return chosen


def link_movers(frames: list[LoadedFrame], fits: list[list[dict]], scale: float,
                tol: float = 1.0) -> list[dict]:
    dets = detections_from_fits(frames, fits)
    groups = visit_groups([f.mjd for f in frames])
    visit_of = {i: v for v, g in enumerate(groups) for i in g}
    dets = unmatched_detections(dets, visit_of, det_of_frame={i: f.detector for i, f in enumerate(frames)})
    out = []
    for v in range(len(groups)):
        out.extend(link_visit([d for d in dets if visit_of[d.frame] == v], scale, tol,
                              min_n=4 if len(groups[v]) >= 6 else 3))
    out.sort(key=lambda m: -m["confidence"])
    for i, m in enumerate(out, 1):
        m["id"] = f"M{i}"
    return out


async def linked_movers(p: Params, sel: list, loader=None) -> dict:
    frames = await (loader or load_frames)(p, sel)
    if not frames:
        return {"movers": [], "n_frames": 0}

    def work():
        return link_movers(frames, fit_frames_sources(p, frames), p.scale)
    return {"movers": await asyncio.to_thread(work), "n_frames": len(frames)}


# --------------------------------------------------------------------------------------------
# blind search (shift-and-stack over a velocity grid)
# --------------------------------------------------------------------------------------------

@dataclass
class SearchCfg:
    max_rate_arcsec_h: float = SKY_MAX_RATE_ARCSEC_H
    min_snr: float = 5.5  # floor of the detection threshold (the trial-count term can raise it)
    max_trials: int = 25000  # per visit
    vel_step_frac: float = 0.7  # velocity step * half-span, in px: smear of the grid
    min_frames: int = 3
    min_shift_px: float = 1.5  # slower than this over the visit is indistinguishable from static
    time_limit_s: float = 240.0
    use_fit: bool = True

    def tag(self) -> str:
        return cache.key_hash(SEARCH_VERSION, self.max_rate_arcsec_h, self.min_snr,
                              self.max_trials, self.vel_step_frac, self.min_shift_px, self.use_fit)


def _smooth_background(img: np.ndarray, valid: np.ndarray, sigma: float = 10.0) -> np.ndarray:
    med = float(np.median(img[valid])) if valid.any() else 0.0
    r = np.where(valid, img - med, 0.0)
    sd = (1.4826 * float(np.median(np.abs(r[valid]))) if valid.any() else 1.0) or 1.0
    r = np.clip(r, -3 * sd, 3 * sd)  # stars barely leak into the background estimate
    w = valid.astype(np.float32)
    num = ndimage.gaussian_filter(r * w, sigma, mode="nearest")
    den = ndimage.gaussian_filter(w, sigma, mode="nearest")
    return (med + num / np.maximum(den, 1e-3)).astype(np.float32)


def prepare_snr_image(img: np.ndarray, psf_px: float, leftover: np.ndarray | None = None
                      ) -> np.ndarray:
    """Matched-filter S/N image (unit-variance noise) with bright/static pixels zeroed.

    `leftover` (data - model from sources.fit_frame) is used when given, else the image minus a
    smooth background.  Pixels above 4.5 sigma (grown by 2 px; above 15 sigma grown by 5 px) are
    set to zero: they are stars/bright sources that would otherwise swamp slow velocity trials.
    A mover fainter than that per frame is untouched."""
    valid = np.isfinite(img)
    if not valid.any():
        return np.zeros(img.shape, np.float32)
    if leftover is not None:
        d = np.where(np.isfinite(leftover), leftover, 0.0).astype(np.float32)
        d = d - float(np.median(d[valid]))
    else:
        d = np.where(valid, img - _smooth_background(img, valid), 0.0).astype(np.float32)
    d[~valid] = 0.0
    sp = max(psf_px / 2.3548, 0.5)
    m = ndimage.gaussian_filter(d, sp, mode="constant")
    w = ndimage.gaussian_filter(valid.astype(np.float32), sp, mode="constant")
    m = np.where(w > 0.5, m / np.maximum(w, 1e-3), 0.0)
    ok = valid & (w > 0.5)
    vals = m[ok]
    sd = 1.4826 * float(np.median(np.abs(vals - np.median(vals)))) if vals.size else 0.0
    if not sd or not math.isfinite(sd):
        return np.zeros(img.shape, np.float32)
    s = ((m - float(np.median(vals))) / sd).astype(np.float32)
    s[~ok] = 0.0
    mask = ndimage.binary_dilation(s > 4.5, iterations=2)
    bright = s > 15.0
    if bright.any():
        mask |= ndimage.binary_dilation(bright, iterations=5)
    s[mask] = 0.0
    return s


def plan_velocities(ts_h: np.ndarray, scale: float, cfg: SearchCfg):
    """Velocity grid (px/h) for one visit: (vx, vy, info), ordered slow to fast.

    Step: the velocity step times the half time span is `vel_step_frac` px, so the grid smears a
    source by at most ~0.5 px.  The number of trials is capped at `cfg.max_trials` by lowering the
    maximum rate (info["limited"])."""
    span = float(ts_h.max() - ts_h.min())
    if span <= 0:
        return np.zeros(0), np.zeros(0), {"limited": False, "step": 0.0, "vmax": 0.0}
    step = cfg.vel_step_frac / (span / 2.0)
    vmax = cfg.max_rate_arcsec_h / scale
    limited = False
    if math.pi * (vmax / step) ** 2 > cfg.max_trials:
        vmax = step * math.sqrt(cfg.max_trials / math.pi)
        limited = True
    vmin = cfg.min_shift_px / span
    k = int(math.ceil(vmax / step))
    ax = step * np.arange(-k, k + 1)
    vx, vy = np.meshgrid(ax, ax)
    vx, vy = vx.ravel(), vy.ravel()
    r = np.hypot(vx, vy)
    keep = (r <= vmax) & (r >= vmin)
    vx, vy, r = vx[keep], vy[keep], r[keep]
    order = np.argsort(r, kind="stable")
    return vx[order], vy[order], {"limited": limited, "step": step, "vmax": vmax}


def _slices(s: int, n: int):
    if abs(s) >= n:
        return None
    return (slice(0, n - s), slice(s, n)) if s >= 0 else (slice(-s, n), slice(0, n + s))


def _stack_trial(S: np.ndarray, sx: np.ndarray, sy: np.ndarray, acc: np.ndarray) -> np.ndarray:
    """acc[y, x] = sum_i S[i, y + sy_i, x + sx_i] (integer shifts, zero outside)."""
    acc.fill(0.0)
    h, w = acc.shape
    for i in range(S.shape[0]):
        ys, xs = _slices(int(sy[i]), h), _slices(int(sx[i]), w)
        if ys is None or xs is None:
            continue
        acc[ys[0], xs[0]] += S[i][ys[1], xs[1]]
    return acc


def _bilinear(S: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Bilinear samples of S[i] at (x[..., i], y[..., i]); zero outside the image."""
    n, h, w = S.shape
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx, fy = x - x0, y - y0
    idx = np.broadcast_to(np.arange(n), x.shape)
    out = np.zeros(x.shape, np.float64)
    for dy, wy in ((0, 1 - fy), (1, fy)):
        for dx, wx in ((0, 1 - fx), (1, fx)):
            xi, yi = x0 + dx, y0 + dy
            ok = (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
            val = S[idx, np.clip(yi, 0, h - 1), np.clip(xi, 0, w - 1)]
            out += np.where(ok, val, 0.0) * wy * wx
    return out


def _refine(S: np.ndarray, tt: np.ndarray, x0, y0, vx, vy, vstep):
    """Local bilinear refinement of the track (x0, y0, vx, vy); returns params and summed S."""
    offs = np.array([(a, b, c, d) for a in (-1, 0, 1) for b in (-1, 0, 1)
                     for c in (-1, 0, 1) for d in (-1, 0, 1)], float)
    best = np.array([x0, y0, vx, vy], float)
    bs = -np.inf
    scale = 0.5
    for _ in range(5):
        for _ in range(8):
            P = best[None, :] + offs * np.array([scale, scale, scale * vstep, scale * vstep])
            xs = P[:, 0:1] + P[:, 2:3] * tt[None, :]
            ys = P[:, 1:2] + P[:, 3:4] * tt[None, :]
            tot = _bilinear(S, xs, ys).sum(axis=1)
            k = int(np.argmax(tot))
            if tot[k] <= bs + 1e-9 or np.all(offs[k] == 0):
                bs = max(bs, tot[k])
                break
            bs, best = float(tot[k]), P[k]
        scale *= 0.5
    return (*best, bs)


def _noise_floor(S: np.ndarray) -> float:
    """Sigma of a full-coverage stack: sqrt of the summed per-frame variances (frames are
    independent; each S/N image has unit variance by construction, a bit less after masking).
    Pixels where shifted frames fall off the grid have fewer terms, i.e. lower noise, so this is
    conservative at the edges."""
    var = 0.0
    for img in S:
        nz = img[img != 0]
        var += (1.4826 * float(np.median(np.abs(nz - np.median(nz))))) ** 2 if nz.size > 20 else 1.0
    return float(math.sqrt(max(var, 1e-6)))


def _track_dist(a: dict, b: dict, t_lo: float, t_hi: float) -> float:
    return max(math.hypot((a["x0"] + a["vx"] * t) - (b["x0"] + b["vx"] * t),
                          (a["y0"] + a["vy"] * t) - (b["y0"] + b["vy"] * t)) for t in (t_lo, t_hi))


def _merge(cands: list[dict], raw: list[dict], t_lo: float, t_hi: float, tol: float = 2.0,
           cap: int = 300) -> None:
    """Greedy duplicate merge: tracks within `tol` px at both ends of the visit are one."""
    for r in sorted(raw, key=lambda c: -c["snr"]):
        for c in cands:
            if _track_dist(r, c, t_lo, t_hi) <= tol:
                if r["snr"] > c["snr"]:
                    c.update({k: r[k] for k in ("x0", "y0", "vx", "vy", "snr")})
                break
        else:
            cands.append(dict(r))
    if len(cands) > cap:
        cands.sort(key=lambda c: -c["snr"])
        del cands[cap:]


def _confidence(snr: float, thr: float) -> float:
    return float(1.0 / (1.0 + math.exp(-(snr - (thr + 1.0)) / 1.2)))


def _cand_out(c: dict, fids, mjds, tt, h: int, w: int, scale: float, thr: float) -> dict:
    xs = c["x0"] + c["vx"] * tt
    ys = c["y0"] + c["vy"] * tt
    rate, pa = px_rate_to_sky(c["vx"], c["vy"], scale)
    return {"rate_arcsec_h": round(rate, 2), "pa_deg": round(pa, 2), "snr": round(float(c["snr"]), 2),
            "confidence": round(_confidence(c["snr"], thr), 3),
            "positions": [{"frame_id": fids[i], "mjd": round(mjds[i], 7), "x": round(float(xs[i]), 3),
                           "y": round(float(ys[i]), 3)}
                          for i in range(len(fids)) if 0 <= xs[i] <= w - 1 and 0 <= ys[i] <= h - 1]}


def search_visit(S: np.ndarray, ts_h: np.ndarray, fids: list[str], mjds: list[float],
                 scale: float, cfg: SearchCfg, plan, psf_px: float, emit=None, cancel=None,
                 deadline: float | None = None, progress=None) -> tuple[list[dict], dict]:
    """Shift-and-stack search of one visit.  S: (n, H, W) S/N images (see prepare_snr_image).

    Threshold = max(cfg.min_snr, Gaussian false-alarm level for one expected false positive over
    all independent pixels x velocity trials).  `emit(provisional_candidates)` is called while
    searching, `progress(k)` with the number of trials completed since the last call."""
    from scipy.stats import norm
    n, h, w = S.shape
    vx, vy, pinfo = plan
    tref = 0.5 * (ts_h.min() + ts_h.max())
    tt = ts_h - tref
    t_lo, t_hi = float(tt.min()), float(tt.max())
    acc = np.empty((h, w), np.float32)
    nz = _noise_floor(S)
    sp = max(psf_px / 2.3548, 0.5)
    n_ind = max(h * w / (2 * math.pi * sp ** 2), 1.0)
    thr = max(cfg.min_snr, float(norm.isf(min(1.0 / (n_ind * max(len(vx), 1)), 0.5))) + 0.3)
    cut = thr * nz
    cands: list[dict] = []
    raw: list[dict] = []
    pend = 0
    info = {"threshold": round(thr, 2), "noise": nz, "trials": len(vx), "limited": pinfo["limited"],
            "vmax_arcsec_h": round(pinfo["vmax"] * scale, 1), "completed": True}

    def flush():
        if raw:
            _merge(cands, raw, t_lo, t_hi)
            raw.clear()
            if emit:
                emit([_cand_out(c, fids, mjds, tt, h, w, scale, thr) for c in cands])

    for k in range(len(vx)):
        if cancel is not None and cancel.is_set():
            info["completed"] = False
            break
        if deadline is not None and (k & 15) == 0 and time.monotonic() > deadline:
            info["completed"] = False
            break
        _stack_trial(S, np.rint(vx[k] * tt), np.rint(vy[k] * tt), acc)
        if float(acc.max()) > cut:
            ys, xs = np.nonzero(acc > cut)
            if len(ys) > 8:
                top = np.argpartition(acc[ys, xs], -8)[-8:]
                ys, xs = ys[top], xs[top]
            for y, x in zip(ys, xs):
                raw.append({"x0": float(x), "y0": float(y), "vx": float(vx[k]), "vy": float(vy[k]),
                            "snr": float(acc[y, x] / nz)})
            if len(raw) >= 64:
                flush()
        pend += 1
        if progress is not None and pend >= 64:
            progress(pend)
            pend = 0
    flush()
    if progress is not None and pend:
        progress(pend)

    refined: list[dict] = []
    for c in sorted(cands, key=lambda c: -c["snr"])[:40]:
        if cancel is not None and cancel.is_set():
            break
        x0, y0, rvx, rvy, tot = _refine(S, tt, c["x0"], c["y0"], c["vx"], c["vy"], pinfo["step"])
        xs_, ys_ = x0 + rvx * tt, y0 + rvy * tt
        inside = (xs_ >= 0) & (xs_ <= w - 1) & (ys_ >= 0) & (ys_ <= h - 1)
        snr = tot / nz
        if snr < thr or inside.mean() < 0.6 or inside.sum() < cfg.min_frames:
            continue
        refined.append({"x0": x0, "y0": y0, "vx": rvx, "vy": rvy, "snr": snr})
    final: list[dict] = []
    _merge(final, refined, t_lo, t_hi, tol=1.5)
    out = [_cand_out(c, fids, mjds, tt, h, w, scale, thr)
           for c in sorted(final, key=lambda c: -c["snr"])]
    return out, info


# --- job machinery ---------------------------------------------------------------------------

@dataclass
class Job:
    id: str
    key: str
    state: str = "running"
    progress: float = 0.0
    tried: int = 0
    total: int = 0
    candidates: list = field(default_factory=list)
    error: str | None = None
    warnings: list = field(default_factory=list)
    cached: bool = False
    phase: str = "loading"
    cancel: threading.Event = field(default_factory=threading.Event)
    task: asyncio.Task | None = None
    created: float = field(default_factory=time.time)

    def status(self) -> dict:
        d = {"state": self.state, "progress": round(self.progress, 4), "tried": self.tried,
             "total": self.total, "candidates": list(self.candidates), "phase": self.phase}
        if self.error:
            d["error"] = self.error
        if self.warnings:
            d["warnings"] = list(self.warnings)
        return d


JOBS: dict[str, Job] = {}
_JOB_LIMIT = 40


def _renumber(cands: list[dict]) -> list[dict]:
    out = []
    for i, c in enumerate(sorted(cands, key=lambda c: -c["snr"]), 1):
        out.append({"id": f"C{i}", **{k: v for k, v in c.items() if k != "id"}})
    return out


def run_search(frames: list[LoadedFrame], p: Params, cfg: SearchCfg, job: Job) -> None:
    """Blocking search over all visits; updates `job` as it goes (runs in a worker thread)."""
    all_groups = visit_groups([f.mjd for f in frames])
    groups = [g for g in all_groups if len(g) >= cfg.min_frames]
    plans = [plan_velocities(np.array([frames[i].mjd for i in g]) * 24.0, p.scale, cfg)
             for g in groups]
    job.total = int(sum(len(pl[0]) for pl in plans))
    if len(groups) < len(all_groups):
        job.warnings.append(f"visits with fewer than {cfg.min_frames} frames were skipped")
    for pl in plans:
        if pl[2]["limited"]:
            job.warnings.append(f"max rate limited to {pl[2]['vmax'] * p.scale:.0f} arcsec/h "
                                f"(trial cap {cfg.max_trials})")
    job.phase = "searching"
    deadline = time.monotonic() + cfg.time_limit_s
    sources_mod = _get_sources() if cfg.use_fit else None
    finished: list[dict] = []
    lock = threading.Lock()

    def bump(k: int):
        with lock:
            job.tried += k
            job.progress = 0.1 + 0.9 * job.tried / max(job.total, 1)

    for g, plan in zip(groups, plans):
        if job.cancel.is_set():
            break
        fr = [frames[i] for i in g]
        S = np.empty((len(fr), *fr[0].img.shape), np.float32)
        for i, lf in enumerate(fr):
            left = None
            if sources_mod is not None:
                try:
                    fm = sources_mod.fit_frame(lf.img, ~np.isfinite(lf.img), lf.psf_px, None)
                    left = np.asarray(fm.leftover, dtype=np.float32)
                except Exception as e:  # noqa: BLE001
                    log.info("movers: fit_frame failed (%s); using a smooth background", e)
                    sources_mod = None
            S[i] = prepare_snr_image(lf.img, lf.psf_px, left)
        base = list(finished)
        cands, info = search_visit(
            S, np.array([f.mjd for f in fr]) * 24.0, [f.id for f in fr], [f.mjd for f in fr],
            p.scale, cfg, plan, float(np.median([f.psf_px for f in fr])),
            emit=lambda prov, base=base: setattr(job, "candidates", _renumber(
                base + [c for c in prov if c["snr"] >= cfg.min_snr])),
            cancel=job.cancel, deadline=deadline, progress=bump)
        finished.extend(cands)
        job.candidates = _renumber(finished)
        if not info["completed"]:
            if not job.cancel.is_set():
                job.warnings.append("time limit reached; search incomplete")
            break
    job.candidates = _renumber(finished)


def _prune_jobs() -> None:
    if len(JOBS) <= _JOB_LIMIT:
        return
    old = sorted((j for j in JOBS if JOBS[j].state != "running"), key=lambda j: JOBS[j].created)
    for jid in old[:len(JOBS) - _JOB_LIMIT]:
        JOBS.pop(jid, None)


async def start_search(p: Params, cfg: SearchCfg | None = None, loader=None,
                       selector=None) -> tuple[Job, bool]:
    """Start (or reuse / answer from the disk cache) a blind search.  Returns (job, cached)."""
    cfg = cfg or SearchCfg()
    key = p.key("movers-search", cfg.tag())
    hit = cache.get_json("movers_search", key)
    if hit is not None:
        job = Job(id=uuid.uuid4().hex[:12], key=key, state="done", progress=1.0,
                  tried=hit.get("tried", 0), total=hit.get("total", 0),
                  candidates=hit.get("candidates", []), cached=True, phase="done",
                  warnings=hit.get("warnings", []))
        JOBS[job.id] = job
        _prune_jobs()
        return job, True
    for j in JOBS.values():
        if j.key == key and j.state == "running":
            return j, False
    job = Job(id=uuid.uuid4().hex[:12], key=key)
    JOBS[job.id] = job
    _prune_jobs()
    job.task = asyncio.create_task(_run_job(job, p, cfg, loader or load_frames,
                                            selector or select_frames_for))
    return job, False


async def _run_job(job: Job, p: Params, cfg: SearchCfg, loader, selector) -> None:
    try:
        sel = await selector(p)
        if not sel:
            raise RuntimeError("no SPHEREx frames for this field")

        def prog(done, total):
            job.progress = 0.1 * done / max(total, 1)
        frames = await loader(p, sel, prog)
        if not frames:
            raise RuntimeError("no frame could be loaded")
        await asyncio.to_thread(run_search, frames, p, cfg, job)
        if job.cancel.is_set():
            job.state = "cancelled"
            return
        job.state, job.progress, job.phase = "done", 1.0, "done"
        if not any("incomplete" in w for w in job.warnings):
            cache.put_json("movers_search", job.key,
                           {"candidates": job.candidates, "tried": job.tried, "total": job.total,
                            "warnings": job.warnings})
    except asyncio.CancelledError:
        job.state = "cancelled"
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("movers search failed")
        job.state, job.error = "error", str(e)[:300]


def cancel_job(job: Job) -> None:
    if job.state != "running":
        return
    job.cancel.set()
    if job.phase == "loading" and job.task is not None:
        job.task.cancel()
    job.state = "cancelled"
