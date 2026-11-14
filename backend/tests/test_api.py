"""Offline API tests (no network): health, validation, static frontend handling."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from spherex_app import config
from spherex_app.main import app

client = TestClient(app)


def test_health_and_cors():
    r = client.get("/api/health", headers={"Origin": "https://example.org"})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert r.headers.get("access-control-allow-origin") == "*"


def test_resolve_coordinates_offline():
    r = client.get("/api/resolve", params={"q": "08:55:10.831 -07:14:42.53"})
    j = r.json()
    assert r.status_code == 200 and j["source"] == "coordinates"
    assert abs(j["ra"] - 133.795129) < 1e-5 and j["epoch"] is None


@pytest.mark.parametrize("path,params", [
    ("/api/stream", {"ra": 1, "dec": 1, "fov": 2}),
    ("/api/stream", {"ra": 1, "dec": 1, "detectors": "7"}),
    ("/api/stream", {"ra": 1, "dec": 1, "max_frames": 100000}),
    ("/api/stream", {"ra": 400, "dec": 1}),
    ("/api/spectrum", {"ra": 1, "dec": 1, "aper": 50}),
    ("/api/spectrum", {"ra": 1, "dec": 1, "pos_ra": 1}),
    ("/api/catalog", {"cat": "nope", "ra": 1, "dec": 1}),
    ("/api/frames", {"ra": 1, "dec": 95}),
])
def test_validation_errors_are_json_400(path, params):
    r = client.get(path, params=params)
    assert r.status_code == 400 and "detail" in r.json()


def test_unknown_api_path_is_json_404():
    r = client.get("/api/nope")
    assert r.status_code == 404 and "detail" in r.json()


def test_static_frontend_missing_is_tolerated(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "FRONTEND_DIR", tmp_path / "does-not-exist")
    assert client.get("/").status_code == 404
    assert client.get("/api/health").status_code == 200


def test_static_frontend_served(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("<!doctype html><title>x</title>")
    (tmp_path / "a.js").write_text("1")
    monkeypatch.setattr(config, "FRONTEND_DIR", tmp_path)
    r = client.get("/")
    assert r.status_code == 200 and "text/html" in r.headers["content-type"]
    assert client.get("/a.js").status_code == 200
    assert client.get("/../pyproject.toml").status_code == 404
