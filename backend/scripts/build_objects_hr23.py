"""Build the `hr23-clusters` object dataset: the Hunt & Reffert open and globular cluster census.

Source: VizieR `J/A+A/686/A42/clusters` (Hunt & Reffert 2024, "Improving the open cluster census. III"), 7,167
clusters. It has the same cluster ids and the same astrometry, distances, ages and extinctions as the 2023 census
(`J/A+A/673/A114`), plus Jacobi radii, masses and a bound / moving-group classification, and 68 corrected names.
Records use the namespace `hr23:` (the catalogue family) with the HR24 `Name`. The pin is the committed,
deterministically gzipped extract of the columns used under `backend/data/sources/hr23-clusters/`, with the sha256
of the full download (VizieR `#` comment lines stripped) in SOURCE.json. A rebuild needs no network. Design:
docs/object-framework.md sections 16.9 and 16.18.

    uv run python backend/scripts/build_objects_hr23.py                # build from the committed snapshot
    uv run python backend/scripts/build_objects_hr23.py --check        # rebuild in a temp dir, compare, verify
    uv run python backend/scripts/build_objects_hr23.py --local FILE   # build from a raw VizieR TSV download
    uv run python backend/scripts/build_objects_hr23.py --refresh      # download the pinned table, rewrite the snapshot
    uv run python backend/scripts/build_objects_hr23.py --refresh --local FILE   # ... from a file you downloaded
    uv run python backend/scripts/build_objects_hr23.py --refresh-members        # only the members snapshot (network)

`--refresh` tries the CDS server and then the CfA mirror (the mirror is intermittent and can return a truncated
file), and rejects a download unless it has exactly 7,167 rows and the pinned sha256. `--check` exits 1 when the
committed dataset differs from a fresh build, or fails `objects_static.verify_dataset`.

Members (script_version 2, docs/object-framework.md 20.9): the VizieR members table `J/A+A/686/A42/members`
(Hunt & Reffert 2024, table 2) is fetched for the clusters with `dist50 <= 500 pc` (ASU list constraints on `ID`, in
batches, CDS then CfA then IDIA) and committed as `members-hr24-<date>.csv.gz` (`ID`, `GaiaDR3`, `Prob`, `inrt`).
`--refresh-members` refuses the download unless every cluster's member count equals its `N` in the committed clusters
snapshot. The build writes `members/<ID>.json` per cluster (membership probabilities truncated, not rounded, to
integer thousandths, so a stored value of 500 or more means Prob >= 0.5 and `n_p50` counts exactly those), adds `assets.members` to those cluster records and a
`members` map to the manifest, and fails when the member files exceed `MEMBERS_MAX_BYTES` (4 MB) on disk.

Output: one `cluster` record per catalogue row, all kept. Evidence follows the mean-parallax signal to noise: at or
above 5 the distance is `measured`; below it the maximum-likelihood distance is prior-dominated, so the distance is
`inferred`, the record `derived` and its marker hollow. `props.quality` is `reliable` for the Hunt & Reffert 2023
cut (CST >= 5 and median CMD class >= 0.5, never for a rejected cluster) and `candidate` otherwise.
"""

from __future__ import annotations

import argparse
import csv
import datetime
import gzip
import hashlib
import io
import json
import re
import sys
import tempfile
import time
from collections import Counter
from decimal import ROUND_FLOOR, Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from spherex_app import objects, objects_static  # noqa: E402

DATASET = "hr23-clusters"
OUT = ROOT / "frontend" / "data" / "objects" / DATASET
SOURCES = ROOT / "backend" / "data" / "sources" / DATASET
SCRIPT = "backend/scripts/build_objects_hr23.py"
SCRIPT_VERSION = 2

VIZIER_ID = "J/A+A/686/A42"
TABLE = "J/A+A/686/A42/clusters"
QUERY = "?-source=J/A%2BA/686/A42/clusters&-out.max=unlimited&-out.all"
MIRRORS = ("https://vizier.cds.unistra.fr/viz-bin/asu-tsv", "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv")
EXPECTED_ROWS = 7167
EXPECTED_SHA256 = "0469c5baec7ccf0431aeb129fb0b06507eee55d499453717a759c8e0ab55d579"
SNAPSHOT = "clusters-hr24-{date}.csv.gz"

MEMBERS_TABLE = "J/A+A/686/A42/members"
MEMBERS_SNAPSHOT = "members-hr24-{date}.csv.gz"
MEMBERS_COLUMNS = ("ID", "GaiaDR3", "Prob", "inrt")
MEMBERS_MIRRORS = ("https://vizier.cds.unistra.fr/viz-bin/asu-tsv", "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv",
                   "https://vizier.idia.ac.za/viz-bin/asu-tsv")
MEMBERS_QUERY = ("?-source=J/A%2BA/686/A42/members&-out=ID,GaiaDR3,Prob,inrt&-out.max=unlimited&ID=")
MEMBERS_MAX_DIST_PC = 500
MEMBERS_MAX_BYTES = 4_000_000     # 4 MB on disk: above it the build fails (docs/object-framework.md 20.17 item 4)
MEMBERS_BATCH_IDS = 60            # clusters per ASU request
MEMBERS_BATCH_ROWS = 15000        # members per ASU request (the sum of the clusters' N)
MEMBERS_FORMAT = "space-maps.cluster-members/1"
SRC_MEMBERS = "Hunt & Reffert 2024, table 2 (J/A+A/686/A42/members); probabilities truncated to thousandths"

CATALOGUE = "Hunt & Reffert 2024 (open and globular clusters in Gaia DR3)"
CITATION = ("Hunt & Reffert 2024, A&A 686, A42 (2024A&A...686A..42H), doi:10.26093/cds/vizier.36860042; "
            "Hunt & Reffert 2023, A&A 673, A114 (2023A&A...673A.114H) for the cluster census and the quality cut")
