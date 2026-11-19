"""Fast offline unit tests. Tests needing the sample cutout are skipped if it is absent."""

from __future__ import annotations

import os
import warnings
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from spherex_app import archive, catalogs, fitsstream, geometry, processing

SAMPLE = Path(os.environ.get(
    "SPHEREX_SAMPLE_CUTOUT",
    "/tmp/claude-1000/-home-vinayakarora-Projects-Nasa-Space-Apps-Planetx-And-SphereX/"
    "1c3e1918-7fff-482d-bfc1-0f9192c55353/scratchpad/dl/cut_0.1.fits"))
needs_sample = pytest.mark.skipif(not SAMPLE.exists(), reason="sample cutout not available")


def _synthetic_fits() -> bytes:
    pri = fits.PrimaryHDU()
    img = fits.ImageHDU(np.arange(12, dtype=">f4").reshape(3, 4), name="IMAGE")
    flg = fits.ImageHDU(np.array([[1, 2], [4, 2 ** 30]], dtype=">i4"), name="FLAGS")
    tab = fits.BinTableHDU.from_columns(
        [fits.Column(name="X", format="3J", array=np.array([[1, 5, 9]])),
         fits.Column(name="V", format="4E", dim="(2,2)", array=np.arange(4.0).reshape(1, 2, 2))],
        name="TAB")
    import io
    b = io.BytesIO()
    fits.HDUList([pri, img, flg, tab]).writeto(b)
    return b.getvalue()


# --- FITS splitter --------------------------------------------------------------------

def test_splitter_synthetic_incremental():
    data = _synthetic_fits()
    s = fitsstream.FitsSplitter()
    counts = [s.feed(data[i:i + 1000]) for i in range(0, len(data), 1000)]
    assert counts[-1] == 4 and counts == sorted(counts)
    names = [h.name for h in s.hdus]
    assert names == ["", "IMAGE", "FLAGS", "TAB"]
    img = fitsstream.image_array(s.hdus[1])
    assert img.dtype.byteorder in ("=", "<") and img.shape == (3, 4)
    np.testing.assert_array_equal(img, np.arange(12).reshape(3, 4))
    assert fitsstream.image_array(s.hdus[2])[1, 1] == 2 ** 30
    row = fitsstream.bintable_row0(s.hdus[3].header(), s.hdus[3].data_bytes)
    np.testing.assert_array_equal(row["X"], [1, 5, 9])
    assert row["V"].shape == (2, 2)


def test_splitter_rejects_non_fits():
    with pytest.raises(fitsstream.FitsFormatError):
        fitsstream.FitsSplitter().feed(b"<html>Service Unavailable</html>" + b" " * 3000)


@needs_sample
def test_splitter_matches_astropy_on_sample_and_truncates():
    data = SAMPLE.read_bytes()
    s = fitsstream.FitsSplitter()
    for i in range(0, len(data), 4096):
        if s.feed(data[i:i + 4096]) >= 5:
            break
    trunc = s.consumed_bytes()
    assert len(trunc) < 200_000  # stopped long before the ~4 MB EPSF
    cut = processing.parse_cutout(trunc)
    with fits.open(SAMPLE) as hdul:
        np.testing.assert_array_equal(cut.image, hdul["IMAGE"].data)
        np.testing.assert_array_equal(cut.flags, hdul["FLAGS"].data.astype(np.uint32))
        np.testing.assert_array_equal(cut.zodi, hdul["ZODI"].data)
    assert cut.flag_bits["SOURCE"] == 21 and cut.flag_bits["TRANSIENT"] == 0


# --- projection -------------------------------------------------------------------------

def test_gnomonic_roundtrip():
    rng = np.random.default_rng(1)
    for ra0, dec0 in [(133.8, -7.2), (10.0, 89.5), (359.99, 0.0), (248.2, 66.75)]:
        xi = rng.uniform(-1000, 1000, 50)
        eta = rng.uniform(-1000, 1000, 50)
        ra, dec = geometry.std_to_sky(xi, eta, ra0, dec0)
        xi2, eta2 = geometry.sky_to_std(ra, dec, ra0, dec0)
        np.testing.assert_allclose(xi2, xi, atol=1e-6)
        np.testing.assert_allclose(eta2, eta, atol=1e-6)


