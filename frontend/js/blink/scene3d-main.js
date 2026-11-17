// Page controller for scene3d.html: reads the patch from the URL, loads the bright context stars (a static file) and
// the Gaia stars plus solar system for the patch (/api/scene3d), and wires the HUD to the Scene3D renderer.
// This is the first view of a spot picked on the sphere; its SPHEREx frames load only from "Watch this patch change".
import { getScene3D, getCoverage } from '../api.js';
import { Scene3D, fmtNum } from './scene3d.js';
import { contextStars, LY_PER_PC as LY } from './scene3d-math.js';
import { AU_PER_PC } from './scene3d-frames.js';
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
let gaiaState = 'loading';   // loading | ok | error
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
  $('hud-count').textContent = stars
    ? (c.gaia ? `${c.gaia.toLocaleString('en-US')} Gaia stars · ${c.ctx.toLocaleString('en-US')} bright stars around`
      : gaiaState === 'error' ? `No Gaia stars · ${c.ctx.toLocaleString('en-US')} bright stars around` : 'Gaia stars loading…')
    : `${c.planets} planets and moons · ${c.bodies} small bodies`;
  $('hud-limit').textContent = `${h.limit.toFixed(1)} mag · [ and ] change it`;
  $('hint').textContent = h.flying ? 'Autopilot · Esc cancels' : h.locked ? 'WASD move · mouse look · wheel throttle · T auto/manual speed · Shift boost · G autopilot to the target · Esc release' : 'Click a star to select it · click empty sky to fly · WASD move · wheel throttle · T auto/manual speed · Shift boost · G autopilot';
  document.querySelectorAll('.scene-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scene === h.scene)));
  setEvidenceUi(h.evidence);
}
function setEvidenceUi(on) {
  $('btn-evidence').setAttribute('aria-pressed', String(!!on));
  $('ev-chip').hidden = !on;
}
function setNote(text) { const n = $('note'); n.textContent = text || ''; n.hidden = !text; }

// ---------------------------------------------------------------- renderer
let scene;
try {
  scene = new Scene3D({
    canvas: $('gl'), labels: $('labels'), card: $('card'), ra, dec, radius,
    onHud,
    onEvidence: setEvidenceUi,
    onScene: (name) => {
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
  $('btn-stars').disabled = true; $('btn-solar').disabled = true; $('btn-reset').disabled = true; $('btn-evidence').disabled = true;
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
async function loadScene() {
  const t0 = performance.now();
  const tick = () => showStatus(`Loading the Gaia stars and the solar system for this patch · ${Math.round((performance.now() - t0) / 1000)} s. A cold cache can take 30 to 90 s.`);
  tick();
  const timer = setInterval(tick, 1000);
  try {
    const p = await getScene3D({ ra, dec, radius, mjd });
    if (p.stars) {
      scene.setGaia(p.stars);
      scene.reveal();   // only moves the camera on an untouched arrival from the sphere or the frames
      const shown = Array.isArray(p.stars.rows) ? p.stars.rows.length : 0;
      $('warn').hidden = !p.stars.truncated && !p.stars.incomplete;
      $('warn').textContent = [
        p.stars.truncated ? `Showing the ${shown.toLocaleString('en-US')} brightest Gaia stars in the cone; fainter ones are left out.` : '',
        p.stars.incomplete ? 'Part of the cone failed to load, so some areas have no Gaia stars.' : '',
      ].filter(Boolean).join(' ');
    }
    if (p.solar) scene.setSolar(p.solar);
    gaiaState = 'ok';
    if (Number.isFinite(p.mjd)) solarDate = new Date((p.mjd - 40587) * 86400000).toISOString().slice(0, 10) + ' UTC';
    $('btn-solar').disabled = !scene.hasSolar;
    const bodiesNote = p.solar && p.solar.bodies_error ? `Small bodies are missing: ${p.solar.bodies_error}` : '';
    setNote(bodiesNote);
    hideStatus();
  } catch (e) {
    gaiaState = 'error';
    scene.endIntro();
    showStatus(`Could not load the Gaia stars and the solar system for this patch: ${e.message}`, { error: true, retry: true });
  } finally {
    clearInterval(timer);
    if (scene.introWaiting) scene.endIntro();   // no Gaia stars in the payload: nothing to reveal
  }
}

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
  loadContext();
  loadScene();
}
