"""Build the `nebulae` object dataset: OpenNGC nebulae merged with the Sharpless HII catalogue, with Gaia
parallax distances for planetary nebulae and stellar distances for HII regions.

Design: docs/object-framework.md section 17 (17.2 inputs and licence, 17.3 merge, 17.4 distances) and section 19.4
(HII-region distances from Gaia, Phase 4).

Inputs, all committed as gzipped snapshots under `backend/data/sources/nebulae/` (see SOURCE.json):
- OpenNGC `NGC.csv` and `addendum.csv` at commit 36cb178a (release v20260501), CC BY-SA 4.0 (Mattia Verga);
- Sharpless 1959 `VII/20` (VizieR), 313 HII regions, positions in B1900 FK4;
- Chornay & Walton 2021 `J/A+A/656/A110/tablea1` (VizieR), Gaia EDR3 parallaxes of planetary nebula central stars;
- Russeil 2003 `J/A+A/397/133` table1 and table3 (VizieR), stellar distances of star-forming complexes;
- Shen, Hou, Liu & Gao 2025 `J/A+A/696/A67` table2 and tablea1 (VizieR), Gaia DR3 (and maser) distances of 459 HII
  regions, and their exciting stars;
- `sh2_ongc_overrides.json` (merge) and `shen_overrides.json` (Shen links), the committed override tables (hand
  edited, not pinned; their sha256 goes into the build report).

    uv run python backend/scripts/build_objects_nebulae.py                # build from the committed snapshots
    uv run python backend/scripts/build_objects_nebulae.py --check        # rebuild in a temp dir, compare, verify
    uv run python backend/scripts/build_objects_nebulae.py --local DIR    # build from raw downloads in DIR
    uv run python backend/scripts/build_objects_nebulae.py --refresh      # download, check the pins, rewrite snapshots
    uv run python backend/scripts/build_objects_nebulae.py --refresh --local DIR   # ... from files you downloaded

`--refresh` fetches OpenNGC by its pinned commit and each VizieR table from the CfA mirror, then the IDIA mirror,
then CDS (the mirror used goes into SOURCE.json), and refuses a download whose row count or sha256 differs from the
pin. The sha256 of a VizieR table is taken over the download without its `#` header lines and blank lines, so the pin
is the data and not the server's timestamp. `--check` exits 1 when the committed dataset (LICENSE.md included)
differs from a fresh build, when the sources folder's LICENSE.md is stale, or when `verify_dataset` finds a problem.
`--local DIR` expects the raw files under their upstream names (see LOCAL_NAMES); a build from them is not pinned.

Output: one `nebula` record per OpenNGC nebula (PN, HII, EmN, RfN, Neb, SNR, Cl+N, DrkN; Dup and NonEx rows are not
nebulae) plus one per Sharpless region that was not merged into one of them. Distances: planetary nebulae with a
reliable Gaia parallax are `measured`; HII regions take the best of a Shen et al. 2025 distance (a maser parallax or a
Group I Gaia distance is `measured`, a Group II/III Gaia distance `derived`) and a Russeil 2003 stellar distance
(`derived`), by the ladder of docs 18.4.2; everything else is direction only (`dist` null, evidence `measured`).
"""

from __future__ import annotations

import argparse
import csv
import datetime
import gzip
import hashlib
import io
import json
import math
import re
import sys
import tempfile
import time
from collections import Counter, defaultdict
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from spherex_app import objects, objects_static  # noqa: E402

DATASET = "nebulae"
OUT = ROOT / "frontend" / "data" / "objects" / DATASET
SOURCES = ROOT / "backend" / "data" / "sources" / DATASET
SCRIPT = "backend/scripts/build_objects_nebulae.py"
SCRIPT_VERSION = 2
OVERRIDES_FILE = "sh2_ongc_overrides.json"
SHEN_OVERRIDES_FILE = "shen_overrides.json"

# --- pins ------------------------------------------------------------------------------------

OPENNGC_SHA = "36cb178a0f69dba8bfc03a99c10512831edf1c6b"
OPENNGC_TAG = "v20260501"
OPENNGC_RAW = f"https://raw.githubusercontent.com/mattiaverga/OpenNGC/{OPENNGC_SHA}/database_files/"
OPENNGC_URL = "https://github.com/mattiaverga/OpenNGC"
VIZIER_MIRRORS = ("vizier.cfa.harvard.edu", "vizier.idia.ac.za", "vizier.cds.unistra.fr")

VERSION = f"OpenNGC {OPENNGC_TAG} ({OPENNGC_SHA[:8]})"
SRC_ONGC = f"OpenNGC {OPENNGC_TAG}"
CATALOGUE = "OpenNGC + Sharpless (VII/20)"

# role -> the input. `sha256` is of the uncompressed committed bytes (for VizieR: without `#` and blank lines).
INPUTS = {
    "openngc": {
        "file": f"openngc-{OPENNGC_SHA[:8]}-NGC.csv.gz", "remote": "NGC.csv", "local": "NGC.csv",
        "sha256": "840fe0c9ee1332e551b2e722a0e92726cd7b157914a3d2177602832aadd3aa9e", "rows": 13969,
    },
    "openngc-addendum": {
        "file": f"openngc-{OPENNGC_SHA[:8]}-addendum.csv.gz", "remote": "addendum.csv", "local": "addendum.csv",
        "sha256": "1d8f0914e643ada325a5a94d88d8fefad6a4937a2f77cc34f21483af22b11983", "rows": 64,
    },
    "sharpless": {
        "file": "sharpless-vii20.tsv.gz", "vizier": "VII/20", "table": "VII/20/catalog", "local": "sharpless-vii20.tsv",
        "sha256": "f6a46cb21faf89b5cac39bc09be0f8f29f1ae8846465d9c7d422ea1128b835b1", "rows": 313,
    },
    "chornay": {
        "file": "chornay2021-tablea1.tsv.gz", "vizier": "J/A+A/656/A110", "table": "J/A+A/656/A110/tablea1",
        "local": "chornay2021-tablea1.tsv", "sha256": "4a8178c533016280f2f4138fe9a4251f29cacb5256ff121aad4338a72a5b5923", "rows": 2117,
    },
    "russeil-table1": {
        "file": "russeil2003-table1.tsv.gz", "vizier": "J/A+A/397/133", "table": "J/A+A/397/133/table1",
        "local": "russeil2003-table1.tsv", "sha256": "07ca46e4775e910bda5aa104910ce106111f334ba36726e2e633cd5659eba16a", "rows": 1449,
    },
    "russeil-table3": {
        "file": "russeil2003-table3.tsv.gz", "vizier": "J/A+A/397/133", "table": "J/A+A/397/133/table3",
        "local": "russeil2003-table3.tsv", "sha256": "e8d0d96c2c992f1658cffd232fb293dfcf1f7d951e7009ebbea60af67bfd9fd6", "rows": 481,
    },
    "shen-table2": {
        "file": "shen2025-table2.tsv.gz", "vizier": "J/A+A/696/A67", "table": "J/A+A/696/A67/table2",
        "local": "shen2025-table2.tsv",
        "sha256": "8389057ce590409b391bb43a0de73fdfac489eec711e953c06a98b4af5bce5fc", "rows": 459,
    },
    "shen-tablea1": {
        "file": "shen2025-tablea1.tsv.gz", "vizier": "J/A+A/696/A67", "table": "J/A+A/696/A67/tablea1",
        "local": "shen2025-tablea1.tsv",
        "sha256": "dbf4febbfaf0685be31d3f639ec47bb24261acfa0cd8c7fd0cc615487441382b", "rows": 1382,
    },
}
ONGC_ROLES = ("openngc", "openngc-addendum")
VIZIER_ROLES = ("sharpless", "chornay", "russeil-table1", "russeil-table3", "shen-table2", "shen-tablea1")

ONGC_COLUMNS = ("Name", "Type", "RA", "Dec", "Const", "MajAx", "MinAx", "PosAng", "B-Mag", "V-Mag", "J-Mag", "H-Mag",
                "K-Mag", "SurfBr", "Hubble", "Pax", "Pm-RA", "Pm-Dec", "RadVel", "Redshift", "Cstar U-Mag",
                "Cstar B-Mag", "Cstar V-Mag", "M", "NGC", "IC", "Cstar Names", "Identifiers", "Common names",
                "NED notes", "OpenNGC notes", "Sources")

# --- licence and credit (docs/object-framework.md 17.2) --------------------------------------

CREDIT = "Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC"
LICENCE_NAME = "CC BY-SA 4.0"
LICENCE_URL = "https://creativecommons.org/licenses/by-sa/4.0/"
# the manifest names both terms: the 59 PN distances and central-star ids are Gaia EDR3-derived (docs 18.18 item 1)
GAIA_CREDIT = "Credit: ESA/Gaia/DPAC"
GAIA_LICENCE_NAME = "CC BY-NC 3.0 IGO"
GAIA_LICENCE_URL = "https://creativecommons.org/licenses/by-nc/3.0/igo/"
MANIFEST_CREDIT = (f"{CREDIT}; PN distances (Chornay & Walton 2021, Gaia EDR3) and HII-region distances "
                   f"(Shen et al. 2025, Gaia DR3): {GAIA_CREDIT}")
