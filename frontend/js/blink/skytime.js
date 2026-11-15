// Astronomy for the whole-sky rewind: calendar, Delta T, long-term precession, Earth rotation, the horizon
// frame of a place, and space motion of stars. Pure functions, tested against ERFA in tests/skytime.test.mjs.
//
// Accuracy (what is and is not modelled):
//   - Precession: Vondrak, Capitaine & Wallace (2011) long-term model, with the ICRS frame bias (ERFA eraLtpb).
//     Valid for +-200,000 years; close to IAU 2006 near J2000.
//   - Earth rotation: Earth Rotation Angle from UT1, equation of the origins from the precession matrix.
//   - Stars: straight-line motion through space from position, proper motion, parallax and radial velocity,
//     with the light-time correction used by ERFA eraStarpm.
//   - Not modelled: nutation (<= 17"), annual aberration (<= 20.5"), refraction (34' at the horizon, 1' at 45 deg).
const D2R = Math.PI / 180, AS2R = D2R / 3600, TAU = 2 * Math.PI;
export const JD2000 = 2451545.0;
export const JD_GREGORIAN = 2299160.5;            // 1582 October 15, 00:00 (first Gregorian day)
const KMS_PCYR = 1.0227121650537077e-6;            // 1 km/s in parsec per Julian year
const C_PCYR = 299792.458 * KMS_PCYR;              // speed of light in parsec per Julian year

// ------------------------------------------------------------------------------------- calendar
/**
 * Julian Day from a calendar date. Astronomical year numbering (1 BCE = year 0, 2 BCE = -1). Dates before
 * 1582 October 15 are in the Julian calendar, as historians and astronomers write them. `day` may be fractional.
 */
export function jdFromCalendar(year, month, day) {
  const greg = year > 1582 || (year === 1582 && (month > 10 || (month === 10 && day >= 15)));
  let y = year, m = month;
  if (m <= 2) { y -= 1; m += 12; }
  let b = 0;
  if (greg) { const a = Math.floor(y / 100); b = 2 - a + Math.floor(a / 4); }
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
}

