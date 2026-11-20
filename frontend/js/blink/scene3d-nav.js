// Autopilot and speed helpers for the 3D fly-through. Pure maths; positions are in whatever frame units the caller uses.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a, fb = [0, 0, -1]) => { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : fb; };

export function easeInOut(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

/** Spherical interpolation of two directions (normalised result). Handles parallel and antiparallel inputs. */
export function slerpDir(a, b, t) {
  a = unit(a); b = unit(b);
  const d = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
  if (d > 1 - 1e-12) return unit([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  if (d < -1 + 1e-12) {   // opposite: rotate about any perpendicular axis
    const ax = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const p = unit([a[1] * ax[2] - a[2] * ax[1], a[2] * ax[0] - a[0] * ax[2], a[0] * ax[1] - a[1] * ax[0]]);
    const th = Math.PI * t;
    return [a[0] * Math.cos(th) + p[0] * Math.sin(th), a[1] * Math.cos(th) + p[1] * Math.sin(th), a[2] * Math.cos(th) + p[2] * Math.sin(th)];
  }
  const th = Math.acos(d), s = Math.sin(th), w0 = Math.sin((1 - t) * th) / s, w1 = Math.sin(t * th) / s;
  return unit([a[0] * w0 + b[0] * w1, a[1] * w0 + b[1] * w1, a[2] * w0 + b[2] * w1]);
}

/** Distance (AU) at which the autopilot stops from a body of the given radius (AU): max(6 radii, 0.002 AU). */
export function arrivalDistance(radiusAu) {
  return Math.max(6 * (Number.isFinite(radiusAu) ? radiusAu : 0), 0.002);
}

export const TURN_SECONDS = 0.8;

export class Autopilot {
  constructor() { this.active = false; this.done = true; }

  start({ from, fromDir, to, stopAt }) {
    this.from = from.slice(); this.pos = from.slice(); this.to = to.slice();
    this.fromDir = unit(fromDir); this.dir = this.fromDir;
    this.stopAt = Math.max(stopAt, 1e-30);
    const D = len(sub(to, from));
    this.L = Math.log(Math.max(D / this.stopAt, 1));            // log of distance ratio at the start of the trip
    this.dur = clamp(2.5 + 0.6 * this.L / Math.LN10, 2.5, 8);   // seconds of travel
    this.t = 0; this.s = 0;
    this.active = true; this.done = false;
    return this;
  }

  cancel() { this.active = false; this.done = true; }

  /**
   * The trip's peak speed (frame units per second) over the travel phase, from the same law step() uses: v(s) = r(s) L ease'(s) / dur with r(s) = stopAt exp(L (1 - ease(s))),
   * ease'(s) = 6 s (1 - s). Cheap (256 samples), cached by (L, dur, stopAt), so the HUD may ask every frame. 0 for an idle autopilot.
   */
  peakSpeed() {
    if (!this.active) return 0;
    const key = `${this.L}|${this.dur}|${this.stopAt}`;
    if (this._peakKey === key) return this._peak;
    let best = 0;
    for (let i = 1; i < 256; i++) { const s = i / 256, v = this.stopAt * Math.exp(this.L * (1 - easeInOut(s))) * this.L * 6 * s * (1 - s) / this.dur; if (v > best) best = v; }
    this._peakKey = key; this._peak = best;
    return best;
  }

  /** Update a moving target. During travel the remaining distance stays continuous. */
  retarget(to) {
    this.to = to.slice();
    if (!this.active) return;
    const rest = 1 - easeInOut(this.s);   // the fraction of the log distance still to go, as step() uses it
    if (this.t > TURN_SECONDS && rest > 1e-9) {
      const r = len(sub(this.to, this.pos));
      this.L = Math.log(Math.max(r / this.stopAt, 1)) / rest;
    }
  }

  /** Advance by dt seconds. Returns {pos, dir, done}. */
  step(dt) {
    if (!this.active) return { pos: this.pos || [0, 0, 0], dir: this.dir || [0, 0, -1], done: true };
    this.t += Math.max(0, dt);
    const toT = sub(this.to, this.pos);
    const u = unit(toT, this.fromDir);
    if (this.t < TURN_SECONDS) {
      this.dir = slerpDir(this.fromDir, u, easeInOut(this.t / TURN_SECONDS));
      return { pos: this.pos.slice(), dir: this.dir, done: false };
    }
    this.s = Math.min(1, (this.t - TURN_SECONDS) / this.dur);
    const r = this.s >= 1 ? this.stopAt : this.stopAt * Math.exp(this.L * (1 - easeInOut(this.s)));
    const dist = r;
    this.pos = [this.to[0] - u[0] * dist, this.to[1] - u[1] * dist, this.to[2] - u[2] * dist];
    this.dir = u;
    if (this.s >= 1) { this.active = false; this.done = true; }
    return { pos: this.pos.slice(), dir: u, done: this.done };
  }
}

// ------------------------------------------------------------------ the HUD speed (docs/object-framework.md section 19.3.6)
/**
 * Why the HUD once read "0.0000000068 AU/s" with the autopilot flying. The readout is the camera's measured world speed smoothed with a 0.1 s time constant, and the
 * HUD called anything above 1e-15 pc/s "moving". An autopilot trip starts from exact rest: its turn phase (0.8 s) does not move the camera, so the smoothed speed decays
 * to a tail of e^-8, and the travel phase then eases in from zero (ease'(0) = 0), so for a frame or two the true speed is a few 1e-14 pc/s, 1e-15 of the trip's peak,
 * and the log-scale readout printed it as a speed. The same happens on the last approach (a trip ends at a few AU after covering parsecs: the speed falls by a factor of
 * 1e8) and as the tail after every stop. Nothing in the autopilot or the frame switch is at fault (scene3d-speed.test.mjs).
 * The fix is to say "at rest" or "turning" there: a speed below SPEED_REL_FLOOR of the recent peak (the smoothed speed, or the autopilot's own peakSpeed() while it flies)
 * is not shown as a speed. SpeedTracker keeps the measure; hudSpeed turns it into what the HUD prints.
 */
export const SPEED_TAU_S = 0.1, SPEED_REL_FLOOR = 1e-6, SPEED_QUIET_S = 1;
export class SpeedTracker {
  constructor() { this.reset(); }
  reset() { this.last = null; this.smoothed = 0; this.speedPc = 0; this.peak = 0; this.quiet = 0; }
  /**
   * worldPc: the camera's world position (pc, doubles) this frame; dt seconds; apPeakPc: the flying autopilot's peakSpeed() in pc/s (0 when none; trips run in world pc
   * so its units are pc). Returns (and keeps in .speedPc) the speed to show, pc/s: the smoothed speed, or 0 while that is below SPEED_REL_FLOOR of the peak. The
   * smoothed state itself is cleared when the raw speed is below the floor too (a stop's tail); the peak is forgotten after SPEED_QUIET_S of that, so a slow flight
   * after a fast one is shown again.
   */
  update(worldPc, dt, apPeakPc = 0) {
    const w = worldPc;
    if (this.last && dt > 0) {
      const v = Math.hypot(w[0] - this.last[0], w[1] - this.last[1], w[2] - this.last[2]) / dt;
      this.smoothed = smoothSpeed(this.smoothed, v, dt);
      this.peak = Math.max(this.peak, this.smoothed, apPeakPc || 0);
      const floor = SPEED_REL_FLOOR * this.peak;
      if (v < floor && this.smoothed < floor) { this.smoothed = 0; this.quiet += dt; if (this.quiet > SPEED_QUIET_S) this.peak = 0; } else this.quiet = 0;
      this.speedPc = this.smoothed < floor ? 0 : this.smoothed;
    }
    this.last = w.slice();
    return this.speedPc;
  }
}
/** One step of the HUD's smoothing: prev + (v - prev) (1 - e^(-dt / 0.1 s)). */
export const smoothSpeed = (prev, v, dt) => prev + (v - prev) * (1 - Math.exp(-dt / SPEED_TAU_S));
/**
 * What the HUD prints for the speed: { mode: 'moving' | 'rest' | 'turning', speedPc }. 'turning': an autopilot trip in its turn phase (the camera does not move; the
 * HUD says so). 'rest': no speed above 1e-15 pc/s or above SPEED_REL_FLOOR of cruisePc (the
 * current cruise speed, pc/s; the HUD reads '0 · cruise ...'). 'moving': speedPc as measured. ap: the Autopilot (or null).
 */
export function hudSpeed(speedPc, ap = null, cruisePc = 0) {
  if (ap && ap.active && ap.t < TURN_SECONDS) return { mode: 'turning', speedPc: 0 };
  // a camera at rest has no peak to compare with, so float-level drift (a few 1e-14 pc/s) would read as a speed: below 1e-6 of the cruise speed is rest too
  const floor = Math.max(1e-15, SPEED_REL_FLOOR * (cruisePc > 0 ? cruisePc : 0));
  return speedPc > floor ? { mode: 'moving', speedPc } : { mode: 'rest', speedPc: 0 };
}

/**
 * Comfortable free-flight speed (frame units per second): about a third of the distance to the nearest surface per
 * second (so you close that gap in ~3 s of coasting, and slow down smoothly as you near it), clamped to
 * [1e-9, hiPc] parsecs per second expressed in frame units via unitsPerPc. hiPc is the level's cap (its autoPc.max, section 18.5.1):
 * the default 100 keeps the Phase 2 behaviour; the galaxy and cosmos levels pass 1e8.
 */
export function suggestSpeed(distToNearestSurface, unitsPerPc, hiPc = 100) {
  const lo = 1e-9 * unitsPerPc, hi = hiPc * unitsPerPc;
  if (!Number.isFinite(distToNearestSurface) || distToNearestSurface <= 0) return lo;
  return clamp(distToNearestSurface / 3, lo, hi);
}

/**
 * The manual speed carried across a frame switch (frame units per second): the same physical speed, scaled by the ratio of the levels' units per parsec
 * and clamped to the new level's [min, max]. floorPc (pc/s) keeps a camera that has just left a star's system from crawling in the new level.
 */
export function carrySpeed(speed, fromPerPc, toPerPc, { min = 0, max = Infinity, floorPc = 0 } = {}) {
  return clamp(Math.max((speed * toPerPc) / fromPerPc, floorPc * toPerPc), min, max);
}

export const C_PC_PER_S = 9.716e-9;       // light speed in parsecs per second
export const C_AU_PER_S = 0.0020040;       // and in AU per second
export const THROTTLE = { min: 0.02, max: 20, def: 1 };

/**
 * Auto-throttle: free-flight speed (frame units per second) is throttle x the distance to the nearest surface, so each
 * second of holding forward closes a fixed fraction of the remaining gap. Clamped to [min, max]; a missing or
 * non-positive distance gives min.
 */
export function autoThrottleSpeed(dNear, throttle, { min = 0, max = Infinity } = {}) {
  if (!Number.isFinite(dNear) || dNear <= 0 || !Number.isFinite(throttle)) return min;
  return clamp(dNear * throttle, min, max);
}

/**
 * Keep a point out of spheres. spheres: [{ c: [x, y, z], r }]; a point inside shell * r is pushed radially onto that
 * shell, which keeps the tangential part of a move (sliding). Returns a new point.
 */
export function keepOutside(p, spheres, shell = 1.02) {
  let q = p.slice();
  for (let pass = 0; pass < 2; pass++) {
    for (const s of spheres) {
      const R = s.r * shell, d = sub(q, s.c), l = len(d);
      if (!(R > 0) || l >= R) continue;
      const u = l > 0 ? [d[0] / l, d[1] / l, d[2] / l] : [0, 0, 1];
      q = [s.c[0] + u[0] * R, s.c[1] + u[1] * R, s.c[2] + u[2] * R];
    }
  }
  return q;
}

/** "2.1 million× c" style text for a speed given as a multiple of light speed. */
export function fmtTimesC(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 0.01) return '<0.01× c';
  if (n < 1000) return `${n < 10 ? n.toFixed(2).replace(/\.?0+$/, '') : Math.round(n)}× c`;
  const units = [[1e15, 'quadrillion'], [1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
  // two significant figures, never in exponent form ('1.0e+2' for 100 thousand): the cosmos speeds reach hundreds of quadrillions of c
  for (const [v, name] of units) if (n >= v) return `${Number((n / v).toPrecision(2)).toLocaleString('en-US')} ${name}× c`;
  return `${Math.round(n)}× c`;
}

/**
 * How much a surface at angle theta from the look direction (cosine c) counts for the auto-throttle: 1 straight ahead,
 * falling to 0.2 at 90 degrees and behind, so a surface that is far off to the side or behind counts as up to 5x farther.
 */
/**
 * Effective distance of a distant star for the interstellar auto-throttle. A star only brakes you if your heading will
 * actually take you close to it: when the path passes within a corridor of radius max(tube, along * tan 0.15 deg), it
 * counts at its along-track distance (so the star you aim at pulls you in smoothly). Any other star counts 50x farther,
 * which only caps the cruise speed in dense fields. Inputs in frame units: along = distance ahead along the heading,
 * dist = straight-line distance.
 */
export const CORRIDOR = { tube: 0.05, tanAngle: Math.tan(0.15 * Math.PI / 180), cruise: 50 };
export function corridorDistance(along, dist, tube = CORRIDOR.tube) {
  if (!(dist > 0)) return 0;
  if (along > 0) {
    const miss2 = Math.max(0, dist * dist - along * along), r = Math.max(tube, along * CORRIDOR.tanAngle);
    if (miss2 <= r * r) return along;
  }
  return dist * CORRIDOR.cruise;
}

export function headingWeight(c, sharp = false) {
  if (!Number.isFinite(c)) return 1;
  // sharp: for distant stars in the interstellar field. Only stars within ~20-30 deg of the heading slow you; one well
  // off-axis counts 50x farther, so a dense field doesn't make you crawl. cos^16: 10 deg 0.78, 20 deg 0.37, 30 deg 0.10.
  if (sharp) return clamp(Math.pow(Math.max(c, 0), 16), 0.02, 1);
  return clamp(c, 0.2, 1);
}
