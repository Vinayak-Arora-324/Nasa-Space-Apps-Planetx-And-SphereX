"""Build the synthetic cluster dataset used to test the static object loader.

Six made-up clusters (ids `test:...`) placed to exercise the tiling: one near each pole, two either
side of the RA 0/360 wrap, one exactly on a declination band edge and one with a large angular size
(to exercise the extent margin of a cone query). Nothing here is real data, so every record says so:
evidence and distance tier are `illustrative`. This is also the template for Phase 1 build scripts
(`objects_static.write_dataset` does the tiling, hashing and validation).

    uv run python backend/scripts/build_objects_fixture.py
    uv run python backend/scripts/build_objects_fixture.py --check      # rebuild in a temp dir, compare

`--check` exits 1 when the committed output differs from a fresh build.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from spherex_app import objects, objects_static  # noqa: E402

OUT = ROOT / "backend" / "tests" / "fixtures" / "objects" / "fixture-clusters"
SCRIPT_VERSION = 1
CATALOGUE = "Space Maps test fixture (synthetic)"
SRC = "synthetic test value"
# (id suffix, name, ra, dec, distance pc, angular diameter deg or None, apparent mag)
CLUSTERS = [
    ("north-pole", "Fixture North Pole", 120.0, 89.5, 500.0, None, 8.0),
    ("south-pole", "Fixture South Pole", 300.0, -89.2, 800.0, None, 9.5),
    ("wrap-west", "Fixture Wrap West", 359.9, 10.0, 300.0, None, 7.0),
    ("wrap-east", "Fixture Wrap East", 0.1, 10.2, 350.0, 4.0, 6.5),  # radius 2 deg: crosses tiles
    ("band-edge", "Fixture Band Edge", 45.0, 20.0, 1200.0, None, 10.0),  # dec exactly on a band edge
    ("mid-sky", "Fixture Mid Sky", 180.0, 0.0, 150.0, 1.0, 5.5),
]


def build_records() -> list[dict]:
    prov = {"source": "static:fixture-clusters", "dataset": "fixture-clusters", "catalogue": CATALOGUE,
            "version": f"fixture {SCRIPT_VERSION}", "citation": "none (synthetic)", "url": None}
    out = []
    for key, name, ra, dec, d, diam, mag in CLUSTERS:
        ang = None
        if diam is not None:
            ang = {"major": objects.quantity(diam, SRC, "illustrative", "deg"), "minor": None, "pa": None}
        out.append(objects.record(
            id=f"test:{key}", kind="cluster", name=name, designations=[],
            position={"model": "fixed", "ra": ra, "dec": dec, "epoch": 2016.0, "method": "assumed",
                      "dist": objects.quantity(d, SRC, "illustrative", "pc")},
            size={"radius": objects.quantity(3.0, SRC, "illustrative", "pc"), "angular": ang},
            props={"n_members": objects.quantity(100, SRC, "illustrative")},
            provenance=prov, evidence="illustrative", render={"mag": mag}))
    return out


def build(out_dir: Path) -> dict:
    return objects_static.write_dataset(
        build_records(), out_dir, dataset="fixture-clusters", kinds=["cluster"],
        provenance={"catalogue": CATALOGUE, "version": f"fixture {SCRIPT_VERSION}",
                    "citation": "none (synthetic)", "url": None, "source_sha256": None},
        build={"script": "backend/scripts/build_objects_fixture.py", "script_version": SCRIPT_VERSION},
        band_deg=10, precedence=50)


def _files(d: Path) -> dict[str, bytes]:
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--check", action="store_true",
                    help="rebuild into a temp dir and compare with --out; exit 1 on any difference")
    a = ap.parse_args()
    if a.check:
        with tempfile.TemporaryDirectory() as tmp:
            build(Path(tmp))
            fresh, have = _files(Path(tmp)), (_files(a.out) if a.out.is_dir() else {})
        diff = sorted(k for k in fresh.keys() | have.keys() if fresh.get(k) != have.get(k))
        if diff:
            print(f"{a.out} differs from a fresh build: {', '.join(diff)}", file=sys.stderr)
            return 1
        print(f"{a.out} is up to date ({len(fresh)} files)")
        return 0
    m = build(a.out)
    print(f"wrote {m['count']} records in {len(m['tiles'])} tiles to {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
