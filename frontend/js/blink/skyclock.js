// The shared sky clock (docs/object-framework.md section 20.3, decisions of 20.17). Pure: no DOM, no WebGL; imports skytime.js only.
//
// One SkyClock per page holds the sky time as a TT Julian Day, a signed rate in sky days per wall second, play/pause, a
// range, and a scripted trip (tweenTo). The 3D view uses it now; Phase 6's "Turn back the sky" constructs its own with its own range.
// Nothing here knows about the 3D view except SKYBOT_JD_RANGE (a source limit the page needs for its re-query rule, section 20.6).
//
// EXPORTS
//   RATES                       [1/24, 0.25, 1, 7, 30.436875, 365.25, 3652.5]  sky days per wall second: 1 h, 6 h, 1 d, 1 wk, 1 mo, 1 yr, 10 yr
//   SETTLE_MS = 1500            the quiet time of settled() and of the 'settle' event (17: the re-query debounce)
//   SKYBOT_JD_RANGE             { lo, hi, checked }  first and last TT JD IMCCE SkyBoT served when checked (section 20.2, bisection on the resolver)
//   jdNow(ms) -> jd             UTC from the wall clock (ms since the Unix epoch), then TT = UT + deltaT(year)/86400 (skytime.deltaT, seconds)
//   clockText(clock) -> { date, time, rate, dir, julian }   '20 Nov 2026', '14:00 UT', '1 day/s' ('−1 yr/s' reversed), dir 1 | -1 | 0 (0 paused or rate 0)
//   class SkyClock({ jd, minJd, maxJd, rate = 1, nowMs = () => Date.now() })
//     jd, minJd, maxJd, rate, playing (starts paused), held; mjd (getter, TT: jd - 2400000.5)
//     tick(wallMs) -> { jd, changed, limit }   wallMs is the absolute wall time (performance.now()); the first tick after play() advances by
//         nothing (no jump), later ticks by rate * dt / 1000 days; a tween overrides the rate; the range clamps. Reaching an end pauses,
//         sets limit to 'min' | 'max' and emits 'limit'. The returned object is reused (no allocation per frame).
//     play(), pause(), toggle()
//     setRate(r), faster(), slower() (step through RATES, keeping the sign), reverse()
//     setJd(jd, { source = 'user' })   clamps; source 'user' | 'now' | 'tween' | 'query' (tick() reports its own moves as 'play' and 'tween'); cancels a tween
//     jumpToNow()                      setJd(jdNow(nowMs()), { source: 'now' })
//     tweenTo(jd, { durationMs = 1000, ease })   a scripted trip (ease: t in 0..1 -> 0..1, default smoothstep); tick() follows it and it ends paused at jd
//     hold(on)                         while held (date field edited, scrub dragged) settled() is false and no 'settle' fires; releasing restarts the quiet timer
//     settled(wallMs, quietMs = SETTLE_MS) -> bool   (paused or rate 0) AND no tween AND not held AND jd unchanged for quietMs
//     on(event, fn) -> off()           'change' ({ jd, source }) | 'limit' ({ end: 'min' | 'max', jd }) | 'settle' ({ jd }) | 'rate' ({ rate })
//   'settle' fires once per settle, from tick(); a new clock counts as settled already (the page starts at its payload's epoch), so it does not fire at start.
import { calendarFromJd, deltaT, fmtYear, MONTHS } from './skytime.js';

export const RATES = [1 / 24, 0.25, 1, 7, 30.436875, 365.25, 3652.5];
export const SETTLE_MS = 1500;
/** SkyBoT's served range, found by bisection on the live resolver on 2026-11-20 (section 20.2): 1890-02-08..12 to 2060-03-21..26 (first and last served epochs; the refused ones were JD 2411406.5 and 2473544.5). */
export const SKYBOT_JD_RANGE = { lo: 2411410.5, hi: 2473539.5, checked: '2026-11-20' };

const MJD0 = 2400000.5, UNIX_JD = 2440587.5, DAY_MS = 86400000;
const decimalYear = (jd) => { const c = calendarFromJd(jd); return c.year + (c.month - 0.5) / 12; };   // as skytime.skyState does for deltaT
/** TT Julian Day of the wall-clock instant ms (ms since the Unix epoch, UTC): TT = UT + deltaT(year)/86400. */
export function jdNow(ms) {
  const jdUt = ms / DAY_MS + UNIX_JD;
  return jdUt + deltaT(decimalYear(jdUt)) / 86400;
}

const smooth = (t) => t * t * (3 - 2 * t);
const clampJd = (c, jd) => (jd < c.minJd ? c.minJd : jd > c.maxJd ? c.maxJd : jd);

export class SkyClock {
  constructor({ jd, minJd, maxJd, rate = 1, nowMs = () => Date.now() }) {
    this.minJd = minJd; this.maxJd = maxJd; this.jd = Math.min(Math.max(jd, minJd), maxJd);
    this.rate = rate; this.playing = false; this.held = false; this.nowMs = nowMs;
    this._dir = rate < 0 ? -1 : 1;        // the sign faster() restores from rate 0
    this._last = null;                    // wall time of the previous tick while playing (null: the next tick has no elapsed time)
    this._changedAt = null;               // wall time jd last changed (null: pending, stamped by the next tick or settled call)
    this._fired = true;                   // 'settle' already emitted for this quiet spell
    this._tween = null; this._res = { jd: this.jd, changed: false, limit: null }; this._on = { change: [], limit: [], settle: [], rate: [] };
  }
  get mjd() { return this.jd - MJD0; }

