// Maths for the 3D fly-through (scene3d.html). Pure and DOM-free, so node can test it (tests/scene3d.test.mjs).
//
// Coordinates are ICRS equatorial with the origin at the Sun: x points to RA 0 Dec 0, y to RA 90 Dec 0, z to the
// north celestial pole. Stars are in parsecs and the solar system in AU; nothing here depends on the unit.
// Matrices are column-major Float32Array(16), as WebGL expects: element (row r, column c) is m[c * 4 + r].

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const LY_PER_PC = 3.2615638;
export const OBLIQUITY_DEG = 23.4392911;   // mean obliquity at J2000, sets the ecliptic plane in ICRS

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// ---------------------------------------------------------------- coordinates
/** RA and Dec (degrees) at distance d -> ICRS x, y, z. */
export function radecToXyz(raDeg, decDeg, d = 1) {
  const ra = raDeg * D2R, dec = decDeg * D2R, c = d * Math.cos(dec);
  return [c * Math.cos(ra), c * Math.sin(ra), d * Math.sin(dec)];
}
/** ICRS x, y, z -> [RA in [0, 360), Dec] in degrees. The length is not returned; use Math.hypot for it. */
export function xyzToRadec(x, y, z) {
  let ra = Math.atan2(y, x) * R2D;
  if (ra < 0) ra += 360;
  if (ra >= 360) ra -= 360;
  const r = Math.hypot(x, y, z) || 1;
  return [ra, Math.asin(clamp(z / r, -1, 1)) * R2D];
}
/** Angle between two sky positions, degrees. atan2 form stays accurate for tiny separations. */
export function separationDeg(ra1, dec1, ra2, dec2) {
  const a = radecToXyz(ra1, dec1), b = radecToXyz(ra2, dec2);
  return Math.atan2(Math.hypot(...cross(a, b)), dot(a, b)) * R2D;
}
/** Direction from yaw (around +z, from +x) and pitch (up from the xy plane), both radians. */
export function dirFromYawPitch(yaw, pitch) {
  const c = Math.cos(pitch);
  return [c * Math.cos(yaw), c * Math.sin(yaw), Math.sin(pitch)];
}
export function yawPitchFromDir(d) {
  const n = norm(d);
  return { yaw: Math.atan2(n[1], n[0]), pitch: Math.asin(clamp(n[2], -1, 1)) };
}

// ---------------------------------------------------------------- photometry
/** Apparent magnitude of a star with absolute magnitude absMag at distance distPc. */
export function apparentMag(absMag, distPc) {
  return absMag + 5 * Math.log10(Math.max(distPc, 1e-6)) - 5;
}
// Colour ramp over BP-RP: blue, blue-white, white, yellow-white, yellow, orange, red. Linear between stops.
const BP_STOPS = [
  [-0.5, [0.61, 0.69, 1.0]],
  [0.0, [0.79, 0.84, 1.0]],
  [0.5, [0.98, 0.98, 1.0]],
  [0.9, [1.0, 0.95, 0.85]],
  [1.3, [1.0, 0.85, 0.6]],
  [2.0, [1.0, 0.7, 0.45]],
  [3.0, [1.0, 0.45, 0.35]],
];
/** BP-RP colour as [r, g, b] in 0..1. null (no colour known) is white-ish. */
export function bpRpToRgb(bpRp) {
  if (bpRp == null || !Number.isFinite(bpRp)) return [1, 0.97, 0.94];
  const x = clamp(bpRp, BP_STOPS[0][0], BP_STOPS[BP_STOPS.length - 1][0]);
  for (let i = 1; i < BP_STOPS.length; i++) {
    const [x1, c1] = BP_STOPS[i], [x0, c0] = BP_STOPS[i - 1];
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return c0.map((v, k) => v + (c1[k] - v) * t);
    }
  }
  return BP_STOPS[BP_STOPS.length - 1][1].slice();
}
/** Rough BP-RP from Johnson B-V for the XHIP stars (good to a few tenths, enough for colour). */
export function bvToBpRp(bv) {
  return bv == null || !Number.isFinite(bv) ? null : 1.2 * bv + 0.02;
}

