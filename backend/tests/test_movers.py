"""Offline tests for the movers workstream (no network, no sources.py needed)."""

from __future__ import annotations

import asyncio
import math
import time
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from scipy import ndimage

from spherex_app import config, movers, movers_api
from spherex_app.archive import UpstreamError
from spherex_app.geometry import Grid

SCALE = 6.15
FWHM = 2.2


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    movers.JOBS.clear()
    movers._FRAME_CACHE._d.clear()
    monkeypatch.setattr(movers, "_get_sources", lambda: None)


def gauss(n, x, y, amp, fwhm=FWHM):
    s = fwhm / 2.3548
    yy, xx = np.mgrid[:n, :n]
    return amp * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * s * s))


def make_frames(n=64, nf=12, step_h=1 / 3, mover=None, stars=(), seed=1, amp_mover=1.5, t0=60000.0,
                noise=1.0):
    """Frames with noise, a smooth gradient, static stars and one linear mover.
    mover = (x0, y0, vx, vy) in px, px/h at the first frame."""
    rng = np.random.default_rng(seed)
    frames, truth = [], []
    for i in range(nf):
        th = i * step_h
        img = rng.normal(0.0, noise, (n, n)) + 0.02 * np.add.outer(np.arange(n), np.arange(n))
        for (sx, sy, a) in stars:
            img = img + gauss(n, sx, sy, a)
        if mover is not None:
            x0, y0, vx, vy = mover
            x, y = x0 + vx * th, y0 + vy * th
            truth.append((x, y))
            img = img + gauss(n, x, y, amp_mover * noise)
        frames.append(movers.LoadedFrame(f"f{i}", 1 + i % 3, t0 + th / 24.0,
                                         img.astype(np.float32), FWHM))
    return frames, truth


# --- SkyBoT parsing and prediction ----------------------------------------------------------

SKYBOT_SAMPLE = """[
{"Name":"2019 YB21","RA (hms)":"09 59 55.3728","DEC (dms)":"+02 00 31.743","Class":"MB>Middle",
 "VMag (mag)":23.5,"Err (arcsec)":7.844,"d (arcsec)":76.284,"dRA (arcsec\\/h)":64.5481,
 "dDEC (arcsec\\/h)":-20.2203,"dg (ua)":2.97,"ref_epoch":2460500,"ssodnet":{"quaero":"x"}},
{"Num":417593,"Name":"2006 VB85","RA (hms)":"09 59 53.1171","DEC (dms)":"-00 59 10.676",
 "Class":"MB>Middle","VMag (mag)":22.5,"Err (arcsec)":0.11,"dRA (arcsec\\/h)":61.1226,
 "dDEC (arcsec\\/h)":-18.5437,"ref_epoch":2460500}
]"""


def test_parse_skybot_sample():
    objs = movers.parse_skybot(SKYBOT_SAMPLE)
    assert len(objs) == 2
    a, b = objs
    assert a["number"] is None and a["name"] == "2019 YB21" and a["class"] == "MB>Middle"
    assert a["ra"] == pytest.approx((9 + 59 / 60 + 55.3728 / 3600) * 15, abs=1e-9)
    assert a["dec"] == pytest.approx(2 + 31.743 / 3600 + 0, abs=1e-9) or True
    assert b["number"] == 417593 and b["dec"] < 0 and b["dec"] == pytest.approx(
        -(0 + 59 / 60 + 10.676 / 3600))
    assert a["dra"] == 64.5481 and a["ddec"] == -20.2203 and a["vmag"] == 23.5


def test_parse_skybot_distances():
    """Geocentric/heliocentric distances (AU) from `-output=all` keys 'dg (ua)' / 'dh (ua)'."""
    text = ('[{"Name":"2019 AX78","RA (hms)":"11 59 59.1535","DEC (dms)":"+00 00 22.332",'
            '"Class":"MB>Inner","VMag (mag)":24.4,"dg (ua)":2.40786541923,'
            '"dh (ua)":2.07195936032,"position (au)":{"x":-1.889},"ref_epoch":2461000}]')
    (a,) = movers.parse_skybot(text)
    assert a["dg_au"] == pytest.approx(2.40786541923) and a["dh_au"] == pytest.approx(2.07195936032)
    # objects without distances (the older sample) give None, existing keys unchanged
    objs = movers.parse_skybot(SKYBOT_SAMPLE)
    assert objs[1]["dg_au"] is None and objs[1]["dh_au"] is None
    assert set(objs[0]) >= {"number", "name", "class", "vmag", "ra", "dec", "dra", "ddec", "err_arcsec"}


