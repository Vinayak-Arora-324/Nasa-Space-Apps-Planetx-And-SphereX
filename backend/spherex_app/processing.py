"""CPU-side work on a cutout: parsing, resampling onto the output grid, photometry.

Everything here is synchronous and is run in a worker thread by the API layer.
"""

from __future__ import annotations

import math
import warnings
from dataclasses import dataclass

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
from scipy import ndimage

from . import config
from .fitsstream import FitsFormatError, image_array, split_bytes
from .geometry import Grid, WaveTable, cutout_to_detector, wave_lookup

warnings.simplefilter("ignore", FITSFixedWarning)

ARCSEC2_SR = (math.pi / (180.0 * 3600.0)) ** 2
# Global flag-bit table; refreshed from parsed FLAGS headers.
FLAG_BITS: dict[str, int] = dict(config.DEFAULT_FLAG_BITS)


@dataclass
class Cutout:
    header: fits.Header  # IMAGE header
    image: np.ndarray  # float32 MJy/sr (zodi NOT subtracted)
    flags: np.ndarray  # uint32
    variance: np.ndarray  # float32 (MJy/sr)^2
    zodi: np.ndarray  # float32 MJy/sr
    flag_bits: dict[str, int]
    wcs: WCS


def parse_flag_bits(h: fits.Header) -> dict[str, int]:
    bits = {}
    for key in h.keys():
        if key.startswith("MSKN") and key[4:].isdigit():
            bits[str(h[key]).strip()] = int(key[4:])
        elif key.startswith("MP") and isinstance(h[key], int) and 0 <= h[key] < 32:
            bits[key[2:].lstrip("_")] = int(h[key])  # older 'MP<NAME> = bit' convention
    return bits


def parse_cutout(data: bytes) -> Cutout:
    hdus = split_bytes(data)
    byname = {h.name: h for h in hdus}
    for need in ("IMAGE", "FLAGS", "VARIANCE", "ZODI"):
        if need not in byname:
            raise FitsFormatError(f"cutout lacks {need} HDU (got {[h.name for h in hdus]})")
    header = byname["IMAGE"].header()
    image = image_array(byname["IMAGE"]).astype(np.float32)
    flags = image_array(byname["FLAGS"]).astype(np.int64).astype(np.uint32)
    variance = image_array(byname["VARIANCE"]).astype(np.float32)
    zodi = image_array(byname["ZODI"]).astype(np.float32)
    bits = parse_flag_bits(byname["FLAGS"].header()) or dict(config.DEFAULT_FLAG_BITS)
    FLAG_BITS.update(bits)
    return Cutout(header, image, flags, variance, zodi, bits, WCS(header))


def wave_table_from_full_file(data: bytes) -> WaveTable | None:
    from .fitsstream import bintable_row0
    for h in split_bytes(data):
        if h.name == "WCS-WAVE":
            return WaveTable.from_row(bintable_row0(h.header(), h.data_bytes))
    return None


def flag_names(value: int, bits: dict[str, int]) -> list[str]:
    return [n for n, b in sorted(bits.items(), key=lambda kv: kv[1]) if value & (1 << b)]


def bad_mask(bits: dict[str, int]) -> int:
    m = 0
    for n in config.BAD_FLAG_NAMES:
        if n in bits:
            m |= 1 << bits[n]
    return m


# --- Resampling -------------------------------------------------------------------

ALIAS_RATIO_MIN = 1.05  # grid scale / native scale above which we anti-alias


def effective_psf_px(header_fwhm_arcsec, detector: int, scale: float) -> float:
    """Effective PSF FWHM (grid px) of a star in the resampled image.

    The header PSF_FWHM (else a per-detector default) is the optical PSF.  The data are detector
    pixels (box response, Gaussian-equivalent sigma 0.29 native px; the measured FWHM of bright
    stars is the header PSF in quadrature with this, to a few %), and when the grid is coarser
    than native the anti-aliasing kernel (Gaussian sigma 0.42 * grid scale) is added as well."""
    try:
        fw = float(header_fwhm_arcsec)
    except (TypeError, ValueError):
        fw = math.nan
    if not (math.isfinite(fw) and fw > 0):
        fw = config.DEFAULT_PSF_FWHM_ARCSEC.get(detector, 8.0)
    fw = math.hypot(fw, 2.3548 * config.PSF_PIXEL_SIGMA * config.NATIVE_SCALE_ARCSEC)
    if scale / config.NATIVE_SCALE_ARCSEC > ALIAS_RATIO_MIN:
        fw = math.hypot(fw, 2.3548 * 0.42 * scale)
    return fw / scale


