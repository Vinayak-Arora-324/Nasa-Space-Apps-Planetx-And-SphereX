// Scene3D: WebGL2 renderer and fly controls for scene3d.html.
//
// One camera model (yaw and pitch, world +z is celestial north) and two kinds of frame (scene3d-frames.js):
//   galaxy - parsecs, origin at the Sun: Gaia stars at their parallax distances plus the bright XHIP stars
//   system - AU, origin at a host star (the Sun included): the host is a sphere, and the Sun's planets are spheres too
// Everything is drawn camera-relative. Stars are additive points; stars near the camera and the planets are drawn from
// positions computed in doubles; bodies big enough to see as discs are ray-traced spheres (impostors) on screen quads.
// Scene brightness goes into an RGBA16F target (when the browser can) and is bloomed and tonemapped at the end.
import * as M from './scene3d-math.js';
import * as F from './scene3d-frames.js';
import { starModel } from './scene3d-physics.js';
import { Autopilot, arrivalDistance, suggestSpeed, TURN_SECONDS } from './scene3d-nav.js';
import { renderStarCard, renderBodyCard } from './scene3d-card.js';
import { makeProgram, supportsHdr, HdrChain } from './scene3d-gl.js';
import * as S from './scene3d-shaders.js';
import { getSystem } from '../api.js';

const { D2R, LY_PER_PC: LY, V_EXPO } = M;
const { AU_PER_PC } = F;
const RANGE = { galaxy: { min: 0.01, max: 10000, speed: 2 }, system: { min: 1e-6, max: 1e3, speed: 0.2 } };
const CONE_DIST = 3000;          // pc, the distance at which the cone-edge ring is drawn
const BASE_PX = 1.6;             // CSS px of a star at the magnitude limit
const PX_PER_MAG = 1.25;         // CSS px added per magnitude brighter than the limit
const LIMIT_DEFAULT = 12, LIMIT_MIN = 0, LIMIT_MAX = 25;
const MAX_LABELS = 40, MAX_BODY_LABELS = 12;
const PICK_PX = 10, GO_DEG = 2;
const NEAR_PC = 0.05;            // stars this close to the camera are drawn exactly and may become spheres
const FOV_SYSTEM = 60;
const SUN_ABS_G = 4.67, SUN_BP_RP = 0.82;
const Z_UP = [0, 0, 1];
const SUN_HOST = { idx: 0, key: 'sun', name: 'Sun', pc: [0, 0, 0] };
// No Ctrl here: holding Ctrl while pressing W would close the tab.
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
const PLANET_RGB = {
  Mercury: [0.75, 0.72, 0.68], Venus: [0.95, 0.85, 0.6], Earth: [0.35, 0.62, 1.0], Moon: [0.8, 0.8, 0.8],
  Mars: [1.0, 0.5, 0.35], Jupiter: [0.92, 0.8, 0.66], Saturn: [0.95, 0.87, 0.6], Uranus: [0.6, 0.9, 0.95], Neptune: [0.42, 0.6, 1.0],
};
const POLE = { Jupiter: [268.06, 64.5], Saturn: [40.59, 83.54], Mars: [317.68, 52.89] };   // RA, Dec of the spin axes (illustrative)

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** Number for the readout: 3 significant figures, with thousands separators. */
export const fmtNum = (v, sig = 3) => (Number.isFinite(v) ? v.toLocaleString('en-US', { maximumSignificantDigits: sig }) : 'n/a');
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
function bodyRgb(cls) {
  const c = String(cls || '');
  if (/^(C|P|D|I)/.test(c)) return [0.6, 0.9, 1.0];   // comets
  if (/NEO|PHA|Apollo|Aten|Amor/i.test(c)) return [1.0, 0.7, 0.5];
  return [0.82, 0.78, 0.7];
}

