"""Catalogue queries run in the background: shared, cached, failure-limited, never cancelled by waiters."""
import asyncio

import httpx
import pytest

from spherex_app import archive, catalogs, config
from spherex_app.archive import UpstreamError

ROW = {"source_id": "1", "ra": "10.0", "dec": "20.0", "pmra": "", "pmdec": "",
       "parallax": "", "phot_g_mean_mag": "12.0"}
FIELD = (10.0, 20.0, 0.1)


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    catalogs._inflight.clear()
    catalogs._failed.clear()
    yield
    catalogs._inflight.clear()
    catalogs._failed.clear()


def _fake_tap(monkeypatch, delay=0.0, exc=None):
    calls = []

    async def fake(url, adql, *, irsa, what, **kw):
        calls.append(kw)
        await asyncio.sleep(delay)
        if exc is not None:
            raise exc
        return [dict(ROW)]

    monkeypatch.setattr(catalogs, "tap_csv", fake)
    return calls


def test_cold_cache_starts_one_query_then_serves_from_disk(monkeypatch):
    calls = _fake_tap(monkeypatch, delay=0.05)

    async def run():
        assert await catalogs.prior_catalog("gaia", *FIELD, wait=0) is None
        task = catalogs._inflight[catalogs._catalog_key("gaia", *FIELD)]
        await task
        assert catalogs.cached_catalog("gaia", *FIELD)[0]["id"] == "1"
        rows = await catalogs.prior_catalog("gaia", *FIELD, wait=0)
        assert rows[0]["mag"] == 12.0
    asyncio.run(run())
    assert len(calls) == 1


def test_concurrent_callers_share_one_query(monkeypatch):
    calls = _fake_tap(monkeypatch, delay=0.1)

    async def run():
        return await asyncio.gather(
            catalogs.prior_catalog("gaia", *FIELD, wait=None),
            catalogs.prior_catalog("gaia", *FIELD, wait=None))
    a, b = asyncio.run(run())
    assert len(calls) == 1
    assert a == b and a[0]["id"] == "1"


def test_timeout_does_not_cancel_the_query(monkeypatch):
    calls = _fake_tap(monkeypatch, delay=0.2)

    async def run():
        assert await catalogs.prior_catalog("gaia", *FIELD, wait=0.01) is None
        await catalogs._inflight[catalogs._catalog_key("gaia", *FIELD)]
        return catalogs.cached_catalog("gaia", *FIELD)
    cached = asyncio.run(run())
    assert len(calls) == 1
    assert cached is not None and cached[0]["id"] == "1"


def test_failure_is_remembered_then_retried_after_ttl(monkeypatch):
    calls = _fake_tap(monkeypatch, exc=UpstreamError("boom"))

    async def run():
        assert await catalogs.prior_catalog("catwise", *FIELD, wait=None) is None
        assert catalogs.recently_failed("catwise", *FIELD)
        # within the failure TTL: no new query
        assert await catalogs.prior_catalog("catwise", *FIELD, wait=None) is None
        assert len(calls) == 1
        # ignore_failures: queries again and surfaces the error
        with pytest.raises(UpstreamError):
            await catalogs.prior_catalog("catwise", *FIELD, wait=None, ignore_failures=True)
        assert len(calls) == 2
        # TTL of zero: the failure has expired, so it is retried
        monkeypatch.setattr(config, "CATALOG_FAIL_TTL_S", 0)
        assert not catalogs.recently_failed("catwise", *FIELD)
        assert await catalogs.prior_catalog("catwise", *FIELD, wait=None) is None
        assert len(calls) == 3
    asyncio.run(run())


def test_tap_receives_catalog_timeout_and_attempts(monkeypatch):
    calls = _fake_tap(monkeypatch)

    async def run():
        await catalogs.catalog("gaia", *FIELD)
    asyncio.run(run())
    assert calls == [{"timeout": config.CATALOG_READ_TIMEOUT_S,
                      "attempts": config.CATALOG_RETRY_ATTEMPTS}]


class _FakeResponse:
    content = b"ok"
    text = "ok"
    status_code = 200


class _FakeClient:
    def __init__(self):
        self.kw = None

    async def get(self, url, params=None, **kw):
        self.kw = kw
        return _FakeResponse()


def test_get_text_passes_per_request_timeout(monkeypatch):
    fake = _FakeClient()
    monkeypatch.setattr(archive, "client", lambda: fake)

    assert asyncio.run(archive.get_text("http://x", timeout=5.0)) == "ok"
    t = fake.kw["timeout"]
    assert isinstance(t, httpx.Timeout) and t.read == 5.0
    assert t.connect == config.HTTP_CONNECT_TIMEOUT_S

    asyncio.run(archive.get_text("http://x"))
    assert "timeout" not in fake.kw
