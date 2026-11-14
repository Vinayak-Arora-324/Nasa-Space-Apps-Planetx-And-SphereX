// SkyRenderer: WebGL2 sky renderer (bicubic float images + vector-like source glows) with a
// Canvas2D fallback exposing the same API. See docs/blink-architecture.md.
//
// Pipeline (WebGL2): every frame is drawn into a canvas-sized RGBA16F "data" target
//   R = background/image value minus `base`, G = validity, B = additive glow sum (data units)
// and a final pass applies stretch + colour AFTER interpolation. All modes (video, blink, diff,
// trail) are just different weights / sources feeding that data target.

const GROUND = [5, 7, 11], MID = [23, 26, 32], WHITE = [233, 230, 223];
const SQRT_2LN2x2 = 2.3548200450309493; // FWHM = 2.3548 sigma

// ---------------------------------------------------------------- pure helpers (tested in node)
export function mitchell(x, B = 1 / 3, C = 1 / 3) {
  x = Math.abs(x);
  if (x < 1) return ((12 - 9 * B - 6 * C) * x * x * x + (-18 + 12 * B + 6 * C) * x * x + (6 - 2 * B)) / 6;
  if (x < 2) return ((-B - 6 * C) * x * x * x + (6 * B + 30 * C) * x * x + (-12 * B - 48 * C) * x + (8 * B + 24 * C)) / 6;
  return 0;
}
export const STRETCH_FN = {
  linear: (t) => t,
  asinh: (t) => Math.asinh(t * 10) / Math.asinh(10),
  log: (t) => Math.log10(1 + 999 * t) / 3,
};
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Data value -> display position s in [0,1] (sym: 0.5 = zero, >0.5 positive). */
export function mapValue(x, lo, hi, sym, stretch = 'linear') {
  const f = STRETCH_FN[stretch] || STRETCH_FN.linear;
  if (sym) { const m = hi || 1e-9; const u = f(clamp01(Math.abs(x) / m)); return 0.5 + 0.5 * Math.sign(x) * u; }
  return f(clamp01((x - lo) / ((hi - lo) || 1e-9)));
}
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Display position -> RGB (0..255). Non-sym: ground -> white. Sym: dark -> #171A20 -> white. */
export function colorOf(s, sym) {
  if (!sym) return mix3(GROUND, WHITE, s);
  return s < 0.5 ? mix3(GROUND, MID, s * 2) : mix3(MID, WHITE, (s - 0.5) * 2);
}
/** Symmetric limit for diff / leftover from caller lim. */
export function symLimit(lim) {
  if (lim && Number.isFinite(lim.sym)) return lim.sym;
  if (!lim) return 1;
  if (lim.lo < 0 && lim.hi > 0) return Math.max(-lim.lo, lim.hi);
  return Math.max(Math.abs(lim.hi - lim.lo) * 0.5, 1e-9);
}
// min: sigma floor (CSS px); k: extra sigma per decade of flux above floorLog; psf: weight of the real PSF width.
// halo: extra (unclamped) intensity per decade above saturation, so very bright stars grow wings.
// rangeMul: stars saturate at rangeMul x the raw white point. beta: Moffat wing steepness.
export const GLOW_DEFAULTS = { min: 1.0, k: 1.0, floorLog: -0.5, maxDecades: 4.5, cut: 8, psf: 1.0, halo: 0.9, rangeMul: 3, beta: 2.5 };
/** Peak display intensity (0..1, signed) of a source of peak amplitude `amp`; `range` is hi-lo (hi for sym). */
export function glowIntensity(amp, range, stretch = 'asinh', halo = 0) {
  const f = STRETCH_FN[stretch] || STRETCH_FN.linear, r = Math.abs(amp) / (range || 1e-9);
  return Math.sign(amp) * (f(clamp01(r)) + (r > 1 ? halo * Math.log10(r) : 0));
}
/** Core sigma in CSS px for a point source of the given integrated flux. */
export function glowSigmaCss(flux, p = GLOW_DEFAULTS) {
  const d = Math.min(p.maxDecades, Math.max(0, Math.log10(Math.max(flux, 1e-3)) - p.floorLog));
  return Math.hypot(p.min, p.k * d);
}
/** Full anisotropic sigma (CSS px) of a source at a given zoom. */
export function glowSigmas(src, pxPerData, p = GLOW_DEFAULTS) {
  const ext = src.kind === 'extended';
  const core = ext ? p.min : glowSigmaCss(src.flux, p);
  const e = ((ext ? (src.fwhm || 2) : (src.fwhm || 0) * p.psf) * pxPerData) / SQRT_2LN2x2;
  const sx = (src.sx || 0) * pxPerData, sy = (src.sy || 0) * pxPerData;
  return [Math.hypot(core, sx, e), Math.hypot(core, sy, e)];
}
export function viewToScreen(view, w, h, x, y) {
  return [w / 2 + (x - view.cx) * view.pxPerData, h / 2 + (y - view.cy) * view.pxPerData];
}
export function viewToData(view, w, h, sx, sy) {
  return [view.cx + (sx - w / 2) / view.pxPerData, view.cy + (sy - h / 2) / view.pxPerData];
}
export function fitView(npix, w, h, cover = true) {
  const a = w / npix, b = h / npix;
  return { cx: (npix - 1) / 2, cy: (npix - 1) / 2, pxPerData: cover ? Math.max(a, b) : Math.min(a, b) };
}
export function trailWeight(age) { return age <= 0 ? 1 : Math.max(0.3, 0.75 * Math.pow(0.94, age - 1)); }
const pair = (x, y) => { const r = [x, y]; r.x = x; r.y = y; return r; };

