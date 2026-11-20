// Motion layer of the 3D view (docs/object-framework.md section 20.4, 20.5 and the decisions of 20.17). Pure: no DOM, no WebGL.
//
// A payload record is compiled once into a MOVER; evalMover then writes where the record is drawn at any sky time into a
// caller-owned array, with no allocation. Every mover is positioned relative to its host (the Sun for the solar system) in ICRS axes, AU.
//
//   model 'ephem'   ss:mercury ... ss:neptune, ss:earth, ss:moon from ephem.js (ERFA plan94 and moon98, in the browser). The ANCHOR is
//                   server_xyz - client_xyz(payload epoch), constant per body; drawn = client(t) + anchor.
//   model 'kepler'  a state record with position.osc (SkyBoT's heliocentric state at osc.epoch_jd): two-body motion about the Sun in
//                   universal variables (propagate), mu = GK^2 (ephem.GK; the body's mass is ignored), anchored the same way. The anchor absorbs
//                   the light time inside SkyBoT's astrometric direction and the up to 10 days between osc.epoch_jd and the query.
//   model 'orbit'   exoplanets and binary black holes through scene3d-orbits.compileOrbit/evalOrbit (section 20.4.3): relative orbit
//                   about the host, no anchor (the record's placement IS the orbit evaluated at the date).
//
// ANCHOR EXACTNESS. Within 1e-9 day of the payload's epoch evalMover copies the server's own xyz_au (kept in the mover), so the
// drawn position at the payload's epoch is bit-identical to what ingest placed there. Elsewhere it is client(t) + anchor, which differs from the
// server value at the epoch by at most a rounding error, so there is no jump at the 1e-9 day edge.
//
// EXPORTS
//   VIEW_JD_RANGE = { min, max }      1900-01-01 and 2100-01-01 (TT Julian Days), the 3D view's clock range (20.1); the server's mjd range 15020-88069
//   WINDOW_DAYS = 365.25              the one valid window of every small-body state: +-1 yr of osc.epoch_jd (17, item 3)
//   PHASE_SIGMA_MAX_DEG = 90          beyond this phase sigma an orbit counts as extrapolated (20.5)
//   MU_SUN = GK^2                     au^3 / day^2
//   propagate(r0, v0, mu, dtDays, out, warm?) -> out   universal-variable two-body propagation (elliptic, parabolic, hyperbolic: one path).
//       r0, v0: [x, y, z] (au, au/day); out[0..2] the position, and out[3..5] the velocity when out has 6 slots. warm: an object { chi }
//       that carries the solver's last universal anomaly between calls (read first, written after), so a frame costs 1-3 Newton steps.
//   oscElements(r, v, mu, epochJd?) -> { a, e, i, node, omega, q, period, tPeri }   osculating elements of an ICRS state, angles in DEGREES
//       relative to the mean ecliptic and equinox of J2000 (ephem.eclipticBasis(2000)); a in au (negative for e > 1, Infinity for e = 1),
//       q = perihelion distance, period in days (null unless e < 1), tPeri the JD of perihelion passage (needs epochJd, else relative to 0)
//   compileMover(o, { payloadMjd, client }) -> mover | null   o: a payload record; payloadMjd defaults to o.position.mjd; client: an optional
//       { bodyHeliocentric(jd, body, out) } replacing ephem.js's (tests); null when nothing can move the record (ss:sun, fixed positions, unusable data)
//   evalMover(m, mjd, out) -> out     the drawn position (au, relative to the host, ICRS) at mjd (TT MJD) into out[0..2]
//   moverValidity(m, mjd) -> { ok, reason, lo, hi, sigmaDeg }   the valid range of section 20.5 (lo, hi in TT JD)
//       kepler: ok iff |jd - epoch_jd| <= WINDOW_DAYS, else reason 'osc-epoch';  orbit with a phase epoch: ok iff phase sigma <= 90 deg, else 'phase-sigma'
//       (no sigma published: ok, sigmaDeg null);  orbit with an assumed phase: ok, reason 'assumed-phase' (informational: illustrative anyway);
//       ephem: always ok. lo and hi are the range edges (the view range where the source has no limit).
//   oscPath(m, n, maxAu = 50, out?) -> Float64Array(3 (n + 1))   the osculating conic of a kepler mover, heliocentric ICRS, anchor applied: a closed
//       ellipse when it lies within maxAu, otherwise the arc within maxAu of the Sun (hyperbola, parabola, or a long ellipse). Needs a kepler mover.
//   motionSummary(items) -> { text, counts }   the time bar's "Moving: ..." line from [{ kind, model, illustrative, valid }]
import { jdFromCalendar } from './skytime.js';
import { GK, bodyHeliocentric, eclipticBasis } from './ephem.js';
import { compileOrbit, evalOrbit, phaseSigmaAt } from './scene3d-orbits.js';

