// Number text for the 3D fly-through's cards (docs/object-framework.md section 17.18, "Card numbers"). Pure: no DOM.
//
// One rule for every card, whatever the kind:
//   - A value with an uncertainty (a Quantity with finite lo <= v <= hi, not all equal) shows the digits the uncertainty supports.
//     The larger of the two errors (v - lo, hi - v) is rounded to 1 or 2 significant figures by the
//     Particle Data Group rule: its first three digits 100-354 keep 2 figures, 355-949 keep 1, 950-999 round up to 1000 and keep 2.
//     Both errors and the value are rounded to that decimal place (a nonzero error never rounds to 0: it shows as one unit of the
//     last digit). Equal rounded errors read '8.94 ± 0.34 M☉', unequal ones '2,220 +180/−170 pc'. The larger error sets the
//     precision so an asymmetric interval never claims more digits than its wider side supports (V404 Cyg: '9.0 +0.2/−0.6 M☉').
//   - Such a value is written in scientific notation when |v| >= 1e5 or 0 < |v| < 1e-3 (SCI_HI, SCI_LO):
//     '4.297 ± 0.012 × 10⁶ M☉'. The errors share the value's power of ten.
//   - A value without an uncertainty keeps the old behaviour: 3 significant figures, en-US thousands separators ('12,700,000 km').
//   - An interval that does not bracket its value is shown as before, as 'v unit (lo–hi)' with up to 5 figures.
//   - A string value (a catalogue bound such as '< 0.12') is returned untouched, with its unit.
//
// EXPORTS
//   SCI_HI = 1e5, SCI_LO = 1e-3
//   fmtNum(v, sig = 3) -> string               3 significant figures, en-US grouping; 'n/a' when not finite
//   fmtQuantity(q, unit = '', { sig = 3, scale = 1 }) -> string
//                                               q: { v, lo?, hi? } or a bare number; scale multiplies v, lo and hi (a unit change, e.g.
//                                               Gyr -> Myr); unit is appended with a space, except '°' which is appended directly
//   roundUncertainty(e) -> { place, e }         place: the power of ten of the last kept digit; e: e rounded there
//   superscript(n) -> '⁶', '⁻¹²'

export const SCI_HI = 1e5, SCI_LO = 1e-3;
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

export const fmtNum = (v, sig = 3) => (fin(v) ? v.toLocaleString('en-US', { maximumSignificantDigits: sig }) : 'n/a');

const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
export const superscript = (n) => String(n).split('').map((c) => SUP[c] || c).join('');

/** The PDG rounding of a positive uncertainty: { place, e } (place = the power of ten of its last kept digit). */
export function roundUncertainty(e) {
  let n = Math.floor(Math.log10(e));
  let lead = Math.round(e / 10 ** (n - 2));          // its first three digits, 100..1000
  if (lead >= 1000) { n += 1; lead = 100; }
  if (lead > 949) return { place: n, e: 10 ** (n + 1) };   // 950-999 round up to 1000, written with 2 figures (0.96 -> 1.0)
  const place = lead <= 354 ? n - 1 : n;
  return { place, e: roundTo(e, place) };
}
const roundTo = (x, place) => (place >= 0 ? Math.round(x / 10 ** place) * 10 ** place : Math.round(x * 10 ** -place) / 10 ** -place);
const fixed = (x, place) => {
  const d = Math.max(0, -place), r = roundTo(x, place);
  return (Object.is(r, -0) ? 0 : r).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const withUnit = (s, unit) => (!unit ? s : unit === '°' ? `${s}°` : `${s} ${unit}`);

function oldInterval(v, lo, hi, unit, sig) {
  for (let d = sig; d <= 5; d++) if (fmtNum(lo, d) !== fmtNum(hi, d)) return `${withUnit(fmtNum(v, d), unit)} (${fmtNum(lo, d)}–${fmtNum(hi, d)})`;
  return withUnit(fmtNum(v, sig), unit);
}

/** A Quantity's card text by the rule in the header. */
export function fmtQuantity(q, unit = '', { sig = 3, scale = 1 } = {}) {
  const raw = q && typeof q === 'object' ? q.v : q;
  if (typeof raw === 'string') return withUnit(raw.trim(), unit);
  if (!fin(raw)) return withUnit('n/a', unit);
  const v = raw * scale;
  const lo = q && typeof q === 'object' && fin(q.lo) ? q.lo * scale : null, hi = q && typeof q === 'object' && fin(q.hi) ? q.hi * scale : null;
  if (lo === null || hi === null) return withUnit(fmtNum(v, sig), unit);
  const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
  const eLo = v - a, eHi = b - v;
  if (eLo < 0 || eHi < 0) return oldInterval(v, a, b, unit, sig);   // the interval does not bracket the value
  if (eLo === 0 && eHi === 0) return withUnit(fmtNum(v, sig), unit);
  const av = Math.abs(v), sci = av >= SCI_HI || (av > 0 && av < SCI_LO);
  const k = sci ? Math.floor(Math.log10(av)) : 0, s = 10 ** k;
  const m = v / s, mLo = eLo / s, mHi = eHi / s;
  const { place } = roundUncertainty(Math.max(mLo, mHi));
  const rLo = errAt(mLo, place), rHi = errAt(mHi, place);
  const err = fixed(rLo, place) === fixed(rHi, place) ? `± ${fixed(rHi, place)}` : `+${fixed(rHi, place)}/−${fixed(rLo, place)}`;
  const body = `${fixed(m, place)} ${err}`;
  return sci ? withUnit(`${body} × 10${superscript(k)}`, unit) : withUnit(body, unit);
}
// An error rounds to the kept place, but never to zero: a nonzero error that small shows as one unit of the last digit.
const errAt = (e, place) => (e > 0 ? Math.max(roundTo(e, place), 10 ** place) : 0);
