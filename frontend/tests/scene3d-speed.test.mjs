// The HUD speed blip (docs/object-framework.md section 19.3.6): scripted trips on the pure modules, 60 fps, the speed per frame as scene3d.js measures it.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../js/blink/scene3d-frames.js';
import * as M from '../js/blink/scene3d-math.js';
import { Autopilot, TURN_SECONDS, arrivalDistance, SpeedTracker, hudSpeed, smoothSpeed, SPEED_REL_FLOOR } from '../js/blink/scene3d-nav.js';

const DT = 1 / 60, AU = F.AU_PER_PC;
const NEAR_PC = 0.05;   // scene3d.js: the stars within this are candidates for stepFrame

/**
 * Runs the legs of a trip the way scene3d.js's _frame does: autopilot step (world pc, or AU inside a system), then the speed measure from the camera's world
 * position, then stepFrame. A leg is { type: 'world', to, stopAt } (a star or galaxy trip, pc) or { type: 'system', toAu, stopAt } (an in-system flight, AU). Legs chain on
 * arrival (the chained trip of _arrived), then the camera rests for `rest` seconds. frames: [{ t, phase, frame, switched, legacy, mode, speedPc, apPeakPc }].
 * `legacy` is the old HUD value: plain smoothing of the same measure, shown as moving above 1e-15 pc/s.
 */
function runTrip({ from, fromDir = [0, 0, -1], legs, stars = [], rest = 3, hitchAt = [], turnEps = null }) {
  const cam = F.makeCam({ pos: from.slice() }), tracker = new SpeedTracker(), frames = [];
  let legIdx = 0, ap = null, legacy = 0, last = null, t = 0, restLeft = rest, dir = fromDir;
  const startLeg = () => {
    const L = legs[legIdx++]; ap = new Autopilot(); ap.type = L.type;
    ap.start({ from: L.type === 'world' ? F.worldPc(cam) : cam.pos.slice(), fromDir: dir, to: L.type === 'world' ? L.to : L.toAu, stopAt: L.stopAt });
  };
  startLeg();
  for (let i = 0; i < 60 * 120 && restLeft > 0; i++) {
    // a long frame: scene3d.js clamps dt to 0.05; turnEps: the frame that ends the first turn overshoots 0.8 s by that much (real frame times are never on the 1/60 grid)
    const dt = hitchAt.includes(i) ? 0.05 : turnEps != null && i === 47 ? TURN_SECONDS - 47 * DT + turnEps : DT;
    if (ap && ap.active) {
      ap.retarget(ap.type === 'world' ? legs[legIdx - 1].to : legs[legIdx - 1].toAu);
      const r = ap.step(dt);
      dir = r.dir;
      cam.pos = ap.type === 'world' ? (cam.frame === 'system' ? F.toSystemPos(r.pos, cam.host.pc) : r.pos.map((v) => v * F.unitsPerPc(cam))) : r.pos.slice();
      if (r.done) { if (legIdx < legs.length) startLeg(); else ap = null; }
    } else restLeft -= dt;
    const w = F.worldPc(cam), apPeakPc = ap && ap.active ? ap.peakSpeed() / (ap.type === 'world' ? 1 : AU) : 0;
    const spd = tracker.update(w, dt, apPeakPc);
    if (last) legacy += (Math.hypot(w[0] - last[0], w[1] - last[1], w[2] - last[2]) / dt - legacy) * (1 - Math.exp(-dt * 10));
    last = w;
    const hud = hudSpeed(spd, ap), phase = ap && ap.active ? (ap.t < TURN_SECONDS ? 'turn' : 'go') : 'rest';
    const cands = stars.map((s, k) => ({ idx: k, key: `s${k}`, name: `s${k}`, pc: s, distPc: Math.hypot(s[0] - w[0], s[1] - w[1], s[2] - w[2]) })).filter((c) => c.distPc < NEAR_PC);
    const sw = F.stepFrame(cam, cands);
    t += dt;
    frames.push({ leg: legIdx, t, phase, frame: cam.frame, switched: sw, legacy, mode: hud.mode, speedPc: hud.speedPc, rawSmoothed: spd });
  }
  return frames;
}