const D2R = Math.PI / 180, TAU = 2 * Math.PI, MJD0 = 2400000.5;
export const VIEW_JD_RANGE = { min: jdFromCalendar(1900, 1, 1), max: jdFromCalendar(2100, 1, 1) };
export const WINDOW_DAYS = 365.25;
export const PHASE_SIGMA_MAX_DEG = 90;
export const MU_SUN = GK * GK;
const ANCHOR_EPS_D = 1e-9;

// ------------------------------------------------------------------------------------- universal variables
const INV_FACT = [1];
for (let k = 1; k <= 30; k++) INV_FACT.push(INV_FACT[k - 1] / k);
const KS = { c: 0, s: 0, r: 0 };   // scratch: Stumpff C(z), S(z) and the distance r at the last kep() call

/** Stumpff functions C(z) and S(z) into KS (series for |z| < 1, closed forms outside). */
function stumpff(z) {
  if (Math.abs(z) < 1) {
    let c = 0, s = 0, p = 1;
    for (let k = 0; k < 12; k++) { c += p * INV_FACT[2 * k + 2]; s += p * INV_FACT[2 * k + 3]; p *= -z; }
    KS.c = c; KS.s = s;
  } else if (z > 0) {
    const q = Math.sqrt(z);
    KS.c = (1 - Math.cos(q)) / z; KS.s = (q - Math.sin(q)) / (z * q);
  } else {
    const q = Math.sqrt(-z);
    KS.c = (Math.cosh(q) - 1) / -z; KS.s = (Math.sinh(q) - q) / (-z * q);
  }
}

/** The universal Kepler function sqrt(mu) dt(chi) = r0 chi + sigma0 chi^2 C + (1 - alpha r0) chi^3 S; sets KS.c, KS.s and KS.r = d/dchi (the distance at chi). */
function kep(chi, alpha, r0, sigma0) {
  const z = alpha * chi * chi;
  stumpff(z);
  const x2 = chi * chi;
  KS.r = x2 * KS.c + sigma0 * chi * (1 - z * KS.s) + r0 * (1 - z * KS.c);
  return r0 * chi + sigma0 * x2 * KS.c + (1 - alpha * r0) * x2 * chi * KS.s;
}

