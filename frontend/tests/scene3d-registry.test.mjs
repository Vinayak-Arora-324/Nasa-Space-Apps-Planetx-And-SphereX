import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../js/blink/scene3d-registry.js';
import * as F from '../js/blink/scene3d-format.js';
import * as M from '../js/blink/scene3d-math.js';

const stub = (init) => { const m = new Map(init ? [['blink.scene3d.layers', init]] : []); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), m }; };
const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
const q = (v, unit, tier = 'measured', src = 'test') => ({ v, unit, tier, src });
const planet = (name, extra = {}) => ({
  id: 'ss:' + name.toLowerCase(), kind: 'planet', name, host: 'ss:sun', evidence: 'measured', render: {},
  position: { model: 'state', xyz_au: [1.2, -0.5, -0.27], tier: 'measured', geo: { ra: 1, dec: 2, dist_au: 1.9 } },
  size: { radius: q(3396.2, 'km') },
  props: { dist_sun: q(1.3637, 'au'), dist_earth: q(1.932, 'au') }, ...extra,
});
const small = (id, kind, name, props = {}, extra = {}) => ({
  id, kind, name, host: 'ss:sun', evidence: 'measured', render: { mag: 22.5 }, size: null,
  position: { model: 'state', xyz_au: [-2, 1.4, 0.6], tier: 'catalogue' },
  props: { class: q('MB>Middle', undefined, 'catalogue'), vmag: q(22.5, 'mag', 'catalogue'), dist_sun: q(2.6213, 'au', 'catalogue'), dist_earth: q(2.40787, 'au', 'catalogue'), ...props }, ...extra,
});
const ctx = (o = {}) => ({ fromYou: '1.5 pc · 4.9 ly', evidence: false, fmtNum: R.fmtNum, ...o });

test('the Phase 0 kinds and layers are registered and every kind points at a real layer', () => {
  for (const k of ['sun', 'planet', 'moon', 'dwarf_planet', 'asteroid', 'comet', 'star']) assert.ok(R.kindSpec(k), k);
  assert.deepEqual(R.layers().map((l) => l.id), ['mw', 'cone', 'starNames', 'planets', 'orbits', 'dwarfPlanets', 'asteroids', 'comets', 'exoplanets', 'clusters', 'clusterCandidates', 'nebulae', 'blackHoles', 'galaxies']);
  assert.deepEqual(R.layers().map((l) => l.group), ['sky', 'sky', 'sky', 'solar', 'solar', 'solar', 'solar', 'solar', 'beyond', 'beyond', 'beyond', 'beyond', 'beyond', 'beyond']);
  const ids = new Set(R.layers().map((l) => l.id));
  for (const s of R.kinds()) assert.ok(s.layer === null || ids.has(s.layer), `${s.kind} layer`);
  assert.equal(R.kindSpec('star').builtin, true); assert.equal(R.kindSpec('star').layer, null); assert.equal(R.kindSpec('star').pick.priority, 20);
  assert.equal(R.layerOf('comet'), 'comets'); assert.equal(R.layerOf('nope'), null); assert.equal(R.kindSpec('nope'), null);
  assert.deepEqual(R.defaultLayers(), Object.fromEntries([...ids].map((i) => [i, i !== 'clusterCandidates'])));   // candidates are off by default (section 16.18 D4)
});

test('kind specs: frames, scope, priorities, labels, collide', () => {
  const P = R.kindSpec('planet'), Mo = R.kindSpec('moon'), S = R.kindSpec('sun'), A = R.kindSpec('asteroid');
  assert.deepEqual(P.frames, { system: 'sphere', galaxy: 'marker' }); assert.deepEqual(Mo.frames, P.frames);
  assert.deepEqual(S.frames, { galaxy: 'marker' });
  assert.deepEqual(A.frames, { system: 'point', galaxy: 'marker' });
  for (const k of ['sun', 'planet', 'moon']) assert.equal(R.kindSpec(k).galaxyScope, 'sky');
  for (const k of ['dwarf_planet', 'asteroid', 'comet']) { assert.equal(R.kindSpec(k).galaxyScope, 'cone'); assert.equal(R.kindSpec(k).pick.priority, 30); }
  assert.equal(P.pick.priority, 10); assert.equal(S.pick.priority, 10); assert.equal(Mo.pick.priority, 10);
  assert.equal(P.label.key(planet('Mars')), 0); assert.equal(Mo.label.key({}), 50); assert.equal(P.label.hideOverDiscPx, 30);
  assert.equal(A.label.max, 12); assert.equal(R.MAX_BODY_LABELS, 12);
  assert.equal(A.label.key({ render: { mag: 20.5 } }), 120.5); assert.equal(A.label.key({ render: {} }), 130);
  assert.ok(P.collide && Mo.collide && !A.collide);
  assert.equal(P.go, 'host-frame');
  assert.equal(P.pointSize({ name: 'Earth' }), 9); assert.equal(Mo.pointSize({}), 4); assert.equal(P.pointSize({ name: 'Mars' }), 6.5); assert.equal(A.pointSize({}), 3);
  assert.equal(P.markerStyle({ evidence: 'derived' }), 'hollow'); assert.equal(P.markerStyle({ evidence: 'measured' }), 'solid');
});

test('units convert to AU and parsecs', () => {
  assert.ok(Math.abs(R.toAu({ v: M.KM_PER_AU, unit: 'km' }) - 1) < 1e-12);
  assert.ok(Math.abs(R.toAu({ v: 1, unit: 'pc' }) - 206264.80624709636) < 1e-6);
  assert.ok(Math.abs(R.toPc({ v: 2, unit: 'Mpc' }) - 2e6) < 1e-6);
  assert.ok(Math.abs(R.toPc({ v: 206264.80624709636, unit: 'au' }) - 1) < 1e-12);
  assert.equal(R.toAu({ v: 1, unit: 'furlong' }), null); assert.equal(R.toPc(null), null); assert.equal(R.toPc({ v: 'x', unit: 'pc' }), null);
});

test('arriveAu: sphere radius in AU, points 0', () => {
  assert.ok(Math.abs(R.kindSpec('planet').arriveAu(planet('Mars')) - 3396.2 / M.KM_PER_AU) < 1e-15);
  assert.equal(R.kindSpec('asteroid').arriveAu(small('mp:2', 'asteroid', 'x')), 0);
});

test('layer persistence: round trip, missing, throwing, bad JSON, partial and invalid values', () => {
  const st = stub();
  R.saveLayers({ ...R.defaultLayers(), asteroids: false, mw: false }, st);
  assert.ok(st.m.has('blink.scene3d.layers'));
  const back = R.loadLayers(st);
  assert.equal(back.asteroids, false); assert.equal(back.mw, false); assert.equal(back.comets, true);
  assert.deepEqual(R.loadLayers(stub()), R.defaultLayers());
  assert.deepEqual(R.loadLayers(null), R.defaultLayers());
  assert.deepEqual(R.loadLayers(throwing), R.defaultLayers());
  assert.deepEqual(R.loadLayers(stub('{not json')), R.defaultLayers());
  assert.deepEqual(R.loadLayers(stub('[1,2]')), R.defaultLayers());
  assert.deepEqual(R.loadLayers(stub('null')), R.defaultLayers());
  const part = R.loadLayers(stub(JSON.stringify({ comets: false, orbits: 'no', bogus: false, mw: 0 })));
  assert.equal(part.comets, false); assert.equal(part.orbits, true); assert.equal(part.mw, true); assert.ok(!('bogus' in part));
  R.saveLayers({ a: true }, throwing); R.saveLayers({ a: true }, null);   // neither throws
  assert.doesNotThrow(() => R.loadLayers());                              // default storage, whatever the runtime has
});

test('planet card: radius, distance, from you, illustrative colour; tiers from the record', () => {
  const c = R.kindSpec('planet').card(planet('Mars'), ctx());
  assert.equal(c.title, 'Mars');
  assert.deepEqual(c.rows.map((r) => r.slice(0, 3)), [
    ['Radius', '3,400 km', 'measured'], ['Distance from Sun', '1.36 AU', 'measured'],
    ['From you', '1.5 pc · 4.9 ly', 'illustrative'], ['Colour and lighting', 'illustrative', 'illustrative'],
  ]);
  assert.equal(c.rows[0][3], 'test');
  const ev = R.kindSpec('planet').card(planet('Mars'), ctx({ evidence: true }));
  assert.deepEqual(ev.rows.map((r) => r[0]), ['Radius', 'Distance from Sun']);
  const noYou = R.kindSpec('moon').card(planet('Moon', { kind: 'moon' }), ctx({ fromYou: null }));
  assert.deepEqual(noYou.rows.map((r) => r[0]), ['Radius', 'Distance from Sun', 'Colour and lighting']);
});

test('planet card falls back to the position for the distance from the Sun, and to n/a without a radius', () => {
  const o = planet('Venus', { props: {}, size: null });
  const c = R.kindSpec('planet').card(o, ctx());
  assert.equal(c.rows[0][1], 'n/a'); assert.equal(c.rows[1][1], `${R.fmtNum(Math.hypot(1.2, -0.5, -0.27))} AU`);
});

test('asteroid and comet cards', () => {
  const a = small('mp:2019 YB21', 'asteroid', '2019 YB21');
  const c = R.kindSpec('asteroid').card(a, ctx());
  assert.equal(c.title, '2019 YB21');
  assert.deepEqual(c.rows.map((r) => r.slice(0, 3)), [
    ['Distance from Sun', '2.62 AU', 'catalogue'], ['Distance from Earth', '2.41 AU', 'catalogue'],
    ['From you', '1.5 pc · 4.9 ly', 'illustrative'], ['Visual mag', '22.5', 'catalogue'], ['Class', 'MB>Middle', 'catalogue'],
  ]);
  assert.equal(R.kindSpec('asteroid').card(a, ctx({ evidence: true })).rows.length, 4);
  const cm = R.kindSpec('comet').card(small('comet:29P', 'comet', '29P/Schwassmann-Wachmann', { class: q('Comet', undefined, 'catalogue'), vmag: q('?', 'mag', 'catalogue') }), ctx());
  assert.equal(cm.title, '29P/Schwassmann-Wachmann'); assert.equal(cm.rows[3][1], 'n/a'); assert.equal(cm.rows[4][1], 'Comet');
  const none = R.kindSpec('asteroid').card(small('mp:5', 'asteroid', 'Astraea', { class: undefined, vmag: undefined }), ctx());
  assert.equal(none.rows[3][1], 'n/a'); assert.equal(none.rows[4][1], 'n/a');
});

