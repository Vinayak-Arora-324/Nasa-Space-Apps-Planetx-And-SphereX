"""Build the `galaxies` object dataset: OpenNGC galaxies merged with the UNGC Local Volume catalogue, with distances
from Cosmicflows-4, McConnachie 2012 (Local Group), UNGC, two curated Magellanic Cloud distances, the Hubble flow and
the CF4 distances of four rich clusters, plus the curated Milky Way record.

Design: docs/object-framework.md section 18 (18.2 inputs and licences, 18.3 merge, 18.4 distances, 18.7 the Milky
Way, 18.11 the context set and the size budget, 18.18 decisions at approval).

Inputs, committed under `backend/data/sources/galaxies/` (see SOURCE.json):
- OpenNGC `NGC.csv` and `addendum.csv` at commit 36cb178a (release v20260501), CC BY-SA 4.0 (Mattia Verga), as copies
  of the nebula build's inputs;
- UNGC (Karachentsev et al. 2013, VizieR J/AJ/145/101/catalog), Cosmicflows-4 (Tully et al. 2023, VizieR
  J/ApJ/944/94/table2 and /groups) and McConnachie 2012 (VizieR J/AJ/144/4/catalog), gzipped VizieR TSV without `#` lines;
- hand-written, committed files (not downloaded, sha256 in the build report): `ungc_ongc_overrides.json`,
  `galaxy_names.json`, `milky_way.json`, `local_group_curated.json`, `clusters.json`; and, read-only from other
  folders, `bh-curated/black_holes.json` (Sgr A*) and `smbh-curated/smbh.json` (the black holes' host galaxies).

    uv run python backend/scripts/build_objects_galaxies.py                # build from the committed snapshots
    uv run python backend/scripts/build_objects_galaxies.py --check        # rebuild in a temp dir, compare, verify
    uv run python backend/scripts/build_objects_galaxies.py --local DIR    # build from raw downloads in DIR
    uv run python backend/scripts/build_objects_galaxies.py --refresh      # download, check the pins, rewrite snapshots
"""

from __future__ import annotations

import argparse
import datetime
import gzip
import json
import math
import re
import sys
import tempfile
from collections import Counter
from decimal import ROUND_HALF_EVEN, Decimal
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from spherex_app import objects, objects_static  # noqa: E402
import build_objects_bh as bhb  # noqa: E402  (Sgr A*'s conversion, so the position exists once)
import build_objects_nebulae as neb  # noqa: E402  (OpenNGC and VizieR parsing, licence text pieces)

DATASET = "galaxies"
OUT = ROOT / "frontend" / "data" / "objects" / DATASET
SOURCES = ROOT / "backend" / "data" / "sources" / DATASET
BH_FILE = ROOT / "backend" / "data" / "sources" / "bh-curated" / "black_holes.json"
SMBH_FILE = ROOT / "backend" / "data" / "sources" / "smbh-curated" / "smbh.json"
SCRIPT = "backend/scripts/build_objects_galaxies.py"
SCRIPT_VERSION = 1

OPENNGC_SHA, OPENNGC_TAG, OPENNGC_URL = neb.OPENNGC_SHA, neb.OPENNGC_TAG, neb.OPENNGC_URL
VIZIER_MIRRORS = neb.VIZIER_MIRRORS
VERSION = f"OpenNGC {OPENNGC_TAG} ({OPENNGC_SHA[:8]})"
SRC_ONGC = f"OpenNGC {OPENNGC_TAG}"
CATALOGUE = ("OpenNGC + UNGC (J/AJ/145/101) + Cosmicflows-4 (J/ApJ/944/94) + McConnachie 2012 (J/AJ/144/4)")
SRC_UNGC = "UNGC (Karachentsev et al. 2013, J/AJ/145/101)"
# The design budget was 7 MB (about 600 B a record); the record format needs about 1 KB a record (every number is a
# Quantity object), so the built dataset is about 12.5 MB uncompressed. See the build report and docs 18.11.
BUDGET_BYTES = 13_000_000
MAX_DESIGNATIONS = 8

OVERRIDES_FILE = "ungc_ongc_overrides.json"
NAMES_FILE = "galaxy_names.json"
MW_FILE = "milky_way.json"
LG_FILE = "local_group_curated.json"
CLUSTERS_FILE = "clusters.json"
CURATED_FILES = (OVERRIDES_FILE, NAMES_FILE, MW_FILE, LG_FILE, CLUSTERS_FILE)

# --- pins ------------------------------------------------------------------------------------

INPUTS = {
    "openngc": dict(neb.INPUTS["openngc"]),
    "openngc-addendum": dict(neb.INPUTS["openngc-addendum"]),
    "ungc": {"file": "ungc-catalog.tsv.gz", "vizier": "J/AJ/145/101", "table": "J/AJ/145/101/catalog",
             "local": "ungc-catalog.tsv", "columns": None, "sha256": "877b0d658b6e4c49bc53fdf650be668011010d6fa87dc490ec00aee7946eda9d", "rows": 869},
    "cf4-table2": {"file": "cf4-table2.tsv.gz", "vizier": "J/ApJ/944/94", "table": "J/ApJ/944/94/table2",
                   "local": "cf4-table2.tsv", "sha256": "d82aa6186bf8517404e5f3f45d028d22ce9e5d3ae1f6496a9d5b7302c70261d7", "rows": 55877,
                   "columns": ("PGC", "Vcmb", "DM", "e_DM", "DMsnIa", "e_DMsnIa", "DMtf", "e_DMtf", "DMfp", "e_DMfp",
                               "DMsbf", "e_DMsbf", "DMsnII", "e_DMsnII", "DMtrgb", "e_DMtrgb", "DMceph", "e_DMceph",
                               "DMmas", "e_DMmas", "RAJ2000", "DEJ2000")},
    "cf4-groups": {"file": "cf4-groups.tsv.gz", "vizier": "J/ApJ/944/94", "table": "J/ApJ/944/94/groups",
                   "local": "cf4-groups.tsv", "sha256": "37d617fbf0d743c461a86b8c51efd433a3f6a9976535bb8d49047c54017a4d36", "rows": 38053,
                   "columns": ("1PGC", "Ngal", "DMzp", "e_DMzp", "Vh", "V3k")},
    "mcconnachie": {"file": "mcconnachie2012.tsv.gz", "vizier": "J/AJ/144/4", "table": "J/AJ/144/4/catalog",
                    "local": "mcconnachie2012.tsv", "columns": None, "sha256": "730b90243de3389b49c1f6742db692150952bb8914267603ed71db081033a4ed", "rows": 102},
}
ONGC_ROLES = neb.ONGC_ROLES
VIZIER_ROLES = ("ungc", "cf4-table2", "cf4-groups", "mcconnachie")

# --- licence and credit ----------------------------------------------------------------------

CREDIT = neb.CREDIT
LICENCE_NAME = neb.LICENCE_NAME
LICENCE_URL = neb.LICENCE_URL
VIZIER_TERMS = neb.VIZIER_TERMS
EDD_TERMS = "https://edd.ifa.hawaii.edu/"
# the 3D view's credits line shows `credit · licence_name`: name Cosmicflows-4 (EDD asks to be cited) and keep each licence with its source
MANIFEST_CREDIT = CREDIT + "; distances: Cosmicflows-4 (Tully et al. 2023), Extragalactic Distance Database"
MANIFEST_LICENCE_NAME = LICENCE_NAME + " (OpenNGC data); Cosmicflows-4 distances under EDD terms"
CITATIONS = {
    "ungc": ("Karachentsev I. D., Makarov D. I., Kaisina E. I., 2013, AJ 145, 101: Updated Nearby Galaxy Catalog "
             "(arXiv:1303.5328), doi:10.26093/cds/vizier.51450101, VizieR J/AJ/145/101"),
    "cf4": ("Tully R. B., Courtois H. M., Sorce J. G., 2023, ApJ 944, 94: Cosmicflows-4 (arXiv:2209.11238), "
            "VizieR J/ApJ/944/94; Extragalactic Distance Database: Tully R. B. et al., 2009, AJ 138, 323"),
    "mcconnachie": ("McConnachie A. W., 2012, AJ 144, 4: The Observed Properties of Dwarf Galaxies in and around the "
                    "Local Group (arXiv:1204.1562), VizieR J/AJ/144/4"),
}
CITATION_OF = {"ungc": "ungc", "cf4-table2": "cf4", "cf4-groups": "cf4", "mcconnachie": "mcconnachie"}

# --- physics and rules -----------------------------------------------------------------------

C_KMS = 299792.458
H0 = 74.6
Q0 = -0.595
SIGMA_V = 300.0
V_MIN = 1000.0
DIPOLE = 369.82
DIPOLE_L, DIPOLE_B = 264.021, 48.253
NGP_RA, NGP_DEC, L_NCP = 192.85948, 27.12825, 122.93192   # Hipparcos eq. 1.5.9; l of the ICRS pole = 90 + l_node
CONTEXT_DIST_PC = 3.0e6
CONTEXT_MAG_B = 10.0
MCC_MATCH_ARCMIN = 3.0
CF4_MATCH_ARCMIN = 0.5