export function propagate(r0, v0, mu, dt, out, warm) {
  const x0 = r0[0], y0 = r0[1], z0 = r0[2], u0 = v0[0], w0 = v0[1], q0 = v0[2];
  const rm = Math.hypot(x0, y0, z0), v2 = u0 * u0 + w0 * w0 + q0 * q0, sm = Math.sqrt(mu);
  const alpha = 2 / rm - v2 / mu, sigma0 = (x0 * u0 + y0 * w0 + z0 * q0) / sm, target = sm * dt;
  let f, g, fd = 0, gd = 0;
  if (dt === 0) { f = 1; g = 0; fd = 0; gd = 1; } else {
    // F(chi) = kep(chi) - target is increasing (F' = r > 0): safeguarded Newton inside a shrinking bracket [lo, hi]
    let chi = warm && Number.isFinite(warm.chi) ? warm.chi : alpha > 1e-9 ? target * alpha : target / rm, lo = -Infinity, hi = Infinity;
    for (let it = 0; it < 120; it++) {
      const F = kep(chi, alpha, rm, sigma0) - target;
      if (F === 0) break;
      if (F > 0) hi = chi; else lo = chi;
      let next = chi - F / KS.r;
      if (!(KS.r > 0) || !(next > lo && next < hi) || (it > 60 && lo > -Infinity && hi < Infinity)) {
        if (lo > -Infinity && hi < Infinity) next = 0.5 * (lo + hi);
        else next = F > 0 ? chi - Math.max(1, 2 * Math.abs(chi)) : chi + Math.max(1, 2 * Math.abs(chi));
      }
      const done = Math.abs(next - chi) <= 1e-15 * Math.max(1, Math.abs(chi));
      chi = next;
      if (done) break;
    }
    kep(chi, alpha, rm, sigma0);                      // Stumpff values and r at the final chi
    const z = alpha * chi * chi, r = KS.r;
    f = 1 - chi * chi * KS.c / rm; g = dt - chi * chi * chi * KS.s / sm;
    fd = sm / (r * rm) * chi * (z * KS.s - 1); gd = 1 - chi * chi * KS.c / r;
    if (warm) warm.chi = chi;
  }
  out[0] = f * x0 + g * u0; out[1] = f * y0 + g * w0; out[2] = f * z0 + g * q0;
  if (out.length >= 6) { out[3] = fd * x0 + gd * u0; out[4] = fd * y0 + gd * w0; out[5] = fd * z0 + gd * q0; }
  return out;
}

// ------------------------------------------------------------------------------------- osculating elements
let ECL = null;   // ICRS -> mean ecliptic of J2000 rows, built on first use
const toEcl = (v) => [0, 1, 2].map((k) => v[0] * ECL[k][0] + v[1] * ECL[k][1] + v[2] * ECL[k][2]);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const wrap360 = (d) => ((d % 360) + 360) % 360;

export function oscElements(r, v, mu, epochJd = 0) {
  if (!ECL) ECL = eclipticBasis(2000);
  const re = toEcl(r), ve = toEcl(v), rm = Math.hypot(...re), v2 = ve[0] * ve[0] + ve[1] * ve[1] + ve[2] * ve[2];
  const h = cross3(re, ve), hm = Math.hypot(...h), vh = cross3(ve, h);
  const ev = [vh[0] / mu - re[0] / rm, vh[1] / mu - re[1] / rm, vh[2] / mu - re[2] / rm], e = Math.hypot(...ev);
  const energy = v2 / 2 - mu / rm, p = hm * hm / mu, q = p / (1 + e);
  const parabolic = Math.abs(e - 1) < 1e-9, a = parabolic ? Infinity : -mu / (2 * energy);
  const inc = Math.acos(Math.max(-1, Math.min(1, h[2] / hm)));
  const nm = Math.hypot(h[1], h[0]), equatorial = nm < 1e-12 * hm;
  const node = equatorial ? 0 : Math.atan2(h[0], -h[1]);
  let omega;
  if (e < 1e-10) omega = 0;
  else if (!equatorial) {
    const nx = -h[1] / nm, ny = h[0] / nm;                                   // unit vector to the ascending node
    omega = Math.acos(Math.max(-1, Math.min(1, (nx * ev[0] + ny * ev[1]) / e)));
    if (ev[2] < 0) omega = TAU - omega;
  } else omega = h[2] > 0 ? Math.atan2(ev[1], ev[0]) : Math.atan2(-ev[1], ev[0]);
  // true anomaly (the argument of latitude for a circular orbit: perihelion is then taken at the epoch)
  let tPeri = epochJd;
  if (e >= 1e-10) {
    let nu = Math.acos(Math.max(-1, Math.min(1, (ev[0] * re[0] + ev[1] * re[1] + ev[2] * re[2]) / (e * rm))));
    if (re[0] * ve[0] + re[1] * ve[1] + re[2] * ve[2] < 0) nu = -nu;
    if (parabolic) { const D = Math.tan(nu / 2); tPeri = epochJd - 0.5 * Math.sqrt(p * p * p / mu) * (D + D * D * D / 3); }
    else if (e < 1) {
      const E = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2)), M = E - e * Math.sin(E);
      tPeri = epochJd - M / Math.sqrt(mu / (a * a * a));
    } else {
      const H = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2)), M = e * Math.sinh(H) - H;
      tPeri = epochJd - M / Math.sqrt(mu / (-a * a * a));
    }
  }
  return { a, e, i: inc / D2R, node: wrap360(node / D2R), omega: wrap360(omega / D2R), q, period: e < 1 && !parabolic ? TAU * Math.sqrt(a * a * a / mu) : null, tPeri };
}

