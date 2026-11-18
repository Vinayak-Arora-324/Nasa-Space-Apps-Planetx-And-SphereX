"""Offline tests for backend/scripts/build_objects_nea.py: synthetic pscomppars rows, injected Gaia side
inputs (no network), the committed dataset and the section 16.13 example records."""

from __future__ import annotations

import importlib.util
import json
import math
import sys
from pathlib import Path

import pytest

from spherex_app import objects, objects_static as st

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "backend" / "scripts" / "build_objects_nea.py"
COMMITTED = ROOT / "frontend" / "data" / "objects" / "nea-exoplanets"
EXAMPLES = Path(__file__).parent / "fixtures" / "objects" / "examples"


def _script():
    spec = importlib.util.spec_from_file_location("build_objects_nea", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["build_objects_nea"] = mod
    spec.loader.exec_module(mod)
    return mod


b = _script()
PROV = b.provenance("2026-11-18")


def link(text: str, calc: bool = False) -> str:
    if calc:
        return '<a refstr=CALCULATED_VALUE href=/docs/pscp_calc.html target=_blank>Calculated Value</a>'
    return f'<a refstr=X href=https://example.org/abs target=ref> {text} </a>'


def row(name: str = "Test b", host: str = "Test", **kw) -> dict:
    """A pscomppars row with a transiting planet on a 10 d orbit around a Sun-like star."""
    r = {c: "" for c in b.COLUMNS}
    r.update(pl_name=name, hostname=host, pl_letter=name.split()[-1], ra="100.5", dec="-20.25",
             discoverymethod="Transit", disc_year="2010", disc_facility="Test Observatory",
             sy_pnum="1", pl_controv_flag="0", gaia_dr3_id="Gaia DR3 1234567890",
             sy_dist="50.0", sy_disterr1="0.5", sy_disterr2="-0.4", sy_dist_reflink=link("Gaia DR3"),
             sy_plx="20.0", sy_vmag="11.5", sy_vmag_reflink=link("TICv8"),
             pl_orbper="10.0", pl_orbpererr1="0.001", pl_orbpererr2="-0.002", pl_orbper_reflink=link("Aa 2020"),
             pl_orbsmax="0.1", pl_orbsmax_reflink=link("Aa 2020"),
             pl_orbeccen="0.1", pl_orbeccenerr1="0.02", pl_orbeccenerr2="-0.02", pl_orbeccen_reflink=link("Bb 2019"),
             pl_bmassj="1.5", pl_bmassjerr1="0.1", pl_bmassjerr2="-0.2", pl_bmassj_reflink=link("Aa 2020"),
             pl_bmassprov="Mass", pl_rade="12.0", pl_radeerr1="0.5", pl_radeerr2="-0.5",
             pl_rade_reflink=link("Aa 2020"), pl_radelim="0", st_mass="1.0", st_mass_reflink=link("Aa 2020"),
             st_rad="1.0", st_rad_reflink=link("Aa 2020"), st_teff="5800", st_teff_reflink=link("Aa 2020"))
    r.update(kw)
    return r


def planet(host_id: str = "gdr3:1234567890", mstar: float | None = 1.0, **kw) -> dict:
    return b.planet_record(row(**kw), host_id, mstar, PROV)


def build_records(rows, dr2=(), pos=()):
    return b.build_records(list(rows), list(dr2), list(pos), "2026-11-18")


# --- reference text ---------------------------------------------------------------------------

def test_reflink_text_is_the_anchor_text_with_entities_decoded():
    assert b.reflink_text('<a refstr=A href=http://x/?a=1&amp;b=2 target=ref> Agol et al. 2021 </a>') == "Agol et al. 2021"
    assert b.reflink_text('<a href=x>Naef &amp; Mayor 2004</a>') == "Naef & Mayor 2004"
    assert b.reflink_text('<a href=x>L&oacute;pez&nbsp;et  al.\n2020</a>') == "López et al. 2020"
    assert b.reflink_text('<a href=x><i>Kepler</i> Team</a>') == "Kepler Team"
    assert b.reflink_text("") == "" and b.reflink_text(None) == "" and b.reflink_text("plain text") == ""
    assert b.is_calculated(link("", calc=True)) and not b.is_calculated(link("Aa 2020"))


def test_quantity_src_names_the_reference():
    p = planet(pl_orbper_reflink=link("Agol &amp; Co. 2021"))
    assert p["position"]["elements"]["period_d"]["src"] == "NEA pscomppars: Agol & Co. 2021"
    p = planet(pl_orbper_reflink="")
    assert p["position"]["elements"]["period_d"]["src"] == "NEA pscomppars"


# --- intervals and numbers --------------------------------------------------------------------

def test_intervals_are_v_plus_err2_and_v_plus_err1_without_float_noise():
    el = planet()["position"]["elements"]
    assert el["period_d"] == {"v": 10.0, "lo": 9.998, "hi": 10.001, "unit": "d",
                              "src": "NEA pscomppars: Aa 2020", "tier": "measured"}
    q = b.quantity(row(pl_orbsmax="0.01154", pl_orbsmaxerr1="0.0001", pl_orbsmaxerr2="-0.0001"),
                   "pl_orbsmax", tier="catalogue")
    assert (q["lo"], q["hi"]) == (0.01144, 0.01164)


def test_one_sided_and_zero_errors():
    only1 = b.quantity(row(pl_orbincl="80", pl_orbinclerr1="3", pl_orbinclerr2=""), "pl_orbincl", tier="measured")
    assert (only1["lo"], only1["hi"]) == (77, 83)
    only2 = b.quantity(row(pl_orbincl="80", pl_orbinclerr1="", pl_orbinclerr2="-3"), "pl_orbincl", tier="measured")
    assert (only2["lo"], only2["hi"]) == (77, 83)
    zero = b.quantity(row(pl_orblper="0", pl_orblpererr1="0", pl_orblpererr2="0"), "pl_orblper", tier="measured")
    assert "lo" not in zero and "hi" not in zero
    assert b.quantity(row(), "pl_orbincl", tier="measured") is None


def test_times_are_mjd_with_exact_decimal_arithmetic():
    el = planet(pl_tranmid="2457322.51419300", pl_tranmiderr1="0.0000030", pl_tranmiderr2="-0.0000030",
                pl_orbtper="2452497.0", pl_orbtpererr1="0.022", pl_orbtpererr2="-0.022")["position"]["elements"]
    assert (el["t_conj_mjd"]["v"], el["t_conj_mjd"]["lo"], el["t_conj_mjd"]["hi"]) == \
        (57322.014193, 57322.01419, 57322.014196)
    assert "unit" not in el["t_conj_mjd"] and el["t_peri_mjd"]["v"] == 52496.5


# --- elements, assumptions and derivations ----------------------------------------------------

def test_a_known_orbit_has_unknown_node_so_the_placement_is_illustrative():
    p = planet(pl_orbincl="89.7", pl_orbtper="2452497.0")
    pos = p["position"]
    assert pos["model"] == "orbit" and pos["elements"]["node_deg"] is None
    assert pos["tier"] == "illustrative" and p["evidence"] == "illustrative"
    assert pos["src"] == "NASA Exoplanet Archive pscomppars; orientation on the sky (node) unknown"
    assert pos["host_radec"] == [100.5, -20.25]
    assert objects.validate_record(p) == []


def test_phase_known_iff_a_conjunction_or_periastron_time_exists():
    assert planet()["position"]["phase_known"] is False
    assert planet(pl_tranmid="2457322.5")["position"]["phase_known"] is True
    assert planet(pl_orbtper="2452497.0")["position"]["phase_known"] is True
    assert planet(pl_tranmid="2457322.5")["position"]["elements"]["t_peri_mjd"] is None


def test_missing_i_omega_and_times_are_null():
    el = planet()["position"]["elements"]
    assert el["i_deg"] is None and el["omega_deg"] is None and el["t_peri_mjd"] is None
    assert el["t_conj_mjd"] is None and el["node_deg"] is None


def test_missing_eccentricity_is_zero_and_illustrative():
    e = planet(pl_orbeccen="", pl_orbeccenerr1="", pl_orbeccenerr2="")["position"]["elements"]["e"]
    assert e == {"v": 0, "src": "assumed circular (no eccentricity in the archive)", "tier": "illustrative"}
    assert planet()["position"]["elements"]["e"]["tier"] == "measured"


def test_negative_lower_bounds_of_non_negative_quantities_are_clamped_and_counted():
    e = planet(pl_orbeccen="0.01", pl_orbeccenerr1="0.03", pl_orbeccenerr2="-0.03")["position"]["elements"]["e"]
    assert e["lo"] == 0 and e["hi"] == 0.04
    b.CLAMPED.clear()
    p = planet(pl_bmassj="0.1", pl_bmassjerr1="0.3", pl_bmassjerr2="-0.3", pl_rade="1", pl_radeerr1="2",
               pl_radeerr2="-2", pl_orbper="5", pl_orbpererr1="6", pl_orbpererr2="-6",
               pl_orbsmax="0.1", pl_orbsmaxerr1="0.2", pl_orbsmaxerr2="-0.2")
    assert p["props"]["mass"]["lo"] == 0 and p["size"]["radius"]["lo"] == 0
    assert p["position"]["elements"]["period_d"]["lo"] == 0 and p["position"]["elements"]["a_au"]["lo"] == 0
    assert dict(b.CLAMPED) == {"pl_bmassj": 1, "pl_rade": 1, "pl_orbper": 1, "pl_orbsmax": 1}
    # an angle is not non-negative: its interval is left alone
    i = b.quantity(row(pl_orbincl="2", pl_orbinclerr1="5", pl_orbinclerr2="-5"), "pl_orbincl", tier="measured")
    assert i["lo"] == -3
    s = star(sy_dist="1", sy_disterr1="2", sy_disterr2="-2", st_mass="0.1", st_masserr1="0.2", st_masserr2="-0.2",
             st_teff="100", st_tefferr1="200", st_tefferr2="-200", st_rad="0.1", st_raderr1="0.2", st_raderr2="-0.2")
    assert s["position"]["dist"]["lo"] == 0 and s["props"]["mass"]["lo"] == 0 and s["props"]["teff"]["lo"] == 0
    assert s["size"]["radius"]["lo"] == 0


def test_whole_number_values_are_written_without_a_decimal_point():
    s = star(st_teff="2566.00", st_tefferr1="26.00", st_tefferr2="-26.00")
    assert s["props"]["teff"]["v"] == 2566 and isinstance(s["props"]["teff"]["v"], int)
    assert json.dumps(s["props"]["teff"]).count(".") == 0


# --- limit flags (1 upper, -1 lower): never presented as a measurement -------------------------

def test_an_upper_limit_on_e_is_a_circular_illustrative_orbit_with_the_bound_in_hi():
    e = planet(pl_orbeccen="0.0063", pl_orbeccenlim="1", pl_orbeccenerr1="", pl_orbeccenerr2="",
               pl_orbeccen_reflink=link("Cont et al. 2026"))["position"]["elements"]["e"]
    assert e == {"v": 0, "hi": 0.0063, "src": "NEA pscomppars: upper limit e < 0.0063 (Cont et al. 2026); drawn circular",
                 "tier": "illustrative"}


def test_a_lower_limit_on_e_is_also_drawn_circular_without_an_upper_bound():
    e = planet(pl_orbeccen="0.3", pl_orbeccenlim="-1")["position"]["elements"]["e"]
    assert e["v"] == 0 and e["tier"] == "illustrative" and "hi" not in e
    assert e["src"].startswith("NEA pscomppars: lower limit e > 0.3 (Bb 2019)") and e["src"].endswith("drawn circular")


def test_a_limit_flag_of_zero_in_any_spelling_is_a_value():
    for flag in ("0", "0.00000000000000e+00", ""):
        assert planet(pl_orbeccenlim=flag)["position"]["elements"]["e"]["tier"] == "measured"


@pytest.mark.parametrize("col,lim,key", [("pl_orbincl", "pl_orbincllim", "i_deg"),
                                         ("pl_orblper", "pl_orblperlim", "omega_deg")])
def test_a_limit_on_inclination_or_omega_leaves_the_element_null(col, lim, key):
    p = planet(**{col: "80", lim: "-1"})
    assert p["position"]["elements"][key] is None
    assert planet(**{col: "80", lim: "0"})["position"]["elements"][key]["v"] == 80


def test_a_limit_on_an_epoch_is_a_missing_epoch():
    p = planet(pl_tranmid="2457322.5", pl_tranmidlim="1", pl_orbtper="2452497.0", pl_orbtperlim="-1")
    el = p["position"]["elements"]
    assert el["t_conj_mjd"] is None and el["t_peri_mjd"] is None and p["position"]["phase_known"] is False


def test_a_limit_on_a_or_p_is_missing_so_kepler_iii_applies():
    el = planet(pl_orbsmax="9.0", pl_orbsmaxlim="-1", pl_orbper="365.25")["position"]["elements"]
    assert el["a_au"]["tier"] == "inferred" and el["a_au"]["v"] == pytest.approx(1.0)
    el = planet(pl_orbper="9999", pl_orbperlim="-1", pl_orbsmax="1.0")["position"]["elements"]
    assert el["period_d"]["tier"] == "inferred" and el["period_d"]["v"] == pytest.approx(365.25)


def test_a_limit_on_the_only_a_or_p_excludes_the_planet():
    assert b.exclusion_reason(row(pl_orbper="9999", pl_orbperlim="-1", pl_orbsmax="", pl_orbsmaxlim="")) == \
        "no orbital period and no semi-major axis"
    assert b.exclusion_reason(row(pl_orbper="", pl_orbsmax="1", pl_orbsmaxlim="1")) is not None
    assert b.exclusion_reason(row(pl_orbper="9999", pl_orbperlim="-1")) is None   # a is there


def test_a_limit_on_the_stellar_mass_means_no_stellar_mass_for_kepler():
    a = planet(pl_orbsmax="", pl_orbper="365.25", mstar=None)["position"]["elements"]["a_au"]
    recs, _ = build_records([row(pl_orbsmax="", pl_orbper="365.25", st_mass="0.5", st_masslim="1")])
    p = next(r for r in recs if r["kind"] == "exoplanet")
    assert p["position"]["elements"]["a_au"]["tier"] == "illustrative" and a["tier"] == "illustrative"
    assert next(r for r in recs if r["kind"] == "star")["props"]["mass"]["v"] == "< 0.5"


def test_limits_on_card_only_quantities_are_strings_with_unit_and_tier_and_no_interval():
    p = planet(pl_bmassprov="Msini", pl_bmassj="0.12", pl_bmassjlim="1")
    assert p["props"]["msini"] == {"v": "< 0.12", "unit": "Mjup", "src": "NEA pscomppars: Aa 2020", "tier": "measured"}
    m = planet(pl_bmassprov="Mass", pl_bmassj="3.1", pl_bmassjlim="-1")["props"]["mass"]
    assert m == {"v": "> 3.1", "unit": "Mjup", "src": "NEA pscomppars: Aa 2020", "tier": "measured"}
    mr = planet(pl_bmassprov="M-R relationship", pl_bmassj="3", pl_bmassjlim="1",
                pl_bmassj_reflink=link("", calc=True))["props"]["mass"]
    assert mr["v"] == "< 3" and mr["tier"] == "inferred" and "Chen & Kipping" in mr["src"] and "lo" not in mr
    r = planet(pl_rade="1.5", pl_radelim="1", pl_radeerr1="", pl_radeerr2="")["size"]["radius"]
    assert r == {"v": "< 1.5", "unit": "Rearth", "src": "NEA pscomppars: Aa 2020", "tier": "measured"}
    rc = planet(pl_rade="1.5", pl_radelim="-1", pl_rade_reflink=link("", calc=True))["size"]["radius"]
    assert rc["v"] == "> 1.5" and rc["tier"] == "inferred"


def test_limits_on_star_props_are_strings_and_a_limited_vmag_gives_no_render_mag():
    s = star(st_teff="3000", st_tefflim="1", st_rad="0.3", st_radlim="-1", st_mass="0.2", st_masslim="1",
             sy_vmag="18", sy_vmaglim="1")
    assert s["props"]["teff"] == {"v": "< 3000", "unit": "K", "src": "NEA pscomppars: Aa 2020", "tier": "catalogue"}
    assert s["size"]["radius"]["v"] == "> 0.3" and s["props"]["mass"]["v"] == "< 0.2"
    assert s["props"]["vmag"]["v"] == "< 18" and s["render"] == {}
    assert planet(sy_vmag="18", sy_vmaglim="1")["render"] == {}
    assert objects.validate_record(s) == []


def test_a_limit_on_the_parallax_or_distance_is_not_a_measurement():
    s = star(sy_plx="2", sy_plxlim="1")
    assert s["position"]["method"] == "assumed" and s["position"]["dist"]["tier"] == "illustrative"
    s = star(sy_dist="40", sy_distlim="1", sy_plx="")
    assert s["position"]["dist"] is None and s["position"]["tier"] == "catalogue"


def test_limit_flagged_values_are_counted_per_column_in_the_report():
    rows = [row("A b", "A", pl_orbeccen="0.1", pl_orbeccenlim="1"), row("A c", "A", pl_orbeccenlim="-1"),
            row("B b", "B", pl_bmassj="1", pl_bmassjlim="1", st_masslim="1")]
    _, rep = build_records(rows)
    assert rep["limit_flags"] == {"pl_bmassjlim": {"lower": 0, "upper": 1},
                                  "pl_orbeccenlim": {"lower": 1, "upper": 1},
                                  "st_masslim": {"lower": 0, "upper": 1}}   # host columns: once per host
    _, rep = build_records([row()])
    assert rep["limit_flags"] == {}


def test_clamped_lower_bounds_are_counted_in_the_report():
    _, rep = build_records([row("A b", "A", pl_bmassj="0.1", pl_bmassjerr1="0.3", pl_bmassjerr2="-0.3")])
    assert rep["lower_bounds_clamped_to_zero"] == {"total": 1, "by_column": {"pl_bmassj": 1}}


def test_missing_a_comes_from_kepler_iii_as_inferred():
    # 1 Msun and P = 365.25 d: a = 1 au exactly
    a = planet(pl_orbsmax="", pl_orbper="365.25", pl_orbpererr1="", pl_orbpererr2="",
               mstar=1.0)["position"]["elements"]["a_au"]
    assert a["v"] == pytest.approx(1.0, rel=1e-9) and a["tier"] == "inferred" and a["unit"] == "au"
    assert "Kepler III" in a["src"] and "lo" not in a
    a8 = planet(pl_orbsmax="", pl_orbper="365.25", mstar=8.0)["position"]["elements"]["a_au"]
    assert a8["v"] == pytest.approx(2.0, rel=1e-9)   # a^3 = M P^2


def test_missing_period_comes_from_kepler_iii_as_inferred():
    per = planet(pl_orbper="", pl_orbpererr1="", pl_orbpererr2="", pl_orbsmax="4.0",
                 mstar=1.0)["position"]["elements"]["period_d"]
    assert per["v"] == pytest.approx(365.25 * 8.0, rel=1e-9) and per["tier"] == "inferred"
    assert per["unit"] == "d" and "Kepler III" in per["src"]


def test_without_a_stellar_mass_kepler_assumes_one_solar_mass_illustratively():
    a = planet(pl_orbsmax="", pl_orbper="365.25", mstar=None)["position"]["elements"]["a_au"]
    assert a["tier"] == "illustrative" and "1 Msun" in a["src"] and a["v"] == pytest.approx(1.0)
    per = planet(pl_orbper="", pl_orbsmax="1.0", mstar=None)["position"]["elements"]["period_d"]
    assert per["tier"] == "illustrative" and per["v"] == pytest.approx(365.25)


def test_derived_values_are_rounded_to_ten_significant_digits():
    a = planet(pl_orbsmax="", pl_orbper="10.0", mstar=1.07)["position"]["elements"]["a_au"]["v"]
    assert float(f"{a:.10g}") == a


# --- mass, radius and the props ---------------------------------------------------------------

def test_msini_is_never_mass():
    p = planet(pl_bmassprov="Msini")
    assert "mass" not in p["props"]
    assert p["props"]["msini"] == {"v": 1.5, "lo": 1.3, "hi": 1.6, "unit": "Mjup",
                                   "src": "NEA pscomppars: Aa 2020", "tier": "measured"}


def test_mass_provenance_mapping():
    assert planet(pl_bmassprov="Mass")["props"]["mass"]["tier"] == "measured"
    assert planet(pl_bmassprov="Msin(i)/sin(i)")["props"]["mass"]["tier"] == "catalogue"
    m = planet(pl_bmassprov="M-R relationship", pl_bmassj_reflink=link("", calc=True))["props"]["mass"]
    assert m["tier"] == "inferred"
    assert m["src"] == "NEA pscomppars: archive-calculated from radius (Chen & Kipping 2017)"
    assert "msini" not in planet(pl_bmassprov="M-R relationship")["props"]
    none = planet(pl_bmassprov="", pl_bmassj="")["props"]
    assert "mass" not in none and "msini" not in none
    unknown = planet(pl_bmassprov="")["props"]   # a value but no provenance: not claimed as a mass
    assert "mass" not in unknown and "msini" not in unknown


def test_a_calculated_radius_is_inferred_and_a_fitted_one_measured():
    r = planet(pl_rade_reflink=link("", calc=True), pl_radeerr1="", pl_radeerr2="")["size"]["radius"]
    assert r["tier"] == "inferred" and r["unit"] == "Rearth"
    assert r["src"] == "NEA pscomppars: archive-calculated from mass (Chen & Kipping 2017)"
    f = planet()["size"]["radius"]
    assert f["tier"] == "measured" and (f["lo"], f["hi"]) == (11.5, 12.5)
    assert planet()["size"]["angular"] is None


def test_missing_radii_give_null_size_and_limits_are_strings():
    assert planet(pl_rade="", pl_radeerr1="", pl_radeerr2="")["size"] is None
    assert planet(pl_radelim="1")["size"]["radius"]["v"] == "< 12"
    assert planet(pl_radelim="-1")["size"]["radius"]["v"] == "> 12"


def test_props_discovery_and_controversial():
    p = planet()
    assert p["props"]["disc_method"]["v"] == "Transit" and p["props"]["disc_year"]["v"] == 2010
    assert p["props"]["disc_facility"]["v"] == "Test Observatory"
    assert all(q["tier"] == "catalogue" for k, q in p["props"].items() if k.startswith("disc_"))
    assert "controversial" not in p["props"]
    c = planet(pl_controv_flag="1")["props"]["controversial"]
    assert c == {"v": "yes", "src": "NEA pscomppars", "tier": "catalogue"}
    assert "period" not in p["props"] and "a" not in p["props"] and "radius" not in p["props"]


def test_planet_names_designations_and_render():
    p = planet(name="51 Peg b", hd_name="HD 217014", hip_name="HIP 113357")
    assert p["id"] == "nea:51 Peg b" and p["name"] == "51 Peg b"
    assert p["designations"] == ["HD 217014 b", "HIP 113357 b"]
    assert planet(name="HD 1 b", hd_name="HD 1")["designations"] == []   # same as the name
    assert p["render"] == {"mag": 11.5} and planet(sy_vmag="")["render"] == {}
    assert p["provenance"] == PROV and set(PROV) == {"source", "dataset", "catalogue", "version"}


# --- host ids ---------------------------------------------------------------------------------

DR2_ONLY = dict(gaia_dr3_id="", gaia_dr2_id="Gaia DR2 111")


def hosts(rows, dr2=(), pos=()):
    groups = b.group_hosts(list(rows))
    return b.resolve_hosts(groups, list(dr2), list(pos))


def nbr(dr2, dr3, mas, dmag):
    return {"dr2_source_id": str(dr2), "dr3_source_id": str(dr3), "angular_distance": str(mas),
            "magnitude_difference": str(dmag)}


def gsrc(sid, ra, dec, g=12.0, pmra="", pmdec=""):
    return {"source_id": str(sid), "ra": str(ra), "dec": str(dec), "pmra": str(pmra), "pmdec": str(pmdec),
            "phot_g_mean_mag": str(g)}


def test_step_1_gaia_dr3_id_with_its_prefix_stripped():
    h = hosts([row(gaia_dr3_id="Gaia DR3 4472832130942575872")])["Test"]
    assert h["id"] == "gdr3:4472832130942575872" and h["step"] == "dr3" and h["dr3"] == "4472832130942575872"


def test_dr3_wins_over_every_other_id():
    h = hosts([row(gaia_dr2_id="Gaia DR2 111", hip_name="HIP 5")], dr2=[nbr(111, 999, 10, 0)])["Test"]
    assert h["step"] == "dr3" and h["id"] == "gdr3:1234567890"
    assert h["same_as"] == ["hip:5"]


def test_step_2_dr2_crossmatch_never_reuses_the_dr2_id():
    h = hosts([row(**DR2_ONLY)], dr2=[nbr(111, 222, 40.0, 0.2)])["Test"]
    assert h["step"] == "dr2-crossmatch" and h["id"] == "gdr3:222" and h["dr3"] == "222"
    h = hosts([row(**DR2_ONLY)], dr2=[])["Test"]
    assert h["step"] == "neahost" and h["id"] == "neahost:Test"


@pytest.mark.parametrize("mas,dmag,ok", [
    (100.0, 1.0, True), (99.9, -1.0, True), (100.1, 0.0, False), (787.0, 0.1, False),
    (10.0, 1.01, False), (10.0, -1.5, False),
])
def test_dr2_neighbour_rule_is_100_mas_and_one_magnitude(mas, dmag, ok):
    assert (b.dr2_to_dr3("111", [nbr(111, 222, mas, dmag)]) == "222") is ok


def test_dr2_takes_the_closest_neighbour_and_only_that_one():
    rows = [nbr(111, 333, 80.0, 0.1), nbr(111, 222, 30.0, 0.2)]
    assert b.dr2_to_dr3("111", rows) == "222"
    # the closest fails on magnitude: a farther neighbour that would pass is not used
    assert b.dr2_to_dr3("111", [nbr(111, 222, 30.0, 3.0), nbr(111, 333, 60.0, 0.1)]) is None
    assert b.dr2_to_dr3("111", []) is None


def test_step_3_hip_when_dr2_does_not_match():
    h = hosts([row(**DR2_ONLY, hip_name="HIP 113357")], dr2=[nbr(111, 222, 787.0, 0.1)])["Test"]
    assert h["step"] == "hip" and h["id"] == "hip:113357" and h["dr3"] is None and h["same_as"] == []
    assert hosts([row(gaia_dr3_id="", hip_name="HIP 5 A")])["Test"]["step"] == "neahost"   # not a bare number


def test_step_4_positional_match_for_coordinate_only_hosts():
    r = row(gaia_dr3_id="", sy_gaiamag="12.1")
    h = hosts([r], pos=[gsrc(777, 100.5, -20.25, 12.0)])["Test"]
    assert h["step"] == "positional" and h["id"] == "gdr3:777" and h["dr3"] == "777"
    assert hosts([r], pos=[])["Test"]["step"] == "neahost"


def test_positional_match_must_be_unique_within_1p5_arcsec_and_agree_in_magnitude():
    ra, dec = 100.5, -20.25
    off = lambda arcsec: arcsec / 3600.0 / math.cos(math.radians(dec))  # noqa: E731
    pm = b.positional_match
    assert pm(ra, dec, 12.0, [gsrc(1, ra + off(1.0), dec, 12.2)]) == "1"
    assert pm(ra, dec, 12.0, [gsrc(1, ra + off(1.6), dec, 12.0)]) is None          # too far
    assert pm(ra, dec, 12.0, [gsrc(1, ra, dec, 12.0), gsrc(2, ra + off(1.0), dec, 12.0)]) is None  # not unique
    assert pm(ra, dec, 12.0, [gsrc(1, ra, dec, 12.0), gsrc(2, ra + off(3.0), dec, 12.0)]) == "1"
    assert pm(ra, dec, 12.0, [gsrc(1, ra, dec, 12.6)]) is None                     # |dG| > 0.5
    assert pm(ra, dec, 12.0, [gsrc(1, ra, dec, 12.5)]) == "1"
    assert pm(ra, dec, None, [gsrc(1, ra, dec, 19.0)]) == "1"                      # no archive G: no check
    assert pm(ra, dec, 12.0, [gsrc(1, ra, dec, "")]) is None                       # source without G


def test_positional_match_propagates_the_gaia_epoch_back_to_2000():
    ra, dec = 100.5, -20.25
    # pmdec = +100 mas/yr: the 2016.0 position is 1.6" north of where the star was in 2000.0
    star = gsrc(5, ra, dec + 1.6 / 3600.0, 12.0, pmra=0.0, pmdec=100.0)
    assert b.positional_match(ra, dec, 12.0, [star]) == "5"
    no_pm = gsrc(5, ra, dec + 1.6 / 3600.0, 12.0)
    assert b.positional_match(ra, dec, 12.0, [no_pm]) is None
    assert b.positional_match(ra, dec, 12.0, [gsrc(5, ra, dec + 1.0 / 3600.0, 12.0, pmra=0.0, pmdec=100.0)]) == "5"  # raw fallback


def test_microlensing_hosts_skip_the_positional_step():
    r = row(gaia_dr3_id="", discoverymethod="Microlensing")
    src = [gsrc(777, 100.5, -20.25, 12.0)]
    h = hosts([r], pos=src)["Test"]
    assert h["step"] == "neahost" and h["id"] == "neahost:Test"
    # one microlensing planet is enough to skip it for the host
    two = [row("Test b", gaia_dr3_id="", discoverymethod="Transit"),
           row("Test c", gaia_dr3_id="", discoverymethod="Microlensing")]
    assert hosts(two, pos=src)["Test"]["step"] == "neahost"
    assert hosts([row(gaia_dr3_id="")], pos=src)["Test"]["step"] == "positional"


def test_the_ladder_order_and_positional_candidates():
    rows = [row("A b", "A"), row("B b", "B", gaia_dr3_id="", gaia_dr2_id="Gaia DR2 111"),
            row("C b", "C", gaia_dr3_id="", hip_name="HIP 9"), row("D b", "D", gaia_dr3_id=""),
            row("E b", "E", gaia_dr3_id="", discoverymethod="Microlensing")]
    dr2 = [nbr(111, 222, 10, 0)]
    pos = [gsrc(777, 100.5, -20.25, 12.0)]
    steps = {k: v["step"] for k, v in hosts(rows, dr2, pos).items()}
    assert steps == {"A": "dr3", "B": "dr2-crossmatch", "C": "hip", "D": "positional", "E": "neahost"}
    groups = b.group_hosts(rows)
    assert [c[0] for c in b.positional_candidates(groups, dr2)] == ["D"]
    assert b.dr2_candidates(groups) == ["111"]


def test_same_as_lists_the_hip_id_when_the_primary_is_gaia():
    recs, _ = build_records([row("51 Peg b", "51 Peg", hip_name="HIP 113357", hd_name="HD 217014",
                                 tic_id="TIC 139298196")])
    star = next(r for r in recs if r["kind"] == "star")
    assert star["same_as"] == ["hip:113357"]
    assert star["designations"] == ["HD 217014", "HIP 113357", "TIC 139298196", "Gaia DR3 1234567890"]
    recs, _ = build_records([row(gaia_dr3_id="", hip_name="HIP 9")])
    assert next(r for r in recs if r["kind"] == "star")["same_as"] == []


def test_two_hostnames_with_one_star_share_one_record():
    recs, rep = build_records([row("A b", "X A"), row("B b", "X B")])
    stars = [r for r in recs if r["kind"] == "star"]
    assert len(stars) == 1 and rep["host_ids_shared_by_two_hostnames"] == 1
    assert {r["host"] for r in recs if r["kind"] == "exoplanet"} == {stars[0]["id"]}


# --- host star records ------------------------------------------------------------------------

def star(**kw) -> dict:
    recs, _ = build_records([row(**kw)])
    return next(r for r in recs if r["kind"] == "star")


def test_star_with_a_parallax_is_measured():
    s = star()
    pos = s["position"]
    assert pos["method"] == "parallax" and pos["dist"]["tier"] == "measured" and s["evidence"] == "measured"
    assert pos["dist"] == {"v": 50.0, "lo": 49.6, "hi": 50.5, "unit": "pc",
                           "src": "NEA pscomppars: Gaia DR3", "tier": "measured"}
    assert pos["ra"] == 100.5 and pos["dec"] == -20.25 and s["host"] is None and s["parent"] is None
    assert objects.validate_record(s) == []


def test_star_without_a_parallax_has_an_assumed_illustrative_distance():
    s = star(sy_plx="")
    assert s["position"]["method"] == "assumed" and s["position"]["dist"]["tier"] == "illustrative"
    assert s["evidence"] == "illustrative" and objects.validate_record(s) == []


def test_microlensing_star_without_a_parallax_is_a_lens_model_derived_distance():
    s = star(sy_plx="", gaia_dr3_id="", discoverymethod="Microlensing")
    assert s["id"] == "neahost:Test" and s["position"]["method"] == "lens-model"
    assert s["position"]["dist"]["tier"] == "inferred" and s["evidence"] == "derived"
    assert objects.validate_record(s) == []
    assert star(discoverymethod="Microlensing")["position"]["method"] == "parallax"   # a parallax wins


def test_star_without_a_distance_is_direction_only_and_measured():
    s = star(sy_dist="", sy_disterr1="", sy_disterr2="", sy_plx="")
    assert s["position"]["dist"] is None and s["position"]["tier"] == "catalogue"
    assert s["evidence"] == "measured" and objects.validate_record(s) == []


def test_star_props():
    s = star(st_spectype="G2 V", st_spectype_reflink=link("Smith 2018"), sy_gaiamag="11.3",
             sy_gaiamag_reflink=link("TICv8"), sy_pnum="3", st_teff_reflink=link("Aa 2020"),
             st_tefferr1="50", st_tefferr2="-60")
    p = s["props"]
    assert p["teff"] == {"v": 5800, "lo": 5740, "hi": 5850, "unit": "K", "src": "NEA pscomppars: Aa 2020",
                         "tier": "catalogue"}
    assert p["mass"]["unit"] == "Msun" and p["spectral_type"]["v"] == "G2 V"
    assert p["spectral_type"]["src"] == "NEA pscomppars: Smith 2018"
    assert p["vmag"]["tier"] == "measured" and p["gmag"]["v"] == 11.3 and p["n_planets"]["v"] == 3
    assert s["size"]["radius"]["unit"] == "Rsun" and s["render"] == {"mag": 11.5}
    assert s["provenance"] == PROV


# --- the whole table: exclusions and the report -----------------------------------------------

def test_exclusions_are_counted_by_reason():
    rows = [row("A b", "A"), row("B b", "B", pl_orbper="", pl_orbsmax=""),
            row("C b", "C", pl_orbper="0", pl_orbsmax=""), row("D b", "D", ra="", dec="")]
    recs, rep = build_records(rows)
    assert rep["rows_read"] == 4 and rep["planets_written"] == 1 and rep["stars_written"] == 1
    assert rep["excluded"] == {"no host position": 1, "no orbital period and no semi-major axis": 2}
    assert sorted(r["id"] for r in recs) == ["gdr3:1234567890", "nea:A b"]


def test_a_host_whose_planets_are_all_excluded_gets_no_star_record():
    recs, rep = build_records([row("A b", "A"), row("B b", "B", pl_orbper="", pl_orbsmax="")])
    assert [r["id"] for r in recs if r["kind"] == "star"] == ["gdr3:1234567890"]
    assert rep["hosts"] == 2


def test_the_report_has_the_ladder_counts_and_rates():
    rows = [row("A b", "A"), row("B b", "B", gaia_dr3_id=""), row("C b", "C", gaia_dr3_id="",
                                                                    discoverymethod="Microlensing")]
    _, rep = build_records(rows, pos=[gsrc(777, 100.5, -20.25, 12.0)])
    assert rep["host_ladder"] == {"dr3": 1, "dr2-crossmatch": 0, "hip": 0, "positional": 1, "neahost": 1}
    assert rep["host_ladder_rate"]["dr3"] == pytest.approx(0.3333, abs=1e-4)
    assert rep["hosts"] == 3 and rep["hosts_with_gaia_dr3_id"] == 2 and rep["gaia_rate"] == pytest.approx(0.6667, abs=1e-4)
    assert rep["microlensing_hosts_without_gaia_or_hip_id"] == 1
    assert rep["records_written"] == rep["planets_written"] + rep["stars_written"]


def test_every_synthetic_record_validates_and_is_hosted_correctly():
    rows = [row("A b", "A", pl_orbincl="88", pl_tranmid="2457000.5"), row("A c", "A", pl_orbper="", pl_orbeccen=""),
            row("B b", "B", gaia_dr3_id="", gaia_dr2_id="", discoverymethod="Microlensing", sy_plx="")]
    recs, _ = build_records(rows)
    assert all(objects.validate_record(r) == [] for r in recs)
    for r in recs:
        if r["kind"] == "exoplanet":
            assert r["host"] == r["parent"] and r["position"]["tier"] == r["evidence"] == "illustrative"


# --- files: snapshot, reproducibility, --check ------------------------------------------------

def _write_sources(d: Path, rows: list[dict], dr2=(), pos=()) -> Path:
    import csv
    import io

    def csv_bytes(cols, rs):
        buf = io.StringIO(newline="")
        w = csv.DictWriter(buf, fieldnames=cols, lineterminator="\n")
        w.writeheader()
        w.writerows(rs)
        return buf.getvalue().encode()

    d.mkdir(parents=True, exist_ok=True)
    files = []
    for role, name, data in (("pscomppars", "pscomppars-2026-11-18.csv.gz", csv_bytes(b.COLUMNS, rows)),
                             ("dr2_dr3", "gaia-dr2-dr3.csv.gz", csv_bytes(b.DR2_COLS, dr2)),
                             ("positional", "gaia-positional.csv.gz", csv_bytes(b.POS_COLS, pos))):
        b.write_gz(d / name, data)
        files.append({"role": role, "file": name, "sha256": b.sha256(data), "retrieved": "2026-11-18",
                      "query_url": "https://example.org/q", "rows": len(b.read_csv_bytes(data)),
                      "citation": "c", "licence": "l"})
    (d / "SOURCE.json").write_text(json.dumps({"dataset": "nea-exoplanets", "files": files}))
    return d


def _tree(d: Path) -> dict[str, bytes]:
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


SYN_ROWS = [row("A b", "A", pl_orbincl="88", pl_tranmid="2457000.5"), row("A c", "A", pl_orbper=""),
            row("B b", "B", gaia_dr3_id="", ra="10.0", dec="60.0", discoverymethod="Microlensing", sy_plx="")]


def test_synthetic_build_is_byte_identical_and_uses_a_string_table(tmp_path):
    src = _write_sources(tmp_path / "src", SYN_ROWS)
    b.build(tmp_path / "a", src)
    b.build(tmp_path / "b", src)
    assert _tree(tmp_path / "a") == _tree(tmp_path / "b")
    m = json.loads((tmp_path / "a" / "manifest.json").read_text())
    assert m["dataset"] == "nea-exoplanets" and m["kinds"] == ["exoplanet", "star"] and m["precedence"] == 50
    assert m["tiling"]["band_deg"] == 10 and m["count"] == 5 and m["src_table"]
    assert m["build"]["report"]["planets_written"] == 3
    assert st.verify_dataset(tmp_path / "a") == []


def test_manifest_provenance_carries_the_citation_acknowledgement_and_pins(tmp_path):
    src = _write_sources(tmp_path / "src", SYN_ROWS)
    m = b.build(tmp_path / "a", src)
    p = m["provenance"]
    assert p["citation"] == "Christiansen et al. 2025 (NASA Exoplanet Archive)"
    assert p["acknowledgement"].startswith("This research has made use of the NASA Exoplanet Archive")
    assert p["version"] == "snapshot 2026-11-18" and p["retrieved"] == "2026-11-18"
    assert len(p["source_sha256"]) == 64 and p["query_url"] == "https://example.org/q"
    assert [s["file"] for s in p["side_inputs"]] == ["gaia-dr2-dr3.csv.gz", "gaia-positional.csv.gz"]


def test_a_changed_snapshot_is_refused(tmp_path):
    src = _write_sources(tmp_path / "src", SYN_ROWS)
    gz = src / "pscomppars-2026-11-18.csv.gz"
    b.write_gz(gz, b"pl_name\nsomething else\n")
    with pytest.raises(SystemExit, match="sha256"):
        b.build(tmp_path / "a", src)


def test_local_builds_from_a_given_csv(tmp_path):
    import csv
    src = _write_sources(tmp_path / "src", [])
    local = tmp_path / "mine.csv"
    with local.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=b.COLUMNS)
        w.writeheader()
        w.writerows(SYN_ROWS)
    m = b.build(tmp_path / "a", src, local=local)
    assert m["count"] == 5 and m["provenance"]["version"] == "local file mine.csv"
    assert m["provenance"]["source_sha256"] == b.sha256(local.read_bytes())


