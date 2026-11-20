"""Offline tests for the live object sources (spherex_app.objects_live): ephemeris and SkyBoT."""

from __future__ import annotations

import asyncio
import math

import pytest

from spherex_app import config, movers, objects, objects_live

MJD = 60000.0


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    objects_live.earth_xyz.cache_clear()
    yield
    objects_live.earth_xyz.cache_clear()


def _by_id(recs):
    return {r["id"]: r for r in recs}


# --- moved helpers (behaviour kept) -----------------------------------------------------------

def test_scene3d_shares_radec_to_xyz():
    from spherex_app import scene3d
    assert scene3d.radec_to_xyz is objects_live.radec_to_xyz


def test_bodies_xyz_adds_earth_and_skips_missing_distance():
    earth = [1.0, 0.0, 0.0]
    objs = [
        {"name": "A", "number": 1, "class": "MB", "vmag": 12.0, "ra": 0.0, "dec": 0.0,
         "dg_au": 2.0, "dh_au": 3.0},
        {"name": "B", "number": None, "class": None, "vmag": None, "ra": 0.0, "dec": 90.0,
         "dg_au": None, "dh_au": None},
    ]
    out = objects_live.bodies_xyz(earth, objs)
    assert len(out) == 1
    b = out[0]
    assert (b["x"], b["y"], b["z"]) == pytest.approx((3.0, 0.0, 0.0))
    assert b["dg_au"] == 2.0 and b["dh_au"] == 3.0 and b["name"] == "A"


def test_solar_planets_and_earth_distance():
    sol = objects_live.solar_positions(MJD)
    names = [p["name"] for p in sol["planets"]]
    assert names == ["Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Moon"]
    earth_r = math.sqrt(sum(c * c for c in sol["earth"]))
    assert 0.98 < earth_r < 1.02
    moon = sol["planets"][-1]
    assert math.dist([moon["x"], moon["y"], moon["z"]], sol["earth"]) < 0.01
    neptune = sol["planets"][6]
    assert 29.5 < math.hypot(neptune["x"], neptune["y"], neptune["z"]) < 30.5


def test_earth_xyz_is_cached_and_matches_solar_positions():
    a = objects_live.earth_xyz(MJD)
    assert objects_live.earth_xyz(MJD) is a
    assert objects_live.earth_xyz.cache_info().hits >= 1
    assert list(a) == pytest.approx(objects_live.solar_positions(MJD)["earth"])


# --- ephem source -----------------------------------------------------------------------------

def test_ephem_returns_sun_eight_planets_with_earth_and_the_moon():
    recs = objects_live.ephem_records(MJD)
    assert len(recs) == 10
    assert all(objects.validate_record(r) == [] for r in recs)
    kinds = [r["kind"] for r in recs]
    assert kinds.count("sun") == 1 and kinds.count("planet") == 8 and kinds.count("moon") == 1
    ids = {r["id"] for r in recs}
    assert ids == {f"ss:{n}" for n in ("sun", "mercury", "venus", "earth", "mars", "jupiter",
                                       "saturn", "uranus", "neptune", "moon")}


def test_ephem_hosts_parents_radii_and_evidence():
    recs = _by_id(objects_live.ephem_records(MJD))
    assert all(r["host"] == "ss:sun" for r in recs.values())
    assert recs["ss:moon"]["parent"] == "ss:earth"
    assert recs["ss:mars"]["parent"] == "ss:sun"
    assert recs["ss:sun"]["parent"] is None
    radii = {k: r["size"]["radius"] for k, r in recs.items()}
    assert radii["ss:mars"]["v"] == 3396 and radii["ss:moon"]["v"] == 1737
    assert radii["ss:earth"]["v"] == 6378 and radii["ss:sun"]["v"] == 695700
    assert radii["ss:sun"]["src"] == "IAU 2015 nominal solar radius"
    assert radii["ss:mars"]["src"] == "IAU WGCCRE 2015 equatorial radius"
    assert all(r["size"]["radius"]["unit"] == "km" for r in recs.values())
    for r in recs.values():
        assert r["evidence"] == "measured" and r["position"]["tier"] == "measured"
        assert r["position"]["method"] == "ephemeris"
        assert "mag" not in r["render"]  # magnitudes are not invented
        assert "in_cone" not in r        # set by the endpoint


