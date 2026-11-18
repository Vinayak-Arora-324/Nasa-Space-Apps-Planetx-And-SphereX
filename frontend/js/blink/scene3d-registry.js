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
//   UNIT_KM                          kilometres per unit: km, au, pc, Mpc, Rearth, Rjup, Rsun
//   toAu(q) / toPc(q) -> number|null a Quantity {v, unit} in AU / parsecs (null for a missing, non-numeric or unknown unit)
//   fmtNum(v, sig = 3)               number text for cards (the same as scene3d.js's)
//   valueWithRange(q, unit, sig = 3) '134.8 pc (134.2–135.4)': more digits (up to 5) until lo and hi differ, else no interval
//   evidenceRows(rows, evidence)     drops rows whose tier is 'illustrative' when evidence is true
//
//   registerKind(spec) / kindSpec(kind) -> spec|null / kinds() -> spec[] in registration order
//   rendererOf(spec, frame, o) -> 'point'|'sphere'|'marker'|'billboard'|null   the renderer of a record in a frame:
//                                spec.frames[frame] may be a function (o) -> renderer (an exoplanet with a radius is a sphere)
//   registerLayer({id, label, group, on = true, parent = null}) / layers() -> layer[] / layerOf(kind) -> layer id|null
//                                parent: a sub-switch of another layer (clusterCandidates under clusters); the panel shows it
//                                indented and disabled while the parent is off. Groups: sky, solar, beyond.
//   defaultLayers() -> {id: bool}
//   loadLayers(storage = globalThis.localStorage) -> {id: bool}   (defaults merged with valid saved booleans; never throws)
//   saveLayers(map, storage = globalThis.localStorage)            (key 'blink.scene3d.layers'; never throws)
//
// KIND SPEC (every field below is present after registerKind; defaults in brackets)
//   kind, layer (id or null), noun [singular, plural], builtin [false]
//   frames       { system?: 'point'|'sphere'|'marker', galaxy?: ... 'billboard' }  renderer per frame, or a function (o) -> renderer
//                (use rendererOf); absent = not drawn there [{}]
//   hosted       true for records that sit in another star's system (exoplanets); their host is resolved to a star key [false]
//   galaxyScope  'sky' (all records) | 'cone' (only in_cone === true)  in the galaxy frame ['sky']
//   pick         { priority, marker? }  lower is picked first: planets and the Sun 10, stars 20, small bodies 30 [30].
//                marker: the priority while drawn as a galaxy-frame marker (small bodies 15: a marker in the Gaia cone
//                always has stars within reach, and the marker is what the viewer is pointing at)
//   label        { key(o), max, group?, hideOverDiscPx } | null.  key sorts labels (small first wins); max caps the
//                labels of a pool (kinds sharing `group`, or the kind alone); hideOverDiscPx hides the label over a disc
//   card(o, ctx) -> { title, subtitle, rows: [[label, text, tier, src]], notes }   ctx = { fromYou: string|null, evidence, fmtNum,
//                place?, hostName? }   place: the store placement (store.placement(id), with .sysAu and .orbit), hostName: the host star's name
//   go           'host-frame'  autopilot flies inside the host's system frame ['host-frame']
//   arriveAu(o)  stop distance radius, AU (spheres: the radius, points: 0)
//   collide      keep the camera outside the sphere in the system frame [false]
//   color(o)     illustrative display colour [r, g, b] 0..1
//   sphere(o, {evidence}) -> { rgb, pole: [raDeg, decDeg]|null, features: {ring, band, atm} (0|1), ext }  (sphere kinds only)
//                rgb is the display colour as in the old PLANET_RGB (not linearised); ext is the impostor quad extent
//   visible(o, {evidence, layers}) -> bool    default: hides evidence === 'illustrative' records in the Evidence view.
//                layers is the layer map; cluster candidates are hidden unless layers.clusterCandidates === true
//   markerStyle(o) -> 'hollow'|'solid'    'hollow' for derived records
//   pointSize(o)  size in px of the system-frame point (Earth 9, the Moon 4, other planets 6.5, small bodies 3)
//   markerPx(o)   size in px of the galaxy-frame marker (the Sun 6, planets 5, the Moon 4, small bodies 3, exoplanets 4)
//   arrivePc(o)   galaxy-frame trips (go 'fly-galaxy'): stop distance in pc from the record (clusters: 2 x r50) [0]
//
// PHASE 1 HELPERS
//   planetLine(o) -> { line, tier }   one line for a host star's planet list: '1.51 d . 1.12 R(earth) . 1.37 M(earth)' or
//                '4.23 d . 0.47 Mj min'; tier is the weakest tier among the quantities shown
//   clusterRgb(o) -> [r, g, b]        illustrative colour of a cluster from its age (blue young, white ~300 Myr, warm old)
//   M_EARTH_PER_MJUP = 317.828, R_EARTH_PER_RJUP = 11.209
import { KM_PER_AU } from './scene3d-math.js';
import { AU_PER_PC } from './scene3d-frames.js';

