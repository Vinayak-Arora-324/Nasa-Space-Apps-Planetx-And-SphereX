// Object store and pure per-frame helpers for the 3D fly-through (docs/object-framework.md sections 7.2, 7.4 and 9).
// No DOM, no WebGL: the renderer passes plain inputs (a camera, a projector, a context) and draws what comes back.
//
// TERMS
//   cam      a scene3d-frames camera { frame, host, pos, ... }; host.key is the star id of the system frame the camera is in.
//   project  (rel) -> [x, y] | null   the renderer's _proj: CSS px of a camera-relative vector, null when off screen.
//   ctx      { layers: {id: bool}, evidence: bool, frame: 'system'|'galaxy', inHost(hostId) -> bool, pxPerRad }
//   entry    one drawn record: { o, spec, renderer, id, kind, host, sysAu, galPc, dir, atInfinity? }  (o is the payload record)
//   sel      { kind, id } for objects, { kind: 'group', id: 'group:' + hostId } for a group marker.
//
// ObjectStore (new ObjectStore({ hostPc(hostId) -> [x, y, z] pc | null })   hostPc is optional, for hosts other than ss:sun)
//   setHostResolver({ key(hostId) -> starKey | null, pc(starKey) -> [x, y, z] pc | null } | null)
//       The renderer's map from an archive host id (gdr3:..., hip:..., neahost:..., or a same_as alias) to the key the star
//       renderer uses. Re-places every non-Sun hosted record. Records and entries then carry host = the resolved key (the raw
//       id when the resolver returns null). The resolver survives later ingest() calls. Sun-hosted records are unaffected.
//   resolveHost(hostId) -> starKey | hostId   (ss:sun is itself)
//   childrenOf(starKey) -> record[]   records whose resolved parent is that star, whatever the layers and evidence (existence is measured)
//   stars: Map id -> record   the 'star' records of the payload (never drawn by the store; the renderer appends the ones it lacks)
//   starRecord(starKey) -> record | null   the star record for a resolved key (its id, or an alias that resolves to it)
//   hostName(starKey) -> string   the star record's name, else the record named by that id, else the key
//   ingest(payload) -> { ok: true, unknownKinds } | { ok: false, error }
//       Replaces the contents. A schema major other than SCHEMA_MAJOR gives ok: false and leaves the store empty.
//       Records of unregistered kinds are counted in unknownKinds; records without id, kind or position, duplicate ids and
//       builtin kinds other than 'star' are skipped (store.skipped counts them). 'star' records go to store.stars.
//   byId: Map id -> record (the payload object);  byKind: Map kind -> record[];  recs: placed records (see below)
//   get(id) -> record | null;  placement(id) -> { sysAu, galPc, dir, orbit } | null   (orbit: the orbitPlacement result, or null)
//   earth: the 'ss:earth' record or null;  hasSolar: boolean (earth present)
//   query: the payload's query;  kindStatus: the payload's `kinds` map ({kind: {status, source, count, truncated, error?}})
//   counts() -> { kind: n } for the stored records
//   errorNotes() -> [{ kinds: [kind...], error }]   kinds with status 'error', grouped by message, in registry order
//   hostPc(hostId) -> [x, y, z] | null   'ss:sun' is the origin; others come from the host resolver (key, then pc), else opts.hostPc
//   Placement per record (computed once per ingest):
//     sysAu  xyz_au relative to its host (state positions), else null
//     galPc  galaxy-frame position in pc, in doubles. Host ss:sun: (xyz_au - earth.xyz_au) / AU_PER_PC, the sky as seen
//            from Earth (section 9; with no earth record it is just xyz_au / AU_PER_PC). Another host: hostPc + xyz / AU_PER_PC
//            when the host resolver or opts.hostPc knows it, else null. fixed positions: radecToXyz(ra, dec, distPc); no distance: null
//            orbit positions (exoplanets): sysAu = orbitPlacement(o, query.mjd).xyzAu (query.mjd missing: J2000, MJD 51544.5),
//            galPc = hostPc + sysAu / AU_PER_PC; null while the host is unresolved or has no distance
//     orbit  the orbitPlacement result (assumed flags, used values, phase source and sigma) for orbit positions, else null
//     dir    unit vector to a direction-only (fixed, dist null) record, else null
//
// kindsPhrase(kinds) -> 'Dwarf planets, asteroids and comets'   the registry nouns joined for a note
// Helpers (pure; entries come from visibleObjects):
//   visibleObjects(store, ctx) -> entry[]
//       Registered, not builtin, has a renderer for ctx.frame (rendererOf: a spec may choose per record), its layer is not off
//       (a layer missing from ctx.layers counts as on), spec.visible(o, { evidence, layers }) passes, system frame: ctx.inHost(host) and sysAu known; galaxy frame: galPc known, 'cone'
//       scope needs in_cone === true, and ss:earth is never drawn (it is the observer).
//       PHASE 2: in the galaxy frame a record with a `dir` and no galPc (direction-only: fixed, dist null) whose renderer is 'billboard' or
//       'marker' is also visible, with entry.atInfinity = true (section 17.5). Never in a system frame (the system test needs sysAu).
//   framePos(entry, cam) -> [x, y, z] | null   camera-relative, in the camera's frame units, computed in doubles. For atInfinity:
//       dir * INF_PC * unitsPerPc(cam), the same for every camera position
//   fromYouFor(entry, rel, fmt) -> string | null   fmt(rel), but null for a direction-only entry (it has no distance: no 'From you' row,
//       no crosshair distance)
//   visibleCounts(visible) -> { counts: {kind: n}, direct: {kind: n direction only} }   for the HUD ("12 nebulae (8 direction only)")
//   groupState(store, visible, cam, pxPerRad, GROUP_PX = 8) -> { [hostKey]: { grouped, count, byKind, pcPos, name, kind, noun, label } }
//       Galaxy frame only ({} otherwise). grouped: the host's visible records span maxR_AU / dist_AU * pxPerRad < GROUP_PX
//       (and there are at least two of them for ss:sun, at least one for any other host). pcPos: where the group marker goes
//       (the host, in pc). name: 'Solar system' for ss:sun, else the star record's name, else the host's record name or id.
//       kind / noun: the one kind all the group's records share and its [singular, plural] noun, else null.
//       label: 'Solar system · 14' for the Sun and mixed groups, 'TRAPPIST-1 · 7 exoplanets' for a one-kind non-Sun group.
//   groupTarget(sel, sunId = 'ss:sun') -> sel   a group sel of a non-Sun host becomes { kind: 'star', id: hostKey } (the renderer
//       selects the host star, whose card lists the planets); the Sun's group and every other sel come back unchanged
//   billboardItems(visible, cam, { evidence, pxPerRad, project?, nearPc? }) -> item[]   pure data for the billboard renderer (section 16.10).
//       Galaxy frame only ([] otherwise); entries whose renderer is 'billboard'. item = { id, kind, rel, dist, radiusUnits, rgb,
//       alpha, fade, nearFade, lineAlpha, mode, pxRadius, markerOnly, hollow, dashed, candidate, screen? }
//         nearFade     smoothstep(ENTER_PC, 4 ENTER_PC, nearPc): 0 where the camera is about to enter a star's system frame (nearPc =
//                      distance to the nearest star, default Infinity = 1), so a cluster's glow and marker never pop when the
//                      frame switch stops drawing clusters. alpha includes it
//         lineAlpha    the Evidence ring's alpha: (0.5 for candidates, else 1) * nearFade (no member-count dimming and NO close fade:
//                      the ring stays at any distance where the cluster is drawn)
//         rel          camera-relative position in the camera's frame units (doubles; the renderer casts to float32)
//         dist, radiusUnits  its length and r50, both in frame units (r50 from size.radius, pc)
//         rgb          clusterRgb(o), illustrative colour from the age
//         alpha        base * fade * nearFade: base = clamp(GLOW_K * N / r50_pc^2, 0, 1), a distance-independent surface brightness
//                      (GLOW_K = 0.002: the Pleiades, N/r50^2 ~ 236, gives 0.47; a diffuse group at 0.7 gives 0.0014; 0.1 without a
//                      count), times 0.5 for candidates
//         fade         smoothstep(1.5, 4, dist / r50): the glow fades out as the camera nears the cluster (you see its stars, not a fog)
//         mode         'outline' (Evidence view: centre marker plus an r50 ring) | 'glow' (Plummer glow, illustrative look)
//         pxRadius     the projected r50 in px (atan(r50 / dist) * pxPerRad); markerOnly: pxRadius < 2 (no glow, marker only)
//         hollow       evidence 'derived' (hollow marker); dashed: hollow in outline mode; candidate: quality 'candidate'
//         screen       project(rel) when a projector is given
//       The renderer sets entry.markerOnly from the item so pickPriority uses the kind's marker priority (16) instead of 25.
//       PHASE 2: a spec with billboard: 'nebula' goes through nebulaItem (scene3d-nebula.js, documented there: the projected-ellipsoid
//       item { look, seed, semiMajorPx, semiMinorPx, angle, inside, markerAlpha, ... }); it needs `project` and skips the entry without it.
//       For nebulae `project` must return null only for points behind the camera (not for off-screen ones). Cluster items are unchanged.
//   nebulaItem, skyFade, infinityPickable, INF_PC, MW_FADE_PC, SKY_FADE_PC, SKY_PICK_MIN   re-exported from scene3d-nebula.js. skyFade(cam) =
//       1 / (1 + (dSun_pc / 800)^2); MW_FADE_PC (800) is the shared constant: scene3d.js imports it from here for the Milky Way glow
//   lensingItems(visible, cam, { evidence, pxPerRad, project, items }) -> item[]   section 17.9, see its comment at the end of the file (LENS_MIN_PX = 9)
//       (PHASE 2: an item's own markerAlpha, when present, replaces that alpha; 'lensing' entries get a marker too, the Evidence view's only look.)
//   markerPoints(visible, groups, cam, items = [], { groupPx = 8, groupRgb }) -> Float32Array   the dynamic-points data of the galaxy
//       frame: 8 floats per point (x y z size alpha r g b, camera-relative), one per ungrouped 'marker' entry, one per grouped host
//       and one per billboard item (the cluster centre marker, alpha 0.5 for candidates, times nearFade). A hollow marker
//       (spec.markerStyle(o) === 'hollow') is encoded as a NEGATIVE size, at least HOLLOW_MIN_PX (8): the point shader draws a ring of |size| px.
//   markerSize(px, hollow) -> signed size;  isHollowSize(size) -> bool   the encoding
//   pickObjects(visible, groups, px, py, maxPx, { project, framePos, reach }) -> { sel, priority, d } | null
//       framePos(entry) -> rel (the renderer closes over the camera; a pseudo-entry { galPc, host, group: true } stands for a
//       group marker), reach(entry) -> extra pick radius in px (a sphere's disc; may be omitted). Grouped hosts give one group
//       candidate (priority 10). Lowest priority wins, then nearest pixel (see choosePick). Priority is pickPriority(entry):
//       spec.pick.marker for marker entries (and billboard entries with entry.markerOnly) when the kind sets it (small bodies
//       and exoplanets 15, clusters 16, ahead of stars), else spec.pick.priority.
//   choosePick(cands) -> the winning candidate | null   cands: [{ sel, priority, d }]; merge the star candidate in here
//   labelCandidates(visible, groups, { project, framePos, discPx }) -> [{ x, y, key, text }]
//       discPx(entry) -> disc radius in px. Applies each kind's label rule. Labels of one pool (spec.label.group, else the
//       kind) are sorted by key and cut to label.max. A grouped host gives one label (group.label) with key 5.
//   planGo(target, { camFrame, camHostKey, sunId = 'ss:sun', resolveHost }) -> a plan
//       target: a record, a { kind, id, host } sel-like, or a group { kind: 'group', id: 'group:<host>' }.
//       resolveHost(hostId) -> starKey (store.resolveHost.bind(store)): maps a record's raw host to the key camHostKey uses;
//       hostId in the plan is the resolved key.
//       { type: 'star' } | { type: 'fly' } (host is the camera's system frame) | { type: 'solar-scene' } (host ss:sun, camera
//       not in it) | { type: 'via-host', hostId } (star trip to hostId, then fly) | { type: 'fly-galaxy' } (no host: clusters)
//       | { type: 'look', dir } (a direction-only target: rotate the camera to face dir, do not move; "Turn to it", section 17.5).
//       A target is direction-only when it is an entry with atInfinity and dir, or when opts.placement(id) (store.placement.bind(store))
//       gives a dir and no galPc or sysAu.
//   pickObjects / labelCandidates take an extra option skyFade (the value of skyFade(cam), default 1): direction-only entries are skipped
//       below SKY_PICK_MIN (0.25) and a direction-only label item carries alpha = skyFade.
//
// PHASE 3 (docs/object-framework.md section 18)
//   galaxyFade(cam) -> 0..1          1 - smoothstep(2e4, 4e4, dSun_pc) (scene3d-galaxy.js); galaxyItem, milkyWayItem, projectAxes re-exported
//   visibleObjects(store, ctx)       ctx.frame may be 'cosmos': only kinds with a cosmos renderer; a record with one is not held to the cone in the unhosted
//       frames (an SMBH from a sky tile; filter with smbhVisible). ctx.galaxyFade (number) or ctx.cam: in the galaxy frame every entry whose kind has no
//       cosmos renderer gets entry.galaxyFade, and the Milky Way billboard entry.mwFade = 1 - galaxyFade; presenceOf(entry) reads either (default 1)
//   billboardItems     every unhosted frame; dispatches on billboardKind(spec, o) ('cluster' | 'nebula' | 'galaxy' | 'milky_way'; spec.billboard may be a
//       function of the record); items of entries with galaxyFade have alpha, lineAlpha and markerAlpha multiplied by it (item.galaxyFade); direction-only
//       items use the kind's spec.skyFadePc
//   pickObjects / labelCandidates   skip entries with presenceOf < 0.25; label alpha = skyFade x presence; options skyFade (number, or a function
//       (entry) -> number, see skyFadeOf(cam)) and galaxyFade (number, for the group markers)
//   markerPoints       plain marker alpha = presenceOf(entry); group markers alpha = galaxyFade(cam).  lensingItems items carry alpha = presenceOf(entry)
//   smbhVisible(entry, items, { selectedId, inCone }) -> bool; withSmbh(visible, items, opts) -> entry[]   section 18.8.3
//   childrenOf(id)     also works for record ids: a galaxy lists its black holes (by parent)
//   planGo(target, { ..., get })  get(id) -> record (store.get): a placed galaxy gives { type: 'fly-galaxy', arrivePc: 3 x radius }, a direction-only galaxy
//       { type: 'look', dir }, the Milky Way { type: 'fly-point', pc, lookAtPc, normal, arrivePc: 0 } (pc: MW_GO_PC = 60 kpc from the centre along the
//       north Galactic pole; the flight ends in cosmos). The target may be an entry, a record or a { kind, id } sel with get
//   starCreditItem(hasGaia) -> item | null; creditItems / creditsLine(sources, counts, extra = [])   extra: client-side items appended after the datasets
//
// PHASE 4 (docs/object-framework.md section 19)
//   lensingItems(..., { items })   items: this frame's billboardItems. A supermassive black hole whose parent galaxy has an item that is not `inside` is capped to LENS_CAP
//       (0.05) of that item's semiMajorPx; below LENS_FLOOR_PX (1.5) it is a marker only: no item, but an entry of the result's `.markerOnly` array ({ id, markerOnly: true, truePx,
//       factor: null, capPx, parentId, parentName, rel, dist, screen? }). item.factor = px / truePx of what is drawn; item.capPx is null when uncapped.
//       RENDERER: this._lens = new Map([...lens, ...lens.markerOnly].map((it) => [it.id, it])) feeds the card's ctx.lensing (it reads enlarged, factor, truePx, markerOnly,
//       parentName); lensVisible(visible, lens, evidence) -> entries is what markerPoints should get in place of the filter on renderer !== 'lensing' (the marker-only black
//       holes keep their marker, everything else as before); the in-cone pick rule is unchanged.
//   store.setEvidence(on) -> bool; visibleObjects(store, ctx) calls it with ctx.evidence   the line-of-sight spread of group members (section 19.3.4): a galaxy with
//       position.method 'group-member' and props.group_radius is placed at D + losOffsetPc(o) in the normal view and exactly at D in the Evidence view, and a supermassive
//       black hole follows its parent galaxy's offset. entry.galPc, store.placement(id).galPc (and .losPc, the offset in force), framePos, picking, planGo, labels, fromYou and
//       markers all read the active position, so the renderer only has to call visibleObjects (or setEvidence) after toggling the Evidence view and rebuild what it caches.
//   losOffsetPc(o) -> pc (signed)   hashUnit(id, 'los') + hashUnit(id, 'los2') - 1 times min(group_radius, D - lo, hi - D); 0 without group_radius or when not a group member
//   smbhVisible(entry, items, { selectedId, inCone, forward })   a parent galaxy behind the camera (item.screen === null, or rel . forward <= 0 given `forward`) counts only
//       when the camera is inside it (item.dist <= item.radiusUnits)
//   homeMarkers(cam, { project, galaxyFade, store, evidence }) -> [{ id, sel, text, rel, screen, alpha, merged, rgb }]   section 19.3.9: the Sun ('ss:sun', sel { kind: 'sun' }) and
//       the Milky Way centre ('gal:milky_way', sel { kind: 'galaxy' }); alpha 1 in cosmos, 1 - galaxyFade in the galaxy frame (nothing at 0), never in a system frame; one merged
//       item 'Milky Way · the Sun is here' when they are under HOME_MERGE_PX (30) apart on screen. Labels and picks are the renderer's to draw.
//   card ctx.lensing  { enlarged, factor, truePx, markerOnly?, parentName? } (scene3d-registry.js documents the notes); ctx.parentName as before
//
// PHASE 5 (docs/object-framework.md section 20, decisions 20.17)
//   store.mjd                       the drawn date (TT MJD): query.mjd after ingest (J2000 without one), then whatever setTime was given
//   store.setTime(mjd, { hosts }) -> bool   re-draws every mover in place (rec.sysAu / rec.galPc keep their array identity; rec.orbit is updated): hosts is a Set or array of
//       host keys, the Sun always; other hosts keep their last state and are brought to the current date when they are passed. Earth is evaluated first; a Sun-hosted galPc is
//       (sysAu - drawn Earth) / AU_PER_PC, the Sun's own marker included. setTime(query.mjd) after ingest changes nothing. true when anything moved
//   store.mover(id) -> mover | null (scene3d-motion.js; .elements for a SkyBoT body, for oscPath and the card);  store.validity(id, mjd = store.mjd) -> moverValidity | { ok: true, reason: null }
//   store.motionItems(visible) -> [{ kind, model, illustrative, valid }]   feed for motionSummary (re-exported here); illustrative: record evidence illustrative or invalid, an assumed phase, or beyond its range
//   store.placement(id).greyed      the record is beyond its valid range (rec.greyed is moverOk, the allocation-free moverValidity(...).ok)
//   GREYED     visibleObjects: such an entry has entry.greyed = true in the normal view and is NOT in the list in the Evidence view (it still counts: groupState's `extra`,
//              visibleCounts). entry.motion = 'ephem' | 'kepler' | 'orbit' and entry.illustrative = true (record evidence illustrative or an assumed phase) mark a moving record.
//              markerPoints draws a greyed marker at GREY_ALPHA (0.35) of its alpha with greyRgb(colour) (the points are floats, so the style is in the data);
//              labelCandidates: a greyed entry's text ends ' (extrapolated)' (no glyph) and the item has greyed: true; a moving illustrative one (not greyed) ends ' ◌';
//              pickObjects: the candidate has greyed: true. Greyed means beyond the valid range and nothing else.
//   groupState(store, visible, cam, pxPerRad, GROUP_PX = 8, { layers, evidence }?)   section 20.8: built from EVERY layer-on record of the host (store.recs; opts.layers, else the
//       layers of the last visibleObjects call, else all on; opts.evidence, else store.evidence), whatever its evidence or validity; the spread is rec.orbitAu = a (1 + e) for an orbit
//       record, the drawn |r| for a state record. Each group also has { evidence, hollow, hidden, extra }: evidence is the host star record's (else measured: a Gaia or XHIP
//       star, the Sun); hollow when derived; hidden in the Evidence view when illustrative. markerPoints draws a grouped host solid or hollow and not at all when hidden;
//       labelCandidates and pickObjects skip a hidden group (its members stay undrawn). extra = { kind: n } the records the HUD must still count (see visibleCounts)
//   visibleCounts(visible, groups = null)   with the groups, adds each group's `extra` (a grouped system's records the Evidence view does not draw one by one, and greyed records
//       the Evidence view hides): "7 exoplanets, on their stars"; the renderer passes this._groups
//
// STAR CARDS (section 16.8)
//   mergeStarSystem(system, rec) -> system'   the star model's `system` input for a star that has an archive star record (rec) and
//       maybe a Gaia /api/system payload. Per row (teff_k, radius_rsun, lum_lsun, mass_msun, age_gyr, spectral_type) the value with
//       the strongest tier wins (measured > catalogue > inferred > illustrative); on a tie, or when only one side has the row,
//       Gaia's is kept / the present one is used. The winner keeps its own src. Notes that the archive value makes false
//       ('No effective temperature available...', 'FLAME mass / age not available...') are dropped. Without rec, system is returned as is.
//       A prefer_record star (section 17.8) is different: each parameter its replace list names (teff, radius, mass) is the record's,
//       whatever the tiers, and Gaia's single-star value moves to system'.notUsed { teff_k?, radius_rsun?, mass_msun? } (the card lists
//       it as 'Gaia single-star <param> · not used', the reason in the notes). Every row still Gaia's gets the note
//       '<Params>: Gaia single-star model; may be biased for this binary.' The star model (starModel) carries notUsed through, and the
//       renderer draws the star from that same model, so the picture and the card agree.
//
// CREDITS (section 17.2)
//   creditItems(sources, counts) -> [{ dataset, text, credit, licenceName, licence }]; creditsLine(sources, counts) -> 'credit · licence | ...'
//       sources: the /api/objects `sources` rows; counts: datasetCounts(store) ({dataset: n of records in the cone}) or omitted (each row's
//       own count). Only datasets with records and a provenance.credit are listed; the line is '' when there are none.
//   datasetCounts(store) -> { dataset: n }   records (and star records) with in_cone === true, by provenance.dataset
//
// TEXT HELPERS (section 16.11)
//   countPhrase(kinds, counts, kindStatus, direct = {}) -> string   '23 small bodies' | '2,000 brightest small bodies (more in this cone)' |
//       '2,000 exoplanets of the brightest hosts (more in this cone)'. kinds: kind names shown as one phrase (dwarf_planet,
//       asteroid and comet together read 'small bodies'); counts: {kind: n}; kindStatus: the payload's kinds map. '' when n = 0
//       and nothing is truncated. Numbers use en-US thousands separators. direct ({kind: n}, from visibleCounts) appends '(8 direction only)':
//       '12 nebulae (8 direction only)', '2,000 nebulae (more in this cone, 8 direction only)'.
//   capNotes(kindStatus) -> string[]   one sentence per capped kind group: 'Showing the 2,000 brightest small bodies in the
//       cone; fainter ones are left out.'
//   hostCountText(store, hostKey, { evidence, layers }) -> string   '7 exoplanets (positions illustrative)'; in the Evidence view
//       '7 exoplanets (positions illustrative, hidden in the Evidence view)'; with the layer off '(..., layer off)'; '' without
//       children. The caller adds the 'Near TRAPPIST-1 · ' prefix.
//
// HOST STARS (section 16.7; pure helpers for the renderer's _rebuildStars)
//   bpRpFromTeff(teffK) -> number   an illustrative BP-RP from Teff: the dwarf sequence of scene3d-physics.js read backwards (monotone,
//       linear between anchors, clamped to 2500-40000 K); the Sun's 0.82 when Teff is missing
//   objectStarParams(o) -> { ra, dec, d, abs, bp } | null   what the renderer needs to append a star record: its direction, its
//       distance in pc, an absolute magnitude (gmag, else vmag, else render.mag, combined with the distance; 10 when it has none) and
//       bp (bpRpFromTeff). null without a positive distance or a direction
//   starValuesFromRecord(o) -> { teff_k, radius_rsun, mass_msun, age_gyr, spectral_type, dist_pc, g_mag }   the star model's `values`
//       (starModel input), as Quantities that keep their own tier and src; only what the record has
//   resolveStarAliases(stars, has) -> { append: record[], alias: Map, prefer: Map }   stars: store.stars (id -> record); has(key) -> bool for the
//       keys the renderer loaded. A record any of whose ids (id, same_as) is loaded maps all its ids to that key; otherwise, when it
//       has a distance, it is appended and all its ids map to its own id. Records with neither stay unresolved.
//       prefer: loaded key -> the star record, for every loaded star whose record has a usable prefer_record (section 17.8): _rebuildStars
//       re-places those rows with preferredStarPlacement (appended records are already at the record's distance)
//   preferredStarDistance(rec) -> { pc, lo, hi, src, tier, notUsed: { plxMas, plxLo, plxHi, pc, pcLo, pcHi, reason } } | null   (registry; re-exported)
//       rec.prefer_record = { replace: ['dist', ...], reason }, distance in position.dist, Gaia single-star parallax in props.gaia_parallax (mas)
//   preferredStarPlacement(rec, { xyz, abs } | { dir, d, abs }) -> { pos: [x, y, z] pc, d, abs, gaiaPc } | null   a loaded Gaia row moved to the
//       curated distance: its direction and apparent G are kept, only the distance (and so the absolute magnitude) changes
//   (the star card rows for such a star: preferredDistanceRows(rec, { bjPc }) in scene3d-registry.js)
//   starSignature(stars) -> string   changes when the set of star ids (or their same_as) changes: when _rebuildStars must run again
import { kindSpec, kinds, SCHEMA_MAJOR, toPc, toKm, rendererOf, clusterRgb, layerOf, UNIT_KM, isAccreting, preferredStarDistance, preferredFields, isSupermassive, isMilkyWay, GAIA_CREDIT } from './scene3d-registry.js';
import * as F from './scene3d-frames.js';
import { radecToXyz, smoothstep, KM_PER_AU } from './scene3d-math.js';
import { orbitPlacement, J2000_MJD, hashUnit, phaseSigmaAt } from './scene3d-orbits.js';
import { compileMover, evalMover, moverValidity, motionSummary, WINDOW_DAYS, PHASE_SIGMA_MAX_DEG } from './scene3d-motion.js';
import { INF_PC, MW_FADE_PC, SKY_FADE_PC, SKY_PICK_MIN, skyFade, infinityPickable, relOfEntry, nebulaItem, projectAxes } from './scene3d-nebula.js';
import { galaxyItem, milkyWayItem, galaxyFade, galacticAxes } from './scene3d-galaxy.js';
export { motionSummary };
export { INF_PC, MW_FADE_PC, SKY_FADE_PC, SKY_PICK_MIN, skyFade, infinityPickable, nebulaItem, projectAxes, galaxyItem, milkyWayItem, galaxyFade, preferredStarDistance };

