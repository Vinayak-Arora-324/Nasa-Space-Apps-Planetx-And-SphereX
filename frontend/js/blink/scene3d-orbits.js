// Client-side orbit evaluation for exoplanets (docs/object-framework.md section 16.6). Pure: no DOM, no WebGL, no imports.
//
// The NASA Exoplanet Archive has no longitude of the ascending node, and often no inclination or phase, so a drawn
// exoplanet placement is always illustrative. What the archive does not give is filled by one documented rule: a
// deterministic per-id hash (FNV-1a), so the same planet is drawn the same way on every load and in every client.
//
// EXPORTS
//   J2000_MJD = 51544.5            the epoch of the assumed mean anomaly when the phase is unknown
//   hashUnit(id, salt) -> [0, 1)   FNV-1a 32-bit over the UTF-8 bytes of `${id}#${salt}`, divided by 2^32.
//                                  Test vectors (32-bit value before the division; also checked in scene3d-orbits.test.mjs):
//                                    '#' -> 638357778;  'a#b' -> 1118607213;  'nea:51 Peg b#node' -> 498661936;
//                                    'nea:TRAPPIST-1 b#phase' -> 2708169220
//   solveKepler(M, e) -> E         Newton on E - e sin E = M (M in radians, any range; E0 = M + e sin M, or pi when e > 0.8;
//                                  |dE| < 1e-12, at most 50 iterations). e is clamped to [0, 0.99].
//   skyBasis(raDeg, decDeg) -> { N, E, Z, u }   unit vectors at the host: north, east, toward the observer (Z = -u), and u = Earth -> host
//   orbitPlacement(rec, mjd) -> { xyzAu, assumed, used, phaseSigmaDeg, phaseSource } | null
//       rec: an exoplanet record (position.model 'orbit', host_radec, elements {period_d, a_au, e, i_deg, omega_deg,
//       t_peri_mjd, t_conj_mjd, node_deg} as Quantities {v, lo?, hi?, tier}); null when period or a is missing.
//       xyzAu     ICRS offset from the host star in AU (X_N N + Y_E E + Z Zhat, Thiele-Innes; inferior conjunction at u = 90 deg)
//       assumed   { node, incl, omega, phase, ecc }  true where the value was not in the archive (ecc: its tier is 'illustrative')
//       used      { node, incl, omega, ecc, a, period, trueAnomaly, r }  the values drawn (degrees, AU, days), for cards
//       phaseSource 'conjunction' (t_conj_mjd) | 'periastron' (t_peri_mjd) | 'assumed' (mean anomaly at J2000 from the hash)
//       phaseSigmaDeg  360 * |t - T0| * sigmaP / P^2 with sigmaP = (hi - lo) / 2 of the period, T0 the epoch used; null when
//                      the phase is assumed or the period has no interval (the epoch's own error is ignored)
//   orbitPath(rec, n = 180) -> [[x, y, z], ...]   n + 1 points (the last equals the first) of the ellipse relative to the
//       host, in AU, uniform in eccentric anomaly, with the same orientation as orbitPlacement; [] when unusable.
//
// ASSUMED VALUES (illustrative, deterministic)
//   node   360 * h(host, 'node'), always (the archive has none). Per HOST (rec.host, else the record id), so the planets of one
//          system share one assumed orbital plane orientation instead of drawing as a starburst
//   incl   90 if the planet transits (disc_method 'Transit' or t_conj_mjd present), else acos(h(host, 'incl')) (isotropic, prograde),
//          also per host (a coplanar system stays coplanar)
//   omega  e > 0: 360 * h(id, 'omega')   (per planet); e = 0: 0
//   phase  M0 = 360 * h(id, 'phase') at J2000_MJD   (per planet)
//   e      the record's value, clamped to [0, 0.99]
const D2R = Math.PI / 180, TWO_PI = 2 * Math.PI;
export const J2000_MJD = 51544.5;

const finite = (q) => (q && Number.isFinite(q.v) ? q.v : null);

/** FNV-1a 32-bit of `${id}#${salt}` (UTF-8), as a fraction of 2^32 in [0, 1). */
export function hashUnit(id, salt) {
  const bytes = new TextEncoder().encode(`${id}#${salt}`);
  let h = 0x811c9dc5;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h / 4294967296;
}

/** Solves E - e sin E = M for E (radians). */
export function solveKepler(M, e) {
  e = Math.min(Math.max(e, 0), 0.99);
  M = ((M % TWO_PI) + TWO_PI) % TWO_PI;
  let E = e > 0.8 ? Math.PI : M + e * Math.sin(M);
  for (let i = 0; i < 50; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

/** North, east and toward-observer unit vectors in ICRS at a sky position (degrees); u is the unit vector Earth -> host. */
export function skyBasis(raDeg, decDeg) {
  const a = raDeg * D2R, d = decDeg * D2R, sa = Math.sin(a), ca = Math.cos(a), sd = Math.sin(d), cd = Math.cos(d);
  const u = [cd * ca, cd * sa, sd];
  return { N: [-sd * ca, -sd * sa, cd], E: [-sa, ca, 0], Z: [-u[0], -u[1], -u[2]], u };
}

const trueAnomaly = (E, e) => 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));

