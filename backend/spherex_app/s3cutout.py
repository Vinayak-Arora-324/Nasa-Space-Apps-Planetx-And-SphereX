"""Cutouts assembled from the public S3 mirror of the SPHEREx Level-2 files with HTTP Range.

The S3 objects are the same files that IRSA serves. Their layout, verified on DR1
`l2b-v27` files, is as follows. Offsets differ between files, so they are discovered per
file and never hard-coded.

    HDU0 PRIMARY   header 2880 B, no data
    HDU1 IMAGE     header 23040 or 25920 B; float32 2040x2040 (16,646,400 B), uncompressed
    HDU2 FLAGS     RICE_1 tile-compressed int32 image stored as a BINTABLE: header 17280 B,
                   2040 rows x 8 B descriptors (1PB: n_bytes, heap_offset), then a ~11.8 MB
                   heap. ZTILE1=2040, ZTILE2=1: **one tile per image row**, so any row
                   range can be fetched and decoded on its own.
    HDU3 VARIANCE  header 11520 B; float32 2040x2040, uncompressed
    HDU4 ZODI      header 11520 B; float32 2040x2040, uncompressed
    HDU5 EPSF      ~3.86 MB binary table (not needed)
    HDU6 WCS-WAVE  one-row binary table (fetched separately, see archive.wave_table)

IRSA's cutout service behaves like `astropy.nddata.Cutout2D(mode="trim")`. The centre is
the SIP `all_world2pix` of the requested position. The size in pixels is
round(size / pixel scale) per axis, and the edges are ceil(pos -/+ n/2), clipped to the
detector. Every CRPIXn (primary and alternate WCSs `A`, `W`) is shifted by the pixel
origin, and FLAGS is delivered uncompressed. This module reproduces that box from the
full-frame IMAGE header. It range-reads only the needed rows of each plane, using one
request per plane, and emits FITS bytes in the same format as a truncated IRSA cutout
(HDUs 0..4). Callers therefore cannot tell the two sources apart.

Whole rows are read because a row is the smallest contiguous unit. A per-pixel-slice read
would need ~90 requests per plane per frame. The cost is bandwidth: about 26 KB per
cutout row for the three float planes and ~6 KB for FLAGS.
"""

from __future__ import annotations

import asyncio
import io
import math
import re
import warnings
from dataclasses import dataclass

import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
from astropy.wcs.utils import proj_plane_pixel_scales

from . import config
from .fitsstream import BLOCK, data_size, padded, scan_header

warnings.simplefilter("ignore", FITSFixedWarning)


class S3LayoutError(ValueError):
    """The file is not laid out the way this reader expects (caller falls back to IRSA)."""


class NoOverlap(ValueError):
    pass


# Typical header sizes, used to fetch speculatively in parallel. They are always verified.
_IMG_HDR_MAX = 10 * BLOCK  # covers 23040 and 25920 (and one block of slack)
_FLAGS_HDR_GUESS = 17280
_PLANE_HDR_GUESS = 11520
_FULL_PLANE_BYTES = 2040 * 2040 * 4

_CRPIX_RE = re.compile(r"^CRPIX([12])([A-Z]?)$")


def s3_url(uri: str) -> str:
    return config.S3_BASE + uri.removeprefix(config.URI_S3_STRIP_PREFIX)


# --- geometry: reproduce IRSA's cutout box -------------------------------------------------

def cutout_box(header: fits.Header, ra: float, dec: float, size_deg: float):
    """Pixel box (x0, x1, y0, y1), 0-based and half-open, of IRSA's cutout of the full frame."""
    w = WCS(header)
    px, py = w.all_world2pix([[ra, dec]], 0, tolerance=1e-8, maxiter=50, quiet=True)[0]
    if not (np.isfinite(px) and np.isfinite(py)):
        raise NoOverlap("position does not project onto the detector")
    sx, sy = proj_plane_pixel_scales(w)  # deg / pixel along x and y
    nx = int(np.round(size_deg / sx))
    ny = int(np.round(size_deg / sy))
    w_full, h_full = int(header["NAXIS1"]), int(header["NAXIS2"])
    x0 = max(int(math.ceil(px - nx / 2.0)), 0)
    x1 = min(int(math.ceil(px + nx / 2.0)), w_full)
    y0 = max(int(math.ceil(py - ny / 2.0)), 0)
    y1 = min(int(math.ceil(py + ny / 2.0)), h_full)
    if x1 <= x0 or y1 <= y0:
        raise NoOverlap(f"cutout box empty (centre pixel {px:.1f}, {py:.1f})")
    return x0, x1, y0, y1


