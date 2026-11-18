// Kinds and layers registry for the 3D fly-through (docs/object-framework.md section 7.1 and 7.3). Pure: no DOM, no WebGL.
//
// A kind spec says how one kind of object is drawn, picked, labelled, carded and flown to. scene3d.js and
// scene3d-objects.js ask the registry instead of branching on the kind. A layer is a toggle in the Layers panel; kinds
// point at one by id. Adding a kind in a later phase is one registerKind() call (plus a registerLayer() if it needs one).
//
// EXPORTS
//   SCHEMA_MAJOR = 1                 object schema major the page understands (payload.schema 'space-maps.objects/<major>')
//   MAX_BODY_LABELS = 12             cap on small-body labels
//   FEATURE_TIER = 'illustrative'    tier of planet bands, atmospheres and rings
//   EVIDENCE_HIDES_FEATURES = false  when true, sphere() returns all features as 0 in the Evidence view (a later follow-up)
//   UNIT_KM                          kilometres per unit: km, au, pc, Mpc
//   toAu(q) / toPc(q) -> number|null a Quantity {v, unit} in AU / parsecs (null for a missing, non-numeric or unknown unit)
//   fmtNum(v, sig = 3)               number text for cards (the same as scene3d.js's)
//   evidenceRows(rows, evidence)     drops rows whose tier is 'illustrative' when evidence is true
//
//   registerKind(spec) / kindSpec(kind) -> spec|null / kinds() -> spec[] in registration order
//   registerLayer({id, label, group, on = true}) / layers() -> layer[] / layerOf(kind) -> layer id|null
//   defaultLayers() -> {id: bool}
//   loadLayers(storage = globalThis.localStorage) -> {id: bool}   (defaults merged with valid saved booleans; never throws)
//   saveLayers(map, storage = globalThis.localStorage)            (key 'blink.scene3d.layers'; never throws)
//
// KIND SPEC (every field below is present after registerKind; defaults in brackets)
//   kind, layer (id or null), noun [singular, plural], builtin [false]
//   frames       { system?: 'point'|'sphere'|'marker', galaxy?: ... }  renderer per frame; absent = not drawn there [{}]
//   galaxyScope  'sky' (all records) | 'cone' (only in_cone === true)  in the galaxy frame ['sky']
//   pick         { priority, marker? }  lower is picked first: planets and the Sun 10, stars 20, small bodies 30 [30].
//                marker: the priority while drawn as a galaxy-frame marker (small bodies 15: a marker in the Gaia cone
//                always has stars within reach, and the marker is what the viewer is pointing at)
//   label        { key(o), max, group?, hideOverDiscPx } | null.  key sorts labels (small first wins); max caps the
//                labels of a pool (kinds sharing `group`, or the kind alone); hideOverDiscPx hides the label over a disc
//   card(o, ctx) -> { title, subtitle, rows: [[label, text, tier, src]], notes }   ctx = { fromYou: string|null, evidence, fmtNum }
//   go           'host-frame'  autopilot flies inside the host's system frame ['host-frame']
//   arriveAu(o)  stop distance radius, AU (spheres: the radius, points: 0)
//   collide      keep the camera outside the sphere in the system frame [false]
//   color(o)     illustrative display colour [r, g, b] 0..1
//   sphere(o, {evidence}) -> { rgb, pole: [raDeg, decDeg]|null, features: {ring, band, atm} (0|1), ext }  (sphere kinds only)
//                rgb is the display colour as in the old PLANET_RGB (not linearised); ext is the impostor quad extent
//   visible(o, {evidence}) -> bool    default: hides evidence === 'illustrative' records in the Evidence view
//   markerStyle(o) -> 'hollow'|'solid'    'hollow' for derived records
//   pointSize(o)  size in px of the system-frame point (Earth 9, the Moon 4, other planets 6.5, small bodies 3)
//   markerPx(o)   size in px of the galaxy-frame marker (the Sun 6, planets 5, the Moon 4, small bodies 3)
import { KM_PER_AU } from './scene3d-math.js';
import { AU_PER_PC } from './scene3d-frames.js';

export const SCHEMA_MAJOR = 1;
export const MAX_BODY_LABELS = 12;
export const FEATURE_TIER = 'illustrative';
export const EVIDENCE_HIDES_FEATURES = false;

