# Object framework for the 3D view (Phase 0)

Status: **approved 2026-11-18** (with the decisions in §14). Phase 0 is implemented; see §15 for what changed during implementation. **Phase 1 (exoplanets, clusters) is designed in §16, approved 2026-11-18 (decisions in §16.18).**

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

> **Phase 1 change (§16.3, §16.5, §16.6):** an `orbit` position may carry `host_radec` (the host's direction, used for
> tiling and the cone test) and the element `t_conj_mjd`. An orbit whose `i_deg` or `node_deg` is `null` is
> `illustrative` too, not only one with an unknown phase. The client evaluates it at the payload's `query.mjd`.

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
| `neahost` | NASA Exoplanet Archive `hostname`, for hosts with no Gaia or Hipparcos id (**Phase 1 change**, §16.4) | 1 | `neahost:OGLE-2005-BLG-390L` |

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

> **Phase 1 change (§16.4, §16.7):** exoplanet `props` are `mass` | `msini`, `disc_method`, `disc_year`,
> `disc_facility` and `controversial`. Period and semi-major axis live in `position.elements` and the radius in
> `size.radius`. The server sends a `star` record for **every** host in the cone, because it cannot know what the star
> payload holds. The client uses one only when the star is missing, and matches through the new `same_as` field.

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

- **Validator rule.** The record's evidence may not be stronger than its position allows. A position tier of `measured` or `catalogue` allows at most `measured`, `inferred` allows at most `derived`, and `illustrative` allows only `illustrative`. For `fixed` positions the governing tier is `dist.tier`. For `orbit` positions with `phase_known: false` the record must be `illustrative`. **Phase 1 change (§16.5):** orbits with an unknown inclination or node, or with an `illustrative` element, must be `illustrative`, and `method: assumed` caps a `fixed` distance at `illustrative`. The backend rejects records that break the rule: the record is dropped, counted and logged, and the request does not fail. The rule is also tested.
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

Tile records must use `fixed` positions and `host: null`, and must pass `validate_record`. **Phase 1 change (§16.3):** records of a hosted kind (`exoplanet`) may instead use an `orbit` position with a `host` and `position.host_radec`, and are tiled by that direction.

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

> **Phase 1 change (§16.7, §16.10):** `frames[frame]` may be a function `(o) → renderer`. `billboard` is implemented
> for clusters. Galaxy-frame markers honour `markerStyle` (hollow for derived records). Specs gain `hosted`.

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
- The group is generic over `host`. Phase 1 exoplanet systems get it for free ("Kepler-90 · 8 planets"). **Phase 1 change (§16.8):** a non-Sun host groups from one visible record, its label names the kind ("TRAPPIST-1 · 7 exoplanets"), and picking it selects the host star, whose card lists the planets.

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

Phase 1's design and status are in §16; the boxes below are ticked when it lands.

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

## 16. Phase 1: exoplanets and star clusters (design)

Status: **approved 2026-11-18** with the decisions in §16.18, which take precedence over the text above them. Phase 0 sections that Phase 1 changes carry a "Phase 1 change"
note pointing here. Where this section and an earlier one disagree, this one wins.

Facts below about the NASA Exoplanet Archive and Gaia were checked against the live services on 2026-11-18. **CDS
(VizieR, cdsarc, TAPVizieR and every mirror tried) was down all day** ("Page unavailable — CDS"; the CfA mirror
reports "database is not currently reachable"). The Hunt & Reffert column names, counts and sizes in §16.9 are
therefore **unverified, from the papers as I remember them**. They are marked ⚠ and get checked against the ReadMe
before the cluster build script is written. The build script also checks them itself and fails loudly on a mismatch.

### 16.1 Decisions at a glance

| Question | Decision |
|---|---|
| Exoplanet source | NASA Exoplanet Archive `pscomppars` (6,470 planets, 4,862 hosts on 2026-11-18). TAP has no dated snapshots, so the **committed, gzipped CSV snapshot is the pin** (§16.2). |
| Host ids | `gaia_dr3_id` (4,491 of 4,862 hosts, 92.4 %), then `gaia_dr2_id` → DR3 through `gaiadr3.dr2_neighbourhood` (26 of 28), then `hip:` (14), then a Gaia DR3 positional match (non-microlensing hosts only), then a new `neahost:<hostname>` id. Details and rates in §16.4. |
| Tiles | Hosted kinds (`exoplanet`) may be stored in tiles as `orbit` positions with `position.host_radec`. Tiling, cone filtering and `in_cone` use that direction (§16.3). |
| Positions | `orbit` model evaluated **once per payload, at the payload's `query.mjd` (TDB)**, the same instant as the solar system. No animation in Phase 1. The Kepler solver and sky-plane convention are in §16.6. |
| Unknown orientation | The archive has no node (Ω) column, so **every exoplanet's drawn placement is `illustrative`**. Unknown Ω, i, ω and phase come from a documented per-id hash, and the card labels them as assumed. |
| Mass and radius | `pl_bmassprov`: `Mass` → `mass` (measured); `Msini` → `msini`, **never `mass`**; `M-R relationship` → `mass` with tier `inferred`. A radius whose reflink is `Calculated Value` (1,544 rows) has tier `inferred`. |
| Host stars | The `nea-exoplanets` dataset also holds one `star` record per host. The client uses one only when the star payload lacks that star (or an alias of it), and then adds it as a real star, so it can be picked, used as a frame host and flown to. |
| Cluster source | Hunt & Reffert. Version: **HR24 (`J/A+A/686/A42`) if it re-releases all HR23 clusters with the same names plus masses, Jacobi radii and the bound/unbound `kind`; otherwise HR23 (`J/A+A/673/A114`)**. This depends on CDS (question Q1). Ids stay `hr23:<name>` either way. |
| Billboard | A camera-facing quad with a Plummer-profile glow sized by `r50` (illustrative look). In the Evidence view it becomes a centre marker plus an `r50` outline ring, both measured placement. |
| Member highlight (stretch) | **Deferred as a follow-up** (§16.12): the members table is about 1.3 M rows ⚠, far over the size budget. |
| Hollow (derived) marker | **Implemented.** Clusters whose parallax distance is prior-dominated (parallax S/N < 5) get `evidence: derived` and use it (§16.9). |
| Truncation UI | Per-kind `truncated` reaches the HUD counts and the warning line, e.g. "2,000 brightest small bodies (more in this cone)" (§16.11). |

### 16.2 Build scripts, pins and reproducibility

Both scripts follow `build_objects_fixture.py`: `ROOT/"frontend"/"data"/"objects"/<dataset>`, `httpx` with timeouts,
usage in the docstring, `objects_static.write_dataset()` for tiling, hashing and validation, and `--check`.

