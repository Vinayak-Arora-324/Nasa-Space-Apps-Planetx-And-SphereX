"""Build the `nea-exoplanets` object dataset: NASA Exoplanet Archive planets and their host stars.

Source: the archive's `pscomppars` table (one row per planet, the "composite" best values) through its TAP
service. The pin is the committed, deterministically gzipped CSV under `backend/data/sources/nea-exoplanets/`
(the archive has no dated releases), plus two small Gaia side inputs from a Gaia TAP service: the DR2 to DR3
neighbourhood of hosts that only have a DR2 id, and Gaia sources around hosts that have no Gaia or
Hipparcos id. A rebuild therefore needs no network. Design: docs/object-framework.md section 16.

    uv run python backend/scripts/build_objects_nea.py                # build from the committed snapshot
    uv run python backend/scripts/build_objects_nea.py --check        # rebuild in a temp dir, compare, verify
    uv run python backend/scripts/build_objects_nea.py --local FILE   # build from a given pscomppars CSV
    uv run python backend/scripts/build_objects_nea.py --refresh      # download a new snapshot, then build

`--refresh` is the only mode that uses the network: it writes `pscomppars-<UTC date>.csv.gz`, the Gaia side
inputs and `SOURCE.json`. Commit a refresh on its own so the data change is reviewable. `--check` exits 1
when the committed dataset differs from a fresh build, or fails `objects_static.verify_dataset`.

Output: one `exoplanet` record per planet (an `orbit` position hosted by its star, tiled by the host's
direction) and one `star` record per host. Host ids come from a ladder (section 16.4): Gaia DR3 id, DR2 id
crossmatched to DR3, Hipparcos number, a Gaia DR3 positional match (not for microlensing hosts), and finally
`neahost:<hostname>`. Every record's placement is `illustrative`, because the archive has no node angle.
Nothing is invented: a missing value is `null`, and an assumed one (eccentricity 0, M* = 1 Msun) is tiered
`illustrative` and says so. A value the archive flags as a limit (`*lim` column: 1 upper, -1 lower) is never
presented as a measurement: for orbital elements it is treated as missing (a limit on `e` becomes a circular
orbit, `illustrative`, with the bound in `hi`), and for card-only quantities `v` is a string such as "< 0.12".
A negative lower bound of an intrinsically non-negative quantity is clamped to 0 and counted in the report. The build report is written to `manifest.build.report`.
"""

from __future__ import annotations

import argparse
import csv
import datetime
import gzip
import hashlib
import html
import io
import json
import math
import re
import sys
import tempfile
import time
from collections import Counter
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from spherex_app import objects, objects_static  # noqa: E402

DATASET = "nea-exoplanets"
OUT = ROOT / "frontend" / "data" / "objects" / DATASET
SOURCES = ROOT / "backend" / "data" / "sources" / DATASET
SCRIPT = "backend/scripts/build_objects_nea.py"
SCRIPT_VERSION = 1

NEA_TAP = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"
GAIA_TAPS = ("https://gea.esac.esa.int/tap-server/tap/sync", "https://gaia.ari.uni-heidelberg.de/tap/sync")
CATALOGUE = "NASA Exoplanet Archive pscomppars"
CITATION = "Christiansen et al. 2025 (NASA Exoplanet Archive)"
ACKNOWLEDGEMENT = ("This research has made use of the NASA Exoplanet Archive, which is operated by the "
                   "California Institute of Technology, under contract with the National Aeronautics and "
                   "Space Administration under the Exoplanet Exploration Program.")
GAIA_CITATION = "Gaia Collaboration, Vallenari et al. 2023 (Gaia DR3), A&A 674, A1"
DR2_NEIGHBOUR_CITATION = GAIA_CITATION + "; Torra et al. 2021 (dr2_neighbourhood), A&A 649, A10"
GAIA_LICENCE = ("Gaia data are public: https://www.cosmos.esa.int/web/gaia-users/license. "
                "This work has made use of data from the European Space Agency (ESA) mission Gaia "
                "(https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis "
                "Consortium (DPAC).")
SRC = "NEA pscomppars"
GAIA_CREDIT = "Credit: ESA/Gaia/DPAC"          # docs/object-framework.md 18.12
GAIA_LICENCE_NAME = "CC BY-NC 3.0 IGO"
GAIA_LICENCE_URL = "https://creativecommons.org/licenses/by-nc/3.0/igo/"

# the fixed column list of the TAP query
COLUMNS = (
    "pl_name pl_letter hostname hd_name hip_name tic_id gaia_dr2_id gaia_dr3_id sy_pnum tran_flag "
    "pl_controv_flag discoverymethod disc_year disc_facility ra dec "
    "sy_dist sy_disterr1 sy_disterr2 sy_dist_reflink sy_plx sy_vmag sy_vmag_reflink sy_gaiamag "
    "sy_gaiamag_reflink "
    "pl_orbper pl_orbpererr1 pl_orbpererr2 pl_orbper_reflink "
    "pl_orbsmax pl_orbsmaxerr1 pl_orbsmaxerr2 pl_orbsmax_reflink "
    "pl_orbeccen pl_orbeccenerr1 pl_orbeccenerr2 pl_orbeccen_reflink "
    "pl_orbincl pl_orbinclerr1 pl_orbinclerr2 pl_orbincl_reflink "
    "pl_orblper pl_orblpererr1 pl_orblpererr2 pl_orblper_reflink "
    "pl_orbtper pl_orbtpererr1 pl_orbtpererr2 pl_orbtper_reflink "
    "pl_tranmid pl_tranmiderr1 pl_tranmiderr2 pl_tranmid_reflink "
    "pl_bmassj pl_bmassjerr1 pl_bmassjerr2 pl_bmassj_reflink pl_bmassprov "
    "pl_rade pl_radeerr1 pl_radeerr2 pl_rade_reflink pl_radelim "
    "st_spectype st_spectype_reflink st_teff st_tefferr1 st_tefferr2 st_teff_reflink "
    "st_rad st_raderr1 st_raderr2 st_rad_reflink st_mass st_masserr1 st_masserr2 st_mass_reflink "
    "pl_orbperlim pl_orbsmaxlim pl_orbeccenlim pl_orbincllim pl_orblperlim pl_orbtperlim pl_tranmidlim "
    "pl_bmassjlim st_tefflim st_radlim st_masslim sy_distlim sy_plxlim sy_vmaglim sy_gaiamaglim"
).split()
# value-limit flags the build reads (NEA: 1 upper limit, -1 lower limit, 0 or empty a value)
LIMIT_COLUMNS = [c for c in COLUMNS if c.endswith("lim")]
ADQL = f"select {','.join(COLUMNS)} from pscomppars order by pl_name"

