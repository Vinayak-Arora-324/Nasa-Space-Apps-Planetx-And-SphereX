import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectStore, visibleObjects, framePos, groupState, pickObjects, choosePick, labelCandidates, planGo, kindsPhrase, groupTarget, pickPriority, billboardItems, countPhrase, capNotes, hostCountText, bpRpFromTeff, objectStarParams, starValuesFromRecord, resolveStarAliases, starSignature } from '../js/blink/scene3d-objects.js';
import { orbitPlacement } from '../js/blink/scene3d-orbits.js';
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
  const r = s.ingest(payload([earth, { ...mars, id: 'nea:x', kind: 'nebula' }, { ...mars, id: undefined }, { ...mars, position: undefined }, { ...mars, kind: undefined },
    { ...earth }, { id: 'gdr3:1', kind: 'star', name: 's', position: { model: 'fixed' } }, mars]));
  assert.deepEqual(r, { ok: true, unknownKinds: 1 });
  assert.deepEqual([...s.byId.keys()].sort(), ['ss:earth', 'ss:mars']); assert.equal(s.skipped, 4);   // star records are kept in store.stars, not skipped
  assert.deepEqual([...s.stars.keys()], ['gdr3:1']);
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

test('pick priority: in the system frame a planet beats a star beats an asteroid at the same pixel', () => {
  const s = store(), host = { key: 'ss:sun', pc: [0, 0, 0] }, scam = F.makeCam({ frame: 'system', host, pos: [0.5, 0.25, -0.125] });
  const svis = visibleObjects(s, gctx({ frame: 'system', inHost: (h) => h === 'ss:sun' }));
  const star = { sel: { kind: 'star', id: 'gdr3:1', idx: 4 }, priority: 20, d: 0 };
  const sast = pickObjects(svis.filter((e) => e.kind === 'asteroid'), {}, 100, 100, 10, { project: () => [100, 100], framePos: (e) => framePos(e, scam) });
  assert.equal(sast.priority, 30);
  assert.equal(choosePick([sast, star]).sel.kind, 'star');
});

test('pick priority: as a galaxy-frame marker an asteroid beats the cone\'s stars; planets still come first', () => {
  const s = store(), cam = F.makeCam({ pos: [0, 0, 0] });
  const project = () => [100, 100], pos = (e) => framePos(e, cam), vis = visibleObjects(s, gctx());
  const only = (pred) => vis.filter(pred);
  const star = { sel: { kind: 'star', id: 'gdr3:1', idx: 4 }, priority: 20, d: 0 };
  const pick = (v) => pickObjects(v, {}, 100, 100, 10, { project, framePos: pos });
  const ast = pick(only((e) => e.kind === 'asteroid'));
  assert.equal(ast.priority, 15);
  assert.equal(choosePick([ast, star]).sel.kind, 'asteroid');
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
  assert.equal(kindsPhrase(['cluster']), 'Star clusters');
  assert.deepEqual(new ObjectStore().errorNotes(), []);
});


// ------------------------------------------------------------------ Phase 1: hosted exoplanets, stars, clusters
const HOST = 'gdr3:2635476908753563008', HOST_PC = M.radecToXyz(346.6263919, -5.0434618, 12.43);
const exoEl = (o = {}) => ({ period_d: q(1.510826, 'd'), a_au: q(0.01154, 'au', 'catalogue'), e: q(0.00622), i_deg: q(89.728), omega_deg: q(336.86), t_conj_mjd: q(57322.014193), t_peri_mjd: null, node_deg: null, ...o });
const exo = (id, o = {}, el = {}) => ({
  id, kind: 'exoplanet', name: id.replace('nea:', ''), designations: [], host: HOST, parent: HOST,
  position: { model: 'orbit', host_radec: [346.6263919, -5.0434618], phase_known: true, tier: 'illustrative', src: 't', elements: exoEl(el) },
  in_cone: true, size: { radius: q(1.116, 'Rearth'), angular: null }, props: { mass: q(0.004, 'Mjup'), disc_method: { v: 'Transit', src: 't', tier: 'catalogue' } },
  provenance: { source: 't' }, evidence: 'illustrative', render: { mag: 17 }, ...o,
});
const trB = exo('nea:TRAPPIST-1 b'), trC = exo('nea:TRAPPIST-1 c', {}, { period_d: q(2.42, 'd'), a_au: q(0.0158, 'au', 'catalogue') });
const hostStar = (id = HOST, o = {}) => ({ id, kind: 'star', name: 'TRAPPIST-1', designations: [], same_as: ['hip:555'], host: null, parent: null,
  position: { model: 'fixed', ra: 346.6263919, dec: -5.0434618, dist: q(12.43, 'pc') }, props: {}, evidence: 'measured', render: { mag: 17 }, ...o });
