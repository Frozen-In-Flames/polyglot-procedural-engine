"""Inverse-rendering foundry: turn super-resolved frames into procedural math.

Two-sided design (see INVERSE.md). This module is the FOUNDRY side: it runs
once, offline, on a machine with a GPU (or Colab). It never ships to the
player. Its output is a plain JSON parameter bundle that the TypeScript
runtime evaluates through the existing bit-exact mirrors. No ML framework,
no NVIDIA dependency, and no Google dependency exists at runtime.

Pipeline:
  1. splat_to_uv -- reproject a super-resolved screen frame into the
     asset's texture (UV) space, nearest-depth wins.
  2. strip_lighting -- recover albedo as observed / shading, in linear
     space, with guards so near-black shading never explodes.
  3. fit_material / fit_height_style -- fit the engine's own procedural
     functions to the recovered maps (distillation).
  4. make_bundle -- emit the plain JSON bundle the runtime loads.

Everything is stdlib-only and deterministic: same seed, same bundle,
on any machine, forever. All math is float64; the GLSL runtime side is
float32, so agreement there is tolerance-checked, not bit-exact
(documented in INVERSE.md; the TS float64 reference in
src/bridge/distill.ts IS bit-exact with this module and is tested).
"""
import json
import math
import os
import struct
from array import array
from typing import Dict, List, Optional, Tuple

from .rng import Rng
from .ml import make_style_weights, stylize_forward

BUNDLE_FORMAT = "xr-distill/1"
ENGINE_TAG = "xr-engine"
MAX_OCTAVES = 6
PASS_SCORE = 0.70
PASS_COVERAGE = 0.50

# ---------------------------------------------------------------------------
# Shared detail function.
#
# This is the canonical distilled-detail math. The GLSL in
# src/material/shader.ts (DISTILL_GLSL, 'distill' effect) evaluates the same
# formula in float32; the TypeScript distillDetail() in src/bridge/distill.ts
# mirrors this function in float64 and is tested bit-exact against it.
#
# The hash is a polynomial hash (Hoskins-style), deliberately using NO
# transcendental functions: sin() differs by 1 ulp between CPython and
# V8 (verified), which would break bit-exactness. Every op here is a
# correctly-rounded float64 basic op, so Python and JS agree exactly.
# ---------------------------------------------------------------------------


def _fract(x: float) -> float:
    return x - math.floor(x)


def _dhash(px: float, py: float) -> float:
    """Polynomial cell hash in [0, 1). Mirrors xg_hhash in DISTILL_GLSL."""
    p3x = _fract(px * 0.1031)
    p3y = _fract(py * 0.1031)
    p3z = _fract(px * 0.1031)
    d = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33)
    p3x += d
    p3y += d
    p3z += d
    return _fract((p3x + p3y) * p3z)


def _dnoise(px: float, py: float) -> float:
    """Value noise over the polynomial-hash lattice. Mirrors xg_dnoise."""
    ix, iy = math.floor(px), math.floor(py)
    fx, fy = px - ix, py - iy
    ux = fx * fx * (3.0 - 2.0 * fx)
    uy = fy * fy * (3.0 - 2.0 * fy)
    a = _dhash(ix, iy)
    b = _dhash(ix + 1, iy)
    c = _dhash(ix, iy + 1)
    d = _dhash(ix + 1, iy + 1)
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy


def detail_reference(
    u: float,
    v: float,
    seed_ox: float,
    seed_oy: float,
    scale: float,
    octaves: int,
    weights: List[float],
    bias: float,
) -> float:
    """Float64 reference of the distilled detail multiplier.

    Mirrors the 'distill' effect body in src/material/shader.ts exactly:
    albedo *= uDistillBias + sum_o on(o) * uDistillW[o] * noise(uv*scale+seed).
    """
    total = 0.0
    px, py = u * scale + seed_ox, v * scale + seed_oy
    freq = 1.0
    for o in range(MAX_OCTAVES):
        if o <= octaves - 1:
            total += weights[o] * _dnoise(px * freq, py * freq)
        freq *= 2.03
    return bias + total


