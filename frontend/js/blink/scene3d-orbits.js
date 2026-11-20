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
//   compileOrbit(rec) -> plan | null     everything orbitPlacement does except the Kepler solve (section 20.4.3): the hashed or
//       given node, inclination, omega and phase, the sky basis, the two ICRS 3-vectors P and Q that map (r cos nu, r sin nu)
//       to an offset from the host, the period, the phase epoch and source, sigma_P. null when orbitPlacement would be null.
//   evalOrbit(plan, mjd, out) -> out     solves Kepler (warm-started from the plan's last E, so a frame costs one or two Newton
//       steps) and writes the ICRS offset in AU into out[0..2]; no allocation. Equal to orbitPlacement(rec, mjd).xyzAu to ~1e-15 AU.
//   phaseSigmaAt(plan, mjd) -> degrees | null     360 |t - T0| sigmaP / P^2 (section 16.6), null when the phase is assumed or sigmaP unknown
//   orbitPathCompiled(plan, n = 180) / orbitPathInto(plan, n, out)   the orbitPath points from a plan (array of triples / flat Float64Array)
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

/** Rotates the orbital-plane position (r, u) into ICRS offsets from the host (unit r: the P and Q vectors of compileOrbit). */
function toIcrs(B, r, u, node, incl) {
  const cO = Math.cos(node), sO = Math.sin(node), ci = Math.cos(incl), si = Math.sin(incl), cu = Math.cos(u), su = Math.sin(u);
  const xn = r * (cO * cu - sO * su * ci), ye = r * (sO * cu + cO * su * ci), z = r * su * si;
  return [0, 1, 2].map((k) => xn * B.N[k] + ye * B.E[k] + z * B.Z[k]);
}

/** Newton for E - e sin E = M with M already in [0, 2 pi); starts at E0, and falls back to the cold start of solveKepler if it does not converge. */
function keplerFrom(M, e, E0) {
  let E = E0;
  for (let i = 0; i < 50; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) return E;
  }
  return solveKepler(M, e);
}

/**
 * Compiles a record's orbit (section 20.4.3). The plan holds: id, P, a, e, w (omega, rad), node, incl (rad), n = 2 pi / P (rad/d),
 * source ('conjunction' | 'periastron' | 'assumed'), tRef (the mjd where the mean anomaly is Mref), phaseEpoch (T0 of the phase sigma,
 * null when assumed), sigP (days or null), assumed (flags), P3 and Q3 (ICRS vectors), bq = a sqrt(1 - e^2), and the warm-start state E and Mw.
 */
export function compileOrbit(rec) {
  const o = orient(rec), hr = rec && rec.position && rec.position.host_radec;
  if (!o || !Array.isArray(hr) || !hr.every(Number.isFinite)) return null;
  const e = o.e, w = o.omega * D2R, assumed = o.assumed;
  let source, tRef, Mref, phaseEpoch = null;
  if (o.tConj != null) {
    const nuC = Math.PI / 2 - w, Ec = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nuC / 2), Math.sqrt(1 + e) * Math.cos(nuC / 2));
    Mref = Ec - e * Math.sin(Ec); source = 'conjunction'; tRef = phaseEpoch = o.tConj;
  } else if (o.tPeri != null) {
    Mref = 0; source = 'periastron'; tRef = phaseEpoch = o.tPeri;
  } else {
    Mref = 360 * hashUnit(o.id, 'phase') * D2R; source = 'assumed'; tRef = J2000_MJD; assumed.phase = true;
  }
  const B = skyBasis(hr[0], hr[1]), node = o.node * D2R, incl = o.incl * D2R;
  const pq = o.el.period_d, sigP = pq && Number.isFinite(pq.lo) && Number.isFinite(pq.hi) ? (pq.hi - pq.lo) / 2 : null;
  return {
    id: o.id, P: o.P, a: o.a, e, w, node, incl, n: TWO_PI / o.P, source, tRef, Mref, phaseEpoch, sigP, assumed, B,
    P3: toIcrs(B, 1, w, node, incl), Q3: toIcrs(B, 1, w + Math.PI / 2, node, incl), bq: o.a * Math.sqrt(1 - e * e),
    E: NaN, Mw: NaN, used: { node: o.node, incl: o.incl, omega: o.omega, ecc: e, a: o.a, period: o.P },
  };
}

