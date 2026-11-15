"""Talking to IRSA: frame discovery (TAP), truncated cutout downloads, spectral WCS tables."""

from __future__ import annotations

import asyncio
import collections
import csv
import io
import logging
import random
import re
from dataclasses import dataclass, asdict

import httpx
import numpy as np

from . import cache, config, s3cutout
from .fitsstream import FitsFormatError, FitsSplitter, bintable_row0, split_bytes
from .geometry import WaveTable

log = logging.getLogger("spherex_app.archive")


class UpstreamError(RuntimeError):
    pass


class _Retryable(Exception):
    pass


# --- shared client / limits -------------------------------------------------------

STATS: collections.Counter = collections.Counter()  # retries, cutouts, bytes (for logs)
_client: httpx.AsyncClient | None = None
_s3_client: httpx.AsyncClient | None = None
_irsa_sem: asyncio.Semaphore | None = None
_s3_sem: asyncio.Semaphore | None = None
_wave_sem: asyncio.Semaphore | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(config.HTTP_READ_TIMEOUT_S, connect=config.HTTP_CONNECT_TIMEOUT_S),
            headers={"User-Agent": config.USER_AGENT},
            follow_redirects=True,
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
        )
    return _client


def s3_client() -> httpx.AsyncClient:
    """Separate pool for S3 (HTTP/1.1 only, so parallelism = connections; keep them alive)."""
    global _s3_client
    if _s3_client is None:
        _s3_client = httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=config.HTTP_CONNECT_TIMEOUT_S),
            headers={"User-Agent": config.USER_AGENT},
            limits=httpx.Limits(max_connections=config.S3_MAX_CONNECTIONS,
                                max_keepalive_connections=config.S3_MAX_CONNECTIONS,
                                keepalive_expiry=30.0),
        )
    return _s3_client


def irsa_sem() -> asyncio.Semaphore:
    global _irsa_sem
    if _irsa_sem is None:
        _irsa_sem = asyncio.Semaphore(config.IRSA_CONCURRENCY)
    return _irsa_sem


def s3_sem() -> asyncio.Semaphore:
    global _s3_sem
    if _s3_sem is None:
        _s3_sem = asyncio.Semaphore(config.S3_CONCURRENCY)
    return _s3_sem


def wave_sem() -> asyncio.Semaphore:
    global _wave_sem
    if _wave_sem is None:
        _wave_sem = asyncio.Semaphore(config.S3_WAVE_CONCURRENCY)
    return _wave_sem


async def close() -> None:
    global _client, _s3_client, _irsa_sem, _s3_sem, _wave_sem
    # A stale-list refresh belongs to this client's lifetime, including ASGI shutdown.
    tasks = list(_bg_tasks)
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    for c in (_client, _s3_client):
        if c is not None:
            await c.aclose()
    _client = _s3_client = None
    _irsa_sem = _s3_sem = None
    _wave_sem = None


async def with_retries(what: str, fn, attempts: int | None = None,
                       retry_on: tuple = ()):
    """Run `fn()` (async), retrying on _Retryable / transport errors with exponential backoff."""
    attempts = attempts or config.RETRY_ATTEMPTS
    delay = config.RETRY_BACKOFF_S
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            return await fn()
        except (_Retryable, httpx.TransportError, FitsFormatError, *retry_on) as e:
            last = e
            STATS["retries"] += 1
            if attempt + 1 < attempts:
                log.debug("%s failed (%s), retry %d", what, e, attempt + 1)
                await asyncio.sleep(delay * (0.75 + 0.5 * random.random()))
                delay = min(delay * config.RETRY_BACKOFF_FACTOR, config.RETRY_BACKOFF_MAX_S)
    raise UpstreamError(f"{what}: {last}")


def _check_status(r: httpx.Response, body: bytes | None = None) -> None:
    if r.status_code >= 500 or r.status_code == 429:
        raise _Retryable(f"HTTP {r.status_code}")
    if r.status_code >= 400:
        snippet = (body or b"")[:200].decode("utf-8", "replace")
        raise UpstreamError(f"HTTP {r.status_code} {snippet}".strip())