MANIFEST_LICENCE_NAME = f"{LICENCE_NAME} (OpenNGC data); Gaia-based PN and HII-region distances {GAIA_LICENCE_NAME}"
VIZIER_TERMS = "https://cds.unistra.fr/vizier-org/licences_vizier.html"
CITATIONS = {
    "sharpless": "Sharpless S., 1959, ApJS 4, 257: A Catalogue of H II Regions (1959ApJS....4..257S), VizieR VII/20",
    "chornay": ("Chornay N. & Walton N. A., 2021, A&A 656, A110: One star, two star, red star, blue star: an updated "
                "planetary nebula central star distance catalogue from Gaia EDR3 (2021A&A...656A.110C), "
                "doi:10.26093/cds/vizier.36560110, VizieR J/A+A/656/A110"),
    "shen": ("Shen X.-J., Hou L.-G., Liu Z. & Gao Z.-M., 2025, A&A 696, A67: Parallax-based distances to Galactic HII "
             "regions: nearby spiral structure (arXiv:2503.01551, 2025A&A...696A..67S), doi:10.1051/0004-6361/202452712, "
             "VizieR J/A+A/696/A67"),
    "russeil": ("Russeil D., 2003, A&A 397, 133: Star-forming complexes and the spiral structure of our Galaxy "
                "(2003A&A...397..133R), doi:10.26093/cds/vizier.33970133, VizieR J/A+A/397/133"),
}
OPENNGC_ACKNOWLEDGEMENTS = """\
OpenNGC has been built by merging data from:

- NASA/IPAC Extragalactic Database, http://ned.ipac.caltech.edu/
  This research has made use of the NASA/IPAC Extragalactic Database (NED) which is operated by the Jet Propulsion
  Laboratory, California Institute of Technology, under contract with the National Aeronautics and Space
  Administration.
- HyperLEDA database, http://leda.univ-lyon1.fr
  We acknowledge the usage of the HyperLeda database (http://leda.univ-lyon1.fr)
- SIMBAD Astronomical Database, http://simbad.u-strasbg.fr/simbad/
  This research has made use of the SIMBAD database, operated at CDS, Strasbourg, France
- HEASARC High Energy Astrophysics Science Archive Research Center, http://heasarc.gsfc.nasa.gov/
  We used several databases from HEASARC such as messier, mwsc, lbn, plnebulae, lmcextobj and smcclustrs.
- Harold Corwin's NGC/IC Positions and Notes, http://haroldcorwin.net/ngcic/index.html

Some common names are taken from internet sources like Wikipedia."""

# --- types, names and codes ------------------------------------------------------------------

NEBULA_TYPES = ("PN", "HII", "EmN", "RfN", "Neb", "SNR", "Cl+N", "DrkN")
TYPE_LABEL = {"PN": "Planetary nebula", "HII": "HII region", "EmN": "Emission nebula", "RfN": "Reflection nebula",
              "Neb": "Nebula", "SNR": "Supernova remnant", "Cl+N": "Cluster with nebula", "DrkN": "Dark nebula"}
# Types a Sharpless region may merge with by position (never PN), and those that may take a Russeil distance.
MERGE_TYPES = ("HII", "EmN", "Neb", "Cl+N", "RfN", "SNR", "DrkN")
RUSSEIL_TYPES = ("HII", "EmN", "Neb", "Cl+N")
SH2_FORM = {1: "circular", 2: "elliptical", 3: "irregular"}
SH2_STRUCT = {1: "amorphous", 2: "intermediate", 3: "filamentary"}
SH2_BRIGHT = {1: "faint", 2: "moderate", 3: "bright"}
SRC_SH2 = "Sharpless 1959 (VII/20)"

# Curated common names, by record id. Not a record field: the map is part of the build (section 17.3).
COMMON_NAMES = {
    "ongc:NGC1976": "Orion Nebula",
    "ongc:NGC6720": "Ring Nebula",
    "ongc:NGC1952": "Crab Nebula",
    "ongc:NGC6523": "Lagoon Nebula",
    "ongc:NGC7000": "North America Nebula",
    "ongc:NGC2237": "Rosette Nebula",
    "ongc:NGC2238": "Rosette Nebula (NGC 2238)",
    "ongc:B033": "Horsehead Nebula",
    "ongc:NGC7293": "Helix Nebula",
    "ongc:NGC6853": "Dumbbell Nebula",
    "ongc:NGC3372": "Carina Nebula",
    "ongc:NGC6514": "Trifid Nebula",
    "ongc:NGC6618": "Omega Nebula",
    "ongc:IC4703": "Eagle Nebula",
    "ongc:NGC6611": "Eagle Nebula Cluster (NGC 6611)",
    "ongc:C099": "Coalsack Nebula",
    "sh2:276": "Barnard's Loop",
}

# --- Russeil linking constants ---------------------------------------------------------------

LINK_MAX_DEG = 1.0        # a Sharpless centre must lie within this of the complex's (l, b)
JOIN_MAX_DEG = 0.05       # table1 `Name` (l+b) to table3 (GLON, GLAT)
SH2_REF = re.compile(r"S\s?(\d{1,3})(?!\d)")
COMPLEX_NAME = re.compile(r"^([+-]?\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)$")

# --- Shen et al. 2025 links and candidates (docs 19.4) ---------------------------------------

SHEN_MAX_MAJOR_ARCMIN = 120.0     # a record this large is a complex of many WISE regions: never linked
SHEN_SRC = "Shen et al. 2025, A&A 696, A67, table2"
SHEN_NAME = "Shen et al. 2025"
RUSSEIL_NAME = "Russeil 2003"
SHEN_LOW_PRECISION = "uncertainty below the table's 0.01 kpc precision"
SHEN_MASER_NOTE = ("VLBI maser parallax of the associated HMSFR, as adopted by Shen et al. 2025 (table2 gives no "
                   "per-row reference; §3.2: primarily Reid et al. 2019)")
SHEN_M22_NOTE = " (value from Méndez-Delgado et al. 2022, Gaia DR3)"
MAX_ALT = objects.MAX_ALT_DISTANCES

# --- Chornay & Walton cuts -------------------------------------------------------------------

PN_REL_MIN = 0.9
PN_SNR_MIN = 5.0
PN_RUWE_MAX = 1.4
PN_G = re.compile(r"PN G(\d{3}\.\d[+-]\d+\.\d)")
SH2_IDENT = re.compile(r"\bSH\s?2-(\d+)\b", re.IGNORECASE)


# --- value helpers ---------------------------------------------------------------------------

def _d(s: str | None) -> Decimal | None:
    s = (s or "").strip()
    if not s:
        return None
    try:
        d = Decimal(s)
    except InvalidOperation:
        return None
    return d if d.is_finite() else None


def _num(x: Decimal | float | int, sig: int = 12) -> float | int:
    """A JSON number with `sig` significant digits; whole numbers become ints."""
    if isinstance(x, int):
        return x
    f = float(format(x, f".{sig}g")) if isinstance(x, Decimal) else float(f"{x:.{sig}g}")
    return int(f) if f.is_integer() and abs(f) < 1e15 else f


def sexagesimal(s: str, *, hours: bool) -> float | None:
    """`hh:mm:ss.s` or `+dd:mm:ss.s` as degrees, rounded to 7 decimals (exact decimal arithmetic)."""
    m = re.fullmatch(r"\s*([+-]?)(\d+):(\d+):(\d+(?:\.\d+)?)\s*", s or "")
    if not m:
        return None
    sign, a, b, c = m.groups()
    v = Decimal(a) + Decimal(b) / 60 + Decimal(c) / 3600
    if hours:
        v *= 15
    v = v.quantize(Decimal("1e-7"), rounding=ROUND_HALF_EVEN)
    return float(-v if sign == "-" else v)


def messier(row: dict) -> str | None:
    """`M 42` from the `M` column (`042`), or None."""
    m = re.match(r"\d+", row["M"].strip())
    return f"M {int(m.group())}" if m else None


def fmt_designation(name: str) -> str:
    """`NGC1976` -> `NGC 1976`, `IC0410` -> `IC 410`, `C009` -> `C 9`, `NGC1530A` -> `NGC 1530A`."""
    m = re.fullmatch(r"([A-Za-z]+)0*(\d+)(.*)", name.strip())
    return f"{m.group(1)} {m.group(2)}{m.group(3)}" if m else name.strip()


def _pad_number(s: str) -> str | None:
    m = re.fullmatch(r"(\d+)(.*)", s.strip())
    return f"{int(m.group(1)):04d}{m.group(2)}" if m else None


# --- parsing ---------------------------------------------------------------------------------

def parse_ongc(data: bytes) -> list[dict]:
    """Rows of an OpenNGC csv (`;` separated; some quoted fields hold `;`). Raises SystemExit on a bad header."""
    reader = csv.reader(io.StringIO(data.decode("utf-8"), newline=""), delimiter=";")
    header = next(reader, None)
    if header is None or tuple(header) != ONGC_COLUMNS:
        raise SystemExit(f"unexpected OpenNGC header: {header!r}")
    rows = []
    for cells in reader:
        if not cells:
            continue
        if len(cells) != len(header):
            raise SystemExit(f"OpenNGC row with {len(cells)} fields, expected {len(header)}: {cells[:3]!r}")
        rows.append(dict(zip(header, cells)))
    return rows