def test_check_mode_flags_a_difference(tmp_path, monkeypatch):
    src = _write_sources(tmp_path / "src", SYN_ROWS)
    b.build(tmp_path / "out", src)
    monkeypatch.setattr(sys, "argv", ["x", "--check", "--sources", str(src), "--out", str(tmp_path / "out")])
    assert b.main() == 0
    next((tmp_path / "out" / "tiles").glob("*.json")).write_text("{}")
    assert b.main() == 1
    monkeypatch.setattr(sys, "argv", ["x", "--check", "--sources", str(src), "--out", str(tmp_path / "gone")])
    assert b.main() == 1


def test_gzip_is_deterministic_and_nameless(tmp_path):
    b.write_gz(tmp_path / "a.gz", b"hello\n" * 100)
    b.write_gz(tmp_path / "b.gz", b"hello\n" * 100)
    raw = (tmp_path / "a.gz").read_bytes()
    assert raw == (tmp_path / "b.gz").read_bytes()
    assert raw[3] == 0 and raw[4:8] == b"\x00\x00\x00\x00"   # no FNAME flag, mtime 0


def test_the_script_documents_the_query_and_columns():
    assert b.ADQL.startswith("select pl_name,") and b.ADQL.endswith("from pscomppars order by pl_name")
    assert b.NEA_TAP == "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"
    assert len(set(b.COLUMNS)) == len(b.COLUMNS)