test('small-body titles: the number goes first for numbered mp ids only', () => {
  const t = (id, name) => R.kindSpec('dwarf_planet').card(small(id, 'dwarf_planet', name), ctx()).title;
  assert.equal(t('mp:1', 'Ceres'), '1 Ceres');
  assert.equal(t('mp:134340', 'Pluto'), '134340 Pluto');
  assert.equal(t('mp:1', '1'), '1');
  assert.equal(t('mp:2019 YB21', '2019 YB21'), '2019 YB21');
  assert.equal(t('comet:29P', '29P'), '29P');
});

test('evidenceRows drops illustrative rows only in the Evidence view', () => {
  const rows = [['a', 'x', 'measured'], ['b', 'y', 'illustrative']];
  assert.deepEqual(R.evidenceRows(rows, true), [rows[0]]); assert.deepEqual(R.evidenceRows(rows, false), rows);
});

test('visible: illustrative records are hidden in the Evidence view only', () => {
  const v = R.kindSpec('planet').visible;
  assert.equal(v({ evidence: 'illustrative' }, { evidence: true }), false);
  assert.equal(v({ evidence: 'illustrative' }, { evidence: false }), true);
  assert.equal(v({ evidence: 'derived' }, { evidence: true }), true);
});

test('sphere spec reproduces the old planet drawing', () => {
  const S = R.kindSpec('planet').sphere, at = (n, evidence = false) => S({ name: n }, { evidence });
  assert.deepEqual(at('Saturn').features, { ring: 1, band: 1, atm: 0 }); assert.equal(at('Saturn').ext, 2.4); assert.equal(at('Saturn', true).ext, 1.1);
  assert.deepEqual(at('Jupiter').features, { ring: 0, band: 1, atm: 0 });
  assert.deepEqual(at('Earth').features, { ring: 0, band: 0, atm: 1 }); assert.deepEqual(at('Venus').features, { ring: 0, band: 0, atm: 1 });
  assert.deepEqual(at('Mars').features, { ring: 0, band: 0, atm: 0 });
  assert.deepEqual(at('Jupiter').pole, [268.06, 64.5]); assert.equal(at('Venus').pole, null);
  assert.deepEqual(at('Mars').rgb, [1.0, 0.5, 0.35]); assert.deepEqual(at('Pluto?').rgb, [0.8, 0.8, 0.8]);
  assert.equal(at('Saturn', true).features.ring, 1, 'Phase 0: the Evidence view still shows the features');
  assert.equal(R.EVIDENCE_HIDES_FEATURES, false); assert.equal(R.FEATURE_TIER, 'illustrative');
  assert.deepEqual(R.kindSpec('moon').sphere({ name: 'Moon' }, {}).rgb, [0.8, 0.8, 0.8]);
});

test('colours: planets by name, small bodies by kind and class', () => {
  assert.deepEqual(R.kindSpec('planet').color({ name: 'Earth' }), [0.35, 0.62, 1.0]);
  assert.deepEqual(R.kindSpec('comet').color(small('comet:1P', 'comet', 'Halley')), [0.6, 0.9, 1.0]);
  assert.deepEqual(R.kindSpec('asteroid').color(small('mp:3', 'asteroid', 'x', { class: q('NEA>Apollo', undefined, 'catalogue') })), [1.0, 0.7, 0.5]);
  assert.deepEqual(R.kindSpec('asteroid').color(small('mp:4', 'asteroid', 'x', { class: q('Centaur', undefined, 'catalogue') })), [0.82, 0.78, 0.7]);
  assert.equal(R.kindSpec('dwarf_planet').color({}).length, 3);
});

test('registerKind adds a kind with defaults, and kindsPhrase-style nouns', () => {
  R.registerKind({ kind: 'test_thing', noun: ['thing', 'things'] });
  const s = R.kindSpec('test_thing');
  assert.equal(s.go, 'host-frame'); assert.equal(s.pick.priority, 30); assert.equal(s.galaxyScope, 'sky'); assert.equal(s.collide, false);
  assert.equal(s.markerStyle({ evidence: 'derived' }), 'hollow');
  assert.throws(() => R.registerKind({}));
});

// ------------------------------------------------------------------ Phase 1: exoplanets and star clusters
import { orbitPlacement } from '../js/blink/scene3d-orbits.js';
const NEA = 'NEA pscomppars: ';
const exoRec = (o = {}, el = {}) => ({
  id: 'nea:TRAPPIST-1 b', kind: 'exoplanet', name: 'TRAPPIST-1 b', host: 'gdr3:1', parent: 'gdr3:1', evidence: 'illustrative', render: { mag: 17 },
  position: { model: 'orbit', host_radec: [346.6263919, -5.0434618], phase_known: true, tier: 'illustrative', elements: {
    period_d: { ...q(1.510826, 'd', 'measured', NEA + 'Agol et al. 2021'), lo: 1.51082, hi: 1.510832 }, a_au: q(0.01154, 'au', 'catalogue', NEA + 'Agol et al. 2021'), e: q(0.00622, undefined, 'measured', NEA + 'Grimm et al. 2018'),
    i_deg: q(89.728, 'deg', 'measured', NEA + 'Agol'), omega_deg: q(336.86, 'deg'), t_conj_mjd: q(57322.014193, undefined), t_peri_mjd: null, node_deg: null, ...el } },
  size: { radius: q(1.116, 'Rearth', 'measured', NEA + 'Agol et al. 2021') },
  props: { mass: q(0.00432309, 'Mjup', 'measured', NEA + 'Agol et al. 2021'), disc_method: q('Transit', undefined, 'catalogue'), disc_year: q(2016, undefined, 'catalogue'), disc_facility: q('La Silla Observatory', undefined, 'catalogue') },
  provenance: { catalogue: 'NASA Exoplanet Archive pscomppars' }, ...o,
});
const placeOf = (o) => { const orb = orbitPlacement(o, 61000); return { sysAu: orb.xyzAu, galPc: null, dir: null, orbit: orb }; };
const rowOf = (card, label) => card.rows.find((r) => r[0] === label);
const cl = (o = {}, pr = {}) => ({
  id: 'hr23:Melotte_22', kind: 'cluster', name: 'Pleiades', host: null, evidence: 'measured', render: {}, in_cone: true,
  position: { model: 'fixed', ra: 56.75, dec: 24.12, method: 'cluster-parallax', dist: q(135.2, 'pc', 'measured', 'HR23', ) },
  size: { radius: q(3.1, 'pc', 'catalogue', 'HR23'), angular: { major: 6 } },
  props: { n_members: q(1245, undefined, 'catalogue', 'HR23'), age: q(0.05, 'Gyr', 'inferred', 'CMD fit'), extinction: q(0.2, 'mag', 'inferred', 'CMD fit'), type: q('open', undefined, 'catalogue'),
    quality: q('reliable', undefined, 'catalogue', 'CST > 5'), ...pr }, ...o,
});

test('Phase 1 layers: exoplanets, clusters and the clusterCandidates sub-switch in group beyond, persisted like the rest', () => {
  const by = Object.fromEntries(R.layers().map((l) => [l.id, l]));
  assert.deepEqual([by.exoplanets, by.clusters], [{ id: 'exoplanets', label: 'Exoplanets', group: 'beyond', on: true, parent: null }, { id: 'clusters', label: 'Star clusters', group: 'beyond', on: true, parent: null }]);
  assert.deepEqual(by.clusterCandidates, { id: 'clusterCandidates', label: 'Include candidates', group: 'beyond', on: false, parent: 'clusters' });
  assert.equal(by.planets.parent, null);
  assert.equal(R.layerOf('exoplanet'), 'exoplanets'); assert.equal(R.layerOf('cluster'), 'clusters');
  const st = stub(); const m = R.loadLayers(st); assert.equal(m.clusterCandidates, false); assert.equal(m.exoplanets, true);
  R.saveLayers({ ...m, clusterCandidates: true, exoplanets: false }, st);
  assert.deepEqual([R.loadLayers(st).clusterCandidates, R.loadLayers(st).exoplanets, R.loadLayers(st).clusters], [true, false, true]);
  assert.equal(R.loadLayers(stub('{"clusterCandidates":"yes"}')).clusterCandidates, false);
});

test('exoplanet and cluster specs; rendererOf resolves a per-record renderer', () => {
  const E = R.kindSpec('exoplanet'), C = R.kindSpec('cluster');
  assert.equal(E.hosted, true); assert.equal(R.kindSpec('planet').hosted, false); assert.equal(C.hosted, false);
  assert.deepEqual(E.noun, ['exoplanet', 'exoplanets']); assert.deepEqual(C.noun, ['star cluster', 'star clusters']);
  assert.equal(R.rendererOf(E, 'system', exoRec()), 'sphere');
  assert.equal(R.rendererOf(E, 'system', exoRec({ size: null })), 'point');
  assert.equal(R.rendererOf(E, 'system', exoRec({ size: { radius: null } })), 'point');
  assert.equal(R.rendererOf(E, 'galaxy', exoRec()), 'marker');
  assert.equal(R.rendererOf(C, 'galaxy', cl()), 'billboard'); assert.equal(R.rendererOf(C, 'system', cl()), null);
  assert.equal(R.rendererOf(R.kindSpec('planet'), 'system', {}), 'sphere'); assert.equal(R.rendererOf(R.kindSpec('sun'), 'system', {}), null); assert.equal(R.rendererOf(null, 'system', {}), null);
  assert.equal(E.galaxyScope, 'cone'); assert.deepEqual(E.pick, { priority: 10, marker: 15 }); assert.equal(E.collide, true); assert.equal(E.pointSize(), 4); assert.equal(E.markerPx(), 4);
  assert.equal(E.label.max, 12); assert.equal(E.label.hideOverDiscPx, 30);
  assert.deepEqual(C.pick, { priority: 25, marker: 16 }); assert.equal(C.go, 'fly-galaxy'); assert.equal(C.galaxyScope, 'cone');
  assert.ok(Math.abs(C.arrivePc(cl()) - 6.2) < 1e-9); assert.equal(R.kindSpec('planet').arrivePc({}), 0);
  assert.ok(C.label.key(cl({}, { n_members: q(5000) })) < C.label.key(cl()), 'more members sort first');
  assert.ok(Math.abs(E.arriveAu(exoRec()) - 1.116 * 6371 / M.KM_PER_AU) < 1e-12);
  assert.equal(R.kindSpec('exoplanet').sphere(exoRec()).features.band, 0); assert.equal(R.kindSpec('exoplanet').sphere(exoRec()).pole, null);
  const rgb = (r) => R.kindSpec('exoplanet').color(exoRec({ size: { radius: q(r, 'Rearth') } })).join();
  assert.equal(new Set([0.9, 1.5, 3, 5, 12].map(rgb)).size, 5, 'a colour per size class');
});

