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

def mrow(cid: str, gaia: int, prob: str, inrt: int = 1) -> dict:
    return {"ID": cid, "GaiaDR3": str(gaia), "Prob": prob, "inrt": str(inrt)}


# cluster 1 (A_1, 200 pc, N 4), cluster 3 (Melotte_22, 200 pc, N 3); cluster 2 (B_2, 800 pc) has no member file.
# Source ids are given out of order and straddle 2^53; the probabilities test the thousandths rounding.
SYN_MEMBERS = [mrow("1", 9007199254740993, "0.5004999999"), mrow("1", 1000, "0.4999", 0), mrow("1", 500, "0.5"),
               mrow("1", 45000919277665536, "0.9999999999", 1),
               mrow("3", 77, "0.0004"), mrow("3", 76, "0.0005"), mrow("3", 75, "1.000000000000000000")]


def _write_snapshot(d: Path, name: str, role: str, cols, rows: list[dict]) -> dict:
    import csv
    import io
    buf = io.StringIO(newline="")
    w = csv.DictWriter(buf, fieldnames=list(cols), lineterminator="\n", extrasaction="ignore")
    w.writeheader()
    w.writerows(rows)
    data = buf.getvalue().encode()
    b.write_gz(d / name, data)
    return {"file": name, "role": role, "sha256": b.sha256(data), "source_sha256": "0" * 64, "retrieved": "2026-11-18",
            "query_url": "https://example.org/q", "mirror": "example.org", "rows": len(rows)}


def _syn_sources(d: Path, rows: list[dict], members: list[dict] | None = None) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    files = [_write_snapshot(d, "c.csv.gz", "clusters", b.COLUMNS, rows),
             _write_snapshot(d, "m.csv.gz", "members", b.MEMBERS_COLUMNS, SYN_MEMBERS if members is None else members)]
    (d / "SOURCE.json").write_text(json.dumps({"dataset": "hr23-clusters", "files": files}))
    return d


def _tree(d: Path) -> dict:
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


SYN = [row("A_1", ID="1", N="4"), row("B_2", ID="2", RA_ICRS="200", Type="m", Plx="1", e_Plx="1", dist50="800", N="5"),
       row("Melotte_22", ID="3", RA_ICRS="56.7", DE_ICRS="24.1", N="3")]


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
    assert st.verify_dataset(tmp_path / "a") == [] and b.verify_members(tmp_path / "a") == []


def _all_records(path: Path) -> dict:
    ds = st.load_dataset(path)
    return {r["id"]: r for t in ds.manifest["tiles"] for r in st._read_tile(ds, t)}


def test_member_files_from_a_synthetic_snapshot(tmp_path):
    src = _syn_sources(tmp_path / "src", SYN)
    m = b.build(tmp_path / "out", src)
    assert sorted(p.name for p in (tmp_path / "out" / "members").iterdir()) == ["1.json", "3.json"]   # B_2 is at 800 pc
    raw = (tmp_path / "out" / "members" / "1.json").read_bytes()
    assert raw.endswith(b"\n") and b", " not in raw.split(b"\"members\":")[1] and b"\": " not in raw          # compact
    one = json.loads(raw)
    assert list(one) == ["format", "cluster", "src", "n", "n_p50", "members"]
    assert one["format"] == "space-maps.cluster-members/1" and one["cluster"] == "hr23:A_1"
    assert one["src"] == ("Hunt & Reffert 2024, table 2 (J/A+A/686/A42/members); "
                          "probabilities truncated to thousandths")
    # sorted by numeric id (not as strings), ids are strings, probabilities are integer thousandths, truncated
    assert one["members"] == [["500", 500, 1], ["1000", 499, 0], ["9007199254740993", 500, 1],
                              ["45000919277665536", 999, 1]]
    # n_p50 counts Prob >= 0.5: 0.5, 0.5004999999 and 0.9999999999, not 0.4999; it equals the stored values >= 500
    assert one["n"] == 4 and one["n_p50"] == 3 == sum(1 for _, p, _ in one["members"] if p >= 500)
    three = json.loads((tmp_path / "out" / "members" / "3.json").read_text())
    assert three["members"] == [["75", 1000, 1], ["76", 0, 1], ["77", 0, 1]] and three["n"] == 3 and three["n_p50"] == 1
    # assets on exactly the clusters within 500 pc; no other record changes
    recs = _all_records(tmp_path / "out")
    assert recs["hr23:A_1"]["assets"] == {"members": "members/1.json"}
    assert recs["hr23:Melotte_22"]["assets"] == {"members": "members/3.json"}
    assert "assets" not in recs["hr23:B_2"]
    assert all(objects.validate_record(r) == [] for r in recs.values())
    mm = m["members"]
    assert mm["max_dist_pc"] == 500 and mm["count"] == 2 and mm["members"] == 7
    assert mm["files"] == {"1": {"n": 4, "sha256": b.sha256(raw)},
                           "3": {"n": 3, "sha256": b.sha256((tmp_path / "out" / "members" / "3.json").read_bytes())}}
    assert json.loads((tmp_path / "out" / "manifest.json").read_text())["members"] == mm
    rep = m["build"]["report"]["members"]
    assert rep["clusters"] == 2 and rep["members"] == 7 and rep["members_p50"] == 4
    assert rep["bytes"] == sum(p.stat().st_size for p in (tmp_path / "out" / "members").iterdir())
    assert rep["largest"]["id"] == "1" and 0 < rep["gzip_bytes"]
    assert m["provenance"]["members"]["table"] == b.MEMBERS_TABLE and m["provenance"]["members"]["max_dist_pc"] == 500
    assert m["build"]["script_version"] == 2


