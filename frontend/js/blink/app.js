// Blink shell: owns view state, UI visibility, flights, and wires the sphere, patch and DOM controls.
import { Sphere, SPHEREX_HIPS } from './sphere.js';
import { PatchView, MODES } from './patch.js';
import { FlyController, reduceMotion } from './fly.js';
import { SearchJob, loadCoverage, dirName } from './movers.js';
import { Rewind, RewindPanel } from './rewind.js';
import { resolve } from '../api.js';
import { BANDS } from '../data.js';
import { mjdToDate, propagate } from '../wcs.js';
import {
  clamp, smooth, wrap360, separation, parseRA, parseDec, fmtRA, fmtDec, fmtDeg, RA_ERROR, DEC_ERROR, readUrlState, writeUrlState, el,
} from './util.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = { width: 0.5, band: 2, layer: 'model', mode: 'video' };
// The field of view is measured across the longer side in portrait too; keep the sphere's edge off screen on phones.
const START = { ra: 285, dec: -8, fov: window.innerHeight > window.innerWidth * 1.2 ? 55 : 85 };
const IDLE_MS = 3500, IGNORE_MS = 1500, DRIFT_DEG_S = 1.1, AUTO_FLY_FOV = 4.5;
const PRESETS = [
  { label: 'North Ecliptic Pole', ra: 270.0, dec: 66.56, pole: true },
  { label: 'South Ecliptic Pole', ra: 90.0, dec: -66.56, pole: true },
  { label: 'Orion Nebula', ra: 83.82, dec: -5.39 },
  { label: 'Galactic Centre', ra: 266.417, dec: -29.008 },
  { label: 'Barnard’s Star', ra: 269.4520770, dec: 4.6933650, pm: [-801.551, 10362.394], plx: 546.98, extra: true },
  { label: 'ε Indi B', ra: 331.0437, dec: -56.7828, pm: [3966, -2536], plx: 274.8, extra: true },
  { label: 'WISE 0855', ra: 133.795129, dec: -7.245147, plx: 439, extra: true },
  { label: 'R Draconis', ra: 248.175, dec: 66.7544, extra: true },
];
// Objects with a large proper motion are centred where they are during the SPHEREx data (epoch 2026.0, the
// same reference epoch as the analysis view), not at their J2000 position.
const REF_EPOCH = 2026.0;
const atRefEpoch = (ra, dec, pmra, pmdec, epoch = 2000) => {
  if (!pmra && !pmdec) return { ra, dec };
  const p = propagate(ra, dec, pmra, pmdec, epoch, REF_EPOCH);
  return { ra: +p.ra.toFixed(7), dec: +p.dec.toFixed(7) };
};
for (const p of PRESETS) if (p.pm) Object.assign(p, atRefEpoch(p.ra, p.dec, p.pm[0], p.pm[1]));
const LAYERS = [['model', 'Measured sky'], ['raw', 'Raw pixels'], ['leftover', 'Leftover']];
const LAYER_NOTES = {
  model: 'The sky as measured: a smooth background plus every star that was fitted, drawn as a soft glow.',
  raw: 'The pixels exactly as SPHEREx recorded them, with nothing removed.',
  leftover: 'What remains after the measured sky is taken away. Anything bright here is not explained yet.',
};
const LAYER_RO = { model: 'Rendered from measurements', raw: 'Raw pixels', leftover: 'Leftover (data minus model)' };
const WIDE_NOTE = 1;

/** Header note for the model layer while some frames still show raw pixels. list: 1-based positions, total: frame count. */
function rawNote(list, total) {
  const head = LAYER_RO.model;
  if (total === 1 || list.length === total) return `${head} · ${total === 1 ? 'frame' : `all ${total} frames`} still raw`;
  const parts = [];
  for (let i = 0; i < list.length;) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    parts.push(j > i ? `${list[i]}–${list[j]}` : `${list[i]}`);
    i = j + 1;
  }
  const text = parts.join(', ');
  if (text.length > 32) return `${head} · ${list.length} of ${total} frames still raw`;
  return `${head} · ${list.length === 1 ? 'frame' : 'frames'} ${text} of ${total} still raw`;
}

const S = {
  view: 'sphere', width: DEFAULTS.width, band: DEFAULTS.band, layer: DEFAULTS.layer, mode: DEFAULTS.mode,
  target: null, pending: null, uiVisible: false, hiddenAtDown: false, drifting: !reduceMotion(),
  flyMix: 0, fading: false, readyFade: 0, readyTarget: 0, readyDur: 0.8, committed: true, cursor: null, hoverUi: false, dragging: false,
  hips: 'none', coverage: [], job: null, loadedAt: 0,
};

