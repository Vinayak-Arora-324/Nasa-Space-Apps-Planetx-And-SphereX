"""Warm the backend's disk cache (frame lists, cutouts, wavelength tables, fitted models) for targets.

Each target is centred exactly as its page does it. Analysis targets (PRESETS) go through
/api/resolve; a proper motion is propagated to epoch 2026.0 and rounded to 7 decimals.
Blink targets (BLINK_PRESETS) are centred without the resolver, as frontend/js/blink/app.js
does. Then /api/stream is requested with the page's parameters. The cutout cache is keyed by the
exact centre, so a later visit from the page is served from disk.

    uv run python backend/scripts/prewarm.py                 # the five analysis targets, then Blink's eight
    uv run python backend/scripts/prewarm.py --blink         # Blink's eight presets as Blink opens them, full-prior models
    uv run python backend/scripts/prewarm.py --blink --band 3 "WISE 0855"
    uv run python backend/scripts/prewarm.py --fov 0.2 "RW Aur" "10.684 41.269"
    uv run python backend/scripts/prewarm.py --server http://localhost:8000   # a running server

--model requests model=1 (which also warms Blink's progressive view) and, before each target
streams, fetches both fit priors (gaia, catwise) over the full field radius, waiting as long as
needed. Catalogue fetches for all targets start up front, --catalog-concurrency at a time.

By default the app runs in-process, with the same code and the same SPHEREX_CACHE_DIR
as the server. With --server, a running instance is warmed instead (its in-memory caches too).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import struct
import sys
import time
from typing import NamedTuple
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from spherex_app import archive, catalogs, config, geometry  # noqa: E402

REF_EPOCH = 2026.0  # the page centres moving targets on their position at this epoch

# Mirrors the page's presets (frontend/js/main.js): `fallback` is used if the name does not
# resolve; `pm_default` if the resolver returns no proper motion.
PRESETS = {
    "Barnard's Star": {},
    "Epsilon Indi B": {"fallback": dict(ra=331.0437, dec=-56.7828, pmra=3966, pmdec=-2536,
                                        epoch=2000.0)},
    "WISE J085510.83-071442.5": {"fallback": dict(ra=133.795129, dec=-7.245147),
                                 "pm_default": dict(pmra=-8118, pmdec=680, epoch=2010.4)},
    "RW Aur": {},
    "R Dra": {},
}

# Blink's presets (frontend/js/blink/app.js PRESETS). `pm` is [pmra, pmdec] in mas/yr at J2000;
# Blink centres those at REF_EPOCH (atRefEpoch), the others at ra/dec as written.
BLINK_PRESETS = [
    {"label": "North Ecliptic Pole", "ra": 270.0, "dec": 66.56},
    {"label": "South Ecliptic Pole", "ra": 90.0, "dec": -66.56},
    {"label": "Orion Nebula", "ra": 83.82, "dec": -5.39},
    {"label": "Galactic Centre", "ra": 266.417, "dec": -29.008},
    {"label": "Barnard’s Star", "ra": 269.4520770, "dec": 4.6933650,
     "pm": (-801.551, 10362.394)},
    {"label": "ε Indi B", "ra": 331.0437, "dec": -56.7828, "pm": (3966, -2536)},
    {"label": "WISE 0855", "ra": 133.795129, "dec": -7.245147},
    {"label": "R Draconis", "ra": 248.175, "dec": 66.7544},
]

# Blink's stream defaults (app.js DEFAULTS); --blink applies them, explicit options win.
BLINK_DEFAULTS = dict(fov=0.5, band="2", per_visit=6)
PLAIN_DEFAULTS = dict(fov=0.1, band="1,2,3,4,5,6", per_visit=None)
BANDS = tuple("123456")


async def centre(c: httpx.AsyncClient, q: str) -> dict:
    preset = PRESETS.get(q, {})
    r = await c.get("/api/resolve", params={"q": q})
    if r.status_code == 200:
        j = r.json()
        p = dict(ra=j["ra"], dec=j["dec"], pmra=j.get("pmra"), pmdec=j.get("pmdec"),
                 epoch=j.get("epoch"))
        if (p["pmra"] is None or p["pmdec"] is None) and "pm_default" in preset:
            p.update(preset["pm_default"])
    elif "fallback" in preset:
        p = dict(pmra=None, pmdec=None, epoch=None) | preset.get("pm_default", {})
        p.update(preset["fallback"])
    else:
        raise RuntimeError(f"cannot resolve {q!r}: HTTP {r.status_code} {r.text[:200]}")
    if p["pmra"] is not None and p["pmdec"] is not None and p["epoch"] is None:
        p["epoch"] = 2000.0
    pm_on = p["pmra"] is not None and p["pmdec"] is not None and (p["pmra"] or p["pmdec"])
    if pm_on and abs(p["epoch"] - REF_EPOCH) > 1e-6:
        p["ra"], p["dec"] = geometry.propagate(p["ra"], p["dec"], p["pmra"], p["pmdec"],
                                               p["epoch"], geometry.jyear_to_mjd(REF_EPOCH))
        p["epoch"] = REF_EPOCH
    p["ra"], p["dec"] = round(p["ra"], 7), round(p["dec"], 7)
    if not pm_on:
        p.update(pmra=None, pmdec=None, epoch=None)
    return p


def _blink_key(name: str) -> str:
    """Name key for matching: case, typographic apostrophe, and epsilon spellings folded."""
    s = name.replace("’", "'").replace("ε", "eps").lower().replace("epsilon", "eps")
    return " ".join(s.split())


def _blink_preset(name: str) -> dict | None:
    key = _blink_key(name)
    return next((p for p in BLINK_PRESETS if _blink_key(p["label"]) == key), None)


def blink_centre(label: str) -> dict:
    """Blink's centre for a preset label (no resolver): {ra, dec}, as the page computes it."""
    p = _blink_preset(label)
    if p is None:
        raise KeyError(f"not a Blink preset: {label!r}")
    ra, dec = p["ra"], p["dec"]
    if "pm" in p:
        pmra, pmdec = p["pm"]
        ra, dec = geometry.propagate(ra, dec, pmra, pmdec, 2000.0,
                                     geometry.jyear_to_mjd(REF_EPOCH))
        ra, dec = round(float(ra), 7), round(float(dec), 7)
    return dict(ra=ra, dec=dec)


