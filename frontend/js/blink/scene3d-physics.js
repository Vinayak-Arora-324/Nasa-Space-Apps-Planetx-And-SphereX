// Stellar physics for the 3D fly-through: colours, Teff/L/R estimates and the single "what do we render and how
// sure are we" decision (starModel). Pure and DOM-free so node can test it (tests/scene3d-physics.test.mjs).

export const AU_PER_PC = 206264.806;
export const RSUN_AU = 0.00465047;
export const REARTH_AU = 4.2635e-5;
export const RJUP_AU = 4.7789e-4;
export const TEFF_SUN = 5772;
export const MBOL_SUN = 4.74;

export const TIERS = ['measured', 'catalogue', 'inferred', 'illustrative'];
export const TIER_INFO = {
  measured: { glyph: '●', label: 'Measured' },
  catalogue: { glyph: '◐', label: 'Catalogue model' },
  inferred: { glyph: '○', label: 'Inferred here' },
  illustrative: { glyph: '◌', label: 'Illustrative' },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// ---------------------------------------------------------------- colour
// Wyman, Sloan & Shirley (2013) multi-lobe fit to the CIE 1931 colour-matching functions.
const lobe = (l, mu, s1, s2) => { const t = (l - mu) / (l < mu ? s1 : s2); return Math.exp(-0.5 * t * t); };
const cmfX = (l) => 1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2);
const cmfY = (l) => 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1);
const cmfZ = (l) => 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8);

const C2 = 1.4388e7; // hc/k in nm K
function planckRgb(T) {
  let X = 0, Y = 0, Z = 0;
  for (let l = 360; l <= 830; l += 5) {
    const B = 1 / (Math.pow(l, 5) * (Math.expm1(C2 / (l * T)) || 1e-300));
    X += B * cmfX(l); Y += B * cmfY(l); Z += B * cmfZ(l);
  }
  // XYZ -> linear sRGB (D65). Out-of-gamut negatives (very hot / cool stars) are clamped.
  let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  let g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  let b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
  r = Math.max(r, 0); g = Math.max(g, 0); b = Math.max(b, 0);
  const m = Math.max(r, g, b) || 1;
  return [r / m, g / m, b / m];
}

const TABLE_N = 64, T_LO = 1000, T_HI = 40000;
let rgbTable = null;
/** Blackbody colour for an effective temperature: linear-light sRGB, max channel 1. Teff clamped to 1000-40000 K. */
export function teffToRgb(teffK) {
  if (!rgbTable) {
    rgbTable = [];
    for (let i = 0; i < TABLE_N; i++) {   // spaced evenly in log T
      rgbTable.push(planckRgb(T_LO * Math.pow(T_HI / T_LO, i / (TABLE_N - 1))));
    }
  }
  const T = clamp(fin(teffK) ? teffK : TEFF_SUN, T_LO, T_HI);
  const f = Math.log(T / T_LO) / Math.log(T_HI / T_LO) * (TABLE_N - 1);
  const i = Math.min(TABLE_N - 2, Math.floor(f)), t = f - i;
  const a = rgbTable[i], b = rgbTable[i + 1];
  const o = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const m = Math.max(o[0], o[1], o[2]) || 1;
  return [o[0] / m, o[1] / m, o[2] / m];
}

// ---------------------------------------------------------------- Teff from Gaia BP-RP
// Approximate interpolation of the empirical colour-temperature sequence of main-sequence stars (Pecaut & Mamajek
// 2013 table, Gaia BP-RP column; solar anchor 0.82 -> 5772 K) and of a red-giant branch (Casagrande+ 2021 / Mucciarelli
// & Bellazzini 2020 trend, solar metallicity). Valid roughly BP-RP -0.6 to 4.5 (dwarfs) and 0.8 to 4.5 (giants).
// Outside the tabulated colours the result is held at the end values, i.e. clamped to 2500-40000 K. Interpolation is
// linear in Teff between anchors; accuracy is a few percent for solar-metallicity stars, worse for reddened ones.
const DWARF_TAB = [[-0.6, 40000], [-0.45, 30000], [-0.3, 16000], [-0.1, 11000], [0.0, 9700], [0.2, 8100], [0.38, 7220],
  [0.55, 6510], [0.74, 5920], [0.82, 5772], [0.98, 5280], [1.15, 4800], [1.4, 4400], [1.84, 3850], [2.2, 3550],
  [2.9, 3200], [3.8, 2850], [4.5, 2500]];
