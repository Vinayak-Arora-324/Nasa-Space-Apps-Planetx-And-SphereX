"""per_visit selection, model=1 payload/records (stubbed `sources`), /api/coverage."""

from __future__ import annotations

import json
import math
import struct
import sys
import types
from dataclasses import dataclass

import numpy as np
import pytest
from fastapi.testclient import TestClient

from spherex_app import archive, cache, config, main, processing
from test_bigfield import RA0, DEC0, synth_cutout

client = TestClient(main.app)


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
        if rec.get("type") == "frame" and rec.get("ok"):
            planes = 4 if recs and recs[0].get("model") else 2
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
    return types.SimpleNamespace(calls=calls)


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
    assert recs[0]["priors"] == "unavailable" and recs[0]["model"] is True
    assert recs[1]["ok"] and env.calls[-1][3] is None

    def bad_fit(*a, **k):
        raise ValueError("no")

    sys.modules["spherex_app.sources"].fit_frame = bad_fit
    recs = parse_stream(client.get("/api/stream", params={
        "ra": RA0, "dec": DEC0, "fov": 0.1, "model": 1, "per_visit": 1, "scale": 7}).content)
    f = recs[1]
    assert f["ok"] and f["model"]["sources"] == [] and "error" in f["model"]
    assert len(f["_payload"]) == 4 * recs[0]["npix"] ** 2 * 4


def test_bad_per_visit_is_400():
    assert client.get("/api/stream", params={"ra": 1, "dec": 1, "per_visit": 0}).status_code == 400


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
