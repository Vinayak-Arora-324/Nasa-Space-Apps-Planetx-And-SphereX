"""Build the `bh-curated` object dataset: nine curated black holes and the seven stars that host them.

Inputs, both committed under `backend/data/sources/bh-curated/`:
- `black_holes.json`: hand-curated from the papers, every number with `src` (a key of `papers`) and `where`. It is
  never downloaded; the build refuses any number without both (an assumed value needs `tier: "illustrative"` and an
  `assumed` reason instead).
- `gaia-dr3-companions.csv`: a Gaia DR3 TAP snapshot of the 7 companions (position, parallax, photometry, RUWE).
  `SOURCE.json` records the service, the ADQL, the date, the sha256 and the Gaia licence statement.

Design: docs/object-framework.md sections 17.8 to 17.12.

    uv run python backend/scripts/build_objects_bh.py                # build from the committed inputs
    uv run python backend/scripts/build_objects_bh.py --check        # rebuild in a temp dir, compare, verify
    uv run python backend/scripts/build_objects_bh.py --local DIR    # build from black_holes.json + the CSV in DIR
    uv run python backend/scripts/build_objects_bh.py --refresh      # re-download only the Gaia snapshot, then build

`--refresh` queries the ESA Gaia TAP, then ARI Heidelberg, then GAVO, and checks the Gaia licence page live.
`--check` exits 1 when the committed dataset differs from a fresh build or fails `objects_static.verify_dataset`.

Output: `black_hole` records (Sgr A* and GRS 1915+105 `fixed`; the other seven hosted `orbit` records) and one
`star` record per companion, which carries `prefer_record` (the system's one stored distance, and the stellar
parameters its paper prints: they replace Gaia's single-star ones) and the single-star Gaia parallax as `gaia_parallax`. Nothing is invented: an assumed value is `illustrative` and says so in its src.
"""

from __future__ import annotations

import argparse
import csv
import datetime
import hashlib
import io
import json
import math
import re
import sys
import tempfile
import time
from collections import Counter
from decimal import Decimal, ROUND_HALF_EVEN
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from spherex_app import objects, objects_static  # noqa: E402

DATASET = "bh-curated"
OUT = ROOT / "frontend" / "data" / "objects" / DATASET
SOURCES = ROOT / "backend" / "data" / "sources" / DATASET
SCRIPT = "backend/scripts/build_objects_bh.py"
SCRIPT_VERSION = 1

CURATED = "black_holes.json"
CURATED_FORMAT = "space-maps.bh-curated/1"
SNAPSHOT = "gaia-dr3-companions.csv"
CATALOGUE = "Space Maps curated black holes"
VERSION = "1"

GAIA_COLUMNS = ("source_id", "ra", "dec", "ref_epoch", "parallax", "parallax_error", "pmra", "pmdec",
                "phot_g_mean_mag", "bp_rp", "ruwe")
TAP_SERVICES = (("ESA Gaia archive", "https://gea.esac.esa.int/tap-server/tap/sync"),
                ("ARI Heidelberg", "https://gaia.ari.uni-heidelberg.de/tap/sync"),
                ("GAVO Heidelberg", "https://dc.zah.uni-heidelberg.de/tap/sync"))
GAIA_LICENCE_PAGE = "https://www.cosmos.esa.int/web/gaia-users/license"
GAIA_TERMS_PAGE = "https://www.cosmos.esa.int/web/esdc/terms-and-conditions"
# records sent with every response (the sky tile, docs/object-framework.md 18.7)
SKY_IDS = {"bh:Sgr A*"}
GAIA_CREDIT = "Credit: ESA/Gaia/DPAC"
GAIA_CITE = "Gaia Collaboration 2023, A&A 674, A1 (Gaia DR3)"

RS_KM_PER_MSUN = Decimal("2.953250")      # 2 G Msun / c^2 in km
GM_SUN = 1.32712440018e20                 # m^3 s^-2 (IAU 2015 nominal)
AU_M = 1.495978707e11
SRC_RS = "Schwarzschild radius from the mass (non-rotating)"
SRC_CURATED = "curated"
SRC_SIMBAD = "SIMBAD (simbad.cfa.harvard.edu mirror), queried 2026-11-18"


# --- number helpers --------------------------------------------------------------------------

def D(x) -> Decimal:
    return Decimal(str(x))


