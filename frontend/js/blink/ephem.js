// Sun, Moon and planets for the whole-sky rewind, from 15,000 BCE to 15,000 CE.
//
// Planets and the Sun: Simon et al. (1994, A&A 282, 663) mean elements with their long-period trigonometric
// terms, as in ERFA eraPlan94. Moon: Meeus (1998, ch. 47, after ELP-2000/82), as in ERFA eraMoon98, but
// carried from the mean ecliptic of date to ICRS with the Vondrak (2011) long-term poles of skytime.js instead
// of the IAU 2006 polynomial precession (which is fitted near J2000 and diverges over millennia).
//
// Geocentric direction error against JPL DE441 (measured by hand with pyerfa and JPL Horizons; see
// docs/technical-reference.md): Sun <= 0.07 deg, Mercury to Mars <= 0.25 deg, Jupiter and Saturn about 1 deg,
// and the Moon 0.2 deg at 3000 BCE and about 2 deg at 9900 BCE (not counting the uncertainty of Delta T).
// Beyond 10,000 BCE (DE441's limit) the errors are extrapolated: Jupiter and Saturn 2-3 deg, the Moon 4-6 deg.
// Not modelled: nutation and aberration (the star layer has neither), Saturn's rings in its brightness.
//
// The tables and algorithms are transcribed from ERFA 2.0 (src/plan94.c, src/moon98.c):
//   Copyright (C) 2013-2023, NumFOCUS Foundation. Derived, with permission, from the SOFA library.
//   Redistribution and use in source and binary forms, with or without modification, are permitted provided
//   that the following conditions are met: (1) redistributions of source code must retain the above copyright
//   notice, this list of conditions and the following disclaimer; (2) redistributions in binary form must
//   reproduce the above copyright notice, this list of conditions and the following disclaimer in the
//   documentation and/or other materials provided with the distribution; (3) neither the name of the Standards
//   Of Fundamental Astronomy Board, the International Astronomical Union nor the names of its contributors may
//   be used to endorse or promote products derived from this software without specific prior written
//   permission. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
//   IMPLIED WARRANTIES ARE DISCLAIMED (full text: https://github.com/liberfa/erfa/blob/master/LICENSE).
import { JD2000, jyear, dot, eclipticPole, equatorPole } from './skytime.js';

const D2R = Math.PI / 180, AS2R = D2R / 3600, TAU = 2 * Math.PI;
const AU_KM = 149597870.7, AU_M = AU_KM * 1000;
const LIGHT_DAY_PER_AU = 0.0057755183;   // light time for one au, days
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const fmod = (a, b) => a % b;            // C fmod and JS % agree (sign of the dividend)
const anpm = (a) => { let w = fmod(a, TAU); if (Math.abs(w) >= Math.PI) w -= Math.sign(a) * TAU; return w; };

