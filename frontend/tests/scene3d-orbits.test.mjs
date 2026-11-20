import test from 'node:test';
import assert from 'node:assert/strict';
import { hashUnit, solveKepler, skyBasis, orbitPlacement, orbitPath, J2000_MJD, compileOrbit, evalOrbit, phaseSigmaAt, orbitPathCompiled, orbitPathInto } from '../js/blink/scene3d-orbits.js';
import { readFileSync } from 'node:fs';

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

// ------------------------------------------------------------------------------------- Phase 5: compiled orbits (section 20.4.3)
const FIX = JSON.parse(readFileSync(new URL('./fixtures/phase5-orbits.json', import.meta.url), 'utf8')).records;   // fixtures/make_phase5_fixtures.py
const byId = (id) => FIX.find((r) => r.id === id);

/** The pre-Phase-5 orbitPlacement, kept here as an independent reference: Kepler solved per call with solveKepler, the true anomaly by atan2, the rotation per call. */
function referencePlacement(rec, mjd) {
  const el = rec.position.elements, fin = (x) => (x && Number.isFinite(x.v) ? x.v : null), P = fin(el.period_d), a = fin(el.a_au);
  const e = Math.min(Math.max(fin(el.e) ?? 0, 0), 0.99), sys = rec.host || rec.id, method = rec.props.disc_method && rec.props.disc_method.v;
  const tConj = fin(el.t_conj_mjd), tPeri = fin(el.t_peri_mjd);
  const node = fin(el.node_deg) ?? 360 * hashUnit(sys, 'node'), incl = fin(el.i_deg) ?? (method === 'Transit' || tConj != null ? 90 : Math.acos(hashUnit(sys, 'incl')) / D2R);
  const omega = fin(el.omega_deg) ?? (e > 0 ? 360 * hashUnit(rec.id, 'omega') : 0), w = omega * D2R, n = 2 * Math.PI / P;
  let M;
  if (tConj != null) { const nuC = Math.PI / 2 - w, Ec = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nuC / 2), Math.sqrt(1 + e) * Math.cos(nuC / 2)); M = Ec - e * Math.sin(Ec) + n * (mjd - tConj); }
  else if (tPeri != null) M = n * (mjd - tPeri);
  else M = 360 * hashUnit(rec.id, 'phase') * D2R + n * (mjd - J2000_MJD);
  const E = solveKepler(M, e), nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2)), r = a * (1 - e * Math.cos(E));
  const B = skyBasis(...rec.position.host_radec), u = w + nu, O = node * D2R, i = incl * D2R;
  const xn = r * (Math.cos(O) * Math.cos(u) - Math.sin(O) * Math.sin(u) * Math.cos(i)), ye = r * (Math.sin(O) * Math.cos(u) + Math.cos(O) * Math.sin(u) * Math.cos(i)), z = r * Math.sin(u) * Math.sin(i);
  return [0, 1, 2].map((k) => xn * B.N[k] + ye * B.E[k] + z * B.Z[k]);
}

test('the fixtures are the committed TRAPPIST-1 b, Gaia BH1 and Cyg X-1 records', () => {
  assert.equal(FIX.length, 3);
  const t = byId('nea:TRAPPIST-1 b'), b = byId('bh:Gaia BH1'), c = byId('bh:Cyg X-1');
  assert.equal(t.position.elements.t_conj_mjd.v, 57322.014193); assert.equal(b.position.elements.t_peri_mjd.v, 57387.4);
  assert.equal(c.position.elements.t_peri_mjd, null); assert.equal(c.position.elements.node_deg, null);
});

test('orbitPlacement equals the old per-call algorithm, and evalOrbit on a reused plan equals orbitPlacement, to 1e-12 AU at many dates', () => {
  let worstRef = 0, worstEval = 0;
  for (const rec of FIX) {
    const plan = compileOrbit(rec), out = [0, 0, 0];
    assert.ok(plan);
    // dates across 1900-2100 (MJD 15020-88069), in a shuffled order so the warm start sees jumps forward and back, plus the epochs themselves
    const dates = [];
    for (let k = 0; k < 400; k++) dates.push(15020 + ((k * 7919) % 400) * 73049 / 400 + (k % 7) * 0.137);
    dates.push(57322.014193, 57387.4, J2000_MJD, 60000);
    for (const mjd of dates) {
      const want = referencePlacement(rec, mjd), got = orbitPlacement(rec, mjd).xyzAu, warm = evalOrbit(plan, mjd, out);
      assert.equal(warm, out);
      for (let c = 0; c < 3; c++) { worstRef = Math.max(worstRef, Math.abs(got[c] - want[c])); worstEval = Math.max(worstEval, Math.abs(warm[c] - got[c])); }
    }
  }
  assert.ok(worstRef < 1e-12, `orbitPlacement vs the old algorithm: ${worstRef}`);
  assert.ok(worstEval < 1e-12, `evalOrbit (warm) vs orbitPlacement: ${worstEval}`);
  console.log(`# orbit equivalence: orbitPlacement vs old algorithm max ${worstRef.toExponential(2)} AU, warm evalOrbit vs orbitPlacement max ${worstEval.toExponential(2)} AU`);
});

