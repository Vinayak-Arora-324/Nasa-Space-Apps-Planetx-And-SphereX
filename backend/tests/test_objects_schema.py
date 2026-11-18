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


def test_all_seven_doc_examples_are_present():
    assert [f.stem for f in FILES] == ["asteroid", "black_hole", "cluster", "comet", "exoplanet",
                                       "galaxy", "planet"]


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
        ("exoplanet", lambda r: r.update(evidence="measured")),
    "orbit with an unknown phase and a measured position tier":
        ("exoplanet", lambda r: r["position"].update(tier="measured")),
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


def test_known_phase_orbit_follows_the_tier_cap():
    r = load("exoplanet")
    r["position"]["phase_known"] = True
    r["position"]["tier"], r["evidence"] = "catalogue", "measured"
    assert objects.validate_record(r) == []
    r["position"]["tier"] = "illustrative"
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


def test_cone_contains_has_no_sky_position_for_orbits_and_earth():
    assert not objects.cone_contains(load("exoplanet"), 0, 0, 180)
    earth = load("planet")
    del earth["position"]["geo"]
    assert not objects.cone_contains(earth, 0, 0, 180)


def test_cone_contains_wraps_in_ra():
    r = load("asteroid")
    r["position"]["geo"].update(ra=359.95, dec=0.0)
    assert objects.cone_contains(r, 0.05, 0.0, 0.2)
