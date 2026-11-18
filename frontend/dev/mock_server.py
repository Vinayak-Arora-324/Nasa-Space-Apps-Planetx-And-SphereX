#!/usr/bin/env python3
"""Development-only mock of the SPHEREx sky-viewer API (stdlib only).

    python3 frontend/dev/mock_server.py [port]      # default 8799
    open http://localhost:8799/?ra=133.795129&dec=-7.245147&fov=0.1

Synthetic sky (offsets xi=east, eta=north in arcsec from the request centre):
  NE star  (+80,+60)  -> must render UPPER-LEFT (north up, east left)
  SW star  (-60,-45), S star (+25,-70), faint (-30,+20), E star (+95,-20)
  variable (-40,+45): brightness varies sinusoidally with time
  mover: at the request position at `epoch` (+pm*dt). Default pm ~7 "/yr if none given.
3 epochs (MJD ~60800, 61000, 61200) x 6 detectors x 8 frames, wavelength varying per frame.

Blink extensions: stream `model=1` (extra background + leftover planes, fitted-source metadata,
field stars, moving objects) or `model=progressive` (raw frames first, then one `model` record per
ok frame carrying the background + leftover planes), `per_visit`, fov up to 3.5 (client picks scale), /api/coverage,
/api/movers/{known,linked,search/*}. If frontend/js/blink/skygl.js does not exist yet, a Canvas2D
stub (dev/skygl-stub.js) is served in its place so the shell can be tested alone.
"""
import json, math, os, random, re, struct, sys, time, mimetypes, threading, uuid
from array import array
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
BANDS = {1: (0.75, 1.09), 2: (1.10, 1.62), 3: (1.63, 2.41), 4: (2.42, 3.82), 5: (3.83, 4.41), 6: (4.42, 5.00)}
EPOCH_START = [60800.0, 61000.0, 61200.0]
FLAG_BITS = {"TRANSIENT": 0, "OVERFLOW": 1, "SUR_ERROR": 2, "NONFUNC": 6, "MISSING_DATA": 7, "HOT": 9, "COLD": 10, "SOURCE": 21}
BAD_MASK = (1 << 6) | (1 << 7) | (1 << 9) | (1 << 2)
NAMES = {
    "barnard's star": ("Barnard's Star", 269.4520, 4.6934, -798.58, 10328.12, 546.98, 2016.0, "M4V"),
    "epsilon indi b": ("eps Ind B", 331.0437, -56.7828, 3966.0, -2536.0, 274.8, 2000.0, "BD"),
    "eps ind b": ("eps Ind B", 331.0437, -56.7828, 3966.0, -2536.0, 274.8, 2000.0, "BD"),
    "wise j085510.83-071442.5": ("WISE J085510.83-071442.5", 133.795129, -7.245147, None, None, None, None, "BD"),
    "rw aur": ("RW Aur", 76.9567, 30.4015, 0.0, 0.0, 6.0, 2000.0, "TTau"),
    "rw aurigae": ("RW Aur", 76.9567, 30.4015, 0.0, 0.0, 6.0, 2000.0, "TTau"),
    "r dra": ("R Dra", 248.1750, 66.7544, -2.0, 11.0, 3.0, 2000.0, "Mira"),
    "r draconis": ("R Dra", 248.1750, 66.7544, -2.0, 11.0, 3.0, 2000.0, "Mira"),
}
JOBS = {}
LAST = {"pmra": None, "pmdec": None, "epoch": None}
STARS = [  # (xi, eta, peak at 1um [MJy/sr], pm-free)
    (80, 60, 40.0), (-60, -45, 25.0), (25, -70, 18.0), (-30, 20, 8.0), (95, -20, 15.0)]
VAR = (-40, 45, 25.0)


def mjd_year(m): return 2000 + (m - 51544.5) / 365.25


def parse_coords(q):
    s = q.strip().replace('−', '-')
    m = re.match(r'^\s*([+-]?\d+(?:\.\d+)?)[\s,]+([+-]?\d+(?:\.\d+)?)\s*$', s)
    if m: return float(m[1]), float(m[2])
    m = re.match(r'^\s*(\d+)\s*[h: ]\s*(\d+)\s*[m: ]\s*([\d.]+)\s*s?[\s,]+([+-]?)\s*(\d+)\s*[d°: ]\s*(\d+)\s*[m\'′: ]\s*([\d.]+)', s)
    if m:
        ra = 15 * (int(m[1]) + int(m[2]) / 60 + float(m[3]) / 3600)
        dec = int(m[5]) + int(m[6]) / 60 + float(m[7]) / 3600
        return ra, -dec if m[4] == '-' else dec
    return None


def frame_list(ra, dec):
    out = []
    rnd = random.Random(1234)
    for det in range(1, 7):
        for e, t0 in enumerate(EPOCH_START):
            for k in range(8):
                mjd = t0 + k * 0.9 + det * 0.05 + rnd.random() * 0.3
                lo, hi = BANDS[det]
                frac = (k * 0.137 + e * 0.29 + det * 0.05 + rnd.random() * 0.05) % 1.0
                out.append(dict(id=f"mock_{det}_{e+1}_{k}", obsid=f"2025W{e+1:02d}_{k:04d}_D{det}", detector=det, mjd=round(mjd, 5),
                                mjd_end=round(mjd + 0.0012, 5), exptime=112.5, release="qr2", version="6.5.2", pipeline="mock",
                                _wl=lo + (hi - lo) * frac, _e=e, _k=k))
    out.sort(key=lambda f: f['mjd'])
    return out