def test_ephem_geo_agrees_with_xyz_minus_earth():
    recs = objects_live.ephem_records(MJD)
    earth = _by_id(recs)["ss:earth"]["position"]["xyz_au"]
    for r in recs:
        if r["id"] == "ss:earth":
            continue
        x, y, z = (a - b for a, b in zip(r["position"]["xyz_au"], earth))
        d = math.sqrt(x * x + y * y + z * z)
        geo = r["position"]["geo"]
        assert geo["dist_au"] == pytest.approx(d, abs=1e-5)
        assert geo["dec"] == pytest.approx(math.degrees(math.asin(z / d)), abs=1e-4)
        assert geo["ra"] == pytest.approx(math.degrees(math.atan2(y, x)) % 360.0, abs=1e-4)
        assert r["props"]["dist_earth"]["v"] == pytest.approx(d, abs=1e-5)
        assert r["props"]["dist_earth"]["tier"] == "measured"


def test_sun_geo_points_away_from_earth_and_is_at_the_origin():
    sun = _by_id(objects_live.ephem_records(MJD))["ss:sun"]
    earth = objects_live.earth_xyz(MJD)
    assert sun["position"]["xyz_au"] == [0.0, 0.0, 0.0]
    d = math.sqrt(sum(c * c for c in earth))
    assert sun["position"]["geo"]["dist_au"] == pytest.approx(d, abs=1e-5)
    ra, dec = math.radians(sun["position"]["geo"]["ra"]), math.radians(sun["position"]["geo"]["dec"])
    u = (math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec))
    assert u == pytest.approx(tuple(-c / d for c in earth), abs=1e-4)


def test_earth_has_no_geo_and_is_never_in_the_cone():
    earth = _by_id(objects_live.ephem_records(MJD))["ss:earth"]
    assert "geo" not in earth["position"]
    assert "dist_earth" not in earth["props"]
    assert objects.validate_record(earth) == []
    assert not objects.cone_contains(earth, 0.0, 0.0, 180.0)


def test_planet_distance_props_are_in_au():
    mars = _by_id(objects_live.ephem_records(MJD))["ss:mars"]
    assert mars["props"]["dist_sun"]["unit"] == "au" and 1.3 < mars["props"]["dist_sun"]["v"] < 1.7


def test_ephem_provenance():
    r = objects_live.ephem_records(MJD)[0]
    assert r["provenance"]["source"] == "ephem"
    assert r["provenance"]["version"].startswith("astropy ")


# --- classification and ids -------------------------------------------------------------------

def _obj(**kw):
    base = {"number": None, "name": "", "class": None, "vmag": 20.0, "ra": 10.0, "dec": 5.0,
            "dg_au": 2.0, "dh_au": 3.0, "err_arcsec": None}
    base.update(kw)
    return base


@pytest.mark.parametrize("kw,kind", [
    (dict(class_="MB>Middle", name="2019 YB21"), "asteroid"),
    (dict(class_="MB>Inner", number=4, name="Vesta"), "asteroid"),
    (dict(class_="Comet", name="Halley"), "comet"),
    (dict(class_="Comet", name="C/2020 F3 (NEOWISE)"), "comet"),
    (dict(class_=None, name="C/2020 F3 (NEOWISE)"), "comet"),
    (dict(class_=None, name="29P/Schwassmann-Wachmann"), "comet"),
    (dict(class_="comet", name="whatever"), "comet"),
    (dict(class_=None, name="P/2010 A2 (LINEAR)"), "comet"),
    (dict(class_=None, name="1P/Halley"), "comet"),
    (dict(class_="Centaur", number=2060, name="Chiron"), "asteroid"),
    (dict(class_="Centaur", name="2019 UN13"), "asteroid"),
    (dict(class_="MB>Outer", number=1, name="Ceres"), "dwarf_planet"),
    (dict(class_="TNO", number=134340, name="Pluto"), "dwarf_planet"),
    (dict(class_="TNO", number=136199, name="Eris"), "dwarf_planet"),
    (dict(class_="TNO", number=136108, name="Haumea"), "dwarf_planet"),
    (dict(class_="TNO", number=136472, name="Makemake"), "dwarf_planet"),
    (dict(class_="TNO", number=90377, name="Sedna"), "asteroid"),     # never by class
    (dict(class_="Dwarf Planet", number=50000, name="Quaoar"), "asteroid"),
])
def test_classify(kw, kind):
    kw = dict(kw)
    kw["class"] = kw.pop("class_")
    assert objects_live.classify(_obj(**kw)) == kind


