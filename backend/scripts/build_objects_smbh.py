"""Build the `smbh-curated` object dataset: eight supermassive black holes, each placed at its host galaxy.

Inputs:
- `backend/data/sources/smbh-curated/smbh.json`: hand-curated from the papers (format `space-maps.smbh-curated/1`),
  every number with `src` (a key of `papers`) and `where`. It is never downloaded; the build refuses any number
  without both.
- the BUILT `galaxies` dataset (`frontend/data/objects/galaxies/`): the host galaxy's `ra`, `dec`, adopted distance,
  distance method and evidence are copied from its records, so a black hole and its galaxy never have two distances
  (docs/object-framework.md 18.8.2). Nothing about a host is written in this script or in smbh.json.

Mass rescaling: a dynamical mass scales linearly with the distance it was derived at, so
`mass = published mass x D_adopted / D_published`, applied to the value and both interval ends. The paper's mass
and distance are kept as `props.mass_published` and `props.dist_published` (shown as "not used"). When the host's
distance is derived (evidence `derived`) the rescaled mass is `inferred`, and so is the record's evidence. A black hole
with `rescale: false` (M31*) keeps the published mass and says why in `props.mass_note`.

Design: docs/object-framework.md sections 18.8 and 18.18 (item 1: the SMBHs live in their own dataset, apart from
`bh-curated`'s Gaia values; Sgr A* stays in `bh-curated`).

    uv run python backend/scripts/build_objects_smbh.py              # build from the committed inputs
    uv run python backend/scripts/build_objects_smbh.py --check      # rebuild in a temp dir, compare, verify

`--check` exits 1 when the committed dataset differs from a fresh build, fails `objects_static.verify_dataset`, or
when a host galaxy's distance has drifted from the one the committed dataset used (the host is named).
There is no network step: `--refresh` is accepted and does nothing.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from collections import Counter
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from spherex_app import objects, objects_static  # noqa: E402
import build_objects_bh as bhb  # noqa: E402  (number helpers, paper citations, the Schwarzschild constant)

DATASET = "smbh-curated"
OUT = ROOT / "frontend" / "data" / "objects" / DATASET
SOURCES = ROOT / "backend" / "data" / "sources" / DATASET
GALAXIES = ROOT / "frontend" / "data" / "objects" / "galaxies"
SCRIPT = "backend/scripts/build_objects_smbh.py"
SCRIPT_VERSION = 2

CURATED = "smbh.json"
CURATED_FORMAT = "space-maps.smbh-curated/1"
CATALOGUE = "Space Maps curated supermassive black holes"
VERSION = "1"
SRC_CURATED = "curated"
CREDIT = "Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC"
EDD_TERMS = "https://edd.ifa.hawaii.edu/"
VIZIER_TERMS = "https://cds.unistra.fr/vizier-org/licences_vizier.html"
_TO_PC = {"pc": Decimal(1), "kpc": Decimal(1000), "Mpc": Decimal(1000000)}

D, rnd, sig_round, sha256 = bhb.D, bhb.rnd, bhb.sig_round, bhb.sha256
_num, paper_src, paper_cite = bhb._num, bhb.paper_src, bhb.paper_cite


def _r(x: Decimal) -> float | int:
    """8 significant digits: far finer than any paper's uncertainty, and a rescale factor stays exact to 1e-7."""
    return sig_round(x, 8)


class CuratedError(ValueError):
    pass


def provenance() -> dict:
    return {"source": f"static:{DATASET}", "dataset": DATASET, "catalogue": CATALOGUE, "version": VERSION}


# --- reading the curated file ----------------------------------------------------------------

