// Scene3D: WebGL2 renderer and fly controls for scene3d.html.
//
// One camera model (yaw and pitch, world +z is celestial north) and three levels of frame (scene3d-frames.js):
//   galaxy - parsecs, origin at the Sun: Gaia stars at their parallax distances plus the bright XHIP stars
//   system - AU, origin at a host star (the Sun included): the host is a sphere, and the Sun's planets are spheres too
//   cosmos - megaparsecs, origin at the Sun, entered beyond 60 kpc: galaxies, the Milky Way and supermassive black holes only (section 18.5). What has no
//            cosmos renderer (stars, clusters, nebulae, ...) fades out with galaxyFade between 20 and 40 kpc, so it is gone before the frame switches.
// Everything is drawn camera-relative. Stars are additive points; stars near the camera and the planets are drawn from
// positions computed in doubles; bodies big enough to see as discs are ray-traced spheres (impostors) on screen quads.
// Scene brightness goes into an RGBA16F target (when the browser can) and is bloomed and tonemapped at the end.
import * as M from './scene3d-math.js';
import * as F from './scene3d-frames.js';
import { starModel, granulation } from './scene3d-physics.js';
import { Autopilot, arrivalDistance, suggestSpeed, TURN_SECONDS, autoThrottleSpeed, keepOutside, headingWeight, corridorDistance, THROTTLE, carrySpeed } from './scene3d-nav.js';
import { renderStarCard, renderBodyCard } from './scene3d-card.js';
import { loadLayers, saveLayers, layerOf, kindSpec, layers as layerDefs, fmtNum as regFmtNum, childGroups, preferredStarDistance, preferredDistanceRows, gaiaDataRow, isMilkyWay } from './scene3d-registry.js';
import { ObjectStore, visibleObjects, framePos, groupState, groupTarget, pickObjects, choosePick, labelCandidates, planGo, hostCountText, kindsPhrase,
  objectStarParams, starValuesFromRecord, resolveStarAliases, preferredStarPlacement, starSignature, billboardItems, lensingItems, markerPoints, mergeStarSystem,
  MW_FADE_PC, skyFadeOf, fromYouFor, visibleCounts, galaxyFade, withSmbh, presenceOf, GALAXY_PICK_MIN } from './scene3d-objects.js';
import { galaxyQuad, galaxySurfacePc, GALAXY_VERTEX_FLOATS } from './scene3d-galaxy.js';
import { fmtDistPc } from './scene3d-format.js';
import { orbitPath } from './scene3d-orbits.js';
import { makeProgram, supportsHdr, HdrChain } from './scene3d-gl.js';
import * as S from './scene3d-shaders.js';
import { getSystem } from '../api.js';

const { D2R, LY_PER_PC: LY, V_EXPO } = M;
const { AU_PER_PC } = F;
const XHAIR_DEG = 2, XHAIR_MS = 100;            // crosshair target readout: pick radius and refresh interval
const CONE_DIST = 3000;          // pc, the distance at which the cone-edge ring is drawn
const CORE_SIGMA_PX = 0.42;      // CSS px: gaussian sigma of a faint star's core (it is integrated over each pixel)
const LIMIT_DEFAULT = 12, LIMIT_MIN = 0, LIMIT_MAX = 25;
const MAX_LABELS = 40;
const PICK_PX = 10, GO_DEG = 2;
const NEAR_PC = 0.05;            // stars this close to the camera are drawn exactly and may become spheres
// Milky Way glow (frontend/data/milkyway.webp, see backend/scripts/build_milkyway.py). MW_K sets its brightness against
// the stars at the default limit and exposure; it brightens with the limit by the same sqrt-of-flux law as the stars.
// The map is the sky seen from the Sun, so it fades out once the camera is a few hundred parsecs away.
const MW_URL = './data/milkyway.webp', MW_K = 0.11;
// Arriving from and leaving for a flat picture (the sphere or the frames), see intro() and flatten().
const INTRO_S = 3.2, FLATTEN_S = 1.3;
const REVEAL_REF = 0.3;          // the dolly zoom keeps stars at this fraction of the median Gaia distance in place
// the sky page's picture over the canvas fades over SNAP_FADE_S once the camera moves, SNAP_DROP_S when the controls are taken
const SNAP_FADE_S = 1.2, SNAP_DROP_S = 0.25;
const SUN_ABS_G = 4.67, SUN_BP_RP = 0.82;
const Z_UP = [0, 0, 1];
const SUN_HOST = { idx: 0, key: 'ss:sun', name: 'Sun', pc: [0, 0, 0] };
const GROUP_RGB = [1.0, 0.92, 0.75], GROUP_PX_SIZE = 8;
// Cluster glow brightness: BB_K x the exposure (capped), so a glow stays a faint wash even in a dark, high-exposure view. The Evidence
// ring is a thin line, drawn at a fixed linear level (not scaled by the exposure: a bright star nearby drives the exposure down and a
// scaled ring vanished with it).
const BB_GLOW_K = 0.08, BB_GLOW_MAX = 0.16, BB_RING = 0.4;
// Nebula glows (illustrative look): NEB_K x the exposure, capped, like the cluster glows; the Evidence outline is at a fixed level (BB_RING).
// The dark pass multiplies its alpha by NEB_DARK (it only darkens the Milky Way glow behind it).
const NEB_K = 0.45, NEB_MAX = 0.9, NEB_DARK = 1.6, NEB_QUAD = 1.3, NEB_PX_MAX = 2e5, LOOK_TURN_S = 0.8;
const GAL_K = NEB_K, GAL_MAX = NEB_MAX;   // galaxy glows: the nebulae's brightness law (illustrative), the same exposure factor and cap
const WORLD_TRIPS = new Set(['star', 'galaxy', 'point']);   // autopilot trips in world parsecs: they cross frame switches
const FLY_POINT_STOP_PC = 1;   // a flight to a point (the Milky Way's face-on view) ends this far from it
const LENS_PX_MAX = 2e4;   // a drawn shadow is never wider than this (CSS px) however close the camera is
const NEB_MODE = { emission: 0, reflection: 1, planetary: 2, snr: 3, dark: 4 };   // the nebula shader's a_mode (10 and 11: Evidence outline, solid and dashed)
// No Ctrl here: holding Ctrl while pressing W would close the tab.
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerpLog = (a, b, t) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);
/** Unit vectors a to b along the great circle, t in 0..1. */
function slerp(a, b, t) {
  const w = Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1));
  if (w < 1e-6) return b.slice();
  const s = Math.sin(w), ka = Math.sin((1 - t) * w) / s, kb = Math.sin(t * w) / s;
  return [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];
}
/** Number for the readout: 3 significant figures, with thousands separators. */
export const fmtNum = regFmtNum;
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// Vertex layouts (floats): stars 7 = x y z abs r g b; points 8 = x y z size alpha r g b; lines 7 = x y z r g b a.
const STRIDE = { stars: 28, points: 32, lines: 28 };