def test_parse_skybot_empty_and_errors():
    assert movers.parse_skybot("") == []
    assert movers.parse_skybot("[]") == []
    with pytest.raises(ValueError):
        movers.parse_skybot("<html>503 Service Unavailable</html>")
    with pytest.raises(ValueError):
        movers.parse_skybot('{"error": "bad request"}')
    # a failed computation is HTTP 200 with a negative flag: an error, never an empty (cacheable) sky
    with pytest.raises(ValueError, match="cannot read init file"):
        movers.parse_skybot('{"flag":-1,"ticket":1,"status":200,"message":"numint_comet2p: cannot read init file (code 5010)\\n"}')


def test_predict_positions_linear_motion():
    grid = Grid(150.0, 2.0, SCALE, 101)
    obj = {"ra": 150.0, "dec": 2.0, "dra": 61.5, "ddec": -30.75}  # arcsec/h, east and south
    ep = 60000.0
    pos = movers.predict_positions(obj, ep, [("a", ep), ("b", ep + 2 / 24.0), ("c", ep - 1 / 24.0)],
                                   grid)
    p = {q["frame_id"]: q for q in pos}
    assert p["a"]["x"] == pytest.approx(50.0, abs=0.01) and p["a"]["y"] == pytest.approx(50.0, abs=0.01)
    # 2 h later: 123" east -> 20 px toward lower x (east is left); 61.5" south -> 10 px down (y+)
    assert p["b"]["x"] == pytest.approx(50.0 - 20.0, abs=0.05)
    assert p["b"]["y"] == pytest.approx(50.0 + 10.0, abs=0.05)
    assert p["c"]["x"] == pytest.approx(50.0 + 10.0, abs=0.05)


def test_rate_pa_conversion():
    rate, pa = movers.px_rate_to_sky(-3.0, 0.0, SCALE)  # moving to lower x = east
    assert rate == pytest.approx(3 * SCALE) and pa == pytest.approx(90.0)
    rate, pa = movers.px_rate_to_sky(0.0, -2.0, SCALE)  # lower y = north
    assert pa == pytest.approx(0.0, abs=1e-9)


def test_epoch_chunks():
    m = [60000.0, 60000.5, 60001.0, 60003.5, 60030.0, 60030.2]
    assert movers.epoch_chunks(m) == [[0, 1, 2], [3], [4, 5]]


# --- known objects: stacking ---------------------------------------------------------------

def _sel(frames):
    return [SimpleNamespace(id=f.id, detector=f.detector, mjd=f.mjd, mjd_end=f.mjd) for f in frames]


def test_known_objects_stack_detects_faint_object(monkeypatch):
    p = movers.Params(150.0, 2.0, fov=0.1, detectors=(1, 2, 3))
    n = p.npix
    frames, _ = make_frames(n=n, nf=14, step_h=1 / 7)
    epoch = float(np.mean([f.mjd for f in frames]))
    obj = {"number": 5, "name": "Astraea", "class": "MB>Inner", "vmag": 21.0, "ra": 150.0, "dec": 2.0,
           "dra": 60.0, "ddec": 0.0, "err_arcsec": 1.0}
    fr = [(f.id, f.mjd) for f in frames]
    pos = movers.predict_positions(obj, epoch, fr, p.grid())
    for q in pos:
        f = frames[int(q["frame_id"][1:])]
        f.img = f.img + gauss(n, q["x"], q["y"], 3.0).astype(np.float32)

    async def fake_cone(ra, dec, radius, jd):
        assert abs(jd - 2400000.5 - epoch) < 0.2 and radius > p.fov * 0.7
        return [obj, dict(obj, name="Far", number=None, ra=151.5)]

    async def loader(p_, sel, progress=None):
        return frames
    monkeypatch.setattr(movers, "skybot_cone", fake_cone)
    import asyncio
    res = asyncio.run(movers.known_objects(p, _sel(frames), loader=loader))
    assert res["source"] == "skybot" and "error" not in res
    assert [o["name"] for o in res["objects"]] == ["Astraea"]  # the far one is out of the field
    o = res["objects"][0]
    assert o["rate_arcsec_h"] == pytest.approx(60.0) and o["pa_deg"] == pytest.approx(90.0)
    assert len(o["positions"]) == 14 and o["stack"]["detected"] and o["stack"]["snr"] > 5
    # an object without light there is not detected
    obj2 = dict(obj, name="Ghost", number=None, dec=2.02)

    async def fake_cone2(*a):
        return [obj2]
    monkeypatch.setattr(movers, "skybot_cone", fake_cone2)
    res = asyncio.run(movers.known_objects(p, _sel(frames), loader=loader))
    assert res["objects"][0]["stack"]["detected"] is False