GAL_TYPES = ("G", "GPair", "GTrpl", "GGroup")
TYPE_LABEL = {"G": "Galaxy", "GPair": "Galaxy pair", "GTrpl": "Galaxy triplet", "GGroup": "Group of galaxies"}

# method -> (tier, evidence class: 0 measured, 1 derived)
MEASURED = ("maser", "cepheid", "trgb", "sbf", "horizontal-branch", "rr-lyrae", "cmd", "eclipsing-binary",
            "resolved-stars")
METHOD_ORDER = ("maser", "cepheid", "trgb", "sbf", "horizontal-branch", "rr-lyrae", "cmd", "resolved-stars",
                "eclipsing-binary", "sn-ia", "tully-fisher", "fundamental-plane", "sn-ii", "supernova",
                "brightest-stars", "pnlf", "group-member", "redshift")
CF4_COLUMNS = (("DMmas", "maser"), ("DMceph", "cepheid"), ("DMtrgb", "trgb"), ("DMsbf", "sbf"),
               ("DMsnIa", "sn-ia"), ("DMtf", "tully-fisher"), ("DMfp", "fundamental-plane"), ("DMsnII", "sn-ii"))
UNGC_METHODS = {"TRGB": "trgb", "Cep": "cepheid", "SBF": "sbf", "HB": "horizontal-branch", "RR": "rr-lyrae",
                "CMD": "cmd", "SN": "supernova", "TF": "tully-fisher", "FP": "fundamental-plane",
                "BS": "brightest-stars", "PNLF": "pnlf", "mem": "group-member"}
UNGC_UNUSED = ("h", "h'", "txt", "geom")
CAT_ORDER = {"cf4": 0, "mcc": 1, "ungc": 2, "curated": -1}
HF_SRC = ("Hubble flow from the heliocentric velocity v_helio ({vsrc}, in props) moved to the CMB frame (v_cmb, in props) "
          "with the Planck 2018 solar dipole (369.82 km/s toward l 264.021, b 48.253); H0 = 74.6 km/s/Mpc "
          "(Cosmicflows-4 scale; Planck's 67.4 would place it about 11 % farther), q0 = -0.595, peculiar velocity "
          "300 km/s (Cosmicflows-4 Sec. 13); the interval is the velocity uncertainty only (no H0 term)")


class CuratedError(ValueError):
    """A hand-written input that is missing something the build requires."""


# --- number helpers --------------------------------------------------------------------------

def D(x) -> Decimal:
    return Decimal(str(x))


def num(x, sig: int = 12):
    return neb._num(x, sig)


def sha256_bytes(b: bytes) -> str:
    return neb.sha256(b)


def sex(s: str, hours: bool) -> float | None:
    return neb.sexagesimal(s.strip().replace(" ", ":"), hours=hours)


def angsep_arcmin(ra0: float, dec0: float, ras: np.ndarray, decs: np.ndarray) -> np.ndarray:
    r0, d0, r1, d1 = map(np.radians, (ra0, dec0, ras, decs))
    h = np.sin((d1 - d0) / 2) ** 2 + np.cos(d0) * np.cos(d1) * np.sin((r1 - r0) / 2) ** 2
    return np.degrees(2 * np.arcsin(np.minimum(1.0, np.sqrt(h)))) * 60.0


def norm_key(s: str) -> str:
    """A name reduced for comparison: `MESSIER031`/`M 31` -> `M31`, `NGC0224`/`NGC 224` -> `NGC224`, `And IX` and
    `Andromeda IX` -> `ANDIX`."""
    s = s.upper().replace("ANDROMEDA", "AND").replace("SAGITTARIUS", "SAG").replace("MESSIER", "M")
    s = re.sub(r"[\s\-\(\)\.,_']", "", s)
    return re.sub(r"(?<!\d)0+(?=\d)", "", s)


# --- OpenNGC galaxies ------------------------------------------------------------------------

def read_galaxies(ongc_rows: list[dict]) -> tuple[list[dict], dict]:
    """The galaxy rows (types GAL_TYPES) with Dup designations folded in, and a report."""
    types = Counter(r["Type"] for r in ongc_rows)
    kept, no_position = [], []
    for r in ongc_rows:
        if r["Type"] not in GAL_TYPES:
            continue
        ra, dec = neb.sexagesimal(r["RA"], hours=True), neb.sexagesimal(r["Dec"], hours=False)
        if ra is None or dec is None or not 0 <= ra < 360:
            no_position.append(r["Name"])
            continue
        m = re.search(r"(?:^|,)\s*PGC\s*0*(\d+)\s*(?:,|$)", r["Identifiers"])
        kept.append({"name": r["Name"], "type": r["Type"], "ra": ra, "dec": dec, "row": r, "dups": [],
                     "maj": neb._d(r["MajAx"]), "min": neb._d(r["MinAx"]), "pa": neb._d(r["PosAng"]),
                     "pgc": int(m.group(1)) if m else None})
    index = {k["name"]: k for k in kept}
    folded, unresolved = 0, []
    for r in ongc_rows:
        if r["Type"] != "Dup":
            continue
        master = None
        for col, prefix in (("NGC", "NGC"), ("IC", "IC")):
            n = neb._pad_number(r[col]) if r[col].strip() else None
            if n:
                master = prefix + n
                break
        if master is None:
            unresolved.append(r["Name"])
        elif master in index:
            index[master]["dups"].append(r["Name"])
            folded += 1
    report = {"rows_read": len(ongc_rows), "rows_by_type": dict(sorted(types.items())),
              "kept_by_type": dict(sorted(Counter(k["type"] for k in kept).items())), "galaxy_rows": len(kept),
              "excluded": {"Dup": types.get("Dup", 0), "NonEx": types.get("NonEx", 0)},
              "dup_designations_folded": folded, "dups_without_master": sorted(unresolved),
              "galaxies_without_position": sorted(no_position),
              "galaxies_with_pgc": sum(1 for k in kept if k["pgc"] is not None)}
    return kept, report


# --- UNGC ------------------------------------------------------------------------------------

def read_ungc(rows: list[dict]) -> list[dict]:
    out, seen = [], set()
    for r in rows:
        name = r["Name"].strip()
        if name in seen:
            raise SystemExit(f"UNGC: duplicate name {name!r}")
        seen.add(name)
        ra, dec = sex(r["RAJ2000"], True), sex(r["DEJ2000"], False)
        a26, ba = neb._d(r["a26"]), neb._d(r["b/a"])
        minor = None if a26 is None or ba is None else (a26 * ba).quantize(D("0.01"), rounding=ROUND_HALF_EVEN)
        out.append({"name": name, "ra": ra, "dec": dec, "maj": a26, "min": minor, "bmag": neb._d(r["Bmag"]),
                    "tt": r["TT"].strip(), "hrv": neb._d(r["HRV"]), "dist": neb._d(r["Dist"]),
                    "fdist": r["f_Dist"].strip(), "row": r})
    return out


def read_overrides(data: list) -> dict[str, dict]:
    out = {}
    for e in data:
        if (not isinstance(e, dict) or not isinstance(e.get("ungc"), str) or "ongc" not in e
                or not str(e.get("reason", "")).strip()):
            raise CuratedError(f"bad override entry (needs ungc, ongc and a reason): {e!r}")
        out[e["ungc"]] = e
    return out


