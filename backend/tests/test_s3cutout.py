"""Offline tests of the S3 range-read cutout path (synthetic full-frame files, mock S3)."""

from __future__ import annotations

import asyncio
import collections
import io
import os
import re
import warnings
from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.nddata import Cutout2D
from astropy.wcs import WCS, FITSFixedWarning

from spherex_app import fitsstream, processing, s3cutout

warnings.simplefilter("ignore", FITSFixedWarning)

DL = Path(os.environ.get(
    "SPHEREX_SAMPLE_DIR",
    "/tmp/claude-1000/-home-vinayakarora-Projects-Nasa-Space-Apps-Planetx-And-SphereX/"
    "1c3e1918-7fff-482d-bfc1-0f9192c55353/scratchpad/dl"))
needs_samples = pytest.mark.skipif(not (DL / "cut_0.1.fits").exists(),
                                   reason="sample cutouts not available")
W0855 = (133.795129, -7.245147)


def _wcs_header(n: int, ra0=150.0, dec0=20.0, rot_deg=17.0) -> fits.Header:
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra0, dec0]
    w.wcs.crpix = [n / 2 + 0.5, n / 2 + 0.5]
    s = 6.15 / 3600
    c, si = np.cos(np.radians(rot_deg)), np.sin(np.radians(rot_deg))
    w.wcs.cd = [[-s * c, s * si], [s * si, s * c]]
    h = w.to_header()
    # an alternate pixel-lookup WCS like SPHEREx's WAVE-TAB (only CRPIX matters here)
    h["CRPIX1W"], h["CRPIX2W"], h["CRVAL1W"], h["CRVAL2W"] = 1, 1, 1.0, 1.0
    h["CRPIX1A"], h["CRPIX2A"] = 1.0, 1.0
    return h


def _full_file(n=64, img_pad_cards=0, var_pad_cards=0) -> tuple[bytes, dict]:
    """A miniature SPHEREx-like L2 file: IMAGE, RICE FLAGS (1 row per tile), VARIANCE, ZODI."""
    rng = np.random.default_rng(3)
    h = _wcs_header(n)
    planes = {
        "IMAGE": rng.normal(1, 0.1, (n, n)).astype(np.float32),
        "FLAGS": rng.integers(0, 2 ** 31 - 1, (n, n)).astype(np.int32) * (rng.random((n, n)) < 0.3),
        "VARIANCE": rng.random((n, n)).astype(np.float32),
        "ZODI": rng.normal(0.2, 0.01, (n, n)).astype(np.float32),
    }
    planes["IMAGE"][5, 7] = np.nan
    planes["FLAGS"][10, 10] = np.iinfo(np.int32).min  # sign bit survives int32 -> uint32
    img_h = h.copy()
    img_h["PSF_FWHM"] = 9.0
    img_h["MJD-AVG"] = 60800.7
    for i in range(img_pad_cards):  # vary header length
        img_h[f"PAD{i:05d}"] = i
    var_h = h.copy()
    for i in range(var_pad_cards):
        var_h[f"PAD{i:05d}"] = i
    flg_h = h.copy()
    flg_h["MSKN0000"] = "TRANSIENT"
    flg_h["MSKN0021"] = "SOURCE"
    flg_h["MP_HOT"] = 10  # older flag-definition convention must also survive decoding
    hdul = fits.HDUList([
        fits.PrimaryHDU(),
        fits.ImageHDU(planes["IMAGE"], img_h, name="IMAGE"),
        fits.CompImageHDU(planes["FLAGS"].astype(np.int32), flg_h, name="FLAGS",
                          compression_type="RICE_1", tile_shape=(1, n)),
        fits.ImageHDU(planes["VARIANCE"], var_h, name="VARIANCE"),
        fits.ImageHDU(planes["ZODI"], h, name="ZODI"),
        fits.BinTableHDU.from_columns([fits.Column(name="E", format="100E",
                                                   array=np.zeros((3, 100)))], name="EPSF"),
    ])
    buf = io.BytesIO()
    hdul.writeto(buf)
    return buf.getvalue(), planes


class _RangeServer:
    """httpx MockTransport serving one object with S3-like Range semantics."""

    def __init__(self, data: bytes, status: int = 206):
        self.data, self.status, self.calls = data, status, []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        m = re.fullmatch(r"bytes=(\d+)-(\d+)", req.headers.get("range", ""))
        assert m, "every request must be a closed byte range"
        a, b = int(m.group(1)), int(m.group(2))
        self.calls.append((a, b))
        if self.status != 206:
            return httpx.Response(self.status, content=b"<Error/>")
        if a >= len(self.data):
            return httpx.Response(416)
        end = min(b, len(self.data) - 1)
        return httpx.Response(206, headers={"Content-Range": f"bytes {a}-{end}/{len(self.data)}"},
                              content=self.data[a:end + 1])


def _fetch(data: bytes, ra, dec, size, status=206):
    srv = _RangeServer(data, status)
    stats = collections.Counter()

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(srv)) as c:
            return await s3cutout.fetch_cutout_bytes(c, "ibe/data/spherex/x/y.fits", ra, dec, size,
                                                     stats)
    return asyncio.run(go()), srv, stats


