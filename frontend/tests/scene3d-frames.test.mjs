import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../js/blink/scene3d-frames.js';
import * as M from '../js/blink/scene3d-math.js';

const rel = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / Math.max(Math.hypot(...b), 1e-300);
const star = (pc, key = 'g:1') => ({ idx: 5, key, name: 'Test', pc, distPc: 0 });

test('pc <-> AU round trip is exact to double rounding', () => {
  const host = [123.456789, -456.123456, 78.9012345];
  for (const p of [[123.4568, -456.1234, 78.9013], [0, 0, 0], [800, 1, -3]]) {
    const back = F.toGalaxyPos(F.toSystemPos(p, host), host);
    assert.ok(rel(back, p) < 1e-13 || Math.hypot(...back.map((v, i) => v - p[i])) < 1e-12, `${p}`);
  }
  // one AU from the host is exactly 1 AU
  const au = F.toSystemPos([host[0] + 1 / F.AU_PER_PC, host[1], host[2]], host);
  assert.ok(Math.abs(au[0] - 1) < 1e-9);
});

test('entering and leaving a system keeps the camera where it was in the world', () => {
  const hostPc = [412.25, -611.5, 305.125];
  const cam = F.makeCam({ pos: [hostPc[0] + 0.015, hostPc[1] - 0.004, hostPc[2] + 0.002], speed: 0.5 });
  const before = F.worldPc(cam);
  const r = F.stepFrame(cam, [{ ...star(hostPc), distPc: Math.hypot(0.015, 0.004, 0.002) }]);
  assert.equal(r, 'enter'); assert.equal(cam.frame, 'system');
  assert.ok(rel(F.worldPc(cam), before) < 1e-9, 'world position unchanged');
  assert.ok(Math.abs(Math.hypot(...cam.pos) / F.AU_PER_PC - Math.hypot(0.015, 0.004, 0.002)) < 1e-12);
  F.leaveSystem(cam);
  assert.equal(cam.frame, 'galaxy'); assert.ok(rel(cam.pos, before) < 1e-9);
});

test('velocity is converted with the position', () => {
  const cam = F.makeCam({ pos: [10, 0, 0] }); cam.vel = [0.1, 0, 0];
  F.enterSystem(cam, { idx: 1, key: 'k', name: 'k', pc: [10, 0, 0] });
  assert.ok(Math.abs(cam.vel[0] - 0.1 * F.AU_PER_PC) < 1e-6);
});

test('hysteresis: no flapping between 0.02 and 0.03 pc', () => {
  const hostPc = [50, 60, 70], host = star(hostPc);
  const cam = F.makeCam({ pos: [50.04, 60, 70] });
  const at = (d) => { // camera d pc from the host along x, frame-appropriate
    cam.pos = cam.frame === 'system' ? [d * F.AU_PER_PC, 0, 0] : [50 + d, 60, 70];
    return F.stepFrame(cam, [{ ...host, distPc: d }]);
  };
  assert.equal(at(0.04), null); assert.equal(cam.frame, 'galaxy');
  assert.equal(at(0.025), null); assert.equal(cam.frame, 'galaxy');       // outside the entry radius
  assert.equal(at(0.019), 'enter');
  for (const d of [0.025, 0.0299, 0.025, 0.021]) { assert.equal(at(d), null, `stays in at ${d}`); assert.equal(cam.frame, 'system'); }
  assert.equal(at(0.031), 'leave'); assert.equal(cam.frame, 'galaxy');
  assert.equal(at(0.025), null); assert.equal(cam.frame, 'galaxy');       // and does not snap back in
});

test('a camera that starts inside a star does not enter it until it has left and returned', () => {
  const cam = F.makeCam({ pos: [0, 0, 0], disarm: 'sun' });
  const sun = (d) => ({ idx: 0, key: 'sun', name: 'Sun', pc: [0, 0, 0], distPc: d });
  assert.equal(F.stepFrame(cam, [sun(0)]), null);
  assert.equal(F.stepFrame(cam, [sun(0.01)]), null);
  assert.equal(cam.disarm, 'sun');
  assert.equal(F.stepFrame(cam, [sun(0.04)]), null);
  assert.equal(cam.disarm, null);
  assert.equal(F.stepFrame(cam, [sun(0.01)]), 'enter');
});

test('the nearest star wins when two are inside the entry radius', () => {
  const cam = F.makeCam({ pos: [0, 0, 0] });
  const a = { ...star([0.01, 0, 0], 'a'), distPc: 0.01 }, b = { ...star([0.005, 0, 0], 'b'), distPc: 0.005 };
  F.stepFrame(cam, [a, b]);
  assert.equal(cam.host.key, 'b');
});

test('camera-relative vector keeps double precision for a star 800 pc away seen from 1 AU', () => {
  const hostPc = [800.123456789012, -123.456789012345, 55.5];
  const cam = F.makeCam({ pos: [0, 0, 0], frame: 'system', host: { idx: 1, key: 'h', name: 'h', pc: hostPc } });
  cam.pos = [1, 0, 0];                                     // 1 AU from the host
  const bodyPc = [hostPc[0] + 2 / F.AU_PER_PC, hostPc[1], hostPc[2]];   // 2 AU from the host along +x
  const r = F.relFromCam(cam, bodyPc);
  assert.ok(Math.abs(r[0] - 1) < 1e-6 && Math.abs(r[1]) < 1e-6 && Math.abs(r[2]) < 1e-6, `got ${r}`);
  // a float32 galaxy-frame position would be off by ~ 800 pc * 6e-8 = 5e-5 pc = ~10 AU
  const f32 = Math.fround(bodyPc[0]) - Math.fround(hostPc[0]);
  assert.ok(Math.abs(f32 * F.AU_PER_PC - 2) > 1e-3, 'sanity: float32 would not be good enough');
  // same in the galaxy frame
  const g = F.makeCam({ pos: [hostPc[0] + 1 / F.AU_PER_PC, hostPc[1], hostPc[2]] });
  const rg = F.relFromCam(g, bodyPc);
  assert.ok(Math.abs(rg[0] * F.AU_PER_PC - 1) < 1e-6);
});

test('quadRect bounds the glow, culls what is off screen, and covers the screen when inside', () => {
  const tan = Math.tan(30 * M.D2R);
  const r = M.quadRect([0, 0, -50], 3, tan * 1.6, tan);
  assert.ok(r[0] < 0 && r[2] > 0 && r[1] < 0 && r[3] > 0 && r[2] < 0.5);
  assert.equal(M.quadRect([0, 0, -2], 3, tan, tan), 'full');
  assert.equal(M.quadRect([0, 0, 500], 3, tan, tan), null);
  assert.equal(M.quadRect([5000, 0, -10], 3, tan, tan), null);
});

test('level of detail and exposure', () => {
  assert.equal(M.sphereWeight(0.2), 0); assert.equal(M.sphereWeight(5), 1);
  assert.ok(M.sphereWeight(1.75) > 0.3 && M.sphereWeight(1.75) < 0.7);
  assert.equal(M.exposureFor(50), 1);
  assert.ok(Math.abs(M.exposureFor(1e7) * 1e7 - M.V_EXPO) < 1e-6);
  assert.ok(M.spriteV(-26.7, 12) * M.exposureFor(M.spriteV(-26.7, 12)) <= M.V_EXPO + 1e-9);
  assert.ok(Math.abs(M.easeExposure(1, 0.01, 100) - 0.01) < 1e-6);
  assert.ok(M.easeExposure(1, 0.01, 0.1) < 1 && M.easeExposure(1, 0.01, 0.1) > 0.01);
});
