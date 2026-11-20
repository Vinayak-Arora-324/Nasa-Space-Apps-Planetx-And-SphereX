// Re-query policy of the 3D view (docs/object-framework.md section 20.6 and the binding conditions of 20.17 item 3). Pure: no DOM, no WebGL;
// the page gives it a fetch function and a wall clock, so it runs under node.
//
// WHY. Only small bodies (SkyBoT) need the server at a new date: the planets are computed in the browser and the static datasets do not depend on
// the date. When the clock SETTLES (skyclock.js: paused, unchanged for SETTLE_MS, not held) on a different day, the page asks /api/objects again
// for the same cone at that day, because the set of small bodies in the cone changes with the date and the two-body states drift (section 20.5).
//
// EXPORTS
//   REQUERY_CAP_MS = 5000, CACHE_SIZE = 8
//   dayOf(mjd) -> number                           the nearest whole day (0 h TT): the date a re-query asks for
//   checkRequery({ mjd, payloadMjd }) -> { go, why, day, payloadDay }
//       go: the settled date is a different day from the payload's AND inside SkyBoT's served range AND inside the view range.
//       why: null | 'no-payload' | 'same-day' | 'outside-skybot' | 'outside-view'
//   skybotRangeText() -> '1890–2060'
//   coneKey({ ra, dec, radius }) -> string;  fmtDay(mjd) -> '20 Nov 2026' (the TT calendar day of a whole-day mjd, no time)
//   class PayloadCache(size = CACHE_SIZE)          LRU by (cone, day): get(cone, day) (marks it used), set(cone, day, payload), has(cone, day), size
//   smallBodyIds(payload) -> Set                   ids of the asteroid, comet and dwarf_planet records
//   populationDiff(before, after) -> { entered, left, changed }   counts from two id sets
//   populationText(diff, mjd) -> string            '27 small bodies entered the cone and 31 left on 20 Nov 2026' ('' when unchanged)
//   skybotState(payload) -> { ok, error }          the payload's `sources` row for 'skybot' (status not 'ok' is a failure); without a row, the small kinds' status
//   requeryStatus({ state, mjd, playing, rate, now }) -> string[]   what the time bar says about small bodies, most important first (section 20.17 item 3):
//       'Fetching the small bodies for <date>…', the 5 s population notice, the SkyBoT range / failure messages, and while playing off the payload's day
//       'Small bodies: the N in the cone on <payload date>, moved along their orbits; pause to fetch the ones there on <date>'
//   class Requerier({ cone, fetchObjects(params, signal) -> Promise<payload>, now() -> ms, onIngest(payload, info) })
//       seed(payload)            the payload that is drawn now (the first one): caches it and records its day and small-body ids
//       onSettle(mjd)            the clock settled at mjd (TT MJD): applies the rules above (cache hit: ingest at once, no request; otherwise a request,
//                                 at most one START per REQUERY_CAP_MS, a settle inside the cap is deferred to its end and only the latest survives)
//       tick()                   starts a deferred request once the cap has run out; the page calls it every frame
//       abort()                  cancels what is in flight and what is deferred (a newer one starting does this by itself)
//       state                    { payloadMjd, payloadDay, nSmall, fetchingDay, pendingDay, fail: null | { kind: 'skybot' | 'network', day, error }, notice: null | { text, until } }
//   onIngest(payload, { day, fromCache, entered, left }) is called with a payload to draw; the page ingests it and moves the store to the clock's date.
import { SKYBOT_JD_RANGE } from './skyclock.js';
import { VIEW_JD_RANGE } from './scene3d-motion.js';
import { calendarFromJd, MONTHS } from './skytime.js';

export const REQUERY_CAP_MS = 5000;
export const CACHE_SIZE = 8;
export const NOTICE_MS = 5000;
const MJD0 = 2400000.5;
const SMALL = new Set(['asteroid', 'comet', 'dwarf_planet']);

export const dayOf = (mjd) => Math.round(mjd);

