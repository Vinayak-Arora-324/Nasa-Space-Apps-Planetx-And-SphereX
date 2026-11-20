// The re-query policy of the 3D view (docs/object-framework.md section 20.6 and the conditions of 20.17 item 3): when to ask, the LRU, the 5 s cap with
// deferral, cancelling, SkyBoT failures, the population announcement and the status texts. No DOM, no network: a fake fetch and a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUERY_CAP_MS, CACHE_SIZE, NOTICE_MS, dayOf, checkRequery, skybotRangeText, coneKey, fmtDay, PayloadCache, smallBodyIds, populationDiff, populationText,
  skybotState, requeryStatus, Requerier } from '../js/blink/scene3d-requery.js';
import { SKYBOT_JD_RANGE } from '../js/blink/skyclock.js';
import { jdFromCalendar } from '../js/blink/skytime.js';

const MJD0 = 2400000.5;
const mjdOfJd = (jd) => jd - MJD0;
const mjd2065 = jdFromCalendar(2065, 6, 1) - MJD0;       // inside the view range (1900-2100), beyond SkyBoT (served to 2060-03)
const cone = { ra: 346.626, dec: -5.043, radius: 3 };
const payload = (mjd, ids = [], { skybot = 'ok' } = {}) => ({
  schema: 'space-maps.objects/1', query: { ra: cone.ra, dec: cone.dec, radius: cone.radius, mjd },
  objects: [{ id: 'ss:mars', kind: 'planet' }, ...ids.map((id) => ({ id, kind: id.startsWith('c:') ? 'comet' : 'asteroid' }))],
  kinds: {}, sources: [{ id: 'ephem', status: 'ok' }, skybot === 'ok' ? { id: 'skybot', status: 'ok' } : { id: 'skybot', status: 'error', error: 'timeout' }],
});
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('checkRequery: only a different whole day, inside SkyBoT and the view range', () => {
  assert.equal(dayOf(61364.54), 61365);
  const base = 61364.5417;                                              // the payload's epoch: today rounded to the hour
  assert.equal(checkRequery({ mjd: base + 0.3, payloadMjd: base }).why, 'same-day');   // 7 h later: still the same nearest day
  assert.equal(checkRequery({ mjd: base - 0.04, payloadMjd: base }).go, false);
  const c = checkRequery({ mjd: base + 1, payloadMjd: base });
  assert.deepEqual([c.go, c.why, c.day, c.payloadDay], [true, null, 61366, 61365]);
  assert.equal(checkRequery({ mjd: 61000, payloadMjd: null }).why, 'no-payload');       // nothing drawn yet: not the re-query's business
  // 2065 is beyond SkyBoT (served up to 2060-03); 1880 too (served from 1890-02); both are inside the view range
  assert.equal(checkRequery({ mjd: mjd2065, payloadMjd: base }).why, 'outside-skybot');
  assert.equal(checkRequery({ mjd: mjdOfJd(jdFromCalendar(1895, 6, 1)), payloadMjd: base }).why, 'outside-view');   // SkyBoT serves from 1890, the view from 1900
  // the edges of SkyBoT's range itself
  assert.equal(checkRequery({ mjd: Math.floor(mjdOfJd(SKYBOT_JD_RANGE.hi)) - 1, payloadMjd: base }).go, true);
  assert.equal(checkRequery({ mjd: mjdOfJd(SKYBOT_JD_RANGE.hi) + 30, payloadMjd: base }).why, 'outside-skybot');
  assert.equal(checkRequery({ mjd: mjdOfJd(2415020.5) - 10, payloadMjd: base }).why, 'outside-view');   // before 1900
  assert.equal(skybotRangeText(), '1890–2060');
});

test('coneKey and fmtDay', () => {
  assert.equal(coneKey(cone), '346.62600|-5.04300|3');
  assert.equal(fmtDay(61365), '21 Nov 2026');            // JD 2461365.5 is 0 h TT on 21 Nov 2026
});

test('PayloadCache: an LRU of 8 by (cone, day); a read refreshes an entry', () => {
  const c = new PayloadCache();
  assert.equal(CACHE_SIZE, 8);
  for (let d = 0; d < 8; d++) c.set(cone, 60000 + d, { d });
  assert.equal(c.size, 8);
  assert.equal(c.get(cone, 60000).d, 0);                  // 60000 is now the most recent
  c.set(cone, 60008, { d: 8 });                           // evicts the least recent: 60001
  assert.equal(c.size, 8);
  assert.ok(c.has(cone, 60000) && !c.has(cone, 60001) && c.has(cone, 60008));
  assert.equal(c.get(cone, 60001), null);
  assert.equal(c.get({ ...cone, ra: 1 }, 60000), null, 'another cone is another key');
});

