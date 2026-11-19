// Pure helpers the Phase 3 renderer (scene3d.js) leans on: the galaxy quad's coordinates, the auto-throttle surface of a galaxy, the speed carried across
// a frame switch and the credit counts of the sky-scope records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectStore, visibleObjects, datasetCounts, starCreditItem, creditsLine } from '../js/blink/scene3d-objects.js';
import { galaxyItem, galaxySurfacePc, galaxyCoords, galaxyShaderParams, galaxyQuad, GALAXY_VERTEX_FLOATS, GALAXY_INSIDE_K } from '../js/blink/scene3d-galaxy.js';
import { carrySpeed, fmtTimesC } from '../js/blink/scene3d-nav.js';
import { defaultLayers } from '../js/blink/scene3d-registry.js';
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
  return { N: [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)], u: M.radecToXyz(ra, dec, 1) };
};
const gal = (id, hub = 'Sb', extra = {}) => ({
  id, kind: 'galaxy', name: id, designations: [], host: null, parent: null,
  position: { model: 'fixed', ra: 10.68, dec: 41.27, epoch: 2000, method: 'cepheid', tier: 'catalogue', dist: { v: 0.7575, lo: 0.735, hi: 0.781, unit: 'Mpc', src: 'Cosmicflows-4', tier: 'measured' } },
  in_cone: false, size: { radius: { v: 30000, unit: 'pc', src: 't', tier: 'inferred' }, angular: { major: catQ(178, 'arcmin'), minor: catQ(70, 'arcmin'), pa: catQ(35, 'deg') } },
  props: { type: { v: 'Galaxy', src: 't', tier: 'catalogue' }, hubble: { v: hub, src: 't', tier: 'catalogue' }, mag_b: catQ(4.29, 'mag'), surface_brightness: catQ(23.63, 'mag/arcsec2') },
  provenance: { source: 'static:galaxies', dataset: 'galaxies' }, evidence: 'measured', render: { mag: 4.29 }, ...extra,
});
const storeOf = (...objs) => { const s = new ObjectStore(); assert.ok(s.ingest({ schema: 'space-maps.objects/1', query: {}, objects: objs, kinds: {}, sources: [] }).ok); return s; };
const visOf = (s, frame, cam) => visibleObjects(s, { layers: defaultLayers(), evidence: false, frame, cam, inHost: () => false });

test('galaxyCoords: the major axis end is (1, 0), the disc images are the unit disc axes, and a singular map gives 0', () => {
  const it = { semiMajorPx: 80, semiMinorPx: 30, angle: 0.4, affine: { a: [70, 20], b: [-9, 12.5], c: [0, 0] } };
  const e = galaxyCoords(it, 80 * Math.cos(0.4), 80 * Math.sin(0.4));
  assert.ok(Math.abs(e.u - 1) < 1e-12 && Math.abs(e.v) < 1e-12);
  const minor = galaxyCoords(it, -30 * Math.sin(0.4), 30 * Math.cos(0.4));
  assert.ok(Math.abs(minor.u) < 1e-12 && Math.abs(minor.v - 1) < 1e-12);
  const A = galaxyCoords(it, 70, 20), B = galaxyCoords(it, -9, 12.5);
  assert.ok(Math.abs(A.du - 1) < 1e-12 && Math.abs(A.dv) < 1e-12 && Math.abs(B.du) < 1e-12 && Math.abs(B.dv - 1) < 1e-12);
  const flat = galaxyCoords({ ...it, affine: { a: [10, 0], b: [20, 0], c: [0, 0] } }, 5, 5);
  assert.equal(flat.du, 0); assert.equal(flat.dv, 0);
});

test('galaxyQuad from a real item: 6 vertices of 18 floats, the quad covers the ellipse, a view with nothing on screen gives null', () => {
  const o = gal('ongc:T'), s = storeOf(o), cam = F.makeCam({ pos: [0, 0, 0] });
  const e = visOf(s, 'galaxy', cam)[0], { N, u } = skyNE(o.position.ra, o.position.dec);
  const it = galaxyItem(e, cam, { project: (rel) => { const p = pinhole(u, N, 1000)(rel); return p && [p[0] + 500, p[1] + 400]; } });
  assert.ok(!it.inside && !it.markerOnly);
  const q = galaxyQuad(it, 1000, 800);
  assert.equal(q.length, 6 * GALAXY_VERTEX_FLOATS);
  const xs = [], ys = [];
  for (let k = 0; k < 6; k++) { xs.push((q[k * 18] + 1) / 2 * 1000); ys.push((1 - q[k * 18 + 1]) / 2 * 800); }
  assert.ok(Math.min(...xs) <= 500 && Math.max(...xs) >= 500 && Math.min(...ys) <= 400 && Math.max(...ys) >= 400);
  assert.equal(galaxyQuad({ ...it, screen: [1e5, 1e5] }, 1000, 800), null);
  assert.equal(galaxyQuad({ ...it, screen: null }, 1000, 800), null);
  for (let k = 0; k < 6; k++) assert.ok(Math.abs(q[k * 18 + 9] - it.alpha) < 1e-6);
});

