// Reference frames for the 3D fly-through. Pure and DOM-free (tests/scene3d-frames.test.mjs).
//
// Frames are a table of levels, innermost first (LEVELS). makeFrames(levels) builds the frame operations for any such
// table; the default two-level instance (system, galaxy) is exported under the old names.
//
// The camera holds { frame, host, pos, vel, ... } as JS doubles, in the units of its level:
//   system - AU, origin at a host star; host = { idx, key, name, pc: [x, y, z] } (its position in the galaxy frame, pc).
//   galaxy - parsecs, origin at the Sun (the star data's own frame); host is null.
//   cosmos - Mpc, origin at the Sun (Phase 3, docs/object-framework.md section 18.5). Entered beyond 60 kpc from the Sun, left below 40 kpc.
// All conversions walk through parsecs in doubles: worldPc(cam) is the camera's place in pc (Sun at the origin), and
// toFrame(pc, level, host) maps it back into a level. So the camera never moves in the world when its frame changes.
// Rendering is camera-relative: relFromCam() subtracts in doubles, and only that small vector reaches the GPU.
//
// Level fields: name, unit, perPc (units per parsec), enterPc / leavePc (hysteresis), range {min, max, speed} (wheel and
// speed bounds in the level's units), autoPc {min, max} (auto-throttle bounds, pc per second), fov (degrees, null: the
// scene decides), near / far (clip planes), hosted (true: the origin is a host star, entered by being close to it).
//   hosted level: enterPc / leavePc are the distance to the nearest host candidate (enter below enterPc, leave above leavePc).
//   outer unhosted level: enterPc / leavePc are the distance from the Sun. Beyond enterPc the camera moves out to it from
//   the next level in; back inside leavePc it returns.

export const AU_PER_PC = 206264.80624709636;

/**
 * The levels, innermost first: system (AU, hosted), galaxy (pc), cosmos (Mpc). Phase 3 (section 18.5.1): the galaxy row's speed caps
 * (range.max, autoPc.max) are 1e8 pc/s, the same as cosmos, so the speed is one function of the scene on both sides of the switch.
 */
export const LEVELS = [
  { name: 'system', unit: 'AU', perPc: AU_PER_PC, enterPc: 0.02, leavePc: 0.03, hosted: true,   // enter a star's system closer than 0.02 pc (about 4,100 AU), leave beyond 0.03
    range: { min: 1e-6, max: 1e3, speed: 0.2 }, autoPc: { min: 1e-12, max: 100 }, fov: 60, near: 1e-9, far: 1e12 },
  { name: 'galaxy', unit: 'pc', perPc: 1, enterPc: 0, leavePc: 0, hosted: false,
    range: { min: 0.01, max: 1e8, speed: 2 }, autoPc: { min: 1e-12, max: 1e8 }, fov: null, near: 1e-9, far: 1e9 },
  { name: 'cosmos', unit: 'Mpc', perPc: 1e-6, enterPc: 6e4, leavePc: 4e4, hosted: false,   // out beyond 60 kpc from the Sun, back in below 40 kpc
    range: { min: 1e-6, max: 100, speed: 0.01 }, autoPc: { min: 1e-12, max: 1e8 }, fov: null, near: 1e-9, far: 1e5 },
];

export const toSystemPos = (pc, hostPc) => [(pc[0] - hostPc[0]) * AU_PER_PC, (pc[1] - hostPc[1]) * AU_PER_PC, (pc[2] - hostPc[2]) * AU_PER_PC];
export const toGalaxyPos = (au, hostPc) => [au[0] / AU_PER_PC + hostPc[0], au[1] / AU_PER_PC + hostPc[1], au[2] / AU_PER_PC + hostPc[2]];

/** Put a new camera together. Defaults to the galaxy frame at pos. */
export function makeCam({ pos = [0, 0, 0], yaw = 0, pitch = 0, speed = 2, frame = 'galaxy', host = null, disarm = null } = {}) {
  return { frame, host, pos: pos.slice(), vel: [0, 0, 0], yaw, pitch, speed, disarm };
}

