import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtQuantity, fmtNum, roundUncertainty, superscript, SCI_HI, SCI_LO } from '../js/blink/scene3d-format.js';
import * as R from '../js/blink/scene3d-registry.js';
import { fmtValue } from '../js/blink/scene3d-physics.js';

const q = (v, lo, hi) => ({ v, lo, hi });

test('Sgr A*\'s mass keeps its measured precision: 4.297 ± 0.012 × 10⁶ M☉, not 4,300,000', () => {
  assert.equal(fmtQuantity(q(4.297e6, 4.285e6, 4.309e6), 'M☉'), '4.297 ± 0.012 × 10⁶ M☉');
  // the same through the black-hole card (one shared formatter, no per-kind case)
  const sgr = { id: 'bh:Sgr A*', kind: 'black_hole', name: 'Sagittarius A*', host: null, parent: null, evidence: 'measured',
    position: { model: 'fixed', ra: 266.4, dec: -29.0, method: 'orbit-fit', dist: { v: 8277, lo: 8268, hi: 8286, unit: 'pc', tier: 'measured', src: 'GRAVITY 2022' } },
    size: { radius: { v: 1.269e7, lo: 1.265e7, hi: 1.273e7, unit: 'km', tier: 'inferred', src: 'Schwarzschild' }, angular: null },
    props: { mass: { v: 4.297e6, lo: 4.285e6, hi: 4.309e6, unit: 'Msun', tier: 'measured', src: 'GRAVITY 2022' } } };
  const rows = R.kindSpec('black_hole').card(sgr, { fromYou: null, evidence: false }).rows, row = (l) => rows.find((r) => r[0] === l)[1];
  assert.equal(row('Mass'), '4.297 ± 0.012 × 10⁶ M☉');
  assert.equal(row('Distance (orbit-fit)'), '8,277 ± 9 pc');
  assert.equal(row('Event horizon (r_s)'), '1.269 ± 0.004 × 10⁷ km');
});

test('a typical star distance and an exoplanet period are unchanged or better', () => {
  // a Bailer-Jones distance: the old card said '134.8 pc (134.2–135.4)'; the digits are the same, the uncertainty is stated
  assert.equal(fmtQuantity(q(134.8, 134.2, 135.4), 'pc'), '134.8 ± 0.6 pc');
  // the old card said '1.51 d' for TRAPPIST-1 b; its period is known to a few microdays
  assert.equal(fmtQuantity(q(1.510826, 1.51082, 1.510832), 'd'), '1.510826 ± 0.000006 d');
  // a star card value through the star card's fmtValue
  assert.equal(fmtValue(q(5790, 5710, 5860), 'K', 0), '5,790 +70/−80 K');
});

test('the uncertainty is rounded to 1-2 figures (PDG rule) and the value to the same decimal place', () => {
  assert.deepEqual(roundUncertainty(0.012), { place: -3, e: 0.012 });     // 120: two figures
  assert.deepEqual(roundUncertainty(0.34), { place: -2, e: 0.34 });       // 340: two figures
  assert.deepEqual(roundUncertainty(0.6), { place: -1, e: 0.6 });         // 600: one figure
  assert.deepEqual(roundUncertainty(0.96), { place: -1, e: 1 });          // 960: rounds up to 1.0
  assert.equal(fmtQuantity(q(8.94, 8.6, 9.28), 'M☉'), '8.94 ± 0.34 M☉');
  assert.equal(fmtQuantity(q(32.7, 31.88, 33.52), 'M☉'), '32.7 ± 0.8 M☉');
  assert.equal(fmtQuantity(q(5.3, 4.34, 6.26), ''), '5.3 ± 1.0');
  assert.equal(fmtQuantity(q(34.87, 34.53, 35.21), '°'), '34.87 ± 0.34°', 'degrees attach without a space');
});

