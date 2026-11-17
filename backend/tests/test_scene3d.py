"""Offline tests for /api/scene3d (no network: star fetchers, TAP and SkyBoT are monkeypatched)."""

from __future__ import annotations

import asyncio
import math
import random

import pytest
from fastapi.testclient import TestClient

from spherex_app import catalogs, config, movers, scene3d
from spherex_app.archive import UpstreamError
from spherex_app.main import app

client = TestClient(app)
MJD = 60000.0
ORION = (83.82, -5.39)


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "GAIA3D_SOURCE", "esa")  # offline default: the ESA path, faked
    scene3d._failed_tiles.clear()


def _gaia_rows(n: int) -> list[dict]:
    """Raw TAP rows as the CSV reader returns them (strings)."""
    return [{"source_id": str(10**18 + i), "ra": "83.8", "dec": "-5.4", "phot_g_mean_mag": "10.0",
             "bp_rp": "", "r_med_geo": "100.0", "r_lo_geo": "90.0", "r_hi_geo": "110.0"}
            for i in range(n)]


def _fake_gaia(n_rows: int, seen: list | None = None):
    async def fake(ra, dec, radius, limit):
        if seen is not None:
            seen.append((ra, dec, radius, limit))
        return _gaia_rows(n_rows)
    return fake


def _fake_skybot(objs=None, exc: Exception | None = None):
    async def fake(ra, dec, radius, jd):
        if exc is not None:
            raise exc
        return objs or []
    return fake


def _catalogue_fake(stars: list[dict], calls: list | None = None, fail=None):
    """Fake per-cone fetch over a synthetic catalogue: returns the brightest `limit` stars inside
    the cone, like the ADQL TOP/ORDER BY would. `fail(ra, dec, radius)` -> bool makes a cone fail."""
    async def fake(ra, dec, radius, limit):
        if calls is not None:
            calls.append((ra, dec, radius, limit))
        if fail is not None and fail(ra, dec, radius):
            raise UpstreamError("Gaia TAP: Job timeout/aborted.")
        inside = [s for s in stars
                  if scene3d.angsep_deg(ra, dec, float(s["ra"]), float(s["dec"])) <= radius]
        inside.sort(key=lambda s: float(s["phot_g_mean_mag"]))
        return inside[:limit]
    return fake


def _star(i: int, ra: float, dec: float, g: float) -> dict:
    return {"source_id": str(10**18 + i), "ra": repr(ra), "dec": repr(dec),
            "phot_g_mean_mag": repr(g), "bp_rp": "0.5", "r_med_geo": "100.0",
            "r_lo_geo": "90.0", "r_hi_geo": "110.0"}


# --- validation -------------------------------------------------------------------------

@pytest.mark.parametrize("params", [
    {"ra": 360, "dec": 0},
    {"ra": -1, "dec": 0},
    {"ra": 10, "dec": 91},
    {"ra": 10, "dec": -90.5},
    {"ra": 10, "dec": 0, "radius": 0.05},
    {"ra": 10, "dec": 0, "radius": 5.5},
    {"ra": 10, "dec": 0, "limit": 99},
    {"ra": 10, "dec": 0, "limit": 50001},
    {"ra": 10, "dec": 0, "mjd": 1000.0},
    {"ra": 10, "dec": 0, "mjd": float("nan")},
])
def test_validation_is_json_400(params, monkeypatch):
    monkeypatch.setattr(scene3d, "_gaia_csv", _fake_gaia(0))
    r = client.get("/api/scene3d", params=params)
    assert r.status_code == 400 and "detail" in r.json()


# --- tiling ----------------------------------------------------------------------------

def test_single_tile_when_radius_small():
    assert scene3d.tile_centres(10.0, 20.0, 0.5) == [(10.0, 20.0, 0.5)]
    tr = scene3d.TILE_R_DEG
    assert scene3d.tile_centres(10.0, 20.0, tr) == [(10.0, 20.0, tr)]
    assert len(scene3d.tile_centres(10.0, 20.0, tr + 0.2)) > 1


