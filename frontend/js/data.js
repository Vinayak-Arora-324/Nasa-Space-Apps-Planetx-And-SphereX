// Frame store, epoch clustering, per-frame background and co-adds.
export const EPOCH_GAP = 20; // days

export const BANDS = [
  null,
  { lo: 0.75, hi: 1.09 }, { lo: 1.10, hi: 1.62 }, { lo: 1.63, hi: 2.41 },
  { lo: 2.42, hi: 3.82 }, { lo: 3.83, hi: 4.41 }, { lo: 4.42, hi: 5.00 },
];

/** Sorted-mjd clustering. Returns [{n, lo, hi}] */
export function clusterEpochs(spans) {
  const s = [...spans].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a - last.hi <= EPOCH_GAP) last.hi = Math.max(last.hi, b);
    else out.push({ n: out.length + 1, lo: a, hi: b });
  }
  return out;
}

export function sampleFinite(a, max = 4096) {
  const step = Math.max(1, Math.floor(a.length / max));
  const t = [];
  for (let i = 0; i < a.length; i += step) { const v = a[i]; if (v === v) t.push(v); }
  return t;
}
export function pctOf(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))];
}
export function medianOf(a) {
  const t = sampleFinite(a, 6000).sort((x, y) => x - y);
  return t.length ? pctOf(t, 50) : NaN;
}

export class Store {
  constructor() { this.reset(); }
  reset() {
    this.frames = [];        // ok frames, sorted by mjd
    this.failed = [];
    this.byId = new Map();
    this.start = null;
    this.metaEpochs = null;  // from /api/frames (all detectors)
    this.version = 0;
  }
  setMeta(frames) {
    this.metaEpochs = frames.length ? clusterEpochs(frames.map((f) => [f.mjd, f.mjd_end || f.mjd])) : [];
  }
  epochRanges() {
    if (this.metaEpochs && this.metaEpochs.length) return this.metaEpochs;
    return clusterEpochs(this.frames.map((f) => [f.mjd, f.mjd]));
  }
  epochOf(mjd) {
    const r = this.epochRanges();
    for (const e of r) if (mjd >= e.lo - 1e-6 && mjd <= e.hi + EPOCH_GAP) return e.n;
    return r.length || 1;
  }
  add(meta, img, flags) {
    if (!meta.ok) { this.failed.push(meta); this.version++; return null; }
    const f = { ...meta, img, flags, med: medianOf(img), _sub: null };
    f.epoch = this.epochOf(f.mjd);
    let lo = 0, hi = this.frames.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.frames[m].mjd <= f.mjd) lo = m + 1; else hi = m; }
    this.frames.splice(lo, 0, f);
    this.byId.set(f.id, f);
    this.version++;
    return f;
  }
  relabelEpochs() { for (const f of this.frames) f.epoch = this.epochOf(f.mjd); }
  count(det) { return this.frames.filter((f) => f.detector === det).length; }
}

export function subOf(f) {
  if (f._sub) return f._sub;
  const out = new Float32Array(f.img.length), m = f.med;
  for (let i = 0; i < out.length; i++) out[i] = f.img[i] - m;
  return (f._sub = out);
}

/**
 * Co-add frames. opts: {method:'median'|'mean', bg, flagMask, shifts:[[dx,dy]...]}
 * shifts: integer pixel offsets; out(x,y) = src(x+dx, y+dy).
 */
export function coadd(frames, npix, opts) {
  const N = npix * npix, n = frames.length;
  const out = new Float32Array(N), fl = new Uint32Array(N);
  const srcs = frames.map((f) => (opts.bg ? subOf(f) : f.img));
  const tmp = new Float32Array(n);
  const mask = opts.flagMask >>> 0;
  const sh = opts.shifts;
  for (let y = 0; y < npix; y++) for (let x = 0; x < npix; x++) {
    const p = y * npix + x;
    let m = 0, sum = 0;
    for (let k = 0; k < n; k++) {
      let q = p;
      if (sh) {
        const sx = x + sh[k][0], sy = y + sh[k][1];
        if (sx < 0 || sy < 0 || sx >= npix || sy >= npix) continue;
        q = sy * npix + sx;
      }
      fl[p] |= frames[k].flags[q];
      const v = srcs[k][q];
      if (v === v && !(mask && (frames[k].flags[q] & mask))) { tmp[m++] = v; sum += v; }
    }
    if (!m) out[p] = NaN;
    else if (opts.method === 'mean') out[p] = sum / m;
    else if (m === 1) out[p] = tmp[0];
    else {
      const s = tmp.subarray(0, m); s.sort();
      out[p] = m & 1 ? s[m >> 1] : 0.5 * (s[(m >> 1) - 1] + s[m >> 1]);
    }
  }
  return { img: out, flags: fl };
}
