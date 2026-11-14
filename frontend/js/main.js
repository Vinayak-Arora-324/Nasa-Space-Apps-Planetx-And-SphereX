import * as api from './api.js';
import { S, readURL, set, linkURL, writeURL } from './state.js';
import { makeWcs, mjdToYear, fmtDate, propagate, fmtRA, fmtDec } from './wcs.js';
import { Store, BANDS, coadd, subOf, clusterEpochs } from './data.js';
import { CMAPS, autoLimits, symLimits, limitsFromSorted, paint, paintRGB, paintFlags } from './render.js';
import { sampleFinite } from './data.js';
import { DET_COLORS, epochColor } from './palette.js';
import { ScatterChart, fmtNum } from './charts.js';
import { drawTimeline } from './timeline.js';
import { showContext, setSurvey, SURVEYS } from './context.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = new Store();
// Moving targets are centred where they are during the SPHEREx data: positions with a proper
// motion are propagated to this reference epoch before loading, and the URL carries
// ra/dec at this epoch (epoch=2026), so links are unambiguous.
const REF_EPOCH = 2026.0;
let posNote = '';
// The challenge's WISE coordinates are an older position, not a fixed sky patch.
// Resolve that exact example to the same catalogue astrometry as the named preset.
const WISE_CHALLENGE = { ra: 133.7951291667, dec: -7.2451472222 };
const WISE_FALLBACK = { ra: 133.81890825, dec: -7.247048, pmra: -8123.7, pmdec: 673.2, epoch: 2000 };
const PRESETS = [
  { label: "Barnard's Star", q: "Barnard's Star" },
  { label: 'Epsilon Indi B', q: 'Epsilon Indi B', fallback: { ra: 331.0437, dec: -56.7828, pmra: 3966, pmdec: -2536, epoch: 2000 } },
  { label: 'WISE 0855', q: 'WISE J085510.83-071442.5', fallback: WISE_FALLBACK },
  { label: 'RW Aurigae', q: 'RW Aur' },
  { label: 'R Draconis', q: 'R Dra' },
];

let wcs = null, startInfo = null, meta = null, loadCtl = null, loadId = 0, loadParams = null, loading = false;
let items = [], idx = 0, playing = false, playRaf = null, dir = 1, acc = 0, lastT = 0;
let hoverId = null, view = { zoom: 1, vx: 0, vy: 0 }, catalogs = {}, lastCat = [], drag = null;
let measured = null, specCtl = null, specChart = null, lcChart = null, epochsCache = [];
const cache = new Map(), paintCache = new Map();
let rebuildTimer = null, lastRebuild = 0, rafPending = false;

/* ---------------------------------------------------------------- status */
function say(kind, html) { $('#status').innerHTML = html ? `<div class="msg ${kind || ''}">${html}</div>` : ''; }
function showEmpty(html) { const e = $('#empty'); e.hidden = !html; e.innerHTML = html ? `<p>${html}</p>` : ''; }

/* ---------------------------------------------------------------- geometry helpers */
function pmOn() { return (S.pmra != null || S.pmdec != null) && !!(S.pmra || S.pmdec); }
function targetSky(mjd) {
  if (!pmOn()) return { ra: S.ra, dec: S.dec };
  return propagate(S.ra, S.dec, S.pmra, S.pmdec, S.epoch ?? 2000, mjdToYear(mjd));
}
function normalizeEpoch() {
  if (!pmOn()) return;
  const from = S.epoch ?? 2000;
  if (Math.abs(from - REF_EPOCH) < 1e-6) return;
  const p = propagate(S.ra, S.dec, S.pmra, S.pmdec, from, REF_EPOCH);
  set({ ra: +p.ra.toFixed(7), dec: +p.dec.toFixed(7), epoch: REF_EPOCH });
  posNote += `RA/Dec propagated from epoch ${from} to ${REF_EPOCH.toFixed(1)} with the proper motion, so the field is centred where the object is in the SPHEREx data.`;
}
function targetPx(mjd) { const t = targetSky(mjd); return wcs ? wcs.toPix(t.ra, t.dec) : null; }
const flagMask = () => {
  const bits = S.flagbits ?? Object.values(startInfo?.flag_bits || {});
  let m = 0; for (const b of bits) m = (m | (1 << b)) >>> 0; return m >>> 0;
};
const flagNames = (v) => startInfo ? Object.entries(startInfo.flag_bits).filter(([, b]) => ((v >>> b) & 1) === 1).map(([n]) => n) : [];

/* ---------------------------------------------------------------- items */
function sdet() {
  if (S.sdet) return S.sdet;
  let best = 0, bc = -1; for (let d = 1; d <= 6; d++) { const c = store.count(d); if (c > bc) { bc = c; best = d; } }
  return bc > 0 ? best : (S.sdet || 1);
}
const wlRange = (fs) => { const w = fs.map((f) => f.wavelength_um).filter((v) => v != null); return w.length ? [Math.min(...w), Math.max(...w)] : null; };
const optsKey = () => `${S.median}|${S.ignoreflag}|${S.bg}|${S.ignoreflag ? flagMask() : 0}`;

function frameItem(f, n) {
  return {
    key: 'f' + f.id, kind: 'frame', frames: [f], mjd: f.mjd, epoch: f.epoch, det: f.detector, id: f.id,
    get: () => ({ img: S.bg ? subOf(f) : f.img, flags: f.flags }),
  };
}
function getStack(d, epoch, track) {
  const fs = store.frames.filter((f) => f.detector === d && (epoch === 'all' || f.epoch === epoch));
  const key = `st|${d}|${epoch}|${track}|${optsKey()}|${fs.length}|${store.version}`;
  if (cache.has(key)) return { ...cache.get(key), fs };
  let shifts = null;
  if (track) {
    const ref = targetPx(store.frames.filter((f) => f.detector === d)[0]?.mjd ?? fs[0].mjd);
    shifts = fs.map((f) => { const t = targetPx(f.mjd); return t && ref ? [Math.round(t.x - ref.x), Math.round(t.y - ref.y)] : [0, 0]; });
  }
  const r = coadd(fs, wcs.npix, { method: S.median ? 'median' : 'mean', bg: true, flagMask: S.ignoreflag ? flagMask() : 0, shifts });
  cache.set(key, r);
  return { ...r, fs };
}
function stackItem(d, epoch, track) {
  const fs = store.frames.filter((f) => f.detector === d && (epoch === 'all' || f.epoch === epoch));
  const mjds = fs.map((f) => f.mjd);
  return {
    key: `s|${d}|${epoch}|${track}`, kind: 'stack', frames: fs, det: d, epoch, track, mjd: mjds.reduce((a, b) => a + b, 0) / mjds.length,
    get: () => getStack(d, epoch, track),
  };
}
function diffSources() {
  const d = sdet(), eps = [...new Set(store.frames.filter((f) => f.detector === d).map((f) => f.epoch))].sort((a, b) => a - b);
  const parse = (v, fallback) => v || fallback;
  const A = parse(S.ea, eps.length ? 'e:' + eps[eps.length - 1] : null), B = parse(S.eb, eps.length ? 'e:' + eps[0] : null);
  return { d, eps, A, B };
}
function resolveSrc(spec, d) {
  if (!spec) return null;
  if (spec.startsWith('e:')) { const e = +spec.slice(2); const fs = store.frames.filter((f) => f.detector === d && f.epoch === e); return fs.length ? { fs, label: `epoch ${e}`, get: () => getStack(d, e, false) } : null; }
  const f = store.byId.get(spec.slice(2)); return f && f.detector === d ? { fs: [f], label: `frame ${f.mjd.toFixed(2)}`, get: () => ({ img: subOf(f), flags: f.flags }) } : null;
}
function diffItem() {
  const { d, A, B } = diffSources(), a = resolveSrc(A, d), b = resolveSrc(B, d);
  if (!a || !b) return null;
  const mjd = (x) => x.fs.reduce((s, f) => s + f.mjd, 0) / x.fs.length;
  return {
    key: `d|${d}|${A}|${B}`, kind: 'diff', det: d, A: a, B: b, frames: [...a.fs, ...b.fs], mjd: mjd(a),
    get: () => {
      const key = `df|${d}|${A}|${B}|${optsKey()}|${store.version}`;
      if (cache.has(key)) return cache.get(key);
      const x = a.get(), y = b.get(), out = new Float32Array(x.img.length), fl = new Uint32Array(x.img.length);
      for (let i = 0; i < out.length; i++) { out[i] = x.img[i] - y.img[i]; fl[i] = x.flags[i] | y.flags[i]; }
      const r = { img: out, flags: fl }; cache.set(key, r); return r;
    },
  };
}
function buildItems() {
  if (!wcs || !store.frames.length) return [];
  const m = S.mode;
  if (m === 'frames') return store.frames.filter((f) => S.det.includes(f.detector)).map(frameItem);
  if (m === 'epochs' || m === 'track') {
    const d = sdet(), eps = [...new Set(store.frames.filter((f) => f.detector === d).map((f) => f.epoch))].sort((a, b) => a - b);
    const out = eps.map((e) => stackItem(d, e, m === 'track'));
    if (m === 'track' && eps.length > 1) out.push(stackItem(d, 'all', true));
    return out;
  }
  if (m === 'diff') { const i = diffItem(); return i ? [i] : []; }
  return [];
}
function rebuild(keepKey) {
  if (loading) { cache.clear(); paintCache.clear(); }
  const oldKey = keepKey ?? items[idx]?.key;
  items = buildItems();
  const at = items.findIndex((i) => i.key === oldKey);
  idx = at >= 0 ? at : Math.min(idx, Math.max(0, items.length - 1));
  lastRebuild = performance.now();
  buildChips(); buildModeOpts(); updateScrubber(); updateTimeline(); requestDraw();
}
function scheduleRebuild() {
  if (rebuildTimer) return;
  const wait = Math.max(0, 250 - (performance.now() - lastRebuild));
  rebuildTimer = setTimeout(() => { rebuildTimer = null; rebuild(); }, wait);
}
function invalidate() { cache.clear(); paintCache.clear(); rebuild(); }

