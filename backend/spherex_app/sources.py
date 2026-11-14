"""Source fitting for one resampled frame (pure numpy/scipy, no I/O, deterministic).

Turns an image into: a smooth diffuse-background map, a list of fitted circular-Gaussian
sources at sub-pixel positions (point or extended), and the leftover
``img - background - sum(models)``.

Algorithm
---------
1. Background: sigma-clipped medians on a mesh (8-16 px boxes), cubic-spline interpolated back
   to full resolution.  It is recomputed from ``img - models`` after sources are fitted, so
   sources never bias it and diffuse structure never turns into point sources.
2. Priors (catalogue positions at the frame epoch) are seeded first and fitted with positions
   allowed to move <= 0.5 px; insignificant ones are dropped.
3. Up to three detect/fit passes: Gaussian matched filter on the residual (NaN/bad aware),
   non-maximum suppression, then joint Levenberg-Marquardt fits (batched over groups of
   neighbours closer than ~2 FWHM; amplitudes + sub-pixel positions, optional width).
   Bright free sources get a width-free refit; FWHM > 1.5 x PSF means ``kind="extended"``.
4. Errors come from the fit covariance scaled by the robust noise.

Notes for integrators
---------------------
* ``cat`` of prior-seeded sources is a copy of ``Prior.cat`` plus ``sep_px`` (fitted - prior
  position, grid px); the caller may convert to ``sep_arcsec`` using the grid scale.
* ``leftover`` is NaN only where ``img`` is non-finite; ``bad`` pixels keep their (unfitted)
  residual so saturated cores are visible.  ``background`` is NaN where ``img`` is NaN.
* The PSF is a circular Gaussian; real (non-Gaussian, undersampled) PSFs leave residuals around
  very bright stars, so candidates much fainter than a close bright neighbour (<10 % of its
  peak, within 2 FWHM) are not reported unless a prior exists for them.
* Errors assume uncorrelated noise (resampling correlations make sx/sy/flux_err optimistic).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage as ndi
from scipy.interpolate import RectBivariateSpline
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

MODEL_VERSION = 1
FWHM_PER_SIGMA = 2.0 * math.sqrt(2.0 * math.log(2.0))
STAMP_FWHM = 2.2          # fit/render stamp half-size in FWHM
LINK_FWHM = 1.5           # neighbours closer than this are fitted jointly
EXT_RATIO = 1.5           # fitted FWHM / PSF above which a source is "extended"
WIDTH_FIT_SNR = 10.0      # free sources at least this significant get a width-free refit
PRIOR_MIN_SNR = 3.0
HALO_FRAC = 0.35          # free detections fainter than this x the local model level are PSF residue
SAT_MIN_SNR = 300.0       # a masked core only means 'saturated' for sources at least this significant
SPIKE_REL = 0.6           # free sources whose 1.5-px residual exceeds this x their own flux are spikes
LM_ITERS = 16             # Levenberg-Marquardt iterations per group fit
LM_TOL = 0.004            # stop when no position moves by more than this (px)
HALO_MIN_SNR = 500.0      # sources brighter than this (in noise sigmas) get a halo exclusion zone
QUALITY_CLIP = 5.0        # quality = RMS of the leftover with |r| clipped at this many sigma
KMAX = 16                 # max sources per joint fit
CHUNK_ELEMS = 1_200_000


@dataclass
class Prior:
    x: float
    y: float
    cat: dict = field(default_factory=dict)


@dataclass
class FrameModel:
    sources: list
    background: np.ndarray
    leftover: np.ndarray
    psf_fwhm_px: float
    noise: float
    quality: float


# ----------------------------------------------------------------------------------------
# Background and noise
# ----------------------------------------------------------------------------------------

def _mad_sigma(v: np.ndarray) -> float:
    v = v[np.isfinite(v)]
    if v.size == 0:
        return 0.0
    if v.size > 400_000:
        v = v[:: int(v.size // 300_000) + 1]
    m = np.median(v)
    return float(1.4826 * np.median(np.abs(v - m)))


def _diff_noise(img: np.ndarray, valid: np.ndarray) -> float:
    ok = valid[:, 1:] & valid[:, :-1]
    d = (img[:, 1:] - img[:, :-1])[ok]
    return _mad_sigma(d) / math.sqrt(2.0) if d.size else 0.0


def _mesh_median(a: np.ndarray, min_n: int):
    s = np.sort(a, axis=-1)  # NaN sorts last
    n = np.count_nonzero(~np.isnan(s), axis=-1)
    i0 = np.maximum((n - 1) // 2, 0)[..., None]
    i1 = np.maximum(n // 2, 0)[..., None]
    m = 0.5 * (np.take_along_axis(s, i0, -1) + np.take_along_axis(s, i1, -1))[..., 0]
    ok = n >= min_n
    return np.where(ok, m, np.nan), ok


def _background(data: np.ndarray, valid: np.ndarray, box: int, sigma: float) -> np.ndarray:
    """Smooth sigma-clipped-median background; defined (extrapolated) everywhere."""
    ny, nx = data.shape
    gy, gx = -(-ny // box), -(-nx // box)
    a = np.full((gy * box, gx * box), np.nan, np.float32)
    a[:ny, :nx] = np.where(valid, data, np.nan)
    a = a.reshape(gy, box, gx, box).transpose(0, 2, 1, 3).reshape(gy, gx, box * box)
    min_n = max(8, int(0.2 * box * box))
    m, ok = _mesh_median(a, min_n)
    if not ok.any():
        return np.zeros((ny, nx), np.float64)
    sg = max(sigma, 1e-30)
    for _ in range(2):
        mm = m[..., None]
        a = np.where((a > mm + 3 * sg) | (a < mm - 3 * sg), np.nan, a)
        m, ok2 = _mesh_median(a, min_n)
        ok &= ok2
        m = np.where(ok, m, np.nan)
    if not ok.all():  # fill empty cells from the nearest good one
        idx = ndi.distance_transform_edt(~ok, return_distances=False, return_indices=True)
        m = m[tuple(idx)]
    if gy < 2 or gx < 2:
        return np.full((ny, nx), float(np.mean(m)), np.float64)
    cy = (np.arange(gy) + 0.5) * box - 0.5
    cx = (np.arange(gx) + 0.5) * box - 0.5
    spl = RectBivariateSpline(cy, cx, m.astype(np.float64), kx=min(3, gy - 1), ky=min(3, gx - 1), s=0)
    return spl(np.arange(ny), np.arange(nx))


# ----------------------------------------------------------------------------------------
# Detection
# ----------------------------------------------------------------------------------------

def _detect(resid, valid, noise, sig, nsigma, sup_r, max_n):
    """Matched-filter peaks.  Returns (y, x, amp, snr) sorted by snr (descending)."""
    r0 = np.where(valid, resid, 0.0)
    w = valid.astype(np.float64)
    h = int(math.ceil(4 * sig))
    t = np.arange(-h, h + 1, dtype=np.float64)
    s1 = np.exp(-0.5 * t * t / sig ** 2).sum()
    s2 = np.exp(-t * t / sig ** 2).sum()
    num = ndi.gaussian_filter(r0, sig, mode="constant", truncate=4.0) * s1 * s1
    den = ndi.gaussian_filter(w, sig / math.sqrt(2.0), mode="constant", truncate=4.0 * math.sqrt(2.0)) * s2 * s2
    good = den > 0.25 * s2 * s2
    snr = np.where(good, num / (noise * np.sqrt(np.maximum(den, 1e-30))), -np.inf)
    pk = (snr > nsigma) & (ndi.maximum_filter(snr, size=3, mode="constant", cval=-np.inf) == snr)
    yy, xx = np.nonzero(pk)
    if yy.size == 0:
        return yy, xx, np.zeros(0), np.zeros(0)
    sn = snr[yy, xx]
    amp = num[yy, xx] / den[yy, xx]
    o = np.argsort(-sn, kind="stable")
    yy, xx, sn, amp = yy[o], xx[o], sn[o], amp[o]
    if yy.size > 1:  # suppress weaker peaks within sup_r of a stronger one
        pr = cKDTree(np.c_[xx, yy].astype(float)).query_pairs(sup_r, output_type="ndarray")
        if len(pr):
            drop = np.zeros(yy.size, bool)
            drop[np.maximum(pr[:, 0], pr[:, 1])] = True  # sorted by snr -> larger index is weaker
            yy, xx, sn, amp = yy[~drop], xx[~drop], sn[~drop], amp[~drop]
    return yy[:max_n], xx[:max_n], amp[:max_n], sn[:max_n]


# ----------------------------------------------------------------------------------------
# Source table
# ----------------------------------------------------------------------------------------

_FLOAT = ("x", "y", "A", "s", "cx", "cy", "rb", "sx", "sy", "sA", "snr", "xm", "ym", "sm", "Am")
_BOOL = ("sat", "ext", "alive")


class _Src:
    def __init__(self):
        self.n = 0
        for k in _FLOAT:
            setattr(self, k, np.zeros(0))
        for k in _BOOL:
            setattr(self, k, np.zeros(0, bool))
        self.prior = np.zeros(0, int)

    def add(self, x, y, A, s, rb, prior):
        m = len(x)
        z = np.zeros(m)
        ss = np.full(m, float(s))
        cols = dict(x=x, y=y, A=A, s=ss, cx=x, cy=y, rb=np.full(m, float(rb)),
                    sx=z + np.inf, sy=z + np.inf, sA=z + np.inf, snr=z,
                    xm=x, ym=y, sm=ss, Am=z)
        for k in _FLOAT:
            setattr(self, k, np.concatenate([getattr(self, k), np.asarray(cols[k], float)]))
        for k, v in (("sat", False), ("ext", False), ("alive", True)):
            setattr(self, k, np.concatenate([getattr(self, k), np.full(m, v)]))
        self.prior = np.concatenate([self.prior, np.asarray(prior, int)])
        self.n += m
        return np.arange(self.n - m, self.n)

    @property
    def fwhm(self):
        return self.s * FWHM_PER_SIGMA

    def snapshot(self):
        self.xm, self.ym, self.sm = self.x.copy(), self.y.copy(), self.s.copy()
        self.Am = np.where(self.alive, self.A, 0.0)

    def render(self, shape):
        return _render(shape, self.x, self.y, self.A * self.alive, self.s)


def _render(shape, x, y, A, s):
    """Sum of circular Gaussians (peak A, sigma s) rendered into a full image."""
    ny, nx = shape
    out = np.zeros(ny * nx)
    sel = A != 0
    x, y, A, s = x[sel], y[sel], A[sel], s[sel]
    if x.size == 0:
        return out.reshape(ny, nx)
    h = np.ceil(STAMP_FWHM * s * FWHM_PER_SIGMA).astype(int)
    for hv in np.unique(h):
        m = h == hv
        off = np.arange(-hv, hv + 1)
        px = np.rint(x[m]).astype(int)[:, None] + off
        py = np.rint(y[m]).astype(int)[:, None] + off
        gx = np.exp(-0.5 * (px - x[m, None]) ** 2 / s[m, None] ** 2)
        gy = np.exp(-0.5 * (py - y[m, None]) ** 2 / s[m, None] ** 2) * A[m, None]
        ok = ((py >= 0) & (py < ny))[:, :, None] & ((px >= 0) & (px < nx))[:, None, :]
        flat = np.clip(py, 0, ny - 1)[:, :, None] * nx + np.clip(px, 0, nx - 1)[:, None, :]
        val = gy[:, :, None] * gx[:, None, :]
        out += np.bincount(flat[ok], weights=val[ok], minlength=ny * nx)
    return out.reshape(ny, nx)


def _make_groups(st: _Src, idx: np.ndarray):
    """Connected groups (index arrays) of sources closer than ~2 FWHM."""
    if idx.size == 0:
        return []
    pts = np.c_[st.x[idx], st.y[idx]]
    fw = st.fwhm[idx]
    labels = np.arange(idx.size)
    if idx.size > 1:
        pr = cKDTree(pts).query_pairs(LINK_FWHM * fw.max(), output_type="ndarray")
        if len(pr):
            d = np.hypot(*(pts[pr[:, 0]] - pts[pr[:, 1]]).T)
            pr = pr[d < 0.5 * LINK_FWHM * (fw[pr[:, 0]] + fw[pr[:, 1]])]
        if len(pr):
            g = coo_matrix((np.ones(len(pr)), (pr[:, 0], pr[:, 1])), shape=(idx.size,) * 2)
            _, labels = connected_components(g, directed=False)
    order = np.argsort(labels, kind="stable")
    groups = []
    for part in np.split(order, np.flatnonzero(np.diff(labels[order])) + 1):
        mem = idx[part]
        if mem.size > KMAX:
            mem = mem[np.argsort(st.y[mem])]
            groups.extend(mem[i:i + KMAX] for i in range(0, mem.size, KMAX))
        else:
            groups.append(mem)
    return groups


# ----------------------------------------------------------------------------------------
# Batched Levenberg-Marquardt fit of groups
# ----------------------------------------------------------------------------------------

def _solve(Hm, g):
    try:
        return np.linalg.solve(Hm, g[..., None])[..., 0]
    except np.linalg.LinAlgError:
        return (np.linalg.pinv(Hm) @ g[..., None])[..., 0]


def _inv(Hm):
    try:
        return np.linalg.inv(Hm)
    except np.linalg.LinAlgError:
        return np.linalg.pinv(Hm)


def _fit_chunk(ctx, ids, width_free):
    """Jointly fit N groups of exactly K sources each. ids: (N,K). Returns dict of (N,K) arrays."""
    st, resid, valid, noise, psf_sig = ctx
    ny, nx = resid.shape
    N, K = ids.shape
    x, y, s = st.x[ids].copy(), st.y[ids].copy(), st.s[ids].copy()
    A = st.A[ids].copy()
    cx, cy, rb = st.cx[ids], st.cy[ids], st.rb[ids]
    prior = st.prior[ids] >= 0
    fwst = np.where(width_free, np.maximum(s, 3 * psf_sig), s) * FWHM_PER_SIGMA
    hk = np.ceil(STAMP_FWHM * fwst)
    x0 = np.clip(np.floor((x - hk).min(1)), 0, nx - 1).astype(int)
    x1 = np.clip(np.ceil((x + hk).max(1)), 0, nx - 1).astype(int)
    y0 = np.clip(np.floor((y - hk).min(1)), 0, ny - 1).astype(int)
    y1 = np.clip(np.ceil((y + hk).max(1)), 0, ny - 1).astype(int)
    W, H = int((x1 - x0).max()) + 1, int((y1 - y0).max()) + 1
    rows = y0[:, None] + np.arange(H)
    cols = x0[:, None] + np.arange(W)
    inb = (rows <= y1[:, None])[:, :, None] & (cols <= x1[:, None])[:, None, :]
    rc, cc = np.minimum(rows, ny - 1), np.minimum(cols, nx - 1)
    V = valid[rc[:, :, None], cc[:, None, :]] & inb
    masked = inb & ~V
    Rz = np.where(V, resid[rc[:, :, None], cc[:, None, :]], 0.0)
    rf, cf = rows.astype(float), cols.astype(float)
    Vf = V.astype(float)

    def gauss(P):
        dy = rf[:, None, :, None] - P[:, :, 2, None, None]
        dx = cf[:, None, None, :] - P[:, :, 1, None, None]
        r2 = dx * dx + dy * dy
        return np.exp(-0.5 * r2 / P[:, :, 3, None, None] ** 2), dx, dy, r2

    P = np.stack([A, x, y, s], axis=2)
    Po = np.stack([st.Am[ids], st.xm[ids], st.ym[ids], st.sm[ids]], axis=2)
    go = gauss(Po)[0]
    D = Rz + (Po[:, :, 0, None, None] * go).sum(1) * Vf  # data with this group's old models added back
    free = np.ones((N, K, 4), bool)
    free[:, :, 3] = width_free
    s_lo, s_hi = 0.7 * psf_sig, 8.0 * psf_sig

    # linear amplitude start at the seed positions
    Gm = (gauss(P)[0] * Vf[:, None]).reshape(N, K, -1)
    Hl = np.einsum("nkp,njp->nkj", Gm, Gm)
    bl = np.einsum("nkp,np->nk", Gm, D.reshape(N, -1))
    Hl += np.eye(K) * (1e-9 * np.trace(Hl, axis1=1, axis2=2)[:, None, None] + 1e-12)
    P[:, :, 0] = np.maximum(_solve(Hl, bl), 0.0)

    def cost(P):
        return (((D - (P[:, :, 0, None, None] * gauss(P)[0]).sum(1)) ** 2) * Vf).sum((1, 2))

    def jac(P, fr):
        g, dx, dy, r2 = gauss(P)
        sg = P[:, :, 3, None, None]
        ag = P[:, :, 0, None, None] * g
        J = np.stack([g, ag * dx / sg ** 2, ag * dy / sg ** 2, ag * r2 / sg ** 3], axis=2)
        J *= Vf[:, None, None] * fr[..., None, None]
        return J.reshape(N, 4 * K, -1), ag.sum(1)

    frf = free.astype(float)
    eye = np.eye(4 * K)
    frozen = (~free).reshape(N, 4 * K).astype(float)[:, :, None] * eye
    lam = np.full(N, 1e-2)
    c0 = cost(P)
    for _ in range(LM_ITERS):
        J, m = jac(P, frf)
        r = ((D - m) * Vf).reshape(N, -1)
        Hm = np.einsum("nip,njp->nij", J, J)
        gr = np.einsum("nip,np->ni", J, r)
        dg = np.einsum("nii->ni", Hm)
        Hd = Hm + lam[:, None, None] * (dg[:, :, None] * eye) + frozen
        Hd += eye * (1e-12 + 1e-9 * dg.max(1)[:, None, None])
        step = _solve(Hd, gr).reshape(N, K, 4)
        step[:, :, 1:3] = np.clip(step[:, :, 1:3], -1.0, 1.0)
        step[:, :, 3] = np.clip(step[:, :, 3], -0.25 * P[:, :, 3], 0.25 * P[:, :, 3])
        Pn = P + step
        Pn[:, :, 0] = np.maximum(Pn[:, :, 0], 0.0)
        Pn[:, :, 1] = np.clip(Pn[:, :, 1], cx - rb, cx + rb)
        Pn[:, :, 2] = np.clip(Pn[:, :, 2], cy - rb, cy + rb)
        Pn[:, :, 3] = np.clip(Pn[:, :, 3], s_lo, s_hi)
        c1 = cost(Pn)
        acc = c1 < c0
        P = np.where(acc[:, None, None], Pn, P)
        c0 = np.where(acc, c1, c0)
        lam = np.clip(np.where(acc, lam * 0.25, lam * 8.0), 1e-7, 1e9)
        mv = np.maximum(np.abs(step[:, :, 1:3]).max((1, 2)), np.abs(step[:, :, 3] / P[:, :, 3]).max(1))
        if ((acc & (mv < LM_TOL)) | (lam > 1e5)).all():
            break

    def variances(fr):
        J, _ = jac(P, fr)
        Hm = np.einsum("nip,njp->nij", J, J)
        dg = np.einsum("nii->ni", Hm)
        Hm = Hm + (fr.reshape(N, 4 * K) == 0).astype(float)[:, :, None] * eye
        Hm = Hm + eye * (1e-9 * dg.max(1)[:, None, None] + 1e-12)
        return np.maximum(np.einsum("nii->ni", _inv(Hm)), 0.0).reshape(N, K, 4) * noise ** 2

    var_full = variances(frf)
    fr2 = frf.copy()  # priors: positions held fixed for the flux error (better resolution than the data)
    fr2[prior[..., None] & np.array([False, True, True, False])] = 0.0
    var_a = variances(fr2)
    # saturated: any masked pixel within half a FWHM of the fitted centre
    r2 = gauss(P)[3]
    core = r2 <= (0.5 * P[:, :, 3, None, None] * FWHM_PER_SIGMA) ** 2
    sat = (core & masked[:, None]).any((2, 3))
    bad_fit = V.sum((1, 2)) < 4 * K + 2
    sA = np.where(bad_fit[:, None], np.inf, np.sqrt(var_a[:, :, 0]))
    return dict(x=P[:, :, 1], y=P[:, :, 2], A=P[:, :, 0], s=P[:, :, 3],
                sx=np.sqrt(var_full[:, :, 1]), sy=np.sqrt(var_full[:, :, 2]), sA=sA, sat=sat)


def _fit_groups(ctx, st: _Src, dirty: np.ndarray, width_free: np.ndarray):
    """Fit every group containing a dirty source. Returns (per-source result dict, group id)."""
    psf_sig = ctx[4]
    groups = [g for g in _make_groups(st, np.flatnonzero(st.alive)) if dirty[g].any()]
    n = st.n
    res = {k: np.full(n, np.nan) for k in ("x", "y", "A", "s", "sx", "sy", "sA")}
    res["sat"] = np.zeros(n, bool)
    gid = np.full(n, -1)
    by_k: dict[int, list] = {}
    for gi, g in enumerate(groups):
        gid[g] = gi
        by_k.setdefault(len(g), []).append(g)
    for K, gl in by_k.items():
        ids = np.array(gl)
        fw = np.where(width_free[ids], np.maximum(st.s[ids], 3 * psf_sig), st.s[ids]) * FWHM_PER_SIGMA
        hk = np.ceil(STAMP_FWHM * fw)
        ext = ((st.x[ids] + hk).max(1) - (st.x[ids] - hk).min(1) + 2) * ((st.y[ids] + hk).max(1) - (st.y[ids] - hk).min(1) + 2)
        o = np.argsort(ext)
        ids, ext = ids[o], ext[o]
        i = 0
        while i < len(ids):
            j = i + 1
            while j < len(ids) and (j + 1 - i) * K * ext[j] * 1.1 <= CHUNK_ELEMS:
                j += 1
            out = _fit_chunk(ctx, ids[i:j], width_free[ids[i:j]])
            flat = ids[i:j].ravel()
            for k, v in out.items():
                res[k][flat] = v.ravel()
            i = j
    return res, gid


def _apply(st: _Src, res, mask):
    for k in ("x", "y", "A", "s", "sx", "sy", "sA", "sat"):
        getattr(st, k)[mask] = res[k][mask]
    sa = st.sA[mask]
    st.snr[mask] = np.where(np.isfinite(sa) & (sa > 0), st.A[mask] / np.where(sa > 0, sa, 1.0), 0.0)


def _prune(st: _Src, nsigma):
    thr = np.where(st.prior >= 0, PRIOR_MIN_SNR, max(0.7 * nsigma, 3.0))
    bad = st.alive & ~((st.A > 0) & (st.snr >= thr) & np.isfinite(st.x))
    st.alive[bad] = False
    st.A[~st.alive] = 0.0


# ----------------------------------------------------------------------------------------
# Public API
# ----------------------------------------------------------------------------------------

def _kill_spikes(st: _Src, new: np.ndarray, left, M, valid, psf, noise) -> None:
    """Drop free sources that are not PSF-like (cosmic-ray / hot-pixel spikes): the residual
    within 1.5 px of the fit is a large fraction of the source's own model flux."""
    ci = new[st.alive[new] & (st.snr[new] > 10.0)]
    if ci.size == 0:
        return
    ny, nx = left.shape
    r = 2
    off = np.arange(-r, r + 1)
    oy, ox = np.nonzero(off[:, None] ** 2 + off[None, :] ** 2 <= 2.25)
    py = np.clip(np.rint(st.y[ci])[:, None].astype(int) + oy - r, 0, ny - 1)
    px = np.clip(np.rint(st.x[ci])[:, None].astype(int) + ox - r, 0, nx - 1)
    ok = valid[py, px]
    res = (np.abs(left[py, px]) * ok).sum(1)
    own = np.maximum((st.A[ci][:, None] * np.exp(-0.5 * ((px - st.x[ci][:, None]) ** 2
                                                         + (py - st.y[ci][:, None]) ** 2)
                                                  / st.s[ci][:, None] ** 2) * ok).sum(1), 1e-30)
    bad = ci[res > SPIKE_REL * own]
    st.alive[bad] = False
    st.A[bad] = 0.0


