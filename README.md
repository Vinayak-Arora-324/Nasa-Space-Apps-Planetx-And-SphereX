# SPHEREx Space Maps — Sky Viewer & Moving-Object Hunter

Built for the NASA Space Apps Challenge (Planet Nine / SPHEREx sky viewer).

SPHEREx maps the entire sky across 102 infrared spectral channels over repeated visits. Comparing single FITS files by hand makes it hard to tell what changed between visits—especially faint asteroids, distant moving bodies, or high-proper-motion brown dwarfs. **Space Maps** lines up every SPHEREx exposure covering a spot on the sky onto one north-up grid and plays them back like a time-lapse clip, so anything that moves or varies jumps straight out against the background stars.

---

## Team & Submission

- **Team Name:** Star Maps
- **Challenge:** Planet X and SPHEREx


## What It Does

### 1. Space Maps (`/`) — Full-Sky Viewer & Time-Lapse Patch Player
- **Whole-sky entry:** Opens on an interactive full-sky sphere (Aladin Lite). Click any patch of sky, jump to built-in presets (Ecliptic Poles, Orion Nebula, Barnard's Star, WISE 0855, etc.), or resolve an object name via CDS Sesame to zoom straight into that patch.
- **Play the sky in four modes:** Streamed frames from NASA IRSA / AWS S3 are resampled to a common north-up tangent grid and played as:
  - **Video** (smooth time interpolation across exposures)
  - **Blink** (hard frame-to-frame cuts)
  - **Difference** (frame minus previous frame, cancelling static stars)
  - **Trails** (running residual stack so movers draw paths across frames)
- **When each photo was taken:** The player shows the UTC date and time of the exposure on screen (and how long ago that was). A time slider lays out every exposure on a broken time axis: one segment per SPHEREx visit with the real spacing between exposures inside it, and the months between visits cut down to a labelled gap (“+6 mo”). Drag or use the arrow keys to scrub (Page Up/Down jumps between visits). Click a visit’s date to loop only that visit.
- **Measured Sky vs. Raw Pixels vs. Leftover:** Rather than showing noisy raw detector cutouts alone, the backend fits each frame's smooth diffuse background and point/extended sources (seeded with Gaia DR3 and CatWISE2020 priors). Frames stream pixels first and crossfade as models finish, letting you toggle between **Measured sky**, **Raw pixels**, and **Leftover** (data minus model) to isolate faint unmodeled sources.
- **Moving-Object Tools:** Automatically overlays known solar-system objects from IMCCE SkyBoT, links unassociated per-frame detections into mover candidates, and supports an opt-in blind shift-and-stack search (`search/start`) across velocity vectors. Hovering over any source or ringed mover displays its fitted brightness (in mJy/µJy), S/N, catalogue ID, distance, and motion rate.

### 2. Turn Back the Sky (Solar/Stellar Time Rewind)
Right from the main sky view, **Turn back the sky…** lets you set a latitude, longitude, solar time, and any date from `15,000 BCE` to `15,000 CE`. It rotates the SPHEREx sky map into the local horizon frame using long-term precession (`Vondrák, Capitaine & Wallace 2011`) while moving 3,114 bright and high-proper-motion stars from Hipparcos/XHIP (`frontend/data/rewind-stars.json`) through 3D space.
It also shows all 88 constellations (figures, names and IAU boundaries, from d3-celestial), the Sun, the Moon with its phase and the planets (ERFA `eraPlan94`/`eraMoon98`, checked against JPL DE441), daylight and twilight, eclipses, and labels for bright galaxies, clusters and nebulae. A "Show on the sky" control switches each layer on or off. Far from today the Moon's position is uncertain by degrees because Earth's past rotation (ΔT) is not known precisely. The view says so and draws a dotted arc for the range.

### 3. Diagnostic Analysis Workbench (`/analysis.html`)
A 7-panel detailed view for inspecting individual detector exposures (`D1`–`D6`), co-added epoch stacks, RGB false-color composites, Gaia/CatWISE proper-motion overlays, and click-anywhere aperture photometry—plotting both the spectrum (evaluated via SPHEREx's `WCS-WAVE` lookup tables) and light curve together with quality-flag diagnostics and CSV export.

---

## Running Locally

### Live Backend (Connects to IRSA, AWS S3, Gaia, CatWISE & SkyBoT)

Requires Python `>= 3.11` and [`uv`](https://docs.astral.sh/uv/). From the repository root:

```sh
uv run uvicorn spherex_app.main:app --app-dir backend --port 8000
```

Open:
- **Space Maps viewer:** http://localhost:8000/
- **Analysis view:** http://localhost:8000/analysis.html
- **FastAPI docs:** http://localhost:8000/docs

> **Note on cold start & caching:** The browser cannot query IRSA directly because IRSA does not send CORS headers, so `backend/spherex_app/` proxies requests, performs HTTP byte-range reads against NASA's public S3 SPHEREx mirror (`nasa-irsa-spherex.s3.amazonaws.com`), and caches results in `.cache/`. A brand-new uncached coordinate query waits 2–5 minutes for IRSA TAP to return its exposure list. To make demo fields load instantaneously before a presentation, pre-warm `.cache/`:
> ```sh
> uv run python backend/scripts/prewarm.py --blink
> ```

### Quick Offline Preview (No Waiting / No Network Needed)

If you want to try the Space Maps WebGL2 viewer, frame playback, spectral bands, and moving-object overlays immediately without waiting on live IRSA TAP queries, start the included synthetic mock server:

```sh
uv run python frontend/dev/mock_server.py 8799
```

Then open http://localhost:8799/ (for example http://localhost:8799/?ra=180&dec=0) to test multi-visit playback (`18 exposures in 3 visits`), progressive models, and simulated movers (`Ceres`, `M1`, `C1`).

---

## Project Structure

```text
backend/
  spherex_app/     FastAPI backend: IRSA TAP discovery, S3 range cutout reader,
                   WCS-WAVE calibration, source/background fitter, movers & cache
  scripts/         prewarm.py, warm_coverage.py, build_rewind_stars.py,
                   build_rewind_sky.py
  tests/           Offline unit and API contract tests (pytest)
frontend/
  index.html       Space Maps main app
  analysis.html    7-panel diagnostic photometry & spectrum viewer
  js/blink/        Framework-free ES modules (WebGL2 SkyRenderer, PatchView,
                   Sphere, Rewind, skytime astrometry, ephem Sun/Moon/planets,
                   Movers, Hover cards)
  dev/             Synthetic mock_server.py and canvas fallback stub
  tests/           Frontend math, streaming, and renderer tests (node --test)
docs/              Architecture notes, UI spec, and deep technical reference
```

---

## Running Tests

Backend suite (offline tests run fast; live-network integration tests marked `online` are skipped by default):

```sh
uv run pytest
```

Frontend suite (Node.js built-in test runner):

```sh
node --test frontend/tests/skygl.test.mjs frontend/tests/skytime.test.mjs frontend/tests/stream.test.mjs
```

---

## Further Documentation

- [Technical Reference](docs/technical-reference.md) — Environment variables, cache layout, IRSA/S3 cutout details, API endpoint contracts, benchmarks, and known limitations.
- [Space Maps Architecture](docs/blink-architecture.md) — Streaming record format, source fitting contract, and renderer pipeline.
- [Space Maps UI Spec](docs/blink-ui-spec.md) — Interaction design and visual specification.

---

## License

Released under the [MIT License](LICENSE).
