// "What exists" histogram: one row per detector, frames binned over time, epochs shaded.
import { DET_COLORS } from './palette.js';
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export function drawTimeline(cv, meta, epochs, loaded, detSel, hoverMjd, emptyMsg) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  g.font = '11px ui-monospace, Menlo, monospace';
  const mute = css('--mute');
  if (!meta.length) { g.fillStyle = mute; g.fillText(emptyMsg || 'No exposures found at this position.', 10, 20); return; }
  const L = 34, R = 8, T = 6, B = 20, pw = W - L - R, rows = 6, rh = (H - T - B) / rows;
  let lo = Infinity, hi = -Infinity;
  for (const f of meta) { lo = Math.min(lo, f.mjd); hi = Math.max(hi, f.mjd_end || f.mjd); }
  const pad = Math.max(3, (hi - lo) * 0.02); lo -= pad; hi += pad;
  const X = (m) => L + ((m - lo) / (hi - lo)) * pw;
  let labEnd = -Infinity;
  epochs.forEach((e, i) => {
    const a = X(e.lo - 1), b = Math.max(X(e.hi + 1), a + 2);
    g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(a, T, b - a, rows * rh);
    // Long label if it fits, else just "E<n>", else nothing (avoid overlapping text).
    g.fillStyle = mute; g.textAlign = 'left';
    for (const t of [`E${e.n} · MJD ${e.lo.toFixed(0)}`, `E${e.n}`]) {
      const w = g.measureText(t).width, x = Math.min(W - R - w, Math.max(L, (a + b) / 2 - w / 2));
      if (x > labEnd + 6) { g.fillText(t, x, H - 6); labEnd = x + w; break; }
    }
  });
  const nb = Math.max(20, Math.floor(pw / 3)), bw = (hi - lo) / nb;
  for (let d = 1; d <= 6; d++) {
    const y = T + (d - 1) * rh, tot = new Uint16Array(nb), got = new Uint16Array(nb);
    for (const f of meta) if (f.detector === d) { const k = Math.min(nb - 1, Math.floor((f.mjd - lo) / bw)); tot[k]++; if (loaded.has(f.id)) got[k]++; }
    const mx = Math.max(1, ...tot), on = detSel.includes(d);
    g.fillStyle = on ? DET_COLORS[d] : mute; g.textAlign = 'right'; g.fillText('D' + d, L - 6, y + rh / 2 + 4);
    for (let k = 0; k < nb; k++) {
      if (!tot[k]) continue;
      const x = L + (k / nb) * pw, w = Math.max(1.5, pw / nb - 0.5), h = Math.max(3, (rh - 3) * (0.35 + 0.65 * tot[k] / mx));
      g.globalAlpha = on ? 0.28 : 0.1; g.fillStyle = DET_COLORS[d]; g.fillRect(x, y + rh - 1.5 - h, w, h);
      if (got[k]) { g.globalAlpha = on ? 1 : 0.4; const h2 = h * got[k] / tot[k]; g.fillRect(x, y + rh - 1.5 - h2, w, h2); }
    }
    g.globalAlpha = 1;
  }
  if (hoverMjd) { const x = X(hoverMjd); g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + rows * rh); g.stroke(); }
}