def match_catalog(sources: list, priors: list, max_sep_px: float) -> None:
    """One-to-one nearest-neighbour match; sets ``source["cat"]`` = prior.cat + ``sep_px``.

    Unmatched sources are left untouched.  The caller converts ``sep_px`` to ``sep_arcsec``.
    """
    if not sources or not priors:
        return
    sp = np.array([[s["x"], s["y"]] for s in sources], float)
    pp = np.array([[p.x, p.y] for p in priors], float)
    k = min(4, len(priors))
    d, j = cKDTree(pp).query(sp, k=k, distance_upper_bound=max_sep_px)
    d, j = d.reshape(len(sources), k), j.reshape(len(sources), k)
    si, ki = np.nonzero(np.isfinite(d))
    used_s, used_p = set(), set()
    for o in np.argsort(d[si, ki], kind="stable"):
        a, b = int(si[o]), int(j[si[o], ki[o]])
        if a in used_s or b in used_p:
            continue
        used_s.add(a)
        used_p.add(b)
        sources[a]["cat"] = {**priors[b].cat, "sep_px": float(d[si[o], ki[o]])}


def _mag_key(p: Prior) -> float:
    m = (p.cat or {}).get("mag")
    return float(m) if isinstance(m, (int, float)) and np.isfinite(m) else 99.0


