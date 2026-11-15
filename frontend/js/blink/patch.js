// Patch view: streaming, playback, renderer driving, overlay drawing and pointer interaction.
import { SkyRenderer } from './skygl.js';
import { streamFrames } from '../api.js';
import { makeWcs } from '../wcs.js';
import { loadKnown, loadLinked, positionAt, pathUntil } from './movers.js';
import { computeLimits, findUnexplained } from './analysis.js';
import { buildCard } from './hover.js';
import { clamp } from './util.js';
import { reduceMotion } from './fly.js';

const BASE_FPS = 4, HOLD = 0.6, MAX_ZOOM = 16, EDGE_PAD = 6;
export const TINTS = [null, [0.55, 0.7, 1], [0.6, 0.85, 1], [0.78, 0.95, 0.85], [1, 0.92, 0.65], [1, 0.72, 0.5], [1, 0.52, 0.45]];
const ACCENT = '#F2B84B';
export const MODES = [
  ['video', 'Video', 'Every frame is lined up on the same stars, so the sky plays as one clip. The stars hold still; anything that slides is moving.'],
  ['blink', 'Blink', 'Hard cuts between frames. A moving object jumps while everything else stays put.'],
  ['diff', 'Difference', 'Each frame minus the one before it. Fixed stars cancel to grey; a mover leaves a bright spot where it is and a dark one where it was.'],
  ['trail', 'Trails', 'Frames stacked as they play. Fixed stars stay points; a mover draws a line.'],
];

export class Session {
  constructor(target) {
    this.target = target;                // {ra, dec, width, band}
    this.frames = [];                    // ok frames sorted by mjd
    this.byId = new Map();
    this.status = 'loading';             // loading | ready | empty | error | cancelled
    this.error = null; this.failed = 0; this.progress = null; this.selected = null;
    this.npix = 0; this.scale = 6.15; this.t0 = performance.now();
    this.ctl = new AbortController();
    this.known = []; this.linked = []; this.cands = []; this.moverNote = '';
    this.active = false; this.limits = null; this.limitsLocked = false;
  }
  get movers() { return [...this.known, ...this.linked, ...this.cands]; }
  abort() { if (this.status === 'loading') this.status = 'cancelled'; this.ctl.abort(); }
}

export class PatchView {
  /** cb: {onUpdate(), onFrameIndex(i), onFramesChanged(), onCursor(text|null), onRecentre(ra,dec), onLeave(), onPickMover(key), uiVisible(), clickAllowed()} */
  constructor(canvas, hoverEl, cb) {
    this.canvas = canvas; this.hoverEl = hoverEl; this.cb = cb;
    this.renderer = null; this.session = null; this.rendererError = null;
    this.mode = 'video'; this.layer = 'model'; this.speed = 1; this.playing = !reduceMotion();
    this.pos = 0; this.zoom = 1; this.cx = 0; this.cy = 0; this.base = 1;
    this.rings = false; this.selectedKey = null; this.dirty = true; this.opacity = 0;
    this.lastIdx = -1; this.drag = null; this.outAcc = 0; this.hoverPt = null; this.wcs = null;
    try { this.renderer = new SkyRenderer(canvas); } catch (e) { this.rendererError = e; }
    this._bind();
  }

  // ---------- session / loading ----------
  begin(target) {
    const s = new Session(target);
    const scale = Math.max(6.15, target.width * 3600 / 1000);
    s.scale = scale;
    const params = { ra: target.ra, dec: target.dec, fov: target.width, scale, detectors: target.band, per_visit: 6, max_frames: 400, model: 'progressive' };
    s.params = params;
    streamFrames(params, {
      signal: s.ctl.signal,
      onStart: (m) => { s.npix = m.npix; s.scale = m.scale_arcsec || scale; s.total = m.selected; s.startMeta = m; this._changed(s); },
      onProgress: (m) => { s.progress = m; this._changed(s); },
      onFrame: (meta, img, flags, bg, left) => this._addFrame(s, meta, img, bg, left),
      onModel: (meta, bg, left) => this._addModel(s, meta, bg, left),
      onEnd: () => {},
    }).then(() => {
      if (s.status === 'loading') s.status = s.frames.length ? 'ready' : 'empty';
      s.loadedMs = performance.now() - s.t0;
      this._finalize(s);
      this._loadMovers(s);
    }).catch((e) => {
      if (s.ctl.signal.aborted) { s.status = s.frames.length ? 'ready' : 'cancelled'; this._finalize(s); return; }
      s.error = e.message || String(e);
      s.status = s.frames.length ? 'ready' : 'error';
      this._finalize(s);
      if (s.frames.length) this._loadMovers(s);
    });
    return s;
  }