/** The mean anomaly of a plan at mjd (rad, unwrapped). */
const meanAnomaly = (plan, mjd) => plan.Mref + plan.n * (mjd - plan.tRef);

/** Solves the plan's Kepler equation at mjd, warm-started from its previous solution; leaves plan.E, plan.Mw current and returns E. */
function solvePlan(plan, mjd) {
  const M = ((meanAnomaly(plan, mjd) % TWO_PI) + TWO_PI) % TWO_PI;
  const E0 = plan.E === plan.E ? plan.E + (M - plan.Mw) : (plan.e > 0.8 ? Math.PI : M + plan.e * Math.sin(M));
  plan.E = keplerFrom(M, plan.e, E0); plan.Mw = M;
  return plan.E;
}

/** Offset from the host (AU, ICRS) of the plan's body at mjd, into out (no allocation); see compileOrbit. */
export function evalOrbit(plan, mjd, out) {
  const E = solvePlan(plan, mjd), x = plan.a * (Math.cos(E) - plan.e), y = plan.bq * Math.sin(E), P = plan.P3, Q = plan.Q3;
  out[0] = x * P[0] + y * Q[0]; out[1] = x * P[1] + y * Q[1]; out[2] = x * P[2] + y * Q[2];
  return out;
}

/** Phase uncertainty in degrees at mjd (section 16.6: 360 |t - T0| sigmaP / P^2), null when the phase is assumed or sigmaP is unknown. */
export function phaseSigmaAt(plan, mjd) {
  return plan.phaseEpoch != null && plan.sigP != null ? 360 * Math.abs(mjd - plan.phaseEpoch) * plan.sigP / (plan.P * plan.P) : null;
}

export function orbitPlacement(rec, mjd) {
  const plan = compileOrbit(rec);
  if (!plan) return null;
  const xyzAu = evalOrbit(plan, mjd, [0, 0, 0]), E = plan.E, e = plan.e;
  return {
    xyzAu, assumed: { ...plan.assumed }, phaseSource: plan.source, phaseSigmaDeg: phaseSigmaAt(plan, mjd),
    used: { ...plan.used, trueAnomaly: trueAnomaly(E, e) / D2R, r: plan.a * (1 - e * Math.cos(E)) },
  };
}

/** The orbit's points into out (flat x, y, z; n + 1 points, the last repeating the first), uniform in eccentric anomaly. */
export function orbitPathInto(plan, n, out) {
  for (let i = 0; i <= n; i++) {
    const E = (i === n ? 0 : i) / n * TWO_PI, x = plan.a * (Math.cos(E) - plan.e), y = plan.bq * Math.sin(E), P = plan.P3, Q = plan.Q3;
    out[3 * i] = x * P[0] + y * Q[0]; out[3 * i + 1] = x * P[1] + y * Q[1]; out[3 * i + 2] = x * P[2] + y * Q[2];
  }
  return out;
}

/** orbitPath from a compiled plan: [[x, y, z], ...]. */
export function orbitPathCompiled(plan, n = 180) {
  const flat = orbitPathInto(plan, n, new Float64Array(3 * (n + 1))), out = [];
  for (let i = 0; i <= n; i++) out.push([flat[3 * i], flat[3 * i + 1], flat[3 * i + 2]]);
  return out;
}

export function orbitPath(rec, n = 180) {
  const plan = compileOrbit(rec);
  return plan ? orbitPathCompiled(plan, n) : [];
}