// ------------------------------------------------------------------------------------- movers
const EPHEM_BODY = { 'ss:mercury': 'mercury', 'ss:venus': 'venus', 'ss:mars': 'mars', 'ss:jupiter': 'jupiter', 'ss:saturn': 'saturn', 'ss:uranus': 'uranus', 'ss:neptune': 'neptune', 'ss:earth': 'earth', 'ss:moon': 'moon' };
const vec3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const defaultClient = { bodyHeliocentric };

/** See the header. A mover is { id, model, anchor, server, payloadMjd, ... } plus the model's own state: body (ephem), r0, v0, epochJd, warm, elements (kepler), plan (orbit). */
export function compileMover(o, { payloadMjd, client = defaultClient } = {}) {
  const pos = o && o.position;
  if (!pos) return null;
  if (pos.model === 'orbit') {
    const plan = compileOrbit(o);
    return plan ? { id: o.id, model: 'orbit', plan, assumed: plan.source === 'assumed', payloadMjd: payloadMjd ?? null } : null;
  }
  if (pos.model !== 'state' || !vec3(pos.xyz_au)) return null;
  const mjd0 = payloadMjd ?? pos.mjd;
  if (!Number.isFinite(mjd0)) return null;
  const server = pos.xyz_au.slice();
  const osc = pos.osc;
  if (osc && vec3(osc.xyz_au) && vec3(osc.vxyz_au_d) && Number.isFinite(osc.epoch_jd) && osc.frame === 'icrf-heliocentric' && Math.hypot(...osc.xyz_au) > 0) {
    const r0 = osc.xyz_au.slice(), v0 = osc.vxyz_au_d.slice(), tmp = [0, 0, 0];
    propagate(r0, v0, MU_SUN, mjd0 + MJD0 - osc.epoch_jd, tmp);
    return {
      id: o.id, model: 'kepler', r0, v0, epochJd: osc.epoch_jd, warm: { chi: NaN }, server, payloadMjd: mjd0,
      anchor: [server[0] - tmp[0], server[1] - tmp[1], server[2] - tmp[2]], elements: oscElements(r0, v0, MU_SUN, osc.epoch_jd),
    };
  }
  const body = EPHEM_BODY[o.id], source = o.provenance && o.provenance.source;
  if (body && o.host === 'ss:sun' && (source === undefined || source === 'ephem')) {
    const tmp = client.bodyHeliocentric(mjd0 + MJD0, body, [0, 0, 0]);
    return { id: o.id, model: 'ephem', body, client, server, payloadMjd: mjd0, anchor: [server[0] - tmp[0], server[1] - tmp[1], server[2] - tmp[2]] };
  }
  return null;
}

