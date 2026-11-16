// Time slider for the patch player: the exposures laid out on a broken time axis, one segment per visit.
// Inside a visit, frames sit where they were taken (hours to days apart); the months between visits are cut
// down to a fixed labelled gap, so every visit stays readable. Pure layout and formatting helpers are exported
// for tests; TimeSlider is the DOM control.
import { clamp, el } from './util.js';
import { mjdToDate } from '../wcs.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------------------------
const pad2 = (v) => String(v).padStart(2, '0');
/** "5 May 2025 · 03:12 UTC" */
export function fmtTaken(mjd) {
  const d = new Date(Math.round(mjdToDate(mjd).getTime() / 60000) * 60000);   // nearest minute
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}
/** "May 2025" */
export const fmtMonth = (mjd) => { const d = mjdToDate(mjd); return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
/** A visit's dates: "12–15 May 2025", "28 May – 2 Jun 2025", "May 2025 – Jan 2026". */
export function fmtVisit(mjd0, mjd1) {
  const a = mjdToDate(mjd0), b = mjdToDate(mjd1);
  const ay = a.getUTCFullYear(), by = b.getUTCFullYear(), am = a.getUTCMonth(), bm = b.getUTCMonth();
  if (mjd1 - mjd0 > 45) return ay === by ? `${MON[am]} – ${MON[bm]} ${by}` : `${MON[am]} ${ay} – ${MON[bm]} ${by}`;
  if (ay === by && am === bm) {
    return a.getUTCDate() === b.getUTCDate() ? `${a.getUTCDate()} ${MON[am]} ${ay}` : `${a.getUTCDate()}–${b.getUTCDate()} ${MON[am]} ${ay}`;
  }
  return `${a.getUTCDate()} ${MON[am]}${ay === by ? '' : ` ${ay}`} – ${b.getUTCDate()} ${MON[bm]} ${by}`;
}
/** A length of time, short: "40 min", "5.2 h", "3.4 d", "6 mo", "1 yr 2 mo". */
export function fmtSpan(days) {
  const d = Math.abs(days);
  if (d < 1 / 24) return `${Math.max(1, Math.round(d * 1440))} min`;
  if (d < 1) return `${(d * 24).toFixed(1)} h`;
  if (d < 45) return `${d < 10 ? d.toFixed(1) : Math.round(d)} d`;
  const mo = Math.round(d / 30.4375);
  if (mo < 12) return `${mo} mo`;
  const y = Math.floor(mo / 12), m = mo % 12;
  return m ? `${y} yr ${m} mo` : `${y} yr`;
}
/** How long before `nowMs` the frame was taken: "3 d ago", "1 yr 2 mo ago". */
export const fmtAgo = (mjd, nowMs = Date.now()) => {
  const days = (nowMs - mjdToDate(mjd).getTime()) / DAY_MS;
  return days < 0 ? 'just now' : `${fmtSpan(days)} ago`;
};

// ---------------------------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------------------------
/**
 * frames: [{mjd, visit}] sorted by time, `visit` numbered 0.. in order.
 * Returns {segs, xs, gaps}, all positions as fractions 0..1 of the track:
 *   segs: [{visit, i0, i1, x0, x1, mjd0, mjd1}]: a visit's frames i0..i1 occupy x0..x1
 *   xs:   per-frame position
 *   gaps: [{x, days}]: centre of each cut between visits and the time it stands for
 * gapFrac is the width of one cut. Segments share the rest in proportion to their frame counts (at least
 * minWeight frames' worth, so a one-frame visit still has room for its label).
 */
export function layoutTimeline(frames, { gapFrac = 0.05, minWeight = 3 } = {}) {
  const n = frames.length, segs = [], xs = new Array(n).fill(0.5), gaps = [];
  if (!n) return { segs, xs, gaps };
  for (let i = 0; i < n; i++) {
    const s = segs[segs.length - 1];
    if (s && frames[i].visit === s.visit) { s.i1 = i; s.mjd1 = frames[i].mjd; } else segs.push({ visit: frames[i].visit, i0: i, i1: i, mjd0: frames[i].mjd, mjd1: frames[i].mjd });
  }
  const g = segs.length > 1 ? Math.min(gapFrac, 0.35 / (segs.length - 1)) : 0;
  const weights = segs.map((s) => Math.max(minWeight, s.i1 - s.i0 + 1));
  const total = weights.reduce((a, b) => a + b, 0), room = 1 - g * (segs.length - 1);
  let x = 0;
  segs.forEach((s, k) => {
    s.x0 = x; s.x1 = x + room * weights[k] / total; x = s.x1 + g;
    const cnt = s.i1 - s.i0 + 1, inset = (s.x1 - s.x0) / (2 * Math.max(cnt, minWeight));  // half a frame's slot
    const a = s.x0 + inset, b = s.x1 - inset, span = s.mjd1 - s.mjd0;
    for (let i = s.i0; i <= s.i1; i++) {
      xs[i] = cnt === 1 ? (s.x0 + s.x1) / 2 : span > 0 ? a + (b - a) * (frames[i].mjd - s.mjd0) / span : a + (b - a) * (i - s.i0) / (cnt - 1);
    }
    if (k) gaps.push({ x: s.x0 - g / 2, days: s.mjd0 - segs[k - 1].mjd1 });
  });
  segs[segs.length - 1].x1 = 1;
  return { segs, xs, gaps };
}
/** Fractional play position (0..n-1) to track position, piecewise linear between frames. */
export function posToX(xs, pos) {
  const n = xs.length; if (!n) return 0;
  const p = clamp(pos, 0, n - 1), a = Math.floor(p), b = Math.min(n - 1, a + 1);
  return xs[a] + (xs[b] - xs[a]) * (p - a);
}
/** Track position to fractional play position: the inverse of posToX (xs is non-decreasing). */
export function xToPos(xs, x) {
  const n = xs.length; if (n < 2) return 0;
  if (x <= xs[0]) return 0;
  if (x >= xs[n - 1]) return n - 1;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  const w = xs[hi] - xs[lo];
  return w > 0 ? lo + (x - xs[lo]) / w : lo;
}
/** Nearest frame to track position x (ties go to the later frame). */
export function nearestFrame(xs, x) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < xs.length; i++) { const d = Math.abs(xs[i] - x); if (d <= bd) { bd = d; best = i; } }
  return best;
}
/**
 * Labels that fit: [{x, w, ...}] in priority order, x the left edge (px). Keeps a label only when it does not
 * overlap one already kept (with `sep` px between), and clamps each inside 0..width.
 */