const resolver = (map, pcs = {}) => ({ key: (id) => map[id] || null, pc: (k) => pcs[k] || null });
const cluster = (id, o = {}, pr = {}) => ({
  id, kind: 'cluster', name: id, designations: [], host: null, parent: null,
  position: { model: 'fixed', ra: 56.75, dec: 24.12, epoch: 2016, method: 'cluster-parallax', dist: q(135, 'pc') }, in_cone: true,
  size: { radius: q(3, 'pc', 'catalogue'), angular: { major: 6 } },
  props: { n_members: q(1000, undefined, 'catalogue'), age: q(0.1, 'Gyr', 'inferred'), quality: { v: 'reliable', tier: 'catalogue', src: 't' }, ...pr },
  evidence: 'measured', render: {}, ...o,
});
const pleiades = cluster('hr23:Pleiades');

test('orbit placement: sysAu is the orbit at query.mjd, galPc is hostPc + sysAu / AU, and placement() returns the orbit', () => {
  const s = store([earth, trB, hostStar()], { hostPc: (id) => (id === HOST ? HOST_PC : null) });
  const p = s.placement('nea:TRAPPIST-1 b'), want = orbitPlacement(trB, 61000);
  assert.deepEqual(p.sysAu, want.xyzAu); assert.equal(p.orbit.phaseSource, 'conjunction'); assert.deepEqual(p.orbit.assumed, want.assumed);
  assert.ok(near(p.galPc, HOST_PC.map((v, i) => v + p.sysAu[i] / AU), 1e-12));
  assert.equal(p.dir, null);
  const noHost = store([earth, trB]).placement('nea:TRAPPIST-1 b');
  assert.ok(noHost.sysAu && noHost.galPc === null);                                       // no host position: placed in the system, not in the galaxy
  // query.mjd missing: J2000 (MJD 51544.5)
  const s2 = new ObjectStore(); s2.ingest({ ...payload([trB]), query: { ra: 1, dec: 1, radius: 1 } });
  assert.deepEqual(s2.placement('nea:TRAPPIST-1 b').sysAu, orbitPlacement(trB, 51544.5).xyzAu);
  const bad = exo('nea:bad b', {}, { period_d: null });
  assert.equal(store([bad]).placement('nea:bad b').sysAu, null);
});

test('star records are kept in store.stars, never drawn, and never counted as skipped', () => {
  const s = store([earth, hostStar(), hostStar('hip:9'), { ...hostStar(), name: 'dup' }]);
  assert.deepEqual([...s.stars.keys()], [HOST, 'hip:9']); assert.equal(s.stars.get(HOST).name, 'TRAPPIST-1'); assert.equal(s.skipped, 1, 'only the duplicate star id');
  assert.equal(s.byId.has(HOST), false); assert.deepEqual(s.counts(), { planet: 1 });
  assert.ok(visibleObjects(s, gctx()).every((e) => e.kind !== 'star'));
});

