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
| `SPHEREX_CATALOG_READ_TIMEOUT` | 900 s | read timeout of a catalogue TAP query (uncached CatWISE queries can take more than 400 s) |
| `SPHEREX_CATALOG_RETRY_ATTEMPTS` | 2 | attempts per catalogue TAP query |
| `SPHEREX_CATALOG_FAIL_TTL` | 600 s | a catalogue query that failed is not retried for this field for this long (in memory) |
| `SPHEREX_PRIOR_WAIT` | 0 s | how long a model stream waits for a catalogue that is not cached yet before fitting without it |
| `SPHEREX_FIT_CONCURRENCY` | = `SPHEREX_CPU_CONCURRENCY` | parallel source-model fits, limited separately from frame processing |

The cache is safe to delete at any time.

### Pre-warming the cache

`backend/scripts/prewarm.py` loads targets the same way the pages do, so its centres and the quantized cutout size match the app's cache keys. There are two kinds of target:

- **Analysis-page targets** (Barnard's Star, eps Ind B, WISE 0855, RW Aur, R Dra): the name is resolved, a moving target is propagated to epoch 2026.0 and the centre is rounded to seven decimals. The proper motion is sent with the stream request.
- **Blink presets** (North and South Ecliptic Poles, Orion Nebula, Galactic Centre, Barnard's Star, ε Indi B, WISE 0855, R Draconis): centred exactly as `frontend/js/blink/app.js` does (fixed coordinates, high proper-motion stars propagated from 2000.0 to 2026.0), with no proper motion in the request, as Blink sends it.

Options match what Blink requests: `--width` (alias `--fov`), `--band` (detectors, e.g. `2`), `--per-visit`, and `--model`, which requests `model=1`. Models are cached per frame, field and catalogues used, and shared with Blink's progressive mode, so warming with `model=1` also warms Blink. With `--model`, the script first fetches **both** fit catalogues (Gaia DR3 and CatWISE2020) for every target and waits as long as they take. Fetches for all targets start up front, `--catalog-concurrency` (default 3) at a time. They bypass the server's 10-minute failure cache, so the fits are made with full priors and the first visitor never waits. `--blink` is shorthand for `--width 0.5 --band 2 --per-visit 6 --model` (Blink's defaults) and, with no targets given, warms only the eight Blink presets. Explicit options override it. Each output line reports frames, failures, model cache hits and fits, the catalogues the fits used, and the catalogue wait. The command exits nonzero if any target, frame or catalogue fails.

```sh
uv run python backend/scripts/prewarm.py --blink                       # Blink's eight presets, as Blink opens them
uv run python backend/scripts/prewarm.py --blink --band 3 "WISE 0855"  # another band / one preset
uv run python backend/scripts/prewarm.py                               # analysis targets, then Blink presets, at fov 0.1, no model
uv run python backend/scripts/prewarm.py --fov 0.2 "RW Aur"            # other targets / field sizes
uv run python backend/scripts/prewarm.py --server http://localhost:8000 --blink   # warm a running server
```

It uses the same `SPHEREX_CACHE_DIR` as the server. With `--server`, catalogues are fetched through the server's `/api/catalog`, which joins any catalogue query the server already has running for that field. A ~260-frame field used 0.71 GB of S3 traffic and roughly 46–50 s of download/processing time at fov 0.1, plus a much slower synchronous TAP query on a completely cold cache. Run prewarm before a demo. On 2026-11-14 the earlier five-target fov 0.1 command (the analysis targets only) was verified against an existing populated cache: 358 / 400 / 258 / 335 / 400 frames, zero failures, 44.9 s total, and no cutout downloads. This is a cache-hit verification, not a cold-prewarm measurement.

### Coverage index for cold fields

Opening a field nobody has opened before first spends two to five minutes on the IRSA TAP query that lists its exposures. `backend/scripts/warm_coverage.py` runs only that query, ahead of time, for a list or grid of fields. It downloads no cutouts and fits no models. Each list is cached on disk and indexed, so the field appears as a "ready" marker on Blink's sphere (from `/api/coverage`) and opens without the TAP wait.

```sh
uv run python backend/scripts/warm_coverage.py "10.6847 41.2690" "56.75,24.1167"    # fields as "ra dec"
uv run python backend/scripts/warm_coverage.py --file fields.txt                    # one "ra dec [label]" per line, # comments
uv run python backend/scripts/warm_coverage.py --grid 80 90 -10 0 1                 # RA 80-90, Dec -10-0, ~1 degree apart
uv run python backend/scripts/warm_coverage.py --file fields.txt --dry-run          # show what would be queried
```

A field whose list on disk is younger than `SPHEREX_FRAMES_DISK_TTL` (6 h) is skipped as fresh; `--force` queries it anyway. Older lists are queried again, so a scheduled run also picks up new data releases. `--concurrency` (default 2) limits parallel TAP queries. The script exits nonzero if any field failed.

To run it on a schedule, use the absolute path to `uv`, since cron and systemd have a minimal `PATH` (`command -v uv` prints it). For example, nightly at 03:30 from cron (`crontab -e`):

```cron
30 3 * * *  cd /path/to/repo && /home/you/.local/bin/uv run python backend/scripts/warm_coverage.py --file fields.txt >> /path/to/warm_coverage.log 2>&1
```

Or as a systemd user timer, with `~/.config/systemd/user/spherex-coverage.service`:

```ini
[Unit]
Description=Pre-warm SPHEREx exposure lists

[Service]
Type=oneshot
WorkingDirectory=/path/to/repo
ExecStart=/home/you/.local/bin/uv run python backend/scripts/warm_coverage.py --file fields.txt
```

and `~/.config/systemd/user/spherex-coverage.timer`:

```ini
[Unit]
Description=Pre-warm SPHEREx exposure lists nightly

[Timer]
OnCalendar=*-*-* 03:30
Persistent=true

[Install]
WantedBy=timers.target
```

Enable it with `systemctl --user daemon-reload && systemctl --user enable --now spherex-coverage.timer`, check it with `systemctl --user list-timers` and `journalctl --user -u spherex-coverage`. If you set `SPHEREX_CACHE_DIR` for the server, set the same value here (`Environment=SPHEREX_CACHE_DIR=...` in the service, or in the crontab line). Blink loads `/api/coverage` when the page opens, so new markers appear on the next page load.

## API summary

All angles are ICRS degrees and times are MJD. Proper motions are in mas/yr with pmra = μα·cosδ, and `epoch` is a Julian year. Errors come back as non-2xx responses with a body of `{"detail": "..."}`. In short:

- `GET /api/health` returns `{"ok": true}`.
- `GET /api/resolve?q=` resolves coordinates in any common format, or an object name via CDS Sesame/SIMBAD. Positions with a proper motion are at epoch 2000.0.
- `GET /api/frames?ra&dec` lists all SPHEREx frames covering the position (metadata only).
- `GET /api/stream?ra&dec&fov=0.1&scale=6.15&detectors=1,…,6&mjd_min&mjd_max&max_frames=400&pmra&pmdec&epoch&per_visit&model=0` returns a binary stream of length-prefixed JSON records plus image payloads, one per frame, in completion order. `fov` is in degrees, from 0.01 to 3.5. Each image is IMAGE − ZODI in MJy/sr, resampled onto a north-up TAN grid (row 0 = north, column 0 = east), followed by its flag plane. Each frame also carries metadata, the wavelength at the field centre, and quick-look photometry of the (optionally moving) target.
  - `per_visit=N` keeps at most N frames for each (detector, visit) pair, spread evenly in time. A gap of more than 20 days starts a new visit. It is applied before `max_frames`.
  - `model=1` fits a source model to each frame. The `start` record then has `"model": true`, and each ok frame record has a `model` object: `psf_fwhm_px`, `noise`, `quality` (leftover RMS over expected noise; about 1 means the model explains the data) and a `sources` list. Each source has a position `x`, `y` in grid pixels, `flux`, `flux_err`, `snr`, `kind` (`point` or `extended`), `saturated` and a `cat` match or `null`. The payload gains two planes after the flags: background (the smooth diffuse light) and leftover (image − background − sources), both float32. The `end` record gains `model_stats` (`cached`, `fitted`, and the `priors` catalogues the fits in this stream used).
  - `model=progressive` sends raw pixels first and the model later; Blink uses it. The `start` record has `"model": "progressive"`, and each ok frame record goes out as soon as its pixels are ready, with image and flags only. Later, a `{"type": "model", "id": <frame id>, "model": {…}}` record carries the same model object, followed by the background and leftover planes. Progress and end records count the model records sent (`models`). Both model modes share one model cache.
  - Catalogue priors never delay frames. A cached model is used without any catalogue lookup. A fit uses the catalogues already cached (usually Gaia); a missing one is fetched in the background, one shared query per field, and saved to disk for later loads. A failed query is not retried for 10 minutes. The model cache key records the catalogues a fit used, so a field fitted with Gaia only is refitted once CatWISE is cached, and is otherwise reused.
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
- `rewind.js`: the whole-sky rewind ("Turn back the sky"): horizon camera, the whirl animation, overlays and the controls in the sphere dock.
- `skytime.js`: the rewind's astronomy (calendar, ΔT, long-term precession, Earth rotation, horizon frame, 3-D star motion), with no DOM.

Blink also uses `frontend/js/api.js` (streaming, including the model planes), `frontend/js/wcs.js` and `frontend/js/data.js`.

## How it works

- **Frame discovery** runs one ADQL query against IRSA TAP (`spherex.artifact` ⨝ `spherex.plane`, `CONTAINS(POINT, poly)`). The query is not tied to a data release. If one observation and detector appear under several releases or processing versions, the newest is kept. Live synchronous queries on 2026-11-14 took 154.3 s for WISE 0855 (258 frames) and 128.9 s for R Dra (2,494 frames). Removing unused columns and server-side sorting still took 135.2 s on WISE. Frame lists are therefore kept on disk (see `SPHEREX_FRAMES_*` above); disk reads took 1.2 ms and 17.1 ms respectively. No asynchronous TAP jobs are used.
- **Cutouts** are cut by the backend itself from the full Level-2 files on the public S3 mirror (`nasa-irsa-spherex.s3.amazonaws.com`), using HTTP Range requests. The file layout is: an empty primary; IMAGE, float32 2040×2040, uncompressed; FLAGS, int32 stored RICE_1 tile-compressed with **one tile per image row**; VARIANCE and ZODI, float32, uncompressed; then the EPSF and WCS-WAVE tables. Header sizes and the FLAGS heap size differ from file to file. For the common layout each frame needs 8 requests in 2 round trips (layout variations can require additional reads): it reads the IMAGE header (full-frame SIP WCS) and the FLAGS tile index, then the needed rows of each plane, one range per plane. It reproduces IRSA's cutout box exactly (Cutout2D semantics: SIP centre, `round(size/scale)` pixels, edges `ceil(c ± n/2)`, clipped at the detector edge), decodes only the needed FLAGS tiles, and shifts every `CRPIXn`/`CRPIXnA`/`CRPIXnW`. The result is **byte-identical** to IRSA's own cutout, checked on 14 frame/size combinations across detectors 1, 3 and 6 at WISE 0855, high-declination R Dra, and a detector corner, so the rest of the code cannot tell the two sources apart. The cost is bandwidth: whole detector rows are read, about 2.7 MB per frame at fov 0.1 versus about 0.2 MB from IRSA. The initial fov 0.1 S3 benchmark completed without upstream retries; retries remain enabled for transient failures. Every range offset and length is checked; ignored Range responses are closed immediately, and unsupported layouts fall back to IRSA. FLAGS descriptors and cutout structure are validated before caching. If S3 fails (for example, a file is not mirrored yet), that frame falls back to IRSA's cutout service. IRSA ignores Range, so its stream is parsed as it arrives and dropped after the ZODI HDU. `SPHEREX_CUTOUT_SOURCE=irsa` reverses the order. Either way the cutout bytes are cached on disk, keyed by file URI, centre and size. The cutout is about 1.45× the requested field of view so that a north-up square is filled at any detector roll.
- **Wavelength:** SPHEREx uses linear variable filters, so every detector pixel sees a different wavelength and a given sky position has a different wavelength in each frame. The backend evaluates the `WAVE-TAB` alternate WCS by bilinear lookup in the `WCS-WAVE` table. That table is a per-detector calibration, fetched once per (detector, processing version) with a small suffix Range request to the public S3 mirror and then cached. The lookup is checked against astropy's own `-TAB` implementation in the tests and live comparisons (maximum difference 8.9e-16 micrometres). Calibration reads have their own bounded queue so the first frame need not wait for every cutout to download.
- **Resampling** is bilinear for pixels and nearest-neighbour for flags, using the SIP WCS. No-data pixels are NaN.
- **Photometry** is quick-look only. It uses a circular aperture (fractional pixels) on the native cutout pixels, a sigma-clipped median background in a 4–7 px annulus, and errors from the VARIANCE plane plus background scatter. Results are converted from MJy/sr to mJy with the local pixel solid angle (about 0.889 mJy per MJy/sr per pixel). **No aperture correction is applied**, so fluxes of point sources are underestimates by the fraction of the PSF outside the aperture. That fraction depends on detector and wavelength. A point is marked `bad` if a serious pixel flag (saturation/overflow, transient, hot/cold, nonlinear, persistence, outlier, missing data and similar) is set inside the aperture, or if the result is not finite. Very bright stars, roughly K < 8, are saturated and come out `bad`.

## Turning back the sky

In the sphere view, the **Turn back the sky…** button opens a small form (folded away by default so the dock leaves the sky free for click-to-fly). It shows the sky above a place (Giza by default, or any latitude and longitude) on a chosen night between 15,000 BCE and 15,000 CE, at a local solar time. The sky whirls backwards (or forwards) around the celestial pole while a year counter runs, then stops on that night. Afterwards you can drag to look around, scroll to zoom, or use the arrow keys, and Escape leaves.

- **The SPHEREx map is turned, not redrawn.** Each frame sets Aladin's centre and view rotation so that the ICRS map appears as the horizon view of the place: ICRS → mean equator of date (the Vondrák, Capitaine & Wallace 2011 long-term precession with the ICRS frame bias, ERFA `eraLtpb`) → local sidereal angle (Earth Rotation Angle minus the equation of the origins) → horizon. Precession and Earth rotation are frame rotations, so they are exact for every pixel of the map. The CIO locator *s* is integrated from the same long-term pole, because the IAU 2006 polynomial for *s* is only fitted near J2000 (it is already 280″ by 26 CE).
- **Stars that move against the others** come from XHIP (Hipparcos 2007 astrometry plus radial velocities; 3,114 stars brighter than V = 5 or faster than 400 mas/yr, in `frontend/data/rewind-stars.json`). They are moved in a straight line through space with the light-time and relativistic terms of ERFA `eraStarpm`. Over 2,000 years this puts Barnard's Star 5.0° from its 1991 position, where a straight line on the sky gives 5.8°. Because the map is a 2025 snapshot, each fast star is drawn in gold where it was on the chosen date, with a ring where the map shows it.
- **Checked against ERFA and astropy** (`frontend/tests/skytime.test.mjs`): the precession matrix matches `eraLtpb` to 1e-9″, the Earth Rotation Angle matches `eraEra00`, star positions match `eraPmsafe` to 1 mas at 5000 BCE, 26 CE and 13,700 CE, and altitude/azimuth at Giza agree with astropy's `AltAz` to within 30″ in 2026 and 21″ in 26 CE. The residual is nutation and aberration, which are left out (under 40″ together, a fraction of a screen pixel). Thuban came within 0.1° of the pole in about 2800 BCE; Vega's closest approach in the coming cycle is 5.7° in about 13,600 CE.
- **The whirl is faster than real time.** Each turn stands for many thousands of nights. During the whirl the date, precession and star motions are those of the year shown, but the turn angle is compressed; where it stops is exact. Times are local mean solar time, which fixes Earth's rotation directly (UT), so the uncertainty of ΔT (minutes, 2,000 years ago) does not move the stars. Dates before 15 October 1582 use the Julian calendar.
- **Not modelled:** nutation, annual aberration, atmospheric refraction (about 0.5° at the horizon) and brightness changes. Stars not in the list stay where the 2025 map has them.
- **Cost:** on an AMD Radeon 780M (integrated), a full frame during the whirl (overlay plus Aladin's render) took a median 10 ms (p90 12.7 ms) at 1543×964 pixels, against 1.4 ms for the ordinary sphere view.

The star list is rebuilt from VizieR (CDS, with mirrors as fallback) with:

```sh
uv run python backend/scripts/build_rewind_stars.py
```

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
- The sky rewind turns the 2025 map; only the 3,114 listed stars are moved. Aladin paints tiles it has not loaded yet in flat grey, so a slow connection shows grey patches while the whirl uncovers new sky.

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
