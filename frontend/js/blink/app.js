// Space Maps shell: owns view state, UI visibility, flights, and wires the sphere, patch and DOM controls.
import { Sphere, SPHEREX_HIPS } from './sphere.js';
import { PatchView, MODES } from './patch.js';
import { FlyController, reduceMotion } from './fly.js';
import { SearchJob, loadCoverage, dirName } from './movers.js';
import { Rewind, RewindPanel } from './rewind.js';
import { TimeSlider, fmtTaken, fmtAgo, fmtSpan, fmtVisit } from './timeslider.js';
import { resolve } from '../api.js';
import { BANDS } from '../data.js';
import { propagate } from '../wcs.js';
import {
  clamp, smooth, wrap360, separation, parseRA, parseDec, fmtRA, fmtDec, fmtDeg, RA_ERROR, DEC_ERROR, readUrlState, writeUrlState, el,
} from './util.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = { width: 0.5, band: 2, layer: 'model', mode: 'video' };
// The field of view is measured across the longer side in portrait too; keep the sphere's edge off screen on phones.
const START = { ra: 285, dec: -8, fov: window.innerHeight > window.innerWidth * 1.2 ? 55 : 85 };
// MIN_FOV: the closest the sphere zooms (the all-sky map is pixelated below about 4 degrees), and the field the 3D page
// hands back at. LOOK_FOV: the view for a ?look link that does not come from the 3D page, wide enough to see the spot.
// VEIL_OUT_MS: the dip to black before the 3D page (matches .veil.out in blink.css).
const IGNORE_MS = 1500, DRIFT_DEG_S = 1.1, MIN_FOV = 4, LOOK_FOV = 12, DRAG_PX = 6, VEIL_OUT_MS = 350;
// the picture of the sky handed to the 3D page (scene3d-main.js reads it once)
const SNAP_KEY = 'scene3d-enter-snap';
// The all-sky tiles for a close view take a moment to arrive. Hand-offs to and from the 3D page wait up to SKY_WAIT_MS
// for SKY_SHOWN of the view to show the sky (sphere.loaded), so the shared picture is the sky and not the blank ground.
const SKY_WAIT_MS = 3000, SKY_SHOWN = 0.85;
const HINT = 'Drag to look around · scroll to zoom · click a spot to fly into it in 3D';
const HINT_MIN = 'As close as the all-sky map goes · click a spot to fly into it in 3D';
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
  target: null, pending: null, uiVisible: false, uiReady: false, full: false, panelAtDown: false, drifting: !reduceMotion(),
  flyMix: 0, fading: false, readyFade: 0, readyTarget: 0, readyDur: 0.8, committed: true, cursor: null, hoverUi: false, dragging: false,
  hips: 'none', coverage: [], job: null, loadedAt: 0, to3d: false,
};

const root = $('root'), hintEl = $('hint'), ui = $('ui'), stage = $('stage'), overlay = $('overlay'), patchCanvas = $('patch');
const sphere = new Sphere($('aladin'));
const patch = new PatchView(patchCanvas, $('hover'), {
  onUpdate: onSessionUpdate, onFrameIndex, onFramesChanged: () => scheduleStrip(), onCursor: (sky) => { S.cursor = sky; },
  onRecentre: (ra, dec) => openFade(ra, dec), onLeave: () => leaveToSphere(), onPickMover: (k) => pickMover(k),
  uiVisible: () => S.uiVisible, clickAllowed: () => !S.panelAtDown, onMovers: () => renderMovers(),
});
const fly = new FlyController(applyFly);
const octx = overlay.getContext('2d');
let rwPanel = null;
const rewind = new Rewind({
  sphere, input: $('rewind-input'),
  hud: { box: $('rewind-hud'), year: $('rwh-year'), sub: $('rwh-sub'), legend: $('rwh-legend'), sky: $('rwh-sky'), live: $('rwh-live') },
  onChange: () => { root.classList.toggle('rewinding', rewind.active); if (rwPanel) rwPanel.sync(); updateReadouts(true); },
});
rwPanel = new RewindPanel(rewind, {
  // The whirl plays with the controls out of the way; focus moves to the sky so arrow keys look around afterwards.
  onBeforeStart: () => {
    S.drifting = false; setFull(false);
    const inp = $('rewind-input'); inp.hidden = false; inp.focus({ preventScroll: true });
  },
  onOpen: (open) => setPanel(open ? 'rewind' : null),
});