def strip_comments(raw: bytes) -> bytes:
    """A VizieR download without its `#` comment lines and its empty lines (they carry the request date)."""
    return b"".join(line for line in raw.splitlines(keepends=True)
                    if not line.startswith(b"#") and line.strip(b"\r\n") != b"")


def parse_vizier(data: bytes) -> list[dict]:
    """Rows of a VizieR ASU-TSV table: header, units and dashes lines, then the rows. Cells are stripped.
    Raises SystemExit on a truncated or malformed table."""
    lines = strip_comments(data).decode("utf-8").splitlines()
    if len(lines) < 3 or not lines[2].lstrip().startswith("-"):
        raise SystemExit("the table does not have header, units and dashes lines")
    header = [h.strip() for h in lines[0].split("\t")]
    rows = []
    for line in lines[3:]:
        cells = line.split("\t")
        if len(cells) != len(header):
            raise SystemExit(f"truncated or malformed row: {line[:80]!r}")
        rows.append({k: v.strip() for k, v in zip(header, cells)})
    return rows


def b1900_to_icrs(rows: list[tuple[str, str]]) -> list[tuple[float, float, float, float]]:
    """(ra, dec, l, b) in degrees for B1900 FK4 `("h m s", "+d m s")` strings: astropy
    `FK4(equinox='B1900', obstime='B1900')` -> ICRS, plus the Galactic coordinates of the result."""
    import astropy.units as u
    from astropy.coordinates import FK4, SkyCoord

    def hms(s: str) -> float:
        h, m, sec = s.split()
        return (float(h) + float(m) / 60 + float(sec) / 3600) * 15.0

    def dms(s: str) -> float:
        sign = -1.0 if s.strip().startswith("-") else 1.0
        d, m, sec = s.strip().lstrip("+-").split()
        return sign * (float(d) + float(m) / 60 + float(sec) / 3600)

    c = SkyCoord(ra=[hms(r) for r, _ in rows] * u.deg, dec=[dms(d) for _, d in rows] * u.deg,
                 frame=FK4(equinox="B1900", obstime="B1900")).icrs
    g = c.galactic
    return [(float(a), float(b), float(l), float(bb)) for a, b, l, bb in zip(c.ra.deg, c.dec.deg, g.l.deg, g.b.deg)]


# --- OpenNGC nebulae -------------------------------------------------------------------------

def read_nebulae(ongc_rows: list[dict]) -> tuple[list[dict], dict]:
    """The nebula rows (types NEBULA_TYPES) as dicts, with Dup designations folded in, and a report.

    A `Dup` row names its master in the NGC column, else in the IC column. When the master is a kept
    nebula, the Dup's own name joins the master's `dups` list."""
    by_name: dict[str, dict] = {}
    for r in ongc_rows:      # the addendum follows NGC.csv; the first row of a name wins
        by_name.setdefault(r["Name"], r)
    types = Counter(r["Type"] for r in ongc_rows)
    kept, no_position = [], []
    for r in ongc_rows:
        if r["Type"] not in NEBULA_TYPES:
            continue
        ra, dec = sexagesimal(r["RA"], hours=True), sexagesimal(r["Dec"], hours=False)
        if ra is None or dec is None or not 0 <= ra < 360:
            no_position.append(r["Name"])
            continue
        kept.append({"name": r["Name"], "type": r["Type"], "ra": ra, "dec": dec, "row": r, "dups": [],
                     "maj": _d(r["MajAx"]), "min": _d(r["MinAx"]), "pa": _d(r["PosAng"])})
    index = {k["name"]: k for k in kept}
    folded, unresolved = 0, []
    for r in ongc_rows:
        if r["Type"] != "Dup":
            continue
        master = None
        for col, prefix in (("NGC", "NGC"), ("IC", "IC")):
            num = _pad_number(r[col]) if r[col].strip() else None
            if num:
                master = prefix + num
                break
        if master is None:
            unresolved.append(r["Name"])
        elif master in index:
            index[master]["dups"].append(r["Name"])
            folded += 1
    report = {"rows_read": len(ongc_rows), "rows_by_type": dict(sorted(types.items())),
              "kept_by_type": dict(sorted(Counter(k["type"] for k in kept).items())), "nebula_rows": len(kept),
              "excluded": {"Dup": types.get("Dup", 0), "NonEx": types.get("NonEx", 0)},
              "dup_designations_folded": folded, "dups_without_master": sorted(unresolved),
              "nebulae_without_position": sorted(no_position)}
    return kept, report


# --- Sharpless -------------------------------------------------------------------------------

def read_sharpless(rows: list[dict]) -> list[dict]:
    """Sharpless regions with their ICRS centre (B1900 FK4 precessed) and Galactic coordinates."""
    pos = b1900_to_icrs([(r["RA1900"], r["DE1900"]) for r in rows])
    out = []
    for r, (ra, dec, l, b) in zip(rows, pos):
        code = lambda k: int(r[k]) if r[k].strip().isdigit() else None  # noqa: E731
        out.append({"n": int(r["Sh2"]), "ra": round(ra % 360.0, 6), "dec": round(dec, 6), "_ra": ra, "_dec": dec,
                    "l": l, "b": b, "diam": _d(r["Diam"]), "form": code("Form"), "struct": code("Struct"),
                    "bright": code("Bright")})
    return out


def read_overrides(data: list) -> tuple[dict[int, dict], dict[int, str]]:
    """The override table: `{sh2: entry}` for merge overrides (`ongc` present; null forbids a merge) and
    `{sh2: complex}` for Russeil link overrides (`russeil_complex`). An entry may carry either or both."""
    merge: dict[int, dict] = {}
    links: dict[int, str] = {}
    for e in data:
        if not isinstance(e, dict) or not isinstance(e.get("sh2"), int) or not str(e.get("reason", "")).strip():
            raise SystemExit(f"bad override entry (needs integer sh2 and a reason): {e!r}")
        if "ongc" in e:
            if e["ongc"] is not None and not isinstance(e["ongc"], str):
                raise SystemExit(f"bad override ongc: {e!r}")
            merge[e["sh2"]] = e
        if "russeil_complex" in e:
            links[e["sh2"]] = e["russeil_complex"]
    return merge, links


def merge_regions(neb: list[dict], sh2: list[dict], overrides: dict[int, dict]) -> tuple[dict[int, dict], dict]:
    """Merge Sharpless regions onto OpenNGC nebulae (docs/object-framework.md 17.3).

    Steps, in order, each OpenNGC row claimed at most once:
    1. identifier: the row's `Identifiers` has `SH 2-<n>`;
    2. overrides: `{sh2, ongc | null}`; null forbids any merge of the region;
    3. positional: candidates of MERGE_TYPES within min(40', max(10', Diam/3, 0.6 MajAx)); a candidate is dropped
       when Diam >= 10 max(MajAx, 1') and the separation is over 10'; score = separation / max(MajAx, 1'),
       lowest first. Pairs are taken in score order, so on a conflict the best score keeps the nebula and the
       others fall back to their next candidate.

    Returns `{sh2 number: pair}` (pair has `ongc`, `rule`, `sep_arcmin`, `score`) and a report."""
    by_name = {n["name"]: n for n in neb}
    regions = {s["n"]: s for s in sh2}
    forbidden = {n for n, e in overrides.items() if e["ongc"] is None}
    pairs: dict[int, dict] = {}
    claimed: dict[str, int] = {}

    def sep_arcmin(s: dict, n: dict) -> float:
        return objects.angsep_deg(s["_ra"], s["_dec"], n["ra"], n["dec"]) * 60.0

    def claim(n: int, name: str, rule: str) -> None:
        s = regions[n]
        pairs[n] = {"sh2": n, "ongc": name, "rule": rule, "sep_arcmin": round(sep_arcmin(s, by_name[name]), 2)}
        claimed[name] = n

    # 1. identifier
    for n in sorted(regions):
        if n in forbidden:
            continue
        for cand in neb:
            if cand["name"] in claimed:
                continue
            ids = {int(m) for m in SH2_IDENT.findall(cand["row"]["Identifiers"])}
            if n in ids:
                claim(n, cand["name"], "identifier")
                break
    # 2. overrides
    for n in sorted(overrides):
        e = overrides[n]
        if e["ongc"] is None:
            continue
        if n not in regions:
            raise SystemExit(f"override for Sh2-{n}: no such Sharpless region")
        if e["ongc"] not in by_name:
            raise SystemExit(f"override for Sh2-{n}: {e['ongc']} is not a kept OpenNGC nebula")
        if n in pairs:
            if pairs[n]["ongc"] != e["ongc"]:
                raise SystemExit(f"override for Sh2-{n} ({e['ongc']}) disagrees with its identifier match "
                                 f"({pairs[n]['ongc']})")
            continue
        if e["ongc"] in claimed:
            raise SystemExit(f"override for Sh2-{n}: {e['ongc']} is already claimed by Sh2-{claimed[e['ongc']]}")
        claim(n, e["ongc"], "override")
    # 3. positional
    cands = []
    for n, s in regions.items():
        if n in pairs or n in forbidden:
            continue
        diam = float(s["diam"]) if s["diam"] is not None else 0.0
        for cand in neb:
            if cand["type"] not in MERGE_TYPES or cand["name"] in claimed:
                continue
            maj = float(cand["maj"]) if cand["maj"] is not None else 0.0
            sep = sep_arcmin(s, cand)
            if sep > min(40.0, max(10.0, diam / 3.0, 0.6 * maj)):
                continue
            if diam >= 10.0 * max(maj, 1.0) and sep > 10.0:
                continue
            cands.append((sep / max(maj, 1.0), n, cand["name"], sep))
    for score, n, name, sep in sorted(cands):
        if n in pairs or name in claimed:
            continue
        pairs[n] = {"sh2": n, "ongc": name, "rule": "positional", "sep_arcmin": round(sep, 2),
                    "score": round(score, 4)}
        claimed[name] = n
    by_rule = Counter(p["rule"] for p in pairs.values())
    report = {"by_rule": {k: by_rule.get(k, 0) for k in ("identifier", "override", "positional")},
              "merged_pairs": [pairs[n] for n in sorted(pairs)],
              "forbidden_by_override": sorted(forbidden)}
    return pairs, report