test('galaxyShaderParams: looks map to shader modes, a face-on disc has face 1 and an edge-on one 0, the Milky Way brings its bar', () => {
  const faceOn = { affine: { a: [50, 0], b: [0, 50], c: [0, 0] } }, edgeOn = { affine: { a: [50, 0], b: [0, 1], c: [0, 0] } };
  const spiral = { billboard: 'galaxy', look: 'barred_spiral', shape: { bulge: 0.3, pitchDeg: 15, bar: true, barAzimuth: 1.1 } };
  assert.equal(galaxyShaderParams({ ...spiral, ...faceOn }).face, 1);
  assert.equal(galaxyShaderParams({ ...spiral, ...edgeOn }).face, 0);
  const p = galaxyShaderParams({ ...spiral, ...faceOn });
  assert.equal(p.mode, 0); assert.ok(p.barHalf > 0 && p.barAz === 1.1 && Math.abs(p.pitch - Math.tan(15 * D2R)) < 1e-12);
  assert.equal(galaxyShaderParams({ billboard: 'galaxy', look: 'elliptical', shape: {}, ...faceOn }).mode, 1);
  assert.equal(galaxyShaderParams({ billboard: 'galaxy', look: 'irregular', shape: {}, ...faceOn }).mode, 2);
  const g = galaxyShaderParams({ billboard: 'galaxy', look: 'group', shape: { blobs: 3 }, ...faceOn });
  assert.equal(g.mode, 3); assert.equal(g.blobs, 3);
  const s0 = galaxyShaderParams({ billboard: 'galaxy', look: 'lenticular', shape: { bulge: 0.6 }, ...faceOn });
  assert.equal(s0.pitch, 0); assert.equal(s0.barHalf, 0);
  const mw = galaxyShaderParams({ billboard: 'milky_way', look: 'milky_way', shape: { bulge: 0.3, pitchDeg: 15 }, bar: { halfLength: 0.32, angle: 27 * D2R }, disc: { scaleLength: 1 / 6 }, ...faceOn });
  assert.ok(Math.abs(mw.barAz - (Math.PI / 2 - 27 * D2R)) < 1e-12 && mw.barHalf === 0.32 && Math.abs(mw.scale - 1 / 6) < 1e-12);
});

test('galaxySurfacePc: centre distance minus the radius, floored at 5 % of the distance; the Milky Way only from outside its disc', () => {
  const m31 = gal('ongc:M31');   // radius 30 kpc
  assert.equal(galaxySurfacePc(m31, 100000), 70000);
  assert.equal(galaxySurfacePc(m31, 30000), GALAXY_INSIDE_K * 30000);
  assert.ok(galaxySurfacePc(m31, 1000) > 0, 'inside a galaxy the speed never reaches zero');
  assert.ok(galaxySurfacePc(m31, 31600) > galaxySurfacePc(m31, 31500), 'continuous and increasing out of the floor');
  const mw = { ...gal('gal:milky_way'), render: { style: 'milky_way' }, props: { thin_disc_scale_length: catQ(2600, 'pc') }, size: { radius: null, angular: null } };
  assert.equal(galaxySurfacePc(mw, 8277), Infinity);
  assert.equal(galaxySurfacePc(mw, 60000), 60000 - 15600);
  assert.equal(galaxySurfacePc({ ...gal('x'), size: { radius: null, angular: null } }, 1000), 1000, 'a galaxy without a size is a point');
});

test('carrySpeed: the same physical speed through every pair of levels, clamped to the new range, with the leaving-a-system floor', () => {
  const [sys, galaxy, cosmos] = F.LEVELS;
  const into = (s, from, to, floorPc = 0) => carrySpeed(s, from.perPc, to.perPc, { ...to.range, floorPc });
  // galaxy 2 pc/s -> cosmos: 2e-6 Mpc/s is below the cosmos minimum 1e-6? no: it is above, so it is carried exactly
  assert.ok(Math.abs(into(2, galaxy, cosmos) - 2e-6) < 1e-18);
  assert.equal(into(1e-3, galaxy, cosmos), cosmos.range.min, 'a very slow galaxy-frame speed is raised to the cosmos minimum');
  assert.ok(Math.abs(into(0.02, cosmos, galaxy) - 2e4) < 1e-9, '0.02 Mpc/s is 20,000 pc/s');
  assert.equal(into(1e3, cosmos, galaxy), galaxy.range.max, 'capped at the galaxy maximum');
  // leaving a system: the old rule max(speed / AU_PER_PC, 0.05) pc/s
  assert.equal(into(1, sys, galaxy, 0.05), 0.05);
  assert.ok(Math.abs(into(1e5, sys, galaxy, 0.05) - 1e5 / F.AU_PER_PC) < 1e-12);
  // a round trip with no clamping returns the speed
  assert.ok(Math.abs(into(into(5, galaxy, cosmos), cosmos, galaxy) - 5) < 1e-9);
});

