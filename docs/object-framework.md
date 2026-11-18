# Object framework for the 3D view (Phase 0)

Status: **approved 2026-11-18** (with the decisions in §14). Phase 0 is implemented; see §15 for what changed during implementation.

This document defines how every kind of object gets into the 3D fly-through (`frontend/scene3d.html`): one record
schema shared by backend and frontend, one endpoint that merges live and prebuilt sources, a frontend registry that
decides how each kind is drawn, picked, labelled, carded and flown to, and a frame design that scales from AU to Mpc.

Phase 0 builds the framework and proves it by moving the existing solar-system data (planets, Moon, SkyBoT asteroids
and comets) onto it. It adds no catalogues. Phases 1–3 should each need only a data source plus a registry entry:

| Phase | Adds | Needs from the framework |
|---|---|---|
| 0 | framework; planets, Moon, asteroids, comets migrated; solar markers in the Stars scene; layer panel | — |
| 1 | exoplanets (NASA Exoplanet Archive → Gaia DR3 hosts), clusters (Hunt & Reffert 2023) | `orbit` position model, `billboard` renderer, chained autopilot via a host star |
| 2 | nebulae (OpenNGC, Sharpless), black holes (Sgr A*, Gaia BH1/2/3, X-ray binaries) | direction-only records (`dist: null`), illustrative appearance with measured placement |
| 3 | galaxies (OpenNGC, UNGC, NED distances) | the `cosmos` (Mpc) frame |

## 1. Decisions at a glance