@pytest.mark.parametrize("ra,dec,radius", [
    (83.82, -5.39, 3.0),   # Orion
    (0.3, 89.0, 3.0),      # near the north pole, RA ~ 0
    (359.7, -89.0, 4.0),   # near the south pole, across RA = 0/360
    (10.0, 89.9, 5.0),     # very close to the pole, largest radius
    (180.0, 0.0, 5.0),
    (0.0, 0.0, 2.0),
])
def test_tile_coverage(ra, dec, radius):
    """Every point within `radius` of the centre is within TILE_R of a tile centre, and every
    tile reaches the query disk."""
    tiles = scene3d.tile_centres(ra, dec, radius)
    assert len(tiles) > 1
    tr = scene3d.TILE_R_DEG
    for tra, tdec, trad in tiles:
        assert trad == tr
        assert scene3d.angsep_deg(ra, dec, tra, tdec) <= radius + tr + 1e-9
    rng = random.Random(7)
    pts = []
    for _ in range(1500):  # random points in the disk (gnomonic offsets: exact angular distance)
        r = math.degrees(math.atan(math.tan(math.radians(radius)) * math.sqrt(rng.random())))
        pts.append((r, rng.uniform(0, 360)))
    pts += [(radius, a) for a in range(0, 360, 3)]  # the edge of the disk, where coverage is hardest
    a0, d0 = math.radians(ra), math.radians(dec)
    worst = 0.0
    for r_deg, theta_deg in pts:
        t = math.tan(math.radians(r_deg))
        th = math.radians(theta_deg)
        pra, pdec = scene3d._gnomonic_inv(a0, d0, t * math.cos(th), t * math.sin(th))
        pra, pdec = math.degrees(pra) % 360.0, math.degrees(pdec)
        assert scene3d.angsep_deg(ra, dec, pra, pdec) <= radius + 1e-6
        nearest = min(scene3d.angsep_deg(pra, pdec, tra, tdec) for tra, tdec, _ in tiles)
        worst = max(worst, nearest)
    assert worst <= tr, f"uncovered point, nearest tile {worst:.4f} deg away"


def test_gnomonic_inverse_angles():
    a0, d0 = math.radians(120.0), math.radians(-70.0)
    for xi, eta in [(0.01, 0.0), (0.0, -0.02), (0.03, 0.02)]:
        ra, dec = scene3d._gnomonic_inv(a0, d0, xi, eta)
        sep = scene3d.angsep_deg(math.degrees(a0), math.degrees(d0), math.degrees(ra), math.degrees(dec))
        assert sep == pytest.approx(math.degrees(math.atan(math.hypot(xi, eta))), abs=1e-9)


def test_tile_cap_values():
    assert scene3d.tile_cap(20000, 3.0) == math.ceil(2.5 * 20000 * (1.0 / 9.0))  # 5556
    assert scene3d.tile_cap(100, 3.0) == 28
    assert scene3d.tile_cap(20000, 0.8) == 20000  # a single cone keeps the exact limit
    assert scene3d.tile_cap(20000, 1.0) == 20000
    assert scene3d.tile_cap(10, 3.0) == 3  # ceil(2.5 * 10 / 9)
    assert all(scene3d.tile_cap(n, 3.0) <= n for n in (1, 10, 100, 20000))


# --- source selection and fallback ------------------------------------------------------

@pytest.mark.parametrize("source,fetcher", [("gavo", "_gavo_csv"), ("ari", "_ari_csv")])
def test_single_query_primary_answers_the_whole_cone(monkeypatch, source, fetcher):
    monkeypatch.setattr(config, "GAIA3D_SOURCE", source)
    calls = []

    async def primary(ra, dec, radius, limit):
        calls.append((radius, limit))
        return _gaia_rows(3)

    async def esa(*a):
        raise AssertionError("the ESA archive must not be queried when the primary works")
    monkeypatch.setattr(scene3d, fetcher, primary)
    monkeypatch.setattr(scene3d, "_gaia_csv", esa)
    res = asyncio.run(scene3d.stars_block(*ORION, 3.0, 20000))
    assert calls == [(3.0, 20000)]  # one query, no tiling
    assert res["source"] == source and res["incomplete"] is False and res["failed_tiles"] == 0
    assert len(res["rows"]) == 3


