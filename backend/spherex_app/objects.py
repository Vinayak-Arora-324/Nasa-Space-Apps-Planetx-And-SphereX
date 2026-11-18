"""Object framework for the 3D view: the record schema, its validator, and the /api/objects merge.

Schema id "space-maps.objects/1" (docs/object-framework.md). A record is a plain JSON object with an
`id`, a `kind`, one `position` model (`fixed`, `state` or `orbit`), quantities that each carry their own
`src` and `tier`, a `provenance` block and one record-level `evidence` that says how well the *drawn
placement* is known: measured, derived or illustrative.

Evidence rule (validated here): the evidence of a record may never be stronger than its position allows.
The governing tier is the position's own tier for `state` and `orbit` positions and the distance tier for
`fixed` positions (the position tier when the distance is unknown). A `measured` or `catalogue` tier
allows at most `measured`, `inferred` allows at most `derived`, `illustrative` allows only `illustrative`.
An orbit whose phase is unknown is always `illustrative`.

Data comes from sources (`Source`): live ones (`objects_live`: ephemeris, SkyBoT) and prebuilt static
datasets (`objects_static`: tiled JSON under config.OBJECTS_DIR). `build_objects` runs every source that
serves a requested kind, concurrently and under a deadline; a failing or slow source costs only its own
kinds. Sources are registered lazily on the first call so tests can point config.OBJECTS_DIR elsewhere.

Everything except `build_objects` is synchronous, pure and offline-testable.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from astropy.time import Time

from . import config

log = logging.getLogger(__name__)

SCHEMA = "space-maps.objects/1"
TILE_FORMAT = "space-maps.object-tiles/1"

# Output order of kinds (also the order of `kinds` in a response).
KINDS = ("sun", "planet", "moon", "dwarf_planet", "asteroid", "comet", "star", "exoplanet",
         "cluster", "nebula", "black_hole", "galaxy")
TIERS = ("measured", "catalogue", "inferred", "illustrative")
EVIDENCE = ("measured", "derived", "illustrative")
UNITS = ("km", "au", "pc", "Mpc", "deg", "arcmin", "arcsec", "mag", "K", "d", "yr", "Gyr", "Msun",
         "Mjup", "Mearth", "Rsun", "Rjup", "Rearth", "arcsec/h")
# `fixed` positions: how the distance was obtained. `state` positions use STATE_METHODS.
METHODS = ("parallax", "bailer-jones", "cluster-parallax", "photometric", "kinematic", "cepheid",
           "trgb", "sbf", "tully-fisher", "redshift", "orbit-fit", "assumed")
STATE_METHODS = ("ephemeris", "orbit-propagation")
NAMESPACES = ("ss", "mp", "comet", "gdr3", "hip", "nea", "hr23", "ongc", "sh2", "ungc", "bh", "gal",
              "test")
POSITION_MODELS = ("fixed", "state", "orbit")
DIST_UNITS = ("pc", "Mpc")

# Accepted dates: 1900-01-01 .. 2100-01-01 (the built-in ephemeris is only meant for that span)
MJD_MIN, MJD_MAX = 15020.0, 88069.0

_ID_RE = re.compile(r"^([a-z][a-z0-9]*):(\S.*)$")
# strength of an evidence level, and the strongest evidence each tier allows
_EVIDENCE_RANK = {"illustrative": 0, "derived": 1, "measured": 2}
_TIER_CAP = {"measured": "measured", "catalogue": "measured", "inferred": "derived",
             "illustrative": "illustrative"}
_ANGLE_TO_DEG = {"deg": 1.0, "arcmin": 1.0 / 60.0, "arcsec": 1.0 / 3600.0}
# A SkyBoT cone is answered by the service; this slack keeps objects it returned at the rim
_CONE_SLACK_DEG = 1e-3


def _now_mjd() -> float:
    """Now (TDB), rounded to the hour so repeat requests reuse the cached SkyBoT cone."""
    return round(float(Time.now().tdb.mjd) * 24.0) / 24.0


def angsep_deg(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    """Great-circle separation in degrees (haversine; fine at any separation and near the poles)."""
    r1, d1, r2, d2 = math.radians(ra1), math.radians(dec1), math.radians(ra2), math.radians(dec2)
    h = math.sin((d2 - d1) / 2) ** 2 + math.cos(d1) * math.cos(d2) * math.sin((r2 - r1) / 2) ** 2
    return math.degrees(2 * math.asin(min(1.0, math.sqrt(h))))


# --- building records ------------------------------------------------------------------------

def quantity(v: float | str, src: str, tier: str, unit: str | None = None,
             lo: float | None = None, hi: float | None = None) -> dict:
    """A Quantity: a value with its source string and tier (and optional unit and interval).
    Unset optional keys are left out, so records stay compact."""
    q: dict[str, Any] = {"v": v}
    if lo is not None:
        q["lo"] = lo
    if hi is not None:
        q["hi"] = hi
    if unit is not None:
        q["unit"] = unit
    q["src"] = src
    q["tier"] = tier
    return q


def record(*, id: str, kind: str, name: str, position: dict, provenance: dict, evidence: str,
           designations: list[str] | None = None, host: str | None = None,
           parent: str | None = None, size: dict | None = None, props: dict | None = None,
           render: dict | None = None) -> dict:
    """A schema record with every required field present. Not validated: see `validate_record`."""
    return {
        "id": id, "kind": kind, "name": name, "designations": list(designations or []),
        "host": host, "parent": parent, "position": position, "size": size,
        "props": dict(props or {}), "provenance": provenance, "evidence": evidence,
        "render": dict(render or {}),
    }


# --- validation ------------------------------------------------------------------------------

def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _check_quantity(q: Any, where: str, out: list[str], units: tuple[str, ...] = UNITS) -> None:
    if not isinstance(q, dict):
        out.append(f"{where}: must be a Quantity object")
        return
    v = q.get("v")
    if not (_is_num(v) or isinstance(v, str)):
        out.append(f"{where}.v: must be a finite number or a string")
    for k in ("lo", "hi"):
        if k in q and q[k] is not None and not _is_num(q[k]):
            out.append(f"{where}.{k}: must be a finite number")
    if q.get("tier") not in TIERS:
        out.append(f"{where}.tier: must be one of {', '.join(TIERS)}")
    if not isinstance(q.get("src"), str) or not q.get("src"):
        out.append(f"{where}.src: required, non-empty string")
    unit = q.get("unit")
    if unit is not None and unit not in units:
        out.append(f"{where}.unit: unknown unit {unit!r}")


def _check_id(v: Any, where: str, out: list[str]) -> None:
    m = _ID_RE.match(v) if isinstance(v, str) else None
    if not m:
        out.append(f"{where}: must look like '<namespace>:<local>'")
    elif m.group(1) not in NAMESPACES:
        out.append(f"{where}: unknown namespace {m.group(1)!r}")


def _check_position(pos: Any, host: Any, out: list[str]) -> str | None:
    """Validate `position`; returns its governing tier (None when it cannot be told)."""
    if not isinstance(pos, dict):
        out.append("position: must be an object")
        return None
    model = pos.get("model")
    if model not in POSITION_MODELS:
        out.append(f"position.model: must be one of {', '.join(POSITION_MODELS)}")
        return None
    if model in ("state", "orbit"):
        if not (isinstance(host, str) and host):
            out.append(f"position.model {model!r} requires a host")
        if pos.get("tier") not in TIERS:
            out.append(f"position.tier: must be one of {', '.join(TIERS)}")
        if not isinstance(pos.get("src"), str) or not pos.get("src"):
            out.append("position.src: required, non-empty string")
    if model == "fixed":
        ra, dec = pos.get("ra"), pos.get("dec")
        if not (_is_num(ra) and 0 <= ra < 360):
            out.append("position.ra: must be a number in [0, 360)")
        if not (_is_num(dec) and -90 <= dec <= 90):
            out.append("position.dec: must be a number in [-90, 90]")
        if pos.get("epoch") is not None and not _is_num(pos["epoch"]):
            out.append("position.epoch: must be a number")
        dist = pos.get("dist")
        method = pos.get("method")
        if method is not None and method not in METHODS:
            out.append(f"position.method: must be one of {', '.join(METHODS)}")
        if dist is None:
            if pos.get("tier") not in TIERS:
                out.append("position.tier: required when position.dist is null")
                return None
            return pos["tier"]
        _check_quantity(dist, "position.dist", out, DIST_UNITS)
        if isinstance(dist, dict) and not _is_num(dist.get("v")):
            out.append("position.dist.v: must be a finite number")
        if method is None:
            out.append("position.method: required when position.dist is given")
        return dist.get("tier") if isinstance(dist, dict) and dist.get("tier") in TIERS else None
    if model == "state":
        if not _is_num(pos.get("mjd")):
            out.append("position.mjd: must be a number")
        xyz = pos.get("xyz_au")
        if not (isinstance(xyz, list) and len(xyz) == 3 and all(_is_num(c) for c in xyz)):
            out.append("position.xyz_au: must be a list of three numbers")
        geo = pos.get("geo")
        if geo is not None:
            if not (isinstance(geo, dict) and all(_is_num(geo.get(k)) for k in ("ra", "dec", "dist_au"))):
                out.append("position.geo: must have numeric ra, dec and dist_au")
        if pos.get("method") not in STATE_METHODS:
            out.append(f"position.method: must be one of {', '.join(STATE_METHODS)}")
        return pos.get("tier") if pos.get("tier") in TIERS else None
    # orbit
    el = pos.get("elements")
    if not isinstance(el, dict):
        out.append("position.elements: must be an object")
    else:
        for k in ("a_au", "e", "period_d"):
            _check_quantity(el.get(k), f"position.elements.{k}", out)
        for k in ("i_deg", "t_peri_mjd", "omega_deg", "node_deg"):
            if el.get(k) is not None:
                _check_quantity(el[k], f"position.elements.{k}", out)
    if not isinstance(pos.get("phase_known"), bool):
        out.append("position.phase_known: must be a boolean")
    elif not pos["phase_known"] and pos.get("tier") != "illustrative":
        out.append("position.tier: an orbit with an unknown phase must be 'illustrative'")
    return pos.get("tier") if pos.get("tier") in TIERS else None


def validate_record(rec: Any) -> list[str]:
    """Problems with one record (empty list = valid). Never raises. Unknown extra fields are allowed
    and `in_cone` is optional, since it is set by the endpoint."""
    try:
        return _validate(rec)
    except Exception as e:  # noqa: BLE001  (a validator must report, not crash)
        return [f"validation failed unexpectedly: {type(e).__name__}: {e}"]


def _validate(rec: Any) -> list[str]:
    if not isinstance(rec, dict):
        return ["record: must be an object"]
    out: list[str] = []
    _check_id(rec.get("id"), "id", out)
    if rec.get("kind") not in KINDS:
        out.append(f"kind: must be one of {', '.join(KINDS)}")
    if not isinstance(rec.get("name"), str) or not rec.get("name"):
        out.append("name: required, non-empty string")
    des = rec.get("designations")
    if not (isinstance(des, list) and all(isinstance(d, str) for d in des)):
        out.append("designations: must be a list of strings")
    for k in ("host", "parent"):
        if k not in rec:
            out.append(f"{k}: required (use null for none)")
        elif rec[k] is not None:
            _check_id(rec[k], k, out)
    if "in_cone" in rec and not isinstance(rec["in_cone"], bool):
        out.append("in_cone: must be a boolean")

    gov = _check_position(rec.get("position"), rec.get("host"), out)

    size = rec.get("size")
    if size is not None:
        if not isinstance(size, dict):
            out.append("size: must be an object or null")
        else:
            if size.get("radius") is not None:
                _check_quantity(size["radius"], "size.radius", out)
            ang = size.get("angular")
            if ang is not None:
                if not isinstance(ang, dict):
                    out.append("size.angular: must be an object or null")
                else:
                    _check_quantity(ang.get("major"), "size.angular.major", out)
                    for k in ("minor", "pa"):
                        if ang.get(k) is not None:
                            _check_quantity(ang[k], f"size.angular.{k}", out)
    if "size" not in rec:
        out.append("size: required (use null for none)")

    props = rec.get("props")
    if not isinstance(props, dict):
        out.append("props: must be an object")
    else:
        for k, q in props.items():
            _check_quantity(q, f"props.{k}", out)

    prov = rec.get("provenance")
    if not isinstance(prov, dict):
        out.append("provenance: must be an object")
    else:
        for k in ("source", "catalogue"):
            if not isinstance(prov.get(k), str) or not prov.get(k):
                out.append(f"provenance.{k}: required, non-empty string")

    render = rec.get("render")
    if not isinstance(render, dict):
        out.append("render: must be an object")
    elif render.get("mag") is not None and not _is_num(render["mag"]):
        out.append("render.mag: must be a finite number")

    ev = rec.get("evidence")
    if ev not in EVIDENCE:
        out.append(f"evidence: must be one of {', '.join(EVIDENCE)}")
    else:
        pos = rec.get("position")
        if isinstance(pos, dict) and pos.get("model") == "orbit" and pos.get("phase_known") is False:
            if ev != "illustrative":
                out.append("evidence: an orbit with an unknown phase must be 'illustrative'")
        elif gov is not None:
            allowed = _TIER_CAP[gov]
            if _EVIDENCE_RANK[ev] > _EVIDENCE_RANK[allowed]:
                out.append(f"evidence: {ev!r} is stronger than a {gov!r} position allows "
                           f"(at most {allowed!r})")
    return out


# --- cone test -------------------------------------------------------------------------------

def sky_position(rec: dict) -> tuple[float, float] | None:
    """The (ra, dec) a record is seen at from the geocentre, or None (orbit positions, and state
    positions without a `geo`, such as Earth itself)."""
    pos = rec.get("position") or {}
    if pos.get("model") == "fixed":
        return float(pos["ra"]), float(pos["dec"])
    if pos.get("model") == "state" and isinstance(pos.get("geo"), dict):
        return float(pos["geo"]["ra"]), float(pos["geo"]["dec"])
    return None


def angular_radius_deg(rec: dict) -> float:
    """Half the angular major axis in degrees, or 0.0 when the record has no angular size."""
    maj = (((rec.get("size") or {}).get("angular") or {}).get("major") or {})
    v, unit = maj.get("v"), maj.get("unit", "deg")
    if not _is_num(v) or unit not in _ANGLE_TO_DEG:
        return 0.0
    return max(0.0, float(v)) * _ANGLE_TO_DEG[unit] / 2.0


def cone_contains(rec: dict, ra: float, dec: float, radius: float) -> bool:
    """True when the record's disc (its angular radius, if any) overlaps the cone (ra, dec, radius)
    seen from the geocentre. Records with no sky position are never inside."""
    sp = sky_position(rec)
    if sp is None:
        return False
    return angsep_deg(ra, dec, sp[0], sp[1]) <= radius + angular_radius_deg(rec)


# --- sources and registry --------------------------------------------------------------------

@dataclass(frozen=True)
class Query:
    """One /api/objects request, as sources see it."""
    ra: float
    dec: float
    radius: float
    mjd: float
    kinds: tuple[str, ...]
    limit: int


@dataclass(frozen=True)
class Source:
    """A provider of records.

    `fetch` raises on failure and returns schema records (they are validated by the merge).
    A lower `precedence` wins when two sources return the same id. `cone` sources answer a cone, and
    the merge drops their records that fall outside it; the others (the Sun and planets) are returned
    whole. A source with no `kinds` serves nothing and always runs, so that a broken dataset reports
    its error in `sources`."""
    id: str
    kinds: tuple[str, ...]
    precedence: int
    fetch: Callable[[Query], Awaitable[list[dict]]]
    provenance: dict
    cone: bool = True


_SOURCES: list[Source] | None = None


def _default_sources() -> list[Source]:
    # imported here: these modules import this one
    from . import objects_live, objects_static
    return [*objects_live.sources(), *objects_static.discover_sources(config.OBJECTS_DIR)]


def sources() -> list[Source]:
    """The registered sources, building the default set (live sources plus the static datasets found
    under config.OBJECTS_DIR) on first use."""
    global _SOURCES
    if _SOURCES is None:
        _SOURCES = _default_sources()
    return list(_SOURCES)


def register(source: Source) -> None:
    """Add a source to the registry (after the default set)."""
    sources()
    assert _SOURCES is not None
    _SOURCES.append(source)


def set_sources(new: list[Source]) -> None:
    """Replace the registry outright (tests)."""
    global _SOURCES
    _SOURCES = list(new)


def reset_sources() -> None:
    """Forget the registry; the next request rebuilds the default set from config.OBJECTS_DIR."""
    global _SOURCES
    _SOURCES = None


def served_kinds() -> tuple[str, ...]:
    """Every kind with a registered source, in KINDS order."""
    have = {k for s in sources() for k in s.kinds}
    return tuple(k for k in KINDS if k in have)


# --- the merge -------------------------------------------------------------------------------

def _err_text(e: BaseException) -> str:
    return str(e) or type(e).__name__


def _mag_key(rec: dict) -> tuple[int, float]:
    m = (rec.get("render") or {}).get("mag")
    return (1, 0.0) if not _is_num(m) else (0, float(m))


async def _run_source(src: Source, q: Query, timeout: float) -> dict:
    """Run one source under a deadline. The fetch runs as its own task behind `asyncio.shield`, so a
    deadline only abandons the wait: the task finishes in the background (and fills its caches)."""
    t0 = time.monotonic()
    task = asyncio.ensure_future(src.fetch(q))
    # retrieve a late exception so it is not reported as "never retrieved"
    task.add_done_callback(lambda t: t.cancelled() or t.exception())
    try:
        recs = await asyncio.wait_for(asyncio.shield(task), timeout)
        err = None
    except asyncio.TimeoutError:
        recs, err = [], f"timed out after {timeout:g} s"
    except Exception as e:  # noqa: BLE001  (a source must never fail the request)
        log.warning("objects: source %s failed: %s: %s", src.id, type(e).__name__, e)
        recs, err = [], _err_text(e)
    return {"src": src, "recs": recs, "error": err, "ms": round((time.monotonic() - t0) * 1000)}


async def build_objects(ra: float, dec: float, radius: float, mjd: float | None = None,
                        kinds: list[str] | tuple[str, ...] | None = None, limit: int = 2000) -> dict:
    """The /api/objects payload (docs/object-framework.md section 4.1).

    Every source that serves a requested kind runs concurrently. Records are validated (invalid ones
    are dropped and counted), de-duplicated by source precedence, cone-filtered for cone sources, cut
    to `limit` per kind by apparent magnitude, and given `in_cone`. Output order is kind, then
    `render.mag` (unknown last), then id. Per-kind status is `ok`, `error` (the source failed) or
    `unavailable` (no registered source serves the kind). Raises ValueError for an unknown kind."""
    mjd = _now_mjd() if mjd is None else float(mjd)
    if kinds is None:
        want = served_kinds()
    else:
        bad = [k for k in kinds if k not in KINDS]
        if bad:
            raise ValueError(f"unknown kind(s): {', '.join(bad)}")
        want = tuple(k for k in KINDS if k in set(kinds))
    q = Query(ra, dec, radius, mjd, want, limit)
    timeout = config.OBJECTS_SOURCE_TIMEOUT_S

    # sources that serve a requested kind (and kind-less diagnostic sources), by precedence
    regs = sorted(sources(), key=lambda s: (s.precedence, s.id))
    active = [s for s in regs if not s.kinds or set(s.kinds) & set(want)]
    results = await asyncio.gather(*(_run_source(s, q, timeout) for s in active))

    # validate, filter, de-duplicate (results are in precedence order, so the first id wins)
    seen: dict[str, tuple[dict, str]] = {}
    stats: dict[str, dict] = {}
    for res in results:
        src: Source = res["src"]
        dropped = 0
        for rec in res["recs"]:
            problems = validate_record(rec)
            if problems:
                dropped += 1
                log.warning("objects: %s dropped %r: %s", src.id,
                            rec.get("id") if isinstance(rec, dict) else None, "; ".join(problems))
                continue
            if rec["kind"] not in want:
                continue
            if src.cone and not cone_contains(rec, ra, dec, radius + _CONE_SLACK_DEG):
                continue
            seen.setdefault(rec["id"], (rec, src.id))
        stats[src.id] = {"dropped": dropped}

    by_kind: dict[str, list[tuple[dict, str]]] = {k: [] for k in want}
    for rec, sid in seen.values():
        by_kind[rec["kind"]].append((rec, sid))
    objects: list[dict] = []
    kept_by_source: dict[str, int] = {s.id: 0 for s in active}
    kind_info: dict[str, dict] = {}
    for k in want:
        items = sorted(by_kind[k], key=lambda it: (_mag_key(it[0]), it[0]["id"]))
        truncated = len(items) > limit
        items = items[:limit]
        for rec, sid in items:
            kept_by_source[sid] += 1
            out = dict(rec)
            out["in_cone"] = cone_contains(rec, ra, dec, radius)
            objects.append(out)
        serving = [r for r in results if k in r["src"].kinds]
        info: dict[str, Any] = {"status": "unavailable", "source": None, "count": len(items),
                                "truncated": truncated}
        if serving:
            ok = [r for r in serving if r["error"] is None]
            failed = [r for r in serving if r["error"] is not None]
            if ok:
                info["status"], info["source"] = "ok", ok[0]["src"].id
                if failed:  # another source of this kind failed: say so, the kind still has data
                    info["error"] = "; ".join(f"{r['src'].id}: {r['error']}" for r in failed)
            else:
                info["status"], info["source"] = "error", failed[0]["src"].id
                info["error"] = failed[0]["error"]
        kind_info[k] = info

    source_rows = []
    for res in results:
        s: Source = res["src"]
        row: dict[str, Any] = {"id": s.id, "status": "ok" if res["error"] is None else "error",
                               "ms": res["ms"], "count": kept_by_source[s.id],
                               "dropped": stats[s.id]["dropped"]}
        if res["error"] is None:
            row["provenance"] = s.provenance
        else:
            row["error"] = res["error"]
        source_rows.append(row)

    return {
        "schema": SCHEMA,
        "query": {"ra": ra, "dec": dec, "radius": radius, "mjd": mjd, "kinds": list(want)},
        "objects": objects,
        "kinds": kind_info,
        "sources": source_rows,
    }