@pytest.mark.parametrize("pads", [(0, 0), (40, 0), (0, 40), (75, 75)])
@pytest.mark.parametrize("pos", [(0.0, 0.0), (0.03, -0.02), (-0.045, 0.05)])
def test_s3_cutout_matches_cutout2d(pads, pos):
    n = 64
    data, planes = _full_file(n, *pads)
    full = fits.open(io.BytesIO(data))
    w_full = WCS(full["IMAGE"].header)
    ra, dec = 150.0 + pos[0], 20.0 + pos[1]
    size = 0.05
    out, srv, stats = _fetch(data, ra, dec, size)
    # every request is a small range: never the whole file
    assert max(b - a + 1 for a, b in srv.calls) < len(data) / 2
    hdus = fitsstream.split_bytes(out)
    assert [h.name for h in hdus] == ["", "IMAGE", "FLAGS", "VARIANCE", "ZODI"]
    ref = Cutout2D(planes["IMAGE"], SkyCoord(ra * u.deg, dec * u.deg), size * u.deg, wcs=w_full,
                   mode="trim")
    (ys, xs) = ref.slices_original
    cut = processing.parse_cutout(out)
    np.testing.assert_array_equal(cut.image, planes["IMAGE"][ys, xs])
    np.testing.assert_array_equal(cut.flags, planes["FLAGS"][ys, xs].astype(np.uint32))
    np.testing.assert_array_equal(cut.variance, planes["VARIANCE"][ys, xs])
    np.testing.assert_array_equal(cut.zodi, planes["ZODI"][ys, xs])
    # shifted WCS: same sky position for the same physical pixel
    h = cut.header
    assert h["CRPIX1"] == pytest.approx(full["IMAGE"].header["CRPIX1"] - xs.start)
    assert h["CRPIX2W"] == pytest.approx(1 - ys.start)
    assert h["CRPIX1A"] == pytest.approx(1 - xs.start)
    assert h["PSF_FWHM"] == 9.0 and h["MJD-AVG"] == 60800.7
    np.testing.assert_allclose(cut.wcs.all_pix2world([[3.0, 4.0]], 0),
                               w_full.all_pix2world([[3.0 + xs.start, 4.0 + ys.start]], 0),
                               atol=1e-10)
    assert cut.flag_bits["SOURCE"] == 21
    assert cut.flag_bits["HOT"] == 10


def test_s3_cutout_clipped_at_detector_edge():
    data, planes = _full_file(64)
    w_full = WCS(fits.open(io.BytesIO(data))["IMAGE"].header)
    ra, dec = w_full.all_pix2world([[1.0, 62.0]], 0)[0]
    out, _, _ = _fetch(data, ra, dec, 0.05)
    cut = processing.parse_cutout(out)
    ref = Cutout2D(planes["ZODI"], SkyCoord(ra * u.deg, dec * u.deg), 0.05 * u.deg, wcs=w_full,
                   mode="trim")
    np.testing.assert_array_equal(cut.zodi, ref.data)
    assert cut.zodi.shape[0] < 29 and cut.zodi.shape[1] < 29


def test_s3_missing_object_is_not_transient():
    data, _ = _full_file(64)
    with pytest.raises(s3cutout.S3Missing):
        _fetch(data, 150.0, 20.0, 0.05, status=404)
    with pytest.raises(s3cutout.S3Transient):
        _fetch(data, 150.0, 20.0, 0.05, status=503)


def test_flags_layout_rejects_non_row_tiles():
    n = 32
    hdu = fits.CompImageHDU(np.zeros((n, n), np.int32), name="FLAGS", compression_type="RICE_1",
                            tile_shape=(8, 8))
    buf = io.BytesIO()
    fits.HDUList([fits.PrimaryHDU(), hdu]).writeto(buf)
    raw = buf.getvalue()[2880:]
    with pytest.raises(s3cutout.S3LayoutError):
        s3cutout.parse_flags_layout(raw, 2880)


@needs_samples
def test_box_and_header_shift_reproduce_irsa_samples():
    """Reconstruct the full-frame header from one IRSA cutout, then predict the other two."""
    with fits.open(DL / "cut_0.1.fits") as h01:
        h = h01["IMAGE"].header
    # IRSA cut this one at full-frame 0-based pixel (351, 115) (found from the S3 file)
    full = s3cutout.shift_header(h, -351, -115, 2040, 2040)
    assert full["CRPIX1"] == 1020.5 and full["CRPIX2"] == 1020.5 and full["CRPIX1W"] == 1.0
    for name, size in (("cut_0.02.fits", 0.02), ("cut_0.1.fits", 0.1), ("cut_0.5.fits", 0.5)):
        with fits.open(DL / name) as hd:
            ref = hd["IMAGE"].header
        x0, x1, y0, y1 = s3cutout.cutout_box(full, *W0855, size)
        assert (x1 - x0, y1 - y0) == (ref["NAXIS1"], ref["NAXIS2"]), name
        got = s3cutout.shift_header(full, x0, y0, x1 - x0, y1 - y0)
        for k in ("CRPIX1", "CRPIX2", "CRPIX1A", "CRPIX2A", "CRPIX1W", "CRPIX2W", "NAXIS1",
                  "NAXIS2"):
            assert float(got[k]) == float(ref[k]), (name, k)