test('compileOrbit: plan fields, phase sources, assumed flags and null for unusable records', () => {
  const t = compileOrbit(byId('nea:TRAPPIST-1 b')), b = compileOrbit(byId('bh:Gaia BH1')), c = compileOrbit(byId('bh:Cyg X-1'));
  assert.equal(t.source, 'conjunction'); assert.equal(b.source, 'periastron'); assert.equal(c.source, 'assumed');
  assert.deepEqual(t.assumed, { node: true, incl: false, omega: false, phase: false, ecc: false });
  assert.deepEqual(b.assumed, { node: false, incl: false, omega: false, phase: false, ecc: false });
  assert.equal(c.assumed.phase, true); assert.equal(c.phaseEpoch, null); assert.equal(c.P, 5.599829);
  assert.equal(compileOrbit({ id: 'x', position: { model: 'orbit' } }), null);
  assert.equal(compileOrbit(bare('nea:N b', { period_d: null })), null);
  // P3 and Q3 are orthonormal (the orbit plane basis) and the plan stays consistent with orbitPlacement's `used`
  for (const p of [t, b, c]) {
    assert.ok(Math.abs(len(p.P3) - 1) < 1e-12 && Math.abs(len(p.Q3) - 1) < 1e-12 && Math.abs(dot(p.P3, p.Q3)) < 1e-12);
  }
  const used = orbitPlacement(byId('bh:Gaia BH1'), 60000).used;
  assert.equal(used.node, 277.8); assert.equal(used.incl, 126.6); assert.equal(used.omega, 12.8);
});

test('phaseSigmaAt = 360 |t - T0| sigmaP / P^2 from the plan, equal to orbitPlacement.phaseSigmaDeg; null when assumed', () => {
  const rec = byId('nea:TRAPPIST-1 b'), plan = compileOrbit(rec), sig = (rec.position.elements.period_d.hi - rec.position.elements.period_d.lo) / 2, P = rec.position.elements.period_d.v;
  for (const mjd of [15020, 40000, 57322.014193, 60000, 88069]) {
    assert.ok(Math.abs(phaseSigmaAt(plan, mjd) - 360 * Math.abs(mjd - 57322.014193) * sig / (P * P)) < 1e-9);
    assert.equal(phaseSigmaAt(plan, mjd), orbitPlacement(rec, mjd).phaseSigmaDeg);
  }
  assert.ok(Math.abs(phaseSigmaAt(plan, 15020) - 40) < 2, 'TRAPPIST-1 b at 1900: about 40 degrees (section 20.15)');
  assert.equal(phaseSigmaAt(compileOrbit(byId('bh:Cyg X-1')), 60000), null);
  assert.equal(phaseSigmaAt(compileOrbit(trappist({ period_d: q(1.510826) })), 60000), null);
});

test('the phase-sigma demotion: a measured orbit with a wide period interval passes 90 degrees at the date the formula says', () => {
  const rec = bare('nea:wide b', { period_d: q(10, { lo: 9.9, hi: 10.1 }), t_peri_mjd: q(58000) });     // sigmaP = 0.1 d -> 90 deg at |t - T0| = 90 P^2 / (360 sigmaP) = 250 d
  const plan = compileOrbit(rec);
  assert.ok(phaseSigmaAt(plan, 58000 + 249) < 90 && phaseSigmaAt(plan, 58000 + 251) > 90);
  assert.ok(Math.abs(phaseSigmaAt(plan, 58000 + 250) - 90) < 1e-9);
});

test('evalOrbit does not allocate: it fills the given array (also a Float64Array) and warm-starts to the same answer as a cold plan', () => {
  const rec = byId('bh:Gaia BH1'), plan = compileOrbit(rec), f64 = new Float64Array(3);
  assert.equal(evalOrbit(plan, 60000, f64), f64);
  const cold = evalOrbit(compileOrbit(rec), 60000.5, [0, 0, 0]);
  evalOrbit(plan, 60000.4, f64); evalOrbit(plan, 60000.5, f64);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(f64[c] - cold[c]) < 1e-13);
  // a very eccentric orbit stepped through many periods in both directions stays on the Kepler solution
  const hot = bare('nea:hot b', { e: q(0.95), t_peri_mjd: q(58000) }), hp = compileOrbit(hot);
  for (const mjd of [58000, 58003, 57990, 59000, 58000.001, 70000, 40000]) {
    const w = referencePlacement(hot, mjd), g = evalOrbit(hp, mjd, [0, 0, 0]);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(g[c] - w[c]) < 1e-12, `e 0.95 at ${mjd}`);
  }
});

test('orbitPathCompiled and orbitPathInto give orbitPath: same points, closed, and the placement lies on them', () => {
  for (const rec of FIX) {
    const plan = compileOrbit(rec), path = orbitPath(rec, 200), pc = orbitPathCompiled(plan, 200), flat = orbitPathInto(plan, 200, new Float64Array(603));
    assert.deepEqual(pc, path); assert.equal(path.length, 201); assert.deepEqual(path[0], path[200]);
    for (let i = 0; i <= 200; i++) for (let c = 0; c < 3; c++) assert.equal(flat[3 * i + c], path[i][c]);
    const x = evalOrbit(plan, 60123.4, [0, 0, 0]), d = Math.min(...path.map((p) => len([p[0] - x[0], p[1] - x[1], p[2] - x[2]])));
    assert.ok(d < 0.1 * plan.a, `${rec.id}: placement ${d} from the path`);
  }
});
