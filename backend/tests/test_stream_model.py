"""per_visit selection, model=1 payload/records (stubbed `sources`), /api/coverage."""

from __future__ import annotations

import asyncio
import json
import math
import struct
import sys
import time
import types
from dataclasses import dataclass

import numpy as np
import pytest
from fastapi.testclient import TestClient

from spherex_app import archive, cache, catalogs, config, main, processing
from test_bigfield import RA0, DEC0, synth_cutout

client = TestClient(main.app)
FOV = 0.1


@pytest.fixture(autouse=True)
def _clear_catalog_state():
    """Background catalogue tasks and failure memory are module globals: keep tests apart."""
    catalogs._inflight.clear()
    catalogs._failed.clear()
    yield
    catalogs._inflight.clear()
    catalogs._failed.clear()


def mk(det, mjd, i=0):
    return archive.Frame(f"f{det}_{mjd}_{i}", f"o{mjd}", det, mjd, mjd + 0.001, 100, "dr1", "v",
                         None, f"u/{det}/{mjd}/{i}")


def test_per_visit_selection():
    frames = [mk(1, 60000 + k * 0.1) for k in range(10)]           # visit A: 10 frames
    frames += [mk(1, 60100 + k * 0.1) for k in range(3)]           # visit B: 3 frames
    frames += [mk(2, 60000 + k * 0.1) for k in range(4)]           # other detector
    sel, n = archive.select_frames(frames, {1, 2}, None, None, 400, per_visit=2)
    assert n == 6
    d1 = sorted(f.mjd for f in sel if f.detector == 1)
    assert d1[0] == 60000 and abs(d1[1] - 60000.9) < 1e-9       # first and last of visit A
    assert d1[2] == 60100 and abs(d1[3] - 60100.2) < 1e-9       # visit B
    assert sum(f.detector == 2 for f in sel) == 2
    # per_visit=1 takes one per visit; large value is a no-op; applied before max_frames
    sel, _ = archive.select_frames(frames, {1}, None, None, 400, per_visit=1)
    assert len(sel) == 2
    sel, n = archive.select_frames(frames, {1, 2}, None, None, 400, per_visit=99)
    assert n == len(frames)
    sel, n = archive.select_frames(frames, {1}, None, None, 3, per_visit=2)
    assert n == 4 and len(sel) == 3
    # gap of exactly 20 days stays in the same visit, 21 does not
    f = [mk(1, 60000), mk(1, 60020), mk(1, 60041)]
    assert len(archive.select_frames(f, {1}, None, None, 9, per_visit=1)[0]) == 2


# --- stream with model=1 ----------------------------------------------------------------

@dataclass
class FakePrior:
    x: float
    y: float
    cat: dict


@dataclass
class FakeFrameModel:
    sources: list
    background: np.ndarray
    leftover: np.ndarray
    psf_fwhm_px: float
    noise: float
    quality: float


def parse_stream(content: bytes):
    pos, recs = 0, []
    while pos < len(content):
        n = struct.unpack_from("<I", content, pos)[0]
        rec = json.loads(content[pos + 4:pos + 4 + n])
        pos += 4 + n
        payload = b""
        planes = 0
        if rec.get("type") == "frame" and rec.get("ok"):
            # inline model=1: image|flags|bg|leftover; otherwise image|flags (progressive too)
            planes = 4 if recs and recs[0].get("model") is True else 2
        elif rec.get("type") == "model":
            planes = 2  # background | leftover
        if planes:
            size = planes * rec_npix(recs[0]) ** 2 * 4
            payload = content[pos:pos + size]
            pos += size
        recs.append(rec)
        rec["_payload"] = payload
    return recs