DR2_MATCH_MAS = 100.0       # DR2 -> DR3: closest neighbour within this angular distance ...
DR2_MATCH_DMAG = 1.0        # ... and with |delta G| no larger than this
POS_QUERY_ARCSEC = 5.0      # positional step: Gaia sources fetched around the archive position
POS_MATCH_ARCSEC = 1.5      # ... and accepted when unique within this radius
POS_MATCH_DMAG = 0.5        # ... with |G - sy_gaiamag| no larger than this
GAIA_EPOCH, NEA_EPOCH = 2016.0, 2000.0
MJD_OFFSET = Decimal("2400000.5")
YEAR_D = 365.25
POSITION_SRC = "NASA Exoplanet Archive pscomppars; orientation on the sky (node) unknown"
KEPLER_SRC = "derived from a and M* (Kepler III)"

SIDE_FILES = {"dr2_dr3": "gaia-dr2-dr3.csv.gz", "positional": "gaia-positional.csv.gz"}
DR2_COLS = ["dr2_source_id", "dr3_source_id", "angular_distance", "magnitude_difference"]
POS_COLS = ["source_id", "ra", "dec", "pmra", "pmdec", "phot_g_mean_mag"]


# --- parsing helpers -------------------------------------------------------------------------

def _d(s: str | None) -> Decimal | None:
    """A CSV cell as an exact Decimal, or None when empty or not a finite number."""
    s = (s or "").strip()
    if not s:
        return None
    try:
        d = Decimal(s)
    except InvalidOperation:
        return None
    return d if d.is_finite() else None


def _num(d: Decimal | float | int, sig: int = 12) -> float | int:
    """A number for JSON, at most `sig` significant digits: archive values are exact decimals with
    fewer digits than that, so only float noise from arithmetic is removed."""
    if isinstance(d, int):
        return d
    x = float(format(d, f".{sig}g"))
    return int(x) if x.is_integer() and abs(x) < 1e15 else x


_A_RE = re.compile(r"<a\b[^>]*>(.*?)</a>", re.I | re.S)


def reflink_text(link: str | None) -> str:
    """The reference text of an archive reflink: the anchor text, tags removed, HTML entities decoded,
    whitespace collapsed ('<a ...> Agol &amp; al. 2021 </a>' -> 'Agol & al. 2021'). Empty if none."""
    m = _A_RE.search(link or "")
    if not m:
        return ""
    text = html.unescape(re.sub(r"<[^>]*>", "", m.group(1)))
    return re.sub(r"\s+", " ", text).strip()


def is_calculated(link: str | None) -> bool:
    """True when the archive computed the value itself (reflink 'Calculated Value')."""
    return "refstr=CALCULATED_VALUE" in (link or "")


def src_of(row: dict, col: str) -> str:
    """`NEA pscomppars: <reference>` for the value of column `col` (its reflink's text)."""
    link = row.get(f"{col}_reflink")
    if is_calculated(link):
        return f"{SRC}: archive-calculated value"
    text = reflink_text(link)
    return f"{SRC}: {text}" if text else SRC


CLAMPED: Counter[str] = Counter()   # lower bounds clamped to 0, by column (reset by build_records)


def limit_flag(row: dict, col: str) -> int:
    """1 when the archive flags `col` as an upper limit, -1 for a lower limit, else 0."""
    d = _d(row.get(f"{col}lim"))
    return 0 if not d else (1 if d > 0 else -1)


def value(row: dict, col: str) -> Decimal | None:
    """The archive value of `col`, or None when it is missing or flagged as a limit."""
    return None if limit_flag(row, col) else _d(row.get(col))


def quantity(row: dict, col: str, *, tier: str, unit: str | None = None, src: str | None = None,
             offset: Decimal | None = None, intervals: bool = True, nonneg: bool = False,
             limit: str = "missing") -> dict | None:
    """The Quantity for column `col` (None when the value is missing), with its interval
    (lo = v + err2, hi = v + err1; symmetric when only one error is given; none when both are 0).

    A value flagged as a limit is returned as None (`limit="missing"`), or as a string `v` such as
    "< 0.12" / "> 3.1" with the same unit, tier and src and no interval (`limit="string"`), which
    number-consuming clients skip and cards show verbatim. `nonneg` clamps a negative `lo` to 0."""
    v = _d(row.get(col))
    if v is None:
        return None
    flag = limit_flag(row, col)
    if flag:
        if limit != "string":
            return None
        return objects.quantity(f"{'<' if flag > 0 else '>'} {_num(v)}", src or src_of(row, col), tier, unit)
    if offset is not None:
        v = v - offset
    e1, e2 = _d(row.get(f"{col}err1")), _d(row.get(f"{col}err2"))
    lo = hi = None
    if intervals and (e1 is not None or e2 is not None) and not (not e1 and not e2):
        hi = v + abs(e1 if e1 is not None else e2)
        lo = v - abs(e2 if e2 is not None else e1)
        if nonneg and lo < 0:
            lo = Decimal(0)
            CLAMPED[col] += 1
    return objects.quantity(_num(v), src or src_of(row, col), tier, unit,
                            None if lo is None else _num(lo), None if hi is None else _num(hi))


