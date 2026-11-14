# SPHEREx sky viewer

A small web tool for the NASA Space Apps "SPHEREx sky viewer" challenge. Give it a position on the sky (RA/Dec, or an object name) and it shows the SPHEREx infrared images of that patch over time, so that moving and variable objects stand out. It also gives a quick-look light curve and spectrum at any position.

The app has two pages:

- `/` is **Blink**, a full-window sky viewer. It opens on the whole sky. Click a spot, or enter coordinates, to fly into a patch and play its frames.
- `/analysis.html` is the earlier pixel viewer. It shows every frame of a patch as a time series, with photometry, light curve and spectrum at a position.

Blink draws the sky from measurements: each frame is fitted with point sources and a smooth background, and the picture is drawn from those fits. Raw pixels and Leftover (data minus model) are available under Advanced options. The unknown-mover search is an opt-in checkbox.

The browser cannot talk to the IRSA archive directly because IRSA sends no CORS headers. This repo therefore has two parts:

- `backend/spherex_app/` is a FastAPI service. It finds frames (IRSA TAP), downloads cutouts and keeps only the parts it needs, then resamples them onto a north-up grid and streams them to the browser. It also does photometry, name resolution, catalogue overlays, source fitting and moving-object search.
- `frontend/` is a static site served by the backend: `index.html` (Blink), `analysis.html` (analysis view), and the `js/blink/` modules described below.

## Run