def test_grid_orientation_north_up_east_left():
    g = geometry.Grid(133.795129, -7.245147, 6.15, geometry.npix_for(0.1, 6.15))
    assert g.npix == 59 and g.c == 29
    x, y = g.sky_to_pix(g.ra, g.dec)
    assert abs(x - 29) < 1e-9 and abs(y - 29) < 1e-9
    # 61.5" north -> 10 px towards row 0
    x, y = g.sky_to_pix(g.ra, g.dec + 61.5 / 3600)
    assert abs(x - 29) < 1e-3 and abs(y - 19) < 1e-3
    # east (increasing RA) -> towards column 0
    x, y = g.sky_to_pix(g.ra + 61.5 / 3600 / np.cos(np.radians(g.dec)), g.dec)
    assert abs(x - 19) < 0.01 and abs(y - 29) < 0.01
    # matches an astropy TAN WCS with CDELT1 = -scale, CDELT2 = -scale (row 0 north)
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [g.ra, g.dec]
    w.wcs.crpix = [g.c + 1, g.c + 1]
    w.wcs.cdelt = [-6.15 / 3600, -6.15 / 3600]
    ra, dec = g.pix_to_sky(np.array([0.0, 58, 10]), np.array([0.0, 58, 40]))
    xa, ya = w.all_world2pix(ra, dec, 0)
    np.testing.assert_allclose(xa, [0, 58, 10], atol=1e-6)
    np.testing.assert_allclose(ya, [0, 58, 40], atol=1e-6)


def test_npix_is_odd():
    assert geometry.npix_for(0.1, 6.15) == 59
    assert geometry.npix_for(0.2, 6.0) % 2 == 1


def test_proper_motion_propagation():
    # 1000 mas/yr north for 10 yr = 10"
    ra, dec = geometry.propagate(100.0, 0.0, 0.0, 1000.0, 2000.0, geometry.jyear_to_mjd(2010.0))
    assert abs((dec - 0.0) * 3600 - 10.0) < 1e-6 and abs(ra - 100.0) < 1e-9
    ra, dec = geometry.propagate(100.0, 60.0, 1000.0, 0.0, 2000.0, geometry.jyear_to_mjd(2010.0))
    assert abs((ra - 100.0) * 3600 * np.cos(np.radians(60.0)) - 10.0) < 1e-3


# --- wavelength lookup ----------------------------------------------------------------------

def test_wave_lookup_bilinear_synthetic():
    x = np.array([1.0, 11.0, 21.0])
    y = np.array([1.0, 101.0])
    vals = np.zeros((2, 3, 2))
    vals[..., 0] = x[None, :] * 0.1 + y[:, None] * 0.01  # linear -> bilinear exact
    vals[..., 1] = 0.05
    t = geometry.WaveTable(x, y, vals)
    wl, bw = geometry.wave_lookup(t, np.array([6.0, 16.0]), np.array([51.0, 1.0]))
    np.testing.assert_allclose(wl, [0.6 + 0.51, 1.6 + 0.01])
    np.testing.assert_allclose(bw, 0.05)


@needs_sample
def test_wave_lookup_matches_astropy_tab():
    warnings.simplefilter("ignore")
    cut = processing.parse_cutout(SAMPLE.read_bytes())
    table = processing.wave_table_from_full_file(SAMPLE.read_bytes())
    assert table is not None
    with fits.open(SAMPLE) as hdul:
        w = WCS(hdul["IMAGE"].header, fobj=hdul, key="W")
        w.sip = None
        rng = np.random.default_rng(0)
        xs = np.concatenate([[0, 58, 29, 0], rng.uniform(-3, 62, 40)])
        ys = np.concatenate([[0, 58, 29, 58], rng.uniform(-3, 62, 40)])
        ref_wl, ref_bw = w.pixel_to_world_values(xs, ys)
    wl, bw = processing.wavelength_at(cut, table, xs, ys)
    np.testing.assert_allclose(wl, ref_wl, rtol=0, atol=1e-6)
    np.testing.assert_allclose(bw, ref_bw, rtol=0, atol=1e-6)
    assert 4.42 < wl[2] < 5.0  # D6


@needs_sample
def test_wave_tail_parser_on_sample():
    data = SAMPLE.read_bytes()
    t1 = archive.parse_wave_tail(data[-8640:])
    t2 = processing.wave_table_from_full_file(data)
    np.testing.assert_array_equal(t1.values, t2.values)


