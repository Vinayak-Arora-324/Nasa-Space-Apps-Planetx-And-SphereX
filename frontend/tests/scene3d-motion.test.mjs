// Motion layer (docs/object-framework.md section 20.4, 20.5, 20.13): two-body propagation, osculating elements, movers, validity, orbit lines and the summary text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { propagate, oscElements, compileMover, evalMover, moverValidity, oscPath, motionSummary, VIEW_JD_RANGE, WINDOW_DAYS, PHASE_SIGMA_MAX_DEG, MU_SUN } from '../js/blink/scene3d-motion.js';
import { GK, heliocentric, eclipticBasis } from '../js/blink/ephem.js';
import { orbitPlacement } from '../js/blink/scene3d-orbits.js';
import { jdFromCalendar } from '../js/blink/skytime.js';

const MJD0 = 2400000.5, D2R = Math.PI / 180, TAU = 2 * Math.PI, mu = MU_SUN;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const ERFA = JSON.parse(readFileSync(new URL('./fixtures/phase5-erfa.json', import.meta.url), 'utf8'));
const ORB = JSON.parse(readFileSync(new URL('./fixtures/phase5-orbits.json', import.meta.url), 'utf8')).records;
const SKY = JSON.parse(readFileSync(new URL('./fixtures/phase5-skybot-ceres.json', import.meta.url), 'utf8'));

// a fixed, generic rotation of the orbital plane into ICRS (not the identity, not the ecliptic)
const rot = (O, i, w) => {
  const cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(i), si = Math.sin(i), cw = Math.cos(w), sw = Math.sin(w);
  return { P: [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si], Q: [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si] };
};
const ROT = rot(1.1, 0.4, 2.3);
const comb = (x, y) => [0, 1, 2].map((k) => x * ROT.P[k] + y * ROT.Q[k]);

/** Closed-form ellipse: a, e, mean anomaly M0 at t = 0, evaluated at t days (independent Newton on Kepler's equation). */
function ellipse(a, e, M0, t) {
  const n = Math.sqrt(mu / (a * a * a)), M = M0 + n * t;
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 100; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const b = a * Math.sqrt(1 - e * e), k = n / (1 - e * Math.cos(E));
  return { r: comb(a * (Math.cos(E) - e), b * Math.sin(E)), v: comb(-a * Math.sin(E) * k, b * Math.cos(E) * k) };
}
/** Closed-form hyperbola (a < 0): mean anomaly M = e sinh H - H = n (t - T). */
function hyperbola(a, e, M0, t) {
  const n = Math.sqrt(mu / (-a * a * a)), M = M0 + n * t, b = -a * Math.sqrt(e * e - 1);
  let H = Math.asinh(M / e);
  for (let k = 0; k < 100; k++) H -= (e * Math.sinh(H) - H - M) / (e * Math.cosh(H) - 1);
  const k = n / (e * Math.cosh(H) - 1);
  return { r: comb(a * (Math.cosh(H) - e), b * Math.sinh(H)), v: comb(a * Math.sinh(H) * k, b * Math.cosh(H) * k) };
}

test('propagate matches the closed-form ellipse over +-1 yr at e = 0.08 and e = 0.968 (1P/Halley-like) to 1e-10 AU', () => {
  let worst = 0;
  for (const [a, e, M0] of [[2.77, 0.08, 0.7], [17.8, 0.968, -0.002], [17.8, 0.968, 3.0], [5.2, 0.5, 2.0], [1.0, 0.0167, 0]]) {
    const s0 = ellipse(a, e, M0, 0), warm = { chi: NaN };
    for (let t = -366; t <= 366; t += 6.1) {
      const want = ellipse(a, e, M0, t), out = [0, 0, 0, 0, 0, 0];
      assert.equal(propagate(s0.r, s0.v, mu, t, out, t % 2 ? warm : undefined), out);
      const dr = dist(out, want.r), dv = dist(out.slice(3), want.v);
      worst = Math.max(worst, dr);
      assert.ok(dr < 1e-10, `a ${a} e ${e} t ${t}: ${dr}`);
      assert.ok(dv < 1e-11, `velocity a ${a} e ${e} t ${t}: ${dv}`);
    }
  }
  console.log(`# propagate vs closed-form ellipse: max ${worst.toExponential(2)} AU`);
});