Requires [uv](https://docs.astral.sh/uv/). From the repo root:

```sh
uv run uvicorn spherex_app.main:app --app-dir backend --port 8000
```

Then open http://localhost:8000/ (Blink) or http://localhost:8000/analysis.html. The API is under `/api/`, and interactive docs are at `/docs`.

Tests (offline and fast; some use a sample cutout and are skipped if it is absent):

```sh
uv run pytest
```

## Configuration

All URLs and tunables are in `backend/spherex_app/config.py`. Most of them can be overridden by environment variables:

| variable | default | meaning |
|---|---|---|
| `SPHEREX_CACHE_DIR` | `.cache/` at repo root | disk cache (cutouts, frame lists, wavelength tables, catalogues) |
| `SPHEREX_CUTOUT_SOURCE` | `s3` | where cutout pixels come from first: `s3` (Range reads of the public S3 mirror) or `irsa` (IRSA cutout service); the other one is the automatic fallback |
| `SPHEREX_S3_CONCURRENCY` | 12 | frames read from S3 at once |
| `SPHEREX_S3_MAX_CONNECTIONS` | 48 | HTTP/1.1 connection pool for S3 |
| `SPHEREX_S3_WAVE_CONCURRENCY` | 3 | small calibration reads, scheduled independently of queued frame downloads |
| `SPHEREX_S3_RETRY_ATTEMPTS` | 3 | attempts for transient S3 failures; missing files fall back immediately |
| `SPHEREX_FRONTEND_DIR` | `frontend/` | static files served at `/` (may be absent) |
| `SPHEREX_IRSA_CONCURRENCY` | 6 | max parallel requests to IRSA |
| `SPHEREX_CPU_CONCURRENCY` | 3 | parallel frame-processing threads |
| `SPHEREX_RETRY_ATTEMPTS` | 10 | attempts per IRSA request (capped exponential backoff) |
| `SPHEREX_HTTP_READ_TIMEOUT` | 300 s | read timeout for slow synchronous TAP and other non-S3 requests |
| `SPHEREX_TAP_TTL` | 600 s | in-memory lifetime of a frame list |
| `SPHEREX_FRAMES_DISK_TTL` | 6 h | a frame list on disk younger than this is used without asking TAP |
| `SPHEREX_FRAMES_STALE_MAX` | 7 days | an older one (up to this age) is served at once and refreshed in the background |
| `SPHEREX_LOG_LEVEL` | INFO | `DEBUG` shows every upstream retry |
| `SPHEREX_IRSA_BASE` | `https://irsa.ipac.caltech.edu` | IRSA base URL (TAP and cutout service) |
| `SPHEREX_S3_BASE` | `https://nasa-irsa-spherex.s3.amazonaws.com/` | public S3 mirror of the Level-2 files |
| `SPHEREX_SESAME_URL` | CDS Sesame endpoint | object name resolver used by `/api/resolve` |
| `SPHEREX_GAIA_TAP` | ESA Gaia TAP sync endpoint | Gaia DR3 catalogue queries |
| `SPHEREX_RETRY_BACKOFF` | 0.5 s | first delay between IRSA retries (capped exponential backoff) |
| `SPHEREX_RESOLVE_TTL` | 86400 s | in-memory lifetime of a name resolution |
| `SPHEREX_CATALOG_TTL` | 30 days | cache lifetime of catalogue overlays and priors |

The cache is safe to delete at any time.

### Pre-warming the cache

`backend/scripts/prewarm.py` loads targets the same way the page does: it resolves the name, propagates a moving target to epoch 2026.0, rounds the centre to seven decimals, and calls `/api/stream` with fov 0.1, scale 6.15, all detectors and cap 400 (no `per_visit` and no `model`). Both the centre and the quantized cutout size (0.15 degrees) therefore match the app's cache keys. This warms frames and cutouts only. Blink's default patch width is 0.5 degrees, so warm with `--fov 0.5` for Blink, and `model=1` results are not warmed. The command exits nonzero if any target or frame fails.

```sh
uv run python backend/scripts/prewarm.py                    # Barnard's Star, eps Ind B, WISE 0855, RW Aur, R Dra at fov 0.1
uv run python backend/scripts/prewarm.py --fov 0.2 "RW Aur"  # other targets / field sizes
uv run python backend/scripts/prewarm.py --server http://localhost:8000   # warm a running server
```

It uses the same `SPHEREX_CACHE_DIR` as the server. A ~260-frame field used 0.71 GB of S3 traffic and roughly 46–50 s of download/processing time at fov 0.1, plus a much slower synchronous TAP query on a completely cold cache. Run prewarm before a demo. On 2026-11-14 the complete command was verified for all five targets against an existing populated cache: 358 / 400 / 258 / 335 / 400 frames, zero failures, 44.9 s total, and no cutout downloads. This is a cache-hit verification, not a cold-prewarm measurement.

## API summary

All angles are ICRS degrees and times are MJD. Proper motions are in mas/yr with pmra = μα·cosδ, and `epoch` is a Julian year. Errors come back as non-2xx responses with a body of `{"detail": "..."}`. In short:

- `GET /api/health` returns `{"ok": true}`.
- `GET /api/resolve?q=` resolves coordinates in any common format, or an object name via CDS Sesame/SIMBAD. Positions with a proper motion are at epoch 2000.0.
- `GET /api/frames?ra&dec` lists all SPHEREx frames covering the position (metadata only).
- `GET /api/stream?ra&dec&fov=0.1&scale=6.15&detectors=1,…,6&mjd_min&mjd_max&max_frames=400&pmra&pmdec&epoch&per_visit&model=0` returns a binary stream of length-prefixed JSON records plus image payloads, one per frame, in completion order. `fov` is in degrees, from 0.01 to 3.5. Each image is IMAGE − ZODI in MJy/sr, resampled onto a north-up TAN grid (row 0 = north, column 0 = east), followed by its flag plane. Each frame also carries metadata, the wavelength at the field centre, and quick-look photometry of the (optionally moving) target.
  - `per_visit=N` keeps at most N frames for each (detector, visit) pair, spread evenly in time. A gap of more than 20 days starts a new visit. It is applied before `max_frames`.
  - `model=1` fits a source model to each frame. The `start` record then has `"model": true`, and each ok frame record has a `model` object: `psf_fwhm_px`, `noise`, `quality` (leftover RMS over expected noise; about 1 means the model explains the data) and a `sources` list. Each source has a position `x`, `y` in grid pixels, `flux`, `flux_err`, `snr`, `kind` (`point` or `extended`), `saturated` and a `cat` match or `null`. The payload gains two planes after the flags: background (the smooth diffuse light) and leftover (image − background − sources), both float32.
- `GET /api/spectrum?ra&dec&fov&pos_ra&pos_dec&…&aper=2` returns per-frame aperture photometry at a position, with the wavelength each frame saw there. That is a spectrum and light curve in one. It uses the same frame selection as `/api/stream` and so reuses its cached cutouts. The response also includes a `failed` count of frames that could not be fetched.
- `GET /api/catalog?cat=gaia|catwise&ra&dec&radius` returns Gaia DR3 or CatWISE2020 sources for overlays, with proper motions in mas/yr and the epoch of each catalogue position.
- `GET /api/coverage` returns the fields that already have cached frame lists, as `{"fields":[{"ra","dec","n_frames"}]}`. Those fields open instantly.

Moving-object endpoints. They take the same parameters: `ra`, `dec`, `fov` (default 0.1), `scale` (default 6.15), `detectors` (default `1,2,3,4,5,6`), `mjd_min`, `mjd_max`, `max_frames` (default 400) and `per_visit`.

- `GET /api/movers/known?…` returns known solar-system objects from IMCCE SkyBoT. Each object has a predicted grid position for every selected frame and a shift-and-stack measurement along its path. SkyBoT is queried for the geocentre.
- `GET /api/movers/linked?…` returns mover candidates made by linking per-frame fitted sources that have no static counterpart.
- `GET /api/movers/search/start?…` starts the unknown-mover blind search (shift-and-stack over a velocity grid) as a background job. It returns `{"job","cached"}`. Results are cached on disk per field and parameters.
- `GET /api/movers/search/status?job=` returns `state` (`running`, `done`, `error` or `cancelled`), `progress`, `tried`, `total` and the candidates found so far.
- `GET /api/movers/search/cancel?job=` cancels a running search.

## Frontend layout

The Blink page is an ES module app with no framework. Its code is in `frontend/js/blink/`:

- `app.js`: the Blink shell. It owns the view state, UI visibility and fly-to flights, and wires the sphere, patch and DOM controls.
- `sphere.js`: the sphere view, Aladin Lite full-window with all chrome hidden. It falls back to a dark ground when the library or the HiPS tiles are unreachable.
- `patch.js`: the patch view. It handles streaming, playback, driving the renderer, overlays and pointer interaction.
- `skygl.js`: `SkyRenderer`, the WebGL2 renderer (bicubic float images and source glows) with a Canvas2D fallback.
- `fly.js`: camera animations between the sphere and a patch.
- `movers.js`: moving-object data for known objects (SkyBoT), linked candidates and the blind search.
- `analysis.js`: display limits, locked across frames, and the unexplained-light finder.
- `hover.js`: hover card contents for the patch view.
- `util.js`: small shared helpers for maths, coordinate parsing and formatting, and URL state.

Blink also uses `frontend/js/api.js` (streaming, including the model planes), `frontend/js/wcs.js` and `frontend/js/data.js`.

## How it works

- **Frame discovery** runs one ADQL query against IRSA TAP (`spherex.artifact` ⨝ `spherex.plane`, `CONTAINS(POINT, poly)`). The query is not tied to a data release. If one observation and detector appear under several releases or processing versions, the newest is kept. Live synchronous queries on 2026-11-14 took 154.3 s for WISE 0855 (258 frames) and 128.9 s for R Dra (2,494 frames). Removing unused columns and server-side sorting still took 135.2 s on WISE. Frame lists are therefore kept on disk (see `SPHEREX_FRAMES_*` above); disk reads took 1.2 ms and 17.1 ms respectively. No asynchronous TAP jobs are used.
- **Cutouts** are cut by the backend itself from the full Level-2 files on the public S3 mirror (`nasa-irsa-spherex.s3.amazonaws.com`), using HTTP Range requests. The file layout is: an empty primary; IMAGE, float32 2040×2040, uncompressed; FLAGS, int32 stored RICE_1 tile-compressed with **one tile per image row**; VARIANCE and ZODI, float32, uncompressed; then the EPSF and WCS-WAVE tables. Header sizes and the FLAGS heap size differ from file to file. For the common layout each frame needs 8 requests in 2 round trips (layout variations can require additional reads): it reads the IMAGE header (full-frame SIP WCS) and the FLAGS tile index, then the needed rows of each plane, one range per plane. It reproduces IRSA's cutout box exactly (Cutout2D semantics: SIP centre, `round(size/scale)` pixels, edges `ceil(c ± n/2)`, clipped at the detector edge), decodes only the needed FLAGS tiles, and shifts every `CRPIXn`/`CRPIXnA`/`CRPIXnW`. The result is **byte-identical** to IRSA's own cutout, checked on 14 frame/size combinations across detectors 1, 3 and 6 at WISE 0855, high-declination R Dra, and a detector corner, so the rest of the code cannot tell the two sources apart. The cost is bandwidth: whole detector rows are read, about 2.7 MB per frame at fov 0.1 versus about 0.2 MB from IRSA. The initial fov 0.1 S3 benchmark completed without upstream retries; retries remain enabled for transient failures. Every range offset and length is checked; ignored Range responses are closed immediately, and unsupported layouts fall back to IRSA. FLAGS descriptors and cutout structure are validated before caching. If S3 fails (for example, a file is not mirrored yet), that frame falls back to IRSA's cutout service. IRSA ignores Range, so its stream is parsed as it arrives and dropped after the ZODI HDU. `SPHEREX_CUTOUT_SOURCE=irsa` reverses the order. Either way the cutout bytes are cached on disk, keyed by file URI, centre and size. The cutout is about 1.45× the requested field of view so that a north-up square is filled at any detector roll.
- **Wavelength:** SPHEREx uses linear variable filters, so every detector pixel sees a different wavelength and a given sky position has a different wavelength in each frame. The backend evaluates the `WAVE-TAB` alternate WCS by bilinear lookup in the `WCS-WAVE` table. That table is a per-detector calibration, fetched once per (detector, processing version) with a small suffix Range request to the public S3 mirror and then cached. The lookup is checked against astropy's own `-TAB` implementation in the tests and live comparisons (maximum difference 8.9e-16 micrometres). Calibration reads have their own bounded queue so the first frame need not wait for every cutout to download.
- **Resampling** is bilinear for pixels and nearest-neighbour for flags, using the SIP WCS. No-data pixels are NaN.
- **Photometry** is quick-look only. It uses a circular aperture (fractional pixels) on the native cutout pixels, a sigma-clipped median background in a 4–7 px annulus, and errors from the VARIANCE plane plus background scatter. Results are converted from MJy/sr to mJy with the local pixel solid angle (about 0.889 mJy per MJy/sr per pixel). **No aperture correction is applied**, so fluxes of point sources are underestimates by the fraction of the PSF outside the aperture. That fraction depends on detector and wavelength. A point is marked `bad` if a serious pixel flag (saturation/overflow, transient, hot/cold, nonlinear, persistence, outlier, missing data and similar) is set inside the aperture, or if the result is not finite. Very bright stars, roughly K < 8, are saturated and come out `bad`.

## New data releases

Nothing needs to change when IRSA ingests new SPHEREx data or a new release (`qr2` → `qr3` → `dr1` → …). The frame query is release-agnostic, and disk frame lists are fresh for 6 h (an existing in-memory hit can add up to 10 min before the next disk-age check). A list served stale (up to 7 days) is refreshed in the background, so the next request sees the new data. All 258 distinct URIs returned by a fresh WISE 0855 TAP query were checked with S3 HEAD on 2026-11-14; every one returned 200. This is a snapshot check, not a guarantee about future mirror lag. Files that are missing from the mirror fall back to IRSA. Newer releases and processing versions automatically replace older ones for the same observation. New processing versions get their wavelength tables fetched on first use. Cached cutouts are keyed by the full file URI, so reprocessed files are downloaded fresh.

## Known limitations

- IRSA TAP is slow. Fresh frame queries took roughly two to five minutes in this audit. A cold view therefore spends much of its time waiting for the frame list. Revisits within 6 h skip TAP entirely, and visits within 7 days get an instant answer while the list is refreshed in the background.
- Cold-load speed depends on bandwidth and archive load; see the measured comparison below. Frames that fail on both sources are reported as failed in the stream and fetched again on the next request. S3 reads complete detector rows, so traffic grows roughly linearly with cutout height even for a narrow field.
- Photometry has no aperture correction and is not suitable for blended sources or very bright stars.
- The source model uses a circular Gaussian PSF, so very bright stars leave ring residuals in the leftover.
- Catalogue priors are limited to Gaia G ≤ 19 and a capped count (`PRIOR_MAX` = 3000). Many faint stars are therefore fitted as unmatched free detections.
- SkyBoT positions are geocentric. Main-belt objects carry a parallax error of a few arcseconds, and near-Earth objects more.
- Large patches (1° and above) download several GB, because the S3 reader fetches whole detector rows.

## Download benchmark (2026-11-14)

WISE 0855 at (133.795129, −7.245147), 258 frames, all detectors, real `/api/stream` on port 8771. Each run started with a separate empty cache. Times include synchronous TAP; downloaded MB counts consumed upstream response bodies, including fallback traffic.

| fov | primary | cold wall (s) | first frame (s) | TAP (s) | after TAP (s) | downloaded MB | failed frames | fallback frames | retries |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.1 | s3 | 200.7 | 153.4 | 150.7 | 50.0 | 711.1 | 0 | 0 | 0 |
| 0.1 | irsa | 234.5 | 141.4 | 139.2 | 95.3 | 200.0 | 0 | 58 | 1267 |
| 0.3 | s3 | 254.7 | 134.3 | 123.5 | 131.2 | 2029.5 | 0 | 0 | 8 |
| 0.3 | irsa | 456.3 | 302.5 | 297.7 | 158.6 | 298.0 | 0 | 0 | 157 |

IRSA-primary uses S3 automatically after its retries are exhausted; fallback frames would otherwise have failed. These are individual runs, so compare the after-TAP column as well as total time. S3 remains the default for the normal 0.1-degree view; large fields consume much more bandwidth. Range-reading all four planes was byte-identical to IRSA in 14 live frame/size comparisons, including detector edges.

With frame metadata already cached but pixels and wavelength tables cold, the final-code fov 0.1 check took 46.4 s (first frame 5.4 s) through S3, versus 78.8 s (first frame 1.7 s) through IRSA; both persisted all 258 cutouts with zero failed frames. The cold IRSA fov 0.3 run exhausted the temporary scratchpad quota after 194 cached cutouts: all frames were delivered, but 64 entries did not persist. Its timing includes those failed cache-write attempts. Cache write failures now log a warning and remove partial temporary files; existing cache entries remain intact. The repository cache was not removed.
