// The galaxy and Milky Way billboard items (docs/object-framework.md sections 18.6.1 and 18.7). Pure: no DOM, no WebGL. scene3d-objects.js
// re-exports everything here and billboardItems dispatches to it for specs with billboard: 'galaxy' | 'milky_way'.
//
// FRAME INDEPENDENCE: every physical scale (a radius in pc, a scale length) goes through unitsPerPc(cam), and no term reads cam.frame, so the same
// world scene gives the same items (screen positions, alphas, fades) in the galaxy frame (pc) and the cosmos frame (Mpc). Section 18.5.5.
//
// EXPORTS
//   GALAXY_MIN_PX = 3                 a semi-major axis under this is a marker only
//   GALAXY_SKY_FADE_PC = 1e5          the fade scale of a direction-only galaxy (the kind's spec.skyFadePc)
//   GALAXY_FADE_PC = [2e4, 4e4]       stars and the other populations fade out between these camera distances from the Sun
//   galaxyFade(cam) -> 0..1           1 - smoothstep(2e4, 4e4, dSun_pc): 1 near the Sun, 0 from 40 kpc out (re-exported by scene3d-objects.js)
//   MW_DISC_SCALES = 6                the Milky Way disc is drawn to this many thin-disc scale lengths
//   galaxyBase(o, majorArcmin, minorArcmin) -> alpha     the illustrative glow before any fade (see below)
//   galaxyItem(entry, cam, ctx) -> item | null
//       entry: a visibleObjects entry of a galaxy (not the Milky Way). ctx = { project, evidence = false, skyFade? }. ctx.project is REQUIRED and
//       must return null ONLY for points behind the camera (as for nebulaItem). skyFade: the direction-only fade, default skyFade(cam, 1e5).
//       Shape (section 18.6.1). D = the distance in pc (INF_PC at infinity), r = D tan(major / 2), Mhat / mhat the major / minor directions on the sky
//       from the PA (north through east), uhat the direction to the galaxy, q = minor / major (cos i), i the inclination:
//         spirals, S0, irregulars, groups:  A = Mhat r,  B = r (beta mhat + s sin i uhat),  C = t r nhat,  nhat = M x (cos i m + s sin i u) the disc normal,
//             s = +-1 from hashUnit(id, 'tilt') (which side is nearer is not known), t the thickness (0.1, less when nearly edge-on),
//             beta the lateral part of B, chosen so that, seen from the Sun, the lateral width of B and C together is exactly r cos i: the screen ellipse
//             is the catalogue's major, minor and PA to 1e-6 (the perspective factor of the tilt included)
//         ellipticals (Hubble type starting with E):  A = Mhat r,  B = mhat r q,  C = uhat |B|  (the nebula depth rule; no depth at infinity)
//       Unknown parts as for nebulae: minor missing -> a circle (minorUnknown); PA missing -> the glow uses 180 deg * hashUnit(id, 'pa') and the
//       Evidence outline is a dashed circle of radius major / 2 (paUnknown); major missing -> a marker only.
//       item = { id, kind, billboard: 'galaxy', rel, dist, radiusUnits, rgb, look, hubble, shape, seed, tilt, mode, alpha, fade, skyFade, lineAlpha,
//         markerAlpha, pxRadius, semiMajorPx, semiMinorPx, angle, affine, cov, screen, inside, markerOnly, hollow, dashed, atInfinity, candidate: false,
//         paUnknown, minorUnknown }
//         look         galaxyLook(o).look: 'elliptical' | 'lenticular' | 'spiral' | 'barred_spiral' | 'irregular' | 'group'
//         hubble       the catalogue Hubble type text or null;  shape: the whole galaxyLook(o) (bulge, disc, arms, pitchDeg, bar, blobs, colour)
//                      plus barAzimuth: 180 deg * hashUnit(id, 'bar') in radians, the bar's angle in the disc plane (barred types)
//         affine       { a: [x, y], b: [x, y], c: [x, y] } the screen images (px, y DOWN) of A, B and C: the fragment shader's map from disc
//                      coordinates (unit disc = the catalogue ellipse) to the screen; null while inside
//         semiMajorPx, semiMinorPx, angle, cov, screen, inside   projectAxes of scene3d-nebula.js (null while inside)
//         alpha        galaxyBase(...) times skyFade (direction-only) or fade (placed); the glow does not depend on distance
//         fade         placed: smoothstep(1, 3, dist / physical semi-major), 0 while inside; direction-only: 1
//         lineAlpha    the Evidence outline's alpha: skyFade (direction-only) else 1; 0 while inside.   markerAlpha: skyFade (1 when placed)
//         markerOnly   semiMajorPx < 3, or no major axis (no glow, no outline: the marker is the object)
//         hollow       evidence 'derived';  dashed: outline mode and (hollow or paUnknown)
//         mode         'outline' (Evidence view) | 'glow'
//       Brightness (illustrative): alpha = clamp(0.35 10^(-0.4 (SB - 22.5)), 0.04, 0.6), SB = props.surface_brightness (mag/arcsec^2); without it SB comes
//       from the B magnitude (else render.mag, else V) and the ellipse as for nebulae, + 8.89 (arcmin^2 -> arcsec^2); without a magnitude 0.1.
//   milkyWayItem(entry, cam, ctx) -> item | null
//       entry: the visibleObjects entry of gal:milky_way (placed at Sgr A*). ctx = { project, evidence = false, galaxyFade? (default galaxyFade(cam)) }.
//       The true axes (section 18.7), from props.ngp_ra / ngp_dec (the north Galactic pole n), props.l_node (the galactic longitude of the ascending
//       node, which fixes the l = 0 direction x from n) and the centre: Ahat = y = n x x (l = 90), Bhat = -x (centre -> Sun), C = thin_disc_scale_height n,
//       the disc radius R = 6 thin_disc_scale_length. Same item shape as galaxyItem with billboard: 'milky_way', look 'milky_way', hubble null and
//         disc         { radiusUnits, scaleLength (1/6 of the disc radius), thickness (C over R) }
//         bar          { halfLength (bar_half_length / R), angle (rad), dir: [sin angle, cos angle] }  in disc coordinates (u along A, v along B): the bar's
//                      near end (toward the Sun) is at positive galactic longitude, so it leans from B toward +A by bar_angle
//         galaxyFade   the camera's galaxyFade;  alpha = base 0.3 x fade x (1 - galaxyFade), markerAlpha = 1 - galaxyFade, so it appears between 20 and
//                      40 kpc from the Sun as the stars fade
//         mode         'marker' in the Evidence view: no glow, no outline, only the centre marker (markerOnly, alpha 0, lineAlpha 0)
//       The frame-independent contract of galaxyItem holds here too.
//   galaxySurfacePc(o, distPc) -> pc       the surface distance a galaxy gives the auto-throttle (renderer, section 18.5.1): the distance from the centre minus the
//       semi-major axis, floored at GALAXY_INSIDE_K (5 %) of the distance so the speed never reaches zero inside it; the Milky Way counts only from outside its
//       drawn disc (inside it the stars set the speed: Infinity)
//   galaxyCoords(item, dx, dy) -> { u, v, du, dv }   the shader's coordinates of the screen offset (dx, dy) px from the item's centre: u, v in the projected ellipse
//       (unit on the ellipse), du, dv in the disc plane (the inverse of the affine map; 0 when the map is singular)
//   galaxyShaderParams(item) -> { mode, bulge, pitch, barHalf, barAz, scale, face, blobs }   the look as numbers for the galaxy fragment shader: mode 0 disc
//       (spirals, S0, the Milky Way), 1 elliptical, 2 irregular, 3 group; face 0..1 the disc's face-on weight (0 edge-on: a dark lane replaces the arms)
//   galaxyQuad(item, W, H, { quad = 1.3 }) -> Float32Array | null   6 vertices of GALAXY_VERTEX_FLOATS (18) floats: clip x y, u v, du dv, r g b alpha, mode, seed,
//       bulge, face, pitch (the blob count for a group), barHalf, barAz, scale. The screen bounding box of the item's ellipse, cut to the viewport
import * as F from './scene3d-frames.js';
import { smoothstep, radecToXyz, cross, norm } from './scene3d-math.js';
import { hashUnit, skyBasis } from './scene3d-orbits.js';
import { INF_PC, relOfEntry, skyFade, projectAxes } from './scene3d-nebula.js';
import { galaxyLook, galaxySemiMajorPc, isMilkyWay } from './scene3d-registry.js';