def rec_npix(start):
    return start["npix"]


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(config, "PRIOR_WAIT_S", 5.0)  # the fake catalogues answer at once
    frames = [mk(3, 60000 + k * 0.1) for k in range(2)]

    async def find_frames(ra, dec):
        return frames

    async def fetch_cutout(uri, ra, dec, size):
        return b"x", True

    async def wave_table(*a):
        return None

    monkeypatch.setattr(archive, "find_frames", find_frames)
    monkeypatch.setattr(archive, "fetch_cutout", fetch_cutout)
    monkeypatch.setattr(archive, "wave_table", wave_table)
    cut = synth_cutout(stars=((200, 200, 50.0),))
    cut.header["MJD-AVG"] = 60000.0
    cut.header["PSF_FWHM"] = 6.5
    monkeypatch.setattr(processing, "parse_cutout", lambda data: cut)

    calls = []

    def fit_frame(img, bad, psf_fwhm_px, priors=None, **kw):
        calls.append((img.shape, bad.dtype, psf_fwhm_px, priors))
        return FakeFrameModel(
            sources=[{"id": 0, "x": 1.0, "y": 2.0, "amp": np.float32(3.0), "snr": float("nan")}],
            background=np.full(img.shape, 7.0, np.float32),
            leftover=np.full(img.shape, 0.5, np.float32),
            psf_fwhm_px=psf_fwhm_px, noise=0.01, quality=1.0)

    stub = types.ModuleType("spherex_app.sources")
    stub.Prior = FakePrior
    stub.fit_frame = fit_frame
    monkeypatch.setitem(sys.modules, "spherex_app.sources", stub)
    # `from . import sources` prefers the package attribute once the real module was imported
    import spherex_app
    monkeypatch.setattr(spherex_app, "sources", stub, raising=False)

    async def fake_catalog(cat, ra, dec, radius):
        if cat == "gaia":
            return [{"id": "1", "ra": RA0, "dec": DEC0, "pmra": 0.0, "pmdec": 0.0, "plx": 3.0,
                     "mag": 12.0, "epoch": 2016.0},
                    {"id": "2", "ra": RA0, "dec": DEC0 + 0.001, "pmra": None, "pmdec": None,
                     "plx": None, "mag": 21.0, "epoch": 2016.0},          # too faint
                    {"id": "3", "ra": RA0 + 5, "dec": DEC0, "pmra": 0, "pmdec": 0, "plx": None,
                     "mag": 10.0, "epoch": 2016.0}]                       # outside the grid
        return [{"id": "J1", "ra": RA0 + 0.002, "dec": DEC0, "pmra": 0.0, "pmdec": 0.0,
                 "plx": None, "mag": 14.0, "epoch": 2015.0}]

    monkeypatch.setattr(main.catalogs, "catalog", fake_catalog)
    return types.SimpleNamespace(calls=calls, frames=frames)


def test_stream_without_model_is_unchanged(env):
    r = client.get("/api/stream", params={"ra": RA0, "dec": DEC0, "fov": 0.1})
    recs = parse_stream(r.content)
    assert "model" not in recs[0] and "priors" not in recs[0]
    assert not env.calls
    f = recs[1]
    assert f["ok"] and "model" not in f and len(f["_payload"]) == 2 * recs[0]["npix"] ** 2 * 4


def test_stream_model_layout_and_cache(env):
    params = {"ra": RA0, "dec": DEC0, "fov": 0.1, "model": 1, "per_visit": 1}
    r = client.get("/api/stream", params=params)
    recs = parse_stream(r.content)
    start = recs[0]
    assert start["model"] is True and "priors" not in start
    frames = [x for x in recs if x["type"] == "frame"]
    assert len(frames) == 1  # per_visit=1: both frames are in one visit
    f = frames[0]
    n2 = start["npix"] ** 2
    assert len(f["_payload"]) == 4 * n2 * 4
    p = f["_payload"]
    bg = np.frombuffer(p, "<f4", n2, 8 * n2)
    left = np.frombuffer(p, "<f4", n2, 12 * n2)
    assert np.all(bg == 7.0) and np.all(left == 0.5)
    m = f["model"]
    assert set(m) >= {"psf_fwhm_px", "noise", "quality", "sources"}
    assert m["sources"][0]["snr"] is None and m["sources"][0]["amp"] == 3.0
    # header PSF in quadrature with the detector-pixel response (see processing.effective_psf_px)
    assert abs(m["psf_fwhm_px"] - math.hypot(6.5, 2.3548 * 0.29 * 6.15) / 6.15) < 1e-3
    shape, dt, psf, priors = env.calls[0]
    assert dt == bool
    assert sorted(p.cat["catalog"] for p in priors) == ["catwise", "gaia"]  # faint/outside cut
    assert all(0 <= p.x <= start["npix"] and 0 <= p.y <= start["npix"] for p in priors)
    # replay hits the disk cache: fitter is not called again, payload identical
    n_calls = len(env.calls)
    r2 = client.get("/api/stream", params=params)
    assert len(env.calls) == n_calls
    assert parse_stream(r2.content)[1]["_payload"] == p