def test_primary_failure_falls_back_to_esa_tiles(monkeypatch):
    monkeypatch.setattr(config, "GAIA3D_SOURCE", "gavo")

    async def gavo_down(*a):
        raise UpstreamError("GAVO TAP: HTTP 503")
    esa_calls = []
    monkeypatch.setattr(scene3d, "_gavo_csv", gavo_down)
    monkeypatch.setattr(scene3d, "_gaia_csv", _fake_gaia(2, esa_calls))
    res = asyncio.run(scene3d.stars_block(*ORION, 3.0, 20000))
    assert res["source"] == "esa" and res["failed_tiles"] == 0
    assert len(esa_calls) == len(scene3d.tile_centres(*ORION, 3.0))


def test_esa_is_the_primary_when_configured(monkeypatch):
    monkeypatch.setattr(config, "GAIA3D_SOURCE", "esa")

    async def gavo(*a):
        raise AssertionError("GAVO must not be queried when ESA is the primary")
    monkeypatch.setattr(scene3d, "_gavo_csv", gavo)
    monkeypatch.setattr(scene3d, "_gaia_csv", _fake_gaia(1))
    res = asyncio.run(scene3d.stars_block(*ORION, 2.0, 100))
    assert res["source"] == "esa"


def test_source_label_in_response(monkeypatch):
    monkeypatch.setattr(scene3d, "_gaia_csv", _fake_gaia(2))
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot())
    j = client.get("/api/scene3d", params={"ra": 1, "dec": 1, "mjd": MJD}).json()
    assert j["stars"]["source"] == scene3d.SOURCE_LABELS["esa"]


def test_unknown_source_is_rejected_at_config_time(monkeypatch):
    import importlib
    monkeypatch.setenv("SPHEREX_GAIA3D_SOURCE", "nope")
    with pytest.raises(ValueError):
        importlib.reload(config)
    monkeypatch.delenv("SPHEREX_GAIA3D_SOURCE")
    importlib.reload(config)


# --- column mapping of the mirrors ---------------------------------------------------------

def test_gavo_columns_map_to_records(monkeypatch):
    seen = {}

    async def fake_tap(url, adql, **kw):
        seen.update(url=url, adql=adql, **kw)
        return [
            {"source_id": "123", "ra": "83.8", "dec": "-5.4", "phot_g_mean_mag": "10",
             "phot_bp_mean_mag": "11", "phot_rp_mean_mag": "9.5",
             "r_med_geo": "400", "r_lo_geo": "380", "r_hi_geo": "420"},
            {"source_id": "124", "ra": "83.9", "dec": "-5.4", "phot_g_mean_mag": "12",
             "phot_bp_mean_mag": "", "phot_rp_mean_mag": "11",
             "r_med_geo": "900", "r_lo_geo": "800", "r_hi_geo": "1000"},
        ]
    monkeypatch.setattr(catalogs, "tap_csv", fake_tap)
    rows = asyncio.run(scene3d._gavo_csv(*ORION, 3.0, 20000))
    assert seen["url"] == config.GAVO_TAP_SYNC
    assert seen["extra"] == {"MAXREC": "20000"}
    assert "gedr3dist.litewithdist" in seen["adql"] and "TOP 20000" in seen["adql"]
    recs = [scene3d._record(r) for r in rows]
    assert recs[0][0] == "123" and recs[0][3] == 10.0
    assert recs[0][4] == pytest.approx(1.5)  # bp_rp = BP - RP
    assert recs[1][4] is None                 # BP missing -> no colour
    assert recs[0][5:] == [400.0, 380.0, 420.0]


def test_ari_columns_map_to_records(monkeypatch):
    seen = {}

    async def fake_tap(url, adql, **kw):
        seen.update(url=url, adql=adql, **kw)
        return [{"source_id": "9", "ra": "83.8", "dec": "-5.4", "phot_g_mean_mag": "8.5",
                 "bp_rp": "0.75", "r_med_geo": "250", "r_lo_geo": "240", "r_hi_geo": "260"}]
    monkeypatch.setattr(catalogs, "tap_csv", fake_tap)
    rows = asyncio.run(scene3d._ari_csv(*ORION, 3.0, 5000))
    assert seen["url"] == config.ARI_TAP_SYNC and seen["extra"] == {"MAXREC": "5000"}
    assert "gaiaedr3_complements.distances" in seen["adql"]
    rec = scene3d._record(rows[0])
    assert rec[4] == 0.75 and rec[5] == 250.0 and rec[6] == 240.0 and rec[7] == 260.0


