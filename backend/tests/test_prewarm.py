"""Prewarm uses exact app centres and decodes fragmented binary streams correctly."""

import asyncio
import importlib.util
import json
import struct
from pathlib import Path

import httpx
import pytest

spec = importlib.util.spec_from_file_location(
    "prewarm", Path(__file__).parents[1] / "scripts" / "prewarm.py")
prewarm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prewarm)


def _record(rec, payload=b""):
    j = json.dumps(rec).encode()
    return struct.pack("<I", len(j)) + j + payload


@pytest.mark.parametrize("chunk_size", [1, 7, 64, 1024])
def test_fragmented_stream(chunk_size):
    start = {"type": "start", "npix": 3}
    frame = {"type": "frame", "ok": True}
    end = {"type": "end", "sent": 1, "failed": 0}
    data = _record(start) + _record(frame, bytes(72)) + _record(end)
    decoder = prewarm.StreamRecords()
    records = []
    for i in range(0, len(data), chunk_size):
        records.extend(decoder.feed(data[i:i + chunk_size]))
    decoder.finish()
    assert records == [start, frame, end]


def test_incomplete_stream_fails():
    decoder = prewarm.StreamRecords()
    decoder.feed(_record({"type": "start", "npix": 3}))
    decoder.feed(_record({"type": "frame", "ok": True}, bytes(71)))
    with pytest.raises(ValueError, match="complete end"):
        decoder.finish()


@pytest.mark.parametrize("name,answer,expected", [
    ("Barnard's Star", {"ra": 269.452075, "dec": 4.6933909, "pmra": -801.551,
                        "pmdec": 10362.394, "epoch": 2000.0}, None),
    ("RW Aur", {"ra": 76.9565, "dec": 30.4027}, (76.9565, 30.4027)),
    ("WISE J085510.83-071442.5", {"ra": 133.795129, "dec": -7.245147}, None),
])
def test_centre_uses_frontend_epoch_and_rounding(name, answer, expected):
    async def run():
        async with httpx.AsyncClient(base_url="http://app", transport=httpx.MockTransport(
                lambda req: httpx.Response(200, json=answer))) as c:
            return await prewarm.centre(c, name)
    p = asyncio.run(run())
    if expected is None:
        pm = answer if "pmra" in answer else prewarm.PRESETS[name]["pm_default"]
        ra, dec = prewarm.geometry.propagate(answer["ra"], answer["dec"], pm["pmra"],
                                            pm["pmdec"], pm["epoch"], 61041.0)
        assert (p["ra"], p["dec"]) == (round(ra, 7), round(dec, 7))
        assert p["epoch"] == 2026.0
    else:
        assert (p["ra"], p["dec"]) == expected


@pytest.mark.parametrize('name', ['Epsilon Indi B', 'WISE J085510.83-071442.5'])
def test_resolver_failure_uses_preset_fallback(name):
    async def run():
        async with httpx.AsyncClient(base_url='http://app', transport=httpx.MockTransport(
                lambda req: httpx.Response(502, json={'detail': 'unavailable'}))) as c:
            return await prewarm.centre(c, name)
    p = asyncio.run(run())
    preset = prewarm.PRESETS[name]
    fb = preset['fallback'] | preset.get('pm_default', {})
    ra, dec = prewarm.geometry.propagate(fb['ra'], fb['dec'], fb['pmra'], fb['pmdec'],
                                        fb['epoch'], 61041.0)
    assert (p['ra'], p['dec'], p['epoch']) == (round(ra, 7), round(dec, 7), 2026.0)


# --- progressive / full-prior stream layouts -------------------------------------------

from spherex_app import main as app_main  # noqa: E402


def _decode(data, chunk_size):
    decoder = prewarm.StreamRecords()
    records = []
    for i in range(0, len(data), chunk_size):
        records.extend(decoder.feed(data[i:i + chunk_size]))
    decoder.finish()
    return records


@pytest.mark.parametrize("chunk_size", [1, 7, 1024])
def test_model_true_stream_has_four_planes_per_frame(chunk_size):
    npix = 3
    start = {"type": "start", "npix": npix, "model": True}
    frame = {"type": "frame", "ok": True, "id": "a"}
    end = {"type": "end", "sent": 2, "failed": 0,
           "model_stats": {"cached": 0, "fitted": 2, "priors": ["gaia", "catwise"]}}
    frame2 = {"type": "frame", "ok": True, "id": "b"}
    data = (_record(start) + _record(frame, bytes(16 * npix * npix))
            + _record(frame2, bytes(16 * npix * npix)) + _record(end))
    assert _decode(data, chunk_size) == [start, frame, frame2, end]


