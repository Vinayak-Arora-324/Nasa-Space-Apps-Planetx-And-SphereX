"""warm_coverage: field parsing, grid layout, and the warm/skip/force/failure flow (offline)."""

from __future__ import annotations

import asyncio
import importlib.util
import math
import re
import types
from pathlib import Path

import pytest

from spherex_app import archive, cache, config
from spherex_app import main as app_main

spec = importlib.util.spec_from_file_location(
    "warm_coverage", Path(__file__).parents[1] / "scripts" / "warm_coverage.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


# --- parse_field -----------------------------------------------------------------

@pytest.mark.parametrize("s", ["1.5 -2.25", "1.5,-2.25", "  1.5 ,  -2.25 "])
def test_parse_field_accepts_space_or_comma(s):
    assert mod.parse_field(s) == (1.5, -2.25)


def test_parse_field_rounds_to_7_decimals():
    assert mod.parse_field("1.123456789 2.0") == (1.1234568, 2.0)


@pytest.mark.parametrize("s", ["garbage", "1.5", "1.5 2.5 extra words", "1.5 -91",
                               "abc 1", "nan 0", "1 inf"])
def test_parse_field_rejects_garbage_and_out_of_range(s):
    with pytest.raises(ValueError):
        mod.parse_field(s)


# --- read_fields_file ------------------------------------------------------------

def test_read_fields_file_skips_blanks_and_comments_and_takes_labels(tmp_path):
    f = tmp_path / "fields.txt"
    f.write_text(
        "# header comment\n"
        "\n"
        "133.795129 -7.245147 WISE J085510\n"
        "   # indented comment\n"
        "10.0,20.0  Some label here\n"
        "30 -5\n"
    )
    assert mod.read_fields_file(f) == [
        (133.795129, -7.245147, "WISE J085510"),
        (10.0, 20.0, "Some label here"),
        (30.0, -5.0, ""),
    ]


def test_read_fields_file_reports_line_number(tmp_path):
    f = tmp_path / "fields.txt"
    f.write_text("10 20\nnot a field\n")
    with pytest.raises(ValueError, match=r"fields\.txt:2"):
        mod.read_fields_file(f)


# --- grid_fields -----------------------------------------------------------------

def test_grid_count_and_spacing_on_equator():
    pts = mod.grid_fields(10, 11, 0, 1, 0.5)
    assert len(pts) == 9
    assert sorted({ra for ra, _ in pts}) == [10.0, 10.5, 11.0]
    assert sorted({dec for _, dec in pts}) == [0.0, 0.5, 1.0]


def test_grid_ra_spacing_widens_with_dec():
    row = [ra for ra, dec in mod.grid_fields(10, 12, 60, 60, 0.5)]
    assert len(row) == 3
    steps = [b - a for a, b in zip(row, row[1:])]
    expected = 0.5 / math.cos(math.radians(60))  # 1.0
    assert all(abs(s - expected) < 1e-6 for s in steps)


def test_grid_wraps_through_zero():
    pts = mod.grid_fields(359, 1, 0, 0, 0.5)
    ras = [ra for ra, _ in pts]
    assert all(0.0 <= ra < 360.0 for ra in ras)
    assert sorted(ras) == [0.0, 0.5, 1.0, 359.0, 359.5]


def test_grid_rejects_bad_arguments():
    with pytest.raises(ValueError):
        mod.grid_fields(10, 11, 0, 1, 0)
    with pytest.raises(ValueError):
        mod.grid_fields(10, 11, 1, 0, 0.5)


# --- main, with a fake TAP -------------------------------------------------------

@pytest.fixture
def fake_tap(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(archive, "_frames_cache", cache.TTLCache(config.TAP_TTL_S))
    state = types.SimpleNamespace(calls=[], fail_at=set())
    uri = ("ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/6/"
           "level2_2025W19_1B_0116_1D6_spx_l2b-v27-2026-197.fits")

    async def fake(url, adql, *, irsa, what, **kw):
        m = re.search(r"POINT\('ICRS', ([-\d.]+), ([-\d.]+)\)", adql)
        ra, dec = float(m.group(1)), float(m.group(2))
        state.calls.append((ra, dec))
        if ra in state.fail_at:
            raise archive.UpstreamError("HTTP 503 (test)")
        n = 2 if ra == 30.0 else 1  # field 30/-5 gets two frames, 10/20 one
        return [{"uri": uri, "energy_bandpassname": f"SPHEREx-D{d}",
                 "time_bounds_lower": "60800.7", "time_bounds_upper": "60800.8",
                 "time_exposure": "113", "provenance_version": "7"}
                for d in range(6, 6 - n, -1)]

    monkeypatch.setattr(archive, "tap_csv", fake)
    return state


def run_main(argv):
    return asyncio.run(mod.main(argv))


def coverage():
    return asyncio.run(app_main.coverage())["fields"]


def test_end_to_end_indexes_both_fields(fake_tap, capsys):
    assert run_main(["10.0 20.0", "30.0 -5.0"]) == 0
    assert sorted(fake_tap.calls) == [(10.0, 20.0), (30.0, -5.0)]
    assert coverage() == [{"ra": 10.0, "dec": 20.0, "n_frames": 1},
                          {"ra": 30.0, "dec": -5.0, "n_frames": 2}]
    assert "queried 2, fresh 0, failed 0" in capsys.readouterr().out


def test_rerun_skips_fresh_and_force_requeries(fake_tap, capsys):
    run_main(["10.0 20.0", "30.0 -5.0"])
    assert len(fake_tap.calls) == 2
    capsys.readouterr()

    assert run_main(["10.0 20.0", "30.0 -5.0"]) == 0
    assert len(fake_tap.calls) == 2  # no new TAP queries
    assert "queried 0, fresh 2, failed 0" in capsys.readouterr().out

    assert run_main(["--force", "10.0 20.0", "30.0 -5.0"]) == 0
    assert len(fake_tap.calls) == 4


def test_stale_list_is_requeried_without_force(fake_tap, monkeypatch):
    run_main(["10.0 20.0"])
    monkeypatch.setattr(config, "FRAMES_DISK_TTL_S", 0)  # every list now counts as stale
    assert run_main(["10.0 20.0"]) == 0
    assert len(fake_tap.calls) == 2


def test_failure_continues_and_exits_1(fake_tap, capsys):
    fake_tap.fail_at.add(10.0)
    assert run_main(["10.0 20.0", "30.0 -5.0"]) == 1
    assert len(fake_tap.calls) == 2  # the failure did not stop the second field
    assert coverage() == [{"ra": 30.0, "dec": -5.0, "n_frames": 2}]
    out = capsys.readouterr().out
    assert "FAILED" in out and "queried 1, fresh 0, failed 1" in out


def test_dry_run_queries_nothing(fake_tap, capsys):
    assert run_main(["--dry-run", "--grid", "10", "11", "0", "1", "0.5"]) == 0
    assert fake_tap.calls == []
    assert capsys.readouterr().out.count("would query") == 9


def test_bad_field_is_a_usage_error(fake_tap):
    assert run_main(["1.5 -91"]) == 2
    assert fake_tap.calls == []
