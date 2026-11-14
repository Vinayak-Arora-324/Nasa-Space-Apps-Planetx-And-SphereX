"""Download failures never cache a partial cutout; missing mirrors fall back once."""
import asyncio
import io

import numpy as np
import pytest
from astropy.io import fits

from spherex_app import archive, cache, config, s3cutout


def _cutout():
    b = io.BytesIO()
    hdus = [fits.PrimaryHDU()]
    for name in ('IMAGE', 'FLAGS', 'VARIANCE', 'ZODI'):
        hdus.append(fits.ImageHDU(np.zeros((2, 3), dtype=np.int32 if name == 'FLAGS'
                                         else np.float32), name=name))
    fits.HDUList(hdus).writeto(b)
    return b.getvalue()


@pytest.mark.parametrize('first', ['s3', 'irsa'])
@pytest.mark.parametrize('corrupt', [False, True])
def test_fallback_and_shared_cache(tmp_path, monkeypatch, first, corrupt):
    monkeypatch.setattr(config, 'CACHE_DIR', tmp_path)
    monkeypatch.setattr(config, 'CUTOUT_SOURCE', first)
    calls = []
    data = _cutout()
    async def bad(*args):
        calls.append(first)
        if corrupt:
            return data[:-10000]
        raise s3cutout.S3Missing('S3 HTTP 404')
    other = 'irsa' if first == 's3' else 's3'
    async def good(*args):
        calls.append(other)
        return data
    monkeypatch.setitem(archive._SOURCES, first, bad)
    monkeypatch.setitem(archive._SOURCES, other, good)
    async def run():
        assert await archive.fetch_cutout('test.fits', 10, 20, 0.15) == (data, False)
        assert await archive.fetch_cutout('test.fits', 10, 20, 0.15) == (data, True)
    asyncio.run(run())
    assert calls == [first, other]


def test_both_sources_fail_do_not_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'CACHE_DIR', tmp_path)
    async def bad(*args):
        raise RuntimeError('unavailable')
    monkeypatch.setitem(archive._SOURCES, 's3', bad)
    monkeypatch.setitem(archive._SOURCES, 'irsa', bad)
    with pytest.raises(archive.UpstreamError):
        asyncio.run(archive.fetch_cutout('test.fits', 10, 20, 0.15))
    key = cache.key_hash('test.fits', '10.0000000', '20.0000000', '0.15')
    assert cache.get_bytes('cutouts', key) is None


def test_missing_s3_wave_table_uses_full_irsa_cutout(tmp_path, monkeypatch):
    from spherex_app import geometry
    monkeypatch.setattr(config, 'CACHE_DIR', tmp_path)
    table = geometry.WaveTable(np.array([1., 2.]), np.array([1., 2.]), np.ones((2, 2, 2)))
    async def s3(req):
        assert req.headers['Range'] == 'bytes=-8640'
        return httpx.Response(404)
    async def irsa(req):
        return httpx.Response(200, content=b'full cutout')
    import httpx
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(s3)) as s, \
                httpx.AsyncClient(transport=httpx.MockTransport(irsa)) as c:
            monkeypatch.setattr(archive, 's3_client', lambda: s)
            monkeypatch.setattr(archive, 'client', lambda: c)
            monkeypatch.setattr(archive, 'split_bytes', lambda b: [type('HDU', (), {
                'name': 'WCS-WAVE', 'header': lambda self: None, 'data_bytes': b''})()])
            monkeypatch.setattr(archive, 'bintable_row0', lambda *args: {
                'X': table.x, 'Y': table.y, 'VALUES': table.values})
            result = await archive.wave_table('unique/missing/version/1/file.fits', 1, 10, 20)
            np.testing.assert_array_equal(result.values, table.values)
    try:
        asyncio.run(run())
    finally:
        archive._wave_mem.clear()
        archive._irsa_sem = archive._s3_sem = None


def test_wave_fetch_does_not_wait_for_all_queued_cutouts(tmp_path, monkeypatch):
    import httpx
    from spherex_app import geometry
    monkeypatch.setattr(config, 'CACHE_DIR', tmp_path)
    table = geometry.WaveTable(np.array([1., 2.]), np.array([1., 2.]), np.ones((2, 2, 2)))
    async def run():
        # Represents a large FIFO queue of cutout downloads occupying every frame permit.
        monkeypatch.setattr(archive, '_s3_sem', asyncio.Semaphore(0))
        monkeypatch.setattr(archive, '_wave_sem', None)
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req:
                httpx.Response(206, headers={'Content-Range': 'bytes 0-5/6'},
                               content=b'suffix'))) as c:
            monkeypatch.setattr(archive, 's3_client', lambda: c)
            monkeypatch.setattr(archive, 'parse_wave_tail', lambda b: table)
            got = await asyncio.wait_for(archive.wave_table(
                'unique/independent/version/1/file.fits', 1, 10, 20), timeout=0.5)
            assert got is table
    try:
        asyncio.run(run())
    finally:
        archive._wave_mem.clear()
        archive._wave_sem = None