def _num(x: Decimal | float | int, sig: int = 12) -> float | int:
    f = float(format(x, f".{sig}g")) if isinstance(x, Decimal) else float(f"{x:.{sig}g}")
    return int(f) if f.is_integer() and abs(f) < 1e15 else f


def rnd(x: Decimal, places: int) -> float | int:
    q = x.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_EVEN)
    return _num(q)


def sig_round(x: Decimal, sig: int) -> float | int:
    return _num(x, sig)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --- reading the curated file ----------------------------------------------------------------

class CuratedError(ValueError):
    pass


def paper_src(papers: dict, key: str | None, where: str | None) -> str:
    """'<cite> (arXiv:<id>), <where>'."""
    if key not in papers:
        raise CuratedError(f"unknown paper key {key!r}")
    p = papers[key]
    s = p["cite"] + (f" (arXiv:{p['arxiv']})" if p.get("arxiv") else "")
    return f"{s}, {where}" if where else s


def paper_cite(papers: dict, key: str) -> str:
    return paper_src(papers, key, None)


def _walk(node, path=""):
    """Every dict that carries a 'v' key (a curated number or text), with its path."""
    if isinstance(node, dict):
        if "v" in node:
            yield path, node
        else:
            for k, v in node.items():
                yield from _walk(v, f"{path}.{k}" if path else k)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _walk(v, f"{path}[{i}]")


def check_curated(cur: dict) -> None:
    """Refuse a curated file in which any number lacks its source (see the module docstring)."""
    if cur.get("format") != CURATED_FORMAT:
        raise CuratedError(f"format must be {CURATED_FORMAT!r}")
    papers = cur.get("papers") or {}
    problems = []
    for path, q in _walk(cur.get("systems")):
        assumed = q.get("assumed")
        if q.get("tier") == "illustrative" or assumed is not None:
            if q.get("tier") != "illustrative" or not (isinstance(assumed, str) and assumed.strip()):
                problems.append(f"{path}: an assumed value needs tier 'illustrative' and an 'assumed' reason")
            if q.get("src") is not None and (q["src"] not in papers or not q.get("where")):
                problems.append(f"{path}: an assumed value that cites a paper needs a known src and a 'where'")
            continue
        if q.get("src") not in papers:
            problems.append(f"{path}: src {q.get('src')!r} is missing or not a key of papers")
        if not (isinstance(q.get("where"), str) and q["where"].strip()):
            problems.append(f"{path}: where is missing")
    for sysd in cur.get("systems", []):
        for k in ("state_src",):
            if sysd["bh"].get(k) is not None and sysd["bh"][k] not in papers:
                problems.append(f"{sysd['bh']['id']}.{k}: unknown paper key")
        c = sysd.get("companion")
        if c and c.get("name_src") not in papers:
            problems.append(f"{sysd['bh']['id']}: companion name_src is not a key of papers")
        if c and isinstance(c.get("identity_src"), dict) and c["identity_src"].get("src") not in papers:
            problems.append(f"{sysd['bh']['id']}: identity_src is not a key of papers")
    if problems:
        raise CuratedError("curated file refused:\n  " + "\n  ".join(problems))


def quantity_from(papers: dict, q: dict, *, unit: str | None = None, tier: str = "measured",
                  scale: Decimal | None = None, places: int | None = None) -> dict:
    """A record Quantity from a curated number: `err` becomes lo and hi; the src is '<cite> (arXiv), <where>'.
    An assumed value's src is its `assumed` text (plus the paper and where, if it cites one)."""
    v = D(q["v"])
    lo, hi = (D(q["lo"]), D(q["hi"])) if "lo" in q else ((v - D(q["err"]), v + D(q["err"])) if "err" in q else (None, None))
    if scale is not None:
        v, lo, hi = v * scale, None if lo is None else lo * scale, None if hi is None else hi * scale
    f = (lambda x: rnd(x, places)) if places is not None else _num
    if q.get("assumed") is not None:
        src = q["assumed"] if q.get("src") is None else f"{q['assumed']} ({paper_src(papers, q['src'], q['where'])})"
        tier = "illustrative"
    else:
        src = paper_src(papers, q["src"], q["where"])
        tier = q.get("tier", tier)
    return objects.quantity(f(v), src, tier, unit or q.get("unit"), None if lo is None else f(lo),
                            None if hi is None else f(hi))


def text_quantity(papers: dict, q: dict, tier: str = "catalogue") -> dict:
    return objects.quantity(q["v"], paper_src(papers, q["src"], q["where"]), tier)