test('propagate: a hyperbola (e = 1.2) against the closed-form hyperbolic Kepler solution, and a parabola against Barker', () => {
  const a = -4, e = 1.2, s0 = hyperbola(a, e, -0.3, 0);
  for (let t = -366; t <= 366; t += 6.1) { const want = hyperbola(a, e, -0.3, t), out = propagate(s0.r, s0.v, mu, t, [0, 0, 0]); assert.ok(dist(out, want.r) < 1e-10, `hyperbola t ${t}: ${dist(out, want.r)}`); }
  assert.ok(propagate(s0.r, s0.v, mu, 20 * 365.25, [0, 0, 0]).every(Number.isFinite), 'far out on the hyperbola');
  // parabola, q = 0.9: Barker's equation D + D^3/3 = 2 (t - T) sqrt(mu / p^3), p = 2 q; r = q (1 + D^2), position q (1 - D^2), 2 q D in the orbital plane
  const q = 0.9, p = 2 * q, par = (t) => { const rhs = 2 * t * Math.sqrt(mu / (p * p * p)); let D = rhs; for (let k = 0; k < 200; k++) D -= (D + D * D * D / 3 - rhs) / (1 + D * D); return comb(q * (1 - D * D), 2 * q * D); };
  const r0 = par(-40), vq = Math.sqrt(2 * mu / q), eps = 1e-4, v0 = par(-40 + eps).map((x, k) => (x - par(-40 - eps)[k]) / (2 * eps));
  for (let t = -40; t <= 300; t += 17) assert.ok(dist(propagate(r0, v0, mu, t + 40, [0, 0, 0]), par(t)) < 1e-6, `parabola t ${t}`);
  assert.ok(vq > 0);
});

test('propagate: dt = 0 returns the state, a full period returns it, and the warm start does not change the result', () => {
  const s = ellipse(3.1, 0.3, 1.0, 0), out = [0, 0, 0], P = TAU * Math.sqrt(3.1 ** 3 / mu);
  assert.deepEqual(propagate(s.r, s.v, mu, 0, out), s.r);
  assert.ok(dist(propagate(s.r, s.v, mu, P, out), s.r) < 1e-10);
  const warm = { chi: NaN };
  for (const t of [10, -300, 4000, 12, 11.9]) { const cold = propagate(s.r, s.v, mu, t, [0, 0, 0]); assert.ok(dist(propagate(s.r, s.v, mu, t, [0, 0, 0], warm), cold) < 1e-12); }
  assert.ok(Number.isFinite(warm.chi));
});

