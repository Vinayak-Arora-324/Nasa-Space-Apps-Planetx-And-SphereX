"""Build the star list that the whole-sky rewind draws (frontend/data/rewind-stars.json).

The rewind needs, for every star it moves, a position, proper motion, parallax and radial velocity,
so that it can be carried through space to any epoch. The source is XHIP, the Extended Hipparcos
Compilation (Anderson & Francis 2012, VizieR V/137D): Hipparcos 2007 astrometry (ICRS, epoch
J1991.25) with radial velocities from the literature. Gaia DR3 is not used here because it
saturates on the bright naked-eye stars, which are the ones whose motion people notice.

Kept: every star brighter than V = 5.0 (trails, asterisms, labels) and every star moving at least
400 mas/yr (those shift by more than 0.2 degrees in 2,000 years).

    uv run python backend/scripts/build_rewind_stars.py
    uv run python backend/scripts/build_rewind_stars.py --tsv xhip.tsv     # from a saved download
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "frontend" / "data" / "rewind-stars.json"
COLUMNS = "HIP,RAJ2000,DEJ2000,Plx,pmRA,pmDE,RV,Vmag,B-V,Name"
# CDS first, then its mirrors (the CDS host is sometimes down for maintenance).
MIRRORS = (
    "https://vizier.cds.unistra.fr/viz-bin/asu-tsv",
    "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv",
    "https://vizieridia.cds.unistra.fr/viz-bin/asu-tsv",
)
V_MAX = 5.0
PM_MIN = 400.0  # mas/yr
# Proper names are shown only for these stars (bright, or part of the story of the pole).
LABEL_V_MAX = 1.6
LABEL_ALWAYS = {11767, 68756, 72607, 87937}  # Polaris, Thuban, Kochab, Barnard's Star
# XHIP's name column has transliterations and one mix-up (HIP 71681 is alpha Cen B, not Proxima).
NAME_FIX = {72607: "Kochab", 71683: "Alpha Centauri", 68702: "Hadar", 71681: None}


def download() -> str:
    params = {"-source": "V/137D/XHIP", "-out.max": "unlimited", "-out": COLUMNS}
    last = None
    for url in MIRRORS:
        try:
            r = httpx.get(url, params=params, timeout=300, follow_redirects=True)
            r.raise_for_status()
            if "\tRAJ2000\t" not in r.text:
                raise ValueError("not a VizieR TSV table")
            return r.text
        except (httpx.HTTPError, ValueError) as e:
            print(f"{url}: {e}", file=sys.stderr)
            last = e
    raise SystemExit(f"could not download XHIP from any VizieR mirror ({last})")


def num(s: str) -> float | None:
    s = s.strip()
    if not s:
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def proper_name(raw: str) -> str | None:
    m = re.search(r"\(([^)]+)\)", raw)
    return m.group(1).strip() if m else None


def parse(text: str) -> tuple[list[list], dict[str, str]]:
    lines = [ln for ln in text.splitlines() if ln and not ln.startswith("#")]
    head = lines[0].split("\t")
    idx = {c: head.index(c) for c in COLUMNS.split(",")}
    rows, names = [], {}
    for ln in lines[3:]:  # header, units, dashes
        f = ln.split("\t")
        if len(f) < len(head):
            continue
        hip = num(f[idx["HIP"]])
        ra, dec, v = num(f[idx["RAJ2000"]]), num(f[idx["DEJ2000"]]), num(f[idx["Vmag"]])
        pmra, pmde = num(f[idx["pmRA"]]), num(f[idx["pmDE"]])
        if hip is None or ra is None or dec is None or v is None:
            continue
        pm = math.hypot(pmra or 0.0, pmde or 0.0)
        hip = int(hip)
        if v >= V_MAX and pm < PM_MIN and hip not in LABEL_ALWAYS:
            continue
        plx, rv, bv = num(f[idx["Plx"]]), num(f[idx["RV"]]), num(f[idx["B-V"]])
        rows.append([hip, round(ra, 6), round(dec, 6), round(pmra or 0.0, 2), round(pmde or 0.0, 2),
                     round(plx, 2) if plx is not None else 0, round(rv, 2) if rv is not None else None,
                     round(v, 2), round(bv, 2) if bv is not None else None])
        name = NAME_FIX[hip] if hip in NAME_FIX else proper_name(f[idx["Name"]])
        if name and (v < LABEL_V_MAX or hip in LABEL_ALWAYS):
            names[str(hip)] = name
    rows.sort(key=lambda r: r[7])  # brightest first
    return rows, names


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--tsv", type=Path, help="use a saved VizieR TSV download instead of fetching")
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()
    text = a.tsv.read_text() if a.tsv else download()
    rows, names = parse(text)
    doc = {
        "source": "XHIP, Extended Hipparcos Compilation (Anderson & Francis 2012), VizieR V/137D",
        "frame": "ICRS",
        "epoch": 1991.25,
        "selection": f"V < {V_MAX} or total proper motion >= {PM_MIN:g} mas/yr",
        "fields": ["hip", "ra_deg", "dec_deg", "pmra_masyr", "pmdec_masyr", "plx_mas", "rv_kms", "vmag", "bv"],
        "stars": rows,
        "names": names,
    }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"wrote {len(rows)} stars ({len(names)} named) to {a.out} ({a.out.stat().st_size / 1024:.0f} KiB)")


if __name__ == "__main__":
    main()