def test_esa_tile_fetch_is_single_attempt(monkeypatch):
    seen = {}

    async def fake_tap(url, adql, **kw):
        seen.update(url=url, **kw)
        return []
    monkeypatch.setattr(catalogs, "tap_csv", fake_tap)
    asyncio.run(scene3d._gaia_csv(*ORION, 1.0, 100))
    assert seen["url"] == config.GAIA_TAP_SYNC and seen["attempts"] == 1


# --- merge -----------------------------------------------------------------------------

def _random_field(seed: int, n: int, centre: tuple[float, float], half: float) -> list[dict]:
    rng = random.Random(seed)
    ra0, dec0 = centre
    stars = []
    for i in range(n):
        ra = (ra0 + rng.uniform(-half, half) / max(math.cos(math.radians(dec0)), 0.1)) % 360.0
        dec = max(-90.0, min(90.0, dec0 + rng.uniform(-half, half)))
        stars.append(_star(i, ra, dec, 5.0 + rng.random() * 15.0 + i * 1e-6))
    return stars


def test_single_cone_is_exact(monkeypatch):
    """Radius within one tile: the result is exactly the brightest `limit` stars of the cone."""
    stars = _random_field(4, 800, ORION, 0.8)
    monkeypatch.setattr(scene3d, "_gaia_csv", _catalogue_fake(stars))
    res = asyncio.run(scene3d.stars_block(*ORION, 0.9, 50))
    inside = sorted((s for s in stars
                     if scene3d.angsep_deg(*ORION, float(s["ra"]), float(s["dec"])) <= 0.9),
                    key=lambda s: float(s["phot_g_mean_mag"]))
    assert [row[0] for row in res["rows"]] == [s["source_id"] for s in inside[:50]]
    assert res["truncated"] is (len(inside) > 50)


def test_tiled_merge_is_exact_when_not_truncated(monkeypatch):
    """Dedupe, radius filter and brightest-limit over the tile union equal a direct query,
    whenever no tile hit its cap."""
    ra0, dec0, radius, limit = ORION[0], ORION[1], 2.6, 3000
    stars = _random_field(3, 1500, (ra0, dec0), 3.0)
    monkeypatch.setattr(scene3d, "_gaia_csv", _catalogue_fake(stars))
    res = asyncio.run(scene3d.stars_block(ra0, dec0, radius, limit))
    inside = sorted((s for s in stars
                     if scene3d.angsep_deg(ra0, dec0, float(s["ra"]), float(s["dec"])) <= radius),
                    key=lambda s: float(s["phot_g_mean_mag"]))
    got_ids = [row[0] for row in res["rows"]]
    assert res["truncated"] is False
    assert got_ids == [s["source_id"] for s in inside[:limit]]
    assert len(set(got_ids)) == len(got_ids)  # no duplicates across tiles


def test_tiled_result_under_cap_is_a_subset_of_the_truth(monkeypatch):
    """With a small limit the per-tile cap binds: the result is truncated and every returned
    star really lies in the cone."""
    ra0, dec0, radius, limit = ORION[0], ORION[1], 2.6, 30
    stars = _random_field(3, 1500, (ra0, dec0), 3.0)
    monkeypatch.setattr(scene3d, "_gaia_csv", _catalogue_fake(stars))
    res = asyncio.run(scene3d.stars_block(ra0, dec0, radius, limit))
    truth = {s["source_id"] for s in stars
             if scene3d.angsep_deg(ra0, dec0, float(s["ra"]), float(s["dec"])) <= radius}
    got = [row[0] for row in res["rows"]]
    assert len(got) == limit and set(got) <= truth and res["truncated"] is True


