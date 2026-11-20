// Sun, Moon and planets for the rewind. The ports are checked against ERFA (pyerfa 2.0.1.5: eraPlan94, and
// eraMoon98 with its IAU 2006 precession undone), then the whole chain against Meeus (1998) worked examples,
// JPL DE441 (Horizons) and historical events. Reference values are embedded so the test runs offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/blink/ephem.js';
import * as T from '../js/blink/skytime.js';
import { jdFromLocal } from '../js/blink/rewind.js';

const D2R = Math.PI / 180;
const sep = (a, b) => T.angleBetween(a.map((x) => x / Math.hypot(...a)), b.map((x) => x / Math.hypot(...b)));
const PLAN94 = {"2451545.0": {"1": [-0.130091772797162, -0.400593024687803, -0.200488646056916], "3": [-0.17716063335054, 0.887401475865844, 0.384735625722873], "5": [4.00156008330459, 2.7361034508087, 1.07543999535354], "6": [6.40460226671083, 6.1752654462968, 2.2744521426213]}, "2448724.5": {"1": [-0.239844942578597, -0.356392142770859, -0.16548546121362], "3": [-0.926546286076254, -0.351208419847975, -0.152276379716803], "5": [-5.17530229668702, 1.40107259652792, 0.726571537155007], "6": [6.58375936189595, -6.75118522475154, -3.07148805154977]}, "625295.0": {"1": [-0.3043433486323, -0.316826011868671, -0.130676939117215], "3": [-0.677161603452274, 0.655052789979186, 0.294231295720825], "5": [-4.78975941173099, -2.32299041341558, -0.867299073896572], "6": [-8.3694172284781, 3.93543742027348, 1.88526375826219]}, "-1894930.0": {"1": [-0.217696588720043, -0.377305596106133, -0.163704769083808], "3": [-1.00533906531936, 0.040184057532759, 0.032072754493553], "5": [3.75046052758284, -3.14454763683725, -1.50138124313141], "6": [3.23124531106582, 7.63939270338432, 3.07221553869765]}, "5926000.25": {"1": [0.330646537449252, -0.229928204079524, -0.150506070904475], "3": [-0.553378671157512, -0.774378426061191, -0.313781111650096], "5": [4.9124412918177, 0.521551484345763, 0.110290512620387], "6": [8.72167049222417, 3.89019069137007, 1.31470166702619]}, "-3757000.5": {"1": [-0.381461040560279, 0.0849637895416635, 0.097939167417873], "3": [-1.01117070583907, -0.0596576120703486, 0.000958213871418], "5": [4.0935431694116, 2.97959232014944, 1.07245742193369], "6": [6.25981882135419, 5.62185295743064, 2.33651572881168]}};
const MOON98 = {"2451545.0": [-2.38553491161667, 0.0902558638983171, 0.00269017741030751], "2448724.5": [2.32413037185916, -0.05635888787955, 0.00246266663484086], "625295.0": [-1.14395888432946, -0.0786674680294507, 0.0025594332435288], "-1894930.0": [-1.63060573058903, -0.00515651921827386, 0.00251488762168362], "5926000.25": [2.94845161383472, 0.0668750260402592, 0.00264515356782961], "-3757000.5": [-1.10303697445038, 0.0645532488154438, 0.00267367375041876]};

test('plan94 port matches ERFA eraPlan94 to 1e-12 au, also far outside 1000-3000 CE', () => {
  for (const [jd, ps] of Object.entries(PLAN94)) {
    for (const [np, p] of Object.entries(ps)) {
      const q = E.plan94(+jd, +np);
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(q[i] - p[i]) < 1e-12, `planet ${np} at JD ${jd}: ${q[i]} vs ${p[i]}`);
    }
  }
});

test('moon98 series matches ERFA eraMoon98 in the ecliptic of date to 1e-12', () => {
  for (const [jd, [l, b, r]] of Object.entries(MOON98)) {
    const m = E.moonEcliptic(+jd);
    assert.ok(Math.abs(Math.atan2(Math.sin(m.lon - l), Math.cos(m.lon - l))) < 1e-12, `lon at ${jd}`);
    assert.ok(Math.abs(m.lat - b) < 1e-12, `lat at ${jd}`);
    assert.ok(Math.abs(m.r / r - 1) < 1e-12, `r at ${jd}`);
  }
});

test('Meeus 47.a: the Moon on 1992 April 12, 0h TD', () => {
  const m = E.moonEcliptic(2448724.5);
  assert.ok(Math.abs(((m.lon / D2R) % 360 + 360) % 360 - 133.162655) < 0.002);   // Meeus: 133.162655 (mean equinox; no nutation)
  assert.ok(Math.abs(m.lat / D2R - -3.229126) < 0.0005);
  assert.ok(Math.abs(m.r * 149597870.7 - 368409.7) < 2);
});