def merge_ungc(gals: list[dict], ungc: list[dict], overrides: dict[str, dict]) -> tuple[dict[str, dict], dict]:
    """Merge UNGC rows onto OpenNGC galaxies (docs/object-framework.md 18.3): identifier, overrides, positional.
    Returns `{ungc name: pair}` (`ongc` is an OpenNGC name, or "gal:milky_way", or None for a forbidden merge)."""
    by_name = {g["name"]: g for g in gals}
    by_m = {}
    for g in gals:
        m = neb.messier(g["row"])
        if m:
            by_m["MESSIER" + m.split()[1].zfill(3)] = g
    by_dup = {d: g for g in gals for d in g["dups"]}
    pairs: dict[str, dict] = {}
    claimed: dict[str, str] = {}

    def claim(u: dict, name: str | None, rule: str, **extra) -> None:
        sep = None
        if name in by_name:
            g = by_name[name]
            sep = round(float(angsep_arcmin(u["ra"], u["dec"], np.array([g["ra"]]), np.array([g["dec"]]))[0]), 2)
            claimed[name] = u["name"]
        pairs[u["name"]] = {"ungc": u["name"], "ongc": name, "rule": rule, "sep_arcmin": sep, **extra}

    for e in overrides.values():                         # validate before use
        if e["ongc"] is not None and e["ongc"] != objects.MILKY_WAY_ID and e["ongc"] not in by_name:
            raise CuratedError(f"override {e['ungc']}: {e['ongc']} is not a kept OpenNGC galaxy")
    ungc_names = {u["name"] for u in ungc}
    for k in overrides:
        if k not in ungc_names:
            raise CuratedError(f"override for {k!r}: no such UNGC row")
    # 1. identifier
    for u in ungc:
        if u["name"] in overrides:
            continue
        g = by_name.get(u["name"]) or by_m.get(u["name"])
        rule = "identifier"
        if g is None and u["name"] in by_dup:
            g, rule = by_dup[u["name"]], "identifier (Dup)"
        if g is not None and g["name"] not in claimed:
            claim(u, g["name"], rule)
    # 2. overrides
    for u in ungc:
        e = overrides.get(u["name"])
        if e is None:
            continue
        if e["ongc"] in claimed:
            raise CuratedError(f"override {u['name']}: {e['ongc']} is already claimed by {claimed[e['ongc']]}")
        claim(u, e["ongc"], "override", reason=e["reason"])
    # 3. positional with the velocity test
    free = [g for g in gals if g["name"] not in claimed]
    if free:
        fra = np.array([g["ra"] for g in free])
        fdec = np.array([g["dec"] for g in free])
        cands = []
        for u in ungc:
            if u["name"] in pairs:
                continue
            seps = angsep_arcmin(u["ra"], u["dec"], fra, fdec)
            for i in np.nonzero(seps <= 60.0)[0]:
                g, s = free[int(i)], float(seps[i])
                maj = float(g["maj"]) if g["maj"] is not None else 0.0
                if s > max(1.0, 0.25 * maj):
                    continue
                v_n = neb._d(g["row"]["RadVel"])
                if u["hrv"] is not None and v_n is not None and abs(u["hrv"] - v_n) > 150:
                    continue
                cands.append((s / max(maj, 1.0), u["name"], g["name"], s))
        for score, un, gn, s in sorted(cands):
            if un in pairs or gn in claimed:
                continue
            pairs[un] = {"ungc": un, "ongc": gn, "rule": "positional", "sep_arcmin": round(s, 2),
                         "score": round(score, 4)}
            claimed[gn] = un
    by_rule = Counter(p["rule"] for p in pairs.values())
    return pairs, {"by_rule": {k: by_rule.get(k, 0) for k in ("identifier", "identifier (Dup)", "override", "positional")},
                   "pairs": [pairs[k] for k in sorted(pairs)]}


# --- distance candidates ---------------------------------------------------------------------

def frac_of_sigma_mu(s: float) -> float:
    return 0.4605 * s


def dist_from_modulus(mu: float, sigma: float | None, vcmb: float | None) -> tuple[float, float | None, float | None]:
    """(D, lo, hi) in pc from a distance modulus: `10^((mu+5)/5)`, divided by `1 + Vcmb/c` when `vcmb` is given."""
    k = 1.0 / (1.0 + vcmb / C_KMS) if vcmb is not None else 1.0
    f = lambda m: 10.0 ** ((m + 5.0) / 5.0) * k  # noqa: E731
    if sigma is None:
        return f(mu), None, None
    return f(mu), f(mu - sigma), f(mu + sigma)


def candidate(cat: str, method: str, unit: str, d_pc: float, lo_pc: float | None, hi_pc: float | None,
              frac: float | None, src: str) -> dict:
    scale = 1e-6 if unit == "Mpc" else 1.0
    q = objects.quantity(num(d_pc * scale, 5), src, "measured" if method in MEASURED else "inferred", unit,
                         None if lo_pc is None else num(lo_pc * scale, 5), None if hi_pc is None else num(hi_pc * scale, 5))
    if q["tier"] == "measured" and method in objects.DERIVED_METHODS:
        raise AssertionError(method)
    return {"cat": cat, "method": method, "cls": 0 if method in MEASURED else 1, "frac": frac, "q": q, "pc": d_pc}


def cf4_candidates(row: dict) -> list[dict]:
    vcmb = neb._d(row["Vcmb"])
    out = []
    for col, method in CF4_COLUMNS:
        mu = neb._d(row[col])
        if mu is None:
            continue
        sg = neb._d(row["e_" + col])
        sigma = float(sg) if sg is not None and sg > 0 else None
        d, lo, hi = dist_from_modulus(float(mu), sigma, None if vcmb is None else float(vcmb))
        shown = f"{row[col]} ± {row['e_' + col]}" if sigma is not None else f"{row[col]}"
        src = (f"Cosmicflows-4 (Tully et al. 2023, ApJ 944, 94), table2 PGC {int(row['PGC'])}: {col} {shown}"
               f", converted from the Cosmicflows-4 modulus by Space Maps (comoving, divided by 1 + Vcmb/c)")
        out.append(candidate("cf4", method, "Mpc", d, lo, hi, None if sigma is None else frac_of_sigma_mu(sigma), src))
    return out


def ungc_candidate(u: dict) -> dict | None:
    method = UNGC_METHODS.get(u["fdist"])
    if method is None or u["dist"] is None:
        return None
    src = (f"{SRC_UNGC}: Dist {u['row']['Dist']} Mpc, {u['fdist']}; UNGC gives no per-galaxy error and rounds to "
           f"0.01 Mpc (its Sec. 2 quotes 5-10 % for the TRGB, Cepheid and SN distances)")
    return candidate("ungc", method, "Mpc", float(u["dist"]) * 1e6, None, None, None, src)


def mcc_candidate(r: dict) -> dict:
    mu = float(r["(m-M)"])
    up = float(r["E_(m-M)"]) if r["E_(m-M)"] else 0.0
    dn = float(r["e_(m-M)"]) if r["e_(m-M)"] else 0.0
    d, _, _ = dist_from_modulus(mu, None, None)
    lo = dist_from_modulus(mu - dn, None, None)[0] if dn else None
    hi = dist_from_modulus(mu + up, None, None)[0] if up else None
    frac = frac_of_sigma_mu((up + dn) / 2) if (up or dn) else None
    err = f" +{r['E_(m-M)']} -{r['e_(m-M)']}" if (up or dn) else ""
    src = (f"McConnachie 2012 (AJ 144, 4; J/AJ/144/4), {r['Name'].strip()}: (m-M) {r['(m-M)']}{err}, from resolved "
           f"stellar populations (generally Cepheid, RR Lyrae or TRGB; also horizontal-branch level and "
           f"main-sequence fitting); converted to a distance by Space Maps")
    return candidate("mcc", "resolved-stars", "pc", d, lo, hi, frac, src)


def rank_key(c: dict):
    return (c["cls"], 0 if c["frac"] is not None else 1, c["frac"] or 0.0, CAT_ORDER[c["cat"]],
            METHOD_ORDER.index(c["method"]))


NAMES = {"cf4": "Cosmicflows-4", "mcc": "McConnachie 2012", "ungc": "UNGC", "curated": "the curated"}


def why_not(c: dict, chosen: dict) -> str:
    cm = chosen["method"]
    if c["cls"] > chosen["cls"]:
        return f"not used: a derived method; a measured {cm} distance exists"
    if c["frac"] is None and chosen["frac"] is not None:
        return f"not used: no published uncertainty, the {cm} distance has one"
    if c["frac"] is not None and chosen["frac"] is not None and c["frac"] > chosen["frac"]:
        return f"not used: larger uncertainty than the {cm} distance"
    return f"not used: ranked below the {cm} distance (catalogue order, then method order)"


def choose(cands: list[dict]) -> tuple[dict | None, list[dict]]:
    """The adopted candidate and the alt_distances entries (<= MAX_ALT_DISTANCES), docs/object-framework.md 18.4.2."""
    if not cands:
        return None, []
    cs = sorted(cands, key=rank_key)
    alts = [{"method": c["method"], "dist": c["q"], "reason": why_not(c, cs[0])}
            for c in cs[1:1 + objects.MAX_ALT_DISTANCES]]
    return cs[0], alts


# --- McConnachie -----------------------------------------------------------------------------

def mcc_rows(rows: list[dict]) -> tuple[list[dict], dict]:
    """The usable Local Group rows: n_Name has G, A or L, a modulus, no flag on it, not the Milky Way."""
    usable, skipped = [], Counter()
    for r in rows:
        flags = {t.strip() for t in r["n_Name"].split(",")}
        if not flags & {"G", "A", "L"}:
            skipped["neighbour (N) or other"] += 1
        elif r["Name"].strip() == "The Galaxy" or not r["(m-M)"]:
            skipped["Milky Way row / no modulus"] += 1
        elif r["u_(m-M)"].strip():
            skipped["flagged modulus"] += 1
        else:
            usable.append(r)
    return usable, dict(skipped)