def sexagesimal_deg(s: str, hours: bool) -> Decimal:
    m = re.fullmatch(r"\s*([+-]?)(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s*", s)
    if not m:
        raise CuratedError(f"cannot read the sexagesimal coordinate {s!r}")
    sign = -1 if m.group(1) == "-" else 1
    x = D(m.group(2)) + D(m.group(3)) / 60 + D(m.group(4)) / 3600
    return sign * x * (15 if hours else 1)


def jd_to_mjd(x: Decimal) -> Decimal:
    return x - D("2400000.5")


# --- the Gaia snapshot -----------------------------------------------------------------------

def read_snapshot(data: bytes) -> dict[str, dict]:
    rows = list(csv.DictReader(io.StringIO(data.decode("utf-8"), newline="")))
    if not rows or list(rows[0].keys()) != list(GAIA_COLUMNS):
        raise SystemExit("the Gaia snapshot does not have the expected columns")
    return {r["source_id"]: r for r in rows}


def adql(ids: list[str]) -> str:
    return (f"SELECT {', '.join(GAIA_COLUMNS)} FROM gaiadr3.gaia_source "
            f"WHERE source_id IN ({','.join(sorted(ids))}) ORDER BY source_id")


def canonical_csv(rows: list[dict]) -> bytes:
    buf = io.StringIO(newline="")
    w = csv.DictWriter(buf, fieldnames=list(GAIA_COLUMNS), lineterminator="\n", extrasaction="ignore")
    w.writeheader()
    w.writerows(sorted(rows, key=lambda r: int(r["source_id"])))
    return buf.getvalue().encode("utf-8")


# --- records ---------------------------------------------------------------------------------

def provenance() -> dict:
    return {"source": f"static:{DATASET}", "dataset": DATASET, "catalogue": CATALOGUE, "version": VERSION}


def radec_of(row: dict) -> tuple[float, float]:
    return rnd(D(row["ra"]) % 360, 7), rnd(D(row["dec"]), 7)


def schwarzschild(papers: dict, mass_q: dict) -> dict:
    m = D(mass_q["v"])
    lo, hi = (D(mass_q["lo"]), D(mass_q["hi"])) if "lo" in mass_q else (m - D(mass_q["err"]), m + D(mass_q["err"]))
    f = lambda x: sig_round(x * RS_KM_PER_MSUN, 4)  # noqa: E731
    return objects.quantity(f(m), SRC_RS, "inferred", "km", f(lo), f(hi))


def companion_distance(papers: dict, c: dict, snap_row: dict) -> tuple[dict, str]:
    """(the record's `dist` Quantity in pc, a note) from the companion's curated distance."""
    d = c["dist"]
    if d.get("parallax_from_snapshot"):
        plx, err = D(snap_row["parallax"]), D(snap_row["parallax_error"])
        src = f"Gaia DR3 parallax (single-star solution), inverted; {d['src_note']}"
        return objects.quantity(rnd(1000 / plx, 2), src, "measured", "pc", rnd(1000 / (plx + err), 2),
                                rnd(1000 / (plx - err), 2)), "parallax"
    if "parallax_mas" in d:
        q = d["parallax_mas"]
        plx, err = D(q["v"]), D(q["err"])
        src = paper_src(papers, q["src"], f"{q['where']}: {q['v']} ± {q['err']} mas, inverted")
        return objects.quantity(rnd(1000 / plx, 2), src, "measured", "pc", rnd(1000 / (plx + err), 2),
                                rnd(1000 / (plx - err), 2)), "parallax"
    if "dist_kpc" in d:
        return quantity_from(papers, d["dist_kpc"], unit="pc", scale=Decimal(1000)), "parallax"
    if "dist_pc" in d:
        return quantity_from(papers, d["dist_pc"], unit="pc"), "parallax"
    raise CuratedError("companion has no distance")


def kepler_a_au(period_d: Decimal, m_total: Decimal) -> Decimal:
    p = float(period_d) * 86400.0
    return D((GM_SUN * float(m_total) * p * p / (4 * math.pi ** 2)) ** (1 / 3) / AU_M)


def wrap(x: Decimal) -> Decimal:
    return x % 360


