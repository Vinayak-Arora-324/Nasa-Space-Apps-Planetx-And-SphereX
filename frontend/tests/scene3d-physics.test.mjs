import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/blink/scene3d-physics.js';

test('teffToRgb: normalised, blue rises and red falls with temperature', () => {
  let prev = null;
  for (const T of [1000, 2000, 3000, 4000, 5772, 8000, 10000, 20000, 30000, 40000]) {
    const c = P.teffToRgb(T);
    assert.ok(Math.abs(Math.max(...c) - 1) < 1e-9, `max channel at ${T}`);
    c.forEach((v) => assert.ok(v >= 0 && Number.isFinite(v)));
    if (prev) { assert.ok(c[2] >= prev[2] - 1e-9, `blue ${T}`); assert.ok(c[0] <= prev[0] + 1e-9, `red ${T}`); }
    prev = c;
  }
  const sun = P.teffToRgb(5772);
  assert.ok(sun[0] >= sun[2] && sun[2] > 0.7, 'sun near-white, slightly warm');
  const m = P.teffToRgb(3000); assert.ok(m[0] === 1 && m[2] < 0.35);
  const b = P.teffToRgb(30000); assert.ok(b[2] === 1 && b[0] < 0.8);
  assert.deepEqual(P.teffToRgb(1), P.teffToRgb(1000));
});

test('teffFromBpRp: monotonic decreasing with anchors', () => {
  for (const giant of [false, true]) {
    let prev = Infinity;
    for (let c = -0.7; c <= 5; c += 0.05) {
      const T = P.teffFromBpRp(c, { giant });
      assert.ok(T <= prev + 1e-9 && T >= 2500 && T <= 40000);
      prev = T;
    }
  }
  const sun = P.teffFromBpRp(0.82);
  assert.ok(sun >= 5700 && sun <= 5850, String(sun));
  assert.ok(P.teffFromBpRp(1.8, { giant: true }) < 4000);
});

test('luminosity and radius round trip for the Sun', () => {
  const L = P.lumFromAbsG(4.67, 5772);
  assert.ok(Math.abs(L - 1) < 0.1, String(L));
  const R = P.radiusFromLumTeff(L, 5772);
  assert.ok(Math.abs(R - 1) < 0.1, String(R));
  assert.ok(Math.abs(P.bcG(5772) - 0.06) < 0.01);
  assert.equal(P.bcG(1000), P.bcG(4000));
  const u = [3000, 5772, 12000].map(P.limbDarkeningU);
  assert.ok(Math.abs(u[1] - 0.6) < 1e-9 && u[0] > u[1] && u[1] > u[2]);
});

const val = (v, tier = 'measured', src = 'test') => ({ v, lo: v * 0.98, hi: v * 1.02, src, tier });

test('starModel: system values win and keep tier', () => {
  const m = P.starModel({ system: { values: { teff_k: val(5000, 'catalogue', 'GSP'), radius_rsun: val(0.8), lum_lsun: val(0.4),
    bp_rp: val(1.0), g_mag: val(8), dist_pc: val(10), spectral_type: { v: 'K', src: 's', tier: 'catalogue' } }, notes: ['hi'] } });
  assert.equal(m.teff.v, 5000); assert.equal(m.teff.tier, 'catalogue'); assert.equal(m.teff.src, 'GSP');
  assert.equal(m.radiusRsun.tier, 'measured'); assert.equal(m.lumLsun.v, 0.4);
  assert.equal(m.spectralType.v, 'K'); assert.deepEqual(m.notes, ['hi']);
  assert.ok(Math.abs(m.radiusAu - 0.8 * P.RSUN_AU) < 1e-12);
});

test('starModel: missing values are inferred with a src', () => {
  const m = P.starModel({ absG: 4.67, bpRp: 0.82, distPc: 10 });
  assert.equal(m.teff.tier, 'inferred'); assert.match(m.teff.src, /BP−RP/);
  assert.equal(m.lumLsun.tier, 'inferred'); assert.match(m.lumLsun.src, /bolometric/);
  assert.match(m.radiusRsun.src, /Stefan/);
  assert.ok(Math.abs(m.radiusRsun.v - 1) < 0.15);
  assert.equal(m.isWhiteDwarf, false); assert.equal(m.isGiant, false);
});