test('oscElements: elements -> state -> elements round-trip, in the ecliptic of J2000', () => {
  const B = eclipticBasis(2000), toIcrs = (v) => [0, 1, 2].map((k) => v[0] * B[0][k] + v[1] * B[1][k] + v[2] * B[2][k]);   // ecliptic -> ICRS
  const cases = [
    { a: 2.77, e: 0.08, i: 10.6, node: 80.3, w: 73.6, M: 40 }, { a: 17.8, e: 0.968, i: 162.2, node: 58.4, w: 111.3, M: 250 }, { a: 0.92, e: 0.19, i: 3.1, node: 330, w: 12, M: 200 },
    { a: -4, e: 1.2, i: 45, node: 200, w: 300, M: -0.4 }, { a: 5.2, e: 0.05, i: 1.3, node: 100.5, w: 273, M: 90 },
  ];
  for (const c of cases) {
    const R = rot(c.node * D2R, c.i * D2R, c.w * D2R), epoch = 2461360.0;
    let s;
    if (c.e < 1) { const n = Math.sqrt(mu / c.a ** 3), M = c.M * D2R; let E = M + c.e * Math.sin(M); for (let k = 0; k < 100; k++) E -= (E - c.e * Math.sin(E) - M) / (1 - c.e * Math.cos(E));
      const b = c.a * Math.sqrt(1 - c.e ** 2), k = n / (1 - c.e * Math.cos(E)); s = { x: c.a * (Math.cos(E) - c.e), y: b * Math.sin(E), vx: -c.a * Math.sin(E) * k, vy: b * Math.cos(E) * k }; }
    else { const n = Math.sqrt(mu / -(c.a ** 3)), M = c.M; let H = Math.asinh(M / c.e); for (let k = 0; k < 100; k++) H -= (c.e * Math.sinh(H) - H - M) / (c.e * Math.cosh(H) - 1);
      const b = -c.a * Math.sqrt(c.e * c.e - 1), k = n / (c.e * Math.cosh(H) - 1); s = { x: c.a * (Math.cosh(H) - c.e), y: b * Math.sinh(H), vx: c.a * Math.sinh(H) * k, vy: b * Math.cosh(H) * k }; }
    const mix = (x, y) => [0, 1, 2].map((k) => x * R.P[k] + y * R.Q[k]);
    const el = oscElements(toIcrs(mix(s.x, s.y)), toIcrs(mix(s.vx, s.vy)), mu, epoch);
    assert.ok(Math.abs(el.a - c.a) < 1e-9 * Math.abs(c.a), `a ${c.a}: ${el.a}`); assert.ok(Math.abs(el.e - c.e) < 1e-12);
    assert.ok(Math.abs(el.i - c.i) < 1e-9, `i ${c.i}: ${el.i}`); assert.ok(Math.abs(el.node - c.node) < 1e-9, `node ${c.node}: ${el.node}`); assert.ok(Math.abs(el.omega - c.w) < 1e-9, `omega ${c.w}: ${el.omega}`);
    assert.ok(Math.abs(el.q - c.a * (1 - c.e)) < 1e-12);
    if (c.e < 1) {
      assert.ok(Math.abs(el.period - TAU * Math.sqrt(c.a ** 3 / mu)) < 1e-8);
      const n = Math.sqrt(mu / c.a ** 3), M = Math.atan2(Math.sin(c.M * D2R), Math.cos(c.M * D2R)); assert.ok(Math.abs(el.tPeri - (epoch - M / n)) < 1e-7, `tPeri ${c.M}: ${el.tPeri - epoch}`);
    } else assert.equal(el.period, null);
  }
  // perihelion time of the propagated state: at tPeri the body is at distance q
  const s0 = ellipse(2.77, 0.08, 0.7, 0), el = oscElements(s0.r, s0.v, mu, 0);
  assert.ok(Math.abs(Math.hypot(...propagate(s0.r, s0.v, mu, el.tPeri, [0, 0, 0])) - el.q) < 1e-9);
  assert.ok(Math.abs(oscElements([1, 0, 0], [0, GK, 0], mu).e) < 1e-12, 'the circular orbit (v = k at 1 AU): e = 0');
});

// ---- Ceres from live SkyBoT (fixture: make_phase5_fixtures.py --skybot)
const ceres = SKY.answers.map((x) => x.raw[0]);
const state = (row) => ({ r: [row['position (au)'].x, row['position (au)'].y, row['position (au)'].z], v: [row['velocity (au/d)'].x, row['velocity (au/d)'].y, row['velocity (au/d)'].z], jd: row.ref_epoch });

test('Ceres: propagating SkyBoT\'s 2026-11-20 state 360 d reproduces SkyBoT\'s own later state within 0.0014 AU', () => {
  const s1 = state(ceres[0]), s2 = state(ceres[1]);
  assert.equal(s1.jd, 2461360); assert.equal(s2.jd, 2461720); assert.ok(SKY.fetched.startsWith('2026-11-'));
  const out = propagate(s1.r, s1.v, mu, s2.jd - s1.jd, [0, 0, 0]), d = dist(out, s2.r);
  assert.ok(d < 0.0014, `drift ${d} AU`);
  console.log(`# Ceres +360 d drift vs SkyBoT: ${d.toExponential(3)} AU (${(d / ceres[1]['dg (ua)'] / D2R).toFixed(4)} deg at its geocentric distance)`);
});

