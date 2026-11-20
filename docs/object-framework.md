# Object framework for the 3D view (Phase 0)

Status: **approved 2026-11-18** (with the decisions in §14). Phase 0 is implemented; see §15 for what changed during implementation. **Phase 1 (exoplanets, clusters) is designed in §16, approved and implemented 2026-11-18 (decisions in §16.18, implementation notes in §16.19). Phase 2 (nebulae, black holes) is designed in §17, approved and implemented 2026-11-19 (conditions in §17.16, implementation notes in §17.18). Phase 3 (the `cosmos` frame, galaxies, the Milky Way, supermassive black holes) is designed in §18, approved 2026-11-19 (decisions in §18.18) and implemented (§18.19). Phase 4 (fixes and data quality) is designed in §19, awaiting approval.**

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
| 3 | galaxies (OpenNGC, UNGC, Cosmicflows-4 distances; **Phase 3 change**: NED-D rejected, §18.4.1), the Milky Way, supermassive black holes | the `cosmos` (Mpc) frame |

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
Rsun Rjup Rearth arcsec/h` (**Phase 2/3 change:** plus `mas`, `km/s` and `mag/arcsec2`, §18.9). `lo`/`hi` are a 1σ or 16–84 % interval, as `src` says.

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
  **Phase 2 change (§17.5, §17.7):** a direction-only record must have `host: null`, `method: null` and no `size.radius` unless that radius is a `measured` or `catalogue` value of its own (§17.7). It is drawn at infinity in the galaxy frame, faded with the camera's distance from the Sun like the Milky Way glow.
- `dist.unit` is `pc` or `Mpc`.
- `method` is one of `parallax`, `bailer-jones`, `cluster-parallax`, `photometric`, `kinematic`, `cepheid`, `trgb`, `sbf`, `tully-fisher`, `redshift`, `orbit-fit`, `assumed`. It is shown on cards and drives the evidence rule.
  **Phase 3 change (§18.4.3, §18.9):** plus `maser`, `sn-ia`, `sn-ii`, `supernova`, `fundamental-plane`, `horizontal-branch`, `rr-lyrae`, `cmd`, `brightest-stars`, `pnlf` and `group-member`; a distance whose method is in `DERIVED_METHODS` may not be `measured` or `catalogue`. Records may carry `alt_distances`, the candidates not used.
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
| `nebula` | 2 | static `nebulae` (OpenNGC + Sharpless merged, §17.3) | null | `type`, `vmag`, `bmag`, `sh2_form`, `sh2_struct`, `sh2_bright`, `central_star` (**Phase 2 change**: no `surface_brightness`) |
| `black_hole` | 2 | static `bh-curated` | null, or the companion star (hosted `orbit`, §17.8) | `mass`, `type`, `state`, `companion_mass`, `companion` |
| `galaxy` | 3 | static `galaxies` (OpenNGC + UNGC merged, Cosmicflows-4 and UNGC distances; **Phase 3 change**, §18.3) | null | `type`, `hubble`, `mag_b`, `mag_v`, `surface_brightness`, `v_helio`, `redshift`, `v_cmb` (and the Milky Way's, §18.7) |

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

- **Validator rule.** The record's evidence may not be stronger than its position allows. A position tier of `measured` or `catalogue` allows at most `measured`, `inferred` allows at most `derived`, and `illustrative` allows only `illustrative`. For `fixed` positions the governing tier is `dist.tier`. For `orbit` positions with `phase_known: false` the record must be `illustrative`. **Phase 1 change (§16.5):** orbits with an unknown inclination or node, or with an `illustrative` element, must be `illustrative`, and `method: assumed` caps a `fixed` distance at `illustrative`. The backend rejects records that break the rule: the record is dropped, counted and logged, and the request does not fail. The rule is also tested. **Phase 2 change (§17.7):** an `orbit` position's tier may not be stronger than its weakest element; direction-only records may carry no host, method or physical radius; `render.style` is checked against `RENDER_STYLES`.
- **Evidence view.**
  - It hides records whose evidence is `illustrative`.
  - It draws every other record in its renderer's *evidence style*, with no illustrative appearance. Star glows already go today.
  - **Phase 0 makes no visible change here.** Planet bands, atmospheres and rings are tagged `illustrative` in the planet kind's sphere spec (`features: {band, atm, ring}`). Whether the Evidence view drops them is one constant in `scene3d-registry.js`, `EVIDENCE_HIDES_FEATURES = false`. Today the ring is clipped by the quad extent while bands and atmosphere still show, and that is kept. Hiding them all is a follow-up (§13).
  - Card rows with tier `illustrative` are dropped, as now.
  - Derived records stay visible. Their markers get a hollow style hook, which Phase 0 has no records to use (§7.1).
- **Phase 3 change (§18.4.3):** the method → evidence table for galaxy distances; SN Ia, Tully–Fisher, fundamental-plane and Hubble-flow distances are `derived`, enforced by `DERIVED_METHODS`.
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

Tile records must use `fixed` positions and `host: null`, and must pass `validate_record`. **Phase 1 change (§16.3):** records of a hosted kind (`exoplanet`) may instead use an `orbit` position with a `host` and `position.host_radec`, and are tiled by that direction. **Phase 2 change (§17.7):** `black_hole` is a hosted kind too. **Phase 3 change (§18.9):** `manifest.sky_tiles` names tiles every query returns whatever the cone (the galaxy context set, the supermassive black holes).

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
>
> **Phase 2 change (§17.5, §17.6, §17.9):** specs gain `billboard: 'cluster' | 'nebula'`, and there is a new renderer,
> `lensing`. Direction-only entries (`atInfinity`) are drawn by the galaxy-frame renderers at infinity, and `go` may plan `look`.
>
> **Phase 3 change (§18.5, §18.6):** `frames.cosmos`; `billboard` may be a function and gains `'galaxy'` and `'milky_way'`;
> per-kind `skyFadePc`; `galaxyScope: 'sky'` for galaxies; every record without a `cosmos` renderer fades with `galaxyFade`.

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

**Phase 3 change (§18.6.2, §18.7):** galaxies fly to 3 radii (`fly-galaxy`), the Milky Way to a face-on view 60 kpc above its centre.

**Phase 2 change (§17.5):** a direction-only target plans `{ type: 'look', dir }`. The camera turns to face it and does
not move ("Turn to it").

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
  // Phase 3, not registered in Phase 0 (Phase 3 change: registered, with the values of section 18.5.1):
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
- **Phase 3 change (§18.5):** `cosmos` is registered; the galaxy level's `range.max` and `autoPc.max` rise to 1e8 pc/s; what each level draws is §18.5.4.
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

**Black hole (Phase 2, hypothetical; superseded by the real records in §17.12)**: measured placement, illustrative appearance. The Evidence view shows the
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

- [x] `backend/scripts/build_objects_nea.py` and `build_objects_hr23.py` (pinned sources), producing `frontend/data/objects/{nea-exoplanets,hr23-clusters}/`.
- [x] Allow hosted static kinds in tiles (`position.host_radec`, §10 note).
- [x] Map Exoplanet Archive hosts to `gdr3:` ids from the archive's Gaia DR3 cross-id column. Fall back to `hip:`, and for hosts missing from the star payload, send `star` records.
- [x] `registerLayer` for `exoplanets` and `clusters`. `registerKind` for `exoplanet` (`frames: {system: 'sphere'|'point', galaxy: 'marker'}`, `go: 'host-frame'`) and `cluster` (`frames: {galaxy: 'billboard'}`).
- [x] Implement the `billboard` renderer (the first kind to need it), plus client-side `orbit` evaluation.
- [x] Derived-placement marker style (the hook already exists).
- [x] Cards: list a host star's planets in its star card (via `parent`).

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

Status: **approved and implemented 2026-11-18**. The decisions in §16.18 and the implementation notes in §16.19 take precedence over the text above them. Phase 0 sections that Phase 1 changes carry a "Phase 1 change"
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
| 3 | `hip_name` → `hip:<n>`. The scene's bright context stars are keyed `hip:`. | 14 (12 in the build: two are caught by step 2 or 4 first) |
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
      "omega_deg":   { "v": 336.86, "lo": 302.62, "hi": 371.1, "unit": "deg", "src": "NEA pscomppars: Grimm et al. 2018", "tier": "measured" },
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

**51 Peg b** (radial velocity; inclination measured, Cont et al. 2026; **radius archive-calculated → `inferred`**; the archive flags its eccentricity as an upper limit, so it is drawn circular and `illustrative`, §16.19).
Only the parts that differ from the shape above are shown:
```json
{ "id": "nea:51 Peg b", "designations": ["HD 217014 b", "HIP 113357 b"],
  "host": "gdr3:2835207319109249920",
  "elements": { "period_d": { "v": 4.2307966, "…": "Cont et al. 2026" }, "a_au": { "v": 0.052 },
    "e": { "v": 0, "hi": 0.0063, "src": "NEA pscomppars: upper limit e < 0.0063 (Cont et al. 2026); drawn circular", "tier": "illustrative" },
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

Phase 2 is designed in §17; the boxes below are ticked when it lands.

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

### 16.19 Implementation notes (Phase 1)

These were settled while building Phase 1. Where they differ from the sections above, they take precedence.

**Archive limit flags.** A value the archive flags as a limit (`*lim` = 1 upper, −1 lower) is never shown as a
measurement.
- An eccentricity limit becomes `v: 0`, `illustrative` (drawn circular), with the bound in `hi`.
- An inclination or ω limit leaves the element `null`, so the client assumes it.
- A period, semi-major axis or epoch limit counts as missing.
- Card-only values (mass, M sin i, radius, star props) keep the bound as a string `v` such as `"< 0.12"`, so a client
  that does arithmetic skips them.
- Counts in the 2026-11-18 build:
  - eccentricity: 288 upper, 11 lower;
  - mass: 225 upper, 13 lower;
  - inclination: 6 upper, 37 lower;
  - planet radius: 5 lower.
- 64 negative lower bounds on positive-only quantities are clamped to 0.

**Dataset size (D2).**
- `nea-exoplanets` is **11.6 MB in 404 tiles** (largest `13-20`, the Kepler field, 2.7 MB), with every interval kept.
- Lossless savings in the tile format:
  - the `src_table`;
  - **`record_defaults`**: top-level keys identical in every record (the compact `provenance`) are stored once in the
    manifest and restored by the loader, like the string table. This is a further change to §6 within tile format 1.
- The source snapshot is 1.2 MB.

**Numbers** are written from the archive's decimal strings: at most 12 significant digits, Kepler-III derived values
at 10.

**Hosts.** Two pairs of host names resolve to one Gaia source (HD 41004 A/B, TOI-2267 A/B) and share one star record.
28 hosts have no distance; they are direction-only `star` records and are not added to the star field.

**Orbit orientation** (changes §16.6). The assumed node Ω, and the assumed inclination of non-transiting planets, are
hashed per **host** (`hashUnit(host, …)`), so a system's unknown orientation is shared and a coplanar system such as
TRAPPIST-1 is drawn as one plane instead of a starburst. ω and the phase stay per planet. It is still illustrative and
labelled so.

**Host star card** (changes §16.8). Per row, the strongest tier wins between the Gaia/Apsis value (or the page's own
photometric estimate, tier `inferred`) and the archive star record. On a tie, Gaia wins. Example: TRAPPIST-1 showed
"○ 2,500 K, 0.056 R☉" (estimated from photometry), whereas the archive gives 2,566 K and 0.1192 R☉ (catalogue, Agol et
al. 2021).

**SkyBoT failures** (a Phase 0 bug found in the hand check). SkyBoT answers a failed computation with HTTP 200 and
`flag: -1`. That was parsed as an empty sky and cached for 7 days, so a patch near the ecliptic showed "0 small bodies".
It now raises, which reports the kinds as `error` and caches nothing. The cache key moved to `skybot-3` so that entries
cached that way are no longer read.

**Cluster catalogue (D1 resolved).** HR24 (`J/A+A/686/A42`) is **pinned alone**.
- It holds the same 7,167 clusters as HR23, matched by catalogue `ID`, with identical values in every shared column
  (RA, Dec, parallax, distances, ages, radii, N, CST).
- It adds masses (`MassTot`, `MassJ`), Jacobi radii and a `Type` of `o` bound open cluster (5,647), `m` moving group
  (1,309), `g` globular (132), `d` too distant, d ≥ 15 kpc (62; HR24 Table 3), and `r` rejected (17).
- **68 names differ from HR23.** They are corrections, such as a Dec sign in a Teutsch name and `FoF_2309` →
  `LP_2309`. Ids use the HR24 names (`hr23:<Name>`).
- Facts were checked through the CfA VizieR mirror on 2026-11-18, while CDS was down. The pinned file's sha256 (`#`
  lines stripped) is in `SOURCE.json`.

**Cluster quality (D4).** The HR23 cut (CST ≥ 5 and median CMD class ≥ 0.5) gives the paper's 4,105. Five of them
are HR24-rejected and are not counted as reliable, which leaves **4,100 reliable** and 3,067 candidates.

**Cluster distances.** The tier is `measured` when `Plx/e_Plx ≥ 5` (`e_Plx` is the standard error of the mean, not
the member spread `s_Plx`). Otherwise it is `inferred`, which makes the record `derived` with a hollow marker: 97
clusters, mostly distant globulars.

**Cluster extent** (changes §16.9). `size.angular.major` is 2 × r50, so the cone test and `max_extent_deg` (22.7°)
follow the half-member radius that the billboard draws. The total radius reaches 73° for nearby moving groups and
would have put them in almost every patch.

**Cluster glow** (§16.10, tuned in the hand check). The glow's peak is a distance-independent surface brightness
∝ N / r50², so a diffuse moving group is nearly invisible next to a compact cluster. The glow also fades out as the
camera comes within a few r50, where the member stars show the cluster. The Evidence-view r50 ring has no close fade.

## 17. Phase 2: nebulae and black holes (design)

Status: **approved 2026-11-18, with the conditions recorded in §17.16** (they are already folded into the sections below); **implemented 2026-11-19** (§17.18).
Sections of §1–§16 that Phase 2 changes carry a "Phase 2 change" note pointing here. Where this section and an earlier one
disagree, this one wins.

Every catalogue fact below was checked against the live source on 2026-11-18:
- OpenNGC on GitHub;
- VizieR through the CfA mirror (`vizier.cfa.harvard.edu`), because CDS (`cdsarc`, `vizier.cds`) timed out again;
- the Gaia archive (ESA TAP);
- arXiv full texts for every black-hole number.

SIMBAD's main site was unreachable, but its Harvard (`simbad.cfa.harvard.edu`) and South African (`simbad.idia.ac.za`)
mirrors answered. All seven black-hole companions were cross-checked there by their Gaia DR3 ids (§17.8).

### 17.1 Decisions at a glance

| Question | Decision |
|---|---|
| Nebula sources | **OpenNGC** at release `v20260501` (commit `36cb178a0f69dba8bfc03a99c10512831edf1c6b`) and **Sharpless** (VizieR `VII/20`), merged at build time into **one dataset, `nebulae`**, built by one script, `build_objects_nebulae.py`. A merge needs both inputs, so two datasets would draw M42 twice (§17.3). |
| Nebula types | OpenNGC `PN`, `HII`, `EmN`, `RfN`, `Neb`, `SNR`, `Cl+N` and `DrkN`, without `Dup` or `NonEx`: **433 rows**. Plus every Sharpless region not merged into one of them. |
| Cross-catalogue merge | Explicit identifier first, then a committed override table, then a scored positional rule with caps that stop huge regions claiming unrelated objects. The OpenNGC id wins, and `Sh2-n` goes into `designations` (§17.3). |
| Distance catalogues (at most two) | **Adopted.** (1) **Chornay & Walton 2021** (`J/A+A/656/A110`): Gaia EDR3 parallaxes of PN central stars, giving `measured` distances, **59 PNe**. (2) **Russeil 2003** (`J/A+A/397/133`) *stellar* (spectrophotometric) distances of star-forming complexes, giving `derived` distances, at most 155 Sharpless regions. **Rejected:** Russeil's kinematic distances, the WISE HII catalogue and González-Santamaría 2021 (§17.4). |
| Direction-only records | Unchanged schema (`fixed`, `dist: null`), plus validator guards. They are drawn **at infinity in the galaxy frame**, faded with the camera's distance from the Sun exactly like the Milky Way glow. They are never placed in 3D. Picking and labels work; the card says "distance unknown". "Go there" becomes **"Turn to it"**, which rotates the camera without moving it (§17.5). |
| Nebula look | A `billboard` variant (`nebula`): an ellipse on screen from `size.angular`, projected so that from the Sun it is exactly the catalogue's major, minor and PA. It has a **procedural illustrative look per type**: emission, reflection, planetary, SNR shell and dark. The Evidence view shows the catalogue outline only, reusing §16.10 (§17.6). |
| Real images | **Follow-up, not Phase 2.** ESA/Hubble and ESA/Webb (CC BY 4.0) clearly allow shipping cropped images with credit, commercial use included. The work needed is per-image curation, astrometric registration from the images' AVM/WCS, and a provenance record per image. **A later version should prefer images with proper sky alignment (tiled sky surveys, e.g. HiPS) over press images, licence permitting** (§17.6.4). |
| Data licence | The OpenNGC-derived `nebulae` data files are **CC BY-SA 4.0**; the code stays MIT. A licence notice sits in both nebula dataset folders, the main `LICENSE` says which data files are CC BY-SA 4.0, and the credit is shown **in the app** (nebula cards and a credits line in the 3D view), not only in the manifest. The same applies to the Phase 3 galaxy files (§17.2). |
| Black holes | `bh-curated`: a hand-curated, committed JSON source in which every number carries its paper and table location. Records: Sgr A*, Gaia BH1, BH2 and BH3, Cyg X-1, V404 Cyg, A0620-00, MAXI J1820+070 and GRS 1915+105, plus `star` records for the seven companions (§17.8). |
| Hosted black holes | `black_hole` joins `HOSTED_KINDS`. Each BH with a Gaia companion is an `orbit` record hosted by the companion's `gdr3:` id. **Gaia BH1 and BH2 are `measured`**: their astrometric orbits give P, e, i, Ω, ω and T_p. **BH3 is `derived`**, because its relative semi-major axis is scaled from a₁. **The X-ray binaries are `illustrative`**: Ω is unknown, so they are hidden in the Evidence view but still counted on the host card, with no special case (a general rule for all hosted kinds is a follow-up, §17.15). |
| Companion distances | A new optional star-record field, **`prefer_record: {replace: ["dist", …], reason}`**, allowed **only on the seven curated companions, listed by id in the validator** (not a general override). When the star payload holds that star, its **distance** comes from the record (orbit-corrected, VLBI or the cited parallax), and since 2026-11-19 also the mass, radius and Teff its paper prints; its sky position and Gaia identity stay Gaia's. The single-star Gaia values are shown on the card as "not used", with the reason (§17.8). |
| `lensing` style | A new renderer: a shadow disc, a photon ring and a soft lensed halo, plus an accretion disc for accreting systems. Its size comes from the real shadow radius (2.6 r_s, with r_s from the mass) when that exceeds a few pixels; otherwise it is drawn enlarged and the card says by how much. It is illustrative, and the Evidence view shows the marker only (§17.9). |
| Sgr A*'s parent | `null` in Phase 2. `gal:milky_way` arrives with Phase 3 galaxies (§17.8). |
| Layers | `nebulae` ("Nebulae") and `blackHoles` ("Black holes") in group `beyond`, default on, persisted in the existing map. **No sub-switches.** Planetary nebulae are small and drawn as markers anyway, and dark nebulae are two objects. |
| Scope | Both kinds are cone-only (`galaxyScope: 'cone'`). Nebulae use centre plus angular extent through the server's `cone_contains`, so a cone inside Barnard's Loop (20°) shows it. |

### 17.2 Build scripts, pins and reproducibility

Both scripts follow `build_objects_hr23.py`:
- the committed snapshot is read by default;
- `--refresh` downloads, re-verifies against the pins and rewrites the snapshots;
- `--local DIR` builds from given files;
- `--check` does a byte-identical rebuild plus `verify_dataset`, and exits 1 on any difference;
- `SOURCE.json` (§16.18 D3) lists every input file;
- a build report goes into `manifest.build.report`;
- `write_dataset(..., src_table=True)` is used.

| | `build_objects_nebulae.py` → `frontend/data/objects/nebulae/` | `build_objects_bh.py` → `frontend/data/objects/bh-curated/` |
|---|---|---|
| Inputs | `openngc-36cb178a-NGC.csv.gz` and `openngc-36cb178a-addendum.csv.gz`: raw files from `raw.githubusercontent.com/mattiaverga/OpenNGC/<sha>/database_files/…`, sha256 of the uncompressed bytes pinned in the script. `sharpless-vii20.tsv.gz`: VizieR ASU-TSV, `-source=VII/20/catalog&-out.all`, 313 rows. `chornay2021-tablea1.tsv.gz`: `J/A+A/656/A110/tablea1`, 2,117 rows. `russeil2003-table1.tsv.gz` and `-table3.tsv.gz`: 1,449 and 481 rows. | `black_holes.json`: **hand-curated and committed**; every number has `{v, lo, hi, unit, src, where}`, and `where` is the table, row or section. `gaia-dr3-companions.csv`: a Gaia DR3 TAP snapshot of the 7 companions (`source_id, ra, dec, ref_epoch, parallax, parallax_error, pmra, pmdec, phot_g_mean_mag, bp_rp, ruwe`), ESA first, then ARI. |
| Snapshots | `backend/data/sources/nebulae/` | `backend/data/sources/bh-curated/` |
| VizieR rows | VizieR TSV header and comment lines (`#…`) are stripped before hashing and parsing, so the pin is the data, not the server's timestamp line (as in Phase 1). The parser skips the units and dashes lines explicitly. | — |
| `--refresh` | OpenNGC by the pinned SHA; VizieR from the CfA mirror, then CDS. The new sha256 is written to `SOURCE.json`, and a changed VizieR table fails loudly. | Only the Gaia snapshot. `black_holes.json` is edited by hand in a reviewed commit and never downloaded. |
| Report | rows read; rows kept per type; excluded `Dup`/`NonEx`; Dup designations folded in; merges by rule (identifier / override / positional), with the **full list of merged pairs**; Sharpless-only regions; distances by method; PN distance cut counts; Russeil links rejected by the 1° filter | records per kind and evidence, and every `src`/`where` pair |

**VizieR mirrors** for `--refresh`, in order: CfA (`vizier.cfa.harvard.edu`), IDIA South Africa (`vizier.idia.ac.za`), then
CDS (`vizier.cds.unistra.fr`). The mirror actually used goes into `SOURCE.json`.

**Licences** go in `SOURCE.json` and `manifest.provenance`:
- **OpenNGC is CC BY-SA 4.0** (`.reuse/dep5`; there is no LICENSE file). The derived `nebulae` data files therefore carry CC BY-SA 4.0 and the OpenNGC credit line: "Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC". They also carry OpenNGC's acknowledgements of NED, HyperLEDA, SIMBAD, HEASARC and Corwin.
- **Where the licence is stated** (approval condition 1; the Phase 3 galaxy files do the same):
  - `LICENSE.md` in **both** `backend/data/sources/nebulae/` and `frontend/data/objects/nebulae/`: what is covered (every file in that folder), CC BY-SA 4.0 with its URL, the verbatim OpenNGC credit and acknowledgements, the Sharpless/VizieR, Chornay & Walton and Russeil citations, and a statement that the build code is MIT.
  - The repository `LICENSE` gains a paragraph after the MIT text: the code is MIT; the data files in those two folders are derived from OpenNGC and licensed CC BY-SA 4.0 (see each folder's `LICENSE.md`).
  - `manifest.provenance` gains **`credit`** (the verbatim line), **`licence_name`** (`"CC BY-SA 4.0"`) and keeps **`licence`** (the URL). `/api/objects` already returns each dataset's provenance in `sources`, so the frontend needs no new endpoint.
  - **In the app:** every nebula card has a `Data` row, "OpenNGC (Mattia Verga), CC BY-SA 4.0" (plus "Sharpless 1959 via VizieR" when merged or Sharpless-only). The 3D view gets a **credits line** listing `credit · licence_name` for every dataset that returned records in the current cone and has a `credit`. It is generic, so the galaxy files need no new code.
- VizieR tables carry the VizieR terms URL and the catalogue citation, as in Phase 1.
- `bh-curated` cites each paper per record. Its seven companion rows hold **Gaia DR3 values, which ESA distributes under CC BY-NC 3.0 IGO** ("Credit: ESA, Gaia DPAC", which **Phase 3 changes** to "Credit: ESA/Gaia/DPAC" everywhere, §18.12; commercial use needs ESA's authorisation), as the build found on ESA's licence pages on 2026-11-19. The design had assumed no licence condition applied. So the manifest has `credit: "Credit: ESA, Gaia DPAC"` and `licence_name: "CC BY-NC 3.0 IGO (Gaia DR3 values)"`, which puts the credit on the credits line, and both `bh-curated` folders carry a `LICENSE.md` saying which values that covers.
  - The licence applies to Gaia data everywhere in the app, including the live star layer and Phase 1's Gaia-derived files. Settling that repository-wide is a follow-up (§17.15).

### 17.3 Nebula records and the cross-catalogue merge

**OpenNGC parsing.**
- Use `csv.reader(delimiter=';')`: 276 lines contain quoted fields with `;` inside.
- RA and Dec are sexagesimal J2000, converted to degrees at 7 decimals. `MajAx` and `MinAx` are in arcmin. `PosAng` is "North Eastwards", in degrees; the guide states no unit, but every value is in 0–180.
- **`Dup` rows** (651) point to their master through the `NGC` column, else the `IC` column; for the 3 rows that fill both, NGC wins. When the master is a kept nebula, the Dup's name joins its `designations`, so NGC 2244 → NGC 2239.
- **`NonEx` rows** (10) are dropped.

**Sharpless parsing.**
- B1900 FK4 → ICRS with astropy: `SkyCoord(…, frame=FK4(equinox='B1900', obstime='B1900')).icrs`, a build-time use of an existing dependency. The recomputed (l, b) agrees with the table's to a median of 0.02°.
- `Diam` is the maximum angular diameter in arcmin. `Form`, `Struct` and `Bright` are 1–3 codes.

**Merge rule** (Sharpless region S onto an OpenNGC row N). The steps run in order, and each N is claimed at most once:
1. **Identifier.** N's `Identifiers` contains `SH 2-<n>`. Only C009 = Sh2-155 has one today.
2. **Overrides.** `backend/data/sources/nebulae/sh2_ongc_overrides.json`, committed: `[{sh2, ongc | null, reason}]`. `null` forbids any merge for that region. Seeded with:
   - `Sh2-11` → `NGC6357` ("War and Peace Nebula; OpenNGC MajAx 3.9′ is the cluster's");
   - `Sh2-276` → `null` ("Barnard's Loop; nothing in OpenNGC is the same object");
   - `Sh2-109` → `null` ("Cygnus region, 18°").

   The build report lists every pair, so reviewers extend the table, not the code.
3. **Positional.** Candidates are N of types HII, EmN, Neb, Cl+N, RfN, SNR or DrkN (never PN) with separation `s ≤ min(40′, max(10′, Diam/3, 0.6·MajAx_N))`.
   - Drop a candidate when `Diam ≥ 10·max(MajAx_N, 1′)` and `s > 10′`: a small object far from the centre of a much larger region is a member, not the region.
   - Score = `s / max(MajAx_N, 1′)`, lowest wins. This picks the nebula NGC 2237 over the cluster NGC 2239 for the Rosette, and NGC 6523 over IC 1271 for M8.
   - When one N is claimed by several regions, the best score keeps it and the others fall back to their next candidate. So IC 410 goes to Sh2-236 (1.7′), not Sh2-230 (46′).

**Expected outcomes**, which are test assertions on the committed snapshot:

| Region | Merges with |
|---|---|
| Sh2-281 | NGC1976 (M42) |
| Sh2-275 | NGC2237 |
| Sh2-117 | NGC7000 |
| Sh2-131 | IC1396 |
| Sh2-25 | NGC6523 |
| Sh2-155 | C009 |
| Sh2-220 | NGC1499 |
| Sh2-236 | IC0410 |
| Sh2-276, Sh2-109 | none |

The research run of the plain nearest-centre rule merged 47 pairs, with the Rosette, M8, Barnard's Loop and Sh2-109 wrong. **The final count comes from the build report.**

**Merged record.**
- The id is OpenNGC's (`ongc:NGC1976`); its position and its V/B magnitudes are used; `Sh2-281` is added to `designations`.
- **Size:** OpenNGC `MajAx`/`MinAx`/`PosAng` when `MajAx ≥ Diam/3`; otherwise the Sharpless diameter as a circle (`major = Diam`, `minor`/`pa` null).
  - The OpenNGC size of a `Cl+N` row is often the cluster's: IC 1396 is 14′ against Sharpless's 170′.
  - The src says which catalogue the size came from.
- **Sharpless-only regions** get `sh2:<n>` (e.g. `sh2:276`), name `Sh2-276` (or a curated common name), type "HII region", and size `major = Diam`.

**Names.**
- A small curated map in the script gives common names, src "curated common name": Orion Nebula, Ring Nebula, Crab Nebula, Lagoon Nebula, North America Nebula, Rosette Nebula, Barnard's Loop, Horsehead Nebula, Helix Nebula, Dumbbell Nebula, …
- Otherwise the first OpenNGC common name; else `M 57`; else `NGC 6720` / `IC 1396` / `Sh2-155`.
- `designations` holds every M/NGC/IC/Sh2/LBN/PN G identifier and the common names.

**Record fields** (`kind: "nebula"`, `host: null`, `parent: null`):

| Field | From | Tier / rule |
|---|---|---|
| `position` | `fixed`, OpenNGC RA/Dec (J2000) or the precessed Sharpless centre, `epoch: 2000.0` | `position.tier: catalogue`. With a distance, the `dist` tier governs (§17.4). |
| `size.angular.major/minor/pa` | §17.3 size rule (arcmin, deg) | `catalogue` |
| `size.radius` | only with a distance: `dist · tan(major/2)` in pc | `inferred` (src "from angular size and distance"). **Always null for direction-only records** (validator, §17.7). |
| `props.type` | readable type: "Planetary nebula", "HII region", "Emission nebula", "Reflection nebula", "Nebula", "Supernova remnant", "Cluster with nebula", "Dark nebula" | `catalogue` |
| `props.vmag`, `props.bmag` | OpenNGC V-Mag, B-Mag | `catalogue` |
| `props.sh2_form`, `sh2_struct`, `sh2_bright` | Sharpless codes as words ("elliptical", "filamentary", "bright") | `catalogue` |
| `props.central_star` | PN with a Chornay distance: "Gaia EDR3 <id>" | `catalogue` |
| `render.mag` | V, else B, else none; ordering only | |
| `evidence` | `measured` for direction-only records and PN parallax distances; `derived` for Russeil distances (§17.4) | |

**Change to §2.5:** nebula `props` keys are `type`, `vmag`, `bmag`, `sh2_form`, `sh2_struct`, `sh2_bright` and `central_star`. `surface_brightness` is dropped: OpenNGC fills `SurfBr` only for galaxies.

**Overlap with clusters.** `Cl+N` rows (M42, NGC 2239, IC 1396) can also be HR24 clusters. They stay two records of two kinds: a cluster glow from member stars, and a nebula glow from the gas. This is intentional, and the cards say which is which.

### 17.4 Nebula distances (two catalogues, evaluated)

**(1) Planetary nebulae: Chornay & Walton 2021**, A&A 656, A110, "One star, two star, red star, blue star: an updated planetary nebula central star distance catalogue from Gaia EDR3", VizieR `J/A+A/656/A110/tablea1`, 2,117 rows.
- **Match:** OpenNGC PN rows to `PNG` through the `PN G<id>` in `Identifiers`. 127 of 130 have one, and 115 of those are in the table.
- **Cuts:** `Rel ≥ 0.9` (central-star identification reliability), `plx/e_plx ≥ 5`, and `RUWE < 1.4` (a blank RUWE fails). **59 PNe pass**, including Ring, Helix, Dumbbell, Owl, Eskimo, Cat's Eye and Bow-Tie.
- **Distance:** `1000/plx` pc, with `lo = 1000/(plx+e_plx)` and `hi = 1000/(plx−e_plx)`, `method: parallax`, tier `measured`, giving `evidence: measured`.
- **No parallax zero-point correction is applied** (Gaia EDR3 has a global offset of about −0.02 mas). At S/N ≥ 5 and these parallaxes, this is under 3 %, and the src says "Gaia EDR3 parallax, no zero-point correction".
- **Not used:** the catalogue's `rcomb`. It folds in a statistical (Hα surface-brightness) distance prior, so it is not a parallax measurement.
- **Rejected alternative:** González-Santamaría et al. 2021 (`J/A+A/656/A51`). It is a similar Gaia EDR3 PN catalogue, but its served `tablea2` holds 405 distances against an abstract that says 1,725, and its distance method could not be checked while CDS was down.

**(2) HII regions: Russeil 2003**, A&A 397, 133, `J/A+A/397/133`, stellar distances only.
- **Linking.**
  - `table1.HaName` names Sharpless regions as `S<n>` (`M8=S25`, `S275`); 270 distinct numbers across 173 complexes.
  - `table1.Name` (`l±b`) is joined to `table3` (`GLON`/`GLAT`, zero-padded) numerically, to within 0.05°. 476 of 481 rows are reached.
  - **The `S` prefix is not always a Sharpless number:** 98 of 289 links point more than 1° from the Sharpless position.
  - Links are therefore kept only when the precessed Sharpless centre lies **within 1° of the complex's (l, b)**. That leaves 191 regions, 155 of them with a stellar distance.
  - **Checked on known regions** (approval condition 5; test assertions on the committed snapshot):
    - Orion (Sh2-281 → M42) links to complex `208.0-19.0` at 400 pc (350–500 pc asserted). Its complex centre is 1.10° from the Sharpless centre, just outside the filter, so the link is an explicit `russeil_complex` entry in the override table.
    - M8 (`S25` → NGC 6523) links to `6.0-1.2` at 1.6 kpc (1.0–1.8 kpc asserted).
    - The Rosette (Sh2-275 → NGC 2237) links to `206.3-2.1`, which Russeil labels "Rosette = W16 = NGC 2237", at 1.9 ± 0.25 kpc. The design's 1.3–1.8 kpc range was too narrow: the link is right and 1.9 kpc is Russeil's own value. Gaia-era studies put the Rosette nearer 1.5 kpc, which is one more reason for the Gaia-based follow-up below.

    A wrong link fails the build test, and the fix goes in the override table or the filter, not the test.
  - **The build report states how many links the 1° filter drops, and lists them.** The build measures the separation along a great circle (the research run used max(|Δl|, |Δb|)): **106 of 289 links are dropped**. That leaves 183 linked regions, 150 of them with a stellar distance; **148 records get one**, because the rest are excluded types.
- **Distance:** `DistSt ± e_DistSt` (kpc → pc), `method: photometric`, tier `inferred`, so `evidence: derived` and a hollow marker. The src names the complex, e.g. "Russeil 2003 table3: stellar distance of complex 208.0-19.0". `n_DistSt = ')'` ("photometric data only") is kept and noted in the src.
- **Kinematic distances (`Dist`) are rejected.**
  - Their error columns `err+D`/`err-D` carry inconsistent signs, and the ReadMe that would explain them is unreachable.
  - Kinematic distances fail near the Sun: Russeil's own Orion complex has kinematic 1.0 kpc against stellar 0.4 kpc (the VLBI value is 0.41 kpc).
  - **This answers the brief's "kinematic distances for HII regions": evaluated and rejected in favour of the same catalogue's stellar distances.**
- **WISE HII catalogue** (Anderson et al. 2014, `J/ApJS/212/1`) is rejected: it gives no distance for the Rosette, IC 1396 or M8.
- **Where it applies:** to Sharpless-only regions, and to merged records of types HII, EmN, Neb and Cl+N. **Never** to SNR, PN, RfN or DrkN, which may sit in front of or behind the complex (the Crab = Sh2-244 stays direction-only).
- **Precedence:** a PN parallax distance beats a Russeil distance; nothing else conflicts.

Built counts (2026-11-18): **697 nebulae.** Of these, 59 have measured PN parallax distances and 148 derived Russeil distances; the other 490 are direction-only. 433 are OpenNGC rows (49 of them merged with Sharpless: 1 by identifier, 2 by override, 46 by position) and 264 are Sharpless-only regions. The positional rule picked NGC 6526 for Sh2-25, so M8 = Sh2-25 = NGC 6523 is an override.

**Follow-up:** look for HII-region distance catalogues based on Gaia parallaxes of the ionising stars (for example
Méndez-Delgado et al. 2020 and later work), which would replace the photometric Russeil distances where they overlap
(§17.15).

### 17.5 Direction-only records end to end

**Schema.** No change: `position.model: fixed` and `dist: null`, with `position.tier` governing evidence (already in the validator). A direction is measured, so a direction-only nebula is `measured`: what is drawn is only its direction. New validator guards (§17.7):
- `host` must be null;
- `method` must be null;
- `size.radius` must be null unless its tier is `measured` or `catalogue` (an independent measurement, such as a star's radius), because a physical size derived without a distance would be made up.

**Store** (`scene3d-objects.js`). `rec.dir` is already computed. New behaviour:
- `visibleObjects` (galaxy frame) accepts an entry with `dir` and no `galPc`, and marks it `atInfinity: true`.
- System frames never draw them, because their kinds have no `system` renderer.
- **`framePos(entry, cam)`** for `atInfinity` returns `dir × INF_PC × unitsPerPc(cam)`.
  - `INF_PC = 1e7` pc: far outside anything placed (≤ 1e4 pc), inside the galaxy far plane (1e9).
  - It is the same for every camera position, so the object stays fixed on the sky as you fly.
- **`skyFade(cam) = 1 / (1 + (dSun_pc / SKY_FADE_PC)²)`**, with `SKY_FADE_PC = 800`.
  - This is the Milky Way glow's rule. `MW_FADE_PC` moves to `scene3d-objects.js` as the one shared constant, and `scene3d.js` imports it.
  - Direction-only objects are "the sky as seen from the Sun", like the glow, so they fade out together when you fly far away.
  - Their billboard alpha, marker alpha and labels are multiplied by it. Below `skyFade < 0.25` they are not labelled or picked.
- **`planGo`** returns `{ type: 'look', dir }` for an `atInfinity` target.
- **`fromYou`** is `null` for them. This fixes the crash at `scene3d.js:1405`: `_fromYou(null)`.
- Group markers ignore them (no host).

**Renderer** (`scene3d.js`).
- Markers and billboards use `framePos`, so no new draw path is needed.
- **"Turn to it":** a new autopilot mode, `ap.type = 'look'`. It slerps the camera orientation to face `dir` over 0.8 s (instant with reduced motion) and leaves the position and speed unchanged. The card button and G both use it.
- The crosshair shows no distance for an `atInfinity` target.

**Card.**
- Rows:
  - `Distance`: "unknown · drawn on the sky as seen from the Sun", tier `catalogue`, src "no distance in the adopted catalogues".
  - The angular-size row.
- No "From you" row.
- Note: "No distance is known, so it is drawn at infinity in its catalogue direction. It fades when you fly far from the Sun."

**Evidence view.** Direction-only records are `measured`, so they stay: the catalogue outline at infinity, with a solid marker.

### 17.6 The nebula billboard variant

#### 17.6.1 Data: `billboardItems` (`scene3d-objects.js`)

- **Generalisation.** The registry spec gains **`billboard: 'cluster' | 'nebula'`**. Clusters keep today's code path unchanged: `r50`, the Plummer profile, and the fades of §16.10 and §16.19. Nebula items come from `nebulaItem(e, cam, ctx)`.
- **Inputs.** `project` is required for nebulae. The renderer always passes it today.

**Shape, a "projected ellipsoid" (pure, tested).** At the nebula's centre, build the sky-plane unit vectors at its direction `û`:
- north `N̂ = (−sinδ cosα, −sinδ sinα, cosδ)` and east `Ê = (−sinα, cosα, 0)`, the same basis as §16.6;
- the major-axis direction `M̂ = cos(PA) N̂ + sin(PA) Ê` and the minor-axis direction `m̂ = −sin(PA) N̂ + cos(PA) Ê`.

The semi-axes are vectors in frame units:
- **Placed:** `A = M̂ · D·tan(major/2)`, `B = m̂ · D·tan(minor/2)`, and the depth axis `C = û · |B|`. **The depth is illustrative: assumed equal to the minor semi-axis.**
- **At infinity:** the same with `D = INF_PC`, and `C = 0`.
- Each is projected through the end points, `a = (P(c+A) − P(c−A))/2` and likewise `b` and `c`, giving the screen covariance `Σ = aaᵀ + bbᵀ + ccᵀ`.
- Its eigen-decomposition gives the on-screen ellipse: semi-axes in px and an angle.
- Seen from the Sun, `C` points at the camera and projects to ~0, so **the ellipse is exactly the catalogue's major, minor and PA**. From elsewhere it is a plausible ellipsoid silhouette; this is the 2-D covariance of Gaussian splatting.
- If an end point does not project (it is behind the camera), the item is `inside: true`. Its glow fades out, and the outline is not drawn.

**Unknown parts.**
- `minor` null → `minor = major`: a circle, which is how the Evidence outline draws it.
- `pa` null → the glow uses `PA = 180°·hashUnit(id, 'pa')` (the FNV-1a of §16.6), and the Evidence outline is a **dashed circle of radius major/2**, because the orientation is unknown.
- `major` null → a marker only.

**Brightness, all illustrative.**
- With a magnitude: `SB = mag + 2.5·log10(π·a′·b′)` (mag/arcmin², with a′ and b′ the semi-axes in arcmin), and `alpha = clamp(0.5·10^(−0.4(SB − 20)), 0.06, 0.5)`.
- With no magnitude: Sharpless `Bright` 1/2/3 → 0.08/0.14/0.22, else 0.10.
- Multiplied by `skyFade` for direction-only records.
- For placed records, multiplied by `fade = smoothstep(1, 3, dist / semi-major)`, so you see the stars, not a fog, once inside. `nearFade` is as for clusters.

**Other item fields.**
- `look` comes from the type:
  - `emission`: HII, EmN, Neb, Cl+N and Sharpless-only regions;
  - `reflection`: RfN;
  - `planetary`: PN;
  - `snr`: SNR;
  - `dark`: DrkN.
- `seed = hashUnit(id, 'look')`.
- `mode`: `glow` or `outline`.
- `markerOnly`: the major semi-axis is under 3 px. Most PNe are arcsec-sized, so they are markers until you get close.
- `hollow`, `dashed`, `atInfinity`.

#### 17.6.2 GL (`scene3d.js`, `scene3d-shaders.js`)

- **Program.** One new program, `nebula`. Each item is a screen-aligned quad covering 1.3× its ellipse, built on the CPU each frame from the item's screen centre and axes (tens per cone).
- **Fragment.** It computes the elliptical radius `ρ` from the quad's local coordinates.
- **Looks** (illustrative), with `fbm` = 3 octaves of value noise seeded by `seed`:

  | Look | Profile | Colour |
  |---|---|---|
  | `emission` | `smoothstep(1, 0.55, ρ)` × (0.55 + 0.45·fbm) | Hα rose |
  | `reflection` | the same, softer | blue |
  | `planetary` | annulus peaking at `ρ ≈ 0.7`, faint centre | teal core to red rim |
  | `snr` | thin shell at `ρ ≈ 0.9`, strongly noise-modulated (filaments) | orange, teal |
  | `dark` | the emission profile | none: drawn with **`blendFunc(ZERO, ONE_MINUS_SRC_ALPHA)` right after the Milky Way glow and before every glow and star**, so it darkens only the glow behind it |

- **Order and blending.** Emission, reflection, planetary and SNR are additive, with no depth write, drawn after the dark pass and the cluster glows and before the stars.
- **Evidence view** (`mode: outline`): a 1.5 px ellipse outline at `ρ = 1`, using the §16.10 ring code with an elliptical `ρ`. It is dashed for derived records and when the PA is unknown, plus the centre marker.
- **Outline mode is pure data.** No noise or colour other than the kind's marker colour.

#### 17.6.3 Registry spec `nebula`

| Field | Value |
|---|---|
| `layer`, `noun` | `nebulae`, `['nebula', 'nebulae']` |
| `frames` | `{ galaxy: 'billboard' }`, `billboard: 'nebula'` |
| `galaxyScope` | `'cone'` |
| `pick` | `{ priority: 26, marker: 17 }`, centre only (`PICK_PX`), like clusters |
| `label` | `key: (o) => (curated or common name ? 0 : 1000) − majorArcmin`, max 12 |
| `go` | `'fly-galaxy'`, `arrivePc = 3 ×` physical semi-major (placed); `'look'` for direction-only (§17.5) |
| `color` | per look (marker colour) |
| `card` | type; distance (method, range), or "unknown · drawn on the sky as seen from the Sun"; angular size "90′ × 60′, PA 30°" (or "PA unknown"); physical size (inferred, placed only); V/B magnitude; Sharpless morphology; central star (PNe); "From you" (placed only); "Look: illustrative, generated from its type and size" (`illustrative`, dropped in the Evidence view). Notes: derived distance ("Distance from the stars of its star-forming complex (Russeil 2003)…"), direction-only, PA unknown. |

#### 17.6.4 Real image billboards: follow-up

**Preference for later work (approval condition 4):** images with proper sky alignment, i.e. tiled sky surveys (HiPS)
with a licence that allows redistribution, come before press images, which need hand registration.

Research findings (licence pages read 2026-11-18):
- **ESA/Hubble and ESA/Webb** are CC BY 4.0: reproduction without fee, cropping is "not a significant change", commercial use allowed, unaltered credit ("ESA/Hubble") required, no logos.
- **SDSS** is CC BY 4.0, "any purpose".
- **NASA** material is not copyrighted in the US, except third-party items.
- **DSS / DSS2** is CC BY-NC-SA 4.0 (MAST): **excluded**, as NC blocks any later commercial use. This also rules out DSS-based HiPS cut-outs via hips2fits.
- **Mellinger** is all rights reserved; **Pan-STARRS** terms are unclear.

So a source exists, and Phase 2 still ships procedural looks. Real images need:
- per-object curation;
- registration on the sky from each image's AVM/WCS metadata (Hubble press images are arcminutes across and rotated);
- a per-image provenance record: source URL, archive, licence and URL, retrieval date, verbatim credit, modifications, a no-logo check, third-party items.

That is a feature of its own, recorded in §17.15.

### 17.7 Schema and validator changes (changes §2, §3, §6)

All additive; the schema stays at version 1.

1. **`HOSTED_KINDS = ("exoplanet", "black_hole")`**. A `black_hole` tile record is either `fixed` with `host: null` (Sgr A*, GRS 1915+105) or a hosted `orbit` with `host_radec` (§16.3 rules).
2. **Direction-only guards** (`fixed`, `dist: null`): `host` must be null, `method` must be null, and `size.radius` must be null **unless its tier is `measured` or `catalogue`**. A radius at those tiers is an independent measurement of the object's own size; an inferred or illustrative one could only be made up without a distance. The design first said `size.radius` must always be null, but 19 of the 28 direction-only NEA host stars carry a catalogue stellar radius, so the rule was narrowed at implementation. `--check` on every existing dataset proves the narrowed rule holds.
3. **Orbit tier floor:** an `orbit` position's `tier` may not be stronger than its weakest element tier (measured = catalogue > inferred > illustrative). BH3's inferred `a_au` therefore makes it `derived`. NEA orbits are all `illustrative` already.
4. **`render.style`**, when present, must be in `RENDER_STYLES = ("lensing",)`, and `lensing` only on `black_hole`. It stays a hint, never data.
5. **`prefer_record`** (star records, optional): exactly `{"replace": [<field>, ...], "reason": <non-empty string>}`. Allowed only
   - on `kind: star`;
   - on an id in **`PREFER_RECORD_IDS`**, a tuple in `objects.py` listing the seven companions of §17.8 explicitly. Any other id is rejected, so this cannot grow into a general override mechanism without a reviewed code change;
   - with a `dist` of tier `measured` or `catalogue`.

   `replace` lists exactly the fields replaced, from **`PREFER_RECORD_FIELDS = ("dist", "mass", "radius", "teff")`**, distinct and in that order, always including `"dist"`. Each named stellar parameter must be in the record (`props.mass`, `size.radius`, `props.teff`) with a `src`. Nothing else (sky position, epoch, Gaia identity, photometry) may be named. **Changed 2026-11-19:** `replace` was the string `"dist"`; it became a field list so the companions also take their papers' stellar parameters instead of Gaia's single-star ones (§17.18).
6. **Props tiers.** No new rule. Each build test asserts its own: a nebula's `size.radius` is `inferred`, and a black hole's event-horizon `size.radius` is `inferred`, never `measured`.

### 17.8 Black holes: `bh-curated`

**Curated source** `backend/data/sources/bh-curated/black_holes.json`. I write it from the research notes. The build script refuses any number without `src` (author, year, journal, arXiv id) and `where`, and copies `src + where` into each Quantity's `src` ("El-Badry et al. 2023, MNRAS 518, 1057 (arXiv:2209.06833), Table 1").

| Record | Position | Distance (method → evidence) | Mass | Placement |
|---|---|---|---|---|
| `bh:Sgr A*` | VLBI J2000 17 45 40.0409 −29 00 28.118 (Reid & Brunthaler 2004/2020) | GRAVITY 2022 (A&A 657, L12): R₀ = 8277 ± 9 pc (stat; "≈30 pc" sys in src), `orbit-fit` → measured | 4.297 ± 0.012 × 10⁶ M☉ (same) | `fixed`, `host: null`, `parent: null` |
| `bh:Gaia BH1` | host Gaia DR3 4373465352415301632 | companion: paper parallax 2.09 ± 0.02 mas → 478.5 (473.9–483.1) pc, `parallax` | 9.62 ± 0.18 (Table 1, joint fit) | hosted `orbit`, **measured** |
| `bh:Gaia BH2` | host Gaia DR3 5870569352746779008 | 0.859 ± 0.018 mas → 1164 pc | 8.94 ± 0.34 (Table 2) | hosted `orbit`, **measured** |
| `bh:Gaia BH3` | host Gaia DR3 4318465066420528000 | 590.6 ± 5.8 pc (Panuzzo et al. 2024, text) | 32.70 ± 0.82 | hosted `orbit`, **derived** (a scaled from a₁; preliminary NSS solution, noted) |
| `bh:Cyg X-1` | host Gaia DR3 2059383668236814720 | VLBA 2.22 (+0.18/−0.17) kpc (Miller-Jones et al. 2021) | 21.2 ± 2.2 | hosted `orbit`, **illustrative** (Ω only a jet-alignment prior; phase epoch not printed) |
| `bh:V404 Cyg` | host Gaia DR3 2056188624872569088 | VLBA 2.39 ± 0.14 kpc (Miller-Jones et al. 2009) | 9.0 (+0.2/−0.6) (Khargharia et al. 2010) | hosted `orbit`, illustrative |
| `bh:A0620-00` | host Gaia DR3 3118721026600835328 (Gandhi et al. 2019's DR2 source, same id in DR3, 0.13 mas) | Gaia DR3 parallax 0.697 ± 0.117 mas (S/N 6) → `parallax`, measured. **Not** Cantrell's 1.06 kpc, which is modelled. | 6.61 ± 0.25 (Cantrell et al. 2010) | hosted `orbit`, illustrative |
| `bh:MAXI J1820+070` | host Gaia DR3 4477902563164690816 | VLBA 2.96 ± 0.33 kpc (Atri et al. 2020) | 8.48 (+0.79/−0.72) (Torres et al. 2020, jet inclination) | hosted `orbit`, illustrative |
| `bh:GRS 1915+105` | VLBA J2000 19 15 11.5473 +10 56 44.704 (Reid et al. 2014) | 8.6 (+2.0/−1.6) kpc, `parallax` → measured | 12.4 (+2.0/−1.8) (same) | `fixed`, `host: null`: no Gaia counterpart within 2″ |

**Orbit elements of hosted black holes.**
- **Gaia BH1–3: the black hole relative to its companion.**
  - The papers give the luminous star's orbit in the Gaia/Halbwachs Thiele–Innes convention. BH2 prints it: `A = a₀(cosω cosΩ − sinω sinΩ cos i)` and so on, with north offset `AX + FY`, east offset `BX + GY`, and z positive away from the observer (RV positive receding).
  - That is exactly the §16.6 sky-plane formula with `u = ω + ν` for the star relative to the barycentre. The black hole relative to the star is the negative of the star relative to the black hole.
  - In the §16.6 evaluator (Z toward the observer) that is the same orbit with **`node_deg = Ω + 180°`**, the same `omega_deg` and `i_deg`, and the relative semi-major axis. The evaluator's Z sign absorbs the line-of-sight flip.
  - **This derivation is written into the record's `src`**, and a test checks it numerically against the Thiele–Innes formulas.
- **Elements:**

  | | P (d) | e | i (°) | Ω (°) | ω (°) | T_p | a_rel (AU) |
  |---|---|---|---|---|---|---|---|
  | BH1 | 185.59 ± 0.05 | 0.451 ± 0.005 | 126.6 ± 0.4 | 97.8 ± 1.0 | 12.8 ± 1.1 | −1.1 ± 0.7, JD−2457389 → MJD 57387.4 | 1.40 ± 0.01 |
  | BH2 | 1276.7 ± 0.6 | 0.5176 ± 0.0009 | 34.87 ± 0.34 | 266.9 ± 0.5 | 130.9 ± 0.4 | 49.3 ± 1.4, JD−2457389 | 4.96 ± 0.08 |
  | BH3 | 4253.1 ± 98.5 | 0.7291 ± 0.0048 | 110.580 ± 0.095 | 136.236 ± 0.128 | 77.34 ± 0.76 | JD 2458177.39 ± 0.88 (TCB) | a₁ = 16.17 ± 0.27 → `a₁(M_BH + M★)/M_BH`, `inferred` |

  - BH1 and BH2 come from the joint (astrometry + RV) fit in Table 1 / Table 2.
  - BH3 comes from Table 2, "Combined solution".
  - Gaia times are TCB; the difference from TDB (about 20 s) is irrelevant here.
- **X-ray binaries.**
  - `period_d` is measured: Cyg X-1 5.599829 ± 0.000016 (Brocksopp et al. 1999); V404 Cyg 6.471170 ± 0.000002 (Casares et al. 2019, Table 3); A0620-00 0.3230160 (held fixed by Cantrell et al. 2010, from Johannsen et al. 2009; no error, tier `catalogue`); MAXI J1820+070 0.68549 ± 0.00001 (Torres et al. 2019).
  - `i_deg`: Cyg X-1 27.51 (Miller-Jones et al. 2021, Table 1); V404 Cyg 67 (+3/−1); A0620-00 50.98 ± 0.87; MAXI J1820+070 63 ± 3 (jet; Atri et al. 2020).
  - `e`: Cyg X-1 0.0189 (68 %: 0.0163–0.0217; Miller-Jones et al. 2021, Table 1, the same fit as its i); A0620-00 0, illustrative ("assumed circular", Cantrell et al. 2010); V404 Cyg and MAXI J1820+070 0, illustrative (none published). An assumed value carries `tier: illustrative` and an `assumed` reason in the curated file, never a paper citation it does not have.
  - `a_au`: Kepler III from P and the summed masses, `inferred`. Companion masses: Cyg X-1 40.6 (+7.7/−7.1); A0620-00 0.40 ± 0.045; MAXI J1820+070 0.61 (+0.13/−0.12); V404 Cyg `q·M_BH` with q = 0.06, `inferred`.
  - `node_deg`: null. `phase_known: false`. Position tier `illustrative`.

**Companion `star` records** (seven; `kind: star`):
- Id `gdr3:<id>`.
- **SIMBAD cross-check** (Harvard mirror, 2026-11-18): each Gaia DR3 id resolves to the expected object.

  | Black hole | Companion Gaia DR3 | SIMBAD main id (type) | Name used |
  |---|---|---|---|
  | Gaia BH1 | 4373465352415301632 | GALEX J172841.0-003451 (SB*) | "Gaia BH1 companion" |
  | Gaia BH2 | 5870569352746779008 | UCAC4 154-126202 (SB*) | "Gaia BH2 companion" |
  | Gaia BH3 | 4318465066420528000 | LS II +14 13 (SB?) | "LS II +14 13" |
  | Cyg X-1 | 2059383668236814720 | HD 226868 (HXB) | "HD 226868" |
  | V404 Cyg | 2056188624872569088 | V* V404 Cyg (HXB) | "V404 Cyg" |
  | A0620-00 | 3118721026600835328 | 1A 0620-00 = V* V616 Mon (HXB) | "V616 Mon" |
  | MAXI J1820+070 | 4477902563164690816 | MAXI J1820+070 (LXB) | "MAXI J1820+070 companion" |

  The name's src is "SIMBAD (simbad.cfa.harvard.edu mirror), 2026-11-18". GRS 1915+105 has no Gaia DR3 entry in SIMBAD either.
- Position from the committed Gaia DR3 snapshot, epoch 2016.
- `dist` as in the table above, `method: parallax`. **The distance of a system is stored once, on the companion.** The hosted black hole has no distance of its own and is placed from its host, so the two cannot differ (approval condition 3).
- **`prefer_record: {"replace": ["dist", …], "reason": …}`**, with a reason per star, e.g. "The single-star Gaia solution ignores the 1,277-day orbit (RUWE 8.0), which biases its parallax; El-Badry et al. 2023 fit the parallax and the orbit together". For A0620-00 the curated value is the inverse of the same Gaia DR3 parallax, as cited; the reason says that the star layer's Bailer-Jones distance adds a Galactic prior.
- **`props.gaia_parallax`**: the single-star Gaia DR3 parallax from the snapshot, `{v, lo, hi, unit: "mas", src: "Gaia DR3 single-star solution (RUWE r)", tier: "measured"}`. The card shows it, with its inverse in pc, as "not used".
- `props`: `teff`, `radius`, `mass` and `spectral_type`/description as printed (e.g. BH1 5850 ± 50 K, 0.99 ± 0.05 R☉, 0.93 ± 0.05 M☉), and `gmag` from Gaia.
- **`replace` lists `dist` plus each of `mass`, `radius`, `teff` the paper prints** (the curated file carries exactly those): Gaia BH1, BH2 and LS II +14 13 replace all four; HD 226868, V616 Mon and the MAXI J1820+070 companion `dist` and `mass`; V404 Cyg `dist` only. `build_objects_bh.py` derives the list from the curated file, and a test checks it against the file.
- `render.mag` = G.

**How `prefer_record` is applied (frontend).** A pure function, `preferredStarDistance(rec)`, returns
`{ pc, lo, hi, src, tier, notUsed: { plxMas, pc, reason } }` or null.
- When the star payload holds the star (`gdr3:<id>` is loaded), `_rebuildStars` keeps the Gaia row's sky position and apparent G and replaces only its distance (and the absolute magnitude derived from it) with the record's. The meta keeps the Gaia (Bailer-Jones) distance as `gaiaPc` for the card.
- When the payload lacks the star (outside the star cone, or below the payload's parallax S/N cut, as for V404 Cyg and MAXI J1820+070), the record is appended as today, at the same position and distance.
- **The star card** shows `Distance` = the curated value with its paper (its own tier), and a row **"Gaia single-star distance · not used"**: the parallax and its inverse (and the Bailer-Jones value when the payload has one), followed by the reason.
- **Stellar parameters** (`mergeStarSystem`): each parameter in `replace` is the record's value whatever the tiers (the general rule keeps Gaia's on a tie), and Gaia's GSP-Phot/FLAME value is listed under it as **"Gaia single-star \<temperature | radius | mass\> · not used"**, with a note saying why. A Gaia value the paper does not replace (luminosity, age, spectral type, or Teff and radius for the X-ray binaries) stays, with the note "\<Params\>: Gaia single-star model; may be biased for this binary." The renderer draws the star (size, colour, surface) from the same star model as the card, so the picture and the card agree.
- Hosted black holes resolve through the same key, so the black hole sits at its companion's curated distance in both cases.

**Black hole `props`:**
- `mass` (Msun, with interval);
- `type` ("supermassive" | "stellar-mass");
- `state` ("dormant: no accretion detected" for Gaia BH1–3; "X-ray binary (accreting)"; "low-luminosity accretion" for Sgr A*);
- `companion_mass`;
- `companion` (text).

**`size.radius`:** the Schwarzschild radius `r_s = 2GM/c² = 2.953250 km · M/M☉`, `inferred`, src "Schwarzschild radius from the mass (non-rotating)". Sgr A*: 1.269 × 10⁷ km. BH1: 28.4 km.

**Sgr A\*'s parent and the Milky Way record.** (**Phase 3 change, §18.7:** the parent is `gal:milky_way`; eight supermassive black holes join, §18.8.) Sgr A*'s `parent` is `null` in Phase 2. Phase 3 adds `gal:milky_way` (the cosmos frame needs it as the collapsed-galaxy billboard, §8) and sets Sgr A*'s parent to it in `bh-curated`. That is a one-line data change.

### 17.9 The `lensing` renderer

**Frames.**
- Sgr A* and GRS 1915+105: `{ galaxy: 'lensing' }`.
- Hosted black holes: `{ system: 'lensing', galaxy: 'marker' }`. In the galaxy frame they group with their host like exoplanets: "Gaia BH1 companion · 1 black hole".

**Data** (`lensingItems(visible, cam, { evidence, pxPerRad, project })`, pure):
- `rShadow = 2.598 · r_s`, the photon-capture radius √27·GM/c², from `size.radius`.
- `truePx = atan(rShadow / dist) · pxPerRad` and `px = max(truePx, LENS_MIN_PX = 9)`.
- `enlarged = truePx < LENS_MIN_PX`, with `factor = LENS_MIN_PX / truePx` for the card.
- `disc = state is accreting`, and `incl` from `i_deg` when known, else 60° (illustrative).

**GL.** A screen-space quad of radius `4·px`, drawn after the stars with normal "over" blending:
- a black disc at `ρ < 1`, which hides the stars behind it;
- a thin photon ring at `ρ ≈ 1`;
- a soft halo out to `ρ ≈ 2.5`;
- for `disc`, an inclined annulus from `ρ = 1.5` to `4`, brighter on one side (illustrative Doppler beaming).

True gravitational lensing of the background (sampling the framebuffer) is a follow-up.

**Phase 3 change (§18.8.3):** reused at Mpc for supermassive black holes, always enlarged there; the radius goes through `unitsPerPc(cam)`.

**Size honesty.**
- Inside Gaia BH1's system frame (AU units, camera range down to 1e-6 AU = 150 km), its 28 km horizon reaches true size at about 1,000 km.
- Everywhere else the look is enlarged, and the card says so: "Drawn enlarged ×3e9: its shadow would be 3e-9 px from here."
- All rows about the look are `illustrative`.

**Evidence view.** The marker only (solid for measured, hollow for derived). No disc, ring or halo.

**Card.** Type, state, mass, distance (method), event horizon (r_s, inferred), orbit (period, e, i, from its companion now), companion, the look row and "From you". Notes: enlargement, "the disc and ring are illustrative", and the orbit's evidence.

**Host card.** The child list is generalised from "Exoplanets · N" to per-kind headings from the registry nouns ("Black holes · 1"). `hostCountText` already uses nouns.

### 17.10 Evidence and tiers of every new field

| Field | Tier | Record evidence |
|---|---|---|
| nebula position (direction) | `catalogue` | `measured` (direction-only) |
| PN distance (Chornay & Walton 2021 parallax, S/N ≥ 5) | `measured` | `measured` |
| HII-complex stellar distance (Russeil 2003) | `inferred` | `derived` (hollow marker, dashed outline) |
| `size.angular` (OpenNGC / Sharpless) | `catalogue` | — |
| nebula `size.radius` (angular × distance) | `inferred` | — |
| nebula look (colour, noise, depth axis, assumed PA) | illustrative, by renderer; card row `illustrative` | hidden in the Evidence view |
| Sgr A* position, R₀, mass | `measured` | `measured` |
| Gaia BH1–2 orbit elements | `measured` (joint fit) | `measured` |
| Gaia BH3 `a_au` | `inferred` | `derived` |
| XRB period / i / e | `measured` / `measured` / `measured` or `illustrative` (assumed 0) | `illustrative` (Ω unknown) |
| XRB `a_au` (Kepler III) | `inferred` | — |
| companion distances | `measured` (parallax) | star records `measured` |
| event horizon `size.radius` | `inferred` | — |
| lensing look | illustrative; Evidence view marker only | — |

### 17.11 Layers and HUD

```js
registerLayer({ id: 'nebulae', label: 'Nebulae', group: 'beyond' });
registerLayer({ id: 'blackHoles', label: 'Black holes', group: 'beyond' });
```

- Persisted in `blink.scene3d.layers` like the rest; defaults on. A layer with no data says why.
- **HUD (`scene3d-main.js:120`).** The hard-coded `['exoplanet', 'cluster']` becomes "every registered kind whose layer is in group `beyond`", so later kinds need no edit here.
- **Direction-only counts:** "12 nebulae (8 direction only)".

### 17.12 Example records

These are stored as `backend/tests/fixtures/objects/examples/*.json` and validated by the schema tests. The build tests assert that the built records for these ids equal them, so the doc cannot drift. Numbers are from the snapshot rows quoted in §17.3–§17.8, with the precision the build writes. Where the build's rounding differs in the last digit, the fixture follows the build and this section is updated in the same commit.

**M57, the Ring Nebula** (OpenNGC + Chornay & Walton 2021: measured):
```json
{
  "id": "ongc:NGC6720", "kind": "nebula", "name": "Ring Nebula",
  "designations": ["M 57", "NGC 6720", "PN G063.1+13.9", "IRAS 18517+3257"],
  "host": null, "parent": null,
  "position": { "model": "fixed", "ra": 283.395875, "dec": 33.0285833, "epoch": 2000.0, "method": "parallax", "tier": "catalogue",
    "dist": { "v": 787.65, "lo": 761.41, "hi": 815.77, "unit": "pc", "src": "Chornay & Walton 2021, A&A 656, A110, tablea1: central star Gaia EDR3 2090486618786534784, plx 1.2696 ± 0.04376 mas (no zero-point correction)", "tier": "measured" } },
  "size": { "radius": { "v": 0.1455, "unit": "pc", "src": "from angular size and distance", "tier": "inferred" },
            "angular": { "major": { "v": 1.27, "unit": "arcmin", "src": "OpenNGC v20260501", "tier": "catalogue" }, "minor": null, "pa": null } },
  "props": {
    "type": { "v": "Planetary nebula", "src": "OpenNGC v20260501 (PN)", "tier": "catalogue" },
    "vmag": { "v": 8.8, "unit": "mag", "src": "OpenNGC v20260501", "tier": "catalogue" },
    "bmag": { "v": 9.7, "unit": "mag", "src": "OpenNGC v20260501", "tier": "catalogue" },
    "central_star": { "v": "Gaia EDR3 2090486618786534784", "src": "Chornay & Walton 2021 (Rel 0.99997, RUWE 1.07)", "tier": "catalogue" }
  },
  "provenance": { "source": "static:nebulae", "dataset": "nebulae", "catalogue": "OpenNGC + Sharpless (VII/20)", "version": "OpenNGC v20260501 (36cb178a)" },
  "evidence": "measured",
  "render": { "mag": 8.8 }
}
```

**M42, the Orion Nebula** (OpenNGC NGC1976 merged with Sh2-281; Russeil 2003 stellar distance: derived). Only the parts that differ in shape:
```json
{ "id": "ongc:NGC1976", "name": "Orion Nebula",
  "designations": ["M 42", "NGC 1976", "Sh2-281", "LBN 974", "MWSC 0582", "Great Orion Nebula"],
  "position": { "model": "fixed", "ra": 83.8186667, "dec": -5.3896667, "epoch": 2000.0, "method": "photometric", "tier": "catalogue",
    "dist": { "v": 400, "lo": 360, "hi": 440, "unit": "pc", "src": "Russeil 2003, A&A 397, 133, table3: stellar distance of complex 208.0-19.0 (Sh2-281)", "tier": "inferred" } },
  "size": { "angular": { "major": { "v": 90, "unit": "arcmin", "src": "OpenNGC v20260501", "tier": "catalogue" },
                         "minor": { "v": 60, "unit": "arcmin", "src": "OpenNGC v20260501", "tier": "catalogue" }, "pa": null } },
  "props": { "type": { "v": "Cluster with nebula", "src": "OpenNGC v20260501 (Cl+N)", "tier": "catalogue" },
             "sh2_form": { "v": "irregular", "src": "Sharpless 1959 (VII/20) Form 3", "tier": "catalogue" } },
  "evidence": "derived", "render": { "mag": 4.0 } }
```

**M1, the Crab Nebula** (SNR; merged with Sh2-244; no adopted distance, so direction-only):
```json
{ "id": "ongc:NGC1952", "name": "Crab Nebula", "designations": ["M 1", "NGC 1952", "Sh2-244", "LBN 833", "IRAS 05315+2158"],
  "position": { "model": "fixed", "ra": 83.6332083, "dec": 22.0144722, "epoch": 2000.0, "tier": "catalogue", "dist": null },
  "size": { "radius": null, "angular": { "major": { "v": 8, "unit": "arcmin", "src": "OpenNGC v20260501", "tier": "catalogue" },
                                         "minor": { "v": 4, "unit": "arcmin", "src": "OpenNGC v20260501", "tier": "catalogue" }, "pa": null } },
  "props": { "type": { "v": "Supernova remnant", "src": "OpenNGC v20260501 (SNR)", "tier": "catalogue" } },
  "evidence": "measured", "render": { "mag": 8.4 } }
```
(OpenNGC notes "Position is for the Crab pulsar"; the card shows it.)

**Sagittarius A\*:**
```json
{
  "id": "bh:Sgr A*", "kind": "black_hole", "name": "Sagittarius A*", "designations": ["Sgr A*"],
  "host": null, "parent": null,
  "position": { "model": "fixed", "ra": 266.4168371, "dec": -29.0078106, "epoch": 2000.0, "method": "orbit-fit",
    "dist": { "v": 8277, "lo": 8268, "hi": 8286, "unit": "pc", "src": "GRAVITY Collaboration 2022, A&A 657, L12 (arXiv:2112.07478), Sec. 4: R0 = 8277 ± 9 pc (statistical; systematic ≈ 30 pc)", "tier": "measured" } },
  "size": { "radius": { "v": 12690000, "lo": 12655000, "hi": 12726000, "unit": "km", "src": "Schwarzschild radius from the mass (non-rotating)", "tier": "inferred" }, "angular": null },
  "props": {
    "mass": { "v": 4297000, "lo": 4285000, "hi": 4309000, "unit": "Msun", "src": "GRAVITY Collaboration 2022, A&A 657, L12 (arXiv:2112.07478), Sec. 4 (statistical; systematic ≈ 40,000 Msun)", "tier": "measured" },
    "type": { "v": "supermassive", "src": "curated", "tier": "catalogue" },
    "state": { "v": "low-luminosity accretion", "src": "curated", "tier": "catalogue" }
  },
  "provenance": { "source": "static:bh-curated", "dataset": "bh-curated", "catalogue": "Space Maps curated black holes", "version": "1" },
  "evidence": "measured",
  "render": { "style": "lensing" }
}
```
The position src is "Reid & Brunthaler 2004, ApJ 616, 872 / 2020, ApJ 892, 39: J2000 17 45 40.0409 −29 00 28.118".

**Gaia BH1** (hosted, measured orbit):
```json
{
  "id": "bh:Gaia BH1", "kind": "black_hole", "name": "Gaia BH1", "designations": [],
  "host": "gdr3:4373465352415301632", "parent": "gdr3:4373465352415301632",
  "position": { "model": "orbit", "host_radec": [262.1712073, -0.581092], "phase_known": true, "tier": "measured",
    "src": "El-Badry et al. 2023, MNRAS 518, 1057 (arXiv:2209.06833), Table 1, astrometry + RVs; black hole relative to its star: node = Ω + 180°",
    "elements": {
      "period_d":   { "v": 185.59, "lo": 185.54, "hi": 185.64, "unit": "d", "src": "El-Badry et al. 2023, Table 1", "tier": "measured" },
      "a_au":       { "v": 1.40, "lo": 1.39, "hi": 1.41, "unit": "au", "src": "El-Badry et al. 2023, Table 1 (relative orbit)", "tier": "measured" },
      "e":          { "v": 0.451, "lo": 0.446, "hi": 0.456, "src": "El-Badry et al. 2023, Table 1", "tier": "measured" },
      "i_deg":      { "v": 126.6, "lo": 126.2, "hi": 127.0, "unit": "deg", "src": "El-Badry et al. 2023, Table 1", "tier": "measured" },
      "node_deg":   { "v": 277.8, "lo": 276.8, "hi": 278.8, "unit": "deg", "src": "El-Badry et al. 2023, Table 1: Ω = 97.8 ± 1.0 (luminous star) + 180°", "tier": "measured" },
      "omega_deg":  { "v": 12.8, "lo": 11.7, "hi": 13.9, "unit": "deg", "src": "El-Badry et al. 2023, Table 1", "tier": "measured" },
      "t_peri_mjd": { "v": 57387.4, "lo": 57386.7, "hi": 57388.1, "src": "El-Badry et al. 2023, Table 1: T_p = −1.1 ± 0.7 (JD − 2457389, TCB)", "tier": "measured" },
      "t_conj_mjd": null } },
  "size": { "radius": { "v": 28.41, "lo": 27.88, "hi": 28.94, "unit": "km", "src": "Schwarzschild radius from the mass (non-rotating)", "tier": "inferred" }, "angular": null },
  "props": {
    "mass": { "v": 9.62, "lo": 9.44, "hi": 9.8, "unit": "Msun", "src": "El-Badry et al. 2023, Table 1 (black hole mass M2)", "tier": "measured" },
    "companion_mass": { "v": 0.93, "lo": 0.88, "hi": 0.98, "unit": "Msun", "src": "El-Badry et al. 2023, Table 1", "tier": "measured" },
    "type": { "v": "stellar-mass", "src": "curated", "tier": "catalogue" },
    "state": { "v": "dormant: no accretion detected", "src": "El-Badry et al. 2023", "tier": "catalogue" }
  },
  "provenance": { "source": "static:bh-curated", "dataset": "bh-curated", "catalogue": "Space Maps curated black holes", "version": "1" },
  "evidence": "measured",
  "render": { "style": "lensing" }
}
```

**Its companion:**
```json
{ "id": "gdr3:4373465352415301632", "kind": "star", "name": "Gaia BH1 companion",
  "designations": ["Gaia DR3 4373465352415301632", "GALEX J172841.0-003451", "2MASS J17284110-0034514"],
  "same_as": [], "host": null, "parent": null,
  "prefer_record": { "replace": ["dist", "mass", "radius", "teff"], "reason": "The single-star Gaia solution ignores the 186-day orbit, which biases its parallax; El-Badry et al. 2023 fit the parallax and the orbit together." },
  "position": { "model": "fixed", "ra": 262.1712073, "dec": -0.581092, "epoch": 2016.0, "method": "parallax",
    "dist": { "v": 478.47, "lo": 473.93, "hi": 483.09, "unit": "pc", "src": "El-Badry et al. 2023, Table 1: parallax 2.09 ± 0.02 mas (orbit-corrected)", "tier": "measured" } },
  "size": { "radius": { "v": 0.99, "lo": 0.94, "hi": 1.04, "unit": "Rsun", "src": "El-Badry et al. 2023, Table 1", "tier": "catalogue" }, "angular": null },
  "props": { "teff": { "v": 5850, "lo": 5800, "hi": 5900, "unit": "K", "src": "El-Badry et al. 2023, Table 1", "tier": "catalogue" },
             "mass": { "v": 0.93, "lo": 0.88, "hi": 0.98, "unit": "Msun", "src": "El-Badry et al. 2023, Table 1", "tier": "catalogue" },
             "gmag": { "v": 13.772, "unit": "mag", "src": "Gaia DR3", "tier": "measured" },
             "gaia_parallax": { "v": 2.07, "lo": 1.9533, "hi": 2.1867, "unit": "mas", "src": "Gaia DR3 single-star solution (RUWE from the snapshot)", "tier": "measured" } },
  "provenance": { "source": "static:bh-curated", "dataset": "bh-curated", "catalogue": "Space Maps curated black holes", "version": "1" },
  "evidence": "measured", "render": { "mag": 13.772 } }
```

The companion's `gaia_parallax`, `gmag` and position come from the committed Gaia snapshot. Where they differ in the last
digit, the fixture follows the build (§17.12 preamble).

These replace the hypothetical black-hole example in §10.

### 17.13 Test plan

**Backend** (`uv run pytest`, offline):
- **`test_objects_schema.py`**
  - The §17.12 examples validate.
  - Each new rule rejects its counter-example:
    - a direction-only record with a host, a method or a `size.radius`;
    - an orbit whose tier is stronger than an inferred element;
    - `render.style: 'lensing'` on a nebula, and an unknown style;
    - `prefer_record` that is not exactly `{replace: [fields], reason}` (a field outside `PREFER_RECORD_FIELDS`, no `dist`, a repeat, the wrong order, or a named field the record lacks), on an id not in `PREFER_RECORD_IDS`, on a non-star, or with an inferred distance.
  - A hosted `black_hole` orbit is accepted.
- **`test_objects_static.py`**
  - A hosted `black_hole` is tiled by `host_radec`.
  - Direction-only records are found by cone and extent.
  - A cone inside a 20° record's disc but 9° from its centre finds it (`max_extent_deg`).
- **`test_build_nebulae.py`** (synthetic rows plus the committed snapshot):
  - CSV quoting with `;`;
  - Dup folding (NGC 2244 → NGC 2239);
  - NonEx dropped;
  - type mapping;
  - B1900 → ICRS precession against a known row;
  - every merge-rule step (identifier, override, positional, cap, size guard, conflict fallback), with the §17.3 expected pairs asserted on the snapshot;
  - the size rule (IC 1396 takes Sharpless's 170′);
  - the PN cuts (each cut drops its row);
  - Russeil linking (numeric join, 1° filter, stellar only, never on SNR/PN/RfN/DrkN; the Crab stays direction-only);
  - the 1° filter on known regions: Orion 350–500 pc, M8 (`S25`) 1.0–1.8 kpc, the Rosette (Sh2-275) 1.3–1.8 kpc, and the report's count of dropped links;
  - the licence: `LICENSE.md` exists in both nebula folders, and `manifest.provenance` has `credit`, `licence_name: "CC BY-SA 4.0"` and the licence URL;
  - the §17.12 records equal the built ones;
  - byte-identical rebuild and `--check`;
  - the build report counts.
- **`test_build_bh.py`**
  - Every curated number has `src` and `where`, and a missing one fails the build.
  - r_s from the mass.
  - The Ω + 180° conversion: the BH's sky offset from the §16.6 formula equals minus the star's offset from the Thiele–Innes formulas (BH2's eqs. 3–6) at 5 epochs.
  - BH3 is `derived`; the X-ray binaries are `illustrative`.
  - Exactly the seven companions carry `prefer_record`, all in `PREFER_RECORD_IDS`; each has `gaia_parallax` and a reason.
  - No hosted black hole has a distance of its own (one stored distance per system).
  - BH2's companion: curated distance ≈ 1,164 pc, and `1000 / gaia_parallax` ≈ 1.49 kpc (not used).
  - Gaia BH1 and Sgr A* equal §17.12.
  - `--check`.
- **`test_objects_api.py`**
  - Both datasets merge through `SPHEREX_OBJECTS_DIR` (fixtures built from synthetic rows).
  - The Orion cone returns M42 with `in_cone: true`.
  - A cone 9° from Barnard's Loop's centre returns it.
  - The Cyg X-1 cone returns the BH and its star record.
  - `--check` on **every** dataset (`nea-exoplanets`, `hr23-clusters`, `nebulae`, `bh-curated`) under the new validator.

**Frontend** (`node --test`):
- **`scene3d-objects.test.mjs`**
  - Direction-only entries are visible in the galaxy frame with `atInfinity`, never in a system frame.
  - `framePos` is independent of the camera position.
  - `skyFade` at 0, 800 and 5,000 pc.
  - No labels or picks below 0.25.
  - `planGo` → `look`; `fromYou` null.
  - `nebulaItem`:
    - from the Sun, the screen ellipse equals major, minor and PA to 1e-6 (several PAs, near the pole);
    - a placed nebula seen side-on shows the depth axis;
    - unknown minor → circle;
    - unknown PA → hashed glow PA and a dashed outline;
    - the brightness mapping;
    - `markerOnly` under 3 px;
    - the `inside` fade;
    - `look` per type.
  - `lensingItems`: true size against `LENS_MIN_PX`, the `enlarged` factor, `disc` by state, and marker-only in the Evidence view.
  - Hosted BH placement through the orbit branch, grouping with its host ("Gaia BH1 companion · 1 black hole"), and `childrenOf`.
  - `preferredStarDistance`: BH2's companion gives ≈ 1,164 pc and `notUsed.pc` ≈ 1.49 kpc; a record without `prefer_record` gives null; only the distance changes (the Gaia row's direction is kept).
  - The hosted black hole and its companion are at the same distance from the Sun (within the orbit offset), whether or not the Gaia star is loaded.
  - The credits line: datasets with a `credit` that returned records are listed; datasets without one, or with no records in the cone, are not.
  - HUD kind list from group `beyond`.
- **`scene3d-registry.test.mjs`**
  - The `nebulae` and `blackHoles` layers in group `beyond`, and persistence.
  - Nebula card rows for placed, derived and direction-only records, with tiers, and the illustrative look row dropped in the Evidence view.
  - Black-hole card rows: mass, r_s inferred, the enlargement note, and the orbit rows with their evidence.
  - Nebula card `Data` row (credit and licence).
  - The star card for a `prefer_record` star: the curated distance with its paper, and the "not used" Gaia row with the reason.
  - The host card's generic child headings.

**By hand** (the real app, backend restarted, headless Chromium as in Step 0). Patches:
- Orion (83.82, −5.39);
- M57 (283.396, 33.029);
- Crab (83.633, 22.015);
- Galactic Centre (266.417, −29.008);
- Cyg X-1 (299.590, 35.202);
- Gaia BH1 (262.171, −0.581);
- a cone inside Barnard's Loop.

In each, check:
- markers and labels, cards, billboards and the lensing look;
- direction-only behaviour: fixed on the sky while flying, fading with distance from the Sun, "Turn to it";
- layer toggles and their persistence;
- the Evidence view: outlines, markers only, hollow derived markers, X-ray binaries hidden but counted;
- that stars, solar objects, exoplanets and clusters are unchanged;
- frame time (as far as software rendering allows).

### 17.14 Work split

`scene3d.js` has one owner at a time; C1 and C2 run one after the other.

| Slice | Model | Files (exclusive) | Depends on |
|---|---|---|---|
| A. Schema and nebula build | Sonnet | `objects.py`, `objects_static.py`, `backend/scripts/build_objects_nebulae.py`, `backend/data/sources/nebulae/**` and `frontend/data/objects/nebulae/**` (both with `LICENSE.md`), `test_objects_schema.py`, `test_objects_static.py`, `test_build_nebulae.py`, `backend/tests/fixtures/objects/**` (nebula examples) | this section |
| H. Black-hole build | Sonnet, after A's schema commit (in parallel with A's build work) | `backend/scripts/build_objects_bh.py`, `backend/data/sources/bh-curated/**` (I write `black_holes.json`), `frontend/data/objects/bh-curated/**`, `test_build_bh.py`, BH example fixtures | A's `objects.py` |
| B. Frontend pure modules | Sonnet, in parallel with A and H | `scene3d-objects.js`, `scene3d-registry.js`, `scene3d-orbits.js` (export `hashUnit` if not already), their tests | this section |
| C1. Renderer: direction-only, nebula billboards, "Turn to it", card fixes, HUD | Sonnet, after B | `scene3d.js`, `scene3d-shaders.js`, `scene3d-main.js`, `scene3d-card.js`, `scene3d.html`, `scene3d.css` | B, A's data |
| C2. Renderer: lensing, hosted black holes, `prefer_record` | Sonnet, after C1 | the same files | C1, H's data |
| D. Docs, mock server, Sesame mirrors, integration, review | me | this doc, `docs/technical-reference.md`, `frontend/dev/mock_server.py`, `test_objects_api.py`, the repository `LICENSE` paragraph, `config.py` and `catalogs.py` (§17.17) with their tests | all |

Haiku runs both suites after each slice, and `--check` on all four datasets.

Commits:
1. This design.
2. Schema changes.
3. Nebula build and data.
4. Black-hole build and data.
5. Frontend pure modules.
6. Renderer: direction-only and nebulae.
7. Renderer: lensing and hosted black holes.
8. Docs.

### 17.15 Phase 3 checklist (megaparsec frame, galaxies, the Milky Way, supermassive black holes)

**Phase 3 change:** designed in §18; the follow-ups carried forward are in §18.16. The OpenNGC `G` count is 10,481 + 40 (§18.2), and NED-D is replaced by Cosmicflows-4 (§18.4.1).

- [ ] Register the `cosmos` level (§8: `enterPc` 6e4, `leavePc` 4e4 from the Sun, unit Mpc), proved already by the three-level frames test.
- [ ] `build_objects_galaxies.py`: OpenNGC galaxies (types `G`, `GPair`, `GTrpl`, `GGroup`; 10,482 + 40 `G` rows at the Phase 2 pin) from the same pinned SHA, plus UNGC (Karachentsev et al. 2013, VizieR), plus NED-D redshift-independent distances. Method → evidence: Cepheid/TRGB/SBF/maser → `measured`; Tully–Fisher, redshift (Hubble flow) → `derived`. Licence: CC BY-SA 4.0 again for the OpenNGC part.
- [ ] Galaxy billboards: reuse the §17.6 projected-ellipse code with a galaxy look (bulge plus disc by Hubble type, illustrative), and surface brightness from OpenNGC `SurfBr` (galaxies only).
- [ ] `gal:milky_way`: a curated record in the galaxy frame's cosmos-level billboard (§8: the Gaia points collapse into it). Set Sgr A*'s `parent` to it (§17.8).
- [ ] Supermassive black holes in `bh-curated`: M87* (EHT 2019 mass and distance) and others with direct (stellar or gas dynamics, maser) masses, hosted by their galaxy record (`parent: ongc:…`, `host: null`). The `lensing` renderer is reused at Mpc scale (always enlarged).
- [ ] Direction-only galaxies (no distance) reuse §17.5 unchanged.
- [ ] Follow-ups carried forward:
  - [ ] real image billboards (§17.6.4);
  - [ ] true gravitational lensing of the background (§17.9);
  - [ ] `EVIDENCE_HIDES_FEATURES`;
  - [ ] the README `online` marker;
  - [ ] the cluster member-star highlight (§16.12);
  - [ ] orbit animation over time;
  - [ ] migrating "Turn back the sky" onto the shared catalogues;
  - [ ] **a general evidence rule for all hosted kinds**, exoplanets included (approval condition 2): at galaxy scale, a marker on the host star takes the host's evidence level; inside the system view, the orbit placement keeps its own level. Phase 2 keeps today's rule with no special case;
  - [ ] **Gaia-parallax-based HII-region distances**, to replace Russeil 2003's photometric ones where they overlap (§17.4);
  - [ ] real images: prefer tiled sky surveys with proper sky alignment over press images, licence permitting (§17.6.4).
  - [ ] **Gaia data licence across the repository**: Gaia DR3 is CC BY-NC 3.0 IGO ("Credit: ESA, Gaia DPAC"). Show the credit wherever Gaia values are shown (star layer, Phase 1 datasets), and decide how the NC term sits with the project's licensing.

### 17.16 Decisions at approval (2026-11-18)

The open questions Q1–Q5 were answered as follows, and each condition is folded into the section named.

1. **Data licence: yes, CC BY-SA 4.0** for the OpenNGC-derived data files; the code stays MIT. Conditions: a licence notice in the nebula dataset folder, a line in the main `LICENSE`, and the OpenNGC credit and licence **where users see the data** (nebula cards and a credits line in the 3D view), not only in the manifest. The Phase 3 galaxy files do the same (§17.2).
2. **X-ray binaries in the Evidence view: keep the rule.** Illustrative placements are hidden there and counted on the host card, with no special case. A general rule for all hosted kinds is a follow-up (§17.15).
3. **`prefer_record`: yes, with conditions** (§17.7 item 5, §17.8):
   - only the seven curated companions, listed explicitly, not a general override mechanism;
   - it replaces the distance only, never the sky position or the Gaia identity (amended 2026-11-19: also the mass, radius and Teff a star's paper prints, never the sky position or the Gaia identity; §17.7 item 5, §17.18);
   - the star card shows the curated distance and its paper, and lists the Gaia single-star value as "not used", with the reason;
   - the black hole and its companion use the same distance;
   - tests cover BH2 (≈ 1.16 kpc, not ≈ 1.5).
4. **Real images: a follow-up.** A later version prefers images with proper sky alignment (tiled sky surveys) over press images, licence permitting (§17.6.4).
5. **HII distances: Russeil 2003 stellar distances (derived), kinematic ones rejected.** The 1° link filter is tested on Orion, M8 = S25 and the Rosette = Sh2-275; the build report states how many links it drops; Gaia-parallax-based HII catalogues are a follow-up (§17.4).
6. **SIMBAD mirrors.** The name resolver (`/api/resolve`) falls back to SIMBAD's Harvard and South African mirrors when CDS is down (§17.17). Those mirrors were used for the companion cross-check in §17.8.

### 17.17 Name resolution: SIMBAD/Sesame mirrors

`catalogs.resolve` asks Sesame for a name. Today that is CDS only (`config.SESAME_URL`). Phase 2 tries, in order:

| Order | Host | URL |
|---|---|---|
| 1 | CDS Strasbourg | `https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/S` |
| 2 | Harvard (CfA) | `https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/S` |
| 3 | IDIA, South Africa | `https://vizier.idia.ac.za/viz-bin/nph-sesame/-oxp/S` |

- All three were checked live on 2026-11-18 and return the same Sesame XML (`parse_sesame` reads it unchanged). The SIMBAD mirrors' own hosts (`simbad.cfa.harvard.edu`, `simbad.idia.ac.za`) serve SIMBAD queries but not the Sesame CGI, so the Sesame URLs above are the VizieR hosts at the same sites.
- `config.SESAME_URLS` holds the list. `SPHEREX_SESAME_URL` still overrides the first entry, and `SPHEREX_SESAME_MIRRORS` (comma-separated) replaces the fallbacks; an empty value disables them.
- A mirror is tried only after an **upstream** failure of the one before (timeout, connection error or 5xx). "Not found" from a working Sesame is an answer, not a failure, so it is not retried elsewhere.
- The response's `source` stays `"sesame"`; a new optional `mirror` field names the host that answered.
- Tests (offline, with stubbed `get_text`): CDS down → CfA answers; CDS and CfA down → IDIA answers; "not found" from CDS → no further requests; all down → the same upstream error as today.

### 17.18 Implementation notes (2026-11-19)

**What changed from the design during implementation:**
- **Direction-only radius guard.** It now allows a `measured` or `catalogue` radius (§17.7 item 2), because 19 NEA host stars carry one.
- **Rosette distance.** It is Russeil's 1.9 kpc, not the 1.3–1.8 kpc the design expected. The link is right; see §17.4.
- **Two extra overrides:** `Sh2-25 → NGC6523`, and Sh2-281's `russeil_complex` link (§17.4).
- **Russeil 1° filter.** It measures great-circle separation, and drops 106 of 289 links.
- **Black-hole values from the papers.** Every number in `black_holes.json` was re-read in the paper text. Cyg X-1's e is now Miller-Jones et al. 2021's 0.0189 (it was Orosz et al. 2011), and A0620-00's i is 50.98 ± 0.87 (it was rounded; §17.8).
- **Gaia licence.** Gaia DR3 is CC BY-NC 3.0 IGO, so `bh-curated` carries a `credit` (§17.2).
- **New unit `mas`.** Added to `UNITS` for `gaia_parallax`.
- **Nebula quads.** They are drawn as their screen bounding box cut to the viewport, with each corner's ellipse coordinates mapped back from its pixel. Up close, clipped triangles showed a seam along the quad's diagonal.
- **Fixtures follow the build** (§17.12 preamble):
  - M57 `lo` is 761.4, from the unrounded e_plx;
  - M42 and the Crab carry more props than §17.12 shows;
  - Sgr A*'s r_s interval is 12,650,000–12,730,000 km (4 significant digits);
  - the Gaia BH1 companion's `companion_mass` tier is `catalogue`;
  - BH3's position tier is `inferred`;
  - `src` strings are the long "cite (arXiv), where" form.

**Open points found in the browser checks:** none left.

**Resolved (2026-11-19):**
- **Stellar parameters of the companions.** `prefer_record.replace` is now a field list (§17.7 item 5); the seven companions take the mass, radius and Teff their papers print, and Gaia's single-star values are listed as not used (BH2: 1.07 ± 0.19 M☉ shown, FLAME's 2.60 not used) (§17.8).
- **Credits line.** The hint, the credits line and the nav are stacked in one bottom dock, so the CC BY-SA credit sits above the nav however it wraps; checked at 375, 768 and 1280 px.
- **Card rounding.** Every card uses one formatter (`scene3d-format.js`, rule below); Sgr A*'s mass reads 4.297 ± 0.012 × 10⁶ M☉.

**Card numbers** (`frontend/js/blink/scene3d-format.js`, `fmtQuantity`; the star card's `fmtValue` and every registry card use it, with no per-kind cases):
- **With an uncertainty** (finite `lo ≤ v ≤ hi`, not all equal): the larger of the two errors is rounded by the Particle Data Group rule (first three digits 100–354 keep 2 significant figures, 355–949 keep 1, 950–999 round up to 1000 and keep 2), and the other error and the value are rounded to the same decimal place. Equal errors read `8.94 ± 0.34 M☉`, unequal ones `2,220 +180/−170 pc`. The larger error sets the precision so an asymmetric interval never claims more digits than its wider side supports. A nonzero error never rounds to 0.
- **Scientific notation** for such values when **|v| ≥ 10⁵ or 0 < |v| < 10⁻³**: `4.297 ± 0.012 × 10⁶ M☉`.
- **Without an uncertainty:** unchanged, 3 significant figures (`12,700,000 km`).
- An interval that does not bracket its value is shown as before (`v unit (lo–hi)`). A string bound such as `"< 0.12"` passes through untouched.

## 18. Phase 3: megaparsec frame, galaxies, the Milky Way and supermassive black holes (design)

Status: **approved 2026-11-19 with the decisions in §18.18**, which override anything in §18.1–§18.17 they contradict. Sections of §1–§17 that Phase 3 changes carry a
"Phase 3 change" note pointing here. Where this section and an earlier one disagree, this one wins.

Every catalogue fact below was checked against the live source on **2026-11-19**:
- OpenNGC on GitHub (raw files at the pinned commit, re-hashed; the releases API);
- VizieR through the CfA mirror (`vizier.cfa.harvard.edu`); CDS (`cdsarc`, `cds.unistra.fr`) answered 404 for the
  ReadMe and licence pages again, and so did the CfA and IDIA copies of the licence page;
- NED's NED-D page and the NED-D CSV itself (downloaded and hashed);
- EDD's home, about and terms pages (`edd.ifa.hawaii.edu`, terms version 2026-10-29);
- ESA's Gaia licence and DR3 credit pages;
- arXiv full texts for every physical number (the papers are listed per value; the quotes and their locations are in
  the research notes and go into each `src`/`where`, as `bh-curated` already does).

### 18.1 Decisions at a glance

| Question | Decision |
|---|---|
| `cosmos` level | Registered as the third row of `LEVELS`: unit Mpc, `enterPc` 6e4 and `leavePc` 4e4 from the Sun, as §8 planned. The galaxy level's speed bounds rise so the camera can leave the Galaxy (§18.5). |
| What is drawn in `cosmos` | Galaxies, the Milky Way billboard and supermassive black holes (Sgr A* included). Stars, clusters, nebulae, exoplanets, stellar-mass black holes and solar markers are **hidden**, and they do not disappear at the frame switch: they fade out with the camera's distance from the Sun between 20 and 40 kpc (`galaxyFade`), so they are already gone when the frame changes (§18.5.4). |
| Magellanic Clouds | LMC at 49.4 kpc (inside the 40–60 kpc hysteresis band), SMC at 63.9 kpc (beyond it), both Cosmicflows-4 Cepheid distances. Every galaxy is drawn by the same frame-independent code in both frames, so crossing the boundary changes nothing on screen (§18.5.5). |
| Galaxy sources | **OpenNGC** types `G`, `GPair`, `GTrpl`, `GGroup` at the Phase 2 pin (10,791 rows) and **UNGC** (Karachentsev et al. 2013, VizieR `J/AJ/145/101`, 869 rows), merged at build time into one dataset, **`galaxies`**, by one script, `build_objects_galaxies.py`. Merge ladder as in §17.3: explicit id, committed overrides, positional score (§18.3). |
| Distance catalogues (at most two) | **Adopted:** (1) **Cosmicflows-4** (Tully et al. 2023, VizieR `J/ApJ/944/94/table2`, 55,877 galaxies, one zero point, per-method moduli with errors, joined by PGC); (2) **UNGC**'s own distances, for Local Volume galaxies Cosmicflows-4 lacks. **Rejected: NED-D** (the file says "All Rights Reserved", last updated 2020, no PGC ids, mixed zero points; §18.4.1). |
| Choosing a distance | Evidence class first (measured methods, then derived catalogue methods, then the Hubble flow), then "has a published uncertainty", then the smallest fractional uncertainty, then catalogue order (CF4, then UNGC). Never an average. The other candidates go on the card as "not used", with the reason (§18.4.2). |
| Method → evidence | Measured: maser, Cepheid, TRGB, SBF, horizontal branch, RR Lyrae, CMD fitting. Derived: SN Ia, SN II, Tully–Fisher, fundamental plane, brightest stars, PNLF, group membership, redshift. SN Ia is derived because it is a secondary indicator: an empirical light-curve standardisation calibrated on Cepheid/TRGB hosts (§18.4.3). |
| Hubble flow | From the OpenNGC (or UNGC) heliocentric velocity, moved to the CMB frame with the Planck 2018 dipole, with **H0 = 74.6** (Cosmicflows-4's own zero point), a **300 km/s** peculiar-velocity floor, and **no distance below v_CMB = 1000 km/s** (direction-only). About 5,930 OpenNGC galaxies are placed this way (§18.4.4). Q2, Q3. |
| Scope | **Cone plus a sky-wide context set**: the Local Group and neighbours (adopted distance ≤ 3 Mpc), every galaxy brighter than B = 10, the hosts of the curated SMBHs and the Milky Way. About 150 records, sent with every response from a `sky` tile (§18.11). Q4. |
| Galaxy look | The §17.6 projected-ellipse billboard, with a third axis that tilts the disc to its catalogue inclination. An illustrative bulge-plus-disc look by Hubble type, brightness from OpenNGC `SurfBr`. The Evidence view shows the catalogue outline only (§16.10); galaxies under 3 px are markers (§18.6). |
| `gal:milky_way` | A curated record in the `galaxies` dataset. Its centre is **Sgr A*'s position and distance, copied by the build from `bh-curated`'s source file**, so R0 = 8277 ± 9 pc exists once. The plane comes from the ICRS definition of Galactic coordinates (Hipparcos Vol. 1 §1.5.3); disc and bar sizes from Bland-Hawthorn & Gerhard 2016. An illustrative billboard; a marker in the Evidence view (§18.7). |
| Supermassive black holes | Eight in `bh-curated`: **M87\***, NGC 4258\*, M31\*, M32\*, Cen A\*, M81\*, M104\* and NGC 4889\*, each with a direct dynamical (or maser, or EHT) mass. Each has `parent: <galaxy id>`, `host: null`, and its galaxy's position **and distance, copied by the build from the built galaxy record**. The paper's distance is shown as "not used"; dynamical masses are rescaled to the adopted distance, the published value shown beside it (§18.8). Q5. |
| `lensing` at Mpc | Reused unchanged; always enlarged at Mpc distances, and the card says by how much. |
| Gaia credit | "Credit: ESA/Gaia/DPAC" on the credits line whenever Gaia stars or Gaia-derived values are on screen, in a `Data` row on every Gaia star card, and in the manifests of `nea-exoplanets`, `hr23-clusters` and `bh-curated`. How the NC term fits the project is **not decided here** (Q1). |
| Licence | The `galaxies` data files are CC BY-SA 4.0 (OpenNGC-derived), handled exactly as the nebulae (§17.16 item 1); UNGC and CF4 via VizieR, with their citations; EDD's terms followed for CF4 (Q1). |

### 18.2 Builds, pins and licences

`build_objects_galaxies.py` follows `build_objects_nebulae.py` (§17.2): the committed snapshot by default, `--refresh`
re-downloads and re-verifies against the pins, `--local DIR`, `--check` (byte-identical rebuild plus `verify_dataset`,
exit 1 on any difference), `SOURCE.json`, `manifest.build.report`, `write_dataset(..., src_table=True,
record_defaults=...)`.

| Input (in `backend/data/sources/galaxies/`) | Pin (checked 2026-11-19) | Rows |
|---|---|---|
| `openngc-36cb178a-NGC.csv.gz`, `openngc-36cb178a-addendum.csv.gz` | The same release (`v20260501`, still the latest release) and commit `36cb178a0f69dba8bfc03a99c10512831edf1c6b` as Phase 2. The raw files re-hash to the pinned `840fe0c9…aa9e` and `1d8f0914…1983`. A copy, not a link to the nebula folder, so each folder's `LICENSE.md` covers its own files (+0.89 MB). | 10,791 galaxy rows: `G` 10,521 (10,481 in `NGC.csv` + 40 in the addendum), `GPair` 231, `GTrpl` 26, `GGroup` 13 (11 + 2). **§17.15 said 10,482 + 40 `G`; the parsed count is 10,481 + 40.** |
| `ungc-catalog.tsv.gz` | VizieR `J/AJ/145/101/catalog`, `-out.all`, "Updated nearby galaxy catalog (Karachentsev+, 2013)", AJ 145, 101 (arXiv:1303.5328), doi:10.26093/cds/vizier.51450101. | 869 |
| `cf4-table2.tsv.gz` | VizieR `J/ApJ/944/94/table2` (Tully et al. 2023, ApJ 944, 94, arXiv:2209.11238), columns `PGC, Vcmb, DM…e_DMmas, RAJ2000, DEJ2000` only (1.28 MB gzipped against 3+ MB for every column). | 55,877 |
| `ungc_ongc_overrides.json` | Hand-written, committed: `[{ungc, ongc \| "gal:milky_way" \| null, reason}]`. | seeded with 3 (§18.3) |
| `galaxy_names.json` | Curated common names (Andromeda Galaxy, Triangulum Galaxy, Large and Small Magellanic Cloud, Whirlpool, Sombrero, Pinwheel, Bode's Galaxy, Cigar Galaxy, Centaurus A, Messier 87, …), src "curated common name". | — |
| `milky_way.json` | Hand-written, committed; every number with `{v, lo, hi, unit, src, where}`, refused without them (§18.7). The centre is **not** in it: it names `"centre_from": "bh:Sgr A*"`, and the build copies that record's position and `dist` out of `backend/data/sources/bh-curated/black_holes.json`. | — |

- VizieR TSV header and comment lines are stripped before hashing, as in Phases 1 and 2; mirrors CfA, IDIA, CDS in that order; the mirror used goes into `SOURCE.json`.
- **Build order.** `galaxies` reads `bh-curated`'s *source* file (Sgr A*); `bh-curated` reads `galaxies`' *built* tiles (the SMBH hosts' distances). There is no cycle: curated source → galaxies → black holes. `build_objects_bh.py --check` fails if the galaxy distance it copied no longer matches the built galaxy record.
- **Report:** rows read and kept per type; Dup designations folded in; UNGC merges by rule with the **full list of pairs**; UNGC-only records; CF4 joins (PGC and positional) and conflicts; distances **per method and per evidence**; Hubble-flow and direction-only counts (with the reason: no velocity, or below 1000 km/s); the context set's members and count; per-file and total bytes.

**Licences** (`SOURCE.json`, `manifest.provenance`, `LICENSE.md` in both `backend/data/sources/galaxies/` and
`frontend/data/objects/galaxies/`, a sentence added to the repository `LICENSE` paragraph that names the nebula folders):
- **OpenNGC**: CC BY-SA 4.0 (`.reuse/dep5`), credit "Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC" plus OpenNGC's acknowledgements, as in §17.2. The derived `galaxies` data files are CC BY-SA 4.0; `manifest.provenance.credit` and `licence_name: "CC BY-SA 4.0"` put it on the credits line with no new code, and every galaxy card has a `Data` row.
- **UNGC and CF4** are VizieR tables, redistributed with their citations and the VizieR terms URL (unreachable today; the earlier phases cite it).
- **Cosmicflows-4** also lives in EDD. The paper's Data Availability says its tables are "available within the public domain of the Extragalactic Distance Database". EDD's terms (2026-10-29) say: "You may use, analyze and share EDD data for research and education, provided you cite it", ask for the EDD citation (Tully et al. 2009, AJ 138, 323), and say that changed, filtered, converted or combined data must say so and must not be presented as EDD data. We take the table from VizieR but follow those terms anyway: the citations go in `LICENSE.md`, the manifest and the card's `Data` row, and the `src` of every CF4 distance says "converted from the Cosmicflows-4 modulus by Space Maps". Whether "research and education" fits the project is Q1.
- **NED-D** is not used (§18.4.1), so NED's terms do not apply beyond OpenNGC's own acknowledgement.

### 18.3 Galaxy records and the OpenNGC–UNGC merge

**OpenNGC parsing** reuses the nebula parser (§17.3): `;` CSV with quoted fields, sexagesimal J2000 to 7 decimals,
`MajAx`/`MinAx` in arcmin, `PosAng` in degrees. `Dup` rows whose master is a kept galaxy add their name to its
`designations`; `NonEx` rows are dropped. `GPair`, `GTrpl` and `GGroup` rows (268) are ordinary records whose size is
the group's extent; none of them has a `RadVel`, and only 29 carry a PGC id, so most are direction-only.

**UNGC parsing.** `RAJ2000`/`DEJ2000` sexagesimal; `a26` (arcmin) and `b/a` give `major` and `minor`; there is no PA,
so `pa` is null (§17.6.1 unknown-PA rule); `Bmag`, `HRV` (km/s), `TT` (T-type), `Dist` (Mpc, 2 decimals) and `f_Dist`
(method code, §18.4.3).

**Merge rule** (a UNGC row U onto an OpenNGC galaxy N; each N is claimed at most once):
1. **Identifier.** U's `Name` is an OpenNGC `Name` (both write `NGC0205`, `IC0010`), or `MESSIERnnn` matches N's `M`
   column. The 2026-11-19 snapshot gives **193** such pairs.
2. **Overrides** (`ungc_ongc_overrides.json`), seeded with:
   - `LMC` → `ESO056-115` ("OpenNGC lists the LMC under its ESO number; addendum row");
   - `SMC` → `NGC0292`;
   - `Milky Way` → `gal:milky_way` ("the curated record; UNGC's `geom` row at 0.01 Mpc is not used").
3. **Positional.** N within `s ≤ max(1′, 0.25·MajAx_N)` and, when both have velocities, `|HRV − RadVel| ≤ 150 km/s`;
   score `s / max(MajAx_N, 1′)`, lowest wins, with the same conflict fallback as §17.3. A research run of a looser rule
   (`0.5·MajAx`, no velocity test) paired 24 more; the report lists every pair, and reviewers extend the override table,
   not the code.

**Merged record:** OpenNGC's id, position, size and magnitudes; the UNGC name joins `designations`; UNGC's distance
becomes a candidate (§18.4). **UNGC-only rows** (652 before overrides, 651 after) become `ungc:<Name>` records with
UNGC's position and size, for example `ungc:And XVIII`.

**CF4 joins.** OpenNGC rows join CF4 by the `PGC nnnnnn` in `Identifiers` (10,104 rows carry one; **3,946** are in CF4).
UNGC-only rows have no PGC; they join CF4 positionally within 0.5′ (CF4 positions are given to 1e-4°), only when the
match is unique; the report lists every pair.

**Names.** The curated map; else OpenNGC's first common name; else `M 31`; else `NGC 4258` / `IC 10` / the UNGC name.
`designations` keeps M, NGC/IC, UGC, PGC, ESO, the UNGC name and common names, at most 8 (the size budget).

**Record fields** (`kind: "galaxy"`, `host: null`, `parent: null`):

| Field | From | Tier / rule |
|---|---|---|
| `position` | `fixed`, OpenNGC or UNGC J2000, `epoch: 2000.0`; `dist` and `method` from §18.4 | `position.tier: catalogue`; the `dist` tier governs |
| `size.angular` | OpenNGC `MajAx`/`MinAx`/`PosAng`, or UNGC `a26`, `a26·b/a`, `pa: null` | `catalogue` |
| `size.radius` | placed only: `D·tan(major/2)` in pc, src "half the catalogue major axis at the adopted distance" | `inferred`; always null when direction-only |
| `props.type` | "Galaxy", "Galaxy pair", "Galaxy triplet", "Group of galaxies" | `catalogue` |
| `props.hubble` | OpenNGC `Hubble` (string), else UNGC `TT` as "T = 9" | `catalogue` |
| `props.mag_b`, `props.mag_v` | OpenNGC `B-Mag`, `V-Mag`; UNGC `Bmag` | `catalogue` |
| `props.surface_brightness` | OpenNGC `SurfBr`: "Mean surface brightness within 25 mag isophot (B-band), expressed in mag/arcsec2" (`NGC_guide.txt`) | `catalogue` |
| `props.v_helio`, `props.redshift` | OpenNGC `RadVel` (heliocentric, km/s), `Redshift`; UNGC `HRV` | `catalogue` |
| `props.v_cmb` | Hubble-flow records only: §18.4.4 | `inferred` |
| `alt_distances` | the candidates not used, at most 4 (new field, §18.9) | each its own tier |
| `render.mag` | B, else V; ordering and labels only | |
| `evidence` | from the `dist` tier (§3); `measured` for direction-only records (only the direction is drawn, §17.5) | |

**Change to §2.5:** galaxy `props` keys are `type`, `hubble`, `mag_b`, `mag_v`, `surface_brightness`, `v_helio`,
`redshift`, `v_cmb`, plus the Milky Way's keys of §18.7.

### 18.4 Distances

#### 18.4.1 Catalogues evaluated

| | **Cosmicflows-4** (adopted) | **NED-D 17.1.0** (rejected) | **UNGC** (adopted, second) |
|---|---|---|---|
| Content | 55,877 galaxies; per-method moduli (SN Ia, TF, FP, SBF, SN II, TRGB, Cepheid, maser) and a weighted mean, "all on the absolute scaling established by the combined TRGB, CPLR, and MASER calibrators" (paper §12); `Vcmb`. | 272,573 distances for 147,363 galaxies, "Version 17.1.0 (May 2020)", page last revised 28 May 2020. | 869 Local Volume galaxies; one distance each, `Dist` in Mpc to 0.01, with a method code; **no per-galaxy error**. |
| Terms | VizieR terms; EDD terms (research and education, cite, say what you changed); the paper calls EDD's tables "public domain". | The CSV's own header: "Copyright (C) 2012-2020 California Institute of Techology - All Rights Reserved". NED's acknowledgement page asks for an acknowledgement in articles and grants no redistribution. **No basis to ship a derived file.** | VizieR terms, citation. |
| Access / pin | VizieR table id + sha256 of the stripped TSV. | One 41 MB CSV (`NED30.5.1-D-17.1.2-20200415.csv`, sha256 `fe818b6d…1f55`), stable URL. | VizieR table id + sha256. |
| Identity | PGC number (OpenNGC carries PGC for 10,104 of 10,791). | NED "preferred names" only; matching needs name normalisation. | Names in OpenNGC's own format (`NGC0205`) or `MESSIERnnn`. |
| Zero point | one, stated | mixed: a "default value of H = 70" and a "fiduciary" LMC modulus of 18.50, with per-row exceptions | TRGB/Cepheid; `h` distances at H0 = 73 |
| Coverage of the 10,791 OpenNGC galaxies | **3,946** (by PGC): maser 4, Cepheid 66, TRGB 126, SBF 430, SN Ia 258, TF 2,251, FP 1,230, SN II 52 (a galaxy can have several). | **≥ 5,360** by an NGC/IC/Messier name match (a lower bound), 527 with a Cepheid, TRGB, maser, SBF, RR Lyrae, eclipsing-binary or horizontal-branch distance. | 217 merged (193 by name, ~24 by position), plus 651 UNGC-only records. |

NED-D covers more galaxies, but its terms, its age and its mixed zero points rule it out. Two catalogues are adopted:
CF4 for most placed galaxies and UNGC for Local Volume dwarfs CF4 lacks. A third distance source is not a catalogue:
the Hubble flow from each galaxy's own velocity (§18.4.4).

**Distances from moduli.** `D = 10^((μ + 5)/5)` pc, `lo`/`hi` from `μ ∓ σ_μ`. CF4's moduli are luminosity-distance
moduli (its Table 3 calls `Dist` the "Luminosity distance corresponding to DMzp"), so the placed distance is
`D / (1 + z)` with `z = Vcmb / c`, the same comoving distance the Hubble-flow formula gives. It is under 3 % even at
Coma, and the src says so. UNGC distances are used as printed; their src says "UNGC gives no per-galaxy error; values
are rounded to 0.01 Mpc; Sec. 2 quotes 5–10 % for its TRGB, Cepheid and SN distances", and the card shows no interval.

#### 18.4.2 Choosing among a galaxy's distances

Candidates: every CF4 per-method modulus of the galaxy, and its UNGC distance. CF4's combined `DM` ("all
methodologies") is **not** a candidate: it averages measured and derived methods, so its evidence cannot be stated.
1. **Evidence class:** measured methods, then derived catalogue methods, then the Hubble flow (§18.4.4), then none.
2. **Within the class, a candidate with a published uncertainty beats one without** (so UNGC only fills gaps).
3. **The smallest fractional uncertainty** (`σ_D/D = 0.4605·σ_μ`).
4. **Catalogue order:** CF4, then UNGC.
5. A fixed method order for exact ties: maser, Cepheid, TRGB, SBF, horizontal branch, RR Lyrae, CMD, then SN Ia, TF, FP, SN II, the rest.

The others (at most 4) go to `alt_distances`, each with its reason ("not used: larger uncertainty than the Cepheid
distance", "not used: a derived method; a measured distance exists"). Example, M31: Cepheid 24.397 ± 0.066 is used;
TRGB 24.53 ± 0.10 and SBF 24.214 ± 0.080 are shown as not used.

#### 18.4.3 Method → evidence

| Method | Codes | `method` | `dist.tier` | Evidence |
|---|---|---|---|---|
| Maser | CF4 `DMmas` | `maser` (new) | `measured` | measured |
| Cepheid | CF4 `DMceph`, UNGC `Cep` | `cepheid` | `measured` | measured |
| TRGB | CF4 `DMtrgb`, UNGC `TRGB` | `trgb` | `measured` | measured |
| SBF | CF4 `DMsbf`, UNGC `SBF` | `sbf` | `measured` | measured |
| Horizontal branch, RR Lyrae, CMD fitting | UNGC `HB`, `RR`, `CMD` | `horizontal-branch`, `rr-lyrae`, `cmd` (new) | `measured` | measured |
| SN Ia | CF4 `DMsnIa` | `sn-ia` (new) | `inferred` | **derived** |
| Supernova (type not given) | UNGC `SN` (3 rows) | `supernova` (new) | `inferred` | derived |
| SN II, Tully–Fisher, fundamental plane | CF4 `DMsnII`, `DMtf`, `DMfp`; UNGC `TF`, `FP` | `sn-ii` (new), `tully-fisher`, `fundamental-plane` (new) | `inferred` | derived |
| Brightest stars, PNLF, group membership | UNGC `BS`, `PNLF`, `mem` | `brightest-stars`, `pnlf`, `group-member` (new) | `inferred` | derived |
| Hubble flow | §18.4.4 | `redshift` | `inferred` | derived |
| UNGC `h`, `h′` (Hubble law at H0 = 73), `txt` ("texture of objects indicating their likely proximity") | — | not used | — | our own Hubble flow, else direction-only |
| UNGC `geom` | the Milky Way row only | not used (override) | — | — |

**Where SN Ia sits, and why.** A type Ia supernova is a standardisable candle: its peak brightness is corrected by an
empirical light-curve relation, and the scale is tied to Cepheid and TRGB hosts (CF4 takes "the grouped SN Ia sample"
as the reference of its method merge, §10.1, and puts the ensemble on an absolute scale through TRGB and Cepheid
galaxies, §10.2). Its per-galaxy precision can match TRGB, but its placement rests on a relation with real assumptions,
which is §3's definition of `derived`. SBF is also calibrated on Cepheid/TRGB galaxies; it stays `measured` as the
Phase 3 checklist says (its calibration is a colour-dependent zero point rather than a standardisation of an event).

**Validator:** a `fixed` distance whose method is in `DERIVED_METHODS` (`redshift`, `tully-fisher`,
`fundamental-plane`, `sn-ia`, `sn-ii`, `supernova`, `brightest-stars`, `pnlf`, `group-member`) may not carry tier
`measured` or `catalogue`, so a Hubble-flow or TF distance can never be shown as measured (§18.9).

#### 18.4.4 Hubble-flow distances

For a galaxy with no catalogue distance and a velocity (OpenNGC `RadVel`, or UNGC `HRV`):
1. **CMB frame.** `v_CMB = v_helio + 369.82 km/s · cos θ`, θ the angle to the solar dipole apex `(l, b) = (264.021°,
   48.253°)` (Planck 2018 I, A&A 641, A1, Table 2 "Planck 2018" row and §2.1: "v = (369.82 ± 0.11) km/s"). In ICRS
   the apex is (167.94°, −6.94°). Stored as `props.v_cmb` (`inferred`).
2. **Threshold.** `v_CMB < 1000 km/s` → no distance: direction-only (§17.5). This covers every blueshifted Local
   Group member without a catalogue distance. (Q3.)
3. **Distance.** `z = v_CMB / c`; `D = (c z / H0)·(1 − (1 + q0) z / 2)`, the comoving distance to second order, with
   `q0 = Ωm/2 − ΩΛ = −0.595` from the `Ωm = 0.27`, `ΩΛ = 0.73` Cosmicflows-4 assumes (its Appendix, Table 4 notes).
   The correction is 3.4 % at the catalogue's highest redshift (z ≈ 0.17).
4. **H0 = 74.6 km/s/Mpc**, Cosmicflows-4's own value: "compatible with a value of the Hubble constant of H0 = 74.6
   km/s/Mpc with the small statistical error of ±0.8 km/s/Mpc but a large potential systematic error of ~3
   km/s/Mpc" (Tully et al. 2023, abstract). Same scale as the catalogue distances shown beside them. Riess et al.
   2022's 73.04 ± 1.04 is 2 % lower; Planck 2018 VI's 67.36 ± 0.54 (Table 2, TT,TE,EE+lowE+lensing) would put every
   Hubble-flow galaxy about 11 % farther, and the card says so. (Q2.)
5. **Interval** (changed at approval, §18.18 item 2). `σ_D/D = σ_v / v_CMB` with `σ_v = 300 km/s` ("The distribution of
   peculiar velocities with well-constrained distances is approximated by a Gaussian distribution with standard
   deviation 300 km/s", CF4 §13), or a cluster's dispersion inside the rich clusters of §18.4.6. H0 adds nothing: the
   CF4 distances beside them do not include it either. That is 30 % at the threshold and 8.5 % at 3,500 km/s.
6. `method: redshift`, `dist.tier: inferred`, `evidence: derived` (hollow marker, dashed outline). The src names the
   velocity, the frame, H0 and σ_v.

**Changed at approval (§18.18 items 3 and 6):** galaxies in rich nearby clusters take the cluster's CF4 group distance
(§18.4.6), and Local Group galaxies have two more distance sources: the curated Magellanic Clouds and McConnachie 2012
(§18.4.7).

#### 18.4.6 Rich nearby clusters (added at approval, §18.18 item 3)

Inside a rich cluster a galaxy's velocity is mostly its motion within the cluster, so a Hubble-flow distance would
smear the cluster into a streak along the line of sight with an interval that understates the error. The research
run counted Hubble-flow candidates (no catalogue distance, v_CMB ≥ 1000 km/s): **147 within 8° of M87 below 3000 km/s**,
41 within 3° of Coma, 19 within 2° of Perseus, 13 near Centaurus, 13 near Abell 1367 and Hercules each, 9 within 4° of
Fornax, 6 near Hydra.

**Rule** (`backend/data/sources/galaxies/clusters.json`, every number with `src`/`where`): a galaxy that would get a
Hubble-flow distance is a **member** when it lies within the cluster's cited radius of the centre galaxy on the sky
and its heliocentric velocity is within 3σ of the CF4 group's heliocentric velocity `Vh` (3σ as Colless & Dunn 1996
clipped Coma). A member is placed at the **CF4 group distance** (the `groups` table's `DMzp ± e_DMzp`, converted as in
§18.4.1), `method: group-member`, tier `inferred`, `evidence: derived`, with the interval widened in quadrature by the
cluster's radius along the line of sight. The card says: "Placed at the distance of the Virgo cluster (Cosmicflows-4
group 41220), because its velocity mostly reflects its motion inside the cluster."

| Cluster | Centre | CF4 group (1PGC, DMzp, D) | σ (km/s) | Radius |
|---|---|---|---|---|
| Virgo | M87 | 41220, 31.048 ± 0.008, 16.2 Mpc | 638 ± 35 (Kashibadze et al. 2020, A&A 635, A135, cluster-parameter table) | 6° = 1.7 Mpc, the virial radius (same, Sect. 1) |
| Fornax | NGC 1399 | 13418, 31.468 ± 0.013, 19.7 Mpc | 374 ± 26 (Drinkwater et al. 2001, ApJ 548, L139, Sect. 3) | 0.7 Mpc virial radius at their 20 Mpc → 2.005° |
| Coma | NGC 4874 | 44715, 34.891 ± 0.025, 95.1 Mpc | 1038 ± 60 (Colless & Dunn 1996, ApJ 458, 435, Sect. 3.1) | 97′ = 2.9 Mpc (Łokas & Mamon 2003, MNRAS 343, 401, Sect. 5) |
| Perseus | NGC 1275 | 12429, 34.185 ± 0.036, 68.7 Mpc | 1163 ± 49 (Meusinger et al. 2020, A&A 640, A30, Table 2) | R_vir,200 2.8 Mpc at their 74 Mpc → 2.168° |

The CF4 `groups` table (`J/ApJ/944/94/groups`, 38,053 rows; columns `1PGC, Ngal, DMzp, e_DMzp, Vh, V3k`) joins the
snapshot: the same catalogue, so still two distance catalogues. Centaurus, Abell 1367, Hercules and Hydra are left
out: no cited radius was found for Centaurus, and the others were not researched; their candidates keep the 300 km/s
floor. Galaxies with their own catalogue distance are never moved. The build report counts and lists the members.

#### 18.4.7 The Local Group (added at approval, §18.18 item 6)

UNGC's 0.01 Mpc rounding is too coarse for Milky Way satellites (the SMC at 0.06 Mpc, Sgr dSph at 0.02 Mpc instead
of about 26 kpc), so two more sources join, **for the Local Group only** (an approved exception to "at most two"):
- **The curated Magellanic Clouds** (`local_group_curated.json`): the LMC at 49.59 ± 0.09 (stat) ± 0.54 (sys) kpc
  (Pietrzyński et al. 2019, Nature 567, 200, abstract) and the SMC at 62.44 ± 0.47 ± 0.81 kpc (Graczyk et al. 2020,
  ApJ 904, 13, abstract), errors in quadrature, `method: eclipsing-binary` (new, measured). They win over every
  catalogue value, which go to `alt_distances`.
- **McConnachie 2012** (AJ 144, 4; arXiv:1204.1562; VizieR `J/AJ/144/4/catalog`, 102 rows, checked 2026-11-19 on the
  CfA mirror; VizieR terms). "All distance moduli are based on resolved stellar population analysis (generally
  Cepheid, RR Lyrae or TRGB measurements, but also horizontal branch level and main-sequence fitting)" (the column notes of its position-and-distance table), so
  `method: resolved-stars` (new, measured), with its asymmetric modulus errors. Only rows associated with the Milky
  Way, M31 or the Local Group (`n_Name` containing G, A or L: 75 rows, 70 usable) are used, not the nearby neighbours (N), and not
  rows whose modulus is flagged (`u_(m-M)` non-blank: Canis Major, Pisces II, Triangulum, Andromeda XXII) or the
  Milky Way row. Rows are matched to
  OpenNGC/UNGC records by name (also `OName`) and then position (≤ 3′); the report lists every pair. A McConnachie
  distance is an ordinary candidate in §18.4.2 (catalogue order CF4, McConnachie, UNGC), so it wins wherever it has
  the smaller fractional error and always over UNGC's error-less values. Expected: Sgr dSph at 26 kpc, Draco and Ursa
  Minor at 76 kpc.

#### 18.4.5 Expected counts (research run on the 2026-11-19 snapshot; the build report gives the final ones)

| | OpenNGC galaxies (10,791) | UNGC-only (651) |
|---|---|---|
| measured | ~592 (CF4 ~575: by first-ranked method maser 4, Cepheid 65, TRGB 105, SBF 401; UNGC ~17) | ~224 (TRGB 197, HB 14, SBF 5, CMD 5, RR 3) before CF4 positional joins |
| derived, catalogue | ~3,400 (CF4 ~3,369: SN Ia 195, TF 2,107, FP 1,053, SN II 16; UNGC ~33) | ~325 (group membership 149, TF 146, brightest stars 29, FP 1) |
| derived, Hubble flow | ~5,930 | a few (UNGC requires V_LG < 600 km/s) |
| direction-only | ~864 (752 without a velocity, 112 below 1000 km/s) | up to ~102 (`h` 80, `h′` 4, `txt` 18) |

At a 3000 km/s threshold the Hubble-flow count drops to ~4,984 and direction-only rises to ~1,810.

### 18.5 The `cosmos` level

#### 18.5.1 The table

```js
{ name: 'galaxy', unit: 'pc',  perPc: 1,    enterPc: 0,   leavePc: 0,   hosted: false,
  range: { min: 0.01, max: 1e8, speed: 2 },    autoPc: { min: 1e-12, max: 1e8 }, fov: null, near: 1e-9, far: 1e9 },
{ name: 'cosmos', unit: 'Mpc', perPc: 1e-6, enterPc: 6e4, leavePc: 4e4, hosted: false,
  range: { min: 1e-6, max: 100, speed: 0.01 }, autoPc: { min: 1e-12, max: 1e8 }, fov: null, near: 1e-9, far: 1e5 },
```
- **Why the galaxy row changes.** `range.max` (1e4 pc/s manual) and `autoPc.max` (100 pc/s auto) are speed caps. At
  100 pc/s the auto-throttle needs ten minutes to reach 60 kpc once it has left the stars. Both rise to 1e8 pc/s (100
  Mpc/s), the same as `cosmos`, so the speed is **the same function of the scene on both sides of the switch**. Inside
  the star field nothing changes: there the throttle × distance to the nearest star (about 1 pc/s) is far below either cap.
- **Auto-throttle surfaces.** `_nearBody` gains galaxies (centre distance minus `size.radius`, heading-weighted as
  stars are) and the Milky Way (its illustrative disc extent), in both unhosted frames. Stars count only while
  `galaxyFade > 0`. Targets, checked in the browser: with throttle 1/s, free flight from the Sun passes 60 kpc within
  about 10 s, and reaches Virgo within about 20 s (`ln(16.9 Mpc / 50 kpc)` ≈ 6 e-folds of approach).
- **Autopilot.** Unchanged: trips already run in world parsecs, and `Autopilot.start` lasts `2.5 + 0.6·log10(D/stop)`
  s, clamped to 8 s. Sun → M87, stopping 3 radii out (52 kpc), is 2.5 + 0.6·log10(16.9e6/5.2e4) ≈ 4.0 s plus the
  0.8 s turn. `suggestSpeed`'s hard-coded `hi = 100·unitsPerPc` becomes the level's `autoPc.max`, so arriving at a
  galaxy gives a speed that suits it.
- **The renderer's frame switch** (`_onFrameChange`) becomes generic: the manual speed scales by `to.perPc/from.perPc`
  and is clamped to the new range; `_system()` runs only when the new level is hosted (today a cosmos → galaxy
  'enter' would call it with no host).

#### 18.5.2 HUD units

One formatter in `scene3d-format.js`, chosen by value, not by frame, so nothing jumps at the switch:
`fmtDistPc(pc)` → AU below 0.02 pc (as now), "350 pc · 1,140 ly", "49.4 kpc · 161,000 ly", "16.9 Mpc · 55.0 million
ly"; `fmtSpeedPc(pcPerS)` likewise (pc/s, kpc/s, Mpc/s, plus the ×c figure). The where-line reads "In TRAPPIST-1's
system" / "Interstellar · 8.3 kpc from the Sun" / "Intergalactic · 16.9 Mpc from the Sun".

#### 18.5.3 Renderer audit

`scene3d.js` has about 25 `frame === 'galaxy'` / `!== 'galaxy'` tests. Each becomes one of:
- **stars and the Gaia patch** (star buffer, star picking and labels, cone outline, intro / reveal / snapshot /
  flatten, `_brightest`'s star scan): `galaxy` only;
- **objects** (billboards, markers, groups, lensing, picking, labels, credits, "Go there"): every unhosted level,
  through a new `F.isHosted(frame)`.

This is a mechanical audit of conditions, not a restructure. If it turns out to need one, I stop and ask.

#### 18.5.4 What is drawn where

`galaxyFade(cam) = 1 − smoothstep(2e4, 4e4, dSun_pc)`, pure, in `scene3d-objects.js`.

| Population | System | Galaxy | Cosmos |
|---|---|---|---|
| Gaia and XHIP stars, the Milky Way glow, the cone outline | as now | brightness × `galaxyFade` (the glow is already ≈ 0 there) | not drawn |
| Clusters, nebulae, exoplanets, stellar-mass black holes, solar markers | as now | alpha × `galaxyFade`; not labelled or picked below 0.25 | not drawn |
| Galaxies (placed and direction-only) | — | drawn | drawn, identically |
| `gal:milky_way` billboard | — | alpha × (1 − `galaxyFade`) | drawn |
| Supermassive black holes (Sgr A* included) | — | drawn (rule §18.8.3) | drawn |

The rule is general: **every record without a `cosmos` renderer fades with `galaxyFade`**, so nothing is drawn in the
galaxy frame beyond 40 kpc that `cosmos` would not draw. The exposure target multiplies the star intensities it scans by
`galaxyFade`, so it reaches `cosmos`'s value (no stars in view: `exposureFor(0) = 1`) before the switch.

Direction-only galaxies get their own fade scale: `skyFade` becomes per kind (`spec.skyFadePc`, nebulae 800 pc as now,
galaxies 1e5 pc). A galaxy without a distance is still roughly where the Sun sees it until the camera has moved a
good fraction of a megaparsec; 100 kpc from the Sun such a galaxy is at half strength and stops being pickable at
about 170 kpc.

#### 18.5.5 The Magellanic Clouds at the boundary

**Changed at approval (§18.18 item 6): the Clouds take their curated eclipsing-binary distances.**
- **LMC** (`ongc:ESO056-115`, UNGC `LMC` merged by override): Pietrzyński et al. 2019, 49.59 ± 0.09 (stat) ± 0.54
  (sys) kpc → **49.59 ± 0.55 kpc** (49.04–50.14). Its 646′ major axis makes its disc radius 4.7 kpc, so it spans about
  44.9–54.3 kpc from the Sun: **entirely inside the 40–60 kpc hysteresis band**. A camera near it can be in either
  frame, depending on where it came from. CF4's Cepheid 49.4 kpc is shown as not used.
- **SMC** (`ongc:NGC0292`): Graczyk et al. 2020, 62.44 ± 0.47 ± 0.81 kpc → **62.44 ± 0.94 kpc** (61.50–63.38); its
  300′ major axis gives a radius of 2.7 kpc, so it spans about 59.7–65.2 kpc. Its centre is beyond the 60 kpc entry
  line and its near edge just inside it: the cloud straddles the line where the camera enters `cosmos`. CF4's Cepheid
  63.9 kpc is shown as not used.
- UNGC's rounded 0.05 and 0.06 Mpc are never used for them.

Why crossing the boundary cannot make them flicker or jump:
1. Their placement is `galPc` in doubles, and both frames reach the screen through `relFromCam` (pc × `perPc` minus
   the camera position); the projected position differs only by rounding (< 1e-9 px).
2. `galaxyItem` and `lensingItems` take frame units and divide by `unitsPerPc(cam)` wherever a physical scale enters,
   so every size, alpha and fade is frame-independent. No term reads `cam.frame`.
3. Everything that differs between the frames is gone before the switch: `galaxyFade` is 0 beyond 40 kpc, and the
   Milky Way billboard is at full strength there in both.
4. Speed, exposure and HUD text are continuous (§18.5.1, §18.5.2, §18.5.4).
5. `stepFrame`'s hysteresis is unchanged: out at 60 kpc, back at 40, never flapping.

A test drives the camera along a path through both Clouds and back across the band, in both frames, and asserts
identical item lists, screen positions, alphas, labels and pick results (§18.14).

#### 18.5.6 The frames test and float32

- The existing three-level test now runs on the **real** `LEVELS` too: enter at 60 kpc, leave at 40, no flapping at 59
  or 50 kpc, velocity scaled by 1e-6, and `worldPc` preserved to 1e-9 relative across system → galaxy → cosmos →
  galaxy. Old exports (`ENTER_PC`, `rangeOf`, …) keep their names; the asserted galaxy `range`/`autoPc` values change.
- **No static float32 buffer holds Mpc coordinates.** Galaxies, the Milky Way, SMBH markers and their billboards are
  camera-relative doubles cast to float32 per frame, so the error is relative to the distance from the camera
  (6e-8 · 16.9 Mpc ≈ 1 pc at Virgo seen from the Sun, far below a pixel). The galaxy-frame star buffer (pc) is drawn
  only while `galaxyFade > 0`, at most 40 kpc out, where float32 gives 2.4e-3 pc, or 2.4e-7 rad for stars ≥ 10 kpc
  away. A test checks `relFromCam` at 16.9 Mpc for a body 1 kpc from the camera: the float32 cast keeps it to 1e-6.

### 18.6 Renderers

#### 18.6.1 Galaxy billboard (`billboard: 'galaxy'`, new pure module `scene3d-galaxy.js`)

**Geometry (reusing §17.6.1).** The projected-ellipsoid core of `scene3d-nebula.js` is exported as
`projectAxes(c, [A, B, C], project)` → screen covariance, semi-axes, angle, `inside`. Galaxies call it with:
- `A = M̂ · r`, the major axis, `r = D·tan(major/2)` (or `INF_PC·tan(major/2)` at infinity);
- **`B = r·(cos i · m̂ + s·sin i · û)`**, the disc's second axis tilted to the inclination `cos i = minor/major`;
  `s = ±1` from `hashUnit(id, 'tilt')`, because which side is nearer is not known;
- `C = n̂ · 0.1 r`, a disc thickness along the disc normal `n̂ = A × B / |A × B|` (spirals, S0, irregulars);
  ellipticals (`hubble` starting with `E`) use `B = m̂·r·minor/major` and `C = û·|B|`, the nebula depth rule.

Seen from the Sun, `û` projects to ~0, so **the ellipse is exactly the catalogue's major, minor and PA** (to 1e-6 in
the tests, as for nebulae). From elsewhere you see the disc at a plausible 3D tilt. The tilt sign, the thickness and
the elliptical depth are illustrative. The item also carries the **disc affine map** `(a, b)` (the screen images of
`A` and `B`), so the fragment shader can work in disc coordinates for arms and bars.

**Item** `{ id, look, hubble, seed, rel, screen, semiMajorPx, semiMinorPx, angle, affine, inside, alpha, fade,
skyFade, lineAlpha, markerAlpha, markerOnly, hollow, dashed, atInfinity, mode }`:
- `markerOnly`: semi-major under 3 px. Seen from the Sun in a 900 px tall view at a 60° field, M87's semi-major
  axis is 0.8 px (a marker) and M31's about 20 px.
- `fade = smoothstep(1, 3, dist / r)`, as for nebulae: the glow is full at 3 radii (where "Go there" stops) and gone
  inside.
- `hollow`/`dashed`: derived distance, or PA unknown (dashed circle of radius major/2, §17.6.1).

**Brightness (illustrative):** `alpha = clamp(0.35·10^(−0.4(SB − 22.5)), 0.04, 0.6)` with `SB` = `SurfBr`. Without
`SurfBr`, SB comes from B and the ellipse as for nebulae, converted to mag/arcsec² (+8.89); else 0.1. Surface
brightness does not depend on distance, so neither does the glow. Times `skyFade` at infinity, `fade` when placed.

**Look** (fragment shader `galaxy`, additive, drawn after the dark-nebula pass and before stars; colours and profiles
are illustrative, not data):

| Hubble type (first letters) | Bulge share | Disc | Extras | Colour |
|---|---|---|---|---|
| `E` | 1 | — | — | warm |
| `S0`, `SA0`, `SB0` | 0.6 | smooth exponential | — | warm |
| `Sa` … `Sd`, `SA*`, `SAB*` | 0.45 / 0.3 / 0.15 / 0.05 | exponential | 2-arm log spiral in disc coordinates, pitch 10° (Sa) to 25° (Sd), noise | warm bulge, blue-white disc |
| `SB*` | as the letter after `SB` | as above | a bar along disc azimuth `hashUnit(id, 'bar')·180°` | as above |
| `I`, `IB`, `Sm`, `Im`, unknown | 0 | clumpy exponential | fbm clumps | blue |
| `GPair`, `GTrpl`, `GGroup` | — | 2 or 3 soft blobs inside the ellipse | — | white |

Edge-on (`|det(a, b)|` small against the thickness) falls back to the covariance profile with a dark mid-plane lane.

**Evidence view** (`mode: outline`): the §16.10 / §17.6.2 ring at ρ = 1 of the projected ellipse, solid for a
measured distance, dashed for a derived one or an unknown PA, plus the centre marker. No glow, no colour.

#### 18.6.2 Registry spec `galaxy`

| Field | Value |
|---|---|
| `layer`, `noun` | `galaxies` ("Galaxies", group `beyond`), `['galaxy', 'galaxies']` |
| `frames` | `{ galaxy: 'billboard', cosmos: 'billboard' }`; `billboard: (o) => o.render.style === 'milky_way' ? 'milky_way' : 'galaxy'` |
| `galaxyScope` | `'sky'`: the server sends the cone plus the context set (§18.11) |
| `skyFadePc` | 1e5 |
| `pick` | `{ priority: 27, marker: 18 }`, centre only, like nebulae |
| `label` | `key: (o) => (curated or common name ? 0 : 1000) + (render.mag ?? 30)`, max 12 |
| `go` | `'fly-galaxy'`, `arrivePc = 3 × size.radius`; `'look'` when direction-only |
| `card` | Type; Morphology; Distance (value, method in words with its catalogue, tier) or "unknown · drawn on the sky as seen from the Sun"; **Other distances · not used** (one row each from `alt_distances`, with the reason); Velocity (heliocentric, redshift; CMB-frame for Hubble-flow ones); Angular size ("178′ × 70′, PA 35°"); Diameter (inferred, placed only); B magnitude; Surface brightness; **Black holes · 1** (child list from `parent`, §18.8.3); From you (placed only); Look ("illustrative, generated from its type and brightness"; dropped in the Evidence view); Data ("OpenNGC (Mattia Verga), CC BY-SA 4.0", plus "Cosmicflows-4 (Tully et al. 2023)" or "UNGC (Karachentsev et al. 2013)" when its distance came from one). Notes: a Hubble-flow note ("From its velocity with H0 = 74.6 km/s/Mpc and a 300 km/s allowance for its own motion; Planck's H0 would put it 11 % farther."), direction-only, PA unknown, a missing UNGC uncertainty. |

#### 18.6.3 Picking, labels and the HUD

Galaxy entries feed `pickObjects` and `labelCandidates` like nebulae (direction-only ones skipped below
`SKY_PICK_MIN`). The HUD's `beyond` count picks the new kind up with no edit: "463 galaxies (12 direction only)".

### 18.7 The Milky Way (`gal:milky_way`)

A curated record in the `galaxies` dataset, built from `milky_way.json`, always in the `sky` tile.

| Field | Value | Source (`src`, `where`) | Tier |
|---|---|---|---|
| `position` | `fixed`, ra 266.4168371, dec −29.0078106, epoch 2000, `method: orbit-fit`, `dist` 8277 (8268–8286) pc | **copied by the build from `bh:Sgr A*`** in `black_holes.json` (GRAVITY 2022, A&A 657, L12, Sec. 4; Reid & Brunthaler 2004/2020); never typed twice | `measured` |
| `props.ngp_ra`, `props.ngp_dec` | 192.85948°, +27.12825° | Hipparcos and Tycho Catalogues, ESA SP-1200 Vol. 1 §1.5.3, eq. 1.5.9 ("to be regarded as exact quantities") | `catalogue` |
| `props.l_node` | 32.93192° | same, eq. 1.5.10 | `catalogue` |
| `props.thin_disc_scale_length` | 2600 ± 500 pc | Bland-Hawthorn & Gerhard 2016, ARA&A 54, 529 (arXiv:1602.07702), §5.1 margin box "Rt" | `measured` |
| `props.thin_disc_scale_height` | 300 ± 50 pc | same, "zt" at R0 | `measured` |
| `props.thick_disc_scale_length`, `props.thick_disc_scale_height` | 2000 ± 200 pc, 900 ± 180 pc | same, "RT", "zT" | `measured` |
| `props.bar_half_length` | 5000 ± 200 pc | same, §4.3 "Rlb" | `measured` |
| `props.bar_angle` | 27 ± 2° | same, §4.2: "The near side of the b/p bulge has its major axis in the first Galactic quadrant (0° < l < 90°). The bar angle between major axis and the Sun-Galactic center line … is φbp = 27° ± 2°" (the long bar: 28°–33°, §4.3) | `measured` |
| `props.stellar_mass` | 5 ± 1 × 10¹⁰ M☉ | same, §6.4 | `measured` |
| `props.sun_height` | 25 ± 5 pc | same, §3.3 (z0, Jurić et al. 2008) | `measured` |
| `size` | `radius: null`, `angular: null` | BHG16 §5.5: "there is no strong evidence for a truncation to date" | — |
| `render.style` | `milky_way` | | |
| `evidence` | `measured` (the centre) | | |

- **Disc plane.** The normal is the north Galactic pole of the ICRS definition, through Sgr A*. That convention puts
  Sgr A* at b = −0.046°, so the drawn plane passes about 7 pc below the Sun; the card gives the measured z0 = 25 ± 5 pc
  beside it and calls the plane a convention.
- **Look** (`billboard: 'milky_way'`, illustrative): the same `projectAxes` with the true axes `A` = disc radius along
  the GC → (l = 90°) direction, `B` = disc radius along the GC → Sun direction, `C` = 300 pc along the pole. The
  profile is the thin-disc exponential to 6 scale lengths (15.6 kpc), with a 5.0 kpc bar at φ = 27° (its near end at
  positive l), a bulge, and illustrative arms; all of it is illustrative, the sizes are measured. Alpha × (1 −
  `galaxyFade`), so it appears between 20 and 40 kpc as the stars fade.
- **Evidence view:** a solid marker at the centre, nothing else.
- **Card:** "Milky Way · our Galaxy". Rows: centre distance R0 (with GRAVITY's citation and "the same value Sgr A*'s
  card shows"), plane (the NGP and node, "IAU convention"), Sun's height, disc and thick-disc scale lengths and
  heights, bar, stellar mass, Black holes · 1 (Sgr A*), From you, Look ("illustrative: a generic barred spiral drawn
  to the measured sizes"), Data. The measured rows and the look row are visibly separate (the look row is the one the
  Evidence view drops).
- **"Go there":** a flight to a point 60 kpc from the centre along the north pole: a face-on view, ending in `cosmos`.
- **Sgr A\*:** its `parent` becomes `gal:milky_way` in `black_holes.json` (§17.8's one-line change). A test asserts
  the Milky Way's `position.dist` and Sgr A*'s are equal, field for field.

### 18.8 Supermassive black holes (`smbh-curated`; changed at approval, §18.18 item 1)

#### 18.8.1 The list

Chosen for a direct mass (stellar or gas dynamics, a maser disc, or the EHT shadow), a host in OpenNGC with a
catalogue distance, and a spread of types and distances. Every number below was re-read in the paper on 2026-11-19.

| Id (name) | Host | Mass as published (assumed D) | Method, paper and location | Why |
|---|---|---|---|---|
| `bh:M87*` | `ongc:NGC4486` | 6.5 ± 0.2 (stat) ± 0.7 (sys) × 10⁹ M☉ (D = 16.8 +0.8/−0.7 Mpc) | EHT shadow; EHT Collaboration 2019, ApJL 875, L6 (Paper VI, arXiv:1906.11243), abstract, §9.2 and Table 7; distance §8.1 / Table 9 (TRGB + 2 SBF) | the first imaged black hole |
| `bh:NGC 4258*` | `ongc:NGC4258` | 3.98 ± 0.04 × 10⁷ M☉ (D = 7.576 ± 0.082 ± 0.076 Mpc) | maser disc; Reid, Pesce & Riess 2019, ApJL 886, L27 (arXiv:1908.05625), Table 2 and abstract | the geometric anchor of the distance ladder |
| `bh:M31*` | `ongc:NGC0224` | 1.4 × 10⁸ M☉, 1σ range 1.1–2.3 × 10⁸ (D not stated) | stellar dynamics (P3 disc); Bender et al. 2005, ApJ 631, 280 (astro-ph/0509839), abstract and §5 | the nearest large galaxy |
| `bh:M32*` | `ongc:NGC0221` | 2.4 ± 1.0 × 10⁶ M☉ (D = 0.79 Mpc) | stellar dynamics; van den Bosch & de Zeeuw 2010, MNRAS 401, 1770 (arXiv:0910.0844), §3.1.2 and §3.1 | a small one, next to M31 |
| `bh:Cen A*` | `ongc:NGC5128` | 5.5 ± 3.0 × 10⁷ M☉, **3σ** (D = 3.5 Mpc) | stellar dynamics; Cappellari et al. 2009, MNRAS 394, 660 (arXiv:0812.1000), abstract and §2 | the nearest radio galaxy |
| `bh:M81*` | `ongc:NGC3031` | 7.0 +2/−1 × 10⁷ M☉ (D = 3.63 Mpc) | gas dynamics; Devereux et al. 2003, AJ 125, 1226 (doi:10.1086/367595; no arXiv version), abstract and §4, distance §3 | a nearby spiral, low-luminosity AGN |
| `bh:M104*` | `ongc:NGC4594` | 6.6 ± 0.4 × 10⁸ M☉ (D = 9.8 Mpc) | stellar dynamics; Jardel et al. 2011, ApJ 739, 21 (arXiv:1107.1238), abstract and §1 | the Sombrero |
| `bh:NGC 4889*` | `ongc:NGC4889` | 2.1 × 10¹⁰ M☉, 68 % 0.55–3.7 × 10¹⁰ (D = 103.2 Mpc, H0 = 70) | stellar dynamics; McConnell et al. 2011, Nature 480, 215 (arXiv:1112.1078), Supplementary Table 4 | one of the most massive known; a **derived** host distance (FP) |

Left out: NGC 1068 (its maser disc is sub-Keplerian, the two papers give 8.0 ± 0.3 × 10⁶ and ~1 × 10⁷ M☉, and it has
no catalogue distance: it would be direction-only); Circinus, UGC 3789 and other maser hosts, which are not in OpenNGC.

Two paper details are kept in the curated file and the card: Cappellari's interval is 3σ (stored as 1σ = 1.0 × 10⁷,
src "the paper's 3σ ± 3.0, divided by 3"); McConnell's main text gives 0.6–3.7 × 10¹⁰ and the supplementary table
0.55–3.7 × 10¹⁰ (the table is used, with the difference noted).

#### 18.8.2 One distance per system (Q5)

- **The galaxy's adopted distance wins**, for the black hole too. The build copies the host galaxy's `ra`, `dec`,
  `dist`, `method` and evidence into the black-hole record (src "the distance of its host galaxy ongc:NGC4486
  (Cosmicflows-4 SBF)"), and `--check` fails when they drift apart. A frontend test asserts the two are placed at the
  same point.
- **The paper's distance is shown as "not used"**, as `props.dist_published` with the reason: "the mass paper assumed
  16.8 Mpc; the galaxy's catalogue distance is used so the black hole sits at its galaxy's centre". For the two
  papers that *measured* their distance (NGC 4258's maser, and EHT's adopted TRGB + SBF), the agreement is shown too:
  7.586 against 7.576 Mpc, 16.86 against 16.8 Mpc.
- **Dynamical masses scale with the assumed distance** (each paper says so: "The value of the black-hole mass scales
  linearly with assumed distance", Gebhardt et al. 2011 §2; "Black hole mass scales as M• ∝ D", Jardel et al. 2011
  §1; "lengths and masses scale as D", Cappellari et al. 2009 fn. 2; EHT's θg = GM/Dc² is a mass-to-distance ratio).
  So `props.mass` is the published mass × `D_adopted / D_assumed`, and `props.mass_published` keeps the paper's value.
  The tier stays `measured` when the adopted distance is measured, and becomes `inferred` when it is derived (NGC
  4889*).
- **M31\***: Bender et al. 2005 state no assumed distance (a scale of 3.8 pc per arcsec can be worked out, but it is
  not a quote), so its mass is **not rescaled**, and the card says why.

Resulting placements (CF4 moduli, research run): M87 16.86 (16.55–17.17) Mpc, SBF; NGC 4258 7.586 (7.482–7.691) Mpc,
maser; M31 757.5 (734.9–780.9) kpc, Cepheid; M32 776.3 (772.7–779.8) kpc, TRGB; Cen A 3.597 (3.532–3.664) Mpc, TRGB;
M104 9.120 (8.790–9.462) Mpc, TRGB; NGC 4889 106.0 (85.7–131.0) Mpc before the 1/(1+z) step, FP (derived); M81 is not in
CF4, so UNGC's Cepheid 3.63 Mpc (no uncertainty given). M87*'s mass becomes 6.5 ± 0.7 × 10⁹ M☉ (×1.003).

#### 18.8.3 Records, frames and visibility

- `kind: black_hole`, `host: null`, `parent: <galaxy id>`, `position: fixed` (copied, above), `size.radius` = r_s
  (inferred, §17.8), `props`: `mass`, `mass_published`, `dist_published`, `type: "supermassive"`, `state` (e.g.
  "low-luminosity accretion" for M87*, "active nucleus" only where the paper says so), `render.style: "lensing"`.
  M87* also gets `props.ring_diameter`: 42 ± 3 μas, written as 4.2 ± 0.3 × 10⁻⁵ arcsec (EHT Paper I, arXiv:1906.11238,
  abstract), tier `measured`: the one black hole whose size on the sky is itself measured.
- **The SMBHs and Sgr A\* go in a `sky` tile of `bh-curated`**, so a galaxy of the context set always arrives with its
  black hole. Stellar-mass black holes stay cone-only.
- **Frames:** `black_hole` gains `cosmos: (o) => supermassive(o) ? 'lensing' : null`; stellar-mass ones fade with
  `galaxyFade` like every other population without a cosmos renderer.
- **Visibility rule** (pure, `smbhVisible(entry, items)`): an SMBH is drawn and pickable when it is `in_cone`
  (Phase 2's behaviour, so Sgr A* in its cone looks exactly as today), **or** its parent galaxy's billboard item is
  `inside` or at least 40 px in semi-major axis, **or** it is selected. Otherwise it is listed on its galaxy's card
  ("Black holes · 1 · M87* · 6.5 × 10⁹ M☉"), from where it can be selected. So M87 from the Sun outside the M87 cone is
  one marker, and close up the black hole appears at its centre. For the Milky Way, "resolved" also needs the camera
  40 kpc or more from the Sun, so Sgr A* near the Sun keeps its Phase 2 cone rule.
- **Lensing at Mpc:** `lensingItems` already scales through frame units; the radius conversion goes through
  `unitsPerPc(cam)` so the Mpc frame needs no special case. From the Sun M87*'s shadow is about 1e-7 px, so it is always
  enlarged, and the card's existing note says by how much ("Drawn enlarged ×9e7: its shadow would be 1e-7 px from
  here.").
- **"Go there":** `fly-galaxy` to 2 pc, as Sgr A* does today.
- **Unchanged:** Sgr A*'s record except `parent`, and all stellar-mass records and companions byte for byte; the tests
  compare them with the Phase 2 fixtures.

### 18.9 Schema and validator changes

All additive; the schema stays at version 1.
1. `METHODS` += `maser`, `sn-ia`, `sn-ii`, `supernova`, `fundamental-plane`, `horizontal-branch`, `rr-lyrae`, `cmd`,
   `brightest-stars`, `pnlf`, `group-member`.
2. `DERIVED_METHODS` (§18.4.3): a `fixed` `dist` with such a method may not have tier `measured` or `catalogue`.
   `--check` on every existing dataset proves nothing already shipped breaks it.
3. `UNITS` += `km/s`, `mag/arcsec2`.
4. `RENDER_STYLES` += `milky_way`, allowed only on `kind: galaxy` and id `gal:milky_way`.
5. **`alt_distances`** (optional, records with a `fixed` position): a list of at most 4 `{method, dist, reason}`,
   `method` in `METHODS`, `dist` a numeric Quantity in pc or Mpc with `src`, `reason` a non-empty string; rule 2
   applies to each.
6. **Sky tiles** (`objects_static.py`, §6): `manifest.sky_tiles: ["sky"]` names tiles that every query returns
   whatever the cone, with `in_cone` set truthfully; their records are in no other tile; `verify_dataset` checks the
   hashes and that no id is in two tiles; `max_extent_deg` ignores them.
7. `/api/objects` gets Starlette's `GZipMiddleware` (part of FastAPI already; **no new dependency**) for responses over
   1 KB: a Virgo cone is about 0.6 MB of JSON and about a tenth of that compressed.
8. No change to `prefer_record` or `PREFER_RECORD_IDS`.

### 18.10 Evidence and tiers of every new field

| Field | Tier | Record evidence |
|---|---|---|
| galaxy direction | `catalogue` | `measured` when direction-only |
| CF4 / UNGC maser, Cepheid, TRGB, SBF, HB, RR Lyrae, CMD distance | `measured` | `measured` |
| CF4 / UNGC SN Ia, SN II, TF, FP; UNGC BS, PNLF, group membership | `inferred` | `derived` |
| Hubble-flow distance, `v_cmb` | `inferred` | `derived` |
| `alt_distances` entries | their own | — |
| `size.angular`, type, Hubble type, magnitudes, surface brightness, velocity, redshift | `catalogue` | — |
| galaxy `size.radius` | `inferred` | — |
| galaxy look, tilt sign, thickness, arms, bar azimuth | illustrative; card row `illustrative` | hidden in the Evidence view |
| Milky Way centre (= Sgr A*) | `measured` | `measured` |
| Milky Way plane (NGP, node) | `catalogue` (a definition) | — |
| Milky Way scale lengths, heights, bar, mass, z0 | `measured` | — |
| Milky Way look | illustrative; a marker in the Evidence view | — |
| SMBH placement | the host's | the host's |
| SMBH mass | `measured`, `inferred` when rescaled by a derived distance | — |
| `mass_published`, `dist_published` | `measured` (shown as not used) | — |
| M87* ring diameter | `measured` | — |

### 18.11 Layers, scope and the data budget

```js
registerLayer({ id: 'galaxies', label: 'Galaxies', group: 'beyond' });   // default on; the Milky Way and SMBHs follow their own layers
```
The Milky Way billboard belongs to `galaxies`; SMBHs to `blackHoles`. No sub-switches.

**Scope (Q4).** Three options:

| | What the client gets | Per request |
|---|---|---|
| Cone only (as nebulae) | the galaxies in the cone; flying out into `cosmos` from a cone that is not on a cluster shows nearly nothing | 3° cone: median under 10 records; Virgo 5°: 465 |
| Sky-wide | all ~11,440 records, every time | ~7 MB of JSON: no |
| **Cone + context set (recommended)** | the cone, plus every record with an adopted distance ≤ 3 Mpc (~118 from UNGC), B ≤ 10 (50), each SMBH host (8) and the Milky Way: ~150 after overlaps, in `tiles/sky.json` | ~150 KB of JSON, ~25 KB compressed, on top of the cone |

**Data budget.** The `galaxies` dataset is at most **7 MB** on disk (about 600 B a record with `src_table`,
`record_defaults` and at most 8 designations; for comparison `hr23-clusters` is 9.3 MB and `nea-exoplanets` 12 MB).
Its source snapshot is about 2.3 MB (OpenNGC copies 0.89 MB, CF4 1.28 MB, UNGC 0.07 MB). Tiles are `radec-bands` 10°
(§6); the Virgo tile is the largest at roughly 0.5 MB, read once and cached in memory. The build report prints the
real sizes. Over 8 MB, I trim the designation list first.

### 18.12 Gaia credit

The credit text is **"Credit: ESA/Gaia/DPAC"** everywhere (Phase 2's `bh-curated` manifest wrote "Credit: ESA, Gaia
DPAC"; it changes to the same string). ESA's licence page (checked 2026-11-19): "Gaia data are distributed under the CC
BY-NC 3.0 IGO license"; the DR3 credit page gives the acknowledgement for publications.
- **Credits line:** an entry "Stars: Gaia DR3 · Credit: ESA/Gaia/DPAC · CC BY-NC 3.0 IGO" whenever the star payload
  holds Gaia rows. It is a client-side item, since stars come from `/api/scene3d`, not `/api/objects`. Datasets
  carrying Gaia values add theirs through the existing generic path.
- **Star cards:** a `Data` row on every Gaia star ("Gaia DR3 · Credit: ESA/Gaia/DPAC · CC BY-NC 3.0 IGO"), and on
  star records holding Gaia values (the seven companions, NEA hosts with Gaia photometry).
- **Phase 1 data:** `nea-exoplanets`' manifest gains `credit: "NASA Exoplanet Archive; Gaia DR3 values: Credit:
  ESA/Gaia/DPAC"` and `licence_name: "CC BY-NC 3.0 IGO (Gaia DR3 values)"`, because its star records carry Gaia DR3
  ids, positions and G magnitudes from its Gaia side inputs. `hr23-clusters` gains `credit: "Hunt & Reffert 2024, from
  Gaia DR3 (Credit: ESA/Gaia/DPAC)"` with no licence name, because its values are the authors' derived ones. Both
  rebuilds change only the manifest; `--check` is re-baselined in the same commit.
- **`LICENSE`:** one factual sentence naming the folders whose Gaia DR3 values are CC BY-NC 3.0 IGO. What that means
  for the project's licence is Q1, not decided here.

### 18.13 Example records

Stored as `backend/tests/fixtures/objects/examples/*.json`; the build tests assert the built records equal them. The
numbers come from the snapshot rows quoted above; where the build's rounding differs in the last digit the fixture
follows the build and this section is updated in the same commit (§17.12 preamble).

**M31, the Andromeda Galaxy** (OpenNGC + UNGC; CF4 Cepheid: measured):
```json
{ "id": "ongc:NGC0224", "kind": "galaxy", "name": "Andromeda Galaxy",
  "designations": ["M 31", "NGC 224", "UGC 454", "PGC 2557", "MESSIER031"],
  "host": null, "parent": null,
  "position": { "model": "fixed", "ra": 10.6847917, "dec": 41.2690556, "epoch": 2000.0, "method": "cepheid", "tier": "catalogue",
    "dist": { "v": 0.75753, "lo": 0.73485, "hi": 0.78091, "unit": "Mpc", "src": "Cosmicflows-4 (Tully et al. 2023, ApJ 944, 94), table2 PGC 2557: DMceph 24.397 ± 0.066, converted by Space Maps", "tier": "measured" } },
  "alt_distances": [
    { "method": "trgb", "dist": { "v": 0.80538, "lo": 0.76913, "hi": 0.84333, "unit": "Mpc", "src": "Cosmicflows-4 table2: DMtrgb 24.53 ± 0.10", "tier": "measured" }, "reason": "not used: larger uncertainty than the Cepheid distance" },
    { "method": "sbf", "dist": { "v": 0.69631, "lo": 0.67112, "hi": 0.72244, "unit": "Mpc", "src": "Cosmicflows-4 table2: DMsbf 24.214 ± 0.080", "tier": "measured" }, "reason": "not used: larger uncertainty than the Cepheid distance" } ],
  "size": { "radius": { "v": 19597, "unit": "pc", "src": "half the catalogue major axis at the adopted distance", "tier": "inferred" },
    "angular": { "major": { "v": 177.83, "unit": "arcmin", "src": "OpenNGC v20260501", "tier": "catalogue" },
                 "minor": { "v": 69.66, "unit": "arcmin", "src": "OpenNGC v20260501", "tier": "catalogue" },
                 "pa": { "v": 35, "unit": "deg", "src": "OpenNGC v20260501", "tier": "catalogue" } } },
  "props": { "type": { "v": "Galaxy", "src": "OpenNGC v20260501 (G)", "tier": "catalogue" },
             "hubble": { "v": "Sb", "src": "OpenNGC v20260501", "tier": "catalogue" },
             "mag_b": { "v": 4.29, "unit": "mag", "src": "OpenNGC v20260501", "tier": "catalogue" },
             "mag_v": { "v": 3.44, "unit": "mag", "src": "OpenNGC v20260501", "tier": "catalogue" },
             "surface_brightness": { "v": 23.63, "unit": "mag/arcsec2", "src": "OpenNGC v20260501", "tier": "catalogue" },
             "v_helio": { "v": -300, "unit": "km/s", "src": "OpenNGC v20260501", "tier": "catalogue" },
             "redshift": { "v": -0.001, "src": "OpenNGC v20260501", "tier": "catalogue" } },
  "provenance": { "source": "static:galaxies", "dataset": "galaxies", "catalogue": "OpenNGC + UNGC (J/AJ/145/101) + Cosmicflows-4 (J/ApJ/944/94)", "version": "OpenNGC v20260501 (36cb178a)" },
  "evidence": "measured", "render": { "mag": 4.29 } }
```
(M31's distance is 757.5 kpc before the 1/(1+z) step; for a blueshifted galaxy the step uses `Vcmb` of the CF4 row and
is below 0.1 %, and the build's value goes into the fixture.)

**M87** (CF4 SBF: measured), only what differs in shape:
```json
{ "id": "ongc:NGC4486", "name": "Messier 87", "designations": ["M 87", "NGC 4486", "Virgo Galaxy", "UGC 7654", "PGC 41361"],
  "position": { "model": "fixed", "ra": 187.7059167, "dec": 12.3911111, "epoch": 2000.0, "method": "sbf", "tier": "catalogue",
    "dist": { "v": 16.858, "lo": 16.550, "hi": 17.171, "unit": "Mpc", "src": "Cosmicflows-4 table2 PGC 41361: DMsbf 31.134 ± 0.040, converted by Space Maps", "tier": "measured" } },
  "props": { "hubble": { "v": "E", "src": "OpenNGC v20260501", "tier": "catalogue" }, "v_helio": { "v": 1256, "unit": "km/s", "src": "OpenNGC v20260501", "tier": "catalogue" } },
  "evidence": "measured", "render": { "mag": 9.65 } }
```

**M87\*** (the host's distance, the EHT mass rescaled ×1.003):
```json
{ "id": "bh:M87*", "kind": "black_hole", "name": "M87*", "designations": ["M87*"],
  "host": null, "parent": "ongc:NGC4486",
  "position": { "model": "fixed", "ra": 187.7059167, "dec": 12.3911111, "epoch": 2000.0, "method": "sbf", "tier": "catalogue",
    "dist": { "v": 16.858, "lo": 16.550, "hi": 17.171, "unit": "Mpc", "src": "the distance of its host galaxy ongc:NGC4486 (Cosmicflows-4 SBF)", "tier": "measured" } },
  "size": { "radius": { "v": 1.926e10, "unit": "km", "src": "Schwarzschild radius from the mass (non-rotating)", "tier": "inferred" }, "angular": null },
  "props": {
    "mass": { "v": 6.52e9, "lo": 5.79e9, "hi": 7.25e9, "unit": "Msun", "src": "EHT Collaboration 2019, ApJL 875, L6 (arXiv:1906.11243), abstract: 6.5 ± 0.2 (stat) ± 0.7 (sys) × 10^9 at 16.8 Mpc, errors in quadrature, rescaled to 16.858 Mpc (M ∝ D)", "tier": "measured" },
    "mass_published": { "v": 6.5e9, "lo": 5.77e9, "hi": 7.23e9, "unit": "Msun", "src": "EHT 2019 Paper VI, at D = 16.8 Mpc", "tier": "measured" },
    "dist_published": { "v": 16.8, "lo": 16.1, "hi": 17.6, "unit": "Mpc", "src": "EHT 2019 Paper VI, §8.1 (TRGB + two SBF): not used, the galaxy's catalogue distance is used", "tier": "measured" },
    "ring_diameter": { "v": 4.2e-5, "lo": 3.9e-5, "hi": 4.5e-5, "unit": "arcsec", "src": "EHT Collaboration 2019, ApJL 875, L1 (arXiv:1906.11238), abstract: 42 ± 3 μas", "tier": "measured" },
    "type": { "v": "supermassive", "src": "curated", "tier": "catalogue" } },
  "provenance": { "source": "static:bh-curated", "dataset": "bh-curated", "catalogue": "Space Maps curated black holes", "version": "2" },
  "evidence": "measured", "render": { "style": "lensing" } }
```

**NGC 12** (no catalogue distance; Hubble flow: derived):
```json
{ "id": "ongc:NGC0012", "name": "NGC 12",
  "position": { "model": "fixed", "ra": 2.1864583, "dec": 4.6125278, "epoch": 2000.0, "method": "redshift", "tier": "catalogue",
    "dist": { "v": 47.18, "lo": 42.71, "hi": 51.64, "unit": "Mpc", "src": "Hubble flow: v_helio 3886 km/s (OpenNGC) → v_CMB 3527.7 km/s (Planck 2018 dipole), H0 = 74.6 ± 3.1 (Cosmicflows-4), q0 = −0.595, peculiar velocity 300 km/s (Cosmicflows-4 §13)", "tier": "inferred" } },
  "props": { "v_cmb": { "v": 3527.7, "unit": "km/s", "src": "v_helio + Planck 2018 solar dipole (369.82 km/s toward l 264.021°, b 48.253°)", "tier": "inferred" } },
  "evidence": "derived" }
```

**IC 47** (no velocity: direction-only), `"position": {"model": "fixed", "ra": 10.7292083, "dec": -13.7407222, "epoch":
2000.0, "tier": "catalogue", "dist": null}`, `"size": {"radius": null, …}`, `"evidence": "measured"`.

**And XVIII** (UNGC-only, TRGB with no published uncertainty):
`"id": "ungc:And XVIII"`, `"position": {"ra": 0.5604167, "dec": 45.0888889, "method": "trgb", "dist": {"v": 1.36,
"unit": "Mpc", "src": "UNGC (Karachentsev et al. 2013, J/AJ/145/101): Dist 1.36 Mpc, TRGB; no per-galaxy error given,
values rounded to 0.01 Mpc", "tier": "measured"}}`, size `major` 1.40′, `minor` 1.39′, `pa` null.

**The Milky Way:**
```json
{ "id": "gal:milky_way", "kind": "galaxy", "name": "Milky Way", "designations": ["Galaxy", "Milky Way (UNGC)"],
  "host": null, "parent": null,
  "position": { "model": "fixed", "ra": 266.4168371, "dec": -29.0078106, "epoch": 2000.0, "method": "orbit-fit",
    "dist": { "v": 8277, "lo": 8268, "hi": 8286, "unit": "pc", "src": "GRAVITY Collaboration 2022, A&A 657, L12 (arXiv:2112.07478), Sec. 4: R0 = 8277 ± 9 pc (statistical; systematic ≈ 30 pc)", "tier": "measured" } },
  "size": { "radius": null, "angular": null },
  "props": {
    "ngp_ra": { "v": 192.85948, "unit": "deg", "src": "Hipparcos and Tycho Catalogues (ESA 1997, SP-1200) Vol. 1 §1.5.3, eq. 1.5.9 (exact by definition)", "tier": "catalogue" },
    "ngp_dec": { "v": 27.12825, "unit": "deg", "src": "same, eq. 1.5.9", "tier": "catalogue" },
    "l_node": { "v": 32.93192, "unit": "deg", "src": "same, eq. 1.5.10", "tier": "catalogue" },
    "thin_disc_scale_length": { "v": 2600, "lo": 2100, "hi": 3100, "unit": "pc", "src": "Bland-Hawthorn & Gerhard 2016, ARA&A 54, 529 (arXiv:1602.07702), §5.1: Rt = 2.6 ± 0.5 kpc", "tier": "measured" },
    "bar_half_length": { "v": 5000, "lo": 4800, "hi": 5200, "unit": "pc", "src": "same, §4.3: Rlb = 5.0 ± 0.2 kpc", "tier": "measured" },
    "bar_angle": { "v": 27, "lo": 25, "hi": 29, "unit": "deg", "src": "same, §4.2: φbp = 27° ± 2°, near side in the first quadrant", "tier": "measured" } },
  "provenance": { "source": "static:galaxies", "dataset": "galaxies", "catalogue": "Space Maps curated (Milky Way)", "version": "1" },
  "evidence": "measured", "render": { "style": "milky_way" } }
```
(and the other `props` of §18.7). **Sgr A\*:** §17.12 with `"parent": "gal:milky_way"`, nothing else changed.

### 18.14 Test plan

**Backend** (`uv run pytest`, offline):
- `test_objects_schema.py`: the §18.13 examples validate; counter-examples fail: a TF or `redshift` distance with tier
  `measured`; a malformed `alt_distances` (5 entries, unknown method, no reason, a derived method marked measured);
  `render.style: milky_way` on any other id or kind; unknown units.
- `test_objects_static.py`: a sky tile is returned for a cone on the far side of the sky, with `in_cone: false`; an id
  in a sky tile and a cone tile fails `verify_dataset`; `max_extent_deg` ignores sky tiles.
- `test_build_galaxies.py` (synthetic rows plus the snapshot):
  - parsing (types, Dup folding, NonEx, UNGC sexagesimal, `a26`·`b/a`);
  - every merge step (identifier with `NGC0205` and `MESSIER031`, the three overrides, positional with the velocity
    test, conflict fallback), with the pairs asserted on the snapshot: M31, M32, NGC 205, M81, NGC 4258 and Cen A by
    name, the LMC and SMC by override, and the UNGC Milky Way row never becoming a record;
  - CF4 by PGC; the UNGC-only positional join;
  - the distance ladder: class, has-uncertainty, smallest error, catalogue order, ties; M31 picks Cepheid with TRGB
    and SBF in `alt_distances`; NGC 4258 picks the maser; M81 falls back to UNGC Cepheid with no interval;
  - the method → tier table (each row), and UNGC `h`/`h′`/`txt` never used;
  - modulus → distance and the 1/(1+z) step; the Hubble flow (CMB dipole against a hand-computed direction, the
    q0 term, the interval, below 1000 km/s → direction-only, a blueshifted galaxy → direction-only);
  - the LMC at 49.4 kpc and the SMC at 63.9 kpc (±0.1);
  - the Milky Way's position and `dist` equal Sgr A*'s in `black_holes.json`, field for field; the build fails when
    `centre_from` names a missing record, or `milky_way.json` has a number without `src`/`where`;
  - the context set: membership rules, about 150 records, the Milky Way and the 8 hosts in it;
  - licence: `LICENSE.md` in both folders, `credit`, `licence_name: "CC BY-SA 4.0"`, the CF4/UNGC/EDD citations;
  - §18.13 records equal the built ones; byte-identical rebuild and `--check`; the report's counts per method and
    evidence; the size budget (dataset ≤ 7 MB).
- `test_build_bh.py`: each SMBH's position and distance equal its host's built record; `--check` fails after a
  galaxy distance is changed; rescaled masses (M87* ×1.0034, M104* ×0.9306), M31* not rescaled; NGC 4889*'s mass
  `inferred` and placement `derived`; Cen A*'s 3σ → 1σ; every SMBH has `src` and `where` on every number; the SMBHs
  and Sgr A* are in the sky tile; **Sgr A* differs from Phase 2 only in `parent`, and every stellar-mass record and
  companion is byte-identical to Phase 2's**; the Gaia credit string.
- `test_build_nea.py`, `test_build_hr23.py`: the new `credit` (and `licence_name` for NEA); `--check`.
- `test_objects_api.py`: the M31 cone returns M31 (measured, Cepheid), M32, NGC 205, the context set and M31*; the
  M87 cone returns M87 and M87* at the same distance; a cone with no galaxies still returns the context set; gzip
  when asked; `--check` on all **six** datasets.

**Frontend** (`node --test`):
- `scene3d-frames.test.mjs`: the real three-level `LEVELS`; 60/40 kpc round trips; no flapping; speed and velocity
  scaling; `worldPc` precision; float32 `relFromCam` at 16.9 Mpc; the new `range`/`autoPc` values.
- `scene3d-galaxy.test.mjs` (new): from the Sun the screen ellipse equals major, minor and PA to 1e-6 (several PAs,
  near the pole, an elliptical, a disc); seen from the side, a disc galaxy shows its tilt and thickness; `minor` or
  `pa` missing; `markerOnly` under 3 px; brightness from `SurfBr` and the fallbacks; `fade` at 1 and 3 radii; looks by
  Hubble type; outline solid / dashed; the Milky Way item's axes from the NGP and node (the Sun 8,277 pc from the
  centre, b of Sgr A* = −0.046°), its alpha against `galaxyFade`, a marker only in the Evidence view.
- `scene3d-objects.test.mjs`: `galaxyFade` at 0, 20, 30, 40, 60 kpc; populations without a cosmos renderer are not
  drawn in `cosmos` and fade in the galaxy frame; per-kind `skyFade`; **the boundary test of §18.5.5** (a path in and
  out of the 40–60 kpc band past both Clouds, run in both frames: the same items, screen positions to 1e-6 px, alphas,
  labels and picks); `smbhVisible` (in cone, resolved parent, selected, the Milky Way's 40 kpc condition);
  `childrenOf` a galaxy id; the credits line with the Gaia star item; `planGo` for a placed galaxy, a direction-only
  one ('look') and the Milky Way.
- `scene3d-registry.test.mjs`: the `galaxies` layer; galaxy cards for measured, derived catalogue, Hubble-flow,
  direction-only and UNGC-without-error records, with tiers; "not used" rows; the look row dropped in the Evidence
  view; the Data row; the Milky Way card's measured / illustrative split; the SMBH card (published mass and distance
  not used, the rescaling factor, the enlargement note, the ring diameter); the Gaia `Data` row on star cards.
- `scene3d-format.test.mjs`: `fmtDistPc` and `fmtSpeedPc` across AU, pc, kpc and Mpc.
- `scene3d-nav.test.mjs`: `suggestSpeed` with the level's cap.

**By hand** (the real app, backend started fresh): the list in the brief's "Verify before pushing" (M31, M87 and
Virgo from `cosmos`, NGC 4258, the LMC boundary, the Galactic Centre, an all-direction-only cone, TRAPPIST-1 / Pleiades /
Orion regression, the credits line at 375, 768 and 1280 px), plus frame time in the Virgo cone.

### 18.15 Work split

`scene3d.js` has one owner at a time: C1, then C2.

| Slice | Model | Files (exclusive) | Depends on |
|---|---|---|---|
| A. Schema, static tiles, gzip | Sonnet | `objects.py`, `objects_static.py`, `main.py` (middleware only), `test_objects_schema.py`, `test_objects_static.py`, schema-level fixtures | this section |
| G. Galaxy build | Sonnet, after A's commit | `backend/scripts/build_objects_galaxies.py`, `backend/data/sources/galaxies/**` (I write `milky_way.json`, the overrides and the names), `frontend/data/objects/galaxies/**` (both with `LICENSE.md`), `test_build_galaxies.py`, galaxy fixtures | A |
| H. Black holes | Sonnet, after G's data | `build_objects_bh.py`, `backend/data/sources/bh-curated/**` (I write the SMBH entries), `frontend/data/objects/bh-curated/**`, `test_build_bh.py`, BH fixtures | G |
| E. Gaia credit in Phase 1 builds | Sonnet, in parallel with G | `build_objects_nea.py`, `build_objects_hr23.py`, their `frontend/data/objects/*/manifest.json`, their tests | A |
| B. Frontend pure modules | Sonnet, in parallel with A, G, E | `scene3d-frames.js`, `scene3d-objects.js`, `scene3d-nebula.js` (export `projectAxes`), `scene3d-galaxy.js` (new), `scene3d-registry.js`, `scene3d-format.js`, `scene3d-nav.js`, their tests | this section |
| C1. Renderer: cosmos frame, fades, galaxy billboards, HUD, credits line | Sonnet, after B | `scene3d.js`, `scene3d-shaders.js`, `scene3d-main.js`, `scene3d-card.js`, `scene3d.html`, `scene3d.css` | B, G's data |
| C2. Renderer: the Milky Way, SMBHs at Mpc, galaxy "Go there", the Gaia star-card row | Sonnet, after C1 | the same files | C1, H's data |
| D. Docs, mock server, integration, review | me | this doc, `docs/technical-reference.md`, `frontend/dev/mock_server.py`, `test_objects_api.py`, `LICENSE` | all |

Haiku runs both suites after each slice, and `--check` on all six datasets.

Commits: (1) this design; (2) schema and static tiles; (3) galaxy build and data; (4) Gaia credit in Phase 1
manifests; (5) black holes; (6) frontend pure modules; (7) renderer: cosmos and galaxies; (8) renderer: the Milky Way
and SMBHs; (9) docs and mock server.

### 18.16 Phase 4 checklist

**Split into Phases 4–7 (2026-11-20, §19):** the follow-ups below are divided as
- **Phase 4, fixes and data (§19):** `EVIDENCE_HIDES_FEATURES`; the README `online` marker; the Gaia-parallax HII
  distances; Q1's licensing applied repository-wide; group-averaged CF4 distances; the "you came from here" marker in
  `cosmos`; the compact tile encoding; the cited radii of the four clusters; and §18.19's "Left rough" list;
- **Phase 5, time and behaviour:** orbit animation over time; the general evidence rule for hosted kinds; the cluster
  member-star highlight; a per-galaxy `kpc` frame, if resolved stars of other galaxies are ever shown;
- **Phase 6:** migrating "Turn back the sky" onto the shared catalogues;
- **Phase 7, lensing and real images:** true gravitational lensing of the background; real image billboards,
  preferring tiled sky surveys.


- [ ] Real image billboards (§17.6.4), preferring tiled sky surveys with proper sky alignment over press images, licence permitting.
- [ ] True gravitational lensing of the background (§17.9).
- [ ] `EVIDENCE_HIDES_FEATURES`.
- [ ] The README `online` marker.
- [ ] The cluster member-star highlight (§16.12).
- [ ] Orbit animation over time.
- [ ] Migrating "Turn back the sky" onto the shared catalogues.
- [ ] A general evidence rule for all hosted kinds (§17.15, approval condition 2).
- [ ] Gaia-parallax-based HII-region distances (§17.4).
- [ ] Whatever Q1 decides about the Gaia NC term and EDD's terms, applied repository-wide.
- [ ] A per-galaxy `kpc` frame (§8) if resolved stars of other galaxies are ever shown.
- [ ] Group-averaged CF4 distances (its `groups` table) as a third option for galaxies with only a TF/FP distance.
- [ ] A Sun / "you came from here" marker in `cosmos`.
- [ ] A compact Quantity encoding (or a per-tile column layout) to bring `galaxies` from 12.5 MB towards the 7 MB budget (§18.19).
- [ ] Cited radii for the Centaurus, Abell 1367, Hercules and Hydra clusters, so their members get the §18.4.6 rule.

### 18.17 Open questions

1. **Non-commercial terms.** Gaia DR3 is CC BY-NC 3.0 IGO, and EDD's terms allow CF4 data to be used and shared "for
   research and education". Both are about to be on screen together with CC BY-SA and MIT material. How should the
   project treat them? *Recommendation:* keep both, label them (credits line, cards, `LICENSE.md`, one sentence in
   `LICENSE`), treat Space Maps as non-commercial education, and decide before any commercial use (ESA's
   authorisation, or swapping the Gaia layer). This design implements only the labelling.
2. **H0 for Hubble-flow distances.** *Recommendation:* CF4's 74.6 ± 0.8 (stat), ~3 (sys), the scale of the catalogue
   distances shown beside them. Alternatives: SH0ES 73.04 ± 1.04 (2 % farther) or Planck 67.36 ± 0.54 (11 % farther,
   and inconsistent with the Cepheid-scale neighbours).
3. **Hubble-flow threshold and frame.** *Recommendation:* the CMB frame and v_CMB ≥ 1000 km/s with a 300 km/s floor
   (~5,930 placed, ~864 direction-only, intervals ≥ 30 % at the threshold, all hollow/dashed). Alternative: 3000 km/s
   (~4,984 placed, ~1,810 direction-only), safer against the Local Group's own motion and Virgo infall.
4. **Scope in `cosmos`.** *Recommendation:* the cone plus the ~150-record context set (D ≤ 3 Mpc, B ≤ 10, SMBH hosts,
   the Milky Way), ~25 KB compressed per request. Cone-only leaves `cosmos` nearly empty; sky-wide is ~7 MB a request.
5. **SMBH list and the distance rule.** *Recommendation:* the eight of §18.8.1; the galaxy's catalogue distance wins
   and the paper's is shown as not used; dynamical masses are rescaled linearly to it, with the published value shown
   beside (M31* not rescaled, because its paper states no distance). The alternative is to show the paper's mass
   unscaled, at a distance that is not the one it is drawn at.
6. **UNGC distances without errors.** About 240 Local Volume dwarfs (most UNGC-only) would be placed from UNGC's
   TRGB/HB/CMD distances, which have no per-galaxy error and are rounded to 0.01 Mpc (±5 kpc, up to ~12 % for the
   Milky Way satellites near the 60 kpc boundary). *Recommendation:* keep them `measured`, with no interval on the card
   and the rounding stated in the src and a card note. The alternative is to mark them `derived` (hollow), which
   undersells a TRGB distance.

### 18.18 Decisions at approval (2026-11-19)

The open questions of §18.17 were answered as follows. Each decision is folded into the section named; where an
earlier part of §18 says otherwise, this section wins.

1. **Non-commercial terms: accepted.** Space Maps is treated as non-commercial education; everything is labelled, and
   the question is decided again before any commercial use. Conditions:
   - The repository `LICENSE` says which data files are **not** MIT: Gaia-derived values (CC BY-NC 3.0 IGO),
     Cosmicflows-4/EDD-derived values (EDD terms, with citations) and OpenNGC-derived files (CC BY-SA 4.0), plus a short
     **"Before any commercial use"** list of exactly which datasets would have to be removed, replaced or cleared.
   - **Files that mix terms** (checked file by file; nothing is relicensed, and each value keeps its source's terms,
     named per folder in `LICENSE.md` and per value in its `src`):
     - **`nebulae` mixes CC BY-SA 4.0 OpenNGC data with Gaia-derived values**: the 59 planetary-nebula distances and
       central-star ids come from Chornay & Walton 2021, which are Gaia EDR3 parallaxes (CC BY-NC 3.0 IGO). Handled by
       labelling: both nebula `LICENSE.md` files say so, the manifest's `credit` adds "PN distances from Gaia EDR3:
       Credit: ESA/Gaia/DPAC", and the dataset is on the "Before any commercial use" list (a commercial build would
       rebuild it without the Chornay & Walton distances, leaving those 59 nebulae direction-only).
     - **`galaxies` mixes CC BY-SA 4.0 OpenNGC data with Cosmicflows-4 distances** under EDD's "research and education"
       terms (and VizieR-served UNGC and McConnachie values). No Gaia values. Handled the same way.
     - **The supermassive black holes move to their own dataset, `smbh-curated`** (§18.8), instead of `bh-curated`,
       because they copy their galaxies' OpenNGC positions and CF4 distances; `bh-curated` holds Gaia values, and the two
       are kept out of one file. `smbh-curated` mixes OpenNGC, CF4 and the papers' values like `galaxies`; no Gaia.
     - `bh-curated` (Gaia + papers), `nea-exoplanets` (NEA + Gaia) and `hr23-clusters` (Hunt & Reffert's values derived
       from Gaia DR3) hold no OpenNGC data. The Milky Way record copies Sgr A*'s values, which come from GRAVITY and
       Reid & Brunthaler, not Gaia.
2. **H0 = 74.6 (Cosmicflows-4): accepted.** The Hubble-flow interval is **not** widened by H0's uncertainty (the CF4
   distances beside them do not include it either): `σ_D/D = σ_v / v_CMB` (§18.4.4). Every Hubble-flow `src` and card
   note states "H0 = 74.6 km/s/Mpc (Cosmicflows-4 scale); Planck's 67.4 would place it about 11 % farther".
3. **CMB frame, 1000 km/s threshold, 300 km/s floor: accepted, with the rich clusters handled separately.** 147
   Hubble-flow candidates lie within 8° of M87 below 3000 km/s, so the count is significant. Chosen: **members of Virgo,
   Fornax, Coma and Perseus take their CF4 group distance as `derived`** (`group-member`), with the cluster radius from
   a cited paper as extra line-of-sight depth, and membership by the cited radius and a 3σ velocity window around the
   CF4 group velocity using cited dispersions (§18.4.6). The build report gives how many galaxies this touches.
4. **Cone plus the context set: accepted.** Membership is computed by the build from the stated rule (adopted distance
   ≤ 3 Mpc, B < 10, the SMBH hosts, the Milky Way) and listed in the build report. A record in both the cone and the
   context set is sent once (the sky tile's records are in no cone tile, and the merge de-duplicates ids). **The
   context set stays per-request**, not a separate cached file: the store replaces its contents on every payload, so a
   second, once-fetched file would need a merge path in the store and the renderer, which is more than a small change.
   Compressed, it adds about 25 KB per request.
5. **The eight black holes and the distance rule: accepted as designed.** Also: a mass rescaled by a `derived` distance
   becomes `inferred` (NGC 4889*); NGC 4258's galaxy and black hole share the CF4 maser distance (7.586 Mpc), and the
   card shows Reid et al. 2019's 7.576 ± 0.082 ± 0.076 Mpc as not used, explaining that CF4's maser modulus is that
   measurement rounded to 0.01 mag; tests assert every rescaling factor. The SMBHs live in `smbh-curated` (item 1).
6. **UNGC distances without errors: kept `measured`, with no invented interval and the rounding stated on the card,
   but not for the Local Group.** The LMC and SMC get curated eclipsing-binary distances; other Local Group galaxies
   get McConnachie 2012's distances with errors (VizieR `J/AJ/144/4`, verified live), an approved exception to "at most
   two" (§18.4.7). The boundary is re-checked with the real distances: the LMC (49.59 kpc) lies wholly inside the
   40–60 kpc band, the SMC (62.44 kpc) straddles the 60 kpc entry line (§18.5.5).

Everything else in §18 is approved as written.

### 18.19 Implementation notes (stage 2, 2026-11-19)

What the build changed from the design above, and what the browser checks left open. The design text is not edited
to match; where the two differ, this section describes what ships.

**Data**
- **Size.** The `galaxies` dataset is **12.5 MB** on disk (11.6 MB of tiles, a 0.9 MB manifest), about 1.0 MB
  gzipped, against the 7 MB budget of §18.11. The budget assumed about 600 B a record; with every number a Quantity
  object (value, interval, unit, tier, `src` index) a record averages 1.06 KB. Trimming designations saves 0.2 MB, so
  they are kept. The build moved the Hubble-flow `src` to one constant string (the velocities are in `props.v_helio`
  and `props.v_cmb`), shortened the CF4 `src`, and put `kind`, `host` and `parent` in `record_defaults`, saving about
  2.6 MB. The build's size cap is 13 MB. It is in line with `nea-exoplanets` (12 MB) and `hr23-clusters` (9.3 MB), and
  only the tiles a cone touches are read. Getting under 7 MB would need a compact Quantity encoding (Phase 4 checklist).
- **Cosmicflows-4 distances are divided by 1 + Vcmb/c** (§18.4.1). The examples in §18.13 were written without that
  step, so the shipped values differ slightly: M31 0.759 Mpc (§18.13: 0.75753), M87 16.768 Mpc (16.858), NGC 4258
  7.569 Mpc (7.586). NGC 12's interval is 43.16–51.19 Mpc: it carries no H0 term (§18.18 item 2). The test fixtures
  follow the build.
- **Counts** (build report): 11,449 records (10,791 OpenNGC, 657 UNGC-only, the Milky Way); 1,850 `measured`, 9,599
  `derived`; 912 direction-only (762 without a velocity, 150 below v_CMB = 1000 km/s). By method: Hubble flow 5,763,
  Tully–Fisher 2,236, fundamental plane 1,050, SBF 413, TRGB 405, group member 308, SN Ia 192, Cepheid 59, McConnachie
  resolved stars 52, SN II 32, brightest stars 18, maser 4, eclipsing binary 2, CMD 1, horizontal branch 1, orbit fit 1.
- **Merge.** UNGC rows were merged into OpenNGC records 193 times by identifier, once by a Dup-row name, 4 times by
  override (LMC, SMC, Fornax; the Milky Way row is dropped) and 14 times by position (the research run expected about
  24). The Fornax dwarf's two catalogue centres are 4.7′ apart, beyond the positional cap, so it was drawn twice (once
  at McConnachie's 147 kpc, once direction-only) until the browser check added the override.
  3,945 OpenNGC galaxies join CF4 by PGC (research: 3,946; the missing one was not traced), and 295 UNGC-only records
  join it by position.
- **Rich clusters (§18.4.6).** 178 galaxies are placed at a CF4 group distance: Virgo 119, Coma 35, Perseus 21,
  Fornax 3. That is fewer than the 147 Virgo candidates the research counted inside 8°, because the rule uses the
  cited 6° radius and the 3σ velocity window. Only galaxies that would otherwise get a Hubble-flow distance (v_CMB ≥
  1000 km/s) can become members; lower-velocity galaxies in the Virgo window stay direction-only, and the build report
  counts them per cluster. The interval adds the cluster radius in quadrature to the group's modulus error. The other
  130 `group-member` records are UNGC's own `mem` distances.
- **Local Group (§18.4.7).** All 70 usable McConnachie rows matched a record. 52 are adopted; the other 18 lose on
  fractional error to a CF4 value (M31's CF4 Cepheid at ±0.066 mag beats McConnachie's ±0.07). Sgr dSph matched by name
  with an added alias (`Sagittarius` → `Sag`) and sits at 26.3 kpc, with UNGC's TRGB value in `alt_distances`. The
  curated LMC and SMC distances are stored in pc.
- **Context set.** 161 galaxy records in the sky tile (everything within 3 Mpc, B ≤ 10, the eight SMBH hosts, the Milky
  Way). It is served per request, not as a separate file, because the client's store replaces its contents with each
  payload (§18.18 item 4).
- **SMBHs (`smbh-curated`).** Factors adopted/published: M87\* 0.998095, NGC 4258\* 0.999116, M32\* 0.984190, Cen A\*
  1.025114, M81\* 1.000000, M104\* 0.926173, NGC 4889\* 1.004360 (mass `inferred`, record `derived`); M31\* is not
  rescaled. NGC 4258\*'s `assumed_dist_is_measurement` has no field of its own: it is stated in the `dist_published`
  `src` and in `mass_note`. M81\*'s host distance (UNGC, Cepheid) has no interval, so its mass interval is the paper's.
  An extra `props.mass_method` carries the paper's method in words. M87\*'s `state` is the curated text ("accreting: the
  EHT ring and a relativistic jet"), not §18.8.3's wording.
- **Mirrors.** CfA hung or reset connections during the refresh, so some snapshots came from IDIA. `SOURCE.json`
  records the mirror for each file, and the sha256 pins are in the script.
- **Coupling.** `build_objects_galaxies.py` imports `build_objects_nebulae` (OpenNGC parsing, licence text) and
  `build_objects_bh` (the Sgr A\* conversion). `build_objects_smbh.py` reads the built galaxy tiles, and its `--check`
  names the host whose distance drifted.

**Frontend**
- `galaxyItem` builds the disc axes with an analytic perspective and thickness correction, so that seen from the Sun
  the drawn ellipse is the catalogue ellipse to 1e-6. The literal B/C axes of §18.6.1 are not exact.
- The Milky Way card's title is "Milky Way" and its subtitle "our Galaxy" (§18.7 wrote them as one line).
- The SMBH card computes the rescale factor as adopted distance / `dist_published` and falls back to the mass ratio.
  The M31\* reason is `props.mass_note`.
- The galaxy card shows heliocentric velocity and redshift on one "Velocity" row, plus a "Velocity (CMB frame)" row for
  Hubble-flow records. The group-member note takes the cluster name and the CF4 group id from the distance `src`.
- A kind with a `cosmos` renderer (the SMBHs) is not held to the cone in the galaxy and cosmos frames.
  `smbhVisible`/`withSmbh` decide what is drawn.
- The renderer (C1/C2) adds the Milky Way and galaxies as auto-throttle surfaces only from outside their drawn disc, with
  a galaxy's surface distance floored at 5 % of its centre distance; otherwise starting inside the disc, or flying into
  M31, stalls the throttle. Speed across a frame switch goes through `carrySpeed` (the ratio of the levels' units).
- The credits line counts the sky-tile galaxies and SMBHs even outside the cone (`datasetCounts(..., { skyScope })`),
  except Sgr A\*: it carries no Gaia values, so `bh-curated`'s Gaia credit appears only when its cone is open.
- A galaxy card lists its black holes twice: the "Black holes · N" row and a list with a Go there each.

**Browser checks (2026-11-19, a fresh backend on the committed tree, 1280 × 800 plus 375/768/1280 for the credits)**

Passed: M31 (CF4 Cepheid 759 ± 23 kpc, four "not used" alternatives, solid outline in the Evidence view); M87 and M87\*
(the same 16.77 ± 0.31 Mpc, mass ×0.9981, "Drawn enlarged ×4e7"); the trip to M87 crosses into `cosmos` once and the
HUD reads Mpc; NGC 4258 and its black hole share the CF4 maser distance with Reid 2019's value listed as not used; the
LMC and SMC (below); the Galactic Centre (Sgr A\* names the Milky Way; both use R0 = 8277 ± 9 pc); the Milky Way's Go
there (60 kpc above the centre, face-on, one switch); a cone of direction-only galaxies (IC 3705, 0.5°): "Turn to it"
turns back to the galaxy and does not move the camera; TRAPPIST-1 (7 planets, the Gaia row), the Pleiades and Orion
unchanged.

The 60/40 kpc boundary, measured in world pc from the Sun on autopilot legs along the LMC and SMC directions: the
switch to `cosmos` fires at 60.02–60.06 kpc and back at 39.73–39.90 kpc, once per crossing, and legs that turn
inside the band (55, 58, 61 kpc) do not switch. The SMC, whose disc straddles the 60 kpc line, grows smoothly through
the switch frame (×1.23, ×1.28, ×1.38, ×1.58 at the switch, ×2.29): no jump, as the frame-independent sizes intend.

Fixed during the checks (each its own commit):
- Galaxy glows were too faint to see (M31 peaked near 5 %): the glow factor is now 3× the nebulae's (`GAL_K`), with the
  §18.6 alpha law unchanged.
- The SMBH card gave the distance in pc (1.677 × 10⁷ pc); it now uses kpc/Mpc as the galaxy card does, and names the
  galaxy ("Galaxy · Milky Way" for Sgr A\*).
- The credits line now names Cosmicflows-4 and EDD beside OpenNGC (manifest `credit`/`licence_name` of `galaxies` and
  `smbh-curated`; tiles unchanged), and drops `bh-curated`'s Gaia credit when only Sgr A\* is in the sky tile.
- At 375 px the credits ran to ~11 lines and pushed the bottom dock over the HUD: under 600 px they are capped at three
  lines and scroll.
- The Fornax duplicate (above).

Left rough:
- The source provenance (`credit`, `licence_name`) is read once when the server starts, so a rebuilt manifest's credit
  needs a restart; the records themselves reload by mtime.
- In-cone SMBHs are drawn with the enlarged lensing look (Phase 2's rule), so from the Sun M31\* and M32\* sit as two
  rings on M31's centre. It is honest (the card gives the enlargement) but dominates the view.
- Group members placed at one CF4 group distance form a thin sheet in front of M87 when seen from close by.
- The glow of a large elliptical close up shows faint 8-bit banding; spiral arms and bars are subtle at a distance.
- The HUD speed can show a tiny value mid-trip ("0.0000000068 AU/s") for a frame or two after a switch.
- `smbhVisible` counts an SMBH whose galaxy is behind the camera as visible (harmless on screen).
- These checks drove frames by hand in a background tab (no real-time rAF), so timings and smoothness by eye still
  need a pass on a real display.

## 19. Phase 4: fixes and data quality (design)

Status: **design, awaiting approval** (open questions in §19.13). Sections of §1–§18 that Phase 4 changes will carry a
"Phase 4 change" note pointing here when it is implemented. Where this section and an earlier one disagree, this one
wins.

Phase 4 is the first of the four follow-up phases recorded in §18.16: fixes and data (this section), then time and
behaviour (5), the "Turn back the sky" migration (6), and lensing and real images (7). Nothing of Phases 5–7 is in
scope here.

Every external fact below was checked live on **2026-11-20**:
- VizieR through the CfA mirror (`vizier.cfa.harvard.edu`), with IDIA (`vizier.idia.ac.za`) answering the same
  metadata; CDS (`vizier.cds.unistra.fr`) served a "Page unavailable" page, and the VizieR licence page
  (`cds.unistra.fr/vizier-org/licences_vizier.html`) answered 404 again, as in earlier phases;
- arXiv full texts (Shen et al. 2025, Reiprich & Böhringer 2002, Fadda et al. 1996) and the arXiv API for journal
  references;
- ESA's Gaia licence page ("Gaia data are distributed under the CC BY-NC 3.0 IGO license");
- NASA SVS item 4851 (the Deep Star Maps behind the Milky Way glow) and its credit line;
- EDD's terms page did **not** answer (connection failed); the terms quoted in §18.2 (version 2026-10-29, read
  2026-11-19) stand, and nothing here changes how CF4 is used.

Research numbers below come from scripts run on the committed snapshots plus the live tables; the build reports give
the final ones.

### 19.1 Decisions at a glance

| Question | Decision |
|---|---|
| `EVIDENCE_HIDES_FEATURES` | **`true`.** In the Evidence view Jupiter and Saturn lose their bands, Saturn its ring, Earth and Venus their atmosphere halo. Discs keep their shading and display colour (§19.3.1). |
| README `online` marker | Never implemented (§13, §16.16, §17.15). **Implement it**: a registered `online` marker, skipped unless `--online` (or `SPHEREX_ONLINE=1`), plus a few live smoke tests of the upstreams the builds pin. The README also gets the right frontend test command (§19.3.2). Q6. |
| M31\*/M32\* rings from the Sun | An SMBH's lensing look is capped to a twentieth of its galaxy's drawn semi-major axis (the look's outer radius to a fifth); below 1.5 px it is drawn as a marker only. The card still gives the enlargement, now of what is drawn (§19.3.3). |
| The Virgo sheet | Records placed at a group or cluster distance get an **illustrative line-of-sight spread** within their group's radius in the normal view, and sit at the exact group distance in the Evidence view; the card says so (§19.3.4). Q4. |
| Elliptical banding | Dither the additive glow shaders by ±½ of an 8-bit step (§19.3.5). |
| HUD speed blip | Reproduce it on scripted trips, fix the cause; acceptance in §19.3.6. |
| Credits read at start | A static source's provenance reloads with its manifest's mtime, like its records (§19.3.7). |
| `smbhVisible` behind the camera | A parent galaxy's item counts only when it is in front of the camera (or `inside`) (§19.3.8). |
| Smoothness | Foreground-tab, real-time rAF frame times before and after, on a real display (§19.12). |
| "You came from here" | Two markers in `cosmos` (and in the galaxy frame beyond 20 kpc): **the Sun** and **the Milky Way's centre**, labelled, merged into one label when closer than 30 px (§19.3.9). |
| Licensing, repository-wide | Every card whose record carries Gaia, CF4/EDD or OpenNGC values ends in a `Data` row derived from the record; the credits line adds the Milky Way glow (NASA SVS, from Gaia DR2); the 2D Space Maps page and the analysis page show the Gaia credit and licence; the README states the non-commercial stance and points to `LICENSE` (§19.8). |
| HII distances | **Shen et al. 2025** (A&A 696, A67; VizieR `J/A+A/696/A67`): Gaia DR3 (Bailer-Jones) distances of the exciting stars of 459 HII regions; 55 of its 459 rows take a literature value (33 Méndez-Delgado et al. 2022, 22 maser parallaxes). Evaluated against Méndez-Delgado et al. 2022 and the Villafranca catalogue (§19.4.1). Adopted through the §18.4.2 ladder; Russeil moves to "not used". Research run: **76 Russeil distances replaced** (median change −14 %, median \|change\| 23 %; 45 by more than 20 %, 13 by more than 50 %) and **70 direction-only nebulae placed**. Q1, Q2. |
| CF4 group distances | A galaxy whose only distances are CF4 Tully–Fisher or fundamental plane gets its CF4 group's distance as a candidate (`group-member`, `derived`), widened by the group's projected radius; **the group wins when its fractional error is smaller** (the ladder). Research run: **1,655 galaxies** move, median \|change\| 12 % (§19.5). Q3. |
| Four more clusters | Centaurus, Abell 1367, Hercules and Hydra join `clusters.json`: radii from Reiprich & Böhringer 2002 (Table 4, r200), dispersions from Fadda et al. 1996 (Tables 2, 4, 5) (§19.6). |
| Tile encoding | **`space-maps.object-tiles/2`**: a manifest `quantity_table` of `[src, tier, unit]` and Quantities stored as `[v, q]` or `[v, q, lo, hi]`. Lossless, with object-form fallback. Readers accept /1 and /2. `galaxies` goes from **12.47 MB to about 7.0 MB** (tiles 11.57 → 5.82 MB; gzipped tiles 1.21 → 1.05 MB). Applied to all six datasets, since it is one flag on `write_dataset` (§19.7). Q5. |

### 19.2 Sources, pins and licences (checked 2026-11-20)

| Input | Where | Pin | Licence and credit |
|---|---|---|---|
| `shen2025-table2.tsv.gz` | `backend/data/sources/nebulae/` | VizieR `J/A+A/696/A67/table2`, "HII regions with parallax distances based on Gaia DR3", **459 rows**, one per region (`Remarks`: 407 blank, 30 `M22`, 19 `maser`, 3 `maser,M22`). sha256 of the stripped TSV, as in Phases 1–3. | VizieR terms with the citation "Shen, Hou, Liu & Gao 2025, A&A 696, A67 (arXiv:2503.01551), doi:10.1051/0004-6361/202452712". The Gaia-derived rows are CC BY-NC 3.0 IGO, "Credit: ESA/Gaia/DPAC" (§19.8). |
| `shen2025-tablea1.tsv.gz` | same | `J/A+A/696/A67/tablea1`, "Information of exciting stars", **1,382 rows** (Gaia DR3 ids, parallaxes and Bailer-Jones distances per star). Not used for values; the build reads it only to name the exciting stars on the card and in the report. | as above |
| `shen_overrides.json` | same | hand-written: `[{nebula, wise \| null, reason}]`, seeded empty; the report lists every pair so reviewers extend the table, not the code (as §17.3). | — |
| `cf4-table2.tsv.gz` | `backend/data/sources/galaxies/` | **Re-snapshot** of `J/ApJ/944/94/table2` with the column `1PGC` ("PGC ID, dominant galaxy in the group") added to the Phase 3 columns. New sha256 in the script and `SOURCE.json`. 55,877 rows as before. | as §18.2 |
| `cf4-groups.tsv.gz` | same | **Re-snapshot** of `J/ApJ/944/94/groups` with `RAJ2000`, `DEJ2000` added (the group position). 38,053 rows as before. | as §18.2 |
| `clusters.json` | same | four entries added (§19.6), every number with `src`/`where`. | — |

`--refresh` follows the Phase 2/3 mirrors (CfA, IDIA, CDS). Build reports, `SOURCE.json`, `--local` and byte-identical
`--check` are unchanged in kind.

### 19.3 Fixes

#### 19.3.1 `EVIDENCE_HIDES_FEATURES = true`

Bands, atmospheres and rings are drawn from no data: the registry tags them `illustrative` (§3, `FEATURE_TIER`). The
Evidence view hides every other illustrative appearance (galaxy and nebula glows, the lensing look, the Milky Way
billboard), so the planets are the one exception left. With the constant on, `sphereOf(o, { evidence: true })`
returns `features: { ring: 0, band: 0, atm: 0 }`:

| Body | Normal view | Evidence view today | Evidence view after |
|---|---|---|---|
| Jupiter | bands | bands | plain shaded disc |
| Saturn | bands, ring (quad 2.4×) | bands, ring clipped by the 1.1× quad | plain shaded disc |
| Earth, Venus | atmosphere halo | halo | plain shaded disc |
| Others | plain | plain | unchanged |

The disc's display colour (`PLANET_RGB`) stays: a disc must be drawn in some colour, and markers keep theirs too. The
§3 sentence "Today the ring is clipped by the quad extent while bands and atmosphere still show" becomes history, and
the Phase 0 registry test that pins `false` is changed.

#### 19.3.2 The `online` pytest marker

The README has said since 2026-11-15 that "live-network integration tests marked `online` are skipped by default"; no
such marker exists and every test is offline. Implemented as:
- `pyproject.toml`: `markers = ["online: needs the network; run with --online"]`;
- `backend/tests/conftest.py` (new): an `--online` option; without it (and without `SPHEREX_ONLINE=1`) every `online`
  test is skipped with that reason;
- `backend/tests/test_online.py` (new), each test with a 60 s budget and a clear failure message naming the host:
  1. every VizieR table a build pins returns its pinned row count from at least one mirror (Phases 1–4, read from the
     scripts' pin tables, not a copy);
  2. Sesame resolves "M31" through at least one of the three hosts of §17.17;
  3. SkyBoT answers a small cone at a fixed epoch;
  4. the pinned OpenNGC commit's two raw files hash to the pins.
- README "Running Tests": `uv run pytest` (offline), `uv run pytest --online` (live), and the frontend command
  `node --test frontend/tests/*.test.mjs` (the listed three files are out of date).

#### 19.3.3 Enlarged SMBH rings on their galaxies

From the Sun, M31\* and M32\* are in the M31 cone, so Phase 2's rule draws them with the enlarged lensing look: a
9 px shadow in a 36 px quad on a galaxy whose drawn semi-major axis is about 20 px. `lensingItems` gains the
billboard items of the frame (`{ items }`) and, for a supermassive black hole whose parent galaxy has an item that is
**not** `inside` (the camera is outside that galaxy):
- `capPx = 0.05 × parent.semiMajorPx`, and `px = min(max(truePx, LENS_MIN_PX), capPx)`, so the whole look (radius
  `4·px`) stays within a fifth of the galaxy's drawn radius;
- when `px < LENS_FLOOR_PX = 1.5`, no lensing item is made; the black hole is a marker (the in-cone rule still makes
  it pickable);
- `factor` becomes `px / truePx` of what is drawn (or `null` when only a marker is drawn), and the card says
  "Drawn enlarged ×N" or "Too small to draw against M31 from here: shown as a marker; its shadow would be 1e-7 px".

Seen from the Sun M31\* and M32\* become two markers; the look appears once M31 is about 180 px in semi-major axis
(`9 / 0.05`), well before "Go there" arrives at 3 radii. Sgr A\* near the Sun is unchanged: the camera is inside the
Milky Way, so its parent item is `inside` and no cap applies. Stellar-mass black holes have no galaxy parent and are
unchanged.

#### 19.3.4 The sheet of group members

178 galaxies sit at one of four CF4 cluster distances, and §19.5 adds about 1,655 at group distances. Seen from
inside or beside a cluster, each group is a flat sheet facing the Sun, which reads as structure that is not there.
The data cannot say where along the line of sight a member is; the record's interval already includes the group's
depth. So:
- each record placed at a group distance carries **`props.group_radius`** (Mpc, `inferred` for the computed ones of
  §19.5, `catalogue` for the cited cluster radii of §18.4.6 and §19.6), with its `src`;
- the renderer places such a record at `D + δ` along its direction, with `δ = group_radius × t`, `t` from
  `hashUnit(id, 'los')` mapped to a triangular distribution on (−1, 1), so members crowd the centre the way a
  cluster does;
- **in the Evidence view `δ = 0`**: the drawn point is the catalogue group distance, nothing else;
- the card's distance row is unchanged (the group distance with its interval) and a note says "Drawn at an
  illustrative depth within its group (±1.3 Mpc), because its own distance along the line of sight is unknown; the
  Evidence view draws it at the group's distance". "From you" uses the drawn position.

The offset is inside the stated interval, so the placement claims nothing the record does not. Records with UNGC's own
`mem` distances have no `group_radius` and are not spread.

#### 19.3.5 Banding in elliptical glows

The galaxy and nebula fragment shaders add `(h(gl_FragCoord.xy) − 0.5) / 255` to the colour they write, with `h` a
cheap interleaved-gradient hash, before the additive blend into the 8-bit target. One line per shader, no new pass.
Checked on a large elliptical (M87 at 3 radii, NGC 4472) with and without.

#### 19.3.6 The HUD speed blip

§18.19 saw "0.0000000068 AU/s" for a frame or two mid-trip. `_trackSpeed` smooths the world-pc speed with a 0.1 s time
constant, so a reading that small means the camera held still for about 3 s, or a frame read a stale world position.
The fix starts from a reproduction: a scripted trip harness (node, using the pure `Autopilot`, `stepFrame` and
`worldPc`) over Sun → M87, Sun → TRAPPIST-1 e and LMC → SMC, recording `speedPc` per frame. Acceptance: on those trips
the HUD never shows a moving speed below 1e-6 of the trip's peak, except at rest or in the turn phase, where it reads
"turning". If the cause is in `scene3d.js` and not in a pure module, the harness becomes a browser check.

#### 19.3.7 Credits reload by mtime

`_static_source` copies the manifest provenance into `Source.provenance` once at start-up; records already reload by
mtime. The source keeps a reference to one dict, and `fetch` refreshes it in place (`clear()` + `update()`) whenever
`load_dataset` returns a new manifest. `build_objects` reads `source.provenance` after the fetch, so the same response
carries the new credit. A dataset that appears or disappears still needs a restart (stated in `technical-reference.md`).

#### 19.3.8 `smbhVisible` and the camera's back

The parent galaxy's item counts only when `it.inside`, or when its centre projects in front of the camera
(`it.screen` set and the centre's view-space depth positive). Today an item behind the camera can still report a large
`semiMajorPx`. Harmless on screen (nothing behind is drawn), but it made the SMBH count and picks wrong.

#### 19.3.9 "You came from here"

`homeMarkers(cam, { project, galaxyFade, store })`, pure, in `scene3d-objects.js`:
- **the Sun** at the galaxy-frame origin, label "Sun · you started here", picking opens the Sun's card;
- **the Milky Way's centre** at `gal:milky_way`'s placed position (Sgr A\*'s, §18.7), label "Milky Way centre ·
  Sgr A\*", picking opens the Milky Way card;
- shown in `cosmos`, and in the galaxy frame with alpha `1 − galaxyFade` (so they appear between 20 and 40 kpc, as the
  stars fade);
- closer than 30 px on screen, the two merge into one marker, "Milky Way · the Sun is here"; from Virgo the Sun and the
  Galactic Centre are 8.3 kpc apart at 16.8 Mpc, about 0.4 px;
- label priority ahead of galaxies; kept in the Evidence view (both placements are measured: the Sun by definition,
  the centre from GRAVITY 2022 via Sgr A\*).

### 19.4 HII-region distances from Gaia

#### 19.4.1 Candidates evaluated (2026-11-20)

| | **Shen et al. 2025** (adopted) | Méndez-Delgado et al. 2022 | Villafranca II (Maíz Apellániz et al. 2022) |
|---|---|---|---|
| Paper | A&A 696, A67, arXiv:2503.01551, "Parallax-based Distances to Galactic HII Regions: Nearby Spiral Structure" | MNRAS 510, 4436, arXiv:2112.12600 | A&A 657, A131, arXiv:2110.01464 |
| Content | 459 HII regions (WISE catalogue ids, Anderson et al. 2014) with Gaia DR3 distances of their O–B2 exciting stars; 55 rows carry a literature value (`Remarks`); per-region distance with asymmetric errors (kpc, 2 decimals), a robustness `Group`, and a `tablea1` of 1,382 exciting-star rows with Gaia DR3 ids. | 42 HII regions, Gaia EDR3 parallaxes of ionising stars. | 26 OB groups (16 + 10) with Gaia EDR3 distances. |
| VizieR | `J/A+A/696/A67` (`table2`, `tablea1`) | no table found | `J/A+A/657/A131` exists, but its metadata did not return today |
| Overlap with our 697 nebulae (research run) | **146 nebulae** under the rule of §19.4.2 | its distances are already in Shen's table (`Remarks: M22`, 33 rows) | a few groups; no table to pin |
| Verdict | adopted | superseded by Shen, which reuses it | rejected: small, not pinnable today |

**How Shen et al. derive a distance** (§3.2 of the paper): "If an H ii region has at least two associated stars, we
calculated the mean value of stellar distances, which is taken as the H ii region distance." The stellar distances are
Bailer-Jones et al. 2021's geometric or photogeometric posteriors (the `tablea1` note: `rgeo` when marked, else the
photogeometric median), which include "a zero-point offset for the parallaxes" (Shen §2). Groups: "(1) Group I: the H
ii region has more than one associated star and all the stars present consistent distances. Therefore, the estimated
distances of these 160 H ii regions in Group I ought to be reliable. (2) Group II: the H ii region originally has two
or more associated stars, but only one is left after the above criteria. (3) Group III: the H ii region has only one
associated star." The `Remarks` column marks rows whose distance is not their own Gaia value: "maser = the distance is
determined from the associated HMSFR maser", "M22 = the distance was given by Méndez-Delgado et al., 2022, based on
Gaia DR3" (VizieR notes).

#### 19.4.2 Linking a Shen region to a nebula record

- **Eligible records:** the types Russeil applies to (§17.4): Sharpless-only regions and merged records of types HII,
  EmN, Neb and Cl+N. Never SNR, PN, RfN or DrkN. Records with `major ≥ 120′` are excluded (40 in the research run:
  Barnard's Loop, the Cygnus region and similar complexes that hold many WISE regions at different distances).
- **Candidates:** Shen regions W whose centre lies within `s ≤ max(r_N, R_W)`, with `r_N` half the record's major axis
  and `R_W` Shen's (WISE) radius.
- **Best:** the lowest `s / max(r_N, R_W)`; one Shen region may serve several records (the Rosette's NGC 2237, 2238,
  2239 and 2246 all take G206.316−02.103), since it gives a distance, not an identity.
- **Overrides** (`shen_overrides.json`) win over the rule; `wise: null` forbids a link.
- **Report:** every link with its score, the other candidates and their distances, the old and new distance, and a list
  of the changes beyond 50 %, for review.

#### 19.4.3 The Shen distance as a candidate

| Shen row | `method` | `dist.tier` | Evidence | Licence |
|---|---|---|---|---|
| Group I, Gaia (blank or `M22` remark) | `bailer-jones` | `measured` | measured | Gaia (CC BY-NC 3.0 IGO) |
| Group II or III, Gaia | `bailer-jones` | `inferred` | derived | Gaia |
| `maser` remark (22 rows) | `parallax` | `measured` | measured | VizieR terms (not Gaia) |

(Q2 for the Group rule, Q1 for the maser rows.) `Dist − e_Dist` and `Dist + E_Dist` (kpc → pc) give `lo`/`hi`; where
the table prints an error of 0.00 kpc (Orion), the Quantity carries no interval and its `src` says "uncertainty below
the table's 0.01 kpc precision". The src names the region and the group: "Shen et al. 2025, A&A 696, A67, table2:
G209.037−19.377 (Group I), maser parallax of the associated HMSFR (as adopted there)" or "… G005.987−01.191
(Group I): mean Gaia DR3 (Bailer-Jones et al. 2021) distance of its exciting stars".

**Choosing** uses the §18.4.2 ladder unchanged: evidence class (a measured Shen distance beats Russeil's derived one),
then "has an uncertainty", then the smaller fractional uncertainty (a Group II/III Shen distance and Russeil's are both
derived; the more precise wins), then catalogue order (Shen, then Russeil). The loser goes to `alt_distances` with its
reason, and the nebula card gains the "Other distances · not used" rows the galaxy card already has. A PN parallax
(Chornay & Walton) still wins over both, and the types never overlap.

**Expected** (research run, with the maser rows):

| Nebula | Today (Russeil) | Shen region | After |
|---|---|---|---|
| Orion Nebula (M42) | 400 (360–440) pc, derived | G209.037−19.377, Group I, maser | **390 pc**, measured (`parallax`) |
| Lagoon Nebula (M8) | 1,600 pc, derived | G005.987−01.191, Group I, M22 | **1,220 ± 20 pc**, measured |
| Rosette Nebula (NGC 2237) | 1,900 pc, derived | G206.316−02.103, Group I | **1,360 −20/+40 pc**, measured |
| Trifid Nebula (M20) | 2,700 pc | G007.015−00.271, Group I, M22 | 1,240 −30/+40 pc |
| Eagle Nebula (NGC 6611) | 2,000 pc | G016.993+00.873, Group I, M22 | 1,720 ± 10 pc |
| Sh2-289 | 8,500 pc | G218.808−04.558, Group III | 450 ± 40 pc, derived (listed for review) |

Counts: 146 nebulae take a Shen distance (Group I 76, II 10, III 60); 76 of them replace a Russeil distance, 70 were
direction-only. Of the 76: median change −14 %, median |change| 23 %, 45 change by more than 20 % and 13 by more than
50 %. Without the maser rows (Q1), Orion would take the 360 pc Group III region G208.367−19.124 next door, which is
why the maser rows are recommended.

**Licence** (as §18.18 item 1): the Gaia-derived Shen values are CC BY-NC 3.0 IGO inside the CC BY-SA `nebulae`
files. Both nebula `LICENSE.md` files say which values that covers; the manifest `credit` becomes "… ; PN distances
(Chornay & Walton 2021, Gaia EDR3) and HII-region distances (Shen et al. 2025, Gaia DR3): Credit: ESA/Gaia/DPAC";
`LICENSE` item 2 and "Before any commercial use" name them (a commercial build drops the Gaia rows, leaving Russeil's
or no distance). The maser rows are not Gaia values.

### 19.5 Group-averaged CF4 distances

**Who:** a galaxy whose distance candidates are only CF4 `DMtf` and/or `DMfp` (and the Hubble flow), with a CF4 group
(`1PGC` from table2) of `Ngal ≥ 2` in the groups table. Galaxies with any measured distance, SN Ia, SN II, UNGC or
McConnachie candidate are never touched.

**The candidate:** `method: group-member`, tier `inferred`, evidence `derived`; `D` from the group's `DMzp ± e_DMzp`
("Group, weighted average distance modulus, TRGB, cepheid and maser calibrators") with the §18.4.1 conversion, using
the group's `V3k` for the `1/(1+z)` step; the interval widened in quadrature by the group radius:
- for the eight rich clusters (§18.4.6, §19.6), the cited radius;
- otherwise **`group_radius` = the rms angular distance of the group's CF4 members from the group position (groups
  table `RAJ2000`, `DEJ2000`), times `D`**, `inferred`, src "rms projected distance of the N Cosmicflows-4 members from
  the group centre, at the group distance (Space Maps)". For a pair it is half the separation.

**When it wins:** the §18.4.2 ladder. Both are derived and have uncertainties, so the smaller fractional uncertainty
wins: the group when `√((0.4605·e_DMzp)² + (group_radius/D)²) < σ_own/D`. The galaxy's own TF/FP distance goes to
`alt_distances` ("not used: larger uncertainty than its group's distance"). The card note: "Placed at the distance of
its group (Cosmicflows-4 group 1PGC 36487, 121 galaxies), whose average is more precise than its own Tully–Fisher
distance."

**Expected** (research run): of the TF/FP-only OpenNGC galaxies, 1,655 are in CF4 groups with `Ngal ≥ 2` (406 pairs,
366 of 3–4, 302 of 5–9, 581 of 10 or more) and the group wins for every one of them, even with the widening (median own
fractional error 20 %, median group error 8 %). Median change +1.9 %, median |change| 12 %; 422 change by more than
20 % and 42 by more than 50 %. 1,476 TF/FP galaxies are alone in their CF4 "group" and keep their own distance.

**Knock-on:** NGC 4889 has only an FP distance and is in Coma (group 44715), so it and NGC 4889\* move to the Coma group
distance; `build_objects_smbh.py` is rebuilt and its rescale factor changes (still `inferred`, `derived`). The galaxy
manifest's report counts every move by group size and lists the >50 % ones.

### 19.6 Cited radii for Centaurus, Abell 1367, Hercules and Hydra

Radii from **Reiprich & Böhringer 2002** (ApJ 567, 716, astro-ph/0111285; HIFLUGCS), Table 4 column (8), r200 "the
radius within which the mean gravitational mass density ⟨ρtot⟩ = 200 ρc" (§4), in h50⁻¹ Mpc with "H0 = 50 h50
km s⁻¹ Mpc⁻¹, h50 = 1, Ωm = 1" (§1). Velocity dispersions from **Fadda et al. 1996** (ApJ 473, 670,
astro-ph/9606098). CF4 groups from the committed groups snapshot.

| Cluster | Centre | CF4 group (1PGC, Ngal, DMzp) | σ (km/s) | r200 (h50⁻¹ Mpc) | Radius on the sky |
|---|---|---|---|---|---|
| Hydra (A1060) | NGC 3311 | 31478, 67, 33.673 ± 0.046 | 610 +52/−43 (Table 2) | 1.95 +0.08/−0.08 | 1.667° |
| Abell 1367 | NGC 3842 | 36487, 121, 34.796 ± 0.036 | 798 +75/−68 (Table 4, multipeaked, whole cluster) | 2.14 +0.08/−0.07 | 0.983° |
| Centaurus (A3526) | NGC 4696 | 43296, 49, 33.027 ± 0.048 | 447 +56/−36 (Table 5, the A3526a peak = Cen 30) | 1.87 +0.04/−0.03 | 1.766° |
| Hercules (A2151) | NGC 6041 | 56962, 278, 36.004 ± 0.028 | 751 +91/−69 (Table 2) | 1.61 +0.03/−0.04 (`A2151w`) | 0.444° |

- **Radius on the sky** is r200 over the angular-diameter distance of the cluster's Table 3 redshift in the paper's own
  cosmology (z = 0.0114, 0.0216, 0.0103, 0.0369): `D_A = (2c/H0)(1 − 1/√(1+z))/(1+z)` with H0 = 50, Ωm = 1, which
  does not depend on H0. The `where` says "Space Maps arithmetic", as for Fornax and Perseus.
- **`radius_mpc`** (the line-of-sight term) is r200 × 50/74.6 (r200 ∝ h⁻¹, moved to the CF4 scale): 1.31, 1.43, 1.25
  and 1.08 Mpc.
- **Centaurus is two groups in CF4**: Cen 30 (NGC 4696, group 43296) and Cen 45 (NGC 4709, group 43423, Vh 4058). The
  CF4 group used is Cen 30's, so its σ is the Cen 30 peak's (Fadda Table 5, A3526a), not the whole bimodal cluster's
  791. Cen 45 galaxies inside 1.766° and within 3σ of Cen 30's Vh = 3602 km/s would join it; the report lists them.
- **Hercules:** HIFLUGCS's `A2151w` is centred at (241.1465°, 17.7252°), on NGC 6041 (OpenNGC `GPair`, PGC 56962,
  whose CF4 group has 278 galaxies).
- The rule of §18.4.6 is unchanged; existing clusters are byte-identical. The research run counted 13 Hubble-flow
  candidates near Centaurus, 13 near Abell 1367 and Hercules each and 6 near Hydra; the build report gives the members.

### 19.7 Compact tile encoding (`space-maps.object-tiles/2`)

**What makes `galaxies` large** (2026-11-20 snapshot): of 11.57 MB of tiles, `props` is 4.63 MB, `size` 2.98 MB and
`position` 2.20 MB, almost all of it the keys of Quantity objects: `{"src":4291,"tier":"catalogue","unit":"mag","v":14.1}`
is 52 bytes for one number.

**Format /2** (only additive to /1):
- manifest `format: "space-maps.object-tiles/2"` and a **`quantity_table`**: a list of `[src, tier, unit]`, where `src`
  is an index into `src_table` (or the string itself when the dataset has no `src_table`) and `unit` is a string or
  `null` for "no unit";
- a **compact Quantity** is a JSON array: `[v, q]` or `[v, q, lo, hi]`, `q` an index into `quantity_table`;
- a Quantity is compacted only when its keys are a subset of `v, lo, hi, unit, src, tier`, `lo` and `hi` are both
  present or both absent, and `unit` is absent or a string. Anything else (nea's 288 one-sided limits, any extra key)
  stays an object, so the encoding is lossless by construction;
- where: `position.dist`, `position.elements.*`, `alt_distances[].dist`, `size.radius`, `size.angular.*`, `props.*`;
- tiles carry `format: "space-maps.object-tiles/2"`; records are otherwise unchanged (sorted keys, id order).

**Readers.** `_read_tile` and `verify_dataset` expand arrays back to objects (keys in sorted order, the integers and
floats exactly as stored) before `record_defaults`, the `src_table` and validation, so records in memory and in
`/api/objects` are identical to /1's. `load_dataset` accepts /1 and /2; an unknown format is a `DatasetError`. Readers
of /1 are migrated in the same change: `objects_static.py`, `frontend/dev/mock_server.py` (which expands tiles
itself), `build_objects_smbh.py` (reads the galaxy tiles through `load_dataset`) and the tests that read tile JSON
directly. Nothing in the browser reads tiles.

**Writer.** `write_dataset(..., compact=True)` writes /2; the default stays /1, so the Phase 0 fixture keeps exercising
the /1 path. All six build scripts pass `compact=True`: the same code, one argument each.

**Migration proof.** A test loads every dataset from the last /1 commit (`git show`) and from the /2 rebuild and asserts
equal record lists, and equal `/api/objects` JSON for the seven regression cones.

**Sizes** (prototype on the committed data; the build reports print the real ones):

| Dataset | Manifest | Tiles before → after | Tiles gzipped before → after |
|---|---|---|---|
| `galaxies` | 0.90 MB (+ 0.27 MB `quantity_table`) | 11.57 → 5.82 MB | 1.21 → 1.05 MB |
| `nea-exoplanets` | 0.14 MB (+ 0.27 MB) | 11.50 → 7.37 MB | 1.64 → 1.48 MB |
| `hr23-clusters` | 0.03 MB | 9.00 → 5.29 MB | 1.34 → 1.24 MB |
| `nebulae` | 0.05 MB | 0.45 → 0.31 MB | 0.097 → 0.088 MB |
| `bh-curated`, `smbh-curated` | 0.02 MB each | 0.019 → 0.013, 0.008 → 0.006 MB | small |

`galaxies` lands at about **7.0 MB** (12.47 before). §19.5 and §19.6 add a few hundred `group_radius` and alternative
distances; the build's size cap drops from 13 MB to 8 MB. The served JSON (and its gzip) is unchanged.

### 19.8 Licensing, applied repository-wide (§18.18 item 1)

**Where users see the values, and what each place shows:**

| Place | Gaia | CF4/EDD | OpenNGC | Change |
|---|---|---|---|---|
| 3D credits line | star layer, `nea`, `bh-curated`, `hr23`, nebula PN/HII distances | `galaxies`, `smbh-curated` | `nebulae`, `galaxies`, `smbh-curated` | adds the Milky Way glow: "Milky Way glow: NASA/GSFC Scientific Visualization Studio · Gaia DR2: ESA/Gaia/DPAC" (SVS's own credit line), while the `mw` layer is on and the glow visible |
| 3D cards | star cards (Gaia row) | galaxy cards | nebula and galaxy cards | **one `dataRow(o)`** in the registry, built from `o.provenance.dataset` and the `src` of the values the card shows, appended by every card: cluster ("Hunt & Reffert 2024, from Gaia DR3 · Credit: ESA/Gaia/DPAC"), exoplanet (NASA Exoplanet Archive; the host's Gaia row stays on the host card), nebula (adds the Gaia credit when its distance is Chornay & Walton's or a Gaia Shen row), SMBH ("Placed at its galaxy: OpenNGC (CC BY-SA 4.0); Cosmicflows-4 (EDD terms)"), stellar black hole (its companion's paper; Gaia when a Gaia value is shown) |
| 2D Space Maps page (`index.html`) | the fitted sources' Gaia DR3 priors and the hover card's "Catalogue: Gaia DR3" | — | — | a small credits footer: "Gaia DR3 · Credit: ESA/Gaia/DPAC · CC BY-NC 3.0 IGO" with a link to `LICENSE` |
| Analysis page | Gaia DR3 overlay | — | — | the footer's "Gaia DR3 (ESA)" becomes "Gaia DR3 (Credit: ESA/Gaia/DPAC, CC BY-NC 3.0 IGO)" |
| "Turn back the sky" | — (XHIP, d3-celestial) | — | — | none |

A registry test walks every kind's card over the example fixtures and asserts a `Data` row naming each credit whose
values the card shows.

**README:** a "Data and licences" section above "License": the code is MIT; Gaia values are CC BY-NC 3.0 IGO, CF4
values follow EDD's research-and-education terms, OpenNGC-derived files are CC BY-SA 4.0; Space Maps is run as a
non-commercial, educational project; see `LICENSE` for exactly which files, and its "Before any commercial use" list.

**`LICENSE`:** item 2 adds the Shen HII distances and the Milky Way glow image (`frontend/data/milkyway.webp`, NASA SVS
from Gaia DR2); "Before any commercial use" adds both.

### 19.9 Evidence and tiers of every new field

| Field | Tier | Record evidence |
|---|---|---|
| Shen distance, Group I (Gaia or M22) | `measured` | `measured` |
| Shen distance, Group II or III | `inferred` | `derived` |
| Shen distance, maser row | `measured` | `measured` |
| Russeil distance when not used | `inferred` (in `alt_distances`) | — |
| CF4 group distance (`group-member`) | `inferred` | `derived` |
| `props.group_radius`, computed | `inferred` | — |
| `props.group_radius`, cited cluster radius | `catalogue` | — |
| the line-of-sight spread `δ` | illustrative; zero in the Evidence view; a card note | unchanged |
| the four clusters' σ and radii | `catalogue` (in `clusters.json`, with `src`/`where`) | — |
| home markers | — (the Sun by definition; the centre from Sgr A\*'s `measured` record) | shown in the Evidence view |
| the capped lensing look | illustrative | unchanged |
| planet bands, atmospheres, rings | illustrative | hidden in the Evidence view |

### 19.10 Test plan

**Backend** (`uv run pytest`, offline):
- `test_objects_static.py`: /2 round trip (every Quantity shape: with and without interval, string `v`, int and float,
  no unit, one-sided interval stays an object, an extra key stays an object); a /1 dataset still loads; an unknown
  format fails; `verify_dataset` on /2; the `quantity_table` index out of range fails; `compact=False` output is
  byte-identical to today's; the provenance of a static source changes after its manifest changes (mtime), in the same
  response.
- `test_objects_migration.py` (new): every dataset, /1 (`git show` of the last /1 commit) against /2: equal records and
  equal `/api/objects` JSON for the seven regression cones.
- `test_build_nebulae.py`: Shen parsing (kpc → pc, asymmetric errors, 0.00 errors → no interval, `Remarks`, `Group`);
  the link rule (eligible types, the 120′ guard, score, one region serving the four Rosette records, overrides);
  evidence per group and remark; the ladder against Russeil (class, then fractional error) with Russeil in
  `alt_distances`; the expected table of §19.4.3 (Orion 390 pc measured `parallax`, M8 1,220 pc, the Rosette 1,360 pc);
  the Crab and PNe unchanged; the licence text and `credit`; the report's counts; `--check`.
- `test_build_galaxies.py`: the `1PGC` join; `group_radius` (rms, pairs, the cited radii for the eight clusters); the
  candidate only for TF/FP-only galaxies; the win condition both ways; measured or SN Ia galaxies untouched; the four new
  clusters (σ, radius, membership on synthetic rows and counts on the snapshot); the size budget (≤ 8 MB); `--check`.
- `test_build_smbh.py`: NGC 4889\* follows its host's new distance; the rescale factor; `--check`.
- `test_online.py` (marked `online`, skipped here); `conftest.py`: skipped without `--online`, run with it.
- `test_objects_api.py`: `--check` on all six datasets; the Orion and M8 cones return the new distances; a Coma cone
  returns NGC 4889 at the group distance.

**Frontend** (`node --test frontend/tests/*.test.mjs`):
- `scene3d-registry.test.mjs`: `EVIDENCE_HIDES_FEATURES` true and the sphere features per planet in both views;
  `dataRow` for every kind over the fixtures; the nebula card's "not used" rows and Shen notes; the group-member note
  with the depth sentence; the SMBH card's "too small to draw" text.
- `scene3d-objects.test.mjs`: `lensingItems` cap (M31\* from the Sun: marker only; at 200 px semi-major: drawn, factor
  of the drawn size; Sgr A\* inside the Milky Way: uncapped); `smbhVisible` with the parent behind the camera;
  the line-of-sight spread (deterministic, within ±`group_radius`, zero in the Evidence view, no spread without
  `group_radius`); `homeMarkers` (cosmos, the galaxy-frame fade, the 30 px merge, the Evidence view).
- `scene3d-speed.test.mjs` (new): the scripted trips of §19.3.6.

### 19.11 Work split

`scene3d.js` has one owner: slice R.

| Slice | Model | Files (exclusive) | Depends on |
|---|---|---|---|
| A. Tile format /2, provenance reload | Sonnet | `objects.py` (format constants), `objects_static.py`, `frontend/dev/mock_server.py` (tile expansion), the one `compact=True` argument in all six build scripts, all six `frontend/data/objects/*/` rebuilds, `test_objects_static.py`, `test_objects_migration.py` (new), tests that read tile JSON | this section |
| O. `online` marker | Sonnet, in parallel with A | `pyproject.toml` (markers), `backend/tests/conftest.py`, `backend/tests/test_online.py` | — |
| N. HII distances | Sonnet, after A | `build_objects_nebulae.py`, `backend/data/sources/nebulae/**`, `frontend/data/objects/nebulae/**`, `test_build_nebulae.py`, nebula fixtures | A |
| G. Group distances, four clusters, SMBH rebuild | Sonnet, after A, in parallel with N | `build_objects_galaxies.py`, `backend/data/sources/galaxies/**` (I write the four `clusters.json` entries), `frontend/data/objects/galaxies/**`, `build_objects_smbh.py`, `frontend/data/objects/smbh-curated/**`, `test_build_galaxies.py`, `test_build_smbh.py`, galaxy fixtures | A |
| F. Frontend pure modules | Sonnet, in parallel with A, N, G | `scene3d-registry.js`, `scene3d-objects.js`, `scene3d-nav.js` (if the speed fix lands there), their tests, `scene3d-speed.test.mjs` | this section |
| R. Renderer and pages | Sonnet, after F | `scene3d.js`, `scene3d-shaders.js`, `scene3d-main.js`, `scene3d-card.js`, `scene3d.html`, `scene3d.css`, `index.html`, `analysis.html` and their CSS | F; N's and G's data for the checks |
| D. Docs, licences, integration, review | me | this doc, `docs/technical-reference.md`, `README.md`, `LICENSE`, `test_objects_api.py` | all |

Haiku runs both suites and `--check` on all six datasets after each slice.

Commits: (1) this design; (2) tile format /2 and the six rebuilds; (3) the `online` marker; (4) HII distances;
(5) group distances, the four clusters and the SMBH rebuild; (6) frontend pure modules; (7) renderer and pages;
(8) docs, README and `LICENSE`.

### 19.12 Browser checks

On a fresh backend (or `--reload`), the real app in a foreground tab with real-time rAF; frame times before (the
current `main`) and after, on the same patches:
- **M31 rings from the Sun** (10.6847, 41.2690): two markers on M31, no rings; flying in, the look appears at about
  180 px semi-major; the M31\* card's text.
- **Virgo up close** (M87, then 2 Mpc out sideways): group members spread in depth, not a sheet; the Evidence view
  shows the sheet at the group distance; a member's card note.
- **An elliptical glow close up** (M87 at 3 radii): no visible banding.
- **The frame switch HUD** (Sun → M87, Sun → TRAPPIST-1 e): no tiny speed values mid-trip.
- **The Sun marker in `cosmos`**: from Virgo one "Milky Way · the Sun is here" marker; at 100 kpc the two markers and
  labels; picking each.
- **The Evidence view on Jupiter and Saturn**: plain discs, no ring.
- **Orion (83.82, −5.39) and M8 (270.9, −24.38)**: the new distances, measured, with Russeil as not used; the Data row
  with the Gaia credit (M8).
- **One Centaurus-cluster galaxy**: at the Cen 30 group distance with the cited radius, derived, with the note.
- **Regression:** TRAPPIST-1, the Pleiades, Orion, the Galactic Centre, M31, M87 (including the flight into
  `cosmos`), the LMC across the 60/40 kpc boundary; the Evidence view at each; the credits line at 375, 768 and 1280
  px, and the 2D page's and analysis page's credits.

### 19.13 Open questions

1. **Shen's maser rows.** 22 of Shen's 459 rows take their distance from a VLBI maser parallax "as adopted there", not
   from Gaia. *Recommendation:* use them (`parallax`, `measured`, not Gaia-licensed), because they are the
   catalogue's own adopted value and the better measurement; without them Orion would take a single-star region next
   door at 360 pc. The alternative is Gaia rows only, with Orion staying at Russeil's 400 pc.
2. **Evidence of a Shen distance.** *Recommendation:* Group I (several exciting stars with consistent distances, "ought
   to be reliable") `measured`; Groups II and III (one star carries the placement) `derived`, which also lets the
   ladder compare them with Russeil on precision. Alternatives: all `measured` (as the PN central stars), or all
   `derived`.
3. **The CF4 group rule.** *Recommendation:* as §19.5: TF/FP-only galaxies, groups of `Ngal ≥ 2`, interval widened by
   the rms projected member radius, the group wins on fractional error (1,655 galaxies). Alternatives: `Ngal ≥ 5`
   (about 880), or no widening (understates the error).
4. **The sheet fix.** *Recommendation:* the illustrative line-of-sight spread within `group_radius` in the normal view,
   exact group distance in the Evidence view, a card note (§19.3.4). The alternative is to keep the sheet and add only
   the note, which leaves 1,800 records drawn as flat planes.
5. **Encoding scope.** *Recommendation:* `compact=True` on all six datasets (one argument each; about 15 MB saved in
   the repository; the migration test covers each). The alternative is `galaxies` only.
6. **The `online` marker.** *Recommendation:* implement it with the four live smoke tests of §19.3.2, which catch an
   upstream changing a pinned table. The alternative is to delete the README sentence.