def _flags_footprint_or(flags: np.ndarray, size: int) -> np.ndarray:
    """OR of flag bits over a size x size footprint (per present bit, via a max filter)."""
    present = int(np.bitwise_or.reduce(flags, axis=None)) if flags.size else 0
    out = np.zeros(flags.shape, dtype=np.uint32)
    for b in range(32):
        if present >> b & 1:
            m = ndimage.maximum_filter(((flags >> b) & 1).astype(np.uint8), size=size,
                                       mode="constant", cval=0)
            out |= m.astype(np.uint32) << b
    return out


def resample(cut: Cutout, grid: Grid):
    """Return (image - zodi, flags, (px, py) cutout coords of every output pixel).

    When the grid is coarser than the native 6.15 arcsec pixels the cutout is first smoothed
    (NaN-aware Gaussian, sigma = 0.42 * ratio native px, about a box average of the output
    pixel) so sampling does not alias; flags are OR-ed over the output-pixel footprint.
    At native scale (ratio <= 1.05) the result is the plain bilinear sample, unchanged."""
    ra, dec = grid.sky_mesh()
    px, py = cut.wcs.all_world2pix(ra.ravel(), dec.ravel(), 0, tolerance=1e-6, maxiter=50,
                                   quiet=True)
    px = px.reshape(ra.shape)
    py = py.reshape(ra.shape)
    sub = (cut.image - cut.zodi).astype(np.float64)
    valid = np.isfinite(sub)
    vals = np.where(valid, sub, 0.0)
    wts = valid.astype(np.float64)
    ratio = grid.scale / config.NATIVE_SCALE_ARCSEC
    smooth = ratio > ALIAS_RATIO_MIN
    if smooth:
        sig = 0.42 * ratio
        vals = ndimage.gaussian_filter(vals, sig, mode="constant", cval=0.0, truncate=3.0)
        wts = ndimage.gaussian_filter(wts, sig, mode="constant", cval=0.0, truncate=3.0)
    coords = np.array([py, px])
    num = ndimage.map_coordinates(vals, coords, order=1, mode="constant", cval=0.0,
                                  prefilter=False)
    den = ndimage.map_coordinates(wts, coords, order=1, mode="constant", cval=0.0,
                                  prefilter=False)
    ny, nx = sub.shape
    inside = (px >= -0.5) & (px <= nx - 0.5) & (py >= -0.5) & (py <= ny - 0.5)
    good = inside & (den > 0.5)
    out = np.full(ra.shape, np.nan, dtype=np.float32)
    out[good] = (num[good] / den[good]).astype(np.float32)
    ix = np.clip(np.rint(px).astype(int), 0, nx - 1)
    iy = np.clip(np.rint(py).astype(int), 0, ny - 1)
    flags = cut.flags
    if smooth:
        flags = _flags_footprint_or(flags, max(2, int(round(ratio))))
    fl = np.where(good, flags[iy, ix], 0).astype(np.uint32)
    return out, fl, px, py


def robust_stats(img: np.ndarray):
    v = img[np.isfinite(img)]
    if v.size == 0:
        return None, None, 0.0
    med = float(np.median(v))
    mad = float(np.median(np.abs(v - med)))
    return med, 1.4826 * mad, v.size / img.size


# --- Photometry -------------------------------------------------------------------

def _sigma_clipped(vals: np.ndarray, nsig=3.0, iters=5):
    v = vals[np.isfinite(vals)]
    for _ in range(iters):
        if v.size < 3:
            break
        med = np.median(v)
        sd = 1.4826 * np.median(np.abs(v - med))
        if sd <= 0:
            break
        keep = np.abs(v - med) < nsig * sd
        if keep.all():
            break
        v = v[keep]
    if v.size == 0:
        return math.nan, math.nan, 0
    med = float(np.median(v))
    return med, float(np.std(v)), int(v.size)