/* ---------------------------------------------------------------- limits & drawing */
function lockLimits() {
  const key = `lock|${S.mode}|${sdet()}|${S.det}|${S.ea}|${S.eb}|${items.length}|${S.hi}|${optsKey()}|${store.version}`;
  if (cache.has(key)) return cache.get(key);
  const pool = [], step = Math.max(1, Math.floor(items.length / 40));
  for (let i = 0; i < items.length; i += step) pool.push(...sampleFinite(items[i].get().img, 3000));
  pool.sort((a, b) => a - b);
  const lim = pool.length ? limitsFromSorted(pool, S.hi) : { lo: 0, hi: 1 };
  cache.set(key, lim); return lim;
}
function limitsFor(it, data) {
  if (it.kind === 'diff') return symLimits(data.img, S.hi);
  if (S.lock && items.length > 1) return lockLimits();
  return autoLimits(data.img, S.hi);
}
function paintItem(it, data) {
  const lim = limitsFor(it, data), cmap = it.kind === 'diff' ? 'div' : S.cmap;
  const key = `${it.key}|${S.stretch}|${cmap}|${lim.lo}|${lim.hi}|${store.version}|${optsKey()}`;
  let cv = paintCache.get(key);
  if (!cv) { if (paintCache.size > 120) paintCache.clear(); cv = paint(data.img, wcs.npix, lim, S.stretch, cmap); paintCache.set(key, cv); }
  return { cv, lim };
}

function requestDraw() { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; draw(); }); }
const curItem = () => {
  if (hoverId && S.mode === 'frames') { const i = items.find((x) => x.id === hoverId); if (i) return i; }
  return items[idx];
};
let geom = { side: 300, k: 1 };
const toScreen = (x, y) => [(x - view.vx) * geom.k + geom.side / 2, (y - view.vy) * geom.k + geom.side / 2];
const toImg = (sx, sy) => [(sx - geom.side / 2) / geom.k + view.vx, (sy - geom.side / 2) / geom.k + view.vy];

function halo(g, fn, color, w = 1.6) { g.lineWidth = w + 2.5; g.strokeStyle = 'rgba(0,0,0,.8)'; fn(); g.stroke(); g.lineWidth = w; g.strokeStyle = color; fn(); g.stroke(); }

function draw() {
  const strip = S.mode === 'strip', cv = $('#main');
  $('#strip').hidden = !strip; cv.hidden = strip;
  document.querySelectorAll('#modes button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === S.mode)));
  if (!wcs || !store.frames.length) { cv.hidden = true; $('#caption').innerHTML = ''; return; }
  if (strip) { drawStrip(); $('#empty').hidden = true; return; }
  const it = curItem();
  if (!it) {
    cv.hidden = true; $('#caption').innerHTML = '';
    showEmpty(S.mode === 'diff' ? 'Difference needs two different epochs or frames of the same detector. Pick A and B above (this detector may only have one epoch loaded).' : 'No frames to show for this selection.');
    return;
  }
  showEmpty('');
  // In embed mode the whole player (tabs, chips, caption, controls) must fit the iframe height.
  let maxH = Math.round(innerHeight * 0.74);
  const stage = $('#stage');
  if (S.embed) maxH = innerHeight - 12 - ($('#viewer').getBoundingClientRect().bottom + scrollY - stage.getBoundingClientRect().height);
  const side = Math.max(200, Math.min(stage.clientWidth || 600, maxH));
  const dpr = window.devicePixelRatio || 1;
  if (geom.side !== side || cv.width !== Math.round(side * dpr)) { cv.style.width = cv.style.height = side + 'px'; cv.width = cv.height = Math.round(side * dpr); }
  geom.side = side; geom.k = (side / wcs.npix) * view.zoom;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#03050a'; g.fillRect(0, 0, side, side);
  const data = it.get(), { cv: pix } = paintItem(it, data);
  g.imageSmoothingEnabled = S.smooth; g.imageSmoothingQuality = 'high';
  const [ox, oy] = toScreen(-0.5, -0.5); const sz = wcs.npix * geom.k;
  g.drawImage(pix, ox, oy, sz, sz);
  if (S.flags && startInfo) {
    const fc = paintFlags(data.flags, wcs.npix, flagMask());
    g.imageSmoothingEnabled = false; g.drawImage(fc, ox, oy, sz, sz); g.imageSmoothingEnabled = S.smooth;
  }
  drawCatalogs(g, it);
  if (S.marker) drawMarkers(g, it);
  drawCompassScale(g, side);
  updateCaption(it); updateMeta(it); updateScrubUI();
  if (lcChart) { const cid = it.kind === 'frame' ? it.id : null; specChart?.current(cid); lcChart.current(cid); }
}

function markersFor(it) {
  const px = (fs, label) => {
    const p = fs.map((f) => targetPx(f.mjd)).filter(Boolean); if (!p.length) return null;
    return { x: p.reduce((s, q) => s + q.x, 0) / p.length, y: p.reduce((s, q) => s + q.y, 0) / p.length, label };
  };
  if (it.kind === 'diff') return [px(it.A.fs, 'A'), px(it.B.fs, 'B')].filter(Boolean);
  if (it.track) { const r = targetPx(store.frames.filter((f) => f.detector === it.det)[0].mjd); return r ? [{ x: r.x, y: r.y, label: '' }] : []; }
  const m = px(it.frames, ''); return m ? [m] : [];
}
function drawMarkers(g, it) {
  for (const m of markersFor(it)) {
    const [sx, sy] = toScreen(m.x, m.y), r = Math.max(11, geom.k * 3.2), gap = r * 0.45;
    halo(g, () => { g.beginPath(); g.arc(sx, sy, r, 0, 6.2832); g.moveTo(sx - r - 6, sy); g.lineTo(sx - gap - 2, sy); g.moveTo(sx + gap + 2, sy); g.lineTo(sx + r + 6, sy); g.moveTo(sx, sy - r - 6); g.lineTo(sx, sy - gap - 2); g.moveTo(sx, sy + gap + 2); g.lineTo(sx, sy + r + 6); }, '#ffd23f');
    if (m.label) { g.fillStyle = '#ffd23f'; g.font = '700 12px system-ui'; g.fillText(m.label, sx + r + 4, sy - r - 2); }
  }
}
function drawCatalogs(g, it) {
  lastCat = [];
  for (const [cat, color, shape] of [['gaia', '#4dd0ff', 'c'], ['catwise', '#ff7ad9', 's']]) {
    const c = catalogs[cat]; if (!S[cat] || !c?.sources) continue;
    const yr = mjdToYear(it.mjd), lim = CAT_DEPTH[S.catdepth]?.[cat] ?? Infinity;
    for (const s of c.sources) {
      if (s.ra == null || s.dec == null) continue;
      if (lim !== Infinity && !(s.mag != null && s.mag <= lim) && s !== picked && !fastMover(s, cat)) continue;
      const p = propagate(s.ra, s.dec, s.pmra, s.pmdec, s.epoch ?? (cat === 'gaia' ? 2016 : 2015.4), yr), q = wcs.toPix(p.ra, p.dec);
      if (!q) continue;
      const [sx, sy] = toScreen(q.x, q.y); if (sx < -10 || sy < -10 || sx > geom.side + 10 || sy > geom.side + 10) continue;
      const r = s === picked ? 9 : 7;
      halo(g, () => { g.beginPath(); if (shape === 'c') g.arc(sx, sy, r, 0, 6.2832); else g.rect(sx - r, sy - r, 2 * r, 2 * r); }, s === picked ? '#fff' : color, s === picked ? 2.4 : 1.4);
      lastCat.push({ sx, sy, s, cat });
    }
  }
}
function niceLen(arcsecPerCss) {
  const target = 110 * arcsecPerCss, steps = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200];
  return steps.reduce((b, v) => (Math.abs(v - target) < Math.abs(b - target) ? v : b));
}
function drawCompassScale(g, side) {
  g.save(); g.font = '600 12px system-ui'; g.fillStyle = '#fff';
  const cx = side - 34, cy = 40, L = 22;
  halo(g, () => { g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, cy - L); g.moveTo(cx, cy); g.lineTo(cx - L, cy); }, '#fff', 1.5);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = '#000';
  g.strokeText('N', cx, cy - L - 5); g.fillText('N', cx, cy - L - 5);
  g.strokeText('E', cx - L - 9, cy + 4); g.fillText('E', cx - L - 9, cy + 4);
  const len = niceLen(wcs.scale / geom.k), px = len / wcs.scale * geom.k, x0 = 14, y0 = side - 34;
  halo(g, () => { g.beginPath(); g.moveTo(x0, y0 - 4); g.lineTo(x0, y0); g.lineTo(x0 + px, y0); g.lineTo(x0 + px, y0 - 4); }, '#fff', 1.5);
  g.textAlign = 'left'; const lab = len >= 60 ? `${len / 60}′` : `${len}″`;
  g.strokeText(lab, x0, y0 - 8); g.fillText(lab, x0, y0 - 8);
  g.restore();
}

