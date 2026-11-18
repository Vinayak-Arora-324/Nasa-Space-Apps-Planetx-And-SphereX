import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectStore, visibleObjects, framePos, groupState, pickObjects, choosePick, labelCandidates, planGo, kindsPhrase } from '../js/blink/scene3d-objects.js';
import { defaultLayers, SCHEMA_MAJOR } from '../js/blink/scene3d-registry.js';
import * as F from '../js/blink/scene3d-frames.js';
import * as M from '../js/blink/scene3d-math.js';

const AU = F.AU_PER_PC;
const q = (v, unit, tier = 'measured') => ({ v, unit, src: 'test', tier });
const EARTH = [1, 0, 0];
const rec = (id, kind, name, xyz, o = {}) => ({
  id, kind, name, designations: [], host: 'ss:sun', parent: 'ss:sun',
  position: { model: 'state', mjd: 61000, xyz_au: xyz, geo: { ra: 0, dec: 0, dist_au: 1 }, method: 'ephemeris', src: 'test', tier: 'measured' },
  in_cone: false, size: kind === 'planet' || kind === 'moon' ? { radius: q(3396.2, 'km'), angular: null } : null,
  props: { dist_sun: q(Math.hypot(...xyz), 'au'), dist_earth: q(1.5, 'au') }, provenance: { source: 'test' }, evidence: 'measured', render: {}, ...o,
});
const small = (id, kind, name, xyz, o = {}) => rec(id, kind, name, xyz, { props: { class: { v: 'MB>Middle', src: 't', tier: 'catalogue' }, vmag: q(20, 'mag', 'catalogue'), dist_sun: q(2.5, 'au', 'catalogue'), dist_earth: q(2.4, 'au', 'catalogue') }, render: { mag: 20 }, ...o });
const sun = rec('ss:sun', 'sun', 'Sun', [0, 0, 0]);
const earth = rec('ss:earth', 'planet', 'Earth', EARTH);
const mars = rec('ss:mars', 'planet', 'Mars', [1.234567, -0.512345, -0.268901], { in_cone: true });
const jupiter = rec('ss:jupiter', 'planet', 'Jupiter', [-3.5, 4.4, 1.9], { in_cone: false });
const ceres = small('mp:1', 'dwarf_planet', 'Ceres', [-2.1, 1.4, 0.6], { in_cone: true });
const astIn = small('mp:2019 YB21', 'asteroid', '2019 YB21', [-2.110482, 1.402931, 0.611207], { in_cone: true });
const astOut = small('mp:99999', 'asteroid', 'Outside', [2.0, -3.0, 0.5], { in_cone: false });
const comet = small('comet:29P', 'comet', '29P/Schwassmann-Wachmann', [-5.902113, 1.331087, 1.120554], { in_cone: true });
const payload = (objects, extra = {}) => ({
  schema: 'space-maps.objects/1', query: { ra: 150, dec: 2, radius: 3, mjd: 61000, kinds: [] }, objects,
  kinds: { planet: { status: 'ok', count: 3 }, asteroid: { status: 'ok', count: 2 } }, sources: [], ...extra,
});
const ALL = [sun, earth, mars, jupiter, ceres, astIn, astOut, comet];
const store = (objs = ALL, opts) => { const s = new ObjectStore(opts); const r = s.ingest(payload(objs)); assert.ok(r.ok); return s; };
const gctx = (o = {}) => ({ layers: defaultLayers(), evidence: false, frame: 'galaxy', inHost: () => false, pxPerRad: 1000, ...o });
const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const near = (a, b, tol = 1e-9) => a.every((x, i) => Math.abs(x - b[i]) < tol);
const ids = (vis) => vis.map((e) => e.id).sort();

test('ingest accepts schema 1, keeps records by id and kind, and exposes earth, query and counts', () => {
  const s = new ObjectStore(); const r = s.ingest(payload(ALL));
  assert.deepEqual(r, { ok: true, unknownKinds: 0 });
  assert.equal(s.hasSolar, true); assert.equal(s.earth.id, 'ss:earth'); assert.equal(s.get('ss:mars').name, 'Mars');
  assert.deepEqual(s.counts(), { sun: 1, planet: 3, dwarf_planet: 1, asteroid: 2, comet: 1 });
  assert.equal(s.query.ra, 150); assert.equal(s.kindStatus.planet.status, 'ok');
  assert.equal(SCHEMA_MAJOR, 1);
});