export const GALAXY_MIN_PX = 3, GALAXY_SKY_FADE_PC = 1e5, GALAXY_FADE_PC = [2e4, 4e4], MW_DISC_SCALES = 6;
const D2R = Math.PI / 180;
const MW_ALPHA = 0.3, MW_DEFAULTS = { ngp_ra: 192.85948, ngp_dec: 27.12825, l_node: 32.93192, thin_disc_scale_length: 2600, thin_disc_scale_height: 300, bar_half_length: 5000, bar_angle: 27 };

export function galaxyFade(cam) {
  const w = F.worldPc(cam), d = Math.hypot(w[0], w[1], w[2]);
  return 1 - smoothstep(GALAXY_FADE_PC[0], GALAXY_FADE_PC[1], d);
}

export const GALAXY_INSIDE_K = 0.05, GALAXY_VERTEX_FLOATS = 18;
export function galaxySurfacePc(o, distPc) {
  if (isMilkyWay(o)) {
    const q = o.props && o.props.thin_disc_scale_length, R = MW_DISC_SCALES * (q && Number.isFinite(q.v) ? q.v : MW_DEFAULTS.thin_disc_scale_length);
    return distPc > R ? distPc - R : Infinity;
  }
  return Math.max(distPc - (galaxySemiMajorPc(o) || 0), GALAXY_INSIDE_K * distPc);
}