def check_curated(cur: dict) -> None:
    """Refuse a curated file in which any number lacks its source, or whose rescaling is not fully stated."""
    if cur.get("format") != CURATED_FORMAT:
        raise CuratedError(f"format must be {CURATED_FORMAT!r}")
    papers = cur.get("papers") or {}
    problems = []
    for path, q in bhb._walk(cur.get("black_holes")):
        if q.get("src") not in papers:
            problems.append(f"{path}: src {q.get('src')!r} is missing or not a key of papers")
        if not (isinstance(q.get("where"), str) and q["where"].strip()):
            problems.append(f"{path}: where is missing")
    ids = set()
    for i, bh in enumerate(cur.get("black_holes") or []):
        w = bh.get("id", f"black_holes[{i}]")
        if w in ids:
            problems.append(f"{w}: duplicate id")
        ids.add(w)
        for k in ("id", "name", "designations", "host_galaxy", "mass", "rescale"):
            if k not in bh:
                problems.append(f"{w}: {k} is missing")
        if bh.get("rescale"):
            if not bh.get("assumed_dist"):
                problems.append(f"{w}: rescale needs assumed_dist")
            s = bh.get("scaling") or {}
            if s.get("src") not in papers or not s.get("where"):
                problems.append(f"{w}: scaling needs a known src and a where")
        elif not (isinstance(bh.get("no_rescale_reason"), str) and bh["no_rescale_reason"].strip()):
            problems.append(f"{w}: rescale false needs no_rescale_reason")
    if problems:
        raise CuratedError("curated file refused:\n  " + "\n  ".join(problems))


def interval(q: dict) -> tuple[Decimal | None, Decimal | None]:
    """(lo, hi) of a curated number: given, or v -/+ the statistical and systematic errors in quadrature, or none."""
    v = D(q["v"])
    if "lo" in q:
        return D(q["lo"]), D(q["hi"])
    errs = [D(q[k]) for k in ("err_stat", "err_sys", "err") if k in q]
    if not errs:
        return None, None
    e = sum((x * x for x in errs), Decimal(0)).sqrt()
    return v - e, v + e


def quantity(papers: dict, q: dict, *, unit: str | None = None, tier: str = "measured", factor: Decimal | None = None,
             src_extra: str | None = None, src_text: str | None = None) -> dict:
    """A record Quantity from a curated number; `factor` multiplies the value and both interval ends."""
    v = D(q["v"])
    lo, hi = interval(q)
    if factor is not None:
        v, lo, hi = v * factor, None if lo is None else lo * factor, None if hi is None else hi * factor
    src = src_text or paper_src(papers, q["src"], q["where"])
    if src_extra:
        src = f"{src}; {src_extra}"
    return objects.quantity(_r(v), src, tier, unit or q.get("unit"), None if lo is None else _r(lo),
                            None if hi is None else _r(hi))


# --- the host galaxies -----------------------------------------------------------------------

def load_hosts(galaxies_dir: Path, ids: set[str]) -> tuple[dict[str, dict], dict]:
    """({id: expanded galaxy record}, the galaxies manifest) for the wanted ids, from the built tiles."""
    gdir = Path(galaxies_dir)
    manifest = json.loads((gdir / "manifest.json").read_text(encoding="utf-8"))
    found: dict[str, dict] = {}
    for tile in sorted(manifest["tiles"]):
        doc = json.loads((gdir / "tiles" / f"{tile}.json").read_text(encoding="utf-8"))
        for r in doc["objects"]:
            if r.get("id") in ids:
                found[r["id"]] = objects_static._expand(r, manifest)
    return found, manifest


def host_of(bh: dict, hosts: dict[str, dict]) -> dict:
    h = hosts.get(bh["host_galaxy"])
    if h is None:
        raise CuratedError(f"{bh['id']}: host galaxy {bh['host_galaxy']} is not in the galaxies dataset")
    d = (h.get("position") or {}).get("dist")
    if not (isinstance(d, dict) and isinstance(d.get("v"), (int, float)) and d.get("unit") in _TO_PC):
        raise CuratedError(f"{bh['id']}: host galaxy {bh['host_galaxy']} has no distance")
    return h


def to_unit(x: Decimal, frm: str, to: str) -> Decimal:
    if frm not in _TO_PC or to not in _TO_PC:
        raise CuratedError(f"unknown distance unit {frm!r} or {to!r}")
    return x * _TO_PC[frm] / _TO_PC[to]


# --- records ---------------------------------------------------------------------------------

def schwarzschild(mass_q: dict) -> dict:
    f = lambda x: sig_round(D(x) * bhb.RS_KM_PER_MSUN, 4)  # noqa: E731
    return objects.quantity(f(mass_q["v"]), bhb.SRC_RS, "inferred", "km", f(mass_q["lo"]), f(mass_q["hi"]))


