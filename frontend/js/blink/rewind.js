// Whole-sky rewind ("turn back the sky"). Turns the SPHEREx all-sky map into the sky above a place on a chosen
// night, with an animated whirl back (or forward) through the years.
//
// The map itself is moved only by frame rotations, which are exact for it: the camera centre and view rotation
// are set each frame so that Aladin shows the horizon view of the place, for precession (Vondrak 2011) and Earth
// rotation. Stars that move against the others are drawn from the XHIP catalogue on the overlay, because the map
// is a snapshot of where they were in 2025. On top go the 88 constellations (figures tied to their stars, names,
// IAU boundaries), named galaxies and nebulae, the Sun, Moon and planets, and the colour of the sky for the
// Sun's altitude. Astronomy is in skytime.js and ephem.js; sky brightness and labels in rewind-sky.js.
import * as T from './skytime.js';
import * as E from './ephem.js';
import * as S from './rewind-sky.js';
import { clamp, smooth, lerp, lerpLog, wrap360, el } from './util.js';
import { reduceMotion } from './fly.js';

const D2R = Math.PI / 180, TAU = 2 * Math.PI;
export const MAP_EPOCH = 2025.5;     // SPHEREx all-sky survey: the map shows each star where it was then
export const YEAR_MIN = -14999, YEAR_MAX = 15000;   // 15,000 BCE (astronomical year -14999) to 15,000 CE
const ENTER_S = 2.0, LAND_S = 1.6, LEAVE_S = 1.4;
const TRAIL_V = 3.6, LABEL_V = 1.6, MOVER_MIN_DEG = 0.25, MOVER_MAX = 140;
const ALWAYS_LABEL = new Set([11767, 68756, 72607, 87937]);   // Polaris, Thuban, Kochab, Barnard's Star
const SIDEREAL = 1.00273781191135448;

// Grouped by region in the place picker; `custom` (no region) goes last.
export const PLACES = [
  { id: 'giza', region: 'Africa', label: 'Giza, Egypt', lat: 29.9792, lon: 31.1342 },
  { id: 'karnak', region: 'Africa', label: 'Karnak, Luxor', lat: 25.7188, lon: 32.6573 },
  { id: 'alexandria', region: 'Africa', label: 'Alexandria, Egypt', lat: 31.2001, lon: 29.9187 },
  { id: 'carthage', region: 'Africa', label: 'Carthage, Tunisia', lat: 36.8528, lon: 10.3233 },
  { id: 'aksum', region: 'Africa', label: 'Aksum, Ethiopia', lat: 14.1306, lon: 38.7189 },

  { id: 'gaza', region: 'Levant', label: 'Gaza City', lat: 31.5017, lon: 34.4668 },
  { id: 'jerusalem', region: 'Levant', label: 'Jerusalem', lat: 31.7780, lon: 35.2354 },
  { id: 'bethlehem', region: 'Levant', label: 'Bethlehem', lat: 31.7043, lon: 35.2077 },
  { id: 'nazareth', region: 'Levant', label: 'Nazareth', lat: 32.7022, lon: 35.2978 },
  { id: 'jericho', region: 'Levant', label: 'Jericho', lat: 31.8710, lon: 35.4440 },
  { id: 'ramla', region: 'Levant', label: 'Ramla', lat: 31.9275, lon: 34.8625 },
  { id: 'ramallah', region: 'Levant', label: 'Ramallah', lat: 31.9038, lon: 35.2034 },
  { id: 'beirut', region: 'Levant', label: 'Beirut', lat: 33.8938, lon: 35.5018 },
  { id: 'tyre', region: 'Levant', label: 'Tyre', lat: 33.2705, lon: 35.2038 },
  { id: 'damascus', region: 'Levant', label: 'Damascus', lat: 33.5116, lon: 36.3066 },
  { id: 'aleppo', region: 'Levant', label: 'Aleppo', lat: 36.1993, lon: 37.1625 },
  { id: 'palmyra', region: 'Levant', label: 'Palmyra', lat: 34.5510, lon: 38.2690 },
  { id: 'antioch', region: 'Levant', label: 'Antioch (Antakya)', lat: 36.2025, lon: 36.1606 },
  { id: 'petra', region: 'Levant', label: 'Petra, Jordan', lat: 30.3285, lon: 35.4444 },

  { id: 'istanbul', region: 'Anatolia', label: 'Istanbul (Constantinople)', lat: 41.0086, lon: 28.9802 },
  { id: 'nicaea', region: 'Anatolia', label: 'Nicaea (İznik)', lat: 40.4292, lon: 29.7211 },
  { id: 'troy', region: 'Anatolia', label: 'Troy', lat: 39.9575, lon: 26.2389 },
  { id: 'ephesus', region: 'Anatolia', label: 'Ephesus', lat: 37.9411, lon: 27.3419 },
  { id: 'tarsus', region: 'Anatolia', label: 'Tarsus', lat: 36.9177, lon: 34.8928 },
  { id: 'gobeklitepe', region: 'Anatolia', label: 'Göbekli Tepe', lat: 37.2231, lon: 38.9225 },

  { id: 'mecca', region: 'Middle East', label: 'Mecca', lat: 21.4225, lon: 39.8262 },
  { id: 'babylon', region: 'Middle East', label: 'Babylon', lat: 32.5422, lon: 44.4209 },
  { id: 'ur', region: 'Middle East', label: 'Ur', lat: 30.9626, lon: 46.1031 },
  { id: 'nineveh', region: 'Middle East', label: 'Nineveh (Mosul)', lat: 36.3594, lon: 43.1528 },
  { id: 'baghdad', region: 'Middle East', label: 'Baghdad', lat: 33.3152, lon: 44.3661 },
  { id: 'persepolis', region: 'Middle East', label: 'Persepolis', lat: 29.9355, lon: 52.8916 },
  { id: 'tehran', region: 'Middle East', label: 'Tehran', lat: 35.6892, lon: 51.3890 },
  { id: 'samarkand', region: 'Middle East', label: 'Samarkand (Ulugh Beg Observatory)', lat: 39.6747, lon: 67.0057 },

  { id: 'delhi', region: 'South Asia', label: 'Delhi', lat: 28.6139, lon: 77.2090 },
  { id: 'ujjain', region: 'South Asia', label: 'Ujjain', lat: 23.1765, lon: 75.7885 },
  { id: 'varanasi', region: 'South Asia', label: 'Varanasi', lat: 25.3176, lon: 82.9739 },
  { id: 'lahore', region: 'South Asia', label: 'Lahore', lat: 31.5204, lon: 74.3587 },
  { id: 'amritsar', region: 'South Asia', label: 'Amritsar', lat: 31.6200, lon: 74.8765 },
  { id: 'hyderabad', region: 'South Asia', label: 'Hyderabad, India', lat: 17.3850, lon: 78.4867 },
  { id: 'chennai', region: 'South Asia', label: 'Chennai', lat: 13.0827, lon: 80.2707 },
  { id: 'dhaka', region: 'South Asia', label: 'Dhaka', lat: 23.8103, lon: 90.4125 },

  { id: 'beijing', region: 'East Asia', label: 'Beijing', lat: 39.9163, lon: 116.3972 },
  { id: 'xian', region: 'East Asia', label: "Xi'an (Chang'an)", lat: 34.3416, lon: 108.9398 },
  { id: 'shanghai', region: 'East Asia', label: 'Shanghai', lat: 31.2304, lon: 121.4737 },
  { id: 'ulaanbaatar', region: 'East Asia', label: 'Ulaanbaatar', lat: 47.8864, lon: 106.9057 },

  { id: 'athens', region: 'Europe', label: 'Athens', lat: 37.9715, lon: 23.7257 },
  { id: 'sparta', region: 'Europe', label: 'Sparta', lat: 37.0755, lon: 22.4303 },
  { id: 'corinth', region: 'Europe', label: 'Corinth', lat: 37.9058, lon: 22.8786 },
  { id: 'delphi', region: 'Europe', label: 'Delphi', lat: 38.4824, lon: 22.5010 },
  { id: 'knossos', region: 'Europe', label: 'Knossos, Crete', lat: 35.2981, lon: 25.1631 },
  { id: 'rome', region: 'Europe', label: 'Rome', lat: 41.8902, lon: 12.4922 },
  { id: 'pompeii', region: 'Europe', label: 'Pompeii', lat: 40.7489, lon: 14.4848 },
  { id: 'sicily', region: 'Europe', label: 'Syracuse, Sicily', lat: 37.0755, lon: 15.2866 },
  { id: 'tirana', region: 'Europe', label: 'Tirana', lat: 41.3275, lon: 19.8187 },
  { id: 'barcelona', region: 'Europe', label: 'Barcelona', lat: 41.3874, lon: 2.1686 },
  { id: 'london', region: 'Europe', label: 'London (Greenwich)', lat: 51.4779, lon: -0.0015 },
  { id: 'stonehenge', region: 'Europe', label: 'Stonehenge', lat: 51.1789, lon: -1.8262 },
  { id: 'kyiv', region: 'Europe', label: 'Kyiv', lat: 50.4501, lon: 30.5234 },
  { id: 'moscow', region: 'Europe', label: 'Moscow', lat: 55.7539, lon: 37.6208 },
  { id: 'stpetersburg', region: 'Europe', label: 'St Petersburg', lat: 59.9343, lon: 30.3351 },

  { id: 'newyork', region: 'Americas', label: 'New York', lat: 40.7128, lon: -74.0060 },
  { id: 'alaska', region: 'Americas', label: 'Fairbanks, Alaska', lat: 64.8378, lon: -147.7164 },
  { id: 'havana', region: 'Americas', label: 'Havana, Cuba', lat: 23.1136, lon: -82.3666 },
  { id: 'cancun', region: 'Americas', label: 'Cancún', lat: 21.1619, lon: -86.8515 },
  { id: 'chichen', region: 'Americas', label: 'Chichén Itzá', lat: 20.6843, lon: -88.5678 },
  { id: 'teotihuacan', region: 'Americas', label: 'Teotihuacan', lat: 19.6925, lon: -98.8438 },
  { id: 'cusco', region: 'Americas', label: 'Cusco', lat: -13.5320, lon: -71.9675 },
  { id: 'rio', region: 'Americas', label: 'Rio de Janeiro', lat: -22.9068, lon: -43.1729 },

  { id: 'maunakea', region: 'Pacific', label: 'Maunakea, Hawaiʻi', lat: 19.8207, lon: -155.4681 },
  { id: 'honolulu', region: 'Pacific', label: 'Honolulu, Hawaiʻi', lat: 21.3069, lon: -157.8583 },
  { id: 'easterisland', region: 'Pacific', label: 'Easter Island (Rapa Nui)', lat: -27.1127, lon: -109.3497 },
  { id: 'sydney', region: 'Pacific', label: 'Sydney', lat: -33.8568, lon: 151.2153 },

  { id: 'mcmurdo', region: 'Antarctica', label: 'McMurdo Station, Antarctica', lat: -77.8463, lon: 166.6682 },

  { id: 'custom', label: 'Somewhere else…' },
];