GAIA_CREDIT = "Credit: ESA/Gaia/DPAC"          # docs/object-framework.md 18.12
LICENCE = "https://cds.unistra.fr/vizier-org/licences_vizier.html"
URL = "https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/686/A42"

# Columns kept in the committed snapshot (Name and ID first).
COLUMNS = ("Name", "ID", "AllNames", "Type", "CST", "N", "RA_ICRS", "DE_ICRS", "r50", "r50pc", "Plx", "e_Plx",
           "dist16", "dist50", "dist84", "globalPlx", "CMDCl50", "logAge16", "logAge50", "logAge84",
           "AV16", "AV50", "AV84", "rJpc", "probJ", "MassJ", "e_MassJ", "MassTot", "e_MassTot", "Note")

SRC_DIST = "Hunt & Reffert 2024 (maximum-likelihood distance from member parallaxes)"
SRC_DIST_GLOBAL = SRC_DIST + "; no star-by-star parallax offset correction was possible (global offset used)"
SRC_RADIUS = "Hunt & Reffert 2024 (radius containing 50% of members)"
SRC_ANGULAR = "twice the radius containing 50% of members (Hunt & Reffert 2024)"
SRC_COUNT = "Hunt & Reffert 2024 (number of member stars)"
SRC_AGE = "CMD fit (neural network), Hunt & Reffert 2023/2024"
SRC_AV = "CMD fit (neural network), Hunt & Reffert 2023/2024 (A_V)"
SRC_TYPE = "Hunt & Reffert 2024 (object type)"
SRC_QUALITY = "Hunt & Reffert 2023 quality cut: CST >= 5 and CMD class >= 0.5"
SRC_MASS = "total observed mass, Hunt & Reffert 2024"
SRC_MASS_J = "mass within the Jacobi radius, Hunt & Reffert 2024"
SRC_JACOBI = "best-fitting Jacobi radius, Hunt & Reffert 2024"
SRC_CLASS = "Hunt & Reffert 2024 (bound open cluster: Jacobi radius probability >= 0.5 and M_J >= 40 Msun)"
SRC_SNR = "mean parallax / its standard error, Hunt & Reffert 2024"
SRC_NOTE = "Hunt & Reffert 2024 (reason the cluster was rejected)"
SRC_COMMON = "curated common name"

TYPE_LABEL = {"o": "open cluster", "m": "moving group", "g": "globular cluster",
              "d": "too distant (d >= 15 kpc)", "r": "rejected"}
CLASS_LABEL = {"o": "bound cluster", "m": "moving group"}

# A few famous clusters, by catalogue Name (HR24 spells them with underscores).
COMMON_NAMES = {
    "Melotte_22": "Pleiades",
    "Melotte_25": "Hyades",
    "NGC_2632": "Praesepe",
    "Melotte_111": "Coma Star Cluster",
    "Melotte_20": "Alpha Persei Cluster",
    "NGC_6475": "Ptolemy Cluster",
    "NGC_6405": "Butterfly Cluster",
    "NGC_6705": "Wild Duck Cluster",
    "NGC_4755": "Jewel Box",
}

SNR_MIN = 5.0
CST_MIN = 5.0
CMD_MIN = 0.5


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
    if isinstance(x, int):
        return x
    f = float(format(x, f".{sig}g")) if isinstance(x, Decimal) else float(f"{x:.{sig}g}")
    return int(f) if f.is_integer() and abs(f) < 1e15 else f


def parallax_snr(row: dict) -> float | None:
    """Plx / e_Plx, or None when either is missing or the error is not positive."""
    plx, err = _d(row.get("Plx")), _d(row.get("e_Plx"))
    if plx is None or err is None or err <= 0:
        return None
    return float(plx / err)


def is_reliable(row: dict) -> bool:
    """The Hunt & Reffert 2023 'highly reliable' cut. A rejected cluster (Type r) never passes."""
    if (row.get("Type") or "").strip() == "r":
        return False
    cst, cmd = _d(row.get("CST")), _d(row.get("CMDCl50"))
    return cst is not None and cmd is not None and cst >= Decimal(str(CST_MIN)) and cmd >= Decimal(str(CMD_MIN))


def age_quantity(row: dict) -> dict | None:
    """Age in Gyr from log10(age/yr), with the 16th and 84th percentiles as the interval."""
    mid = _d(row.get("logAge50"))
    if mid is None:
        return None
    gyr = lambda x: _num(10 ** float(x) / 1e9, 6)  # noqa: E731
    lo, hi = _d(row.get("logAge16")), _d(row.get("logAge84"))
    return objects.quantity(gyr(mid), SRC_AGE, "inferred", "Gyr",
                            None if lo is None else gyr(lo), None if hi is None else gyr(hi))


def extinction_quantity(row: dict) -> dict | None:
    mid = _d(row.get("AV50"))
    if mid is None:
        return None
    lo, hi = _d(row.get("AV16")), _d(row.get("AV84"))
    return objects.quantity(_num(mid), SRC_AV, "inferred", "mag",
                            None if lo is None else _num(lo), None if hi is None else _num(hi))


def _err_quantity(row: dict, col: str, err_col: str, src: str, unit: str, tier: str = "inferred") -> dict | None:
    v = _d(row.get(col))
    if v is None:
        return None
    e = _d(row.get(err_col))
    lo = hi = None
    if e is not None and e > 0:
        lo, hi = max(v - e, Decimal(0)), v + e
    return objects.quantity(_num(v, 8), src, tier, unit, None if lo is None else _num(lo, 8),
                            None if hi is None else _num(hi, 8))


