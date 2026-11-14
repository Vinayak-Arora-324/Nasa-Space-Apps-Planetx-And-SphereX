"""Name/coordinate resolution (CDS Sesame) and reference catalogues (Gaia DR3, CatWISE2020)."""

from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET

from astropy import units as u
from astropy.coordinates import Angle

from . import cache, config
from .archive import UpstreamError, get_text, tap_csv
from .geometry import mjd_to_jyear


class NotFound(LookupError):
    pass


# --- coordinates ------------------------------------------------------------------

_COORD_CHARS = re.compile(r"^[\d\s:.,+\-hmsd°'\"′″]+$")
_NUM = r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?"


def parse_coordinates(q: str) -> tuple[float, float] | None:
    """Parse decimal-degree or sexagesimal (RA in hours) coordinates; None if not coordinates."""
    s = q.strip()
    if not s or not _COORD_CHARS.match(s) or len(re.findall(r"\d+", s)) < 2:
        return None
    s = s.replace("°", "d").replace("′", "m").replace("″", "s").replace("'", "m").replace('"', "s")
    toks = [t for t in re.split(r"[\s,]+", s) if t]
    # decimal degrees: exactly two plain numbers
    if len(toks) == 2 and all(re.fullmatch(_NUM, t) for t in toks):
        ra, dec = float(toks[0]), float(toks[1])
    else:
        # split RA/Dec: at the sign of Dec, or half of the tokens
        m = re.match(r"^\s*(.+?)[\s,]+([+-].*)$", s)
        if m:
            ra_s, dec_s = m.group(1), m.group(2)
        elif len(toks) == 2:
            ra_s, dec_s = toks
        elif len(toks) % 2 == 0:
            ra_s, dec_s = " ".join(toks[:len(toks) // 2]), " ".join(toks[len(toks) // 2:])
        else:
            return None
        ra_s = ra_s.replace(",", " ").strip()
        dec_s = dec_s.replace(",", " ").strip()
        try:
            if re.fullmatch(_NUM, ra_s) and re.fullmatch(_NUM, dec_s):
                ra, dec = float(ra_s), float(dec_s)
            else:
                ra_unit = u.deg if "d" in ra_s else u.hourangle
                ra = Angle(_sexa(ra_s), unit=ra_unit).degree
                dec = Angle(_sexa(dec_s), unit=u.deg).degree
        except (ValueError, u.UnitsError):
            return None
    if not (0.0 <= ra < 360.0 or math.isclose(ra, 360.0)) or not -90.0 <= dec <= 90.0:
        return None
    return ra % 360.0, dec


def _sexa(s: str) -> str:
    """Normalise '08 55 10.8' / '08:55:10.8' / '08h55m10.8s' for astropy Angle."""
    s = s.strip()
    if re.search(r"[hdms]", s):
        return s
    parts = re.split(r"[\s:]+", s)
    return ":".join(parts)


# --- Sesame --------------------------------------------------------------------------

def _fnum(el, path):
    if el is None:
        return None
    t = el.findtext(path)
    try:
        return float(t) if t is not None and t.strip() else None
    except ValueError:
        return None


def parse_sesame(xml_text: str, q: str) -> dict:
    root = ET.fromstring(xml_text)
    for res in root.iter("Resolver"):
        ra, dec = _fnum(res, "jradeg"), _fnum(res, "jdedeg")
        if ra is None or dec is None:
            continue
        pm = res.find("pm")
        pmra, pmdec = _fnum(pm, "pmRA"), _fnum(pm, "pmDE")
        plx = _fnum(res.find("plx"), "v")
        has_pm = pmra is not None or pmdec is not None
        name = (res.findtext("oname") or q).strip()
        return {"name": name, "ra": ra, "dec": dec, "pmra": pmra, "pmdec": pmdec, "plx": plx,
                "epoch": 2000.0 if has_pm else None,
                "otype": (res.findtext("otype") or None), "source": "sesame"}
    raise NotFound(f"could not resolve '{q}'")


_resolve_mem = cache.TTLCache(config.RESOLVE_TTL_S, maxsize=1024)


async def resolve(q: str) -> dict:
    q = q.strip()
    c = parse_coordinates(q)
    if c is not None:
        return {"name": q, "ra": c[0], "dec": c[1], "pmra": None, "pmdec": None, "plx": None,
                "epoch": None, "otype": None, "source": "coordinates"}
    key = q.lower()
    hit = _resolve_mem.get(key)
    if hit is not None:
        return hit
    from urllib.parse import quote
    text = await get_text(f"{config.SESAME_URL}?{quote(q)}", what="Sesame")
    out = parse_sesame(text, q)
    _resolve_mem.put(key, out)
    return out


# --- reference catalogues --------------------------------------------------------------

def _num(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


async def catalog(cat: str, ra: float, dec: float, radius: float) -> list[dict]:
    key = cache.key_hash(cat, f"{ra:.6f}", f"{dec:.6f}", f"{radius:.5f}")
    hit = cache.get_json("catalog", key, ttl=config.CATALOG_TTL_S)
    if hit is not None:
        return hit
    if cat == "gaia":
        rows = await tap_csv(config.GAIA_TAP_SYNC, config.GAIA_ADQL.format(ra=ra, dec=dec, r=radius),
                             irsa=False, what="Gaia TAP")
        out = [{"id": r.get("source_id"), "ra": _num(r.get("ra")), "dec": _num(r.get("dec")),
                "pmra": _num(r.get("pmra")), "pmdec": _num(r.get("pmdec")),
                "plx": _num(r.get("parallax")), "mag": _num(r.get("phot_g_mean_mag")),
                "epoch": 2016.0} for r in rows]
    elif cat == "catwise":
        rows = await tap_csv(config.IRSA_TAP_SYNC,
                             config.CATWISE_ADQL.format(ra=ra, dec=dec, r=radius),
                             irsa=True, what="CatWISE TAP")
        out = []
        for r in rows:
            pmra, pmdec, mjd = _num(r.get("pmra")), _num(r.get("pmdec")), _num(r.get("meanobsmjd"))
            out.append({"id": (r.get("source_name") or "").strip(), "ra": _num(r.get("ra")),
                        "dec": _num(r.get("dec")),
                        "pmra": pmra * 1000.0 if pmra is not None else None,  # arcsec/yr -> mas/yr
                        "pmdec": pmdec * 1000.0 if pmdec is not None else None,
                        "plx": None, "mag": _num(r.get("w2mpro_pm")),
                        "epoch": round(mjd_to_jyear(mjd), 4) if mjd is not None else None})
    else:
        raise ValueError("cat must be 'gaia' or 'catwise'")
    out = [s for s in out if s["ra"] is not None and s["dec"] is not None]
    cache.put_json("catalog", key, out)
    return out


__all__ = ["resolve", "catalog", "parse_coordinates", "parse_sesame", "NotFound", "UpstreamError"]