def match_mcc(rows: list[dict], recs: list[dict], claimed_cap: int = 1) -> tuple[dict[str, dict], list[dict], list[str]]:
    """Match McConnachie rows to records by name (Name and OName) then by position (<= 3'). Returns
    `{record id: row}`, the pair list and the names left unmatched."""
    keys: dict[str, list[dict]] = {}
    for rec in recs:
        for n in rec["_names"]:
            keys.setdefault(norm_key(n), []).append(rec)
    ra = np.array([r["_ra"] for r in recs])
    dec = np.array([r["_dec"] for r in recs])
    taken: dict[str, dict] = {}
    pairs, left = [], []
    todo = []
    for r in rows:
        names = [r["Name"]] + [x for x in r["OName"].split(",") if x.strip()]
        hit = None
        for n in names:
            for rec in keys.get(norm_key(n), []):
                if rec["id"] not in taken:
                    hit = rec
                    break
            if hit:
                break
        if hit:
            taken[hit["id"]] = r
            pairs.append(_mcc_pair(r, hit, "name"))
        else:
            todo.append(r)
    cands = []
    for r in todo:
        rr, dd = sex(r["RAJ2000"], True), sex(r["DEJ2000"], False)
        seps = angsep_arcmin(rr, dd, ra, dec)
        for i in np.nonzero(seps <= MCC_MATCH_ARCMIN)[0]:
            cands.append((float(seps[i]), r["Name"].strip(), int(i), r))
    done = set()
    for s, name, i, r in sorted(cands, key=lambda x: x[:3]):
        if name in done or recs[i]["id"] in taken:
            continue
        done.add(name)
        taken[recs[i]["id"]] = r
        pairs.append(_mcc_pair(r, recs[i], "position", s))
    for r in todo:
        if r["Name"].strip() not in done:
            left.append(r["Name"].strip())
    return taken, sorted(pairs, key=lambda p: p["mcconnachie"]), sorted(left)


def _mcc_pair(r: dict, rec: dict, rule: str, sep: float | None = None) -> dict:
    if sep is None:
        sep = float(angsep_arcmin(sex(r["RAJ2000"], True), sex(r["DEJ2000"], False),
                                  np.array([rec["_ra"]]), np.array([rec["_dec"]]))[0])
    return {"mcconnachie": r["Name"].strip(), "record": rec["id"], "rule": rule, "sep_arcmin": round(sep, 2)}


# --- Hubble flow -----------------------------------------------------------------------------

def _unit_vec(ra: float, dec: float) -> np.ndarray:
    r, d = math.radians(ra), math.radians(dec)
    return np.array([math.cos(d) * math.cos(r), math.cos(d) * math.sin(r), math.sin(d)])


def galactic_to_icrs(l: float, b: float) -> tuple[float, float]:
    """ICRS (ra, dec) of a Galactic direction, from the Hipparcos definition (NGP and the pole's longitude)."""
    lr, br, dg = math.radians(l), math.radians(b), math.radians(NGP_DEC)
    dl = math.radians(L_NCP) - lr
    dec = math.asin(math.sin(dg) * math.sin(br) + math.cos(dg) * math.cos(br) * math.cos(dl))
    y = math.cos(br) * math.sin(dl)
    x = math.cos(dg) * math.sin(br) - math.sin(dg) * math.cos(br) * math.cos(dl)
    return (NGP_RA + math.degrees(math.atan2(y, x))) % 360.0, math.degrees(dec)


APEX = galactic_to_icrs(DIPOLE_L, DIPOLE_B)
_APEX_VEC = _unit_vec(*APEX)


def v_cmb(v_helio: float, ra: float, dec: float) -> float:
    """CMB-frame velocity: `v_helio + 369.82 km/s * cos(angle to the dipole apex)`."""
    return v_helio + DIPOLE * float(_unit_vec(ra, dec) @ _APEX_VEC)


def hubble_distance_mpc(v: float) -> float:
    """Comoving distance to second order: `(c z / H0)(1 - (1 + q0) z / 2)`, z = v / c."""
    z = v / C_KMS
    return (C_KMS * z / H0) * (1.0 - (1.0 + Q0) * z / 2.0)


def hubble_quantity(v_helio: float, vc: float, vsrc: str) -> dict:
    d = hubble_distance_mpc(vc)
    f = SIGMA_V / vc
    src = HF_SRC.format(vsrc=vsrc)
    return objects.quantity(num(d, 4), src, "inferred", "Mpc", num(d * (1 - f), 4), num(d * (1 + f), 4))


# --- curated inputs --------------------------------------------------------------------------

def _need_src(node, papers: dict, path: str, problems: list[str]) -> None:
    if isinstance(node, dict):
        if "v" in node:
            if node.get("src") not in papers:
                problems.append(f"{path}: src {node.get('src')!r} is missing or not a key of papers")
            if not (isinstance(node.get("where"), str) and node["where"].strip()):
                problems.append(f"{path}: where is missing")
        else:
            for k, v in node.items():
                if k != "papers":
                    _need_src(v, papers, f"{path}.{k}" if path else k, problems)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _need_src(v, papers, f"{path}[{i}]", problems)


def check_curated(cur: dict, what: str) -> None:
    problems: list[str] = []
    papers = cur.get("papers") or {}
    for key in ("props", "no_edge", "type", "distances", "clusters"):
        if key in cur:
            _need_src(cur[key], papers, key, problems)
    if what == "clusters":
        for c in cur["clusters"]:
            for k in ("sigma", "radius_deg", "radius_mpc"):
                if k not in c:
                    problems.append(f"{c.get('name')}: {k} is missing")
    if problems:
        raise CuratedError(f"{what}: curated file refused:\n  " + "\n  ".join(problems))


def milky_way_record(mw: dict, bh: dict, prov: dict) -> dict:
    check_curated(mw, "milky_way.json")
    papers = mw["papers"]
    system = next((s for s in bh["systems"] if s["bh"]["id"] == mw.get("centre_from")), None)
    if system is None or system["bh"]["position"]["model"] != "fixed":
        raise CuratedError(f"milky_way.json: centre_from {mw.get('centre_from')!r} is not a fixed record in black_holes.json")
    pos = system["bh"]["position"]
    position = {"model": "fixed", "ra": bhb.rnd(bhb.sexagesimal_deg(pos["ra_hms"]["v"], True) % 360, 7),
                "dec": bhb.rnd(bhb.sexagesimal_deg(pos["dec_dms"]["v"], False), 7), "epoch": pos["epoch"],
                "method": pos["method"],
                "dist": bhb.quantity_from(bh["papers"], pos["dist"], unit="pc",
                                          scale=Decimal(1000) if pos["dist"]["unit"] == "kpc" else None)}
    props = {k: bhb.quantity_from(papers, q, tier=q["tier"]) for k, q in mw["props"].items()}
    props["type"] = bhb.text_quantity(papers, mw["type"])
    return objects.record(id=mw["id"], kind="galaxy", name=mw["name"], designations=mw["designations"],
                          position=position, size={"radius": None, "angular": None}, props=props,
                          provenance={"source": f"static:{DATASET}", "dataset": DATASET,
                                      "catalogue": "Space Maps curated (Milky Way)", "version": "1"},
                          evidence="measured", render={"style": "milky_way"})


def curated_distance(entry: dict, papers: dict) -> dict:
    d = entry["dist"]
    sig = math.hypot(d["err_stat"], d["err_sys"])
    v, lo, hi = d["v"] * 1000.0, (d["v"] - sig) * 1000.0, (d["v"] + sig) * 1000.0
    src = (f"{bhb.paper_src(papers, d['src'], d['where'])}; statistical and systematic errors added in quadrature")
    q = objects.quantity(num(v, 6), src, "measured", "pc", num(lo, 6), num(hi, 6))
    return {"cat": "curated", "method": entry["method"], "cls": 0, "frac": sig / d["v"], "q": q, "pc": v}


# --- records ---------------------------------------------------------------------------------

def provenance() -> dict:
    return {"source": f"static:{DATASET}", "dataset": DATASET, "catalogue": CATALOGUE, "version": VERSION}


def designations_for(g: dict | None, u: dict | None, name: str) -> list[str]:
    out: list[str] = []

    def add(x: str) -> None:
        x = x.strip()
        if x and x != name and x not in out:
            out.append(x)

    if g is not None:
        row = g["row"]
        if neb.messier(row):
            add(neb.messier(row))
        add(neb.fmt_designation(g["name"]))
        for col, prefix in (("NGC", "NGC"), ("IC", "IC")):
            if row[col].strip():
                add(neb.fmt_designation(prefix + (neb._pad_number(row[col]) or row[col])))
        for d in g["dups"]:
            add(neb.fmt_designation(d))
        ids = [i.strip() for i in row["Identifiers"].split(",") if i.strip()]
        for pat, fmt in ((r"UGC \d+", lambda s: "UGC " + str(int(s.split()[1]))),
                         (r"PGC \d+", lambda s: "PGC " + str(int(s.split()[1]))),
                         (r"ESO \d+-\d+", lambda s: s)):
            for i in ids:
                if re.fullmatch(pat, i):
                    add(fmt(i))
    if u is not None and g is not None and neb.fmt_designation(u["name"]) not in out and u["name"] != g["name"] \
            and neb.fmt_designation(u["name"]) != name:
        add(u["name"])
    if g is not None:
        for c in row["Common names"].split(","):
            add(c)
    return out[:MAX_DESIGNATIONS]