# ---------------------------------------------------------------------------
# Step 1: screen space -> UV space (nearest-depth-wins splat)
#
# Layouts are flat row-major lists, matching the rest of xrgen:
#   frame   : [r, g, b] * (w * h), linear-space light
#   uvbuf   : [u, v] * (w * h)      from the G-buffer pass
#   depthbuf: [d] * (w * h)         view depth, nearer is smaller
# Returns (accum_rgb, counts): accum is [r, g, b] * (tex_w * tex_h),
# counts is [n] * (tex_w * tex_h).
# ---------------------------------------------------------------------------


def splat_to_uv(
    frame: List[float],
    uvbuf: List[float],
    depthbuf: List[float],
    w: int,
    h: int,
    tex_w: int,
    tex_h: int,
) -> Tuple[List[float], List[int]]:
    accum = [0.0] * (tex_w * tex_h * 3)
    counts = [0] * (tex_w * tex_h)
    best_depth = [math.inf] * (tex_w * tex_h)
    for j in range(h):
        for i in range(w):
            p = j * w + i
            u, v = uvbuf[p * 2], uvbuf[p * 2 + 1]
            if not (0.0 <= u <= 1.0 and 0.0 <= v <= 1.0):
                continue
            ti = min(int(u * tex_w), tex_w - 1)
            tj = min(int(v * tex_h), tex_h - 1)
            t = tj * tex_w + ti
            d = depthbuf[p]
            if d >= best_depth[t]:
                continue
            # Nearest-depth wins: replace, do not blend.
            best_depth[t] = d
            accum[t * 3] = frame[p * 3]
            accum[t * 3 + 1] = frame[p * 3 + 1]
            accum[t * 3 + 2] = frame[p * 3 + 2]
            counts[t] = 1
    return accum, counts


def texel_mean_color(
    accum: List[float], counts: List[int]
) -> Tuple[float, float, float]:
    """Sample-weighted mean color over texels that received samples."""
    sr = sg = sb = n = 0.0
    for t, c in enumerate(counts):
        if c > 0:
            sr += accum[t * 3]
            sg += accum[t * 3 + 1]
            sb += accum[t * 3 + 2]
            n += 1.0
    if n == 0.0:
        return (0.0, 0.0, 0.0)
    return (sr / n, sg / n, sb / n)


def coverage(counts: List[int]) -> float:
    """Fraction of texels that received at least one sample."""
    if not counts:
        return 0.0
    hit = sum(1 for c in counts if c > 0)
    return hit / len(counts)


# ---------------------------------------------------------------------------
# Step 2: lighting strip. albedo = observed / shading, in linear space.
#
# shading comes from the G-buffer pass: the engine's own lighting equation
# evaluated with albedo = 1 (or exactly 1.0 for unlit materials). Where
# shading is near zero we cannot trust the division, so those texels are
# marked invalid and excluded from fitting.
# ---------------------------------------------------------------------------


def strip_lighting(
    observed: List[float],
    shading: List[float],
    counts: List[int],
    eps: float = 1e-4,
    albedo_cap: float = 8.0,
) -> Tuple[List[float], List[bool]]:
    """Recover per-texel albedo. Returns (albedo_rgb, valid_mask)."""
    n = len(counts)
    albedo = [0.0] * (n * 3)
    valid = [False] * n
    for t in range(n):
        if counts[t] == 0:
            continue
        ok = True
        for k in range(3):
            s = shading[t * 3 + k]
            if s < eps:
                ok = False
                break
            a = observed[t * 3 + k] / s
            albedo[t * 3 + k] = min(max(a, 0.0), albedo_cap)
        valid[t] = ok
    return albedo, valid


def srgb_to_linear(c: float) -> float:
    """Use when the upscaler hands you sRGB frames; the pipe is linear."""
    if c <= 0.04045:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


# ---------------------------------------------------------------------------
# Step 3: distillation fitting.
#
# The model is linear in its weights, so fitting is exact least squares,
# not gradient descent: for a candidate (seed offset, scale, octaves),
# solve for weights[6] + bias against the recovered detail. Candidate
# search is seeded, so the whole fit is deterministic.
# ---------------------------------------------------------------------------


def _design_row(
    u: float, v: float, seed_ox: float, seed_oy: float, scale: float,
    octaves: int,
) -> List[float]:
    """One row of the least-squares design matrix: 6 noise cols + bias."""
    row = []
    px, py = u * scale + seed_ox, v * scale + seed_oy
    freq = 1.0
    for o in range(MAX_OCTAVES):
        if o <= octaves - 1:
            row.append(_dnoise(px * freq, py * freq))
        else:
            row.append(0.0)
        freq *= 2.03
    row.append(1.0)  # bias column
    return row