test('layer map reaches visible(): cluster candidates are hidden unless clusterCandidates is true; evidence does not hide clusters', () => {
  const C = R.kindSpec('cluster'), cand = cl({}, { quality: q('candidate', undefined, 'catalogue') });
  assert.equal(C.visible(cl(), { evidence: true, layers: {} }), true); assert.equal(C.visible(cl({ evidence: 'derived' }), { evidence: true, layers: {} }), true);
  assert.equal(C.visible(cand, { evidence: false, layers: {} }), false); assert.equal(C.visible(cand, { layers: { clusterCandidates: false } }), false);
  assert.equal(C.visible(cand, { evidence: true, layers: { clusterCandidates: true } }), true); assert.equal(C.visible(cand), false);
  assert.equal(R.kindSpec('exoplanet').visible(exoRec(), { evidence: true, layers: {} }), false); assert.equal(R.kindSpec('exoplanet').visible(exoRec(), { evidence: false }), true);
  assert.equal(R.kindSpec('planet').visible(planet('Mars'), { evidence: true, layers: {} }), true);
});

test('exoplanet card: rows with tiers and sources, in the section 16.7 order', () => {
  const o = exoRec(), c = R.kindSpec('exoplanet').card(o, ctx({ place: placeOf(o), hostName: 'TRAPPIST-1' }));
  assert.equal(c.title, 'TRAPPIST-1 b'); assert.equal(c.subtitle, 'Exoplanet');
  assert.deepEqual(c.rows.map((r) => r[0]), ['Host star', 'Orbital period', 'Semi-major axis', 'Eccentricity', 'Inclination', 'Mass', 'Radius', 'Discovered', 'From its star now', 'From you']);
  assert.deepEqual(rowOf(c, 'Host star'), ['Host star', 'TRAPPIST-1', 'catalogue', 'NASA Exoplanet Archive pscomppars']);
  assert.deepEqual(rowOf(c, 'Orbital period'), ['Orbital period', '1.510826 ± 0.000006 d', 'measured', NEA + 'Agol et al. 2021']);   // the digits its interval supports
  assert.deepEqual(rowOf(c, 'Semi-major axis').slice(1, 3), ['0.0115 AU', 'catalogue']);
  assert.deepEqual(rowOf(c, 'Eccentricity').slice(1, 3), ['0.00622', 'measured']);
  assert.deepEqual(rowOf(c, 'Inclination').slice(1, 3), ['89.7°', 'measured']);
  assert.deepEqual(rowOf(c, 'Mass').slice(1, 3), ['1.37 M⊕', 'measured']);                       // 0.00432 Mjup < 0.1 Mjup: Earth masses
  assert.deepEqual(rowOf(c, 'Radius').slice(1, 3), ['1.12 R⊕', 'measured']);
  assert.deepEqual(rowOf(c, 'Discovered').slice(1, 3), ['Transit, 2016, La Silla Observatory', 'catalogue']);
  const from = rowOf(c, 'From its star now'); assert.equal(from[2], 'illustrative'); assert.match(from[1], /AU$/);
  assert.equal(rowOf(c, 'From you')[2], 'illustrative');
  assert.equal(c.notes[0], 'Where it is drawn on its orbit is illustrative: the orbit\'s orientation on the sky is not known.');
  assert.match(c.notes[1], /^Phase from the 2016 transit time, ±\d+(\.\d+)?° today\.$/); assert.equal(c.notes.length, 2);
  assert.equal(R.kindSpec('exoplanet').card(o, ctx()).rows.find((r) => r[0] === 'Host star')[1], 'gdr3:1');       // no hostName: the id; no place: no row
  assert.equal(R.kindSpec('exoplanet').card(o, ctx()).rows.some((r) => r[0] === 'From its star now'), false);
});

test('exoplanet card: M sin i is a minimum mass, inferred radius and mass name their relation, large values change unit', () => {
  const ms = exoRec({ props: { msini: q(0.47, 'Mjup', 'measured', NEA + 'x'), disc_method: q('Radial Velocity', undefined, 'catalogue') }, size: { radius: q(14.1, 'Rearth', 'inferred', NEA + 'archive-calculated from mass (Chen & Kipping 2017)') } });
  const c = R.kindSpec('exoplanet').card(ms, ctx({ place: placeOf(ms) }));
  assert.deepEqual(rowOf(c, 'Minimum mass (M sin i)').slice(1, 3), ['0.47 Mj', 'measured']); assert.equal(rowOf(c, 'Mass'), undefined);
  const r = rowOf(c, 'Radius (from mass, Chen & Kipping 2017)'); assert.deepEqual(r.slice(1, 3), ['1.26 Rj', 'inferred']); assert.match(r[3], /Chen & Kipping/);
  const mr = exoRec({ props: { mass: q(0.02, 'Mjup', 'inferred', NEA + 'archive-calculated from radius (Chen & Kipping 2017)') } });
  const m = R.kindSpec('exoplanet').card(mr, ctx({ place: placeOf(mr) })), row = rowOf(m, 'Mass (from radius, Chen & Kipping 2017)');
  assert.deepEqual(row.slice(1, 3), ['6.36 M⊕', 'inferred']);
  assert.deepEqual(rowOf(R.kindSpec('exoplanet').card(exoRec({ props: { mass: q(2.5, 'Mjup') } }), ctx()), 'Mass').slice(1), ['2.5 Mj', 'measured', 'test']);
  const bare = R.kindSpec('exoplanet').card(exoRec({ props: {}, size: null }), ctx());
  assert.equal(rowOf(bare, 'Mass')[1], 'n/a'); assert.equal(rowOf(bare, 'Radius')[1], 'n/a'); assert.equal(rowOf(bare, 'Discovered')[1], 'n/a');
});

test('exoplanet card: assumed eccentricity and inclination are labelled, illustrative, and dropped in the Evidence view', () => {
  const o = exoRec({}, { e: q(0, undefined, 'illustrative', 'assumed circular (no eccentricity in the archive)'), i_deg: null, t_conj_mjd: null, t_peri_mjd: q(52496.5, undefined, 'measured', 'x') });
  o.props.disc_method = q('Radial Velocity', undefined, 'catalogue');
  const place = placeOf(o), c = R.kindSpec('exoplanet').card(o, ctx({ place }));
  assert.deepEqual(rowOf(c, 'Eccentricity').slice(1, 3), ['0 (assumed)', 'illustrative']);
  const inc = rowOf(c, 'Inclination'); assert.equal(inc[2], 'illustrative'); assert.equal(inc[1], `unknown · drawn at ${Math.round(place.orbit.used.incl)}°`);
  assert.match(c.notes[1], /^Phase from the 2003 periastron time/);
  const ev = R.kindSpec('exoplanet').card(o, ctx({ place, evidence: true }));
  for (const l of ['Eccentricity', 'Inclination', 'From its star now', 'From you']) assert.equal(rowOf(ev, l), undefined, l);
  assert.ok(rowOf(ev, 'Orbital period') && rowOf(ev, 'Radius'));
  const noPlace = R.kindSpec('exoplanet').card(o, ctx()); assert.equal(rowOf(noPlace, 'Inclination')[1], 'unknown'); assert.equal(rowOf(noPlace, 'Eccentricity')[1], '0 (assumed)');
});

test('exoplanet card notes: unknown phase, phase effectively unknown, and the controversial flag', () => {
  const o = exoRec({}, { t_conj_mjd: null }), card = (x, p) => R.kindSpec('exoplanet').card(x, ctx({ place: p || placeOf(x) }));
  assert.equal(card(o).notes[1], 'Its place along the orbit is unknown, so an assumed phase is drawn.');
  const far = exoRec({}, { period_d: q(1.510826, undefined, 'measured', 'x'), a_au: q(0.0115), t_conj_mjd: q(40000) });
  far.position.elements.period_d.lo = 1.5; far.position.elements.period_d.hi = 1.52;
  assert.match(card(far).notes[1], /effectively unknown at this date/);
  const c = exoRec({}); c.props.controversial = q('yes', undefined, 'catalogue');
  assert.match(card(c).notes.at(-1), /controvers/);
  assert.equal(R.kindSpec('exoplanet').card(exoRec({}), ctx()).notes.length, 1, 'no place, no phase note');
});

test('planetLine: period, radius and mass with the weakest tier', () => {
  assert.deepEqual(R.planetLine(exoRec()), { line: '1.51 d · 1.12 R⊕ · 1.37 M⊕', tier: 'measured' });
  const rv = exoRec({ props: { msini: q(0.47, 'Mjup') }, size: null }, { period_d: q(4.2307966, 'd') });
  assert.deepEqual(R.planetLine(rv), { line: '4.23 d · 0.47 Mj min', tier: 'measured' });
  const inf = exoRec({ size: { radius: q(14.1, 'Rearth', 'inferred') } }); assert.deepEqual(R.planetLine(inf), { line: '1.51 d · 1.26 Rj · 1.37 M⊕', tier: 'inferred' });
  assert.equal(R.planetLine(exoRec({ props: {}, size: null }, { period_d: null })).line, '0.0115 AU');
  assert.equal(R.planetLine(exoRec({ props: {}, size: null }, { period_d: null, a_au: null })).line, '');
});