# --- host ids --------------------------------------------------------------------------------

def _strip_id(s: str, prefix: str) -> str | None:
    s = (s or "").strip()
    if s.startswith(prefix):
        s = s[len(prefix):].strip()
    return s if s.isdigit() else None


def _hip(s: str) -> str | None:
    m = re.fullmatch(r"HIP\s+(\d+)", (s or "").strip())
    return str(int(m.group(1))) if m else None


def _propagate(ra: float, dec: float, pmra: float | None, pmdec: float | None) -> tuple[float, float]:
    """A Gaia position (epoch 2016.0) moved to epoch 2000.0 with its proper motion (mas/yr, pmra
    including cos dec). Without a proper motion the position is returned unchanged."""
    if pmra is None or pmdec is None:
        return ra, dec
    dt = NEA_EPOCH - GAIA_EPOCH
    return (ra + pmra * dt / (3.6e6 * max(math.cos(math.radians(dec)), 1e-9)), dec + pmdec * dt / 3.6e6)


def _fnum(s: str | None) -> float | None:
    d = _d(s)
    return None if d is None else float(d)


def positional_match(ra: float, dec: float, gaiamag: float | None, sources: list[dict]) -> str | None:
    """Ladder step 4. `sources` are Gaia rows (POS_COLS) near the archive position. Returns the DR3
    source id, or None. The Gaia position is propagated from 2016.0 to 2000.0 and also tried as it
    stands; the first of the two with exactly one source within 1.5" is used, and that source must have
    |G - sy_gaiamag| <= 0.5 when sy_gaiamag is known."""
    parsed = []
    for s in sources:
        sra, sdec = _fnum(s.get("ra")), _fnum(s.get("dec"))
        if sra is None or sdec is None or not (s.get("source_id") or "").strip():
            continue
        parsed.append((s["source_id"].strip(), sra, sdec, _fnum(s.get("pmra")), _fnum(s.get("pmdec")),
                       _fnum(s.get("phot_g_mean_mag"))))
    for propagate in (True, False):
        near = []
        for sid, sra, sdec, pmra, pmdec, g in parsed:
            pra, pdec = _propagate(sra, sdec, pmra, pmdec) if propagate else (sra, sdec)
            if objects.angsep_deg(ra, dec, pra % 360.0, pdec) * 3600.0 <= POS_MATCH_ARCSEC:
                near.append((sid, g))
        if len(near) == 1:
            sid, g = near[0]
            if gaiamag is None or (g is not None and abs(g - gaiamag) <= POS_MATCH_DMAG):
                return sid
    return None


def dr2_to_dr3(dr2_id: str, neighbours: list[dict]) -> str | None:
    """Ladder step 2. `neighbours` are the dr2_neighbourhood rows of `dr2_id`. The closest one is
    taken, and only if it lies within 100 mas with |delta G| <= 1 (Torra et al. 2021); a DR2 id is
    never reused as a DR3 id, because the two differ for some stars."""
    best = None
    for n in neighbours:
        dist, dmag, dr3 = _fnum(n.get("angular_distance")), _fnum(n.get("magnitude_difference")), \
            (n.get("dr3_source_id") or "").strip()
        if dist is None or not dr3.isdigit():
            continue
        key = (dist, int(dr3))
        if best is None or key < best[0]:
            best = (key, dmag, dr3)
    if best is None:
        return None
    (dist, _), dmag, dr3 = best
    if dist <= DR2_MATCH_MAS and dmag is not None and abs(dmag) <= DR2_MATCH_DMAG:
        return dr3
    return None


def group_hosts(rows: list[dict]) -> dict[str, list[dict]]:
    """Rows by hostname, each group in pl_name order, hosts in name order."""
    out: dict[str, list[dict]] = {}
    for r in sorted(rows, key=lambda r: r["pl_name"]):
        out.setdefault(r["hostname"], []).append(r)
    return dict(sorted(out.items()))


def is_microlensing(rows: list[dict]) -> bool:
    return any(r.get("discoverymethod") == "Microlensing" for r in rows)


def _first(rows: list[dict], col: str) -> str:
    return next((r[col].strip() for r in rows if (r.get(col) or "").strip()), "")


