// Small shared helpers: maths, coordinate parsing and formatting, URL state.
export const D2R = Math.PI / 180;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
export const lerp = (a, b, t) => a + (b - a) * t;
export const lerpLog = (a, b, t) => Math.exp(lerp(Math.log(a), Math.log(b), t));
export const wrap360 = (a) => ((a % 360) + 360) % 360;
/** Signed shortest difference b - a in degrees, in (-180, 180]. */
export const dRA = (a, b) => { let d = wrap360(b - a); if (d > 180) d -= 360; return d; };

/** Great-circle separation in degrees. */
export function separation(ra1, dec1, ra2, dec2) {
  const a = Math.sin((dec2 - dec1) * D2R / 2) ** 2 + Math.cos(dec1 * D2R) * Math.cos(dec2 * D2R) * Math.sin((ra2 - ra1) * D2R / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / D2R;
}

// ---- coordinate parsing (spec section 8) ----
export const RA_ERROR = 'Right ascension should be 0–360° or 00:00:00–23:59:59.';
export const DEC_ERROR = 'Declination should be between −90° and +90°.';

function sexagesimal(s) {
  // "18:00:00", "18h 00m 00s", "-29d00m30s", "−29° 00′ 30″", "18 00 00"
  const t = s.replace(/[hdms°′″'":]/gi, ' ').trim().split(/\s+/);
  if (t.length < 2 || t.length > 3 || !t.every((x) => /^\d+(\.\d+)?$/.test(x.replace(/^[+-]/, '')))) return null;
  const [a, b = 0, c = 0] = t.map((x) => parseFloat(x));
  if (b >= 60 || c >= 60) return null;
  return { v: Math.abs(a) + b / 60 + c / 3600, neg: /^-/.test(t[0]) };
}
const norm = (s) => String(s).trim().replace(/[−–—]/g, '-');

/** Returns degrees or null. */
export function parseRA(str) {
  const s = norm(str);
  if (!s) return null;
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) { const v = parseFloat(s); return v >= 0 && v < 360 ? v : null; }
  const x = sexagesimal(s);
  if (!x || x.neg) return null;
  const deg = x.v * 15;
  return deg >= 0 && deg < 360 ? deg : null;
}
export function parseDec(str) {
  const s = norm(str);
  if (!s) return null;
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) { const v = parseFloat(s); return v >= -90 && v <= 90 ? v : null; }
  const x = sexagesimal(s);
  if (!x) return null;
  const v = x.neg ? -x.v : x.v;
  return v >= -90 && v <= 90 ? v : null;
}

export function fmtRA(deg) {
  let s = Math.round(wrap360(deg) / 15 * 3600 * 10) / 10;
  if (s >= 86400) s -= 86400;
  const h = Math.floor(s / 3600), m = Math.floor((s - h * 3600) / 60), sec = s - h * 3600 - m * 60;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${sec.toFixed(1).padStart(4, '0')}s`;
}
export function fmtDec(deg) {
  const sign = deg < 0 ? '−' : '+';
  let s = Math.round(Math.abs(deg) * 3600);
  const d = Math.floor(s / 3600), m = Math.floor((s - d * 3600) / 60), sec = s - d * 3600 - m * 60;
  return `${sign}${String(d).padStart(2, '0')}° ${String(m).padStart(2, '0')}′ ${String(sec).padStart(2, '0')}″`;
}
export const fmtDeg = (v) => String(Math.round(v * 1e6) / 1e6);
export const fmtWidth = (w) => `${w}°`;

// ---- URL state (shareable links) ----
const KEYS = ['ra', 'dec', 'width', 'band', 'layer', 'mode'];
export function readUrlState() {
  const p = new URLSearchParams(location.search), out = {};
  const num = (k) => { const v = parseFloat(p.get(k)); return isFinite(v) ? v : null; };
  const ra = num('ra'), dec = num('dec');
  if (ra !== null && dec !== null && ra >= 0 && ra < 360 && Math.abs(dec) <= 90) { out.ra = ra; out.dec = dec; }
  const w = num('width') ?? num('fov');
  if (w !== null && w > 0 && w <= 3.5) out.width = w;
  const b = num('band'); if (b >= 1 && b <= 6) out.band = Math.round(b);
  if (['model', 'raw', 'leftover'].includes(p.get('layer'))) out.layer = p.get('layer');
  if (['video', 'blink', 'diff', 'trail'].includes(p.get('mode'))) out.mode = p.get('mode');
  return out;
}
export function writeUrlState(st) {
  const p = new URLSearchParams();
  for (const k of KEYS) {
    const v = st[k];
    if (v === null || v === undefined || v === '') continue;
    p.set(k, typeof v === 'number' ? String(Math.round(v * 1e5) / 1e5) : v);
  }
  const s = p.toString();
  try { history.replaceState(null, '', s ? `?${s}` : location.pathname); } catch (_) { /* sandboxed */ }
}

export const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) n.append(c);
  return n;
};
