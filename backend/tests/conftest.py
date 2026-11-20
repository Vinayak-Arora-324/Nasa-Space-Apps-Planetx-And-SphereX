"""pytest options: the `online` marker is skipped unless `--online` or SPHEREX_ONLINE=1 (object framework 19.3.2)."""
import os

import pytest

SKIP_REASON = "needs the network: run with --online"


def pytest_addoption(parser):
    parser.addoption("--online", action="store_true", default=False,
                     help="run the tests marked `online` (live network smoke tests of the pinned upstreams)")


def pytest_collection_modifyitems(config, items):
    if config.getoption("--online") or os.environ.get("SPHEREX_ONLINE") == "1":
        return
    skip = pytest.mark.skip(reason=SKIP_REASON)
    for item in items:
        if "online" in item.keywords:
            item.add_marker(skip)