const radec = (ra, dec, pc) => M.radecToXyz(ra, dec, pc);
const TRIPS = {
  'Sun to M87': () => ({ switches: true, from: [0, 0, 0], legs: [{ type: 'world', to: radec(187.7059, 12.3911, 16.8e6), stopAt: 3 * 1.9e5 }], hitchAt: [60, 200, 400] }),
  'Sun to TRAPPIST-1 e': () => {
    const star = radec(346.6224, -5.0414, 12.43);
    return { switches: true, from: [0, 0, 0], stars: [star], legs: [{ type: 'world', to: star, stopAt: arrivalDistance(8.4e-4) / AU }, { type: 'system', toAu: [0.0292, 0, 0.001], stopAt: 0.002 }] };
  },
  'LMC to SMC': () => {
    const lmc = radec(80.89375, -69.75611, 49590), smc = radec(13.1865833, -72.8286111, 62440), start = lmc.map((v, i) => v * 0.75 + [100, -50, 20][i]);
    return { from: start, fromDir: M.dirFromYawPitch(0, 0), legs: [{ type: 'world', to: smc, stopAt: 3 * 2400 }] };
  },
};

for (const [name, make] of Object.entries(TRIPS)) {
  for (const eps of [null, 1e-5, 3e-4, 0.004]) test(`speed HUD on ${name} (frame phase ${eps}): no moving speed below 1e-6 of the peak outside the turn and rest, 'turning' during the turn, at rest after`, () => {
    const trip = make(), frames = runTrip({ ...trip, turnEps: eps });
    const peaks = new Map();   // each leg of a chained trip has its own peak: the HUD floor follows the autopilot that is flying
    for (const f of frames) peaks.set(f.leg, Math.max(peaks.get(f.leg) || 0, f.speedPc));
    const peak = Math.max(...peaks.values()); assert.ok(peak > 0, 'the camera moved');
    let turning = 0, moving = 0;
    for (const f of frames) {
      if (f.mode === 'moving') { moving++; assert.ok(f.speedPc >= SPEED_REL_FLOOR * peaks.get(f.leg), `t=${f.t.toFixed(3)} ${f.phase} ${f.frame}: ${f.speedPc} vs peak ${peaks.get(f.leg)}`); }
      if (f.mode === 'turning') turning++;
      assert.ok(f.mode === 'turning' ? f.phase === 'turn' : true, 'turning only in the turn phase');
    }
    assert.ok(turning >= 40 && moving > 100, `${turning} turning, ${moving} moving`);
    assert.equal(frames.slice(0, 40).every((f) => f.mode === 'turning'), true, 'the first 0.8 s are the turn');
    const tail = frames.slice(-60 * 1.5 + 1);   // the last 1.5 s of a 3 s rest: nothing is moving
    assert.ok(tail.every((f) => f.mode === 'rest' && f.speedPc === 0), 'at rest after the trip');
    if (trip.switches) assert.ok(frames.some((f) => f.switched), 'a frame switch happened on this trip');
    // the switch itself is not a blip: the smoothed speed is continuous across it
    frames.forEach((f, i) => { if (f.switched && i > 0 && f.phase === 'go') assert.ok(f.rawSmoothed > 0.3 * frames[i - 1].rawSmoothed && f.rawSmoothed < 3 * frames[i - 1].rawSmoothed || frames[i - 1].rawSmoothed === 0, `switch at ${i}`); });
  });
}

