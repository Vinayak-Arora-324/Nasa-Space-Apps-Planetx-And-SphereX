import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectStore, visibleObjects, framePos, groupState, pickObjects, choosePick, labelCandidates, planGo, kindsPhrase, groupTarget, pickPriority, billboardItems, markerPoints, markerSize, isHollowSize, mergeStarSystem, countPhrase, capNotes, hostCountText, bpRpFromTeff, objectStarParams, starValuesFromRecord, resolveStarAliases, starSignature,
  skyFade, INF_PC, MW_FADE_PC, SKY_FADE_PC, nebulaItem, lensingItems, LENS_MIN_PX, fromYouFor, visibleCounts, creditItems, creditsLine, datasetCounts,
  preferredStarDistance, preferredStarPlacement, galaxyFade, smbhVisible, withSmbh, starCreditItem, skyFadeOf,
  LENS_FLOOR_PX, lensVisible, homeMarkers, losOffsetPc } from '../js/blink/scene3d-objects.js';
import { galacticAxes } from '../js/blink/scene3d-galaxy.js';
import { preferredDistanceRows, beyondKinds } from '../js/blink/scene3d-registry.js';
import { orbitPlacement, hashUnit } from '../js/blink/scene3d-orbits.js';
import { defaultLayers, SCHEMA_MAJOR } from '../js/blink/scene3d-registry.js';
import * as F from '../js/blink/scene3d-frames.js';
import * as M from '../js/blink/scene3d-math.js';
import { starModel } from '../js/blink/scene3d-physics.js';
import { renderStarCard } from '../js/blink/scene3d-card.js';
import { motionSummary, evalMover, moverValidity } from '../js/blink/scene3d-motion.js';
import { GK } from '../js/blink/ephem.js';
import { GREY_ALPHA, greyRgb } from '../js/blink/scene3d-objects.js';

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
  const r = s.ingest(payload([earth, { ...mars, id: 'nea:x', kind: 'quasar' }, { ...mars, id: undefined }, { ...mars, position: undefined }, { ...mars, kind: undefined },
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
  // section 20.8: the group is built from every layer-on record, so an illustrative one still counts in the Evidence view (it exists; the marker takes the host's evidence)
  assert.equal(groupState(ill, visibleObjects(ill, gctx({ evidence: true })), cam, 1000)['ss:sun'].count, 5);
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
  assert.ok(Math.abs(p.alpha - 0.002 * 1000 / 9) < 1e-12, 'surface brightness 0.002 N / r50^2'); assert.ok(Math.abs(by(g, 'hr23:C').alpha - p.alpha / 2) < 1e-12); assert.equal(by(g, 'hr23:C').candidate, true);
  assert.deepEqual(p.rgb.map((v) => v >= 0 && v <= 1), [true, true, true]);
  assert.equal(p.hollow, false); assert.equal(by(g, 'hr23:D').hollow, true); assert.equal(by(g, 'hr23:D').dashed, false); assert.equal(by(o, 'hr23:D').dashed, true);
  assert.equal(by(g, 'hr23:Pleiades').screen, undefined);
  assert.deepEqual(billboardItems(vis, cam, { project: () => [3, 4] })[0].screen, [3, 4]);
  // fade: smoothstep(1.5, 4, dist / r50) on the glow only; the Evidence ring (lineAlpha) keeps full strength at any distance
  const at = (d) => billboardItems(vis.filter((e) => e.id === 'hr23:Pleiades'), F.makeCam({ pos: M.radecToXyz(56.75, 24.12, 135 - d) }), { pxPerRad: 1000 })[0];
  assert.equal(at(1.4).fade, 0); assert.equal(at(1.4).alpha, 0); assert.equal(at(12.5).fade, 1); assert.ok(at(9).fade > 0 && at(9).fade < 1);
  assert.equal(at(1.4).lineAlpha, 1); assert.equal(at(6).lineAlpha, 1); assert.equal(at(1.4).mode, 'glow');
  // marker-only when the projected r50 is under 2 px
  assert.equal(billboardItems(vis, cam, { pxPerRad: 40 })[0].markerOnly, true);
  assert.equal(billboardItems(vis, F.makeCam({ frame: 'system', host: { key: 'x', pc: [0, 0, 0] }, pos: [0, 0, 0] }), { pxPerRad: 1000 }).length, 0);
  assert.deepEqual(billboardItems(visibleObjects(s, gctx({ layers: L })).filter((e) => e.kind === 'planet'), cam, {}), []);
  const lowN = cluster('hr23:L', {}, { n_members: q(10, undefined, 'catalogue') }), noN = cluster('hr23:N', {}, { n_members: undefined });
  const s2 = store([lowN, noN]), v2 = visibleObjects(s2, gctx());
  assert.ok(Math.abs(by(billboardItems(v2, cam, {}), 'hr23:L').alpha - 0.002 * 10 / 9) < 1e-12); assert.equal(by(billboardItems(v2, cam, {}), 'hr23:N').alpha, 0.1);
  // distance-independent surface brightness: the Pleiades (N 1721, r50 2.7: ~236) is a haze, a diffuse group (194, 16.4: ~0.72) is not; capped at 1
  const pl = cluster('hr23:P', {}, { n_members: q(1721, undefined, 'catalogue') }), hsc = cluster('hr23:H', { size: { radius: q(16.38, 'pc', 'catalogue'), angular: { major: 6 } } }, { n_members: q(194, undefined, 'catalogue') });
  pl.size.radius = q(2.7, 'pc', 'catalogue');
  const v3 = billboardItems(visibleObjects(store([pl, hsc]), gctx()), cam, {});
  assert.ok(Math.abs(by(v3, 'hr23:P').alpha - 0.002 * 1721 / 7.29) < 1e-9 && by(v3, 'hr23:P').alpha > 0.4); assert.ok(by(v3, 'hr23:H').alpha < 0.002);
  assert.equal(billboardItems(visibleObjects(store([cluster('hr23:X', {}, { n_members: q(1e6, undefined, 'catalogue') })]), gctx()), cam, {})[0].alpha, 1);
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

// ------------------------------------------------------------------ slice C2: billboards, hollow markers, star-card merge, cluster trip
test('billboardItems: nearFade hides a cluster before the camera enters a star frame (no pop), lineAlpha ignores the member count', () => {
  const lowN = cluster('hr23:L', {}, { n_members: q(10, undefined, 'catalogue') });
  const vis = visibleObjects(store([lowN]), gctx()), cam = F.makeCam({ pos: [0, 0, 0] });
  const at = (nearPc) => billboardItems(vis, cam, { pxPerRad: 1000, nearPc })[0];
  assert.equal(at(Infinity).nearFade, 1); assert.equal(at(1).nearFade, 1); assert.equal(at(F.ENTER_PC).nearFade, 0); assert.equal(at(0).alpha, 0);
  assert.ok(at(2 * F.ENTER_PC).nearFade > 0 && at(2 * F.ENTER_PC).nearFade < 1);
  assert.ok(Math.abs(at(1).alpha - 0.002 * 10 / 9) < 1e-12); assert.equal(at(1).lineAlpha, 1);
  const cand = cluster('hr23:C', {}, { quality: { v: 'candidate', tier: 'catalogue', src: 't' } });
  assert.equal(billboardItems(visibleObjects(store([cand]), gctx({ layers: { ...defaultLayers(), clusterCandidates: true } })), cam, {})[0].lineAlpha, 0.5);
});

test('hollow markers are a negative size; markerPoints puts cluster centres, markers and groups into the 8-float point layout', () => {
  assert.equal(markerSize(4, true), -4); assert.equal(markerSize(4, false), 4); assert.equal(isHollowSize(-4), true); assert.equal(isHollowSize(4), false);
  const der = cluster('hr23:D', { evidence: 'derived', position: { ...pleiades.position, ra: 100 } }), cand = cluster('hr23:C', { position: { ...pleiades.position, ra: 80 } }, { quality: { v: 'candidate', tier: 'catalogue', src: 't' } });
  const s = store([earth, mars, pleiades, der, cand]), vis = visibleObjects(s, gctx({ layers: { ...defaultLayers(), clusterCandidates: true } }));
  const cam = F.makeCam({ pos: [0, 0, 0] }), items = billboardItems(vis, cam, { pxPerRad: 1000 });
  const pts = markerPoints(vis, groupState(s, vis, cam, 1000), cam, items);
  assert.equal(pts.length % 8, 0); assert.equal(pts.length / 8, 4, 'Mars marker + three cluster centres');
  const rows = []; for (let i = 0; i < pts.length; i += 8) rows.push(Array.from(pts.slice(i, i + 8)));
  const byDist = (id) => rows.find((r) => near(r.slice(0, 3), items.find((it) => it.id === id).rel, 1e-3));
  assert.equal(byDist('hr23:Pleiades')[3], 4); assert.equal(byDist('hr23:Pleiades')[4], 1);
  assert.equal(byDist('hr23:D')[3], -8, 'derived: hollow, widened to 8 px so it reads as a ring'); assert.equal(byDist('hr23:C')[3], 4); assert.equal(byDist('hr23:C')[4], 0.5, 'candidate: half alpha');
  const mk = rows.find((r) => r[3] === 5); assert.ok(mk && mk[4] === 1, 'a solid kind marker keeps size 5 and alpha 1');
  // a faded-out cluster (camera about to enter a star frame) draws no centre marker either
  assert.equal(markerPoints(vis, {}, cam, billboardItems(vis, cam, { nearPc: 0 })).length / 8, 1);
});

test('mergeStarSystem: per row the strongest tier wins, a tie keeps Gaia, notes the archive value makes false are dropped', () => {
  const sc = (v, tier, src, o = {}) => ({ v, tier, src, ...o });
  const rec = starRec('gdr3:1', { size: { radius: { v: 0.1192, unit: 'Rsun', tier: 'catalogue', src: 'NEA pscomppars: Agol et al. 2021' }, angular: null },
    props: { teff: sc(2566, 'catalogue', 'NEA pscomppars: Agol et al. 2021'), mass: { v: 0.0898, unit: 'Msun', tier: 'catalogue', src: 'NEA m' } } });
  const gaia = { values: { dist_pc: sc(12.4, 'measured', 'BJ'), teff_k: null, radius_rsun: null, mass_msun: null, age_gyr: null },
    notes: ['No effective temperature available for this star', 'FLAME mass not available for this star', 'FLAME age not available for this star'] };
  const m = mergeStarSystem(gaia, rec);
  assert.equal(m.values.teff_k.v, 2566); assert.equal(m.values.teff_k.tier, 'catalogue'); assert.match(m.values.teff_k.src, /Agol/);
  assert.equal(m.values.radius_rsun.v, 0.1192); assert.equal(m.values.mass_msun.v, 0.0898); assert.equal(m.values.dist_pc.v, 12.4, 'other rows are untouched');
  assert.deepEqual(m.notes, ['FLAME age not available for this star']);
  assert.equal(gaia.notes.length, 3, 'the input is not mutated');
  // a tie keeps Gaia's value and src; a stronger Gaia value stays; a stronger archive value replaces a weaker Gaia one
  const g2 = { values: { teff_k: sc(2500, 'catalogue', 'GSP-Phot'), radius_rsun: sc(0.2, 'measured', 'interferometry'), mass_msun: sc(0.5, 'inferred', 'x') }, notes: [] };
  const m2 = mergeStarSystem(g2, rec);
  assert.equal(m2.values.teff_k.src, 'GSP-Phot'); assert.equal(m2.values.radius_rsun.v, 0.2); assert.equal(m2.values.mass_msun.v, 0.0898);
  // no Gaia payload yet: the record's values alone; no record: the system comes back as it is
  assert.equal(mergeStarSystem(undefined, rec).values.teff_k.v, 2566); assert.deepEqual(mergeStarSystem(undefined, rec).notes, []);
  assert.equal(mergeStarSystem(gaia, null), gaia); assert.equal(mergeStarSystem(undefined, undefined), undefined);
});

test('a cluster trip: the plan is fly-galaxy and the spec stops at 2 x r50 (pc); the HUD phrase for a capped cone reads 2,003 small bodies', async () => {
  const { kindSpec } = await import('../js/blink/scene3d-registry.js');
  const spec = kindSpec('cluster');
  assert.equal(spec.go, 'fly-galaxy'); assert.equal(spec.arrivePc(pleiades), 6); assert.equal(spec.arrivePc({ size: null }), 0);
  const stars = { camFrame: 'galaxy', camHostKey: null, resolveHost: (h) => h };
  assert.deepEqual(planGo({ kind: 'cluster', id: pleiades.id, host: pleiades.host }, stars), { type: 'fly-galaxy' });
  const st = { asteroid: { count: 2000, truncated: true } };
  assert.equal(countPhrase(['dwarf_planet', 'asteroid', 'comet'], { dwarf_planet: 1, asteroid: 2000, comet: 2 }, st), '2,003 brightest small bodies (more in this cone)');
  assert.deepEqual(capNotes(st), ['Showing the 2,000 brightest small bodies in the cone; fainter ones are left out.']);
});

// ====================================================================== Phase 2: nebulae, direction-only records, black holes
const D2R = Math.PI / 180;
const dotv = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossv = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const catQ = (v, unit) => ({ v, unit, src: 't', tier: 'catalogue' });
const neb = (id, o = {}, ang = {}, pr = {}) => ({
  id, kind: 'nebula', name: id, designations: [], host: null, parent: null,
  position: { model: 'fixed', ra: 83.82, dec: -5.39, epoch: 2000, method: 'photometric', tier: 'catalogue', dist: { v: 400, lo: 360, hi: 440, unit: 'pc', src: 't', tier: 'inferred' } },
  in_cone: true, size: { radius: null, angular: { major: catQ(90, 'arcmin'), minor: catQ(60, 'arcmin'), pa: catQ(30, 'deg'), ...ang } },
  props: { type: { v: 'Emission nebula', src: 't', tier: 'catalogue' }, ...pr }, provenance: { source: 'static:nebulae', dataset: 'nebulae' }, evidence: 'derived', render: { mag: 4 }, ...o,
});
const dirNeb = (id, o = {}, ang = {}, pr = {}) => neb(id, { evidence: 'measured', position: { model: 'fixed', ra: 83.633, dec: 22.014, epoch: 2000, tier: 'catalogue', dist: null }, ...o }, ang, pr);
/** A pinhole camera at the origin of the camera-relative frame looking along `fwd` with `up`: project(rel) in px, null behind it (never clips to the screen). */
const pinhole = (fwd, up, f = 1000) => {
  const R = crossv(fwd, up);
  return (rel) => { const z = dotv(rel, fwd); return z <= 1e-12 ? null : [f * dotv(rel, R) / z, -f * dotv(rel, up) / z]; };
};
const skyNE = (ra, dec) => {   // north and east from the section 17.6.1 formulas, written out here (not through skyBasis)
  const a = ra * D2R, d = dec * D2R;
  return { N: [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)], E: [-Math.sin(a), Math.cos(a), 0], u: M.radecToXyz(ra, dec, 1) };
};
const modPi = (x) => ((x % Math.PI) + Math.PI) % Math.PI;
const angDiffPi = (a, b) => { const d = modPi(a - b); return Math.min(d, Math.PI - d); };
const nebEntry = (o, cam, opts = {}) => {
  const s = store([o]), vis = visibleObjects(s, gctx(opts));
  assert.equal(vis.length, 1); return vis[0];
};
const sunCam = F.makeCam({ pos: [0, 0, 0] });

test('direction-only records: atInfinity in the galaxy frame, never in a system frame, group markers ignore them', () => {
  const d = dirNeb('ongc:NGC1952'), p = neb('ongc:NGC1976');
  const s = store([earth, d, p]);
  assert.deepEqual(s.placement(d.id).dir, M.radecToXyz(83.633, 22.014, 1)); assert.equal(s.placement(d.id).galPc, null);
  const vis = visibleObjects(s, gctx());
  const e = vis.find((x) => x.id === d.id), pe = vis.find((x) => x.id === p.id);
  assert.equal(e.atInfinity, true); assert.equal(pe.atInfinity, undefined); assert.equal(e.renderer, 'billboard');
  assert.deepEqual(visibleObjects(s, gctx({ frame: 'system', inHost: () => true })).filter((x) => x.kind === 'nebula'), []);
  assert.deepEqual(visibleObjects(s, gctx({ layers: { ...defaultLayers(), nebulae: false } })).map((x) => x.id), []);
  assert.deepEqual(groupState(s, vis, sunCam, 1000), {});
  assert.deepEqual(visibleCounts(vis), { counts: { nebula: 2 }, direct: { nebula: 1 } });
  // cone scope still applies
  assert.equal(visibleObjects(store([{ ...d, in_cone: false }]), gctx()).length, 0);
});

test('framePos of a direction-only entry is dir x INF_PC x unitsPerPc, whatever the camera does; skyFade at 0, 800 and 5,000 pc', () => {
  const d = dirNeb('ongc:NGC1952'), e = visibleObjects(store([d]), gctx())[0], dir = M.radecToXyz(83.633, 22.014, 1);
  assert.equal(INF_PC, 1e7);
  for (const pos of [[0, 0, 0], [500, -300, 20], [1e4, 1e4, -1e4]]) assert.deepEqual(framePos(e, F.makeCam({ pos })), dir.map((v) => v * 1e7));
  assert.ok(near(framePos(e, { ...F.makeCam({ pos: [1, 2, 3] }), frame: 'system', host: { key: 'x', pc: [0, 0, 0] } }), dir.map((v) => v * 1e7 * AU), 1e-3));
  assert.equal(skyFade(F.makeCam({ pos: [0, 0, 0] })), 1);
  assert.ok(Math.abs(skyFade(F.makeCam({ pos: [800, 0, 0] })) - 0.5) < 1e-12);
  assert.ok(Math.abs(skyFade(F.makeCam({ pos: [0, 3000, 4000] })) - 1 / (1 + 39.0625)) < 1e-12);
  assert.equal(MW_FADE_PC, 800); assert.equal(SKY_FADE_PC, MW_FADE_PC);
});

test('no labels and no picks below skyFade 0.25; labels carry the fade as alpha above it; placed objects are unaffected', () => {
  const d = dirNeb('ongc:NGC1952'), p = neb('ongc:NGC1976'), vis = visibleObjects(store([d, p]), gctx());
  const project = (rel) => [100 + rel[0] * 1e-9, 100 + rel[1] * 1e-9], pos = (e) => framePos(e, sunCam);
  const lab = (sky) => labelCandidates(vis, {}, { project, framePos: pos, skyFade: sky });
  assert.deepEqual(lab(1).map((l) => l.text).sort(), ['ongc:NGC1952', 'ongc:NGC1976']);
  assert.equal(lab(1).find((l) => l.text === 'ongc:NGC1976').alpha, undefined); assert.equal(lab(0.5).find((l) => l.text === 'ongc:NGC1952').alpha, 0.5);
  assert.deepEqual(lab(0.2).map((l) => l.text), ['ongc:NGC1976']);
  const pick = (sky) => pickObjects(vis.filter((e) => e.atInfinity), {}, 100, 100, 50, { project, framePos: pos, skyFade: sky });
  assert.equal(pick(0.3).sel.id, 'ongc:NGC1952'); assert.equal(pick(0.2), null); assert.equal(pick(1).sel.kind, 'nebula');
});

test('planGo: a direction-only target turns to it; fromYouFor is null for it; placed objects keep their plans', () => {
  const d = dirNeb('ongc:NGC1952'), s = store([d, neb('ongc:NGC1976')]), e = visibleObjects(s, gctx()).find((x) => x.id === d.id);
  const dir = M.radecToXyz(83.633, 22.014, 1);
  assert.deepEqual(planGo(e, { camFrame: 'galaxy', camHostKey: null }), { type: 'look', dir });
  assert.deepEqual(planGo({ kind: 'nebula', id: d.id, host: null }, { camFrame: 'galaxy', camHostKey: null, placement: (id) => s.placement(id) }), { type: 'look', dir });
  assert.deepEqual(planGo({ kind: 'nebula', id: 'ongc:NGC1976', host: null }, { camFrame: 'galaxy', camHostKey: null, placement: (id) => s.placement(id) }), { type: 'fly-galaxy' });
  assert.equal(fromYouFor(e, [1, 2, 3], () => 'x'), null); assert.equal(fromYouFor({ id: 'a' }, [1, 2, 3], () => 'x'), 'x');
});

test('nebulaItem from the Sun: the screen ellipse is the catalogue major, minor and PA to 1e-6, for several PAs and near the pole', () => {
  const f = 1000;
  for (const [ra, dec] of [[83.82, -5.39], [10, 60], [200, 89.5], [350, -89.2]]) {
    for (const pa of [0, 30, 90, 137, 179]) {
      for (const placed of [true, false]) {
        const o = placed ? neb('ongc:T', { position: { ...neb('x').position, ra, dec } }, { major: catQ(90, 'arcmin'), minor: catQ(40, 'arcmin'), pa: catQ(pa, 'deg') })
          : dirNeb('ongc:T', { position: { model: 'fixed', ra, dec, epoch: 2000, tier: 'catalogue', dist: null } }, { major: catQ(90, 'arcmin'), minor: catQ(40, 'arcmin'), pa: catQ(pa, 'deg') });
        const { N, u } = skyNE(ra, dec), e = nebEntry(o, sunCam), it = nebulaItem(e, sunCam, { project: pinhole(u, N, f) });
        const wantMaj = f * Math.tan(45 * D2R / 60), wantMin = f * Math.tan(20 * D2R / 60);
        assert.ok(Math.abs(it.semiMajorPx / wantMaj - 1) < 1e-6, `major ${ra} ${dec} ${pa}`);
        assert.ok(Math.abs(it.semiMinorPx / wantMin - 1) < 1e-6, `minor ${ra} ${dec} ${pa}`);
        assert.ok(angDiffPi(it.angle, Math.atan2(-Math.cos(pa * D2R), -Math.sin(pa * D2R))) < 1e-6, `PA ${ra} ${dec} ${pa}`);   // north up, east left
        assert.equal(it.inside, false); assert.equal(it.atInfinity, !placed);
      }
    }
  }
});

test('nebulaItem: a placed nebula seen side-on shows its depth axis (as long as the minor semi-axis)', () => {
  const o = neb('ongc:S', {}, { major: catQ(20, 'arcmin'), minor: catQ(20, 'arcmin'), pa: catQ(0, 'deg') });
  const e = nebEntry(o, sunCam), { N, u } = skyNE(83.82, -5.39), D = Math.hypot(...e.galPc), semi = D * Math.tan(10 * D2R / 60);
  // look along the major axis (north) from 400 pc to the south: A points at the camera and vanishes, B and the depth axis are both seen
  const cam = F.makeCam({ pos: e.galPc.map((v, i) => v + 400 * N[i]) });
  const it = nebulaItem(e, cam, { project: pinhole(N.map((v) => -v), u, 1000) });
  assert.ok(Math.abs(it.semiMajorPx - 1000 * semi / 400) < 1e-6 * it.semiMajorPx, 'the larger of B and the depth axis');
  assert.ok(Math.abs(it.semiMinorPx - it.semiMajorPx) < 1e-6 * it.semiMajorPx, 'B and the depth axis have the same length: a circle');
});

test('nebulaItem: unknown minor is a circle; unknown PA uses the hashed angle in the glow and a dashed circle in the outline; no major is a marker', () => {
  const { N, u } = skyNE(83.82, -5.39), proj = pinhole(u, N);
  const noMinor = nebEntry(neb('ongc:M', {}, { minor: null }), sunCam), a = nebulaItem(noMinor, sunCam, { project: proj });
  assert.equal(a.minorUnknown, true); assert.ok(Math.abs(a.semiMajorPx - a.semiMinorPx) < 1e-9);
  const noPa = nebEntry(neb('ongc:P', {}, { pa: null }), sunCam), g = nebulaItem(noPa, sunCam, { project: proj }), ev = nebulaItem(noPa, sunCam, { project: proj, evidence: true });
  assert.equal(g.paUnknown, true); assert.equal(g.mode, 'glow'); assert.equal(g.dashed, false);
  const pa = 180 * hashUnit('ongc:P', 'pa');
  assert.ok(angDiffPi(g.angle, Math.atan2(-Math.cos(pa * D2R), -Math.sin(pa * D2R))) < 1e-6, 'the glow angle is the hashed PA');
  assert.ok(g.semiMinorPx < g.semiMajorPx * 0.7, 'the glow keeps its minor axis');
  assert.equal(ev.mode, 'outline'); assert.equal(ev.dashed, true); assert.ok(Math.abs(ev.semiMinorPx - ev.semiMajorPx) < 1e-9, 'a circle of the major radius');
  assert.ok(Math.abs(ev.semiMajorPx - 1000 * Math.tan(45 * D2R / 60)) < 1e-6);
  const solid = nebulaItem(nebEntry(neb('ongc:K', { evidence: 'measured' }), sunCam), sunCam, { project: proj, evidence: true });
  assert.equal(solid.dashed, false); assert.equal(solid.hollow, false);
  assert.equal(nebulaItem(nebEntry(neb('ongc:D'), sunCam), sunCam, { project: proj, evidence: true }).dashed, true, 'derived: hollow and dashed');
  const none = nebulaItem(nebEntry(neb('ongc:N', {}, { major: null, minor: null, pa: null }), sunCam), sunCam, { project: proj });
  assert.equal(none.markerOnly, true); assert.equal(none.alpha, 0);
  assert.equal(nebulaItem(nebEntry(neb('ongc:Q'), sunCam), sunCam, {}), null, 'project is required');
  assert.equal(a.seed, hashUnit('ongc:M', 'look'));
});

test('nebulaItem brightness: the surface-brightness mapping, the Sharpless fallback, and the fades', () => {
  const { N, u } = skyNE(83.82, -5.39), proj = pinhole(u, N);
  const at = (o, cam = sunCam, ctx = {}) => nebulaItem(nebEntry(o, cam), cam, { project: proj, ...ctx });
  const far = (extra) => neb('ongc:B', { position: { ...neb('x').position, dist: { v: 1000, unit: 'pc', src: 't', tier: 'measured' } }, render: { mag: 14.757 }, ...extra }, { major: catQ(20, 'arcmin'), minor: catQ(20, 'arcmin') });
  const sb = 14.757 + 2.5 * Math.log10(Math.PI * 100);
  assert.ok(Math.abs(sb - 21) < 1e-3);
  const mid = at(far());
  assert.ok(Math.abs(mid.alpha - 0.5 * Math.pow(10, -0.4 * (sb - 20))) < 1e-9); assert.equal(mid.fade, 1);
  assert.equal(at(far({ render: { mag: 1 } })).alpha, 0.5, 'clamped at 0.5');
  assert.equal(at(far({ render: { mag: 20 } })).alpha, 0.06, 'clamped at 0.06');
  assert.ok(Math.abs(at(far({ render: {} }, {})).alpha - 0.1) < 1e-12, 'no magnitude and no Sharpless code: 0.10');
  for (const [b, a] of [[1, 0.08], [2, 0.14], [3, 0.22]]) assert.equal(at(far({ render: {} }), sunCam, {}).alpha === 0.1 && at(neb('ongc:S' + b, { render: {} }, {}, { sh2_bright: { v: b, tier: 'catalogue', src: 't' } })).alpha, a);
  assert.equal(at(neb('ongc:S4', { render: {} }, {}, { sh2_bright: { v: 'bright', tier: 'catalogue', src: 't' } })).alpha, 0.22, 'the word form too');
  // direction-only: times skyFade (half at 800 pc); nearFade multiplies everything
  const d = dirNeb('ongc:I', { render: { mag: 1 } }), e = nebEntry(d, sunCam), cam800 = F.makeCam({ pos: [800, 0, 0] });
  assert.equal(nebulaItem(e, sunCam, { project: proj }).alpha, 0.5);
  const half = nebulaItem(e, cam800, { project: () => [0, 0] }), none = nebulaItem(e, sunCam, { project: proj, nearFade: 0.5 });
  assert.equal(half.alpha, 0.25); assert.equal(half.markerAlpha, 0.5); assert.equal(half.lineAlpha, 0.5); assert.equal(half.skyFade, 0.5);
  assert.equal(none.alpha, 0.25); assert.equal(none.markerAlpha, 0.5); assert.equal(none.lineAlpha, 0.5);
});

test('nebulaItem: markerOnly under 3 px, the glow fades out approaching a placed nebula (smoothstep(1, 3, dist / semi-major)) and inside means no glow', () => {
  const { N, u } = skyNE(83.82, -5.39), proj = pinhole(u, N);
  const ring = nebulaItem(nebEntry(neb('ongc:R', { position: { ...neb('x').position, dist: { v: 787, unit: 'pc', src: 't', tier: 'measured' } } }, { major: catQ(1.27, 'arcmin'), minor: null, pa: null }), sunCam), sunCam, { project: proj });
  assert.ok(ring.semiMajorPx < 3); assert.equal(ring.markerOnly, true);
  const big = nebulaItem(nebEntry(neb('ongc:Big'), sunCam), sunCam, { project: proj }); assert.equal(big.markerOnly, false);
  assert.ok(nebulaItem(nebEntry(neb('ongc:Edge', {}, { major: catQ(0.3, 'deg'), minor: catQ(0.3, 'deg') }), sunCam), sunCam, { project: proj }).semiMajorPx > 3 - 1e9);
  // along the line to the Sun, 2 semi-major axes from the centre: fade = smoothstep(1, 3, 2) = 0.5
  const o = neb('ongc:F', {}, { major: catQ(60, 'arcmin'), minor: catQ(30, 'arcmin'), pa: catQ(0, 'deg') }), e = nebEntry(o, sunCam);
  const D = Math.hypot(...e.galPc), semi = D * Math.tan(30 * D2R / 60), uu = e.galPc.map((v) => v / D);
  const camAt = (k) => F.makeCam({ pos: uu.map((v) => v * (D - k * semi)) });
  const proj2 = pinhole(uu, N);
  const it2 = nebulaItem(e, camAt(2), { project: proj2 });
  assert.ok(Math.abs(it2.fade - 0.5) < 1e-9); assert.ok(Math.abs(it2.alpha - 0.5 * 0.5) < 1e-9); assert.equal(it2.inside, false);   // mag 4 on a big patch: base 0.5
  assert.equal(nebulaItem(e, camAt(4), { project: proj2 }).fade, 1);
  assert.equal(nebulaItem(e, camAt(0.5), { project: proj2 }).fade, 0);
  const inside = nebulaItem(e, camAt(0), { project: proj2 });   // the camera is at the centre: the axis ends are behind or beside it
  assert.equal(inside.inside, true); assert.equal(inside.alpha, 0); assert.equal(inside.lineAlpha, 0); assert.equal(inside.semiMajorPx, null);
  // billboardItems: a nebula item needs project; the Evidence view is outline
  const vis = visibleObjects(store([o, pleiades]), gctx());
  assert.deepEqual(billboardItems(vis, sunCam, { pxPerRad: 1000 }).map((i) => i.id), ['hr23:Pleiades']);
  const items = billboardItems(vis, sunCam, { pxPerRad: 1000, project: proj, evidence: true });
  assert.deepEqual(items.map((i) => i.id).sort(), ['hr23:Pleiades', 'ongc:F']); assert.equal(items.find((i) => i.id === 'ongc:F').mode, 'outline');
  assert.equal(items.find((i) => i.id === 'hr23:Pleiades').billboard, undefined, 'cluster items are unchanged');
});

test('nebulaItem look per type, and the marker points use the nebula marker alpha', () => {
  const { N, u } = skyNE(83.82, -5.39), proj = pinhole(u, N);
  const look = (t) => nebulaItem(nebEntry(neb('ongc:L', {}, {}, { type: { v: t, tier: 'catalogue', src: 't' } }), sunCam), sunCam, { project: proj }).look;
  assert.deepEqual(['Emission nebula', 'HII region', 'Nebula', 'Cluster with nebula', 'Reflection nebula', 'Planetary nebula', 'Supernova remnant', 'Dark nebula'].map(look),
    ['emission', 'emission', 'emission', 'emission', 'reflection', 'planetary', 'snr', 'dark']);
  assert.equal(nebulaItem(nebEntry(neb('ongc:L2', { props: {} }), sunCam), sunCam, { project: proj }).look, 'emission', 'Sharpless-only regions have no type words to go on');
  const d = dirNeb('ongc:I'), vis = visibleObjects(store([d]), gctx()), cam800 = F.makeCam({ pos: [800, 0, 0] });
  const items = billboardItems(vis, cam800, { pxPerRad: 1000, project: () => [0, 0] });
  const pts = markerPoints(vis, {}, cam800, items);
  assert.equal(pts.length, 8); assert.equal(pts[4], 0.5); assert.equal(pts[3], 4);
  assert.equal(markerPoints(vis, {}, cam800, billboardItems(vis, cam800, { pxPerRad: 1000, project: () => [0, 0], nearPc: 0 })).length, 0, 'nearFade 0: no marker');
});

test('pick priority: a nebula is 26 until it is a marker, then 17; a lensing black hole is 12', () => {
  const e = visibleObjects(store([neb('ongc:P')]), gctx())[0];
  assert.equal(pickPriority(e), 26); assert.equal(pickPriority({ ...e, markerOnly: true }), 17);
});

// ---- black holes
const BH_HOST = 'gdr3:5870569352746779008';
const bhEl = (o = {}) => ({ period_d: q(1276.7, 'd'), a_au: q(4.96, 'au'), e: q(0.5176, undefined), i_deg: q(34.87, 'deg'), node_deg: q(86.9, 'deg'), omega_deg: q(130.9, 'deg'), t_peri_mjd: q(57438.3, undefined), t_conj_mjd: null, ...o });
const bh = (id, o = {}) => ({
  id, kind: 'black_hole', name: 'Gaia BH2', designations: [], host: BH_HOST, parent: BH_HOST,
  position: { model: 'orbit', host_radec: [262.17, -0.58], phase_known: true, tier: 'measured', src: 'El-Badry et al. 2023', elements: bhEl() },
  in_cone: true, size: { radius: { v: 26.4, unit: 'km', src: 'Schwarzschild radius from the mass (non-rotating)', tier: 'inferred' }, angular: null },
  props: { mass: { v: 8.94, lo: 8.6, hi: 9.28, unit: 'Msun', src: 'El-Badry 2023', tier: 'measured' }, type: { v: 'stellar-mass', src: 'curated', tier: 'catalogue' }, state: { v: 'dormant: no accretion detected', src: 't', tier: 'catalogue' } },
  provenance: { source: 'static:bh-curated', dataset: 'bh-curated' }, evidence: 'measured', render: { style: 'lensing' }, ...o,
});
const sgr = () => bh('bh:Sgr A*', { name: 'Sagittarius A*', host: null, parent: null,
  position: { model: 'fixed', ra: 266.4168371, dec: -29.0078106, epoch: 2000, method: 'orbit-fit', tier: 'measured', dist: { v: 8277, lo: 8268, hi: 8286, unit: 'pc', src: 'GRAVITY 2022', tier: 'measured' } },
  size: { radius: { v: 1.269e7, unit: 'km', src: 'Schwarzschild radius from the mass (non-rotating)', tier: 'inferred' }, angular: null },
  props: { mass: { v: 4.297e6, unit: 'Msun', src: 'GRAVITY', tier: 'measured' }, state: { v: 'low-luminosity accretion', src: 't', tier: 'catalogue' } } });
const bh2Star = (o = {}) => ({
  id: BH_HOST, kind: 'star', name: 'Gaia BH2 companion', designations: [], same_as: [], host: null, parent: null,
  prefer_record: { replace: ['dist'], reason: 'The single-star Gaia solution ignores the 1,277-day orbit (RUWE 8.0), which biases its parallax.' },
  position: { model: 'fixed', ra: 262.17, dec: -0.58, epoch: 2016, method: 'parallax', dist: { v: 1164.1, lo: 1140.5, hi: 1189.0, unit: 'pc', src: 'El-Badry et al. 2023, Table 2: parallax 0.859 ± 0.018 mas', tier: 'measured' } },
  props: { gmag: { v: 13.7, unit: 'mag', src: 'Gaia DR3', tier: 'measured' }, gaia_parallax: { v: 0.6721, lo: 0.5676, hi: 0.7766, unit: 'mas', src: 'Gaia DR3 single-star solution (RUWE 8.0)', tier: 'measured' } },
  evidence: 'measured', render: { mag: 13.7 }, ...o,
});

test('lensingItems: true size against LENS_MIN_PX, the enlargement factor, disc by state, incl 60 unless known, marker only in the Evidence view', () => {
  const s = store([sgr()]), vis = visibleObjects(s, gctx());
  assert.equal(vis.length, 1); assert.equal(vis[0].renderer, 'lensing'); assert.equal(LENS_MIN_PX, 9);
  const cam = F.makeCam({ pos: [0, 0, 0] }), [it] = lensingItems(vis, cam, { pxPerRad: 1000 });
  const rs_pc = 1.269e7 / (AU * 149597870.7), dist = Math.hypot(...vis[0].galPc);
  assert.ok(Math.abs(it.rShadow / (2.598 * rs_pc) - 1) < 1e-12); assert.ok(Math.abs(it.dist - dist) < 1e-9);
  assert.ok(Math.abs(it.truePx - Math.atan(2.598 * rs_pc / dist) * 1000) / it.truePx < 1e-9); assert.ok(it.truePx < 1e-5);
  assert.equal(it.px, 9); assert.equal(it.enlarged, true); assert.ok(Math.abs(it.factor - 9 / it.truePx) / it.factor < 1e-12);
  assert.equal(it.disc, true); assert.equal(it.incl, 60); assert.equal(it.inclAssumed, true);
  assert.equal(lensingItems(vis, cam, { evidence: true, pxPerRad: 1000 }).length, 0, 'Evidence view: marker only');
  assert.ok(markerPoints(vis, {}, cam).length === 8, 'the marker is still there');
  // big enough on screen (very close, huge pxPerRad): true size wins, not enlarged
  const closeCam = F.makeCam({ pos: vis[0].galPc.map((v) => v * (1 - 1e-12)) }), c = lensingItems(vis, closeCam, { pxPerRad: 1e9 })[0];
  assert.equal(c.enlarged, false); assert.equal(c.factor, 1); assert.equal(c.px, c.truePx); assert.ok(c.truePx > 9);
  assert.equal(lensingItems(vis, cam, { pxPerRad: 1000, project: () => [5, 6] })[0].screen.join(), '5,6');
});

test('lensing in a system frame: AU units, a dormant black hole has no disc, i_deg is used when known', () => {
  const host = bh2Star(), b = bh('bh:Gaia BH2');
  const s = store([b, host]), hostPc = M.radecToXyz(262.17, -0.58, 1164.1);
  s.setHostResolver(resolver({ [BH_HOST]: BH_HOST }, { [BH_HOST]: hostPc }));
  const cam = F.makeCam({ frame: 'system', host: { key: BH_HOST, pc: hostPc }, pos: [1, 0, 0] });
  const vis = visibleObjects(s, { layers: defaultLayers(), evidence: false, frame: 'system', inHost: (h) => h === BH_HOST });
  assert.equal(vis.length, 1); assert.equal(vis[0].renderer, 'lensing');
  const [it] = lensingItems(vis, cam, { pxPerRad: 1000 });
  assert.ok(Math.abs(it.rShadow - 2.598 * 26.4 / 149597870.7) / it.rShadow < 1e-12, 'frame units are AU');
  assert.equal(it.disc, false); assert.equal(it.incl, 34.87); assert.equal(it.inclAssumed, false);
  assert.ok(it.truePx < 1e-3 && it.enlarged);
  // a few thousand km away the shadow reaches its true size: 2.598 r_s = 68.6 km is 9 px at 7,600 km at 1000 px / rad
  const at = (km) => lensingItems(vis, F.makeCam({ ...cam, pos: [vis[0].sysAu[0] + km / 149597870.7, vis[0].sysAu[1], vis[0].sysAu[2]] }), { pxPerRad: 1000 })[0];
  assert.equal(at(5000).enlarged, false); assert.ok(Math.abs(at(5000).truePx - 1000 * Math.atan(2.598 * 26.4 / 5000)) < 1e-6); assert.equal(at(20000).enlarged, true);
});

test('hosted black holes are placed through the orbit branch, group with their host and appear in childrenOf; illustrative ones are hidden in the Evidence view', () => {
  const host = bh2Star(), good = bh('bh:Gaia BH2'), xrb = bh('bh:Cyg X-1', { name: 'Cyg X-1', evidence: 'illustrative', position: { ...good.position, tier: 'illustrative', elements: bhEl({ node_deg: null, t_peri_mjd: null }) } });
  const s = store([earth, good, xrb, host]);
  const hostPc = M.radecToXyz(262.17, -0.58, 1164.1);
  s.setHostResolver(resolver({ [BH_HOST]: BH_HOST }, { [BH_HOST]: hostPc }));
  const p = s.placement('bh:Gaia BH2'), want = orbitPlacement(good, 61000);
  assert.deepEqual(p.sysAu, want.xyzAu); assert.ok(Math.hypot(...p.sysAu) < 8, 'an orbit of a few AU'); assert.ok(near(p.galPc, hostPc.map((v, i) => v + p.sysAu[i] / AU), 1e-12));
  assert.deepEqual(s.childrenOf(BH_HOST).map((o) => o.id).sort(), ['bh:Cyg X-1', 'bh:Gaia BH2']);
  const vis = visibleObjects(s, gctx()), cam = F.makeCam({ pos: [0, 0, 0] });
  assert.deepEqual(vis.filter((e) => e.kind === 'black_hole').map((e) => e.renderer), ['marker', 'marker']);
  const g = groupState(s, vis, cam, 1000);   // both black holes are on the group, whatever their evidence (section 20.8)
  assert.equal(g[BH_HOST].grouped, true); assert.equal(g[BH_HOST].label, 'Gaia BH2 companion · 2 black holes'); assert.equal(g[BH_HOST].noun[0], 'black hole');
  assert.deepEqual(visibleObjects(s, gctx({ evidence: true })).filter((e) => e.kind === 'black_hole').map((e) => e.id), ['bh:Gaia BH2'], 'illustrative ones are hidden, exactly as exoplanets are');
  assert.equal(hostCountText(s, BH_HOST, { evidence: false, layers: {} }), '2 black holes (positions illustrative)');
  assert.equal(hostCountText(s, BH_HOST, { evidence: true, layers: {} }), '2 black holes (positions illustrative, hidden in the Evidence view)');
  assert.equal(hostCountText(s, BH_HOST, { evidence: false, layers: { blackHoles: false } }), '2 black holes (positions illustrative, layer off)');
  // planGo: a hosted black hole goes through its host
  assert.deepEqual(planGo({ kind: 'black_hole', id: 'bh:Gaia BH2', host: BH_HOST }, { camFrame: 'galaxy', camHostKey: null, resolveHost: (h) => s.resolveHost(h) }), { type: 'via-host', hostId: BH_HOST });
  assert.deepEqual(planGo(sgr(), { camFrame: 'galaxy', camHostKey: null }), { type: 'fly-galaxy' });
  // the layer
  assert.deepEqual(visibleObjects(s, gctx({ layers: { ...defaultLayers(), blackHoles: false } })).filter((e) => e.kind === 'black_hole'), []);
});

test('prefer_record: BH2\'s companion is at 1,164 pc and the single-star Gaia parallax would give 1,488 pc; no prefer_record gives null', () => {
  const d = preferredStarDistance(bh2Star());
  assert.ok(Math.abs(d.pc - 1164.1) < 1e-9 && d.lo === 1140.5 && d.hi === 1189.0 && d.tier === 'measured'); assert.match(d.src, /El-Badry/);
  assert.ok(Math.abs(d.notUsed.plxMas - 0.6721) < 1e-12); assert.ok(Math.abs(d.notUsed.pc - 1487.9) < 0.5); assert.ok(d.notUsed.pc > 1480 && d.notUsed.pc < 1495);
  assert.ok(d.notUsed.pcLo < d.notUsed.pc && d.notUsed.pc < d.notUsed.pcHi); assert.match(d.notUsed.reason, /RUWE 8/);
  assert.equal(preferredStarDistance(bh2Star({ prefer_record: undefined })), null);
  assert.equal(preferredStarDistance(bh2Star({ prefer_record: { replace: 'ra', reason: 'x' } })), null);
  assert.equal(preferredStarDistance(bh2Star({ prefer_record: { replace: ['mass'], reason: 'x' } })), null, 'dist not replaced');
  assert.equal(preferredStarDistance(bh2Star({ prefer_record: { replace: 'dist', reason: 'x' } })).pc, 1164.1, 'a bare dist string still reads as [dist]');
  assert.equal(preferredStarDistance(bh2Star({ position: { ...bh2Star().position, dist: null } })), null);
  assert.equal(preferredStarDistance(null), null);
  assert.equal(preferredStarDistance(bh2Star({ props: {} })).notUsed.pc, null);
});

test('prefer_record: only the distance changes, the Gaia direction is kept; resolveStarAliases reports the loaded keys to re-place', () => {
  const rec = bh2Star(), dir = M.radecToXyz(262.1712, -0.5811, 1);
  const bj = 1488, row = { xyz: dir.map((v) => v * bj), abs: 5 };
  const pl = preferredStarPlacement(rec, row);
  assert.equal(pl.d, 1164.1); assert.ok(near(pl.pos.map((v) => v / 1164.1), dir, 1e-12), 'the Gaia direction'); assert.ok(Math.abs(pl.gaiaPc - bj) < 1e-9);
  const G = row.abs + 5 * Math.log10(bj) - 5;
  assert.ok(Math.abs(pl.abs - (G - 5 * Math.log10(1164.1) + 5)) < 1e-12, 'the apparent G is kept'); assert.ok(pl.abs > row.abs, 'nearer, so fainter in absolute terms');
  assert.deepEqual(preferredStarPlacement(rec, { dir, d: bj, abs: 5 }).pos, pl.pos);
  assert.equal(preferredStarPlacement(bh2Star({ prefer_record: undefined }), row), null); assert.equal(preferredStarPlacement(rec, null), null);
  const stars = new Map([[BH_HOST, rec], ['gdr3:9', { ...bh2Star(), id: 'gdr3:9', prefer_record: undefined }]]);
  const r = resolveStarAliases(stars, (k) => k === BH_HOST || k === 'gdr3:9');
  assert.deepEqual([...r.prefer.keys()], [BH_HOST]); assert.equal(r.prefer.get(BH_HOST), rec); assert.deepEqual(r.append, []);
  const r2 = resolveStarAliases(new Map([[BH_HOST, rec]]), () => false);
  assert.equal(r2.prefer.size, 0); assert.deepEqual(r2.append.map((x) => x.id), [BH_HOST], 'not loaded: appended at the record\'s own distance');
});

test('the hosted black hole and its companion are at the same distance from the Sun whether or not the Gaia star is loaded', () => {
  const rec = bh2Star(), b = bh('bh:Gaia BH2'), dir = M.radecToXyz(262.17, -0.58, 1);
  const place = (hostPc) => { const s = store([earth, b, rec]); s.setHostResolver(resolver({ [BH_HOST]: BH_HOST }, { [BH_HOST]: hostPc })); return { host: Math.hypot(...hostPc), bh: Math.hypot(...s.placement('bh:Gaia BH2').galPc), sep: Math.hypot(...s.placement('bh:Gaia BH2').sysAu) / AU }; };
  const loaded = preferredStarPlacement(rec, { xyz: dir.map((v) => v * 1488), abs: 5 }).pos;   // a Gaia row at its own (Bailer-Jones) 1,488 pc, moved
  const appended = M.radecToXyz(rec.position.ra, rec.position.dec, objectStarParams(rec).d);
  const a = place(loaded), c = place(appended);
  assert.ok(Math.abs(a.host - 1164.1) < 1e-6 && Math.abs(c.host - 1164.1) < 1e-6);
  assert.ok(Math.abs(a.bh - a.host) <= a.sep + 1e-9, 'within the orbit offset'); assert.ok(Math.abs(c.bh - c.host) <= c.sep + 1e-9);
  assert.ok(Math.abs(a.bh - c.bh) < 1e-5, 'the same with or without the Gaia star');
  assert.ok(Math.abs(a.bh - 1488) > 300, 'not at the single-star distance');
});

test('credits line: only datasets that returned records in the cone and carry a credit; once per credit; errors add nothing', () => {
  const prov = (dataset, extra = {}) => ({ dataset, source: 'static:' + dataset, ...extra });
  const sources = [
    { id: 'static:nebulae', status: 'ok', count: 12, provenance: prov('nebulae', { credit: 'Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC', licence_name: 'CC BY-SA 4.0', licence: 'https://creativecommons.org/licenses/by-sa/4.0/' }) },
    { id: 'static:hr23-clusters', status: 'ok', count: 40, provenance: prov('hr23-clusters', { licence: 'https://x' }) },
    { id: 'static:galaxies', status: 'ok', count: 0, provenance: prov('galaxies', { credit: 'Galaxy credit', licence_name: 'CC BY-SA 4.0' }) },
    { id: 'static:bh-curated', status: 'ok', count: 3, provenance: prov('bh-curated') },
    { id: 'static:broken', status: 'error', error: 'boom' },
    { id: 'static:nea-exoplanets', status: 'ok', count: 5, provenance: prov('nea-exoplanets', { credit: '  ', licence_name: 'x' }) },
  ];
  assert.equal(creditsLine(sources), 'Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC · CC BY-SA 4.0');
  assert.deepEqual(creditItems(sources).map((i) => [i.dataset, i.licenceName, i.licence]), [['nebulae', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0/']]);
  assert.equal(creditsLine(sources, { nebulae: 0 }), '', 'no records in the cone');
  assert.equal(creditsLine(sources, { galaxies: 2 }), 'Galaxy credit · CC BY-SA 4.0');
  assert.equal(creditsLine(sources, { nebulae: 1, galaxies: 1 }), 'Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC · CC BY-SA 4.0 | Galaxy credit · CC BY-SA 4.0');
  assert.equal(creditsLine([], null), ''); assert.equal(creditsLine(undefined), ''); assert.equal(creditsLine([{ id: 'x', status: 'ok', count: 1, provenance: { credit: 'C' } }]), 'C');
  const dup = [sources[0], { ...sources[0], id: 'static:other', provenance: { ...sources[0].provenance, dataset: 'other' } }];
  assert.equal(creditItems(dup).length, 1);
  const s = store([earth, neb('ongc:A'), neb('ongc:B', { in_cone: false }), dirNeb('ongc:C'), bh('bh:Gaia BH2'), bh2Star({ in_cone: true, provenance: { dataset: 'bh-curated' } })]);
  assert.deepEqual(datasetCounts(s), { nebulae: 2, 'bh-curated': 2 });
  assert.equal(creditsLine(sources, datasetCounts(s)), 'Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC · CC BY-SA 4.0');
});

test('HUD: the kinds of group beyond, and the direction-only count text', () => {
  assert.deepEqual(beyondKinds(), ['exoplanet', 'cluster', 'nebula', 'black_hole', 'galaxy']);
  const kinds = beyondKinds(), counts = { nebula: 12, cluster: 1 }, direct = { nebula: 8 };
  assert.equal(countPhrase(['nebula'], counts, {}, direct), '12 nebulae (8 direction only)');
  assert.equal(countPhrase(['nebula'], counts, {}), '12 nebulae'); assert.equal(countPhrase(['cluster'], counts, {}, direct), '1 star cluster');
  assert.equal(countPhrase(['nebula'], { nebula: 1 }, {}, { nebula: 1 }), '1 nebula (1 direction only)');
  assert.equal(countPhrase(['nebula'], { nebula: 20 }, { nebula: { truncated: true } }, { nebula: 8 }), '20 nebulae (more in this cone, 8 direction only)');
  assert.equal(countPhrase(['black_hole'], { black_hole: 2 }, {}, {}), '2 black holes');
  void kinds;
});

test('star card rows for a prefer_record star are in the registry tests; the Gaia row names the parallax, its inverse and the reason', () => {
  const r = preferredDistanceRows(bh2Star(), { bjPc: 1450.3 });
  assert.equal(r.rows[0][0], 'Distance'); assert.match(r.rows[0][1], /1,16\d/); assert.equal(r.rows[0][2], 'measured'); assert.match(r.rows[0][3], /El-Badry/);
  assert.equal(r.rows[1][0], 'Gaia single-star distance · not used'); assert.match(r.rows[1][1], /0\.672 mas → 1,490 pc/); assert.match(r.rows[1][1], /Bailer-Jones 1,450 pc/);
  assert.match(r.notes[0], /RUWE 8\.0/); assert.equal(preferredDistanceRows(bh2Star({ prefer_record: undefined })), null);
});

// ---- prefer_record stellar parameters (section 17.8, 17.18 follow-up): the papers' values, not Gaia's single-star ones
const bh2Paper = (o = {}) => bh2Star({
  prefer_record: { replace: ['dist', 'mass', 'radius', 'teff'], reason: bh2Star().prefer_record.reason },
  size: { radius: { v: 7.77, lo: 7.52, hi: 8.02, unit: 'Rsun', src: 'El-Badry et al. 2023, MNRAS 521, 4323, Table 2 (red giant)', tier: 'catalogue' }, angular: null },
  props: { ...bh2Star().props,
    teff: { v: 4604, lo: 4517, hi: 4691, unit: 'K', src: 'El-Badry et al. 2023, MNRAS 521, 4323, Table 2 (red giant)', tier: 'catalogue' },
    mass: { v: 1.07, lo: 0.88, hi: 1.26, unit: 'Msun', src: 'El-Badry et al. 2023, MNRAS 521, 4323, Table 2 (red giant)', tier: 'catalogue' } }, ...o });
// a Gaia /api/system payload shaped like the BH2 companion's: FLAME's single-star mass is 2.60 (flagged); the other values are test inputs
const bh2Gaia = () => ({ values: {
  dist_pc: { v: 1488, src: 'Bailer-Jones 2021 (geometric)', tier: 'measured' },
  teff_k: { v: 4700, lo: 4650, hi: 4750, src: 'Gaia DR3 GSP-Phot', tier: 'catalogue' },
  radius_rsun: { v: 9.4, lo: 9.1, hi: 9.7, src: 'Gaia DR3 FLAME', tier: 'catalogue' },
  lum_lsun: { v: 37, lo: 35, hi: 39, src: 'Gaia DR3 FLAME', tier: 'catalogue' },
  mass_msun: { v: 2.6, lo: 2.3, hi: 2.9, src: 'Gaia DR3 FLAME', tier: 'catalogue' },
  age_gyr: { v: 0.8, src: 'Gaia DR3 FLAME', tier: 'catalogue' } },
  notes: ['FLAME quality flags set (1): treat radius, luminosity, mass and age with caution'] });

test('prefer_record stellar parameters: BH2\'s companion uses the paper\'s mass, radius and Teff whatever the tiers; Gaia\'s go to notUsed', () => {
  const m = mergeStarSystem(bh2Gaia(), bh2Paper());
  assert.equal(m.values.mass_msun.v, 1.07); assert.match(m.values.mass_msun.src, /El-Badry/);
  assert.equal(m.values.radius_rsun.v, 7.77); assert.equal(m.values.teff_k.v, 4604);
  assert.deepEqual(Object.keys(m.notUsed).sort(), ['mass_msun', 'radius_rsun', 'teff_k']);
  assert.equal(m.notUsed.mass_msun.v, 2.6); assert.match(m.notUsed.mass_msun.src, /FLAME/);
  assert.equal(m.values.lum_lsun.v, 37, 'a parameter the paper does not print keeps Gaia\'s value'); assert.equal(m.values.age_gyr.v, 0.8);
  assert.ok(m.notes.includes('Luminosity and age: Gaia single-star model; may be biased for this binary.'), m.notes.join(' | '));
  assert.ok(m.notes.some((n) => /^The Gaia single-star temperature, radius and mass are not used: /.test(n)));
  assert.ok(m.notes.includes('FLAME quality flags set (1): treat radius, luminosity, mass and age with caution'), 'Gaia\'s own notes stay');
  // without the replace list, the old rule: a tier tie keeps Gaia's FLAME value
  const plain = mergeStarSystem(bh2Gaia(), bh2Paper({ prefer_record: { replace: ['dist'], reason: 'x' } }));
  assert.equal(plain.values.mass_msun.v, 2.6); assert.deepEqual(plain.notUsed, {});
  assert.ok(plain.notes.some((n) => /^Temperature, radius, luminosity, mass and age: Gaia single-star model/.test(n)));
  // a star with no prefer_record is untouched by the new notes
  const none = mergeStarSystem(bh2Gaia(), bh2Paper({ prefer_record: undefined }));
  assert.equal(none.notUsed, undefined); assert.deepEqual(none.notes, bh2Gaia().notes);
  // only a mass printed (Cyg X-1 style): the mass is replaced, Gaia's Teff and radius stay with the note
  const cyg = mergeStarSystem(bh2Gaia(), bh2Paper({ prefer_record: { replace: ['dist', 'mass'], reason: 'x' } }));
  assert.equal(cyg.values.mass_msun.v, 1.07); assert.equal(cyg.values.teff_k.v, 4700); assert.deepEqual(Object.keys(cyg.notUsed), ['mass_msun']);
  assert.ok(cyg.notes.includes('Temperature, radius, luminosity and age: Gaia single-star model; may be biased for this binary.'));
  assert.ok(cyg.notes.includes('The Gaia single-star mass is not used: Gaia\'s GSP-Phot and FLAME model the light as one single star, while the values shown come from the paper\'s fit of the binary.'));
});

test('prefer_record stellar parameters: the star model (what is drawn) uses the same values as the card', () => {
  const md = starModel({ system: mergeStarSystem(bh2Gaia(), bh2Paper()), absG: 0.5, bpRp: 1.4, distPc: 1164.1, kind: 'gaia' });
  assert.equal(md.massMsun.v, 1.07); assert.equal(md.radiusRsun.v, 7.77); assert.equal(md.teff.v, 4604);
  assert.ok(Math.abs(md.radiusAu - 7.77 * 0.00465047) < 1e-12, 'the drawn size is the paper\'s radius');
  assert.deepEqual(md.rgb, starModel({ system: { values: { teff_k: { v: 4604, tier: 'catalogue' } } } }).rgb, 'the colour is the paper\'s Teff');
  assert.equal(md.notUsed.mass_msun.v, 2.6);
});

// a minimal DOM for renderStarCard: elements with children, className, textContent and a flattened text
function fakeDoc() {
  const mk = (tag) => ({ tag, className: '', children: [], _text: '', title: '', ownerDocument: doc, style: {},
    appendChild(c) { this.children.push(c); return c; }, removeChild(c) { this.children.splice(this.children.indexOf(c), 1); },
    get firstChild() { return this.children[0] || null; }, addEventListener() {},
    set textContent(t) { this._text = String(t); }, get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); } });
  const doc = { createElement: mk, createTextNode: (t) => ({ textContent: t }) };
  return { doc, host: mk('div') };
}
const cardRows = (host) => {
  const dl = host.children.find((c) => c.className === 'card-rows'), out = [];
  for (let i = 0; i < dl.children.length; i += 2) out.push([dl.children[i].textContent, dl.children[i + 1].textContent.slice(1).trim(), dl.children[i + 1].children[0].title]);
  return out;
};

test('prefer_record stellar parameters: BH2\'s companion card shows the paper\'s 1.07 M☉ and lists FLAME\'s 2.60 M☉ as not used', () => {
  const rec = bh2Paper(), md = starModel({ system: mergeStarSystem(bh2Gaia(), rec), absG: 0.5, bpRp: 1.4, distPc: 1164.1, kind: 'gaia' });
  const pref = preferredDistanceRows(rec, { bjPc: 1488 });
  const { host } = fakeDoc();
  renderStarCard(host, { ...md, notes: [...md.notes, ...pref.notes] }, { title: rec.name, distRows: pref.rows });
  const rows = cardRows(host), get = (label) => rows.find((r) => r[0] === label);
  assert.deepEqual(rows.map((r) => r[0]).slice(0, 7), ['Temperature', 'Gaia single-star temperature · not used', 'Radius', 'Gaia single-star radius · not used', 'Luminosity', 'Mass', 'Gaia single-star mass · not used']);
  assert.equal(get('Mass')[1], '1.07 ± 0.19 M☉'); assert.match(get('Mass')[2], /El-Badry et al\. 2023/);
  assert.equal(get('Gaia single-star mass · not used')[1], '2.60 ± 0.30 M☉'); assert.match(get('Gaia single-star mass · not used')[2], /FLAME/);
  assert.equal(get('Radius')[1], '7.77 ± 0.25 R☉'); assert.equal(get('Temperature')[1], '4,600 ± 90 K');
  assert.match(get('Luminosity')[2], /FLAME/);
  assert.ok(get('Gaia single-star distance · not used'), 'the distance row is still there');
  const notes = host.children.filter((c) => c.className === 'card-note').map((c) => c.textContent);
  assert.ok(notes.includes('Luminosity and age: Gaia single-star model; may be biased for this binary.'));
  assert.ok(notes.some((n) => /^The Gaia single-star temperature, radius and mass are not used/.test(n)));
  assert.ok(notes.some((n) => /^The Gaia single-star distance is not used: /.test(n)));
});

// ====================================================================== Phase 3: cosmos, galaxies, the Milky Way, supermassive black holes
const gq = (v, unit, tier = 'catalogue') => ({ v, unit, src: 't', tier });
const galRec = (id, ra, dec, distKpc, major, minor, pa, o = {}) => ({
  id, kind: 'galaxy', name: id, designations: [], host: null, parent: null,
  position: { model: 'fixed', ra, dec, epoch: 2000, method: 'cepheid', tier: 'catalogue', dist: distKpc == null ? null : { v: distKpc, unit: 'pc', src: 'Cosmicflows-4', tier: 'measured', ...(distKpc ? { v: distKpc * 1e3 } : {}) } },
  in_cone: false, size: { radius: null, angular: { major: gq(major, 'arcmin'), minor: gq(minor, 'arcmin'), pa: pa == null ? null : gq(pa, 'deg') } },
  props: { type: gq('Galaxy', ''), hubble: gq('SBm', ''), surface_brightness: gq(23.5, 'mag/arcsec2') }, provenance: { source: 'static:galaxies', dataset: 'galaxies' }, evidence: 'measured', render: { mag: 0.9 }, ...o,
});
const LMC = galRec('ongc:ESO056-115', 80.89375, -69.75611, 49.59, 646, 550, 170), SMC = galRec('ongc:NGC0292', 13.1865833, -72.8286111, 62.44, 299.92, 179.89, 45);
const mwG = () => ({
  id: 'gal:milky_way', kind: 'galaxy', name: 'Milky Way', designations: [], host: null, parent: null, in_cone: false, size: { radius: null, angular: null },
  position: { model: 'fixed', ra: 266.4168371, dec: -29.0078106, epoch: 2000, method: 'orbit-fit', tier: 'measured', dist: { v: 8277, lo: 8268, hi: 8286, unit: 'pc', src: 'GRAVITY', tier: 'measured' } },
  props: { ngp_ra: gq(192.85948, 'deg'), ngp_dec: gq(27.12825, 'deg'), l_node: gq(32.93192, 'deg'), thin_disc_scale_length: gq(2600, 'pc', 'measured'), thin_disc_scale_height: gq(300, 'pc', 'measured'),
    bar_half_length: gq(5000, 'pc', 'measured'), bar_angle: gq(27, 'deg', 'measured') },
  provenance: { source: 'static:galaxies', dataset: 'galaxies' }, evidence: 'measured', render: { style: 'milky_way' },
});
const smbh = (id, parent, o = {}) => ({ ...sgr(), id, name: id, parent, in_cone: false, props: { ...sgr().props, type: { v: 'supermassive', src: 't', tier: 'catalogue' } }, ...o });
const cosmosCtx = (o = {}) => gctx({ frame: 'cosmos', ...o });
const camAtPc = (pc, frame) => F.makeCam({ pos: frame === 'cosmos' ? pc.map((v) => v * 1e-6) : pc.slice(), frame });
const lookAt = (cam, target) => {   // a pinhole camera at cam looking at a world point (pc)
  const w = F.worldPc(cam), f = unit(target.map((v, i) => v - w[i])), up0 = Math.abs(f[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const R = unit(crossv(f, up0)), up = crossv(R, f);
  return pinhole(f, up, 1000);
};

test('galaxyFade: 1 to 20 kpc, 0.5 at 30, 0 from 40 kpc, in either frame', () => {
  const g = (pc, fr) => galaxyFade(camAtPc([pc, 0, 0], fr));
  assert.deepEqual([0, 2e4, 4e4, 6e4].map((p) => g(p)), [1, 1, 0, 0]); assert.ok(Math.abs(g(3e4) - 0.5) < 1e-12); assert.ok(Math.abs(g(3e4, 'cosmos') - 0.5) < 1e-12);
});

test('cosmos frame: only kinds with a cosmos renderer; sky scope draws every record sent; the others fade with galaxyFade in the galaxy frame', () => {
  const nb = neb('ongc:NGC1976'), pl = rec('ss:mars', 'planet', 'Mars', [1.2, -0.5, -0.27], { in_cone: true });
  const s = store([earth, pl, nb, LMC, mwG(), smbh('bh:Sgr A*', 'gal:milky_way'), smbh('bh:M87*', 'ongc:NGC4486')]);
  const co = visibleObjects(s, cosmosCtx());
  assert.deepEqual(ids(co), ['bh:M87*', 'bh:Sgr A*', 'gal:milky_way', 'ongc:ESO056-115']);   // galaxies in the cosmos, SMBHs from a sky tile whatever the cone
  assert.equal(co.every((e) => e.galaxyFade == null && e.mwFade == null), true);
  const cam = camAtPc([2e4 + 1e4, 0, 0]);   // 30 kpc: galaxyFade 0.5
  const ga = visibleObjects(s, gctx({ cam })), by = Object.fromEntries(ga.map((e) => [e.id, e]));
  assert.equal(by['ongc:NGC1976'].galaxyFade, 0.5); assert.equal(by['ss:mars'].galaxyFade, 0.5); assert.equal(by['ongc:ESO056-115'].galaxyFade, undefined);
  assert.equal(by['gal:milky_way'].mwFade, 0.5); assert.equal(by['bh:Sgr A*'].galaxyFade, undefined, 'a supermassive black hole has a cosmos renderer');
  assert.equal(visibleObjects(s, gctx()).find((e) => e.id === 'ss:mars').galaxyFade, undefined, 'without cam or galaxyFade nothing is set');
  assert.equal(visibleObjects(s, gctx({ galaxyFade: 0.1 })).find((e) => e.id === 'ss:mars').galaxyFade, 0.1);
  // a stellar-mass black hole has no cosmos renderer (cone scope still applies in the galaxy frame)
  assert.deepEqual(visibleObjects(store([bh('bh:gaia2')]), cosmosCtx()), []);
});

test('populations without a cosmos renderer: alpha x galaxyFade on billboards, markers and labels; not labelled or picked below 0.25', () => {
  const nb = neb('ongc:NGC1976', {}, {}, {}), s = store([earth, nb, LMC]);
  const cam = camAtPc([2e4 + 1e4, 0, 0]), vis = visibleObjects(s, gctx({ cam })), proj = (rel) => [100 + rel[0] * 1e-9, 100 + rel[1] * 1e-9];
  const items = billboardItems(vis, cam, { pxPerRad: 1000, project: lookAt(cam, [0, 0, 0]) });
  const full = billboardItems(visibleObjects(s, gctx()), cam, { pxPerRad: 1000, project: lookAt(cam, [0, 0, 0]) });
  const a = items.find((i) => i.id === 'ongc:NGC1976'), b = full.find((i) => i.id === 'ongc:NGC1976');
  assert.ok(Math.abs(a.alpha - b.alpha * 0.5) < 1e-12); assert.ok(Math.abs(a.lineAlpha - b.lineAlpha * 0.5) < 1e-12); assert.ok(Math.abs(a.markerAlpha - 0.5 * (b.markerAlpha ?? 1)) < 1e-12);
  assert.equal(items.find((i) => i.id === 'ongc:ESO056-115').alpha, full.find((i) => i.id === 'ongc:ESO056-115').alpha, 'a galaxy is unaffected');
  const pos = (e) => framePos(e, sunCam);
  assert.equal(labelCandidates(vis, {}, { project: proj, framePos: pos }).find((l) => l.text === 'ongc:NGC1976').alpha, 0.5);
  const low = visibleObjects(s, gctx({ galaxyFade: 0.2 }));
  assert.ok(!labelCandidates(low, {}, { project: proj, framePos: pos }).some((l) => l.text === 'ongc:NGC1976'));
  assert.equal(pickObjects(low, {}, 100, 100, 1e9, { project: proj, framePos: pos }).sel.id, 'ongc:ESO056-115', 'the nebula is not pickable');
  assert.equal(pickObjects(visibleObjects(s, gctx({ galaxyFade: 0.3 })), {}, 100, 100, 1e9, { project: proj, framePos: pos }) !== null, true);
  const mk = markerPoints(visibleObjects(store([earth, rec('ss:mars', 'planet', 'Mars', [1.2, -0.5, -0.27], { in_cone: true })]), gctx({ galaxyFade: 0.4 })), {}, sunCam);
  assert.ok(Math.abs(mk[4] - 0.4) < 1e-6); assert.equal(markerPoints(visibleObjects(store([earth, mars]), gctx({ galaxyFade: 0 })), {}, sunCam).length, 0);
});

test('per-kind skyFade: galaxies fade over 1e5 pc, nebulae over 800; pick and label gates follow the kind', () => {
  assert.equal(skyFade(F.makeCam({ pos: [1e5, 0, 0] }), 1e5), 0.5); assert.equal(skyFade(F.makeCam({ pos: [800, 0, 0] })), 0.5);
  const dg = galRec('ongc:IC47', 10.7, -13.7, null, 5, 4, 10), dn = dirNeb('ongc:NGC1952'), vis = visibleObjects(store([dg, dn]), gctx());
  const cam = camAtPc([1500, 0, 0]), of = skyFadeOf(cam), by = Object.fromEntries(vis.map((e) => [e.id, e]));
  assert.ok(of(by['ongc:NGC1952']) < 0.25); assert.ok(of(by['ongc:IC47']) > 0.99);
  const proj = () => [100, 100], pos = (e) => framePos(e, cam);
  assert.deepEqual(labelCandidates(vis, {}, { project: proj, framePos: pos, skyFade: of }).map((l) => l.text), ['ongc:IC47']);
  assert.equal(pickObjects(vis, {}, 100, 100, 5, { project: proj, framePos: pos, skyFade: of }).sel.id, 'ongc:IC47');
  const far = camAtPc([1.8e5, 0, 0]), sf = skyFade(far, 1e5);
  assert.ok(sf < 0.25 && sf > 0.2); assert.equal(pickObjects(vis.filter((e) => e.id === 'ongc:IC47'), {}, 100, 100, 5, { project: proj, framePos: pos, skyFade: skyFadeOf(far) }), null);
  assert.equal(by['ongc:IC47'].spec.skyFadePc, 1e5); assert.equal(by['ongc:NGC1952'].spec.skyFadePc, 800);
});

test('the boundary (section 18.5.5): a path through the LMC and SMC across 40-60 kpc gives identical items, screen positions, alphas, labels and picks in both frames', () => {
  const nb = neb('ongc:NGC1976'), s = store([earth, nb, LMC, SMC, galRec('ongc:IC47', 10.7, -13.7, null, 5, 4, 10), mwG()]);
  const lmcPc = M.radecToXyz(80.89375, -69.75611, 49590), smcPc = M.radecToXyz(13.1865833, -72.8286111, 62440);
  const path = [];
  for (const k of [0, 0.25, 0.5, 0.75, 1]) {   // toward the LMC across the band, on to the SMC, and back
    path.push(lmcPc.map((v, i) => v * (0.6 + 0.4 * k) + 3000 * (1 - k) * [0.3, -0.5, 0.2][i]));
    path.push(smcPc.map((v, i) => v * (0.8 + 0.2 * k) + 4000 * k * [0.2, 0.1, -0.4][i]));
  }
  path.push(...path.slice().reverse());
  let compared = 0;
  for (const w of path) {
    const target = lmcPc.map((v, i) => (v + smcPc[i]) / 2), cams = [camAtPc(w, 'galaxy'), camAtPc(w, 'cosmos')];
    const out = cams.map((cam) => {
      const proj = lookAt(cam, target), vis = visibleObjects(s, { ...(cam.frame === 'cosmos' ? cosmosCtx() : gctx()), cam });
      const items = billboardItems(vis, cam, { pxPerRad: 1000, project: proj }).filter((i) => i.kind === 'galaxy');
      const sky = skyFade(cam, 1e5), pos = (e) => framePos(e, cam);
      const gv = vis.filter((e) => e.kind === 'galaxy');
      return { items, labels: labelCandidates(gv, {}, { project: proj, framePos: pos, skyFade: sky }), pick: pickObjects(gv, {}, 500, 500, 1e9, { project: proj, framePos: pos, skyFade: sky }),
        popGone: vis.filter((e) => e.kind === 'nebula').map((e) => e.galaxyFade) };
    });
    const [g, c] = out; compared++;
    assert.deepEqual(g.items.map((i) => i.id), c.items.map((i) => i.id)); assert.ok(g.items.length >= 3);
    for (let k = 0; k < g.items.length; k++) {
      const a = g.items[k], b = c.items[k];
      for (const key of ['alpha', 'fade', 'lineAlpha', 'markerAlpha', 'skyFade', 'semiMajorPx', 'semiMinorPx', 'angle', 'markerOnly', 'inside', 'look', 'dashed', 'hollow']) {
        if (typeof a[key] === 'number') assert.ok(Math.abs(a[key] - b[key]) < 1e-6 * Math.max(1, Math.abs(a[key])), `${a.id} ${key} ${a[key]} ${b[key]}`); else assert.equal(a[key], b[key], `${a.id} ${key}`);
      }
      if (a.screen) for (let j = 0; j < 2; j++) assert.ok(Math.abs(a.screen[j] - b.screen[j]) < 1e-6, `${a.id} screen`);
      if (a.affine) for (const m of ['a', 'b', 'c']) for (let j = 0; j < 2; j++) assert.ok(Math.abs(a.affine[m][j] - b.affine[m][j]) < 1e-6, `${a.id} affine`);
    }
    assert.deepEqual(g.labels.map((l) => [l.text, l.alpha]), c.labels.map((l) => [l.text, l.alpha]));
    g.labels.forEach((l, k) => { assert.ok(Math.abs(l.x - c.labels[k].x) < 1e-6 && Math.abs(l.y - c.labels[k].y) < 1e-6); });
    assert.deepEqual(g.pick && g.pick.sel, c.pick && c.pick.sel);
    assert.ok(g.pick === null || Math.abs(g.pick.d - c.pick.d) < 1e-6);
    assert.deepEqual(g.popGone.every((v) => v === 0 || v < 1), true);
  }
  assert.equal(compared, path.length);
  // the LMC (disc radius about 4.7 kpc) lies wholly inside the 40-60 kpc band, so a camera by it can be in either frame
  const lmcD = Math.hypot(...lmcPc); assert.ok(lmcD > 4e4 && lmcD < 6e4);
});

test('smbhVisible: in the cone, selected, a resolved parent (inside or 40 px), the Milky Way only from 40 kpc out', () => {
  const m87 = smbh('bh:M87*', 'ongc:NGC4486'), e = { id: m87.id, kind: 'black_hole', o: m87 };
  assert.equal(smbhVisible(e, []), false);
  assert.equal(smbhVisible(e, [], { selectedId: 'bh:M87*' }), true); assert.equal(smbhVisible(e, [], { inCone: true }), true);
  assert.equal(smbhVisible({ ...e, o: { ...m87, in_cone: true } }, []), true, 'in_cone on the record');
  assert.equal(smbhVisible(e, [{ id: 'ongc:NGC4486', semiMajorPx: 39, inside: false }]), false);
  assert.equal(smbhVisible(e, [{ id: 'ongc:NGC4486', semiMajorPx: 40, inside: false }]), true);
  assert.equal(smbhVisible(e, [{ id: 'ongc:NGC4486', semiMajorPx: null, inside: true }]), true);
  assert.equal(smbhVisible(e, [{ id: 'ongc:other', semiMajorPx: 900 }]), false, 'another galaxy does not count');
  const sg = smbh('bh:Sgr A*', 'gal:milky_way'), se = { id: sg.id, kind: 'black_hole', o: sg };
  assert.equal(smbhVisible(se, [{ id: 'gal:milky_way', billboard: 'milky_way', semiMajorPx: 900, galaxyFade: 1 }]), false, 'near the Sun: the Phase 2 cone rule');
  assert.equal(smbhVisible(se, [{ id: 'gal:milky_way', billboard: 'milky_way', semiMajorPx: 900, galaxyFade: 0 }]), true);
  assert.equal(smbhVisible(se, [], { inCone: true }), true);
  assert.equal(smbhVisible({ id: 'x', kind: 'galaxy', o: LMC }, []), true); assert.equal(smbhVisible({ id: 'b', kind: 'black_hole', o: bh('b') }, []), true, 'stellar-mass ones are not governed by it');
  const s = store([smbh('bh:M87*', 'ongc:NGC4486'), LMC]), vis = visibleObjects(s, cosmosCtx());
  assert.deepEqual(withSmbh(vis, [], {}).map((x) => x.id), ['ongc:ESO056-115']);
});

test('childrenOf works for record ids: a galaxy lists its black holes; star keys still work', () => {
  const m87 = galRec('ongc:NGC4486', 187.7, 12.39, 16858, 8, 7, 0), b1 = smbh('bh:M87*', 'ongc:NGC4486'), s = store([m87, b1, smbh('bh:other', 'ongc:NGC0224')]);
  assert.deepEqual(s.childrenOf('ongc:NGC4486').map((o) => o.id), ['bh:M87*']); assert.deepEqual(s.childrenOf('nope'), []);
  const s2 = new ObjectStore(); s2.ingest(payload([m87, b1])); s2.setHostResolver({ key: (id) => (id === 'ongc:NGC4486' ? 'weird-key' : null), pc: () => null });
  assert.deepEqual(s2.childrenOf('ongc:NGC4486').map((o) => o.id), ['bh:M87*'], 'by the raw parent too');
});

test('lensing at Mpc: the same item whichever frame, enlarged, M87* from the Sun about 1e-7 px', () => {
  const m87 = smbh('bh:M87*', 'ongc:NGC4486', { position: { ...sgr().position, ra: 187.7059167, dec: 12.3911111, dist: { v: 16.858, unit: 'Mpc', src: 't', tier: 'measured' } },
    size: { radius: { v: 1.926e10, unit: 'km', src: 't', tier: 'inferred' }, angular: null } });
  const s = store([m87]), g = camAtPc([0, 0, 0], 'galaxy'), c = camAtPc([0, 0, 0], 'cosmos');
  const a = lensingItems(visibleObjects(s, gctx()), g, { pxPerRad: 1000 })[0], b = lensingItems(visibleObjects(s, cosmosCtx()), c, { pxPerRad: 1000 })[0];
  assert.equal(b.enlarged, true); assert.ok(b.truePx < 1e-6 && b.truePx > 1e-8, `${b.truePx}`);
  assert.ok(Math.abs(a.truePx / b.truePx - 1) < 1e-9); assert.ok(Math.abs(a.factor / b.factor - 1) < 1e-9); assert.ok(Math.abs(a.rShadow * 1e-6 / b.rShadow - 1) < 1e-12);
  assert.equal(b.alpha, 1); assert.equal(markerPoints(visibleObjects(s, cosmosCtx()), {}, c).length, 8);
  assert.equal(lensingItems(visibleObjects(s, cosmosCtx()), c, { evidence: true, pxPerRad: 1000 }).length, 0);
});

test('billboardItems dispatches by billboard kind (a function of the record too) in the cosmos frame', () => {
  const s = store([LMC, mwG()]), cam = camAtPc([0, 7e4, 0], 'cosmos'), vis = visibleObjects(s, cosmosCtx({ cam }));
  const items = billboardItems(vis, cam, { pxPerRad: 1000, project: lookAt(cam, [0, 0, 0]) });
  assert.deepEqual(items.map((i) => [i.id, i.billboard]).sort(), [['gal:milky_way', 'milky_way'], ['ongc:ESO056-115', 'galaxy']]);
  assert.deepEqual(billboardItems(vis, camAtPc([0, 0, 0]).frame === 'galaxy' ? { ...cam, frame: 'system', host: { pc: [0, 0, 0], key: 'x' } } : cam, { project: () => [0, 0] }), []);
});

test('planGo: a placed galaxy flies to 3 radii, a direction-only one turns, the Milky Way flies to a face-on point 60 kpc up', () => {
  const m31 = galRec('ongc:NGC0224', 10.68, 41.27, 757.5, 177.8, 69.7, 35, { size: { radius: { v: 19597, unit: 'pc', src: 't', tier: 'inferred' }, angular: null } });
  const dg = galRec('ongc:IC47', 10.7, -13.7, null, 5, 4, 10), s = store([m31, dg, mwG()]), get = (id) => s.get(id), opts = { camFrame: 'galaxy', camHostKey: null, placement: (id) => s.placement(id), get };
  assert.deepEqual(planGo({ kind: 'galaxy', id: 'ongc:NGC0224', host: null }, opts), { type: 'fly-galaxy', arrivePc: 3 * 19597 });
  const e = visibleObjects(s, gctx()).find((x) => x.id === 'ongc:NGC0224'); assert.deepEqual(planGo(e, opts), { type: 'fly-galaxy', arrivePc: 3 * 19597 });
  assert.deepEqual(planGo({ kind: 'galaxy', id: 'ongc:IC47', host: null }, opts), { type: 'look', dir: M.radecToXyz(10.7, -13.7, 1) });
  assert.deepEqual(planGo(dg, { camFrame: 'galaxy', camHostKey: null }), { type: 'look', dir: M.radecToXyz(10.7, -13.7, 1) }, 'a bare record');
  const p = planGo({ kind: 'galaxy', id: 'gal:milky_way', host: null }, opts), c = M.radecToXyz(266.4168371, -29.0078106, 8277), ax = galacticAxes(192.85948, 27.12825, 32.93192);
  assert.equal(p.type, 'fly-point'); assert.ok(near(p.lookAtPc, c, 1e-6));
  assert.ok(Math.abs(Math.hypot(...p.pc.map((v, i) => v - c[i])) - 60000) < 1e-6); assert.ok(near(unit(p.pc.map((v, i) => v - c[i])), ax.n, 1e-12));
  assert.ok(Math.hypot(...p.pc) > 6e4, 'ends in cosmos');
  assert.deepEqual(planGo(sgr(), { camFrame: 'galaxy', camHostKey: null }), { type: 'fly-galaxy' }, 'Sgr A* is unchanged');
  assert.deepEqual(planGo({ kind: 'cluster', id: pleiades.id, host: pleiades.host }, { camFrame: 'galaxy', camHostKey: null, resolveHost: (h) => h }), { type: 'fly-galaxy' });
});

test('credits: the Gaia star item goes on the line, once, only when the star payload holds Gaia rows', () => {
  assert.equal(starCreditItem(false), null);
  const it = starCreditItem(true); assert.equal(it.text, 'Stars: Gaia DR3 · Credit: ESA/Gaia/DPAC · CC BY-NC 3.0 IGO');
  const src = [{ id: 'static:nebulae', status: 'ok', count: 3, provenance: { dataset: 'nebulae', credit: 'Credits: OpenNGC', licence_name: 'CC BY-SA 4.0' } }];
  assert.equal(creditsLine(src, { nebulae: 3 }, [starCreditItem(true)]), 'Credits: OpenNGC · CC BY-SA 4.0 | Stars: Gaia DR3 · Credit: ESA/Gaia/DPAC · CC BY-NC 3.0 IGO');
  assert.equal(creditsLine(src, { nebulae: 3 }, [starCreditItem(false)]), 'Credits: OpenNGC · CC BY-SA 4.0');
  assert.equal(creditsLine([], {}, [starCreditItem(true), starCreditItem(true)]), 'Stars: Gaia DR3 · Credit: ESA/Gaia/DPAC · CC BY-NC 3.0 IGO');
  assert.equal(creditsLine(src, { nebulae: 3 }), 'Credits: OpenNGC · CC BY-SA 4.0'); assert.equal(creditItems(src, { nebulae: 3 }, starCreditItem(true)).length, 2);
});

// ------------------------------------------------------------------ Phase 4 (section 19)
const mpc = (v, o = {}) => ({ v, unit: 'Mpc', src: 't', tier: 'inferred', ...o });
const m31Bh = (o = {}) => smbh('bh:M31*', 'ongc:NGC0224', { position: { ...sgr().position, ra: 10.6847917, dec: 41.2690556, dist: mpc(0.759, { tier: 'measured' }) },
  size: { radius: { v: 4.1e8, unit: 'km', src: 't', tier: 'inferred' }, angular: null }, ...o });
const m31G = () => galRec('ongc:NGC0224', 10.6847917, 41.2690556, 759, 177.8, 69.7, 35);
const lensAt = (items, o = m31Bh(), cam = camAtPc([0, 0, 0], 'galaxy')) => {
  const s = store([m31G(), o]), vis = visibleObjects(s, gctx({ cam }));
  return lensingItems(vis, cam, { pxPerRad: 1000, items });
};

test('lensingItems cap (section 19.3.3): M31* from the Sun is a marker only, drawn at 200 px with the factor of what is drawn, Sgr A* inside the Milky Way is uncapped', () => {
  assert.equal(LENS_FLOOR_PX, 1.5);
  const far = lensAt([{ id: 'ongc:NGC0224', semiMajorPx: 20, inside: false }]);   // seen from the Sun: M31 is about 20 px in semi-major axis
  assert.equal(far.length, 0); assert.equal(far.markerOnly.length, 1);
  const m = far.markerOnly[0];
  assert.equal(m.id, 'bh:M31*'); assert.equal(m.markerOnly, true); assert.equal(m.factor, null); assert.equal(m.capPx, 1); assert.equal(m.parentName, 'ongc:NGC0224'); assert.ok(m.truePx > 0 && m.truePx < 1e-6);
  const near = lensAt([{ id: 'ongc:NGC0224', semiMajorPx: 200, inside: false }]);
  assert.equal(near.length, 1); assert.equal(near.markerOnly.length, 0);
  const it = near[0]; assert.equal(it.px, 9); assert.equal(it.capPx, 10); assert.equal(it.enlarged, true); assert.ok(Math.abs(it.factor - 9 / it.truePx) / it.factor < 1e-12);
  const tight = lensAt([{ id: 'ongc:NGC0224', semiMajorPx: 120, inside: false }])[0];   // the cap (6 px) is under the minimum look: px = cap, factor = cap / truePx
  assert.equal(tight.px, 6); assert.ok(Math.abs(tight.factor - 6 / tight.truePx) / tight.factor < 1e-12);
  assert.equal(lensAt([{ id: 'ongc:NGC0224', semiMajorPx: 30, inside: false }]).length, 1, 'cap 1.5 px is not under the floor: drawn');
  assert.equal(lensAt([{ id: 'ongc:NGC0224', semiMajorPx: 29, inside: false }]).length, 0, '1.45 px: a marker');
  assert.equal(lensAt([{ id: 'ongc:NGC0224', semiMajorPx: null, inside: true }])[0].px, 9, 'the camera inside the parent: no cap');
  assert.equal(lensAt([])[0].px, 9, 'no parent item: no cap');
  // Sgr A* from the Sun: the Milky Way's item is inside, so uncapped
  const sg = lensingItems(visibleObjects(store([mwG(), smbh('bh:Sgr A*', 'gal:milky_way', { position: sgr().position, size: sgr().size })]), gctx({ cam: camAtPc([0, 0, 0]) })), camAtPc([0, 0, 0]),
    { pxPerRad: 1000, items: [{ id: 'gal:milky_way', semiMajorPx: null, inside: true, billboard: 'milky_way' }] });
  assert.equal(sg.length, 1); assert.equal(sg[0].px, 9);
  // a stellar-mass black hole has no galaxy parent and is unchanged
  const st = lensingItems(visibleObjects(store([{ ...sgr(), id: 'bh:s', parent: 'ongc:NGC0224' }]), gctx({ cam: camAtPc([0, 0, 0]) })), camAtPc([0, 0, 0]), { pxPerRad: 1000, items: [{ id: 'ongc:NGC0224', semiMajorPx: 20, inside: false }] });
  assert.equal(st.length, 1); assert.equal(st[0].capPx, null);
  // the Evidence view: nothing, with an empty markerOnly list; lensVisible keeps the marker-only black hole's marker
  const ev = lensingItems(visibleObjects(store([m31G(), m31Bh()]), gctx({ cam: camAtPc([0, 0, 0]), evidence: true })), camAtPc([0, 0, 0]), { evidence: true, items: [] });
  assert.equal(ev.length, 0); assert.deepEqual(ev.markerOnly, []);
  const vis = visibleObjects(store([m31G(), m31Bh()]), gctx({ cam: camAtPc([0, 0, 0]) }));
  assert.deepEqual(lensVisible(vis, far, false).map((e) => e.id).sort(), ['bh:M31*', 'ongc:NGC0224']); assert.deepEqual(lensVisible(vis, near, false).map((e) => e.id), ['ongc:NGC0224']);
  assert.ok(lensVisible(vis, near, true).some((e) => e.id === 'bh:M31*'));
  const withName = lensingItems(vis, camAtPc([0, 0, 0]), { pxPerRad: 1000, items: [{ id: 'ongc:NGC0224', semiMajorPx: 20, inside: false }] });
  assert.equal(withName.markerOnly[0].parentName, 'ongc:NGC0224', 'the parent entry names it');
});

test('smbhVisible (section 19.3.8): a parent galaxy behind the camera does not count; one the camera is inside still does', () => {
  const m87 = smbh('bh:M87*', 'ongc:NGC4486'), e = { id: m87.id, kind: 'black_hole', o: m87 }, big = { id: 'ongc:NGC4486', semiMajorPx: 300, inside: false };
  assert.equal(smbhVisible(e, [{ ...big, screen: [10, 10] }]), true, 'in front: counted');
  assert.equal(smbhVisible(e, [{ ...big, screen: null }]), false, 'its centre is behind the camera');
  assert.equal(smbhVisible(e, [{ id: 'ongc:NGC4486', semiMajorPx: null, inside: true, screen: null, dist: 3, radiusUnits: 10 }]), true, 'the camera is inside it, looking away');
  assert.equal(smbhVisible(e, [{ id: 'ongc:NGC4486', semiMajorPx: null, inside: true, screen: null, dist: 3e3, radiusUnits: 10 }]), false, 'inside is also reported for a centre behind the camera: not near enough');
  assert.equal(smbhVisible(e, [{ ...big, rel: [0, 0, -5] }], { forward: [0, 0, 1] }), false, 'rel . forward <= 0');
  assert.equal(smbhVisible(e, [{ ...big, rel: [0, 0, 5] }], { forward: [0, 0, 1] }), true);
  // through the real items: a galaxy behind a pinhole camera
  const g = galRec('ongc:NGC4486', 187.7, 12.39, 16858, 600, 500, 0), s = store([g, smbh('bh:M87*', 'ongc:NGC4486')]);
  const cam = camAtPc([0, 0, 0]), vis = visibleObjects(s, gctx({ cam })), tgt = M.radecToXyz(187.7, 12.39, 16858);
  const back = billboardItems(vis, cam, { pxPerRad: 1000, project: lookAt(cam, tgt.map((v) => -v)) }), front = billboardItems(vis, cam, { pxPerRad: 1000, project: lookAt(cam, tgt) });
  const ent = vis.find((x) => x.id === 'bh:M87*');
  assert.equal(smbhVisible(ent, back), false); assert.equal(smbhVisible(ent, front), front[0].semiMajorPx >= 40 || !!front[0].inside);
});

// ---- the line-of-sight spread of group members (section 19.3.4, 19.14 item 4)
const grp = (id, ra, dec, D, lo, hi, gr, o = {}) => galRec(id, ra, dec, null, 5, 4, 10, { position: { model: 'fixed', ra, dec, epoch: 2000, method: 'group-member', tier: 'inferred',
  dist: { v: D, lo, hi, unit: 'Mpc', src: 'its group', tier: 'inferred' } }, props: { type: gq('Galaxy', ''), ...(gr == null ? {} : { group_radius: { v: gr, unit: 'Mpc', src: 'rms', tier: 'inferred' } }) }, ...o });
const distPc = (pc) => Math.hypot(...pc);

test('line-of-sight spread: deterministic, bounded by the radius and the interval, a bell with no edge, zero in the Evidence view', () => {
  const g1 = grp('ongc:NGC4501', 187.4, 14.4, 16.5, 15.1, 17.9, 1.7);
  const a = store([g1]), b = store([JSON.parse(JSON.stringify(g1))]);
  const pa = a.placement('ongc:NGC4501'), pb = b.placement('ongc:NGC4501');
  assert.deepEqual(pa.galPc, pb.galPc, 'the same place on every load'); assert.deepEqual(a.placement('ongc:NGC4501').galPc, pa.galPc, 'and twice in one store');
  const off = distPc(pa.galPc) - 16.5e6; assert.ok(off !== 0 && Math.abs(off) <= 1.4e6 + 1e-6, `${off}`); assert.ok(Math.abs(pa.losPc - off) < 1e-3);
  assert.equal(losOffsetPc(g1), pa.losPc);
  // the Evidence view: the exact group distance; toggling back restores the spread
  assert.equal(a.setEvidence(true), true); assert.ok(Math.abs(distPc(a.placement('ongc:NGC4501').galPc) - 16.5e6) < 1e-3); assert.equal(a.placement('ongc:NGC4501').losPc, 0);
  assert.equal(a.setEvidence(true), false); assert.equal(a.setEvidence(false), true); assert.deepEqual(a.placement('ongc:NGC4501').galPc, pa.galPc);
  // visibleObjects carries the flag, so an entry's galPc, framePos and planGo follow
  const cam = camAtPc([0, 0, 0], 'cosmos'), ctx = (evidence) => cosmosCtx({ evidence, cam });
  const evD = distPc(visibleObjects(a, ctx(true)).find((e) => e.id === 'ongc:NGC4501').galPc), nD = distPc(visibleObjects(a, ctx(false)).find((e) => e.id === 'ongc:NGC4501').galPc);
  assert.ok(Math.abs(evD - 16.5e6) < 1e-3 && Math.abs(nD - 16.5e6 - off) < 1e-3);
  const e = visibleObjects(a, ctx(false)).find((x) => x.id === 'ongc:NGC4501'), rel = framePos(e, cam);
  assert.ok(Math.abs(Math.hypot(...rel) - nD * 1e-6) < 1e-9, 'framePos is the drawn place');
  // the bound over many ids, with a wide and a tight interval; the distribution is a bell (more mass near 0 than near the edge), and reaches near both edges
  let max = 0, inner = 0, outer = 0, n = 4000;
  for (let i = 0; i < n; i++) {
    const o = grp(`ongc:T${i}`, 10, 10, 16.5, 15.1, 17.9, 1.7), d = losOffsetPc(o) / 1e6; max = Math.max(max, Math.abs(d));
    assert.ok(Math.abs(d) <= 1.4 + 1e-12, `${d}`); if (Math.abs(d) < 0.35) inner++; if (Math.abs(d) > 1.05) outer++;
    const tight = losOffsetPc(grp(`ongc:U${i}`, 10, 10, 16.5, 16.3, 16.9, 1.7)) / 1e6;   // the interval ends 0.2 and 0.4 Mpc away, less than the group radius
    assert.ok(tight >= -0.2 - 1e-12 && tight <= 0.4 + 1e-12 && Math.abs(tight) <= 0.2 + 1e-12, `${tight}`);   // b = min(1.7, 0.2, 0.4) = 0.2 on both sides
    const noLo = losOffsetPc(grp(`ongc:V${i}`, 10, 10, 16.5, null, 16.9, 1.7)) / 1e6; assert.ok(Math.abs(noLo) <= 0.4 + 1e-12);
    const noEnds = losOffsetPc({ ...grp(`ongc:W${i}`, 10, 10, 16.5, null, null, 0.8), position: { ...grp('x', 0, 0, 16.5, null, null, 0.8).position, dist: { v: 16.5, unit: 'Mpc', src: 't', tier: 'inferred' } } }) / 1e6;
    assert.ok(Math.abs(noEnds) <= 0.8 + 1e-12);
  }
  assert.ok(max > 1.3, `reaches near the bound: ${max}`); assert.ok(inner / n > 0.4 && outer / n < 0.09, `bell: ${inner / n} ${outer / n}`);
  // no spread without group_radius, or when not a group member
  assert.equal(losOffsetPc(grp('ongc:N1', 1, 1, 16.5, 15, 18, null)), 0);
  const nogr = store([grp('ongc:N1', 1, 1, 16.5, 15, 18, null)]); assert.ok(Math.abs(distPc(nogr.placement('ongc:N1').galPc) - 16.5e6) < 1e-3); assert.equal(nogr.placement('ongc:N1').losPc, 0);
  assert.equal(losOffsetPc(grp('ongc:N2', 1, 1, 16.5, 15, 18, 1.7, { position: { ...grp('x', 1, 1, 16.5, 15, 18, 1.7).position, method: 'tully-fisher' } })), 0);
});

test('line-of-sight spread: a hosted supermassive black hole is drawn at its galaxy\'s offset centre, picking and planGo use the drawn place', () => {
  const g = grp('ongc:NGC4889', 195.03, 27.98, 100, 90, 110, 3), bhr = smbh('bh:NGC4889*', 'ongc:NGC4889', { position: { ...sgr().position, ra: 195.03, dec: 27.98, dist: { v: 100, unit: 'Mpc', src: 'its galaxy', tier: 'inferred' } },
    size: { radius: { v: 6e10, unit: 'km', src: 't', tier: 'inferred' }, angular: null } });
  const s = store([g, bhr]), pg = s.placement('ongc:NGC4889'), pb = s.placement('bh:NGC4889*');
  assert.ok(pg.losPc !== 0); assert.ok(Math.abs(pg.losPc) <= 3e6); assert.ok(Math.abs(distPc(pb.galPc) - distPc(pg.galPc)) < 1e-3, 'same drawn distance'); assert.equal(pb.losPc, pg.losPc);
  s.setEvidence(true); assert.ok(Math.abs(distPc(s.placement('bh:NGC4889*').galPc) - 100e6) < 1e-3);
  s.setEvidence(false);
  // a galaxy-less black hole and a galaxy without a radius do not move
  const lone = store([smbh('bh:Q*', 'ongc:none', { position: { ...sgr().position, dist: mpc(50) } })]); assert.ok(Math.abs(distPc(lone.placement('bh:Q*').galPc) - 50e6) < 1e-3);
  // pick and the go plan read the same place: the entry's galPc
  const cam = camAtPc([0, 0, 0], 'cosmos'), vis = visibleObjects(s, cosmosCtx({ cam })), e = vis.find((x) => x.id === 'ongc:NGC4889');
  assert.deepEqual(e.galPc, s.placement('ongc:NGC4889').galPc);
  const pk = pickObjects([e], {}, 5, 5, 3, { project: (rel) => [5, 5], framePos: (x) => framePos(x, cam) }); assert.equal(pk.sel.id, 'ongc:NGC4889');
  assert.equal(planGo(e, { camFrame: 'cosmos', placement: (id) => s.placement(id), get: (id) => s.get(id) }).type, 'fly-galaxy');
});

// ---- "you came from here" (section 19.3.9)
test('homeMarkers: the Sun and the Milky Way centre, faded with the stars, merged under 30 px, kept in the Evidence view, never in a system frame', () => {
  const s = store([mwG()]), proj = (px) => (rel) => (rel[2] > 0 || rel[0] !== 0 ? [rel[0] * px, rel[1] * px] : [0, 0]);
  const cam = camAtPc([0, 0, 3e4], 'galaxy');
  const at = (c, o = {}) => homeMarkers(c, { project: (rel) => [rel[0] * 100, rel[1] * 100], galaxyFade: 0.3, store: s, evidence: false, ...o });
  const g = at(cam); assert.deepEqual(g.map((m) => m.id), ['ss:sun', 'gal:milky_way']); assert.ok(g.every((m) => Math.abs(m.alpha - 0.7) < 1e-12));
  assert.deepEqual(g[0].sel, { kind: 'sun', id: 'ss:sun' }); assert.deepEqual(g[1].sel, { kind: 'galaxy', id: 'gal:milky_way' });
  assert.equal(g[0].text, 'Sun · you started here'); assert.equal(g[1].text, 'Milky Way centre · Sgr A*');
  assert.deepEqual(at(cam, { galaxyFade: 1 }), [], 'nothing while the stars are at full strength');
  assert.equal(at(cam, { galaxyFade: 0.999 }).length, 2);
  const sys = F.makeCam({ pos: [0, 0, 0], frame: 'system', host: { idx: 0, key: 'ss:sun', pc: [0, 0, 0] } }); assert.deepEqual(at(sys, { galaxyFade: 0 }), []);
  assert.equal(at(cam, { evidence: true }).length, 2, 'both are measured: kept in the Evidence view');
  const c = camAtPc([0, 0, 1e-6 * 0 + 0.1], 'cosmos');   // Mpc: alpha 1 whatever galaxyFade says
  const cc = at(c, { galaxyFade: 1, project: (rel) => [rel[0] * 1e4, rel[1] * 1e4] }); assert.ok(cc.length >= 1 && cc.every((m) => m.alpha === 1));
  const merged = at(camAtPc([0, 0, 30e3 * 1e-6], 'cosmos'), { project: (rel) => [rel[0] * 1e-4, rel[1] * 1e-4], galaxyFade: 1 });   // 8.3 kpc apart, tiny on screen
  assert.equal(merged.length, 1); assert.equal(merged[0].text, 'Milky Way · the Sun is here'); assert.equal(merged[0].merged, true); assert.equal(merged[0].id, 'gal:milky_way');
  assert.equal(at(camAtPc([0, 0, 30e3 * 1e-6], 'cosmos'), { project: (rel) => [rel[0] * 1e4, rel[1] * 1e4], galaxyFade: 1 }).length, 2, 'far apart on screen: two');
  assert.deepEqual(at(cam, { store: store([]) }).map((m) => m.id), ['ss:sun'], 'no Milky Way record: only the Sun');
  assert.deepEqual(at(cam, { project: () => null }), [], 'behind the camera: nothing');
});


// ------------------------------------------------------------------ Phase 5 (section 20): time, the general evidence rule, greyed records
const P5_MJD = 61000, P5_JD = P5_MJD + 2400000.5;
const eph = (id, kind, name, xyz) => rec(id, kind, name, xyz, { provenance: { source: 'ephem' }, position: { model: 'state', mjd: P5_MJD, xyz_au: xyz, method: 'ephemeris', src: 'astropy ephem', tier: 'measured' } });
const kep = (id, name, o = {}) => small(id, 'asteroid', name, [2.5, 0.1, 0.02], { in_cone: true, provenance: { source: 'skybot' }, ...o,
  position: { model: 'state', mjd: P5_MJD, xyz_au: [2.5, 0.1, 0.02], method: 'orbit-propagation', src: 'SkyBoT', tier: 'catalogue',
    osc: { epoch_jd: P5_JD - 0.5, xyz_au: [2.49, 0.09, 0.02], vxyz_au_d: [0, GK / Math.sqrt(2.5), 0.0005], frame: 'icrf-heliocentric', src: 'SkyBoT state', tier: 'catalogue' } } });
const mercury = eph('ss:mercury', 'planet', 'Mercury', [0.3, -0.2, -0.1]), earth5 = eph('ss:earth', 'planet', 'Earth', [0.9, 0.4, 0.17]);
const sun5 = rec('ss:sun', 'sun', 'Sun', [0, 0, 0]);
const store5 = (objs, opts) => { const s = new ObjectStore(opts); assert.ok(s.ingest(payload(objs, { query: { ra: 150, dec: 2, radius: 3, mjd: P5_MJD, kinds: [] } })).ok); return s; };
const snapshot = (st) => st.recs.map((r) => [r.id, r.sysAu && r.sysAu.slice(), r.galPc && r.galPc.slice(), r.orbit && r.orbit.xyzAu.slice()]);

test('setTime(query.mjd) leaves every record where ingest put it; the arrays are the same objects throughout', () => {
  const st = store5([sun5, earth5, mercury, kep('mp:7', 'Seven'), exo('nea:b', { host: HOST }), hostStar()]);
  st.setHostResolver(resolver({ [HOST]: HOST }, { [HOST]: HOST_PC }));
  const before = snapshot(st), arrays = st.recs.map((r) => [r.sysAu, r.galPc]);
  assert.equal(st.mjd, P5_MJD); assert.equal(st.setTime(P5_MJD, { hosts: [HOST] }), false);
  assert.deepEqual(snapshot(st), before);
  assert.equal(st.setTime(P5_MJD + 30, { hosts: [HOST] }), true); assert.equal(st.mjd, P5_MJD + 30);
  st.recs.forEach((r, i) => { assert.equal(r.sysAu, arrays[i][0], r.id); assert.equal(r.galPc, arrays[i][1], r.id); });   // in place
  assert.equal(st.setTime(P5_MJD, { hosts: [HOST] }), true);
  const back = snapshot(st);
  back.forEach((b, i) => { for (const k of [1, 2, 3]) if (b[k]) assert.ok(near(b[k], before[i][k], 1e-9), `${b[0]} back at the payload epoch`); });
});

test('setTime moves Mercury and Earth on the ephemeris and a SkyBoT body two-body; the Sun marker stays at minus Earth', () => {
  const st = store5([sun5, earth5, mercury, kep('mp:7', 'Seven')]);
  const m0 = st.placement('ss:mercury').sysAu.slice(), e0 = st.placement('ss:earth').sysAu.slice(), k0 = st.placement('mp:7').sysAu.slice();
  assert.ok(st.mover('ss:mercury') && st.mover('mp:7').elements && !st.mover('ss:sun'));
  assert.equal(st.setTime(P5_MJD + 40), true);
  const m1 = st.placement('ss:mercury').sysAu, e1 = st.placement('ss:earth').sysAu, k1 = st.placement('mp:7').sysAu;
  assert.ok(Math.hypot(...m1.map((v, i) => v - m0[i])) > 0.1, 'Mercury moved a good part of its orbit in 40 days');
  assert.ok(Math.hypot(...e1.map((v, i) => v - e0[i])) > 0.1); assert.ok(Math.hypot(...k1.map((v, i) => v - k0[i])) > 0.05);
  assert.ok(near(st.placement('ss:sun').galPc, e1.map((v) => -v / AU), 1e-12), 'the Sun marker follows minus the DRAWN Earth');
  assert.ok(near(st.placement('mp:7').galPc, k1.map((v, i) => (v - e1[i]) / AU), 1e-12), 'a Sun-hosted galPc is relative to the drawn Earth');
  assert.equal(st.setTime(P5_MJD + 40), false);
  // the same record through evalMover directly
  assert.ok(near(k1, evalMover(st.mover('mp:7'), P5_MJD + 40, [0, 0, 0]), 1e-12));
});

test('hosts: only the Sun and the listed hosts are evaluated; a host added later is brought to the current date', () => {
  const st = store5([sun5, earth5, exo('nea:b', { host: HOST }), hostStar()]);
  st.setHostResolver(resolver({ [HOST]: HOST }, { [HOST]: HOST_PC }));
  const b0 = st.placement('nea:b').sysAu.slice();
  assert.equal(st.setTime(P5_MJD + 0.7, { hosts: [] }), true);              // only Earth moved; the planet waits
  assert.deepEqual(st.placement('nea:b').sysAu, b0); assert.equal(st.mjd, P5_MJD + 0.7);
  assert.equal(st.setTime(P5_MJD + 0.7, { hosts: new Set([HOST]) }), true);  // the date did not change, the host is new
  assert.ok(Math.hypot(...st.placement('nea:b').sysAu.map((v, i) => v - b0[i])) > 1e-5);
  assert.ok(near(st.placement('nea:b').sysAu, orbitPlacement(trB.host ? exo('nea:b', { host: HOST }) : null, P5_MJD + 0.7).xyzAu, 1e-11), 'the same as orbitPlacement at that date');
});

test('placement(id).orbit follows the drawn date', () => {
  const el = { period_d: { v: 1.510826, lo: 1.510726, hi: 1.510926, unit: 'd', tier: 'measured', src: 't' } };
  const st = store5([earth5, exo('nea:b', { host: HOST }, el), hostStar()]);
  st.setHostResolver(resolver({ [HOST]: HOST }, { [HOST]: HOST_PC }));
  const o0 = st.placement('nea:b').orbit, s0 = o0.phaseSigmaDeg;
  st.setTime(P5_MJD + 1000, { hosts: [HOST] });
  const o1 = st.placement('nea:b').orbit, want = orbitPlacement(exo('nea:b', { host: HOST }, el), P5_MJD + 1000);
  assert.equal(o1, o0, 'updated in place'); assert.ok(Math.abs(o1.phaseSigmaDeg - want.phaseSigmaDeg) < 1e-9); assert.ok(o1.phaseSigmaDeg > s0);
  assert.ok(Math.abs(o1.used.trueAnomaly - want.used.trueAnomaly) < 1e-9 && Math.abs(o1.used.r - want.used.r) < 1e-15);
});

test('validity(id) is moverValidity, { ok: true } without a mover; moverOk agrees with it', () => {
  const st = store5([sun5, earth5, mercury, kep('mp:7', 'Seven'), exo('nea:b', { host: HOST }, { period_d: { v: 1.5, lo: 1.4, hi: 1.6, unit: 'd', tier: 'measured', src: 't' } }), hostStar()]);
  assert.deepEqual(st.validity('ss:sun'), { ok: true, reason: null }); assert.equal(st.validity('mp:7').ok, true);
  assert.equal(st.validity('mp:7', P5_MJD + 400).reason, 'osc-epoch'); assert.equal(st.validity('nope').ok, true);
  for (const id of ['mp:7', 'nea:b', 'ss:mercury']) for (const dt of [-30000, -500, 0, 300, 400, 5000, 30000]) {
    st.setTime(P5_MJD + dt, { hosts: [HOST] });
    assert.equal(!st.placement(id).greyed, moverValidity(st.mover(id), P5_MJD + dt).ok, `${id} ${dt}`);
  }
});

test('greyed: beyond its valid range only; flagged in the normal view, hidden in the Evidence view, still counted, styled in markers and labels', () => {
  const st = store5([sun5, earth5, mars, kep('mp:7', 'Seven'), kep('mp:8', 'Eight')]);
  const cam = F.makeCam({ pos: [0, 0, 0] });
  assert.ok(visibleObjects(st, gctx()).every((e) => !e.greyed), 'inside the window nothing is greyed');
  st.setTime(P5_MJD + 400);
  const vis = visibleObjects(st, gctx()), g7 = vis.find((e) => e.id === 'mp:7');
  assert.equal(g7.greyed, true); assert.equal(vis.find((e) => e.id === 'ss:mars').greyed, undefined);
  const ev = visibleObjects(st, gctx({ evidence: true }));
  assert.ok(!ev.some((e) => e.id === 'mp:7' || e.id === 'mp:8'), 'hidden in the Evidence view');
  // counted: the group's extra (ungrouped here) and the HUD counts
  const groups = groupState(st, ev, cam, 1000);
  assert.equal(groups['ss:sun'].grouped, false); assert.deepEqual(groups['ss:sun'].extra, { asteroid: 2 });
  assert.equal(visibleCounts(ev, groups).counts.asteroid, 2); assert.equal(visibleCounts(ev).counts.asteroid, undefined);
  assert.equal(visibleCounts(vis, groupState(st, vis, cam, 1000)).counts.asteroid, 2, 'no double count in the normal view');
  assert.equal(groups['ss:sun'].count, 4);
  // the marker: alpha and colour
  const pts = markerPoints(vis, {}, cam), ent = (id) => vis.findIndex((e) => e.id === id);
  const k = ent('mp:7'), mk = ent('ss:mars');
  assert.ok(Math.abs(pts[8 * k + 4] - GREY_ALPHA) < 1e-6); assert.ok(Math.abs(pts[8 * mk + 4] - 1) < 1e-6);
  const c = g7.spec.color(g7.o), want = greyRgb(c); assert.ok(Math.abs(pts[8 * k + 5] - want[0]) < 1e-6);
  assert.ok(Math.max(...want) - Math.min(...want) < Math.max(...c) - Math.min(...c), 'desaturated');
  // labels end in (extrapolated), without the illustrative glyph
  const L = labelCandidates(vis, {}, { project: () => [10, 10], framePos: (e) => framePos(e, cam) }).filter((l) => /Seven|Eight/.test(l.text));
  assert.deepEqual(L.map((l) => l.text).sort(), ['Eight (extrapolated)', 'Seven (extrapolated)']); assert.ok(L.every((l) => l.greyed === true));
  const pk = pickObjects(vis, {}, 10, 10, 50, { project: () => [10, 10], framePos: (e) => framePos(e, cam) });
  assert.ok(pk);
});

test('a moving record whose drawn placement is illustrative ends its label in the illustrative glyph', () => {
  const st = store5([earth5, exo('nea:b', { host: HOST, name: 'TRAPPIST-1 b', evidence: 'illustrative' }), hostStar()]);
  st.setHostResolver(resolver({ [HOST]: HOST }, { [HOST]: HOST_PC }));
  const cam = F.makeCam({ frame: 'system', host: { key: HOST, pc: HOST_PC }, pos: [0.01, 0, 0] });
  const vis = visibleObjects(st, { layers: defaultLayers(), evidence: false, frame: 'system', inHost: (h) => h === HOST });
  assert.equal(vis.length, 1);
  const L = labelCandidates(vis, {}, { project: () => [1, 1], framePos: (e) => framePos(e, cam) });
  assert.equal(L[0].text, 'TRAPPIST-1 b ◌'); assert.equal(L[0].greyed, undefined);
  const still = rec('mp:9', 'asteroid', 'Still', [1, 1, 0], { evidence: 'illustrative', in_cone: true });
  const st2 = store5([earth5, still]), vis2 = visibleObjects(st2, gctx());
  assert.equal(labelCandidates(vis2, {}, { project: () => [1, 1], framePos: (e) => framePos(e, F.makeCam({ pos: [0, 0, 0] })) })[0].text, 'Still', 'no mover, no glyph');
});

test('motionItems feeds motionSummary: planets, small bodies beyond their range, exoplanets and black holes with their evidence', () => {
  const trio = ['b', 'c', 'd'].map((n) => exo(`nea:${n}`, { host: HOST, name: `TRAPPIST-1 ${n}` }));
  const cyg = bh('bh:Cyg X-1', { host: HOST, parent: HOST, name: 'Cyg X-1', evidence: 'illustrative', position: { ...bh('x').position, tier: 'illustrative', elements: bhEl({ node_deg: null, t_peri_mjd: null }) } });
  const st = store5([sun5, earth5, mercury, kep('mp:7', 'Seven'), kep('mp:8', 'Eight'), ...trio, cyg, hostStar()]);
  st.setHostResolver(resolver({ [HOST]: HOST }, { [HOST]: HOST_PC }));
  st.setTime(P5_MJD + 400, { hosts: [HOST] });
  const vis = [...visibleObjects(st, gctx()), ...visibleObjects(st, { layers: defaultLayers(), evidence: false, frame: 'system', inHost: (h) => h === HOST })].filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i);
  const items = st.motionItems(vis);
  const m = motionSummary(items);
  assert.match(m.text, /^Moving: 1 planet \(ephemeris\)/); assert.match(m.text, /2 small bodies \(SkyBoT orbits, ±1 yr; 2 beyond their range\)/);
  assert.match(m.text, /3 exoplanets ◌/); assert.match(m.text, /1 black hole ◌ \(no phase epoch published\)/);
  assert.equal(m.counts.beyond, 2); assert.equal(items.find((i) => i.kind === 'black_hole').illustrative, true);
  assert.deepEqual(st.motionItems([]), []);
});

// the general evidence rule for hosted kinds (section 20.8)
const sevenOf = (host, o = {}) => ['b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => exo(`nea:T1 ${n}`, { host, name: `TRAPPIST-1 ${n}`, ...o }));
const galStore = (hostRec, planets) => {
  const st = store5([earth5, ...planets, hostRec]);
  st.setHostResolver(resolver({ [hostRec.id]: hostRec.id }, { [hostRec.id]: HOST_PC }));
  return st;
};
const farCam = () => F.makeCam({ pos: [0, 0, 0] });

test('TRAPPIST-1 · 7 exoplanets shows as a group marker in the Evidence view (illustrative planets, measured host) and counts on the HUD', () => {
  const st = galStore(hostStar(), sevenOf(HOST)), cam = farCam();
  for (const evidence of [false, true]) {
    const vis = visibleObjects(st, gctx({ evidence })), g = groupState(st, vis, cam, 1000)[HOST];
    assert.equal(vis.filter((e) => e.kind === 'exoplanet').length, evidence ? 0 : 7);
    assert.equal(g.grouped, true); assert.equal(g.label, 'TRAPPIST-1 · 7 exoplanets'); assert.equal(g.evidence, 'measured'); assert.equal(g.hidden, false); assert.equal(g.hollow, false);
    assert.equal(markerPoints(vis, { [HOST]: g }, cam).length, 8, 'one solid group marker');
    assert.ok(markerPoints(vis, { [HOST]: g }, cam)[3] > 0);
    assert.equal(labelCandidates(vis, { [HOST]: g }, { project: () => [1, 1], framePos: (e) => framePos(e, cam) }).filter((l) => l.text === 'TRAPPIST-1 · 7 exoplanets').length, 1);
    assert.ok(pickObjects(vis, { [HOST]: g }, 1, 1, 50, { project: () => [1, 1], framePos: (e) => framePos(e, cam) }).sel.kind === 'group');
    assert.equal(visibleCounts(vis, { [HOST]: g }).counts.exoplanet, 7, 'the HUD counts them in both views');
  }
  assert.equal(hostCountText(st, HOST, { evidence: true, layers: {} }), '7 exoplanets (positions illustrative, hidden in the Evidence view)', 'unchanged');
});

test('a derived host draws a hollow group marker in both views; an illustrative host hides it in the Evidence view only', () => {
  const cam = farCam();
  const derived = galStore(hostStar(HOST, { evidence: 'derived' }), sevenOf(HOST));
  for (const evidence of [false, true]) {
    const vis = visibleObjects(derived, gctx({ evidence })), g = groupState(derived, vis, cam, 1000)[HOST], pts = markerPoints(vis, { [HOST]: g }, cam);
    assert.equal(g.hollow, true); assert.equal(g.hidden, false); assert.equal(pts.length, 8); assert.ok(isHollowSize(pts[3]) && Math.abs(pts[3]) >= 8);
  }
  const ill = galStore(hostStar(HOST, { evidence: 'illustrative' }), sevenOf(HOST));
  const nv = visibleObjects(ill, gctx({ evidence: false })), gn = groupState(ill, nv, cam, 1000)[HOST];
  assert.equal(gn.hidden, false); assert.equal(markerPoints(nv, { [HOST]: gn }, cam).length, 8);
  const ev = visibleObjects(ill, gctx({ evidence: true })), ge = groupState(ill, ev, cam, 1000)[HOST];
  assert.equal(ge.grouped, true); assert.equal(ge.hidden, true); assert.equal(markerPoints(ev, { [HOST]: ge }, cam).length, 0);
  assert.equal(labelCandidates(ev, { [HOST]: ge }, { project: () => [1, 1], framePos: (e) => framePos(e, cam) }).length, 0);
  assert.equal(pickObjects(ev, { [HOST]: ge }, 1, 1, 50, { project: () => [1, 1], framePos: (e) => framePos(e, cam) }), null);
  assert.equal(visibleCounts(ev, { [HOST]: ge }).counts.exoplanet, undefined, 'a hidden group adds no count');
  assert.equal(groupState(ill, ev, cam, 1000, 8, { evidence: false })[HOST].hidden, false, 'opts.evidence overrides the store flag');
});

test('the Sun\'s group is the same in both views: measured, solid, never hidden', () => {
  const st = store([sun, earth, mars, jupiter, ceres, astIn, comet]), cam = F.makeCam({ pos: [1, 0, 0] });
  for (const evidence of [false, true]) {
    const g = groupState(st, visibleObjects(st, gctx({ evidence })), cam, 1000)['ss:sun'];
    assert.deepEqual([g.grouped, g.evidence, g.hollow, g.hidden, g.count], [true, 'measured', false, false, 6]);
  }
});

test('a resolved system draws each record with its own evidence: illustrative hidden and derived hollow in the Evidence view', () => {
  const planets = [exo('nea:m', { host: HOST, evidence: 'measured' }), exo('nea:d', { host: HOST, evidence: 'derived' }), exo('nea:i', { host: HOST, evidence: 'illustrative' })];
  const st = galStore(hostStar(), planets);
  const cam = F.makeCam({ frame: 'system', host: { key: HOST, pc: HOST_PC }, pos: [0.01, 0, 0] });
  const sys = (evidence) => visibleObjects(st, { layers: defaultLayers(), evidence, frame: 'system', inHost: (h) => h === HOST });
  assert.deepEqual(sys(true).map((e) => e.id).sort(), ['nea:d', 'nea:m']);
  assert.equal(sys(false).length, 3); assert.equal(sys(true).find((e) => e.id === 'nea:d').spec.markerStyle({ evidence: 'derived' }), 'hollow');
  // close in the galaxy frame it is resolved too: the group is not drawn and each marker keeps its own style
  const near1 = F.makeCam({ pos: HOST_PC.map((v) => v * (1 - 1e-12)) }), vis = visibleObjects(st, gctx({ evidence: true })), g = groupState(st, vis, near1, 1000)[HOST];
  assert.equal(g.grouped, false); assert.equal(g.count, 3); assert.equal(visibleCounts(vis, { [HOST]: g }).counts.exoplanet, 2, 'only the drawn ones, resolved');
});

test('the spread is the orbit size a(1 + e): a system groups and ungroups at the same distance whatever the date or the phase', () => {
  const wide = exo('nea:w', { host: HOST }, { a_au: q(50, 'au', 'catalogue'), e: q(0.8), period_d: q(100000, 'd') });
  const st = galStore(hostStar(), [wide]);
  assert.ok(Math.abs(st.recs.find((r) => r.id === 'nea:w').orbitAu - 90) < 1e-9, 'a (1 + e) = 90 AU');
  const pxPerRad = 1000, dist = 90 * pxPerRad / 8;                                          // exactly 8 px of spread
  const camAt = (au) => F.makeCam({ pos: HOST_PC.map((v, i) => v - (i === 0 ? au / AU : 0)) });
  const grouped = (cam) => groupState(st, visibleObjects(st, gctx()), cam, pxPerRad)[HOST].grouped;
  for (const dt of [0, 9000, 17000, 31000]) {
    st.setTime(P5_MJD + dt, { hosts: [HOST] });
    assert.equal(grouped(camAt(dist * 1.02)), true, `grouped from far away at +${dt} d`); assert.equal(grouped(camAt(dist * 0.98)), false, `resolved nearer at +${dt} d`);
  }
});

test('records of a host whose layer is off are not in its group; the layers of the last visibleObjects call are the default', () => {
  const st = galStore(hostStar(), sevenOf(HOST)), cam = farCam();
  const vis = visibleObjects(st, gctx({ layers: { ...defaultLayers(), exoplanets: false } }));
  assert.equal(groupState(st, vis, cam, 1000)[HOST], undefined);
  assert.equal(groupState(st, vis, cam, 1000, 8, { layers: {} })[HOST].count, 7, 'explicit layers win');
});
