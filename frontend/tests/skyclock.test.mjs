// The shared sky clock (docs/object-framework.md section 20.3 and 20.17): time stepping, range, rates, tweens, settle and the readout text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SkyClock, RATES, SETTLE_MS, SKYBOT_JD_RANGE, jdNow, clockText } from '../js/blink/skyclock.js';
import { jdFromCalendar, deltaT } from '../js/blink/skytime.js';

const JD_MIN = jdFromCalendar(1900, 1, 1), JD_MAX = jdFromCalendar(2100, 1, 1);
const mk = (o = {}) => new SkyClock({ jd: 2461360, minJd: JD_MIN, maxJd: JD_MAX, rate: 1, ...o });

test('constants: RATES, SETTLE_MS, and SkyBoT\'s served range with its check date', () => {
  assert.deepEqual(RATES, [1 / 24, 0.25, 1, 7, 30.436875, 365.25, 3652.5]);
  assert.equal(SETTLE_MS, 1500);
  assert.deepEqual(SKYBOT_JD_RANGE, { lo: 2411410.5, hi: 2473539.5, checked: '2026-11-20' });
});

test('a new clock is paused; tick does not move it; mjd = jd - 2400000.5', () => {
  const c = mk();
  assert.equal(c.playing, false); assert.equal(c.mjd, 2461360 - 2400000.5);
  const r = c.tick(1000); assert.deepEqual({ ...r }, { jd: 2461360, changed: false, limit: null });
});

test('tick at each rate, both directions: advances rate * dt / 1000 days; the first tick after play moves nothing', () => {
  for (const rate of RATES) for (const sign of [1, -1]) {
    const c = mk({ rate: sign * rate });
    c.tick(5000); c.play();
    assert.equal(c.tick(6000).changed, false, 'first tick after play: no elapsed time');
    assert.equal(c.jd, 2461360);
    const r = c.tick(7000);                                                  // 1 s later
    assert.ok(Math.abs(c.jd - (2461360 + sign * rate)) < 1e-9, `rate ${sign * rate}: ${c.jd}`);
    assert.equal(r.changed, true); assert.equal(r.jd, c.jd);
    c.tick(7500);                                                             // half a second more
    assert.ok(Math.abs(c.jd - (2461360 + sign * rate * 1.5)) < 1e-9);
  }
});

test('tick returns one reused object (no allocation per frame)', () => {
  const c = mk(); c.play(); const a = c.tick(0), b = c.tick(16);
  assert.equal(a, b);
});

test('pause then play: the gap is not counted (no jump)', () => {
  const c = mk(); c.play(); c.tick(0); c.tick(1000);
  const jd = c.jd; c.pause(); c.tick(10000); c.play(); c.tick(20000);
  assert.equal(c.jd, jd);
  c.tick(21000); assert.ok(Math.abs(c.jd - (jd + 1)) < 1e-9);
});

test('clamping and limit at both ends: reaching an end pauses and emits limit with which end', () => {
  const c = mk({ jd: JD_MAX - 0.5, rate: 1 }), seen = [];
  c.on('limit', (e) => seen.push(e)); c.play(); c.tick(0);
  const r = c.tick(2000);
  assert.equal(c.jd, JD_MAX); assert.equal(c.playing, false); assert.equal(r.limit, 'max'); assert.deepEqual(seen, [{ end: 'max', jd: JD_MAX }]);
  assert.equal(c.tick(3000).limit, null, 'the flag is for one tick only');
  c.setRate(-100); c.play(); c.tick(4000);
  const r2 = c.tick(6000 * 1000 * 1000);                                      // far into the past
  assert.equal(c.jd, JD_MIN); assert.equal(r2.limit, 'min'); assert.equal(seen[1].end, 'min'); assert.equal(c.playing, false);
  c.setJd(JD_MAX + 50); assert.equal(c.jd, JD_MAX); c.setJd(JD_MIN - 50); assert.equal(c.jd, JD_MIN);
  assert.equal(mk({ jd: 0 }).jd, JD_MIN, 'the constructor clamps too');
});

test('faster / slower step through RATES keeping the sign; reverse flips it; rate events fire', () => {
  const c = mk({ rate: 1 }), events = []; c.on('rate', (e) => events.push(e.rate));
  c.faster(); assert.equal(c.rate, 7); c.faster(); c.faster(); c.faster(); assert.equal(c.rate, 3652.5); c.faster(); assert.equal(c.rate, 3652.5);
  c.slower(); assert.equal(c.rate, 365.25);
  c.reverse(); assert.equal(c.rate, -365.25); c.slower(); assert.equal(c.rate, -30.436875); c.faster(); c.faster(); assert.equal(c.rate, -3652.5);
  for (let k = 0; k < 10; k++) c.slower(); assert.equal(c.rate, -RATES[0], 'the bottom of the ladder is 1 h/s, never 0');
  const off = mk({ rate: 3 }); off.faster(); assert.equal(off.rate, 7, 'a rate between steps goes to the next step up'); off.setRate(3); off.slower(); assert.equal(off.rate, 1);
  assert.ok(events.length >= 6);
  const z = mk({ rate: 0 }); z.faster(); assert.equal(z.rate, RATES[0]);
});