test('population: ids of the small bodies, the diff and the announcement text', () => {
  const a = smallBodyIds(payload(1, ['a:1', 'a:2', 'c:1'])), b = smallBodyIds(payload(2, ['a:2', 'a:3', 'a:4', 'c:1']));
  assert.deepEqual([...a].sort(), ['a:1', 'a:2', 'c:1']);
  const d = populationDiff(a, b);
  assert.deepEqual([d.entered, d.left, d.changed], [2, 1, true]);
  assert.equal(populationText(d, 61365), '2 small bodies entered the cone and 1 left on 21 Nov 2026');
  assert.equal(populationText({ entered: 1, left: 0, changed: true }, 61365), '1 small body entered the cone on 21 Nov 2026');
  assert.equal(populationText({ entered: 0, left: 31, changed: true }, 61365), '31 small bodies left the cone on 21 Nov 2026');
  assert.equal(populationText(populationDiff(a, a), 61365), '');
  const big = populationDiff(new Set(), new Set(Array.from({ length: 27 }, (_, i) => 'x' + i)));
  assert.match(populationText({ ...big, left: 31 }, 61365), /^27 small bodies entered the cone and 31 left on /);
});

test('skybotState: the skybot row of sources decides; without it the small kinds do', () => {
  assert.equal(skybotState(payload(1)).ok, true);
  assert.deepEqual(skybotState(payload(1, [], { skybot: 'error' })), { ok: false, error: 'timeout' });
  assert.equal(skybotState({ sources: [], kinds: { asteroid: { status: 'error', error: 'x' } } }).ok, false);
  assert.equal(skybotState({ sources: [], kinds: { asteroid: { status: 'ok' } } }).ok, true);
});

// ---------------------------------------------------------------------------------------------- Requerier
function rig(opts = {}) {
  const calls = [], ingested = [];
  let t = 1000;
  const r = new Requerier({
    cone, now: () => t, onIngest: (p, info) => ingested.push({ mjd: p.query.mjd, ...info }),
    fetchObjects: (params, signal) => new Promise((res, rej) => {
      const call = { params, signal, res, rej }; calls.push(call);
      signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
    ...opts,
  });
  return { r, calls, ingested, at: (ms) => { t = ms; }, now: () => t };
}

test('Requerier: a settle on another day fetches that day once; the payload is cached and ingested with the population change', async () => {
  const { r, calls, ingested, at } = rig();
  r.seed(payload(61364.5417, ['a:1', 'a:2']));
  assert.equal(r.onSettle(61364.6).go, false); await flush(); assert.equal(calls.length, 0);   // the same day
  r.onSettle(61369.2); await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, { ra: cone.ra, dec: cone.dec, radius: cone.radius, mjd: 61369 });
  assert.equal(r.state.fetchingDay, 61369);
  assert.deepEqual(requeryStatus({ state: r.state, mjd: 61369.2, now: 1000 }), ['Fetching the small bodies for 25 Nov 2026…']);
  at(1500); calls[0].res(payload(61369, ['a:2', 'a:3', 'a:4'])); await flush();
  assert.equal(ingested.length, 1);
  assert.deepEqual([ingested[0].mjd, ingested[0].fromCache, ingested[0].entered, ingested[0].left], [61369, false, 2, 1]);
  assert.equal(r.state.fetchingDay, null); assert.equal(r.state.payloadDay, 61369); assert.equal(r.state.fail, null);
  assert.equal(r.state.notice.text, '2 small bodies entered the cone and 1 left on 25 Nov 2026');
  assert.deepEqual(requeryStatus({ state: r.state, mjd: 61369.2, now: 1500 }), ['2 small bodies entered the cone and 1 left on 25 Nov 2026']);
  assert.deepEqual(requeryStatus({ state: r.state, mjd: 61369.2, now: 1500 + NOTICE_MS + 1 }), [], 'the announcement lasts about 5 s');
});

test('Requerier: scrubbing back re-ingests the cached payload without a request', async () => {
  const { r, calls, ingested, at } = rig();
  r.seed(payload(61364.5417, ['a:1']));
  r.onSettle(61369); await flush(); calls[0].res(payload(61369, ['a:2'])); await flush();
  at(20000);
  r.onSettle(61365); await flush();                       // back to the seeded day
  assert.equal(calls.length, 1, 'no second request');
  assert.equal(ingested.length, 2);
  assert.deepEqual([ingested[1].mjd, ingested[1].fromCache], [61364.5417, true]);
  assert.equal(r.state.payloadDay, 61365);
});

test('Requerier: at most one start per 5 s; a settle inside the cap is deferred to its end and only the latest survives', async () => {
  const { r, calls, at } = rig();
  r.seed(payload(61364.5417));
  at(10000); r.onSettle(61400); await flush(); assert.equal(calls.length, 1);
  at(11000); r.onSettle(61410); await flush(); r.tick(); await flush(); assert.equal(calls.length, 1, 'inside the cap: deferred');
  assert.equal(r.state.pendingDay, 61410);
  at(12000); r.onSettle(61420); await flush(); r.tick(); await flush(); assert.equal(calls.length, 1);
  assert.equal(r.state.pendingDay, 61420, 'the latest settle replaces the earlier one');
  assert.deepEqual(requeryStatus({ state: r.state, mjd: 61420, now: 12000 }), [`Fetching the small bodies for ${fmtDay(61420)}…`]);
  at(10000 + REQUERY_CAP_MS - 1); r.tick(); await flush(); assert.equal(calls.length, 1);
  at(10000 + REQUERY_CAP_MS); r.tick(); await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.mjd, 61420, 'only the latest survived');
  assert.equal(calls[0].signal.aborted, true, 'the newer request cancelled the one in flight');
  assert.equal(r.state.pendingDay, null);
});