// ------------------------------------------------------------------------------------- eraPlan94 tables
const P_AMAS = [6023600, 408523.5, 328900.5, 3098710, 1047.355, 3498.5, 22869, 19314];
const P_A = [
  [0.3870983098, 0, 0],
  [0.72332982, 0, 0],
  [1.0000010178, 0, 0],
  [1.5236793419, 3e-10, 0],
  [5.2026032092, 1.9132e-06, -3.9e-09],
  [9.5549091915, -2.13896e-05, 4.44e-08],
  [19.2184460618, -3.716e-07, 9.79e-08],
  [30.1103868694, -1.6635e-06, 6.86e-08],
];
const P_DLM = [
  [252.25090552, 5381016286.88982, -1.92789],
  [181.97980085, 2106641364.33548, 0.59381],
  [100.46645683, 1295977422.83429, -2.04411],
  [355.43299958, 689050774.93988, 0.94264],
  [34.35151874, 109256603.77991, -30.60378],
  [50.0774443, 43996098.55732, 75.61614],
  [314.05500511, 15424811.93933, -1.75083],
  [304.34866548, 7865503.20744, 0.21103],
];
const P_E = [
  [0.2056317526, 0.0002040653, -2.8349e-06],
  [0.0067719164, -0.0004776521, 9.8127e-06],
  [0.0167086342, -0.0004203654, -1.26734e-05],
  [0.0934006477, 0.0009048438, -8.0641e-06],
  [0.0484979255, 0.0016322542, -4.71366e-05],
  [0.0555481426, -0.0034664062, -6.43639e-05],
  [0.0463812221, -0.0002729293, 7.8913e-06],
  [0.009455747, 6.03263e-05, 0],
];
const P_PI = [
  [77.45611904, 5719.1159, -4.83016],
  [131.563703, 175.4864, -498.48184],
  [102.93734808, 11612.3529, 53.27577],
  [336.06023395, 15980.45908, -62.328],
  [14.33120687, 7758.75163, 259.95938],
  [93.05723748, 20395.49439, 190.25952],
  [173.00529106, 3215.56238, -34.09288],
  [48.12027554, 1050.71912, 27.39717],
];
const P_DINC = [
  [7.00498625, -214.25629, 0.28977],
  [3.39466189, -30.84437, -11.67836],
  [0, 469.97289, -3.35053],
  [1.84972648, -293.31722, -8.1183],
  [1.30326698, -71.5589, 11.95297],
  [2.48887878, 91.85195, -17.66225],
  [0.77319689, -60.72723, 1.25759],
  [1.76995259, 8.12333, 0.08135],
];
const P_OMEGA = [
  [48.33089304, -4515.21727, -31.79892],
  [76.67992019, -10008.48154, -51.32614],
  [174.87317577, -8679.27034, 15.34191],
  [49.55809321, -10620.90088, -230.57416],
  [100.46440702, 6362.03561, 326.52178],
  [113.66550252, -9240.19942, -66.23743],
  [74.00595701, 2669.15033, 145.93964],
  [131.78405702, -221.94322, -0.78728],
];
const P_KP = [
  [69613, 75645, 88306, 59899, 15746, 71087, 142173, 3086, 0],
  [21863, 32794, 26934, 10931, 26250, 43725, 53867, 28939, 0],
  [16002, 21863, 32004, 10931, 14529, 16368, 15318, 32794, 0],
  [6345, 7818, 15636, 7077, 8184, 14163, 1107, 4872, 0],
  [1760, 1454, 1167, 880, 287, 2640, 19, 2047, 1454],
  [574, 0, 880, 287, 19, 1760, 1167, 306, 574],
  [204, 0, 177, 1265, 4, 385, 200, 208, 204],
  [0, 102, 106, 4, 98, 1367, 487, 204, 0],
];
const P_CA = [
  [4, -13, 11, -9, -9, -3, -1, 4, 0],
  [-156, 59, -42, 6, 19, -20, -10, -12, 0],
  [64, -152, 62, -8, 32, -41, 19, -11, 0],
  [124, 621, -145, 208, 54, -57, 30, 15, 0],
  [-23437, -2634, 6601, 6259, -1507, -1821, 2620, -2115, -1489],
  [62911, -119919, 79336, 17814, -24241, 12068, 8306, -4893, 8902],
  [389061, -262125, -44088, 8387, -22976, -2093, -615, -9720, 6633],
  [-412235, -157046, -31430, 37817, -9740, -13, -7449, 9644, 0],
];
const P_SA = [
  [-29, -1, 9, 6, -6, 5, 4, 0, 0],
  [-48, -125, -26, -37, 18, -13, -20, -2, 0],
  [-150, -46, 68, 54, 14, 24, -28, 22, 0],
  [-621, 532, -694, -20, 192, -94, 71, -73, 0],
  [-14614, -19828, -5869, 1881, -4372, -2255, 782, 930, 913],
  [139737, 0, 24667, 51123, -5102, 7429, -4095, -1976, -9566],
  [-138081, 0, 37205, -49039, -41901, -33872, -27037, -12474, 18797],
  [0, 28492, 133236, 69654, 52322, -49577, -26430, -3593, 0],
];
const P_KQ = [
  [3086, 15746, 69613, 59899, 75645, 88306, 12661, 2658, 0, 0],
  [21863, 32794, 10931, 73, 4387, 26934, 1473, 2157, 0, 0],
  [10, 16002, 21863, 10931, 1473, 32004, 4387, 73, 0, 0],
  [10, 6345, 7818, 1107, 15636, 7077, 8184, 532, 10, 0],
  [19, 1760, 1454, 287, 1167, 880, 574, 2640, 19, 1454],
  [19, 574, 287, 306, 1760, 12, 31, 38, 19, 574],
  [4, 204, 177, 8, 31, 200, 1265, 102, 4, 204],
  [4, 102, 106, 8, 98, 1367, 487, 204, 4, 102],
];
const P_CL = [
  [21, -95, -157, 41, -5, 42, 23, 30, 0, 0],
  [-160, -313, -235, 60, -74, -76, -27, 34, 0, 0],
  [-325, -322, -79, 232, -52, 97, 55, -41, 0, 0],
  [2268, -979, 802, 602, -668, -33, 345, 201, -55, 0],
  [7610, -4997, -7689, -5841, -2617, 1115, -748, -607, 6074, 354],
  [-18549, 30125, 20012, -730, 824, 23, 1289, -352, -14767, -2062],
  [-135245, -14594, 4197, -4030, -5630, -2898, 2540, -306, 2939, 1986],
  [89948, 2103, 8963, 2695, 3682, 1648, 866, -154, -1963, -283],
];
const P_SL = [
  [-342, 136, -23, 62, 66, -52, -33, 17, 0, 0],
  [524, -149, -35, 117, 151, 122, -71, -62, 0, 0],
  [-105, -137, 258, 35, -116, -88, -112, -80, 0, 0],
  [854, -205, -936, -240, 140, -341, -97, -232, 536, 0],
  [-56980, 8016, 1012, 1448, -3024, -3710, 318, 503, 3767, 577],
  [138606, -13478, -4964, 1441, -1319, -1482, 427, 1236, -9167, -1918],
  [71234, -41116, 5334, -4935, -1848, 66, 434, -1748, 3780, -701],
  [-47645, 11647, 2166, 3194, 679, 0, -244, -419, -2531, 48],
];