def resolve_hosts(groups: dict[str, list[dict]], dr2_rows: list[dict], pos_rows: list[dict]) -> dict[str, dict]:
    """The host id ladder. Returns {hostname: {"id", "step", "dr3", "hip", "same_as"}}: `step` is one
    of dr3, dr2-crossmatch, hip, positional, neahost; `dr3` is the Gaia DR3 id found (or None); `hip`
    the Hipparcos number (or None); `same_as` the other ids of the star."""
    dr2_by: dict[str, list[dict]] = {}
    for n in dr2_rows:
        dr2_by.setdefault((n.get("dr2_source_id") or "").strip(), []).append(n)
    out = {}
    for host, rows in groups.items():
        dr3 = _strip_id(_first(rows, "gaia_dr3_id"), "Gaia DR3")
        dr2 = _strip_id(_first(rows, "gaia_dr2_id"), "Gaia DR2")
        hip = _hip(_first(rows, "hip_name"))
        step = None
        if dr3:
            step = "dr3"
        elif dr2 and (dr3 := dr2_to_dr3(dr2, dr2_by.get(dr2, []))):
            step = "dr2-crossmatch"
        elif hip:
            step = "hip"
        elif not is_microlensing(rows) and (ra := _fnum(rows[0].get("ra"))) is not None \
                and (dec := _fnum(rows[0].get("dec"))) is not None \
                and (dr3 := positional_match(ra, dec, _fnum(_first(rows, "sy_gaiamag")),
                                             near_sources(pos_rows, ra, dec))):
            step = "positional"
        if step in ("dr3", "dr2-crossmatch", "positional"):
            hid, same = f"gdr3:{dr3}", ([f"hip:{hip}"] if hip else [])
        elif step == "hip":
            hid, same = f"hip:{hip}", []
        else:
            step, dr3, hid, same = "neahost", None, f"neahost:{host}", []
        out[host] = {"id": hid, "step": step, "dr3": dr3, "hip": hip, "same_as": same}
    return out


def near_sources(pos_rows: list[dict], ra: float, dec: float) -> list[dict]:
    return [s for s in pos_rows
            if (sra := _fnum(s.get("ra"))) is not None and (sdec := _fnum(s.get("dec"))) is not None
            and objects.angsep_deg(ra, dec, sra, sdec) * 3600.0 <= POS_QUERY_ARCSEC]


def dr2_candidates(groups: dict[str, list[dict]]) -> list[str]:
    """DR2 ids of hosts that have no DR3 id (the ids the DR2 -> DR3 query needs)."""
    return sorted({d for rows in groups.values() if not _strip_id(_first(rows, "gaia_dr3_id"), "Gaia DR3")
                   and (d := _strip_id(_first(rows, "gaia_dr2_id"), "Gaia DR2"))}, key=int)


def positional_candidates(groups: dict[str, list[dict]], dr2_rows: list[dict]) -> list[tuple[str, float, float]]:
    """(hostname, ra, dec) of the hosts that reach ladder step 4 (no DR3, no DR2 crossmatch, no Hipparcos
    number, not microlensing), given the DR2 side input."""
    ladder = resolve_hosts(groups, dr2_rows, [])
    return [(h, float(_d(rows[0]["ra"])), float(_d(rows[0]["dec"])))
            for h, rows in groups.items()
            if ladder[h]["step"] == "neahost" and not is_microlensing(rows)
            and _d(rows[0].get("ra")) is not None and _d(rows[0].get("dec")) is not None]


# --- records ---------------------------------------------------------------------------------

def kepler_period_d(a_au: float, mstar: float) -> float:
    """P[yr]^2 = a[AU]^3 / M[Msun]; in days (Julian years)."""
    return YEAR_D * math.sqrt(a_au ** 3 / mstar)


def kepler_a_au(period_d: float, mstar: float) -> float:
    return (mstar * (period_d / YEAR_D) ** 2) ** (1.0 / 3.0)


def exclusion_reason(row: dict) -> str | None:
    """Why a planet is left out of the dataset, or None."""
    per, a = value(row, "pl_orbper"), value(row, "pl_orbsmax")
    if (per is None or per <= 0) and (a is None or a <= 0):
        return "no orbital period and no semi-major axis"
    if _d(row.get("ra")) is None or _d(row.get("dec")) is None:
        return "no host position"
    return None


def provenance(snapshot_date: str) -> dict:
    return {"source": f"static:{DATASET}", "dataset": DATASET, "catalogue": CATALOGUE,
            "version": f"snapshot {snapshot_date}"}


def _host_radec(row: dict) -> list[float]:
    return [_num(_d(row["ra"]) % 360), _num(_d(row["dec"]))]