const PC_KM = AU_PER_PC * KM_PER_AU;
export const UNIT_KM = { km: 1, au: KM_PER_AU, pc: PC_KM, Mpc: PC_KM * 1e6 };
const conv = (q, per) => (q && Number.isFinite(q.v) && UNIT_KM[q.unit] ? (q.v * UNIT_KM[q.unit]) / per : null);
export const toAu = (q) => conv(q, KM_PER_AU);
export const toPc = (q) => conv(q, PC_KM);
const toKm = (q) => conv(q, 1);

export const fmtNum = (v, sig = 3) => (Number.isFinite(v) ? v.toLocaleString('en-US', { maximumSignificantDigits: sig }) : 'n/a');
export const evidenceRows = (rows, evidence) => (evidence ? rows.filter((r) => r[2] !== 'illustrative') : rows);

// ------------------------------------------------------------------ layers
const LAYER_LIST = [];
const LAYER_KEY = 'blink.scene3d.layers';
export function registerLayer({ id, label, group, on = true }) {
  const l = { id, label, group, on: !!on }, i = LAYER_LIST.findIndex((x) => x.id === id);
  if (i >= 0) LAYER_LIST[i] = l; else LAYER_LIST.push(l);
  return l;
}
export const layers = () => LAYER_LIST.map((l) => ({ ...l }));
export const defaultLayers = () => Object.fromEntries(LAYER_LIST.map((l) => [l.id, l.on]));
export const layerOf = (kind) => { const s = KIND_MAP.get(kind); return s ? s.layer : null; };
function storageOf(storage) { try { return storage === undefined ? globalThis.localStorage : storage; } catch (_) { return null; } }
export function loadLayers(storage) {
  const out = defaultLayers();
  try {
    const st = storageOf(storage);
    if (!st) return out;
    const saved = JSON.parse(st.getItem(LAYER_KEY) || '{}');
    if (saved && typeof saved === 'object') for (const l of LAYER_LIST) if (typeof saved[l.id] === 'boolean') out[l.id] = saved[l.id];
  } catch (_) { /* storage blocked or bad JSON: defaults */ }
  return out;
}
export function saveLayers(map, storage) {
  try { const st = storageOf(storage); if (st) st.setItem(LAYER_KEY, JSON.stringify(map)); } catch (_) { /* storage blocked */ }
}

// ------------------------------------------------------------------ kinds
const KIND_MAP = new Map();
const noop = () => 0;
const DEFAULTS = {
  layer: null, builtin: false, frames: {}, galaxyScope: 'sky', pick: { priority: 30 }, label: null, card: null, go: 'host-frame',
  arriveAu: noop, collide: false, color: () => [0.8, 0.8, 0.8], sphere: null,
  visible: (o, { evidence } = {}) => !(evidence && o.evidence === 'illustrative'),
  markerStyle: (o) => (o.evidence === 'derived' ? 'hollow' : 'solid'),
  pointSize: () => 3, markerPx: () => 3,
};
export function registerKind(spec) {
  if (!spec || typeof spec.kind !== 'string') throw new Error('registerKind: a kind name is required');
  const s = { ...DEFAULTS, ...spec };
  if (!s.noun) s.noun = [spec.kind.replace(/_/g, ' '), spec.kind.replace(/_/g, ' ') + 's'];
  KIND_MAP.set(s.kind, s);
  return s;
}
export const kindSpec = (kind) => KIND_MAP.get(kind) || null;
export const kinds = () => [...KIND_MAP.values()];

// ------------------------------------------------------------------ built-in data for the Phase 0 kinds
// Display colours (illustrative). The Earth and Moon rows are for the sphere and marker shading.
const PLANET_RGB = {
  Mercury: [0.75, 0.72, 0.68], Venus: [0.95, 0.85, 0.6], Earth: [0.35, 0.62, 1.0], Moon: [0.8, 0.8, 0.8],
  Mars: [1.0, 0.5, 0.35], Jupiter: [0.92, 0.8, 0.66], Saturn: [0.95, 0.87, 0.6], Uranus: [0.6, 0.9, 0.95], Neptune: [0.42, 0.6, 1.0],
};
const POLE = { Jupiter: [268.06, 64.5], Saturn: [40.59, 83.54], Mars: [317.68, 52.89] };   // RA, Dec of the spin axes (illustrative)
const NEO_RE = /NEO|PHA|Apollo|Aten|Amor/i;

