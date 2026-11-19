"""Offline tests for /api/objects and objects.build_objects (SkyBoT and the ephemeris are stubbed)."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from spherex_app import cache, config, movers, objects, objects_live
from spherex_app.main import app

client = TestClient(app)
MJD = 60000.0
FIXTURES = Path(__file__).parent / "fixtures" / "objects"
SOLAR = ["sun", "planet", "moon"]
SMALL = ["dwarf_planet", "asteroid", "comet"]


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "OBJECTS_DIR", tmp_path / "no-datasets")
    objects.reset_sources()
    objects_live.earth_xyz.cache_clear()
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot())
    yield
    objects.reset_sources()
    objects_live.earth_xyz.cache_clear()


def _obj(**kw):
    base = {"number": None, "name": "", "class": None, "vmag": 20.0, "ra": 83.8, "dec": -5.4,
            "dg_au": 2.0, "dh_au": 3.0, "err_arcsec": None}
    base.update(kw)
    return base


CERES = _obj(number=1, name="Ceres", **{"class": "MB>Outer"}, vmag=8.1)
ASTEROID = _obj(name="2019 YB21", **{"class": "MB>Middle"}, vmag=22.5)
COMET = _obj(name="C/2020 F3 (NEOWISE)", **{"class": "Comet"}, vmag=10.0)
CENTAUR = _obj(number=2060, name="Chiron", **{"class": "Centaur"}, vmag=17.0)


def _fake_skybot(objs=None, exc=None, seen=None):
    async def fake(ra, dec, radius, jd):
        if seen is not None:
            seen.append((ra, dec, radius, jd))
        if exc is not None:
            raise exc
        return list(objs or [])
    return fake


def _get(**params):
    p = {"ra": 83.82, "dec": -5.39, "radius": 2, "mjd": MJD}
    p.update(params)
    return client.get("/api/objects", params=p)


def _ids(j, kind=None):
    return [o["id"] for o in j["objects"] if kind is None or o["kind"] == kind]


# --- shape ------------------------------------------------------------------------------------

def test_response_shape_and_schema(monkeypatch):
    seen = []
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot([CERES, ASTEROID, COMET], seen=seen))
    r = _get()
    assert r.status_code == 200
    j = r.json()
    assert set(j) == {"schema", "query", "objects", "kinds", "sources"}
    assert j["schema"] == "space-maps.objects/1" == objects.SCHEMA
    assert j["query"] == {"ra": 83.82, "dec": -5.39, "radius": 2.0, "mjd": MJD, "kinds": SOLAR + SMALL}
    assert seen == [(83.82, -5.39, 2.0, MJD + 2400000.5)]
    assert set(j["kinds"]) == set(SOLAR + SMALL)
    assert j["kinds"]["planet"] == {"status": "ok", "source": "ephem", "count": 8, "truncated": False}
    assert j["kinds"]["sun"]["count"] == 1 and j["kinds"]["moon"]["count"] == 1
    assert j["kinds"]["dwarf_planet"] == {"status": "ok", "source": "skybot", "count": 1, "truncated": False}
    assert j["kinds"]["asteroid"]["count"] == 1 and j["kinds"]["comet"]["count"] == 1
    assert [s["id"] for s in j["sources"]] == ["ephem", "skybot"]
    for s in j["sources"]:
        assert set(s) == {"id", "status", "ms", "count", "dropped", "provenance"} and s["status"] == "ok"
        assert s["dropped"] == 0
    assert [s["count"] for s in j["sources"]] == [10, 3]
    assert len(j["objects"]) == 13
    for o in j["objects"]:
        assert objects.validate_record(o) == []
        assert isinstance(o["in_cone"], bool)


def test_default_mjd_is_now_rounded_to_the_hour():
    j = client.get("/api/objects", params={"ra": 1, "dec": 1}).json()
    assert abs(j["query"]["mjd"] - objects._now_mjd()) <= 1 / 24 + 1e-9
    assert round(j["query"]["mjd"] * 24) == pytest.approx(j["query"]["mjd"] * 24, abs=1e-6)


def test_in_cone_is_truthful_and_the_big_bodies_are_always_returned(monkeypatch):
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot([CERES]))
    j = _get(ra=83.8, dec=-5.4, radius=0.5).json()
    by = {o["id"]: o for o in j["objects"]}
    assert by["mp:1"]["in_cone"] is True
    assert by["ss:earth"]["in_cone"] is False
    assert len(_ids(j, "planet")) == 8 and "ss:sun" in by and "ss:moon" in by
    sun = by["ss:sun"]
    geo = sun["position"]["geo"]
    j2 = _get(ra=geo["ra"], dec=geo["dec"], radius=0.5).json()
    assert {o["id"]: o for o in j2["objects"]}["ss:sun"]["in_cone"] is True


def test_small_bodies_outside_the_cone_are_dropped(monkeypatch):
    far = _obj(name="2020 XX", ra=200.0, dec=40.0)
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot([CERES, far]))
    assert _ids(_get().json(), "asteroid") == []
    assert _ids(_get().json(), "dwarf_planet") == ["mp:1"]


def test_kinds_filter_and_unavailable_kinds(monkeypatch):
    seen = []
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot([CERES, COMET], seen=seen))
    j = _get(kinds="planet,comet").json()
    assert j["query"]["kinds"] == ["planet", "comet"]
    assert set(_ids(j, "planet")) and set(o["kind"] for o in j["objects"]) == {"planet", "comet"}
    assert [s["id"] for s in j["sources"]] == ["ephem", "skybot"]
    j = _get(kinds="cluster,planet").json()
    assert j["kinds"]["cluster"] == {"status": "unavailable", "source": None, "count": 0, "truncated": False}
    assert j["kinds"]["planet"]["status"] == "ok"
    assert [s["id"] for s in j["sources"]] == ["ephem"]  # SkyBoT was not asked
    n = len(seen)
    _get(kinds="moon")
    assert len(seen) == n  # a request that needs no small bodies never calls SkyBoT


def test_empty_kinds_means_the_default():
    a = _get(kinds="").json()
    b = _get().json()
    assert a["query"]["kinds"] == b["query"]["kinds"] == SOLAR + SMALL


def test_kinds_order_and_whitespace_are_normalised():
    j = _get(kinds=" comet , planet,planet").json()
    assert j["query"]["kinds"] == ["planet", "comet"]


# --- parameter errors -------------------------------------------------------------------------

@pytest.mark.parametrize("params", [
    {"ra": 360}, {"ra": -1}, {"dec": 91}, {"dec": -91}, {"radius": 0.05}, {"radius": 5.1},
    {"mjd": 10}, {"mjd": 90000}, {"limit": 0}, {"limit": 10001}, {"kinds": "planet,foo"},
    {"ra": "nan"}, {"mjd": "inf"},
])
def test_bad_parameters_are_400(params):
    assert _get(**params).status_code == 400


def test_unknown_kind_lists_the_valid_ones():
    r = _get(kinds="wormhole")
    assert r.status_code == 400
    d = r.json()["detail"]
    assert "wormhole" in d and all(k in d for k in objects.KINDS)


def test_missing_required_params_are_422():
    assert client.get("/api/objects", params={"ra": 1}).status_code == 422


def test_both_routes_exist_and_scene3d_has_no_solar_helpers():
    from spherex_app import scene3d
    assert not hasattr(scene3d, "solar_positions") and not hasattr(scene3d, "bodies_xyz")
    paths = set(client.get("/openapi.json").json()["paths"])
    assert "/api/scene3d" in paths and "/api/objects" in paths


# --- failures ---------------------------------------------------------------------------------

def test_skybot_failure_marks_its_kinds_and_keeps_the_planets(monkeypatch):
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot(exc=RuntimeError("SkyBoT down")))
    r = _get()
    assert r.status_code == 200
    j = r.json()
    for k in SMALL:
        assert j["kinds"][k] == {"status": "error", "source": "skybot", "count": 0, "truncated": False,
                                 "error": "SkyBoT down"}
    assert len(_ids(j, "planet")) == 8 and j["kinds"]["planet"]["status"] == "ok"
    sb = next(s for s in j["sources"] if s["id"] == "skybot")
    assert sb["status"] == "error" and sb["error"] == "SkyBoT down" and "provenance" not in sb


def test_ephemeris_failure_marks_the_planets_and_keeps_skybot(monkeypatch):
    def boom(mjd):
        raise RuntimeError("ephemeris broke")
    monkeypatch.setattr(objects_live, "solar_positions", boom)
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot([CERES, ASTEROID]))
    r = _get()
    assert r.status_code == 200
    j = r.json()
    for k in SOLAR:
        assert j["kinds"][k]["status"] == "error" and j["kinds"][k]["error"] == "ephemeris broke"
    assert j["kinds"]["asteroid"]["status"] == "ok" and _ids(j, "asteroid") == ["mp:2019 YB21"]
    assert _ids(j, "planet") == []


def test_an_exception_without_a_message_is_reported_by_type(monkeypatch):
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot(exc=KeyError()))
    j = _get().json()
    assert j["kinds"]["comet"]["error"] == "KeyError"


def test_slow_source_times_out_promptly_and_still_fills_its_cache(monkeypatch):
    monkeypatch.setattr(config, "OBJECTS_SOURCE_TIMEOUT_S", 0.05)
    finished = []

    async def slow(ra, dec, radius, jd):
        await asyncio.sleep(0.3)
        cache.put_json("skybot", "slow-key", [{"name": "late"}])
        finished.append(True)
        return [CERES]
    monkeypatch.setattr(movers, "skybot_cone", slow)

    async def scenario():
        t0 = time.monotonic()
        j = await objects.build_objects(83.82, -5.39, 2.0, MJD, None, 100)
        took = time.monotonic() - t0
        assert not finished  # the response did not wait for it
        await asyncio.sleep(0.5)
        return j, took

    j, took = asyncio.run(scenario())
    assert took < 0.25
    assert j["kinds"]["asteroid"]["status"] == "error"
    assert j["kinds"]["asteroid"]["error"] == "timed out after 0.05 s"
    sb = next(s for s in j["sources"] if s["id"] == "skybot")
    assert sb["status"] == "error" and sb["error"] == "timed out after 0.05 s" and sb["ms"] >= 40
    assert len(_ids(j, "planet")) == 8  # the other source is unaffected
    assert finished == [True]
    assert cache.get_json("skybot", "slow-key") == [{"name": "late"}]


def test_a_late_failure_after_the_deadline_is_swallowed(monkeypatch, caplog):
    monkeypatch.setattr(config, "OBJECTS_SOURCE_TIMEOUT_S", 0.02)

    async def slow_fail(ra, dec, radius, jd):
        await asyncio.sleep(0.1)
        raise RuntimeError("late failure")
    monkeypatch.setattr(movers, "skybot_cone", slow_fail)

    async def scenario():
        j = await objects.build_objects(1.0, 1.0, 1.0, MJD, ["asteroid"], 10)
        await asyncio.sleep(0.2)
        return j
    assert asyncio.run(scenario())["kinds"]["asteroid"]["status"] == "error"


# --- merge rules ------------------------------------------------------------------------------

def _rec(i, kind="asteroid", mag=None, ra=10.0, dec=5.0, name=None, source="fake"):
    return objects.record(
        id=f"test:{i}", kind=kind, name=name or i, host="ss:sun",
        position={"model": "state", "mjd": MJD, "xyz_au": [1, 0, 0],
                  "geo": {"ra": ra, "dec": dec, "dist_au": 1.0}, "method": "orbit-propagation",
                  "src": "t", "tier": "catalogue"},
        provenance={"source": source, "catalogue": "t"}, evidence="measured",
        render={} if mag is None else {"mag": mag})


def _src(sid, recs, precedence=50, kinds=("asteroid",), cone=True, exc=None):
    async def fetch(q):
        if exc:
            raise exc
        return list(recs)
    return objects.Source(sid, kinds, precedence, fetch, {"source": sid, "catalogue": sid}, cone)


def _build(sources, **kw):
    objects.set_sources(sources)
    args = dict(ra=10.0, dec=5.0, radius=2.0, mjd=MJD, kinds=None, limit=2000)
    args.update(kw)
    return asyncio.run(objects.build_objects(**args))


def test_duplicate_ids_go_to_the_lower_precedence_source_whatever_the_order():
    hi = _src("hi", [_rec("x", name="from-hi")], precedence=5)
    lo = _src("lo", [_rec("x", name="from-lo"), _rec("y")], precedence=60)
    for order in ([hi, lo], [lo, hi]):
        j = _build(order)
        by = {o["id"]: o for o in j["objects"]}
        assert by["test:x"]["name"] == "from-hi" and set(by) == {"test:x", "test:y"}
        counts = {s["id"]: s["count"] for s in j["sources"]}
        assert counts == {"hi": 1, "lo": 1}  # the loser's duplicate is not counted


def test_order_is_kind_then_magnitude_then_id():
    recs = [_rec("c", mag=None), _rec("b", mag=5.0), _rec("a", mag=None), _rec("z", mag=2.0),
            _rec("m", kind="comet", mag=1.0), _rec("n", kind="dwarf_planet", mag=30.0)]
    j = _build([_src("s", recs, kinds=("asteroid", "comet", "dwarf_planet"))])
    assert _ids(j) == ["test:n", "test:z", "test:b", "test:a", "test:c", "test:m"]
    again = _build([_src("s", list(reversed(recs)), kinds=("asteroid", "comet", "dwarf_planet"))])
    assert _ids(again) == _ids(j)


def test_limit_is_per_kind_brightest_first_and_reports_truncated():
    recs = [_rec(f"a{i}", mag=float(i)) for i in range(5)] + [_rec("unk")] + \
           [_rec(f"c{i}", kind="comet", mag=float(i)) for i in range(2)]
    j = _build([_src("s", recs, kinds=("asteroid", "comet"))], limit=3)
    assert _ids(j, "asteroid") == ["test:a0", "test:a1", "test:a2"]
    assert j["kinds"]["asteroid"]["truncated"] is True and j["kinds"]["asteroid"]["count"] == 3
    assert j["kinds"]["comet"]["truncated"] is False and j["kinds"]["comet"]["count"] == 2
    assert j["sources"][0]["count"] == 5
    assert _build([_src("s", recs, kinds=("asteroid", "comet"))], limit=6)["kinds"]["asteroid"]["truncated"] is False


def test_limit_applies_through_the_route(monkeypatch):
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot(
        [_obj(name=f"2020 A{i}", vmag=10.0 + i) for i in range(5)]))
    j = _get(limit=2, kinds="asteroid").json()
    assert j["kinds"]["asteroid"]["truncated"] is True
    assert _ids(j, "asteroid") == ["mp:2020 A0", "mp:2020 A1"]


def test_invalid_records_are_dropped_and_counted():
    bad_evidence = _rec("bad1")
    bad_evidence["position"]["tier"], bad_evidence["evidence"] = "illustrative", "measured"
    no_id = _rec("bad2")
    del no_id["id"]
    good = _rec("ok")
    j = _build([_src("s", [bad_evidence, no_id, "junk", good])])
    assert _ids(j) == ["test:ok"]
    row = j["sources"][0]
    assert row["dropped"] == 3 and row["count"] == 1 and row["status"] == "ok"


def test_records_of_unrequested_kinds_are_ignored():
    j = _build([_src("s", [_rec("a"), _rec("c", kind="comet")], kinds=("asteroid", "comet"))],
               kinds=["asteroid"])
    assert _ids(j) == ["test:a"] and j["sources"][0]["dropped"] == 0


def test_cone_sources_are_filtered_and_others_are_whole():
    far = _rec("far", ra=200.0, dec=40.0)
    assert _ids(_build([_src("s", [far], cone=True)])) == []
    j = _build([_src("s", [far], cone=False)])
    assert _ids(j) == ["test:far"] and j["objects"][0]["in_cone"] is False


def test_in_cone_is_not_taken_from_the_source():
    r = _rec("a")
    r["in_cone"] = False
    assert _build([_src("s", [r])])["objects"][0]["in_cone"] is True


def test_two_sources_one_kind_a_partial_failure_still_reports_ok():
    j = _build([_src("good", [_rec("a")], precedence=10), _src("bad", [], precedence=20, exc=RuntimeError("no"))])
    k = j["kinds"]["asteroid"]
    assert k["status"] == "ok" and k["source"] == "good" and "bad: no" in k["error"]
    assert [s["status"] for s in j["sources"]] == ["ok", "error"]


def test_unknown_kind_to_build_objects_raises_value_error():
    objects.set_sources([_src("s", [])])
    with pytest.raises(ValueError, match="wormhole"):
        asyncio.run(objects.build_objects(1, 1, 1, MJD, ["wormhole"], 10))


def test_records_from_a_source_are_not_mutated():
    r = _rec("a")
    _build([_src("s", [r])])
    assert "in_cone" not in r


def test_the_response_is_deterministic(monkeypatch):
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot([CERES, ASTEROID, COMET, CENTAUR]))

    def strip(j):
        for s in j["sources"]:
            s.pop("ms")
        return j
    assert strip(_get().json()) == strip(_get().json())


def test_classification_reaches_the_response(monkeypatch):
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot([CERES, ASTEROID, COMET, CENTAUR]))
    j = _get().json()
    assert _ids(j, "dwarf_planet") == ["mp:1"]
    assert _ids(j, "comet") == ["comet:C/2020 F3"]
    assert _ids(j, "asteroid") == ["mp:2060", "mp:2019 YB21"]  # by magnitude


# --- static datasets through OBJECTS_DIR ------------------------------------------------------

def test_static_fixture_is_merged_through_the_objects_dir(monkeypatch):
    monkeypatch.setattr(config, "OBJECTS_DIR", FIXTURES)  # also holds examples/, which has no manifest
    objects.reset_sources()
    j = _get(ra=180.0, dec=0.0, radius=1.0).json()
    assert "cluster" in j["query"]["kinds"]
    assert j["kinds"]["cluster"] == {"status": "ok", "source": "static:fixture-clusters", "count": 1,
                                     "truncated": False}
    assert _ids(j, "cluster") == ["test:mid-sky"]
    assert j["objects"][-1]["id"] == "test:mid-sky"  # clusters sort after the solar kinds
    src = next(s for s in j["sources"] if s["id"] == "static:fixture-clusters")
    assert src["status"] == "ok" and src["count"] == 1
    assert src["provenance"]["catalogue"] == "Space Maps test fixture (synthetic)"
    assert j["objects"][-1]["in_cone"] is True


def test_static_kinds_filter(monkeypatch):
    monkeypatch.setattr(config, "OBJECTS_DIR", FIXTURES)
    objects.reset_sources()
    j = _get(ra=180.0, dec=0.0, radius=1.0, kinds="planet").json()
    assert "static:fixture-clusters" not in [s["id"] for s in j["sources"]]
    assert "cluster" not in j["kinds"]


def test_cluster_extent_makes_it_in_cone_from_the_side(monkeypatch):
    monkeypatch.setattr(config, "OBJECTS_DIR", FIXTURES)
    objects.reset_sources()
    j = _get(ra=0.1, dec=12.5, radius=0.5, kinds="cluster").json()  # 2.3 deg from wrap-east, radius 2
    assert _ids(j) == ["test:wrap-east"]


def test_a_broken_dataset_is_an_error_in_sources_not_a_crash(monkeypatch, tmp_path):
    d = tmp_path / "objs"
    (d / "broken").mkdir(parents=True)
    (d / "broken" / "manifest.json").write_text('{"kinds": ["cluster"], "format": "nope"}')
    (d / "garbled").mkdir()
    (d / "garbled" / "manifest.json").write_text("{{{")
    monkeypatch.setattr(config, "OBJECTS_DIR", d)
    objects.reset_sources()
    r = _get()
    assert r.status_code == 200
    j = r.json()
    rows = {s["id"]: s for s in j["sources"]}
    assert rows["static:broken"]["status"] == "error" and "invalid manifest" in rows["static:broken"]["error"]
    assert rows["static:garbled"]["status"] == "error"
    assert len(_ids(j, "planet")) == 8  # live sources are unaffected
    j2 = _get(kinds="cluster").json()
    assert j2["kinds"]["cluster"]["status"] == "error" and j2["kinds"]["cluster"]["source"] == "static:broken"


def test_no_objects_dir_means_no_datasets():
    j = _get().json()
    assert [s["id"] for s in j["sources"]] == ["ephem", "skybot"]


def test_registry_is_lazy_and_resettable(monkeypatch):
    objects.reset_sources()
    assert objects._SOURCES is None
    assert [s.id for s in objects.sources()] == ["ephem", "skybot"]
    objects.register(_src("extra", []))
    assert [s.id for s in objects.sources()][-1] == "extra"
    assert "asteroid" in objects.served_kinds()
    objects.reset_sources()
    assert [s.id for s in objects.sources()] == ["ephem", "skybot"]


def test_response_is_json_serialisable_end_to_end(monkeypatch):
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot([CERES, COMET]))
    r = _get()
    json.loads(r.text)


# --- hosted static kinds (exoplanets) and their stars, through the objects dir ----------------

NEA_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_objects_nea.py"


def _nea_script():
    spec = importlib.util.spec_from_file_location("build_objects_nea", NEA_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["build_objects_nea"] = mod
    spec.loader.exec_module(mod)
    return mod


def _nea_row(mod, name, host, ra, dec, vmag, dr3):
    r = {c: "" for c in mod.COLUMNS}
    r.update(pl_name=name, hostname=host, pl_letter=name.split()[-1], ra=str(ra), dec=str(dec),
             discoverymethod="Transit", disc_year="2016", sy_pnum="2", gaia_dr3_id=f"Gaia DR3 {dr3}",
             sy_dist="12.4", sy_plx="80.4", sy_vmag=str(vmag), pl_orbper="1.5", pl_orbsmax="0.0115",
             pl_bmassj="0.004", pl_bmassprov="Mass", pl_rade="1.1", pl_radelim="0",
             pl_tranmid="2457322.5", pl_bmassj_reflink="<a href=x>Agol et al. 2021</a>",
             pl_orbper_reflink="<a href=x>Agol et al. 2021</a>")
    return r


@pytest.fixture
def nea_dir(tmp_path, monkeypatch):
    """A tiny exoplanet dataset (3 planets of 2 hosts, built by the real script code) as OBJECTS_DIR."""
    mod = _nea_script()
    rows = [_nea_row(mod, "Bright b", "Bright", 150.0, 2.0, 6.0, 1001),
            _nea_row(mod, "Bright c", "Bright", 150.0, 2.0, 6.0, 1001),
            _nea_row(mod, "Faint b", "Faint", 150.4, 2.2, 15.0, 1002),
            _nea_row(mod, "Far b", "Far", 250.0, -40.0, 9.0, 1003)]
    mod.build_from(rows, [], [], {"catalogue": "t", "version": "v"}, "2026-11-18", tmp_path / "objs" / "nea-exoplanets")
    monkeypatch.setattr(config, "OBJECTS_DIR", tmp_path / "objs")
    objects.reset_sources()
    return tmp_path / "objs"


def test_exoplanets_and_hosts_merge_cone_only_by_host_position(nea_dir):
    j = _get(ra=150.0, dec=2.0, radius=1.0, kinds="exoplanet,star").json()
    assert j["query"]["kinds"] == ["star", "exoplanet"]
    assert sorted(_ids(j, "exoplanet")) == ["nea:Bright b", "nea:Bright c", "nea:Faint b"]
    assert sorted(_ids(j, "star")) == ["gdr3:1001", "gdr3:1002"]
    assert all(o["in_cone"] is True for o in j["objects"])
    for k in ("exoplanet", "star"):
        assert j["kinds"][k] == {"status": "ok", "source": "static:nea-exoplanets",
                                 "count": 3 if k == "exoplanet" else 2, "truncated": False}
    row = next(s for s in j["sources"] if s["id"] == "static:nea-exoplanets")
    assert row["status"] == "ok" and row["count"] == 5 and row["dropped"] == 0
    assert row["provenance"]["catalogue"] == "t"


def test_a_cone_away_from_the_host_does_not_return_its_planets(nea_dir):
    j = _get(ra=150.0, dec=3.5, radius=0.5, kinds="exoplanet,star").json()   # 1.5 deg from Bright
    assert _ids(j) == []
    j = _get(ra=150.0, dec=3.0, radius=1.1, kinds="exoplanet").json()        # Bright is 1.0 deg away: inside
    assert "nea:Bright b" in _ids(j)
    j = _get(ra=250.0, dec=-40.0, radius=0.5, kinds="exoplanet").json()
    assert _ids(j) == ["nea:Far b"]


def test_in_cone_is_the_hosts_direction_not_a_file_property(nea_dir):
    # Faint is 0.45 deg from (150, 2): the cone of 0.2 deg does not hold it, so it is filtered, not in_cone false
    j = _get(ra=150.0, dec=2.0, radius=0.2, kinds="exoplanet").json()
    assert sorted(_ids(j)) == ["nea:Bright b", "nea:Bright c"]


def test_records_are_served_with_string_src_and_validate(nea_dir):
    j = _get(ra=150.0, dec=2.0, radius=1.0, kinds="exoplanet,star").json()
    for o in j["objects"]:
        assert objects.validate_record(o) == []
        srcs = [q["src"] for q in o["props"].values()]
        assert all(isinstance(x, str) for x in srcs) and isinstance(o["position"].get("src", ""), str)
    planet = next(o for o in j["objects"] if o["id"] == "nea:Bright b")
    assert planet["position"]["elements"]["period_d"]["src"] == "NEA pscomppars: Agol et al. 2021"
    assert planet["position"]["host_radec"] == [150.0, 2.0] and "in_cone" in planet


def test_exoplanets_are_ordered_by_host_magnitude_and_truncated_per_kind(nea_dir):
    j = _get(ra=150.0, dec=2.0, radius=1.0, kinds="exoplanet,star", limit=2).json()
    assert _ids(j, "exoplanet") == ["nea:Bright b", "nea:Bright c"]          # the faint host's planet is cut
    assert j["kinds"]["exoplanet"]["truncated"] is True and j["kinds"]["exoplanet"]["count"] == 2
    assert _ids(j, "star") == ["gdr3:1001", "gdr3:1002"] and j["kinds"]["star"]["truncated"] is False
    j = _get(ra=150.0, dec=2.0, radius=1.0, kinds="exoplanet,star", limit=1).json()
    assert j["kinds"]["star"]["truncated"] is True and _ids(j, "star") == ["gdr3:1001"]
    assert j["kinds"]["exoplanet"]["truncated"] is True


def test_kinds_filter_skips_the_exoplanet_dataset(nea_dir):
    j = _get(ra=150.0, dec=2.0, radius=1.0, kinds="planet").json()
    assert "static:nea-exoplanets" not in [s["id"] for s in j["sources"]]
    assert "exoplanet" not in j["kinds"]
    assert "exoplanet" in objects.served_kinds() and "star" in objects.served_kinds()


def test_the_real_committed_dataset_serves_trappist_1_through_the_route(monkeypatch):
    monkeypatch.setattr(config, "OBJECTS_DIR", Path(__file__).resolve().parents[2] / "frontend" / "data" / "objects")
    objects.reset_sources()
    j = _get(ra=346.626, dec=-5.043, radius=0.5, kinds="exoplanet,star").json()
    ids = _ids(j, "exoplanet")
    assert [i for i in ids if i.startswith("nea:TRAPPIST-1 ")] == [f"nea:TRAPPIST-1 {c}" for c in "bcdefgh"]
    assert "gdr3:2635476908753563008" in _ids(j, "star")
    assert j["kinds"]["exoplanet"]["status"] == "ok" and all(o["in_cone"] for o in j["objects"])
    assert next(s for s in j["sources"] if s["id"] == "static:nea-exoplanets")["dropped"] == 0


# --- Phase 2: the committed nebulae and bh-curated datasets through /api/objects (§17.13) ----

DATA = Path(__file__).resolve().parents[2] / "frontend" / "data" / "objects"


@pytest.fixture
def phase2_dir(tmp_path, monkeypatch):
    """The two committed Phase 2 datasets (copied, so the test reads exactly what ships) as OBJECTS_DIR."""
    import shutil
    d = tmp_path / "objs"
    for name in ("nebulae", "bh-curated"):
        shutil.copytree(DATA / name, d / name)
    monkeypatch.setattr(config, "OBJECTS_DIR", d)
    objects.reset_sources()
    return d


def _obj_by_id(j, oid):
    return next((o for o in j["objects"] if o["id"] == oid), None)


def test_orion_cone_returns_m42_in_cone_with_its_derived_distance(phase2_dir):
    j = _get(ra=83.82, dec=-5.39, radius=1.0, kinds="nebula").json()
    m42 = _obj_by_id(j, "ongc:NGC1976")
    assert m42 is not None and m42["in_cone"] is True and m42["evidence"] == "derived"
    assert m42["position"]["dist"]["tier"] == "inferred" and "Russeil 2003" in m42["position"]["dist"]["src"]
    assert "Sh2-281" in m42["designations"]
    assert all(objects.validate_record(o) == [] for o in j["objects"])


def test_a_cone_nine_degrees_from_barnards_loop_centre_still_returns_it(phase2_dir):
    # Barnard's Loop (sh2:276) is centred at (81.87, -3.97) with a 1200 arcmin (20 deg) diameter
    j = _get(ra=81.867, dec=5.035, radius=0.5, kinds="nebula").json()
    loop = _obj_by_id(j, "sh2:276")
    assert loop is not None and loop["in_cone"] is True
    assert loop["position"]["dist"] is None and loop["evidence"] == "measured"   # direction only


def test_the_crab_is_direction_only(phase2_dir):
    j = _get(ra=83.633, dec=22.015, radius=0.5, kinds="nebula").json()
    crab = _obj_by_id(j, "ongc:NGC1952")
    assert crab is not None and crab["position"]["dist"] is None and crab["size"]["radius"] is None
    assert crab["host"] is None and crab["position"].get("method") is None


def test_cyg_x1_cone_returns_the_black_hole_and_its_companion(phase2_dir):
    j = _get(ra=299.590, dec=35.202, radius=0.5, kinds="black_hole,star").json()
    bh, star = _obj_by_id(j, "bh:Cyg X-1"), _obj_by_id(j, "gdr3:2059383668236814720")
    assert bh is not None and star is not None
    assert bh["host"] == star["id"] and bh["evidence"] == "illustrative" and bh["position"]["model"] == "orbit"
    assert bh["position"].get("dist") is None                      # one stored distance per system: the star's
    assert star["prefer_record"]["replace"] == ["dist", "mass"] and star["position"]["dist"]["v"] == 2220
    assert star["props"]["gaia_parallax"]["unit"] == "mas"


def test_sources_carry_the_credits_the_app_shows(phase2_dir):
    j = _get(ra=83.82, dec=-5.39, radius=1.0, kinds="nebula").json()
    neb = next(s for s in j["sources"] if s["id"] == "static:nebulae")
    assert neb["provenance"]["licence_name"] == "CC BY-SA 4.0 (OpenNGC data); Gaia EDR3-based PN distances CC BY-NC 3.0 IGO"
    assert neb["provenance"]["credit"] == "Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC; PN distances from Gaia EDR3: Credit: ESA/Gaia/DPAC"
    j = _get(ra=266.417, dec=-29.008, radius=0.5, kinds="black_hole").json()
    assert _obj_by_id(j, "bh:Sgr A*")["evidence"] == "measured"
    bh = next(s for s in j["sources"] if s["id"] == "static:bh-curated")
    assert bh["provenance"]["credit"] == "Credit: ESA/Gaia/DPAC"
    assert bh["provenance"]["licence_name"].startswith("CC BY-NC 3.0 IGO")


# --- Phase 3: galaxies, the Milky Way and the supermassive black holes through /api/objects (§18.14) ----

PHASE3 = ("galaxies", "smbh-curated", "bh-curated")
SMBH_IDS = {"bh:M87*", "bh:NGC 4258*", "bh:M31*", "bh:M32*", "bh:Cen A*", "bh:M81*", "bh:M104*", "bh:NGC 4889*"}


@pytest.fixture
def phase3_dir(tmp_path, monkeypatch):
    """The committed galaxies, smbh-curated and bh-curated datasets (linked, not copied: the galaxies are 12 MB)."""
    d = tmp_path / "objs"
    d.mkdir()
    for name in PHASE3:
        (d / name).symlink_to(DATA / name, target_is_directory=True)
    monkeypatch.setattr(config, "OBJECTS_DIR", d)
    objects.reset_sources()
    return d


def _kinds3(**params):
    return _get(**{"kinds": "galaxy,black_hole", "radius": 0.5, **params}).json()


def test_m31_cone_gives_the_galaxy_in_cone_with_its_measured_distance_and_its_black_hole(phase3_dir):
    j = _kinds3(ra=10.6847, dec=41.2690)
    m31, bh = _obj_by_id(j, "ongc:NGC0224"), _obj_by_id(j, "bh:M31*")
    assert m31["in_cone"] is True and m31["name"] == "Andromeda Galaxy" and m31["evidence"] == "measured"
    d = m31["position"]["dist"]
    assert m31["position"]["method"] == "cepheid" and d["unit"] == "Mpc" and "Cosmicflows-4" in d["src"]
    assert [a["method"] for a in m31["alt_distances"]] and all(a["reason"].startswith("not used") for a in m31["alt_distances"])
    assert bh["parent"] == "ongc:NGC0224" and bh["position"]["dist"]["v"] == d["v"]
    assert bh["props"]["mass"]["v"] == 1.4e8 and "mass_published" not in bh["props"]          # not rescaled ...
    assert bh["props"]["mass_note"]["v"]                                                       # ... and says why
    assert all(objects.validate_record(o) == [] for o in j["objects"])


def test_m87_and_m87_star_share_one_distance_and_the_mass_is_rescaled_to_it(phase3_dir):
    j = _kinds3(ra=187.7059, dec=12.3911)
    m87, bh = _obj_by_id(j, "ongc:NGC4486"), _obj_by_id(j, "bh:M87*")
    assert m87["in_cone"] is True and bh["in_cone"] is True and bh["parent"] == "ongc:NGC4486"
    assert bh["position"]["dist"] == m87["position"]["dist"] | {"src": bh["position"]["dist"]["src"]}
    p = bh["props"]
    factor = m87["position"]["dist"]["v"] / p["dist_published"]["v"]
    assert p["mass"]["v"] == pytest.approx(p["mass_published"]["v"] * factor, rel=1e-6)
    assert p["ring_diameter"]["unit"] == "arcsec" and p["ring_diameter"]["tier"] == "measured"


def test_ngc4258_galaxy_and_black_hole_use_the_same_maser_distance(phase3_dir):
    j = _kinds3(ra=184.7396, dec=47.3040)
    g, bh = _obj_by_id(j, "ongc:NGC4258"), _obj_by_id(j, "bh:NGC 4258*")
    assert g["position"]["method"] == "maser" and bh["position"]["dist"]["v"] == g["position"]["dist"]["v"]
    assert bh["props"]["dist_published"]["v"] == 7.576 and "not used" in bh["props"]["dist_published"]["src"]


def test_hubble_flow_and_cluster_member_sources_state_their_assumptions(phase3_dir):
    j = _kinds3(ra=187.7059, dec=12.3911, radius=5.0)
    flow = [o for o in j["objects"] if o["position"].get("method") == "redshift"]
    members = [o for o in j["objects"] if o["position"].get("method") == "group-member" and o["id"].startswith("ongc:")]
    assert flow and all("H0 = 74.6" in o["position"]["dist"]["src"] and "67.4" in o["position"]["dist"]["src"] for o in flow)
    assert all(o["evidence"] == "derived" and o["position"]["dist"]["tier"] == "inferred" for o in flow + members)
    assert any("Virgo cluster" in o["position"]["dist"]["src"] and "group 41220" in o["position"]["dist"]["src"] for o in members)


def test_galactic_centre_sgr_a_star_names_the_milky_way_and_shares_its_r0(phase3_dir):
    j = _kinds3(ra=266.417, dec=-29.008)
    sgr, mw = _obj_by_id(j, "bh:Sgr A*"), _obj_by_id(j, "gal:milky_way")
    assert sgr["parent"] == "gal:milky_way" and sgr["in_cone"] is True
    assert mw["position"]["dist"]["unit"] == "pc"
    sd = sgr["position"]["dist"]
    assert (sd["v"] * (1000 if sd["unit"] == "kpc" else 1)) == pytest.approx(mw["position"]["dist"]["v"], rel=1e-9)


def test_an_empty_cone_still_gets_the_context_set_once_and_marked_out_of_cone(phase3_dir):
    j = _kinds3(ra=0.0, dec=-89.5)          # no catalogued galaxy here
    ids = _ids(j)
    assert len(ids) == len(set(ids))
    assert {"gal:milky_way", "ongc:ESO056-115", "ongc:NGC0292", "ongc:NGC0224", "ongc:NGC4486", "bh:Sgr A*"} <= set(ids)
    assert SMBH_IDS <= set(ids)
    sky = {o["id"] for o in j["objects"] if not o["in_cone"]}
    assert len([i for i in sky if not i.startswith("bh:")]) == 161 and SMBH_IDS <= sky
    # a cone over M31: M31 is in the sky tile and inside the cone, and is still sent once
    ids = _ids(_kinds3(ra=10.6847, dec=41.2690, radius=3.0))
    assert ids.count("ongc:NGC0224") == 1 and len(ids) == len(set(ids))


def test_the_large_response_is_gzip_compressed(phase3_dir):
    r = client.get("/api/objects", params={"ra": 187.7, "dec": 12.4, "radius": 5, "mjd": MJD, "kinds": "galaxy"},
                   headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers.get("content-encoding") == "gzip"
    assert r.json()["kinds"]["galaxy"]["status"] == "ok"


def test_the_galaxy_sources_carry_their_credits_and_no_gaia(phase3_dir):
    j = _kinds3(ra=10.6847, dec=41.2690)
    for sid in ("static:galaxies", "static:smbh-curated"):
        prov = next(s for s in j["sources"] if s["id"] == sid)["provenance"]
        assert "Mattia Verga" in prov["credit"] and prov["licence_name"].startswith("CC BY-SA 4.0")
        assert "No Gaia values" in prov["data_licence_note"] and "Gaia" not in prov["credit"]


@pytest.mark.parametrize("name", ["nea-exoplanets", "hr23-clusters", "nebulae", "bh-curated", "galaxies", "smbh-curated"])
def test_every_committed_dataset_verifies(name):
    from spherex_app.objects_static import verify_dataset
    assert verify_dataset(DATA / name) == []