export class Scene3D {
  /**
   * canvas: WebGL canvas. labels: 2D canvas laid over it. card: element for the picked-object card.
   * ra, dec, radius: the patch (degrees). Throws if WebGL2 is unavailable or a shader fails to build.
   */
  constructor({ canvas, labels, card, ra, dec, radius = 3, onHud = () => {}, onScene = () => {}, onLost = () => {}, onEvidence = () => {} }) {
    this.canvas = canvas; this.labelsEl = labels; this.lab = labels.getContext('2d'); this.card = card;
    this.target = { ra, dec, radius };
    this.fovStars = clamp(radius * 2.5, 20, 70);
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.hooks = { onHud, onScene, onLost, onEvidence };
    this.cpu = {}; this.gpu = {};
    this.limit = LIMIT_DEFAULT; this.evidence = false; this.bloomK = 1; this.bloomT = 0.45;
    this.ctx = []; this.gaia = null; this.solarData = null; this.namedIdx = [];
    this.st = { n: 0, pos: new Float64Array(0), data: new Float32Array(0), gal: new Float32Array(0), meta: [] };
    this.planets = []; this.bodies = []; this.sunPos = [0, 0, 0];
    this.counts = { gaia: 0, ctx: 0, planets: 0, bodies: 0 };
    this.keys = new Set(); this.touch = new Map(); this.pinch = null;
    this.hover = null; this.sel = null; this.locked = false;
    this.sys = new Map(); this.models = new Map();
    this.ap = null; this.dyn = new Map(); this.cands = [];
    this.dpr = 1; this.cssW = 1; this.cssH = 1; this.vp = new Float32Array(16); this.R = M.lookRotation([1, 0, 0]);
    this.expo = 1; this.expoTarget = 1; this.vScan = 0; this.scanN = 0; this.hdrBad = false;
    this.lost = false; this.running = false; this._last = 0; this._hudT = 0; this._cardT = 0; this._cardSig = ''; this._raf = 0;
    this._pickSig = ''; this._pickSel = null; this._frameNo = 0; this._t = 0;
    this._frame = this._frame.bind(this);
    this.cam = this._startCam('stars');
    this.fov = this.fovStars;
    this._initGL();
    const cone = linesToBuf(M.coneLines(ra, dec, radius, CONE_DIST), [1, 0.82, 0.55, 0.4]);
    this._put('lineStars', cone.data, cone.n);
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
      star: makeProgram(gl, S.STAR_VS, S.SPRITE_FS, S.SPRITE_UNIFORMS_STAR, d),
      point: makeProgram(gl, S.POINT_VS, S.SPRITE_FS, ['u_vp', 'u_eye', 'u_dpr'], d),
      line: makeProgram(gl, S.LINE_VS, S.LINE_FS, ['u_vp', 'u_eye'], d),
      body: makeProgram(gl, S.BODY_VS, S.BODY_FS, S.BODY_UNIFORMS, d),
    };
    this.vaoEmpty = this.hdr ? this.hdr.vao : gl.createVertexArray();
    this.dynBuf = { stars: gl.createBuffer(), points: gl.createBuffer() };
    this.maxPt = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
    this.gpu = {};
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
  /** Solar payload: the `solar` object of /api/scene3d. */
  setSolar(s) {
    if (!s || !Array.isArray(s.earth)) return;
    this.solarData = { earth: s.earth.slice(0, 3) };
    const pts = [], orbits = [], planets = [];
    let earthListed = false;
    const addPlanet = (name, p) => {
      const km = M.PLANET_KM[name];
      planets.push({ name, kind: name === 'Moon' ? 'moon' : 'planet', pos: [p[0], p[1], p[2]], rAu: km ? km / M.KM_PER_AU : 4e-5, rgb: PLANET_RGB[name] || [0.8, 0.8, 0.8] });
    };
    for (const p of s.planets || []) {
      earthListed = earthListed || p.name === 'Earth';
      addPlanet(p.name, [p.x, p.y, p.z]);
      if (p.name !== 'Moon') orbits.push(M.orbitCircle(Math.hypot(p.x, p.y, p.z)));
    }
    if (!earthListed) { addPlanet('Earth', this.solarData.earth); orbits.push(M.orbitCircle(Math.hypot(...this.solarData.earth))); }
    this.planets = planets;
    const bodies = s.bodies || [];
    this.bodies = bodies.map((b) => ({ kind: 'body', name: b.name || null, number: b.number, cls: b.class, vmag: b.vmag, dh: b.dh_au, dg: b.dg_au, pos: [b.x, b.y, b.z] }));
    for (const b of bodies) {
      const c = bodyRgb(b.class);
      pts.push(b.x, b.y, b.z, 3, 0.9, c[0], c[1], c[2]);
    }
    this._pickSig = '';
    this.counts.planets = planets.length; this.counts.bodies = bodies.length;
    this._put('points', new Float32Array(pts), pts.length / 8);
    const lines = linesToBuf(orbits, [0.6, 0.7, 0.95, 0.18]);
    this._put('lineSolar', lines.data, lines.n);
    const { ra, dec, radius } = this.target, e = this.solarData.earth;
    const cone = M.coneLines(ra, dec, radius, 8).map((pl) => pl.map((q) => [q[0] + e[0], q[1] + e[1], q[2] + e[2]]));
    const cb = linesToBuf(cone, [1, 0.82, 0.55, 0.4]);
    this._put('coneSolar', cb.data, cb.n);
    if (this.scene === 'solar') this.cam = this._startCam('solar');
  }
  get hasSolar() { return !!this.solarData; }
  /** 'solar' while the camera is in the Sun's system frame, otherwise 'stars'. */
  get scene() { return this.cam.frame === 'system' && this.cam.host.key === 'sun' ? 'solar' : 'stars'; }
  get fovDeg() { return this.fov; }