def test_stream_model_priors_unavailable_and_fit_failure(env, monkeypatch):
    async def boom(*a):
        raise RuntimeError("tap down")

    monkeypatch.setattr(main.catalogs, "catalog", boom)
    recs = parse_stream(client.get("/api/stream", params={
        "ra": RA0, "dec": DEC0, "fov": 0.1, "model": 1, "per_visit": 1}).content)
    assert "priors" not in recs[0] and recs[0]["model"] is True
    assert recs[1]["ok"] and env.calls[-1][3] is None
    assert recs[-1]["model_stats"]["priors"] == []

    def bad_fit(*a, **k):
        raise ValueError("no")

    sys.modules["spherex_app.sources"].fit_frame = bad_fit
    recs = parse_stream(client.get("/api/stream", params={
        "ra": RA0, "dec": DEC0, "fov": 0.1, "model": 1, "per_visit": 1, "scale": 7}).content)
    f = recs[1]
    assert f["ok"] and f["model"]["sources"] == [] and "error" in f["model"]
    assert len(f["_payload"]) == 4 * recs[0]["npix"] ** 2 * 4


def _run(**extra):
    params = {"ra": RA0, "dec": DEC0, "fov": FOV, "model": 1, **extra}
    return parse_stream(client.get("/api/stream", params=params).content)


def _frames(recs):
    return [r for r in recs if r["type"] == "frame"]


def _gaia_rows():
    return [{"id": "1", "ra": RA0, "dec": DEC0, "pmra": 0.0, "pmdec": 0.0, "plx": 3.0,
             "mag": 12.0, "epoch": 2016.0}]


def _catwise_rows():
    return [{"id": "J1", "ra": RA0 + 0.002, "dec": DEC0, "pmra": 0.0, "pmdec": 0.0,
             "plx": None, "mag": 14.0, "epoch": 2015.0}]


def _put_prior(cat, rows):
    """Disk-cache a catalogue for the test field, under the key scheme the stream uses."""
    cache.put_json("catalog", catalogs._catalog_key(cat, RA0, DEC0, main.prior_radius(FOV)), rows)


def test_cached_models_need_no_catalogue_lookup(env, monkeypatch):
    recs = _run()
    frames = _frames(recs)
    n = len(frames)
    assert n == 2 and all(f["ok"] and "model" in f for f in frames)
    assert recs[-1]["model_stats"] == {"cached": 0, "fitted": n, "priors": ["catwise", "gaia"]}

    touched = []

    def trap(name):
        def f(*a, **k):
            touched.append(name)
            raise AssertionError(f"{name} must not be called for cached models")
        return f

    monkeypatch.setattr(main.catalogs, "prior_catalog", trap("prior_catalog"))
    monkeypatch.setattr(main.catalogs, "cached_catalog", trap("cached_catalog"))
    monkeypatch.setattr(main.catalogs, "catalog", trap("catalog"))
    env.calls.clear()
    recs = _run()
    frames = _frames(recs)
    assert len(frames) == n and all(f["ok"] and "model" in f for f in frames)
    assert recs[-1]["model_stats"] == {"cached": n, "fitted": 0, "priors": []}
    assert touched == [] and not env.calls