const ceresRecord = (payloadMjd = 61364, offset = [1.7e-4, -2.2e-4, 0.9e-4]) => {
  const s = state(ceres[0]), at = propagate(s.r, s.v, mu, payloadMjd + MJD0 - s.jd, [0, 0, 0]);
  return { id: 'mp:1', kind: 'dwarf_planet', host: 'ss:sun', position: { model: 'state', mjd: payloadMjd, xyz_au: at.map((x, k) => x + offset[k]), method: 'orbit-propagation', tier: 'catalogue',
    osc: { epoch_jd: s.jd, xyz_au: s.r, vxyz_au_d: s.v, frame: 'icrf-heliocentric', src: 'IMCCE SkyBoT state vector at its reference epoch', tier: 'catalogue' } } };
};

test('kepler mover: the anchor makes the drawn position at the payload epoch bit-exactly the server\'s xyz_au', () => {
  const rec = ceresRecord(), m = compileMover(rec, { payloadMjd: 61364 }), out = [9, 9, 9];
  assert.equal(m.model, 'kepler');
  assert.equal(evalMover(m, 61364, out), out); assert.deepEqual(out, rec.position.xyz_au);
  assert.deepEqual(evalMover(m, 61364 + 4e-10, [0, 0, 0]), rec.position.xyz_au);
  // continuity across the 1e-9 d edge (the body itself moves 0.01 AU/d * 3e-9 d = 3e-11 AU), and client + anchor elsewhere
  assert.ok(dist(evalMover(m, 61364 + 3e-9, [0, 0, 0]), rec.position.xyz_au) < 1e-10);
  const s = state(ceres[0]), p = propagate(s.r, s.v, mu, 61364 + 30 + MJD0 - s.jd, [0, 0, 0]);
  const got = evalMover(m, 61394, [0, 0, 0]); for (let k = 0; k < 3; k++) assert.ok(Math.abs(got[k] - (p[k] + m.anchor[k])) < 1e-15);
  assert.ok(Math.hypot(...m.anchor) < 1e-3, 'the anchor here is the injected 3e-4 AU offset');
  assert.equal(compileMover(rec).payloadMjd, 61364, 'payloadMjd defaults to position.mjd');
  assert.equal(m.elements.e > 0.05 && m.elements.e < 0.12, true, 'Ceres e ~ 0.08'); assert.ok(Math.abs(m.elements.period / 365.25 - 4.6) < 0.1);
});

