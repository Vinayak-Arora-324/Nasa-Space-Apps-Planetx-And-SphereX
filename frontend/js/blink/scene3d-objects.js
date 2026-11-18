// Object store and pure per-frame helpers for the 3D fly-through (docs/object-framework.md sections 7.2, 7.4 and 9).
// No DOM, no WebGL: the renderer passes plain inputs (a camera, a projector, a context) and draws what comes back.
//
// TERMS
//   cam      a scene3d-frames camera { frame, host, pos, ... }; host.key is the star id of the system frame the camera is in.
//   project  (rel) -> [x, y] | null   the renderer's _proj: CSS px of a camera-relative vector, null when off screen.
//   ctx      { layers: {id: bool}, evidence: bool, frame: 'system'|'galaxy', inHost(hostId) -> bool, pxPerRad }
//   entry    one drawn record: { o, spec, renderer, id, kind, host, sysAu, galPc, dir }  (o is the payload record)
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
//   framePos(entry, cam) -> [x, y, z] | null   camera-relative, in the camera's frame units, computed in doubles
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
//         lineAlpha    the Evidence ring's alpha: (0.5 for candidates, else 1) * fade * nearFade (no member-count dimming)
//         rel          camera-relative position in the camera's frame units (doubles; the renderer casts to float32)
//         dist, radiusUnits  its length and r50, both in frame units (r50 from size.radius, pc)
//         rgb          clusterRgb(o), illustrative colour from the age
//         alpha        base * fade: base from log10(n_members) (0.15 at 10 members, 0.45 at 100, 0.75 at 1000, clamped to
//                      [0.1, 1]; 0.3 without a count), times 0.5 for candidates
//         fade         smoothstep(0.5, 2, dist / r50): 0 inside the cluster's core, 1 beyond two r50
//         mode         'outline' (Evidence view: centre marker plus an r50 ring) | 'glow' (Plummer glow, illustrative look)
//         pxRadius     the projected r50 in px (atan(r50 / dist) * pxPerRad); markerOnly: pxRadius < 2 (no glow, marker only)
//         hollow       evidence 'derived' (hollow marker); dashed: hollow in outline mode; candidate: quality 'candidate'
//         screen       project(rel) when a projector is given
//       The renderer sets entry.markerOnly from the item so pickPriority uses the kind's marker priority (16) instead of 25.
//   markerPoints(visible, groups, cam, items = [], { groupPx = 8, groupRgb }) -> Float32Array   the dynamic-points data of the galaxy
//       frame: 8 floats per point (x y z size alpha r g b, camera-relative), one per ungrouped 'marker' entry, one per grouped host
//       and one per billboard item (the cluster centre marker, alpha 0.5 for candidates, times nearFade). A hollow marker
//       (spec.markerStyle(o) === 'hollow') is encoded as a NEGATIVE size: the point shader draws a ring of |size| px.
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
//
// STAR CARDS (section 16.8)
//   mergeStarSystem(system, rec) -> system'   the star model's `system` input for a star that has an archive star record (rec) and
//       maybe a Gaia /api/system payload. Per row (teff_k, radius_rsun, lum_lsun, mass_msun, age_gyr, spectral_type) the value with
//       the strongest tier wins (measured > catalogue > inferred > illustrative); on a tie, or when only one side has the row,
//       Gaia's is kept / the present one is used. The winner keeps its own src. Notes that the archive value makes false
//       ('No effective temperature available...', 'FLAME mass / age not available...') are dropped. Without rec, system is returned as is.
//
// TEXT HELPERS (section 16.11)
//   countPhrase(kinds, counts, kindStatus) -> string   '23 small bodies' | '2,000 brightest small bodies (more in this cone)' |
//       '2,000 exoplanets of the brightest hosts (more in this cone)'. kinds: kind names shown as one phrase (dwarf_planet,
//       asteroid and comet together read 'small bodies'); counts: {kind: n}; kindStatus: the payload's kinds map. '' when n = 0
//       and nothing is truncated. Numbers use en-US thousands separators.
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
//   resolveStarAliases(stars, has) -> { append: record[], alias: Map }   stars: store.stars (id -> record); has(key) -> bool for the
//       keys the renderer loaded. A record any of whose ids (id, same_as) is loaded maps all its ids to that key; otherwise, when it
//       has a distance, it is appended and all its ids map to its own id. Records with neither stay unresolved
//   starSignature(stars) -> string   changes when the set of star ids (or their same_as) changes: when _rebuildStars must run again
import { kindSpec, kinds, SCHEMA_MAJOR, toPc, rendererOf, clusterRgb, layerOf, UNIT_KM } from './scene3d-registry.js';
import * as F from './scene3d-frames.js';
import { radecToXyz, smoothstep } from './scene3d-math.js';
import { orbitPlacement, J2000_MJD } from './scene3d-orbits.js';

