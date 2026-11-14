"""Synthetic, offline tests for spherex_app.sources."""

from __future__ import annotations

import math
import time

import numpy as np

from spherex_app.sources import Prior, fit_frame, match_catalog

FWHM = 2.2
SIG = FWHM / (2 * math.sqrt(2 * math.log(2)))


def render(n, stars, sig=SIG):
    """stars: iterable of (x, y, amp[, sigma]); point-sampled Gaussians."""
    img = np.zeros((n, n))
    yy, xx = np.mgrid[:n, :n]
    for st in stars:
        x, y, a = st[:3]
        s = st[3] if len(st) > 3 else sig
        h = int(6 * s) + 2
        x0, y0 = int(round(x)), int(round(y))
        sl = (slice(max(y0 - h, 0), y0 + h + 1), slice(max(x0 - h, 0), x0 + h + 1))
        img[sl] += a * np.exp(-0.5 * ((xx[sl] - x) ** 2 + (yy[sl] - y) ** 2) / s ** 2)
    return img


def field(n, nstars, noise=1.0, seed=0, amp=(0.8, 2.5), margin=6):
    rng = np.random.default_rng(seed)
    stars = [(rng.uniform(margin, n - margin), rng.uniform(margin, n - margin),
              10 ** rng.uniform(*amp) * noise) for _ in range(nstars)]
    return render(n, stars) + rng.normal(0, noise, (n, n)), np.array(stars)


def nearest(model, x, y):
    s = model.sources
    if not s:
        return None, np.inf
    d = [math.hypot(a["x"] - x, a["y"] - y) for a in s]
    i = int(np.argmin(d))
    return s[i], d[i]


def test_recovers_positions_and_fluxes():
    img, tr = field(300, 150, seed=1)
    m = fit_frame(img, None, FWHM)
    assert 0.9 < m.noise < 1.1
    errs, ratios = [], []
    for x, y, a in tr[tr[:, 2] > 50]:
        s, d = nearest(m, x, y)
        assert d < 0.3, (x, y, a, d)
        errs.append(d)
        ratios.append(s["flux"] / (a * 2 * math.pi * SIG ** 2))
        assert s["kind"] == "point" and s["snr"] > 30
        assert s["sx"] > 0 and s["flux_err"] > 0 and s["cat"] is None
    assert max(errs) < 0.1 and np.sqrt(np.mean(np.square(errs))) < 0.05
    assert abs(np.median(ratios) - 1) < 0.01 and np.max(np.abs(np.array(ratios) - 1)) < 0.06
    # few spurious detections
    far = [s for s in m.sources if min(math.hypot(s["x"] - x, s["y"] - y) for x, y, _ in tr) > 1.5]
    assert len(far) <= 2
    # reported sigma is honest: normalised residuals of bright stars
    iso = [(x, y) for x, y, a in tr[tr[:, 2] > 50]
           if np.sort(np.hypot(tr[:, 0] - x, tr[:, 1] - y))[1] > 3 * FWHM]
    z = [(nearest(m, x, y)[0]["x"] - x) / nearest(m, x, y)[0]["sx"] for x, y in iso]
    z += [(nearest(m, x, y)[0]["y"] - y) / nearest(m, x, y)[0]["sy"] for x, y in iso]
    assert len(iso) > 20 and 0.6 < np.std(z) < 1.5


def test_leftover_noise_like():
    img, _ = field(300, 120, seed=2)
    m = fit_frame(img, None, FWHM)
    assert abs(m.quality - 1) < 0.2
    assert m.background.dtype == np.float32 and m.leftover.dtype == np.float32
    assert m.background.shape == m.leftover.shape == img.shape
    assert abs(np.nanstd(m.leftover) / m.noise - 1) < 0.2


def test_deblend_with_priors():
    n = 80
    a = 60.0
    xy = [(40.0, 40.0), (40.0 + FWHM, 40.3)]
    rng = np.random.default_rng(3)
    img = render(n, [(x, y, a) for x, y in xy]) + rng.normal(0, 1.0, (n, n))
    pri = [Prior(x + 0.2, y - 0.15, {"catalog": "gaia", "id": f"G{i}", "mag": 15.0})
           for i, (x, y) in enumerate(xy)]
    m = fit_frame(img, None, FWHM, pri)
    assert len(m.sources) == 2
    for (x, y), src in zip(xy, sorted(m.sources, key=lambda s: s["x"])):
        assert math.hypot(src["x"] - x, src["y"] - y) < 0.5 + 1e-6
        assert abs(src["amp"] / a - 1) < 0.1
        assert src["blend"] is not None and src["cat"]["catalog"] == "gaia"
    assert m.sources[0]["blend"] == m.sources[1]["blend"]
    assert {s["cat"]["id"] for s in m.sources} == {"G0", "G1"}
    assert abs(m.quality - 1) < 0.25


