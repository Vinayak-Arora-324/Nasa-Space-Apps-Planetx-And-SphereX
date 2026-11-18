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
//   ingest(payload) -> { ok: true, unknownKinds } | { ok: false, error }
//       Replaces the contents. A schema major other than SCHEMA_MAJOR gives ok: false and leaves the store empty.
//       Records of unregistered kinds are counted in unknownKinds; records without id, kind or position, duplicate ids and
//       records of builtin kinds (stars) are skipped (store.skipped counts them).
//   byId: Map id -> record (the payload object);  byKind: Map kind -> record[];  recs: placed records (see below)
//   get(id) -> record | null;  placement(id) -> { sysAu, galPc, dir } | null
//   earth: the 'ss:earth' record or null;  hasSolar: boolean (earth present)
//   query: the payload's query;  kindStatus: the payload's `kinds` map ({kind: {status, source, count, truncated, error?}})
//   counts() -> { kind: n } for the stored records
//   errorNotes() -> [{ kinds: [kind...], error }]   kinds with status 'error', grouped by message, in registry order
//   hostPc(hostId) -> [x, y, z] | null   'ss:sun' is the origin; others come from opts.hostPc
//   Placement per record (computed once per ingest):
//     sysAu  xyz_au relative to its host (state positions), else null
//     galPc  galaxy-frame position in pc, in doubles. Host ss:sun: (xyz_au - earth.xyz_au) / AU_PER_PC, the sky as seen
//            from Earth (section 9; with no earth record it is just xyz_au / AU_PER_PC). Another host: hostPc + xyz / AU_PER_PC
//            when opts.hostPc knows it, else null. fixed positions: radecToXyz(ra, dec, distPc); no distance: null
//     dir    unit vector to a direction-only (fixed, dist null) record, else null
//
// kindsPhrase(kinds) -> 'Dwarf planets, asteroids and comets'   the registry nouns joined for a note
// Helpers (pure; entries come from visibleObjects):
//   visibleObjects(store, ctx) -> entry[]
//       Registered, not builtin, has a renderer for ctx.frame, its layer is not off (a layer missing from ctx.layers counts
//       as on), spec.visible passes, system frame: ctx.inHost(host) and sysAu known; galaxy frame: galPc known, 'cone'
//       scope needs in_cone === true, and ss:earth is never drawn (it is the observer).
//   framePos(entry, cam) -> [x, y, z] | null   camera-relative, in the camera's frame units, computed in doubles
//   groupState(store, visible, cam, pxPerRad, GROUP_PX = 8) -> { [hostId]: { grouped, count, byKind, pcPos, name } }
//       Galaxy frame only ({} otherwise). grouped: the host's visible records span maxR_AU / dist_AU * pxPerRad < GROUP_PX
//       (and there are at least two of them). pcPos: where the group marker goes (the host, in pc). name: 'Solar system' for
//       ss:sun, else the host's record name or id.
//   pickObjects(visible, groups, px, py, maxPx, { project, framePos, reach }) -> { sel, priority, d } | null
//       framePos(entry) -> rel (the renderer closes over the camera; a pseudo-entry { galPc, host, group: true } stands for a
//       group marker), reach(entry) -> extra pick radius in px (a sphere's disc; may be omitted). Grouped hosts give one group
//       candidate (priority 10). Lowest priority wins, then nearest pixel (see choosePick).
//   choosePick(cands) -> the winning candidate | null   cands: [{ sel, priority, d }]; merge the star candidate in here
//   labelCandidates(visible, groups, { project, framePos, discPx }) -> [{ x, y, key, text }]
//       discPx(entry) -> disc radius in px. Applies each kind's label rule. Labels of one pool (spec.label.group, else the
//       kind) are sorted by key and cut to label.max. A grouped host gives one label 'Solar system · 14' with key 5.
//   planGo(target, { camFrame, camHostKey, sunId = 'ss:sun' }) -> a plan
//       target: a record, a { kind, id, host } sel-like, or a group { kind: 'group', id: 'group:<host>' }.
//       { type: 'star' } | { type: 'fly' } (host is the camera's system frame) | { type: 'solar-scene' } (host ss:sun, camera
//       not in it) | { type: 'via-host', hostId } (star trip to hostId, then fly) | { type: 'fly-galaxy' } (no host)
import { kindSpec, kinds, SCHEMA_MAJOR, toPc } from './scene3d-registry.js';
import * as F from './scene3d-frames.js';
import { radecToXyz } from './scene3d-math.js';

const { AU_PER_PC } = F;
const SUN = 'ss:sun', EARTH = 'ss:earth';
const kindOrder = () => new Map(kinds().map((s, i) => [s.kind, i]));
const hasXyz = (p) => Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite);

export class ObjectStore {
  constructor(opts = {}) { this.opts = opts; this._clear(); }
  _clear() {
    this.byId = new Map(); this.byKind = new Map(); this.recs = []; this._place = new Map();
    this.earth = null; this.query = null; this.kindStatus = {}; this.skipped = 0;
  }
  get hasSolar() { return !!this.earth; }
  get(id) { return this.byId.get(id) || null; }
  placement(id) { const r = this._place.get(id); return r ? { sysAu: r.sysAu, galPc: r.galPc, dir: r.dir } : null; }
  hostPc(hostId) { return hostId === SUN ? [0, 0, 0] : (this.opts.hostPc ? this.opts.hostPc(hostId) || null : null); }

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
      if (spec.builtin || this.byId.has(o.id)) { this.skipped++; continue; }
      this.byId.set(o.id, o); accepted.push(o);
      if (!this.byKind.has(o.kind)) this.byKind.set(o.kind, []);
      this.byKind.get(o.kind).push(o);
    }
    this.earth = this.byId.get(EARTH) || null;
    const e = this.earth && hasXyz(this.earth.position.xyz_au) ? this.earth.position.xyz_au : [0, 0, 0];
    for (const o of accepted) {
      const rec = { o, id: o.id, kind: o.kind, host: o.host || null, spec: kindSpec(o.kind), sysAu: null, galPc: null, dir: null };
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
  const out = [], layers = ctx.layers || {}, ev = { evidence: !!ctx.evidence };
  for (const r of store.recs) {
    const spec = r.spec, renderer = spec.frames[ctx.frame];
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
    const hostRec = store.get(host);
    out[host] = {
      grouped: list.length >= 2 && dist > 0 && (maxR / dist) * pxPerRad < GROUP_PX,
      count: list.length, byKind, pcPos: pcPos.slice(), name: host === SUN ? 'Solar system' : (hostRec && hostRec.name) || host,
    };
  }
  return out;
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
    if (d <= Math.max(maxPx, reach(e) || 0)) cands.push({ sel: { kind: e.kind, id: e.id }, priority: e.spec.pick.priority, d });
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
    out.push({ x: q[0], y: q[1], key: 5, text: `${g.name} · ${g.count}` });
  }
  return out;
}

export function planGo(target, { camFrame, camHostKey, sunId = SUN } = {}) {
  if (!target || target.kind === 'star') return { type: 'star' };
  const isGroup = target.kind === 'group', hostId = isGroup ? (target.host || String(target.id).replace(/^group:/, '')) : target.host;
  if (!hostId) return { type: 'fly-galaxy' };
  if (isGroup) return hostId === sunId ? { type: 'solar-scene' } : { type: 'via-host', hostId };
  if (camFrame === 'system' && camHostKey === hostId) return { type: 'fly' };
  return hostId === sunId ? { type: 'solar-scene' } : { type: 'via-host', hostId };
}
