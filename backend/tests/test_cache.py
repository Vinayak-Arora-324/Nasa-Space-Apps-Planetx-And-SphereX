"""A cancelled download can be re-requested while its connection is still closing."""
import asyncio

from spherex_app.cache import SingleFlight


def test_cancelled_flight_is_replaced_before_cleanup_finishes():
    async def run():
        flight = SingleFlight()
        started, closing, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def slow():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                closing.set()
                await release.wait()
        first = asyncio.create_task(flight.run('same cutout', slow))
        await started.wait()
        underlying = flight._inflight['same cutout'][0]
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        await closing.wait()
        async def replacement():
            return 'fresh download'
        try:
            assert await asyncio.wait_for(flight.run('same cutout', replacement), 0.5) == 'fresh download'
        finally:
            release.set()
            await asyncio.gather(underlying, return_exceptions=True)
    asyncio.run(run())


def test_cancelling_one_waiter_preserves_shared_download():
    async def run():
        flight = SingleFlight()
        started, release = asyncio.Event(), asyncio.Event()
        calls = 0
        async def download():
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return b'cutout'
        first = asyncio.create_task(flight.run('key', download))
        second = asyncio.create_task(flight.run('key', download))
        await started.wait()
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        release.set()
        assert await second == b'cutout'
        assert calls == 1
    asyncio.run(run())


def test_failed_cache_write_removes_temp_and_preserves_previous_entry(tmp_path, monkeypatch):
    import errno
    from pathlib import Path
    from spherex_app import cache, config
    monkeypatch.setattr(config, 'CACHE_DIR', tmp_path)
    cache.put_bytes('cutouts', 'key', b'previous')
    write = Path.write_bytes
    def full_disk(path, data):
        write(path, data[:3])  # a real partial temporary file
        raise OSError(errno.ENOSPC, 'no space left')
    monkeypatch.setattr(Path, 'write_bytes', full_disk)
    cache.put_bytes('cutouts', 'key', b'replacement')
    assert cache.get_bytes('cutouts', 'key') == b'previous'
    assert not list(tmp_path.rglob('*.tmp*'))