const { AU_PER_PC } = F;
const SUN = 'ss:sun', EARTH = 'ss:earth', MJD0 = 2400000.5, D2R = Math.PI / 180;
export const GREY_ALPHA = 0.35;   // a greyed (extrapolated) marker is drawn at this share of its alpha, desaturated (section 20.5, 20.17 item 2)
/** The desaturated colour of a greyed marker: 80 % of the way to its own luma. */
export const greyRgb = (c) => { const l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]; return [c[0] * 0.2 + l * 0.8, c[1] * 0.2 + l * 0.8, c[2] * 0.2 + l * 0.8]; };
const trueAnomaly = (E, e) => 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
/** moverValidity(m, mjd).ok without the allocation (the per-frame path); a test keeps the two equal. */
function moverOk(m, mjd) {
  if (m.model === 'kepler') return Math.abs(mjd + MJD0 - m.epochJd) <= WINDOW_DAYS;
  if (m.model === 'orbit') { if (m.plan.source === 'assumed') return true; const s = phaseSigmaAt(m.plan, mjd); return s === null || s <= PHASE_SIGMA_MAX_DEG; }
  return true;
}
const kindOrder = () => new Map(kinds().map((s, i) => [s.kind, i]));
const hasXyz = (p) => Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite);

/**
 * The illustrative line-of-sight offset (pc, signed) of a record placed at a group distance (section 19.3.4, 19.14 item 4): 0 unless position.method is
 * 'group-member' and props.group_radius is a Quantity (Mpc or any length unit). delta = b * (u1 + u2 - 1), u1 = hashUnit(id, 'los'), u2 = hashUnit(id, 'los2'): a
 * smooth bell on (-1, 1) with no edge, the same on every load. b = min(group_radius, D - lo, hi - D) in pc (a missing end of the interval does not bound it), so the
 * drawn point never leaves the record's own interval or the group radius.
 */