const glowKey = (g) => (g.vs != null ? `${g.id}~${g.vs}~${g.minSnr || 0}~${g.match || 0}` : String(g.id));

// ---------------------------------------------------------------- shaders
const STRETCH_GLSL = `
float asinh10(float t){ float x = 10.0*t; return log(x + sqrt(x*x + 1.0)) * ${(1 / Math.asinh(10)).toFixed(10)}; }
float stretchF(float t){
  if (u_str < 0.5) return t;
  if (u_str < 1.5) return asinh10(t);
  return log(1.0 + 999.0*t) * 0.14476482730108395; // 1/(3 ln10)
}`;

const FS_QUAD_VS = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`;

const NANF = `
bool isnanf(float v){ return (floatBitsToUint(v) & 0x7fffffffu) > 0x7f800000u; }`;

const BG_FS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D u_a, u_b;
uniform float u_wa, u_wb, u_n, u_base, u_diff, u_trail;
uniform sampler2D u_c, u_d; // trail: running max of past residuals, and this frame's residual
uniform vec3 u_view;      // cx, cy, pxPerData (device)
uniform vec2 u_dev;       // canvas device size
out vec4 o;
${NANF}
float mitch(float x){
  x = abs(x);
  if (x < 1.0) return (7.0*x*x*x - 12.0*x*x + 16.0/3.0)/6.0;
  if (x < 2.0) return (-7.0/3.0*x*x*x + 12.0*x*x - 20.0*x + 32.0/3.0)/6.0;
  return 0.0;
}
float bicubic(sampler2D s, vec2 p, out bool valid){
  vec2 i0 = floor(p), f = p - i0;
  float wx[4], wy[4];
  for (int k=0;k<4;k++){ wx[k] = mitch(float(k-1) - f.x); wy[k] = mitch(float(k-1) - f.y); }
  float sum = 0.0, wf = 0.0;
  for (int j=0;j<4;j++){
    int iy = int(i0.y) + j - 1;
    for (int i=0;i<4;i++){
      int ix = int(i0.x) + i - 1;
      if (ix < 0 || iy < 0 || ix >= int(u_n) || iy >= int(u_n)) continue;
      float v = texelFetch(s, ivec2(ix, iy), 0).r;
      if (isnanf(v)) continue;
      float w = wx[i]*wy[j]; sum += w*v; wf += w;
    }
  }
  valid = wf > 0.5 && p.x > -0.5 && p.y > -0.5 && p.x < u_n-0.5 && p.y < u_n-0.5;
  return valid ? sum/wf : 0.0;
}
// supersample when minifying so zoomed-out views do not alias
float sampleAA(sampler2D s, vec2 p, out bool valid){
  float pps = u_view.z;
  int N = pps < 0.5 ? 3 : (pps < 0.8 ? 2 : 1);
  if (N == 1) return bicubic(s, p, valid);
  float acc = 0.0, cnt = 0.0, tot = 0.0;
  for (int j=0;j<3;j++) for (int i=0;i<3;i++){
    if (i>=N || j>=N) continue;
    vec2 off = ((vec2(float(i),float(j)) + 0.5)/float(N) - 0.5)/pps;
    bool v; float x = bicubic(s, p+off, v); tot += 1.0;
    if (v){ acc += x; cnt += 1.0; }
  }
  valid = cnt*2.0 > tot; return valid ? acc/cnt : 0.0;
}
void main(){
  vec2 p = vec2(u_view.x + (gl_FragCoord.x - 0.5*u_dev.x)/u_view.z,
                u_view.y + (0.5*u_dev.y - gl_FragCoord.y)/u_view.z);
  bool va = false, vb = false; float a = 0.0, b = 0.0;
  if (u_wa != 0.0) a = sampleAA(u_a, p, va);
  if (u_wb != 0.0) b = sampleAA(u_b, p, vb);
  float r = 0.0, g = 0.0;
  if (u_diff > 0.5){ if (va && vb){ r = u_wa*a + u_wb*b; g = 1.0; } }
  else {
    float ws = (va?u_wa:0.0) + (vb?u_wb:0.0);
    if (ws > 1e-4){ r = ((va?u_wa*a:0.0) + (vb?u_wb*b:0.0))/ws - u_base; g = 1.0; }
  }
  float tb = 0.0;
  if (u_trail > 0.5){ bool vc, vd; float c = sampleAA(u_c, p, vc), dd = sampleAA(u_d, p, vd); tb = max((vc ? c : 0.0) - (vd ? dd : 0.0), 0.0); }
  o = vec4(r, g, 0.0, tb);
}`;