const GIANT_TAB = [[0.8, 5300], [1.0, 4900], [1.2, 4600], [1.6, 4100], [2.0, 3800], [3.0, 3400], [4.5, 3000]];
function interp(tab, x) {
  if (x <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) {
    if (x <= tab[i][0]) { const [x0, y0] = tab[i - 1], [x1, y1] = tab[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
  }
  return tab[tab.length - 1][1];
}
/** Effective temperature (K) from Gaia BP-RP. `giant` selects the giant-branch relation. Result clamped to 2500-40000 K. */
export function teffFromBpRp(bpRp, { giant = false } = {}) {
  if (!fin(bpRp)) return TEFF_SUN;
  return clamp(interp(giant ? GIANT_TAB : DWARF_TAB, bpRp), 2500, 40000);
}

// ---------------------------------------------------------------- L and R
// Andrae et al. 2018 (Gaia DR2 Apsis, Table 2): BC_G = sum a_i (Teff - 5772)^i, two ranges split at 5500 K.
// Valid 4000-8000 K; outside that Teff is clamped to the range (so cool M dwarfs and hot stars are poorly served:
// their true |BC| is larger, and luminosities from this path are lower/upper limits in spirit). Treat as 'inferred'.
const BC_COOL = [1.749, 1.977e-3, 3.737e-7, -8.966e-11, -4.183e-14];   // 4000-5500 K
const BC_WARM = [6.000e-2, 6.731e-5, -6.647e-8, 2.859e-11, -7.197e-15]; // 5500-8000 K
export function bcG(teffK) {
  const T = clamp(fin(teffK) ? teffK : TEFF_SUN, 4000, 8000);
  const c = T < 5500 ? BC_COOL : BC_WARM, d = T - TEFF_SUN;
  return c[0] + d * (c[1] + d * (c[2] + d * (c[3] + d * c[4])));
}
/** L/Lsun from absolute G magnitude and Teff. */
export function lumFromAbsG(absG, teffK) {
  return Math.pow(10, -0.4 * (absG + bcG(teffK) - MBOL_SUN));
}
/** R/Rsun from Stefan-Boltzmann: R = sqrt(L) (Tsun/T)^2. */
export function radiusFromLumTeff(L, teffK) {
  return Math.sqrt(L) * Math.pow(TEFF_SUN / teffK, 2);
}
/** Linear limb-darkening coefficient u: ~0.75 cool (<=3500 K), ~0.6 at the Sun, ~0.3 hot (>=12000 K). Piecewise in log T. */
export function limbDarkeningU(teffK) {
  const T = clamp(fin(teffK) ? teffK : TEFF_SUN, 3500, 12000);
  const pts = [[Math.log(3500), 0.75], [Math.log(5772), 0.6], [Math.log(12000), 0.3]];
  const x = Math.log(T);
  const [a, b] = x <= pts[1][0] ? [pts[0], pts[1]] : [pts[1], pts[2]];
  const t = (x - a[0]) / (b[0] - a[0]), s = t * t * (3 - 2 * t);   // smoothstep: flat at the joins
  return a[1] + (b[1] - a[1]) * s;
}

/**
 * Surface convection, for the close-up of a star. Granule size grows with the pressure scale height, H/R ~ T R / M (in
 * solar units), a little faster than linearly: about 1/600 of the radius on the Sun, while on red giants and supergiants
 * simulations (Freytag et al. 2002, Chiavassa et al. 2009) show a few cells spanning a good part of the disc.
 * The mass is the catalogue value when there is one, else a main-sequence guess from L (with a giant's halved).
 * Contrast is ~15% on cool stars and fades out above ~7000 K, where the convective envelope is too thin to show.
 * Returns { size (stellar radii), contrast, spots (whether starspots make sense: convective envelopes only) }.
 */
export function granulation(md) {
  const T = md && md.teff && fin(md.teff.v) ? md.teff.v : TEFF_SUN;
  const R = md && md.radiusRsun && fin(md.radiusRsun.v) ? md.radiusRsun.v : 1;
  const L = md && md.lumLsun && fin(md.lumLsun.v) ? md.lumLsun.v : 1;
  let M = md && md.massMsun && fin(md.massMsun.v) ? md.massMsun.v : Math.pow(Math.max(L, 1e-4), 1 / 3.5) * (md && md.isGiant ? 0.5 : 1);
  M = clamp(M, 0.08, 60);
  const size = clamp(1.7e-3 * Math.pow((T / TEFF_SUN) * R / M, 1.5), 2e-4, 0.3);
  const t = clamp((7400 - T) / 1400, 0, 1);
  return { size, contrast: 0.02 + 0.14 * t * t * (3 - 2 * t), spots: !(md && md.isWhiteDwarf) && T < 6600 };
}

// ---------------------------------------------------------------- the model
const WD_RADIUS = 0.012;
function pick(V) {
  return V && fin(V.v) ? { v: V.v, lo: V.lo, hi: V.hi, src: V.src, tier: V.tier || 'catalogue' } : null;
}
const inferred = (v, src) => ({ v, src, tier: 'inferred' });

/**
 * Decide what to render for a star and how sure we are. System values win (keeping tier/src); gaps are filled by
 * inference and tagged 'inferred'. Always returns finite numbers.
 */
export function starModel(input = {}) {
  const sys = input.system, vals = (sys && sys.values) || {};
  const notes = sys && Array.isArray(sys.notes) ? sys.notes.slice() : [];
  const out = { notes };

  const bpRpV = pick(vals.bp_rp);
  const bpRp = fin(input.bpRp) ? input.bpRp : bpRpV ? bpRpV.v : null;
  const gV = pick(vals.g_mag);
  const distV = pick(vals.dist_pc);
  // The system payload's value keeps its provenance; the renderer's own copy is only a fallback.
  const distPc = distV ? distV.v : fin(input.distPc) ? input.distPc : null;
  let absG = fin(input.absG) ? input.absG : null;
  if (absG === null && gV && distPc > 0) absG = gV.v - 5 * Math.log10(distPc) + 5;

  if (input.kind === 'sun') {
    const T = { v: TEFF_SUN, src: 'IAU 2015 nominal solar values', tier: 'measured' };
    return { teff: T, radiusRsun: { ...T, v: 1 }, lumLsun: { ...T, v: 1 }, massMsun: { ...T, v: 1 },
      ageGyr: { v: 4.57, src: 'meteoritic dating', tier: 'measured' },
      spectralType: { v: 'G2V', src: 'standard', tier: 'measured' }, distPc: 0,
      rgb: teffToRgb(TEFF_SUN), limbU: limbDarkeningU(TEFF_SUN), radiusAu: RSUN_AU, isWhiteDwarf: false,
      isGiant: false, notes };
  }

  const wdProb = vals.wd_prob && fin(vals.wd_prob.v) ? vals.wd_prob.v : null;
  const isWhiteDwarf = (wdProb !== null && wdProb > 0.5) || (absG !== null && bpRp !== null && absG > 10 && bpRp < 0.6);
  const colourGiant = absG !== null && bpRp !== null && absG < 2 && bpRp > 0.8;

  // Teff
  let teff = pick(vals.teff_k);
  if (!teff) {
    if (bpRp !== null) teff = inferred(teffFromBpRp(bpRp, { giant: colourGiant }), 'from BP−RP colour');
    else { teff = inferred(TEFF_SUN, 'assumed Sun-like (no colour available)'); notes.push('No colour or temperature available: showing a Sun-like star.'); }
  }
  const T = teff.v;

  // Radius (given) and luminosity
  let radius = pick(vals.radius_rsun);
  let lum = pick(vals.lum_lsun);
  if (!lum) {
    // With a catalogue radius and Teff, Stefan–Boltzmann beats the bolometric-correction route, whose BC_G fit only covers
    // 4000–8000 K (a 26,000 K B star came out 12x too faint that way).
    const sb = () => inferred(radius.v * radius.v * Math.pow(T / TEFF_SUN, 4), 'from R and Teff (Stefan–Boltzmann)');
    if (radius && teff.tier !== 'inferred') lum = sb();
    else if (absG !== null) lum = inferred(lumFromAbsG(absG, T), 'from absolute G + bolometric correction');
    else if (radius) lum = sb();
  }
  if (!radius) {
    if (isWhiteDwarf) radius = inferred(WD_RADIUS, 'typical white-dwarf radius');
    else if (lum) radius = inferred(radiusFromLumTeff(lum.v, T), 'from L and Teff (Stefan–Boltzmann)');
    else { radius = inferred(1, 'assumed Sun-like'); }
  }
  if (!lum) lum = inferred(radius.v * radius.v * Math.pow(T / TEFF_SUN, 4), 'from R and Teff (Stefan–Boltzmann)');
  if (isWhiteDwarf && radius.tier === 'inferred') notes.push('Flagged as a white dwarf; radius is a typical value.');
  if (absG !== null && (T < 4000 || T > 8000) && lum.tier === 'inferred' && /bolometric/.test(lum.src)) {
    notes.push('Luminosity uses a bolometric correction outside its calibrated 4000–8000 K range; treat as rough.');
  }

  out.teff = teff; out.radiusRsun = radius; out.lumLsun = lum;
  const mass = pick(vals.mass_msun); if (mass) out.massMsun = mass;
  const age = pick(vals.age_gyr); if (age) out.ageGyr = age;
  const st = vals.spectral_type;
  if (st && typeof st.v === 'string') out.spectralType = { v: st.v, src: st.src, tier: st.tier || 'catalogue' };
  if (distPc !== null) {
    out.distPc = distV ? distV
      : input.kind === 'ctx' ? { v: distPc, src: 'Hipparcos parallax (XHIP)', tier: 'measured' }
      : input.kind === 'gaia' ? { v: distPc, src: 'Bailer-Jones 2021 (geometric)', tier: 'measured' }
      : inferred(distPc, 'as given');
  }
  if (gV) out.gMag = gV;
  if (bpRp !== null) {
    out.bpRp = bpRpV && bpRp === bpRpV.v ? bpRpV
      : input.kind === 'ctx' ? inferred(bpRp, 'from Johnson B−V (XHIP)')
      : { v: bpRp, src: 'Gaia DR3 photometry', tier: 'measured' };
  }
  if (sys && sys.notUsed && typeof sys.notUsed === 'object') out.notUsed = sys.notUsed;   // prefer_record: Gaia's single-star values, listed as not used
  out.rgb = teffToRgb(T);
  out.limbU = limbDarkeningU(T);
  out.radiusAu = radius.v * RSUN_AU;
  out.isWhiteDwarf = isWhiteDwarf;
  out.isGiant = colourGiant || (!isWhiteDwarf && radius.v > 5);
  return out;
}

/** "5,790 K (5,710–5,860)". V is {v, lo, hi} or a bare number; null/non-finite gives an em dash. */
export function fmtValue(V, unit = '', digits = 0) {
  const v = V && typeof V === 'object' ? V.v : V;
  if (!fin(v)) return '—';
  const f = (x) => x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  let s = f(v) + (unit ? ' ' + unit : '');
  if (V && typeof V === 'object' && fin(V.lo) && fin(V.hi) && f(V.lo) !== f(V.hi)) s += ` (${f(V.lo)}–${f(V.hi)})`;
  return s;
}
