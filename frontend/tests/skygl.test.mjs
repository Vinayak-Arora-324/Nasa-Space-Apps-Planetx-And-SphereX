import test from 'node:test';
import assert from 'node:assert/strict';
import { _internal as I, mitchell, SkyRenderer } from '../js/blink/skygl.js';

test('mitchell kernel: partition of unity, symmetry, support', () => {
  for (const f of [0, 0.1, 0.37, 0.5, 0.9]) {
    let s = 0; for (let k = -1; k <= 2; k++) s += mitchell(k - f);
    assert.ok(Math.abs(s - 1) < 1e-12, `sum ${s}`);
  }
  assert.equal(mitchell(2), 0); assert.equal(mitchell(3), 0);
  assert.ok(Math.abs(mitchell(0.4) - mitchell(-0.4)) < 1e-15);
  assert.ok(Math.abs(mitchell(0) - 16 / 18) < 1e-12);
});

test('stretch functions map 0->0 and 1->1 and are monotone', () => {
  for (const f of Object.values(I.STRETCH_FN)) {
    assert.ok(Math.abs(f(0)) < 1e-12); assert.ok(Math.abs(f(1) - 1) < 1e-12);
    let p = -1; for (let t = 0; t <= 1; t += 0.05) { assert.ok(f(t) >= p); p = f(t); }
  }
});

test('mapValue / colorOf: black point is ground, symmetric zero is mid', () => {
  assert.deepEqual(I.colorOf(I.mapValue(0.1, 0.1, 2, false, 'asinh'), false).map(Math.round), [5, 7, 11]);
  assert.deepEqual(I.colorOf(I.mapValue(0, -1, 1, true, 'linear'), true).map(Math.round), [23, 26, 32]);
  assert.ok(I.mapValue(1, -1, 1, true, 'linear') > 0.99 && I.mapValue(-1, -1, 1, true, 'linear') < 0.01);
  assert.equal(I.symLimit({ lo: -2, hi: 1 }), 2);
  assert.equal(I.symLimit({ lo: 0, hi: 1, sym: 0.3 }), 0.3);
});

test('glow size grows with flux, has a floor, grows with uncertainty and extended fwhm', () => {
  const a = I.glowSigmaCss(0.001), b = I.glowSigmaCss(0.1), c = I.glowSigmaCss(10), d = I.glowSigmaCss(1e6);
  assert.ok(a >= I.GLOW_DEFAULTS.min && a <= b && b < c && c < d);
  const base = I.glowSigmas({ flux: 1, kind: 'point' }, 10)[0];
  const [sx, sy] = I.glowSigmas({ flux: 1, kind: 'point', sx: 0.5, sy: 0.1 }, 10);
  assert.ok(sx > base && sx > sy);
  assert.ok(I.glowSigmas({ flux: 1, kind: 'extended', fwhm: 6 }, 10)[0] > I.glowSigmas({ flux: 1, kind: 'extended', fwhm: 6 }, 1)[0]);
});

test('view transforms are inverse; col 0 left, row 0 top', () => {
  const v = { cx: 50, cy: 50, pxPerData: 8 };
  assert.deepEqual(I.viewToScreen(v, 800, 600, 50, 50), [400, 300]);
  const [sx, sy] = I.viewToScreen(v, 800, 600, 10.3, 77.7);
  const [x, y] = I.viewToData(v, 800, 600, sx, sy);
  assert.ok(Math.abs(x - 10.3) < 1e-9 && Math.abs(y - 77.7) < 1e-9);
  assert.ok(I.viewToScreen(v, 800, 600, 0, 0)[0] < I.viewToScreen(v, 800, 600, 1, 0)[0]);
  assert.ok(I.viewToScreen(v, 800, 600, 0, 0)[1] < I.viewToScreen(v, 800, 600, 0, 1)[1]);
});

test('fitView cover vs contain', () => {
  const c = I.fitView(100, 1000, 500, true), f = I.fitView(100, 1000, 500, false);
  assert.equal(c.pxPerData, 10); assert.equal(f.pxPerData, 5); assert.equal(c.cx, 49.5);
});

test('trail weights fade monotonically with a floor', () => {
  assert.equal(I.trailWeight(0), 1);
  let p = 1; for (let a = 1; a < 80; a++) { const w = I.trailWeight(a); assert.ok(w <= p && w >= 0.3); p = w; }
});

