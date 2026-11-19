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

// ---------------------------------------------------------------- table-driven levels (three-level table)
const F3 = F.makeFrames(F.LEVELS);   // the real three-level table (section 18.5.6)
const sunStar = (d, key = 'sun') => ({ idx: 0, key, name: key, pc: [0, 0, 0], distPc: d });

test('LEVELS holds today\'s values and the old exports are the two-level instance', () => {
  assert.deepEqual(F.LEVELS.map((l) => l.name), ['system', 'galaxy', 'cosmos']);
  assert.deepEqual(F.rangeOf('system'), { min: 1e-6, max: 1e3, speed: 0.2 });
  assert.deepEqual(F.rangeOf('galaxy'), { min: 0.01, max: 1e8, speed: 2 });
  assert.deepEqual(F.rangeOf('cosmos'), { min: 1e-6, max: 100, speed: 0.01 });
  assert.equal(F.levelOf('system').fov, 60);
  assert.equal(F.levelOf('system').far, 1e12); assert.equal(F.levelOf('galaxy').far, 1e9);
  assert.deepEqual(F.levelOf('galaxy').autoPc, { min: 1e-12, max: 1e8 });
  assert.deepEqual(F.levelOf('cosmos').autoPc, { min: 1e-12, max: 1e8 });
  assert.deepEqual([F.levelOf('cosmos').unit, F.levelOf('cosmos').perPc, F.levelOf('cosmos').enterPc, F.levelOf('cosmos').leavePc, F.levelOf('cosmos').far], ['Mpc', 1e-6, 6e4, 4e4, 1e5]);
  assert.equal(F.isHosted('system'), true); assert.equal(F.isHosted('galaxy'), false); assert.equal(F.isHosted('cosmos'), false); assert.throws(() => F.isHosted('nowhere'));
  assert.equal(F.ENTER_PC, 0.02); assert.equal(F.LEAVE_PC, 0.03);
  assert.equal(F.unitsPerPc({ frame: 'system' }), F.AU_PER_PC); assert.equal(F.unitsPerPc({ frame: 'galaxy' }), 1);
  assert.equal(F.unitsPerPc({ frame: 'cosmos' }), 1e-6);
});

test('three levels: galaxy to cosmos and back, with hysteresis', () => {
  const cam = F.makeCam({ pos: [3e4, 0, 0] });
  const at = (pc) => { cam.pos = cam.frame === 'cosmos' ? [pc * 1e-6, 0, 0] : [pc, 0, 0]; return F3.stepFrame(cam, []); };
  assert.equal(at(5.9e4), null); assert.equal(cam.frame, 'galaxy');
  assert.equal(at(6.1e4), 'leave'); assert.equal(cam.frame, 'cosmos');
  assert.ok(Math.abs(cam.pos[0] - 0.061) < 1e-12, 'position is now in Mpc');
  for (const d of [5.9e4, 4.5e4, 4.01e4, 5e4]) { assert.equal(at(d), null, `stays out at ${d}`); assert.equal(cam.frame, 'cosmos'); }
  assert.equal(at(3.9e4), 'enter'); assert.equal(cam.frame, 'galaxy');
  assert.ok(Math.abs(cam.pos[0] - 3.9e4) < 1e-6, 'back in pc');
  assert.equal(at(5e4), null); assert.equal(cam.frame, 'galaxy');           // and does not flap back out below 60 kpc
});

test('three levels: velocity follows the units across galaxy and cosmos', () => {
  const cam = F.makeCam({ pos: [7e4, 0, 0] }); cam.vel = [100, 0, 0];     // pc per second
  F3.stepFrame(cam, []);
  assert.equal(cam.frame, 'cosmos'); assert.ok(Math.abs(cam.vel[0] - 1e-4) < 1e-16);
});

test('three levels: system to galaxy to cosmos to galaxy keeps worldPc to 1e-9 relative', () => {
  const hostPc = [60500.123456789, -11000.5, 4000.25];
  const cam = F.makeCam({ pos: [hostPc[0] + 0.01, hostPc[1] - 0.005, hostPc[2] + 0.002] });
  const before = F3.worldPc(cam);
  F3.enterLevel(cam, 'system', { idx: 9, key: 'far', name: 'Far', pc: hostPc });
  assert.equal(cam.frame, 'system'); assert.ok(rel(F3.worldPc(cam), before) < 1e-9);
  F3.leaveLevel(cam);
  assert.equal(cam.frame, 'galaxy'); assert.equal(cam.disarm, 'far'); assert.ok(rel(F3.worldPc(cam), before) < 1e-9);
  F3.enterLevel(cam, 'cosmos');
  assert.equal(cam.frame, 'cosmos'); assert.equal(cam.host, null); assert.ok(rel(F3.worldPc(cam), before) < 1e-9);
  F3.enterLevel(cam, 'galaxy');
  assert.equal(cam.frame, 'galaxy'); assert.ok(rel(F3.worldPc(cam), before) < 1e-9);
  const rc = F3.toFrame(before, 'cosmos');
  assert.ok(Math.abs(rc[0] - before[0] * 1e-6) < 1e-15);
});

