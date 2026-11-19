// Direction-only sky constants and the nebula billboard item (docs/object-framework.md sections 17.5 and 17.6.1). Pure: no DOM, no
// WebGL. scene3d-objects.js re-exports everything here, and billboardItems dispatches to nebulaItem for specs with billboard: 'nebula'.
//
// EXPORTS
//   INF_PC = 1e7                     where a direction-only object is drawn: this far (pc) along its direction, whatever the camera does
//   MW_FADE_PC = 800                 the Milky Way glow's fade distance (pc) and the one shared constant for direction-only objects;
//                                    SKY_FADE_PC is the same number. scene3d.js imports it from scene3d-objects.js
//   SKY_PICK_MIN = 0.25              below this skyFade a direction-only object is neither labelled nor picked
//   skyFade(cam, scalePc = SKY_FADE_PC) -> 0..1   1 / (1 + (dSun_pc / scalePc)^2), dSun the camera's distance from the Sun. Phase 3 (section 18.5.4):
//                                    the fade scale is per kind (spec.skyFadePc: nebulae 800 pc as here, galaxies 1e5 pc); the default is unchanged
//   projectAxes(center, [A, B, C], project) -> { semiMajorPx, semiMinorPx, angle, cov, inside, screen, ax: [a, b, c] }   Phase 3: the projected-ellipsoid
//       core of nebulaItem and galaxyItem. center: camera-relative vector (frame units); A, B, C: the three semi-axis vectors (frame units; C may be
//       null: a flat ellipse); project as for nebulaItem (null ONLY for points behind the camera). Each axis is projected through its two ends,
//       a = (P(c + A) - P(c - A)) / 2, and the screen covariance is S = a a^T + b b^T + c c^T.
//         ax          [a, b, c] the screen images of the axes ([x, y] px, y DOWN; c is [0, 0] when C is null)
//         cov         { xx, xy, yy } of S;  semiMajorPx, semiMinorPx: sqrt of its eigenvalues;  angle: the major axis' atan2(y, x), in (-pi/2, pi/2]
//         screen      project(center);  inside: the centre or an axis end cannot be projected (the camera is within the ellipsoid, or it is behind
//                     the camera): then semiMajorPx, semiMinorPx, angle and cov are null and ax is null
//   infinityPickable(fade) -> bool   fade >= SKY_PICK_MIN
//   relOfEntry(entry, cam) -> [x, y, z] | null   camera-relative position of a galaxy-frame entry in frame units. An entry with atInfinity
//                                    gives dir * INF_PC * unitsPerPc(cam): the same for every camera position
//   nebulaItem(entry, cam, ctx) -> item | null
//       entry: a visibleObjects entry of a nebula. ctx = { project, evidence = false, nearFade = 1, skyFade? }. ctx.project is REQUIRED
//       (null is returned without it) and must return null ONLY for points behind the camera (a projection that does not clip to the
//       screen: the item needs the ends of its axes even where they fall off screen); an axis end it cannot project makes the item
//       `inside` (the camera is within the nebula, or the nebula is behind it).
//       Shape (section 17.6.1): the centre is the entry's position, the semi-axes are the vectors A = Mhat D tan(major / 2),
//       B = mhat D tan(minor / 2) and the depth axis C = uhat |B| (illustrative: the minor semi-axis; 0 at infinity), D the distance in pc
//       (INF_PC at infinity), Mhat / mhat the major / minor directions on the sky from PA (north through east), as in scene3d-orbits.js's
//       skyBasis. Each is projected through its two ends (a = (P(c + A) - P(c - A)) / 2) and the screen covariance is
//       S = a a^T + b b^T + c c^T; its eigen-decomposition gives the ellipse. Seen from the Sun the depth axis projects to ~0, so the
//       ellipse is exactly the catalogue's major, minor and PA.
//       Unknown parts: minor missing -> a circle (minor = major, minorUnknown); PA missing -> the glow uses 180 deg * hashUnit(id, 'pa'),
//       and the Evidence outline is a dashed circle of radius major / 2 (paUnknown); major missing -> a marker only.
//       item = { id, kind, billboard: 'nebula', rel, dist, radiusUnits, rgb, look, seed, mode, alpha, fade, nearFade, skyFade, lineAlpha,
//         markerAlpha, pxRadius, semiMajorPx, semiMinorPx, angle, screen, inside, markerOnly, hollow, dashed, atInfinity, candidate: false,
//         paUnknown, minorUnknown }
//         look         'emission' | 'reflection' | 'planetary' | 'snr' | 'dark' (nebulaLook of the registry, from props.type)
//         seed         hashUnit(id, 'look'), for the noise
//         mode         'outline' (Evidence view: ellipse outline plus centre marker) | 'glow' (illustrative look)
//         semiMajorPx, semiMinorPx, angle   the screen ellipse: semi-axes in px and the major axis' angle in radians, atan2(y, x) with x
//                      right and y DOWN in px, in (-pi/2, pi/2]. null while inside. pxRadius = semiMajorPx (0 for no major, Infinity inside)
//         alpha        glow alpha: clamp(0.5 10^(-0.4 (SB - 20)), 0.06, 0.5) with SB = mag + 2.5 log10(pi a' b') (mag per arcmin^2, a' and b' the
//                      catalogue semi-axes in arcmin); without a magnitude the Sharpless Bright 1/2/3 -> 0.08 / 0.14 / 0.22, else 0.10.
//                      Times skyFade (direction-only) or fade (placed), times nearFade
//         fade         placed: smoothstep(1, 3, dist / physical semi-major), 0 while inside; direction-only: 1
//         lineAlpha    the Evidence outline's alpha: nearFade * skyFade (direction-only), 0 while inside
//         markerAlpha  the centre marker's alpha: nearFade * skyFade (direction-only; markerPoints reads it)
//         markerOnly   semiMajorPx < 3, or no major axis (no glow, no outline, the marker is the object)
//         hollow       evidence 'derived';  dashed: outline mode and (hollow or paUnknown)
import * as F from './scene3d-frames.js';
import { smoothstep } from './scene3d-math.js';
import { hashUnit, skyBasis } from './scene3d-orbits.js';
import { nebulaLook } from './scene3d-registry.js';