const GLOW_VS = `#version 300 es
precision highp float;
layout(location=0) in vec4 i_a;  // x, y, amp, flux
layout(location=1) in vec4 i_b;  // sx, sy, fwhm, ext
uniform vec3 u_view; uniform vec2 u_dev; uniform float u_dpr, u_w;
uniform vec4 u_gp; // min, k, floorLog, maxDecades
uniform vec4 u_gd; // display range (hi-lo, or hi when symmetric), halo gain, psf weight, cut
uniform float u_str;
out vec2 v_off; out vec2 v_sig; out float v_amp;
${STRETCH_GLSL}
void main(){
  float pps = u_view.z / u_dpr;           // CSS px per data px
  float d = clamp(log(max(i_a.w, 1e-3))*0.4342944819 - u_gp.z, 0.0, u_gp.w);
  bool ext = i_b.w > 0.5;
  float core = ext ? u_gp.x : length(vec2(u_gp.x, u_gp.y*d));
  float e = i_b.z*pps/2.35482*(ext ? 1.0 : u_gd.z);
  vec2 u = i_b.xy*pps;
  vec2 sg = sqrt(vec2(core*core + e*e) + u*u);
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1))*2.0 - 1.0;
  vec2 off = corner * sg * u_gd.w;                   // CSS px
  vec2 ctr = vec2(0.5*u_dev.x + (i_a.x - u_view.x)*u_view.z, 0.5*u_dev.y + (i_a.y - u_view.y)*u_view.z);
  vec2 dev = ctr + off*u_dpr;
  gl_Position = vec4(dev.x/u_dev.x*2.0 - 1.0, 1.0 - dev.y/u_dev.y*2.0, 0.0, 1.0);
  float r = abs(i_a.z)/u_gd.x;
  float I = sign(i_a.z) * (stretchF(clamp(r, 0.0, 1.0)) + u_gd.y*log(max(r, 1.0))*0.4342944819);
  v_off = off; v_sig = sg; v_amp = I * u_w;
}`;
const GLOW_FS = `#version 300 es
precision highp float;
in vec2 v_off; in vec2 v_sig; in float v_amp;
uniform float u_cut, u_beta;
out vec4 o;
void main(){
  vec2 q = v_off / v_sig; float r2 = dot(q,q);
  float edge = pow(1.0 + u_cut*u_cut/(2.0*u_beta), -u_beta);
  float g = max(pow(1.0 + r2/(2.0*u_beta), -u_beta) - edge, 0.0) / (1.0 - edge);
  o = vec4(0.0, 0.0, v_amp*g, 0.0);
}`;

const ACC_FS = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D u_acc, u_frame; uniform float u_first;
out vec4 o;
${NANF}
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  float b = texelFetch(u_frame, c, 0).r;

  float a = u_first > 0.5 ? b : texelFetch(u_acc, c, 0).r;
  float r = isnanf(a) ? b : (isnanf(b) ? a : max(a, b));
  o = vec4(r, 0.0, 0.0, 1.0);
}`;

const FINAL_FS = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D u_data;
uniform float u_lo, u_hi, u_base, u_sym, u_str;
uniform vec3 u_tint;
out vec4 o;
const vec3 GROUND = vec3(${GROUND.map((v) => (v / 255).toFixed(6)).join(',')});
const vec3 MID = vec3(${MID.map((v) => (v / 255).toFixed(6)).join(',')});
const vec3 WHITE = vec3(${WHITE.map((v) => (v / 255).toFixed(6)).join(',')});
${STRETCH_GLSL}
float map(float x){
  if (u_sym > 0.5){ float u = stretchF(clamp(abs(x)/u_hi, 0.0, 1.0)); return 0.5 + 0.5*sign(x)*u; }
  return stretchF(clamp((x - u_lo)/(u_hi - u_lo), 0.0, 1.0));
}
vec3 cmap(float s){
  if (u_sym < 0.5) return mix(GROUND, WHITE, s);
  return s < 0.5 ? mix(GROUND, MID, s*2.0) : mix(MID, WHITE, (s-0.5)*2.0);
}
void main(){
  vec4 d = texelFetch(u_data, ivec2(gl_FragCoord.xy), 0);
  bool valid = d.g > 0.5;
  float xb = valid ? d.r + u_base : (u_sym > 0.5 ? 0.0 : u_lo);
  float sB = map(xb);
  vec3 col = valid ? cmap(sB) : GROUND;
  // B: source glows, already in display units. A: trail residual stack, in data units.
  col += (WHITE - GROUND) * u_tint * d.b * (u_sym > 0.5 ? 0.5 : 1.0);
  if (d.a > 0.0) col += (WHITE - GROUND) * u_tint * (map(xb + d.a) - sB);
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233)))*43758.5453) - 0.5;
  o = vec4(clamp(col + n/255.0, 0.0, 1.0), 1.0);
}`;

