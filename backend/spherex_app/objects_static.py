"""Static object datasets: RA/Dec band tiling, the manifest and tile files, and cone queries.

A dataset is a directory (frontend/data/objects/<dataset>/ in the repo) built offline by a script:

    <dataset>/manifest.json            format, schema, dataset, kinds, precedence, tiling, max_extent_deg,
                                       count, provenance, build, tiles {name: {count, sha256}}
    <dataset>/tiles/<band>-<bin>.json  {"format", "tile", "objects": [records]}

Tiling `radec-bands` (docs/object-framework.md section 6): declination bands of `band_deg`, numbered from
-90 degrees; band b has max(1, round(360 cos(dec_mid) / band_deg)) RA bins starting at RA 0. A record
lies in the tile that holds its (ra, dec), direction-only records included. A cone query reads every tile
whose box comes within radius + max_extent_deg of the cone centre, then filters the records exactly with
`objects.cone_contains` (which adds each record's own angular radius).

Writing is reproducible: sorted keys, records ordered by id, compact separators, no timestamps, and a
sha256 per tile in the manifest. The same input gives byte-identical output.

Tile records are `fixed` positions with `host: null` and must pass `objects.validate_record`.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import threading
from dataclasses import dataclass
from pathlib import Path

from .objects import (KINDS, SCHEMA, TILE_FORMAT, Query, Source, angsep_deg, angular_radius_deg,
                      cone_contains, validate_record)

log = logging.getLogger(__name__)

SCHEME = "radec-bands"
MANIFEST = "manifest.json"
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
    tiles = m.get("tiles")
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
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise DatasetError(f"{tp}: invalid tile ({e})") from e
    with _lock:
        _tiles[str(tp)] = (mtime, recs)
    return recs


def cone_query(ds: Dataset, ra: float, dec: float, radius: float) -> list[dict]:
    """Records of the dataset whose disc overlaps the cone, ordered by tile then file order."""
    m = ds.manifest
    out = []
    for tile in tiles_for_cone(ra, dec, radius, ds.band_deg, float(m["max_extent_deg"])):
        if tile not in m["tiles"]:
            continue
        out.extend(r for r in _read_tile(ds, tile) if cone_contains(r, ra, dec, radius))
    return out


# --- writing ---------------------------------------------------------------------------------

def _dumps(obj: object) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"


def write_dataset(records: list[dict], out_dir: str | Path, *, dataset: str, kinds: list[str],
                  provenance: dict, build: dict, band_deg: float = 10, precedence: int = 50) -> dict:
    """Write `records` as a tiled dataset under `out_dir` and return the manifest.

    Every record is validated and must be a `fixed` position with `host: None`, a kind listed in
    `kinds`, a unique id and no stored `in_cone`; otherwise ValueError lists the problems and nothing
    is written. Output is deterministic (sorted keys, records ordered by id, no timestamps)."""
    problems = []
    seen: set[str] = set()
    for r in records:
        rid = r.get("id") if isinstance(r, dict) else None
        probs = validate_record(r)
        if not probs:
            if r["position"]["model"] != "fixed":
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

    by_tile: dict[str, list[dict]] = {}
    for r in sorted(records, key=lambda r: r["id"]):
        p = r["position"]
        by_tile.setdefault(tile_of(p["ra"], p["dec"], band_deg), []).append(r)

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
        "max_extent_deg": max((angular_radius_deg(r) for r in records), default=0.0),
        "count": len(records), "provenance": provenance, "build": build, "tiles": tiles,
    }
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
            recs = json.loads(data)["objects"]
        except (ValueError, KeyError, TypeError):
            out.append(f"{name}: not a tile file")
            continue
        total += len(recs)
        if len(recs) != info["count"]:
            out.append(f"{name}: {len(recs)} records, manifest says {info['count']}")
        for r in recs:
            out += [f"{name}: {r.get('id')}: {p}" for p in validate_record(r)]
            if r.get("position", {}).get("model") == "fixed" and \
                    tile_of(r["position"]["ra"], r["position"]["dec"], ds.band_deg) != name:
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
