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

/**
 * Comfortable free-flight speed (frame units per second): about a third of the distance to the nearest surface per
 * second (so you close that gap in ~3 s of coasting, and slow down smoothly as you near it), clamped to
 * [1e-9, 100] parsecs per second expressed in frame units via unitsPerPc.
 */
export function suggestSpeed(distToNearestSurface, unitsPerPc) {
  const lo = 1e-9 * unitsPerPc, hi = 100 * unitsPerPc;
  if (!Number.isFinite(distToNearestSurface) || distToNearestSurface <= 0) return lo;
  return clamp(distToNearestSurface / 3, lo, hi);
}