def test_per_tile_cap_is_used_and_marks_truncated(monkeypatch):
    limits = []
    cap = scene3d.tile_cap(20000, 3.0)

    async def fake(ra, dec, radius, limit):
        limits.append(limit)
        return _gaia_rows(limit)  # every tile returns its full TOP
    monkeypatch.setattr(scene3d, "_gaia_csv", fake)
    res = asyncio.run(scene3d.stars_block(*ORION, 3.0, 20000))
    assert limits and set(limits) == {cap} and cap < 20000
    assert res["truncated"] is True


def test_truncated_when_a_single_cone_hits_the_limit(monkeypatch):
    monkeypatch.setattr(scene3d, "_gaia_csv", _fake_gaia(100))
    res = asyncio.run(scene3d.stars_block(83.8, -5.4, 0.5, 100))
    assert res["truncated"] is True and len(res["rows"]) == 100
    monkeypatch.setattr(scene3d, "_gaia_csv", _fake_gaia(99))
    res = asyncio.run(scene3d.stars_block(83.9, -5.4, 0.5, 100))
    assert res["truncated"] is False


def test_dedupe_across_overlapping_tiles(monkeypatch):
    stars = [_star(0, *ORION, 9.0)]  # right at the query centre: in every tile
    calls = []
    monkeypatch.setattr(scene3d, "_gaia_csv", _catalogue_fake(stars, calls))
    res = asyncio.run(scene3d.stars_block(*ORION, 3.0, 100))
    assert len(calls) > 1 and [row[0] for row in res["rows"]] == [stars[0]["source_id"]]


def test_at_most_two_tiles_in_flight(monkeypatch):
    state = {"now": 0, "peak": 0}

    async def fake(ra, dec, radius, limit):
        state["now"] += 1
        state["peak"] = max(state["peak"], state["now"])
        await asyncio.sleep(0.01)
        state["now"] -= 1
        return []
    monkeypatch.setattr(scene3d, "_gaia_csv", fake)
    asyncio.run(scene3d.stars_block(*ORION, 3.0, 100))
    assert 1 < state["peak"] <= config.GAIA3D_TILE_CONCURRENCY == 2


# --- partial failure, negative cache, per-tile cache -----------------------------------------

def test_partial_failure_returns_incomplete(monkeypatch):
    ra0, dec0, radius = ORION[0], ORION[1], 3.0
    stars = _random_field(5, 800, (ra0, dec0), 3.0)
    tiles = scene3d.tile_centres(ra0, dec0, radius)
    bad = tiles[0][:2]
    monkeypatch.setattr(scene3d, "_gaia_csv",
                        _catalogue_fake(stars, fail=lambda ra, dec, r: (ra, dec) == bad))
    res = asyncio.run(scene3d.stars_block(ra0, dec0, radius, 100000))
    assert res["incomplete"] is True and res["failed_tiles"] == 1 and len(res["rows"]) > 0
    assert res["truncated"] is False


def test_all_tiles_failing_raises_upstream(monkeypatch):
    monkeypatch.setattr(scene3d, "_gaia_csv", _catalogue_fake([], fail=lambda *a: True))
    with pytest.raises(UpstreamError):
        asyncio.run(scene3d.stars_block(*ORION, 3.0, 100))


def test_failed_tile_is_skipped_within_ttl_then_retried(monkeypatch):
    """A tile that failed is not queried again for GAIA3D_TILE_FAIL_TTL_S; the others come from
    the disk cache, so the retry touches nothing. After the TTL the failed tile is retried."""
    ra0, dec0, radius = ORION[0], ORION[1], 2.0
    stars = _random_field(9, 300, (ra0, dec0), 2.0)
    tiles = scene3d.tile_centres(ra0, dec0, radius)
    bad = tiles[1][:2]
    state = {"fail": True}
    calls: list = []
    monkeypatch.setattr(scene3d, "_gaia_csv", _catalogue_fake(
        stars, calls, fail=lambda ra, dec, r: state["fail"] and (ra, dec) == bad))

    first = asyncio.run(scene3d.stars_block(ra0, dec0, radius, 500))
    assert first["incomplete"] and first["failed_tiles"] == 1 and len(calls) == len(tiles)

    state["fail"] = False
    calls.clear()
    second = asyncio.run(scene3d.stars_block(ra0, dec0, radius, 500))
    assert calls == []  # the failed tile is skipped (negative cache); the rest are cached
    assert second["incomplete"] and second["failed_tiles"] == 1

    monkeypatch.setattr(config, "GAIA3D_TILE_FAIL_TTL_S", 0.0)  # TTL over
    calls.clear()
    third = asyncio.run(scene3d.stars_block(ra0, dec0, radius, 500))
    assert [c[:2] for c in calls] == [bad]  # only the previously failed tile is queried
    assert third["incomplete"] is False and third["failed_tiles"] == 0