  _rebuildStars() {
    const g = this.gaia, { ra, dec, radius } = this.target;
    // Gaia misses the brightest stars (saturation) and the parallax cut drops others, so a context star inside the cone
    // is dropped only when a Gaia star of similar brightness sits within 2' of it (2' covers decades of proper motion).
    const ctx = g ? this.ctx.filter((c) => M.separationDeg(c.ra, c.dec, ra, dec) >= radius || !g.match(c)) : this.ctx;
    const rows = g ? g.rows : [];
    const n = 1 + rows.length + ctx.length;                      // the Sun is star 0
    const pos = new Float64Array(3 * n), gal = new Float32Array(7 * n), meta = new Array(n), named = [0];
    meta[0] = { kind: 'sun', name: 'Sun', id: 'sun', abs: SUN_ABS_G, bp: SUN_BP_RP, d: 0 };
    gal[3] = SUN_ABS_G; gal.set(M.bpRpToRgb(SUN_BP_RP), 4);
    let k = 1;
    if (g) {
      const I = g.I;
      for (const r of rows) {
        const o = 7 * k, abs = Number.isFinite(r[I.abs_g]) ? r[I.abs_g] : 5;
        pos[3 * k] = r[I.x]; pos[3 * k + 1] = r[I.y]; pos[3 * k + 2] = r[I.z];
        gal[o + 3] = abs; gal.set(M.bpRpToRgb(r[I.bp_rp]), o + 4);
        meta[k] = { kind: 'gaia', id: String(r[I.id]), dlo: r[I.d_lo], dhi: r[I.d_hi], bp: r[I.bp_rp], abs, name: null };
        k++;
      }
    }
    for (const c of ctx) {
      const o = 7 * k, p = M.radecToXyz(c.ra, c.dec, c.d);
      pos.set(p, 3 * k); gal[o + 3] = c.absMag; gal.set(M.bpRpToRgb(c.bpRp), o + 4);
      meta[k] = { kind: 'ctx', hip: c.hip, name: c.name, d: c.d, vmag: c.vmag, bp: c.bpRp, abs: c.absMag };
      if (c.name) named.push(k);
      k++;
    }
    for (let i = 0; i < n; i++) { gal[7 * i] = pos[3 * i]; gal[7 * i + 1] = pos[3 * i + 1]; gal[7 * i + 2] = pos[3 * i + 2]; }
    this.st = { n, pos, gal, data: gal, meta };
    this.namedIdx = named; this._pickSig = ''; this.models.clear(); this.dyn.clear(); this.sel = null; this.ap = null;
    this.counts.gaia = rows.length; this.counts.ctx = ctx.length;
    if (this.cam.frame === 'system') this.cam.host = { ...this.cam.host };
    this._syncStarFrame();
  }
  /** Fill the star buffer for the camera's frame: parsecs in the galaxy frame, AU relative to the host in a system frame. */
  _syncStarFrame() {
    const st = this.st;
    if (this.cam.frame === 'galaxy') st.data = st.gal;
    else {
      const d = new Float32Array(st.gal), h = this.cam.host.pc;
      for (let i = 0; i < st.n; i++) {
        d[7 * i] = (st.pos[3 * i] - h[0]) * AU_PER_PC; d[7 * i + 1] = (st.pos[3 * i + 1] - h[1]) * AU_PER_PC; d[7 * i + 2] = (st.pos[3 * i + 2] - h[2]) * AU_PER_PC;
      }
      st.data = d;
    }
    this._put('stars', st.data, st.n);
  }
  _starPc(i) { const p = this.st.pos; return [p[3 * i], p[3 * i + 1], p[3 * i + 2]]; }
  _starKey(i) { const m = this.st.meta[i]; return m.kind === 'sun' ? 'sun' : m.kind === 'gaia' ? 'g:' + m.id : 'c:' + m.hip; }
  _starName(i) {
    const m = this.st.meta[i], s = this.sys.get(this._starKey(i));
    if (s && s.payload && s.payload.name) return s.payload.name;
    return m.name || (m.kind === 'gaia' ? (/^Gaia/i.test(m.id) ? m.id : `Gaia DR3 ${m.id}`) : `HIP ${m.hip}`);
  }
  _modelFor(i) {
    let md = this.models.get(i);
    if (md) return md;
    const m = this.st.meta[i], s = this.sys.get(this._starKey(i)), system = s && s.payload ? s.payload : undefined;
    const distPc = m.kind === 'sun' ? 0 : Math.hypot(...this._starPc(i));
    if (m.kind === 'sun') md = starModel({ kind: 'sun', system });
    else if (m.kind === 'gaia') md = starModel({ system, absG: m.abs, bpRp: m.bp, distPc, kind: 'gaia' });
    else md = starModel({ absG: m.abs, bpRp: m.bp, distPc: m.d, name: m.name, kind: 'ctx' });
    this.models.set(i, md);
    return md;
  }
  /** The system payload for a star (fetched once, cached): { state: 'loading' | 'ok' | 'error', payload, error }. */
  _system(i) {
    const m = this.st.meta[i];
    if (m.kind === 'ctx') return null;
    const key = this._starKey(i);
    let s = this.sys.get(key);
    if (s) return s;
    s = { state: 'loading', payload: null, error: null };
    this.sys.set(key, s);
    getSystem(m.kind === 'sun' ? 'sun' : m.id).then((p) => { s.state = 'ok'; s.payload = p; }, (e) => { s.state = 'error'; s.error = e.message || String(e); })
      .finally(() => { this.models.delete(i); this._cardSig = ''; });
    return s;
  }