# --- the committed snapshot and dataset -------------------------------------------------------

@pytest.fixture(scope="module")
def built(tmp_path_factory):
    out = tmp_path_factory.mktemp("nea") / "out"
    b.build(out)
    return out


def test_the_committed_snapshot_matches_source_json():
    src = b.load_sources(b.SOURCES)   # raises when a sha256 differs
    meta = {f["role"]: f for f in src["meta"]["files"]}
    assert set(meta) == {"pscomppars", "dr2_dr3", "positional"}
    assert len(src["pscomppars"]) == meta["pscomppars"]["rows"] > 6000
    for f in meta.values():
        assert f["retrieved"] and f["query_url"].startswith("https://") and f["citation"] and f["licence"]
        assert (b.SOURCES / f["file"]).is_file() and len(f["sha256"]) == 64
    assert meta["pscomppars"]["file"] == f"pscomppars-{meta['pscomppars']['retrieved']}.csv.gz"
    assert meta["pscomppars"]["licence"] == b.ACKNOWLEDGEMENT


def test_the_committed_dataset_equals_a_fresh_build_and_verifies(built):
    assert _tree(built) == _tree(COMMITTED)
    assert st.verify_dataset(COMMITTED) == []


def test_rebuilding_from_the_committed_snapshot_is_byte_identical(built, tmp_path):
    b.build(tmp_path / "again")
    assert _tree(tmp_path / "again") == _tree(built)