const ARCMIN_PER ={ arcmin: 1, arcsec: 1 / 60, deg: 60 };
const arcminOf = (q) => (q && Number.isFinite(q.v) && ARCMIN_PER[q.unit || 'arcmin'] ? q.v * ARCMIN_PER[q.unit || 'arcmin'] : null);
const num = (q) => (q && Number.isFinite(q.v) ? q.v : null);
const scale = (v, k) => [v[0] * k, v[1] * k, v[2] * k];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** The glow's alpha before any fade (see the header). */
export function galaxyBase(o, aArcmin, bArcmin) {
  const pr = o.props || {};
  let sb = num(pr.surface_brightness);
  if (sb == null) {
    const mag = num(pr.mag_b) ?? (o.render && Number.isFinite(o.render.mag) ? o.render.mag : null) ?? num(pr.mag_v);
    if (mag == null || !(aArcmin > 0) || !(bArcmin > 0)) return 0.1;
    sb = mag + 2.5 * Math.log10(Math.PI * aArcmin * bArcmin) + 8.89;
  }
  return clamp(0.35 * Math.pow(10, -0.4 * (sb - 22.5)), 0.04, 0.6);
}

export function galaxyItem(e, cam, ctx = {}) {
  const { project, evidence = false } = ctx;
  if (typeof project !== 'function') return null;
  const o = e.o, p = o.position || {}, ang = (o.size && o.size.angular) || {};
  const rel = relOfEntry(e, cam);
  if (!rel || !Number.isFinite(p.ra) || !Number.isFinite(p.dec)) return null;
  const atInf = !!e.atInfinity, upc = F.unitsPerPc(cam), dist = Math.hypot(rel[0], rel[1], rel[2]);
  const sFade = atInf ? (ctx.skyFade != null ? ctx.skyFade : skyFade(cam, (e.spec && e.spec.skyFadePc) || GALAXY_SKY_FADE_PC)) : 1;
  const majorAm = arcminOf(ang.major), minorAm = arcminOf(ang.minor), paQ = ang.pa;
  const paKnown = !!paQ && Number.isFinite(paQ.v), minorUnknown = !(minorAm > 0), paUnknown = !paKnown;
  const hollow = e.spec.markerStyle(o) === 'hollow', mode = evidence ? 'outline' : 'glow';
  const L = galaxyLook(o), seed = hashUnit(e.id, 'look'), tilt = hashUnit(e.id, 'tilt') < 0.5 ? -1 : 1;
  const base = {
    id: e.id, kind: e.kind, billboard: 'galaxy', rel, dist, rgb: e.spec.color(o), look: L.look, hubble: L.hubble, shape: { ...L, barAzimuth: Math.PI * hashUnit(e.id, 'bar') },
    seed, tilt, mode, skyFade: sFade, hollow, atInfinity: atInf, candidate: false, paUnknown, minorUnknown, markerAlpha: sFade, screen: project(rel),
  };
  if (!(majorAm > 0)) {   // no angular size: only the marker
    return { ...base, radiusUnits: 0, alpha: 0, fade: 0, lineAlpha: 0, pxRadius: 0, semiMajorPx: 0, semiMinorPx: 0, angle: 0, affine: null, cov: null, inside: false, markerOnly: true, dashed: false };
  }
  const D = atInf ? INF_PC : Math.hypot(e.galPc[0], e.galPc[1], e.galPc[2]);
  const outlineCircle = evidence && paUnknown, minor = minorUnknown || outlineCircle ? majorAm : minorAm;
  const paDeg = paKnown ? paQ.v : evidence ? 0 : 180 * hashUnit(e.id, 'pa');
  const B0 = skyBasis(p.ra, p.dec), cp = Math.cos(paDeg * D2R), sp = Math.sin(paDeg * D2R), u = B0.u;
  const Mh = [0, 1, 2].map((k) => cp * B0.N[k] + sp * B0.E[k]), mh = [0, 1, 2].map((k) => -sp * B0.N[k] + cp * B0.E[k]);
  const rho = Math.tan((majorAm * D2R / 60) / 2), r = D * upc * rho;   // r: the physical semi-major axis in frame units
  const q = clamp(Math.tan((minor * D2R / 60) / 2) / rho, 0, 1);       // minor / major (cos i), from the tangents so the screen ratio is exact
  let axes;
  if (L.look === 'elliptical') {
    const B = scale(mh, r * q);
    axes = [scale(Mh, r), B, atInf ? null : scale(u, Math.hypot(...B))];
  } else {
    const ci = q, si = Math.sqrt(Math.max(1 - q * q, 0));
    const t = si > 0 ? Math.min(0.1, (0.99 * ci) / si) : 0.1;
    const kB = 1 / (1 - (rho * si) ** 2), kC = 1 / (1 - (t * rho * ci) ** 2);
    const beta = Math.sqrt(Math.max(ci * ci - (t * si * kC) ** 2, 0)) / kB;
    const nh = addv(scale(u, -ci), scale(mh, tilt * si));   // the disc normal: M x (cos i m + s sin i u)
    axes = [scale(Mh, r), addv(scale(mh, r * beta), scale(u, r * tilt * si)), scale(nh, r * t)];
  }
  const pj = projectAxes(rel, axes, project), inside = pj.inside, dashed = evidence && (hollow || paUnknown);
  if (inside) {
    return { ...base, radiusUnits: r, alpha: 0, fade: 0, lineAlpha: 0, pxRadius: Infinity, semiMajorPx: null, semiMinorPx: null, angle: null, affine: null, cov: null, inside: true, markerOnly: false, dashed };
  }
  const fade = atInf ? 1 : smoothstep(1, 3, dist / r);
  const alpha = galaxyBase(o, majorAm / 2, minor / 2) * (atInf ? sFade : fade);
  const { semiMajorPx, semiMinorPx, angle } = pj, markerOnly = semiMajorPx < GALAXY_MIN_PX;
  return { ...base, radiusUnits: r, alpha, fade, lineAlpha: sFade, pxRadius: semiMajorPx, semiMajorPx, semiMinorPx, angle, cov: pj.cov, affine: { a: pj.ax[0], b: pj.ax[1], c: pj.ax[2] },
    inside: false, markerOnly, dashed };
}