def select(params, ra, dec):
    fl = frame_list(ra, dec)
    dets = [int(x) for x in params.get('detectors', '1,2,3,4,5,6').split(',') if x]
    fl = [f for f in fl if f['detector'] in dets]
    if params.get('mjd_min'): fl = [f for f in fl if f['mjd'] >= float(params['mjd_min'])]
    if params.get('mjd_max'): fl = [f for f in fl if f['mjd'] <= float(params['mjd_max'])]
    pv = int(params.get('per_visit') or 0)
    if pv > 0:  # at most pv frames per (detector, visit), spread evenly; visit gap > 20 d
        out = []
        for d in dets:
            sub = sorted((f for f in fl if f['detector'] == d), key=lambda f: f['mjd'])
            groups = []
            for f in sub:
                if groups and f['mjd'] - groups[-1][-1]['mjd'] <= 20: groups[-1].append(f)
                else: groups.append([f])
            for g in groups:
                out += g if len(g) <= pv else [g[int(i * len(g) / pv)] for i in range(pv)]
        fl = sorted(out, key=lambda f: f['mjd'])
    total = len(fl)
    cap = int(params.get('max_frames', 400))
    if total > cap:
        out = []
        for d in dets:
            sub = [f for f in fl if f['detector'] == d]
            n = max(1, round(cap * len(sub) / total))
            out += [sub[int(i * len(sub) / n)] for i in range(n)] if n < len(sub) else sub
        fl = out
    return total, fl


def mover_offset(mjd, pm):
    """offset (xi, eta) arcsec of the mover at time mjd."""
    pmra, pmdec, epoch = pm
    if pmra is None:
        dt = mjd_year(mjd) - 2026.4
        return -15 + (-6.0) * dt, -10 + 4.0 * dt
    dt = mjd_year(mjd) - epoch
    return pmra * dt / 1000.0, pmdec * dt / 1000.0


MOVERS = [  # offsets in arcsec at visit start, rates in arcsec/hour (east, north)
    dict(id="K1", name="Ceres", number=1, cls="MB>Middle", vmag=16.9, xi0=-70, eta0=30, vx=0.35, vy=-0.18, amp=14.0, kind="known", modelled=True),
    dict(id="M1", name="M1", xi0=40, eta0=-55, vx=-0.25, vy=0.40, amp=9.0, kind="linked", modelled=True),
    dict(id="C1", name="C1", xi0=10, eta0=70, vx=0.30, vy=0.10, amp=2.4, kind="candidate", modelled=False),
]


def mover_xy(m, mjd):
    t0 = max(t for t in EPOCH_START if t <= mjd + 1e-6)
    h = (mjd - t0) * 24
    return m['xi0'] + m['vx'] * h, m['eta0'] + m['vy'] * h


def rate_pa(m):
    return math.hypot(m['vx'], m['vy']), (math.degrees(math.atan2(m['vx'], m['vy'])) % 360)


def field_stars(ra, dec, npix, scale):
    rnd = random.Random(int(round(ra * 100)) * 1000 + int(round(dec * 100)) + 7)
    c = (npix - 1) / 2
    out = []
    count = min(180, 30 + (npix * npix) // 500)
    for i in range(count):
        amp = 1.5 * (1 - rnd.random()) ** -0.9
        out.append(dict(xi=(rnd.random() - 0.5) * (npix - 8) * scale, eta=(rnd.random() - 0.5) * (npix - 8) * scale, amp=min(amp, 25.0),
                        gaia=rnd.random() < 0.7, plx=rnd.choice([None, 0.8, 3.1, 12.5, 54.0]), i=i))
    return out


def pm_of(p):
    if p.get('pmra') not in (None, '') and p.get('pmdec') not in (None, ''):
        return float(p['pmra']), float(p['pmdec']), float(p.get('epoch') or 2000.0)
    return None, None, None


def render(f, npix, scale, pm, model=None):
    """Return (img array('f'), flags array('I'), metadata dict). model: dict with ra/dec to add Blink planes."""
    det = f['detector']; mjd = f['mjd']
    seed = int(mjd * 1000) + det
    rnd = random.Random(seed)
    c = (npix - 1) / 2
    fwhm = 5.5 + 0.7 * det  # arcsec
    sig = fwhm / 2.355 / scale
    wl = f['_wl']
    sp = (wl / 1.0) ** -1.5 * (1.0 if det < 4 else 1.4) * (0.25 if model else 1.0)
    noise = 0.04 + 0.01 * det
    gscale = 60.0 / max(npix, 60)
    b0 = (rnd.random() - 0.5) * (0.12 if model else 3.0)
    gx = (rnd.random() - 0.5) * (0.004 if model else 0.02) * gscale
    gy = (rnd.random() - 0.5) * (0.004 if model else 0.02) * gscale
    img = array('f', [0.0]) * (npix * npix)
    for y in range(npix):
        row = y * npix
        for x in range(npix):
            img[row + x] = b0 + gx * (x - c) + gy * (y - c) + rnd.gauss(0, noise)
    flags = array('I', [0]) * (npix * npix)
    srcs = [(xi, eta, a) for xi, eta, a in STARS]
    va = VAR[2] * (1.0 + 0.5 * math.sin(2 * math.pi * (mjd - 60800) / 280.0))
    srcs.append((VAR[0], VAR[1], va))
    mo = mover_offset(mjd, pm)
    srcs.append((mo[0], mo[1], 30.0))
    msrc = None
    if model is not None:
        bgp = array('f', [0.0]) * (npix * npix)
        for y in range(npix):
            for x in range(npix): bgp[y * npix + x] = b0 + gx * (x - c) + gy * (y - c)
        msrc = []  # modelled sources: dicts
        extra = []
        for st in field_stars(model['ra'], model['dec'], npix, scale):
            extra.append((st['xi'], st['eta'], st['amp'] / sp if sp > 0 else st['amp']))
            cat = None
            if st['gaia']:
                cat = dict(catalog="gaia", id=f"Gaia DR3 {4000000000 + st['i'] * 7919}", mag=round(19 - 2.5 * math.log10(max(st['amp'], 0.1)), 2), sep_arcsec=0.4,
                           parallax_mas=st['plx'], pmra=-12.0 + st['i'], pmdec=4.0)
            msrc.append(dict(xi=st['xi'], eta=st['eta'], a=st['amp'] / sp, cat=cat, kind="extended" if st['i'] % 17 == 3 else "point", blend=None))
        for xi, eta, a in srcs[:len(STARS) + 1]:
            msrc.append(dict(xi=xi, eta=eta, a=a, cat=dict(catalog="gaia", id=f"Gaia DR3 {5000 + int(abs(xi))}", mag=12.5, sep_arcsec=0.3, parallax_mas=3.1, pmra=0.0, pmdec=0.0), kind="point", blend=None))
        # a close pair to exercise the blend list
        px, py = srcs[0][0] + 9, srcs[0][1] - 7
        extra.append((px, py, 12.0 / sp)); msrc.append(dict(xi=px, eta=py, a=12.0 / sp, cat=None, kind="point", blend=1))
        msrc[-len(STARS) - 2]['blend'] = 1
        for m in MOVERS:
            xi, eta = mover_xy(m, mjd)
            extra.append((xi, eta, m['amp'] / sp))
            if m['modelled']: msrc.append(dict(xi=xi, eta=eta, a=m['amp'] / sp, cat=None, kind="point", blend=None, mover=m['id']))
        srcs = srcs[:len(STARS) + 1] + extra
        modimg = array('f', [0.0]) * (npix * npix)
    if model is not None:
        # modelled = everything except the faint unmodelled candidate mover
        cand = {(round(mover_xy(m, mjd)[0], 6), round(mover_xy(m, mjd)[1], 6)) for m in MOVERS if not m['modelled']}
        modset = {t for t in srcs if (round(t[0], 6), round(t[1], 6)) not in cand}
    for xi, eta, a in srcs:
        cx, cy = c - xi / scale, c - eta / scale
        r = int(4 * sig) + 1
        for y in range(max(0, int(cy) - r), min(npix, int(cy) + r + 1)):
            for x in range(max(0, int(cx) - r), min(npix, int(cx) + r + 1)):
                v = a * sp * math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sig * sig))
                img[y * npix + x] += v
                if model is not None and (xi, eta, a) in modset: modimg[y * npix + x] += v
                if v > 0.5 * a * sp and a * sp > 8: flags[y * npix + x] |= 1 << 21
    hr = random.Random(det * 77)
    for _ in range(6):
        hx, hy = hr.randrange(npix), hr.randrange(npix)
        img[hy * npix + hx] += 3.0; flags[hy * npix + hx] |= 1 << 9
    if f['_k'] % 3 == 0:
        tx, ty = rnd.randrange(npix), rnd.randrange(npix); flags[ty * npix + tx] |= 1 << 0
    nan = float('nan')
    for y in range(npix - 8, npix):
        for x in range(npix - 12, npix): img[y * npix + x] = nan
    if f['_k'] % 5 == 4:
        for y in range(npix):
            for x in range(10, 13): img[y * npix + x] = nan
    info = dict(noise=noise, wl=wl, sig=sig)
    if model is not None:
        left = array('f', [0.0]) * (npix * npix)
        for i in range(npix * npix):
            v = img[i]
            left[i] = v - bgp[i] - modimg[i] if v == v else nan
        out = []
        for i, m in enumerate(msrc):
            x, y = c - m['xi'] / scale, c - m['eta'] / scale
            amp = m['a'] * sp
            s2 = sig * (2.2 if m['kind'] == 'extended' else 1.0)
            flux = amp * 2 * math.pi * s2 * s2
            d = dict(id=i, x=round(x, 3), y=round(y, 3), sx=0.04 + 0.12 / max(amp, 1.0), sy=0.04 + 0.12 / max(amp, 1.0), amp=round(amp, 3), flux=round(flux, 3),
                     flux_err=round(noise * 2 * math.pi * s2 * 1.5, 4), snr=round(amp / noise, 1), kind=m['kind'], fwhm=round(s2 * 2.355, 2), blend=m['blend'],
                     saturated=amp > 400, cat=m['cat'])
            out.append(d)
        info.update(bg=bgp, left=left, sources=out)
    return img, flags, info


