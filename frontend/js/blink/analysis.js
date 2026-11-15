// Display limits (locked across frames) and the "unexplained light" finder.
import { autoLimits, symLimits } from '../render.js';
import { sampleFinite, pctOf } from '../data.js';

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

/** Limits for every layer/mode sampled across loaded frames; locked by the caller. */
export function computeLimits(frames) {
  if (!frames.length) return null;
  const pick = (arr, k = 6) => {
    if (arr.length <= k) return arr;
    const out = [];
    for (let i = 0; i < k; i++) out.push(arr[Math.floor((i * (arr.length - 1)) / (k - 1))]);
    return out;
  };
  const use = pick(frames, 6), modUse = pick(frames.filter((f) => f.bg), 6);
  const rawLo = [], rawHi = [], lf = [], bgLo = [], bgHi = [], peakAmp = [];
  for (const f of use) {
    const l = autoLimits(f.img, 99.5); rawLo.push(l.lo); rawHi.push(l.hi);
  }
  for (const f of modUse) {
    const bs = sampleFinite(f.bg, 8192).sort((x, y) => x - y);
    if (bs.length) { bgLo.push(pctOf(bs, 5)); bgHi.push(pctOf(bs, 99.5)); }
    if (f.left) lf.push(symLimits(f.left, 99.5).hi);
    if (f.sources && f.sources.length) {
      const amps = f.sources.map((s) => s.amp || 0).filter((a) => a > 0).sort((a, b) => a - b);
      if (amps.length) peakAmp.push(pctOf(amps, 90));
    }
  }
  let lo = median(rawLo), hi = median(rawHi);
  if (!(hi > lo)) hi = lo + 1e-6;
  const noise = use[0].noise || 0.01;
  // Difference mode shows each frame minus the one before it, so its range comes from two
  // time-adjacent frames (frames are MJD-sorted), not from the spread-out sample above.
  let d = NaN;
  if (frames.length > 1) {
    const a = frames[0].img, b = frames[1].img, diff = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) diff[i] = Math.abs(a[i] - b[i]);
    const s = sampleFinite(diff, 8192).sort((x, y) => x - y);
    if (s.length) d = pctOf(s, 99.5);
  }
  if (!(d > 0)) d = 4 * noise;
  const lh = lf.length ? median(lf) : 4 * noise;
  // Model layer: black point at the dark end of the smooth background so the sky sits on the ground
  // colour; the white point scales with both the star dynamic range and diffuse background spread
  // so later visits do not wash grey under asinh. The background top skips the single brightest
  // sampled frame (when there are 3+) so one bad fit cannot dim every frame. Source glows keep the
  // raw range (`star`) so their brightness ordering matches the raw pixels.
  const star = Math.max(hi - lo, 1e-6);
  const starRange = Math.max(star, peakAmp.length ? median(peakAmp) : 0);
  let mlo = lo, mhi = hi;
  if (bgLo.length) {
    mlo = median(bgLo);
    const tops = [...bgHi].sort((x, y) => x - y);
    const bgTop = tops[tops.length >= 3 ? tops.length - 2 : tops.length - 1];
    const bgSpan = Math.max(0, bgTop - mlo);
    mhi = mlo + Math.max(0.5 * starRange, bgSpan * 8, 6 * noise);
  }
  return {
    model: { lo: mlo, hi: mhi, star }, raw: { lo, hi }, trail: { lo, hi },
    leftover: { lo: -lh, hi: lh }, diff: { lo: -d, hi: d },
  };
}

/**
 * Smoothed leftover/noise on overlapping blocks; local maxima above `thresh` sigma that sit away from
 * fitted sources are "possible faint objects". Returns [{x, y, z}] in grid pixels, best first.
 */
export function findUnexplained(left, npix, noise, psfPx, sources, thresh = 8, maxN = 6) {
  if (!left || !(noise > 0)) return [];
  const k = Math.max(3, Math.round((psfPx || 2) * 1.6)), step = Math.max(1, k >> 1);
  const nb = Math.floor((npix - k) / step) + 1;
  if (nb < 3) return [];
  const z = new Float32Array(nb * nb);
  for (let by = 0; by < nb; by++) for (let bx = 0; bx < nb; bx++) {
    let sum = 0, n = 0;
    for (let y = by * step; y < by * step + k; y++) {
      const row = y * npix;
      for (let x = bx * step; x < bx * step + k; x++) { const v = left[row + x]; if (v === v) { sum += v; n++; } }
    }
    z[by * nb + bx] = n > 0.75 * k * k ? sum / (noise * Math.sqrt(n)) : 0;
  }
  const out = [];
  for (let by = 1; by < nb - 1; by++) for (let bx = 1; bx < nb - 1; bx++) {
    const v = z[by * nb + bx];
    if (v < thresh) continue;
    let ok = true;
    for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && z[(by + dy) * nb + bx + dx] > v) { ok = false; break; }
    if (!ok) continue;
    const x = bx * step + (k - 1) / 2, y = by * step + (k - 1) / 2;
    if (sources && sources.some((s) => Math.hypot(s.x - x, s.y - y) < (psfPx || 2) * 1.5 && s.snr > 30)) continue;
    out.push({ x, y, z: v });
  }
  out.sort((a, b) => b.z - a.z);
  return out.slice(0, maxN);
}