def test_priors_insignificant_dropped_and_free_detection_has_no_cat():
    n = 100
    rng = np.random.default_rng(4)
    img = render(n, [(30, 30, 80), (70, 60, 40)]) + rng.normal(0, 1.0, (n, n))
    pri = [Prior(30.1, 30.0, {"id": "real"}), Prior(20.0, 80.0, {"id": "ghost"})]
    m = fit_frame(img, None, FWHM, pri)
    cats = {(round(s["x"]), round(s["y"])): s["cat"] for s in m.sources}
    assert len(m.sources) == 2
    assert cats[(30, 30)]["id"] == "real" and cats[(70, 60)] is None


def test_diffuse_light_goes_to_background():
    n = 300
    rng = np.random.default_rng(5)
    yy, xx = np.mgrid[:n, :n]
    diffuse = 0.03 * xx + 0.02 * yy + 12 * np.exp(-0.5 * ((xx - 150) ** 2 + (yy - 120) ** 2) / 25 ** 2)
    img = diffuse + rng.normal(0, 1.0, (n, n))
    stars = [(60.0, 230.0, 80.0), (240.0, 60.0, 50.0)]
    img = img + render(n, stars)
    m = fit_frame(img, None, FWHM)
    assert len(m.sources) <= 4
    for x, y, _ in stars:
        assert nearest(m, x, y)[1] < 0.3
    # background tracks the diffuse light
    err = (m.background - diffuse)[30:-30, 30:-30]
    assert abs(np.median(err)) < 0.3 and np.std(err) < 0.6
    assert abs(m.quality - 1) < 0.2


def test_extended_source_classified():
    n = 120
    rng = np.random.default_rng(6)
    ext_sig = 3.2 * SIG
    img = render(n, [(60.0, 60.0, 25.0, ext_sig), (25.0, 25.0, 60.0), (95.0, 90.0, 60.0)])
    img = img + rng.normal(0, 1.0, (n, n))
    m = fit_frame(img, None, FWHM)
    e, d = nearest(m, 60, 60)
    assert d < 0.3 and e["kind"] == "extended"
    assert abs(e["fwhm"] / (ext_sig * 2.3548) - 1) < 0.1
    assert abs(e["flux"] / (25.0 * 2 * math.pi * ext_sig ** 2) - 1) < 0.1
    assert len(m.sources) == 3
    assert nearest(m, 25, 25)[0]["kind"] == "point" and nearest(m, 95, 90)[0]["kind"] == "point"
    assert abs(m.quality - 1) < 0.2


def test_saturated_core_masked():
    n = 100
    rng = np.random.default_rng(7)
    amp = 3000.0
    img = render(n, [(50.3, 49.8, amp), (20.0, 20.0, 60.0)]) + rng.normal(0, 1.0, (n, n))
    bad = np.zeros((n, n), bool)
    bad[48:52, 48:52] = True
    img[bad] = 5000.0  # garbage in saturated pixels
    m = fit_frame(img, bad, FWHM)
    s, d = nearest(m, 50.3, 49.8)
    assert d < 0.3 and s["saturated"]
    assert abs(s["flux"] / (amp * 2 * math.pi * SIG ** 2) - 1) < 0.15
    assert not nearest(m, 20, 20)[0]["saturated"]
    assert len(m.sources) <= 3


def test_nan_regions_and_edges():
    img, tr = field(200, 60, seed=8)
    img[:, :30] = np.nan
    img[100:110, 100:140] = np.nan
    m = fit_frame(img, None, FWHM)
    assert np.isnan(m.background[:, :30]).all() and np.isnan(m.leftover[:, :30]).all()
    assert np.isfinite(m.background[:, 30:]).sum() > 0 and np.isfinite(m.leftover[0, 40])
    ok = (tr[:, 0] > 40) & ~((tr[:, 0] > 95) & (tr[:, 0] < 145) & (tr[:, 1] > 95) & (tr[:, 1] < 115)) & (tr[:, 2] > 40)
    for x, y, a in tr[ok]:
        assert nearest(m, x, y)[1] < 0.3
    assert all(np.isfinite([s["x"], s["y"], s["flux"], s["snr"]]).all() for s in m.sources)


def test_empty_and_flat_images():
    m = fit_frame(np.random.default_rng(9).normal(0, 1, (64, 64)), None, FWHM)
    assert len(m.sources) <= 1 and abs(m.quality - 1) < 0.2
    m = fit_frame(np.full((50, 50), np.nan), None, FWHM)
    assert m.sources == [] and np.isnan(m.leftover).all()