const GK = 0.017202098950, SINEPS = 0.3977771559319137, COSEPS = 0.9174820620691818;

/**
 * Heliocentric position (au) of planet np (1 Mercury, 2 Venus, 3 Earth-Moon barycentre, 4 Mars, 5 Jupiter,
 * 6 Saturn, 7 Uranus, 8 Neptune) at TT Julian Day jd, in the J2000 mean equator and equinox (ICRS to 23 mas).
 * A port of ERFA eraPlan94 without the velocity and without its validity flag (it is used far beyond
 * 1000-3000 CE here on purpose; see the accuracy note at the top).
 */
export function plan94(jd, np) {
  const i = np - 1, t = (jd - JD2000) / 365250;
  let da = P_A[i][0] + (P_A[i][1] + P_A[i][2] * t) * t;
  let dl = (3600 * P_DLM[i][0] + (P_DLM[i][1] + P_DLM[i][2] * t) * t) * AS2R;
  const de = P_E[i][0] + (P_E[i][1] + P_E[i][2] * t) * t;
  const dp = anpm((3600 * P_PI[i][0] + (P_PI[i][1] + P_PI[i][2] * t) * t) * AS2R);
  const di = (3600 * P_DINC[i][0] + (P_DINC[i][1] + P_DINC[i][2] * t) * t) * AS2R;
  const dom = anpm((3600 * P_OMEGA[i][0] + (P_OMEGA[i][1] + P_OMEGA[i][2] * t) * t) * AS2R);
  const dmu = 0.35953620 * t;
  for (let k = 0; k < 8; k++) {
    const arga = P_KP[i][k] * dmu, argl = P_KQ[i][k] * dmu;
    da += (P_CA[i][k] * Math.cos(arga) + P_SA[i][k] * Math.sin(arga)) * 1e-7;
    dl += (P_CL[i][k] * Math.cos(argl) + P_SL[i][k] * Math.sin(argl)) * 1e-7;
  }
  const arga = P_KP[i][8] * dmu;
  da += t * (P_CA[i][8] * Math.cos(arga) + P_SA[i][8] * Math.sin(arga)) * 1e-7;
  for (let k = 8; k < 10; k++) {
    const argl = P_KQ[i][k] * dmu;
    dl += t * (P_CL[i][k] * Math.cos(argl) + P_SL[i][k] * Math.sin(argl)) * 1e-7;
  }
  dl = fmod(dl, TAU);
  // Kepler's equation
  const am = dl - dp;
  let ae = am + de * Math.sin(am), dae = 1;
  for (let k = 0; k < 10 && Math.abs(dae) > 1e-12; k++) {
    dae = (am - ae + de * Math.sin(ae)) / (1 - de * Math.cos(ae));
    ae += dae;
  }
  const ae2 = ae / 2, at = 2 * Math.atan2(Math.sqrt((1 + de) / (1 - de)) * Math.sin(ae2), Math.cos(ae2));
  const r = da * (1 - de * Math.cos(ae));
  const si2 = Math.sin(di / 2), xq = si2 * Math.cos(dom), xp = si2 * Math.sin(dom);
  const tl = at + dp, xsw = Math.sin(tl), xcw = Math.cos(tl), xm2 = 2 * (xp * xcw - xq * xsw), ci2 = Math.cos(di / 2);
  const x = r * (xcw - xm2 * xp), y = r * (xsw + xm2 * xq), z = r * (-xm2 * ci2);
  return [x, y * COSEPS - z * SINEPS, y * SINEPS + z * COSEPS];
}

