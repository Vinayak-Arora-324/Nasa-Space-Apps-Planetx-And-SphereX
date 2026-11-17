"""Build the constellations and deep-sky objects that the whole-sky rewind draws (frontend/data/rewind-sky.json).

Sources:
  - Constellation stick figures, names, label points, IAU boundaries and the Messier list: d3-celestial by
    Olaf Frohn (BSD 3-clause), pinned to one commit so the output is reproducible.
  - Stars: XHIP (Anderson & Francis 2012, VizieR V/137D), as in build_rewind_stars.py.

The stick figures are polylines in J2000 RA/Dec. Each vertex is snapped to its Hipparcos star, so the figures
move with the stars through the millennia. Stars used by a figure that are not already in rewind-stars.json
(fainter than V = 5) are written here as `extraStars`, with the same fields.

The IAU boundaries (Delporte 1930) run along lines of constant right ascension and declination of the B1875.0
equator. Each edge is taken back to B1875, filled in along its meridian or parallel there, then brought to
ICRS. Boundaries are fixed among the distant stars, so they need no further motion at runtime.

    uv run python backend/scripts/build_rewind_sky.py
    uv run python backend/scripts/build_rewind_sky.py --tsv xhip.tsv     # from a saved XHIP download
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import erfa
import httpx
import numpy as np

from build_rewind_stars import COLUMNS, OUT as STARS_OUT, download, num

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "frontend" / "data" / "rewind-sky.json"
D3_SHA = "7e720a3de062059d4c5400a379146a601d9010e0"
D3 = f"https://raw.githubusercontent.com/ofrohn/d3-celestial/{D3_SHA}/data/"
SNAP_DEG = 0.05      # a figure vertex must be this close to its star
STEP_DEG = 1.0       # boundary edges are filled in to at most this spacing

# Messier objects shown with a common name, and how prominent each label is (1 = always, 2 = most views,
# 3 = only when zoomed in). Names follow common English usage.
MESSIER = {
    "M1": ("Crab Nebula", 3), "M6": ("Butterfly Cluster", 3), "M7": ("Ptolemy's Cluster", 2),
    "M8": ("Lagoon Nebula", 2), "M11": ("Wild Duck Cluster", 3), "M13": ("Hercules Cluster", 2),
    "M16": ("Eagle Nebula", 3), "M17": ("Omega Nebula", 3), "M20": ("Trifid Nebula", 3),
    "M27": ("Dumbbell Nebula", 3), "M31": ("Andromeda Galaxy", 1), "M33": ("Triangulum Galaxy", 2),
    "M42": ("Orion Nebula", 1), "M44": ("Beehive Cluster", 2), "M45": ("Pleiades", 1),
    "M51": ("Whirlpool Galaxy", 3), "M57": ("Ring Nebula", 3), "M81": ("Bode's Galaxy", 3),
    "M82": ("Cigar Galaxy", 3), "M83": ("Southern Pinwheel", 3), "M87": ("Virgo A", 3),
    "M101": ("Pinwheel Galaxy", 3), "M104": ("Sombrero Galaxy", 3),
}
# Star clusters near enough to drift visibly are tied to a member star (HIP), so they move with it.
ANCHOR = {"M45": 17702}   # Alcyone
# Figure stars that XHIP (and the Hipparcos main catalogue) give no astrometry for, from the literature:
# J2000 ra, dec (deg), pmra, pmdec (mas/yr), parallax (mas), rv (km/s), V, B-V.
MISSING = {
    55203: (169.5455, 31.5292, -339.4, -607.8, 113.2, -16.9, 3.79, 0.59),   # xi UMa (Alula Australis), a close binary
}
# IAU (WGSN) proper names for the brighter stars, beyond the 28 that rewind-stars.json names. Shown when
# zoomed in; XHIP's own name column uses older transliterations.
STAR_NAMES = {
    25428: "Elnath", 45238: "Miaplacidus", 26311: "Alnilam", 109268: "Alnair", 26727: "Alnitak", 62956: "Alioth",
    15863: "Mirfak", 90185: "Kaus Australis", 54061: "Dubhe", 34444: "Wezen", 67301: "Alkaid", 41037: "Avior",
    86228: "Sargas", 28360: "Menkalinan", 82273: "Atria", 31681: "Alhena", 100751: "Peacock", 30324: "Mirzam",
    46390: "Alphard", 50583: "Algieba", 9884: "Hamal", 3419: "Diphda", 92855: "Nunki", 68933: "Menkent",
    27366: "Saiph", 5447: "Mirach", 677: "Alpheratz", 86032: "Rasalhague", 14576: "Algol", 9640: "Almach",
    57632: "Denebola", 39429: "Naos", 45556: "Aspidiske", 76267: "Alphecca", 100453: "Sadr", 44816: "Suhail",
    65378: "Mizar", 3179: "Schedar", 87833: "Eltanin", 25930: "Mintaka", 746: "Caph", 78401: "Dschubba",
    72105: "Izar", 107315: "Enif", 2081: "Ankaa", 58001: "Phecda", 84012: "Sabik", 113881: "Scheat",
    105199: "Alderamin", 35904: "Aludra", 102488: "Aljanah", 113963: "Markab", 14135: "Menkar", 54872: "Zosma",
    78820: "Acrab", 25985: "Arneb", 59803: "Gienah", 53910: "Merak", 85927: "Shaula", 25336: "Bellatrix",
    65477: "Alcor", 10826: "Mira", 17702: "Alcyone", 95947: "Albireo", 8903: "Sheratan", 36188: "Gomeisa",
}
# Not in the Messier list. ICRS degrees.
EXTRA_DSO = [
    ("lmc", "Large Magellanic Cloud", "g", 0.9, 80.894, -69.756, 1, None),
    ("smc", "Small Magellanic Cloud", "g", 2.7, 13.187, -72.829, 1, None),
    ("gc", "Galactic centre", "gc0", None, 266.41683, -29.00781, 1, None),   # Sgr A*
    ("omegacen", "Omega Centauri", "gc", 3.9, 201.697, -47.4795, 2, None),
    ("47tuc", "47 Tucanae", "gc", 4.1, 6.0236, -72.0813, 2, None),
    ("hyades", "Hyades", "oc", 0.5, 66.75, 15.87, 2, 20894),              # theta2 Tauri
    ("doublecl", "Double Cluster", "oc", 4.3, 34.75, 57.13, 2, None),
    ("carina", "Carina Nebula", "sfr", 1.0, 161.265, -59.867, 2, None),
    ("coalsack", "Coalsack", "dn", None, 189.5, -62.9, 2, None),
]


def fetch(name: str) -> dict:
    r = httpx.get(D3 + name, timeout=60, follow_redirects=True)
    r.raise_for_status()
    return r.json()


def parse_xhip(text: str) -> dict[int, list]:
    """Every XHIP star with a position and V magnitude, as rewind-stars.json rows, keyed by HIP."""
    lines = [ln for ln in text.splitlines() if ln and not ln.startswith("#")]
    head = lines[0].split("\t")
    idx = {c: head.index(c) for c in COLUMNS.split(",")}
    out = {}
    for ln in lines[3:]:
        f = ln.split("\t")
        if len(f) < len(head):
            continue
        hip, ra, dec, v = (num(f[idx[c]]) for c in ("HIP", "RAJ2000", "DEJ2000", "Vmag"))
        if hip is None or ra is None or dec is None or v is None:
            continue
        pmra, pmde, plx, rv, bv = (num(f[idx[c]]) for c in ("pmRA", "pmDE", "Plx", "RV", "B-V"))
        out[int(hip)] = [int(hip), round(ra, 6), round(dec, 6), round(pmra or 0.0, 2), round(pmde or 0.0, 2),
                         round(plx, 2) if plx is not None else 0, round(rv, 2) if rv is not None else None,
                         round(v, 2), round(bv, 2) if bv is not None else None]
    return out


def unit(ra: np.ndarray, dec: np.ndarray) -> np.ndarray:
    a, d = np.radians(ra), np.radians(dec)
    return np.stack([np.cos(d) * np.cos(a), np.cos(d) * np.sin(a), np.sin(d)], axis=-1)


def radec(v: np.ndarray) -> tuple[float, float]:
    return math.degrees(math.atan2(v[1], v[0])) % 360.0, math.degrees(math.asin(max(-1.0, min(1.0, v[2]))))


def snap_figures(lines: dict, xhip: dict[int, list]) -> tuple[dict[str, list], set[int]]:
    hips = np.array(list(xhip))
    rows = np.array([xhip[h][1:5] for h in hips], dtype=float)
    # carry XHIP (J1991.25) to J2000 to match the figures
    dt = 2000.0 - 1991.25
    dec = rows[:, 1] + rows[:, 3] / 3.6e6 * dt
    ra = rows[:, 0] + rows[:, 2] / 3.6e6 * dt / np.cos(np.radians(rows[:, 1]))
    sv = unit(ra, dec)
    figures: dict[str, list] = {}
    used: set[int] = set()
    misses = []
    for feat in lines["features"]:
        cid = feat["id"]
        for poly in feat["geometry"]["coordinates"]:
            line = []
            for lon, lat in poly:
                v = unit(np.array(lon % 360.0), np.array(lat))
                ang = np.degrees(np.arccos(np.clip(sv @ v, -1, 1)))
                near = np.where(ang < SNAP_DEG)[0]
                if not len(near):
                    misses.append((cid, lon, lat, float(ang.min())))
                    continue
                h = int(hips[near[np.argmin(ang[near])]])
                line.append(h)
                used.add(h)
            if len(line) > 1:
                figures.setdefault(cid, []).append(line)
    if misses:
        for m in misses:
            print(f"no star within {SNAP_DEG} deg of {m[0]} vertex ({m[1]}, {m[2]}): nearest {m[3]:.3f} deg", file=sys.stderr)
        raise SystemExit("figure vertices without a star")
    return figures, used


def boundaries(borders: dict) -> list[list[float]]:
    """IAU boundary edges as ICRS polylines [ra0, dec0, ra1, dec1, ...] filled in along B1875 meridians/parallels."""
    P = erfa.pmat06(*erfa.epb2jd(1875.0))     # GCRS -> mean equator and equinox of B1875
    out, odd = [], 0
    for feat in borders["features"]:
        for poly in feat["geometry"]["coordinates"]:
            pts = [P @ unit(np.array(lon % 360.0), np.array(lat)) for lon, lat in poly]
            b = [radec(p) for p in pts]
            dense = [b[0]]
            for (ra0, de0), (ra1, de1) in zip(b, b[1:]):
                dra = (ra1 - ra0 + 180.0) % 360.0 - 180.0
                n = max(1, math.ceil(max(abs(dra) * math.cos(math.radians(de0)), abs(de1 - de0)) / STEP_DEG))
                if abs(dra) > 0.02 and abs(de1 - de0) > 0.02:
                    odd += 1
                for i in range(1, n + 1):
                    f = i / n
                    # a parallel keeps its declination; a meridian keeps its right ascension
                    dense.append(((ra0 + dra * f) % 360.0, de0 + (de1 - de0) * f))
            line = []
            for ra, de in dense:
                g = P.T @ unit(np.array(ra), np.array(de))
                r2, d2 = radec(g)
                line += [round(r2, 3), round(d2, 3)]
            out.append(line)
    if odd:
        print(f"note: {odd} boundary segments are neither B1875 meridians nor parallels", file=sys.stderr)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--tsv", type=Path, help="use a saved XHIP VizieR TSV download instead of fetching")
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()

    lines, names, borders, messier = (fetch(n) for n in (
        "constellations.lines.json", "constellations.json", "constellations.borders.json", "messier.json"))
    xhip = parse_xhip(a.tsv.read_text() if a.tsv else download())
    for hip, (ra, dec, pmra, pmde, plx, rv, v, bv) in MISSING.items():
        if hip not in xhip:   # back to the XHIP epoch, J1991.25
            dt = 1991.25 - 2000.0
            ra += pmra / 3.6e6 * dt / math.cos(math.radians(dec))
            dec += pmde / 3.6e6 * dt
            xhip[hip] = [hip, round(ra, 6), round(dec, 6), pmra, pmde, plx, rv, v, bv]
    figures, used = snap_figures(lines, xhip)

    have = {row[0] for row in json.loads(STARS_OUT.read_text())["stars"]}
    need = used | {h for h in ANCHOR.values()} | {e[7] for e in EXTRA_DSO if e[7]} | set(STAR_NAMES)
    extra = sorted((xhip[h] for h in need - have), key=lambda r: r[7])

    seen: set[str] = set()
    cons = []
    for feat in names["features"]:
        cid, p = feat["id"], feat["properties"]
        # Serpens comes in two parts (Caput and Cauda), each with its own label
        part = 2 if cid in seen else 1
        seen.add(cid)
        lon, lat = feat["geometry"]["coordinates"]
        cons.append({"id": cid if part == 1 else f"{cid}{part}", "abbr": cid, "name": p["name"], "rank": int(p["rank"]),
                     "ra": round(lon % 360.0, 3), "dec": round(lat, 3)})
    fig_out = dict(sorted(figures.items()))   # both Serpens parts are drawn under "Ser"

    dsos = []
    for feat in messier["features"]:
        mid, p = feat["id"], feat["properties"]
        if mid not in MESSIER:
            continue
        name, prio = MESSIER[mid]
        lon, lat = feat["geometry"]["coordinates"]
        d = {"id": mid, "name": name, "type": p["type"], "mag": p["mag"], "ra": round(lon % 360.0, 4),
             "dec": round(lat, 4), "prio": prio}
        if mid in ANCHOR:
            d["hip"] = ANCHOR[mid]
        dsos.append(d)
    for did, name, typ, mag, ra, dec, prio, hip in EXTRA_DSO:
        d = {"id": did, "name": name, "type": typ, "mag": mag, "ra": ra, "dec": dec, "prio": prio}
        if hip:
            d["hip"] = hip
        dsos.append(d)
    dsos.sort(key=lambda d: (d["prio"], d["mag"] if d["mag"] is not None else 99))

    doc = {
        "source": {
            "constellations": f"d3-celestial by Olaf Frohn (BSD 3-clause), commit {D3_SHA}",
            "boundaries": "IAU constellation boundaries (Delporte 1930) via d3-celestial, filled in along B1875.0 "
                          "meridians and parallels and transformed to ICRS with IAU 2006 precession",
            "stars": "XHIP, Extended Hipparcos Compilation (Anderson & Francis 2012), VizieR V/137D",
            "licence": "d3-celestial data: Copyright (c) 2015, Olaf Frohn. BSD 3-clause licence; see "
                       "https://github.com/ofrohn/d3-celestial/blob/master/LICENSE",
        },
        "frame": "ICRS",
        "starEpoch": 1991.25,
        "starFields": ["hip", "ra_deg", "dec_deg", "pmra_masyr", "pmdec_masyr", "plx_mas", "rv_kms", "vmag", "bv"],
        "extraStars": extra,
        "starNames": {str(h): n for h, n in sorted(STAR_NAMES.items())},
        "constellations": cons,
        "figures": fig_out,
        "boundaries": boundaries(borders),
        "dsos": dsos,
    }
    a.out.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    n_seg = sum(len(v) for v in fig_out.values())
    print(f"wrote {len(cons)} constellation names, {len(fig_out)} figures ({n_seg} lines, {len(used)} stars, "
          f"{len(extra)} extra), {len(doc['boundaries'])} boundary edges, {len(dsos)} deep-sky objects to {a.out} "
          f"({a.out.stat().st_size / 1024:.0f} KiB)")


if __name__ == "__main__":
    main()