test('a schema major of 2 is refused and the store stays empty', () => {
  const s = new ObjectStore();
  const r = s.ingest({ ...payload(ALL), schema: 'space-maps.objects/2' });
  assert.equal(r.ok, false); assert.match(r.error, /newer page/);
  assert.equal(s.recs.length, 0); assert.equal(s.hasSolar, false); assert.deepEqual(s.counts(), {});
  assert.equal(s.ingest({ objects: ALL }).ok, false);                     // no schema at all
  s.ingest(payload(ALL)); assert.equal(s.recs.length, 8);
  assert.equal(s.ingest({ ...payload(ALL), schema: 'space-maps.objects/3' }).ok, false); assert.equal(s.recs.length, 0);
});

test('unknown kinds are counted and skipped; bad records and duplicates are skipped', () => {
  const s = new ObjectStore();
  const r = s.ingest(payload([earth, { ...mars, id: 'nea:x', kind: 'exoplanet' }, { ...mars, id: undefined }, { ...mars, position: undefined }, { ...mars, kind: undefined },
    { ...earth }, { id: 'gdr3:1', kind: 'star', name: 's', position: { model: 'fixed' } }, mars]));
  assert.deepEqual(r, { ok: true, unknownKinds: 1 });
  assert.deepEqual([...s.byId.keys()].sort(), ['ss:earth', 'ss:mars']); assert.equal(s.skipped, 5);
});

test('galaxy placement: the direction from the origin is the geocentric one, the Sun marker points at minus Earth', () => {
  const s = store(), cam = F.makeCam({ pos: [0, 0, 0] });
  const vis = visibleObjects(s, gctx());
  for (const e of vis) {
    const rel = framePos(e, cam), want = unit(e.sysAu.map((v, i) => v - EARTH[i]).map((v) => v));
    if (e.id === 'ss:sun') assert.ok(near(unit(rel), [-1, 0, 0]), 'the Sun marker points at -earth');
    assert.ok(near(unit(rel), want), e.id);
    assert.ok(Math.abs(Math.hypot(...rel) * AU - Math.hypot(...e.sysAu.map((v, i) => v - EARTH[i]))) < 1e-6);
  }
  assert.equal(vis.length, 6);
});

test('scope: planets and the Sun outside the cone are markers, small bodies outside are not, Earth never is', () => {
  const vis = ids(visibleObjects(store(), gctx()));
  assert.deepEqual(vis, ['comet:29P', 'mp:1', 'mp:2019 YB21', 'ss:jupiter', 'ss:mars', 'ss:sun']);
  assert.ok(!vis.includes('ss:earth')); assert.ok(!vis.includes('mp:99999'));
  const e = visibleObjects(store(), gctx()).find((x) => x.id === 'ss:mars');
  assert.equal(e.renderer, 'marker'); assert.equal(e.spec.kind, 'planet');
});

test('from 1 pc away every placement is within 50 AU of the origin and the system collapses into a group', () => {
  const s = store(), cam = F.makeCam({ pos: [1, 0, 0] }), vis = visibleObjects(s, gctx());
  for (const e of vis) assert.ok(Math.hypot(...e.galPc) * AU < 50, e.id);
  const g = groupState(s, vis, cam, 1000);
  assert.equal(g['ss:sun'].grouped, true); assert.equal(g['ss:sun'].count, 6); assert.equal(g['ss:sun'].name, 'Solar system');
  assert.deepEqual(g['ss:sun'].byKind, { sun: 1, planet: 2, dwarf_planet: 1, asteroid: 1, comet: 1 });
  assert.deepEqual(g['ss:sun'].pcPos, [0, 0, 0]);
});

test('group threshold: maxR / dist * pxPerRad against 8 px', () => {
  const s = store(), vis = visibleObjects(s, gctx());
  const maxR = Math.max(...vis.map((e) => Math.hypot(...e.sysAu)));
  const camAt = (au) => F.makeCam({ pos: [au / AU, 0, 0] });
  const dist = maxR * 1000 / 8;                                            // exactly 8 px of spread
  assert.equal(groupState(s, vis, camAt(dist * 1.05), 1000)['ss:sun'].grouped, true);
  assert.equal(groupState(s, vis, camAt(dist * 0.95), 1000)['ss:sun'].grouped, false);
  assert.equal(groupState(s, vis, camAt(dist * 0.95), 1000, 10)['ss:sun'].grouped, true);   // a larger GROUP_PX
  assert.equal(groupState(s, vis, F.makeCam({ pos: [0, 0, 0] }), 1000)['ss:sun'].grouped, false);   // standing on the Sun
  assert.deepEqual(groupState(s, vis, F.makeCam({ frame: 'system', host: { key: 'ss:sun', pc: [0, 0, 0] }, pos: [1, 0, 0] }), 1000), {});
});