def black_hole_record(papers: dict, bh: dict, host: dict, prov: dict) -> tuple[dict, dict]:
    """(the record, its build-report row)."""
    hp = host["position"]
    hd = hp["dist"]
    derived = host.get("evidence") == "derived" or hd.get("tier") == "inferred"
    host_src = f"the distance of its host galaxy {host['id']} ({hd['src']})"
    dist = objects.quantity(hd["v"], host_src, hd["tier"], hd["unit"], hd.get("lo"), hd.get("hi"))
    position = {"model": "fixed", "ra": hp["ra"], "dec": hp["dec"], "epoch": hp["epoch"], "method": hp["method"],
                "tier": hp["tier"], "dist": dist}
    mq = bh["mass"]
    props: dict = {}
    factor = None
    row = {"id": bh["id"], "host": host["id"], "method": hp["method"], "evidence": host["evidence"],
           "dist_adopted": {"v": hd["v"], "unit": hd["unit"]}, "dist_published": None, "factor": None,
           "mass_published": _num(D(mq["v"])), "rescaled": bool(bh["rescale"])}
    pub_tier = "measured"
    if bh["rescale"]:
        ad = bh["assumed_dist"]
        d_pub = D(ad["v"])
        if ad["unit"] != hd["unit"]:
            d_pub = to_unit(d_pub, ad["unit"], hd["unit"])
        factor = D(hd["v"]) / d_pub
        if not (factor > 0):
            raise CuratedError(f"{bh['id']}: non-positive rescale factor")
        mass_tier = "inferred" if derived else "measured"
        why = (f"rescaled by ×{float(factor):.6g} (host distance {hd['v']} {hd['unit']} / the paper's {ad['v']} "
               f"{ad['unit']}; M ∝ D: {paper_cite(papers, bh['scaling']['src'])}, {bh['scaling']['where']})")
        if derived:
            why += "; the host's distance is derived, so the rescaled mass is inferred"
        props["mass"] = quantity(papers, mq, unit="Msun", tier=mass_tier, factor=factor, src_extra=why)
        props["mass_published"] = quantity(
            papers, mq, unit="Msun", tier=pub_tier,
            src_extra=f"as published, at the paper's assumed distance {ad['v']} {ad['unit']}")
        dtier = "measured" if bh.get("assumed_dist_is_measurement") or "err_stat" in ad or "lo" in ad else "catalogue"
        props["dist_published"] = quantity(
            papers, ad, tier=dtier,
            src_extra=("a distance the paper measured itself; " if bh.get("assumed_dist_is_measurement") else "")
            + "not used: the host galaxy's adopted distance is used, so the black hole sits at its galaxy's centre")
        row.update(factor=float(f"{factor:.8g}"), dist_published={"v": ad["v"], "unit": ad["unit"]})
        notes = []
        if bh.get("assumed_dist_is_measurement"):
            notes.append(f"The galaxy and the black hole share the Cosmicflows-4 maser distance; {paper_cite(papers, ad['src'])} "
                         "give their own distance, listed here but not used.")
        if derived:
            notes.append(f"The host galaxy's distance is derived ({hp['method']}), so this mass is an inference from it, "
                         "not a measurement.")
        if notes:
            props["mass_note"] = objects.quantity(" ".join(notes), SRC_CURATED, "catalogue")
    else:
        mass_tier = "inferred" if derived else "measured"
        props["mass"] = quantity(papers, mq, unit="Msun", tier=mass_tier, src_extra="as published, not rescaled")
        props["mass_note"] = objects.quantity(bh["no_rescale_reason"], paper_cite(papers, mq["src"]), "catalogue")
    row["mass_adopted"] = props["mass"]["v"]
    row["mass_tier"] = props["mass"]["tier"]
    props["type"] = objects.quantity("supermassive", SRC_CURATED, "catalogue")
    if bh.get("state"):
        props["state"] = objects.quantity(bh["state"], SRC_CURATED, "catalogue")
    if bh.get("method_text"):
        props["mass_method"] = objects.quantity(bh["method_text"], paper_cite(papers, mq["src"]), "catalogue")
    if bh.get("ring_diameter"):
        props["ring_diameter"] = quantity(papers, bh["ring_diameter"])
    size = {"radius": schwarzschild(props["mass"]), "angular": None}
    rec = objects.record(id=bh["id"], kind="black_hole", name=bh["name"], designations=bh["designations"],
                         host=None, parent=host["id"], position=position, size=size, props=props, provenance=prov,
                         evidence=host["evidence"], render={"style": "lensing"})
    return rec, row