def test_committed_manifest_report_and_shape():
    m = json.loads((COMMITTED / "manifest.json").read_text())
    rep = m["build"]["report"]
    assert m["kinds"] == ["exoplanet", "star"] and m["precedence"] == 50 and m["tiling"]["band_deg"] == 10
    assert rep["rows_read"] == 6470 and rep["planets_written"] + sum(rep["excluded"].values()) == 6470
    assert rep["records_written"] == m["count"] == rep["planets_written"] + rep["stars_written"]
    assert sum(rep["host_ladder"].values()) == rep["hosts"] == 4862
    assert rep["host_ladder"]["dr3"] == 4491 and rep["gaia_rate"] > 0.92
    assert m["src_table"] == sorted(set(m["src_table"]))
    assert m["record_defaults"] == {"provenance": b.provenance(m["provenance"]["retrieved"])}
    assert rep["limit_flags"]["pl_orbeccenlim"] == {"lower": 11, "upper": 288}
    assert rep["limit_flags"]["pl_bmassjlim"]["upper"] == 225
    assert rep["lower_bounds_clamped_to_zero"]["total"] == sum(rep["lower_bounds_clamped_to_zero"]["by_column"].values())


def _committed_record(rid: str) -> dict:
    ds = st.load_dataset(COMMITTED)
    m = ds.manifest
    for t in m["tiles"]:
        for r in st._read_tile(ds, t):
            if r["id"] == rid:
                return r
    raise AssertionError(rid)