def display_name(g: dict | None, u: dict | None, rid: str, names: dict) -> str:
    if rid in names:
        return names[rid]
    if g is not None:
        first = next((c.strip() for c in g["row"]["Common names"].split(",") if c.strip()), "")
        if first:
            return first
        if neb.messier(g["row"]):
            return neb.messier(g["row"])
        return neb.fmt_designation(g["name"])
    return neb.fmt_designation(u["name"]) if re.fullmatch(r"(NGC|IC)\d+.*", u["name"]) else u["name"]


def build_records(inputs: dict, cur: dict) -> tuple[list[dict], dict, list[str]]:
    """Records, the build report and the context-set ids, from parsed inputs and the curated files."""
    gals, report = read_galaxies(inputs["ongc"])
    ungc = read_ungc(inputs["ungc"])
    overrides = read_overrides(cur["overrides"])
    pairs, mrep = merge_ungc(gals, ungc, overrides)
    gal_names = {g["name"] for g in gals}
    by_ungc_of = {pairs[u["name"]]["ongc"]: u for u in ungc
                  if u["name"] in pairs and pairs[u["name"]]["ongc"] in gal_names}
    ungc_only = [u for u in ungc if u["name"] not in pairs]
    ungc_only += [u for u in ungc if u["name"] in pairs and pairs[u["name"]]["ongc"] is None]
    report.update({"ungc_rows": len(ungc), "ungc_merges": mrep["by_rule"], "ungc_merged_pairs": mrep["pairs"],
                   "ungc_only": len(ungc_only), "ungc_milky_way_row_dropped": any(p["ongc"] == objects.MILKY_WAY_ID for p in pairs.values())})

    # CF4
    cf4 = {int(r["PGC"]): r for r in inputs["cf4"]}
    groups = {int(r["1PGC"]): r for r in inputs["groups"]}
    cf4_ra = np.array([float(r["RAJ2000"]) for r in inputs["cf4"]])
    cf4_dec = np.array([float(r["DEJ2000"]) for r in inputs["cf4"]])
    cf4_rows = inputs["cf4"]
    cf4_pgc_join = Counter()
    cf4_pos_pairs, cf4_pos_conflicts = [], []

    items = []      # one per record: dict with g, u, id, ra, dec, cands
    for g in gals:
        u = by_ungc_of.get(g["name"])
        items.append({"g": g, "u": u, "id": f"ongc:{g['name']}", "ra": g["ra"], "dec": g["dec"], "cf4": cf4.get(g["pgc"]) if g["pgc"] else None})
        if items[-1]["cf4"] is not None:
            cf4_pgc_join["joined"] += 1
        elif g["pgc"] is not None:
            cf4_pgc_join["pgc_not_in_cf4"] += 1
    for u in ungc_only:
        row = None
        seps = angsep_arcmin(u["ra"], u["dec"], cf4_ra, cf4_dec)
        idx = np.nonzero(seps <= CF4_MATCH_ARCMIN)[0]
        if len(idx) == 1:
            row = cf4_rows[int(idx[0])]
            cf4_pos_pairs.append({"ungc": u["name"], "pgc": int(row["PGC"]), "sep_arcmin": round(float(seps[idx[0]]), 3)})
        elif len(idx) > 1:
            cf4_pos_conflicts.append({"ungc": u["name"], "pgcs": [int(cf4_rows[int(i)]["PGC"]) for i in idx]})
        items.append({"g": None, "u": u, "id": f"ungc:{u['name']}", "ra": u["ra"], "dec": u["dec"], "cf4": row})
    report["cf4"] = {"rows": len(cf4_rows), "groups_rows": len(groups), "openngc_with_pgc": report["galaxies_with_pgc"],
                     "joined_by_pgc": cf4_pgc_join["joined"], "pgc_not_in_cf4": cf4_pgc_join["pgc_not_in_cf4"],
                     "ungc_only_joined_by_position": len(cf4_pos_pairs), "positional_pairs": cf4_pos_pairs,
                     "positional_conflicts_not_joined": cf4_pos_conflicts}

    # McConnachie
    mrows, mskipped = mcc_rows(inputs["mcconnachie"])
    names_of = {}
    for it in items:
        ns = []
        if it["g"] is not None:
            g = it["g"]
            ns += [g["name"], *g["dups"], *[c for c in g["row"]["Common names"].split(",") if c.strip()]]
            if neb.messier(g["row"]):
                ns.append(neb.messier(g["row"]))
            ns += [i for i in g["row"]["Identifiers"].split(",") if re.match(r"(UGC|PGC|ESO|MCG|DDO) ", i.strip())]
        if it["u"] is not None:
            ns.append(it["u"]["name"])
        it["_names"], it["_ra"], it["_dec"] = ns, it["ra"], it["dec"]
    taken, mpairs, mleft = match_mcc(mrows, items)
    report["mcconnachie"] = {"rows": len(inputs["mcconnachie"]), "usable": len(mrows), "skipped": mskipped,
                             "matched": len(taken), "pairs": mpairs, "unmatched": mleft}

    # curated Magellanic Clouds
    lg_papers = cur["local_group"]["papers"]
    check_curated(cur["local_group"], "local_group_curated.json")
    curated = {e["record"]: curated_distance(e, lg_papers) for e in cur["local_group"]["distances"]}
    for rid in curated:
        if rid not in {it["id"] for it in items}:
            raise CuratedError(f"local_group_curated.json: {rid} is not a record")
    clusters = cur["clusters"]
    check_curated(clusters, "clusters.json")

    # first pass: catalogue candidates
    for it in items:
        cands = []
        if it["cf4"] is not None:
            cands += cf4_candidates(it["cf4"])
        if it["id"] in taken:
            cands.append(mcc_candidate(taken[it["id"]]))
        if it["u"] is not None:
            c = ungc_candidate(it["u"])
            if c:
                cands.append(c)
        it["cands"] = cands
        if it["id"] in curated:
            alts = sorted(cands, key=rank_key)[:objects.MAX_ALT_DISTANCES]
            it["chosen"] = curated[it["id"]]
            it["alts"] = [{"method": c["method"], "dist": c["q"],
                           "reason": "not used: the curated eclipsing-binary distance is used for the Magellanic Clouds"}
                          for c in alts]
        else:
            it["chosen"], it["alts"] = choose(cands)

    # velocities, Hubble flow and clusters
    by_id = {it["id"]: it for it in items}
    cl_info = []
    for c in clusters["clusters"]:
        centre = by_id.get(c["centre"])
        grp = groups.get(c["cf4_group"])
        if centre is None or grp is None:
            raise CuratedError(f"clusters.json: {c['name']}: centre or CF4 group missing")
        mu, e = float(grp["DMzp"]), float(grp["e_DMzp"])
        d, lo, hi = dist_from_modulus(mu, e, float(grp["V3k"]))
        r_pc = c["radius_mpc"]["v"] * 1e6
        d_pc = d
        err = math.hypot(max(d - lo, hi - d), r_pc)
        src = (f"Placed at the distance of the {c['name'].replace(' cluster', '')} cluster (Cosmicflows-4 group "
               f"{c['cf4_group']}: DMzp {grp['DMzp']} ± {grp['e_DMzp']}, converted by Space Maps), because its velocity "
               f"mostly reflects its motion inside the cluster: it lies within {c['radius_deg']['v']} deg of the "
               f"cluster centre and within 3 sigma ({c['sigma']['v']} km/s) of the group's velocity {grp['Vh']} km/s; "
               f"the interval adds the cluster radius {c['radius_mpc']['v']} Mpc along the line of sight in quadrature")
        q = objects.quantity(num(d_pc * 1e-6, 5), src, "inferred", "Mpc", num((d_pc - err) * 1e-6, 5), num((d_pc + err) * 1e-6, 5))
        cl_info.append({"c": c, "centre": centre, "vh": float(grp["Vh"]), "q": q, "members": [], "grp": grp})
    hf = Counter()
    direction_reasons = Counter()
    cluster_direction_only = Counter()
    for it in items:
        g, u = it["g"], it["u"]
        v = vsrc = None
        if g is not None and neb._d(g["row"]["RadVel"]) is not None:
            v, vsrc = float(neb._d(g["row"]["RadVel"])), f"OpenNGC {OPENNGC_TAG} RadVel"
        elif u is not None and u["hrv"] is not None:
            v, vsrc = float(u["hrv"]), "UNGC HRV"
        it["v"], it["vsrc"] = v, vsrc
        it["vcmb"] = None
        if it["chosen"] is not None:
            continue
        if v is None:
            direction_reasons["no_velocity"] += 1
            continue
        it["vcmb"] = vc = v_cmb(v, it["ra"], it["dec"])
        member = None
        for ci in cl_info:
            sep = float(angsep_arcmin(it["ra"], it["dec"], np.array([ci["centre"]["ra"]]), np.array([ci["centre"]["dec"]]))[0]) / 60.0
            if sep <= ci["c"]["radius_deg"]["v"] and abs(v - ci["vh"]) <= 3 * ci["c"]["sigma"]["v"]:
                member = ci
                break
        if vc < V_MIN:
            direction_reasons["below_1000_km_s"] += 1
            if member is not None:
                cluster_direction_only[member["c"]["name"]] += 1
            continue
        if member is not None:
            member["members"].append(it["id"])
            it["chosen"] = {"cat": "cluster", "method": "group-member", "q": member["q"], "pc": member["q"]["v"] * 1e6}
            it["cluster"] = member["c"]["name"]
        else:
            it["chosen"] = {"cat": "hubble", "method": "redshift", "pc": 0.0,
                            "q": hubble_quantity(v, vc, vsrc)}
            hf["hubble_flow"] += 1
    report["direction_only"] = {"no_velocity": direction_reasons["no_velocity"],
                                "below_1000_km_s": direction_reasons["below_1000_km_s"],
                                "total": direction_reasons["no_velocity"] + direction_reasons["below_1000_km_s"]}

    # records
    names = cur["names"]["names"]
    records = []
    for it in items:
        records.append(galaxy_record(it, names))
    mw = milky_way_record(cur["mw"], cur["bh"], provenance())
    records.append(mw)
    ids = [r["id"] for r in records]
    if len(set(ids)) != len(ids):
        raise CuratedError("duplicate record ids")

    # report
    by_method = Counter((r["position"].get("method") or "direction-only") for r in records)
    by_evidence = Counter(r["evidence"] for r in records)
    source_of = Counter()
    for it in items:
        source_of[it["chosen"]["cat"] if it["chosen"] else "direction-only"] += 1
    report["distances"] = {"by_method": dict(sorted(by_method.items())), "by_evidence": dict(sorted(by_evidence.items())),
                           "by_source": dict(sorted(source_of.items()))}
    report["hubble_flow"] = hf["hubble_flow"]
    report["clusters"] = {ci["c"]["name"]: {"members": len(ci["members"]), "cf4_group": ci["c"]["cf4_group"],
                                            "distance_mpc": ci["q"]["v"], "ids": sorted(ci["members"]),
                                            "direction_only_in_window_below_1000_km_s": cluster_direction_only.get(ci["c"]["name"], 0)}
                          for ci in cl_info}
    report["cluster_members_total"] = sum(len(ci["members"]) for ci in cl_info)
    report["alt_distances_records"] = sum(1 for r in records if r.get("alt_distances"))
    report["records_written"] = len(records)
    report["by_type"] = dict(sorted(Counter(r["props"]["type"]["v"] for r in records).items()))
    report["milky_way"] = {"centre_from": cur["mw"]["centre_from"], "no_edge": cur["mw"]["no_edge"]}

    # context set
    smbh = cur["smbh"]
    hosts = sorted({b["host_galaxy"] for b in smbh["black_holes"]})
    for h in hosts:
        if h not in ids:
            raise CuratedError(f"smbh.json: host galaxy {h} is not a galaxy record")
    context, why = [], {}
    for r in records:
        reasons = []
        d = r["position"].get("dist")
        if d is not None:
            pc = d["v"] * (1e6 if d["unit"] == "Mpc" else 1.0)
            if pc <= CONTEXT_DIST_PC:
                reasons.append("distance <= 3 Mpc")
        mb = r["props"].get("mag_b")
        if mb is not None and mb["v"] < CONTEXT_MAG_B:
            reasons.append("mag_b < 10")
        if r["id"] in hosts:
            reasons.append("SMBH host")
        if r["id"] == objects.MILKY_WAY_ID:
            reasons.append("the Milky Way")
        if reasons:
            context.append(r["id"])
            why[r["id"]] = reasons
    report["context_set"] = {"count": len(context), "smbh_hosts": hosts, "members": {k: why[k] for k in sorted(why)}}
    return records, report, context


