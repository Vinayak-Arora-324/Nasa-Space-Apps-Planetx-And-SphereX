"""All endpoints and tunables in one place. Most can be overridden by environment variables."""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


# --- Locations -------------------------------------------------------------
CACHE_DIR = Path(_env("SPHEREX_CACHE_DIR", str(REPO_ROOT / ".cache")))
FRONTEND_DIR = Path(_env("SPHEREX_FRONTEND_DIR", str(REPO_ROOT / "frontend")))

# --- Remote services -------------------------------------------------------
IRSA_BASE = _env("SPHEREX_IRSA_BASE", "https://irsa.ipac.caltech.edu")
IRSA_TAP_SYNC = IRSA_BASE + "/TAP/sync"
# The public S3 mirror; object key = uri without this prefix
S3_BASE = _env("SPHEREX_S3_BASE", "https://nasa-irsa-spherex.s3.amazonaws.com/")
URI_S3_STRIP_PREFIX = "ibe/data/spherex/"
SESAME_URL = _env("SPHEREX_SESAME_URL", "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/S")
GAIA_TAP_SYNC = _env("SPHEREX_GAIA_TAP", "https://gea.esac.esa.int/tap-server/tap/sync")

FRAMES_ADQL = (
    "SELECT a.uri, p.obsid, p.energy_bandpassname, p.time_bounds_lower, p.time_bounds_upper, "
    "p.time_exposure, p.provenance_version, p.obs_publisher_did "
    "FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid "
    "WHERE 1 = CONTAINS(POINT('ICRS', {ra:.7f}, {dec:.7f}), p.poly) "
    "ORDER BY p.time_bounds_lower"
)
GAIA_ADQL = (
    "SELECT TOP 2000 source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag "
    "FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT('ICRS',ra,dec),"
    "CIRCLE('ICRS',{ra:.7f},{dec:.7f},{r:.6f})) ORDER BY phot_g_mean_mag"
)
#  3D fly-through (/api/scene3d): Gaia DR3 stars with Bailer-Jones (2021) geometric distances.
#  parallax_over_error > 5 keeps the distances meaningful. Columns: r_med_geo, r_lo_geo, r_hi_geo (pc).
GAIA3D_ADQL = (
    "SELECT TOP {n} g.source_id, g.ra, g.dec, g.phot_g_mean_mag, g.bp_rp, "
    "d.r_med_geo, d.r_lo_geo, d.r_hi_geo "
    "FROM gaiadr3.gaia_source AS g JOIN external.gaiaedr3_distance AS d ON g.source_id = d.source_id "
    "WHERE 1=CONTAINS(POINT('ICRS',g.ra,g.dec),CIRCLE('ICRS',{ra:.7f},{dec:.7f},{r:.6f})) "
    "AND g.parallax_over_error > 5 AND g.phot_g_mean_mag IS NOT NULL "
    "ORDER BY g.phot_g_mean_mag"
)
# 3D scene star sources. "gavo" (GAVO Data Center, EDR3 lite + Bailer-Jones, one table, fast)
# is the default; "ari" (ARI Heidelberg, EDR3 + Bailer-Jones join) is a second single-query
# mirror; "esa" is the ESA Gaia archive, queried in tiles (its sync endpoint aborts queries
# that run past about a minute). A failing single-query source falls back to the ESA tiles.
GAIA3D_SOURCES = ("gavo", "ari", "esa")
GAIA3D_SOURCE = _env("SPHEREX_GAIA3D_SOURCE", "gavo").strip().lower()
if GAIA3D_SOURCE not in GAIA3D_SOURCES:
    raise ValueError(f"SPHEREX_GAIA3D_SOURCE must be one of {GAIA3D_SOURCES}")
GAVO_TAP_SYNC = _env("SPHEREX_GAVO_TAP", "https://dc.zah.uni-heidelberg.de/tap/sync")
ARI_TAP_SYNC = _env("SPHEREX_ARI_TAP", "https://gaia.ari.uni-heidelberg.de/tap/sync")
GAVO3D_ADQL = (
    "SELECT TOP {n} source_id, ra, dec, phot_g_mean_mag, phot_bp_mean_mag, phot_rp_mean_mag, "
    "r_med_geo, r_lo_geo, r_hi_geo FROM gedr3dist.litewithdist "
    "WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra:.7f},{dec:.7f},{r:.6f})) "
    "AND parallax/parallax_error > 5 AND phot_g_mean_mag IS NOT NULL "
    "ORDER BY phot_g_mean_mag"
)
# ARI's ADQL parser rejects a table-qualified column in ORDER BY, hence the bare name.
ARI3D_ADQL = (
    "SELECT TOP {n} g.source_id, g.ra, g.dec, g.phot_g_mean_mag, g.bp_rp, "
    "d.r_med_geo, d.r_lo_geo, d.r_hi_geo "
    "FROM gaiaedr3.gaia_source AS g JOIN gaiaedr3_complements.distances AS d ON g.source_id = d.source_id "
    "WHERE 1=CONTAINS(POINT('ICRS',g.ra,g.dec),CIRCLE('ICRS',{ra:.7f},{dec:.7f},{r:.6f})) "
    "AND g.parallax_over_error > 5 AND g.phot_g_mean_mag IS NOT NULL "
    "ORDER BY phot_g_mean_mag"
)
CATWISE_ADQL = (
    "SELECT TOP 2000 source_name, ra, dec, pmra, pmdec, w1mpro_pm, w2mpro_pm, meanobsmjd "
    "FROM catwise_2020 WHERE CONTAINS(POINT('ICRS',ra,dec),"
    "CIRCLE('ICRS',{ra:.7f},{dec:.7f},{r:.6f}))=1 ORDER BY w2mpro_pm"
)

