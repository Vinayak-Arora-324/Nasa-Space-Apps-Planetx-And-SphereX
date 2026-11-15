// Rewind astronomy checked against ERFA (pyerfa 2.0.1.5) and astropy 8.0.2 AltAz. Reference values were
// generated once with those libraries and are embedded here, so the test runs offline with plain node.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/blink/skytime.js';

const AS = 180 / Math.PI * 3600;
// erfa.ltpb(epj)
const LTPB = {
  '-12000': [[-0.9790679682422366, -0.1905058643815909, -0.07164795320352112], [0.1787490258906603, -0.6364584182945782, -0.7503129130736752], [0.09733806709181242, -0.7474143411911448, 0.657188788155009]],
  '26': [[0.887363964320557, 0.42217304437010156, 0.18535132972978055], [-0.422199527294982, 0.9055607278667914, -0.04131981724627995], [-0.18529099810085362, -0.04158952695875564, 0.9818032171826204]],
  '13700': [[-0.9725464302117574, -0.2197168282467126, -0.07666783202611202], [0.20951306622424018, -0.6833326379339355, -0.6994003009833253], [0.10128038390377311, -0.6962621785789169, 0.7106062640568667]],
};
// erfa.era00(jd, 0)
const ERA = { 2451545.0: 4.894961212823756, 1730000.25: 3.614378144960064, 2461000.7: 2.305837044806303 };
// erfa.pmsafe from XHIP (epoch J1991.25): [ra deg, dec deg, parallax mas]
const XHIP = {
  barnard: [269.45402263, 4.66828781, -798.80, 10277.30, 548.31, -110.51],
  arcturus: [213.91811408, 19.18727046, -1093.39, -2000.06, 88.83, -5.24],
  alphacen: [219.92041034, -60.83514707, -3678.19, 481.84, 742.12, -21.40],
};
const PMSAFE = {
  'barnard@26': [269.841267641, -0.320268091, 486.90350958], 'barnard@13700': [258.108235858, 69.106233588, 848.555691413],
  'barnard@-5000': [270.51865332, -8.989912978, 371.643284802], 'arcturus@26': [214.553700481, 20.276810434, 88.725699129],
  'arcturus@13700': [210.281246827, 12.649253664, 88.583509015], 'arcturus@-5000': [216.211656777, 23.036115609, 88.272632147],
  'alphacen@26': [223.93876507, -61.030326598, 718.741201611], 'alphacen@13700': [193.406852601, -56.015304356, 886.915156526],
  'alphacen@-5000': [233.19592883, -61.022425711, 662.229866113],
};
// astropy AltAz (pressure 0, UT1 = given UT) at Giza (29.9792 N, 31.1342 E): [az, alt] degrees.
// JDs are 20 March, 22:00 local mean solar time, in 2026 (Gregorian) and 26 CE (Julian calendar).
const GIZA = { lat: 29.9792, lon: 31.1342 };
const JD = { 2026: 2461120.3301827777, '26ce': 1730633.3301827777 };
const STARS = { polaris: [37.946143, 89.26413778], sirius: [101.28854105, -16.71314306], vega: [279.23410825, 38.78299326], thuban: [211.09760812, 64.3758087] };
const ALTAZ = {
  2026: { polaris: [359.299876, 29.845272], sirius: [230.401712, 25.094184], vega: [36.32945, -7.504903], thuban: [29.590534, 38.413086] },
  '26ce': { polaris: [355.209418, 19.205432], sirius: [243.468223, 10.767755], vega: [44.192975, 0.308896], thuban: [15.769765, 38.636857] },
};

test('long-term precession matrix matches ERFA eraLtpb to 1e-9 arcsec', () => {
  for (const [e, m] of Object.entries(LTPB)) {
    const r = T.ltpb(+e);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(r[i][j] - m[i][j]) * AS < 1e-9, `${e} [${i}][${j}]`);
  }
});

test('Earth rotation angle matches ERFA eraEra00', () => {
  for (const [jd, v] of Object.entries(ERA)) assert.ok(Math.abs(T.earthRotationAngle(+jd) - v) * AS < 1e-6, jd);
});

