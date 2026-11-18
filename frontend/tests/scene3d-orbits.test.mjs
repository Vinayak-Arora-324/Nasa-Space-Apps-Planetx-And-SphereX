import test from 'node:test';
import assert from 'node:assert/strict';
import { hashUnit, solveKepler, skyBasis, orbitPlacement, orbitPath, J2000_MJD } from '../js/blink/scene3d-orbits.js';

const q = (v, o = {}) => ({ v, src: 'test', tier: 'measured', ...o });
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const D2R = Math.PI / 180;
// TRAPPIST-1 b (section 16.13): transiting, i, omega and t_conj known, node unknown.
const trappist = (el = {}, extra = {}) => ({
  id: 'nea:TRAPPIST-1 b', kind: 'exoplanet', name: 'TRAPPIST-1 b', host: 'gdr3:1', parent: 'gdr3:1',
  position: { model: 'orbit', host_radec: [346.6263919, -5.0434618], phase_known: true, tier: 'illustrative', elements: {
    period_d: q(1.510826, { lo: 1.51082, hi: 1.510832 }), a_au: q(0.01154, { tier: 'catalogue' }), e: q(0.00622),
    i_deg: q(89.728), omega_deg: q(336.86), t_conj_mjd: q(57322.014193), t_peri_mjd: null, node_deg: null, ...el } },
  props: { disc_method: { v: 'Transit', src: 't', tier: 'catalogue' } }, ...extra,
});
const bare = (id, el = {}, props = {}, host = 'x') => ({
  id, kind: 'exoplanet', name: id, host, position: { model: 'orbit', host_radec: [100, 20], elements: {
    period_d: q(10), a_au: q(0.1), e: q(0.3), i_deg: null, omega_deg: null, t_peri_mjd: null, t_conj_mjd: null, node_deg: null, ...el } }, props });

test('hashUnit is FNV-1a 32-bit over UTF-8 of id#salt, divided by 2^32 (test vectors and an independent implementation)', () => {
  const vec = [['', '', 638357778], ['a', 'b', 1118607213], ['nea:51 Peg b', 'node', 498661936], ['nea:TRAPPIST-1 b', 'phase', 2708169220], ['nea:ε Eri b', 'node', 4113901871]];
  for (const [id, salt, h] of vec) assert.equal(hashUnit(id, salt), h / 4294967296, `${id}#${salt}`);
  const ref = (s) => { let h = 0x811c9dc5n; for (const b of Buffer.from(s, 'utf8')) { h ^= BigInt(b); h = (h * 0x01000193n) % 4294967296n; } return Number(h) / 4294967296; };
  for (const id of ['nea:Kepler-90 h', 'hip:1', 'nea:Ünïcode b', 'x'.repeat(200)]) for (const salt of ['node', 'incl', 'omega', 'phase']) assert.equal(hashUnit(id, salt), ref(`${id}#${salt}`));
  for (let i = 0; i < 100; i++) { const h = hashUnit('id' + i, 'node'); assert.ok(h >= 0 && h < 1); }
});