  // ------------------------------------------------------------------ scenes and camera
  _startCam(scene) {
    const { ra, dec } = this.target;
    const { yaw, pitch: p0 } = M.yawPitchFromDir(M.radecToXyz(ra, dec, 1));
    const pitch = clamp(p0, -1.5, 1.5);                         // same limit as mouse look: up = +z must not be parallel to the view
    if (scene === 'solar' && this.solarData) {
      // Near Earth, a little sunward and above the ecliptic, looking at it: the Moon, the Sun's glare and the orbits in view.
      const e = this.solarData.earth, eps = M.OBLIQUITY_DEG * D2R;
      const nep = [0, -Math.sin(eps), Math.cos(eps)];
      const toSun = M.norm(e.map((v) => -v)), side = M.norm(M.cross(nep, toSun));
      const off = M.norm([0, 1, 2].map((k) => 0.5 * toSun[k] + 0.8 * side[k] + 0.3 * nep[k]));
      const pos = [0, 1, 2].map((k) => e[k] + 0.004 * off[k]);
      const v = M.yawPitchFromDir(sub3(e, pos));
      return F.makeCam({ frame: 'system', host: SUN_HOST, pos, yaw: v.yaw, pitch: clamp(v.pitch, -1.5, 1.5), speed: 0.002 });
    }
    return F.makeCam({ pos: [0, 0, 0], yaw, pitch, speed: RANGE.galaxy.speed, disarm: 'sun' });
  }
  setScene(name) {
    if (name === 'solar' && !this.solarData) return;
    this.ap = null; this.sel = null; this.hover = null; this.card.hidden = true; this._cardT = 0;
    this.cam = this._startCam(name);
    this._syncStarFrame();
    this.hooks.onScene(this.scene);
  }
  toggleScene() { this.setScene(this.scene === 'stars' ? 'solar' : 'stars'); }
  resetView() { this.setScene(this.scene); }
  setEvidence(on) { this.evidence = !!on; this._cardSig = ''; this.hooks.onEvidence(this.evidence); }
  toggleEvidence() { this.setEvidence(!this.evidence); }

  // ------------------------------------------------------------------ controls
  _key(e, down) {
    const code = e.code;
    if (!down) { this.keys.delete(code); return; }
    if (e.metaKey) return;
    if (e.ctrlKey || e.altKey) return;                          // leave Ctrl+F, Ctrl+R and friends alone
    if (MOVE_KEYS.has(code)) { this.keys.add(code); this.ap = null; e.preventDefault(); return; }
    if (e.repeat) { if (code === 'Tab') e.preventDefault(); return; }
    if (code === 'Tab') { e.preventDefault(); this.toggleScene(); return; }
    if (code === 'KeyH') { this.resetView(); return; }
    if (code === 'KeyE') { this.toggleEvidence(); return; }
    if (code === 'KeyG') { this._goFromCrosshair(); return; }
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
    for (let i = 0; i < 3; i++) cam.pos[i] += f[i] * amount * cam.speed;
  }
  _wheel(e) {
    e.preventDefault();
    const cam = this.cam, r = RANGE[cam.frame];
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    cam.speed = clamp(cam.speed * Math.exp(-dy * 0.0015), r.min, r.max);   // logarithmic: equal steps, equal ratios
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
    const target = len > 1e-9 ? w.map((v) => (v / len) * cam.speed * boost) : [0, 0, 0];
    const a = 1 - Math.exp(-dt * 8);                       // velocity eases toward the target: no hard starts or stops
    for (let i = 0; i < 3; i++) { cam.vel[i] += (target[i] - cam.vel[i]) * a; cam.pos[i] += cam.vel[i] * dt; }
  }