test('starModel: giant, white dwarf and nothing at all', () => {
  const g = P.starModel({ absG: 0.5, bpRp: 1.2 });
  assert.ok(g.isGiant && g.radiusRsun.v > 5);
  const wd = P.starModel({ absG: 12, bpRp: 0.1 });
  assert.ok(wd.isWhiteDwarf); assert.equal(wd.radiusRsun.v, 0.012); assert.equal(wd.radiusRsun.tier, 'inferred');
  const wd2 = P.starModel({ system: { values: { wd_prob: val(0.9), bp_rp: val(0.2) } } });
  assert.ok(wd2.isWhiteDwarf);
  const e = P.starModel({});
  for (const k of ['teff', 'radiusRsun', 'lumLsun']) { assert.ok(Number.isFinite(e[k].v)); assert.equal(e[k].tier, 'inferred'); }
  assert.ok(e.notes.length > 0 && e.rgb.every(Number.isFinite) && Number.isFinite(e.radiusAu));
  assert.equal(P.starModel({ kind: 'sun' }).radiusRsun.v, 1);
});

test('fmtValue and tier tables', () => {
  assert.equal(P.fmtValue({ v: 5790, lo: 5710, hi: 5860 }, 'K', 0), '5,790 K (5,710–5,860)');
  assert.equal(P.fmtValue(null, 'K'), '—');
  assert.equal(P.fmtValue(1.234, 'R☉', 2), '1.23 R☉');
  assert.deepEqual(Object.keys(P.TIER_INFO), P.TIERS);
});

test('distance keeps its measured provenance', () => {
  const system = { values: { dist_pc: { v: 149.16, lo: 140, hi: 158, src: 'Bailer-Jones 2021 (geometric)', tier: 'measured' } } };
  const a = P.starModel({ system, distPc: 149.1607, absG: 4, bpRp: 0.8, kind: 'gaia' });
  assert.equal(a.distPc.tier, 'measured'); assert.equal(a.distPc.v, 149.16);
  const b = P.starModel({ distPc: 25, absG: 1, bpRp: 0.5, kind: 'ctx' });
  assert.equal(b.distPc.tier, 'measured'); assert.match(b.distPc.src, /Hipparcos/);
  assert.equal(b.bpRp.tier, 'inferred');
});

test('hot star with catalogue R and Teff gets Stefan–Boltzmann luminosity', () => {
  const v = (x, tier = 'catalogue') => ({ v: x, lo: null, hi: null, src: 'Gaia DR3', tier });
  const m = P.starModel({ system: { values: { teff_k: v(26322), radius_rsun: v(7.52), dist_pc: v(406.8, 'measured') } }, absG: -3.5, bpRp: -0.39, kind: 'gaia' });
  assert.match(m.lumLsun.src, /Stefan/);
  assert.ok(Math.abs(m.lumLsun.v - 7.52 ** 2 * (26322 / 5772) ** 4) / m.lumLsun.v < 1e-9);
  assert.ok(!m.notes.some((n) => /bolometric/.test(n)));
});

test('granulation: tiny on the Sun, large on a red supergiant, faint on hot stars', () => {
  const sun = P.granulation(P.starModel({ kind: 'sun' }));
  assert.ok(Math.abs(sun.size - 1.7e-3) < 1e-4, `sun ${sun.size}`);
  assert.ok(sun.contrast > 0.1 && sun.spots);
  const bet = P.granulation(P.starModel({ absG: -6, bpRp: 2.3, distPc: 200, kind: 'ctx' }));
  assert.ok(bet.size > 0.05, `supergiant ${bet.size}`);
  const hot = P.granulation(P.starModel({ absG: 1.7, bpRp: 0.19, distPc: 7.7, kind: 'ctx' }));
  assert.ok(hot.contrast < 0.05 && !hot.spots);
});
