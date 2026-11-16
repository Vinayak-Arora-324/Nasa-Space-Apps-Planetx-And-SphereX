// GLSL ES 3.00 sources for scene3d.js. Compiled by makeProgram(); `#define LDR` is added when there is no HDR target.
import { TONE_GLSL } from './scene3d-gl.js';

// Display-referred intensity (what tier 1 wrote straight to the canvas) -> linear HDR value that tonemaps (ACES + sRGB)
// back to about the same pixel. Above 1 it keeps going, so bright stars reach well past white and feed the bloom.
const INVT = `
float invT(float a){
#ifdef LDR
  return clamp(a, 0.0, 1.0);
#else
  a = clamp(a, 0.0, 1.0);
  if (a < 0.3) return 0.069*pow(a/0.3, 2.2);
  if (a < 0.6) return mix(0.069, 0.216, (a-0.3)/0.3);
  if (a < 0.8) return mix(0.216, 0.49, (a-0.6)/0.2);
  if (a < 0.95) return mix(0.49, 1.6, (a-0.8)/0.15);
  return mix(1.6, 3.0, (a-0.95)/0.05);
#endif
}
vec3 invT3(vec3 c){ return vec3(invT(c.r), invT(c.g), invT(c.b)); }
float starY(float x){
#ifdef LDR
  return min(x, 1.0);
#else
  return invT(min(x, 1.0)) + 0.5*log2(max(x, 1.0));
#endif
}
`;

