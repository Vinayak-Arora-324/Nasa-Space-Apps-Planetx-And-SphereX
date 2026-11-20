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
//
// PHASE 3 (docs/object-framework.md section 18.5.2): HUD distances and speeds, chosen by VALUE, not by frame, so nothing jumps when the camera
// switches level. Both take parsecs (and pc per second) whatever the camera's frame units are.
//   fmtDistPc(pc) -> '3.2 AU' (below 0.02 pc) | '350 pc · 1,140 ly' | '49.4 kpc · 161,000 ly' | '16.9 Mpc · 55.0 million ly' ('… billion ly' from
//                    1,000 million); 3 significant figures; 'n/a' when not finite or negative
//   fmtSpeedPc(pcPerS) -> '0' | '206 AU/s · ≈ 0.4× c' | '2 pc/s · ≈ 6.5 hundred million× c'-style: AU/s (below 0.02 pc/s), pc/s, kpc/s or Mpc/s, then ' · ≈ ' and fmtTimesC
//
// PHASE 5 (docs/object-framework.md section 20): dates and time spans on cards
//   fmtDrawnDate(mjd) -> '20 Nov 2026 14:00 UT'   the drawn date (a TT MJD) as UT to the minute, in the Julian calendar before 1582 (skyclock.clockText); 'n/a' when not finite
//   fmtSpan(days) -> '45 days' | '1.3 yr' | '6 hours' | '1 day'   a span of days (sign ignored): minutes below an hour, hours below a day, days below a year (365.25 d), else
//                    years to 2 significant figures ('1.3 yr', '12 yr', '120 yr'); 'n/a' when not finite
//   LY_PER_PC, AU_PER_PC re-stated here are the same constants as scene3d-math.js and scene3d-frames.js

import { fmtTimesC, C_PC_PER_S } from './scene3d-nav.js';
import { clockText } from './skyclock.js';

export const SCI_HI = 1e5, SCI_LO = 1e-3;
const AU_PER_PC = 206264.80624709636, LY_PER_PC = 3.2615638;
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

// ------------------------------------------------------------------ Phase 3: HUD distances and speeds (section 18.5.2)
const sig3 = (v) => Number(v).toPrecision(3);
const lyText = (pc) => {   // light-years of a distance in pc: '1,140 ly', '161,000 ly', '55.0 million ly', '1.23 billion ly'
  const ly = pc * LY_PER_PC;
  if (ly < 9.995e5) return `${fmtNum(ly)} ly`;
  if (ly < 9.995e8) return `${sig3(ly / 1e6)} million ly`;
  return `${sig3(ly / 1e9)} billion ly`;
};
/** A length in pc as HUD text, by value: AU, pc, kpc or Mpc, with light-years beside it (none beside AU). */
export function fmtDistPc(pc) {
  if (!fin(pc) || pc < 0) return 'n/a';
  if (pc < 0.02) return `${fmtNum(pc * AU_PER_PC)} AU`;
  if (pc < 999.5) return `${fmtNum(pc)} pc · ${lyText(pc)}`;
  if (pc < 999.5e3) return `${fmtNum(pc / 1e3)} kpc · ${lyText(pc)}`;
  return `${fmtNum(pc / 1e6)} Mpc · ${lyText(pc)}`;
}
/** A speed in pc per second as HUD text, by value: AU/s, pc/s, kpc/s or Mpc/s, then the multiple of light speed. '0' for no motion. */
export function fmtSpeedPc(pcPerS) {
  if (!fin(pcPerS) || pcPerS < 0) return 'n/a';
  if (pcPerS === 0) return '0';
  const c = fmtTimesC(pcPerS / C_PC_PER_S), tail = c ? ` · ≈ ${c}` : '';
  if (pcPerS < 0.02) return `${fmtNum(pcPerS * AU_PER_PC)} AU/s${tail}`;
  if (pcPerS < 999.5) return `${fmtNum(pcPerS)} pc/s${tail}`;
  if (pcPerS < 999.5e3) return `${fmtNum(pcPerS / 1e3)} kpc/s${tail}`;
  return `${fmtNum(pcPerS / 1e6)} Mpc/s${tail}`;
}

// ------------------------------------------------------------------ Phase 5: the drawn date and spans (section 20.4, 20.5)
const MJD0 = 2400000.5;
/** A TT MJD as 'D Mon YYYY HH:MM UT' (skyclock.clockText: UT = TT - deltaT, whole minutes, Julian calendar before 1582 October 15). */
export function fmtDrawnDate(mjd) {
  if (!fin(mjd)) return 'n/a';
  const t = clockText({ jd: mjd + MJD0, rate: 0, playing: false });
  return `${t.date} ${t.time}`;
}
/** A span of days as text, by value: '30 min', '6 hours', '1 day', '45 days', '1.3 yr'. */
export function fmtSpan(days) {
  if (!fin(days)) return 'n/a';
  const d = Math.abs(days), two = (v) => fmtNum(v, 2), unit = (txt, one, many) => `${txt} ${txt === '1' ? one : many}`;
  if (d < 1 / 24) return `${two(d * 1440)} min`;
  if (d < 1) return unit(two(d * 24), 'hour', 'hours');
  if (d < 365.25) return unit(d < 10 ? two(d) : String(Math.round(d)), 'day', 'days');
  return `${two(d / 365.25)} yr`;
}