def _solve_least_squares(
    rows: List[List[float]], targets: List[float]
) -> List[float]:
    """Normal equations + Gaussian elimination. Small (<=7 unknowns)."""
    m = len(rows[0])
    ata = [[0.0] * m for _ in range(m)]
    atb = [0.0] * m
    for r, t in zip(rows, targets):
        for a in range(m):
            atb[a] += r[a] * t
            for b in range(a, m):
                ata[a][b] += r[a] * r[b]
    for a in range(m):
        for b in range(a):
            ata[a][b] = ata[b][a]
    # Regularize lightly so flat regions do not blow up.
    for a in range(m):
        ata[a][a] += 1e-9
    # Gaussian elimination with partial pivoting.
    n = m
    aug = [ata[i] + [atb[i]] for i in range(n)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(aug[r][col]))
        aug[col], aug[piv] = aug[piv], aug[col]
        pv = aug[col][col]
        if abs(pv) < 1e-12:
            continue
        for r in range(col + 1, n):
            f = aug[r][col] / pv
            for c in range(col, n + 1):
                aug[r][c] -= f * aug[col][c]
    x = [0.0] * n
    for i in range(n - 1, -1, -1):
        s = aug[i][n] - sum(aug[i][j] * x[j] for j in range(i + 1, n))
        x[i] = s / aug[i][i] if abs(aug[i][i]) > 1e-12 else 0.0
    return x


def _rmse(pred: List[float], target: List[float]) -> float:
    n = len(target)
    if n == 0:
        return math.inf
    return math.sqrt(sum((p - t) ** 2 for p, t in zip(pred, target)) / n)


def _r2_score(pred: List[float], target: List[float]) -> float:
    """Coefficient of determination: fraction of variance explained.
    1.0 is a perfect fit, 0.0 explains nothing (flat model). This is the
    honest quality metric: a near-flat fit on real detail scores near
    zero and gets flagged, never silently shipped."""
    n = len(target)
    if n == 0:
        return 0.0
    mean = sum(target) / n
    ss_tot = sum((t - mean) ** 2 for t in target)
    if ss_tot < 1e-12:
        return 0.0
    ss_res = sum((p - t) ** 2 for p, t in zip(pred, target))
    return max(0.0, min(1.0, 1.0 - ss_res / ss_tot))


def fit_detail(
    albedo: List[float],
    valid: List[bool],
    tex_w: int,
    tex_h: int,
    base_color: Tuple[float, float, float],
    seed: int,
    src: Optional[dict] = None,
) -> Tuple[dict, float, float]:
    """Fit the detail function to recovered albedo.

    Target per texel: mean albedo / base_color - 1 (the detail residual).
    Returns (params, rmse, r2). Deterministic for the seed.

    src is the honest part: when the input frame was rendered by the
    engine itself, the source detail parameters (seed offset, scale,
    octaves) are KNOWN from the material spec, so we fit weights + bias
    by exact least squares against the true basis. A noise seed cannot
    be discovered by random search (uncorrelated fields), so when the
    input is foreign (src is None) we fit against a canonical seed and
    let the R^2 score report the truth: statistical approximation only.
    """
    us, vs, targets = [], [], []
    for tj in range(tex_h):
        v = (tj + 0.5) / tex_h
        for ti in range(tex_w):
            t = tj * tex_w + ti
            if not valid[t]:
                continue
            u = (ti + 0.5) / tex_w
            r = albedo[t * 3] / max(base_color[0], 1e-6)
            g = albedo[t * 3 + 1] / max(base_color[1], 1e-6)
            b = albedo[t * 3 + 2] / max(base_color[2], 1e-6)
            us.append(u)
            vs.append(v)
            # Full detail multiplier (not residual): the runtime
            # evaluates albedo *= bias + sum(w * noise), so the bias
            # column carries the mean and no +1 is needed at runtime.
            targets.append((r + g + b) / 3.0)
    if not targets:
        raise ValueError("fit_detail: no valid texels to fit")

    if src is not None:
        candidates = [(
            float(src["seed"][0]), float(src["seed"][1]),
            float(src["scale"]), int(src["octaves"]),
        )]
    else:
        # Canonical seed for foreign inputs; discrete scale search only.
        candidates = [
            (0.0, 0.0, s, 4)
            for s in (8.0, 16.0, 24.0, 32.0, 48.0)
        ]
    best = None  # (r2, rmse, params)
    for seed_ox, seed_oy, scale, octaves in candidates:
        rows = [
            _design_row(u, v, seed_ox, seed_oy, scale, octaves)
            for u, v in zip(us, vs)
        ]
        w = _solve_least_squares(rows, targets)
        pred = [sum(rw * x for rw, x in zip(row, w)) for row in rows]
        err = _rmse(pred, targets)
        r2 = _r2_score(pred, targets)
        if best is None or r2 > best[0]:
            best = (
                r2, err,
                {
                    "seed": [seed_ox, seed_oy],
                    "scale": scale,
                    "octaves": octaves,
                    "weights": w[:6],
                    "bias": w[6],
                },
            )
    assert best is not None
    r2, err, params = best
    return params, err, r2


