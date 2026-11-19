import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectStore, visibleObjects } from '../js/blink/scene3d-objects.js';
import { galaxyItem, milkyWayItem, galaxyFade, galaxyBase, galacticAxes } from '../js/blink/scene3d-galaxy.js';
import { projectAxes } from '../js/blink/scene3d-nebula.js';
import { galaxyLook, defaultLayers } from '../js/blink/scene3d-registry.js';
import { hashUnit } from '../js/blink/scene3d-orbits.js';
import * as F from '../js/blink/scene3d-frames.js';
import * as M from '../js/blink/scene3d-math.js';

const D2R = Math.PI / 180;
const catQ = (v, unit, tier = 'catalogue') => ({ v, unit, src: 't', tier });
const dotv = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossv = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const pinhole = (fwd, up, f = 1000) => {
  const R = crossv(fwd, up);
  return (rel) => { const z = dotv(rel, fwd); return z <= 1e-12 ? null : [f * dotv(rel, R) / z, -f * dotv(rel, up) / z]; };
};
const skyNE = (ra, dec) => {
  const a = ra * D2R, d = dec * D2R;
  return { N: [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)], E: [-Math.sin(a), Math.cos(a), 0], u: M.radecToXyz(ra, dec, 1) };
};
const modPi = (x) => ((x % Math.PI) + Math.PI) % Math.PI;
const angDiffPi = (a, b) => { const d = modPi(a - b); return Math.min(d, Math.PI - d); };
const gal = (id, o = {}, ang = {}, pr = {}, pos = {}) => ({
  id, kind: 'galaxy', name: id, designations: [], host: null, parent: null,
  position: { model: 'fixed', ra: 10.68, dec: 41.27, epoch: 2000, method: 'cepheid', tier: 'catalogue', dist: { v: 0.7575, lo: 0.735, hi: 0.781, unit: 'Mpc', src: 'Cosmicflows-4', tier: 'measured' }, ...pos },
  in_cone: true, size: { radius: null, angular: { major: catQ(178, 'arcmin'), minor: catQ(70, 'arcmin'), pa: catQ(35, 'deg'), ...ang } },
  props: { type: { v: 'Galaxy', src: 't', tier: 'catalogue' }, hubble: { v: 'Sb', src: 't', tier: 'catalogue' }, mag_b: catQ(4.29, 'mag'), surface_brightness: catQ(23.63, 'mag/arcsec2'), ...pr },
  provenance: { source: 'static:galaxies', dataset: 'galaxies' }, evidence: 'measured', render: { mag: 4.29 }, ...o,
});
const dirGal = (id, o = {}, ang = {}, pr = {}) => gal(id, { evidence: 'measured', ...o }, ang, pr, { dist: null, method: undefined });
const entryOf = (o, frame = 'galaxy') => {
  const s = new ObjectStore(); assert.ok(s.ingest({ schema: 'space-maps.objects/1', query: {}, objects: [o], kinds: {}, sources: [] }).ok);
  const vis = visibleObjects(s, { layers: defaultLayers(), evidence: false, frame, inHost: () => false });
  assert.equal(vis.length, 1); return vis[0];
};
const sun = F.makeCam({ pos: [0, 0, 0] });
const view = (o) => { const { N, u } = skyNE(o.position.ra, o.position.dec); return pinhole(u, N); };

test('from the Sun the screen ellipse is the catalogue major, minor and PA to 1e-6: discs, an elliptical, several PAs, near the pole', () => {
  const f = 1000;
  for (const [ra, dec] of [[83.82, -5.39], [10, 60], [200, 89.5], [350, -89.2]]) {
    for (const pa of [0, 30, 90, 137, 179]) {
      for (const hub of ['Sb', 'E', 'Sc']) {
        for (const placed of [true, false]) {
          const mk = placed ? gal : dirGal;
          const o = mk('ongc:T', { position: { ...gal('x').position, ra, dec, ...(placed ? {} : { dist: null }) } }, { major: catQ(90, 'arcmin'), minor: catQ(40, 'arcmin'), pa: catQ(pa, 'deg') }, { hubble: catQ(hub, '') });
          o.position.ra = ra; o.position.dec = dec;
          const { N, u } = skyNE(ra, dec), it = galaxyItem(entryOf(o), sun, { project: pinhole(u, N, f) });
          assert.ok(Math.abs(it.semiMajorPx / (f * Math.tan(45 * D2R / 60)) - 1) < 1e-6, `major ${ra} ${dec} ${pa} ${hub}`);
          assert.ok(Math.abs(it.semiMinorPx / (f * Math.tan(20 * D2R / 60)) - 1) < 1e-6, `minor ${ra} ${dec} ${pa} ${hub} ${placed}`);
          assert.ok(angDiffPi(it.angle, Math.atan2(-Math.cos(pa * D2R), -Math.sin(pa * D2R))) < 1e-6, `PA ${ra} ${dec} ${pa}`);
          assert.equal(it.inside, false); assert.equal(it.atInfinity, !placed); assert.equal(it.billboard, 'galaxy');
        }
      }
    }
  }
});