// =====================================================================================
// UI: a calm layer that is always there, and everything else behind Esc
// =====================================================================================
// Calm (the default): the wordmark, one read-out line, a one-line hint, the place markers and a small bar (search, "Turn back the
// sky" and "All controls"). Esc or that button brings up everything else; Esc again, or dragging or scrolling the sky, folds it
// back. The dock steps aside while a flight or the rewind whirl plays, then the calm layer returns.
let loadStart = performance.now();
function setUi(v) { S.uiVisible = v; ui.classList.toggle('visible', v); root.classList.toggle('ui-on', v); }
/** Called every frame: shows the UI after the opening, and keeps the dock out of the way of flights and the whirl. */
function syncUi() {
  const ready = reduceMotion() || performance.now() - loadStart >= IGNORE_MS;
  if (ready !== S.uiReady) { S.uiReady = ready; ui.classList.toggle('ready', ready); }
  const show = ready && (reduceMotion() || (!fly.active && !rewind.busy));
  if (show !== S.uiVisible) setUi(show);
}
function setFull(v, { focus = false } = {}) {
  if (!v) setPanel(null);
  S.full = v; ui.classList.toggle('full', v); root.classList.toggle('ui-full', v);
  for (const b of document.querySelectorAll('.more-btn')) {
    const label = v ? 'Fewer controls' : 'All controls';
    b.setAttribute('aria-expanded', String(v)); b.setAttribute('aria-label', `${label} (Esc)`);
    b.querySelector('.more-label').textContent = label;
  }
  // a control that just folded away would leave focus nowhere: hand it to the toggle that is on screen
  if (focus || (!v && ui.contains(document.activeElement) && document.activeElement.offsetParent === null)) {
    const b = [...document.querySelectorAll('.more-btn')].find((n) => n.offsetParent !== null);
    if (b) b.focus({ preventScroll: true });
  }
}
for (const b of document.querySelectorAll('.more-btn')) b.addEventListener('click', () => setFull(!S.full));

const onControls = (t) => !!(t && t.closest && t.closest('.sheet, .bar, .hint, .readouts, .status'));
/** Looking around the sky folds the extra controls away, unless a panel is open (it was asked for). */
function lookingAround() { S.drifting = false; if (S.full && !openPanel && !reduceMotion()) setFull(false); }
let tap = null;
window.addEventListener('pointerdown', (e) => {
  S.drifting = false;
  S.panelAtDown = !!openPanel;
  tap = onControls(e.target) ? null : { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
}, true);
window.addEventListener('pointermove', (e) => {
  if (!tap || e.pointerId !== tap.id || tap.moved) return;
  if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) >= DRAG_PX) { tap.moved = true; lookingAround(); }
}, { capture: true, passive: true });
const endTap = (e) => {
  const t = tap; tap = null;
  if (!t || e.pointerId !== t.id || e.type === 'pointercancel' || t.moved) return;
  // a click on the sky with a panel open only closes the panel; otherwise the sky handles it (fly there)
  if (S.panelAtDown) setPanel(null);
};
window.addEventListener('pointerup', endTap, true); window.addEventListener('pointercancel', endTap, true);
window.addEventListener('wheel', (e) => { if (!onControls(e.target)) lookingAround(); }, { capture: true, passive: true });
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault(); e.stopPropagation();
  // innermost first: the suggestion list, then an open panel, then the controls themselves
  if (!qList.hidden) { closeSuggest(); qIn.focus(); return; }
  if (openPanel) { const by = panelOpener(); setPanel(null); if (by) by.focus(); return; }
  if (S.uiVisible) setFull(!S.full, { focus: ui.contains(document.activeElement) });
}, true);