/** The orbit's elements with every unknown filled in by the documented rule (angles in radians). */
function orient(rec) {
  const p = rec && rec.position, el = p && p.elements;
  if (!el) return null;
  const P = finite(el.period_d), a = finite(el.a_au);
  if (!(P > 0) || !(a > 0)) return null;
  const id = rec.id || '', sys = rec.host || id, props = rec.props || {}, method = props.disc_method && props.disc_method.v;
  const eq = el.e, eVal = finite(eq);
  const e = Math.min(Math.max(eVal == null ? 0 : eVal, 0), 0.99);
  const assumed = { node: false, incl: false, omega: false, phase: false, ecc: eVal == null || (eq && eq.tier === 'illustrative') };
  let node = finite(el.node_deg), incl = finite(el.i_deg), omega = finite(el.omega_deg);
  const tConj = finite(el.t_conj_mjd), tPeri = finite(el.t_peri_mjd);
  if (node == null) { node = 360 * hashUnit(sys, 'node'); assumed.node = true; }
  if (incl == null) {
    const transits = method === 'Transit' || tConj != null;
    incl = transits ? 90 : Math.acos(hashUnit(sys, 'incl')) / D2R; assumed.incl = true;
  }
  if (omega == null) { omega = e > 0 ? 360 * hashUnit(id, 'omega') : 0; assumed.omega = true; }
  return { P, a, e, node, incl, omega, tConj, tPeri, assumed, el, id };
}

/** Rotates the orbital-plane position (r, u) into ICRS offsets from the host. */
function toIcrs(B, r, u, node, incl) {
  const cO = Math.cos(node), sO = Math.sin(node), ci = Math.cos(incl), si = Math.sin(incl), cu = Math.cos(u), su = Math.sin(u);
  const xn = r * (cO * cu - sO * su * ci), ye = r * (sO * cu + cO * su * ci), z = r * su * si;
  return [0, 1, 2].map((k) => xn * B.N[k] + ye * B.E[k] + z * B.Z[k]);
}

export function orbitPlacement(rec, mjd) {
  const o = orient(rec), hr = rec && rec.position && rec.position.host_radec;
  if (!o || !Array.isArray(hr) || !hr.every(Number.isFinite)) return null;
  const n = TWO_PI / o.P, e = o.e, w = o.omega * D2R, assumed = o.assumed;
  let M, source, t0 = null;
  if (o.tConj != null) {
    const nuC = Math.PI / 2 - w, Ec = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nuC / 2), Math.sqrt(1 + e) * Math.cos(nuC / 2));
    const Mc = Ec - e * Math.sin(Ec);
    M = Mc + n * (mjd - o.tConj); source = 'conjunction'; t0 = o.tConj;
  } else if (o.tPeri != null) {
    M = n * (mjd - o.tPeri); source = 'periastron'; t0 = o.tPeri;
  } else {
    M = 360 * hashUnit(o.id, 'phase') * D2R + n * (mjd - J2000_MJD); source = 'assumed'; assumed.phase = true;
  }
  const E = solveKepler(M, e), nu = trueAnomaly(E, e), r = o.a * (1 - e * Math.cos(E));
  const B = skyBasis(hr[0], hr[1]);
  const xyzAu = toIcrs(B, r, w + nu, o.node * D2R, o.incl * D2R);
  const pq = o.el.period_d, sigP = pq && Number.isFinite(pq.lo) && Number.isFinite(pq.hi) ? (pq.hi - pq.lo) / 2 : null;
  const phaseSigmaDeg = t0 != null && sigP != null ? 360 * Math.abs(mjd - t0) * sigP / (o.P * o.P) : null;
  return {
    xyzAu, assumed, phaseSource: source, phaseSigmaDeg,
    used: { node: o.node, incl: o.incl, omega: o.omega, ecc: e, a: o.a, period: o.P, trueAnomaly: nu / D2R, r },
  };
}

export function orbitPath(rec, n = 180) {
  const o = orient(rec), hr = rec && rec.position && rec.position.host_radec;
  if (!o || !Array.isArray(hr) || !hr.every(Number.isFinite)) return [];
  const B = skyBasis(hr[0], hr[1]), w = o.omega * D2R, e = o.e, out = [];
  for (let i = 0; i <= n; i++) {
    const E = (i === n ? 0 : i) / n * TWO_PI;
    out.push(toIcrs(B, o.a * (1 - e * Math.cos(E)), w + trueAnomaly(E, e), o.node * D2R, o.incl * D2R));
  }
  return out;
}
