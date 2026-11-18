"""Offline tests for backend/scripts/build_objects_hr23.py: synthetic catalogue rows, the committed snapshot
and dataset, and the Melotte_22 example fixture."""

from __future__ import annotations

import gzip
import importlib.util
import json
import sys
from pathlib import Path

import pytest

from spherex_app import objects, objects_static as st

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "backend" / "scripts" / "build_objects_hr23.py"
COMMITTED = ROOT / "frontend" / "data" / "objects" / "hr23-clusters"
EXAMPLES = Path(__file__).parent / "fixtures" / "objects" / "examples"


def _script():
    spec = importlib.util.spec_from_file_location("build_objects_hr23", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["build_objects_hr23"] = mod
    spec.loader.exec_module(mod)
    return mod


b = _script()
PROV = b.provenance("2026-11-18")


def row(name: str = "Test_1", **kw) -> dict:
    r = {c: "" for c in b.COLUMNS}
    r.update(Name=name, ID="1", AllNames=f"{name},Alias_1", Type="o", CST="20.0", N="100",
             RA_ICRS="100.5", DE_ICRS="-20.25", r50="1.0", r50pc="2.0", Plx="5.0", e_Plx="0.5",
             dist16="190", dist50="200", dist84="210", globalPlx="0", CMDCl50="0.8",
             logAge16="8.0", logAge50="9.0", logAge84="9.3", AV16="0.1", AV50="0.2", AV84="0.3",
             rJpc="10", probJ="0.9", MassJ="100", e_MassJ="10", MassTot="120", e_MassTot="12")
    r.update(kw)
    return r


def rec(**kw) -> dict:
    out = b.cluster_record(row(**kw), PROV)
    assert objects.validate_record(out) == []
    return out


def test_parallax_snr_rule_measured_vs_derived():
    hi = rec(Plx="5.0", e_Plx="1.0")           # S/N exactly 5
    lo = rec(Plx="4.9", e_Plx="1.0")
    assert hi["evidence"] == "measured" and hi["position"]["dist"]["tier"] == "measured"
    assert lo["evidence"] == "derived" and lo["position"]["dist"]["tier"] == "inferred"
    assert lo["props"]["parallax_snr"]["v"] == 4.9
    for bad in ({"e_Plx": ""}, {"Plx": ""}, {"e_Plx": "0"}, {"Plx": "-3", "e_Plx": "0.1"}):
        assert rec(**bad)["evidence"] == "derived"


def test_distance_interval_and_global_parallax_note():
    d = rec()["position"]
    assert (d["dist"]["v"], d["dist"]["lo"], d["dist"]["hi"], d["dist"]["unit"]) == (200, 190, 210, "pc")
    assert d["method"] == "cluster-parallax" and d["epoch"] == 2016.0 and d["model"] == "fixed"
    assert "offset" not in d["dist"]["src"]
    assert "offset" in rec(globalPlx="1")["position"]["dist"]["src"]


def test_size_radius_and_angular_extent_is_twice_r50():
    r = rec()
    assert r["size"]["radius"]["v"] == 2.0 and r["size"]["radius"]["unit"] == "pc"
    assert r["size"]["angular"]["major"]["v"] == 2.0 and r["size"]["angular"]["minor"] is None
    assert st.angular_radius_deg(r) == pytest.approx(1.0)


def test_age_conversion_and_tier():
    a = rec()["props"]["age"]
    assert a["v"] == 1.0 and a["lo"] == pytest.approx(0.1) and a["hi"] == pytest.approx(1.99526, rel=1e-4)
    assert a["unit"] == "Gyr" and a["tier"] == "inferred"
    assert "age" not in rec(logAge50="")["props"]
    e = rec()["props"]["extinction"]
    assert (e["v"], e["lo"], e["hi"], e["tier"]) == (0.2, 0.1, 0.3, "inferred")
    assert "extinction" not in rec(AV50="")["props"] and "mass" not in rec(MassTot="")["props"]


def test_common_names_and_designations():
    r = b.cluster_record(row("Melotte_22", AllNames="Melotte_22,M45,Melotte 22"), PROV)
    assert r["name"] == "Pleiades" and r["id"] == "hr23:Melotte_22"
    assert r["designations"] == ["Melotte 22", "M45"]
    assert r["props"]["common_name"]["src"] == "curated common name"
    for key, name in (("Melotte_25", "Hyades"), ("NGC_2632", "Praesepe")):
        assert b.display_name(row(key)) == (name, True)
    assert b.cluster_record(row("Foo_12"), PROV)["name"] == "Foo 12"
    assert b.cluster_record(row("Foo_12"), PROV)["designations"] == ["Foo 12", "Alias 1"]


def test_quality_rule_and_rejected_is_never_reliable():
    q = lambda **kw: rec(**kw)["props"]["quality"]["v"]  # noqa: E731
    assert q() == "reliable"
    assert q(CST="4.99") == "candidate" and q(CST="5", CMDCl50="0.5") == "reliable"
    assert q(CMDCl50="0.49") == "candidate" and q(CMDCl50="") == "candidate"
    assert q(Type="r", Note="galaxy") == "candidate"
    assert not b.is_reliable(row(Type="r", CST="99", CMDCl50="1"))


def test_type_mapping_class_and_note():
    assert rec()["props"]["type"]["v"] == "open cluster" and rec()["props"]["class"]["v"] == "bound cluster"
    m = rec(Type="m")
    assert m["props"]["type"]["v"] == "moving group" and m["props"]["class"]["v"] == "moving group"
    assert rec(Type="g")["props"]["type"]["v"] == "globular cluster" and "class" not in rec(Type="g")["props"]
    d = rec(Type="d")["props"]
    assert "15 kpc" in d["type"]["v"] and "class" not in d
    r = rec(Type="r", Note="Galaxy")["props"]
    assert r["type"]["v"] == "rejected" and r["note"]["v"] == "Galaxy"
    assert "note" not in rec()["props"]


def test_rows_without_position_or_distance_are_excluded_and_counted():
    recs, rep = b.build_records([row(), row("B_2", dist50=""), row("C_3", RA_ICRS="")], "2026-11-18")
    assert len(recs) == 1 and rep["excluded"] == {"missing position or distance": 2}


def test_raw_download_validation_rejects_truncation():
    header = "\t".join(["recno"] + list(b.COLUMNS))
    body = "\n".join([header, "\t".join([" "] * (len(b.COLUMNS) + 1)), "\t".join(["---"] * (len(b.COLUMNS) + 1))])
    with pytest.raises(SystemExit):   # too few rows
        b.check_raw(body.encode(), pinned=False)
    with pytest.raises(SystemExit):   # a cut-off row
        b.parse_raw((body + "\nx\ty").encode())
    assert b.strip_comments(b"#a\nx\n#b\ny\n") == b"x\ny\n"


# --- files: snapshot, reproducibility, --check ------------------------------------------------

def _syn_sources(d: Path, rows: list[dict]) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    import csv
    import io
    buf = io.StringIO(newline="")
    w = csv.DictWriter(buf, fieldnames=list(b.COLUMNS), lineterminator="\n", extrasaction="ignore")
    w.writeheader()
    w.writerows(rows)
    data = buf.getvalue().encode()
    b.write_gz(d / "c.csv.gz", data)
    f = {"file": "c.csv.gz", "sha256": b.sha256(data), "source_sha256": "0" * 64, "retrieved": "2026-11-18",
         "query_url": "https://example.org/q", "mirror": "example.org", "rows": len(rows)}
    (d / "SOURCE.json").write_text(json.dumps({"dataset": "hr23-clusters", "files": [f]}))
    return d


def _tree(d: Path) -> dict:
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


SYN = [row("A_1", ID="1"), row("B_2", ID="2", RA_ICRS="200", Type="m", Plx="1", e_Plx="1"),
       row("Melotte_22", ID="3", RA_ICRS="56.7", DE_ICRS="24.1")]


def test_synthetic_build_is_byte_identical_and_verifies(tmp_path):
    src = _syn_sources(tmp_path / "src", SYN)
    m = b.build(tmp_path / "a", src)
    b.build(tmp_path / "b", src)
    assert _tree(tmp_path / "a") == _tree(tmp_path / "b")
    assert m["dataset"] == "hr23-clusters" and m["kinds"] == ["cluster"] and m["precedence"] == 50
    assert m["tiling"]["band_deg"] == 10 and m["count"] == 3 and m["src_table"] and m["record_defaults"]["provenance"]
    rep = m["build"]["report"]
    assert rep["by_evidence"] == {"derived": 1, "measured": 2} and rep["common_names"] == 1
    assert m["provenance"]["source_rows"] == 3 and m["provenance"]["licence"] == b.LICENCE
    assert st.verify_dataset(tmp_path / "a") == []


def test_check_passes_then_fails_on_a_change(tmp_path, monkeypatch):
    src = _syn_sources(tmp_path / "src", SYN)
    b.build(tmp_path / "out", src)
    monkeypatch.setattr(sys, "argv", ["x", "--check", "--sources", str(src), "--out", str(tmp_path / "out")])
    assert b.main() == 0
    next((tmp_path / "out" / "tiles").glob("*.json")).write_text("{}")
    assert b.main() == 1


def test_gzip_is_deterministic_and_nameless(tmp_path):
    b.write_gz(tmp_path / "a.gz", b"hello\n" * 100)
    assert (tmp_path / "a.gz").read_bytes()[3] == 0 and (tmp_path / "a.gz").read_bytes()[4:8] == b"\0\0\0\0"


@pytest.fixture(scope="module")
def snapshot():
    return b.load_snapshot(b.SOURCES)


def test_committed_snapshot_matches_source_json(snapshot):
    f = snapshot["file"]
    assert f["rows"] == b.EXPECTED_ROWS == len(snapshot["rows"]) and f["source_sha256"] == b.EXPECTED_SHA256
    assert len({r["Name"] for r in snapshot["rows"]}) == b.EXPECTED_ROWS
    assert "Hunt & Reffert 2024" in f["citation"] and f["licence"] == b.LICENCE


def test_committed_dataset_is_current_and_valid(tmp_path):
    b.build(tmp_path / "again")
    assert _tree(tmp_path / "again") == _tree(COMMITTED)
    assert st.verify_dataset(COMMITTED) == []


def test_committed_manifest_report(snapshot):
    m = json.loads((COMMITTED / "manifest.json").read_text())
    rep = m["build"]["report"]
    assert m["count"] == rep["records_written"] == rep["rows_read"] == 7167 and m["kinds"] == ["cluster"]
    assert rep["by_type"] == {"globular cluster": 132, "moving group": 1309, "open cluster": 5647,
                              "rejected": 17, "too distant (d >= 15 kpc)": 62}
    assert rep["by_quality"]["reliable"] == 4100 and rep["by_quality"]["reliable"] + rep["by_quality"]["candidate"] == 7167
    assert rep["by_evidence"] == {"derived": 97, "measured": 7070}
    assert rep["without_age"] == rep["without_extinction"] == rep["without_mass"] == 211
    assert 22 < m["max_extent_deg"] < 23
    assert m["provenance"]["source_sha256"] == b.EXPECTED_SHA256


def test_the_cluster_example_equals_the_built_melotte_22(snapshot):
    built = b.cluster_record(next(r for r in snapshot["rows"] if r["Name"] == "Melotte_22"),
                             b.provenance(snapshot["file"]["retrieved"]))
    example = json.loads((EXAMPLES / "cluster.json").read_text())
    assert example == built
    assert objects.validate_record(example) == []
    assert example["name"] == "Pleiades" and example["props"]["n_members"]["v"] == 1721
    ds = st.load_dataset(COMMITTED)
    tile = [r for t in ds.manifest["tiles"] for r in st._read_tile(ds, t) if r["id"] == "hr23:Melotte_22"]
    assert tile == [example]