def hosted_orbit(papers: dict, bh: dict, comp: dict, snap: dict) -> tuple[dict, str]:
    """The `orbit` position of a hosted black hole (section 17.8)."""
    pos = bh["position"]
    el = pos["elements"]
    row = snap[comp["gaia_dr3"]]
    host_radec = list(radec_of(row))
    if pos["convention"] == "luminous-star":
        node = el["node_deg"]
        ev = D(node["v"])
        err = D(node["err"])
        nq = objects.quantity(
            rnd(wrap(ev + 180), 4), paper_src(papers, node["src"], node["where"])
            + f"; black hole relative to its star: node = Ω ({node['v']} ± {node['err']}) + 180°", "measured", "deg",
            rnd(wrap(ev - err + 180), 4), rnd(wrap(ev + err + 180), 4))
        tp = el["t_peri_jd"]
        tpv, tpe = jd_to_mjd(D(tp["v"])), D(tp["err"])
        tpq = objects.quantity(rnd(tpv, 4), paper_src(papers, tp["src"], tp["where"]) + "; MJD = JD - 2400000.5 (TCB)",
                               "measured", None, rnd(tpv - tpe, 4), rnd(tpv + tpe, 4))
        if "a_au" in el:
            aq = quantity_from(papers, el["a_au"], unit="au")
            a_note = ""
            tier, evidence = "measured", "measured"
        else:  # BH3: a1 is the luminous star's orbit about the barycentre
            a1 = el["a1_au"]
            m_bh, m_st = D(bh["mass"]["v"]), D(comp["mass"]["v"])
            mbl, mbh = D(bh["mass"].get("lo", m_bh - D(bh["mass"].get("err", 0)))), D(bh["mass"].get("hi", m_bh + D(bh["mass"].get("err", 0))))
            msl, msh = D(comp["mass"].get("lo", m_st - D(comp["mass"].get("err", 0)))), D(comp["mass"].get("hi", m_st + D(comp["mass"].get("err", 0))))
            a1v, a1e = D(a1["v"]), D(a1["err"])
            av = a1v * (m_bh + m_st) / m_bh
            alo = (a1v - a1e) * (1 + msl / mbh)
            ahi = (a1v + a1e) * (1 + msh / mbl)
            src = (f"{paper_src(papers, a1['src'], a1['where'])}: a1 = {a1['v']} ± {a1['err']} au (the luminous star's "
                   f"orbit about the barycentre); relative orbit a = a1 (M_BH + M*) / M_BH with M_BH = {bh['mass']['v']} Msun "
                   f"and M* = {comp['mass']['v']} Msun, inferred; interval from the extremes of the inputs' intervals")
            aq = objects.quantity(rnd(av, 3), src, "inferred", "au", rnd(alo, 3), rnd(ahi, 3))
            a_note = "; a = a1 (M_BH + M*) / M_BH (inferred)"
            tier, evidence = "inferred", "derived"
        elements = {"period_d": quantity_from(papers, el["period_d"], unit="d"), "a_au": aq,
                    "e": quantity_from(papers, el["e"]), "i_deg": quantity_from(papers, el["i_deg"], unit="deg"),
                    "node_deg": nq, "omega_deg": quantity_from(papers, el["omega_deg"], unit="deg"),
                    "t_peri_mjd": tpq, "t_conj_mjd": None}
        src = (paper_src(papers, el["period_d"]["src"], el["period_d"]["where"])
               + "; black hole relative to its luminous star: node = Ω + 180°, same ω, i, e, P and T_p "
               "(the section 16.6 sky-plane formula, Z toward the observer, reproduces the star's Gaia Thiele-Innes "
               "offsets with the sign reversed)" + a_note)
        if bh.get("solution_note"):
            src += f". {bh['solution_note']}"
        return {"model": "orbit", "host_radec": host_radec, "phase_known": bool(pos["phase_known"]), "tier": tier,
                "src": src, "elements": elements}, evidence
    # X-ray binary: the orientation is not measured, so the placement is illustrative
    m_bh = D(bh["mass"]["v"])
    mlo = D(bh["mass"].get("lo", m_bh - D(bh["mass"].get("err", 0))))
    mhi = D(bh["mass"].get("hi", m_bh + D(bh["mass"].get("err", 0))))
    if "companion_mass" in bh:
        cm = bh["companion_mass"]
        c = D(cm["v"])
        clo = D(cm.get("lo", c - D(cm.get("err", 0))))
        chi = D(cm.get("hi", c + D(cm.get("err", 0))))
        how = f"companion mass {cm['v']} Msun ({paper_src(papers, cm['src'], cm['where'])})"
    else:
        q = bh["mass_ratio"]
        qv = D(q["v"])
        c, clo, chi = qv * m_bh, qv * mlo, qv * mhi
        how = (f"companion mass = q M_BH with q = {q['v']} ({paper_src(papers, q['src'], q['where'])}), inferred")
    pe = el["period_d"]
    pv = D(pe["v"])
    av = kepler_a_au(pv, m_bh + c)
    alo, ahi = kepler_a_au(pv, mlo + clo), kepler_a_au(pv, mhi + chi)
    asrc = (f"Kepler's third law from P = {pe['v']} d ({paper_src(papers, pe['src'], pe['where'])}) and the summed "
            f"masses: M_BH {bh['mass']['v']} Msun ({paper_src(papers, bh['mass']['src'], bh['mass']['where'])}) + {how}; "
            "inferred; interval from the mass intervals")
    elements = {"period_d": quantity_from(papers, pe, unit="d"),
                "a_au": objects.quantity(sig_round(av, 5), asrc, "inferred", "au", sig_round(alo, 5), sig_round(ahi, 5)),
                "e": quantity_from(papers, el["e"]), "i_deg": quantity_from(papers, el["i_deg"], unit="deg"),
                "node_deg": None, "omega_deg": None, "t_peri_mjd": None, "t_conj_mjd": None}
    src = f"Illustrative placement: {pos['node_note']} The period, inclination and eccentricity are as cited per element."
    return {"model": "orbit", "host_radec": host_radec, "phase_known": False, "tier": "illustrative",
            "src": src, "elements": elements}, "illustrative"