  on(event, fn) {
    const list = this._on[event];
    if (!list) throw new Error(`unknown clock event ${event}`);
    list.push(fn);
    return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  }
  _emit(event, payload) { for (const fn of this._on[event].slice()) fn(payload); }
  _touch() { this._changedAt = null; this._fired = false; }          // jd changed, or a quiet-timer restart: the next tick (or settled call) stamps the wall time
  _set(jd, source) {
    if (jd === this.jd) return false;
    this.jd = jd; this._touch(); this._emit('change', { jd, source });
    return true;
  }

  play() { this._tween = null; if (!this.playing) { this.playing = true; this._last = null; this._fired = false; } }
  pause() { this._tween = null; if (this.playing) { this.playing = false; this._last = null; this._touch(); } }
  toggle() { if (this.playing) this.pause(); else this.play(); }

  setRate(r) {
    if (!Number.isFinite(r) || r === this.rate) return;
    this.rate = r; if (r !== 0) this._dir = r < 0 ? -1 : 1;
    this._fired = false; this._emit('rate', { rate: r });
  }
  faster() {
    const a = Math.abs(this.rate), next = RATES.find((x) => x > a * (1 + 1e-9));
    this.setRate((this.rate === 0 ? this._dir : Math.sign(this.rate)) * (next === undefined ? RATES[RATES.length - 1] : next));
  }
  slower() {
    const a = Math.abs(this.rate);
    let prev = RATES[0];
    for (const x of RATES) if (x < a * (1 - 1e-9)) prev = x;
    this.setRate((this.rate === 0 ? this._dir : Math.sign(this.rate)) * prev);
  }
  reverse() { if (this.rate === 0) { this._dir = -this._dir; return; } this.setRate(-this.rate); }

  setJd(jd, { source = 'user' } = {}) { this._tween = null; return this._set(clampJd(this, jd), source); }
  jumpToNow() { return this.setJd(jdNow(this.nowMs()), { source: 'now' }); }
  tweenTo(jd, { durationMs = 1000, ease = smooth } = {}) {
    this.playing = false; this._last = null; this._fired = false;
    this._tween = { from: this.jd, to: clampJd(this, jd), t0: null, dur: Math.max(0, durationMs), ease };
  }
  hold(on) {
    on = !!on;
    if (on === this.held) return;
    this.held = on;
    this._touch();                         // pressing or releasing restarts the quiet timer; held blocks 'settle' until released
  }

  tick(wallMs) {
    const res = this._res; res.changed = false; res.limit = null;
    if (this._changedAt === null) this._changedAt = wallMs;
    const tw = this._tween;
    if (tw) {
      if (tw.t0 === null) tw.t0 = wallMs;
      const f = tw.dur > 0 ? Math.min(1, (wallMs - tw.t0) / tw.dur) : 1;
      const jd = f >= 1 ? tw.to : tw.from + (tw.to - tw.from) * tw.ease(f);
      if (f >= 1) { this._tween = null; this._touch(); }
      res.changed = this._set(jd, 'tween');
    } else if (this.playing) {
      if (this._last !== null && this.rate !== 0) {
        const raw = this.jd + this.rate * (wallMs - this._last) / 1000;
        const jd = clampJd(this, raw);
        res.changed = this._set(jd, 'play');
        if (jd !== raw) {
          this.playing = false; this._last = null; this._touch();
          res.limit = jd === this.minJd ? 'min' : 'max'; this._emit('limit', { end: res.limit, jd });
        } else this._last = wallMs;
      } else this._last = wallMs;
    }
    if (!this._fired && this.settled(wallMs)) { this._fired = true; this._emit('settle', { jd: this.jd }); }
    res.jd = this.jd;
    return res;
  }

  settled(wallMs, quietMs = SETTLE_MS) {
    if (this._changedAt === null) this._changedAt = wallMs;
    return (!this.playing || this.rate === 0) && !this._tween && !this.held && wallMs - this._changedAt >= quietMs;
  }
}

const RATE_UNITS = [['yr', 365.25], ['mo', 30.436875], ['wk', 7], ['day', 1], ['h', 1 / 24], ['min', 1 / 1440]];
function rateText(rate) {
  const a = Math.abs(rate);
  if (a === 0) return '0';
  const [unit, size] = RATE_UNITS.find(([, s]) => a >= s * (1 - 1e-9)) || RATE_UNITS[RATE_UNITS.length - 1];
  const v = Number((a / size).toFixed(2));
  return `${rate < 0 ? '−' : ''}${v} ${unit === 'day' && v !== 1 ? 'days' : unit}/s`;
}

/**
 * The readout of a clock: { date: '20 Nov 2026', time: '14:00 UT', rate: '1 day/s' ('−1 yr/s' when reversed), dir: 1 | -1 | 0, julian }.
 * Date and time are UT = TT - deltaT, to the minute; the Julian calendar before 1582 October 15 (julian: true), astronomical-year
 * numbering shown as CE below 1000 and BCE up to year 0 (skytime.fmtYear).
 */
export function clockText(clock) {
  const jdTt = clock.jd, jdUt = jdTt - deltaT(decimalYear(jdTt)) / 86400;
  const c = calendarFromJd(Math.round(jdUt * 1440) / 1440 + 1e-7);     // whole minutes (the 1e-7 d keeps 23:59.99 from rounding past the day)
  const year = c.year >= 1000 ? String(c.year) : fmtYear(c.year);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${c.day} ${MONTHS[c.month - 1].slice(0, 3)} ${year}`, time: `${pad(c.hour)}:${pad(c.minute)} UT`, rate: rateText(clock.rate),
    dir: !clock.playing || clock.rate === 0 ? 0 : clock.rate < 0 ? -1 : 1, julian: c.julian,
  };
}