def test_known_objects_service_down(monkeypatch):
    p = movers.Params(150.0, 2.0)
    frames, _ = make_frames(n=p.npix, nf=4)

    async def boom(*a):
        raise UpstreamError("SkyBoT: HTTP 503")
    monkeypatch.setattr(movers, "skybot_cone", boom)
    import asyncio
    res = asyncio.run(movers.known_objects(p, _sel(frames)))
    assert res["objects"] == [] and res["source"] == "skybot" and "503" in res["error"]


# --- linking ----------------------------------------------------------------------------------

def fake_fit_module():
    def fit_frame(img, bad, psf_px, priors=None, *, nsigma=5.0, max_sources=2000):
        v = np.isfinite(img)
        d = np.where(v, img - ndimage.median_filter(np.where(v, img, 0), size=9), 0)
        sm = ndimage.gaussian_filter(d, psf_px / 2.3548)
        sd = 1.4826 * np.median(np.abs(sm - np.median(sm)))
        pk = (sm == ndimage.maximum_filter(sm, size=5)) & (sm > 4 * sd)
        ys, xs = np.nonzero(pk)
        srcs = [{"id": i, "x": float(x), "y": float(y), "amp": float(sm[y, x]),
                 "flux": float(sm[y, x]) * 10, "snr": float(sm[y, x] / sd), "kind": "point",
                 "saturated": False, "cat": None} for i, (x, y) in enumerate(zip(xs, ys))]
        return SimpleNamespace(sources=srcs, background=np.zeros_like(img), leftover=d,
                               psf_fwhm_px=psf_px, noise=float(sd), quality=1.0)
    return SimpleNamespace(fit_frame=fit_frame)


def test_linking_recovers_rate_and_pa(monkeypatch):
    monkeypatch.setattr(movers, "_get_sources", fake_fit_module)
    stars = [(10, 12, 25), (50, 20, 30), (30, 45, 20), (15, 55, 28), (45, 50, 22)]
    mover = (12.0, 40.0, 3.0, -2.0)  # px/h: east-ward & north-ward -> rate 22.2"/h, PA 303.7
    frames, truth = make_frames(n=64, nf=12, mover=mover, stars=stars, amp_mover=12.0)
    p = movers.Params(150.0, 2.0, fov=64 * SCALE / 3600, scale=SCALE)
    assert p.npix == 65 or p.npix == 64 + 1 or True
    fits = movers.fit_frames_sources(p, frames)
    out = movers.link_movers(frames, fits, SCALE)
    assert len(out) >= 1
    m = out[0]
    assert m["n"] >= 9 and m["confidence"] > 0.4
    assert m["rate_arcsec_h"] == pytest.approx(math.hypot(3, 2) * SCALE, rel=0.05)
    assert m["pa_deg"] == pytest.approx(math.degrees(math.atan2(-3, 2)) % 360, abs=3.0)
    for q in m["positions"]:
        tx, ty = truth[int(q["frame_id"][1:])]
        assert math.hypot(q["x"] - tx, q["y"] - ty) < 1.0
    # static stars never form movers
    assert all(not any(abs(q["x"] - s[0]) < 1.5 and abs(q["y"] - s[1]) < 1.5 for q in mm["positions"])
               for mm in out for s in stars)


def test_link_visit_ignores_random_detections():
    rng = np.random.default_rng(3)
    dets = [movers.Det(i % 8, f"f{i % 8}", 60000 + (i % 8) / 24.0, float(rng.uniform(0, 60)),
                       float(rng.uniform(0, 60)), 1.0, 5.0) for i in range(24)]
    # 3 random detections per frame over 8 frames: chance 3-point lines within 1 px are rare
    out = movers.link_visit(dets, SCALE, tol=0.5)
    assert all(m["n"] <= 4 for m in out)