def designations(row: dict) -> list[str]:
    """The Name and the AllNames list, underscores shown as spaces, deduplicated in order."""
    out = [row["Name"].strip().replace("_", " ")]
    for part in (row.get("AllNames") or "").split(","):
        part = part.strip().replace("_", " ")
        if part and part not in out:
            out.append(part)
    return out


def display_name(row: dict) -> tuple[str, bool]:
    key = row["Name"].strip()
    if key in COMMON_NAMES:
        return COMMON_NAMES[key], True
    return key.replace("_", " "), False


def provenance(snapshot_date: str) -> dict:
    return {"source": f"static:{DATASET}", "dataset": DATASET, "catalogue": CATALOGUE,
            "version": f"{VIZIER_ID}, retrieved {snapshot_date}"}


# --- records ---------------------------------------------------------------------------------

def cluster_record(row: dict, prov: dict) -> dict | None:
    """The `cluster` record of one catalogue row, or None when it lacks a position or a distance."""
    ra, dec, d50 = _d(row.get("RA_ICRS")), _d(row.get("DE_ICRS")), _d(row.get("dist50"))
    if ra is None or dec is None or d50 is None:
        return None
    name_key = row["Name"].strip()
    typ = (row.get("Type") or "").strip()
    snr = parallax_snr(row)
    measured = snr is not None and snr >= SNR_MIN
    d16, d84 = _d(row.get("dist16")), _d(row.get("dist84"))
    flag = (row.get("globalPlx") or "").strip() == "1"
    dist = objects.quantity(_num(d50, 10), SRC_DIST_GLOBAL if flag else SRC_DIST,
                            "measured" if measured else "inferred", "pc",
                            None if d16 is None else _num(d16, 10), None if d84 is None else _num(d84, 10))
    position = {"model": "fixed", "ra": _num(ra % 360), "dec": _num(dec), "epoch": 2016.0,
                "method": "cluster-parallax", "dist": dist}

    r50pc, r50 = _d(row.get("r50pc")), _d(row.get("r50"))
    size = None
    if r50pc is not None or r50 is not None:
        size = {"radius": None if r50pc is None else objects.quantity(_num(r50pc, 8), SRC_RADIUS, "catalogue", "pc"),
                "angular": None if r50 is None else {
                    "major": objects.quantity(_num(2 * r50, 8), SRC_ANGULAR, "catalogue", "deg"),
                    "minor": None, "pa": None}}

    props: dict[str, dict] = {}
    n = _d(row.get("N"))
    if n is not None:
        props["n_members"] = objects.quantity(int(n), SRC_COUNT, "catalogue")
    for key, q in (("age", age_quantity(row)), ("extinction", extinction_quantity(row))):
        if q is not None:
            props[key] = q
    if typ:
        props["type"] = objects.quantity(TYPE_LABEL.get(typ, f"type {typ}, see Hunt & Reffert 2024"),
                                         SRC_TYPE, "catalogue")
        if typ in CLASS_LABEL:
            props["class"] = objects.quantity(CLASS_LABEL[typ], SRC_CLASS, "catalogue")
    props["quality"] = objects.quantity("reliable" if is_reliable(row) else "candidate", SRC_QUALITY, "catalogue")
    mass = _err_quantity(row, "MassTot", "e_MassTot", SRC_MASS, "Msun")
    if mass is not None:
        props["mass"] = mass
    mass_j = _err_quantity(row, "MassJ", "e_MassJ", SRC_MASS_J, "Msun")
    if mass_j is not None:
        props["mass_jacobi"] = mass_j
    rj = _d(row.get("rJpc"))
    if rj is not None:
        props["jacobi_radius"] = objects.quantity(_num(rj, 8), SRC_JACOBI, "inferred", "pc")
    if snr is not None:
        props["parallax_snr"] = objects.quantity(_num(snr, 6), SRC_SNR, "catalogue")
    note = (row.get("Note") or "").strip()
    if note:
        props["note"] = objects.quantity(note, SRC_NOTE, "catalogue")

    name, curated = display_name(row)
    rec = objects.record(id=f"hr23:{name_key}", kind="cluster", name=name, designations=designations(row),
                         position=position, size=size, props=props, provenance=prov,
                         evidence="measured" if measured else "derived", render={})
    if curated:
        rec["props"]["common_name"] = objects.quantity(name, SRC_COMMON, "catalogue")
    return rec


def build_records(rows: list[dict], snapshot_date: str) -> tuple[list[dict], dict]:
    prov = provenance(snapshot_date)
    records, excluded = [], Counter()
    for row in rows:
        rec = cluster_record(row, prov)
        if rec is None:
            excluded["missing position or distance"] += 1
        else:
            records.append(rec)
    by = lambda f: dict(sorted(Counter(f(r) for r in records).items()))  # noqa: E731
    report = {
        "rows_read": len(rows), "records_written": len(records),
        "excluded": dict(excluded),
        "by_type": by(lambda r: r["props"]["type"]["v"] if "type" in r["props"] else "(none)"),
        "by_quality": by(lambda r: r["props"]["quality"]["v"]),
        "by_evidence": by(lambda r: r["evidence"]),
        "without_age": sum(1 for r in records if "age" not in r["props"]),
        "without_extinction": sum(1 for r in records if "extinction" not in r["props"]),
        "without_mass": sum(1 for r in records if "mass" not in r["props"]),
        "parallax_snr_below_5": sum(1 for r in records if r["evidence"] == "derived"),
        "global_parallax_offset": sum(1 for r in records if r["position"]["dist"]["src"] == SRC_DIST_GLOBAL),
        "common_names": sum(1 for r in records if "common_name" in r["props"]),
    }
    return records, report


