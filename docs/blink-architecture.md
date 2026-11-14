# Blink rebuild — architecture and interface contract

Approved plan: turn the pixel viewer into the full-window "Blink" sky viewer described in
`docs/blink-ui-spec.md`. The sky is drawn from **measurements of the real data** (fitted sources +
smooth background), with the raw pixels and the leftover (data − model) one switch away.
Nothing is drawn that does not come from SPHEREx data; catalogues only label and seed fits.

This file is the contract between parallel workstreams. If you must deviate, keep the change
backward compatible and say so in your final report.

## Decisions (already agreed — do not re-open)

- Old UI is preserved as `frontend/analysis.html` (uses `frontend/js/main.js`, unchanged). The new
  Blink UI becomes `frontend/index.html`. A patch in Blink links to the analysis view for the same
  position (`analysis.html?ra=..&dec=..&fov=..`).
- No 3D. Sphere view = directions on the celestial sphere only. Distance appears only as text in
  hover cards when Gaia has a parallax.
- Default view: modelled sky (background + fitted sources as glows). Technical options (under
  "Advanced options"): Raw pixels, Leftover (data − model), and the **Unknown-mover search**
  checkbox (off by default, runs on demand, cached, results are "candidates" with confidence and a
  dashed ring).
- Known asteroids (SkyBoT) and faint fixed stars (plain stacking) are part of the default view.
- Single mission: SPHEREx only. Do not build NEOWISE/ZTF buttons.
- Spec bands map exactly to SPHEREx detectors D1–D6. A patch plays **one detector (band) at a time**.
- Default patch width is **0.5°** (spec says 1°; 1° and above download several GB at SPHEREx row-read
  cost). Options: 0.25, 0.5, 1, 2, 3.5. Show a "large field — slow" note for ≥ 1°.
- Real cadence: frames are clumped into visits (epochs) months apart. The frame strip and time label
  use real MJDs; playback must cope with 1–N frames.

## Coordinates and units (everywhere)

- Grid: north-up TAN, `npix × npix`, row 0 = north, column 0 = east (so drawing col 0 at the left
  gives east-left). Pixel centres at integer coordinates; centre `c = (npix-1)/2`.
- Source positions `x` (column), `y` (row) are in these grid pixel units, floats, 0-based.
- Image values: IMAGE − ZODI in MJy/sr (as today). NaN = no data.
- Angles in degrees, times MJD, rates arcsec/hour, position angle measured north through east.

## Backend: `/api/stream` extensions (owner: backend-stream workstream)

All existing parameters and behaviour stay the same when the new parameters are absent.

- `FOV_MAX_DEG` → 3.5. `NPIX_MAX` stays ≈1001; clients pick `scale = max(6.15, fov*3600/1000)`.
- When `scale` is coarser than native (6.15″) the resampling must **anti-alias** (area-average /
  pre-smooth), not point-sample with bilinear.
- New `per_visit=N` (optional int): keep at most N frames per (detector, visit) cluster, spread
  evenly in time. Visit clustering: gap > 20 days starts a new visit (same as `EPOCH_GAP` in
  `frontend/js/data.js`). Applied before `max_frames`.
- New `model=1` (optional): the `start` record gets `"model": true`, and each ok `frame` record gets
  a `"model"` object, and the binary payload gains two planes:

  payload = image f32 LE (npix²) | flags u32 LE (npix²) | background f32 LE (npix²) | leftover f32 LE (npix²)

  where `background` is the smooth diffuse-light map and `leftover = image − background − Σ sources`.

  ```json
  "model": {
    "psf_fwhm_px": 1.9,          // PSF FWHM used, in grid pixels
    "noise": 0.012,              // robust per-pixel sigma of leftover, MJy/sr
    "quality": 1.04,             // leftover RMS / expected noise; ≈1 means the model explains the data
    "sources": [
      {"id": 0, "x": 101.32, "y": 55.80, "sx": 0.08, "sy": 0.09,
       "amp": 3.21, "flux": 11.8, "flux_err": 0.21, "snr": 56.0,
       "kind": "point",            // "point" | "extended"
       "fwhm": 1.9,                // px; > psf for extended
       "blend": null,              // integer group id when fitted jointly with neighbours
       "saturated": false,
       "cat": {"catalog": "gaia", "id": "Gaia DR3 1234", "mag": 14.2, "sep_arcsec": 0.6,
               "parallax_mas": 3.1, "pmra": -12.0, "pmdec": 4.0}   // or null
      }
    ]
  }
  ```
  `flux` = integrated model flux in image units × pixels (MJy/sr·px); `amp` = peak MJy/sr.
- Fitting uses catalogue priors (Gaia DR3 + CatWISE positions propagated to the frame epoch) to
  deblend overlaps; sources without a prior are fitted freely (that is how movers get found).
- Model results are cached on disk keyed by (cutout key, grid, model version).

## Backend: `sources.py` (owner: source-fitting workstream) — pure, no I/O