/* strip mode */
function drawStrip() {
  const box = $('#strip'); box.innerHTML = '';
  const ep = S.estack === 'all' ? 'all' : +S.estack;
  const mk = (title, sub, cvPix, d, pressed) => {
    const f = document.createElement('figure'); f.tabIndex = 0; f.setAttribute('role', 'button'); f.setAttribute('aria-pressed', String(pressed));
    const c = document.createElement('canvas'); c.width = c.height = wcs.npix; c.getContext('2d').drawImage(cvPix, 0, 0);
    if (S.smooth) c.style.imageRendering = 'auto';
    const cap = document.createElement('figcaption'); cap.innerHTML = `<b style="color:${d ? DET_COLORS[d] : '#fff'}">${esc(title)}</b> ${esc(sub)}`;
    f.append(c, cap);
    if (d) { const pick = () => { set({ sdet: d }); buildChips(); drawStrip(); }; f.onclick = pick; f.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }; }
    box.appendChild(f);
  };
  const imgs = {};
  for (let d = 1; d <= 6; d++) {
    const n = store.frames.filter((f) => f.detector === d && (ep === 'all' || f.epoch === ep)).length;
    if (!n) { mk(`D${d}`, 'no frames', paint(new Float32Array(wcs.npix ** 2).fill(NaN), wcs.npix, { lo: 0, hi: 1 }, 'linear', 'gray'), d, d === sdet()); continue; }
    const st = getStack(d, ep, false); imgs[d] = st.img;
    mk(`D${d}`, `${BANDS[d].lo}–${BANDS[d].hi} µm · ${n} fr`, paint(st.img, wcs.npix, autoLimits(st.img, S.hi), S.stretch, S.cmap), d, d === sdet());
  }
  const [r, gch, b] = S.rgb.split(',').map(Number);
  if (imgs[r] || imgs[gch] || imgs[b]) mk('RGB', `R=D${r} G=D${gch} B=D${b}`, paintRGB([imgs[r], imgs[gch], imgs[b]], wcs.npix, S.hi, S.stretch), 0, false);
  $('#caption').innerHTML = `<b>All bands</b> · ${ep === 'all' ? 'all epochs co-added' : 'epoch ' + ep} · ${S.median ? 'median' : 'mean'} per detector, own scale per tile<span class="sub">Click a tile to select that detector for the other modes. Each detector sees a different wavelength range, so the same star looks different in each.</span>`;
  $('#meta-body').innerHTML = '<span class="muted">Select Frames or Epoch stacks to inspect individual exposures.</span>'; renderFails();
}

/* ---------------------------------------------------------------- caption / metadata */
function updateCaption(it) {
  let h;
  if (it.kind === 'frame') {
    const f = it.frames[0], n = items.indexOf(it) + 1;
    h = `<b>${fmtDate(f.mjd, f.date_iso)}</b> · MJD ${f.mjd.toFixed(3)} · <span style="color:${DET_COLORS[f.detector]}">●</span> D${f.detector} · λ ${f.wavelength_um?.toFixed(3)} ± ${(f.bandwidth_um / 2)?.toFixed(3)} µm · epoch ${f.epoch}` +
      `<span class="sub">Frame ${n}/${items.length}${S.bg ? ' · median background subtracted' : ''} — brightness changes between frames mix spectral shape with real variability.</span>`;
  } else if (it.kind === 'stack') {
    const w = wlRange(it.frames), ep = it.epoch === 'all' ? 'all epochs' : 'epoch ' + it.epoch;
    h = `<b>${it.track ? 'Tracked ' : ''}${S.median ? 'median' : 'mean'} stack · ${ep}</b> · <span style="color:${DET_COLORS[it.det]}">●</span> D${it.det} · ${it.frames.length} frames · MJD ${Math.min(...it.frames.map((f) => f.mjd)).toFixed(1)}–${Math.max(...it.frames.map((f) => f.mjd)).toFixed(1)}` +
      `<span class="sub">λ ${w ? w[0].toFixed(2) + '–' + w[1].toFixed(2) : '?'} µm across the stack${it.track ? ' · frames shifted to follow the predicted target; background stars smear' : ''}${pmOn() || !it.track ? '' : ' · set proper motion to track'}</span>`;
  } else {
    h = `<b>Difference · D${it.det}</b> · A (${esc(it.A.label)}) − B (${esc(it.B.label)})<span class="sub">A moving object appears as a positive/negative pair. Different wavelengths per epoch leave residuals on spectrally steep stars.</span>`;
  }
  $('#caption').innerHTML = h;
}
const row = (k, v) => `<tr><td>${k}</td><td>${v ?? '—'}</td></tr>`;
function updateMeta(it) {
  let h = '<table>';
  if (it.kind === 'frame') {
    const f = it.frames[0], tf = flagNames(f.target?.flags || 0);
    h += row('obsid', esc(f.obsid)) + row('date', fmtDate(f.mjd, f.date_iso)) + row('MJD', f.mjd.toFixed(4)) + row('detector', 'D' + f.detector) +
      row('wavelength', `${f.wavelength_um?.toFixed(4)} ± ${(f.bandwidth_um / 2)?.toFixed(4)} µm (centre)`) + row('gradient', `${f.dwave_dx?.toExponential(2)}, ${f.dwave_dy?.toExponential(2)} µm/px`) +
      row('exposure', f.exptime != null ? f.exptime + ' s' : null) + row('PSF FWHM', f.psf_fwhm_arcsec != null ? f.psf_fwhm_arcsec.toFixed(2) + '″' : null) +
      row('quality (DQA)', esc(f.dqa)) + row('release / version', `${esc(f.release)} / ${esc(f.version)}`) + row('valid pixels', f.frac_valid != null ? (f.frac_valid * 100).toFixed(1) + ' %' : null) +
      row('background', f.bkg_median != null ? f.bkg_median.toPrecision(4) + ' MJy/sr' : null) + row('noise (σ)', f.noise != null ? f.noise.toPrecision(3) + ' MJy/sr' : null) +
      row('flags at target', tf.length ? esc(tf.join(', ')) : 'none') + row('zodi median', f.zodi_median?.toPrecision?.(4)) + row('epoch', f.epoch) +
      row('links', [f.cutout_url && `<a href="${esc(f.cutout_url)}" target="_blank" rel="noopener">cutout</a>`, f.file_url && `<a href="${esc(f.file_url)}" target="_blank" rel="noopener">full FITS</a>`].filter(Boolean).join(' · ') || null);
  } else {
    const fs = it.frames; h += row('type', it.kind === 'diff' ? 'difference image' : 'co-add') + row('detector', 'D' + it.det) + row('frames', fs.length) +
      row('MJD range', `${Math.min(...fs.map((f) => f.mjd)).toFixed(2)} – ${Math.max(...fs.map((f) => f.mjd)).toFixed(2)}`) +
      row('median noise', fmtNum(fs.reduce((s, f) => s + (f.noise || 0), 0) / fs.length) + ' MJy/sr (per frame)') +
      row('obsids', fs.slice(0, 4).map((f) => esc(f.obsid)).join(', ') + (fs.length > 4 ? ` … +${fs.length - 4}` : ''));
  }
  $('#meta-body').innerHTML = h + '</table>'; renderFails();
}
function renderFails() {
  if (!store.failed.length) return;
  $('#meta-body').insertAdjacentHTML('beforeend', `<details class="fails"><summary>${store.failed.length} failed frame(s)</summary><ul>${store.failed.map((f) => `<li>D${f.detector} · MJD ${f.mjd?.toFixed?.(2) ?? '?'} · ${esc(f.id)}: ${esc(f.error)}</li>`).join('')}</ul></details>`);
}

/* ---------------------------------------------------------------- chips / mode options */
function buildChips() {
  const box = $('#chips'); box.innerHTML = '';
  const multi = S.mode === 'frames', cur = sdet();
  for (let d = 1; d <= 6; d++) {
    const tot = meta?.by_detector?.[d] ?? meta?.by_detector?.[String(d)] ?? 0, got = store.count(d);
    const on = multi ? S.det.includes(d) : d === cur;
    const b = document.createElement('button'); b.className = 'chip'; b.type = 'button'; b.style.setProperty('--c', DET_COLORS[d]);
    b.setAttribute('aria-pressed', String(on));
    b.title = `Detector ${d}: ${BANDS[d].lo}–${BANDS[d].hi} µm · ${got} loaded of ${tot} available`;
    b.innerHTML = `<i></i>D${d} <small>${BANDS[d].lo}–${BANDS[d].hi}µm · ${got}${tot > got ? '/' + tot : ''}</small>`;
    b.onclick = () => {
      if (multi) { const s = S.det.includes(d) ? S.det.filter((x) => x !== d) : [...S.det, d].sort(); if (!s.length) return; set({ det: s }); }
      else set({ sdet: d });
      rebuild(); updateNarrow();
    };
    box.appendChild(b);
  }
}
function epochOptions(sel, d, withFrames) {
  const eps = [...new Set(store.frames.filter((f) => f.detector === d).map((f) => f.epoch))].sort((a, b) => a - b);
  let h = '<optgroup label="Epoch stacks">' + eps.map((e) => { const r = store.epochRanges().find((x) => x.n === e); return `<option value="e:${e}">epoch ${e}${r ? ` (MJD ${r.lo.toFixed(0)})` : ''}</option>`; }).join('') + '</optgroup>';
  if (withFrames) h += '<optgroup label="Single frames">' + store.frames.filter((f) => f.detector === d).map((f) => `<option value="f:${esc(f.id)}">frame MJD ${f.mjd.toFixed(2)} · λ${f.wavelength_um?.toFixed(2)}</option>`).join('') + '</optgroup>';
  sel.innerHTML = h;
}
function buildModeOpts() {
  const box = $('#modeopts'); box.innerHTML = '';
  if (!store.frames.length) return;
  if (S.mode === 'diff') {
    const { d, A, B } = diffSources();
    box.innerHTML = `<label>A <select id="m-a"></select></label><span>−</span><label>B <select id="m-b"></select></label><span>detector D${d} (chips above)</span>`;
    const a = $('#m-a'), b = $('#m-b'); epochOptions(a, d, true); epochOptions(b, d, true); a.value = A; b.value = B;
    a.onchange = () => { set({ ea: a.value }); rebuild(); }; b.onchange = () => { set({ eb: b.value }); rebuild(); };
  } else if (S.mode === 'strip') {
    const eps = [...new Set(store.frames.map((f) => f.epoch))].sort((a, b) => a - b);
    const dets = [1, 2, 3, 4, 5, 6], sel = (id, v) => `<select id="${id}">${dets.map((d) => `<option value="${d}" ${d == v ? 'selected' : ''}>D${d}</option>`).join('')}</select>`;
    const [r, g, b] = S.rgb.split(',').map(Number);
    box.innerHTML = `<label>Epoch <select id="m-ep"><option value="all">all (co-added)</option>${eps.map((e) => `<option value="${e}">epoch ${e}</option>`).join('')}</select></label><span>RGB composite:</span><label>R ${sel('m-r', r)}</label><label>G ${sel('m-g', g)}</label><label>B ${sel('m-b2', b)}</label>`;
    $('#m-ep').value = String(S.estack);
    $('#m-ep').onchange = (e) => { set({ estack: e.target.value }); requestDraw(); };
    const upd = () => { set({ rgb: [$('#m-r').value, $('#m-g').value, $('#m-b2').value].join(',') }); requestDraw(); };
    ['#m-r', '#m-g', '#m-b2'].forEach((s) => ($(s).onchange = upd));
  } else if (S.mode === 'epochs' || S.mode === 'track') {
    box.innerHTML = `<span>Detector D${sdet()} · ${items.length} ${S.mode === 'track' ? 'tracked stacks' : 'epochs'}; choose another detector with the chips.${S.mode === 'track' && !pmOn() ? ' <b style="color:var(--accent)">Set proper motion (Position &amp; proper motion) to track a mover.</b>' : ''}</span>`;
  } else box.innerHTML = `<span>${items.length} frames from ${S.det.length} detector(s), in time order. Epoch boundaries are marked under the scrubber.</span>`;
}