@pytest.mark.parametrize("chunk_size", [1, 7, 1024])
def test_progressive_stream_has_two_planes_and_model_records(chunk_size):
    npix = 3
    start = {"type": "start", "npix": npix, "model": "progressive"}
    frame = {"type": "frame", "ok": True, "id": "a"}
    model = {"type": "model", "id": "a", "model": {}}
    failed = {"type": "frame", "ok": False, "id": "b", "error": "x"}
    end = {"type": "end", "sent": 1, "failed": 1}
    data = (_record(start) + _record(frame, bytes(8 * npix * npix))
            + _record(model, bytes(8 * npix * npix)) + _record(failed) + _record(end))
    assert _decode(data, chunk_size) == [start, frame, model, failed, end]


def test_plain_stream_has_two_planes_and_no_model_records():
    npix = 3
    start = {"type": "start", "npix": npix}
    frame = {"type": "frame", "ok": True}
    end = {"type": "end", "sent": 1, "failed": 0}
    data = _record(start) + _record(frame, bytes(8 * npix * npix)) + _record(end)
    assert _decode(data, 1) == [start, frame, end]


# --- Blink centring ----------------------------------------------------------------------

# Blink's own coordinates (frontend/js/blink/app.js PRESETS) for the presets without a pm.
BLINK_FIXED = {
    "North Ecliptic Pole": (270.0, 66.56),
    "South Ecliptic Pole": (90.0, -66.56),
    "Orion Nebula": (83.82, -5.39),
    "Galactic Centre": (266.417, -29.008),
    "WISE 0855": (133.795129, -7.245147),
    "R Draconis": (248.175, 66.7544),
}
# Computed with node from frontend/js/wcs.js propagate(ra, dec, pmra, pmdec, 2000, 2026),
# rounded to 7 decimals (toFixed(7)).
BLINK_PM = {
    "Barnard’s Star": (269.4462679, 4.7682044),
    "ε Indi B": (331.0960121, -56.8011046),
}


@pytest.mark.parametrize("label", sorted(BLINK_FIXED))
def test_blink_centre_fixed_presets_are_app_coordinates(label):
    ra, dec = BLINK_FIXED[label]
    assert prewarm.blink_centre(label) == {"ra": ra, "dec": dec}


@pytest.mark.parametrize("label", sorted(BLINK_PM))
def test_blink_centre_proper_motion_matches_frontend(label):
    ra, dec = BLINK_PM[label]
    c = prewarm.blink_centre(label)
    assert (c["ra"], c["dec"]) == (ra, dec)


def test_blink_presets_cover_app_labels():
    labels = [p["label"] for p in prewarm.BLINK_PRESETS]
    assert labels == ["North Ecliptic Pole", "South Ecliptic Pole", "Orion Nebula",
                      "Galactic Centre", "Barnard’s Star", "ε Indi B", "WISE 0855",
                      "R Draconis"]


@pytest.mark.parametrize("alias,label", [
    ("Barnard's Star", "Barnard’s Star"),
    ("eps Indi B", "ε Indi B"),
    ("Epsilon Indi B", "ε Indi B"),
    ("wise 0855", "WISE 0855"),
])
def test_blink_aliases_map_to_the_same_centre(alias, label):
    assert prewarm.blink_centre(alias) == prewarm.blink_centre(label)


def test_non_blink_name_is_not_a_blink_target():
    assert prewarm._blink_preset("RW Aur") is None
    assert [t.blink for t in prewarm.plan_targets(["Barnard's Star", "RW Aur"])] == [True, False]


def test_default_targets_are_analysis_then_blink_presets():
    targets = prewarm.plan_targets([])
    assert [(t.name, t.blink) for t in targets] == (
        [(q, False) for q in prewarm.PRESETS]
        + [(p["label"], True) for p in prewarm.BLINK_PRESETS])
    blink = prewarm.plan_targets([], blink_only=True)
    assert [(t.name, t.blink) for t in blink] == [(p["label"], True) for p in prewarm.BLINK_PRESETS]


# --- arguments -----------------------------------------------------------------------------

def test_blink_shorthand_sets_blink_stream_options():
    a = prewarm.parse_args(["--blink"])
    assert (a.fov, a.band, a.per_visit, a.model) == (0.5, "2", 6, True)


def test_explicit_options_override_blink():
    a = prewarm.parse_args(["--blink", "--band", "3"])
    assert (a.fov, a.band, a.per_visit, a.model) == (0.5, "3", 6, True)
    b = prewarm.parse_args(["--blink", "--width", "0.2", "--per-visit", "4"])
    assert (b.fov, b.per_visit) == (0.2, 4)


def test_old_defaults_without_blink():
    a = prewarm.parse_args([])
    assert (a.fov, a.band, a.per_visit, a.model) == (0.1, "1,2,3,4,5,6", None, False)
    assert a.max_frames == 400 and a.catalog_concurrency == 3


