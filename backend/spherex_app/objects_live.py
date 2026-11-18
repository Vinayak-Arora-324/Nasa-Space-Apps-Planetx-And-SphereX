"""Live object sources: the built-in solar-system ephemeris ("ephem") and IMCCE SkyBoT ("skybot").

Frame: ICRS equatorial Cartesian axes, origin at the Sun, positions in AU (x toward RA=0 Dec=0, y
toward RA=90 Dec=0, z toward Dec=+90). Light-time is ignored everywhere, as in the 2D movers code.

* ephem   (precedence 10; kinds sun, planet, moon): the Sun, the eight planets *including Earth*, and
  the Moon, from astropy's built-in ephemeris. Always returned whole, whatever the cone.
* skybot  (precedence 20; kinds dwarf_planet, asteroid, comet): SkyBoT's cone search, one record per
  object. Which kind a SkyBoT object gets is decided here (see `classify`); a dwarf planet is
  identified only by its minor-planet number, never by SkyBoT's class string.

Earth's `position` has no `geo` (the geocentre is the observer, so it has no direction), and
`in_cone` is always False for it.

The helpers `radec_to_xyz`, `PLANETS`, `solar_positions` and `bodies_xyz` used to live in scene3d.py,
which still re-exports them. This module must not import scene3d.
"""

from __future__ import annotations

import asyncio
import functools
import math
import re

import astropy
from astropy import units as u
from astropy.coordinates import get_body_barycentric
from astropy.time import Time

from . import movers
from .objects import Query, Source, quantity, record

SKYBOT_JD_OFFSET = 2400000.5

# (display name, astropy body id); Earth is returned separately, Sun is the origin
PLANETS = (
    ("Mercury", "mercury"), ("Venus", "venus"), ("Mars", "mars"), ("Jupiter", "jupiter"),
    ("Saturn", "saturn"), ("Uranus", "uranus"), ("Neptune", "neptune"), ("Moon", "moon"),
)

# IAU equatorial radii (km) and NAIF ids. Earth and the Moon follow the same WGCCRE 2015 report.
RADII_KM = {"Mercury": 2440, "Venus": 6052, "Earth": 6378, "Moon": 1737, "Mars": 3396,
            "Jupiter": 71492, "Saturn": 60268, "Uranus": 25559, "Neptune": 24764}
SUN_RADIUS_KM = 695700
NAIF = {"Sun": 10, "Mercury": 199, "Venus": 299, "Earth": 399, "Moon": 301, "Mars": 499,
        "Jupiter": 599, "Saturn": 699, "Uranus": 799, "Neptune": 899}
# Dwarf planets, by minor-planet number (never by SkyBoT class): Ceres, Pluto, Haumea, Makemake, Eris
DWARF_PLANET_NUMBERS = frozenset({1, 134340, 136199, 136108, 136472})

_COMET_NAME = re.compile(r"^\d+[PDI](/|$)|^[CPDXI]/")
_PERIODIC = re.compile(r"^(\d+[PDI])/")

EPHEM_SRC = "astropy built-in ephemeris"
EPHEM_POSITION_SRC = "astropy built-in ephemeris (ERFA plan94/epv00)"
RADIUS_SRC = "IAU WGCCRE 2015 equatorial radius"
SUN_RADIUS_SRC = "IAU 2015 nominal solar radius"
SKYBOT_SRC = "IMCCE SkyBoT"
SKYBOT_POSITION_SRC = ("IMCCE SkyBoT, geocentric RA/Dec and distance; "
                       "heliocentric xyz = Earth + dg·û (light-time ignored)")

EPHEM_PROVENANCE = {
    "source": "ephem", "catalogue": "astropy built-in solar-system ephemeris",
    "version": f"astropy {astropy.__version__}", "citation": "Astropy Collaboration 2022; ERFA",
    "url": "https://docs.astropy.org/en/stable/coordinates/solarsystem.html",
}
SKYBOT_PROVENANCE = {
    "source": "skybot", "catalogue": "IMCCE SkyBoT", "version": None,
    "citation": "Berthier et al. 2006, ASP Conf. Ser. 351, 367",
    "url": "https://ssp.imcce.fr/webservices/skybot/",
}


def _f(v) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def radec_to_xyz(ra: float, dec: float, d: float = 1.0) -> tuple[float, float, float]:
    """Equatorial (ICRS) RA/Dec in degrees at distance d -> Cartesian (x toward RA=0, z toward pole)."""
    r, dd = math.radians(ra), math.radians(dec)
    cd = math.cos(dd)
    return (d * cd * math.cos(r), d * cd * math.sin(r), d * math.sin(dd))


