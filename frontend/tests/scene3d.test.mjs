// Pure maths behind scene3d.html: coordinates, photometry, colour, matrices and the cone and orbit geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/blink/scene3d-math.js';

const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);

test('radecToXyz places the axes where the contract says', () => {
  const [x, y, z] = M.radecToXyz(0, 0, 10); close(x, 10); close(y, 0); close(z, 0);
  const [x2, y2, z2] = M.radecToXyz(90, 0, 10); close(x2, 0); close(y2, 10); close(z2, 0);
  const [x3, y3, z3] = M.radecToXyz(0, 90, 10); close(x3, 0, 1e-12); close(y3, 0, 1e-12); close(z3, 10);
});

test('radec <-> xyz round trip', () => {
  const cases = [[0, 0, 1], [83.82, -5.39, 250], [359.9, 45, 0.5], [200.1, -89.2, 4000], [12.5, 89.9, 3]];
  for (const [ra, dec, d] of cases) {
    const p = M.radecToXyz(ra, dec, d);
    close(Math.hypot(...p), d, 1e-9, 'length');
    const [ra2, dec2] = M.xyzToRadec(...p);
    close(ra2, ra, 1e-9, `ra ${ra}`); close(dec2, dec, 1e-9, `dec ${dec}`);
  }
  // RA is always returned in [0, 360)
  const [ra3] = M.xyzToRadec(1, -1e-12, 0);
  assert.ok(ra3 >= 0 && ra3 < 360, `ra wrap ${ra3}`);
});

test('separationDeg is the great-circle angle', () => {
  close(M.separationDeg(0, 0, 90, 0), 90, 1e-9);
  close(M.separationDeg(10, 20, 10, 20), 0, 1e-9);
  close(M.separationDeg(0, 89, 180, 89), 2, 1e-9);
});

test('apparentMag: absolute magnitude at 10 pc, and inverse-square falloff', () => {
  for (const M0 of [-2, 0, 4.83, 12]) {
    close(M.apparentMag(M0, 10), M0, 1e-12);
    close(M.apparentMag(M0, 100), M0 + 5, 1e-12);
  }
  assert.ok(Number.isFinite(M.apparentMag(0, 0)), 'd = 0 is clamped, not infinite');
});

test('bpRpToRgb: endpoints are blue and red, null is white-ish, output is in 0..1', () => {
  const blue = M.bpRpToRgb(-0.5), red = M.bpRpToRgb(3);
  assert.ok(blue[2] > blue[0], 'blue end has more blue than red');
  assert.ok(red[0] > red[2], 'red end has more red than blue');
  assert.ok(red[1] < red[0] && red[2] < red[1], 'red end is red, not orange');
  const white = M.bpRpToRgb(null);
  assert.ok(white.every((v) => v > 0.9), 'null is white-ish');
  // values beyond the ends clamp to the ends
  assert.deepEqual(M.bpRpToRgb(-9), blue);
  assert.deepEqual(M.bpRpToRgb(30), red);
  for (let x = -0.5; x <= 3; x += 0.1) for (const v of M.bpRpToRgb(x)) assert.ok(v >= 0 && v <= 1, `in range at ${x}`);
  // redder stars have a smaller blue component
  assert.ok(M.bpRpToRgb(0.2)[2] > M.bpRpToRgb(1.5)[2]);
});

test('bvToBpRp follows the rough relation and passes nulls through', () => {
  close(M.bvToBpRp(0), 0.02, 1e-12);
  close(M.bvToBpRp(1), 1.22, 1e-12);
  assert.equal(M.bvToBpRp(null), null);
});

test('lookRotation maps the look direction to -Z', () => {
  for (const dir of [[1, 0, 0], [0, 1, 0], [0.3, -0.5, 0.8], [-0.2, 0.1, -0.9]]) {
    const n = M.norm(dir);
    const [x, y, z, w] = M.transformPoint(M.lookRotation(n), n);
    close(x, 0, 1e-6); close(y, 0, 1e-6); close(z, -1, 1e-6); close(w, 1, 1e-6);
  }
});

test('viewMatrix puts a point ahead of the eye on the -Z axis, and the eye at the origin', () => {
  const eye = [3, -2, 5], dir = M.norm([1, 2, -0.5]);
  const V = M.viewMatrix(eye, dir);
  const [x, y, z] = M.transformPoint(V, [eye[0] + 4 * dir[0], eye[1] + 4 * dir[1], eye[2] + 4 * dir[2]]);
  close(x, 0, 1e-5); close(y, 0, 1e-5); close(z, -4, 1e-5);
  const [ex, ey, ez] = M.transformPoint(V, eye);
  close(ex, 0, 1e-5); close(ey, 0, 1e-5); close(ez, 0, 1e-5);
});

