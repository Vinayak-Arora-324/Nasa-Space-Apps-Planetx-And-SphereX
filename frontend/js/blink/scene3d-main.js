// Page controller for scene3d.html: reads the patch from the URL, loads the bright context stars (a static file) and
// the Gaia stars for the patch (/api/scene3d) and its objects (/api/objects: planets, the Moon, small bodies), which load
// side by side and fail separately, and wires the HUD and the layers panel to the Scene3D renderer.
// This is the first view of a spot picked on the sphere; its SPHEREx frames load only from "Watch this patch change".
import { getScene3D, getObjects, getCoverage } from '../api.js';
import { Scene3D, fmtNum } from './scene3d.js';
import { contextStars, LY_PER_PC as LY } from './scene3d-math.js';
import { AU_PER_PC } from './scene3d-frames.js';
import { layers as layerList, kinds as kindList, kindSpec, beyondKinds } from './scene3d-registry.js';
import { kindsPhrase, countPhrase, capNotes, creditItems, datasetCounts } from './scene3d-objects.js';
import { C_PC_PER_S, fmtTimesC } from './scene3d-nav.js';
import { fmtRA, fmtDec, fmtDeg, separation } from './util.js';

const $ = (id) => document.getElementById(id);
const DEFAULT = { ra: 83.82, dec: -5.39, radius: 3 };
const HELP_KEY = 'scene3d-help-seen';

// ---------------------------------------------------------------- URL
const q = new URLSearchParams(location.search);
const num = (k) => { const v = q.get(k); return v === null || v.trim() === '' ? NaN : Number(v); };
const ra = Number.isFinite(num('ra')) ? ((num('ra') % 360) + 360) % 360 : DEFAULT.ra;
const dec = Number.isFinite(num('dec')) && Math.abs(num('dec')) <= 90 ? num('dec') : DEFAULT.dec;
const radius = Number.isFinite(num('radius')) && num('radius') > 0 ? Math.min(5, Math.max(0.1, num('radius'))) : DEFAULT.radius;
const mjd = Number.isFinite(num('mjd')) ? num('mjd') : undefined;
// carried through from the main page, for the frames it opens: patch width, band, and a target found by name
const width = Number.isFinite(num('width')) && num('width') > 0 && num('width') <= 3.5 ? num('width') : null;
const band = Number.isInteger(num('band')) && num('band') >= 1 && num('band') <= 6 ? num('band') : null;
const name = (q.get('name') || '').trim().slice(0, 80);
const plx = name && num('plx') > 0 ? num('plx') : null;
// the field (degrees across the longer side) of the flat picture this page was opened from: the sphere or the frames
const enter = num('enter') > 0 && num('enter') <= 60 ? num('enter') : null;
const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
// a reload or a shared link opens the page as usual, without the hand-off
if (q.has('enter')) { q.delete('enter'); try { history.replaceState(null, '', `${location.pathname}?${q}`); } catch (_) { /* sandboxed */ } }
// LEAVE_FOV: the field the camera narrows to before handing over, the sphere's closest zoom (MIN_FOV in app.js), where
// the sky and the frames open. INTRO_WAIT_MS: how long the opening picture waits for the Gaia stars before widening to
// the normal view (a cold cache takes much longer; the camera then glides into the patch when they come).
const LEAVE_FOV = 4, INTRO_WAIT_MS = 1500;
// The sky page's picture of the view it handed over from (app.js enter3D), read once: the page opens on it.
const SNAP_KEY = 'scene3d-enter-snap', SNAP_MAX_AGE_MS = 30000;
let snap = null;
if (enter) {
  try { snap = JSON.parse(sessionStorage.getItem(SNAP_KEY) || 'null'); sessionStorage.removeItem(SNAP_KEY); } catch (_) { snap = null; }
  if (!snap || typeof snap.img !== 'string' || !snap.img.startsWith('data:image/') || Math.abs(snap.fov - enter) > 1e-3
    || !(Date.now() - snap.t < SNAP_MAX_AGE_MS)) snap = null;
}

