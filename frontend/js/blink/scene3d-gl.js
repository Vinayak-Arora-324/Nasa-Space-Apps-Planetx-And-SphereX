// GL plumbing for scene3d.js: shader programs and the HDR chain (RGBA16F scene target, bloom, tonemap).
// The HDR chain is optional: without EXT_color_buffer_float, supportsHdr() is false and the scene draws straight to the canvas.

/** Compile and link a program; returns { p, u } with the named uniform locations. `defines` is inserted after #version. */
export function makeProgram(gl, vs, fs, names, defines = '') {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src.replace('#version 300 es\n', `#version 300 es\n${defines}`));
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  const u = {};
  for (const n of names) u[n] = gl.getUniformLocation(p, n);
  return { p, u };
}

export const supportsHdr = (gl) => !!gl.getExtension('EXT_color_buffer_float');

const FS_TRI_VS = `#version 300 es
precision highp float;
out vec2 v_uv;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));   // 0,0  2,0  0,2: one triangle over the screen
  v_uv = p; gl_Position = vec4(p*2.0 - 1.0, 0.0, 1.0);
}`;
// 13-tap downsample (Jimenez). The first level also takes out the dim stars with a soft threshold, so only the bright
// objects glow and the dense star field is not hazed.
const DOWN_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src; uniform vec2 u_px; uniform float u_thresh;
vec3 T(vec2 d){
  vec3 c = texture(u_src, v_uv + d*u_px).rgb;
  float l = max(c.r, max(c.g, c.b));
  return c * (u_thresh > 0.0 ? max(l - u_thresh, 0.0)/max(l, 1e-4) : 1.0);
}
void main(){
  vec3 a=T(vec2(-2,2)), b=T(vec2(0,2)), c=T(vec2(2,2)), d=T(vec2(-2,0)), e=T(vec2(0,0)), f=T(vec2(2,0)),
       g=T(vec2(-2,-2)), h=T(vec2(0,-2)), i=T(vec2(2,-2)), j=T(vec2(-1,1)), k=T(vec2(1,1)), l=T(vec2(-1,-1)), m=T(vec2(1,-1));
  o = vec4(e*0.125 + (a+c+g+i)*0.03125 + (b+d+f+h)*0.0625 + (j+k+l+m)*0.125, 1.0);
}`;
const UP_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src; uniform vec2 u_px; uniform float u_w;
void main(){
  vec3 s = texture(u_src, v_uv).rgb*4.0;
  s += (texture(u_src, v_uv + u_px*vec2(1,0)).rgb + texture(u_src, v_uv - u_px*vec2(1,0)).rgb
      + texture(u_src, v_uv + u_px*vec2(0,1)).rgb + texture(u_src, v_uv - u_px*vec2(0,1)).rgb)*2.0;
  s += texture(u_src, v_uv + u_px).rgb + texture(u_src, v_uv - u_px).rgb
     + texture(u_src, v_uv + u_px*vec2(1,-1)).rgb + texture(u_src, v_uv + u_px*vec2(-1,1)).rgb;
  o = vec4(s*(u_w/16.0), 1.0);
}`;
/** ACES filmic fit (Narkowicz), then the sRGB transfer function. Shared with the LDR fallback of the impostor shader. */
export const TONE_GLSL = `
vec3 aces(vec3 x){ return clamp((x*(2.51*x + 0.03))/(x*(2.43*x + 0.59) + 0.14), 0.0, 1.0); }
vec3 srgb(vec3 c){ return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }
`;
const TONE_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_scene, u_bloom; uniform float u_strength, u_exposure;
${TONE_GLSL}
void main(){
  vec3 c = texture(u_scene, v_uv).rgb + texture(u_bloom, v_uv).rgb*u_strength;
  o = vec4(srgb(aces(c*u_exposure)), 1.0);
}`;

const LEVELS = 5;

export class HdrChain {
  constructor(gl) {
    this.gl = gl; this.w = 0; this.h = 0; this.ok = false;
    this.vao = gl.createVertexArray();                                     // attribute-less draws (fullscreen passes, impostors)
    this.down = makeProgram(gl, FS_TRI_VS, DOWN_FS, ['u_src', 'u_px', 'u_thresh']);
    this.up = makeProgram(gl, FS_TRI_VS, UP_FS, ['u_src', 'u_px', 'u_w']);
    this.tone = makeProgram(gl, FS_TRI_VS, TONE_FS, ['u_scene', 'u_bloom', 'u_strength', 'u_exposure']);
    this.scene = null; this.levels = [];
  }
  _target(w, h) {
    const gl = this.gl, tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h, ok };
  }
  _free(t) { if (t) { this.gl.deleteTexture(t.tex); this.gl.deleteFramebuffer(t.fb); } }
  /** Size the scene target and the bloom levels from the canvas size. Returns false when the HDR chain cannot be used. */
  resize(w, h) {
    if (w === this.w && h === this.h && this.scene) return this.ok;
    this.w = w; this.h = h;
    this._free(this.scene); this.levels.forEach((l) => this._free(l));
    this.scene = this._target(w, h); this.levels = [];
    let lw = w, lh = h;
    for (let i = 0; i < LEVELS; i++) { lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1); this.levels.push(this._target(lw, lh)); }
    this.ok = this.scene.ok && this.levels.every((l) => l.ok);
    return this.ok;
  }
  /** Draw the next passes into the HDR scene target. */
  begin() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fb);
    gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  }
  /** Bloom the scene and tonemap it to the canvas. */
  finish({ strength = 0.12, exposure = 1, threshold = 0.45 } = {}) {
    const gl = this.gl, L = this.levels;
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(this.down.p);
    gl.uniform1i(this.down.u.u_src, 0);
    let src = this.scene;
    for (let i = 0; i < LEVELS; i++) {
      const dst = L[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb); gl.viewport(0, 0, dst.w, dst.h);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(this.down.u.u_px, 1 / src.w, 1 / src.h);
      gl.uniform1f(this.down.u.u_thresh, i === 0 ? threshold : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      src = dst;
    }
    gl.useProgram(this.up.p);
    gl.uniform1i(this.up.u.u_src, 0);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = LEVELS - 1; i > 0; i--) {
      const lo = L[i], dst = L[i - 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb); gl.viewport(0, 0, dst.w, dst.h);
      gl.bindTexture(gl.TEXTURE_2D, lo.tex);
      gl.uniform2f(this.up.u.u_px, 1 / lo.w, 1 / lo.h);
      gl.uniform1f(this.up.u.u_w, 0.9);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(this.tone.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, L[0].tex);
    gl.uniform1i(this.tone.u.u_scene, 0); gl.uniform1i(this.tone.u.u_bloom, 1);
    gl.uniform1f(this.tone.u.u_strength, strength); gl.uniform1f(this.tone.u.u_exposure, exposure);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
  }
}