// ---------------------------------------------------------------- star lists and geometry
/**
 * Bright context stars from data/rewind-stars.json (rows with a `fields` header and a `names` map keyed by HIP).
 * Keeps stars with parallax above minPlx mas. Distance is 1000/parallax, and absolute magnitude follows from V.
 */
export function contextStars(data, minPlx = 0.5) {
  const f = data.fields || [];
  const I = { hip: f.indexOf('hip'), ra: f.indexOf('ra_deg'), dec: f.indexOf('dec_deg'), plx: f.indexOf('plx_mas'), v: f.indexOf('vmag'), bv: f.indexOf('bv') };
  const names = data.names || {};
  const out = [];
  for (const row of data.stars || []) {
    const plx = row[I.plx], vmag = row[I.v];
    if (!(plx > minPlx) || !Number.isFinite(vmag)) continue;
    const d = 1000 / plx, hip = row[I.hip];
    out.push({ hip, name: names[hip] || null, ra: row[I.ra], dec: row[I.dec], d, vmag, absMag: vmag + 5 - 5 * Math.log10(d), bpRp: bvToBpRp(row[I.bv]) });
  }
  return out;
}
/**
 * The edge of a sky cone, seen from the origin: a ring at angular radius radiusDeg around (ra, dec), at distance dist,
 * plus four spokes from the origin to the ring. Returns polylines, each an array of [x, y, z].
 */
export function coneLines(raDeg, decDeg, radiusDeg, dist, n = 96) {
  const c = radecToXyz(raDeg, decDeg, 1);
  const e1 = norm(cross(c, Math.abs(c[2]) > 0.99 ? [1, 0, 0] : [0, 0, 1]));
  const e2 = cross(c, e1);
  const ct = Math.cos(radiusDeg * D2R), st = Math.sin(radiusDeg * D2R);
  const at = (phi) => {
    const cp = Math.cos(phi), sp = Math.sin(phi);
    return [0, 1, 2].map((k) => (c[k] * ct + (e1[k] * cp + e2[k] * sp) * st) * dist);
  };
  const ring = [];
  for (let i = 0; i <= n; i++) ring.push(at((2 * Math.PI * i) / n));
  const spokes = [0, 1, 2, 3].map((k) => [[0, 0, 0], at((k * Math.PI) / 2)]);
  return [ring, ...spokes];
}
/** A circle in the ecliptic plane (the planets' orbital plane) of the given radius around the Sun, as a polyline. */
export function orbitCircle(radius, n = 180) {
  // Ecliptic x is ICRS x; ecliptic y is (0, cos e, sin e) in ICRS.
  const eps = OBLIQUITY_DEG * D2R, u = [1, 0, 0], v = [0, Math.cos(eps), Math.sin(eps)];
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n, ca = Math.cos(a), sa = Math.sin(a);
    pts.push([0, 1, 2].map((k) => radius * (ca * u[k] + sa * v[k])));
  }
  return pts;
}

// ---------------------------------------------------------------- matrices and camera
/** Column-major product a * b. */
export function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}
/** Perspective projection with OpenGL clip conventions (depth -1..1). fovy in radians. */
export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
/**
 * Rotation that takes the direction `dir` to view-space -Z, with `up` kept as up. The rows of the view rotation are
 * right, up and -forward, so a point straight ahead lands on the negative z axis.
 */
