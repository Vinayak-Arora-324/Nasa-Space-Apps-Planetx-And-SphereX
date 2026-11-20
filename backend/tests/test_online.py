"""Live smoke tests of the upstreams the builds pin (object framework 19.3.2). Skipped unless `--online`.

Each failure message names the host and the pin it checked, and what a failure means upstream."""
import hashlib
import importlib.util
import sys
from pathlib import Path
from urllib.parse import quote

import httpx
import pytest

from spherex_app import catalogs, config, movers

pytestmark = pytest.mark.online

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
TIMEOUT = httpx.Timeout(60.0, connect=20.0)
VIZIER_ORDER = ("vizier.cfa.harvard.edu", "vizier.idia.ac.za", "vizier.cds.unistra.fr")


def _script(name: str):
    path = SCRIPTS / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _get(url: str, params: dict | None = None) -> httpx.Response:
    r = httpx.get(url, params=params, timeout=TIMEOUT, follow_redirects=True)
    r.raise_for_status()
    return r


def _vizier_pins() -> list[tuple]:
    """(script, role, table, rows, column) for every VizieR table a build pins, read from the scripts."""
    neb, gal, hr = (_script(n) for n in ("build_objects_nebulae", "build_objects_galaxies", "build_objects_hr23"))
    pins = []
    for mod, roles in ((neb, neb.VIZIER_ROLES), (gal, gal.VIZIER_ROLES)):
        for role in roles:
            spec = mod.INPUTS[role]
            cols = spec.get("columns")
            pins.append((mod.SCRIPT, role, spec["table"], spec["rows"], cols[0] if cols else None))
    pins.append((hr.SCRIPT, "hr23-clusters", hr.TABLE, hr.EXPECTED_ROWS, "Name"))
    return pins


def _row_count(host: str, table: str, column: str | None) -> int:
    """Data rows of an ASU-TSV answer: one column when the pin names one (the 55k-row tables), else all of it."""
    out = f"-out={quote(column)}" if column else "-out.all"
    r = _get(f"https://{host}/viz-bin/asu-tsv?-source={quote(table, safe='')}&{out}&-out.max=unlimited")
    lines = [ln for ln in r.text.splitlines() if ln.strip() and not ln.startswith("#")]
    # header, [units,] dashes: a one-column answer has no units line when the column has no unit
    dash = next((i for i in (1, 2) if i < len(lines) and set(lines[i].replace("\t", "").strip()) == {"-"}), None)
    assert dash is not None, f"no dashes line after the header: {lines[:3]!r}"
    return len(lines) - dash - 1


@pytest.mark.parametrize("script,role,table,rows,column", _vizier_pins(), ids=lambda v: v if isinstance(v, str) else "")
def test_vizier_table_row_count(script, role, table, rows, column):
    seen = []
    for host in VIZIER_ORDER:
        try:
            n = _row_count(host, table, column)
        except (httpx.HTTPError, AssertionError) as e:
            seen.append(f"{host}: {type(e).__name__} {e}")
            continue
        if n == rows:
            return
        seen.append(f"{host}: {n} rows")
    pytest.fail(f"VizieR table {table} (role {role}, pinned by {script}) should have {rows} rows on at least one of "
                f"{', '.join(VIZIER_ORDER)}; got " + "; ".join(seen) + ". Upstream changed or withdrew the table: "
                "re-check it and refresh the pin (`--refresh`), or every mirror is down.")


def test_sesame_resolves_m31():
    seen = []
    for base in config.SESAME_URLS:
        try:
            out = catalogs.parse_sesame(_get(f"{base}?{quote('M31')}").text, "M31")
        except Exception as e:  # any failure on one host moves on to the next, as the app does
            seen.append(f"{base}: {type(e).__name__} {e}")
            continue
        assert abs(out["ra"] - 10.6847) < 0.1 and abs(out["dec"] - 41.2690) < 0.1, \
            f"Sesame at {base} put M31 at ({out['ra']}, {out['dec']}), not near (10.6847, 41.2690)"
        return
    pytest.fail("no Sesame host in config.SESAME_URLS resolved 'M31': " + "; ".join(seen) +
                ". The service or the -oxp/S response format changed, or all three hosts are down.")


def test_skybot_small_cone_answers():
    jd = 2460000.5  # fixed epoch, 2023-02-25
    params = {"-ra": "10.68470", "-dec": "41.26900", "-rd": "0.1000", "-ep": f"{jd:.4f}",
              "-mime": "json", "-output": "all", "-observer": "500"}
    try:
        text = _get(movers.SKYBOT_URL, params).text
        objs = movers.parse_skybot(text)  # raises on a non-JSON body or a negative flag
    except (httpx.HTTPError, ValueError) as e:
        pytest.fail(f"SkyBoT at {movers.SKYBOT_URL} (cone r=0.1 deg, JD {jd}) did not answer validly: {e}. The "
                    "service is down, or its conesearch parameters or JSON format changed (see movers.parse_skybot).")
    assert isinstance(objs, list), f"SkyBoT at {movers.SKYBOT_URL}: expected a list of objects, got {type(objs)}"


@pytest.mark.parametrize("role", ["openngc", "openngc-addendum"])
def test_openngc_pinned_files_hash(role):
    neb = _script("build_objects_nebulae")
    spec = neb.INPUTS[role]
    url = neb.OPENNGC_RAW + spec["remote"]
    got = hashlib.sha256(_get(url).content).hexdigest()
    assert got == spec["sha256"], (
        f"raw.githubusercontent.com {url} (OpenNGC commit {neb.OPENNGC_SHA}) hashes to {got}, pinned "
        f"{spec['sha256']}: the commit-pinned file should be immutable, so the repository was rewritten or the "
        "host is serving altered bytes.")