const root = $('root'), ui = $('ui'), stage = $('stage'), overlay = $('overlay'), patchCanvas = $('patch');
const sphere = new Sphere($('aladin'));
const patch = new PatchView(patchCanvas, $('hover'), {
  onUpdate: onSessionUpdate, onFrameIndex, onFramesChanged: () => scheduleStrip(), onCursor: (sky) => { S.cursor = sky; },
  onRecentre: (ra, dec) => openFade(ra, dec), onLeave: () => leaveToSphere(), onPickMover: (k) => pickMover(k),
  uiVisible: () => S.uiVisible, clickAllowed: () => !S.hiddenAtDown, onMovers: () => renderMovers(),
});
const fly = new FlyController(applyFly);
const octx = overlay.getContext('2d');
let rwPanel = null;
const rewind = new Rewind({
  sphere, input: $('rewind-input'),
  hud: { box: $('rewind-hud'), year: $('rwh-year'), sub: $('rwh-sub'), legend: $('rwh-legend'), live: $('rwh-live') },
  onChange: () => { root.classList.toggle('rewinding', rewind.active); if (rwPanel) rwPanel.sync(); updateReadouts(true); },
});
rwPanel = new RewindPanel(rewind, {
  // The whirl plays with the controls out of the way; focus moves to the sky so arrow keys look around afterwards.
  onBeforeStart: () => {
    S.drifting = false;
    const inp = $('rewind-input'); inp.hidden = false; inp.focus({ preventScroll: true });
    if (!reduceMotion()) { clearTimeout(hideTimer); setUi(false); }
  },
});

// =====================================================================================
// UI visibility and idle fade
// =====================================================================================
let hideTimer = 0, loadStart = performance.now();
function setUi(v) { S.uiVisible = v; ui.classList.toggle('visible', v); root.classList.toggle('ui-on', v); }
function reveal() {
  if (performance.now() - loadStart < IGNORE_MS || rewind.busy) return;
  S.drifting = false;
  setUi(true);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(maybeHide, IDLE_MS);
}
function maybeHide() {
  const focusIn = ui.contains(document.activeElement) && document.activeElement !== document.body;
  if (S.hoverUi || focusIn || S.dragging) { hideTimer = setTimeout(maybeHide, 600); return; }
  setUi(false);
}
window.addEventListener('pointerdown', () => { S.hiddenAtDown = !S.uiVisible; }, true);
for (const ev of ['pointermove', 'pointerdown', 'touchstart', 'wheel', 'keydown']) window.addEventListener(ev, () => reveal(), { passive: true });
document.addEventListener('focusin', (e) => { if (ui.contains(e.target)) reveal(); });
for (const n of document.querySelectorAll('.col, .right, .readouts')) {
  n.addEventListener('pointerenter', () => { S.hoverUi = true; }); n.addEventListener('pointerleave', () => { S.hoverUi = false; });
}

// =====================================================================================
// Sphere interaction (click-to-fly, auto-fly on zoom) and markers
// =====================================================================================
const aladinEl = $('aladin');
let down = null;
aladinEl.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, hidden: !S.uiVisible || S.hiddenAtDown }; S.dragging = true; }, true);
window.addEventListener('pointerup', (e) => {
  S.dragging = false;
  const d = down; down = null;
  if (!d || S.view !== 'sphere' || fly.active || rewind.active || e.target !== aladinEl && !aladinEl.contains(e.target)) return;
  if (d.hidden || Math.hypot(e.clientX - d.x, e.clientY - d.y) >= 6) return;
  const r = aladinEl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const hit = markerAt(x, y), w = sphere.screen2world(x, y);
  if (hit) flyTo(hit.ra, hit.dec); else if (w) flyTo(w.ra, w.dec);
}, true);
window.addEventListener('pointercancel', () => { S.dragging = false; down = null; }, true);

function allMarkers() {
  const m = PRESETS.filter((p) => !p.extra).map((p) => ({ ...p, kind: 'preset' }));
  // cached fields that sit on top of each other (same target at slightly different coordinates) show once
  for (const f of S.coverage) if (!m.some((q) => q.kind === 'ready' && separation(q.ra, q.dec, f.ra, f.dec) < 0.15)) m.push({ ra: f.ra, dec: f.dec, kind: 'ready', n: f.n_frames });
  return m;
}
function markerAt(x, y) {
  let best = null, bd = 22;
  for (const m of allMarkers()) {
    const q = sphere.world2screen(m.ra, m.dec); if (!q) continue;
    const d = Math.hypot(q.x - x, q.y - y); if (d < bd) { bd = d; best = m; }
  }
  return best;
}
function drawMarkers(ctx, W, H) {
  if (!sphere.ok) return;
  ctx.save();
  ctx.font = '500 12px Inter, system-ui, sans-serif'; ctx.textBaseline = 'middle';
  const cam = sphere.cam;
  for (const m of allMarkers()) {
    const q = sphere.world2screen(m.ra, m.dec);
    if (!q || q.x < -50 || q.y < -50 || q.x > W + 50 || q.y > H + 50) continue;
    if (m.kind === 'ready') {
      ctx.strokeStyle = 'rgba(242,184,75,.85)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, 7); ctx.stroke();
      ctx.fillStyle = 'rgba(242,184,75,.95)'; ctx.beginPath(); ctx.arc(q.x, q.y, 2, 0, 7); ctx.fill();
      if (cam.fov < 70) { ctx.fillStyle = 'rgba(233,230,223,.8)'; ctx.fillText(`ready · ${m.n} frames`, q.x + 12, q.y); }
      continue;
    }
    if (m.pole) {
      const e = sphere.world2screen(m.ra, m.dec + (m.dec > 0 ? -3.5 : 3.5));
      const rad = e ? Math.hypot(e.x - q.x, e.y - q.y) : 0;
      if (rad > 3) {
        ctx.strokeStyle = '#F2B84B'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 5]); ctx.beginPath(); ctx.arc(q.x, q.y, rad, 0, 7); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#F2B84B'; ctx.shadowColor = 'rgba(5,7,11,.9)'; ctx.shadowBlur = 5; ctx.fillText('deep field', q.x + rad * 0.72 + 6, q.y - rad * 0.72);
        ctx.shadowBlur = 0;
      }
    }
    ctx.fillStyle = '#E9E6DF'; ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, 7); ctx.fill();
    ctx.shadowColor = 'rgba(5,7,11,.95)'; ctx.shadowBlur = 5; ctx.fillText(m.label, q.x + 9, q.y + 1); ctx.shadowBlur = 0;
  }
  ctx.restore();
}