```python
@dataclass
class Prior:
    x: float; y: float                 # grid px at frame epoch
    cat: dict                          # the "cat" object above (catalog, id, mag, ...)

@dataclass
class FrameModel:
    sources: list[dict]                # exactly the source dicts above (cat filled from priors)
    background: np.ndarray             # float32 npix×npix
    leftover: np.ndarray               # float32 npix×npix
    psf_fwhm_px: float
    noise: float
    quality: float

def fit_frame(img: np.ndarray, bad: np.ndarray | None, psf_fwhm_px: float,
              priors: list[Prior] | None = None, *, nsigma: float = 5.0,
              max_sources: int = 2000) -> FrameModel: ...

def match_catalog(sources: list[dict], priors: list[Prior], max_sep_px: float) -> None: ...
```
`img` is the resampled grid image (NaN = no data), `bad` a boolean mask of pixels to ignore.

## Backend: movers (owner: movers workstream) — `movers.py` + `movers_api.py` (FastAPI `APIRouter`)

- `GET /api/movers/known?ra&dec&fov&scale&detectors&mjd_min&mjd_max&max_frames&per_visit`
  → known solar-system objects from IMCCE SkyBoT, with a predicted grid position for every selected
  frame id, and a shift-and-stack measurement along each path:
  `{"objects":[{"name","number","class","vmag","rate_arcsec_h","pa_deg",
     "positions":[{"frame_id","mjd","x","y"}], "stack":{"snr","detected"}}], "source":"skybot"}`
- `GET /api/movers/linked?...same params...` → mover candidates from linking per-frame fitted sources
  that have no static counterpart:
  `{"movers":[{"id":"M1","rate_arcsec_h","pa_deg","confidence","positions":[{"frame_id","mjd","x","y","flux"}]}]}`
- Unknown-mover blind search (shift-and-stack over a velocity grid), background job:
  `GET /api/movers/search/start?...same params...` → `{"job":"<id>","cached":bool}`
  `GET /api/movers/search/status?job=<id>` → `{"state":"running|done|error|cancelled","progress":0..1,
     "tried":int,"total":int,"candidates":[{"id":"C1","rate_arcsec_h","pa_deg","confidence","snr",
     "positions":[{"frame_id","mjd","x","y"}]}]}` (candidates grow while running)
  `GET /api/movers/search/cancel?job=<id>`
  Results cached on disk per field+params.
- `GET /api/coverage` → fields that already have cached frame lists (instant to open):
  `{"fields":[{"ra","dec","n_frames"}]}` (owner: backend-stream workstream).

## Frontend: renderer `frontend/js/blink/skygl.js` (owner: renderer workstream)

WebGL2, with a Canvas2D fallback. No framework. ES module.

```js
export class SkyRenderer {
  constructor(canvas)                  // owns the canvas; sizes to device pixels on resize()
  resize()                             // read clientWidth/Height × devicePixelRatio
  setGrid(npix)
  setFrame(id, { img, background, leftover, sources, psfFwhmPx })   // Float32Arrays; upload lazily
  dropFrame(id)
  setView({ cx, cy, pxPerData })       // data px at canvas centre; CSS px per data px
  fit(cover = true)                    // choose view so the grid covers (true) / fits (false) canvas
  render({
    a, b, t,                           // frame ids and crossfade 0..1 (b may be null)
    mode,                              // 'video' | 'blink' | 'diff' | 'trail'
    layer,                             // 'model' | 'raw' | 'leftover'
    lim, stretch,                      // {lo,hi} MJy/sr; 'linear'|'asinh'|'log'
    tint,                              // [r,g,b] 0..1 band tint for glows
    trail,                             // ordered ids up to the current frame (trail mode)
    prev,                              // previous frame id (diff mode)
  })
  toScreen(x, y) / toData(sx, sy)      // CSS px <-> grid px
  sourceAt(sx, sy, frameId, radiusCss = 10) // nearest drawn source dict(s) under the cursor (array)
}
```
- Raw/leftover/background images: **bicubic (Mitchell–Netravali B=C=1/3)** sampling of the float
  data in the shader, stretch and colour applied **after** interpolation. Black point maps to the
  ground colour `#05070B`.
- `layer:'model'`: background layer (bicubic) + sources as soft glows (instanced quads). Glow core
  size grows with log(flux); blur/softness grows with position uncertainty (`sx, sy`), so faint
  stars read as soft dim smudges. Extended sources use their `fwhm`.
- `mode:'diff'`: current − previous on the `#171A20` ground, symmetric limits.
  `mode:'trail'`: running stack up to the current frame.

## Frontend: Blink shell (owner: shell workstream)

`frontend/index.html`, `frontend/css/blink.css`, `frontend/js/blink/*.js` (except `skygl.js`),
`frontend/dev/mock_server.py` (extend it for `model=1`, `per_visit`, large fov and the movers/coverage
endpoints with synthetic data). Follows `docs/blink-ui-spec.md` sections 2–8 and 11, with the
deviations listed above. Sphere view = Aladin Lite (pinned `aladin-lite@3.8.2`, see
`frontend/js/context.js`). Streaming uses `frontend/js/api.js` (extend `streamFrames` to read the
two extra planes when `start.model` is true; keep the old behaviour otherwise).

Hover card (patch view): name/ID, type (star / extended / asteroid / mover candidate / unmatched),
measured brightness, Gaia distance (1/parallax) when present, motion for movers; for blends list
every fitted source under the cursor. Label "Rendered from measurements" in the header area
(replaces the spec's "SIMULATED IMAGERY"). Unexplained-light markers where `quality` is high
locally (from the leftover) with the hint "Possible faint object — try Advanced options".