test('asymmetric intervals: +hi/−lo, the precision set by the larger side', () => {
  assert.equal(fmtQuantity(q(2220, 2050, 2400), 'pc'), '2,220 +180/−170 pc');                // Cyg X-1, VLBA
  assert.equal(fmtQuantity(q(9.0, 8.4, 9.2), 'M☉'), '9.0 +0.2/−0.6 M☉');                     // V404 Cyg, as printed
  assert.equal(fmtQuantity(q(8600, 7000, 10600), 'pc'), '8,600 +2,000/−1,600 pc');           // GRS 1915+105
  assert.equal(fmtQuantity(q(1164.1, 1140.5, 1189.0), 'pc'), '1,164 +25/−24 pc');            // Gaia BH2
  assert.equal(fmtQuantity(q(1.2e6, 1.0e6, 1.5e6), 'M☉'), '1.20 +0.30/−0.20 × 10⁶ M☉');
  assert.equal(fmtQuantity(q(10, 10, 12), 'K'), '10.0 +2.0/−0.0 K', 'a one-sided interval');
  assert.equal(fmtQuantity(q(10, 9.9999, 12), 'K'), '10.0 +2.0/−0.1 K', 'a nonzero side never rounds to 0');
});

test('scientific notation above 1e5 and below 1e-3, only for values with an uncertainty', () => {
  assert.equal(SCI_HI, 1e5); assert.equal(SCI_LO, 1e-3);
  assert.equal(fmtQuantity(q(99000, 98000, 100000), 'pc'), '99,000 ± 1,000 pc');
  assert.equal(fmtQuantity(q(2.0e-4, 1.5e-4, 2.6e-4), ''), '2.0 +0.6/−0.5 × 10⁻⁴');
  assert.equal(fmtQuantity(q(-3.1e-5, -3.3e-5, -2.9e-5), ''), '-3.10 ± 0.20 × 10⁻⁵');
  assert.equal(superscript(-12), '⁻¹²');
  assert.equal(fmtQuantity({ v: 1.269e7 }, 'km'), '12,700,000 km', 'no uncertainty: the old 3 significant figures');
});

test('without an uncertainty the old behaviour is kept; string bounds pass through untouched', () => {
  assert.equal(fmtQuantity({ v: 12.4 }, 'pc'), '12.4 pc');
  assert.equal(fmtQuantity(1245), '1,250');
  assert.equal(fmtQuantity(q(134.84, 134.84, 134.84), 'pc'), '135 pc', 'a zero-width interval is no uncertainty');
  assert.equal(fmtQuantity({ v: 3, lo: 4, hi: 5 }, 'x'), '3 x (4–5)', 'an interval that does not bracket the value is shown as before');
  assert.equal(fmtQuantity({ v: '< 0.12' }, 'Mj'), '< 0.12 Mj');
  assert.equal(fmtQuantity({ v: ' > 3 ' }), '> 3');
  assert.equal(fmtQuantity(null, 'pc'), 'n/a pc');
  assert.equal(fmtValue({ v: 1.234 }, 'R☉', 2), '1.23 R☉');
  assert.equal(fmtNum(NaN), 'n/a');
  // a bound on a card row: the exoplanet card shows it verbatim, never as a number
  const o = { id: 'nea:x b', kind: 'exoplanet', name: 'x b', host: 'gdr3:1', parent: 'gdr3:1', evidence: 'illustrative',
    position: { model: 'orbit', elements: { period_d: { v: 3.2, lo: 3.1, hi: 3.3, unit: 'd', tier: 'measured' } } },
    size: { radius: { v: '< 1.2', unit: 'Rearth', tier: 'measured' } }, props: { mass: { v: '< 0.12', unit: 'Mjup', tier: 'measured' } } };
  const rows = R.kindSpec('exoplanet').card(o, { fromYou: null, evidence: false }).rows, row = (l) => rows.find((r) => r[0] === l)[1];
  assert.equal(row('Mass'), '< 0.12 Mj'); assert.equal(row('Radius'), '< 1.2 R⊕'); assert.equal(row('Orbital period'), '3.20 ± 0.10 d');
});