def _rec(o, mjd=MJD):
    body = objects_live.bodies_xyz([1.0, 0.0, 0.0], [o])[0]
    return objects_live.skybot_record(o, body, mjd, mjd + objects_live.SKYBOT_JD_OFFSET)


def test_ids_and_names():
    assert _rec(_obj(number=1, name="Ceres", **{"class": "MB>Outer"}))["id"] == "mp:1"
    assert _rec(_obj(name="2019 YB21", **{"class": "MB>Middle"}))["id"] == "mp:2019 YB21"
    c = _rec(_obj(name="C/2020 F3 (NEOWISE)", **{"class": "Comet"}))
    assert c["id"] == "comet:C/2020 F3" and c["name"] == "C/2020 F3 (NEOWISE)"
    assert c["designations"] == ["C/2020 F3"]
    p = _rec(_obj(name="29P/Schwassmann-Wachmann", **{"class": "Comet"}))
    assert p["id"] == "comet:29P" and p["name"] == "29P/Schwassmann-Wachmann"
    assert p["designations"] == ["29P"]
    # numbered asteroid: name if present, else the number
    assert _rec(_obj(number=433, name="Eros"))["name"] == "Eros"
    nameless = _rec(_obj(number=433, name=""))
    assert nameless["name"] == "433" and nameless["id"] == "mp:433" and nameless["designations"] == []
    assert _rec(_obj(number=433, name="Eros"))["designations"] == ["433"]
    assert _rec(_obj(name="", number=None)) is None


def test_skybot_record_content():
    o = _obj(number=2, name="Pallas", **{"class": "MB>Middle"}, vmag=8.5, ra=83.8, dec=-5.4,
             dg_au=1.5, dh_au=2.6, err_arcsec=0.11)
    r = _rec(o)
    assert objects.validate_record(r) == []
    assert r["kind"] == "asteroid" and r["host"] == "ss:sun" and r["parent"] == "ss:sun"
    assert r["position"]["method"] == "orbit-propagation" and r["position"]["tier"] == "catalogue"
    assert r["position"]["geo"] == {"ra": 83.8, "dec": -5.4, "dist_au": 1.5}
    assert r["evidence"] == "measured" and r["render"] == {"mag": 8.5}
    assert r["size"] is None
    p = r["props"]
    assert p["class"]["v"] == "MB>Middle" and p["vmag"]["unit"] == "mag"
    assert p["dist_sun"]["v"] == 2.6 and p["dist_earth"]["v"] == 1.5
    assert p["pos_err"]["v"] == 0.11 and p["pos_err"]["unit"] == "arcsec"
    assert all(q["src"] == "IMCCE SkyBoT" and q["tier"] == "catalogue" for q in p.values())
    assert r["provenance"]["source"] == "skybot" and r["provenance"]["query"]["observer"] == "500"
    # heliocentric xyz = earth + dg * unit
    assert r["position"]["xyz_au"] == pytest.approx(
        [1.0 + 1.5 * math.cos(math.radians(-5.4)) * math.cos(math.radians(83.8)),
         1.5 * math.cos(math.radians(-5.4)) * math.sin(math.radians(83.8)),
         1.5 * math.sin(math.radians(-5.4))], abs=1e-5)


def test_optional_props_are_omitted_when_unknown():
    r = _rec(_obj(number=7, name="Iris", vmag=None, dh_au=None))
    assert set(r["props"]) == {"dist_earth"} and r["render"] == {}
    assert objects.validate_record(r) == []


def test_comet_magnitude_is_labelled_total():
    r = _rec(_obj(name="C/2099 A1", **{"class": "Comet"}, vmag=12.0))
    assert r["props"]["vmag"]["src"] == "IMCCE SkyBoT (total magnitude)"


# --- skybot source (stubbed service) ----------------------------------------------------------

def _fake_skybot(objs=None, exc=None, seen=None):
    async def fake(ra, dec, radius, jd):
        if seen is not None:
            seen.append((ra, dec, radius, jd))
        if exc is not None:
            raise exc
        return objs or []
    return fake