def test_the_doc_examples_equal_the_built_records():
    assert _committed_record("nea:TRAPPIST-1 b") == json.loads((EXAMPLES / "exoplanet.json").read_text())
    assert _committed_record("gdr3:2635476908753563008") == json.loads((EXAMPLES / "star_host.json").read_text())


def test_trappist_1_b_matches_the_design_doc_values():
    p = _committed_record("nea:TRAPPIST-1 b")
    el = p["position"]["elements"]
    assert p["host"] == p["parent"] == "gdr3:2635476908753563008" and p["evidence"] == "illustrative"
    assert p["position"]["host_radec"] == [346.6263919, -5.0434618] and p["position"]["phase_known"] is True
    assert (el["period_d"]["v"], el["period_d"]["lo"], el["period_d"]["hi"]) == (1.510826, 1.51082, 1.510832)
    assert (el["a_au"]["v"], el["e"]["v"], el["i_deg"]["v"], el["omega_deg"]["v"]) == (0.01154, 0.00622, 89.728, 336.86)
    assert (el["t_conj_mjd"]["v"], el["t_conj_mjd"]["hi"]) == (57322.014193, 57322.014196)
    assert el["t_peri_mjd"] is None and el["node_deg"] is None
    assert p["size"]["radius"]["v"] == 1.116 and p["props"]["mass"]["v"] == 0.00432309
    assert p["render"] == {"mag": 17.02} and p["designations"] == []