// ---------------------------------------------------------------- GL backend
class GLBackend {
  constructor(canvas, owner) {
    this.owner = owner; this.canvas = canvas;
    const gl = this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('no webgl2');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('no EXT_color_buffer_float');
    this.name = 'webgl2';
    this.progBg = this.prog(FS_QUAD_VS, BG_FS);
    this.progGlow = this.prog(GLOW_VS, GLOW_FS);
    this.progAcc = this.prog(FS_QUAD_VS, ACC_FS);
    this.progFinal = this.prog(FS_QUAD_VS, FINAL_FS);
    this.emptyVao = gl.createVertexArray();
    this.tex = new Map();   // key -> {t, used}
    this.glow = new Map();  // id -> {vao, buf, count, used}
    this.acc = new Map();   // plane -> {tex:[2], fbo:[2], cur, ids, has, n}
    this.data = null; this.dw = 0; this.dh = 0;
    this.stamp = 0;
    this.u = new Map();
  }
  prog(vs, fs) {
    const gl = this.gl, mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    p._u = {};
    return p;
  }
  U(p, name) {
    if (!(name in p._u)) p._u[name] = this.gl.getUniformLocation(p, name);
    return p._u[name];
  }
  resize(w, h) { // device px
    const gl = this.gl;
    if (this.data && this.dw === w && this.dh === h) return;
    if (this.data) { gl.deleteTexture(this.data.t); gl.deleteFramebuffer(this.data.f); }
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    this.data = { t, f }; this.dw = w; this.dh = h;
  }
  floatTex(n, arr) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, n, n);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (arr) { gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, n, gl.RED, gl.FLOAT, arr); }
    return t;
  }
  getTex(id, plane, protect) {
    const key = id + '\u0000' + plane, hit = this.tex.get(key);
    if (hit) { hit.used = ++this.stamp; return hit.t; }
    const fr = this.owner.frames.get(id), arr = fr && (fr[plane] || this.owner.derived(id, plane));
    const n = this.owner.npix;
    if (!arr || arr.length < n * n) return null;
    const cap = this.owner.cacheFrames * 3;
    while (this.tex.size >= cap) {
      let vk = null, vu = Infinity;
      for (const [k, v] of this.tex) if (v.used < vu && !(protect && protect.has(k))) { vk = k; vu = v.used; }
      if (vk === null) break;
      this.gl.deleteTexture(this.tex.get(vk).t); this.tex.delete(vk);
    }
    const t = this.floatTex(n, arr);
    this.tex.set(key, { t, used: ++this.stamp });
    return t;
  }
  getGlow(spec, protectIds) {
    const id = glowKey(spec);
    let g = this.glow.get(id);
    const fr = this.owner.frames.get(spec.id);
    if (!fr) return null;
    if (g) { g.used = ++this.stamp; return g; }
    const inst = this.owner.instances(spec.id, spec.vs, spec.minSnr, spec.match);
    if (!inst || !inst.count) return null;
    const gl = this.gl;
    const cap = this.owner.cacheFrames;
    while (this.glow.size >= cap) {
      let vk = null, vu = Infinity;
      for (const [k, v] of this.glow) if (v.used < vu && !(protectIds && protectIds.has(k))) { vk = k; vu = v.used; }
      if (vk === null) break;
      this.freeGlow(vk);
    }
    const buf = gl.createBuffer(), vao = gl.createVertexArray();
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, inst.data, gl.STATIC_DRAW);
    for (let k = 0; k < 2; k++) { gl.enableVertexAttribArray(k); gl.vertexAttribPointer(k, 4, gl.FLOAT, false, 32, k * 16); gl.vertexAttribDivisor(k, 1); }
    gl.bindVertexArray(null);
    g = { vao, buf, count: inst.count, used: ++this.stamp };
    this.glow.set(id, g);
    return g;
  }
  freeGlow(id) {
    const g = this.glow.get(id); if (!g) return;
    this.gl.deleteBuffer(g.buf); this.gl.deleteVertexArray(g.vao); this.glow.delete(id);
  }
  dropFrame(id) {
    const gl = this.gl;
    for (const key of [...this.tex.keys()]) if (key.startsWith(id + '\u0000')) { gl.deleteTexture(this.tex.get(key).t); this.tex.delete(key); }
    for (const k of [...this.glow.keys()]) if (k === id || k.startsWith(id + '~') || k.endsWith('~' + id) || k.includes('~' + id + '~')) this.freeGlow(k);
    this.invalidateTrail(id);
  }
  invalidateTrail(id) {
    for (const c of this.acc.values()) if (id == null || c.ids.includes(id)) { c.ids = []; c.has = false; }
  }
  resetGrid() {
    const gl = this.gl;
    for (const v of this.tex.values()) gl.deleteTexture(v.t);
    this.tex.clear();
    for (const id of [...this.glow.keys()]) this.freeGlow(id);
    for (const c of this.acc.values()) { c.tex.forEach((t) => gl.deleteTexture(t)); c.fbo.forEach((f) => gl.deleteFramebuffer(f)); }
    this.acc.clear();
  }
  accFor(plane) {
    const n = this.owner.npix;
    let c = this.acc.get(plane);
    if (c) return c;
    const gl = this.gl;
    c = { tex: [], fbo: [], cur: 0, ids: [], has: false, n };
    for (let k = 0; k < 2; k++) {
      const t = this.floatTex(n, null), f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      c.tex.push(t); c.fbo.push(f);
    }
    this.acc.set(plane, c);
    return c;
  }
  /** Running max of `plane` over ids, incremental when ids extends the cached list. */
  accumulate(plane, ids, protect) {
    const gl = this.gl, c = this.accFor(plane), n = this.owner.npix;
    let start = c.ids.length;
    if (!(ids.length >= start && c.ids.every((v, i) => v === ids[i]))) { c.ids = []; c.has = false; start = 0; }
    if (start < ids.length) {
      gl.useProgram(this.progAcc); gl.bindVertexArray(this.emptyVao);
      gl.disable(gl.BLEND); gl.viewport(0, 0, n, n); gl.colorMask(true, true, true, true);
      for (let i = start; i < ids.length; i++) {
        const ft = this.getTex(ids[i], plane, protect);
        c.ids.push(ids[i]);
        if (!ft) continue;
        const dst = 1 - c.cur;
        gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo[dst]);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, c.tex[c.cur]);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, ft);
        gl.uniform1i(this.U(this.progAcc, 'u_acc'), 0); gl.uniform1i(this.U(this.progAcc, 'u_frame'), 1);
        gl.uniform1f(this.U(this.progAcc, 'u_first'), c.has ? 0 : 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        c.cur = dst; c.has = true;
      }
    }
    return c.has ? c.tex[c.cur] : null;
  }
  render(plan) {
    const gl = this.gl, { w, h, dpr } = plan.css, W = this.canvas.width, H = this.canvas.height;
    this.resize(W, H);
    const protect = new Set();
    for (const id of [plan.bg.a, plan.bg.b]) if (id != null) protect.add(id + '\u0000' + plan.plane);
    const protectIds = new Set(plan.glows.map(glowKey));
    const view = plan.view, ppsDev = view.pxPerData * (W / w);
    // 1. background
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.data.f);
    gl.viewport(0, 0, W, H); gl.disable(gl.BLEND); gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    let tA = null, tB = null, wa = plan.bg.wa, wb = plan.bg.wb;
    const bg = plan.bg;
    let tC = null, tD = null;
    tA = bg.a != null ? this.getTex(bg.a, plan.plane, protect) : null;
    if (bg.type === 'trail') {
      protect.add(bg.a + '\u0000' + bg.resid);
      tC = this.accumulate(bg.resid, bg.trail, protect); tD = this.getTex(bg.a, bg.resid, protect);
      wa = 1; wb = 0;
    } else tB = bg.b != null ? this.getTex(bg.b, plan.plane, protect) : null;
    if (!tA && tB) { tA = tB; wa = wb; wb = 0; if (bg.type === 'diff') { tA = null; } }
    if (tA) {
      const p = this.progBg;
      gl.useProgram(p); gl.bindVertexArray(this.emptyVao);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tA);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tB || tA);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, tC || tA);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, tD || tA);
      gl.uniform1i(this.U(p, 'u_a'), 0); gl.uniform1i(this.U(p, 'u_b'), 1);
      gl.uniform1i(this.U(p, 'u_c'), 2); gl.uniform1i(this.U(p, 'u_d'), 3);
      gl.uniform1f(this.U(p, 'u_trail'), tC && tD ? 1 : 0);
      if (bg.type === 'diff' && !tB) wb = 0;
      gl.uniform1f(this.U(p, 'u_wa'), wa); gl.uniform1f(this.U(p, 'u_wb'), tB ? wb : 0);
      gl.uniform1f(this.U(p, 'u_n'), this.owner.npix);
      gl.uniform1f(this.U(p, 'u_base'), plan.base);
      gl.uniform1f(this.U(p, 'u_diff'), bg.type === 'diff' ? 1 : 0);
      gl.uniform3f(this.U(p, 'u_view'), view.cx, view.cy, ppsDev);
      gl.uniform2f(this.U(p, 'u_dev'), W, H);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    // 2. glows (B channel only)
    if (plan.glows.length) {
      const p = this.progGlow, gp = this.owner.glowParams;
      gl.useProgram(p);
      gl.colorMask(false, false, true, false);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.blendEquation(plan.glowMax ? gl.MAX : gl.FUNC_ADD);
      gl.uniform3f(this.U(p, 'u_view'), view.cx, view.cy, ppsDev);
      gl.uniform2f(this.U(p, 'u_dev'), W, H);
      gl.uniform1f(this.U(p, 'u_dpr'), W / w);
      gl.uniform4f(this.U(p, 'u_gp'), gp.min, gp.k, gp.floorLog, gp.maxDecades);
      gl.uniform1f(this.U(p, 'u_cut'), gp.cut);
      gl.uniform4f(this.U(p, 'u_gd'), plan.glowRange, gp.halo, gp.psf, gp.cut);
      gl.uniform1f(this.U(p, 'u_beta'), gp.beta);
      gl.uniform1f(this.U(p, 'u_str'), { linear: 0, asinh: 1, log: 2 }[plan.stretch] ?? 0);
      for (const g of plan.glows) {
        const buf = this.getGlow(g, protectIds);
        if (!buf) continue;
        gl.uniform1f(this.U(p, 'u_w'), g.w);
        gl.bindVertexArray(buf.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, buf.count);
      }
      gl.bindVertexArray(null);
      gl.blendEquation(gl.FUNC_ADD); gl.disable(gl.BLEND); gl.colorMask(true, true, true, true);
    }
    // 3. final colour pass
    const p = this.progFinal;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    gl.useProgram(p); gl.bindVertexArray(this.emptyVao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.data.t);
    gl.uniform1i(this.U(p, 'u_data'), 0);
    gl.uniform1f(this.U(p, 'u_lo'), plan.lim.lo); gl.uniform1f(this.U(p, 'u_hi'), plan.lim.hi);
    gl.uniform1f(this.U(p, 'u_base'), plan.base); gl.uniform1f(this.U(p, 'u_sym'), plan.sym ? 1 : 0);
    gl.uniform1f(this.U(p, 'u_str'), { linear: 0, asinh: 1, log: 2 }[plan.stretch] ?? 0);
    gl.uniform3f(this.U(p, 'u_tint'), ...plan.tint);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