def test_slow_catalogue_never_delays_frames(env, monkeypatch):
    monkeypatch.setattr(config, "PRIOR_WAIT_S", 0.0)
    _put_prior("gaia", _gaia_rows())

    async def catalog(cat, ra, dec, radius):
        if cat == "catwise":
            await asyncio.sleep(30)  # stands in for a CatWISE query that takes minutes
        return _gaia_rows()

    monkeypatch.setattr(main.catalogs, "catalog", catalog)
    t0 = time.monotonic()
    recs = _run()
    assert time.monotonic() - t0 < 5
    frames = _frames(recs)
    assert frames and all(f["ok"] and "model" in f for f in frames)
    assert recs[-1]["model_stats"] == {"cached": 0, "fitted": len(frames), "priors": ["gaia"]}
    assert len(env.calls) == len(frames)
    for *_, priors in env.calls:
        assert {p.cat["catalog"] for p in priors} == {"gaia"}


def test_gaia_only_fit_is_refitted_when_catwise_arrives(env, monkeypatch):
    _put_prior("gaia", _gaia_rows())
    catwise_calls = []

    async def catalog(cat, ra, dec, radius):
        if cat == "catwise":
            catwise_calls.append(cat)
            raise archive.UpstreamError("catwise down")
        return _gaia_rows()

    monkeypatch.setattr(main.catalogs, "catalog", catalog)

    recs = _run()
    n = len(_frames(recs))
    assert recs[-1]["model_stats"] == {"cached": 0, "fitted": n, "priors": ["gaia"]}

    recs = _run()  # the failure is remembered: no new CatWISE query, nothing refitted
    assert recs[-1]["model_stats"] == {"cached": n, "fitted": 0, "priors": []}
    assert len(catwise_calls) == 1

    _put_prior("catwise", _catwise_rows())
    recs = _run()
    assert recs[-1]["model_stats"] == {"cached": 0, "fitted": n, "priors": ["catwise", "gaia"]}
    assert {p.cat["catalog"] for p in env.calls[-1][3]} == {"gaia", "catwise"}
    recs = _run()
    assert recs[-1]["model_stats"] == {"cached": n, "fitted": 0, "priors": []}

    # Only Gaia visible again: the full-prior models are still used, nothing is refitted.
    real_cached = catalogs.cached_catalog
    monkeypatch.setattr(main.catalogs, "cached_catalog",
                        lambda cat, *a: None if cat == "catwise" else real_cached(cat, *a))
    recs = _run()
    assert recs[-1]["model_stats"] == {"cached": n, "fitted": 0, "priors": []}
    assert len(catwise_calls) == 1


def test_prior_radius_and_tags():
    assert main.prior_radius(0.5) == 0.5 * 0.7072 + 0.02
    assert main._superset_tags({}) == ["gaia+catwise", "gaia", "catwise", "none"]
    assert main._superset_tags({"gaia"}) == ["gaia+catwise", "gaia"]
    assert main._superset_tags({"gaia", "catwise"}) == ["gaia+catwise"]
    assert main._prior_tag({"catwise"}) == "catwise" and main._prior_tag(set()) == "none"


def test_bad_model_value_is_400():
    r = client.get("/api/stream", params={"ra": RA0, "dec": DEC0, "model": "banana"})
    assert r.status_code == 400


def test_bad_per_visit_is_400():
    assert client.get("/api/stream", params={"ra": 1, "dec": 1, "per_visit": 0}).status_code == 400


def _model_recs(recs):
    return [r for r in recs if r["type"] == "model"]


def test_progressive_layout(env, monkeypatch):
    real_fetch = archive.fetch_cutout
    bad_uri = env.frames[1].uri

    async def flaky(uri, ra, dec, size):
        if uri == bad_uri:
            raise archive.UpstreamError("cutout gone")
        return await real_fetch(uri, ra, dec, size)

    monkeypatch.setattr(archive, "fetch_cutout", flaky)
    recs = _run(model="progressive")
    start = recs[0]
    assert start["model"] == "progressive"
    npix2 = start["npix"] ** 2 * 4
    frames = _frames(recs)
    ok = [r for r in frames if r["ok"]]
    bad = [r for r in frames if not r["ok"]]
    assert len(ok) == 1 and len(bad) == 1 and bad[0]["id"] == env.frames[1].id
    for f in ok:
        assert "model" not in f and len(f["_payload"]) == 2 * npix2
    mrecs = _model_recs(recs)
    assert [m["id"] for m in mrecs] == [f["id"] for f in ok]  # one per ok frame, none for failed
    for m in mrecs:
        assert set(m) >= {"type", "id", "model", "_payload"} and len(m["_payload"]) == 2 * npix2
        assert set(m["model"]) >= {"psf_fwhm_px", "noise", "quality", "sources"}
        frame_idx = next(i for i, r in enumerate(recs) if r is not m and r.get("id") == m["id"]
                         and r["type"] == "frame")
        assert frame_idx < recs.index(m)
    bg = np.frombuffer(mrecs[0]["_payload"], "<f4", start["npix"] ** 2)
    assert np.all(bg == 7.0)
    end = recs[-1]
    assert end["type"] == "end" and end["models"] == len(ok) == 1
    assert end["sent"] == 1 and end["failed"] == 1
    assert end["model_stats"]["fitted"] == 1 and end["model_stats"]["cached"] == 0
    assert len(env.calls) == 1