# --- planetary nebula distances (Chornay & Walton 2021) --------------------------------------

def png_ids(row: dict) -> list[str]:
    return sorted(set(PN_G.findall(row.get("Identifiers", ""))))


def _f(s: str | None) -> float | None:
    d = _d(s)
    return None if d is None else float(d)


def pn_distance(nrow: dict, chornay_by_png: dict[str, list[dict]]) -> tuple[dict | None, str]:
    """The Chornay & Walton match of an OpenNGC PN row that passes every cut, with the reason when none does.

    Returns (match, reason): match is `{plx, e_plx, rel, ruwe, gaia, png}` or None; reason is one of
    "ok", "no PN G id", "not in Chornay", "Rel", "S/N", "RUWE". The reason names the first cut that fails
    for every candidate, in the order Rel, S/N, RUWE."""
    ids = png_ids(nrow)
    if not ids:
        return None, "no PN G id"
    matches = [c for g in ids for c in chornay_by_png.get(g, [])]
    if not matches:
        return None, "not in Chornay"
    best_reason = "RUWE"
    order = {"Rel": 0, "S/N": 1, "RUWE": 2}
    passing = []
    for c in matches:
        rel, plx, e, ruwe = _f(c["Rel"]), _f(c["plx"]), _f(c["e_plx"]), _f(c["RUWE"])
        if rel is None or rel < PN_REL_MIN:
            why = "Rel"
        elif plx is None or e is None or e <= 0 or plx / e < PN_SNR_MIN:
            why = "S/N"
        elif ruwe is None or ruwe >= PN_RUWE_MAX:
            why = "RUWE"
        else:
            passing.append({"plx": plx, "e_plx": e, "rel": rel, "ruwe": ruwe, "gaia": c["GaiaEDR3"].strip(),
                            "png": c["PNG"].strip(), "raw": c})
            continue
        if order[why] < order[best_reason]:
            best_reason = why
    if not passing:
        return None, best_reason
    passing.sort(key=lambda m: (-m["rel"], m["e_plx"]))
    return passing[0], "ok"


def pn_dist_quantity(m: dict) -> dict:
    plx, e = m["plx"], m["e_plx"]
    src = (f"Chornay & Walton 2021, A&A 656, A110, tablea1: central star Gaia EDR3 {m['gaia']}, "
           f"plx {m['raw']['plx'].strip()} ± {e:.4g} mas (no zero-point correction)")
    return objects.quantity(round(1000.0 / plx, 2), src, "measured", "pc",
                            round(1000.0 / (plx + e), 2), round(1000.0 / (plx - e), 2))


# --- HII region distances (Russeil 2003) -----------------------------------------------------

def russeil_links(table1: list[dict], table3: list[dict], regions: dict[int, dict], link_overrides: dict[int, str]
                  ) -> tuple[dict[int, dict], dict]:
    """Stellar distances of Sharpless regions from Russeil 2003.

    `table1.HaName` names Sharpless regions `S<n>`; `table1.Name` (`l+b`) joins `table3` numerically (GLON,
    GLAT) to within JOIN_MAX_DEG. A link (Sharpless number, complex) is kept only when the Sharpless centre
    is within LINK_MAX_DEG of the complex's (l, b), or when the override table names that complex for the
    region. Only `DistSt` is used (never the kinematic `Dist`). Returns `{sh2: link}` for the nearest
    kept complex that has a stellar distance, and a report."""
    t3 = []
    for r in table3:
        l, b = _f(r["GLON"]), _f(r["GLAT"])
        if l is not None and b is not None:
            t3.append((l, b, r))

    def join(name: str):
        m = COMPLEX_NAME.match(name.strip())
        if not m:
            return None
        l0, b0 = float(m.group(1)), float(m.group(2))
        best = None
        for l, b, r in t3:
            dl = abs((l0 - l + 180.0) % 360.0 - 180.0)
            d = max(dl, abs(b0 - b))
            if d <= JOIN_MAX_DEG and (best is None or d < best[0]):
                best = (d, r)
        return best[1] if best else None

    refs: dict[int, set[str]] = defaultdict(set)
    for r in table1:
        for n in {int(x) for x in SH2_REF.findall(r["HaName"])}:
            refs[n].add(r["Name"].strip())
    joined: dict[str, dict | None] = {}
    candidates: dict[int, list[dict]] = defaultdict(list)
    dropped, accepted_by_override, total = [], [], 0
    unknown_numbers = sorted(n for n in refs if n not in regions)
    for n in sorted(refs):
        if n not in regions:
            continue
        for name in sorted(refs[n]):
            if name not in joined:
                joined[name] = join(name)
            r3 = joined[name]
            if r3 is None:
                continue
            total += 1
            s = regions[n]
            sep = objects.angsep_deg(s["l"], s["b"], float(r3["GLON"]), float(r3["GLAT"]))
            link = {"sh2": n, "complex": name, "seq": int(r3["Seq"]), "sep_deg": round(sep, 3), "row": r3}
            if sep <= LINK_MAX_DEG:
                candidates[n].append(link)
            elif link_overrides.get(n) == name:
                link["override"] = True
                candidates[n].append(link)
                accepted_by_override.append({k: v for k, v in link.items() if k != "row"})
            else:
                dropped.append({k: v for k, v in link.items() if k != "row"})
    best: dict[int, dict] = {}
    for n, links in candidates.items():
        with_dist = [k for k in links if _d(k["row"]["DistSt"]) is not None]
        if with_dist:
            best[n] = min(with_dist, key=lambda k: (k["sep_deg"], k["complex"]))
    missing = sorted(n for n, name in link_overrides.items()
                     if not any(k["complex"] == name for k in candidates.get(n, [])))
    if missing:
        raise SystemExit(f"Russeil link override(s) for Sh2-{missing} match no table1/table3 link")
    report = {"table1_rows": len(table1), "table3_rows": len(table3), "sharpless_numbers_named": len(refs),
              "sharpless_numbers_not_in_catalogue": unknown_numbers, "links": total,
              "links_dropped_by_1deg_filter": len(dropped), "dropped": dropped,
              "links_accepted_by_override": accepted_by_override,
              "regions_linked": len(candidates), "regions_with_stellar_distance": len(best)}
    return best, report


def russeil_quantity(link: dict) -> dict:
    r3 = link["row"]
    v = _d(r3["DistSt"]) * 1000
    e = _d(r3["e_DistSt"])
    note = " (photometric data only)" if r3["n_DistSt"].strip() == ")" else ""
    src = (f"Russeil 2003, A&A 397, 133, table3: stellar distance of complex {link['complex']} "
           f"(Sh2-{link['sh2']}){note}")
    lo = hi = None
    if e is not None and e > 0:
        lo, hi = max(v - e * 1000, Decimal(0)), v + e * 1000
    return objects.quantity(_num(v, 8), src, "inferred", "pc", None if lo is None else _num(lo, 8),
                            None if hi is None else _num(hi, 8))


# --- HII region distances (Shen et al. 2025) -------------------------------------------------

def read_shen(rows: list[dict], star_rows: list[dict]) -> tuple[list[dict], dict]:
    """The usable rows of table2 as dicts (distances in pc), and a report. `tablea1` only counts the exciting stars
    of each region (the build does not use their values). A row without a distance or a position is skipped."""
    stars = Counter(r["WISE"] for r in star_rows)
    out, skipped = [], []
    for r in rows:
        dist, ra, dec, rad = _d(r["Dist"]), _d(r["_RA"]), _d(r["_DE"]), _d(r["R"])
        if dist is None or ra is None or dec is None:
            skipped.append(r["WISE"])
            continue
        e_lo, e_hi = _d(r["e_Dist"]), _d(r["E_Dist"])
        remarks = {x.strip() for x in r["Remarks"].split(",") if x.strip()}
        if e_lo is None and e_hi is None or (e_lo == 0 and e_hi == 0):
            lo = hi = None            # an error below the table's precision (or none given): no interval
        else:
            lo = max(dist - (e_lo or 0), Decimal(0)) * 1000
            hi = (dist + (e_hi or 0)) * 1000
        out.append({"wise": r["WISE"], "ra": float(ra), "dec": float(dec), "radius_arcsec": float(rad or 0),
                    "dist": dist * 1000, "lo": lo, "hi": hi, "group": r["Group"].strip(),
                    "remarks": sorted(remarks), "maser": "maser" in remarks, "m22": "M22" in remarks,
                    "stars": stars.get(r["WISE"], 0), "cl": r["Cl"]})
    return out, {"table2_rows": len(rows), "tablea1_rows": len(star_rows), "usable_rows": len(out),
                 "skipped_rows": skipped}