test('SkyRenderer sourceAt / toScreen with the Canvas2D backend (stubbed DOM)', () => {
  globalThis.document = { createElement: () => ({ getContext: () => null }) };
  const ctx = new Proxy({}, { get: () => () => {} });
  const canvas = { clientWidth: 400, clientHeight: 300, width: 400, height: 300, getContext: (k) => (k === '2d' ? ctx : null) };
  const r = new SkyRenderer(canvas);
  assert.equal(r.backendName, 'canvas2d');
  r.setGrid(100);
  r.setFrame('a', { img: new Float32Array(1e4), sources: [{ id: 1, x: 50, y: 50, flux: 1 }, { id: 2, x: 52, y: 50, flux: 2 }, { id: 3, x: 90, y: 90, flux: 1 }] });
  r.setView({ cx: 50, cy: 50, pxPerData: 10 });
  assert.deepEqual(r.sourceAt(200, 150, 'a', 25).map((s) => s.id), [1, 2]);
  assert.deepEqual(r.sourceAt(200, 150, 'a', 5).map((s) => s.id), [1]);
  const p = r.toScreen(50, 50); assert.equal(p.x, 200); assert.equal(p[1], 150);
  r.fit(true); assert.equal(r.view.pxPerData, 4);
  delete globalThis.document;
});

test('glow intensity: monotonic, saturates at 1 plus a halo above, signed', () => {
  const r = 3;
  const a = I.glowIntensity(0.01, r), b = I.glowIntensity(0.3, r), c = I.glowIntensity(3, r), d = I.glowIntensity(300, r, 'asinh', 0.9);
  assert.ok(a < b && b < c && c <= 1 && d > 1);
  assert.equal(I.glowIntensity(1000, r, 'asinh', 0), 1);
  assert.ok(I.glowIntensity(-1, r) < 0);
});

test('trail / diff glows keep only sources without a counterpart in the other frame', () => {
  globalThis.document = { createElement: () => ({ getContext: () => null }) };
  const ctx = new Proxy({}, { get: () => () => {} });
  const canvas = { clientWidth: 400, clientHeight: 300, width: 400, height: 300, getContext: (k) => (k === '2d' ? ctx : null) };
  const r = new SkyRenderer(canvas);
  r.setGrid(100);
  const fixed = (id) => ({ id, x: 20, y: 20, snr: 50, flux: 5 });
  r.setFrame('a', { img: new Float32Array(1e4), sources: [fixed(1), { id: 2, x: 60, y: 60, snr: 20, flux: 2 }, { id: 3, x: 80, y: 10, snr: 3, flux: 0.5 }] });
  r.setFrame('b', { img: new Float32Array(1e4), sources: [{ ...fixed(1), x: 20.8 }, { id: 4, x: 30, y: 70, snr: 15, flux: 1 }] });
  assert.deepEqual(r.filtered('a', 'b', 0).map((s) => s.id), [2, 3]);          // the fixed star cancels, the others changed
  assert.deepEqual(r.filtered('a', 'b', 8).map((s) => s.id), [2]);             // faint detection dropped by the S/N cut
  assert.equal(r.filtered('a').length, 3);
  const plan = r.buildPlan({ a: 'a', trail: ['b', 'a'], mode: 'trail', layer: 'model', lim: { lo: 0, hi: 1 } });
  assert.equal(plan.bg.type, 'trail');                                          // the background itself is never accumulated
  assert.deepEqual(plan.glows.map((g) => [g.id, g.vs || null]), [['b', 'a'], ['a', null]]);
  delete globalThis.document;
});

/** Canvas2D-backed renderer with a stubbed DOM (no browser). Caller must delete globalThis.document. */
function c2dRenderer(opts = {}) {
  globalThis.document = { createElement: () => ({ getContext: () => null }) };
  const ctx = new Proxy({}, { get: () => () => {} });
  const canvas = { clientWidth: 400, clientHeight: 300, width: 400, height: 300, getContext: (k) => (k === '2d' ? ctx : null) };
  return new SkyRenderer(canvas, opts);
}

test('setModel keeps the raw image, replaces background and sources, false for unknown ids', () => {
  try {
    const r = c2dRenderer();
    r.setGrid(2);
    const img = Float32Array.of(1, 2, 3, 4);
    r.setFrame('a', { img, background: Float32Array.of(0, 0, 0, 0) });
    const bg2 = Float32Array.of(9, 9, 9, 9);
    assert.equal(r.setModel('a', { background: bg2, sources: [{ x: 1, y: 1, flux: 1 }] }), true);
    const f = r.frames.get('a');
    assert.equal(f.img, img);
    assert.equal(f.background, bg2);
    assert.equal(f.sources.length, 1);
    assert.equal(f.psfFwhmPx, 1.9);
    assert.equal(r.setModel('nope', { background: bg2 }), false);
    assert.equal(r.frames.has('nope'), false);
  } finally { delete globalThis.document; }
});