def xyz_to_radec(x: float, y: float, z: float) -> tuple[float, float, float]:
    """Cartesian -> (ra deg in [0, 360), dec deg, distance). A zero vector gives (0, 0, 0)."""
    d = math.sqrt(x * x + y * y + z * z)
    if d == 0.0:
        return 0.0, 0.0, 0.0
    return math.degrees(math.atan2(y, x)) % 360.0, math.degrees(math.asin(max(-1.0, min(1.0, z / d)))), d


def solar_positions(mjd: float) -> dict:
    """Earth and the planets/Moon relative to the Sun, AU, ICRS axes (built-in ephemeris)."""
    t = Time(mjd, format="mjd", scale="tdb")
    sun = get_body_barycentric("sun", t)

    def rel(body: str) -> list[float]:
        xyz = (get_body_barycentric(body, t) - sun).xyz.to_value(u.au)
        return [round(float(v), 6) for v in xyz]

    planets = []
    for name, body in PLANETS:
        x, y, z = rel(body)
        planets.append({"name": name, "x": x, "y": y, "z": z})
    return {"earth": rel("earth"), "planets": planets}


@functools.lru_cache(maxsize=64)
def earth_xyz(mjd: float) -> tuple[float, float, float]:
    """Earth relative to the Sun, AU, ICRS axes (cached per epoch, shared by both live sources so a
    planet-list failure does not lose the small bodies)."""
    t = Time(mjd, format="mjd", scale="tdb")
    sun = get_body_barycentric("sun", t)
    xyz = (get_body_barycentric("earth", t) - sun).xyz.to_value(u.au)
    return tuple(round(float(v), 6) for v in xyz)  # type: ignore[return-value]


def bodies_xyz(earth: list[float], objs: list[dict]) -> list[dict]:
    """SkyBoT objects -> heliocentric positions: earth + dg * unit(geocentric RA/Dec).

    Light-time is ignored. Objects without a geocentric distance are skipped."""
    ex, ey, ez = earth
    out = []
    for o in objs:
        dg = _f(o.get("dg_au"))
        if dg is None or dg <= 0:
            continue
        ux, uy, uz = radec_to_xyz(o["ra"], o["dec"], 1.0)
        dh = _f(o.get("dh_au"))
        out.append({
            "name": o.get("name") or "", "number": o.get("number"), "class": o.get("class"),
            "vmag": _f(o.get("vmag")),
            "x": round(ex + dg * ux, 6), "y": round(ey + dg * uy, 6), "z": round(ez + dg * uz, 6),
            "dg_au": round(dg, 6), "dh_au": None if dh is None else round(dh, 6),
        })
    return out


# --- ephem source ----------------------------------------------------------------------------

def _geo(xyz: list[float] | tuple[float, ...], earth: list[float] | tuple[float, ...]) -> dict:
    """Direction and distance of a heliocentric position seen from Earth (light-time ignored)."""
    ra, dec, d = xyz_to_radec(xyz[0] - earth[0], xyz[1] - earth[1], xyz[2] - earth[2])
    return {"ra": round(ra, 5), "dec": round(dec, 5), "dist_au": round(d, 6)}


def _state(mjd: float, xyz: list[float], geo: dict | None) -> dict:
    pos = {"model": "state", "mjd": mjd, "xyz_au": list(xyz), "method": "ephemeris",
           "src": EPHEM_POSITION_SRC, "tier": "measured"}
    if geo is not None:
        pos["geo"] = geo
    return pos


def ephem_records(mjd: float) -> list[dict]:
    """Records for the Sun, the eight planets (Earth included) and the Moon at `mjd`."""
    sol = solar_positions(mjd)
    earth = list(earth_xyz(mjd))
    prov = EPHEM_PROVENANCE
    out = []

    def dist_q(v: float) -> dict:
        return quantity(round(v, 6), EPHEM_SRC, "measured", "au")

    sun_geo = _geo([0.0, 0.0, 0.0], earth)
    out.append(record(
        id="ss:sun", kind="sun", name="Sun", designations=[f"NAIF {NAIF['Sun']}"],
        host="ss:sun", parent=None, position=_state(mjd, [0.0, 0.0, 0.0], sun_geo),
        size={"radius": quantity(SUN_RADIUS_KM, SUN_RADIUS_SRC, "measured", "km"), "angular": None},
        props={"dist_earth": dist_q(sun_geo["dist_au"])}, provenance=prov, evidence="measured"))

    bodies = [(p["name"], "moon" if p["name"] == "Moon" else "planet", [p["x"], p["y"], p["z"]])
              for p in sol["planets"]]
    bodies.append(("Earth", "planet", earth))
    for name, kind, xyz in bodies:
        is_earth = name == "Earth"
        geo = None if is_earth else _geo(xyz, earth)
        props = {"dist_sun": dist_q(math.sqrt(sum(c * c for c in xyz)))}
        if geo is not None:
            props["dist_earth"] = dist_q(geo["dist_au"])
        out.append(record(
            id=f"ss:{name.lower()}", kind=kind, name=name, designations=[f"NAIF {NAIF[name]}"],
            host="ss:sun", parent="ss:earth" if name == "Moon" else "ss:sun",
            position=_state(mjd, xyz, geo),
            size={"radius": quantity(RADII_KM[name], RADIUS_SRC, "measured", "km"), "angular": None},
            props=props, provenance=prov, evidence="measured"))
    return out