test('setHostResolver: aliases through same_as, re-placement once hosts arrive, resolved keys on records and entries', () => {
  const alias = exo('nea:51 Peg b', { host: 'hip:555', parent: 'hip:555' });
  const s = store([earth, trB, alias, hostStar()]);
  assert.equal(s.placement(trB.id).galPc, null); assert.deepEqual(visibleObjects(s, gctx()), []);
  assert.equal(s.resolveHost(HOST), HOST);
  const key = 'star:7';
  s.setHostResolver(resolver({ [HOST]: key, 'hip:555': key, [key]: key }, { [key]: HOST_PC }));
  assert.equal(s.resolveHost('hip:555'), key); assert.equal(s.resolveHost('ss:sun'), 'ss:sun');
  assert.deepEqual(s.hostPc('hip:555'), HOST_PC); assert.deepEqual(s.hostPc(key), HOST_PC);
  const vis = visibleObjects(s, gctx());
  assert.deepEqual(ids(vis), ['nea:51 Peg b', 'nea:TRAPPIST-1 b']); for (const e of vis) { assert.equal(e.host, key); assert.equal(e.renderer, 'marker'); }
  assert.ok(near(s.placement(trB.id).galPc, HOST_PC.map((v, i) => v + s.placement(trB.id).sysAu[i] / AU), 1e-12));
  assert.deepEqual(s.childrenOf(key).map((o) => o.id).sort(), ['nea:51 Peg b', 'nea:TRAPPIST-1 b']);
  assert.equal(s.hostName(key), 'TRAPPIST-1');                                              // via the star record's id or same_as alias
  // the resolver survives a new ingest; a null result falls back to the raw id; null removes it
  s.ingest(payload([earth, trB, hostStar()]));
  assert.equal(s.placement(trB.id).galPc !== null, true);
  s.setHostResolver(resolver({}, {})); assert.equal(s.placement(trB.id).galPc, null);
  assert.deepEqual(visibleObjects(s, gctx()), []); assert.equal(s.childrenOf(HOST).length, 1);
  s.setHostResolver(null); assert.equal(s.hostPc(HOST), null);
});

test('the resolver leaves Sun-hosted records alone and opts.hostPc still works', () => {
  const s = store([earth, mars, trB], { hostPc: (id) => (id === HOST ? HOST_PC : null) });
  const before = s.placement('ss:mars');
  s.setHostResolver(resolver({}, {}));
  assert.deepEqual(s.placement('ss:mars'), before);
  assert.ok(s.placement(trB.id).galPc, 'opts.hostPc is the fallback when the resolver knows nothing');
});

test('childrenOf ignores layers and evidence, and Sun-hosted records are not children of a star', () => {
  const s = store([earth, mars, trB, trC, { ...exo('nea:x b', { evidence: 'measured' }) }]);
  s.setHostResolver(resolver({ [HOST]: 'k' }, { k: HOST_PC }));
  assert.deepEqual(s.childrenOf('k').map((o) => o.id).sort(), ['nea:TRAPPIST-1 b', 'nea:TRAPPIST-1 c', 'nea:x b']);
  assert.deepEqual(s.childrenOf('nope'), []);
  const hidden = ids(visibleObjects(s, gctx({ evidence: true, layers: { ...defaultLayers(), exoplanets: false } })));
  assert.ok(!hidden.includes('nea:TRAPPIST-1 b'));
  assert.equal(s.childrenOf('k').length, 3);
});

