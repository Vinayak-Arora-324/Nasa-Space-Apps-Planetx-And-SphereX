// The time bar of the 3D view (docs/object-framework.md section 20.3 and the decisions of 20.17): a row in the bottom dock, above the credits line.
//
// Controls: Now, slower, play / pause, faster, the rate, and the date readout, which is a button that opens a date field. Keys P (play / pause),
// , (slower), . (faster), N (now) and Shift+, (reverse). Below the controls one status line from the renderer (what moves and on what evidence, the
// star epoch notice, the range and re-query messages) and a small legend of the three orbit-line styles.
//
// Everything that can be decided without a DOM is exported and tested (timebar.test.mjs): layoutFor, readoutText, dateFields, jdFromFields, keyAction,
// limitMessage, starsNotice, statusSegments, LEGEND. The DOM class TimeBar only wires them to elements.
//
// EXPORTS (pure)
//   COMPACT_PX = 520                       the bar's width at or below which it folds (a phone)
//   layoutFor(widthPx) -> { compact, showTime, stepsInMenu }   compact: Now, play / pause, rate and date (no time); slower and faster go under a "⋯" button
//   readoutText(clockText, layout) -> '20 Nov 2026 14:00 UT' ('20 Nov 2026' when compact)
//   dateFields(clock) -> { date: 'YYYY-MM-DD', hour }   the date field's value: UT, as the readout shows it (Julian calendar before 1582 is not offered: the field is 1900-2100)
//   jdFromFields(date, hour) -> TT Julian Day | null   the inverse (UT -> TT with skytime.deltaT); null for an unreadable date
//   keyAction({ code, shiftKey, ctrlKey, altKey, metaKey, repeat, target }) -> 'toggle' | 'slower' | 'faster' | 'now' | 'reverse' | null   (ignored inside a text field)
//   limitMessage(clock) -> string                  'The 3D view covers 1900–2100' while the clock sits at an end of its range
//   starsNotice(clock, epoch = 2016) -> string     the Gaia epoch notice when the clock is more than a year from the stars' epoch (section 20.17 item 1)
//   statusSegments({ summary, clock, epoch, requery }) -> string[]   the status line's parts, in order: moving summary, stars notice, limit message, re-query messages
//   LEGEND                                         [{ style: 'solid' | 'dashed' | 'dotted', label, title }]
import { calendarFromJd, jdFromCalendar, deltaT, JD2000 } from './skytime.js';
import { clockText } from './skyclock.js';

export const COMPACT_PX = 520;
export function layoutFor(widthPx) {
  const compact = Number.isFinite(widthPx) && widthPx > 0 && widthPx <= COMPACT_PX;
  return { compact, showTime: !compact, stepsInMenu: compact };
}

export const readoutText = (ct, layout) => (layout && layout.showTime === false ? ct.date : `${ct.date} ${ct.time}`);

const decimalYear = (jd) => { const c = calendarFromJd(jd); return c.year + (c.month - 0.5) / 12; };
const pad = (n, w = 2) => String(n).padStart(w, '0');

export function dateFields(clock) {
  const jdUt = clock.jd - deltaT(decimalYear(clock.jd)) / 86400;
  const c = calendarFromJd(Math.round(jdUt * 1440) / 1440 + 1e-7);
  return { date: `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)}`, hour: c.hour };
}

export function jdFromFields(date, hour = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '').trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(hour);
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && Number.isFinite(h) && h >= 0 && h < 24)) return null;
  const jdUt = jdFromCalendar(y, mo, d + h / 24);
  return jdUt + deltaT(y + (mo - 0.5) / 12) / 86400;
}

const TEXT_TAGS = /^(INPUT|TEXTAREA|SELECT)$/;
export function keyAction(e) {
  if (!e || e.ctrlKey || e.altKey || e.metaKey) return null;
  const t = e.target;
  if (t && (t.isContentEditable || TEXT_TAGS.test(t.tagName || ''))) return null;
  switch (e.code) {
    case 'KeyP': return e.repeat ? null : 'toggle';
    case 'KeyN': return e.repeat ? null : 'now';
    case 'Comma': return e.shiftKey ? (e.repeat ? null : 'reverse') : 'slower';
    case 'Period': return 'faster';
    default: return null;
  }
}

export function limitMessage(clock) {
  if (!(clock.jd <= clock.minJd || clock.jd >= clock.maxJd)) return '';
  return `The 3D view covers ${calendarFromJd(clock.minJd).year}–${calendarFromJd(clock.maxJd).year}`;
}

export function starsNotice(clock, epoch = 2016) {
  const jd = JD2000 + (epoch - 2000) * 365.25;
  return Math.abs(clock.jd - jd) > 365.25 ? `Stars shown at their Gaia DR3 epoch (${Number(epoch).toFixed(1)}); proper motion not applied.` : '';
}