// =====================================================================================
// Flights and view transitions
// =====================================================================================
function applyFly(st) {
  sphere.setCamera(st.ra, st.dec, st.fov);
  if (st.kind === 'leave') S.flyMix = st.oldMix;
  else if (st.kind === 'fly') S.flyMix = S.committed ? st.newMix : st.oldMix;
}

function patchSnapshot() {
  if (!S.target) return null;
  return { ra: S.target.ra, dec: S.target.dec, width: S.target.width, fov: S.target.width };
}
function setView(v) {
  S.view = v;
  root.classList.toggle('in-patch', v === 'patch');
  $('sphere-dock').hidden = v !== 'sphere';
  $('play-dock').hidden = v !== 'patch';
  $('link-analysis').hidden = v !== 'patch';
  updateReadouts(true); urlSync();
}
function fillCoords(ra, dec, name) {
  $('in-ra').value = fmtDeg(ra); $('in-dec').value = fmtDeg(dec); $('in-name').value = name || ''; nameDirty = false;
  $('in-ra').removeAttribute('aria-invalid'); $('in-dec').removeAttribute('aria-invalid'); $('coord-error').textContent = '';
}

/** Start loading a patch and fly to it from wherever we are. */
async function flyTo(ra, dec, name, named = null) {
  if (rewind.active) rewind.exitNow();
  const inPatch = S.view === 'patch' && patch.opacity > 0.5 && !!S.target;
  const from = inPatch
    ? { ra: S.target.ra, dec: S.target.dec, fov: S.target.width, inPatch: true }
    : { ...sphere.readCamera(), inPatch: false };
  if (S.pending) S.pending.abort();
  fly.cancel();
  const target = { ra: wrap360(ra), dec: clamp(dec, -89.99, 89.99), width: S.width, band: S.band, named };
  stopSearch();
  S.pending = patch.begin(target); S.committed = false;
  if (!inPatch && patch.session) patch.deactivate();
  S.flyMix = inPatch ? 1 : 0; S.readyFade = inPatch ? S.readyFade : 0;
  if (!inPatch) { stripKey = ''; $('strip').replaceChildren(); $('play-dock').classList.add('empty'); }
  root.classList.add('flying');
  fillCoords(target.ra, target.dec, name);
  S.target = target; S.fading = false;
  setView('patch');
  renderStatus(); renderMovers();
  const done = await fly.fly(from, target, (p) => { if (!S.committed && p >= 0.3) commit(); });
  if (done) { if (!S.committed) commit(); S.flyMix = 1; root.classList.remove('flying'); }
  S.readyDur = 0.8;
}
function commit() {
  if (!S.pending) { S.committed = true; return; }
  const s = S.pending; S.pending = null; S.committed = true; S.fading = false;
  patch.activate(s); S.readyFade = 0; S.readyTarget = s.frames.length ? 1 : 0;
  S.target = s.target; syncLinks(); renderStatus(); renderMovers(); scheduleStrip(true); urlSync();
}

/** Re-centre / rebuild the patch in place: fade to the veil, load, fade in (no fly). */
function openFade(ra, dec, name, opts = {}) {
  if (fly.active) return;
  // a rebuild at the same spot (new width / band) keeps the named target; a re-centre elsewhere drops it
  const same = S.target && separation(S.target.ra, S.target.dec, ra, dec) < 1e-6;
  const named = 'named' in opts ? opts.named : (same ? S.target.named || null : null);
  const target = { ra: wrap360(ra), dec: clamp(dec, -89.99, 89.99), width: S.width, band: S.band, named };
  if (S.pending) S.pending.abort();
  stopSearch();
  S.pending = patch.begin(target); S.committed = false; S.fading = true; S.readyTarget = 0; S.readyDur = 0.45;
  S.target = target;
  fillCoords(target.ra, target.dec, name);
  sphere.setCamera(target.ra, target.dec, target.width);
  if (S.view !== 'patch') { setView('patch'); S.flyMix = 1; }
  renderStatus(); urlSync();
}