test('cluster card: distance with interval and method, members, r50, age, extinction, type, quality, class and mass', () => {
  const o = cl(); o.position.dist = { ...o.position.dist, lo: 133.9, hi: 136.6 };
  const c = R.kindSpec('cluster').card(o, ctx());
  assert.equal(c.title, 'Pleiades'); assert.equal(c.subtitle, 'Star cluster');
  assert.deepEqual(rowOf(c, 'Distance (cluster parallax)'), ['Distance (cluster parallax)', '135.2 +1.4/−1.3 pc', 'measured', 'HR23']);
  assert.deepEqual(rowOf(c, 'Members').slice(1, 3), ['1,250', 'catalogue']);
  assert.deepEqual(rowOf(c, 'Radius (r50)').slice(1, 3), ['3.1 pc', 'catalogue']);
  assert.deepEqual(rowOf(c, 'Age').slice(1, 3), ['50 Myr', 'inferred']);
  assert.deepEqual(rowOf(c, 'Extinction (A_V)').slice(1, 3), ['0.2 mag', 'inferred']);
  assert.deepEqual(rowOf(c, 'Type').slice(1, 3), ['open', 'catalogue']);
  assert.deepEqual(rowOf(c, 'Quality').slice(1, 4), ['reliable', 'catalogue', 'CST > 5']);
  assert.equal(c.notes, null); assert.equal(rowOf(c, 'Class'), undefined); assert.equal(rowOf(c, 'Mass'), undefined);
  assert.deepEqual(R.kindSpec('cluster').card(cl({}, { age: q(2.5, 'Gyr', 'inferred') }), ctx()).rows.find((r) => r[0] === 'Age').slice(1, 3), ['2.5 Gyr', 'inferred']);
  const hr24 = R.kindSpec('cluster').card(cl({}, { mass: q(800, 'Msun', 'inferred', 'HR24'), class: q('bound cluster', undefined, 'catalogue', 'HR24') }), ctx());
  assert.deepEqual(rowOf(hr24, 'Class').slice(1, 3), ['bound cluster', 'catalogue']); assert.deepEqual(rowOf(hr24, 'Mass').slice(1, 3), ['800 M☉', 'inferred']);
  assert.equal(rowOf(R.kindSpec('cluster').card(cl({}, { bound: q(false, undefined, 'catalogue') }), ctx()), 'Class')[1], 'moving group');
});

test('cluster card: derived distance is prior-dominated, candidates say so, and the Evidence view keeps these rows', () => {
  const d = cl({ evidence: 'derived' }); d.position.dist = q(1800, 'pc', 'inferred', 'HR23 prior');
  const c = R.kindSpec('cluster').card(d, ctx({ evidence: true }));
  assert.equal(rowOf(c, 'Distance (cluster parallax)')[2], 'inferred'); assert.match(c.notes[0], /prior-dominated \(parallax S\/N < 5\)/);
  assert.ok(rowOf(c, 'Age') && rowOf(c, 'Members'));
  const cand = R.kindSpec('cluster').card(cl({}, { quality: q('candidate', undefined, 'catalogue', 'CST < 5') }), ctx());
  assert.equal(rowOf(cand, 'Quality')[1], 'candidate'); assert.match(cand.notes[0], /^Candidate/);
});

test('clusterRgb: blue when young, white near 300 Myr, warm when old, grey without an age', () => {
  const at = (g) => R.clusterRgb(cl({}, { age: q(g, 'Gyr') }));
  const [r1, , b1] = at(0.005), [r2, g2, b2] = at(0.3), [r3, , b3] = at(5);
  assert.ok(b1 > r1); assert.deepEqual([r2, g2, b2], [1, 1, 1]); assert.ok(r3 > b3);
  const mid = at(0.1); assert.ok(mid[0] > at(0.03)[0] && mid[0] < 1);
  assert.deepEqual(R.clusterRgb(cl({}, { age: undefined })), [0.9, 0.9, 0.95]);
  assert.deepEqual(R.kindSpec('cluster').color(cl()), R.clusterRgb(cl()));
});

test('units: exoplanet radii convert to AU', () => {
  assert.ok(Math.abs(R.toAu(q(1, 'Rearth')) - 6371 / M.KM_PER_AU) < 1e-15); assert.equal(R.toAu(q(1, 'Parsnip')), null);
});

test('valueWithRange is the shared card rule (scene3d-format.js): the digits the uncertainty supports, 3 figures without one', () => {
  assert.equal(R.valueWithRange({ v: 135.2, lo: 134.2, hi: 137.1 }, 'pc'), '135.2 +1.9/−1.0 pc');
  assert.equal(R.valueWithRange({ v: 134.84, lo: 134.6, hi: 135.2 }, 'pc'), '134.8 +0.4/−0.2 pc');
  assert.equal(R.valueWithRange({ v: 134.84, lo: 134.84, hi: 134.84 }, 'pc'), '135 pc');
  assert.equal(R.valueWithRange({ v: 12.4 }, 'pc'), '12.4 pc');
  assert.equal(R.fmtNum, F.fmtNum, 'one fmtNum');
});

test('a catalogue bound is shown as the bound, never as a value or n/a', async () => {
  const { kindSpec, planetLine } = await import('../js/blink/scene3d-registry.js');
  const o = { id: 'nea:x b', kind: 'exoplanet', name: 'x b', host: 'gdr3:1', parent: 'gdr3:1', evidence: 'illustrative',
    position: { model: 'orbit', host_radec: [10, 10], phase_known: false, tier: 'illustrative', src: 't',
      elements: { period_d: { v: 3, unit: 'd', src: 't', tier: 'measured' }, a_au: { v: 0.04, unit: 'au', src: 't', tier: 'catalogue' },
        e: { v: 0, src: 'assumed', tier: 'illustrative' }, i_deg: null, omega_deg: null, t_peri_mjd: null, t_conj_mjd: null, node_deg: null } },
    size: { radius: { v: '> 3.1', unit: 'Rearth', src: 'NEA pscomppars: X 2020', tier: 'measured' }, angular: null },
    props: { mass: { v: '< 0.12', unit: 'Mjup', src: 'NEA pscomppars: X 2020', tier: 'measured' } }, provenance: {}, render: {} };
  const rows = kindSpec('exoplanet').card(o, { evidence: false, fmtNum: (v) => String(v) }).rows;
  assert.deepEqual(rows.find((r) => r[0] === 'Mass').slice(0, 2), ['Mass', '< 0.12 Mj']);
  assert.deepEqual(rows.find((r) => r[0] === 'Radius').slice(0, 2), ['Radius', '> 3.1 R⊕']);
  assert.equal(planetLine(o).line, '3 d · > 3.1 R⊕ · < 0.12 Mj');
  assert.equal(kindSpec('exoplanet').frames.system(o), 'point');   // a bound is no size to draw a sphere with
});

// ====================================================================== Phase 2: nebulae and black holes
const cq = (v, unit, tier = 'catalogue', src = 'OpenNGC v20260501') => ({ v, unit, tier, src });
const nebRec = (o = {}) => ({
  id: 'ongc:NGC1976', kind: 'nebula', name: 'Orion Nebula', designations: ['M 42', 'NGC 1976', 'Sh2-281'], host: null, parent: null,
  position: { model: 'fixed', ra: 83.8186667, dec: -5.3896667, epoch: 2000, method: 'photometric', tier: 'catalogue',
    dist: { v: 400, lo: 360, hi: 440, unit: 'pc', src: 'Russeil 2003, A&A 397, 133, table3', tier: 'inferred' } },
  size: { radius: { v: 5.8, unit: 'pc', src: 'from angular size and distance', tier: 'inferred' }, angular: { major: cq(90, 'arcmin'), minor: cq(60, 'arcmin'), pa: null } },
  props: { type: cq('Cluster with nebula', undefined, 'catalogue', 'OpenNGC v20260501 (Cl+N)'), vmag: cq(4, 'mag'), bmag: cq(5, 'mag'), sh2_form: cq('irregular', undefined, 'catalogue', 'Sharpless 1959 (VII/20) Form 3') },
  in_cone: true, evidence: 'derived', render: { mag: 4 }, ...o,
});
const dirOnlyNeb = (o = {}) => nebRec({ id: 'ongc:NGC1952', name: 'Crab Nebula', designations: ['M 1', 'NGC 1952', 'Sh2-244'], evidence: 'measured',
  position: { model: 'fixed', ra: 83.633, dec: 22.014, epoch: 2000, tier: 'catalogue', dist: null }, size: { radius: null, angular: { major: cq(8, 'arcmin'), minor: cq(4, 'arcmin'), pa: null } },
  props: { type: cq('Supernova remnant') }, ...o });
const ring = () => nebRec({ id: 'ongc:NGC6720', name: 'Ring Nebula', designations: ['M 57', 'NGC 6720'], evidence: 'measured',
  position: { model: 'fixed', ra: 283.3959, dec: 33.0286, epoch: 2000, method: 'parallax', tier: 'catalogue', dist: { v: 787.65, lo: 761.41, hi: 815.77, unit: 'pc', src: 'Chornay & Walton 2021', tier: 'measured' } },
  size: { radius: { v: 0.1455, unit: 'pc', src: 'from angular size and distance', tier: 'inferred' }, angular: { major: cq(1.27, 'arcmin'), minor: null, pa: null } },
  props: { type: cq('Planetary nebula'), vmag: cq(8.8, 'mag'), central_star: cq('Gaia EDR3 2090486618786534784') } });
const row = (c, label) => c.rows.find((r) => r[0] === label);

test('Phase 2 layers: nebulae and blackHoles in group beyond, on by default, persisted like the rest', () => {
  const by = Object.fromEntries(R.layers().map((l) => [l.id, l]));
  assert.deepEqual([by.nebulae, by.blackHoles], [{ id: 'nebulae', label: 'Nebulae', group: 'beyond', on: true, parent: null }, { id: 'blackHoles', label: 'Black holes', group: 'beyond', on: true, parent: null }]);
  assert.equal(R.layerOf('nebula'), 'nebulae'); assert.equal(R.layerOf('black_hole'), 'blackHoles');
  const st = stub(); const m = R.loadLayers(st); assert.equal(m.nebulae, true); assert.equal(m.blackHoles, true);
  R.saveLayers({ ...m, nebulae: false, blackHoles: false }, st);
  const back = R.loadLayers(st); assert.deepEqual([back.nebulae, back.blackHoles, back.clusters], [false, false, true]);
  assert.deepEqual(R.beyondKinds(), ['exoplanet', 'cluster', 'nebula', 'black_hole', 'galaxy']);
});