export function evalMover(m, mjd, out) {
  if (m.model === 'orbit') return evalOrbit(m.plan, mjd, out);
  if (Math.abs(mjd - m.payloadMjd) < ANCHOR_EPS_D) { out[0] = m.server[0]; out[1] = m.server[1]; out[2] = m.server[2]; return out; }
  if (m.model === 'ephem') m.client.bodyHeliocentric(mjd + MJD0, m.body, out);
  else propagate(m.r0, m.v0, MU_SUN, mjd + MJD0 - m.epochJd, out, m.warm);
  out[0] += m.anchor[0]; out[1] += m.anchor[1]; out[2] += m.anchor[2];
  return out;
}

export function moverValidity(m, mjd) {
  const jd = mjd + MJD0;
  if (m.model === 'kepler') {
    const ok = Math.abs(jd - m.epochJd) <= WINDOW_DAYS;
    return { ok, reason: ok ? null : 'osc-epoch', lo: m.epochJd - WINDOW_DAYS, hi: m.epochJd + WINDOW_DAYS, sigmaDeg: null };
  }
  if (m.model === 'orbit') {
    const plan = m.plan;
    if (plan.source === 'assumed') return { ok: true, reason: 'assumed-phase', lo: VIEW_JD_RANGE.min, hi: VIEW_JD_RANGE.max, sigmaDeg: null };
    const sigmaDeg = phaseSigmaAt(plan, mjd), ok = sigmaDeg === null || sigmaDeg <= PHASE_SIGMA_MAX_DEG;
    let lo = VIEW_JD_RANGE.min, hi = VIEW_JD_RANGE.max;
    if (plan.sigP > 0) { const half = PHASE_SIGMA_MAX_DEG * plan.P * plan.P / (360 * plan.sigP), t0 = plan.phaseEpoch + MJD0; lo = t0 - half; hi = t0 + half; }
    return { ok, reason: ok ? null : 'phase-sigma', lo, hi, sigmaDeg };
  }
  return { ok: true, reason: null, lo: VIEW_JD_RANGE.min, hi: VIEW_JD_RANGE.max, sigmaDeg: null };
}

// ------------------------------------------------------------------------------------- the osculating conic of a selected small body
export function oscPath(m, n, maxAu = 50, out = new Float64Array(3 * (n + 1))) {
  if (!m || m.model !== 'kepler') throw new Error('oscPath needs a kepler mover');
  const r = m.r0, v = m.v0, rm = Math.hypot(...r), h = cross3(r, v), hm = Math.hypot(...h), hh = [h[0] / hm, h[1] / hm, h[2] / hm];
  const vh = cross3(v, h), ev = [vh[0] / MU_SUN - r[0] / rm, vh[1] / MU_SUN - r[1] / rm, vh[2] / MU_SUN - r[2] / rm], e = Math.hypot(...ev);
  const P = e > 1e-10 ? [ev[0] / e, ev[1] / e, ev[2] / e] : [r[0] / rm, r[1] / rm, r[2] / rm], Q = cross3(hh, P);
  const p = hm * hm / MU_SUN, q = p / (1 + e), A = m.anchor;
  const put = (k, x, y) => { out[3 * k] = x * P[0] + y * Q[0] + A[0]; out[3 * k + 1] = x * P[1] + y * Q[1] + A[1]; out[3 * k + 2] = x * P[2] + y * Q[2] + A[2]; };
  const apo = e < 1 ? p / (1 - e) : Infinity;
  if (apo <= maxAu) {                                                    // closed ellipse, uniform in eccentric anomaly
    const a = p / (1 - e * e), b = a * Math.sqrt(1 - e * e);
    for (let k = 0; k <= n; k++) { const E = (k === n ? 0 : k) / n * TAU; put(k, a * (Math.cos(E) - e), b * Math.sin(E)); }
  } else {                                                               // the arc within R of the Sun, nu = 2 atan(s tan(nuMax / 2)) for s in [-1, 1] (dense at perihelion)
    const R = Math.max(maxAu, 2 * q), cosMax = Math.max(-1, Math.min(1, (p / R - 1) / e)), tmax = Math.tan(Math.acos(cosMax) / 2);
    for (let k = 0; k <= n; k++) { const nu = 2 * Math.atan((2 * k / n - 1) * tmax), rr = p / (1 + e * Math.cos(nu)); put(k, rr * Math.cos(nu), rr * Math.sin(nu)); }
  }
  return out;
}