export function statusSegments({ summary = '', clock, epoch = 2016, requery = [] }) {
  return [summary, starsNotice(clock, epoch), limitMessage(clock), ...requery].filter(Boolean);
}

export const LEGEND = [
  { style: 'solid', label: 'measured', title: 'Solid line: a measured orbit' },
  { style: 'dashed', label: 'derived', title: 'Dashed line: an orbit derived from measurements' },
  { style: 'dotted', label: 'illustrative', title: 'Dotted line: an illustrative orbit (its orientation or phase is not known)' },
];

// ------------------------------------------------------------------------------------------------ DOM
function el(doc, tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

/**
 * new TimeBar({ root, clock, doc? }): fills root (an empty element) with the controls, the status line and the legend, and binds the keys.
 *   setStatus(lines)   the status line's text (an array of strings, joined with " · ")
 *   refresh()          re-reads the clock now (the bar also follows the clock's 'change' and 'rate' events by itself)
 *   dispose()
 */
export class TimeBar {
  constructor({ root, clock, doc = root.ownerDocument, onKeysHandled = () => {} }) {
    this.root = root; this.clock = clock; this.doc = doc; this.layout = layoutFor(0); this._dirty = true; this._raf = 0; this._lastPaint = -1e9; this._editing = false;
    root.classList.add('timebar'); root.setAttribute('role', 'group'); root.setAttribute('aria-label', 'Sky time');
    const b = (cls, label, text, key) => {
      const x = el(doc, 'button', `btn tb-btn ${cls}`, text); x.type = 'button'; x.setAttribute('aria-label', label); x.title = key ? `${label} (${key})` : label; return x;
    };
    this.nowBtn = b('tb-now', 'Jump to now', 'Now', 'N');
    this.slowerBtn = b('tb-step', 'Slower', '◀◀', ',');
    this.playBtn = b('tb-play', 'Play', '▶', 'P'); this.playBtn.setAttribute('aria-pressed', 'false');
    this.fasterBtn = b('tb-step', 'Faster', '▶▶', '.');
    this.rateEl = el(doc, 'span', 'tb-rate mono'); this.rateEl.setAttribute('aria-label', 'Rate');
    this.readoutBtn = b('tb-readout mono', 'Set the date and time', '', null); this.readoutBtn.setAttribute('aria-expanded', 'false'); this.readoutBtn.setAttribute('aria-haspopup', 'dialog');
    this.moreBtn = b('tb-more-btn', 'More time controls', '⋯', null); this.moreBtn.setAttribute('aria-expanded', 'false');
    this.row = el(doc, 'div', 'tb-row');
    this.menu = el(doc, 'div', 'tb-menu'); this.menu.hidden = true;
    this.edit = this._buildEdit();
    this.statusEl = el(doc, 'p', 'tb-status'); this.statusEl.hidden = true;
    this.legendEl = el(doc, 'p', 'tb-legend');
    this.legendEl.append('Orbit lines: ');
    LEGEND.forEach((l) => { const s = el(doc, 'span', 'tb-key'); s.title = l.title; s.append(el(doc, 'i', `tb-swatch ${l.style}`), l.label); this.legendEl.append(s); });
    root.append(this.row, this.menu, this.edit.form, this.statusEl, this.legendEl);
    this._place();

    this.nowBtn.addEventListener('click', () => { clock.jumpToNow(); this.refresh(); });
    this.slowerBtn.addEventListener('click', () => { clock.slower(); this.refresh(); });
    this.fasterBtn.addEventListener('click', () => { clock.faster(); this.refresh(); });
    this.playBtn.addEventListener('click', () => { clock.toggle(); this.refresh(); });
    this.moreBtn.addEventListener('click', () => this._setMenu(this.menu.hidden));
    this.readoutBtn.addEventListener('click', () => this._setEdit(!this._editing));
    this._off = [clock.on('change', () => { this._dirty = true; this._schedule(); }), clock.on('rate', () => this.refresh()), clock.on('limit', () => this.refresh())];
    this._onKey = (e) => {
      const a = keyAction(e);
      if (!a) return;
      if (a === 'toggle') clock.toggle(); else if (a === 'slower') clock.slower(); else if (a === 'faster') clock.faster(); else if (a === 'now') clock.jumpToNow(); else if (a === 'reverse') clock.reverse();
      this.refresh(); onKeysHandled(a);
    };
    window.addEventListener('keydown', this._onKey);
    this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._measure()) : null;
    if (this._ro) this._ro.observe(root);
    this._measure();
    this.refresh();
  }

  _buildEdit() {
    const doc = this.doc, form = el(doc, 'form', 'tb-edit'); form.hidden = true; form.setAttribute('role', 'dialog'); form.setAttribute('aria-label', 'Set the sky date');
    const date = el(doc, 'input', 'tb-date'); date.type = 'date'; date.min = '1900-01-01'; date.max = '2100-12-31'; date.setAttribute('aria-label', 'Date (UT)');
    const hour = el(doc, 'input', 'tb-hour mono'); hour.type = 'number'; hour.min = '0'; hour.max = '23'; hour.step = '1'; hour.setAttribute('aria-label', 'Hour (UT)');
    const go = el(doc, 'button', 'btn tb-btn', 'Go'); go.type = 'submit';
    const close = el(doc, 'button', 'btn quiet tb-btn', 'Close'); close.type = 'button';
    const lab = (t, input) => { const l = el(doc, 'label', 'tb-field', t); l.append(input); return l; };
    form.append(lab('Date', date), lab('Hour (UT)', hour), go, close);
    const apply = () => { const jd = jdFromFields(date.value, hour.value === '' ? 0 : hour.value); if (jd !== null) { this.clock.setJd(jd, { source: 'user' }); this.refresh(); } };
    form.addEventListener('submit', (e) => { e.preventDefault(); apply(); this._setEdit(false); });
    date.addEventListener('change', apply); hour.addEventListener('change', apply);
    close.addEventListener('click', () => this._setEdit(false));
    // keys typed in the field are the field's: they must not fly the camera (the page listens on window) or toggle the clock
    form.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); this._setEdit(false); } });
    return { form, date, hour };
  }

  _setEdit(open) {
    if (open === this._editing) return;
    this._editing = open;
    if (open) {
      const f = dateFields(this.clock);
      this.edit.date.value = f.date; this.edit.hour.value = String(f.hour);
      this.edit.form.hidden = false; this.clock.hold(true); this._setMenu(false);
      try { this.edit.date.focus({ preventScroll: true }); } catch (_) { /* detached */ }
    } else {
      this.edit.form.hidden = true; this.clock.hold(false);
      try { this.readoutBtn.focus({ preventScroll: true }); } catch (_) { /* detached */ }
    }
    this.readoutBtn.setAttribute('aria-expanded', String(open));
    this.refresh();
  }
  _setMenu(open) { this.menu.hidden = !open || !this.layout.stepsInMenu; this.moreBtn.setAttribute('aria-expanded', String(!this.menu.hidden)); }

  /** Controls go where the layout wants them: inline, or the steps under the "more" button. */
  _place() {
    const L = this.layout, r = this.row;
    r.textContent = ''; this.menu.textContent = '';
    if (L.compact) { r.append(this.nowBtn, this.playBtn, this.rateEl, this.readoutBtn, this.moreBtn); this.menu.append(this.slowerBtn, this.fasterBtn); }
    else r.append(this.nowBtn, this.slowerBtn, this.playBtn, this.fasterBtn, this.rateEl, this.readoutBtn);
    this.root.dataset.compact = L.compact ? '1' : '0';
    this._setMenu(false);
  }
  _measure() {
    const w = this.root.parentElement ? this.root.parentElement.clientWidth : this.root.clientWidth, next = layoutFor(w || (typeof window !== 'undefined' ? window.innerWidth : 0));
    if (next.compact !== this.layout.compact) { this.layout = next; this._place(); this._dirty = true; this.refresh(); }
  }

  setStatus(lines) {
    const text = (lines || []).filter(Boolean).join(' · ');
    if (text === this._statusText) return;
    this._statusText = text; this.statusEl.textContent = text; this.statusEl.hidden = !text;
  }

  _schedule() {
    if (this._raf || typeof requestAnimationFrame !== 'function') return;
    this._raf = requestAnimationFrame((t) => { this._raf = 0; if (t - this._lastPaint >= 90) this.refresh(t); else this._schedule(); });
  }
  refresh(t) {
    this._lastPaint = typeof t === 'number' ? t : (typeof performance !== 'undefined' ? performance.now() : 0); this._dirty = false;
    const ct = clockText(this.clock), c = this.clock;
    this.readoutBtn.textContent = readoutText(ct, this.layout);
    this.rateEl.textContent = ct.rate;
    this.playBtn.textContent = c.playing ? '❚❚' : '▶';
    this.playBtn.setAttribute('aria-pressed', String(!!c.playing));
    this.playBtn.title = `${c.playing ? 'Pause' : 'Play'} (P)`;
    this.root.classList.toggle('playing', !!c.playing);
  }
  dispose() {
    window.removeEventListener('keydown', this._onKey);
    this._off.forEach((f) => f());
    if (this._ro) this._ro.disconnect();
    if (this._raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf);
    if (this._editing) this.clock.hold(false);
  }
}