test('Meeus 25.a: the Sun on 1992 October 13, 0h TD, ecliptic longitude of date', () => {
  const s = E.solarSystem(2448908.5);
  // Meeus 25.a true longitude 199.90988 (FK5 equinox); plan94 + Vondrak should agree within 0.005 deg
  assert.ok(Math.abs(s.sun.lon - 199.90988) < 0.005, String(s.sun.lon));
  assert.ok(Math.abs(Math.hypot(...s.sun.p) - 0.99760775) < 2e-4);
});

test('Meeus 33.a: Venus on 1992 December 20, 0h TD', () => {
  const s = E.solarSystem(2448976.5), v = s.planets.find((p) => p.id === 'venus');
  assert.ok(Math.abs(Math.hypot(...v.p) - 0.910947) < 2e-4);
  const d = T.raDecFromVec(T.mxv(T.ltpb(T.jyear(2448976.5)), v.v));
  // apparent place 316.17291, -18.88802 includes nutation and aberration (~0.01 deg), not modelled here
  assert.ok(Math.abs(d.ra - 316.17291) < 0.03 && Math.abs(d.dec - -18.88802) < 0.03, `${d.ra} ${d.dec}`);
});

// JPL DE441 via Horizons: heliocentric ecliptic J2000 (au) and the geocentric Moon at 3002 BCE.
const EPS = 84381.448 / 3600 * D2R;
const ecl2eq = (v) => [v[0], Math.cos(EPS) * v[1] - Math.sin(EPS) * v[2], Math.sin(EPS) * v[1] + Math.cos(EPS) * v[2]];
test('agrees with JPL DE441: Jupiter in 2000 and 3002 BCE, the Moon in 3002 BCE', () => {
  const jupNow = ecl2eq([4.0011771611, 2.9385761070, -0.1017852766]);
  assert.ok(sep(E.plan94(2451545.0, 5), jupNow) < 0.02);
  const jupOld = ecl2eq([-4.7897689896, -2.4828829943, 0.1273551336]);
  assert.ok(sep(E.plan94(625295.0, 5), jupOld) < 0.1);
  const emb = ecl2eq([-0.1771587842, 0.9672193525, -0.0000011393]);
  assert.ok(sep(E.plan94(2451545.0, 3), emb) < 0.002);
  const moonOld = ecl2eq([2.5467293e-3, 1.548173e-4, -2.031960e-4]);
  assert.ok(sep(E.solarSystem(625295.0).moon.p, moonOld) < 0.3);
});

/** Smallest separation (degrees) of two bodies over UT JD jd0 +- span days, and when (UT JD). */
function closest(f, jd0, span, n = 1441) {
  let best = [Infinity, 0];
  for (let i = 0; i < n; i++) {
    const jd = jd0 - span + 2 * span * i / (n - 1), y = T.jyear(jd), s = E.solarSystem(jd + T.deltaT(y) / 86400);
    const d = f(s); if (d < best[0]) best = [d, jd];
  }
  return best;
}
const body = (s, id) => (id === 'sun' ? s.sun.p : id === 'moon' ? s.moon.p : s.planets.find((p) => p.id === id).p);
const pair = (a, b) => (s) => sep(body(s, a), body(s, b));

test('historical events: the 2020 great conjunction, eclipses of 2017, 763 BCE and 585 BCE', () => {
  let [d, jd] = closest(pair('jupiter', 'saturn'), T.jdFromCalendar(2020, 12, 21.75), 2);
  assert.ok(Math.abs(d - 0.102) < 0.01, `2020 Jupiter-Saturn ${d}`);
  [d, jd] = closest(pair('sun', 'moon'), T.jdFromCalendar(2017, 8, 21.77), 0.25);
  assert.ok(d < 0.5 && Math.abs((jd - T.jdFromCalendar(2017, 8, 21)) * 24 - 18.43) < 0.2, `2017 eclipse ${d} ${jd}`);
  [d, jd] = closest(pair('sun', 'moon'), T.jdFromCalendar(-762, 6, 15.35), 0.5);   // Bur-Sagale, Assyria
  assert.ok(d < 0.5, `763 BCE eclipse ${d}`);
  [d, jd] = closest(pair('sun', 'moon'), T.jdFromCalendar(-584, 5, 28.6), 0.5);    // Thales, Herodotus
  assert.ok(d < 0.5 && Math.abs(jd - 1507900.097) < 0.05, `585 BCE eclipse ${d} ${jd}`);
});