test('a nearly edge-on disc keeps the catalogue ellipse too (the thickness shrinks with the minor axis)', () => {
  const o = gal('ongc:E', {}, { major: catQ(30, 'arcmin'), minor: catQ(1.5, 'arcmin'), pa: catQ(60, 'deg') }), { N, u } = skyNE(10.68, 41.27);
  const it = galaxyItem(entryOf(o), sun, { project: pinhole(u, N) });
  assert.ok(Math.abs(it.semiMinorPx / (1000 * Math.tan(0.75 * D2R / 60)) - 1) < 1e-6);
});

test('seen from the side a disc galaxy shows its tilt and thickness: the minor axis opens up beyond the catalogue one', () => {
  const o = gal('ongc:S', {}, { major: catQ(60, 'arcmin'), minor: catQ(15, 'arcmin'), pa: catQ(0, 'deg') }), e = entryOf(o), { N, u } = skyNE(10.68, 41.27);
  const D = Math.hypot(...e.galPc), r = D * Math.tan(30 * D2R / 60);
  const cam = F.makeCam({ pos: e.galPc.map((v, i) => v + 5 * r * N[i]) });   // along the major axis: A points at the camera
  const it = galaxyItem(e, cam, { project: pinhole(N.map((v) => -v), u, 1000) });
  assert.equal(it.inside, false);
  const cosI = Math.tan(7.5 * D2R / 60) / Math.tan(30 * D2R / 60), sinI = Math.sqrt(1 - cosI * cosI);
  assert.ok(it.semiMajorPx > 1000 * r * sinI / (5 * r) * 0.9, 'the tilted second axis points toward or away from the camera and is seen');
  assert.ok(it.semiMajorPx / it.semiMinorPx < 20); assert.ok(it.tilt === 1 || it.tilt === -1); assert.equal(it.tilt, hashUnit('ongc:S', 'tilt') < 0.5 ? -1 : 1);
  assert.ok(it.affine.a && it.affine.b && it.affine.c);
});

test('unknown minor is a circle, unknown PA hashes the glow angle and dashes the outline circle, no major is a marker', () => {
  const { N, u } = skyNE(10.68, 41.27), proj = pinhole(u, N);
  const a = galaxyItem(entryOf(gal('ongc:M', {}, { minor: null })), sun, { project: proj });
  assert.equal(a.minorUnknown, true); assert.ok(Math.abs(a.semiMajorPx - a.semiMinorPx) < 1e-6 * a.semiMajorPx);
  const noPa = entryOf(gal('ongc:P', {}, { pa: null })), g = galaxyItem(noPa, sun, { project: proj }), ev = galaxyItem(noPa, sun, { project: proj, evidence: true });
  assert.equal(g.paUnknown, true); assert.equal(g.dashed, false); assert.equal(ev.mode, 'outline'); assert.equal(ev.dashed, true);
  assert.ok(Math.abs(ev.semiMinorPx - ev.semiMajorPx) < 1e-6 * ev.semiMajorPx, 'a circle of the major radius');
  const pa = 180 * hashUnit('ongc:P', 'pa');
  assert.ok(angDiffPi(g.angle, Math.atan2(-Math.cos(pa * D2R), -Math.sin(pa * D2R))) < 1e-6);
  const none = galaxyItem(entryOf(gal('ongc:N', {}, { major: null, minor: null, pa: null })), sun, { project: proj });
  assert.equal(none.markerOnly, true); assert.equal(none.alpha, 0);
  assert.equal(galaxyItem(entryOf(gal('ongc:Q')), sun, {}), null, 'project is required');
});