async def get_text(url: str, params: dict | None = None, *, irsa: bool = False,
                   what: str = "request", timeout: float | None = None,
                   attempts: int | None = None) -> str:
    """GET a text body. `timeout` (read seconds) and `attempts` override the shared defaults."""
    kw = {}
    if timeout is not None:
        kw["timeout"] = httpx.Timeout(timeout, connect=config.HTTP_CONNECT_TIMEOUT_S)

    async def once():
        if irsa:
            async with irsa_sem():
                r = await client().get(url, params=params, **kw)
        else:
            r = await client().get(url, params=params, **kw)
        STATS["net_bytes"] += len(r.content)
        STATS["irsa_bytes" if irsa else "other_bytes"] += len(r.content)
        _check_status(r, r.content)
        return r.text
    return await with_retries(what, once, attempts=attempts)


async def tap_csv(url: str, adql: str, *, irsa: bool, what: str,
                  timeout: float | None = None, attempts: int | None = None) -> list[dict]:
    params = {"QUERY": adql, "FORMAT": "csv"}
    if not irsa:
        params.update({"REQUEST": "doQuery", "LANG": "ADQL"})
    text = await get_text(url, params, irsa=irsa, what=what, timeout=timeout, attempts=attempts)
    if text.lstrip().startswith("<"):
        # VOTable error document
        m = re.search(r"<INFO[^>]*name=\"QUERY_STATUS\"[^>]*>(.*?)</INFO>", text, re.S)
        raise UpstreamError(f"{what}: {m.group(1).strip() if m else text[:200]}")
    return list(csv.DictReader(io.StringIO(text)))


# --- frame discovery -------------------------------------------------------------

@dataclass
class Frame:
    id: str
    obsid: str
    detector: int
    mjd: float
    mjd_end: float
    exptime: float | None
    release: str
    version: str
    pipeline: str | None
    uri: str

    def public(self) -> dict:
        d = asdict(self)
        d.pop("uri")
        return d


_ID_RE = re.compile(r"level2_(.+?)_spx_")


def _release_rank(rel: str):
    m = re.match(r"([a-z]+)(\d*)", rel)
    kind, num = (m.group(1), int(m.group(2) or 0)) if m else (rel, 0)
    return ({"dr": 3, "qr": 2}.get(kind, 1), num)


def _version_rank(ver: str):
    return tuple(int(x) for x in re.findall(r"\d+", ver))


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_frame_rows(rows: list[dict]) -> list[Frame]:
    best: dict[tuple[str, int], Frame] = {}
    for row in rows:
        uri = (row.get("uri") or "").strip()
        if not uri:
            continue
        parts = uri.split("/")
        fname = parts[-1]
        m = _ID_RE.search(fname)
        fid = m.group(1) if m else fname.rsplit(".", 1)[0]
        dm = re.search(r"D(\d)\s*$", row.get("energy_bandpassname") or "") or re.search(r"D(\d)$", fid)
        if not dm:
            continue
        det = int(dm.group(1))
        try:
            i = parts.index("spherex")
            release = parts[i + 1]
        except (ValueError, IndexError):
            release = ""
        version = parts[-3] if len(parts) >= 3 else ""
        obsid = re.sub(r"D\d$", "", fid)
        mjd = _f(row.get("time_bounds_lower"))
        if mjd is None:
            continue
        fr = Frame(id=fid, obsid=obsid, detector=det, mjd=mjd,
                   mjd_end=_f(row.get("time_bounds_upper")) or mjd,
                   exptime=_f(row.get("time_exposure")), release=release, version=version,
                   pipeline=(row.get("provenance_version") or None), uri=uri)
        key = (obsid, det)
        old = best.get(key)
        if old is None or (_release_rank(fr.release), _version_rank(fr.version)) > \
                (_release_rank(old.release), _version_rank(old.version)):
            best[key] = fr
    return sorted(best.values(), key=lambda f: (f.mjd, f.detector))


_frames_cache = cache.TTLCache(config.TAP_TTL_S)
_frames_flight = cache.SingleFlight()
_bg_tasks: set = set()
_FRAME_COLS = ("uri", "energy_bandpassname", "time_bounds_lower", "time_bounds_upper",
               "time_exposure", "provenance_version")


async def _query_frames(ra: float, dec: float, key, dkey: str) -> list[Frame]:
    rows = await tap_csv(config.IRSA_TAP_SYNC, config.FRAMES_ADQL.format(ra=ra, dec=dec),
                         irsa=True, what="IRSA TAP frame query")
    frames = parse_frame_rows(rows)
    _frames_cache.put(key, frames)
    cache.put_json("frames", dkey, [{c: r.get(c) for c in _FRAME_COLS} for r in rows])
    cache.put_json("frames_index", dkey, {"ra": ra, "dec": dec, "n_frames": len(frames)})
    STATS["tap_queries"] += 1
    return frames