def test_progressive_matches_inline_and_shares_cache(env, tmp_path, monkeypatch):
    inline = _run()
    n = len(_frames(inline))
    assert inline[-1]["model_stats"]["fitted"] == n
    inline_by_id = {f["id"]: f for f in _frames(inline)}
    npix2 = inline[0]["npix"] ** 2 * 4

    calls_before = len(env.calls)
    prog = _run(model="progressive")
    assert prog[-1]["model_stats"] == {"cached": n, "fitted": 0, "priors": []}
    assert len(env.calls) == calls_before  # served from the cache written by model=1
    models = {m["id"]: m for m in _model_recs(prog)}
    assert len(models) == n
    for f in _frames(prog):
        ref = inline_by_id[f["id"]]
        assert "model" not in f
        assert f["_payload"] == ref["_payload"][:2 * npix2]          # image | flags
        assert models[f["id"]]["model"] == ref["model"]
        assert models[f["id"]]["_payload"] == ref["_payload"][2 * npix2:]  # bg | leftover

    # fresh cache: progressive first fits everything, then inline reads it back
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "fresh")
    env.calls.clear()
    prog = _run(model="progressive")
    assert prog[-1]["model_stats"]["fitted"] == n and len(env.calls) == n
    models = {m["id"]: m for m in _model_recs(prog)}
    inline = _run()
    assert inline[-1]["model_stats"] == {"cached": n, "fitted": 0, "priors": []}
    assert len(env.calls) == n
    for f in _frames(inline):
        assert models[f["id"]]["model"] == f["model"]
        assert models[f["id"]]["_payload"] == f["_payload"][2 * npix2:]


def test_progressive_sends_raw_before_fit_finishes(env, monkeypatch):
    fake = sys.modules["spherex_app.sources"]
    real_fit = fake.fit_frame

    def slow_fit(*a, **k):
        time.sleep(0.2)
        return real_fit(*a, **k)

    monkeypatch.setattr(fake, "fit_frame", slow_fit)
    recs = _run(model="progressive")
    frame_idx = [i for i, r in enumerate(recs) if r["type"] == "frame" and r["ok"]]
    model_idx = [i for i, r in enumerate(recs) if r["type"] == "model"]
    assert frame_idx and model_idx
    assert frame_idx[0] < model_idx[0]
    assert any(i < min(model_idx) for i in frame_idx)


# --- coverage ---------------------------------------------------------------------------

def test_coverage_lists_cached_fields(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    assert client.get("/api/coverage").json() == {"fields": []}

    async def fake_tap(url, adql, *, irsa, what):
        u = "ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/6/" \
            "level2_2025W19_1B_0116_1D6_spx_l2b-v27-2026-197.fits"
        return [{"uri": u, "energy_bandpassname": "SPHEREx-D6", "time_bounds_lower": "60800.7",
                 "time_bounds_upper": "60800.8", "time_exposure": "113", "provenance_version": "7"}]

    monkeypatch.setattr(archive, "tap_csv", fake_tap)
    import asyncio
    asyncio.run(archive.find_frames(10.0, 20.0))
    assert client.get("/api/coverage").json() == {"fields": [{"ra": 10.0, "dec": 20.0, "n_frames": 1}]}