def test_max_sources_keeps_brightest():
    img, tr = field(200, 80, seed=10, amp=(1.5, 2.5))
    m = fit_frame(img, None, FWHM, max_sources=10)
    assert len(m.sources) == 10
    top = np.sort(tr[:, 2])[-10:]
    assert min(s["amp"] for s in m.sources) > 0.5 * top[0]


def test_deterministic():
    img, _ = field(150, 40, seed=11)
    a, b = fit_frame(img, None, FWHM), fit_frame(img, None, FWHM)
    assert a.sources == b.sources and np.array_equal(a.leftover, b.leftover, equal_nan=True)


def test_match_catalog_one_to_one():
    srcs = [{"x": 10.0, "y": 10.0, "cat": None}, {"x": 10.4, "y": 10.0, "cat": None},
            {"x": 50.0, "y": 50.0, "cat": None}]
    pri = [Prior(10.3, 10.0, {"id": "A"}), Prior(90.0, 90.0, {"id": "far"})]
    match_catalog(srcs, pri, 1.0)
    assert srcs[1]["cat"]["id"] == "A" and abs(srcs[1]["cat"]["sep_px"] - 0.1) < 1e-9
    assert srcs[0]["cat"] is None and srcs[2]["cat"] is None  # prior A used once; "far" too far
    match_catalog([], pri, 1.0)
    match_catalog(srcs, [], 1.0)


def test_performance_large_and_small():
    img, tr = field(300, 150, seed=12)
    t0 = time.perf_counter()
    m = fit_frame(img, None, FWHM)
    t_small = time.perf_counter() - t0
    img, tr = field(1001, 1500, seed=13)
    t0 = time.perf_counter()
    m = fit_frame(img, None, FWHM)
    t_big = time.perf_counter() - t0
    print(f"\n300^2/150 stars: {t_small:.2f}s; 1001^2/1500 stars: {t_big:.2f}s; n={len(m.sources)}")
    assert len(m.sources) > 1350
    assert t_small < 1.0 and t_big < 6.0
    assert abs(m.quality - 1) < 0.2


def test_halo_of_bright_star_not_reported_as_sources():
    n = 80
    rng = np.random.default_rng(11)
    img = render(n, [(40.0, 40.0, 3000.0)]) + rng.normal(0, 1.0, (n, n))
    yy, xx = np.mgrid[:n, :n]
    r = np.hypot(xx - 40.0, yy - 40.0)
    img += 6.0 * np.exp(-0.5 * ((r - 5.0) / 1.5) ** 2) * (1 + 0.3 * np.cos(3 * np.arctan2(yy - 40, xx - 40)))
    m = fit_frame(img, None, FWHM)
    assert sum(1 for s in m.sources if 2.5 < math.hypot(s["x"] - 40, s["y"] - 40) < 14) == 0


def test_spike_not_reported_as_source():
    n = 80
    rng = np.random.default_rng(12)
    img = rng.normal(0, 1.0, (n, n))
    img[30, 30] += 500.0
    img[30, 31] += 300.0
    m = fit_frame(img, None, FWHM)
    assert all(math.hypot(s["x"] - 30.5, s["y"] - 30) > 3 for s in m.sources)


def test_isolated_flagged_pixel_is_not_saturation():
    img, tr = field(100, 10, seed=3, amp=(1.2, 1.6))
    bad = np.zeros(img.shape, bool)
    x, y, _ = tr[0]
    bad[int(round(y)), int(round(x))] = True
    m = fit_frame(img, bad, FWHM)
    s, d = nearest(m, x, y)
    assert d < 0.5 and not s["saturated"]



def test_saturated_broad_winged_star_is_one_point_source():
    # A saturated star refit from its wings looks broader than the PSF. That must not turn it
    # into an "extended" source (regression: R Dra had hundreds), and the extra components the
    # fit puts inside the masked core must not be reported as a blend of several objects.
    n = 100
    rng = np.random.default_rng(11)
    img = render(n, [(50.2, 50.1, 3000.0, SIG * 1.6), (20.0, 20.0, 60.0)]) + rng.normal(0, 1.0, (n, n))
    bad = np.zeros((n, n), bool)
    bad[48:53, 48:53] = True
    img[bad] = 1e5
    m = fit_frame(img, bad, FWHM)
    near = [q for q in m.sources if math.hypot(q["x"] - 50.2, q["y"] - 50.1) < FWHM]
    assert len(near) == 1
    s = near[0]
    assert s["saturated"] and s["kind"] == "point" and s["fwhm"] == FWHM and s["blend"] is None
    assert [q["id"] for q in m.sources] == list(range(len(m.sources)))
    assert not nearest(m, 20, 20)[0]["saturated"]