def _aperture_weights(shape, x0, y0, r, sub=config.APER_SUBSAMPLE):
    """Fractional-overlap weights of a circle (centre x0,y0 in 0-based pixels) by sub-sampling."""
    ny, nx = shape
    x_lo, x_hi = max(int(math.floor(x0 - r - 1)), 0), min(int(math.ceil(x0 + r + 1)), nx - 1)
    y_lo, y_hi = max(int(math.floor(y0 - r - 1)), 0), min(int(math.ceil(y0 + r + 1)), ny - 1)
    w = np.zeros(shape, dtype=np.float64)
    if x_lo > x_hi or y_lo > y_hi:
        return w
    offs = (np.arange(sub) + 0.5) / sub - 0.5
    ys, xs = np.mgrid[y_lo:y_hi + 1, x_lo:x_hi + 1]
    sx = xs[..., None, None] + offs[None, None, None, :]
    sy = ys[..., None, None] + offs[None, None, :, None]
    inside = (sx - x0) ** 2 + (sy - y0) ** 2 <= r * r
    w[y_lo:y_hi + 1, x_lo:x_hi + 1] = inside.mean(axis=(2, 3))
    return w


def pixel_solid_angle_sr(wcs: WCS, x, y) -> float:
    """Local pixel solid angle from the (SIP) WCS Jacobian at (x, y)."""
    pts = np.array([[x - 0.5, y], [x + 0.5, y], [x, y - 0.5], [x, y + 0.5]])
    w = wcs.all_pix2world(pts, 0)
    ra, dec = np.radians(w[:, 0]), np.radians(w[:, 1])
    cosd = math.cos(dec.mean())
    dxa = ((ra[1] - ra[0] + math.pi) % (2 * math.pi) - math.pi) * cosd, dec[1] - dec[0]
    dya = ((ra[3] - ra[2] + math.pi) % (2 * math.pi) - math.pi) * cosd, dec[3] - dec[2]
    return abs(dxa[0] * dya[1] - dxa[1] * dya[0])


@dataclass
class PhotResult:
    x: float  # 0-based cutout pixel
    y: float
    flux_mjy: float | None
    err_mjy: float | None
    flags: int
    bad: bool


def photometry(cut: Cutout, ra: float, dec: float, aper: float) -> PhotResult:
    x0, y0 = (float(v) for v in cut.wcs.all_world2pix([[ra, dec]], 0, quiet=True)[0])
    ny, nx = cut.image.shape
    if not (np.isfinite(x0) and np.isfinite(y0)) or x0 < -0.5 or y0 < -0.5 \
            or x0 > nx - 0.5 or y0 > ny - 0.5:
        return PhotResult(x0, y0, None, None, 0, True)
    w = _aperture_weights(cut.image.shape, x0, y0, aper)
    yy, xx = np.indices(cut.image.shape)
    rr = np.hypot(xx - x0, yy - y0)
    ann = (rr >= config.ANNULUS_IN_PX) & (rr <= config.ANNULUS_OUT_PX)
    bkg, bkg_sd, n_ann = _sigma_clipped(cut.image[ann])
    in_ap = w > 0
    flags = int(np.bitwise_or.reduce(cut.flags[in_ap])) if in_ap.any() else 0
    img = cut.image.astype(np.float64)
    var = cut.variance.astype(np.float64)
    good = in_ap & np.isfinite(img) & np.isfinite(var)
    wtot = w[in_ap].sum()
    wgood = w[good].sum()
    if wtot <= 0 or wgood < 0.7 * wtot or not math.isfinite(bkg) or n_ann < 5:
        return PhotResult(x0, y0, None, None, flags, True)
    scale_fill = wtot / wgood  # compensate for a few NaN pixels in the aperture
    s = float(np.sum(w[good] * (img[good] - bkg))) * scale_fill
    area = wtot
    e2 = float(np.sum(w[good] ** 2 * var[good])) * scale_fill ** 2 \
        + (area * bkg_sd) ** 2 * (math.pi / 2) / n_ann
    omega = pixel_solid_angle_sr(cut.wcs, x0, y0)
    k = 1e9 * omega  # MJy/sr * sr -> MJy; *1e9 -> mJy
    flux, err = s * k, math.sqrt(e2) * k
    bad = bool(flags & bad_mask(cut.flag_bits)) or not (math.isfinite(flux) and math.isfinite(err))
    return PhotResult(x0, y0, flux if math.isfinite(flux) else None,
                      err if math.isfinite(err) else None, flags, bad)