export function losOffsetPc(o) {
  const p = o && o.position, g = o && o.props && o.props.group_radius;
  if (!p || p.method !== 'group-member' || !p.dist) return 0;
  const R = toPc(g), D = toPc(p.dist);
  if (!(R > 0) || !(D > 0)) return 0;
  const k = toPc({ v: 1, unit: p.dist.unit }), lo = Number.isFinite(p.dist.lo) ? p.dist.lo * k : null, hi = Number.isFinite(p.dist.hi) ? p.dist.hi * k : null;
  let b = R;
  if (lo != null) b = Math.min(b, D - lo);
  if (hi != null) b = Math.min(b, hi - D);
  if (!(b > 0)) return 0;
  return b * (hashUnit(o.id, 'los') + hashUnit(o.id, 'los2') - 1);
}

export class ObjectStore {
  constructor(opts = {}) { this.opts = opts; this._evidence = false; this._clear(); }
  _clear() {
    this.byId = new Map(); this.byKind = new Map(); this.recs = []; this._place = new Map(); this.stars = new Map();
    this.earth = null; this.query = null; this.kindStatus = {}; this.skipped = 0; this._earthAu = [0, 0, 0]; this._idx = null;
    this.mjd = null; this._movers = []; this._sunRecs = []; this._earthRec = null; this._scr = [0, 0, 0]; this._layers = null;
  }
  get hasSolar() { return !!this.earth; }
  get(id) { return this.byId.get(id) || null; }
  placement(id) { const r = this._place.get(id); return r ? { sysAu: r.sysAu, galPc: r.galPc, dir: r.dir, orbit: r.orbit, losPc: r.galPcSpread && !this._evidence ? r.losPc : 0, greyed: r.greyed } : null; }
  /** The record's mover (scene3d-motion.js: model 'ephem' | 'kepler' | 'orbit', and .elements for a kepler one), or null when it does not move. */
  mover(id) { const r = this._place.get(id); return r ? r.mover : null; }
  /** moverValidity of the record at mjd (default: the drawn date); { ok: true, reason: null } for a record without a mover. */
  validity(id, mjd = this.mjd) { const r = this._place.get(id); return r && r.mover && Number.isFinite(mjd) ? moverValidity(r.mover, mjd) : { ok: true, reason: null }; }
  /** The items motionSummary wants, from visibleObjects entries: [{ kind, model, illustrative, valid }] for the entries that move. */
  motionItems(visible) {
    const out = [];
    for (const e of visible) {
      const r = this._place.get(e.id);
      if (!r || !r.mover) continue;
      out.push({ kind: r.kind, model: r.mover.model, illustrative: r.o.evidence === 'illustrative' || r.o.evidence === 'invalid' || !!r.mover.assumed || r.greyed, valid: !r.greyed });
    }
    return out;
  }
  /**
   * Draws every mover at mjd (TT MJD), in place: rec.sysAu and rec.galPc keep their array identity, rec.orbit is updated, rec.greyed follows the validity. Only records
   * whose host is in `hosts` (a Set or an array of host keys; the Sun always) are evaluated; the others keep their last state and are evaluated at the then-current date
   * the next time their host is passed. Earth is evaluated first and a Sun-hosted galPc is (sysAu - Earth's drawn sysAu) / AU_PER_PC (the Sun's own marker included).
   * setTime(query.mjd) after ingest changes nothing. Returns true when anything moved. store.mjd is the drawn date afterwards.
   */
  setTime(mjd, { hosts = null } = {}) {
    if (!Number.isFinite(mjd)) return false;
    const want = hosts instanceof Set ? hosts : Array.isArray(hosts) ? new Set(hosts) : null;
    let moved = false, earthMoved = false;
    const E = this._earthRec;
    if (E && E.mover && E.evalMjd !== mjd) { this._evalRec(E, mjd); earthMoved = moved = true; }
    for (const r of this._movers) {
      if (r === E || r.evalMjd === mjd) continue;
      if (r.host !== SUN && !(want && (want.has(r.host) || want.has(r.rawHost)))) continue;
      this._evalRec(r, mjd); moved = true;
    }
    if (earthMoved) for (const r of this._sunRecs) this._galSun(r);
    this.mjd = mjd;
    return moved;
  }
  _galSun(r) {
    const e = this._earthAu, s = r.sysAu; if (!s) return;
    const g = r.galPc || (r.galPc = [0, 0, 0]);
    g[0] = (s[0] - e[0]) / AU_PER_PC; g[1] = (s[1] - e[1]) / AU_PER_PC; g[2] = (s[2] - e[2]) / AU_PER_PC;
  }
  _evalRec(r, mjd) {
    const m = r.mover;
    if (m.model === 'orbit' && r.orbit) { this._updateOrbit(r, mjd); }
    else if (r.sysAu) { const S = evalMover(m, mjd, this._scr), a = r.sysAu; a[0] = S[0]; a[1] = S[1]; a[2] = S[2]; }
    if (r.sysAu) {
      if (r.host === SUN) this._galSun(r);
      else { const h = r.host ? this.hostPc(r.host) : null; if (h) { const g = r.galPc || (r.galPc = [0, 0, 0]); g[0] = h[0] + r.sysAu[0] / AU_PER_PC; g[1] = h[1] + r.sysAu[1] / AU_PER_PC; g[2] = h[2] + r.sysAu[2] / AU_PER_PC; } }
    }
    r.evalMjd = mjd; r.greyed = !moverOk(m, mjd);
  }
  _orbitFromMover(r, mjd) {   // the orbitPlacement-shaped object, built from the compiled plan
    const plan = r.mover.plan, xyz = evalMover(r.mover, mjd, [0, 0, 0]), E = plan.E, e = plan.e;
    r.orbit = { xyzAu: xyz, assumed: { ...plan.assumed }, phaseSource: plan.source, phaseSigmaDeg: phaseSigmaAt(plan, mjd),
      used: { ...plan.used, trueAnomaly: trueAnomaly(E, e) / D2R, r: plan.a * (1 - e * Math.cos(E)) } };
  }
  _updateOrbit(r, mjd) {
    const plan = r.mover.plan, o = r.orbit, S = evalMover(r.mover, mjd, o.xyzAu), E = plan.E, e = plan.e;
    r.sysAu[0] = S[0]; r.sysAu[1] = S[1]; r.sysAu[2] = S[2];
    o.phaseSigmaDeg = phaseSigmaAt(plan, mjd); o.used.trueAnomaly = trueAnomaly(E, e) / D2R; o.used.r = plan.a * (1 - e * Math.cos(E));
  }
  /**
   * The Evidence view flag of the placements (section 19.3.4): records placed at a group distance with props.group_radius (and the black holes of such a galaxy)
   * are drawn at D + losOffsetPc in the normal view and at the exact distance D when `on`. Re-points every spread record's galPc (cheap; a no-op when the flag
   * is unchanged). visibleObjects(store, ctx) calls it with ctx.evidence, so the renderer needs no call of its own; picking, planGo, labels, fromYou and markers
   * all read the placement, so they follow. Returns true when anything moved.
   */
  setEvidence(on) {
    on = !!on;
    if (on === this._evidence) return false;
    this._evidence = on;
    let moved = false;
    for (const r of this.recs) if (r.galPcSpread) { r.galPc = on ? r.galPcExact : r.galPcSpread; moved = true; }
    return moved;
  }
  get evidence() { return this._evidence; }
  resolveHost(hostId) {
    if (!hostId || hostId === SUN || !this._resolver) return hostId || null;
    return this._resolver.key(hostId) || hostId;
  }
  hostPc(hostId) {
    if (hostId === SUN) return [0, 0, 0];
    if (this._resolver) { const pc = this._resolver.pc(this._resolver.key(hostId) || hostId); if (hasXyz(pc)) return pc; }
    return this.opts.hostPc ? this.opts.hostPc(hostId) || null : null;
  }
  setHostResolver(resolver) {
    this._resolver = resolver && typeof resolver.key === 'function' && typeof resolver.pc === 'function' ? resolver : null;
    this._idx = null;
    for (const rec of this.recs) {
      if (!rec.rawHost || rec.rawHost === SUN) continue;
      rec.host = this.resolveHost(rec.rawHost); rec.parent = this.resolveHost(rec.o.parent || rec.rawHost);
      this._placeRecord(rec, this._earthAu);
    }
  }
  _index() {   // children by resolved parent and star records by resolved key, rebuilt after ingest and setHostResolver
    if (this._idx) return this._idx;
    const kids = new Map(), stars = new Map();
    const put = (k, o) => { if (!kids.has(k)) kids.set(k, []); kids.get(k).push(o); };
    for (const rec of this.recs) {
      if (rec.parent && rec.parent !== SUN) put(rec.parent, rec.o);
      const raw = rec.o.parent;   // a record id (a galaxy's black holes) is a parent too, whatever the host resolver says about it
      if (raw && raw !== SUN && raw !== rec.parent) put(raw, rec.o);
    }
    for (const s of this.stars.values()) { const k = this.resolveHost(s.id); if (!stars.has(k)) stars.set(k, s); }
    for (const s of this.stars.values()) for (const a of Array.isArray(s.same_as) ? s.same_as : []) { const k = this.resolveHost(a); if (!stars.has(k)) stars.set(k, s); }
    return (this._idx = { kids, stars });
  }
  childrenOf(id) { return (this._index().kids.get(id) || []).slice(); }   // a star key or a record id (a galaxy lists its black holes by parent)
  starRecord(starKey) { return this._index().stars.get(starKey) || this.stars.get(starKey) || null; }
  hostName(starKey) {
    const s = this.starRecord(starKey), r = this.get(starKey);
    return (s && s.name) || (r && r.name) || starKey;
  }