test('setModel crossfades raw -> model over fadeMs (Canvas2D combine)', () => {
  try {
    let now = 1000;
    const r = c2dRenderer({ now: () => now, fadeMs: 600 });
    r.setGrid(2);
    r.setFrame('a', { img: Float32Array.of(2, 2, 2, 2), background: Float32Array.of(2, 2, 2, 2) });
    r.setModel('a', { background: Float32Array.of(0, 0, 0, 0), sources: [{ x: 0, y: 0, flux: 5, snr: 20 }] });
    const view = { a: 'a', mode: 'video', layer: 'model', lim: { lo: 0, hi: 1 } };
    let plan = r.buildPlan(view);
    assert.ok(Math.abs(plan.bg.fa - 1) < 1e-6);
    assert.equal(plan.glows.length, 0);                       // w = 0 glows are dropped
    assert.equal(r.fading, true);
    assert.ok(Math.abs(r.backend.combine(plan)[0] - 2) < 1e-6);
    now += 300;
    plan = r.buildPlan(view);
    assert.ok(Math.abs(plan.bg.fa - 0.5) < 1e-6);
    assert.ok(Math.abs(plan.glows[0].w - 0.5) < 1e-6);
    assert.ok(Math.abs(r.backend.combine(plan)[0] - 1) < 1e-6);
    now += 600;
    plan = r.buildPlan(view);
    assert.equal(plan.bg.fa, 0);
    assert.equal(plan.glows[0].w, 1);
    assert.equal(r.backend.combine(plan)[0], 0);
    assert.equal(r.fading, false);
  } finally { delete globalThis.document; }
});

test('raw layer and diff / trail plans never crossfade (fa = fb = 0 mid-fade)', () => {
  try {
    let now = 1000;
    const r = c2dRenderer({ now: () => now, fadeMs: 600 });
    r.setGrid(2);
    r.setFrame('a', { img: Float32Array.of(1, 1, 1, 1), background: Float32Array.of(1, 1, 1, 1) });
    r.setFrame('b', { img: Float32Array.of(2, 2, 2, 2), background: Float32Array.of(2, 2, 2, 2) });
    r.setModel('a', { background: Float32Array.of(0, 0, 0, 0), sources: [{ x: 0, y: 0, flux: 5, snr: 20 }] });
    r.setModel('b', { background: Float32Array.of(0, 0, 0, 0) });
    now += 300;                                                // mid-fade
    const lim = { lo: 0, hi: 1 };
    const plans = [
      { a: 'a', layer: 'raw', lim },
      { a: 'a', prev: 'b', mode: 'diff', layer: 'model', lim },
      { a: 'a', trail: ['b', 'a'], mode: 'trail', layer: 'model', lim },
    ].map((o) => r.buildPlan(o));
    for (const p of plans) { assert.equal(p.bg.fa, 0); assert.equal(p.bg.fb, 0); }
    assert.ok(r.buildPlan({ a: 'a', layer: 'model', lim }).bg.fa > 0); // sanity: the model layer does fade
  } finally { delete globalThis.document; }
});

test('Canvas2D combine: NaN in the model uses raw, NaN in raw uses model', () => {
  try {
    let now = 1000;
    const r = c2dRenderer({ now: () => now });
    r.setGrid(2);
    r.setFrame('a', { img: Float32Array.of(2, NaN, 2, NaN), background: Float32Array.of(0, 0, 0, 0) });
    r.setModel('a', { background: Float32Array.of(NaN, 4, 6, NaN) });
    const plan = r.buildPlan({ a: 'a', layer: 'model', lim: { lo: 0, hi: 1 } });
    assert.equal(plan.bg.fa, 1);                              // just attached: fully raw
    const v = r.backend.combine(plan);
    assert.ok(Math.abs(v[0] - 2) < 1e-6);                     // model NaN -> raw
    assert.ok(Math.abs(v[1] - 4) < 1e-6);                     // raw NaN -> model
    now += 300;                                                // fa = 0.5
    const mid = r.backend.combine(r.buildPlan({ a: 'a', layer: 'model', lim: { lo: 0, hi: 1 } }));
    assert.ok(Math.abs(mid[0] - 2) < 1e-6);
    assert.ok(Math.abs(mid[1] - 4) < 1e-6);
    assert.ok(Math.abs(mid[2] - 4) < 1e-6);                   // 0.5 * 6 + 0.5 * 2
    assert.ok(Number.isNaN(mid[3]));                          // both NaN stays NaN
  } finally { delete globalThis.document; }
});
