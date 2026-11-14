// All view state lives in the URL query string; the page boots from it.
const NUM = new Set(['ra', 'dec', 'fov', 'pmra', 'pmdec', 'epoch', 'sdet', 'cap', 'hi', 'speed', 'mjd_min', 'mjd_max', 'frame']);
const BOOL = new Set(['embed', 'lock', 'bg', 'marker', 'flags', 'gaia', 'catwise', 'smooth', 'ignoreflag', 'median', 'play']);
const LIST = new Set(['det', 'flagbits']);

export const DEFAULTS = {
  ra: null, dec: null, fov: 0.1, q: '', pmra: null, pmdec: null, epoch: null,
  det: [1, 2, 3, 4, 5, 6], sdet: null, mode: 'frames', stretch: 'asinh', cmap: 'gray',
  embed: false, lock: true, bg: true, marker: true, flags: false, gaia: false, catwise: false,
  smooth: false, hi: 99.5, speed: 6, cap: 400, mjd_min: null, mjd_max: null,
  median: true, ignoreflag: false, ea: null, eb: null, frame: null, play: true, flagbits: null, loop: 'loop',
  rgb: '5,3,1', estack: 'all', catdepth: 'mid',
};

export const S = { ...DEFAULTS, det: [...DEFAULTS.det] };

export function readURL() {
  const p = new URLSearchParams(location.search);
  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (!p.has(k)) continue;
    const v = p.get(k);
    if (NUM.has(k)) { const n = parseFloat(v); S[k] = isFinite(n) ? n : def; }
    else if (BOOL.has(k)) S[k] = v === '1' || v === 'true';
    else if (LIST.has(k)) { const l = v.split(',').map(Number).filter((n) => isFinite(n)); S[k] = l.length ? l : def; }
    else S[k] = v;
  }
  if (p.has('name') && !p.has('q')) S.q = p.get('name');
}

const sameVal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function writeURL() {
  const p = new URLSearchParams();
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = S[k];
    if (v === null || v === undefined || v === '' || sameVal(v, def)) continue;
    if (BOOL.has(k)) p.set(k, v ? '1' : '0');
    else if (Array.isArray(v)) p.set(k, v.join(','));
    else p.set(k, typeof v === 'number' ? String(+v.toFixed(7)) : v);
  }
  // embed must always be written when set; bool defaults that are true need explicit 0 when false (handled above)
  const s = p.toString();
  history.replaceState(null, '', s ? `?${s}` : location.pathname);
}

export function set(patch) { Object.assign(S, patch); writeURL(); }

export function linkURL(embed) {
  const u = new URL(location.href);
  u.searchParams.delete('embed');
  if (embed) u.searchParams.set('embed', '1');
  return u.toString();
}