class Target(NamedTuple):
    name: str
    blink: bool  # centred as Blink does (no resolver), not as the analysis page does


def plan_targets(names, blink_only: bool = False) -> list[Target]:
    """No names: the analysis presets, then Blink's presets (only Blink's with --blink, since
    Blink never opens the analysis page's proper-motion centres). Names matching a Blink label
    use Blink's centre; anything else goes through the resolver."""
    if not names:
        return ([] if blink_only else [Target(q, False) for q in PRESETS]) \
            + [Target(p["label"], True) for p in BLINK_PRESETS]
    return [Target(q, _blink_preset(q) is not None) for q in names]


async def target_centre(c: httpx.AsyncClient, t: Target) -> dict:
    return blink_centre(t.name) if t.blink else await centre(c, t.name)


def stream_params(p: dict, a: argparse.Namespace) -> dict:
    """/api/stream parameters for a centre, as the page sends them (Blink: no proper motion)."""
    params = {"ra": p["ra"], "dec": p["dec"], "fov": a.fov,
              "scale": max(6.15, a.fov * 3600 / 1000),
              "detectors": a.band, "max_frames": a.max_frames}
    if a.per_visit is not None:
        params["per_visit"] = a.per_visit
    if a.model:
        params["model"] = 1
    if p.get("pmra") is not None:
        params.update(pmra=p["pmra"], pmdec=p["pmdec"], epoch=p["epoch"])
    return params