test('the cause: the old readout (plain smoothing, moving above 1e-15 pc/s) printed a tiny moving speed in the first frames of the travel phase and in the tail after a stop', () => {
  for (const [name, make] of Object.entries(TRIPS)) {
    const frames = runTrip({ ...make(), turnEps: 1e-5 }), peak = Math.max(...frames.map((f) => f.legacy));
    const blips = frames.filter((f) => f.phase === 'go' && f.legacy > 1e-15 && f.legacy < SPEED_REL_FLOOR * peak);
    assert.ok(blips.length >= 1, name + ': ' + 'the old readout shows a moving speed under 1e-6 of the peak');
    const first = frames.findIndex((f) => f.phase === 'go');
    assert.ok(frames[first].legacy < 1e-6 * peak, 'it is the ease-in from rest: the first travel frame is essentially still');
    const tail = frames.filter((f) => f.phase === 'rest' && f.legacy > 1e-15);
    assert.ok(tail.length > 30, 'and the tail after the stop reads as a speed for a second or more');
    // the new readout shows none of them
    const peaks = new Map(); for (const f of frames) peaks.set(f.leg, Math.max(peaks.get(f.leg) || 0, f.speedPc));
    assert.equal(frames.filter((f) => f.mode === 'moving' && f.speedPc < SPEED_REL_FLOOR * peaks.get(f.leg)).length, 0);
    assert.ok(frames.filter((f) => f.phase === 'rest' && f.mode === 'moving').length < tail.length, 'the new tail is shorter');
  }
});

test('Autopilot.peakSpeed is the trip\'s measured peak (to within the smoothing), 0 when idle', () => {
  const ap = new Autopilot(); assert.equal(ap.peakSpeed(), 0);
  ap.start({ from: [0, 0, 0], fromDir: [0, 0, -1], to: [0, 0, -1e6], stopAt: 100 });
  const pk = ap.peakSpeed(); let best = 0, prev = ap.pos.slice();
  for (let i = 0; i < 60 * 12; i++) { const r = ap.step(DT); best = Math.max(best, Math.hypot(r.pos[0] - prev[0], r.pos[1] - prev[1], r.pos[2] - prev[2]) / DT); prev = r.pos; }
  assert.ok(Math.abs(pk / best - 1) < 0.03, `${pk} ${best}`); assert.equal(ap.peakSpeed(), 0, 'done');
});

test('SpeedTracker and hudSpeed: free flight, a stop, a slow flight after a fast one, the turn phase', () => {
  const tr = new SpeedTracker(); let x = 0;
  for (let i = 0; i < 120; i++) { x += 5 * DT; tr.update([x, 0, 0], DT); }
  assert.ok(Math.abs(tr.speedPc - 5) < 0.01); assert.equal(hudSpeed(tr.speedPc).mode, 'moving');
  for (let i = 0; i < 90; i++) tr.update([x, 0, 0], DT);   // stops dead: the tail snaps to rest after about 1.4 s, not 3.5 s
  assert.equal(tr.speedPc, 0); assert.equal(hudSpeed(tr.speedPc).mode, 'rest');
  for (let i = 0; i < 120; i++) tr.update([x, 0, 0], DT);
  assert.equal(tr.peak, 0, 'the peak is forgotten after a second at rest');
  for (let i = 0; i < 60; i++) { x += 1e-9 * DT; tr.update([x, 0, 0], DT); }   // 1 nanoparsec per second after a 5 pc/s flight: shown
  assert.ok(tr.speedPc > 5e-10 && hudSpeed(tr.speedPc).mode === 'moving', `${tr.speedPc}`);
  const ap = new Autopilot().start({ from: [0, 0, 0], fromDir: [0, 0, -1], to: [0, 0, -100], stopAt: 1 });
  assert.deepEqual(hudSpeed(3, ap), { mode: 'turning', speedPc: 0 }); ap.step(1); assert.equal(hudSpeed(3, ap).mode, 'moving');
  assert.equal(hudSpeed(0, null).mode, 'rest'); assert.equal(hudSpeed(1e-16, null).mode, 'rest');
  assert.equal(smoothSpeed(0, 10, 0.1), 10 * (1 - Math.exp(-1)));
});