async function leaveToSphere() {
  if (S.view !== 'patch' || !S.target) return;
  if (S.pending) { S.pending.abort(); S.pending = null; }
  if (patch.session) patch.session.abort();
  stopSearch();
  const t = S.target;
  S.committed = true; S.flyMix = 1;
  sphere.setCamera(t.ra, t.dec, t.width);
  setView('sphere'); S.cursor = null;
  root.classList.add('flying');
  const done = await fly.leave({ ra: t.ra, dec: t.dec, width: t.width });
  if (done) { root.classList.remove('flying'); S.flyMix = 0; patch.deactivate(); S.target = null; renderStatus(); renderMovers(); }
}

async function zoomButton(factor) {
  if (S.view !== 'sphere' || fly.active || rewind.active) return;
  const cam = sphere.readCamera();
  const to = clamp(cam.fov * factor, 3.5, 100);
  S.drifting = false;
  root.classList.add('flying');
  await fly.zoom(cam, to);
  root.classList.remove('flying');
}

// =====================================================================================
// Coordinates form
// =====================================================================================
let nameDirty = false;
$('in-name').addEventListener('input', () => { nameDirty = true; });
$('in-width').addEventListener('change', () => {
  S.width = parseFloat($('in-width').value);
  $('width-note').hidden = S.width < WIDE_NOTE;
  if (S.view === 'patch' && S.target && !fly.active) openFade(S.target.ra, S.target.dec);
  urlSync();
});
$('coord-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('coord-error'), nameV = $('in-name').value.trim(), raV = $('in-ra').value.trim(), decV = $('in-dec').value.trim();
  err.textContent = ''; $('in-ra').removeAttribute('aria-invalid'); $('in-dec').removeAttribute('aria-invalid');
  const textRa = /[a-z]{3,}/i.test(raV) && !decV;     // a name typed into the RA box
  if ((nameDirty && nameV) || textRa || (!raV && !decV && nameV)) { await goName(textRa ? raV : nameV); return; }
  const ra = parseRA(raV), dec = parseDec(decV);
  if (ra === null) { err.textContent = RA_ERROR; $('in-ra').setAttribute('aria-invalid', 'true'); $('in-ra').focus(); return; }
  if (dec === null) { err.textContent = DEC_ERROR; $('in-dec').setAttribute('aria-invalid', 'true'); $('in-dec').focus(); return; }
  go(ra, dec);
});
const norm = (t) => String(t).toLowerCase().replace(/[’']/g, '').replace(/ε/g, 'eps').replace(/epsilon/g, 'eps').replace(/[^a-z0-9]+/g, ' ').trim();
const ALIASES = { 'wise 0855': 'WISE 0855', 'wise j0855 0714': 'WISE 0855', 'wise j085510 83 071442 5': 'WISE 0855', 'wise 0855 0714': 'WISE 0855', 'eps indi b': 'ε Indi B', 'eps ind b': 'ε Indi B',
  'barnards star': 'Barnard’s Star', 'gj 699': 'Barnard’s Star', 'r dra': 'R Draconis', 'r draconis': 'R Draconis' };
/** The places offered as pills are found by name locally first (the name resolver does not know every nickname). */
function presetByName(q) {
  const n = norm(q), want = ALIASES[n];
  return PRESETS.find((p) => (want && p.label === want) || norm(p.label) === n) || null;
}
async function goName(q) {
  const err = $('coord-error');
  const local = presetByName(q);
  if (local) { err.textContent = ''; go(local.ra, local.dec, local.label, local.plx ? { name: local.label, plx: local.plx } : null); return; }
  err.textContent = `Looking up “${q}”…`;
  try {
    const r = await resolve(q);
    err.textContent = '';
    const p = atRefEpoch(r.ra, r.dec, r.pmra, r.pmdec, r.epoch || 2000);
    go(p.ra, p.dec, r.name || q, r.plx > 0 ? { name: r.name || q, plx: r.plx } : null);
  } catch (e) { err.textContent = `Couldn’t find “${q}”. Check the spelling, or type coordinates instead.`; }
}
function go(ra, dec, name, named = null) {
  S.drifting = false;
  if (S.view === 'patch' && S.target && !fly.active && separation(S.target.ra, S.target.dec, ra, dec) < 1e-6) { openFade(ra, dec, name, { named }); return; }
  flyTo(ra, dec, name, named);
}

// =====================================================================================
// Controls: presets, bands, layers, modes, speed, rings
// =====================================================================================
function pill(text, props = {}) { return el('button', { type: 'button', class: 'pill', ...props, text }); }
const presetBox = $('presets');
for (const p of PRESETS) presetBox.append(pill(p.label, { onclick: () => { S.drifting = false; go(p.ra, p.dec, p.label, p.plx ? { name: p.label, plx: p.plx } : null); } }));

const bandBox = $('band-chips');
BANDS.forEach((b, i) => {
  if (!b) return;
  bandBox.append(pill(`D${i} · ${b.lo.toFixed(2)}–${b.hi.toFixed(2)} µm`, { 'data-band': i, 'aria-pressed': 'false', onclick: () => setBand(i) }));
});
function setBand(i) {
  if (i === S.band) return;
  S.band = i; syncChips();
  sphere.setBand(i);
  if (S.view === 'patch' && S.target && !fly.active) openFade(S.target.ra, S.target.dec);
  updateReadouts(true); urlSync();
}
const layerBox = $('layer-chips'); layerBox.classList.add('layers');
for (const [k, label] of LAYERS) layerBox.append(pill(label, { 'data-layer': k, 'aria-pressed': 'false', onclick: () => setLayer(k) }));
function setLayer(k) { S.layer = k; patch.layer = k; patch.dirty = true; for (const f of patch.frames) f.unexp = null; syncChips(); updateReadouts(true); urlSync(); }

const modeBox = $('mode-pills');
for (const [k, label] of MODES) modeBox.append(pill(label, { 'data-mode': k, 'aria-pressed': 'false', onclick: () => setMode(k) }));
function setMode(k) { S.mode = k; patch.mode = k; patch.dirty = true; syncChips(); urlSync(); }
const speedBox = $('speed-pills');
for (const v of [0.5, 1, 2]) speedBox.append(pill(`${v}×`, { 'data-speed': v, 'aria-pressed': 'false', onclick: () => { patch.speed = v; syncChips(); } }));
for (const b of speedBox.children) b.classList.add('tall');

function syncChips() {
  for (const b of bandBox.children) b.setAttribute('aria-pressed', String(+b.dataset.band === S.band));
  for (const b of layerBox.children) b.setAttribute('aria-pressed', String(b.dataset.layer === S.layer));
  for (const b of modeBox.children) b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode));
  for (const b of speedBox.children) b.setAttribute('aria-pressed', String(+b.dataset.speed === patch.speed));
  $('mode-note').textContent = MODES.find((m) => m[0] === S.mode)[2];
  $('layer-note').textContent = LAYER_NOTES[S.layer];
}
$('btn-rings').addEventListener('click', () => {
  patch.rings = !patch.rings; patch.dirty = true;
  const b = $('btn-rings'); b.setAttribute('aria-pressed', String(patch.rings)); b.textContent = patch.rings ? 'Movers ringed' : 'Ring the movers';
});
$('btn-back').addEventListener('click', leaveToSphere);
$('btn-zoom-in').addEventListener('click', () => zoomButton(0.55));
$('btn-zoom-out').addEventListener('click', () => zoomButton(1.8));
$('btn-open-centre').addEventListener('click', () => { if (fly.active || rewind.active) return; const c = sphere.readCamera(); S.drifting = false; flyTo(c.ra, c.dec); });
$('btn-play').addEventListener('click', () => { patch.setPlaying(!patch.playing); syncPlay(); });
function syncPlay() {
  const b = $('btn-play'), n = patch.n;
  b.disabled = n < 2; b.style.opacity = n < 2 ? 0.45 : 1;
  b.setAttribute('aria-label', patch.playing ? 'Pause' : 'Play');
  $('play-icon').setAttribute('d', patch.playing ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z');
}

$('advanced').addEventListener('toggle', () => ui.classList.toggle('adv-open', $('advanced').open));

// ---- frame strip ----
let stripQueued = false, stripKey = '';
function scheduleStrip(force) {
  if (force) stripKey = '';
  if (stripQueued) return; stripQueued = true;
  requestAnimationFrame(() => { stripQueued = false; buildStrip(); });
}
function buildStrip() {
  const F = patch.frames, strip = $('strip');
  const key = F.map((f) => f.id).join('|');
  $('play-dock').classList.toggle('empty', F.length === 0);
  if (key === stripKey) return;
  stripKey = key;
  strip.replaceChildren(...F.map((f, i) => {
    const d = mjdToDate(f.mjd);
    return el('button', {
      type: 'button', class: i && f.visit !== F[i - 1].visit ? 'gap' : '', 'data-i': i,
      'aria-label': `Go to frame ${i + 1} of ${F.length}`, title: `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    });
  }));
  patch.lastIdx = -1; syncPlay();
  $('play-dock').classList.toggle('empty', F.length === 0);
  const nv = patch.session ? patch.session.visits : 0;
  $('load-line').textContent = F.length ? `${F.length} exposure${F.length === 1 ? '' : 's'}${nv > 1 ? ` in ${nv} visits` : ''}${patch.session && patch.session.failed ? ` · ${patch.session.failed} failed to load` : ''}` : '';
}
$('strip').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  patch.seek(+b.dataset.i); syncPlay();
});
function onFrameIndex(i, st, f) {
  const strip = $('strip'), kids = strip.children, n = kids.length;
  if (n !== patch.n) buildStrip();
  for (let k = 0; k < kids.length; k++) {
    const c = kids[k]; c.classList.toggle('cur', k === i); c.classList.toggle('past', k < i);
    k === i ? c.setAttribute('aria-current', 'true') : c.removeAttribute('aria-current');
  }
  $('frame-label').textContent = `Frame ${String(i + 1).padStart(2, '0')} / ${String(patch.n).padStart(2, '0')}`;
}
function updateTimeLabels() {
  const F = patch.frames; if (!F.length) { $('elapsed-label').textContent = ''; $('visit-label').textContent = ''; return; }
  const st = patch._state(); if (!st) return;
  const dt = st.mjd - F[0].mjd;
  $('elapsed-label').textContent = patch.n < 2 ? 'T + 0 d' : dt < 1 ? `T + ${(dt * 24).toFixed(1)} h` : `T + ${dt.toFixed(1)} d`;
  const f = F[st.nearest], nv = patch.session.visits;
  $('visit-label').textContent = `${nv > 1 ? `Visit ${f.visit + 1}/${nv} · ` : ''}${mjdToDate(f.mjd).toISOString().slice(0, 10)}`;
}

// ---- movers list + search ----
function renderMovers() {
  const s = patch.session, ul = $('mover-list'), list = s && s.active ? s.movers : [];
  ul.replaceChildren();
  $('mover-count').textContent = list.length ? String(list.length) : '';
  if (!list.length) {
    const msg = !s || !s.active ? 'Open a patch to see its moving objects.' : s.moverNote || (s.moversLoaded ? 'No moving objects found in this patch.' : s.status === 'loading' ? 'Looking for moving objects once the frames are in…' : 'Looking for moving objects…');
    ul.append(el('li', { class: 'empty', text: msg })); return;
  }
  for (const m of list) {
    const rate = (isFinite(m.rate) ? `${m.rate.toFixed(2)}″/h${isFinite(m.pa) ? ` · PA ${Math.round(m.pa)}°` : ''}` : '') + (m.detected ? ' · seen' : '');
    const row = el('button', {
      type: 'button', class: `mover-row${m.kind === 'candidate' ? ' cand' : ''}`, 'aria-pressed': String(m.key === patch.selectedKey),
      title: `${m.sub}${isFinite(m.confidence) ? ` · confidence ${Math.round(m.confidence * 100)}%` : ''}${isFinite(m.pa) ? ` · moving ${dirName(m.pa)}` : ''}`,
      onclick: () => pickMover(m.key),
    }, el('span', { class: 'nm', text: m.label }), el('span', { class: 'rate', text: rate }));
    ul.append(el('li', {}, row));
  }
}
function pickMover(key) { patch.selectedKey = patch.selectedKey === key ? null : key; patch.dirty = true; renderMovers(); }

const chk = $('chk-search');
chk.addEventListener('change', () => { chk.checked ? startSearch() : stopSearch(); });
function startSearch() {
  const s = patch.session; if (!s || !s.active) { chk.checked = false; $('search-note').textContent = 'Open a patch first, then turn this on.'; return; }
  const p = { ra: s.params.ra, dec: s.params.dec, fov: s.params.fov, scale: s.params.scale, detectors: s.params.detectors, per_visit: 6, max_frames: 400 };
  $('search-note').textContent = 'Starting the search…';
  S.job = new SearchJob(p, (u) => {
    if (S.job === null || patch.session !== s) return;
    s.cands = u.candidates || []; patch.dirty = true; renderMovers();
    const n = u.found ?? s.cands.length, c = `${n} candidate${n === 1 ? '' : 's'}${n > s.cands.length ? ` (the ${s.cands.length} most confident shown)` : ''}`;
    $('search-note').textContent = u.state === 'running' ? `Searching… ${Math.round(u.progress * 100)}% (${u.tried ?? '?'} of ${u.total ?? '?'} trial motions) · ${c} so far. Candidates are only possible movers; confidence is shown on each row.`
      : u.state === 'done' ? `Search finished: ${c}. Candidates are only possible movers, not confirmed objects.`
      : u.state === 'error' ? `The search could not run: ${u.error || 'unknown error'}.` : 'Search cancelled.';
    if (u.state === 'error') { chk.checked = false; S.job = null; }
  });
  S.job.start();
}
function stopSearch() {
  if (S.job) { S.job.cancel(); S.job = null; }
  chk.checked = false;
  const s = patch.session; if (s) { s.cands = []; patch.dirty = true; }
  $('search-note').textContent = 'Looks for faint things sliding across the patch that no catalogue lists. Slow; the answer is saved for next time.';
  renderMovers();
}

function syncLinks() {
  const t = S.target; if (!t) return;
  $('link-analysis').href = `analysis.html?ra=${fmtDeg(t.ra)}&dec=${fmtDeg(t.dec)}&fov=${Math.min(0.5, t.width)}`;
}

// =====================================================================================
// Status (loading / empty / error)
// =====================================================================================
const st = { box: $('status'), title: $('status-title'), text: $('status-text'), bar: $('status-bar'), fill: $('status-fill'), btn: $('status-cancel') };
const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const bandText = (b) => `D${b} (${BANDS[b].lo.toFixed(2)}–${BANDS[b].hi.toFixed(2)} µm)`;
let statusMode = '';
function renderStatus() {
  const s = S.pending || patch.session;
  if (!s || S.view !== 'patch') { st.box.hidden = true; return; }
  const el_ = performance.now() - s.t0;
  st.box.classList.remove('corner', 'error');
  if (s.status === 'loading') {
    const n = s.frames.length, tot = s.progress ? s.progress.total : s.total, done = s.progress ? s.progress.done : n;
    const prog = tot ? `${Math.min(done, tot)} of ${tot} exposures` : '';
    st.box.hidden = false; statusMode = 'cancel'; st.btn.textContent = 'Cancel';
    if (!n) {
      st.title.textContent = 'Finding every SPHEREx exposure of this spot…';
      st.text.textContent = `${mmss(el_)}${prog ? ` · ${prog}` : ''} · This can take a few minutes the first time.`;
      st.bar.hidden = !tot; st.fill.style.width = tot ? `${Math.round(100 * Math.min(done, tot) / tot)}%` : '0';
    } else {
      st.box.classList.add('corner'); st.text.textContent = `Loading exposures… ${n}${tot ? ` of ${tot}` : ''} · ${mmss(el_)}`;
    }
  } else if (s.status === 'empty') {
    st.box.hidden = false; statusMode = 'back'; st.btn.textContent = 'Back to the whole sky'; st.bar.hidden = true;
    st.title.textContent = 'No SPHEREx data here';
    st.text.textContent = `SPHEREx has no exposures of this spot in band ${bandText(s.target.band)}. Try another band under Advanced options, or pick a different place.`;
  } else if (s.status === 'error') {
    st.box.hidden = false; st.box.classList.add('error'); statusMode = 'back'; st.btn.textContent = 'Back to the whole sky'; st.bar.hidden = true;
    st.title.textContent = 'Couldn’t load this patch';
    st.text.textContent = `${s.error || 'Something went wrong.'} Check your connection and try again.`;
  } else if (s.status === 'cancelled') {
    st.box.hidden = true;
  } else if (s.error) {
    st.box.hidden = false; statusMode = 'dismiss'; st.box.classList.add('corner'); st.btn.textContent = 'Dismiss'; st.bar.hidden = true;
    st.text.textContent = `Some frames could not be loaded: ${s.error}`;
  } else { st.box.hidden = true; }
}
st.btn.addEventListener('click', () => {
  if (statusMode === 'cancel') {
    const s = S.pending || patch.session; if (!s) return;
    s.abort();
    if (!s.frames.length) leaveToSphere(); else { s.status = 'ready'; renderStatus(); }
  } else if (statusMode === 'back') leaveToSphere();
  else { const s = patch.session; if (s) s.error = null; renderStatus(); }
});
function onSessionUpdate(s) {
  if (s === S.pending || s === patch.session) { renderStatus(); if (s.status === 'ready' || s.status === 'empty') { renderMovers(); scheduleStrip(); } }
}

// =====================================================================================
// Header read-outs, aria, URL state
// =====================================================================================
function updateReadouts(force) {
  const cam = S.view === 'sphere' ? sphere.readCamera() : null, t = S.target;
  const b = BANDS[S.band];
  let c;
  if (cam) c = `${fmtRA(cam.ra)}  ${fmtDec(cam.dec)}  ·  ${cam.fov >= 10 ? cam.fov.toFixed(0) : cam.fov.toFixed(1)}°`;
  else if (t) c = `${fmtRA(t.ra)}  ${fmtDec(t.dec)}  ·  ${t.width}°`;
  else c = '';
  $('ro-centre').textContent = c;
  $('ro-mission').textContent = `SPHEREx · D${S.band} ${b.lo.toFixed(2)}–${b.hi.toFixed(2)} µm`;
  let cur;
  if (S.view === 'patch' && S.cursor) cur = `${fmtRA(S.cursor.ra)}  ${fmtDec(S.cursor.dec)}`;
  else cur = S.view === 'patch' ? 'Click the sky to re-centre' : 'Drag to look around';
  $('ro-cursor').textContent = cur;
  let layerTxt = S.view === 'patch' ? LAYER_RO[S.layer]
    : S.hips === 'spherex' ? 'SPHEREx all-sky map' : S.hips === '2mass' ? 'Backdrop: 2MASS all-sky survey' : '';
  if (S.view === 'patch' && S.layer === 'model' && patch.session) {
    const raw = patch.rawFrames();
    if (raw.length) layerTxt = rawNote(raw, patch.session.frames.length);
  }
  $('ro-layer').textContent = layerTxt;
  if (rewind.active) {
    const r = rewind.readouts();
    $('ro-centre').textContent = r.centre; $('ro-cursor').textContent = r.cursor; $('ro-layer').textContent = r.layer;
    if (force) updateTimeLabels();
    return;
  }
  const label = S.view === 'patch' && t
    ? `Patch of the sky centred on right ascension ${fmtRA(t.ra)}, declination ${fmtDec(t.dec)}, ${t.width} degrees wide, SPHEREx band D${S.band}`
    : cam ? `The whole sky, centred on right ascension ${fmtRA(cam.ra)}, declination ${fmtDec(cam.dec)}, ${cam.fov.toFixed(0)} degrees across` : 'Sky view';
  patchCanvas.setAttribute('aria-label', label); $('aladin').setAttribute('aria-label', label);
  if (force) updateTimeLabels();
}
function urlSync() {
  const o = {};
  if (S.view === 'patch' && S.target) { o.ra = S.target.ra; o.dec = S.target.dec; }
  if (S.width !== DEFAULTS.width) o.width = S.width;
  if (S.band !== DEFAULTS.band) o.band = S.band;
  if (S.layer !== DEFAULTS.layer) o.layer = S.layer;
  if (S.mode !== DEFAULTS.mode) o.mode = S.mode;
  writeUrlState(o);
}

// =====================================================================================
// Main loop
// =====================================================================================
let last = performance.now(), W = 1, H = 1, dpr = 1, tick5 = 0, tickStatus = 0;
function sizeOverlay() {
  dpr = window.devicePixelRatio || 1; W = overlay.clientWidth; H = overlay.clientHeight;
  overlay.width = Math.round(W * dpr); overlay.height = Math.round(H * dpr);
  patch.resize();
}
window.addEventListener('resize', sizeOverlay);

function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  // sphere camera: drift, auto-fly, clamp
  if (S.view === 'sphere' && !fly.active && !rewind.active) {
    if (S.drifting) { const c = sphere.cam; sphere.setCamera(wrap360(c.ra + DRIFT_DEG_S * dt), c.dec, c.fov); }
    else {
      const c = sphere.readCamera();
      if (c.fov < AUTO_FLY_FOV) { S.drifting = false; flyTo(c.ra, c.dec); }
      else if (c.fov > 100) sphere.setCamera(c.ra, c.dec, 100);
    }
  }
  // patch fade: frames present -> fade in; a replacement patch fades the old one out first
  const s = patch.session;
  if (S.fading && !S.committed) {
    S.readyFade = clamp(S.readyFade - dt / 0.45, 0, 1);
    if (!fly.active && S.readyFade <= 0.001 && S.pending) { S.flyMix = 1; commit(); S.readyDur = 1.1; }
  } else if (S.committed && s && s.active) {
    S.readyTarget = s.frames.length && s.npix ? 1 : 0;
    const rate = S.readyTarget ? 1 / Math.max(S.readyDur, 0.3) : 1 / 0.45;
    S.readyFade = clamp(S.readyFade + clamp(S.readyTarget - S.readyFade, -rate * dt, rate * dt), 0, 1);
  }
  const op = S.view === 'sphere' && !fly.active ? 0 : S.flyMix * smooth(S.readyFade);
  if (Math.abs(op - patch.opacity) > 1e-3) patch.setOpacity(op);
  const hide = patch.opacity >= 0.995 ? 'hidden' : '';
  if (aladinEl.style.visibility !== hide) aladinEl.style.visibility = hide;

  octx.setTransform(dpr, 0, 0, dpr, 0, 0); octx.clearRect(0, 0, W, H);
  if (S.uiVisible && patch.opacity < 0.5 && S.view !== 'patch' && !rewind.active) drawMarkers(octx, W, H);
  patch.frame(dt, octx, dpr, S.uiVisible);
  rewind.frame(dt, octx, W, H, dpr);

  if (now - tick5 > 200) { tick5 = now; updateReadouts(false); updateTimeLabels(); }
  if (now - tickStatus > 500) { tickStatus = now; renderStatus(); }
  requestAnimationFrame(loop);
}

// =====================================================================================
// Start-up
// =====================================================================================
async function start() {
  const url = readUrlState();
  if (url.width) S.width = url.width;
  if (url.band) S.band = url.band;
  if (url.layer) { S.layer = url.layer; patch.layer = url.layer; }
  if (url.mode) { S.mode = url.mode; patch.mode = url.mode; }
  $('in-width').value = String(S.width); $('width-note').hidden = S.width < WIDE_NOTE;
  syncChips(); syncPlay();
  sizeOverlay();
  if (patch.rendererError) $('sphere-note').textContent = 'This browser could not start the image renderer.';

  const cam0 = url.ra !== undefined ? { ra: url.ra, dec: url.dec, fov: Math.max(S.width, 3.5) } : START;
  sphere.onSource = (src) => {
    S.hips = src;
    const note = $('sphere-note');
    note.hidden = src !== 'none';
    if (src === 'none') note.textContent = 'The all-sky map could not be loaded (are you offline?). You can still type coordinates or pick a place to open a patch.';
    updateReadouts(true);
  };
  sphere.band = S.band;
  sphere.init(cam0);   // async; the page does not wait for it

  // opening sequence
  if (reduceMotion()) { $('veil').style.display = 'none'; stage.classList.add('entered'); }
  else requestAnimationFrame(() => requestAnimationFrame(() => { $('veil').classList.add('lift'); stage.classList.add('entered'); }));
  loadStart = performance.now();

  if (url.ra !== undefined) {
    S.drifting = false;
    sphere.setCamera(url.ra, url.dec, Math.max(S.width * 6, 4));   // the all-sky map is pixelated far below ~4 degrees
    S.flyMix = 1; S.readyDur = 1.1;
    openFade(url.ra, url.dec);
    // first load: no old patch to fade out
    S.readyFade = 0;
  } else { setView('sphere'); }
  syncChips();
  requestAnimationFrame((t) => { last = t; loop(t); });
  loadCoverage().then((f) => { S.coverage = f; });
}
start();
// For tests and debugging from the console.
window.__blink = { S, sphere, patch, fly, flyTo, leaveToSphere, rewind, rwPanel, SPHEREX_HIPS };