# --- reading and writing the pinned input ----------------------------------------------------

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_gz(path: Path, data: bytes) -> None:
    """Deterministic gzip: no file name, mtime 0."""
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, compresslevel=9, mtime=0) as g:
        g.write(data)
    path.write_bytes(buf.getvalue())


def read_csv_bytes(data: bytes) -> list[dict]:
    return list(csv.DictReader(io.StringIO(data.decode("utf-8"), newline="")))


def strip_comments(raw: bytes) -> bytes:
    """The download without its VizieR `#` comment lines (they carry the request date)."""
    return b"".join(line for line in raw.splitlines(keepends=True) if not line.startswith(b"#"))


def parse_raw(raw: bytes) -> list[dict]:
    """Rows of a raw VizieR TSV download: a header line, a units line and a dashes line, then the rows.
    Raises SystemExit unless the table is complete."""
    lines = [l for l in strip_comments(raw).decode("utf-8").splitlines() if l.strip()]
    if len(lines) < 4:
        raise SystemExit("the download has no table")
    header = lines[0].split("\t")
    missing = [c for c in COLUMNS if c not in header]
    if missing:
        raise SystemExit(f"the download lacks columns: {', '.join(missing)}")
    if not lines[2].lstrip().startswith("-"):
        raise SystemExit("the download does not have the expected units and dashes lines")
    rows = []
    for line in lines[3:]:
        cells = line.split("\t")
        if len(cells) != len(header):
            raise SystemExit(f"truncated or malformed row: {line[:80]!r}")
        rows.append({k: v.strip() for k, v in zip(header, cells)})
    return rows


def check_raw(raw: bytes, *, pinned: bool) -> list[dict]:
    rows = parse_raw(raw)
    if len(rows) != EXPECTED_ROWS:
        raise SystemExit(f"expected {EXPECTED_ROWS} rows, got {len(rows)} (truncated download?)")
    if pinned and sha256(strip_comments(raw)) != EXPECTED_SHA256:
        raise SystemExit("sha256 of the download differs from the pin; refusing it (update EXPECTED_SHA256 "
                         "deliberately if the catalogue was revised)")
    return rows


def extract(rows: list[dict]) -> bytes:
    """The committed columns as a canonical CSV (Unix line endings, rows sorted by ID)."""
    buf = io.StringIO(newline="")
    w = csv.DictWriter(buf, fieldnames=list(COLUMNS), lineterminator="\n", extrasaction="ignore")
    w.writeheader()
    w.writerows(sorted(rows, key=lambda r: (int(r["ID"]), r["Name"])))
    return buf.getvalue().encode("utf-8")


def _entry(meta: dict, role: str) -> dict | None:
    return next((f for f in meta["files"] if f.get("role") == role), None)


def _read_pinned(directory: Path, f: dict) -> list[dict]:
    data = gzip.decompress((directory / f["file"]).read_bytes())
    if sha256(data) != f["sha256"]:
        raise SystemExit(f"{f['file']}: sha256 differs from SOURCE.json")
    return read_csv_bytes(data)


def load_snapshot(directory: Path) -> dict:
    """The committed snapshots: `rows`/`file` for the clusters table, `member_rows`/`members_file` for the members."""
    meta = json.loads((directory / "SOURCE.json").read_text(encoding="utf-8"))
    f = _entry(meta, "clusters")
    if f is None:
        raise SystemExit("SOURCE.json has no clusters entry")
    mf = _entry(meta, "members")
    return {"meta": meta, "file": f, "rows": _read_pinned(directory, f),
            "members_file": mf, "member_rows": None if mf is None else _read_pinned(directory, mf)}


def provenance_full(f: dict, *, version: str | None = None) -> dict:
    return {"catalogue": CATALOGUE, "version": version or f"{VIZIER_ID}, retrieved {f['retrieved']}",
            "vizier_id": VIZIER_ID, "table": TABLE, "citation": CITATION, "licence": LICENCE, "url": URL,
            "query_url": f["query_url"], "mirror": f.get("mirror"), "retrieved": f["retrieved"],
            "source_sha256": f["source_sha256"], "source_rows": f["rows"], "snapshot_file": f["file"],
            "snapshot_sha256": f["sha256"],
            # derived by Hunt & Reffert from Gaia DR3; the VizieR terms stay the licence, so no licence_name
            "credit": f"Hunt & Reffert 2024, from Gaia DR3 ({GAIA_CREDIT})"}


def members_provenance(mf: dict) -> dict:
    return {"table": MEMBERS_TABLE, "src": SRC_MEMBERS, "licence": LICENCE, "query_url": mf["query_url"],
            "mirror": mf.get("mirror"), "retrieved": mf["retrieved"], "source_sha256": mf["source_sha256"],
            "source_rows": mf["rows"], "snapshot_file": mf["file"], "snapshot_sha256": mf["sha256"],
            "max_dist_pc": MEMBERS_MAX_DIST_PC,
            "credit": f"Hunt & Reffert 2024, from Gaia DR3 ({GAIA_CREDIT}); Gaia data CC BY-NC 3.0 IGO"}


