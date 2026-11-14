"""Tiny disk cache (atomic writes, optional TTL via mtime), in-memory TTL cache, single-flight."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import config

log = logging.getLogger(__name__)


def key_hash(*parts: Any) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()


def _path(kind: str, key: str, ext: str) -> Path:
    return config.CACHE_DIR / kind / key[:2] / f"{key}{ext}"


def get_bytes(kind: str, key: str, ttl: float | None = None) -> bytes | None:
    p = _path(kind, key, ".bin")
    try:
        if ttl is not None and time.time() - p.stat().st_mtime > ttl:
            return None
        return p.read_bytes()
    except OSError:
        return None


def put_bytes(kind: str, key: str, data: bytes) -> None:
    p = _path(kind, key, ".bin")
    tmp = None
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(f".tmp{os.getpid()}_{id(data)}")
        tmp.write_bytes(data)
        os.replace(tmp, p)
    except OSError as e:
        if tmp is not None:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
        log.warning("disk cache write failed for %s: %s", kind, e)  # response is still usable


def get_json(kind: str, key: str, ttl: float | None = None) -> Any | None:
    raw = get_bytes(kind, key, ttl)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def get_json_aged(kind: str, key: str) -> tuple[Any, float] | None:
    """(object, age in seconds) of a cached JSON entry, or None."""
    p = _path(kind, key, ".bin")
    try:
        age = time.time() - p.stat().st_mtime
        return json.loads(p.read_bytes()), age
    except (OSError, ValueError):
        return None


def put_json(kind: str, key: str, obj: Any) -> None:
    put_bytes(kind, key, json.dumps(obj, separators=(",", ":")).encode())


def list_json(kind: str) -> list[Any]:
    """All JSON entries of a cache kind (small index-like kinds only)."""
    out = []
    root = config.CACHE_DIR / kind
    try:
        files = sorted(root.glob("*/*.bin"))
    except OSError:
        return out
    for p in files:
        try:
            out.append(json.loads(p.read_bytes()))
        except (OSError, ValueError):
            continue
    return out


class TTLCache:
    def __init__(self, ttl: float, maxsize: int = 256) -> None:
        self.ttl, self.maxsize = ttl, maxsize
        self._d: dict[Any, tuple[float, Any]] = {}

    def get(self, key):
        hit = self._d.get(key)
        if hit and time.monotonic() - hit[0] < self.ttl:
            return hit[1]
        self._d.pop(key, None)
        return None

    def put(self, key, value) -> None:
        if len(self._d) >= self.maxsize:
            oldest = min(self._d, key=lambda k: self._d[k][0])
            self._d.pop(oldest, None)
        self._d[key] = (time.monotonic(), value)


class SingleFlight:
    """Coalesce concurrent calls for the same key into one in-flight task."""

    def __init__(self) -> None:
        self._inflight: dict[Any, list] = {}  # key -> [future, n_waiters]

    async def run(self, key, fn: Callable[[], Awaitable[Any]]):
        entry = self._inflight.get(key)
        if entry is None:
            fut = asyncio.ensure_future(fn())
            entry = [fut, 0]
            self._inflight[key] = entry
            fut.add_done_callback(lambda _f, k=key, e=entry: self._inflight.get(k) is e
                                  and self._inflight.pop(k, None))
        fut = entry[0]
        entry[1] += 1
        try:
            # shield: one caller going away must not kill a task others still wait for
            return await asyncio.shield(fut)
        finally:
            entry[1] -= 1
            if entry[1] == 0 and not fut.done():
                # A replacement request must not join a task that is still unwinding
                # cancellation (for example, closing an upstream streaming response).
                if self._inflight.get(key) is entry:
                    self._inflight.pop(key, None)
                fut.cancel()  # nobody is waiting any more
