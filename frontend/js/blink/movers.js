// Moving-object data: known (SkyBoT), linked candidates, and the on-demand blind search.
const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '' && !(typeof v === 'number' && !isFinite(v))) p.set(k, String(v));
  return p.toString();
};
async function getJSON(path, params, signal) {
  const res = await fetch(`${path}?${qs(params || {})}`, { signal });
  if (!res.ok) { let m = `${res.status}`; try { const j = await res.json(); if (j.detail) m = String(j.detail); } catch (_) { /* ignore */ } throw new Error(m); }
  return res.json();
}

const pts = (positions) => (positions || []).filter((q) => isFinite(q.x) && isFinite(q.y) && isFinite(q.mjd))
  .map((q) => ({ mjd: q.mjd, x: q.x, y: q.y })).sort((a, b) => a.mjd - b.mjd);

export async function loadCoverage(signal) {
  try { const j = await getJSON('/api/coverage', {}, signal); return (j.fields || []).filter((f) => isFinite(f.ra) && isFinite(f.dec)); } catch (_) { return []; }
}

export async function loadKnown(params, signal) {
  const j = await getJSON('/api/movers/known', params, signal);
  return (j.objects || []).map((o, i) => ({
    key: `k${i}:${o.name}`, kind: 'known', label: o.name || `K${i + 1}`, short: (o.name || `K${i + 1}`).replace(/^\(\d+\)\s*/, ''),
    sub: [o.number ? `asteroid ${o.number}` : 'known solar-system object', o.class].filter(Boolean).join(' · '),
    rate: o.rate_arcsec_h, pa: o.pa_deg, vmag: o.vmag, snr: o.stack && o.stack.snr, detected: o.stack ? o.stack.detected : null, pts: pts(o.positions),
  })).filter((m) => m.pts.length).sort((a, b) => (b.detected ? 1 : 0) - (a.detected ? 1 : 0) || (a.vmag || 99) - (b.vmag || 99));
}
// The linker also returns chance alignments of faint detections (hundreds per field, confidence about 0.3).
// Only links the server is reasonably sure about are drawn and listed.
export const LINKED_MIN_CONFIDENCE = 0.4, LINKED_MAX = 8, CAND_MAX = 12;
export async function loadLinked(params, signal) {
  const j = await getJSON('/api/movers/linked', params, signal);
  return (j.movers || []).map((o, i) => ({
    key: `m${i}:${o.id}`, kind: 'linked', label: o.id || `M${i + 1}`, short: o.id || `M${i + 1}`, sub: 'mover candidate found in these frames',
    rate: o.rate_arcsec_h, pa: o.pa_deg, confidence: o.confidence, pts: pts(o.positions),
  })).filter((m) => m.pts.length && !(m.confidence < LINKED_MIN_CONFIDENCE)).sort((a, b) => b.confidence - a.confidence).slice(0, LINKED_MAX);
}
const candOf = (o, i) => ({
  key: `c:${o.id}`, kind: 'candidate', label: o.id || `C${i + 1}`, short: o.id || `C${i + 1}`, sub: 'unknown mover candidate',
  rate: o.rate_arcsec_h, pa: o.pa_deg, confidence: o.confidence, snr: o.snr, pts: pts(o.positions),
});

export class SearchJob {
  constructor(params, onUpdate) { this.params = params; this.onUpdate = onUpdate; this.job = null; this.timer = 0; this.stopped = false; }
  async start() {
    try {
      const r = await getJSON('/api/movers/search/start', this.params);
      this.job = r.job;
      if (this.stopped) { this.cancel(); return; }
      this._poll();
    } catch (e) { this.onUpdate({ state: 'error', error: e.message, progress: 0, candidates: [] }); }
  }
  async _poll() {
    if (this.stopped) return;
    try {
      const s = await getJSON('/api/movers/search/status', { job: this.job });
      if (this.stopped) return;
      this.onUpdate({ state: s.state, progress: s.progress || 0, tried: s.tried, total: s.total, found: (s.candidates || []).length, candidates: (s.candidates || []).map(candOf).filter((m) => m.pts.length).sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, CAND_MAX) });
      if (s.state === 'running') this.timer = setTimeout(() => this._poll(), 1500);
    } catch (e) { if (!this.stopped) this.onUpdate({ state: 'error', error: e.message, progress: 0, candidates: [] }); }
  }
  cancel() {
    this.stopped = true; clearTimeout(this.timer);
    if (this.job) fetch(`/api/movers/search/cancel?${qs({ job: this.job })}`).catch(() => {});
  }
}

/** Position of a mover at time mjd (linear between samples, clamped at the ends). */
export function positionAt(m, mjd) {
  const p = m.pts;
  if (!p.length) return null;
  if (mjd <= p[0].mjd) return { x: p[0].x, y: p[0].y };
  const last = p[p.length - 1];
  if (mjd >= last.mjd) return { x: last.x, y: last.y };
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p[mid].mjd <= mjd) lo = mid; else hi = mid; }
  const t = (mjd - p[lo].mjd) / (p[hi].mjd - p[lo].mjd || 1);
  return { x: p[lo].x + (p[hi].x - p[lo].x) * t, y: p[lo].y + (p[hi].y - p[lo].y) * t };
}
/** Path up to (and including) mjd, for trails. */
export function pathUntil(m, mjd) {
  const out = [];
  for (const q of m.pts) { if (q.mjd <= mjd + 1e-9) out.push(q); }
  const cur = positionAt(m, mjd);
  if (cur && (!out.length || out[out.length - 1].mjd < mjd)) out.push({ mjd, x: cur.x, y: cur.y });
  return out;
}
export const dirName = (pa) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((pa % 360) + 360) % 360) / 45) % 8];