test('a non-Sun group needs one record; its label carries the noun and its target is the host star; the Sun keeps its label', () => {
  const s = store([earth, mars, trB]); s.setHostResolver(resolver({ [HOST]: 'k' }, { k: HOST_PC }));
  s.stars.set(HOST, hostStar());
  const cam = F.makeCam({ pos: [0, 0, 0] }), vis = visibleObjects(s, gctx()), g = groupState(s, vis, cam, 1000);
  assert.equal(g.k.grouped, true); assert.equal(g.k.count, 1); assert.equal(g.k.name, 'TRAPPIST-1'); assert.equal(g.k.kind, 'exoplanet');
  assert.deepEqual(g.k.noun, ['exoplanet', 'exoplanets']); assert.equal(g.k.label, 'TRAPPIST-1 · 1 exoplanet');
  assert.equal(g['ss:sun'].grouped, false, 'the Sun still needs two records (only Mars is here)');
  const two = store([earth, trB, trC]); two.setHostResolver(resolver({ [HOST]: 'k' }, { k: HOST_PC })); two.stars.set(HOST, hostStar());
  const g2 = groupState(two, visibleObjects(two, gctx()), cam, 1000);
  assert.equal(g2.k.label, 'TRAPPIST-1 · 2 exoplanets');
  const L = labelCandidates(visibleObjects(two, gctx()), g2, { project: () => [5, 6], framePos: (e) => F.relFromCam(cam, e.galPc) });
  assert.deepEqual(L, [{ x: 5, y: 6, key: 5, text: 'TRAPPIST-1 · 2 exoplanets' }]);
  const hit = pickObjects(visibleObjects(two, gctx()), g2, 5, 6, 10, { project: () => [5, 6], framePos: (e) => F.relFromCam(cam, e.galPc) });
  assert.deepEqual(hit.sel, { kind: 'group', id: 'group:k' });
  assert.deepEqual(groupTarget(hit.sel), { kind: 'star', id: 'k' });
  assert.deepEqual(groupTarget({ kind: 'group', id: 'group:ss:sun' }), { kind: 'group', id: 'group:ss:sun' });
  assert.deepEqual(groupTarget({ kind: 'planet', id: 'ss:mars' }), { kind: 'planet', id: 'ss:mars' });
  assert.equal(groupTarget(null), null);
  // the Sun group is unchanged: two records, count-only label; unnamed non-Sun hosts fall back to the id; mixed kinds drop the noun
  const sg = groupState(store(), visibleObjects(store(), gctx()), F.makeCam({ pos: [1, 0, 0] }), 1000)['ss:sun'];
  assert.equal(sg.label, 'Solar system · 6'); assert.equal(sg.kind, null);
  const bare = store([earth, trB]); bare.setHostResolver(resolver({}, { [HOST]: HOST_PC }));
  assert.equal(groupState(bare, visibleObjects(bare, gctx()), cam, 1000)[HOST].name, HOST);
  const mixed = store([earth, trB, exo('nea:m b', { kind: 'planet' })]); mixed.setHostResolver(resolver({}, { [HOST]: HOST_PC }));
  assert.equal(groupState(mixed, visibleObjects(mixed, gctx()), cam, 1000)[HOST].label, `${HOST} · 2`);
});

test('exoplanets are cone-only in the galaxy frame and spheres or points in the system frame by radius', () => {
  const noR = exo('nea:nr b', { size: null }), out = exo('nea:out b', { in_cone: false });
  const s = store([earth, trB, noR, out]); s.setHostResolver(resolver({}, { [HOST]: HOST_PC }));
  assert.deepEqual(ids(visibleObjects(s, gctx())), ['nea:TRAPPIST-1 b', 'nea:nr b']);
  const sys = visibleObjects(s, gctx({ frame: 'system', inHost: (h) => h === HOST }));
  assert.equal(sys.find((e) => e.id === trB.id).renderer, 'sphere'); assert.equal(sys.find((e) => e.id === noR.id).renderer, 'point');
  assert.equal(sys.length, 3, 'the system frame is not cone-filtered');
  assert.deepEqual(ids(visibleObjects(s, gctx({ evidence: true }))), [], 'illustrative records are hidden in the Evidence view');
});