def test_all_tiles_recently_failed_is_502(monkeypatch):
    monkeypatch.setattr(scene3d, "_gaia_csv", _catalogue_fake([], fail=lambda *a: True))
    with pytest.raises(UpstreamError):
        asyncio.run(scene3d.stars_block(*ORION, 2.0, 100))
    calls = []
    monkeypatch.setattr(scene3d, "_gaia_csv", _catalogue_fake([], calls))
    with pytest.raises(UpstreamError):  # every tile is still in the negative cache
        asyncio.run(scene3d.stars_block(*ORION, 2.0, 100))
    assert calls == []


def test_cone_block_is_disk_cached(monkeypatch):
    calls = []
    monkeypatch.setattr(scene3d, "_gaia_csv", _fake_gaia(2, calls))
    a = asyncio.run(scene3d.cone_block("esa", 1.0, 2.0, 0.5, 100))
    b = asyncio.run(scene3d.cone_block("esa", 1.0, 2.0, 0.5, 100))
    assert a == b and len(calls) == 1 and a["n_raw"] == 2


# --- math and rows ----------------------------------------------------------------------

def test_radec_to_xyz_axes():
    x, y, z = scene3d.radec_to_xyz(0.0, 0.0, 10.0)
    assert (x, y, z) == pytest.approx((10.0, 0.0, 0.0), abs=1e-12)
    x, y, z = scene3d.radec_to_xyz(90.0, 0.0, 10.0)
    assert (x, y, z) == pytest.approx((0.0, 10.0, 0.0), abs=1e-12)
    x, y, z = scene3d.radec_to_xyz(123.0, 90.0, 10.0)
    assert (x, y, z) == pytest.approx((0.0, 0.0, 10.0), abs=1e-9)
    x, y, z = scene3d.radec_to_xyz(0.0, -60.0, 2.0)
    assert z == pytest.approx(-2.0 * math.sin(math.radians(60))) and x > 0


def test_star_rows_abs_g_and_fields():
    rows = [
        {"source_id": "3017364063330718080", "ra": "0", "dec": "0", "phot_g_mean_mag": "10",
         "bp_rp": "0.5", "r_med_geo": "100", "r_lo_geo": "90", "r_hi_geo": "110"},
        {"source_id": "42", "ra": "0", "dec": "90", "phot_g_mean_mag": "12",
         "bp_rp": "", "r_med_geo": "1000", "r_lo_geo": "900", "r_hi_geo": "1100"},
        {"source_id": "", "ra": "0", "dec": "0", "phot_g_mean_mag": "10", "r_med_geo": "100"},
        {"source_id": "7", "ra": "0", "dec": "0", "phot_g_mean_mag": "10", "r_med_geo": ""},
    ]
    out = scene3d.star_rows_from_csv(rows)
    assert len(out) == 2
    sid, x, y, z, absg, bp, lo, hi = out[0]
    assert isinstance(sid, str) and sid == "3017364063330718080"
    assert (x, y, z) == pytest.approx((100.0, 0.0, 0.0))
    assert absg == pytest.approx(5.0, abs=1e-6)  # 10 + 5 - 10
    assert bp == 0.5 and lo == 90.0 and hi == 110.0
    sid, x, y, z, absg, bp, lo, hi = out[1]
    assert (x, y, z) == pytest.approx((0.0, 0.0, 1000.0), abs=1e-3)
    assert absg == pytest.approx(12 + 5 - 5 * math.log10(1000.0), abs=1e-6)
    assert bp is None