const { AU_PER_PC } = F;
const SUN = 'ss:sun', EARTH = 'ss:earth';
const kindOrder = () => new Map(kinds().map((s, i) => [s.kind, i]));
const hasXyz = (p) => Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite);

export class ObjectStore {
  constructor(opts = {}) { this.opts = opts; this._clear(); }
  _clear() {
    this.byId = new Map(); this.byKind = new Map(); this.recs = []; this._place = new Map(); this.stars = new Map();
    this.earth = null; this.query = null; this.kindStatus = {}; this.skipped = 0; this._earthAu = [0, 0, 0]; this._idx = null;
  }
  get hasSolar() { return !!this.earth; }
  get(id) { return this.byId.get(id) || null; }
  placement(id) { const r = this._place.get(id); return r ? { sysAu: r.sysAu, galPc: r.galPc, dir: r.dir, orbit: r.orbit } : null; }
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
      rec.galPc = null; this._placeRecord(rec, this._earthAu);
    }
  }
  _index() {   // children by resolved parent and star records by resolved key, rebuilt after ingest and setHostResolver
    if (this._idx) return this._idx;
    const kids = new Map(), stars = new Map();
    for (const rec of this.recs) if (rec.parent && rec.parent !== SUN) { if (!kids.has(rec.parent)) kids.set(rec.parent, []); kids.get(rec.parent).push(rec.o); }
    for (const s of this.stars.values()) { const k = this.resolveHost(s.id); if (!stars.has(k)) stars.set(k, s); }
    for (const s of this.stars.values()) for (const a of Array.isArray(s.same_as) ? s.same_as : []) { const k = this.resolveHost(a); if (!stars.has(k)) stars.set(k, s); }
    return (this._idx = { kids, stars });
  }
  childrenOf(starKey) { return (this._index().kids.get(starKey) || []).slice(); }
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
        spec: kindSpec(o.kind), sysAu: null, galPc: null, dir: null, orbit: null };
      this._placeRecord(rec, e);
      this.recs.push(rec); this._place.set(o.id, rec);
    }
    return { ok: true, unknownKinds };
  }
  _placeRecord(rec, earthAu) {
    const p = rec.o.position;
    if (p.model === 'state' && hasXyz(p.xyz_au)) {
      rec.sysAu = p.xyz_au.slice(0, 3);
      if (rec.host === SUN) rec.galPc = [(p.xyz_au[0] - earthAu[0]) / AU_PER_PC, (p.xyz_au[1] - earthAu[1]) / AU_PER_PC, (p.xyz_au[2] - earthAu[2]) / AU_PER_PC];
      else {
        const h = rec.host ? this.hostPc(rec.host) : null;
        if (h) rec.galPc = [h[0] + p.xyz_au[0] / AU_PER_PC, h[1] + p.xyz_au[1] / AU_PER_PC, h[2] + p.xyz_au[2] / AU_PER_PC];
      }
    } else if (p.model === 'orbit') {
      if (rec.orbit === null) rec.orbit = orbitPlacement(rec.o, this.query && Number.isFinite(this.query.mjd) ? this.query.mjd : J2000_MJD);
      if (!rec.orbit) return;
      rec.sysAu = rec.orbit.xyzAu.slice(0, 3);
      const h = rec.host ? this.hostPc(rec.host) : null;
      if (h) rec.galPc = [h[0] + rec.sysAu[0] / AU_PER_PC, h[1] + rec.sysAu[1] / AU_PER_PC, h[2] + rec.sysAu[2] / AU_PER_PC];
    } else if (p.model === 'fixed' && Number.isFinite(p.ra) && Number.isFinite(p.dec)) {
      const d = p.dist ? toPc(p.dist) : null;
      if (Number.isFinite(d)) rec.galPc = radecToXyz(p.ra, p.dec, d);
      else if (!p.dist) rec.dir = radecToXyz(p.ra, p.dec, 1);
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

export function visibleObjects(store, ctx) {
  const out = [], layers = ctx.layers || {}, ev = { evidence: !!ctx.evidence, layers };
  for (const r of store.recs) {
    const spec = r.spec, renderer = rendererOf(spec, ctx.frame, r.o);
    if (!renderer) continue;
    if (spec.layer && layers[spec.layer] === false) continue;
    if (!spec.visible(r.o, ev)) continue;
    if (ctx.frame === 'system') {
      if (!r.sysAu || !ctx.inHost(r.host)) continue;
    } else {
      if (!r.galPc || r.id === EARTH) continue;
      if (spec.galaxyScope === 'cone' && r.o.in_cone !== true) continue;
    }
    out.push({ o: r.o, spec, renderer, id: r.id, kind: r.kind, host: r.host, sysAu: r.sysAu, galPc: r.galPc, dir: r.dir });
  }
  return out;
}

export function framePos(entry, cam) {
  if (cam.frame === 'system') {
    if (!entry.sysAu) return null;
    return [entry.sysAu[0] - cam.pos[0], entry.sysAu[1] - cam.pos[1], entry.sysAu[2] - cam.pos[2]];
  }
  return entry.galPc ? F.relFromCam(cam, entry.galPc) : null;
}

export function groupState(store, visible, cam, pxPerRad, GROUP_PX = 8) {
  if (cam.frame !== 'galaxy') return {};
  const by = new Map();
  for (const e of visible) {
    if (!e.host || !e.sysAu) continue;
    if (!by.has(e.host)) by.set(e.host, []);
    by.get(e.host).push(e);
  }
  const out = {}, w = F.worldPc(cam);
  for (const [host, list] of by) {
    const pcPos = store.hostPc(host);
    if (!pcPos) continue;
    let maxR = 0; const byKind = {};
    for (const e of list) { maxR = Math.max(maxR, Math.hypot(e.sysAu[0], e.sysAu[1], e.sysAu[2])); byKind[e.kind] = (byKind[e.kind] || 0) + 1; }
    const dist = Math.hypot(pcPos[0] - w[0], pcPos[1] - w[1], pcPos[2] - w[2]) * AU_PER_PC;
    const name = host === SUN ? 'Solar system' : store.hostName(host), kk = Object.keys(byKind);
    const kind = kk.length === 1 ? kk[0] : null, spec = kind && kindSpec(kind), noun = spec ? spec.noun : null;
    const label = host !== SUN && noun ? `${name} · ${list.length} ${noun[list.length === 1 ? 0 : 1]}` : `${name} · ${list.length}`;
    out[host] = {
      grouped: list.length >= (host === SUN ? 2 : 1) && dist > 0 && (maxR / dist) * pxPerRad < GROUP_PX,
      count: list.length, byKind, pcPos: pcPos.slice(), name, kind: host === SUN ? null : kind, noun: host === SUN ? null : noun, label,
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

export function pickObjects(visible, groups, px, py, maxPx, { project, framePos: pos, reach = () => 0 }) {
  const cands = [];
  for (const e of visible) {
    if (isGrouped(groups, e)) continue;
    const rel = pos(e), q = rel && project(rel); if (!q) continue;
    const d = Math.hypot(q[0] - px, q[1] - py);
    if (d <= Math.max(maxPx, reach(e) || 0)) cands.push({ sel: { kind: e.kind, id: e.id }, priority: pickPriority(e), d });
  }
  for (const [host, g] of Object.entries(groups)) {
    if (!g.grouped) continue;
    const rel = pos({ galPc: g.pcPos, host, group: true }), q = rel && project(rel); if (!q) continue;
    const d = Math.hypot(q[0] - px, q[1] - py);
    if (d <= maxPx) cands.push({ sel: { kind: 'group', id: 'group:' + host }, priority: 10, d });
  }
  return choosePick(cands);
}

export function labelCandidates(visible, groups, { project, framePos: pos, discPx = () => 0 }) {
  const out = [], pools = new Map();
  for (const e of visible) {
    const L = e.spec.label; if (!L || isGrouped(groups, e)) continue;
    const rel = pos(e), q = rel && project(rel); if (!q) continue;
    if (L.hideOverDiscPx != null && discPx(e) > L.hideOverDiscPx) continue;
    const item = { x: q[0], y: q[1], key: L.key(e.o), text: e.o.name };
    if (L.max == null) { out.push(item); continue; }
    const pool = L.group || e.kind;
    if (!pools.has(pool)) pools.set(pool, { max: L.max, items: [] });
    pools.get(pool).items.push(item);
  }
  for (const { max, items } of pools.values()) out.push(...items.sort((a, b) => a.key - b.key).slice(0, max));
  for (const [host, g] of Object.entries(groups)) {
    if (!g.grouped) continue;
    const rel = pos({ galPc: g.pcPos, host, group: true }), q = rel && project(rel); if (!q) continue;
    out.push({ x: q[0], y: q[1], key: 5, text: g.label || `${g.name} · ${g.count}` });
  }
  return out;
}

export function planGo(target, { camFrame, camHostKey, sunId = SUN, resolveHost } = {}) {
  if (!target || target.kind === 'star') return { type: 'star' };
  const isGroup = target.kind === 'group', raw = isGroup ? (target.host || String(target.id).replace(/^group:/, '')) : target.host;
  const hostId = raw && resolveHost ? resolveHost(raw) || raw : raw;
  if (!hostId) return { type: 'fly-galaxy' };
  if (isGroup) return hostId === sunId ? { type: 'solar-scene' } : { type: 'via-host', hostId };
  if (camFrame === 'system' && camHostKey === hostId) return { type: 'fly' };
  return hostId === sunId ? { type: 'solar-scene' } : { type: 'via-host', hostId };
}

// ------------------------------------------------------------------ billboards (section 16.10)
const GLOW_MIN_PX = 2;
export function billboardItems(visible, cam, { evidence = false, pxPerRad = 1000, project = null, nearPc = Infinity } = {}) {
  if (cam.frame !== 'galaxy') return [];
  const out = [], upc = F.unitsPerPc(cam), nearFade = smoothstep(F.ENTER_PC, 4 * F.ENTER_PC, nearPc);
  for (const e of visible) {
    if (e.renderer !== 'billboard') continue;
    const rel = framePos(e, cam), r50 = toPc(e.o.size && e.o.size.radius);
    if (!rel || !(r50 > 0)) continue;
    const dist = Math.hypot(rel[0], rel[1], rel[2]), radiusUnits = r50 * upc;
    const nq = e.o.props && e.o.props.n_members, n = nq && Number.isFinite(nq.v) && nq.v > 0 ? nq.v : null;
    const candidate = !!(e.o.props && e.o.props.quality && e.o.props.quality.v === 'candidate');
    const base = (n == null ? 0.3 : Math.min(Math.max(0.15 + 0.3 * (Math.log10(n) - 1), 0.1), 1)) * (candidate ? 0.5 : 1);
    const fade = dist > 0 ? smoothstep(0.5, 2, dist / radiusUnits) : 0;
    const pxRadius = dist > 0 ? Math.atan(radiusUnits / dist) * pxPerRad : Infinity;
    const mode = evidence ? 'outline' : 'glow', hollow = e.spec.markerStyle(e.o) === 'hollow';
    const item = { id: e.id, kind: e.kind, rel, dist, radiusUnits, rgb: clusterRgb(e.o), alpha: base * fade * nearFade, fade, nearFade,
      lineAlpha: (candidate ? 0.5 : 1) * fade * nearFade, mode, pxRadius,
      markerOnly: pxRadius < GLOW_MIN_PX, hollow, dashed: hollow && mode === 'outline', candidate };
    if (project) item.screen = project(rel);
    out.push(item);
  }
  return out;
}

// ------------------------------------------------------------------ galaxy-frame marker points
export const markerSize = (px, hollow) => (hollow ? -px : px);
export const isHollowSize = (size) => size < 0;
export function markerPoints(visible, groups, cam, items = [], { groupPx = 8, groupRgb = [1, 0.92, 0.75] } = {}) {
  const out = [];
  const put = (rel, size, a, c) => out.push(rel[0], rel[1], rel[2], size, a, c[0], c[1], c[2]);
  for (const e of visible) {
    if (e.renderer !== 'marker' || (e.host && groups[e.host] && groups[e.host].grouped)) continue;
    const rel = framePos(e, cam);
    if (rel) put(rel, markerSize(e.spec.markerPx(e.o), e.spec.markerStyle(e.o) === 'hollow'), 1, e.spec.color(e.o));
  }
  if (items.length) {
    const by = new Map(visible.map((e) => [e.id, e]));
    for (const it of items) {
      const e = by.get(it.id);
      if (e && it.nearFade > 0) put(it.rel, markerSize(e.spec.markerPx(e.o), it.hollow), (it.candidate ? 0.5 : 1) * it.nearFade, e.spec.color(e.o));
    }
  }
  for (const [host, g] of Object.entries(groups)) {
    if (!g.grouped) continue;
    const rel = framePos({ galPc: g.pcPos, host, group: true }, cam);
    if (rel) put(rel, groupPx, 1, groupRgb);
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

export function countPhrase(ks, counts = {}, kindStatus = {}) {
  const n = ks.reduce((s, k) => s + (counts[k] || 0), 0), trunc = isTrunc(ks, kindStatus);
  if (!n && !trunc) return '';
  const noun = nounOf(ks, n);
  if (!trunc) return `${fmtN(n)} ${noun}`;
  if (ks.length === 1 && ks[0] === 'exoplanet') return `${fmtN(n)} ${noun} of the brightest hosts (more in this cone)`;
  return `${fmtN(n)} ${isSmallGroup(ks) ? 'brightest ' : ''}${noun} (more in this cone)`;
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
export function mergeStarSystem(system, rec) {
  if (!rec) return system;
  const recVals = starValuesFromRecord(rec), vals = { ...((system && system.values) || {}) };
  let notes = system && Array.isArray(system.notes) ? system.notes.slice() : [];
  for (const row of MERGED_ROWS) {
    const a = vals[row], b = recVals[row];
    if (!hasVal(b) || (hasVal(a) && strength(a) <= strength(b))) continue;   // a tie keeps Gaia's
    vals[row] = b;
    if (NOTE_FOR_ROW[row]) notes = notes.filter((n) => !NOTE_FOR_ROW[row].test(n));
  }
  return { ...(system || {}), values: vals, notes };
}
export function resolveStarAliases(stars, has) {
  const append = [], alias = new Map();
  for (const rec of stars.values()) {
    const ids = [rec.id, ...(Array.isArray(rec.same_as) ? rec.same_as.filter((a) => typeof a === 'string') : [])];
    const loaded = ids.find(has);
    let key = loaded || null;
    if (!key && objectStarParams(rec)) { key = rec.id; append.push(rec); }
    if (key) for (const id of ids) if (!alias.has(id)) alias.set(id, key);
  }
  return { append, alias };
}
export function starSignature(stars) {
  let s = '';
  for (const r of stars.values()) s += `${r.id}=${Array.isArray(r.same_as) ? r.same_as.join(',') : ''};`;
  return s;
}