  _addFrame(s, meta, img, bg, left) {
    if (!meta.ok) { s.failed++; this._changed(s); return; }
    const m = meta.model || {};
    const f = { id: meta.id, mjd: meta.mjd, meta, img, bg: bg || null, left: left || null, sources: m.sources || [], psf: m.psf_fwhm_px || 2, noise: m.noise || 0.01, quality: m.quality, unexp: null };
    f.modelPending = s.startMeta && s.startMeta.model === 'progressive' && !meta.model;
    let lo = 0, hi = s.frames.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s.frames[mid].mjd <= f.mjd) lo = mid + 1; else hi = mid; }
    s.frames.splice(lo, 0, f); s.byId.set(f.id, f);
    this._visits(s);
    if (s.active) this._push(s, f);
    this._changed(s);
  }
  /** A fitted model for a raw frame (progressive mode). Crossfades the frame to the measured sky when it is on screen. */
  _addModel(s, meta, bg, left) {
    const f = s.byId.get(meta.id); if (!f) return;
    const m = meta.model || {};
    f.bg = bg; f.left = left; f.sources = m.sources || []; f.psf = m.psf_fwhm_px || f.psf || 2;
    f.noise = m.noise || f.noise || 0.01; f.quality = m.quality; f.unexp = null; f.modelPending = false;
    f.meta.model = m;
    const nBg = s.frames.reduce((n, x) => n + (x.bg ? 1 : 0), 0);
    if (!s.modelLimits && nBg > 0) {
      s.limits = computeLimits(s.frames);
      if (nBg >= Math.min(3, s.frames.length)) s.modelLimits = true;
    }
    if (s.active && this.renderer && this._gridFor === s) {
      this.renderer.setModel(f.id, { background: bg, leftover: left, sources: f.sources, psfFwhmPx: f.psf, noise: f.noise }, { fade: true });
    }
    this.dirty = true; this.cb.onFramesChanged(); this._changed(s);
  }
  /** 1-based positions (time order) of frames still waiting for their fitted model. */
  rawFrames(s = this.session) {
    if (!s) return [];
    const out = [];
    s.frames.forEach((f, i) => { if (f.modelPending) out.push(i + 1); });
    return out;
  }
  _visits(s) {
    let v = 0;
    s.frames.forEach((f, i) => { if (i && f.mjd - s.frames[i - 1].mjd > 20) v++; f.visit = v; f.idx = i; });
    s.visits = v + 1;
  }
  _push(s, f) {
    this.renderer.setFrame(f.id, { img: f.img, background: f.bg || f.img, leftover: f.left || new Float32Array(f.img.length), sources: f.sources, psfFwhmPx: f.psf, noise: f.noise });
    if (!s.limitsLocked && (s.frames.length >= 3 || s.status !== 'loading')) this._lock(s);
    else if (!s.limits) s.limits = computeLimits(s.frames);
    this.cb.onFramesChanged();
    this.dirty = true;
  }
  _lock(s) {
    s.limits = computeLimits(s.frames); s.limitsLocked = !!s.limits && (s.frames.length >= 3 || s.status !== 'loading');
    const nBg = s.frames.reduce((n, x) => n + (x.bg ? 1 : 0), 0);
    s.modelLimits = nBg > 0 && (nBg >= Math.min(3, s.frames.length) || s.status !== 'loading');
  }
  _finalize(s) {
    if (s.active && s.frames.length) { this._lock(s); this.cb.onFramesChanged(); }
    this._changed(s);
  }
  _changed(s) { this.cb.onUpdate(s); this.dirty = true; }

  async _loadMovers(s) {
    const p = { ra: s.params.ra, dec: s.params.dec, fov: s.params.fov, scale: s.params.scale, detectors: s.params.detectors, per_visit: 6, max_frames: 400 };
    const [k, l] = await Promise.allSettled([loadKnown(p, s.ctl.signal), loadLinked(p, s.ctl.signal)]);
    if (k.status === 'fulfilled') s.known = k.value;
    if (l.status === 'fulfilled') s.linked = l.value;
    s.moverNote = (k.status === 'rejected' && l.status === 'rejected') ? 'Moving-object lookup is unavailable right now.' : '';
    s.moversLoaded = true;
    this.cb.onMovers && this.cb.onMovers(s);
    this.dirty = true;
  }

  /** Make a session the displayed one (drops the previous one's frames from the renderer). */
  activate(s) {
    const r = this.renderer;
    if (this.session && this.session !== s) { this.session.active = false; if (r) for (const f of this.session.frames) r.dropFrame(f.id); }
    this.session = s; s.active = true;
    if (!r) return;
    if (s.npix) { r.setGrid(s.npix); this._gridFor = s; }
    this._setup(s);
    for (const f of s.frames) this.renderer.setFrame(f.id, { img: f.img, background: f.bg || f.img, leftover: f.left || new Float32Array(f.img.length), sources: f.sources, psfFwhmPx: f.psf, noise: f.noise });
    if (s.frames.length) this._lock(s);
    this.pos = 0; this.lastIdx = -1; this.playing = !reduceMotion();
    this.zoom = 1; this._fit();
    this.cb.onFramesChanged(); this.cb.onUpdate(s); this.dirty = true;
  }
  _setup(s) {
    if (s.npix) this.wcs = makeWcs(s.target.ra, s.target.dec, s.scale, s.npix);
  }
  /** Grid size is only known after the start record; activate lazily if it arrives later. */
  ensureGrid() {
    const s = this.session; if (!s || !this.renderer || !s.npix || this._gridFor === s) return;
    this.renderer.setGrid(s.npix); this._gridFor = s; this._setup(s); this._fit();
    for (const f of s.frames) this._push(s, f);
  }
  deactivate() {
    const s = this.session;
    if (s) { s.active = false; if (this.renderer) for (const f of s.frames) this.renderer.dropFrame(f.id); }
    this.session = null; this._gridFor = null; this.wcs = null; this.hideHover(); this.dirty = true;
  }

  // ---------- geometry ----------
  resize() { if (this.renderer) { this.renderer.resize(); this._fit(); } this.dirty = true; }
  _fit() {
    const s = this.session, r = this.renderer;
    if (!s || !r || !s.npix) return;
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1, n = s.npix;
    this.base = Math.max(w / n, h / n);
    if (this.zoom <= 1.0001) { this.zoom = 1; this.cx = this.cy = (n - 1) / 2; }
    this._applyView();
  }
  _applyView() {
    const s = this.session, r = this.renderer; if (!s || !r) return;
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1, n = s.npix, ppd = this.base * this.zoom;
    const hw = w / 2 / ppd, hh = h / 2 / ppd, c = (n - 1) / 2;
    this.cx = hw >= c + 0.5 ? c : clamp(this.cx, hw - 0.5, n - 0.5 - hw);
    this.cy = hh >= c + 0.5 ? c : clamp(this.cy, hh - 0.5, n - 0.5 - hh);
    r.setView({ cx: this.cx, cy: this.cy, pxPerData: ppd });
    this.dirty = true;
  }
  toScreen(x, y) { return this.renderer.toScreen(x, y); }

  // ---------- playback ----------
  get frames() { return this.session ? this.session.frames : []; }
  get n() { return this.frames.length; }
  setPlaying(v) { this.playing = v && this.n > 1; this.dirty = true; }
  seek(i) { this.pos = clamp(i, 0, Math.max(0, this.n - 1)); this.playing = false; this.dirty = true; }
  _state() {
    const n = this.n;
    if (!n) return null;
    const p = Math.min(this.pos, n - 1);
    let a = Math.floor(p), t = p - a, b = a < n - 1 ? a + 1 : null;
    if (this.mode !== 'video') { t = 0; b = null; }
    if (b === null) t = 0;
    const F = this.frames, mjd = F[a].mjd + (b !== null ? t * (F[b].mjd - F[a].mjd) : 0);
    return { a, b, t, p, mjd, nearest: this.mode === 'video' ? Math.round(p) : a };
  }
  get current() { const st = this._state(); return st ? this.frames[st.nearest] : null; }

  /** Called once per animation frame. Returns true when something was drawn. */
  frame(dt, ctx, dpr, uiVisible) {
    const s = this.session, r = this.renderer;
    if (!s || !r || !s.npix) return;
    this.ensureGrid();
    const n = this.n;
    if (this.playing && n > 1) {
      this.pos += dt * BASE_FPS * this.speed;
      const cycle = (n - 1) + HOLD;
      if (this.pos >= cycle) this.pos -= cycle;
      this.dirty = true;
    }
    const st = this._state();
    if (!st) return;
    if (st.nearest !== this.lastIdx) { this.lastIdx = st.nearest; this.cb.onFrameIndex(st.nearest, st, this.frames[st.nearest]); }
    if (r.fading) this.dirty = true;   // keep redrawing while a raw -> model crossfade runs
    if (this.dirty || this.opacity > 0) {
      const F = this.frames, lim = s.limits || { model: { lo: 0, hi: 1 }, raw: { lo: 0, hi: 1 }, trail: { lo: 0, hi: 1 }, leftover: { lo: -1, hi: 1 }, diff: { lo: -1, hi: 1 } };
      const key = this.mode === 'diff' ? 'diff' : this.layer;
      const sym = key === 'leftover' || key === 'diff';
      const aId = F[st.a].id;
      r.render({
        a: aId, b: st.b !== null ? F[st.b].id : null, t: st.t, mode: this.mode, layer: this.layer,
        lim: lim[key] || lim.model, stretch: sym ? 'linear' : 'asinh', tint: TINTS[s.target.band] || [1, 1, 1],
        trail: F.slice(0, st.a + 1).map((f) => f.id), prev: st.a > 0 ? F[st.a - 1].id : aId,
      });
      this.dirty = false;
    }
    if (this.opacity > 0.5) this._drawOverlay(ctx, st, uiVisible);
  }

  // ---------- overlay: rings, trails, unexplained markers ----------
  visibleMovers() {
    const s = this.session; if (!s) return [];
    return s.movers.filter((m) => this.rings || m.kind === 'candidate' || m.key === this.selectedKey);
  }
  _unexplained(f) {
    if (f.unexp) return f.unexp;
    f.unexp = this.layer === 'raw' || !f.left ? [] : findUnexplained(f.left, this.session.npix, f.noise, f.psf, f.sources);
    return f.unexp;
  }
  _drawOverlay(ctx, st, uiVisible) {
    const s = this.session, r = this.renderer;
    ctx.save();
    ctx.lineWidth = 1.5; ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace';
    const items = [];
    for (const m of this.visibleMovers()) {
      const pos = positionAt(m, st.mjd); if (!pos) continue;
      items.push({ m, sel: m.key === this.selectedKey, q: r.toScreen(pos.x, pos.y) });
    }
    for (const { m, sel, q } of items) {
      if (this.mode === 'trail') {
        const path = pathUntil(m, st.mjd);
        if (path.length > 1) { ctx.strokeStyle = 'rgba(242,184,75,0.65)'; ctx.setLineDash([]); ctx.lineWidth = 1; ctx.beginPath(); path.forEach((pt, i) => { const z = r.toScreen(pt.x, pt.y); i ? ctx.lineTo(z.x, z.y) : ctx.moveTo(z.x, z.y); }); ctx.stroke(); }
      }
      ctx.strokeStyle = ACCENT; ctx.lineWidth = sel ? 3 : 1.5;
      ctx.setLineDash(m.kind === 'candidate' ? [4, 4] : []);
      ctx.beginPath(); ctx.arc(q.x, q.y, 20, 0, Math.PI * 2); ctx.stroke();
    }
    const placed = [];
    ctx.setLineDash([]); ctx.fillStyle = ACCENT; ctx.shadowColor = 'rgba(5,7,11,.9)'; ctx.shadowBlur = 4;
    for (let i = 0; i < items.length; i++) {
      const { m, q } = items[i], tw = ctx.measureText(m.short).width;
      const cands = [
        [q.x + 16, q.y - 16], [q.x - 16 - tw, q.y + 24], [q.x - 16 - tw, q.y - 16],
        [q.x + 16, q.y + 24], [q.x - tw / 2, q.y - 25], [q.x - tw / 2, q.y + 32],
      ];
      let best = cands[0], bestScore = Infinity;
      for (let k = 0; k < cands.length; k++) {
        const [lx, ly] = cands[k], x0 = lx - 2, y0 = ly - 12, x1 = lx + tw + 2, y1 = ly + 2;
        let score = k * 0.01;
        for (const b of placed) if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) score += 100;
        for (let j = 0; j < items.length; j++) {
          if (j === i) continue;
          const o = items[j].q, dx = Math.max(x0 - o.x, 0, o.x - x1), dy = Math.max(y0 - o.y, 0, o.y - y1);
          if (Math.hypot(dx, dy) < 22) score += 10;
        }
        if (score < bestScore) { bestScore = score; best = cands[k]; }
        if (score < 1) break;
      }
      ctx.fillText(m.short, best[0], best[1]);
      placed.push([best[0] - 2, best[1] - 12, best[0] + tw + 2, best[1] + 2]);
    }
    ctx.shadowBlur = 0;
    if (uiVisible && this.layer !== 'raw' && this.mode !== 'diff') {
      const f = this.frames[st.nearest];
      if (f) {
        ctx.strokeStyle = 'rgba(233,230,223,0.75)'; ctx.lineWidth = 1.25; ctx.setLineDash([1.5, 3.5]); ctx.lineCap = 'round';
        for (const u of this._unexplained(f)) { const q = r.toScreen(u.x, u.y); ctx.beginPath(); ctx.arc(q.x, q.y, 11, 0, Math.PI * 2); ctx.stroke(); }
      }
    }
    ctx.restore();
  }

  // ---------- pointer interaction ----------
  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.session || !this.session.npix) return;
      c.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, moved: false, allowed: this.cb.clickAllowed() };
      this.hideHover();
    });
    c.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (d) {
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) > 6) d.moved = true;
        if (d.moved) { const ppd = this.base * this.zoom; this.cx = d.cx - dx / ppd; this.cy = d.cy - dy / ppd; this._applyView(); }
        return;
      }
      this._hover(e);
    });
    const up = (e) => {
      const d = this.drag; this.drag = null;
      if (!d || e.type === 'pointercancel') return;
      if (!d.moved && d.allowed) this._click(e);
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => { this.hideHover(); this.cb.onCursor(null); });
    c.addEventListener('wheel', (e) => {
      if (!this.session || !this.session.npix) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      if (dy > 0 && this.zoom <= 1.0001) { this.outAcc += dy; if (this.outAcc > 90) { this.outAcc = 0; this.cb.onLeave(); } return; }
      this.outAcc = 0;
      const rect = c.getBoundingClientRect(), sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const d0 = this.renderer.toData(sx, sy);
      this.zoom = clamp(this.zoom * Math.exp(-dy * 0.0015), 1, MAX_ZOOM);
      const ppd = this.base * this.zoom;
      this.cx = d0.x - (sx - rect.width / 2) / ppd; this.cy = d0.y - (sy - rect.height / 2) / ppd;
      this._applyView(); this.hideHover();
    }, { passive: false });
  }
  _rel(e) { const r = this.canvas.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; }
  _moversAt(sx, sy, rad) {
    const st = this._state(); if (!st) return [];
    const out = [];
    for (const m of this.visibleMovers()) {
      const p = positionAt(m, st.mjd); if (!p) continue;
      const q = this.renderer.toScreen(p.x, p.y); const d = Math.hypot(q.x - sx, q.y - sy);
      if (d <= rad) out.push({ m, d });
    }
    return out.sort((a, b) => a.d - b.d).map((o) => o.m);
  }
  _click(e) {
    const { sx, sy } = this._rel(e);
    const hit = this._moversAt(sx, sy, 24)[0];
    if (hit) { this.cb.onPickMover(hit.key); return; }
    const d = this.renderer.toData(sx, sy);
    if (!this.wcs) return;
    const sky = this.wcs.toSky(d.x, d.y);
    this.cb.onRecentre(sky.ra, sky.dec);
  }
  _hover(e) {
    const s = this.session, r = this.renderer;
    if (!s || !r || !this.wcs) return;
    const { sx, sy } = this._rel(e), d = r.toData(sx, sy), sky = this.wcs.toSky(d.x, d.y);
    this.cb.onCursor(sky);
    const st = this._state(); if (!st) return;
    const f = this.frames[st.nearest];
    const movers = this._moversAtAny(sx, sy, 16, st);
    let srcs = [];
    try { srcs = r.sourceAt(sx, sy, f.id, 10) || []; } catch (_) { srcs = []; }
    // A target the user asked for by name carries its parallax: the fitted source at the centre inherits it
    // when no catalogue match came back (the catalogue cross-match is optional on the server).
    const nm = s.target.named;
    if (nm) {
      const c0 = (s.npix - 1) / 2, near = f.sources.filter((q) => !q.cat && Math.hypot(q.x - c0, q.y - c0) < 3.5).sort((p, q) => q.flux - p.flux)[0];
      if (near) srcs = srcs.map((q) => (q === near ? { ...q, cat: { catalog: 'SIMBAD', id: nm.name, parallax_mas: nm.plx } } : q));
    }
    // Movers that are also fitted sources: hide the duplicate source entry.
    if (movers.length) srcs = srcs.filter((q) => !movers.some((m) => { const p = positionAt(m, st.mjd); return p && Math.hypot(p.x - q.x, p.y - q.y) < 3; }));
    let node = null;
    if (movers.length || srcs.length) node = buildCard(srcs, movers, s.scale);
    else if (this.layer !== 'raw' && this.mode !== 'diff' && this.cb.uiVisible()) {
      const u = this._unexplained(f).find((q) => { const p = r.toScreen(q.x, q.y); return Math.hypot(p.x - sx, p.y - sy) < 16; });
      if (u) { node = document.createElement('div'); node.textContent = 'Possible faint object — try Advanced options'; }
    }
    if (!node) { this.hideHover(); return; }
    const h = this.hoverEl; h.replaceChildren(node); h.hidden = false;
    const w = this.canvas.clientWidth, hh = this.canvas.clientHeight;
    const bw = h.offsetWidth, bh = h.offsetHeight;
    h.style.left = `${Math.round(sx + 16 + bw > w ? sx - 16 - bw : sx + 16)}px`;
    h.style.top = `${Math.round(clamp(sy - bh / 2, 8, hh - bh - 8))}px`;
  }
  /** Movers near the cursor regardless of the ring toggle (hovering a known mover always explains it). */
  _moversAtAny(sx, sy, rad, st) {
    const s = this.session, out = [];
    for (const m of s.movers) {
      const p = positionAt(m, st.mjd); if (!p) continue;
      const q = this.renderer.toScreen(p.x, p.y);
      if (Math.hypot(q.x - sx, q.y - sy) <= rad) out.push(m);
    }
    return out;
  }
  hideHover() { if (this.hoverEl) this.hoverEl.hidden = true; }

  setOpacity(v) {
    this.opacity = v; this.canvas.style.opacity = String(v);
    if (v <= 0.001) { this.hideHover(); }
    this.dirty = true;
  }
}
