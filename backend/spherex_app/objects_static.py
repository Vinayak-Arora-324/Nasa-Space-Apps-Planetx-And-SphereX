"""Static object datasets: RA/Dec band tiling, the manifest and tile files, and cone queries.

A dataset is a directory (frontend/data/objects/<dataset>/ in the repo) built offline by a script:

    <dataset>/manifest.json            format, schema, dataset, kinds, precedence, tiling, max_extent_deg,
                                       count, provenance, build, tiles {name: {count, sha256}}
    <dataset>/tiles/<band>-<bin>.json  {"format", "tile", "objects": [records]}
    <dataset>/tiles/sky.json           optional sky tile, same format (see below)

Tiling `radec-bands` (docs/object-framework.md section 6): declination bands of `band_deg`, numbered from
-90 degrees; band b has max(1, round(360 cos(dec_mid) / band_deg)) RA bins starting at RA 0. A record
lies in the tile that holds its (ra, dec), direction-only records included. A cone query reads every tile
whose box comes within radius + max_extent_deg of the cone centre, then filters the records exactly with
`objects.cone_contains` (which adds each record's own angular radius).

Sky tiles (docs/object-framework.md 18.9 item 6): `write_dataset(..., sky_ids=[...])` writes those records
to `tiles/sky.json` and lists `"sky_tiles": ["sky"]` in the manifest (the key is absent when there are none,
so a dataset without sky records is byte-identical to one written before). A sky record is in no cone tile
and does not count toward `max_extent_deg`; `verify_dataset` checks the tile hash and that no id is in two
tiles. `cone_query` returns the cone's records plus every sky-tile record. Mechanism: `_read_tile` returns
the sky tile's records as `objects.SkyRecord` (a dict subclass), and `objects.build_objects` skips the cone
filter for a `SkyRecord` while still computing `in_cone` from the real cone, so a sky record outside the
cone arrives with `in_cone: false`. The per-kind `limit` still applies to them.

Writing is reproducible: sorted keys, records ordered by id, compact separators, no timestamps, and a
sha256 per tile in the manifest. The same input gives byte-identical output.

Tile records are `fixed` positions with `host: null`, or (Phase 1) records of a hosted kind
(`objects.HOSTED_KINDS`: exoplanets, and from Phase 2 black holes) with an `orbit` position, a non-null
`host` and `position.host_radec`; a hosted record is tiled by that direction (`objects.sky_position`).
A black hole may also be `fixed` with `host: null` (Sgr A*). Every record
must pass `objects.validate_record`.

String table (`write_dataset(..., src_table=True)`): the manifest gets `src_table`, the sorted distinct
`src` strings of every Quantity and every position, and tile files hold the integer index in place of the
string. `_read_tile` and `verify_dataset` expand the indices before validating or caching, so records in
memory and in /api/objects always carry string `src`. Tile format stays 1: a reader that does not expand
fails validation on an integer `src` instead of misreading it.

Record defaults (`write_dataset(..., record_defaults={...})`): top-level keys that are identical in every
record (the compact `provenance` of a dataset) are stored once in `manifest["record_defaults"]` and left
out of the tile records. `_read_tile` and `verify_dataset` put a missing key back (a copy of the default)
before validating or caching, so served records are unchanged. Opt-in and generic: any top-level key.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import math
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from .objects import (HOSTED_KINDS, KINDS, SCHEMA, TILE_FORMAT, Query, SkyRecord, Source, angsep_deg,
                      angular_radius_deg, cone_contains, sky_position, validate_record)

log = logging.getLogger(__name__)

SCHEME = "radec-bands"
# Hosted kinds that may also be stored as a free-standing `fixed` record with host null (Phase 2).
FREE_HOSTED_KINDS = ("black_hole",)
MANIFEST = "manifest.json"
SKY_TILE = "sky"
_EPS = 1e-9  # degrees; absorbs float error at tile edges


class DatasetError(ValueError):
    """A dataset on disk that cannot be used (missing or invalid manifest, bad tile)."""


# --- tiling maths ----------------------------------------------------------------------------

def _n_bands(band_deg: float) -> int:
    return max(1, math.ceil(180.0 / band_deg - 1e-9))


def _band_edges(band: int, band_deg: float) -> tuple[float, float]:
    lo = -90.0 + band * band_deg
    return lo, min(90.0, lo + band_deg)


def _n_bins(band: int, band_deg: float) -> int:
    lo, hi = _band_edges(band, band_deg)
    return max(1, round(360.0 * math.cos(math.radians((lo + hi) / 2.0)) / band_deg))


def tile_of(ra: float, dec: float, band_deg: float = 10.0) -> str:
    """Name ("<band>-<bin>") of the tile that holds (ra, dec). The last band includes dec = +90."""
    band = min(max(int(math.floor((dec + 90.0) / band_deg)), 0), _n_bands(band_deg) - 1)
    nb = _n_bins(band, band_deg)
    b = min(int((ra % 360.0) / (360.0 / nb)), nb - 1)
    return f"{band}-{b}"


def tile_bounds(tile: str, band_deg: float = 10.0) -> tuple[float, float, float, float]:
    """(ra_lo, ra_hi, dec_lo, dec_hi) of a tile, in degrees."""
    band, b = (int(x) for x in tile.split("-"))
    lo, hi = _band_edges(band, band_deg)
    w = 360.0 / _n_bins(band, band_deg)
    return b * w, (b + 1) * w, lo, hi


def _box_distance(ra0: float, dec0: float, box: tuple[float, float, float, float]) -> float:
    """Least angular distance (deg) from (ra0, dec0) to an RA/Dec box (ra_lo, ra_hi, dec_lo, dec_hi).

    If the point's RA lies inside the box's RA range the nearest box point is straight along the
    meridian. Otherwise it is on one of the two meridian edges, found by projecting the point onto that
    meridian's great circle and clamping to the band; the corners are tried as well. Every candidate is
    a real box point, so the result never underestimates the distance. Valid at the poles."""
    ra_lo, ra_hi, dec_lo, dec_hi = box
    if ra_lo <= ra0 <= ra_hi:
        return max(0.0, dec_lo - dec0, dec0 - dec_hi)
    best = 180.0
    for ra_e in (ra_lo, ra_hi):
        dra = abs(ra0 - ra_e) % 360.0
        dra = math.radians(min(dra, 360.0 - dra))  # across the RA 0/360 wrap
        dec_p = math.degrees(math.atan2(math.sin(math.radians(dec0)),
                                        math.cos(math.radians(dec0)) * math.cos(dra)))
        for d in (dec_lo, dec_hi, min(max(dec_p, dec_lo), dec_hi)):
            best = min(best, angsep_deg(ra0, dec0, ra_e, d))
    return best


def tiles_for_cone(ra: float, dec: float, radius: float, band_deg: float = 10.0,
                   margin_deg: float = 0.0) -> list[str]:
    """Names of every tile that may hold a record within `radius + margin_deg` of (ra, dec).

    Conservative (a tile that only touches the grown cone is included) and correct at the poles and
    across the RA 0/360 wrap. `margin_deg` is the dataset's max_extent_deg."""
    ra0 = ra % 360.0
    reach = radius + margin_deg + _EPS
    out = []
    for band in range(_n_bands(band_deg)):
        lo, hi = _band_edges(band, band_deg)
        if dec + reach < lo or dec - reach > hi:
            continue
        for b in range(_n_bins(band, band_deg)):
            tile = f"{band}-{b}"
            if reach >= 180.0 or _box_distance(ra0, dec, tile_bounds(tile, band_deg)) <= reach:
                out.append(tile)
    return out