// Stars: 7 floats per vertex (x y z abs r g b). The shader subtracts the eye in the current frame's units and gets the
// distance in pc from u_toPc. u_skip lists star indices drawn elsewhere (the near-camera stars, drawn from exact doubles).
export const STAR_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in float a_abs;
layout(location=2) in vec3 a_col;
uniform mat4 u_vp;
uniform vec3 u_eye;
uniform float u_toPc, u_expo, u_limit, u_base, u_perMag, u_dpr, u_maxPt;
uniform int u_skip[16];
out vec3 v_col;
out float v_head;
void main(){
  for (int i = 0; i < 16; i++) if (gl_VertexID == u_skip[i]) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; v_col = vec3(0.0); v_head = 0.0; return; }
  vec3 rel = a_pos - u_eye;
  float dist = max(length(rel)*u_toPc, 1e-9);
  float m = a_abs + 2.1714724*log(dist) - 5.0;               // apparent magnitude: 5 log10(d) - 5 + M
  float flux = exp(-0.9210340*(m - u_limit));                // 10^(-0.4 (m - limit)): 1 at the limit
  gl_Position = u_vp * vec4(rel, 1.0);
  // Size grows linearly with magnitude (log of flux), so a 0 mag star is a big glint, not a screen-filling disc.
  gl_PointSize = clamp(u_base + u_perMag*max(u_limit - m, 0.0), 1.5*u_dpr, min(40.0*u_dpr, u_maxPt));
  // The intensity law of tier 1 (0.3 sqrt(flux)), times the exposure; starY adds headroom above white.
  float x = 0.3*sqrt(flux)*u_expo;
  v_col = a_col * min(x, 1.0);                                          // display-referred; the fragment shader maps it to linear
  v_head = 0.5*log2(max(x, 1.0));
}`;
// Planets and small bodies: x y z, CSS px size, alpha, r g b. Positions are relative to u_eye.
export const POINT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in vec2 a_style;
layout(location=2) in vec3 a_col;
uniform mat4 u_vp;
uniform vec3 u_eye;
uniform float u_dpr;
out vec3 v_col;
out float v_head;
void main(){
  gl_Position = u_vp * vec4(a_pos - u_eye, 1.0);
  gl_PointSize = a_style.x * u_dpr;
  v_col = a_col * a_style.y; v_head = 0.0;
}`;
// A gaussian core with a faint halo that reaches zero at the sprite edge.
export const SPRITE_FS = `#version 300 es
precision highp float;
in vec3 v_col;
in float v_head;
out vec4 o;
${INVT}
void main(){
  vec2 p = gl_PointCoord*2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 >= 1.0) discard;
  float k = (exp(-4.0*r2) + 0.12*exp(-1.2*r2)) * (1.0 - r2*r2);
  // The profile is applied in display space, as tier 1 did, then mapped to linear: gaussian tails stay as thin as before.
  o = vec4(invT3(v_col * k) + (v_col / max(max(v_col.r, max(v_col.g, v_col.b)), 1e-4)) * (v_head * k * k * 0.5), 1.0);
}`;
export const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in vec4 a_col;
uniform mat4 u_vp;
uniform vec3 u_eye;
out vec4 v_col;
void main(){ gl_Position = u_vp * vec4(a_pos - u_eye, 1.0); v_col = a_col; }`;
export const LINE_FS = `#version 300 es
precision highp float;
in vec4 v_col;
out vec4 o;
${INVT}
void main(){ o = vec4(invT3(v_col.rgb * v_col.a), 1.0); }`;

// Impostor spheres: a screen rectangle per body (u_rect, NDC), a ray-sphere intersection per pixel. u_c is the sphere
// centre in view space in units of the sphere's radius, computed on the CPU in doubles, so it is exact from 1 R to kpc.
export const BODY_VS = `#version 300 es
precision highp float;
uniform vec4 u_rect;
out vec2 v_ndc;
void main(){
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  v_ndc = mix(u_rect.xy, u_rect.zw, c);
  gl_Position = vec4(v_ndc, 0.0, 1.0);
}`;
export const BODY_FS = `#version 300 es
precision highp float;
in vec2 v_ndc;
out vec4 o;
uniform vec2 u_tan;
uniform vec3 u_c, u_col, u_light, u_pole;
uniform mat3 u_v2w;
uniform int u_kind;                       // 0 star, 1 planet
uniform float u_u, u_surf, u_glow, u_time, u_evid, u_w, u_ext, u_pix, u_ring, u_band, u_atm;
${TONE_GLSL}
float hash(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x + p.y + p.z)); }
float vnoise(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f*f*(3.0 - 2.0*f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
void main(){
  vec3 d = normalize(vec3(v_ndc*u_tan, -1.0));
  float t = dot(d, u_c);
  vec3 q = u_c - t*d;                                          // stable at distance: no (b^2 - c^2) cancellation
  float h = length(q);
  float cov = t > 0.0 ? clamp((1.0 - h)/(u_pix*length(u_c)) + 0.5, 0.0, 1.0) : 0.0;   // anti-aliased edge
  float h2 = min(h*h, 0.9999);
  float t0 = t - sqrt(1.0 - h2);
  vec3 n = normalize(t0*d - u_c);
  vec3 rgb = vec3(0.0); float a = 0.0;
  if (u_kind == 0) {
    if (cov > 0.0) {
      float mu = clamp(dot(n, -d), 0.0, 1.0);
      float I = 1.0 - u_u*(1.0 - mu);                          // linear limb darkening
      float g = 1.0;
      if (u_evid < 0.5) {                                      // illustrative granulation
        vec3 p = (u_v2w*n)*16.0 + vec3(0.0, 0.0, u_time*0.12);
        float gn = 0.6*vnoise(p) + 0.4*vnoise(p*2.7 + 7.3);
        g = 1.0 + 0.22*(gn - 0.5)*(0.35 + 0.65*mu);
      }
      rgb = u_col*(I*g*u_surf)*cov; a = cov;
    }
    if (cov < 1.0 && t > 0.0 && u_glow > 0.0) {                // illustrative corona
      float x = max(h - 1.0, 0.0);
      float fall = 0.7*exp(-x*3.5) + 0.3*exp(-x*0.9);
      float st = 0.75 + 0.5*vnoise((u_v2w*(q/max(h, 1e-4)))*2.5 + vec3(0.0, 0.0, u_time*0.04));
      rgb += u_col*u_glow*fall*st*smoothstep(u_ext, u_ext*0.55, h)*(1.0 - cov);
    }
  } else {
    vec3 L = normalize(u_light);
    vec3 sph = vec3(0.0); float sa = 0.0;
    if (cov > 0.0) {
      vec3 alb = mix(u_col, vec3(0.5), u_evid);
      if (u_band > 0.5 && u_evid < 0.5) {                      // illustrative cloud bands on the gas giants
        float lat = asin(clamp(dot(n, u_pole), -1.0, 1.0));
        alb *= 0.84 + 0.3*(0.5 + 0.5*sin(lat*20.0 + 2.2*sin(lat*6.0)));
      }
      float ndl = dot(n, L), lit = smoothstep(-0.1, 0.5, ndl); // soft terminator
      sph = alb*(0.012 + lit)*u_surf;
      if (u_atm > 0.5 && u_evid < 0.5) sph += vec3(0.35, 0.55, 1.0)*pow(1.0 - clamp(dot(n, -d), 0.0, 1.0), 3.0)*0.5*smoothstep(-0.3, 0.4, ndl);
      sph *= cov; sa = cov;
    }
    rgb = sph; a = sa;
    if (u_ring > 0.5 && u_evid < 0.5) {                        // Saturn's ring: a flat annulus in the equatorial plane
      float dn = dot(d, u_pole);
      if (abs(dn) > 1e-4) {
        float tr = dot(u_c, u_pole)/dn;
        vec3 rp = tr*d - u_c; float rr = length(rp);
        if (tr > 0.0 && rr > 1.24 && rr < 2.33 && (cov < 0.5 || tr < t0)) {
          float band = 0.55 + 0.45*sin(rr*70.0 + 3.0*sin(rr*23.0));
          float ra = rr < 1.53 ? 0.35 : rr < 1.95 ? 0.9 : rr < 2.03 ? 0.04 : 0.7;      // C ring, B ring, Cassini division, A ring
          ra *= 0.75 + 0.25*band;
          float pl = dot(rp, L);
          float shadow = (pl < 0.0 && length(rp - pl*L) < 1.0) ? 0.1 : 1.0;           // Saturn's shadow on the ring
          vec3 rc = vec3(0.86, 0.78, 0.64)*(0.55 + 0.45*band)*shadow*u_surf;
          rgb = rc*ra + rgb*(1.0 - ra); a = ra + a*(1.0 - ra);
        }
      }
    }
  }
  rgb *= u_w; a *= u_w;
#ifdef LDR
  rgb = srgb(aces(rgb));
#endif
  o = vec4(rgb, a);
}`;

export const SPRITE_UNIFORMS_STAR = ['u_vp', 'u_eye', 'u_toPc', 'u_expo', 'u_limit', 'u_base', 'u_perMag', 'u_dpr', 'u_maxPt', 'u_skip'];
export const BODY_UNIFORMS = ['u_rect', 'u_tan', 'u_c', 'u_col', 'u_light', 'u_pole', 'u_v2w', 'u_kind', 'u_u', 'u_surf', 'u_glow', 'u_time',
  'u_evid', 'u_w', 'u_ext', 'u_pix', 'u_ring', 'u_band', 'u_atm'];