  ingest(payload) {
    this._clear();
    const m = payload && typeof payload.schema === 'string' ? /^space-maps\.objects\/(\d+)/.exec(payload.schema) : null;
    if (!m || Number(m[1]) !== SCHEMA_MAJOR) return { ok: false, error: 'Objects need a newer page; reload' };
    this.query = payload.query || null; this.kindStatus = payload.kinds || {};
    const payloadMjd = this.query && Number.isFinite(this.query.mjd) ? this.query.mjd : null;
    this.mjd = payloadMjd === null ? J2000_MJD : payloadMjd;
    let unknownKinds = 0;
    const accepted = [];
    for (const o of Array.isArray(payload.objects) ? payload.objects : []) {
      if (!o || typeof o.id !== 'string' || typeof o.kind !== 'string' || !o.position || typeof o.position !== 'object') { this.skipped++; continue; }
      const spec = kindSpec(o.kind);
      if (!spec) { unknownKinds++; continue; }
      if (spec.builtin && o.kind === 'star' && !this.stars.has(o.id)) { this.stars.set(o.id, o); continue; }
      if (spec.builtin || this.byId.has(o.id)) { this.skipped++; continue; }
      this.byId.set(o.id, o); accepted.push(o);
      if (!this.byKind.has(o.kind)) this.byKind.set(o.kind, []);
      this.byKind.get(o.kind).push(o);
    }
    this.earth = this.byId.get(EARTH) || null;
    const e = this._earthAu = this.earth && hasXyz(this.earth.position.xyz_au) ? this.earth.position.xyz_au : [0, 0, 0];
    for (const o of accepted) {
      const rec = { o, id: o.id, kind: o.kind, rawHost: o.host || null, host: this.resolveHost(o.host), parent: this.resolveHost(o.parent || o.host),
        spec: kindSpec(o.kind), sysAu: null, galPc: null, dir: null, orbit: null, mover: null, evalMjd: null, greyed: false, orbitAu: null };
      try { rec.mover = compileMover(o, { payloadMjd }); } catch (_) { rec.mover = null; }
      this._placeRecord(rec, e);
      if (rec.mover) {   // evaluated where ingest put it: the payload's epoch (a state record: the epoch its mover was anchored at)
        rec.evalMjd = rec.mover.model === 'orbit' ? this.mjd : rec.mover.payloadMjd;
        rec.greyed = !moverOk(rec.mover, rec.evalMjd);
        if (rec.mover.model === 'orbit') rec.orbitAu = rec.mover.plan.a * (1 + rec.mover.plan.e);
        this._movers.push(rec);
      }
      if (rec.host === SUN) this._sunRecs.push(rec);
      this.recs.push(rec); this._place.set(o.id, rec);
    }
    this._earthRec = this._place.get(EARTH) || null;
    if (this._earthRec && this._earthRec.sysAu) this._earthAu = this._earthRec.sysAu;   // moves in place with setTime
    this._spread();
    return { ok: true, unknownKinds };
  }
  _placeRecord(rec, earthAu) {
    const p = rec.o.position;
    if (p.model === 'state' && hasXyz(p.xyz_au)) {
      rec.sysAu = p.xyz_au.slice(0, 3);
      if (rec.host === SUN) rec.galPc = [(p.xyz_au[0] - earthAu[0]) / AU_PER_PC, (p.xyz_au[1] - earthAu[1]) / AU_PER_PC, (p.xyz_au[2] - earthAu[2]) / AU_PER_PC];
      else {
        const h = rec.host ? this.hostPc(rec.host) : null;
        if (h) rec.galPc = [h[0] + p.xyz_au[0] / AU_PER_PC, h[1] + p.xyz_au[1] / AU_PER_PC, h[2] + p.xyz_au[2] / AU_PER_PC]; else rec.galPc = null;
      }
    } else if (p.model === 'orbit') {
      if (rec.orbit === null) {
        if (rec.mover && rec.mover.model === 'orbit') this._orbitFromMover(rec, this.mjd);
        else rec.orbit = orbitPlacement(rec.o, this.mjd);
      }
      if (!rec.orbit) return;
      rec.sysAu = rec.sysAu || [0, 0, 0];
      rec.sysAu[0] = rec.orbit.xyzAu[0]; rec.sysAu[1] = rec.orbit.xyzAu[1]; rec.sysAu[2] = rec.orbit.xyzAu[2];
      const h = rec.host ? this.hostPc(rec.host) : null;
      if (h) { const g = rec.galPc || (rec.galPc = [0, 0, 0]); g[0] = h[0] + rec.sysAu[0] / AU_PER_PC; g[1] = h[1] + rec.sysAu[1] / AU_PER_PC; g[2] = h[2] + rec.sysAu[2] / AU_PER_PC; } else rec.galPc = null;
    } else if (p.model === 'fixed' && Number.isFinite(p.ra) && Number.isFinite(p.dec)) {
      const d = p.dist ? toPc(p.dist) : null;
      if (Number.isFinite(d)) rec.galPc = radecToXyz(p.ra, p.dec, d);
      else if (!p.dist) rec.dir = radecToXyz(p.ra, p.dec, 1);
    }
  }
  _spread() {   // section 19.3.4: the illustrative line-of-sight depth within a group; a supermassive black hole takes its galaxy's offset
    for (const rec of this.recs) {
      rec.galPcExact = rec.galPc; rec.galPcSpread = null; rec.losPc = 0;
      const p = rec.o.position;
      if (!rec.galPc || !p || p.model !== 'fixed') continue;
      const host = rec.kind === 'black_hole' && isSupermassive(rec.o) && rec.o.parent ? this.byId.get(rec.o.parent) : rec.o;
      const off = host ? losOffsetPc(host) : 0, d = toPc(p.dist);
      if (!off || !(d > 0)) continue;
      rec.losPc = off; rec.galPcSpread = radecToXyz(p.ra, p.dec, d + off);
      if (!this._evidence) rec.galPc = rec.galPcSpread;
    }
  }
  counts() {
    const out = {};
    for (const [k, list] of this.byKind) out[k] = list.length;
    return out;
  }
  errorNotes() {
    const order = kindOrder(), groups = new Map();
    for (const [kind, st] of Object.entries(this.kindStatus)) {
      if (!st || st.status !== 'error') continue;
      const msg = st.error || 'unknown error';
      if (!groups.has(msg)) groups.set(msg, []);
      groups.get(msg).push(kind);
    }
    const rank = (k) => (order.has(k) ? order.get(k) : 1e6);
    const notes = [...groups].map(([error, ks]) => ({ kinds: ks.sort((a, b) => rank(a) - rank(b)), error }));
    return notes.sort((a, b) => rank(a.kinds[0]) - rank(b.kinds[0]));
  }
}

