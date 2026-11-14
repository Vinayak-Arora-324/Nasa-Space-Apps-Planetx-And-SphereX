// Colour maps, stretches and pixel painting.
import { sampleFinite, pctOf } from './data.js';

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function ramp(stops) {
  const c = stops.map(hex), out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (c.length - 1), k = Math.min(c.length - 2, Math.floor(t)), f = t - k;
    for (let j = 0; j < 3; j++) out[i * 3 + j] = Math.round(c[k][j] * (1 - f) + c[k + 1][j] * f);
  }
  return out;
}
export const CMAPS = {
  gray: ramp(['#000000', '#ffffff']),
  igray: ramp(['#ffffff', '#000000']),
  viridis: ramp(['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725']),
  magma: ramp(['#000004', '#140e36', '#3b0f70', '#641a80', '#8c2981', '#b73779', '#de4968', '#f7705c', '#fe9f6d', '#fecf92', '#fcfdbf']),
  // Dark-centred diverging map (blue = negative, red = positive) so that zero matches the dark UI
  // and faint residuals stay visible; a light-centred map made difference images glare white.
  div: ramp(['#b9d7ff', '#4a90e2', '#1d4a8a', '#0d1420', '#8a2a1d', '#e2553a', '#ffc4a8']),
};
export const CMAP_LABELS = { gray: 'Grey', igray: 'Inverted grey', viridis: 'Viridis', magma: 'Magma' };

const STRETCH_FN = {
  linear: (t) => t,
  asinh: (t) => Math.asinh(t * 10) / Math.asinh(10),
  log: (t) => Math.log10(1 + 999 * t) / 3,
};
const lutCache = {};
function stretchLut(name) {
  if (lutCache[name]) return lutCache[name];
  const f = STRETCH_FN[name] || STRETCH_FN.linear, a = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) a[i] = Math.round(255 * Math.min(1, Math.max(0, f(i / 1023))));
  return (lutCache[name] = a);
}

const limCache = new WeakMap();
export function autoLimits(img, hiPct) {
  let m = limCache.get(img); if (!m) limCache.set(img, (m = {}));
  const key = hiPct;
  if (m[key]) return m[key];
  const s = sampleFinite(img, 8192).sort((a, b) => a - b);
  const lim = s.length ? limitsFromSorted(s, hiPct) : { lo: 0, hi: 1 };
  return (m[key] = lim);
}
export function limitsFromSorted(s, hiPct) {
  let lo = pctOf(s, 2), hi = pctOf(s, hiPct);
  if (!(hi > lo)) hi = lo + 1e-6;
  return { lo, hi };
}
export function symLimits(img, hiPct) {
  const s = sampleFinite(img, 8192).map(Math.abs).sort((a, b) => a - b);
  const m = s.length ? pctOf(s, hiPct) : 1;
  return { lo: -m || -1e-6, hi: m || 1e-6 };
}

let off = null;
export function offscreen(n) {
  if (!off) off = document.createElement('canvas');
  if (off.width !== n || off.height !== n) { off.width = n; off.height = n; }
  return off;
}

/** Paint a single-band image into a fresh canvas (npix x npix). */
export function paint(img, npix, lim, stretch, cmapName, into) {
  const cv = into || document.createElement('canvas');
  cv.width = npix; cv.height = npix;
  const ctx = cv.getContext('2d'), id = ctx.createImageData(npix, npix), d = id.data;
  const cm = CMAPS[cmapName] || CMAPS.gray, sl = stretchLut(cmapName === 'div' ? 'linear' : stretch);
  const inv = 1 / (lim.hi - lim.lo), nan = cmapName === 'div' ? [58, 58, 64] : [18, 22, 34];
  for (let i = 0; i < img.length; i++) {
    const v = img[i], o = i * 4;
    if (v !== v) { d[o] = nan[0]; d[o + 1] = nan[1]; d[o + 2] = nan[2]; d[o + 3] = 255; continue; }
    let t = (v - lim.lo) * inv; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ci = sl[(t * 1023) | 0] * 3;
    d[o] = cm[ci]; d[o + 1] = cm[ci + 1]; d[o + 2] = cm[ci + 2]; d[o + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return cv;
}

/** RGB composite: each channel gets its own limits and the chosen stretch. */
export function paintRGB(imgs, npix, hiPct, stretch, into) {
  const cv = into || document.createElement('canvas');
  cv.width = npix; cv.height = npix;
  const ctx = cv.getContext('2d'), id = ctx.createImageData(npix, npix), d = id.data;
  const sl = stretchLut(stretch);
  imgs.forEach((img, ch) => {
    const lim = img ? autoLimits(img, hiPct) : { lo: 0, hi: 1 }, inv = 1 / (lim.hi - lim.lo);
    for (let i = 0; i < npix * npix; i++) {
      const v = img ? img[i] : NaN, o = i * 4;
      d[o + 3] = 255;
      if (v !== v) { d[o + ch] = 14; continue; }
      let t = (v - lim.lo) * inv; t = t < 0 ? 0 : t > 1 ? 1 : t;
      d[o + ch] = sl[(t * 1023) | 0];
    }
  });
  ctx.putImageData(id, 0, 0);
  return cv;
}

/** Translucent mask canvas for flagged pixels. */
export function paintFlags(flags, npix, mask, into) {
  const cv = into || document.createElement('canvas');
  cv.width = npix; cv.height = npix;
  const ctx = cv.getContext('2d'), id = ctx.createImageData(npix, npix), d = id.data;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] & mask) { const o = i * 4; d[o] = 255; d[o + 1] = 40; d[o + 2] = 200; d[o + 3] = 120; }
  }
  ctx.putImageData(id, 0, 0);
  return cv;
}
