"""Pre-warm the IRSA frame lists (which SPHEREx exposures cover a sky position) for many fields.

Only the exposure lists are fetched: no cutouts, no models. The slow TAP query (2-5 min) runs
ahead of time, and each warmed field then shows as "ready" on the sky sphere (GET /api/coverage).
A list younger than FRAMES_DISK_TTL_S (6 h) counts as fresh and is skipped unless --force.

    uv run python backend/scripts/warm_coverage.py "133.795129 -7.245147" "10.0,20.0"
    uv run python backend/scripts/warm_coverage.py --file fields.txt
    uv run python backend/scripts/warm_coverage.py --grid 130 140 -10 0 0.5 --dry-run
    uv run python backend/scripts/warm_coverage.py --file fields.txt --force --concurrency 1

A fields file has one "ra dec [label]" per line (decimal degrees, space or comma separated).
Blank lines and lines starting with # are ignored. A field whose first value is negative must
come after a bare --, e.g. `warm_coverage.py -- "-5.0 3.0"`, or go in the file.

Exit status: 0 if every field succeeded, 1 if any failed, 2 on bad arguments.
"""

from __future__ import annotations

import argparse
import asyncio
import math
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from spherex_app import archive, cache, config  # noqa: E402

# "ra dec" then an optional free-text label; the separators may be spaces and/or commas.
_LINE_RE = re.compile(r"^(\S+?)[\s,]+(\S+?)(?:[\s,]+(.*))?$")


def _centre(ra: float, dec: float) -> tuple[float, float]:
    """Round to 7 decimals (as the app does), wrap RA into [0, 360), check dec."""
    if not (math.isfinite(ra) and math.isfinite(dec)):
        raise ValueError(f"non-finite centre {ra} {dec}")
    if not -90.0 <= dec <= 90.0:
        raise ValueError(f"dec {dec:g} outside [-90, 90]")
    ra = round(ra % 360.0, 7)
    if ra >= 360.0:  # rounding of e.g. 359.99999999999 can give exactly 360
        ra = 0.0
    return ra, round(dec + 0.0, 7)  # + 0.0 turns -0.0 into 0.0


def parse_field(s: str) -> tuple[float, float]:
    """'RA DEC' or 'RA,DEC' in decimal degrees -> (ra, dec)."""
    m = _LINE_RE.match(s.strip())
    if not m or m.group(3):
        raise ValueError(f"expected 'RA DEC' in degrees, got {s!r}")
    try:
        ra, dec = float(m.group(1)), float(m.group(2))
    except ValueError:
        raise ValueError(f"not numbers: {s!r}") from None
    return _centre(ra, dec)


