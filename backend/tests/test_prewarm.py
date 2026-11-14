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
