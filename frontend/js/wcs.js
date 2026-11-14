// Gnomonic (TAN) projection helpers matching the API contract:
// north-up, east-left, row 0 = north, column 0 = east, centre pixel c = (npix-1)/2.
const D2R = Math.PI / 180;

export function makeWcs(ra0, dec0, scale, npix) {
  const c = (npix - 1) / 2;
  const sd0 = Math.sin(dec0 * D2R), cd0 = Math.cos(dec0 * D2R);
  return {
    ra0, dec0, scale, npix, c,
    /** sky -> pixel. Returns null on the far hemisphere. */
    toPix(ra, dec) {
      const da = (ra - ra0) * D2R, d = dec * D2R;
      const sd = Math.sin(d), cd = Math.cos(d), cda = Math.cos(da);
      const cosc = sd0 * sd + cd0 * cd * cda;
      if (cosc <= 1e-6) return null;
      const xi = (cd * Math.sin(da) / cosc) / D2R * 3600;
      const eta = ((cd0 * sd - sd0 * cd * cda) / cosc) / D2R * 3600;
      return { x: c - xi / scale, y: c - eta / scale, xi, eta };
    },
    /** pixel -> sky (degrees) */
    toSky(x, y) {
      const xi = (c - x) * scale / 3600 * D2R, eta = (c - y) * scale / 3600 * D2R;
      const rho = Math.hypot(xi, eta);
      if (rho === 0) return { ra: ra0, dec: dec0 };
      const cc = Math.atan(rho), sc = Math.sin(cc), cosc = Math.cos(cc);
      const dec = Math.asin(cosc * sd0 + eta * sc * cd0 / rho);
      const ra = ra0 * D2R + Math.atan2(xi * sc, rho * cd0 * cosc - eta * sd0 * sc);
      return { ra: (((ra / D2R) % 360) + 360) % 360, dec: dec / D2R };
    },
  };
}

export const mjdToYear = (mjd) => 2000 + (mjd - 51544.5) / 365.25;
export const mjdToDate = (mjd) => new Date((mjd - 40587) * 86400000);
export function fmtDate(mjd, iso) {
  const s = iso || mjdToDate(mjd).toISOString();
  return s.replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Proper-motion propagation, linear in the tangent plane (same as the backend).
 * pm in mas/yr (pmra includes cos dec); epochs are Julian years.
 */
export function propagate(ra, dec, pmra, pmdec, fromYear, toYear) {
  const dt = toYear - fromYear;
  if (!dt || (!pmra && !pmdec)) return { ra, dec };
  // makeWcs with scale 1"/px and npix 1 (c = 0): x = -xi, y = -eta in arcsec.
  return makeWcs(ra, dec, 1, 1).toSky(-((pmra || 0) * dt) / 1000, -((pmdec || 0) * dt) / 1000);
}

export function fmtRA(deg) {
  const h = (((deg % 360) + 360) % 360) / 15;
  const hh = Math.floor(h), m = (h - hh) * 60, mm = Math.floor(m), ss = (m - mm) * 60;
  return `${String(hh).padStart(2, '0')}h${String(mm).padStart(2, '0')}m${ss.toFixed(2).padStart(5, '0')}s`;
}
export function fmtDec(deg) {
  const s = deg < 0 ? '−' : '+', a = Math.abs(deg);
  const d = Math.floor(a), m = (a - d) * 60, mm = Math.floor(m), ss = (m - mm) * 60;
  return `${s}${String(d).padStart(2, '0')}°${String(mm).padStart(2, '0')}′${ss.toFixed(1).padStart(4, '0')}″`;
}