test('group counts respect layers and evidence', () => {
  const s = store(), cam = F.makeCam({ pos: [1, 0, 0] });
  const layers = { ...defaultLayers(), asteroids: false, comets: false };
  const g = groupState(s, visibleObjects(s, gctx({ layers })), cam, 1000)['ss:sun'];
  assert.equal(g.count, 4); assert.equal(g.byKind.asteroid, undefined);
  const ill = store([...ALL.slice(0, 5), { ...astIn, evidence: 'illustrative' }]);
  assert.equal(groupState(ill, visibleObjects(ill, gctx({ evidence: true })), cam, 1000)['ss:sun'].count, 4);
  assert.equal(groupState(ill, visibleObjects(ill, gctx({ evidence: false })), cam, 1000)['ss:sun'].count, 5);
});

test('a layer turned off hides its kind', () => {
  const s = store();
  const off = (id) => ids(visibleObjects(s, gctx({ layers: { ...defaultLayers(), [id]: false } })));
  assert.ok(!off('asteroids').includes('mp:2019 YB21') && off('asteroids').includes('comet:29P'));
  assert.ok(!off('comets').includes('comet:29P'));
  assert.ok(!off('dwarfPlanets').includes('mp:1'));
  assert.ok(!off('planets').includes('ss:mars') && !off('planets').includes('ss:sun'));
  assert.ok(visibleObjects(s, gctx({ layers: {} })).length === 6, 'a layer missing from the map counts as on');
});

test('the Evidence view hides illustrative records only', () => {
  const s = store([earth, mars, { ...jupiter, evidence: 'illustrative' }, { ...ceres, evidence: 'derived' }]);
  assert.deepEqual(ids(visibleObjects(s, gctx({ evidence: true }))), ['mp:1', 'ss:mars']);
  assert.deepEqual(ids(visibleObjects(s, gctx({ evidence: false }))), ['mp:1', 'ss:jupiter', 'ss:mars']);
});

test('system frame: only records of the camera host, at xyz minus the camera position', () => {
  const s = store(), host = { idx: 0, key: 'ss:sun', name: 'Sun', pc: [0, 0, 0] };
  const cam = F.makeCam({ frame: 'system', host, pos: [0.5, 0.25, -0.125] });
  const sctx = gctx({ frame: 'system', inHost: (h) => h === 'ss:sun' });
  const vis = visibleObjects(s, sctx);
  assert.deepEqual(ids(vis), ['comet:29P', 'mp:1', 'mp:2019 YB21', 'mp:99999', 'ss:earth', 'ss:jupiter', 'ss:mars']);   // the Sun is star 0 here, small bodies are not cone-filtered
  for (const e of vis) { const r = framePos(e, cam); assert.ok(near(r, e.sysAu.map((v, i) => v - cam.pos[i]), 1e-15), e.id); }
  assert.equal(vis.find((e) => e.id === 'ss:mars').renderer, 'sphere'); assert.equal(vis.find((e) => e.id === 'mp:1').renderer, 'point');
  assert.deepEqual(visibleObjects(s, gctx({ frame: 'system', inHost: () => false })), []);
});

test('placement of another host uses opts.hostPc, with none if it is unknown', () => {
  const planetB = rec('nea:b', 'planet', 'B b', [0.5, 0, 0], { host: 'hip:1' });
  const withHost = store([earth, planetB], { hostPc: (id) => (id === 'hip:1' ? [10, 20, 30] : null) });
  assert.ok(near(withHost.placement('nea:b').galPc, [10 + 0.5 / AU, 20, 30], 1e-12));
  assert.equal(store([earth, planetB]).placement('nea:b').galPc, null);
  assert.deepEqual(ids(visibleObjects(store([earth, planetB]), gctx())), []);
});

