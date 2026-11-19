import test from 'node:test';
import assert from 'node:assert/strict';
import { Autopilot, arrivalDistance, suggestSpeed, slerpDir, easeInOut } from '../js/blink/scene3d-nav.js';

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function run(ap, dt = 1 / 60, tmax = 30, each) {
  let t = 0, r;
  do { r = ap.step(dt); t += dt; if (each) each(r, t); } while (!r.done && t < tmax);
  return { r, t };
}

test('arrivalDistance', () => {
  assert.equal(arrivalDistance(0.0001), 0.002);
  assert.ok(Math.abs(arrivalDistance(0.00465) - 0.0279) < 1e-9);
  assert.ok(Math.abs(arrivalDistance(1) - 6) < 1e-12);
});

test('autopilot reaches stopAt, approaches monotonically, ends facing target', () => {
  const to = [100, 50, -20], stopAt = 0.01;
  const ap = new Autopilot().start({ from: [0, 0, 0], fromDir: [0, 0, -1], to, stopAt });
  let prev = Infinity;
  const { r, t } = run(ap, 1 / 60, 30, (s) => { const d = dist(s.pos, to); assert.ok(d <= prev + 1e-9); prev = d; });
  assert.ok(r.done);
  assert.ok(Math.abs(dist(r.pos, to) - stopAt) / stopAt < 1e-6);
  const u = [to[0] - r.pos[0], to[1] - r.pos[1], to[2] - r.pos[2]], l = Math.hypot(...u);
  assert.ok(Math.abs(r.dir[0] * u[0] / l + r.dir[1] * u[1] / l + r.dir[2] * u[2] / l - 1) < 1e-9);
  assert.ok(t < 10);
});

test('turn phase ends facing the target without moving', () => {
  const ap = new Autopilot().start({ from: [0, 0, 0], fromDir: [1, 0, 0], to: [0, 10, 0], stopAt: 1 });
  const a = ap.step(0.4); assert.deepEqual(a.pos, [0, 0, 0]); assert.ok(a.dir[1] > 0 && a.dir[0] > 0);
  const b = ap.step(0.41); assert.ok(b.dir[1] > 0.999 || b.pos[1] > 0);
});

test('duration within 2.5-8 s of travel for wide distance ratios', () => {
  for (const ratio of [1e2, 1e12]) {
    const ap = new Autopilot().start({ from: [0, 0, 0], fromDir: [0, 0, 1], to: [ratio, 0, 0], stopAt: 1 });
    const { t, r } = run(ap, 1 / 120, 60);
    assert.ok(r.done);
    const travel = t - 0.8;
    assert.ok(travel >= 2.5 - 0.02 && travel <= 8 + 0.02, `${ratio}: ${travel}`);
  }
});

test('retarget follows a moving target and cancel stops', () => {
  const ap = new Autopilot().start({ from: [0, 0, 0], fromDir: [1, 0, 0], to: [10, 0, 0], stopAt: 0.1 });
  let to = [10, 0, 0], r;
  for (let i = 0; i < 100; i++) { to = [10, i * 0.05, 0]; ap.retarget(to); r = ap.step(1 / 60); }
  for (let i = 0; i < 2000 && !r.done; i++) { ap.retarget(to); r = ap.step(1 / 60); }
  assert.ok(r.done); assert.ok(Math.abs(dist(r.pos, to) - 0.1) < 1e-6);
  const b = new Autopilot().start({ from: [0, 0, 0], fromDir: [1, 0, 0], to: [5, 0, 0], stopAt: 1 });
  b.cancel(); assert.ok(b.step(1).done);
});

test('helpers', () => {
  assert.equal(easeInOut(0), 0); assert.equal(easeInOut(1), 1); assert.equal(easeInOut(0.5), 0.5);
  const m = slerpDir([1, 0, 0], [0, 1, 0], 0.5); assert.ok(Math.abs(m[0] - Math.SQRT1_2) < 1e-12);
  const o = slerpDir([1, 0, 0], [-1, 0, 0], 0.5); assert.ok(Math.abs(Math.hypot(...o) - 1) < 1e-12);
  assert.equal(suggestSpeed(30, 1), 10);
  assert.equal(suggestSpeed(1e-30, 1), 1e-9); assert.equal(suggestSpeed(1e9, 1), 100);
  assert.equal(suggestSpeed(NaN, 5), 5e-9);
});

test('retargeting a stationary target every frame does not change the trip', async () => {
  const { Autopilot } = await import('../js/blink/scene3d-nav.js');
  const from = [0.774, 0.589, 0.254], to = [-8.741, 3.499, 1.517];
  const a = new Autopilot().start({ from, fromDir: [0, 0, 1], to, stopAt: 0.0024 });
  let r;
  for (let i = 0; i < 400 && !a.done; i++) { a.retarget(to); r = a.step(0.05); }
  assert.ok(a.done);
  const d = Math.hypot(r.pos[0] - to[0], r.pos[1] - to[1], r.pos[2] - to[2]);
  assert.ok(Math.abs(d - 0.0024) < 1e-6, `stopped ${d} from the target`);
});

