"""Frame-list disk cache: fresh hits skip TAP, stale hits answer at once and refresh."""

from __future__ import annotations

import asyncio
import os
import time

from spherex_app import archive, cache, config

URI = "ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/6/level2_2025W19_1B_0116_1D6_spx_l2b-v27-2026-197.fits"


def _row(t):
    return {"uri": URI, "energy_bandpassname": "SPHEREx-D6", "time_bounds_lower": str(t),
            "time_bounds_upper": str(t + 0.001), "time_exposure": "113.6",
            "provenance_version": "7.0.5"}


def test_frame_list_disk_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    calls = []

    async def fake_tap(url, adql, *, irsa, what):
        calls.append(adql)
        return [_row(60800.7 + len(calls))]

    monkeypatch.setattr(archive, "tap_csv", fake_tap)

    def forget_memory():
        archive._frames_cache._d.clear()

    async def scenario():
        f1 = await archive.find_frames(10.0, 20.0)
        assert len(calls) == 1 and f1[0].mjd == 60801.7
        forget_memory()  # like a server restart
        f2 = await archive.find_frames(10.0, 20.0)
        assert len(calls) == 1 and f2[0].mjd == f1[0].mjd  # fresh disk hit, no TAP

        # make the disk entry stale: served at once, refreshed in the background
        key = cache.key_hash("frames-v1", 10.0, 20.0)
        p = cache._path("frames", key, ".bin")
        old = time.time() - config.FRAMES_DISK_TTL_S - 10
        os.utime(p, (old, old))
        forget_memory()
        f3 = await archive.find_frames(10.0, 20.0)
        assert f3[0].mjd == f1[0].mjd
        for _ in range(50):
            if len(calls) == 2 and not archive._bg_tasks:
                break
            await asyncio.sleep(0.01)
        assert len(calls) == 2
        f4 = await archive.find_frames(10.0, 20.0)  # memory now holds the refreshed list
        assert f4[0].mjd == 60802.7

        # too old: query before answering
        very_old = time.time() - config.FRAMES_STALE_MAX_S - 10
        os.utime(p, (very_old, very_old))
        forget_memory()
        f5 = await archive.find_frames(10.0, 20.0)
        assert len(calls) == 3 and f5[0].mjd == 60803.7

    asyncio.run(scenario())
    archive._frames_cache._d.clear()


def test_shutdown_cancels_stale_refresh(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'CACHE_DIR', tmp_path)
    key = cache.key_hash('frames-v1', 11.0, 21.0)
    cache.put_json('frames', key, [_row(60800.7)])
    p = cache._path('frames', key, '.bin')
    old = time.time() - config.FRAMES_DISK_TTL_S - 10
    os.utime(p, (old, old))
    async def run():
        started, cancelled = asyncio.Event(), asyncio.Event()
        async def pending(*args, **kwargs):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        monkeypatch.setattr(archive, 'tap_csv', pending)
        assert (await archive.find_frames(11.0, 21.0))[0].mjd == 60800.7
        await asyncio.wait_for(started.wait(), timeout=0.5)
        await archive.close()
        await asyncio.wait_for(cancelled.wait(), timeout=0.5)
        assert not archive._bg_tasks
    try:
        asyncio.run(run())
    finally:
        archive._frames_cache._d.clear()
