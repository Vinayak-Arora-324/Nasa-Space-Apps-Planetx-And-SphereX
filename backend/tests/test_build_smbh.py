"""Offline tests for backend/scripts/build_objects_smbh.py: the eight supermassive black holes at their host galaxies'
distances, every rescaling factor, the M31* non-rescale, the derived NGC 4889*, the sky tile, the licence files and
byte-identical rebuilds (docs/object-framework.md 18.8, 18.18 item 1)."""

from __future__ import annotations

import copy
import importlib.util
import json
import shutil
import sys
from pathlib import Path

import pytest

from spherex_app import objects, objects_static as st

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "backend" / "scripts" / "build_objects_smbh.py"
COMMITTED = ROOT / "frontend" / "data" / "objects" / "smbh-curated"
GALAXIES = ROOT / "frontend" / "data" / "objects" / "galaxies"
BH_COMMITTED = ROOT / "frontend" / "data" / "objects" / "bh-curated"


def _script():
    sys.path.insert(0, str(SCRIPT.parent))
    spec = importlib.util.spec_from_file_location("build_objects_smbh", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["build_objects_smbh"] = mod
    spec.loader.exec_module(mod)
    return mod


b = _script()

# id -> (host id, expected adopted/published factor, adopted distance Mpc, published distance Mpc). The distances are
# the expected values of the current galaxies build (docs/object-framework.md 18.8.2), written here and nowhere in the script.
EXPECTED = {
    "bh:M87*": ("ongc:NGC4486", 16.768 / 16.8, 16.768, 16.8),
    "bh:NGC 4258*": ("ongc:NGC4258", 7.5693 / 7.576, 7.5693, 7.576),
    "bh:M32*": ("ongc:NGC0221", 0.77751 / 0.79, 0.77751, 0.79),
    "bh:Cen A*": ("ongc:NGC5128", 3.5879 / 3.5, 3.5879, 3.5),
    "bh:M81*": ("ongc:NGC3031", 1.0, 3.63, 3.63),
    "bh:M104*": ("ongc:NGC4594", 9.0765 / 9.8, 9.0765, 9.8),
    "bh:NGC 4889*": ("ongc:NGC4889", 103.65 / 103.2, 103.65, 103.2),
}


@pytest.fixture(scope="module")
def cur():
    return json.loads((b.SOURCES / b.CURATED).read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def hosts(cur):
    return b.load_hosts(GALAXIES, {x["host_galaxy"] for x in cur["black_holes"]})[0]


@pytest.fixture(scope="module")
def ds():
    return st.load_dataset(COMMITTED)


@pytest.fixture(scope="module")
def recs(ds):
    return {r["id"]: r for r in st._read_tile(ds, "sky")}


def _src(q):
    return q["src"]


# --- the committed dataset ---------------------------------------------------------------------

def test_eight_records_all_in_the_sky_tile(ds, recs):
    assert ds.manifest["count"] == 8 and ds.manifest["kinds"] == ["black_hole"]
    assert ds.manifest["sky_tiles"] == ["sky"] and set(ds.manifest["tiles"]) == {"sky"}
    assert set(recs) == {"bh:M87*", "bh:NGC 4258*", "bh:M31*", "bh:M32*", "bh:Cen A*", "bh:M81*", "bh:M104*",
                         "bh:NGC 4889*"}
    assert all(isinstance(r, st.SkyRecord) for r in st._read_tile(ds, "sky"))


def test_committed_records_validate(recs, ds):
    for r in recs.values():
        assert objects.validate_record(r) == [], r["id"]
    assert st.verify_dataset(COMMITTED) == []


def test_parent_is_the_host_galaxy_and_the_host_is_null(cur, recs, hosts):
    for bh in cur["black_holes"]:
        r = recs[bh["id"]]
        assert r["kind"] == "black_hole" and r["host"] is None and r["parent"] == bh["host_galaxy"]
        assert r["parent"] in hosts and r["position"]["model"] == "fixed"
        assert r["props"]["type"]["v"] == "supermassive" and r["render"] == {"style": "lensing"}
        assert r["designations"] == bh["designations"]


def test_position_and_distance_are_the_hosts_exactly(cur, recs, hosts):
    for bh in cur["black_holes"]:
        r, h = recs[bh["id"]], hosts[bh["host_galaxy"]]
        for k in ("ra", "dec", "epoch", "method", "tier"):
            assert r["position"][k] == h["position"][k], (bh["id"], k)
        d, hd = r["position"]["dist"], h["position"]["dist"]
        for k in ("v", "lo", "hi", "unit", "tier"):
            assert d.get(k) == hd.get(k), (bh["id"], k)
        assert d["src"] == f"the distance of its host galaxy {h['id']} ({hd['src']})"
        assert r["evidence"] == h["evidence"]


@pytest.mark.parametrize("bid", sorted(EXPECTED))
def test_every_rescaling_factor(bid, cur, recs, hosts):
    host, factor, d_adopted, d_pub = EXPECTED[bid]
    r = recs[bid]
    # the expected distances really are what the committed galaxies and smbh.json hold
    assert hosts[host]["position"]["dist"]["v"] == pytest.approx(d_adopted, rel=1e-9)
    bh = next(x for x in cur["black_holes"] if x["id"] == bid)
    assert bh["assumed_dist"]["v"] == d_pub
    assert d_adopted / d_pub == pytest.approx(factor, rel=1e-12)
    p = r["props"]
    assert r["position"]["dist"]["v"] == pytest.approx(d_adopted, rel=1e-9)
    assert p["dist_published"]["v"] == d_pub and p["dist_published"]["unit"] == "Mpc"
    assert "not used" in p["dist_published"]["src"]
    assert p["mass_published"]["unit"] == p["mass"]["unit"] == "Msun"
    assert p["mass"]["v"] / p["mass_published"]["v"] == pytest.approx(factor, abs=1e-6)
    for k in ("lo", "hi"):          # the interval scales with the value
        assert p["mass"][k] / p["mass_published"][k] == pytest.approx(factor, abs=1e-6)
    assert p["mass_published"]["v"] == bh["mass"]["v"]
    # and the same factor from the host record's distance, as the card computes it
    assert p["mass"]["v"] / p["mass_published"]["v"] == pytest.approx(
        r["position"]["dist"]["v"] / p["dist_published"]["v"], abs=1e-6)


def test_m87_mass_and_ring(recs):
    r = recs["bh:M87*"]
    m, mp = r["props"]["mass"], r["props"]["mass_published"]
    assert mp["v"] == 6.5e9 and mp["lo"] == pytest.approx(6.5e9 - (0.2e9 ** 2 + 0.7e9 ** 2) ** 0.5, rel=1e-6)
    assert m["tier"] == "measured" and r["evidence"] == "measured"
    ring = r["props"]["ring_diameter"]
    assert (ring["v"], ring["lo"], ring["hi"], ring["unit"], ring["tier"]) == (4.2e-5, 3.9e-5, 4.5e-5, "arcsec", "measured")
    assert [k for k, x in recs.items() if "ring_diameter" in x["props"]] == ["bh:M87*"]
    assert "accret" in r["props"]["state"]["v"]


def test_m31_is_not_rescaled_and_says_why(cur, recs):
    p = recs["bh:M31*"]["props"]
    bh = next(x for x in cur["black_holes"] if x["id"] == "bh:M31*")
    assert (p["mass"]["v"], p["mass"]["lo"], p["mass"]["hi"]) == (1.4e8, 1.1e8, 2.3e8)
    assert p["mass_note"]["v"] == bh["no_rescale_reason"] and "not rescaled" in p["mass_note"]["v"]
    assert "mass_published" not in p and "dist_published" not in p
    assert recs["bh:M31*"]["evidence"] == "measured" and p["mass"]["tier"] == "measured"


def test_ngc4889_is_derived_and_its_mass_inferred(recs, hosts):
    r = recs["bh:NGC 4889*"]
    assert hosts["ongc:NGC4889"]["evidence"] == "derived"
    assert r["evidence"] == "derived" and r["position"]["method"] == "fundamental-plane"
    assert r["position"]["dist"]["tier"] == "inferred"
    assert r["props"]["mass"]["tier"] == "inferred" and "inferred" in r["props"]["mass"]["src"]
    assert r["props"]["mass_published"]["tier"] == "measured"
    assert "derived" in r["props"]["mass_note"]["v"]
    for bid, x in recs.items():     # only the derived host gives an inferred mass
        if bid != "bh:NGC 4889*":
            assert x["props"]["mass"]["tier"] == "measured" and x["evidence"] == "measured", bid


def test_ngc4258_shares_the_maser_distance(recs, hosts):
    r = recs["bh:NGC 4258*"]
    h = hosts["ongc:NGC4258"]
    assert r["position"]["dist"]["v"] == h["position"]["dist"]["v"] == 7.5693 and r["position"]["method"] == "maser"
    pub = r["props"]["dist_published"]
    assert pub["v"] == 7.576 and pub["lo"] == pytest.approx(7.576 - (0.082 ** 2 + 0.076 ** 2) ** 0.5, abs=1e-6)
    assert "measured itself" in pub["src"] and "not used" in pub["src"]
    note = r["props"]["mass_note"]["v"]
    assert "Cosmicflows-4 maser distance" in note and "not used" in note


def test_every_number_has_a_src_and_the_radius_is_inferred(recs):
    for r in recs.values():
        for q in [r["position"]["dist"], r["size"]["radius"], *r["props"].values()]:
            assert q["src"] and q["tier"] in objects.TIERS
        assert r["size"]["radius"]["tier"] == "inferred" and r["size"]["radius"]["unit"] == "km"
        m = r["props"]["mass"]["v"]
        assert r["size"]["radius"]["v"] == pytest.approx(m * float(b.bhb.RS_KM_PER_MSUN), rel=1e-3)


def test_no_gaia_and_licence_files():
    m = json.loads((COMMITTED / "manifest.json").read_text())
    pv = m["provenance"]
    assert "No Gaia values." in pv["data_licence_note"] and pv["licence_name"] == "CC BY-SA 4.0"
    assert "Verga" in pv["credit"] and "edd.ifa.hawaii.edu" in pv["data_licence_note"]
    assert "Gaia" not in json.dumps(m).replace("No Gaia values", "").replace("no Gaia", "")
    for d in (COMMITTED, b.SOURCES):
        t = (d / "LICENSE.md").read_text(encoding="utf-8")
        assert "CC BY-SA 4.0" in t or "OpenNGC" in t
        assert "no gaia values" in t.lower()
    assert "CC BY-SA 4.0" in (COMMITTED / "LICENSE.md").read_text() and "EDD" in (COMMITTED / "LICENSE.md").read_text()


def test_bh_curated_is_untouched_and_keeps_sgr_a_star():
    m = json.loads((BH_COMMITTED / "manifest.json").read_text())
    assert m["count"] == 16 and m["provenance"]["credit"] == "Credit: ESA/Gaia/DPAC"
    sky = json.loads((BH_COMMITTED / "tiles" / "sky.json").read_text())["objects"]
    assert [r["id"] for r in sky] == ["bh:Sgr A*"]


def test_report_in_the_manifest(ds):
    rep = ds.manifest["build"]["report"]
    assert ds.manifest["build"]["script"] == b.SCRIPT and rep["records_written"] == 8
    assert rep["by_kind_and_evidence"] == {"black_hole/derived": 1, "black_hole/measured": 7}
    rows = {r["id"]: r for r in rep["black_holes"]}
    assert rows["bh:NGC 4889*"]["evidence"] == "derived" and rows["bh:NGC 4889*"]["mass_tier"] == "inferred"
    assert rows["bh:M31*"]["factor"] is None and rows["bh:M31*"]["rescaled"] is False
    for bid, (host, factor, *_rest) in EXPECTED.items():
        assert rows[bid]["host"] == host and rows[bid]["factor"] == pytest.approx(factor, abs=1e-6)
    assert "bh:M87*" in b.report_table(rep)


# --- the curated file is refused when incomplete -----------------------------------------------

def test_refuses_a_number_without_where_or_src(cur):
    bad = copy.deepcopy(cur)
    del bad["black_holes"][0]["mass"]["where"]
    with pytest.raises(b.CuratedError, match="where is missing"):
        b.check_curated(bad)
    bad = copy.deepcopy(cur)
    bad["black_holes"][1]["assumed_dist"]["src"] = "nobody2020"
    with pytest.raises(b.CuratedError, match="not a key of papers"):
        b.check_curated(bad)


def test_refuses_an_unstated_rescale_rule(cur):
    bad = copy.deepcopy(cur)
    del next(x for x in bad["black_holes"] if x["id"] == "bh:M31*")["no_rescale_reason"]
    with pytest.raises(b.CuratedError, match="no_rescale_reason"):
        b.check_curated(bad)
    bad = copy.deepcopy(cur)
    bad["black_holes"][0]["assumed_dist"] = None
    with pytest.raises(b.CuratedError, match="assumed_dist"):
        b.check_curated(bad)


def test_missing_host_or_host_without_distance_fails_loudly(cur, hosts):
    h = {k: v for k, v in hosts.items() if k != "ongc:NGC4486"}
    with pytest.raises(b.CuratedError, match="ongc:NGC4486 is not in the galaxies dataset"):
        b.build_records(cur, h)
    h = copy.deepcopy(hosts)
    h["ongc:NGC4486"]["position"]["dist"] = None
    with pytest.raises(b.CuratedError, match="has no distance"):
        b.build_records(cur, h)


# --- rebuilds and --check ----------------------------------------------------------------------

def _files(d: Path) -> dict[str, bytes]:
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


def test_rebuild_is_byte_identical(tmp_path):
    b.build(tmp_path / "a")
    b.build(tmp_path / "b")
    assert _files(tmp_path / "a") == _files(tmp_path / "b") == _files(COMMITTED)


def test_check_passes_on_the_committed_dataset(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["build_objects_smbh.py", "--check"])
    assert b.main() == 0
    assert "up to date" in capsys.readouterr().out


def _drifted_galaxies(tmp_path: Path, host: str, factor: float) -> Path:
    """A copy of the galaxies dataset in which `host`'s distance is multiplied by `factor` (tile hashes left stale)."""
    g = tmp_path / "galaxies"
    shutil.copytree(GALAXIES, g)
    man = json.loads((g / "manifest.json").read_text())
    table = man["src_table"]
    for t in man["tiles"]:
        p = g / "tiles" / f"{t}.json"
        doc = json.loads(p.read_text())
        hit = False
        for r in doc["objects"]:
            if r["id"] == host:
                r["position"]["dist"]["v"] = round(r["position"]["dist"]["v"] * factor, 6)
                hit = True
        if hit:
            p.write_text(json.dumps(doc, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    assert table
    return g


def test_check_fails_and_names_the_host_when_a_host_distance_drifts(tmp_path, monkeypatch, capsys):
    g = _drifted_galaxies(tmp_path, "ongc:NGC4486", 1.01)
    monkeypatch.setattr(sys, "argv", ["build_objects_smbh.py", "--check", "--galaxies", str(g)])
    assert b.main() == 1
    err = capsys.readouterr().err
    assert "host galaxy ongc:NGC4486" in err and "16.768" in err and "differs from a fresh build" in err


def test_check_fails_when_a_committed_file_is_edited(tmp_path, monkeypatch, capsys):
    out = tmp_path / "smbh"
    shutil.copytree(COMMITTED, out)
    (out / "LICENSE.md").write_text("changed", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["build_objects_smbh.py", "--check", "--out", str(out)])
    assert b.main() == 1
    assert "LICENSE.md" in capsys.readouterr().err


def test_refresh_is_a_no_op(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["build_objects_smbh.py", "--refresh", "--out", str(tmp_path / "o")])
    assert b.main() == 0
    out = capsys.readouterr().out
    assert "nothing to download" in out and "wrote 8 records" in out
    assert _files(tmp_path / "o") == _files(COMMITTED)