# --- Where cutout pixels come from ---------------------------------------------
# "s3": range-read the needed rows of the full Level-2 file from the public S3 mirror and
#       assemble an IRSA-identical cutout locally (IRSA cutout service as automatic fallback).
# "irsa": IRSA cutout service first (S3 as automatic fallback).
CUTOUT_SOURCE = _env("SPHEREX_CUTOUT_SOURCE", "s3").strip().lower()
S3_CONCURRENCY = int(_env("SPHEREX_S3_CONCURRENCY", "12"))  # frames read from S3 at once
S3_MAX_CONNECTIONS = int(_env("SPHEREX_S3_MAX_CONNECTIONS", "48"))
S3_RETRY_ATTEMPTS = int(_env("SPHEREX_S3_RETRY_ATTEMPTS", "3"))
S3_WAVE_CONCURRENCY = int(_env("SPHEREX_S3_WAVE_CONCURRENCY", "3"))

# --- Concurrency / retries / timeouts --------------------------------------
IRSA_CONCURRENCY = int(_env("SPHEREX_IRSA_CONCURRENCY", "6"))
# CPU work (header/WCS parsing is GIL-bound): a few threads at most, so frames finish
# progressively instead of all at once
CPU_CONCURRENCY = int(_env("SPHEREX_CPU_CONCURRENCY", "3"))
FIT_CONCURRENCY = int(_env("SPHEREX_FIT_CONCURRENCY", str(CPU_CONCURRENCY)))  # source-model fits, separate from frame processing
# IRSA can answer even serial requests with HTTP 503. Bound retries and use capped
# exponential backoff with jitter before the alternate source is attempted.
RETRY_ATTEMPTS = int(_env("SPHEREX_RETRY_ATTEMPTS", "10"))
RETRY_BACKOFF_S = float(_env("SPHEREX_RETRY_BACKOFF", "0.5"))  # first delay
RETRY_BACKOFF_FACTOR = 1.6
RETRY_BACKOFF_MAX_S = 5.0
HTTP_CONNECT_TIMEOUT_S = 20.0
HTTP_READ_TIMEOUT_S = float(_env("SPHEREX_HTTP_READ_TIMEOUT", "300"))  # slow synchronous TAP
USER_AGENT = "spherex-sky-viewer/0.1"
LOG_LEVEL = _env("SPHEREX_LOG_LEVEL", "INFO").upper()

# --- Caching -----------------------------------------------------------------
TAP_TTL_S = float(_env("SPHEREX_TAP_TTL", "600"))  # frame lists: short, so new data shows up
# Frame lists on disk. Any query on the spherex tables currently costs IRSA TAP 5-40 s, even
# one that returns nothing. A list younger than FRAMES_DISK_TTL is served as is. One
# younger than FRAMES_STALE_MAX is served at once while a background query refreshes it, so
# the next request sees new data. Anything older is queried before answering.
FRAMES_DISK_TTL_S = float(_env("SPHEREX_FRAMES_DISK_TTL", str(6 * 3600)))
FRAMES_STALE_MAX_S = float(_env("SPHEREX_FRAMES_STALE_MAX", str(7 * 86400)))
CATALOG_TTL_S = float(_env("SPHEREX_CATALOG_TTL", str(30 * 86400)))
# A catalogue query that failed is not retried for this long (in memory, per field).
CATALOG_FAIL_TTL_S = float(_env("SPHEREX_CATALOG_FAIL_TTL", "600"))
# Catalogue TAP queries (CatWISE can take > 400 s): their own read timeout and attempt count.
CATALOG_READ_TIMEOUT_S = float(_env("SPHEREX_CATALOG_READ_TIMEOUT", "900"))
CATALOG_RETRY_ATTEMPTS = int(_env("SPHEREX_CATALOG_RETRY_ATTEMPTS", "2"))
# 3D scene star query (Gaia + Bailer-Jones join, can be slow on the ESA TAP server)
GAIA3D_READ_TIMEOUT_S = float(_env("SPHEREX_GAIA3D_READ_TIMEOUT", "120"))
GAIA3D_TILE_CONCURRENCY = int(_env("SPHEREX_GAIA3D_TILE_CONCURRENCY", "2"))  # ESA tiles at once
# A tile (ESA path) that failed is skipped for this long instead of being queried again.
GAIA3D_TILE_FAIL_TTL_S = float(_env("SPHEREX_GAIA3D_TILE_FAIL_TTL", "600"))
RESOLVE_TTL_S = float(_env("SPHEREX_RESOLVE_TTL", "86400"))
CUTOUT_SIZE_FACTOR = 1.45  # cutout size = fov * factor, to fill a north-up square at any roll
CUTOUT_SIZE_QUANTUM_DEG = 0.01  # round cutout size up to this so cache keys repeat
CUTOUT_HDUS_NEEDED = 5  # PRIMARY, IMAGE, FLAGS, VARIANCE, ZODI -> stop reading after HDU 4

