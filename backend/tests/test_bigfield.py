"""Wide fields: anti-aliased downsampling, cutout sizing, S3 box clipping."""

from __future__ import annotations

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from spherex_app import archive, config, geometry, processing, s3cutout

RA0, DEC0 = 150.0, 2.0


def synth_cutout(n=401, stars=((200.0, 200.0, 100.0),), noise=0.0, seed=0) -> processing.Cutout:
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [RA0, DEC0]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-6.15 / 3600, 6.15 / 3600]
    yy, xx = np.indices((n, n), dtype=float)
    img = np.random.default_rng(seed).normal(0, noise, (n, n)) if noise else np.zeros((n, n))
    for x, y, a in stars:
        img += a * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 1.0 ** 2))
    h = w.to_header()
    h["NAXIS1"] = h["NAXIS2"] = n
    return processing.Cutout(
        header=fits.Header(h), image=img.astype(np.float32), flags=np.zeros((n, n), np.uint32),
        variance=np.ones((n, n), np.float32), zodi=np.zeros((n, n), np.float32),
        flag_bits=dict(config.DEFAULT_FLAG_BITS), wcs=w)


def test_native_scale_unchanged_and_downsample_conserves_flux():
    cut = synth_cutout()
    g1 = geometry.Grid(RA0, DEC0, 6.15, 201)
    img1, _, _, _ = processing.resample(cut, g1)
    # native scale: plain bilinear, a centred star keeps its peak
    assert abs(np.nanmax(img1) - 100.0) < 1.0
    flux_native = np.nansum(img1) * 1.0  # per native px
    g3 = geometry.Grid(RA0, DEC0, 18.45, 67)  # 3x coarser
    img3, _, _, _ = processing.resample(cut, g3)
    flux3 = np.nansum(img3) * 9.0  # each output px covers 9 native px
    assert abs(flux3 / flux_native - 1) < 0.05


def test_downsample_has_no_aliasing_pattern():
    # a star moved by sub-pixel offsets must give a stable summed flux (point sampling does not)
    fluxes = []
    for dx in np.linspace(0, 2.9, 7):
        cut = synth_cutout(stars=((200.0 + dx, 200.3, 100.0),))
        img, *_ = processing.resample(cut, geometry.Grid(RA0, DEC0, 24.6, 51))  # 4x coarser
        fluxes.append(np.nansum(img) * 16.0)
    fluxes = np.array(fluxes)
    assert fluxes.std() / fluxes.mean() < 0.02


def test_downsample_is_nan_aware_and_ors_flags():
    cut = synth_cutout(stars=())
    cut.image[:, 190:210] = np.nan
    cut.flags[100, 100] = 1 << 3
    g = geometry.Grid(RA0, DEC0, 24.6, 51)
    img, fl, px, py = processing.resample(cut, g)
    assert np.isfinite(img).sum() > 0
    assert np.nanmax(np.abs(img)) < 1e-4  # NaNs do not leak in as zeros
    assert fl.max() == 1 << 3  # the lone flagged native pixel survives into some output pixel


def test_cutout_size_for_wide_fields_clips_to_detector():
    assert config.FOV_MAX_DEG == 3.5
    size = archive.cutout_size_deg(3.5)
    assert size > 3.5 * 1.44
    h = fits.Header()
    h["NAXIS1"] = h["NAXIS2"] = 2040
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [RA0, DEC0]
    w.wcs.crpix = [1020.5, 1020.5]
    w.wcs.cdelt = [-6.15 / 3600, 6.15 / 3600]
    h.update(w.to_header())
    x0, x1, y0, y1 = s3cutout.cutout_box(h, RA0, DEC0, size)
    assert (x0, x1, y0, y1) == (0, 2040, 0, 2040)
