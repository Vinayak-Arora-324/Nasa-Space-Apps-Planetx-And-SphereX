"""Physical parameters of one star for the 3D fly-through (`/api/system/{source_id}`).

Phase 1 is stellar parameters only; `planets` and `companions` are empty placeholders.
Every value carries its provenance: {"v", "lo", "hi", "src", "tier"}. Tier "measured" is
Gaia astrometry/photometry (and Bailer-Jones distances); "catalogue" is everything from Apsis
(GSP-Phot, FLAME, ESP-HS, DSC). The backend never derives values; the frontend does that.

`build_payload` (row -> payload) is pure and offline-testable; `get_system` is the async entry.
"""

from __future__ import annotations

import logging
import math

from . import cache, catalogs, config
from .archive import UpstreamError

log = logging.getLogger(__name__)

CACHE_KIND = "system3d"
SRC_PHOT = "Gaia DR3 photometry"
SRC_DIST = "Bailer-Jones 2021 (geometric)"
SRC_PLX = "Gaia DR3 parallax"
SRC_GSP = "Gaia DR3 GSP-Phot"
SRC_FLAME = "Gaia DR3 FLAME"
SRC_ESPHS = "Gaia DR3 ESP-HS"
SRC_DSC = "Gaia DR3 DSC"
HOT_TEFF_K = 25000.0

_SELECT = (
    "g.source_id, g.ra, g.dec, g.parallax, g.parallax_error, g.phot_g_mean_mag, g.bp_rp, "
    "d.r_med_geo, d.r_lo_geo, d.r_hi_geo, "
    "a.teff_gspphot, a.teff_gspphot_lower, a.teff_gspphot_upper, "
    "a.logg_gspphot, a.logg_gspphot_lower, a.logg_gspphot_upper, "
    "a.radius_gspphot, a.radius_gspphot_lower, a.radius_gspphot_upper, "
    "a.radius_flame, a.radius_flame_lower, a.radius_flame_upper, "
    "a.lum_flame, a.lum_flame_lower, a.lum_flame_upper, "
    "a.mass_flame, a.mass_flame_lower, a.mass_flame_upper, "
    "a.age_flame, a.age_flame_lower, a.age_flame_upper, a.flags_flame, "
    "a.teff_esphs, a.teff_esphs_uncertainty, a.logg_esphs, a.logg_esphs_uncertainty, "
    "a.spectraltype_esphs, a.classprob_dsc_combmod_whitedwarf"
)
_FROM_APS = (
    " FROM gaiadr3.gaia_source AS g "
    "LEFT JOIN gaiadr3.astrophysical_parameters AS a ON g.source_id = a.source_id "
    "LEFT JOIN {dist} AS d ON g.source_id = d.source_id "
    "WHERE g.source_id IN ({sid})"
)
# ARI mirror: Bailer-Jones table gaiaedr3_complements.distances; ESA: external.gaiaedr3_distance
ARI_ADQL = "SELECT " + _SELECT + _FROM_APS.format(dist="gaiaedr3_complements.distances", sid="{sid}")
ESA_ADQL = "SELECT " + _SELECT + _FROM_APS.format(dist="external.gaiaedr3_distance", sid="{sid}")


def _f(v) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _v(v, src: str, tier: str, lo=None, hi=None, nd: int = 5) -> dict | None:
    x = _f(v)
    if x is None:
        return None
    lo, hi = _f(lo), _f(hi)
    return {"v": round(x, nd), "lo": None if lo is None else round(lo, nd),
            "hi": None if hi is None else round(hi, nd), "src": src, "tier": tier}


def _cat(row: dict, col: str, src: str, nd: int = 5) -> dict | None:
    return _v(row.get(col), src, "catalogue", row.get(col + "_lower"), row.get(col + "_upper"), nd)


def _empty_values() -> dict:
    return {k: None for k in ("dist_pc", "g_mag", "bp_rp", "teff_k", "radius_rsun", "lum_lsun",
                              "mass_msun", "age_gyr", "logg", "spectral_type", "wd_prob")}


def sun_payload() -> dict:
    iau = "IAU 2015 nominal"
    vals = _empty_values()
    for k, x in (("teff_k", 5772.0), ("radius_rsun", 1.0), ("lum_lsun", 1.0), ("mass_msun", 1.0),
                 ("age_gyr", 4.57), ("logg", 4.438)):
        vals[k] = {"v": x, "lo": None, "hi": None, "src": iau, "tier": "measured"}
    vals["spectral_type"] = {"v": "G2V", "src": iau, "tier": "measured"}
    return {"id": "sun", "name": "Sun", "ra": None, "dec": None, "values": vals,
            "planets": [], "companions": [], "notes": []}


