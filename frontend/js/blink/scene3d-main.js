// Page controller for scene3d.html: reads the patch from the URL, loads the bright context stars (a static file) and
// the Gaia stars plus solar system for the patch (/api/scene3d), and wires the HUD to the Scene3D renderer.
import { getScene3D } from '../api.js';
import { Scene3D, fmtNum } from './scene3d.js';
import { contextStars, LY_PER_PC as LY } from './scene3d-math.js';
import { fmtRA, fmtDec, fmtDeg } from './util.js';

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

// ---------------------------------------------------------------- static text
$('coords').textContent = `RA ${fmtRA(ra)} · Dec ${fmtDec(dec)}`;
$('cone-r').textContent = fmtNum(radius, 3);
$('btn-back').href = `./?ra=${fmtDeg(ra)}&dec=${fmtDeg(dec)}`;
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
  $('hud-scene').textContent = stars ? 'Stars' : `Solar system${solarDate ? ' · ' + solarDate : ''}`;
  $('hud-dist').textContent = stars ? `${fmtNum(h.dist)} pc · ${fmtNum(h.dist * LY)} ly` : `${fmtNum(h.dist)} AU`;
  $('hud-speed').textContent = `${fmtNum(h.speed)} ${h.unit}/s`;
  const c = h.counts;
  $('hud-count').textContent = stars
    ? (c.gaia ? `${c.gaia.toLocaleString('en-US')} Gaia stars · ${c.ctx.toLocaleString('en-US')} bright stars around`
      : gaiaState === 'error' ? `No Gaia stars · ${c.ctx.toLocaleString('en-US')} bright stars around` : 'Gaia stars loading…')
    : `${c.planets} planets and moons · ${c.bodies} small bodies`;
  $('hud-limit').textContent = `${h.limit.toFixed(1)} mag · [ and ] change it`;
  $('hint').textContent = h.locked ? 'Esc releases the mouse' : 'Click the sky to fly';
  document.querySelectorAll('.scene-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scene === h.scene)));
}
function setNote(text) { const n = $('note'); n.textContent = text || ''; n.hidden = !text; }

// ---------------------------------------------------------------- renderer
let scene;
try {
  scene = new Scene3D({
    canvas: $('gl'), labels: $('labels'), card: $('card'), ra, dec, radius,
    onHud,
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
  $('btn-stars').disabled = true; $('btn-solar').disabled = true; $('btn-reset').disabled = true;
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
    showStatus(`Could not load the Gaia stars and the solar system for this patch: ${e.message}`, { error: true, retry: true });
  } finally {
    clearInterval(timer);
  }
}

// ---------------------------------------------------------------- controls
$('btn-stars').addEventListener('click', () => scene && scene.setScene('stars'));
$('btn-solar').addEventListener('click', () => scene && scene.setScene('solar'));
$('btn-reset').addEventListener('click', () => scene && scene.resetView());
$('status-retry').addEventListener('click', () => loadScene());

// Help: once, then only on '?'.
const help = $('help');
let seen = false;
try { seen = localStorage.getItem(HELP_KEY) === '1'; } catch (_) { /* storage blocked: show it every time */ }
help.hidden = seen;
$('help-start').addEventListener('click', () => {
  help.hidden = true;
  try { localStorage.setItem(HELP_KEY, '1'); } catch (_) { /* ignore */ }
});
window.addEventListener('keydown', (e) => { if (e.key === '?') help.hidden = !help.hidden; });

if (scene) {
  scene.start();
  loadContext();
  loadScene();
}