def fit_material(
    albedo: List[float],
    valid: List[bool],
    tex_w: int,
    tex_h: int,
    seed: int,
    src: Optional[dict] = None,
) -> Tuple[dict, dict]:
    """Fit base color + detail. Returns (material_params, quality).

    src optionally carries the known source detail parameters when the
    input frame was rendered by the engine itself (see fit_detail).
    quality['score'] is R^2: fraction of detail variance explained.
    """
    r, g, b = texel_mean_color(
        albedo, [1 if v else 0 for v in valid]
    )
    base_color = (min(max(r, 0.0), 1.0), min(max(g, 0.0), 1.0),
                  min(max(b, 0.0), 1.0))
    params, rmse, r2 = fit_detail(albedo, valid, tex_w, tex_h, base_color,
                                  seed, src=src)
    cov = sum(1 for v in valid if v) / len(valid) if valid else 0.0
    quality = {
        "rmse": rmse,
        "score": r2,
        "coverage": cov,
    }
    quality["passed"] = (
        quality["score"] >= PASS_SCORE and cov >= PASS_COVERAGE
    )
    material = {
        "baseColor": [base_color[0], base_color[1], base_color[2]],
        "detail": {
            "kind": "fbm-hhash",
            "seed": params["seed"],
            "scale": params["scale"],
            "octaves": params["octaves"],
            "weights": params["weights"],
            "bias": params["bias"],
        },
    }
    return material, quality


def fit_quality_score(rmse: float, data_range: float, cov: float) -> float:
    """Legacy helper kept for API stability: prefer the R^2 score that
    fit_detail returns. Bad fits score low; they get flagged, never
    silently shipped (see make_bundle, which records passed/failed)."""
    if data_range < 1e-9:
        return 0.0
    return max(0.0, min(1.0, 1.0 - rmse / data_range))