/** Whether a settle at mjd should fetch: a different day from the payload's, inside SkyBoT's served range and the view range. */
export function checkRequery({ mjd, payloadMjd }) {
  const day = dayOf(mjd), payloadDay = Number.isFinite(payloadMjd) ? dayOf(payloadMjd) : null, jd = day + MJD0;
  let why = null;
  if (payloadDay === null) why = 'no-payload';                     // nothing drawn yet: the first payload is the page's own request
  else if (payloadDay === day) why = 'same-day';
  else if (jd < VIEW_JD_RANGE.min || jd > VIEW_JD_RANGE.max) why = 'outside-view';
  else if (jd < SKYBOT_JD_RANGE.lo || jd > SKYBOT_JD_RANGE.hi) why = 'outside-skybot';
  return { go: why === null, why, day, payloadDay };
}

export const skybotRangeText = () => `${calendarFromJd(SKYBOT_JD_RANGE.lo).year}–${calendarFromJd(SKYBOT_JD_RANGE.hi).year}`;

export const coneKey = (c) => `${Number(c.ra).toFixed(5)}|${Number(c.dec).toFixed(5)}|${Number(c.radius)}`;

/** '20 Nov 2026': the calendar day of a TT MJD (a whole-day mjd is 0 h TT, so no UT conversion is involved). */
export function fmtDay(mjd) {
  if (!Number.isFinite(mjd)) return 'n/a';
  const c = calendarFromJd(mjd + MJD0 + 1e-7);
  return `${c.day} ${MONTHS[c.month - 1].slice(0, 3)} ${c.year}`;
}