test('space motion matches ERFA eraPmsafe to 1 mas, including distance', () => {
  for (const [k, [ra, dec, plx]] of Object.entries(PMSAFE)) {
    const [name, ep] = k.split('@'), st = T.makeStar(...XHIP[name], 1991.25), p = T.starAt(st, +ep);
    const sep = T.angleBetween(p.v, T.vecFromRaDec(ra, dec)) * 3600;
    assert.ok(sep < 1e-3, `${k}: ${sep}"`);
    assert.ok(Math.abs(XHIP[name][4] * 10 ** (-p.dmag / 5) - plx) < 0.01, `${k} parallax`);
  }
  // Barnard's Star 2,000 years back: about 5.0 deg in 3-D, not the 5.8 deg a straight line on the sky gives.
  const b = T.makeStar(...XHIP.barnard, 1991.25), moved = T.angleBetween(T.vecFromRaDec(XHIP.barnard[0], XHIP.barnard[1]), T.starAt(b, 26).v);
  assert.ok(Math.abs(moved - 5.004) < 0.01, `${moved}`);
});

test('a star without parallax keeps a constant proper motion', () => {
  const st = T.makeStar(10, 20, 3600, 0, 0, 0, 2000), p = T.starAt(st, 3000);
  assert.ok(Math.abs(T.angleBetween(T.vecFromRaDec(10, 20), p.v) - 1) < 1e-3);   // tangent-plane step: atan(mu t)
  assert.equal(p.dmag, 0);
});

test('horizon positions agree with astropy AltAz within nutation + aberration (< 40")', () => {
  for (const [label, jd] of Object.entries(JD)) {
    const s = T.skyState(jd, GIZA.lon), M = T.horizonMatrix(s.prec, s.theta, GIZA.lat);
    for (const [k, [ra, dec]] of Object.entries(STARS)) {
      const h = T.altAzFromVec(T.mxv(M, T.vecFromRaDec(ra, dec))), [az, alt] = ALTAZ[label][k];
      const sep = T.angleBetween(T.vecFromAltAz(h.az, h.alt), T.vecFromAltAz(az, alt)) * 3600;
      assert.ok(sep < 40, `${label} ${k}: ${sep.toFixed(1)}"`);
    }
  }
});

test('CIO locator follows the long-term pole (IAU 2006 s06 gives -280.04" at 26 CE)', () => {
  assert.ok(Math.abs(T.cioLocator(2000) * AS) < 1e-3);
  assert.ok(Math.abs(T.cioLocator(26) * AS + 278.13) < 0.05);
});

test('calendar: Julian before 1582 October 15, Gregorian after, astronomical years', () => {
  assert.equal(T.jdFromCalendar(2000, 1, 1.5), 2451545);
  assert.equal(T.jdFromCalendar(1582, 10, 4), 2299159.5);
  assert.equal(T.jdFromCalendar(1582, 10, 15), 2299160.5);
  assert.equal(T.jdFromCalendar(333, 1, 27.5), 1842713);
  assert.equal(T.jdFromCalendar(-1000, 7, 12.5), 1356001);
  assert.equal(T.jdFromCalendar(-4712, 1, 1.5), 0);
  for (const jd of [0, 1356001, 1721423.5, 2299159.5, 2299160.5, 2451545, 2461120.25]) {
    const c = T.calendarFromJd(jd);
    assert.equal(T.jdFromCalendar(c.year, c.month, c.day + c.dayFrac), jd);
  }
  assert.equal(T.fmtYear(26), '26 CE');
  assert.equal(T.fmtYear(0), '1 BCE');
  assert.equal(T.fmtYear(-2559), '2560 BCE');
  assert.equal(T.daysInMonth(1900, 2), 28);   // Gregorian: not a leap year
  assert.equal(T.daysInMonth(1500, 2), 29);   // Julian: every fourth year
});

test('the pole drifts along the precession circle: Thuban in 2800 BCE, Vega in 13,600 CE, Polaris now', () => {
  const near = (epj, s) => T.angleBetween(T.poleOfDate(epj), T.starAt(T.makeStar(...s, 1991.25), epj).v);
  const thuban = [211.09760812, 64.3758087, -56.34, 17.21, 10.76, -14], vega = [279.23410825, 38.78299326, 200.94, 286.23, 130.23, -20.6];
  assert.ok(near(-2799, thuban) < 0.2);
  assert.ok(near(-2559, thuban) < 1.5);                 // the Great Pyramid's time
  assert.ok(Math.abs(near(13590, vega) - 5.67) < 0.05); // Vega's own motion keeps it 5.7 deg away
  assert.ok(near(2026, [37.946143, 89.26413778, 44.48, -11.85, 7.54, -16.42]) < 0.7);
});