test('markerOnly under 3 px: M87 from the Sun is a marker, M31 is not', () => {
  const m87 = gal('ongc:NGC4486', { position: { ...gal('x').position, ra: 187.7, dec: 12.39, method: 'sbf', dist: { v: 16.858, unit: 'Mpc', src: 'Cosmicflows-4', tier: 'measured' } } }, { major: catQ(8.3, 'arcmin'), minor: catQ(6.6, 'arcmin'), pa: catQ(0, 'deg') }, { hubble: catQ('E', '') });
  m87.position.ra = 187.7; m87.position.dec = 12.39;
  const { N, u } = skyNE(187.7, 12.39), f = 900 / (2 * Math.tan(30 * D2R));   // a 900 px tall view at a 60 degree field
  const it = galaxyItem(entryOf(m87), sun, { project: pinhole(u, N, f) });
  assert.ok(it.semiMajorPx < 3 && it.semiMajorPx > 0.5, `${it.semiMajorPx}`); assert.equal(it.markerOnly, true);
  const m31 = galaxyItem(entryOf(gal('ongc:NGC0224')), sun, { project: view(gal('ongc:NGC0224')) });
  assert.equal(m31.markerOnly, false);
});

test('brightness: SurfBr mapping and clamps, B magnitude fallback, none gives 0.1; fades by skyFade (direction-only) and by distance (placed)', () => {
  const pr = (o, ang = {}) => galaxyItem(entryOf(o), sun, { project: view(o) });
  assert.ok(Math.abs(pr(gal('a', {}, {}, { surface_brightness: catQ(22.5, 'mag/arcsec2') })).alpha - 0.35) < 1e-12);
  assert.ok(Math.abs(pr(gal('a', {}, {}, { surface_brightness: catQ(23.63, 'mag/arcsec2') })).alpha - 0.35 * Math.pow(10, -0.4 * 1.13)) < 1e-12);
  assert.equal(pr(gal('a', {}, {}, { surface_brightness: catQ(10, 'mag/arcsec2') })).alpha, 0.6);
  assert.equal(pr(gal('a', {}, {}, { surface_brightness: catQ(40, 'mag/arcsec2') })).alpha, 0.04);
  const fb = gal('b', { render: {} }, { major: catQ(10, 'arcmin'), minor: catQ(10, 'arcmin') }, { surface_brightness: null, mag_b: catQ(12, 'mag') });
  delete fb.props.surface_brightness;
  assert.ok(Math.abs(galaxyBase(fb, 5, 5) - Math.min(Math.max(0.35 * Math.pow(10, -0.4 * (12 + 2.5 * Math.log10(Math.PI * 25) + 8.89 - 22.5)), 0.04), 0.6)) < 1e-12);
  const none = gal('c', { render: {} }); delete none.props.surface_brightness; delete none.props.mag_b;
  assert.equal(galaxyBase(none, 90, 35), 0.1);
  const d = dirGal('d'), e = entryOf(d), proj = view(d);
  const near = galaxyItem(e, sun, { project: proj }), far = galaxyItem(e, F.makeCam({ pos: [1e5, 0, 0] }), { project: () => [0, 0] });
  assert.ok(Math.abs(far.alpha / near.alpha - 0.5) < 1e-12); assert.equal(far.skyFade, 0.5); assert.equal(far.markerAlpha, 0.5); assert.equal(far.lineAlpha, 0.5);
});

test('fade = smoothstep(1, 3, dist / radius): full at 3 radii, half at 2, gone inside', () => {
  const o = gal('ongc:F', {}, { major: catQ(60, 'arcmin'), minor: catQ(30, 'arcmin'), pa: catQ(0, 'deg') }), e = entryOf(o);
  const D = Math.hypot(...e.galPc), r = D * Math.tan(30 * D2R / 60), uu = e.galPc.map((v) => v / D), { N } = skyNE(10.68, 41.27);
  const at = (k) => galaxyItem(e, F.makeCam({ pos: uu.map((v) => v * (D - k * r)) }), { project: pinhole(uu, N) });
  assert.ok(Math.abs(at(2).fade - 0.5) < 1e-9); assert.equal(at(4).fade, 1); assert.equal(at(0.5).fade, 0);
  const i = at(0); assert.equal(i.inside, true); assert.equal(i.alpha, 0); assert.equal(i.semiMajorPx, null); assert.equal(i.affine, null);
});