/** Frame operations for a table of levels (innermost first). */
export function makeFrames(levels) {
  const index = new Map(levels.map((l, i) => [l.name, i]));
  const at = (name) => { const i = index.get(name); if (i === undefined) throw new Error(`unknown frame level: ${name}`); return i; };
  const level = (name) => levels[at(name)];
  const lv = (cam) => levels[at(cam.frame)];

  /** Units per parsec in the camera's frame. */
  const unitsPerPc = (cam) => lv(cam).perPc;
  /** Position in pc of a point given in the camera's frame units (the Sun at the origin). */
  const toPc = (cam, pos) => {
    const L = lv(cam), k = L.perPc, h = L.hosted ? cam.host.pc : null;
    return h ? [pos[0] / k + h[0], pos[1] / k + h[1], pos[2] / k + h[2]] : [pos[0] / k, pos[1] / k, pos[2] / k];
  };
  /** Camera position in the galaxy frame (pc). */
  const worldPc = (cam) => toPc(cam, cam.pos);
  /** A world position in pc -> the units of a level (host: { pc } for a hosted level). */
  const toFrame = (pc, levelName, host = null) => {
    const L = level(levelName), k = L.perPc;
    if (L.hosted) { const h = host.pc; return [(pc[0] - h[0]) * k, (pc[1] - h[1]) * k, (pc[2] - h[2]) * k]; }
    return [pc[0] * k, pc[1] * k, pc[2] * k];
  };
  /** Vector from the camera to a body at galaxy position bodyPc, in the camera's frame units. Computed in doubles. */
  const relFromCam = (cam, bodyPc) => {
    const L = lv(cam), k = L.perPc, h = L.hosted ? cam.host.pc : [0, 0, 0];
    return [(bodyPc[0] - h[0]) * k - cam.pos[0], (bodyPc[1] - h[1]) * k - cam.pos[1], (bodyPc[2] - h[2]) * k - cam.pos[2]];
  };
  /** Camera distance to its host in pc (Infinity when the camera's level has no host). */
  const hostDistPc = (cam) => (lv(cam).hosted ? Math.hypot(cam.pos[0], cam.pos[1], cam.pos[2]) / lv(cam).perPc : Infinity);

  /** Move the camera to another level. pos and vel are converted; the camera does not move in the world. */
  function enterLevel(cam, levelName, host = null) {
    const to = level(levelName), from = lv(cam), pc = worldPc(cam);
    const vel = cam.vel.map((v) => (v * to.perPc) / from.perPc);
    cam.pos = toFrame(pc, levelName, host); cam.vel = vel;
    cam.frame = levelName; cam.host = to.hosted ? host : null;
    if (to.hosted) cam.disarm = null;
  }
  /** Leave a hosted level for the next one out; the host is remembered in cam.disarm so the camera does not snap back in. */
  function leaveLevel(cam) {
    const i = at(cam.frame);
    if (!levels[i].hosted) return;
    const key = cam.host.key;
    enterLevel(cam, levels[i + 1].name);
    cam.disarm = key;
  }
  /**
   * Decide whether to switch levels. cands: stars near the camera, each { idx, key, name, pc, distPc } (distPc from the
   * camera). Returns 'enter' (moved to an inner level), 'leave' (moved to an outer level) or null, after applying the switch.
   */
  function stepFrame(cam, cands) {
    const i = at(cam.frame), L = levels[i];
    if (L.hosted) {
      if (hostDistPc(cam) > L.leavePc) { leaveLevel(cam); return 'leave'; }
      return null;
    }
    const sunPc = () => Math.hypot(...worldPc(cam));
    const outer = levels[i + 1];
    if (outer && !outer.hosted && sunPc() > outer.enterPc) { enterLevel(cam, outer.name); return 'leave'; }
    const inner = levels[i - 1];
    if (inner && !inner.hosted && sunPc() < L.leavePc) { enterLevel(cam, inner.name); return 'enter'; }
    if (!inner || !inner.hosted) return null;
    if (cam.disarm) {
      const d = cands.find((c) => c.key === cam.disarm);
      if (!d || d.distPc > inner.leavePc) cam.disarm = null;   // moved away from where we started (or left): armed again
    }
    let best = null;
    for (const c of cands) if (c.distPc < inner.enterPc && c.key !== cam.disarm && (!best || c.distPc < best.distPc)) best = c;
    if (!best) return null;
    enterLevel(cam, inner.name, { idx: best.idx, key: best.key, name: best.name, pc: best.pc });
    return 'enter';
  }
  /** True when the named level is a hosted one (its origin is a host star): only 'system' in the default table. Unhosted levels draw objects the same way. */
  const isHosted = (name) => level(name).hosted;
  return { levels, level, isHosted, unitsPerPc, worldPc, toPc, toFrame, relFromCam, hostDistPc, enterLevel, leaveLevel, stepFrame, rangeOf: (name) => level(name).range };
}

// The default two-level instance, under the names the renderer and the tests already use.
const DEFAULT = makeFrames(LEVELS);
export const ENTER_PC = LEVELS[0].enterPc;    // enter a star's system frame closer than this
export const LEAVE_PC = LEVELS[0].leavePc;    // and leave it beyond this (hysteresis: no flapping at the border)
export const { unitsPerPc, worldPc, relFromCam, hostDistPc, stepFrame } = DEFAULT;
export const enterSystem = (cam, host) => DEFAULT.enterLevel(cam, 'system', host);
export const leaveSystem = (cam) => DEFAULT.leaveLevel(cam);
/** isHosted('system') -> true; isHosted('galaxy') and isHosted('cosmos') -> false (section 18.5.3: objects are drawn in every unhosted level). */
export const isHosted = (frameName) => DEFAULT.isHosted(frameName);
/** The level with this frame name ('system', 'galaxy' or 'cosmos'), and its speed range { min, max, speed }. */
export const levelOf = (frameName) => DEFAULT.level(frameName);
export const rangeOf = (frameName) => DEFAULT.rangeOf(frameName);
