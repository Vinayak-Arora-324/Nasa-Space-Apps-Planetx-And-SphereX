import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutTimeline, posToX, xToPos, nearestFrame, fitLabels, fmtTaken, fmtVisit, fmtSpan, fmtAgo } from '../js/blink/timeslider.js';

// MJD 60800 = 2025-05-05 00:00 UTC
const visit = (v, t0, offsets) => offsets.map((h) => ({ mjd: t0 + h / 24, visit: v }));
const threeVisits = () => [...visit(0, 60800, [0, 2, 4, 30]), ...visit(1, 61000, [0, 1]), ...visit(2, 61200, [5])];

test('segments cover the track in order, one per visit, with labelled gaps between them', () => {
  const F = threeVisits(), { segs, xs, gaps } = layoutTimeline(F, { gapFrac: 0.05 });
  assert.equal(segs.length, 3);
  assert.deepEqual(segs.map((s) => [s.i0, s.i1]), [[0, 3], [4, 5], [6, 6]]);
  assert.equal(segs[0].x0, 0); assert.equal(segs[2].x1, 1);
  for (let k = 1; k < segs.length; k++) assert.ok(segs[k].x0 > segs[k - 1].x1, 'segments are separated by a gap');
  assert.equal(gaps.length, 2);
  assert.ok(Math.abs(gaps[0].days - (200 - 30 / 24)) < 1e-9, 'a gap reports the real time it stands for');
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], 'frames are in time order on the track');
  for (const s of segs) for (let i = s.i0; i <= s.i1; i++) assert.ok(xs[i] > s.x0 && xs[i] < s.x1, 'frames sit inside their visit');
});

test('inside a visit, frames are spaced by when they were taken', () => {
  const { xs } = layoutTimeline(visit(0, 60800, [0, 1, 2, 30]));
  const step = xs[1] - xs[0];
  assert.ok(Math.abs((xs[2] - xs[1]) - step) < 1e-9);
  assert.ok(Math.abs((xs[3] - xs[2]) - 28 * step) < 1e-9, 'a 28 h wait is 28 times the width of a 1 h wait');
});

test('frames taken at the same moment are spread evenly; a lone frame sits in the middle of its segment', () => {
  const same = layoutTimeline(visit(0, 60800, [0, 0, 0])).xs;
  assert.ok(same[0] < same[1] && same[1] < same[2]);
  const { segs, xs } = layoutTimeline(threeVisits());
  assert.ok(Math.abs(xs[6] - (segs[2].x0 + segs[2].x1) / 2) < 1e-9);
});

test('posToX and xToPos invert each other, also across the gap between visits', () => {
  const { xs } = layoutTimeline(threeVisits());
  for (const p of [0, 0.25, 1, 2.5, 3.5, 4, 5.9, 6]) assert.ok(Math.abs(xToPos(xs, posToX(xs, p)) - p) < 1e-9, `pos ${p}`);
  assert.equal(xToPos(xs, -1), 0); assert.equal(xToPos(xs, 2), 6);
  assert.equal(nearestFrame(xs, xs[4] + 1e-4), 4);
  assert.equal(nearestFrame(xs, 0), 0); assert.equal(nearestFrame(xs, 1), 6);
});

test('many visits never let the gaps take more than about a third of the track', () => {
  const F = Array.from({ length: 20 }, (_, v) => ({ mjd: 60800 + v * 100, visit: v }));
  const { segs } = layoutTimeline(F, { gapFrac: 0.2 });
  const covered = segs.reduce((a, s) => a + (s.x1 - s.x0), 0);
  assert.ok(covered >= 0.65 - 1e-9, `segments cover ${covered}`);
});

test('empty and single-frame timelines do not break', () => {
  assert.deepEqual(layoutTimeline([]).xs, []);
  assert.equal(posToX([], 3), 0); assert.equal(xToPos([], 0.4), 0);
  const one = layoutTimeline([{ mjd: 60800, visit: 0 }]);
  assert.equal(one.xs[0], 0.5); assert.equal(xToPos(one.xs, 0.9), 0);
});

test('labels that would overlap are dropped, the higher priority ones kept', () => {
  const kept = fitLabels([{ x: 0, w: 50, t: 'a' }, { x: 30, w: 40, t: 'b' }, { x: 70, w: 20, t: 'c' }, { x: 290, w: 30, t: 'd' }], 300);
  assert.deepEqual(kept.map((k) => k.t), ['a', 'c', 'd']);
  assert.equal(kept[2].x, 270, 'a label is pulled back inside the track');
});

test('dates and lengths read the way a person would say them', () => {
  assert.equal(fmtTaken(60800 + (3 + 12 / 60) / 24), '5 May 2025 · 03:12 UTC');
  assert.equal(fmtVisit(60800, 60802.5), '5–7 May 2025');
  assert.equal(fmtVisit(60800, 60800.2), '5 May 2025');
  assert.equal(fmtVisit(60826, 60828), '31 May – 2 Jun 2025');
  assert.equal(fmtVisit(60800, 61000), 'May – Nov 2025');
  assert.equal(fmtVisit(61000, 61100), 'Nov 2025 – Mar 2026');
  assert.equal(fmtSpan(0.01), '14 min');
  assert.equal(fmtSpan(5.2 / 24), '5.2 h');
  assert.equal(fmtSpan(3.4), '3.4 d');
  assert.equal(fmtSpan(200), '7 mo');
  assert.equal(fmtSpan(400), '1 yr 1 mo');
  assert.equal(fmtSpan(365.25), '1 yr');
  const now = Date.UTC(2026, 10, 16);
  assert.equal(fmtAgo(60800, now), '1 yr 6 mo ago');
  assert.equal(fmtAgo(70000, now), 'just now');
});