def read_fields_file(path) -> list[tuple[float, float, str]]:
    """Fields from a text file: (ra, dec, label) per line, label '' if absent."""
    out = []
    for n, raw in enumerate(Path(path).read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _LINE_RE.match(line)
        if not m:
            raise ValueError(f"{path}:{n}: expected 'ra dec [label]', got {line!r}")
        try:
            ra, dec = _centre(float(m.group(1)), float(m.group(2)))
        except ValueError as e:
            raise ValueError(f"{path}:{n}: {e}") from None
        out.append((ra, dec, (m.group(3) or "").strip()))
    return out


def grid_fields(ra_min: float, ra_max: float, dec_min: float, dec_max: float,
                step: float) -> list[tuple[float, float]]:
    """Grid of centres: rows of constant dec every `step`, RA spaced about step / cos(dec).

    Each row spans RA_MIN..RA_MAX (through 0 if RA_MAX < RA_MIN) with the nearest whole number
    of steps, so both ends are included and the spacing is within a few percent of the ideal.
    """
    if not step > 0:
        raise ValueError("grid STEP must be positive")
    if not (-90.0 <= dec_min <= dec_max <= 90.0):
        raise ValueError("grid DEC_MIN and DEC_MAX must satisfy -90 <= DEC_MIN <= DEC_MAX <= 90")
    if abs(ra_max - ra_min) >= 360.0:
        raise ValueError("grid RA span must be less than 360 degrees")
    width = (ra_max - ra_min) % 360.0  # RA_MIN > RA_MAX wraps through 0
    n_dec = math.floor((dec_max - dec_min) / step + 1e-9)
    out = []
    for i in range(n_dec + 1):
        dec = min(90.0, dec_min + i * step)
        cos_dec = max(math.cos(math.radians(dec)), 0.05)
        n_ra = max(1, round(width / (step / cos_dec)))
        for j in range(n_ra + 1):
            out.append(_centre(ra_min + width * j / n_ra, dec))
    return out


def _keys(ra: float, dec: float):
    """The in-memory key and the disk key find_frames uses for a centre."""
    key = (round(ra, 6), round(dec, 6))
    return key, cache.key_hash("frames-v1", *key)


def _disk_fresh(ra: float, dec: float):
    """(n_frames, age_s) if the disk list is younger than FRAMES_DISK_TTL_S, else None."""
    _, dkey = _keys(ra, dec)
    disk = cache.get_json_aged("frames", dkey)
    if disk is None:
        return None
    rows, age = disk
    if age >= config.FRAMES_DISK_TTL_S:
        return None
    return len(archive.parse_frame_rows(rows)), age


async def warm_field(ra: float, dec: float, force: bool, sem: asyncio.Semaphore) -> dict:
    """Query one field's frame list (unless fresh). Never raises for an ordinary failure."""
    if not force:
        hit = _disk_fresh(ra, dec)
        if hit is not None:
            return {"ra": ra, "dec": dec, "status": "fresh", "n_frames": hit[0],
                    "age_s": hit[1]}
    key, dkey = _keys(ra, dec)
    t0 = time.monotonic()
    async with sem:
        try:
            frames = await archive._query_frames(ra, dec, key, dkey)
        except Exception as e:  # noqa: BLE001 - one bad field must not stop the run
            return {"ra": ra, "dec": dec, "status": "failed",
                    "error": str(e) or type(e).__name__, "seconds": time.monotonic() - t0}
    return {"ra": ra, "dec": dec, "status": "queried", "n_frames": len(frames),
            "seconds": time.monotonic() - t0}


def _format(r: dict, label: str) -> str:
    head = f"{r['ra']:11.7f} {r['dec']:+11.7f}  "
    if r["status"] == "queried":
        body = f"{r['n_frames']} frames  {r['seconds']:.1f} s"
    elif r["status"] == "fresh":
        body = f"fresh (cached {r['age_s'] / 3600:.1f} h ago, {r['n_frames']} frames)"
    else:
        body = f"FAILED {r['error']}"
    return head + body + (f"  [{label}]" if label else "")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="Pre-warm SPHEREx exposure lists for sky fields.")
    ap.add_argument("fields", nargs="*", metavar="FIELD",
                    help='"RA DEC" in degrees, e.g. "133.795129 -7.245147" or "133.795129,-7.245147"')
    ap.add_argument("--file", type=Path,
                    help="text file with one 'ra dec [label]' per line")
    ap.add_argument("--grid", nargs=5, type=float,
                    metavar=("RA_MIN", "RA_MAX", "DEC_MIN", "DEC_MAX", "STEP"),
                    help="grid of centres in degrees; RA_MIN > RA_MAX wraps through 0")
    ap.add_argument("--concurrency", type=int, default=2,
                    help="TAP queries at once (default 2; IRSA is slow)")
    ap.add_argument("--force", action="store_true",
                    help="re-query even when a fresh list is on disk")
    ap.add_argument("--dry-run", action="store_true",
                    help="show the fields and whether each would be queried; query nothing")
    return ap


async def main(argv=None) -> int:
    ap = build_parser()
    a = ap.parse_args(argv)
    if a.concurrency < 1:
        print("error: --concurrency must be at least 1", file=sys.stderr)
        return 2
    try:
        fields = [(*parse_field(s), "") for s in a.fields]
        if a.file is not None:
            fields += read_fields_file(a.file)
        if a.grid is not None:
            fields += [(ra, dec, "") for ra, dec in grid_fields(*a.grid)]
    except (ValueError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    if not fields:
        print("error: no fields given (positional, --file or --grid)", file=sys.stderr)
        return 2

    unique, seen = [], set()  # the same centre twice is queried once
    for ra, dec, label in fields:
        k = _keys(ra, dec)[0]
        if k not in seen:
            seen.add(k)
            unique.append((ra, dec, label))

    if a.dry_run:
        for ra, dec, label in unique:
            hit = None if a.force else _disk_fresh(ra, dec)
            if hit is None:
                state = "would query"
            else:
                state = f"would skip (fresh, cached {hit[1] / 3600:.1f} h ago, {hit[0]} frames)"
            print(f"{ra:11.7f} {dec:+11.7f}  {state}" + (f"  [{label}]" if label else ""),
                  flush=True)
        print(f"{len(unique)} fields", flush=True)
        return 0

    sem = asyncio.Semaphore(a.concurrency)
    counts = {"queried": 0, "fresh": 0, "failed": 0}
    labels = {(ra, dec): label for ra, dec, label in unique}
    t0 = time.monotonic()
    tasks = [asyncio.ensure_future(warm_field(ra, dec, a.force, sem)) for ra, dec, _ in unique]
    try:
        for fut in asyncio.as_completed(tasks):
            r = await fut
            counts[r["status"]] += 1
            print(_format(r, labels[(r["ra"], r["dec"])]), flush=True)
    finally:
        for t in tasks:
            t.cancel()
        await archive.close()
    print(f"queried {counts['queried']}, fresh {counts['fresh']}, failed {counts['failed']} "
          f"in {time.monotonic() - t0:.1f} s", flush=True)
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