def planet_record(row: dict, host_id: str, mstar: float | None, prov: dict) -> dict:
    """The `exoplanet` record of one pscomppars row (which must not be excluded)."""
    per_q = quantity(row, "pl_orbper", tier="measured", unit="d", nonneg=True)
    a_q = quantity(row, "pl_orbsmax", tier="catalogue", unit="au", nonneg=True)
    per_ok = per_q is not None and per_q["v"] > 0
    a_ok = a_q is not None and a_q["v"] > 0
    if not per_ok:
        m, tier = (mstar, "inferred") if mstar else (1.0, "illustrative")
        src = KEPLER_SRC if mstar else "derived from a assuming M* = 1 Msun (Kepler III)"
        per_q = objects.quantity(_num(kepler_period_d(a_q["v"], m), 10), src, tier, "d")
    if not a_ok:
        m, tier = (mstar, "inferred") if mstar else (1.0, "illustrative")
        src = "derived from P and M* (Kepler III)" if mstar else "derived from P assuming M* = 1 Msun (Kepler III)"
        a_q = objects.quantity(_num(kepler_a_au(per_q["v"], m), 10), src, tier, "au")
    e_q = quantity(row, "pl_orbeccen", tier="measured", nonneg=True)
    e_flag = limit_flag(row, "pl_orbeccen")
    if e_flag and _d(row.get("pl_orbeccen")) is not None:   # a limit: drawn circular, the bound is kept
        bound = _num(_d(row["pl_orbeccen"]))
        ref = src_of(row, "pl_orbeccen").partition(": ")[2]
        e_q = objects.quantity(
            0, f"{SRC}: {'upper' if e_flag > 0 else 'lower'} limit e {'<' if e_flag > 0 else '>'} {bound}"
               f"{f' ({ref})' if ref else ''}; drawn circular", "illustrative",
            hi=bound if e_flag > 0 else None)
    elif e_q is None:
        e_q = objects.quantity(0, "assumed circular (no eccentricity in the archive)", "illustrative")
    i_q = quantity(row, "pl_orbincl", tier="measured", unit="deg")
    w_q = quantity(row, "pl_orblper", tier="measured", unit="deg")
    tp_q = quantity(row, "pl_orbtper", tier="measured", offset=MJD_OFFSET)
    tc_q = quantity(row, "pl_tranmid", tier="measured", offset=MJD_OFFSET)
    elements = {"period_d": per_q, "a_au": a_q, "e": e_q, "i_deg": i_q, "omega_deg": w_q,
                "t_peri_mjd": tp_q, "t_conj_mjd": tc_q, "node_deg": None}
    position = {"model": "orbit", "host_radec": _host_radec(row), "phase_known": bool(tp_q or tc_q),
                "tier": "illustrative", "src": POSITION_SRC, "elements": elements}

    size = None
    calc = is_calculated(row.get("pl_rade_reflink"))
    r_q = quantity(row, "pl_rade", unit="Rearth", tier="inferred" if calc else "measured", nonneg=True,
                   limit="string",
                   src=f"{SRC}: archive-calculated from mass (Chen & Kipping 2017)" if calc else None)
    if r_q is not None:
        size = {"radius": r_q, "angular": None}

    props: dict[str, dict] = {}
    prov_kind = (row.get("pl_bmassprov") or "").strip()
    if prov_kind == "Mass":
        q, key = quantity(row, "pl_bmassj", tier="measured", unit="Mjup", nonneg=True, limit="string"), "mass"
    elif prov_kind == "Msin(i)/sin(i)":
        q, key = quantity(row, "pl_bmassj", tier="catalogue", unit="Mjup", nonneg=True, limit="string"), "mass"
    elif prov_kind == "Msini":
        q, key = quantity(row, "pl_bmassj", tier="measured", unit="Mjup", nonneg=True, limit="string"), "msini"
    elif prov_kind == "M-R relationship":
        calc = is_calculated(row.get("pl_bmassj_reflink"))
        q, key = quantity(row, "pl_bmassj", tier="inferred", unit="Mjup", nonneg=True, limit="string",
                          src=f"{SRC}: archive-calculated from radius (Chen & Kipping 2017)" if calc
                          else f"{src_of(row, 'pl_bmassj')} (mass-radius relation)"), "mass"
    else:  # no provenance given: nothing says whether it is a mass or a minimum mass
        q, key = None, "mass"
    if q is not None:
        props[key] = q
    if (row.get("discoverymethod") or "").strip():
        props["disc_method"] = objects.quantity(row["discoverymethod"].strip(), SRC, "catalogue")
    if _d(row.get("disc_year")) is not None:
        props["disc_year"] = objects.quantity(int(_d(row["disc_year"])), SRC, "catalogue")
    if (row.get("disc_facility") or "").strip():
        props["disc_facility"] = objects.quantity(row["disc_facility"].strip(), SRC, "catalogue")
    if _d(row.get("pl_controv_flag")) == 1:
        props["controversial"] = objects.quantity("yes", SRC, "catalogue")

    name, letter = row["pl_name"].strip(), (row.get("pl_letter") or "").strip()
    designations = []
    for col in ("hd_name", "hip_name"):
        base = (row.get(col) or "").strip()
        d = f"{base} {letter}".strip() if base else ""
        if d and d != name and d not in designations:
            designations.append(d)
    vmag = value(row, "sy_vmag")
    return objects.record(
        id=f"nea:{name}", kind="exoplanet", name=name, designations=designations,
        host=host_id, parent=host_id, position=position, size=size, props=props, provenance=prov,
        evidence="illustrative", render={"mag": _num(vmag)} if vmag is not None else {})


def star_record(rows: list[dict], host: dict, prov: dict) -> dict:
    """The `star` record of a host, from the first of its rows (system columns are identical across a
    host's rows)."""
    row = rows[0]
    name = row["hostname"].strip()
    plx = value(row, "sy_plx")
    dist_q = quantity(row, "sy_dist", tier="measured", unit="pc", src=src_of(row, "sy_dist"), nonneg=True)
    position: dict = {"model": "fixed", "ra": _num(_d(row["ra"]) % 360), "dec": _num(_d(row["dec"])),
                      "epoch": None}
    if dist_q is None:
        position["dist"], position["tier"] = None, "catalogue"   # direction only
        evidence = "measured"
    else:
        if plx is not None:
            position["method"], evidence = "parallax", "measured"
        elif is_microlensing(rows):
            position["method"], evidence = "lens-model", "derived"
            dist_q["tier"] = "inferred"
        else:
            position["method"], evidence = "assumed", "illustrative"
            dist_q["tier"] = "illustrative"
        position["dist"] = dist_q
    rad_q = quantity(row, "st_rad", tier="catalogue", unit="Rsun", nonneg=True, limit="string")
    props: dict[str, dict] = {}
    for key, col, unit in (("teff", "st_teff", "K"), ("mass", "st_mass", "Msun")):
        q = quantity(row, col, tier="catalogue", unit=unit, nonneg=True, limit="string")
        if q is not None:
            props[key] = q
    if (row.get("st_spectype") or "").strip():
        props["spectral_type"] = objects.quantity(row["st_spectype"].strip(), src_of(row, "st_spectype"),
                                                  "catalogue")
    for key, col in (("vmag", "sy_vmag"), ("gmag", "sy_gaiamag")):
        q = quantity(row, col, tier="measured", unit="mag", intervals=False, limit="string")
        if q is not None:
            props[key] = q
    if _d(row.get("sy_pnum")) is not None:
        props["n_planets"] = objects.quantity(int(_d(row["sy_pnum"])), SRC, "catalogue")
    designations = []
    for d in ((row.get("hd_name") or "").strip(), _first(rows, "hip_name"), _first(rows, "tic_id"),
              f"Gaia DR3 {host['dr3']}" if host["dr3"] else ""):
        if d and d not in designations:
            designations.append(d)
    vmag = value(row, "sy_vmag")
    rec = objects.record(
        id=host["id"], kind="star", name=name, designations=designations, position=position,
        size={"radius": rad_q, "angular": None} if rad_q else None, props=props, provenance=prov,
        evidence=evidence, render={"mag": _num(vmag)} if vmag is not None else {})
    rec["same_as"] = list(host["same_as"])
    return rec


