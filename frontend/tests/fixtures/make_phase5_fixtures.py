"""Fixtures for the Phase 5 frontend tests (docs/object-framework.md section 20.13).

Run from backend/ (pyerfa comes with astropy):
    cd backend && uv run python ../frontend/tests/fixtures/make_phase5_fixtures.py            # pyerfa + tile records
    cd backend && uv run python ../frontend/tests/fixtures/make_phase5_fixtures.py --skybot   # also re-fetch SkyBoT (live)

Writes next to this script:
  phase5-erfa.json     ERFA plan94 / epv00 / moon98 vectors at five dates in 1900-2100 (AU, ICRS axes), for ephem.test.mjs
  phase5-orbits.json   TRAPPIST-1 b, Gaia BH1 and Cyg X-1 expanded from the committed tiles, for scene3d-orbits.test.mjs
  phase5-skybot-ceres.json  the raw SkyBoT resolver answers for Ceres at two epochs and the fetch date, for scene3d-motion.test.mjs
The first two are deterministic; the SkyBoT file is a snapshot of a live service and is only rewritten with --skybot.
"""
import datetime
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import erfa

HERE = Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "objects"
# TT Julian Days: 1900-01-01, 1950-06-15, J2000, 2026-11-20, 2099-12-31
DATES = [2415020.5, 2433812.5, 2451545.0, 2461360.0, 2488069.5]
PLAN94_NP = {"mercury": 1, "venus": 2, "earth_moon_barycentre": 3, "mars": 4, "jupiter": 5, "saturn": 6, "uranus": 7, "neptune": 8}


def erfa_fixture():
    out = []
    for jd in DATES:
        p = {name: [float(c) for c in erfa.plan94(jd, 0.0, np_)[0]] for name, np_ in PLAN94_NP.items()}
        pvh, _pvb = erfa.epv00(jd, 0.0)           # heliocentric (pvh) and barycentric Earth, ICRS axes
        moon = erfa.moon98(jd, 0.0)               # geocentric Moon, GCRS, with ERFA's IAU 2006 precession
        out.append({"jd": jd, "plan94": p, "epv00_earth_helio": [float(c) for c in pvh["p"]],
                    "moon98_gcrs": [float(c) for c in moon["p"]]})
    # a denser scan of the heliocentric Earth, for the 7,000 km bound (section 20.2 measured 6,496 km over 23,565 dates every 3.1 d)
    scan = []
    for k in range(600):
        jd = 2415020.5 + k * (2488069.5 - 2415020.5) / 599
        scan.append([jd] + [float(c) for c in erfa.epv00(jd, 0.0)[0]["p"]])
    return {"generator": "make_phase5_fixtures.py", "pyerfa": erfa.__version__, "units": "AU, ICRS axes, TT jd", "dates": out,
            "epv00_earth_scan": {"columns": ["jd", "x", "y", "z"], "rows": scan}}


def expand(q, table):
    if q is None:
        return None
    v, idx, *rest = q
    o = {"v": v, "tier": table[idx][1]}
    if len(rest) == 2:
        o["lo"], o["hi"] = rest
    return o


def tile_record(dataset, tile, rid):
    man = json.loads((DATA / dataset / "manifest.json").read_text())
    table = man["quantity_table"]
    for r in json.loads((DATA / dataset / "tiles" / f"{tile}.json").read_text())["objects"]:
        if r["id"] == rid:
            pos = r["position"]
            el = {k: expand(v, table) for k, v in pos["elements"].items()}
            props = {k: {"v": v[0]} for k, v in (r.get("props") or {}).items() if k == "disc_method"}
            return {"id": r["id"], "kind": r["kind"], "name": r["name"], "host": r["host"],
                    "position": {"model": "orbit", "host_radec": pos["host_radec"], "tier": pos["tier"], "elements": el}, "props": props}
    raise KeyError(rid)


def orbits_fixture():
    recs = [tile_record("nea-exoplanets", "8-34", "nea:TRAPPIST-1 b"), tile_record("bh-curated", "8-26", "bh:Gaia BH1"),
            tile_record("bh-curated", "12-24", "bh:Cyg X-1")]
    return {"generator": "make_phase5_fixtures.py", "note": "records expanded from the committed tiles (quantity arrays -> {v, lo, hi, tier})", "records": recs}


def skybot_fixture():
    url = "https://ssp.imcce.fr/webservices/skybot/api/resolver.php"
    rows = []
    for ep in (2461360, 2461720):
        q = urllib.parse.urlencode({"-name": "Ceres", "-ep": ep, "-mime": "json", "-output": "all", "-observer": "500"})
        with urllib.request.urlopen(f"{url}?{q}", timeout=60) as r:
            rows.append({"requested_ep": ep, "raw": json.loads(r.read().decode())})
    return {"source": url, "params": "-name=Ceres -ep=<jd> -mime=json -output=all -observer=500",
            "fetched": datetime.date.today().isoformat(), "answers": rows}


def dump(name, obj):
    (HERE / name).write_text(json.dumps(obj, indent=1) + "\n")
    print("wrote", name)


if __name__ == "__main__":
    dump("phase5-erfa.json", erfa_fixture())
    dump("phase5-orbits.json", orbits_fixture())
    if "--skybot" in sys.argv:
        dump("phase5-skybot-ceres.json", skybot_fixture())