@pytest.mark.parametrize('content_range', [None, 'bytes 1-4/100', 'bytes 0-5/100'])
def test_range_reader_rejects_wrong_offsets(content_range):
    async def run():
        hdr = {} if content_range is None else {'Content-Range': content_range}
        async with httpx.AsyncClient(transport=httpx.MockTransport(
                lambda req: httpx.Response(206, headers=hdr, content=b'1234'))) as c:
            rd = s3cutout.RangeReader(c, 'https://example.test/a', collections.Counter())
            await rd.get(0, 4)
    with pytest.raises(s3cutout.S3LayoutError):
        asyncio.run(run())


def test_ignored_range_is_closed_without_reading_full_file():
    class Unreadable(httpx.AsyncByteStream):
        async def __aiter__(self):
            raise AssertionError('must not read a server response that ignores Range')
            yield b''
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(
                lambda req: httpx.Response(200, stream=Unreadable()))) as c:
            await s3cutout.RangeReader(c, 'https://example.test/a', collections.Counter()).get(0, 4)
    with pytest.raises(s3cutout.S3LayoutError, match='HTTP 200'):
        asyncio.run(run())


@pytest.mark.parametrize('q_descriptor,gap', [(False, 0), (False, 137), (True, 29)])
def test_flags_heap_gap_and_64bit_descriptors(q_descriptor, gap):
    blob, planes = _full_file(64)
    hdu = fitsstream.split_bytes(blob)[2]
    h = hdu.header()
    table_size = int(h['NAXIS1']) * int(h['NAXIS2'])
    desc = np.frombuffer(hdu.data_bytes[:table_size], dtype='>i4').reshape(-1, 2)
    heap = hdu.data_bytes[table_size:]
    if q_descriptor:
        h['TFORM1'] = '1QB'
        h['NAXIS1'] = 16
    table = desc.astype('>i8' if q_descriptor else '>i4').tobytes()
    h['THEAP'] = len(table) + gap
    h['PCOUNT'] = gap + len(heap)
    layout = s3cutout.parse_flags_layout(h.tostring().encode() + table, 12345)
    assert isinstance(layout, s3cutout.FlagsLayout)
    assert layout.heap_off == 12345 + len(h.tostring()) + len(table) + gap
    y0, y1 = 4, 13
    lo = int(layout.desc[y0:y1, 1].min())
    hi = int((layout.desc[y0:y1, 1] + layout.desc[y0:y1, 0]).max())
    flags, header = s3cutout.decode_flag_rows(layout, y0, y1, heap[lo:hi], lo)
    np.testing.assert_array_equal(flags, planes['FLAGS'][y0:y1])


def test_flags_descriptor_outside_heap_rejected():
    blob, _ = _full_file(32)
    hdu = fitsstream.split_bytes(blob)[2]
    raw = bytearray(hdu.header_bytes + hdu.data_bytes)
    raw[len(hdu.header_bytes):len(hdu.header_bytes) + 4] = (2**31 - 1).to_bytes(4, 'big')
    with pytest.raises(s3cutout.S3LayoutError, match='outside'):
        s3cutout.parse_flags_layout(bytes(raw), 0)


def test_sip_shift_at_high_declination_and_edges():
    from astropy.wcs import Sip
    w = WCS(_wcs_header(2040, ra0=248.162, dec0=66.753))
    a, b = np.zeros((4, 4)), np.zeros((4, 4))
    a[2, 0], a[1, 1], b[0, 2] = 1e-6, -3e-7, -8e-7
    w.sip = Sip(a, b, None, None, w.wcs.crpix)
    h = w.to_header(relax=True)
    h['NAXIS'], h['NAXIS1'], h['NAXIS2'] = 2, 2040, 2040
    h['CRPIX1W'], h['CRPIX2W'] = 1.0, 1.0
    ra, dec = w.all_pix2world([[3.25, 2035.75]], 0)[0]
    x0, x1, y0, y1 = s3cutout.cutout_box(h, ra, dec, 0.15)
    assert x0 == 0 and y1 == 2040
    cut = s3cutout.shift_header(h, x0, y0, x1-x0, y1-y0)
    pos = WCS(cut).all_world2pix([[ra, dec]], 0, tolerance=1e-8)[0]
    np.testing.assert_allclose(pos, [3.25-x0, 2035.75-y0], atol=1e-7)
    assert cut['CRPIX2W'] == 1-y0


def test_failed_read_closes_sibling_before_fallback():
    async def run():
        closed = asyncio.Event()
        async def upstream(req):
            if req.headers['Range'].startswith('bytes=0-'):
                return httpx.Response(404)
            try:
                await asyncio.Event().wait()
            finally:
                closed.set()
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as c:
            with pytest.raises(s3cutout.S3Missing):
                await s3cutout.fetch_cutout_bytes(c, 'missing.fits', 1, 2, 0.1,
                                                 collections.Counter())
        assert closed.is_set()
    asyncio.run(run())