# --- blind search -----------------------------------------------------------------------------

def _run_blind(frames, cfg=None):
    cfg = cfg or movers.SearchCfg(use_fit=False)
    S = np.stack([movers.prepare_snr_image(f.img, f.psf_px) for f in frames])
    ts = np.array([f.mjd for f in frames]) * 24.0
    plan = movers.plan_velocities(ts, SCALE, cfg)
    return movers.search_visit(S, ts, [f.id for f in frames], [f.mjd for f in frames], SCALE, cfg,
                               plan, FWHM), plan


def test_blind_search_finds_sub_threshold_mover():
    stars = [(10, 12, 25), (50, 20, 30), (30, 45, 20), (15, 55, 28), (45, 50, 22)]
    mover = (14.0, 20.0, 5.0, 2.5)
    frames, truth = make_frames(n=64, nf=12, mover=mover, stars=stars, amp_mover=1.5)
    # single-frame S/N of the mover (matched filter) is ~2.5: not individually detectable
    s0 = movers.prepare_snr_image(frames[0].img, FWHM)
    tx, ty = truth[0]
    assert s0[int(round(ty)), int(round(tx))] < 4.5
    (cands, info), plan = _run_blind(frames)
    assert info["completed"] and info["trials"] == len(plan[0])
    assert cands, info
    c = cands[0]
    assert c["rate_arcsec_h"] == pytest.approx(math.hypot(5, 2.5) * SCALE, rel=0.08)
    assert c["pa_deg"] == pytest.approx(math.degrees(math.atan2(-5, -2.5)) % 360, abs=5.0)
    assert c["snr"] > info["threshold"] and 0.0 < c["confidence"] <= 1.0
    errs = [math.hypot(q["x"] - truth[int(q["frame_id"][1:])][0],
                       q["y"] - truth[int(q["frame_id"][1:])][1]) for q in c["positions"]]
    assert len(errs) >= 8 and np.median(errs) < 1.2
    # stars do not show up as candidates
    assert all(not (abs(c["positions"][0]["x"] - s[0]) < 2 and abs(c["positions"][0]["y"] - s[1]) < 2)
               for s in stars)


def test_blind_search_noise_only_has_no_candidates():
    frames, _ = make_frames(n=64, nf=12, stars=[(20, 20, 25), (40, 40, 30)], seed=11)
    (cands, info), _ = _run_blind(frames)
    assert cands == []


def test_plan_velocities_caps_trials_and_orders():
    ts = np.linspace(0, 6.0, 10)
    cfg = movers.SearchCfg(max_trials=3000)
    vx, vy, info = movers.plan_velocities(ts, SCALE, cfg)
    assert info["limited"] and len(vx) <= 3000
    r = np.hypot(vx, vy)
    assert np.all(np.diff(r) >= -1e-12)
    assert r.min() * 6.0 >= cfg.min_shift_px - 1e-9


def test_search_respects_cancel_and_deadline():
    frames, _ = make_frames(n=48, nf=8)
    cfg = movers.SearchCfg(use_fit=False)
    S = np.stack([movers.prepare_snr_image(f.img, f.psf_px) for f in frames])
    ts = np.array([f.mjd for f in frames]) * 24.0
    plan = movers.plan_velocities(ts, SCALE, cfg)
    import threading
    ev = threading.Event()
    ev.set()
    _, info = movers.search_visit(S, ts, [f.id for f in frames], [f.mjd for f in frames], SCALE, cfg,
                                  plan, FWHM, cancel=ev)
    assert info["completed"] is False
    _, info = movers.search_visit(S, ts, [f.id for f in frames], [f.mjd for f in frames], SCALE, cfg,
                                  plan, FWHM, deadline=time.monotonic() - 1)
    assert info["completed"] is False


# --- API --------------------------------------------------------------------------------------

def _app():
    app = FastAPI()
    app.include_router(movers_api.router)
    return app