def read_shen_overrides(data: list, shen: list[dict], records: dict[str, dict]) -> dict[str, str | None]:
    """`{record id: WISE name or None}` from `[{nebula, wise | null, reason}]`; unknown names are an error."""
    names = {s["wise"] for s in shen}
    out: dict[str, str | None] = {}
    for e in data:
        if set(e) != {"nebula", "wise", "reason"} or not e["reason"]:
            raise SystemExit(f"{SHEN_OVERRIDES_FILE}: entries are {{nebula, wise|null, reason}}, got {e!r}")
        if e["nebula"] not in records:
            raise SystemExit(f"{SHEN_OVERRIDES_FILE}: no nebula record {e['nebula']!r}")
        if e["wise"] is not None and e["wise"] not in names:
            raise SystemExit(f"{SHEN_OVERRIDES_FILE}: no Shen region {e['wise']!r}")
        if e["nebula"] in out:
            raise SystemExit(f"{SHEN_OVERRIDES_FILE}: {e['nebula']} twice")
        out[e["nebula"]] = e["wise"]
    return out


def shen_candidates(rec: dict, shen: list[dict]) -> list[dict]:
    """Shen regions near a record by the link rule: centre separation s <= max(r_N, R_W) (arcmin), best first by
    s / max(r_N, R_W), then s, then WISE name. Each is `{shen, sep, score}`."""
    r_n = rec["major"] / 2.0 if rec["major"] else 0.0
    out = []
    for w in shen:
        scale = max(r_n, w["radius_arcsec"] / 60.0)
        if scale <= 0:
            continue
        s = objects.angsep_deg(rec["ra"], rec["dec"], w["ra"], w["dec"]) * 60.0
        if s <= scale:
            out.append({"shen": w, "sep": s, "score": s / scale})
    out.sort(key=lambda c: (c["score"], c["sep"], c["shen"]["wise"]))
    return out


def shen_quantity(w: dict) -> dict:
    """The distance Quantity of a Shen row: src shapes are parsed by the frontend (docs 19.4.3)."""
    head = f"{SHEN_SRC}: {w['wise']} (Group {w['group']}): "
    if w["maser"]:
        src = head + SHEN_MASER_NOTE
    elif w["group"] == "I":
        src = head + "mean Gaia DR3 (Bailer-Jones et al. 2021) distance of its exciting stars"
    else:
        src = head + "Gaia DR3 (Bailer-Jones et al. 2021) distance of its exciting star"
    if w["m22"] and not w["maser"]:
        src += SHEN_M22_NOTE
    if w["lo"] is None:
        src += f"; {SHEN_LOW_PRECISION}"
    tier = "measured" if w["maser"] or w["group"] == "I" else "inferred"
    return objects.quantity(_num(w["dist"], 8), src, tier, "pc",
                            None if w["lo"] is None else _num(w["lo"], 8),
                            None if w["hi"] is None else _num(w["hi"], 8))


def candidate(cat: str, method: str, q: dict) -> dict:
    """A distance candidate for the ladder: `cls` 0 measured, 1 derived; `frac` the fractional uncertainty or None."""
    v = q["v"]
    frac = None
    if q.get("lo") is not None and q.get("hi") is not None and v:
        frac = max(v - q["lo"], q["hi"] - v) / v
    return {"cat": cat, "method": method, "q": q, "cls": 0 if q["tier"] == "measured" else 1, "frac": frac}


CAT_ORDER = {"pn": 0, "shen": 1, "russeil": 2}
CAT_NAME = {"pn": "Chornay & Walton 2021", "shen": SHEN_NAME, "russeil": RUSSEIL_NAME}


def rank_key(c: dict):
    return (c["cls"], 0 if c["frac"] is not None else 1, c["frac"] or 0.0, CAT_ORDER[c["cat"]])


def why_not(c: dict, chosen: dict) -> str:
    name = CAT_NAME[chosen["cat"]]
    if c["cls"] > chosen["cls"]:
        return "not used: a derived distance; a measured one exists"
    if c["frac"] is None and chosen["frac"] is not None:
        return f"not used: no published uncertainty, the {name} distance has one"
    if c["frac"] is not None and chosen["frac"] is not None and c["frac"] > chosen["frac"]:
        return f"not used: larger uncertainty than the {name} distance"
    return f"not used: ranked below the {name} distance (catalogue order)"


def choose(cands: list[dict]) -> tuple[dict | None, list[dict]]:
    """The adopted candidate and the `alt_distances` entries (docs 18.4.2, applied to nebulae in 19.4.3)."""
    if not cands:
        return None, []
    cs = sorted(cands, key=rank_key)
    return cs[0], [{"method": c["method"], "dist": c["q"], "reason": why_not(c, cs[0])} for c in cs[1:1 + MAX_ALT]]


# --- records ---------------------------------------------------------------------------------

def provenance() -> dict:
    return {"source": f"static:{DATASET}", "dataset": DATASET, "catalogue": CATALOGUE, "version": VERSION}


def _angular(major: Decimal | None, minor: Decimal | None, pa: Decimal | None, src: str) -> dict | None:
    if major is None:
        return None
    return {"major": objects.quantity(_num(major, 8), src, "catalogue", "arcmin"),
            "minor": None if minor is None else objects.quantity(_num(minor, 8), src, "catalogue", "arcmin"),
            "pa": None if pa is None else objects.quantity(_num(pa, 8), src, "catalogue", "deg")}


def size_for(n: dict | None, s: dict | None) -> dict | None:
    """The angular size: OpenNGC's major, minor and PA when MajAx >= Diam/3 (or there is no Sharpless
    region), else the Sharpless diameter as a circle (docs/object-framework.md 17.3)."""
    if n is not None and n["maj"] is not None and (s is None or s["diam"] is None or n["maj"] >= s["diam"] / 3):
        return _angular(n["maj"], n["min"], n["pa"], SRC_ONGC)
    if s is not None and s["diam"] is not None:
        return _angular(s["diam"], None, None, f"{SRC_SH2}, maximum diameter (shown as a circle)")
    return None


def sh2_props(s: dict) -> dict[str, dict]:
    props = {}
    for key, col, words in (("sh2_form", "form", SH2_FORM), ("sh2_struct", "struct", SH2_STRUCT),
                            ("sh2_bright", "bright", SH2_BRIGHT)):
        code = s[col]
        if code in words:
            props[key] = objects.quantity(words[code], f"{SRC_SH2} {col.capitalize()} {code}", "catalogue")
    return props


def designations_for(n: dict | None, s: dict | None, name: str) -> list[str]:
    out: list[str] = []
    row = n["row"] if n else None

    def add(x: str) -> None:
        x = x.strip()
        if x and x != name and x not in out:
            out.append(x)

    if row is not None:
        if messier(row):
            add(messier(row))
        add(fmt_designation(n["name"]))
        for col, prefix in (("NGC", "NGC"), ("IC", "IC")):
            if row[col].strip() and n["type"] != "Dup":
                add(fmt_designation(prefix + (_pad_number(row[col]) or row[col])))
    if s is not None:
        add(f"Sh2-{s['n']}")
    if n is not None:
        for d in n["dups"]:
            add(fmt_designation(d))
        idents = []
        for i in row["Identifiers"].split(","):
            i = i.strip()
            if not i:
                continue
            m = SH2_IDENT.fullmatch(i)
            idents.append(f"Sh2-{m.group(1)}" if m else i)
        rank = lambda i: 0 if i.startswith(("LBN", "PN G")) else 1 if i.startswith("MWSC") else 2  # noqa: E731
        for i in sorted(idents, key=rank):
            add(i)
        for c in row["Common names"].split(","):
            add(c)
    return out


def display_name(n: dict | None, s: dict | None, rid: str) -> str:
    """The curated common name, else OpenNGC's first common name, else `M 57`, else `NGC 6720` or `Sh2-155`."""
    if rid in COMMON_NAMES:
        return COMMON_NAMES[rid]
    if n is not None:
        first = next((c.strip() for c in n["row"]["Common names"].split(",") if c.strip()), "")
        if first:
            return first
        if messier(n["row"]):
            return messier(n["row"])
        return fmt_designation(n["name"])
    return f"Sh2-{s['n']}"


def record_id(n: dict | None, s: dict | None) -> str:
    return f"ongc:{n['name']}" if n else f"sh2:{s['n']}"