test('nebula and black hole specs: frames, scope, picks, labels, arrival, colours', () => {
  const N = R.kindSpec('nebula'), B = R.kindSpec('black_hole');
  assert.deepEqual(N.frames, { galaxy: 'billboard' }); assert.equal(N.billboard, 'nebula'); assert.equal(R.kindSpec('cluster').billboard, undefined);
  assert.equal(N.galaxyScope, 'cone'); assert.deepEqual(N.pick, { priority: 26, marker: 17 }); assert.deepEqual(N.noun, ['nebula', 'nebulae']); assert.equal(N.go, 'fly-galaxy');
  assert.equal(N.label.max, 12);
  assert.ok(N.label.key(nebRec({ name: 'Orion Nebula' })) < N.label.key(nebRec({ name: 'NGC 6720' })), 'common names first');
  assert.ok(N.label.key(nebRec({ name: 'Orion Nebula' })) < N.label.key(nebRec({ name: 'Rosette Nebula', size: { angular: { major: cq(80, 'arcmin') } } })), 'then the larger first');
  assert.equal(N.label.key(nebRec({ name: 'Sh2-276', size: { angular: { major: cq(1200, 'arcmin') } } })), 1000 - 1200);
  assert.ok(Math.abs(N.arrivePc(nebRec()) - 3 * 400 * Math.tan(45 * Math.PI / 180 / 60)) < 1e-9); assert.equal(N.arrivePc(dirOnlyNeb()), 0);
  assert.ok(Math.abs(R.nebulaSemiMajorPc(nebRec()) - 400 * Math.tan(45 * Math.PI / 180 / 60)) < 1e-12);
  // a look per type, a marker colour per look
  const looks = ['Emission nebula', 'Reflection nebula', 'Planetary nebula', 'Supernova remnant', 'Dark nebula'].map((t) => R.nebulaLook(nebRec({ props: { type: cq(t) } })));
  assert.deepEqual(looks, ['emission', 'reflection', 'planetary', 'snr', 'dark']);
  assert.equal(new Set(looks.map((l, i) => N.color(nebRec({ props: { type: cq(['Emission nebula', 'Reflection nebula', 'Planetary nebula', 'Supernova remnant', 'Dark nebula'][i]) } })).join())).size, 5);
  assert.equal(R.rendererOf(N, 'galaxy', nebRec()), 'billboard'); assert.equal(R.rendererOf(N, 'system', nebRec()), null);
  const fixed = { host: null }, hosted = { host: 'gdr3:1' };
  assert.equal(R.rendererOf(B, 'galaxy', fixed), 'lensing'); assert.equal(R.rendererOf(B, 'system', fixed), null);
  assert.equal(R.rendererOf(B, 'system', hosted), 'lensing'); assert.equal(R.rendererOf(B, 'galaxy', hosted), 'marker');
  assert.equal(B.hosted, true); assert.deepEqual(B.noun, ['black hole', 'black holes']); assert.equal(B.galaxyScope, 'cone');
  assert.equal(B.visible({ evidence: 'illustrative' }, { evidence: true }), false); assert.equal(B.visible({ evidence: 'measured' }, { evidence: true }), true);
  assert.equal(N.visible(dirOnlyNeb(), { evidence: true }), true, 'a direction is measured: it stays in the Evidence view');
});

test('nebula card, derived and placed: rows with tiers, the Data row with the Sharpless credit, the illustrative look row', () => {
  const c = R.kindSpec('nebula').card(nebRec(), ctx({ fromYou: '350 pc · 1,140 ly' }));
  assert.equal(c.title, 'Orion Nebula'); assert.equal(c.subtitle, 'Cluster with nebula');
  assert.deepEqual(c.rows.map((r) => r[0]), ['Type', 'Distance (photometric)', 'Angular size', 'Radius (from angular size and distance)', 'Magnitude', 'Sharpless morphology', 'From you', 'Look', 'Data']);
  assert.deepEqual(row(c, 'Distance (photometric)').slice(1, 3), ['400 ± 40 pc', 'inferred']); assert.match(row(c, 'Distance (photometric)')[3], /Russeil 2003/);
  assert.deepEqual(row(c, 'Angular size').slice(1, 3), ['90′ × 60′, PA unknown', 'catalogue']);
  assert.equal(row(c, 'Radius (from angular size and distance)')[2], 'inferred'); assert.equal(row(c, 'Magnitude')[1], 'V 4 · B 5');
  assert.equal(row(c, 'Sharpless morphology')[1], 'irregular'); assert.equal(row(c, 'From you')[1], '350 pc · 1,140 ly');
  assert.deepEqual(row(c, 'Look').slice(1, 3), ['illustrative, generated from its type and size', 'illustrative']);
  assert.equal(row(c, 'Data')[1], 'OpenNGC (Mattia Verga), CC BY-SA 4.0; Sharpless 1959 via VizieR');
  assert.equal(c.notes.length, 2); assert.match(c.notes[0], /Russeil 2003/); assert.match(c.notes[1], /orientation/);
  const e = R.kindSpec('nebula').card(nebRec(), ctx({ evidence: true, fromYou: null }));
  assert.equal(row(e, 'Look'), undefined, 'the illustrative look row is dropped in the Evidence view'); assert.ok(row(e, 'Data'), 'the credit stays'); assert.ok(row(e, 'Distance (photometric)'));
});

test('nebula card, measured planetary nebula: the OpenNGC-only Data row, central star, a catalogued size with an unknown minor axis', () => {
  const c = R.kindSpec('nebula').card(ring(), ctx());
  assert.equal(row(c, 'Data')[1], 'OpenNGC (Mattia Verga), CC BY-SA 4.0');
  assert.deepEqual(row(c, 'Distance (parallax)').slice(1, 3), ['788 +28/−26 pc', 'measured']); assert.match(row(c, 'Central star')[1], /Gaia EDR3 2090486618786534784/);
  assert.equal(row(c, 'Angular size')[1], '1.27′ across, PA unknown'); assert.equal(c.notes.length, 1, 'no derived-distance note');
  assert.equal(row(R.kindSpec('nebula').card(nebRec({ id: 'sh2:276', designations: [] }), ctx()), 'Data')[1], 'OpenNGC (Mattia Verga), CC BY-SA 4.0; Sharpless 1959 via VizieR', 'a sh2: id counts');
  assert.equal(row(R.kindSpec('nebula').card(nebRec({ designations: ['M 42'], id: 'ongc:NGC1976' }), ctx()), 'Data')[1], 'OpenNGC (Mattia Verga), CC BY-SA 4.0', 'no Sh2 designation: no Sharpless credit');
  const full = R.kindSpec('nebula').card(nebRec({ props: { type: cq('Nebula') }, size: { radius: null, angular: { major: cq(90, 'arcmin'), minor: cq(60, 'arcmin'), pa: cq(30, 'deg') } } }), ctx());
  assert.equal(row(full, 'Angular size')[1], '90′ × 60′, PA 30°');
});

test('nebula card, direction only: unknown distance, no From you row even when one is passed, the notes', () => {
  const c = R.kindSpec('nebula').card(dirOnlyNeb(), ctx({ fromYou: '9,999,999 pc' }));
  assert.deepEqual(row(c, 'Distance').slice(1, 3), ['unknown · drawn on the sky as seen from the Sun', 'catalogue']); assert.equal(row(c, 'Distance')[3], 'no distance in the adopted catalogues');
  assert.equal(row(c, 'From you'), undefined); assert.equal(row(c, 'Radius (from angular size and distance)'), undefined);
  assert.match(row(c, 'Data')[1], /OpenNGC/); assert.match(row(c, 'Data')[1], /Sharpless/);
  assert.equal(c.notes[0], 'No distance is known, so it is drawn at infinity in its catalogue direction. It fades when you fly far from the Sun.');
  assert.ok(row(R.kindSpec('nebula').card(dirOnlyNeb(), ctx({ evidence: true })), 'Distance'), 'the unknown-distance row is a catalogue fact: kept in the Evidence view');
});

test('enlargementNote reads like section 17.9', () => {
  assert.equal(R.enlargementNote({ factor: 3e9, truePx: 3e-9 }), 'Drawn enlarged ×3e9: its shadow would be 3e-9 px from here.');
  assert.equal(R.enlargementNote({ factor: 1.2e5, truePx: 7.4e-5 }), 'Drawn enlarged ×1e5: its shadow would be 7e-5 px from here.');
});

const bhRec = (o = {}) => ({
  id: 'bh:Gaia BH1', kind: 'black_hole', name: 'Gaia BH1', designations: [], host: 'gdr3:4373465352415301632', parent: 'gdr3:4373465352415301632',
  position: { model: 'orbit', host_radec: [262.17, -0.58], phase_known: true, tier: 'measured', src: 'El-Badry et al. 2023, MNRAS 518, 1057, Table 1',
    elements: { period_d: q(185.59, 'd', 'measured', 'El-Badry Table 1'), a_au: q(1.4, 'au'), e: q(0.451, undefined, 'measured', 'El-Badry Table 1'), i_deg: q(126.6, 'deg', 'measured', 'El-Badry Table 1'), node_deg: q(277.8, 'deg') } },
  size: { radius: q(28.41, 'km', 'inferred', 'Schwarzschild radius from the mass (non-rotating)'), angular: null },
  props: { mass: { v: 9.62, lo: 9.44, hi: 9.8, unit: 'Msun', src: 'El-Badry 2023', tier: 'measured' }, companion_mass: q(0.93, 'Msun', 'measured'), type: q('stellar-mass', undefined, 'catalogue'), state: q('dormant: no accretion detected', undefined, 'catalogue') },
  evidence: 'measured', in_cone: true, render: { style: 'lensing' }, ...o,
});
const sgrRec = () => bhRec({ id: 'bh:Sgr A*', name: 'Sagittarius A*', host: null, parent: null,
  position: { model: 'fixed', ra: 266.4168, dec: -29.0078, epoch: 2000, method: 'orbit-fit', tier: 'measured', dist: { v: 8277, lo: 8268, hi: 8286, unit: 'pc', src: 'GRAVITY Collaboration 2022', tier: 'measured' } },
  size: { radius: q(1.269e7, 'km', 'inferred', 'Schwarzschild radius from the mass (non-rotating)'), angular: null },
  props: { mass: { v: 4297000, lo: 4285000, hi: 4309000, unit: 'Msun', src: 'GRAVITY 2022', tier: 'measured' }, type: q('supermassive', undefined, 'catalogue'), state: q('low-luminosity accretion', undefined, 'catalogue') } });