def shift_header(h: fits.Header, x0: int, y0: int, nx: int, ny: int) -> fits.Header:
    """Header of a sub-array starting at 0-based pixel (x0, y0), as IRSA writes it."""
    h = h.copy()
    h["NAXIS1"] = nx
    h["NAXIS2"] = ny
    for key in list(h.keys()):
        m = _CRPIX_RE.match(key)
        if m:
            h[key] = float(h[key]) - (x0 if m.group(1) == "1" else y0)
    return h


def _hdu_bytes(h: fits.Header, data: np.ndarray | None) -> bytes:
    out = h.tostring().encode("ascii")  # padded to a whole number of blocks
    if data is not None:
        raw = np.ascontiguousarray(data).tobytes()
        out += raw + b"\0" * (padded(len(raw)) - len(raw))
    return out


# --- FLAGS: RICE_1 tiles, one per row -------------------------------------------------------

@dataclass
class FlagsLayout:
    header: fits.Header  # compressed (BINTABLE) header
    desc: np.ndarray  # (n_rows, 2) int64: n_bytes, heap offset
    heap_off: int  # absolute file offset of the heap
    next_hdu: int  # absolute file offset of the following HDU


def parse_flags_layout(buf: bytes, start: int) -> FlagsLayout | int:
    """Parse the FLAGS header and descriptor table from bytes that begin at file offset `start`.

    Returns the number of bytes needed if `buf` is too short."""
    sc = scan_header(buf, 0)
    if sc is None:
        return len(buf) + 4 * BLOCK
    hlen, cards = sc
    h = fits.Header.fromstring(buf[:hlen].decode("ascii", "replace"))
    if h.get("XTENSION") != "BINTABLE" or not h.get("ZIMAGE") or h.get("EXTNAME") != "FLAGS":
        raise S3LayoutError(f"HDU2 is not a compressed FLAGS image ({h.get('XTENSION')}, "
                            f"{h.get('EXTNAME')})")
    if str(h.get("ZCMPTYPE", "")).strip() != "RICE_1" or int(h.get("TFIELDS", 0)) != 1:
        raise S3LayoutError(f"unsupported FLAGS compression {h.get('ZCMPTYPE')}")
    if int(h.get("ZTILE2", 0)) != 1 or int(h.get("ZTILE1", 0)) != int(h["ZNAXIS1"]) \
            or int(h["NAXIS2"]) != int(h["ZNAXIS2"]):
        raise S3LayoutError("FLAGS tiles are not one image row each")
    tform = str(h["TFORM1"]).strip().upper()
    if not re.fullmatch(r"1[PQ]B(?:\(\d*\))?", tform):
        raise S3LayoutError(f"unexpected FLAGS TFORM1 {tform}")
    if int(h.get("ZBITPIX", 0)) != 32 or int(h.get("ZNAXIS", 0)) != 2:
        raise S3LayoutError("FLAGS is not a two-dimensional int32 image")
    if tform.startswith("1P"):
        ddt = ">i4"
    elif tform.startswith("1Q"):
        ddt = ">i8"
    else:
        raise S3LayoutError(f"unexpected FLAGS TFORM1 {tform}")
    nrow, rowlen = int(h["NAXIS2"]), int(h["NAXIS1"])
    if rowlen != 2 * np.dtype(ddt).itemsize:
        raise S3LayoutError("FLAGS table has extra columns")
    theap = int(h.get("THEAP", nrow * rowlen))
    heap_size = nrow * rowlen + int(h["PCOUNT"]) - theap
    if theap < nrow * rowlen or heap_size < 0:
        raise S3LayoutError("invalid FLAGS heap offset/size")
    if len(buf) < hlen + nrow * rowlen:
        return hlen + nrow * rowlen
    desc = np.frombuffer(buf, dtype=ddt, count=2 * nrow, offset=hlen).reshape(nrow, 2).astype(np.int64)
    if (desc < 0).any() or (desc[:, 0] > heap_size - desc[:, 1]).any():
        raise S3LayoutError("FLAGS descriptor points outside its heap")
    return FlagsLayout(h, desc, start + hlen + theap, start + hlen + padded(data_size(cards)))