def test_width_is_fov():
    assert prewarm.parse_args(["--width", "0.3"]).fov == 0.3
    assert prewarm.parse_args(["--fov", "0.3"]).fov == 0.3


@pytest.mark.parametrize("band,expected", [("2", "2"), ("1,3", "1,3"), ("1, 6", "1,6")])
def test_band_is_normalised(band, expected):
    assert prewarm.parse_args(["--band", band]).band == expected


@pytest.mark.parametrize("band", ["0", "7", "", "1,x", "1,,3"])
def test_band_rejects_bad_detectors(band):
    with pytest.raises(SystemExit):
        prewarm.parse_args(["--band", band])


def test_request_params_for_blink_preset_match_blink():
    a = prewarm.parse_args(["--blink"])
    p = prewarm.blink_centre("WISE 0855")
    params = prewarm.stream_params(p, a)
    assert params == {"ra": 133.795129, "dec": -7.245147, "fov": 0.5, "scale": 6.15,
                      "detectors": "2", "per_visit": 6, "max_frames": 400, "model": 1}
    assert not {"pmra", "pmdec", "epoch"} & params.keys()


def test_scale_follows_blink_for_wide_fields():
    a = prewarm.parse_args(["--width", "2"])
    assert prewarm.stream_params({"ra": 1.0, "dec": 2.0}, a)["scale"] == pytest.approx(7.2)


def test_old_request_params_are_unchanged():
    a = prewarm.parse_args([])
    params = prewarm.stream_params({"ra": 10.0, "dec": 20.0, "pmra": None}, a)
    assert params == {"ra": 10.0, "dec": 20.0, "fov": 0.1, "scale": 6.15,
                      "detectors": "1,2,3,4,5,6", "max_frames": 400}


# --- catalogue warming (offline) -----------------------------------------------------------

def _mock_client(stream_body, calls):
    def handler(req):
        calls.append(req)
        if req.url.path == "/api/stream":
            return httpx.Response(200, content=stream_body)
        return httpx.Response(404)
    return httpx.AsyncClient(base_url="http://app", transport=httpx.MockTransport(handler),
                             timeout=None)


def _blink_stream(priors):
    start = {"type": "start", "npix": 3, "model": True}
    frame = {"type": "frame", "ok": True, "id": "a"}
    end = {"type": "end", "sent": 1, "failed": 0,
           "model_stats": {"cached": 0, "fitted": 1, "priors": priors}}
    return _record(start) + _record(frame, bytes(16 * 9)) + _record(end)


def test_model_warming_fetches_both_priors_and_streams(monkeypatch, capsys):
    seen = []

    async def fake(cat, ra, dec, radius, wait=0.0, *, ignore_failures=False):
        seen.append((cat, ra, dec, radius, wait, ignore_failures))
        return [{"ra": ra, "dec": dec}]

    monkeypatch.setattr(prewarm.catalogs, "prior_catalog", fake)
    calls = []
    a = prewarm.parse_args(["--blink", "WISE 0855"])
    rc = asyncio.run(prewarm.run(a, _mock_client(_blink_stream(["catwise", "gaia"]), calls)))

    assert rc == 0
    radius = app_main.prior_radius(0.5)
    ra, dec = prewarm.blink_centre("WISE 0855").values()
    assert sorted(seen) == sorted([("gaia", ra, dec, radius, None, True),
                                   ("catwise", ra, dec, radius, None, True)])
    stream = calls[0].url.params
    assert stream["model"] == "1" and stream["detectors"] == "2" and stream["per_visit"] == "6"
    assert "pmra" not in stream and "epoch" not in stream
    out = capsys.readouterr().out
    assert "1 frames, 0 failed" in out
    assert "models: 0 cached, 1 fitted, priors gaia+catwise" in out
    assert "catalogues" in out


def test_failing_catwise_is_reported_and_target_still_streams(monkeypatch, capsys):
    async def fake(cat, ra, dec, radius, wait=0.0, *, ignore_failures=False):
        if cat == "catwise":
            raise RuntimeError("upstream down")
        return [{"ra": ra, "dec": dec}]

    monkeypatch.setattr(prewarm.catalogs, "prior_catalog", fake)
    calls = []
    a = prewarm.parse_args(["--blink", "WISE 0855"])
    rc = asyncio.run(prewarm.run(a, _mock_client(_blink_stream(["gaia"]), calls)))

    assert rc == 1
    assert len(calls) == 1  # streamed anyway
    out = capsys.readouterr().out
    assert "catwise FAILED: upstream down" in out
    assert "1 frames, 0 failed" in out