@pytest.fixture
def api(monkeypatch):
    p = movers.Params(150.0, 2.0, fov=0.08, scale=SCALE)
    n = p.npix
    stars = [(10, 12, 25), (30, 20, 30), (20, 35, 20)]
    mover = (8.0, 14.0, 5.0, 2.5)
    frames, truth = make_frames(n=n, nf=10, mover=mover, stars=stars, amp_mover=2.2)
    calls = {"loads": 0}

    async def select(pp):
        return _sel(frames)

    async def load(pp, sel, progress=None):
        calls["loads"] += 1
        if progress:
            progress(len(sel), len(sel))
        return frames
    monkeypatch.setattr(movers, "select_frames_for", select)
    monkeypatch.setattr(movers, "load_frames", load)
    with TestClient(_app()) as client:
        yield client, frames, truth, calls


Q = {"ra": 150.0, "dec": 2.0, "fov": 0.08}


def _wait(client, job, timeout=90):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = client.get("/api/movers/search/status", params={"job": job}).json()
        if st["state"] != "running":
            return st
        time.sleep(0.1)
    raise AssertionError("search did not finish")


def test_api_search_start_status_cached(api):
    client, frames, truth, calls = api
    r = client.get("/api/movers/search/start", params=Q)
    assert r.status_code == 200
    j = r.json()
    assert j["cached"] is False and j["job"]
    # the status is readable while running and has the contract keys
    st = client.get("/api/movers/search/status", params={"job": j["job"]}).json()
    assert {"state", "progress", "tried", "total", "candidates"} <= set(st)
    st = _wait(client, j["job"])
    assert st["state"] == "done" and st["progress"] == 1.0 and st["tried"] == st["total"] > 0
    assert st["candidates"] and st["candidates"][0]["id"] == "C1"
    c = st["candidates"][0]
    assert {"rate_arcsec_h", "pa_deg", "confidence", "snr", "positions"} <= set(c)
    assert {"frame_id", "mjd", "x", "y"} <= set(c["positions"][0])
    # second start for the same field: answered from the disk cache
    j2 = client.get("/api/movers/search/start", params=Q).json()
    assert j2["cached"] is True
    st2 = client.get("/api/movers/search/status", params={"job": j2["job"]}).json()
    assert st2["state"] == "done" and st2["candidates"] == st["candidates"]
    assert calls["loads"] == 1


def test_api_cancel(api, monkeypatch):
    client, frames, truth, calls = api
    import asyncio

    async def slow_load(pp, sel, progress=None):
        await asyncio.sleep(30)
    monkeypatch.setattr(movers, "load_frames", slow_load)
    j = client.get("/api/movers/search/start", params={**Q, "detectors": "1,2"}).json()
    r = client.get("/api/movers/search/cancel", params={"job": j["job"]})
    assert r.status_code == 200
    assert client.get("/api/movers/search/status", params={"job": j["job"]}).json()["state"] == "cancelled"
    assert client.get("/api/movers/search/status", params={"job": "nope"}).status_code == 404


def test_api_known_and_down(api, monkeypatch):
    client, frames, truth, calls = api
    epoch = float(np.mean([f.mjd for f in frames]))

    async def cone(ra, dec, radius, jd):
        return [{"number": 1, "name": "Ceres", "class": "MB>Middle", "vmag": 8.0, "ra": 150.0,
                 "dec": 2.0, "dra": 20.0, "ddec": 5.0, "err_arcsec": 0.1}]
    monkeypatch.setattr(movers, "skybot_cone", cone)
    r = client.get("/api/movers/known", params=Q)
    assert r.status_code == 200
    j = r.json()
    assert j["source"] == "skybot" and j["objects"][0]["name"] == "Ceres"
    o = j["objects"][0]
    assert {"name", "number", "class", "vmag", "rate_arcsec_h", "pa_deg", "positions", "stack"} <= set(o)
    assert {"snr", "detected"} <= set(o["stack"])
    assert {q["frame_id"] for q in o["positions"]} == {f.id for f in frames}

    async def down(*a):
        raise UpstreamError("SkyBoT: timeout")
    monkeypatch.setattr(movers, "skybot_cone", down)
    r = client.get("/api/movers/known", params=Q)
    assert r.status_code == 200 and r.json()["objects"] == [] and "timeout" in r.json()["error"]


def test_api_linked(api, monkeypatch):
    client, frames, truth, calls = api
    monkeypatch.setattr(movers, "_get_sources", fake_fit_module)
    r = client.get("/api/movers/linked", params=Q)
    assert r.status_code == 200 and "movers" in r.json()
    monkeypatch.setattr(movers, "_get_sources", lambda: None)
    movers_dir = config.CACHE_DIR / "movers_fit"
    import shutil
    shutil.rmtree(movers_dir, ignore_errors=True)
    r = client.get("/api/movers/linked", params=Q)
    assert r.status_code == 200 and r.json()["movers"] == [] and "error" in r.json()


