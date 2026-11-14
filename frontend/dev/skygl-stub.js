// Throwaway Canvas2D stand-in for frontend/js/blink/skygl.js (same SkyRenderer API).
// The mock server serves this at /js/blink/skygl.js only while the real file does not exist.
const GROUND = [5, 7, 11];

export class SkyRenderer {
  constructor(canvas) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.frames = new Map(); this.npix = 0; this.view = { cx: 0, cy: 0, pxPerData: 1 };
    this.off = document.createElement('canvas'); this.resize();
  }
  resize() {
    const d = window.devicePixelRatio || 1, w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.dpr = d; this.canvas.width = Math.max(1, Math.round(w * d)); this.canvas.height = Math.max(1, Math.round(h * d));
  }
  setGrid(n) { this.npix = n; this.off.width = n; this.off.height = n; }
  setFrame(id, f) { this.frames.set(id, f); }
  dropFrame(id) { this.frames.delete(id); }
  setView(v) { Object.assign(this.view, v); }
  fit(cover = true) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, n = this.npix || 1;
    this.view = { cx: (n - 1) / 2, cy: (n - 1) / 2, pxPerData: (cover ? Math.max : Math.min)(w / n, h / n) };
  }
  toScreen(x, y) {
    const v = this.view;
    return { x: this.canvas.clientWidth / 2 + (x - v.cx) * v.pxPerData, y: this.canvas.clientHeight / 2 + (y - v.cy) * v.pxPerData };
  }
  toData(sx, sy) {
    const v = this.view;
    return { x: v.cx + (sx - this.canvas.clientWidth / 2) / v.pxPerData, y: v.cy + (sy - this.canvas.clientHeight / 2) / v.pxPerData };
  }
  sourceAt(sx, sy, id, r = 10) {
    const f = this.frames.get(id); if (!f || !f.sources) return [];
    return f.sources.map((s) => ({ s, d: Math.hypot(this.toScreen(s.x, s.y).x - sx, this.toScreen(s.x, s.y).y - sy) }))
      .filter((o) => o.d <= r).sort((a, b) => a.d - b.d).map((o) => o.s);
  }
  _paint(arr, lim, diffOf, sym) {
    const n = this.npix, c = this.off.getContext('2d'), im = c.createImageData(n, n), d = im.data;
    const lo = sym ? -lim.hi : lim.lo, span = (sym ? 2 * lim.hi : lim.hi - lim.lo) || 1;
    for (let i = 0; i < n * n; i++) {
      let v = arr[i]; if (diffOf) v -= diffOf[i];
      let t = v === v ? Math.min(1, Math.max(0, (v - lo) / span)) : 0;
      t = Math.asinh(t * 8) / Math.asinh(8);
      const o = i * 4;
      d[o] = GROUND[0] + (230 - GROUND[0]) * t; d[o + 1] = GROUND[1] + (226 - GROUND[1]) * t; d[o + 2] = GROUND[2] + (215 - GROUND[2]) * t; d[o + 3] = 255;
    }
    c.putImageData(im, 0, 0);
    return this.off;
  }
  render(o) {
    const ctx = this.ctx, d = this.dpr, W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = o.mode === 'diff' ? '#171A20' : '#05070B'; ctx.fillRect(0, 0, W, H);
    const A = this.frames.get(o.a); if (!A || !this.npix) return;
    const n = this.npix, p0 = this.toScreen(-0.5, -0.5), pp = this.view.pxPerData * d;
    const draw = (id, alpha, key) => {
      const f = this.frames.get(id); if (!f) return;
      const arr = f[key]; if (!arr) return;
      const src = this._paint(arr, o.lim, o.mode === 'diff' && o.prev != null && this.frames.get(o.prev) ? this.frames.get(o.prev)[key] : null, o.mode === 'diff' || o.layer === 'leftover');
      ctx.globalAlpha = alpha; ctx.imageSmoothingEnabled = true;
      ctx.drawImage(src, p0.x * d, p0.y * d, n * pp, n * pp);
      if (o.layer === 'model' && o.mode !== 'diff') {
        ctx.globalCompositeOperation = 'lighter';
        for (const s of f.sources || []) {
          const q = this.toScreen(s.x, s.y), r = Math.max(2, (0.8 + 0.7 * Math.log10(1 + Math.max(0, s.flux))) * this.view.pxPerData * 1.4) * d;
          const g = ctx.createRadialGradient(q.x * d, q.y * d, 0, q.x * d, q.y * d, r);
          g.addColorStop(0, `rgba(${230 * o.tint[0] | 0},${230 * o.tint[1] | 0},${230 * o.tint[2] | 0},0.9)`); g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q.x * d, q.y * d, r, 0, 7); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    };
    const key = o.layer === 'raw' ? 'img' : o.layer === 'leftover' ? 'leftover' : 'background';
    draw(o.a, 1, key);
    if (o.b != null && o.mode === 'video' && o.t > 0) draw(o.b, o.t, key);
    ctx.globalAlpha = 1;
  }
}