def bh_props(papers: dict, bh: dict, comp: dict | None) -> dict:
    props = {"mass": quantity_from(papers, bh["mass"], unit="Msun")}
    if "companion_mass" in bh:
        props["companion_mass"] = quantity_from(papers, bh["companion_mass"], unit="Msun")
    elif comp and "mass" in comp:
        props["companion_mass"] = quantity_from(papers, comp["mass"], unit="Msun", tier="catalogue")
    props["type"] = objects.quantity(bh["type"], SRC_CURATED, "catalogue")
    state_src = paper_cite(papers, bh["state_src"]) if bh.get("state_src") else SRC_CURATED
    props["state"] = objects.quantity(bh["state"], state_src, "catalogue")
    if comp:
        props["companion"] = objects.quantity(comp["name"], SRC_CURATED, "catalogue")
    return props


def black_hole_record(papers: dict, system: dict, snap: dict, prov: dict) -> dict:
    bh, comp = system["bh"], system["companion"]
    pos = bh["position"]
    host = parent = None
    if pos["model"] == "fixed":
        ra = rnd(sexagesimal_deg(pos["ra_hms"]["v"], True) % 360, 7)
        dec = rnd(sexagesimal_deg(pos["dec_dms"]["v"], False), 7)
        position = {"model": "fixed", "ra": ra, "dec": dec, "epoch": pos["epoch"], "method": pos["method"],
                    "dist": quantity_from(papers, pos["dist"], unit="pc",
                                          scale=Decimal(1000) if pos["dist"]["unit"] == "kpc" else None)}
        evidence = "measured"
    else:
        if comp is None:
            raise CuratedError(f"{bh['id']}: a hosted black hole needs a companion")
        position, evidence = hosted_orbit(papers, bh, comp, snap)
        host = parent = f"gdr3:{comp['gaia_dr3']}"
    if bh.get("parent"):        # a free-standing black hole may name its parent (Sgr A*: gal:milky_way, 18.8.3)
        parent = bh["parent"]
    props = bh_props(papers, bh, comp)
    if pos["model"] == "fixed":
        rq, dq = pos["ra_hms"], pos["dec_dms"]
        props["coordinates"] = objects.quantity(
            f"{rq['v']} {dq['v']} (J2000)", paper_src(papers, rq["src"], rq["where"]), "measured")
    size = {"radius": schwarzschild(papers, bh["mass"]), "angular": None}
    return objects.record(id=bh["id"], kind="black_hole", name=bh["name"], designations=bh["designations"],
                          host=host, parent=parent, position=position, size=size, props=props,
                          provenance=prov, evidence=evidence, render={"style": "lensing"})


