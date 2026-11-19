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
uniform float u_toPc, u_expo, u_limit, u_dpr, u_maxPt, u_sig;
uniform int u_skip[16];
out vec3 v_col;
out float v_amp;
out vec4 v_psf;                                              // core sigma, wing radius, sprite radius, sprite size (device px)
// One point-spread function for every star, as in a real eye or camera: a tight core plus faint power-law wings
// (Moffat, beta 1.5, so ~r^-3). Brightness only scales it. A faint star is a dim point; a bright one saturates its core
// and lights up more of its wings, so it looks bigger exactly the way a bright star does in a photograph.
const float WING = 0.05, WING_R = 2.0, VISIBLE = 0.01;      // wing peak (of the core's), wing scale (CSS px), cut-off
void main(){
  for (int i = 0; i < 16; i++) if (gl_VertexID == u_skip[i]) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; v_col = vec3(0.0); v_amp = 0.0; v_psf = vec4(1.0); return; }
  vec3 rel = a_pos - u_eye;
  float dist = max(length(rel)*u_toPc, 1e-9);
  float m = a_abs + 2.1714724*log(dist) - 5.0;               // apparent magnitude: 5 log10(d) - 5 + M
  float flux = exp(-0.9210340*(m - u_limit));                // 10^(-0.4 (m - limit)): 1 at the limit
  gl_Position = u_vp * vec4(rel, 1.0);
  // Peak display intensity: the intensity law of tier 1 (0.3 sqrt(flux)), times the exposure. Above 1 the core saturates.
  float x = 0.3*sqrt(flux)*u_expo*max(max(a_col.r, a_col.g), a_col.b);
  float rw = WING_R*u_dpr;
  float rWing = rw*pow(max(x*WING/VISIBLE, 1.0), 1.0/3.0);   // where x * wing(r) falls to the visible cut-off
  float rad = clamp(max(rWing, 3.0*u_sig + 1.0), 1.0, 0.5*min(40.0*u_dpr, u_maxPt));
  gl_PointSize = 2.0*ceil(rad);
  v_psf = vec4(u_sig, rw, rad, gl_PointSize);
  v_col = a_col; v_amp = x;
}`;
// Planets and small bodies: x y z, CSS px size, alpha, r g b. Positions are relative to u_eye. A NEGATIVE size marks a hollow
// marker (a derived record, section 7.1): the sprite is |size| px wide and the fragment shader draws a ring instead of a dot.
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
out float v_ring;
void main(){
  gl_Position = u_vp * vec4(a_pos - u_eye, 1.0);
  gl_PointSize = abs(a_style.x) * u_dpr;
  v_col = a_col * a_style.y; v_head = 0.0; v_ring = a_style.x < 0.0 ? 1.0 : 0.0;
}`;
// A gaussian core with a faint halo that reaches zero at the sprite edge.
export const SPRITE_FS = `#version 300 es
precision highp float;
in vec3 v_col;
in float v_head;
in float v_ring;
out vec4 o;
${INVT}
void main(){
  vec2 p = gl_PointCoord*2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 >= 1.0) discard;
  float k = (exp(-4.0*r2) + 0.12*exp(-1.2*r2)) * (1.0 - r2*r2);
  // Hollow marker: a ring (peak at 0.72 of the radius, about 0.4 wide) instead of the filled core; solid markers are unchanged.
  if (v_ring > 0.5) k = clamp(1.0 - abs(sqrt(r2) - 0.72)/0.2, 0.0, 1.0);
  // The profile is applied in display space, as tier 1 did, then mapped to linear: gaussian tails stay as thin as before.
  o = vec4(invT3(v_col * k) + (v_col / max(max(v_col.r, max(v_col.g, v_col.b)), 1e-4)) * (v_head * k * k * 0.5), 1.0);
}`;
// Stars: the point-spread function of STAR_VS. The core's value at each pixel is the gaussian's average over that
// pixel's square (a product of erf differences), normalised so a star centred on a pixel peaks at v_amp. It is exact for
// sub-pixel cores, so faint stars keep their brightness and shape as they move instead of snapping between a 1-pixel and
// a 2x2 dot. The display -> linear map works on the brightest channel and keeps the hue (per channel, a bright blue
// star got a dark, saturated blue centre). What is above white goes on as HDR headroom, which feeds the bloom.
export const STAR_FS = `#version 300 es
precision highp float;
in vec3 v_col;
in float v_amp;
in vec4 v_psf;
out vec4 o;
${INVT}
float erfA(float x){                                         // Winitzki: erf to about 1e-4
  float x2 = x*x, ax2 = 0.147*x2;
  return sign(x)*sqrt(1.0 - exp(-x2*(1.2732395 + ax2)/(1.0 + ax2)));
}
float boxG(float x, float k){ return erfA((x + 0.5)*k) - erfA((x - 0.5)*k); }
const float WING = 0.05;                                     // must match STAR_VS
void main(){
  vec2 d = (gl_PointCoord - 0.5)*v_psf.w;                   // offset from the star in device px (sub-pixel exact)
  float k = 0.70710678/v_psf.x, c0 = boxG(0.0, k);
  float core = boxG(d.x, k)*boxG(d.y, k)/(c0*c0);
  float r2 = dot(d, d), e2 = r2/(v_psf.z*v_psf.z);
  float q = 1.0 + r2/(v_psf.y*v_psf.y);
  float wing = e2 < 1.0 ? WING/(q*sqrt(q))*(1.0 - e2)*(1.0 - e2) : 0.0;
  float I = v_amp*(core + wing);
  if (I < 1e-4) discard;
  vec3 hue = v_col/max(max(v_col.r, v_col.g), max(v_col.b, 1e-4));
  o = vec4(hue*(invT(min(I, 1.0)) + 0.5*log2(max(I, 1.0))), 1.0);
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
uniform float u_gran, u_gamp, u_spots, u_seed;   // granule size (stellar radii), granulation contrast, starspots on/off, per-star seed
${TONE_GLSL}
float hash(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x + p.y + p.z)); }
float vnoise(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f*f*(3.0 - 2.0*f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
uvec3 pcg3d(uvec3 v){
  v = v*1664525u + 1013904223u;
  v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
  v ^= v >> 16u;
  v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
  return v;
}
vec3 hash3i(vec3 c){ return vec3(pcg3d(uvec3(ivec3(floor(c)) + 1048576)))*(1.0/4294967295.0); }
// Cellular (Worley) noise: distance to the nearest and second-nearest feature point, and a random value for the nearest
// cell. Feature points wander slowly, so the cells evolve the way granules do.
vec3 worley(vec3 x, float tm){
  vec3 i = floor(x), f = x - i;
  float F1 = 9.0, F2 = 9.0, id = 0.0;
  for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int l = -1; l <= 1; l++) {
    vec3 g = vec3(float(l), float(j), float(k));
    vec3 hh = hash3i(i + g);
    vec3 r = g + 0.5 + 0.38*sin(tm + 6.2831853*hh) - f;
    float dd = dot(r, r);
    if (dd < F1) { F2 = F1; F1 = dd; id = hh.x; } else if (dd < F2) F2 = dd;
  }
  return vec3(sqrt(F1), sqrt(F2), id);
}
// Granules: bright cell interiors, narrow dark lanes between them, cell-to-cell variation. Roughly zero mean.
// The cell field is domain-warped, so cells are irregular rather than a tiling, and each granule is a soft dome.
float granules(vec3 p, float tm){
  p += 1.4*(vec3(vnoise(p*0.4), vnoise(p*0.4 + 7.1), vnoise(p*0.4 + 13.7)) - 0.5);
  vec3 w = worley(p, tm);
  float lane = 1.0 - smoothstep(0.0, 0.3, w.y - w.x);
  float dome = 1.0 - smoothstep(0.0, 0.9, w.x);
  float fine = vnoise(p*3.1 + 5.0) - 0.5;                    // texture inside the cells
  return 0.9*dome*(0.6 + 0.8*w.z) + 0.25*fine - 0.3*lane - 0.5;
}
// Starspots: up to six, in the active latitudes (8 to 35 degrees), umbra and penumbra, edges anti-aliased by fp.
float starspots(vec3 s, float fp){
  float I = 1.0;
  for (int i = 0; i < 6; i++) {
    vec3 hh = hash3i(vec3(float(i), u_seed, 7.0));
    if (hh.x < 0.4) continue;
    float lat = (0.14 + 0.47*hh.y)*(hh.z < 0.5 ? -1.0 : 1.0), lon = 6.2831853*fract(hh.x*7.13 + hh.y*3.7);
    vec3 c = vec3(cos(lat)*cos(lon), cos(lat)*sin(lon), sin(lat));
    float r = 0.012 + 0.032*fract(hh.z*13.1), dd = length(s - c), e = max(fp, 1e-4);
    float pen = 1.0 - smoothstep(r - e, r + e, dd), umb = 1.0 - smoothstep(0.42*r - e, 0.42*r + e, dd);
    I *= 1.0 - 0.32*pen - 0.5*umb;
  }
  return I;
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
      // Limb darkening per channel: blue darkens more than red, so the limb is darker and redder, as in white-light
      // photographs of the Sun.
      // Quadratic law, I = 1 - a(1 - mu) - b(1 - mu)^2, with a + b ~ 1.15 u (the Sun in V: a 0.47, b 0.23).
      vec3 uc = u_u*vec3(0.82, 1.0, 1.18), om = vec3(1.0 - mu);
      vec3 I = pow(max(1.0 - 0.8*uc*om - 0.35*uc*om*om, 0.04), vec3(1.4));   // with a photographic contrast curve
      float g = 1.0;
      if (u_evid < 0.5) {                                      // illustrative surface: granulation, network, spots
        vec3 s = u_v2w*n;                                      // surface point on the unit sphere, world-fixed
        float fp = u_pix*t0/max(mu, 0.08);                     // one pixel's size on the surface, in stellar radii
        float tm = u_time*0.08, ctr = 0.35 + 0.65*mu;           // granulation contrast fades towards the limb
        // Each scale shows only once its cells are a few pixels across; below that it averages out to a smooth disc,
        // as a real star does in a photograph.
        float wg = smoothstep(1.5, 4.0, u_gran/fp);
        if (wg > 0.0) g += u_gamp*wg*ctr*(granules(s/u_gran, tm) + 0.5*wg*granules(s*(2.03/u_gran) + 17.0, tm*1.7));
        float sg = 18.0*u_gran, wsg = smoothstep(1.5, 4.0, sg/fp);
        if (wsg > 0.0) {                                       // supergranulation network: bright faculae towards the limb
          vec3 w = worley(s/sg + 31.0, tm*0.2);
          float net = 1.0 - smoothstep(0.0, 0.12, w.y - w.x);
          g *= 1.0 + wsg*(0.25*u_gamp*(1.0 - mu)*(1.0 - mu)*net*5.0 - 0.02*u_gamp*net);
        }
        if (u_spots > 0.5) g *= starspots(s, fp);
      }
      rgb = u_col*I*(g*u_surf)*cov; a = cov;
    }
    if (cov < 1.0 && t > 0.0 && u_glow > 0.0) {                // glare: what an eye or a camera adds around a bright disc
      float x = max(h - 1.0, 0.0);
      float fall = 0.55*exp(-x*7.0) + 0.45/(1.0 + 25.0*x*x);
      rgb += u_col*u_glow*fall*smoothstep(u_ext, u_ext*0.55, h)*(1.0 - cov);
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
  rgb = srgb(tonemap(rgb));
#endif
  o = vec4(rgb, a);
}`;