@needs_sample
def test_resample_and_photometry_on_sample():
    cut = processing.parse_cutout(SAMPLE.read_bytes())
    g = geometry.Grid(133.795129, -7.245147, 6.15, 59)
    img, fl, px, py = processing.resample(cut, g)
    assert img.shape == (59, 59) and fl.dtype == np.uint32
    assert np.isfinite(img).mean() > 0.6
    assert np.all(fl[~np.isfinite(img)] == 0)
    # Gaia G=13.3 star ~46" south of centre must be bright in the image and photometry
    star = (133.79701, -7.25786)
    x, y = g.sky_to_pix(*star)
    xi, yi = int(round(x)), int(round(y))
    patch = img[yi - 1:yi + 2, xi - 1:xi + 2]
    med, sig, _ = processing.robust_stats(img)
    assert np.nanmax(patch) > med + 10 * sig
    p = processing.photometry(cut, *star, 2.0)
    assert p.flux_mjy is not None and p.flux_mjy > 0 and p.err_mjy > 0
    om = processing.pixel_solid_angle_sr(cut.wcs, 29, 29)
    assert abs(om * 1e9 - 0.889) < 0.02  # mJy per (MJy/sr * px)


# --- frame list / selection / parsing --------------------------------------------------------

def _row(uri, det, t):
    return {"uri": uri, "energy_bandpassname": f"SPHEREx-D{det}", "time_bounds_lower": t,
            "time_bounds_upper": t + 0.001, "time_exposure": "113.5", "provenance_version": "7.0.5"}


def test_frame_dedup_keeps_newest_and_parses_fields():
    u_old = "ibe/data/spherex/qr2/level2/2025W19_1B/l2b-v20-2025-300/6/level2_2025W19_1B_0116_1D6_spx_l2b-v20-2025-300.fits"
    u_new = "ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/6/level2_2025W19_1B_0116_1D6_spx_l2b-v27-2026-197.fits"
    u_3 = "ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/3/level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits"
    fr = archive.parse_frame_rows([_row(u_old, 6, 60800.7), _row(u_new, 6, 60800.7), _row(u_3, 3, 60800.7)])
    assert len(fr) == 2
    f6 = [f for f in fr if f.detector == 6][0]
    assert f6.id == "2025W19_1B_0116_1D6" and f6.obsid == "2025W19_1B_0116_1"
    assert f6.release == "dr1" and f6.version == "l2b-v27-2026-197" and f6.pipeline == "7.0.5"


def test_select_frames_thins_evenly_per_detector():
    frames = [archive.Frame(f"f{d}_{i}", "o", d, 60000 + i, 60000 + i, 1, "dr1", "v", None, "u")
              for d in (1, 2) for i in range(100 if d == 1 else 50)]
    sel, n = archive.select_frames(frames, {1, 2}, None, None, 30)
    assert n == 150 and len(sel) == 30
    d1 = [f.mjd for f in sel if f.detector == 1]
    assert len(d1) == 20 and d1[0] == 60000 and d1[-1] == 60099
    sel, n = archive.select_frames(frames, {2}, 60010, 60019, 400)
    assert n == 10 and all(f.detector == 2 for f in sel)


def test_cutout_size_quantised():
    assert archive.cutout_size_deg(0.1) == 0.15
    assert archive.cutout_size_deg(0.02) == 0.03


# --- coordinates / Sesame ---------------------------------------------------------------------

@pytest.mark.parametrize("q", ["133.795129 -7.245147", "133.795129, -7.245147",
                               "08h55m10.831s -7d14m42.53s", "08:55:10.831 -07:14:42.53",
                               "08 55 10.831 -07 14 42.53", "08:55:10.831, -07:14:42.53"])
def test_parse_coordinates(q):
    ra, dec = catalogs.parse_coordinates(q)
    assert abs(ra - 133.795129) < 2e-5 and abs(dec + 7.245147) < 2e-5


@pytest.mark.parametrize("q", ["Barnard's Star", "M31", "WISE J085510.83-071442.5", "R Dra"])
def test_names_are_not_coordinates(q):
    assert catalogs.parse_coordinates(q) is None