def license_text(which: str) -> str:
    """The LICENSE.md of the sources folder (`which == "sources"`) or of the built dataset (`"dataset"`)."""
    if which == "sources":
        folder = "backend/data/sources/hr23-clusters/"
        covered = ("- `clusters-hr24-*.csv.gz`: the Hunt & Reffert 2024 cluster table from VizieR "
                   f"({VIZIER_ID}), columns selected;\n"
                   "- `members-hr24-*.csv.gz`: the Hunt & Reffert 2024 members table (table 2, "
                   f"`{MEMBERS_TABLE}`) from VizieR, for the clusters within {MEMBERS_MAX_DIST_PC} pc, "
                   "columns ID, GaiaDR3, Prob, inrt;\n"
                   "- `SOURCE.json`, the inputs' hashes, URLs and retrieval dates;\n- this file.")
    else:
        folder = "frontend/data/objects/hr23-clusters/"
        covered = ("- `manifest.json`;\n- `tiles/*.json`, the cluster records;\n"
                   f"- `members/*.json`, the member stars of each cluster within {MEMBERS_MAX_DIST_PC} pc;\n"
                   "- this file.")
    return f"""# Licence and credits: hr23-clusters data

Applies to **every file in `{folder}`**:

{covered}

## Terms

The values come from the Hunt & Reffert catalogue as served by VizieR (CDS Strasbourg), under VizieR's terms of use
({LICENCE}). Please cite:

- {CITATION}

Hunt & Reffert derived the cluster positions, distances, sizes and memberships from Gaia DR3 data
({GAIA_CREDIT}). Nothing is relicensed here: the catalogue values keep VizieR's terms, and the underlying Gaia
data keep ESA's.

## The members folder

The `members/` folder of the dataset (`frontend/data/objects/hr23-clusters/members/`) and the members snapshot hold
Gaia-derived values: the Hunt & Reffert 2024 members table (table 2, `{MEMBERS_TABLE}`) lists, for each cluster
within {MEMBERS_MAX_DIST_PC} pc, its member stars by Gaia DR3 source id with a membership probability and a
tidal-radius flag. Credit: ESA/Gaia/DPAC. The Gaia data are available under CC BY-NC 3.0 IGO (non-commercial use),
and the table keeps VizieR's terms of use ({LICENCE}), as for the clusters table.

## Code

The code that builds these files (`backend/scripts/build_objects_hr23.py`) and the rest of the repository are
under the MIT licence (see the repository `LICENSE`).
"""


def member_clusters(rows: list[dict]) -> list[dict]:
    """The cluster rows that get a member file: a position and a distance, `dist50` at most 500 pc, by numeric ID."""
    out = []
    for r in rows:
        d50 = _d(r.get("dist50"))
        if _d(r.get("RA_ICRS")) is None or _d(r.get("DE_ICRS")) is None or d50 is None:
            continue
        if d50 <= MEMBERS_MAX_DIST_PC:
            out.append(r)
    return sorted(out, key=lambda r: int(r["ID"]))


def thousandths(prob: str) -> int:
    """Prob truncated (floored) to integer thousandths, so stored >= 500 exactly when Prob >= 0.5."""
    d = Decimal(prob)
    if not Decimal(0) <= d <= Decimal(1):
        raise SystemExit(f"membership probability {prob!r} is outside [0, 1]")
    return int((d * 1000).quantize(Decimal(1), rounding=ROUND_FLOOR))   # exact decimal: "0.5" -> 500, "0.4999" -> 499


def check_member_counts(clusters: list[dict], member_rows: list[dict]) -> None:
    """Every cluster within 500 pc has exactly its `N` member rows, and no other cluster has any."""
    have = Counter(r["ID"] for r in member_rows)
    want = {r["ID"]: int(_d(r["N"])) for r in clusters}
    bad = [f"{r['Name']} (ID {r['ID']}): {have.get(r['ID'], 0)} member rows, N = {want[r['ID']]}"
           for r in clusters if have.get(r["ID"], 0) != want[r["ID"]]]
    extra = sorted(set(have) - set(want), key=int)
    if bad or extra:
        raise SystemExit("the members table does not match the clusters table:\n  "
                         + "\n  ".join(bad[:20] + ([f"{len(bad) - 20} more"] if len(bad) > 20 else [])
                                       + ([f"member rows of clusters not within {MEMBERS_MAX_DIST_PC} pc: "
                                           f"{extra[:10]}"] if extra else [])))