def nebula_record(n: dict | None, s: dict | None, pn: dict | None, russeil: dict | None, shen: dict | None = None,
                  chosen_out: dict | None = None) -> dict:
    """One `nebula` record. `n` is the OpenNGC row (or None), `s` the Sharpless region (or None), `pn` a passing
    Chornay match, `russeil` a Russeil link with a stellar distance and `shen` a linked Shen row (both already
    restricted to the types that may take them). A PN takes its parallax; otherwise the ladder chooses between the
    Shen and Russeil distances and the loser goes to `alt_distances`. `chosen_out` receives the chosen candidate."""
    rid = record_id(n, s)
    ra, dec = (n["ra"], n["dec"]) if n else (s["ra"], s["dec"])
    name = display_name(n, s, rid)

    size_ang = size_for(n, s)
    dist, method, evidence, alts = None, None, "measured", []
    if pn is not None:
        dist, method, evidence = pn_dist_quantity(pn), "parallax", "measured"
    else:
        cands = []
        if shen is not None:
            cands.append(candidate("shen", "parallax" if shen["maser"] else "bailer-jones", shen_quantity(shen)))
        if russeil is not None:
            cands.append(candidate("russeil", "photometric", russeil_quantity(russeil)))
        best, alts = choose(cands)
        if best is not None:
            dist, method = best["q"], best["method"]
            evidence = "measured" if best["cls"] == 0 else "derived"
        if chosen_out is not None:
            chosen_out["best"], chosen_out["alts"], chosen_out["cands"] = best, alts, cands
    position: dict = {"model": "fixed", "ra": _num(ra, 12), "dec": _num(dec, 12), "epoch": 2000.0,
                      "tier": "catalogue", "dist": dist}
    if method:
        position["method"] = method

    radius = None
    if dist is not None and size_ang is not None:
        half = math.radians(float(size_ang["major"]["v"]) / 60.0 / 2.0)
        radius = objects.quantity(_num(dist["v"] * math.tan(half), 4), "from angular size and distance",
                                  "inferred", "pc")
    size = None if radius is None and size_ang is None else {"radius": radius, "angular": size_ang}

    props: dict[str, dict] = {}
    if n is not None:
        props["type"] = objects.quantity(TYPE_LABEL[n["type"]], f"{SRC_ONGC} ({n['type']})", "catalogue")
        for key, col in (("vmag", "V-Mag"), ("bmag", "B-Mag")):
            v = _d(n["row"][col])
            if v is not None:
                props[key] = objects.quantity(_num(v, 8), SRC_ONGC, "catalogue", "mag")
    else:
        props["type"] = objects.quantity("HII region", SRC_SH2, "catalogue")
    if s is not None:
        props.update(sh2_props(s))
    if pn is not None:
        props["central_star"] = objects.quantity(
            f"Gaia EDR3 {pn['gaia']}", f"Chornay & Walton 2021 (Rel {pn['rel']:.5g}, RUWE {pn['ruwe']:.3g})",
            "catalogue")

    render: dict = {}
    if n is not None:
        mag = _d(n["row"]["V-Mag"]) or _d(n["row"]["B-Mag"])
        if mag is not None:
            render["mag"] = _num(mag, 8)
    rec = objects.record(id=rid, kind="nebula", name=name, designations=designations_for(n, s, name),
                         position=position, size=size, props=props, provenance=provenance(), evidence=evidence,
                         render=render)
    if alts:
        rec["alt_distances"] = alts
    return rec