test('ephem movers: planets, Earth and the Moon; the anchor is the server - client difference and the Sun gets no mover', () => {
  const d = ERFA.dates[3], mjd = d.jd - MJD0, H = heliocentric(d.jd);
  const server = { mercury: d.plan94.mercury, neptune: d.plan94.neptune, mars: d.plan94.mars, earth: d.epv00_earth_helio, moon: d.epv00_earth_helio.map((x, k) => x + d.moon98_gcrs[k]) };
  const rec = (name) => ({ id: `ss:${name}`, kind: name === 'moon' ? 'moon' : 'planet', host: 'ss:sun', provenance: { source: 'ephem' }, position: { model: 'state', mjd, xyz_au: server[name].map((x) => +x.toFixed(6)), method: 'ephemeris', tier: 'measured' } });
  assert.equal(compileMover({ id: 'ss:sun', kind: 'sun', host: 'ss:sun', position: { model: 'state', mjd, xyz_au: [0, 0, 0], method: 'ephemeris' } }, { payloadMjd: mjd }), null);
  for (const name of ['mercury', 'mars', 'neptune', 'earth', 'moon']) {
    const r = rec(name), m = compileMover(r, { payloadMjd: mjd }), out = [0, 0, 0];
    assert.equal(m.model, 'ephem'); assert.equal(m.body, name);
    assert.deepEqual(evalMover(m, mjd, out), r.position.xyz_au, `${name}: exact at the payload epoch`);
    const ref = name === 'earth' ? H.earth : name === 'moon' ? H.moon : H.planets[name];
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(m.anchor[k] - (r.position.xyz_au[k] - ref[k])) < 1e-15);
    if (name === 'earth') assert.ok(Math.hypot(...m.anchor) * 149597870.7 < 7000, 'Earth: the epv00 difference, under 7,000 km');
    // 100 days later: client(t) + anchor
    const later = evalMover(m, mjd + 100, [0, 0, 0]), H2 = heliocentric(d.jd + 100), ref2 = name === 'earth' ? H2.earth : name === 'moon' ? H2.moon : H2.planets[name];
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(later[k] - (ref2[k] + m.anchor[k])) < 1e-14, `${name} later`);
  }
  // the planets' anchors are only the server's rounding when both sides run plan94 (<= 1e-8 AU, section 20.4.1); here the server column is plan94 rounded to 1e-6
  assert.ok(Math.hypot(...compileMover(rec('mercury'), { payloadMjd: mjd }).anchor) < 1e-6);
  // moon-minus-earth is the geocentric Moon at every date, whatever the anchors
  const me = compileMover(rec('moon'), { payloadMjd: mjd }), ee = compileMover(rec('earth'), { payloadMjd: mjd });
  for (const dt of [0, 17, -400]) { const mo = evalMover(me, mjd + dt, [0, 0, 0]), ea = evalMover(ee, mjd + dt, [0, 0, 0]); assert.ok(Math.hypot(mo[0] - ea[0], mo[1] - ea[1], mo[2] - ea[2]) > 0.002 && Math.hypot(mo[0] - ea[0], mo[1] - ea[1], mo[2] - ea[2]) < 0.0028); }
  // unknown ids, non-ephem sources and fixed or malformed positions give null
  assert.equal(compileMover({ id: 'ss:pluto', host: 'ss:sun', position: { model: 'state', mjd, xyz_au: [1, 2, 3] } }, { payloadMjd: mjd }), null);
  assert.equal(compileMover({ id: 'ss:mars', host: 'ss:sun', provenance: { source: 'skybot' }, position: { model: 'state', mjd, xyz_au: [1, 2, 3] } }, { payloadMjd: mjd }), null);
  assert.equal(compileMover({ id: 'x', position: { model: 'fixed' } }), null);
  assert.equal(compileMover({ id: 'mp:2', host: 'ss:sun', position: { model: 'state', mjd, xyz_au: [1, 2, 3] } }, { payloadMjd: mjd }), null, 'a small body without osc cannot move');
  assert.equal(compileMover({ id: 'mp:2', host: 'ss:sun', position: { model: 'state', mjd, xyz_au: [1, 2, 3], osc: { epoch_jd: 2461360, xyz_au: [1, 2], vxyz_au_d: [0, 0, 0], frame: 'icrf-heliocentric' } } }, { payloadMjd: mjd }), null);
  assert.equal(compileMover({ id: 'mp:2', host: 'ss:sun', position: { model: 'state', mjd, xyz_au: [1, 2, 3], osc: { epoch_jd: 2461360, xyz_au: [1, 0, 0], vxyz_au_d: [0, 0.017, 0], frame: 'barycentric' } } }, { payloadMjd: mjd }), null);
});

test('an injected client replaces the browser ephemeris', () => {
  const client = { bodyHeliocentric: (jd, body, out) => { out[0] = jd - 2461000; out[1] = 0; out[2] = 0; return out; } };
  const m = compileMover({ id: 'ss:mars', host: 'ss:sun', position: { model: 'state', mjd: 61000.5, xyz_au: [10, 1, 1] } }, { payloadMjd: 61000.5, client });
  assert.deepEqual(evalMover(m, 61010.5, [0, 0, 0]), [20, 1, 1]);
});