export function fitLabels(items, width, sep = 8) {
  const kept = [];
  for (const it of items) {
    const x = clamp(it.x, 0, Math.max(0, width - it.w));
    if (kept.some((k) => x < k.x + k.w + sep && x + it.w + sep > k.x)) continue;
    kept.push({ ...it, x });
  }
  return kept.sort((a, b) => a.x - b.x);
}

// ---------------------------------------------------------------------------------------------
// DOM control
// ---------------------------------------------------------------------------------------------
const CH_PX = 6.7;          // average width of one 11px mono character
const GAP_PX = 58, GAP_MIN_PX = 34;   // a cut between visits: 58 px, or 14% of a narrow track
const textW = (s) => Math.ceil(s.length * CH_PX) + 2;

export class TimeSlider {
  /**
   * host: element to build into.
   * cb: {seek(pos, {snap}), pause(), pos() -> current play position, focusVisit(visit|null),
   *      frames() -> [{mjd, visit}], focused() -> visit|null}
   */
  constructor(host, cb) {
    this.cb = cb; this.layout = layoutTimeline([]); this.n = 0; this.lastX = -1; this.cur = -1; this.drag = null;
    this.track = el('div', { class: 'tl-track', role: 'slider', tabindex: '0', 'aria-label': 'Time: which exposure is shown', 'aria-valuemin': '1', 'aria-valuemax': '1', 'aria-valuenow': '1' });
    this.segLayer = el('div', { class: 'tl-segs', 'aria-hidden': 'true' });
    this.gapLayer = el('div', { class: 'tl-gaps', 'aria-hidden': 'true' });
    this.tickLayer = el('div', { class: 'tl-ticks', 'aria-hidden': 'true' });
    this.handle = el('div', { class: 'tl-handle', 'aria-hidden': 'true' });
    this.tip = el('div', { class: 'tl-tip mono', 'aria-hidden': 'true', hidden: true });
    this.track.append(this.segLayer, this.gapLayer, this.tickLayer, this.handle);
    this.labels = el('div', { class: 'tl-labels' });
    host.replaceChildren(el('div', { class: 'tl-wrap' }, this.track, this.tip), this.labels);
    this._bind();
    this.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.build(true)) : null;
    if (this.ro) this.ro.observe(this.track);
  }

  /** Lay the frames out again (frames arrived, the window changed size, or focus changed). */
  build(keepKey) {
    const F = this.cb.frames(), W = this.track.clientWidth || 600;
    this.n = F.length;
    this.layout = layoutTimeline(F, { gapFrac: clamp(W * 0.14, GAP_MIN_PX, GAP_PX) / W });
    const { segs, xs, gaps } = this.layout, foc = this.cb.focused();
    const pct = (v) => `${(v * 100).toFixed(3)}%`;
    this.segLayer.replaceChildren(...segs.map((s) => el('span', {
      class: `tl-seg${foc !== null && foc !== s.visit ? ' dimmed' : ''}`, style: `left:${pct(s.x0)};width:${pct(s.x1 - s.x0)}`,
    })));
    // each cut between visits says how much time it leaves out
    const gapW = segs.length > 1 ? (segs[1].x0 - segs[0].x1) * W : 0;
    this.gapLayer.replaceChildren(...gaps.map((g) => {
      const text = [`+${fmtSpan(g.days)}`, `+${fmtSpan(g.days).replace(/ /g, '')}`].find((t) => textW(t) + 4 <= gapW) || '';
      return el('span', { class: 'tl-cut mono', style: `left:${pct(g.x)}`, title: `${fmtSpan(g.days)} between visits` }, text);
    }));
    this.tickLayer.replaceChildren(...xs.map((x, i) => el('span', { class: 'tl-tick', 'data-i': String(i), style: `left:${pct(x)}` })));
    this.track.setAttribute('aria-valuemax', String(Math.max(1, this.n)));
    this._buildLabels(F, W);
    this.cur = -1; this.lastX = -1;
    if (!keepKey) this.tip.hidden = true;
  }
  _buildLabels(F, W) {
    const { segs } = this.layout, foc = this.cb.focused(), multi = segs.length > 1;
    const items = [];
    // visit labels first (highest priority), then month marks inside long visits. Visits use the most
    // detailed label style that fits every one of them, so the row reads evenly.
    const styles = multi
      ? [(s, d) => `Visit ${s.visit + 1} · ${d}`, (s, d) => d, (s) => fmtMonth(s.mjd0), (s) => `V${s.visit + 1}`]
      : [(s, d) => d, (s) => fmtMonth(s.mjd0)];
    const style = styles.find((fn) => segs.every((s) => textW(fn(s, fmtVisit(s.mjd0, s.mjd1))) + (multi ? 6 : 0) <= Math.max((s.x1 - s.x0) * W, 26))) || styles[styles.length - 1];
    segs.forEach((s) => {
      const dates = fmtVisit(s.mjd0, s.mjd1), text = style(s, dates);
      items.push({ kind: 'visit', s, text, full: `Visit ${s.visit + 1} of ${segs.length}, ${dates}, ${s.i1 - s.i0 + 1} exposure${s.i1 === s.i0 ? '' : 's'}`, x: s.x0 * W, w: textW(text) + (multi ? 6 : 0) });
    });
    segs.forEach((s) => {
      if (s.mjd1 - s.mjd0 < 60) return;
      const d = mjdToDate(s.mjd0);
      for (let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1; ; m++) {
        const t = Date.UTC(y, m, 1) / DAY_MS + 40587; if (t >= s.mjd1) break;
        const p = s.i0 + xToMjdPos(F, s, t);
        const text = fmtMonth(t);
        items.push({ kind: 'month', text, x: posToX(this.layout.xs, p) * W - 3, w: textW(text) });
      }
    });
    const kept = fitLabels(items, W);
    this.labels.replaceChildren(...kept.map((it) => {
      if (it.kind === 'visit' && multi) {
        return el('button', {
          type: 'button', class: 'tl-lab tl-visit mono', style: `left:${it.x}px`, 'aria-pressed': String(foc === it.s.visit),
          title: foc === it.s.visit ? 'Playing this visit only. Click to play every visit again.' : `${it.full}. Click to play only this visit.`,
          'aria-label': `${it.full}. ${foc === it.s.visit ? 'Playing this visit only; press to play every visit' : 'Press to play only this visit'}`,
          onclick: () => this.cb.focusVisit(foc === it.s.visit ? null : it.s.visit),
        }, it.text);
      }
      return el('span', { class: `tl-lab mono ${it.kind === 'month' ? 'tl-month' : 'tl-visit plain'}`, style: `left:${it.x}px`, title: it.full || '', 'aria-hidden': it.kind === 'visit' ? null : 'true' }, it.text);
    }));
  }

  /** Move the handle to fractional play position `pos`; `i` is the frame on screen. */
  set(pos, i, valueText) {
    const x = posToX(this.layout.xs, pos);
    if (Math.abs(x - this.lastX) > 1e-5) { this.lastX = x; this.handle.style.left = `${(x * 100).toFixed(3)}%`; }
    if (i !== this.cur) {
      const kids = this.tickLayer.children;
      for (let k = 0; k < kids.length; k++) { kids[k].classList.toggle('cur', k === i); kids[k].classList.toggle('past', k < i); }
      this.cur = i;
      this.track.setAttribute('aria-valuenow', String(i + 1));
    }
    if (valueText && valueText !== this.valueText) { this.valueText = valueText; this.track.setAttribute('aria-valuetext', valueText); }
  }

  _fracAt(e) { const r = this.track.getBoundingClientRect(); return clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1); }
  _showTip(e, i) {
    const F = this.cb.frames(), f = F[i]; if (!f) { this.tip.hidden = true; return; }
    this.tip.textContent = fmtTaken(f.mjd); this.tip.hidden = false;
    const W = this.track.clientWidth, x = this.layout.xs[i] * W, w = this.tip.offsetWidth;
    this.tip.style.left = `${clamp(x - w / 2, 0, Math.max(0, W - w))}px`;
  }
  _bind() {
    const t = this.track;
    t.addEventListener('pointerdown', (e) => {
      if (!this.n || e.button > 0) return;
      t.setPointerCapture(e.pointerId); this.drag = { id: e.pointerId };
      this.cb.pause(); this._scrub(e, false);
    });
    t.addEventListener('pointermove', (e) => {
      if (!this.n) return;
      if (this.drag && e.pointerId === this.drag.id) { this._scrub(e, false); return; }
      if (e.pointerType === 'mouse') this._showTip(e, nearestFrame(this.layout.xs, this._fracAt(e)));
    });
    const end = (e) => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      this.drag = null;
      if (e.type !== 'pointercancel') this._scrub(e, true);
      else this.cb.seek(Math.round(this.cb.pos()), { snap: true });
      if (e.pointerType !== 'mouse') this.tip.hidden = true;
    };
    t.addEventListener('pointerup', end); t.addEventListener('pointercancel', end);
    t.addEventListener('pointerleave', () => { if (!this.drag) this.tip.hidden = true; });
    t.addEventListener('keydown', (e) => {
      if (!this.n || e.altKey || e.ctrlKey || e.metaKey) return;
      const { segs } = this.layout, i = Math.round(this.cb.pos());
      const sIdx = segs.findIndex((s) => i >= s.i0 && i <= s.i1);
      let to = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') to = i + 1;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') to = i - 1;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = this.n - 1;
      else if (e.key === 'PageDown') to = sIdx >= 0 && sIdx < segs.length - 1 ? segs[sIdx + 1].i0 : this.n - 1;
      else if (e.key === 'PageUp') to = sIdx > 0 ? (i > segs[sIdx].i0 ? segs[sIdx].i0 : segs[sIdx - 1].i0) : 0;
      if (to === null) return;
      e.preventDefault();
      this.cb.pause(); this.cb.seek(clamp(to, 0, this.n - 1), { snap: true });
    });
  }
  /** While dragging, video mode follows the pointer smoothly; letting go lands on the nearest real exposure. */
  _scrub(e, snap) {
    const x = this._fracAt(e), xs = this.layout.xs;
    if (snap) { this.cb.seek(nearestFrame(xs, x), { snap: true }); this.tip.hidden = true; return; }
    this.cb.seek(xToPos(xs, x), { snap: false });
    this._showTip(e, nearestFrame(xs, x));
  }
  destroy() { if (this.ro) this.ro.disconnect(); }
}

/** Fractional frame offset (from s.i0) at time mjd inside segment s, linear between the frames around it. */
function xToMjdPos(F, s, mjd) {
  let k = s.i0;
  while (k < s.i1 && F[k + 1].mjd <= mjd) k++;
  if (k >= s.i1) return s.i1 - s.i0;
  const w = F[k + 1].mjd - F[k].mjd;
  return k - s.i0 + (w > 0 ? (mjd - F[k].mjd) / w : 0);
}