async def find_frames(ra: float, dec: float) -> list[Frame]:
    key = (round(ra, 6), round(dec, 6))
    hit = _frames_cache.get(key)
    if hit is not None:
        return hit
    dkey = cache.key_hash("frames-v1", *key)

    def run():
        return _query_frames(ra, dec, key, dkey)

    disk = cache.get_json_aged("frames", dkey)
    if disk is not None and disk[1] < config.FRAMES_STALE_MAX_S:
        rows, age = disk
        frames = parse_frame_rows(rows)
        if cache.get_bytes("frames_index", dkey) is None:  # lists cached before the index existed
            cache.put_json("frames_index", dkey, {"ra": ra, "dec": dec, "n_frames": len(frames)})
        if age < config.FRAMES_DISK_TTL_S:
            _frames_cache.put(key, frames)
            return frames
        # stale: answer now, refresh in the background for the next request
        _frames_cache.put(key, frames)

        async def refresh():
            try:
                await _frames_flight.run(key, run)
            except Exception as e:  # noqa: BLE001
                log.warning("background frame-list refresh failed: %s", e)
        t = asyncio.ensure_future(refresh())
        _bg_tasks.add(t)
        t.add_done_callback(_bg_tasks.discard)
        return frames

    return await _frames_flight.run(key, run)


VISIT_GAP_DAYS = 20.0  # a gap longer than this starts a new visit (as EPOCH_GAP in the frontend)


def thin_per_visit(frames: list[Frame], per_visit: int) -> list[Frame]:
    """At most `per_visit` frames per (detector, visit), spread evenly in time."""
    by_det: dict[int, list[Frame]] = {}
    for f in frames:
        by_det.setdefault(f.detector, []).append(f)
    out: list[Frame] = []
    for lst in by_det.values():
        lst.sort(key=lambda f: f.mjd)
        visit: list[Frame] = []
        for f in lst + [None]:
            if f is not None and (not visit or f.mjd - visit[-1].mjd <= VISIT_GAP_DAYS):
                visit.append(f)
                continue
            if len(visit) <= per_visit:
                out.extend(visit)
            else:
                idx = np.unique(np.round(np.linspace(0, len(visit) - 1, per_visit)).astype(int))
                out.extend(visit[i] for i in idx)
            visit = [f] if f is not None else []
    out.sort(key=lambda f: (f.mjd, f.detector))
    return out


def select_frames(frames: list[Frame], detectors, mjd_min, mjd_max, max_frames: int,
                  per_visit: int | None = None):
    """Filter, optionally thin per visit, then thin evenly in time within each detector.
    Returns (selected, n_available); n_available counts frames after the filter and per_visit."""
    pool = [f for f in frames if f.detector in detectors
            and (mjd_min is None or f.mjd >= mjd_min) and (mjd_max is None or f.mjd <= mjd_max)]
    if per_visit is not None and per_visit >= 1:
        pool = thin_per_visit(pool, per_visit)
    n = len(pool)
    if n <= max_frames:
        return pool, n
    by_det: dict[int, list[Frame]] = {}
    for f in pool:
        by_det.setdefault(f.detector, []).append(f)
    # proportional quotas (largest remainder), at least 1 per detector when possible
    dets = sorted(by_det)
    exact = {d: max_frames * len(by_det[d]) / n for d in dets}
    quota = {d: int(exact[d]) for d in dets}
    rest = max_frames - sum(quota.values())
    for d in sorted(dets, key=lambda d: exact[d] - quota[d], reverse=True)[:rest]:
        quota[d] += 1
    out: list[Frame] = []
    for d in dets:
        lst = sorted(by_det[d], key=lambda f: f.mjd)
        q = min(quota[d], len(lst))
        if q <= 0:
            continue
        idx = np.unique(np.round(np.linspace(0, len(lst) - 1, q)).astype(int))
        out.extend(lst[i] for i in idx)
    out.sort(key=lambda f: (f.mjd, f.detector))
    return out, n


# --- cutouts ------------------------------------------------------------------------

def cutout_size_deg(fov: float) -> float:
    q = config.CUTOUT_SIZE_QUANTUM_DEG
    return round(float(np.ceil(fov * config.CUTOUT_SIZE_FACTOR / q - 1e-9) * q), 4)