test('the 7 BCE triple conjunction of Jupiter and Saturn has three close approaches', () => {
  for (const jd0 of [1719014, 1719140, 1719204]) {
    const [d] = closest(pair('jupiter', 'saturn'), jd0, 20, 161);
    assert.ok(d < 1.3, `near JD ${jd0}: ${d}`);
  }
});

test('the Moon seen from Earth: phase and the 1-degree parallax', () => {
  // Meeus 48.a: 1992 April 12, 0h TD, illuminated fraction 0.6786 (geocentric)
  const s = E.solarSystem(2448724.5), mt = E.moonTopocentric(s.moon.p, s.sun.p, [0, 0, 0]);
  assert.ok(Math.abs(mt.k - 0.6786) < 0.002, String(mt.k));
  // the Moon on the horizon sits about 0.95 deg lower than from the Earth's centre
  const top = E.moonTopocentric([0, 0, 0.00257], [1, 0, 0], [1, 0, 0]);
  assert.ok(Math.abs(T.angleBetween(top.v, [0, 0, 1]) - 0.95) < 0.02);
});

test('local mean solar time: clock noon is the mean Sun\'s noon in every era', () => {
  for (const y of [-14999, -6000, 2026, 15000]) {
    let sum = 0, n = 0;
    for (let day = 0; day < 365; day += 5) {
      const jd = jdFromLocal({ year: y, month: 1, day: 1, hour: 12, minute: 0 }, 0) + day;
      const s = T.skyState(jd, 0), v = T.mxv(s.prec, E.solarSystem(s.jdTt).sun.v);
      const ha = ((((s.theta - Math.atan2(v[1], v[0])) / D2R + 180) % 360) + 360) % 360 - 180;
      sum += ha; n++;
    }
    assert.ok(Math.abs(sum / n * 4) < 6, `${y}: mean Sun hour angle at noon ${(sum / n * 4).toFixed(1)} min`);
  }
});

test('Delta T uncertainty grows to hours in the deep past', () => {
  assert.equal(T.deltaTSigma(2000), 1);
  assert.ok(T.deltaTSigma(-2999) / 3600 > 0.3 && T.deltaTSigma(-2999) / 3600 < 1);
  assert.ok(T.deltaTSigma(-9999) / 3600 > 2 && T.deltaTSigma(-9999) / 3600 < 4);
});

// ------------------------------------------------------------------------------------- Phase 5: heliocentric positions, plan94 elements (section 20.4.1)
import { readFileSync } from 'node:fs';
const ERFA5 = JSON.parse(readFileSync(new URL('./fixtures/phase5-erfa.json', import.meta.url), 'utf8'));   // fixtures/make_phase5_fixtures.py
const KM = 149597870.7;
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const PLANET_NP = { mercury: 1, venus: 2, mars: 4, jupiter: 5, saturn: 6, uranus: 7, neptune: 8 };

test('heliocentric(jd): the planets equal ERFA plan94 to 1e-12 au at five dates in 1900-2100', () => {
  assert.equal(ERFA5.dates.length, 5);
  for (const d of ERFA5.dates) {
    const h = E.heliocentric(d.jd);
    for (const [name, np] of Object.entries(PLANET_NP)) {
      const ref = d.plan94[name];
      assert.ok(np > 0 && ref, name);
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(h.planets[name][i] - ref[i]) < 1e-12, `${name} at ${d.jd}`);
    }
    assert.deepEqual(Object.keys(h.planets), ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);
  }
});

test('heliocentric(jd): Earth is within 7,000 km of ERFA epv00 (measured maximum 6,496 km over 1900-2100, section 20.2)', () => {
  let worst = 0;
  for (const d of ERFA5.dates) {
    const km = Math.hypot(...vsub(E.heliocentric(d.jd).earth, d.epv00_earth_helio)) * KM;
    worst = Math.max(worst, km);
    assert.ok(km < 7000, `Earth ${km} km at ${d.jd}`);
  }
  for (const [jd, x, y, z] of ERFA5.epv00_earth_scan.rows) {
    const km = Math.hypot(...vsub(E.heliocentric(jd).earth, [x, y, z])) * KM;
    worst = Math.max(worst, km);
    assert.ok(km < 7000, `Earth ${km} km at ${jd}`);
  }
  console.log(`# heliocentric Earth vs epv00 at the 5 fixture dates and 600 dates over 1900-2100: max ${worst.toFixed(0)} km`);
});

