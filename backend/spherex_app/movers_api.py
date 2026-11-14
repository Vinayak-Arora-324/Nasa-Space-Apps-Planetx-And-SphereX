"""HTTP routes for the movers workstream (`app.include_router(movers_api.router)`)."""

from __future__ import annotations

import math

from fastapi import APIRouter, Depends, HTTPException, Query

from . import config, movers
from .archive import UpstreamError
from .geometry import npix_for

router = APIRouter(prefix="/api/movers", tags=["movers"])


def _bad(msg: str):
    raise HTTPException(status_code=400, detail=msg)


def _params(ra: float, dec: float, fov: float, scale: float, detectors: str,
            mjd_min: float | None, mjd_max: float | None, max_frames: int,
            per_visit: int | None) -> movers.Params:
    if not (math.isfinite(ra) and math.isfinite(dec)) or not (0 <= ra <= 360) or not (-90 <= dec <= 90):
        _bad("ra/dec out of range (0<=ra<=360, -90<=dec<=90)")
    if not config.FOV_MIN_DEG <= fov <= config.FOV_MAX_DEG:
        _bad(f"fov must be between {config.FOV_MIN_DEG} and {config.FOV_MAX_DEG} deg")
    if not config.SCALE_MIN_ARCSEC <= scale <= config.SCALE_MAX_ARCSEC:
        _bad(f"scale must be between {config.SCALE_MIN_ARCSEC} and {config.SCALE_MAX_ARCSEC} arcsec")
    if npix_for(fov, scale) > config.NPIX_MAX:
        _bad(f"fov/scale gives {npix_for(fov, scale)} px > {config.NPIX_MAX}; increase scale")
    if not 1 <= max_frames <= config.MAX_FRAMES_CAP:
        _bad(f"max_frames must be between 1 and {config.MAX_FRAMES_CAP}")
    if per_visit is not None and per_visit < 1:
        _bad("per_visit must be >= 1")
    try:
        dets = sorted({int(x) for x in detectors.replace(" ", "").split(",") if x})
    except ValueError:
        dets = []
    if not dets or any(d not in config.DETECTORS for d in dets):
        _bad("detectors must be a comma-separated list of integers 1-6")
    return movers.Params(ra % 360.0, dec, fov, scale, tuple(dets), mjd_min, mjd_max, max_frames,
                         per_visit)


def params_dep(ra: float, dec: float, fov: float = 0.1, scale: float = config.NATIVE_SCALE_ARCSEC,
               detectors: str = "1,2,3,4,5,6", mjd_min: float | None = None,
               mjd_max: float | None = None, max_frames: int = config.MAX_FRAMES_DEFAULT,
               per_visit: int | None = Query(None)) -> movers.Params:
    return _params(ra, dec, fov, scale, detectors, mjd_min, mjd_max, max_frames, per_visit)


async def _select(p: movers.Params):
    try:
        return await movers.select_frames_for(p)
    except UpstreamError as e:
        raise HTTPException(status_code=502, detail=f"upstream archive error: {e}") from e


@router.get("/known")
async def known(p: movers.Params = Depends(params_dep)):
    sel = await _select(p)
    try:
        return await movers.known_objects(p, sel)
    except UpstreamError as e:
        raise HTTPException(status_code=502, detail=f"upstream archive error: {e}") from e


@router.get("/linked")
async def linked(p: movers.Params = Depends(params_dep)):
    sel = await _select(p)
    try:
        return await movers.linked_movers(p, sel)
    except UpstreamError as e:
        raise HTTPException(status_code=502, detail=f"upstream archive error: {e}") from e
    except RuntimeError as e:
        return {"movers": [], "error": str(e)}


@router.get("/search/start")
async def search_start(p: movers.Params = Depends(params_dep)):
    job, cached = await movers.start_search(p)
    return {"job": job.id, "cached": cached}


def _job(job: str) -> movers.Job:
    j = movers.JOBS.get(job)
    if j is None:
        raise HTTPException(status_code=404, detail="unknown job")
    return j


@router.get("/search/status")
async def search_status(job: str):
    return _job(job).status()


@router.get("/search/cancel")
async def search_cancel(job: str):
    j = _job(job)
    movers.cancel_job(j)
    return {"job": j.id, "state": j.state}