// ---------------------------------------------------------------- static text
$('coords').textContent = `${name ? name + ' · ' : ''}RA ${fmtRA(ra)} · Dec ${fmtDec(dec)}`;
$('cone-r').textContent = fmtNum(radius, 3);
function mainUrl(extra) {
  const p = new URLSearchParams(extra);
  p.set('from', '3d');
  if (width !== null) p.set('width', String(width));
  if (band !== null) p.set('band', String(band));
  return `./?${p}`;
}
// ?ra&dec opens the patch and starts loading its frames; ?look only turns the sphere to the spot
$('btn-frames').href = mainUrl({ ra: fmtDeg(ra), dec: fmtDeg(dec), ...(name ? { name } : {}), ...(plx ? { plx: String(plx) } : {}) });
$('btn-back').href = mainUrl({ look: `${fmtDeg(ra)},${fmtDeg(dec)}` });

// Whether the frame list for this spot is already cached, so the frames button can say how long it will take.
// Matches the main page's frame query, which is made at the patch centre.
getCoverage().then((j) => {
  const f = (j.fields || []).find((c) => Number.isFinite(c.ra) && Number.isFinite(c.dec) && separation(c.ra, c.dec, ra, dec) < 0.01);
  $('frames-note').textContent = f ? `${f.n_frames.toLocaleString('en-US')} frames · opened before` : 'Not opened before · the first load can take minutes';
}).catch(() => { /* no note: the button still works */ });
document.title = 'Inside the patch · 3D fly-through';

// ---------------------------------------------------------------- status banner
let solarDate = '';
let pageScene = 'stars';        // the scene the HUD last reported: the Gaia sentences of #warn belong to the Stars scene
let gaiaState = 'loading';      // loading | ok | error
let objectsState = 'loading';   // loading | ok | error
function showStatus(text, { error = false, retry = false } = {}) {
  const box = $('status');
  box.hidden = false;
  box.classList.toggle('error', error);
  $('status-text').textContent = text;
  $('status-retry').hidden = !retry;
}
const hideStatus = () => { $('status').hidden = true; };