def build_records(cur: dict, hosts: dict[str, dict]) -> tuple[list[dict], dict]:
    check_curated(cur)
    papers, prov = cur["papers"], provenance()
    records, rows = [], []
    for bh in cur["black_holes"]:
        rec, row = black_hole_record(papers, bh, host_of(bh, hosts), prov)
        records.append(rec)
        rows.append(row)
    report = {
        "records_written": len(records),
        "by_kind_and_evidence": dict(sorted(Counter(f"{r['kind']}/{r['evidence']}" for r in records).items())),
        "curated_numbers": sum(1 for _ in bhb._walk(cur["black_holes"])),
        "black_holes": rows,
    }
    return records, report


def report_table(report: dict) -> str:
    lines = [f"{'black hole':<14} {'host':<14} {'method':<18} {'evidence':<9} {'D adopted':>12} {'D paper':>10} "
             f"{'factor':>9} {'M published':>12} {'M adopted':>12} tier"]
    for r in report["black_holes"]:
        da, dp = r["dist_adopted"], r["dist_published"]
        lines.append(f"{r['id']:<14} {r['host']:<14} {r['method']:<18} {r['evidence']:<9} "
                     f"{da['v']:>8g} {da['unit']:<3} {('%g %s' % (dp['v'], dp['unit'])) if dp else 'n/a':>10} "
                     f"{('%.6f' % r['factor']) if r['factor'] else 'none':>9} {r['mass_published']:>12.4g} "
                     f"{r['mass_adopted']:>12.4g} {r['mass_tier']}")
    return "\n".join(lines)


# --- manifest and writing --------------------------------------------------------------------

LICENSE_MD = """# Licence and credits: smbh-curated data

Applies to every file in this folder (`manifest.json`, `tiles/*.json` and this file).

These eight supermassive black holes are placed at the centres of their host galaxies, so each record **copies its
host galaxy's position and distance** from the `galaxies` dataset. Those values keep the terms of their sources:

- **Positions** are OpenNGC's, licensed under **CC BY-SA 4.0** (https://creativecommons.org/licenses/by-sa/4.0/).
  Credits: Mattia Verga https://github.com/mattiaverga/OpenNGC (release v20260501, commit
  `36cb178a0f69dba8bfc03a99c10512831edf1c6b`). The records here are derived from those positions and are shared under
  the same licence.
- **Distances** are the host galaxies' adopted distances. Where a `src` says "Cosmicflows-4", the value comes from
  Tully et al. 2023, which the Extragalactic Distance Database (https://edd.ifa.hawaii.edu/) distributes under its
  terms: use, analysis and sharing for research and education, provided EDD is cited; the values are converted by
  Space Maps (the `src` says so) and are not EDD data. They are **not** under CC BY-SA 4.0. Cite Tully et al. 2009,
  AJ 138, 323 alongside the paper. M81's distance is UNGC's (Karachentsev et al. 2013, VizieR J/AJ/145/101), which keeps
  VizieR's terms (https://cds.unistra.fr/vizier-org/licences_vizier.html).
- **Masses, the paper distances, the M87* ring diameter and the names** are curated by hand from the published papers
  cited in `manifest.json` (`provenance.papers`) and in each value's `src`, as facts with their citations. The
  rescaled masses are computed by Space Maps from them (the `src` says so).

Nothing here is relicensed: each value keeps the terms of its source. There are no Gaia values in these files.

The code that builds them (`backend/scripts/build_objects_smbh.py`) and the rest of the repository are under the MIT
licence (see the repository `LICENSE`). Only the data files listed above carry the terms named here.
"""


def provenance_full(cur: dict, inp_bytes: bytes, gm: dict, hosts: dict[str, dict]) -> dict:
    papers = "; ".join(
        p["cite"] + (f", arXiv:{p['arxiv']}" if p.get("arxiv") else "") + (f", doi:{p['doi']}" if p.get("doi") else "")
        for p in cur["papers"].values())
    gp = gm["provenance"]
    return {"catalogue": CATALOGUE, "version": VERSION,
            "citation": (f"Curated by hand from: {papers}. Host positions and distances copied from the Space Maps "
                         f"galaxies dataset ({gp.get('version')}): {gp.get('citation')}"),
            "papers": dict(cur["papers"]), "curated_file": CURATED, "curated_sha256": sha256(inp_bytes),
            "curated_date": cur.get("curated"),
            "credit": gp.get("credit") or CREDIT, "licence": gp.get("licence"), "licence_name": gp.get("licence_name"),   # the galaxies' credit: OpenNGC and Cosmicflows-4
            "data_licence_note": ("OpenNGC-derived positions: CC BY-SA 4.0. Cosmicflows-4 distances: EDD terms "
                                  f"({EDD_TERMS}), research and education, cite EDD; values converted by Space Maps, "
                                  f"not relicensed. M81's UNGC distance via VizieR: {VIZIER_TERMS}. Masses and ring "
                                  "diameter: the cited papers. No Gaia values."),
            "edd_terms": EDD_TERMS, "vizier_terms": VIZIER_TERMS,
            "galaxies_dataset": {"dataset": "galaxies", "version": gp.get("version"),
                                 "openngc_commit": gp.get("openngc_commit"), "hosts": sorted(hosts)}}