def galaxy_record(it: dict, names: dict) -> dict:
    g, u, rid = it["g"], it["u"], it["id"]
    name = display_name(g, u, rid, names)
    ch = it["chosen"]
    if g is not None:
        maj, mino, pa, ang_src = g["maj"], g["min"], g["pa"], SRC_ONGC
        if maj is None and u is not None and u["maj"] is not None:
            maj, mino, pa, ang_src = u["maj"], u["min"], None, SRC_UNGC
    else:
        maj, mino, pa, ang_src = u["maj"], u["min"], None, SRC_UNGC
    ang = None
    if maj is not None:
        mk = lambda x, unit: None if x is None else objects.quantity(num(x, 8), ang_src, "catalogue", unit)  # noqa: E731
        ang = {"major": mk(maj, "arcmin"), "minor": mk(mino, "arcmin"), "pa": mk(pa, "deg")}
    dist = method = None
    evidence = "measured"
    if ch is not None:
        dist, method = ch["q"], ch["method"]
        evidence = "measured" if dist["tier"] == "measured" else "derived"
    position = {"model": "fixed", "ra": num(it["ra"], 12), "dec": num(it["dec"], 12), "epoch": 2000.0,
                "tier": "catalogue", "dist": dist}
    if method:
        position["method"] = method
    radius = None
    if dist is not None and ang is not None:
        pc = dist["v"] * (1e6 if dist["unit"] == "Mpc" else 1.0)
        radius = objects.quantity(num(pc * math.tan(math.radians(float(maj) / 60.0 / 2.0)), 5),
                                  "half the catalogue major axis at the adopted distance", "inferred", "pc")
    size = None if radius is None and ang is None else {"radius": radius, "angular": ang}

    props: dict[str, dict] = {}
    if g is not None:
        row = g["row"]
        props["type"] = objects.quantity(TYPE_LABEL[g["type"]], f"{SRC_ONGC} ({g['type']})", "catalogue")
        if row["Hubble"].strip():
            props["hubble"] = objects.quantity(row["Hubble"].strip(), SRC_ONGC, "catalogue")
        elif u is not None and u["tt"]:
            props["hubble"] = objects.quantity(f"T = {u['tt']}", SRC_UNGC, "catalogue")
        for key, col in (("mag_b", "B-Mag"), ("mag_v", "V-Mag")):
            v = neb._d(row[col])
            if v is not None:
                props[key] = objects.quantity(num(v, 8), SRC_ONGC, "catalogue", "mag")
        if "mag_b" not in props and u is not None and u["bmag"] is not None:
            props["mag_b"] = objects.quantity(num(u["bmag"], 8), SRC_UNGC, "catalogue", "mag")
        sb = neb._d(row["SurfBr"])
        if sb is not None:
            props["surface_brightness"] = objects.quantity(num(sb, 8), SRC_ONGC, "catalogue", "mag/arcsec2")
        rv = neb._d(row["RadVel"])
        if rv is not None:
            props["v_helio"] = objects.quantity(num(rv, 8), SRC_ONGC, "catalogue", "km/s")
        elif u is not None and u["hrv"] is not None:
            props["v_helio"] = objects.quantity(num(u["hrv"], 8), SRC_UNGC, "catalogue", "km/s")
        z = neb._d(row["Redshift"])
        if z is not None:
            props["redshift"] = objects.quantity(num(z, 8), SRC_ONGC, "catalogue")
    else:
        props["type"] = objects.quantity("Galaxy", SRC_UNGC, "catalogue")
        if u["tt"]:
            props["hubble"] = objects.quantity(f"T = {u['tt']}", SRC_UNGC, "catalogue")
        if u["bmag"] is not None:
            props["mag_b"] = objects.quantity(num(u["bmag"], 8), SRC_UNGC, "catalogue", "mag")
        if u["hrv"] is not None:
            props["v_helio"] = objects.quantity(num(u["hrv"], 8), SRC_UNGC, "catalogue", "km/s")
    if ch is not None and ch["method"] == "redshift":
        props["v_cmb"] = objects.quantity(num(it["vcmb"], 5), "v_helio + Planck 2018 solar dipole (369.82 km/s toward "
                                          "l 264.021, b 48.253)", "inferred", "km/s")
    render = {}
    for k in ("mag_b", "mag_v"):
        if k in props:
            render["mag"] = props[k]["v"]
            break
    rec = objects.record(id=rid, kind="galaxy", name=name, designations=designations_for(g, u, name),
                         position=position, size=size, props=props, provenance=provenance(), evidence=evidence,
                         render=render)
    if it.get("alts"):
        rec["alt_distances"] = it["alts"]
    return rec


# --- licence text ----------------------------------------------------------------------------