def fit_frame(img, bad=None, psf_fwhm_px: float = 2.0, priors=None, *, nsigma: float = 5.0,
              max_sources: int = 2000) -> FrameModel:
    img = np.array(img, dtype=np.float64)
    ny, nx = img.shape
    finite = np.isfinite(img)
    valid = finite if bad is None else (finite & ~np.asarray(bad, bool))
    psf = float(psf_fwhm_px)
    sig = psf / FWHM_PER_SIGMA

    def nan_bg(b):
        return np.where(finite, b, np.nan).astype(np.float32)

    def trivial(bg, noise=0.0):
        left = np.where(finite, img - bg, np.nan).astype(np.float32)
        return FrameModel([], nan_bg(bg), left, psf, float(noise), 1.0)

    if valid.sum() < 64:
        return trivial(np.zeros((ny, nx)))

    box = int(np.clip(round(min(ny, nx) / 64), 8, 16))
    box = int(min(max(box, math.ceil(4 * psf)), 32, max(min(ny, nx) // 2, 4)))
    bg = _background(img, valid, box, _diff_noise(img, valid))
    noise = _mad_sigma((img - bg)[valid])
    if not noise > 0:
        return trivial(bg, 0.0)
    noise_fit = noise

    st = _Src()
    M = np.zeros((ny, nx))

    def ctx_for(resid):
        return (st, resid, valid, noise, sig)

    # ---- priors
    pri = [(i, p) for i, p in enumerate(priors or [])
           if np.isfinite(p.x) and np.isfinite(p.y) and -1.5 <= p.x <= nx - 0.5 and -1.5 <= p.y <= ny - 0.5]
    if pri:
        if len(pri) > max_sources:
            pri = sorted(pri, key=lambda ip: _mag_key(ip[1]))[:max_sources]
        px = np.array([p.x for _, p in pri], float)
        py = np.array([p.y for _, p in pri], float)
        ix = np.clip(np.rint(px).astype(int), 0, nx - 1)
        iy = np.clip(np.rint(py).astype(int), 0, ny - 1)
        a0 = np.maximum(np.where(valid[iy, ix], (img - bg)[iy, ix], 0.0), 0.0)
        new = st.add(px, py, a0, sig, 0.5, [i for i, _ in pri])
        dirty = np.zeros(st.n, bool)
        dirty[new] = True
        res, _ = _fit_groups(ctx_for(img - bg), st, dirty, np.zeros(st.n, bool))
        _apply(st, res, dirty)
        _prune(st, nsigma)
        M = st.render((ny, nx))
        st.snapshot()

    def width_stage(new_mask):
        cand = new_mask & st.alive & (st.prior < 0) & (st.snr >= WIDTH_FIT_SNR)
        if not cand.any():
            return
        # cheap screen: reduced chi^2 of the fixed-PSF residual within ~1.3 FWHM
        ci = np.flatnonzero(cand)
        r = int(math.ceil(1.3 * psf))
        off = np.arange(-r, r + 1)
        disc = (off[:, None] ** 2 + off[None, :] ** 2) <= (1.3 * psf) ** 2
        oy, ox = np.nonzero(disc)
        py = np.clip(np.rint(st.y[ci])[:, None].astype(int) + oy - r, 0, ny - 1)
        px = np.clip(np.rint(st.x[ci])[:, None].astype(int) + ox - r, 0, nx - 1)
        rr, vv = (img - bg - M)[py, px], valid[py, px]
        chi = ((rr ** 2) * vv).sum(1) / np.maximum(vv.sum(1), 1) / noise ** 2
        cand[ci[chi < 2.5]] = False
        if not cand.any():
            return
        s_old = st.s.copy()
        st.s[cand] *= 1.2
        res, gid = _fit_groups(ctx_for(img - bg - M), st, cand, cand)
        ext = cand & (res["s"] * FWHM_PER_SIGMA > EXT_RATIO * psf)
        acc = np.isin(gid, np.unique(gid[ext])) & (gid >= 0)
        _apply(st, res, acc)
        st.s[cand & ~acc] = s_old[cand & ~acc]
        st.ext |= ext & acc

    sat_done = [np.zeros(0, bool)]

    def sat_stage():
        """Saturated stars: the masked core leaves only the wings, which a narrow Gaussian
        extrapolates to an absurd amplitude; refit their width (from valid pixels only)."""
        cand = st.alive & st.sat & ~st.ext & (st.A > SAT_MIN_SNR * noise)
        done = sat_done[0]
        cand[:done.size] &= ~done  # each saturated star is width-refit once
        if not cand.any():
            return
        sat_done[0] = np.concatenate([done | cand[:done.size], cand[done.size:]])
        s_old = st.s.copy()
        st.s[cand] = np.maximum(st.s[cand] * 1.6, 1.6 * sig)
        res, gid = _fit_groups(ctx_for(img - bg - M), st, cand, cand)
        acc = (gid >= 0) & np.isfinite(res["A"])
        _apply(st, res, acc)
        st.s[cand & ~acc] = s_old[cand & ~acc]

    if st.n:
        sat_stage()
        M = st.render((ny, nx))
        st.snapshot()

    # ---- detect / fit passes
    for _ in range(3):
        resid = img - bg - M
        noise = _mad_sigma(resid[valid])
        if not noise > 0:
            break
        noise_fit = noise
        room = max_sources - int(st.alive.sum())
        if room <= 0:
            break
        yy, xx, amp, _sn = _detect(resid, valid, noise, sig, nsigma, 0.8 * psf, room)
        if yy.size and M.any():  # PSF-mismatch rings/halos: no free source far below the local model
            keep = amp >= HALO_FRAC * M[yy, xx]
            yy, xx, amp = yy[keep], xx[keep], amp[keep]
        if yy.size:  # bright-star halos (the real PSF has wings a Gaussian lacks)
            br = np.flatnonzero(st.alive & (st.A > HALO_MIN_SNR * noise))
            if br.size:
                tr = cKDTree(np.c_[st.x[br], st.y[br]])
                pts = np.c_[xx, yy].astype(float)
                keep = np.ones(yy.size, bool)
                for rad, frac in ((6.0, 0.01), (14.0, 0.004)):
                    for k, nb in enumerate(tr.query_ball_point(pts, rad)):
                        if nb and amp[k] < frac * st.A[br[nb]].max():
                            keep[k] = False
                yy, xx, amp = yy[keep], xx[keep], amp[keep]
        al = np.flatnonzero(st.alive)
        if yy.size and al.size:
            d, j = cKDTree(np.c_[st.x[al], st.y[al]]).query(
                np.c_[xx, yy].astype(float), k=min(4, al.size), distance_upper_bound=2 * psf)
            d = d.reshape(len(xx), -1)
            j = np.minimum(j.reshape(len(xx), -1), al.size - 1)
            Anb = np.where(np.isfinite(d), st.A[al][j], 0.0)
            keep = ~((d < 0.4 * psf) | (amp[:, None] < 0.1 * Anb)).any(1)
            yy, xx, amp = yy[keep], xx[keep], amp[keep]
        if yy.size == 0:
            break
        new = st.add(xx.astype(float), yy.astype(float), np.maximum(amp, 0.0), sig,
                     max(2.0, 1.5 * psf), -np.ones(len(xx), int))
        dirty = np.zeros(st.n, bool)
        dirty[new] = True
        res, _ = _fit_groups(ctx_for(resid), st, dirty, np.zeros(st.n, bool))
        _apply(st, res, np.isfinite(res["A"]))  # neighbours in touched groups are refit too
        _prune(st, nsigma)
        M = st.render((ny, nx))
        _kill_spikes(st, new, img - bg - M, M, valid, psf, noise)
        M = st.render((ny, nx))
        st.snapshot()
        newm = np.zeros(st.n, bool)
        newm[new] = True
        width_stage(newm)
        M = st.render((ny, nx))
        st.snapshot()
        sat_stage()
        M = st.render((ny, nx))
        st.snapshot()
        bg = _background(img - M, valid, box, noise)
        if not st.alive[new].any():
            break

    # ---- finalise
    flux_all = st.A * 2 * math.pi * st.s ** 2
    if st.alive.sum() > max_sources:
        keep = np.flatnonzero(st.alive)
        keep = keep[np.argsort(-flux_all[keep])[:max_sources]]
        st.alive[:] = False
        st.alive[keep] = True
        st.A[~st.alive] = 0.0
    M = st.render((ny, nx))
    bg = _background(img - M, valid, box, noise)
    left = img - bg - M
    noise_f = _mad_sigma(left[valid])
    if noise_f > 0:
        noise = noise_f
    quality = float(np.sqrt(np.mean(np.minimum(left[valid] ** 2, (QUALITY_CLIP * noise) ** 2))) / noise)
    scale = noise / noise_fit if noise_fit > 0 else 1.0

    idx = np.flatnonzero(st.alive)
    idx = idx[np.argsort(-flux_all[idx], kind="stable")]
    blend = np.full(st.n, -1)
    bid = 0
    for g in _make_groups(st, idx):
        if len(g) > 1:
            blend[g] = bid
            bid += 1
    plist = list(priors or [])
    out = []
    for k, i in enumerate(idx):
        sat = bool(st.sat[i] and st.A[i] > SAT_MIN_SNR * noise_fit)
        # A saturated star's wing-only refit looks broad; that is not evidence of extent, so it
        # stays a point source (its fitted width is still used for flux and the leftover).
        ext = bool(st.ext[i]) and not sat
        cat = None
        if st.prior[i] >= 0:
            pp = plist[st.prior[i]]
            cat = {**pp.cat, "sep_px": float(math.hypot(st.x[i] - pp.x, st.y[i] - pp.y))}
        f2 = 2 * math.pi * st.s[i] ** 2
        out.append({
            "id": k, "x": float(st.x[i]), "y": float(st.y[i]),
            "sx": float(st.sx[i] * scale), "sy": float(st.sy[i] * scale),
            "amp": float(st.A[i]), "flux": float(st.A[i] * f2),
            "flux_err": float(st.sA[i] * scale * f2),
            "snr": float(st.snr[i] / scale),
            "kind": "extended" if ext else "point",
            "fwhm": float(st.s[i] * FWHM_PER_SIGMA) if ext else psf,
            "blend": int(blend[i]) if blend[i] >= 0 else None,
            "saturated": sat, "cat": cat})
    out = _absorb_into_saturated(out, psf)
    if plist:  # free detections sitting on a dropped prior inherit its catalogue entry
        used = {int(st.prior[i]) for i in idx if st.prior[i] >= 0}
        match_catalog([s for s in out if s["cat"] is None],
                      [p for j, p in enumerate(plist) if j not in used], 0.5 * psf)
    return FrameModel(out, nan_bg(bg), np.where(finite, left, np.nan).astype(np.float32),
                      psf, float(noise), quality)


def _absorb_into_saturated(out: list[dict], psf: float) -> list[dict]:
    """Fold fainter free fits sitting inside a saturated star's core into that star.

    The joint fit soaks up the mismatch of a saturated core with extra components a fraction of a
    pixel away. They are not separate objects, so reporting them would make one star read as a
    blend of several. Only the reported list changes; the leftover already includes every
    component, so it is unaffected. Catalogue-seeded sources are never absorbed.
    """
    sats = [s for s in out if s["saturated"]]
    if not sats:
        return out
    gone = set()
    for s in sorted(sats, key=lambda q: -q["amp"]):
        if id(s) in gone:
            continue
        for q in out:
            # q may itself carry the saturated flag just because it sits on the same masked core
            if q is s or id(q) in gone or q["cat"] is not None:
                continue
            if q["amp"] < s["amp"] and math.hypot(q["x"] - s["x"], q["y"] - s["y"]) < psf:
                s["flux"] += q["flux"]
                s["flux_err"] = math.hypot(s["flux_err"], q["flux_err"])
                gone.add(id(q))
    kept = [q for q in out if id(q) not in gone]
    groups: dict[int, int] = {}
    for q in kept:
        if q["blend"] is not None:
            groups[q["blend"]] = groups.get(q["blend"], 0) + 1
    for k, q in enumerate(kept):
        q["id"] = k
        if q["blend"] is not None and groups[q["blend"]] < 2:
            q["blend"] = None
    return kept