def companion_record(papers: dict, system: dict, snap: dict, prov: dict) -> dict:
    c = system["companion"]
    row = snap[c["gaia_dr3"]]
    ra, dec = radec_of(row)
    dist, method = companion_distance(papers, c, row)
    desig = [f"Gaia DR3 {c['gaia_dr3']}"]
    desig += [d for d in c["designations"] if d not in desig]
    plx, err = D(row["parallax"]), D(row["parallax_error"])
    ruwe = D(row["ruwe"])
    gmag = rnd(D(row["phot_g_mean_mag"]), 3)
    ident_src = f"{paper_cite(papers, c['name_src'])}; SIMBAD main identifier of this Gaia DR3 source: {c['simbad_main_id']}"
    if c["name_src"] != "simbad_cfa":
        ident_src += f" ({SRC_SIMBAD})"
    if isinstance(c.get("identity_src"), dict):
        ident_src += f"; identity: {paper_src(papers, c['identity_src']['src'], c['identity_src']['where'])}"
    props: dict = {}
    for key in ("teff", "mass"):
        if key in c:
            props[key] = quantity_from(papers, c[key], tier="catalogue")
    props["gmag"] = objects.quantity(gmag, "Gaia DR3", "measured", "mag")
    props["gaia_parallax"] = objects.quantity(
        rnd(plx, 4), f"Gaia DR3 single-star solution (RUWE {rnd(ruwe, 2):.2f})", "measured", "mas",
        rnd(plx - err, 4), rnd(plx + err, 4))
    props["description"] = text_quantity(papers, c["description"])
    props["identity"] = objects.quantity(f"SIMBAD: {c['simbad_main_id']}", ident_src, "catalogue")
    size = None
    if "radius" in c:
        size = {"radius": quantity_from(papers, c["radius"], tier="catalogue"), "angular": None}
    position = {"model": "fixed", "ra": ra, "dec": dec, "epoch": float(row["ref_epoch"]), "method": method,
                "dist": dist}
    return objects.record(
        id=f"gdr3:{c['gaia_dr3']}", kind="star", name=c["name"], designations=desig, position=position, size=size,
        props=props, provenance=prov, evidence="measured", render={"mag": gmag}) | {
        "same_as": [], "prefer_record": {"replace": prefer_fields(c), "reason": c["prefer_reason"]}}


def prefer_fields(c: dict) -> list[str]:
    """What the companion's prefer_record replaces: the distance, and each stellar parameter the paper prints (and
    the curated file therefore carries). A parameter the paper does not print keeps Gaia's single-star value."""
    return [f for f in objects.PREFER_RECORD_FIELDS if f == "dist" or f in c]


def build_records(cur: dict, snap: dict) -> tuple[list[dict], dict]:
    check_curated(cur)
    papers, prov = cur["papers"], provenance()
    records = []
    for system in cur["systems"]:
        c = system["companion"]
        if c and c["gaia_dr3"] not in snap:
            raise CuratedError(f"{c['gaia_dr3']} is not in the Gaia snapshot")
        records.append(black_hole_record(papers, system, snap, prov))
        if c:
            records.append(companion_record(papers, system, snap, prov))
    pairs = sorted({(p[0], p[1]) for p in _src_where(cur)})
    by = lambda f: dict(sorted(Counter(f(r) for r in records).items()))  # noqa: E731
    report = {
        "records_written": len(records),
        "by_kind": by(lambda r: r["kind"]),
        "by_kind_and_evidence": by(lambda r: f"{r['kind']}/{r['evidence']}"),
        "by_position_model": by(lambda r: r["position"]["model"]),
        "curated_numbers": sum(1 for _ in _walk(cur["systems"])),
        "gaia_snapshot_rows": len(snap),
        "src_where_pairs": [{"paper": k, "where": w} for k, w in pairs],
    }
    return records, report


def _src_where(cur: dict):
    for _, q in _walk(cur["systems"]):
        if q.get("src") in cur["papers"]:
            yield q["src"], q.get("where")


# --- inputs, manifest and writing ------------------------------------------------------------

def load_inputs(directory: Path) -> dict:
    cur_bytes = (directory / CURATED).read_bytes()
    csv_bytes = (directory / SNAPSHOT).read_bytes()
    return {"cur_bytes": cur_bytes, "csv_bytes": csv_bytes, "cur": json.loads(cur_bytes),
            "snap": read_snapshot(csv_bytes)}


