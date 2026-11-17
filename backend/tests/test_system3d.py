"""Offline tests for /api/system/{source_id} (the ARI and ESA fetchers are monkeypatched)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from spherex_app import config, system3d
from spherex_app.archive import UpstreamError
from spherex_app.main import app

client = TestClient(app)
SID = "4373465352415301632"

FULL = {
    "source_id": SID, "ra": "262.1712", "dec": "-0.5810", "parallax": "2.07", "parallax_error": "0.117",
    "phot_g_mean_mag": "13.772", "bp_rp": "1.1748", "r_med_geo": "478.73", "r_lo_geo": "456.05",
    "r_hi_geo": "507.16", "teff_gspphot": "5396.4", "teff_gspphot_lower": "5375.3",
    "teff_gspphot_upper": "5536.2", "logg_gspphot": "4.2297", "radius_gspphot": "1.27",
    "radius_flame": "1.0895", "radius_flame_lower": "1.039", "radius_flame_upper": "1.1547",
    "lum_flame": "0.8995", "lum_flame_lower": "0.822", "lum_flame_upper": "1.006",
    "mass_flame": "0.909", "mass_flame_lower": "0.869", "mass_flame_upper": "0.949",
    "age_flame": "12.36", "age_flame_lower": "11.03", "age_flame_upper": "13.5",
    "flags_flame": "00", "teff_esphs": "", "spectraltype_esphs": "G",
    "classprob_dsc_combmod_whitedwarf": "2.0e-12",
}


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")


def _all_vs(payload):
    return [v for v in payload["values"].values() if v is not None]


def test_full_mapping():
    p = system3d.build_payload(FULL)
    v = p["values"]
    assert p["id"] == SID and p["planets"] == [] and p["companions"] == [] and p["notes"] == []
    assert v["dist_pc"]["tier"] == "measured" and v["dist_pc"]["src"] == system3d.SRC_DIST
    assert v["g_mag"]["tier"] == "measured" and v["bp_rp"]["src"] == system3d.SRC_PHOT
    assert v["teff_k"]["src"] == system3d.SRC_GSP and v["teff_k"]["lo"] == 5375.3
    assert v["radius_rsun"]["src"] == system3d.SRC_FLAME and v["radius_rsun"]["hi"] == 1.1547
    assert v["lum_lsun"]["v"] == 0.8995 and v["mass_msun"]["v"] == 0.909 and v["age_gyr"]["v"] == 12.36
    assert v["logg"]["v"] == 4.2297
    assert v["spectral_type"] == {"v": "G", "src": system3d.SRC_ESPHS, "tier": "catalogue"}
    assert v["wd_prob"]["tier"] == "catalogue"


def test_tiers_and_src_on_every_value():
    for p in (system3d.build_payload(FULL), system3d.sun_payload()):
        for x in _all_vs(p):
            assert x["tier"] in ("measured", "catalogue") and x["src"]
            if p["id"] != "sun" and x["src"] != system3d.SRC_PHOT and x["src"] != system3d.SRC_DIST:
                assert x["tier"] == "catalogue"


def test_missing_flame_gives_nulls_and_notes():
    row = {k: v for k, v in FULL.items() if "flame" not in k}
    p = system3d.build_payload(row)
    v = p["values"]
    assert v["mass_msun"] is None and v["age_gyr"] is None and v["lum_lsun"] is None
    assert v["radius_rsun"]["src"] == system3d.SRC_GSP  # GSP-Phot radius fallback
    assert "FLAME mass not available for this star" in p["notes"]


def test_hot_star_uses_esphs_teff():
    row = dict(FULL, teff_gspphot="31000", teff_esphs="33500", teff_esphs_uncertainty="800")
    t = system3d.build_payload(row)["values"]["teff_k"]
    assert t["v"] == 33500 and t["src"] == system3d.SRC_ESPHS and t["lo"] == 32700
    # GSP-Phot missing entirely: ESP-HS still used
    t = system3d.build_payload(dict(FULL, teff_gspphot="", teff_esphs="9000"))["values"]["teff_k"]
    assert t["src"] == system3d.SRC_ESPHS


def test_flame_flags_note_and_parallax_fallback():
    row = dict(FULL, flags_flame="01", r_med_geo="", r_lo_geo="", r_hi_geo="")
    p = system3d.build_payload(row)
    assert any("FLAME quality flags" in n for n in p["notes"])
    assert p["values"]["dist_pc"]["src"] == system3d.SRC_PLX


def test_sun_payload():
    r = client.get("/api/system/sun")
    assert r.status_code == 200
    j = r.json()
    assert j["name"] == "Sun" and j["ra"] is None
    v = j["values"]
    assert v["teff_k"]["v"] == 5772 and v["age_gyr"]["v"] == 4.57 and v["logg"]["v"] == 4.438
    assert v["spectral_type"]["v"] == "G2V"
    assert v["dist_pc"] is None and v["g_mag"] is None and v["bp_rp"] is None
    assert v["teff_k"]["src"] == "IAU 2015 nominal" and v["teff_k"]["tier"] == "measured"


@pytest.mark.parametrize("bad", ["abc", "12ab", "-5", "1.5", "99999999999999999999"])
def test_bad_id_400(bad):
    assert client.get(f"/api/system/{bad}").status_code == 400


def _patch(monkeypatch, ari=None, esa=None):
    calls = {"ari": 0, "esa": 0}

    async def a(sid):
        calls["ari"] += 1
        if isinstance(ari, Exception):
            raise ari
        return ari

    async def e(sid):
        calls["esa"] += 1
        if isinstance(esa, Exception):
            raise esa
        return esa
    monkeypatch.setattr(system3d, "_ari_row", a)
    monkeypatch.setattr(system3d, "_esa_row", e)
    return calls


def test_route_ok_and_cached(monkeypatch):
    calls = _patch(monkeypatch, ari=[FULL])
    r = client.get(f"/api/system/{SID}")
    assert r.status_code == 200 and r.json()["values"]["teff_k"]["v"] == 5396.4
    client.get(f"/api/system/{SID}")
    assert calls["ari"] == 1  # second request served from the cache


def test_404_unknown(monkeypatch):
    _patch(monkeypatch, ari=[])
    r = client.get("/api/system/123")
    assert r.status_code == 404 and "detail" in r.json()


def test_ari_failure_falls_back_to_esa(monkeypatch):
    calls = _patch(monkeypatch, ari=UpstreamError("ari down"), esa=[FULL])
    r = client.get(f"/api/system/{SID}")
    assert r.status_code == 200 and calls == {"ari": 1, "esa": 1}


def test_total_failure_502_not_cached(monkeypatch):
    calls = _patch(monkeypatch, ari=UpstreamError("ari down"), esa=UpstreamError("esa down"))
    assert client.get(f"/api/system/{SID}").status_code == 502
    _patch(monkeypatch, ari=[FULL])
    assert client.get(f"/api/system/{SID}").status_code == 200
    assert calls["ari"] == 1