test('black hole card, fixed (Sgr A*): type, state, mass, distance, r_s inferred, the enlargement note and the illustrative look', () => {
  const c = R.kindSpec('black_hole').card(sgrRec(), ctx({ lensing: { enlarged: true, factor: 3e9, truePx: 3e-9 }, fromYou: '8,277 pc' }));
  assert.equal(c.title, 'Sagittarius A*'); assert.equal(c.subtitle, 'Black hole');
  assert.deepEqual(c.rows.map((r) => r[0]), ['Type', 'State', 'Mass', 'Distance (orbit-fit)', 'Event horizon (r_s)', 'From you', 'Look']);
  assert.deepEqual(row(c, 'Mass').slice(1, 3), ['4.297 ± 0.012 × 10⁶ M☉', 'measured']); assert.deepEqual(row(c, 'Distance (orbit-fit)').slice(1, 3), ['8,277 ± 9 pc', 'measured']);
  assert.deepEqual(row(c, 'Event horizon (r_s)').slice(1, 3), ['12,700,000 km', 'inferred']); assert.match(row(c, 'Event horizon (r_s)')[3], /Schwarzschild/);
  assert.match(row(c, 'Look')[1], /accretion disc/); assert.equal(row(c, 'Look')[2], 'illustrative');
  assert.deepEqual(c.notes, ['Drawn enlarged ×3e9: its shadow would be 3e-9 px from here.', 'The disc and ring are illustrative.']);
  const ev = R.kindSpec('black_hole').card(sgrRec(), ctx({ evidence: true })); assert.equal(row(ev, 'Look'), undefined); assert.ok(row(ev, 'Event horizon (r_s)'));
  assert.deepEqual(R.kindSpec('black_hole').card(sgrRec(), ctx()).notes, ['The disc and ring are illustrative.'], 'no enlargement note without a lensing item');
  const inMw = R.kindSpec('black_hole').card({ ...sgrRec(), parent: 'gal:milky_way' }, ctx({ parentName: 'Milky Way' }));   // section 18.8: Sgr A* names its galaxy
  assert.deepEqual(row(inMw, 'Galaxy').slice(0, 3), ['Galaxy', 'Milky Way', 'catalogue']); assert.equal(inMw.rows[2][0], 'Galaxy');
});

test('black hole card, hosted: companion distance, orbit rows with their evidence, no disc for a dormant black hole', () => {
  const host = { position: { dist: { v: 478.47, lo: 473.93, hi: 483.09, unit: 'pc', src: 'El-Badry et al. 2023, Table 1', tier: 'measured' } } };
  const c = R.kindSpec('black_hole').card(bhRec(), ctx({ hostName: 'Gaia BH1 companion', hostRecord: host, place: { sysAu: [1, 0.5, 0.2], galPc: [100, 100, 100], orbit: null } }));
  assert.deepEqual(c.rows.map((r) => r[0]), ['Type', 'State', 'Mass', 'Distance (its companion\'s)', 'Event horizon (r_s)', 'Orbital period', 'Eccentricity', 'Inclination', 'Orbit evidence', 'Companion', 'From its companion now', 'From you', 'Look']);
  assert.deepEqual(row(c, 'Distance (its companion\'s)').slice(1, 3), ['478 ± 5 pc', 'measured']);
  assert.deepEqual(row(c, 'Orbital period').slice(1, 3), ['186 d', 'measured']); assert.deepEqual(row(c, 'Eccentricity').slice(1, 3), ['0.451', 'measured']); assert.equal(row(c, 'Inclination')[1], '127°');
  assert.deepEqual(row(c, 'Orbit evidence').slice(1, 3), ['measured orbit', 'measured']); assert.match(row(c, 'Orbit evidence')[3], /El-Badry/);
  assert.equal(row(c, 'Companion')[1], 'Gaia BH1 companion · 0.93 M☉'); assert.equal(row(c, 'From its companion now')[1], '1.14 AU');
  assert.doesNotMatch(row(c, 'Look')[1], /disc/); assert.match(c.notes[c.notes.length - 1], /El-Badry/);
  // an X-ray binary: illustrative placement, assumed eccentricity, hidden rows in the Evidence view
  const x = bhRec({ evidence: 'illustrative', position: { ...bhRec().position, tier: 'illustrative', phase_known: false, elements: { period_d: q(5.6, 'd'), a_au: q(0.2, 'au', 'inferred'), e: q(0, undefined, 'illustrative', 'assumed'), i_deg: null, node_deg: null } },
    props: { ...bhRec().props, state: q('X-ray binary (accreting)', undefined, 'catalogue') } });
  const cx = R.kindSpec('black_hole').card(x, ctx({ hostName: 'HD 226868', place: { sysAu: [0.1, 0, 0], galPc: [1000, 0, 0] } }));
  assert.deepEqual(row(cx, 'Eccentricity').slice(1, 3), ['0 (assumed)', 'illustrative']); assert.equal(row(cx, 'Inclination')[2], 'illustrative');
  assert.deepEqual(row(cx, 'Orbit evidence').slice(1, 3), ['illustrative placement', 'illustrative']); assert.equal(row(cx, 'From its companion now')[2], 'illustrative');
  assert.equal(row(cx, 'Distance (its companion\'s)')[1], '1,000 pc'); assert.match(row(cx, 'Look')[1], /accretion disc/);
  assert.ok(cx.notes.some((n) => /illustrative/.test(n) && /orientation/.test(n)));
  const ev = R.kindSpec('black_hole').card(x, ctx({ evidence: true, hostName: 'HD 226868' }));
  assert.equal(row(ev, 'Eccentricity'), undefined); assert.equal(row(ev, 'Look'), undefined); assert.ok(row(ev, 'Orbital period'), 'measured period stays');
  assert.equal(R.isAccreting(x), true); assert.equal(R.isAccreting(bhRec()), false); assert.equal(R.isAccreting(sgrRec()), true);
});

test('childGroups: one heading per kind from the registry nouns, in registry order, with a line each', () => {
  const planet = exoRec(), g = R.childGroups([bhRec(), planet, bhRec({ id: 'bh:2', name: 'Two' })]);
  assert.deepEqual(g.map((x) => x.title), ['Exoplanets · 1', 'Black holes · 2']); assert.deepEqual(g.map((x) => x.kind), ['exoplanet', 'black_hole']);
  assert.equal(g[0].items[0].name, 'TRAPPIST-1 b'); assert.equal(g[1].items[0].line, '9.62 M☉ · 186 d'); assert.equal(g[1].items[0].tier, 'measured');
  assert.deepEqual(R.childGroups([]), []);
  assert.equal(R.childLine(planet).line, R.planetLine(planet).line);
});

test('the star card for a prefer_record star: the curated distance with its paper, then the Gaia single-star value as not used with the reason', () => {
  const rec = { id: 'gdr3:5870569352746779008', kind: 'star', name: 'Gaia BH2 companion',
    prefer_record: { replace: ['dist'], reason: 'The single-star Gaia solution ignores the 1,277-day orbit (RUWE 8.0), which biases its parallax.' },
    position: { model: 'fixed', ra: 1, dec: 2, dist: { v: 1164.1, lo: 1140.5, hi: 1189, unit: 'pc', src: 'El-Badry et al. 2023, Table 2: parallax 0.859 ± 0.018 mas', tier: 'measured' } },
    props: { gaia_parallax: { v: 0.6721, lo: 0.5676, hi: 0.7766, unit: 'mas', src: 'Gaia DR3 single-star solution (RUWE 8.0)', tier: 'measured' } } };
  const r = R.preferredStarDistance(rec);
  assert.ok(Math.abs(r.pc - 1164.1) < 1e-9); assert.ok(r.notUsed.pc > 1480 && r.notUsed.pc < 1495);
  const c = R.preferredDistanceRows(rec, { bjPc: 1470.2 });
  assert.deepEqual(c.rows[0], ['Distance', '1,164 +25/−24 pc', 'measured', 'El-Badry et al. 2023, Table 2: parallax 0.859 ± 0.018 mas']);
  assert.equal(c.rows[1][0], 'Gaia single-star distance · not used'); assert.equal(c.rows[1][1], 'parallax 0.672 mas → 1,490 pc · Bailer-Jones 1,470 pc'); assert.equal(c.rows[1][3], 'Gaia DR3 single-star solution (RUWE 8.0)');
  assert.equal(c.notes.length, 1); assert.match(c.notes[0], /not used: The single-star Gaia solution ignores the 1,277-day orbit/);
  assert.equal(R.evidenceRows(c.rows, true).length, 2, 'measured rows stay in the Evidence view');
  assert.equal(R.preferredDistanceRows({ ...rec, prefer_record: undefined }), null);
  assert.equal(R.preferredDistanceRows({ ...rec, props: {} }).rows[1][1], 'not used', 'no parallax on the record: the row still says it is not used');
});

test('a fixed black hole is reached by a galaxy-frame trip (go fly-galaxy, stop at arrivePc), and every interval shows the digits it supports, tight or wide', () => {
  const spec = R.kindSpec('black_hole');
  assert.equal(spec.go, 'fly-galaxy'); assert.equal(spec.arrivePc(sgrRec()), 2);
  const wide = sgrRec(); wide.position.dist = { v: 787.7, lo: 761.4, hi: 815.8, unit: 'pc', src: 'x', tier: 'measured' };
  assert.equal(row(spec.card(wide, ctx()), 'Distance (orbit-fit)')[1], '788 +28/−26 pc');
  assert.equal(row(spec.card(sgrRec(), ctx()), 'Distance (orbit-fit)')[1], '8,277 ± 9 pc');   // R0 = 8,277 ± 9 pc, not 8,280
});