/** The Galactic axes in ICRS from the north pole and the node's longitude: { n, x, y } (unit vectors; x toward l = 0, y toward l = 90, n the pole). */
export function galacticAxes(ngpRa, ngpDec, lNodeDeg) {
  const n = radecToXyz(ngpRa, ngpDec, 1), a = ngpRa * D2R;
  const node = [-Math.sin(a), Math.cos(a), 0];                   // where the plane crosses the equator going north (RA = ngpRa + 90)
  const l = lNodeDeg * D2R, nxn = cross(n, node);
  const x = norm(addv(scale(node, Math.cos(l)), scale(nxn, -Math.sin(l))));   // the node is at longitude l_node: rotate it back by -l_node about n
  return { n, x, y: cross(n, x) };
}

export function milkyWayItem(e, cam, ctx = {}) {
  const { project, evidence = false } = ctx;
  if (typeof project !== 'function') return null;
  const o = e.o, pr = o.props || {}, rel = relOfEntry(e, cam);
  if (!rel) return null;
  const val = (k) => num(pr[k]) ?? MW_DEFAULTS[k];
  const upc = F.unitsPerPc(cam), dist = Math.hypot(rel[0], rel[1], rel[2]);
  const g = ctx.galaxyFade != null ? ctx.galaxyFade : galaxyFade(cam), present = 1 - g;
  const ax = galacticAxes(val('ngp_ra'), val('ngp_dec'), val('l_node'));
  const Rpc = MW_DISC_SCALES * val('thin_disc_scale_length'), R = Rpc * upc, zh = val('thin_disc_scale_height') * upc;
  const phi = val('bar_angle') * D2R;
  const base = {
    id: e.id, kind: e.kind, billboard: 'milky_way', rel, dist, radiusUnits: R, rgb: e.spec.color(o), look: 'milky_way', hubble: null, shape: galaxyLook(o), seed: hashUnit(e.id, 'look'),
    tilt: 1, skyFade: 1, hollow: false, atInfinity: false, candidate: false, paUnknown: false, minorUnknown: false, galaxyFade: g, markerAlpha: present, screen: project(rel),
    disc: { radiusUnits: R, scaleLength: 1 / MW_DISC_SCALES, thickness: zh / R },
    bar: { halfLength: val('bar_half_length') / Rpc, angle: phi, dir: [Math.sin(phi), Math.cos(phi)] },   // the near end leans from B (to the Sun) toward +A (positive l)
  };
  const marker = { ...base, mode: 'marker', alpha: 0, fade: 0, lineAlpha: 0, dashed: false };
  if (evidence) return { ...marker, pxRadius: 0, semiMajorPx: 0, semiMinorPx: 0, angle: 0, affine: null, cov: null, inside: false, markerOnly: true };
  const pj = projectAxes(rel, [scale(ax.y, R), scale(ax.x, -R), scale(ax.n, zh)], project);
  if (pj.inside) return { ...marker, mode: 'glow', pxRadius: Infinity, semiMajorPx: null, semiMinorPx: null, angle: null, affine: null, cov: null, inside: true, markerOnly: false };
  const fade = smoothstep(1, 3, dist / R);
  return { ...base, mode: 'glow', alpha: MW_ALPHA * fade * present, fade, lineAlpha: 0, dashed: false, pxRadius: pj.semiMajorPx, semiMajorPx: pj.semiMajorPx, semiMinorPx: pj.semiMinorPx,
    angle: pj.angle, cov: pj.cov, affine: { a: pj.ax[0], b: pj.ax[1], c: pj.ax[2] }, inside: false, markerOnly: pj.semiMajorPx < GALAXY_MIN_PX };
}

