"""Offline tests for backend/scripts/build_objects_galaxies.py: synthetic rows for every rule, the committed snapshots and
dataset for the expected outcomes of docs/object-framework.md 18.3 and 18.4, the licence files, the 18.13 example
records, and byte-identical rebuilds."""

from __future__ import annotations

import copy
import gzip
import importlib.util
import json
import math
import re
import shutil
import sys
from pathlib import Path

import pytest

from spherex_app import objects, objects_static as st

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "backend" / "scripts" / "build_objects_galaxies.py"
COMMITTED = ROOT / "frontend" / "data" / "objects" / "galaxies"
BH_COMMITTED = ROOT / "frontend" / "data" / "objects" / "bh-curated"
EXAMPLES = Path(__file__).parent / "fixtures" / "objects" / "examples"


def _script():
    sys.path.insert(0, str(SCRIPT.parent))
    spec = importlib.util.spec_from_file_location("build_objects_galaxies", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["build_objects_galaxies"] = mod
    spec.loader.exec_module(mod)
    return mod


b = _script()


# --- synthetic rows ---------------------------------------------------------------------------

def orow(name="NGC0001", typ="G", ra="05:00:00.00", dec="+10:00:00.0", **kw) -> dict:
    r = {c: "" for c in b.neb.ONGC_COLUMNS}
    r.update(Name=name, Type=typ, RA=ra, Dec=dec, MajAx="10.00", MinAx="5.00", **{"B-Mag": "12.0"})
    r.update(kw)
    return r


def urow(name="UGC00001", ra="05 00 00.0", dec="+10 00 00", dist="5.00", f="TRGB", hrv="", a26="2.0", ba="0.5") -> dict:
    return {"Name": name, "RAJ2000": ra, "DEJ2000": dec, "a26": a26, "b/a": ba, "Bmag": "14.0", "TT": "9", "HRV": hrv,
            "Dist": dist, "f_Dist": f}


def gals(*rows):
    return b.read_galaxies(list(rows))[0]


def merge(g_rows, u_rows, overrides=None):
    pairs, rep = b.merge_ungc(gals(*g_rows), b.read_ungc(list(u_rows)), b.read_overrides(overrides or []))
    return pairs, rep


# --- committed data ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def committed():
    ds = st.load_dataset(COMMITTED)
    recs = {}
    for t in ds.manifest["tiles"]:
        for r in st._read_tile(ds, t):
            recs[r["id"]] = r
    return {"ds": ds, "manifest": ds.manifest, "report": ds.manifest["build"]["report"], "recs": recs}


@pytest.fixture(scope="module")
def inputs():
    files = {f["role"]: f for f in json.loads((b.SOURCES / "SOURCE.json").read_text())["files"] if "sha256" in f}
    rows = {role: b.parse_role(role, gzip.decompress((b.SOURCES / f["file"]).read_bytes())) for role, f in files.items()}
    return rows


def rec_dist_pc(r):
    d = r["position"]["dist"]
    return d["v"] * (1e6 if d["unit"] == "Mpc" else 1.0)


# --- parsing ----------------------------------------------------------------------------------

def test_openngc_parsing_types_dup_folding_and_nonex():
    rows = [orow("NGC0001", "G"), orow("NGC0002", "GPair"), orow("NGC0003", "GTrpl"), orow("NGC0004", "GGroup"),
            orow("NGC0005", "OCl"), orow("NGC0006", "NonEx"), orow("IC0100", "Dup", NGC="0001"),
            orow("IC0101", "Dup", IC="0002"), orow("IC0102", "Dup", NGC="0099"), orow("NGC0007", "G", RA="", Dec="")]
    kept, rep = b.read_galaxies(rows)
    assert [k["name"] for k in kept] == ["NGC0001", "NGC0002", "NGC0003", "NGC0004"]
    assert kept[0]["dups"] == ["IC0100"] and kept[1]["dups"] == []
    assert rep["kept_by_type"] == {"G": 1, "GGroup": 1, "GPair": 1, "GTrpl": 1}
    assert rep["excluded"] == {"Dup": 3, "NonEx": 1} and rep["dup_designations_folded"] == 1
    assert rep["galaxies_without_position"] == ["NGC0007"] and rep["dups_without_master"] == []


def test_pgc_is_read_from_identifiers():
    g = gals(orow("NGC0001", Identifiers="2MASX J1,PGC 002557,UGC 00454"), orow("NGC0002", Identifiers="PGC 2557A"))
    assert g[0]["pgc"] == 2557 and g[1]["pgc"] is None


def test_ungc_parsing_sexagesimal_and_axes():
    u = b.read_ungc([urow("And XVIII", "00 02 14.5", "+45 05 20", a26="1.40", ba="0.99"),
                     urow("X", "05 30 00.0", "-00 30 00", a26="", ba="")])
    assert (u[0]["ra"], u[0]["dec"]) == (0.5604167, 45.0888889)
    assert (float(u[0]["maj"]), float(u[0]["min"])) == (1.40, 1.39)
    assert u[1]["dec"] == -0.5 and u[1]["maj"] is None and u[1]["min"] is None
    with pytest.raises(SystemExit):
        b.read_ungc([urow("A"), urow("A")])


def test_norm_key_joins_the_spellings():
    assert b.norm_key("MESSIER031") == b.norm_key("M 31") == "M31"
    assert b.norm_key("NGC0205") == b.norm_key("NGC 205")
    assert b.norm_key("Andromeda IX") == b.norm_key("And IX")
    assert b.norm_key("Sagittarius dSph") == b.norm_key("Sag dSph")


# --- the merge ladder -------------------------------------------------------------------------

def test_merge_by_identifier_ngc_and_messier():
    g = [orow("NGC0205", ra="00:40:22.0", dec="+41:41:07", M="110"), orow("NGC0224", ra="00:42:44.3", dec="+41:16:09", M="031")]
    pairs, rep = merge(g, [urow("NGC0205", "00 40 22.0", "+41 41 07"), urow("MESSIER031", "00 42 44.3", "+41 16 09")])
    assert {k: (p["ongc"], p["rule"]) for k, p in pairs.items()} == {"NGC0205": ("NGC0205", "identifier"),
                                                                      "MESSIER031": ("NGC0224", "identifier")}
    assert rep["by_rule"]["identifier"] == 2


def test_merge_by_override_and_milky_way_and_bad_overrides():
    g = [orow("ESO056-115", ra="05:23:34.5", dec="-69:45:22")]
    ov = [{"ungc": "LMC", "ongc": "ESO056-115", "reason": "r"}, {"ungc": "Milky Way", "ongc": "gal:milky_way", "reason": "r"}]
    pairs, _ = merge(g, [urow("LMC", "05 23 34.6", "-69 45 22"), urow("Milky Way", "17 45 40.0", "-29 00 28")], ov)
    assert pairs["LMC"]["ongc"] == "ESO056-115" and pairs["LMC"]["rule"] == "override"
    assert pairs["Milky Way"]["ongc"] == "gal:milky_way"
    with pytest.raises(b.CuratedError):
        merge(g, [urow("LMC")], [{"ungc": "LMC", "ongc": "NGC9999", "reason": "r"}])
    with pytest.raises(b.CuratedError):
        merge(g, [urow("LMC")], [{"ungc": "SMC", "ongc": "ESO056-115", "reason": "r"}])
    with pytest.raises(b.CuratedError):
        b.read_overrides([{"ungc": "LMC", "ongc": None}])


def test_merge_positional_with_the_velocity_test_and_conflict_fallback():
    g = [orow("A", ra="05:00:00.00", dec="+10:00:00.0", MajAx="8.0", RadVel="1000"),
         orow("B", ra="05:00:00.00", dec="+10:01:30.0", MajAx="8.0", RadVel="1000")]
    # inside max(1', 0.25 * 8') = 2' of both; U1 is nearer A, U2 is also nearest A: the better score keeps A, U2 falls back to B
    u = [urow("U1", "05 00 00.0", "+10 00 05", hrv="1050"), urow("U2", "05 00 00.0", "+10 00 10", hrv="1000"),
         urow("U3", "05 00 00.0", "+10 00 00", hrv="1400")]       # U3: velocity differs by 400 km/s -> no merge
    pairs, rep = merge(g, u)
    assert pairs["U1"]["ongc"] == "A" and pairs["U2"]["ongc"] == "B" and "U3" not in pairs
    assert rep["by_rule"]["positional"] == 2
    # without velocities on one side the test is skipped; beyond max(1', 0.25 MajAx) there is no merge
    pairs, _ = merge([orow("A", MajAx="2.0")], [urow("U", "05 00 00.0", "+10 01 30")])
    assert pairs == {}
    pairs, _ = merge([orow("A", MajAx="2.0")], [urow("U", "05 00 00.0", "+10 00 40")])
    assert pairs["U"]["ongc"] == "A"


def test_each_openngc_galaxy_is_claimed_once():
    g = [orow("A", MajAx="8.0")]
    pairs, _ = merge(g, [urow("NGC9", "05 00 00.0", "+10 00 03"), urow("U2", "05 00 00.0", "+10 00 05")])
    assert len(pairs) == 1


# --- the snapshot merge -----------------------------------------------------------------------

def test_expected_merges_on_the_snapshot(committed):
    pairs = {p["ungc"]: p for p in committed["report"]["ungc_merged_pairs"]}
    for u, o in (("MESSIER031", "NGC0224"), ("MESSIER081", "NGC3031")):
        assert (pairs[u]["ongc"], pairs[u]["rule"]) == (o, "identifier")
    for u, o in (("NGC0221", "NGC0221"), ("MESSIER032", "NGC0221"), ("NGC0205", "NGC0205"), ("NGC4258", "NGC4258"),
                 ("NGC5128", "NGC5128")):
        if u in pairs:
            assert (pairs[u]["ongc"], pairs[u]["rule"]) == (o, "identifier")
    by_ongc = {p["ongc"]: p for p in pairs.values()}
    for o in ("NGC0221", "NGC0205", "NGC4258", "NGC5128", "NGC0224", "NGC3031"):
        assert by_ongc[o]["rule"] == "identifier"
    assert (pairs["LMC"]["ongc"], pairs["LMC"]["rule"]) == ("ESO056-115", "override")
    assert (pairs["SMC"]["ongc"], pairs["SMC"]["rule"]) == ("NGC0292", "override")
    assert (pairs["Fornax"]["ongc"], pairs["Fornax"]["rule"]) == ("ESO356-004", "override")   # one Fornax dSph, not two
    assert "ungc:Fornax" not in committed["recs"]
    assert pairs["Milky Way"]["ongc"] == "gal:milky_way"
    assert "ungc:Milky Way" not in committed["recs"] and "ungc:MW" not in committed["recs"]
    assert not [r for r in committed["recs"] if "Milky Way" in r and r != "gal:milky_way"]
    rep = committed["report"]
    assert rep["ungc_merges"]["identifier"] >= 193 and rep["ungc_merges"]["override"] == 4
    assert rep["ungc_milky_way_row_dropped"] is True
    assert rep["ungc_only"] == 869 - len(pairs) + 0 and rep["ungc_only"] == sum(1 for r in committed["recs"] if r.startswith("ungc:"))
    assert len(rep["ungc_merged_pairs"]) == len(pairs)


def test_merged_records_carry_the_unGC_name_and_openngc_position(committed):
    m31 = committed["recs"]["ongc:NGC0224"]
    assert "MESSIER031" in m31["designations"] and m31["name"] == "Andromeda Galaxy"
    assert (m31["position"]["ra"], m31["position"]["dec"]) == (10.6847917, 41.2690556)


# --- CF4 and McConnachie joins ----------------------------------------------------------------

def test_cf4_by_pgc_and_unique_positional_join_report(committed):
    c = committed["report"]["cf4"]
    assert c["rows"] == 55877 and c["groups_rows"] == 38053
    assert 3900 <= c["joined_by_pgc"] <= 3946 and c["ungc_only_joined_by_position"] == len(c["positional_pairs"]) > 100
    assert all(p["sep_arcmin"] <= 0.5 for p in c["positional_pairs"])
    assert c["positional_conflicts_not_joined"] == []
    assert committed["recs"]["ongc:NGC0224"]["position"]["dist"]["src"].startswith("Cosmicflows-4")
    assert "table2 PGC 2557" in committed["recs"]["ongc:NGC0224"]["position"]["dist"]["src"]
    for p in c["positional_pairs"][:5]:
        assert f"ungc:{p['ungc']}" in committed["recs"]


def test_mcconnachie_rows_used_and_matched(committed, inputs):
    mc = committed["report"]["mcconnachie"]
    assert mc["rows"] == 102 and mc["usable"] == 70 and mc["matched"] == 70 and mc["unmatched"] == []
    usable, skipped = b.mcc_rows(inputs["mcconnachie"])
    assert len(usable) == 70 and sum(skipped.values()) == 32
    names = {r["Name"].strip() for r in usable}
    assert not names & {"Canis Major", "Pisces II", "Triangulum", "Andromeda XXII", "The Galaxy"}
    assert all(p["sep_arcmin"] <= 3.0 for p in mc["pairs"] if p["rule"] == "position")
    sag = committed["recs"]["ungc:Sag dSph"]["position"]
    assert sag["method"] == "resolved-stars" and sag["dist"]["unit"] == "pc"
    assert sag["dist"]["v"] == pytest.approx(26300, rel=0.01)           # about 26 kpc, not UNGC's 0.02 Mpc
    assert "McConnachie" in sag["dist"]["src"]
    assert committed["recs"]["ungc:Sag dSph"]["alt_distances"][0]["method"] == "trgb"


# --- distance ladder --------------------------------------------------------------------------

def cand(cat, method, frac, v=1.0):
    return b.candidate(cat, method, "Mpc", v * 1e6, None, None, frac, "s")


def test_ladder_class_then_uncertainty_then_size_then_catalogue_then_method():
    measured_big = cand("cf4", "trgb", 0.10)
    derived_small = cand("cf4", "tully-fisher", 0.01)
    assert b.choose([derived_small, measured_big])[0] is measured_big            # evidence class first
    no_err = cand("ungc", "cepheid", None)
    assert b.choose([no_err, measured_big])[0] is measured_big                   # has an uncertainty beats none
    small = cand("mcc", "resolved-stars", 0.05)
    assert b.choose([measured_big, small])[0] is small                           # smallest fractional error
    a, c = cand("ungc", "trgb", 0.05), cand("cf4", "sbf", 0.05)
    assert b.choose([a, c])[0] is c                                              # catalogue order: CF4 first
    a, c = cand("cf4", "sbf", 0.05), cand("cf4", "cepheid", 0.05)
    assert b.choose([a, c])[0] is c                                              # fixed method order
    mc = cand("mcc", "resolved-stars", 0.05)
    assert b.choose([mc, cand("ungc", "trgb", None)])[0] is mc
    assert b.choose([]) == (None, [])


def test_alt_distances_are_capped_with_reasons():
    cs = [cand("cf4", "cepheid", 0.03), cand("cf4", "trgb", 0.05), cand("cf4", "sbf", 0.06), cand("mcc", "resolved-stars", 0.07),
          cand("ungc", "trgb", None), cand("cf4", "tully-fisher", 0.1)]
    chosen, alts = b.choose(cs)
    assert chosen["method"] == "cepheid" and len(alts) == objects.MAX_ALT_DISTANCES
    assert alts[0]["reason"] == "not used: larger uncertainty than the cepheid distance"
    rs = " ".join(a["reason"] for a in b.choose(cs[:1] + [cand("ungc", "trgb", None), cand("cf4", "tully-fisher", 0.01)])[1])
    assert "no published uncertainty" in rs and "a derived method; a measured cepheid distance exists" in rs


def test_m31_ladder_on_the_snapshot(committed):
    m31 = committed["recs"]["ongc:NGC0224"]
    assert m31["position"]["method"] == "cepheid" and m31["evidence"] == "measured"
    assert m31["position"]["dist"]["v"] == pytest.approx(0.7575, abs=0.002)
    alts = {a["method"]: a for a in m31["alt_distances"]}
    assert {"trgb", "sbf", "resolved-stars"} <= set(alts) and len(m31["alt_distances"]) == 4
    assert [a["method"] for a in m31["alt_distances"]].count("cepheid") == 1          # UNGC's Cepheid value
    assert any("UNGC" in a["dist"]["src"] for a in m31["alt_distances"])
    assert any("McConnachie" in a["dist"]["src"] for a in m31["alt_distances"])
    assert all(a["reason"].startswith("not used") for a in m31["alt_distances"])
    assert objects.validate_record(m31) == []


def test_ngc4258_maser_and_m81_unGC_cepheid_without_interval(committed):
    n = committed["recs"]["ongc:NGC4258"]
    assert n["position"]["method"] == "maser" and n["position"]["dist"]["tier"] == "measured"
    assert n["position"]["dist"]["v"] == pytest.approx(7.586, abs=0.03) and "DMmas" in n["position"]["dist"]["src"]
    m81 = committed["recs"]["ongc:NGC3031"]["position"]
    assert m81["method"] == "cepheid" and m81["dist"]["v"] == 3.63 and "lo" not in m81["dist"] and "hi" not in m81["dist"]
    assert "UNGC" in m81["dist"]["src"] and "0.01 Mpc" in m81["dist"]["src"] and "no per-galaxy error" in m81["dist"]["src"]


def test_method_to_tier_table_and_unused_unGC_codes():
    for code, method in b.UNGC_METHODS.items():
        c = b.ungc_candidate(b.read_ungc([urow("X", f=code)])[0])
        want = "measured" if method in ("trgb", "cepheid", "sbf", "horizontal-branch", "rr-lyrae", "cmd") else "inferred"
        assert c["q"]["tier"] == want and c["method"] == method and c["cls"] == (0 if want == "measured" else 1)
        assert method in objects.METHODS
    for code in b.UNGC_UNUSED:
        assert b.ungc_candidate(b.read_ungc([urow("X", f=code)])[0]) is None
    assert b.ungc_candidate(b.read_ungc([urow("X", dist="")])[0]) is None
    row = dict.fromkeys(("Vcmb", "DM", "e_DM"), "")
    row.update({c: "" for c in ("DMsnIa", "e_DMsnIa", "DMtf", "e_DMtf", "DMfp", "e_DMfp", "DMsbf", "e_DMsbf", "DMsnII",
                                "e_DMsnII", "DMtrgb", "e_DMtrgb", "DMceph", "e_DMceph", "DMmas", "e_DMmas")})
    row.update(PGC="1", Vcmb="1000", DM="30", e_DM="1")
    for col, method in b.CF4_COLUMNS:
        r = dict(row, **{col: "30.0", "e_" + col: "0.1"})
        out = b.cf4_candidates(r)
        assert [c["method"] for c in out] == [method]       # the combined DM is never a candidate
        assert out[0]["q"]["tier"] == ("measured" if method in ("maser", "cepheid", "trgb", "sbf") else "inferred")
        assert out[0]["q"]["src"].startswith("Cosmicflows-4") and "converted" in out[0]["q"]["src"]


def test_modulus_to_distance_and_the_one_plus_z_step():
    d, lo, hi = b.dist_from_modulus(24.397, 0.066, None)
    assert d == pytest.approx(10 ** ((24.397 + 5) / 5)) and lo < d < hi
    assert lo == pytest.approx(10 ** ((24.397 - 0.066 + 5) / 5))
    z = 6195 / b.C_KMS
    d2, _, _ = b.dist_from_modulus(34.995, 0.41, 6195)
    assert d2 == pytest.approx(10 ** ((34.995 + 5) / 5) / (1 + z))
    assert 1 - d2 / 10 ** ((34.995 + 5) / 5) == pytest.approx(0.02025, abs=1e-4)


# --- Hubble flow ------------------------------------------------------------------------------

def test_cmb_dipole_direction_and_velocity():
    ra, dec = b.APEX
    assert (ra, dec) == pytest.approx((167.94, -6.94), abs=0.01)
    assert b.v_cmb(1000.0, ra, dec) == pytest.approx(1369.82)                       # toward the apex: + 369.82
    assert b.v_cmb(1000.0, (ra + 180) % 360, -dec) == pytest.approx(630.18)         # away from it
    assert b.v_cmb(1000.0, ra + 90, 0.0) == pytest.approx(1000.0 + 369.82 * math.cos(math.radians(
        math.degrees(math.acos(math.cos(math.radians(-dec)) * math.cos(math.radians(90)))))), abs=0.01)


def test_hubble_distance_q0_term_and_interval():
    v = 3527.7
    z = v / b.C_KMS
    assert b.hubble_distance_mpc(v) == pytest.approx(v / 74.6 * (1 - 0.405 * z / 2), rel=1e-12)
    assert b.hubble_distance_mpc(v) < v / 74.6
    q = b.hubble_quantity(3886, v, "OpenNGC RadVel")
    f = 300 / v
    assert q["v"] == pytest.approx(47.18, abs=0.01) and q["lo"] == pytest.approx(q["v"] * (1 - f), abs=0.01)
    assert q["hi"] == pytest.approx(q["v"] * (1 + f), abs=0.01) and q["tier"] == "inferred"      # no H0 term
    assert "H0 = 74.6" in q["src"] and "67.4" in q["src"] and "300 km/s" in q["src"]


def test_ngc12_against_a_hand_computation(committed):
    r = committed["recs"]["ongc:NGC0012"]
    ra, dec, vh = math.radians(r["position"]["ra"]), math.radians(r["position"]["dec"]), 3886.0
    a_ra, a_dec = math.radians(167.94), math.radians(-6.94)
    cos_t = math.sin(dec) * math.sin(a_dec) + math.cos(dec) * math.cos(a_dec) * math.cos(ra - a_ra)
    vc = vh + 369.82 * cos_t
    assert r["props"]["v_cmb"]["v"] == pytest.approx(vc, abs=0.3) and r["props"]["v_helio"]["v"] == vh
    z = vc / 299792.458
    d = vc / 74.6 * (1 - (1 - 0.595) * z / 2)
    p = r["position"]
    assert p["method"] == "redshift" and p["dist"]["tier"] == "inferred" and r["evidence"] == "derived"
    assert p["dist"]["v"] == pytest.approx(d, rel=2e-3)
    assert p["dist"]["lo"] == pytest.approx(d * (1 - 300 / vc), rel=3e-3) and p["dist"]["hi"] == pytest.approx(d * (1 + 300 / vc), rel=3e-3)
    assert "74.6" in p["dist"]["src"] and r["size"]["radius"]["tier"] == "inferred"


def test_direction_only_records_and_the_threshold(committed):
    ic47 = committed["recs"]["ongc:IC0047"]
    assert ic47["position"]["dist"] is None and "method" not in ic47["position"]
    assert ic47["size"]["radius"] is None and ic47["evidence"] == "measured" and "v_helio" not in ic47["props"]
    n_no_v = n_low = 0
    for r in committed["recs"].values():
        if r["kind"] != "galaxy" or r["id"] == objects.MILKY_WAY_ID:
            continue
        p = r["position"]
        v = r["props"].get("v_helio")
        if p["dist"] is None:
            assert "method" not in p and (r["size"] is None or r["size"]["radius"] is None) and r["evidence"] == "measured"
            if v is None:
                n_no_v += 1
            else:
                assert b.v_cmb(v["v"], p["ra"], p["dec"]) < 1000.0           # blueshifted or slow: direction-only
                n_low += 1
        if p.get("method") == "redshift":
            assert r["props"]["v_cmb"]["v"] >= 1000.0
    rep = committed["report"]["direction_only"]
    assert rep["total"] == rep["no_velocity"] + rep["below_1000_km_s"] > 0
    assert (n_no_v, n_low) == (rep["no_velocity"], rep["below_1000_km_s"])
    assert committed["report"]["hubble_flow"] == committed["report"]["distances"]["by_method"]["redshift"]


# --- clusters ---------------------------------------------------------------------------------

CLUSTER_TIERS = {"Virgo cluster": "catalogue", "Fornax cluster": "catalogue", "Coma cluster": "catalogue",
                 "Perseus cluster": "catalogue", "Centaurus cluster": "inferred", "Abell 1367": "inferred",
                 "Hercules cluster": "inferred", "Hydra cluster": "inferred"}


def test_cluster_members_take_the_cf4_group_distance(committed, inputs):
    rep = committed["report"]["clusters"]
    assert set(rep) == set(CLUSTER_TIERS)
    assert all(v["members"] == len(v["ids"]) > 0 for v in rep.values())
    groups = {int(r["1PGC"]): r for r in inputs["cf4-groups"]}
    cl = json.loads((b.SOURCES / b.CLUSTERS_FILE).read_text())["clusters"]
    for c in cl:
        g = groups[c["cf4_group"]]
        want = b.dist_from_modulus(float(g["DMzp"]), float(g["e_DMzp"]), float(g["V3k"]))[0] * 1e-6
        info = rep[c["name"]]
        assert info["distance_mpc"] == pytest.approx(want, rel=1e-4)
        for rid in info["ids"]:
            r = committed["recs"][rid]
            p = r["position"]
            assert p["method"] == "group-member" and p["dist"]["tier"] == "inferred" and r["evidence"] == "derived"
            assert p["dist"]["v"] == info["distance_mpc"] and "alt_distances" not in r
            first = c["name"].replace(" cluster", "")
            assert f"{first} cluster" in p["dist"]["src"] and f"group {c['cf4_group']}" in p["dist"]["src"]
            assert p["dist"]["hi"] - p["dist"]["v"] >= c["radius_mpc"]["v"] - 0.01              # widened by the cluster radius
            assert abs(r["props"]["v_helio"]["v"] - float(g["Vh"])) <= 3 * c["sigma"]["v"]
    virgo = committed["recs"][rep["Virgo cluster"]["ids"][0]]
    assert virgo["position"]["dist"]["v"] == pytest.approx(16.2, abs=0.1)
    assert committed["recs"]["ongc:NGC4486"]["position"]["method"] == "sbf"      # M87 keeps its own distance


def test_a_galaxy_with_its_own_distance_is_never_a_member(committed):
    members = {i for v in committed["report"]["clusters"].values() for i in v["ids"]}
    for rid in members:
        assert "own" not in committed["recs"][rid]["position"]["dist"]["src"]
    for rid, r in committed["recs"].items():
        if r["position"].get("dist") and r["position"]["method"] != "group-member":
            assert rid not in members
    # UNGC's own group membership (`mem`) is also `group-member`, with its own src; so are Phase 4's CF4 group distances
    others = [r for r in committed["recs"].values() if r["position"].get("method") == "group-member" and r["id"] not in members]
    ungc = [r for r in others if "UNGC" in r["position"]["dist"]["src"]]
    cf4 = [r for r in others if r["position"]["dist"]["src"].startswith("Placed at the distance of")]
    assert ungc and cf4 and len(ungc) + len(cf4) == len(others)


# --- curated Magellanic Clouds ----------------------------------------------------------------

def test_lmc_and_smc_use_the_curated_distances(committed):
    lmc, smc = committed["recs"]["ongc:ESO056-115"], committed["recs"]["ongc:NGC0292"]
    for r, kpc, who in ((lmc, 49.59, "Pietrzy"), (smc, 62.44, "Graczyk")):
        d = r["position"]["dist"]
        assert r["position"]["method"] == "eclipsing-binary" and d["unit"] == "pc" and d["tier"] == "measured"
        assert d["v"] == pytest.approx(kpc * 1000, abs=100) and who in d["src"] and r["evidence"] == "measured"
        assert d["lo"] < d["v"] < d["hi"]
        assert r["alt_distances"] and all("curated" in a["reason"] for a in r["alt_distances"])
    assert lmc["position"]["dist"]["hi"] - 49590 == pytest.approx(math.hypot(0.09, 0.54) * 1000, abs=1)
    assert not [r for r in committed["recs"].values() if r["position"].get("method") == "eclipsing-binary"][2:]


# --- the Milky Way ----------------------------------------------------------------------------

def test_milky_way_copies_sgr_a_star_from_the_built_bh_tile(committed):
    ds = st.load_dataset(BH_COMMITTED)
    sgr = next(r for t in ds.manifest["tiles"] for r in st._read_tile(ds, t) if r["id"] == "bh:Sgr A*")
    mw = committed["recs"]["gal:milky_way"]
    for k in ("model", "ra", "dec", "epoch", "method", "dist"):
        assert mw["position"][k] == sgr["position"][k], k
    assert mw["position"]["dist"]["v"] == 8277 and mw["position"]["dist"]["src"] == sgr["position"]["dist"]["src"]
    assert mw["evidence"] == "measured" and mw["render"] == {"style": "milky_way"} and mw["size"] == {"radius": None, "angular": None}
    for k in ("ngp_ra", "ngp_dec", "l_node", "thin_disc_scale_length", "thin_disc_scale_height", "thick_disc_scale_length",
              "thick_disc_scale_height", "bar_half_length", "bar_angle", "stellar_mass", "sun_height"):
        assert mw["props"][k]["src"] and mw["props"][k]["tier"] in ("catalogue", "measured")


def test_milky_way_refused_without_src_or_with_a_missing_centre():
    cur = json.loads((b.SOURCES / b.MW_FILE).read_text())
    bh = json.loads(b.BH_FILE.read_text())
    b.milky_way_record(cur, bh, b.provenance())
    bad = copy.deepcopy(cur)
    del bad["props"]["bar_angle"]["src"]
    with pytest.raises(b.CuratedError, match="bar_angle"):
        b.milky_way_record(bad, bh, b.provenance())
    bad = copy.deepcopy(cur)
    del bad["props"]["bar_angle"]["where"]
    with pytest.raises(b.CuratedError, match="where"):
        b.milky_way_record(bad, bh, b.provenance())
    bad = copy.deepcopy(cur)
    bad["centre_from"] = "bh:Nowhere"
    with pytest.raises(b.CuratedError, match="centre_from"):
        b.milky_way_record(bad, bh, b.provenance())


def test_clusters_and_local_group_files_are_checked():
    cl = json.loads((b.SOURCES / b.CLUSTERS_FILE).read_text())
    b.check_curated(cl, "clusters.json")
    del cl["clusters"][0]["sigma"]["where"]
    with pytest.raises(b.CuratedError):
        b.check_curated(cl, "clusters.json")


# --- the context set --------------------------------------------------------------------------

def test_context_set_rules_and_members(committed):
    ds, recs = committed["ds"], committed["recs"]
    sky = {r["id"] for r in st._read_tile(ds, "sky")}
    assert ds.manifest["sky_tiles"] == ["sky"] and committed["report"]["context_set"]["count"] == len(sky)
    assert 100 <= len(sky) <= 250
    hosts = {x["host_galaxy"] for x in json.loads(b.SMBH_FILE.read_text())["black_holes"]}
    assert len(hosts) == 8 and hosts <= sky and objects.MILKY_WAY_ID in sky
    want = set()
    for rid, r in recs.items():
        d = r["position"].get("dist")
        mb = r["props"].get("mag_b")
        if (d and rec_dist_pc(r) <= 3e6) or (mb and mb["v"] < 10) or rid in hosts or rid == objects.MILKY_WAY_ID:
            want.add(rid)
    assert sky == want
    for rid in ("ongc:NGC0224", "ongc:NGC0221", "ongc:NGC0205", "ongc:ESO056-115", "ongc:NGC0292", "ongc:NGC3031"):
        assert rid in sky
    assert "ongc:NGC0012" not in sky
    # a sky record is in no cone tile
    in_cone_tiles = {r["id"] for t in ds.manifest["tiles"] if t != "sky" for r in st._read_tile(ds, t)}
    assert not sky & in_cone_tiles
    far = st.cone_query(ds, 200.0, -60.0, 0.5)
    assert sky <= {r["id"] for r in far} and any(r["id"] == "gal:milky_way" for r in far)


# --- names, designations, records -------------------------------------------------------------

def test_names_and_designations(committed):
    recs = committed["recs"]
    assert recs["ongc:NGC4486"]["name"] == "Messier 87" and recs["ongc:NGC0221"]["name"] == "M32"
    assert recs["ongc:IC0047"]["name"] == "IC 47"
    assert recs["ungc:And XVIII"]["name"] == "And XVIII"
    assert max(len(r["designations"]) for r in recs.values()) <= b.MAX_DESIGNATIONS
    assert all(r["name"] not in r["designations"] for r in recs.values())
    assert recs["ongc:NGC0224"]["designations"] == ["M 31", "NGC 224", "UGC 454", "PGC 2557", "MESSIER031"]
    g = gals(orow("NGC0100", M="005", NGC="0200", Identifiers="UGC 00007,PGC 000009,ESO 100-200,ESO-LV 1", **{"Common names": "Foo,Bar"}),
             orow("NGC0200", "G"))[0]
    assert b.designations_for(g, None, "Foo") == ["M 5", "NGC 100", "NGC 200", "UGC 7", "PGC 9", "ESO 100-200", "Bar"]


def test_every_record_validates_and_the_rules_hold(committed):
    problems = st.verify_dataset(COMMITTED)
    assert problems == []
    for r in committed["recs"].values():
        assert r["kind"] == "galaxy" and r["host"] is None and r["parent"] is None
        d = r["position"].get("dist")
        if d is None:
            continue
        m = r["position"]["method"]
        if r["id"] == objects.MILKY_WAY_ID:
            continue
        assert (d["tier"] == "measured") == (m in b.MEASURED) and (r["evidence"] == "measured") == (d["tier"] == "measured")
        assert len(r.get("alt_distances", [])) <= 4 and r["position"]["ra"] < 360
        if r["id"] != objects.MILKY_WAY_ID and r["size"] and r["size"]["radius"]:
            assert r["size"]["radius"]["src"] == "half the catalogue major axis at the adopted distance"
    errorless = [r for r in committed["recs"].values()
                 if r["position"].get("dist") and "UNGC" in r["position"]["dist"]["src"]
                 and r["position"]["method"] not in ("group-member",) and "lo" not in r["position"]["dist"]]
    assert errorless and all("0.01 Mpc" in r["position"]["dist"]["src"] for r in errorless)


@pytest.mark.parametrize("rid,fixture", [("ongc:NGC0224", "galaxy_m31"), ("ongc:NGC4486", "galaxy_m87"),
                                         ("ongc:NGC0012", "galaxy_ngc12"), ("ongc:IC0047", "galaxy_ic47"),
                                         ("ungc:And XVIII", "galaxy_and_xviii"), ("gal:milky_way", "galaxy_milky_way"),
                                         ("ongc:ESO056-115", "galaxy_lmc")])
def test_the_18_13_examples_equal_the_built_records(committed, rid, fixture):
    example = json.loads((EXAMPLES / f"{fixture}.json").read_text(encoding="utf-8"))
    assert example == committed["recs"][rid]
    assert objects.validate_record(example) == []


def test_the_examples_match_the_documented_numbers():
    load = lambda n: json.loads((EXAMPLES / f"{n}.json").read_text(encoding="utf-8"))  # noqa: E731
    m31 = load("galaxy_m31")
    assert (m31["position"]["ra"], m31["position"]["dec"]) == (10.6847917, 41.2690556)
    assert m31["position"]["dist"]["v"] == pytest.approx(0.75753, abs=2e-3)                  # 18.13: 0.75753 (build differs in the last digits)
    assert m31["size"]["angular"]["major"]["v"] == 177.83 and m31["props"]["mag_b"]["v"] == 4.29
    assert m31["props"]["surface_brightness"]["unit"] == "mag/arcsec2" and m31["props"]["v_helio"]["v"] == -300
    assert m31["provenance"]["version"] == "OpenNGC v20260501 (36cb178a)"
    m87 = load("galaxy_m87")
    assert (m87["position"]["ra"], m87["position"]["dec"]) == (187.7059167, 12.3911111)
    assert m87["position"]["dist"]["v"] == pytest.approx(16.858, abs=0.15) and m87["position"]["method"] == "sbf"
    ic = load("galaxy_ic47")
    assert (ic["position"]["ra"], ic["position"]["dec"]) == (10.7292083, -13.7407222) and ic["position"]["dist"] is None
    ax = load("galaxy_and_xviii")
    assert (ax["position"]["ra"], ax["position"]["dec"]) == (0.5604167, 45.0888889)
    assert ax["size"]["angular"]["major"]["v"] == 1.4 and ax["size"]["angular"]["minor"]["v"] == 1.39
    assert ax["size"]["angular"]["pa"] is None
    mw = load("galaxy_milky_way")
    assert mw["position"]["dist"]["v"] == 8277 and mw["designations"] == ["Galaxy", "Milky Way (UNGC)"]


# --- licence, manifest, report ----------------------------------------------------------------

def test_license_files_exist_in_both_folders_and_say_what_18_2_requires():
    for folder, which in ((b.SOURCES, "sources"), (COMMITTED, "dataset")):
        text = (folder / "LICENSE.md").read_text(encoding="utf-8")
        assert text == b.license_text(which)
        for needle in ("CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/",
                       "Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC", "NASA/IPAC Extragalactic Database",
                       "Cosmicflows-4", "EDD", "Tully", "Karachentsev", "McConnachie", "Nothing here is relicensed",
                       "not EDD data", "research and education", "MIT", "every file in"):
            assert needle in text, (which, needle)
    assert "OpenNGC `NGC.csv`" in (b.SOURCES / "LICENSE.md").read_text()
    assert "tiles/*.json" in (COMMITTED / "LICENSE.md").read_text()


def test_the_manifest_provenance_carries_the_credit_licence_and_citations(committed):
    m = committed["manifest"]
    p = m["provenance"]
    assert p["credit"] == ("Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC; "
                           "distances: Cosmicflows-4 (Tully et al. 2023), Extragalactic Distance Database")
    assert p["licence_name"] == "CC BY-SA 4.0 (OpenNGC data); Cosmicflows-4 distances under EDD terms"
    assert p["licence"] == "https://creativecommons.org/licenses/by-sa/4.0/"
    for needle in ("Karachentsev", "Tully", "Extragalactic Distance Database", "McConnachie", "Cosmicflows-4"):
        assert needle in p["citation"]
    assert "EDD" in p["data_licence_note"] and {i["role"] for i in p["inputs"]} == set(b.INPUTS)
    assert m["dataset"] == "galaxies" and m["kinds"] == ["galaxy"] and m["sky_tiles"] == ["sky"]
    assert m["record_defaults"]["provenance"]["dataset"] == "galaxies"
    assert m["build"]["script"] == "backend/scripts/build_objects_galaxies.py"


def test_source_json_lists_every_input_with_its_pin():
    meta = json.loads((b.SOURCES / "SOURCE.json").read_text())
    files = {f["role"]: f for f in meta["files"] if f.get("kind") != "committed"}
    assert set(files) == set(b.INPUTS)
    for role, f in files.items():
        data = gzip.decompress((b.SOURCES / f["file"]).read_bytes())
        assert b.neb.sha256(data) == f["sha256"] == b.INPUTS[role]["sha256"] and f["rows"] == b.INPUTS[role]["rows"]
        assert f["retrieved"] and f["mirror"]
        if role in b.VIZIER_ROLES:
            assert f["mirror"] in b.VIZIER_MIRRORS and not any(l.startswith(b"#") for l in data.splitlines())
    assert files["openngc"]["sha256"] == b.neb.INPUTS["openngc"]["sha256"]
    assert files["openngc-addendum"]["sha256"] == b.neb.INPUTS["openngc-addendum"]["sha256"]
    assert files["cf4-table2"]["columns"][0] == "PGC" and files["cf4-table2"]["columns"][-1] == "1PGC"
    assert len(files["cf4-table2"]["columns"]) == 23
    assert files["cf4-groups"]["columns"] == ["1PGC", "Ngal", "DMzp", "e_DMzp", "Vh", "V3k", "RAJ2000", "DEJ2000"]


def test_vizier_urls_and_mirror_order():
    assert b.VIZIER_MIRRORS == ("vizier.cfa.harvard.edu", "vizier.idia.ac.za", "vizier.cds.unistra.fr")
    u = b.vizier_url("vizier.cfa.harvard.edu", "J/AJ/145/101/catalog")
    assert "-out.all" in u and "-source=J%2FAJ%2F145%2F101%2Fcatalog" in u
    assert "-out=PGC,Vcmb" in b.vizier_url("m", "J/ApJ/944/94/table2", b.INPUTS["cf4-table2"]["columns"])


def test_report_counts_agree_with_the_records(committed):
    rep, recs = committed["report"], committed["recs"]
    n = len(recs)
    assert rep["records_written"] == n == committed["manifest"]["count"] == 11449
    d = rep["distances"]
    assert sum(d["by_method"].values()) == n and sum(d["by_evidence"].values()) == n
    from collections import Counter
    assert d["by_method"] == dict(sorted(Counter(r["position"].get("method") or "direction-only" for r in recs.values()).items()))
    assert d["by_evidence"] == dict(sorted(Counter(r["evidence"] for r in recs.values()).items()))
    assert d["by_method"]["direction-only"] == rep["direction_only"]["total"]
    assert d["by_method"]["redshift"] == rep["hubble_flow"]
    assert rep["cluster_members_total"] == sum(v["members"] for v in rep["clusters"].values())
    assert rep["rows_read"] == 14033 and rep["kept_by_type"] == {"G": 10521, "GGroup": 13, "GPair": 231, "GTrpl": 26}
    assert rep["dup_designations_folded"] == 604 and sum(rep["kept_by_type"].values()) == 10791
    assert rep["ungc_rows"] == 869 and rep["context_set"]["count"] == len(rep["context_set"]["members"])
    assert set(rep["curated_sha256"]) >= {b.MW_FILE, b.CLUSTERS_FILE, b.LG_FILE, b.NAMES_FILE, b.OVERRIDES_FILE}


def test_size_budget_and_the_reported_bytes(committed):
    rep = committed["report"]
    tiles = {p.name: p.stat().st_size for p in (COMMITTED / "tiles").glob("*.json")}
    assert rep["tile_bytes"] == tiles and rep["tiles_bytes_total"] == sum(tiles.values())
    total = sum(tiles.values()) + (COMMITTED / "manifest.json").stat().st_size
    assert b.BUDGET_BYTES == 8_000_000 and total <= b.BUDGET_BYTES          # Phase 4: 13 MB -> 8 MB
    assert rep["snapshot_bytes_total"] == sum(p.stat().st_size for p in b.SOURCES.glob("*.gz"))
    assert max(tiles.values()) < 600_000


# --- reproducibility and --check ---------------------------------------------------------------

def _tree(d: Path) -> dict:
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


def test_the_committed_dataset_is_a_byte_identical_rebuild_and_verifies(tmp_path):
    b.build(tmp_path / "again")
    assert _tree(tmp_path / "again") == _tree(COMMITTED)
    assert st.verify_dataset(COMMITTED) == []


def test_check_passes_then_fails_on_changes(tmp_path, monkeypatch):
    shutil.copytree(COMMITTED, tmp_path / "out")
    monkeypatch.setattr(sys, "argv", ["x", "--check", "--out", str(tmp_path / "out")])
    assert b.main() == 0
    (tmp_path / "out" / "LICENSE.md").write_text("changed")
    assert b.main() == 1
    shutil.copy(COMMITTED / "LICENSE.md", tmp_path / "out" / "LICENSE.md")
    next((tmp_path / "out" / "tiles").glob("1*.json")).write_text("{}")
    assert b.main() == 1


def test_a_changed_snapshot_or_pin_is_refused(tmp_path):
    src = tmp_path / "src"
    shutil.copytree(b.SOURCES, src)
    f = src / "ungc-catalog.tsv.gz"
    f.write_bytes(gzip.compress(gzip.decompress(f.read_bytes()).replace(b"UGC12894", b"UGC12895"), mtime=0))
    with pytest.raises(SystemExit, match="sha256"):
        b.build(tmp_path / "o", src)
    with pytest.raises(SystemExit, match="table does not have"):
        b.verify_download("ungc", b"A\tB\n-\t-\n1\t2\n")
    with pytest.raises(SystemExit, match="pin"):
        b.verify_download("ungc", b.canonical("ungc", gzip.decompress((b.SOURCES / "ungc-catalog.tsv.gz").read_bytes()) + b"#x\n").replace(b"UGC12894", b"UGC12895"))


def test_cone_at_m31_finds_m31_m32_and_ngc205_and_the_context_set():
    ds = st.load_dataset(COMMITTED)
    ids = {r["id"]: r for r in st.cone_query(ds, 10.68, 41.27, 1.0)}
    assert {"ongc:NGC0224", "ongc:NGC0221", "ongc:NGC0205", "gal:milky_way"} <= set(ids)
    assert objects.validate_record(ids["ongc:NGC0224"]) == [] and isinstance(ids["gal:milky_way"], objects.SkyRecord)


# --- Phase 4: CF4 group distances (docs 19.5), cited cluster radii (19.6), props.group_radius (19.3.4) -----------

SMALL_SRC = re.compile(r"^Placed at the distance of its group \(Cosmicflows-4 group 1PGC (\d+), (\d+) galaxies: DMzp ([\d.]+) ± "
                       r"([\d.]+), converted by Space Maps\), whose average is more precise than its own "
                       r"(Tully–Fisher|fundamental-plane) distance; the interval adds the group radius ([\d.]+) Mpc "
                       r"\(rms projected distance of its Cosmicflows-4 members\) along the line of sight in quadrature$")
RICH_SRC = re.compile(r"^Placed at the distance of the (.+) cluster \(Cosmicflows-4 group (\d+): DMzp ([\d.]+) ± ([\d.]+), "
                      r"converted by Space Maps\), whose average is more precise than its own (Tully–Fisher|fundamental-plane) "
                      r"distance; the interval adds the cluster radius ([\d.]+) Mpc along the line of sight in quadrature$")
RADIUS_SRC = re.compile(r"^rms projected distance of the (\d+) Cosmicflows-4 members from their mean position, at the group "
                        r"distance \(Space Maps\)$")


def grow(gid, ngal, dmzp, e, v3k=5000.0, ra=10.0, dec=20.0):
    return {"1PGC": str(gid), "Ngal": str(ngal), "DMzp": str(dmzp), "e_DMzp": str(e), "Vh": "5000", "V3k": str(v3k),
            "RAJ2000": str(ra), "DEJ2000": str(dec)}


def trow(pgc, gid, ra, dec, vcmb=5000, **dm):
    r = {c: "" for c in b.INPUTS["cf4-table2"]["columns"]}
    r.update(PGC=str(pgc), Vcmb=str(vcmb), RAJ2000=str(ra), DEJ2000=str(dec), **{"1PGC": str(gid)})
    r.update({k: str(v) for k, v in dm.items()})
    return r


def test_the_1pgc_column_joins_table2_to_the_groups(inputs):
    t2, groups = inputs["cf4-table2"], inputs["cf4-groups"]
    assert (len(t2), len(groups)) == (55877, 38053)
    assert "1PGC" in t2[0] and "RAJ2000" in groups[0] and "DEJ2000" in groups[0]
    from collections import Counter
    members = Counter(r["1PGC"] for r in t2)
    gmap = {r["1PGC"]: r for r in groups}
    assert all(int(gmap[k]["Ngal"]) == n for k, n in members.items() if k in gmap)       # Ngal is the member count of table2
    assert sum(1 for k in members if k not in gmap) == 12              # 12 table2 rows name a 1PGC the groups table lacks
    assert members["41220"] == int(gmap["41220"]["Ngal"]) and int(gmap["41220"]["Ngal"]) > 100


def test_group_radius_is_the_rms_about_the_members_mean_position():
    d_pc = 30e6
    sep_deg = 0.2
    c = math.cos(math.radians(20.0))
    pair = [(10.0 - sep_deg / 2 / c, 20.0), (10.0 + sep_deg / 2 / c, 20.0)]
    mean = b.members_mean(pair)
    assert mean == pytest.approx((10.0, 20.0), abs=1e-3)
    # a pair: half the separation, by construction
    half = math.radians(sep_deg) / 2 * 30.0
    assert b.rms_radius_mpc(pair, mean, d_pc) == pytest.approx(half, rel=1e-3)
    assert b.rms_radius_mpc(pair, mean, 2 * d_pc) == pytest.approx(2 * half, rel=1e-3)
    assert b.rms_radius_mpc([(10.0, 20.0)], b.members_mean([(10.0, 20.0)]), d_pc) == pytest.approx(0.0, abs=1e-6)
    # across RA 0/360 the mean is on the seam
    wrap = [(359.9, 0.0), (0.1, 0.0)]
    m = b.members_mean(wrap)
    assert min(m[0], 360 - m[0]) < 1e-6 and abs(m[1]) < 1e-9
    assert b.rms_radius_mpc(wrap, m, d_pc) == pytest.approx(math.radians(0.1) * 30.0, rel=1e-4)
    # the groups table's own position plays no part: a wrong one changes nothing
    grp = grow(7, 2, 34.0, 0.05, ra=349.78, dec=18.13)
    rows = [trow(1, 7, *pair[0]), trow(2, 7, *pair[1])]
    gc = b.group_candidate(grp, rows, "tully-fisher")
    d0 = b.group_distance(grp)[0]
    assert gc["radius_mpc"] == pytest.approx(math.radians(sep_deg) / 2 * d0 * 1e-6, rel=1e-3)


def test_the_candidate_is_only_for_tf_and_fp_only_galaxies():
    row = lambda **dm: b.cf4_candidates(trow(1, 1, 10.0, 20.0, **dm))     # noqa: E731
    assert b.group_eligible(row(DMtf=34.0, e_DMtf=0.4)) == "tully-fisher"
    assert b.group_eligible(row(DMtf=34.0, e_DMtf=0.4, DMfp=34.1, e_DMfp=0.2)) == "fundamental-plane"
    for extra in ({"DMsnIa": 34.0, "e_DMsnIa": 0.1}, {"DMsnII": 34.0, "e_DMsnII": 0.2}, {"DMtrgb": 34.0, "e_DMtrgb": 0.1},
                  {"DMsbf": 34.0, "e_DMsbf": 0.1}, {"DMceph": 34.0, "e_DMceph": 0.1}, {"DMmas": 34.0, "e_DMmas": 0.1}):
        assert b.group_eligible(row(DMtf=34.0, e_DMtf=0.4, **extra)) is None, extra
    ungc = b.ungc_candidate(b.read_ungc([urow("X", dist="20.0", f="TF")])[0])
    mcc = b.mcc_candidate({"Name": "X", "(m-M)": "24.0", "E_(m-M)": "0.1", "e_(m-M)": "0.1"})
    assert b.group_eligible(row(DMtf=34.0, e_DMtf=0.4) + [ungc]) is None
    assert b.group_eligible(row(DMtf=34.0, e_DMtf=0.4) + [mcc]) is None
    assert b.group_eligible([]) is None


def _synthetic_group(e_dmzp, own_e, ngal=3, spread_deg=0.05, gid=7):
    grp = grow(gid, ngal, 34.0, e_dmzp)
    members = [trow(100 + i, gid, 10.0 + (i - 1) * spread_deg, 20.0, DMtf=34.5, e_DMtf=own_e) for i in range(ngal)]
    cands = b.cf4_candidates(members[0])
    return grp, members, cands, b.group_candidate(grp, members, b.group_eligible(cands))


def frac_small(e):
    return b.frac_of_sigma_mu(e)


def test_the_group_wins_on_fractional_uncertainty_and_the_own_distance_is_listed_as_not_used():
    grp, members, cands, gc = _synthetic_group(e_dmzp=0.05, own_e=0.4)
    assert gc["frac"] < cands[0]["frac"]
    best, alts = b.choose_with_group(cands, gc)
    assert best is gc and best["q"]["tier"] == "inferred" and best["method"] == "group-member"
    assert [a["method"] for a in alts] == ["tully-fisher"] and alts[0]["reason"] == "not used: larger uncertainty than its group's distance"
    m = SMALL_SRC.match(best["q"]["src"])
    assert m and m.group(1) == "7" and m.group(2) == "3" and m.group(5) == "Tully–Fisher"
    # D from DMzp with the 1/(1+z) step of V3k, interval widened by the radius in quadrature
    d = 10 ** ((34.0 + 5) / 5) / (1 + 5000.0 / b.C_KMS) * 1e-6
    assert best["q"]["v"] == pytest.approx(d, rel=1e-4)
    err = math.hypot(d * (10 ** (0.05 / 5) - 1), gc["radius_mpc"])
    assert best["q"]["hi"] - best["q"]["v"] == pytest.approx(err, rel=2e-3)
    assert gc["radius"]["tier"] == "inferred" and gc["radius"]["unit"] == "Mpc" and RADIUS_SRC.match(gc["radius"]["src"]).group(1) == "3"
    # the other way: a large group modulus error, or a wide group, and the galaxy keeps its own distance
    grp, members, cands, gc = _synthetic_group(e_dmzp=0.6, own_e=0.05)
    best, alts = b.choose_with_group(cands, gc)
    assert best is cands[0] and alts == [] and gc["frac"] > cands[0]["frac"]
    grp, members, cands, gc = _synthetic_group(e_dmzp=0.05, own_e=0.1, spread_deg=8.0)        # a wide group: the radius dominates
    assert gc["radius_mpc"] * 1e6 / gc["pc"] > cands[0]["frac"] > frac_small(0.05)
    assert b.choose_with_group(cands, gc)[0] is cands[0]
    # fundamental-plane wording, and no candidate means no change
    fp = b.cf4_candidates(trow(1, 7, 10.0, 20.0, DMfp=34.5, e_DMfp=0.4))
    g2 = b.group_candidate(grow(7, 2, 34.0, 0.05), [trow(1, 7, 10, 20), trow(2, 7, 10.1, 20)], "fundamental-plane")
    assert SMALL_SRC.match(g2["q"]["src"]).group(5) == "fundamental-plane"
    assert b.choose_with_group(fp, None) == b.choose(fp)


def test_a_rich_cluster_group_uses_the_cited_radius_and_its_wording():
    cl = json.loads((b.SOURCES / b.CLUSTERS_FILE).read_text(encoding="utf-8"))
    virgo = next(c for c in cl["clusters"] if c["name"] == "Virgo cluster")
    grp = grow(41220, 1000, 31.048, 0.008, v3k=1300.0)
    members = [trow(1, 41220, 187.7, 12.4)]
    gc = b.group_candidate(grp, members, "tully-fisher", virgo, cl["papers"])
    assert gc["radius"] == {"v": 1.7, "unit": "Mpc", "tier": "catalogue", "src": gc["radius"]["src"]}
    assert "Kashibadze" in gc["radius"]["src"] and "Sect. 1" in gc["radius"]["src"]
    assert gc["q"]["src"] == ("Placed at the distance of the Virgo cluster (Cosmicflows-4 group 41220: DMzp 31.048 ± 0.008, "
                              "converted by Space Maps), whose average is more precise than its own Tully–Fisher distance; "
                              "the interval adds the cluster radius 1.7 Mpc along the line of sight in quadrature")
    hydra = next(c for c in cl["clusters"] if c["name"] == "Hydra cluster")
    gh = b.group_candidate(grow(31478, 67, 33.673, 0.046, v3k=3900.0), members, "fundamental-plane", hydra, cl["papers"])
    assert gh["radius"]["tier"] == "inferred" and gh["radius"]["v"] == 1.307 and "h50" in gh["radius"]["src"]
    assert RICH_SRC.match(gh["q"]["src"]).group(1) == "Hydra" and "fundamental-plane distance" in gh["q"]["src"]


def test_cluster_membership_rule_on_synthetic_rows_for_the_four_new_clusters():
    cl = json.loads((b.SOURCES / b.CLUSTERS_FILE).read_text(encoding="utf-8"))
    new = [c for c in cl["clusters"] if c["name"] in ("Centaurus cluster", "Abell 1367", "Hercules cluster", "Hydra cluster")]
    assert [c["cf4_group"] for c in new] == [43296, 36487, 56962, 31478]
    assert [c["sigma"]["v"] for c in new] == [447, 798, 751, 610]
    assert [c["radius_deg"]["v"] for c in new] == [1.766, 0.983, 0.444, 1.667]
    assert [c["radius_mpc"]["v"] for c in new] == [1.253, 1.434, 1.079, 1.307] and all(c["radius_mpc"]["tier"] == "inferred" for c in new)
    groups = {int(r["1PGC"]): r for r in b.parse_role("cf4-groups", gzip.decompress((b.SOURCES / "cf4-groups.tsv.gz").read_bytes()))}
    for c in new:
        ci = {"c": c, "centre": {"ra": 100.0, "dec": 0.0}, "vh": float(groups[c["cf4_group"]]["Vh"])}
        r, s3 = c["radius_deg"]["v"], 3 * c["sigma"]["v"]
        assert b.cluster_member(ci, 100.0 + 0.99 * r, 0.0, ci["vh"] + 0.99 * s3)
        assert not b.cluster_member(ci, 100.0 + 1.01 * r, 0.0, ci["vh"])             # outside the radius
        assert not b.cluster_member(ci, 100.0, 0.0, ci["vh"] + 1.01 * s3)            # outside 3 sigma
        assert not b.cluster_member(ci, 100.0, 0.0, ci["vh"] - 1.01 * s3)


def test_the_four_new_clusters_on_the_snapshot(committed):
    rep, recs = committed["report"]["clusters"], committed["recs"]
    assert {k: rep[k]["members"] for k in ("Centaurus cluster", "Abell 1367", "Hercules cluster", "Hydra cluster")} == \
        {"Centaurus cluster": 10, "Abell 1367": 10, "Hercules cluster": 6, "Hydra cluster": 5}
    assert {k: rep[k]["members"] for k in ("Virgo cluster", "Fornax cluster", "Coma cluster", "Perseus cluster")} == \
        {"Virgo cluster": 119, "Fornax cluster": 3, "Coma cluster": 35, "Perseus cluster": 21}
    cl = {c["name"]: c for c in json.loads((b.SOURCES / b.CLUSTERS_FILE).read_text(encoding="utf-8"))["clusters"]}
    groups = {int(r["1PGC"]): r for r in b.parse_role("cf4-groups", gzip.decompress((b.SOURCES / "cf4-groups.tsv.gz").read_bytes()))}
    placed = set()
    for name, info in rep.items():
        c = cl[name]
        ra0, dec0 = recs[c["centre"]]["position"]["ra"], recs[c["centre"]]["position"]["dec"]
        vh = float(groups[c["cf4_group"]]["Vh"])
        assert info["group_radius_mpc"] == c["radius_mpc"]["v"] and info["group_radius_tier"] == CLUSTER_TIERS[name]
        for rid in info["ids"]:
            r = recs[rid]
            gr = r["props"]["group_radius"]
            assert (gr["v"], gr["unit"], gr["tier"]) == (c["radius_mpc"]["v"], "Mpc", CLUSTER_TIERS[name])
            assert gr["src"].startswith(f"{name} ") and "Space Maps" in gr["src"] if gr["tier"] == "inferred" else "as printed" in gr["src"]
            sep = b.angsep_arcmin(ra0, dec0, __import__("numpy").array([r["position"]["ra"]]), __import__("numpy").array([r["position"]["dec"]]))[0] / 60
            assert sep <= c["radius_deg"]["v"] and abs(r["props"]["v_helio"]["v"] - vh) <= 3 * c["sigma"]["v"]
            assert r["position"]["dist"]["src"].startswith(f"Placed at the distance of the {name.replace(' cluster', '')} cluster")
            placed.add(rid)
    # nobody who satisfies the rule was left on the Hubble flow
    import numpy as np
    for r in committed["recs"].values():
        if r["position"].get("method") != "redshift":
            continue
        for name, c in cl.items():
            ra0, dec0 = recs[c["centre"]]["position"]["ra"], recs[c["centre"]]["position"]["dec"]
            sep = b.angsep_arcmin(ra0, dec0, np.array([r["position"]["ra"]]), np.array([r["position"]["dec"]]))[0] / 60
            assert not (sep <= c["radius_deg"]["v"] and abs(r["props"]["v_helio"]["v"] - float(groups[c["cf4_group"]]["Vh"])) <= 3 * c["sigma"]["v"]), (r["id"], name)


def test_group_distances_on_the_snapshot(committed, inputs):
    recs, rep = committed["recs"], committed["report"]
    g = rep["group_distances"]
    moved = [r for r in recs.values() if SMALL_SRC.match((r["position"].get("dist") or {}).get("src", "")) or RICH_SRC.match((r["position"].get("dist") or {}).get("src", ""))]
    assert g["moved"] == len(moved) == sum(g["moved_by_size"].values())
    assert g["tf_fp_only_galaxies"] == g["moved"] + g["kept_own_distance"]
    assert g["kept_own_distance"] == g["kept_own_alone_or_no_group"] + g["kept_own_group_lost"]
    assert all(g["eligible_by_size"][k] == g["moved_by_size"][k] + g["kept_own_by_size"][k] for k in g["eligible_by_size"])
    assert g["moved_by_size"] == {"pairs (2)": 405, "3-4": 366, "5-9": 301, "10+": 384, "rich clusters": 196}
    assert (g["moved"], g["kept_own_distance"], g["kept_own_alone_or_no_group"], g["kept_own_group_lost"]) == (1652, 1469, 1469, 0)
    assert g["over_20_percent"] == 416 and g["over_50_percent"] == 37 == len(g["moves_over_50_percent"])
    assert g["median_abs_change"] == pytest.approx(0.1174, abs=1e-4) and abs(g["median_rel_change"]) < 0.01
    up = g["upstream_group_positions"]
    assert up["more_than_1_deg_from_members_mean"] >= up["more_than_10_deg"] > 100 and len(up["examples"]) == 5
    assert up["more_than_1_deg_from_members_mean"] == 195 and up["more_than_10_deg"] == 156
    t2 = {r["PGC"]: r for r in inputs["cf4-table2"]}
    groups = {r["1PGC"]: r for r in inputs["cf4-groups"]}
    rich = {c["cf4_group"] for c in json.loads((b.SOURCES / b.CLUSTERS_FILE).read_text(encoding="utf-8"))["clusters"]}
    for r in moved:
        p = r["position"]
        assert p["method"] == "group-member" and p["dist"]["tier"] == "inferred" and r["evidence"] == "derived"
        alts = r["alt_distances"]
        assert alts and {a["method"] for a in alts} <= {"tully-fisher", "fundamental-plane"}
        assert all(a["reason"] == "not used: larger uncertainty than its group's distance" for a in alts)
        assert alts[0]["dist"]["src"].startswith("Cosmicflows-4") and "group" not in alts[0]["dist"]["src"].split(":")[0]
        gr = r["props"]["group_radius"]
        assert gr["unit"] == "Mpc"
        m = SMALL_SRC.match(p["dist"]["src"])
        if m:
            gid = m.group(1)
            assert int(gid) not in rich and gr["tier"] == "inferred" and RADIUS_SRC.match(gr["src"]).group(1) == m.group(2)
            assert gr["v"] == pytest.approx(float(m.group(6)), rel=0.06, abs=0.006)
            assert groups[gid]["Ngal"] == m.group(2) and groups[gid]["DMzp"] == m.group(3) and groups[gid]["e_DMzp"] == m.group(4)
        else:
            m = RICH_SRC.match(p["dist"]["src"])
            assert int(m.group(2)) in rich and gr["tier"] == CLUSTER_TIERS[next(k for k in CLUSTER_TIERS if k.startswith(m.group(1)))]
            assert gr["v"] == float(m.group(6))
    # the group's own CF4 candidate is the TF/FP one: recompute a sample of radii from the inputs
    import numpy as np
    from collections import defaultdict
    by = defaultdict(list)
    for r in inputs["cf4-table2"]:
        by[r["1PGC"]].append(r)
    checked = 0
    for r in moved:
        m = SMALL_SRC.match(r["position"]["dist"]["src"])
        if not m or checked >= 40:
            continue
        grp = groups[m.group(1)]
        pts = np.array([(float(x["RAJ2000"]), float(x["DEJ2000"])) for x in by[m.group(1)]])
        pos = (float(grp["RAJ2000"]), float(grp["DEJ2000"]))
        pos = b.members_mean([tuple(x) for x in pts])
        theta = np.radians(b.angsep_arcmin(pos[0], pos[1], pts[:, 0], pts[:, 1]) / 60)
        want = math.sqrt(float((theta ** 2).mean())) * r["position"]["dist"]["v"] * (1 + 0.0)   # at the adopted D (Mpc)
        assert r["props"]["group_radius"]["v"] == pytest.approx(want, rel=1e-3, abs=1e-4), r["id"]
        checked += 1
    assert checked == 40


def test_measured_sn_and_other_distances_are_untouched_by_the_group_rule(committed):
    recs = committed["recs"]
    group_src = ("Placed at the distance of its group", "Placed at the distance of the ")
    for r in recs.values():
        p = r["position"]
        if p.get("method") in b.MEASURED or p.get("method") in ("sn-ia", "sn-ii", "supernova", "brightest-stars", "pnlf"):
            assert "group_radius" not in r["props"] and not p["dist"]["src"].startswith(group_src)
    # UNGC's own `mem` distances are not spread either
    for r in recs.values():
        if r["position"].get("method") == "group-member" and "UNGC" in r["position"]["dist"]["src"]:
            assert "group_radius" not in r["props"]
    # every record that carries a group radius sits at a group-member distance
    assert all(r["position"]["method"] == "group-member" for r in recs.values() if "group_radius" in r["props"])


def test_m31_m87_ngc4258_do_not_change_and_ngc4889_follows_coma(committed):
    recs = committed["recs"]
    for rid, method, d in (("ongc:NGC0224", "cepheid", 0.75901), ("ongc:NGC4486", "sbf", 16.768), ("ongc:NGC4258", "maser", 7.5693)):
        r = recs[rid]
        assert r["position"]["method"] == method and r["position"]["dist"]["v"] == d and r["evidence"] == "measured"
        assert "group_radius" not in r["props"]
        assert not any("group" in a["reason"] for a in r.get("alt_distances", []))
    r = recs["ongc:NGC4889"]
    assert r["position"]["method"] == "group-member" and r["position"]["dist"]["v"] == 92.876
    assert RICH_SRC.match(r["position"]["dist"]["src"]).group(1) == "Coma"
    assert r["alt_distances"][0]["method"] == "fundamental-plane" and r["alt_distances"][0]["dist"]["v"] == 103.65
    assert r["props"]["group_radius"]["v"] == 2.9 and r["props"]["group_radius"]["tier"] == "catalogue"
    smbh = st.load_dataset(ROOT / "frontend" / "data" / "objects" / "smbh-curated")
    star = {x["id"]: x for x in st._read_tile(smbh, "sky")}["bh:NGC 4889*"]
    assert star["position"]["dist"]["v"] == 92.876 and "group_radius" not in star["props"]


def test_a_targeted_refresh_touches_only_the_named_inputs(tmp_path):
    src, local = tmp_path / "src", tmp_path / "local"
    shutil.copytree(b.SOURCES, src)
    local.mkdir()
    for role in ("cf4-table2", "cf4-groups"):
        (local / b.INPUTS[role]["local"]).write_bytes(gzip.decompress((b.SOURCES / b.INPUTS[role]["file"]).read_bytes()))
    before = {p.name: p.read_bytes() for p in src.glob("*.gz")}
    b.refresh(src, local, only=("cf4-table2", "cf4-groups"))
    assert {p.name: p.read_bytes() for p in src.glob("*.gz")} == before                      # the same bytes, byte for byte
    meta = json.loads((src / "SOURCE.json").read_text())
    files = {f["role"]: f for f in meta["files"] if f.get("kind") != "committed"}
    assert set(files) == set(b.INPUTS) and files["ungc"]["mirror"] == "vizier.cfa.harvard.edu"      # untouched entry kept
    assert files["cf4-table2"]["mirror"] == "(local file)" and files["cf4-table2"]["sha256"] == b.INPUTS["cf4-table2"]["sha256"]
    with pytest.raises(SystemExit, match="unknown input"):
        b.refresh(src, local, only=("nope",))
    (src / "ungc-catalog.tsv.gz").write_bytes(gzip.compress(b"x", mtime=0))
    with pytest.raises(SystemExit, match="will not touch it"):
        b.refresh(src, local, only=("cf4-table2",))