/** 'Dwarf planets, asteroids and comets' from kind names, using the registry nouns. */
export function kindsPhrase(ks) {
  const words = ks.map((k) => { const s = kindSpec(k); return s ? s.noun[1] : `${k.replace(/_/g, ' ')}s`; });
  const text = words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const AT_INFINITY_RENDERERS = ['billboard', 'marker'];
/** The billboard item builder of a record: spec.billboard is a string or a function of the record ('cluster' | 'nebula' | 'galaxy' | 'milky_way'). */
export const billboardKind = (spec, o) => (typeof spec.billboard === 'function' ? spec.billboard(o) : spec.billboard) || 'cluster';
export const GALAXY_PICK_MIN = 0.25;   // below this a record that fades with galaxyFade is neither labelled nor picked
/** How present an entry is, 0..1: galaxyFade for records without a cosmos renderer, 1 - galaxyFade for the Milky Way billboard, else 1. */
export const presenceOf = (e) => (e.galaxyFade != null ? e.galaxyFade : e.mwFade != null ? e.mwFade : 1);

export function visibleObjects(store, ctx) {
  if (typeof store.setEvidence === 'function') store.setEvidence(!!ctx.evidence);   // the group-member line-of-sight spread is off in the Evidence view
  const out = [], layers = ctx.layers || {}, ev = { evidence: !!ctx.evidence, layers };
  store._layers = layers;   // groupState reads the layers the last visibleObjects call used when it is not given its own
  const gf = ctx.galaxyFade != null ? ctx.galaxyFade : ctx.cam ? galaxyFade(ctx.cam) : null, hostedFrame = F.isHosted(ctx.frame);
  for (const r of store.recs) {
    const spec = r.spec, renderer = rendererOf(spec, ctx.frame, r.o);
    if (!renderer) continue;
    if (spec.layer && layers[spec.layer] === false) continue;
    if (!spec.visible(r.o, ev)) continue;
    if (r.greyed && ev.evidence) continue;   // beyond its valid range: an extrapolation, illustrative, so not in the Evidence view (section 20.17 item 2)
    const hasCosmos = !hostedFrame && !!rendererOf(spec, 'cosmos', r.o);
    if (hostedFrame) {
      if (!r.sysAu || !ctx.inHost(r.host)) continue;
    } else {
      if (r.id === EARTH) continue;
      if (!r.galPc && !(r.dir && AT_INFINITY_RENDERERS.includes(renderer))) continue;   // a direction-only record is drawn at infinity (section 17.5)
      if (spec.galaxyScope === 'cone' && r.o.in_cone !== true && !hasCosmos) continue;   // a record with a cosmos renderer (an SMBH) comes from a sky tile: smbhVisible decides
    }
    const entry = { o: r.o, spec, renderer, id: r.id, kind: r.kind, host: r.host, sysAu: r.sysAu, galPc: r.galPc, dir: r.dir };
    if (r.greyed) entry.greyed = true;
    if (r.mover) { entry.motion = r.mover.model; if (r.o.evidence === 'illustrative' || r.mover.assumed) entry.illustrative = true; }
    if (!r.galPc && r.dir && !hostedFrame) entry.atInfinity = true;
    if (ctx.frame === 'galaxy' && gf != null) {   // section 18.5.4
      if (!hasCosmos) entry.galaxyFade = gf;
      else if (renderer === 'billboard' && billboardKind(spec, r.o) === 'milky_way') entry.mwFade = 1 - gf;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Supermassive black holes show only when resolved (section 18.8.3). entry: a visibleObjects entry; items: the billboardItems of the same frame;
 * opts { selectedId, inCone } (inCone: boolean, default entry.o.in_cone === true). Any other entry is true. An SMBH is shown when it is in the cone, is
 * selected, or its parent galaxy's item is `inside` or at least 40 px in semi-major axis AND in front of the camera (section 19.3.8: item.screen null means behind;
 * opts.forward, a unit vector, adds the test rel . forward > 0 for callers whose projector clips); for the Milky Way the camera must also be 40 kpc or more
 * from the Sun (the item's galaxyFade is 0), so Sgr A* near the Sun keeps its cone rule.
 */
export function smbhVisible(entry, items, { selectedId = null, inCone, forward = null } = {}) {
  if (!entry || entry.kind !== 'black_hole' || !isSupermassive(entry.o)) return true;
  if (selectedId != null && selectedId === entry.id) return true;
  if (inCone != null ? inCone : entry.o.in_cone === true) return true;
  const it = (items || []).find((i) => i.id === entry.o.parent);
  if (!it) return false;
  if (it.billboard === 'milky_way' && !(it.galaxyFade === 0)) return false;
  // Section 19.3.8: a galaxy behind the camera does not count. project() returns null only for points behind the camera, so an item with screen === null (or, given
  // opts.forward, a centre with rel . forward <= 0) is behind; it still counts when the camera is inside it (its distance within its semi-major axis).
  const behind = it.screen === null || (Array.isArray(forward) && Array.isArray(it.rel) && it.rel[0] * forward[0] + it.rel[1] * forward[1] + it.rel[2] * forward[2] <= 0);
  if (behind) return !!(it.inside && Number.isFinite(it.dist) && Number.isFinite(it.radiusUnits) && it.dist <= it.radiusUnits);
  return !!(it.inside || (it.semiMajorPx != null && it.semiMajorPx >= 40));
}
/** visible.filter(smbhVisible) with the items built from the same list: the renderer's one-liner. */
export const withSmbh = (visible, items, opts) => visible.filter((e) => smbhVisible(e, items, opts));

/** The star-credit item for the credits line (section 18.12): null unless the star payload holds Gaia rows. */
export const STAR_CREDIT_TEXT = `Stars: ${GAIA_CREDIT}`;
export const starCreditItem = (hasGaia) => (hasGaia ? { dataset: 'gaia-dr3', text: STAR_CREDIT_TEXT, credit: 'Credit: ESA/Gaia/DPAC', licenceName: 'CC BY-NC 3.0 IGO', licence: 'https://creativecommons.org/licenses/by-nc/3.0/igo/' } : null);

export function framePos(entry, cam) {
  if (entry.atInfinity) return relOfEntry(entry, cam);
  if (cam.frame === 'system') {
    if (!entry.sysAu) return null;
    return [entry.sysAu[0] - cam.pos[0], entry.sysAu[1] - cam.pos[1], entry.sysAu[2] - cam.pos[2]];
  }
  return relOfEntry(entry, cam);   // atInfinity: dir * INF_PC * unitsPerPc, the same for every camera position
}

/** The camera-relative text for the card's `fromYou`: null for a direction-only entry (it has no distance), else fmt(rel). */
export const fromYouFor = (entry, rel, fmt) => (!entry || entry.atInfinity || !rel ? null : fmt(rel));

/** Counts of the visible entries by kind: { counts: {kind: n}, direct: {kind: n of them direction only} } for the HUD (galaxy frame). */
export function visibleCounts(visible, groups = null) {
  const counts = {}, direct = {};
  for (const e of visible) { counts[e.kind] = (counts[e.kind] || 0) + 1; if (e.atInfinity) direct[e.kind] = (direct[e.kind] || 0) + 1; }
  // section 20.8: the records of a grouped system the Evidence view does not draw one by one still exist ("7 exoplanets, on their stars"), and a greyed record
  // hidden in the Evidence view is counted too (groupState's `extra`)
  if (groups) for (const g of Object.values(groups)) if (g.extra) for (const [k, n] of Object.entries(g.extra)) counts[k] = (counts[k] || 0) + n;
  return { counts, direct };
}

export function groupState(store, visible, cam, pxPerRad, GROUP_PX = 8, opts = {}) {
  if (cam.frame !== 'galaxy') return {};
  const layers = opts.layers || store._layers || {}, evidence = opts.evidence != null ? !!opts.evidence : !!store.evidence;
  const seen = new Set(visible.map((e) => e.id)), by = new Map();
  // section 20.8: a group is built from EVERY record of the host whose layer is on, whatever its evidence or validity (existence is measured)
  for (const r of store.recs) {
    if (!r.host || !r.sysAu || r.id === EARTH) continue;
    const spec = r.spec;
    if (!rendererOf(spec, 'galaxy', r.o) || (spec.layer && layers[spec.layer] === false)) continue;
    if (spec.galaxyScope === 'cone' && r.o.in_cone !== true && !rendererOf(spec, 'cosmos', r.o)) continue;
    if (!by.has(r.host)) by.set(r.host, []);
    by.get(r.host).push(r);
  }
  const out = {}, w = F.worldPc(cam);
  for (const [host, list] of by) {
    const pcPos = store.hostPc(host);
    if (!pcPos) continue;
    let maxR = 0; const byKind = {};
    // the spread is the ORBIT SIZE, a (1 + e), for an orbit record and the drawn |r| for a state record, so a system groups at the same distance whatever the date or phase
    for (const r of list) { maxR = Math.max(maxR, r.orbitAu != null ? r.orbitAu : Math.hypot(r.sysAu[0], r.sysAu[1], r.sysAu[2])); byKind[r.kind] = (byKind[r.kind] || 0) + 1; }
    const dist = Math.hypot(pcPos[0] - w[0], pcPos[1] - w[1], pcPos[2] - w[2]) * AU_PER_PC;
    const name = host === SUN ? 'Solar system' : store.hostName(host), kk = Object.keys(byKind);
    const kind = kk.length === 1 ? kk[0] : null, spec = kind && kindSpec(kind), noun = spec ? spec.noun : null;
    const label = host !== SUN && noun ? `${name} · ${list.length} ${noun[list.length === 1 ? 0 : 1]}` : `${name} · ${list.length}`;
    // the marker takes the host's evidence: its star record's, else measured (a Gaia or Hipparcos star, the Sun)
    const star = host === SUN ? null : store.starRecord(host), ev = (star && star.evidence) || 'measured';
    const grouped = list.length >= (host === SUN ? 2 : 1) && dist > 0 && (maxR / dist) * pxPerRad < GROUP_PX, hidden = evidence && ev === 'illustrative';
    let extra = null;
    if (!hidden) for (const r of list) {
      if (seen.has(r.id) || !(grouped || r.greyed)) continue;   // grouped: all of them are on the marker; resolved: only a greyed record the Evidence view hides
      if (!extra) extra = {};
      extra[r.kind] = (extra[r.kind] || 0) + 1;
    }
    out[host] = {
      grouped, count: list.length, byKind, pcPos: pcPos.slice(), name, kind: host === SUN ? null : kind, noun: host === SUN ? null : noun, label,
      evidence: ev, hollow: ev === 'derived', hidden, extra,
    };
  }
  return out;
}

/** A kind's pick priority for this entry: spec.pick.marker while drawn as a marker (when set), else spec.pick.priority. */
export const pickPriority = (e) => ((e.renderer === 'marker' || (e.renderer === 'billboard' && e.markerOnly)) && e.spec.pick.marker != null ? e.spec.pick.marker : e.spec.pick.priority);

/** The sel to act on for a picked sel: a non-Sun group selects its host star (whose card lists the planets). */
export function groupTarget(sel, sunId = SUN) {
  if (!sel || sel.kind !== 'group') return sel;
  const host = String(sel.id).replace(/^group:/, '');
  return host === sunId ? sel : { kind: 'star', id: host };
}
const isGrouped = (groups, e) => !!(e.host && groups[e.host] && groups[e.host].grouped);

/** The best candidate: the lowest priority number, then the smallest pixel distance. */
export function choosePick(cands) {
  let best = null;
  for (const c of cands) if (c && (!best || c.priority < best.priority || (c.priority === best.priority && c.d < best.d))) best = c;
  return best;
}

/** skyFade option: a number for every direction-only entry, or a function (entry) -> number (per-kind scales: skyFadeOf(cam)). */
const skyOf = (sky, e) => (typeof sky === 'function' ? sky(e) : sky);
/** (entry) -> skyFade(cam, the kind's spec.skyFadePc): the per-kind fade of a direction-only entry (nebulae 800 pc, galaxies 1e5). */
export const skyFadeOf = (cam) => (e) => skyFade(cam, (e && e.spec && e.spec.skyFadePc) || SKY_FADE_PC);

export function pickObjects(visible, groups, px, py, maxPx, { project, framePos: pos, reach = () => 0, skyFade: sky = 1, galaxyFade: gfade = 1 }) {
  const cands = [];
  for (const e of visible) {
    if (isGrouped(groups, e) || (e.atInfinity && !infinityPickable(skyOf(sky, e))) || presenceOf(e) < GALAXY_PICK_MIN) continue;
    const rel = pos(e), q = rel && project(rel); if (!q) continue;
    const d = Math.hypot(q[0] - px, q[1] - py);
    if (d <= Math.max(maxPx, reach(e) || 0)) { const c = { sel: { kind: e.kind, id: e.id }, priority: pickPriority(e), d }; if (e.greyed) c.greyed = true; cands.push(c); }
  }
  for (const [host, g] of Object.entries(groups)) {
    if (!g.grouped || g.hidden || gfade < GALAXY_PICK_MIN) continue;
    const rel = pos({ galPc: g.pcPos, host, group: true }), q = rel && project(rel); if (!q) continue;
    const d = Math.hypot(q[0] - px, q[1] - py);
    if (d <= maxPx) cands.push({ sel: { kind: 'group', id: 'group:' + host }, priority: 10, d });
  }
  return choosePick(cands);
}

export function labelCandidates(visible, groups, { project, framePos: pos, discPx = () => 0, skyFade: sky = 1, galaxyFade: gfade = 1 }) {
  const out = [], pools = new Map();
  for (const e of visible) {
    const L = e.spec.label; if (!L || isGrouped(groups, e) || (e.atInfinity && !infinityPickable(skyOf(sky, e))) || presenceOf(e) < GALAXY_PICK_MIN) continue;
    const rel = pos(e), q = rel && project(rel); if (!q) continue;
    if (L.hideOverDiscPx != null && discPx(e) > L.hideOverDiscPx) continue;
    // section 20.4.4, 20.5: a greyed record says so and carries no glyph; a moving record whose placement is illustrative ends in the illustrative glyph
    const item = { x: q[0], y: q[1], key: L.key(e.o), text: e.greyed ? `${e.o.name} (extrapolated)` : e.motion && e.illustrative ? `${e.o.name} ◌` : e.o.name };
    if (e.greyed) item.greyed = true;
    const alpha = (e.atInfinity ? skyOf(sky, e) : 1) * presenceOf(e);
    if (e.atInfinity || alpha < 1) item.alpha = alpha;
    if (L.max == null) { out.push(item); continue; }
    const pool = L.group || e.kind;
    if (!pools.has(pool)) pools.set(pool, { max: L.max, items: [] });
    pools.get(pool).items.push(item);
  }
  for (const { max, items } of pools.values()) out.push(...items.sort((a, b) => a.key - b.key).slice(0, max));
  for (const [host, g] of Object.entries(groups)) {
    if (!g.grouped || g.hidden || gfade < GALAXY_PICK_MIN) continue;
    const rel = pos({ galPc: g.pcPos, host, group: true }), q = rel && project(rel); if (!q) continue;
    const gl = { x: q[0], y: q[1], key: 5, text: g.label || `${g.name} · ${g.count}` };
    if (gfade < 1) gl.alpha = gfade;
    out.push(gl);
  }
  return out;
}

export const MW_GO_PC = 60000;   // "Go there" for the Milky Way: this far from its centre along the north Galactic pole
export function planGo(target, { camFrame, camHostKey, sunId = SUN, resolveHost, placement, get } = {}) {
  if (!target || target.kind === 'star') return { type: 'star' };
  const rec = target.o || (target.props || target.position ? target : get && target.id ? get(target.id) : null);   // the record, when the caller gave one
  if (target.kind !== 'group') {   // a direction-only target: turn to it (section 17.5)
    if (target.atInfinity && target.dir) return { type: 'look', dir: target.dir.slice() };
    const pl = placement && target.id ? placement(target.id) : null;
    if (pl && !pl.galPc && !pl.sysAu && pl.dir) return { type: 'look', dir: pl.dir.slice() };
    const rp = rec && rec.position;
    if (rec && rec.kind === 'galaxy' && rp && rp.model === 'fixed' && !rp.dist && Number.isFinite(rp.ra) && Number.isFinite(rp.dec)) return { type: 'look', dir: radecToXyz(rp.ra, rp.dec, 1) };
    if (rec && rec.kind === 'galaxy') {   // section 18.7 / 18.6.2: the Milky Way flies to a face-on point; any other galaxy stops 3 radii out
      const spec = kindSpec('galaxy');
      if (isMilkyWay(rec)) {
        const ax = galacticAxes(rec.props && rec.props.ngp_ra ? rec.props.ngp_ra.v : 192.85948, rec.props && rec.props.ngp_dec ? rec.props.ngp_dec.v : 27.12825,
          rec.props && rec.props.l_node ? rec.props.l_node.v : 32.93192);
        const d = toPc(rec.position.dist), c = radecToXyz(rec.position.ra, rec.position.dec, d);
        return { type: 'fly-point', pc: c.map((v, i) => v + MW_GO_PC * ax.n[i]), lookAtPc: c, normal: ax.n, arrivePc: 0 };
      }
      return { type: 'fly-galaxy', arrivePc: spec.arrivePc(rec) };
    }
  }
  const isGroup = target.kind === 'group', raw = isGroup ? (target.host || String(target.id).replace(/^group:/, '')) : target.host;
  const hostId = raw && resolveHost ? resolveHost(raw) || raw : raw;
  if (!hostId) return { type: 'fly-galaxy' };
  if (isGroup) return hostId === sunId ? { type: 'solar-scene' } : { type: 'via-host', hostId };
  if (camFrame === 'system' && camHostKey === hostId) return { type: 'fly' };
  return hostId === sunId ? { type: 'solar-scene' } : { type: 'via-host', hostId };
}

// ------------------------------------------------------------------ billboards (section 16.10)
const GLOW_MIN_PX = 2;
export const GLOW_K = 0.002, GLOW_UNKNOWN = 0.1, GLOW_NEAR = [1.5, 4];   // alpha = clamp(GLOW_K N / r50_pc^2); the glow fades out between 1.5 and 4 r50 from the centre
export function billboardItems(visible, cam, { evidence = false, pxPerRad = 1000, project = null, nearPc = Infinity } = {}) {
  if (F.isHosted(cam.frame)) return [];
  const out = [], upc = F.unitsPerPc(cam), nearFade = smoothstep(F.ENTER_PC, 4 * F.ENTER_PC, nearPc), gf = galaxyFade(cam);
  const faded = (it, e) => {   // records without a cosmos renderer fade with galaxyFade in the galaxy frame (section 18.5.4)
    if (e.galaxyFade == null || !it) return it;
    const m = it.markerAlpha != null ? it.markerAlpha : (it.candidate ? 0.5 : 1) * (it.nearFade != null ? it.nearFade : 1);
    return { ...it, alpha: it.alpha * e.galaxyFade, lineAlpha: it.lineAlpha * e.galaxyFade, markerAlpha: m * e.galaxyFade, galaxyFade: e.galaxyFade };
  };
  for (const e of visible) {
    if (e.renderer !== 'billboard') continue;
    const bk = billboardKind(e.spec, e.o);
    if (bk === 'nebula') {
      const it = nebulaItem(e, cam, { project, evidence, nearFade, pxPerRad, skyFade: skyFade(cam, e.spec.skyFadePc || SKY_FADE_PC) });
      if (it) out.push(faded(it, e));
      continue;
    }
    if (bk === 'galaxy' || bk === 'milky_way') {
      const it = bk === 'galaxy' ? galaxyItem(e, cam, { project, evidence, skyFade: skyFade(cam, e.spec.skyFadePc || 1e5) }) : milkyWayItem(e, cam, { project, evidence, galaxyFade: gf });
      if (it) out.push(faded(it, e));
      continue;
    }
    const rel = framePos(e, cam), r50 = toPc(e.o.size && e.o.size.radius);
    if (!rel || !(r50 > 0)) continue;
    const dist = Math.hypot(rel[0], rel[1], rel[2]), radiusUnits = r50 * upc;
    const nq = e.o.props && e.o.props.n_members, n = nq && Number.isFinite(nq.v) && nq.v > 0 ? nq.v : null;
    const candidate = !!(e.o.props && e.o.props.quality && e.o.props.quality.v === 'candidate');
    // surface brightness, independent of distance: peak ~ N / r50_pc^2 (members per projected area), so a compact rich cluster is a
    // visible haze and a diffuse moving group is not. Unknown N: a faint default.
    const base = (n == null ? GLOW_UNKNOWN : Math.min(Math.max(GLOW_K * n / (r50 * r50), 0), 1)) * (candidate ? 0.5 : 1);
    const fade = dist > 0 ? smoothstep(GLOW_NEAR[0], GLOW_NEAR[1], dist / radiusUnits) : 0;
    const pxRadius = dist > 0 ? Math.atan(radiusUnits / dist) * pxPerRad : Infinity;
    const mode = evidence ? 'outline' : 'glow', hollow = e.spec.markerStyle(e.o) === 'hollow';
    const item = { id: e.id, kind: e.kind, rel, dist, radiusUnits, rgb: clusterRgb(e.o), alpha: base * fade * nearFade, fade, nearFade,
      lineAlpha: (candidate ? 0.5 : 1) * nearFade, mode, pxRadius,
      markerOnly: pxRadius < GLOW_MIN_PX, hollow, dashed: hollow && mode === 'outline', candidate };
    if (project) item.screen = project(rel);
    out.push(faded(item, e));
  }
  return out;
}

// ------------------------------------------------------------------ galaxy-frame marker points
export const HOLLOW_MIN_PX = 8;   // a hollow marker is at least this wide: a 4 px ring cannot be told from a dot
export const markerSize = (px, hollow) => (hollow ? -px : px);
export const isHollowSize = (size) => size < 0;
export function markerPoints(visible, groups, cam, items = [], { groupPx = 8, groupRgb = [1, 0.92, 0.75] } = {}) {
  const out = [];
  const put = (rel, size, a, c) => out.push(rel[0], rel[1], rel[2], size, a, c[0], c[1], c[2]);
  for (const e of visible) {
    if ((e.renderer !== 'marker' && e.renderer !== 'lensing') || (e.host && groups[e.host] && groups[e.host].grouped)) continue;   // a lensing look keeps its marker (the Evidence view shows only that)
    const rel = framePos(e, cam);
    const pres = presenceOf(e);
    if (rel && pres > 0) {
      const h = e.spec.markerStyle(e.o) === 'hollow', px = e.spec.markerPx(e.o), c = e.spec.color(e.o);
      put(rel, markerSize(h ? Math.max(px, HOLLOW_MIN_PX) : px, h), e.greyed ? pres * GREY_ALPHA : pres, e.greyed ? greyRgb(c) : c);   // greyed: beyond its valid range
    }
  }
  if (items.length) {
    const by = new Map(visible.map((e) => [e.id, e]));
    for (const it of items) {
      const e = by.get(it.id);
      const a = it.markerAlpha != null ? it.markerAlpha : (it.candidate ? 0.5 : 1) * it.nearFade;   // nebulae carry their own (nearFade x skyFade)
      if (e && a > 0) put(it.rel, markerSize(it.hollow ? Math.max(e.spec.markerPx(e.o), HOLLOW_MIN_PX) : e.spec.markerPx(e.o), it.hollow), a, e.spec.color(e.o));
    }
  }
  for (const [host, g] of Object.entries(groups)) {
    if (!g.grouped || g.hidden) continue;
    const rel = framePos({ galPc: g.pcPos, host, group: true }, cam), gfa = galaxyFade(cam);
    if (rel && gfa > 0) put(rel, g.hollow ? markerSize(Math.max(groupPx, HOLLOW_MIN_PX), true) : groupPx, gfa, groupRgb);   // a derived host: hollow
  }
  return new Float32Array(out);
}

// ------------------------------------------------------------------ count and cap text (section 16.11)
const SMALL_KINDS = ['dwarf_planet', 'asteroid', 'comet'];
const fmtN = (n) => Number(n).toLocaleString('en-US');
const isSmallGroup = (ks) => ks.length > 0 && ks.every((k) => SMALL_KINDS.includes(k));
const nounOf = (ks, n) => {
  if (isSmallGroup(ks) && ks.length > 1) return n === 1 ? 'small body' : 'small bodies';
  const s = ks.length === 1 ? kindSpec(ks[0]) : null;
  return s ? s.noun[n === 1 ? 0 : 1] : (ks.length === 1 ? ks[0].replace(/_/g, ' ') + (n === 1 ? '' : 's') : 'objects');
};
const isTrunc = (ks, st) => ks.some((k) => st && st[k] && st[k].truncated);

export function countPhrase(ks, counts = {}, kindStatus = {}, direct = {}) {
  const n = ks.reduce((s, k) => s + (counts[k] || 0), 0), trunc = isTrunc(ks, kindStatus);
  if (!n && !trunc) return '';
  const noun = nounOf(ks, n), dn = ks.reduce((s, k) => s + (direct[k] || 0), 0);
  let text;
  if (!trunc) text = `${fmtN(n)} ${noun}`;
  else if (ks.length === 1 && ks[0] === 'exoplanet') text = `${fmtN(n)} ${noun} of the brightest hosts (more in this cone)`;
  else text = `${fmtN(n)} ${isSmallGroup(ks) ? 'brightest ' : ''}${noun} (more in this cone)`;
  if (dn > 0) text = text.endsWith(')') ? `${text.slice(0, -1)}, ${fmtN(dn)} direction only)` : `${text} (${fmtN(dn)} direction only)`;
  return text;
}

export function capNotes(kindStatus = {}) {
  const order = kinds().map((s) => s.kind), notes = [], done = new Set();
  const groups = [SMALL_KINDS, ...order.filter((k) => !SMALL_KINDS.includes(k)).map((k) => [k])];
  for (const ks of groups) {
    const cut = ks.filter((k) => kindStatus[k] && kindStatus[k].truncated);
    if (!cut.length || cut.some((k) => done.has(k))) continue;
    cut.forEach((k) => done.add(k));
    const n = cut.reduce((s, k) => s + (kindStatus[k].count || 0), 0), num = n ? `${fmtN(n)} ` : '';
    const noun = nounOf(cut.length > 1 || isSmallGroup(ks) ? ks : cut, 2);
    notes.push(isSmallGroup(ks) ? `Showing the ${num}brightest ${noun} in the cone; fainter ones are left out.`
      : cut[0] === 'exoplanet' ? `Showing the ${num}exoplanets of the brightest hosts in the cone; the rest are left out.`
        : `Showing ${num}${noun} in the cone; more are left out.`);
  }
  return notes;
}

export function hostCountText(store, hostKey, { evidence = false, layers = {} } = {}) {
  const kids = store.childrenOf(hostKey);
  if (!kids.length) return '';
  const by = new Map();
  for (const o of kids) by.set(o.kind, (by.get(o.kind) || 0) + 1);
  const parts = [...by].map(([k, n]) => `${fmtN(n)} ${nounOf([k], n)}`);
  const text = parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  const illus = kids.some((o) => o.evidence === 'illustrative');
  const off = [...by.keys()].some((k) => { const l = layerOf(k); return l && layers[l] === false; });
  if (!illus && !off) return text;
  const bits = [];
  if (illus) bits.push('positions illustrative');
  if (evidence && illus) bits.push('hidden in the Evidence view'); else if (off) bits.push('layer off');
  return `${text} (${bits.join(', ')})`;
}

// ------------------------------------------------------------------ host stars (section 16.7)
const SUN_BP_RP = 0.82, FAINT_ABS = 10;
// Teff (K) -> Gaia BP-RP: the dwarf colour sequence of scene3d-physics.js (Pecaut & Mamajek 2013) read from the other side. It is
// monotone, so a host's illustrative colour never contradicts its temperature; it is only a colour, never shown as a measurement.
const TEFF_BPRP = [[2500, 4.5], [2850, 3.8], [3200, 2.9], [3550, 2.2], [3850, 1.84], [4400, 1.4], [4800, 1.15], [5280, 0.98], [5772, 0.82],
  [5920, 0.74], [6510, 0.55], [7220, 0.38], [8100, 0.2], [9700, 0], [11000, -0.1], [16000, -0.3], [30000, -0.45], [40000, -0.6]];
export function bpRpFromTeff(teffK) {
  if (!Number.isFinite(teffK)) return SUN_BP_RP;
  const T = TEFF_BPRP;
  if (teffK <= T[0][0]) return T[0][1];
  for (let i = 1; i < T.length; i++) {
    if (teffK <= T[i][0]) { const [x0, y0] = T[i - 1], [x1, y1] = T[i]; return y0 + ((y1 - y0) * (teffK - x0)) / (x1 - x0); }
  }
  return T[T.length - 1][1];
}
const qv = (q) => (q && Number.isFinite(q.v) ? q.v : null);
const pcOf = (q) => (q && q.unit === 'pc' ? (Number.isFinite(q.v) ? q.v : null) : toPc(q));   // pc stays exact: no round trip through km
export function objectStarParams(o) {
  const p = o && o.position;
  if (!p || !Number.isFinite(p.ra) || !Number.isFinite(p.dec)) return null;
  const d = p.dist ? pcOf(p.dist) : null;
  if (!(d > 0)) return null;
  const pr = o.props || {};
  const mag = qv(pr.gmag) ?? qv(pr.vmag) ?? (o.render && Number.isFinite(o.render.mag) ? o.render.mag : null);
  return { ra: p.ra, dec: p.dec, d, abs: mag === null ? FAINT_ABS : mag - 5 * Math.log10(d) + 5, bp: bpRpFromTeff(qv(pr.teff)) };
}

/** The star model's `values` for a star record (see the header). */
export function starValuesFromRecord(o) {
  const pr = (o && o.props) || {}, out = {};
  const keep = (q, v) => ({ v, lo: q.lo, hi: q.hi, src: q.src, tier: q.tier, unit: q.unit });
  const scaled = (q, to) => {          // q's value in the unit `to` (lo and hi scale with it); null when the unit is unknown
    if (!q || !Number.isFinite(q.v) || !UNIT_KM[q.unit] || !UNIT_KM[to]) return null;
    const k = UNIT_KM[q.unit] / UNIT_KM[to];
    return { ...keep(q, q.v * k), lo: Number.isFinite(q.lo) ? q.lo * k : undefined, hi: Number.isFinite(q.hi) ? q.hi * k : undefined };
  };
  if (qv(pr.teff) !== null) out.teff_k = keep(pr.teff, pr.teff.v);
  const r = scaled(o && o.size && o.size.radius, 'Rsun'); if (r) out.radius_rsun = r;
  const m = pr.mass; if (qv(m) !== null && (!m.unit || m.unit === 'Msun')) out.mass_msun = keep(m, m.v);
  const a = pr.age; if (qv(a) !== null && (!a.unit || a.unit === 'Gyr')) out.age_gyr = keep(a, a.v);
  const st = pr.spectral_type; if (st && typeof st.v === 'string' && st.v) out.spectral_type = { v: st.v, src: st.src, tier: st.tier };
  const d = o && o.position && o.position.dist, pc = d ? pcOf(d) : null;
  if (pc > 0) out.dist_pc = { ...keep(d, pc), lo: Number.isFinite(d.lo) ? pcOf({ v: d.lo, unit: d.unit }) : undefined, hi: Number.isFinite(d.hi) ? pcOf({ v: d.hi, unit: d.unit }) : undefined, unit: 'pc' };
  if (qv(pr.gmag) !== null) out.g_mag = keep(pr.gmag, pr.gmag.v);
  return out;
}
const TIER_STRENGTH = { measured: 0, catalogue: 1, derived: 2, inferred: 2, illustrative: 3 };
const strength = (q) => (q && Number.isFinite(TIER_STRENGTH[q.tier]) ? TIER_STRENGTH[q.tier] : 2);
const hasVal = (q) => !!q && (typeof q.v === 'string' ? q.v !== '' : Number.isFinite(q.v));
const MERGED_ROWS = ['teff_k', 'radius_rsun', 'lum_lsun', 'mass_msun', 'age_gyr', 'spectral_type'];
const NOTE_FOR_ROW = { teff_k: /^No effective temperature available/, mass_msun: /^FLAME mass not available/, age_gyr: /^FLAME age not available/ };
const PREFER_ROW = { teff: 'teff_k', radius: 'radius_rsun', mass: 'mass_msun' };   // prefer_record field -> star model row
const ROW_WORD = { teff_k: 'temperature', radius_rsun: 'radius', lum_lsun: 'luminosity', mass_msun: 'mass', age_gyr: 'age', spectral_type: 'spectral type' };
const wordList = (w) => (w.length < 2 ? w.join('') : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`);
export function mergeStarSystem(system, rec) {
  if (!rec) return system;
  const recVals = starValuesFromRecord(rec), vals = { ...((system && system.values) || {}) };
  const pref = preferredFields(rec), forced = new Set([...pref].map((f) => PREFER_ROW[f]).filter(Boolean)), notUsed = {};
  let notes = system && Array.isArray(system.notes) ? system.notes.slice() : [];
  for (const row of MERGED_ROWS) {
    const a = vals[row], b = recVals[row];
    if (!hasVal(b)) continue;
    if (forced.has(row)) { if (hasVal(a)) notUsed[row] = a; }                // prefer_record: the paper's value, whatever the tiers
    else if (hasVal(a) && strength(a) <= strength(b)) continue;               // a tie keeps Gaia's
    vals[row] = b;
    if (NOTE_FOR_ROW[row]) notes = notes.filter((n) => !NOTE_FOR_ROW[row].test(n));
  }
  if (!pref.size) return { ...(system || {}), values: vals, notes };
  const gaiaRows = MERGED_ROWS.filter((row) => hasVal(vals[row]) && vals[row] !== recVals[row]);
  if (gaiaRows.length) { const w = wordList(gaiaRows.map((r) => ROW_WORD[r])); notes.push(`${w.charAt(0).toUpperCase()}${w.slice(1)}: Gaia single-star model; may be biased for this binary.`); }
  const nu = MERGED_ROWS.filter((row) => notUsed[row]);
  if (nu.length) notes.push(`The Gaia single-star ${wordList(nu.map((r) => ROW_WORD[r]))} ${nu.length > 1 ? 'are' : 'is'} not used: Gaia's GSP-Phot and FLAME model the light as one single star, while the values shown come from the paper's fit of the binary.`);
  return { ...(system || {}), values: vals, notes, notUsed };
}
export function resolveStarAliases(stars, has) {
  const append = [], alias = new Map(), prefer = new Map();
  for (const rec of stars.values()) {
    const ids = [rec.id, ...(Array.isArray(rec.same_as) ? rec.same_as.filter((a) => typeof a === 'string') : [])];
    const loaded = ids.find(has);
    let key = loaded || null;
    if (!key && objectStarParams(rec)) { key = rec.id; append.push(rec); }
    else if (key && preferredStarDistance(rec) && !prefer.has(key)) prefer.set(key, rec);   // loaded under Gaia's own distance: re-place it
    if (key) for (const id of ids) if (!alias.has(id)) alias.set(id, key);
  }
  return { append, alias, prefer };
}
/**
 * A loaded star row re-placed at the curated distance of its prefer_record record (section 17.8): the Gaia direction and apparent G are kept and
 * only the distance (hence the absolute magnitude) changes. row = { xyz: [x, y, z] pc (the Gaia row, at its own distance), abs } or { dir, d, abs };
 * the apparent G is abs + 5 log10(d) - 5. -> { pos: [x, y, z] pc, d, abs, gaiaPc } or null (no prefer_record, or no usable row).
 */
export function preferredStarPlacement(rec, row) {
  const pd = preferredStarDistance(rec);
  if (!pd || !row) return null;
  const xyz = row.xyz || (row.dir && row.d > 0 ? row.dir.map((v) => v * row.d) : null);
  if (!xyz || !xyz.every(Number.isFinite)) return null;
  const gaiaPc = Math.hypot(xyz[0], xyz[1], xyz[2]);
  if (!(gaiaPc > 0)) return null;
  const k = pd.pc / gaiaPc, g = Number.isFinite(row.abs) ? row.abs + 5 * Math.log10(gaiaPc) - 5 : null;
  return { pos: [xyz[0] * k, xyz[1] * k, xyz[2] * k], d: pd.pc, abs: g === null ? row.abs : g - 5 * Math.log10(pd.pc) + 5, gaiaPc };
}
export function starSignature(stars) {
  let s = '';
  for (const r of stars.values()) s += `${r.id}=${Array.isArray(r.same_as) ? r.same_as.join(',') : ''};`;
  return s;
}

// ------------------------------------------------------------------ lensing (section 17.9, 19.3.3)
export const LENS_MIN_PX = 9, SHADOW_PER_RS = 2.598;   // the shadow's radius is sqrt(27) GM / c^2 = 2.598 r_s
export const LENS_FLOOR_PX = 1.5, LENS_CAP = 0.05;     // below LENS_FLOOR_PX a capped look is a marker only; the cap is LENS_CAP of the parent's drawn semi-major axis
/**
 * Items for the lensing renderer (pure data; the renderer draws a screen quad of radius 4 * px per item). Entries whose renderer is 'lensing' with a
 * size.radius (r_s); none in the Evidence view (marker only, markerPoints draws it). item = { id, kind, rel, dist, rShadow, truePx, px, enlarged,
 * factor, disc, incl, inclAssumed, capPx, screen? }
 *   rShadow  2.598 r_s in frame units (system: AU, galaxy: pc);  truePx  atan(rShadow / dist) * pxPerRad;  px  max(truePx, LENS_MIN_PX), capped below
 *   enlarged px > truePx;  factor  px / truePx, what is drawn over the truth (1 when not enlarged): the card says "Drawn enlarged ×3e9: ..."
 *   disc     the state is accreting (isAccreting);  incl  degrees, i_deg when known else 60 (illustrative; inclAssumed)
 * opts.items (the billboardItems of the frame): a supermassive black hole whose parent galaxy has an item that is not `inside` (the camera is outside that galaxy) is
 * capped to LENS_CAP (a twentieth) of that item's semiMajorPx: px = min(max(truePx, 9), capPx), so the whole look (radius 4 px) stays within a fifth of the galaxy.
 * Sgr A* inside the Milky Way (its item `inside`) and stellar-mass black holes are never capped. Below LENS_FLOOR_PX no item is made: the black hole is a marker.
 * The result array carries `.markerOnly`: those black holes as { id, kind, markerOnly: true, truePx, px: 0, factor: null, enlarged: false, capPx, parentId,
 * parentName, rel, dist, screen? }. The renderer keeps their markers (lensVisible) and passes the entry to the card as ctx.lensing, like a drawn item.
 */
export function lensingItems(visible, cam, { evidence = false, pxPerRad = 1000, project = null, items = [] } = {}) {
  const out = [], marks = [], upc = F.unitsPerPc(cam);
  out.markerOnly = marks;
  if (evidence) return out;
  for (const e of visible) {
    if (e.renderer !== 'lensing') continue;
    const rel = framePos(e, cam), rs = toKm(e.o.size && e.o.size.radius);
    if (!rel || !(rs > 0)) continue;
    const rShadow = SHADOW_PER_RS * (rs / (F.AU_PER_PC * KM_PER_AU)) * upc, dist = Math.hypot(rel[0], rel[1], rel[2]);
    const truePx = dist > 0 ? Math.atan(rShadow / dist) * pxPerRad : Infinity;
    let px = Math.max(truePx, LENS_MIN_PX), capPx = null, parent = null;
    if (isSupermassive(e.o) && e.o.parent && Number.isFinite(truePx)) {
      parent = items.find((i) => i.id === e.o.parent) || null;
      if (parent && !parent.inside && Number.isFinite(parent.semiMajorPx)) { capPx = LENS_CAP * parent.semiMajorPx; px = Math.min(px, capPx); } else parent = null;
    }
    if (capPx != null && px < LENS_FLOOR_PX) {
      const pe = visible.find((v) => v.id === e.o.parent), m = { id: e.id, kind: e.kind, markerOnly: true, truePx, px: 0, factor: null, enlarged: false, capPx, parentId: e.o.parent,
        parentName: pe ? pe.o.name : null, rel, dist, alpha: presenceOf(e) };
      if (project) m.screen = project(rel);
      marks.push(m);
      continue;
    }
    const iq = e.o.position && e.o.position.elements && e.o.position.elements.i_deg, known = !!iq && Number.isFinite(iq.v), enlarged = px > truePx;
    const item = { id: e.id, kind: e.kind, rel, dist, rShadow, truePx, px, enlarged, factor: enlarged ? px / truePx : 1, capPx,
      disc: isAccreting(e.o), incl: known ? iq.v : 60, inclAssumed: !known, alpha: presenceOf(e) };
    if (project) item.screen = project(rel);
    out.push(item);
  }
  return out;
}
/** The entries whose marker is drawn: every non-lensing entry; lensing entries in the Evidence view and the ones lensingItems made a marker only (`lens` is its result). */
export const lensVisible = (visible, lens, evidence = false) => {
  const only = new Set(((lens && lens.markerOnly) || []).map((m) => m.id));
  return visible.filter((e) => e.renderer !== 'lensing' || evidence || only.has(e.id));
};

// ------------------------------------------------------------------ "you came from here" (section 19.3.9)
export const HOME_MERGE_PX = 30, SUN_ID = 'ss:sun', MW_ID = 'gal:milky_way';
export const HOME_SUN_TEXT = 'Sun · you started here', HOME_MW_TEXT = 'Milky Way centre · Sgr A*', HOME_MERGED_TEXT = 'Milky Way · the Sun is here';
/**
 * The two "you came from here" markers: [{ id, sel: { kind, id }, text, rel, screen, alpha, merged, rgb }], pure. opts { project, galaxyFade (number, galaxyFade(cam)),
 * store, evidence }. The Sun (id 'ss:sun', sel { kind: 'sun' }: its card) at the galaxy-frame origin; the Milky Way's centre (id 'gal:milky_way', sel { kind: 'galaxy' }:
 * the Milky Way card) at store.placement('gal:milky_way').galPc, left out when the store lacks it. In cosmos alpha is 1; in the galaxy frame 1 - galaxyFade (nothing
 * at 0); never in a system frame. A marker the projector cannot place (behind the camera) is left out. When both are on screen and less than HOME_MERGE_PX apart they
 * merge into one item { id: 'gal:milky_way', text: 'Milky Way · the Sun is here', merged: true } at the centre. The Evidence view keeps both (both placements are
 * measured); `evidence` is accepted for symmetry. Label priority is the caller's: these come ahead of galaxies.
 */
export function homeMarkers(cam, { project = null, galaxyFade: gf = 0, store = null, evidence = false } = {}) {
  if (!cam || F.isHosted(cam.frame)) return [];
  const alpha = cam.frame === 'cosmos' ? 1 : 1 - gf;
  if (!(alpha > 0)) return [];
  const mk = (id, kind, text, pc, rgb) => {
    const rel = F.relFromCam(cam, pc), screen = project ? project(rel) : null;
    return project && !screen ? null : { id, sel: { kind, id }, text, rel, screen, alpha, merged: false, rgb };
  };
  const sun = mk(SUN_ID, 'sun', HOME_SUN_TEXT, [0, 0, 0], [1, 0.95, 0.8]);
  const pl = store && typeof store.placement === 'function' ? store.placement(MW_ID) : null;
  const mw = pl && pl.galPc ? mk(MW_ID, 'galaxy', HOME_MW_TEXT, pl.galPc, [0.9, 0.92, 1]) : null;
  if (sun && mw && sun.screen && mw.screen && Math.hypot(sun.screen[0] - mw.screen[0], sun.screen[1] - mw.screen[1]) < HOME_MERGE_PX) return [{ ...mw, text: HOME_MERGED_TEXT, merged: true }];
  return [sun, mw].filter(Boolean);
}

// ------------------------------------------------------------------ credits line (section 17.2)
/**
 * The datasets that returned records in the cone and carry a `credit`: [{ dataset, text: 'credit · licence_name', credit, licenceName, licence }].
 * sources: the /api/objects `sources` rows ({ id, status, count, provenance: { dataset, credit, licence_name, licence } }); counts: { dataset: n } of
 * the records that fell in the cone (datasetCounts), or omitted to use each row's own `count`. A row without a credit, with an error, or with no
 * records adds nothing. Equal credit lines are listed once.
 */
export function creditItems(sources, counts = null, extra = []) {
  const out = [], seen = new Set();
  for (const row of Array.isArray(sources) ? sources : []) {
    const pv = row && row.provenance;
    if (!pv || typeof pv.credit !== 'string' || !pv.credit.trim() || (row.status && row.status !== 'ok')) continue;
    const ds = pv.dataset || String(row.id || '').replace(/^static:/, ''), n = counts ? counts[ds] : row.count;
    if (!(n > 0)) continue;
    const credit = pv.credit.trim(), name = typeof pv.licence_name === 'string' ? pv.licence_name.trim() : '';
    const text = name ? `${credit} · ${name}` : credit;
    if (seen.has(text)) continue;
    seen.add(text); out.push({ dataset: ds, text, credit, licenceName: name || null, licence: pv.licence || null });
  }
  // client-side items (the Gaia star layer, starCreditItem): appended after the datasets, null ones dropped, equal text once
  for (const it of Array.isArray(extra) ? extra : [extra]) if (it && it.text && !seen.has(it.text)) { seen.add(it.text); out.push(it); }
  return out;
}
/** The credits line of the 3D view: the items of creditItems joined with ' | ', '' when there are none. extra: client-side items, e.g. [starCreditItem(hasGaia)]. */
export const creditsLine = (sources, counts = null, extra = []) => creditItems(sources, counts, extra).map((i) => i.text).join(' | ');
/**
 * { dataset: n } of the store's records that are in the cone, by record provenance.dataset (the counts creditsLine wants). skyScope: true also counts the
 * records of a sky-scope kind (galaxies) and the supermassive black holes that came in a sky tile without being in the cone (the context set, section 18.11),
 * so the credits stay up while those are what is on screen.
 */
export function datasetCounts(store, { skyScope = false } = {}) {
  const out = {};
  for (const r of store.recs) {
    const ds = r.o.provenance && r.o.provenance.dataset;
    // Sgr A* (parent: the Milky Way) is in bh-curated's sky tile but carries no Gaia values: its dataset's Gaia credit counts only when its cone is open
    if (ds && (r.o.in_cone === true || (skyScope && (r.spec.galaxyScope === 'sky' || (isSupermassive(r.o) && r.o.parent !== 'gal:milky_way'))))) out[ds] = (out[ds] || 0) + 1;
  }
  for (const s of store.stars.values()) { const ds = s.provenance && s.provenance.dataset; if (ds && s.in_cone === true) out[ds] = (out[ds] || 0) + 1; }
  return out;
}
