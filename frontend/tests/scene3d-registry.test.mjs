import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../js/blink/scene3d-registry.js';
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
  assert.deepEqual(R.layers().map((l) => l.id), ['mw', 'cone', 'starNames', 'planets', 'orbits', 'dwarfPlanets', 'asteroids', 'comets', 'exoplanets', 'clusters', 'clusterCandidates']);
  assert.deepEqual(R.layers().map((l) => l.group), ['sky', 'sky', 'sky', 'solar', 'solar', 'solar', 'solar', 'solar', 'beyond', 'beyond', 'beyond']);
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
  assert.deepEqual(rowOf(c, 'Orbital period'), ['Orbital period', '1.51 d', 'measured', NEA + 'Agol et al. 2021']);
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
  assert.deepEqual(rowOf(c, 'Distance (cluster parallax)'), ['Distance (cluster parallax)', '135 pc (134–137)', 'measured', 'HR23']);
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

test('valueWithRange: more digits (up to 5) until lo and hi differ, else no interval', () => {
  assert.equal(R.valueWithRange({ v: 135.2, lo: 134.2, hi: 137.1 }, 'pc'), '135 pc (134–137)');
  assert.equal(R.valueWithRange({ v: 134.84, lo: 134.6, hi: 135.2 }, 'pc'), '134.8 pc (134.6–135.2)');   // 3 digits: 135 and 135
  assert.equal(R.valueWithRange({ v: 134.84, lo: 134.84, hi: 134.84 }, 'pc'), '135 pc');
  assert.equal(R.valueWithRange({ v: 12.4 }, 'pc'), '12.4 pc');
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