class StreamRecords:
    """Incremental contract decoder; consume a record only when its payload is complete.

    Payload sizes (float32 planes of npix x npix): an ok frame has 4 planes when the stream
    started with model true (16*npix^2 bytes), else 2 planes (8*npix^2); a progressive
    {"type": "model"} record has 2 planes (8*npix^2)."""

    def __init__(self):
        self.buf = bytearray()
        self.npix = None
        self.frame_planes = 2
        self.ended = False

    def feed(self, chunk: bytes):
        self.buf.extend(chunk)
        records = []
        while len(self.buf) >= 4:
            n = struct.unpack_from("<I", self.buf)[0]
            if len(self.buf) < 4 + n:
                break
            rec = json.loads(self.buf[4:4 + n])
            kind = rec["type"]
            if kind == "start":
                self.npix = rec["npix"]
                self.frame_planes = 4 if rec.get("model") is True else 2
            payload = 0
            if (kind == "frame" and rec.get("ok")) or kind == "model":
                if self.npix is None:
                    raise ValueError(f"{kind} before stream start")
                planes = self.frame_planes if kind == "frame" else 2
                payload = planes * 4 * self.npix * self.npix
            if len(self.buf) < 4 + n + payload:
                break
            del self.buf[:4 + n + payload]
            self.ended |= kind == "end"
            records.append(rec)
        return records

    def finish(self):
        if self.buf or not self.ended:
            raise ValueError("stream ended without a complete end record")


async def _fetch_one(c: httpx.AsyncClient, cat: str, p: dict, radius: float, server: bool) -> int:
    if server:
        r = await c.get("/api/catalog", params=dict(cat=cat, ra=p["ra"], dec=p["dec"],
                                                    radius=radius))
        r.raise_for_status()
        return len(r.json()["sources"])
    rows = await catalogs.prior_catalog(cat, p["ra"], p["dec"], radius, wait=None,
                                        ignore_failures=True)
    if rows is None:
        raise RuntimeError("no catalogue rows returned")
    return len(rows)


def _prior_radius(fov: float) -> float:
    from spherex_app.main import prior_radius  # lazy: importing the app is heavy

    return prior_radius(fov)


async def _fetch_priors(c: httpx.AsyncClient, p: dict, a: argparse.Namespace,
                        sem: asyncio.Semaphore, label: str) -> tuple[float, dict]:
    """Both fit priors for one target, holding one --catalog-concurrency slot."""
    async with sem:
        t0 = time.monotonic()
        radius = _prior_radius(a.fov)
        if a.server and radius > config.CATALOG_RADIUS_MAX_DEG:
            print(f"warning: {label}: radius {radius:.3f} deg is above the server cap "
                  f"({config.CATALOG_RADIUS_MAX_DEG} deg); its prior cache will not match",
                  flush=True)
        names = list(config.PRIOR_CATALOGS)
        res = await asyncio.gather(*(_fetch_one(c, cat, p, radius, a.server) for cat in names),
                                   return_exceptions=True)
        return time.monotonic() - t0, dict(zip(names, res))


async def warm(c: httpx.AsyncClient, q: str, p: dict, a: argparse.Namespace,
               note: str = "") -> int:
    t0 = time.monotonic()
    ok = failed = 0
    end = None
    decoder = StreamRecords()
    async with c.stream("GET", "/api/stream", params=stream_params(p, a)) as r:
        r.raise_for_status()
        async for chunk in r.aiter_bytes():
            for rec in decoder.feed(chunk):
                kind = rec.get("type")
                if kind == "frame":
                    if rec.get("ok"):
                        ok += 1
                    else:
                        failed += 1
                elif kind == "end":
                    end = rec
                    if (ok, failed) != (rec["sent"], rec["failed"]):
                        raise ValueError("stream end counts disagree with decoded frames")
    decoder.finish()
    line = (f"{q:28s} ra={p['ra']:.7f} dec={p['dec']:+.7f} fov={a.fov:g}: {ok} frames, "
            f"{failed} failed, {time.monotonic() - t0:.1f} s")
    if a.model and end is not None:
        st = end.get("model_stats", {})
        priors = [cat for cat in config.PRIOR_CATALOGS if cat in st.get("priors", [])]
        line += (f", models: {st.get('cached', 0)} cached, {st.get('fitted', 0)} fitted, "
                 f"priors {'+'.join(priors) or 'none'}")
    print(line + note, flush=True)
    return failed


