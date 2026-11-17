// Drawing helpers for the rewind's sky layers: how bright the sky is for a Sun and Moon altitude, label
// placement without overlaps, the Sun and Moon discs, and which layers the viewer has switched on.
import { clamp, lerp, smooth } from './util.js';

const TAU = 2 * Math.PI;

// ------------------------------------------------------------------ layers
export const LAYERS = [
  { id: 'lines', label: 'Constellations', on: true },
  { id: 'cnames', label: 'Constellation names', on: true },
  { id: 'borders', label: 'Boundaries', on: false },
  { id: 'snames', label: 'Star names', on: true },
  { id: 'bodies', label: 'Sun, Moon and planets', on: true },
  { id: 'daylight', label: 'Daylight', on: true },
  { id: 'deepsky', label: 'Galaxies and nebulae', on: true },
];
const KEY = 'blink.rewind.layers';
export function loadLayers() {
  const out = Object.fromEntries(LAYERS.map((l) => [l.id, l.on]));
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const l of LAYERS) if (typeof saved[l.id] === 'boolean') out[l.id] = saved[l.id];
  } catch (_) { /* storage blocked or bad JSON: defaults */ }
  return out;
}
export function saveLayers(layers) {
  try { localStorage.setItem(KEY, JSON.stringify(layers)); } catch (_) { /* storage blocked */ }
}

// ------------------------------------------------------------------ sky brightness
/** Piecewise-linear lookup in [[x, y], ...] (y a number or an array). */
function table(stops, x) {
  if (x <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [b, vb] = stops[i];
    if (x <= b) {
      const [a, va] = stops[i - 1], t = (x - a) / (b - a);
      return Array.isArray(va) ? va.map((v, k) => lerp(v, vb[k], t)) : lerp(va, vb, t);
    }
  }
  return stops[stops.length - 1][1];
}
// By the Sun's geometric altitude (degrees). -0.83 deg is sunrise: refraction lifts the Sun by about that much.
const WASH = [[-18, 0], [-12, 0.35], [-6, 0.6], [-0.83, 0.92], [10, 0.97]];
const ZENITH = [[-18, [5, 7, 11]], [-12, [11, 27, 58]], [-6, [24, 46, 96]], [-0.83, [39, 74, 133]], [10, [93, 159, 224]]];
const HORIZON = [[-18, [9, 12, 20]], [-12, [26, 38, 70]], [-6, [72, 80, 116]], [-0.83, [150, 156, 178]], [10, [176, 208, 238]]];
const MLIM = [[-18, 6], [-12, 4], [-6, 1], [0, -4], [10, -4.5]];

/** Twilight name for a Sun altitude. */
export function twilight(h) {
  if (h > -0.83) return 'day';
  if (h > -6) return 'civil twilight';
  if (h > -12) return 'nautical twilight';
  if (h > -18) return 'astronomical twilight';
  return 'night';
}

/**
 * How the sky looks for a Sun altitude h and the Moon (altitude, lit fraction k), degrees.
 * wash: opacity of the sky colour over the map; mlim: faintest magnitude still seen; lineA, dsoA: how much of
 * the figure lines and deep-sky labels to keep; glow: warm twilight glow at the Sun's azimuth (0-1).
 */
export function skyLight(h, moonAlt = -90, moonK = 0) {
  const mUp = moonAlt > 0 ? Math.sin(moonAlt * Math.PI / 180) : 0, moon = mUp * moonK;
  let wash = table(WASH, h), zen = table(ZENITH, h), hor = table(HORIZON, h);
  if (moon > 0 && h < -6) {   // moonlight: a faint blue sky and fewer stars
    const m = 0.12 * moon * (1 - smooth((h + 12) / 6));
    wash = wash + m * (1 - wash);
    zen = zen.map((v, i) => lerp(v, [26, 42, 78][i], m * 2)); hor = hor.map((v, i) => lerp(v, [40, 52, 82][i], m * 2));
  }
  const mlim = table(MLIM, h) - 1.5 * moon;
  return {
    h, wash, zen, hor, mlim,
    lineA: 1 - 0.85 * smooth((h + 12) / 8) - 0.2 * moon,
    dsoA: (1 - smooth((h + 15) / 6)) * (1 - 0.6 * moon),
    glow: h > -10 && h < 5 ? 0.6 * (1 - Math.abs(h + 2.5) / 7.5) : 0,
  };
}
/** Night light: what the overlay uses when daylight is switched off. */
export const NIGHT = skyLight(-90);