def test_bodies_xyz_adds_earth_and_skips_missing_distance():
    earth = [1.0, 0.0, 0.0]
    objs = [
        {"name": "A", "number": 1, "class": "MB", "vmag": 12.0, "ra": 0.0, "dec": 0.0,
         "dg_au": 2.0, "dh_au": 3.0},
        {"name": "B", "number": None, "class": None, "vmag": None, "ra": 0.0, "dec": 90.0,
         "dg_au": None, "dh_au": None},
    ]
    out = scene3d.bodies_xyz(earth, objs)
    assert len(out) == 1
    b = out[0]
    assert (b["x"], b["y"], b["z"]) == pytest.approx((3.0, 0.0, 0.0))
    assert b["dg_au"] == 2.0 and b["dh_au"] == 3.0 and b["name"] == "A"


def test_solar_planets_and_earth_distance():
    sol = scene3d.solar_positions(MJD)
    names = [p["name"] for p in sol["planets"]]
    assert names == ["Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Moon"]
    earth_r = math.sqrt(sum(c * c for c in sol["earth"]))
    assert 0.98 < earth_r < 1.02
    moon = sol["planets"][-1]
    assert math.dist([moon["x"], moon["y"], moon["z"]], sol["earth"]) < 0.01
    neptune = sol["planets"][6]
    assert 29.5 < math.hypot(neptune["x"], neptune["y"], neptune["z"]) < 30.5


# --- route ------------------------------------------------------------------------------

def test_scene_response_shape_and_fields(monkeypatch):
    seen = []
    monkeypatch.setattr(scene3d, "_gaia_csv", _fake_gaia(3, seen))
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot(objs=[
        {"name": "Ceres", "number": 1, "class": "MBA", "vmag": 8.1, "ra": 83.8, "dec": -5.4,
         "dg_au": 1.5, "dh_au": 2.6}]))
    r = client.get("/api/scene3d", params={"ra": 83.82, "dec": -5.39, "radius": 2, "limit": 500,
                                           "mjd": MJD})
    assert r.status_code == 200
    j = r.json()
    assert set(j) == {"ra", "dec", "radius", "mjd", "stars", "solar"}
    assert j["mjd"] == MJD and j["radius"] == 2.0
    st = j["stars"]
    assert set(st) == {"epoch", "source", "fields", "rows", "truncated", "incomplete", "failed_tiles"}
    assert st["epoch"] == 2016.0 and st["fields"] == scene3d.STAR_FIELDS
    assert st["truncated"] is False and st["incomplete"] is False and st["failed_tiles"] == 0
    assert len(st["rows"]) == 3  # the same three stars come back from every tile: deduped
    assert all(isinstance(row[0], str) and len(row) == 8 for row in st["rows"])
    assert len(seen) == len(scene3d.tile_centres(83.82, -5.39, 2.0))
    so = j["solar"]
    assert set(so) == {"earth", "sun", "planets", "bodies", "bodies_error"}
    assert so["sun"] == [0, 0, 0] and so["bodies_error"] is None
    assert len(so["earth"]) == 3 and len(so["planets"]) == 8
    assert set(so["planets"][0]) == {"name", "x", "y", "z"}
    b = so["bodies"][0]
    assert set(b) == {"name", "number", "class", "vmag", "x", "y", "z", "dg_au", "dh_au"}
    assert b["name"] == "Ceres" and b["number"] == 1


def test_skybot_failure_does_not_fail_request(monkeypatch):
    monkeypatch.setattr(scene3d, "_gaia_csv", _fake_gaia(2))
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot(exc=RuntimeError("SkyBoT down")))
    r = client.get("/api/scene3d", params={"ra": 1, "dec": 1, "mjd": MJD})
    assert r.status_code == 200
    so = r.json()["solar"]
    assert so["bodies"] == [] and so["bodies_error"] == "SkyBoT down"
    assert len(so["planets"]) == 8


def test_star_total_failure_is_502(monkeypatch):
    monkeypatch.setattr(scene3d, "_gaia_csv", _catalogue_fake([], fail=lambda *a: True))
    monkeypatch.setattr(movers, "skybot_cone", _fake_skybot())
    r = client.get("/api/scene3d", params={"ra": 1, "dec": 1, "mjd": MJD})
    assert r.status_code == 502 and "detail" in r.json()