test('setJd clamps, reports its source in change events, and ignores no-ops', () => {
  const c = mk(), ev = []; c.on('change', (e) => ev.push(e));
  c.setJd(2461400, { source: 'query' }); c.setJd(2461400); c.setJd(JD_MAX + 9, { source: 'user' });
  assert.deepEqual(ev, [{ jd: 2461400, source: 'query' }, { jd: JD_MAX, source: 'user' }]);
  const off = c.on('change', () => ev.push('x')); off(); c.setJd(2461000); assert.equal(ev.at(-1).jd, 2461000);
  assert.throws(() => c.on('bogus', () => {}));
});

test('jdNow: UTC from the wall clock, then TT = UT + deltaT(year); jumpToNow uses nowMs and clamps', () => {
  const ms = Date.UTC(2026, 10, 20, 14, 0, 0);                                         // 2026-11-20 14:00 UTC
  const expect = jdFromCalendar(2026, 11, 20 + 14 / 24);                               // its UT Julian Day, by the calendar routine
  const tt = jdNow(ms);
  assert.ok(Math.abs(tt - (expect + deltaT(2026 + 10.5 / 12) / 86400)) < 1e-9, `${tt}`);
  assert.ok(Math.abs(jdNow(Date.UTC(2000, 0, 1, 12)) - (2451545.0 + deltaT(2000 + 0.5 / 12) / 86400)) < 1e-9, 'J2000.0 UTC noon');
  const c = mk({ nowMs: () => ms }); c.setJd(2460000); const ev = []; c.on('change', (e) => ev.push(e.source));
  c.jumpToNow(); assert.equal(c.jd, tt); assert.deepEqual(ev, ['now']);
  const far = mk({ nowMs: () => Date.UTC(2500, 0, 1) }); far.jumpToNow(); assert.equal(far.jd, JD_MAX);
});

test('tweenTo: follows the easing, overrides the rate, ends paused at the target, emits change with source tween', () => {
  const c = mk({ rate: 7 }), ev = []; c.on('change', (e) => ev.push(e.source));
  c.play(); c.tick(0); c.tweenTo(2461360 + 100, { durationMs: 1000, ease: (t) => t * t });
  assert.equal(c.playing, false);
  c.tick(100);                                                                // the tween starts at its first tick
  assert.equal(c.jd, 2461360);
  c.tick(600); assert.ok(Math.abs(c.jd - (2461360 + 100 * 0.25)) < 1e-9, `half-way in time is a quarter of the way with t^2: ${c.jd}`);
  c.tick(5000); assert.equal(c.jd, 2461460); assert.equal(c.playing, false);
  assert.ok(ev.every((s) => s === 'tween') && ev.length >= 2);
  c.tick(6000); assert.equal(c.jd, 2461460, 'ended paused: the old rate does not take over');
  // default easing is monotone from 0 to 1; targets clamp; a zero duration jumps on the next tick; setJd cancels
  const d = mk(); d.tweenTo(JD_MAX + 1e6, { durationMs: 1000 }); d.tick(0); let prev = d.jd; for (let t = 100; t <= 1000; t += 100) { d.tick(t); assert.ok(d.jd >= prev); prev = d.jd; }
  assert.equal(d.jd, JD_MAX);
  const z = mk(); z.tweenTo(2461361, { durationMs: 0 }); z.tick(0); assert.equal(z.jd, 2461361);
  const s = mk(); s.tweenTo(2462000); s.tick(0); s.setJd(2461000); s.tick(500); assert.equal(s.jd, 2461000);
});

test('settled: false while playing, true after SETTLE_MS of quiet when paused; rate 0 counts as paused', () => {
  const c = mk(); c.play(); c.tick(0); c.tick(1000);
  assert.equal(c.settled(1000 + 5000), false, 'not while playing, however long');
  c.pause(); c.tick(1000);
  assert.equal(c.settled(1000 + SETTLE_MS - 1), false); assert.equal(c.settled(1000 + SETTLE_MS), true);
  assert.equal(c.settled(1000 + 400, 300), true, 'a custom quiet time');
  c.setJd(2461999); c.tick(1100);
  assert.equal(c.settled(1100 + 1000), false, 'a change restarts the quiet time'); assert.equal(c.settled(1100 + SETTLE_MS), true);
  const r0 = mk({ rate: 0 }); r0.play(); r0.tick(0); r0.tick(10); assert.equal(r0.settled(10 + SETTLE_MS), true, 'rate 0: nothing moves');
  const t = mk(); t.tick(0); t.tweenTo(2461400, { durationMs: 1000 }); t.tick(100);
  assert.equal(t.settled(100 + 9000), false, 'not while a tween runs'); t.tick(1200);
  assert.equal(t.settled(1200 + SETTLE_MS - 1), false); assert.equal(t.settled(1200 + SETTLE_MS), true, 'a tween that ended settles after the quiet time');
});