const css = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(3)})`;
/**
 * Paints the sky colour over the map: a vertical gradient from the horizon (yHor) to high up (yTop), and the
 * warm glow where the Sun is near the horizon (glowAt: screen point on the horizon below the Sun, or null).
 */
export function drawWash(ctx, W, H, L, a, yHor, yTop, glowAt, pxPerDeg) {
  if (a * L.wash < 0.003) return;
  ctx.save();
  const y0 = Number.isFinite(yHor) ? yHor : H, y1 = Number.isFinite(yTop) && yTop < y0 - 10 ? yTop : Math.min(y0 - 10, 0);
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, css(L.hor, a * L.wash)); g.addColorStop(1, css(L.zen, a * L.wash));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (glowAt && L.glow > 0.01) {
    const r = Math.max(80, 40 * pxPerDeg), rg = ctx.createRadialGradient(glowAt.x, glowAt.y, 0, glowAt.x, glowAt.y, r);
    const k = a * L.glow;
    rg.addColorStop(0, `rgba(255,160,90,${(0.55 * k).toFixed(3)})`); rg.addColorStop(0.45, `rgba(240,120,90,${(0.22 * k).toFixed(3)})`); rg.addColorStop(1, 'rgba(240,120,90,0)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}

// ------------------------------------------------------------------ Sun and Moon
export function drawSun(ctx, q, r, h, a) {
  const warm = clamp((8 - h) / 10, 0, 1), core = [255, lerp(250, 205, warm), lerp(235, 150, warm)];
  const g = ctx.createRadialGradient(q.x, q.y, r * 0.6, q.x, q.y, r * 7);
  g.addColorStop(0, css(core, 0.55 * a)); g.addColorStop(0.3, css(core, 0.14 * a)); g.addColorStop(1, css(core, 0));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q.x, q.y, r * 7, 0, TAU); ctx.fill();
  ctx.fillStyle = css(core, a); ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, TAU); ctx.fill();
}
/**
 * The Moon's disc at q, radius r (px), lit fraction k, with the bright limb towards screen angle phi (radians,
 * the direction of the Sun on screen). The dark part is drawn faintly (earthshine).
 */
export function drawMoon(ctx, q, r, k, phi, a) {
  ctx.save();
  ctx.translate(q.x, q.y); ctx.rotate(phi);
  if (k > 0.25) {
    const g = ctx.createRadialGradient(0, 0, r, 0, 0, r * 4);
    g.addColorStop(0, `rgba(230,232,240,${(0.22 * a * k).toFixed(3)})`); g.addColorStop(1, 'rgba(230,232,240,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r * 4, 0, TAU); ctx.fill();
  }
  ctx.fillStyle = `rgba(48,52,62,${(0.75 * a).toFixed(3)})`; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
  const rx = r * Math.abs(2 * k - 1);
  ctx.fillStyle = `rgba(240,236,222,${a.toFixed(3)})`;
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);                         // the sunward half
  if (k >= 0.5) ctx.ellipse(0, 0, rx, r, 0, Math.PI / 2, 3 * Math.PI / 2, false);   // gibbous: bulge away from the Sun
  else ctx.ellipse(0, 0, rx, r, 0, Math.PI / 2, -Math.PI / 2, true);              // crescent: cut back towards it
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------------ labels
/**
 * Greedy label placement: labels are added with a priority (lower first), then placed in that order at the
 * first candidate position that overlaps nothing placed so far; labels that cannot be placed are dropped.
 */
export class Labeler {
  constructor(ctx, W, H) { this.ctx = ctx; this.W = W; this.H = H; this.items = []; this.boxes = []; this.widths = new Map(); }
  /** Keeps an area clear (a disc or a marker). */
  block(x, y, w, h) { this.boxes.push([x - w / 2, y - h / 2, x + w / 2, y + h / 2]); }
  /**
   * item: { text, x, y, prio, font, size, color, mode ('point' beside a mark, 'centre' on the spot),
   *         gap (px from the mark), spacing (letter spacing, px), alpha }
   */
  add(item) { if (item.alpha > 0.02 && item.text) this.items.push(item); }
  _width(it) {
    const key = `${it.font}|${it.spacing || 0}|${it.text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      const c = this.ctx; c.font = it.font;
      w = c.measureText(it.text).width + (it.spacing || 0) * it.text.length;
      this.widths.set(key, w);
    }
    return w;
  }
  _free(b) {
    if (b[0] < 4 || b[2] > this.W - 4 || b[1] < 2 || b[3] > this.H - 2) return false;
    for (const o of this.boxes) if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) return false;
    return true;
  }
  flush() {
    const c = this.ctx;
    this.items.sort((a, b) => a.prio - b.prio);
    c.save();
    c.textBaseline = 'middle'; c.textAlign = 'left'; c.shadowColor = 'rgba(5,7,11,.95)'; c.shadowBlur = 5;
    for (const it of this.items) {
      const w = this._width(it), h = (it.size || 12) + 2, g = it.gap ?? 8, pad = 2;
      const cands = it.mode === 'centre'
        ? [[it.x - w / 2, it.y], [it.x - w / 2, it.y - h], [it.x - w / 2, it.y + h]]
        : [[it.x + g, it.y], [it.x - g - w, it.y], [it.x - w / 2, it.y - h + 1 - g / 2], [it.x - w / 2, it.y + h - 1 + g / 2]];
      for (const [x, y] of cands) {
        const box = [x - pad, y - h / 2, x + w + pad, y + h / 2];
        if (!this._free(box)) continue;
        this.boxes.push(box);
        c.font = it.font; c.fillStyle = it.color.replace('$a', clamp(it.alpha, 0, 1).toFixed(3));
        if ('letterSpacing' in c) c.letterSpacing = `${it.spacing || 0}px`;
        c.fillText(it.text, x, y);
        break;
      }
    }
    if ('letterSpacing' in c) c.letterSpacing = '0px';
    c.restore();
  }
}
