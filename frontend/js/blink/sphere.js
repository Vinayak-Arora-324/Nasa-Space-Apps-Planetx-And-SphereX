// Sphere view: Aladin Lite full-window with all chrome hidden. Degrades to a dark ground when the
// library or the HiPS tiles are unreachable (the camera model keeps working so flights still run).
const SRC = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js';
// IRSA publishes the SPHEREx DR1 all-sky data cube as HiPS (102 frames, one per band/channel).
export const SPHEREX_HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
export const FALLBACK_HIPS = 'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color';
const CUBE = { depth: 102, emMin: 7.43e-7, emMax: 5.009e-6 };
const C_LIGHT = 299792458;
// Aladin paints tiles it has not loaded yet with the cube's blank value (26/255, flat grey). A black point just
// above it turns unloaded areas into the ground colour and darkens the noisy sky background a little.
const CUT_MIN = 30;
const SKY_PIXEL_DEG = 0.0035786;   // hips_pixel_scale of the cube (order 5)

let libPromise = null;
function loadLib() {
  if (libPromise) return libPromise;
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
  libPromise = Promise.race([
    import(SRC).then(async (m) => { const A = m.default || window.A; await A.init; return A; }),
    timeout,
  ]).catch((e) => { libPromise = null; throw e; });
  return libPromise;
}

export class Sphere {
  constructor(host) {
    this.host = host;
    this.al = null; this.A = null; this.cube = null;
    this.source = 'none';          // 'spherex' | '2mass' | 'none'
    this.cam = { ra: 285, dec: -8, fov: 85 };
    this.band = 2;
    this.onSource = () => {};
  }
  get ok() { return !!this.al; }

  async init(cam) {
    Object.assign(this.cam, cam);
    try {
      const A = await loadLib();
      this.A = A;
      this.al = A.aladin(this.host, {
        survey: [], log: false, target: `${this.cam.ra} ${this.cam.dec}`, fov: this.cam.fov, cooFrame: 'ICRSd', projection: 'SIN',
        showReticle: false, showZoomControl: false, showFullscreenControl: false, showLayersControl: false, showGotoControl: false,
        showFrame: false, showCooGridControl: false, showProjectionControl: false, showSettingsControl: false, showShareControl: false,
        showStatusBar: false, showSimbadPointerControl: false, showContextMenu: false, showCatalogControl: false, showFov: false,
        backgroundColor: 'rgb(5,7,11)', showFullscreenControl2: false,
      });
      try { this.al.setBackgroundColor && this.al.setBackgroundColor('rgb(5,7,11)'); } catch (_) { /* optional */ }
      this._loadSurvey();
      return true;
    } catch (e) {
      this.al = null; this.source = 'none'; this.error = e;
      this.onSource('none');
      return false;
    }
  }

  _loadSurvey() {
    const { A, al } = this;
    let settled = false;
    const useFallback = () => {
      if (settled) return; settled = true;
      try { al.setBaseImageLayer(FALLBACK_HIPS); this.source = '2mass'; } catch (_) { this.source = 'none'; }
      this.onSource(this.source);
    };
    try {
      const cube = A.imageHiPS(SPHEREX_HIPS, {
        successCallback: (hips) => { if (settled) return; settled = true; this.cube = hips; try { hips.setCuts(CUT_MIN, 255); } catch (_) { /* default cuts */ } this.source = 'spherex'; this.setBand(this.band); this.onSource('spherex'); },
        errorCallback: useFallback,
      });
      al.setBaseImageLayer(cube);
      setTimeout(useFallback, 12000);
    } catch (_) { useFallback(); }
  }

  /** Show the cube channel in the middle of detector band d (1..6). */
  setBand(d) {
    this.band = d;
    if (!this.cube) return;
    const frame = 17 * (d - 1) + 8, fLo = C_LIGHT / CUBE.emMax, fHi = C_LIGHT / CUBE.emMin;
    try { this.cube.setFrequency({ value: fLo + (frame + 0.5) / CUBE.depth * (fHi - fLo), unit: 'Hz' }); } catch (_) { /* tiles not ready */ }
  }

  /**
   * The all-sky cube is only 13 arcsec per pixel; below a few degrees of field the tiles would show as
   * huge square pixels. Blur the map in proportion to the magnification (CSS blur on the host, only when needed).
   */
  soften(fov) {
    if (!this.host || !(fov > 0)) return;
    const w = this.host.clientWidth || 1440, mag = (SKY_PIXEL_DEG * w) / fov;
    const sd = mag > 1.6 ? Math.min(16, Math.round(0.4 * (mag - 1) * 2) / 2) : 0;
    if (sd !== this._sd) { this._sd = sd; this.host.style.filter = sd ? `blur(${sd}px)` : ''; }
  }

  setCamera(ra, dec, fov) {
    this.cam = { ra, dec, fov };
    this.soften(fov);
    if (!this.al) return;
    try { this.al.gotoRaDec(ra, dec); this.al.setFoV(fov); } catch (_) { /* mid-load */ }
  }
  setCenter(ra, dec) { this.setCamera(ra, dec, this.cam.fov); }

  /** Read the live camera (the user may have dragged/scrolled through Aladin). */
  readCamera() {
    if (this.al) {
      try {
        const [ra, dec] = this.al.getRaDec(), f = this.al.getFoV();
        if (isFinite(ra) && isFinite(dec) && f && isFinite(f[0])) this.cam = { ra: ((ra % 360) + 360) % 360, dec, fov: f[0] };
        this.soften(this.cam.fov);
      } catch (_) { /* keep last */ }
    }
    return this.cam;
  }
  world2screen(ra, dec) {
    if (!this.al) return null;
    try { const p = this.al.world2pix(ra, dec); return p && isFinite(p[0]) ? { x: p[0], y: p[1] } : null; } catch (_) { return null; }
  }
  screen2world(x, y) {
    if (!this.al) return null;
    try { const w = this.al.pix2world(x, y); return w && isFinite(w[0]) ? { ra: ((w[0] % 360) + 360) % 360, dec: w[1] } : null; } catch (_) { return null; }
  }
}