async def run(a: argparse.Namespace, c: httpx.AsyncClient) -> int:
    targets = plan_targets(a.targets, blink_only=a.blink)
    centres: list = []
    for t in targets:
        try:
            centres.append(await target_centre(c, t))
        except Exception as e:  # noqa: BLE001
            centres.append(e)
    sem = asyncio.Semaphore(a.catalog_concurrency)
    groups = [asyncio.create_task(_fetch_priors(c, p, a, sem, t.name))
              if a.model and not isinstance(p, Exception) else None
              for t, p in zip(targets, centres)]
    bad = 0
    try:
        for t, p, grp in zip(targets, centres, groups):
            try:
                if isinstance(p, Exception):
                    raise p
                note = ""
                if grp is not None:
                    secs, res = await grp
                    note = f", catalogues {secs:.1f} s"
                    for cat, r in res.items():
                        if isinstance(r, BaseException):
                            bad += 1
                            note += f", {cat} FAILED: {r}"
                bad += bool(await warm(c, t.name, p, a, note))
            except Exception as e:  # noqa: BLE001
                bad += 1
                print(f"{t.name}: FAILED {e}", flush=True)
    finally:
        for g in groups:
            if g is not None:
                g.cancel()
        await asyncio.gather(*(g for g in groups if g is not None), return_exceptions=True)
    return 1 if bad else 0


def band_arg(s: str) -> str:
    parts = [p.strip() for p in s.split(",")]
    if not all(p in BANDS for p in parts):
        raise argparse.ArgumentTypeError(f"detectors are digits 1-6, comma separated: {s!r}")
    return ",".join(parts)


def positive_int(s: str) -> int:
    try:
        v = int(s)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not an integer: {s!r}") from None
    if v < 1:
        raise argparse.ArgumentTypeError(f"must be at least 1: {s!r}")
    return v


def parse_args(argv=None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("targets", nargs="*",
                    help="names or coordinates (default: the analysis and Blink presets; only the Blink presets with --blink)")
    ap.add_argument("--fov", "--width", dest="fov", type=float, default=None,
                    help="field of view in degrees (default 0.1; 0.5 with --blink)")
    ap.add_argument("--band", type=band_arg, default=None,
                    help="detectors to request, e.g. 2 or 1,3 (default 1,2,3,4,5,6; 2 with --blink)")
    ap.add_argument("--per-visit", type=positive_int, default=None,
                    help="per_visit parameter (default: not sent; 6 with --blink)")
    ap.add_argument("--max-frames", type=int, default=400, help="as the page's 'cap' (400)")
    ap.add_argument("--model", action="store_true",
                    help="request model=1 and warm both fit priors before each target streams")
    ap.add_argument("--blink", action="store_true",
                    help="shorthand for --width 0.5 --band 2 --per-visit 6 --model")
    ap.add_argument("--catalog-concurrency", type=positive_int, default=3,
                    help="targets whose catalogue fetches run at once (default 3)")
    ap.add_argument("--server", help="warm a running server, e.g. http://localhost:8000")
    a = ap.parse_args(argv)
    for k, v in (BLINK_DEFAULTS if a.blink else PLAIN_DEFAULTS).items():
        if getattr(a, k) is None:
            setattr(a, k, v)
    a.model = a.model or a.blink
    return a


async def main(argv=None) -> int:
    a = parse_args(argv)
    if a.server:
        c = httpx.AsyncClient(base_url=a.server, timeout=None)
    else:
        from spherex_app.main import app
        c = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://app",
                              timeout=None)
    try:
        return await run(a, c)
    finally:
        if not a.server:
            await catalogs.close()  # before the HTTP client its queries use
        await c.aclose()
        await archive.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