export const SCHEMA_MAJOR = 1;
export const MAX_BODY_LABELS = 12;
export const FEATURE_TIER = 'illustrative';
export const EVIDENCE_HIDES_FEATURES = false;

const PC_KM = AU_PER_PC * KM_PER_AU;
export const UNIT_KM = { km: 1, au: KM_PER_AU, pc: PC_KM, Mpc: PC_KM * 1e6, Rearth: 6371, Rjup: 71492, Rsun: 695700 };
export const M_EARTH_PER_MJUP = 317.828, R_EARTH_PER_RJUP = 11.209;
const conv = (q, per) => (q && Number.isFinite(q.v) && UNIT_KM[q.unit] ? (q.v * UNIT_KM[q.unit]) / per : null);
export const toAu = (q) => conv(q, KM_PER_AU);
export const toPc = (q) => conv(q, PC_KM);
const toKm = (q) => conv(q, 1);

export const fmtNum = (v, sig = 3) => (Number.isFinite(v) ? v.toLocaleString('en-US', { maximumSignificantDigits: sig }) : 'n/a');
export const evidenceRows = (rows, evidence) => (evidence ? rows.filter((r) => r[2] !== 'illustrative') : rows);

// ------------------------------------------------------------------ layers
const LAYER_LIST = [];
const LAYER_KEY = 'blink.scene3d.layers';
export function registerLayer({ id, label, group, on = true, parent = null }) {
  const l = { id, label, group, on: !!on, parent }, i = LAYER_LIST.findIndex((x) => x.id === id);
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
  layer: null, builtin: false, hosted: false, frames: {}, galaxyScope: 'sky', pick: { priority: 30 }, label: null, card: null, go: 'host-frame',
  arriveAu: noop, collide: false, color: () => [0.8, 0.8, 0.8], sphere: null,
  visible: (o, { evidence } = {}) => !(evidence && o.evidence === 'illustrative'),
  markerStyle: (o) => (o.evidence === 'derived' ? 'hollow' : 'solid'),
  pointSize: () => 3, markerPx: () => 3, arrivePc: noop,
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
export function rendererOf(spec, frame, o) {
  const f = spec && spec.frames ? spec.frames[frame] : null;
  return (typeof f === 'function' ? f(o) : f) || null;
}

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
// Unit labels for values the catalogue gives only as a bound (a string v such as '< 0.12'), shown verbatim.
const LIMIT_UNIT = { Mjup: 'Mj', Mearth: 'M⊕', Rjup: 'Rj', Rearth: 'R⊕', Msun: 'M☉', Rsun: 'R☉', au: 'AU', pc: 'pc', d: 'd', K: 'K', mag: 'mag', deg: '°' };
/** A catalogue bound ('< 0.12 Mj') from a Quantity whose v is a string, else null. Never turned into a number. */
const limitText = (q) => (q && typeof q.v === 'string' && /^[<>]/.test(q.v.trim()) ? `${q.v.trim()}${q.unit && LIMIT_UNIT[q.unit] ? ' ' + LIMIT_UNIT[q.unit] : ''}` : null);
function qtyRow(label, q, fmt, fallbackTier) {
  return [label, q && Number.isFinite(q.v) ? fmt(q) : limitText(q) || 'n/a', (q && q.tier) || fallbackTier, srcOf(q)];
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
/**
 * 'v unit (lo-hi)' with enough significant digits for lo and hi to read differently: 3, then 4, then 5; when they still match the
 * interval is omitted ('135 pc'). q needs finite v, lo, hi for an interval. The value uses the same digits as the interval.
 */
export function valueWithRange(q, unit = '', sig = 3) {
  const u = unit ? ` ${unit}` : '';
  if (!q || !Number.isFinite(q.lo) || !Number.isFinite(q.hi)) return `${fmtNum(q && q.v, sig)}${u}`;
  for (let d = sig; d <= 5; d++) if (fmtNum(q.lo, d) !== fmtNum(q.hi, d)) return `${fmtNum(q.v, d)}${u} (${fmtNum(q.lo, d)}–${fmtNum(q.hi, d)})`;
  return `${fmtNum(q.v, sig)}${u}`;
}

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

// ------------------------------------------------------------------ Phase 1: exoplanets and star clusters (section 16.7, 16.9)
const TIER_RANK = { measured: 0, catalogue: 1, derived: 2, inferred: 2, illustrative: 3 };
const worstTier = (tiers) => tiers.filter(Boolean).reduce((w, t) => ((TIER_RANK[t] ?? 2) > (TIER_RANK[w] ?? 2) ? t : w), 'measured');
const hasV = (q) => !!q && Number.isFinite(q.v);
const rEarth = (q) => (q.unit === 'Rjup' ? q.v * R_EARTH_PER_RJUP : q.v);
const mJup = (q) => (q.unit === 'Mearth' ? q.v / M_EARTH_PER_MJUP : q.v);
const radiusText = (q, f) => (rEarth(q) >= 6 ? `${f(rEarth(q) / R_EARTH_PER_RJUP)} Rj` : `${f(rEarth(q))} R⊕`);
const massText = (q, f) => (mJup(q) < 0.1 ? `${f(mJup(q) * M_EARTH_PER_MJUP)} M⊕` : `${f(mJup(q))} Mj`);
/** 'Chen & Kipping 2017' from a src such as 'NEA pscomppars: archive-calculated from mass (Chen & Kipping 2017)'; null if none. */
const relationOf = (q) => { const m = q && /archive-calculated from (mass|radius) \(([^)]+)\)/.exec(q.src || ''); return m ? { from: m[1], rel: m[2] } : null; };
const hasRadius = (o) => hasV(o.size && o.size.radius);
const radiusClassRgb = (o) => {   // illustrative colour by size class (Earth radii)
  if (!hasRadius(o)) return [0.8, 0.8, 0.8];
  const r = rEarth(o.size.radius);
  return r < 1.25 ? [0.72, 0.64, 0.58] : r < 2 ? [0.6, 0.68, 0.78] : r < 4 ? [0.55, 0.75, 0.85] : r < 6 ? [0.4, 0.6, 0.95] : [0.9, 0.78, 0.6];
};

/** One line for a host star's planet list, with the weakest tier among the quantities shown. */
export function planetLine(o, fmt = fmtNum) {
  const el = (o.position && o.position.elements) || {}, parts = [], tiers = [];
  const P = el.period_d, a = el.a_au, r = o.size && o.size.radius, m = prop(o, 'mass'), ms = prop(o, 'msini');
  if (hasV(P)) { parts.push(`${fmt(P.v)} d`); tiers.push(P.tier); } else if (hasV(a)) { parts.push(`${fmt(a.v)} AU`); tiers.push(a.tier); }
  if (hasV(r)) { parts.push(radiusText(r, fmt)); tiers.push(r.tier); } else if (limitText(r)) { parts.push(limitText(r)); tiers.push(r.tier); }
  if (hasV(m)) { parts.push(massText(m, fmt)); tiers.push(m.tier); } else if (limitText(m)) { parts.push(limitText(m)); tiers.push(m.tier); }
  else if (hasV(ms)) { parts.push(`${massText(ms, fmt)} min`); tiers.push(ms.tier); } else if (limitText(ms)) { parts.push(`${limitText(ms)} min`); tiers.push(ms.tier); }
  return { line: parts.join(' · '), tier: worstTier(tiers) };
}

function exoplanetCard(o, ctx) {
  const f = num(ctx), el = (o.position && o.position.elements) || {}, place = ctx.place || null, orb = place && place.orbit;
  const P = el.period_d, a = el.a_au, e = el.e, inc = el.i_deg, cat = (o.provenance && o.provenance.catalogue) || null;
  const rows = [['Host star', ctx.hostName || o.host || 'n/a', 'catalogue', cat]];
  rows.push(qtyRow('Orbital period', P, (q) => `${f(q.v)} d`, 'measured'));
  rows.push(qtyRow('Semi-major axis', a, (q) => `${f(q.v)} AU`, 'catalogue'));
  const assumedE = orb ? orb.assumed.ecc : !hasV(e) || e.tier === 'illustrative';
  rows.push(assumedE ? ['Eccentricity', `${hasV(e) ? f(e.v) : '0'} (assumed)`, 'illustrative', (e && e.src) || 'assumed circular (no eccentricity in the archive)']
    : qtyRow('Eccentricity', e, (q) => f(q.v), 'measured'));
  rows.push(hasV(inc) ? qtyRow('Inclination', inc, (q) => `${f(q.v)}°`, 'measured')
    : ['Inclination', orb ? `unknown · drawn at ${Math.round(orb.used.incl)}°` : 'unknown', 'illustrative', 'assumed: 90° if it transits, else one random draw shared by the planets of this system']);
  const mass = prop(o, 'mass'), msini = prop(o, 'msini');
  if (hasV(msini) && !hasV(mass)) rows.push(qtyRow('Minimum mass (M sin i)', msini, (q) => massText(q, f), 'measured'));
  else {
    const rel = relationOf(mass);
    const label = rel ? `Mass (from ${rel.from}, ${rel.rel})` : mass && mass.tier === 'inferred' ? 'Mass (inferred)' : 'Mass';
    rows.push(qtyRow(label, mass, (q) => massText(q, f), 'measured'));
  }
  const rad = o.size && o.size.radius, relR = relationOf(rad);
  rows.push(qtyRow(relR ? `Radius (from ${relR.from}, ${relR.rel})` : rad && rad.tier === 'inferred' ? 'Radius (inferred)' : 'Radius', rad, (q) => radiusText(q, f), 'measured'));
  const m = prop(o, 'disc_method'), y = prop(o, 'disc_year'), fa = prop(o, 'disc_facility');
  const disc = [m && m.v, y && y.v, fa && fa.v].filter((v) => v != null && v !== '').join(', ');
  rows.push(['Discovered', disc || 'n/a', (m && m.tier) || 'catalogue', srcOf(m)]);
  if (place && place.sysAu) rows.push(['From its star now', `${f(hypot3(place.sysAu))} AU`, 'illustrative', 'where it is drawn on its orbit is illustrative']);
  rows.push(...fromYouRow(ctx));
  const notes = [];
  if (!hasV(el.node_deg)) notes.push('Where it is drawn on its orbit is illustrative: the orbit\'s orientation on the sky is not known.');
  if (orb) {
    const sg = orb.phaseSigmaDeg, tj = hasV(el.t_conj_mjd) ? el.t_conj_mjd.v : null, tp = hasV(el.t_peri_mjd) ? el.t_peri_mjd.v : null;
    const year = (mjd) => Math.round(2000 + (mjd - 51544.5) / 365.25);
    if (orb.phaseSource === 'assumed') notes.push('Its place along the orbit is unknown, so an assumed phase is drawn.');
    else {
      const what = orb.phaseSource === 'conjunction' ? `${year(tj)} ${m && m.v === 'Transit' ? 'transit' : 'conjunction'} time` : `${year(tp)} periastron time`;
      if (sg != null && sg > 90) notes.push(`Phase from the ${what}, but it is effectively unknown at this date.`);
      else notes.push(`Phase from the ${what}${sg != null ? `, ±${f(sg)}° today` : ''}.`);
    }
  }
  const c = prop(o, 'controversial');
  if (c && c.v) notes.push('The NASA Exoplanet Archive flags this planet as controversial.');
  return finish(ctx, { title: o.name, subtitle: 'Exoplanet', rows, notes: notes.length ? notes : null });
}

const ageGyr = (o) => { const q = prop(o, 'age'); return hasV(q) ? q.v : null; };
// Age stops (Gyr -> rgb), interpolated in log age: blue under 30 Myr, white near 300 Myr, warm over 1 Gyr.
const AGE_STOPS = [[0.01, [0.6, 0.75, 1.0]], [0.03, [0.72, 0.84, 1.0]], [0.3, [1.0, 1.0, 1.0]], [1, [1.0, 0.92, 0.78]], [3, [1.0, 0.8, 0.55]]];
export function clusterRgb(o) {
  const g = ageGyr(o);
  if (g == null || g <= 0) return [0.9, 0.9, 0.95];
  const x = Math.log10(g), S = AGE_STOPS, lx = (i) => Math.log10(S[i][0]);
  if (x <= lx(0)) return S[0][1].slice();
  if (x >= lx(S.length - 1)) return S[S.length - 1][1].slice();
  let i = 0; while (x > lx(i + 1)) i++;
  const k = (x - lx(i)) / (lx(i + 1) - lx(i));
  return S[i][1].map((v, c) => v + (S[i + 1][1][c] - v) * k);
}

function clusterCard(o, ctx) {
  const f = num(ctx), p = o.position || {}, d = p.dist, r = o.size && o.size.radius;
  const rows = [];
  rows.push(qtyRow('Distance (cluster parallax)', d, (q) => valueWithRange(q, 'pc'), 'measured'));
  const n = prop(o, 'n_members'); rows.push(qtyRow('Members', n, (q) => f(q.v), 'catalogue'));
  rows.push(qtyRow('Radius (r50)', r, (q) => `${f(toPc(q) ?? q.v)} pc`, 'catalogue'));
  const age = prop(o, 'age'); rows.push(qtyRow('Age', age, (q) => (q.v < 0.1 ? `${f(q.v * 1000)} Myr` : `${f(q.v)} Gyr`), 'inferred'));
  const ext = prop(o, 'extinction'); rows.push(qtyRow('Extinction (A_V)', ext, (q) => `${f(q.v)} mag`, 'inferred'));
  const ty = prop(o, 'type'); if (ty) rows.push(['Type', ty.v, ty.tier || 'catalogue', srcOf(ty)]);
  const qu = prop(o, 'quality'); if (qu) rows.push(['Quality', qu.v, qu.tier || 'catalogue', srcOf(qu)]);
  const cls = prop(o, 'class') || prop(o, 'bound');
  if (cls) rows.push(['Class', typeof cls.v === 'boolean' ? (cls.v ? 'bound cluster' : 'moving group') : String(cls.v), cls.tier || 'catalogue', srcOf(cls)]);
  const mass = prop(o, 'mass'); if (hasV(mass)) rows.push(['Mass', `${f(mass.v)} ${mass.unit === 'Msun' || !mass.unit ? 'M☉' : mass.unit}`, mass.tier || 'inferred', srcOf(mass)]);
  rows.push(...fromYouRow(ctx));
  const notes = [];
  if ((d && d.tier === 'inferred') || o.evidence === 'derived') notes.push('The distance is prior-dominated (parallax S/N < 5), so the cluster is drawn as a hollow marker.');
  if (qu && qu.v === 'candidate') notes.push('Candidate: it does not pass the catalogue\'s reliability cut and may not be a real cluster.');
  return finish(ctx, { title: o.name, subtitle: 'Star cluster', rows, notes: notes.length ? notes : null });
}
const clusterMembers = (o) => { const n = prop(o, 'n_members'); return hasV(n) ? n.v : 0; };

registerLayer({ id: 'mw', label: 'Milky Way glow', group: 'sky' });
registerLayer({ id: 'cone', label: 'Cone outline', group: 'sky' });
registerLayer({ id: 'starNames', label: 'Star names', group: 'sky' });
registerLayer({ id: 'planets', label: 'Planets and the Moon', group: 'solar' });
registerLayer({ id: 'orbits', label: 'Orbits', group: 'solar' });
registerLayer({ id: 'dwarfPlanets', label: 'Dwarf planets', group: 'solar' });
registerLayer({ id: 'asteroids', label: 'Asteroids', group: 'solar' });
registerLayer({ id: 'comets', label: 'Comets', group: 'solar' });

registerLayer({ id: 'exoplanets', label: 'Exoplanets', group: 'beyond' });
registerLayer({ id: 'clusters', label: 'Star clusters', group: 'beyond' });
registerLayer({ id: 'clusterCandidates', label: 'Include candidates', group: 'beyond', on: false, parent: 'clusters' });

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
registerKind({ kind: 'exoplanet', layer: 'exoplanets', noun: ['exoplanet', 'exoplanets'], hosted: true,
  frames: { system: (o) => (hasRadius(o) ? 'sphere' : 'point'), galaxy: 'marker' }, galaxyScope: 'cone', pick: { priority: 10, marker: 15 },
  label: { key: () => 20, max: 12, hideOverDiscPx: 30 }, card: exoplanetCard, arriveAu: radiusAu, collide: true, color: radiusClassRgb,
  sphere: (o) => ({ rgb: radiusClassRgb(o), pole: null, features: { ring: 0, band: 0, atm: 0 }, ext: 1.1 }), pointSize: () => 4, markerPx: () => 4 });
registerKind({ kind: 'cluster', layer: 'clusters', noun: ['star cluster', 'star clusters'], frames: { galaxy: 'billboard' }, galaxyScope: 'cone',
  pick: { priority: 25, marker: 16 }, label: { key: (o) => -clusterMembers(o), max: 12, hideOverDiscPx: null }, card: clusterCard, go: 'fly-galaxy',
  arrivePc: (o) => 2 * (toPc(o.size && o.size.radius) || 0), color: clusterRgb, markerPx: () => 4,
  visible: (o, { evidence, layers } = {}) => !(evidence && o.evidence === 'illustrative')
    && !(prop(o, 'quality') && prop(o, 'quality').v === 'candidate' && !(layers && layers.clusterCandidates === true)) });
// Stars stay columnar and are handled by scene3d.js; this entry gives them an id for dispatch, a priority and a noun.
registerKind({ kind: 'star', layer: null, builtin: true, noun: ['star', 'stars'], frames: { system: 'point', galaxy: 'point' }, pick: { priority: 20 } });