// Asterisms as polylines of Hipparcos numbers: drawn only if the constellation file (rewind-sky.json) fails to load.
const ASTERISMS = [
  [[67301, 65378, 62956, 59774, 58001, 53910, 54061, 59774]],                          // Big Dipper
  [[11767, 85822, 82080, 77055, 72607, 75097, 79822, 77055]],                          // Little Dipper
  [[27989, 25336, 25930, 26311, 26727, 27989], [26727, 27366], [25930, 24436]],        // Orion
  [[746, 3179, 4427, 6686, 8886]],                                                      // Cassiopeia
  [[60718, 61084], [62434, 59747]],                                                     // Southern Cross
];
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const wrap180 = (a) => { const x = wrap360(a); return x > 180 ? x - 360 : x; };
const wrapPi = (a) => { const x = ((a % TAU) + TAU) % TAU; return x > Math.PI ? x - TAU : x; };
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeInOutCubicD = (t) => (t < 0.5 ? 12 * t * t : 3 * (-2 * t + 2) ** 2);
const pad2 = (n) => String(n).padStart(2, '0');
const dirName = (az) => CARDINALS[Math.round(wrap360(az) / 45) % 8];
function slerp(a, b, t) {
  const w = T.angleBetween(a, b) * D2R;
  if (w < 1e-9) return b;
  const s = Math.sin(w), ka = Math.sin((1 - t) * w) / s, kb = Math.sin(t * w) / s;
  return [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];
}

const BV_STOPS = [[-0.4, [155, 176, 255]], [0, [202, 215, 255]], [0.4, [248, 247, 255]], [0.8, [255, 244, 234]], [1.2, [255, 214, 166]], [2.0, [255, 176, 118]]];
function bvColor(bv) {
  const x = clamp(bv ?? 0.6, -0.4, 2.0);
  for (let i = 1; i < BV_STOPS.length; i++) {
    const [b, c] = BV_STOPS[i], [a, p] = BV_STOPS[i - 1];
    if (x <= b) { const t = (x - a) / (b - a); return p.map((v, k) => Math.round(v + (c[k] - v) * t)); }
  }
  return BV_STOPS[BV_STOPS.length - 1][1];
}

/**
 * UT Julian Day of a local mean solar time at longitude lon (degrees east). The mean Sun moves along the
 * equator with TT, so with Delta T hours long it would no longer cross the meridian at UT noon; the small
 * shift (0.0027379 Delta T, 41 minutes by 15,000 BCE) keeps clock noon the mean Sun's noon in every era.
 */
export function jdFromLocal({ year, month, day, hour, minute }, lon) {
  const jd = T.jdFromCalendar(year, month, day + (hour + minute / 60 - lon / 15) / 24);
  return jd + (SIDEREAL - 1) * T.deltaT(year + (month - 0.5) / 12) / 86400;
}

const SEASONS = ['March equinox', 'June solstice', 'September equinox', 'December solstice'];
/** Where the Sun is in its year, from its ecliptic longitude of date: "12 days after the June solstice". */
export function seasonText(lon) {
  const k = Math.floor(wrap360(lon) / 90), after = (wrap360(lon) - 90 * k) / 0.9856, before = (90 * (k + 1) - wrap360(lon)) / 0.9856;
  const n = (d) => `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`;
  if (after < 0.5) return `the day of the ${SEASONS[k]}`;
  if (before < 0.5) return `the day of the ${SEASONS[(k + 1) % 4]}`;
  return after <= before ? `${n(after)} after the ${SEASONS[k]}` : `${n(before)} before the ${SEASONS[(k + 1) % 4]}`;
}
/** Words for the HUD and screen readers: daylight, the Moon, the season, visible planets, and how sure we are. */
export function skyLines(b) {
  const h = b.sun.alt, tw = S.twilight(h), when = b.sun.az < 180 ? 'morning' : 'evening';
  const light = tw === 'day' ? `Daytime, the Sun ${Math.max(0, Math.round(h))}° up in the ${dirName(b.sun.az)}`
    : tw === 'night' ? 'Night' : `${when[0].toUpperCase()}${when.slice(1)} ${tw}`;
  const m = b.moon, pct = Math.round(m.k * 100);
  const moon = pct < 2 ? (m.alt > 0 ? 'New Moon up' : 'New Moon')
    : m.alt > 0 ? `Moon ${pct}% lit, ${m.waxing ? 'waxing' : 'waning'}, ${Math.round(m.alt)}° up in the ${dirName(m.az)}`
      : `Moon ${pct}% lit, below the horizon`;
  const L = b.light, up = b.planets.filter((p) => p.alt > 2 && p.mag < L.mlim + 0.5 && p.mag < 6).map((p) => p.name);
  const season = seasonText(b.sun.lon);
  const parts = [light, moon, `Sun ${season}`];
  if (b.sun.eclipse && h > -0.83) {
    const what = { total: 'A total eclipse of the Sun', annular: 'An annular eclipse of the Sun', partial: 'A partial eclipse of the Sun' }[b.sun.eclipse];
    parts.splice(1, 0, m.sig > 0.25 ? `${what}, if the Moon is where it is drawn` : what);
  }
  if (up.length) parts.push(`${up.join(', ')} up`);
  const caveat = m.sig > 1 ? `The Moon could be about ${m.sig < 10 ? m.sig.toFixed(0) : Math.round(m.sig)}° either side of where it is drawn (dotted): how fast Earth spun that long ago is not known precisely.` : '';
  return { text: parts.join(' · '), spoken: `${parts.join('. ')}.`, caveat };
}

/** Checks a requested date; returns an error message or ''. */
export function checkWhen(w) {
  if (!Number.isInteger(w.year) || w.year < YEAR_MIN || w.year > YEAR_MAX) return `Pick a year between ${T.fmtYear(YEAR_MIN)} and ${T.fmtYear(YEAR_MAX)}.`;
  if (!Number.isInteger(w.day) || w.day < 1 || w.day > T.daysInMonth(w.year, w.month)) return `${T.MONTHS[w.month - 1]} ${T.fmtYear(w.year)} has ${T.daysInMonth(w.year, w.month)} days.`;
  if (w.year === 1582 && w.month === 10 && w.day > 4 && w.day < 15) return '5–14 October 1582 never happened: those days were skipped when the Gregorian calendar began.';
  if (!(w.hour >= 0 && w.hour < 24) || !(w.minute >= 0 && w.minute < 60)) return 'Type the time as HH:MM, for example 22:00.';
  return '';
}