test('orbit mover: equals orbitPlacement at any date; validity by phase sigma and phase source', () => {
  const trappist = ORB.find((r) => r.id === 'nea:TRAPPIST-1 b'), bh1 = ORB.find((r) => r.id === 'bh:Gaia BH1'), cyg = ORB.find((r) => r.id === 'bh:Cyg X-1');
  for (const rec of ORB) {
    const m = compileMover(rec, { payloadMjd: 61364 }), out = [0, 0, 0];
    assert.equal(m.model, 'orbit');
    for (const mjd of [15020, 40123.4, 57322.014193, 61364, 88069]) { const w = orbitPlacement(rec, mjd).xyzAu, g = evalMover(m, mjd, out); assert.equal(g, out); assert.ok(dist(g, w) < 1e-12); }
  }
  const mt = compileMover(trappist, { payloadMjd: 61364 }), mb = compileMover(bh1, { payloadMjd: 61364 }), mc = compileMover(cyg, { payloadMjd: 61364 });
  let v = moverValidity(mt, 57322.014193); assert.deepEqual([v.ok, v.reason], [true, null]); assert.ok(Math.abs(v.sigmaDeg) < 1e-9);
  v = moverValidity(mt, 15020); assert.ok(v.ok && v.sigmaDeg > 35 && v.sigmaDeg < 45, 'TRAPPIST-1 b at 1900: about 40 degrees');
  assert.ok(v.lo < 15020 + MJD0 && v.hi > 2488069.5, 'its 90-degree window covers the view range');
  v = moverValidity(mb, 15020); assert.ok(v.ok); assert.ok(v.sigmaDeg < 90);
  v = moverValidity(mc, 61364); assert.deepEqual([v.ok, v.reason, v.sigmaDeg], [true, 'assumed-phase', null]);
  assert.equal(PHASE_SIGMA_MAX_DEG, 90);
  const wide = { id: 'nea:wide b', host: 'x', position: { model: 'orbit', host_radec: [10, 10], elements: { period_d: { v: 10, lo: 9.9, hi: 10.1 }, a_au: { v: 0.1 }, e: { v: 0.2 }, t_peri_mjd: { v: 58000 } } }, props: {} };
  const mw = compileMover(wide, { payloadMjd: 58000 });
  v = moverValidity(mw, 58000 + 249); assert.equal(v.ok, true);
  v = moverValidity(mw, 58000 + 260); assert.deepEqual([v.ok, v.reason], [false, 'phase-sigma']); assert.ok(v.sigmaDeg > 90);
  assert.ok(Math.abs(v.hi - (58000 + MJD0 + 250)) < 1e-9 && Math.abs(v.lo - (58000 + MJD0 - 250)) < 1e-9);
});

test('validity of small bodies: ok inside +-1 yr of the osc epoch, reason osc-epoch beyond; ephem movers are always ok', () => {
  const m = compileMover(ceresRecord(), { payloadMjd: 61364 }), e0 = 2461360 - MJD0;
  assert.equal(WINDOW_DAYS, 365.25);
  for (const dt of [-365.25, -100, 0, 100, 365.25]) { const v = moverValidity(m, e0 + dt); assert.deepEqual([v.ok, v.reason], [true, null], `dt ${dt}`); }
  for (const dt of [-365.3, 400, 1000, -3650]) { const v = moverValidity(m, e0 + dt); assert.deepEqual([v.ok, v.reason], [false, 'osc-epoch'], `dt ${dt}`); }
  const v = moverValidity(m, e0); assert.equal(v.lo, 2461360 - 365.25); assert.equal(v.hi, 2461360 + 365.25);
  const planet = compileMover({ id: 'ss:mars', host: 'ss:sun', position: { model: 'state', mjd: 61364, xyz_au: [1, 1, 0] } }, { payloadMjd: 61364 });
  assert.deepEqual(moverValidity(planet, 15020).ok, true); assert.equal(moverValidity(planet, 88069).reason, null);
  assert.equal(VIEW_JD_RANGE.min, jdFromCalendar(1900, 1, 1)); assert.equal(VIEW_JD_RANGE.max, jdFromCalendar(2100, 1, 1));
  assert.equal(VIEW_JD_RANGE.min - MJD0, 15020); assert.equal(VIEW_JD_RANGE.max - MJD0, 88069);
});