/* ---------------------------------------------------------------- scrubber / player */
function updateScrubber() {
  const sc = $('#scrub'); sc.max = Math.max(0, items.length - 1); sc.value = idx; sc.disabled = items.length < 2;
  drawTicks(); updateScrubUI();
}
function updateScrubUI() {
  $('#scrub').value = idx; $('#p-pos').textContent = `${items.length ? idx + 1 : 0} / ${items.length}`;
  const p = $('#p-play'); p.textContent = playing ? '⏸' : '▶'; p.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  drawTicks();
}
function drawTicks() {
  const cv = $('#ticks'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const n = items.length; if (!n) return;
  let prevEp = null;
  items.forEach((it, i) => {
    const x = Math.round(((i + 0.5) / n) * W) + 0.5, ep = it.epoch;
    if (prevEp !== null && ep !== prevEp) { g.strokeStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.moveTo(x - 0.5 - W / n / 2, 0); g.lineTo(x - 0.5 - W / n / 2, H); g.stroke(); }
    prevEp = ep;
    g.strokeStyle = DET_COLORS[it.det] || '#aaa'; g.globalAlpha = i === idx ? 1 : (it.id && it.id === hoverId ? 1 : 0.7);
    g.lineWidth = i === idx || it.id === hoverId ? 3 : 1; g.beginPath(); g.moveTo(x, i === idx ? 0 : H * 0.35); g.lineTo(x, H); g.stroke();
  });
  g.globalAlpha = 1;
}
function go(i) { if (!items.length) return; idx = ((i % items.length) + items.length) % items.length; set({ frame: idx || null }); requestDraw(); }
function haltPlayback() { if (playRaf != null) cancelAnimationFrame(playRaf); playRaf = null; playing = false; }
function setPlaying(p) {
  haltPlayback(); playing = p && items.length > 1;
  if (playing) { lastT = performance.now(); acc = 0; dir = 1; playRaf = requestAnimationFrame(tick); }
  updateScrubUI(); set({ play: playing });
}
function tick(t) {
  playRaf = null;
  if (!playing) return;
  acc += t - lastT; lastT = t; const dt = 1000 / S.speed;
  if (acc >= dt) {
    acc %= dt; let n = idx + dir;
    if (S.loop === 'bounce') { if (n >= items.length) { dir = -1; n = items.length - 2; } else if (n < 0) { dir = 1; n = 1; } }
    else if (n >= items.length) { if (S.loop === 'once') { n = items.length - 1; playing = false; set({ play: false }); } else n = 0; }
    idx = Math.max(0, Math.min(items.length - 1, n)); requestDraw();
  }
  if (playing) playRaf = requestAnimationFrame(tick); else updateScrubUI();
}

/* ---------------------------------------------------------------- pointer / HUD */
function setupPointer() {
  const cv = $('#main'), hud = $('#hud'), tip = $('#skytip');
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); const [x, y] = pos(e); drag = { x, y, vx: view.vx, vy: view.vy, moved: false }; });
  cv.addEventListener('pointermove', (e) => {
    const [sx, sy] = pos(e);
    if (drag) { const dx = sx - drag.x, dy = sy - drag.y; if (Math.hypot(dx, dy) > 4) drag.moved = true; if (drag.moved && view.zoom > 1) { view.vx = drag.vx - dx / geom.k; view.vy = drag.vy - dy / geom.k; requestDraw(); } }
    readout(sx, sy, hud, tip);
  });
  cv.addEventListener('pointerup', (e) => {
    const [sx, sy] = pos(e), d = drag; drag = null;
    if (d && !d.moved) clickAt(sx, sy);
  });
  cv.addEventListener('pointerleave', () => { hud.textContent = ''; tip.hidden = true; });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.25 : 0.8, ...pos(e)); }, { passive: false });
}
function zoomBy(f, sx = geom.side / 2, sy = geom.side / 2) {
  if (!wcs) return;
  const [ix, iy] = toImg(sx, sy); view.zoom = Math.max(1, Math.min(24, view.zoom * f));
  geom.k = (geom.side / wcs.npix) * view.zoom; view.vx = ix - (sx - geom.side / 2) / geom.k; view.vy = iy - (sy - geom.side / 2) / geom.k;
  if (view.zoom === 1) { view.vx = view.vy = wcs.c; } requestDraw();
}
function readout(sx, sy, hud, tip) {
  const it = curItem(); if (!it || !wcs) return;
  const [x, y] = toImg(sx, sy), ix = Math.round(x), iy = Math.round(y), n = wcs.npix;
  if (ix < 0 || iy < 0 || ix >= n || iy >= n) { hud.textContent = ''; return; }
  const data = it.get(), v = data.img[iy * n + ix], sky = wcs.toSky(x, y), fl = data.flags[iy * n + ix];
  let wl = '';
  if (it.kind === 'frame') { const f = it.frames[0]; if (f.wavelength_um != null) wl = ` · λ ${(f.wavelength_um + (f.dwave_dx || 0) * (ix - wcs.c) + (f.dwave_dy || 0) * (iy - wcs.c)).toFixed(4)} µm`; }
  const names = flagNames(fl);
  hud.textContent = `${fmtRA(sky.ra)} ${fmtDec(sky.dec)} · px (${ix},${iy}) · ${v === v ? v.toPrecision(4) : 'no data'} MJy/sr${wl}${names.length ? ' · ' + names.join(',') : ''}`;
  const near = nearestCat(sx, sy);
  if (near) {
    const s = near.s; tip.hidden = false;
    tip.innerHTML = `<b>${near.cat === 'gaia' ? 'Gaia DR3' : 'CatWISE'}</b> ${esc(s.id)} <span class="muted">(click for details)</span><br>${near.cat === 'gaia' ? 'G' : 'W2'} = ${s.mag != null ? (+s.mag).toFixed(2) : '—'} · pm (${s.pmra != null ? (+s.pmra).toFixed(1) : '—'}, ${s.pmdec != null ? (+s.pmdec).toFixed(1) : '—'}) mas/yr${s.plx != null ? ' · plx ' + (+s.plx).toFixed(2) + ' mas' : ''}`;
    tip.style.left = Math.min(geom.side - 220, near.sx + 12) + 'px'; tip.style.top = Math.max(4, near.sy - 44) + 'px';
  } else tip.hidden = true;
}
let picked = null;
// Fast movers are always drawn. CatWISE proper motions of faint sources are noisy (hundreds of
// mas/yr), so CatWISE needs a higher threshold and a brightness floor.
const fastMover = (s, cat) => { const pm = Math.hypot(s.pmra || 0, s.pmdec || 0); return cat === 'gaia' ? pm >= 100 : pm >= 1000 && s.mag != null && s.mag <= 16.5; };
const CAT_DEPTH = { bright: { gaia: 15, catwise: 13 }, mid: { gaia: 17, catwise: 15 }, faint: { gaia: 19, catwise: 16 }, all: { gaia: Infinity, catwise: Infinity } };
function nearestCat(sx, sy, maxPx = 10) {
  let near = null, bd = maxPx * maxPx;
  for (const c of lastCat) { const d = (c.sx - sx) ** 2 + (c.sy - sy) ** 2; if (d < bd) { bd = d; near = c; } }
  return near;
}
function showPick(c, it) {
  picked = c ? c.s : null; const box = $('#o-pick');
  if (!c) { box.innerHTML = ''; requestDraw(); return; }
  const s = c.s, g = c.cat === 'gaia', ep = s.epoch ?? (g ? 2016 : 2015.4), yr = mjdToYear(it.mjd), p = propagate(s.ra, s.dec, s.pmra, s.pmdec, ep, yr);
  const tot = s.pmra != null && s.pmdec != null ? Math.hypot(s.pmra, s.pmdec) : null, f = (v, d = 1) => (v != null ? (+v).toFixed(d) : '—');
  box.innerHTML = `<b>${g ? 'Gaia DR3' : 'CatWISE2020'}</b> ${esc(s.id)}<table>` +
    row(g ? 'G mag' : 'W2 mag', f(s.mag, 2)) + row('pm RA*, Dec', `${f(s.pmra)}, ${f(s.pmdec)} mas/yr`) + row('total pm', tot != null ? `${tot.toFixed(1)} mas/yr (${(tot / 1000 / wcs.scale).toFixed(2)} px/yr)` : null) +
    (g ? row('parallax', s.plx != null ? f(s.plx, 2) + ' mas' : null) : '') + row('catalogue position', `${fmtRA(s.ra)} ${fmtDec(s.dec)} (epoch ${(+ep).toFixed(2)})`) +
    row('at this frame', `${fmtRA(p.ra)} ${fmtDec(p.dec)} (${yr.toFixed(2)})`) + '</table>' +
    `<button type="button" id="pick-measure">Spectrum &amp; light curve of this source</button> <button type="button" id="pick-close" aria-label="Close">✕</button>`;
  $('#pick-measure').onclick = () => { measure({ ra: s.ra, dec: s.dec }, 'source', { pmra: s.pmra ?? 0, pmdec: s.pmdec ?? 0, epoch: +ep, label: `${g ? 'Gaia DR3' : 'CatWISE'} ${s.id}` }); $('#charts').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
  $('#pick-close').onclick = () => showPick(null);
  requestDraw();
}
function clickAt(sx, sy) {
  const it = curItem(); if (!it || !wcs) return;
  const c = nearestCat(sx, sy); if (c) { showPick(c, it); return; }
  const [x, y] = toImg(sx, sy);
  for (const m of markersFor(it)) { if (Math.hypot(m.x - x, m.y - y) * geom.k < 14) { return measure(null, 'target'); } }
  const s = wcs.toSky(x, y); measure(s, 'click');
}

/* ---------------------------------------------------------------- loading */
function showSearching(msg) { say('', `<span>${msg}</span>`); }
async function doSearch(text, preset) {
  text = (text || '').trim(); if (!text) return; posNote = '';
  abortAll(); showSearching(`Resolving “${esc(text)}”…`); showEmpty('Resolving…');
  const ctl = new AbortController(); loadCtl = ctl;
  try {
    let r = await api.resolve(text, ctl.signal);
    if (r.source === 'coordinates') {
      const p = makeWcs(WISE_CHALLENGE.ra, WISE_CHALLENGE.dec, 1, 1).toPix(r.ra, r.dec);
      if (p && Math.hypot(p.x, p.y) < 1) {
        const originalName = r.name || text;
        try { r = await api.resolve(PRESETS[2].q, ctl.signal); }
        catch (e) { if (e.name === 'AbortError') throw e; r = { ...WISE_FALLBACK }; }
        if (r.pmra == null || r.pmdec == null) r = { ...r, ...WISE_FALLBACK };
        r.name = originalName;
        posNote = 'Recognised the WISE 0855 challenge coordinates (an earlier WISE position); using its J2000 catalogue position and proper motion. ';
      }
    }
    let pmra = r.pmra, pmdec = r.pmdec, epoch = r.epoch;
    if ((pmra == null || pmdec == null) && preset?.pmDefault) ({ pmra, pmdec, epoch } = preset.pmDefault);
    if (pmra != null && pmdec != null && epoch == null) epoch = 2000;
    set({ ra: r.ra, dec: r.dec, q: preset ? preset.label : (r.name || text), pmra: pmra ?? null, pmdec: pmdec ?? null, epoch: epoch ?? null, mjd_min: null, mjd_max: null, ea: null, eb: null, frame: null });
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (preset?.fallback) {
      const fb = preset.fallback, pd = preset.pmDefault || {};
      set({ ra: fb.ra, dec: fb.dec, q: preset.label, pmra: fb.pmra ?? pd.pmra ?? null, pmdec: fb.pmdec ?? pd.pmdec ?? null, epoch: fb.epoch ?? pd.epoch ?? null, mjd_min: null, mjd_max: null, ea: null, eb: null, frame: null });
    } else {
      say('err', `<b>Could not resolve “${esc(text)}”.</b> <span>${esc(e.message)} — try coordinates such as “133.795 -7.245” or “08h55m10.8s -07d14m42s”.</span>`);
      showEmpty('Nothing to show yet.'); return;
    }
  }
  syncFields(); loadField();
}
function abortAll() {
  loadId++; haltPlayback(); clearTimeout(rebuildTimer); rebuildTimer = null;
  stopProgress(); loadCtl?.abort(); specCtl?.abort(); loadCtl = null; loading = false;
  updateScrubUI();
}
function syncFields() {
  $('#q').value = S.q || ''; $('#fov').value = String(S.fov);
  if (![...$('#fov').options].some((o) => +o.value === S.fov)) $('#fov').insertAdjacentHTML('beforeend', `<option value="${S.fov}">${S.fov}°</option>`), ($('#fov').value = String(S.fov));
  const v = (x) => (x == null ? '' : x);
  $('#f-ra').value = v(S.ra); $('#f-dec').value = v(S.dec); $('#f-pmra').value = v(S.pmra); $('#f-pmdec').value = v(S.pmdec); $('#f-epoch').value = v(S.epoch);
  $('#f-cap').value = String(S.cap); $('#f-marker').checked = S.marker;
  $('#d-stretch').value = S.stretch; $('#d-hi').value = String(S.hi); $('#d-cmap').value = S.cmap; $('#d-interp').value = S.smooth ? '1' : '0';
  $('#d-lock').checked = S.lock; $('#d-bg').checked = S.bg; $('#d-median').checked = S.median; $('#d-ignore').checked = S.ignoreflag; $('#d-flags').checked = S.flags;
  $('#o-depth').value = S.catdepth; $('#o-gaia').checked = S.gaia; $('#o-catwise').checked = S.catwise; $('#p-speed').value = String(S.speed); $('#p-loop').value = S.loop;
  $('#fovwarn').hidden = S.fov < 0.3;
}
function readFields() {
  posNote = '';
  const n = (id) => { const v = parseFloat($(id).value); return isFinite(v) ? v : null; };
  const pmra = n('#f-pmra'), pmdec = n('#f-pmdec');
  set({ ra: n('#f-ra'), dec: n('#f-dec'), pmra, pmdec, epoch: n('#f-epoch') ?? (pmra != null || pmdec != null ? 2000 : null), cap: +$('#f-cap').value, fov: +$('#fov').value });
}
function loadEstimate() {
  if (!meta) return 0;
  return meta.frames.filter((f) => S.det.includes(f.detector) && (S.mjd_min == null || f.mjd >= S.mjd_min) && (S.mjd_max == null || f.mjd <= S.mjd_max)).length;
}

async function loadField() {
  if (S.ra == null || S.dec == null || !isFinite(S.ra) || !isFinite(S.dec)) { say('err', 'Enter a valid RA and Dec.'); return; }
  // Canonical 7-decimal position, identical to what the URL carries, so a shared link requests
  // exactly the same field (the backend cutout cache is keyed by the exact centre).
  normalizeEpoch(); set({ ra: +S.ra.toFixed(7), dec: +S.dec.toFixed(7) }); $('#f-note').textContent = pmOn() ? (posNote || `RA/Dec are at epoch ${S.epoch}; the marker follows the proper motion.`) : '';
  abortAll(); const ctl = new AbortController(); loadCtl = ctl; const mine = ++loadId, sig = ctl.signal;
  store.reset(); cache.clear(); paintCache.clear(); items = []; idx = 0; wcs = null; startInfo = null; meta = null; catalogs = {}; measured = null; view = { zoom: 1, vx: 0, vy: 0 };
  hoverId = null; specChart?.setMessage('Not measured yet'); lcChart?.setMessage('Not measured yet'); $('#ch-csv').disabled = true; $('#ch-table').innerHTML = '';
  $('#ch-where').textContent = 'Click the image (or the button) to measure.'; $('#ch-note').textContent = ''; picked = null; $('#o-pick').innerHTML = '';
  $('#canvas-wrap')?.remove(); buildChips(); updateScrubber(); $('#modeopts').innerHTML = ''; $('#caption').innerHTML = ''; $('#main').hidden = true; $('#strip').hidden = true;
  $('#meta-body').textContent = 'Loading…'; $('#flaglist').textContent = 'Flag legend appears once data arrive.';
  $('#timeline-card').hidden = false; $('#tl-sum').textContent = 'Checking what exists…'; drawTimeline($('#timeline'), [], [], new Set(), S.det, null, 'Waiting for the exposure list from IRSA…');
  showEmpty('Checking which exposures cover this position…'); syncFields();
  startProgress('frames', ctl);
  showContextPanel();
  try { meta = await api.getFrames(S.ra, S.dec, sig); } catch (e) { if (mine !== loadId) return; stopProgress(); if (sig.aborted) { say('', 'Cancelled.'); showEmpty('Cancelled.'); return; } say('err', `<b>Could not list exposures.</b> ${esc(e.message)}`); showEmpty('Backend error — see message above.'); return; }
  if (mine !== loadId) return;
  store.setMeta(meta.frames); buildChips(); updateTimeline();
  if (!meta.count) { stopProgress(); say('warn', '<b>No SPHEREx exposures at this position.</b> <span>The archive returned no exposures; try another target or check the coordinates.</span>'); showEmpty('No exposures here.'); $('#tl-sum').textContent = '0 exposures'; $('#meta-body').textContent = 'No frames.'; return; }
  if (!S.sdet) { let best = 1, bc = -1; for (const [d, c] of Object.entries(meta.by_detector || {})) if (c > bc) { bc = c; best = +d; } S.sdet = best; }
  loadParams = { ra: S.ra, dec: S.dec, fov: S.fov, scale: 6.15, detectors: S.det.join(','), mjd_min: S.mjd_min, mjd_max: S.mjd_max, max_frames: S.cap };
  if (pmOn()) Object.assign(loadParams, { pmra: S.pmra, pmdec: S.pmdec, epoch: S.epoch ?? 2000 });
  showEmpty('Requesting pixels from the archive…'); loading = true; updateNarrow();
  startProgress('pixels', ctl);
  const t0 = performance.now(); let first = true, stopped = false;
  try {
    await api.streamFrames(loadParams, {
      signal: sig,
      onStart: (m) => { if (mine !== loadId) return; startInfo = m; wcs = makeWcs(m.ra, m.dec, m.scale_arcsec, m.npix); view = { zoom: 1, vx: wcs.c, vy: wcs.c }; prog.want = m.selected; buildFlagLegend(); updateNarrow(); showContextPanel(); renderProgress(); },
      onFrame: (m, img, fl) => {
        if (mine !== loadId) return;
        const f = store.add(m, img, fl);
        if (f) { prog.got++; prog.lastFrame = performance.now(); } else prog.failed++;
        renderProgress();
        if (first && f) { first = false; showEmpty(''); rebuild(); } else scheduleRebuild();
      },
      onProgress: (m) => { if (mine !== loadId || !prog) return; prog.retries = m.upstream_retries || 0; prog.downloaded = m.downloaded || 0; renderProgress(); },
      onEnd: () => {},
    });
  } catch (e) {
    if (mine !== loadId) return;
    stopped = !!prog?.userStop; stopProgress(); loading = false;
    if (!stopped) {
      say('err', `<b>Loading stopped.</b> ${esc(e.message)}${store.frames.length ? ' Showing the frames that arrived.' : ''} <button type="button" class="st-retry">Try again</button>`);
      store.relabelEpochs(); cache.clear(); paintCache.clear(); rebuild(); updateNarrow();
      if (!store.frames.length) showEmpty('No frames could be loaded.');
      return;
    }
  }
  if (mine !== loadId) return;
  stopProgress();
  // A stopped stream can still be explored, including new catalogue requests.
  if (sig.aborted) loadCtl = new AbortController();
  loading = false; store.relabelEpochs(); cache.clear(); paintCache.clear(); rebuild();
  if (!stopped && startInfo?.selected === 0) {
    say('warn', '<b>No exposures match the selected detectors and dates.</b> Choose another detector or clear the date selection.');
    showEmpty('No matching exposures.'); $('#meta-body').textContent = 'No frames match this selection.';
    updateNarrow(); return;
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const trunc = startInfo && startInfo.total_available > startInfo.selected, nf = store.failed.length;
  const failTxt = nf ? ` <b>${nf} frame${nf > 1 ? 's' : ''} failed</b> after repeated retries (listed under Frame details). <button type="button" class="st-retry">Retry failed frames</button>` : '';
  say(trunc || nf || stopped ? 'warn' : '', `<span>${stopped ? 'Stopped: kept' : 'Loaded'} <b>${store.frames.length}</b>${stopped && startInfo ? ` of ${startInfo.selected}` : ''} frames in ${secs} s.${failTxt}${trunc ? ` The field has ${startInfo.total_available} matching frames; ${startInfo.selected} were selected (thinned evenly in time per detector). Narrow by epoch or detector below, or load more.` : ''}</span>`);
  if (!store.frames.length) { showEmpty(stopped ? 'Stopped before any frame arrived.' : 'No frames could be loaded.'); $('#meta-body').textContent = 'No frames loaded.'; renderFails(); updateNarrow(); return; }
  updateNarrow();
  if (S.frame != null && S.mode !== 'strip') go(Math.min(items.length - 1, S.frame));
  if (S.play && !stopped && !matchMedia('(prefers-reduced-motion: reduce)').matches) setPlaying(true);
  if (S.gaia) ensureCatalog('gaia'); if (S.catwise) ensureCatalog('catwise');
  if (!S.embed && !stopped) measure(null, 'target');
  else if (stopped) $('#ch-where').textContent = 'Load stopped. Measure at target requests photometry for the full detector/date selection.';
}

/* progress / waiting feedback (IRSA can be slow and answers many requests with 503) */
let prog = null, progTimer = null;
function startProgress(phase, ctl) {
  clearInterval(progTimer);
  const now = performance.now();
  prog = { phase, ctl, t0: now, lastFrame: now, got: 0, failed: 0, want: 0, retries: 0, downloaded: 0, userStop: false };
  $('#status').innerHTML = ''; progTimer = setInterval(renderProgress, 1000); renderProgress();
}
function stopProgress() { clearInterval(progTimer); progTimer = null; prog = null; }
const fmtSecs = (s) => (s < 90 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`);
function renderProgress() {
  if (!prog) return;
  let box = $('#prog');
  if (!box) {
    $('#status').innerHTML = '<div class="msg" id="prog"><span class="spin" aria-hidden="true"></span><span id="prog-main"></span> <button type="button" id="prog-stop"></button><div class="bar"><i id="prog-bar"></i></div><div id="prog-sub" class="sub"></div></div>';
    box = $('#prog');
    $('#prog-stop').onclick = () => { if (!prog) return; prog.userStop = true; prog.ctl.abort(); };
  }
  const now = performance.now(), el = (now - prog.t0) / 1000;
  let main, sub = '', pct = 0, stop;
  if (prog.phase === 'frames') {
    main = `Asking the IRSA archive which SPHEREx exposures cover this position… <b>${fmtSecs(el)}</b>`;
    sub = el > 6 ? 'The exposure query often takes 5–50 s, and can take several minutes when IRSA is slow. Still waiting; you can cancel or search for another target.' : '';
    stop = 'Cancel';
  } else {
    const done = prog.got + prog.failed, want = prog.want || 0, stall = (now - prog.lastFrame) / 1000;
    pct = want ? (done / want) * 100 : 0;
    main = `Loading pixels… <b>${prog.got}</b> / ${want || '?'} frames${prog.failed ? ` · <b class="bad">${prog.failed} failed</b>` : ''} · ${fmtSecs(el)}`;
    if (done >= 8 && want > done) { const rate = done / el; main += ` · about ${fmtSecs((want - done) / rate)} left`; }
    const slow = stall > 6 || prog.retries > 0;
    if (slow) sub = `The archive is answering slowly${prog.retries ? ` (${prog.retries} request${prog.retries > 1 ? 's' : ''} retried so far)` : ''}${stall > 6 ? `; last frame arrived ${Math.round(stall)} s ago` : ''}. Retries are automatic. `;
    if (prog.got) sub += 'Frames that have arrived can already be viewed and played.';
    else if (el > 4) sub += 'The first view downloads cutouts from the archive and can take several minutes; cached repeat views are faster.';
    stop = prog.got ? `Stop and keep ${prog.got}` : 'Cancel';
    if (!prog.got) showEmpty(`Waiting for the first frame… ${fmtSecs(el)}${slow ? '<br><small>The archive is slow right now; retrying automatically.</small>' : ''}`);
  }
  $('#prog-main').innerHTML = main; $('#prog-sub').innerHTML = sub; $('#prog-bar').style.width = Math.min(100, pct) + '%';
  $('#prog-bar').parentElement.classList.toggle('indeterminate', prog.phase === 'frames');
  if ($('#prog-stop').textContent !== stop) $('#prog-stop').textContent = stop;
}

function updateNarrow() {
  const box = $('#narrow'); if (!meta || !meta.count) { box.hidden = true; return; }
  const est = loadEstimate(), selDets = S.det.join(','), loadedDets = loadParams?.detectors || '';
  const eps = store.epochRanges();
  box.hidden = false;
  const capNote = est > S.cap ? `<b style="color:var(--accent)">${est} frames match but the cap is ${S.cap}</b>; frames are thinned evenly in time.` : `${est} frames match the current selection.`;
  box.innerHTML = `<span>${capNote}</span>` +
    `<label class="inline">Epoch <select id="n-ep"><option value="">all</option>${eps.map((e) => `<option value="${e.n}">${e.n} (MJD ${e.lo.toFixed(0)}–${e.hi.toFixed(0)})</option>`).join('')}</select></label>` +
    (selDets !== loadedDets && !loading ? `<button id="n-det">Reload with detectors D${S.det.join(',')} only</button>` : '') +
    (est > S.cap && !loading ? `<button id="n-more">Load up to ${Math.min(3000, Math.max(S.cap * 2, 800))} frames</button>` : '');
  const sel = $('#n-ep'); const cur = eps.find((e) => S.mjd_min != null && Math.abs(e.lo - 1 - S.mjd_min) < 2 || (S.mjd_min != null && S.mjd_min <= e.lo && S.mjd_max >= e.hi));
  if (cur && S.mjd_min != null) sel.value = String(cur.n);
  sel.onchange = () => { const e = eps.find((x) => x.n === +sel.value); set(e ? { mjd_min: e.lo - 1, mjd_max: e.hi + 1, frame: null } : { mjd_min: null, mjd_max: null, frame: null }); loadField(); };
  $('#n-det') && ($('#n-det').onclick = () => { set({ frame: null }); loadField(); });
  $('#n-more') && ($('#n-more').onclick = () => { set({ cap: Math.min(3000, Math.max(S.cap * 2, 800)), frame: null }); $('#f-cap').value = String(S.cap); loadField(); });
}
function updateTimeline() {
  if (!meta) return;
  $('#tl-sum').textContent = `${meta.count} exposures · ${store.epochRanges().length} epochs · ${store.frames.length} loaded`;
  drawTimeline($('#timeline'), meta.frames, store.epochRanges(), new Set(store.frames.map((f) => f.id)), S.det);
}
function buildFlagLegend() {
  const fb = startInfo?.flag_bits || {}, box = $('#flaglist'); box.innerHTML = '';
  const bits = S.flagbits ?? Object.values(fb);
  Object.entries(fb).sort((a, b) => a[1] - b[1]).forEach(([name, b]) => {
    const l = document.createElement('label'), c = document.createElement('input'); c.type = 'checkbox'; c.checked = bits.includes(b);
    c.onchange = () => { const cur = new Set(S.flagbits ?? Object.values(fb)); c.checked ? cur.add(b) : cur.delete(b); set({ flagbits: [...cur].sort((x, y) => x - y) }); cache.clear(); paintCache.clear(); requestDraw(); };
    l.append(c, document.createTextNode(` bit ${b} ${name}`)); box.appendChild(l);
  });
  if (!Object.keys(fb).length) box.textContent = 'No flag definitions supplied.';
}

/* ---------------------------------------------------------------- catalogs */
async function ensureCatalog(cat) {
  if (!wcs || catalogs[cat]?.sources || catalogs[cat]?.busy) return;
  const mine = loadId;
  catalogs[cat] = { busy: true }; $('#o-status').textContent = `Fetching ${cat}…`;
  try {
    const r = await api.getCatalog(cat, wcs.ra0, wcs.dec0, Math.min(0.5, S.fov * 0.75), loadCtl?.signal);
    if (mine !== loadId) return;
    catalogs[cat] = { sources: r.sources || [] };
    $('#o-status').textContent = `${cat === 'gaia' ? 'Gaia' : 'CatWISE'}: ${catalogs[cat].sources.length} sources in the field.`;
  } catch (e) { if (e.name === 'AbortError' || mine !== loadId) return; catalogs[cat] = { error: e.message }; $('#o-status').textContent = `${cat}: ${e.message}`; }
  requestDraw();
}

/* ---------------------------------------------------------------- spectrum / light curve */
async function measure(skyPos, kind, motion) {
  if (!wcs || !loadParams) return;
  specCtl?.abort(); specCtl = new AbortController(); const sig = specCtl.signal;
  const isTarget = kind === 'target' || !skyPos, pos = isTarget ? { ra: S.ra, dec: S.dec } : skyPos;
  const p = { ...loadParams, fov: startInfo.fov, pos_ra: pos.ra, pos_dec: pos.dec, aper: 2.0 };
  delete p.scale;
  if (!isTarget) { delete p.pmra; delete p.pmdec; delete p.epoch; }
  if (motion) Object.assign(p, { pmra: motion.pmra, pmdec: motion.pmdec, epoch: motion.epoch });
  $('#ch-where').textContent = isTarget ? `Target ${fmtRA(pos.ra)} ${fmtDec(pos.dec)}${pmOn() ? ` (J${S.epoch}, moving with proper motion)` : ''}` : motion ? `${motion.label} (moving with its catalogue proper motion)` : `Fixed position ${fmtRA(pos.ra)} ${fmtDec(pos.dec)}`;
  $('#ch-note').textContent = '';
  const t0 = performance.now(), tickMsg = () => {
    const el = (performance.now() - t0) / 1000;
    specChart.setMessage(`Measuring ${p.max_frames ? 'up to ' + p.max_frames + ' ' : ''}frames… ${Math.round(el)} s`);
    lcChart.setMessage(el > 5 ? 'Measuring on the native pixels; any missing frames are being retried from the archive.' : 'Measuring…');
  };
  tickMsg(); const tm = setInterval(() => { if (sig.aborted) clearInterval(tm); else tickMsg(); }, 1000);
  try {
    const r = await api.getSpectrum(p, sig); clearInterval(tm); if (sig.aborted) return;
    measured = r; renderCharts();
  } catch (e) { clearInterval(tm); if (sig.aborted) return; specChart.setMessage('Spectrum failed: ' + e.message); lcChart.setMessage('Spectrum failed: ' + e.message); measured = null; $('#ch-csv').disabled = true; }
}
// Flags that make a photometry point "bad" in the backend (config.BAD_FLAG_NAMES), in plain words.
const BAD_WHY = {
  OVERFLOW: 'saturated', NONLINEAR: 'non-linear (near saturation)', TRANSIENT: 'transient / cosmic ray', PERSIST: 'persistence from an earlier bright source',
  HOT: 'hot pixel', COLD: 'cold pixel', MISSING_DATA: 'missing data', OUTLIER: 'outlier', SUR_ERROR: 'ramp-fit error', NONFUNC: 'non-functional pixel',
  DICHROIC: 'dichroic artefact', FULLSAMPLE: 'full-sample readout', PHANMISS: 'phantom correction missing', PHANTOM: 'phantom', REFERENCE: 'reference pixel',
};
function flagSummary(pts) {
  const bad = pts.filter((p) => p.bad), counts = new Map();
  let unexplained = 0;
  for (const p of bad) {
    const why = (p.flag_names || []).filter((n) => n in BAD_WHY);
    if (!why.length) unexplained++;
    for (const n of why) counts.set(n, (counts.get(n) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const parts = sorted.slice(0, 2).map(([n, c]) => `${n} (${BAD_WHY[n]})${c === bad.length ? '' : ` in ${c}`}`);
  if (sorted.length > 2) parts.push(`${sorted.length - 2} other flag type${sorted.length > 3 ? 's' : ''}`);
  if (unexplained) parts.push(`no valid measurement in ${unexplained}`);
  const top = sorted[0]?.[0];
  return { n: bad.length, text: parts.join(', '), first: top ? `${top} (${BAD_WHY[top]})` : 'no valid measurement', saturated: counts.has('OVERFLOW') || counts.has('NONLINEAR'),
    all: sorted.map(([n, c]) => `${n} ×${c}`).join(', ') };
}
function pointEpoch(p) { return store.byId.get(p.id)?.epoch ?? store.epochOf(p.mjd); }
function renderCharts() {
  if (!measured) return;
  const showBad = $('#ch-bad').checked, pts = measured.points || [];
  const note = $('#ch-note'), fails = measured.failed ? ` ${measured.failed} frame(s) could not be fetched and are missing.` : '';
  if (!pts.length) { note.textContent = fails.trim(); specChart.setMessage('No measurements returned'); lcChart.setMessage('No measurements returned'); return; }
  const fsum = flagSummary(pts);
  if (fsum.n === pts.length) {
    note.innerHTML = `<b>All ${pts.length} points are flagged: ${esc(fsum.text)}.</b> ${fsum.saturated ? 'The source is too bright for SPHEREx (roughly K &lt; 8 saturates), so these fluxes are unreliable and underestimated.' : 'Treat these fluxes with caution.'} Flagged points are drawn hollow${showBad ? '' : ' — tick “Show flagged points” to see them'}.${fails}`;
    note.title = 'Flags in the aperture: ' + fsum.all;
    if (!showBad) { const m = `All ${pts.length} points flagged: ${fsum.first} — tick “Show flagged points”`; specChart.setMessage(m); lcChart.setMessage(m); $('#ch-csv').disabled = false; $('#ch-table').innerHTML = ''; return; }
  } else if (fsum.n) note.innerHTML = `${fsum.n} of ${pts.length} points flagged: ${esc(fsum.text)}. They are drawn hollow${showBad ? '' : ' and are hidden now'}.${fsum.saturated && fsum.n > pts.length / 2 ? ' Most measurements are flagged and the source is affected by saturation; apparent variability may be instrumental.' : ''}${fails}`;
  else note.textContent = fails.trim();
  const base = (p) => ({ id: p.id, y: p.flux_mjy, err: p.err_mjy, bad: p.bad, hidden: p.bad && !showBad, raw: p, epoch: pointEpoch(p) });
  const ok = (v) => v != null && isFinite(v);
  const nodata = pts.filter((p) => !ok(p.flux_mjy)).length;
  if (nodata) note.insertAdjacentText('beforeend', ` ${nodata} point${nodata > 1 ? 's have' : ' has'} no finite flux and cannot be plotted.`);
  const sp = pts.filter((p) => ok(p.flux_mjy) && ok(p.wavelength_um)).map((p) => { const b = base(p); return { ...b, x: p.wavelength_um, xerr: (p.bandwidth_um || 0) / 2, color: epochColor(b.epoch) }; });
  const lc = pts.filter((p) => ok(p.flux_mjy)).map((p) => { const b = base(p); return { ...b, x: p.mjd, color: DET_COLORS[p.detector] }; });
  specChart.setData(sp, BANDS.slice(1).map((b, i) => ({ x0: b.lo, x1: b.hi, label: 'D' + (i + 1) })));
  lcChart.setData(lc);
  const eps = [...new Set(sp.map((p) => p.epoch))].sort((a, b) => a - b), dets = [...new Set(pts.map((p) => p.detector))].sort();
  $('#lg-epoch').innerHTML = eps.map((e) => `<span style="--c:${epochColor(e)}"><i></i>epoch ${e}</span>`).join('') + '<span class="muted">○ flagged</span>';
  $('#lg-det').innerHTML = dets.map((d) => `<span style="--c:${DET_COLORS[d]}"><i></i>D${d}</span>`).join('') + '<span class="muted">○ flagged</span>';
  $('#ch-csv').disabled = false;
  const rows = pts.filter((p) => showBad || !p.bad).slice(0, 600);
  $('#ch-table').innerHTML = `<table><thead><tr><th>det</th><th>MJD</th><th>λ µm</th><th>flux mJy</th><th>err</th><th>S/N</th><th>flags</th></tr></thead><tbody>${rows.map((p) => `<tr><td>D${p.detector}</td><td>${p.mjd.toFixed(3)}</td><td>${p.wavelength_um?.toFixed(3) ?? '—'}</td><td>${fmtNum(p.flux_mjy)}</td><td>${fmtNum(p.err_mjy)}</td><td>${p.snr != null ? (+p.snr).toFixed(1) : ''}</td><td>${esc((p.flag_names || []).join(' '))}${p.bad ? ' ✗' : ''}</td></tr>`).join('')}</tbody></table>`;
}
const chartOpts = (xLabel, xFmt, tipFn) => ({
  xLabel, yLabel: 'Flux (mJy)', xFmt,
  tooltip: tipFn,
  onHover: (p) => { hoverId = p ? p.id : null; specChart?.highlight(hoverId); lcChart?.highlight(hoverId); requestDraw(); drawTicks(); },
  onClick: (p) => jumpToFrame(p.id),
});
const tipHtml = (p) => { const r = p.raw; return `<b>D${r.detector}</b> · MJD ${r.mjd.toFixed(2)} · epoch ${p.epoch}<br>λ ${r.wavelength_um?.toFixed(3)} µm · ${fmtNum(r.flux_mjy)} ± ${fmtNum(r.err_mjy)} mJy · S/N ${r.snr != null ? (+r.snr).toFixed(1) : '—'}${r.flag_names?.length ? '<br>flags: ' + esc(r.flag_names.join(', ')) : ''}${r.bad ? '<br>flagged bad' : ''}<br><span class="muted">click to jump to this frame</span>`; };
function jumpToFrame(id) {
  const f = store.byId.get(id); if (!f) return;
  setPlaying(false); hoverId = null;
  const patch = { mode: 'frames' }; if (!S.det.includes(f.detector)) patch.det = [...S.det, f.detector].sort();
  set(patch); rebuild(); const i = items.findIndex((x) => x.id === id); if (i >= 0) go(i);
  $('#viewer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function downloadCSV() {
  if (!measured) return;
  const hdr = ['id', 'detector', 'mjd', 'wavelength_um', 'bandwidth_um', 'flux_mjy', 'err_mjy', 'snr', 'flags', 'flag_names', 'bad'];
  const lines = [hdr.join(',')].concat(measured.points.map((p) => [p.id, p.detector, p.mjd, p.wavelength_um, p.bandwidth_um, p.flux_mjy, p.err_mjy, p.snr, p.flags, `"${(p.flag_names || []).join(' ')}"`, p.bad].join(',')));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `spherex_spectrum_${measured.pos_ra.toFixed(5)}_${measured.pos_dec.toFixed(5)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------------------------------------------------------------- context panel */
let ctxShown = null;
function showContextPanel() {
  if (S.embed || S.ra == null) return;
  const key = [S.ra, S.dec, S.fov].join();
  if (ctxShown === key) return; ctxShown = key;
  const h = S.fov / 2, w = makeWcs(S.ra, S.dec, 1, 2 * h * 3600 + 1), c = w.c;
  const corners = [[0, 0], [2 * c, 0], [2 * c, 2 * c], [0, 2 * c]].map(([x, y]) => { const s = w.toSky(x, y); return [s.ra, s.dec]; });
  showContext($('#aladin'), S.ra, S.dec, S.fov, corners, $('#c-survey').value || SURVEYS[0][0]);
}

/* ---------------------------------------------------------------- init & wiring */
function copyText(t, label) {
  const done = () => { $('#copied').textContent = label + ' copied'; setTimeout(() => ($('#copied').textContent = ''), 2500); };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(done, () => { prompt('Copy:', t); });
  else { prompt('Copy:', t); }
}
function wire() {
  $('#presets').innerHTML = PRESETS.map((p, i) => `<button type="button" data-i="${i}">${esc(p.label)}</button>`).join('');
  $('#presets').onclick = (e) => { const b = e.target.closest('button'); if (b) { const p = PRESETS[+b.dataset.i]; $('#q').value = p.q; doSearch(p.q, p); } };
  $('#search').onsubmit = (e) => { e.preventDefault(); set({ fov: +$('#fov').value }); doSearch($('#q').value); };
  $('#fov').onchange = () => { set({ fov: +$('#fov').value }); $('#fovwarn').hidden = S.fov < 0.3; if (S.ra != null && !$('#q').matches(':focus')) loadField(); };
  $('#apply').onclick = () => { readFields(); loadField(); };
  ['#f-pmra', '#f-pmdec', '#f-epoch'].forEach((s) => ($(s).onchange = () => { const n = (id) => { const v = parseFloat($(id).value); return isFinite(v) ? v : null; }; set({ pmra: n('#f-pmra'), pmdec: n('#f-pmdec'), epoch: n('#f-epoch') }); requestDraw(); buildModeOpts(); }));
  $('#f-cap').onchange = () => set({ cap: +$('#f-cap').value });
  $('#f-marker').onchange = (e) => { set({ marker: e.target.checked }); requestDraw(); };
  $('#modes').onclick = (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); };
  const bindSel = (id, key, conv = (v) => v, inval = false) => ($(id).onchange = (e) => { set({ [key]: conv(e.target.value) }); inval ? invalidate() : (paintCache.clear(), requestDraw()); });
  bindSel('#d-stretch', 'stretch'); bindSel('#d-hi', 'hi', Number); bindSel('#d-cmap', 'cmap'); bindSel('#d-interp', 'smooth', (v) => v === '1');
  const bindChk = (id, key, inval) => ($(id).onchange = (e) => { set({ [key]: e.target.checked }); inval ? invalidate() : (paintCache.clear(), requestDraw()); });
  bindChk('#d-lock', 'lock'); bindChk('#d-bg', 'bg', true); bindChk('#d-median', 'median', true); bindChk('#d-ignore', 'ignoreflag', true); bindChk('#d-flags', 'flags');
  $('#o-gaia').onchange = (e) => { set({ gaia: e.target.checked }); if (e.target.checked) ensureCatalog('gaia'); requestDraw(); };
  $('#o-depth').onchange = (e) => { set({ catdepth: e.target.value }); requestDraw(); };
  $('#o-catwise').onchange = (e) => { set({ catwise: e.target.checked }); if (e.target.checked) ensureCatalog('catwise'); requestDraw(); };
  $('#z-in').onclick = () => zoomBy(1.4); $('#z-out').onclick = () => zoomBy(1 / 1.4); $('#z-fit').onclick = () => { view = { zoom: 1, vx: wcs?.c ?? 0, vy: wcs?.c ?? 0 }; requestDraw(); };
  $('#p-play').onclick = () => setPlaying(!playing); $('#p-prev').onclick = () => { setPlaying(false); go(idx - 1); }; $('#p-next').onclick = () => { setPlaying(false); go(idx + 1); };
  $('#scrub').oninput = (e) => { setPlaying(false); go(+e.target.value); };
  $('#p-speed').onchange = (e) => set({ speed: +e.target.value }); $('#p-loop').onchange = (e) => set({ loop: e.target.value });
  $('#status').addEventListener('click', (e) => { if (e.target.closest('.st-retry')) loadField(); });
  $('#copy-link').onclick = () => copyText(linkURL(false), 'Link');
  $('#copy-embed').onclick = () => copyText(`<iframe src="${linkURL(true)}" width="760" height="780" style="border:0" loading="lazy" allowfullscreen title="SPHEREx sky blink"></iframe>`, 'Embed code');
  $('#ch-target').onclick = () => measure(null, 'target'); $('#ch-bad').onchange = renderCharts; $('#ch-csv').onclick = downloadCSV;
  $('#c-survey').innerHTML = SURVEYS.map(([id, l]) => `<option value="${id}">${l}</option>`).join('');
  $('#c-survey').onchange = (e) => { setSurvey(e.target.value); ctxShown = null; showContextPanel(); };
  specChart = new ScatterChart($('#ch-spec'), $('#tip-spec'), chartOpts('Wavelength (µm)', null, tipHtml));
  lcChart = new ScatterChart($('#ch-lc'), $('#tip-lc'), chartOpts('Date (MJD)', (v) => v.toFixed(0), tipHtml));
  specChart.setMessage('Not measured yet'); lcChart.setMessage('Not measured yet');
  new ResizeObserver(() => { if (items.length || S.mode === 'strip') requestDraw(); drawTicks(); updateTimeline(); }).observe($('#stage'));
  setupPointer();
  document.addEventListener('keydown', onKey);
}
function setMode(m) { setPlaying(false); set({ mode: m }); view = { zoom: 1, vx: wcs?.c ?? 0, vy: wcs?.c ?? 0 }; items = []; rebuild(''); }
function onKey(e) {
  const t = e.target.tagName; if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
  if (e.key === ' ') { if (t === 'BUTTON') return; e.preventDefault(); setPlaying(!playing); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); setPlaying(false); go(idx + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); setPlaying(false); go(idx - 1); }
  else if (e.key === 'Home') go(0); else if (e.key === 'End') go(items.length - 1);
  else if (e.key === ']') { const o = [2, 4, 6, 10, 20]; const i = Math.min(o.length - 1, o.indexOf(S.speed) + 1); set({ speed: o[i < 0 ? 2 : i] }); $('#p-speed').value = String(S.speed); }
  else if (e.key === '[') { const o = [2, 4, 6, 10, 20]; const i = Math.max(0, o.indexOf(S.speed) - 1); set({ speed: o[i] }); $('#p-speed').value = String(S.speed); }
  else if (e.key === '+' || e.key === '=') zoomBy(1.4); else if (e.key === '-') zoomBy(1 / 1.4); else if (e.key === '0') $('#z-fit').click();
  else if (e.key === 'm') { set({ marker: !S.marker }); $('#f-marker').checked = S.marker; requestDraw(); }
  else if (e.key === 'g') { set({ flags: !S.flags }); $('#d-flags').checked = S.flags; requestDraw(); }
  else { const m = { f: 'frames', e: 'epochs', d: 'diff', a: 'strip', t: 'track' }[e.key]; if (m) setMode(m); }
}

function boot() {
  readURL(); document.body.classList.toggle('embed', S.embed);
  if (S.embed) $('#display').open = false;
  wire(); syncFields();
  document.querySelectorAll('#modes button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === S.mode)));
  if (S.ra != null && S.dec != null) loadField();
  else if (S.q) { const p = PRESETS.find((x) => x.label === S.q || x.q === S.q); doSearch(p ? p.q : S.q, p); }
  else { showEmpty('Search for an object or enter coordinates, or try one of the example targets above.'); say('', ''); }
}
boot();
// Debug/test hook (used by the headless integration tests).
window.__sky = { store, S, get items() { return items; }, get idx() { return idx; }, get wcs() { return wcs; }, get catalogs() { return catalogs; }, propagate, mjdToYear, setMode, go, setPlaying };