// ---------------------------------------------------------------- HUD
function onHud(h) {
  const stars = h.scene === 'stars';
  if (h.scene !== pageScene) { pageScene = h.scene; refreshWarn(); }
  document.querySelectorAll('[data-only]').forEach((el) => { el.hidden = el.dataset.only !== h.scene; });
  $('hud-where').textContent = h.frame === 'system'
    ? `Near ${h.hostName} · ${fmtNum(h.surfaceAu)} AU from its surface`
    : `Interstellar · ${fmtNum(h.dist)} pc from the Sun`;
  $('hud-dist').textContent = `${h.dist < 0.02 ? fmtNum(h.dist * AU_PER_PC) + ' AU' : fmtNum(h.dist) + ' pc · ' + fmtNum(h.dist * LY) + ' ly'}${h.scene === 'solar' && solarDate ? ' · ' + solarDate : ''}`;
  const moving = h.speedPc > 1e-15;
  $('hud-speed').textContent = `${moving ? `${fmtNum(h.speed)} ${h.unit}/s · ≈ ${fmtTimesC(h.speedPc / C_PC_PER_S)}` : `0 · cruise ${fmtNum(h.cruise)} ${h.unit}/s`}${h.flying ? ' · autopilot' : ''}`;
  $('hud-mode').textContent = h.auto ? `Auto speed · ${fmtNum(h.throttle, 2)}/s of the way to the nearest surface · T switches` : 'Manual speed · wheel sets it · T switches';
  $('hud-near').textContent = h.nearName && h.nearText ? `${h.nearName} · ${h.nearText}` : 'n/a';
  $('hud-ev').textContent = `${h.ev >= 0 ? '+' : '−'}${Math.abs(h.ev).toFixed(1)} EV`;
  const c = h.counts;
  $('hud-count').textContent = h.frame === 'system' && h.hostCount ? h.hostCount : stars ? starsCountText(h, c) : solarCountText(h.objCounts || {});
  $('hud-limit').textContent = `${h.limit.toFixed(1)} mag · [ and ] change it`;
  $('hint').textContent = h.flying ? 'Autopilot · Esc cancels' : h.locked ? 'WASD move · mouse look · wheel throttle · T auto/manual speed · Shift boost · G autopilot to the target · Esc release' : 'Click a star to select it · click empty sky to fly · WASD move · wheel throttle · T auto/manual speed · Shift boost · G autopilot';
  document.querySelectorAll('.scene-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scene === h.scene)));
  setEvidenceUi(h.evidence);
}
const plural = (n, kind) => { const s = kindSpec(kind); return s ? s.noun[n === 1 ? 0 : 1] : kind; };
const SMALL_KINDS = ['dwarf_planet', 'asteroid', 'comet'];
/** "8 planets and the Moon · 23 small bodies" (or "2,000 brightest small bodies (more in this cone)"), from the store's counts and the registry nouns. */
function solarCountText(c) {
  if (objectsState === 'loading') return 'Solar system loading…';
  const planets = c.planet || 0, moons = c.moon || 0, status = scene ? scene.store.kindStatus : {};
  const small = countPhrase(SMALL_KINDS, c, status) || '0 small bodies';
  const first = [planets ? `${planets} ${plural(planets, 'planet')}` : '', moons === 1 ? 'the Moon' : moons > 1 ? `${moons} ${plural(moons, 'moon')}` : ''].filter(Boolean).join(' and ');
  return [first, small].filter(Boolean).join(' · ');
}
/** The Stars scene's count line: the Gaia counts, and in the galaxy frame the exoplanets and clusters in view. */
function starsCountText(h, c) {
  const gaia = c.gaia ? `${c.gaia.toLocaleString('en-US')} Gaia stars · ${c.ctx.toLocaleString('en-US')} bright stars around`
    : gaiaState === 'error' ? `No Gaia stars · ${c.ctx.toLocaleString('en-US')} bright stars around` : 'Gaia stars loading…';
  const status = scene ? scene.store.kindStatus : {}, vis = h.visCounts || {}, direct = h.visDirect || {};
  const beyond = h.frame === 'galaxy' ? beyondKinds().filter((k) => vis[k] > 0).map((k) => countPhrase([k], vis, status, direct)) : [];
  return [gaia, ...beyond].join(' · ');
}
function setEvidenceUi(on) {
  $('btn-evidence').setAttribute('aria-pressed', String(!!on));
  $('ev-chip').hidden = !on;
}
/**
 * The credits line (section 17.2): `credit · licence` for every dataset that has records in the cone and a credit (OpenNGC's CC BY-SA 4.0 for the
 * nebulae). Shown in both scenes, small; the licence name links to its page in a new tab.
 */
function refreshCredits(sources) {
  const box = $('credits');
  box.textContent = '';
  const items = scene ? creditItems(sources, datasetCounts(scene.store)) : [];
  items.forEach((it, i) => {
    if (i) box.append(' | ');
    if (!it.licenceName || !it.licence || !/^https?:\/\//i.test(it.licence)) { box.append(it.text); return; }
    box.append(`${it.credit} · `);
    const a = document.createElement('a');
    a.href = it.licence; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = it.licenceName;
    box.append(a);
  });
  box.hidden = !items.length;
}
// Notes from independent loads (the bright stars, the objects) share one line, each under its own key.
const notes = {};
function setNote(text, key = 'ctx') {
  notes[key] = text || '';
  const all = Object.values(notes).filter(Boolean).join(' ');
  const n = $('note'); n.textContent = all; n.hidden = !all;
}

// ---------------------------------------------------------------- renderer
let scene;
try {
  scene = new Scene3D({
    canvas: $('gl'), labels: $('labels'), card: $('card'), ra, dec, radius,
    onHud,
    onEvidence: setEvidenceUi,
    onLayers: syncLayers,
    onScene: (name) => {
      if (name !== pageScene) { pageScene = name; refreshWarn(); }
      $('btn-stars').setAttribute('aria-pressed', String(name === 'stars'));
      $('btn-solar').setAttribute('aria-pressed', String(name === 'solar'));
    },
    onLost: (lost) => {
      if (lost) showStatus('The graphics context was lost. The browser should restore it on its own.');
      else hideStatus();
    },
  });
} catch (e) {
  showStatus(`The 3D view needs WebGL2. This browser could not start it: ${e.message} Try a current Chrome, Edge, Firefox or Safari.`, { error: true });
  $('gl').hidden = true;
  $('btn-stars').disabled = true; $('btn-solar').disabled = true; $('btn-reset').disabled = true; $('btn-evidence').disabled = true; $('btn-layers').disabled = true;
}

// ---------------------------------------------------------------- loading
async function loadContext() {
  try {
    const r = await fetch('data/rewind-stars.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    scene.setContext(contextStars(await r.json()));
  } catch (e) {
    setNote(`The bright stars around the patch did not load (${e.message}).`);
  }
}
let t0 = 0, timer = 0;
function loadingText() {
  const what = [gaiaState === 'loading' ? 'the Gaia stars' : '', objectsState === 'loading' ? 'the solar system' : ''].filter(Boolean).join(' and ');
  return what ? `Loading ${what} for this patch · ${Math.round((performance.now() - t0) / 1000)} s.${gaiaState === 'loading' ? ' A cold cache can take 30 to 90 s.' : ''}` : '';
}
/** Banner: what is still loading, else the stars error (with a retry), else nothing. */
function refreshStatus() {
  const text = loadingText();
  if (text) showStatus(text);
  else if (gaiaState === 'error') showStatus(`Could not load the Gaia stars for this patch: ${gaiaError}`, { error: true, retry: true });
  else hideStatus();
  if (!text && timer) { clearInterval(timer); timer = 0; }
}
let gaiaError = '';
let gaiaWarn = [];   // the Gaia truncation sentences
/** #warn: the Gaia sentences (Stars scene only) and the cap sentences of the objects payload (both scenes). */
function refreshWarn() {
  const parts = [...(pageScene === 'stars' ? gaiaWarn : []), ...(scene ? capNotes(scene.store.kindStatus) : [])];
  const w = $('warn');
  w.textContent = parts.join(' '); w.hidden = !parts.length;
}
async function loadStars() {
  gaiaState = 'loading';
  try {
    const p = await getScene3D({ ra, dec, radius });
    if (p.stars) {
      scene.setGaia(p.stars);
      scene.reveal();   // only moves the camera on an untouched arrival from the sphere or the frames
      const shown = Array.isArray(p.stars.rows) ? p.stars.rows.length : 0;
      gaiaWarn = [
        p.stars.truncated ? `Showing the ${shown.toLocaleString('en-US')} brightest Gaia stars in the cone; fainter ones are left out.` : '',
        p.stars.incomplete ? 'Part of the cone failed to load, so some areas have no Gaia stars.' : '',
      ].filter(Boolean);
      refreshWarn();
    }
    gaiaState = 'ok';
  } catch (e) {
    gaiaState = 'error'; gaiaError = e.message || String(e);
    scene.endIntro();
  } finally {
    if (scene.introWaiting) scene.endIntro();   // no Gaia stars in the payload: nothing to reveal
    refreshStatus();
  }
}
async function loadObjects() {
  objectsState = 'loading';
  try {
    const p = await getObjects({ ra, dec, radius, mjd });
    const r = scene.setObjects(p);
    refreshCredits(p.sources);
    if (!r.ok) { objectsState = 'error'; setNote(r.error, 'objects'); }
    else {
      objectsState = 'ok';
      const m = p.query && p.query.mjd;
      if (Number.isFinite(m)) solarDate = new Date((m - 40587) * 86400000).toISOString().slice(0, 10) + ' UTC';
      setNote(scene.store.errorNotes().map((n) => `${kindsPhrase(n.kinds)} are missing: ${n.error}`).join(' '), 'objects');
    }
  } catch (e) {
    objectsState = 'error';
    setNote(`The solar system did not load (${e.message || e}).`, 'objects');
  } finally {
    $('btn-solar').disabled = !scene.hasSolar;
    buildLayers();
    refreshWarn();
    refreshStatus();
  }
}
/** Both requests run side by side and each is handled alone. A retry asks again only for what failed. */
function loadScene() {
  const wantStars = gaiaState !== 'ok', wantObjects = objectsState !== 'ok';
  t0 = performance.now();
  if (wantStars) gaiaState = 'loading';
  if (wantObjects) objectsState = 'loading';
  refreshStatus();
  if (!timer) timer = setInterval(refreshStatus, 1000);
  if (wantStars) loadStars();
  if (wantObjects) loadObjects();
}

// ---------------------------------------------------------------- layers panel
const panel = $('layers'), layersBtn = $('btn-layers');
const LAYER_GROUPS = [['sky', 'Sky'], ['solar', 'Solar system'], ['beyond', 'Beyond the Solar system']];
/** A layer whose kinds all failed to load is disabled, with the error as its title. */
function layerError(l) {
  const ks = kindList().filter((k) => k.layer === l.id);
  if (!ks.length) return null;
  const st = scene.store.kindStatus || {};
  return ks.every((k) => st[k.kind] && st[k.kind].status === 'error') ? ks.map((k) => st[k.kind].error).find(Boolean) || 'did not load' : null;
}
/** Pressed and enabled state of a layer's pill: a sub-switch (a layer with a parent) is disabled while its parent is off. */
function applyLayerState(b, l, map) {
  b.setAttribute('aria-pressed', String(!!map[l.id]));
  const par = l.parent ? layerList().find((x) => x.id === l.parent) : null;
  const err = layerError(l), parentOff = !!par && (!map[par.id] || !!layerError(par));
  b.disabled = !!err || parentOff;
  b.title = err || (parentOff ? `Turn on ${(layerList().find((x) => x.id === l.parent) || { label: l.parent }).label} first` : '');
}
function buildLayers() {
  if (!scene) return;
  const host = $('layers-body');
  host.textContent = '';
  for (const [gid, label] of LAYER_GROUPS) {
    const list = layerList().filter((l) => l.group === gid);
    if (!list.length) continue;
    const h = document.createElement('h3'); h.className = 'layers-label'; h.textContent = label; h.id = `layers-${gid}`;
    const chips = document.createElement('div'); chips.className = 'chips layers'; chips.setAttribute('role', 'group'); chips.setAttribute('aria-labelledby', h.id);
    const pill = (l) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = l.parent ? 'pill sub' : 'pill'; b.textContent = l.label; b.dataset.layer = l.id;
      applyLayerState(b, l, scene.layers);
      b.addEventListener('click', () => scene.setLayer(l.id, !scene.layers[l.id]));
      return b;
    };
    const brk = () => { const d = document.createElement('div'); d.className = 'layer-break'; return d; };
    for (const l of list.filter((x) => !x.parent)) {
      chips.append(pill(l));
      const subs = list.filter((x) => x.parent === l.id);   // sub-switches follow their parent, on a row of their own, indented
      if (subs.length) { chips.append(brk()); for (const sub of subs) chips.append(pill(sub)); chips.append(brk()); }
    }
    host.append(h, chips);
  }
}
function syncLayers(map) {
  const defs = new Map(layerList().map((l) => [l.id, l]));
  panel.querySelectorAll('[data-layer]').forEach((b) => applyLayerState(b, defs.get(b.dataset.layer), map));
}
function setLayersOpen(open) {
  panel.hidden = !open;
  layersBtn.setAttribute('aria-expanded', String(open));
}
layersBtn.addEventListener('click', () => setLayersOpen(panel.hidden));
$('layers-close').addEventListener('click', () => { setLayersOpen(false); layersBtn.focus({ preventScroll: true }); });
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey || !scene) return;
  if (e.code === 'KeyL' && !e.repeat) setLayersOpen(panel.hidden);
  else if (e.code === 'Escape' && !panel.hidden) { setLayersOpen(false); if (panel.contains(document.activeElement)) layersBtn.focus({ preventScroll: true }); }
});

