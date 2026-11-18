"""Offline tests for static object datasets (spherex_app.objects_static): tiling, loading, queries."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import math
import random
import shutil
import sys
from pathlib import Path

import pytest

from spherex_app import config, objects, objects_static as st

FIXTURES = Path(__file__).parent / "fixtures" / "objects"
FIXTURE = FIXTURES / "fixture-clusters"
SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_objects_fixture.py"


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    objects.reset_sources()
    yield
    objects.reset_sources()


def _script():
    spec = importlib.util.spec_from_file_location("build_objects_fixture", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["build_objects_fixture"] = mod
    spec.loader.exec_module(mod)
    return mod


def _cluster(i: str, ra: float, dec: float, diam: float | None = None) -> dict:
    ang = None if diam is None else {
        "major": objects.quantity(diam, "synthetic", "illustrative", "deg"), "minor": None, "pa": None}
    return objects.record(
        id=f"test:{i}", kind="cluster", name=i,
        position={"model": "fixed", "ra": ra, "dec": dec, "method": "assumed",
                  "dist": objects.quantity(100, "synthetic", "illustrative", "pc")},
        size={"radius": None, "angular": ang},
        provenance={"source": "static:t", "catalogue": "t"}, evidence="illustrative")


def _write(tmp: Path, recs: list[dict], band: float = 10) -> Path:
    st.write_dataset(recs, tmp, dataset="t", kinds=["cluster"], provenance={"catalogue": "t"},
                     build={"script": "x", "script_version": 1}, band_deg=band)
    return tmp


# --- tiling maths -----------------------------------------------------------------------------

def test_tile_of_a_point():
    assert st.tile_of(0.0, -90.0) == "0-0"
    assert st.tile_of(200.0, 0.0) == "9-20"   # band 9 is [0, 10): cos(5 deg) -> 36 bins of 10 deg
    assert st.tile_of(45.0, 20.0) == "11-4"   # dec exactly on a band edge belongs to the upper band
    assert st.tile_of(45.0, 19.999999) == "10-4"
    assert st.tile_of(359.9, 10.0) == "10-34"
    assert st.tile_of(0.1, 10.2) == "10-0"
    assert st.tile_of(360.0, 0.0) == st.tile_of(0.0, 0.0)


def test_last_band_includes_the_north_pole_and_the_poles_have_few_bins():
    assert st.tile_of(10.0, 90.0).startswith("17-")
    assert st.tile_of(10.0, -90.0).startswith("0-")
    bands = {}
    for ra in range(0, 360, 5):
        for dec in (-89.5, 0.0, 89.5):
            bands.setdefault(dec, set()).add(st.tile_of(ra, dec))
    assert len(bands[89.5]) == 3 and len(bands[-89.5]) == 3 and len(bands[0.0]) == 36


def test_tile_bounds_contain_the_points_they_hold():
    rng = random.Random(1)
    for _ in range(2000):
        ra, dec = rng.uniform(0, 360), math.degrees(math.asin(rng.uniform(-1, 1)))
        ra_lo, ra_hi, dec_lo, dec_hi = st.tile_bounds(st.tile_of(ra, dec))
        assert ra_lo <= ra <= ra_hi and dec_lo <= dec <= dec_hi


def test_tiles_tile_the_sky_without_gaps():
    # every tile name from a fine grid of points is one of the tiles a whole-sky cone returns
    everything = set(st.tiles_for_cone(0.0, 0.0, 180.0))
    for ra in range(0, 360, 3):
        for dec in range(-90, 91, 3):
            assert st.tile_of(ra, dec) in everything


@pytest.mark.parametrize("ra,dec,radius,margin", [
    (0.0, 0.0, 0.5, 0.0), (359.95, 10.0, 0.3, 0.0), (0.05, 10.0, 3.0, 0.0),
    (120.0, 89.9, 0.5, 0.0), (10.0, -89.8, 1.0, 0.0), (45.0, 20.0, 0.1, 0.0),
    (180.0, 0.0, 5.0, 4.0), (0.0, 90.0, 5.0, 0.0), (0.0, -90.0, 0.1, 0.0), (359.99, -45.0, 5.0, 2.0),
])
def test_tiles_for_cone_cover_every_point_of_the_grown_cone(ra, dec, radius, margin):
    tiles = set(st.tiles_for_cone(ra, dec, radius, 10, margin))
    reach = radius + margin
    rng = random.Random(7)
    for _ in range(4000):
        # a random point within `reach` of the centre
        d = reach * math.sqrt(rng.random())
        pa = rng.uniform(0, 2 * math.pi)
        dec2 = math.degrees(math.asin(
            math.sin(math.radians(dec)) * math.cos(math.radians(d))
            + math.cos(math.radians(dec)) * math.sin(math.radians(d)) * math.cos(pa)))
        ra2 = math.degrees(math.radians(ra) + math.atan2(
            math.sin(pa) * math.sin(math.radians(d)) * math.cos(math.radians(dec)),
            math.cos(math.radians(d)) - math.sin(math.radians(dec)) * math.sin(math.radians(dec2)))) % 360
        assert st.tile_of(ra2, dec2) in tiles, (ra2, dec2)


def test_tiles_for_cone_is_selective():
    tiles = st.tiles_for_cone(180.0, 0.0, 0.5, 10, 0.0)
    assert 1 <= len(tiles) <= 4
    assert "10-34" in st.tiles_for_cone(0.05, 10.0, 0.3, 10, 0.0)       # across the RA wrap
    assert "10-0" in st.tiles_for_cone(359.95, 10.0, 0.3, 10, 0.0)
    assert any(t.startswith("17-") for t in st.tiles_for_cone(5.0, 89.9, 0.5, 10, 0.0))
    # near the pole the cone reaches every RA bin of the polar band
    assert {t for t in st.tiles_for_cone(5.0, 89.9, 0.5, 10, 0.0) if t.startswith("17-")} == \
        {"17-0", "17-1", "17-2"}


def test_band_edge_cone_includes_both_bands():
    tiles = st.tiles_for_cone(45.0, 20.0, 0.05, 10, 0.0)
    assert any(t.startswith("10-") for t in tiles) and any(t.startswith("11-") for t in tiles)


def test_other_band_widths_work():
    for band in (5, 7.5, 30):
        for ra, dec in ((0.0, 0.0), (359.9, 89.9), (12.0, -90.0), (200.0, 33.0)):
            tiles = set(st.tiles_for_cone(ra, dec, 1.0, band, 0.0))
            assert st.tile_of(ra, dec, band) in tiles


# --- queries over a built dataset -------------------------------------------------------------

def test_every_record_inside_a_cone_is_found_extent_included(tmp_path):
    rng = random.Random(3)
    recs = [_cluster(f"r{i}", rng.uniform(0, 360), math.degrees(math.asin(rng.uniform(-1, 1))),
                     rng.choice([None, None, 0.5, 3.0])) for i in range(400)]
    # plant records at the awkward places
    recs += [_cluster("np", 33.0, 89.95, 1.0), _cluster("sp", 211.0, -89.9), _cluster("w1", 359.99, 0.0, 2.0),
             _cluster("w2", 0.01, 0.0), _cluster("edge", 100.0, 30.0, 4.0)]
    ds = st.load_dataset(_write(tmp_path / "t", recs))
    assert ds.manifest["max_extent_deg"] == 2.0
    for _ in range(300):
        ra, dec = rng.uniform(0, 360), math.degrees(math.asin(rng.uniform(-1, 1)))
        radius = rng.uniform(0.1, 5.0)
        want = {r["id"] for r in recs if objects.cone_contains(r, ra, dec, radius)}
        got = {r["id"] for r in st.cone_query(ds, ra, dec, radius)}
        assert got == want, (ra, dec, radius)
    for ra, dec in ((0.0, 0.0), (0.0, 90.0), (0.0, -90.0), (359.99, 0.0), (100.0, 33.0)):
        want = {r["id"] for r in recs if objects.cone_contains(r, ra, dec, 5.0)}
        assert {r["id"] for r in st.cone_query(ds, ra, dec, 5.0)} == want


def test_the_extent_margin_matters(tmp_path):
    big = _cluster("big", 100.0, 30.0, 6.0)  # radius 3 deg
    ds = st.load_dataset(_write(tmp_path / "t", [big]))
    # a cone 3.5 deg away, in a different band and bin, still touches the object's disc
    assert [r["id"] for r in st.cone_query(ds, 100.0, 33.5, 1.0)] == ["test:big"]
    assert st.cone_query(ds, 100.0, 35.0, 1.0) == []


# --- the fixture dataset ----------------------------------------------------------------------

def test_fixture_dataset_loads_and_is_marked_synthetic():
    ds = st.load_dataset(FIXTURE)
    m = ds.manifest
    assert m["dataset"] == "fixture-clusters" and m["kinds"] == ["cluster"] and m["count"] == 6
    assert len(m["tiles"]) >= 3 and m["max_extent_deg"] > 0
    assert m["provenance"]["catalogue"] == "Space Maps test fixture (synthetic)"
    recs = [r for t in m["tiles"] for r in st._read_tile(ds, t)]
    assert len(recs) == 6 and all(r["id"].startswith("test:") for r in recs)
    for r in recs:
        assert objects.validate_record(r) == []
        assert r["evidence"] == "illustrative" and r["position"]["dist"]["tier"] == "illustrative"
        assert r["position"]["model"] == "fixed" and r["host"] is None
    assert any(r["position"]["dec"] > 85 for r in recs) and any(r["position"]["dec"] < -85 for r in recs)
    assert any(r["position"]["ra"] > 359 for r in recs) and any(r["position"]["ra"] < 1 for r in recs)


def test_fixture_cone_queries():
    ds = st.load_dataset(FIXTURE)
    ids = lambda ra, dec, r: sorted(x["id"] for x in st.cone_query(ds, ra, dec, r))  # noqa: E731
    assert ids(180.0, 0.0, 0.5) == ["test:mid-sky"]
    assert ids(0.0, 10.1, 0.5) == ["test:wrap-east", "test:wrap-west"]
    assert ids(0.0, 90.0, 1.0) == ["test:north-pole"]
    assert ids(0.0, -90.0, 1.0) == ["test:south-pole"]
    # wrap-east has a 2 deg radius: a cone 2.3 deg away still reaches it, but not wrap-west
    assert ids(0.1, 12.5, 0.5) == ["test:wrap-east"]
    assert ids(90.0, 0.0, 1.0) == []


def test_fixture_is_verified_clean():
    assert st.verify_dataset(FIXTURE) == []


def test_rebuilding_the_fixture_is_byte_identical(tmp_path):
    mod = _script()
    mod.build(tmp_path / "a")
    mod.build(tmp_path / "b")
    fa, fb = mod._files(tmp_path / "a"), mod._files(tmp_path / "b")
    assert fa == fb
    assert fa == mod._files(FIXTURE)  # and equal to the committed output


def test_manifest_sha256_matches_every_tile():
    import hashlib
    m = json.loads((FIXTURE / "manifest.json").read_text())
    for name, info in m["tiles"].items():
        data = (FIXTURE / "tiles" / f"{name}.json").read_bytes()
        assert hashlib.sha256(data).hexdigest() == info["sha256"]


def test_a_tampered_tile_fails_verification(tmp_path):
    shutil.copytree(FIXTURE, tmp_path / "d")
    tile = next((tmp_path / "d" / "tiles").glob("*.json"))
    tile.write_text(tile.read_text().replace("Fixture", "Tampered"))
    assert any("sha256" in p for p in st.verify_dataset(tmp_path / "d"))


def test_check_mode_flags_a_difference(tmp_path, monkeypatch):
    mod = _script()
    shutil.copytree(FIXTURE, tmp_path / "d")
    monkeypatch.setattr(sys, "argv", ["x", "--check", "--out", str(tmp_path / "d")])
    assert mod.main() == 0
    next((tmp_path / "d" / "tiles").glob("*.json")).write_text("{}")
    assert mod.main() == 1


# --- write_dataset ----------------------------------------------------------------------------

def test_write_is_sorted_compact_and_free_of_timestamps(tmp_path):
    out = _write(tmp_path / "t", [_cluster("b", 10.0, 5.0), _cluster("a", 10.5, 5.5)])
    text = (out / "tiles" / "9-1.json").read_text()
    assert text.index("test:a") < text.index("test:b")
    assert ", " not in text and ": " not in text
    assert "time" not in (out / "manifest.json").read_text().replace("sha256", "")


@pytest.mark.parametrize("mutate,msg", [
    (lambda r: r.update(host="ss:sun"), "host"),
    (lambda r: r["position"].update(ra=999), "ra"),
    (lambda r: r.update(in_cone=True), "in_cone"),
    (lambda r: r.update(kind="galaxy"), "kind"),
    (lambda r: r.update(evidence="measured"), "evidence"),
])
def test_write_rejects_bad_records(tmp_path, mutate, msg):
    r = _cluster("a", 10.0, 5.0)
    mutate(r)
    with pytest.raises(ValueError, match=msg):
        _write(tmp_path / "t", [r])
    assert not (tmp_path / "t" / "manifest.json").exists()


def test_write_rejects_non_fixed_positions_and_duplicates(tmp_path):
    orbit = _planet("a", 10.0, 5.0)
    orbit["kind"] = "cluster"   # an orbit position is only for hosted kinds
    with pytest.raises(ValueError, match="fixed"):
        st.write_dataset([orbit], tmp_path / "x", dataset="t", kinds=["cluster"],
                         provenance={}, build={})
    with pytest.raises(ValueError, match="duplicate"):
        _write(tmp_path / "y", [_cluster("a", 1.0, 1.0), _cluster("a", 2.0, 2.0)])


def test_rewriting_removes_stale_tiles(tmp_path):
    _write(tmp_path / "t", [_cluster("a", 10.0, 5.0), _cluster("b", 200.0, -50.0)])
    _write(tmp_path / "t", [_cluster("a", 10.0, 5.0)])
    assert [p.name for p in (tmp_path / "t" / "tiles").glob("*.json")] == ["9-1.json"]


# --- manifests and discovery ------------------------------------------------------------------

def test_bad_manifests_raise_clear_errors(tmp_path):
    with pytest.raises(st.DatasetError, match="cannot read manifest"):
        st.load_dataset(tmp_path / "missing")
    (tmp_path / "d").mkdir()
    (tmp_path / "d" / "manifest.json").write_text("{not json")
    with pytest.raises(st.DatasetError, match="not valid JSON"):
        st.load_dataset(tmp_path / "d")
    (tmp_path / "d" / "manifest.json").write_text('{"format": "other/9"}')
    with pytest.raises(st.DatasetError, match="invalid manifest"):
        st.load_dataset(tmp_path / "d")


def test_manifest_is_reloaded_when_its_mtime_changes(tmp_path):
    d = _write(tmp_path / "t", [_cluster("a", 10.0, 5.0)])
    assert st.load_dataset(d).manifest["count"] == 1
    _write(d, [_cluster("a", 10.0, 5.0), _cluster("b", 20.0, 5.0)])
    import os
    mp = d / "manifest.json"
    os.utime(mp, ns=(mp.stat().st_atime_ns, mp.stat().st_mtime_ns + 10**9))
    assert st.load_dataset(d).manifest["count"] == 2


def test_discover_sources(tmp_path):
    assert st.discover_sources(tmp_path / "nope") == []
    _write(tmp_path / "good", [_cluster("a", 10.0, 5.0)])
    (tmp_path / "empty-dir").mkdir()  # no manifest: ignored
    (tmp_path / "file.txt").write_text("x")
    srcs = st.discover_sources(tmp_path)
    assert [s.id for s in srcs] == ["static:t"]  # the dataset's own name
    assert srcs[0].kinds == ("cluster",) and srcs[0].precedence == 50
    assert srcs[0].provenance["catalogue"] == "t" and srcs[0].provenance["dataset"] == "t"
    recs = asyncio.run(srcs[0].fetch(objects.Query(10.0, 5.0, 1.0, 60000.0, ("cluster",), 10)))
    assert [r["id"] for r in recs] == ["test:a"]


def test_a_broken_dataset_registers_a_source_that_raises(tmp_path):
    (tmp_path / "bad").mkdir()
    (tmp_path / "bad" / "manifest.json").write_text('{"kinds": ["cluster"], "format": "nope"}')
    (tmp_path / "worse").mkdir()
    (tmp_path / "worse" / "manifest.json").write_text("garbage")
    srcs = {s.id: s for s in st.discover_sources(tmp_path)}
    assert set(srcs) == {"static:bad", "static:worse"}
    assert srcs["static:bad"].kinds == ("cluster",) and srcs["static:worse"].kinds == ()
    with pytest.raises(st.DatasetError):
        asyncio.run(srcs["static:bad"].fetch(objects.Query(0, 0, 1, 60000.0, ("cluster",), 10)))


# --- hosted records (exoplanets): tiled by their host's direction -----------------------------

def _planet(i: str, ra: float, dec: float, host: str = "gdr3:1") -> dict:
    r = json.loads((FIXTURES / "examples" / "exoplanet.json").read_text())
    r.update(id=f"nea:{i}", name=i, host=host, parent=host)
    r["position"]["host_radec"] = [ra, dec]
    return r


def _write_hosted(tmp: Path, recs: list[dict], **kw) -> Path:
    st.write_dataset(recs, tmp, dataset="h", kinds=["exoplanet", "star"], provenance={"catalogue": "t"},
                     build={"script": "x", "script_version": 1}, band_deg=10, **kw)
    return tmp


def test_a_hosted_record_is_tiled_by_host_radec(tmp_path):
    d = _write_hosted(tmp_path / "h", [_planet("x b", 346.63, -5.04), _planet("y b", 0.5, 89.9)])
    m = json.loads((d / "manifest.json").read_text())
    assert sorted(m["tiles"]) == sorted([st.tile_of(346.63, -5.04), st.tile_of(0.5, 89.9)])
    assert m["max_extent_deg"] == 0.0 and m["count"] == 2
    assert st.verify_dataset(d) == []


def test_a_cone_at_the_host_finds_it_and_a_cone_one_degree_away_does_not(tmp_path):
    ds = st.load_dataset(_write_hosted(tmp_path / "h", [_planet("x b", 346.63, -5.04),
                                                      _planet("z b", 100.0, 30.0)]))
    assert [r["id"] for r in st.cone_query(ds, 346.63, -5.04, 0.1)] == ["nea:x b"]
    assert [r["id"] for r in st.cone_query(ds, 346.63, -4.04, 0.5)] == []     # 1 deg away
    assert [r["id"] for r in st.cone_query(ds, 346.63, -4.04, 1.5)] == ["nea:x b"]
    assert [r["id"] for r in st.cone_query(ds, 0.0, -5.0, 14.0)] == ["nea:x b"]  # across the RA wrap


def test_hosted_and_fixed_records_mix_in_one_dataset(tmp_path):
    star = json.loads((FIXTURES / "examples" / "star_host.json").read_text())
    ds = st.load_dataset(_write_hosted(tmp_path / "h", [star, _planet("x b", star["position"]["ra"],
                                                                      star["position"]["dec"])]))
    got = st.cone_query(ds, star["position"]["ra"], star["position"]["dec"], 0.1)
    assert sorted(r["id"] for r in got) == sorted([star["id"], "nea:x b"])


def test_write_refuses_bad_hosted_records(tmp_path):
    no_radec = _planet("a b", 10.0, 5.0)
    del no_radec["position"]["host_radec"]
    no_host = _planet("c b", 10.0, 5.0)
    no_host["host"] = None
    fixed_planet = _planet("d b", 10.0, 5.0)
    fixed_planet["position"] = {"model": "fixed", "ra": 10.0, "dec": 5.0, "method": "assumed",
                                "dist": objects.quantity(10, "x", "illustrative", "pc")}
    for bad, msg in ((no_radec, "host_radec"), (no_host, "host"), (fixed_planet, "orbit")):
        with pytest.raises(ValueError, match=msg):
            _write_hosted(tmp_path / "x", [bad])
        assert not (tmp_path / "x" / "manifest.json").exists()
    # an orbit position of a kind that is not hosted, and a hosted kind with host null in a fixed position
    other = _planet("e b", 10.0, 5.0)
    other["kind"] = "cluster"
    with pytest.raises(ValueError, match="fixed"):
        _write_hosted(tmp_path / "x", [other])


def test_verify_catches_a_hosted_record_in_the_wrong_tile(tmp_path):
    d = _write_hosted(tmp_path / "h", [_planet("x b", 346.63, -5.04)])
    m = json.loads((d / "manifest.json").read_text())
    (tile,) = m["tiles"]
    other = "9-1"
    (d / "tiles" / f"{other}.json").write_bytes((d / "tiles" / f"{tile}.json").read_bytes())
    (d / "tiles" / f"{tile}.json").unlink()
    m["tiles"] = {other: m["tiles"][tile]}
    (d / "manifest.json").write_text(json.dumps(m))
    assert any("wrong tile" in p for p in st.verify_dataset(d))


# --- the string table (section 16.18 D2) ------------------------------------------------------

def _srcs(rec: dict) -> list:
    return [h["src"] for h in st._src_holders(rec) if "src" in h]


def _tile_records(d: Path) -> list[dict]:
    return [r for p in sorted((d / "tiles").glob("*.json")) for r in json.loads(p.read_text())["objects"]]


def test_src_table_stores_sorted_distinct_strings_and_integer_indices(tmp_path):
    star = json.loads((FIXTURES / "examples" / "star_host.json").read_text())
    recs = [star, _planet("x b", 346.63, -5.04), _planet("y b", 100.0, 30.0)]
    d = _write_hosted(tmp_path / "h", recs, src_table=True)
    m = json.loads((d / "manifest.json").read_text())
    table = m["src_table"]
    assert table == sorted(set(table)) and "NEA pscomppars: Agol et al. 2021" in table
    assert set(table) == {s for r in recs for s in _srcs(r)}
    raw = _tile_records(d)
    for r in raw:
        assert all(isinstance(s, int) for s in _srcs(r))
        assert all(isinstance(s, str) for s in _srcs(st._expand_src(json.loads(json.dumps(r)), table)))
    assert "Agol" not in "".join(p.read_text() for p in (d / "tiles").glob("*.json"))
    assert st.verify_dataset(d) == []


def test_src_table_round_trip_serves_string_src_and_the_original_records(tmp_path):
    star = json.loads((FIXTURES / "examples" / "star_host.json").read_text())
    recs = [star, _planet("x b", star["position"]["ra"], star["position"]["dec"])]
    ds = st.load_dataset(_write_hosted(tmp_path / "h", recs, src_table=True))
    got = {r["id"]: r for r in st.cone_query(ds, star["position"]["ra"], star["position"]["dec"], 0.5)}
    assert set(got) == {r["id"] for r in recs}
    for r in recs:
        assert got[r["id"]] == r
        assert all(isinstance(s, str) for s in _srcs(got[r["id"]]))
    again = st.cone_query(ds, star["position"]["ra"], star["position"]["dec"], 0.5)   # from the cache
    assert all(isinstance(s, str) for r in again for s in _srcs(r))
    assert objects.validate_record(got["nea:x b"]) == []


def test_src_table_covers_size_and_angular_quantities(tmp_path):
    c = _cluster("a", 10.0, 5.0, 2.0)
    d = tmp_path / "t"
    st.write_dataset([c], d, dataset="t", kinds=["cluster"], provenance={"catalogue": "t"},
                     build={"script": "x", "script_version": 1}, src_table=True)
    assert json.loads((d / "manifest.json").read_text())["src_table"] == ["synthetic"]
    (rec,) = st.cone_query(st.load_dataset(d), 10.0, 5.0, 1.0)
    assert rec == c


def test_an_out_of_range_src_index_is_a_dataset_error(tmp_path):
    star = json.loads((FIXTURES / "examples" / "star_host.json").read_text())
    d = _write_hosted(tmp_path / "h", [star], src_table=True)
    (tp,) = (d / "tiles").glob("*.json")
    doc = json.loads(tp.read_text())
    doc["objects"][0]["position"]["dist"]["src"] = 9999
    tp.write_text(json.dumps(doc))
    ds = st.load_dataset(d)
    with pytest.raises(st.DatasetError, match="string table"):
        st.cone_query(ds, star["position"]["ra"], star["position"]["dec"], 1.0)
    assert any("string table" in p for p in st.verify_dataset(d))   # (the sha256 also differs)


def test_an_integer_src_without_a_table_is_refused(tmp_path):
    d = _write(tmp_path / "t", [_cluster("a", 10.0, 5.0)])
    tp = d / "tiles" / "9-1.json"
    doc = json.loads(tp.read_text())
    doc["objects"][0]["position"]["dist"]["src"] = 0
    tp.write_text(json.dumps(doc))
    with pytest.raises(st.DatasetError):
        st.cone_query(st.load_dataset(d), 10.0, 5.0, 1.0)


def test_a_bad_src_table_in_the_manifest_is_refused(tmp_path):
    d = _write(tmp_path / "t", [_cluster("a", 10.0, 5.0)])
    m = json.loads((d / "manifest.json").read_text())
    m["src_table"] = "nope"
    (d / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(st.DatasetError, match="src_table"):
        st.load_dataset(d)


def test_src_table_output_is_byte_deterministic_and_default_has_no_table(tmp_path):
    star = json.loads((FIXTURES / "examples" / "star_host.json").read_text())
    recs = [star, _planet("x b", 346.63, -5.04), _planet("y b", 100.0, 30.0)]
    a = _write_hosted(tmp_path / "a", recs, src_table=True)
    b = _write_hosted(tmp_path / "b", list(reversed(recs)), src_table=True)
    files = lambda d: {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}  # noqa: E731
    assert files(a) == files(b)
    plain = _write_hosted(tmp_path / "c", recs)
    assert "src_table" not in json.loads((plain / "manifest.json").read_text())
    assert "Agol" in "".join(p.read_text() for p in (plain / "tiles").glob("*.json"))


# --- record defaults ---------------------------------------------------------------------------

def test_record_defaults_are_stored_once_and_restored_on_read(tmp_path):
    star = json.loads((FIXTURES / "examples" / "star_host.json").read_text())
    recs = [star, _planet("x b", star["position"]["ra"], star["position"]["dec"])]
    prov = {"source": "static:t", "catalogue": "t"}
    for r in recs:
        r["provenance"] = dict(prov)
    d = _write_hosted(tmp_path / "h", recs, src_table=True, record_defaults={"provenance": prov})
    m = json.loads((d / "manifest.json").read_text())
    assert m["record_defaults"] == {"provenance": prov}
    assert all("provenance" not in r for r in _tile_records(d))
    ds = st.load_dataset(d)
    got = {r["id"]: r for r in st.cone_query(ds, star["position"]["ra"], star["position"]["dec"], 0.5)}
    assert got == {r["id"]: r for r in recs}
    got["nea:x b"]["provenance"]["catalogue"] = "mutated"   # a served record is its own copy
    again = {r["id"]: r for r in st.cone_query(ds, star["position"]["ra"], star["position"]["dec"], 0.5)}
    assert again["gdr3:2635476908753563008"]["provenance"] == prov
    assert st.verify_dataset(d) == []


def test_only_keys_equal_to_the_default_are_left_out(tmp_path):
    a, c = _cluster("a", 10.0, 5.0), _cluster("c", 20.0, 5.0)
    c["provenance"] = {"source": "static:t", "catalogue": "other"}
    d = tmp_path / "t"
    st.write_dataset([a, c], d, dataset="t", kinds=["cluster"], provenance={"catalogue": "t"},
                     build={"script": "x", "script_version": 1}, record_defaults={"provenance": a["provenance"]})
    stored = {r["id"]: r for r in _tile_records(d)}
    assert "provenance" not in stored["test:a"] and stored["test:c"]["provenance"]["catalogue"] == "other"
    ds = st.load_dataset(d)
    assert {r["id"]: r["provenance"] for r in st.cone_query(ds, 15.0, 5.0, 10.0)} == \
        {"test:a": a["provenance"], "test:c": c["provenance"]}


def test_no_record_defaults_is_a_no_op_and_a_bad_value_is_refused(tmp_path):
    d = _write(tmp_path / "t", [_cluster("a", 10.0, 5.0)])
    assert "record_defaults" not in json.loads((d / "manifest.json").read_text())
    assert all("provenance" in r for r in _tile_records(d))
    m = json.loads((d / "manifest.json").read_text())
    m["record_defaults"] = [1]
    (d / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(st.DatasetError, match="record_defaults"):
        st.load_dataset(d)