// ------------------------------------------------------------------------------------- the time bar's "Moving: ..." line
const SMALL_KINDS = new Set(['asteroid', 'comet', 'dwarf_planet']);
const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * "Moving: 8 planets and the Moon (ephemeris) · 214 small bodies (SkyBoT orbits, +-1 yr; 12 beyond their range) · 7 exoplanets ◌ (orbit orientation unknown) · 1 black hole ◌ (no phase epoch published)".
 * items: [{ kind, model: 'ephem' | 'kepler' | 'orbit', illustrative, valid }]. ◌ marks illustrative placements; a mixed family says how many. '' when nothing moves.
 */
export function motionSummary(items) {
  const fam = { planets: 0, moon: 0, small: 0, exo: 0, bh: 0, other: new Map() }, bad = { small: 0, exo: 0, bh: 0, other: 0 }, ill = { exo: 0, bh: 0, other: 0 };
  let beyond = 0, illustrative = 0;
  for (const it of items) {
    if (!it || (it.model !== 'ephem' && it.model !== 'kepler' && it.model !== 'orbit')) continue;
    const off = it.valid === false ? 1 : 0, il = it.illustrative ? 1 : 0;
    beyond += off; illustrative += il;
    if (it.model === 'ephem') { if (it.kind === 'moon') fam.moon++; else fam.planets++; }
    else if (it.model === 'kepler' || SMALL_KINDS.has(it.kind)) { fam.small++; bad.small += off; }
    else if (it.kind === 'exoplanet') { fam.exo++; bad.exo += off; ill.exo += il; }
    else if (it.kind === 'black_hole') { fam.bh++; bad.bh += off; ill.bh += il; }
    else { fam.other.set(it.kind, (fam.other.get(it.kind) || 0) + 1); bad.other += off; ill.other += il; }
  }
  const counts = { planets: fam.planets, moon: fam.moon, smallBodies: fam.small, exoplanets: fam.exo, blackHoles: fam.bh, other: Object.fromEntries(fam.other), beyond, illustrative };
  const parts = [], range = (k) => (bad[k] ? `${bad[k].toLocaleString('en-US')} beyond their range` : '');
  const paren = (...xs) => { const s = xs.filter(Boolean).join('; '); return s ? ` (${s})` : ''; };
  if (fam.planets || fam.moon) {
    const who = fam.planets && fam.moon ? `${plural(fam.planets, 'planet', 'planets')} and the Moon` : fam.planets ? plural(fam.planets, 'planet', 'planets') : 'the Moon';
    parts.push(`${who} (ephemeris)`);
  }
  if (fam.small) parts.push(`${plural(fam.small, 'small body', 'small bodies')}${paren('SkyBoT orbits, ±1 yr', range('small'))}`);
  const orbitFamily = (n, noun, k, noteIll, noteMeasured) => {
    if (!n) return;
    const all = ill[k] === n, none = ill[k] === 0;
    parts.push(`${plural(n, noun[0], noun[1])}${all ? ' ◌' : ''}${paren(all ? noteIll : none ? noteMeasured : `${ill[k].toLocaleString('en-US')} ◌ ${noteIll}`, range(k))}`);
  };
  orbitFamily(fam.exo, ['exoplanet', 'exoplanets'], 'exo', 'orbit orientation unknown', 'measured orbits');
  orbitFamily(fam.bh, ['black hole', 'black holes'], 'bh', 'no phase epoch published', 'measured orbits');
  for (const [kind, n] of fam.other) { const noun = kind.replace(/_/g, ' '); parts.push(`${plural(n, noun, noun + 's')}${paren(range('other'))}`); }
  return { text: parts.length ? `Moving: ${parts.join(' · ')}` : '', counts };
}