def test_member_counts_must_equal_n(tmp_path):
    src = _syn_sources(tmp_path / "src", SYN, SYN_MEMBERS[:-1])         # cluster 3 is one member short
    with pytest.raises(SystemExit, match="Melotte_22.*2 member rows, N = 3"):
        b.build(tmp_path / "out", src)
    extra = SYN_MEMBERS + [mrow("2", 5, "0.9")]
    with pytest.raises(SystemExit, match="not within 500 pc"):
        b.build(tmp_path / "out2", _syn_sources(tmp_path / "src2", SYN, extra))


def test_the_size_cap_fails_the_build(tmp_path, monkeypatch):
    src = _syn_sources(tmp_path / "src", SYN)
    monkeypatch.setattr(b, "MEMBERS_MAX_BYTES", 100)
    with pytest.raises(SystemExit, match=r"above the 100 byte cap.*stop and ask"):
        b.build(tmp_path / "out", src)
    assert not (tmp_path / "out" / "members").exists()


def test_check_covers_member_files(tmp_path, monkeypatch):
    src = _syn_sources(tmp_path / "src", SYN)
    out = tmp_path / "out"
    b.build(out, src)
    (src / "LICENSE.md").write_text(b.license_text("sources"), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["x", "--check", "--sources", str(src), "--out", str(out)])
    assert b.main() == 0
    orig = (out / "members" / "1.json").read_bytes()
    (out / "members" / "1.json").write_bytes(orig.replace(b"500", b"501", 1))   # a changed member
    assert b.main() == 1
    (out / "members" / "1.json").write_bytes(orig)
    (out / "members" / "9.json").write_text("{}")                                # an extra file
    assert b.main() == 1
    (out / "members" / "9.json").unlink()
    (out / "members" / "3.json").unlink()                                        # a missing file
    assert b.main() == 1
    assert any("missing on disk" in p for p in b.verify_members(out))


def test_check_passes_then_fails_on_a_change(tmp_path, monkeypatch):
    src = _syn_sources(tmp_path / "src", SYN)
    b.build(tmp_path / "out", src)
    (src / "LICENSE.md").write_text(b.license_text("sources"), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["x", "--check", "--sources", str(src), "--out", str(tmp_path / "out")])
    assert b.main() == 0
    next((tmp_path / "out" / "tiles").glob("*.json")).write_text("{}")
    assert b.main() == 1


def test_members_download_helpers():
    assert b.members_url("https://h/viz-bin/asu-tsv", ["2", "3", "4"]).endswith("&ID==2,=3,=4")
    clusters = [row(f"C_{i}", ID=str(i), N="7000") for i in range(1, 6)]
    assert [[c["ID"] for c in bt] for bt in b.member_batches(clusters)] == [["1", "2"], ["3", "4"], ["5"]]
    raw = (b"#c\n\nID\tGaiaDR3\tProb\tinrt\n \t \t \t\n----\t---\t---\t-\n"
           b"   2\t5601593074416727552\t 0.634451492972257669\t1\n   2\t7\t 0.5\t0\n")
    assert b.parse_members_raw(raw) == [mrow("2", 5601593074416727552, "0.634451492972257669"), mrow("2", 7, "0.5", 0)]
    with pytest.raises(SystemExit):
        b.parse_members_raw(raw + b"   2\t8\n")                     # a cut-off row
    with pytest.raises(SystemExit):
        b.parse_members_raw(b"<!doctype html>\n<html>")             # a mirror's error page
    assert b.thousandths("0.0005") == 0 and b.thousandths("0.4999") == 499 and b.thousandths("1.0") == 1000
    assert b.thousandths("0.5") == b.thousandths(" 0.500000000000000000".strip()) == 500
    assert b.thousandths("0.499999999999999999") == 499 and b.thousandths("0.999999999999999999") == 999


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


