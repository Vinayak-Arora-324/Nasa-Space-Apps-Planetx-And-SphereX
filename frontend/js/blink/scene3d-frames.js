// Reference frames for the 3D fly-through. Pure and DOM-free (tests/scene3d-frames.test.mjs).
//
// The camera holds { frame, host, pos } as JS doubles:
//   galaxy - units of parsecs, origin at the Sun (the star data's own frame); host is null.
//   system - units of AU, origin at a host star; host = { idx, key, name, pc: [x, y, z] } (its position in the galaxy frame).
// Switching frames converts pos exactly (AU = (pc - host_pc) * AU_PER_PC), so the camera's world position in pc does not
// change. Rendering is camera-relative: relFromCam() subtracts in doubles, and only that small vector reaches the GPU.

export const AU_PER_PC = 206264.80624709636;
export const ENTER_PC = 0.02;    // enter a star's system frame closer than this (about 4,100 AU)
export const LEAVE_PC = 0.03;    // and leave it beyond this (hysteresis: no flapping at the border)

export const toSystemPos = (pc, hostPc) => [(pc[0] - hostPc[0]) * AU_PER_PC, (pc[1] - hostPc[1]) * AU_PER_PC, (pc[2] - hostPc[2]) * AU_PER_PC];
export const toGalaxyPos = (au, hostPc) => [au[0] / AU_PER_PC + hostPc[0], au[1] / AU_PER_PC + hostPc[1], au[2] / AU_PER_PC + hostPc[2]];

/** Units per parsec in the camera's frame. */
export const unitsPerPc = (cam) => (cam.frame === 'system' ? AU_PER_PC : 1);
/** Camera position in the galaxy frame (pc). */
export const worldPc = (cam) => (cam.frame === 'system' ? toGalaxyPos(cam.pos, cam.host.pc) : cam.pos.slice());
/** Vector from the camera to a body at galaxy position bodyPc, in the camera's frame units. Computed in doubles. */
export function relFromCam(cam, bodyPc) {
  if (cam.frame === 'system') {
    const h = cam.host.pc;
    return [(bodyPc[0] - h[0]) * AU_PER_PC - cam.pos[0], (bodyPc[1] - h[1]) * AU_PER_PC - cam.pos[1], (bodyPc[2] - h[2]) * AU_PER_PC - cam.pos[2]];
  }
  return [bodyPc[0] - cam.pos[0], bodyPc[1] - cam.pos[1], bodyPc[2] - cam.pos[2]];
}
/** Camera distance to its host in pc (Infinity in the galaxy frame). */
export const hostDistPc = (cam) => (cam.frame === 'system' ? Math.hypot(cam.pos[0], cam.pos[1], cam.pos[2]) / AU_PER_PC : Infinity);

/** Put a new camera together. Defaults to the galaxy frame at pos. */
export function makeCam({ pos = [0, 0, 0], yaw = 0, pitch = 0, speed = 2, frame = 'galaxy', host = null, disarm = null } = {}) {
  return { frame, host, pos: pos.slice(), vel: [0, 0, 0], yaw, pitch, speed, disarm };
}

/** Switch to the system frame of host. pos and vel are converted; the camera does not move in the world. */
export function enterSystem(cam, host) {
  if (cam.frame === 'system') leaveSystem(cam);
  cam.pos = toSystemPos(cam.pos, host.pc);
  cam.vel = cam.vel.map((v) => v * AU_PER_PC);
  cam.frame = 'system'; cam.host = host; cam.disarm = null;
}
export function leaveSystem(cam) {
  if (cam.frame !== 'system') return;
  const key = cam.host.key;
  cam.pos = toGalaxyPos(cam.pos, cam.host.pc);
  cam.vel = cam.vel.map((v) => v / AU_PER_PC);
  cam.frame = 'galaxy'; cam.host = null; cam.disarm = key;   // do not snap straight back in
}
/**
 * Decide whether to switch frames. cands: stars near the camera, each { idx, key, name, pc, distPc } (distPc from the
 * camera). Returns 'enter', 'leave' or null, after applying the switch to cam.
 */
export function stepFrame(cam, cands) {
  if (cam.frame === 'system') {
    if (hostDistPc(cam) > LEAVE_PC) { leaveSystem(cam); return 'leave'; }
    return null;
  }
  if (cam.disarm) {
    const d = cands.find((c) => c.key === cam.disarm);
    if (!d || d.distPc > LEAVE_PC) cam.disarm = null;   // moved away from where we started (or left): armed again
  }
  let best = null;
  for (const c of cands) if (c.distPc < ENTER_PC && c.key !== cam.disarm && (!best || c.distPc < best.distPc)) best = c;
  if (!best) return null;
  enterSystem(cam, { idx: best.idx, key: best.key, name: best.name, pc: best.pc });
  return 'enter';
}