export const INF_PC = 1e7;
export const MW_FADE_PC = 800, SKY_FADE_PC = MW_FADE_PC;
export const SKY_PICK_MIN = 0.25;
export const NEBULA_MIN_PX = 3;   // a semi-major axis under this is a marker only
const D2R = Math.PI / 180;

export function skyFade(cam, scalePc = SKY_FADE_PC) {
  const w = F.worldPc(cam), d = Math.hypot(w[0], w[1], w[2]);
  return 1 / (1 + (d / scalePc) ** 2);
}
export const infinityPickable = (fade) => fade >= SKY_PICK_MIN;

export function relOfEntry(entry, cam) {
  if (entry.atInfinity && entry.dir) { const k = INF_PC * F.unitsPerPc(cam); return [entry.dir[0] * k, entry.dir[1] * k, entry.dir[2] * k]; }
  if (cam.frame === 'system') return null;
  return entry.galPc ? F.relFromCam(cam, entry.galPc) : null;
}

const ARCMIN_PER = { arcmin: 1, arcsec: 1 / 60, deg: 60 };
const arcminOf = (q) => (q && Number.isFinite(q.v) && ARCMIN_PER[q.unit || 'arcmin'] ? q.v * ARCMIN_PER[q.unit || 'arcmin'] : null);
const SH2_BRIGHT = { 1: 0.08, 2: 0.14, 3: 0.22, faint: 0.08, moderate: 0.14, bright: 0.22 };
const add = (a, b, s = 1) => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];

/** Brightness of the glow before any fade: see the header. Illustrative. */
export function nebulaBase(o, aArcmin, bArcmin) {
  const pr = o.props || {}, v = (q) => (q && Number.isFinite(q.v) ? q.v : null);
  const mag = o.render && Number.isFinite(o.render.mag) ? o.render.mag : (v(pr.vmag) ?? v(pr.bmag));
  if (mag != null && aArcmin > 0 && bArcmin > 0) {
    const sb = mag + 2.5 * Math.log10(Math.PI * aArcmin * bArcmin);
    return Math.min(Math.max(0.5 * Math.pow(10, -0.4 * (sb - 20)), 0.06), 0.5);
  }
  const br = pr.sh2_bright && pr.sh2_bright.v;
  return SH2_BRIGHT[typeof br === 'string' ? br.toLowerCase() : br] ?? 0.1;
}

/** The projected ellipsoid (see the header): the covariance of the screen images of the axes and its ellipse. */
export function projectAxes(center, axes, project) {
  const [A, B, C = null] = axes, screen = project(center), ax = [];
  let sxx = 0, sxy = 0, syy = 0, inside = !screen;
  if (!inside) {
    for (const v of [A, B, C]) {
      if (!v) { ax.push([0, 0]); continue; }
      const p1 = project(add(center, v)), p2 = project(add(center, v, -1));
      if (!p1 || !p2) { inside = true; break; }
      const x = (p1[0] - p2[0]) / 2, y = (p1[1] - p2[1]) / 2;
      ax.push([x, y]); sxx += x * x; sxy += x * y; syy += y * y;
    }
  }
  if (inside) return { semiMajorPx: null, semiMinorPx: null, angle: null, cov: null, inside: true, screen, ax: null };
  const mean = (sxx + syy) / 2, R = Math.hypot((sxx - syy) / 2, sxy);
  return { semiMajorPx: Math.sqrt(mean + R), semiMinorPx: Math.sqrt(Math.max(mean - R, 0)), angle: 0.5 * Math.atan2(2 * sxy, sxx - syy),
    cov: { xx: sxx, xy: sxy, yy: syy }, inside: false, screen, ax };
}