def aperture(img, flags, npix, x0, y0, r):
    vals = [v for v in img if v == v]
    vals.sort(); med = vals[len(vals) // 2] if vals else 0.0
    s = 0.0; n = 0; fl = 0; nn = 0
    for y in range(max(0, int(y0 - r - 1)), min(npix, int(y0 + r + 2))):
        for x in range(max(0, int(x0 - r - 1)), min(npix, int(x0 + r + 2))):
            if (x - x0) ** 2 + (y - y0) ** 2 <= r * r:
                v = img[y * npix + x]; fl |= flags[y * npix + x]
                n += 1
                if v == v: s += v - med; nn += 1
    return s * 0.89, fl, nn, n


def target_px(f, npix, scale, pm, ra, dec):
    c = (npix - 1) / 2
    if pm[0] is None: xi = eta = 0.0
    else:
        dt = mjd_year(f['mjd']) - pm[2]; xi, eta = pm[0] * dt / 1000, pm[1] * dt / 1000
    return c - xi / scale, c - eta / scale


def frame_meta(f, npix, scale, pm, ra, dec, img, flags, info):
    tx, ty = target_px(f, npix, scale, pm, ra, dec)
    flux, fl, nn, n = aperture(img, flags, npix, tx, ty, 2.0)
    lo, hi = BANDS[f['detector']]
    sv = sorted(v for v in img if v == v)
    valid = len(sv) / len(img)
    return {
        "type": "frame", "ok": True, "id": f['id'], "obsid": f['obsid'], "detector": f['detector'], "mjd": f['mjd'],
        "date_iso": time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime((f['mjd'] - 40587) * 86400)),
        "exptime": f['exptime'], "wavelength_um": info['wl'], "bandwidth_um": (hi - lo) / 17.0,
        "dwave_dx": 0.0, "dwave_dy": (hi - lo) / 17.0 / 60.0 * 0.5, "psf_fwhm_arcsec": info['sig'] * 2.355 * scale,
        "zodi_median": 0.0, "bkg_median": sv[len(sv) // 2], "noise": info['noise'], "frac_valid": valid, "dqa": "Pass",
        "release": f['release'], "version": f['version'],
        "cutout_url": f"https://example.invalid/mock/cutout/{f['id']}.fits", "file_url": f"https://example.invalid/mock/full/{f['id']}.fits",
        "target": {"x": tx, "y": ty, "ra": ra, "dec": dec, "flux_mjy": flux, "flux_err_mjy": info['noise'] * math.sqrt(max(nn, 1)) * 0.89, "flags": fl},
    }


# ---- 3D fly-through (/api/scene3d): deterministic synthetic scene matching the backend contract ----
SCENE_N = 6000
OBLIQ = math.radians(23.4392911)
PLANETS_AU = [("Mercury", 0.387), ("Venus", 0.723), ("Earth", 1.0), ("Mars", 1.524), ("Jupiter", 5.203),
              ("Saturn", 9.537), ("Uranus", 19.19), ("Neptune", 30.07)]

def _ecl_to_icrs(X, Y, Z):
    """Ecliptic to ICRS equatorial: rotate about x by the obliquity."""
    return (X, Y * math.cos(OBLIQ) - Z * math.sin(OBLIQ), Y * math.sin(OBLIQ) + Z * math.cos(OBLIQ))

def mock_solar(ra, dec, radius, mjd):
    """Synthetic solar system: circular orbits with phases from mjd (Kepler periods), ecliptic -> ICRS,
    plus 3 small bodies near the line of sight. Returns (earth xyz, planets incl. Earth and the Moon, bodies)."""
    rng = random.Random(f"solar/{ra:.4f}/{dec:.4f}/{radius:.3f}")
    a0, d0 = math.radians(ra), math.radians(dec)
    t = 2 * math.pi * (mjd - 51544.5) / 365.25
    planets, earth = [], None
    for k, (name, au) in enumerate(PLANETS_AU):
        th = t / (au ** 1.5) + 2 * math.pi * k / 9.0
        x, y, z = _ecl_to_icrs(au * math.cos(th), au * math.sin(th), 0.0)
        planets.append(dict(name=name, x=round(x, 6), y=round(y, 6), z=round(z, 6)))
        if name == "Earth": earth = (x, y, z)
    th_m = t * 13.37 / 1.0
    mx, my, mz = _ecl_to_icrs(0.00257 * math.cos(th_m), 0.00257 * math.sin(th_m), 0.0)
    planets.append(dict(name="Moon", x=round(earth[0] + mx, 6), y=round(earth[1] + my, 6), z=round(earth[2] + mz, 6)))
    u = (math.cos(d0) * math.cos(a0), math.cos(d0) * math.sin(a0), math.sin(d0))
    bodies = []
    for j, (name, cls, vmag, dl) in enumerate([("Mock Asteroid A", "MBA", 14.1, 2.6), ("Mock Asteroid B", "NEO", 16.3, 3.3), ("C/2099 A1 (Mock)", "Comet", 12.2, 3.9)]):
        wob = 0.5 * math.radians(radius) * dl   # keeps the body inside the cone (|offset| < 0.87 * radius)
        jitter = [rng.uniform(-wob, wob) for _ in range(3)]
        p = [earth[k] + u[k] * dl + jitter[k] for k in range(3)]
        dg = math.dist(p, earth); dh = math.sqrt(sum(q * q for q in p))
        bodies.append(dict(name=name, number=990001 + j if j < 2 else None, **{"class": cls}, vmag=vmag,
                           x=round(p[0], 6), y=round(p[1], 6), z=round(p[2], 6), dg_au=round(dg, 6), dh_au=round(dh, 6)))
    return earth, planets, bodies

def scene3d_payload(ra, dec, radius, limit, mjd):
    rng = random.Random(f"scene3d/{ra:.4f}/{dec:.4f}/{radius:.3f}")
    a0, d0 = math.radians(ra), math.radians(dec)
    c = (math.cos(d0) * math.cos(a0), math.cos(d0) * math.sin(a0), math.sin(d0))
    e1 = (-math.sin(a0), math.cos(a0), 0.0)
    e2 = (c[1] * e1[2] - c[2] * e1[1], c[2] * e1[0] - c[0] * e1[2], c[0] * e1[1] - c[1] * e1[0])
    cosR = math.cos(math.radians(radius))
    rows = []
    for i in range(SCENE_N):
        ct = 1 - rng.random() * (1 - cosR); st = math.sqrt(max(0.0, 1 - ct * ct)); phi = rng.random() * 2 * math.pi
        v = [c[k] * ct + st * (math.cos(phi) * e1[k] + math.sin(phi) * e2[k]) for k in range(3)]
        d = 2.0 * math.exp(rng.random() * math.log(2000.0))           # log-uniform 2 to 4000 pc
        absg = -2.0 + 14.0 * math.sqrt(rng.random())                  # more faint stars than bright ones
        bprp = None if rng.random() < 0.03 else round(rng.uniform(0.0, 3.0), 3)
        f = rng.uniform(0.10, 0.30)
        rows.append([str(4472832130942575872 + i * 7919), round(v[0] * d, 4), round(v[1] * d, 4), round(v[2] * d, 4),
                     round(absg, 3), bprp, round(d * (1 - f), 3), round(d * (1 + f), 3)])
    truncated = len(rows) > limit
    rows = rows[:limit]
    earth, planets, bodies = mock_solar(ra, dec, radius, mjd)
    return dict(ra=ra, dec=dec, radius=radius, mjd=mjd,
                stars=dict(epoch=2016.0, source="mock (synthetic)", fields=["id", "x", "y", "z", "abs_g", "bp_rp", "d_lo", "d_hi"],
                           rows=rows, truncated=truncated),
                solar=dict(earth=[round(e, 6) for e in earth], sun=[0, 0, 0], planets=planets, bodies=bodies, bodies_error=None))

# ---- /api/objects: the space-maps.objects/1 contract, from the mock solar system above ----
OBJ_SCHEMA = "space-maps.objects/1"
OBJ_KINDS = ["sun", "planet", "moon", "dwarf_planet", "asteroid", "comet", "star", "exoplanet", "cluster", "nebula", "black_hole", "galaxy"]
OBJ_SERVED = ["sun", "planet", "moon", "dwarf_planet", "asteroid", "comet"]
OBJ_RADII_KM = dict(Sun=695700, Mercury=2440, Venus=6052, Earth=6378, Moon=1737, Mars=3396, Jupiter=71492, Saturn=60268, Uranus=25559, Neptune=24764)
MOCK_PROV = {"catalogue": "Space Maps dev mock (synthetic, not a real ephemeris)", "version": None, "citation": "none", "url": None}

def _oq(v, src, tier, unit=None):
    q = {"v": v}
    if unit: q["unit"] = unit
    q.update(src=src, tier=tier)
    return q

def _radec(x, y, z):
    d = math.sqrt(x * x + y * y + z * z)
    return math.degrees(math.atan2(y, x)) % 360.0, math.degrees(math.asin(max(-1.0, min(1.0, z / d)))), d

def _angsep(ra1, dec1, ra2, dec2):
    r1, d1, r2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    h = math.sin((d2 - d1) / 2) ** 2 + math.cos(d1) * math.cos(d2) * math.sin((r2 - r1) / 2) ** 2
    return math.degrees(2 * math.asin(min(1.0, math.sqrt(h))))

def objects_payload(ra, dec, radius, mjd, kinds, limit):
    earth, planets, bodies = mock_solar(ra, dec, radius, mjd)
    ephem_prov = dict(MOCK_PROV, source="ephem")
    sky_prov = dict(MOCK_PROV, source="skybot")

    def state(xyz, with_geo, method, src, tier):
        pos = {"model": "state", "mjd": mjd, "xyz_au": list(xyz), "method": method, "src": src, "tier": tier}
        if with_geo:
            g = _radec(xyz[0] - earth[0], xyz[1] - earth[1], xyz[2] - earth[2])
            pos["geo"] = {"ra": round(g[0], 5), "dec": round(g[1], 5), "dist_au": round(g[2], 6)}
        return pos

    def rec(id, kind, name, desig, parent, pos, size, props, prov, mag=None):
        r = {"id": id, "kind": kind, "name": name, "designations": desig, "host": "ss:sun", "parent": parent,
             "position": pos, "size": size, "props": props, "provenance": prov, "evidence": "measured",
             "render": {} if mag is None else {"mag": mag}}
        g = pos.get("geo")
        r["in_cone"] = bool(g) and _angsep(ra, dec, g["ra"], g["dec"]) <= radius
        return r

    out = []
    sun_pos = state([0.0, 0.0, 0.0], True, "ephemeris", "mock ephemeris", "measured")
    out.append(rec("ss:sun", "sun", "Sun", [], None, sun_pos, {"radius": _oq(OBJ_RADII_KM["Sun"], "IAU 2015 nominal solar radius", "measured", "km"), "angular": None},
                   {"dist_earth": _oq(sun_pos["geo"]["dist_au"], "mock ephemeris", "measured", "au")}, ephem_prov))
    for p in planets:
        xyz = [p["x"], p["y"], p["z"]]
        is_earth, is_moon = p["name"] == "Earth", p["name"] == "Moon"
        pos = state(xyz, not is_earth, "ephemeris", "mock ephemeris", "measured")
        props = {"dist_sun": _oq(round(math.sqrt(sum(c * c for c in xyz)), 6), "mock ephemeris", "measured", "au")}
        if not is_earth: props["dist_earth"] = _oq(pos["geo"]["dist_au"], "mock ephemeris", "measured", "au")
        out.append(rec("ss:" + p["name"].lower(), "moon" if is_moon else "planet", p["name"], [], "ss:earth" if is_moon else "ss:sun", pos,
                       {"radius": _oq(OBJ_RADII_KM[p["name"]], "IAU WGCCRE 2015 equatorial radius", "measured", "km"), "angular": None}, props, ephem_prov))
    for b in bodies:
        comet = b["class"] == "Comet"
        xyz = [b["x"], b["y"], b["z"]]
        pos = state(xyz, False, "orbit-propagation", "mock SkyBoT", "catalogue")
        g = _radec(xyz[0] - earth[0], xyz[1] - earth[1], xyz[2] - earth[2])
        pos["geo"] = {"ra": round(g[0], 5), "dec": round(g[1], 5), "dist_au": round(g[2], 6)}
        rid = "comet:" + b["name"].split(" (")[0] if comet else f"mp:{b['number']}"
        props = {"class": _oq(b["class"], "mock SkyBoT", "catalogue"), "vmag": _oq(b["vmag"], "mock SkyBoT", "catalogue", "mag"),
                 "dist_sun": _oq(b["dh_au"], "mock SkyBoT", "catalogue", "au"), "dist_earth": _oq(b["dg_au"], "mock SkyBoT", "catalogue", "au")}
        out.append(rec(rid, "comet" if comet else "asteroid", b["name"], [rid.split(":", 1)[1]] if comet else [str(b["number"])], "ss:sun", pos, None, props, sky_prov, b["vmag"]))
    by_kind, info = {}, {}
    for k in kinds:
        items = sorted((r for r in out if r["kind"] == k and (k in ("sun", "planet", "moon") or r["in_cone"])),
                       key=lambda r: (r["render"].get("mag") is None, r["render"].get("mag") or 0.0, r["id"]))
        by_kind[k] = items[:limit]
        info[k] = ({"status": "ok", "source": "ephem" if k in ("sun", "planet", "moon") else "skybot", "count": len(by_kind[k]), "truncated": len(items) > limit}
                   if k in OBJ_SERVED else {"status": "unavailable", "source": None, "count": 0, "truncated": False})
    objs = [r for k in kinds for r in by_kind[k]]
    n = lambda src: sum(1 for r in objs if r["provenance"]["source"] == src)
    return {"schema": OBJ_SCHEMA, "query": {"ra": ra, "dec": dec, "radius": radius, "mjd": mjd, "kinds": kinds}, "objects": objs, "kinds": info,
            "sources": [{"id": "ephem", "status": "ok", "ms": 1, "count": n("ephem"), "dropped": 0, "provenance": ephem_prov},
                        {"id": "skybot", "status": "ok", "ms": 1, "count": n("skybot"), "dropped": 0, "provenance": sky_prov}]}



# ---- /api/system/<id>: deterministic synthetic stellar parameters (hash of the id) ----
def _sv(v, src, tier, lo=None, hi=None):
    return dict(v=v, lo=lo, hi=hi, src=src, tier=tier)

def system_payload(sid):
    if sid == "sun":
        iau = "IAU 2015 nominal"
        vals = {k: None for k in ("dist_pc", "g_mag", "bp_rp", "teff_k", "radius_rsun", "lum_lsun", "mass_msun", "age_gyr", "logg", "spectral_type", "wd_prob")}
        for k, v in (("teff_k", 5772.0), ("radius_rsun", 1.0), ("lum_lsun", 1.0), ("mass_msun", 1.0), ("age_gyr", 4.57), ("logg", 4.438)):
            vals[k] = _sv(v, iau, "measured")
        vals["spectral_type"] = dict(v="G2V", src=iau, tier="measured")
        return dict(id="sun", name="Sun", ra=None, dec=None, values=vals, planets=[], companions=[], notes=[])
    rng = random.Random(f"system/{sid}")
    teff = round(math.exp(rng.uniform(math.log(2800), math.log(30000))))
    giant = rng.random() < 0.12
    if giant:
        radius = round(math.exp(rng.uniform(math.log(8), math.log(200))), 3)
    else:
        radius = round(max(0.1, (teff / 5772.0) ** 1.6 * rng.uniform(0.8, 1.2)), 3)
    lum = round(radius ** 2 * (teff / 5772.0) ** 4, 5)
    mass = round(max(0.08, min(40.0, lum ** 0.25 * rng.uniform(0.9, 1.1) if not giant else rng.uniform(0.8, 5))), 3)
    logg = round(4.438 + math.log10(mass) - 2 * math.log10(radius), 3)
    have_flame = rng.random() >= 0.30
    cat = "catalogue"
    spec = "OBAFGKM"[min(6, max(0, int((8000 / max(teff, 2000)) ** 1.0 * 1.2)))] if teff > 25000 or rng.random() < 0.3 else None
    d = round(math.exp(rng.uniform(math.log(2), math.log(4000))), 3)
    f = rng.uniform(0.05, 0.2)
    hs = teff > 25000
    vals = dict(
        dist_pc=_sv(d, "Bailer-Jones 2021 (geometric)", "measured", round(d * (1 - f), 3), round(d * (1 + f), 3)),
        g_mag=_sv(round(rng.uniform(6, 19), 4), "Gaia DR3 photometry", "measured"),
        bp_rp=_sv(round(rng.uniform(-0.4, 3.5), 4), "Gaia DR3 photometry", "measured"),
        teff_k=_sv(float(teff), "Gaia DR3 ESP-HS" if hs else "Gaia DR3 GSP-Phot", cat, round(teff * 0.97, 1), round(teff * 1.03, 1)),
        radius_rsun=_sv(radius, "Gaia DR3 FLAME" if have_flame else "Gaia DR3 GSP-Phot", cat, round(radius * 0.93, 4), round(radius * 1.07, 4)),
        lum_lsun=_sv(lum, "Gaia DR3 FLAME", cat, round(lum * 0.85, 5), round(lum * 1.15, 5)) if have_flame else None,
        mass_msun=_sv(mass, "Gaia DR3 FLAME", cat, round(mass * 0.95, 4), round(mass * 1.05, 4)) if have_flame else None,
        age_gyr=_sv(round(rng.uniform(0.1, 12), 3), "Gaia DR3 FLAME", cat, None, None) if have_flame else None,
        logg=_sv(logg, "Gaia DR3 GSP-Phot", cat, round(logg - 0.1, 3), round(logg + 0.1, 3)),
        spectral_type=dict(v=spec, src="Gaia DR3 ESP-HS", tier=cat) if spec else None,
        wd_prob=_sv(round(rng.random() ** 8, 6), "Gaia DR3 DSC", cat),
    )
    notes = [] if have_flame else ["FLAME mass not available for this star", "FLAME age not available for this star", "FLAME luminosity not available for this star"]
    return dict(id=sid, name=None, ra=round(rng.uniform(0, 360), 5), dec=round(rng.uniform(-90, 90), 5), values=vals, planets=[], companions=[], notes=notes)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def send_json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path); p = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path.startswith('/api/'): return self.api(u.path[5:], p)
            return self.static(u.path)
        except (BrokenPipeError, ConnectionResetError): pass
        except Exception as e:
            try: self.send_json({"detail": f"mock error: {e}"}, 500)
            except Exception: pass

    def static(self, path):
        path = path.split('?')[0]
        if path == '/': path = '/index.html'
        fp = os.path.normpath(os.path.join(ROOT, path.lstrip('/')))
        if path == '/js/blink/skygl.js' and not os.path.isfile(fp): fp = os.path.join(ROOT, 'dev', 'skygl-stub.js')
        if not fp.startswith(ROOT) or not os.path.isfile(fp): return self.send_json({"detail": "not found"}, 404)
        data = open(fp, 'rb').read()
        self.send_response(200); self.send_header('Content-Type', mimetypes.guess_type(fp)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(data))); self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(data)

    def mover_positions(self, m, p):
        ra = float(p.get('ra', 0)); dec = float(p.get('dec', 0))
        fov = float(p.get('fov', 0.1)); scale = float(p.get('scale', 6.15))
        npix = int(round(fov * 3600 / scale)); npix += (npix % 2 == 0)
        c = (npix - 1) / 2
        _, sel = select(p, ra, dec)
        pos = []
        for f in sel:
            xi, eta = mover_xy(m, f['mjd'])
            pos.append(dict(frame_id=f['id'], mjd=f['mjd'], x=round(c - xi / scale, 3), y=round(c - eta / scale, 3)))
        return pos

    def movers(self, ep, p):
        if ep == 'known':
            objs = []
            for m in MOVERS:
                if m['kind'] != 'known': continue
                r, pa = rate_pa(m)
                objs.append(dict(name=m['name'], number=m['number'], **{"class": m['cls']}, vmag=m['vmag'], rate_arcsec_h=round(r, 3), pa_deg=round(pa, 1),
                                 positions=self.mover_positions(m, p), stack=dict(snr=24.0, detected=True)))
            return self.send_json({"objects": objs, "source": "skybot"})
        if ep == 'linked':
            out = []
            for m in MOVERS:
                if m['kind'] != 'linked': continue
                r, pa = rate_pa(m)
                out.append(dict(id=m['id'], rate_arcsec_h=round(r, 3), pa_deg=round(pa, 1), confidence=0.82, positions=[dict(q, flux=m['amp']) for q in self.mover_positions(m, p)]))
            return self.send_json({"movers": out})
        if ep == 'search/start':
            job = uuid.uuid4().hex[:8]
            JOBS[job] = dict(state='running', t0=time.time(), cancelled=False, params=dict(p))
            return self.send_json({"job": job, "cached": False})
        if ep == 'search/cancel':
            j = JOBS.get(p.get('job', ''))
            if j: j['cancelled'] = True; j['state'] = 'cancelled'
            return self.send_json({"ok": True})
        if ep == 'search/status':
            j = JOBS.get(p.get('job', ''))
            if not j: return self.send_json({"detail": "unknown job"}, 404)
            if j['state'] == 'running':
                prog = min(1.0, (time.time() - j['t0']) / 8.0)
                if prog >= 1: j['state'] = 'done'
            else: prog = 1.0 if j['state'] == 'done' else 0.3
            cands = []
            if prog >= 0.5 and j['state'] != 'cancelled':
                m = [x for x in MOVERS if x['kind'] == 'candidate'][0]; r, pa = rate_pa(m)
                cands.append(dict(id="C1", rate_arcsec_h=round(r, 3), pa_deg=round(pa, 1), confidence=0.46, snr=5.8, positions=self.mover_positions(m, j['params'])))
            return self.send_json({"state": j['state'], "progress": round(prog, 3), "tried": int(prog * 400), "total": 400, "candidates": cands})
        return self.send_json({"detail": "unknown endpoint"}, 404)

    def api(self, ep, p):
        if ep == 'health': return self.send_json({"ok": True})
        if ep == 'resolve':
            q = p.get('q', '').strip(); k = q.lower()
            if k in NAMES:
                n, ra, dec, pa, pd, plx, epo, ot = NAMES[k]
                return self.send_json(dict(name=n, ra=ra, dec=dec, pmra=pa, pmdec=pd, plx=plx, epoch=epo, otype=ot, source="sesame"))
            c = parse_coords(q)
            if c: return self.send_json(dict(name=q, ra=c[0], dec=c[1], pmra=None, pmdec=None, plx=None, epoch=None, otype=None, source="coordinates"))
            return self.send_json({"detail": f"Could not resolve '{q}'"}, 404)
        if ep == 'coverage':
            return self.send_json({"fields": [dict(ra=133.795129, dec=-7.245147, n_frames=18), dict(ra=270.0, dec=66.56, n_frames=18), dict(ra=269.452, dec=4.6934, n_frames=18)]})
        if ep == 'scene3d':
            try:
                ra, dec = float(p['ra']), float(p['dec'])
                radius = float(p.get('radius', 3)); limit = int(p.get('limit', 20000))
                mjd = float(p['mjd']) if 'mjd' in p else 61000.0
            except (KeyError, ValueError):
                return self.send_json({"detail": "ra and dec are required numbers; radius, limit and mjd must be numbers"}, 400)
            if not (0 <= ra < 360 and -90 <= dec <= 90): return self.send_json({"detail": "ra must be in [0, 360) and dec in [-90, 90]"}, 400)
            if not (0 < radius <= 30): return self.send_json({"detail": "radius must be in (0, 30] degrees"}, 400)
            if limit < 1: return self.send_json({"detail": "limit must be at least 1"}, 400)
            return self.send_json(scene3d_payload(ra, dec, radius, limit, mjd))
        if ep == 'objects':
            try:
                ra, dec = float(p['ra']), float(p['dec'])
                radius = float(p.get('radius', 3)); limit = int(p.get('limit', 2000))
                mjd = float(p['mjd']) if 'mjd' in p else 61000.0
            except (KeyError, ValueError):
                return self.send_json({"detail": "ra and dec are required numbers; radius, limit and mjd must be numbers"}, 400)
            if not (0 <= ra < 360 and -90 <= dec <= 90): return self.send_json({"detail": "ra must be in [0, 360) and dec in [-90, 90]"}, 400)
            if not (0.1 <= radius <= 5.0): return self.send_json({"detail": "radius must be between 0.1 and 5.0 deg"}, 400)
            if not (1 <= limit <= 10000): return self.send_json({"detail": "limit must be between 1 and 10000"}, 400)
            if not (15020.0 <= mjd <= 88069.0): return self.send_json({"detail": "mjd must be between 15020 (1900) and 88069 (2100)"}, 400)
            want = [k.strip() for k in p.get('kinds', '').split(',') if k.strip()]
            bad = [k for k in want if k not in OBJ_KINDS]
            if bad: return self.send_json({"detail": f"unknown kind(s): {', '.join(bad)}; valid kinds: {', '.join(OBJ_KINDS)}"}, 400)
            kinds = [k for k in OBJ_KINDS if k in want] if want else list(OBJ_SERVED)
            return self.send_json(objects_payload(ra, dec, radius, mjd, kinds, limit))
        if ep.startswith('system/'):
            sid = ep[7:].strip('/')
            if sid != 'sun' and not sid.isdigit(): return self.send_json({"detail": "source_id must be a Gaia source id (digits) or 'sun'"}, 400)
            return self.send_json(system_payload(sid))
        if ep.startswith('movers/'): return self.movers(ep[7:], p)
        ra = float(p.get('ra', 0)); dec = float(p.get('dec', 0))
        if ep == 'frames':
            fl = frame_list(ra, dec)
            if abs(dec) > 85 or ra < 0:  # example: nothing
                fl = []
            by = {}
            for f in fl: by[str(f['detector'])] = by.get(str(f['detector']), 0) + 1
            clean = [{k: v for k, v in f.items() if not k.startswith('_')} for f in fl]
            return self.send_json(dict(ra=ra, dec=dec, count=len(clean), frames=clean, by_detector=by))
        if ep == 'catalog':
            pa, pd, epo = LAST['pmra'], LAST['pmdec'], LAST['epoch']
            cat = p.get('cat', 'gaia'); cosd = math.cos(math.radians(dec))
            def sky(xi, eta): return ra + xi / 3600 / cosd, dec + eta / 3600
            src = []
            for i, (xi, eta, a) in enumerate(STARS + [VAR]):
                r, d = sky(xi, eta); src.append(dict(id=f"{'Gaia DR3 ' if cat == 'gaia' else 'J'}{1000 + i}", ra=r, dec=d, pmra=0.0, pmdec=0.0, plx=1.0, mag=14 - a, epoch=2016.0 if cat == 'gaia' else 2010.5))
            ye = 2016.0 if cat == 'gaia' else 2010.5
            pm = (pa, pd, epo) if pa is not None else (None, None, None)
            m0 = mover_offset(51544.5 + (ye - 2000) * 365.25, pm)
            mp = (pa, pd) if pa is not None else (-6000.0, 4000.0)
            r, d = sky(*m0); src.append(dict(id="mover", ra=r, dec=d, pmra=mp[0], pmdec=mp[1], plx=50.0, mag=12.0, epoch=ye))
            return self.send_json(dict(cat=cat, sources=src))
        pm = pm_of(p); LAST.update(pmra=pm[0], pmdec=pm[1], epoch=pm[2])
        fov = float(p.get('fov', 0.1)); scale = float(p.get('scale', 6.15))
        npix = int(round(fov * 3600 / scale)); npix += (npix % 2 == 0)
        total, sel = select(p, ra, dec)
        if abs(dec) > 85: total, sel = 0, []   # no coverage near the poles of the equatorial frame
        if ep == 'stream':
            self.send_response(200); self.send_header('Content-Type', 'application/octet-stream'); self.send_header('Cache-Control', 'no-store'); self.end_headers()
            def rec(obj, payload=b''):
                b = json.dumps(obj).encode(); self.wfile.write(struct.pack('<I', len(b)) + b + payload); self.wfile.flush()
            use_model = p.get('model') in ('1', 'true', 'progressive')
            progressive = p.get('model') == 'progressive'
            mdl = dict(ra=ra, dec=dec) if use_model else None
            st = dict(type="start", ra=ra, dec=dec, fov=fov, scale_arcsec=scale, npix=npix, total_available=total, selected=len(sel), flag_bits=FLAG_BITS, detectors=sorted({f['detector'] for f in sel}))
            if use_model: st['model'] = 'progressive' if progressive else True
            if abs(ra - 10.0) < 1e-6 and abs(dec - 20.0) < 1e-6:  # slow field: exercises the loading state
                for i in range(8): time.sleep(1.0); rec(dict(type='progress', done=i, total=18))
            rec(st)
            order = sel[:]; random.Random(5).shuffle(order); sent = 0; failed = 0
            held = []  # progressive: (frame id, model dict, planes) sent after all raw frames
            for f in order:
                time.sleep(0.02 + random.random() * 0.04)
                if f['_k'] == 7 and f['_e'] == 1 and f['detector'] == 2:
                    failed += 1; rec(dict(type="frame", ok=False, id=f['id'], detector=f['detector'], mjd=f['mjd'], error="mock: cutout download failed (HTTP 503)")); continue
                img, flags, info = render(f, npix, scale, pm, mdl)
                meta = frame_meta(f, npix, scale, pm, ra, dec, img, flags, info)
                if progressive:
                    rec(meta, img.tobytes() + flags.tobytes())
                    held.append((f['id'], dict(psf_fwhm_px=info['sig'] * 2.355, noise=info['noise'], quality=1.04, sources=info['sources']),
                                 info['bg'].tobytes() + info['left'].tobytes()))
                elif use_model:
                    meta['model'] = dict(psf_fwhm_px=info['sig'] * 2.355, noise=info['noise'], quality=1.04, sources=info['sources'])
                    rec(meta, img.tobytes() + flags.tobytes() + info['bg'].tobytes() + info['left'].tobytes())
                else:
                    rec(meta, img.tobytes() + flags.tobytes())
                sent += 1
                if use_model and sent % 4 == 0: rec(dict(type="progress", done=sent + failed, total=len(sel)))
            for fid, mdict, planes in held:  # progressive: models trail the raw frames, one every 0.15 s
                time.sleep(0.15)
                rec(dict(type="model", id=fid, model=mdict), planes)
            end = dict(type="end", sent=sent, failed=failed)
            if progressive: end['models'] = len(held)
            rec(end); return
        if ep == 'spectrum':
            pra = float(p.get('pos_ra', ra)); pdec = float(p.get('pos_dec', dec))
            aper = float(p.get('aper', 2.0)); c = (npix - 1) / 2; cosd = math.cos(math.radians(dec))
            xi = (pra - ra) * cosd * 3600; eta = (pdec - dec) * 3600
            pts = []
            for f in sel:
                if f['_k'] == 7 and f['_e'] == 1 and f['detector'] == 2: continue
                img, flags, info = render(f, npix, scale, pm)
                if pm[0] is not None:
                    dt = mjd_year(f['mjd']) - pm[2]; x_, e_ = xi + pm[0] * dt / 1000, eta + pm[1] * dt / 1000
                else: x_, e_ = xi, eta
                flux, fl, nn, n = aperture(img, flags, npix, c - x_ / scale, c - e_ / scale, aper)
                lo, hi = BANDS[f['detector']]
                err = info['noise'] * math.sqrt(max(nn, 1)) * 0.89
                names = [k for k, b in FLAG_BITS.items() if fl >> b & 1]
                pts.append(dict(id=f['id'], detector=f['detector'], mjd=f['mjd'], wavelength_um=info['wl'], bandwidth_um=(hi - lo) / 17, flux_mjy=flux, err_mjy=err,
                                snr=flux / err if err else None, flags=fl, flag_names=names, bad=bool(fl & BAD_MASK) or nn < 0.7 * n))
            return self.send_json(dict(pos_ra=pra, pos_dec=pdec, aperture_px=aper, points=pts))
        self.send_json({"detail": "unknown endpoint"}, 404)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    print(f"mock SPHEREx API + static frontend on http://127.0.0.1:{port}/")
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