/** Calendar date of a Julian Day (Julian calendar before 1582 October 15). */
export function calendarFromJd(jd) {
  const z = Math.floor(jd + 0.5), f = jd + 0.5 - z;
  let a = z;
  if (z >= 2299161) { const al = Math.floor((z - 1867216.25) / 36524.25); a = z + 1 + al - Math.floor(al / 4); }
  const b = a + 1524, c = Math.floor((b - 122.1) / 365.25), d = Math.floor(365.25 * c), e = Math.floor((b - d) / 30.6001);
  const dayF = b - d - Math.floor(30.6001 * e) + f;
  const month = e < 14 ? e - 1 : e - 13, year = month > 2 ? c - 4716 : c - 4715;
  const day = Math.floor(dayF), mins = Math.round((dayF - day) * 1440);
  return { year, month, day, hour: Math.floor(mins / 60) % 24, minute: mins % 60, dayFrac: dayF - day, julian: z < 2299161 };
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "26 CE", "2560 BCE" (astronomical year 0 is 1 BCE). */
export function fmtYear(y) {
  const n = y > 0 ? y : 1 - y, s = n >= 10000 ? n.toLocaleString('en-US') : String(n);
  return `${s} ${y > 0 ? 'CE' : 'BCE'}`;
}
/** Days in a month of a given (astronomical) year, Julian calendar before 1582. */
export function daysInMonth(year, month) {
  const next = month === 12 ? jdFromCalendar(year + 1, 1, 1) : jdFromCalendar(year, month + 1, 1);
  return Math.round(next - jdFromCalendar(year, month, 1));
}

/** Julian year (TT-ish) of a Julian Day. */
export const jyear = (jd) => 2000 + (jd - JD2000) / 365.25;

/**
 * Delta T = TT - UT1 in seconds (Espenak & Meeus 2006 polynomials, Morrison & Stephenson 2004 outside them).
 * Only the precession and star-motion time argument uses it, so its uncertainty (minutes, 2,000 years ago)
 * changes nothing visible; Earth's rotation is driven by UT, which local solar time fixes directly.
 */
export function deltaT(y) {
  const u = (y - 1820) / 100;
  if (y < -500 || y >= 2150) return -20 + 32 * u * u;
  if (y < 500) { const t = y / 100; return 10583.6 + t * (-1014.41 + t * (33.78311 + t * (-5.952053 + t * (-0.1798452 + t * (0.022174192 + t * 0.0090316521))))); }
  if (y < 1600) { const t = (y - 1000) / 100; return 1574.2 + t * (-556.01 + t * (71.23472 + t * (0.319781 + t * (-0.8503463 + t * (-0.005050998 + t * 0.0083572073))))); }
  if (y < 1700) { const t = y - 1600; return 120 - 0.9808 * t - 0.01532 * t * t + t ** 3 / 7129; }
  if (y < 1800) { const t = y - 1700; return 8.83 + 0.1603 * t - 0.0059285 * t * t + 0.00013336 * t ** 3 - t ** 4 / 1174000; }
  if (y < 1860) { const t = y - 1800; return 13.72 - 0.332447 * t + 0.0068612 * t ** 2 + 0.0041116 * t ** 3 - 0.00037436 * t ** 4 + 0.0000121272 * t ** 5 - 0.0000001699 * t ** 6 + 0.000000000875 * t ** 7; }
  if (y < 1900) { const t = y - 1860; return 7.62 + 0.5737 * t - 0.251754 * t ** 2 + 0.01680668 * t ** 3 - 0.0004473624 * t ** 4 + t ** 5 / 233174; }
  if (y < 1920) { const t = y - 1900; return -2.79 + 1.494119 * t - 0.0598939 * t ** 2 + 0.0061966 * t ** 3 - 0.000197 * t ** 4; }
  if (y < 1941) { const t = y - 1920; return 21.2 + 0.84493 * t - 0.0761 * t ** 2 + 0.0020936 * t ** 3; }
  if (y < 1961) { const t = y - 1950; return 29.07 + 0.407 * t - t * t / 233 + t ** 3 / 2547; }
  if (y < 1986) { const t = y - 1975; return 45.45 + 1.067 * t - t * t / 260 - t ** 3 / 718; }
  if (y < 2005) { const t = y - 2000; return 63.86 + 0.3345 * t - 0.060374 * t ** 2 + 0.0017275 * t ** 3 + 0.000651814 * t ** 4 + 0.00002373599 * t ** 5; }
  if (y < 2050) { const t = y - 2000; return 62.92 + 0.32217 * t + 0.005589 * t * t; }
  return -20 + 32 * u * u - 0.5628 * (2150 - y);
}

// ------------------------------------------------------------------------------------- vectors
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
/** r . v */
export const mxv = (r, v) => [dot(r[0], v), dot(r[1], v), dot(r[2], v)];
/** r^T . v */
export const mtxv = (r, v) => [r[0][0] * v[0] + r[1][0] * v[1] + r[2][0] * v[2], r[0][1] * v[0] + r[1][1] * v[1] + r[2][1] * v[2], r[0][2] * v[0] + r[1][2] * v[1] + r[2][2] * v[2]];
export const mxm = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
export const vecFromRaDec = (ra, dec) => { const a = ra * D2R, d = dec * D2R, c = Math.cos(d); return [c * Math.cos(a), c * Math.sin(a), Math.sin(d)]; };
export function raDecFromVec(v) {
  const r = Math.atan2(v[1], v[0]) / D2R;
  return { ra: ((r % 360) + 360) % 360, dec: Math.atan2(v[2], Math.hypot(v[0], v[1])) / D2R };
}

// ------------------------------------------------------------------------------------- precession
// Vondrak, Capitaine & Wallace 2011, A&A 534, A22 (with the 2012 erratum), as in ERFA eraLtpecl / eraLtpequ.
const PQPER = [
  [708.15, -5486.751211, -684.661560, 667.666730, -5523.863691],
  [2309.00, -17.127623, 2446.283880, -2354.886252, -549.747450],
  [1620.00, -617.517403, 399.671049, -428.152441, -310.998056],
  [492.20, 413.442940, -356.652376, 376.202861, 421.535876],
  [1183.00, 78.614193, -186.387003, 184.778874, -36.776172],
  [622.00, -180.732815, -316.800070, 335.321713, -145.278396],
  [882.00, -87.676083, 198.296701, -185.138669, -34.744450],
  [547.00, 46.140315, 101.135679, -120.972830, 22.885731],
];
const PQPOL = [[5851.607687, -0.1189000, -0.00028913, 0.000000101], [-1600.886300, 1.1689818, -0.00000020, -0.000000437]];
const XYPER = [
  [256.75, -819.940624, 75004.344875, 81491.287984, 1558.515853],
  [708.15, -8444.676815, 624.033993, 787.163481, 7774.939698],
  [274.20, 2600.009459, 1251.136893, 1251.296102, -2219.534038],
  [241.45, 2755.175630, -1102.212834, -1257.950837, -2523.969396],
  [2309.00, -167.659835, -2660.664980, -2966.799730, 247.850422],
  [492.20, 871.855056, 699.291817, 639.744522, -846.485643],
  [396.10, 44.769698, 153.167220, 131.600209, -1393.124055],
  [288.90, -512.313065, -950.865637, -445.040117, 368.526116],
  [231.10, -819.415595, 499.754645, 584.522874, 749.045012],
  [1610.00, -538.071099, -145.188210, -89.756563, 444.704518],
  [620.00, -189.793622, 558.116553, 524.429630, 235.934465],
  [157.87, -402.922932, -23.923029, -13.549067, 374.049623],
  [220.30, 179.516345, -165.405086, -210.157124, -171.330180],
  [1200.00, -9.814756, 9.344131, -44.919798, -22.899655],
];
const XYPOL = [[5453.282155, 0.4252841, -0.00037173, -0.000000152], [-73750.930350, -0.7675452, -0.00018725, 0.000000231]];

function series(epj, per, pol) {
  const t = (epj - 2000) / 100, w = TAU * t;
  let a = 0, b = 0;
  for (const p of per) { const ang = w / p[0], s = Math.sin(ang), c = Math.cos(ang); a += c * p[1] + s * p[3]; b += c * p[2] + s * p[4]; }
  let tt = 1;
  for (let i = 0; i < 4; i++) { a += pol[0][i] * tt; b += pol[1][i] * tt; tt *= t; }
  return [a * AS2R, b * AS2R];
}
/** Pole of the ecliptic of date in the J2000 mean frame. */
export function eclipticPole(epj) {
  const [p, q] = series(epj, PQPER, PQPOL), eps0 = 84381.406 * AS2R;
  const w = Math.sqrt(Math.max(0, 1 - p * p - q * q)), s = Math.sin(eps0), c = Math.cos(eps0);
  return [p, -q * c - w * s, -q * s + w * c];
}
/** Pole of the equator of date in the J2000 mean frame. */
export function equatorPole(epj) {
  const [x, y] = series(epj, XYPER, XYPOL);
  return [x, y, Math.sqrt(Math.max(0, 1 - x * x - y * y))];
}
/** Long-term precession matrix, J2000 mean -> mean of date (ERFA eraLtp). */
export function ltp(epj) {
  const peqr = equatorPole(epj), pecl = eclipticPole(epj);
  const eqx = unit(cross(peqr, pecl));
  return [eqx, cross(peqr, eqx), peqr];
}
const FB_DX = -0.016617 * AS2R, FB_DE = -0.0068192 * AS2R, FB_DR = -0.0146 * AS2R;
/** Long-term precession including the ICRS frame bias, ICRS -> mean of date (ERFA eraLtpb). */
export function ltpb(epj) {
  return ltp(epj).map((r) => [r[0] - r[1] * FB_DR + r[2] * FB_DX, r[0] * FB_DR + r[1] + r[2] * FB_DE, -r[0] * FB_DX - r[1] * FB_DE + r[2]]);
}
/** North pole of the equator of date, as an ICRS unit vector. */
export const poleOfDate = (epj) => ltpb(epj)[2];

// ------------------------------------------------------------------------------------- Earth rotation
/** Earth Rotation Angle (radians) at a UT1 Julian Day (IAU 2000, ERFA eraEra00). */
export function earthRotationAngle(jdUt1) {
  const t = jdUt1 - JD2000, f = ((jdUt1 % 1) + 1) % 1;
  const th = TAU * (f + 0.7790572732640 + 0.00273781191135448 * t);
  return ((th % TAU) + TAU) % TAU;
}
// CIO locator s, integrated from the long-term pole: s(t) = s(J2000) - integral of (X dY/dt - Y dX/dt) / (1 + Z).
// The IAU 2006 series for s is a polynomial fitted near J2000; over millennia its cubic term dominates (about
// 280" by 26 CE), so it is integrated here from the same Vondrak pole that drives the precession.
const S_T0 = -20500, S_T1 = 20500, S_H = 5, S_J2000 = 94e-6 * AS2R;
let sTab = null;
function sRate(t) {
  const h = 1e-3, a = ltpb(t)[2], b = ltpb(t + h)[2], c = ltpb(t - h)[2];
  const xd = (b[0] - c[0]) / (2 * h), yd = (b[1] - c[1]) / (2 * h);
  return -(a[0] * yd - a[1] * xd) / (1 + a[2]);
}
function buildSTable() {
  const n = Math.round((S_T1 - S_T0) / S_H), k0 = Math.round((2000 - S_T0) / S_H), tab = new Float64Array(n + 1);
  tab[k0] = S_J2000;
  const step = (t0, t1) => (t1 - t0) / 6 * (sRate(t0) + 4 * sRate((t0 + t1) / 2) + sRate(t1));   // Simpson
  for (let k = k0; k < n; k++) tab[k + 1] = tab[k] + step(S_T0 + k * S_H, S_T0 + (k + 1) * S_H);
  for (let k = k0; k > 0; k--) tab[k - 1] = tab[k] - step(S_T0 + (k - 1) * S_H, S_T0 + k * S_H);
  return tab;
}
/** CIO locator s (radians) at Julian year epj (valid -20,000 to +20,000). */
export function cioLocator(epj) {
  if (!sTab) sTab = buildSTable();
  const x = (Math.min(S_T1, Math.max(S_T0, epj)) - S_T0) / S_H, k = Math.min(sTab.length - 2, Math.floor(x)), f = x - k;
  return sTab[k] + (sTab[k + 1] - sTab[k]) * f;
}
/** Equation of the origins from a bias-precession matrix and the CIO locator s (ERFA eraEors). */
export function equationOfOrigins(r, s) {
  const x = r[2][0], ax = x / (1 + r[2][2]);
  const xs = 1 - ax * x, ys = -ax * r[2][1], zs = -x;
  const p = r[0][0] * xs + r[0][1] * ys + r[0][2] * zs, q = r[1][0] * xs + r[1][1] * ys + r[1][2] * zs;
  return p !== 0 || q !== 0 ? s - Math.atan2(q, p) : s;
}

/**
 * Everything the view needs for a place and instant. jdUt: UT Julian Day; lat/lon in degrees (east positive).
 * Returns { epj, prec (ICRS -> mean of date), theta (local sidereal angle, radians) }.
 */
export function skyState(jdUt, lon) {
  const cal = calendarFromJd(jdUt), y = cal.year + (cal.month - 0.5) / 12;
  const jdTt = jdUt + deltaT(y) / 86400, epj = jyear(jdTt);
  const prec = ltpb(epj);
  const theta = earthRotationAngle(jdUt) - equationOfOrigins(prec, cioLocator(epj)) + lon * D2R;
  return { epj, prec, theta };
}

/**
 * ICRS -> horizon matrix. Horizon axes: x = north, y = east, z = zenith.
 * theta: local sidereal angle of the equinox of date (radians), lat in degrees.
 */
export function horizonMatrix(prec, theta, lat) {
  const c = Math.cos(theta), s = Math.sin(theta), p = lat * D2R, sp = Math.sin(p), cp = Math.cos(p);
  const rz = [[c, s, 0], [-s, c, 0], [0, 0, 1]];
  const h = [[-sp, 0, cp], [0, 1, 0], [cp, 0, sp]];
  return mxm(h, mxm(rz, prec));
}
/** Unit vector in the horizon frame from azimuth (from north through east) and altitude, degrees. */
export function vecFromAltAz(az, alt) {
  const a = az * D2R, h = alt * D2R, c = Math.cos(h);
  return [c * Math.cos(a), c * Math.sin(a), Math.sin(h)];
}
export function altAzFromVec(v) {
  const az = Math.atan2(v[1], v[0]) / D2R;
  return { az: ((az % 360) + 360) % 360, alt: Math.asin(Math.max(-1, Math.min(1, v[2]))) / D2R };
}

/** Position angle (degrees, north through east) at ICRS point c of the direction towards ICRS point z. */
export function positionAngle(c, z) {
  const { ra, dec } = raDecFromVec(c), a = ra * D2R, d = dec * D2R;
  const n = [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)], e = [-Math.sin(a), Math.cos(a), 0];
  return Math.atan2(dot(z, e), dot(z, n)) / D2R;
}