def limit_counts(rows: list[dict], groups: dict[str, list[dict]]) -> dict:
    """Values the archive flags as limits, by `*lim` column: planet columns over all rows read, host
    (`st_*`, `sy_*`) columns over the first row of each host. {column: {"upper": n, "lower": n}}."""
    out: dict[str, dict[str, int]] = {}
    host_rows = [g[0] for g in groups.values()]
    for col in LIMIT_COLUMNS:
        n_up = n_lo = 0
        for r in (rows if col.startswith("pl_") else host_rows):
            f = limit_flag(r, col[:-3])
            n_up += f > 0
            n_lo += f < 0
        if n_up or n_lo:
            out[col] = {"upper": n_up, "lower": n_lo}
    return out


def build_records(rows: list[dict], dr2_rows: list[dict], pos_rows: list[dict],
                  snapshot_date: str) -> tuple[list[dict], dict]:
    """(records, report) for the pscomppars rows and the Gaia side inputs. Pure: no files, no network."""
    prov = provenance(snapshot_date)
    CLAMPED.clear()
    groups = group_hosts(rows)
    hosts = resolve_hosts(groups, dr2_rows, pos_rows)
    excluded: Counter[str] = Counter()
    planets, kept_hosts = [], {}
    for host, hrows in groups.items():
        for row in hrows:
            why = exclusion_reason(row)
            if why:
                excluded[why] += 1
                continue
            mstar = value(row, "st_mass")
            mstar = float(mstar) if mstar is not None and mstar > 0 else None
            planets.append(planet_record(row, hosts[host]["id"], mstar, prov))
            kept_hosts.setdefault(hosts[host]["id"], (host, [])) [1].append(row)
    stars = []
    merged = 0
    for hid, (host, hrows) in sorted(kept_hosts.items()):
        # two hostnames can resolve to one star; the first (by name) supplies its record
        merged += sum(1 for h in groups if hosts[h]["id"] == hid) - 1
        stars.append(star_record(groups[host], hosts[host], prov))

    ladder = Counter(h["step"] for h in hosts.values())
    steps = ("dr3", "dr2-crossmatch", "hip", "positional", "neahost")
    n_hosts = len(hosts)
    micro_skipped = sum(1 for h, r in groups.items() if hosts[h]["step"] == "neahost" and is_microlensing(r))
    report = {
        "rows_read": len(rows), "planets_written": len(planets), "stars_written": len(stars),
        "records_written": len(planets) + len(stars),
        "excluded": dict(sorted(excluded.items())),
        "hosts": n_hosts,
        "host_ladder": {s: ladder.get(s, 0) for s in steps},
        "host_ladder_rate": {s: round(ladder.get(s, 0) / n_hosts, 4) if n_hosts else 0.0 for s in steps},
        "hosts_with_gaia_dr3_id": sum(ladder.get(s, 0) for s in ("dr3", "dr2-crossmatch", "positional")),
        "gaia_rate": round(sum(ladder.get(s, 0) for s in ("dr3", "dr2-crossmatch", "positional")) / n_hosts, 4)
        if n_hosts else 0.0,
        "dr2_only_hosts": sum(1 for rows_ in groups.values()
                              if not _strip_id(_first(rows_, "gaia_dr3_id"), "Gaia DR3")
                              and _strip_id(_first(rows_, "gaia_dr2_id"), "Gaia DR2")),
        "positional_candidates": len(positional_candidates(groups, dr2_rows)),
        "microlensing_hosts_without_gaia_or_hip_id": micro_skipped,
        "host_ids_shared_by_two_hostnames": merged,
        "limit_flags": limit_counts(rows, groups),
        "lower_bounds_clamped_to_zero": {"total": sum(CLAMPED.values()), "by_column": dict(sorted(CLAMPED.items()))},
        "mass_provenance": dict(sorted(Counter(
            (r.get("pl_bmassprov") or "").strip() or "(none)" for r in rows).items())),
    }
    return planets + stars, report


# --- reading and writing the pinned inputs ---------------------------------------------------

def read_csv_bytes(data: bytes) -> list[dict]:
    return list(csv.DictReader(io.StringIO(data.decode("utf-8"), newline="")))


def read_gz(path: Path) -> bytes:
    return gzip.decompress(path.read_bytes())


