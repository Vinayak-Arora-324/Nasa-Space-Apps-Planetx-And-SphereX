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
    assert [f.stem for f in FILES] == ["asteroid", "black_hole", "cluster", "comet", "exoplanet",
                                       "galaxy", "planet", "star_host"]


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
    assert objects.HOSTED_KINDS == ("exoplanet",)


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
    cl = load("cluster")  # 56.6, 24.1, angular major 1.3 deg
    assert objects.cone_contains(cl, 56.6, 24.1, 0.01)


def test_cone_contains_adds_the_angular_radius():
    cl = load("cluster")  # radius 0.65 deg
    assert objects.cone_contains(cl, 56.6, 25.0, 0.5)       # 0.9 deg away < 0.5 + 0.65
    assert not objects.cone_contains(cl, 56.6, 25.0, 0.2)   # 0.9 deg away > 0.2 + 0.65


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