export class Rewind {
  /** sphere: Sphere; input: element that takes pointer input while active; hud: { box, year, sub, legend, live }. */
  constructor({ sphere, input, hud, onChange }) {
    this.sphere = sphere; this.input = input; this.hud = hud; this.onChange = onChange || (() => {});
    this.mode = 'off'; this.t = 0; this.conv = null;
    this.stars = null; this.loading = null; this.movers = [];
    this.cam = { az: 0, alt: 20, fov: 110 };
    this.place = null; this.when = null; this.jd = null; this.M = null; this.epj = MAP_EPOCH;
    this.groundA = 0; this.overlayA = 0; this.trailA = 0; this.speed = 0; this.cursor = null;
    this.trail = document.createElement('canvas'); this.tctx = this.trail.getContext('2d');
    this.circle = null; this._hudText = '';
    this.layers = S.loadLayers(); this.sky = null; this.b0 = null; this.b1 = null; this.light = null;
    this._pos = { epj: NaN, map: new Map() };
    this._bindInput();
  }
  /** Switches a sky layer (see LAYERS in rewind-sky.js) and remembers the choice. */
  setLayer(id, on) { this.layers[id] = !!on; S.saveLayers(this.layers); }
  get active() { return this.mode !== 'off'; }
  get landed() { return this.mode === 'landed'; }
  get busy() { return this.mode === 'enter' || this.mode === 'spin' || this.mode === 'leave'; }