def write_gz(path: Path, data: bytes) -> None:
    """Deterministic gzip: no file name, mtime 0."""
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, compresslevel=9, mtime=0) as g:
        g.write(data)
    path.write_bytes(buf.getvalue())


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_sources(directory: Path) -> dict:
    """SOURCE.json and the three inputs of a snapshot directory."""
    meta = json.loads((directory / "SOURCE.json").read_text(encoding="utf-8"))
    files = {f["role"]: f for f in meta["files"]}
    out = {"meta": meta, "files": files}
    for role, f in files.items():
        data = read_gz(directory / f["file"])
        if sha256(data) != f["sha256"]:
            raise SystemExit(f"{f['file']}: sha256 differs from SOURCE.json")
        out[role] = read_csv_bytes(data)
    return out


def provenance_full(src: dict) -> dict:
    nea = src["files"]["pscomppars"]
    side = [{k: f[k] for k in ("file", "sha256", "retrieved", "query_url", "rows", "citation")}
            for role, f in sorted(src["files"].items()) if role != "pscomppars"]
    return {"catalogue": CATALOGUE, "version": f"snapshot {nea['retrieved']}", "citation": CITATION,
            "url": "https://exoplanetarchive.ipac.caltech.edu/", "acknowledgement": ACKNOWLEDGEMENT,
            "query_url": nea["query_url"], "retrieved": nea["retrieved"], "source_sha256": nea["sha256"],
            "side_inputs": side,
            # the Gaia DR3 values (distances, positions, magnitudes) carry Gaia's terms; the app's credits line shows this
            "credit": f"NASA Exoplanet Archive; Gaia DR3 values: {GAIA_CREDIT}",
            "licence_name": f"{GAIA_LICENCE_NAME} (Gaia DR3 values)", "licence": GAIA_LICENCE_URL}


def license_text(which: str) -> str:
    """The LICENSE.md of the sources folder (`which == "sources"`) or of the built dataset (`"dataset"`)."""
    if which == "sources":
        folder = "backend/data/sources/nea-exoplanets/"
        covered = ("- `pscomppars-*.csv.gz`: the NASA Exoplanet Archive `pscomppars` table as downloaded;\n"
                   "- `gaia-dr2-dr3.csv.gz` and `gaia-positional.csv.gz`: ESA Gaia DR3 values (and the DR2 to DR3 "
                   "neighbourhood table) fetched from the Gaia TAP service;\n"
                   "- `SOURCE.json`, the list of those inputs with their hashes, URLs and retrieval dates;\n- this file.")
    else:
        folder = "frontend/data/objects/nea-exoplanets/"
        covered = "- `manifest.json`;\n- `tiles/*.json`, the exoplanet and host-star records;\n- this file."
    return f"""# Licence and credits: nea-exoplanets data

Applies to **every file in `{folder}`**:

{covered}

## Which values are which

- The planet and star parameters from the NASA Exoplanet Archive come from the archive's `pscomppars` table. It
  asks that research using it carries this acknowledgement: {ACKNOWLEDGEMENT}
- The **Gaia DR3 values** (host-star positions, parallaxes and distances, G magnitudes and the identifiers matched
  to them) are ESA Gaia data, distributed under the **{GAIA_LICENCE_NAME}** licence ({GAIA_LICENCE_URL}).
  Credit: ESA/Gaia/DPAC. ESA's terms ask for authorisation (data.licences@esa.int) before commercial use.
  {GAIA_CITATION}. Each record's provenance says which of its values come from Gaia.

Each value keeps the terms of its source. Merging the two sources in one file does not relicense either of them.

## Code

The code that builds these files (`backend/scripts/build_objects_nea.py`) and the rest of the repository are
under the MIT licence (see the repository `LICENSE`).
"""


def build_from(rows: list[dict], dr2_rows: list[dict], pos_rows: list[dict], prov_full: dict,
               snapshot_date: str, out_dir: Path) -> dict:
    records, report = build_records(rows, dr2_rows, pos_rows, snapshot_date)
    m = objects_static.write_dataset(
        records, out_dir, dataset=DATASET, kinds=["exoplanet", "star"], provenance=prov_full,
        build={"script": SCRIPT, "script_version": SCRIPT_VERSION, "report": report},
        band_deg=10, precedence=50, src_table=True, record_defaults={"provenance": provenance(snapshot_date)}, compact=True)
    (Path(out_dir) / "LICENSE.md").write_text(license_text("dataset"), encoding="utf-8")
    return m


def build(out_dir: Path, sources: Path = SOURCES, local: Path | None = None) -> dict:
    """Build the dataset into `out_dir` from the committed snapshot (or from a local CSV)."""
    src = load_sources(sources)
    if local is None:
        rows, prov_full = src["pscomppars"], provenance_full(src)
        date = src["files"]["pscomppars"]["retrieved"]
    else:
        data = local.read_bytes()
        rows = read_csv_bytes(data)
        date = f"local {sha256(data)[:12]}"
        prov_full = dict(provenance_full(src), version=f"local file {local.name}", retrieved=None,
                         query_url=None, source_sha256=sha256(data))
    return build_from(rows, src["dr2_dr3"], src["positional"], prov_full, date, out_dir)


# --- downloading -----------------------------------------------------------------------------

def _http_get(url: str, timeout: float = 300.0) -> bytes:
    import httpx
    last: Exception | None = None
    for attempt in range(3):
        try:
            r = httpx.get(url, timeout=timeout, follow_redirects=True)
            r.raise_for_status()
            return r.content
        except httpx.HTTPError as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise SystemExit(f"download failed: {url[:120]}: {last}")