def decode_flag_rows(layout: FlagsLayout, y0: int, y1: int, heap: bytes, heap_lo: int):
    """Decode rows [y0, y1) of the FLAGS image. Returns (int32 array, uncompressed header).

    `heap` holds heap bytes from heap offset `heap_lo`. A mini compressed HDU that holds
    only those tiles is built so that astropy's own (public) RICE decoder does the work."""
    n = y1 - y0
    d = layout.desc[y0:y1].copy()
    d[:, 1] -= heap_lo
    if (d[:, 1] < 0).any() or (d[:, 1] + d[:, 0] > len(heap)).any():
        raise S3LayoutError("FLAGS heap range does not cover the requested tiles")
    h = layout.header.copy()
    h["NAXIS2"] = n
    h["ZNAXIS2"] = n
    h["PCOUNT"] = len(heap)
    h.remove("THEAP", ignore_missing=True)
    ddt = ">i4" if str(h["TFORM1"]).strip().upper().startswith("1P") else ">i8"
    table = d.astype(ddt).tobytes() + heap
    blob = (fits.PrimaryHDU().header.tostring().encode("ascii")
            + h.tostring().encode("ascii") + table + b"\0" * (padded(len(table)) - len(table)))
    with fits.open(io.BytesIO(blob), memmap=False) as hd:
        hdu = hd[1]
        data = np.array(hdu.data, dtype=np.int32)
        hdr = hdu.header.copy()
    if data.shape != (n, int(layout.header["ZNAXIS1"])):
        raise S3LayoutError(f"decoded FLAGS shape {data.shape}")
    # astropy reports NAXIS2 = n; the caller resets NAXIS1/2 and CRPIX for the cutout
    return data, hdr


# --- range reader ----------------------------------------------------------------------------

class RangeReader:
    """Range GETs on one S3 object, with byte/request accounting."""

    def __init__(self, client: httpx.AsyncClient, url: str, stats) -> None:
        self.client, self.url, self.stats = client, url, stats

    async def get(self, off: int, length: int) -> bytes:
        if length <= 0:
            return b""
        async with self.client.stream("GET", self.url,
                                      headers={"Range": f"bytes={off}-{off + length - 1}"}) as r:
            self.stats["s3_requests"] += 1
            if r.status_code == 416:
                return b""  # past EOF (also used by speculative header reads)
            if r.status_code >= 500 or r.status_code == 429:
                raise S3Transient(f"S3 HTTP {r.status_code}")
            if r.status_code in (403, 404):
                raise S3Missing(f"S3 HTTP {r.status_code} for {self.url.rsplit('/', 1)[-1]}")
            if r.status_code != 206:
                # Close immediately if Range was ignored; never download a full 70 MB file.
                raise S3LayoutError(f"S3 Range request returned HTTP {r.status_code}")
            m = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", r.headers.get("content-range", ""))
            if m is None:
                raise S3LayoutError("missing/invalid S3 Content-Range")
            lo, hi, total = map(int, m.groups())
            if lo != off or hi != min(off + length, total) - 1 or hi < lo:
                raise S3LayoutError("S3 Content-Range does not match request")
            data = bytearray()
            async for chunk in r.aiter_bytes():
                self.stats["net_bytes"] += len(chunk)
                self.stats["s3_bytes"] += len(chunk)
                data.extend(chunk)
                if len(data) > hi - lo + 1:
                    raise S3LayoutError("S3 Range response exceeds its declared length")
            if len(data) != hi - lo + 1:
                raise S3Transient("short S3 Range response")
            return bytes(data)