// ------------------------------------------------------------------------------------- eraMoon98 tables
// 60 terms: D, M, M', F, sum l (deg), sum r (m)
const M_TLR = [
  0, 0, 1, 0, 6.288774, -20905355, 2, 0, -1, 0, 1.274027, -3699111, 2, 0, 0, 0, 0.658314, -2955968,
  0, 0, 2, 0, 0.213618, -569925, 0, 1, 0, 0, -0.185116, 48888, 0, 0, 0, 2, -0.114332, -3149,
  2, 0, -2, 0, 0.058793, 246158, 2, -1, -1, 0, 0.057066, -152138, 2, 0, 1, 0, 0.053322, -170733,
  2, -1, 0, 0, 0.045758, -204586, 0, 1, -1, 0, -0.040923, -129620, 1, 0, 0, 0, -0.03472, 108743,
  0, 1, 1, 0, -0.030383, 104755, 2, 0, 0, -2, 0.015327, 10321, 0, 0, 1, 2, -0.012528, 0,
  0, 0, 1, -2, 0.01098, 79661, 4, 0, -1, 0, 0.010675, -34782, 0, 0, 3, 0, 0.010034, -23210,
  4, 0, -2, 0, 0.008548, -21636, 2, 1, -1, 0, -0.007888, 24208, 2, 1, 0, 0, -0.006766, 30824,
  1, 0, -1, 0, -0.005163, -8379, 1, 1, 0, 0, 0.004987, -16675, 2, -1, 1, 0, 0.004036, -12831,
  2, 0, 2, 0, 0.003994, -10445, 4, 0, 0, 0, 0.003861, -11650, 2, 0, -3, 0, 0.003665, 14403,
  0, 1, -2, 0, -0.002689, -7003, 2, 0, -1, 2, -0.002602, 0, 2, -1, -2, 0, 0.00239, 10056,
  1, 0, 1, 0, -0.002348, 6322, 2, -2, 0, 0, 0.002236, -9884, 0, 1, 2, 0, -0.00212, 5751,
  0, 2, 0, 0, -0.002069, 0, 2, -2, -1, 0, 0.002048, -4950, 2, 0, 1, -2, -0.001773, 4130,
  2, 0, 0, 2, -0.001595, 0, 4, -1, -1, 0, 0.001215, -3958, 0, 0, 2, 2, -0.00111, 0,
  3, 0, -1, 0, -0.000892, 3258, 2, 1, 1, 0, -0.00081, 2616, 4, -1, -2, 0, 0.000759, -1897,
  0, 2, -1, 0, -0.000713, -2117, 2, 2, -1, 0, -0.0007, 2354, 2, 1, -2, 0, 0.000691, 0,
  2, -1, 0, -2, 0.000596, 0, 4, 0, 1, 0, 0.000549, -1423, 0, 0, 4, 0, 0.000537, -1117,
  4, -1, 0, 0, 0.00052, -1571, 1, 0, -2, 0, -0.000487, -1739, 2, 1, 0, -2, -0.000399, 0,
  0, 0, 2, -2, -0.000381, -4421, 1, 1, 1, 0, 0.000351, 0, 3, 0, -2, 0, -0.00034, 0,
  4, 0, -3, 0, 0.00033, 0, 2, -1, 2, 0, 0.000327, 0, 0, 2, 1, 0, -0.000323, 1165,
  1, 1, -1, 0, 0.000299, 0, 2, 0, 3, 0, 0.000294, 0, 2, 0, -1, -2, 0, 8752,
];
// 60 terms: D, M, M', F, sum b (deg)
const M_TB = [
  0, 0, 0, 1, 5.128122, 0, 0, 1, 1, 0.280602, 0, 0, 1, -1, 0.277693,
  2, 0, 0, -1, 0.173237, 2, 0, -1, 1, 0.055413, 2, 0, -1, -1, 0.046271,
  2, 0, 0, 1, 0.032573, 0, 0, 2, 1, 0.017198, 2, 0, 1, -1, 0.009266,
  0, 0, 2, -1, 0.008822, 2, -1, 0, -1, 0.008216, 2, 0, -2, -1, 0.004324,
  2, 0, 1, 1, 0.0042, 2, 1, 0, -1, -0.003359, 2, -1, -1, 1, 0.002463,
  2, -1, 0, 1, 0.002211, 2, -1, -1, -1, 0.002065, 0, 1, -1, -1, -0.00187,
  4, 0, -1, -1, 0.001828, 0, 1, 0, 1, -0.001794, 0, 0, 0, 3, -0.001749,
  0, 1, -1, 1, -0.001565, 1, 0, 0, 1, -0.001491, 0, 1, 1, 1, -0.001475,
  0, 1, 1, -1, -0.00141, 0, 1, 0, -1, -0.001344, 1, 0, 0, -1, -0.001335,
  0, 0, 3, 1, 0.001107, 4, 0, 0, -1, 0.001021, 4, 0, -1, 1, 0.000833,
  0, 0, 1, -3, 0.000777, 4, 0, -2, 1, 0.000671, 2, 0, 0, -3, 0.000607,
  2, 0, 2, -1, 0.000596, 2, -1, 1, -1, 0.000491, 2, 0, -2, 1, -0.000451,
  0, 0, 3, -1, 0.000439, 2, 0, 2, 1, 0.000422, 2, 0, -3, -1, 0.000421,
  2, 1, -1, 1, -0.000366, 2, 1, 0, 1, -0.000351, 4, 0, 0, 1, 0.000331,
  2, -1, 1, 1, 0.000315, 2, -2, 0, -1, 0.000302, 0, 0, 1, 3, -0.000283,
  2, 1, 1, -1, -0.000229, 1, 1, 0, -1, 0.000223, 1, 1, 0, 1, 0.000223,
  0, 1, -2, -1, -0.00022, 2, 1, -1, -1, -0.00022, 1, 0, 1, 1, -0.000185,
  2, -1, -2, -1, 0.000181, 0, 1, 2, 1, -0.000177, 4, 0, -2, -1, 0.000176,
  4, -1, -1, -1, 0.000166, 1, 0, 1, -1, -0.000164, 4, 0, 1, -1, 0.000132,
  1, 0, -1, -1, -0.000119, 4, -1, 0, -1, 0.000115, 2, -2, 0, 1, 0.000107,
];