| Question | Decision | Why |
|---|---|---|
| Where do objects come from? | New `GET /api/objects`. `/api/scene3d` serves only stars and **drops the `solar` block** (no compatibility wrapper). | See §4.4. Objects arrive in about a second instead of waiting 30–90 s for a cold Gaia cone. A Gaia failure no longer hides the solar system. The only client ships in the same commit. |
| Stars as records? | No. Stars stay columnar (`fields` / `rows`, ~50k rows) with their own buffers, shaders and pick loop. They **do** get schema ids (`gdr3:…`, `hip:…`, `ss:sun`), and the renderer exposes them through the same kind interface. | Per-record JSON and per-object dispatch for tens of thousands of points would cost load time and frame time for no gain. Stable ids are what other records link to (`host`, `parent`). |
| Evidence | Each record has one `evidence` (`measured` \| `derived` \| `illustrative`), the evidence for **where it is drawn**. Each quantity also keeps its existing 4-tier `tier` (measured / catalogue / inferred / illustrative). A validator enforces that a record's evidence is never stronger than its position's tier. | The Evidence view hides or shows by placement. Cards keep the finer tiers they already show. Appearance (colour, rings, lensing) is always illustrative and is switched off in the Evidence view. |
| Frames | Table-driven frame levels, innermost first: `system` (AU) ⊂ `galaxy` (pc) ⊂ `cosmos` (Mpc, Phase 3). Phase 0 ships two levels through the generic code and a test that drives three. | §8 |
| Solar objects in the Stars scene | In the galaxy frame they are placed as seen from **Earth** (heliocentric position minus Earth's). They are drawn as constant-size markers with labels. The Sun, the Moon and all planets are shown across the whole sky. Asteroids, comets and dwarf planets are shown only inside the cone, which is all SkyBoT returns. Once the system is unresolved on screen, they collapse into one "Solar system" group marker on the Sun. | §9. At the start camera this gives the same directions as the 2D patch (and SkyBoT). From far away they correctly sit on the Sun. |
| Static data | Build script → `frontend/data/objects/<dataset>/manifest.json` + `tiles/*.json` (RA/Dec band tiling). Read by the backend loader. Also directly fetchable by static pages (the 2D rewind, later). | §6 |

## 2. Object record schema, version 1

Schema id: `"space-maps.objects/1"`. Records are plain JSON objects. Units are fixed per field and named in the field,
or carried inside a Quantity.

### 2.1 Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id `<namespace>:<local>` (§2.4). Unique in a response. The frontend keys selection, labels and caches on it. |
| `kind` | string | yes | A registered kind (§2.5). Clients ignore kinds they do not know. |
| `name` | string | yes | Display name. |
| `designations` | string[] | yes (may be empty) | Other names and numbers, for search and cards. |
| `host` | id \| null | yes | The star whose **system frame** holds this object (`ss:sun` for the solar system). `null` for objects that live in the galaxy (or cosmos) frame. A `state` or `orbit` position is relative to `host`. |
| `parent` | id \| null | yes | Physical parent: Moon → `ss:earth`, exoplanet → host star, SMBH → its galaxy, BH1 → its companion star. May point at an id not in the response. |
| `position` | Position | yes | §2.2 |
| `in_cone` | bool | response only | Set by the endpoint: inside the query cone as seen from the geocentre, extent included. Never stored in tiles. |
| `size` | Size \| null | yes | `{ "radius": Quantity, "angular": { "major": Q, "minor": Q, "pa": Q } \| null }`. Either part may be null. |
| `props` | {key: Quantity} | yes (may be `{}`) | Kind-specific values for cards (class, magnitude, mass, period, …). Keys are stable per kind (§2.5). |
| `provenance` | Provenance | yes | §2.3 |
| `evidence` | `"measured"` \| `"derived"` \| `"illustrative"` | yes | Evidence for the drawn placement (§3). |
| `render` | object | yes (may be `{}`) | Hints only, never data: `mag` (apparent V from Earth, for label priority and point brightness), `color` (display sRGB, always illustrative), `style` (named style the registry may honour). |

**Quantity**: `{ "v": number | string, "lo"?: number, "hi"?: number, "unit"?: string, "src": string, "tier": Tier }`.
Here `Tier` is one of `measured`, `catalogue`, `inferred`, `illustrative`, the same tiers and glyphs as
`scene3d-physics.js` `TIER_INFO`. Allowed units: `km au pc Mpc deg arcmin arcsec mag K d yr Gyr Msun Mjup Mearth
Rsun Rjup Rearth arcsec/h`. `lo`/`hi` are a 1σ or 16–84 % interval, as `src` says.

### 2.2 Position models

`position.model` names the model. Axes are always ICRS equatorial (x → RA 0 Dec 0, z → Dec +90), the same as
`scene3d.py`.

**`fixed`**: a catalogue position.
```json
{ "model": "fixed", "ra": 56.75, "dec": 24.12, "epoch": 2016.0,
  "dist": { "v": 135.0, "lo": 134.0, "hi": 136.0, "unit": "pc", "src": "…", "tier": "measured" },
  "method": "parallax" }
```
- `dist` may be `null`, which makes a direction-only object. It is drawn as a sky marker at infinity and never placed in 3D (Phase 2 nebulae without distances).
- `dist.unit` is `pc` or `Mpc`.
- `method` is one of `parallax`, `bailer-jones`, `cluster-parallax`, `photometric`, `kinematic`, `cepheid`, `trgb`, `sbf`, `tully-fisher`, `redshift`, `orbit-fit`, `assumed`. It is shown on cards and drives the evidence rule.
- `pm` (`{pmra, pmdec}` in mas/yr) is optional and reserved. It is not applied in Phase 0.

**`state`**: a position evaluated by the server at the response's `mjd` (TDB).
```json
{ "model": "state", "mjd": 61000.0, "xyz_au": [1.21, -0.62, -0.31],
  "geo": { "ra": 152.3, "dec": 11.9, "dist_au": 1.93 },
  "method": "ephemeris", "src": "…", "tier": "measured" }
```
- `xyz_au` is relative to `host`.
- `geo` is the direction and distance seen from the geocentre (light-time ignored, as today). It gives `in_cone`, the card's RA/Dec, and the Stars-scene marker direction.
- `method` is `ephemeris` (built-in planetary theory) or `orbit-propagation` (SkyBoT).

**`orbit`**: Keplerian elements relative to `host`, for the client to evaluate. This is reserved for Phase 1 (exoplanets). Phase 0 validates the shape only.
```json
{ "model": "orbit", "elements": { "a_au": Q, "e": Q, "i_deg": Q|null, "period_d": Q, "t_peri_mjd": Q|null,
  "omega_deg": Q|null, "node_deg": Q|null }, "phase_known": false, "src": "…", "tier": "illustrative" }
```
If the phase or orientation is unknown (`phase_known: false`), the drawn point on the orbit is illustrative, and so is
the record's `evidence` (§3).

### 2.3 Provenance

```json
{ "source": "skybot", "catalogue": "IMCCE SkyBoT", "version": null, "citation": "Berthier et al. 2006, ASP Conf. Ser. 351, 367",
  "url": "https://ssp.imcce.fr/webservices/skybot/", "query": { "epoch_jd": 2461000.5, "observer": "500" } }
```
- `source` is the backend source id (§5).
- `version` is the catalogue release, or the pinned file hash for static data.
- `query` is free-form and optional.
- Static datasets add `"dataset"` and `"build"` (the script name and the manifest's build stamp).
- Per-quantity `src` strings give detail where one record mixes sources.

### 2.4 Ids

| Namespace | Local part | Phase | Example |
|---|---|---|---|
| `ss` | lower-case IAU name of a built-in major body | 0 | `ss:sun`, `ss:earth`, `ss:moon`, `ss:mars` |
| `mp` | MPC number if numbered, else provisional designation | 0 | `mp:1`, `mp:2019 YB21` |
| `comet` | MPC comet designation | 0 | `comet:29P`, `comet:C/2020 F3` |
| `gdr3` | Gaia DR3 `source_id` (EDR3 ids are identical) | 0 (stars) | `gdr3:4472832130942575872` |
| `hip` | Hipparcos number (XHIP context stars) | 0 (stars) | `hip:113357` |
| `nea` | NASA Exoplanet Archive `pl_name` | 1 | `nea:51 Peg b` |
| `hr23` | Hunt & Reffert 2023 cluster name | 1 | `hr23:Melotte_22` |
| `ongc` | OpenNGC name | 2–3 | `ongc:NGC0224` |
| `sh2` | Sharpless number | 2 | `sh2:155` |
| `ungc` | UNGC name | 3 | `ungc:…` |
| `bh` | project-curated black-hole list (each record cites its paper) | 2 | `bh:Sgr A*`, `bh:Gaia BH1` |
| `gal` | project-curated special galaxies with no catalogue id that fits (the Milky Way) | 2–3 | `gal:milky_way` |
| `test` | fixtures only | 0 | `test:a` |

Every object has exactly one `id`, chosen by the source in a fixed precedence. All other names go in
`designations`. For example, Pluto from SkyBoT is `mp:134340` with name `Pluto`. When two sources return the same
`id`, the higher-precedence source wins (§5.3).

The star renderer uses the same ids as frame-host keys. `_starKey` changes from `sun` / `g:<id>` / `c:<hip>` to
`ss:sun` / `gdr3:<id>` / `hip:<n>`. So an exoplanet's `host` is directly the key of the star system it lives in.

### 2.5 Kinds

| Kind | Phase | Source | `host` | `props` keys |
|---|---|---|---|---|
| `sun` | 0 | ephem (one record, `ss:sun`, `xyz_au` [0,0,0]) | `ss:sun` | `dist_earth` |
| `planet` | 0 | ephem | `ss:sun` | `dist_sun`, `dist_earth` |
| `moon` | 0 (Moon only) | ephem | `ss:sun` (parent `ss:earth`) | `dist_sun`, `dist_earth` |
| `dwarf_planet` | 0 | skybot, identified **only** by the fixed asteroid-number list 1, 134340, 136199, 136108, 136472 (never by SkyBoT `Class`) | `ss:sun` | as asteroid |
| `asteroid` | 0 | skybot | `ss:sun` | `class`, `vmag`, `dist_sun`, `dist_earth`, `pos_err` |
| `comet` | 0 | skybot | `ss:sun` | as asteroid |
| `exoplanet` | 1 | static `nea` | host star id | `mass`, `radius`, `period`, `a`, `disc_method`, `disc_year` |
| `cluster` | 1 | static `hr23` | null | `n_members`, `age`, `r50`, `extinction` |
| `nebula` | 2 | static `ongc` / `sh2` | null | `type`, `surface_brightness` |
| `black_hole` | 2 | static `bh` | null or the companion's system | `mass`, `type` |
| `galaxy` | 3 | static `ongc` / `ungc` (+ NED distances) | null | `type`, `mag_b`, `v_helio` |

Stars are kind `star`. It is used for ids and dispatch, but never sent as an object record in Phase 0. Phase 1 may
send `star` records for exoplanet hosts missing from the star payload (§13).

The Sun is both star 0 of the star pipeline and the `sun` object record, and the two roles never overlap:
- **Star 0** is the host sphere in the system frame and a star point seen from afar.
- **The `sun` record** is only the galaxy-frame direction marker, the Sun as seen from Earth (§9).

Both share the id `ss:sun`. Picking the marker opens the Sun's star card.

**Comet vs asteroid (SkyBoT).** A record is a comet if its `Class` starts with `Comet`, or if its name matches a comet
designation (`^\d+[PDI](/|$)` or `^[CPDXI]/`). Everything else is an asteroid, apart from the dwarf-planet numbers
above. This replaces the frontend regex `/^(C|P|D|I)/` on the class string, which also matched "Centaur". The exact
`Class` string SkyBoT uses for comets is checked against the live service during integration (the mock uses
`Comet`).

### 2.6 Versioning

- Responses and tile manifests carry `"schema": "space-maps.objects/1"`.
- Adding optional fields, kinds, namespaces, units or methods keeps the version at **1**. Clients must ignore what they do not know.
- Removing a field, changing a unit, or changing what a field means bumps the major version.
- The frontend accepts only the majors it knows. On a mismatch it shows a note ("Objects need a newer page; reload") and draws no objects. Stars are unaffected.

## 3. Evidence rules

The record's `evidence` describes **where the object is drawn**:

| `evidence` | Meaning | Examples |
|---|---|---|
| `measured` | Existence and 3D placement come from measurement, or from a catalogue model fitted to measurements. | planets (ephemeris), SkyBoT objects, Gaia-parallax clusters, Sgr A* (stellar orbits), Cepheid/TRGB galaxy distances |
| `derived` | The object is real, but its placement rests on a relation with real assumptions. | photometric or kinematic nebula distances, redshift (Hubble-flow) galaxy distances |
| `illustrative` | The drawn placement is a stand-in. | an exoplanet at an unknown orbital phase |

- **Validator rule.** The record's evidence may not be stronger than its position allows. A position tier of `measured` or `catalogue` allows at most `measured`, `inferred` allows at most `derived`, and `illustrative` allows only `illustrative`. For `fixed` positions the governing tier is `dist.tier`. For `orbit` positions with `phase_known: false` the record must be `illustrative`. The backend rejects records that break the rule: the record is dropped, counted and logged, and the request does not fail. The rule is also tested.
- **Evidence view.**
  - It hides records whose evidence is `illustrative`.
  - It draws every other record in its renderer's *evidence style*, with no illustrative appearance. Star glows already go today.
  - **Phase 0 makes no visible change here.** Planet bands, atmospheres and rings are tagged `illustrative` in the planet kind's sphere spec (`features: {band, atm, ring}`). Whether the Evidence view drops them is one constant in `scene3d-registry.js`, `EVIDENCE_HIDES_FEATURES = false`. Today the ring is clipped by the quad extent while bands and atmosphere still show, and that is kept. Hiding them all is a follow-up (§13).
  - Card rows with tier `illustrative` are dropped, as now.
  - Derived records stay visible. Their markers get a hollow style hook, which Phase 0 has no records to use (§7.1).
- **Group markers** (§9) count only records that pass the current evidence and layer filters. An exoplanet hidden in the Evidence view still shows as "3 planets" on its host's card, because its existence is measured. This is a Phase 1 card detail.

## 4. Endpoint contract

### 4.1 `GET /api/objects`

| Param | Default | Rule |
|---|---|---|
| `ra`, `dec` | required | as `/api/scene3d` |
| `radius` | 3.0 | 0.1–5.0 deg, as `/api/scene3d` |
| `mjd` | now (TDB, rounded to the hour) | 15020–88069 |
| `kinds` | all registered kinds | Comma list. An unknown kind gives 400 and the message lists the valid ones. |
| `limit` | 2000 | 1–10000, the cap **per kind**. Records are sorted by `render.mag` (brightest first, unknown last); `truncated` is reported per kind. |

Response (200 whenever the parameters are valid, whatever the sources do):
```json
{
  "schema": "space-maps.objects/1",
  "query": { "ra": 150.0, "dec": 2.0, "radius": 3.0, "mjd": 61000.0, "kinds": ["planet", "moon", "dwarf_planet", "asteroid", "comet"] },
  "objects": [ { "...": "records, §2" } ],
  "kinds": {
    "planet":   { "status": "ok", "source": "ephem", "count": 8, "truncated": false },
    "moon":     { "status": "ok", "source": "ephem", "count": 1, "truncated": false },
    "asteroid": { "status": "error", "source": "skybot", "count": 0, "truncated": false, "error": "SkyBoT down" },
    "comet":    { "status": "error", "source": "skybot", "count": 0, "truncated": false, "error": "SkyBoT down" },
    "cluster":  { "status": "unavailable", "source": null, "count": 0, "truncated": false }
  },
  "sources": [
    { "id": "ephem", "status": "ok", "ms": 41, "count": 9, "dropped": 0, "provenance": { "...": "" } },
    { "id": "skybot", "status": "error", "ms": 25000, "count": 0, "dropped": 0, "error": "timed out after 25 s" }
  ]
}
```
- `kinds` is what the page uses for notes. It replaces `bodies_error`, and every kind fed by a failed source carries that source's error.
- `unavailable` means no source serves that kind in this deployment, for example no dataset installed. It is not an error.
- `sources` is for diagnostics and provenance.

### 4.2 Failure and timing

- Sources run concurrently. Each is wrapped in `try/except Exception` and a deadline, `config.OBJECTS_SOURCE_TIMEOUT_S` (default 25 s, env `SPHEREX_OBJECTS_SOURCE_TIMEOUT`).
- The deadline wraps `asyncio.shield`, so a slow SkyBoT query keeps running in the background and fills its disk cache for the next request. Today one slow SkyBoT can hold the scene for the 300 s HTTP timeout.
- Only invalid parameters give 4xx. Nothing gives 5xx because of a source.
- Ephemeris and SkyBoT are independent. SkyBoT gets Earth's position from a shared, `lru_cache`d `earth_xyz(mjd)`, so a planet-list failure does not lose the small bodies (unless astropy itself fails).

### 4.3 Caching

- The response as a whole is not cached.
- Ephemeris is computed per request (milliseconds).
- SkyBoT keeps its 7-day disk cache, keyed with the epoch, which is why the default `mjd` is rounded to the hour.
- Static manifests and tiles are cached in memory and reloaded when the manifest's mtime changes.

### 4.4 `/api/scene3d` after Phase 0

It keeps `ra`, `radius` and `limit`, and returns `{ra, dec, radius, stars}`. The `solar` block and `mjd` go: stars are
epoch 2016 and do not depend on the date. Reasons not to keep a compatibility wrapper:

1. Its only client is this repo's frontend, which is served by the same backend and migrated in the same change.
2. A wrapper would either query SkyBoT twice per page (scene3d + objects, both cold together) or make the page wait for stars before it gets objects.
3. Splitting fixes two real bugs:
   - Today a Gaia failure on every source (502) also loses the planets.
   - An ephemeris exception (outside the `try` in `build_scene`) fails the whole scene.

A browser holding an old cached page against a new backend simply gets no solar system (`if (p.solar)` is already
optional), and FastAPI ignores the now-unknown `mjd` parameter.

## 5. Backend layout

| Module | Contents |
|---|---|
| `spherex_app/objects.py` | Schema constants (`SCHEMA`, `KINDS`, `TIERS`, `EVIDENCE`, units, methods, namespaces); `validate_record()` (returns a list of problems, does not raise); `quantity()` / `record()` helpers; the evidence rule; `cone_contains(record, ra, dec, radius)`; the source registry; `build_objects()` (merge, limits, per-kind status). |
| `spherex_app/objects_live.py` | `ephem` source: `solar_positions` moved here from `scene3d.py`, plus `earth_xyz(mjd)`, records for the 8 planets (Earth included) and the Moon, with IAU radii (moved from the frontend's `PLANET_KM`). `skybot` source: `bodies_xyz` moved here, plus classification into asteroid / comet / dwarf_planet and record building. |
| `spherex_app/objects_static.py` | Tiling maths, manifest and tile loading and validation, cone query, and `write_dataset()` for build scripts. |
| `spherex_app/scene3d.py` | Stars only; the solar code moves out. |
| `spherex_app/main.py` | `/api/objects` route; `/api/scene3d` loses `mjd`. |
| `spherex_app/config.py` | `OBJECTS_DIR` (env `SPHEREX_OBJECTS_DIR`, default `FRONTEND_DIR/data/objects`) and `OBJECTS_SOURCE_TIMEOUT_S`. |

### 5.1 Source interface

```python
@dataclass(frozen=True)
class Source:
    id: str                      # "ephem", "skybot", "static:<dataset>"
    kinds: tuple[str, ...]       # kinds it can return
    precedence: int              # lower wins on duplicate ids
    fetch: Callable[[Query], Awaitable[list[dict]]]   # raises on failure; returns schema records
    provenance: dict             # shown in `sources`
```
Live sources are registered in code. Every valid dataset found under `OBJECTS_DIR` registers one `static:<dataset>`
source at startup. A broken manifest registers a source that always reports an error, so the problem is visible in
`sources` instead of silently missing.

### 5.2 Query

`Query(ra, dec, radius, mjd, kinds, limit)`. Sources whose kinds do not meet `kinds` are not run.

### 5.3 Merge

1. Each source's records are validated. Invalid ones are dropped and counted in `dropped`.
2. Records are filtered to the requested kinds.
3. Duplicate ids are de-duplicated by `precedence`.
4. Records are cut per kind to `limit` by `render.mag`.
5. `in_cone` is set on every record. Records are cone-filtered when their source is a cone source (skybot, static). The Sun, planets and Moon are always all returned (the Stars scene shows them across the whole sky and the Solar system scene needs them all) and carry `in_cone` truthfully.
6. Output order is kind order (§2.5), then `render.mag`, then id, so tests are deterministic.

## 6. Static tile format (`space-maps.object-tiles/1`)

Location: `frontend/data/objects/<dataset>/`. It is served statically, so the 2D rewind can later read it without the
backend, and it is read from disk by the backend loader. Phase 0 ships no dataset there. The loader is exercised by
`backend/tests/fixtures/objects/fixture-clusters/`, which is built by `backend/scripts/build_objects_fixture.py` (the
template for Phase 1 build scripts).

```
<dataset>/manifest.json
<dataset>/tiles/<band>-<bin>.json
```

**Tiling `radec-bands`.**
- Declination bands of `band_deg` (default 10°), numbered from −90°. Band `b` covers `[-90 + b·w, -90 + (b+1)·w)`, and the last band includes +90.
- Band `b` has `n_b = max(1, round(360·cos(dec_mid)/w))` RA bins of `360/n_b` degrees each, with bin 0 starting at RA 0.
- A record goes in the tile that holds its `(ra, dec)`. Direction-only records (`dist: null`) are tiled the same way.
- Cone query: every tile whose bounding cap intersects the cone grown by `manifest.max_extent_deg` is read. The records are then filtered exactly with `cone_contains`, which includes the record's angular radius.
- The poles and the RA 0/360 wrap are covered in the tests.
- HEALPix was considered and not used: there is no pure-Python implementation without a new dependency (`astropy-healpix`/`healpy`), and the catalogue sizes in Phases 1–3 (≤ ~20k objects each) do not need it. The tiling is named in the manifest, so a later `healpix-nested` scheme can sit beside it.

**`manifest.json`**
```json
{
  "format": "space-maps.object-tiles/1",
  "schema": "space-maps.objects/1",
  "dataset": "hr23-clusters",
  "kinds": ["cluster"],
  "precedence": 50,
  "tiling": { "scheme": "radec-bands", "band_deg": 10 },
  "max_extent_deg": 4.2,
  "count": 7167,
  "provenance": {
    "catalogue": "Hunt & Reffert 2023 star clusters", "version": "J/A+A/673/A114",
    "citation": "Hunt & Reffert 2023, A&A 673, A114", "url": "https://cdsarc.cds.unistra.fr/…",
    "source_sha256": "<hash of the downloaded source file>"
  },
  "build": { "script": "backend/scripts/build_objects_hr23.py", "script_version": 1 },
  "tiles": { "11-14": { "count": 12, "sha256": "…" } }
}
```
**Tile** `tiles/11-14.json`: `{ "format": "space-maps.object-tiles/1", "tile": "11-14", "objects": [ records ] }`.

Tile records must use `fixed` positions and `host: null`, and must pass `validate_record`.

**Reproducibility.**
- `write_dataset()` writes sorted keys, a stable record order (by id), `separators=(",", ":")` and no timestamps (the build stamp is the script version plus `source_sha256`, not the build time).
- The same input gives byte-identical output, and this is tested.
- Build scripts pin their source (a release, a VizieR table id, a git SHA or a file hash), follow the existing pattern (`ROOT/"frontend"/"data"/…`, `httpx` with timeouts, a `--local` file flag, usage in the docstring) and document themselves in `docs/technical-reference.md`.
- The loader verifies a tile's `sha256` only in tests and in `--check` mode of the build script. At runtime it trusts the repo.

## 7. Frontend

New pure modules (no DOM, no WebGL, testable in node):

- `js/blink/scene3d-registry.js` holds the kinds and layers registry, the built-in Phase 0 kind specs, and layer persistence.
- `js/blink/scene3d-objects.js` holds the object store. It ingests a payload and checks the schema major, computes per-frame positions, builds pick, label and group candidates from a projector function, and plans autopilot trips.

`scene3d.js` keeps everything GL and the star internals, and calls into the store and registry instead of branching on
`sel.t`. `scene3d-main.js` fetches stars and objects in parallel and owns the layer panel.

### 7.1 Kind spec (registry interface)

```js
registerKind({
  kind: 'asteroid',
  layer: 'asteroids',                       // toggle-panel layer this kind belongs to
  noun: ['small body', 'small bodies'],     // HUD counts
  // which frames show it, and how: 'point' | 'sphere' | 'marker' | 'billboard'
  // (billboard is reserved for Phase 1 clusters and not implemented in Phase 0)
  frames: { system: 'point', galaxy: 'marker' },
  pick: { priority: 30 },                   // lower is picked first: planets 10, stars 20, small bodies 30
  label: { key: (o) => 100 + (o.render.mag ?? 30), max: 12, hideOverDiscPx: 30 },
  card: (o, ctx) => ({ title, subtitle, rows: [[label, text, tier, src]], notes }),   // data only; DOM is built by scene3d-card.js
  go: 'host-frame',                         // autopilot: fly inside the host's system frame (§7.4)
  arriveAu: (o) => 0,                       // stop distance radius; spheres use their radius
  collide: false,                           // keepOutside sphere in the system frame (planets: true)
  color: (o) => [0.82, 0.78, 0.7],          // illustrative display colour
  sphere: null,                             // sphere kinds: (o, evidence) => { rgb, ring, band, atm, pole }
  visible: (o, { evidence }) => !(evidence && o.evidence === 'illustrative'),   // default
  markerStyle: (o) => (o.evidence === 'derived' ? 'hollow' : 'solid'),         // hook; no derived records in Phase 0
});
```
Phase 0 registers `planet`, `moon`, `dwarf_planet`, `asteroid` and `comet`.

`star` is registered with the same fields, plus `builtin: true`. Its pick, position, card and go come from
`scene3d.js`'s columnar star code, not the store, which keeps the special case explicit. Kinds the server sends that
are not registered are counted and ignored.

**Renderers in `scene3d.js`.**

| Renderer | Behaviour |
|---|---|
| `point` | System-frame AU positions in one static buffer per layer state, drawn with the existing `point` program (as the solar `points` buffer is today). |
| `sphere` | Today's planet path: a point that cross-fades into a ray-traced impostor, with per-kind shading from `sphere()`. |
| `marker` | Constant-size GL points from camera-relative positions computed in doubles each frame (`_drawDynPoints`), plus overlay labels and the selection ring. |

### 7.2 Selection

`sel = { kind, id }` for objects and `{ kind: 'star', id, idx }` for stars. `this.sel.t` disappears. Because ids are
stable, a selection survives a refreshed objects payload, which fixes the stale `bodies[idx]` that a second
`setSolar` could leave. Every site in the inventory becomes registry dispatch:

| Site | Becomes |
|---|---|
| `_resolve`, `_go`, `_stepAutopilot` | `ops(kind).resolve`, `planGo` (§7.4) |
| `_valid` | the kind is registered, its layer is on, it is visible in the current frame and evidence, and the record exists |
| `_selKey` | `kind + ':' + id` |
| `_selPos` | the store's position in the camera's frame |
| `_renderCard` | `spec.card()` → `renderBodyCard`; the star path keeps `renderStarCard` |
| `_crosshairTarget` | `resolve` + `arriveAu` |
| `_labelCandidates` | per-kind `label` |
| `_pickAt` | candidates from every visible kind, sorted by (priority, then brightest for stars / nearest for the rest), matching today's behaviour |
| `_nearBody`, `_nearest` | kinds with `collide` |
| `_draw` | per-renderer |
| `_onFrameChange` | keeps `sel` if it is still valid in the new frame, instead of "clear anything not a star" |
| overlay ring | `this.dyn` keyed by selection key |

### 7.3 Layers and the panel

`registerLayer({ id, label, group, on })`:

| Group | Layers |
|---|---|
| Sky | `mw` Milky Way glow, `cone` Cone outline, `starNames` Star names |
| Solar system | `planets` Planets and the Moon, `orbits` Orbits, `dwarfPlanets` Dwarf planets, `asteroids` Asteroids, `comets` Comets |

- Defaults are all on, so nothing changes visually for existing users apart from the new markers.
- Choices are saved as `{id: bool}` JSON under `localStorage['blink.scene3d.layers']`, wrapped in try/catch as `rewind-sky.js` does. A blocked or corrupt store gives the defaults.
- The panel is a "Layers" button in the bottom nav, plus the L key. It opens a small panel of `aria-pressed` pills grouped as above, built from the registry. A layer with no data in this payload is shown disabled with its reason ("SkyBoT down").
- Turning a layer off hides its objects, labels and picks, and clears a selection in it.
- Phase 1 adds `exoplanets` and `clusters` just by registering them.

### 7.4 Autopilot ("Go there")

`planGo(target, cam)` is pure and tested. Its result depends on where the target lives:

| Target | Plan |
|---|---|
| Star | the existing star trip in galaxy parsecs |
| Object whose `host` is the camera's current system frame | fly in AU (today's planet and body trip, retargeted each frame) |
| Object hosted by `ss:sun`, camera not in the Sun's frame | `setScene('solar')` (camera near Earth, as the pill does), then fly. This is the Stars-scene path into the Solar system scene. |
| Object hosted by another star | star trip to the host with `then: target`. On arrival in the host's frame, `_arrived` starts the object trip. |

The last case is implemented and unit-tested in Phase 0, so Phase 1 exoplanets need no autopilot work. It has no real
data in Phase 0.

### 7.5 Data flow

`scene3d-main.js` calls `getScene3D` (stars) and `getObjects` (new in `api.js`) concurrently.

- Objects usually land first. Markers and the Solar system pill become available without waiting for Gaia.
- `scene.setObjects(payload)` replaces `setSolar`. `hasSolar` means the store has `ss:earth`.
- Notes come from `kinds[*].status === 'error'`, grouped by error: "Asteroids, comets and dwarf planets are missing: SkyBoT down".
- The HUD date comes from the objects payload's `query.mjd`.
- HUD counts use the registry nouns.

## 8. Frames and scales

Frames exist for three reasons:

1. GPU precision: static float32 buffers hold frame-unit coordinates.
2. Human units and speed ranges (HUD, wheel, auto-throttle bounds).
3. Which object populations are live.

CPU positions are float64 everywhere and are subtracted from the camera before reaching the GPU, so precision is not
the limit at any planned scale.

```js
// scene3d-frames.js: innermost first; a camera is { frame, host, pos, vel, … } as today
export const LEVELS = [
  { name: 'system', unit: 'AU',  perPc: AU_PER_PC, enterPc: 0.02, leavePc: 0.03,           // host: a star
    range: { min: 1e-6, max: 1e3, speed: 0.2 }, autoPc: { min: 1e-12, max: 100 }, fov: 60 },
  { name: 'galaxy', unit: 'pc',  perPc: 1,                                                 // host: none (origin = Sun)
    range: { min: 0.01, max: 1e4, speed: 2 },   autoPc: { min: 1e-12, max: 100 } },
  // Phase 3, not registered in Phase 0:
  // { name: 'cosmos', unit: 'Mpc', perPc: 1e-6, enterPc: 6e4, leavePc: 4e4 (from the Sun, i.e. leave the galaxy beyond 60 kpc),
  //   range: { min: 1e-6, max: 100, speed: 0.01 }, autoPc: { min: 1, max: 1e8 } },
];
export function makeFrames(levels) → { unitsPerPc, worldPc, relFromCam, toFrame, stepFrame, level(name) }
```
- **Hierarchy.** Each level's origin is a host in the next level out. A system host is a star at `host.pc`. The galaxy frame's origin is the Sun, which is at the origin of `cosmos` too, so galaxy ↔ cosmos is a pure scale (ICRS axes, Sun-centred, no Local-Group offset). All conversions go through parsecs in doubles: `worldPc(cam)` walks out to pc, and `toFrame(pc, level, host)` walks in.
- **Transitions.** Each level has `enterPc` and `leavePc` hysteresis. The ratio is 1.5 as today.
  - For `system`, the distance is to the nearest star candidate; that is today's `stepFrame`, unchanged.
  - For `cosmos`, it is the distance from the Sun. Leaving the galaxy beyond 60 kpc enters `cosmos`, and coming back inside 40 kpc returns.
  - There is no frame per external galaxy, because there are no resolved stars to show there. A per-galaxy `kpc` level can be added later as one more table row with a galaxy host.
- **`RANGE` and the auto-throttle bounds** move from `scene3d.js` constants into the table (`range`, `autoPc`). The values are the same for the existing two levels.
- **Rendering per level.**
  - Stars are drawn in `system` and `galaxy`.
  - In `cosmos` the Gaia points collapse into the Milky Way object. That is an illustrative billboard in Phase 3, and in the Evidence view only a marker.
  - Near and far clip planes come from the level (`near`/`far`, today 1e-9 and 1e12/1e9).
  - The HUD unit comes from `unit`.
- **Phase 0 deliverable.** The frame functions are table-driven and take the level list as data. The old exports (`ENTER_PC`, `LEAVE_PC`, `toSystemPos`, `stepFrame`, …) stay as the two-level instance, so the existing tests pass unchanged. A new test builds a three-level table (with a synthetic outer level) and checks the enter/leave round trips, hysteresis and `worldPc` precision across all three.

## 9. Solar-system objects in the Stars scene

At parsec scale the solar system is a point at the Sun. What the user clicked, though, is a patch of the **geocentric**
sky (the sphere, the frames and SkyBoT all use the geocentre), and the start camera at the origin stands in for that
observer: the intro hand-off already relies on this for stars, whose parallax between Sun and Earth is invisible.

**Placement (galaxy frame).** A solar-system object sits at `(xyz_au − earth_xyz_au) / AU_PER_PC` pc.
- At the start camera, its direction is exactly its geocentric `geo` direction, so Ceres sits where the 2D patch showed it.
- From anywhere else it is within ~30 AU of the Sun, which is what a pc-scale view should show.
- The 1 AU shift between this placement and the system frame's heliocentric one occurs at the frame switch (≥ 4,100 AU from the Sun). There it is under 0.015°, below a pixel at the system frame's 60° field.
- The rule generalises: objects of another host get no shift (there is no observer there).

**Which objects.** These are per-kind registry settings (`galaxyScope: 'sky' | 'cone'`), applied within the layers that are on:
- The Sun, the Moon and all seven other planets are `'sky'`: drawn across the whole sky, as the XHIP context stars are.
- Asteroids, comets and dwarf planets are `'cone'`: only `in_cone` records. SkyBoT returns only the cone anyway, and the filter keeps that true for any future source.
- Earth is not drawn in the galaxy frame, since it is the observer. Its marker would sit on the camera.

**Drawing.**
- `marker` renderer: a constant-size point in the kind's colour.
- Labels follow the kind's label rule (bright first, at most 12 small-body labels as today).
- Picking uses the kind priorities, so planets win over stars and stars win over small bodies.
- The card is the same one as in the Solar system scene, plus "Show in the Solar system", which runs the §7.4 plan.

**Group marker.** When the host system's spread on screen, `maxR_AU / dist_AU · pxPerRad`, falls below 8 px, its
markers and labels are replaced by one group marker at the host, "Solar system · 14 objects in the patch".
- The count includes only visible objects.
- Picking the group shows a card with counts per kind and a "Go there" that opens the Solar system scene.
- The group is generic over `host`. Phase 1 exoplanet systems get it for free ("Kepler-90 · 8 planets").

**Evidence view.** Markers are annotations of measured placements, as star labels are, so they stay. Illustrative
records are hidden as everywhere else.

## 10. JSON examples

These examples are stored verbatim as `backend/tests/fixtures/objects/examples/*.json`, and the schema tests validate
every one of them, so this document cannot drift from the validator.

- The planet, asteroid and comet show the shape the live sources will produce. Their numbers are representative, not a stored ephemeris.
- **The Phase 1–3 values are approximate placeholders that illustrate the format. They are not curated data**, and real records will come from the pinned catalogues.

**Planet (ephem)**
```json
{
  "id": "ss:mars", "kind": "planet", "name": "Mars", "designations": ["NAIF 499"],
  "host": "ss:sun", "parent": "ss:sun",
  "position": { "model": "state", "mjd": 61000.0, "xyz_au": [1.234567, -0.512345, -0.268901],
    "geo": { "ra": 152.31, "dec": 11.92, "dist_au": 1.932 },
    "method": "ephemeris", "src": "astropy built-in ephemeris (ERFA plan94/epv00)", "tier": "measured" },
  "in_cone": false,
  "size": { "radius": { "v": 3396.2, "unit": "km", "src": "IAU WGCCRE 2015 equatorial radius", "tier": "measured" }, "angular": null },
  "props": {
    "dist_sun":   { "v": 1.3637, "unit": "au", "src": "astropy built-in ephemeris", "tier": "measured" },
    "dist_earth": { "v": 1.932,  "unit": "au", "src": "astropy built-in ephemeris", "tier": "measured" }
  },
  "provenance": { "source": "ephem", "catalogue": "astropy built-in solar-system ephemeris", "version": "astropy 6.1",
    "citation": "Astropy Collaboration 2022; ERFA", "url": "https://docs.astropy.org/en/stable/coordinates/solarsystem.html" },
  "evidence": "measured",
  "render": { "mag": 1.1 }
}
```

**Asteroid (SkyBoT)**
```json
{
  "id": "mp:2019 YB21", "kind": "asteroid", "name": "2019 YB21", "designations": [],
  "host": "ss:sun", "parent": "ss:sun",
  "position": { "model": "state", "mjd": 61000.0, "xyz_au": [-2.110482, 1.402931, 0.611207],
    "geo": { "ra": 149.98072, "dec": 2.00882, "dist_au": 2.40787 },
    "method": "orbit-propagation", "src": "IMCCE SkyBoT, geocentric RA/Dec and distance; heliocentric xyz = Earth + dg·û (light-time ignored)", "tier": "catalogue" },
  "in_cone": true,
  "size": null,
  "props": {
    "class":      { "v": "MB>Middle", "src": "IMCCE SkyBoT", "tier": "catalogue" },
    "vmag":       { "v": 22.5, "unit": "mag", "src": "IMCCE SkyBoT", "tier": "catalogue" },
    "dist_sun":   { "v": 2.6213, "unit": "au", "src": "IMCCE SkyBoT", "tier": "catalogue" },
    "dist_earth": { "v": 2.40787, "unit": "au", "src": "IMCCE SkyBoT", "tier": "catalogue" },
    "pos_err":    { "v": 0.11, "unit": "arcsec", "src": "IMCCE SkyBoT", "tier": "catalogue" }
  },
  "provenance": { "source": "skybot", "catalogue": "IMCCE SkyBoT", "version": null,
    "citation": "Berthier et al. 2006, ASP Conf. Ser. 351, 367", "url": "https://ssp.imcce.fr/webservices/skybot/",
    "query": { "epoch_jd": 2461000.5, "observer": "500" } },
  "evidence": "measured",
  "render": { "mag": 22.5 }
}
```

**Comet (SkyBoT)**
```json
{
  "id": "comet:29P", "kind": "comet", "name": "29P/Schwassmann-Wachmann", "designations": ["29P"],
  "host": "ss:sun", "parent": "ss:sun",
  "position": { "model": "state", "mjd": 61000.0, "xyz_au": [-5.902113, 1.331087, 1.120554],
    "geo": { "ra": 150.4, "dec": 1.7, "dist_au": 5.31 },
    "method": "orbit-propagation", "src": "IMCCE SkyBoT, geocentric RA/Dec and distance; heliocentric xyz = Earth + dg·û (light-time ignored)", "tier": "catalogue" },
  "in_cone": true,
  "size": null,
  "props": {
    "class":      { "v": "Comet", "src": "IMCCE SkyBoT", "tier": "catalogue" },
    "vmag":       { "v": 15.8, "unit": "mag", "src": "IMCCE SkyBoT (total magnitude)", "tier": "catalogue" },
    "dist_sun":   { "v": 6.15, "unit": "au", "src": "IMCCE SkyBoT", "tier": "catalogue" },
    "dist_earth": { "v": 5.31, "unit": "au", "src": "IMCCE SkyBoT", "tier": "catalogue" }
  },
  "provenance": { "source": "skybot", "catalogue": "IMCCE SkyBoT", "version": null,
    "citation": "Berthier et al. 2006, ASP Conf. Ser. 351, 367", "url": "https://ssp.imcce.fr/webservices/skybot/" },
  "evidence": "measured",
  "render": { "mag": 15.8 }
}
```

**Exoplanet (Phase 1, hypothetical)**: the orbit is known, the phase on it is not, so the placement is illustrative.
```json
{
  "id": "nea:51 Peg b", "kind": "exoplanet", "name": "51 Peg b", "designations": ["HD 217014 b", "Dimidium"],
  "host": "hip:113357", "parent": "hip:113357",
  "position": { "model": "orbit", "phase_known": false, "tier": "illustrative",
    "src": "NASA Exoplanet Archive pscomppars (placeholder values)",
    "elements": {
      "a_au":     { "v": 0.0527, "unit": "au", "src": "placeholder", "tier": "catalogue" },
      "e":        { "v": 0.0, "src": "placeholder", "tier": "catalogue" },
      "period_d": { "v": 4.2308, "unit": "d", "src": "placeholder", "tier": "measured" },
      "i_deg": null, "t_peri_mjd": null, "omega_deg": null, "node_deg": null } },
  "size": null,
  "props": {
    "mass":        { "v": 0.46, "unit": "Mjup", "src": "placeholder (M sin i)", "tier": "measured" },
    "disc_method": { "v": "Radial Velocity", "src": "placeholder", "tier": "catalogue" },
    "disc_year":   { "v": 1995, "src": "placeholder", "tier": "catalogue" }
  },
  "provenance": { "source": "static:nea-exoplanets", "dataset": "nea-exoplanets", "catalogue": "NASA Exoplanet Archive",
    "version": "pscomppars <pinned date>", "citation": "NASA Exoplanet Archive (Christiansen et al. 2025)", "url": "https://exoplanetarchive.ipac.caltech.edu/" },
  "evidence": "illustrative",
  "render": {}
}
```
Note: a static tile requires `fixed` positions and `host: null` (§6), but exoplanets are hosted orbits. Phase 1
therefore relaxes that rule for kinds whose registry says `hosted: true`. It tiles them by their host's RA/Dec, and
the record gains `position.host_radec` for that purpose. This is recorded in the Phase 1 checklist rather than built
now, because Phase 0 has no hosted static kind to test it with.

**Cluster (Phase 1, hypothetical)**
```json
{
  "id": "hr23:Melotte_22", "kind": "cluster", "name": "Pleiades", "designations": ["Melotte 22", "M45"],
  "host": null, "parent": null,
  "position": { "model": "fixed", "ra": 56.6, "dec": 24.1, "epoch": 2016.0, "method": "cluster-parallax",
    "dist": { "v": 135.0, "lo": 134.0, "hi": 136.0, "unit": "pc", "src": "placeholder", "tier": "measured" } },
  "size": { "radius": { "v": 3.0, "unit": "pc", "src": "placeholder (r50)", "tier": "catalogue" },
            "angular": { "major": { "v": 1.3, "unit": "deg", "src": "placeholder", "tier": "catalogue" }, "minor": null, "pa": null } },
  "props": { "n_members": { "v": 900, "src": "placeholder", "tier": "catalogue" }, "age": { "v": 0.1, "unit": "Gyr", "src": "placeholder", "tier": "inferred" } },
  "provenance": { "source": "static:hr23-clusters", "dataset": "hr23-clusters", "catalogue": "Hunt & Reffert 2023",
    "version": "J/A+A/673/A114", "citation": "Hunt & Reffert 2023, A&A 673, A114", "url": "https://cdsarc.cds.unistra.fr/" },
  "evidence": "measured",
  "render": { "mag": 1.6 }
}
```

**Black hole (Phase 2, hypothetical)**: measured placement, illustrative appearance. The Evidence view shows the
marker but not the lensing disc.
```json
{
  "id": "bh:Sgr A*", "kind": "black_hole", "name": "Sagittarius A*", "designations": ["Sgr A*"],
  "host": null, "parent": "gal:milky_way",
  "position": { "model": "fixed", "ra": 266.41684, "dec": -29.00781, "epoch": 2000.0, "method": "orbit-fit",
    "dist": { "v": 8178, "lo": 8165, "hi": 8191, "unit": "pc", "src": "placeholder (GRAVITY 2019, S2 orbit)", "tier": "measured" } },
  "size": { "radius": { "v": 1.2e7, "unit": "km", "src": "placeholder (Schwarzschild radius from mass)", "tier": "inferred" }, "angular": null },
  "props": { "mass": { "v": 4.15e6, "unit": "Msun", "src": "placeholder (GRAVITY 2019)", "tier": "measured" },
             "type": { "v": "supermassive", "src": "curated", "tier": "catalogue" } },
  "provenance": { "source": "static:bh-curated", "dataset": "bh-curated", "catalogue": "Space Maps curated black holes",
    "version": "1", "citation": "GRAVITY Collaboration 2019, A&A 625, L10", "url": null },
  "evidence": "measured",
  "render": { "style": "lensing" }
}
```

**Galaxy (Phase 3, hypothetical)**
```json
{
  "id": "ongc:NGC0224", "kind": "galaxy", "name": "Andromeda Galaxy", "designations": ["M31", "NGC 224", "UGC 454"],
  "host": null, "parent": null,
  "position": { "model": "fixed", "ra": 10.6847, "dec": 41.2690, "epoch": 2000.0, "method": "cepheid",
    "dist": { "v": 0.765, "lo": 0.745, "hi": 0.785, "unit": "Mpc", "src": "placeholder (NED-D median)", "tier": "measured" } },
  "size": { "radius": null,
            "angular": { "major": { "v": 3.17, "unit": "deg", "src": "placeholder (OpenNGC)", "tier": "catalogue" },
                         "minor": { "v": 1.0, "unit": "deg", "src": "placeholder", "tier": "catalogue" },
                         "pa": { "v": 35, "unit": "deg", "src": "placeholder", "tier": "catalogue" } } },
  "props": { "type": { "v": "SA(s)b", "src": "placeholder (OpenNGC)", "tier": "catalogue" } },
  "provenance": { "source": "static:ongc-galaxies", "dataset": "ongc-galaxies", "catalogue": "OpenNGC + NED-D",
    "version": "<pinned>", "citation": "Mattiazzi 2023 (OpenNGC); Steer et al. 2017 (NED-D)", "url": "https://github.com/mattiaverga/OpenNGC" },
  "evidence": "measured",
  "render": { "mag": 3.4 }
}
```
A redshift-only galaxy would carry `method: "redshift"`, `dist.tier: "inferred"` and `evidence: "derived"`.

## 11. Migration plan

The work is in slices with one owner each. `scene3d.js` has exactly one owner, slice C, and that slice starts only
after B lands.

| Slice | Owner | Files (exclusive) | Depends on |
|---|---|---|---|
| A. Backend | Sonnet | `backend/spherex_app/{objects,objects_live,objects_static}.py` (new), `scene3d.py`, `main.py` (routes), `config.py`, `backend/scripts/build_objects_fixture.py` (new), `backend/tests/test_objects*.py` (new), `test_scene3d.py`, `backend/tests/fixtures/objects/**`, `frontend/dev/mock_server.py` | this doc |
| B. Frontend core | Sonnet, in parallel with A | `frontend/js/blink/{scene3d-registry,scene3d-objects}.js` (new), `scene3d-frames.js`, `frontend/js/api.js` (`getObjects` only), `frontend/tests/{scene3d-registry,scene3d-objects}.test.mjs` (new), `scene3d-frames.test.mjs` (additions) | this doc |
| C. Renderer integration | Sonnet, after B | `frontend/js/blink/scene3d.js`, `scene3d-main.js`, `scene3d-card.js`, `frontend/scene3d.html`, `frontend/css/scene3d.css` | A's response shape (from this doc and the mock), B |
| D. Docs and review | me | `docs/technical-reference.md` (API summary, data build), README notes, this doc's status | A, B, C |

Commits, in logical steps:
1. This doc.
2. Backend objects framework (A).
3. Frontend registry, store and frames (B).
4. Renderer onto the registry, with solar markers and the layer panel (C).
5. Docs.

## 12. Test plan

**Backend** (`uv run pytest`, offline; SkyBoT and the ephemeris stubbed with `monkeypatch`, as now):

- **`test_objects_schema.py`**
  - Every example in §10 validates.
  - Mutations are rejected:
    - a missing id;
    - a bad namespace format;
    - an unknown position model;
    - `state` without a host;
    - evidence stronger than the position tier allows (each row of the §3 rule);
    - an `orbit` with an unknown phase that is not illustrative;
    - a Quantity with an unknown tier or unit.
  - Unknown extra fields are allowed.
- **`test_objects_live.py`**
  - 8 planets (Earth included) plus the Moon, with correct ids, hosts and parents and radii present.
  - `geo` agrees with `xyz − earth`.
  - Classification: `MB>Middle` → asteroid; `Comet` → comet; `C/2020 F3 (NEOWISE)` and `29P/…` → comet; `Centaur` → asteroid; number 1 → dwarf planet.
  - Ids `mp:1`, `mp:2019 YB21`, `comet:C/2020 F3`.
  - `bodies_xyz` behaviour is kept (moved test).
- **`test_objects_static.py`**
  - Tile of a point; tiles for cones at a pole, across RA 0/360 and at a band edge.
  - Every record inside a cone is found, cone and extent margin included.
  - The fixture dataset loads, and `kinds` filters it.
  - A corrupt manifest gives a source error, not a crash.
  - Rebuilding the fixture is byte-identical, and the tile `sha256` matches.
- **`test_objects_api.py`**
  - Response shape and `schema`; the `kinds` filter; 400s; `limit` and `truncated`; deterministic order; dedupe by precedence.
  - SkyBoT failure → its kinds `error`, planets still there, 200.
  - Ephemeris failure → planets `error`, SkyBoT still there.
  - A slow source hits a small timeout → `timed out`, the response returns promptly, and the shielded task still caches.
  - An invalid record is dropped and counted.
  - The static fixture is merged through `SPHEREX_OBJECTS_DIR`.
- **`test_scene3d.py`**
  - The shape test is updated to `{ra, dec, radius, stars}`.
  - The solar tests move to `test_objects_live.py`.
  - The star tests are unchanged.

**Frontend** (`node --test frontend/tests/*.test.mjs`):

- **`scene3d-registry.test.mjs`**
  - The Phase 0 kinds and layers are registered.
  - Each kind's layer exists.
  - Load and save with a stub storage that throws, holds bad JSON, or holds a partial map.
  - Card rows for a planet, an asteroid and a comet, each with tiers.
  - Evidence filtering of rows and records.
  - Unknown kinds are ignored.
- **`scene3d-objects.test.mjs`**
  - Ingest, and refusing an unknown schema major.
  - Galaxy-frame placement: from the origin, the direction equals `geo` (to 1e-9), and the Sun marker points at −Earth. From 1 pc away, every object is within 50 AU of the Sun.
  - Scope: planets and the Sun outside the cone are still markers. A small body with `in_cone: false` is not. Earth is never a marker.
  - System-frame placement equals `xyz_au`.
  - The in-cone filter for markers.
  - Group collapse threshold, with counts that respect layers and evidence.
  - Pick candidates honour priority: a planet beats a star beats an asteroid at the same pixel.
  - The label limit.
  - Every `planGo` branch (in-frame, solar-scene, chained via a host, star).
- **`scene3d-frames.test.mjs`**
  - The existing tests are unchanged.
  - Three-level table: round trips, hysteresis at each level, and `worldPc` precision across levels.

**By hand** (the mock server, then the live backend if reachable):
- Open a patch near the ecliptic. Stars look unchanged.
- Solar markers appear in the Stars scene before the Gaia stars finish. Labels are sensible, and the group marker appears when flying away.
- Picking, the card and "Show in the Solar system" work for each kind, and so do G and the autopilot.
- Layer toggles hide things, persist across a reload, and survive blocked storage.
- The Evidence view hides illustrative rows and the planet bands and atmosphere.
- The Solar system scene (pill, Tab, flying in) still works.
- "Watch this patch change" and the intro hand-off still work.
- The HUD counts and notes are right, including a forced SkyBoT failure.
- Frame time is checked in DevTools before and after on the same patch.

## 13. What Phase 1 will plug in (checklist)

- [ ] `backend/scripts/build_objects_nea.py` and `build_objects_hr23.py` (pinned sources), producing `frontend/data/objects/{nea-exoplanets,hr23-clusters}/`.
- [ ] Allow hosted static kinds in tiles (`position.host_radec`, §10 note).
- [ ] Map Exoplanet Archive hosts to `gdr3:` ids from the archive's Gaia DR3 cross-id column. Fall back to `hip:`, and for hosts missing from the star payload, send `star` records.
- [ ] `registerLayer` for `exoplanets` and `clusters`. `registerKind` for `exoplanet` (`frames: {system: 'sphere'|'point', galaxy: 'marker'}`, `go: 'host-frame'`) and `cluster` (`frames: {galaxy: 'billboard'}`).
- [ ] Implement the `billboard` renderer (the first kind to need it), plus client-side `orbit` evaluation.
- [ ] Derived-placement marker style (the hook already exists).
- [ ] Cards: list a host star's planets in its star card (via `parent`).

Follow-ups outside Phase 1:
- [ ] Evidence view: set `EVIDENCE_HIDES_FEATURES = true`, which hides planet bands, atmospheres and rings (all tagged illustrative in Phase 0).
- [ ] The README's `online` pytest marker is not implemented (no marker or skip logic exists).

## 14. Decisions made at approval (2026-11-18)

1. **Stars scene.** It shows the Sun, the Moon and all planets across the whole sky, as the XHIP context stars are. Asteroids, comets and dwarf planets appear only inside the clicked cone.
2. **`solar` is dropped from `/api/scene3d` outright.** The backend and frontend change in the same commit, and every test asserting the old shape is updated.
3. **Dwarf planets are their own kind and layer.** They are identified from the fixed list of asteroid numbers 1, 134340, 136199, 136108 and 136472, never from SkyBoT's class. They are cone-only for now.
4. **No visible Evidence-view change in Phase 0.** Planet bands, atmospheres and rings are tagged illustrative in the registry, so hiding them later is one line. This is noted as a follow-up.

**Commit consequence of 2.** Slice A adds `/api/objects` next to the unchanged `/api/scene3d`; `scene3d.py` imports the moved solar helpers from `objects_live.py`. The `solar` removal (`scene3d.py`, `main.py`, `test_scene3d.py`, and the mock's `/api/scene3d`) lands in the same commit as slice C's frontend switch.

## 15. Implementation notes (Phase 0)

These were settled while building Phase 0. Where they differ from the sections above, they take precedence.

- **Pick priority of markers.** In the Stars scene every small-body marker sits among the cone's Gaia stars, so "stars beat small bodies" would make them unpickable. Kind specs therefore take `pick.marker`, the priority while drawn as a galaxy-frame marker. Small bodies use 15, ahead of stars at 20. In the Solar system scene their priority stays 30, as before.
- **The Sun's marker.** It is selected as kind `sun` and positioned where the marker is drawn (the Sun as seen from Earth). It shows the star-0 card, and its button is "Show in the Solar system". In the Solar system scene the Sun is star 0 and is picked as a star, as before.
- **Earth** has no `position.geo` and is never `in_cone`. Its geocentric direction is undefined.
- **Precision.** Heliocentric positions are served to 1e-9 AU (`objects_live.XYZ_DP`). At the old 1e-6 AU the Moon's direction from Earth was off by up to an arcminute, because the Moon is only 0.0026 AU away.
- **Partial failure of a kind.** If one of two sources serving a kind fails, the kind stays `ok` and carries an `error` string naming the failed source. `count` counts the records kept after dedupe and `limit`.
- **Frame levels** carry a `hosted` flag. `system` levels are entered by distance to a host star; unhosted outer levels by distance from the Sun.
- **Not yet verified live:** the exact SkyBoT `Class` string for comets. The classifier also accepts comet designations in the name, so either form works.