def build(out_dir: Path, sources: Path = SOURCES, galaxies: Path = GALAXIES) -> dict:
    cur_bytes = (Path(sources) / CURATED).read_bytes()
    cur = json.loads(cur_bytes)
    check_curated(cur)
    hosts, gm = load_hosts(galaxies, {b["host_galaxy"] for b in cur["black_holes"]})
    records, report = build_records(cur, hosts)
    m = objects_static.write_dataset(
        records, out_dir, dataset=DATASET, kinds=["black_hole"], provenance=provenance_full(cur, cur_bytes, gm, hosts),
        build={"script": SCRIPT, "script_version": SCRIPT_VERSION, "report": report},
        band_deg=10, precedence=50, src_table=True, record_defaults={"provenance": provenance()},
        sky_ids={r["id"] for r in records}, compact=True)
    (Path(out_dir) / "LICENSE.md").write_text(LICENSE_MD, encoding="utf-8")
    return m


# --- command line ----------------------------------------------------------------------------

def _files(d: Path) -> dict[str, bytes]:
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


def host_drift(committed: Path, fresh: dict) -> list[str]:
    """One message per host whose adopted distance differs between the committed dataset and a fresh build."""
    try:
        old = {r["id"]: r for r in json.loads((Path(committed) / "manifest.json").read_text())["build"]["report"]["black_holes"]}
    except (OSError, KeyError, ValueError):
        return []
    out = []
    for r in fresh["black_holes"]:
        o = old.get(r["id"])
        if o and o["dist_adopted"] != r["dist_adopted"]:
            out.append(f"host galaxy {r['host']} ({r['id']}): its distance is now {r['dist_adopted']['v']} "
                       f"{r['dist_adopted']['unit']}, the committed dataset used {o['dist_adopted']['v']} "
                       f"{o['dist_adopted']['unit']}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--sources", type=Path, default=SOURCES, help="directory of smbh.json")
    ap.add_argument("--galaxies", type=Path, default=GALAXIES, help="the built galaxies dataset")
    ap.add_argument("--refresh", action="store_true", help="accepted and ignored: the source is curated, nothing to download")
    ap.add_argument("--check", action="store_true",
                    help="rebuild into a temp dir, compare with --out and verify it; exit 1 on any difference")
    a = ap.parse_args()
    if a.refresh:
        print("--refresh: nothing to download (smbh.json is curated by hand); building from the committed inputs")
    if a.check:
        with tempfile.TemporaryDirectory() as tmp:
            m = build(Path(tmp), a.sources, a.galaxies)
            fresh, have = _files(Path(tmp)), (_files(a.out) if a.out.is_dir() else {})
        diff = sorted(k for k in fresh.keys() | have.keys() if fresh.get(k) != have.get(k))
        problems = objects_static.verify_dataset(a.out) if a.out.is_dir() else ["output directory missing"]
        for msg in host_drift(a.out, m["build"]["report"]):
            print(msg, file=sys.stderr)
        if diff:
            print(f"{a.out} differs from a fresh build: {', '.join(diff[:10])}{' ...' if len(diff) > 10 else ''}",
                  file=sys.stderr)
        for p in problems[:20]:
            print(f"verify: {p}", file=sys.stderr)
        if diff or problems:
            return 1
        print(f"{a.out} is up to date ({len(fresh)} files, verified)")
        return 0
    m = build(a.out, a.sources, a.galaxies)
    r = m["build"]["report"]
    print(f"wrote {m['count']} records ({r['by_kind_and_evidence']}) to {a.out}")
    print(report_table(r))
    return 0


if __name__ == "__main__":
    sys.exit(main())