def test_51_peg_b_is_inferred_radius_and_hip_alias():
    p = _committed_record("nea:51 Peg b")
    assert p["designations"] == ["HD 217014 b", "HIP 113357 b"] and p["host"] == "gdr3:2835207319109249920"
    assert p["size"]["radius"]["tier"] == "inferred"
    assert p["size"]["radius"]["src"] == "NEA pscomppars: archive-calculated from mass (Chen & Kipping 2017)"
    assert p["position"]["elements"]["i_deg"]["v"] == 49.8 and p["position"]["elements"]["t_peri_mjd"]["v"] == 52496.5
    # the archive flags its eccentricity as an upper limit (e < 0.0063): drawn circular, not claimed
    e = p["position"]["elements"]["e"]
    assert e["v"] == 0 and e["hi"] == 0.0063 and e["tier"] == "illustrative"
    assert e["src"] == "NEA pscomppars: upper limit e < 0.0063 (Cont et al. 2026); drawn circular"
    assert _committed_record("gdr3:2835207319109249920")["same_as"] == ["hip:113357"]


def test_no_committed_record_claims_a_known_placement():
    ds = st.load_dataset(COMMITTED)
    n = 0
    for t in ds.manifest["tiles"]:
        for r in st._read_tile(ds, t):
            if r["kind"] == "exoplanet":
                n += 1
                assert r["evidence"] == "illustrative" and r["position"]["tier"] == "illustrative"
                assert r["position"]["elements"]["node_deg"] is None
                assert "mass" not in r["props"] or "msini" not in r["props"]
    assert n == ds.manifest["build"]["report"]["planets_written"]


