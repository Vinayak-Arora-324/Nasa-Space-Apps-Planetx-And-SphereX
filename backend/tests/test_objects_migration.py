"""The /1 -> /2 tile format migration (docs/object-framework.md 19.7, 19.14 item 5).

(a) Permanent: every shipped dataset decodes, re-encodes to the same bytes, and re-writes as /1 to the same records.
(b) Baseline: the records decoded from the shipped /2 tiles equal the records decoded from the last /1 commit.
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest

from spherex_app import objects_static as st

REPO = Path(__file__).resolve().parents[2]
OBJECTS = REPO / "frontend" / "data" / "objects"
DATASETS = ("bh-curated", "galaxies", "hr23-clusters", "nea-exoplanets", "nebulae", "smbh-curated")

# DATASET -> the commit whose /1 tiles it must still decode to (the last /1 commit). A dataset whose data changes
# later in Phase 4 is removed from this dict in that very commit, so the format change and the data changes stay
# separately provable.
BASELINE = {name: "3d12c9c" for name in DATASETS if name not in ("nebulae", "galaxies", "smbh-curated", "hr23-clusters")}
# nebulae: data changed in Phase 4 (Shen HII distances)
# galaxies, smbh-curated: data changed in Phase 4 (CF4 group distances)
# hr23-clusters: data changed in Phase 5 (assets.members on the clusters within 500 pc, section 20.9)

# Manifest keys a dataset build adds after write_dataset (hr23-clusters' member map, section 20.9), and the folders
# beside tiles/ that are not tile data (the member files): the format round trip carries the first and ignores the second.
EXTRA_MANIFEST_KEYS = ("members",)
NON_TILE_DIRS = ("members",)


def _records(path: Path) -> dict[str, dict]:
    """{id: record as served} of a dataset on disk, whatever its format."""
    ds = st.load_dataset(path)
    out = {}
    for t in sorted(ds.manifest["tiles"]):
        for r in st._read_tile(ds, t):
            assert r["id"] not in out
            out[r["id"]] = dict(r)
    return out


def _canon(recs: dict) -> str:
    return json.dumps(recs, sort_keys=True)


def _rewrite(path: Path, out: Path, compact: bool) -> None:
    ds = st.load_dataset(path)
    m = ds.manifest
    sky = {r["id"] for t in (m.get("sky_tiles") or ()) for r in st._read_tile(ds, t)}
    st.write_dataset(list(_records(path).values()), out, dataset=m["dataset"], kinds=m["kinds"],
                     provenance=m["provenance"], build=m["build"], band_deg=m["tiling"]["band_deg"],
                     precedence=m["precedence"], src_table="src_table" in m,
                     record_defaults=m.get("record_defaults"), sky_ids=sky or None, compact=compact)
    extra = {k: m[k] for k in EXTRA_MANIFEST_KEYS if k in m}
    if extra:
        fresh = json.loads((out / st.MANIFEST).read_text(encoding="utf-8"))
        fresh.update(extra)
        (out / st.MANIFEST).write_bytes(st._dumps(fresh).encode("utf-8"))


@pytest.mark.parametrize("name", DATASETS)
def test_shipped_dataset_is_format_2_and_verifies(name):
    assert st.load_dataset(OBJECTS / name).manifest["format"] == "space-maps.object-tiles/2"
    assert st.verify_dataset(OBJECTS / name) == []


@pytest.mark.parametrize("name", DATASETS)
def test_decoded_records_survive_a_format_1_rewrite(name, tmp_path):
    shipped = _records(OBJECTS / name)
    _rewrite(OBJECTS / name, tmp_path / "one", compact=False)
    assert st.load_dataset(tmp_path / "one").manifest["format"] == "space-maps.object-tiles/1"
    assert st.verify_dataset(tmp_path / "one") == []
    back = _records(tmp_path / "one")
    assert back == shipped and _canon(back) == _canon(shipped)


@pytest.mark.parametrize("name", DATASETS)
def test_decoded_records_re_encode_to_the_shipped_bytes(name, tmp_path):
    _rewrite(OBJECTS / name, tmp_path / "two", compact=True)
    shipped = {p.relative_to(OBJECTS / name): p.read_bytes()
               for p in (OBJECTS / name).rglob("*.json")
               if p.relative_to(OBJECTS / name).parts[0] not in NON_TILE_DIRS}
    fresh = {p.relative_to(tmp_path / "two"): p.read_bytes() for p in (tmp_path / "two").rglob("*.json")}
    assert fresh.keys() == shipped.keys()
    assert [k for k in shipped if fresh[k] != shipped[k]] == []


def _baseline_dir(name: str, commit: str, dest: Path) -> Path:
    """Extract the dataset as it was at `commit` (git archive); skips when git or the commit is unavailable."""
    if shutil.which("git") is None:
        pytest.skip("git is not available")
    rel = f"frontend/data/objects/{name}"
    try:
        tar = subprocess.run(["git", "archive", commit, rel], cwd=REPO, check=True, capture_output=True,
                             timeout=120).stdout
    except (subprocess.SubprocessError, OSError):
        pytest.skip(f"commit {commit} is not available")
    with tarfile.open(fileobj=io.BytesIO(tar)) as t:
        t.extractall(dest, filter="data")
    return dest / rel


@pytest.mark.parametrize("name", sorted(BASELINE))
def test_format_2_tiles_decode_to_the_records_the_format_1_tiles_gave(name, tmp_path):
    old = _baseline_dir(name, BASELINE[name], tmp_path)
    assert st.load_dataset(old).manifest["format"] == "space-maps.object-tiles/1"
    before, after = _records(old), _records(OBJECTS / name)
    assert before.keys() == after.keys()
    assert [i for i in before if before[i] != after[i]] == []
    assert _canon(before) == _canon(after)