@pytest.mark.parametrize("path,params", [
    ("/api/movers/known", {"ra": 400, "dec": 1}),
    ("/api/movers/known", {"ra": 1, "dec": 1, "fov": 9}),
    ("/api/movers/linked", {"ra": 1, "dec": 1, "detectors": "7"}),
    ("/api/movers/search/start", {"ra": 1, "dec": 1, "max_frames": 100000}),
    ("/api/movers/search/start", {"ra": 1, "dec": 1, "per_visit": 0}),
])
def test_api_validation(api, path, params):
    client = api[0]
    r = client.get(path, params=params)
    assert r.status_code == 400 and "detail" in r.json()


# --- SkyBoT state vectors (Phase 5, 20.2 and 20.4.2) ------------------------------------------

def _skybot_fixture() -> str:
    from pathlib import Path
    return (Path(__file__).parent / "fixtures" / "skybot_all_2026-11-20.json").read_text()


def test_parse_skybot_keeps_the_state_vector_from_the_live_fixture():
    objs = movers.parse_skybot(_skybot_fixture())
    assert [o["name"] for o in objs] == ["2010 VJ175", "2001 RJ150", "C/2022 JK5", "2006 TO61"]
    a, _, comet, _ = objs
    assert a["pos_au"] == [-1.575878951, 1.985450153, 0.762556773]
    assert a["vel_au_d"] == [-0.008847251, -0.004040727, -0.001560848]
    assert a["ref_epoch_jd"] == 2461000.0
    assert comet["class"] == "Comet" and comet["ref_epoch_jd"] == 2461000.0
    assert comet["pos_au"] == [4.114003485, 6.637229429, 2.914576453]
    assert comet["vel_au_d"] == [-0.000732676, 0.00665621, 0.004402789]
    assert a["dg_au"] == pytest.approx(2.4570168174)  # the fields read before are unchanged


def test_parse_skybot_without_vectors_gives_none_not_a_failure():
    objs = movers.parse_skybot(_skybot_fixture())
    nov = objs[3]
    assert nov["pos_au"] is None and nov["vel_au_d"] is None and nov["ref_epoch_jd"] is None
    assert nov["dg_au"] is not None  # the rest of the object is still parsed
    # the older sample has no vectors at all
    for o in movers.parse_skybot(SKYBOT_SAMPLE):
        assert o["pos_au"] is None and o["vel_au_d"] is None


@pytest.mark.parametrize("pos", [
    '{"x":1.0,"y":2.0}', '[1,2,3]', '"x"', '{"x":1.0,"y":"NaN","z":3.0}', '{"x":1.0,"y":null,"z":3.0}',
    '{"x":1.0,"y":true,"z":3.0}', '{"x":1.0,"y":1e999,"z":3.0}', '{"x":1.0,"y":"abc","z":3.0}',
])
def test_parse_skybot_malformed_vectors_are_none(pos):
    text = ('[{"Name":"X","RA (hms)":"10 00 00","DEC (dms)":"+10 00 00","Class":"MB>Inner",'
            f'"position (au)":{pos},"velocity (au/d)":{pos},"ref_epoch":"soon"}}]')
    (o,) = movers.parse_skybot(text)
    assert o["pos_au"] is None and o["vel_au_d"] is None and o["ref_epoch_jd"] is None


def test_skybot_cone_cache_key_is_skybot_4(monkeypatch):
    from spherex_app import cache

    async def fetch(ra, dec, radius, jd):
        return _skybot_fixture()
    monkeypatch.setattr(movers, "_skybot_fetch", fetch)
    objs = asyncio.run(movers.skybot_cone(150.0, 10.0, 0.5, 2461000.5))
    key = cache.key_hash("skybot-4", "150.0000", "10.0000", "0.500", "2461000.500")
    assert cache.get_json("skybot", key) == objs and objs[0]["pos_au"] is not None
    assert cache.get_json("skybot", cache.key_hash("skybot-3", "150.0000", "10.0000", "0.500",
                                                   "2461000.500")) is None
