// Small hand-drawn canvas scatter chart with error bars, hover and click.
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export class ScatterChart {
  /**
   * opts: {xLabel, yLabel, xFmt, bands:[{x0,x1,label}], onHover(p|null), onClick(p), tooltip(p)->html}
   */
  constructor(canvas, tipEl, opts) {
    this.cv = canvas; this.tip = tipEl; this.o = opts;
    this.pts = []; this.hl = null; this.cur = null; this.hover = null; this.layout = null;
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerleave', () => this.setHover(null));
    canvas.addEventListener('click', () => { if (this.hover && opts.onClick) opts.onClick(this.hover); });
    new ResizeObserver(() => this.draw()).observe(canvas);
    this.message = '';
  }
  setData(pts, bands) { this.pts = pts; if (bands) this.o.bands = bands; this.message = ''; this.draw(); }
  setMessage(m) { this.pts = []; this.message = m; this.draw(); }
  highlight(id) { this.hl = id; this.draw(); }
  current(id) { this.cur = id; this.draw(); }
  setHover(p, ev) {
    if (p === this.hover) return;
    this.hover = p; this.cv.style.cursor = p ? 'pointer' : 'default';
    if (this.o.onHover) this.o.onHover(p);
    if (!p) this.tip.hidden = true;
    this.draw();
  }
  onMove(e) {
    const r = this.cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 14 * 14;
    for (const p of this.pts) {
      if (p._sx === undefined) continue;
      const d = (p._sx - mx) ** 2 + (p._sy - my) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    this.setHover(best);
    if (best) {
      this.tip.hidden = false; this.tip.innerHTML = this.o.tooltip(best);
      const w = this.tip.offsetWidth;
      this.tip.style.left = Math.min(r.width - w - 4, Math.max(4, mx + 12)) + 'px';
      this.tip.style.top = Math.max(4, my - 8 - this.tip.offsetHeight) + 'px';
    }
  }
  draw() {
    const cv = this.cv, dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const ink = css('--ink'), mute = css('--mute'), grid = css('--grid'), bg = css('--panel');
    const L = 58, R = 12, T = 22, B = 40, pw = W - L - R, ph = H - T - B;
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    if (!this.pts.length) {
      g.fillStyle = mute; g.textAlign = 'center'; g.font = '13px system-ui, sans-serif';
      g.fillText(this.message || 'No data', W / 2, H / 2); this.layout = null; return;
    }
    let x0 = Infinity, x1 = -Infinity, ys = [], nVis = 0, nGood = 0;
    for (const p of this.pts) {
      if (p.hidden) continue;
      nVis++; x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      if (!p.bad) { nGood++; ys.push(p.y - (p.err || 0), p.y + (p.err || 0)); }
    }
    // Scale on good points, unless they are a minority of what is shown (e.g. a saturated
    // star), in which case flagged points would mostly fall off the chart.
    if (nGood < nVis * 0.5) { ys = []; for (const p of this.pts) if (!p.hidden) ys.push(p.y); }
    if (!isFinite(x0)) { g.fillStyle = mute; g.textAlign = 'center'; g.fillText('All points hidden', W / 2, H / 2); return; }
    ys.sort((a, b) => a - b);
    let y0 = ys[Math.floor(ys.length * 0.01)], y1 = ys[Math.ceil(ys.length * 0.99) - 1];
    if (!(y1 > y0)) { y0 -= 1; y1 += 1; }
    const padY = (y1 - y0) * 0.08; y0 -= padY; y1 += padY;
    if (this.o.xDomain) [x0, x1] = this.o.xDomain; else { const px = (x1 - x0) * 0.04 || 1; x0 -= px; x1 += px; }
    const X = (v) => L + ((v - x0) / (x1 - x0)) * pw, Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * ph;
    this.layout = { X, Y };
    // bands
    (this.o.bands || []).forEach((b, i) => {
      const a = Math.max(L, X(b.x0)), c = Math.min(L + pw, X(b.x1));
      if (c <= a) return;
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.0)'; g.fillRect(a, T, c - a, ph);
      g.fillStyle = mute; g.textAlign = 'center'; g.fillText(b.label, (a + c) / 2, T - 8);
      g.strokeStyle = grid; g.beginPath(); g.moveTo(a, T); g.lineTo(a, T + ph); g.stroke();
    });
    // grid + ticks
    g.strokeStyle = grid; g.fillStyle = mute; g.lineWidth = 1;
    const yt = niceTicks(y0, y1, 5), xt = niceTicks(x0, x1, Math.max(3, Math.floor(pw / 90)));
    g.textAlign = 'right';
    for (const t of yt) { const y = Math.round(Y(t)) + 0.5; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); g.fillText(fmtNum(t), L - 6, y + 4); }
    g.textAlign = 'center';
    for (const t of xt) { const x = Math.round(X(t)) + 0.5; g.fillText(this.o.xFmt ? this.o.xFmt(t) : fmtNum(t), x, T + ph + 15); g.beginPath(); g.moveTo(x, T + ph); g.lineTo(x, T + ph + 4); g.stroke(); }
    if (y0 < 0 && y1 > 0) { g.strokeStyle = 'rgba(255,255,255,.35)'; g.setLineDash([4, 4]); const y = Y(0); g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); g.setLineDash([]); }
    g.fillStyle = ink; g.font = '12px system-ui, sans-serif';
    g.fillText(this.o.xLabel, L + pw / 2, H - 6);
    g.save(); g.translate(13, T + ph / 2); g.rotate(-Math.PI / 2); g.fillText(this.o.yLabel, 0, 0); g.restore();
    // clip & points
    g.save(); g.beginPath(); g.rect(L, T - 2, pw, ph + 4); g.clip();
    for (const p of this.pts) {
      if (p.hidden) { p._sx = undefined; continue; }
      const sx = X(p.x), sy = Y(p.y); p._sx = sx; p._sy = sy;
      const dim = p.bad ? 0.5 : 1;
      g.globalAlpha = dim;
      if (p.err) { g.strokeStyle = p.color; g.lineWidth = 1; g.globalAlpha = dim * 0.55; g.beginPath(); g.moveTo(sx, Y(p.y - p.err)); g.lineTo(sx, Y(p.y + p.err)); g.stroke(); }
      if (p.xerr) { g.beginPath(); g.moveTo(X(p.x - p.xerr), sy); g.lineTo(X(p.x + p.xerr), sy); g.stroke(); }
      g.globalAlpha = dim;
      g.beginPath(); g.arc(sx, sy, 3.6, 0, 6.2832);
      if (p.bad) { g.strokeStyle = p.color; g.lineWidth = 1.5; g.stroke(); }
      else { g.fillStyle = p.color; g.fill(); g.strokeStyle = bg; g.lineWidth = 1.5; g.stroke(); }
    }
    g.globalAlpha = 1;
    const off = this.pts.filter((p) => !p.hidden && (p.y < y0 || p.y > y1)).length;
    if (off) { g.fillStyle = mute; g.textAlign = 'right'; g.font = '11px system-ui, sans-serif'; g.fillText(`${off} point${off > 1 ? 's' : ''} off scale`, L + pw - 4, T + 12); }
    for (const p of this.pts) {
      if (p._sx === undefined || p.hidden) continue;
      const on = p === this.hover || p.id === this.hl, cur = p.id === this.cur;
      if (on || cur) { g.beginPath(); g.arc(p._sx, p._sy, on ? 8 : 7, 0, 6.2832); g.strokeStyle = on ? '#fff' : ink; g.lineWidth = on ? 2 : 1.5; if (cur && !on) g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]); }
    }
    g.restore();
  }
}

export function fmtNum(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(1);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return (+v.toPrecision(3)).toString();
}
function niceTicks(a, b, n) {
  const span = b - a, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw)), r = raw / mag;
  const step = (r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10) * mag, out = [];
  for (let t = Math.ceil(a / step) * step; t <= b + 1e-9; t += step) out.push(+t.toFixed(10));
  return out;
}