test('perspective: the centre of the view lands at the NDC centre, and depth maps to -1..1', () => {
  const P = M.perspective(Math.PI / 4, 16 / 9, 0.1, 100);
  const [x, y, z, w] = M.transformPoint(P, [0, 0, -10]);
  close(x / w, 0); close(y / w, 0);
  // depth: near plane -> -1, far plane -> +1, and in between it increases monotonically
  const ndcZ = (d) => { const [, , zz, ww] = M.transformPoint(P, [0, 0, -d]); return zz / ww; };
  close(ndcZ(0.1), -1, 1e-6, 'near');
  close(ndcZ(100), 1, 1e-4, 'far');
  assert.ok(ndcZ(1) < ndcZ(10) && ndcZ(10) < ndcZ(50), 'monotonic in depth');
});

test('yaw/pitch round trip', () => {
  for (const [yaw, pitch] of [[0, 0], [1.2, 0.4], [-2.5, -1.1]]) {
    const d = M.dirFromYawPitch(yaw, pitch);
    const r = M.yawPitchFromDir(d);
    close(r.yaw, yaw, 1e-9); close(r.pitch, pitch, 1e-9);
  }
});

test('contextStars keeps parallax above the cut and derives distance and absolute magnitude', () => {
  const data = {
    fields: ['hip', 'ra_deg', 'dec_deg', 'pmra_masyr', 'pmdec_masyr', 'plx_mas', 'rv_kms', 'vmag', 'bv'],
    names: { '11767': 'Polaris' },
    stars: [
      [11767, 37.95, 89.26, 0, 0, 10, null, 5, 0.6],
      [1, 10, 10, 0, 0, 0.4, null, 3, 0.1],      // parallax too small: dropped
      [2, 20, -10, 0, 0, null, null, 3, 0.1],    // no parallax: dropped
    ],
  };
  const out = M.contextStars(data);
  assert.equal(out.length, 1);
  const s = out[0];
  assert.equal(s.name, 'Polaris');
  close(s.d, 100, 1e-9, 'distance from parallax');
  close(s.absMag, 0, 1e-9, 'M = V + 5 - 5 log10(d)');
  close(s.bpRp, 1.2 * 0.6 + 0.02, 1e-12);
});

test('coneLines: ring at the cone radius and distance, spokes from the origin', () => {
  const [ra, dec, radius, dist] = [83.82, -5.39, 3, 3000];
  const [ring, ...spokes] = M.coneLines(ra, dec, radius, dist, 64);
  const dir = M.radecToXyz(ra, dec, 1);
  assert.equal(ring.length, 65);
  for (const p of ring) {
    close(Math.hypot(...p), dist, 1e-6, 'ring distance');
    close(M.dot(M.norm(p), dir), Math.cos(radius * M.D2R), 1e-9, 'angle from the centre');
  }
  assert.equal(spokes.length, 4);
  for (const s of spokes) { assert.deepEqual(s[0], [0, 0, 0]); close(Math.hypot(...s[1]), dist, 1e-6); }
});

test('orbitCircle lies in the ecliptic plane, which is tilted 23.44 degrees from the equator', () => {
  const r = 5.2;
  const pts = M.orbitCircle(r, 90);
  const eps = M.OBLIQUITY_DEG * M.D2R;
  const normal = [0, -Math.sin(eps), Math.cos(eps)];   // ecliptic north pole in ICRS
  assert.equal(pts.length, 91);
  for (const p of pts) {
    close(Math.hypot(...p), r, 1e-9, 'radius');
    close(M.dot(p, normal), 0, 1e-9, 'in plane');
  }
  // the ecliptic north pole sits at Dec = 90 - obliquity
  const [, decPole] = M.xyzToRadec(...normal);
  close(decPole, 90 - M.OBLIQUITY_DEG, 1e-6);
});

test('mul4 matches the usual column-major product', () => {
  const a = M.perspective(1, 1, 1, 10), b = M.viewMatrix([1, 2, 3], [0, 1, 0]);
  const ab = M.mul4(a, b);
  const p = [0.5, -0.25, -4];
  const direct = M.transformPoint(a, M.transformPoint(b, p).slice(0, 3));
  const combined = M.transformPoint(ab, p);
  for (let i = 0; i < 4; i++) close(combined[i], direct[i], 1e-4, `component ${i}`);
});