const poly4 = (c, t) => c[0] + (c[1] + (c[2] + (c[3] + c[4] * t) * t) * t) * t;
const ELP = [218.31665436, 481267.88123421, -0.0015786, 1 / 538841, -1 / 65194000];
const DEL = [297.8501921, 445267.1114034, -0.0018819, 1 / 545868, 1 / 113065000];
const EM = [357.5291092, 35999.0502909, -0.0001536, 1 / 24490000, 0];
const EMP = [134.9633964, 477198.8675055, 0.0087414, 1 / 69699, -1 / 14712000];
const FF = [93.2720950, 483202.0175233, -0.0036539, 1 / 3526000, 1 / 863310000];

/**
 * Geocentric Moon at TT Julian Day jd in the mean ecliptic and equinox of date: { lon, lat (radians), r (au) }.
 * The series of ERFA eraMoon98 (Meeus 1998, ch. 47), without its final IAU 2006 precession.
 */
export function moonEcliptic(jd) {
  const t = (jd - JD2000) / 36525;
  const elp = D2R * fmod(poly4(ELP, t), 360), d = D2R * fmod(poly4(DEL, t), 360), em = D2R * fmod(poly4(EM, t), 360);
  const emp = D2R * fmod(poly4(EMP, t), 360), f = D2R * fmod(poly4(FF, t), 360);
  const a1 = D2R * (119.75 + 131.849 * t), a2 = D2R * (53.09 + 479264.290 * t), a3 = D2R * (313.45 + 481266.484 * t);
  const e = 1 + (-0.002516 - 0.0000074 * t) * t, esq = e * e;
  let vel = 0.003958 * Math.sin(a1) + 0.001962 * Math.sin(elp - f) + 0.000318 * Math.sin(a2), vr = 0;
  let vb = -0.002235 * Math.sin(elp) + 0.000382 * Math.sin(a3) + 0.000175 * Math.sin(a1 - f) + 0.000175 * Math.sin(a1 + f)
    + 0.000127 * Math.sin(elp - emp) - 0.000115 * Math.sin(elp + emp);
  const ef = (m) => (Math.abs(m) === 1 ? e : Math.abs(m) === 2 ? esq : 1);
  for (let n = M_TLR.length / 6 - 1; n >= 0; n--) {
    const k = n * 6, arg = M_TLR[k] * d + M_TLR[k + 1] * em + M_TLR[k + 2] * emp + M_TLR[k + 3] * f, en = ef(M_TLR[k + 1]);
    vel += M_TLR[k + 4] * Math.sin(arg) * en;
    vr += M_TLR[k + 5] * Math.cos(arg) * en;
  }
  for (let n = M_TB.length / 5 - 1; n >= 0; n--) {
    const k = n * 5, arg = M_TB[k] * d + M_TB[k + 1] * em + M_TB[k + 2] * emp + M_TB[k + 3] * f;
    vb += M_TB[k + 4] * Math.sin(arg) * ef(M_TB[k + 1]);
  }
  return { lon: elp + D2R * vel, lat: vb * D2R, r: (vr + 385000560.0) / AU_M };
}