async def _fetch_ephem(q: Query) -> list[dict]:
    return await asyncio.to_thread(ephem_records, q.mjd)


# --- skybot source ---------------------------------------------------------------------------

def classify(obj: dict) -> str:
    """Kind of one parsed SkyBoT object: dwarf_planet (by minor-planet number only), comet (class
    starts with "Comet", or a comet designation as name) or asteroid. "Centaur" is an asteroid."""
    if obj.get("number") in DWARF_PLANET_NUMBERS:
        return "dwarf_planet"
    cls = str(obj.get("class") or "")
    if cls.lower().startswith("comet") or _COMET_NAME.match(str(obj.get("name") or "")):
        return "comet"
    return "asteroid"


def comet_designation(name: str) -> str:
    """"29P/Schwassmann-Wachmann" -> "29P"; "C/2020 F3 (NEOWISE)" -> "C/2020 F3"."""
    m = _PERIODIC.match(name)
    return m.group(1) if m else name.split(" (")[0].strip()


def skybot_record(obj: dict, body: dict, mjd: float, jd: float) -> dict | None:
    """One record for a SkyBoT object `obj` (movers.parse_skybot) and its `bodies_xyz` row `body`.
    None when the object has no usable name or number."""
    kind = classify(obj)
    number, raw_name = obj.get("number"), (obj.get("name") or "").strip()
    designations: list[str] = []
    if kind == "comet" and raw_name:
        desig = comet_designation(raw_name)
        rid, name = f"comet:{desig}", raw_name
        designations = [desig]
    elif number is not None:
        rid, name = f"mp:{number}", raw_name or str(number)
        designations = [str(number)] if str(number) != name else []
    elif raw_name:
        rid, name = f"mp:{raw_name}", raw_name
    else:
        return None
    vmag = body["vmag"]
    vsrc = f"{SKYBOT_SRC} (total magnitude)" if kind == "comet" else SKYBOT_SRC
    props = {}
    if obj.get("class"):
        props["class"] = quantity(str(obj["class"]), SKYBOT_SRC, "catalogue")
    if vmag is not None:
        props["vmag"] = quantity(vmag, vsrc, "catalogue", "mag")
    if body["dh_au"] is not None:
        props["dist_sun"] = quantity(body["dh_au"], SKYBOT_SRC, "catalogue", "au")
    props["dist_earth"] = quantity(body["dg_au"], SKYBOT_SRC, "catalogue", "au")
    err = _f(obj.get("err_arcsec"))
    if err is not None:
        props["pos_err"] = quantity(err, SKYBOT_SRC, "catalogue", "arcsec")
    position = {
        "model": "state", "mjd": mjd, "xyz_au": [body["x"], body["y"], body["z"]],
        "geo": {"ra": round(float(obj["ra"]), 5), "dec": round(float(obj["dec"]), 5),
                "dist_au": body["dg_au"]},
        "method": "orbit-propagation", "src": SKYBOT_POSITION_SRC, "tier": "catalogue",
    }
    prov = dict(SKYBOT_PROVENANCE, query={"epoch_jd": jd, "observer": "500"})
    return record(
        id=rid, kind=kind, name=name, designations=designations, host="ss:sun", parent="ss:sun",
        position=position, size=None, props=props, provenance=prov, evidence="measured",
        render={} if vmag is None else {"mag": vmag})


async def _fetch_skybot(q: Query) -> list[dict]:
    jd = q.mjd + SKYBOT_JD_OFFSET
    objs = await movers.skybot_cone(q.ra, q.dec, q.radius, jd)
    earth = list(await asyncio.to_thread(earth_xyz, q.mjd))
    out = []
    for o in objs:
        rows = bodies_xyz(earth, [o])  # same maths as bodies_xyz; skips objects without a distance
        if not rows:
            continue
        rec = skybot_record(o, rows[0], q.mjd, jd)
        if rec is not None:
            out.append(rec)
    return out


def sources() -> list[Source]:
    """The two live sources."""
    return [
        Source("ephem", ("sun", "planet", "moon"), 10, _fetch_ephem, EPHEM_PROVENANCE, cone=False),
        Source("skybot", ("dwarf_planet", "asteroid", "comet"), 20, _fetch_skybot,
               SKYBOT_PROVENANCE, cone=True),
    ]