export function nebulaItem(e, cam, ctx = {}) {
  const { project, evidence = false, nearFade = 1 } = ctx;
  if (typeof project !== 'function') return null;
  const o = e.o, p = o.position || {}, ang = (o.size && o.size.angular) || {};
  const rel = relOfEntry(e, cam);
  if (!rel || !Number.isFinite(p.ra) || !Number.isFinite(p.dec)) return null;
  const atInf = !!e.atInfinity, upc = F.unitsPerPc(cam), dist = Math.hypot(rel[0], rel[1], rel[2]);
  const sFade = atInf ? (ctx.skyFade != null ? ctx.skyFade : skyFade(cam)) : 1;
  const majorAm = arcminOf(ang.major), minorAm = arcminOf(ang.minor), paQ = ang.pa;
  const paKnown = !!paQ && Number.isFinite(paQ.v), minorUnknown = !(minorAm > 0);
  const paUnknown = !paKnown, hollow = e.spec.markerStyle(o) === 'hollow';
  const mode = evidence ? 'outline' : 'glow';
  const look = nebulaLook(o), seed = hashUnit(e.id, 'look');
  const base = {
    id: e.id, kind: e.kind, billboard: 'nebula', rel, dist, rgb: e.spec.color(o), look, seed, mode, nearFade, skyFade: sFade, hollow, atInfinity: atInf,
    candidate: false, paUnknown, minorUnknown, markerAlpha: nearFade * sFade, screen: project(rel),
  };
  if (!(majorAm > 0)) {   // no angular size: only the marker
    return { ...base, radiusUnits: 0, alpha: 0, fade: 0, lineAlpha: 0, pxRadius: 0, semiMajorPx: 0, semiMinorPx: 0, angle: 0, inside: false, markerOnly: true, dashed: false };
  }
  const D = atInf ? INF_PC : Math.hypot(e.galPc[0], e.galPc[1], e.galPc[2]);
  // the circle of the Evidence outline when the orientation is unknown; the glow keeps the minor axis and a hashed angle
  const outlineCircle = evidence && paUnknown, minor = minorUnknown || outlineCircle ? majorAm : minorAm;
  const paDeg = paKnown ? paQ.v : evidence ? 0 : 180 * hashUnit(e.id, 'pa');
  const B0 = skyBasis(p.ra, p.dec), cp = Math.cos(paDeg * D2R), sp = Math.sin(paDeg * D2R);
  const Mh = [0, 1, 2].map((k) => cp * B0.N[k] + sp * B0.E[k]), mh = [0, 1, 2].map((k) => -sp * B0.N[k] + cp * B0.E[k]);
  const lenA = D * upc * Math.tan((majorAm * D2R / 60) / 2), lenB = D * upc * Math.tan((minor * D2R / 60) / 2);
  const axes = [Mh.map((x) => x * lenA), mh.map((x) => x * lenB)];
  const pj = projectAxes(rel, atInf ? axes : [...axes, B0.u.map((x) => x * lenB)], project);   // the depth axis (last): illustrative, as long as the minor semi-axis
  const inside = pj.inside;
  const dashed = evidence && (hollow || paUnknown);
  if (inside) {
    return { ...base, radiusUnits: lenA, alpha: 0, fade: 0, lineAlpha: 0, pxRadius: Infinity, semiMajorPx: null, semiMinorPx: null, angle: null, inside: true, markerOnly: false, dashed };
  }
  const { semiMajorPx, semiMinorPx, angle } = pj;
  const fade = atInf ? 1 : smoothstep(1, 3, dist / lenA);
  const alpha = nebulaBase(o, majorAm / 2, minor / 2) * (atInf ? sFade : fade) * nearFade;
  const markerOnly = semiMajorPx < NEBULA_MIN_PX;
  return { ...base, radiusUnits: lenA, alpha, fade, lineAlpha: nearFade * sFade, pxRadius: semiMajorPx, semiMajorPx, semiMinorPx, angle, inside: false, markerOnly, dashed };
}
