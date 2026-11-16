// Scene3D: WebGL2 renderer and fly controls for scene3d.html. Two scenes share one camera model
// (yaw and pitch, with world +z as celestial north):
//   stars  - Gaia DR3 stars at their parallax distances, plus the bright XHIP stars around them (units pc)
//   solar  - Sun, planets, Moon and small bodies at the chosen date (units AU)
// Stars are additive gl.POINTS. Their size and alpha come from the apparent magnitude seen from the camera.
import * as M from './scene3d-math.js';

const { D2R, LY_PER_PC: LY } = M;
const CFG = {
  stars: { unit: 'pc', speed: 2, min: 0.01, max: 10000, near: 1e-3, far: 1e8 },
  solar: { unit: 'AU', speed: 0.2, min: 0.001, max: 100, near: 1e-6, far: 1e5 },
};
const CONE_DIST = 3000;          // pc, the distance at which the cone-edge ring is drawn
const BASE_PX = 1.6;             // CSS px of a star at the magnitude limit
const PX_PER_MAG = 1.25;         // CSS px added per magnitude brighter than the limit
const LIMIT_DEFAULT = 12, LIMIT_MIN = 0, LIMIT_MAX = 25;
const MAX_LABELS = 40;
const MAX_BODY_LABELS = 12;     // small bodies crowd together inside the cone; name only the brightest
const PICK_PX = 10;
const Z_UP = [0, 0, 1];
// No Ctrl here: holding Ctrl while pressing W would close the tab.
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight']);
const PLANET_RGB = {
  Mercury: [0.75, 0.72, 0.68], Venus: [0.95, 0.85, 0.6], Earth: [0.35, 0.62, 1.0], Moon: [0.8, 0.8, 0.8],
  Mars: [1.0, 0.5, 0.35], Jupiter: [0.92, 0.8, 0.66], Saturn: [0.95, 0.87, 0.6], Uranus: [0.6, 0.9, 0.95], Neptune: [0.42, 0.6, 1.0],
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** Number for the readout: 3 significant figures, with thousands separators. */
export const fmtNum = (v, sig = 3) => (Number.isFinite(v) ? v.toLocaleString('en-US', { maximumSignificantDigits: sig }) : 'n/a');
const dist3 = (p, x, y, z) => Math.hypot(x - p[0], y - p[1], z - p[2]);

// ---------------------------------------------------------------- shaders (GLSL ES 3.00)
const STAR_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in float a_abs;
layout(location=2) in vec3 a_col;
uniform mat4 u_vp;
uniform vec3 u_eye;
uniform float u_limit, u_base, u_perMag, u_dpr, u_maxPt;
out vec3 v_col;
out float v_alpha;
void main(){
  float dist = max(length(a_pos - u_eye), 1e-6);
  float m = a_abs + 2.1714724*log(dist) - 5.0;          // apparent magnitude: 5 log10(d) - 5 + M
  float flux = exp(-0.9210340*(m - u_limit));           // 10^(-0.4 (m - limit)): 1 at the limit
  gl_Position = u_vp * vec4(a_pos, 1.0);
  // Size grows linearly with magnitude (log of flux), so a 0 mag star is a big glint, not a screen-filling disc.
  gl_PointSize = clamp(u_base + u_perMag*max(u_limit - m, 0.0), 1.5*u_dpr, min(40.0*u_dpr, u_maxPt));
  // Intensity keeps some dynamic range above the limit and fades below it, so stars fade in rather than pop.
  v_alpha = clamp(0.3*sqrt(flux), 0.0, 1.0);
  v_col = a_col;
}`;
const POINT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in vec2 a_style;                       // CSS px size, alpha
layout(location=2) in vec3 a_col;
uniform mat4 u_vp;
uniform float u_dpr;
out vec3 v_col;
out float v_alpha;
void main(){
  gl_Position = u_vp * vec4(a_pos, 1.0);
  gl_PointSize = a_style.x * u_dpr;
  v_alpha = a_style.y;
  v_col = a_col;
}`;
// Shared by stars and solar points: a gaussian core with a faint halo that reaches zero at the sprite edge.
const SPRITE_FS = `#version 300 es
precision highp float;
in vec3 v_col;
in float v_alpha;
out vec4 o;
void main(){
  vec2 p = gl_PointCoord*2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 >= 1.0) discard;
  float k = (exp(-4.0*r2) + 0.12*exp(-1.2*r2)) * (1.0 - r2*r2);
  o = vec4(v_col * (k * v_alpha), 1.0);
}`;
const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in vec4 a_col;
uniform mat4 u_vp;
out vec4 v_col;
void main(){ gl_Position = u_vp * vec4(a_pos, 1.0); v_col = a_col; }`;
const LINE_FS = `#version 300 es
precision highp float;
in vec4 v_col;
out vec4 o;
void main(){ o = vec4(v_col.rgb * v_col.a, 1.0); }`;

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
  constructor({ canvas, labels, card, ra, dec, radius = 3, onHud = () => {}, onScene = () => {}, onLost = () => {} }) {
    this.canvas = canvas; this.labelsEl = labels; this.lab = labels.getContext('2d'); this.card = card;
    this.target = { ra, dec, radius };
    this.fovStars = clamp(radius * 2.5, 20, 70);
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.hooks = { onHud, onScene, onLost };
    this._initGL();
    this.scene = 'stars'; this.limit = LIMIT_DEFAULT;
    this.cams = { stars: null, solar: null };
    this.cam = this.cams.stars = this._startCam('stars');
    this.cpu = {}; this.gpu = {};
    this.meta = { stars: [], solar: [] };
    this.ctx = []; this.gaia = null; this.solarData = null; this.namedIdx = [];
    this.counts = { gaia: 0, ctx: 0, planets: 0, bodies: 0 };
    this.keys = new Set(); this.touch = new Map(); this.pinch = null;
    this.hover = null; this.pinIdx = -1; this.locked = false;
    this.dpr = 1; this.cssW = 1; this.cssH = 1; this.vp = new Float32Array(16);
    this.lost = false; this.running = false; this._last = 0; this._hudT = 0; this._cardT = 0; this._raf = 0;
    this._pickSig = ''; this._pickIdx = -1;
    this._frame = this._frame.bind(this);
    const cone = linesToBuf(M.coneLines(ra, dec, radius, CONE_DIST), [1, 0.82, 0.55, 0.4]);
    this._put('lineStars', cone.data, cone.n);
    this._bind();
  }

  // ------------------------------------------------------------------ GL setup
  _initGL() {
    const gl = this.gl;
    const mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const prog = (vs, fs, names) => {
      const p = gl.createProgram();
      gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
      const u = {};
      for (const n of names) u[n] = gl.getUniformLocation(p, n);
      return { p, u };
    };
    this.prog = {
      star: prog(STAR_VS, SPRITE_FS, ['u_vp', 'u_eye', 'u_limit', 'u_base', 'u_perMag', 'u_dpr', 'u_maxPt']),
      point: prog(POINT_VS, SPRITE_FS, ['u_vp', 'u_dpr']),
      line: prog(LINE_VS, LINE_FS, ['u_vp']),
    };
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
    const pts = [], meta = [], orbits = [];
    const addPt = (p, size, alpha, rgb, m) => { pts.push(p[0], p[1], p[2], size, alpha, rgb[0], rgb[1], rgb[2]); meta.push(m); };
    addPt([0, 0, 0], 90, 0.22, [1, 0.66, 0.3], null);                                  // Sun glow
    addPt([0, 0, 0], 22, 1, [1, 0.93, 0.78], { kind: 'sun', name: 'Sun' });
    let earthListed = false, planets = 0;
    for (const p of s.planets || []) {
      const isEarth = p.name === 'Earth', isMoon = p.name === 'Moon';
      earthListed = earthListed || isEarth; planets++;
      addPt([p.x, p.y, p.z], isEarth ? 9 : isMoon ? 4 : 6.5, 1, PLANET_RGB[p.name] || [0.8, 0.8, 0.8],
        { kind: isMoon ? 'moon' : 'planet', name: p.name });
      if (!isMoon) orbits.push(M.orbitCircle(Math.hypot(p.x, p.y, p.z)));
    }
    if (!earthListed) { addPt(this.solarData.earth, 9, 1, PLANET_RGB.Earth, { kind: 'planet', name: 'Earth' }); orbits.push(M.orbitCircle(Math.hypot(...this.solarData.earth))); planets++; }
    const bodies = s.bodies || [];
    for (const b of bodies) {
      addPt([b.x, b.y, b.z], 3, 0.9, bodyRgb(b.class), { kind: 'body', name: b.name || null, number: b.number, cls: b.class, vmag: b.vmag, dh: b.dh_au, dg: b.dg_au });
    }
    this.meta.solar = meta;
    this._pickSig = '';
    this.counts.planets = planets; this.counts.bodies = bodies.length;
    const n = pts.length / 8;
    this._put('points', new Float32Array(pts), n);
    const lines = linesToBuf(orbits, [0.6, 0.7, 0.95, 0.18]);
    this._put('lineSolar', lines.data, lines.n);
    const { ra, dec, radius } = this.target, e = this.solarData.earth;
    const cone = M.coneLines(ra, dec, radius, 8).map((pl) => pl.map((q) => [q[0] + e[0], q[1] + e[1], q[2] + e[2]]));
    const cb = linesToBuf(cone, [1, 0.82, 0.55, 0.4]);
    this._put('coneSolar', cb.data, cb.n);
    if (this.scene === 'solar') this.cam = this.cams.solar = this._startCam('solar');
  }
  get hasSolar() { return !!this.solarData; }
  /** Vertical field of view: matches the patch in the star scene, wide in the solar one. */
  get fovDeg() { return this.scene === 'solar' ? 60 : this.fovStars; }

  _rebuildStars() {
    const g = this.gaia, { ra, dec, radius } = this.target;
    // Gaia misses the brightest stars (saturation) and the parallax cut drops others, so a context star inside the cone
    // is dropped only when a Gaia star of similar brightness sits within 2' of it (2' covers decades of proper motion).
    const ctx = g ? this.ctx.filter((c) => M.separationDeg(c.ra, c.dec, ra, dec) >= radius || !g.match(c)) : this.ctx;
    const rows = g ? g.rows : [];
    const n = rows.length + ctx.length;
    const data = new Float32Array(7 * n), meta = new Array(n), named = [];
    let k = 0;
    if (g) {
      const I = g.I;
      for (const r of rows) {
        const o = 7 * k, abs = r[I.abs_g];
        data[o] = r[I.x]; data[o + 1] = r[I.y]; data[o + 2] = r[I.z];
        data[o + 3] = Number.isFinite(abs) ? abs : 5;
        data.set(M.bpRpToRgb(r[I.bp_rp]), o + 4);
        meta[k] = { kind: 'gaia', id: String(r[I.id]), dlo: r[I.d_lo], dhi: r[I.d_hi], bp: r[I.bp_rp], abs: data[o + 3], name: null };
        k++;
      }
    }
    for (const c of ctx) {
      const o = 7 * k, p = M.radecToXyz(c.ra, c.dec, c.d);
      data.set(p, o); data[o + 3] = c.absMag; data.set(M.bpRpToRgb(c.bpRp), o + 4);
      meta[k] = { kind: 'ctx', hip: c.hip, name: c.name, d: c.d, vmag: c.vmag, bp: c.bpRp, abs: c.absMag };
      if (c.name) named.push(k);
      k++;
    }
    this.meta.stars = meta; this.namedIdx = named; this._pickSig = '';
    this.counts.gaia = rows.length; this.counts.ctx = ctx.length;
    this._put('stars', data, n);
  }

  // ------------------------------------------------------------------ scenes and camera
  _startCam(scene) {
    const { ra, dec } = this.target;
    const { yaw, pitch: p0 } = M.yawPitchFromDir(M.radecToXyz(ra, dec, 1));
    const pitch = clamp(p0, -1.5, 1.5);                         // same limit as mouse look: up = +z must not be parallel to the view
    if (scene === 'solar' && this.solarData) {
      // A three-quarter view from above the ecliptic that frames the Sun, Earth and the first few AU of the cone.
      const e = this.solarData.earth, d = M.radecToXyz(ra, dec, 1), eps = M.OBLIQUITY_DEG * D2R;
      const nep = [0, -Math.sin(eps), Math.cos(eps)];          // north ecliptic pole in ICRS
      const far = [0, 1, 2].map((k) => e[k] + 3 * d[k]);      // a point 3 AU down the cone
      const c = far.map((v) => v / 2);                          // midway between the Sun and that point
      const R = Math.hypot(...far) / 2 + 1;
      // Back off away from the cone side, then up: u is the in-plane direction from the Sun toward c.
      const cn = M.dot(c, nep), u = M.norm(c.map((v, k) => v - cn * nep[k]));
      const pos = [0, 1, 2].map((k) => c[k] + R * (1.3 * nep[k] - 1.2 * u[k]));
      const look = [0, 1, 2].map((k) => c[k] - pos[k]);
      const v = M.yawPitchFromDir(look);
      return { pos, vel: [0, 0, 0], yaw: v.yaw, pitch: clamp(v.pitch, -1.5, 1.5), speed: CFG[scene].speed };
    }
    return { pos: [0, 0, 0], vel: [0, 0, 0], yaw, pitch, speed: CFG[scene].speed };
  }
  setScene(name) {
    if (name === this.scene || (name === 'solar' && !this.solarData)) return;
    this.cams[this.scene] = this.cam;
    this.scene = name;
    this.cam = this.cams[name] || (this.cams[name] = this._startCam(name));
    this.pinIdx = -1; this.hover = null; this.card.hidden = true; this._cardT = 0;
    this.hooks.onScene(name);
  }
  toggleScene() { this.setScene(this.scene === 'stars' ? 'solar' : 'stars'); }
  resetView() { this.cam = this.cams[this.scene] = this._startCam(this.scene); this.pinIdx = -1; }

  // ------------------------------------------------------------------ controls
  _key(e, down) {
    const code = e.code;
    if (!down) { this.keys.delete(code); return; }
    if (e.metaKey) return;
    if (e.ctrlKey || e.altKey) return;                          // leave Ctrl+F, Ctrl+R and friends alone
    if (MOVE_KEYS.has(code)) { this.keys.add(code); e.preventDefault(); return; }
    if (code === 'Tab') { e.preventDefault(); if (!e.repeat) this.toggleScene(); return; }
    if (code === 'KeyH') { if (!e.repeat) this.resetView(); return; }
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
    if (this.locked) this.pinIdx = -1;
  }
  _pdown(e) {
    if (e.pointerType === 'touch') {
      const p = this._rel(e);
      this.touch.set(e.pointerId, { x: p.x, y: p.y, moved: 0 });
      this.pinch = null;
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      return;
    }
    if (e.button === 0 && !this.locked) this._lock();
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
    if (t && t.moved < 8 && this.touch.size === 0) this.pinIdx = this._pick(t.x, t.y);   // a tap pins a card; empty sky clears it
  }
  _look(dx, dy) {
    const cam = this.cam; if (!cam) return;
    const s = this.fovDeg * D2R * 0.008;                     // radians per pixel, scaled to the (per-scene) field of view
    cam.yaw -= dx * s;
    cam.pitch = clamp(cam.pitch - dy * s, -1.5, 1.5);
  }
  _dolly(amount) {
    const cam = this.cam, f = M.dirFromYawPitch(cam.yaw, cam.pitch);
    for (let i = 0; i < 3; i++) cam.pos[i] += f[i] * amount * cam.speed;
  }
  _wheel(e) {
    e.preventDefault();
    const cam = this.cam, cfg = CFG[this.scene];
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    cam.speed = clamp(cam.speed * Math.exp(-dy * 0.0015), cfg.min, cfg.max);   // logarithmic: equal steps, equal ratios
  }
  _step(dt) {
    const cam = this.cam; if (!cam || dt <= 0) return;
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
  }
  _matrices() {
    const cam = this.cam, cfg = CFG[this.scene];
    const dir = M.dirFromYawPitch(cam.yaw, cam.pitch);
    const aspect = this.canvas.width / this.canvas.height;
    this.vp = M.mul4(M.perspective(this.fovDeg * D2R, aspect, cfg.near, cfg.far), M.viewMatrix(cam.pos, dir, Z_UP));
  }
  _frame(t) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._frame);
    const dt = this._last ? Math.min(0.05, (t - this._last) / 1000) : 0;
    this._last = t;
    this._resize();
    this._step(dt);
    this._matrices();
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    if (this.scene === 'stars') { this._drawLines('lineStars'); this._drawStars(); }
    else { this._drawLines('lineSolar'); this._drawLines('coneSolar'); this._drawPoints(); }
    this._overlay(t);
  }
  _drawLines(key) {
    const g = this.gpu[key]; if (!g || !g.n) return;
    const gl = this.gl, pr = this.prog.line;
    gl.useProgram(pr.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.b);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE.lines, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE.lines, 12);
    gl.uniformMatrix4fv(pr.u.u_vp, false, this.vp);
    gl.drawArrays(gl.LINES, 0, g.n);
  }
  _drawStars() {
    const g = this.gpu.stars; if (!g || !g.n) return;
    const gl = this.gl, pr = this.prog.star, u = pr.u;
    gl.useProgram(pr.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.b);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE.stars, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, STRIDE.stars, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, STRIDE.stars, 16);
    gl.uniformMatrix4fv(u.u_vp, false, this.vp);
    gl.uniform3f(u.u_eye, this.cam.pos[0], this.cam.pos[1], this.cam.pos[2]);
    gl.uniform1f(u.u_limit, this.limit);
    gl.uniform1f(u.u_base, BASE_PX * this.dpr);
    gl.uniform1f(u.u_perMag, PX_PER_MAG * this.dpr);
    gl.uniform1f(u.u_dpr, this.dpr);
    gl.uniform1f(u.u_maxPt, this.maxPt);
    gl.drawArrays(gl.POINTS, 0, g.n);
  }
  _drawPoints() {
    const g = this.gpu.points; if (!g || !g.n) return;
    const gl = this.gl, pr = this.prog.point, u = pr.u;
    gl.useProgram(pr.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.b);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE.points, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE.points, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, STRIDE.points, 20);
    gl.uniformMatrix4fv(u.u_vp, false, this.vp);
    gl.uniform1f(u.u_dpr, this.dpr);
    gl.drawArrays(gl.POINTS, 0, g.n);
  }

  // ------------------------------------------------------------------ picking, labels, card
  /** Screen position in CSS px, or null when behind the camera or well off screen. */
  _proj(x, y, z) {
    const v = this.vp;
    const w = v[3] * x + v[7] * y + v[11] * z + v[15];
    if (w <= 1e-12) return null;
    const nx = (v[0] * x + v[4] * y + v[8] * z + v[12]) / w, ny = (v[1] * x + v[5] * y + v[9] * z + v[13]) / w;
    if (nx < -1.1 || nx > 1.1 || ny < -1.1 || ny > 1.1) return null;
    return [(nx * 0.5 + 0.5) * this.cssW, (0.5 - ny * 0.5) * this.cssH];
  }
  /** Index of the object under (px, py) in CSS px: the brightest star, or the nearest solar-system point. -1 for none. */
  _pick(px, py) {
    const R2 = PICK_PX * PICK_PX, v = this.vp;
    if (this.scene === 'stars') {
      const g = this.cpu.stars; if (!g) return -1;
      const d = g.data, cam = this.cam;
      let best = -1, bestM = Infinity;
      for (let i = 0; i < g.n; i++) {
        const o = 7 * i, x = d[o], y = d[o + 1], z = d[o + 2];
        const w = v[3] * x + v[7] * y + v[11] * z + v[15];
        if (w <= 1e-12) continue;
        const sx = ((v[0] * x + v[4] * y + v[8] * z + v[12]) / w * 0.5 + 0.5) * this.cssW - px;
        const sy = (0.5 - (v[1] * x + v[5] * y + v[9] * z + v[13]) / w * 0.5) * this.cssH - py;
        if (sx * sx + sy * sy > R2) continue;
        const m = M.apparentMag(d[o + 3], dist3(cam.pos, x, y, z));
        if (m < bestM) { bestM = m; best = i; }
      }
      return best;
    }
    const g = this.cpu.points; if (!g) return -1;
    const d = g.data;
    let best = -1, bestD = R2;
    for (let i = 0; i < g.n; i++) {
      if (!this.meta.solar[i]) continue;
      const p = this._proj(d[8 * i], d[8 * i + 1], d[8 * i + 2]); if (!p) continue;
      const dd = (p[0] - px) ** 2 + (p[1] - py) ** 2;
      if (dd <= bestD) { bestD = dd; best = i; }
    }
    return best;
  }
  /** Hover pick, recomputed only when the pointer or the camera has moved (the projection loop is the costly part). */
  _hoverPick() {
    const c = this.cam, h = this.hover;
    const sig = `${h.x.toFixed(1)},${h.y.toFixed(1)}|${c.pos.join(',')}|${c.yaw}|${c.pitch}|${this.scene}|${this.cssW}x${this.cssH}`;
    if (sig !== this._pickSig) { this._pickSig = sig; this._pickIdx = this._pick(h.x, h.y); }
    return this._pickIdx;
  }
  _posOf(idx) {
    if (this.scene === 'stars') { const d = this.cpu.stars.data, o = 7 * idx; return [d[o], d[o + 1], d[o + 2]]; }
    const d = this.cpu.points.data, o = 8 * idx; return [d[o], d[o + 1], d[o + 2]];
  }
  _info(idx) {
    const cam = this.cam, p = this._posOf(idx), dCam = dist3(cam.pos, ...p), dSun = Math.hypot(...p);
    if (this.scene === 'stars') {
      const m = this.meta.stars[idx], mCam = M.apparentMag(m.abs, dCam);
      const bp = m.bp == null || !Number.isFinite(m.bp) ? 'n/a' : m.bp.toFixed(2) + (m.kind === 'ctx' ? ' (from B−V)' : '');
      const rows = [];
      if (m.kind === 'gaia') {
        rows.push(['Distance from Sun', `${fmtNum(m.dlo)}–${fmtNum(m.dhi)} pc · ${fmtNum(m.dlo * LY)}–${fmtNum(m.dhi * LY)} ly`]);
      } else {
        rows.push(['Distance from Sun', `${fmtNum(m.d)} pc · ${fmtNum(m.d * LY)} ly`]);
        rows.push(['Source', 'XHIP parallax']);
      }
      rows.push(['From you', `${fmtNum(dCam)} pc · ${fmtNum(dCam * LY)} ly`]);
      rows.push(['Apparent mag here', mCam.toFixed(2)]);
      rows.push(['Absolute mag', m.abs.toFixed(2)]);
      rows.push(['BP−RP', bp]);
      const title = m.kind === 'gaia' ? (/^Gaia/i.test(m.id) ? m.id : `Gaia DR3 ${m.id}`) : m.name || `HIP ${m.hip}`;
      return { title, rows };
    }
    const m = this.meta.solar[idx];
    if (m.kind === 'body') {
      return {
        title: `${m.number != null ? m.number + ' ' : ''}${m.name || 'Small body'}`,
        rows: [['Distance from Sun', `${fmtNum(m.dh)} AU`], ['Distance from Earth', `${fmtNum(m.dg)} AU`],
          ['From you', `${fmtNum(dCam)} AU`], ['Visual mag', Number.isFinite(m.vmag) ? m.vmag.toFixed(1) : 'n/a'], ['Class', m.cls || 'n/a']],
      };
    }
    return { title: m.name, rows: [['Distance from Sun', `${fmtNum(dSun)} AU`], ['From you', `${fmtNum(dCam)} AU`]] };
  }
  _labelCandidates() {
    const out = [], cam = this.cam;
    if (this.scene === 'stars') {
      const d = this.cpu.stars ? this.cpu.stars.data : null;
      if (!d) return out;
      for (const i of this.namedIdx) {
        const o = 7 * i, p = this._proj(d[o], d[o + 1], d[o + 2]); if (!p) continue;
        const mag = M.apparentMag(d[o + 3], dist3(cam.pos, d[o], d[o + 1], d[o + 2]));
        if (mag > 6) continue;
        out.push({ x: p[0], y: p[1], key: mag, text: this.meta.stars[i].name });
      }
      return out;
    }
    const g = this.cpu.points; if (!g) return out;
    const d = g.data, bodies = [];
    for (let i = 0; i < g.n; i++) {
      const m = this.meta.solar[i]; if (!m) continue;
      const p = this._proj(d[8 * i], d[8 * i + 1], d[8 * i + 2]); if (!p) continue;
      if (m.kind === 'body') {
        const text = m.name || `(${m.number})`;
        bodies.push({ x: p[0], y: p[1], key: 100 + (Number.isFinite(m.vmag) ? m.vmag : 30), text });
      } else out.push({ x: p[0], y: p[1], key: m.kind === 'moon' ? 50 : 0, text: m.name });   // Earth wins over the Moon beside it
    }
    return out.concat(bodies.sort((a, b) => a.key - b.key).slice(0, MAX_BODY_LABELS));
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
    this._updateCard(t);
    this._hud(t);
  }
  _updateCard(t) {
    let idx = -1;
    if (!this.locked) {
      if (this.pinIdx >= 0) idx = this.pinIdx;
      else if (this.hover) idx = this._hoverPick();
    }
    const hide = () => { this.card.hidden = true; this._cardT = 0; };
    if (idx < 0) return hide();
    const stale = (this.scene === 'stars' ? !this.meta.stars[idx] : !this.meta.solar[idx]);
    if (stale) return hide();
    const p = this._proj(...this._posOf(idx));
    if (!p) return hide();
    if (t - this._cardT > 250 || this.card.hidden) {
      const info = this._info(idx);
      const title = document.createElement('p'); title.className = 'card-title'; title.textContent = info.title;
      const dl = document.createElement('dl'); dl.className = 'card-rows';
      for (const [k, v] of info.rows) {
        const dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = k; dd.textContent = v; dl.append(dt, dd);
      }
      this.card.replaceChildren(title, dl);
      this._cardT = t;
    }
    this.card.hidden = false;
    const cw = this.card.offsetWidth || 240, ch = this.card.offsetHeight || 120;
    let x = p[0] + 16, y = p[1] + 16;
    if (x + cw > this.cssW - 8) x = p[0] - cw - 16;
    if (y + ch > this.cssH - 8) y = p[1] - ch - 16;
    this.card.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }
  _hud(t) {
    if (t - this._hudT < 250) return;
    this._hudT = t;
    const cam = this.cam;
    this.hooks.onHud({
      scene: this.scene, unit: CFG[this.scene].unit, dist: Math.hypot(...cam.pos), speed: cam.speed,
      limit: this.limit, locked: this.locked, counts: { ...this.counts },
    });
  }
}