def cutout_url(uri: str, ra: float, dec: float, size: float) -> str:
    return f"{config.IRSA_BASE}/{uri}?center={ra:.7f},{dec:.7f}d&size={size:g}"


def file_url(uri: str) -> str:
    return f"{config.IRSA_BASE}/{uri}"


_cutout_flight = cache.SingleFlight()


async def _cutout_from_irsa(uri: str, ra: float, dec: float, size: float) -> bytes:
    """IRSA cutout service, read as a stream and cut off after the ZODI HDU."""
    url = cutout_url(uri, ra, dec, size)

    async def once():
        async with irsa_sem():
            splitter = FitsSplitter()
            STATS["irsa_requests"] += 1
            async with client().stream("GET", url) as r:
                if r.status_code != 200:
                    body = await r.aread()
                    STATS["net_bytes"] += len(body)
                    STATS["irsa_bytes"] += len(body)
                    _check_status(r, body)
                    raise UpstreamError(f"HTTP {r.status_code}")
                async for chunk in r.aiter_bytes(65536):
                    STATS["net_bytes"] += len(chunk)
                    STATS["irsa_bytes"] += len(chunk)
                    if splitter.feed(chunk) >= config.CUTOUT_HDUS_NEEDED:
                        break  # leaving the context closes the connection
            if len(splitter.hdus) < config.CUTOUT_HDUS_NEEDED:
                raise _Retryable(f"cutout truncated after {len(splitter.hdus)} HDUs")
            return splitter.consumed_bytes()

    return await with_retries(f"IRSA cutout {uri.rsplit('/', 1)[-1]}", once)


async def _cutout_from_s3(uri: str, ra: float, dec: float, size: float) -> bytes:
    """Same bytes as the IRSA cutout, assembled from Range reads of the S3 mirror."""
    async def once():
        async with s3_sem():
            return await s3cutout.fetch_cutout_bytes(s3_client(), uri, ra, dec, size, STATS)

    # S3Missing (404/403) and layout errors are not retried: fall back at once
    return await with_retries(f"S3 cutout {uri.rsplit('/', 1)[-1]}", once,
                              attempts=config.S3_RETRY_ATTEMPTS,
                              retry_on=(s3cutout.S3Transient,))


_SOURCES = {"s3": _cutout_from_s3, "irsa": _cutout_from_irsa}


def cutout_sources() -> list[str]:
    first = config.CUTOUT_SOURCE if config.CUTOUT_SOURCE in _SOURCES else "s3"
    return [first] + [k for k in _SOURCES if k != first]


def _validate_cutout(data: bytes) -> None:
    """Reject corrupt upstream results before they can poison the shared disk cache."""
    hdus = split_bytes(data)
    if [h.name for h in hdus[:5]] != ["", "IMAGE", "FLAGS", "VARIANCE", "ZODI"]:
        raise FitsFormatError("cutout does not contain the four expected image planes")
    shape = (hdus[1].cards.get("NAXIS1"), hdus[1].cards.get("NAXIS2"))
    if not all(isinstance(n, int) and n > 0 for n in shape):
        raise FitsFormatError("empty cutout")
    for h, bitpix in zip(hdus[1:5], (-32, 32, -32, -32)):
        if h.cards.get("BITPIX") != bitpix or h.cards.get("NAXIS") != 2 or \
                (h.cards.get("NAXIS1"), h.cards.get("NAXIS2")) != shape:
            raise FitsFormatError(f"unexpected {h.name} type or shape")


async def fetch_cutout(uri: str, ra: float, dec: float, size: float) -> tuple[bytes, bool]:
    """Bytes of HDUs 0..4 of the cutout (disk-cached). Returns (bytes, from_cache).

    Both sources produce the same bytes layout, so the cache is shared between them."""
    key = cache.key_hash(uri, f"{ra:.7f}", f"{dec:.7f}", f"{size:g}")
    hit = cache.get_bytes("cutouts", key)
    if hit is not None:
        return hit, True

    async def run():
        errors = []
        for i, src in enumerate(cutout_sources()):
            try:
                data = await _SOURCES[src](uri, ra, dec, size)
                _validate_cutout(data)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                errors.append(f"{src}: {e}")
                if i == 0:
                    STATS["fallbacks"] += 1
                    log.info("cutout via %s failed for %s (%s); falling back", src,
                             uri.rsplit("/", 1)[-1], e)
                continue
            STATS["cutouts"] += 1
            STATS[f"cutouts_{src}"] += 1
            STATS["cutout_bytes"] += len(data)
            cache.put_bytes("cutouts", key, data)
            return data
        raise UpstreamError("; ".join(errors))

    return await _cutout_flight.run(key, run), False