def build_payload(row: dict) -> dict:
    """One joined TAP row (strings or numbers; ESA/ARI column names) -> the /api/system payload."""
    notes: list[str] = []
    vals = _empty_values()

    # distance: Bailer-Jones geometric, else a clean parallax inversion
    vals["dist_pc"] = _v(row.get("r_med_geo"), SRC_DIST, "measured",
                         row.get("r_lo_geo"), row.get("r_hi_geo"), 4)
    if vals["dist_pc"] and vals["dist_pc"]["v"] <= 0:
        vals["dist_pc"] = None
    if vals["dist_pc"] is None:
        plx, err = _f(row.get("parallax")), _f(row.get("parallax_error"))
        if plx and plx > 0 and err is not None and err / plx < 0.2:
            vals["dist_pc"] = _v(1000.0 / plx, SRC_PLX, "measured",
                                 1000.0 / (plx + err), 1000.0 / (plx - err), 4)
        else:
            notes.append("No reliable distance available for this star")
    vals["g_mag"] = _v(row.get("phot_g_mean_mag"), SRC_PHOT, "measured", nd=4)
    vals["bp_rp"] = _v(row.get("bp_rp"), SRC_PHOT, "measured", nd=4)

    # Teff: ESP-HS (hot stars) when it has a value, else GSP-Phot
    t_gsp, t_hs = _f(row.get("teff_gspphot")), _f(row.get("teff_esphs"))
    if t_hs is not None:
        u = _f(row.get("teff_esphs_uncertainty"))
        vals["teff_k"] = _v(t_hs, SRC_ESPHS, "catalogue",
                            None if u is None else t_hs - u, None if u is None else t_hs + u, 1)
        if t_gsp is not None and t_gsp <= HOT_TEFF_K:
            notes.append("Teff from ESP-HS; GSP-Phot also has a value")
    elif t_gsp is not None:
        vals["teff_k"] = _cat(row, "teff_gspphot", SRC_GSP, 1)
    else:
        notes.append("No effective temperature available for this star")

    if _f(row.get("radius_flame")) is not None:
        vals["radius_rsun"] = _cat(row, "radius_flame", SRC_FLAME)
    else:
        vals["radius_rsun"] = _cat(row, "radius_gspphot", SRC_GSP)
    vals["lum_lsun"] = _cat(row, "lum_flame", SRC_FLAME)
    vals["mass_msun"] = _cat(row, "mass_flame", SRC_FLAME)
    vals["age_gyr"] = _cat(row, "age_flame", SRC_FLAME)

    if _f(row.get("logg_gspphot")) is not None:
        vals["logg"] = _cat(row, "logg_gspphot", SRC_GSP, 4)
    else:
        u = _f(row.get("logg_esphs_uncertainty"))
        lg = _f(row.get("logg_esphs"))
        vals["logg"] = _v(lg, SRC_ESPHS, "catalogue",
                          None if lg is None or u is None else lg - u,
                          None if lg is None or u is None else lg + u, 4)

    st = (row.get("spectraltype_esphs") or "").strip()
    if st:
        vals["spectral_type"] = {"v": st, "src": SRC_ESPHS, "tier": "catalogue"}
    vals["wd_prob"] = _v(row.get("classprob_dsc_combmod_whitedwarf"), SRC_DSC, "catalogue", nd=6)

    if vals["mass_msun"] is None:
        notes.append("FLAME mass not available for this star")
    if vals["age_gyr"] is None:
        notes.append("FLAME age not available for this star")
    if vals["lum_lsun"] is None:
        notes.append("FLAME luminosity not available for this star")
    flags = (row.get("flags_flame") or "").strip().strip('"')
    if flags and set(flags) - {"0"}:
        notes.append(f"FLAME quality flags set ({flags}): treat radius, luminosity, mass and age with caution")

    sid = str(row.get("source_id") or "").strip()
    return {"id": sid, "name": None, "ra": _f(row.get("ra")), "dec": _f(row.get("dec")),
            "values": vals, "planets": [], "companions": [], "notes": notes}


# --- async fetch ---------------------------------------------------------------------------

async def _ari_row(sid: str) -> list[dict]:
    return await catalogs.tap_csv(
        config.ARI_TAP_SYNC, ARI_ADQL.format(sid=sid), irsa=False, what="Gaia TAP (ARI)",
        timeout=config.GAIA3D_READ_TIMEOUT_S, attempts=config.CATALOG_RETRY_ATTEMPTS,
        extra={"MAXREC": "2"})


async def _esa_row(sid: str) -> list[dict]:
    return await catalogs.tap_csv(
        config.GAIA_TAP_SYNC, ESA_ADQL.format(sid=sid), irsa=False, what="Gaia TAP (ESA)",
        timeout=config.GAIA3D_READ_TIMEOUT_S, attempts=config.CATALOG_RETRY_ATTEMPTS,
        extra={"MAXREC": "2"})


async def get_system(sid: str) -> dict:
    """Payload for a Gaia source id (digits). Raises catalogs.NotFound (404) for an unknown id and
    UpstreamError (502) when ARI and ESA both fail. Only successful payloads are cached."""
    if sid == "sun":
        return sun_payload()
    hit = cache.get_json(CACHE_KIND, sid, ttl=config.CATALOG_TTL_S)
    if hit is not None:
        return hit
    try:
        rows = await _ari_row(sid)
    except Exception as e:  # noqa: BLE001  (any ARI failure falls back to ESA)
        log.warning("system3d: ARI lookup failed (%s: %s); using ESA", type(e).__name__, e)
        try:
            rows = await _esa_row(sid)
        except UpstreamError:
            raise
        except Exception as e2:  # noqa: BLE001
            raise UpstreamError(f"Gaia TAP lookup failed: {e2}") from e2
    if not rows:
        raise catalogs.NotFound(f"Gaia source {sid} not found")
    out = build_payload(rows[0])
    out["id"] = sid
    cache.put_json(CACHE_KIND, sid, out)
    return out