test('cluster visibility gets the layers: candidates need clusterCandidates, evidence never hides measured or derived clusters', () => {
  const cand = cluster('hr23:C', {}, { quality: { v: 'candidate', tier: 'catalogue', src: 't' } }), der = cluster('hr23:D', { evidence: 'derived' });
  const s = store([earth, pleiades, cand, der]), L = defaultLayers();
  assert.deepEqual(ids(visibleObjects(s, gctx({ layers: L }))), ['hr23:D', 'hr23:Pleiades']);
  assert.deepEqual(ids(visibleObjects(s, gctx({ layers: { ...L, clusterCandidates: true } }))), ['hr23:C', 'hr23:D', 'hr23:Pleiades']);
  assert.deepEqual(ids(visibleObjects(s, gctx({ layers: { ...L, clusters: false, clusterCandidates: true } }))), []);
  assert.deepEqual(ids(visibleObjects(s, gctx({ layers: L, evidence: true }))), ['hr23:D', 'hr23:Pleiades']);
  assert.equal(visibleObjects(s, gctx({ layers: L }))[0].renderer, 'billboard');
  assert.deepEqual(visibleObjects(s, gctx({ layers: L, frame: 'system', inHost: () => true })).filter((e) => e.kind === 'cluster'), [], 'clusters are not drawn in a system frame');
  assert.ok(near(s.placement('hr23:Pleiades').galPc, M.radecToXyz(56.75, 24.12, 135), 1e-9));
  assert.deepEqual(visibleObjects(store([cluster('hr23:out', { in_cone: false })]), gctx()), []);
});

test('billboardItems: glow in the normal view, outline in the Evidence view, fades, marker-only and hollow', () => {
  const der = cluster('hr23:D', { evidence: 'derived' }), cand = cluster('hr23:C', {}, { quality: { v: 'candidate', tier: 'catalogue', src: 't' } });
  const s = store([earth, pleiades, der, cand]), L = { ...defaultLayers(), clusterCandidates: true }, vis = visibleObjects(s, gctx({ layers: L }));
  const cam = F.makeCam({ pos: [0, 0, 0] }), by = (items, id) => items.find((i) => i.id === id);
  const g = billboardItems(vis, cam, { evidence: false, pxPerRad: 1000 }), o = billboardItems(vis, cam, { evidence: true, pxPerRad: 1000 });
  assert.equal(g.length, 3);
  const p = by(g, 'hr23:Pleiades');
  assert.equal(p.mode, 'glow'); assert.equal(by(o, 'hr23:Pleiades').mode, 'outline');
  assert.equal(p.radiusUnits, 3); assert.ok(Math.abs(p.dist - 135) < 1e-9); assert.ok(near(p.rel, M.radecToXyz(56.75, 24.12, 135), 1e-9));
  assert.equal(p.fade, 1); assert.ok(Math.abs(p.pxRadius - Math.atan(3 / 135) * 1000) < 1e-9); assert.equal(p.markerOnly, false);
  assert.ok(Math.abs(p.alpha - 0.75) < 1e-12, 'log10(1000) members'); assert.equal(by(g, 'hr23:C').alpha, 0.375); assert.equal(by(g, 'hr23:C').candidate, true);
  assert.deepEqual(p.rgb.map((v) => v >= 0 && v <= 1), [true, true, true]);
  assert.equal(p.hollow, false); assert.equal(by(g, 'hr23:D').hollow, true); assert.equal(by(g, 'hr23:D').dashed, false); assert.equal(by(o, 'hr23:D').dashed, true);
  assert.equal(by(g, 'hr23:Pleiades').screen, undefined);
  assert.deepEqual(billboardItems(vis, cam, { project: () => [3, 4] })[0].screen, [3, 4]);
  // fade: smoothstep(0.5, 2, dist / r50); inside half an r50 it is 0, beyond two r50 it is 1
  const at = (d) => billboardItems(vis.filter((e) => e.id === 'hr23:Pleiades'), F.makeCam({ pos: M.radecToXyz(56.75, 24.12, 135 - d) }), { pxPerRad: 1000 })[0];
  assert.equal(at(1.4).fade, 0); assert.equal(at(6).fade, 1); assert.ok(at(4.5).fade > 0 && at(4.5).fade < 1);
  assert.equal(at(1.4).alpha, 0);
  // marker-only when the projected r50 is under 2 px
  assert.equal(billboardItems(vis, cam, { pxPerRad: 40 })[0].markerOnly, true);
  assert.equal(billboardItems(vis, F.makeCam({ frame: 'system', host: { key: 'x', pc: [0, 0, 0] }, pos: [0, 0, 0] }), { pxPerRad: 1000 }).length, 0);
  assert.deepEqual(billboardItems(visibleObjects(s, gctx({ layers: L })).filter((e) => e.kind === 'planet'), cam, {}), []);
  const lowN = cluster('hr23:L', {}, { n_members: q(10, undefined, 'catalogue') }), noN = cluster('hr23:N', {}, { n_members: undefined });
  const s2 = store([lowN, noN]), v2 = visibleObjects(s2, gctx());
  assert.ok(Math.abs(by(billboardItems(v2, cam, {}), 'hr23:L').alpha - 0.15) < 1e-12); assert.equal(by(billboardItems(v2, cam, {}), 'hr23:N').alpha, 0.3);
});