class S3Transient(RuntimeError):
    pass


class S3Missing(RuntimeError):
    """Not on the mirror (e.g. newest data not yet synced): fall back, do not retry."""


async def _gather_reads(*reads):
    """Close sibling range requests before retrying/falling back after one read fails."""
    tasks = [asyncio.ensure_future(read) for read in reads]
    try:
        return await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


async def _header_at(rd: RangeReader, off: int, pre: bytes = b"", want: int = 4 * BLOCK):
    """(header bytes, cards) of the HDU starting at `off`; `pre` may hold its first bytes."""
    buf = pre
    while True:
        sc = scan_header(buf, 0)
        if sc is not None:
            return buf[:sc[0]], sc[1]
        if len(buf) > 200 * BLOCK:
            raise S3LayoutError(f"no END card within {len(buf)} bytes at {off}")
        more = await rd.get(off + len(buf), max(want, len(buf)))
        if not more:
            raise S3LayoutError("unexpected EOF while reading a header")
        buf += more


def _check_plane(cards: dict, name: str, ref_naxis: tuple[int, int]):
    ext = str(cards.get("EXTNAME", "")).strip()
    if ext != name or int(cards.get("BITPIX", 0)) != -32 or int(cards.get("NAXIS", 0)) != 2 or \
            (int(cards["NAXIS1"]), int(cards["NAXIS2"])) != ref_naxis:
        raise S3LayoutError(f"unexpected {name} HDU ({ext}, BITPIX={cards.get('BITPIX')})")


async def _plane(rd: RangeReader, off: int, name: str, ref_naxis, y0: int, y1: int,
                 hdr_guess: int = _PLANE_HDR_GUESS):
    """Fetch a float32 plane's header and rows [y0, y1) in parallel, guessing the header
    length. Returns (header bytes, row bytes, offset of next HDU)."""
    rowb = ref_naxis[0] * 4
    hdr_task = rd.get(off, hdr_guess)
    rows_task = rd.get(off + hdr_guess + y0 * rowb, (y1 - y0) * rowb)
    pre, rows = await _gather_reads(hdr_task, rows_task)
    hb, cards = await _header_at(rd, off, pre)
    _check_plane(cards, name, ref_naxis)
    if len(hb) != hdr_guess:  # guessed wrong: refetch the rows at the right place
        rows = await rd.get(off + len(hb) + y0 * rowb, (y1 - y0) * rowb)
    if len(rows) != (y1 - y0) * rowb:
        raise S3LayoutError(f"short read of {name} rows")
    return hb, rows, off + len(hb) + padded(data_size(cards))