// ---------------------------------------------------------------- Canvas2D backend
class C2DBackend {
  constructor(canvas, owner) {
    this.owner = owner; this.canvas = canvas; this.name = 'canvas2d';
    this.ctx = canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('no 2d context');
    this.off = document.createElement('canvas');
    this.cache = { key: '', img: null }; this.trail = { plane: '', ids: [], acc: null };
  }
  resize() {}
  dropFrame(id) { this.invalidateTrail(id); this.cache.key = ''; }
  invalidateTrail(id) { if (id == null || this.trail.ids.includes(id)) { this.trail.ids = []; this.trail.acc = null; } }
  resetGrid() { this.trail.ids = []; this.trail.acc = null; this.cache.key = ''; }
  combine(plan) {
    const n = this.owner.npix, N = n * n, own = this.owner, bg = plan.bg;
    const get = (id) => { const f = own.frames.get(id); const a = f && f[plan.plane]; return a && a.length >= N ? a : null; };
    if (bg.type === 'trail') {
      const t = this.trail, rp = bg.resid, dget = (id) => own.derived(id, rp);
      if (t.plane !== rp || !(bg.trail.length >= t.ids.length && t.ids.every((v, i) => v === bg.trail[i]))) { t.plane = rp; t.ids = []; t.acc = null; }
      for (let i = t.ids.length; i < bg.trail.length; i++) {
        t.ids.push(bg.trail[i]); const a = dget(bg.trail[i]); if (!a) continue;
        if (!t.acc) t.acc = Float32Array.from(a);
        else { const o = t.acc; for (let k = 0; k < N; k++) { const v = a[k]; if (v > o[k]) o[k] = v; } }
      }
      const cur = get(bg.a), cr = dget(bg.a);
      if (!cur) return null;
      if (!t.acc || !cr) return cur;
      const out = Float32Array.from(cur);
      for (let k = 0; k < N; k++) { const d = t.acc[k] - cr[k]; if (d > 0 && out[k] === out[k]) out[k] += d; }
      return out;
    }
    const A = bg.a != null ? get(bg.a) : null, B = bg.b != null ? get(bg.b) : null;
    if (!A && !B) return null;
    if (bg.type === 'single' || !B || !A) return A || (bg.type === 'diff' ? null : B);
    const out = new Float32Array(N), wa = bg.wa, wb = bg.wb;
    if (bg.type === 'diff') { for (let k = 0; k < N; k++) out[k] = wa * A[k] + wb * B[k]; return out; }
    for (let k = 0; k < N; k++) { const a = A[k], b = B[k]; out[k] = a !== a ? (b !== b ? NaN : b) : (b !== b ? a : wa * a + wb * b); }
    return out;
  }
  colourise(vals, plan) {
    const n = this.owner.npix, off = this.off;
    if (off.width !== n || off.height !== n) { off.width = n; off.height = n; }
    const c = off.getContext('2d'), id = c.createImageData(n, n), d = id.data, { lo, hi } = plan.lim;
    for (let k = 0; k < n * n; k++) {
      const v = vals ? vals[k] : NaN, o = k * 4;
      let rgb = GROUND;
      if (v === v) rgb = colorOf(mapValue(v, lo, hi, plan.sym, plan.stretch), plan.sym);
      d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
    }
    c.putImageData(id, 0, 0);
  }
  render(plan) {
    const ctx = this.ctx, { w, h, dpr } = plan.css, view = plan.view, n = this.owner.npix;
    ctx.setTransform(this.canvas.width / w, 0, 0, this.canvas.height / h, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgb(${GROUND})`; ctx.fillRect(0, 0, w, h);
    const vals = this.combine(plan);
    if (vals) {
      this.colourise(vals, plan);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      const [x0, y0] = viewToScreen(view, w, h, -0.5, -0.5), s = view.pxPerData * n;
      ctx.drawImage(this.off, x0, y0, s, s);
    }
    const range = plan.glowRange, gp = this.owner.glowParams;
    const tint = plan.tint, tc = (u) => [0, 1, 2].map((k) => Math.round((GROUND[k] + (WHITE[k] - GROUND[k]) * tint[k] * u)));
    const order = plan.glows.slice();
    for (const g of order) {
      const inst = this.owner.frames.get(g.id); if (!inst) continue;
      for (const s of this.owner.filtered(g.id, g.vs, g.minSnr, g.match)) {
        if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
        const amp = this.owner.ampOf(s, inst.psfFwhmPx) * g.w;
        const u = Math.min(1, Math.abs(glowIntensity(amp, range, plan.stretch, gp.halo)));
        if (u < 0.004) continue;
        const [sx, sy] = viewToScreen(view, w, h, s.x, s.y), [gx, gy] = glowSigmas({ ...s, fwhm: s.fwhm || inst.psfFwhmPx }, view.pxPerData, gp);
        const R = gp.cut * Math.max(gx, gy);
        if (sx < -R || sy < -R || sx > w + R || sy > h + R) continue;
        const neg = amp < 0, col = neg ? GROUND : tc(1);
        ctx.save(); ctx.translate(sx, sy); ctx.scale(gx / Math.max(gx, gy), gy / Math.max(gx, gy));
        const M = gp.cut * Math.max(gx, gy);
        const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, M);
        for (let q = 0; q <= 8; q++) { const f = q / 8, r = f * gp.cut; gr.addColorStop(f, `rgba(${col[0]},${col[1]},${col[2]},${(u * Math.exp(-0.5 * r * r)).toFixed(4)})`); }
        ctx.globalCompositeOperation = neg ? 'source-over' : 'lighter';
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, M, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

// ---------------------------------------------------------------- SkyRenderer
export class SkyRenderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas; this.npix = 0;
    this.frames = new Map(); this.view = { cx: 0, cy: 0, pxPerData: 1 };
    this.cacheFrames = opts.cacheFrames || 64;
    this.glowParams = { ...GLOW_DEFAULTS, ...(opts.glow || {}) };
    this._inst = new Map();
    this.cssW = 1; this.cssH = 1; this.dpr = 1;
    this.backend = null;
    if (!opts.fallback && SkyRenderer.webglSupported()) {
      try { this.backend = new GLBackend(canvas, this); } catch (e) { console.warn('skygl: WebGL2 failed, using Canvas2D', e); this.backend = null; }
    }
    if (!this.backend) this.backend = new C2DBackend(canvas, this);
    this.resize();
  }
  static webglSupported() {
    try {
      const c = document.createElement('canvas'), gl = c.getContext('webgl2');
      return !!(gl && gl.getExtension('EXT_color_buffer_float'));
    } catch { return false; }
  }
  get backendName() { return this.backend.name; }
  resize() {
    const c = this.canvas, dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const w = c.clientWidth || c.width || 1, h = c.clientHeight || c.height || 1;
    this.cssW = w; this.cssH = h; this.dpr = dpr;
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
  }
  setGrid(npix) {
    if (npix === this.npix) return;
    this.npix = npix; this._inst.clear();
    this.backend.resetGrid();
  }
  setFrame(id, d) {
    if (this.frames.has(id)) this.backend.dropFrame(id);
    this._dropInst(id);
    this.frames.set(id, {
      img: d.img || null, background: d.background || null, leftover: d.leftover || null,
      sources: d.sources || [], psfFwhmPx: d.psfFwhmPx || 1.9, noise: d.noise || 0,
    });
    if (!this.npix) {
      const a = d.img || d.background || d.leftover;
      if (a) this.setGrid(Math.round(Math.sqrt(a.length)));
    }
  }
  dropFrame(id) { this.backend.dropFrame(id); this.frames.delete(id); this._dropInst(id); }
  _dropInst(id) { for (const k of [...this._inst.keys()]) if (k === id || String(k).startsWith(id + '~') || String(k).includes('~' + id + '~')) this._inst.delete(k); }
  /** Lazily derived planes: positive residual above 2 sigma (raw: image - background, leftover: leftover). */
  derived(id, plane) {
    const f = this.frames.get(id); if (!f) return null;
    if (f[plane]) return f[plane];
    const src = plane === 'residRaw' ? f.img : plane === 'residLeft' ? f.leftover : null;
    if (!src) return null;
    const sub = plane === 'residRaw' ? f.background : null, thr = 2.5 * (f.noise || 0), n = this.npix, out = new Float32Array(src.length);
    // 3x3 median first: a real source spreads over several pixels, a single hot pixel (cosmic ray) does not
    const r = new Float32Array(src.length), w = new Float32Array(9);
    for (let k = 0; k < src.length; k++) { const v = src[k] - (sub ? sub[k] : 0); r[k] = v === v ? v : 0; }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= n) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= n) continue; const v = r[yy * n + xx]; let j = c++; while (j > 0 && w[j - 1] > v) { w[j] = w[j - 1]; j--; } w[j] = v; } }
      const v = w[c >> 1] - thr;
      out[y * n + x] = v > 0 ? v : 0;
    }
    f[plane] = out; return out;
  }
  hasFrame(id) { return this.frames.has(id); }
  setView(v) { Object.assign(this.view, v); }
  getView() { return { ...this.view }; }
  fit(cover = true) { Object.assign(this.view, fitView(this.npix || 1, this.cssW, this.cssH, cover)); }
  toScreen(x, y) { const r = viewToScreen(this.view, this.cssW, this.cssH, x, y); return pair(r[0], r[1]); }
  toData(sx, sy) { const r = viewToData(this.view, this.cssW, this.cssH, sx, sy); return pair(r[0], r[1]); }
  ampOf(s, psf = 1.9) {
    if (Number.isFinite(s.amp)) return s.amp;
    const sg = psf / SQRT_2LN2x2; return (s.flux || 0) / (2 * Math.PI * sg * sg);
  }
  /** Packed per-source instance data (8 floats each) for a frame. */
  /**
   * Sources of frame `id`; with `vs`, only those with no counterpart in frame `vs` (within `match` px)
   * and at least `minSnr`: i.e. what changed between the frames. Fixed stars (and their per-frame
   * detection jitter) drop out, movers stay.
   */
  filtered(id, vs, minSnr = 0, match = 1.6) {
    match = match || 1.6;
    const f = this.frames.get(id); if (!f) return [];
    const all = (f.sources || []).filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y));
    if (vs == null) return all;
    const o = this.frames.get(vs);
    if (!o) return all.filter((s) => (s.snr || 0) >= minSnr);
    const cell = Math.max(2, match), grid = new Map(), key = (i, j) => i * 100003 + j;
    for (const q of o.sources || []) { if (!Number.isFinite(q.x)) continue; const k = key(Math.floor(q.x / cell), Math.floor(q.y / cell)); (grid.get(k) || grid.set(k, []).get(k)).push(q); }
    return all.filter((s) => {
      if ((s.snr || 0) < minSnr) return false;
      const ci = Math.floor(s.x / cell), cj = Math.floor(s.y / cell);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const l = grid.get(key(ci + di, cj + dj)); if (!l) continue;
        for (const q of l) if (Math.hypot(q.x - s.x, q.y - s.y) <= match) return false;
      }
      return true;
    });
  }
  instances(id, vs, minSnr, match) {
    const ck = vs == null ? id : `${id}~${vs}~${minSnr || 0}~${match || 0}`;
    let r = this._inst.get(ck); if (r) return r;
    const f = this.frames.get(id); if (!f) return null;
    const src = this.filtered(id, vs, minSnr, match);
    const data = new Float32Array(src.length * 8);
    src.forEach((s, i) => {
      const o = i * 8, fl = Math.max(Number.isFinite(s.flux) ? s.flux : 0, 1e-3);
      data[o] = s.x; data[o + 1] = s.y; data[o + 2] = this.ampOf(s, f.psfFwhmPx); data[o + 3] = fl;
      data[o + 4] = s.sx || 0; data[o + 5] = s.sy || 0; data[o + 6] = s.fwhm || f.psfFwhmPx; data[o + 7] = s.kind === 'extended' ? 1 : 0;
    });
    if (this._inst.size > 160) this._inst.delete(this._inst.keys().next().value);
    r = { data, count: src.length }; this._inst.set(ck, r); return r;
  }
  sourceAt(sx, sy, frameId, radiusCss = 10) {
    const f = this.frames.get(frameId); if (!f) return [];
    const [dx, dy] = this.toData(sx, sy), pps = this.view.pxPerData, r = radiusCss / pps, out = [];
    for (const s of f.sources) {
      const ax = s.x - dx, ay = s.y - dy;
      if (Math.abs(ax) > r || Math.abs(ay) > r) continue;
      const d = Math.hypot(ax, ay) * pps;
      if (d <= radiusCss) out.push([d, s]);
    }
    return out.sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  }
  buildPlan(o) {
    const layer = o.layer || 'model', mode = o.mode || 'video';
    const plane = layer === 'raw' ? 'img' : layer === 'leftover' ? 'leftover' : 'background';
    const has = (id) => id != null && this.frames.has(id);
    const a = o.a, t = Math.min(1, Math.max(0, o.t || 0));
    const sym = layer === 'leftover' || mode === 'diff';
    let lim = o.lim || { lo: 0, hi: 1 };
    lim = sym ? { lo: -symLimit(lim), hi: symLimit(lim) } : { lo: lim.lo, hi: lim.hi };
    let bg, glows = [], glowMax = false;
    if (mode === 'diff') {
      const prev = has(o.prev) ? o.prev : a;
      bg = { type: 'diff', a, b: prev, wa: 1, wb: -1 };
      glows = prev === a ? [] : [{ id: a, w: 1, vs: prev, minSnr: 0 }, { id: prev, w: -1, vs: a, minSnr: 0 }];
    } else if (mode === 'trail') {
      const ids = (o.trail && o.trail.length ? o.trail : [a]).filter((id) => this.frames.has(id));
      // Stack the *changes*: current frame as the base, plus the running max of glows (model) or of the
      // positive residual (raw / leftover). The background itself is never accumulated.
      bg = { type: 'trail', a, trail: ids, resid: layer === 'raw' ? 'residRaw' : 'residLeft', wa: 1, wb: 0 };
      const recent = ids.slice(-60);
      glows = recent.map((id, i) => (id === a ? { id, w: 1 } : { id, w: trailWeight(recent.length - 1 - i), vs: a, minSnr: 8, match: 2.5 }));
      glowMax = true;
    } else if (mode === 'video' && has(o.b) && t > 0) {
      bg = { type: 'blend', a, b: o.b, wa: 1 - t, wb: t };
      glows = [{ id: a, w: 1 - t }, { id: o.b, w: t }].filter((g) => g.w > 0);
    } else { bg = { type: 'single', a, b: null, wa: 1, wb: 0 }; glows = [{ id: a, w: 1 }]; }
    if (layer !== 'model') glows = [];
    const tint0 = o.tint || [1, 1, 1], mx = Math.max(...tint0, 1e-6);
    const tint = tint0.map((c) => 1 - 0.75 * (1 - c / mx));
    return {
      css: { w: this.cssW, h: this.cssH, dpr: this.dpr }, view: this.view, layer, mode, plane, sym, lim,
      base: sym || bg.type === 'diff' ? 0 : lim.lo, glowRange: sym ? lim.hi : (Number.isFinite(o.lim && o.lim.star) ? o.lim.star : lim.hi - lim.lo) * this.glowParams.rangeMul, stretch: o.stretch || 'asinh', tint, bg, glows, glowMax,
    };
  }
  render(o = {}) {
    if (!this.npix) return;
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    if ((cw && cw !== this.cssW) || (ch && ch !== this.cssH) || this.canvas.width !== Math.round(this.cssW * this.dpr)) this.resize();
    this.backend.render(this.buildPlan(o));
  }
  /** Debug/extra: number of GPU textures currently resident. */
  get residentTextures() { return this.backend.tex ? this.backend.tex.size : 0; }
}

export const _internal = {
  mitchell, STRETCH_FN, mapValue, glowIntensity, colorOf, symLimit, glowSigmaCss, glowSigmas, viewToScreen, viewToData, fitView,
  trailWeight, GROUND, MID, WHITE, GLOW_DEFAULTS,
};
