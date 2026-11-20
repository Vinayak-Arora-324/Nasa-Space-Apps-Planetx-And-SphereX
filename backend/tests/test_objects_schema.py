"""Offline tests for the object record schema and its validator (spherex_app.objects)."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from spherex_app import objects

EXAMPLES = Path(__file__).parent / "fixtures" / "objects" / "examples"
FILES = sorted(EXAMPLES.glob("*.json"))


def load(name: str) -> dict:
    return json.loads((EXAMPLES / f"{name}.json").read_text())


def test_all_doc_examples_are_present():
    assert [f.stem for f in FILES] == ["asteroid", "bh_gaia_bh1", "bh_sgr_a_star", "black_hole", "cluster",
                                       "comet", "exoplanet", "galaxy", "galaxy_and_xviii", "galaxy_ic47",
                                       "galaxy_lmc", "galaxy_m31", "galaxy_m87", "galaxy_milky_way",
                                       "galaxy_ngc12", "nebula_crab", "nebula_m42", "nebula_m57", "planet",
                                       "star_gaia_bh1_companion", "star_host"]


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.stem)
def test_every_doc_example_validates(path):
    assert objects.validate_record(json.loads(path.read_text())) == []


def test_unknown_extra_fields_and_missing_in_cone_are_allowed():
    r = load("planet")
    del r["in_cone"]
    r["something_new"] = {"a": 1}
    r["position"]["extra"] = 5
    assert objects.validate_record(r) == []


def test_validator_never_raises_on_garbage():
    for junk in (None, 5, "x", [], {}, {"id": 3, "position": 7, "props": []}):
        assert objects.validate_record(junk)  # a non-empty problem list, not an exception


def _mut(name, fn):
    r = copy.deepcopy(load(name))
    fn(r)
    return r


REJECTED = {
    "missing id": ("planet", lambda r: r.pop("id")),
    "bad id format": ("planet", lambda r: r.update(id="mars")),
    "id with an empty local part": ("planet", lambda r: r.update(id="ss:")),
    "unknown namespace": ("planet", lambda r: r.update(id="zzz:mars")),
    "unknown kind": ("planet", lambda r: r.update(kind="wormhole")),
    "empty name": ("planet", lambda r: r.update(name="")),
    "designations not a list": ("planet", lambda r: r.update(designations="NAIF 499")),
    "unknown position model": ("planet", lambda r: r["position"].update(model="teleport")),
    "state without a host": ("planet", lambda r: r.update(host=None)),
    "orbit without a host": ("exoplanet", lambda r: r.update(host=None)),
    "state xyz of the wrong length": ("planet", lambda r: r["position"].update(xyz_au=[1, 2])),
    "state with an unknown method": ("planet", lambda r: r["position"].update(method="magic")),
    "fixed ra out of range": ("cluster", lambda r: r["position"].update(ra=360.0)),
    "fixed dec out of range": ("cluster", lambda r: r["position"].update(dec=91)),
    "fixed with a distance but no method": ("cluster", lambda r: r["position"].pop("method")),
    "fixed with an unknown method": ("cluster", lambda r: r["position"].update(method="vibes")),
    "fixed distance in km": ("cluster", lambda r: r["position"]["dist"].update(unit="km")),
    "quantity with an unknown tier": ("planet", lambda r: r["props"]["dist_sun"].update(tier="great")),
    "quantity with an unknown unit": ("planet", lambda r: r["props"]["dist_sun"].update(unit="furlong")),
    "quantity without a src": ("planet", lambda r: r["props"]["dist_sun"].pop("src")),
    "quantity with a non-numeric lo": ("cluster", lambda r: r["position"]["dist"].update(lo="x")),
    "size radius with a bad unit": ("planet", lambda r: r["size"]["radius"].update(unit="parsnip")),
    "provenance without a catalogue": ("planet", lambda r: r["provenance"].pop("catalogue")),
    "unknown evidence": ("planet", lambda r: r.update(evidence="certain")),
    "render.mag not a number": ("planet", lambda r: r["render"].update(mag="bright")),
    "orbit with an unknown phase that is not illustrative":
        ("exoplanet", lambda r: (r["position"].update(phase_known=False), r.update(evidence="measured"))),
    "orbit with an unknown phase and a measured position tier":
        ("exoplanet", lambda r: r["position"].update(phase_known=False, tier="measured")),
    "orbit missing a required element": ("exoplanet", lambda r: r["position"]["elements"].pop("a_au")),
    "orbit phase_known not a boolean": ("exoplanet", lambda r: r["position"].update(phase_known="no")),
}


@pytest.mark.parametrize("label", REJECTED)
def test_mutation_is_rejected(label):
    name, fn = REJECTED[label]
    assert objects.validate_record(_mut(name, fn)), label


# --- the evidence rule (section 3): one case per row ------------------------------------------
# governing tier -> evidence that is allowed / refused
CAP_CASES = [
    ("measured", "measured", True), ("measured", "derived", True), ("measured", "illustrative", True),
    ("catalogue", "measured", True), ("catalogue", "derived", True),
    ("inferred", "measured", False), ("inferred", "derived", True), ("inferred", "illustrative", True),
    ("illustrative", "measured", False), ("illustrative", "derived", False),
    ("illustrative", "illustrative", True),
]


@pytest.mark.parametrize("tier,evidence,ok", CAP_CASES)
def test_evidence_rule_state_position_uses_position_tier(tier, evidence, ok):
    r = load("asteroid")
    r["position"]["tier"], r["evidence"] = tier, evidence
    assert (objects.validate_record(r) == []) is ok


@pytest.mark.parametrize("tier,evidence,ok", CAP_CASES)
def test_evidence_rule_fixed_position_uses_distance_tier(tier, evidence, ok):
    r = load("cluster")
    r["position"]["dist"]["tier"], r["evidence"] = tier, evidence
    assert (objects.validate_record(r) == []) is ok


def test_position_tier_does_not_govern_a_fixed_position_with_a_distance():
    r = load("cluster")
    r["position"]["tier"] = "measured"  # allowed, but ignored: dist.tier governs
    r["position"]["dist"]["tier"], r["evidence"] = "inferred", "measured"
    assert objects.validate_record(r)


@pytest.mark.parametrize("tier,evidence,ok", CAP_CASES)
def test_evidence_rule_direction_only_uses_position_tier(tier, evidence, ok):
    r = load("cluster")
    r["position"]["dist"] = None
    r["position"]["method"] = None   # direction only: no method and no physical radius (section 17.7)
    r["size"]["radius"] = None
    r["position"]["tier"], r["evidence"] = tier, evidence
    assert (objects.validate_record(r) == []) is ok


def test_direction_only_without_a_position_tier_is_rejected():
    r = load("cluster")
    r["position"]["dist"] = None
    assert any("position.tier" in p for p in objects.validate_record(r))


def _fully_known_orbit() -> dict:
    """An orbit with every orientation element known and no illustrative element: the only kind
    that may claim a non-illustrative placement (the archive never has one: no node)."""
    r = load("exoplanet")
    r["position"]["elements"]["node_deg"] = objects.quantity(120.0, "test", "measured", "deg")
    r["position"]["tier"], r["evidence"] = "catalogue", "measured"
    return r


def test_fully_known_orbit_follows_the_tier_cap():
    r = _fully_known_orbit()
    assert objects.validate_record(r) == []
    r["evidence"] = "derived"
    assert objects.validate_record(r) == []
    r["position"]["tier"], r["evidence"] = "inferred", "measured"
    assert objects.validate_record(r)


# --- Phase 1 additions (section 16.5): fields and evidence rules ------------------------------

def test_the_real_exoplanet_example_is_illustrative_because_the_node_is_unknown():
    r = load("exoplanet")
    assert r["position"]["elements"]["node_deg"] is None and r["position"]["phase_known"] is True
    assert r["position"]["tier"] == "illustrative" and r["evidence"] == "illustrative"
    assert objects.validate_record(r) == []


@pytest.mark.parametrize("label,fn", {
    "node unknown": lambda r: r["position"]["elements"].update(node_deg=None),
    "inclination unknown": lambda r: r["position"]["elements"].update(i_deg=None),
    "phase unknown": lambda r: r["position"].update(phase_known=False),
    "an assumed eccentricity":
        lambda r: r["position"]["elements"]["e"].update(tier="illustrative"),
    "an illustrative semi-major axis":
        lambda r: r["position"]["elements"]["a_au"].update(tier="illustrative"),
    "an illustrative period":
        lambda r: r["position"]["elements"]["period_d"].update(tier="illustrative"),
    "an illustrative optional element":
        lambda r: r["position"]["elements"]["t_conj_mjd"].update(tier="illustrative"),
}.items(), ids=lambda x: x if isinstance(x, str) else "")
def test_an_orbit_that_is_not_fully_known_must_have_an_illustrative_position_tier(label, fn):
    r = _fully_known_orbit()
    fn(r)
    problems = objects.validate_record(r)
    assert any("position.tier" in p for p in problems), (label, problems)
    r["position"]["tier"], r["evidence"] = "illustrative", "illustrative"
    assert objects.validate_record(r) == [], label


def test_an_orbit_with_a_null_node_and_tier_catalogue_is_rejected():
    r = load("exoplanet")
    r["position"]["tier"] = "catalogue"
    assert any("position.tier" in p and "node_deg" in p for p in objects.validate_record(r))
    r["evidence"] = "measured"
    assert objects.validate_record(r)


def test_assumed_method_forces_an_illustrative_distance():
    r = load("star_host")
    r["position"]["method"] = "assumed"
    assert any("assumed" in p for p in objects.validate_record(r))   # measured distance
    r["position"]["dist"]["tier"], r["evidence"] = "inferred", "derived"
    assert any("assumed" in p for p in objects.validate_record(r))
    r["position"]["dist"]["tier"], r["evidence"] = "illustrative", "illustrative"
    assert objects.validate_record(r) == []
    r["position"]["dist"] = None   # direction only: nothing to assume
    r["position"]["method"] = None
    r["size"]["radius"] = None
    r["position"]["tier"] = "catalogue"
    r["evidence"] = "measured"
    assert objects.validate_record(r) == []


@pytest.mark.parametrize("hr,ok", [
    ([346.6, -5.0], True), ([0.0, -90.0], True), ([359.999, 90.0], True),
    ([360.0, 0.0], False), ([-1.0, 0.0], False), ([10.0, 90.5], False), ([10.0], False),
    ([10.0, 5.0, 1.0], False), (["a", 5.0], False), ("10 5", False), ({"ra": 1, "dec": 2}, False),
    ([float("nan"), 0.0], False),
])
def test_host_radec_ranges(hr, ok):
    r = load("exoplanet")
    r["position"]["host_radec"] = hr
    assert (objects.validate_record(r) == []) is ok


def test_host_radec_and_t_conj_are_optional():
    r = load("exoplanet")
    del r["position"]["host_radec"]
    r["position"]["elements"].pop("t_conj_mjd")
    assert objects.validate_record(r) == []
    r["position"]["elements"]["t_conj_mjd"] = None
    assert objects.validate_record(r) == []


def test_t_conj_mjd_is_validated_as_a_quantity():
    r = load("exoplanet")
    r["position"]["elements"]["t_conj_mjd"] = {"v": "soon", "src": "x", "tier": "nope"}
    assert objects.validate_record(r)
    r["position"]["elements"]["t_conj_mjd"] = 57322.0
    assert objects.validate_record(r)


def test_same_as_is_a_list_of_valid_ids():
    r = load("star_host")
    assert r["same_as"] == []
    r["same_as"] = ["hip:113357", "gdr3:4472832130942575872", "neahost:OGLE-2005-BLG-390L"]
    assert objects.validate_record(r) == []
    for bad in ("hip:1", ["hip"], ["zzz:1"], [3], [None]):
        r["same_as"] = bad
        assert objects.validate_record(r), bad
    del r["same_as"]
    assert objects.validate_record(r) == []


def test_neahost_namespace_and_lens_model_method():
    r = load("star_host")
    r["id"] = "neahost:OGLE-2005-BLG-390L"
    assert objects.validate_record(r) == []
    r["position"]["method"] = "lens-model"
    r["position"]["dist"]["tier"], r["evidence"] = "inferred", "derived"
    assert objects.validate_record(r) == []
    r["evidence"] = "measured"   # a lens-model distance is inferred: at most derived
    assert objects.validate_record(r)
    assert "neahost" in objects.NAMESPACES and "lens-model" in objects.METHODS
    assert objects.HOSTED_KINDS == ("exoplanet", "black_hole")


def test_star_records_validate_like_any_record():
    r = load("star_host")
    assert r["kind"] == "star" and r["host"] is None
    assert objects.validate_record(r) == []
    r["position"]["ra"] = 400
    assert objects.validate_record(r)


def test_redshift_galaxy_is_derived():
    r = load("galaxy")
    r["position"].update(method="redshift")
    r["position"]["dist"]["tier"], r["evidence"] = "inferred", "derived"
    assert objects.validate_record(r) == []
    r["evidence"] = "measured"
    assert objects.validate_record(r)


# --- helpers ----------------------------------------------------------------------------------

def test_quantity_leaves_out_unset_keys():
    q = objects.quantity(1.5, "src", "measured")
    assert q == {"v": 1.5, "src": "src", "tier": "measured"}
    q = objects.quantity(1.5, "src", "measured", "au", lo=1.0, hi=2.0)
    assert q == {"v": 1.5, "lo": 1.0, "hi": 2.0, "unit": "au", "src": "src", "tier": "measured"}


def test_record_helper_builds_a_valid_record():
    r = objects.record(
        id="test:a", kind="cluster", name="A",
        position={"model": "fixed", "ra": 10.0, "dec": 5.0, "method": "assumed",
                  "dist": objects.quantity(100, "x", "illustrative", "pc")},
        provenance={"source": "test", "catalogue": "t"}, evidence="illustrative")
    assert objects.validate_record(r) == []
    assert r["host"] is None and r["parent"] is None and r["size"] is None
    assert r["props"] == {} and r["render"] == {} and r["designations"] == []


def test_constants_follow_the_doc():
    assert objects.SCHEMA == "space-maps.objects/1"
    assert objects.TILE_FORMAT == "space-maps.object-tiles/1"
    assert objects.KINDS == ("sun", "planet", "moon", "dwarf_planet", "asteroid", "comet", "star",
                             "exoplanet", "cluster", "nebula", "black_hole", "galaxy")
    assert objects.TIERS == ("measured", "catalogue", "inferred", "illustrative")
    assert objects.EVIDENCE == ("measured", "derived", "illustrative")


# --- cone_contains ----------------------------------------------------------------------------

def test_cone_contains_state_uses_geo_and_fixed_uses_ra_dec():
    ast = load("asteroid")  # geo 149.98072, 2.00882
    assert objects.cone_contains(ast, 150.0, 2.0, 0.1)
    assert not objects.cone_contains(ast, 160.0, 2.0, 0.1)
    cl = load("cluster")  # Pleiades, 56.68, 24.11
    assert objects.cone_contains(cl, 56.68, 24.11, 0.01)


def test_cone_contains_adds_the_angular_radius():
    cl = load("cluster")  # Pleiades: angular major 2.29 deg, so a radius of 1.146 deg; 1.9 deg north of it at dec 26.0
    assert objects.cone_contains(cl, 56.68, 26.0, 1.0)      # 1.9 deg away < 1.0 + 1.146
    assert not objects.cone_contains(cl, 56.68, 26.0, 0.5)  # 1.9 deg away > 0.5 + 1.146


def test_an_orbit_is_seen_where_its_host_is():
    r = load("exoplanet")   # host_radec 346.6263919, -5.0434618
    assert objects.sky_position(r) == (346.6263919, -5.0434618)
    assert objects.cone_contains(r, 346.6, -5.0, 0.1)
    assert not objects.cone_contains(r, 346.6, -4.0, 0.5)    # 1 deg away
    assert objects.cone_contains(r, 346.6, -4.0, 1.5)
    assert objects.cone_contains(r, 0.0, -5.0, 14.0)         # across the RA wrap


def test_cone_contains_has_no_sky_position_for_orbits_without_a_host_direction_and_earth():
    r = load("exoplanet")
    del r["position"]["host_radec"]
    assert objects.sky_position(r) is None
    assert not objects.cone_contains(r, 0, 0, 180)
    earth = load("planet")
    del earth["position"]["geo"]
    assert not objects.cone_contains(earth, 0, 0, 180)


def test_cone_contains_wraps_in_ra():
    r = load("asteroid")
    r["position"]["geo"].update(ra=359.95, dec=0.0)
    assert objects.cone_contains(r, 0.05, 0.0, 0.2)


# --- Phase 2 additions (section 17.7) ---------------------------------------------------------

@pytest.mark.parametrize("name", ["nebula_m57", "nebula_m42", "nebula_crab"])
def test_the_nebula_examples_validate_and_have_the_documented_shape(name):
    r = load(name)
    assert objects.validate_record(r) == []
    assert r["kind"] == "nebula" and r["host"] is None and r["parent"] is None


def _direction_only() -> dict:
    return load("nebula_crab")


def test_the_crab_example_is_a_valid_direction_only_record():
    r = _direction_only()
    assert r["position"]["dist"] is None and r["position"].get("method") is None
    assert r["size"]["radius"] is None and r["evidence"] == "measured"
    assert objects.validate_record(r) == []


@pytest.mark.parametrize("label,fn", {
    "a host": lambda r: r.update(host="gdr3:1"),
    "a method": lambda r: r["position"].update(method="photometric"),
    "an inferred size.radius": lambda r: r["size"].update(
        radius=objects.quantity(1.0, "made up", "inferred", "pc")),
    "an illustrative size.radius": lambda r: r["size"].update(
        radius=objects.quantity(1.0, "made up", "illustrative", "pc")),
}.items(), ids=lambda x: x if isinstance(x, str) else "")
def test_a_direction_only_record_may_not_have(label, fn):
    r = _direction_only()
    fn(r)
    problems = objects.validate_record(r)
    assert problems and any(w in " ".join(problems) for w in ("direction", "host")), (label, problems)


def test_the_direction_only_guards_do_not_touch_records_with_a_distance():
    r = load("nebula_m57")      # has a distance: host null, method, radius are all fine
    assert r["position"]["method"] == "parallax" and r["size"]["radius"] is not None
    assert objects.validate_record(r) == []


def _hosted_bh(**kw) -> dict:
    r = load("exoplanet")
    r.update(id="bh:Test BH", kind="black_hole", name="Test BH", render={"style": "lensing"})
    r["position"]["elements"]["node_deg"] = objects.quantity(120.0, "test", "measured", "deg")
    for q in r["position"]["elements"].values():
        if q is not None:
            q["tier"] = "measured"
    r["position"]["tier"], r["evidence"] = "measured", "measured"
    r["props"] = {"mass": objects.quantity(9.6, "test", "measured", "Msun")}
    r.update(kw)
    return r


def test_a_hosted_black_hole_orbit_is_accepted():
    r = _hosted_bh()
    assert objects.validate_record(r) == []
    assert "black_hole" in objects.HOSTED_KINDS


def test_an_orbit_tier_may_not_be_stronger_than_its_weakest_element():
    r = _hosted_bh()
    r["position"]["elements"]["a_au"]["tier"] = "inferred"       # like Gaia BH3's scaled a
    problems = objects.validate_record(r)
    assert any("weakest" in p for p in problems), problems
    r["position"]["tier"] = "catalogue"
    assert any("weakest" in p for p in objects.validate_record(r))
    r["position"]["tier"], r["evidence"] = "inferred", "measured"
    problems = objects.validate_record(r)
    assert problems and not any("weakest" in p for p in problems)   # now only the evidence cap fails
    r["evidence"] = "derived"
    assert objects.validate_record(r) == []
    r["position"]["tier"], r["evidence"] = "illustrative", "illustrative"
    assert objects.validate_record(r) == []


def test_the_orbit_tier_floor_treats_measured_and_catalogue_as_equal():
    r = _hosted_bh()
    r["position"]["elements"]["a_au"]["tier"] = "catalogue"
    r["position"]["tier"] = "measured"
    assert objects.validate_record(r) == []
    r["position"]["elements"]["a_au"]["tier"] = "measured"
    r["position"]["tier"] = "catalogue"
    assert objects.validate_record(r) == []


def test_every_existing_exoplanet_example_orbit_is_still_valid():
    assert objects.validate_record(load("exoplanet")) == []


def test_render_style():
    assert objects.RENDER_STYLES == ("lensing", "milky_way")
    assert objects.validate_record(_hosted_bh()) == []
    r = _hosted_bh()
    r["render"] = {"style": "sparkly"}
    assert any("render.style" in p for p in objects.validate_record(r))
    n = load("nebula_m57")
    n["render"]["style"] = "lensing"
    assert any("lensing" in p for p in objects.validate_record(n))
    n["render"]["style"] = "sparkly"
    assert any("render.style" in p for p in objects.validate_record(n))
    n["render"].pop("style")
    assert objects.validate_record(n) == []
    c = load("black_hole")          # the Sgr A* placeholder uses lensing on a black_hole
    assert c["render"]["style"] == "lensing" and objects.validate_record(c) == []


def _companion(**kw) -> dict:
    r = load("star_host")
    r.update(id="gdr3:5870569352746779008", name="Gaia BH2 companion",
             prefer_record={"replace": ["dist"], "reason": "the single-star solution ignores the orbit"})
    r.update(kw)
    return r


def test_prefer_record_on_a_listed_star_is_accepted():
    assert objects.validate_record(_companion()) == []
    r = _companion()
    r["position"]["dist"]["tier"] = "catalogue"
    assert objects.validate_record(r) == []


def test_prefer_record_may_replace_the_stellar_parameters_the_record_carries():
    r = _companion()
    assert {"teff", "mass"} <= set(r["props"]) and r["size"]["radius"]
    r["prefer_record"]["replace"] = ["dist", "mass", "radius", "teff"]
    assert objects.validate_record(r) == []
    assert objects.PREFER_RECORD_FIELDS == ("dist", "mass", "radius", "teff")


def test_prefer_record_ids_are_the_seven_companions():
    assert objects.PREFER_RECORD_IDS == (
        "gdr3:4373465352415301632", "gdr3:5870569352746779008", "gdr3:4318465066420528000",
        "gdr3:2059383668236814720", "gdr3:2056188624872569088", "gdr3:3118721026600835328",
        "gdr3:4477902563164690816")
    for sid in objects.PREFER_RECORD_IDS:
        assert objects.validate_record(_companion(id=sid)) == []


@pytest.mark.parametrize("label,fn", {
    "an id not in PREFER_RECORD_IDS": lambda r: r.update(id="gdr3:2635476908753563008"),
    "a non-star kind": lambda r: r.update(kind="cluster"),
    "an inferred distance": lambda r: (r["position"]["dist"].update(tier="inferred"),
                                       r.update(evidence="derived")),
    "an illustrative distance": lambda r: (r["position"]["dist"].update(tier="illustrative"),
                                           r.update(evidence="illustrative")),
    "no distance": lambda r: (r["position"].update(dist=None, method=None, tier="catalogue")),
    "a replace value other than a field list": lambda r: r["prefer_record"].update(replace="dist"),
    "an empty field list": lambda r: r["prefer_record"].update(replace=[]),
    "an unlisted field (sky position)": lambda r: r["prefer_record"].update(replace=["dist", "ra"]),
    "an unlisted field (Gaia identity)": lambda r: r["prefer_record"].update(replace=["dist", "identity"]),
    "an unlisted field (photometry)": lambda r: r["prefer_record"].update(replace=["dist", "gmag"]),
    "a list without dist": lambda r: r["prefer_record"].update(replace=["teff"]),
    "a repeated field": lambda r: r["prefer_record"].update(replace=["dist", "dist"]),
    "fields out of order": lambda r: r["prefer_record"].update(replace=["dist", "teff", "mass"]),
    "a non-string field": lambda r: r["prefer_record"].update(replace=["dist", 3]),
    "a replaced field the record lacks": lambda r: (r["props"].pop("mass", None),
                                                    r["prefer_record"].update(replace=["dist", "mass"])),
    "a replaced field without a src": lambda r: (r["props"]["teff"].update(src=""),
                                                 r["prefer_record"].update(replace=["dist", "teff"])),
    "an extra key": lambda r: r["prefer_record"].update(also="position"),
    "no reason": lambda r: r["prefer_record"].pop("reason"),
    "an empty reason": lambda r: r["prefer_record"].update(reason="  "),
    "a non-string reason": lambda r: r["prefer_record"].update(reason=3),
    "no replace": lambda r: r["prefer_record"].pop("replace"),
    "a string value": lambda r: r.update(prefer_record="dist"),
    "a null value": lambda r: r.update(prefer_record=None),
}.items(), ids=lambda x: x if isinstance(x, str) else "")
def test_prefer_record_rejects(label, fn):
    r = _companion()
    fn(r)
    assert any("prefer_record" in p for p in objects.validate_record(r)), label


def test_a_star_without_prefer_record_is_unaffected():
    assert objects.validate_record(load("star_host")) == []


def test_a_direction_only_star_may_have_a_catalogue_or_measured_radius():
    r = load("star_host")
    r["position"]["dist"], r["position"]["method"], r["position"]["tier"] = None, None, "catalogue"
    r["size"] = {"angular": None, "radius": objects.quantity(0.12, "NEA pscomppars", "catalogue", "Rsun")}
    assert objects.validate_record(r) == []
    r["size"]["radius"]["tier"] = "measured"
    assert objects.validate_record(r) == []
    r["size"]["radius"]["tier"] = "inferred"
    assert any("radius" in p for p in objects.validate_record(r))


# --- Phase 3 (docs/object-framework.md 18.9) ---------------------------------------------------

def _gal() -> dict:
    return copy.deepcopy(load("galaxy"))


def _alt(**kw) -> dict:
    a = {"method": "trgb", "dist": {"v": 0.78, "unit": "Mpc", "src": "t", "tier": "measured"},
         "reason": "not used: larger uncertainty"}
    a.update(kw)
    return a


@pytest.mark.parametrize("method", ["maser", "sn-ia", "sn-ii", "supernova", "fundamental-plane",
                                    "horizontal-branch", "rr-lyrae", "cmd", "brightest-stars", "pnlf",
                                    "group-member", "eclipsing-binary", "resolved-stars"])
def test_new_methods_are_accepted(method):
    r = _gal()
    r["position"]["method"] = method
    if method in objects.DERIVED_METHODS:
        r["position"]["dist"]["tier"], r["evidence"] = "inferred", "derived"
    assert objects.validate_record(r) == []


@pytest.mark.parametrize("method", objects.DERIVED_METHODS)
@pytest.mark.parametrize("tier", ["measured", "catalogue"])
def test_derived_method_cannot_be_measured_or_catalogue(method, tier):
    r = _gal()
    r["position"]["method"] = method
    r["position"]["dist"]["tier"] = tier
    assert any("derived" in p for p in objects.validate_record(r))
    r["position"]["dist"]["tier"], r["evidence"] = "inferred", "derived"
    assert objects.validate_record(r) == []


def test_tully_fisher_and_redshift_distance_marked_measured_is_rejected():
    for m in ("tully-fisher", "redshift"):
        r = _gal()
        r["position"]["method"] = m
        assert objects.validate_record(r) != []


def test_new_units():
    r = _gal()
    r["props"]["vel"] = {"v": 300.0, "unit": "km/s", "src": "t", "tier": "measured"}
    r["props"]["sb"] = {"v": 22.0, "unit": "mag/arcsec2", "src": "t", "tier": "measured"}
    assert objects.validate_record(r) == []
    r["props"]["sb"]["unit"] = "mag/sr"
    assert objects.validate_record(r) != []


def test_milky_way_style_only_on_the_milky_way_galaxy():
    r = _gal()
    r.update(id="gal:milky_way")
    r["render"]["style"] = "milky_way"
    assert objects.validate_record(r) == []
    r["id"] = "gal:other"
    assert any("milky_way" in p for p in objects.validate_record(r))
    r["id"], r["kind"] = "gal:milky_way", "cluster"
    assert any("milky_way" in p for p in objects.validate_record(r))


def test_lensing_stays_black_hole_only():
    r = _gal()
    r["render"]["style"] = "lensing"
    assert objects.validate_record(r) != []


def test_alt_distances_valid():
    r = _gal()
    r["alt_distances"] = [_alt(), _alt(method="sn-ia", dist={"v": 0.8, "unit": "Mpc", "src": "t",
                                                            "tier": "inferred"})]
    assert objects.validate_record(r) == []
    r["alt_distances"] = [_alt() for _ in range(4)]
    assert objects.validate_record(r) == []
    r["alt_distances"] = []
    assert objects.validate_record(r) == []


@pytest.mark.parametrize("label,alts", [
    ("five entries", [_alt() for _ in range(5)]),
    ("unknown method", [_alt(method="vibes")]),
    ("no reason", [{k: v for k, v in _alt().items() if k != "reason"}]),
    ("empty reason", [_alt(reason="")]),
    ("extra key", [dict(_alt(), note="x")]),
    ("derived marked measured", [_alt(method="tully-fisher")]),
    ("bad unit", [_alt(dist={"v": 1.0, "unit": "km", "src": "t", "tier": "measured"})]),
    ("non-numeric v", [_alt(dist={"v": "far", "unit": "Mpc", "src": "t", "tier": "measured"})]),
    ("no src", [_alt(dist={"v": 1.0, "unit": "Mpc", "tier": "measured"})]),
    ("not a list", {"a": 1}),
    ("entry not an object", ["x"]),
])
def test_alt_distances_rejected(label, alts):
    r = _gal()
    r["alt_distances"] = alts
    assert objects.validate_record(r) != [], label


def test_alt_distances_need_a_fixed_position():
    r = load("planet")
    r["alt_distances"] = [_alt()]
    assert any("alt_distances" in p for p in objects.validate_record(r))


# --- position.osc and assets (Phase 5, 20.11) ---------------------------------------------------

def _with_osc(**over):
    r = copy.deepcopy(load("asteroid"))
    osc = {"epoch_jd": 2460990.0, "xyz_au": [-2.1, 1.4, 0.6], "vxyz_au_d": [-0.008, -0.004, -0.002],
           "frame": "icrf-heliocentric", "src": "IMCCE SkyBoT state vector at its reference epoch",
           "tier": "catalogue"}
    osc.update(over)
    r["position"]["osc"] = osc   # asteroid example: mjd 61000.0 (JD 2461000.5), orbit-propagation
    return r


def test_osc_on_a_skybot_state_is_accepted():
    assert objects.validate_record(_with_osc(epoch_jd=2461000.0)) == []
    assert objects.validate_record(_with_osc(epoch_jd=2461000.5 + 60, tier="inferred")) == []


@pytest.mark.parametrize("label,over,text", [
    ("non-finite number", {"xyz_au": [1.0, float("nan"), 0.0]}, "osc.xyz_au"),
    ("infinite velocity", {"vxyz_au_d": [float("inf"), 0.0, 0.0]}, "osc.vxyz_au_d"),
    ("not a 3-vector", {"vxyz_au_d": [0.0, 0.0]}, "osc.vxyz_au_d"),
    ("speed of 1 AU/d", {"vxyz_au_d": [1.0, 0.0, 0.0]}, "speed must be below"),
    ("epoch 100 days from mjd", {"epoch_jd": 2461100.5}, "within 60 days"),
    ("epoch not a number", {"epoch_jd": "2461000"}, "osc.epoch_jd"),
    ("unknown frame", {"frame": "ecliptic-heliocentric"}, "osc.frame"),
    ("missing src", {"src": ""}, "osc.src"),
    ("unknown tier", {"tier": "great"}, "osc.tier"),
])
def test_bad_osc_is_rejected(label, over, text):
    probs = objects.validate_record(_with_osc(**over))
    assert any(text in p for p in probs), (label, probs)


def test_osc_tier_may_not_be_stronger_than_the_position():
    r = _with_osc(tier="measured")
    r["position"]["tier"] = "inferred"
    r["evidence"] = "derived"
    assert any("osc.tier" in p and "stronger" in p for p in objects.validate_record(r))
    r["position"]["tier"] = "illustrative"
    r["evidence"] = "illustrative"
    assert any("osc.tier" in p for p in objects.validate_record(r))


def test_osc_needs_orbit_propagation():
    r = _with_osc()
    r["position"]["method"] = "ephemeris"
    assert any("osc: allowed only with method 'orbit-propagation'" in p
               for p in objects.validate_record(r))


def _with_assets(assets):
    r = copy.deepcopy(load("cluster"))
    r["assets"] = assets
    return r


@pytest.mark.parametrize("path", ["members/Melotte_22.json", "members/4423.json", "m/a_b+c-d.e/f"])
def test_assets_accepted(path):
    assert objects.validate_record(_with_assets({"members": path})) == []


@pytest.mark.parametrize("assets,text", [
    ({"members": "members/../x.json"}, "assets.members"),
    ({"members": "../x.json"}, "assets.members"),
    ({"members": "/etc/x.json"}, "assets.members"),
    ({"members": "members//x.json"}, "assets.members"),
    ({"members": "members/x.json/"}, "assets.members"),
    ({"members": 5}, "assets.members"),
    ({"photos": "members/x.json"}, "unknown key"),
    ("members/x.json", "assets: must be an object"),
])
def test_bad_assets_are_rejected(assets, text):
    assert any(text in p for p in objects.validate_record(_with_assets(assets)))
