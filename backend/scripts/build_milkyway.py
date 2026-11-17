"""Build the Milky Way glow that the 3D fly-through draws behind its stars (frontend/data/milkyway.webp + .json).

Source: NASA/Goddard Space Flight Center Scientific Visualization Studio, "Deep Star Maps 2020" (SVS 4851, Ernie
Wright), the 4k celestial-coordinate map: 1.7 billion stars from Hipparcos-2, Tycho-2 and Gaia DR2 in a linear,
half-float OpenEXR, plate carree, centred on RA 0h with RA increasing to the left.

The fly-through already draws stars one by one (the XHIP bright stars, and Gaia in the patch), so only the light of
the stars it cannot list should come from this map. A 9x9 then a 5x5 median takes out the resolved stars and keeps
the diffuse glow and the dust lanes (a morphological opening left round blobs). The few bright stars drawn larger
than the median survive as smudges; anything far above the local background is pulled down to it. The result is
2048x1024, stored sRGB-encoded in 8 bits (the page uploads it as an SRGB8 texture, so filtering happens in linear
light), divided by `scale`, the linear value that maps to 255.

Needs ImageMagick 7 with OpenEXR and WebP (`magick -list format`).

    uv run python backend/scripts/build_milkyway.py
    uv run python backend/scripts/build_milkyway.py --exr starmap_2020_4k.exr     # from a saved download
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import httpx
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT_IMG = ROOT / "frontend" / "data" / "milkyway.webp"
OUT_META = ROOT / "frontend" / "data" / "milkyway.json"
SRC_URL = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/starmap_2020_4k.exr"
W, H = 2048, 1024
SMUDGE = 1.8          # a pixel brighter than this many times its wider-area median is a left-over star


def magick(*args: str, stdin: bytes | None = None) -> bytes:
    return subprocess.run(["magick", *args], input=stdin, stdout=subprocess.PIPE, check=True).stdout


def read_float(path: Path, *ops: str) -> np.ndarray:
    raw = magick(str(path), *ops, "-depth", "32", "-define", "quantum:format=floating-point", "RGB:-")
    return np.frombuffer(raw, dtype="<f4").reshape(H, W, 3).copy()


def srgb_encode(x: np.ndarray) -> np.ndarray:
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(np.maximum(x, 0.0031308), 1 / 2.4) - 0.055)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--exr", type=Path, help="a saved starmap_2020_4k.exr (downloaded when omitted)")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        src = args.exr
        if src is None:
            src = Path(tmp) / "starmap_2020_4k.exr"
            print(f"downloading {SRC_URL}", file=sys.stderr)
            with httpx.stream("GET", SRC_URL, timeout=600, follow_redirects=True) as r:
                r.raise_for_status()
                with src.open("wb") as f:
                    for chunk in r.iter_bytes():
                        f.write(chunk)
        glow = read_float(src, "-statistic", "Median", "9x9", "-statistic", "Median", "5x5", "-resize", f"{W}x{H}!")
        # Wider-area background: the same image, medianed over ~1.5 degrees.
        tmp_exr = Path(tmp) / "glow.exr"
        magick("-size", f"{W}x{H}", "-depth", "32", "-define", "quantum:format=floating-point", "RGB:-",
               str(tmp_exr), stdin=glow.astype("<f4").tobytes())
        wide = read_float(tmp_exr, "-statistic", "Median", "17x17")

    lum = glow @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    lum_w = wide @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    k = np.minimum(1.0, SMUDGE * lum_w / np.maximum(lum, 1e-9))[..., None]
    glow = np.maximum(glow * k, 0.0)

    scale = float(np.percentile(glow.max(axis=2), 99.97))
    img = np.clip(np.rint(srgb_encode(np.clip(glow / scale, 0.0, 1.0)) * 255.0), 0, 255).astype(np.uint8)
    OUT_IMG.parent.mkdir(parents=True, exist_ok=True)
    magick("-size", f"{W}x{H}", "-depth", "8", "RGB:-", "-define", "webp:lossless=false", "-quality", "94",
           str(OUT_IMG), stdin=img.tobytes())
    meta = {
        "image": OUT_IMG.name, "width": W, "height": H,
        "projection": "plate carree, ICRS; u = 0.5 - RA/360 (mod 1), v = 0.5 - Dec/180",
        "encoding": "sRGB 8-bit; linear = srgb_decode(texel) * scale (in the source map's linear units)",
        "scale": scale,
        "median": float(np.median(glow.max(axis=2))),
        "credit": "NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps 2020 "
                  "(Hipparcos-2, Tycho-2, Gaia DR2); resolved stars removed",
        "source": "https://svs.gsfc.nasa.gov/4851",
    }
    OUT_META.write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {OUT_IMG} ({OUT_IMG.stat().st_size / 1e6:.2f} MB) and {OUT_META}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