// ------------------------------------------------------------------------------------- frames
/** Axes of the mean ecliptic and equinox of date, in the J2000 mean frame: [x (equinox), y, z (ecliptic pole)]. */
export function eclipticBasis(epj) {
  const k = eclipticPole(epj), n = equatorPole(epj), x = unit(cross(n, k));
  return [x, cross(k, x), k];
}
/** Ecliptic-of-date longitude (degrees, 0-360) of a J2000/ICRS vector. */
export function eclipticLongitude(v, basis) {
  const l = Math.atan2(dot(v, basis[1]), dot(v, basis[0])) / D2R;
  return ((l % 360) + 360) % 360;
}

// ------------------------------------------------------------------------------------- the sky's wanderers
export const PLANETS = [
  { id: 'mercury', name: 'Mercury', np: 1, rgb: [222, 214, 200] },
  { id: 'venus', name: 'Venus', np: 2, rgb: [255, 246, 222] },
  { id: 'mars', name: 'Mars', np: 4, rgb: [255, 150, 105] },
  { id: 'jupiter', name: 'Jupiter', np: 5, rgb: [255, 232, 196] },
  { id: 'saturn', name: 'Saturn', np: 6, rgb: [240, 216, 160] },
  { id: 'uranus', name: 'Uranus', np: 7, rgb: [190, 232, 236] },
];
/**
 * Visual magnitude from heliocentric distance r, geocentric distance d (au) and phase angle i (degrees):
 * Astronomical Almanac 1984 formulas, as in Meeus (1998) ch. 41. Saturn's rings are ignored (up to 0.5 mag).
 */
