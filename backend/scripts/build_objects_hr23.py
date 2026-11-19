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

`--refresh` tries the CDS server and then the CfA mirror (the mirror is intermittent and can return a truncated
file), and rejects a download unless it has exactly 7,167 rows and the pinned sha256. `--check` exits 1 when the
committed dataset differs from a fresh build, or fails `objects_static.verify_dataset`.

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
from decimal import Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from spherex_app import objects, objects_static  # noqa: E402

DATASET = "hr23-clusters"
OUT = ROOT / "frontend" / "data" / "objects" / DATASET
SOURCES = ROOT / "backend" / "data" / "sources" / DATASET
SCRIPT = "backend/scripts/build_objects_hr23.py"
SCRIPT_VERSION = 1

VIZIER_ID = "J/A+A/686/A42"
TABLE = "J/A+A/686/A42/clusters"
QUERY = "?-source=J/A%2BA/686/A42/clusters&-out.max=unlimited&-out.all"
MIRRORS = ("https://vizier.cds.unistra.fr/viz-bin/asu-tsv", "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv")
EXPECTED_ROWS = 7167
EXPECTED_SHA256 = "0469c5baec7ccf0431aeb129fb0b06507eee55d499453717a759c8e0ab55d579"
SNAPSHOT = "clusters-hr24-{date}.csv.gz"

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


def load_snapshot(directory: Path) -> dict:
    meta = json.loads((directory / "SOURCE.json").read_text(encoding="utf-8"))
    f = meta["files"][0]
    data = gzip.decompress((directory / f["file"]).read_bytes())
    if sha256(data) != f["sha256"]:
        raise SystemExit(f"{f['file']}: sha256 differs from SOURCE.json")
    return {"meta": meta, "file": f, "rows": read_csv_bytes(data)}


def provenance_full(f: dict, *, version: str | None = None) -> dict:
    return {"catalogue": CATALOGUE, "version": version or f"{VIZIER_ID}, retrieved {f['retrieved']}",
            "vizier_id": VIZIER_ID, "table": TABLE, "citation": CITATION, "licence": LICENCE, "url": URL,
            "query_url": f["query_url"], "mirror": f.get("mirror"), "retrieved": f["retrieved"],
            "source_sha256": f["source_sha256"], "source_rows": f["rows"], "snapshot_file": f["file"],
            "snapshot_sha256": f["sha256"],
            # derived by Hunt & Reffert from Gaia DR3; the VizieR terms stay the licence, so no licence_name
            "credit": f"Hunt & Reffert 2024, from Gaia DR3 ({GAIA_CREDIT})"}


def license_text(which: str) -> str:
    """The LICENSE.md of the sources folder (`which == "sources"`) or of the built dataset (`"dataset"`)."""
    if which == "sources":
        folder = "backend/data/sources/hr23-clusters/"
        covered = ("- `clusters-hr24-*.csv.gz`: the Hunt & Reffert 2024 cluster table from VizieR "
                   f"({VIZIER_ID}), columns selected;\n"
                   "- `SOURCE.json`, the input's hash, URL and retrieval date;\n- this file.")
    else:
        folder = "frontend/data/objects/hr23-clusters/"
        covered = "- `manifest.json`;\n- `tiles/*.json`, the cluster records;\n- this file."
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

## Code

The code that builds these files (`backend/scripts/build_objects_hr23.py`) and the rest of the repository are
under the MIT licence (see the repository `LICENSE`).
"""


def build_from(rows: list[dict], prov_full: dict, snapshot_date: str, out_dir: Path) -> dict:
    records, report = build_records(rows, snapshot_date)
    m = objects_static.write_dataset(
        records, out_dir, dataset=DATASET, kinds=["cluster"], provenance=prov_full,
        build={"script": SCRIPT, "script_version": SCRIPT_VERSION, "report": report},
        band_deg=10, precedence=50, src_table=True, record_defaults={"provenance": provenance(snapshot_date)})
    (Path(out_dir) / "LICENSE.md").write_text(license_text("dataset"), encoding="utf-8")
    return m


def build(out_dir: Path, sources: Path = SOURCES, local: Path | None = None) -> dict:
    """Build the dataset into `out_dir` from the committed snapshot (or from a raw VizieR TSV)."""
    snap = load_snapshot(sources)
    f = snap["file"]
    if local is None:
        return build_from(snap["rows"], provenance_full(f), f["retrieved"], out_dir)
    raw = local.read_bytes()
    rows = check_raw(raw, pinned=False)
    stripped = sha256(strip_comments(raw))
    full = dict(provenance_full(f, version=f"{VIZIER_ID}, local file {local.name}"), retrieved=None,
                query_url=None, mirror=None, source_sha256=stripped, source_rows=len(rows),
                snapshot_file=None, snapshot_sha256=sha256(extract(rows)))
    return build_from(read_csv_bytes(extract(rows)), full, f"local {stripped[:12]}", out_dir)


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
    for old in directory.glob("*"):
        old.unlink()
    write_gz(directory / name, data)
    meta = {"dataset": DATASET,
            "note": "Pinned input of backend/scripts/build_objects_hr23.py. Regenerate with --refresh. `sha256` is "
                    "of the uncompressed committed bytes (the columns used, rows sorted by ID); `source_sha256` is "
                    "of the full original download with its # comment lines stripped.",
            "files": [{"file": name, "role": "clusters", "sha256": sha256(data), "source_sha256": sha256(strip_comments(raw)),
                       "source_bytes": len(raw), "retrieved": retrieved, "query_url": url, "mirror": mirror,
                       "vizier_id": VIZIER_ID, "table": TABLE, "rows": len(rows), "columns": list(COLUMNS),
                       "citation": CITATION, "licence": LICENCE}]}
    (directory / "SOURCE.json").write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")


# --- command line ----------------------------------------------------------------------------

def _files(d: Path) -> dict[str, bytes]:
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


def _print_report(m: dict) -> None:
    r = m["build"]["report"]
    print(f"rows read {r['rows_read']}; wrote {r['records_written']} clusters in {len(m['tiles'])} tiles; "
          f"excluded {r['excluded'] or 'none'}")
    print(f"types {r['by_type']}; quality {r['by_quality']}; evidence {r['by_evidence']}")
    print(f"without age {r['without_age']}, extinction {r['without_extinction']}, mass {r['without_mass']}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--sources", type=Path, default=SOURCES, help="directory of the committed snapshot")
    ap.add_argument("--local", type=Path, help="a raw VizieR TSV download (build from it, or refresh from it)")
    ap.add_argument("--refresh", action="store_true", help="download the pinned table (network), rewrite the snapshot, build")
    ap.add_argument("--check", action="store_true",
                    help="rebuild into a temp dir, compare with --out and verify it; exit 1 on any difference")
    a = ap.parse_args()
    if a.refresh:
        refresh(a.sources, a.local)
        print(f"snapshot written to {a.sources}")
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
    (a.sources / "LICENSE.md").write_text(license_text("sources"), encoding="utf-8")
    _print_report(m)
    print(f"wrote {m['count']} records to {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
