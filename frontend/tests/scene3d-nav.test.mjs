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