test('hold: while held there is no settle; releasing restarts the quiet timer', () => {
  const c = mk(), fired = []; c.on('settle', () => fired.push(1));
  c.tick(0); c.hold(true); c.setJd(2461500); c.tick(100);
  assert.equal(c.held, true); assert.equal(c.settled(100 + 60000), false); c.tick(100 + 60000); assert.equal(fired.length, 0);
  c.hold(false); c.tick(70000);
  assert.equal(c.settled(70000 + SETTLE_MS - 1), false, 'quiet time restarts at the release');
  c.tick(70000 + SETTLE_MS - 1); assert.equal(fired.length, 0);
  c.tick(70000 + SETTLE_MS); assert.equal(fired.length, 1);
});

test('settle fires once per settle, from tick, never at start or while playing; a new change arms the next one', () => {
  const c = mk(), fired = []; c.on('settle', (e) => fired.push(e.jd));
  for (let t = 0; t <= 10000; t += 500) c.tick(t);
  assert.deepEqual(fired, [], 'a fresh clock is already settled at its payload epoch: no event');
  c.setJd(2461500); c.tick(10000);
  for (let t = 10500; t <= 14000; t += 500) c.tick(t);
  assert.deepEqual(fired, [2461500], 'exactly once, 1.5 s after the change');
  c.play(); c.tick(15000); c.tick(16000); c.tick(17000); assert.equal(fired.length, 1);
  c.pause(); for (let t = 17000; t <= 22000; t += 500) c.tick(t);
  assert.equal(fired.length, 2); assert.equal(fired[1], c.jd);
  c.setRate(30); for (let t = 22500; t <= 26000; t += 500) c.tick(t);
  assert.equal(fired.length, 3, 'a rate change while paused arms a settle too (the date is unchanged)');
  const w = mk(); w.tweenTo(2461400, { durationMs: 500 }); const f2 = []; w.on('settle', () => f2.push(1));
  for (let t = 0; t <= 5000; t += 100) w.tick(t);
  assert.equal(f2.length, 1, 'a tween ending settles once');
});

test('toggle plays and pauses', () => {
  const c = mk(); c.toggle(); assert.equal(c.playing, true); c.toggle(); assert.equal(c.playing, false);
});

test('clockText: modern dates, 1900, 2100 and a BCE date in the Julian calendar', () => {
  // TT = UT + deltaT; the readout is UT, to the minute
  const at = (y, m, d, h = 0, min = 0) => { const ut = jdFromCalendar(y, m, d + (h + min / 60) / 24); return mk({ jd: ut + deltaT(y + (m - 0.5) / 12) / 86400, minJd: -1e7, maxJd: 1e7 }); };
  let t = clockText(at(2026, 11, 20, 14, 0));
  assert.deepEqual(t, { date: '20 Nov 2026', time: '14:00 UT', rate: '1 day/s', dir: 0, julian: false });
  t = clockText(at(1900, 1, 1, 0, 0)); assert.equal(t.date, '1 Jan 1900'); assert.equal(t.time, '00:00 UT');
  t = clockText(at(2099, 12, 31, 23, 59)); assert.equal(t.date, '31 Dec 2099'); assert.equal(t.time, '23:59 UT');
  t = clockText(at(2100, 1, 1, 0, 0)); assert.equal(t.date, '1 Jan 2100');
  const bce = clockText(at(-2559, 3, 5, 6, 30));                               // 2560 BCE, Julian calendar (astronomical year -2559)
  assert.equal(bce.date, '5 Mar 2560 BCE'); assert.equal(bce.time, '06:30 UT'); assert.equal(bce.julian, true);
  assert.equal(clockText(at(26, 7, 4, 12, 0)).date, '4 Jul 26 CE');
  assert.equal(clockText(at(1582, 10, 4, 12, 0)).julian, true); assert.equal(clockText(at(1582, 10, 15, 12, 0)).julian, false);
});

test('clockText rate and direction: unit names, minus sign when reversed, dir 0 when paused', () => {
  const c = mk(), want = ['1 h/s', '6 h/s', '1 day/s', '1 wk/s', '1 mo/s', '1 yr/s', '10 yr/s'];
  RATES.forEach((r, i) => { c.setRate(r); assert.equal(clockText(c).rate, want[i]); c.setRate(-r); assert.equal(clockText(c).rate, `−${want[i]}`); });
  c.setRate(2); assert.equal(clockText(c).rate, '2 days/s'); c.setRate(1 / 1440); assert.equal(clockText(c).rate, '1 min/s'); c.setRate(0); assert.equal(clockText(c).rate, '0');
  c.setRate(1); assert.equal(clockText(c).dir, 0, 'paused'); c.play(); assert.equal(clockText(c).dir, 1);
  c.setRate(-1); assert.equal(clockText(c).dir, -1); c.setRate(0); assert.equal(clockText(c).dir, 0);
});