test('fixed positions place by ra, dec and distance; direction-only records get a unit vector', () => {
  const fx = (id, dist) => ({ id, kind: 'planet', name: id, host: null, position: { model: 'fixed', ra: 90, dec: 0, dist }, evidence: 'measured', props: {}, render: {} });
  const s = store([fx('t:a', { v: 2, unit: 'Mpc' }), fx('t:b', null)]);
  assert.ok(near(s.placement('t:a').galPc, [0, 2e6, 0], 1e-3));
  assert.equal(s.placement('t:b').galPc, null); assert.ok(near(s.placement('t:b').dir, [0, 1, 0], 1e-12));
});

test('pick priority: a planet beats a star beats an asteroid at the same pixel', () => {
  const s = store(), cam = F.makeCam({ pos: [0, 0, 0] });
  const project = () => [100, 100], pos = (e) => framePos(e, cam), vis = visibleObjects(s, gctx());
  const only = (pred) => vis.filter(pred);
  const star = { sel: { kind: 'star', id: 'gdr3:1', idx: 4 }, priority: 20, d: 0 };
  const pick = (v) => pickObjects(v, {}, 100, 100, 10, { project, framePos: pos });
  const ast = pick(only((e) => e.kind === 'asteroid'));
  assert.equal(ast.priority, 30);
  assert.equal(choosePick([ast, star]).sel.kind, 'star');
  const pl = pick(only((e) => e.kind === 'planet' || e.kind === 'asteroid'));
  assert.equal(pl.priority, 10); assert.equal(pl.sel.kind, 'planet');
  assert.equal(choosePick([pl, star, ast]).sel.kind, 'planet');
  assert.equal(choosePick([]), null); assert.equal(choosePick([star, { ...star, sel: { kind: 'star', id: 'b' }, d: -1 }]).sel.id, 'b');
});

test('pick: nearest wins among equals, reach widens the radius, off-screen is ignored', () => {
  const s = store(), cam = F.makeCam({ pos: [0, 0, 0] }), vis = visibleObjects(s, gctx());
  const at = { 'ss:mars': [100, 100], 'ss:jupiter': [104, 100] };
  const project = (rel) => rel.__id && at[rel.__id];
  const pos = (e) => { const r = framePos(e, cam); r.__id = e.id; return r; };
  const planets = vis.filter((e) => e.kind === 'planet');
  assert.equal(pickObjects(planets, {}, 103, 100, 10, { project, framePos: pos }).sel.id, 'ss:jupiter');
  assert.equal(pickObjects(planets, {}, 130, 100, 10, { project, framePos: pos }), null);
  assert.equal(pickObjects(planets, {}, 130, 100, 10, { project, framePos: pos, reach: (e) => (e.id === 'ss:mars' ? 40 : 0) }).sel.id, 'ss:mars');
  assert.equal(pickObjects(planets, {}, 100, 100, 10, { project: () => null, framePos: pos }), null);
});

test('a grouped host is one pick candidate with priority 10, and its members are not pickable alone', () => {
  const s = store(), cam = F.makeCam({ pos: [1, 0, 0] }), vis = visibleObjects(s, gctx()), g = groupState(s, vis, cam, 1000);
  const project = () => [50, 50], pos = (e) => F.relFromCam(cam, e.galPc);
  const hit = pickObjects(vis, g, 50, 50, 10, { project, framePos: pos });
  assert.deepEqual(hit.sel, { kind: 'group', id: 'group:ss:sun' }); assert.equal(hit.priority, 10);
});

test('labels: planets and the Sun are always labelled, small bodies at most 12, brightest first', () => {
  const many = Array.from({ length: 20 }, (_, i) => small(`mp:${1000 + i}`, 'asteroid', `Rock ${i}`, [-2, 1 + i * 0.01, 0.5], { in_cone: true, render: { mag: 25 - i * 0.5 } }));
  const s = store([sun, earth, mars, jupiter, ...many]), cam = F.makeCam({ pos: [0, 0, 0] });
  const vis = visibleObjects(s, gctx());
  const L = labelCandidates(vis, {}, { project: (r) => [r[0] * 1e5, r[1] * 1e5], framePos: (e) => framePos(e, cam) });
  assert.equal(L.filter((l) => l.key >= 100).length, 12);
  const kept = L.filter((l) => l.key >= 100).map((l) => l.text).sort();
  assert.ok(kept.includes('Rock 19') && !kept.includes('Rock 0'), 'the 12 brightest stay');
  assert.deepEqual(L.filter((l) => l.key < 100).map((l) => l.text).sort(), ['Jupiter', 'Mars', 'Sun']);
  assert.ok(L.every((l) => Number.isFinite(l.x) && Number.isFinite(l.y)));
});