test('fmtTimesC never writes an exponent: the cosmos speeds are hundreds of quadrillions of c', () => {
  assert.equal(fmtTimesC(1e5), '100 thousand× c');
  assert.equal(fmtTimesC(2.1e8), '210 million× c');
  assert.equal(fmtTimesC(1.2e17), '120 quadrillion× c');
  assert.equal(fmtTimesC(2.1e19), '21,000 quadrillion× c');
  assert.equal(fmtTimesC(2.1e6), '2.1 million× c');
});

test('datasetCounts with skyScope counts the sky-tile galaxies and black holes that are outside the cone, never a cone-scope record outside it', () => {
  const m = gal('ongc:M31'), far = { ...gal('ongc:far'), in_cone: false }, near = { ...gal('ongc:near'), in_cone: true };
  const neb = { id: 'ongc:NGC1976', kind: 'nebula', name: 'Orion', designations: [], host: null, parent: null, position: { model: 'fixed', ra: 83.8, dec: -5.4, epoch: 2000, method: 'cepheid', tier: 'catalogue', dist: { v: 400, unit: 'pc', src: 't', tier: 'measured' } },
    in_cone: false, size: { radius: null, angular: { major: catQ(60, 'arcmin') } }, props: { type: { v: 'Nebula', src: 't', tier: 'catalogue' } }, provenance: { source: 'static:nebulae', dataset: 'nebulae' }, evidence: 'measured', render: {} };
  const bh = { id: 'bh:M87*', kind: 'black_hole', name: 'M87*', designations: [], host: null, parent: 'ongc:M87', position: gal('x').position, in_cone: false, size: { radius: { v: 1e-3, unit: 'km', src: 't', tier: 'inferred' } },
    props: { type: { v: 'supermassive', src: 't', tier: 'catalogue' }, mass: catQ(6.5e9, 'Msun') }, provenance: { source: 'static:smbh-curated', dataset: 'smbh-curated' }, evidence: 'measured', render: { style: 'lensing' } };
  const s = storeOf(m, far, near, neb, bh);
  assert.deepEqual(datasetCounts(s), { galaxies: 1 });
  assert.deepEqual(datasetCounts(s, { skyScope: true }), { galaxies: 3, 'smbh-curated': 1 });
  const sources = [{ id: 'static:galaxies', status: 'ok', count: 3, provenance: { dataset: 'galaxies', credit: 'Credit: OpenNGC', licence_name: 'CC BY-SA 4.0' } }];
  assert.equal(creditsLine(sources, datasetCounts(s, { skyScope: true }), [starCreditItem(true)]), 'Credit: OpenNGC · CC BY-SA 4.0 | Stars: Gaia DR3 · Credit: ESA/Gaia/DPAC · CC BY-NC 3.0 IGO');
  assert.equal(creditsLine(sources, datasetCounts(s, { skyScope: true }), [starCreditItem(false)]), 'Credit: OpenNGC · CC BY-SA 4.0');
});

test('a galaxy looks the same in the galaxy and the cosmos frame (the switch has no jump): screen, alpha and size agree to rounding', () => {
  const o = gal('ongc:T'), s = storeOf(o);
  const camG = F.makeCam({ pos: [30000, 5000, 4000] }), camC = F.makeCam({ pos: [0, 0, 0], frame: 'cosmos' });
  camC.pos = camG.pos.map((v) => v * 1e-6);
  const dir = M.norm([1, 0.3, 0.2]);
  const R = crossv(dir, [0, 0, 1]), up = crossv(R, dir);
  const mk = (cam) => { const e = visOf(s, cam.frame, cam)[0]; return galaxyItem(e, cam, { project: pinhole(dir, up, 800) }); };
  const a = mk(camG), b = mk(camC);
  assert.ok(a && b);
  for (const k of ['alpha', 'fade', 'semiMajorPx', 'semiMinorPx', 'angle']) assert.ok(Math.abs(a[k] - b[k]) <= 1e-6 * Math.max(1, Math.abs(a[k])), k);
  assert.ok(Math.hypot(a.screen[0] - b.screen[0], a.screen[1] - b.screen[1]) < 1e-3);
  const e = visOf(s, 'cosmos', camC);
  assert.equal(e.length, 1, 'the cosmos frame draws the galaxy');
});
