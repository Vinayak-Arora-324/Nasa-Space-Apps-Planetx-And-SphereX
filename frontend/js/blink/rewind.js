// Whole-sky rewind ("turn back the sky"). Turns the SPHEREx all-sky map into the sky above a place on a chosen
// night, with an animated whirl back (or forward) through the years.
//
// The map itself is moved only by frame rotations, which are exact for it: the camera centre and view rotation
// are set each frame so that Aladin shows the horizon view of the place, for precession (Vondrak 2011) and Earth
// rotation. Stars that move against the others are drawn from the XHIP catalogue on the overlay, because the map
// is a snapshot of where they were in 2025. Astronomy is in skytime.js.
import * as T from './skytime.js';
import { clamp, smooth, lerp, lerpLog, wrap360, el } from './util.js';
import { reduceMotion } from './fly.js';

const D2R = Math.PI / 180, TAU = 2 * Math.PI;
export const MAP_EPOCH = 2025.5;     // SPHEREx all-sky survey: the map shows each star where it was then
export const YEAR_MIN = -14999, YEAR_MAX = 15000;   // 15,000 BCE (astronomical year -14999) to 15,000 CE
const ENTER_S = 2.0, LAND_S = 1.6, LEAVE_S = 1.4;
const TRAIL_V = 3.6, LABEL_V = 1.6, MOVER_MIN_DEG = 0.25, MOVER_MAX = 140;
const ALWAYS_LABEL = new Set([11767, 68756, 72607, 87937]);   // Polaris, Thuban, Kochab, Barnard's Star
const SIDEREAL = 1.00273781191135448;

export const PLACES = [
  { id: 'giza', label: 'Giza, Egypt', lat: 29.9792, lon: 31.1342 },
  { id: 'karnak', label: 'Karnak, Luxor', lat: 25.7188, lon: 32.6573 },
  { id: 'athens', label: 'Athens', lat: 37.9715, lon: 23.7257 },
  { id: 'stonehenge', label: 'Stonehenge', lat: 51.1789, lon: -1.8262 },
  { id: 'chichen', label: 'Chichén Itzá', lat: 20.6843, lon: -88.5678 },
  { id: 'maunakea', label: 'Maunakea, Hawaiʻi', lat: 19.8207, lon: -155.4681 },
  { id: 'sydney', label: 'Sydney', lat: -33.8568, lon: 151.2153 },
  { id: 'custom', label: 'Somewhere else…' },
];

// Asterisms as polylines of Hipparcos numbers.
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
/** Label to the right of a point, or to its left when it would run off the right edge. */
function label(ctx, text, x, y, W, gap = 8) {
  if (x + gap + ctx.measureText(text).width > W - 6) { ctx.textAlign = 'right'; ctx.fillText(text, x - gap, y); ctx.textAlign = 'left'; }
  else ctx.fillText(text, x + gap, y);
}
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