const prop = (o, key) => (o.props ? o.props[key] : undefined) || null;
const srcOf = (q) => (q && q.src) || null;
/** A row for a quantity with a unit: [label, text, tier, src]; 'n/a' when the record lacks it. */
function qtyRow(label, q, fmt, fallbackTier) {
  return [label, q && Number.isFinite(q.v) ? fmt(q) : 'n/a', (q && q.tier) || fallbackTier, srcOf(q)];
}
const hypot3 = (a) => Math.hypot(a[0], a[1], a[2]);
const sunDistAu = (o) => {
  const q = prop(o, 'dist_sun');
  if (q && Number.isFinite(toAu(q))) return { ...q, v: toAu(q), unit: 'au' };
  const p = o.position && o.position.xyz_au;      // a record without it: the distance from its position (host is the Sun)
  return p && o.host === 'ss:sun' ? { v: hypot3(p), unit: 'au', tier: o.position.tier || 'measured', src: o.position.src } : null;
};
const earthDistAu = (o) => {
  const q = prop(o, 'dist_earth');
  if (q && Number.isFinite(toAu(q))) return { ...q, v: toAu(q), unit: 'au' };
  const g = o.position && o.position.geo;
  return g && Number.isFinite(g.dist_au) ? { v: g.dist_au, unit: 'au', tier: o.position.tier || 'measured', src: o.position.src } : null;
};
const fromYouRow = (ctx) => (ctx.fromYou != null ? [['From you', ctx.fromYou, 'illustrative', 'distance from the camera right now']] : []);
const finish = (ctx, card) => ({ ...card, rows: evidenceRows(card.rows, ctx.evidence) });
const num = (ctx) => ctx.fmtNum || fmtNum;

function planetCard(o, ctx) {
  const f = num(ctx), r = o.size && o.size.radius, km = toKm(r), sun = sunDistAu(o);
  return finish(ctx, {
    title: o.name, subtitle: null, notes: null,
    rows: [
      ['Radius', Number.isFinite(km) ? `${f(km)} km` : 'n/a', (r && r.tier) || 'measured', srcOf(r)],
      qtyRow('Distance from Sun', sun, (q) => `${f(q.v)} AU`, 'measured'),
      ...fromYouRow(ctx),
      ['Colour and lighting', 'illustrative', FEATURE_TIER, null],
    ],
  });
}
function sunCard(o, ctx) {   // the renderer replaces this with the star card for star 0; this is the fallback
  const f = num(ctx), e = earthDistAu(o);
  return finish(ctx, { title: o.name || 'Sun', subtitle: 'The Sun', notes: null, rows: [qtyRow('Distance from Earth', e, (q) => `${f(q.v)} AU`, 'measured'), ...fromYouRow(ctx)] });
}
function smallBodyCard(o, ctx) {
  const f = num(ctx), m = /^mp:(\d+)$/.exec(o.id || ''), name = o.name || 'Small body';
  const title = m && name !== m[1] ? `${m[1]} ${name}` : name;
  const vmag = prop(o, 'vmag'), cls = prop(o, 'class');
  return finish(ctx, {
    title, subtitle: null, notes: null,
    rows: [
      qtyRow('Distance from Sun', sunDistAu(o), (q) => `${f(q.v)} AU`, 'catalogue'),
      qtyRow('Distance from Earth', earthDistAu(o), (q) => `${f(q.v)} AU`, 'catalogue'),
      ...fromYouRow(ctx),
      ['Visual mag', vmag && Number.isFinite(vmag.v) ? vmag.v.toFixed(1) : 'n/a', (vmag && vmag.tier) || 'catalogue', srcOf(vmag)],
      ['Class', (cls && cls.v) || 'n/a', (cls && cls.tier) || 'catalogue', srcOf(cls)],
    ],
  });
}
const smallMag = (o) => (o.render && Number.isFinite(o.render.mag) ? o.render.mag : (prop(o, 'vmag') && Number.isFinite(prop(o, 'vmag').v) ? prop(o, 'vmag').v : 30));
const radiusAu = (o) => { const a = toAu(o.size && o.size.radius); return Number.isFinite(a) ? a : 4e-5; };   // 4e-5 AU: the old fallback