**Source snapshots are committed** under `backend/data/sources/<dataset>/` (§16.18 D3), written with `gzip -n` semantics
(no name or mtime, so the bytes are deterministic). A rebuild needs no network, and `--check` is a true byte-for-byte
test. This matters more than usual today, with both CDS and the ESA Gaia archive down.

| | `build_objects_nea.py` | `build_objects_hr23.py` |
|---|---|---|
| Source | `https://exoplanetarchive.ipac.caltech.edu/TAP/sync`, `select <fixed column list> from pscomppars order by pl_name`, CSV | the CDS clusters table of the pinned catalogue (`.dat` + ReadMe byte-by-byte) ⚠ |
| Pin | `pscomppars-2026-11-18.csv.gz` (expected ~1.3 MB; the 40-column raw CSV is 11.6 MB and 1.25 MB gzipped, the HTML reflinks being most of it). The query text, retrieval date and sha256 of the uncompressed CSV go in `manifest.provenance`. | VizieR id + sha256 of the `.dat` file. The ReadMe is checked by sha256 too, and the extracted columns are committed as `clusters.csv.gz` (expected < 1 MB ⚠). |
| Side inputs (also committed) | `gaia-dr2-dr3.csv` (DR2→DR3 for DR2-only hosts) and `gaia-positional.csv` (positional fallback), both from Gaia TAP. ESA `gea.esac.esa.int` is tried first, then ARI `gaia.ari.uni-heidelberg.de/tap` (the same mirror order the star pipeline uses). | none |
| Default run | builds from the committed snapshot | builds from the committed snapshot |
| `--refresh` | downloads a new snapshot (today's date in the file name) and the side inputs, then builds | downloads the pinned file, verifies its sha256, re-extracts, then builds |
| `--local FILE` | build from a given CSV | build from a given `.dat` |
| `--check` | rebuild into a temp dir and byte-compare with the committed dataset; exit 1 on a difference. It also runs `verify_dataset` (tile hashes, counts, validity, tile placement). | same |
| Report | prints and writes into `manifest.build.report`: rows read, records written, rows excluded by reason, host match rates per ladder step | rows read, written, excluded, and counts per type and per evidence |

Pins are refreshed only by an explicit `--refresh` run in a commit of its own, so data changes are reviewable.

### 16.3 Hosted records in tiles (changes §6)

- `objects.HOSTED_KINDS = ("exoplanet",)`. This is the backend mirror of the registry's `hosted: true`.
- An `orbit` position may carry `host_radec: [ra, dec]` (degrees, ICRS): the host's direction from the geocentre.
  - It is optional in the schema.
  - It is required for tile records.
  - The validator checks ranges as for `fixed`.
- `objects.sky_position()` returns `host_radec` for `orbit` positions. So `cone_contains`, the merge's cone filter and
  `in_cone` treat an exoplanet as sitting on its host: cone-only, like Gaia stars.
- `write_dataset()` accepts either kind of record:
  - a `fixed` position with `host: null` (as before); or
  - a kind in `HOSTED_KINDS` with an `orbit` position, a non-null `host` and `host_radec`.
- Tiles are chosen by `sky_position()`, and `verify_dataset()`'s wrong-tile check uses the same function.
- Hosted kinds have no angular extent, so `max_extent_deg` is unaffected.

### 16.4 Exoplanet records (`nea-exoplanets`, kinds `exoplanet` and `star`)

**Exclusions:**
- 7 planets with neither period nor semi-major axis.
- Planets of hosts with neither `ra`/`dec` (none today) nor any id.

Both are counted in the build report.

**Host id ladder** (one id per `hostname`; no host has inconsistent ids across its planets):

| Step | Rule | Hosts (2026-11-18) |
|---|---|---|
| 1 | `gaia_dr3_id` present (strip `"Gaia DR3 "`) → `gdr3:<id>` | 4,491 (92.4 %) |
| 2 | only `gaia_dr2_id` → `gaiadr3.dr2_neighbourhood`, the closest neighbour within 100 mas with \|ΔG\| ≤ 1 mag (Torra et al. 2021). Note: DR2 and DR3 ids differ for 13 of these 28, and also for Proxima Cen, so a DR2 id is never reused as DR3. | 26 of 28 (787 mas and 126 mas rejected; those go on down the ladder) |
| 3 | `hip_name` → `hip:<n>`. The scene's bright context stars are keyed `hip:`. | 14 |
| 4 | positional: a Gaia DR3 source within 1.5″ of the archive position, with \|G − `sy_gaiamag`\| ≤ 0.5 when known, unique within 1.5″. **Skipped for microlensing hosts**, whose lenses Gaia does not see (a match would be the blended source star). | ≤ 47 (the non-microlensing coordinate-only hosts) |
| 5 | `neahost:<hostname>` (new namespace) | ~282 microlensing + leftovers |

Steps 2–5 are expected to bring the share of hosts with a Gaia id to about 93 %. The real numbers come from the build
report.

**Exoplanet record fields:**

| Field | From | Tier / rule |
|---|---|---|
| `id`, `name` | `nea:<pl_name>`, `pl_name` | |
| `designations` | `<hd_name> <pl_letter>`, `<hip_name> <pl_letter>`, when they differ from the name | |
| `host`, `parent` | the host id from the ladder | |
| `position.model` | `orbit`, with `host_radec` = the archive `ra`, `dec` | |
| `elements.period_d` | `pl_orbper`, with `lo`/`hi` from err1/err2 | `measured`. If missing (356 rows), from `a` and `st_mass` by Kepler III (342 rows): `inferred`, src "derived from a and M★ (Kepler III)". |
| `elements.a_au` | `pl_orbsmax` (± errs) | `catalogue` (usually the authors' own Kepler III). If missing (498), from P and `st_mass` (490 rows): `inferred`. With no `st_mass` (1 row), M★ = 1 M☉ is assumed: `illustrative`. |
| `elements.e` | `pl_orbeccen` (± errs) | `measured`. If missing (1,070), `v: 0`, `illustrative`, src "assumed circular (no eccentricity in the archive)". |
| `elements.i_deg` | `pl_orbincl` (± errs) | `measured`; `null` when missing |
| `elements.omega_deg` | `pl_orblper` | `measured`; `null` when missing |
| `elements.t_peri_mjd` | `pl_orbtper − 2400000.5` | `measured`; `null` when missing |
| `elements.t_conj_mjd` (**new optional element**) | `pl_tranmid − 2400000.5`: the time of inferior conjunction, which is the transit mid-time for transiting planets (51 Peg b has one without transiting) | `measured` (± err) |
| `elements.node_deg` | always `null`: the archive has no Ω | |
| `phase_known` | `true` when `t_conj_mjd` or `t_peri_mjd` is present (5,884 of 6,470) | |
| `position.tier`, `evidence` | `illustrative` for every record, because Ω is unknown (validator rule, §16.5) | |
| `size.radius` | `pl_rade` (± errs), unit `Rearth` | `measured`. If `pl_rade_reflink` is `Calculated Value`, `inferred`, src "archive-calculated from mass (Chen & Kipping 2017)". Limits (`pl_radelim ≠ 0`, 5 rows) and missing values (50) → `null`. |
| `props.mass` | `pl_bmassj` (± errs), unit `Mjup`, when `pl_bmassprov` is `Mass` or `Msin(i)/sin(i)` | `measured` / `catalogue` |
| `props.mass` | the same, when `pl_bmassprov` is `M-R relationship` (calculated reflink) | `inferred`, src "archive-calculated from radius (Chen & Kipping 2017)" |
| `props.msini` | `pl_bmassj` when `pl_bmassprov` is `Msini` | `measured`; shown as "Minimum mass (M sin i)", never as mass |
| `props.disc_method`, `disc_year`, `disc_facility` | as named | `catalogue` |
| `props.controversial` | `pl_controv_flag = 1` (58 planets) → `v: "yes"` | `catalogue`. The card adds a note. |
| `render.mag` | `sy_vmag` of the host | used for the per-kind limit order ("brightest" = brightest hosts) |
| `provenance` | compact in tiles: `{source, dataset, catalogue, version}`. The full citation, acknowledgement and query are in the manifest and in `/api/objects` `sources[].provenance`. | |

Quantity `src` strings are `"NEA pscomppars: <reference>"`, where the reference is the reflink's link text with HTML
entities decoded (for example `NEA pscomppars: Agol et al. 2021`).

**Change to §2.5:** `period`, `a` and `radius` live only in `position.elements` and `size.radius`, never duplicated
in `props`. `msini`, `disc_facility` and `controversial` are added.

**Host `star` records** (one per host; `kind: "star"`):
- `fixed` at the archive `ra`/`dec`, with `dist` = `sy_dist` (± errs).
- The distance method and tier depend on where the distance came from:

  | Case | `method` | Tier |
  |---|---|---|
  | a parallax is given (`sy_plx`) | `parallax` | `measured` |
  | a microlensing host without a parallax | `lens-model` (**new method**) | `inferred` → evidence `derived` |
  | otherwise | `assumed` | `illustrative` |

- `props`: `teff`, `radius` (Rsun), `mass` (Msun), `spectral_type`, `vmag`, `gmag`, `n_planets` (`sy_pnum`), all with
  their reflinks as `src`.
- **`same_as`** (a **new optional record field**, a list of ids): the host's other ids, such as `hip:113357` for
  51 Peg.
- `render.mag` is `sy_vmag`.
- Star records are cone-filtered by their own position, like everything else.

**Size.** Estimated at ~8.5 MB for the exoplanet records plus ~1.5 MB for the stars, so **~10 MB on disk and ~0.8 MB
compressed in git**. That is at the ~10 MB line, so see question Q2. If it must be smaller, the levers are:
- drop the `lo`/`hi` intervals on `a`, `e` and `i` (about −15 %);
- shorten quantity `src` to the reference id (about −10 %).

### 16.5 Schema and validator changes (changes §2.2–§2.4, §3)

All of these are additive, so the schema stays at version 1.

**Additions:**
- `position.host_radec` (orbit positions).
- `elements.t_conj_mjd`.
- The record field `same_as` (a list of ids).
- The namespace `neahost`.
- The method `lens-model`.
- Validator: `star` records and `same_as` ids are validated like `host`.

**New evidence rules** (also tested):
1. An `orbit` position whose `i_deg` or `node_deg` is `null`, or whose `phase_known` is false, must have
   `position.tier: illustrative`. The record is then `illustrative` through the existing tier cap. An orbit is
   placed in 3D only when its orientation and phase are both known.
2. An `orbit` element with tier `illustrative` (assumed e, a from an assumed M★) forces `position.tier: illustrative`.
3. `method: assumed` on a `fixed` position forces `dist.tier: illustrative`.

The backend rejects records that break these rules, and the build scripts refuse to write them.

### 16.6 Client-side orbit evaluation (`frontend/js/blink/scene3d-orbits.js`, new, pure)

- **Time base.** `t` = the objects payload's `query.mjd` (TDB), the instant the solar system is drawn at.
  - The archive epochs are BJD_TDB; minutes of difference are irrelevant here.
  - Placement is computed once per ingest and again when host positions change (§16.7).
- **Kepler solver.**
  - Mean anomaly `M = n (t − t_peri)`, with `n = 2π / P`.
  - Solve `E − e sin E = M` by Newton's method, starting from `E₀ = M + e sin M` (or `π` when `e > 0.8`), until
    `|ΔE| < 1e-12`, at most 50 iterations.
  - `e` is clamped to [0, 0.99].
  - Then `ν = 2 atan2(√(1+e) sin(E/2), √(1−e) cos(E/2))` and `r = a (1 − e cos E)`.
- **Sky-plane basis at the host** (from `host_radec`):
  - `û` is the unit vector from Earth to the host.
  - `N̂` (north) = `(−sin δ cos α, −sin δ sin α, cos δ)`; `Ê` (east) = `(−sin α, cos α, 0)`; `Ẑ = −û` (toward the observer).
  - With `u = ω + ν`:
    - `X_N = r (cos Ω cos u − sin Ω sin u cos i)`
    - `Y_E = r (sin Ω cos u + cos Ω sin u cos i)`
    - `Z = r sin u sin i`
  - ICRS `xyz_au = X_N N̂ + Y_E Ê + Z Ẑ`.
  - With this convention inferior conjunction (transit) is at `u = 90°`. The planet is then between its star and Earth,
    which a test checks.
- **Phase.**
  - With `t_conj_mjd` (preferred: recent and precise), `ν_c = 90° − ω` → `E_c` → `M_c`, and `t_peri = t_conj − M_c / n`.
  - Otherwise `t_peri_mjd` is used directly.
  - Otherwise the mean anomaly at MJD 51544.5 (J2000) is assumed.
  - The phase uncertainty at `t`, `σ_M = 360° · |t − T₀| · σ_P / P²`, is reported. Above 90° the card says the phase is
    "effectively unknown at this date".
- **Assumed values (illustrative, deterministic per id).**
  - `h(id, salt)` is FNV-1a 32-bit over the UTF-8 bytes of `id + "#" + salt`, divided by 2³². It is documented with
    test vectors.
  - `Ω = 360° · h(id, "node")`, always (no archive value).
  - `i` when unknown: 90° if the planet transits (`disc_method` Transit or `t_conj_mjd` present); otherwise
    `acos(h(id, "incl"))`, an isotropic prograde draw.
  - `ω` when unknown and `e > 0`: `360° · h(id, "omega")`; with `e = 0`, 0.
  - `M₀` when the phase is unknown: `360° · h(id, "phase")` at J2000.
- **API.**
  - `orbitPlacement(rec, mjd) → { xyzAu, assumed: { node, incl, omega, phase, ecc }, phaseSigmaDeg }`
  - `orbitPath(rec, n = 180) → [[x, y, z]…]`, in AU relative to the host, with the same orientation.
  - Cards read `assumed` to label rows.
- **Why not store the assumed values in the tiles?** The tiles then hold only catalogue values, with `null` meaning
  unknown. The assumption is one documented client rule, and the 2D rewind (or any other client) can reproduce it from
  the test vectors.

### 16.7 Frontend: store, host resolution and kinds

**`scene3d-objects.js` (store):**
- `ingest` keeps `star` records in `store.stars` (id → record) instead of skipping them. They are not drawn by the store.
- `_placeRecord` gains an `orbit` branch: `sysAu = orbitPlacement(o, query.mjd).xyzAu`, and `galPc = hostPc + sysAu / AU_PER_PC`.
- `setHostResolver({ key(hostId) → starKey | null, pc(starKey) → [x, y, z] | null })` re-places hosted non-Sun
  records. Entries carry `host` = the **resolved star key**, so `inHost`, `groupState`, `planGo` and the frame host
  all compare against the key the star renderer uses.
- `childrenOf(starKey) → records` whose resolved `parent` is that star. This ignores layers and evidence, because
  existence is measured.

**`scene3d.js` `_rebuildStars`:**
- After the Gaia rows and context stars, it appends each `star` record whose id and `same_as` ids are all absent from
  the loaded keys. Each appended star gets:
  - `meta.kind: 'obj'` and key = its record id;
  - position `radecToXyz(ra, dec, dist)`;
  - absolute magnitude from `gmag` (else `vmag`) and the distance;
  - colour from `teff` (illustrative), defaulting to a Sun-like BP−RP.
- Star records without a distance are not appended. Their planets cannot be placed, but they still appear in cards.
- It then builds the alias map (record id or `same_as` → loaded key) and calls `store.setHostResolver`.
- `setObjects` reruns this when the set of star records changes.
- `_starIdx` becomes a `Map` lookup: it is now called per hosted record, which with ~20k stars would be a linear scan
  each time.
- Appended stars with a `gdr3:` id still fetch `/api/system/<id>` for their card.

**Registry:**
- `frames[frame]` may be a function `(o) → renderer` (**change to §7.1**), so that an exoplanet with a radius is a
  `sphere` and one without is a `point`. `rendererOf(spec, frame, o)` resolves it.
- `registerLayer({ id: 'exoplanets', label: 'Exoplanets', group: 'beyond' })` and
  `{ id: 'clusters', label: 'Star clusters', group: 'beyond' }`. The panel gains the group "Beyond the Solar system".
  Persistence is unchanged: the same `blink.scene3d.layers` map, defaults on.
- **`exoplanet`** spec:

  | Field | Value |
  |---|---|
  | `layer` | `exoplanets` |
  | `noun` | `exoplanet(s)` |
  | `hosted` | `true` |
  | `frames` | `{ system: (o) => (radius ? 'sphere' : 'point'), galaxy: 'marker' }` |
  | `galaxyScope` | `'cone'` |
  | `pick` | `{ priority: 10, marker: 15 }` |
  | `label` | `{ key: () => 20, max: 12, hideOverDiscPx: 30 }` |
  | `arriveAu` | the radius |
  | `collide` | `true` |
  | `sphere` | colour by radius class, no features, no pole (all illustrative) |
  | `card` | below |

- **`cluster`** spec:

  | Field | Value |
  |---|---|
  | `layer` | `clusters` |
  | `noun` | `star cluster(s)` |
  | `frames` | `{ galaxy: 'billboard' }` |
  | `galaxyScope` | `'cone'` (centre plus extent, via the server's `cone_contains`) |
  | `pick` | `{ priority: 25, marker: 16 }`, and only within `PICK_PX` of the centre: the glow never steals clicks from member stars |
  | `label` | key by member count, max 12 |
  | `go` | a galaxy-frame trip stopping at 2 × `r50` from the centre (`fly-galaxy`, already a `planGo` branch, now implemented) |

**Exoplanet card** (tiers on every row; illustrative rows drop in the Evidence view as now):
- Host.
- Orbital period.
- Semi-major axis.
- Eccentricity, or "0 (assumed)".
- Inclination, or "unknown · drawn at 63°".
- Mass, "Minimum mass (M sin i)", or "Mass (from radius, Chen & Kipping 2017)".
- Radius, or "Radius (from mass, …)".
- Discovered: method, year, facility.
- From its star now (illustrative).
- From you.
- Notes:
  - "Where it is drawn on its orbit is illustrative: the orbit's orientation on the sky is not known."
  - The phase source, for example "phase from the 2020 transit time, ±3° today".
  - The controversial flag, when set.

### 16.8 Frames, rendering and cards for non-Sun hosts

These are the fixes from the inventory (file:line as of `27a7518`):

| Site | Today | Phase 1 |
|---|---|---|
| `scene3d.js:965,995,998` `_draw` gates orbits, cone and points on `_inSun()` | non-Sun frames draw only the host and stars | points and orbit lines come from per-host buffers for the camera's current host; the cone lines stay Sun-only |
| `scene3d.js:245` `_rebuildPoints` uses `inHost: h === ss:sun` | | rebuilt for `cam.host.key`, and also on frame change |
| `scene3d.js:221-228` orbit circles from every `planet` | latent bug (any non-Sun `planet` would orbit the Sun) | Sun circles only from Sun-hosted planets. For another host, `lineSys` holds the exoplanet ellipses from `orbitPath`. These need both the `orbits` and `exoplanets` layers on, and they are hidden in the Evidence view, since the orientation is illustrative. |
| `scene3d.js:92` `new ObjectStore()` with no `hostPc` | non-Sun `galPc` is always null | `setHostResolver` (§16.7) |
| `objects.js` `groupState` needs ≥ 2 records | | for non-Sun hosts ≥ 1, so a one-planet system still gets "51 Peg · 1 exoplanet" |
| group pick for a non-Sun host | would open a group card | selects the **host star** instead, whose card lists the planets, so the star stays pickable under its own label |
| group label | "Name · 14" | "TRAPPIST-1 · 7 exoplanets" when all of a group's records are one kind; the Sun keeps "Solar system · 14" |
| `scene3d.js:642` via-host with an unloaded host | silently does nothing | resolved key; if still missing, the card's Go button is disabled with "host star not in this view" |
| `registry.js:123` `sunDistAu` | needs `host === ss:sun` | exoplanet cards use "From its star", computed from `sysAu` |
| HUD in a non-Sun system | Gaia counts | "Near TRAPPIST-1 · 7 exoplanets (positions illustrative)" via a `hostCountText` helper |
| `get scene` | `'solar'` only in the Sun's frame | unchanged (the Solar system pill stays Sun-only) |

**Host star card.** `renderStarCard` gains `children: { title: 'Exoplanets', items: [{ name, line, tier, onGo | null }], total, hiddenNote }`:
- The list shows every record from `store.childrenOf(starKey)`, whatever the evidence or layer state.
- Each line is short, for example "1.51 d · 1.12 R⊕ · 1.37 M⊕" or "4.23 d · 0.47 Mj min".
- Each item has "Go there", which runs the existing `via-host` plan.
- In the Evidence view, or with the layer off, the items stay listed with no Go button, and the note says why. For
  example: "Their positions on their orbits are illustrative, so the Evidence view hides them". This is the §3
  group-marker rule: "3 exoplanets" is still counted.
- The title of an unnamed Gaia star becomes the archive host name ("TRAPPIST-1"). For appended (`obj`) stars, the
  card's physical rows come from the star record's props (archive values, with their reflinks as `src`).
- Gaia stars keep their Gaia/Apsis rows. The two are not mixed.

**Autopilot.** From the Stars scene, Go on a planet is `via-host`:
1. a star trip to the resolved host;
2. arrival in the host's system frame;
3. `_arrived` starts the AU trip (implemented in Phase 0).

Planets are spheres when they have a radius, with the host as the light source (`_drawBody` already lights from the
frame origin).

### 16.9 Star clusters (`hr23-clusters`, kind `cluster`) ⚠

**Version.** HR24 (Hunt & Reffert 2024, A&A 686, A42, "Improving the open cluster census. III") re-analyses the HR23
clusters with Jacobi radii and masses and classifies each as a bound open cluster or a moving group. If its ReadMe
confirms all 7,167 objects with the same names and the HR23 positions, distances and ages, HR24 is the better pin:
- the bound/unbound `kind` is exactly what the card should say;
- the masses are worth showing.

Otherwise HR23 is pinned as the checklist says. **This is Q1, and it needs CDS to come back.**

**Fields** (column names to be verified ⚠):

| Field | From | Tier / rule |
|---|---|---|
| `id` / `name` | `hr23:<Name>` (e.g. `hr23:Melotte_22`). The name is shown with `_` → space. Famous clusters get a common name from a small curated map in the build script (Pleiades, Hyades, Praesepe, …; src "curated common name"). | |
| `designations` | the catalogue's cross-match names | |
| `position` | `fixed`, `RAdeg`/`DEdeg` (ICRS, epoch 2016), `epoch: 2016.0`, `method: "cluster-parallax"`, `dist` = `dist50` with `lo` `dist16`, `hi` `dist84` (pc) | `measured` when the cluster's mean parallax has S/N ≥ 5. Otherwise the distance is prior-dominated: `inferred` → **evidence `derived`, hollow marker**. |
| `size.radius` | `r50` in pc | `catalogue` |
| `size.angular.major` | 2 × the total radius in degrees, so that the cone query and `in_cone` include the cluster's extent (`max_extent_deg` follows) | `catalogue` |
| `props.n_members` | the number of members | `catalogue` |
| `props.age` | `10^logAge50` in Gyr (16/84 → lo/hi) | `inferred` (CMD neural-network fit) |
| `props.extinction` | `AV50` (16/84) | `inferred` |
| `props.type` | open / globular / moving group | `catalogue` |
| `props.reliable` | the paper's own quality cut (CST and CMD class) | `catalogue` |
| `props.mass`, `props.bound` | HR24 only | `inferred` / `catalogue` |
| `render` | `{}`. Clusters have no integrated magnitude, so labels rank by `n_members`. | |

All clusters are kept, candidates included. Unreliable ones are drawn at half glow and say so on their card.

### 16.10 The `billboard` renderer

- **Data.** `billboardItems(visible, cam, { evidence, pxPerRad }) → [{ rel, radiusUnits, rgb, alpha, mode, pxRadius }]`
  is pure and tested, and lives in `scene3d-objects.js`.
  - Positions are camera-relative in doubles, then cast to float32, as with markers.
  - The radius is `r50` converted to frame units.
- **GL** (`scene3d.js` + `scene3d-shaders.js`).
  - One new program. Each visible cluster is a camera-facing quad of half-size 4 × `r50`, built on the CPU each frame
    (a cone has tens of clusters, not thousands).
  - Additive blending, no depth write, drawn after the Milky Way and before stars.
- **Normal view** (`mode: glow`, illustrative look).
  - The surface brightness is a Plummer profile `(1 + (ρ/r50)²)⁻²` times `alpha`.
  - `alpha` comes from `log10(n_members)`, halved for unreliable clusters.
  - The colour comes from age: blue under 30 Myr, white around 300 Myr, warm over 1 Gyr. This is illustrative.
  - Fades:
    - `smoothstep(0.5, 2)` in camera distance / `r50`, so there is no pop entering a member star's system frame, where
      clusters are not drawn;
    - out when the projected `r50` is under 2 px, where only the marker shows.
  - A small centre marker is always drawn (pick and label anchor).
- **Evidence view** (`mode: outline`).
  - No glow.
  - A 1.5 px ring at `r50` (antialiased with `fwidth`), plus the centre marker.
  - Both are measured placement: catalogue centre, distance and `r50`.
  - Derived clusters draw a hollow centre marker and a dashed ring.
- **Hollow marker.** `_markerData` passes `markerStyle(o)` into the point shader's existing size/alpha attributes as a
  ring mask (`gl_PointCoord` radius test). That is the §7.1 hook, which galaxy-frame markers of any kind now honour.

### 16.11 Truncation UI (Phase 0 carry-over)

`scene3d-objects.js` gains pure helpers.

**`countPhrase(kinds, counts, kindStatus)`:**
- It gives "2,000 brightest small bodies (more in this cone)" when any of the kinds is `truncated`, and
  "23 small bodies" otherwise.
- `solarCountText` uses it for the small-body group. `hostCountText` and the galaxy-frame HUD use it for exoplanets
  and clusters.
- For exoplanets the wording is "2,000 exoplanets of the brightest hosts (more in this cone)".

**`capNotes(kindStatus)`:**
- One sentence per capped kind group, in the style of the Gaia sentence: "Showing the 2,000 brightest small bodies in
  the cone; fainter ones are left out."
- `#warn` moves out of the `data-only="stars"` wrapper. It joins the Gaia parts (Stars scene only) with these (both
  scenes).
- Both loaders refresh it.

Tests: helper unit tests, plus a backend test that `truncated` is set per kind (it exists already).

### 16.12 Stretch goal: member-star highlight → follow-up

- HR23's members table is about 1.3 M Gaia DR3 sources ⚠.
- Even reduced to `source_id` + cluster index, that is about 10–13 MB binary (more as JSON), over the size budget for
  one dataset.
- A per-cone live VizieR query would make the feature depend on CDS. That CDS was down all day while I wrote this is
  the argument against.
- The lookup itself is cheap: a `Set` of the cone's ~20k payload ids, checked against the cone's members.

Recorded as a follow-up with two viable designs:
- (a) a per-cluster member tile in the cluster dataset, only for clusters within ~500 pc (expected < 1 MB ⚠);
- (b) a backend `/api/objects` side table, queried only for clusters in the cone.

### 16.13 Example records (from real rows of the 2026-11-18 snapshot)

These replace `examples/exoplanet.json` and add `examples/star_host.json`. The build script's output for these ids
must equal them (a test), so the doc cannot drift from the data. The cluster example stays hypothetical until CDS is
reachable. It is then replaced by the real Melotte_22 row, and the same test covers it.

**TRAPPIST-1 b** (transiting; mass and radius measured; Ω unknown → illustrative):
```json
{
  "id": "nea:TRAPPIST-1 b", "kind": "exoplanet", "name": "TRAPPIST-1 b", "designations": [],
  "host": "gdr3:2635476908753563008", "parent": "gdr3:2635476908753563008",
  "position": { "model": "orbit", "host_radec": [346.6263919, -5.0434618], "phase_known": true, "tier": "illustrative",
    "src": "NASA Exoplanet Archive pscomppars; orientation on the sky (node) unknown",
    "elements": {
      "period_d":    { "v": 1.510826, "lo": 1.51082, "hi": 1.510832, "unit": "d", "src": "NEA pscomppars: Agol et al. 2021", "tier": "measured" },
      "a_au":        { "v": 0.01154, "lo": 0.01144, "hi": 0.01164, "unit": "au", "src": "NEA pscomppars: Agol et al. 2021", "tier": "catalogue" },
      "e":           { "v": 0.00622, "lo": 0.00318, "hi": 0.00926, "src": "NEA pscomppars: Grimm et al. 2018", "tier": "measured" },
      "i_deg":       { "v": 89.728, "lo": 89.563, "hi": 89.893, "unit": "deg", "src": "NEA pscomppars: Agol et al. 2021", "tier": "measured" },
      "omega_deg":   { "v": 336.86, "unit": "deg", "src": "NEA pscomppars: Grimm et al. 2018", "tier": "measured" },
      "t_conj_mjd":  { "v": 57322.014193, "lo": 57322.01419, "hi": 57322.014196, "src": "NEA pscomppars: Ducrot et al. 2020", "tier": "measured" },
      "t_peri_mjd": null, "node_deg": null } },
  "size": { "radius": { "v": 1.116, "lo": 1.104, "hi": 1.13, "unit": "Rearth", "src": "NEA pscomppars: Agol et al. 2021", "tier": "measured" }, "angular": null },
  "props": {
    "mass":          { "v": 0.00432309, "lo": 0.00410599, "hi": 0.00454019, "unit": "Mjup", "src": "NEA pscomppars: Agol et al. 2021", "tier": "measured" },
    "disc_method":   { "v": "Transit", "src": "NEA pscomppars", "tier": "catalogue" },
    "disc_year":     { "v": 2016, "src": "NEA pscomppars", "tier": "catalogue" },
    "disc_facility": { "v": "La Silla Observatory", "src": "NEA pscomppars", "tier": "catalogue" }
  },
  "provenance": { "source": "static:nea-exoplanets", "dataset": "nea-exoplanets", "catalogue": "NASA Exoplanet Archive pscomppars",
    "version": "snapshot 2026-11-18" },
  "evidence": "illustrative",
  "render": { "mag": 17.02 }
}
```

**51 Peg b** (radial velocity; inclination measured, Cont et al. 2026; **radius archive-calculated → `inferred`**).
Only the parts that differ from the shape above are shown:
```json
{ "id": "nea:51 Peg b", "designations": ["HD 217014 b", "HIP 113357 b"],
  "host": "gdr3:2835207319109249920",
  "elements": { "period_d": { "v": 4.2307966, "…": "Cont et al. 2026" }, "a_au": { "v": 0.052 }, "e": { "v": 0.0063 },
    "i_deg": { "v": 49.8, "lo": 44.1, "hi": 55.6 }, "omega_deg": { "v": 0.0, "src": "NEA pscomppars: Naef et al. 2004" },
    "t_peri_mjd": { "v": 52496.5 }, "t_conj_mjd": { "v": 56326.4323 }, "node_deg": null },
  "size": { "radius": { "v": 14.1, "unit": "Rearth", "src": "NEA pscomppars: archive-calculated from mass (Chen & Kipping 2017)", "tier": "inferred" } },
  "props": { "mass": { "v": 0.61, "lo": 0.56, "hi": 0.67, "unit": "Mjup", "src": "NEA pscomppars: Cont et al. 2026", "tier": "measured" },
             "disc_method": { "v": "Radial Velocity" }, "disc_year": { "v": 1995 } },
  "render": { "mag": 5.45309 } }
```

**Host star TRAPPIST-1:**
```json
{
  "id": "gdr3:2635476908753563008", "kind": "star", "name": "TRAPPIST-1", "designations": ["TIC 278892590", "Gaia DR3 2635476908753563008"],
  "same_as": [], "host": null, "parent": null,
  "position": { "model": "fixed", "ra": 346.6263919, "dec": -5.0434618, "epoch": null, "method": "parallax",
    "dist": { "v": 12.42988881, "lo": 12.4111822, "hi": 12.44859542, "unit": "pc", "src": "NEA pscomppars: Gaia DR2", "tier": "measured" } },
  "size": { "radius": { "v": 0.1192, "lo": 0.1179, "hi": 0.1205, "unit": "Rsun", "src": "NEA pscomppars: Agol et al. 2021", "tier": "catalogue" }, "angular": null },
  "props": {
    "teff":          { "v": 2566, "lo": 2540, "hi": 2592, "unit": "K", "src": "NEA pscomppars: Agol et al. 2021", "tier": "catalogue" },
    "mass":          { "v": 0.0898, "lo": 0.0875, "hi": 0.0921, "unit": "Msun", "src": "NEA pscomppars: Agol et al. 2021", "tier": "catalogue" },
    "spectral_type": { "v": "M8.0 V", "src": "NEA pscomppars: Piaulet-Ghorayeb et al. 2025", "tier": "catalogue" },
    "vmag":          { "v": 17.02, "unit": "mag", "src": "NEA pscomppars: TICv8", "tier": "measured" },
    "n_planets":     { "v": 7, "src": "NEA pscomppars", "tier": "catalogue" }
  },
  "provenance": { "source": "static:nea-exoplanets", "dataset": "nea-exoplanets", "catalogue": "NASA Exoplanet Archive pscomppars", "version": "snapshot 2026-11-18" },
  "evidence": "measured",
  "render": { "mag": 17.02 }
}
```
51 Peg's star record has `"same_as": ["hip:113357"]`, so it also resolves when the star payload holds only the
`hip:` context star.

### 16.14 Test plan

**Backend** (`uv run pytest`, offline):
- **`test_objects_schema.py`**
  - The new examples validate.
  - `host_radec` ranges.
  - `same_as` ids.
  - `t_conj_mjd`.
  - `neahost`.
  - `lens-model`.
  - Each new evidence rule (§16.5) rejects its counter-example. For example:
    - an orbit with node null but tier `catalogue`;
    - an orbit with an assumed `e` that is not illustrative;
    - `method: assumed` with a measured distance.
- **`test_objects_static.py`**
  - A hosted record is tiled by `host_radec`.
  - A cone at the host finds it; a cone 1° away does not.
  - `write_dataset` refuses a hosted record without `host_radec`, and an `orbit` record of a kind not in `HOSTED_KINDS`.
  - `verify_dataset` catches a hosted record in the wrong tile.
- **`test_build_nea.py`** (new; synthetic CSV rows, no network):
  - `Msini` → `msini` and no `mass`; `M-R relationship` → `mass` with tier `inferred`.
  - A `Calculated Value` radius → `inferred`.
  - A missing e → 0, illustrative.
  - A missing a → Kepler III, inferred.
  - The host ladder: dr3 > dr2 crossmatch > hip > positional > neahost; microlensing skips the positional step.
  - The DR2 neighbour rule (100 mas, ΔG).
  - `same_as`.
  - Exclusions are counted.
  - Reflink text is extracted and its entities decoded.
  - Building twice gives byte-identical output.
  - The committed dataset passes `--check`.
  - The §16.13 examples equal the built records.
- **`test_build_hr23.py`** (new; synthetic rows):
  - The parallax S/N rule (measured vs derived).
  - The angular extent.
  - The age conversion and its tier.
  - Common names.
  - Byte-identical rebuild and `--check`.
- **`test_objects_api.py`**
  - Both datasets merge through `SPHEREX_OBJECTS_DIR` (with small fixtures built by the scripts from synthetic rows).
  - Exoplanets and stars are cone-only by host position, and `in_cone` is true.
  - `truncated` per kind.

**Frontend** (`node --test`):
- **`scene3d-orbits.test.mjs`** (new)
  - Kepler solver residual < 1e-12 at e = 0, 0.5, 0.95.
  - Periodicity (t and t + P give the same position).
  - `r` between `a(1 − e)` and `a(1 + e)`.
  - At `t_conj`, the planet lies toward Earth: `dot(xyz, −û) ≈ r sin i`.
  - FNV-1a test vectors.
  - Assumed values are stable per id and differ across ids.
  - A transiting planet with unknown i gets 90°.
  - `assumed` flags.
  - `phaseSigmaDeg`.
  - `orbitPath` closes and contains the placement.
- **`scene3d-objects.test.mjs`**
  - The orbit branch of placement.
  - Star records go to `store.stars`.
  - `setHostResolver`: aliases through `same_as`, and re-placement after hosts arrive.
  - `childrenOf` ignores evidence and layers.
  - A non-Sun group needs ≥ 1 record, its label carries the noun, and its pick resolves to the host star.
  - `billboardItems`: glow vs outline mode by evidence, the fades, derived → hollow.
  - `countPhrase` and `capNotes`.
  - `planGo` for an exoplanet from the galaxy frame → `via-host` with the resolved key.
  - `fly-galaxy` for a cluster.
- **`scene3d-registry.test.mjs`**
  - The `exoplanets` and `clusters` layers in group `beyond`, and persistence.
  - Exoplanet card rows:
    - M sin i shown as minimum mass;
    - an inferred radius labelled with its relation;
    - an assumed e and i labelled and dropped in the Evidence view.
  - Cluster card rows and tiers.
  - `rendererOf` per record.

**By hand** (the real app, backend restarted after every backend change, in a browser), at three patches:
1. **TRAPPIST-1** (RA 346.626, Dec −5.043), and 55 Cnc (RA 133.149, Dec 28.330) for a bright hip/Gaia host.
2. **The Pleiades** (RA 56.75, Dec 24.12), and the Hyades for a cluster bigger than the cone.
3. **A patch near the ecliptic** (e.g. RA 150, Dec 12) for the small-body cap.

In each, check:
- markers and the group label;
- the host card's planet list;
- autopilot into the host's frame and on to a planet;
- the orbits;
- the billboards;
- the layer toggles and their persistence;
- the Evidence view (planets hidden but counted; outline rings; hollow derived markers);
- stars and solar objects unchanged, and the frame time in DevTools unchanged.

### 16.15 Work split

`scene3d.js` has one owner at a time. Slices C1 and C2 run one after the other.

| Slice | Model | Files (exclusive) | Depends on |
|---|---|---|---|
| A. Backend schema, tiles, NEA build | Sonnet | `objects.py`, `objects_static.py`, `backend/scripts/build_objects_nea.py`, `backend/data/sources/nea-exoplanets/**`, `frontend/data/objects/nea-exoplanets/**`, `backend/tests/test_objects_schema.py`, `test_objects_static.py`, `test_build_nea.py`, `test_objects_api.py`, `backend/tests/fixtures/objects/**` | this section |
| B. Frontend pure modules | Sonnet, in parallel with A | `scene3d-orbits.js` (new), `scene3d-objects.js`, `scene3d-registry.js`, their tests, `scene3d-orbits.test.mjs` (new) | this section |
| H. Cluster build | Sonnet, once CDS is reachable (in parallel with anything) | `backend/scripts/build_objects_hr23.py`, `backend/data/sources/hr23-clusters/**`, `frontend/data/objects/hr23-clusters/**`, `test_build_hr23.py` | A's `write_dataset` (cluster records are plain `fixed`, so only the merged schema is needed) |
| C1. Renderer: hosts and exoplanets | Sonnet, after A and B | `scene3d.js`, `scene3d-card.js`, `scene3d-main.js`, `scene3d.html`, `scene3d.css` | A, B |
| C2. Renderer: billboard, hollow marker, truncation UI | Sonnet, after C1 | `scene3d.js`, `scene3d-shaders.js`, `scene3d-main.js`, `scene3d.html`, `scene3d.css` | C1, H's data (or a fixture) |
| D. Docs, integration, review | me | this doc's status, `docs/technical-reference.md`, `frontend/dev/mock_server.py` additions | all |

Haiku runs both suites after each slice and the byte-identical `--check` rebuilds.

Commits:
1. This design.
2. Schema and hosted tiles.
3. NEA build and data.
4. Frontend pure modules.
5. Renderer: exoplanets and hosts.
6. Clusters build and data.
7. Billboard, hollow marker, truncation UI.
8. Docs.

### 16.16 Phase 2 checklist (nebulae and black holes)

- [ ] `build_objects_ongc.py` (OpenNGC pinned by git SHA: emission/reflection/planetary nebulae, SNRs) and `build_objects_sh2.py` (Sharpless, VizieR `VII/20`). Distances are mostly absent: `dist: null` direction-only records, or photometric/kinematic distances → `evidence: derived` (hollow marker, now implemented).
- [ ] Direction-only rendering: a sky marker at infinity in the galaxy frame (the store already computes `dir`), never placed in 3D, and its card says "distance unknown".
- [ ] Nebula appearance: a `billboard` variant from the angular size and PA (`size.angular`), illustrative look; outline only in the Evidence view (reuses §16.10).
- [ ] `bh-curated` dataset: Sgr A*, Gaia BH1/2/3, a handful of X-ray binaries, each citing its paper. BH1–3 are hosted by their companion's system (`host` = the companion's `gdr3:` id), and the companion is a `star` record if missing (reuses §16.7).
- [ ] The `lensing` style: illustrative disc. The Evidence view shows the marker only.
- [ ] Decide whether Sgr A* gets `gal:milky_way` as its parent, and the Milky Way record itself (Phase 3 overlap).
- [ ] Follow-ups carried forward: `EVIDENCE_HIDES_FEATURES`; the README `online` marker; the member-star highlight (§16.12); orbit animation over time.

### 16.17 Open questions

- **Q1. Cluster catalogue version.** Pin HR24 if it re-releases every HR23 cluster under the same names (adding masses
  and the bound/moving-group `kind`), else HR23? It cannot be checked until CDS is back. Meanwhile I can start every
  slice except H.
- **Q2. Size.** `nea-exoplanets` is estimated at ~10 MB on disk (~0.8 MB in git) for 6,470 planets and 4,862 hosts,
  right at your ~10 MB line. Keep all planets with full intervals, or trim (no intervals on a/e/i, short `src`) to
  ~8 MB?
- **Q3. Committing source snapshots.** OK to commit the gzipped NEA snapshot (~1.3 MB), the two small Gaia crossmatch
  CSVs, and the extracted HR columns (< 1 MB), so that rebuilds and `--check` work offline and byte-identically?
- **Q4. Clusters to include.** All of them (about 7,167, candidates drawn fainter and labelled), or only the paper's
  "reliable" subset (about 4,105 ⚠)?

### 16.18 Decisions at approval (2026-11-18)

These answer Q1–Q4 and take precedence over §16.1–§16.17.

**D1. Cluster version.**
- Pin **HR24** (`J/A+A/686/A42`) if its ReadMe confirms the same 7,167 clusters under the same names.
- If HR24 only adds columns and does not repeat astrometry and distances, pin **HR23 as well** and join the two by
  cluster name. The manifest then records both pins (VizieR ids and sha256s).
- Ids stay `hr23:<name>`.
- If HR24 is pinned, the card shows its bound-cluster / moving-group class.
- Slice H waits for CDS; everything else proceeds.

**D2. Size.**
- Keep every planet and every uncertainty interval. About 10 MB is fine for this dataset: git stores it compressed
  (~0.8 MB), clients fetch only their cone's tiles, and the deployment's Caddy compresses JSON.
- Lossless savings are welcome. **String table:**
  - The manifest gains `src_table: [string…]`, the distinct quantity `src` strings sorted.
  - In tile files, a Quantity's or position's `src` may be an integer index into it.
  - The loader (`objects_static._read_tile`) and `verify_dataset` expand indices before validation and caching, so
    `/api/objects` and every record in memory always carry string `src`.
  - `write_dataset(..., src_table=True)` builds the table, and the output stays byte-deterministic.
  - This is a **change to §6**, kept within tile format 1, because no reader outside this repo exists yet. A tile
    reader must expand integer `src` values from `manifest.src_table`. A reader that does not would fail validation
    on an integer `src`; it can never mistake it for a source.
  - Expected saving: ~2 MB on `nea-exoplanets`.

**D3. Source snapshots.**
- Committed under `backend/data/sources/<dataset>/` (outside `frontend/`, so never served), gzipped
  deterministically.
- Each directory has a `SOURCE.json` with, per file:
  - `file`, `sha256` (of the uncompressed bytes);
  - `retrieved` (UTC date), the exact `query_url` (or download URL), the row count;
  - `citation`, and the licence or acknowledgement text.
- Build scripts read the committed snapshot by default and download only with `--refresh`.

**D4. Clusters to include.**
- All ~7,167 are in the dataset.
- Candidate status is separate from `evidence`: `props.quality` is `{ v: "reliable" | "candidate", tier: "catalogue",
  src: "<the paper's criterion>" }`.
- By default only reliable clusters are shown.
- The `clusters` layer has a persisted sub-switch, **"Include candidates"**. This is a layer
  `clusterCandidates`:
  - group `beyond`, `on: false`, `parent: 'clusters'`;
  - the panel shows it indented and disabled while `clusters` is off;
  - it is saved in the same `blink.scene3d.layers` map.
- Kind specs' `visible(o, { evidence, layers })` now also receives the layer map (**change to §7.1**).
- Shown candidates are drawn at half glow and half marker alpha, and labelled "candidate" on the card.