def fit_height_style(
    height_detail: List[float],
    w: int,
    h: int,
    seed: int,
    candidates: int = 24,
    src_style_seed: Optional[int] = None,
) -> Tuple[dict, float]:
    """Fit style-MLP-shaped weights to a recovered height-detail map.

    Reuses the exact MLP form the runtime already mirrors
    (make_style_weights / stylize_forward): the bundle carries plain
    weights, TsMlProvider evaluates them. When the input was rendered
    by the engine itself, src_style_seed is KNOWN and the weights are
    reproduced exactly (verification mode). Otherwise a seeded random
    search runs and the rmse says honestly how close it got.
    Returns (weights_dict, rmse). Deterministic for the seed.
    """
    if len(height_detail) != w * h:
        raise ValueError("height_detail size must equal w*h")
    data_range = max(height_detail) - min(height_detail)
    if data_range < 1e-9:
        raise ValueError("fit_height_style: flat height detail, nothing to fit")

    def _err_for(weights: dict) -> Tuple[float, dict]:
        pred = [
            stylize_forward(
                [height_detail[idx], (idx % w) / max(w - 1, 1),
                 (idx // w) / max(h - 1, 1)],
                weights,
            )
            for idx in range(w * h)
        ]
        # Fit an affine map from MLP output to the target: the MLP gives
        # the shape, scale/offset are free (2-param least squares).
        n = w * h
        sx = sum(pred)
        sxx = sum(p * p for p in pred)
        sy = sum(height_detail)
        sxy = sum(p * t for p, t in zip(pred, height_detail))
        denom = n * sxx - sx * sx
        if abs(denom) < 1e-12:
            return math.inf, {"scale": 1.0, "offset": 0.0}
        a = (n * sxy - sx * sy) / denom
        b = (sy - a * sx) / n
        err = math.sqrt(
            sum((a * p + b - t) ** 2 for p, t in zip(pred, height_detail)) / n
        )
        return err, {"scale": a, "offset": b}

    if src_style_seed is not None:
        weights = make_style_weights(src_style_seed)
        err, affine = _err_for(weights)
        weights = dict(weights)
        weights["affine"] = affine
        return weights, err

    rng = Rng(seed ^ 0x5EED)
    best = None
    for _ in range(candidates):
        style_seed = int(rng.uniform(0, 2 ** 31))
        weights = make_style_weights(style_seed)
        err, affine = _err_for(weights)
        if best is None or err < best[0]:
            best = (err, weights, affine)
    if best is None:
        raise ValueError("fit_height_style: no candidate fit")
    err, weights, affine = best
    weights = dict(weights)
    weights["affine"] = affine
    return weights, err


# ---------------------------------------------------------------------------
# Step 4: the bundle. Plain JSON. This is the only thing that crosses from
# the foundry to the runtime, and it carries no code, no weights files,
# no textures, and no dependency on anything but arithmetic.
# ---------------------------------------------------------------------------


def make_bundle(
    asset: str,
    seed: int,
    material: dict,
    quality: dict,
    height_style: Optional[dict] = None,
    provenance: Optional[dict] = None,
    engine_version: str = "0.3.0",
) -> dict:
    """Assemble the distillation bundle. quality['passed'] is recorded
    verbatim: a failed fit ships as a flagged document, never silently."""
    return {
        "format": BUNDLE_FORMAT,
        "asset": asset,
        "engine": ENGINE_TAG,
        "engine_version": engine_version,
        "seed": seed,
        "material": material,
        "heightStyle": height_style,
        "quality": quality,
        "provenance": provenance or {},
    }


def validate_bundle(doc: dict) -> dict:
    """Schema + range check. Raises ValueError on anything malformed."""
    if not isinstance(doc, dict):
        raise ValueError("bundle must be an object")
    for key in ("format", "asset", "engine", "seed", "material", "quality"):
        if key not in doc:
            raise ValueError(f"bundle missing required key: {key}")
    if doc["format"] != BUNDLE_FORMAT:
        raise ValueError(f"unknown bundle format: {doc['format']}")
    if doc["engine"] != ENGINE_TAG:
        raise ValueError(f"bundle is for engine {doc['engine']!r}, not xr-engine")
    mat = doc["material"]
    bc = mat.get("baseColor")
    if not (isinstance(bc, list) and len(bc) == 3
            and all(isinstance(c, (int, float)) and 0.0 <= c <= 1.0 for c in bc)):
        raise ValueError("material.baseColor must be [r, g, b] in [0, 1]")
    det = mat.get("detail", {})
    if det.get("kind") != "fbm-hhash":
        raise ValueError("material.detail.kind must be 'fbm-hhash'")
    w = det.get("weights")
    if not (isinstance(w, list) and len(w) == MAX_OCTAVES
            and all(isinstance(x, (int, float)) and math.isfinite(x) for x in w)):
        raise ValueError("material.detail.weights must be 6 finite numbers")
    if not (isinstance(det.get("octaves"), int)
            and 1 <= det["octaves"] <= MAX_OCTAVES):
        raise ValueError("material.detail.octaves must be an int in 1..6")
    for key in ("seed", "scale", "bias"):
        if not isinstance(det.get(key), (int, float, list)):
            raise ValueError(f"material.detail.{key} has wrong type")
    hs = doc.get("heightStyle")
    if hs is not None:
        if hs.get("arch") != [3, 6, 1]:
            raise ValueError("heightStyle.arch must be [3, 6, 1]")
        for key in ("w1", "b1", "w2", "b2"):
            if key not in hs:
                raise ValueError(f"heightStyle missing {key}")
    q = doc["quality"]
    for key in ("score", "coverage"):
        v = q.get(key)
        if not (isinstance(v, (int, float)) and 0.0 <= v <= 1.0):
            raise ValueError(f"quality.{key} must be in [0, 1]")
    if not isinstance(q.get("passed"), bool):
        raise ValueError("quality.passed must be a bool")
    return doc


# ---------------------------------------------------------------------------
# G-buffer bundle I/O. Raw float32 LE + JSON manifest: stdlib-readable
# (array/struct), no numpy, no PIL, no packaging story needed.
# ---------------------------------------------------------------------------

_F32 = "<f"


def save_gbuffer_bundle(
    path: str,
    width: int,
    height: int,
    frame: List[float],
    uv: List[float],
    depth: List[float],
    shading: List[float],
) -> None:
    """Write one capture for the foundry to consume."""
    os.makedirs(path, exist_ok=True)
    manifest = {
        "format": "xr-gbuffer/1",
        "width": width,
        "height": height,
        "files": {
            "frame": "frame.f32",      # rgb float32, linear
            "uv": "uv.f32",            # uv float32
            "depth": "depth.f32",       # view depth float32
            "shading": "shading.f32",   # rgb float32, albedo=1 lighting
        },
    }
    with open(os.path.join(path, "manifest.json"), "w") as f:
        json.dump(manifest, f)
    blobs = {
        "frame.f32": (frame, 3),
        "uv.f32": (uv, 2),
        "depth.f32": (depth, 1),
        "shading.f32": (shading, 3),
    }
    for name, (vals, comps) in blobs.items():
        assert len(vals) == width * height * comps, name
        buf = array("f", vals)
        if struct.pack("=f", 1.0) != struct.pack("<f", 1.0):
            buf.byteswap()
        with open(os.path.join(path, name), "wb") as f:
            buf.tofile(f)


def load_gbuffer_bundle(path: str) -> dict:
    """Read a capture back. Returns dict of flat lists + width/height."""
    with open(os.path.join(path, "manifest.json")) as f:
        manifest = json.load(f)
    if manifest.get("format") != "xr-gbuffer/1":
        raise ValueError("not an xr-gbuffer/1 bundle")
    w, h = manifest["width"], manifest["height"]
    comps = {"frame": 3, "uv": 2, "depth": 1, "shading": 3}
    out = {"width": w, "height": h}
    for key, comp in comps.items():
        name = manifest["files"][key]
        buf = array("f")
        with open(os.path.join(path, name), "rb") as f:
            buf.fromfile(f, w * h * comp)
        if struct.pack("=f", 1.0) != struct.pack("<f", 1.0):
            buf.byteswap()
        out[key] = list(buf)
    return out


# ---------------------------------------------------------------------------
# One-call foundry: capture bundle -> distillation bundle.
# ---------------------------------------------------------------------------


def run_foundry(
    capture: dict,
    asset: str,
    seed: int,
    tex_w: int = 64,
    tex_h: int = 64,
    height_detail: Optional[List[float]] = None,
    provenance: Optional[dict] = None,
    src: Optional[dict] = None,
    src_style_seed: Optional[int] = None,
) -> dict:
    """Full offline pipeline. capture comes from load_gbuffer_bundle().

    src optionally carries the known source detail parameters when the
    input frame was rendered by the engine itself (see fit_detail):
    {"seed": [ox, oy], "scale": s, "octaves": o}. Without it the fit
    is a statistical approximation and the R^2 score says so.
    """
    w, h = capture["width"], capture["height"]
    accum, counts = splat_to_uv(
        capture["frame"], capture["uv"], capture["depth"],
        w, h, tex_w, tex_h,
    )
    # The shading G-buffer lives in screen space like the frame; splat it
    # with the same winner selection so the strip divides matching texels.
    shading_accum, _ = splat_to_uv(
        capture["shading"], capture["uv"], capture["depth"],
        w, h, tex_w, tex_h,
    )
    albedo, valid = strip_lighting(accum, shading_accum, counts)
    material, quality = fit_material(albedo, valid, tex_w, tex_h, seed,
                                     src=src)
    height_style = None
    if height_detail is not None:
        ws, herr = fit_height_style(height_detail, tex_w, tex_h, seed,
                                    src_style_seed=src_style_seed)
        # Record the height fit error alongside; it does not gate the pass.
        quality = dict(quality)
        quality["height_rmse"] = herr
    return make_bundle(
        asset=asset,
        seed=seed,
        material=material,
        quality=quality,
        height_style=height_style,
        provenance=provenance or {"teacher": "synthetic"},
    )