async def fetch_cutout_bytes(client: httpx.AsyncClient, uri: str, ra: float, dec: float,
                             size: float, stats) -> bytes:
    """FITS bytes of HDUs 0..4 of the IRSA-equivalent cutout, read from S3 with Range."""
    rd = RangeReader(client, s3_url(uri), stats)
    # Round trip 1: primary + IMAGE header, and FLAGS header + descriptors at their usual place
    flags_guess = BLOCK + 23040 + _FULL_PLANE_BYTES
    head, fpre = await _gather_reads(
        rd.get(0, BLOCK + _IMG_HDR_MAX),
        rd.get(flags_guess, _FLAGS_HDR_GUESS + 2040 * 8 + 2 * BLOCK),
    )
    if not head.startswith(b"SIMPLE"):
        raise S3LayoutError("not a FITS file")
    sc = scan_header(head, 0)
    if sc is None:
        raise S3LayoutError("primary header too long")
    p_len, p_cards = sc
    if data_size(p_cards):
        raise S3LayoutError("primary HDU has data")
    primary_hb = head[:p_len]
    img_hb, img_cards = await _header_at(rd, p_len, head[p_len:])
    if str(img_cards.get("EXTNAME", "")).strip() != "IMAGE" or int(img_cards.get("BITPIX", 0)) != -32:
        raise S3LayoutError("HDU1 is not a float32 IMAGE")
    ref_naxis = (int(img_cards["NAXIS1"]), int(img_cards["NAXIS2"]))
    img_data = p_len + len(img_hb)
    flags_off = img_data + padded(data_size(img_cards))

    img_hdr, box = await asyncio.to_thread(_image_header_and_box, img_hb, ra, dec, size)
    x0, x1, y0, y1 = box
    rowb = ref_naxis[0] * 4

    # FLAGS layout (normally already in fpre)
    fbuf = fpre[flags_off - flags_guess:] if 0 <= flags_off - flags_guess < len(fpre) else b""
    while True:
        lay = parse_flags_layout(fbuf, flags_off)
        if isinstance(lay, FlagsLayout):
            break
        fbuf += await rd.get(flags_off + len(fbuf), lay - len(fbuf))
        if len(fbuf) < lay:
            raise S3LayoutError("EOF in FLAGS table")
    heap_lo = int(lay.desc[y0:y1, 1].min())
    heap_hi = int((lay.desc[y0:y1, 1] + lay.desc[y0:y1, 0]).max())

    # Round trip 2: everything else in parallel (headers guessed, verified after)
    var_off = lay.next_hdu
    zodi_off_guess = var_off + _PLANE_HDR_GUESS + padded(ref_naxis[0] * ref_naxis[1] * 4)
    img_rows, heap, var, zodi = await _gather_reads(
        rd.get(img_data + y0 * rowb, (y1 - y0) * rowb),
        rd.get(lay.heap_off + heap_lo, heap_hi - heap_lo),
        _plane(rd, var_off, "VARIANCE", ref_naxis, y0, y1),
        _speculative(_plane(rd, zodi_off_guess, "ZODI", ref_naxis, y0, y1)),
    )
    var_hb, var_rows, zodi_off = var
    if zodi_off != zodi_off_guess:  # VARIANCE header was not the usual size: guess was wrong
        zodi = await _plane(rd, zodi_off, "ZODI", ref_naxis, y0, y1)
    elif isinstance(zodi, BaseException):
        raise zodi
    zodi_hb, zodi_rows, _ = zodi
    if len(img_rows) != (y1 - y0) * rowb or len(heap) != heap_hi - heap_lo:
        raise S3LayoutError("short read of IMAGE rows / FLAGS heap")

    return await asyncio.to_thread(
        _assemble, primary_hb, img_hdr, img_rows, lay, heap, heap_lo, var_hb, var_rows,
        zodi_hb, zodi_rows, box, ref_naxis[0])


async def _speculative(coro):
    """Await a read made at a guessed offset; a layout error is returned, not raised, because
    it only matters if the guess turns out to be right."""
    try:
        return await coro
    except S3LayoutError as e:
        return e


def _image_header_and_box(img_hb: bytes, ra, dec, size):
    h = fits.Header.fromstring(img_hb.decode("ascii", "replace"))
    return h, cutout_box(h, ra, dec, size)


def _rows_to_plane(rows: bytes, width: int, x0: int, x1: int) -> np.ndarray:
    a = np.frombuffer(rows, dtype=">f4").reshape(-1, width)
    return a[:, x0:x1]


def _assemble(primary_hb, img_hdr, img_rows, lay, heap, heap_lo, var_hb, var_rows, zodi_hb,
              zodi_rows, box, width) -> bytes:
    x0, x1, y0, y1 = box
    nx, ny = x1 - x0, y1 - y0
    out = [primary_hb]
    out.append(_hdu_bytes(shift_header(img_hdr, x0, y0, nx, ny),
                          _rows_to_plane(img_rows, width, x0, x1)))
    flags, fl_hdr = decode_flag_rows(lay, y0, y1, heap, heap_lo)
    out.append(_hdu_bytes(shift_header(fl_hdr, x0, y0, nx, ny),
                          flags[:, x0:x1].astype(">i4")))
    for hb, rows in ((var_hb, var_rows), (zodi_hb, zodi_rows)):
        h = fits.Header.fromstring(hb.decode("ascii", "replace"))
        out.append(_hdu_bytes(shift_header(h, x0, y0, nx, ny), _rows_to_plane(rows, width, x0, x1)))
    return b"".join(out)
