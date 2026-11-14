"""Warm the backend's disk cache (frame lists, cutouts, wavelength tables) for a few targets.

Each target is resolved and centred exactly as the web page does it: the name goes through
/api/resolve; if there is a proper motion, the position is propagated to epoch 2026.0 and
rounded to 7 decimals. Then /api/stream is requested with the page's default parameters.
The cutout cache is keyed by the exact centre, so a later visit from the page is served
from disk.

    uv run python backend/scripts/prewarm.py                       # the five challenge targets
    uv run python backend/scripts/prewarm.py --fov 0.2 "RW Aur" "10.684 41.269"
    uv run python backend/scripts/prewarm.py --server http://localhost:8000   # a running server

By default the app runs in-process, with the same code and the same SPHEREX_CACHE_DIR
as the server. With --server, a running instance is warmed instead (its in-memory caches too).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from spherex_app import archive, geometry  # noqa: E402

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


class StreamRecords:
    """Incremental contract decoder; consume a record only when its payload is complete."""

    def __init__(self):
        self.buf = bytearray()
        self.npix = None
        self.ended = False

    def feed(self, chunk: bytes):
        self.buf.extend(chunk)
        records = []
        while len(self.buf) >= 4:
            n = struct.unpack_from("<I", self.buf)[0]
            if len(self.buf) < 4 + n:
                break
            rec = json.loads(self.buf[4:4 + n])
            if rec["type"] == "start":
                self.npix = rec["npix"]
            payload = 0
            if rec["type"] == "frame" and rec.get("ok"):
                if self.npix is None:
                    raise ValueError("frame before stream start")
                payload = 8 * self.npix * self.npix
            if len(self.buf) < 4 + n + payload:
                break
            del self.buf[:4 + n + payload]
            self.ended |= rec["type"] == "end"
            records.append(rec)
        return records

    def finish(self):
        if self.buf or not self.ended:
            raise ValueError("stream ended without a complete end record")


async def warm(c: httpx.AsyncClient, q: str, fov: float, max_frames: int) -> int:
    t0 = time.monotonic()
    p = await centre(c, q)
    params = {"ra": p["ra"], "dec": p["dec"], "fov": fov, "scale": 6.15,
              "detectors": "1,2,3,4,5,6", "max_frames": max_frames}
    if p["pmra"] is not None:
        params.update(pmra=p["pmra"], pmdec=p["pmdec"], epoch=p["epoch"])
    ok = failed = 0
    decoder = StreamRecords()
    async with c.stream("GET", "/api/stream", params=params) as r:
        r.raise_for_status()
        async for chunk in r.aiter_bytes():
            for rec in decoder.feed(chunk):
                if rec.get("type") == "frame":
                    if rec.get("ok"):
                        ok += 1
                    else:
                        failed += 1
                elif rec.get("type") == "end" and (ok, failed) != (rec["sent"], rec["failed"]):
                    raise ValueError("stream end counts disagree with decoded frames")
    decoder.finish()
    print(f"{q:28s} ra={p['ra']:.7f} dec={p['dec']:+.7f} fov={fov:g}: {ok} frames, "
          f"{failed} failed, {time.monotonic() - t0:.1f} s", flush=True)
    return failed


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("targets", nargs="*", default=list(PRESETS),
                    help="names or coordinates (default: the five challenge targets)")
    ap.add_argument("--fov", type=float, default=0.1)
    ap.add_argument("--max-frames", type=int, default=400, help="as the page's 'cap' (400)")
    ap.add_argument("--server", help="warm a running server, e.g. http://localhost:8000")
    a = ap.parse_args()
    if a.server:
        c = httpx.AsyncClient(base_url=a.server, timeout=None)
    else:
        from spherex_app.main import app
        c = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://app",
                              timeout=None)
    bad = 0
    try:
        for q in a.targets:
            try:
                bad += bool(await warm(c, q, a.fov, a.max_frames))
            except Exception as e:  # noqa: BLE001
                bad += 1
                print(f"{q}: FAILED {e}", flush=True)
    finally:
        await c.aclose()
        await archive.close()
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