test('pick priority: a billboard is 25 until it collapses to a marker, then 16 (ahead of the 20 of stars)', () => {
  const e = visibleObjects(store([pleiades]), gctx())[0];
  assert.equal(pickPriority(e), 25); assert.equal(pickPriority({ ...e, markerOnly: true }), 16);
  const x = visibleObjects(store([earth, trB], { hostPc: () => HOST_PC }), gctx())[0]; assert.equal(pickPriority(x), 15);
});

test('countPhrase: small bodies, truncation, exoplanets, separators', () => {
  const small = ['dwarf_planet', 'asteroid', 'comet'];
  assert.equal(countPhrase(small, { dwarf_planet: 1, asteroid: 20, comet: 2 }, {}), '23 small bodies');
  assert.equal(countPhrase(small, { asteroid: 1 }, {}), '1 small body');
  assert.equal(countPhrase(small, { dwarf_planet: 1, asteroid: 1996, comet: 3 }, { asteroid: { truncated: true } }), '2,000 brightest small bodies (more in this cone)');
  assert.equal(countPhrase(['asteroid'], { asteroid: 2000 }, { asteroid: { truncated: true } }), '2,000 brightest asteroids (more in this cone)');
  assert.equal(countPhrase(['exoplanet'], { exoplanet: 2000 }, { exoplanet: { truncated: true } }), '2,000 exoplanets of the brightest hosts (more in this cone)');
  assert.equal(countPhrase(['exoplanet'], { exoplanet: 7 }, { exoplanet: { truncated: false } }), '7 exoplanets');
  assert.equal(countPhrase(['exoplanet'], { exoplanet: 1 }), '1 exoplanet');
  assert.equal(countPhrase(['cluster'], { cluster: 12 }), '12 star clusters');
  assert.equal(countPhrase(small, {}, {}), ''); assert.equal(countPhrase(['exoplanet'], { exoplanet: 12345 }), '12,345 exoplanets');
});

test('capNotes: one sentence per capped kind group, in the style of the Gaia sentence', () => {
  assert.deepEqual(capNotes({}), []); assert.deepEqual(capNotes({ asteroid: { status: 'ok', count: 5 } }), []);
  assert.deepEqual(capNotes({ asteroid: { truncated: true, count: 2000 }, comet: { truncated: true, count: 30 }, dwarf_planet: { truncated: false, count: 2 } }),
    ['Showing the 2,030 brightest small bodies in the cone; fainter ones are left out.']);
  assert.deepEqual(capNotes({ asteroid: { truncated: true, count: 2000 }, exoplanet: { truncated: true, count: 2000 }, cluster: { truncated: true, count: 500 } }), [
    'Showing the 2,000 brightest small bodies in the cone; fainter ones are left out.',
    'Showing the 2,000 exoplanets of the brightest hosts in the cone; the rest are left out.',
    'Showing 500 star clusters in the cone; more are left out.']);
});