test('looks by Hubble type and T-type; groups; bars only for SB', () => {
  const L = (h, ty = 'Galaxy') => galaxyLook(gal('x', {}, {}, { hubble: h == null ? null : catQ(h, ''), type: catQ(ty, '') }));
  assert.equal(L('E').look, 'elliptical'); assert.equal(L('E').bulge, 1);
  assert.equal(L('S0').look, 'lenticular'); assert.equal(L('SB0').look, 'lenticular'); assert.equal(L('SB0').bar, false); assert.equal(L('SA0').bulge, 0.6);
  assert.deepEqual([L('Sa').bulge, L('Sb').bulge, L('Sc').bulge, L('Sd').bulge], [0.45, 0.3, 0.15, 0.05]);
  assert.deepEqual([L('Sa').pitchDeg, L('Sd').pitchDeg], [10, 25]); assert.equal(L('Sa').arms, 2);
  assert.equal(L('SBb').look, 'barred_spiral'); assert.equal(L('SBb').bar, true); assert.equal(L('SABb').bar, false); assert.equal(L('SAc').look, 'spiral');
  assert.ok(Math.abs(L('Sab').bulge - 0.375) < 1e-12);
  for (const h of ['I', 'IB', 'Im', 'Sm', 'Irr', null, 'xyz']) assert.equal(L(h).look, 'irregular', String(h));
  assert.equal(L('T = 9').look, 'irregular'); assert.equal(L('T = 3').look, 'spiral'); assert.equal(L('T = -5').look, 'elliptical'); assert.equal(L('T = -2').look, 'lenticular');
  assert.deepEqual([L(null, 'Galaxy pair').blobs, L(null, 'Galaxy triplet').blobs, L(null, 'Group of galaxies').blobs], [2, 3, 3]); assert.equal(L('Sb', 'Galaxy pair').look, 'group');
  const { N, u } = skyNE(10.68, 41.27), it = galaxyItem(entryOf(gal('ongc:B', {}, {}, { hubble: catQ('SBb', '') })), sun, { project: pinhole(u, N) });
  assert.equal(it.look, 'barred_spiral'); assert.equal(it.hubble, 'SBb'); assert.equal(it.shape.barAzimuth, Math.PI * hashUnit('ongc:B', 'bar')); assert.equal(it.seed, hashUnit('ongc:B', 'look'));
});

test('Evidence view: outline, solid for a measured distance, dashed for a derived one', () => {
  const { N, u } = skyNE(10.68, 41.27), proj = pinhole(u, N);
  const m = galaxyItem(entryOf(gal('a')), sun, { project: proj, evidence: true }), d = galaxyItem(entryOf(gal('b', { evidence: 'derived' })), sun, { project: proj, evidence: true });
  assert.equal(m.mode, 'outline'); assert.equal(m.dashed, false); assert.equal(m.hollow, false); assert.equal(d.dashed, true); assert.equal(d.hollow, true);
  assert.equal(galaxyItem(entryOf(gal('b', { evidence: 'derived' })), sun, { project: proj }).dashed, false, 'glow view: no dashes');
});

test('projectAxes: ellipse from three axes, null C is flat, behind the camera is inside', () => {
  const proj = pinhole([0, 0, 1], [0, 1, 0], 1000);
  const r = projectAxes([0, 0, 100], [[10, 0, 0], [0, 5, 0], null], proj);
  assert.ok(Math.abs(r.semiMajorPx - 100) < 1e-9 && Math.abs(r.semiMinorPx - 50) < 1e-9); assert.ok(r.angle === 0 || Math.abs(r.angle) < 1e-12);
  assert.deepEqual(r.ax[2], [0, 0]); assert.equal(r.inside, false); assert.ok(Math.abs(r.screen[0]) + Math.abs(r.screen[1]) === 0);
  const b = projectAxes([0, 0, 5], [[10, 0, 0], [0, 5, 0], [0, 0, 10]], proj); assert.equal(b.inside, true); assert.equal(b.cov, null); assert.equal(b.ax, null);
});

// ---------------------------------------------------------------- the Milky Way
const mwRec = (o = {}) => ({
  id: 'gal:milky_way', kind: 'galaxy', name: 'Milky Way', designations: ['Galaxy'], host: null, parent: null,
  position: { model: 'fixed', ra: 266.4168371, dec: -29.0078106, epoch: 2000, method: 'orbit-fit', tier: 'measured', dist: { v: 8277, lo: 8268, hi: 8286, unit: 'pc', src: 'GRAVITY', tier: 'measured' } },
  in_cone: false, size: { radius: null, angular: null },
  props: { ngp_ra: catQ(192.85948, 'deg'), ngp_dec: catQ(27.12825, 'deg'), l_node: catQ(32.93192, 'deg'), thin_disc_scale_length: catQ(2600, 'pc', 'measured'), thin_disc_scale_height: catQ(300, 'pc', 'measured'),
    bar_half_length: catQ(5000, 'pc', 'measured'), bar_angle: catQ(27, 'deg', 'measured') },
  provenance: { source: 'static:galaxies', dataset: 'galaxies' }, evidence: 'measured', render: { style: 'milky_way' }, ...o,
});