test('evalMover writes only into the given array and keeps the mover\'s own arrays (no allocation)', () => {
  const planet = compileMover({ id: 'ss:earth', host: 'ss:sun', position: { model: 'state', mjd: 61364, xyz_au: [-0.2, 0.9, 0.39] } }, { payloadMjd: 61364 });
  const movers = [compileMover(ceresRecord(), { payloadMjd: 61364 }), planet, compileMover(ORB[0], { payloadMjd: 61364 }), compileMover(ORB[1], { payloadMjd: 61364 })];
  for (const m of movers) {
    const out = new Float64Array(3), anchor = m.anchor, server = m.server, keep = [anchor && anchor.slice(), server && server.slice()];
    for (let k = 0; k < 2000; k++) assert.equal(evalMover(m, 61364 + k * 0.37, out), out);
    assert.equal(m.anchor, anchor); assert.equal(m.server, server);
    assert.deepEqual([anchor && anchor.slice(), server && server.slice()], keep, 'the mover\'s state is not modified');
    assert.ok(out.every(Number.isFinite));
  }
  // the heap does not grow with the number of evaluations (a loose bound: the young generation may not have been collected)
  const m = movers[0], out = [0, 0, 0]; for (let k = 0; k < 2000; k++) evalMover(m, 61364 + k * 0.01, out);
  const before = process.memoryUsage().heapUsed; for (let k = 0; k < 200000; k++) evalMover(m, 61364 + (k % 700) * 0.31 + 1, out);
  assert.ok(process.memoryUsage().heapUsed - before < 8e6, `heap grew by ${process.memoryUsage().heapUsed - before} bytes over 200k evaluations`);
});

test('oscPath: the osculating ellipse of Ceres closes and contains the propagated body; a hyperbola is an arc within maxAu; the anchor is applied', () => {
  const rec = ceresRecord(), m = compileMover(rec, { payloadMjd: 61364 });
  const p = oscPath(m, 360); assert.equal(p.length, 3 * 361); assert.deepEqual([...p.slice(0, 3)], [...p.slice(3 * 360)]);
  const sample = (k) => [p[3 * k], p[3 * k + 1], p[3 * k + 2]];
  for (const dt of [-200, 0, 150, 365]) {
    const x = evalMover(m, 61364 + dt, [0, 0, 0]); let best = Infinity; for (let k = 0; k < 360; k++) best = Math.min(best, dist(sample(k), x));
    assert.ok(best < 0.03, `body at ${dt} d is ${best} AU from the path`);
  }
  assert.ok(dist(sample(0), [0, 0, 0]) > 1.5 && Math.hypot(...m.anchor) < 1e-3);
  // anchor applied: shifting the server position shifts the path by the same amount
  const shifted = compileMover(ceresRecord(61364, [1.7e-4 + 0.01, -2.2e-4, 0.9e-4]), { payloadMjd: 61364 }), ps = oscPath(shifted, 360);
  assert.ok(Math.abs(ps[0] - p[0] - 0.01) < 1e-12);
  // a hyperbola e = 1.2, q = 0.8 (a = -4): the arc within 50 AU, ends at 50 AU, perihelion in the middle at q
  const hs = hyperbola(-4, 1.2, 0.5, 0), hrec = { id: 'comet:I', host: 'ss:sun', position: { model: 'state', mjd: 61364, xyz_au: hs.r, osc: { epoch_jd: 2461364.5, xyz_au: hs.r, vxyz_au_d: hs.v, frame: 'icrf-heliocentric' } } };
  const hm = compileMover(hrec, { payloadMjd: 61364 }), hp = oscPath(hm, 100, 50), r = (k) => Math.hypot(hp[3 * k], hp[3 * k + 1], hp[3 * k + 2]);
  assert.ok(Math.abs(r(0) - 50) < 1e-9 && Math.abs(r(100) - 50) < 1e-9 && Math.abs(r(50) - 0.8) < 1e-9);
  for (let k = 0; k <= 100; k++) assert.ok(r(k) <= 50 + 1e-9);
  assert.throws(() => oscPath(compileMover(ORB[0], { payloadMjd: 61364 }), 10));
  // a long ellipse (a = 200 AU) is clipped to the arc as well; a short one closes
  const long = ellipse(200, 0.99, 0.0, 0), lrec = { id: 'comet:L', host: 'ss:sun', position: { model: 'state', mjd: 61364, xyz_au: long.r, osc: { epoch_jd: 2461364.5, xyz_au: long.r, vxyz_au_d: long.v, frame: 'icrf-heliocentric' } } };
  const lp = oscPath(compileMover(lrec, { payloadMjd: 61364 }), 50, 50); let rmax = 0; for (let k = 0; k <= 50; k++) rmax = Math.max(rmax, Math.hypot(lp[3 * k], lp[3 * k + 1], lp[3 * k + 2]));
  assert.ok(rmax <= 50 + 1e-9);
});