def test_skybot_fetch_builds_records_and_skips_objects_without_a_distance(monkeypatch):
    seen = []
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot([
        _obj(number=1, name="Ceres", **{"class": "MB>Outer"}),
        _obj(name="2019 YB21", dg_au=None),
        _obj(name="C/2020 F3 (NEOWISE)", **{"class": "Comet"}),
    ], seen=seen))
    src = objects_live.sources()[1]
    q = objects.Query(10.0, 5.0, 2.0, MJD, ("asteroid",), 100)
    recs = asyncio.run(src.fetch(q))
    assert [r["id"] for r in recs] == ["mp:1", "comet:C/2020 F3"]
    assert seen == [(10.0, 5.0, 2.0, MJD + 2400000.5)]
    assert src.id == "skybot" and src.precedence == 20
    assert src.kinds == ("dwarf_planet", "asteroid", "comet")


def test_ephem_source_definition():
    src = objects_live.sources()[0]
    assert src.id == "ephem" and src.precedence == 10 and src.kinds == ("sun", "planet", "moon")
    assert not src.cone  # the Sun and planets are always all returned


# --- position.osc from SkyBoT's state vector (Phase 5, 20.4.2 and 20.11) -----------------------

def _vec_obj(**kw):
    d = dict(pos_au=[-1.575878951, 1.985450153, 0.762556773],
             vel_au_d=[-0.008847251, -0.004040727, -0.001560848], ref_epoch_jd=2460000.0)
    d.update(kw)  # MJD 60000.0 is JD 2460000.5, so the reference epoch is 0.5 d before it
    return _obj(**d)


def test_skybot_record_writes_osc():
    r = _rec(_vec_obj(number=425642, name="2010 VJ175", **{"class": "MB>Inner"}))
    assert objects.validate_record(r) == []
    assert r["position"]["osc"] == {
        "epoch_jd": 2460000.0, "xyz_au": [-1.575878951, 1.985450153, 0.762556773],
        "vxyz_au_d": [-0.008847251, -0.004040727, -0.001560848], "frame": "icrf-heliocentric",
        "src": "IMCCE SkyBoT state vector at its reference epoch", "tier": "catalogue"}


def test_skybot_osc_rounding_is_deterministic():
    r = _rec(_vec_obj(name="X", pos_au=[1.23456789012345, 0.0, 0.0],
                      vel_au_d=[0.0123456789012345, 0.0, 0.0]))
    assert objects.validate_record(r) == []
    assert r["position"]["osc"]["xyz_au"][0] == 1.23456789
    assert r["position"]["osc"]["vxyz_au_d"][0] == 0.012345678901


@pytest.mark.parametrize("kw", [
    {}, {"pos_au": None}, {"vel_au_d": None}, {"ref_epoch_jd": None},
    {"pos_au": [1.0, float("nan"), 0.0]}, {"vel_au_d": [1.0, 2.0]},
])
def test_skybot_record_without_complete_vectors_has_no_osc(kw):
    o = _obj(name="X", **{"class": "MB>Inner"})
    if kw:
        o = _vec_obj(name="X", **{"class": "MB>Inner"})
        o.update(kw)
    r = _rec(o)
    assert "osc" not in r["position"] and objects.validate_record(r) == []


def test_osc_does_not_change_xyz_or_geo():
    plain = _rec(_obj(number=2, name="Pallas", ra=83.8, dec=-5.4, dg_au=1.5))
    withv = _rec(_vec_obj(number=2, name="Pallas", ra=83.8, dec=-5.4, dg_au=1.5))
    withv["position"].pop("osc")
    assert withv == plain


def test_skybot_fetch_passes_the_vectors_through(monkeypatch):
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot([
        _vec_obj(number=1, name="Ceres", **{"class": "MB>Outer"}),
        _obj(name="2019 YB21", **{"class": "MB>Middle"}),
    ]))
    src = objects_live.sources()[1]
    recs = asyncio.run(src.fetch(objects.Query(10.0, 5.0, 2.0, MJD, ("asteroid",), 100)))
    assert "osc" in recs[0]["position"] and "osc" not in recs[1]["position"]
    assert recs[0]["position"]["osc"]["epoch_jd"] == 2460000.0