# --- Request limits ------------------------------------------------------------
FOV_MIN_DEG = 0.01
FOV_MAX_DEG = 3.5  # about one detector (2040 px * 6.15" = 3.49 deg); cutouts clip to it
SCALE_MIN_ARCSEC = 1.0
SCALE_MAX_ARCSEC = 60.0
NPIX_MAX = 1001
MAX_FRAMES_DEFAULT = 400
MAX_FRAMES_CAP = 1500
CATALOG_RADIUS_MAX_DEG = 0.5
APER_MIN_PX, APER_MAX_PX = 0.5, 10.0

# --- Instrument facts ------------------------------------------------------------
NATIVE_SCALE_ARCSEC = 6.15
DETECTORS = (1, 2, 3, 4, 5, 6)
DETECTOR_RANGES_UM = {
    1: (0.75, 1.09), 2: (1.10, 1.62), 3: (1.63, 2.41),
    4: (2.42, 3.82), 5: (3.83, 4.41), 6: (4.42, 5.00),
}
# Fallback flag-bit table (from the MSKNnnnn keywords of a DR1 FLAGS header). Updated at
# runtime from every FLAGS header that is parsed.
DEFAULT_FLAG_BITS = {
    "TRANSIENT": 0, "OVERFLOW": 1, "SUR_ERROR": 2, "NONFUNC": 6, "DICHROIC": 7,
    "MISSING_DATA": 9, "HOT": 10, "COLD": 11, "FULLSAMPLE": 12, "PHANMISS": 14,
    "NONLINEAR": 15, "PERSIST": 17, "OUTLIER": 19, "CROSSTALK": 20, "SOURCE": 21,
    "GHOST": 22, "GHOST_FPA": 23, "GHOST_EXT": 24, "STREAK": 25, "BLOOM": 26,
    "SNOWBALL": 27, "HALO": 28,
}
# Flags that make a photometry point "bad" (only those present in the header are used)
BAD_FLAG_NAMES = (
    "TRANSIENT", "OVERFLOW", "SUR_ERROR", "PHANTOM", "REFERENCE", "NONFUNC", "DICHROIC",
    "MISSING_DATA", "HOT", "COLD", "FULLSAMPLE", "PHANMISS", "NONLINEAR", "PERSIST", "OUTLIER",
)
# Photometry
ANNULUS_IN_PX = 4.0
ANNULUS_OUT_PX = 7.0
APER_SUBSAMPLE = 5
STREAM_TARGET_APER_PX = 2.0

# --- Per-frame source model (/api/stream?model=1) ----------------------------------
MODEL_VERSION = "m4"  # bump to invalidate cached model results
# Fallback optical PSF FWHM (arcsec) per detector, used when the IMAGE header has no PSF_FWHM
# (these are the PSF_FWHM values found in real L2 headers; they are per-detector constants).
DEFAULT_PSF_FWHM_ARCSEC = {1: 7.5, 2: 7.46, 3: 7.45, 4: 8.67, 5: 8.63, 6: 9.04}
# Detector pixel response (box) as a Gaussian sigma in native pixels (1/sqrt(12)); added in
# quadrature to the header PSF to get the effective FWHM seen in the (bilinearly sampled) data.
PSF_PIXEL_SIGMA = 0.29
# Catalogue priors: brightness limits, and a cap on the number passed to the fitter.
PRIOR_GAIA_G_MAX = 19.0
# CatWISE rows in catalogs.catalog carry W2 (w2mpro_pm) as `mag`; W2 <= 15.5 ~ W1 <= 16
PRIOR_CATWISE_W2_MAX = 15.5
PRIOR_FAST_PM_MASYR = 500.0  # fast movers: always included as priors
# The stream never blocks on catalogues: a fit uses the priors already cached and a missing
# catalogue is fetched in the background. A stream waits at most this long for missing ones.
PRIOR_WAIT_S = float(_env("SPHEREX_PRIOR_WAIT", "0"))
PRIOR_CATALOGS = ("gaia", "catwise")  # order used in model cache keys
PRIOR_MAX = 3000
PRIOR_PAD_PX = 2.0  # keep priors up to this far outside the grid edge
# SPHEREx detector size (px): cutouts are clipped to it
DETECTOR_NPIX = 2040