  // ------------------------------------------------------------------ autopilot
  /** A selection -> what the autopilot needs: { world pc or AU position, radius in AU, name }. */
  _resolve(sel) {
    if (!sel) return null;
    if (sel.t === 'star' && this.st.meta[sel.idx]) {
      const md = this._modelFor(sel.idx);
      return { type: 'star', idx: sel.idx, pc: this._starPc(sel.idx), rAu: md.radiusAu, name: this._starName(sel.idx) };
    }
    if (sel.t === 'planet') {
      const p = this.planets.find((q) => q.name === sel.name);
      return p ? { type: 'planet', pos: p.pos, rAu: p.rAu, name: p.name } : null;
    }
    if (sel.t === 'body' && this.bodies[sel.idx]) { const b = this.bodies[sel.idx]; return { type: 'body', pos: b.pos, rAu: 0, name: b.name || `(${b.number})` }; }
    return null;
  }
  _inSun() { return this.cam.frame === 'system' && this.cam.host.key === 'sun'; }
  _goFromCrosshair() {
    const px = (GO_DEG * D2R) * this.pxPerRad;
    this._go(this._pickAt(this.cssW / 2, this.cssH / 2, px) || this.sel);
  }
  _go(sel) {
    const t = this._resolve(sel), cam = this.cam;
    if (!t) return;
    if (t.type !== 'star' && !this._inSun()) return;           // planets only exist in the Sun's frame
    const dir = M.dirFromYawPitch(cam.yaw, cam.pitch), stopAu = arrivalDistance(t.rAu), obj = new Autopilot();
    // Stars: the whole trip runs in galaxy parsecs (doubles keep the last few AU exact), so crossing into the star's
    // system frame needs no restart. Planets and small bodies run in the Sun's AU frame.
    if (t.type === 'star') obj.start({ from: F.worldPc(cam), fromDir: dir, to: t.pc, stopAt: stopAu / AU_PER_PC });
    else obj.start({ from: cam.pos.slice(), fromDir: dir, to: t.pos, stopAt: stopAu });
    this.ap = { obj, sel, type: t.type, unitsPerPc: t.type === 'star' ? 1 : AU_PER_PC };
    cam.vel = [0, 0, 0];
  }
  _stepAutopilot(dt) {
    const ap = this.ap, cam = this.cam; if (!ap) return;
    if (ap.type !== 'star' && !this._inSun()) { this.ap = null; return; }
    const t = this._resolve(ap.sel);
    if (!t) { this.ap = null; return; }
    if (ap.type !== 'star') ap.obj.retarget(t.pos);
    const r = ap.obj.step(dt);
    cam.pos = ap.type === 'star' ? (cam.frame === 'system' ? F.toSystemPos(r.pos, cam.host.pc) : r.pos.slice()) : r.pos.slice();
    const v = M.yawPitchFromDir(r.dir);
    cam.yaw = v.yaw; cam.pitch = clamp(v.pitch, -1.5, 1.5); cam.vel = [0, 0, 0];
    if (r.done) { this.ap = null; this._arrived(t); }
  }
  _arrived(t) {
    const cam = this.cam, upc = F.unitsPerPc(cam);
    const surfAu = this._surfaceAu();
    cam.speed = clamp(suggestSpeed(surfAu * (upc / AU_PER_PC), upc), RANGE[cam.frame].min, RANGE[cam.frame].max);
    if (t.type === 'star' && cam.frame === 'system') this.hooks.onHud(this._hudData());
  }
  /** The sphere whose surface is nearest the camera: { name, au } (au = Infinity when in the galaxy frame). */
  _nearest() {
    const cam = this.cam;
    if (cam.frame !== 'system') return { name: null, au: Infinity };
    let best = { name: this._starName(cam.host.idx), au: Math.max(0, Math.hypot(...cam.pos) - this._modelFor(cam.host.idx).radiusAu) };
    if (this._inSun()) for (const p of this.planets) {
      const au = Math.max(0, Math.hypot(...sub3(p.pos, cam.pos)) - p.rAu);
      if (au < best.au) best = { name: p.name, au };
    }
    return best;
  }
  /** Distance from the camera to the nearest sphere surface, in AU (Infinity when there is none). */
  _surfaceAu() { return this._nearest().au; }
  /** After a frame switch: the free-flight speed that suits the new surroundings, and the star buffer. */
  _onFrameChange(kind) {
    const cam = this.cam;
    this._syncStarFrame(); this._pickSig = ''; this.hooks.onScene(this.scene);
    if (kind === 'enter') {
      cam.speed = clamp(suggestSpeed(this._surfaceAu(), AU_PER_PC), RANGE.system.min, RANGE.system.max);
      if (this.sel && this.sel.t !== 'star') this.sel = null;
    } else cam.speed = clamp(Math.max(cam.speed / AU_PER_PC, 0.05), RANGE.galaxy.min, RANGE.galaxy.max);
    if (this.ap && this.ap.type !== 'star') this.ap = null;
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
    const want = cam.frame === 'system' ? FOV_SYSTEM : this.fovStars;
    this.fov += (want - this.fov) * (dt > 0 ? 1 - Math.exp(-dt * 3) : 0);
    const dir = M.dirFromYawPitch(cam.yaw, cam.pitch);
    const aspect = this.canvas.width / this.canvas.height;
    this.R = M.lookRotation(dir, Z_UP);                          // rotation only: translation is subtracted before this
    const [n, f] = cam.frame === 'system' ? [1e-9, 1e12] : [1e-9, 1e9];
    this.vp = M.mul4(M.perspective(this.fov * D2R, aspect, n, f), this.R);
    this.tanY = Math.tan(this.fov * D2R / 2); this.tanX = this.tanY * aspect;
    this.pxPerRad = (this.cssH / 2) / this.tanY;
  }
  /** Stars within NEAR_PC of the camera: nearest first handled by stepFrame, all of them drawn exactly. */
  _scan() {
    const st = this.st, w = F.worldPc(this.cam), out = [], r2 = NEAR_PC * NEAR_PC, p = st.pos;
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
    return Math.max(v, this.vScan);
  }
  _frame(t) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._frame);
    const dt = this._last ? Math.min(0.05, (t - this._last) / 1000) : 0;
    this._last = t; this._t = t / 1000; this._frameNo++;
    this._resize();
    this._step(dt);
    this._stepAutopilot(dt);
    let cands = this._scan();
    const sw = F.stepFrame(this.cam, cands);
    if (sw) { this._onFrameChange(sw); cands = this._scan(); }
    this._matrices(dt);
    // exposure: eased toward what the brightest thing in view needs
    this.expoTarget = M.exposureFor(this._brightest(cands));
    this.expo = dt > 0 ? M.easeExposure(this.expo, this.expoTarget, dt) : this.expoTarget;
    this._draw(cands, t);
    this._overlay(t);
  }

  // ------------------------------------------------------------------ drawing
  _draw(cands, t) {
    const gl = this.gl, cam = this.cam, W = this.canvas.width, H = this.canvas.height;
    const hdr = this.hdr && this.hdr.ok ? this.hdr : null;
    if (hdr) hdr.begin(); else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    const sun = this._inSun();
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
    if (sun) {
      for (const p of this.planets) {
        const relv = sub3(p.pos, cam.pos), dist = Math.hypot(...relv), angPx = M.angRadius(p.rAu, dist) * this.pxPerRad, s = M.sphereWeight(angPx);
        this.dyn.set('p:' + p.name, angPx);
        const size = p.name === 'Earth' ? 9 : p.name === 'Moon' ? 4 : 6.5;
        if (dist > p.rAu) dynPts.push(relv[0], relv[1], relv[2], size, 1 - s, p.rgb[0], p.rgb[1], p.rgb[2]);
        if (s > 0 && dist > p.rAu) bodies.push({ kind: 1, rel: relv, dist, rAu: p.rAu, s, p });
      }
    }
    // lines
    if (cam.frame === 'galaxy') this._drawLines('lineStars');
    else if (sun) { this._drawLines('lineSolar'); this._drawLines('coneSolar'); }
    this._drawStars('stars', skip);
    if (dynStars.length) this._drawDynStars(new Float32Array(dynStars));
    if (sun) { this._drawPoints(this.gpu.points, [0, 0, 0].map((_, i) => cam.pos[i])); if (dynPts.length) this._drawDynPoints(new Float32Array(dynPts)); }
    // spheres, far to near, premultiplied "over"
    bodies.sort((a, b) => b.dist - a.dist);
    if (bodies.length) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      for (const b of bodies) this._drawBody(b, t);
    }
    if (hdr) hdr.finish({ strength: this.bloomK * (0.1 + 0.2 * clamp(-Math.log10(this.expo) / 4, 0, 1)), exposure: 1, threshold: this.bloomT });
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  _drawLines(key) {
    const g = this.gpu[key]; if (!g || !g.n) return;
    const gl = this.gl, pr = this.prog.line, cam = this.cam;
    gl.useProgram(pr.p);
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
    gl.uniform1f(u.u_expo, this.expo);
    gl.uniform1f(u.u_limit, this.limit);
    gl.uniform1f(u.u_base, BASE_PX * this.dpr);
    gl.uniform1f(u.u_perMag, PX_PER_MAG * this.dpr);
    gl.uniform1f(u.u_dpr, this.dpr);
    gl.uniform1f(u.u_maxPt, this.maxPt);
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
    const ext = b.kind === 0 ? (this.evidence ? 1.1 : 3) : b.p.name === 'Saturn' && !this.evidence ? 2.4 : 1.1;
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
    gl.uniformMatrix3fv(u.u_v2w, false, [R[0], R[1], R[2], R[4], R[5], R[6], R[8], R[9], R[10]]);
    if (b.kind === 0) {
      const md = b.md, x = M.spriteV(M.apparentMag(this.st.gal[7 * b.idx + 3], b.dist / AU_PER_PC), this.limit) * this.expo;
      const surf = (0.45 + 0.35 * M.discRadiance(md.teff.v)) * clamp(x, 0.05, 1);   // below white, so limb darkening and colour show
      gl.uniform1i(u.u_kind, 0);
      gl.uniform3f(u.u_col, md.rgb[0], md.rgb[1], md.rgb[2]);
      gl.uniform1f(u.u_u, md.limbU);
      gl.uniform1f(u.u_surf, surf);
      gl.uniform1f(u.u_glow, this.evidence ? 0 : 0.35 * surf);
      gl.uniform1f(u.u_ring, 0); gl.uniform1f(u.u_band, 0); gl.uniform1f(u.u_atm, 0);
    } else {
      const p = b.p, L = M.norm(p.pos.map((v) => -v)), pole = POLE[p.name] ? M.radecToXyz(POLE[p.name][0], POLE[p.name][1], 1) : Z_UP;
      const Lv = M.rotateView(R, L), Pv = M.rotateView(R, pole);
      gl.uniform1i(u.u_kind, 1);
      gl.uniform3f(u.u_col, p.rgb[0], p.rgb[1], p.rgb[2]);
      gl.uniform3f(u.u_light, Lv[0], Lv[1], Lv[2]); gl.uniform3f(u.u_pole, Pv[0], Pv[1], Pv[2]);
      gl.uniform1f(u.u_u, 0); gl.uniform1f(u.u_surf, 0.5); gl.uniform1f(u.u_glow, 0);
      gl.uniform1f(u.u_ring, p.name === 'Saturn' ? 1 : 0);
      gl.uniform1f(u.u_band, p.name === 'Jupiter' || p.name === 'Saturn' ? 1 : 0);
      gl.uniform1f(u.u_atm, p.name === 'Earth' || p.name === 'Venus' ? 1 : 0);
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
  /** Object under (px, py) in CSS px within maxPx: a planet, else the brightest star, else a small body. null for none. */
  _pickAt(px, py, maxPx) {
    const cam = this.cam, sun = this._inSun();
    if (sun) {
      let best = null, bestD = Infinity;
      for (const p of this.planets) {
        const q = this._proj(sub3(p.pos, cam.pos)); if (!q) continue;
        const d = Math.hypot(q[0] - px, q[1] - py), reach = Math.max(maxPx, this.dyn.get('p:' + p.name) || 0);
        if (d <= reach && d < bestD) { bestD = d; best = { t: 'planet', name: p.name }; }
      }
      if (best) return best;
    }
    const st = this.st;
    let bi = -1, bm = Infinity;
    for (let i = 0; i < st.n; i++) {
      const rel = F.relFromCam(cam, [st.pos[3 * i], st.pos[3 * i + 1], st.pos[3 * i + 2]]);
      const q = this._proj(rel); if (!q) continue;
      const reach = Math.max(maxPx, this.dyn.get(i) || 0);
      if (Math.hypot(q[0] - px, q[1] - py) > reach) continue;
      const distPc = Math.hypot(...rel) / F.unitsPerPc(cam), m = M.apparentMag(st.gal[7 * i + 3], distPc);
      if (m < bm) { bm = m; bi = i; }
    }
    if (bi >= 0) return { t: 'star', idx: bi };
    if (sun) {
      let best = null, bestD = maxPx;
      this.bodies.forEach((b, i) => {
        const q = this._proj(sub3(b.pos, cam.pos)); if (!q) return;
        const d = Math.hypot(q[0] - px, q[1] - py);
        if (d <= bestD) { bestD = d; best = { t: 'body', idx: i }; }
      });
      return best;
    }
    return null;
  }
  _select(sel) {
    this.sel = sel; this._cardSig = ''; this._cardT = 0;
    if (sel.t === 'star') this._system(sel.idx);
  }
  _selKey(sel) { return sel ? (sel.t === 'star' ? 's' + sel.idx : sel.t === 'planet' ? 'p' + sel.name : 'b' + sel.idx) : ''; }
  _selPos(sel) {   // camera-relative position
    const cam = this.cam;
    if (sel.t === 'star') return F.relFromCam(cam, this._starPc(sel.idx));
    return sub3(sel.t === 'planet' ? this.planets.find((p) => p.name === sel.name).pos : this.bodies[sel.idx].pos, cam.pos);
  }
  _valid(sel) {
    if (!sel) return false;
    if (sel.t === 'star') return !!this.st.meta[sel.idx];
    if (!this._inSun()) return false;
    return sel.t === 'planet' ? this.planets.some((p) => p.name === sel.name) : !!this.bodies[sel.idx];
  }
  _hoverPick() {
    const c = this.cam, h = this.hover;
    const sig = `${h.x.toFixed(1)},${h.y.toFixed(1)}|${c.pos.join(',')}|${c.yaw}|${c.pitch}|${c.frame}|${this.cssW}x${this.cssH}`;
    if (sig !== this._pickSig) { this._pickSig = sig; this._pickSel = this._pickAt(h.x, h.y, PICK_PX); }
    return this._pickSel;
  }
  _fromYou(rel) {
    const u = F.unitsPerPc(this.cam), dpc = Math.hypot(...rel) / u;
    if (this.cam.frame === 'system' && dpc < 0.02) return `${fmtNum(dpc * AU_PER_PC)} AU`;
    return `${fmtNum(dpc)} pc · ${fmtNum(dpc * LY)} ly`;
  }
  /** In the evidence view the card lists no illustrative rows. */
  _evRows(rows) { return this.evidence ? rows.filter((r) => r[2] !== 'illustrative') : rows; }
  _renderCard(sel, pinned) {
    const onGo = pinned ? () => this._go(sel) : undefined, rel = this._selPos(sel);
    if (sel.t === 'star') {
      const m = this.st.meta[sel.idx], md = this._modelFor(sel.idx), s = this._system(sel.idx), dSun = m.kind === 'sun' ? 0 : Math.hypot(...this._starPc(sel.idx));
      const sub = m.kind === 'sun' ? 'The Sun' : m.kind === 'gaia' ? `${fmtNum(dSun)} pc · ${fmtNum(dSun * LY)} ly from the Sun` : 'Bright star (XHIP parallax)';
      renderStarCard(this.card, md, { title: this._starName(sel.idx), subtitle: sub, distFromCameraText: this.evidence ? null : this._fromYou(rel), onGo,
        loading: !!s && s.state === 'loading' && pinned, error: s && s.state === 'error' ? `Could not load system details: ${s.error}` : null });
    } else if (sel.t === 'planet') {
      const p = this.planets.find((q) => q.name === sel.name), dSun = Math.hypot(...p.pos);
      renderBodyCard(this.card, { title: p.name, onGo, rows: this._evRows([
        ['Radius', `${fmtNum(M.PLANET_KM[p.name] || 0)} km`, 'measured'],
        ['Distance from Sun', `${fmtNum(dSun)} AU`, 'measured'],
        ['From you', this._fromYou(rel), 'illustrative'],
        ['Colour and lighting', 'illustrative', 'illustrative'],
      ]) });
    } else {
      const b = this.bodies[sel.idx];
      renderBodyCard(this.card, { title: `${b.number != null ? b.number + ' ' : ''}${b.name || 'Small body'}`, onGo, rows: this._evRows([
        ['Distance from Sun', `${fmtNum(b.dh)} AU`, 'catalogue'], ['Distance from Earth', `${fmtNum(b.dg)} AU`, 'catalogue'],
        ['From you', this._fromYou(rel), 'illustrative'], ['Visual mag', Number.isFinite(b.vmag) ? b.vmag.toFixed(1) : 'n/a', 'catalogue'],
        ['Class', b.cls || 'n/a', 'catalogue'],
      ]) });
    }
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
    const p = this._proj(this._selPos(sel));
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
    for (const i of this.namedIdx) {
      const rel = F.relFromCam(cam, this._starPc(i)), p = this._proj(rel); if (!p) continue;
      if (hostP && Math.hypot(p[0] - hostP[0], p[1] - hostP[1]) < hostPx * 1.5) continue;
      const mag = M.apparentMag(st.gal[7 * i + 3], Math.hypot(...rel) / F.unitsPerPc(cam));
      if (mag > 6) continue;
      out.push({ x: p[0], y: p[1], key: mag, text: st.meta[i].name });
    }
    if (this._inSun()) {
      for (const pl of this.planets) {
        const p = this._proj(sub3(pl.pos, cam.pos)); if (!p || (this.dyn.get('p:' + pl.name) || 0) > 30) continue;   // no label on a visible disc
        out.push({ x: p[0], y: p[1], key: pl.kind === 'moon' ? 50 : 0, text: pl.name });   // Earth wins over the Moon beside it
      }
      const bodies = [];
      this.bodies.forEach((b) => {
        const p = this._proj(sub3(b.pos, cam.pos)); if (!p) return;
        bodies.push({ x: p[0], y: p[1], key: 100 + (Number.isFinite(b.vmag) ? b.vmag : 30), text: b.name || `(${b.number})` });
      });
      return out.concat(bodies.sort((a, b) => a.key - b.key).slice(0, MAX_BODY_LABELS));
    }
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
      lab.fillStyle = 'rgba(233, 230, 223, 0.9)';
      lab.beginPath(); lab.arc(L.x, L.y, 1.6, 0, Math.PI * 2); lab.fill();
      lab.fillStyle = 'rgba(233, 230, 223, 0.8)';
      lab.fillText(L.text, L.x + 8, L.y);
    }
    lab.shadowBlur = 0;
    if (this.sel && this._valid(this.sel)) {                      // ring around the selected object while it is still a speck
      const p = this._proj(this._selPos(this.sel)), px = this.dyn.get(this.sel.t === 'star' ? this.sel.idx : 'p:' + this.sel.name) || 0;
      if (p && px < 14) { lab.strokeStyle = 'rgba(242, 184, 75, 0.85)'; lab.lineWidth = 1.5; lab.beginPath(); lab.arc(p[0], p[1], 11, 0, Math.PI * 2); lab.stroke(); }
    }
    if (this.locked) {                                            // crosshair
      const cx = W / 2, cy = H / 2;
      lab.strokeStyle = 'rgba(233, 230, 223, 0.7)'; lab.lineWidth = 1;
      lab.beginPath(); lab.moveTo(cx - 8, cy); lab.lineTo(cx - 3, cy); lab.moveTo(cx + 3, cy); lab.lineTo(cx + 8, cy);
      lab.moveTo(cx, cy - 8); lab.lineTo(cx, cy - 3); lab.moveTo(cx, cy + 3); lab.lineTo(cx, cy + 8); lab.stroke();
    }
    this._updateCard(t);
    this._hud(t);
  }
  _hudData() {
    const cam = this.cam, inSys = cam.frame === 'system', near = this._nearest();
    return {
      scene: this.scene, frame: cam.frame, unit: inSys ? 'AU' : 'pc',
      hostName: inSys ? near.name : null,
      surfaceAu: inSys ? near.au : null,
      sunPc: F.worldPc(cam), speed: cam.speed, ev: Math.log2(this.expo),
      limit: this.limit, locked: this.locked, counts: { ...this.counts }, evidence: this.evidence,
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