# --- spectral WCS (WCS-WAVE) tables ------------------------------------------------------

_wave_mem: dict[str, WaveTable] = {}
_wave_flight = cache.SingleFlight()


def _wave_key(uri: str, detector: int) -> str:
    parts = uri.split("/")
    vdir = "/".join(parts[:-4] + [parts[-3]]) if len(parts) >= 4 else uri  # drop week dir
    return f"{vdir}|D{detector}"


def parse_wave_tail(tail: bytes) -> WaveTable:
    """Find the WCS-WAVE BINTABLE in the last few blocks of a SPHEREx L2 file."""
    best = None
    for off in range(0, len(tail) - 2880 + 1, 80):
        if tail.startswith(b"XTENSION= 'BINTABLE'", off):
            best = off  # keep the last one
    if best is None:
        raise FitsFormatError("no BINTABLE header in file tail")
    fake = b"SIMPLE  =                    T" + b" " * 50 + b"END".ljust(80) + b" " * (2880 - 160)
    hdus = split_bytes(fake + tail[best:])
    for h in hdus:
        if h.name == "WCS-WAVE":
            return WaveTable.from_row(bintable_row0(h.header(), h.data_bytes))
    raise FitsFormatError("WCS-WAVE table not found in file tail")


async def wave_table(uri: str, detector: int, ra: float, dec: float) -> WaveTable | None:
    key = _wave_key(uri, detector)
    if key in _wave_mem:
        return _wave_mem[key]
    hk = cache.key_hash(key)
    j = cache.get_json("wavetab", hk)
    if j is not None:
        t = WaveTable.from_json(j)
        _wave_mem[key] = t
        return t

    async def from_s3():
        url = config.S3_BASE + uri.removeprefix(config.URI_S3_STRIP_PREFIX)
        # A completed cutout needs this table before the browser can display it. Keep
        # calibration reads out of the queue of pending frame downloads.
        async with wave_sem():
            async with s3_client().stream("GET", url, headers={"Range": "bytes=-8640"}) as r:
                STATS["s3_requests"] += 1
                _check_status(r)
                if r.status_code != 206:
                    raise UpstreamError(f"S3 WCS-WAVE Range returned HTTP {r.status_code}")
                m = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)",
                                 r.headers.get("content-range", ""))
                if m is None:
                    raise FitsFormatError("invalid WCS-WAVE Content-Range")
                lo, hi, total = map(int, m.groups())
                if hi != total - 1 or lo != max(0, total - 8640):
                    raise FitsFormatError("incorrect WCS-WAVE suffix range")
                tail = bytearray()
                async for chunk in r.aiter_bytes():
                    STATS["net_bytes"] += len(chunk)
                    STATS["s3_bytes"] += len(chunk)
                    tail.extend(chunk)
                    if len(tail) > 8640:
                        raise FitsFormatError("oversized WCS-WAVE suffix")
                if len(tail) != hi - lo + 1:
                    raise FitsFormatError("truncated WCS-WAVE suffix")
        return parse_wave_tail(bytes(tail))

    async def from_full_cutout():
        async with irsa_sem():
            r = await client().get(cutout_url(uri, ra, dec, 0.02))
        STATS["net_bytes"] += len(r.content)
        STATS["irsa_bytes"] += len(r.content)
        STATS["irsa_requests"] += 1
        _check_status(r, r.content)
        for h in split_bytes(r.content):
            if h.name == "WCS-WAVE":
                return WaveTable.from_row(bintable_row0(h.header(), h.data_bytes))
        raise FitsFormatError("WCS-WAVE missing from full cutout")

    async def run():
        try:
            t = await with_retries("S3 WCS-WAVE", from_s3, attempts=config.S3_RETRY_ATTEMPTS)
        except Exception as e:  # noqa: BLE001
            log.warning("S3 WCS-WAVE failed for %s (%s); falling back to full cutout", key, e)
            t = await with_retries("WCS-WAVE via cutout", from_full_cutout)
        _wave_mem[key] = t
        cache.put_json("wavetab", hk, t.to_json())
        return t

    try:
        return await _wave_flight.run(key, run)
    except Exception as e:  # noqa: BLE001
        log.warning("no wavelength table for %s: %s", key, e)
        return None
