"""3D scene for the fly-through view: Gaia (E)DR3 stars with Bailer-Jones distances, and the solar system.

Frame: ICRS equatorial Cartesian axes, origin at the Sun. x toward RA=0 Dec=0, y toward RA=90
Dec=0, z toward Dec=+90. Stars are in parsecs, solar-system bodies in AU.

Star sources (config.GAIA3D_SOURCE): a single cone query to the GAVO or ARI mirror is tried first.
If it fails, the cone is answered from the ESA archive in tiles, because the ESA sync endpoint
aborts queries that run longer than about a minute. Every source maps its columns to the same
record shape: [source_id, ra, dec, G, bp_rp, r_med_pc, r_lo_pc, r_hi_pc].

The pure functions are synchronous and offline-testable; `build_scene` is the async entry point
the API route calls.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time

from astropy.time import Time

from . import cache, catalogs, config, movers
from .archive import UpstreamError
# the solar helpers moved to objects_live; re-exported so `scene3d.X` keeps resolving
from .objects_live import PLANETS, bodies_xyz, radec_to_xyz, solar_positions  # noqa: F401

log = logging.getLogger(__name__)

STAR_CACHE_KIND = "scene3d-tiles"
SOURCE_LABELS = {
    "gavo": "Gaia EDR3 (GAVO Data Center) + Bailer-Jones (2021) geometric distances",
    "ari": "Gaia EDR3 (ARI Heidelberg) + Bailer-Jones (2021) geometric distances",
    "esa": "Gaia DR3 (ESA archive) + Bailer-Jones (2021) geometric distances",
}
STAR_FIELDS = ["id", "x", "y", "z", "abs_g", "bp_rp", "d_lo", "d_hi"]
STAR_EPOCH = 2016.0
SKYBOT_JD_OFFSET = 2400000.5
# Accepted dates: 1900-01-01 .. 2100-01-01 (the built-in ephemeris is only meant for that span)
MJD_MIN, MJD_MAX = 15020.0, 88069.0

# ESA tiling: tile radius (deg). A hex lattice of spacing s has covering radius s/sqrt(3); the
# 0.97 margin absorbs the difference between gnomonic-plane and true angular distances.
TILE_R_DEG = 1.0
_HEX_SPACING_FACTOR = math.sqrt(3.0) * 0.97
# Per-tile TOP cap = min(limit, ceil(TILE_CAP_FACTOR * limit * tile_area / cone_area)): a tile
# holds about limit * tile_area / cone_area of the final stars, so the cap leaves a margin.
TILE_CAP_FACTOR = 2.5


def _f(v) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def angsep_deg(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    """Great-circle separation in degrees (haversine; fine at any separation and near the poles)."""
    r1, d1, r2, d2 = math.radians(ra1), math.radians(dec1), math.radians(ra2), math.radians(dec2)
    h = math.sin((d2 - d1) / 2) ** 2 + math.cos(d1) * math.cos(d2) * math.sin((r2 - r1) / 2) ** 2
    return math.degrees(2 * math.asin(min(1.0, math.sqrt(h))))


def _gnomonic_inv(a0: float, d0: float, xi: float, eta: float) -> tuple[float, float]:
    """Inverse gnomonic projection about (a0, d0), all in radians; (xi, eta) are tangent-plane
    coordinates (tan of the angular offset). Valid at any dec, including the poles."""
    rho = math.hypot(xi, eta)
    if rho == 0.0:
        return a0, d0
    c = math.atan(rho)
    sc, cc = math.sin(c), math.cos(c)
    sd0, cd0 = math.sin(d0), math.cos(d0)
    dec = math.asin(max(-1.0, min(1.0, cc * sd0 + eta * sc * cd0 / rho)))
    ra = a0 + math.atan2(xi * sc, rho * cd0 * cc - eta * sd0 * sc)
    return ra, dec


def tile_centres(ra: float, dec: float, radius: float,
                 tile_r: float = TILE_R_DEG) -> list[tuple[float, float, float]]:
    """Cone centres (ra, dec, radius) that together cover the disk (ra, dec, radius).

    A single tile is returned when radius <= tile_r. Otherwise a hexagonal lattice in the
    gnomonic tangent plane at (ra, dec): every point within `radius` of the centre lies within
    `tile_r` of some returned centre. Centres are kept when their disk reaches the query disk,
    i.e. angular distance <= radius + tile_r (a smaller margin would drop centres that cover
    points on the query edge)."""
    if radius <= tile_r:
        return [(ra % 360.0, dec, radius)]
    a0, d0 = math.radians(ra), math.radians(dec)
    tr = math.radians(tile_r)
    s = _HEX_SPACING_FACTOR * tr
    lim = math.radians(radius + tile_r)
    n = int(lim / s) + 3
    out = []
    for j in range(-n, n + 1):
        for i in range(-n, n + 1):
            xi = s * (i + j / 2.0)
            eta = s * j * math.sqrt(3.0) / 2.0
            if math.atan(math.hypot(xi, eta)) > lim:  # gnomonic: atan(rho) = angular distance
                continue
            r, d = _gnomonic_inv(a0, d0, xi, eta)
            out.append((math.degrees(r) % 360.0, math.degrees(d), tile_r))
    return out


def tile_cap(limit: int, radius: float, tile_r: float = TILE_R_DEG) -> int:
    """TOP for each ESA tile. A single cone (radius <= tile_r) keeps the exact `limit`."""
    if radius <= tile_r:
        return limit
    return min(limit, math.ceil(TILE_CAP_FACTOR * limit * (tile_r / radius) ** 2))


def _record(r: dict) -> list | None:
    """One TAP row -> [source_id, ra, dec, G, bp_rp, r_med_pc, r_lo_pc, r_hi_pc] or None."""
    sid = (r.get("source_id") or "").strip()
    ra, dec = _f(r.get("ra")), _f(r.get("dec"))
    d = _f(r.get("r_med_geo"))
    g = _f(r.get("phot_g_mean_mag"))
    if not sid or ra is None or dec is None or g is None or d is None or d <= 0:
        return None
    return [sid, ra, dec, g, _f(r.get("bp_rp")), d, _f(r.get("r_lo_geo")), _f(r.get("r_hi_geo"))]


def _r(v, nd: int = 4):
    return None if v is None else round(v, nd)


def _output_row(rec: list) -> list:
    """Record -> [id, x_pc, y_pc, z_pc, abs_g, bp_rp, d_lo_pc, d_hi_pc] (abs_g = G + 5 - 5 log10 d)."""
    sid, ra, dec, g, bp, d, lo, hi = rec
    x, y, z = radec_to_xyz(ra, dec, d)
    return [sid, _r(x), _r(y), _r(z), _r(g + 5.0 - 5.0 * math.log10(d)), _r(bp), _r(lo), _r(hi)]


def star_rows_from_csv(rows: list[dict]) -> list[list]:
    """Gaia/Bailer-Jones TAP rows (ESA or ARI column names) -> output star rows."""
    return [_output_row(rec) for rec in (_record(r) for r in rows) if rec is not None]


# --- per-source fetchers: each returns raw rows already carrying the ESA/ARI column names ---

async def _gaia_csv(ra: float, dec: float, radius: float, limit: int) -> list[dict]:
    """ESA archive, one cone. One attempt only: a failed tile is retried later, not in-request."""
    return await catalogs.tap_csv(
        config.GAIA_TAP_SYNC,
        config.GAIA3D_ADQL.format(n=limit, ra=ra, dec=dec, r=radius),
        irsa=False, what="Gaia TAP (ESA)",
        timeout=config.GAIA3D_READ_TIMEOUT_S, attempts=1)


async def _gavo_csv(ra: float, dec: float, radius: float, limit: int) -> list[dict]:
    """GAVO Data Center (EDR3 lite joined with Bailer-Jones). Its table has the BP and RP
    magnitudes but no bp_rp, so bp_rp is derived here."""
    rows = await catalogs.tap_csv(
        config.GAVO_TAP_SYNC,
        config.GAVO3D_ADQL.format(n=limit, ra=ra, dec=dec, r=radius),
        irsa=False, what="GAVO TAP", timeout=config.GAIA3D_READ_TIMEOUT_S,
        attempts=config.CATALOG_RETRY_ATTEMPTS, extra={"MAXREC": str(limit)})
    for r in rows:
        bp, rp = _f(r.get("phot_bp_mean_mag")), _f(r.get("phot_rp_mean_mag"))
        r["bp_rp"] = None if bp is None or rp is None else bp - rp
    return rows


async def _ari_csv(ra: float, dec: float, radius: float, limit: int) -> list[dict]:
    """ARI Heidelberg Gaia mirror (EDR3 with the Bailer-Jones join; bp_rp is provided)."""
    return await catalogs.tap_csv(
        config.ARI_TAP_SYNC,
        config.ARI3D_ADQL.format(n=limit, ra=ra, dec=dec, r=radius),
        irsa=False, what="Gaia TAP (ARI)", timeout=config.GAIA3D_READ_TIMEOUT_S,
        attempts=config.CATALOG_RETRY_ATTEMPTS, extra={"MAXREC": str(limit)})


async def _fetch(source: str, ra: float, dec: float, radius: float, limit: int) -> list[dict]:
    # looked up at call time, so tests can replace a fetcher by name
    fetch = {"gavo": _gavo_csv, "ari": _ari_csv, "esa": _gaia_csv}[source]
    return await fetch(ra, dec, radius, limit)


# --- disk cache and negative cache -------------------------------------------------------

def _cone_key(source: str, ra: float, dec: float, radius: float, limit: int) -> str:
    return cache.key_hash("scene3d-cone-2", source, f"{ra:.7f}", f"{dec:.7f}", f"{radius:.6f}", limit)


_failed_tiles: dict[str, float] = {}  # cone key -> time.monotonic() of the last failure


class TileSkipped(UpstreamError):
    """A tile that failed recently, not queried again yet."""


def _tile_recently_failed(key: str) -> bool:
    t = _failed_tiles.get(key)
    if t is None:
        return False
    if time.monotonic() - t < config.GAIA3D_TILE_FAIL_TTL_S:
        return True
    _failed_tiles.pop(key, None)
    return False


async def cone_block(source: str, ra: float, dec: float, radius: float, limit: int) -> dict:
    """One cone query: {"n_raw": rows the TAP query returned, "recs": records}. Disk-cached per
    cone, so a retry only re-runs the cones that failed. Raises UpstreamError on failure."""
    key = _cone_key(source, ra, dec, radius, limit)
    hit = cache.get_json(STAR_CACHE_KIND, key, ttl=config.CATALOG_TTL_S)
    if hit is not None:
        return hit
    raw = await _fetch(source, ra, dec, radius, limit)
    out = {"n_raw": len(raw), "recs": [rec for rec in (_record(r) for r in raw) if rec]}
    cache.put_json(STAR_CACHE_KIND, key, out)
    return out


# --- merge -----------------------------------------------------------------------------

def _merge(parts: list[tuple[dict, int]], ra: float, dec: float, radius: float, limit: int,
           failed: int, source: str) -> dict:
    """Dedupe by source_id, keep stars within `radius`, brightest `limit` by apparent G.
    `parts` are (cone result, cone TOP) pairs. truncated: the merge had more than `limit` stars,
    or a cone returned its TOP (so it may have had more stars than were fetched)."""
    seen: dict[str, list] = {}
    for cone, _cap in parts:
        for rec in cone["recs"]:
            if rec[0] in seen or angsep_deg(ra, dec, rec[1], rec[2]) > radius:
                continue
            seen[rec[0]] = rec
    merged = sorted(seen.values(), key=lambda rec: rec[3])  # apparent G, brightest first
    capped = any(cone["n_raw"] >= cap for cone, cap in parts)
    return {
        "source": source,
        "rows": [_output_row(rec) for rec in merged[:limit]],
        "truncated": len(merged) > limit or capped,
        "incomplete": failed > 0,
        "failed_tiles": failed,
    }


async def _esa_tiles(ra: float, dec: float, radius: float, limit: int) -> dict:
    tiles = tile_centres(ra, dec, radius)
    cap = tile_cap(limit, radius)
    sem = asyncio.Semaphore(config.GAIA3D_TILE_CONCURRENCY)

    async def one(t: tuple[float, float, float]) -> dict:
        tra, tdec, tr = t
        key = _cone_key("esa", tra, tdec, tr, cap)
        if _tile_recently_failed(key):
            raise TileSkipped(f"Gaia TAP (ESA) tile at ra={tra:.3f} dec={tdec:.3f} failed recently")
        async with sem:
            try:
                return await cone_block("esa", tra, tdec, tr, cap)
            except Exception:
                _failed_tiles[key] = time.monotonic()
                raise

    res = await asyncio.gather(*(one(t) for t in tiles), return_exceptions=True)
    ok = [r for r in res if not isinstance(r, BaseException)]
    failed = len(res) - len(ok)
    if not ok:
        err = res[0]
        if isinstance(err, UpstreamError):
            raise err
        raise UpstreamError(f"Gaia TAP (ESA): {err}") from err
    return _merge([(c, cap) for c in ok], ra, dec, radius, limit, failed, "esa")


async def stars_block(ra: float, dec: float, radius: float, limit: int) -> dict:
    """Stars within `radius` of (ra, dec), brightest `limit` of them.

    The primary source (config.GAIA3D_SOURCE) answers the whole cone in one query when it
    works. Otherwise, or if it fails, the ESA archive answers in tiles, each capped at
    tile_cap(). Raises UpstreamError only if the fallback fails for every tile."""
    primary = config.GAIA3D_SOURCE
    if primary != "esa":
        try:
            cone = await cone_block(primary, ra, dec, radius, limit)
            return _merge([(cone, limit)], ra, dec, radius, limit, 0, primary)
        except Exception as e:  # noqa: BLE001  (any failure of the primary falls back)
            log.warning("scene3d: %s star query failed (%s: %s); using ESA tiles",
                        primary, type(e).__name__, e)
    return await _esa_tiles(ra, dec, radius, limit)


def _now_mjd() -> float:
    """Now, rounded to the hour so repeat requests reuse the cached SkyBoT cone."""
    return round(float(Time.now().tdb.mjd) * 24.0) / 24.0


async def build_scene(ra: float, dec: float, radius: float, limit: int,
                      mjd: float | None = None) -> dict:
    """The /api/scene3d payload. A star failure of every source raises UpstreamError (502);
    partial ESA tile failures are reported in stars.incomplete/failed_tiles. A SkyBoT failure is
    reported in solar.bodies_error and does not fail the request."""
    mjd = _now_mjd() if mjd is None else float(mjd)

    async def solar() -> tuple[dict, list[dict], str | None]:
        sol = await asyncio.to_thread(solar_positions, mjd)
        try:
            objs = await movers.skybot_cone(ra, dec, radius, mjd + SKYBOT_JD_OFFSET)
        except Exception as e:  # noqa: BLE001  (SkyBoT is optional for the scene)
            return sol, [], str(e) or type(e).__name__
        return sol, bodies_xyz(sol["earth"], objs), None

    stars, (sol, bodies, bodies_error) = await asyncio.gather(
        stars_block(ra, dec, radius, limit), solar())

    return {
        "ra": ra, "dec": dec, "radius": radius, "mjd": mjd,
        "stars": {
            "epoch": STAR_EPOCH, "source": SOURCE_LABELS[stars["source"]], "fields": STAR_FIELDS,
            "rows": stars["rows"], "truncated": stars["truncated"],
            "incomplete": stars["incomplete"], "failed_tiles": stars["failed_tiles"],
        },
        "solar": {
            "earth": sol["earth"], "sun": [0, 0, 0], "planets": sol["planets"],
            "bodies": bodies, "bodies_error": bodies_error,
        },
    }