test('three levels: stars are still entered from the galaxy level with the same hysteresis and disarm', () => {
  const cam = F.makeCam({ pos: [0, 0, 0], disarm: 'sun' });
  assert.equal(F3.stepFrame(cam, [sunStar(0)]), null);
  assert.equal(F3.stepFrame(cam, [sunStar(0.04)]), null); assert.equal(cam.disarm, null);
  assert.equal(F3.stepFrame(cam, [sunStar(0.01)]), 'enter'); assert.equal(cam.frame, 'system');
  cam.pos = [0.05 * F.AU_PER_PC, 0, 0];
  assert.equal(F3.stepFrame(cam, []), 'leave'); assert.equal(cam.frame, 'galaxy');
  assert.equal(F3.stepFrame(cam, [sunStar(0.01)]), null);                  // disarmed after leaving
});

test('three levels: relFromCam and unitsPerPc in the cosmos frame', () => {
  const cam = F.makeCam({ pos: [0.01, 0, 0], frame: 'cosmos' });
  assert.equal(F3.unitsPerPc(cam), 1e-6);
  const r = F3.relFromCam(cam, [2e4, 0, 0]);                                // 0.02 Mpc minus 0.01 Mpc
  assert.ok(Math.abs(r[0] - 0.01) < 1e-15);
  assert.equal(F3.hostDistPc(cam), Infinity);
});

test('the default instance is the three-level table: far enough out the camera is in cosmos', () => {
  const cam = F.makeCam({ pos: [9e9, 0, 0] });
  assert.equal(F.stepFrame(cam, []), 'leave'); assert.equal(cam.frame, 'cosmos');
});

test('real LEVELS: 60 kpc out, 40 kpc back, no flapping at 59 or 50 kpc, velocity x 1e-6, worldPc to 1e-9 across system, galaxy, cosmos, galaxy', () => {
  const cam = F.makeCam({ pos: [5.9e4, 0, 0] }); cam.vel = [3, 0, 0];
  assert.equal(F.stepFrame(cam, []), null); assert.equal(cam.frame, 'galaxy');
  cam.pos = [5.9e4 + 0.2e4, 0, 0]; const w0 = F.worldPc(cam);
  assert.equal(F.stepFrame(cam, []), 'leave'); assert.equal(cam.frame, 'cosmos');
  assert.ok(Math.abs(cam.vel[0] - 3e-6) < 1e-18); assert.ok(rel(F.worldPc(cam), w0) < 1e-9);
  for (const d of [5.9e4, 5e4, 4.01e4]) { cam.pos = [d * 1e-6, 0, 0]; assert.equal(F.stepFrame(cam, []), null, `stays in cosmos at ${d}`); assert.equal(cam.frame, 'cosmos'); }
  cam.pos = [3.9e4 * 1e-6, 0, 0]; assert.equal(F.stepFrame(cam, []), 'enter'); assert.equal(cam.frame, 'galaxy');
  for (const d of [3.9e4, 5.9e4, 5e4]) { cam.pos = [d, 0, 0]; assert.equal(F.stepFrame(cam, []), null, `stays in galaxy at ${d}`); assert.equal(cam.frame, 'galaxy'); }
  const hostPc = [60500.123456789, -11000.5, 4000.25], c2 = F.makeCam({ pos: [hostPc[0] + 0.01, hostPc[1], hostPc[2]] }), before = F.worldPc(c2);
  F.makeFrames(F.LEVELS).enterLevel(c2, 'system', { idx: 1, key: 'h', name: 'h', pc: hostPc });
  for (const to of ['galaxy', 'cosmos', 'galaxy']) { F3.enterLevel(c2, to); assert.ok(rel(F3.worldPc(c2), before) < 1e-9, to); }
});

test('float32 relFromCam at 16.9 Mpc keeps a body 1 kpc from the camera to 1e-6 (section 18.5.6)', () => {
  const camPc = [10139999.37, 11829999.61, 6305389.43], body = [camPc[0] + 700.5, camPc[1] - 599.3, camPc[2] + 500.4];
  const cam = F.makeCam({ pos: F3.toFrame(camPc, 'cosmos'), frame: 'cosmos' }), r = F3.relFromCam(cam, body);
  const want = [700.5e-6, -599.3e-6, 500.4e-6];
  assert.ok(Math.hypot(...r.map((v, i) => v - want[i])) / Math.hypot(...want) < 1e-9, 'doubles');
  const r32 = r.map(Math.fround);   // the per-frame float32 cast of a camera-relative vector
  assert.ok(Math.hypot(...r32.map((v, i) => v - want[i])) / Math.hypot(...want) < 1e-6, 'float32');
  const abs32 = body.map(Math.fround).map((v, i) => v - Math.fround(camPc[i]));   // what a static float32 buffer would give
  assert.ok(Math.hypot(...abs32.map((v, i) => v - [700.5, -599.3, 500.4][i])) / Math.hypot(700.5, 599.3, 500.4) > 1e-4, 'sanity: a static float32 buffer would not do');
});