// =====================================================================================
// Panels: at most one open above the bar
// =====================================================================================
const PANELS = { find: $('panel-find'), rewind: $('panel-rewind') };
const OPENERS = { find: ['btn-find', 'btn-find-2'], rewind: ['rw-open', 'rw-change'] };
let openPanel = null;
function setPanel(name) {
  openPanel = name && PANELS[name] ? name : null;
  for (const [k, n] of Object.entries(PANELS)) n.hidden = k !== openPanel;
  $('sheet').hidden = !openPanel;
  root.classList.toggle('sheet-open', !!openPanel);
  for (const [k, ids] of Object.entries(OPENERS)) for (const id of ids) $(id).setAttribute('aria-expanded', String(k === openPanel));
  if (openPanel) { $('sheet').scrollTop = 0; if (!S.full) setFull(true); }
}
function panelOpener() {
  if (!openPanel) return null;
  return OPENERS[openPanel].map($).find((b) => b.offsetParent !== null) || null;
}
function togglePanel(name, focusId) {
  if (openPanel === name) { setPanel(null); return; }
  setPanel(name);
  if (focusId) $(focusId).focus({ preventScroll: true });
}
$('btn-find').addEventListener('click', () => togglePanel('find', 'in-ra'));
$('btn-find-2').addEventListener('click', () => togglePanel('find'));
$('rw-open').addEventListener('click', () => togglePanel('rewind', 'rw-year'));
$('rw-change').addEventListener('click', () => togglePanel('rewind', 'rw-year'));
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => { const by = panelOpener(); setPanel(null); if (by) by.focus(); });
setFull(false);   // labels the toggles

