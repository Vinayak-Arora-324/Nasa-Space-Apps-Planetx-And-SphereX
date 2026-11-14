"""Minimal incremental FITS splitter.

IRSA cutouts are multi-extension FITS files whose bulk (the EPSF table) comes after the
pixel planes we need. HTTP Range is not honoured by the cutout service, so we read the
stream incrementally, split it into HDUs as bytes arrive, and stop once we have enough.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from astropy.io import fits

BLOCK = 2880
CARD = 80

_BITPIX_DTYPE = {8: ">u1", 16: ">i2", 32: ">i4", 64: ">i8", -32: ">f4", -64: ">f8"}


class FitsFormatError(ValueError):
    pass


@dataclass
class RawHDU:
    header_bytes: bytes
    data_bytes: bytes  # unpadded data section
    cards: dict  # minimal keyword -> raw value string, for structural keywords

    def header(self) -> fits.Header:
        return fits.Header.fromstring(self.header_bytes.decode("ascii", errors="replace"))

    @property
    def name(self) -> str:
        return str(self.cards.get("EXTNAME", "")).strip("' ").upper()


def _parse_value(raw: str):
    raw = raw.strip()
    if raw.startswith("'"):
        end = raw.find("'", 1)
        return raw[1:end].rstrip() if end > 0 else raw[1:]
    raw = raw.split("/", 1)[0].strip()
    try:
        return int(raw)
    except ValueError:
        try:
            return float(raw)
        except ValueError:
            return raw


def scan_header(buf: bytes | bytearray, start: int):
    """Return (end_of_header_offset, cards) if a complete header starts at `start`, else None."""
    cards: dict = {}
    pos = start
    n = len(buf)
    while pos + BLOCK <= n:
        block = bytes(buf[pos:pos + BLOCK])
        for i in range(0, BLOCK, CARD):
            card = block[i:i + CARD].decode("ascii", errors="replace")
            key = card[:8].strip()
            if key == "END":
                return pos + BLOCK, cards
            if card[8:10] == "= " and key in _STRUCTURAL:
                cards[key] = _parse_value(card[10:])
        pos += BLOCK
    return None


_scan_header = scan_header  # backwards-compatible name

_STRUCTURAL = {"SIMPLE", "XTENSION", "BITPIX", "NAXIS", "PCOUNT", "GCOUNT", "EXTNAME", "EXTEND",
               *{f"NAXIS{i}" for i in range(1, 1000)}}


def data_size(cards: dict) -> int:
    """Unpadded size in bytes of the data section described by structural keywords."""
    bitpix = int(cards.get("BITPIX", 8))
    naxis = int(cards.get("NAXIS", 0))
    if naxis == 0:
        prod = 0
    else:
        prod = 1
        for i in range(1, naxis + 1):
            prod *= int(cards[f"NAXIS{i}"])
    pcount = int(cards.get("PCOUNT", 0))
    gcount = int(cards.get("GCOUNT", 1))
    if naxis == 0 and pcount == 0:
        return 0
    return abs(bitpix) // 8 * gcount * (pcount + prod)


def padded(n: int) -> int:
    return (n + BLOCK - 1) // BLOCK * BLOCK


class FitsSplitter:
    """Feed bytes with `feed()`; completed HDUs accumulate in `.hdus`."""

    def __init__(self) -> None:
        self.buf = bytearray()
        self.pos = 0  # start of the next HDU in buf
        self.hdus: list[RawHDU] = []

    def feed(self, chunk: bytes) -> int:
        """Append bytes; return number of complete HDUs so far."""
        if chunk:
            self.buf.extend(chunk)
        while True:
            if not self.hdus and len(self.buf) >= 6 and self.pos == 0 and self.buf[:6] != b"SIMPLE":
                raise FitsFormatError("stream does not start with a FITS primary header: %r"
                                      % bytes(self.buf[:60]))
            scanned = scan_header(self.buf, self.pos)
            if scanned is None:
                break
            hdr_end, cards = scanned
            nbytes = data_size(cards)
            end = hdr_end + padded(nbytes)
            if len(self.buf) < hdr_end + nbytes:
                break
            self.hdus.append(RawHDU(bytes(self.buf[self.pos:hdr_end]),
                                    bytes(self.buf[hdr_end:hdr_end + nbytes]), cards))
            self.pos = end
            if len(self.buf) < end:  # padding of the last HDU not yet received; fine
                break
        return len(self.hdus)

    def consumed_bytes(self) -> bytes:
        """Bytes up to and including the last complete HDU (padding truncated to what arrived)."""
        if not self.hdus:
            return b""
        return bytes(self.buf[:min(self.pos, len(self.buf))])


def split_bytes(data: bytes) -> list[RawHDU]:
    s = FitsSplitter()
    s.feed(data)
    return s.hdus


def image_array(hdu: RawHDU) -> np.ndarray:
    """Decode an image HDU into a native-endian numpy array (shape NAXIS2, NAXIS1)."""
    c = hdu.cards
    bitpix = int(c["BITPIX"])
    naxis = int(c["NAXIS"])
    shape = tuple(int(c[f"NAXIS{i}"]) for i in range(naxis, 0, -1))
    arr = np.frombuffer(hdu.data_bytes, dtype=_BITPIX_DTYPE[bitpix], count=int(np.prod(shape)))
    return arr.reshape(shape).astype(arr.dtype.newbyteorder("="))


_TFORM_DTYPE = {"J": ">i4", "E": ">f4", "D": ">f8", "I": ">i2", "K": ">i8", "B": ">u1"}


def bintable_row0(header: fits.Header, data_bytes: bytes) -> dict[str, np.ndarray]:
    """Decode the first row of a simple fixed-width binary table (numeric columns only).

    Columns with TDIMn are reshaped to numpy order (reversed FITS order)."""
    out = {}
    offset = 0
    for i in range(1, int(header["TFIELDS"]) + 1):
        tform = str(header[f"TFORM{i}"]).strip()
        j = 0
        while j < len(tform) and tform[j].isdigit():
            j += 1
        rep = int(tform[:j]) if j else 1
        code = tform[j]
        if code not in _TFORM_DTYPE:
            raise FitsFormatError(f"unsupported TFORM {tform}")
        dt = np.dtype(_TFORM_DTYPE[code])
        vals = np.frombuffer(data_bytes, dtype=dt, count=rep, offset=offset).astype(dt.newbyteorder("="))
        offset += rep * dt.itemsize
        tdim = header.get(f"TDIM{i}")
        if tdim:
            dims = [int(x) for x in str(tdim).strip("() ").split(",")]
            vals = vals.reshape(tuple(reversed(dims)))
        out[str(header[f"TTYPE{i}"]).strip()] = vals
    return out