def test_no_committed_numeric_value_is_a_flagged_limit_and_strings_are_limits():
    ds = st.load_dataset(COMMITTED)
    strings = 0
    for t in ds.manifest["tiles"]:
        for r in st._read_tile(ds, t):
            qs = list(r["props"].values()) + ([r["size"]["radius"]] if r["size"] else [])
            for q in qs:
                if isinstance(q["v"], str) and q["v"][:1] in "<>":
                    strings += 1
                    assert "lo" not in q and "hi" not in q and q["v"][1] == " " and float(q["v"][2:]) >= 0
            if r["kind"] == "exoplanet":
                e = r["position"]["elements"]["e"]
                if e["src"].find("limit") >= 0:
                    assert e["v"] == 0 and e["tier"] == "illustrative"
                for k in ("period_d", "a_au", "e"):
                    assert r["position"]["elements"][k].get("lo", 0) >= 0
    lim = ds.manifest["build"]["report"]["limit_flags"]
    assert strings > 200 and strings <= sum(v["upper"] + v["lower"] for v in lim.values())


def test_the_provenance_is_stored_once_in_the_manifest_and_restored_when_served():
    raw = (COMMITTED / "tiles" / "13-20.json").read_text()
    assert '"provenance"' not in raw
    r = _committed_record("nea:TRAPPIST-1 b")
    assert r["provenance"] == {"catalogue": "NASA Exoplanet Archive pscomppars", "dataset": "nea-exoplanets",
                               "source": "static:nea-exoplanets", "version": "snapshot 2026-11-18"}