# --- datasets --------------------------------------------------------------------------------

@dataclass(frozen=True)
class Dataset:
    """A validated manifest and where it lives."""
    root: Path
    manifest: dict

    @property
    def name(self) -> str:
        return self.manifest["dataset"]

    @property
    def band_deg(self) -> float:
        return float(self.manifest["tiling"]["band_deg"])


_lock = threading.Lock()
_manifests: dict[str, tuple[int, Dataset]] = {}  # manifest path -> (mtime_ns, dataset)
_tiles: dict[str, tuple[int, list[dict]]] = {}   # tile path -> (mtime_ns, records)


def _check_manifest(m: object, where: str) -> dict:
    if not isinstance(m, dict):
        raise DatasetError(f"{where}: manifest must be a JSON object")
    problems = []
    if m.get("format") != TILE_FORMAT:
        problems.append(f"format must be {TILE_FORMAT!r}")
    if m.get("schema") != SCHEMA:
        problems.append(f"schema must be {SCHEMA!r} (this server reads schema 1 only)")
    if not (isinstance(m.get("dataset"), str) and m["dataset"]):
        problems.append("dataset must be a non-empty string")
    kinds = m.get("kinds")
    if not (isinstance(kinds, list) and kinds and all(k in KINDS for k in kinds)):
        problems.append("kinds must be a non-empty list of known kinds")
    if isinstance(m.get("precedence"), bool) or not isinstance(m.get("precedence"), int):
        problems.append("precedence must be an integer")
    tiling = m.get("tiling")
    band = tiling.get("band_deg") if isinstance(tiling, dict) else None
    if not (isinstance(tiling, dict) and tiling.get("scheme") == SCHEME
            and isinstance(band, (int, float)) and not isinstance(band, bool) and 0 < band <= 90):
        problems.append(f"tiling must be {{scheme: {SCHEME!r}, band_deg: 0 < number <= 90}}")
    ext = m.get("max_extent_deg")
    if isinstance(ext, bool) or not isinstance(ext, (int, float)) or not 0 <= ext <= 180:
        problems.append("max_extent_deg must be a number in [0, 180]")
    if isinstance(m.get("count"), bool) or not isinstance(m.get("count"), int):
        problems.append("count must be an integer")
    if not isinstance(m.get("provenance"), dict):
        problems.append("provenance must be an object")
    if not isinstance(m.get("build"), dict):
        problems.append("build must be an object")
    if m.get("record_defaults") is not None and not isinstance(m["record_defaults"], dict):
        problems.append("record_defaults must be an object")
    tab = m.get("src_table")
    if tab is not None and not (isinstance(tab, list) and all(isinstance(x, str) for x in tab)):
        problems.append("src_table must be a list of strings")
    tiles = m.get("tiles")
    sky = m.get("sky_tiles")
    if sky is not None and not (isinstance(sky, list) and sky and all(isinstance(x, str) for x in sky)
                                and isinstance(tiles, dict) and all(x in tiles for x in sky)):
        problems.append("sky_tiles must be a non-empty list of tile names listed in tiles")
    if not (isinstance(tiles, dict) and all(
            isinstance(v, dict) and isinstance(v.get("count"), int) and isinstance(v.get("sha256"), str)
            for v in tiles.values())):
        problems.append("tiles must map tile names to {count, sha256}")
    if problems:
        raise DatasetError(f"{where}: invalid manifest: " + "; ".join(problems))
    return m