// ------------------------------------------------------------------ the renderer's quad
/** The shader coordinates of a screen offset from the item's centre (see the header). */
export function galaxyCoords(it, dx, dy) {
  const ct = Math.cos(it.angle || 0), sn = Math.sin(it.angle || 0), a = Math.max(it.semiMajorPx, 1e-6), b = Math.max(it.semiMinorPx, 0.5);
  const out = { u: (dx * ct + dy * sn) / a, v: (-dx * sn + dy * ct) / b, du: 0, dv: 0 };   // the inverse of px = c + u a (cos, sin) + v b (-sin, cos), y down
  const m = it.affine;
  if (m) {
    const det = m.a[0] * m.b[1] - m.a[1] * m.b[0];
    if (Math.abs(det) > 1e-9) { out.du = (dx * m.b[1] - dy * m.b[0]) / det; out.dv = (m.a[0] * dy - m.a[1] * dx) / det; }
  }
  return out;
}

const TAN = (deg) => Math.tan(deg * D2R);
export function galaxyShaderParams(it) {
  const sh = it.shape || {}, m = it.affine;
  let face = 1;
  if (m) {
    const det = Math.abs(m.a[0] * m.b[1] - m.a[1] * m.b[0]), a2 = m.a[0] * m.a[0] + m.a[1] * m.a[1];
    face = a2 > 0 ? smoothstep(0.03, 0.15, det / a2) : 0;   // |det| / |a|^2 is about the cosine of the inclination
  }
  const P = { mode: 0, bulge: 0.3, pitch: 0, barHalf: 0, barAz: 0, scale: 0.28, face, blobs: 0 };
  if (it.billboard === 'milky_way') {
    return { ...P, bulge: sh.bulge != null ? sh.bulge : 0.3, pitch: TAN(sh.pitchDeg || 15), barHalf: it.bar.halfLength, barAz: Math.PI / 2 - it.bar.angle, scale: it.disc.scaleLength };
  }
  if (it.look === 'elliptical') return { ...P, mode: 1, bulge: 1 };
  if (it.look === 'irregular') return { ...P, mode: 2, bulge: 0, scale: 0.35 };
  if (it.look === 'group') return { ...P, mode: 3, bulge: 0, blobs: sh.blobs || 2 };
  const spiral = it.look === 'spiral' || it.look === 'barred_spiral';
  return { ...P, bulge: sh.bulge != null ? sh.bulge : 0.3, pitch: spiral ? TAN(sh.pitchDeg || 15) : 0, barHalf: sh.bar ? 0.32 : 0, barAz: sh.barAzimuth || 0 };
}