test('hostCountText: counts with the illustrative note, the Evidence view and a layer that is off', () => {
  const s = store([earth, trB, trC]); s.setHostResolver(resolver({ [HOST]: 'k' }, { k: HOST_PC }));
  assert.equal(hostCountText(s, 'k', {}), '2 exoplanets (positions illustrative)');
  assert.equal(hostCountText(s, 'k', { evidence: true }), '2 exoplanets (positions illustrative, hidden in the Evidence view)');
  assert.equal(hostCountText(s, 'k', { layers: { exoplanets: false } }), '2 exoplanets (positions illustrative, layer off)');
  assert.equal(hostCountText(s, 'none', {}), '');
  const one = store([earth, exo('nea:z b', { evidence: 'measured' })]); one.setHostResolver(resolver({ [HOST]: 'k' }, { k: HOST_PC }));
  assert.equal(hostCountText(one, 'k'), '1 exoplanet');
});

test('planGo: an exoplanet from the galaxy frame goes via the resolved host; a cluster flies in the galaxy frame', () => {
  const s = store([earth, trB]); s.setHostResolver(resolver({ [HOST]: 'k' }, { k: HOST_PC }));
  const stars = { camFrame: 'galaxy', camHostKey: null, resolveHost: (h) => s.resolveHost(h) };
  assert.deepEqual(planGo(trB, stars), { type: 'via-host', hostId: 'k' });
  assert.deepEqual(planGo({ kind: 'exoplanet', id: trB.id, host: HOST }, { ...stars, camFrame: 'system', camHostKey: 'k' }), { type: 'fly' });
  assert.deepEqual(planGo({ kind: 'group', id: 'group:k' }, stars), { type: 'via-host', hostId: 'k' });
  assert.deepEqual(planGo(trB, { camFrame: 'galaxy', camHostKey: null }), { type: 'via-host', hostId: HOST }, 'without a resolver the raw id is used');
  assert.deepEqual(planGo(pleiades, stars), { type: 'fly-galaxy' });
  assert.deepEqual(planGo({ kind: 'cluster', id: 'x', host: null }, { ...stars, camFrame: 'system', camHostKey: 'k' }), { type: 'fly-galaxy' });
});

// ---- host stars (section 16.7)
const starRec = (id, o = {}) => ({
  id, kind: 'star', name: id, same_as: [], position: { model: 'fixed', ra: 10, dec: -20, dist: q(10, 'pc', 'measured') },
  props: { gmag: q(15, 'mag'), teff: q(5772, 'K', 'catalogue'), mass: q(0.5, 'Msun', 'catalogue') }, size: { radius: q(0.8, 'Rsun', 'catalogue') }, render: { mag: 14 }, ...o,
});

test('bpRpFromTeff is monotone, the Sun is 0.82, and a missing Teff is Sun-like', () => {
  assert.ok(Math.abs(bpRpFromTeff(5772) - 0.82) < 1e-9);
  assert.equal(bpRpFromTeff(null), 0.82); assert.equal(bpRpFromTeff(NaN), 0.82);
  let prev = Infinity;
  for (const t of [1000, 2500, 2566, 3000, 4000, 5000, 5772, 6500, 8000, 10000, 20000, 40000, 90000]) { const b = bpRpFromTeff(t); assert.ok(b <= prev, `${t}`); prev = b; }
  assert.equal(bpRpFromTeff(1000), 4.5); assert.equal(bpRpFromTeff(90000), -0.6);
});

test('objectStarParams: absolute magnitude from gmag, else vmag, else render.mag; null without a distance', () => {
  const p = objectStarParams(starRec('a'));           // G = 15 at 10 pc
  assert.ok(Math.abs(p.abs - 15) < 1e-9); assert.equal(p.d, 10); assert.equal(p.ra, 10); assert.ok(Math.abs(p.bp - 0.82) < 1e-9);
  const v = objectStarParams(starRec('b', { props: { vmag: q(12, 'mag') } }));
  assert.ok(Math.abs(v.abs - 12) < 1e-9);
  const r = objectStarParams(starRec('c', { props: {}, render: { mag: 9 } }));
  assert.ok(Math.abs(r.abs - 9) < 1e-9);
  assert.equal(objectStarParams(starRec('d', { props: {}, render: {} })).abs, 10, 'no magnitude: faint default');
  assert.equal(objectStarParams(starRec('e', { position: { model: 'fixed', ra: 1, dec: 2, dist: null } })), null);
  assert.equal(objectStarParams(starRec('f', { position: { model: 'fixed', ra: 1, dec: 2, dist: q(0, 'pc') } })), null);
  const far = objectStarParams(starRec('g', { position: { model: 'fixed', ra: 1, dec: 2, dist: q(100, 'pc') } }));
  assert.ok(Math.abs(far.abs - 10) < 1e-9, 'G = 15 at 100 pc');
});