def test_parse_sesame():
    xml = """<?xml version="1.0"?><Sesame><Target><name>x</name><Resolver name="S=Simbad">
    <otype>BY*</otype><jradeg>269.45207</jradeg><jdedeg>4.69339</jdedeg>
    <pm><v>10393</v><pmRA>-801.551</pmRA><pmDE>10362.394</pmDE></pm>
    <plx><v>546.9759</v></plx><oname>NAME Barnard's star</oname></Resolver></Target></Sesame>"""
    r = catalogs.parse_sesame(xml, "barnard")
    assert r["ra"] == 269.45207 and r["pmdec"] == 10362.394 and r["epoch"] == 2000.0
    assert r["plx"] == 546.9759 and r["otype"] == "BY*" and r["source"] == "sesame"
    with pytest.raises(catalogs.NotFound):
        catalogs.parse_sesame("<Sesame><Target><Resolver/></Target></Sesame>", "nope")


# --- Sesame mirrors (object framework §17.17) ---------------------------------------------

_SESAME_OK = """<?xml version="1.0"?><Sesame><Target><name>M57</name><Resolver name="S=Simbad">
<otype>PN</otype><jradeg>283.39623652</jradeg><jdedeg>33.02913425</jdedeg><oname>M 57</oname></Resolver></Target></Sesame>"""
_SESAME_NONE = "<Sesame><Target><name>nope</name><Resolver/></Target></Sesame>"
_URLS = ("https://cds.example/S", "https://cfa.example/S", "https://idia.example/S")


def _stub_sesame(monkeypatch, answers):
    """answers: host -> body text, or an exception to raise. Returns the list of hosts asked, in order."""
    from urllib.parse import urlsplit
    asked = []

    async def fake_get_text(url, params=None, **kw):
        host = urlsplit(url).netloc
        asked.append(host)
        a = answers[host]
        if isinstance(a, Exception):
            raise a
        return a

    monkeypatch.setattr(catalogs, "get_text", fake_get_text)
    monkeypatch.setattr(catalogs.config, "SESAME_URLS", _URLS)
    monkeypatch.setattr(catalogs, "_resolve_mem", catalogs.cache.TTLCache(60, maxsize=8))  # no cached answers
    return asked


def _resolve(q):
    import asyncio
    return asyncio.run(catalogs.resolve(q))


def test_sesame_falls_back_to_cfa_when_cds_is_down(monkeypatch):
    from spherex_app.archive import UpstreamError
    asked = _stub_sesame(monkeypatch, {"cds.example": UpstreamError("Sesame: timed out"),
                                       "cfa.example": _SESAME_OK, "idia.example": _SESAME_OK})
    r = _resolve("M57")
    assert asked == ["cds.example", "cfa.example"]
    assert r["mirror"] == "cfa.example" and r["source"] == "sesame" and abs(r["ra"] - 283.3962365) < 1e-6


def test_sesame_falls_back_to_idia_when_cds_and_cfa_are_down(monkeypatch):
    from spherex_app.archive import UpstreamError
    asked = _stub_sesame(monkeypatch, {"cds.example": UpstreamError("HTTP 503"),
                                       "cfa.example": "<html>maintenance</html", "idia.example": _SESAME_OK})
    r = _resolve("M57")
    assert asked == ["cds.example", "cfa.example", "idia.example"] and r["mirror"] == "idia.example"


def test_sesame_not_found_is_an_answer_not_a_failure(monkeypatch):
    asked = _stub_sesame(monkeypatch, {"cds.example": _SESAME_NONE, "cfa.example": _SESAME_OK,
                                       "idia.example": _SESAME_OK})
    with pytest.raises(catalogs.NotFound):
        _resolve("nope")
    assert asked == ["cds.example"]


def test_sesame_all_down_raises_the_upstream_error(monkeypatch):
    from spherex_app.archive import UpstreamError
    asked = _stub_sesame(monkeypatch, {h: UpstreamError(f"{h} down") for h in ("cds.example", "cfa.example",
                                                                              "idia.example")})
    with pytest.raises(UpstreamError):
        _resolve("M57")
    assert asked == ["cds.example", "cfa.example", "idia.example"]


def test_sesame_mirror_config_defaults():
    from spherex_app import config
    assert config.SESAME_URLS[0] == config.SESAME_URL
    hosts = [u.split("/")[2] for u in config.SESAME_URLS[1:]]
    assert hosts == ["vizier.cfa.harvard.edu", "vizier.idia.ac.za"]