import { autoThrottleSpeed, keepOutside, fmtTimesC, THROTTLE } from '../js/blink/scene3d-nav.js';

test('autoThrottleSpeed scales with distance and clamps', () => {
  assert.equal(autoThrottleSpeed(100, 0.5, { min: 0.01, max: 1000 }), 50);
  assert.equal(autoThrottleSpeed(1e6, 0.5, { min: 0.01, max: 1000 }), 1000);
  assert.equal(autoThrottleSpeed(1e-6, 0.5, { min: 0.01, max: 1000 }), 0.01);
  assert.equal(autoThrottleSpeed(Infinity, 0.5, { min: 2, max: 9 }), 2);
  assert.equal(autoThrottleSpeed(NaN, 0.5, { min: 2, max: 9 }), 2);
  assert.ok(THROTTLE.min < THROTTLE.def && THROTTLE.def < THROTTLE.max);
});

test('holding forward under auto throttle converges on the surface exponentially, never inside', () => {
  const c = [0, 0, 0], r = 1;
  let x = 1000, prevGap = Infinity;
  for (let i = 0; i < 6000; i++) {
    const gap = x - r;
    x += -autoThrottleSpeed(gap, 0.5, { min: 1e-9, max: 1e9 }) / 60;
    x = keepOutside([x, 0, 0], [{ c, r }])[0];
    assert.ok(x >= 1.02 * r - 1e-12 && Number.isFinite(x));
    assert.ok(x - r <= prevGap + 1e-12); prevGap = x - r;
  }
  assert.ok(Math.abs(x - 1.02) < 1e-6);
});

test('keepOutside pushes to the shell, slides, and leaves outside points alone', () => {
  const s = [{ c: [0, 0, 0], r: 1 }];
  assert.deepEqual(keepOutside([5, 0, 0], s), [5, 0, 0]);
  const q = keepOutside([0.5, 0.8, 0], s);
  assert.ok(Math.abs(Math.hypot(...q) - 1.02) < 1e-12);
  assert.ok(q[1] > q[0]);                                   // tangential part kept
  assert.ok(Math.abs(Math.hypot(...keepOutside([0, 0, 0], s)) - 1.02) < 1e-12);
});

test('fmtTimesC', () => {
  assert.equal(fmtTimesC(2.1e6), '2.1 million× c');
  assert.equal(fmtTimesC(1), '1× c');
  assert.equal(fmtTimesC(350), '350× c');
  assert.equal(fmtTimesC(4.5e9), '4.5 billion× c');
  assert.equal(fmtTimesC(0.001), '<0.01× c');
});

import { headingWeight } from '../js/blink/scene3d-nav.js';
test('headingWeight: 1 ahead, floored at 0.2 beside and behind', () => {
  assert.equal(headingWeight(1), 1);
  assert.equal(headingWeight(0.5), 0.5);
  assert.equal(headingWeight(0), 0.2);
  assert.equal(headingWeight(-1), 0.2);
  assert.equal(headingWeight(NaN), 1);
  // sharp cone for distant stars: ahead counts fully, 20 deg partly, beside/behind 50x farther
  assert.equal(headingWeight(1, true), 1);
  assert.ok(headingWeight(Math.cos(20 * Math.PI / 180), true) > 0.3);
  assert.equal(headingWeight(0, true), 0.02);
  assert.equal(headingWeight(-1, true), 0.02);
});

import { corridorDistance } from '../js/blink/scene3d-nav.js';
test('corridorDistance: only stars on your path brake you', () => {
  assert.equal(corridorDistance(380, 380), 380);                          // the star you aim at: along-track distance
  assert.equal(corridorDistance(10, Math.hypot(10, 0.04)), 10);           // passing within the 0.05 pc tube
  assert.equal(corridorDistance(300, Math.hypot(300, 0.6)), 300);         // far away, inside the 0.15 deg corridor
  assert.equal(corridorDistance(10, Math.hypot(10, 1)), Math.hypot(10, 1) * 50);   // 1 pc off the path: cruise cap only
  assert.equal(corridorDistance(-5, 5), 250);                             // behind you
});

test('suggestSpeed takes the level cap: the default keeps 100 pc/s, the galaxy and cosmos levels pass 1e8', () => {
  assert.equal(suggestSpeed(1e9, 1), 100); assert.equal(suggestSpeed(1e9, 1, 100), 100);
  assert.equal(suggestSpeed(3e6, 1, 1e8), 1e6); assert.equal(suggestSpeed(3e12, 1, 1e8), 1e8);
  assert.equal(suggestSpeed(3e12, 1e-6, 1e8), 1e2);                          // cosmos units: 1e8 pc/s is 100 Mpc/s
  assert.equal(suggestSpeed(NaN, 1, 1e8), 1e-9);
});