def _gaia_tap(adql: str, first_column: str) -> tuple[bytes, str]:
    """Run an ADQL query on the first Gaia TAP service that answers with CSV (a service in downtime
    answers with an HTML page). Returns (csv bytes, query URL)."""
    import httpx
    errors = []
    for base in GAIA_TAPS:
        url = f"{base}?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY={quote(adql)}"
        try:
            r = httpx.post(base, data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv",
                                       "QUERY": adql}, timeout=300.0, follow_redirects=True)
            r.raise_for_status()
        except httpx.HTTPError as e:
            errors.append(f"{base}: {e}")
            continue
        if r.content.lstrip().startswith(first_column.encode()):
            return r.content, url
        errors.append(f"{base}: answered with something other than CSV")
    raise SystemExit("no Gaia TAP service answered:\n  " + "\n  ".join(errors))


def _canonical_csv(data: bytes, columns: list[str], key) -> bytes:
    """The rows of a TAP CSV in a fixed order and with Unix line endings, so a refresh is stable."""
    rows = read_csv_bytes(data)
    rows.sort(key=key)
    buf = io.StringIO(newline="")
    w = csv.DictWriter(buf, fieldnames=columns, lineterminator="\n", extrasaction="ignore")
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue().encode("utf-8")


def refresh(directory: Path) -> None:
    """Download the snapshot and side inputs into `directory` and write SOURCE.json."""
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    directory.mkdir(parents=True, exist_ok=True)
    for old in directory.glob("*"):
        old.unlink()
    nea_url = f"{NEA_TAP}?query={quote(ADQL, safe=',')}&format=csv"
    raw = _http_get(nea_url)
    raw = raw.replace(b"\r\n", b"\n")
    rows = read_csv_bytes(raw)
    if not rows or set(COLUMNS) - set(rows[0]):
        raise SystemExit("the archive answered without the expected columns")
    files = []

    def add(role: str, name: str, data: bytes, query_url: str, citation: str, licence: str) -> None:
        write_gz(directory / name, data)
        files.append({"role": role, "file": name, "sha256": sha256(data), "retrieved": today,
                      "query_url": query_url, "rows": len(read_csv_bytes(data)), "citation": citation,
                      "licence": licence})

    add("pscomppars", f"pscomppars-{today}.csv.gz", raw, nea_url, CITATION, ACKNOWLEDGEMENT)
    groups = group_hosts(rows)

    ids = dr2_candidates(groups)
    adql = ("SELECT dr2_source_id, dr3_source_id, angular_distance, magnitude_difference "
            "FROM gaiadr3.dr2_neighbourhood WHERE dr2_source_id IN (" + ", ".join(ids) + ")")
    data, url = _gaia_tap(adql, "dr2_source_id")
    data = _canonical_csv(data, DR2_COLS, lambda r: (int(r["dr2_source_id"]), float(r["angular_distance"]),
                                                      int(r["dr3_source_id"])))
    add("dr2_dr3", SIDE_FILES["dr2_dr3"], data, url, DR2_NEIGHBOUR_CITATION, GAIA_LICENCE)

    cands = positional_candidates(groups, read_csv_bytes(data))
    radius = POS_QUERY_ARCSEC / 3600.0
    if cands:
        where = " OR ".join(f"1=CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra:.7f}, {dec:.7f}, {radius:.7f}))"
                            for _, ra, dec in cands)
        adql = f"SELECT source_id, ra, dec, pmra, pmdec, phot_g_mean_mag FROM gaiadr3.gaia_source WHERE {where}"
        data, url = _gaia_tap(adql, "source_id")
        data = _canonical_csv(data, POS_COLS, lambda r: int(r["source_id"]))
    else:
        data, url = (",".join(POS_COLS) + "\n").encode(), "(no candidates)"
    add("positional", SIDE_FILES["positional"], data, url, GAIA_CITATION, GAIA_LICENCE)
    meta = {"dataset": DATASET, "note": "Pinned inputs of backend/scripts/build_objects_nea.py. Regenerate "
            "with --refresh. `sha256` is of the uncompressed bytes.", "files": files}
    (directory / "SOURCE.json").write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")


# --- command line ----------------------------------------------------------------------------

def _files(d: Path) -> dict[str, bytes]:
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


def _print_report(m: dict) -> None:
    r = m["build"]["report"]
    print(f"rows read {r['rows_read']}; wrote {r['planets_written']} planets + {r['stars_written']} stars "
          f"in {len(m['tiles'])} tiles; excluded {r['excluded'] or 'none'}")
    print("host ladder: " + ", ".join(f"{k} {v} ({r['host_ladder_rate'][k]:.1%})"
                                      for k, v in r["host_ladder"].items())
          + f"; Gaia DR3 id for {r['gaia_rate']:.1%} of {r['hosts']} hosts")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--sources", type=Path, default=SOURCES, help="directory of the committed snapshot")
    ap.add_argument("--local", type=Path, help="build from this pscomppars CSV instead of the snapshot")
    ap.add_argument("--refresh", action="store_true", help="download a new snapshot (network), then build")
    ap.add_argument("--check", action="store_true",
                    help="rebuild into a temp dir, compare with --out and verify it; exit 1 on any difference")
    a = ap.parse_args()
    if a.refresh:
        refresh(a.sources)
        print(f"snapshot written to {a.sources}")
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
            print(f"{a.out} differs from a fresh build: {', '.join(diff[:10])}"
                  f"{' ...' if len(diff) > 10 else ''}", file=sys.stderr)
        for p in problems[:20]:
            print(f"verify: {p}", file=sys.stderr)
        if diff or problems:
            return 1
        print(f"{a.out} is up to date ({len(fresh)} files, verified)")
        return 0
    m = build(a.out, a.sources, a.local)
    (a.sources / "LICENSE.md").write_text(license_text("sources"), encoding="utf-8")
    _print_report(m)
    print(f"wrote {m['count']} records to {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