test('Requerier: outside SkyBoT nothing is fetched, the status says why and the payload stays', async () => {
  const { r, calls, ingested } = rig();
  r.seed(payload(61364.5417, ['a:1']));
  const c = r.onSettle(mjd2065); await flush();
  assert.equal(c.why, 'outside-skybot');
  assert.equal(calls.length, 0); assert.equal(ingested.length, 0);
  assert.deepEqual(requeryStatus({ state: r.state, mjd: mjd2065, now: 0 }),
    ['SkyBoT serves 1890–2060; small bodies are the ones from 20 Nov 2026, moved along their orbits']);
});

test('Requerier: SkyBoT failing (source row or request) keeps the payload and the status says so', async () => {
  const { r, calls, ingested, at } = rig();
  r.seed(payload(61364.5417, ['a:1']));
  r.onSettle(61400); await flush();
  calls[0].res(payload(61400, [], { skybot: 'error' })); await flush();       // SkyBoT's row is not ok: its (empty) result is not ingested
  assert.equal(ingested.length, 0); assert.equal(r.state.payloadDay, 61365); assert.equal(r.state.nSmall, 1);
  assert.equal(r.state.fail.kind, 'skybot');
  assert.deepEqual(requeryStatus({ state: r.state, mjd: 61400, now: 0 }), ['SkyBoT did not answer; small bodies are the ones from 20 Nov 2026, moved along their orbits']);
  assert.equal(r.cache.has(cone, 61400), false, 'a failed payload is not cached');
  at(20000);
  r.onSettle(61401); await flush(); calls[1].rej(new Error('network down')); await flush();   // the request itself fails
  assert.equal(ingested.length, 0); assert.equal(r.state.fail.kind, 'network');
  at(40000);
  r.onSettle(61402); await flush(); calls[2].res(payload(61402, ['a:1', 'a:9'])); await flush();   // a later success clears it
  assert.equal(ingested.length, 1); assert.equal(r.state.fail, null);
});

test('Requerier: coming back to the payload day cancels what is in flight', async () => {
  const { r, calls, ingested } = rig();
  r.seed(payload(61364.5417));
  r.onSettle(61400); await flush();
  assert.equal(r.onSettle(61364.8).why, 'same-day');
  assert.equal(calls[0].signal.aborted, true); assert.equal(r.state.fetchingDay, null);
  await flush(); assert.equal(ingested.length, 0);
});

test('requeryStatus: while playing far from the payload the status says which small bodies are drawn and how to fetch', () => {
  const state = { payloadMjd: 61364.5417, payloadDay: 61365, nSmall: 214, fetchingDay: null, pendingDay: null, fail: null, notice: null };
  assert.deepEqual(requeryStatus({ state, mjd: 61700.3, playing: true, rate: 30, now: 0 }),
    ['Small bodies: the 214 in the cone on 20 Nov 2026, moved along their orbits; pause to fetch the ones there on 22 Oct 2027']);
  assert.deepEqual(requeryStatus({ state, mjd: 61700.3, playing: false, now: 0 }), []);
  assert.deepEqual(requeryStatus({ state, mjd: 61365.1, playing: true, rate: 1, now: 0 }), []);
});