test('heliocentric(jd): Earth = plan94(EMB) - moon / (1 + EMRAT), and Moon - Earth is the ephem.js geocentric Moon (equal to ERFA moon98 within its precession model)', () => {
  assert.equal(E.EMRAT, 81.30056822149722);
  let worst = 0;
  for (const d of ERFA5.dates) {
    const h = E.heliocentric(d.jd), emb = E.plan94(d.jd, 3), m = E.moonGeocentric(d.jd);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(h.earth[i] - (emb[i] - m[i] / (1 + E.EMRAT))) < 1e-15);
      assert.ok(Math.abs(h.moon[i] - h.earth[i] - m[i]) < 1e-15);
    }
    // moon98 in ERFA uses the IAU 2006 precession, ephem.js the Vondrak poles: they differ by arc seconds over a century at most (Moon distance 0.00257 au)
    const dm = Math.hypot(...vsub(vsub(h.moon, h.earth), d.moon98_gcrs));
    worst = Math.max(worst, dm);
    assert.ok(dm < 2e-8, `Moon - Earth vs moon98 at ${d.jd}: ${dm} au`);
  }
  console.log(`# heliocentric Moon - Earth vs moon98: max ${(worst * KM).toFixed(2)} km`);
});

test('bodyHeliocentric writes into the given array and agrees with heliocentric', () => {
  const out = [0, 0, 0], jd = 2461360, h = E.heliocentric(jd);
  for (const [body, ref] of [['mercury', h.planets.mercury], ['neptune', h.planets.neptune], ['earth', h.earth], ['moon', h.moon]]) {
    assert.equal(E.bodyHeliocentric(jd, body, out), out);
    assert.deepEqual(out, ref);
  }
  assert.throws(() => E.bodyHeliocentric(jd, 'pluto', out));
});

test('plan94 is unchanged by the refactor: the 1e-12 ERFA comparison above plus bit-stable values at J2000', () => {
  // values printed by the pre-refactor implementation (git 9863662) at JD 2451545.0
  const ref = { 1: [-0.130091772797162, -0.400593024687803, -0.200488646056916], 5: [4.00156008330459, 2.7361034508087, 1.07543999535354] };
  for (const [np, p] of Object.entries(ref)) { const q = E.plan94(2451545.0, +np); for (let i = 0; i < 3; i++) assert.ok(Math.abs(q[i] - p[i]) < 1e-14); }
});

test('planetElements / planetOrbitPath reproduce plan94: the planet at its eccentric anomaly lands on plan94(jd, np) to 1e-9 au', () => {
  // each coordinate of the ellipse is C + A cos E + B sin E, so the four samples of an n = 4 path (E = 0, 90, 180, 270 deg) give it exactly at any E
  let worst = 0;
  for (const jd of [2415020.5, 2433812.5, 2451545.0, 2461360.0, 2488069.5]) for (const np of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const el = E.planetElements(jd, np);
    assert.ok(el.a > 0.3 && el.e >= 0 && el.e < 0.3 && Math.abs(el.i) < 0.15);
    const am = el.L - el.peri; let ae = am + el.e * Math.sin(am);          // Kepler's equation on the element set, as plan94 solves it
    for (let k = 0; k < 50; k++) ae -= (ae - el.e * Math.sin(ae) - am) / (1 - el.e * Math.cos(ae));
    const p = E.planetOrbitPath(jd, np, 4), want = E.plan94(jd, np);
    for (let c = 0; c < 3; c++) {
      const got = (p[c] + p[6 + c]) / 2 + (p[c] - p[6 + c]) / 2 * Math.cos(ae) + (p[3 + c] - p[9 + c]) / 2 * Math.sin(ae);
      worst = Math.max(worst, Math.abs(got - want[c]));
      assert.ok(Math.abs(got - want[c]) < 1e-9, `np ${np} jd ${jd} axis ${c}: ${got} vs ${want[c]}`);
    }
  }
  console.log(`# planetOrbitPath vs plan94 at the true anomaly: max ${worst.toExponential(2)} au`);
});

test('planetOrbitPath: closed (the last point repeats the first), n + 1 points, the right size and a reusable output', () => {
  const p = E.planetOrbitPath(2461360, 5), el = E.planetElements(2461360, 5);
  assert.equal(p.length, 3 * 129); assert.ok(p instanceof Float64Array);
  assert.deepEqual([...p.slice(0, 3)], [...p.slice(3 * 128)]);
  for (let k = 0; k <= 128; k++) { const r = Math.hypot(p[3 * k], p[3 * k + 1], p[3 * k + 2]); assert.ok(r > el.a * (1 - el.e) - 1e-9 && r < el.a * (1 + el.e) + 1e-9); }
  const out = new Float64Array(3 * 33);
  assert.equal(E.planetOrbitPath(2461360, 5, 32, out), out);
  assert.deepEqual(E.PLANET_IDS, { 'ss:mercury': 1, 'ss:venus': 2, 'ss:mars': 4, 'ss:jupiter': 5, 'ss:saturn': 6, 'ss:uranus': 7, 'ss:neptune': 8 });
  assert.equal(E.EARTH_ORBIT_NP, 3);
});
