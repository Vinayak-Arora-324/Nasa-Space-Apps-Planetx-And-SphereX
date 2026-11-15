import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLimits } from '../js/blink/analysis.js';

const N = 48 * 48;
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function noisy(seed, offset = 0, sd = 0.05) {
  const r = rng(seed), a = new Float32Array(N);
  for (let i = 0; i < N; i++) a[i] = offset + (r() + r() + r() - 1.5) * sd * 2;
  return a;
}
const frame = (i, extra = {}) => ({ id: `f${i}`, mjd: 60000 + i, img: noisy(i + 1), noise: 0.05, ...extra });

test('difference range comes from time-adjacent frames, not the spread-out sample', () => {
  // 12 frames: the first two match; frame 2 (which the spread sample would pair with frame 0) is far brighter.
  const frames = Array.from({ length: 12 }, (_, i) => frame(i, i === 2 ? { img: noisy(3, 50) } : {}));
  const L = computeLimits(frames);
  assert.ok(L.diff.hi < 1, `diff range ${L.diff.hi} should reflect frame 1 - frame 0, not the bright frame`);
});

test('one outlier background frame does not set the measured-sky white point', () => {
  const frames = Array.from({ length: 6 }, (_, i) => frame(i, { bg: noisy(100 + i, 0, 0.01) }));
  const calm = computeLimits(frames).model.hi;
  frames[3].bg = noisy(200, 0, 0.01).map((v, i) => (i % 7 === 0 ? 40 : v));  // one badly fitted frame
  const withOutlier = computeLimits(frames).model.hi;
  assert.ok(Math.abs(withOutlier - calm) < 0.05 * Math.abs(calm) + 1e-3, `white point moved ${calm} -> ${withOutlier}`);
});

test('source glow range stays the raw pixel range even with bright fitted sources', () => {
  const frames = Array.from({ length: 4 }, (_, i) => frame(i, { bg: noisy(300 + i, 0, 0.01), sources: [{ amp: 80 }, { amp: 90 }, { amp: 100 }] }));
  const L = computeLimits(frames);
  assert.ok(Math.abs(L.model.star - (L.raw.hi - L.raw.lo)) < 1e-9);
  assert.ok(L.model.hi - L.model.lo >= 0.5 * 90 - 1e-6, 'white point still makes room for the bright sources');
});
