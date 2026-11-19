"""Offline tests for backend/scripts/build_objects_bh.py: the curated file, the Gaia snapshot, the committed
dataset, the section 16.6 / Thiele-Innes conversion, and the example fixtures (docs/object-framework.md 17.8, 17.12)."""

from __future__ import annotations

import importlib.util
import json
import math
import shutil
import sys
from pathlib import Path

import pytest

from spherex_app import objects, objects_static as st

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "backend" / "scripts" / "build_objects_bh.py"
COMMITTED = ROOT / "frontend" / "data" / "objects" / "bh-curated"
EXAMPLES = Path(__file__).parent / "fixtures" / "objects" / "examples"


def _script():
    spec = importlib.util.spec_from_file_location("build_objects_bh", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["build_objects_bh"] = mod
    spec.loader.exec_module(mod)
    return mod


b = _script()


@pytest.fixture(scope="module")
def inputs():
    return b.load_inputs(b.SOURCES)


@pytest.fixture(scope="module")
def built(inputs):
    records, report = b.build_records(inputs["cur"], inputs["snap"])
    return {r["id"]: r for r in records}, report


def _tree(d: Path) -> dict:
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


# --- the curated file ------------------------------------------------------------------------

def test_every_curated_number_has_src_and_where(inputs):
    b.check_curated(inputs["cur"])      # does not raise
    nums = list(b._walk(inputs["cur"]["systems"]))
    assert len(nums) > 60
    for path, q in nums:
        if q.get("tier") == "illustrative":
            assert q.get("assumed"), path
        else:
            assert q["src"] in inputs["cur"]["papers"] and q["where"], path


def _broken(inputs, mutate):
    cur = json.loads(json.dumps(inputs["cur"]))
    mutate(cur)
    return cur


def test_a_number_without_src_or_where_fails_the_build(inputs, tmp_path):
    def no_where(c):
        del c["systems"][1]["bh"]["mass"]["where"]

    def no_src(c):
        c["systems"][1]["bh"]["position"]["elements"]["e"]["src"] = None

    def bad_key(c):
        c["systems"][0]["bh"]["mass"]["src"] = "nobody2099"

    for mutate in (no_where, no_src, bad_key):
        with pytest.raises(b.CuratedError):
            b.build_records(_broken(inputs, mutate), inputs["snap"])
    # through the command line, from a temp copy of the files
    d = tmp_path / "in"
    shutil.copytree(b.SOURCES, d)
    cur = json.loads((d / b.CURATED).read_text())
    del cur["systems"][0]["bh"]["mass"]["where"]
    (d / b.CURATED).write_text(json.dumps(cur))
    with pytest.raises(b.CuratedError):
        b.build(tmp_path / "out", b.SOURCES, d)


def test_an_assumed_value_needs_illustrative_tier_and_a_reason(inputs):
    def no_reason(c):
        c["systems"][5]["bh"]["position"]["elements"]["e"].pop("assumed")

    def not_illustrative(c):
        c["systems"][5]["bh"]["position"]["elements"]["e"]["tier"] = "measured"

    for mutate in (no_reason, not_illustrative):
        with pytest.raises(b.CuratedError):
            b.build_records(_broken(inputs, mutate), inputs["snap"])


def test_assumed_values_are_illustrative_with_their_reason(built):
    recs, _ = built
    e = recs["bh:V404 Cyg"]["position"]["elements"]["e"]
    assert e["tier"] == "illustrative" and e["src"] == "no eccentricity published; circular assumed"
    e = recs["bh:A0620-00"]["position"]["elements"]["e"]
    assert e["tier"] == "illustrative" and e["src"].startswith("assumed circular by Cantrell")


# --- numbers ---------------------------------------------------------------------------------

def test_schwarzschild_radius_from_the_mass(built):
    recs, _ = built
    sgr = recs["bh:Sgr A*"]["size"]["radius"]
    assert sgr["v"] == pytest.approx(1.269e7, rel=1e-3) and sgr["unit"] == "km"
    r1 = recs["bh:Gaia BH1"]["size"]["radius"]
    assert (r1["v"], r1["lo"], r1["hi"]) == (28.41, 27.88, 28.94)
    for r in recs.values():
        if r["kind"] == "black_hole":
            assert r["size"]["radius"]["tier"] == "inferred" and r["size"]["angular"] is None
            assert r["size"]["radius"]["src"] == "Schwarzschild radius from the mass (non-rotating)"
            assert r["render"] == {"style": "lensing"}


def test_unit_conversions(built):
    recs, _ = built
    sgr = recs["bh:Sgr A*"]["position"]
    assert (sgr["ra"], sgr["dec"]) == (266.4168371, -29.0078106)
    assert recs["bh:GRS 1915+105"]["position"]["dist"]["v"] == 8600
    assert recs["gdr3:2059383668236814720"]["position"]["dist"]["v"] == 2220       # kpc to pc
    bh1 = recs["gdr3:4373465352415301632"]["position"]["dist"]
    assert (bh1["v"], bh1["lo"], bh1["hi"]) == (478.47, 473.93, 483.09)           # 1000 / (2.09 +- 0.02)
    tp = recs["bh:Gaia BH1"]["position"]["elements"]["t_peri_mjd"]
    assert tp["v"] == 57387.4 and tp["lo"] == 57386.7
    a620 = recs["gdr3:3118721026600835328"]
    assert a620["position"]["dist"]["v"] == pytest.approx(1000 / 0.6969215127, abs=0.01)
    assert a620["position"]["dist"]["src"].startswith("Gaia DR3 parallax (single-star solution), inverted;")


def test_kepler_third_law_for_the_x_ray_binaries(built):
    recs, _ = built
    cyg = recs["bh:Cyg X-1"]["position"]["elements"]
    a = ((21.2 + 40.6) * (5.599829 / 365.25) ** 2) ** (1 / 3)
    assert cyg["a_au"]["v"] == pytest.approx(a, rel=1e-3) and cyg["a_au"]["tier"] == "inferred"
    v404 = recs["bh:V404 Cyg"]["position"]["elements"]["a_au"]
    a = ((9.0 + 0.06 * 9.0) * (6.471170 / 365.25) ** 2) ** (1 / 3)
    assert v404["v"] == pytest.approx(a, rel=1e-3) and "q M_BH" in v404["src"] and v404["tier"] == "inferred"


def test_bh3_relative_semi_major_axis(built):
    recs, _ = built
    a = recs["bh:Gaia BH3"]["position"]["elements"]["a_au"]
    assert a["v"] == pytest.approx(16.17 * (32.70 + 0.76) / 32.70, abs=1e-3) and a["tier"] == "inferred"
    assert "a1 (M_BH + M*) / M_BH" in a["src"] and "inferred" in a["src"]
    assert "preliminary" in recs["bh:Gaia BH3"]["position"]["src"].lower()


# --- the node + 180 degree conversion --------------------------------------------------------

D2R = math.pi / 180


def _kepler(M: float, e: float) -> float:
    M = M % (2 * math.pi)
    E = M + e * math.sin(M) if e <= 0.8 else math.pi
    for _ in range(50):
        dE = (E - e * math.sin(E) - M) / (1 - e * math.cos(E))
        E -= dE
        if abs(dE) < 1e-12:
            break
    return E


def _sky_offsets(rec: dict, mjd: float) -> tuple[float, float]:
    """Mirror of orbitPlacement in scene3d-orbits.js (periastron phase, no assumed values), projected on north and
    east at the host: Z is toward the observer and u = omega + nu."""
    el = rec["position"]["elements"]
    P, a, e = el["period_d"]["v"], el["a_au"]["v"], el["e"]["v"]
    w, node, incl = el["omega_deg"]["v"] * D2R, el["node_deg"]["v"] * D2R, el["i_deg"]["v"] * D2R
    E = _kepler(2 * math.pi / P * (mjd - el["t_peri_mjd"]["v"]), e)
    nu = 2 * math.atan2(math.sqrt(1 + e) * math.sin(E / 2), math.sqrt(1 - e) * math.cos(E / 2))
    r, u = a * (1 - e * math.cos(E)), w + nu
    cO, sO, ci, si, cu, su = math.cos(node), math.sin(node), math.cos(incl), math.sin(incl), math.cos(u), math.sin(u)
    # the offset along (N, E, Z) is exactly the (xn, ye, z) of toIcrs before it is rotated into ICRS
    return r * (cO * cu - sO * su * ci), r * (sO * cu + cO * su * ci)


def _thiele_innes(a: float, e: float, omega: float, node: float, incl: float, P: float, tp: float, mjd: float):
    """The luminous star's offset about the barycentre (north, east) in the Gaia / Halbwachs convention."""
    w, O, i = omega * D2R, node * D2R, incl * D2R
    A = a * (math.cos(w) * math.cos(O) - math.sin(w) * math.sin(O) * math.cos(i))
    B = a * (math.cos(w) * math.sin(O) + math.sin(w) * math.cos(O) * math.cos(i))
    F = -a * (math.sin(w) * math.cos(O) + math.cos(w) * math.sin(O) * math.cos(i))
    G = -a * (math.sin(w) * math.sin(O) - math.cos(w) * math.cos(O) * math.cos(i))
    E = _kepler(2 * math.pi / P * (mjd - tp), e)
    X, Y = math.cos(E) - e, math.sqrt(1 - e * e) * math.sin(E)
    return A * X + F * Y, B * X + G * Y


@pytest.mark.parametrize("name,star_a_fraction", [("Gaia BH1", 0.04), ("Gaia BH2", 0.1), ("Gaia BH3", 0.03)])
def test_node_plus_180_gives_minus_the_stars_thiele_innes_offset(inputs, built, name, star_a_fraction):
    recs, _ = built
    rec = recs[f"bh:{name}"]
    el = next(s for s in inputs["cur"]["systems"] if s["bh"]["id"] == f"bh:{name}")["bh"]["position"]["elements"]
    P, e = el["period_d"]["v"], el["e"]["v"]
    tp = el["t_peri_jd"]["v"] - 2400000.5
    a_rel = rec["position"]["elements"]["a_au"]["v"]
    a_star = a_rel * star_a_fraction          # the star's orbit about the barycentre is a fraction of the relative one
    assert rec["position"]["elements"]["node_deg"]["v"] == pytest.approx((el["node_deg"]["v"] + 180) % 360, abs=1e-9)
    for k in range(5):
        mjd = tp + (k + 0.3) * P / 5
        bn, be = _sky_offsets(rec, mjd)
        sn, se = _thiele_innes(a_star, e, el["omega_deg"]["v"], el["node_deg"]["v"], el["i_deg"]["v"], P, tp, mjd)
        scale = a_rel / a_star
        assert bn == pytest.approx(-scale * sn, abs=1e-9 * a_rel) and be == pytest.approx(-scale * se, abs=1e-9 * a_rel)
    # with Omega itself instead of Omega + 180 the directions would be opposite, so the test can tell them apart
    wrong = json.loads(json.dumps(rec))
    wrong["position"]["elements"]["node_deg"]["v"] = el["node_deg"]["v"]
    bn, be = _sky_offsets(wrong, tp + 0.3 * P / 5)
    sn, se = _thiele_innes(a_star, e, el["omega_deg"]["v"], el["node_deg"]["v"], el["i_deg"]["v"], P, tp, tp + 0.3 * P / 5)
    assert bn * sn + be * se > 0


# --- evidence, hosting, distance -------------------------------------------------------------

def test_evidence_and_tiers(built):
    recs, report = built
    assert recs["bh:Gaia BH3"]["evidence"] == "derived" and recs["bh:Gaia BH3"]["position"]["tier"] == "inferred"
    for n in ("Cyg X-1", "V404 Cyg", "A0620-00", "MAXI J1820+070"):
        r = recs[f"bh:{n}"]
        assert r["evidence"] == "illustrative" and r["position"]["tier"] == "illustrative"
        assert r["position"]["phase_known"] is False and r["position"]["elements"]["node_deg"] is None
        assert "orientation is illustrative" in r["position"]["src"]
    for n in ("Gaia BH1", "Gaia BH2", "Sgr A*", "GRS 1915+105"):
        assert recs[f"bh:{n}"]["evidence"] == "measured"
    stars = [r for r in recs.values() if r["kind"] == "star"]
    assert len(stars) == 7 and all(r["evidence"] == "measured" for r in stars)
    assert report["by_kind_and_evidence"] == {"black_hole/derived": 1, "black_hole/illustrative": 4,
                                              "black_hole/measured": 4, "star/measured": 7}
    for n in ("Sgr A*", "GRS 1915+105"):
        r = recs[f"bh:{n}"]
        assert r["host"] is None and r["parent"] is None and r["position"]["model"] == "fixed"


def test_prefer_record_on_exactly_the_seven_companions(built):
    recs, _ = built
    with_pr = sorted(i for i, r in recs.items() if "prefer_record" in r)
    assert with_pr == sorted(objects.PREFER_RECORD_IDS)
    for i in with_pr:
        r = recs[i]
        assert r["prefer_record"]["replace"] == "dist" and r["prefer_record"]["reason"].strip()
        assert "gaia_parallax" in r["props"] and r["props"]["gaia_parallax"]["unit"] == "mas"
        assert r["position"]["dist"]["tier"] == "measured" and r["position"]["epoch"] == 2016.0


def test_no_hosted_black_hole_has_a_distance_of_its_own(built):
    recs, _ = built
    hosted = [r for r in recs.values() if r["kind"] == "black_hole" and r["host"]]
    assert len(hosted) == 7
    for r in hosted:
        assert r["position"]["model"] == "orbit" and "dist" not in r["position"]
        assert r["host"] == r["parent"] and r["host"] in recs
        assert r["position"]["host_radec"] == [recs[r["host"]]["position"]["ra"], recs[r["host"]]["position"]["dec"]]


def test_bh2_companion_uses_the_curated_distance_not_gaia_single_star(built):
    recs, _ = built
    c = recs["gdr3:5870569352746779008"]
    assert c["position"]["dist"]["v"] == pytest.approx(1164, abs=1)
    assert 1000 / c["props"]["gaia_parallax"]["v"] == pytest.approx(1488, abs=2)       # about 1.49 kpc, not used
    assert "RUWE 9.22" in c["props"]["gaia_parallax"]["src"]


def test_snapshot_parallaxes_match_simbad(inputs):
    simbad = {"4373465352415301632": (2.0700, 0.1167), "5870569352746779008": (0.6721, 0.1045),
              "4318465066420528000": (1.6443, 0.069), "2059383668236814720": (0.4439, 0.0149),
              "2056188624872569088": (0.3024, 0.0783), "3118721026600835328": (0.6969, 0.1168),
              "4477902563164690816": (0.3692, 0.078)}
    snap = inputs["snap"]
    assert set(snap) == set(simbad)
    for sid, (plx, err) in simbad.items():
        assert float(snap[sid]["parallax"]) == pytest.approx(plx, abs=6e-5)
        assert float(snap[sid]["parallax_error"]) == pytest.approx(err, abs=6e-5)
        assert float(snap[sid]["ref_epoch"]) == 2016.0


# --- files: snapshot, reproducibility, --check -----------------------------------------------

def test_committed_snapshot_matches_source_json():
    meta = json.loads((b.SOURCES / "SOURCE.json").read_text())
    f = meta["files"][0]
    assert b.sha256((b.SOURCES / b.SNAPSHOT).read_bytes()) == f["sha256"] and f["rows"] == 7
    assert f["service"] and f["adql"] and f["retrieved"] and "CC BY-NC" in f["licence_statement"]


def test_committed_dataset_is_current_and_valid(tmp_path):
    b.build(tmp_path / "again")
    assert _tree(tmp_path / "again") == _tree(COMMITTED)
    assert st.verify_dataset(COMMITTED) == []


def test_manifest_provenance_and_report():
    m = json.loads((COMMITTED / "manifest.json").read_text())
    assert m["count"] == 16 and sorted(m["kinds"]) == ["black_hole", "star"]
    p = m["provenance"]
    assert p["catalogue"] == "Space Maps curated black holes" and p["version"] == "1"
    # the Gaia terms require the credit wherever the values are shown: the app's credits line lists it
    assert p["credit"] == "Credit: ESA, Gaia DPAC" and p["licence_name"].startswith("CC BY-NC 3.0 IGO")
    lic = (COMMITTED / "LICENSE.md").read_text()
    assert "CC BY-NC 3.0 IGO" in lic and "Credit: ESA, Gaia DPAC" in lic
    assert "CC BY-NC 3.0 IGO" in (b.SOURCES / "LICENSE.md").read_text()
    for key, paper in json.loads((b.SOURCES / b.CURATED).read_text())["papers"].items():
        if key != "simbad_cfa":
            assert paper["cite"] in p["citation"] and paper["arxiv"] in p["citation"]
    assert "Gaia DPAC" in p["citation"]
    assert m["build"]["report"]["records_written"] == 16 and m["build"]["report"]["src_where_pairs"]


def test_check_passes_then_fails_on_a_change(tmp_path, monkeypatch):
    out = tmp_path / "out"
    monkeypatch.setattr(sys, "argv", ["x", "--out", str(out)])
    assert b.main() == 0
    monkeypatch.setattr(sys, "argv", ["x", "--check", "--out", str(out)])
    assert b.main() == 0
    tile = next((out / "tiles").glob("*.json"))
    tile.write_bytes(tile.read_bytes().replace(b"measured", b"measureX", 1))
    assert b.main() == 1


def test_local_directory_builds_the_same_records(tmp_path):
    d = tmp_path / "in"
    shutil.copytree(b.SOURCES, d)
    m = b.build(tmp_path / "out", b.SOURCES, d)
    assert m["count"] == 16


# --- the example fixtures --------------------------------------------------------------------

@pytest.mark.parametrize("fixture,rid", [("bh_sgr_a_star", "bh:Sgr A*"), ("bh_gaia_bh1", "bh:Gaia BH1"),
                                         ("star_gaia_bh1_companion", "gdr3:4373465352415301632")])
def test_the_examples_equal_the_built_records(built, fixture, rid):
    example = json.loads((EXAMPLES / f"{fixture}.json").read_text())
    assert example == built[0][rid]
    assert objects.validate_record(example) == []
    ds = st.load_dataset(COMMITTED)
    tile = [r for t in ds.manifest["tiles"] for r in st._read_tile(ds, t) if r["id"] == rid]
    assert tile == [example]