// ====================================================================== Phase 3
const pcq = (v, unit, tier = 'catalogue', src = 'OpenNGC v20260501') => ({ v, unit, tier, src });
const m31 = (o = {}) => ({
  id: 'ongc:NGC0224', kind: 'galaxy', name: 'Andromeda Galaxy', designations: ['M 31'], host: null, parent: null,
  position: { model: 'fixed', ra: 10.6847917, dec: 41.2690556, epoch: 2000, method: 'cepheid', tier: 'catalogue',
    dist: { v: 0.75753, lo: 0.73485, hi: 0.78091, unit: 'Mpc', src: 'Cosmicflows-4 (Tully et al. 2023, ApJ 944, 94), table2 PGC 2557: DMceph 24.397 ± 0.066, converted by Space Maps', tier: 'measured' } },
  alt_distances: [
    { method: 'trgb', dist: { v: 0.80538, lo: 0.76913, hi: 0.84333, unit: 'Mpc', src: 'Cosmicflows-4 table2: DMtrgb 24.53 ± 0.10', tier: 'measured' }, reason: 'not used: larger uncertainty than the Cepheid distance' },
    { method: 'sbf', dist: { v: 0.69631, lo: 0.67112, hi: 0.72244, unit: 'Mpc', src: 'Cosmicflows-4 table2: DMsbf 24.214 ± 0.080', tier: 'measured' }, reason: 'not used: larger uncertainty than the Cepheid distance' }],
  size: { radius: { v: 19597, unit: 'pc', src: 'half the catalogue major axis at the adopted distance', tier: 'inferred' },
    angular: { major: pcq(177.83, 'arcmin'), minor: pcq(69.66, 'arcmin'), pa: pcq(35, 'deg') } },
  props: { type: pcq('Galaxy', ''), hubble: pcq('Sb', ''), mag_b: pcq(4.29, 'mag'), mag_v: pcq(3.44, 'mag'), surface_brightness: pcq(23.63, 'mag/arcsec2'), v_helio: pcq(-300, 'km/s'), redshift: pcq(-0.001, '') },
  provenance: { source: 'static:galaxies', dataset: 'galaxies' }, evidence: 'measured', render: { mag: 4.29 }, ...o,
});
const gctxr = (o = {}) => ({ fromYou: '757 kpc · 2.47 million ly', evidence: false, fmtNum: R.fmtNum, ...o });
const dirOnlyGal = () => m31({ id: 'ongc:IC0047', name: 'IC 47', alt_distances: undefined, position: { model: 'fixed', ra: 10.7292083, dec: -13.7407222, epoch: 2000, tier: 'catalogue', dist: null },
  size: { radius: null, angular: { major: pcq(1.5, 'arcmin'), minor: pcq(1.2, 'arcmin'), pa: null } }, props: { type: pcq('Galaxy', ''), mag_b: pcq(14, 'mag') } });

test('the galaxies layer and the galaxy kind (section 18.6.2)', () => {
  const by = Object.fromEntries(R.layers().map((l) => [l.id, l]));
  assert.deepEqual(by.galaxies, { id: 'galaxies', label: 'Galaxies', group: 'beyond', on: true, parent: null }); assert.equal(R.layerOf('galaxy'), 'galaxies');
  const s = R.kindSpec('galaxy');
  assert.deepEqual(s.noun, ['galaxy', 'galaxies']); assert.deepEqual(s.frames, { galaxy: 'billboard', cosmos: 'billboard' }); assert.equal(s.galaxyScope, 'sky'); assert.equal(s.skyFadePc, 1e5);
  assert.deepEqual(s.pick, { priority: 27, marker: 18 }); assert.equal(s.go, 'fly-galaxy'); assert.equal(s.label.max, 12);
  assert.equal(R.rendererOf(s, 'cosmos', m31()), 'billboard'); assert.equal(s.billboard(m31()), 'galaxy'); assert.equal(s.billboard({ render: { style: 'milky_way' } }), 'milky_way');
  assert.equal(R.kindSpec('nebula').skyFadePc, 800);
  assert.equal(s.arrivePc(m31()), 3 * 19597); assert.equal(s.arrivePc(dirOnlyGal()), 0);
  assert.ok(s.label.key(m31({ name: 'Andromeda Galaxy' })) < s.label.key(m31({ name: 'NGC 224' }))); assert.ok(s.label.key({ name: 'NGC 1', render: { mag: 5 } }) === 1005);
  assert.equal(s.label.key({ name: 'x', render: {}, id: 'gal:milky_way' }), 30); assert.equal(s.label.key({ name: 'Milky Way', render: { style: 'milky_way' } }), -1);
  assert.equal(R.beyondKinds().at(-1), 'galaxy');
  assert.equal(R.rendererOf(R.kindSpec('black_hole'), 'cosmos', { props: { type: { v: 'supermassive' } } }), 'lensing'); assert.equal(R.rendererOf(R.kindSpec('black_hole'), 'cosmos', { props: { type: { v: 'stellar-mass' } } }), null);
  for (const k of ['cluster', 'nebula', 'exoplanet', 'planet']) assert.equal(R.rendererOf(R.kindSpec(k), 'cosmos', {}), null, k);
});

test('galaxy card, measured distance: rows, tiers, "not used" distances, data credits', () => {
  const c = R.kindSpec('galaxy').card(m31(), gctxr()), row = (l) => c.rows.find((r) => r[0] === l);
  assert.equal(c.title, 'Andromeda Galaxy'); assert.equal(c.subtitle, 'Galaxy');
  assert.equal(row('Type')[1], 'Galaxy'); assert.equal(row('Morphology')[1], 'Sb');
  const d = c.rows.find((r) => r[0].startsWith('Distance ('));
  assert.equal(d[0], 'Distance (Cepheid variables, Cosmicflows-4)'); assert.equal(d[1], '758 ± 23 kpc'); assert.equal(d[2], 'measured');
  const alt = c.rows.filter((r) => r[0] === 'Other distances · not used');
  assert.equal(alt.length, 2); assert.match(alt[0][1], /^tip of the red-giant branch: 810 ± 40 kpc · not used: larger uncertainty than the Cepheid distance$/); assert.match(alt[1][1], /^surface-brightness fluctuations: /);
  assert.match(row('Velocity')[1], /km\/s \(heliocentric\) · z/);
  assert.equal(row('Angular size')[1], '178′ × 69.7′, PA 35°'); assert.equal(row('Diameter (from angular size and distance)')[2], 'inferred'); assert.match(row('Diameter (from angular size and distance)')[1], /^39\.2 kpc$/);
  assert.equal(row('B magnitude')[1], '4.29 mag'); assert.match(row('Surface brightness')[1], /^23\.6 mag\/arcsec²$/);
  assert.equal(row('From you')[1], '757 kpc · 2.47 million ly'); assert.equal(row('Look')[2], 'illustrative');
  assert.equal(row('Data')[1], 'OpenNGC (Mattia Verga), CC BY-SA 4.0; Cosmicflows-4 (Tully et al. 2023)');
  assert.equal(c.notes, null); assert.equal(row('Black holes · 1'), undefined);
  const ev = R.kindSpec('galaxy').card(m31(), gctxr({ evidence: true })); assert.equal(ev.rows.find((r) => r[0] === 'Look'), undefined); assert.ok(ev.rows.find((r) => r[0] === 'Data'), 'the Data row stays');
});