/** Expand polylines into GL_LINES segments with one colour. Returns { data, n }. */
function linesToBuf(polys, [r, g, b, a]) {
  let n = 0;
  for (const p of polys) n += Math.max(0, p.length - 1) * 2;
  const data = new Float32Array(n * 7);
  let k = 0;
  for (const p of polys) {
    for (let i = 0; i < p.length - 1; i++) {
      for (const q of [p[i], p[i + 1]]) { data.set([q[0], q[1], q[2], r, g, b, a], k); k += 7; }
    }
  }
  return { data, n };
}
export class Scene3D {
  /**
   * canvas: WebGL canvas. labels: 2D canvas laid over it. card: element for the picked-object card.
   * ra, dec, radius: the patch (degrees). Throws if WebGL2 is unavailable or a shader fails to build.
   */
  constructor({ canvas, labels, card, ra, dec, radius = 3, onHud = () => {}, onScene = () => {}, onLost = () => {}, onEvidence = () => {}, onLayers = () => {} }) {
    this.canvas = canvas; this.labelsEl = labels; this.lab = labels.getContext('2d'); this.card = card;
    this.target = { ra, dec, radius };
    this.fovStars = clamp(radius * 2.5, 20, 70);
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.hooks = { onHud, onScene, onLost, onEvidence, onLayers };
    this.cpu = {}; this.gpu = {};
    this.limit = LIMIT_DEFAULT; this.evidence = false; this.bloomK = 1; this.bloomT = 0.45;
    this.ctx = []; this.gaia = null; this.namedIdx = [];
    this.layers = loadLayers();                                  // {layerId: bool}, saved in localStorage
    this.store = new ObjectStore();                              // planets, the Moon, small bodies (later catalogues): /api/objects
    this._ver = 0;                                               // bumps when layers, evidence or objects change (the pick cache key)
    this._vis = []; this._groups = {}; this._warned = new Set(); this.pxPerRad = 1;
    this._visAll = []; this._bb = []; this._gf = 1;            // _visAll: every visible entry; _vis: the same minus the supermassive black holes not resolved (smbhVisible); _bb: this frame's billboard items; _gf: galaxyFade
    this.st = { n: 0, pos: new Float64Array(0), data: new Float32Array(0), gal: new Float32Array(0), meta: [] };
    this.counts = { gaia: 0, ctx: 0, obj: 0 };
    this.keys = new Set(); this.touch = new Map(); this.pinch = null;
    this.hover = null; this.sel = null; this.locked = false;
    this.sys = new Map(); this.models = new Map();
    this._keyIdx = new Map(); this._alias = new Map(); this._starSig = null;   // star key -> idx, record id or alias -> key, star records seen (see _rebuildStars)
    this._visSig = ''; this._bufHost = null;                   // what _vis and the per-host buffers (points, lineSys) were built for
    this.ap = null; this.dyn = new Map(); this.cands = [];
    this.dpr = 1; this.cssW = 1; this.cssH = 1; this.vp = new Float32Array(16); this.R = M.lookRotation([1, 0, 0]);
    this.expo = 1; this.expoTarget = 1; this.vScan = 0; this.scanN = 0; this.hdrBad = false;
    this.lost = false; this.running = false; this._last = 0; this._hudT = 0; this._cardT = 0; this._cardSig = ''; this._raf = 0;
    this._pickSig = ''; this._pickSel = null; this._frameNo = 0; this._t = 0;
    this.autoSpeed = true; this.throttle = THROTTLE.def;       // auto-throttle: speed = throttle x distance to the nearest surface
    this._near = null; this._nearNo = -1; this._xh = null; this._xhT = -1e9; this._lastWorld = null; this.speedPc = 0;
    this._intro = null; this._outro = null; this._arrival = null;   // camera animations to and from a flat picture
    this._snap = null;                                               // the flat picture laid over the canvas (showSnap)
    this._frame = this._frame.bind(this);
    this._pj = (rel) => this._proj(rel); this._pjAll = (rel) => this._projAll(rel); this._fp = (e) => framePos(e, this.cam);   // closures for the object helpers
    this.cam = this._startCam('stars');
    this.fov = this.fovStars;
    this._initGL();
    this.mwImg = null;                                           // the glow is optional: without it the sky is black
    const loadSky = (tries) => fetch(MW_URL).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.blob(); })
      .then((bl) => createImageBitmap(bl))
      .then((bm) => { this.mwImg = bm; if (!this.lost) this._uploadSky(); })
      .catch(() => { if (tries > 0) setTimeout(() => loadSky(tries - 1), 3000); });
    loadSky(2);
    const cone = linesToBuf(M.coneLines(ra, dec, radius, CONE_DIST), [1, 0.82, 0.55, 0.4]);
    this._put('lineStars', cone.data, cone.n);
    this._refreshVisible();
    this._rebuildStars();
    this._bind();
  }

  // ------------------------------------------------------------------ GL setup
  _initGL() {
    const gl = this.gl;
    this.useHdr = !this.hdrBad && supportsHdr(gl);
    this.hdr = this.useHdr ? new HdrChain(gl) : null;
    const d = this.useHdr ? '' : '#define LDR\n';
    this.prog = {
      star: makeProgram(gl, S.STAR_VS, S.STAR_FS, S.SPRITE_UNIFORMS_STAR, d),
      point: makeProgram(gl, S.POINT_VS, S.SPRITE_FS, ['u_vp', 'u_eye', 'u_dpr'], d),
      line: makeProgram(gl, S.LINE_VS, S.LINE_FS, ['u_vp', 'u_eye', 'u_a'], d),
      body: makeProgram(gl, S.BODY_VS, S.BODY_FS, S.BODY_UNIFORMS, d),
      sky: makeProgram(gl, S.SKY_VS, S.SKY_FS, ['u_tan', 'u_sky', 'u_v2w', 'u_k'], d),
      bb: makeProgram(gl, S.BB_VS, S.BB_FS, ['u_vp', 'u_k', 'u_dpr'], d),
      nebula: makeProgram(gl, S.NEBULA_VS, S.NEBULA_FS, ['u_k', 'u_dpr'], d),
      galaxy: makeProgram(gl, S.GALAXY_VS, S.GALAXY_FS, ['u_k'], d),
      lens: makeProgram(gl, S.LENS_VS, S.LENS_FS, [], d),
    };
    this.skyTex = null;
    if (this.mwImg) this._uploadSky();
    this.vaoEmpty = this.hdr ? this.hdr.vao : gl.createVertexArray();
    this.dynBuf = { stars: gl.createBuffer(), points: gl.createBuffer(), bb: gl.createBuffer(), nebula: gl.createBuffer(), galaxy: gl.createBuffer(), lens: gl.createBuffer() };
    this.maxPt = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
    this.gpu = {};
  }
  _uploadSky() {
    const gl = this.gl, tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, this.mwImg);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.skyTex = tex;
  }
  /** Store CPU data under key and upload it (skipped while the context is lost; restore uploads it again). */
  _put(key, data, n) { this.cpu[key] = { data, n }; this._upload(key); }
  _upload(key) {
    const gl = this.gl, src = this.cpu[key];
    if (!src || this.lost) return;
    const old = this.gpu[key];
    if (old) gl.deleteBuffer(old.b);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, src.data, gl.STATIC_DRAW);
    this.gpu[key] = { b, n: src.n };
  }
  _bind() {
    const c = this.canvas;
    this._h = {
      kd: (e) => this._key(e, true), ku: (e) => this._key(e, false), blur: () => this.keys.clear(),
      pd: (e) => this._pdown(e), pm: (e) => this._pmove(e), pu: (e) => this._pup(e),
      pl: (e) => { if (e.pointerType !== 'touch') this.hover = null; },
      wheel: (e) => this._wheel(e), mm: (e) => { if (this.locked) this._look(e.movementX, e.movementY); },
      plc: () => this._lockChange(), lost: (e) => this._onLost(e), restored: () => this._onRestored(),
    };
    window.addEventListener('keydown', this._h.kd); window.addEventListener('keyup', this._h.ku); window.addEventListener('blur', this._h.blur);
    document.addEventListener('mousemove', this._h.mm); document.addEventListener('pointerlockchange', this._h.plc);
    c.addEventListener('pointerdown', this._h.pd); c.addEventListener('pointermove', this._h.pm);
    c.addEventListener('pointerup', this._h.pu); c.addEventListener('pointercancel', this._h.pu);
    c.addEventListener('pointerleave', this._h.pl);
    c.addEventListener('wheel', this._h.wheel, { passive: false });
    c.addEventListener('webglcontextlost', this._h.lost); c.addEventListener('webglcontextrestored', this._h.restored);
  }
  dispose() {
    const c = this.canvas, h = this._h;
    window.removeEventListener('keydown', h.kd); window.removeEventListener('keyup', h.ku); window.removeEventListener('blur', h.blur);
    document.removeEventListener('mousemove', h.mm); document.removeEventListener('pointerlockchange', h.plc);
    c.removeEventListener('pointerdown', h.pd); c.removeEventListener('pointermove', h.pm);
    c.removeEventListener('pointerup', h.pu); c.removeEventListener('pointercancel', h.pu); c.removeEventListener('pointerleave', h.pl);
    c.removeEventListener('wheel', h.wheel); c.removeEventListener('webglcontextlost', h.lost); c.removeEventListener('webglcontextrestored', h.restored);
    this.running = false; cancelAnimationFrame(this._raf);
  }

  // ------------------------------------------------------------------ data
  /** Context stars (from M.contextStars). Inside the Gaia cone, those Gaia also has are dropped once its data arrives. */
  setContext(list) { this.ctx = list || []; this._rebuildStars(); }
  /** Gaia payload: the `stars` object of /api/scene3d. */
  setGaia(payload) {
    if (!payload || !Array.isArray(payload.rows)) return;
    const f = payload.fields || [];
    const I = {};
    for (const k of ['id', 'x', 'y', 'z', 'abs_g', 'bp_rp', 'd_lo', 'd_hi']) I[k] = f.indexOf(k);
    const near = (r, c) => {
      const d = Math.hypot(r[I.x], r[I.y], r[I.z]) || 1, cu = M.radecToXyz(c.ra, c.dec, 1);
      const cosSep = (r[I.x] * cu[0] + r[I.y] * cu[1] + r[I.z] * cu[2]) / d;
      if (cosSep < Math.cos(2 / 60 * D2R)) return false;
      return Math.abs(M.apparentMag(r[I.abs_g], d) - c.vmag) < 1.5;
    };
    this.gaia = { rows: payload.rows, I, match: (c) => payload.rows.some((r) => near(r, c)) };
    this._rebuildStars();
  }
  /**
   * Objects payload: the response of /api/objects (schema space-maps.objects/1). Replaces what was there. Returns the
   * store's ingest result ({ ok, unknownKinds } or { ok: false, error }) so the page can say when the schema is too new.
   */
  setObjects(payload) {
    const r = this.store.ingest(payload);
    this._ver++; this._pickSig = ''; this._near = null;
    const e = this._earthAu();
    let cb = { data: new Float32Array(0), n: 0 };
    if (e) {
      const { ra, dec, radius } = this.target;
      cb = linesToBuf(M.coneLines(ra, dec, radius, 8).map((pl) => pl.map((q) => [q[0] + e[0], q[1] + e[1], q[2] + e[2]])), [1, 0.82, 0.55, 0.4]);
    }
    this._put('coneSolar', cb.data, cb.n);
    if (this.scene === 'solar') this.cam = this._startCam('solar');
    // Objects usually land before Gaia. The host stars they bring (and the host resolver that needs them) change only with
    // the set of star records, so an unchanged set skips the rebuild; the resolver closes over this._alias and this._keyIdx.
    if (starSignature(this.store.stars) !== this._starSig) this._rebuildStars();
    else this._refreshObjectBuffers();
    return r;
  }
  /** Visible entries and the per-host buffers (points, orbit lines) after the objects, layers, evidence, frame or host changed. */
  _refreshObjectBuffers() { this._refreshVisible(); this._refreshGroups(); this._rebuildPoints(); this._rebuildLines(); }
  /** Earth's heliocentric position in AU from its record (the patch's cone is drawn around it), or null. */
  _earthAu() {
    const p = this.store.earth && this.store.earth.position.xyz_au;
    return Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite) ? p.slice(0, 3) : null;
  }
  /** The star key of the camera's system frame, or null in the galaxy frame. */
  _hostKey() { return this.cam.frame === 'system' ? this.cam.host.key : null; }
  /**
   * The static point buffer for the camera's current host: its visible 'point' entries in AU (small bodies of the Sun, exoplanets
   * without a radius). Empty in the galaxy frame. Rebuilt when layers, evidence, data, the frame or the host change.
   */
  _rebuildPoints() {
    this._refreshVisible();
    const key = this._hostKey(), pts = [];
    if (key) {
      for (const e of this._vis) {
        if (e.renderer !== 'point') continue;
        const c = e.spec.color(e.o);
        pts.push(e.sysAu[0], e.sysAu[1], e.sysAu[2], e.spec.pointSize(e.o), 0.9, c[0], c[1], c[2]);
      }
    }
    this._bufHost = key;
    this._put('points', new Float32Array(pts), pts.length / 8);
  }
  /**
   * The orbit lines for the camera's current host (buffer lineSys, AU relative to the host). The Sun: a circle per Sun-hosted
   * planet. Another star: the ellipse of each of its exoplanets (orbitPath), only with the exoplanets layer on and never in the
   * Evidence view, because the orientation of those orbits is illustrative. The orbits layer is checked when drawing.
   */
  _rebuildLines() {
    const key = this._hostKey(), polys = [];
    if (key === SUN_HOST.key) {
      for (const o of this.store.byKind.get('planet') || []) {      // the Moon travels with Earth: it has no orbit of its own
        const p = o.host === SUN_HOST.key && this.store.placement(o.id);
        if (p && p.sysAu) polys.push(M.orbitCircle(Math.hypot(p.sysAu[0], p.sysAu[1], p.sysAu[2])));
      }
    } else if (key && !this.evidence) {
      for (const o of this.store.childrenOf(key)) {
        const spec = kindSpec(o.kind), l = spec && spec.layer;
        if (!spec || !spec.hosted || (l && this.layers[l] === false)) continue;
        const path = orbitPath(o);
        if (path.length) polys.push(path);
      }
    }
    const lines = linesToBuf(polys, key === SUN_HOST.key ? [0.6, 0.7, 0.95, 0.18] : [0.55, 0.75, 0.9, 0.3]);
    this._put('lineSys', lines.data, lines.n);
  }
  get hasSolar() { return this.store.hasSolar; }
  /** The kinds' layers are toggles: turning one off hides its objects, labels and picks, and clears a selection in it. */
  setLayer(id, on) {
    if (!(id in this.layers)) return;
    this.layers[id] = !!on;
    saveLayers(this.layers);
    this._ver++; this._pickSig = ''; this._near = null;
    this._refreshObjectBuffers();
    if (this.sel && this.sel.kind !== 'star' && (layerOf(this.sel.kind) === id && !on || !this._valid(this.sel))) { this.sel = null; this._cardSig = ''; }
    this.hooks.onLayers(this.layers);
  }
  /** 'solar' while the camera is in the Sun's system frame, otherwise 'stars'. */
  get scene() { return this._inSun() ? 'solar' : 'stars'; }
  get fovDeg() { return this.fov; }

  _rebuildStars() {
    const g = this.gaia, { ra, dec, radius } = this.target;
    // Gaia misses the brightest stars (saturation) and the parallax cut drops others, so a context star inside the cone
    // is dropped only when a Gaia star of similar brightness sits within 2' of it (2' covers decades of proper motion).
    const ctx = g ? this.ctx.filter((c) => M.separationDeg(c.ra, c.dec, ra, dec) >= radius || !g.match(c)) : this.ctx;
    const rows = g ? g.rows : [];
    const cap = 1 + rows.length + ctx.length + this.store.stars.size;   // the Sun is star 0; archive host stars (kind 'obj') come last
    const pos = new Float64Array(3 * cap), gal = new Float32Array(7 * cap), meta = [], named = [0], keyIdx = new Map();
    meta.push({ kind: 'sun', key: 'ss:sun', name: 'Sun', id: 'sun', abs: SUN_ABS_G, bp: SUN_BP_RP, d: 0 }); keyIdx.set('ss:sun', 0);
    gal[3] = SUN_ABS_G; gal.set(M.bpRpToRgb(SUN_BP_RP), 4);
    let k = 1;
    if (g) {
      const I = g.I;
      for (const r of rows) {
        const o = 7 * k, abs = Number.isFinite(r[I.abs_g]) ? r[I.abs_g] : 5, id = String(r[I.id]);
        pos[3 * k] = r[I.x]; pos[3 * k + 1] = r[I.y]; pos[3 * k + 2] = r[I.z];
        gal[o + 3] = abs; gal.set(M.bpRpToRgb(r[I.bp_rp]), o + 4);
        meta.push({ kind: 'gaia', key: 'gdr3:' + id, id, dlo: r[I.d_lo], dhi: r[I.d_hi], bp: r[I.bp_rp], abs, name: null });
        keyIdx.set('gdr3:' + id, k);
        k++;
      }
    }
    for (const c of ctx) {
      const o = 7 * k, p = M.radecToXyz(c.ra, c.dec, c.d);
      pos.set(p, 3 * k); gal[o + 3] = c.absMag; gal.set(M.bpRpToRgb(c.bpRp), o + 4);
      meta.push({ kind: 'ctx', key: 'hip:' + c.hip, hip: c.hip, name: c.name, d: c.d, vmag: c.vmag, bp: c.bpRp, abs: c.absMag });
      keyIdx.set('hip:' + c.hip, k);
      if (c.name) named.push(k);
      k++;
    }
    // Host stars from the objects payload that Gaia and the context stars lack. Their colour is an illustrative estimate from Teff.
    const { append, alias, prefer } = resolveStarAliases(this.store.stars, (key) => keyIdx.has(key));
    for (const rec of append) {
      const sp = objectStarParams(rec), o = 7 * k;
      pos.set(M.radecToXyz(sp.ra, sp.dec, sp.d), 3 * k); gal[o + 3] = sp.abs; gal.set(M.bpRpToRgb(sp.bp), o + 4);
      meta.push({ kind: 'obj', key: rec.id, id: rec.id, rec, name: rec.name || null, d: sp.d, abs: sp.abs, bp: sp.bp });
      keyIdx.set(rec.id, k);
      k++;
    }
    // prefer_record (section 17.8): a loaded star whose record carries a curated distance keeps its Gaia sky position and apparent G and takes the
    // curated distance (and the absolute magnitude that goes with it). The Bailer-Jones distance stays as meta.gaiaPc for the card.
    for (const [key, rec] of prefer) {
      const i = keyIdx.get(key), pl = i === undefined ? null : preferredStarPlacement(rec, { xyz: [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]], abs: gal[7 * i + 3] });
      if (!pl) continue;
      pos.set(pl.pos, 3 * i); gal[7 * i + 3] = pl.abs;
      Object.assign(meta[i], { abs: pl.abs, d: pl.d, gaiaPc: pl.gaiaPc, preferred: true });
    }
    const n = k;
    for (let i = 0; i < n; i++) { gal[7 * i] = pos[3 * i]; gal[7 * i + 1] = pos[3 * i + 1]; gal[7 * i + 2] = pos[3 * i + 2]; }
    this.st = { n, pos: pos.subarray(0, 3 * n), gal: gal.subarray(0, 7 * n), data: gal.subarray(0, 7 * n), meta };
    this._keyIdx = keyIdx; this._alias = alias; this._starSig = starSignature(this.store.stars);
    // The store resolves archive host ids (gdr3, hip, neahost, same_as) to the keys above and places their planets there.
    this.store.setHostResolver({ key: (id) => this._alias.get(id) || (this._keyIdx.has(id) ? id : null),
      pc: (key) => { const i = this._keyIdx.get(key); return i === undefined ? null : this._starPc(i); } });
    for (const [key, i] of keyIdx) {                              // a Gaia star that hosts planets takes the archive's name for it
      const m = meta[i], rec = m.kind === 'gaia' && !m.name ? this.store.starRecord(key) : null;
      if (rec && rec.name) m.name = rec.name;
    }
    this.namedIdx = named; this._pickSig = ''; this.models.clear(); this.dyn.clear();
    if (this.sel && this.sel.kind === 'star') this.sel = null;         // star indices changed; an object selection keeps its id
    if (this.ap && this.ap.type === 'star') this.ap = null;
    this.counts.gaia = rows.length; this.counts.ctx = ctx.length; this.counts.obj = append.length;
    if (this.cam.frame === 'system') {                           // the host's index may have moved
      const i = keyIdx.get(this.cam.host.key);
      this.cam.host = i === undefined ? { ...this.cam.host } : { ...this.cam.host, idx: i, pc: this._starPc(i) };
    }
    this._disarmIdx = null; this._near = null; this._ver++;
    this._syncStarFrame();
    this._refreshObjectBuffers();                                 // the resolver re-placed the hosted records
  }
  /**
   * Fill the star buffer for the camera's frame: parsecs in an unhosted frame (the galaxy frame draws them; the cosmos frame keeps the same buffer and
   * draws none, so a switch between those two uploads nothing), AU relative to the host in a system frame.
   */
  _syncStarFrame() {
    const st = this.st;
    if (!F.isHosted(this.cam.frame)) {
      st.data = st.gal;
      if (this.cpu.stars && this.cpu.stars.data === st.gal) return;
    } else {
      const d = new Float32Array(st.gal), h = this.cam.host.pc;
      for (let i = 0; i < st.n; i++) {
        d[7 * i] = (st.pos[3 * i] - h[0]) * AU_PER_PC; d[7 * i + 1] = (st.pos[3 * i + 1] - h[1]) * AU_PER_PC; d[7 * i + 2] = (st.pos[3 * i + 2] - h[2]) * AU_PER_PC;
      }
      st.data = d;
    }
    this._put('stars', st.data, st.n);
  }
  _starPc(i) { const p = this.st.pos; return [p[3 * i], p[3 * i + 1], p[3 * i + 2]]; }
  _starKey(i) { return this.st.meta[i].key; }
  /** Index of the star with this schema id ('ss:sun', 'gdr3:…', 'hip:…', or an archive host's id), or -1 when it is not loaded. */
  _starIdx(key) { const i = this._keyIdx.get(key); return i === undefined ? -1 : i; }
  _starSel(i) { return { kind: 'star', id: this._starKey(i), idx: i }; }
  _starName(i) {
    const m = this.st.meta[i], s = this.sys.get(m.key);
    if (s && s.payload && s.payload.name) return s.payload.name;
    return m.name || (m.kind === 'gaia' ? (/^Gaia/i.test(m.id) ? m.id : `Gaia DR3 ${m.id}`) : m.kind === 'obj' ? m.id : `HIP ${m.hip}`);
  }
  _modelFor(i) {
    let md = this.models.get(i);
    if (md) return md;
    const m = this.st.meta[i], s = this.sys.get(m.key), system = s && s.payload ? s.payload : undefined;
    const distPc = m.kind === 'sun' ? 0 : Math.hypot(...this._starPc(i));
    if (m.kind === 'sun') md = starModel({ kind: 'sun', system });
    // A star that hosts planets has an archive star record too. Per row (Teff, radius, luminosity, mass, age) the stronger tier wins,
    // so TRAPPIST-1 shows the archive's Teff and radius (catalogue) instead of this page's colour-based guesses (inferred).
    else if (m.kind === 'gaia') md = starModel({ system: mergeStarSystem(system, this.store.starRecord(m.key)), absG: m.abs, bpRp: m.bp, distPc, kind: 'gaia' });
    // An archive host: its physical rows are the record's props (tier and src kept); a Gaia payload, once fetched, is merged row by row. The BP-RP estimate only colours the point, so it is not passed here: it would read as measured.
    else if (m.kind === 'obj') md = starModel({ system: system ? mergeStarSystem(system, m.rec) : { values: starValuesFromRecord(m.rec), notes: [] }, absG: m.abs, distPc: m.d, kind: 'obj' });
    else md = starModel({ absG: m.abs, bpRp: m.bp, distPc: m.d, name: m.name, kind: 'ctx' });
    this.models.set(i, md);
    return md;
  }
  /** The system payload for a star (fetched once, cached): { state: 'loading' | 'ok' | 'error', payload, error }. Null for stars with none. */
  _system(i) {
    const m = this.st.meta[i];
    // Gaia sources (loaded, or archive hosts with a gdr3 id) have an /api/system payload; the context stars and other archive hosts do not
    const sid = m.kind === 'sun' ? 'sun' : m.kind === 'gaia' ? m.id : m.kind === 'obj' && m.id.startsWith('gdr3:') ? m.id.slice(5) : null;
    if (sid === null) return null;
    const key = m.key;
    let s = this.sys.get(key);
    if (s) return s;
    s = { state: 'loading', payload: null, error: null };
    this.sys.set(key, s);
    getSystem(sid).then((p) => { s.state = 'ok'; s.payload = p; }, (e) => { s.state = 'error'; s.error = e.message || String(e); })
      .finally(() => { const j = this._starIdx(key); if (j >= 0) this.models.delete(j); this._cardSig = ''; });
    return s;
  }

  // ------------------------------------------------------------------ scenes and camera
  _startCam(scene) {
    const { ra, dec } = this.target;
    const { yaw, pitch: p0 } = M.yawPitchFromDir(M.radecToXyz(ra, dec, 1));
    const pitch = clamp(p0, -1.5, 1.5);                         // same limit as mouse look: up = +z must not be parallel to the view
    if (scene === 'solar' && this.store.hasSolar) {
      // Near Earth, a little sunward and above the ecliptic, looking at it: the Moon, the Sun's glare and the orbits in view.
      const e = this._earthAu() || [1, 0, 0], eps = M.OBLIQUITY_DEG * D2R;
      const nep = [0, -Math.sin(eps), Math.cos(eps)];
      const toSun = M.norm(e.map((v) => -v)), side = M.norm(M.cross(nep, toSun));
      const off = M.norm([0, 1, 2].map((k) => 0.5 * toSun[k] + 0.8 * side[k] + 0.3 * nep[k]));
      const pos = [0, 1, 2].map((k) => e[k] + 0.004 * off[k]);
      const v = M.yawPitchFromDir(sub3(e, pos));
      return F.makeCam({ frame: 'system', host: SUN_HOST, pos, yaw: v.yaw, pitch: clamp(v.pitch, -1.5, 1.5), speed: 0.002 });
    }
    return F.makeCam({ pos: [0, 0, 0], yaw, pitch, speed: F.rangeOf('galaxy').speed, disarm: SUN_HOST.key });
  }
  setScene(name) {
    if (name === 'solar' && !this.store.hasSolar) return;
    if (this._outro) return;                                    // leaving the page: the camera is on its way out
    this._takeOver();
    this.ap = null; this.sel = null; this.hover = null; this.card.hidden = true; this._cardT = 0;
    this.cam = this._startCam(name);
    this._syncStarFrame(); this._ver++; this._pickSig = ''; this._near = null;
    this._refreshObjectBuffers();
    this.hooks.onScene(this.scene);
  }
  toggleScene() { this.setScene(this.scene === 'stars' ? 'solar' : 'stars'); }
  resetView() { this.setScene(this.scene); }
  setEvidence(on) {
    this.evidence = !!on; this._cardSig = ''; this._ver++; this._pickSig = '';
    this._refreshObjectBuffers();
    this.hooks.onEvidence(this.evidence);
  }
  toggleEvidence() { this.setEvidence(!this.evidence); }
  /** T: auto-throttle (speed follows the distance to the nearest surface) or the old fixed speed. */
  toggleAutoSpeed() {
    if (this.autoSpeed) { const r = F.rangeOf(this.cam.frame); this.cam.speed = clamp(this._cruise(), r.min, r.max); }   // carry the current speed over
    this.autoSpeed = !this.autoSpeed;
    this._hudT = 0;
  }

  // ------------------------------------------------------------------ controls
  _key(e, down) {
    const code = e.code;
    if (!down) { this.keys.delete(code); return; }
    if (e.metaKey) return;
    if (e.ctrlKey || e.altKey) return;                          // leave Ctrl+F, Ctrl+R and friends alone
    if (this._outro) return;                                    // leaving the page: no more steering
    this._takeOver();
    // Space and Enter press the focused button of a panel that owns its keys (the layers panel); flying keys still work there.
    const t = e.target;
    if ((code === 'Space' || code === 'Enter') && t && t.closest && t.closest('[data-own-keys]')) return;
    if (MOVE_KEYS.has(code)) { this.keys.add(code); this.ap = null; e.preventDefault(); return; }
    if (e.repeat) { if (code === 'Tab') e.preventDefault(); return; }
    if (code === 'Tab') { e.preventDefault(); this.toggleScene(); return; }
    if (code === 'KeyH') { this.resetView(); return; }
    if (code === 'KeyE') { this.toggleEvidence(); return; }
    if (code === 'KeyG') { this._goFromCrosshair(); return; }
    if (code === 'KeyT') { this.toggleAutoSpeed(); return; }
    if (code === 'Escape') {
      if (this.ap) this.ap = null;
      else if (!this.locked && this.sel) { this.sel = null; this._cardSig = ''; }
      return;
    }
    if (code === 'BracketLeft' || code === 'BracketRight') {
      this.limit = clamp(this.limit + (code === 'BracketRight' ? 0.5 : -0.5), LIMIT_MIN, LIMIT_MAX);
    }
  }
  _rel(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  _lock() {
    const c = this.canvas;
    if (!c.requestPointerLock) return;
    try { const p = c.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* not allowed here */ }
  }
  _lockChange() {
    this.locked = document.pointerLockElement === this.canvas;
    this.canvas.classList.toggle('locked', this.locked);
    this.hover = null;
  }
  _pdown(e) {
    if (this._outro) return;
    this._takeOver();
    if (e.pointerType === 'touch') {
      const p = this._rel(e);
      this.touch.set(e.pointerId, { x: p.x, y: p.y, moved: 0 });
      this.pinch = null;
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      return;
    }
    if (e.button !== 0 || this.locked) return;
    const p = this._rel(e), hit = this._pickAt(p.x, p.y, PICK_PX);
    if (hit) this._select(hit);        // a click on an object selects it; the pointer stays free
    else this._lock();                 // a click on empty sky starts flying
  }
  _pmove(e) {
    if (e.pointerType === 'touch') {
      const t = this.touch.get(e.pointerId); if (!t) return;
      const p = this._rel(e), dx = p.x - t.x, dy = p.y - t.y;
      t.x = p.x; t.y = p.y; t.moved += Math.hypot(dx, dy);
      if (this.touch.size === 1) this._look(dx, dy);
      else if (this.touch.size === 2) {
        const [a, b] = [...this.touch.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch !== null) this._dolly((d - this.pinch) * 0.02);   // spread fingers = forward
        this.pinch = d;
      }
      return;
    }
    if (!this.locked) this.hover = this._rel(e);
  }
  _pup(e) {
    if (e.pointerType !== 'touch') return;
    const t = this.touch.get(e.pointerId);
    this.touch.delete(e.pointerId); this.pinch = null;
    if (t && t.moved < 8 && this.touch.size === 0) { const hit = this._pickAt(t.x, t.y, PICK_PX); if (hit) this._select(hit); else { this.sel = null; this._cardSig = ''; } }
  }
  _look(dx, dy) {
    const cam = this.cam; if (!cam || this.ap) return;
    const s = this.fov * D2R * 0.008;                        // radians per pixel, scaled to the field of view
    cam.yaw -= dx * s;
    cam.pitch = clamp(cam.pitch - dy * s, -1.5, 1.5);
  }
  _dolly(amount) {
    const cam = this.cam, f = M.dirFromYawPitch(cam.yaw, cam.pitch);
    for (let i = 0; i < 3; i++) cam.pos[i] += f[i] * amount * this._cruise();
  }
  _wheel(e) {
    e.preventDefault();
    const cam = this.cam, r = F.rangeOf(cam.frame);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const k = Math.exp(-dy * 0.0015);                         // logarithmic: equal steps, equal ratios
    if (this.autoSpeed) this.throttle = clamp(this.throttle * k, THROTTLE.min, THROTTLE.max);
    else cam.speed = clamp(cam.speed * k, r.min, r.max);
    this._hudT = 0;
  }
  _step(dt) {
    const cam = this.cam; if (!cam || dt <= 0 || this.ap) return;
    const k = this.keys, boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 10 : 1;
    const f = M.dirFromYawPitch(cam.yaw, cam.pitch), r = M.norm(M.cross(f, Z_UP));
    const w = [0, 0, 0];
    const add = (v, s) => { for (let i = 0; i < 3; i++) w[i] += v[i] * s; };
    if (k.has('KeyW') || k.has('ArrowUp')) add(f, 1);
    if (k.has('KeyS') || k.has('ArrowDown')) add(f, -1);
    if (k.has('KeyD') || k.has('ArrowRight')) add(r, 1);
    if (k.has('KeyA') || k.has('ArrowLeft')) add(r, -1);
    if (k.has('KeyR') || k.has('Space')) add(Z_UP, 1);
    if (k.has('KeyF')) add(Z_UP, -1);
    const len = Math.hypot(w[0], w[1], w[2]);
    const target = len > 1e-9 ? w.map((v) => (v / len) * this._cruise() * boost) : [0, 0, 0];
    const a = 1 - Math.exp(-dt * 8);                       // velocity eases toward the target: no hard starts or stops
    for (let i = 0; i < 3; i++) { cam.vel[i] += (target[i] - cam.vel[i]) * a; cam.pos[i] += cam.vel[i] * dt; }
    if (cam.frame === 'system') {                           // never inside a body: stop at its shell, keep the sliding part
      const sp = this._nearBody().spheres;
      if (sp.length) cam.pos = keepOutside(cam.pos, sp);
    }
  }
  /** Free-flight cruise speed in frame units per second (before Shift): fixed, or throttle x distance to the nearest surface. */
  _cruise() {
    const cam = this.cam;
    if (!this.autoSpeed) return cam.speed;
    const u = F.unitsPerPc(cam), a = F.levelOf(cam.frame).autoPc;
    return autoThrottleSpeed(this._nearBody().dAhead, this.throttle, { min: a.min * u, max: a.max * u });
  }
  /**
   * The nearest surface to the camera, in frame units, cached per frame: { name, d, dAhead, spheres, starPc }. Unhosted frames: stars (while they are drawn,
   * galaxyFade > 0) and galaxies (galaxySurfacePc), in this frame's units, so the speed is one function of the scene on both sides of the 40 / 60 kpc switch;
   * starPc is the nearest star's surface in pc. System frame: the host, the Sun's planets and any other star. d is the plain nearest surface (the HUD shows it).
   * dAhead is what the auto-throttle uses: each surface's distance divided by headingWeight(angle from where you look),
   * so a star beside or behind you counts as farther, and you do not crawl past every star on the way to a faraway one
   * (stars farther than NEAR_PC count only when your path runs close to them, see corridorDistance).
   * Both frames use the same measure, so the speed is continuous across a frame switch. spheres (system frame only):
   * bodies to keep out of, { c, r } in frame units. The star the camera started in (disarmed) counts as at least
   * LEAVE_PC away for dAhead, so starting at the Sun is not a standstill.
   */
  _nearBody() {
    if (this._near && this._nearNo === this._frameNo) return this._near;
    const cam = this.cam, st = this.st, sys = cam.frame === 'system', u = F.unitsPerPc(cam), p = st.pos, spheres = [];
    const w = F.worldPc(cam), host = sys ? cam.host.idx : -1, r2 = NEAR_PC * NEAR_PC, f = M.dirFromYawPitch(cam.yaw, cam.pitch);
    if (cam.disarm && (!this._disarmIdx || this._disarmIdx.key !== cam.disarm)) {
      this._disarmIdx = { key: cam.disarm, idx: this._starIdx(cam.disarm) };
    }
    const dis = cam.disarm && this._disarmIdx ? this._disarmIdx.idx : -1;
    let raw = { name: null, d: Infinity }, ahead = Infinity;
    const eat = (name, d, dx, dy, dz, dist, floorD) => {       // d: surface distance, (dx,dy,dz): vector to the centre, dist: its length
      if (name !== undefined && d < raw.d) raw = { name, d };   // name undefined: counts for dAhead only
      const c = dist > 0 ? (dx * f[0] + dy * f[1] + dz * f[2]) / dist : 1;
      const e = Math.max(d, floorD || 0) / headingWeight(c);
      if (e < ahead) ahead = e;
    };
    let bi = -1, b2 = Infinity, ei = -1, e2 = Infinity, starPc = Infinity;
    const starsOn = sys || galaxyFade(cam) > 0;                // beyond 40 kpc the stars are not drawn, so they are not surfaces either (section 18.5.1)
    for (let i = 0; starsOn && i < st.n; i++) {
      if (i === host) continue;
      const dx = p[3 * i] - w[0], dy = p[3 * i + 1] - w[1], dz = p[3 * i + 2] - w[2], d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < b2) { b2 = d2; bi = i; }
      if (i === dis && !sys) continue;                         // handled below, with its floor
      // Stars beyond NEAR_PC brake you only if your path runs close to them (corridorDistance: interstellar cruising);
      // nearer ones use the gentle heading weight, the same one the host and planets use in the system frame, so the
      // speed stays continuous across the frame switch. (All in pc here: these are galaxy-frame star positions.)
      const dd = Math.sqrt(d2), along = dx * f[0] + dy * f[1] + dz * f[2];
      const e = d2 >= r2 ? corridorDistance(along, dd) : dd / headingWeight(dd > 0 ? along / dd : 1);
      if (e < e2) { e2 = e; ei = i; }
      if (sys && d2 < r2) {                                   // other stars close by, to keep out of
        const rAu = this._modelFor(i).radiusAu;
        spheres.push({ c: F.toSystemPos(this._starPc(i), cam.host.pc), r: rAu, idx: i });
      }
    }
    const rPcOf = (i, d2) => (d2 < r2 ? this._modelFor(i).radiusAu / AU_PER_PC : 0);
    if (sys) {
      for (const sp of spheres) {                             // the nearby stars, in AU
        const dx = sp.c[0] - cam.pos[0], dy = sp.c[1] - cam.pos[1], dz = sp.c[2] - cam.pos[2], dist = Math.hypot(dx, dy, dz);
        eat(this._starName(sp.idx), Math.max(0, dist - sp.r), dx, dy, dz, dist);
      }
      const rAu = this._modelFor(host).radiusAu, dist = Math.hypot(...cam.pos);
      spheres.push({ c: [0, 0, 0], r: rAu });
      eat(this._starName(host), Math.max(0, dist - rAu), -cam.pos[0], -cam.pos[1], -cam.pos[2], dist);
      for (const e of this._vis) {                            // the kinds that collide (planets, the Moon) in this system
        if (!e.spec.collide || !e.sysAu) continue;
        const rObj = e.spec.arriveAu(e.o), c = e.sysAu;
        spheres.push({ c, r: rObj });
        const dx = c[0] - cam.pos[0], dy = c[1] - cam.pos[1], dz = c[2] - cam.pos[2], dist2 = Math.hypot(dx, dy, dz);
        eat(e.o.name, Math.max(0, dist2 - rObj), dx, dy, dz, dist2);
      }
    } else {
      if (bi >= 0) {
        // Fetch the nearest star's Gaia parameters well before you arrive (within 0.5 pc), so a star you fly to yourself
        // gets its catalogue radius and Teff, not the colour-based guess. Cached; a no-op after the first call.
        if (b2 < 0.25) this._system(bi);
        const dx = p[3 * bi] - w[0], dy = p[3 * bi + 1] - w[1], dz = p[3 * bi + 2] - w[2], dist = Math.sqrt(b2);
        raw = { name: this._starName(bi), d: Math.max(0, dist - rPcOf(bi, b2)) };
        starPc = raw.d;
      }
      if (ei >= 0) {
        const dx = p[3 * ei] - w[0], dy = p[3 * ei + 1] - w[1], dz = p[3 * ei + 2] - w[2], dist = Math.hypot(dx, dy, dz);
        eat(undefined, Math.max(0, dist - rPcOf(ei, dist * dist)), dx, dy, dz, dist);
      }
      if (dis >= 0 && starsOn) {
        const dx = p[3 * dis] - w[0], dy = p[3 * dis + 1] - w[1], dz = p[3 * dis + 2] - w[2], dist = Math.hypot(dx, dy, dz);
        eat(undefined, Math.max(0, dist - rPcOf(dis, dist * dist)), dx, dy, dz, dist, F.LEAVE_PC);
      }
      // Galaxies and the Milky Way are surfaces in both unhosted frames (galaxySurfacePc; direction-only ones have no distance and are not surfaces).
      for (const e of this._visAll) {
        if (e.kind !== 'galaxy' || !e.galPc) continue;
        const dx = e.galPc[0] - w[0], dy = e.galPc[1] - w[1], dz = e.galPc[2] - w[2], dist = Math.hypot(dx, dy, dz), d = galaxySurfacePc(e.o, dist);
        if (Number.isFinite(d)) eat(e.o.name, d, dx, dy, dz, dist);
      }
      // everything above is in parsecs: this frame's units are 1 / unitsPerPc of that (Mpc in the cosmos frame), the HUD and the throttle read them
      raw = { name: raw.name, d: raw.d * u }; ahead *= u;       // (starPc stays in pc)
    }
    this._near = { name: raw.name, d: raw.d, dAhead: ahead, u, spheres, starPc }; this._nearNo = this._frameNo;
    return this._near;
  }

  // ------------------------------------------------------------------ autopilot
  /**
   * A selection -> what the autopilot needs. Stars: { type 'star', idx, pc, rAu, name }. Objects (from the store, so it also works
   * from another frame): { type 'object', host, pos (AU in the host's frame), rAu, name }. Groups: { type 'group', host, pc, name }.
   */
  _resolve(sel) {
    if (!sel) return null;
    if (sel.kind === 'star') {
      if (!this.st.meta[sel.idx]) return null;
      const md = this._modelFor(sel.idx);
      return { type: 'star', idx: sel.idx, pc: this._starPc(sel.idx), rAu: md.radiusAu, name: this._starName(sel.idx) };
    }
    if (sel.kind === 'group') {
      const host = String(sel.id).replace(/^group:/, ''), g = this._groups[host];
      return g ? { type: 'group', host, pc: g.pcPos, name: g.name } : null;
    }
    const o = this.store.get(sel.id), pl = o && this.store.placement(sel.id), spec = o && kindSpec(o.kind);
    // a cluster (go 'fly-galaxy'): { type: 'galaxy', pc, stopPc (spec.arrivePc, 2 x r50), name }, a trip in galaxy parsecs
    if (o && spec && spec.go === 'fly-galaxy' && !o.host && pl && pl.galPc) return { type: 'galaxy', pc: pl.galPc, stopPc: spec.arrivePc(o), name: o.name, o };
    if (!o || !spec || !pl || !pl.sysAu) return null;
    return { type: 'object', host: this.store.resolveHost(o.host), pos: pl.sysAu, rAu: spec.arriveAu(o), name: o.name, o };   // host: the key the camera's frame carries
  }
  _inSun() { return this.cam.frame === 'system' && this.cam.host.key === SUN_HOST.key; }
  _inHost(hostId) { return this.cam.frame === 'system' && this.cam.host.key === hostId; }
  _goFromCrosshair() {
    const px = (GO_DEG * D2R) * this.pxPerRad;
    this._go(this._pickAt(this.cssW / 2, this.cssH / 2, px) || this.sel);
  }
  /** What "Go there" does for this selection (see planGo): { type: 'star' | 'fly' | 'solar-scene' | 'via-host' | 'fly-galaxy' | 'look', hostId?, dir? }. */
  _planFor(sel) {
    const cam = this.cam;
    const target = sel.kind === 'star' ? { kind: 'star' } : sel.kind === 'group' ? { kind: 'group', id: sel.id } : { kind: sel.kind, id: sel.id, host: (this.store.get(sel.id) || {}).host };
    return planGo(target, { camFrame: cam.frame, camHostKey: cam.host ? cam.host.key : null, resolveHost: (h) => this.store.resolveHost(h),
      placement: (id) => this.store.placement(id), get: (id) => this.store.get(id) });   // get: a galaxy's own record (the Milky Way's face-on flight, a direction-only galaxy's turn)
  }
  /** A via-host trip whose host star is not in the star list cannot start (the card's button says so). */
  _hostMissing(plan) { return plan.type === 'via-host' && this._starIdx(plan.hostId) < 0; }
  _go(sel) {
    if (!sel) return;
    const plan = this._planFor(sel);
    if (plan.type === 'star') this._goStar(sel, null);
    else if (plan.type === 'look') this._lookAt(plan.dir, sel);
    else if (plan.type === 'fly') this._flyTo(sel);
    else if (plan.type === 'solar-scene') {
      this.setScene('solar');
      if (this.scene !== 'solar' || sel.kind === 'group') return;
      if (sel.kind === 'sun') { this.sel = this._starSel(0); this._cardSig = ''; this._goStar(this.sel, null); return; }   // in its own frame the Sun is star 0
      this.sel = sel; this._cardSig = ''; this._cardT = 0;      // setScene cleared it: keep the target's card pinned
      this._refreshVisible(); this._refreshGroups();
      this._flyTo(sel);
    } else if (plan.type === 'via-host') {
      const idx = this._starIdx(plan.hostId);                   // the resolved host; not loaded: nothing to fly to (the card disables the button)
      if (idx >= 0) this._goStar(this._starSel(idx), sel);       // the host star first; on arrival the trip to the object starts
    }
    else if (plan.type === 'fly-galaxy') this._goGalaxy(sel);
    else if (plan.type === 'fly-point') this._goPoint(sel, plan);
  }
  /**
   * A trip to a point in world parsecs that ends looking at another (the Milky Way: MW_GO_PC above its centre along the north Galactic pole, looking down at
   * it, so it ends in the cosmos frame). The position runs on the same Autopilot as the other trips and crosses the frame switch the same way; the view turns
   * from the direction of travel to the direction of plan.lookAtPc as the trip progresses, so it arrives face-on. It stops FLY_POINT_STOP_PC short of the point.
   */
  _goPoint(sel, plan) {
    const cam = this.cam, obj = new Autopilot();
    obj.start({ from: F.worldPc(cam), fromDir: M.dirFromYawPitch(cam.yaw, cam.pitch), to: plan.pc, stopAt: FLY_POINT_STOP_PC });
    this.ap = { obj, sel, type: 'point', plan, then: null, unitsPerPc: 1 };
    cam.vel = [0, 0, 0];
  }
  /**
   * A trip to a cluster's centre in galaxy parsecs, stopping at spec.arrivePc (2 x r50) from it, retargeted each frame like the star
   * trip. It runs in world parsecs, so it carries on across a star's system frame if the path enters one.
   */
  _goGalaxy(sel) {
    const t = this._resolve(sel), cam = this.cam;
    if (!t || t.type !== 'galaxy') return;
    const obj = new Autopilot();
    obj.start({ from: F.worldPc(cam), fromDir: M.dirFromYawPitch(cam.yaw, cam.pitch), to: t.pc, stopAt: Math.max(t.stopPc, 1e-6) });
    this.ap = { obj, sel, type: 'galaxy', then: null, unitsPerPc: 1 };
    cam.vel = [0, 0, 0];
  }
  /** The star trip, run in galaxy parsecs (doubles keep the last few AU exact), so crossing into the star's system frame needs no restart. */
  _goStar(sel, then) {
    const t = this._resolve(sel), cam = this.cam;
    if (!t || t.type !== 'star') return;
    const obj = new Autopilot();
    obj.start({ from: F.worldPc(cam), fromDir: M.dirFromYawPitch(cam.yaw, cam.pitch), to: t.pc, stopAt: arrivalDistance(t.rAu) / AU_PER_PC });
    this.ap = { obj, sel, type: 'star', then, unitsPerPc: 1 };
    cam.vel = [0, 0, 0];
  }
  /** An in-frame trip to an object of the camera's system, in AU, retargeted each frame. */
  _flyTo(sel) {
    const t = this._resolve(sel), cam = this.cam;
    if (!t || t.type !== 'object' || !this._inHost(t.host)) return;
    const obj = new Autopilot();
    obj.start({ from: cam.pos.slice(), fromDir: M.dirFromYawPitch(cam.yaw, cam.pitch), to: t.pos, stopAt: arrivalDistance(t.rAu) });
    this.ap = { obj, sel, type: 'object', host: t.host, then: null, unitsPerPc: AU_PER_PC };
    cam.vel = [0, 0, 0];
  }
  /**
   * "Turn to it" (a direction-only target, plan type 'look'): the camera turns to face dir over LOOK_TURN_S (at once with reduced motion).
   * Position, velocity and speed are untouched. Yaw and pitch are eased separately (the camera has no roll), yaw the short way round.
   */
  _lookAt(dir, sel) {
    const cam = this.cam, to = M.yawPitchFromDir(dir), instant = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    let dy = to.yaw - cam.yaw;
    dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
    this.ap = { type: 'look', sel, yaw0: cam.yaw, dYaw: dy, pitch0: cam.pitch, pitch1: clamp(to.pitch, -1.5, 1.5), s: instant ? 1 : 0, dur: LOOK_TURN_S };
    if (instant) this._stepLook(0);
  }
  _stepLook(dt) {
    const ap = this.ap, cam = this.cam;
    ap.s = Math.min(1, ap.s + dt / ap.dur);
    const e = ease(ap.s);
    cam.yaw = ap.yaw0 + ap.dYaw * e; cam.pitch = ap.pitch0 + (ap.pitch1 - ap.pitch0) * e;
    if (ap.s >= 1) this.ap = null;
  }
  _stepAutopilot(dt) {
    const ap = this.ap, cam = this.cam; if (!ap) return;
    if (ap.type === 'look') { this._stepLook(dt); return; }
    const world = WORLD_TRIPS.has(ap.type);                            // trips in world parsecs: they cross frame switches
    if (!world && !this._inHost(ap.host)) { this.ap = null; return; }   // left the object's system
    // a point flight has a fixed target: its arrival speed is that of a galaxy trip stopping that far out
    const t = ap.type === 'point' ? { type: 'galaxy', stopPc: Math.hypot(...ap.plan.pc.map((v, i) => v - ap.plan.lookAtPc[i])) } : this._resolve(ap.sel);
    if (!t) { this.ap = null; return; }
    if (ap.type === 'galaxy') ap.obj.retarget(t.pc);
    else if (ap.type !== 'star' && ap.type !== 'point') ap.obj.retarget(t.pos);
    const r = ap.obj.step(dt);
    if (ap.type === 'point') {                                         // turn from the direction of travel to the centre as the trip progresses
      const to = ap.plan.lookAtPc.map((v, i) => v - r.pos[i]), L = Math.hypot(...to);
      if (L > 0) r.dir = slerp(r.dir, to.map((v) => v / L), ease(ap.obj.s));
    }
    // world pc -> the camera's frame units: AU from the host in a system frame, otherwise parsecs times the level's units per parsec (Mpc in the cosmos frame)
    cam.pos = world ? (cam.frame === 'system' ? F.toSystemPos(r.pos, cam.host.pc) : r.pos.map((v) => v * F.unitsPerPc(cam))) : r.pos.slice();
    const v = M.yawPitchFromDir(r.dir);
    cam.yaw = v.yaw; cam.pitch = clamp(v.pitch, -1.5, 1.5); cam.vel = [0, 0, 0];
    if (r.done) { this.ap = null; this._arrived(t, ap.then); }
  }
  _arrived(t, then) {
    const cam = this.cam, upc = F.unitsPerPc(cam);
    const surfAu = this._surfaceAu(), r = F.rangeOf(cam.frame);
    // At a cluster (stopped 2 x r50 out) the nearest "surface" is a star, so a third of the stop distance is the comfortable pace.
    const hiPc = F.levelOf(cam.frame).autoPc.max;                     // the level's cap (1e8 pc/s out here), so a galaxy trip gets a speed that suits its size
    cam.speed = clamp(t.type === 'galaxy' ? suggestSpeed(t.stopPc * upc, upc, hiPc) : suggestSpeed(surfAu * (upc / AU_PER_PC), upc, hiPc), r.min, r.max);
    if (t.type === 'star' && cam.frame === 'system') this.hooks.onHud(this._hudData());
    // a chained trip (to an object of the star just reached): only once we are in that star's frame, and never to a group
    if (then && then.kind !== 'group' && t.type === 'star' && cam.frame === 'system' && cam.host.key === this._starKey(t.idx)) {
      this._refreshVisible(); this._refreshGroups();
      this.sel = then; this._cardSig = ''; this._cardT = 0;
      this._go(then);
    }
  }
  /** The sphere whose surface is nearest the camera: { name, au } (au = Infinity when in the galaxy frame). */
  _nearest() {
    const cam = this.cam;
    if (cam.frame !== 'system') return { name: null, au: Infinity };
    let best = { name: this._starName(cam.host.idx), au: Math.max(0, Math.hypot(...cam.pos) - this._modelFor(cam.host.idx).radiusAu) };
    for (const e of this._vis) {
      if (!e.spec.collide || !e.sysAu) continue;
      const au = Math.max(0, Math.hypot(...sub3(e.sysAu, cam.pos)) - e.spec.arriveAu(e.o));
      if (au < best.au) best = { name: e.o.name, au };
    }
    return best;
  }
  /** Distance from the camera to the nearest sphere surface, in AU (Infinity when there is none). */
  _surfaceAu() { return this._nearest().au; }
  /**
   * After a frame switch (prev: the frame the camera came from): the free-flight speed that suits the new surroundings, and the star buffer. Entering a
   * hosted level (a star's system) picks a speed from the nearest surface and fetches the star's system; every other switch carries the manual speed across
   * through the ratio of the levels' units per parsec (carrySpeed), clamped to the new range, so no switch jumps in speed.
   */
  _onFrameChange(kind, prev) {
    const cam = this.cam, to = F.levelOf(cam.frame), from = F.levelOf(prev);
    this._syncStarFrame(); this._ver++; this._pickSig = ''; this._near = null; this.hooks.onScene(this.scene);
    this._refreshObjectBuffers();                                 // the visible set and the per-host buffers depend on the frame and the host
    if (to.hosted) {
      this._system(cam.host.idx);
      cam.speed = clamp(suggestSpeed(this._surfaceAu(), to.perPc), to.range.min, to.range.max);
    } else cam.speed = carrySpeed(cam.speed, from.perPc, to.perPc, { ...to.range, floorPc: from.hosted ? 0.05 : 0 });   // 0.05 pc/s: leaving a system is not a crawl
    if (this.ap && !WORLD_TRIPS.has(this.ap.type)) this.ap = null;     // a trip inside a system ends when the camera leaves it
  }

  // ------------------------------------------------------------------ arriving from and leaving for a flat picture
  // The sphere and the frames view are flat pictures of the sky. Seen from the Sun, the 3D scene looks the same, so the
  // page opens on that picture (intro) and pulls into the patch (reveal), and before it goes it glides back to it (flatten).
  /** Vertical field of view (degrees) that shows longDeg across the canvas's longer side, the way the sphere measures it. */
  _flatFov(longDeg) {
    const a = (this.canvas.clientWidth || 1) / (this.canvas.clientHeight || 1);
    return a >= 1 ? 2 * Math.atan(Math.tan(longDeg * D2R / 2) / a) / D2R : longDeg;
  }
  /**
   * Opened from a flat picture that showed longDeg across its longer side: the camera holds at the Sun with that field,
   * so every star sits where the picture had it, until reveal() or endIntro(). Taking the controls ends it where it is.
   */
  intro(longDeg) {
    const c = this.cam;
    if (!(longDeg > 0) || c.frame !== 'galaxy') return;
    this._arrival = { long: longDeg, dir: M.dirFromYawPitch(c.yaw, c.pitch) };
    this._intro = { ...this._arrival, s: 0, end: 0, zref: 0, dur: INTRO_S, playing: false, glide: false };
    this.fov = this._flatFov(longDeg);
  }
  /** Taking the controls ends the arrival where it is, and a late reveal() no longer moves the camera. */
  _takeOver() { this._intro = null; this._arrival = null; if (this._snap) this._snap.fade = SNAP_DROP_S; }
  /** The camera is still holding on the flat picture, waiting for reveal(). */
  get introWaiting() { return !!this._intro && !this._intro.playing; }
  /**
   * The depth reveal, a dolly zoom: the field widens to the normal one while the camera moves along the view axis, so
   * stars at the reference distance keep their place on screen; nearer ones spread outward and farther ones draw in.
   * Needs the Gaia stars (their distances set the reference); without them the arrival just ends. When they come after
   * the opening picture has already widened (endIntro) and the controls are untouched, the camera glides from the Sun
   * to the same place instead.
   */
  reveal() {
    const a = this._arrival, c = this.cam;
    if (!a || c.frame !== 'galaxy' || (this._intro && this._intro.playing)) return;
    const st = this.st, d = [], f0 = this._flatFov(a.long);
    for (let i = 0; i < st.n; i++) if (st.meta[i].kind === 'gaia') d.push(Math.hypot(st.pos[3 * i], st.pos[3 * i + 1], st.pos[3 * i + 2]));
    if (!d.length || f0 >= this.fovStars) { this._intro = null; this._arrival = null; return; }
    d.sort((x, y) => x - y);
    const zref = REVEAL_REF * d[d.length >> 1], end = zref * (1 - Math.tan(f0 * D2R / 2) / Math.tan(this.fovStars * D2R / 2));
    if (this._intro) Object.assign(this._intro, { zref, end, playing: true });
    else if (Math.hypot(...c.pos) < 1e-9) this._intro = { ...a, s: 0, zref, end, dur: INTRO_S, playing: true, glide: true, f0: this.fov };
    this._arrival = null;
  }
  /**
   * The picture the page was opened from (an <img> over the canvas, showing longDeg across its longer side), so the page
   * opens on what the sky showed rather than on the stars alone. It holds while the camera waits on the opening picture,
   * then follows the camera's field (the dolly zoom keeps it in place, widening at the Sun shrinks it) as it fades.
   */
  showSnap(el, longDeg) {
    if (!this._intro) { el.remove(); return; }
    this._snap = { el, long: longDeg, dir: this._intro.dir, a: 1, fade: SNAP_FADE_S };
  }
  /** The opening picture (or its overlay) is still on screen. */
  get introActive() { return !!(this._intro || this._snap); }
  _stepSnap(dt) {
    const sn = this._snap; if (!sn) return;
    const it = this._intro;
    if (!it || it.playing) sn.a -= dt / sn.fade;
    if (sn.a <= 0 || this.cam.frame !== 'galaxy') { sn.el.remove(); this._snap = null; return; }
    // the picture is the plane at the reference distance (at infinity before the Gaia stars set one)
    const p = this.cam.pos, cz = p[0] * sn.dir[0] + p[1] * sn.dir[1] + p[2] * sn.dir[2];
    const zref = sn.zref = (it && it.zref) || sn.zref || 0;
    const k = Math.tan(this._flatFov(sn.long) * D2R / 2) / Math.tan(this.fov * D2R / 2) * (zref > cz ? zref / (zref - cz) : 1);
    sn.el.style.transform = `scale(${k.toFixed(5)})`;
    sn.el.style.opacity = (sn.a * sn.a * (3 - 2 * sn.a)).toFixed(3);
  }
  /** Ends the opening picture without the reveal: the field eases out to the normal one from where the camera is. */
  endIntro() { this._intro = null; }
  _stepIntro(dt) {
    const it = this._intro; if (!it) return;
    if (this.cam.frame !== 'galaxy') { this._intro = null; return; }
    const f0 = this._flatFov(it.long);
    if (!it.playing) { this.fov = f0; return; }
    it.s = Math.min(1, it.s + dt / it.dur);
    const e = ease(it.s);
    // a glide starts from the widened view: straight along the axis to where the dolly zoom would have ended
    const fov = it.glide ? lerpLog(it.f0, this.fovStars, e) : lerpLog(f0, this.fovStars, e);
    const cz = it.glide ? it.end * e : it.zref * (1 - Math.tan(f0 * D2R / 2) / Math.tan(fov * D2R / 2));
    this.cam.pos = it.dir.map((v) => v * cz); this.cam.vel = [0, 0, 0];
    this.fov = fov;
    if (it.s >= 1) this._intro = null;
  }
  /**
   * Leaving for a flat picture: back to the Sun, looking at the patch, while the field narrows to show longDeg across the
   * longer side, so the next page opens on the same picture. Resolves once there, and the camera holds until endFlatten().
   * Resolves at once in a star system, where there is no such picture to match.
   */
  flatten(longDeg, dur = FLATTEN_S) {
    this._intro = null; this._arrival = null; this._outro = null; this.ap = null; this.keys.clear(); this.hover = null;
    if (this._snap) { this._snap.el.remove(); this._snap = null; }
    if (this.locked && document.exitPointerLock) document.exitPointerLock();
    const c = this.cam;
    if (c.frame !== 'galaxy' || !this.running || !(longDeg > 0)) return Promise.resolve();
    const { ra, dec } = this.target, v = M.yawPitchFromDir(M.radecToXyz(ra, dec, 1));
    const d1 = M.dirFromYawPitch(v.yaw, clamp(v.pitch, -1.5, 1.5));
    return new Promise((done) => {
      this._outro = { p0: c.pos.slice(), d0: M.dirFromYawPitch(c.yaw, c.pitch), d1, f0: this.fov, long: longDeg, s: 0, dur, done };
    });
  }
  /** Back from the page this one handed over to (the browser kept it): the controls are free again. */
  endFlatten() { this._outro = null; }
  _stepOutro(dt) {
    const o = this._outro; if (!o) return;
    const c = this.cam, f1 = this._flatFov(o.long);
    o.s = Math.min(1, o.s + dt / o.dur);
    const e = ease(o.s), fov = lerpLog(o.f0, f1, e);
    // the reverse dolly: the distance follows the field so stars at the reference distance stay put (a plain glide when
    // the field is not narrowing)
    const t0 = Math.tan(o.f0 * D2R / 2), t1 = Math.tan(f1 * D2R / 2), tf = Math.tan(fov * D2R / 2);
    const g = o.f0 > f1 * 1.01 ? clamp((1 - t1 / tf) / (1 - t1 / t0), 0, 1) : 1 - e;
    c.pos = o.p0.map((v) => v * g); c.vel = [0, 0, 0];
    const v = M.yawPitchFromDir(slerp(o.d0, o.d1, e));
    c.yaw = v.yaw; c.pitch = clamp(v.pitch, -1.5, 1.5);
    this.fov = fov;
    if (o.s >= 1 && o.done) { const done = o.done; o.done = null; done(); }
  }

  // ------------------------------------------------------------------ frame loop
  start() {
    if (this.running || this.lost) return;
    this.running = true; this._last = 0;
    this._raf = requestAnimationFrame(this._frame);
  }
  _onLost(e) {
    e.preventDefault();
    this.lost = true; this.running = false; cancelAnimationFrame(this._raf);
    this.hooks.onLost(true);
  }
  _onRestored() {
    this.lost = false;
    this._initGL();
    for (const k of Object.keys(this.cpu)) this._upload(k);
    this.start();
    this.hooks.onLost(false);
  }
  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = this.canvas.clientWidth || 1, ch = this.canvas.clientHeight || 1;
    this.cssW = cw; this.cssH = ch; this.dpr = dpr;
    const w = Math.max(1, Math.round(cw * dpr)), h = Math.max(1, Math.round(ch * dpr));
    if (w !== this.canvas.width || h !== this.canvas.height) {
      this.canvas.width = w; this.canvas.height = h;
      this.labelsEl.width = w; this.labelsEl.height = h;
    }
    if (this.hdr && !this.hdr.resize(w, h)) { this.hdrBad = true; this._initGL(); for (const k of Object.keys(this.cpu)) this._upload(k); }
  }
  _matrices(dt) {
    const cam = this.cam;
    const L = F.levelOf(cam.frame), want = L.fov || this.fovStars;
    if (!this._intro && !this._outro) this.fov += (want - this.fov) * (dt > 0 ? 1 - Math.exp(-dt * 3) : 0);
    const dir = M.dirFromYawPitch(cam.yaw, cam.pitch);
    const aspect = this.canvas.width / this.canvas.height;
    this.R = M.lookRotation(dir, Z_UP);                          // rotation only: translation is subtracted before this
    this.vp = M.mul4(M.perspective(this.fov * D2R, aspect, L.near, L.far), this.R);
    this.tanY = Math.tan(this.fov * D2R / 2); this.tanX = this.tanY * aspect;
    this.pxPerRad = (this.cssH / 2) / this.tanY;
  }
  /** Measured world-space speed (pc/s, smoothed) from the camera's movement; frame switches do not disturb it. */
  _trackSpeed(dt) {
    const w = F.worldPc(this.cam);
    if (this._lastWorld && dt > 0) {
      const v = Math.hypot(w[0] - this._lastWorld[0], w[1] - this._lastWorld[1], w[2] - this._lastWorld[2]) / dt;
      this.speedPc += (v - this.speedPc) * (1 - Math.exp(-dt * 10));
    }
    this._lastWorld = w;
  }
  /** Stars within NEAR_PC of the camera: nearest first handled by stepFrame, all of them drawn exactly. */
  _scan() {
    const st = this.st, w = F.worldPc(this.cam), out = [], r2 = NEAR_PC * NEAR_PC, p = st.pos;
    if (this.cam.frame === 'cosmos') return out;                  // 60 kpc from the Sun: no star is near
    for (let i = 0; i < st.n; i++) {
      const dx = p[3 * i] - w[0], dy = p[3 * i + 1] - w[1], dz = p[3 * i + 2] - w[2], d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < r2) out.push({ idx: i, key: this._starKey(i), name: this._starName(i), pc: [p[3 * i], p[3 * i + 1], p[3 * i + 2]], distPc: Math.sqrt(d2) });
    }
    return out;
  }
  /** Brightest sprite intensity (v) in view: the host in a system frame, otherwise the brightest of the stars ahead. */
  _brightest(cands) {
    const cam = this.cam, st = this.st;
    let v = 0;
    const vOf = (i, distPc, rAu) => {
      if (distPc * AU_PER_PC < rAu * 1.05) return 0;              // inside the star: nothing to adapt to
      return M.spriteV(M.apparentMag(st.gal[7 * i + 3], distPc), this.limit);
    };
    if (cam.frame === 'system') {
      const i = cam.host.idx, d = Math.hypot(...cam.pos) || 1;
      const v = vOf(i, d / AU_PER_PC, this._modelFor(i).radiusAu);
      // Looking away from the host, its glare does not set the exposure (the eye adapts to what is in view).
      const dir = M.dirFromYawPitch(cam.yaw, cam.pitch), ang = Math.acos(clamp(-(cam.pos[0] * dir[0] + cam.pos[1] * dir[1] + cam.pos[2] * dir[2]) / d, -1, 1));
      const edge = Math.atan(Math.hypot(this.tanX, this.tanY)), out = (ang - edge) / 0.5;
      return out <= 0 ? v : Math.min(v, V_EXPO) * Math.max(0, 1 - out);
    }
    // The stars fade out with galaxyFade (20 to 40 kpc), so the exposure target scales their intensities by it and reaches the cosmos frame's value
    // (nothing bright in view: exposureFor(0) = 1) before the switch. From 40 kpc out there is nothing to scan.
    const gf = this._gf;
    if (!(gf > 0)) return 0;
    for (const c of cands) v = Math.max(v, vOf(c.idx, c.distPc, this._modelFor(c.idx).radiusAu));
    if (this._frameNo % 3 === 0 || !this.vScan) {                 // the full scan is the costly part: every third frame
      const dir = M.dirFromYawPitch(cam.yaw, cam.pitch), p = st.pos, g = st.gal;
      let best = 0;
      for (let i = 0; i < st.n; i++) {
        const dx = p[3 * i] - cam.pos[0], dy = p[3 * i + 1] - cam.pos[1], dz = p[3 * i + 2] - cam.pos[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-10 || d2 < NEAR_PC * NEAR_PC) continue;       // the near ones are handled above
        const dd = Math.sqrt(d2);
        if ((dx * dir[0] + dy * dir[1] + dz * dir[2]) / dd < 0.35) continue;
        const vv = M.spriteV(M.apparentMag(g[7 * i + 3], dd), this.limit);
        if (vv > best) best = vv;
      }
      this.vScan = Math.max(best, 1e-9);
    }
    return Math.max(v, this.vScan) * gf;
  }
  _frame(t) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._frame);
    const dt = this._last ? Math.min(0.05, (t - this._last) / 1000) : 0;
    this._last = t; this._t = t / 1000; this._frameNo++;
    this._resize();
    this._refreshVisible();                                      // once per frame: reused by drawing, labels, picking and validity
    this._step(dt);
    this._stepAutopilot(dt);
    this._stepIntro(dt); this._stepSnap(dt);
    this._stepOutro(dt);
    this._trackSpeed(dt);
    let cands = this._scan();
    const prevFrame = this.cam.frame, sw = F.stepFrame(this.cam, cands);
    if (sw) { this._onFrameChange(sw, prevFrame); cands = this._scan(); }
    this._matrices(dt);
    this._gf = F.isHosted(this.cam.frame) ? 1 : galaxyFade(this.cam);   // 1 near the Sun, 0 from 40 kpc out (section 18.5.4)
    for (const e of this._visAll) { if (e.galaxyFade != null) e.galaxyFade = this._gf; else if (e.mwFade != null) e.mwFade = 1 - this._gf; }
    this._bb = this._billboards();                                // cluster, nebula and galaxy items; they also feed markers and picking; sets this._vis
    this._refreshGroups();
    // exposure: eased toward what the brightest thing in view needs
    this.expoTarget = M.exposureFor(this._brightest(cands));
    this.expo = dt > 0 ? M.easeExposure(this.expo, this.expoTarget, dt) : this.expoTarget;
    this._draw(cands, t);
    this._overlay(t);
  }

  /**
   * The visible object entries for the camera's frame and host. They depend only on the layers, the evidence flag, the store and
   * the frame and host, all of which bump this._ver, so the list is rebuilt only then (a Kepler-field cone holds thousands).
   */
  _refreshVisible() {
    const cam = this.cam, sig = `${this._ver}|${cam.frame}|${cam.frame === 'system' ? cam.host.key : ''}`;
    if (sig === this._visSig) return;
    this._visSig = sig;
    // cam: in the galaxy frame the entries of kinds without a cosmos renderer carry galaxyFade (the Milky Way billboard 1 - galaxyFade); _frame refreshes them
    // every frame. _vis is _visAll until _billboards removes the supermassive black holes that are not resolved yet (smbhVisible).
    this._visAll = this._vis = visibleObjects(this.store, { layers: this.layers, evidence: this.evidence, frame: cam.frame, cam, inHost: (h) => cam.frame === 'system' && cam.host.key === h, pxPerRad: this.pxPerRad });
  }
  _refreshGroups() { this._groups = groupState(this.store, this._vis, this.cam, this.pxPerRad); }

  // ------------------------------------------------------------------ drawing
  _draw(cands, t) {
    const gl = this.gl, cam = this.cam, W = this.canvas.width, H = this.canvas.height;
    const hdr = this.hdr && this.hdr.ok ? this.hdr : null;
    if (hdr) hdr.begin(); else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    this._drawSky();
    const bb = this._bb;                                          // cluster, nebula and galaxy items (_billboards, once a frame); they also feed markers and picking
    this._drawNebulae(bb, true);                                  // dark nebulae: right after the Milky Way glow, before every other glow and star
    this._drawBillboards(bb);                                     // cluster glows and rings
    this._drawNebulae(bb, false);                                 // emission, reflection, planetary and SNR glows, and the Evidence outlines (galaxy outlines too)
    this._drawGalaxies(bb);                                       // galaxy and Milky Way glows (the Evidence view draws their outlines above)
    const sun = this._inSun(), inSys = cam.frame === 'system', vis = this._vis, groups = this._groups, gf = this._gf, starsOn = inSys || gf > 1e-3;   // starsOn: not in the cosmos frame, and not once galaxyFade has taken them out
    const bufOk = inSys && this._bufHost === cam.host.key;       // points and lineSys belong to the camera's host (rebuilt on every frame change)
    const bodies = [];                                            // spheres to draw, with their crossfade weight
    const dynStars = [], dynPts = [], skip = new Int32Array(16).fill(-1);
    this.dyn.clear();
    // near stars: exact camera-relative positions; the host and any star big enough on screen are spheres too
    cands.slice(0, 16).forEach((c, k) => {
      skip[k] = c.idx;
      const md = this._modelFor(c.idx), rel = F.relFromCam(cam, c.pc), dist = Math.hypot(...rel);
      const distAu = cam.frame === 'system' ? dist : dist * AU_PER_PC, rAu = md.radiusAu;
      const angPx = M.angRadius(rAu, distAu) * this.pxPerRad, s = M.sphereWeight(angPx);
      const inside = distAu < rAu * 1.001;
      this.dyn.set(c.idx, angPx);
      const wPoint = inside ? 0 : 1 - s;
      const col = this.st.gal.subarray(7 * c.idx + 4, 7 * c.idx + 7);
      dynStars.push(rel[0], rel[1], rel[2], this.st.gal[7 * c.idx + 3], col[0] * wPoint, col[1] * wPoint, col[2] * wPoint);
      if (s > 0 && !inside) bodies.push({ kind: 0, rel, dist: distAu, rAu, s, md, idx: c.idx, units: cam.frame === 'system' ? 1 : AU_PER_PC });
    });
    const lens = lensingItems(vis, cam, { evidence: this.evidence, pxPerRad: this.pxPerRad, project: this._pjAll });   // black holes: the lensing look (never in the Evidence view)
    this._lens = new Map(lens.map((it) => [it.id, it]));
    for (const it of lens) this.dyn.set(it.id, it.px);            // the pick reach and the selection ring follow the drawn size
    for (const e of vis) {
      if (e.renderer === 'sphere') {                              // a point that cross-fades into a ray-traced sphere
        const rAu = e.spec.arriveAu(e.o), relv = framePos(e, cam), dist = Math.hypot(relv[0], relv[1], relv[2]);
        const angPx = M.angRadius(rAu, dist) * this.pxPerRad, s = M.sphereWeight(angPx), c = e.spec.color(e.o);
        this.dyn.set(e.id, angPx);
        if (dist > rAu) dynPts.push(relv[0], relv[1], relv[2], e.spec.pointSize(e.o), 1 - s, c[0], c[1], c[2]);
        if (s > 0 && dist > rAu) bodies.push({ kind: 1, rel: relv, dist, rAu, s, e });
      }
    }
    // lines
    if (!inSys) { if (this.layers.cone && starsOn) this._drawLines('lineStars', gf); }   // the cone outline fades with the stars
    else {                                                        // orbits of the current host; the cone outline is the Sun's only (it is Earth's patch)
      if (bufOk && this.layers.orbits) this._drawLines('lineSys');
      if (sun && this.layers.cone) this._drawLines('coneSolar');
    }
    if (starsOn) {
      this._drawStars('stars', skip);
      if (dynStars.length) this._drawDynStars(new Float32Array(dynStars));
    }
    if (bufOk) this._drawPoints(this.gpu.points, cam.pos);
    if (dynPts.length) this._drawDynPoints(new Float32Array(dynPts));
    this._drawLensing(lens);                                      // after the stars, "over" blending: the black disc hides what is behind it
    // a lensing entry keeps its marker only in the Evidence view; otherwise its look is the marker
    const marks = markerPoints(this.evidence ? vis : vis.filter((e) => e.renderer !== 'lensing'), groups, cam, bb, { groupPx: GROUP_PX_SIZE, groupRgb: GROUP_RGB });   // galaxy-frame markers, cluster centres, group markers
    if (marks.length) this._drawDynPoints(marks);
    // spheres, far to near, premultiplied "over"
    bodies.sort((a, b) => b.dist - a.dist);
    if (bodies.length) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      for (const b of bodies) this._drawBody(b, t);
    }
    if (hdr) hdr.finish({ strength: this.bloomK * (0.1 + 0.2 * clamp(-Math.log10(this.expo) / 4, 0, 1)), exposure: 1, threshold: this.bloomT });
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  /**
   * The billboard items for this frame (billboardItems: clusters, nebulae, galaxies and the Milky Way), in the galaxy and cosmos frames. The nearest star's
   * distance feeds the fade that hides a cluster before the camera enters a star's system frame (clusters are not drawn there). It also tells each entry
   * whether it has collapsed to a marker (< 2 px), which picking reads (pickPriority). Then this._vis becomes this._visAll without the supermassive black holes
   * that are not resolved yet (smbhVisible: in the cone, selected, or their galaxy's item is inside the view or 40 px across; section 18.8.3).
   */
  _billboards() {
    const cam = this.cam;
    if (F.isHosted(cam.frame)) { this._vis = this._visAll; return []; }
    let items = [];
    if (this._visAll.some((e) => e.renderer === 'billboard')) {
      const near = cam.disarm ? Infinity : this._nearBody().starPc;    // while leaving the start star (the Sun) it is not "about to enter" anything
      // project: null only for points behind the camera (a nebula needs the ends of its axes even where they fall off screen)
      items = billboardItems(this._visAll, cam, { evidence: this.evidence, pxPerRad: this.pxPerRad, nearPc: near, project: this._pjAll });
      const by = new Map(items.map((i) => [i.id, i]));
      for (const e of this._visAll) if (e.renderer === 'billboard') { const it = by.get(e.id); e.markerOnly = !!(it && it.markerOnly); }
    }
    this._vis = withSmbh(this._visAll, items, { selectedId: this.sel && this.sel.kind !== 'star' ? this.sel.id : null });
    return items;
  }
  /**
   * Draws the cluster glows (or, in the Evidence view, the r50 rings): a camera-facing quad of half-size 4 x r50 per item, built here
   * from the camera-relative doubles (cast to float32 only at the end, as the markers are). Additive, no depth, after the Milky Way
   * and before the stars. An item whose r50 is under 2 px (markerOnly) or that has faded out draws no quad: its marker is enough.
   */
  _drawBillboards(items) {
    const quads = items.filter((it) => !it.billboard && (it.markerOnly ? false : (it.mode === 'outline' ? it.lineAlpha : it.alpha) > 1e-3));   // clusters only: nebulae and galaxies carry `billboard`
    if (!quads.length) return;
    const cam = this.cam, f = M.dirFromYawPitch(cam.yaw, cam.pitch), r = M.norm(M.cross(f, Z_UP)), u = M.cross(r, f);
    const data = new Float32Array(quads.length * 6 * 10);
    let k = 0;
    const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    for (const it of quads) {
      const h = 4 * it.radiusUnits, outline = it.mode === 'outline';
      const a = outline ? it.lineAlpha : it.alpha, mode = outline ? (it.dashed ? 2 : 1) : 0;
      for (const [cx, cy] of CORNERS) {
        for (let j = 0; j < 3; j++) data[k++] = it.rel[j] + h * (cx * r[j] + cy * u[j]);
        data[k++] = 4 * cx; data[k++] = 4 * cy;
        data[k++] = it.rgb[0]; data[k++] = it.rgb[1]; data[k++] = it.rgb[2]; data[k++] = a; data[k++] = mode;
      }
    }
    const gl = this.gl, pr = this.prog.bb, st = 40;
    const kk = this.evidence ? BB_RING : Math.min(BB_GLOW_K * this.expo, BB_GLOW_MAX);
    gl.useProgram(pr.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf.bb);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, k), gl.STREAM_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, st, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, st, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, st, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, st, 36);
    gl.uniformMatrix4fv(pr.u.u_vp, false, this.vp);
    gl.uniform1f(pr.u.u_k, kk);
    gl.uniform1f(pr.u.u_dpr, this.dpr);
    gl.drawArrays(gl.TRIANGLES, 0, k / 10);
    gl.disableVertexAttribArray(3);
  }
  /**
   * The nebula billboards (docs/object-framework.md section 17.6.2): per item a screen-aligned quad (a rotated rectangle covering NEB_QUAD x its
   * ellipse) built here from the item's screen centre, semi-axes and angle, in clip space. dark: true draws only the dark nebulae, with
   * blendFunc(ZERO, ONE_MINUS_SRC_ALPHA) (they darken what is behind them: the Milky Way glow); false draws the rest, additive, no depth.
   * In the Evidence view the pass draws the catalogue ellipse (dashed for derived records and an unknown PA) in the marker colour, and the
   * dark pass draws nothing. Items that are markers only, inside, or faded out draw no quad (markerPoints gives the marker).
   */
  _drawNebulae(items, dark) {
    const ev = this.evidence, quads = [];
    for (const it of items) {
      if (!(it.billboard === 'nebula' || (ev && it.billboard === 'galaxy')) || it.markerOnly || it.inside || !it.screen || it.semiMajorPx == null) continue;   // galaxies: only their Evidence outline is drawn here
      if ((!ev && it.look === 'dark') !== dark) continue;   // the Evidence view draws every outline in the additive pass
      if ((ev ? it.lineAlpha : it.alpha) > 1e-3) quads.push(it);
    }
    if (!quads.length) return;
    const gl = this.gl, pr = this.prog.nebula, W = this.cssW, H = this.cssH, st = 40;   // 10 floats a vertex: clip xy, ellipse uv, rgba, mode and seed
    const data = new Float32Array(quads.length * 6 * 10);
    const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    let k = 0;
    for (const it of quads) {
      const a = Math.min(it.semiMajorPx, NEB_PX_MAX), b = Math.min(Math.max(it.semiMinorPx, 0.5), NEB_PX_MAX), th = it.angle || 0;
      const ct = Math.cos(th), sn = Math.sin(th);
      const ext = ev ? 1 + Math.min(Math.max(0.3, 4 / b), 6) : NEB_QUAD;          // the outline's line is a few px wide: leave room around a thin ellipse
      const alpha = ev ? it.lineAlpha : dark ? it.alpha * NEB_DARK : it.alpha;
      const mode = ev ? (it.dashed ? 11 : 10) : NEB_MODE[it.look] ?? 0;
      // The quad is drawn as its screen bounding box cut to the viewport, each corner given the ellipse coordinates of that pixel (the map is
      // affine, so the interpolation is exact). No vertex leaves the screen: clipped triangles showed a seam along the quad's diagonal.
      const ex = ext * (Math.abs(a * ct) + Math.abs(b * sn)), ey = ext * (Math.abs(a * sn) + Math.abs(b * ct));
      const x0 = Math.max(0, it.screen[0] - ex), x1 = Math.min(W, it.screen[0] + ex), y0 = Math.max(0, it.screen[1] - ey), y1 = Math.min(H, it.screen[1] + ey);
      if (!(x1 > x0 && y1 > y0)) continue;
      for (const [cx, cy] of CORNERS) {
        const px = cx < 0 ? x0 : x1, py = cy < 0 ? y0 : y1;
        const dx = px - it.screen[0], dy = py - it.screen[1];
        const u = (dx * ct + dy * sn) / a, v = (-dx * sn + dy * ct) / b;   // inverse of px = c + u a (cos, sin) + v b (-sin, cos), y down
        data[k++] = px / W * 2 - 1; data[k++] = 1 - py / H * 2;
        data[k++] = u; data[k++] = v;
        data[k++] = it.rgb[0]; data[k++] = it.rgb[1]; data[k++] = it.rgb[2]; data[k++] = alpha;
        data[k++] = mode; data[k++] = it.seed * 97.0;
      }
    }
    gl.blendFunc(dark ? gl.ZERO : gl.ONE, dark ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
    gl.useProgram(pr.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf.nebula);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, k), gl.STREAM_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, st, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, st, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, st, 16);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, st, 32);
    gl.uniform1f(pr.u.u_k, ev ? BB_RING : Math.min(NEB_K * this.expo, NEB_MAX));
    gl.uniform1f(pr.u.u_dpr, this.dpr);
    gl.drawArrays(gl.TRIANGLES, 0, k / 10);
    gl.disableVertexAttribArray(3);
    gl.blendFunc(gl.ONE, gl.ONE);
  }
  /**
   * The galaxy and Milky Way glows (sections 18.6.1 and 18.7, illustrative looks): one clip-space quad per item from galaxyQuad (the item's screen ellipse, its
   * disc coordinates and the look's numbers), drawn by the galaxy shader, additive, after the nebulae and before the stars. Items that are markers only
   * (under 3 px), inside, or faded out draw no quad (the marker is enough). Nothing is drawn in the Evidence view: _drawNebulae draws the measured outline.
   * The Milky Way's alpha already carries (1 - galaxyFade) and every size goes through unitsPerPc, so the same galaxy is drawn identically in the galaxy and
   * the cosmos frame.
   */
  _drawGalaxies(items) {
    if (this.evidence) return;
    const parts = [];
    for (const it of items) {
      if ((it.billboard !== 'galaxy' && it.billboard !== 'milky_way') || it.markerOnly || it.inside || it.alpha <= 1e-3) continue;
      const q = galaxyQuad(it, this.cssW, this.cssH, { quad: NEB_QUAD });
      if (q) parts.push(q);
    }
    if (!parts.length) return;
    const data = new Float32Array(parts.length * 6 * GALAXY_VERTEX_FLOATS);
    parts.forEach((q, i) => data.set(q, i * q.length));
    const gl = this.gl, pr = this.prog.galaxy, st = 4 * GALAXY_VERTEX_FLOATS;
    gl.useProgram(pr.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf.galaxy);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    const attrs = [[2, 0], [2, 8], [2, 16], [4, 24], [4, 40], [4, 56]];   // clip xy, ellipse uv, disc uv, rgba, (mode seed bulge face), (pitch bar bar-angle scale)
    attrs.forEach(([n, off], i) => { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, st, off); });
    gl.uniform1f(pr.u.u_k, Math.min(GAL_K * this.expo, GAL_MAX));
    gl.drawArrays(gl.TRIANGLES, 0, data.length / GALAXY_VERTEX_FLOATS);
    for (let i = 4; i < 6; i++) gl.disableVertexAttribArray(i);   // attributes 4 and 5 are not used by the other programs' layouts
  }
  /**
   * Black-hole lensing looks (section 17.9, illustrative): per item a screen-aligned quad of half-size 4 x its drawn shadow radius, built here from the
   * item's screen centre (the shader draws the disc, ring, halo and accretion disc). Premultiplied "over", so the black disc hides the stars behind it.
   * The disc's position angle is arbitrary but stable (seeded from the id); its inclination is the record's i (60 degrees when unknown).
   */
  _drawLensing(items) {
    const quads = items.filter((it) => it.screen && Math.abs(it.screen[0]) < 1e7 && Math.abs(it.screen[1]) < 1e7);
    if (!quads.length) return;
    const W = this.cssW, H = this.cssH, data = new Float32Array(quads.length * 6 * 8);
    const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    let k = 0, n = 0;
    for (const it of quads) {
      const R = 4 * Math.min(it.px, LENS_PX_MAX / 4), [sx, sy] = it.screen;
      if (sx + R < 0 || sx - R > W || sy + R < 0 || sy - R > H) continue;
      let h = 2166136261; for (const ch of String(it.id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
      const ang = ((h >>> 0) % 6283) / 1000;
      for (const [cx, cy] of CORNERS) {
        data[k++] = (sx + cx * R) / W * 2 - 1; data[k++] = 1 - (sy + cy * R) / H * 2;
        data[k++] = 4 * cx; data[k++] = 4 * cy;
        data[k++] = it.disc ? 1 : 0; data[k++] = Math.cos(it.incl * D2R); data[k++] = ang; data[k++] = 0;
      }
      n++;
    }
    if (!n) return;
    const gl = this.gl, pr = this.prog.lens, st = 32;
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(pr.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf.lens);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, k), gl.STREAM_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, st, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, st, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, st, 16);
    gl.drawArrays(gl.TRIANGLES, 0, k / 8);
    gl.blendFunc(gl.ONE, gl.ONE);
  }
  _drawSky() {
    if (!this.skyTex || !this.layers.mw) return;
    const gl = this.gl, pr = this.prog.sky, u = pr.u, R = this.R;
    const dSun = Math.hypot(...F.worldPc(this.cam));
    const k = MW_K * this.expo * Math.pow(10, 0.2 * (this.limit - LIMIT_DEFAULT)) / (1 + (dSun / MW_FADE_PC) ** 2) * this._gf;   // x galaxyFade: gone before the cosmos frame
    if (k < 1e-5) return;
    gl.useProgram(pr.p);
    gl.bindVertexArray(this.vaoEmpty);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.skyTex);
    gl.uniform1i(u.u_sky, 0);
    gl.uniform2f(u.u_tan, this.tanX, this.tanY);
    gl.uniformMatrix3fv(u.u_v2w, false, M.viewToWorld3(R));
    gl.uniform1f(u.u_k, k);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
  _drawLines(key, alpha = 1) {
    const g = this.gpu[key]; if (!g || !g.n) return;
    const gl = this.gl, pr = this.prog.line, cam = this.cam;
    gl.useProgram(pr.p);
    gl.uniform1f(pr.u.u_a, alpha);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.b);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE.lines, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE.lines, 12);
    gl.uniformMatrix4fv(pr.u.u_vp, false, this.vp);
    gl.uniform3f(pr.u.u_eye, cam.pos[0], cam.pos[1], cam.pos[2]);
    gl.drawArrays(gl.LINES, 0, g.n);
  }
  _starUniforms(eye, skip) {
    const gl = this.gl, u = this.prog.star.u, cam = this.cam;
    gl.useProgram(this.prog.star.p);
    gl.uniformMatrix4fv(u.u_vp, false, this.vp);
    gl.uniform3f(u.u_eye, eye[0], eye[1], eye[2]);
    gl.uniform1f(u.u_toPc, cam.frame === 'system' ? 1 / AU_PER_PC : 1);
    gl.uniform1f(u.u_expo, this.expo * this._gf);               // the peak intensity is linear in it: the stars fade out with galaxyFade (20 to 40 kpc)
    gl.uniform1f(u.u_limit, this.limit);
    gl.uniform1f(u.u_dpr, this.dpr);
    gl.uniform1f(u.u_maxPt, this.maxPt);
    gl.uniform1f(u.u_sig, Math.max(CORE_SIGMA_PX * this.dpr, 0.5));
    gl.uniform1iv(u.u_skip, skip);
  }
  _starAttribs() {
    const gl = this.gl;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE.stars, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, STRIDE.stars, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, STRIDE.stars, 16);
  }
  _drawStars(key, skip) {
    const g = this.gpu[key]; if (!g || !g.n) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, g.b);
    this._starAttribs();
    this._starUniforms(this.cam.pos, skip);
    gl.drawArrays(gl.POINTS, 0, g.n);
  }
  _drawDynStars(data) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf.stars);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    this._starAttribs();
    this._starUniforms([0, 0, 0], new Int32Array(16).fill(-1));
    gl.drawArrays(gl.POINTS, 0, data.length / 7);
  }
  _pointAttribs() {
    const gl = this.gl;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE.points, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE.points, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, STRIDE.points, 20);
  }
  _drawPoints(g, eye) {
    if (!g || !g.n) return;
    const gl = this.gl, pr = this.prog.point;
    gl.useProgram(pr.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.b);
    this._pointAttribs();
    gl.uniformMatrix4fv(pr.u.u_vp, false, this.vp);
    gl.uniform3f(pr.u.u_eye, eye[0], eye[1], eye[2]);
    gl.uniform1f(pr.u.u_dpr, this.dpr);
    gl.drawArrays(gl.POINTS, 0, g.n);
  }
  _drawDynPoints(data) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf.points);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    this._drawPoints({ b: this.dynBuf.points, n: data.length / 8 }, [0, 0, 0]);
  }
  _drawBody(b, t) {
    const gl = this.gl, pr = this.prog.body, u = pr.u;
    const cv = M.rotateView(this.R, b.rel).map((v) => v / b.rAu);
    const sp = b.kind === 1 ? b.e.spec.sphere(b.e.o, { evidence: this.evidence }) : null;   // rgb, pole, features, ext of a sphere kind
    const ext = b.kind === 0 ? (this.evidence ? 1.1 : 3) : sp.ext;
    const rect = M.quadRect(cv, ext, this.tanX, this.tanY);
    if (!rect) return;
    gl.useProgram(pr.p);
    gl.bindVertexArray(this.vaoEmpty);
    gl.uniform4f(u.u_rect, ...(rect === 'full' ? [-1, -1, 1, 1] : rect));
    gl.uniform2f(u.u_tan, this.tanX, this.tanY);
    gl.uniform3f(u.u_c, cv[0], cv[1], cv[2]);
    gl.uniform1f(u.u_pix, (2 * this.tanY) / this.canvas.height);
    gl.uniform1f(u.u_time, this._t);
    gl.uniform1f(u.u_evid, this.evidence ? 1 : 0);
    gl.uniform1f(u.u_w, b.s);
    gl.uniform1f(u.u_ext, ext);
    const R = this.R;
    gl.uniformMatrix3fv(u.u_v2w, false, M.viewToWorld3(R));
    if (b.kind === 0) {
      const md = b.md, x = M.spriteV(M.apparentMag(this.st.gal[7 * b.idx + 3], b.dist / AU_PER_PC), this.limit) * this.expo;
      const surf = (0.3 + 0.25 * M.discRadiance(md.teff.v)) * clamp(x, 0.05, 1);    // well below white, so limb darkening and colour show
      const gr = granulation(md);
      gl.uniform1f(u.u_gran, gr.size); gl.uniform1f(u.u_gamp, gr.contrast); gl.uniform1f(u.u_spots, gr.spots ? 1 : 0);
      gl.uniform1f(u.u_seed, (b.idx * 2654435761) % 65536);
      gl.uniform1i(u.u_kind, 0);
      // md.rgb is a display (sRGB) colour; the sphere shader works in linear light, so linearise it first. Used as is,
      // the tonemapper's sRGB encoding desaturated it a second time and an orange M star came out beige.
      gl.uniform3f(u.u_col, ...md.rgb.map((c) => Math.pow(c, 2.2)));
      gl.uniform1f(u.u_u, md.limbU);
      gl.uniform1f(u.u_surf, surf);
      gl.uniform1f(u.u_glow, this.evidence ? 0 : 0.35 * surf);
      gl.uniform1f(u.u_ring, 0); gl.uniform1f(u.u_band, 0); gl.uniform1f(u.u_atm, 0);
    } else {
      const L = M.norm(b.e.sysAu.map((v) => -v)), pole = sp.pole ? M.radecToXyz(sp.pole[0], sp.pole[1], 1) : Z_UP;
      const Lv = M.rotateView(R, L), Pv = M.rotateView(R, pole);
      gl.uniform1i(u.u_kind, 1);
      gl.uniform3f(u.u_col, sp.rgb[0], sp.rgb[1], sp.rgb[2]);
      gl.uniform3f(u.u_light, Lv[0], Lv[1], Lv[2]); gl.uniform3f(u.u_pole, Pv[0], Pv[1], Pv[2]);
      gl.uniform1f(u.u_u, 0); gl.uniform1f(u.u_surf, 0.5); gl.uniform1f(u.u_glow, 0);
      gl.uniform1f(u.u_gran, 1); gl.uniform1f(u.u_gamp, 0); gl.uniform1f(u.u_spots, 0); gl.uniform1f(u.u_seed, 0);
      gl.uniform1f(u.u_ring, sp.features.ring); gl.uniform1f(u.u_band, sp.features.band); gl.uniform1f(u.u_atm, sp.features.atm);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  // ------------------------------------------------------------------ picking, labels, card
  /** Screen position in CSS px of a camera-relative vector, or null when behind the camera or well off screen. */
  _proj(rel) {
    const v = this.vp, x = rel[0], y = rel[1], z = rel[2];
    const w = v[3] * x + v[7] * y + v[11] * z + v[15];
    if (w <= 1e-30) return null;
    const nx = (v[0] * x + v[4] * y + v[8] * z + v[12]) / w, ny = (v[1] * x + v[5] * y + v[9] * z + v[13]) / w;
    if (nx < -1.1 || nx > 1.1 || ny < -1.1 || ny > 1.1) return null;
    return [(nx * 0.5 + 0.5) * this.cssW, (0.5 - ny * 0.5) * this.cssH];
  }
  /** Like _proj, but null only for points behind the camera: off-screen points still give a (possibly far) screen position. */
  _projAll(rel) {
    const v = this.vp, x = rel[0], y = rel[1], z = rel[2];
    const w = v[3] * x + v[7] * y + v[11] * z + v[15];
    if (w <= 1e-30) return null;
    return [((v[0] * x + v[4] * y + v[8] * z + v[12]) / w * 0.5 + 0.5) * this.cssW, (0.5 - (v[1] * x + v[5] * y + v[9] * z + v[13]) / w * 0.5) * this.cssH];
  }
  /**
   * What is under (px, py) in CSS px within maxPx, or null: { kind: 'star', id, idx } | { kind, id } | { kind: 'group', id }.
   * One star candidate (the brightest in reach, priority 20) and one object candidate (pickObjects) go through choosePick:
   * planets and the group marker (10) beat stars (20), which beat small bodies (30).
   */
  _pickAt(px, py, maxPx) {
    const cam = this.cam, st = this.st;
    let bi = -1, bm = Infinity, bd = 0;
    const starsPick = cam.frame === 'system' || this._gf >= GALAXY_PICK_MIN;   // faded-out stars (and every star in the cosmos frame) are not picked
    for (let i = 0; starsPick && i < st.n; i++) {
      const rel = F.relFromCam(cam, [st.pos[3 * i], st.pos[3 * i + 1], st.pos[3 * i + 2]]);
      const q = this._proj(rel); if (!q) continue;
      const reach = Math.max(maxPx, this.dyn.get(i) || 0), d = Math.hypot(q[0] - px, q[1] - py);
      if (d > reach) continue;
      const distPc = Math.hypot(...rel) / F.unitsPerPc(cam), m = M.apparentMag(st.gal[7 * i + 3], distPc);
      if (m < bm) { bm = m; bi = i; bd = d; }
    }
    const cands = [];
    if (bi >= 0) cands.push({ sel: this._starSel(bi), priority: kindSpec('star').pick.priority, d: bd });
    cands.push(pickObjects(this._vis, this._groups, px, py, maxPx, { project: this._pj, framePos: this._fp, reach: (e) => this.dyn.get(e.id) || 0, skyFade: skyFadeOf(cam), galaxyFade: this._gf }));
    const win = choosePick(cands);
    return win ? this._pickTarget(win.sel) : null;   // the Sun's marker stays kind 'sun' (drawn where Earth sees it); its card is star 0's
  }
  /** A group marker of another star stands for that star: picking it selects the host star (whose card lists the planets). */
  _pickTarget(sel) {
    const t = groupTarget(sel);
    if (t === sel || t.kind !== 'star') return sel;
    const idx = this._starIdx(t.id);
    return idx >= 0 ? this._starSel(idx) : sel;                  // the host is not in the star list: keep the group
  }
  _select(sel) {
    this.sel = sel; this._cardSig = ''; this._cardT = 0;
    if (sel.kind === 'star') this._system(sel.idx);
    else if (sel.kind === 'sun') this._system(0);
  }
  _selKey(sel) { return sel ? (sel.kind === 'star' ? 's' + sel.idx : sel.kind + ':' + sel.id) : ''; }
  _entry(id) { for (const e of this._vis) if (e.id === id) return e; return null; }
  /** Camera-relative position of a selection in the camera's frame, or null when it is not drawn. */
  _selPos(sel) {
    const cam = this.cam;
    if (sel.kind === 'star') return F.relFromCam(cam, this._starPc(sel.idx));
    if (sel.kind === 'group') { const host = String(sel.id).replace(/^group:/, ''), g = this._groups[host]; return g ? framePos({ galPc: g.pcPos, host, group: true }, cam) : null; }
    const e = this._entry(sel.id);
    return e ? framePos(e, cam) : null;
  }
  _valid(sel) {
    if (!sel) return false;
    if (sel.kind === 'star') return !!this.st.meta[sel.idx];
    if (sel.kind === 'group') { const g = this._groups[String(sel.id).replace(/^group:/, '')]; return !!(g && g.grouped); }
    return !!this._entry(sel.id);
  }
  _hoverPick() {
    const c = this.cam, h = this.hover;
    const sig = `${this._ver}|${h.x.toFixed(1)},${h.y.toFixed(1)}|${c.pos.join(',')}|${c.yaw}|${c.pitch}|${c.frame}|${this.cssW}x${this.cssH}`;
    if (sig !== this._pickSig) { this._pickSig = sig; this._pickSel = this._pickAt(h.x, h.y, PICK_PX); }
    return this._pickSel;
  }
  _fromYou(rel) {
    return fmtDistPc(Math.hypot(...rel) / F.unitsPerPc(this.cam));   // by value, not by frame: AU, pc, kpc or Mpc (section 18.5.2); solar-system objects read in AU too
  }
  /**
   * The planet list of a host star's card (renderStarCard's `children`), or null for a star without any. It lists every child of
   * the star whatever the evidence view or layers say, because the planets exist whether or not their positions are drawn. A
   * child has a Go button only while it is drawn (not in the Evidence view, its layer on) and the card is pinned.
   */
  _childrenFor(key, pinned) {
    const kids = this.store.childrenOf(key);
    if (!kids.length) return null;
    const off = [...new Set(kids.map((o) => layerOf(o.kind)).filter((l) => l && this.layers[l] === false))];
    const ofGalaxy = kids.every((o) => o.parent && !o.host);      // a galaxy's black holes sit at its centre, a measured position: the Evidence view keeps their Go there
    const go = (ofGalaxy || !this.evidence) && !off.length;
    const groups = childGroups(kids, fmtNum).map((g) => ({ title: g.title, items: g.items.map((it) => ({ name: it.name, line: it.line, tier: it.tier,
      // a galaxy's black hole is drawn only once resolved (smbhVisible), so going to it selects it first: a selected one is always drawn
      onGo: pinned && go ? () => { const s = { kind: it.o.kind, id: it.o.id }; if (it.o.parent && !it.o.host) this._select(s); this._go(s); } : null })) }));
    const items = groups.flatMap((g) => g.items);
    const label = (id) => (layerDefs().find((l) => l.id === id) || { label: id }).label;
    const note = this.evidence && !ofGalaxy ? 'Their positions on their orbits are illustrative, so the Evidence view hides them.'
      : off.length ? `The ${off.map(label).join(' and ')} layer is off, so they are not drawn.` : null;
    return { groups, items, total: kids.length, note };   // one heading per kind: 'Exoplanets · 7', 'Black holes · 1'
  }
  _renderCard(sel, pinned) {
    const rel = this._selPos(sel);
    if (sel.kind === 'star') {
      const onGo = pinned ? () => this._go(sel) : undefined;
      const m = this.st.meta[sel.idx], md = this._modelFor(sel.idx), s = this._system(sel.idx), dSun = m.kind === 'sun' ? 0 : Math.hypot(...this._starPc(sel.idx));
      const sub = m.kind === 'sun' ? 'The Sun' : m.kind === 'ctx' ? 'Bright star (XHIP parallax)' : `${fmtNum(dSun)} pc · ${fmtNum(dSun * LY)} ly from the Sun`;
      // prefer_record (section 17.8): the curated distance (with its paper) replaces the Distance row, and the Gaia single-star value is listed as not used
      const rec = m.kind === 'sun' ? null : this.store.starRecord(m.key), pv = s && s.payload && s.payload.values && s.payload.values.dist_pc;
      const pref = rec ? preferredDistanceRows(rec, { bjPc: Number.isFinite(m.gaiaPc) ? m.gaiaPc : m.kind === 'obj' && pv && Number.isFinite(pv.v) ? pv.v : null }) : null;
      const model = pref ? { ...md, notes: [...(md.notes || []), ...pref.notes] } : md;
      renderStarCard(this.card, model, { title: this._starName(sel.idx), subtitle: sub, distFromCameraText: this.evidence ? null : this._fromYou(rel), onGo, distRows: pref ? pref.rows : null,
        // the Gaia credit row (section 18.12): every Gaia star, and the archive stars that carry Gaia DR3 ids (NEA hosts) or Gaia values (the bh-curated companions)
        dataRow: m.kind === 'gaia' || (m.kind === 'obj' && m.id.startsWith('gdr3:')) || (rec && rec.provenance && rec.provenance.dataset === 'bh-curated') ? gaiaDataRow() : null,
        children: this._childrenFor(m.key, pinned),
        loading: !!s && s.state === 'loading' && pinned, error: s && s.state === 'error' ? `Could not load system details: ${s.error}` : null });
      return;
    }
    const plan = this._planFor(sel), goLabel = plan.type === 'solar-scene' ? 'Show in the Solar system' : plan.type === 'look' ? 'Turn to it' : 'Go there';
    const onGo = pinned ? () => this._go(sel) : undefined;     // clusters too: their plan is fly-galaxy
    const goDisabled = this._hostMissing(plan) ? 'host star not in this view' : null;
    if (sel.kind === 'group') {
      const host = String(sel.id).replace(/^group:/, ''), g = this._groups[host];
      const names = this._vis.filter((e) => e.host === host).sort((a, b) => a.spec.pick.priority - b.spec.pick.priority).map((e) => e.o.name);
      const sub = names.length ? `In this view: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}` : null;
      const rows = Object.entries(g.byKind).map(([k, n]) => { const sp = kindSpec(k); const noun = sp ? sp.noun[n === 1 ? 0 : 1] : k; return [noun.charAt(0).toUpperCase() + noun.slice(1), String(n), 'measured', 'objects in this view']; });
      renderBodyCard(this.card, { title: g.name, subtitle: sub, rows, onGo, goLabel, goDisabled });
      return;
    }
    if (sel.kind === 'sun') {                                     // the Sun's marker: star 0's card, placed where the marker is
      const s = this._system(0);
      renderStarCard(this.card, this._modelFor(0), { title: this._starName(0), subtitle: 'The Sun', distFromCameraText: this.evidence || !rel ? null : this._fromYou(rel), onGo, goLabel,
        loading: !!s && s.state === 'loading' && pinned, error: s && s.state === 'error' ? `Could not load system details: ${s.error}` : null });
      return;
    }
    const e = this._entry(sel.id);
    const c = e.spec.card(e.o, { fromYou: this.evidence ? null : fromYouFor(e, rel, (r) => this._fromYou(r)), evidence: this.evidence, fmtNum,
      place: this.store.placement(e.id), lensing: this._lens && this._lens.get(e.id) || null, hostName: e.host ? this.store.hostName(e.host) : null,
      hostRecord: e.host ? this.store.starRecord(e.host) : null, children: e.kind === 'galaxy' ? this.store.childrenOf(e.id) : undefined });
    // a galaxy lists its black holes with a Go there each (they are drawn only when resolved, see _childrenFor)
    const children = e.kind === 'galaxy' ? this._childrenFor(e.id, pinned) : null;
    renderBodyCard(this.card, { title: c.title, subtitle: c.subtitle, rows: c.rows, notes: c.notes, onGo, goLabel, goDisabled, children });
  }
  _updateCard(t) {
    let sel = null, pinned = false;
    if (!this.locked) {
      if (this.sel && this._valid(this.sel)) { sel = this.sel; pinned = true; }
      else if (this.hover) sel = this._hoverPick();
    }
    const hide = () => { this.card.hidden = true; this._cardT = 0; };
    if (!sel || !this._valid(sel)) return hide();
    const key = this._selKey(sel) + (pinned ? 'P' : 'h'), stale = key !== this._cardSig;
    const busy = pinned && this.card.matches(':hover');           // do not rebuild the card under the pointer (it would eat a click)
    if (stale || (!busy && t - this._cardT > (pinned ? 1000 : 250)) || this.card.hidden) {
      this._renderCard(sel, pinned);
      this._cardSig = key; this._cardT = t;
    }
    this.card.hidden = false;
    this.card.classList.toggle('pinned', pinned);
    if (pinned) { this.card.style.transform = ''; return; }
    const rel = this._selPos(sel), p = rel && this._proj(rel);
    if (!p) return hide();
    const cw = this.card.offsetWidth || 240, ch = this.card.offsetHeight || 120;
    let x = p[0] + 16, y = p[1] + 16;
    if (x + cw > this.cssW - 8) x = p[0] - cw - 16;
    if (y + ch > this.cssH - 8) y = p[1] - ch - 16;
    this.card.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }
  _labelCandidates() {
    const out = [], cam = this.cam, st = this.st;
    const hostPx = cam.frame === 'system' && !this._inSun() ? this.dyn.get(cam.host.idx) || 0 : 0;   // no labels on top of a star's disc
    const hostP = hostPx > 20 ? this._proj(F.relFromCam(cam, cam.host.pc)) : null;
    const sunMarker = !F.isHosted(cam.frame) && this._vis.some((e) => e.id === SUN_HOST.key);        // the marker is labelled "Sun": not twice
    if (this.layers.starNames && (cam.frame === 'system' || this._gf >= GALAXY_PICK_MIN)) {          // not labelled once galaxyFade has taken the stars below 0.25
      for (const i of this.namedIdx) {
        if (i === 0 && sunMarker) continue;
        const rel = F.relFromCam(cam, this._starPc(i)), p = this._proj(rel); if (!p) continue;
        if (hostP && Math.hypot(p[0] - hostP[0], p[1] - hostP[1]) < hostPx * 1.5) continue;
        const mag = M.apparentMag(st.gal[7 * i + 3], Math.hypot(...rel) / F.unitsPerPc(cam));
        if (mag > 6) continue;
        out.push({ x: p[0], y: p[1], key: mag, text: st.meta[i].name });
      }
    }
    const L = labelCandidates(this._vis, this._groups, { project: this._pj, framePos: this._fp, discPx: (e) => this.dyn.get(e.id) || 0, skyFade: skyFadeOf(cam), galaxyFade: this._gf });
    for (const l of L) out.push(l);
    return out;
  }
  _overlay(t) {
    const lab = this.lab, W = this.cssW, H = this.cssH, dpr = this.dpr;
    lab.setTransform(dpr, 0, 0, dpr, 0, 0);
    lab.clearRect(0, 0, W, H);
    lab.font = '12px "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';
    lab.textBaseline = 'middle';
    lab.shadowColor = 'rgba(5, 7, 11, 0.9)'; lab.shadowBlur = 4;
    const cands = this._labelCandidates().sort((a, b) => a.key - b.key);
    const placed = [];
    for (const L of cands) {
      if (placed.length >= MAX_LABELS) break;
      const w = lab.measureText(L.text).width;
      const box = { x0: L.x + 6, y0: L.y - 7, x1: L.x + 10 + w, y1: L.y + 7 };
      if (placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
      placed.push(box);
      const la = L.alpha != null ? L.alpha : 1;                  // a direction-only label fades with the sky (skyFade)
      lab.fillStyle = `rgba(233, 230, 223, ${(0.9 * la).toFixed(3)})`;
      lab.beginPath(); lab.arc(L.x, L.y, 1.6, 0, Math.PI * 2); lab.fill();
      lab.fillStyle = `rgba(233, 230, 223, ${(0.8 * la).toFixed(3)})`;
      lab.fillText(L.text, L.x + 8, L.y);
    }
    lab.shadowBlur = 0;
    if (this.sel && this._valid(this.sel)) {                      // ring around the selected object while it is still a speck
      const rel = this._selPos(this.sel), p = rel && this._proj(rel), px = this.dyn.get(this.sel.kind === 'star' ? this.sel.idx : this.sel.id) || 0;
      if (p && px < 14) { lab.strokeStyle = 'rgba(242, 184, 75, 0.85)'; lab.lineWidth = 1.5; lab.beginPath(); lab.arc(p[0], p[1], 11, 0, Math.PI * 2); lab.stroke(); }
    }
    if (this.locked) {                                            // crosshair
      const cx = W / 2, cy = H / 2;
      lab.strokeStyle = 'rgba(233, 230, 223, 0.7)'; lab.lineWidth = 1;
      lab.beginPath(); lab.moveTo(cx - 8, cy); lab.lineTo(cx - 3, cy); lab.moveTo(cx + 3, cy); lab.lineTo(cx + 8, cy);
      lab.moveTo(cx, cy - 8); lab.lineTo(cx, cy - 3); lab.moveTo(cx, cy + 3); lab.lineTo(cx, cy + 8); lab.stroke();
      const xh = this._crosshairTarget(t);
      if (xh) {
        lab.textAlign = 'center'; lab.lineJoin = 'round'; lab.lineWidth = 3.5; lab.strokeStyle = 'rgba(5, 7, 11, 0.9)';   // outlined: stays readable on a bright disc
        const line = (text, y, fill) => { lab.strokeText(text, cx, y); lab.fillStyle = fill; lab.fillText(text, cx, y); };
        line(xh.name, cy + 24, 'rgb(240, 237, 230)');
        let y = cy + 40;
        if (xh.dist) { line(xh.dist, y, 'rgb(225, 222, 214)'); y += 16; }          // a direction-only target has no distance
        line(xh.turn ? 'G to turn to it' : 'G to autopilot', y, 'rgb(250, 200, 100)');
        lab.textAlign = 'start'; lab.lineWidth = 1;
      }
    }
    this._updateCard(t);
    this._hud(t);
  }
  /** The object nearest the screen centre within XHAIR_DEG, refreshed at ~10 Hz: { name, dist } or null. */
  _crosshairTarget(t) {
    if (t - this._xhT < XHAIR_MS) return this._xh;
    this._xhT = t;
    const sel = this._pickAt(this.cssW / 2, this.cssH / 2, XHAIR_DEG * D2R * this.pxPerRad);
    if (!sel || !this._valid(sel)) return (this._xh = null);
    if (sel.kind === 'star') this._system(sel.idx);             // prefetch: you may be about to fly there
    const rel = this._selPos(sel); if (!rel) return (this._xh = null);
    const d = Math.hypot(...rel), u = F.unitsPerPc(this.cam), e = sel.kind === 'star' || sel.kind === 'group' ? null : this._entry(sel.id);
    // Distance to the surface, like the HUD's Nearest row (radius in frame units).
    const rad = sel.kind === 'star' ? this._modelFor(sel.idx).radiusAu * u / AU_PER_PC : e && !e.atInfinity ? e.spec.arriveAu(e.o) * u / AU_PER_PC : 0;
    const surf = d > 0 ? rel.map((v) => v * Math.max(0, d - rad) / d) : rel;
    const name = sel.kind === 'star' ? this._starName(sel.idx) : sel.kind === 'group' ? this._groups[String(sel.id).replace(/^group:/, '')].name : e.o.name;
    const short = name.length > 28 && /^Gaia/i.test(name) ? 'Gaia …' + name.slice(-8) : name;
    const inf = !!(e && e.atInfinity);
    return (this._xh = { name: short, dist: inf ? null : this._fromYou(surf), turn: inf, sel });
  }
  /** "7 exoplanets (positions illustrative)" in a system frame of a star with planets, else ''. */
  _hostCountText() {
    const key = this._hostKey();
    return key && key !== SUN_HOST.key ? hostCountText(this.store, key, { evidence: this.evidence, layers: this.layers }) : '';
  }
  /** Visible object counts by kind in the unhosted frames ({} in a system), for the HUD's exoplanet, cluster and galaxy phrases; faded-out entries are not counted. */
  _visCounts() { return F.isHosted(this.cam.frame) ? { counts: {}, direct: {} } : visibleCounts(this._vis.filter((e) => presenceOf(e) >= GALAXY_PICK_MIN)); }
  _hudData() {
    const cam = this.cam, inSys = cam.frame === 'system', near = this._nearest(), near2 = this._nearBody(), vc = this._visCounts();
    return {
      scene: this.scene, frame: cam.frame, unit: F.levelOf(cam.frame).unit,
      hostName: inSys ? near.name : null,
      surfaceAu: inSys ? near.au : null,
      sunPc: F.worldPc(cam), speed: this.speedPc * F.unitsPerPc(cam), speedPc: this.speedPc, cruise: this._cruise(), cruisePc: this._cruise() / F.unitsPerPc(cam), auto: this.autoSpeed, throttle: this.throttle,
      starsOn: inSys || this._gf > 0,
      nearName: near2.name, nearText: Number.isFinite(near2.d) ? this._fromYou([near2.d]) : null, xhair: this.locked ? this._xh : null, ev: Math.log2(this.expo),
      limit: this.limit, locked: this.locked, counts: { ...this.counts }, objCounts: this.store.counts(), evidence: this.evidence,
      hostCount: this._hostCountText(), visCounts: vc.counts, visDirect: vc.direct,
      flying: !!this.ap, selected: this.sel && this._valid(this.sel) ? this._selKey(this.sel) : null,
    };
  }
  _hud(t) {
    if (t - this._hudT < 250) return;
    this._hudT = t;
    const h = this._hudData();
    h.dist = Math.hypot(...h.sunPc);
    this.hooks.onHud(h);
  }
}