test('solveKepler: residual under 1e-12 at e = 0, 0.5 and 0.95, and clamping of e', () => {
  for (const e of [0, 0.5, 0.95]) for (let k = -20; k <= 40; k++) {
    const M = k * 0.37, E = solveKepler(M, e), Mw = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const Ew = ((E % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    assert.ok(Math.abs(Ew - e * Math.sin(Ew) - Mw) < 1e-12, `e ${e} M ${M}`);
  }
  assert.equal(solveKepler(1, 0), solveKepler(1, -3));
  assert.ok(Number.isFinite(solveKepler(2, 5)) && Math.abs(solveKepler(2, 5) - solveKepler(2, 0.99)) < 1e-15);
});

test('sky basis is orthonormal with Z toward the observer', () => {
  const B = skyBasis(123, -45);
  for (const v of [B.N, B.E, B.Z]) assert.ok(Math.abs(len(v) - 1) < 1e-12);
  assert.ok(Math.abs(dot(B.N, B.E)) < 1e-12 && Math.abs(dot(B.N, B.Z)) < 1e-12 && Math.abs(dot(B.E, B.Z)) < 1e-12);
  assert.ok(Math.abs(dot(B.Z, B.u) + 1) < 1e-12);
  assert.ok(Math.abs(dot(skyBasis(0, 0).N, [0, 0, 1]) - 1) < 1e-12);
});

test('placement: r stays between a(1-e) and a(1+e), and t and t + P agree', () => {
  const rec = bare('nea:ecc b', { e: q(0.6), t_peri_mjd: q(58000) });
  const a = 0.1, B = skyBasis(100, 20);
  for (let k = 0; k < 40; k++) {
    const t = 59000 + k * 0.77, p = orbitPlacement(rec, t), r = len(p.xyzAu);
    assert.ok(r >= a * 0.4 - 1e-12 && r <= a * 1.6 + 1e-12, `r ${r}`);
    const p2 = orbitPlacement(rec, t + 10);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(p.xyzAu[c] - p2.xyzAu[c]) < 1e-12);
    assert.ok(Math.abs(r - p.used.r) < 1e-12 && B);
  }
});

test('at conjunction the planet lies toward Earth: dot(xyz, -u) = r sin i, and it is nearest to us', () => {
  for (const [el, mj] of [[{}, 57322.014193], [{ e: q(0.5), omega_deg: q(40), i_deg: q(70) }, 57322.014193], [{ e: q(0.8), omega_deg: q(200), i_deg: q(30) }, 57322.014193]]) {
    const rec = trappist(el), B = skyBasis(...rec.position.host_radec);
    const p = orbitPlacement(rec, mj), r = len(p.xyzAu), i = p.used.incl * D2R;
    assert.ok(Math.abs(dot(p.xyzAu, B.Z) - r * Math.sin(i)) < 1e-12 * Math.max(1, r), 'toward Earth');
    assert.ok(dot(p.xyzAu, B.Z) > 0);
    assert.equal(p.phaseSource, 'conjunction'); assert.ok(Math.abs(p.phaseSigmaDeg) < 1e-9);
    const half = orbitPlacement(rec, mj + rec.position.elements.period_d.v / 2);       // half an orbit later it is on the far side (for e ~ 0)
    if (!el.e) assert.ok(dot(half.xyzAu, B.Z) < 0);
  }
});

test('periastron: the planet is at a(1-e) at t_peri; the phase source and an unknown phase', () => {
  const rec = bare('nea:peri b', { t_peri_mjd: q(58000) });
  const p = orbitPlacement(rec, 58000);
  assert.ok(Math.abs(len(p.xyzAu) - 0.1 * 0.7) < 1e-12); assert.equal(p.phaseSource, 'periastron'); assert.equal(p.assumed.phase, false);
  const u = orbitPlacement(bare('nea:peri b'), J2000_MJD);
  assert.equal(u.phaseSource, 'assumed'); assert.equal(u.assumed.phase, true); assert.equal(u.phaseSigmaDeg, null);
  assert.equal(J2000_MJD, 51544.5);
  // the assumed mean anomaly at J2000 is 360 * h(id, 'phase'): the radius there follows the same Kepler solution
  const M = 2 * Math.PI * hashUnit('nea:peri b', 'phase'), E = solveKepler(M, 0.3);
  assert.ok(Math.abs(u.used.r - 0.1 * (1 - 0.3 * Math.cos(E))) < 1e-12);
});

test('assumed values are stable per id, differ across ids, and carry assumed flags', () => {
  const a = orbitPlacement(bare('nea:A b', {}, {}, 'hostA'), 60000), a2 = orbitPlacement(bare('nea:A b', {}, {}, 'hostA'), 60000), b = orbitPlacement(bare('nea:B b', {}, {}, 'hostB'), 60000);
  assert.deepEqual(a, a2);
  assert.notEqual(a.used.node, b.used.node); assert.notEqual(a.used.incl, b.used.incl); assert.notEqual(a.used.omega, b.used.omega);
  assert.equal(a.used.node, 360 * hashUnit('hostA', 'node')); assert.equal(a.used.omega, 360 * hashUnit('nea:A b', 'omega'));
  assert.ok(Math.abs(a.used.incl - Math.acos(hashUnit('hostA', 'incl')) / D2R) < 1e-12 && a.used.incl >= 0 && a.used.incl <= 90);
  assert.deepEqual(a.assumed, { node: true, incl: true, omega: true, phase: true, ecc: false });
  const t = orbitPlacement(trappist(), 60000);                               // known i, omega, phase; node and nothing else assumed
  assert.deepEqual(t.assumed, { node: true, incl: false, omega: false, phase: false, ecc: false });
  assert.equal(t.used.incl, 89.728); assert.equal(t.used.omega, 336.86);
  const ill = orbitPlacement(bare('nea:C b', { e: q(0, { tier: 'illustrative' }) }), 60000);
  assert.equal(ill.assumed.ecc, true); assert.equal(ill.used.omega, 0, 'e = 0 gives omega 0');
  assert.equal(orbitPlacement(bare('nea:C b', { e: null }), 60000).assumed.ecc, true);
  assert.ok(orbitPlacement(bare('nea:C b', { e: q(2) }), 60000).used.ecc <= 0.99, 'e is clamped');
});

test('a transiting planet with unknown i gets 90 degrees, by method or by a conjunction time', () => {
  assert.equal(orbitPlacement(bare('nea:T b', {}, { disc_method: { v: 'Transit' } }), 60000).used.incl, 90);
  assert.equal(orbitPlacement(bare('nea:T b', { t_conj_mjd: q(58000) }), 60000).used.incl, 90);
  assert.notEqual(orbitPlacement(bare('nea:T b', {}, { disc_method: { v: 'Radial Velocity' } }), 60000).used.incl, 90);
});

test('phaseSigmaDeg = 360 |t - T0| sigmaP / P^2, null without a period interval', () => {
  const rec = trappist(), P = 1.510826, sig = (1.510832 - 1.51082) / 2;
  const p = orbitPlacement(rec, 57322.014193 + 1000);
  assert.ok(Math.abs(p.phaseSigmaDeg - (360 * 1000 * sig) / (P * P)) < 1e-9);
  assert.ok(Math.abs(orbitPlacement(rec, 57322.014193 - 1000).phaseSigmaDeg - p.phaseSigmaDeg) < 1e-9);
  assert.equal(orbitPlacement(trappist({ period_d: q(1.510826) }), 60000).phaseSigmaDeg, null);
});

test('unusable orbits give null', () => {
  assert.equal(orbitPlacement(bare('nea:N b', { period_d: null }), 60000), null);
  assert.equal(orbitPlacement(bare('nea:N b', { a_au: q('x') }), 60000), null);
  assert.equal(orbitPlacement({ id: 'x', position: { model: 'orbit' } }, 60000), null);
  const noRadec = bare('nea:N b'); delete noRadec.position.host_radec;
  assert.equal(orbitPlacement(noRadec, 60000), null); assert.deepEqual(orbitPath(noRadec), []);
});

test('orbitPath closes, stays on the orbit and contains the placement', () => {
  const rec = bare('nea:path b', { e: q(0.3), t_peri_mjd: q(58000) });
  const path = orbitPath(rec, 360);
  assert.equal(path.length, 361); assert.deepEqual(path[0], path[360]);
  for (const p of path) assert.ok(len(p) >= 0.1 * 0.7 - 1e-12 && len(p) <= 0.1 * 1.3 + 1e-12);
  assert.equal(orbitPath(rec).length, 181);
  for (const t of [58001.3, 58004.2, 58008.9]) {
    const x = orbitPlacement(rec, t).xyzAu, d = Math.min(...path.map((p) => len([p[0] - x[0], p[1] - x[1], p[2] - x[2]])));
    assert.ok(d < 0.1 * 0.03, `distance ${d}`);
  }
  // the path lies in one plane through the host (no out-of-plane drift)
  const n = [0, 1, 2].map(() => 0), a = path[0], b = path[90];
  const nrm = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; const nl = len(nrm);
  for (const p of path) assert.ok(Math.abs(dot(p, nrm) / nl) < 1e-12 && n);
});

test('the assumed node and inclination are per host: one system shares its plane, other hosts and planet-only values differ', () => {
  const b1 = orbitPlacement(bare('nea:S b', {}, {}, 'gdr3:7'), 60000), b2 = orbitPlacement(bare('nea:S c', {}, {}, 'gdr3:7'), 60000), o = orbitPlacement(bare('nea:T b', {}, {}, 'gdr3:8'), 60000);
  assert.equal(b1.used.node, b2.used.node); assert.equal(b1.used.incl, b2.used.incl);
  assert.notEqual(b1.used.node, o.used.node); assert.notEqual(b1.used.incl, o.used.incl);
  assert.notEqual(b1.used.omega, b2.used.omega, 'omega stays per planet');
  assert.equal(b1.used.node, 360 * hashUnit('gdr3:7', 'node'));
  // the same holds for the drawn ellipse, and a record without a host falls back to its own id
  const p1 = orbitPath(bare('nea:S b', { e: q(0) }, {}, 'gdr3:7'), 8), p2 = orbitPath(bare('nea:S c', { e: q(0) }, {}, 'gdr3:7'), 8);
  assert.ok(Math.abs(Math.hypot(...p1[0]) - 0.1) < 1e-12 && Math.abs(Math.hypot(...p2[0]) - 0.1) < 1e-12);
  const nh = orbitPlacement({ ...bare('nea:N b'), host: undefined }, 60000);
  assert.equal(nh.used.node, 360 * hashUnit('nea:N b', 'node'));
  // transiting planets keep i = 90 whatever the host's draw is
  assert.equal(orbitPlacement(bare('nea:S d', {}, { disc_method: { v: 'Transit' } }, 'gdr3:7'), 60000).used.incl, 90);
  // coplanar: two circular planets of one host with the same i have orbit normals that agree
  const nrm = (rec) => { const P = orbitPath(rec, 8), A = P[0], B = P[2]; const c = [A[1]*B[2]-A[2]*B[1], A[2]*B[0]-A[0]*B[2], A[0]*B[1]-A[1]*B[0]]; const l = len(c); return c.map((v) => v / l); };
  const n1 = nrm(bare('nea:S b', { e: q(0) }, {}, 'gdr3:7')), n2 = nrm(bare('nea:S c', { e: q(0), a_au: q(0.2) }, {}, 'gdr3:7'));
  assert.ok(Math.abs(Math.abs(dot(n1, n2)) - 1) < 1e-9);
});