def build_records(inputs: dict, overrides: list, shen_overrides: list | None = None) -> tuple[list[dict], dict]:
    """Records and the build report from parsed inputs: `ongc` (NGC.csv + addendum rows), `sharpless`, `chornay`,
    `russeil1`, `russeil3`, `shen2` and `shen_a1` (lists of row dicts), the merge override table and the Shen link
    override table (lists)."""
    neb, report = read_nebulae(inputs["ongc"])
    sh2 = read_sharpless(inputs["sharpless"])
    regions = {s["n"]: s for s in sh2}
    merge_ov, link_ov = read_overrides(overrides)
    pairs, merge_report = merge_regions(neb, sh2, merge_ov)
    merged_of = {p["ongc"]: p["sh2"] for p in pairs.values()}
    links, russeil_report = russeil_links(inputs["russeil1"], inputs["russeil3"], regions, link_ov)

    chornay_by_png: dict[str, list[dict]] = defaultdict(list)
    for c in inputs["chornay"]:
        chornay_by_png[c["PNG"].strip()].append(c)
    shen, shen_read = read_shen(inputs.get("shen2", []), inputs.get("shen_a1", []))
    shen_by_wise = {w["wise"]: w for w in shen}

    # one pass to fix each record's inputs, then the Shen links, then the records
    items = []
    pn_report = Counter()
    for n in neb:
        s = regions.get(merged_of.get(n["name"]))
        pn = None
        if n["type"] == "PN":
            pn_report["rows"] += 1
            pn, why = pn_distance(n["row"], chornay_by_png)
            pn_report[{"ok": "pass", "no PN G id": "no_png_id", "not in Chornay": "not_in_chornay",
                       "Rel": "fail_rel", "S/N": "fail_snr", "RUWE": "fail_ruwe"}[why]] += 1
        ru = links.get(s["n"]) if pn is None and s is not None and n["type"] in RUSSEIL_TYPES else None
        items.append({"n": n, "s": s, "pn": pn, "ru": ru, "eligible": n["type"] in RUSSEIL_TYPES})
    sharpless_only = [s for s in sh2 if s["n"] not in pairs]
    for s in sharpless_only:
        items.append({"n": None, "s": s, "pn": None, "ru": links.get(s["n"]), "eligible": True})
    for it in items:
        it["id"] = record_id(it["n"], it["s"])
        ang = size_for(it["n"], it["s"])
        it["major"] = float(ang["major"]["v"]) if ang else None
        it["ra"], it["dec"] = (it["n"]["ra"], it["n"]["dec"]) if it["n"] else (it["s"]["ra"], it["s"]["dec"])
    shen_ov = read_shen_overrides(shen_overrides or [], shen, {it["id"]: it for it in items})

    records, link_rows, outcomes = [], [], []
    excluded_big, no_shen_row = [], 0
    for it in items:
        sh_link, rule, cand_list = None, None, []
        if it["id"] in shen_ov:
            wise = shen_ov[it["id"]]
            if wise is not None:
                w = shen_by_wise[wise]
                cand_list = shen_candidates(it, shen)
                sh = next((c for c in cand_list if c["shen"]["wise"] == wise), None)
                sep = objects.angsep_deg(it["ra"], it["dec"], w["ra"], w["dec"]) * 60.0
                sh_link = sh or {"shen": w, "sep": sep, "score": None}
                rule = "override"
        elif it["eligible"] and it["pn"] is None:
            if it["major"] is not None and it["major"] >= SHEN_MAX_MAJOR_ARCMIN:
                excluded_big.append(it["id"])
            else:
                cand_list = shen_candidates(it, shen)
                if cand_list:
                    sh_link, rule = cand_list[0], "rule"
        out = {}
        rec = nebula_record(it["n"], it["s"], it["pn"], it["ru"], sh_link["shen"] if sh_link else None, out)
        records.append(rec)
        best = out.get("best")
        if sh_link is not None:
            w = sh_link["shen"]
            ru_q = next((c["q"] for c in out["cands"] if c["cat"] == "russeil"), None)
            new = best["q"]["v"] if best else None
            link_rows.append({
                "id": it["id"], "name": rec["name"], "wise": w["wise"], "group": w["group"],
                "remarks": w["remarks"], "rule": rule,
                "score": None if sh_link["score"] is None else round(sh_link["score"], 4),
                "sep_arcmin": round(sh_link["sep"], 3), "shen_pc": _num(w["dist"], 8),
                "other_candidates": [{"wise": c["shen"]["wise"], "group": c["shen"]["group"],
                                      "dist_pc": _num(c["shen"]["dist"], 8), "sep_arcmin": round(c["sep"], 3),
                                      "score": round(c["score"], 4)}
                                     for c in cand_list if c["shen"]["wise"] != w["wise"]],
                "old_pc": None if ru_q is None else ru_q["v"], "new_pc": new,
                "winner": best["cat"] if best else None})
        outcomes.append((it, sh_link, best, out))

    # counts
    adopted = [l for l in link_rows if l["winner"] == "shen"]
    by_group = Counter(l["group"] for l in adopted)
    by_remark = Counter(",".join(l["remarks"]) or "(blank)" for l in adopted)
    replaced = [l for l in adopted if l["old_pc"] is not None]
    placed = [l for l in adopted if l["old_pc"] is None]
    kept_reasons = Counter()
    for it, sh_link, best, out in outcomes:
        if best is None or best["cat"] != "russeil":
            continue
        if sh_link is not None:
            kept_reasons["Shen row linked, lost on the ladder: " + out["alts"][0]["reason"].removeprefix("not used: ")] += 1
        elif it["id"] in excluded_big:
            kept_reasons[f"record major axis >= {SHEN_MAX_MAJOR_ARCMIN:g} arcmin (not linked)"] += 1
        else:
            kept_reasons["no Shen region within the link rule"] += 1
    changes = []
    for l in replaced:
        rel = l["new_pc"] / l["old_pc"] - 1.0
        changes.append({**{k: l[k] for k in ("id", "name", "wise", "group", "remarks", "old_pc", "new_pc")},
                        "change": round(rel, 4)})
    rel = sorted(c["change"] for c in changes)
    med = lambda xs: 0.0 if not xs else (xs[len(xs) // 2] if len(xs) % 2 else (xs[len(xs) // 2 - 1] + xs[len(xs) // 2]) / 2)  # noqa: E731
    shen_report = {
        **shen_read, "eligible_records": sum(1 for it in items if it["eligible"] and it["pn"] is None),
        "links": len(link_rows), "link_rows": link_rows,
        "adopted": len(adopted), "adopted_by_group": {k: by_group.get(k, 0) for k in ("I", "II", "III")},
        "adopted_by_remark": dict(sorted(by_remark.items())),
        "russeil_replaced": len(replaced), "direction_only_placed": len(placed),
        "russeil_kept": sum(kept_reasons.values()), "russeil_kept_by_reason": dict(sorted(kept_reasons.items())),
        "excluded_major_ge_120_arcmin": sorted(excluded_big),
        "replaced_change": {"median": round(med(rel), 4), "median_abs": round(med(sorted(abs(x) for x in rel)), 4),
                            "over_20pct": sum(1 for x in rel if abs(x) > 0.2),
                            "over_50pct": sum(1 for x in rel if abs(x) > 0.5)},
        "changes_over_50pct": sorted((c for c in changes if abs(c["change"]) > 0.5), key=lambda c: c["id"]),
        "overrides": len(shen_ov),
    }

    method = Counter("pn_parallax_measured" if it["pn"] is not None
                     else {"shen": "shen", "russeil": "russeil_derived"}.get(out["best"]["cat"] if out.get("best") else "",
                                                                         "direction_only")
                     for it, _, _, out in outcomes)
    by = lambda f: dict(sorted(Counter(f(r) for r in records).items()))  # noqa: E731
    report.update({
        "sharpless_rows": len(sh2), "merges": merge_report["by_rule"], "merged_pairs": merge_report["merged_pairs"],
        "forbidden_by_override": merge_report["forbidden_by_override"],
        "sharpless_only": len(sharpless_only),
        "distances": {k: method.get(k, 0) for k in ("pn_parallax_measured", "shen", "russeil_derived", "direction_only")},
        "shen": shen_report,
        "planetary_nebula_cuts": {k: pn_report.get(k, 0) for k in
                                  ("rows", "no_png_id", "not_in_chornay", "fail_rel", "fail_snr", "fail_ruwe", "pass")},
        "russeil": russeil_report,
        "records_written": len(records), "by_evidence": by(lambda r: r["evidence"]),
        "by_type": by(lambda r: r["props"]["type"]["v"]),
    })
    return records, report


# --- licence text ----------------------------------------------------------------------------

def license_text(which: str) -> str:
    """The LICENSE.md of the sources folder (`which == "sources"`) or of the built dataset (`"dataset"`)."""
    if which == "sources":
        folder = "backend/data/sources/nebulae/"
        covered = (
            "- the gzipped input snapshots (`*.gz`): OpenNGC `NGC.csv` and `addendum.csv` exactly as published at "
            f"commit `{OPENNGC_SHA}`, and the six VizieR tables (Sharpless, Chornay & Walton, Russeil, Shen et al. "
            "`table2` and `tablea1`) without their `#` header lines;\n"
            f"- `SOURCE.json`, the list of those inputs with their hashes, URLs and retrieval dates;\n"
            f"- `{OVERRIDES_FILE}` and `{SHEN_OVERRIDES_FILE}`, the hand-written merge and Shen link override tables;\n"
            "- this file.")
        derived = ("The OpenNGC files are unmodified copies. The six VizieR tables are unmodified copies too, "
                   "redistributed with the credit below under VizieR's terms of use "
                   f"({VIZIER_TERMS}); CC BY-SA 4.0 does not relicense them.")
    else:
        folder = "frontend/data/objects/nebulae/"
        covered = ("- `manifest.json`;\n- `tiles/*.json`, the nebula records;\n- this file.")
        derived = ("These files are derived from OpenNGC: its objects, coordinates, sizes, magnitudes, names and "
                   "identifiers were merged with the Sharpless catalogue (matched by identifier, a committed override "
                   "table and position), given distances from Chornay & Walton 2021, Shen et al. 2025 and Russeil 2003, and converted "
                   "to Space Maps' record format. The OpenNGC-derived values are licensed under the same CC BY-SA 4.0 licence; the exception is below.")
    return f"""# Licence and credits: nebulae data

Applies to **every file in `{folder}`**:

{covered}

## Licence

{derived}

The OpenNGC data, and the data derived from it, are licensed under **{LICENCE_NAME}**
({LICENCE_URL}).

{CREDIT}

## Values with other terms

Two sets of values are Gaia-derived. (1) The distances of the 59 planetary nebulae and their central-star
identifiers come from Chornay & Walton 2021, who derived them from Gaia EDR3 parallaxes. (2) The HII-region distances
taken from Shen et al. 2025 whose `src` says "Gaia DR3" (their Group I, II and III rows without a maser remark, some
of them values from Mendez-Delgado et al. 2022 based on Gaia DR3) are Bailer-Jones et al. 2021 distances of exciting
stars, from Gaia DR3. Both are under **{GAIA_LICENCE_NAME}** ({GAIA_LICENCE_URL}), with the credit "PN distances
(Chornay & Walton 2021, Gaia EDR3) and HII-region distances (Shen et al. 2025, Gaia DR3): {GAIA_CREDIT}". ESA's terms
ask for authorisation (data.licences@esa.int) before commercial use. They are **not** relicensed by {LICENCE_NAME}:
each value keeps the terms of its source.

The rows of Shen et al. 2025 that adopt a VLBI maser parallax (their `src` says "VLBI maser parallax", never
"Gaia") are **not** Gaia values: they come from the literature through VizieR (terms: {VIZIER_TERMS}), and so do
the Russeil 2003 distances.

OpenNGC is at {OPENNGC_URL}, release {OPENNGC_TAG}, commit `{OPENNGC_SHA}`. Changes made here: the rows of the
types PN, HII, EmN, RfN, Neb, SNR, Cl+N and DrkN were selected, merged with the Sharpless catalogue, given
distances and re-encoded as JSON records (see `docs/object-framework.md`, section 17).

## OpenNGC acknowledgements

{OPENNGC_ACKNOWLEDGEMENTS}

## Other catalogues (via VizieR, CDS Strasbourg)

- {CITATIONS['sharpless']}
- {CITATIONS['chornay']}
- {CITATIONS['shen']}
- {CITATIONS['russeil']}

VizieR terms of use: {VIZIER_TERMS}

## Code

The code that builds these files (`backend/scripts/build_objects_nebulae.py`) and the rest of the repository are
under the MIT licence (see the repository `LICENSE`). Only the data files listed above carry the data terms described here.
"""


# --- reading and writing the pinned input ----------------------------------------------------

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_gz(path: Path, data: bytes) -> None:
    """Deterministic gzip: no file name, mtime 0."""
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, compresslevel=9, mtime=0) as g:
        g.write(data)
    path.write_bytes(buf.getvalue())


def parse_role(role: str, data: bytes) -> list[dict]:
    return parse_ongc(data) if role in ONGC_ROLES else parse_vizier(data)


def canonical(role: str, raw: bytes) -> bytes:
    """The bytes that are committed and hashed: OpenNGC as published, VizieR without `#` and empty lines."""
    return raw if role in ONGC_ROLES else strip_comments(raw)


def check_rows(role: str, rows: list[dict]) -> None:
    want = INPUTS[role]["rows"]
    if len(rows) != want:
        raise SystemExit(f"{INPUTS[role]['file']}: expected {want} rows, got {len(rows)} (truncated download?)")


def load_inputs(sources: Path, local: Path | None) -> dict:
    """Parsed inputs, the override table, and the metadata of every input file."""
    meta = json.loads((sources / "SOURCE.json").read_text(encoding="utf-8"))
    files = {f["role"]: f for f in meta["files"]}
    parsed, info = {}, {}
    for role, spec in INPUTS.items():
        f = files[role]
        if local is None:
            data = gzip.decompress((sources / f["file"]).read_bytes())
            if sha256(data) != f["sha256"] or (spec["sha256"] and sha256(data) != spec["sha256"]):
                raise SystemExit(f"{f['file']}: sha256 differs from SOURCE.json or from the pin in the script")
            info[role] = f
        else:
            data = canonical(role, (local / spec["local"]).read_bytes())
            info[role] = dict(f, retrieved=None, mirror=None, url=None, sha256=sha256(data), file=spec["local"])
        rows = parse_role(role, data)
        check_rows(role, rows)
        parsed[role] = rows
    ov_bytes = (sources / OVERRIDES_FILE).read_bytes()   # hand-edited and committed: not pinned, see the report
    sov_bytes = (sources / SHEN_OVERRIDES_FILE).read_bytes()
    return {"inputs": {"ongc": parsed["openngc"] + parsed["openngc-addendum"], "sharpless": parsed["sharpless"],
                       "chornay": parsed["chornay"], "russeil1": parsed["russeil-table1"],
                       "russeil3": parsed["russeil-table3"], "shen2": parsed["shen-table2"],
                       "shen_a1": parsed["shen-tablea1"]},
            "overrides": json.loads(ov_bytes.decode("utf-8")), "overrides_sha256": sha256(ov_bytes),
            "shen_overrides": json.loads(sov_bytes.decode("utf-8")), "shen_overrides_sha256": sha256(sov_bytes),
            "files": info, "meta": meta}


def provenance_full(files: dict) -> dict:
    inputs = [{k: f.get(k) for k in ("role", "file", "sha256", "rows", "url", "mirror", "retrieved")}
              for f in sorted(files.values(), key=lambda f: f["role"])]
    return {"catalogue": CATALOGUE, "version": VERSION, "openngc_commit": OPENNGC_SHA, "url": OPENNGC_URL,
            "credit": MANIFEST_CREDIT, "licence_name": MANIFEST_LICENCE_NAME, "licence": LICENCE_URL,
            "citation": " | ".join(["OpenNGC (Mattia Verga), " + OPENNGC_URL, *CITATIONS.values()]),
            "data_licence_note": ("OpenNGC-derived data: CC BY-SA 4.0. PN distances and central-star ids (Chornay & Walton 2021) and "
                                  "the HII-region distances of Shen et al. 2025 whose src says Gaia DR3: Gaia-derived, "
                                  f"{GAIA_LICENCE_NAME} ({GAIA_LICENCE_URL}); Shen's maser-parallax rows are not Gaia values. "
                                  f"Sharpless, Chornay & Walton, Russeil and Shen tables via VizieR: {VIZIER_TERMS}"),
            "vizier_terms": VIZIER_TERMS, "inputs": inputs}


def build(out_dir: Path, sources: Path = SOURCES, local: Path | None = None) -> dict:
    """Build the dataset (and its LICENSE.md) into `out_dir` from the committed snapshots, or from raw downloads."""
    loaded = load_inputs(sources, local)
    records, report = build_records(loaded["inputs"], loaded["overrides"], loaded["shen_overrides"])
    report["overrides_sha256"] = loaded["overrides_sha256"]    # --check catches drift between overrides and data
    report["shen"]["overrides_sha256"] = loaded["shen_overrides_sha256"]
    manifest = objects_static.write_dataset(
        records, out_dir, dataset=DATASET, kinds=["nebula"], provenance=provenance_full(loaded["files"]),
        build={"script": SCRIPT, "script_version": SCRIPT_VERSION, "report": report},
        band_deg=10, precedence=50, src_table=True, record_defaults={"provenance": provenance()}, compact=True)
    (out_dir / "LICENSE.md").write_text(license_text("dataset"), encoding="utf-8")
    return manifest


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
    raise RuntimeError(f"{url[:100]}: {last}")


def vizier_url(mirror: str, table: str) -> str:
    return f"https://{mirror}/viz-bin/asu-tsv?-source={quote(table, safe='')}&-out.all&-out.max=unlimited"


def verify_download(role: str, raw: bytes) -> bytes:
    """The canonical bytes of a download, after checking its row count and its pin. SystemExit on a mismatch."""
    data = canonical(role, raw)
    check_rows(role, parse_role(role, data))
    pin = INPUTS[role]["sha256"]
    if pin and sha256(data) != pin:
        raise SystemExit(f"{INPUTS[role]['file']}: sha256 {sha256(data)} differs from the pin {pin}; refusing it "
                         "(update the pin deliberately if the catalogue was revised)")
    return data


def download(role: str) -> tuple[bytes, str, str]:
    """(canonical bytes, url, mirror) of one input from its pinned URL or the first VizieR mirror that returns
    the complete pinned table."""
    spec = INPUTS[role]
    if role in ONGC_ROLES:
        url = OPENNGC_RAW + spec["remote"]
        return verify_download(role, _http_get(url)), url, "raw.githubusercontent.com"
    errors = []
    for mirror in VIZIER_MIRRORS:
        url = vizier_url(mirror, spec["table"])
        try:
            return verify_download(role, _http_get(url)), url, mirror
        except (RuntimeError, SystemExit) as e:
            errors.append(f"{mirror}: {e}")
    raise SystemExit(f"no VizieR mirror returned {spec['table']} as pinned:\n  " + "\n  ".join(errors))


def source_json(files: list[dict]) -> dict:
    return {"dataset": DATASET,
            "note": ("Pinned inputs of backend/scripts/build_objects_nebulae.py. Regenerate with --refresh. `sha256` is of "
                     "the uncompressed committed bytes: OpenNGC exactly as published at the pinned commit; VizieR tables "
                     "without their # comment lines and empty lines (the lines carry the request date)."),
            "files": files + [{"role": "overrides", "file": OVERRIDES_FILE, "kind": "committed",
                               "note": ("hand-edited merge override table, committed, not downloaded and not pinned "
                                        "here; its sha256 is in manifest.build.report.overrides_sha256"),
                               "licence": f"{LICENCE_NAME}, {LICENCE_URL}"},
                              {"role": "shen-overrides", "file": SHEN_OVERRIDES_FILE, "kind": "committed",
                               "note": ("hand-edited table of Shen link overrides [{nebula, wise|null, reason}], committed, "
                                        "not downloaded and not pinned here; its sha256 is in "
                                        "manifest.build.report.shen.overrides_sha256"),
                               "licence": "MIT (the repository licence)"}]}


def refresh(directory: Path, local: Path | None = None) -> None:
    """Write the snapshots and SOURCE.json from a download (or from `local`, a directory of raw files)."""
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    files, blobs = [], {}
    for role, spec in INPUTS.items():
        if local is None:
            data, url, mirror = download(role)
        else:
            data = verify_download(role, (local / spec["local"]).read_bytes())
            url, mirror = None, "(local file)"
        blobs[role] = data
        f = {"role": role, "file": spec["file"], "sha256": sha256(data), "rows": spec["rows"], "url": url,
             "mirror": mirror, "retrieved": today, "bytes": len(data)}
        if role in ONGC_ROLES:
            f.update(source="OpenNGC", commit=OPENNGC_SHA, release=OPENNGC_TAG, licence=f"{LICENCE_NAME}, {LICENCE_URL}",
                     citation=CREDIT)
        else:
            cite = CITATIONS["sharpless" if role == "sharpless" else "chornay" if role == "chornay"
                             else "shen" if role.startswith("shen") else "russeil"]
            f.update(source="VizieR", vizier_id=spec["vizier"], table=spec["table"], licence=VIZIER_TERMS, citation=cite)
        files.append(f)
    for name in (OVERRIDES_FILE, SHEN_OVERRIDES_FILE):
        if not (directory / name).exists():
            raise SystemExit(f"{directory / name} is missing (it is committed by hand)")
    directory.mkdir(parents=True, exist_ok=True)
    for old in list(directory.glob("*.gz")):
        old.unlink()
    for role, data in blobs.items():
        write_gz(directory / INPUTS[role]["file"], data)
    (directory / "SOURCE.json").write_text(
        json.dumps(source_json(files), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (directory / "LICENSE.md").write_text(license_text("sources"), encoding="utf-8")


# --- command line ----------------------------------------------------------------------------

def _files(d: Path) -> dict[str, bytes]:
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


def _print_report(m: dict) -> None:
    r = m["build"]["report"]
    print(f"rows read {r['rows_read']}; kept {r['kept_by_type']}; excluded {r['excluded']}; "
          f"Dup designations folded {r['dup_designations_folded']}")
    print(f"merges {r['merges']} ({len(r['merged_pairs'])} pairs); Sharpless-only {r['sharpless_only']}; "
          f"distances {r['distances']}")
    print(f"PN cuts {r['planetary_nebula_cuts']}")
    ru = r["russeil"]
    print(f"Russeil: {ru['links']} links, {ru['links_dropped_by_1deg_filter']} dropped by the 1 deg filter, "
          f"{ru['regions_with_stellar_distance']} regions with a stellar distance")
    sh = r["shen"]
    print(f"Shen: {sh['usable_rows']} rows, {sh['links']} links, adopted {sh['adopted']} (groups {sh['adopted_by_group']}, "
          f"remarks {sh['adopted_by_remark']}); Russeil replaced {sh['russeil_replaced']}, direction-only placed "
          f"{sh['direction_only_placed']}, Russeil kept {sh['russeil_kept']}; >50% changes {len(sh['changes_over_50pct'])}")
    print(f"wrote {r['records_written']} records in {len(m['tiles'])} tiles; evidence {r['by_evidence']}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--sources", type=Path, default=SOURCES, help="directory of the committed snapshots")
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
            print(f"{a.out} differs from a fresh build: {', '.join(diff[:10])}"
                  f"{' ...' if len(diff) > 10 else ''}", file=sys.stderr)
        for p in problems[:20]:
            print(f"verify: {p}", file=sys.stderr)
        if diff or problems:
            return 1
        print(f"{a.out} is up to date ({len(fresh)} files, verified)")
        return 0
    m = build(a.out, a.sources, a.local)
    _print_report(m)
    print(f"wrote {m['count']} records to {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