def license_text(which: str) -> str:
    if which == "sources":
        folder = "backend/data/sources/galaxies/"
        covered = (
            "- the gzipped input snapshots (`*.gz`): OpenNGC `NGC.csv` and `addendum.csv` exactly as published at "
            f"commit `{OPENNGC_SHA}`, and the four VizieR tables (UNGC, Cosmicflows-4 `table2` and `groups`, "
            "McConnachie 2012) without their `#` header lines;\n"
            "- `SOURCE.json`, the list of those inputs with their hashes, URLs and retrieval dates;\n"
            f"- `{OVERRIDES_FILE}`, `{NAMES_FILE}`, `{MW_FILE}`, `{LG_FILE}` and `{CLUSTERS_FILE}`, hand-written "
            "curated files;\n- this file.")
        derived = ("The OpenNGC files are unmodified copies. The VizieR tables are unmodified copies too (the CF4 "
                   "table keeps only the columns the build uses), redistributed with the citations below under "
                   f"VizieR's terms of use ({VIZIER_TERMS}); CC BY-SA 4.0 does not relicense them.")
    else:
        folder = "frontend/data/objects/galaxies/"
        covered = "- `manifest.json`;\n- `tiles/*.json`, the galaxy records;\n- this file."
        derived = ("These files are derived from OpenNGC: its galaxies, coordinates, sizes, magnitudes, velocities, "
                   "names and identifiers were merged with UNGC (by identifier, a committed override table and "
                   "position), given distances, and converted to Space Maps' record format. The OpenNGC-derived "
                   "values are licensed under the same CC BY-SA 4.0 licence; the exceptions are below.")
    return f"""# Licence and credits: galaxies data

Applies to **every file in `{folder}`**:

{covered}

## Licence

{derived}

The OpenNGC data, and the data derived from it, are licensed under **{LICENCE_NAME}**
({LICENCE_URL}).

{CREDIT}

OpenNGC is at {OPENNGC_URL}, release {OPENNGC_TAG}, commit `{OPENNGC_SHA}`. Changes made here: the rows of the types
G, GPair, GTrpl and GGroup were selected, merged with UNGC, given distances and re-encoded as JSON records (see
`docs/object-framework.md`, section 18).

## Values with other terms

Nothing here is relicensed: each value keeps the terms of its source, named in its `src`.

- **Cosmicflows-4 / EDD-terms values.** Every distance whose `src` says "Cosmicflows-4" (the per-method moduli
  converted to comoving distances, and the CF4 group distances of the Virgo, Fornax, Coma and Perseus clusters) comes
  from Tully et al. 2023, which the Extragalactic Distance Database ({EDD_TERMS}) distributes under its terms: use,
  analysis and sharing for research and education, provided EDD is cited; changed, converted or combined data must
  say so and must not be presented as EDD data. These values are converted by Space Maps (the `src` says so) and are
  not EDD data. They are **not** under CC BY-SA 4.0. Cite Tully et al. 2009, AJ 138, 323 alongside the paper.
- **UNGC and McConnachie values**, served by VizieR (CDS), keep VizieR's terms of use ({VIZIER_TERMS}) with the
  citations below.
- **Hubble-flow distances and the cluster rule** are computed by Space Maps from OpenNGC (or UNGC) velocities and
  the Planck 2018 dipole; the cluster distances use the CF4 groups table.
- **The Milky Way record** copies Sgr A*'s position and distance from the black-hole source file (GRAVITY
  Collaboration 2022; Reid & Brunthaler) and holds Bland-Hawthorn & Gerhard 2016 and Hipparcos values, each cited in
  its `src`.

There are no Gaia values in these files.

## OpenNGC acknowledgements

{neb.OPENNGC_ACKNOWLEDGEMENTS}

## Other catalogues

- {CITATIONS['ungc']}
- {CITATIONS['cf4']}
- {CITATIONS['mcconnachie']}

VizieR terms of use: {VIZIER_TERMS}

## Code

The code that builds these files (`backend/scripts/build_objects_galaxies.py`) and the rest of the repository are
under the MIT licence (see the repository `LICENSE`). Only the data files listed above carry the terms named here.
"""


# --- reading and writing the pinned input ----------------------------------------------------

def canonical(role: str, raw: bytes) -> bytes:
    return raw if role in ONGC_ROLES else neb.strip_comments(raw)


def parse_role(role: str, data: bytes) -> list[dict]:
    return neb.parse_ongc(data) if role in ONGC_ROLES else neb.parse_vizier(data)


def check_rows(role: str, rows: list[dict]) -> None:
    want = INPUTS[role]["rows"]
    if len(rows) != want:
        raise SystemExit(f"{INPUTS[role]['file']}: expected {want} rows, got {len(rows)} (truncated download?)")


def load_curated(sources: Path, bh_file: Path, smbh_file: Path) -> dict:
    def rd(name: str):
        b = (sources / name).read_bytes()
        return json.loads(b.decode("utf-8")), sha256_bytes(b)

    cur, shas = {}, {}
    cur["overrides"], shas[OVERRIDES_FILE] = rd(OVERRIDES_FILE)
    cur["names"], shas[NAMES_FILE] = rd(NAMES_FILE)
    cur["mw"], shas[MW_FILE] = rd(MW_FILE)
    cur["local_group"], shas[LG_FILE] = rd(LG_FILE)
    cur["clusters"], shas[CLUSTERS_FILE] = rd(CLUSTERS_FILE)
    for key, f in (("bh", bh_file), ("smbh", smbh_file)):
        b = f.read_bytes()
        cur[key] = json.loads(b.decode("utf-8"))
        shas[f"{f.parent.name}/{f.name}"] = sha256_bytes(b)
    return cur, shas


def load_inputs(sources: Path, local: Path | None) -> dict:
    meta = json.loads((sources / "SOURCE.json").read_text(encoding="utf-8"))
    files = {f["role"]: f for f in meta["files"] if "sha256" in f and f.get("kind") != "committed"}
    parsed, info = {}, {}
    for role, spec in INPUTS.items():
        f = files[role]
        if local is None:
            data = gzip.decompress((sources / f["file"]).read_bytes())
            if neb.sha256(data) != f["sha256"] or (spec["sha256"] and neb.sha256(data) != spec["sha256"]):
                raise SystemExit(f"{f['file']}: sha256 differs from SOURCE.json or from the pin in the script")
            info[role] = f
        else:
            data = canonical(role, (local / spec["local"]).read_bytes())
            info[role] = dict(f, retrieved=None, mirror=None, url=None, sha256=neb.sha256(data), file=spec["local"])
        rows = parse_role(role, data)
        check_rows(role, rows)
        parsed[role] = rows
    return {"inputs": {"ongc": parsed["openngc"] + parsed["openngc-addendum"], "ungc": parsed["ungc"],
                       "cf4": parsed["cf4-table2"], "groups": parsed["cf4-groups"],
                       "mcconnachie": parsed["mcconnachie"]}, "files": info}


def provenance_full(files: dict) -> dict:
    inputs = [{k: f.get(k) for k in ("role", "file", "sha256", "rows", "url", "mirror", "retrieved")}
              for f in sorted(files.values(), key=lambda f: f["role"])]
    return {"catalogue": CATALOGUE, "version": VERSION, "openngc_commit": OPENNGC_SHA, "url": OPENNGC_URL,
            "credit": MANIFEST_CREDIT, "licence_name": MANIFEST_LICENCE_NAME, "licence": LICENCE_URL,
            "citation": " | ".join(["OpenNGC (Mattia Verga), " + OPENNGC_URL, *CITATIONS.values(),
                                    "Tully R. B. et al., 2009, AJ 138, 323 (Extragalactic Distance Database)"]),
            "data_licence_note": ("OpenNGC-derived data: CC BY-SA 4.0. Cosmicflows-4 distances: EDD terms "
                                  f"({EDD_TERMS}), research and education, cite EDD; values converted by Space Maps, "
                                  f"not relicensed. UNGC and McConnachie tables via VizieR: {VIZIER_TERMS}. "
                                  "No Gaia values."),
            "vizier_terms": VIZIER_TERMS, "edd_terms": EDD_TERMS, "inputs": inputs}