test('galaxy card: derived catalogue distance, Hubble flow, cluster member, UNGC without an uncertainty, direction-only', () => {
  const spec = R.kindSpec('galaxy'), withDist = (method, dist, extra = {}) => m31({ position: { ...m31().position, method, dist }, alt_distances: undefined, ...extra });
  const tf = spec.card(withDist('tully-fisher', { v: 24.1, lo: 20, hi: 28, unit: 'Mpc', src: 'Cosmicflows-4 table2: DMtf', tier: 'inferred' }), gctxr());
  assert.equal(tf.rows.find((r) => r[0].startsWith('Distance ('))[0], 'Distance (Tully–Fisher relation, Cosmicflows-4)');
  assert.match(tf.notes[0], /^A derived distance \(Tully–Fisher relation\)/);
  const hf = spec.card(withDist('redshift', { v: 47.18, lo: 42.71, hi: 51.64, unit: 'Mpc', src: 'Hubble flow: v_helio 3886 km/s (OpenNGC) → H0 = 74.6 (Cosmicflows-4)', tier: 'inferred' }, { props: { ...m31().props, v_cmb: pcq(3527.7, 'km/s', 'inferred', 'dipole') } }), gctxr());
  assert.equal(hf.notes.length, 1); assert.match(hf.notes[0], /H0 = 74\.6 km\/s\/Mpc \(Cosmicflows-4 scale\)/); assert.match(hf.notes[0], /300 km\/s/); assert.match(hf.notes[0], /Planck's 67\.4 would place it about 11 % farther\.$/);
  assert.equal(hf.rows.find((r) => r[0] === 'Velocity (CMB frame)')[2], 'inferred'); assert.match(hf.rows.find((r) => r[0].startsWith('Distance ('))[1], /^47 ± 4 Mpc$/);
  const gm = spec.card(withDist('group-member', { v: 16.2, unit: 'Mpc', src: 'the Virgo cluster, Cosmicflows-4 group 41220 (31.048 ± 0.008)', tier: 'inferred' }), gctxr());
  assert.equal(gm.notes[0], 'Placed at the distance of the Virgo cluster (Cosmicflows-4 group 41220), because its velocity mostly reflects its motion inside the cluster.');
  const ung = spec.card(m31({ id: 'ungc:And XVIII', name: 'And XVIII', position: { ...m31().position, method: 'trgb', dist: { v: 1.36, unit: 'Mpc', src: 'UNGC (Karachentsev et al. 2013, J/AJ/145/101): Dist 1.36 Mpc, TRGB; no per-galaxy error given', tier: 'measured' } }, alt_distances: undefined,
    size: { radius: null, angular: { major: pcq(1.4, 'arcmin'), minor: pcq(1.39, 'arcmin'), pa: null } } }), gctxr());
  assert.equal(ung.rows.find((r) => r[0].startsWith('Distance ('))[1], '1.36 Mpc'); assert.equal(ung.rows.find((r) => r[0].startsWith('Distance ('))[2], 'measured');
  assert.ok(ung.notes.some((n) => /no uncertainty/.test(n) && /0\.01 Mpc/.test(n))); assert.ok(ung.notes.some((n) => /no orientation/.test(n)));
  assert.equal(ung.rows.find((r) => r[0] === 'Data')[1], 'UNGC (Karachentsev et al. 2013)');
  const dn = spec.card(dirOnlyGal(), gctxr({ fromYou: null }));
  assert.equal(dn.rows.find((r) => r[0] === 'Distance')[1], 'unknown · drawn on the sky as seen from the Sun'); assert.equal(dn.rows.find((r) => r[0] === 'From you'), undefined);
  assert.equal(dn.rows.find((r) => r[0] === 'Diameter (from angular size and distance)'), undefined); assert.match(dn.notes[0], /^No distance is known/);
  const mc = spec.card(withDist('resolved-stars', { v: 26, lo: 24, hi: 28, unit: 'kpc', src: 'McConnachie 2012 (AJ 144, 4) Table 3', tier: 'measured' }), gctxr());
  assert.equal(mc.rows.find((r) => r[0].startsWith('Distance ('))[0], 'Distance (resolved stars, McConnachie 2012)'); assert.match(mc.rows.find((r) => r[0] === 'Data')[1], /McConnachie 2012$/);
  assert.equal(R.methodWord('eclipsing-binary'), 'eclipsing binaries'); assert.equal(R.methodWord('orbit-fit'), 'orbit-fit');
  for (const m of ['maser', 'sn-ia', 'sn-ii', 'supernova', 'fundamental-plane', 'horizontal-branch', 'rr-lyrae', 'cmd', 'brightest-stars', 'pnlf', 'group-member', 'eclipsing-binary', 'resolved-stars']) assert.notEqual(R.methodWord(m), m, m);
});

test('galaxy card lists its black holes from ctx.children', () => {
  const bhRec = { id: 'bh:M87*', kind: 'black_hole', name: 'M87*', props: { mass: { v: 6.52e9, lo: 5.79e9, hi: 7.25e9, unit: 'Msun', tier: 'measured', src: 't' } } };
  const c = R.kindSpec('galaxy').card(m31(), gctxr({ children: [bhRec] })), r = c.rows.find((x) => x[0] === 'Black holes · 1');
  assert.equal(r[1], 'M87* · 6.5 ± 0.7 × 10⁹ M☉'); assert.equal(r[2], 'measured');
});

test('the Milky Way card: measured rows, then the illustrative look row (dropped in the Evidence view)', () => {
  const mw = { id: 'gal:milky_way', kind: 'galaxy', name: 'Milky Way', designations: [], host: null, parent: null, size: { radius: null, angular: null }, render: { style: 'milky_way' }, evidence: 'measured',
    position: { model: 'fixed', ra: 266.4168371, dec: -29.0078106, epoch: 2000, method: 'orbit-fit', tier: 'measured', dist: { v: 8277, lo: 8268, hi: 8286, unit: 'pc', src: 'GRAVITY 2022', tier: 'measured' } },
    props: { ngp_ra: pcq(192.85948, 'deg'), ngp_dec: pcq(27.12825, 'deg'), l_node: pcq(32.93192, 'deg'), thin_disc_scale_length: { v: 2600, lo: 2100, hi: 3100, unit: 'pc', tier: 'measured', src: 't' }, thin_disc_scale_height: pcq(300, 'pc', 'measured'),
      bar_half_length: { v: 5000, lo: 4800, hi: 5200, unit: 'pc', tier: 'measured', src: 't' }, bar_angle: pcq(27, 'deg', 'measured'), sun_height: pcq(25, 'pc', 'measured'), stellar_mass: { v: 5e10, lo: 4e10, hi: 6e10, unit: 'Msun', tier: 'measured', src: 't' } } };
  const spec = R.kindSpec('galaxy'), c = spec.card(mw, gctxr()), row = (l) => c.rows.find((r) => r[0] === l);
  assert.equal(c.title, 'Milky Way'); assert.equal(c.subtitle, 'our Galaxy');
  assert.equal(row('Distance to the centre (R0)')[1], '8.277 ± 0.009 kpc'); assert.equal(row('Distance to the centre (R0)')[2], 'measured');
  assert.match(row('Plane (IAU convention)')[1], /192\.85948°, Dec \+27\.12825°; node at l = 32\.93192°/); assert.equal(row('Plane (IAU convention)')[2], 'catalogue');
  assert.equal(row('Thin disc scale length')[1], '2.6 ± 0.5 kpc'); assert.equal(row('Bar half-length')[1], '5.00 ± 0.20 kpc'); assert.equal(row('Bar angle (from the Sun–centre line)')[1], '27°');
  assert.equal(row('Sun\'s height above the midplane')[1], '25 pc');
  const measured = c.rows.filter((r) => r[2] === 'measured').length, lookAt = c.rows.findIndex((r) => r[0] === 'Look');
  assert.ok(measured >= 7); assert.ok(c.rows.slice(0, lookAt).every((r) => r[2] !== 'illustrative' || r[0] === 'From you'), 'nothing illustrative before the look row');
  assert.equal(c.rows[lookAt][2], 'illustrative'); assert.match(c.rows[lookAt][1], /generic barred spiral/);
  assert.ok(c.notes.some((n) => /same value Sgr A\*'s card shows/.test(n)));
  const ev = spec.card(mw, gctxr({ evidence: true })); assert.equal(ev.rows.find((r) => r[0] === 'Look'), undefined); assert.ok(ev.rows.find((r) => r[0] === 'Thin disc scale length'));
  assert.equal(spec.arrivePc(mw), 0);
});

test('supermassive black hole card: rescaled mass, published mass and distance not used, ring diameter, enlargement note, M31* not rescaled', () => {
  const m87 = { id: 'bh:M87*', kind: 'black_hole', name: 'M87*', host: null, parent: 'ongc:NGC4486', evidence: 'measured', render: { style: 'lensing' },
    position: { model: 'fixed', ra: 187.7059167, dec: 12.3911111, method: 'sbf', tier: 'catalogue', dist: { v: 16.858, lo: 16.55, hi: 17.171, unit: 'Mpc', src: 'the distance of its host galaxy', tier: 'measured' } },
    size: { radius: { v: 1.926e10, unit: 'km', src: 't', tier: 'inferred' }, angular: null },
    props: { type: pcq('supermassive', ''), mass: { v: 6.52e9, lo: 5.79e9, hi: 7.25e9, unit: 'Msun', src: 'EHT rescaled', tier: 'measured' },
      mass_published: { v: 6.5e9, lo: 5.77e9, hi: 7.23e9, unit: 'Msun', src: 'EHT 2019', tier: 'measured' }, dist_published: { v: 16.8, lo: 16.1, hi: 17.6, unit: 'Mpc', src: 'EHT 2019: not used', tier: 'measured' },
      ring_diameter: { v: 4.2e-5, lo: 3.9e-5, hi: 4.5e-5, unit: 'arcsec', src: 'EHT 2019 Paper I', tier: 'measured' } } };
  const spec = R.kindSpec('black_hole'), c = spec.card(m87, { fromYou: null, evidence: false, lensing: { enlarged: true, factor: 9e7, truePx: 1e-7 } }), row = (l) => c.rows.find((r) => r[0] === l);
  assert.ok(c.rows.find((r) => /^Mass \(rescaled ×1\.0035\)$/.test(r[0])), c.rows.map((r) => r[0]).join('|'));
  assert.equal(row('Published mass · not used')[1], '6.5 ± 0.7 × 10⁹ M☉'); assert.equal(row('Published distance · not used')[1], '16.8 +0.8/−0.7 Mpc');
  assert.equal(row('Ring diameter')[1], '42.0 ± 3.0 μas'); assert.equal(row("Distance (its galaxy's, surface-brightness fluctuations)")[2], 'measured'); assert.match(row("Distance (its galaxy's, surface-brightness fluctuations)")[1], / Mpc$/);
  assert.ok(c.notes.some((n) => /^Drawn enlarged ×9e\+?7/.test(n) || /Drawn enlarged/.test(n))); assert.ok(c.notes.some((n) => /rescaled by ×1\.0035/.test(n) && /16\.8 \+0\.8/.test(n)));
  const m31bh = { ...m87, id: 'bh:M31*', name: 'M31*', props: { type: pcq('supermassive', ''), mass: { v: 1.4e8, lo: 1.1e8, hi: 2.3e8, unit: 'Msun', src: 'Bender', tier: 'measured' }, mass_note: { v: 'Bender et al. 2005 do not state the distance they assumed, so the mass is shown as published and not rescaled.', src: 't', tier: 'catalogue' } } };
  const c2 = spec.card(m31bh, { fromYou: null, evidence: false });
  assert.equal(c2.rows.find((r) => r[0] === 'Mass')[1], '1.4 +0.9/−0.3 × 10⁸ M☉'); assert.ok(!c2.rows.some((r) => /not used|Ring/.test(r[0])));
  assert.ok(c2.notes.some((n) => /not rescaled/.test(n)));
  // a Phase 2 card is unchanged
  const plain = spec.card({ ...m87, props: { type: pcq('stellar-mass', ''), mass: m87.props.mass } }, { fromYou: null, evidence: false });
  assert.ok(plain.rows.find((r) => r[0] === 'Mass') && !plain.rows.some((r) => /not used|Ring/.test(r[0])));
});

test('the Gaia Data row for star cards', () => {
  assert.deepEqual(R.gaiaDataRow().slice(0, 3), ['Data', 'Gaia DR3 · Credit: ESA/Gaia/DPAC · CC BY-NC 3.0 IGO', 'catalogue']); assert.equal(R.GAIA_CREDIT, R.gaiaDataRow()[1]);
  assert.equal(R.evidenceRows([R.gaiaDataRow()], true).length, 1, 'never dropped in the Evidence view');
});