function sphereOf(o, { evidence } = {}) {
  const n = o.name, hide = EVIDENCE_HIDES_FEATURES && evidence;
  const f = hide ? { ring: 0, band: 0, atm: 0 } : { ring: n === 'Saturn' ? 1 : 0, band: n === 'Jupiter' || n === 'Saturn' ? 1 : 0, atm: n === 'Earth' || n === 'Venus' ? 1 : 0 };
  return { rgb: PLANET_RGB[n] || [0.8, 0.8, 0.8], pole: POLE[n] || null, features: f, ext: n === 'Saturn' && !evidence && !hide ? 2.4 : 1.1 };
}
const smallColor = (o) => (NEO_RE.test((prop(o, 'class') || {}).v || '') ? [1.0, 0.7, 0.5] : [0.82, 0.78, 0.7]);
const SMALL = { frames: { system: 'point', galaxy: 'marker' }, galaxyScope: 'cone', pick: { priority: 30, marker: 15 }, card: smallBodyCard, pointSize: () => 3, markerPx: () => 3,
  label: { key: (o) => 100 + smallMag(o), max: MAX_BODY_LABELS, group: 'small', hideOverDiscPx: null } };

registerLayer({ id: 'mw', label: 'Milky Way glow', group: 'sky' });
registerLayer({ id: 'cone', label: 'Cone outline', group: 'sky' });
registerLayer({ id: 'starNames', label: 'Star names', group: 'sky' });
registerLayer({ id: 'planets', label: 'Planets and the Moon', group: 'solar' });
registerLayer({ id: 'orbits', label: 'Orbits', group: 'solar' });
registerLayer({ id: 'dwarfPlanets', label: 'Dwarf planets', group: 'solar' });
registerLayer({ id: 'asteroids', label: 'Asteroids', group: 'solar' });
registerLayer({ id: 'comets', label: 'Comets', group: 'solar' });

registerKind({ kind: 'sun', layer: 'planets', noun: ['sun', 'suns'], frames: { galaxy: 'marker' }, galaxyScope: 'sky', pick: { priority: 10 },
  label: { key: () => 0, max: null, hideOverDiscPx: null }, card: sunCard, arriveAu: radiusAu, color: () => [1.0, 0.95, 0.8], pointSize: () => 6.5, markerPx: () => 6 });
registerKind({ kind: 'planet', layer: 'planets', noun: ['planet', 'planets'], frames: { system: 'sphere', galaxy: 'marker' }, galaxyScope: 'sky', pick: { priority: 10 },
  label: { key: () => 0, max: null, hideOverDiscPx: 30 }, card: planetCard, arriveAu: radiusAu, collide: true,
  color: (o) => PLANET_RGB[o.name] || [0.8, 0.8, 0.8], sphere: sphereOf, pointSize: (o) => (o.name === 'Earth' ? 9 : 6.5), markerPx: () => 5 });
registerKind({ kind: 'moon', layer: 'planets', noun: ['moon', 'moons'], frames: { system: 'sphere', galaxy: 'marker' }, galaxyScope: 'sky', pick: { priority: 10 },
  label: { key: () => 50, max: null, hideOverDiscPx: 30 }, card: planetCard, arriveAu: radiusAu, collide: true,
  color: (o) => PLANET_RGB[o.name] || PLANET_RGB.Moon, sphere: sphereOf, pointSize: () => 4, markerPx: () => 4 });
registerKind({ ...SMALL, kind: 'dwarf_planet', layer: 'dwarfPlanets', noun: ['dwarf planet', 'dwarf planets'], color: () => [0.7, 0.72, 0.82] });
registerKind({ ...SMALL, kind: 'asteroid', layer: 'asteroids', noun: ['asteroid', 'asteroids'], color: smallColor });
registerKind({ ...SMALL, kind: 'comet', layer: 'comets', noun: ['comet', 'comets'], color: () => [0.6, 0.9, 1.0] });
// Stars stay columnar and are handled by scene3d.js; this entry gives them an id for dispatch, a priority and a noun.
registerKind({ kind: 'star', layer: null, builtin: true, noun: ['star', 'stars'], frames: { system: 'point', galaxy: 'point' }, pick: { priority: 20 } });