def build(out_dir: Path, sources: Path = SOURCES, local: Path | None = None, bh_file: Path = BH_FILE,
          smbh_file: Path = SMBH_FILE) -> dict:
    """Build the dataset (and its LICENSE.md) into `out_dir` from the committed snapshots, or from raw downloads."""
    loaded = load_inputs(sources, local)
    cur, shas = load_curated(sources, bh_file, smbh_file)
    records, report, context = build_records(loaded["inputs"], cur)
    report["curated_sha256"] = shas
    snap_bytes = {f["file"]: (sources / f["file"]).stat().st_size for f in loaded["files"].values()
                  if local is None and (sources / f["file"]).is_file()}
    report["snapshot_bytes"] = dict(sorted(snap_bytes.items()))
    report["snapshot_bytes_total"] = sum(snap_bytes.values())
    kw = dict(dataset=DATASET, kinds=["galaxy"], provenance=provenance_full(loaded["files"]), band_deg=10,
              precedence=50, src_table=True, record_defaults={"provenance": provenance(), "kind": "galaxy", "host": None, "parent": None}, sky_ids=context)
    with tempfile.TemporaryDirectory() as tmp:     # tile sizes do not depend on the manifest's report
        m0 = objects_static.write_dataset(records, Path(tmp), build={"script": SCRIPT, "script_version": SCRIPT_VERSION,
                                                                    "report": {}}, **kw)
        tile_bytes = {f"{t}.json": (Path(tmp) / "tiles" / f"{t}.json").stat().st_size for t in sorted(m0["tiles"])}
        report["tile_bytes"] = tile_bytes
        report["tiles_bytes_total"] = sum(tile_bytes.values())
        report["largest_tile"] = max(tile_bytes.items(), key=lambda kv: kv[1])
    manifest = objects_static.write_dataset(records, out_dir, build={"script": SCRIPT, "script_version": SCRIPT_VERSION,
                                                                    "report": report}, **kw)
    (out_dir / "LICENSE.md").write_text(license_text("dataset"), encoding="utf-8")
    size = sum(p.stat().st_size for p in (out_dir / "tiles").glob("*.json")) + (out_dir / "manifest.json").stat().st_size
    if size > BUDGET_BYTES:
        print(f"WARNING: dataset is {size} bytes, over the {BUDGET_BYTES} budget", file=sys.stderr)
    return manifest


# --- downloading -----------------------------------------------------------------------------

def vizier_url(mirror: str, table: str, columns: tuple | None = None) -> str:
    from urllib.parse import quote
    cols = "&-out.all" if not columns else "&-out=" + ",".join(columns)
    return f"https://{mirror}/viz-bin/asu-tsv?-source={quote(table, safe='')}{cols}&-out.max=unlimited"


def _get(url: str) -> bytes:
    import httpx
    import time
    last = None
    for attempt in range(3):
        try:
            r = httpx.get(url, timeout=httpx.Timeout(60.0, connect=15.0), follow_redirects=True)
            r.raise_for_status()
            return r.content
        except httpx.HTTPError as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{url[:100]}: {last}")


def verify_download(role: str, raw: bytes) -> bytes:
    data = canonical(role, raw)
    check_rows(role, parse_role(role, data))
    pin = INPUTS[role]["sha256"]
    if pin and neb.sha256(data) != pin:
        raise SystemExit(f"{INPUTS[role]['file']}: sha256 {neb.sha256(data)} differs from the pin {pin}; refusing it")
    return data


def download(role: str) -> tuple[bytes, str, str]:
    spec = INPUTS[role]
    if role in ONGC_ROLES:
        url = neb.OPENNGC_RAW + spec["remote"]
        return verify_download(role, _get(url)), url, "raw.githubusercontent.com"
    errors = []
    for mirror in VIZIER_MIRRORS:
        url = vizier_url(mirror, spec["table"], spec["columns"])
        try:
            return verify_download(role, _get(url)), url, mirror
        except (RuntimeError, SystemExit) as e:
            errors.append(f"{mirror}: {e}")
    raise SystemExit(f"no VizieR mirror returned {spec['table']} as pinned:\n  " + "\n  ".join(errors))


def source_json(files: list[dict]) -> dict:
    return {"dataset": DATASET,
            "note": ("Pinned inputs of backend/scripts/build_objects_galaxies.py. Regenerate with --refresh. `sha256` is "
                     "of the uncompressed committed bytes: OpenNGC exactly as published at the pinned commit; VizieR "
                     "tables without their # comment lines and empty lines (the lines carry the request date). The "
                     "hand-written files are committed, not downloaded; their sha256 is in manifest.build.report."),
            "files": files + [{"role": f"curated:{f}", "file": f, "kind": "committed",
                               "licence": "Space Maps curated; each number cites its paper"} for f in CURATED_FILES]}


def refresh(directory: Path, local: Path | None = None, copy_from: Path | None = None) -> None:
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    files, blobs = [], {}
    for role, spec in INPUTS.items():
        if local is not None:
            data = verify_download(role, (local / spec["local"]).read_bytes())
            url, mirror = None, "(local file)"
        else:
            data, url, mirror = download(role)
        blobs[role] = data
        f = {"role": role, "file": spec["file"], "sha256": neb.sha256(data), "rows": spec["rows"], "url": url,
             "mirror": mirror, "retrieved": today, "bytes": len(data)}
        if role in ONGC_ROLES:
            f.update(source="OpenNGC", commit=OPENNGC_SHA, release=OPENNGC_TAG, licence=f"{LICENCE_NAME}, {LICENCE_URL}",
                     citation=CREDIT)
        else:
            f.update(source="VizieR", vizier_id=spec["vizier"], table=spec["table"], licence=VIZIER_TERMS,
                     citation=CITATIONS[CITATION_OF[role]])
            if spec.get("columns"):
                f["columns"] = list(spec["columns"])
        files.append(f)
    for f in CURATED_FILES:
        if not (directory / f).exists():
            raise SystemExit(f"{directory / f} is missing (it is committed by hand)")
    directory.mkdir(parents=True, exist_ok=True)
    for old in list(directory.glob("*.gz")):
        old.unlink()
    for role, data in blobs.items():
        neb.write_gz(directory / INPUTS[role]["file"], data)
    (directory / "SOURCE.json").write_text(json.dumps(source_json(files), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (directory / "LICENSE.md").write_text(license_text("sources"), encoding="utf-8")
    print("pins:", {r: neb.sha256(d) for r, d in blobs.items() if r in VIZIER_ROLES})


# --- command line ----------------------------------------------------------------------------

def _files(d: Path) -> dict[str, bytes]:
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


def _print_report(m: dict, out: Path) -> None:
    r = m["build"]["report"]
    print(f"rows read {r['rows_read']}; kept {r['kept_by_type']}; excluded {r['excluded']}; "
          f"Dup designations folded {r['dup_designations_folded']}")
    print(f"UNGC {r['ungc_rows']} rows: merges {r['ungc_merges']}, UNGC-only {r['ungc_only']}")
    for p in r["ungc_merged_pairs"]:
        print(f"  {p['ungc']} -> {p['ongc']} ({p['rule']}, {p['sep_arcmin']}')")
    c = r["cf4"]
    print(f"CF4: {c['joined_by_pgc']} by PGC ({c['pgc_not_in_cf4']} PGC not in CF4), {c['ungc_only_joined_by_position']} UNGC-only by "
          f"position, {len(c['positional_conflicts_not_joined'])} conflicts")
    mc = r["mcconnachie"]
    print(f"McConnachie: {mc['usable']} usable of {mc['rows']}, {mc['matched']} matched, unmatched {mc['unmatched']}")
    print(f"distances {r['distances']}; Hubble flow {r['hubble_flow']}; direction-only {r['direction_only']}")
    print(f"clusters {{{', '.join(f'{k}: {v['members']}' for k, v in r['clusters'].items())}}}")
    print(f"context set {r['context_set']['count']}; tiles {r['tiles_bytes_total']} bytes (largest {r['largest_tile']}); "
          f"snapshots {r['snapshot_bytes_total']} bytes")
    print(f"wrote {r['records_written']} records")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--sources", type=Path, default=SOURCES)
    ap.add_argument("--local", type=Path, help="a directory of raw downloads (build from it, or refresh from it)")
    ap.add_argument("--refresh", action="store_true", help="download the pinned inputs (network), rewrite the snapshots, build")
    ap.add_argument("--check", action="store_true",
                    help="rebuild into a temp dir, compare with --out and verify it; exit 1 on any difference")
    a = ap.parse_args()
    if a.refresh:
        refresh(a.sources, a.local)
        print(f"snapshots written to {a.sources}")
        a.local = None
    if a.check:
        with tempfile.TemporaryDirectory() as tmp:
            build(Path(tmp), a.sources, a.local)
            fresh, have = _files(Path(tmp)), (_files(a.out) if a.out.is_dir() else {})
        diff = sorted(k for k in fresh.keys() | have.keys() if fresh.get(k) != have.get(k))
        src_license = a.sources / "LICENSE.md"
        if not src_license.is_file() or src_license.read_text(encoding="utf-8") != license_text("sources"):
            diff.append(f"{a.sources}/LICENSE.md")
        problems = objects_static.verify_dataset(a.out) if a.out.is_dir() else ["output directory missing"]
        if diff:
            print(f"{a.out} differs from a fresh build: {', '.join(diff[:10])}{' ...' if len(diff) > 10 else ''}", file=sys.stderr)
        for p in problems[:20]:
            print(f"verify: {p}", file=sys.stderr)
        if diff or problems:
            return 1
        print(f"{a.out} is up to date ({len(fresh)} files, verified)")
        return 0
    m = build(a.out, a.sources, a.local)
    _print_report(m, a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
