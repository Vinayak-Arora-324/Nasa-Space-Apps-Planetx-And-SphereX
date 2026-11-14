"""Projection maths, output grid, proper-motion propagation and wavelength lookup."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

ARCSEC = np.pi / (180.0 * 3600.0)
MJD_J2000 = 51544.5


# --- Gnomonic (TAN) projection -------------------------------------------------

def sky_to_std(ra, dec, ra0, dec0):
    """ICRS degrees -> standard coordinates (xi east-positive, eta north-positive) in arcsec."""
    ra, dec = np.radians(ra), np.radians(dec)
    ra0, dec0 = np.radians(ra0), np.radians(dec0)
    dra = ra - ra0
    cosc = np.sin(dec0) * np.sin(dec) + np.cos(dec0) * np.cos(dec) * np.cos(dra)
    xi = np.cos(dec) * np.sin(dra) / cosc
    eta = (np.cos(dec0) * np.sin(dec) - np.sin(dec0) * np.cos(dec) * np.cos(dra)) / cosc
    return xi / ARCSEC, eta / ARCSEC


def std_to_sky(xi, eta, ra0, dec0):
    """Standard coordinates in arcsec -> ICRS degrees (inverse gnomonic)."""
    xi = np.asarray(xi, dtype=float) * ARCSEC
    eta = np.asarray(eta, dtype=float) * ARCSEC
    ra0r, dec0r = np.radians(ra0), np.radians(dec0)
    denom = np.cos(dec0r) - eta * np.sin(dec0r)
    ra = ra0r + np.arctan2(xi, denom)
    dec = np.arctan2(np.sin(dec0r) + eta * np.cos(dec0r), np.hypot(xi, denom))
    return np.degrees(ra) % 360.0, np.degrees(dec)


@dataclass(frozen=True)
class Grid:
    """North-up output grid: row 0 north, column 0 east; x = c - xi/scale, y = c - eta/scale."""
    ra: float
    dec: float
    scale: float  # arcsec / px
    npix: int

    @property
    def c(self) -> float:
        return (self.npix - 1) / 2.0

    def sky_to_pix(self, ra, dec):
        xi, eta = sky_to_std(ra, dec, self.ra, self.dec)
        return self.c - xi / self.scale, self.c - eta / self.scale

    def pix_to_sky(self, x, y):
        return std_to_sky((self.c - np.asarray(x)) * self.scale,
                          (self.c - np.asarray(y)) * self.scale, self.ra, self.dec)

    def sky_mesh(self):
        """(ra, dec) arrays of shape (npix, npix), row-major (row = y)."""
        idx = np.arange(self.npix, dtype=float)
        x, y = np.meshgrid(idx, idx)
        return self.pix_to_sky(x, y)


def npix_for(fov_deg: float, scale_arcsec: float) -> int:
    n = int(round(fov_deg * 3600.0 / scale_arcsec))
    if n % 2 == 0:
        n += 1
    return max(n, 3)


# --- Time / proper motion -------------------------------------------------------

def mjd_to_jyear(mjd: float) -> float:
    return 2000.0 + (mjd - MJD_J2000) / 365.25


def jyear_to_mjd(jy: float) -> float:
    return MJD_J2000 + (jy - 2000.0) * 365.25


def propagate(ra, dec, pmra, pmdec, epoch, mjd):
    """Linear proper-motion propagation (pm in mas/yr, pmra includes cos dec) to time `mjd`."""
    if pmra is None and pmdec is None:
        return ra, dec
    if epoch is None:
        return ra, dec
    dt = mjd_to_jyear(mjd) - epoch
    xi = (pmra or 0.0) * dt / 1000.0
    eta = (pmdec or 0.0) * dt / 1000.0
    r, d = std_to_sky(xi, eta, ra, dec)
    return float(r), float(d)


# --- Wavelength lookup (WAVE-TAB alternate WCS 'W') -----------------------------

@dataclass(frozen=True)
class WaveTable:
    x: np.ndarray  # control points along detector x (1-based pixels), shape (nx,)
    y: np.ndarray  # control points along detector y, shape (ny,)
    values: np.ndarray  # shape (ny, nx, 2): [..., 0] wavelength um, [..., 1] bandwidth um

    def to_json(self) -> dict:
        return {"x": self.x.tolist(), "y": self.y.tolist(), "values": self.values.tolist()}

    @classmethod
    def from_json(cls, d: dict) -> "WaveTable":
        return cls(np.asarray(d["x"], float), np.asarray(d["y"], float),
                   np.asarray(d["values"], float))

    @classmethod
    def from_row(cls, row: dict) -> "WaveTable":
        x = np.asarray(row["X"], float).ravel()
        y = np.asarray(row["Y"], float).ravel()
        v = np.asarray(row["VALUES"], float).reshape(len(y), len(x), 2)
        return cls(x, y, v)


def _frac_index(grid: np.ndarray, p):
    p = np.asarray(p, float)
    i = np.clip(np.searchsorted(grid, p, side="right") - 1, 0, len(grid) - 2)
    t = (p - grid[i]) / (grid[i + 1] - grid[i])
    return i, t  # t may be <0 or >1 (linear extrapolation at the borders)


def wave_lookup(table: WaveTable, det_x, det_y):
    """Bilinear lookup at 1-based full-detector pixel coordinates -> (wavelength, bandwidth)."""
    ix, tx = _frac_index(table.x, det_x)
    iy, ty = _frac_index(table.y, det_y)
    v = table.values
    tx = tx[..., None]
    ty = ty[..., None]
    out = ((1 - tx) * (1 - ty) * v[iy, ix] + tx * (1 - ty) * v[iy, ix + 1]
           + (1 - tx) * ty * v[iy + 1, ix] + tx * ty * v[iy + 1, ix + 1])
    return out[..., 0], out[..., 1]


def cutout_to_detector(header, x0, y0):
    """0-based cutout pixel -> 1-based full-detector lookup coordinate (p - CRPIXnW + 1)."""
    crpix1 = float(header.get("CRPIX1W", 0.0))
    crpix2 = float(header.get("CRPIX2W", 0.0))
    crval1 = float(header.get("CRVAL1W", 1.0))
    crval2 = float(header.get("CRVAL2W", 1.0))
    cd1 = float(header.get("CDELT1W", 1.0))
    cd2 = float(header.get("CDELT2W", 1.0))
    return (crval1 + cd1 * (np.asarray(x0) + 1.0 - crpix1),
            crval2 + cd2 * (np.asarray(y0) + 1.0 - crpix2))
