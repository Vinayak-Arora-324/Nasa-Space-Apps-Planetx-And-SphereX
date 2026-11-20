"""Offline tests for backend/scripts/build_objects_nebulae.py: synthetic rows for every rule, the committed
snapshots and dataset for the expected outcomes of docs/object-framework.md 17.3 and 17.4, the licence files,
the section 17.12 example records, and byte-identical rebuilds."""

from __future__ import annotations

import gzip
import importlib.util
import json
import shutil
import sys
from pathlib import Path

import pytest

from spherex_app import objects, objects_static as st

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "backend" / "scripts" / "build_objects_nebulae.py"
COMMITTED = ROOT / "frontend" / "data" / "objects" / "nebulae"
EXAMPLES = Path(__file__).parent / "fixtures" / "objects" / "examples"


def _script():
    spec = importlib.util.spec_from_file_location("build_objects_nebulae", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["build_objects_nebulae"] = mod
    spec.loader.exec_module(mod)
    return mod


b = _script()


# --- synthetic rows ---------------------------------------------------------------------------

def orow(name="NGC0001", typ="HII", ra="05:00:00.00", dec="+10:00:00.0", **kw) -> dict:
    r = {c: "" for c in b.ONGC_COLUMNS}
    r.update(Name=name, Type=typ, RA=ra, Dec=dec, MajAx="10.00", MinAx="5.00", **{"V-Mag": "9.0"})
    r.update(kw)
    return r


def nebs(*rows: dict) -> list[dict]:
    return b.read_nebulae(list(rows))[0]


def hms(deg: float) -> str:
    h = deg / 15.0
    return f"{int(h):02d}:{int((h % 1) * 60):02d}:{(h * 3600) % 60:05.2f}"


def dms(deg: float) -> str:
    a = abs(deg)
    return f"{'-' if deg < 0 else '+'}{int(a):02d}:{int((a % 1) * 60):02d}:{(a * 3600) % 60:04.1f}"


def srow(n: int, ra1900="05 30 00.0", de1900="-05 30 00", diam="60", form="3", struct="2", bright="3") -> dict:
    return {"recno": str(n), "Sh2": str(n), "GlLund": "", "GbLund": "", "GLon": "", "GLat": "", "RA1900": ra1900,
            "DE1900": de1900, "Diam": diam, "Form": form, "Struct": struct, "Bright": bright, "Stars": "0"}


def regions_at(*specs) -> list[dict]:
    """Sharpless regions for `(n, diam, ra, dec)` specs, placed at the given ICRS position (B1900 strings are
    chosen so that the precessed centre lands within a degree; the tests then use the precessed centre)."""
    out = b.read_sharpless([srow(n, diam=str(d)) for n, d, _, _ in specs])
    for s, (_, _, ra, dec) in zip(out, specs):
        s.update(ra=ra, dec=dec, _ra=ra, _dec=dec)
    return out


def neb_at(name: str, typ: str, s: dict, off_arcmin: float, maj: str = "10.00", **kw) -> dict:
    """An OpenNGC row `off_arcmin` north of a Sharpless centre."""
    return orow(name, typ, hms(s["_ra"]), dms(s["_dec"] + off_arcmin / 60.0), MajAx=maj, **kw)


def pairs_of(neb_rows, sh2, overrides=None):
    ov = b.read_overrides(overrides or [])[0]
    pairs, _ = b.merge_regions(nebs(*neb_rows), sh2, ov)
    return {n: p["ongc"] for n, p in pairs.items()}


# --- parsing ----------------------------------------------------------------------------------

def test_openngc_csv_reader_keeps_quoted_semicolons():
    head = ";".join(b.ONGC_COLUMNS) + "\n"
    cells = ["NGC0001", "HII", "05:00:00.00", "+10:00:00.0"] + [""] * 23 + ['"Bar; Foo, Baz"', "", "", "", ""]
    assert len(cells) == 32
    rows = b.parse_ongc((head + ";".join(cells) + "\n").encode())
    assert len(rows) == 1 and rows[0]["Identifiers"] == "Bar; Foo, Baz" and rows[0]["Name"] == "NGC0001"
    with pytest.raises(SystemExit):
        b.parse_ongc(b"Name;Type\nA;B\n")
    with pytest.raises(SystemExit):
        b.parse_ongc((head + "a;b;c\n").encode())


def test_the_committed_openngc_snapshot_has_quoted_semicolons():
    rows = b.parse_ongc(gzip.decompress((b.SOURCES / b.INPUTS["openngc"]["file"]).read_bytes()))
    assert len(rows) == b.INPUTS["openngc"]["rows"]
    assert any(";" in v for r in rows for v in r.values())


def test_sexagesimal_conversion_and_rounding():
    assert b.sexagesimal("18:53:35.01", hours=True) == 283.395875
    assert b.sexagesimal("+33:01:42.9", hours=False) == 33.0285833
    assert b.sexagesimal("-05:23:22.8", hours=False) == -5.3896667
    assert b.sexagesimal("-00:30:00", hours=False) == -0.5
    assert b.sexagesimal("", hours=True) is None and b.sexagesimal("12.5", hours=True) is None


def test_designation_formatting():
    assert [b.fmt_designation(x) for x in ("NGC1976", "IC0410", "C009", "NGC1530A", "B033")] == [
        "NGC 1976", "IC 410", "C 9", "NGC 1530A", "B 33"]


def test_strip_comments_drops_hash_and_empty_lines_only():
    assert b.strip_comments(b"#a\nx\n\n#b\n \t\ny\n") == b"x\n \t\ny\n"


# --- Dup folding, NonEx, types -----------------------------------------------------------------

def test_dup_rows_fold_into_their_master_and_non_nebulae_are_not_kept():
    rows = [
        orow("NGC2239", "Cl+N"), orow("NGC2244", "Dup", NGC="2239"),             # Dup through NGC
        orow("IC0434", "Neb"), orow("IC0999", "Dup", IC="0434"),                 # Dup through IC
        orow("NGC0100", "HII"), orow("IC0888", "Dup", NGC="0100", IC="0434"),    # both filled: NGC wins
        orow("NGC0200", "G"), orow("NGC0201", "Dup", NGC="0200"),               # master is a galaxy: not folded
        orow("NGC0300", "NonEx"), orow("M102", "Dup"),                            # dropped; no master
        orow("NGC0400", "OCl"), orow("NGC0500", "PN"),
    ]
    neb, rep = b.read_nebulae(rows)
    by = {n["name"]: n for n in neb}
    assert sorted(by) == ["IC0434", "NGC0100", "NGC0500", "NGC2239"]
    assert by["NGC2239"]["dups"] == ["NGC2244"] and by["IC0434"]["dups"] == ["IC0999"]
    assert by["NGC0100"]["dups"] == ["IC0888"] and by["NGC0500"]["dups"] == []
    assert rep["dup_designations_folded"] == 3 and rep["dups_without_master"] == ["M102"]
    assert rep["excluded"] == {"Dup": 5, "NonEx": 1} and rep["rows_read"] == 12
    assert rep["kept_by_type"] == {"Cl+N": 1, "HII": 1, "Neb": 1, "PN": 1}
    rec = b.nebula_record(by["NGC2239"], None, None, None)
    assert "NGC 2244" in rec["designations"]


def test_a_dup_with_a_suffixed_master_number():
    neb, rep = b.read_nebulae([orow("NGC1530A", "Neb"), orow("IC0900", "Dup", NGC="1530A")])
    assert neb[0]["dups"] == ["IC0900"] and rep["dup_designations_folded"] == 1


def test_the_real_dup_folding_ngc2244_into_ngc2239():
    inputs = b.load_inputs(b.SOURCES, None)["inputs"]
    neb, rep = b.read_nebulae(inputs["ongc"])
    assert {n["name"]: n for n in neb}["NGC2239"]["dups"] == ["NGC2244"]
    assert rep["excluded"] == {"Dup": 652, "NonEx": 10} and rep["dup_designations_folded"] == 24
    assert rep["dups_without_master"] == ["M102"]


def test_type_mapping_and_rows_without_a_position_are_reported():
    rows = [orow(f"NGC{i:04d}", t) for i, t in enumerate(b.NEBULA_TYPES, 1)] + [orow("NGC9000", "HII", ra="")]
    neb, rep = b.read_nebulae(rows)
    assert len(neb) == 8 and rep["nebulae_without_position"] == ["NGC9000"]
    labels = {n["type"]: b.nebula_record(n, None, None, None)["props"]["type"] for n in neb}
    assert {t: q["v"] for t, q in labels.items()} == {
        "PN": "Planetary nebula", "HII": "HII region", "EmN": "Emission nebula", "RfN": "Reflection nebula",
        "Neb": "Nebula", "SNR": "Supernova remnant", "Cl+N": "Cluster with nebula", "DrkN": "Dark nebula"}
    assert labels["PN"]["src"] == "OpenNGC v20260501 (PN)" and labels["PN"]["tier"] == "catalogue"


# --- Sharpless precession ---------------------------------------------------------------------

def test_b1900_to_icrs_against_a_known_row():
    """Sh2-281 (the Orion Nebula region): RA 05 30 ?, B1900 -> ICRS 83.7275, -5.4665 (checked against the
    table's own Galactic coordinates 209.0, -19.5)."""
    rows = b.parse_vizier(gzip.decompress((b.SOURCES / b.INPUTS["sharpless"]["file"]).read_bytes()))
    row = next(r for r in rows if r["Sh2"] == "281")
    s = b.read_sharpless([row])[0]
    assert s["ra"] == pytest.approx(83.7275, abs=2e-4) and s["dec"] == pytest.approx(-5.4665, abs=2e-4)
    assert s["l"] == pytest.approx(209.04, abs=0.01) and s["b"] == pytest.approx(-19.50, abs=0.01)


def test_precessed_galactic_coordinates_agree_with_the_tables_to_a_few_hundredths_of_a_degree():
    rows = b.parse_vizier(gzip.decompress((b.SOURCES / b.INPUTS["sharpless"]["file"]).read_bytes()))
    sh = b.read_sharpless(rows)
    assert len(sh) == 313
    offs = sorted(objects.angsep_deg(s["l"], s["b"], float(r["GLon"]), float(r["GLat"]))
                  for s, r in zip(sh, rows))
    assert offs[len(offs) // 2] < 0.05 and offs[-1] < 0.5


def test_a_hand_checked_b1900_precession():
    """Over 100 years at (0h, 0 deg) general precession gives about +3.075 s/yr in RA (1.281 deg) and
    +20.04 arcsec/yr in Dec (0.557 deg)."""
    (ra, dec, _, _), = b.b1900_to_icrs([("00 00 00.0", "+00 00 00")])
    assert ra == pytest.approx(1.281, abs=0.01) and dec == pytest.approx(0.557, abs=0.01)


# --- the merge rule ----------------------------------------------------------------------------

def test_step_1_identifier():
    (s,) = regions_at((155, 60, 344.0, 62.0))
    far = orow("C009", "HII", hms(300.0), dms(10.0), Identifiers="LBN 529,SH 2-155")   # nowhere near
    assert pairs_of([far], [s]) == {155: "C009"}
    pairs, rep = b.merge_regions(nebs(far), [s], {})
    assert rep["by_rule"] == {"identifier": 1, "override": 0, "positional": 0}
    assert pairs[155]["rule"] == "identifier"
    # the identifier is for another number: no merge
    other = orow("C010", "HII", hms(300.0), dms(10.0), Identifiers="SH 2-154")
    assert pairs_of([other], [s]) == {}


def test_step_2_overrides_and_the_null_override():
    (s,) = regions_at((11, 90, 260.0, -34.0))
    near = neb_at("NGC6357", "Cl+N", s, 22.0, maj="3.90")
    other = neb_at("NGC6358", "HII", s, 2.0, maj="30.00")
    ov = [{"sh2": 11, "ongc": "NGC6357", "reason": "x"}]
    assert pairs_of([near, other], [s]) == {11: "NGC6358"}          # positional alone picks the better score
    assert pairs_of([near, other], [s], ov) == {11: "NGC6357"}      # the override wins
    _, rep = b.merge_regions(nebs(near, other), [s], b.read_overrides(ov)[0])
    assert rep["by_rule"]["override"] == 1 and rep["merged_pairs"][0]["rule"] == "override"
    null = [{"sh2": 11, "ongc": None, "reason": "none"}]
    assert pairs_of([near, other], [s], null) == {}                  # null forbids any merge
    far_id = orow("X1", "HII", hms(10.0), dms(0.0), Identifiers="SH 2-11")
    assert pairs_of([far_id], [s], null) == {}                       # even by identifier
    with pytest.raises(SystemExit, match="not a kept OpenNGC nebula"):
        pairs_of([near], [s], [{"sh2": 11, "ongc": "NGC9999", "reason": "x"}])
    with pytest.raises(SystemExit, match="no such Sharpless"):
        pairs_of([near], [s], [{"sh2": 12, "ongc": "NGC6357", "reason": "x"}])
    with pytest.raises(SystemExit):
        b.read_overrides([{"sh2": 11, "ongc": "NGC6357"}])           # a reason is required


def test_step_3_positional_never_takes_a_pn_and_respects_the_types():
    (s,) = regions_at((1, 30, 100.0, 10.0))
    for typ, ok in (("HII", 1), ("EmN", 1), ("Neb", 1), ("Cl+N", 1), ("RfN", 1), ("SNR", 1), ("DrkN", 1), ("PN", 0)):
        assert len(pairs_of([neb_at("NGC0001", typ, s, 1.0)], [s])) == ok, typ


def test_the_separation_cap():
    (s,) = regions_at((1, 90, 100.0, 10.0))      # Diam/3 = 30'
    assert pairs_of([neb_at("NGC0001", "HII", s, 29.0, maj="10.00")], [s]) == {1: "NGC0001"}
    assert pairs_of([neb_at("NGC0001", "HII", s, 31.0, maj="10.00")], [s]) == {}
    # 0.6 * MajAx widens it, up to the hard cap of 40'
    assert pairs_of([neb_at("NGC0001", "HII", s, 35.0, maj="60.00")], [s]) == {1: "NGC0001"}
    assert pairs_of([neb_at("NGC0001", "HII", s, 41.0, maj="90.00")], [s]) == {}
    (small,) = regions_at((2, 6, 100.0, 10.0))   # the floor is 10'
    assert pairs_of([neb_at("NGC0001", "HII", small, 9.0, maj="1.00")], [small]) == {2: "NGC0001"}
    assert pairs_of([neb_at("NGC0001", "HII", small, 11.0, maj="1.00")], [small]) == {}
    (huge,) = regions_at((3, 1200, 100.0, 10.0))  # Diam/3 = 400' is capped at 40'
    assert pairs_of([neb_at("NGC0001", "HII", huge, 41.0, maj="500.00")], [huge]) == {}


def test_the_size_guard_a_small_object_far_from_the_centre_of_a_much_larger_region_is_a_member():
    (s,) = regions_at((1, 300, 100.0, 10.0))     # 5 degrees
    member = neb_at("NGC0001", "Neb", s, 12.0, maj="3.00")        # Diam >= 10 * MajAx and s > 10'
    assert pairs_of([member], [s]) == {}
    centre = neb_at("NGC0001", "Neb", s, 8.0, maj="3.00")         # within 10': allowed
    assert pairs_of([centre], [s]) == {1: "NGC0001"}
    big = neb_at("NGC0001", "Neb", s, 12.0, maj="31.00")          # Diam < 10 * MajAx: allowed
    assert pairs_of([big], [s]) == {1: "NGC0001"}


def test_the_score_prefers_the_nebula_over_the_cluster():
    """Rosette: NGC 2237 (80', 14' away) beats the cluster NGC 2239 (9.3', 3.3' away)."""
    (s,) = regions_at((275, 100, 100.0, 5.0))
    nebula = neb_at("NGC2237", "Neb", s, 14.0, maj="80.00")
    cluster = neb_at("NGC2239", "Cl+N", s, -3.3, maj="9.30")
    assert pairs_of([cluster, nebula], [s]) == {275: "NGC2237"}


def test_conflict_fallback_the_best_score_keeps_the_nebula_and_the_others_take_their_next_candidate():
    s1, s2 = regions_at((1, 40, 100.0, 10.0), (2, 40, 100.0, 10.4))
    shared = neb_at("NGC0001", "HII", s1, 1.0, maj="10.00")                  # 1' from Sh2-1, ~25' from Sh2-2
    second = orow("NGC0002", "HII", hms(s2["_ra"]), dms(s2["_dec"] - 8 / 60), MajAx="10.00")
    got = pairs_of([shared, second], [s1, s2])
    assert got == {1: "NGC0001", 2: "NGC0002"}
    # without a second candidate the loser stays unmerged
    assert pairs_of([shared], [s1, s2]) == {1: "NGC0001"}
    # one nebula is claimed at most once, and the identifier step comes first
    (s3,) = regions_at((3, 40, 100.0, 10.0))
    ident = orow("NGC0001", "HII", hms(s3["_ra"]), dms(s3["_dec"] + 1 / 60), Identifiers="SH 2-1")
    assert pairs_of([ident], [s1, s3]) == {1: "NGC0001"}


def test_a_region_with_no_candidate_stays_sharpless_only():
    (s,) = regions_at((7, 30, 100.0, 10.0))
    assert pairs_of([orow("NGC0001", "HII", hms(200.0), dms(-40.0))], [s]) == {}


# --- the expected outcomes on the real snapshot (17.3) ----------------------------------------

@pytest.fixture(scope="module")
def built():
    loaded = b.load_inputs(b.SOURCES, None)
    records, report = b.build_records(loaded["inputs"], loaded["overrides"], loaded["shen_overrides"])
    return {"records": {r["id"]: r for r in records}, "report": report, "loaded": loaded}


EXPECTED_PAIRS = {281: "NGC1976", 275: "NGC2237", 117: "NGC7000", 131: "IC1396", 25: "NGC6523", 155: "C009",
                  220: "NGC1499", 236: "IC0410"}


def test_the_expected_pairs_of_17_3_hold_on_the_snapshot(built):
    pairs = {p["sh2"]: p for p in built["report"]["merged_pairs"]}
    for n, ongc in EXPECTED_PAIRS.items():
        assert pairs[n]["ongc"] == ongc, (n, pairs.get(n))
    assert 276 not in pairs and 109 not in pairs
    assert pairs[155]["rule"] == "identifier"
    assert {n for n, p in pairs.items() if p["rule"] == "override"} == {11, 25}
    assert pairs[11]["ongc"] == "NGC6357" and pairs[281]["rule"] == "positional"
    # each OpenNGC row and each region is used once
    assert len({p["ongc"] for p in pairs.values()}) == len(pairs)
    assert built["report"]["merges"] == {"identifier": 1, "override": 2, "positional": 46}
    assert len(pairs) == 49


def test_the_merge_overrides_in_the_committed_table():
    ov = json.loads((b.SOURCES / b.OVERRIDES_FILE).read_text())
    by = {e["sh2"]: e for e in ov}
    assert by[11]["ongc"] == "NGC6357" and by[276]["ongc"] is None and by[109]["ongc"] is None
    assert by[25]["ongc"] == "NGC6523" and by[281]["russeil_complex"] == "208.0-19.0"
    assert all(e["reason"].strip() for e in ov)


def test_sharpless_only_regions_and_merged_ids(built):
    recs = built["records"]
    assert built["report"]["sharpless_only"] == 264 and built["report"]["sharpless_rows"] == 313
    assert sum(1 for i in recs if i.startswith("sh2:")) == 264 and len(recs) == 433 + 264
    loop = recs["sh2:276"]
    assert loop["name"] == "Barnard's Loop" and loop["props"]["type"]["v"] == "HII region"
    assert loop["position"]["dist"] is None and loop["size"]["angular"]["major"]["v"] == 1200
    assert loop["size"]["angular"]["minor"] is None and loop["size"]["angular"]["pa"] is None
    assert not any("Sh2-109" in r["designations"] for r in recs.values() if r["id"] != "sh2:109")
    assert recs["sh2:109"]["name"] == "Sh2-109"
    assert "Sh2-281" in recs["ongc:NGC1976"]["designations"] and "sh2:281" not in recs


# --- the size rule ------------------------------------------------------------------------------

def test_size_rule_openngc_when_its_major_axis_is_at_least_a_third_of_the_diameter():
    n = nebs(orow("NGC0001", "Cl+N", MajAx="20.00", MinAx="10.00", PosAng="45"))[0]
    s = regions_at((1, 60, 100.0, 10.0))[0]                      # 20 >= 60/3: OpenNGC
    a = b.size_for(n, s)
    assert (a["major"]["v"], a["minor"]["v"], a["pa"]["v"], a["pa"]["unit"]) == (20, 10, 45, "deg")
    assert a["major"]["src"] == "OpenNGC v20260501"
    s2 = regions_at((1, 61, 100.0, 10.0))[0]                     # 20 < 61/3: the Sharpless diameter, a circle
    c = b.size_for(n, s2)
    assert c["major"]["v"] == 61 and c["minor"] is None and c["pa"] is None
    assert "Sharpless" in c["major"]["src"] and "circle" in c["major"]["src"]
    assert b.size_for(n, None)["major"]["v"] == 20 and b.size_for(None, s)["major"]["v"] == 60
    nosize = nebs(orow("NGC0002", "Neb", MajAx="", MinAx=""))[0]
    assert b.size_for(nosize, None) is None and b.size_for(nosize, s)["major"]["v"] == 60
    assert b.nebula_record(nosize, None, None, None)["size"] is None


def test_ic1396_takes_sharplesss_170_arcmin(built):
    r = built["records"]["ongc:IC1396"]
    a = r["size"]["angular"]
    assert a["major"]["v"] == 170 and a["minor"] is None and a["pa"] is None
    assert "Sharpless" in a["major"]["src"]
    assert "Sh2-131" in r["designations"]
    orion = built["records"]["ongc:NGC1976"]["size"]["angular"]
    assert (orion["major"]["v"], orion["minor"]["v"]) == (90, 60) and orion["major"]["src"] == "OpenNGC v20260501"


# --- planetary nebula distances (17.4) ----------------------------------------------------------

def crow(png="063.1+13.9", rel="0.99997", plx="1.2696", e="0.04376", ruwe="1.07", gaia="2090486618786534784") -> dict:
    return {"PNG": png, "Name": "x", "GaiaEDR3": gaia, "Rel": rel, "plx": plx, "e_plx": e, "RUWE": ruwe}


def pn_match(c: dict, ident="IRAS 1,PN G063.1+13.9"):
    row = orow("NGC6720", "PN", Identifiers=ident)
    return b.pn_distance(row, {c["PNG"]: [c]})


def test_a_pn_that_passes_every_cut_gets_a_parallax_distance():
    m, why = pn_match(crow())
    assert why == "ok" and m["gaia"] == "2090486618786534784"
    q = b.pn_dist_quantity(m)
    assert q["v"] == 787.65 and q["lo"] == pytest.approx(761.41, abs=0.02) and q["hi"] == 815.77
    assert q["unit"] == "pc" and q["tier"] == "measured" and "no zero-point correction" in q["src"]
    n = nebs(orow("NGC6720", "PN"))[0]
    r = b.nebula_record(n, None, m, None)
    assert r["evidence"] == "measured" and r["position"]["method"] == "parallax"
    assert r["props"]["central_star"]["v"] == "Gaia EDR3 2090486618786534784"
    assert r["size"]["radius"]["tier"] == "inferred" and r["size"]["radius"]["src"] == "from angular size and distance"
    assert objects.validate_record(r) == []


@pytest.mark.parametrize("label,kw,why", [
    ("Rel below 0.9", {"rel": "0.89"}, "Rel"),
    ("a blank Rel", {"rel": ""}, "Rel"),
    ("S/N below 5", {"plx": "1.0", "e": "0.21"}, "S/N"),
    ("a zero parallax error", {"e": "0"}, "S/N"),
    ("a blank parallax", {"plx": ""}, "S/N"),
    ("RUWE of 1.4", {"ruwe": "1.4"}, "RUWE"),
    ("a blank RUWE", {"ruwe": ""}, "RUWE"),
])
def test_each_pn_cut_drops_its_row(label, kw, why):
    m, got = pn_match(crow(**kw))
    assert m is None and got == why, label


def test_pn_cut_edges_pass():
    assert pn_match(crow(rel="0.9"))[1] == "ok"
    assert pn_match(crow(plx="1.0", e="0.2"))[1] == "ok"        # S/N exactly 5
    assert pn_match(crow(ruwe="1.3999"))[1] == "ok"


def test_pn_matching_needs_a_pn_g_identifier_and_a_chornay_row():
    assert b.pn_distance(orow("NGC1", "PN", Identifiers="IRAS 1"), {})[1] == "no PN G id"
    assert b.pn_distance(orow("NGC1", "PN", Identifiers="PN G001.0+01.0"), {})[1] == "not in Chornay"
    assert b.png_ids(orow(Identifiers="PN G063.1+13.9, PK 1")) == ["063.1+13.9"]


def test_chornay_rows_for_a_non_pn_are_never_used():
    inputs = {"ongc": [orow("NGC1", "HII", Identifiers="PN G063.1+13.9")], "sharpless": [], "chornay": [crow()],
              "russeil1": [], "russeil3": []}
    recs, rep = b.build_records(inputs, [])
    assert recs[0]["position"]["dist"] is None and rep["planetary_nebula_cuts"]["rows"] == 0


def test_the_pn_cut_counts_on_the_snapshot(built):
    cuts = built["report"]["planetary_nebula_cuts"]
    assert cuts == {"rows": 130, "no_png_id": 3, "not_in_chornay": 12, "fail_rel": 13, "fail_snr": 35,
                    "fail_ruwe": 8, "pass": 59}
    assert sum(cuts[k] for k in cuts if k != "rows") == cuts["rows"]
    measured = [r for r in built["records"].values() if r["props"]["type"]["v"] == "Planetary nebula"
                and r["position"].get("method") == "parallax"]
    assert len(measured) == 59
    for name in ("NGC6720", "NGC7293", "NGC6853", "NGC3587", "NGC2392", "NGC6543", "NGC40"):
        assert built["records"].get(f"ongc:{name}", built["records"].get(f"ongc:NGC{int(name[3:]):04d}")
                                    )["position"]["dist"]["tier"] == "measured", name


# --- Russeil linking (17.4) --------------------------------------------------------------------

def r1(name, ha) -> dict:
    return {"Name": name, "HaName": ha}


def r3(seq, lon, lat, dist="", dist_st="", e="", n="") -> dict:
    return {"Seq": str(seq), "GLON": lon, "GLAT": lat, "Dist": dist, "DistSt": dist_st, "e_DistSt": e, "n_DistSt": n}


def reg_gal(n, l, bb) -> dict:
    return {"n": n, "l": l, "b": bb}


def test_russeil_numeric_join_and_s_references():
    regions = {25: reg_gal(25, 6.15, -1.5), 26: reg_gal(26, 100.0, 1.0)}
    t1 = [r1("6.0-1.2", "M8=S25"), r1("6.0-1.2", ""), r1("100.0+1.0", "S26"), r1("100.0+1.0", "S 26")]
    t3 = [r3(9, "006.0", " -1.2", dist="2.8", dist_st="1.6", e="0.25"), r3(10, "100.0", "+1.0", dist="3.0")]
    best, rep = b.russeil_links(t1, t3, regions, {})
    assert list(best) == [25] and best[25]["complex"] == "6.0-1.2" and best[25]["seq"] == 9
    assert rep["links"] == 2 and rep["links_dropped_by_1deg_filter"] == 0
    assert rep["regions_linked"] == 2 and rep["regions_with_stellar_distance"] == 1   # 26 has no DistSt
    q = b.russeil_quantity(best[25])
    assert (q["v"], q["lo"], q["hi"], q["unit"], q["tier"]) == (1600, 1350, 1850, "pc", "inferred")
    assert "complex 6.0-1.2 (Sh2-25)" in q["src"] and "photometric" not in q["src"]


def test_russeil_uses_the_stellar_distance_never_the_kinematic_one():
    regions = {1: reg_gal(1, 10.0, 0.0)}
    t3 = [r3(1, "010.0", "+0.0", dist="5.0")]
    best, _ = b.russeil_links([r1("10.0+0.0", "S1")], t3, regions, {})
    assert best == {}
    t3 = [r3(1, "010.0", "+0.0", dist="5.0", dist_st="2.0", e="0.5", n=")")]
    best, _ = b.russeil_links([r1("10.0+0.0", "S1")], t3, regions, {})
    q = b.russeil_quantity(best[1])
    assert q["v"] == 2000 and "photometric data only" in q["src"]


def test_russeil_one_degree_filter_and_the_join_tolerance():
    regions = {1: reg_gal(1, 10.0, 0.0), 2: reg_gal(2, 10.0, 0.0)}
    t3 = [r3(1, "011.1", "+0.0", dist_st="2.0", e="0.1")]
    best, rep = b.russeil_links([r1("11.1+0.0", "S1")], t3, regions, {})
    assert best == {} and rep["links_dropped_by_1deg_filter"] == 1
    assert rep["dropped"] == [{"sh2": 1, "complex": "11.1+0.0", "seq": 1, "sep_deg": 1.1}]
    t3 = [r3(1, "010.9", "+0.0", dist_st="2.0", e="0.1")]
    assert list(b.russeil_links([r1("10.9+0.0", "S1")], t3, regions, {})[0]) == [1]
    # a table1 name more than 0.05 deg from every table3 row is not linked at all
    best, rep = b.russeil_links([r1("10.9+0.0", "S1")], [r3(1, "010.8", "+0.0", dist_st="2.0")], regions, {})
    assert best == {} and rep["links"] == 0 and rep["links_dropped_by_1deg_filter"] == 0
    # the sky separation uses cos(b): 1.05 deg in longitude at b = 60 is only 0.53 deg on the sky
    hi = {1: reg_gal(1, 10.0, 60.0)}
    best, _ = b.russeil_links([r1("11.1+60.0", "S1")], [r3(1, "011.1", "+60.0", dist_st="2.0")], hi, {})
    assert list(best) == [1]


def test_russeil_nearest_complex_wins_and_an_override_can_accept_a_dropped_link():
    regions = {5: reg_gal(5, 50.0, 0.0)}
    t1 = [r1("50.4+0.0", "S5"), r1("50.1+0.0", "S5")]
    t3 = [r3(1, "050.4", "+0.0", dist_st="3.0"), r3(2, "050.1", "+0.0", dist_st="1.0")]
    best, _ = b.russeil_links(t1, t3, regions, {})
    assert best[5]["complex"] == "50.1+0.0"
    far = {5: reg_gal(5, 50.0, 0.0)}
    best, rep = b.russeil_links([r1("51.5+0.0", "S5")], [r3(1, "051.5", "+0.0", dist_st="3.0")], far, {5: "51.5+0.0"})
    assert best[5]["override"] is True and rep["links_dropped_by_1deg_filter"] == 0
    assert rep["links_accepted_by_override"][0]["complex"] == "51.5+0.0"
    with pytest.raises(SystemExit, match="match no table1/table3 link"):
        b.russeil_links([r1("51.5+0.0", "S5")], [r3(1, "051.5", "+0.0")], far, {5: "99.0+0.0"})


def russeil_inputs(types: list[str]) -> dict:
    """OpenNGC nebulae of the given types, each merged with its own Sharpless region that has a Russeil complex."""
    ongc, sh, t1, t3 = [], [], [], []
    for i, typ in enumerate(types, 1):
        ra1900 = f"{5 + i:02d} 00 00.0"
        sh.append(srow(i, ra1900=ra1900, de1900="+10 00 00", diam="20"))
    sref = b.read_sharpless(sh)
    for i, (typ, s) in enumerate(zip(types, sref), 1):
        ongc.append(orow(f"NGC{i:04d}", typ, hms(s["_ra"]), dms(s["_dec"]), MajAx="20.00"))
        t1.append(r1(f"{s['l']:.1f}{s['b']:+.1f}", f"S{i}"))
        t3.append(r3(i, f"{s['l']:05.1f}", f"{s['b']:+.1f}", dist_st="1.5", e="0.2"))
    return {"ongc": ongc, "sharpless": sh, "chornay": [], "russeil1": t1, "russeil3": t3}


def test_russeil_applies_to_hii_emn_neb_cl_n_and_sharpless_only_but_never_to_snr_pn_rfn_drkn():
    types = ["HII", "EmN", "Neb", "Cl+N", "SNR", "RfN", "DrkN"]
    recs, rep = b.build_records(russeil_inputs(types), [])
    by = {r["id"]: r for r in recs}
    for i, typ in enumerate(types, 1):
        r = by[f"ongc:NGC{i:04d}"]
        has = r["position"]["dist"] is not None
        assert has == (typ in ("HII", "EmN", "Neb", "Cl+N")), typ
        if has:
            assert r["evidence"] == "derived" and r["position"]["method"] == "photometric"
            assert r["position"]["dist"]["tier"] == "inferred" and r["size"]["radius"]["tier"] == "inferred"
        else:
            assert r["evidence"] == "measured" and r["size"]["radius"] is None and "method" not in r["position"]
        assert objects.validate_record(r) == []
    assert rep["merges"]["positional"] == 7 and rep["distances"]["russeil_derived"] == 4
    # a Sharpless-only region with a linked complex takes the distance too
    inp = russeil_inputs(["HII"])
    inp["ongc"] = []
    recs, _ = b.build_records(inp, [])
    assert recs[0]["id"] == "sh2:1" and recs[0]["position"]["dist"]["v"] == 1500


def test_a_pn_parallax_beats_russeil():
    inp = russeil_inputs(["HII"])
    inp["ongc"][0].update(Type="PN", Identifiers="PN G063.1+13.9")
    inp["chornay"] = [crow()]
    recs, rep = b.build_records(inp, [{"sh2": 1, "ongc": "NGC0001", "reason": "test"}])
    r = next(x for x in recs if x["id"] == "ongc:NGC0001")
    assert r["position"]["method"] == "parallax" and r["evidence"] == "measured"
    assert rep["distances"] == {"pn_parallax_measured": 1, "shen": 0, "russeil_derived": 0, "direction_only": 0}


def test_russeil_known_regions_still_link_and_sit_in_alt_distances_on_the_snapshot(built):
    """Approval condition 5 (docs 17.4): Orion 350-500 pc, M8 1.0-1.8 kpc, and the Rosette linked to complex 206.3-2.1
    (Russeil's table1 labels it "Rosette = W16 = NGC 2237") at 1.9 +- 0.25 kpc. Since Phase 4 a measured Shen distance is
    adopted instead, and the Russeil value is kept as a "not used" alternative. Sh2-281 needs its link override because
    Russeil's Orion complex is 1.10 deg from the Sharpless centre."""
    recs = built["records"]

    def russeil(rid):
        alts = [a for a in recs[rid]["alt_distances"] if a["method"] == "photometric"]
        assert len(alts) == 1 and alts[0]["dist"]["tier"] == "inferred"
        assert alts[0]["reason"] == "not used: a derived distance; a measured one exists"
        return alts[0]["dist"]

    orion = russeil("ongc:NGC1976")
    assert 350 <= orion["v"] <= 500 and (orion["v"], orion["lo"], orion["hi"]) == (400, 360, 440)
    assert "complex 208.0-19.0 (Sh2-281)" in orion["src"]
    m8 = russeil("ongc:NGC6523")
    assert 1000 <= m8["v"] <= 1800 and m8["v"] == 1600 and "complex 6.0-1.2 (Sh2-25)" in m8["src"]
    rosette = russeil("ongc:NGC2237")
    assert "complex 206.3-2.1 (Sh2-275)" in rosette["src"]
    assert (rosette["v"], rosette["lo"], rosette["hi"]) == (1900, 1650, 2150)
    # a Russeil distance that is still adopted (Shen has no row there) keeps its old src and derived evidence
    assert recs["ongc:NGC6611"]["position"]["method"] == "photometric" and recs["ongc:NGC6611"]["evidence"] == "derived"


def test_the_one_degree_filter_report_on_the_snapshot(built):
    ru = built["report"]["russeil"]
    assert (ru["links"], ru["links_dropped_by_1deg_filter"]) == (289, 106) and len(ru["dropped"]) == 106
    assert ru["regions_with_stellar_distance"] == 150 and ru["regions_linked"] == 183
    assert ru["table1_rows"] == 1449 and ru["table3_rows"] == 481 and ru["sharpless_numbers_named"] == 270
    dropped = {(d["sh2"], d["complex"]) for d in ru["dropped"]}
    assert (276, "208.0-19.0") in dropped and (8, "96.3-0.2") in dropped and (27, "355.1+20.9") in dropped
    assert (25, "6.0-1.2") not in dropped and (275, "206.3-2.1") not in dropped
    assert all(d["sep_deg"] > 1.0 for d in ru["dropped"])
    assert [(d["sh2"], d["complex"]) for d in ru["links_accepted_by_override"]] == [(281, "208.0-19.0")]
    assert ru["links_accepted_by_override"][0]["sep_deg"] > 1.0


def test_the_crab_stays_direction_only_and_snrs_never_get_a_distance(built):
    crab = built["records"]["ongc:NGC1952"]
    assert crab["position"]["dist"] is None and crab["evidence"] == "measured" and crab["size"]["radius"] is None
    assert "Sh2-244" in crab["designations"]
    for r in built["records"].values():
        if r["props"]["type"]["v"] in ("Supernova remnant", "Reflection nebula", "Dark nebula"):
            assert r["position"]["dist"] is None, r["id"]
        if r["position"]["dist"] is None:
            assert r["evidence"] == "measured" and "method" not in r["position"] and r["host"] is None
            assert r["size"] is None or r["size"]["radius"] is None
            assert r["position"]["tier"] == "catalogue"


def test_distances_by_method_on_the_snapshot(built):
    rep = built["report"]
    assert rep["distances"] == {"pn_parallax_measured": 59, "shen": 141, "russeil_derived": 77, "direction_only": 420}
    assert sum(rep["distances"].values()) == rep["records_written"] == 697
    assert rep["by_evidence"] == {"derived": 137, "measured": 560}
    assert rep["rows_read"] == 14033 and rep["nebula_rows"] == 433 and rep["dup_designations_folded"] == 24
    assert rep["kept_by_type"] == {"Cl+N": 67, "DrkN": 2, "EmN": 8, "HII": 83, "Neb": 94, "PN": 130, "RfN": 38,
                                   "SNR": 11}
    assert rep["excluded"] == {"Dup": 652, "NonEx": 10}


def test_every_built_record_is_valid_and_distance_rules_hold(built):
    for r in built["records"].values():
        assert objects.validate_record(r) == [], r["id"]
        d = r["position"]["dist"]
        if d is not None:
            assert r["size"] is None or r["size"]["radius"] is None or r["size"]["radius"]["tier"] == "inferred"
            assert (d["tier"], r["evidence"]) in (("measured", "measured"), ("inferred", "derived"))


# --- names, designations, ids ----------------------------------------------------------------

def test_names_and_designations():
    n = nebs(orow("NGC6720", "PN", M="057", Identifiers="IRAS 18517+3257,PN G063.1+13.9", **{"Common names": "Ring Nebula"}))[0]
    r = b.nebula_record(n, None, None, None)
    assert r["id"] == "ongc:NGC6720" and r["name"] == "Ring Nebula"
    assert r["designations"] == ["M 57", "NGC 6720", "PN G063.1+13.9", "IRAS 18517+3257"]
    plain = b.nebula_record(nebs(orow("IC1396", "Cl+N"))[0], None, None, None)
    assert plain["name"] == "IC 1396" and plain["designations"] == []
    first = b.nebula_record(nebs(orow("NGC0007", "Neb", **{"Common names": "Foo Nebula,Bar Nebula"}))[0], None, None, None)
    assert first["name"] == "Foo Nebula" and "Bar Nebula" in first["designations"]
    m = b.nebula_record(nebs(orow("NGC0008", "Neb", M="099"))[0], None, None, None)
    assert m["name"] == "M 99"
    s = regions_at((155, 60, 344.0, 62.0))[0]
    assert b.nebula_record(None, s, None, None)["name"] == "Sh2-155"
    assert b.nebula_record(None, s, None, None)["id"] == "sh2:155"
    merged = b.nebula_record(nebs(orow("C009", "HII", Identifiers="LBN 529,SH 2-155"))[0], s, None, None)
    assert merged["designations"].count("Sh2-155") == 1 and "SH 2-155" not in merged["designations"]


def test_curated_names(built):
    names = {rid: built["records"][rid]["name"] for rid in b.COMMON_NAMES if rid in built["records"]}
    assert names["ongc:NGC1976"] == "Orion Nebula" and names["ongc:NGC6720"] == "Ring Nebula"
    assert names["ongc:NGC1952"] == "Crab Nebula" and names["ongc:NGC6523"] == "Lagoon Nebula"
    assert names["ongc:NGC7000"] == "North America Nebula" and names["ongc:NGC2237"] == "Rosette Nebula"
    assert names["sh2:276"] == "Barnard's Loop" and names["ongc:B033"] == "Horsehead Nebula"
    assert names["ongc:NGC7293"] == "Helix Nebula" and names["ongc:NGC6853"] == "Dumbbell Nebula"
    assert len(names) == len(b.COMMON_NAMES)
    shown = [r["name"] for r in built["records"].values()]
    assert shown.count("Rosette Nebula") == 1 and shown.count("Eagle Nebula") == 1


def test_sharpless_morphology_words():
    s = b.read_sharpless([srow(1, form="1", struct="3", bright="2"), srow(2, form="", struct="9", bright="")])
    p = b.sh2_props(s[0])
    assert (p["sh2_form"]["v"], p["sh2_struct"]["v"], p["sh2_bright"]["v"]) == ("circular", "filamentary", "moderate")
    assert p["sh2_form"]["src"] == "Sharpless 1959 (VII/20) Form 1"
    assert b.sh2_props(s[1]) == {}


# --- the section 17.12 examples ---------------------------------------------------------------

@pytest.mark.parametrize("rid,fixture", [("ongc:NGC6720", "nebula_m57"), ("ongc:NGC1976", "nebula_m42"),
                                         ("ongc:NGC1952", "nebula_crab")])
def test_the_17_12_examples_equal_the_built_records(built, rid, fixture):
    example = json.loads((EXAMPLES / f"{fixture}.json").read_text(encoding="utf-8"))
    assert example == built["records"][rid]
    assert objects.validate_record(example) == []
    ds = st.load_dataset(COMMITTED)
    tiled = [r for t in ds.manifest["tiles"] for r in st._read_tile(ds, t) if r["id"] == rid]
    assert tiled == [example]


def test_the_examples_match_the_documented_numbers():
    m57 = json.loads((EXAMPLES / "nebula_m57.json").read_text(encoding="utf-8"))
    d = m57["position"]["dist"]
    assert (m57["position"]["ra"], m57["position"]["dec"]) == (283.395875, 33.0285833)
    assert (d["v"], d["hi"]) == (787.65, 815.77) and d["lo"] == pytest.approx(761.41, abs=0.02)
    assert m57["size"]["radius"]["v"] == 0.1455 and m57["props"]["central_star"]["src"].endswith("RUWE 1.07)")
    assert m57["provenance"] == {"source": "static:nebulae", "dataset": "nebulae",
                                 "catalogue": "OpenNGC + Sharpless (VII/20)",
                                 "version": "OpenNGC v20260501 (36cb178a)"}
    m42 = json.loads((EXAMPLES / "nebula_m42.json").read_text(encoding="utf-8"))
    assert m42["designations"] == ["M 42", "NGC 1976", "Sh2-281", "LBN 974", "MWSC 0582", "Great Orion Nebula"]
    assert (m42["position"]["ra"], m42["position"]["dec"]) == (83.8186667, -5.3896667)
    assert (m42["position"]["dist"]["v"], m42["position"]["method"], m42["evidence"]) == (390, "parallax", "measured")
    assert m42["alt_distances"][0]["dist"]["v"] == 400
    crab = json.loads((EXAMPLES / "nebula_crab.json").read_text(encoding="utf-8"))
    assert crab["designations"] == ["M 1", "NGC 1952", "Sh2-244", "LBN 833", "IRAS 05315+2158"]
    assert (crab["position"]["ra"], crab["position"]["dec"]) == (83.6332083, 22.0144722)
    assert crab["position"]["dist"] is None and crab["size"]["radius"] is None


# --- licence -----------------------------------------------------------------------------------

def test_license_files_exist_in_both_folders_and_say_what_17_2_requires():
    for folder, which in ((b.SOURCES, "sources"), (COMMITTED, "dataset")):
        text = (folder / "LICENSE.md").read_text(encoding="utf-8")
        assert text == b.license_text(which)
        for needle in ("CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/",
                       "Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC",
                       "NASA/IPAC Extragalactic Database", "HyperLeda", "SIMBAD", "HEASARC", "Harold Corwin",
                       "Sharpless", "Chornay", "Russeil", "MIT", "every file in"):
            assert needle in text, (which, needle)
    assert "OpenNGC `NGC.csv`" in (b.SOURCES / "LICENSE.md").read_text()
    assert "tiles/*.json" in (COMMITTED / "LICENSE.md").read_text()


def test_the_manifest_provenance_carries_the_credit_and_the_licence():
    p = json.loads((COMMITTED / "manifest.json").read_text())["provenance"]
    assert p["credit"] == ("Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC; PN distances (Chornay & "
                           "Walton 2021, Gaia EDR3) and HII-region distances (Shen et al. 2025, Gaia DR3): "
                           "Credit: ESA/Gaia/DPAC")
    assert p["licence_name"] == "CC BY-SA 4.0 (OpenNGC data); Gaia-based PN and HII-region distances CC BY-NC 3.0 IGO"
    assert "Shen X.-J., Hou L.-G., Liu Z. & Gao Z.-M., 2025, A&A 696, A67" in p["citation"] and "doi:10.1051/0004-6361/202452712" in p["citation"]
    assert "maser" in p["data_licence_note"] and "not Gaia" in p["data_licence_note"]
    assert p["licence"] == "https://creativecommons.org/licenses/by-sa/4.0/"
    assert p["openngc_commit"] == "36cb178a0f69dba8bfc03a99c10512831edf1c6b"
    assert {i["role"] for i in p["inputs"]} == set(b.INPUTS)


def test_openngc_acknowledgements_are_the_readme_wording_at_the_pinned_commit():
    # the README at the pinned commit credits "Mattia Verga" and lists NED, HyperLEDA, SIMBAD, HEASARC and Corwin
    for line in ("This research has made use of the NASA/IPAC Extragalactic Database (NED)",
                 "We acknowledge the usage of the HyperLeda database (http://leda.univ-lyon1.fr)",
                 "This research has made use of the SIMBAD database, operated at CDS, Strasbourg, France",
                 "We used several databases from HEASARC such as messier, mwsc, lbn, plnebulae, lmcextobj and "
                 "smcclustrs."):
        assert line in b.OPENNGC_ACKNOWLEDGEMENTS


# --- snapshots, pins and refresh ---------------------------------------------------------------

def test_source_json_lists_every_input_with_its_pin():
    meta = json.loads((b.SOURCES / "SOURCE.json").read_text())
    files = {f["role"]: f for f in meta["files"]}
    assert set(files) == set(b.INPUTS) | {"overrides", "shen-overrides"}
    for role, spec in b.INPUTS.items():
        f = files[role]
        assert f["file"] == spec["file"] and f["sha256"] == spec["sha256"] and f["rows"] == spec["rows"]
        assert f["retrieved"] and f["url"] and f["mirror"] and f["licence"] and f["citation"]
        data = gzip.decompress((b.SOURCES / f["file"]).read_bytes())
        assert b.sha256(data) == f["sha256"]
    assert files["openngc"]["url"] == ("https://raw.githubusercontent.com/mattiaverga/OpenNGC/"
                                       "36cb178a0f69dba8bfc03a99c10512831edf1c6b/database_files/NGC.csv")
    assert files["sharpless"]["mirror"] in b.VIZIER_MIRRORS
    assert files["overrides"]["kind"] == "committed" and "sha256" not in files["overrides"]
    assert files["shen-overrides"]["kind"] == "committed" and "sha256" not in files["shen-overrides"]
    assert (b.SOURCES / "sh2_ongc_overrides.json").is_file() and (b.SOURCES / "shen_overrides.json").is_file()
    assert files["shen-table2"]["rows"] == 459 and files["shen-tablea1"]["rows"] == 1382
    assert files["shen-table2"]["mirror"] in b.VIZIER_MIRRORS and files["shen-table2"]["retrieved"] == "2026-11-20"
    assert files["shen-table2"]["table"] == "J/A+A/696/A67/table2" and "2503.01551" in files["shen-table2"]["citation"]


def test_vizier_snapshots_have_no_comment_lines():
    for role in b.VIZIER_ROLES:
        data = gzip.decompress((b.SOURCES / b.INPUTS[role]["file"]).read_bytes())
        assert not any(line.startswith(b"#") or line == b"" for line in data.split(b"\n")[:-1])
        assert len(b.parse_vizier(data)) == b.INPUTS[role]["rows"]


def test_vizier_urls_and_mirror_order():
    assert b.VIZIER_MIRRORS == ("vizier.cfa.harvard.edu", "vizier.idia.ac.za", "vizier.cds.unistra.fr")
    u = b.vizier_url("vizier.cfa.harvard.edu", "J/A+A/656/A110/tablea1")
    assert u == ("https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=J%2FA%2BA%2F656%2FA110%2Ftablea1"
                 "&-out.all&-out.max=unlimited")


def _raw_local(tmp: Path, comment: bool = True) -> Path:
    """The committed snapshots as raw downloads (VizieR tables with a `#` header and blank lines)."""
    d = tmp / "raw"
    d.mkdir()
    for role, spec in b.INPUTS.items():
        data = gzip.decompress((b.SOURCES / spec["file"]).read_bytes())
        if role in b.VIZIER_ROLES and comment:
            data = b"#\n#   VizieR Astronomical Server\n#INFO\trequest_date=2030-01-01\n\n" + data
        (d / spec["local"]).write_bytes(data)
    return d


def test_refresh_from_local_raw_files_reproduces_the_snapshots(tmp_path):
    raw = _raw_local(tmp_path)
    out = tmp_path / "sources"
    out.mkdir()
    shutil.copy(b.SOURCES / b.OVERRIDES_FILE, out / b.OVERRIDES_FILE)
    shutil.copy(b.SOURCES / b.SHEN_OVERRIDES_FILE, out / b.SHEN_OVERRIDES_FILE)
    b.refresh(out, raw)
    for f in b.SOURCES.glob("*.gz"):
        assert gzip.decompress((out / f.name).read_bytes()) == gzip.decompress(f.read_bytes())
    meta = json.loads((out / "SOURCE.json").read_text())
    assert {f["role"] for f in meta["files"]} == set(b.INPUTS) | {"overrides", "shen-overrides"}
    assert (out / "LICENSE.md").read_text() == b.license_text("sources")
    # and a build straight from the raw files equals the committed dataset
    b.build(tmp_path / "from_raw", out, raw)
    assert (tmp_path / "from_raw" / "manifest.json").read_bytes()
    assert _tree(tmp_path / "from_raw" / "tiles") == _tree(COMMITTED / "tiles")


def test_a_download_that_differs_from_the_pin_or_is_truncated_is_refused(tmp_path):
    raw = _raw_local(tmp_path)
    f = raw / b.INPUTS["sharpless"]["local"]
    lines = f.read_bytes().split(b"\n")
    f.write_bytes(b"\n".join(lines[:-3]) + b"\n")                     # truncated
    out = tmp_path / "s"
    out.mkdir()
    shutil.copy(b.SOURCES / b.OVERRIDES_FILE, out / b.OVERRIDES_FILE)
    shutil.copy(b.SOURCES / b.SHEN_OVERRIDES_FILE, out / b.SHEN_OVERRIDES_FILE)
    with pytest.raises(SystemExit, match="expected 313 rows"):
        b.refresh(out, raw)
    (tmp_path / "x").mkdir()
    raw2 = _raw_local(tmp_path / "x")
    g = raw2 / b.INPUTS["russeil-table3"]["local"]
    data = g.read_bytes()
    i = data.rindex(b"\t")
    g.write_bytes(data[:i] + b" " + data[i:])                          # changed bytes, same row count
    with pytest.raises(SystemExit, match="differs from the pin"):
        b.refresh(out, raw2)


def test_download_tries_the_mirrors_in_order_and_records_the_one_used(monkeypatch):
    good = (b.SOURCES / b.INPUTS["sharpless"]["file"])
    payload = b"#header\n\n" + gzip.decompress(good.read_bytes())
    calls = []

    def fake(url, timeout=300.0):
        calls.append(url)
        if "cfa.harvard" in url:
            raise RuntimeError("down")
        if "idia" in url:
            return payload[:-50]                                          # truncated: refused
        return payload

    monkeypatch.setattr(b, "_http_get", fake)
    data, url, mirror = b.download("sharpless")
    assert mirror == "vizier.cds.unistra.fr" and [u.split("/")[2] for u in calls] == list(b.VIZIER_MIRRORS)
    assert b.sha256(data) == b.INPUTS["sharpless"]["sha256"]
    monkeypatch.setattr(b, "_http_get", lambda url, timeout=300.0: (_ for _ in ()).throw(RuntimeError("down")))
    with pytest.raises(SystemExit, match="no VizieR mirror"):
        b.download("chornay")
    seen = []
    monkeypatch.setattr(b, "_http_get", lambda url, timeout=300.0: (seen.append(url), b"")[1])
    with pytest.raises(SystemExit):
        b.download("openngc")
    assert seen == [b.OPENNGC_RAW + "NGC.csv"]


def test_a_changed_snapshot_is_refused(tmp_path):
    src = tmp_path / "s"
    shutil.copytree(b.SOURCES, src)
    p = src / b.INPUTS["sharpless"]["file"]
    b.write_gz(p, gzip.decompress(p.read_bytes()) + b"x\n")
    with pytest.raises(SystemExit, match="sha256"):
        b.load_inputs(src, None)


def test_the_overrides_sha256_is_in_the_build_report_and_check_catches_drift(tmp_path, monkeypatch):
    m = json.loads((COMMITTED / "manifest.json").read_text())
    assert m["build"]["report"]["overrides_sha256"] == b.sha256((b.SOURCES / b.OVERRIDES_FILE).read_bytes())
    src = tmp_path / "s"
    shutil.copytree(b.SOURCES, src)
    ov = json.loads((src / b.OVERRIDES_FILE).read_text())
    (src / b.OVERRIDES_FILE).write_text(json.dumps(ov + [{"sh2": 1, "ongc": None, "reason": "test"}]))
    monkeypatch.setattr(sys, "argv", ["x", "--check", "--sources", str(src), "--out", str(COMMITTED)])
    assert b.main() == 1


def test_editing_the_overrides_needs_neither_network_nor_refresh(tmp_path, monkeypatch):
    def no_network(*a, **k):
        raise AssertionError("network used")
    monkeypatch.setattr(b, "_http_get", no_network)
    raw = _raw_local(tmp_path)
    src = tmp_path / "s"
    shutil.copytree(b.SOURCES, src)
    ov = json.loads((src / b.OVERRIDES_FILE).read_text())
    (src / b.OVERRIDES_FILE).write_text(json.dumps(ov + [{"sh2": 1, "ongc": None, "reason": "test edit"}]))
    m = b.build(tmp_path / "out", src, raw)
    assert m["build"]["report"]["overrides_sha256"] == b.sha256((src / b.OVERRIDES_FILE).read_bytes())
    assert st.verify_dataset(tmp_path / "out") == []
    b.build(tmp_path / "out2", src)          # and from the committed snapshots


# --- reproducibility and --check ---------------------------------------------------------------

def _tree(d: Path) -> dict:
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


def test_the_committed_dataset_is_a_byte_identical_rebuild_and_verifies(tmp_path):
    b.build(tmp_path / "again")
    assert _tree(tmp_path / "again") == _tree(COMMITTED)
    assert "LICENSE.md" in _tree(COMMITTED)
    assert st.verify_dataset(COMMITTED) == []


def test_committed_manifest(built):
    m = json.loads((COMMITTED / "manifest.json").read_text())
    assert m["dataset"] == "nebulae" and m["kinds"] == ["nebula"] and m["precedence"] == 50
    assert m["count"] == 697 == m["build"]["report"]["records_written"] and m["src_table"]
    assert m["record_defaults"]["provenance"]["dataset"] == "nebulae"
    assert m["build"]["script"] == "backend/scripts/build_objects_nebulae.py"
    expected = json.loads(json.dumps(dict(built["report"], overrides_sha256=built["loaded"]["overrides_sha256"])))
    expected["shen"]["overrides_sha256"] = built["loaded"]["shen_overrides_sha256"]
    assert m["build"]["report"] == expected
    assert m["tiling"] == {"scheme": "radec-bands", "band_deg": 10}
    assert m["max_extent_deg"] == pytest.approx(10.0)                                   # Barnard's Loop, 20 deg wide
    assert sum(t["count"] for t in m["tiles"].values()) == 697


def test_a_cone_inside_barnards_loop_but_9_degrees_from_its_centre_finds_it():
    ds = st.load_dataset(COMMITTED)
    loop = next(r for t in ds.manifest["tiles"] for r in st._read_tile(ds, t) if r["id"] == "sh2:276")
    ra, dec = loop["position"]["ra"], loop["position"]["dec"]
    assert [r["id"] for r in st.cone_query(ds, ra, dec - 9.0, 0.5) if r["id"] == "sh2:276"] == ["sh2:276"]
    assert not [r for r in st.cone_query(ds, ra, dec - 12.0, 0.5) if r["id"] == "sh2:276"]


def test_cone_at_orion_finds_m42_and_the_dataset_is_cone_servable():
    ds = st.load_dataset(COMMITTED)
    ids = {r["id"] for r in st.cone_query(ds, 83.82, -5.39, 0.5)}
    assert "ongc:NGC1976" in ids and "sh2:276" in ids          # Barnard's Loop is 20 deg wide, Orion is inside it


def test_synthetic_build_is_byte_identical_and_check_passes_then_fails(tmp_path, monkeypatch):
    b.build(tmp_path / "out")
    monkeypatch.setattr(sys, "argv", ["x", "--check", "--out", str(tmp_path / "out")])
    assert b.main() == 0
    # a changed tile
    next((tmp_path / "out" / "tiles").glob("*.json")).write_text("{}")
    assert b.main() == 1
    b.build(tmp_path / "out")
    assert b.main() == 0
    # a changed licence file in the dataset folder
    (tmp_path / "out" / "LICENSE.md").write_text("changed")
    assert b.main() == 1
    b.build(tmp_path / "out")
    (tmp_path / "out" / "LICENSE.md").unlink()
    assert b.main() == 1


def test_check_fails_when_the_sources_licence_is_stale(tmp_path, monkeypatch):
    src = tmp_path / "src"
    shutil.copytree(b.SOURCES, src)
    b.build(tmp_path / "out", src)
    monkeypatch.setattr(sys, "argv", ["x", "--check", "--sources", str(src), "--out", str(tmp_path / "out")])
    assert b.main() == 0
    (src / "LICENSE.md").write_text("old")
    assert b.main() == 1
    (src / "LICENSE.md").unlink()
    assert b.main() == 1


def test_gzip_is_deterministic_and_nameless(tmp_path):
    b.write_gz(tmp_path / "a.gz", b"hello\n" * 100)
    assert (tmp_path / "a.gz").read_bytes()[3] == 0 and (tmp_path / "a.gz").read_bytes()[4:8] == b"\0\0\0\0"


def test_dataset_sizes_stay_small():
    size = sum(p.stat().st_size for p in COMMITTED.rglob("*") if p.is_file())
    assert size < 3_000_000


def test_licence_files_keep_the_gaia_derived_values_under_their_own_terms():
    for folder in (b.SOURCES, COMMITTED):
        text = (folder / "LICENSE.md").read_text(encoding="utf-8")
        assert "59 planetary nebulae" in text and "Gaia EDR3" in text and "CC BY-NC 3.0 IGO" in text
        assert "Credit: ESA/Gaia/DPAC" in text and "not** relicensed by CC BY-SA 4.0" in text
        assert "Shen et al. 2025" in text and "Group I, II and III rows without a maser remark" in text
        assert "are **not** Gaia values" in text and "VLBI maser parallax" in text
        assert "HII-region distances (Shen et al. 2025, Gaia DR3): Credit: ESA/Gaia/DPAC" in text


# --- HII-region distances from Shen et al. 2025 (docs 19.4) ------------------------------------

GAIA_I = ("Shen et al. 2025, A&A 696, A67, table2: G005.987-01.191 (Group I): mean Gaia DR3 (Bailer-Jones et al. "
          "2021) distance of its exciting stars")
MASER = ("VLBI maser parallax of the associated HMSFR, as adopted by Shen et al. 2025 (table2 gives no per-row "
         "reference; §3.2: primarily Reid et al. 2019)")


def shen_row(wise="G005.987-01.191", ra=100.0, dec=10.0, r=120, dist="1.22", lo="0.02", hi="0.02", group="I",
             remarks="", cl="K") -> dict:
    return {"WISE": wise, "Cl": cl, "R": str(r), "Dist": dist, "e_Dist": lo, "E_Dist": hi, "Group": group,
            "Remarks": remarks, "_RA": str(ra), "_DE": str(dec)}


def shen(*rows, stars=()):
    return b.read_shen(list(rows), [{"WISE": w} for w in stars])


def at_shen(row: dict, name="NGC0001", typ="HII", maj="10.00", off_arcmin=0.0) -> dict:
    """An OpenNGC row `off_arcmin` north of a Shen row's centre."""
    return orow(name, typ, hms(float(row["_RA"])), dms(float(row["_DE"]) + off_arcmin / 60.0), MajAx=maj)


def shen_build(ongc_rows, shen_rows, overrides=None, sh=None):
    inp = {"ongc": ongc_rows, "sharpless": sh or [], "chornay": [], "russeil1": [], "russeil3": [],
           "shen2": shen_rows, "shen_a1": []}
    return b.build_records(inp, [], overrides)


def test_shen_parsing_kpc_to_pc_asymmetric_errors_and_the_zero_error_case():
    rows, rep = shen(shen_row(dist="1.36", lo="0.02", hi="0.04"), shen_row("G209.037-19.377", dist="0.39", lo="0.00",
                     hi="0.00", remarks="maser"), shen_row("G001.000+01.000", dist="2.50", lo="0.10", hi="0.00",
                     group="III", remarks="maser,M22"), stars=["G005.987-01.191"] * 3)
    a, o, c = rows
    assert (a["dist"], a["lo"], a["hi"]) == (1360, 1340, 1400) and a["group"] == "I" and a["remarks"] == []
    assert a["stars"] == 3 and a["radius_arcsec"] == 120.0 and (a["ra"], a["dec"]) == (100.0, 10.0)
    assert o["dist"] == 390 and o["lo"] is None and o["hi"] is None and o["maser"] and not o["m22"]
    assert c["remarks"] == ["M22", "maser"] and c["maser"] and c["m22"] and (c["lo"], c["hi"]) == (2400, 2500)
    assert rep == {"table2_rows": 3, "tablea1_rows": 3, "usable_rows": 3, "skipped_rows": []}
    assert b.read_shen([shen_row(dist="")], [])[1]["skipped_rows"] == ["G005.987-01.191"]


def test_shen_src_strings_are_the_exact_shapes_the_frontend_parses():
    q = lambda **kw: b.shen_quantity(b.read_shen([shen_row(**kw)], [])[0][0])   # noqa: E731
    g1 = q()
    assert g1["src"] == GAIA_I and (g1["v"], g1["lo"], g1["hi"], g1["tier"], g1["unit"]) == (1220, 1200, 1240,
                                                                                            "measured", "pc")
    g3 = q(wise="G007.015-00.271", group="III")
    assert g3["src"] == ("Shen et al. 2025, A&A 696, A67, table2: G007.015-00.271 (Group III): Gaia DR3 "
                         "(Bailer-Jones et al. 2021) distance of its exciting star") and g3["tier"] == "inferred"
    assert q(group="II")["src"].endswith("(Group II): Gaia DR3 (Bailer-Jones et al. 2021) distance of its exciting star")
    m22 = q(remarks="M22")
    assert m22["src"] == GAIA_I + " (value from Méndez-Delgado et al. 2022, Gaia DR3)" and m22["tier"] == "measured"
    ms = q(wise="G209.037-19.377", dist="0.39", lo="0.00", hi="0.00", remarks="maser")
    assert ms["src"] == (f"Shen et al. 2025, A&A 696, A67, table2: G209.037-19.377 (Group I): {MASER}; uncertainty "
                         "below the table's 0.01 kpc precision")
    assert "Gaia" not in ms["src"] and "lo" not in ms and "hi" not in ms and ms["tier"] == "measured"
    both = q(remarks="maser,M22", group="III")        # a maser row is never labelled Gaia, whatever the group
    assert "Gaia" not in both["src"] and "Méndez" not in both["src"] and both["tier"] == "measured"
    assert q(lo="0.00", hi="0.00")["src"] == GAIA_I + "; uncertainty below the table's 0.01 kpc precision"
    assert q(remarks="M22", lo="0.00", hi="0.00")["src"] == (GAIA_I + " (value from Méndez-Delgado et al. 2022, "
                                                              "Gaia DR3); uncertainty below the table's 0.01 kpc "
                                                              "precision")


@pytest.mark.parametrize("typ,linked", [("HII", True), ("EmN", True), ("Neb", True), ("Cl+N", True), ("SNR", False),
                                        ("RfN", False), ("DrkN", False)])
def test_the_link_rule_applies_to_the_russeil_types_and_never_to_snr_rfn_drkn(typ, linked):
    w = shen_row()
    recs, rep = shen_build([at_shen(w, "NGC0001", typ)], [w])
    assert (recs[0]["position"]["dist"] is not None) is linked
    assert rep["shen"]["links"] == int(linked) and objects.validate_record(recs[0]) == []


def test_a_pn_is_never_linked_and_a_sharpless_only_region_is_eligible():
    s1 = b.read_sharpless([srow(1, diam="20")])[0]
    w = shen_row(ra=s1["_ra"], dec=s1["_dec"])
    recs, rep = shen_build([at_shen(w, "NGC0001", "PN")], [w], sh=[srow(1, diam="20")])
    by = {r["id"]: r for r in recs}
    assert by["ongc:NGC0001"]["position"]["dist"] is None
    assert by["sh2:1"]["position"]["dist"]["v"] == 1220 and by["sh2:1"]["position"]["method"] == "bailer-jones"
    assert by["sh2:1"]["size"]["radius"]["v"] > 0 and by["sh2:1"]["evidence"] == "measured"


def test_the_120_arcmin_guard_and_the_separation_rule():
    w = shen_row(r=60)                                   # R_W = 1 arcmin
    # major 119' links (r_N = 59.5'); 120' is excluded
    recs, rep = shen_build([at_shen(w, "NGC0001", maj="119.00", off_arcmin=30.0),
                            at_shen(w, "NGC0002", maj="120.00", off_arcmin=30.0)], [w])
    by = {r["id"]: r for r in recs}
    assert by["ongc:NGC0001"]["position"]["dist"] is not None and by["ongc:NGC0002"]["position"]["dist"] is None
    assert rep["shen"]["excluded_major_ge_120_arcmin"] == ["ongc:NGC0002"]
    # s <= max(r_N, R_W): R_W wins for a tiny record, r_N for a big one
    recs, _ = shen_build([at_shen(w, "NGC0003", maj="0.50", off_arcmin=0.9), at_shen(w, "NGC0004", maj="0.50",
                          off_arcmin=1.1), at_shen(w, "NGC0005", maj="10.00", off_arcmin=4.9),
                          at_shen(w, "NGC0006", maj="10.00", off_arcmin=5.1)], [w])
    assert [r["position"]["dist"] is not None for r in recs] == [True, False, True, False]


def test_best_candidate_by_score_then_separation_then_wise_name():
    near, far = shen_row("G100.000+00.000", 100.0, 10.0, r=300, dist="1.00"), shen_row("G100.100+00.000", 100.0,
                                                                                        10.0 + 2 / 60, r=300,
                                                                                        dist="2.00")
    n = at_shen(near, maj="10.00")
    recs, rep = shen_build([n], [far, near])
    link = rep["shen"]["link_rows"][0]
    assert recs[0]["position"]["dist"]["v"] == 1000 and link["wise"] == "G100.000+00.000"
    assert link["score"] == 0.0 and link["rule"] == "rule" and link["new_pc"] == 1000 and link["old_pc"] is None
    assert [c["wise"] for c in link["other_candidates"]] == ["G100.100+00.000"]
    assert link["other_candidates"][0]["dist_pc"] == 2000 and link["winner"] == "shen"
    # an exact tie on score and separation goes to the smaller WISE name
    a, c = shen_row("G200.000+00.000", dist="1.00"), shen_row("G100.000+00.000", dist="2.00")
    recs, rep = shen_build([at_shen(a)], [a, c])
    assert rep["shen"]["link_rows"][0]["wise"] == "G100.000+00.000"


def test_one_shen_row_serves_several_records():
    w = shen_row(ra=97.9, dec=4.9, r=900, dist="1.36", lo="0.02", hi="0.04")
    names = ["NGC2237", "NGC2238", "NGC2239", "NGC2246"]
    recs, rep = shen_build([at_shen(w, n, off_arcmin=i) for i, n in enumerate(names)], [w])
    assert [r["position"]["dist"]["v"] for r in recs] == [1360] * 4
    assert [l["wise"] for l in rep["shen"]["link_rows"]] == ["G005.987-01.191"] * 4


def test_shen_overrides_win_and_null_forbids():
    w, other = shen_row(dist="1.22"), shen_row("G999.000+00.000", ra=150.0, dec=-20.0, dist="3.33")
    n = at_shen(w)
    ov = [{"nebula": "ongc:NGC0001", "wise": "G999.000+00.000", "reason": "test"}]
    recs, rep = shen_build([n], [w, other], ov)
    link = rep["shen"]["link_rows"][0]
    assert recs[0]["position"]["dist"]["v"] == 3330 and link["rule"] == "override" and link["score"] is None
    recs, rep = shen_build([n], [w, other], [{"nebula": "ongc:NGC0001", "wise": None, "reason": "no"}])
    assert recs[0]["position"]["dist"] is None and rep["shen"]["links"] == 0 and rep["shen"]["overrides"] == 1
    for bad in ([{"nebula": "ongc:NGC9", "wise": None, "reason": "x"}],
                [{"nebula": "ongc:NGC0001", "wise": "G0", "reason": "x"}],
                [{"nebula": "ongc:NGC0001", "wise": None}]):
        with pytest.raises(SystemExit):
            shen_build([n], [w, other], bad)
    assert json.loads((b.SOURCES / b.SHEN_OVERRIDES_FILE).read_text()) == []


@pytest.mark.parametrize("group,remarks,method,tier,evidence", [
    ("I", "", "bailer-jones", "measured", "measured"), ("I", "M22", "bailer-jones", "measured", "measured"),
    ("II", "", "bailer-jones", "inferred", "derived"), ("III", "M22", "bailer-jones", "inferred", "derived"),
    ("I", "maser", "parallax", "measured", "measured"), ("III", "maser", "parallax", "measured", "measured"),
    ("II", "maser,M22", "parallax", "measured", "measured")])
def test_evidence_by_group_and_remark(group, remarks, method, tier, evidence):
    w = shen_row(group=group, remarks=remarks)
    r = shen_build([at_shen(w)], [w])[0][0]
    assert (r["position"]["method"], r["position"]["dist"]["tier"], r["evidence"]) == (method, tier, evidence)
    assert objects.validate_record(r) == [] and r["position"]["tier"] == "catalogue"
    assert r["size"]["radius"]["tier"] == "inferred"


def _with_russeil(w_kwargs):
    """The Russeil test region (1500 +- 200 pc, derived, fractional 0.133) with a Shen row on top of it."""
    inp = russeil_inputs(["HII"])
    o = inp["ongc"][0]
    ra, dec = b.sexagesimal(o["RA"], hours=True), b.sexagesimal(o["Dec"], hours=False)
    inp["shen2"] = [shen_row(ra=ra, dec=dec, r=300, **w_kwargs)]
    inp["shen_a1"] = []
    recs, rep = b.build_records(inp, [], [])
    return next(r for r in recs if r["id"] == "ongc:NGC0001"), rep


def test_the_ladder_a_measured_shen_distance_beats_russeil_even_with_a_bigger_interval():
    r, rep = _with_russeil({"dist": "1.20", "lo": "0.90", "hi": "0.90"})
    assert r["position"]["dist"]["v"] == 1200 and r["evidence"] == "measured"
    alt, = r["alt_distances"]
    assert alt["method"] == "photometric" and alt["dist"]["v"] == 1500 and alt["dist"]["tier"] == "inferred"
    assert alt["reason"] == "not used: a derived distance; a measured one exists"
    assert objects.validate_record(r) == []
    assert rep["shen"]["russeil_replaced"] == 1 and rep["shen"]["direction_only_placed"] == 0
    link = rep["shen"]["link_rows"][0]
    assert (link["old_pc"], link["new_pc"], link["winner"]) == (1500, 1200, "shen")


def test_the_ladder_two_derived_distances_the_smaller_fractional_uncertainty_wins_both_ways():
    # Group III 0.45 +- 0.04 kpc (8.9 %) against Russeil's 13.3 %: Shen wins, Russeil goes to alt_distances
    r, rep = _with_russeil({"dist": "1.50", "lo": "0.05", "hi": "0.05", "group": "III"})
    assert r["position"]["method"] == "bailer-jones" and r["evidence"] == "derived"
    assert r["alt_distances"][0]["reason"] == "not used: larger uncertainty than the Shen et al. 2025 distance"
    assert r["alt_distances"][0]["dist"]["v"] == 1500 and r["alt_distances"][0]["method"] == "photometric"
    # a wider Shen interval (20 %): Russeil keeps the record and Shen is the alternative
    r, rep = _with_russeil({"dist": "1.10", "lo": "0.22", "hi": "0.22", "group": "III"})
    assert r["position"]["method"] == "photometric" and r["position"]["dist"]["v"] == 1500
    alt, = r["alt_distances"]
    assert alt["method"] == "bailer-jones" and alt["dist"]["v"] == 1100 and alt["dist"]["tier"] == "inferred"
    assert alt["reason"] == "not used: larger uncertainty than the Russeil 2003 distance"
    assert objects.validate_record(r) == []
    assert rep["shen"]["russeil_replaced"] == 0 and rep["shen"]["russeil_kept"] == 1
    assert rep["shen"]["russeil_kept_by_reason"] == {
        "Shen row linked, lost on the ladder: larger uncertainty than the Russeil 2003 distance": 1}
    # a derived Shen distance without an interval loses to Russeil's, which has one
    r, _ = _with_russeil({"dist": "1.10", "lo": "0.00", "hi": "0.00", "group": "II"})
    assert r["position"]["method"] == "photometric"
    assert r["alt_distances"][0]["reason"] == "not used: no published uncertainty, the Russeil 2003 distance has one"
    # ties on everything go to Shen (catalogue order)
    cands = [b.candidate("russeil", "photometric", objects.quantity(1000, "r", "inferred", "pc", 900, 1100)),
             b.candidate("shen", "bailer-jones", objects.quantity(1000, "s", "inferred", "pc", 900, 1100))]
    best, alts = b.choose(cands)
    assert best["cat"] == "shen" and alts[0]["method"] == "photometric"


def test_a_pn_parallax_still_wins_over_both():
    inp = russeil_inputs(["HII"])
    inp["ongc"][0].update(Type="PN", Identifiers="PN G063.1+13.9")
    inp["chornay"] = [crow()]
    o = inp["ongc"][0]
    inp["shen2"] = [shen_row(ra=b.sexagesimal(o["RA"], hours=True), dec=b.sexagesimal(o["Dec"], hours=False), r=300)]
    recs, rep = b.build_records(inp, [{"sh2": 1, "ongc": "NGC0001", "reason": "test"}], [])
    r = next(x for x in recs if x["id"] == "ongc:NGC0001")
    assert r["position"]["method"] == "parallax" and r["position"]["dist"]["src"].startswith("Chornay")
    assert "alt_distances" not in r and rep["shen"]["links"] == 0


# --- the snapshot, with Shen ---------------------------------------------------------------------

def test_orion_m8_rosette_trifid_eagle_on_the_snapshot(built):
    recs = built["records"]
    d = lambda rid: recs[rid]["position"]["dist"]   # noqa: E731
    o = d("ongc:NGC1976")
    assert (o["v"], o["tier"]) == (390, "measured") and "lo" not in o and "hi" not in o
    assert recs["ongc:NGC1976"]["position"]["method"] == "parallax" and recs["ongc:NGC1976"]["evidence"] == "measured"
    assert o["src"] == ("Shen et al. 2025, A&A 696, A67, table2: G209.037-19.377 (Group I): " + MASER +
                        "; uncertainty below the table's 0.01 kpc precision")
    assert "Gaia" not in o["src"]
    assert [(a["method"], a["dist"]["v"]) for a in recs["ongc:NGC1976"]["alt_distances"]] == [("photometric", 400)]
    m8 = d("ongc:NGC6523")
    assert (m8["v"], m8["lo"], m8["hi"], m8["tier"]) == (1220, 1200, 1240, "measured")
    assert "G005.987-01.191 (Group I)" in m8["src"] and "Méndez-Delgado et al. 2022" in m8["src"]
    assert recs["ongc:NGC6523"]["position"]["method"] == "bailer-jones"
    for rid in ("ongc:NGC2237", "ongc:NGC2238", "ongc:NGC2239", "ongc:NGC2246"):
        r = d(rid)
        assert (r["v"], r["lo"], r["hi"], r["tier"]) == (1360, 1340, 1400, "measured"), rid
        assert "G206.316-02.103 (Group I)" in r["src"]
    trifid, eagle = d("ongc:NGC6514"), d("ongc:IC4703")
    assert (trifid["v"], trifid["lo"], trifid["hi"]) == (1240, 1210, 1280)
    assert (eagle["v"], eagle["lo"], eagle["hi"]) == (1720, 1710, 1730)
    assert recs["ongc:IC4703"]["evidence"] == "measured" and recs["ongc:IC4703"]["size"]["radius"]["v"] > 0


def test_the_crab_and_the_pne_are_unchanged_by_shen(built):
    recs = built["records"]
    assert recs["ongc:NGC1952"]["position"]["dist"] is None and "alt_distances" not in recs["ongc:NGC1952"]
    pne = [r for r in recs.values() if r["props"]["type"]["v"] == "Planetary nebula"]
    assert len(pne) == 130
    for r in pne:
        assert "alt_distances" not in r
        d = r["position"]["dist"]
        assert d is None or (r["position"]["method"] == "parallax" and d["src"].startswith("Chornay & Walton 2021"))
    for r in recs.values():
        if r["props"]["type"]["v"] in ("Supernova remnant", "Reflection nebula", "Dark nebula"):
            assert r["position"]["dist"] is None


def test_every_maser_src_has_no_gaia_and_every_gaia_src_names_gaia_dr3(built):
    seen = set()
    for r in built["records"].values():
        d = r["position"]["dist"]
        if d is None or not d["src"].startswith("Shen"):
            continue
        if r["position"]["method"] == "parallax":
            assert "Gaia" not in d["src"] and "VLBI maser parallax of the associated HMSFR" in d["src"]
            seen.add("maser")
        else:
            assert r["position"]["method"] == "bailer-jones" and "Gaia DR3 (Bailer-Jones et al. 2021)" in d["src"]
            seen.add("gaia")
        assert d["tier"] == ("measured" if r["evidence"] == "measured" else "inferred")
        assert objects.validate_record(r) == []
    assert seen == {"maser", "gaia"}


def test_the_shen_report_counts_on_the_snapshot(built):
    sh = built["report"]["shen"]
    assert (sh["table2_rows"], sh["tablea1_rows"], sh["usable_rows"], sh["skipped_rows"]) == (459, 1382, 459, [])
    assert sh["links"] == len(sh["link_rows"]) == 146 and sh["adopted"] == 141
    assert sh["adopted_by_group"] == {"I": 76, "II": 10, "III": 55}
    assert sh["adopted_by_remark"] == {"(blank)": 97, "M22": 26, "M22,maser": 5, "maser": 13}
    assert (sh["russeil_replaced"], sh["direction_only_placed"], sh["russeil_kept"]) == (71, 70, 77)
    assert sh["russeil_replaced"] + sh["direction_only_placed"] == sh["adopted"]
    assert sh["russeil_kept_by_reason"] == {
        "Shen row linked, lost on the ladder: larger uncertainty than the Russeil 2003 distance": 5,
        "no Shen region within the link rule": 54, "record major axis >= 120 arcmin (not linked)": 18}
    assert len(sh["excluded_major_ge_120_arcmin"]) == 40 and "sh2:276" in sh["excluded_major_ge_120_arcmin"]
    assert sh["replaced_change"] == {"median": -0.1435, "median_abs": 0.2217, "over_20pct": 40, "over_50pct": 9}
    big = {c["id"]: c for c in sh["changes_over_50pct"]}
    assert len(big) == 9 and big["ongc:NGC6514"]["group"] == "I" and big["sh2:135"]["group"] == "II"
    assert all(abs(c["change"]) > 0.5 and c["group"] in ("I", "II", "III") for c in big.values())
    # every link row carries what a reviewer needs
    for l in sh["link_rows"]:
        assert set(l) == {"id", "name", "wise", "group", "remarks", "rule", "score", "sep_arcmin", "shen_pc",
                          "other_candidates", "old_pc", "new_pc", "winner"}
    orion = next(l for l in sh["link_rows"] if l["id"] == "ongc:NGC1976")
    assert (orion["wise"], orion["old_pc"], orion["new_pc"], orion["winner"]) == ("G209.037-19.377", 400, 390, "shen")
    committed = json.loads((COMMITTED / "manifest.json").read_text())["build"]["report"]["shen"]
    assert committed["overrides_sha256"] == b.sha256((b.SOURCES / b.SHEN_OVERRIDES_FILE).read_bytes())


def test_the_shen_snapshots_are_pinned_and_unmodified():
    for role, rows in (("shen-table2", 459), ("shen-tablea1", 1382)):
        data = gzip.decompress((b.SOURCES / b.INPUTS[role]["file"]).read_bytes())
        assert b.sha256(data) == b.INPUTS[role]["sha256"] and not data.startswith(b"#") and b"\n#" not in data
        assert len(b.parse_vizier(data)) == rows
    t2 = b.parse_vizier(gzip.decompress((b.SOURCES / "shen2025-table2.tsv.gz").read_bytes()))
    assert Counter_remarks(t2) == {"": 407, "M22": 30, "maser": 19, "maser,M22": 3}


def Counter_remarks(rows):
    from collections import Counter
    return dict(Counter(r["Remarks"] for r in rows))