// ---------------------------------------------------------------- hand-off to and from the flat views
const veil = $('veil');
let leaving = false;
/** Glide back to the flat picture, dip to black, then go. A plain page change without motion or WebGL. */
async function handOff(href) {
  if (leaving) return;
  leaving = true;
  if (!scene || reduceMotion()) { location.href = href; return; }
  await scene.flatten(LEAVE_FOV);
  veil.classList.remove('lift', 'quick'); veil.classList.add('out');
  setTimeout(() => { location.href = href; }, 350);
}
for (const a of [$('btn-frames'), $('btn-back')]) {
  a.addEventListener('click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // a new tab or window: no animation
    e.preventDefault();
    handOff(a.href);
  });
}
// The browser's Back button can bring this page back as it was left, under the veil with the camera held.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted || !leaving) return;
  leaving = false;
  if (scene) scene.endFlatten();
  veil.classList.remove('out'); veil.classList.add('lift', 'quick');
});

// ---------------------------------------------------------------- controls
$('btn-stars').addEventListener('click', () => scene && scene.setScene('stars'));
$('btn-solar').addEventListener('click', () => scene && scene.setScene('solar'));
$('btn-evidence').addEventListener('click', () => scene && scene.toggleEvidence());
$('btn-reset').addEventListener('click', () => scene && scene.resetView());
$('status-retry').addEventListener('click', () => loadScene());