// ------------------------------------------------------------------------------------- stars
/**
 * Prepare a star for propagation. ra/dec degrees at `epoch` (Julian year), pm in mas/yr (pmra includes cos dec),
 * plx in mas, rv in km/s. Stars without a positive parallax move on the sky with constant proper motion.
 */
export function makeStar(ra, dec, pmra, pmdec, plx, rv, epoch) {
  const a = ra * D2R, d = dec * D2R, sa = Math.sin(a), ca = Math.cos(a), sd = Math.sin(d), cd = Math.cos(d);
  const u = [cd * ca, cd * sa, sd], p = [-sa, ca, 0], q = [-sd * ca, -sd * sa, cd];
  const ma = (pmra || 0) * AS2R / 1000, md = (pmdec || 0) * AS2R / 1000;
  if (!(plx > 0)) return { epoch, r: 0, pos: u, vel: [ma * p[0] + md * q[0], ma * p[1] + md * q[1], ma * p[2] + md * q[2]] };
  const r = 1000 / plx;
  const t = [r * (ma * p[0] + md * q[0]), r * (ma * p[1] + md * q[1]), r * (ma * p[2] + md * q[2])];
  // Observed -> inertial velocity (special-relativistic light-time terms, as ERFA eraStarpv).
  const bsr = (rv || 0) * KMS_PCYR / C_PCYR, bst = Math.hypot(t[0], t[1], t[2]) / C_PCYR;
  let br = bsr, bt = bst, dop = 1, del = 0;
  for (let i = 0; i < 100; i++) {
    dop = 1 + br; const w = br * br + bt * bt; del = -w / (Math.sqrt(1 - w) + 1);
    const nbr = dop * bsr + del, nbt = dop * bst;
    if (Math.abs(nbr - br) < 1e-15 && Math.abs(nbt - bt) < 1e-15) { br = nbr; bt = nbt; break; }
    br = nbr; bt = nbt;
  }
  const vr = C_PCYR * (dop * bsr + del);
  return { epoch, r, pos: [r * u[0], r * u[1], r * u[2]], vel: [dop * t[0] + vr * u[0], dop * t[1] + vr * u[1], dop * t[2] + vr * u[2]] };
}
/**
 * Where a star appears at Julian year `epj`: { v (ICRS unit vector), dmag (brightness change from distance) }.
 * Straight-line space motion with the light-time correction of ERFA eraStarpm.
 */
export function starAt(st, epj) {
  const dt = epj - st.epoch, P = st.pos, V = st.vel;
  if (!st.r) return { v: unit([P[0] + V[0] * dt, P[1] + V[1] * dt, P[2] + V[2] * dt]), dmag: 0 };
  let te = dt, x = 0, y = 0, z = 0, r2 = st.r;
  for (let k = 0; k < 3; k++) {
    x = P[0] + V[0] * te; y = P[1] + V[1] * te; z = P[2] + V[2] * te;
    r2 = Math.hypot(x, y, z); te = dt + (st.r - r2) / C_PCYR;
  }
  return { v: [x / r2, y / r2, z / r2], dmag: 5 * Math.log10(r2 / st.r) };
}

/** Angle in degrees between two unit vectors. */
export function angleBetween(a, b) {
  const c = cross(a, b);
  return Math.atan2(Math.hypot(c[0], c[1], c[2]), dot(a, b)) / D2R;
}
