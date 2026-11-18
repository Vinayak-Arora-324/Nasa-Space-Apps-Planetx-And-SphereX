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
  assert.deepEqual(R.layers().map((l) => l.id), ['mw', 'cone', 'starNames', 'planets', 'orbits', 'dwarfPlanets', 'asteroids', 'comets']);
  assert.deepEqual(R.layers().map((l) => l.group), ['sky', 'sky', 'sky', 'solar', 'solar', 'solar', 'solar', 'solar']);
  const ids = new Set(R.layers().map((l) => l.id));
  for (const s of R.kinds()) assert.ok(s.layer === null || ids.has(s.layer), `${s.kind} layer`);
  assert.equal(R.kindSpec('star').builtin, true); assert.equal(R.kindSpec('star').layer, null); assert.equal(R.kindSpec('star').pick.priority, 20);
  assert.equal(R.layerOf('comet'), 'comets'); assert.equal(R.layerOf('nope'), null); assert.equal(R.kindSpec('nope'), null);
  assert.deepEqual(R.defaultLayers(), Object.fromEntries([...ids].map((i) => [i, true])));
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