/** UT Julian Day of a local mean solar time at longitude lon (degrees east). */
export function jdFromLocal({ year, month, day, hour, minute }, lon) {
  return T.jdFromCalendar(year, month, day + (hour + minute / 60 - lon / 15) / 24);
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
    this._bindInput();
  }
  get active() { return this.mode !== 'off'; }
  get landed() { return this.mode === 'landed'; }
  get busy() { return this.mode === 'enter' || this.mode === 'spin' || this.mode === 'leave'; }

  // ------------------------------------------------------------------ data
  loadStars() {
    if (!this.loading) {
      this.loading = fetch('data/rewind-stars.json')
        .then((r) => { if (!r.ok) throw new Error(`star list: HTTP ${r.status}`); return r.json(); })
        .then((d) => this._ingest(d))
        .catch((e) => { this.loading = null; throw e; });
    }
    return this.loading;
  }
  _ingest(d) {
    const list = [], byHip = new Map();
    for (const [hip, ra, dec, pmra, pmdec, plx, rv, v, bv] of d.stars) {
      const s = { hip, v, bv, rgb: bvColor(bv), name: d.names[hip] || null, st: T.makeStar(ra, dec, pmra, pmdec, plx, rv, d.epoch) };
      list.push(s); byHip.set(hip, s);
    }
    this.stars = list;
    this.trailStars = list.filter((s) => s.v < TRAIL_V);
    this.named = list.filter((s) => s.name && (s.v < LABEL_V || ALWAYS_LABEL.has(s.hip)));
    this.asterisms = ASTERISMS.map((g) => g.map((line) => line.map((h) => byHip.get(h)).filter(Boolean)));
    T.cioLocator(2000);   // builds the CIO-locator table now (~0.1 s), not in the first animation frame
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
    this.hud.live.textContent = `The sky over ${this.place.label} on ${date} at ${pad2(w.hour)}:${pad2(w.minute)} local solar time${cal.julian ? ' (Julian calendar)' : ''}.`;
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
      if (p >= 1) this._phase('spin');
    } else if (this.mode === 'spin') {
      const p = clamp(this.t / this.spinDur, 0, 1), e = easeInOutCubic(p);
      jd = lerp(this.jd0, this.jd1, e);
      const s = T.skyState(jd, this.place.lon);
      st = { epj: s.epj, prec: s.prec, theta: this.s0.theta + this.dTheta * e };
      this.speed = Math.abs(this.dTheta * easeInOutCubicD(p) / this.spinDur) / TAU;   // turns per second
      this.trailA = 1; this.groundA = 1; this.overlayA = Math.max(0, this.overlayA - dt * 3);   // labels belong to the landing
      if (p >= 1) { st = this.s1; this._land(false); }
    } else if (this.mode === 'land') {
      const p = clamp(this.t / LAND_S, 0, 1);
      st = this.s1; this.overlayA = Math.max(this.overlayA, smooth(p)); this.trailA = 1 - smooth(p); this.speed = 0;
      if (p >= 1) { this.mode = 'landed'; this.trailA = 0; this._clearTrails(); }
    } else if (this.mode === 'landed') {
      st = this.s1;
    } else if (this.mode === 'leave') {
      const p = clamp(this.t / LEAVE_S, 0, 1), e = smooth(p), fr = this.leaveFrom;
      st = this.s1;
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
    this._draw(ctx, M, W, H, dpr);
    this._hud(jd);
  }

  _proj(v) {
    const { ra, dec } = T.raDecFromVec(v);
    return this.sphere.world2screen(ra, dec);
  }
  _clearTrails() { this.tctx.setTransform(1, 0, 0, 1, 0, 0); this.tctx.clearRect(0, 0, this.trail.width, this.trail.height); this.prevTrail = null; }

  _draw(ctx, M, W, H, dpr) {
    const epj = this.epj, above = (v, lim = 0) => T.mxv(M, v)[2] > Math.sin(lim * D2R);
    ctx.save();
    // 1. darken the map while it whirls, so the trails carry the motion
    if (this.speed > 0.02) { ctx.fillStyle = `rgba(5,7,11,${0.55 * clamp(this.speed / 0.7, 0, 1)})`; ctx.fillRect(0, 0, W, H); }
    // 2. star trails
    if (this.trailA > 0.003 && this.trailStars) this._trails(ctx, M, W, H, dpr);
    const oa = this.overlayA;
    // 3. asterisms
    if (this.asterisms) {
      ctx.lineWidth = 1; ctx.strokeStyle = `rgba(233,230,223,${0.16 + 0.22 * oa})`;
      for (const g of this.asterisms) for (const line of g) {
        ctx.beginPath(); let pen = false;
        for (const s of line) {
          const v = T.starAt(s.st, epj).v, q = above(v, -3) ? this._proj(v) : null;
          if (!q) { pen = false; continue; }
          pen ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); pen = true;
        }
        ctx.stroke();
      }
    }
    // 4. the pole's path among the stars (precession circle), today's stretch highlighted
    this._precession(ctx, M, epj, oa, W);
    // 5. fast stars: where the map shows them (ring, 2025) and where they really are at this epoch (gold)
    ctx.font = '500 12px Inter, system-ui, sans-serif'; ctx.textBaseline = 'middle';
    const ma = this.mode === 'spin' ? 0.9 : Math.max(oa, this.mode === 'enter' ? 0 : 0.9);
    for (const m of this.movers) {
      const v = T.starAt(m.s.st, epj).v;
      if (!above(v, -2) && !above(m.v0, -2)) continue;
      const a = this._proj(m.v0), b = this._proj(v);
      if (!a || !b) continue;
      const bright = clamp((6.5 - m.s.v) / 6, 0.25, 1);
      if (Math.hypot(b.x - a.x, b.y - a.y) > 3) {
        ctx.strokeStyle = `rgba(242,184,75,${0.45 * ma * bright})`; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.strokeStyle = `rgba(233,230,223,${0.5 * ma * bright})`;
        ctx.beginPath(); ctx.arc(a.x, a.y, 3.5 + 2 * bright, 0, TAU); ctx.stroke();
      }
      ctx.fillStyle = `rgba(242,184,75,${ma * (0.55 + 0.45 * bright)})`;
      ctx.beginPath(); ctx.arc(b.x, b.y, 1.6 + 2.2 * bright, 0, TAU); ctx.fill();
      if (m.s.name && oa > 0.02 && above(v)) {
        ctx.fillStyle = `rgba(242,184,75,${oa})`; ctx.shadowColor = 'rgba(5,7,11,.95)'; ctx.shadowBlur = 5;
        label(ctx, m.s.name, b.x, b.y - 1, W); ctx.shadowBlur = 0;
      }
    }
    // 6. names of bright stars
    if (this.named && oa > 0.02) {
      const moving = new Set(this.movers.map((m) => m.s));
      ctx.fillStyle = `rgba(233,230,223,${0.82 * oa})`; ctx.shadowColor = 'rgba(5,7,11,.95)'; ctx.shadowBlur = 5;
      for (const s of this.named) {
        if (moving.has(s)) continue;
        const v = T.starAt(s.st, epj).v;
        if (!above(v, 1)) continue;
        const q = this._proj(v); if (!q) continue;
        label(ctx, s.name, q.x, q.y - 1, W);
      }
      ctx.shadowBlur = 0;
    }
    // 7. ground, horizon and compass points
    if (this.groundA > 0.003) this._ground(ctx, M, W, H);
    ctx.restore();
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

  _precession(ctx, M, epj, oa, W) {
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
    draw(this.circle, `rgba(233,230,223,${0.1 + 0.12 * oa})`, 1, [2, 5]);
    const n = 90, seg = [];
    for (let i = 0; i <= n; i++) seg.push(T.poleOfDate(lerp(MAP_EPOCH, epj, i / n)));
    draw(seg, 'rgba(242,184,75,0.85)', 1.6, []);
    ctx.font = '400 11px "IBM Plex Mono", ui-monospace, monospace'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(5,7,11,.95)'; ctx.shadowBlur = 4;
    if (oa > 0.02) {
      ctx.fillStyle = `rgba(233,230,223,${0.6 * oa})`;
      for (const c of this.ticks) {
        // ticks next to the shown date or today would sit on their labels
        if (Math.abs(c.y - epj) < 700 || Math.abs(c.y - MAP_EPOCH) < 700 || T.mxv(M, c.v)[2] < 0) continue;
        const q = this._proj(c.v); if (!q) continue;
        ctx.beginPath(); ctx.arc(q.x, q.y, 1.6, 0, TAU); ctx.fill();
        label(ctx, c.label, q.x, q.y, W, 6);
      }
    }
    // today's pole and the pole of the shown date (the sky turns about it)
    const today = T.poleOfDate(MAP_EPOCH), qt = T.mxv(M, today)[2] > 0 ? this._proj(today) : null;
    if (qt && Math.abs(epj - MAP_EPOCH) > 30) {
      ctx.strokeStyle = 'rgba(233,230,223,.7)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(qt.x, qt.y, 4, 0, TAU); ctx.stroke();
      if (oa > 0.02) {   // left of the ring: Polaris, a degree away, is labelled on the right
        ctx.fillStyle = `rgba(233,230,223,${0.75 * oa})`; ctx.textAlign = 'right'; ctx.fillText('pole today', qt.x - 9, qt.y + 1); ctx.textAlign = 'left';
      }
    }
    const pole = this.place.lat >= 0 ? T.poleOfDate(epj) : T.poleOfDate(epj).map((x) => -x);
    if (T.mxv(M, pole)[2] > 0) {
      const q = this._proj(pole);
      if (q) {
        ctx.strokeStyle = 'rgba(242,184,75,.95)'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(q.x, q.y, 7, 0, TAU);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(q.x + dx * 10, q.y + dy * 10); ctx.lineTo(q.x + dx * 16, q.y + dy * 16); }
        ctx.stroke();
        if (oa > 0.02) {
          ctx.fillStyle = `rgba(242,184,75,${oa})`;
          label(ctx, `${this.place.lat >= 0 ? 'north' : 'south'} celestial pole, ${T.fmtYear(this.when.year)}`, q.x, q.y - 12, W, 20);
        }
      }
    }
    ctx.shadowBlur = 0;
  }

  _ground(ctx, M, W, H) {
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
    g.addColorStop(0, 'rgba(22,17,12,0.97)'); g.addColorStop(1, 'rgba(5,7,11,1)');
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
    let year, sub, legend = '';
    if (this.mode === 'landed' || this.mode === 'land' || this.mode === 'leave') {
      const w = this.when;
      year = T.fmtYear(w.year);
      sub = `${w.day} ${T.MONTHS[w.month - 1]} · ${pad2(w.hour)}:${pad2(w.minute)} local solar time · ${this.place.label}${cal.julian ? ' · Julian calendar' : ''}`;
      if (this.movers.length) legend = 'Gold: where fast-moving stars really were. Ring: where the SPHEREx map (2025) shows them.';
      if (this.starsErr) legend = 'The star list could not be loaded, so star motions, names and trails are not shown.';
    } else {
      year = T.fmtYear(cal.year);
      sub = this.mode === 'enter' ? `The sky over ${this.place.label}, ${T.MONTHS[this.when.month - 1]} ${this.when.day}` : this.jd1 < this.jd0 ? 'Turning back the sky…' : 'Turning the sky forward…';
    }
    const text = `${year}|${sub}|${legend}`;
    if (text !== this._hudText) {
      this._hudText = text; h.year.textContent = year; h.sub.textContent = sub; h.legend.textContent = legend; h.legend.hidden = !legend;
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
    };
    const f = this.f, now = new Date(), y = now.getUTCFullYear();
    for (const p of PLACES) f.place.append(el('option', { value: p.id, text: p.label }));
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