  // ------------------------------------------------------------------ data
  loadStars() {
    if (!this.loading) {
      const get = (url, what) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${what}: HTTP ${r.status}`); return r.json(); });
      // the constellations are optional: without them the sky still turns, with a few asterisms
      const sky = get('data/rewind-sky.json', 'constellations').catch((e) => { this.skyErr = e; return null; });
      this.loading = Promise.all([get('data/rewind-stars.json', 'star list'), sky])
        .then(([d, k]) => this._ingest(d, k))
        .catch((e) => { this.loading = null; throw e; });
    }
    return this.loading;
  }
  _ingest(d, sky) {
    const list = [], byHip = new Map();
    const add = (rows, epoch, names) => {
      for (const [hip, ra, dec, pmra, pmdec, plx, rv, v, bv] of rows) {
        if (byHip.has(hip)) continue;
        const s = { hip, v, bv, rgb: bvColor(bv), name: names[hip] || null, st: T.makeStar(ra, dec, pmra, pmdec, plx, rv, epoch) };
        list.push(s); byHip.set(hip, s);
      }
    };
    add(d.stars, d.epoch, d.names);
    if (sky) {
      add(sky.extraStars, sky.starEpoch, sky.starNames);
      for (const [hip, name] of Object.entries(sky.starNames)) { const s = byHip.get(+hip); if (s && !s.name) s.name = name; }
    }
    this.stars = list;
    this.trailStars = list.filter((s) => s.v < TRAIL_V);
    this.named = list.filter((s) => s.name).sort((a, b) => a.v - b.v);
    this.asterisms = ASTERISMS.map((g) => g.map((line) => line.map((h) => byHip.get(h)).filter(Boolean)));
    if (sky) this._ingestSky(sky, byHip);
    T.cioLocator(2000);   // builds the CIO-locator table now (~0.1 s), not in the first animation frame
  }
  _ingestSky(sky, byHip) {
    const figures = new Map();
    for (const [id, lines] of Object.entries(sky.figures)) figures.set(id, lines.map((l) => l.map((h) => byHip.get(h)).filter(Boolean)));
    // a label rides with its constellation: it moves by the mean motion of the figure's stars
    const cons = sky.constellations.map((c) => {
      const stars = [...new Set((figures.get(c.abbr) || []).flat())];
      return { ...c, v: T.vecFromRaDec(c.ra, c.dec), stars, ref: null };
    });
    const dsos = sky.dsos.map((o) => ({ ...o, v: T.vecFromRaDec(o.ra, o.dec), stars: o.hip && byHip.get(o.hip) ? [byHip.get(o.hip)] : [], ref: null }));
    const borders = sky.boundaries.map((b) => { const pts = []; for (let i = 0; i < b.length; i += 2) pts.push(T.vecFromRaDec(b[i], b[i + 1])); return pts; });
    this.sky = { figures: [...figures.values()], cons, dsos, borders };
  }
  /** Where a star is at the shown epoch, cached while the epoch holds still. */
  _at(s) {
    const c = this._pos;
    if (c.epj !== this.epj) { c.epj = this.epj; c.map.clear(); }
    let v = c.map.get(s);
    if (!v) { v = T.starAt(s.st, this.epj).v; c.map.set(s, v); }
    return v;
  }
  /** A label point carried along by the mean motion of its stars since J2000. */
  _drift(o) {
    if (!o.stars.length) return o.v;
    if (!o.ref) { o.ref = [0, 0, 0]; for (const s of o.stars) { const v = T.starAt(s.st, 2000).v; o.ref = o.ref.map((x, i) => x + v[i] / o.stars.length); } }
    if (o.at !== this.epj) {
      const m = [0, 0, 0];
      for (const s of o.stars) { const v = this._at(s); for (let i = 0; i < 3; i++) m[i] += v[i] / o.stars.length; }
      const u = [o.v[0] + m[0] - o.ref[0], o.v[1] + m[1] - o.ref[1], o.v[2] + m[2] - o.ref[2]], n = Math.hypot(...u);
      o.cur = [u[0] / n, u[1] / n, u[2] / n]; o.at = this.epj;
    }
    return o.cur;
  }

  /**
   * Sun, Moon and planets for a sky state, seen from the place: ICRS unit vectors, altitudes, the Moon's phase
   * and, far from today, the stretch of its orbit it could be on given how uncertain Delta T is.
   */
  _bodies(s) {
    const lat = this.place.lat, M = T.horizonMatrix(s.prec, s.theta, lat), zen = T.mtxv(M, [0, 0, 1]);
    const ss = E.solarSystem(s.jdTt), alt = (v) => Math.asin(clamp(T.mxv(M, v)[2], -1, 1)) / D2R;
    const moon = E.moonTopocentric(ss.moon.p, ss.sun.p, zen);
    const basis = E.eclipticBasis(s.epj), elong = wrap360(E.eclipticLongitude(moon.v, basis) - ss.sun.lon);
    const y = s.epj, sigH = T.deltaTSigma(y) / 3600, sig = Math.hypot(0.55 * sigH, 2 * (Math.abs(y - 2000) / 12000) ** 3);
    let arc = null;
    if (sig > 1) {   // positions the Moon would have if Earth's clock were off by up to one sigma of Delta T, plus model error
      const span = sig / 0.55 / 24, off = moon.v.map((x, i) => x - ss.moon.v[i]);   // topocentric shift
      arc = [];
      for (let k = -6; k <= 6; k++) {
        const g = E.moonGeocentric(s.jdTt + span * k / 6, basis), n = Math.hypot(...g);
        arc.push([g[0] / n + off[0], g[1] / n + off[1], g[2] / n + off[2]]);
      }
    }
    const sunAlt = alt(ss.sun.v), moonAlt = alt(moon.v);
    // the Sun's apparent radius (959.6" at 1 au) and, when the Moon's disc reaches it, what kind of eclipse
    const sunR = 959.63 / 3600 / Math.hypot(...ss.sun.p), sep = T.angleBetween(moon.v, ss.sun.v);
    let eclipse = null;
    if (sep < sunR + moon.radius && sunAlt > -1) {
      eclipse = sep < moon.radius - sunR ? 'total' : sep < sunR - moon.radius ? 'annular' : 'partial';
    }
    return {
      sun: { v: ss.sun.v, alt: sunAlt, az: T.altAzFromVec(T.mxv(M, ss.sun.v)).az, lon: ss.sun.lon, radius: sunR, eclipse },
      moon: { ...moon, alt: moonAlt, az: T.altAzFromVec(T.mxv(M, moon.v)).az, waxing: elong < 180, sig, arc },
      planets: ss.planets.map((p) => ({ ...p, alt: alt(p.v) })),
      light: S.skyLight(sunAlt, moonAlt, moon.k),
    };
  }

  // ------------------------------------------------------------------ camera
  /** Learns Aladin's rotation convention (sign and handedness) from the live view, once. */
  _calibrate() {
    const sp = this.sphere, cam = sp.readCamera(), keepRot = sp.rot || 0;
    const ra = cam.ra, dec = clamp(cam.dec, -60, 60);
    sp.setCamera(ra, dec, Math.min(cam.fov, 60));
    const ang = (r2, d2) => {
      const a = sp.world2screen(ra, dec), b = sp.world2screen(r2, d2);
      return a && b ? Math.atan2(b.x - a.x, -(b.y - a.y)) / D2R : null;
    };
    sp.setRotation(0);
    const n0 = ang(ra, dec + 1), e0 = ang(ra + 1 / Math.cos(dec * D2R), dec);
    sp.setRotation(40);
    const n1 = ang(ra, dec + 1);
    sp.setRotation(keepRot); sp.setCamera(cam.ra, cam.dec, cam.fov);
    if (n0 === null || e0 === null || n1 === null || Math.abs(Math.abs(wrap180(n1 - n0)) - 40) > 5) return false;
    this.conv = { s: Math.sign(wrap180(n1 - n0)), h: Math.sign(wrap180(n0 - e0)), n0 };
    return true;
  }
  /** Aladin rotation that puts the direction at position angle `pa` straight up. */
  _rotFor(pa) { const c = this.conv || { s: 1, h: 1, n0: 0 }; return wrap180(c.s * (c.h * pa - c.n0)); }

  /** ICRS camera for the horizon view `cam` under ICRS -> horizon matrix M. */
  _horizonView(M, cam) {
    const c = T.mtxv(M, T.vecFromAltAz(cam.az, cam.alt)), zen = T.mtxv(M, [0, 0, 1]);
    return { c, rot: this._rotFor(T.positionAngle(c, zen)), fov: cam.fov };
  }
  _apply(view) {
    const { ra, dec } = T.raDecFromVec(view.c);
    this.sphere.setCamera(ra, dec, view.fov);
    this.sphere.setRotation(view.rot);
  }
  _sphereView() {
    const c = this.sphere.readCamera();
    return { c: T.vecFromRaDec(c.ra, c.dec), rot: this.sphere.rot || 0, fov: c.fov };
  }
  /** Default look direction: towards the visible celestial pole, horizon low on the screen. */
  _defaultCam(lat, W, H) {
    const fov = W > H * 1.2 ? 112 : 100;
    const half = Math.sin(fov / 2 * D2R), halfV = half * H / Math.max(1, W);
    const alt = clamp(Math.asin(clamp(0.72 * halfV, 0, 0.99)) / D2R, 6, 40);
    return { az: lat >= 0 ? 0 : 180, alt, fov };
  }

  // ------------------------------------------------------------------ control
  /**
   * Turn the sky to `when` ({year, month, day, hour, minute}, local solar time) above `place` ({label, lat, lon}).
   * Chains from the current night when already landed at the same place; otherwise starts from tonight.
   */
  async start(place, when, opts = {}) {
    if (!this.sphere.ok) throw new Error('The sky map has not loaded yet. Try again in a moment.');
    let starsErr = null;
    await this.loadStars().catch((e) => { starsErr = e; });
    const same = this.active && this.place && this.place.lat === place.lat && this.place.lon === place.lon;
    const chain = same && (this.mode === 'landed' || this.mode === 'land');
    const now = new Date(), nowYear = now.getUTCFullYear();
    const jd1 = jdFromLocal(when, place.lon);
    let jd0;
    if (chain) jd0 = this.jd1;
    else {
      const d = Math.min(when.day, T.daysInMonth(nowYear, when.month));
      jd0 = jdFromLocal({ ...when, year: nowYear, day: d }, place.lon);
    }
    if (!this.conv && !this._calibrate()) this.conv = null;   // falls back to the default convention
    const W = this.input.clientWidth || window.innerWidth, H = this.input.clientHeight || window.innerHeight;
    const fromView = chain ? null : this._sphereView();
    if (!chain) { this.cam = this._defaultCam(place.lat, W, H); this._clearTrails(); }
    this.place = { ...place }; this.when = { ...when }; this.opts = opts;
    this.jd0 = jd0; this.jd1 = jd1;
    this.s0 = T.skyState(jd0, place.lon); this.s1 = T.skyState(jd1, place.lon);
    this.b0 = this._bodies(this.s0); this.b1 = this._bodies(this.s1);
    // The whirl: the exact change in sidereal angle, plus K whole turns standing for the nights in between.
    const days = jd1 - jd0, raw = this.s1.theta - this.s0.theta;
    const K = Math.abs(days) < 3 ? 0 : clamp(Math.round(2 + Math.log10(Math.abs(days)) / 2), 2, 5);
    const target = Math.abs(days) < 3 ? TAU * SIDEREAL * days : Math.sign(days) * TAU * K;
    this.dTheta = raw + TAU * Math.round((target - raw) / TAU);
    const dy = Math.abs(this.s1.epj - this.s0.epj);
    this.spinDur = Math.abs(days) < 3 ? 2.2 : clamp(5.2 + 1.6 * Math.log10(1 + dy / 100), 4, 9.5);
    this.fromView = fromView; this.lastView = null;
    this._pickMovers();
    this.starsErr = starsErr;
    this.overlayA = chain ? this.overlayA : 0;
    this.input.hidden = false;
    this.hud.box.hidden = false;
    this.hud.box.classList.remove('landed');
    this.hud.live.textContent = '';
    if (reduceMotion()) { this.groundA = 1; this._land(true); } else this._phase(chain ? 'spin' : 'enter');
    this.onChange();
  }
  /** Spin back to tonight at the same place. */
  returnToday() {
    if (!this.place || !this.when) return;
    const y = new Date().getUTCFullYear(), d = Math.min(this.when.day, T.daysInMonth(y, this.when.month));
    return this.start(this.place, { ...this.when, year: y, day: d });
  }
  /** Turn the map back to north-up and leave the horizon view. */
  leave() {
    if (!this.active || this.mode === 'leave') return;
    if (reduceMotion() || !this.lastView) { this.exitNow(); return; }
    this.leaveFrom = this.lastView; this._phase('leave'); this.onChange();
  }
  exitNow() {
    if (!this.active) return;
    this.mode = 'off'; this.sphere.setRotation(0);
    this.input.hidden = true; this.hud.box.hidden = true; this.hud.box.classList.remove('on', 'landed');
    this.groundA = 0; this.overlayA = 0; this._clearTrails(); this.cursor = null;
    this.onChange();
  }
  _phase(m) { this.mode = m; this.t = 0; }
  _land(instant) {
    this.mode = instant ? 'landed' : 'land'; this.t = 0; this.jd = this.jd1; this.speed = 0;
    if (instant) { this.overlayA = 1; this.trailA = 0; this._clearTrails(); }
    const w = this.when, cal = T.calendarFromJd(this.jd1);
    const date = `${w.day} ${T.MONTHS[w.month - 1]} ${T.fmtYear(w.year)}`;
    const sky = this.b1 ? skyLines(this.b1) : null;
    this.skyLine = sky;
    this.hud.live.textContent = `The sky over ${this.place.label} on ${date} at ${pad2(w.hour)}:${pad2(w.minute)} local solar time${cal.julian ? ' (Julian calendar)' : ''}.${sky ? ` ${sky.spoken}` : ''}`;
    this.hud.box.classList.add('landed');
    this.onChange();
  }

  _pickMovers() {
    this.movers = [];
    if (!this.stars) return;
    const ep = this.s1.epj, out = [];
    for (const s of this.stars) {
      const v0 = T.starAt(s.st, MAP_EPOCH).v, v1 = T.starAt(s.st, ep).v, d = T.angleBetween(v0, v1);
      if (d >= MOVER_MIN_DEG) out.push({ s, v0, d });
    }
    out.sort((a, b) => a.s.v - b.s.v);
    this.movers = out.slice(0, MOVER_MAX);
  }

  // ------------------------------------------------------------------ input (horizon look-around)
  _bindInput() {
    const n = this.input; let drag = null;
    n.tabIndex = 0;
    n.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'landed') return;
      drag = { x: e.clientX, y: e.clientY, az: this.cam.az, alt: this.cam.alt };
      try { n.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
      n.classList.add('dragging');
    });
    n.addEventListener('pointermove', (e) => {
      const r = n.getBoundingClientRect(); this.cursor = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (!drag) return;
      const k = this.cam.fov / Math.max(1, n.clientWidth);
      this.cam.az = wrap360(drag.az - (e.clientX - drag.x) * k);
      this.cam.alt = clamp(drag.alt + (e.clientY - drag.y) * k, 0, 80);
    });
    const end = () => { drag = null; n.classList.remove('dragging'); };
    n.addEventListener('pointerup', end); n.addEventListener('pointercancel', end);
    n.addEventListener('pointerleave', () => { if (!drag) this.cursor = null; });
    n.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.mode !== 'landed') return;
      this.cam.fov = clamp(this.cam.fov * Math.exp(e.deltaY * 0.0012), 25, 150);
    }, { passive: false });
    n.addEventListener('keydown', (e) => {
      if (this.mode !== 'landed') return;
      const step = this.cam.fov / 20, k = e.key;
      if (k === 'ArrowLeft') this.cam.az = wrap360(this.cam.az - step);
      else if (k === 'ArrowRight') this.cam.az = wrap360(this.cam.az + step);
      else if (k === 'ArrowUp') this.cam.alt = clamp(this.cam.alt + step, 0, 80);
      else if (k === 'ArrowDown') this.cam.alt = clamp(this.cam.alt - step, 0, 80);
      else if (k === '+' || k === '=') this.cam.fov = clamp(this.cam.fov / 1.15, 25, 150);
      else if (k === '-') this.cam.fov = clamp(this.cam.fov * 1.15, 25, 150);
      else return;
      e.preventDefault();
    });
  }

  /** Header read-outs while the rewind is showing. */
  readouts() {
    const c = this.cam;
    const centre = `Facing ${dirName(c.az)} · ${Math.round(c.alt)}° up · ${Math.round(c.fov)}°`;
    let cursor = this.landed ? 'Drag to look around' : 'Turning the sky…';
    if (this.landed && this.cursor && this.M) {
      const w = this.sphere.screen2world(this.cursor.x, this.cursor.y);
      if (w) {
        const h = T.altAzFromVec(T.mxv(this.M, T.vecFromRaDec(w.ra, w.dec)));
        cursor = `Altitude ${h.alt.toFixed(1)}°  Azimuth ${h.az.toFixed(1)}° ${dirName(h.az)}`;
      }
    }
    const cal = T.calendarFromJd(this.jd || this.jd0 || T.JD2000);
    return { centre, cursor, layer: `SPHEREx all-sky map, turned to ${T.fmtYear(this.landed ? this.when.year : cal.year)}` };
  }

  // ------------------------------------------------------------------ per-frame
  frame(dt, ctx, W, H, dpr) {
    if (!this.active) return;
    this.t += dt;
    let st, view = null, jd = this.jd1;
    if (this.mode === 'enter') {
      const p = clamp(this.t / ENTER_S, 0, 1), e = smooth(p);
      st = this.s0; jd = this.jd0;
      const M = T.horizonMatrix(st.prec, st.theta, this.place.lat), to = this._horizonView(M, this.cam), fr = this.fromView;
      view = { c: slerp(fr.c, to.c, e), rot: fr.rot + wrap180(to.rot - fr.rot) * e, fov: lerpLog(fr.fov, to.fov, e) };
      this.groundA = e; this.speed = 0;
      this.bodies = this.b0; this.bodyA = e; this.washL = this.b0.light; this.washA = e;
      if (p >= 1) this._phase('spin');
    } else if (this.mode === 'spin') {
      const p = clamp(this.t / this.spinDur, 0, 1), e = easeInOutCubic(p);
      jd = lerp(this.jd0, this.jd1, e);
      const s = T.skyState(jd, this.place.lon);
      st = { epj: s.epj, prec: s.prec, theta: this.s0.theta + this.dTheta * e };
      this.speed = Math.abs(this.dTheta * easeInOutCubicD(p) / this.spinDur) / TAU;   // turns per second
      this.trailA = 1; this.groundA = 1; this.overlayA = Math.max(0, this.overlayA - dt * 3);   // labels belong to the landing
      // the Sun and Moon mean nothing while the days race by; the sky colour hands over from tonight to the date
      this.bodyA = 0; this.washL = p < 0.5 ? this.b0.light : this.b1.light;
      this.washA = p < 0.5 ? 1 - smooth(p / 0.15) : smooth((p - 0.85) / 0.15);
      if (p >= 1) { st = this.s1; this._land(false); }
    } else if (this.mode === 'land') {
      const p = clamp(this.t / LAND_S, 0, 1);
      st = this.s1; this.overlayA = Math.max(this.overlayA, smooth(p)); this.trailA = 1 - smooth(p); this.speed = 0;
      this.bodies = this.b1; this.bodyA = smooth(p); this.washL = this.b1.light; this.washA = 1;
      if (p >= 1) { this.mode = 'landed'; this.trailA = 0; this._clearTrails(); }
    } else if (this.mode === 'landed') {
      st = this.s1;
      this.bodies = this.b1; this.bodyA = 1; this.washL = this.b1.light; this.washA = 1;
    } else if (this.mode === 'leave') {
      const p = clamp(this.t / LEAVE_S, 0, 1), e = smooth(p), fr = this.leaveFrom;
      st = this.s1;
      this.bodies = this.b1; this.bodyA = Math.min(this.bodyA, 1 - e); this.washL = this.b1.light; this.washA = 1 - e;
      view = { c: fr.c, rot: fr.rot - fr.rot * e, fov: lerpLog(fr.fov, 85, e) };
      this.groundA = 1 - e; this.overlayA = Math.min(this.overlayA, 1 - e);
      if (p >= 1) { this._apply(view); this.exitNow(); return; }
    }
    this.epj = st.epj; this.jdShown = jd;
    const M = T.horizonMatrix(st.prec, st.theta, this.place.lat);
    this.M = M;
    if (!view) {
      const cam = this.mode === 'spin' ? { ...this.cam, fov: this.cam.fov * (1 + 0.1 * Math.sin(Math.PI * clamp(this.t / this.spinDur, 0, 1))) } : this.cam;
      view = this._horizonView(M, cam);
    }
    this._apply(view); this.lastView = view;
    this.viewC = view.c; this.cosView = Math.cos(Math.min(100, view.fov * 0.72 + 8) * D2R); this.pxDeg = W / Math.max(1, view.fov);
    this._draw(ctx, M, W, H, dpr);
    this._hud(jd);
  }

  _proj(v) {
    const { ra, dec } = T.raDecFromVec(v);
    return this.sphere.world2screen(ra, dec);
  }
  _clearTrails() { this.tctx.setTransform(1, 0, 0, 1, 0, 0); this.tctx.clearRect(0, 0, this.trail.width, this.trail.height); this.prevTrail = null; }

  /** Screen point of an ICRS unit vector if it is above altitude lim (degrees) and near the view; else null. */
  _pv(v, lim = -3) {
    if (T.mxv(this.M, v)[2] < Math.sin(lim * D2R) || T.dot(v, this.viewC) < this.cosView) return null;
    return this._proj(v);
  }
  /** Draws polylines of ICRS vectors (or stars), lifting the pen where a point is hidden. */
  _polylines(ctx, lines, toV, lim) {
    ctx.beginPath();
    for (const line of lines) {
      let pen = false, prev = null;
      for (const p of line) {
        const q = this._pv(toV(p), lim);
        // a jump across the screen means the projection wrapped: break the line there
        if (!q || (prev && Math.abs(q.x - prev.x) + Math.abs(q.y - prev.y) > 0.8 * (this._W + this._H))) { pen = false; prev = q; if (!q) continue; }
        pen ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); pen = true; prev = q;
      }
    }
    ctx.stroke();
  }

  _draw(ctx, M, W, H, dpr) {
    const above = (v, lim = 0) => T.mxv(M, v)[2] > Math.sin(lim * D2R), lay = this.layers, oa = this.overlayA;
    this._W = W; this._H = H;
    const day = lay.daylight && this.washL, L = day ? this.washL : S.NIGHT, wa = day ? this.washA : 0;
    // how much of the night sky shows through the daylight (1 at night)
    const night = 1 - wa * (1 - L.lineA), mlim = lerp(6, L.mlim, wa), dsoA = 1 - wa * (1 - L.dsoA);
    const seen = (mag) => clamp(mlim - mag + 0.5, 0, 1);
    const fov = this.lastView ? this.lastView.fov : 100;
    const lab = new S.Labeler(ctx, W, H);
    this.L = lab;
    ctx.save();
    // 1. darken the map while it whirls, so the trails carry the motion
    if (this.speed > 0.02) { ctx.fillStyle = `rgba(5,7,11,${0.55 * clamp(this.speed / 0.7, 0, 1)})`; ctx.fillRect(0, 0, W, H); }
    // 2. the colour of the sky: twilight and day cover the map
    if (day && wa > 0.003) {
      const hz = this._proj(T.mtxv(M, T.vecFromAltAz(this.cam.az, 0))), top = this._proj(T.mtxv(M, T.vecFromAltAz(this.cam.az, Math.min(85, this.cam.alt + fov * 0.3))));
      const b = this.bodies, g = b && b.sun.alt < 6 ? this._proj(T.mtxv(M, T.vecFromAltAz(b.sun.az, 0))) : null;
      S.drawWash(ctx, W, H, L, wa, hz ? hz.y : H, top ? top.y : 0, g, this.pxDeg);
    }
    // 3. star trails
    if (this.trailA > 0.003 && this.trailStars) this._trails(ctx, M, W, H, dpr);
    // 4. constellation boundaries and figures
    if (this.sky && lay.borders) {
      ctx.lineWidth = 1; ctx.setLineDash([3, 4]); ctx.strokeStyle = `rgba(150,176,230,${(0.1 + 0.16 * oa) * night})`;
      this._polylines(ctx, this.sky.borders, (v) => v, -2);
      ctx.setLineDash([]);
    }
    if (lay.lines && (this.sky || this.asterisms)) {
      ctx.lineWidth = 1; ctx.strokeStyle = `rgba(150,184,240,${(0.13 + 0.27 * oa) * night})`;
      this._polylines(ctx, this.sky ? this.sky.figures.flat() : this.asterisms.flat(), (s) => this._at(s), -3);
    }
    // 5. the pole's path among the stars (precession circle), today's stretch highlighted
    this._precession(ctx, M, this.epj, oa, night);
    // 6. galaxies, clusters and nebulae
    if (this.sky && lay.deepsky && oa > 0.02) this._deepSky(ctx, fov, oa * dsoA);
    // 7. fast stars: where the map shows them (ring, 2025) and where they really are at this epoch (gold)
    const ma = (this.mode === 'spin' ? 0.9 : Math.max(oa, this.mode === 'enter' ? 0 : 0.9));
    for (const m of this.movers) {
      const v = this._at(m.s), vis = seen(m.s.v);
      if ((!above(v, -2) && !above(m.v0, -2)) || vis < 0.02) continue;
      const a = this._proj(m.v0), b = this._proj(v);
      if (!a || !b) continue;
      const bright = clamp((6.5 - m.s.v) / 6, 0.25, 1), k = ma * vis;
      if (Math.hypot(b.x - a.x, b.y - a.y) > 3) {
        ctx.strokeStyle = `rgba(242,184,75,${0.45 * k * bright})`; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.strokeStyle = `rgba(233,230,223,${0.5 * k * bright})`;
        ctx.beginPath(); ctx.arc(a.x, a.y, 3.5 + 2 * bright, 0, TAU); ctx.stroke();
      }
      ctx.fillStyle = `rgba(242,184,75,${k * (0.55 + 0.45 * bright)})`;
      ctx.beginPath(); ctx.arc(b.x, b.y, 1.6 + 2.2 * bright, 0, TAU); ctx.fill();
      if (m.s.name && above(v)) lab.add({ text: m.s.name, x: b.x, y: b.y - 1, prio: 2 + m.s.v / 10, font: '500 12px Inter, system-ui, sans-serif', size: 12, color: 'rgba(242,184,75,$a)', alpha: oa * vis });
    }
    // 8. Sun, Moon and planets
    if (lay.bodies && this.bodies && this.bodyA > 0.003) this._bodiesDraw(ctx, this.bodies, this.bodyA, mlim, lab);
    // 9. names of stars and constellations
    if (lay.snames && this.named && oa > 0.02) {
      const moving = new Set(this.movers.map((m) => m.s)), vmax = fov > 95 ? LABEL_V : fov > 60 ? 2.6 : 3.6;
      for (const s of this.named) {
        if (moving.has(s) || (s.v >= vmax && !ALWAYS_LABEL.has(s.hip))) continue;
        const vis = seen(s.v); if (vis < 0.02) continue;
        const q = this._pv(this._at(s), 1); if (!q) continue;
        lab.add({ text: s.name, x: q.x, y: q.y - 1, prio: 3 + s.v / 10, font: '500 12px Inter, system-ui, sans-serif', size: 12, color: 'rgba(233,230,223,$a)', alpha: 0.82 * oa * vis });
      }
    }
    if (this.sky && lay.cnames && oa > 0.02) {
      const rmax = fov > 120 ? 1 : fov > 85 ? 2 : 3;
      for (const c of this.sky.cons) {
        if (c.rank > rmax) continue;
        const q = this._pv(this._drift(c), 4); if (!q) continue;
        lab.add({ text: c.name.toUpperCase(), x: q.x, y: q.y, prio: 5 + c.rank, mode: 'centre', font: '600 10px Inter, system-ui, sans-serif', size: 10, spacing: 1.6, color: 'rgba(150,184,240,$a)', alpha: 0.75 * oa * night });
      }
    }
    lab.flush();
    // 10. ground, horizon and compass points
    if (this.groundA > 0.003) this._ground(ctx, M, W, H, wa * clamp((L.h + 8) / 14, 0, 1));
    ctx.restore();
  }

  _deepSky(ctx, fov, a) {
    const pmax = fov > 110 ? 1 : fov > 70 ? 2 : 3, lab = this.L;
    ctx.lineWidth = 1;
    for (const o of this.sky.dsos) {
      if (o.prio > pmax) continue;
      const q = this._pv(this._drift(o), 2); if (!q) continue;
      const big = o.id === 'lmc' || o.id === 'smc' ? Math.max(6, 4 * this.pxDeg) : 4.5;
      const col = o.type === 'gc0' ? '255,200,140' : /^(g|s|e|i)$/.test(o.type) ? '246,196,160' : /^(oc|gc)$/.test(o.type) ? '200,214,255' : '160,236,210';
      ctx.strokeStyle = `rgba(${col},${0.55 * a})`;
      ctx.beginPath();
      if (o.type === 'gc0') { ctx.moveTo(q.x - 6, q.y); ctx.lineTo(q.x + 6, q.y); ctx.moveTo(q.x, q.y - 6); ctx.lineTo(q.x, q.y + 6); }
      else if (/^(g|s|e|i)$/.test(o.type)) ctx.ellipse(q.x, q.y, big * 1.5, big * 0.75, -0.5, 0, TAU);
      else ctx.arc(q.x, q.y, big, 0, TAU);
      ctx.stroke();
      lab.block(q.x, q.y, 2 * big + 2, 2 * big + 2);
      lab.add({ text: o.name, x: q.x, y: q.y, gap: big + 5, prio: 6 + o.prio, font: 'italic 400 11.5px Inter, system-ui, sans-serif', size: 11.5, color: `rgba(${col},$a)`, alpha: 0.85 * a });
    }
  }

  _bodiesDraw(ctx, b, a, mlim, lab) {
    const fontB = '600 12px Inter, system-ui, sans-serif';
    // planets: dots sized by brightness, named when they can be seen
    for (const p of b.planets) {
      if (p.alt < -1) continue;
      const vis = clamp(mlim - p.mag + 1, 0, 1); if (vis < 0.02) continue;
      const q = this._pv(p.v, -1); if (!q) continue;
      const r = clamp(2.6 - 0.45 * p.mag, 1.6, 4.6), [cr, cg, cb] = p.rgb;
      const g = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, r * 3.2);
      g.addColorStop(0, `rgba(${cr},${cg},${cb},${0.5 * a * vis})`); g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q.x, q.y, r * 3.2, 0, TAU); ctx.fill();
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${a * vis})`; ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, TAU); ctx.fill();
      lab.block(q.x, q.y, 2 * r + 4, 2 * r + 4);
      lab.add({ text: p.name, x: q.x, y: q.y, gap: r + 6, prio: 1 + p.mag / 100, font: fontB, size: 12, color: `rgba(${cr},${cg},${cb},$a)`, alpha: a * vis });
    }
    // the Moon, with the stretch of sky it could be on when Delta T is uncertain
    const m = b.moon;
    if (m.alt > -1.5) {
      const q = this._pv(m.v, -1.5);
      if (q) {
        if (m.arc) {
          ctx.save(); ctx.setLineDash([2, 5]); ctx.lineWidth = 2; ctx.lineCap = 'round';
          ctx.strokeStyle = `rgba(240,236,222,${0.45 * a})`;
          this._polylines(ctx, [m.arc], (v) => v, -6);
          ctx.restore();
        }
        const r = Math.max(7, m.radius * this.pxDeg), toward = this._towards(m.v, b.sun.v), phi = toward ? Math.atan2(toward.y - q.y, toward.x - q.x) : 0;
        S.drawMoon(ctx, q, r, m.k, phi, a);
        lab.block(q.x, q.y, 2 * r + 6, 2 * r + 6);
        lab.add({ text: 'Moon', x: q.x, y: q.y, gap: r + 6, prio: 0.5, font: fontB, size: 12, color: 'rgba(240,236,222,$a)', alpha: a });
      }
    }
    // the Sun, last: in an eclipse the Moon's disc is drawn on the Sun's glow, then the Sun's core is cut by it
    if (b.sun.alt > -1.5) {
      const q = this._pv(b.sun.v, -1.5);
      if (q) {
        const r = Math.max(9, b.sun.radius * this.pxDeg);
        S.drawSun(ctx, q, r, b.sun.alt, a);
        const mq = b.sun.eclipse ? this._pv(m.v, -1.5) : null;
        if (mq) {   // the Moon in front of the Sun, enlarged by as much as the Sun's disc so the overlap stays true
          const k = r / (b.sun.radius * this.pxDeg);
          ctx.fillStyle = `rgba(8,9,12,${a})`; ctx.beginPath();
          ctx.arc(q.x + (mq.x - q.x) * k, q.y + (mq.y - q.y) * k, m.radius * this.pxDeg * k, 0, TAU); ctx.fill();
        }
        lab.block(q.x, q.y, 2 * r + 8, 2 * r + 8);
        lab.add({ text: 'Sun', x: q.x, y: q.y, gap: r + 8, prio: 0, font: fontB, size: 12, color: 'rgba(255,226,170,$a)', alpha: a });
      }
    }
  }
  /** Screen point one degree from ICRS point a towards ICRS point b (for orienting the Moon's lit side). */
  _towards(a, b) {
    const d = T.dot(a, b), p = [b[0] - d * a[0], b[1] - d * a[1], b[2] - d * a[2]], n = Math.hypot(...p);
    if (n < 1e-9) return null;
    const k = Math.tan(D2R);
    return this._proj([a[0] + k * p[0] / n, a[1] + k * p[1] / n, a[2] + k * p[2] / n].map((x, i, u) => x / Math.hypot(...u)));
  }

  _trails(ctx, M, W, H, dpr) {
    const tw = Math.round(W * dpr), th = Math.round(H * dpr), tc = this.tctx;
    if (this.trail.width !== tw || this.trail.height !== th) { this.trail.width = tw; this.trail.height = th; this.prevTrail = null; }
    tc.setTransform(dpr, 0, 0, dpr, 0, 0);
    // fade what is there: long tails at full speed, quick fade as the sky settles
    tc.globalCompositeOperation = 'destination-out';
    tc.fillStyle = `rgba(0,0,0,${this.mode === 'spin' ? 0.075 : 0.16})`; tc.fillRect(0, 0, W, H);
    tc.globalCompositeOperation = 'lighter';
    const prev = this.prevTrail || new Map(), next = new Map(), lim = W * 0.35;
    if (this.mode === 'spin') {
      tc.lineCap = 'round';
      for (const s of this.trailStars) {
        const v = T.starAt(s.st, this.epj).v;
        if (T.mxv(M, v)[2] < -0.05) continue;
        const q = this._proj(v); if (!q) continue;
        next.set(s, q);
        const p = prev.get(s);
        if (!p || Math.hypot(q.x - p.x, q.y - p.y) > lim) continue;
        const k = clamp((TRAIL_V - s.v) / 5, 0, 1), [r, g, b] = s.rgb;
        tc.strokeStyle = `rgba(${r},${g},${b},${0.22 + 0.7 * k})`; tc.lineWidth = 0.7 + 2.1 * k;
        tc.beginPath(); tc.moveTo(p.x, p.y); tc.lineTo(q.x, q.y); tc.stroke();
      }
    }
    this.prevTrail = next;
    tc.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = this.trailA; ctx.drawImage(this.trail, 0, 0, W, H); ctx.globalAlpha = 1;
  }

  /** night: how much of the night sky the daylight leaves (1 at night). */
  _precession(ctx, M, epj, oa, night) {
    if (!this.circle) {
      this.circle = [];
      for (let y = -13000; y <= 13000; y += 200) this.circle.push(T.poleOfDate(y));
      // millennium ticks in historical years: 2000 BCE is astronomical year -1999
      this.ticks = [];
      for (let n = -12000; n <= 12000; n += 2000) if (n) { const y = n > 0 ? n : n + 1; this.ticks.push({ y, label: T.fmtYear(y), v: T.poleOfDate(y) }); }
    }
    const draw = (pts, style, width, dash) => {
      ctx.strokeStyle = style; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath(); let pen = false;
      for (const v of pts) {
        const q = T.mxv(M, v)[2] > -0.02 ? this._proj(v) : null;
        if (!q) { pen = false; continue; }
        pen ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); pen = true;
      }
      ctx.stroke(); ctx.setLineDash([]);
    };
    const k = night, lab = this.L, mono = '400 11px "IBM Plex Mono", ui-monospace, monospace';
    draw(this.circle, `rgba(233,230,223,${(0.1 + 0.12 * oa) * Math.max(k, 0.25)})`, 1, [2, 5]);
    const n = 90, seg = [];
    for (let i = 0; i <= n; i++) seg.push(T.poleOfDate(lerp(MAP_EPOCH, epj, i / n)));
    draw(seg, `rgba(242,184,75,${0.85 * Math.max(k, 0.35)})`, 1.6, []);
    if (oa > 0.02) {
      ctx.fillStyle = `rgba(233,230,223,${0.6 * oa})`;
      for (const c of this.ticks) {
        // ticks next to the shown date or today would sit on their labels
        if (Math.abs(c.y - epj) < 700 || Math.abs(c.y - MAP_EPOCH) < 700 || T.mxv(M, c.v)[2] < 0) continue;
        const q = this._proj(c.v); if (!q) continue;
        ctx.beginPath(); ctx.arc(q.x, q.y, 1.6, 0, TAU); ctx.fill();
        lab.add({ text: c.label, x: q.x, y: q.y, gap: 6, prio: 4, font: mono, size: 11, color: 'rgba(233,230,223,$a)', alpha: 0.6 * oa * k });
      }
    }
    // today's pole and the pole of the shown date (the sky turns about it)
    const today = T.poleOfDate(MAP_EPOCH), qt = T.mxv(M, today)[2] > 0 ? this._proj(today) : null;
    if (qt && Math.abs(epj - MAP_EPOCH) > 30) {
      ctx.strokeStyle = `rgba(233,230,223,${0.7 * Math.max(k, 0.35)})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(qt.x, qt.y, 4, 0, TAU); ctx.stroke();
      // after Polaris's name, so that takes the right of it and this the left
      lab.block(qt.x, qt.y, 10, 10);
      lab.add({ text: 'pole today', x: qt.x, y: qt.y + 1, gap: 9, prio: 3.5, font: mono, size: 11, color: 'rgba(233,230,223,$a)', alpha: 0.75 * oa * k });
    }
    const pole = this.place.lat >= 0 ? T.poleOfDate(epj) : T.poleOfDate(epj).map((x) => -x);
    if (T.mxv(M, pole)[2] > 0) {
      const q = this._proj(pole);
      if (q) {
        ctx.strokeStyle = `rgba(242,184,75,${0.95 * Math.max(k, 0.4)})`; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(q.x, q.y, 7, 0, TAU);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(q.x + dx * 10, q.y + dy * 10); ctx.lineTo(q.x + dx * 16, q.y + dy * 16); }
        ctx.stroke();
        lab.block(q.x, q.y, 34, 34);
        lab.add({ text: `${this.place.lat >= 0 ? 'north' : 'south'} celestial pole, ${T.fmtYear(this.when.year)}`, x: q.x, y: q.y - 12, gap: 20, prio: 1.5,
          font: '500 12px Inter, system-ui, sans-serif', size: 12, color: 'rgba(242,184,75,$a)', alpha: oa * Math.max(k, 0.4) });
      }
    }
  }

  /** dayK: 0 at night, 1 in full daylight (the land is lit). */
  _ground(ctx, M, W, H, dayK = 0) {
    const ga = this.groundA, az0 = this.cam.az, pts = [];
    for (let k = -89; k <= 89; k += 1.5) {
      const q = this._proj(T.mtxv(M, T.vecFromAltAz(az0 + k, 0)));
      if (q) pts.push(q);
    }
    if (pts.length < 2) return;
    const big = 4 * (W + H), f = pts[0], l = pts[pts.length - 1];
    let topY = Infinity; for (const p of pts) topY = Math.min(topY, p.y);
    ctx.save();
    ctx.globalAlpha = ga;
    ctx.beginPath(); ctx.moveTo(f.x - big, f.y);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.lineTo(l.x + big, l.y); ctx.lineTo(l.x + big, H + big); ctx.lineTo(f.x - big, H + big); ctx.closePath();
    const g = ctx.createLinearGradient(0, Math.max(0, topY), 0, H);
    const top = [lerp(22, 74, dayK), lerp(17, 70, dayK), lerp(12, 56, dayK)], bot = [lerp(5, 34, dayK), lerp(7, 32, dayK), lerp(11, 26, dayK)];
    g.addColorStop(0, `rgba(${top.map(Math.round)},0.97)`); g.addColorStop(1, `rgba(${bot.map(Math.round)},1)`);
    ctx.fillStyle = g; ctx.fill();
    // horizon line with a faint glow above it
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = 'rgba(242,184,75,0.10)'; ctx.lineWidth = 7; ctx.stroke();
    ctx.strokeStyle = 'rgba(233,230,223,0.34)'; ctx.lineWidth = 1; ctx.stroke();
    // compass points
    ctx.font = '600 11px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let i = 0; i < 8; i++) {
      const q = this._proj(T.mtxv(M, T.vecFromAltAz(i * 45, 0)));
      if (!q || q.x < -20 || q.x > W + 20 || q.y > H) continue;
      ctx.fillStyle = i % 2 ? 'rgba(233,230,223,0.5)' : 'rgba(233,230,223,0.85)';
      ctx.fillText(CARDINALS[i], q.x, q.y + 10);
      ctx.fillRect(q.x - 0.5, q.y - 4, 1, 8);
    }
    ctx.restore();
  }

  _hud(jd) {
    const h = this.hud, cal = T.calendarFromJd(jd);
    let year, sub, legend = '', skyText = '';
    if (this.mode === 'landed' || this.mode === 'land' || this.mode === 'leave') {
      const w = this.when;
      year = T.fmtYear(w.year);
      sub = `${w.day} ${T.MONTHS[w.month - 1]} · ${pad2(w.hour)}:${pad2(w.minute)} local solar time · ${this.place.label}${cal.julian ? ' · Julian calendar' : ''}`;
      const notes = [];
      if (this.movers.length) notes.push('Gold: where fast-moving stars really were. Ring: where the SPHEREx map (2025) shows them.');
      if (this.skyLine && this.skyLine.caveat && this.layers.bodies) notes.push(this.skyLine.caveat);
      if (this.starsErr) notes.splice(0, notes.length, 'The star list could not be loaded, so star motions, names and trails are not shown.');
      else if (this.skyErr) notes.push('The constellations could not be loaded, so only a few star patterns are drawn.');
      legend = notes.join(' ');
      skyText = this.skyLine && this.layers.bodies ? this.skyLine.text : '';
    } else {
      year = T.fmtYear(cal.year);
      sub = this.mode === 'enter' ? `The sky over ${this.place.label}, ${T.MONTHS[this.when.month - 1]} ${this.when.day}` : this.jd1 < this.jd0 ? 'Turning back the sky…' : 'Turning the sky forward…';
    }
    const text = `${year}|${sub}|${legend}|${skyText}`;
    if (text !== this._hudText) {
      this._hudText = text; h.year.textContent = year; h.sub.textContent = sub; h.legend.textContent = legend; h.legend.hidden = !legend;
      if (h.sky) { h.sky.textContent = skyText; h.sky.hidden = !skyText; }
    }
    h.box.classList.toggle('on', this.mode !== 'leave' || this.t < LEAVE_S * 0.4);
  }
}

// ------------------------------------------------------------------ panel (form in the sphere dock)
/** Wires the "Turn back the sky" controls. ids: element ids used in index.html. */
export class RewindPanel {
  constructor(rewind, { onBeforeStart, onOpen } = {}) {
    this.r = rewind; this.onBeforeStart = onBeforeStart || (() => {}); this.onOpen = onOpen || (() => {});
    const $ = (id) => document.getElementById(id);
    this.$ = $;
    this.f = {
      place: $('rw-place'), lat: $('rw-lat'), lon: $('rw-lon'), custom: $('rw-custom'), locate: $('rw-locate'),
      year: $('rw-year'), era: $('rw-era'), month: $('rw-month'), day: $('rw-day'), time: $('rw-time'),
      go: $('rw-go'), today: $('rw-today'), exit: $('rw-exit'), error: $('rw-error'), presets: $('rw-presets'),
      layers: $('rw-layers'),
    };
    const f = this.f, now = new Date(), y = now.getUTCFullYear();
    const groups = new Map();
    for (const p of PLACES) {
      const opt = el('option', { value: p.id, text: p.label });
      if (!p.region) { f.place.append(opt); continue; }
      if (!groups.has(p.region)) { groups.set(p.region, el('optgroup', { label: p.region })); f.place.append(groups.get(p.region)); }
      groups.get(p.region).append(opt);
    }
    T.MONTHS.forEach((m, i) => f.month.append(el('option', { value: String(i + 1), text: m })));
    f.place.value = 'giza';
    this.setWhen({ year: y - 2000, month: now.getMonth() + 1, day: now.getDate(), hour: 22, minute: 0 });
    const presets = [
      ['2,000 years ago', () => ({ year: y - 2000 })],
      ['Great Pyramid · 2560 BCE', () => ({ year: -2559, place: 'giza' })],
      ['Vega near the pole · 13,600 CE', () => ({ year: 13600 })],
    ];
    for (const [label, fn] of presets) {
      f.presets.append(el('button', {
        type: 'button', class: 'pill', text: label,
        onclick: () => { const p = fn(); if (p.place) { f.place.value = p.place; this._syncPlace(); } this.setWhen({ ...this.readWhen(true), year: p.year }); this.go(); },
      }));
    }
    if (f.layers) {
      for (const l of S.LAYERS) {
        const b = el('button', { type: 'button', class: 'pill', text: l.label, 'aria-pressed': String(!!this.r.layers[l.id]) });
        b.addEventListener('click', () => {
          const on = !this.r.layers[l.id];
          this.r.setLayer(l.id, on); b.setAttribute('aria-pressed', String(on));
        });
        f.layers.append(b);
      }
    }
    f.place.addEventListener('change', () => this._syncPlace());
    for (const n of [f.year, f.era]) n.addEventListener('input', () => this._syncLabel());
    f.today.addEventListener('click', () => { f.error.textContent = ''; this.r.returnToday(); });
    f.exit.addEventListener('click', () => this.r.leave());
    f.locate.addEventListener('click', () => this._locate());
    // The form lives in a panel the shell opens and closes (onOpen), so the sky stays clear until it is asked for.
    this.form = $('rw-form');
    this.form.addEventListener('submit', (e) => { e.preventDefault(); this.go(); });
    this._syncPlace(); this._syncLabel();
  }
  setOpen(open, focus = false) {
    this.onOpen(open);
    if (open && focus) this.f.year.focus({ preventScroll: true });
  }
  setWhen(w) {
    const f = this.f;
    f.year.value = String(w.year > 0 ? w.year : 1 - w.year); f.era.value = w.year > 0 ? 'CE' : 'BCE';
    f.month.value = String(w.month); f.day.value = String(w.day);
    if (w.hour !== undefined) f.time.value = `${pad2(w.hour)}:${pad2(w.minute)}`;
    this._syncLabel();
  }
  /** Reads the form. lenient: keep going with defaults for unreadable fields (presets). */
  readWhen(lenient = false) {
    const f = this.f, n = parseInt(f.year.value.replace(/[,\s]/g, ''), 10);
    const year = Number.isFinite(n) ? (f.era.value === 'BCE' ? 1 - n : n) : NaN;
    const m = /^(\d{1,2}):(\d{2})$/.exec(f.time.value.trim());
    const w = { year, month: +f.month.value, day: parseInt(f.day.value, 10), hour: m ? +m[1] : NaN, minute: m ? +m[2] : NaN };
    if (lenient) {
      if (!Number.isFinite(w.hour)) { w.hour = 22; w.minute = 0; }
      if (!Number.isFinite(w.day)) w.day = 1;
    }
    return w;
  }
  readPlace() {
    const f = this.f, id = f.place.value;
    if (id !== 'custom') return PLACES.find((p) => p.id === id);
    const lat = parseFloat(f.lat.value.replace('−', '-')), lon = parseFloat(f.lon.value.replace('−', '-'));
    if (!(lat >= -89.9 && lat <= 89.9) || !(lon >= -180 && lon <= 180)) return null;
    return { id: 'custom', label: `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`, lat, lon };
  }
  _syncPlace() { this.f.custom.hidden = this.f.place.value !== 'custom'; }
  _syncLabel() {
    const w = this.readWhen(true), y = new Date().getUTCFullYear(), ref = this.r.landed ? this.r.when.year : y;
    this.f.go.textContent = Number.isFinite(w.year) && w.year > ref ? 'Turn the sky forward' : 'Turn back the sky';
  }
  sync() {
    const r = this.r;
    this.f.today.hidden = !r.active || !r.when || r.when.year === new Date().getUTCFullYear();
    this.f.exit.hidden = !r.active;
    this.f.go.disabled = r.busy; this.f.today.disabled = r.busy;
    this._syncLabel();
  }
  _locate() {
    const f = this.f;
    if (!navigator.geolocation) { f.error.textContent = 'This browser cannot share its location. Type a latitude and longitude instead.'; return; }
    f.error.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition((p) => {
      f.lat.value = p.coords.latitude.toFixed(4); f.lon.value = p.coords.longitude.toFixed(4); f.error.textContent = '';
    }, () => { f.error.textContent = 'Your location is not available. Type a latitude and longitude instead.'; }, { timeout: 10000 });
  }
  async go() {
    const f = this.f; f.error.textContent = '';
    const place = this.readPlace();
    if (!place) { f.error.textContent = 'Latitude should be −89.9 to 89.9 and longitude −180 to 180 (east positive).'; f.lat.focus(); return; }
    const w = this.readWhen(), bad = checkWhen(w);
    if (bad) { f.error.textContent = bad; return; }
    if (!this.r.sphere.ok) { f.error.textContent = 'The sky map has not loaded yet. Try again in a moment.'; return; }
    this.onBeforeStart();
    try { await this.r.start(place, w); } catch (e) {
      f.error.textContent = e.message || String(e);
      if (!this.r.active) this.r.input.hidden = true;
    }
  }
}