export function lookRotation(dir, up = [0, 0, 1]) {
  const f = norm(dir), r = norm(cross(f, up)), u = cross(r, f);
  return new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, 0, 0, 0, 1]);
}
/** World-to-view matrix for a camera at `eye` looking along `dir`. */
export function viewMatrix(eye, dir, up = [0, 0, 1]) {
  const m = lookRotation(dir, up);
  m[12] = -(m[0] * eye[0] + m[4] * eye[1] + m[8] * eye[2]);
  m[13] = -(m[1] * eye[0] + m[5] * eye[1] + m[9] * eye[2]);
  m[14] = -(m[2] * eye[0] + m[6] * eye[1] + m[10] * eye[2]);
  return m;
}
/** m * (p, 1) -> [x, y, z, w]. */
export function transformPoint(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

// ---------------------------------------------------------------- exposure, level of detail, impostor quads
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const KM_PER_AU = 149597870.7;
/** Equatorial radii in km of the bodies drawn as spheres in the Sun's system. */
export const PLANET_KM = { Mercury: 2440, Venus: 6052, Earth: 6378, Moon: 1737, Mars: 3396, Jupiter: 71492, Saturn: 60268, Uranus: 25559, Neptune: 24764 };
/** Angular radius (CSS px) below which a star is only a point, and above which it is only a sphere. */
export const LOD_POINT_PX = 0.5, LOD_SPHERE_PX = 3;
/** Weight of the sphere in the point-to-sphere crossfade (the point gets 1 - weight, so flux is conserved). */
export const sphereWeight = (angPx) => smoothstep(LOD_POINT_PX, LOD_SPHERE_PX, angPx);
/** Angular radius in radians of a sphere of radius r seen from distance d (same units). pi/2 when inside. */
export const angRadius = (r, d) => (d <= r ? Math.PI / 2 : Math.asin(r / d));

// A point sprite's pre-exposure intensity is v = 0.3 * sqrt(flux), flux = 10^(-0.4 (m - limit)): the compressive law the
// tier 1 renderer used, so the galaxy view keeps its look. Exposure only drops once v passes V_EXPO (a star far brighter
// than anything in the old view), so ordinary skies are untouched and a nearby star dims everything else.
export const V_EXPO = 1000;
export const spriteV = (m, limit) => 0.3 * Math.pow(10, -0.2 * (m - limit));
export const exposureFor = (vBrightest) => (vBrightest > V_EXPO ? V_EXPO / vBrightest : 1);
/** Ease log(exposure) toward its target with time constant tau seconds. */
export const easeExposure = (cur, target, dt, tau = 0.25) => cur * Math.pow(target / cur, 1 - Math.exp(-dt / tau));
/** Surface radiance of a star's disc (linear HDR, before tonemapping): hotter stars are brighter, within limits. */
export const discRadiance = (teff) => clamp(Math.pow(teff / 5800, 2), 0.35, 2.2);

/**
 * The screen rectangle (NDC, [x0, y0, x1, y1]) that bounds a sphere's glow of radius ext, centred at view-space cv (the
 * camera looks down -z), with tanX and tanY the half-field tangents. 'full' when it may cover the screen, null when off screen.
 */
export function quadRect(cv, ext, tanX, tanY) {
  const dist = Math.hypot(cv[0], cv[1], cv[2]);
  if (dist <= ext * 1.02) return 'full';
  const theta = Math.acos(clamp(-cv[2] / dist, -1, 1)), alpha = Math.asin(ext / dist);
  if (theta - alpha > Math.atan(Math.hypot(tanX, tanY)) + 0.02) return null;
  if (theta + alpha > 1.45) return 'full';
  const rho = ((Math.tan(theta + alpha) - Math.tan(Math.max(theta - alpha, -1.4))) / 2) * 1.12 + 0.002;
  const ux = cv[0] / -cv[2], uy = cv[1] / -cv[2];
  const r = [(ux - rho) / tanX, (uy - rho) / tanY, (ux + rho) / tanX, (uy + rho) / tanY];
  if (r[2] < -1 || r[0] > 1 || r[3] < -1 || r[1] > 1) return null;
  return r.map((v) => clamp(v, -1, 1));
}
/** Rotate v by the 3x3 part of a view matrix (column-major, as lookRotation returns it), in doubles. */
export const rotateView = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
];

/**
 * The view-to-world rotation as a column-major mat3 for a shader, from R (column-major 4x4, world to view, rotation only).
 * It is R's upper 3x3 transposed: R's rows become the mat3's columns.
 */
export const viewToWorld3 = (R) => [R[0], R[4], R[8], R[1], R[5], R[9], R[2], R[6], R[10]];