def provenance_full(cur: dict, meta: dict, inp: dict, *, local: bool) -> dict:
    f = meta["files"][0]
    papers = "; ".join(
        f"{p['cite']}" + (f", arXiv:{p['arxiv']}" if p.get("arxiv") else "") + (f", doi:{p['doi']}" if p.get("doi") else "")
        for k, p in cur["papers"].items() if k != "simbad_cfa")
    citation = (f"Curated by hand from: {papers}. Names cross-checked in {cur['papers']['simbad_cfa']['cite']}. "
                f"Gaia DR3 companion positions, parallaxes and photometry: {GAIA_CITE}, {GAIA_CREDIT}.")
    return {"catalogue": CATALOGUE, "version": VERSION if not local else f"{VERSION}, local files",
            "citation": citation, "papers": {k: v for k, v in cur["papers"].items()},
            "curated_file": CURATED, "curated_sha256": sha256(inp["cur_bytes"]), "curated_date": cur.get("curated"),
            "gaia_snapshot_file": SNAPSHOT, "gaia_snapshot_sha256": sha256(inp["csv_bytes"]),
            "gaia_service": None if local else f.get("service"), "gaia_retrieved": None if local else f.get("retrieved"),
            "gaia_licence": f.get("licence_name"), "gaia_licence_url": f.get("licence_url"),
            "gaia_terms_url": f.get("terms_url"), "gaia_credit_line": f.get("credit_line"),
            "licence": f.get("licence_url"),
            # the Gaia terms require this credit wherever the values are shown, so the app's credits line lists it
            "credit": GAIA_CREDIT, "licence_name": f"{GAIA_LICENCE_NAME} (Gaia DR3 values)"}


GAIA_LICENCE_NAME = "CC BY-NC 3.0 IGO"
LICENSE_MD = """# Licence and credits: bh-curated data

Applies to every file in this folder.

- **Gaia DR3 values** (the companion stars' positions, parallaxes, G magnitudes and RUWE, from
  `backend/data/sources/bh-curated/gaia-dr3-companions.csv`) are ESA Gaia data, distributed under the
  **CC BY-NC 3.0 IGO** licence (https://creativecommons.org/licenses/by-nc/3.0/igo/). Credit: ESA/Gaia/DPAC.
  The ESA terms ask for authorisation (data.licences@esa.int) before commercial use.
- **Everything else** (masses, distances, orbits and names) is curated by hand from the published papers
  cited in `manifest.json` (`provenance.papers`) and in each value's `src`, as facts with their citations.

The build code is under the MIT licence (see the repository `LICENSE`).
"""


def build(out_dir: Path, sources: Path = SOURCES, local: Path | None = None) -> dict:
    meta = json.loads((sources / "SOURCE.json").read_text(encoding="utf-8"))
    inp = load_inputs(local or sources)
    if local is None:
        f = meta["files"][0]
        if sha256(inp["csv_bytes"]) != f["sha256"]:
            raise SystemExit(f"{SNAPSHOT}: sha256 differs from SOURCE.json")
    records, report = build_records(inp["cur"], inp["snap"])
    m = objects_static.write_dataset(
        records, out_dir, dataset=DATASET, kinds=["black_hole", "star"],
        provenance=provenance_full(inp["cur"], meta, inp, local=local is not None),
        build={"script": SCRIPT, "script_version": SCRIPT_VERSION, "report": report},
        band_deg=10, precedence=50, src_table=True, record_defaults={"provenance": provenance()},
        sky_ids=SKY_IDS, compact=True)
    (Path(out_dir) / "LICENSE.md").write_text(LICENSE_MD, encoding="utf-8")
    return m


# --- refreshing the Gaia snapshot ------------------------------------------------------------

def _tap(url: str, query: str) -> bytes:
    import httpx
    last: Exception | None = None
    for attempt in range(3):
        try:
            r = httpx.post(url, data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query},
                           timeout=120.0, follow_redirects=True)
            r.raise_for_status()
            return r.content
        except httpx.HTTPError as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


