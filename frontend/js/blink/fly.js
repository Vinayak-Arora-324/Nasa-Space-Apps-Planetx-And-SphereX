// Camera animations between the sphere and a patch (spec section 7).
import { smooth as S, lerp, lerpLog, dRA, wrap360, separation, clamp } from './util.js';

export const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class FlyController {
  /** apply({ra, dec, fov, oldMix, newMix, p, kind}) is called every animation frame. */
  constructor(apply) { this.apply = apply; this.raf = 0; this.active = false; this.token = 0; }

  cancel() { cancelAnimationFrame(this.raf); this.active = false; this.token++; }

  _run(dur, step) {
    this.cancel();
    const token = this.token;
    this.active = true;
    return new Promise((resolve) => {
      if (reduceMotion()) { step(1); this.active = false; resolve(true); return; }
      const t0 = performance.now();
      const tick = (now) => {
        if (token !== this.token) { resolve(false); return; }
        const p = clamp((now - t0) / (dur * 1000), 0, 1);
        step(p);
        if (p < 1) this.raf = requestAnimationFrame(tick);
        else { this.active = false; resolve(true); }
      };
      this.raf = requestAnimationFrame(tick);
    });
  }

  /**
   * Fly from the current camera to a patch. from: {ra, dec, fov, inPatch}; to: {ra, dec, width}.
   * onProgress(p) lets the caller swap patch data at the right moment.
   */
  fly(from, to, onProgress) {
    const sep = separation(from.ra, from.dec, to.ra, to.dec), fromPatch = !!from.inPatch;
    const dur = 2.4 + Math.min(2.2, sep / 50) + (fromPatch ? 0.8 : 0);
    let fovMid = Math.max(from.fov, Math.min(70, sep * 0.8));
    if (fromPatch) fovMid = Math.max(fovMid, 8);
    const dra = dRA(from.ra, to.ra);
    return this._run(dur, (p) => {
      let fov, c = 0;
      if (p < 0.3) fov = lerpLog(from.fov, fovMid, S(p / 0.3));
      else if (p < 0.7) { fov = fovMid; c = S((p - 0.3) / 0.4); }
      else { fov = lerpLog(fovMid, to.width, S((p - 0.7) / 0.3)); c = 1; }
      if (p >= 0.7) c = 1;
      this.apply({
        ra: wrap360(from.ra + dra * c), dec: lerp(from.dec, to.dec, c), fov,
        oldMix: fromPatch ? 1 - S(p / 0.3) : 0, newMix: S((p - 0.82) / 0.18), p, kind: 'fly',
      });
      onProgress && onProgress(p);
    });
  }

  /** Leave a patch: field of view widens from the patch width to 55 degrees over 2.2 s. */
  leave(from) {
    return this._run(2.2, (p) => {
      this.apply({ ra: from.ra, dec: from.dec, fov: lerpLog(from.width, 55, S(p)), oldMix: 1 - S(p / 0.4), newMix: 0, p, kind: 'leave' });
    });
  }

  /** Simple field-of-view tween for the zoom buttons. */
  zoom(cam, fovTo, dur = 0.45) {
    return this._run(dur, (p) => this.apply({ ra: cam.ra, dec: cam.dec, fov: lerpLog(cam.fov, fovTo, S(p)), oldMix: 0, newMix: 0, p, kind: 'zoom' }));
  }
}