export function planetMag(np, r, d, i) {
  const k = 5 * Math.log10(r * d);
  switch (np) {
    case 1: return -0.42 + k + 0.0380 * i - 0.000273 * i * i + 0.000002 * i ** 3;
    case 2: return -4.40 + k + 0.0009 * i + 0.000239 * i * i - 0.00000065 * i ** 3;
    case 4: return -1.52 + k + 0.016 * i;
    case 5: return -9.40 + k + 0.005 * i;
    case 6: return -8.88 + k;
    case 7: return -7.19 + k;
    default: return -6.87 + k;
  }
}
const angle = (a, b) => Math.atan2(norm(cross(a, b)), dot(a, b)) / D2R;

/**
 * Geocentric Sun, Moon and planets at TT Julian Day jd, as ICRS vectors in au (light-time corrected planets).
 * Returns { epj, sun: { p, v, lon (ecliptic of date, deg) }, moon: { p }, planets: [{ ...PLANETS[i], p, v, mag }] }.
 * The Moon is geocentric here; use moonTopocentric() for a place on the Earth.
 */
export function solarSystem(jd) {
  const epj = jyear(jd), emb = plan94(jd, 3), sunP = [-emb[0], -emb[1], -emb[2]];
  const basis = eclipticBasis(epj);
  const planets = PLANETS.map((pl) => {
    let h = plan94(jd, pl.np), g = sub(h, emb);
    h = plan94(jd - norm(g) * LIGHT_DAY_PER_AU, pl.np); g = sub(h, emb);
    const i = angle([-h[0], -h[1], -h[2]], [-g[0], -g[1], -g[2]]);
    return { ...pl, p: g, v: unit(g), mag: planetMag(pl.np, norm(h), norm(g), i) };
  });
  const moonP = moonGeocentric(jd, basis);
  return { epj, sun: { p: sunP, v: unit(sunP), lon: eclipticLongitude(sunP, basis) }, moon: { p: moonP, v: unit(moonP), r: norm(moonP) }, planets };
}

/** Geocentric Moon at TT Julian Day jd as an ICRS vector in au (basis: eclipticBasis of the date, optional). */
export function moonGeocentric(jd, basis = eclipticBasis(jyear(jd))) {
  const m = moonEcliptic(jd), cb = Math.cos(m.lat), lx = cb * Math.cos(m.lon), ly = cb * Math.sin(m.lon), lz = Math.sin(m.lat);
  return [0, 1, 2].map((j) => m.r * (lx * basis[0][j] + ly * basis[1][j] + lz * basis[2][j]));
}

const EARTH_R_AU = 6378.137 / AU_KM;
/**
 * The Moon seen from a place: zenith is the ICRS unit vector of the observer's zenith. Returns the topocentric
 * ICRS unit vector, distance (au), illuminated fraction k, phase angle (degrees) and apparent radius (degrees).
 */
export function moonTopocentric(moonP, sunP, zenith) {
  const p = sub(moonP, zenith.map((z) => z * EARTH_R_AU)), r = norm(p);
  const i = angle(sub(sunP, p), [-p[0], -p[1], -p[2]]);   // Sun-Moon-observer angle
  return { v: unit(p), r, phase: i, k: (1 + Math.cos(i * D2R)) / 2, radius: Math.asin(1737.4 / (r * AU_KM)) / D2R };
}
