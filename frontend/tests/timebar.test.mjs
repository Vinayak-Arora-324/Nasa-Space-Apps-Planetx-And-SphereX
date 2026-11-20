// The time bar's pure helpers (js/blink/timebar.js): layout decisions, readout text, the date field's conversion, key bindings, the status line's parts.
// The DOM class is exercised in the browser; nothing here needs a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPACT_PX, layoutFor, readoutText, dateFields, jdFromFields, keyAction, limitMessage, starsNotice, statusSegments, LEGEND } from '../js/blink/timebar.js';
import { SkyClock, clockText } from '../js/blink/skyclock.js';
import { VIEW_JD_RANGE } from '../js/blink/scene3d-motion.js';
import { jdFromCalendar, deltaT } from '../js/blink/skytime.js';

const clockAt = (jd, extra = {}) => Object.assign(new SkyClock({ jd, minJd: VIEW_JD_RANGE.min, maxJd: VIEW_JD_RANGE.max }), extra);
const key = (code, extra = {}) => ({ code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, target: { tagName: 'CANVAS' }, ...extra });

test('layoutFor: a phone folds to Now, play, rate and date; slower and faster go under a menu', () => {
  for (const w of [320, 375, 414, COMPACT_PX]) assert.deepEqual(layoutFor(w), { compact: true, showTime: false, stepsInMenu: true }, `${w}`);
  for (const w of [COMPACT_PX + 1, 768, 1280]) assert.deepEqual(layoutFor(w), { compact: false, showTime: true, stepsInMenu: false }, `${w}`);
  assert.equal(layoutFor(0).compact, false, 'an unmeasured bar is not folded');
  assert.equal(layoutFor(NaN).compact, false);
});

test('readoutText: date and time, the date alone when folded', () => {
  const c = clockAt(jdFromCalendar(2026, 11, 20.5833)), ct = clockText(c);
  assert.match(readoutText(ct, layoutFor(1280)), /^20 Nov 2026 \d\d:\d\d UT$/);
  assert.equal(readoutText(ct, layoutFor(375)), '20 Nov 2026');
});

test('dateFields and jdFromFields invert each other (UT in the field, TT in the clock)', () => {
  for (const [y, m, d, h] of [[2026, 11, 20, 13], [1900, 1, 1, 0], [2099, 12, 31, 23], [1969, 7, 20, 20]]) {
    const jd = jdFromFields(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, h);
    assert.ok(Number.isFinite(jd));
    const f = dateFields(clockAt(jd, {}));
    assert.deepEqual([f.date, f.hour], [`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, h], `${y}-${m}-${d} ${h}h`);
  }
  // TT is ahead of UT by delta T (skytime.deltaT at the date's decimal year)
  const jd = jdFromFields('2026-11-20', 12), ut = jdFromCalendar(2026, 11, 20.5);
  assert.ok(Math.abs((jd - ut) * 86400 - deltaT(2026 + 10.5 / 12)) < 1e-3, `delta T ${(jd - ut) * 86400}`);
  assert.equal(jdFromFields('', 0), null); assert.equal(jdFromFields('2026-13-01', 0), null); assert.equal(jdFromFields('2026-11-20', 24), null); assert.equal(jdFromFields('abc', 0), null);
  assert.ok(jdFromFields('2026-11-20') !== null, 'no hour means 0 h');
});

test('keyAction: P, comma, period, N and Shift+comma; nothing inside a text field or with a modifier', () => {
  assert.equal(keyAction(key('KeyP')), 'toggle');
  assert.equal(keyAction(key('Comma')), 'slower');
  assert.equal(keyAction(key('Period')), 'faster');
  assert.equal(keyAction(key('KeyN')), 'now');
  assert.equal(keyAction(key('Comma', { shiftKey: true })), 'reverse');
  assert.equal(keyAction(key('KeyP', { repeat: true })), null, 'a held P does not flicker the clock');
  assert.equal(keyAction(key('Period', { repeat: true })), 'faster');
  assert.equal(keyAction(key('KeyP', { ctrlKey: true })), null);
  assert.equal(keyAction(key('KeyN', { metaKey: true })), null);
  assert.equal(keyAction(key('KeyP', { target: { tagName: 'INPUT' } })), null);
  assert.equal(keyAction(key('KeyN', { target: { tagName: 'SELECT' } })), null);
  assert.equal(keyAction(key('KeyP', { target: { tagName: 'DIV', isContentEditable: true } })), null);
  for (const code of ['KeyW', 'KeyL', 'KeyI', 'KeyE', 'KeyG', 'KeyT', 'KeyH', 'Tab', 'Space', 'BracketLeft']) assert.equal(keyAction(key(code)), null, `${code} stays the page's`);
});

test('limitMessage: said while the clock sits at an end of its range', () => {
  assert.equal(limitMessage(clockAt(jdFromCalendar(2026, 11, 20))), '');
  assert.equal(limitMessage(clockAt(VIEW_JD_RANGE.max)), 'The 3D view covers 1900–2100');
  assert.equal(limitMessage(clockAt(VIEW_JD_RANGE.min)), 'The 3D view covers 1900–2100');
  const c = clockAt(VIEW_JD_RANGE.max - 1); c.setJd(VIEW_JD_RANGE.max + 50);          // clamped to the end
  assert.equal(limitMessage(c), 'The 3D view covers 1900–2100');
});

test('starsNotice: more than a year from the stars\' epoch (section 20.17 item 1)', () => {
  const text = 'Stars shown at their Gaia DR3 epoch (2016.0); proper motion not applied.';
  assert.equal(starsNotice(clockAt(jdFromCalendar(2026, 11, 20))), text);
  assert.equal(starsNotice(clockAt(jdFromCalendar(1900, 1, 1))), text);
  assert.equal(starsNotice(clockAt(jdFromCalendar(2016, 6, 1))), '', 'within a year of 2016.0');
  assert.equal(starsNotice(clockAt(jdFromCalendar(2016, 12, 1))), '');
  assert.equal(starsNotice(clockAt(jdFromCalendar(2017, 3, 1))), text);
  assert.equal(starsNotice(clockAt(jdFromCalendar(2026, 11, 20)), 2015.5), text.replace('2016.0', '2015.5'));
});

test('statusSegments: the moving summary, the stars notice, the limit message and the re-query lines, in that order, empties dropped', () => {
  const c = clockAt(jdFromCalendar(2026, 11, 20));
  assert.deepEqual(statusSegments({ summary: 'Moving: 8 planets and the Moon (ephemeris)', clock: c, requery: ['Fetching the small bodies for 25 Nov 2026…'] }), [
    'Moving: 8 planets and the Moon (ephemeris)', 'Stars shown at their Gaia DR3 epoch (2016.0); proper motion not applied.', 'Fetching the small bodies for 25 Nov 2026…']);
  assert.deepEqual(statusSegments({ clock: clockAt(jdFromCalendar(2016, 3, 1)) }), []);
  const end = statusSegments({ summary: '', clock: clockAt(VIEW_JD_RANGE.max), requery: [] });
  assert.equal(end[end.length - 1], 'The 3D view covers 1900–2100');
});

test('LEGEND: the three line styles, solid for measured, dashed for derived, dotted for illustrative', () => {
  assert.deepEqual(LEGEND.map((l) => [l.style, l.label]), [['solid', 'measured'], ['dashed', 'derived'], ['dotted', 'illustrative']]);
  for (const l of LEGEND) assert.ok(l.title.length > 10);
});