def _licence_statement() -> tuple[str, str]:
    """(the licence sentence, the Gaia credit line) read live from the ESA pages."""
    import httpx

    def text(url):
        t = httpx.get(url, timeout=60.0, follow_redirects=True).raise_for_status().text
        t = re.sub(r"<script.*?</script>|<style.*?</style>", "", t, flags=re.S)
        import html
        return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", t)))
    lic = re.search(r"Gaia data are distributed under the .{0,60}?license\.", text(GAIA_LICENCE_PAGE))
    if not lic:
        raise SystemExit("could not read the Gaia licence statement; check it by hand before refreshing")
    credit = re.search(r"Gaia All (Credit: ESA, Gaia DPAC)", text(GAIA_TERMS_PAGE))
    if not credit:
        raise SystemExit("could not read the Gaia credit line; check it by hand before refreshing")
    # the page words it "Credit: ESA, Gaia DPAC"; Space Maps shows the form the design fixes (18.12)
    return lic.group(0), GAIA_CREDIT


def refresh(directory: Path) -> None:
    """Re-download the Gaia snapshot and rewrite it and SOURCE.json. black_holes.json is never touched."""
    cur = json.loads((directory / CURATED).read_text(encoding="utf-8"))
    ids = sorted(s["companion"]["gaia_dr3"] for s in cur["systems"] if s["companion"])
    query = adql(ids)
    errors = []
    for service, url in TAP_SERVICES:
        try:
            rows = list(csv.DictReader(io.StringIO(_tap(url, query).decode("utf-8"), newline="")))
            if sorted(r["source_id"] for r in rows) != ids or list(rows[0].keys()) != list(GAIA_COLUMNS):
                raise RuntimeError(f"expected the {len(ids)} sources and columns, got {len(rows)} rows")
            break
        except (RuntimeError, KeyError, IndexError, UnicodeDecodeError) as e:
            errors.append(f"{service}: {e}")
    else:
        raise SystemExit("no Gaia TAP service answered:\n  " + "\n  ".join(errors))
    lic, credit = _licence_statement()
    data = canonical_csv(rows)
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    (directory / SNAPSHOT).write_bytes(data)
    meta = {"dataset": DATASET,
            "note": "Pinned Gaia input of backend/scripts/build_objects_bh.py. Regenerate with --refresh (it never touches "
                    "black_holes.json, which is hand-curated). `sha256` is of the committed CSV bytes (columns as queried, "
                    "rows sorted by source_id, Unix line endings).",
            "files": [{"file": SNAPSHOT, "role": "gaia-dr3-companions", "sha256": sha256(data), "rows": len(rows),
                       "columns": list(GAIA_COLUMNS), "service": service, "tap_url": url, "adql": query,
                       "retrieved": today, "table": "gaiadr3.gaia_source", "citation": GAIA_CITE,
                       "licence_name": "CC BY-NC 3.0 IGO", "licence_statement": lic, "licence_url": GAIA_LICENCE_PAGE,
                       "terms_url": GAIA_TERMS_PAGE, "credit_line": credit, "licence_checked": today}]}
    (directory / "SOURCE.json").write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")


# --- command line ----------------------------------------------------------------------------

def _files(d: Path) -> dict[str, bytes]:
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--sources", type=Path, default=SOURCES, help="directory of the committed inputs")
    ap.add_argument("--local", type=Path, help="a directory with black_holes.json and gaia-dr3-companions.csv")
    ap.add_argument("--refresh", action="store_true", help="re-download the Gaia snapshot only (network), then build")
    ap.add_argument("--check", action="store_true",
                    help="rebuild into a temp dir, compare with --out and verify it; exit 1 on any difference")
    a = ap.parse_args()
    if a.refresh:
        refresh(a.sources)
        print(f"Gaia snapshot written to {a.sources}")
    if a.check:
        with tempfile.TemporaryDirectory() as tmp:
            build(Path(tmp), a.sources, a.local)
            fresh, have = _files(Path(tmp)), (_files(a.out) if a.out.is_dir() else {})
        diff = sorted(k for k in fresh.keys() | have.keys() if fresh.get(k) != have.get(k))
        problems = objects_static.verify_dataset(a.out) if a.out.is_dir() else ["output directory missing"]
        if diff:
            print(f"{a.out} differs from a fresh build: {', '.join(diff[:10])}{' ...' if len(diff) > 10 else ''}",
                  file=sys.stderr)
        for p in problems[:20]:
            print(f"verify: {p}", file=sys.stderr)
        if diff or problems:
            return 1
        print(f"{a.out} is up to date ({len(fresh)} files, verified)")
        return 0
    m = build(a.out, a.sources, a.local)
    r = m["build"]["report"]
    print(f"wrote {m['count']} records ({r['by_kind_and_evidence']}) to {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