// =====================================================================================
// Sphere interaction (click-to-fly, auto-fly on zoom) and markers
// =====================================================================================
const aladinEl = $('aladin');
let down = null;
aladinEl.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, hidden: S.panelAtDown }; S.dragging = true; }, true);
window.addEventListener('pointerup', (e) => {
  S.dragging = false;
  const d = down; down = null;
  if (!d || S.view !== 'sphere' || fly.active || rewind.active || e.target !== aladinEl && !aladinEl.contains(e.target)) return;
  if (d.hidden || Math.hypot(e.clientX - d.x, e.clientY - d.y) >= 6) return;
  const r = aladinEl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const hit = markerAt(x, y), w = sphere.screen2world(x, y);
  if (hit) flyTo3D(hit.ra, hit.dec, hit.label, hit.plx ? { name: hit.label, plx: hit.plx } : null); else if (w) flyTo3D(w.ra, w.dec);
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
  if (S.to3d) return;   // on the way to the 3D page: the camera moves, no patch is shown
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

/** The 3D page for a spot. width, band and the named target ride along so its "Watch this patch change" opens the same frames. */
function scene3dUrl(ra, dec, named) {
  const p = new URLSearchParams({ ra: fmtDeg(ra), dec: fmtDeg(dec) });
  if (S.width !== DEFAULTS.width) p.set('width', String(S.width));
  if (S.band !== DEFAULTS.band) p.set('band', String(S.band));
  if (named && named.name) { p.set('name', named.name); if (named.plx) p.set('plx', String(named.plx)); }
  return `scene3d.html?${p}`;
}
/**
 * Hand-off to the 3D page: a short dip to black. fov is the field the picture shows across its longer side; the 3D page
 * opens on the same picture from the Sun (?enter=) and then pulls into the patch, so the two pages read as one move.
 */
/** Until most of the view shows the sky, or maxMs passes: resolves to whether it does. */
async function skyShown(maxMs) {
  const t0 = performance.now();
  for (;;) {
    if (await sphere.loaded() >= SKY_SHOWN) return true;
    if (performance.now() - t0 > maxMs) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}
function enter3D(url, fov, snap = false) {
  if (reduceMotion() || !(fov > 0)) { location.href = url; return; }
  const veil = $('veil');
  veil.classList.remove('lift', 'quick'); veil.classList.add('out');
  // The 3D page draws stars only; from the sky it opens on this picture of the view and dissolves it into the stars.
  const shot = snap ? Promise.race([sphere.snapshot(), new Promise((r) => setTimeout(r, 900))]) : null;
  Promise.all([shot, new Promise((r) => setTimeout(r, VEIL_OUT_MS))]).then(([s]) => {
    try {
      if (s && s.img) sessionStorage.setItem(SNAP_KEY, JSON.stringify({ ...s, fov, t: Date.now() }));
      else sessionStorage.removeItem(SNAP_KEY);
    } catch (_) { /* storage full or blocked: the 3D page opens on its own stars */ }
    location.href = `${url}&enter=${+fov.toFixed(4)}`;
  });
}

/**
 * From the sphere, a chosen spot opens the 3D view first: the camera flies there without loading any frames, then the
 * page changes. Frames load only when asked for ("Watch this patch change" on the 3D page).
 */
async function flyTo3D(ra, dec, name, named = null) {
  if (S.to3d) return;
  if (rewind.active) rewind.exitNow();
  setFull(false); closeSuggest();
  S.drifting = false;
  const to = { ra: wrap360(ra), dec: clamp(dec, -89.99, 89.99), width: MIN_FOV };
  if (!named && name) named = { name };   // a name alone is only shown; a parallax makes it a named target in the frames view
  S.to3d = true; root.classList.add('flying');
  const done = await fly.fly({ ...sphere.readCamera(), inPatch: false }, to);
  // the picture handed over is the sky at the spot, so it waits (briefly) for the view's tiles; a blank one is not sent
  if (done) { const shown = await skyShown(SKY_WAIT_MS); enter3D(scene3dUrl(to.ra, to.dec, named), to.width, shown); return; }
  S.to3d = false; root.classList.remove('flying');
}
// Coming back with the browser's Back button can restore this page as it was left, mid-hand-off and under the veil.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  if (S.to3d) { S.to3d = false; root.classList.remove('flying'); }
  const veil = $('veil');
  if (veil.classList.contains('out')) { veil.classList.remove('out'); veil.classList.add('lift', 'quick'); }
});

/** Start loading a patch and fly to it from wherever we are. */
async function flyTo(ra, dec, name, named = null) {
  if (rewind.active) rewind.exitNow();
  setFull(false); closeSuggest();
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
  if (!inPatch) { stripKey = ''; slider.build(); $('play-dock').classList.add('empty'); }
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
  setFull(false);
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
  const to = clamp(cam.fov * factor, MIN_FOV, 100);
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
async function goName(q, err = $('coord-error')) {
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
  // a new place picked from the sphere opens in 3D; inside a patch the controls keep working on frames
  if (S.view !== 'patch') { flyTo3D(ra, dec, name, named); return; }
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
$('btn-3d').addEventListener('click', () => {
  const t = S.target; if (!t || S.view !== 'patch') return;
  enter3D(scene3dUrl(t.ra, t.dec, t.named), patch.fieldDeg() || t.width);
});
$('btn-zoom-in').addEventListener('click', () => zoomButton(0.55));
$('btn-zoom-out').addEventListener('click', () => zoomButton(1.8));
$('btn-open-centre').addEventListener('click', () => { if (fly.active || rewind.active) return; const c = sphere.readCamera(); flyTo3D(c.ra, c.dec); });
$('btn-play').addEventListener('click', () => { patch.setPlaying(!patch.playing); syncPlay(); });
function syncPlay() {
  const b = $('btn-play'), n = patch.n;
  b.disabled = n < 2; b.style.opacity = n < 2 ? 0.45 : 1;
  b.setAttribute('aria-label', patch.playing ? 'Pause' : 'Play');
  $('play-icon').setAttribute('d', patch.playing ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z');
}

// ---- search box in the bar: places to try, then any name the resolver knows ----
const qIn = $('q'), qList = $('q-list');
function closeSuggest() { qList.hidden = true; qIn.setAttribute('aria-expanded', 'false'); }
function renderSuggest() {
  const raw = qIn.value.trim(), n = norm(raw);
  const hits = PRESETS.filter((p) => !n || norm(p.label).includes(n));
  const kids = [];
  if (hits.length) kids.push(el('li', { class: 'q-head', text: n ? 'Places' : 'Places to try' }));
  for (const p of hits) kids.push(el('li', {}, el('button', { type: 'button', text: p.label, onclick: () => goPreset(p) })));
  if (raw && !presetByName(raw)) kids.push(el('li', {}, el('button', { type: 'button', class: 'q-go', text: `Look up “${raw}”`, onclick: () => searchBar(raw) })));
  qList.replaceChildren(...kids);
  qList.hidden = !kids.length; qIn.setAttribute('aria-expanded', String(!qList.hidden));
}
function goPreset(p) { qIn.value = ''; closeSuggest(); $('bar-msg').textContent = ''; S.drifting = false; go(p.ra, p.dec, p.label, p.plx ? { name: p.label, plx: p.plx } : null); }
function searchBar(q) { closeSuggest(); if (!q) return; S.drifting = false; goName(q, $('bar-msg')).then(() => { if (!$('bar-msg').textContent) qIn.value = ''; }); }
qIn.addEventListener('focus', renderSuggest);
qIn.addEventListener('input', () => { $('bar-msg').textContent = ''; renderSuggest(); });
$('q-form').addEventListener('submit', (e) => { e.preventDefault(); searchBar(qIn.value.trim()); });
$('q-form').addEventListener('focusout', (e) => { if (!$('q-form').contains(e.relatedTarget)) closeSuggest(); });
$('q-form').addEventListener('keydown', (e) => {
  const items = [...qList.querySelectorAll('button')], i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (qList.hidden) renderSuggest();
    const list = [...qList.querySelectorAll('button')]; if (!list.length) return;
    e.preventDefault(); e.stopPropagation();
    // the list opens upwards, so ArrowUp moves away from the box
    const next = i < 0 ? (e.key === 'ArrowUp' ? list.length - 1 : 0) : i + (e.key === 'ArrowUp' ? -1 : 1);
    if (next < 0 || next >= list.length) qIn.focus(); else list[next].focus();
  }
});

// ---- time slider: every exposure on a broken time axis, one segment per visit ----
const slider = new TimeSlider($('timeline'), {
  frames: () => patch.frames,
  pos: () => patch.pos,
  focused: () => patch.loopVisit,
  pause: () => { patch.setPlaying(false); syncPlay(); },
  seek: (pos, { snap }) => {
    const had = patch.loopVisit;
    patch.seek(patch.mode === 'video' && !snap ? pos : Math.round(pos));
    if (had !== patch.loopVisit) slider.build(true);
    syncPlay(); updateTimeLabels();
  },
  focusVisit: (v) => {
    patch.setLoopVisit(v); slider.build(true);
    const [lo, hi] = patch.bounds();
    patch.setPlaying(hi > lo && !reduceMotion()); syncPlay(); updateTimeLabels();
  },
});
let stripQueued = false, stripKey = '';
function scheduleStrip(force) {
  if (force) stripKey = '';
  if (stripQueued) return; stripQueued = true;
  requestAnimationFrame(() => { stripQueued = false; buildStrip(); });
}
function buildStrip() {
  const F = patch.frames;
  const key = F.map((f) => f.id).join('|');
  $('play-dock').classList.toggle('empty', F.length === 0);
  if (key === stripKey) return;
  // a newly streamed frame can renumber the visits: drop a focus that no longer names the same frames
  if (patch.loopVisit !== null && patch.session && patch.loopVisit >= patch.session.visits) patch.setLoopVisit(null);
  stripKey = key;
  slider.build();
  patch.lastIdx = -1; syncPlay();
  const nv = patch.session ? patch.session.visits : 0;
  const span = F.length > 1 ? ` · ${fmtVisit(F[0].mjd, F[F.length - 1].mjd)}` : '';
  $('load-line').textContent = F.length ? `${F.length} exposure${F.length === 1 ? '' : 's'}${nv > 1 ? ` in ${nv} visits` : ''}${span}${patch.session && patch.session.failed ? ` · ${patch.session.failed} failed to load` : ''}` : '';
}
function onFrameIndex() {
  if (slider.n !== patch.n) buildStrip();
  updateTimeLabels();
}
/** The shown exposure's real time, how long ago that was, and how far into the sequence it sits. */
function updateTimeLabels() {
  const F = patch.frames;
  if (!F.length) { for (const id of ['elapsed-label', 'visit-label', 'taken-label', 'ago-label']) $(id).textContent = ''; return; }
  const st = patch._state(); if (!st) return;
  const i = st.nearest, f = F[i], nv = patch.session.visits, [lo, hi] = patch.bounds();
  const n2 = (v) => String(v).padStart(2, '0');
  $('frame-label').textContent = patch.loopVisit !== null ? `Frame ${n2(i - lo + 1)} / ${n2(hi - lo + 1)}` : `Frame ${n2(i + 1)} / ${n2(patch.n)}`;
  // while frames crossfade in video mode, say so instead of naming a moment no photo was taken
  const between = patch.mode === 'video' && st.b !== null && st.t > 0.08 && st.t < 0.92 && F[st.b].visit !== F[st.a].visit;
  $('taken-label').textContent = between ? `between visits ${F[st.a].visit + 1} and ${F[st.b].visit + 1}` : fmtTaken(f.mjd);
  $('ago-label').textContent = between ? '' : fmtAgo(f.mjd);
  const dt = f.mjd - F[lo].mjd;
  $('elapsed-label').textContent = patch.n < 2 || dt <= 0 ? 'T + 0' : `T + ${fmtSpan(dt)}`;
  $('elapsed-label').title = patch.loopVisit !== null ? 'Time since the first exposure of this visit' : 'Time since the first exposure';
  $('visit-label').textContent = nv > 1 ? `Visit ${f.visit + 1} / ${nv}${patch.loopVisit !== null ? ' · looping' : ''}` : '';
  const exp = f.meta && isFinite(f.meta.exptime) ? `, ${Math.round(f.meta.exptime)} s exposure` : '';
  slider.set(patch.pos, st.nearest, `Frame ${st.nearest + 1} of ${patch.n}, taken ${fmtTaken(f.mjd)}${nv > 1 ? `, visit ${f.visit + 1} of ${nv}` : ''}${exp}`);
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
  if (S.view === 'patch' && S.target) {
    o.ra = S.target.ra; o.dec = S.target.dec;
    if (S.target.named) { o.name = S.target.named.name; o.plx = S.target.named.plx; }
  }
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
  syncUi();
  // sphere camera: drift, clamp the zoom (zooming in never opens anything)
  if (S.view === 'sphere' && !fly.active && !rewind.active && !S.to3d) {
    if (S.drifting) { const c = sphere.cam; sphere.setCamera(wrap360(c.ra + DRIFT_DEG_S * dt), c.dec, c.fov); }
    else {
      const c = sphere.readCamera();
      if (c.fov < MIN_FOV) { S.drifting = false; sphere.setCamera(c.ra, c.dec, MIN_FOV); }
      else if (c.fov > 100) sphere.setCamera(c.ra, c.dec, 100);
      const hint = c.fov <= MIN_FOV * 1.02 ? HINT_MIN : HINT;
      if (hintEl.textContent !== hint) hintEl.textContent = hint;
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
  if (S.view === 'patch' && patch.n) { const st = patch._state(); if (st) slider.set(patch.pos, st.nearest); }
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

  // from=3d: handed back by the 3D page, which narrowed to the sphere's closest field around the spot before it went
  const from3d = new URLSearchParams(location.search).get('from') === '3d' && !reduceMotion();
  const cam0 = url.ra !== undefined ? { ra: url.ra, dec: url.dec, fov: Math.max(S.width, MIN_FOV) }
    : url.look ? { ...url.look, fov: from3d ? MIN_FOV : LOOK_FOV } : START;
  sphere.onSource = (src) => {
    S.hips = src;
    const note = $('sphere-note');
    note.hidden = src !== 'none';
    if (src === 'none') note.textContent = 'The all-sky map could not be loaded (are you offline?). You can still type coordinates or pick a place to open a patch.';
    updateReadouts(true);
  };
  sphere.band = S.band;
  const sphereReady = sphere.init(cam0);   // async; the page does not wait for it

  // opening sequence (a hand-back from the 3D page lifts the veil quickly and skips the slow settle)
  if (reduceMotion()) { $('veil').style.display = 'none'; stage.classList.add('entered'); }
  else if (from3d && !url.look) requestAnimationFrame(() => requestAnimationFrame(() => { $('veil').classList.add('lift', 'quick'); stage.classList.add('entered', 'arrived'); }));
  else requestAnimationFrame(() => requestAnimationFrame(() => { $('veil').classList.add('lift'); stage.classList.add('entered'); }));
  loadStart = performance.now();

  if (url.ra !== undefined) {
    S.drifting = false;
    sphere.setCamera(url.ra, url.dec, Math.max(S.width * 6, 4));   // the all-sky map is pixelated far below ~4 degrees
    S.flyMix = 1; S.readyDur = 1.1;
    openFade(url.ra, url.dec, url.name, { named: url.plx ? { name: url.name, plx: url.plx } : null });
    // first load: no old patch to fade out
    S.readyFade = 0;
  } else {
    // ?look=ra,dec (back from the 3D page): the sphere around that spot, nothing loads. Handed back by the 3D page, it
    // opens at the closest field (the picture the 3D view ended on) and zooms out to the whole sky around the spot.
    if (url.look) S.drifting = false;
    setView('sphere');
    if (url.look && from3d) zoomOutFromSpot(sphereReady);
  }
  syncChips();
  requestAnimationFrame((t) => { last = t; loop(t); });
  loadCoverage().then((f) => { S.coverage = f; });
}
/**
 * Back from the 3D page at a spot: the veil stays down until the map shows the view (the picture the 3D page ended on),
 * or a moment has passed, then lifts, and the view widens from the spot to the whole sky.
 */
async function zoomOutFromSpot(sphereReady) {
  await Promise.race([sphereReady, new Promise((r) => setTimeout(r, 2500))]);
  await skyShown(SKY_WAIT_MS);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  $('veil').classList.add('lift', 'quick'); stage.classList.add('entered', 'arrived');
  await new Promise((r) => setTimeout(r, 700));
  if (S.view !== 'sphere' || fly.active || rewind.active || S.to3d) return;   // already on the way somewhere else
  root.classList.add('flying');
  await fly.zoom(sphere.readCamera(), START.fov, 2.6);
  root.classList.remove('flying');
}
start();
// For tests and debugging from the console.
window.__blink = { S, sphere, patch, fly, flyTo, leaveToSphere, rewind, rwPanel, SPHEREX_HIPS };