export function galaxyQuad(it, W, H, { quad = 1.3 } = {}) {
  if (!it.screen || !(it.semiMajorPx > 0)) return null;
  const a = it.semiMajorPx, b = Math.max(it.semiMinorPx, 0.5), th = it.angle || 0, ct = Math.cos(th), sn = Math.sin(th);
  const ex = quad * (Math.abs(a * ct) + Math.abs(b * sn)), ey = quad * (Math.abs(a * sn) + Math.abs(b * ct));
  const x0 = Math.max(0, it.screen[0] - ex), x1 = Math.min(W, it.screen[0] + ex), y0 = Math.max(0, it.screen[1] - ey), y1 = Math.min(H, it.screen[1] + ey);
  if (!(x1 > x0 && y1 > y0)) return null;
  const P = galaxyShaderParams(it), data = new Float32Array(6 * GALAXY_VERTEX_FLOATS);
  let k = 0;
  for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
    const px = cx < 0 ? x0 : x1, py = cy < 0 ? y0 : y1, c = galaxyCoords(it, px - it.screen[0], py - it.screen[1]);
    data.set([px / W * 2 - 1, 1 - py / H * 2, c.u, c.v, c.du, c.dv, it.rgb[0], it.rgb[1], it.rgb[2], it.alpha, P.mode, it.seed * 97.0, P.bulge, P.face,
      P.mode === 3 ? P.blobs : P.pitch, P.barHalf, P.barAz, P.scale], k);
    k += GALAXY_VERTEX_FLOATS;
  }
  return data;
}