def member_files(clusters: list[dict], member_rows: list[dict]) -> dict[str, bytes]:
    """`{"<ID>.json": bytes}` for every cluster in `clusters`: compact JSON, members sorted by numeric Gaia id."""
    check_member_counts(clusters, member_rows)
    by_id: dict[str, list[tuple[int, int, int, bool]]] = {}
    for r in member_rows:
        by_id.setdefault(r["ID"], []).append((int(r["GaiaDR3"]), thousandths(r["Prob"]), int(r["inrt"]),
                                              Decimal(r["Prob"]) >= Decimal("0.5")))
    out = {}
    for c in clusters:
        ms = sorted(by_id[c["ID"]])
        doc = {"format": MEMBERS_FORMAT, "cluster": f"hr23:{c['Name'].strip()}", "src": SRC_MEMBERS,
               "n": len(ms), "n_p50": sum(1 for m in ms if m[3]),
               "members": [[str(g), p, i] for g, p, i, _ in ms]}
        out[f"{c['ID']}.json"] = (json.dumps(doc, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
    return out


def members_report(files: dict[str, bytes], clusters: list[dict], member_rows: list[dict]) -> dict:
    total = sum(len(v) for v in files.values())
    gz = sum(len(gzip.compress(v, compresslevel=9, mtime=0)) for v in files.values())
    big = max(files, key=lambda k: (len(files[k]), k)) if files else None
    return {"clusters": len(files), "members": len(member_rows),
            "members_p50": sum(json.loads(v)["n_p50"] for v in files.values()),
            "bytes": total, "gzip_bytes": gz,
            "largest": None if big is None else {"id": big.removesuffix(".json"), "bytes": len(files[big])}}


def build_from(rows: list[dict], prov_full: dict, snapshot_date: str, out_dir: Path,
               member_rows: list[dict] | None = None, members_prov: dict | None = None) -> dict:
    if member_rows is None or members_prov is None:
        raise SystemExit("no members snapshot: run --refresh-members")
    records, report = build_records(rows, snapshot_date)
    clusters = [r for r in member_clusters(rows)]
    files = member_files(clusters, member_rows)
    mrep = members_report(files, clusters, member_rows)
    if mrep["bytes"] > MEMBERS_MAX_BYTES:
        raise SystemExit(f"the member files total {mrep['bytes']:,} bytes on disk ({mrep['gzip_bytes']:,} gzipped), "
                         f"above the {MEMBERS_MAX_BYTES:,} byte cap: stop and ask before shipping them "
                         f"(docs/object-framework.md 20.17 item 4)")
    report["members"] = mrep
    ids = {c["ID"]: c["Name"].strip() for c in clusters}
    by_name = {f"hr23:{n}": i for i, n in ids.items()}
    for rec in records:
        if rec["id"] in by_name:
            rec["assets"] = {"members": f"members/{by_name[rec['id']]}.json"}
    out = Path(out_dir)
    m = objects_static.write_dataset(
        records, out, dataset=DATASET, kinds=["cluster"], provenance=dict(prov_full, members=members_prov),
        build={"script": SCRIPT, "script_version": SCRIPT_VERSION, "report": report},
        band_deg=10, precedence=50, src_table=True, record_defaults={"provenance": provenance(snapshot_date)}, compact=True)
    mdir = out / "members"
    mdir.mkdir(parents=True, exist_ok=True)
    for old in mdir.iterdir():
        if old.is_file():
            old.unlink()
    for name, data in files.items():
        (mdir / name).write_bytes(data)
    m["members"] = {"prob": "truncated to thousandths", "max_dist_pc": MEMBERS_MAX_DIST_PC, "count": len(files), "members": len(member_rows),
                    "files": {name.removesuffix(".json"): {"n": json.loads(data)["n"], "sha256": sha256(data)}
                              for name, data in files.items()}}
    (out / objects_static.MANIFEST).write_bytes(objects_static._dumps(m).encode("utf-8"))
    (out / "LICENSE.md").write_text(license_text("dataset"), encoding="utf-8")
    return m


def verify_members(out: Path) -> list[str]:
    """Problems with the member files of a built dataset: the manifest map against the folder, and the assets."""
    try:
        m = json.loads((out / objects_static.MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return [f"manifest unreadable: {e}"]
    mm = m.get("members")
    if not isinstance(mm, dict) or not isinstance(mm.get("files"), dict):
        return ["manifest has no members map"]
    problems = []
    mdir = out / "members"
    on_disk = {p.name for p in mdir.iterdir()} if mdir.is_dir() else set()
    want = {f"{k}.json" for k in mm["files"]}
    problems += [f"members/{n}: not in the manifest" for n in sorted(on_disk - want)]
    problems += [f"members/{n}: listed in the manifest, missing on disk" for n in sorted(want - on_disk)]
    rows = 0
    for k, info in sorted(mm["files"].items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else -1):
        p = mdir / f"{k}.json"
        if not p.is_file():
            continue
        data = p.read_bytes()
        if sha256(data) != info.get("sha256"):
            problems.append(f"members/{k}.json: sha256 does not match the manifest")
        try:
            doc = json.loads(data)
        except ValueError:
            problems.append(f"members/{k}.json: not JSON")
            continue
        if doc.get("format") != MEMBERS_FORMAT or doc.get("n") != info.get("n") or len(doc.get("members", ())) != info.get("n"):
            problems.append(f"members/{k}.json: format or count differs from the manifest")
        rows += len(doc.get("members", ()))
    if rows != mm.get("members") or len(mm["files"]) != mm.get("count"):
        problems.append("manifest members count or rows differ from the files")
    try:
        ds = objects_static.load_dataset(out)
    except objects_static.DatasetError as e:
        return problems + [str(e)]
    assets = {}
    try:
        for t in ds.manifest["tiles"]:
            for r in objects_static._read_tile(ds, t):
                if "assets" in r:
                    assets[r["id"]] = r["assets"].get("members")
    except objects_static.DatasetError as e:
        return problems + [str(e)]
    for rid, path in assets.items():
        if path is None or path.removeprefix("members/").removesuffix(".json") not in mm["files"]:
            problems.append(f"{rid}: assets.members {path!r} has no member file")
    if len(assets) != len(mm["files"]):
        problems.append(f"{len(assets)} records carry assets.members, the manifest lists {len(mm['files'])} files")
    return problems


def build(out_dir: Path, sources: Path = SOURCES, local: Path | None = None) -> dict:
    """Build the dataset into `out_dir` from the committed snapshots (or the clusters from a raw VizieR TSV)."""
    snap = load_snapshot(sources)
    f = snap["file"]
    mf = snap["members_file"]
    mprov = None if mf is None else members_provenance(mf)
    if local is None:
        return build_from(snap["rows"], provenance_full(f), f["retrieved"], out_dir, snap["member_rows"], mprov)
    raw = local.read_bytes()
    rows = check_raw(raw, pinned=False)
    stripped = sha256(strip_comments(raw))
    full = dict(provenance_full(f, version=f"{VIZIER_ID}, local file {local.name}"), retrieved=None,
                query_url=None, mirror=None, source_sha256=stripped, source_rows=len(rows),
                snapshot_file=None, snapshot_sha256=sha256(extract(rows)))
    return build_from(read_csv_bytes(extract(rows)), full, f"local {stripped[:12]}", out_dir,
                      snap["member_rows"], mprov)


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


def download() -> tuple[bytes, str, str]:
    """(raw TSV, query URL, mirror) from the first server that returns the complete pinned table."""
    errors = []
    for base in MIRRORS:
        url = base + QUERY
        try:
            raw = _http_get(url)
            check_raw(raw, pinned=True)
            return raw, url, base.split("/viz-bin")[0].removeprefix("https://")
        except (RuntimeError, SystemExit) as e:
            errors.append(f"{base}: {e}")
    raise SystemExit("no VizieR server returned the complete table:\n  " + "\n  ".join(errors))


def refresh(directory: Path, local: Path | None = None) -> None:
    """Write the snapshot and SOURCE.json from a download (or from `local`, a raw TSV)."""
    if local is None:
        raw, url, mirror = download()
        retrieved = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    else:
        raw = local.read_bytes()
        check_raw(raw, pinned=True)
        text = raw[:4000].decode("utf-8", "replace")
        m = re.search(r"request_date=(\d{4}-\d\d-\d\d)", text)
        retrieved = m.group(1) if m else datetime.datetime.now(datetime.timezone.utc).date().isoformat()
        u = re.search(r"request=(\S+)", text)
        url = u.group(1) if u else MIRRORS[-1] + QUERY
        mirror = url.split("/viz-bin")[0].removeprefix("https://")
        if "request=" not in text:
            mirror = "(local file)"
    rows = parse_raw(raw)
    data = extract(rows)
    name = SNAPSHOT.format(date=retrieved)
    directory.mkdir(parents=True, exist_ok=True)
    for old in directory.glob("clusters-hr24-*.csv.gz"):
        old.unlink()
    write_gz(directory / name, data)
    entry = {"file": name, "role": "clusters", "sha256": sha256(data), "source_sha256": sha256(strip_comments(raw)),
             "source_bytes": len(raw), "retrieved": retrieved, "query_url": url, "mirror": mirror,
             "vizier_id": VIZIER_ID, "table": TABLE, "rows": len(rows), "columns": list(COLUMNS),
             "citation": CITATION, "licence": LICENCE}
    _write_source(directory, "clusters", entry)


SOURCE_NOTE = ("Pinned inputs of backend/scripts/build_objects_hr23.py. Regenerate with --refresh (both) or "
               "--refresh-members. `sha256` is of the uncompressed committed bytes (the columns used, rows sorted by "
               "ID, and for the members by GaiaDR3); `source_sha256` is of the full original download with its # "
               "comment lines stripped (for the members: of the batches' downloads, each stripped, concatenated in "
               "request order).")


def _write_source(directory: Path, role: str, entry: dict) -> None:
    """Put `entry` (a SOURCE.json files entry) in the role's place, keeping the other role's entry as it is."""
    path = directory / "SOURCE.json"
    old = json.loads(path.read_text(encoding="utf-8"))["files"] if path.is_file() else []
    files = [f for f in old if f.get("role") != role] + [entry]
    files.sort(key=lambda f: f["role"])
    meta = {"dataset": DATASET, "note": SOURCE_NOTE, "files": files}
    path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")


# --- downloading the members -----------------------------------------------------------------

def member_batches(clusters: list[dict]) -> list[list[dict]]:
    """Consecutive clusters (by ID) grouped so that a request names few IDs and returns few rows."""
    batches, cur, rows = [], [], 0
    for c in clusters:
        n = int(_d(c["N"]))
        if cur and (len(cur) >= MEMBERS_BATCH_IDS or rows + n > MEMBERS_BATCH_ROWS):
            batches.append(cur)
            cur, rows = [], 0
        cur.append(c)
        rows += n
    if cur:
        batches.append(cur)
    return batches


def members_url(base: str, ids: list[str]) -> str:
    """ASU list constraint: `ID==2,=3,=4` (the first `=` belongs to the query, the rest to the list)."""
    return base + MEMBERS_QUERY + "=" + ",=".join(ids)


def parse_members_raw(raw: bytes) -> list[dict]:
    """Rows of one members download: header, units and dashes lines, then rows. SystemExit on anything else."""
    # the units line is blank cells separated by tabs, so only truly empty lines are dropped
    lines = [l for l in strip_comments(raw).decode("utf-8", "replace").splitlines() if l != ""]
    if len(lines) < 3 or lines[0].split("\t") != list(MEMBERS_COLUMNS) or not lines[2].lstrip().startswith("-"):
        raise SystemExit("not a members table download")
    rows = []
    for line in lines[3:]:
        cells = [c.strip() for c in line.split("\t")]
        if len(cells) != len(MEMBERS_COLUMNS) or not all(cells) or not cells[0].isdigit() or not cells[1].isdigit() \
                or cells[3] not in ("0", "1"):
            raise SystemExit(f"truncated or malformed row: {line[:80]!r}")
        thousandths(cells[2])
        rows.append(dict(zip(MEMBERS_COLUMNS, cells)))
    return rows


def download_members(clusters: list[dict], log=print) -> tuple[list[dict], bytes, str]:
    """(rows, concatenated stripped downloads, mirrors used) for every cluster in `clusters`. A batch is accepted
    only when each of its clusters has exactly its `N` rows; a mirror that fails is tried last afterwards."""
    mirrors = list(MEMBERS_MIRRORS)
    used: list[str] = []
    rows: list[dict] = []
    raws: list[bytes] = []
    batches = member_batches(clusters)
    for k, batch in enumerate(batches, 1):
        ids = [c["ID"] for c in batch]
        want = {c["ID"]: int(_d(c["N"])) for c in batch}
        errors = []
        for base in list(mirrors):
            try:
                raw = _http_get(members_url(base, ids), timeout=120.0)
                got = parse_members_raw(raw)
                have = Counter(r["ID"] for r in got)
                if dict(have) != want:
                    wrong = [f"ID {i}: {have.get(i, 0)} rows, N = {n}" for i, n in want.items() if have.get(i, 0) != n]
                    raise SystemExit("member counts differ from the clusters table: " + "; ".join(wrong[:5])
                                     + ("" if set(have) <= set(want) else f"; unexpected IDs {sorted(set(have) - set(want))[:5]}"))
            except (RuntimeError, SystemExit) as e:
                errors.append(f"{base}: {e}")
                mirrors.remove(base)
                mirrors.append(base)
                continue
            host = base.split("/viz-bin")[0].removeprefix("https://")
            if host not in used:
                used.append(host)
            rows += got
            raws.append(strip_comments(raw))
            break
        else:
            raise SystemExit(f"refusing the members refresh; batch {k}/{len(batches)} (IDs {ids[0]}..{ids[-1]}) failed "
                             "on every server:\n  " + "\n  ".join(errors))
        if k % 5 == 0 or k == len(batches):
            log(f"  members: batch {k}/{len(batches)}, {len(rows):,} rows so far ({', '.join(used)})")
    return rows, b"".join(raws), ", ".join(used)


def members_extract(rows: list[dict]) -> bytes:
    """The committed members CSV: ID, GaiaDR3, Prob, inrt; rows sorted by numeric ID then numeric GaiaDR3."""
    buf = io.StringIO(newline="")
    w = csv.DictWriter(buf, fieldnames=list(MEMBERS_COLUMNS), lineterminator="\n")
    w.writeheader()
    w.writerows(sorted(rows, key=lambda r: (int(r["ID"]), int(r["GaiaDR3"]))))
    return buf.getvalue().encode("utf-8")


def refresh_members(directory: Path) -> None:
    """Download the members of the clusters within 500 pc and write the snapshot and its SOURCE.json entry."""
    snap = load_snapshot(directory)
    clusters = member_clusters(snap["rows"])
    rows, raw, mirror = download_members(clusters)
    check_member_counts(clusters, rows)
    keys = [(r["ID"], r["GaiaDR3"]) for r in rows]
    if len(set(keys)) != len(keys):
        raise SystemExit("refusing the members refresh: a (cluster, source) pair appears twice")
    data = members_extract(rows)
    retrieved = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    name = MEMBERS_SNAPSHOT.format(date=retrieved)
    for old in directory.glob("members-hr24-*.csv.gz"):
        old.unlink()
    write_gz(directory / name, data)
    entry = {"file": name, "role": "members", "sha256": sha256(data), "source_sha256": sha256(raw),
             "source_bytes": len(raw), "retrieved": retrieved, "mirror": mirror,
             "query_url": ("https://" + mirror.split(", ")[0] + "/viz-bin/asu-tsv" + MEMBERS_QUERY + "=<id>,=<id>,..."),
             "query": (f"ASU list constraint on ID, in batches of up to {MEMBERS_BATCH_IDS} clusters or "
                       f"{MEMBERS_BATCH_ROWS} members, for the {len(clusters)} clusters with dist50 <= "
                       f"{MEMBERS_MAX_DIST_PC} pc in {snap['file']['file']}; every cluster's row count equals its N"),
             "vizier_id": VIZIER_ID, "table": MEMBERS_TABLE, "rows": len(rows), "clusters": len(clusters),
             "columns": list(MEMBERS_COLUMNS), "citation": CITATION, "licence": LICENCE}
    _write_source(directory, "members", entry)


# --- command line ----------------------------------------------------------------------------

def _files(d: Path) -> dict[str, bytes]:
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


def _print_report(m: dict) -> None:
    r = m["build"]["report"]
    print(f"rows read {r['rows_read']}; wrote {r['records_written']} clusters in {len(m['tiles'])} tiles; "
          f"excluded {r['excluded'] or 'none'}")
    print(f"types {r['by_type']}; quality {r['by_quality']}; evidence {r['by_evidence']}")
    print(f"without age {r['without_age']}, extinction {r['without_extinction']}, mass {r['without_mass']}")
    mr = r["members"]
    print(f"members: {mr['clusters']} clusters within {MEMBERS_MAX_DIST_PC} pc, {mr['members']:,} members, "
          f"{mr['members_p50']:,} with Prob >= 0.5; {mr['bytes']:,} bytes on disk "
          f"(cap {MEMBERS_MAX_BYTES:,}), {mr['gzip_bytes']:,} gzipped (gzip -9 of each file, summed); "
          f"largest members/{mr['largest']['id']}.json, {mr['largest']['bytes']:,} bytes")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--sources", type=Path, default=SOURCES, help="directory of the committed snapshot")
    ap.add_argument("--local", type=Path, help="a raw VizieR TSV download (build from it, or refresh from it)")
    ap.add_argument("--refresh", action="store_true", help="download the pinned table (network), rewrite the snapshot, build")
    ap.add_argument("--refresh-members", action="store_true",
                    help="download only the members table (network) for the committed clusters snapshot, rewrite "
                         "its snapshot, build")
    ap.add_argument("--check", action="store_true",
                    help="rebuild into a temp dir, compare with --out and verify it; exit 1 on any difference")
    a = ap.parse_args()
    if a.refresh:
        refresh(a.sources, a.local)
        print(f"snapshot written to {a.sources}")
        a.local = None
    if a.refresh or a.refresh_members:
        refresh_members(a.sources)
        print(f"members snapshot written to {a.sources}")
    if a.check:
        with tempfile.TemporaryDirectory() as tmp:
            build(Path(tmp), a.sources, a.local)
            fresh, have = _files(Path(tmp)), (_files(a.out) if a.out.is_dir() else {})
        diff = sorted(k for k in fresh.keys() | have.keys() if fresh.get(k) != have.get(k))
        src_license = a.sources / "LICENSE.md"
        if not src_license.is_file() or src_license.read_text(encoding="utf-8") != license_text("sources"):
            diff.append(f"{a.sources}/LICENSE.md")
        problems = (objects_static.verify_dataset(a.out) + verify_members(a.out)) if a.out.is_dir() \
            else ["output directory missing"]
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