test('the Galactic axes: the Sun is 8,277 pc from the centre, Sgr A* is at b = -0.046 deg, l = 0 points at the Galactic centre', () => {
  const ax = galacticAxes(192.85948, 27.12825, 32.93192), e = entryOf(mwRec());
  assert.ok(Math.abs(Math.hypot(...e.galPc) - 8277) < 1e-6);
  const c = M.norm(e.galPc), b = Math.asin(dotv(c, ax.n)) / D2R;
  assert.ok(Math.abs(b + 0.046) < 0.001, `b ${b}`);
  const [ra, dec] = M.xyzToRadec(...ax.x); assert.ok(Math.abs(ra - 266.405) < 0.01 && Math.abs(dec + 28.936) < 0.01);
  assert.ok(Math.abs(dotv(ax.x, ax.n)) < 1e-12 && Math.abs(dotv(ax.y, ax.n)) < 1e-12 && Math.abs(dotv(ax.x, ax.y)) < 1e-12);
  const [rra, rdec] = M.xyzToRadec(...ax.y); assert.ok(Math.abs(rra - 318.0) < 0.05 && Math.abs(rdec - 48.33) < 0.05, 'l = 90 is toward Cygnus');
});

test('milkyWayItem: true axes, disc to 6 scale lengths, bar leaning to positive longitude, alpha x (1 - galaxyFade), marker only in the Evidence view', () => {
  const e = entryOf(mwRec()), ax = galacticAxes(192.85948, 27.12825, 32.93192);
  const cam = F.makeCam({ pos: e.galPc.map((v, i) => v + 60000 * ax.n[i]) });   // 60 kpc above the centre: face on
  const proj = pinhole(ax.n.map((v) => -v), ax.y, 1000);
  const it = milkyWayItem(e, cam, { project: proj });
  assert.equal(it.billboard, 'milky_way'); assert.equal(it.look, 'milky_way'); assert.equal(it.inside, false); assert.equal(it.galaxyFade, 0);
  const R = 6 * 2600; assert.ok(Math.abs(it.radiusUnits - R) < 1e-9);
  assert.ok(Math.abs(it.semiMajorPx / (1000 * R / 60000) - 1) < 1e-3, 'face on: a circle of the disc radius'); assert.ok(Math.abs(it.semiMinorPx / it.semiMajorPx - 1) < 1e-3);
  assert.ok(Math.abs(it.disc.thickness - 300 / R) < 1e-12); assert.ok(Math.abs(it.bar.halfLength - 5000 / R) < 1e-12); assert.ok(Math.abs(it.bar.angle - 27 * D2R) < 1e-12);
  assert.ok(Math.abs(it.bar.dir[0] - Math.sin(27 * D2R)) < 1e-12 && it.bar.dir[0] > 0, 'near end toward +A (positive l)');
  assert.equal(it.alpha, 0.3 * it.fade * 1); assert.equal(it.markerAlpha, 1); assert.equal(it.mode, 'glow');
  // the item's A axis is the l = 90 direction: its screen image points along the camera's up (ax.y)
  assert.ok(Math.abs(it.affine.a[0]) < 1e-6 * R && it.affine.a[1] < 0, 'A is along the screen up');
  // alpha against galaxyFade
  const half = milkyWayItem(e, cam, { project: proj, galaxyFade: 0.25 });
  assert.ok(Math.abs(half.alpha - it.alpha * 0.75) < 1e-12); assert.equal(half.markerAlpha, 0.75);
  assert.equal(milkyWayItem(e, cam, { project: proj, galaxyFade: 1 }).alpha, 0);
  const ev = milkyWayItem(e, cam, { project: proj, evidence: true });
  assert.equal(ev.mode, 'marker'); assert.equal(ev.alpha, 0); assert.equal(ev.lineAlpha, 0); assert.equal(ev.markerOnly, true); assert.equal(ev.markerAlpha, 1);
  // from the Sun the camera is inside the disc: no billboard, and galaxyFade is 1 so nothing shows anyway
  const sunView = milkyWayItem(e, sun, { project: view(mwRec()) });
  assert.equal(sunView.inside, true); assert.equal(sunView.alpha, 0); assert.equal(sunView.galaxyFade, 1); assert.equal(sunView.markerAlpha, 0);
});

test('galaxyFade at 0, 20, 30, 40 and 60 kpc', () => {
  const at = (pc) => galaxyFade(F.makeCam({ pos: [pc, 0, 0] }));
  assert.equal(at(0), 1); assert.equal(at(2e4), 1); assert.ok(Math.abs(at(3e4) - 0.5) < 1e-12); assert.equal(at(4e4), 0); assert.equal(at(6e4), 0);
  assert.equal(galaxyFade(F.makeCam({ pos: [3e4 * 1e-6, 0, 0], frame: 'cosmos' })).toFixed(12), '0.500000000000');
});