def test_committed_members_snapshot(snapshot):
    mf, rows = snapshot["members_file"], snapshot["member_rows"]
    assert mf["table"] == "J/A+A/686/A42/members" and mf["licence"] == b.LICENCE and mf["role"] == "members"
    assert mf["rows"] == len(rows) == 89738 and mf["clusters"] == 695
    assert mf["file"].startswith("members-hr24-") and mf["mirror"] and mf["source_sha256"] and mf["retrieved"]
    keys = [(int(r["ID"]), int(r["GaiaDR3"])) for r in rows]
    assert keys == sorted(set(keys))                                                # sorted, no duplicate
    clusters = b.member_clusters(snapshot["rows"])
    assert len(clusters) == 695 and sum(int(c["N"]) for c in clusters) == 89738      # docs 20.2
    b.check_member_counts(clusters, rows)


def test_pleiades_member_file_is_the_hr24_count():
    one = json.loads((COMMITTED / "members" / "4423.json").read_text())
    assert one["cluster"] == "hr23:Melotte_22" and one["n"] == 1721 and one["n_p50"] == 1014 == (
        sum(1 for _, p, _ in one["members"] if p >= 500))
    assert len(one["members"]) == 1721 and all(isinstance(m[0], str) for m in one["members"])
    ids = [int(m[0]) for m in one["members"]]
    assert ids == sorted(ids)
    rec = _all_records(COMMITTED)["hr23:Melotte_22"]
    assert rec["assets"] == {"members": "members/4423.json"}


def test_committed_member_assets_and_size_cap():
    m = json.loads((COMMITTED / "manifest.json").read_text())
    mm = m["members"]
    assert mm["max_dist_pc"] == 500 and mm["count"] == 695 and mm["members"] == 89738 and len(mm["files"]) == 695
    assert mm["files"]["4423"]["n"] == 1721
    rep = m["build"]["report"]["members"]
    assert rep["bytes"] == sum(p.stat().st_size for p in (COMMITTED / "members").iterdir()) <= b.MEMBERS_MAX_BYTES
    assert b.verify_members(COMMITTED) == []
    assert mm["prob"] == "truncated to thousandths"
    for p in (COMMITTED / "members").iterdir():          # stored >= 500 is exactly n_p50 in every file
        d = json.loads(p.read_text())
        assert d["n_p50"] == sum(1 for _, pr, _ in d["members"] if pr >= 500), p.name
    with_assets = {rid for rid, r in _all_records(COMMITTED).items() if "assets" in r}
    assert len(with_assets) == 695


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
    # copies: _read_tile's records are cached, and popping from them would change what later tests read
    tile = [dict(r) for t in ds.manifest["tiles"] for r in st._read_tile(ds, t) if r["id"] == "hr23:Melotte_22"]
    assert tile[0].pop("assets") == {"members": "members/4423.json"}      # the only difference: the members asset
    assert tile == [example]


def test_credit_and_licence_files():
    p = json.loads((COMMITTED / "manifest.json").read_text())["provenance"]
    assert p["credit"] == "Hunt & Reffert 2024, from Gaia DR3 (Credit: ESA/Gaia/DPAC)"
    assert "licence_name" not in p and p["licence"] == b.LICENCE
    for folder, which in ((b.SOURCES, "sources"), (COMMITTED, "dataset")):
        text = (folder / "LICENSE.md").read_text(encoding="utf-8")
        assert text == b.license_text(which)
        for needle in ("VizieR", b.CITATION, "Gaia DR3", "Credit: ESA/Gaia/DPAC", "Nothing is relicensed", "MIT",
                       "CC BY-NC 3.0 IGO", "members"):
            assert needle in text, (which, needle)


def test_licence_text_names_the_members_folder():
    ds = b.license_text("dataset")
    assert "frontend/data/objects/hr23-clusters/members/" in ds and "`members/*.json`" in ds
    assert "Gaia-derived" in ds and "J/A+A/686/A42/members" in ds
    assert "members-hr24-*.csv.gz" in b.license_text("sources")