test('motionSummary: the time bar line, grouped by family, plurals, beyond-range counts and the empty case', () => {
  const eph = (kind, n) => Array.from({ length: n }, () => ({ kind, model: 'ephem', illustrative: false, valid: true }));
  const small = (n, bad = 0) => Array.from({ length: n }, (_, k) => ({ kind: ['asteroid', 'comet', 'dwarf_planet'][k % 3], model: 'kepler', illustrative: k < bad, valid: k >= bad }));
  const orb = (kind, n, ill = n, bad = 0) => Array.from({ length: n }, (_, k) => ({ kind, model: 'orbit', illustrative: k < ill, valid: k >= bad }));
  let s = motionSummary([...eph('planet', 8), ...eph('moon', 1), ...small(214, 12), ...orb('exoplanet', 7), ...orb('black_hole', 1)]);
  assert.equal(s.text, 'Moving: 8 planets and the Moon (ephemeris) · 214 small bodies (SkyBoT orbits, ±1 yr; 12 beyond their range) · 7 exoplanets ◌ (orbit orientation unknown) · 1 black hole ◌ (no phase epoch published)');
  assert.deepEqual(s.counts, { planets: 8, moon: 1, smallBodies: 214, exoplanets: 7, blackHoles: 1, other: {}, beyond: 12, illustrative: 8 + 12 });
  assert.equal(motionSummary([...eph('planet', 8), ...eph('moon', 1), ...small(3)]).text, 'Moving: 8 planets and the Moon (ephemeris) · 3 small bodies (SkyBoT orbits, ±1 yr)', 'no "beyond their range" when none');
  assert.equal(motionSummary(small(1)).text, 'Moving: 1 small body (SkyBoT orbits, ±1 yr)');
  assert.equal(motionSummary(eph('planet', 1)).text, 'Moving: 1 planet (ephemeris)');
  assert.equal(motionSummary(eph('moon', 1)).text, 'Moving: the Moon (ephemeris)');
  assert.equal(motionSummary([...orb('black_hole', 3, 0), ...orb('exoplanet', 1, 0)]).text, 'Moving: 1 exoplanet (measured orbits) · 3 black holes (measured orbits)');
  assert.equal(motionSummary(orb('black_hole', 4, 3)).text, 'Moving: 4 black holes (3 ◌ no phase epoch published)');
  assert.equal(motionSummary(orb('exoplanet', 2, 2, 1)).text, 'Moving: 2 exoplanets ◌ (orbit orientation unknown; 1 beyond their range)');
  assert.equal(motionSummary([]).text, ''); assert.equal(motionSummary([{ kind: 'star', model: 'fixed' }]).text, '');
  assert.equal(motionSummary(orb('brown_dwarf', 2, 0)).text, 'Moving: 2 brown dwarfs');
  assert.equal(motionSummary([]).counts.planets, 0);
});