export class PayloadCache {
  constructor(size = CACHE_SIZE) { this.max = size; this.map = new Map(); }
  _k(cone, day) { return `${typeof cone === 'string' ? cone : coneKey(cone)}@${day}`; }
  get size() { return this.map.size; }
  has(cone, day) { return this.map.has(this._k(cone, day)); }
  get(cone, day) {
    const k = this._k(cone, day), v = this.map.get(k);
    if (v === undefined) return null;
    this.map.delete(k); this.map.set(k, v);   // most recently used last
    return v;
  }
  set(cone, day, payload) {
    const k = this._k(cone, day);
    this.map.delete(k); this.map.set(k, payload);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

export function smallBodyIds(payload) {
  const ids = new Set();
  for (const o of payload && Array.isArray(payload.objects) ? payload.objects : []) if (o && SMALL.has(o.kind) && typeof o.id === 'string') ids.add(o.id);
  return ids;
}

export function populationDiff(before, after) {
  let entered = 0, left = 0;
  for (const id of after) if (!before.has(id)) entered++;
  for (const id of before) if (!after.has(id)) left++;
  return { entered, left, changed: entered > 0 || left > 0 };
}

const bodies = (n) => `${n.toLocaleString('en-US')} small ${n === 1 ? 'body' : 'bodies'}`;
export function populationText(diff, mjd) {
  if (!diff || !diff.changed) return '';
  const when = fmtDay(mjd);
  if (diff.entered && diff.left) return `${bodies(diff.entered)} entered the cone and ${diff.left.toLocaleString('en-US')} left on ${when}`;
  return diff.entered ? `${bodies(diff.entered)} entered the cone on ${when}` : `${bodies(diff.left)} left the cone on ${when}`;
}

/** SkyBoT's own row of the payload's `sources` (status 'ok' or 'error'); without a row the small kinds' own status decides. */
export function skybotState(payload) {
  const row = payload && Array.isArray(payload.sources) ? payload.sources.find((s) => s && s.id === 'skybot') : null;
  if (row) return row.status === 'ok' ? { ok: true, error: null } : { ok: false, error: row.error || 'SkyBoT did not answer' };
  const kinds = (payload && payload.kinds) || {}, bad = [...SMALL].map((k) => kinds[k]).find((k) => k && k.status === 'error');
  return bad ? { ok: false, error: bad.error || 'SkyBoT did not answer' } : { ok: true, error: null };
}

export function requeryStatus({ state, mjd, playing = false, rate = 1, now = 0 }) {
  const out = [], chk = checkRequery({ mjd, payloadMjd: state.payloadMjd }), moving = playing && rate !== 0;
  if (state.fetchingDay !== null || state.pendingDay !== null) out.push(`Fetching the small bodies for ${fmtDay(state.pendingDay !== null ? state.pendingDay : state.fetchingDay)}…`);
  if (state.notice && now < state.notice.until) out.push(state.notice.text);
  const from = fmtDay(state.payloadMjd);
  if (chk.why === 'outside-skybot' || chk.why === 'outside-view') out.push(`SkyBoT serves ${skybotRangeText()}; small bodies are the ones from ${from}, moved along their orbits`);
  else if (state.fail && !moving && chk.go) out.push(`SkyBoT did not answer; small bodies are the ones from ${from}, moved along their orbits`);
  else if (moving && chk.go) out.push(`Small bodies: the ${state.nSmall.toLocaleString('en-US')} in the cone on ${from}, moved along their orbits; pause to fetch the ones there on ${fmtDay(chk.day)}`);
  return out;
}

export class Requerier {
  constructor({ cone, fetchObjects, now = () => Date.now(), onIngest = () => {} }) {
    this.cone = cone; this.fetchObjects = fetchObjects; this.now = now; this.onIngest = onIngest;
    this.cache = new PayloadCache(); this._ids = new Set(); this._ctl = null; this._lastStart = -Infinity; this._pending = null;
    this.state = { payloadMjd: null, payloadDay: null, nSmall: 0, fetchingDay: null, pendingDay: null, fail: null, notice: null };
  }
  _setPayload(payload) {
    const m = payload && payload.query && Number.isFinite(payload.query.mjd) ? payload.query.mjd : null;
    this._ids = smallBodyIds(payload);
    Object.assign(this.state, { payloadMjd: m, payloadDay: m === null ? null : dayOf(m), nSmall: this._ids.size });
  }
  seed(payload) {
    this._setPayload(payload);
    if (this.state.payloadDay !== null) this.cache.set(this.cone, this.state.payloadDay, payload);
  }
  _cancel() {
    if (this._ctl) { this._ctl.abort(); this._ctl = null; }
    this._pending = null; this.state.fetchingDay = null; this.state.pendingDay = null;
  }
  abort() { this._cancel(); }
  _ingest(payload, day, fromCache) {
    const before = this._ids;
    this._setPayload(payload);
    const diff = populationDiff(before, this._ids);
    this.state.fail = null;
    this.state.notice = diff.changed ? { text: populationText(diff, day), until: this.now() + NOTICE_MS } : null;
    this.onIngest(payload, { day, fromCache, entered: diff.entered, left: diff.left });
  }
  onSettle(mjd) {
    const chk = checkRequery({ mjd, payloadMjd: this.state.payloadMjd });
    if (!chk.go) { this._cancel(); if (chk.why === 'same-day') this.state.fail = null; return chk; }
    const cached = this.cache.get(this.cone, chk.day);
    if (cached) { this._cancel(); this._ingest(cached, chk.day, true); return chk; }
    this._pending = chk.day; this.state.pendingDay = chk.day;       // the latest settle survives
    this.tick();
    return chk;
  }
  tick() {
    if (this._pending === null) return;
    const t = this.now();
    if (t - this._lastStart < REQUERY_CAP_MS) return;                // inside the cap: deferred to its end
    const day = this._pending;
    this._pending = null; this.state.pendingDay = null;
    this._start(day, t);
  }
  _start(day, t) {
    if (this._ctl) this._ctl.abort();                                // a newer request cancels the one in flight
    const ctl = this._ctl = new AbortController();
    this._lastStart = t; this.state.fetchingDay = day;
    Promise.resolve().then(() => this.fetchObjects({ ra: this.cone.ra, dec: this.cone.dec, radius: this.cone.radius, mjd: day }, ctl.signal)).then((payload) => {
      if (this._ctl !== ctl || ctl.signal.aborted) return;
      this._ctl = null; this.state.fetchingDay = null;
      const sb = skybotState(payload);
      if (!sb.ok) { this.state.fail = { kind: 'skybot', day, error: sb.error }; return; }   // keep the current payload: no body vanishes
      this.cache.set(this.cone, day, payload);
      this._ingest(payload, day, false);
    }, (err) => {
      if (this._ctl !== ctl || ctl.signal.aborted) return;
      this._ctl = null; this.state.fetchingDay = null;
      this.state.fail = { kind: 'network', day, error: err && err.message ? err.message : String(err) };
    });
  }
}