test('starValuesFromRecord: quantities keep their tier and src, radius converts to Rsun', () => {
  const v = starValuesFromRecord(starRec('a', { size: { radius: q(1, 'Rjup', 'catalogue') } }));
  assert.equal(v.teff_k.tier, 'catalogue'); assert.equal(v.teff_k.src, 'test'); assert.equal(v.teff_k.v, 5772);
  assert.ok(Math.abs(v.radius_rsun.v - 71492 / 695700) < 1e-9); assert.equal(v.radius_rsun.src, 'test');
  assert.equal(v.mass_msun.v, 0.5); assert.deepEqual(v.dist_pc.unit, 'pc'); assert.equal(v.dist_pc.v, 10); assert.equal(v.g_mag.v, 15);
  assert.deepEqual(starValuesFromRecord(starRec('b', { props: {}, size: null, position: { model: 'fixed', ra: 1, dec: 2, dist: null } })), {});
  assert.equal(starValuesFromRecord(starRec('c', { props: { mass: q(1, 'Mjup') } })).mass_msun, undefined, 'a mass in another unit is left out');
});

test('resolveStarAliases: loaded stars absorb a record and its same_as ids; the rest are appended; no distance stays unresolved', () => {
  const loaded = new Set(['ss:sun', 'gdr3:1', 'hip:7']);
  const stars = new Map([
    ['gdr3:1', starRec('gdr3:1')],                                         // loaded as is
    ['neahost:X', starRec('neahost:X', { same_as: ['hip:7'] })],           // an alias of a loaded star
    ['neahost:Y', starRec('neahost:Y', { same_as: ['hip:99'] })],          // not loaded, has a distance: appended
    ['neahost:Z', starRec('neahost:Z', { position: { model: 'fixed', ra: 1, dec: 2, dist: null } })],   // no distance: unresolved
  ]);
  const { append, alias } = resolveStarAliases(stars, (k) => loaded.has(k));
  assert.deepEqual(append.map((r) => r.id), ['neahost:Y']);
  assert.equal(alias.get('gdr3:1'), 'gdr3:1'); assert.equal(alias.get('neahost:X'), 'hip:7'); assert.equal(alias.get('hip:7'), 'hip:7');
  assert.equal(alias.get('neahost:Y'), 'neahost:Y'); assert.equal(alias.get('hip:99'), 'neahost:Y');
  assert.equal(alias.has('neahost:Z'), false);
  // a first claim on an id wins
  const dup = resolveStarAliases(new Map([['a', starRec('a', { same_as: ['x'] })], ['b', starRec('b', { same_as: ['x'] })]]), () => false);
  assert.equal(dup.alias.get('x'), 'a'); assert.deepEqual(dup.append.map((r) => r.id), ['a', 'b']);
});

test('starSignature changes with the ids and aliases only', () => {
  const a = new Map([['a', starRec('a')], ['b', starRec('b', { same_as: ['x'] })]]);
  const sig = starSignature(a);
  assert.equal(starSignature(new Map([['a', starRec('a', { name: 'other' })], ['b', starRec('b', { same_as: ['x'] })]])), sig);
  assert.notEqual(starSignature(new Map([['a', starRec('a')]])), sig);
  assert.notEqual(starSignature(new Map([['a', starRec('a')], ['b', starRec('b', { same_as: ['y'] })]])), sig);
  assert.equal(starSignature(new Map()), '');
});