# --- Wavelength ------------------------------------------------------------------

def wavelength_at(cut: Cutout, table: WaveTable | None, x0, y0):
    if table is None:
        return None, None
    dx, dy = cutout_to_detector(cut.header, x0, y0)
    wl, bw = wave_lookup(table, dx, dy)
    return wl, bw


def _f(v, nd=6):
    if v is None:
        return None
    v = float(v)
    return round(v, nd) if math.isfinite(v) else None


def frame_product(cut: Cutout, table: WaveTable | None, grid: Grid, target_ra: float,
                  target_dec: float, aper: float = config.STREAM_TARGET_APER_PX,
                  arrays: dict | None = None):
    """Build the per-frame JSON metadata (partial) and the image/flag payload arrays.

    If `arrays` is a dict it receives the resampled `img` (float32) and `flags` (uint32)."""
    img, fl, px, py = resample(cut, grid)
    if arrays is not None:
        arrays["img"], arrays["flags"] = img, fl
    med, sig, frac = robust_stats(img)
    c = int(grid.c)
    h = cut.header
    # wavelength at the centre and its gradient per output pixel (central differences)
    d = min(5, c)
    wl = bw = gx = gy = None
    if table is not None:
        sel_x = np.array([c, c - d, c + d, c, c])
        sel_y = np.array([c, c, c, c - d, c + d])
        wls, bws = wavelength_at(cut, table, px[sel_y, sel_x], py[sel_y, sel_x])
        wl, bw = wls[0], bws[0]
        if d > 0:
            gx = (wls[2] - wls[1]) / (2 * d)
            gy = (wls[4] - wls[3]) / (2 * d)
    phot = photometry(cut, target_ra, target_dec, aper)
    tx, ty = grid.sky_to_pix(target_ra, target_dec)
    zodi_med = float(np.nanmedian(cut.zodi)) if np.isfinite(cut.zodi).any() else None
    meta = {
        "mjd": _f(h.get("MJD-AVG"), 7),
        "date_iso": h.get("DATE-AVG"),
        "exptime": _f(h.get("XPOSURE", h.get("TELAPSE")), 3),
        "wavelength_um": _f(wl), "bandwidth_um": _f(bw),
        "dwave_dx": _f(gx, 8), "dwave_dy": _f(gy, 8),
        "psf_fwhm_arcsec": _f(h.get("PSF_FWHM"), 3),
        "zodi_median": _f(zodi_med), "bkg_median": _f(med), "noise": _f(sig),
        "frac_valid": _f(frac, 4),
        "dqa": h.get("L2DQAFLG"),
        "target": {"x": _f(tx, 3), "y": _f(ty, 3), "ra": _f(target_ra, 7), "dec": _f(target_dec, 7),
                   "flux_mjy": _f(phot.flux_mjy), "flux_err_mjy": _f(phot.err_mjy),
                   "flags": phot.flags},
    }
    payload = img.astype("<f4").tobytes() + fl.astype("<u4").tobytes()
    return meta, payload


def spectrum_point(cut: Cutout, table: WaveTable | None, ra: float, dec: float, aper: float):
    phot = photometry(cut, ra, dec, aper)
    wl, bw = wavelength_at(cut, table, phot.x, phot.y)
    snr = (phot.flux_mjy / phot.err_mjy) if (phot.flux_mjy is not None and phot.err_mjy) else None
    return {
        "mjd": _f(cut.header.get("MJD-AVG"), 7),
        "wavelength_um": _f(wl), "bandwidth_um": _f(bw),
        "flux_mjy": _f(phot.flux_mjy), "err_mjy": _f(phot.err_mjy), "snr": _f(snr, 3),
        "flags": phot.flags, "flag_names": flag_names(phot.flags, cut.flag_bits),
        "bad": phot.bad,
    }