def load_dataset(path: str | Path) -> Dataset:
    """Read and validate `<path>/manifest.json` (cached until its mtime changes).
    Raises DatasetError, with a message naming the file, when it is missing or invalid."""
    root = Path(path)
    mp = root / MANIFEST
    try:
        mtime = mp.stat().st_mtime_ns
    except OSError as e:
        raise DatasetError(f"{mp}: cannot read manifest ({e.strerror or e})") from e
    with _lock:
        hit = _manifests.get(str(mp))
    if hit is not None and hit[0] == mtime:
        return hit[1]
    try:
        raw = json.loads(mp.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise DatasetError(f"{mp}: manifest is not valid JSON ({e})") from e
    ds = Dataset(root, _check_manifest(raw, str(mp)))
    with _lock:
        _manifests[str(mp)] = (mtime, ds)
    return ds


# --- the string table ------------------------------------------------------------------------

def _src_holders(rec: dict):
    """Every dict of a record that carries a `src` string: the position, its distance and orbital
    elements, the size quantities, and the props."""
    pos = rec.get("position")
    if isinstance(pos, dict):
        yield pos
        if isinstance(pos.get("dist"), dict):
            yield pos["dist"]
        if isinstance(pos.get("elements"), dict):
            yield from (q for q in pos["elements"].values() if isinstance(q, dict))
    size = rec.get("size")
    if isinstance(size, dict):
        if isinstance(size.get("radius"), dict):
            yield size["radius"]
        if isinstance(size.get("angular"), dict):
            yield from (q for q in size["angular"].values() if isinstance(q, dict))
    if isinstance(rec.get("props"), dict):
        yield from (q for q in rec["props"].values() if isinstance(q, dict))


def _is_index(v: object) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _compress_src(rec: dict, index: dict[str, int]) -> dict:
    """A copy of `rec` with every `src` string replaced by its index in the string table."""
    out = copy.deepcopy(rec)
    for h in _src_holders(out):
        if isinstance(h.get("src"), str):
            h["src"] = index[h["src"]]
    return out


def _expand_src(rec: dict, table: list[str]) -> dict:
    """Replace integer `src` values of `rec` (in place) by their strings. An index outside the
    table raises DatasetError."""
    for h in _src_holders(rec):
        v = h.get("src")
        if _is_index(v):
            if not 0 <= v < len(table):
                raise DatasetError(f"{rec.get('id')}: src index {v} is outside the string table "
                                   f"({len(table)} entries)")
            h["src"] = table[v]
    return rec


def _fill_defaults(rec: dict, defaults: dict) -> dict:
    """Put the manifest's `record_defaults` back into a tile record (in place) where a key is missing."""
    if not isinstance(rec, dict):
        raise DatasetError("a tile record is not an object")
    for k, v in defaults.items():
        if k not in rec:
            rec[k] = copy.deepcopy(v)
    return rec


def _expand(rec: dict, manifest: dict) -> dict:
    """A tile record as stored -> the record as served (defaults and string table restored)."""
    return _expand_src(_fill_defaults(rec, manifest.get("record_defaults") or {}),
                       manifest.get("src_table") or [])


def _read_tile(ds: Dataset, tile: str) -> list[dict]:
    """Records of one tile, through the in-memory cache keyed by path and mtime."""
    tp = ds.root / "tiles" / f"{tile}.json"
    try:
        mtime = tp.stat().st_mtime_ns
    except OSError as e:
        raise DatasetError(f"{tp}: tile listed in the manifest cannot be read ({e.strerror or e})") from e
    with _lock:
        hit = _tiles.get(str(tp))
    if hit is not None and hit[0] == mtime:
        return hit[1]
    try:
        doc = json.loads(tp.read_text(encoding="utf-8"))
        recs = doc["objects"]
        if doc.get("format") != TILE_FORMAT or not isinstance(recs, list):
            raise ValueError("not a tile file")
        recs = [_expand(r, ds.manifest) for r in recs]
        if tile in (ds.manifest.get("sky_tiles") or ()):
            recs = [SkyRecord(r) for r in recs]
    except (OSError, ValueError, KeyError, TypeError) as e:  # DatasetError is a ValueError
        if isinstance(e, DatasetError):
            raise DatasetError(f"{tp}: {e}") from e
        raise DatasetError(f"{tp}: invalid tile ({e})") from e
    with _lock:
        _tiles[str(tp)] = (mtime, recs)
    return recs


def cone_query(ds: Dataset, ra: float, dec: float, radius: float) -> list[dict]:
    """Records of the dataset whose disc overlaps the cone, ordered by tile then file order, followed by
    every record of the sky tiles (`objects.SkyRecord`, returned whatever the cone)."""
    m = ds.manifest
    out = []
    for tile in tiles_for_cone(ra, dec, radius, ds.band_deg, float(m["max_extent_deg"])):
        if tile not in m["tiles"]:
            continue
        out.extend(r for r in _read_tile(ds, tile) if cone_contains(r, ra, dec, radius))
    for tile in m.get("sky_tiles") or ():
        out.extend(_read_tile(ds, tile))
    return out


# --- writing ---------------------------------------------------------------------------------

def _dumps(obj: object) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"


def write_dataset(records: list[dict], out_dir: str | Path, *, dataset: str, kinds: list[str],
                  provenance: dict, build: dict, band_deg: float = 10, precedence: int = 50,
                  src_table: bool = False, record_defaults: dict | None = None,
                  sky_ids: Iterable[str] | None = None) -> dict:
    """Write `records` as a tiled dataset under `out_dir` and return the manifest.

    Every record is validated and must be either a `fixed` position with `host: None`, or a record of
    a hosted kind (`objects.HOSTED_KINDS`) with an `orbit` position, a host and `host_radec`
    (a black hole may be the former too). Its kind
    must be listed in `kinds`, its id unique and `in_cone` not stored; otherwise ValueError lists the
    problems and nothing is written. With `record_defaults`, each top-level key whose value equals the
    default is left out of the tile records and stored once in the manifest. Records whose id is in `sky_ids`
    go to the sky tile `tiles/sky.json` instead of a cone tile (see the module docstring); an id in
    `sky_ids` that is not among the records is an error. With `src_table=True` the distinct `src` strings go to
    `manifest["src_table"]` and tiles hold their indices. Output is deterministic (sorted keys,
    records ordered by id, no timestamps)."""
    problems = []
    sky = set(sky_ids or ())
    unknown = sky - {r.get("id") for r in records if isinstance(r, dict)}
    if unknown:
        problems.append(f"sky_ids not among the records: {sorted(unknown)}")
    seen: set[str] = set()
    for r in records:
        rid = r.get("id") if isinstance(r, dict) else None
        probs = validate_record(r)
        if not probs:
            pos = r["position"]
            # a hosted kind is an `orbit` with a host and host_radec; a black hole may also be a free-standing
            # `fixed` record with host null (Sgr A*, GRS 1915+105: docs/object-framework.md 17.7)
            if r["kind"] in HOSTED_KINDS and not (r["kind"] in FREE_HOSTED_KINDS and pos["model"] == "fixed"):
                if pos["model"] != "orbit":
                    probs.append(f"{r['kind']} tile records must have an 'orbit' position")
                elif r["host"] is None:
                    probs.append(f"{r['kind']} tile records must have a host")
                elif sky_position(r) is None:
                    probs.append(f"{r['kind']} tile records must have position.host_radec")
            else:
                if pos["model"] != "fixed":
                    probs.append("tile records must have a 'fixed' position")
                if r["host"] is not None:
                    probs.append("tile records must have host null")
            if r["kind"] not in kinds:
                probs.append(f"kind {r['kind']!r} is not in the dataset kinds {kinds}")
            if "in_cone" in r:
                probs.append("in_cone is set by the endpoint and must not be stored")
            if rid in seen:
                probs.append("duplicate id")
            seen.add(rid)
        problems.extend(f"{rid}: {p}" for p in probs)
    if problems:
        raise ValueError("invalid records:\n  " + "\n  ".join(problems))

    table: list[str] = []
    index: dict[str, int] = {}
    if src_table:
        table = sorted({h["src"] for r in records for h in _src_holders(r)
                        if isinstance(h.get("src"), str)})
        index = {t: i for i, t in enumerate(table)}
    by_tile: dict[str, list[dict]] = {}
    for r in sorted(records, key=lambda r: r["id"]):
        ra, dec = sky_position(r)  # type: ignore[misc]  (validated above)
        name = SKY_TILE if r["id"] in sky else tile_of(ra, dec, band_deg)
        out_rec = _compress_src(r, index) if src_table else r
        if record_defaults:
            out_rec = {k: v for k, v in out_rec.items() if not (k in record_defaults and v == record_defaults[k])}
        by_tile.setdefault(name, []).append(out_rec)

    out = Path(out_dir)
    tdir = out / "tiles"
    tdir.mkdir(parents=True, exist_ok=True)
    for old in tdir.glob("*.json"):
        old.unlink()
    tiles = {}
    for name in sorted(by_tile):
        data = _dumps({"format": TILE_FORMAT, "objects": by_tile[name], "tile": name}).encode("utf-8")
        (tdir / f"{name}.json").write_bytes(data)
        tiles[name] = {"count": len(by_tile[name]), "sha256": hashlib.sha256(data).hexdigest()}
    manifest = {
        "format": TILE_FORMAT, "schema": SCHEMA, "dataset": dataset, "kinds": list(kinds),
        "precedence": precedence, "tiling": {"scheme": SCHEME, "band_deg": band_deg},
        "max_extent_deg": max((angular_radius_deg(r) for r in records if r["id"] not in sky), default=0.0),
        "count": len(records), "provenance": provenance, "build": build, "tiles": tiles,
    }
    if sky:
        manifest["sky_tiles"] = [SKY_TILE]
    if src_table:
        manifest["src_table"] = table
    if record_defaults:
        manifest["record_defaults"] = record_defaults
    (out / MANIFEST).write_bytes(_dumps(manifest).encode("utf-8"))
    return manifest


def verify_dataset(path: str | Path) -> list[str]:
    """Problems with a dataset on disk (empty = fine): manifest, tile hashes and counts, and that
    every record is valid and sits in the tile its position says. For tests and build scripts; the
    runtime loader trusts the repo."""
    try:
        ds = load_dataset(path)
    except DatasetError as e:
        return [str(e)]
    out = []
    total = 0
    sky_tiles = set(ds.manifest.get("sky_tiles") or ())
    owner: dict[str, str] = {}
    for name, info in sorted(ds.manifest["tiles"].items()):
        tp = ds.root / "tiles" / f"{name}.json"
        try:
            data = tp.read_bytes()
        except OSError as e:
            out.append(f"{name}: cannot read tile ({e.strerror or e})")
            continue
        if hashlib.sha256(data).hexdigest() != info["sha256"]:
            out.append(f"{name}: sha256 does not match the manifest")
        try:
            recs = [_expand(r, ds.manifest) for r in json.loads(data)["objects"]]
        except DatasetError as e:
            out.append(f"{name}: {e}")
            continue
        except (ValueError, KeyError, TypeError, AttributeError):
            out.append(f"{name}: not a tile file")
            continue
        total += len(recs)
        if len(recs) != info["count"]:
            out.append(f"{name}: {len(recs)} records, manifest says {info['count']}")
        for r in recs:
            out += [f"{name}: {r.get('id')}: {p}" for p in validate_record(r)]
            rid = r.get("id")
            if rid in owner:
                out.append(f"{name}: {rid}: id is also in tile {owner[rid]}")
            owner.setdefault(rid, name)
            sp = sky_position(r)
            if name not in sky_tiles and sp is not None and tile_of(sp[0], sp[1], ds.band_deg) != name:
                out.append(f"{name}: {r.get('id')}: record is in the wrong tile")
    if total != ds.manifest["count"]:
        out.append(f"manifest count {ds.manifest['count']} but tiles hold {total}")
    return out


# --- registering datasets as sources ---------------------------------------------------------

def _raw_kinds(manifest_path: Path) -> tuple[str, ...]:
    """Kinds named by a manifest that may be broken, so a broken dataset's kinds report `error`
    instead of `unavailable`. Empty when they cannot be told."""
    try:
        ks = json.loads(manifest_path.read_text(encoding="utf-8")).get("kinds")
        return tuple(k for k in KINDS if isinstance(ks, list) and k in ks)
    except (OSError, ValueError, AttributeError):
        return ()


def _static_source(root: Path) -> Source:
    sid = f"static:{root.name}"
    try:
        ds = load_dataset(root)
    except DatasetError as e:
        log.warning("objects: dataset %s is unusable: %s", root, e)
        err = e

        async def broken(q: Query) -> list[dict]:
            raise err

        return Source(sid, _raw_kinds(root / MANIFEST), 1000, broken,
                      {"source": sid, "dataset": root.name, "error": str(e)})

    async def fetch(q: Query) -> list[dict]:
        # reload per call: a changed manifest (mtime) is picked up without a restart
        return await asyncio.to_thread(lambda: cone_query(load_dataset(root), q.ra, q.dec, q.radius))

    prov = dict(ds.manifest["provenance"], source=sid, dataset=ds.name, build=ds.manifest["build"],
                count=ds.manifest["count"])
    return Source(f"static:{ds.name}", tuple(ds.manifest["kinds"]), ds.manifest["precedence"],
                  fetch, prov)


def discover_sources(objects_dir: str | Path) -> list[Source]:
    """One `static:<dataset>` Source per subdirectory of `objects_dir` that has a manifest. A broken
    dataset registers a source whose fetch raises its error, so it shows up as an error in `sources`
    instead of silently missing. A missing directory means no datasets."""
    base = Path(objects_dir)
    try:
        dirs = sorted(p for p in base.iterdir() if p.is_dir() and (p / MANIFEST).exists())
    except OSError:
        return []
    return [_static_source(p) for p in dirs]


__all__ = ["Dataset", "DatasetError", "cone_query", "discover_sources", "load_dataset", "tile_bounds",
           "tile_of", "tiles_for_cone", "verify_dataset", "write_dataset"]