// The Milky Way glow behind everything: the NASA SVS Deep Star Maps 2020 sky with its resolved stars taken out
// (backend/scripts/build_milkyway.py), plate carree in ICRS. One full-screen triangle; the texture is SRGB8, so it is
// sampled and filtered in linear light. No mipmaps, so the RA seam needs no special care.
export const SKY_VS = `#version 300 es
precision highp float;
uniform vec2 u_tan;
out vec3 v_dir;
void main(){
  vec2 ndc = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2))*2.0 - 1.0;
  v_dir = vec3(ndc*u_tan, -1.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;
export const SKY_FS = `#version 300 es
precision highp float;
in vec3 v_dir;
out vec4 o;
uniform sampler2D u_sky;
uniform mat3 u_v2w;
uniform float u_k;
${TONE_GLSL}
void main(){
  vec3 w = normalize(u_v2w*v_dir);
  float ra = atan(w.y, w.x), dec = asin(clamp(w.z, -1.0, 1.0));
  vec3 c = texture(u_sky, vec2(fract(0.5 - ra*0.15915494), 0.5 - dec*0.31830989)).rgb*u_k;
#ifdef LDR
  c = srgb(tonemap(c));
#endif
  o = vec4(c, 1.0);
}`;

// Cluster billboards (section 16.10): one camera-facing quad per cluster, built on the CPU each frame (camera-relative doubles cast
// to float32, like the markers). Vertex: x y z (camera-relative corner), u v (position in the quad in units of r50, so +-4 at the
// edges), r g b, a (alpha, fade included), mode (0 glow, 1 outline, 2 dashed outline). Drawn additively with no depth write.
//  glow     surface brightness a * rgb * (1 + (rho/r50)^2)^-2 (a Plummer profile), scaled by u_k (kept faint: it is an illustration)
//  outline  no glow, an antialiased ring at rho = r50 about 1.5 CSS px wide (fwidth), dashed when mode is 2
export const BB_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in vec2 a_uv;
layout(location=2) in vec4 a_col;
layout(location=3) in float a_mode;
uniform mat4 u_vp;
out vec2 v_uv;
out vec4 v_col;
out float v_mode;
void main(){
  gl_Position = u_vp * vec4(a_pos, 1.0);
  v_uv = a_uv; v_col = a_col; v_mode = a_mode;
}`;
export const BB_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_col;
in float v_mode;
out vec4 o;
uniform float u_k, u_dpr;
${TONE_GLSL}
void main(){
  float rho = length(v_uv);
  vec3 c;
  if (v_mode < 0.5) {
    // Plummer profile with its value at the quad edge (rho = 4) subtracted and rescaled, so it is exactly 0 there, times a taper
    // over rho 3..4: no visible square, whatever the brightness
    float q = 1.0 + rho*rho;
    float f = max((1.0/(q*q) - 0.00346) / (1.0 - 0.00346), 0.0) * (1.0 - smoothstep(3.0, 4.0, rho));
    c = v_col.rgb * (v_col.a * u_k * f);
  } else {
    float w = fwidth(rho);                                           // rho change per device px
    float hw = 0.75*u_dpr*w;                                     // half of ~1.5 CSS px, in rho units
    float ring = 1.0 - smoothstep(hw - w, hw + w, abs(rho - 1.0));
    if (v_mode > 1.5) {                                              // dashed: 24 dashes around the ring, half on
      float ang = atan(v_uv.y, v_uv.x);
      ring *= step(0.5, fract(ang * 3.8197186));
    }
    c = v_col.rgb * (v_col.a * u_k * ring);
  }
  if (max(c.r, max(c.g, c.b)) < 1e-5) discard;
#ifdef LDR
  c = srgb(tonemap(c));
#endif
  o = vec4(c, 1.0);
}`;

// Nebula billboards (docs/object-framework.md section 17.6.2). A quad per item is built on the CPU in clip space (a_pos is NDC); a_uv is the
// position in the ellipse's own units, so the elliptical radius is simply rho = length(v_uv) (1 on the catalogue ellipse). Illustrative looks.
// a_mode: 0 emission, 1 reflection, 2 planetary, 3 supernova remnant, 4 dark (alpha-only output, drawn with blendFunc(ZERO, ONE_MINUS_SRC_ALPHA));
// 10 / 11: Evidence outline, solid / dashed (no noise, no colour beyond the marker colour).
export const NEBULA_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_uv;
layout(location=2) in vec4 a_col;
layout(location=3) in vec2 a_p;
out vec2 v_uv;
out vec4 v_col;
out vec2 v_p;
void main(){
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_uv = a_uv; v_col = a_col; v_p = a_p;
}`;
export const NEBULA_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_col;
in vec2 v_p;
out vec4 o;
uniform float u_k, u_dpr;
${TONE_GLSL}
float hash21(vec2 p, float s){
  p = fract(p*vec2(123.34, 456.21) + s*17.13);
  p += dot(p, p + 45.32 + s);
  return fract(p.x*p.y);
}
float vnoise(vec2 p, float s){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0 - 2.0*f);
  return mix(mix(hash21(i, s), hash21(i + vec2(1,0), s), f.x), mix(hash21(i + vec2(0,1), s), hash21(i + vec2(1,1), s), f.x), f.y);
}
float fbm(vec2 p, float s){   // 3 octaves of value noise, 0..1
  float a = 0.5, t = 0.0, n = 0.0;
  for (int i = 0; i < 3; i++) { t += a*vnoise(p, s); n += a; p = p*2.03 + 7.1; a *= 0.5; }
  return t/n;
}
void main(){
  float rho = length(v_uv);
  float seed = v_p.y, mode = v_p.x;
  vec3 c = vec3(0.0);
  float alpha = v_col.a;
  if (mode > 9.5) {                                                   // Evidence view: the catalogue ellipse at rho = 1
    float w = fwidth(rho);                                            // rho change per device px
    float hw = 0.75*u_dpr*w;                                          // half of ~1.5 CSS px, in rho units
    float ring = 1.0 - smoothstep(hw - w, hw + w, abs(rho - 1.0));
    if (mode > 10.5) ring *= step(0.5, fract(atan(v_uv.y, v_uv.x) * 3.8197186));   // dashed: 24 dashes
    c = v_col.rgb * (alpha * u_k * ring);
  } else {
    float edge = 1.0 - smoothstep(1.0, 1.3, rho);                     // the quad reaches 1.3: nothing may be left at its edge
    vec2 q = v_uv*2.2;
    float n = fbm(q, seed);
    float prof;
    vec3 col = v_col.rgb;
    if (mode < 0.5) prof = smoothstep(1.0, 0.55, rho) * (0.55 + 0.45*n);                          // emission
    else if (mode < 1.5) prof = smoothstep(1.0, 0.3, rho) * (0.72 + 0.28*n);                      // reflection: softer
    else if (mode < 2.5) {                                                                        // planetary: an annulus, a faint centre
      float ring = exp(-pow((rho - 0.7)/0.17, 2.0));
      prof = (ring + 0.12*smoothstep(0.7, 0.0, rho)) * (0.8 + 0.2*n);
      col = mix(v_col.rgb, vec3(1.0, 0.32, 0.28), smoothstep(0.35, 0.95, rho));                   // teal core to red rim
    } else if (mode < 3.5) {                                                                      // supernova remnant: a thin shell with filaments
      float shell = exp(-pow((rho - 0.9)/0.09, 2.0));
      float fil = pow(fbm(q*1.7 + 3.0, seed + 1.0), 2.0)*2.2;
      prof = shell*(0.12 + fil) + 0.08*smoothstep(1.0, 0.0, rho)*n;
      col = mix(v_col.rgb, vec3(0.3, 0.8, 0.85), smoothstep(0.35, 0.75, fbm(q*0.9 + 9.0, seed)));  // orange, teal
    } else prof = smoothstep(1.0, 0.55, rho) * (0.55 + 0.45*n);                                   // dark: the emission profile
    prof *= edge;
    if (mode > 3.5) { o = vec4(0.0, 0.0, 0.0, clamp(alpha*prof, 0.0, 0.9)); if (o.a < 0.002) discard; return; }
    c = col * (alpha * u_k * prof);
  }
  if (max(c.r, max(c.g, c.b)) < 1e-5) discard;
#ifdef LDR
  c = srgb(tonemap(c));
#endif
  o = vec4(c, 1.0);
}`;

// Black-hole lensing look (section 17.9, illustrative): one screen-space quad per black hole, radius 4 x its drawn shadow radius, drawn after the stars
// with premultiplied "over" blending (blendFunc(ONE, ONE_MINUS_SRC_ALPHA)). v_uv is the position in units of the shadow radius, so rho = length(v_uv):
// a black disc at rho < 1 (alpha 1: it hides the stars behind it), a thin photon ring at rho ~ 1, a soft halo out to ~2.5 and, for an accreting black
// hole, an inclined annulus from rho 1.5 to 4, brighter on one side (Doppler beaming). The back half of the disc is hidden by the shadow, the front half is not.
// a_p: x = disc (0 or 1), y = cos(inclination), z = the disc's position angle on screen (arbitrary but stable, seeded from the id), w = unused.
export const LENS_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_uv;
layout(location=2) in vec4 a_p;
out vec2 v_uv;
out vec4 v_p;
void main(){
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_uv = a_uv; v_p = a_p;
}`;
export const LENS_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_p;
out vec4 o;
${TONE_GLSL}
void main(){
  float rho = length(v_uv);
  if (rho > 4.0) discard;
  float w = max(fwidth(rho), 1e-4);
  float shadow = 1.0 - smoothstep(1.0 - w, 1.0 + w, rho);
  float ring = exp(-pow((rho - 1.035)/0.05, 2.0));
  float halo = 0.30*exp(-(rho - 1.0)*2.4) * (1.0 - smoothstep(1.6, 2.5, rho)) * step(1.0, rho + w);
  vec3 c = ring*vec3(1.45, 1.15, 0.80) + halo*vec3(0.95, 0.62, 0.36);
  if (v_p.x > 0.5) {
    float ca = cos(v_p.z), sa = sin(v_p.z);
    vec2 q = vec2(ca*v_uv.x + sa*v_uv.y, -sa*v_uv.x + ca*v_uv.y);     // the disc's frame: its line of nodes along x, the near side at y < 0
    float cosI = max(v_p.y, 0.07);
    float r = length(vec2(q.x, q.y/cosI));                            // radius in the disc's own plane
    float band = smoothstep(1.5, 1.75, r) * (1.0 - smoothstep(3.0, 4.0, r));
    float phi = atan(q.y/cosI, q.x);
    float beam = pow(clamp(0.5 + 0.5*sin(phi + 1.2), 0.0, 1.0), 1.6);  // brighter on one side, still visible on the other
    float temp = clamp((r - 1.5)/2.5, 0.0, 1.0);
    vec3 hot = vec3(1.5, 1.1, 0.75), cool = vec3(0.85, 0.34, 0.12);
    vec3 d = mix(hot, cool, temp) * (band * (0.12 + 1.05*beam) * (1.7/r));
    float front = step(0.0, -q.y);
    d *= max(front, step(1.0, rho));                                  // the shadow hides the back half
    c += d;
  }
  vec3 col = c;
  float a = shadow;
  if (a < 0.002 && max(col.r, max(col.g, col.b)) < 1e-4) discard;
#ifdef LDR
  col = srgb(tonemap(col));
#endif
  o = vec4(col, a);
}`;

export const SPRITE_UNIFORMS_STAR = ['u_vp', 'u_eye', 'u_toPc', 'u_expo', 'u_limit', 'u_dpr', 'u_maxPt', 'u_sig', 'u_skip'];
export const BODY_UNIFORMS = ['u_rect', 'u_tan', 'u_c', 'u_col', 'u_light', 'u_pole', 'u_v2w', 'u_kind', 'u_u', 'u_surf', 'u_glow', 'u_time',
  'u_evid', 'u_w', 'u_ext', 'u_pix', 'u_ring', 'u_band', 'u_atm', 'u_gran', 'u_gamp', 'u_spots', 'u_seed'];