// Help: once, then only on '?'.
const help = $('help');
let seen = false;
try { seen = localStorage.getItem(HELP_KEY) === '1'; } catch (_) { /* storage blocked: show it every time */ }
// opened from a flat picture: the card waits until the camera has finished arriving
const entering = document.documentElement.classList.contains('entering');
help.hidden = seen || !!(entering && enter && scene);
$('help-start').addEventListener('click', () => {
  help.hidden = true; seen = true;
  try { localStorage.setItem(HELP_KEY, '1'); } catch (_) { /* ignore */ }
});
window.addEventListener('keydown', (e) => { if (e.key === '?') help.hidden = !help.hidden; });

// The veil lifts once the opening picture is ready and the first frames are drawn.
const snapEl = $('enter-snap');
if (entering && scene && snap) {
  snapEl.src = snap.img;
  if (snap.blur > 0) snapEl.style.filter = `blur(${+snap.blur}px)`;
  snapEl.hidden = false;
} else snapEl.remove();
if (entering) {
  const ready = snapEl.isConnected && snapEl.decode ? snapEl.decode().catch(() => {}) : Promise.resolve();
  Promise.race([ready, new Promise((r) => setTimeout(r, 600))]).then(() =>
    requestAnimationFrame(() => requestAnimationFrame(() => veil.classList.add('lift', 'quick'))));
}

if (scene) {
  window.__scene3d = scene;
  if (enter && document.documentElement.classList.contains('entering')) {
    scene.intro(enter);
    if (snapEl.isConnected) scene.showSnap(snapEl, enter);
    setTimeout(() => { if (scene.introWaiting) scene.endIntro(); }, INTRO_WAIT_MS);
    const helpLater = () => {
      if (scene.introActive) { setTimeout(helpLater, 250); return; }
      if (!seen) help.hidden = false;
    };
    setTimeout(helpLater, INTRO_WAIT_MS);
  }
  scene.start();
  buildLayers();
  loadContext();
  loadScene();
}