test('labels: a disc over 30 px hides a planet label; the Moon sorts after planets; small bodies of every kind share the 12', () => {
  const moon = rec('ss:moon', 'moon', 'Moon', [1.002, 0, 0]);
  const s = store([earth, mars, moon, ceres, astIn, comet]), cam = F.makeCam({ pos: [0, 0, 0] }), vis = visibleObjects(s, gctx());
  const common = { project: () => [10, 10], framePos: (e) => framePos(e, cam) };
  const L = labelCandidates(vis, {}, { ...common, discPx: (e) => (e.id === 'ss:mars' ? 31 : 5) });
  assert.ok(!L.some((l) => l.text === 'Mars')); assert.equal(L.find((l) => l.text === 'Moon').key, 50);
  assert.equal(L.filter((l) => l.key >= 100).length, 3);
});

test('a grouped host gives one label, "Solar system · N", with key 5', () => {
  const s = store(), cam = F.makeCam({ pos: [1, 0, 0] }), vis = visibleObjects(s, gctx()), g = groupState(s, vis, cam, 1000);
  const L = labelCandidates(vis, g, { project: () => [20, 30], framePos: (e) => F.relFromCam(cam, e.galPc) });
  assert.deepEqual(L, [{ x: 20, y: 30, key: 5, text: 'Solar system · 6' }]);
});

test('planGo covers every branch', () => {
  const inSun = { camFrame: 'system', camHostKey: 'ss:sun' }, stars = { camFrame: 'galaxy', camHostKey: null };
  assert.deepEqual(planGo({ kind: 'star', id: 'gdr3:1' }, stars), { type: 'star' });
  assert.deepEqual(planGo(mars, inSun), { type: 'fly' });
  assert.deepEqual(planGo(mars, stars), { type: 'solar-scene' });
  assert.deepEqual(planGo(mars, { camFrame: 'system', camHostKey: 'gdr3:7' }), { type: 'solar-scene' });
  const exo = { kind: 'planet', id: 'nea:b', host: 'gdr3:7' };
  assert.deepEqual(planGo(exo, stars), { type: 'via-host', hostId: 'gdr3:7' });
  assert.deepEqual(planGo(exo, inSun), { type: 'via-host', hostId: 'gdr3:7' });
  assert.deepEqual(planGo(exo, { camFrame: 'system', camHostKey: 'gdr3:7' }), { type: 'fly' });
  assert.deepEqual(planGo({ kind: 'group', id: 'group:ss:sun' }, stars), { type: 'solar-scene' });
  assert.deepEqual(planGo({ kind: 'group', id: 'group:gdr3:7' }, stars), { type: 'via-host', hostId: 'gdr3:7' });
  assert.deepEqual(planGo({ kind: 'cluster', id: 'x', host: null }, stars), { type: 'fly-galaxy' });
  assert.deepEqual(planGo({ ...mars, host: 'sun' }, { camFrame: 'system', camHostKey: 'sun', sunId: 'sun' }), { type: 'fly' });
});

test('errorNotes groups failed kinds by message; kindsPhrase uses the registry nouns', () => {
  const s = new ObjectStore();
  s.ingest(payload([earth], { kinds: {
    planet: { status: 'ok', count: 8 }, comet: { status: 'error', error: 'SkyBoT down' }, asteroid: { status: 'error', error: 'SkyBoT down' },
    dwarf_planet: { status: 'error', error: 'SkyBoT down' }, moon: { status: 'error', error: 'ephemeris failed' }, cluster: { status: 'unavailable' } } }));
  assert.deepEqual(s.errorNotes(), [{ kinds: ['moon'], error: 'ephemeris failed' }, { kinds: ['dwarf_planet', 'asteroid', 'comet'], error: 'SkyBoT down' }]);
  assert.equal(kindsPhrase(['dwarf_planet', 'asteroid', 'comet']), 'Dwarf planets, asteroids and comets');
  assert.equal(kindsPhrase(['comet']), 'Comets'); assert.equal(kindsPhrase(['asteroid', 'comet']), 'Asteroids and comets');
  assert.equal(kindsPhrase(['cluster']), 'Clusters');
  assert.deepEqual(new ObjectStore().errorNotes(), []);
});
