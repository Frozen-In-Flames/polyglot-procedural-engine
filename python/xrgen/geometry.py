"""Geometry reconstruction: the other half of the inverse-rendering foundry.

V3's inverse.py distills MATERIALS/surface detail (albedo) from frames.
This module distills GEOMETRY: from depth + normal G-buffers it fits a
procedural heightfield -- a base plane plus a displacement function --
using the engine's own canonical detail math.

Pipeline (all stdlib-only, deterministic, float64):
  1. unproject_points -- depth texels -> world-space points (pinhole camera).
  2. fit_base_plane -- least-squares plane, trying all three dominant axes
     and keeping the smallest perpendicular RMSE (not R^2, which is
     degenerate for high-frequency displacement over a plane). Points
     become (u, v) plane coords + signed residuals.
  3. fit_displacement -- fit the canonical fbm-hhash detail function
     (inverse._dnoise, the SAME function the material distiller fits and
     the GLSL/TS mirrors evaluate) to the residuals by exact least
     squares. Like fit_detail: when the frame was rendered by the engine
     itself, the source (seed, scale, octaves) are KNOWN and passed via
     src; otherwise a canonical seed is tried and the R^2 score reports
     the truth (statistical approximation only). src may also carry the
     authoring-time coordinate mapping -- the noise basis is frame
     sensitive, so a known mapping must be used instead of the bbox
     observed from this capture.
  4. Quality gate -- R^2 on the displacement fit, normal agreement
     (analytic normals of the fitted heightfield vs measured normals),
     and coverage. Bad fits are marked failed, never silently shipped.

The displacement evaluator needs no new runtime mirror: it IS the
already-mirrored fbm-hhash detail function (Python detail_reference <->
TS distillDetail <-> GLSL xg_distill, bit-exact per INVERSE.md). The
bundle carries the plane frame + mapping so the runtime can evaluate
h(u, v) with the existing mirrors. Unprojection and plane fitting are
foundry-only, like splat_to_uv -- they never ship to the player.
"""
import math
from typing import Dict, List, Optional, Tuple

from .inverse import (
    MAX_OCTAVES,
    PASS_COVERAGE,
    PASS_SCORE,
    _design_row,
    _dnoise,
    _r2_score,
    _rmse,
    _solve_least_squares,
    coverage,
    detail_reference,
)

GEOM_FORMAT = "xr-geom/1"
GEOM_KIND = "heightfield-fbm-hhash"
# Median |cos| between fitted-analytic and measured normals required to pass.
NORMAL_COS_PASS = 0.95
# Below this residual range the surface is declared exactly planar; the
# displacement fit is then trivially perfect (R^2 would 0/0 otherwise).
FLAT_RESIDUAL_EPS = 1e-9


# ---------------------------------------------------------------------------
# Step 1: unproject depth texels to world-space points.
#
# Layouts match the foundry conventions (flat row-major):
#   depth   : [d] * (w * h), view depth = length(worldPos - camPos).
#             Texels with depth <= 0 or non-finite are background (the GL
#             path clears to 0) and are skipped.
#   normals : [x, y, z] * (w * h), world-space unit normals from the
#             G-buffer. Zero-length normals mark background.
#   cam     : {"fovY" (radians), "aspect", "pos", "forward", "up"}.
# Row 0 of the buffers is the TOP row of the frame.
# ---------------------------------------------------------------------------


def _norm3(v: Tuple[float, float, float]) -> Tuple[float, float, float]:
    l = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    if l < 1e-12:
        return (0.0, 0.0, 0.0)
    return (v[0] / l, v[1] / l, v[2] / l)


def _cross(a: Tuple[float, float, float],
           b: Tuple[float, float, float]) -> Tuple[float, float, float]:
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _dot(a: Tuple[float, float, float],
         b: Tuple[float, float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def unproject_points(
    depth: List[float],
    normals: List[float],
    w: int,
    h: int,
    cam: dict,
) -> Tuple[List[Tuple[float, float, float]],
           List[Tuple[float, float, float]]]:
    """Unproject valid texels. Returns (points, point_normals), world space."""
    if len(depth) != w * h:
        raise ValueError("depth size must equal w*h")
    if len(normals) != w * h * 3:
        raise ValueError("normals size must equal w*h*3")
    f = _norm3((cam["forward"][0], cam["forward"][1], cam["forward"][2]))
    up = (cam["up"][0], cam["up"][1], cam["up"][2])
    r = _norm3(_cross(f, up))
    u = _cross(r, f)
    pos = (cam["pos"][0], cam["pos"][1], cam["pos"][2])
    tan_half = math.tan(cam["fovY"] / 2.0)
    aspect = cam["aspect"]
    points: List[Tuple[float, float, float]] = []
    pnorms: List[Tuple[float, float, float]] = []
    for j in range(h):
        y_ndc = 1.0 - 2.0 * (j + 0.5) / h
        for i in range(w):
            p = j * w + i
            d = depth[p]
            if not math.isfinite(d) or d <= 0.0:
                continue
            nx = normals[p * 3]
            ny = normals[p * 3 + 1]
            nz = normals[p * 3 + 2]
            nl = math.sqrt(nx * nx + ny * ny + nz * nz)
            if nl < 0.5:
                continue
            x_ndc = 2.0 * (i + 0.5) / w - 1.0
            dx = x_ndc * tan_half * aspect
            dy = y_ndc * tan_half
            dir_w = _norm3((r[0] * dx + u[0] * dy + f[0],
                            r[1] * dx + u[1] * dy + f[1],
                            r[2] * dx + u[2] * dy + f[2]))
            points.append((pos[0] + dir_w[0] * d,
                           pos[1] + dir_w[1] * d,
                           pos[2] + dir_w[2] * d))
            pnorms.append((nx / nl, ny / nl, nz / nl))
    return points, pnorms


# ---------------------------------------------------------------------------
# Step 2: base plane. Fit coordinate k as a linear function of the other
# two, trying k = 0, 1, 2, and keep the axis with the best R^2. Returns the
# plane frame plus per-point (u, v, residual).
# ---------------------------------------------------------------------------


def fit_base_plane(
    points: List[Tuple[float, float, float]],
) -> dict:
    """Fit the dominant plane. Tries expressing each coordinate as a
    linear function of the other two and keeps the axis with the smallest
    perpendicular RMSE (not R^2: a high-frequency displacement over a
    plane has ~zero linear R^2 on every axis, which would make R^2-based
    selection arbitrary). Returns the plane frame plus per-point (u, v)
    coords and signed residuals."""
    if len(points) < 3:
        raise ValueError("fit_base_plane: need at least 3 points")
    best = None  # (perp_rmse, k, a, b, c)
    for k in (0, 1, 2):
        ax = (k + 1) % 3
        bx = (k + 2) % 3
        rows = [[p[ax], p[bx], 1.0] for p in points]
        targets = [p[k] for p in points]
        a, b, c = _solve_least_squares(rows, targets)
        inv = 1.0 / math.sqrt(a * a + b * b + 1.0)
        se = 0.0
        for p in points:
            r = (p[k] - (a * p[ax] + b * p[bx] + c)) * inv
            se += r * r
        rmse = math.sqrt(se / len(points))
        if best is None or rmse < best[0]:
            best = (rmse, k, a, b, c)
    assert best is not None
    rmse, k, a, b, c = best
    n = len(points)
    cx = sum(p[0] for p in points) / n
    cy = sum(p[1] for p in points) / n
    cz = sum(p[2] for p in points) / n
    # Plane: x_k = a*x_ax + b*x_bx + c  ->  normal (-a, -b, 1) in (ax,bx,k).
    nvec = [0.0, 0.0, 0.0]
    nvec[(k + 1) % 3] = -a
    nvec[(k + 2) % 3] = -b
    nvec[k] = 1.0
    normal = _norm3((nvec[0], nvec[1], nvec[2]))
    origin = (cx, cy, cz)
    # Deterministic in-plane basis.
    t = (0.0, 1.0, 0.0) if abs(normal[1]) < 0.9 else (1.0, 0.0, 0.0)
    u = _norm3(_cross(normal, t))
    v = _cross(normal, u)
    us, vs, residuals = [], [], []
    for p in points:
        d = (p[0] - cx, p[1] - cy, p[2] - cz)
        us.append(_dot(d, u))
        vs.append(_dot(d, v))
        residuals.append(_dot(d, normal))
    return {
        "origin": [cx, cy, cz],
        "u": [u[0], u[1], u[2]],
        "v": [v[0], v[1], v[2]],
        "normal": [normal[0], normal[1], normal[2]],
        "axis": k,
        "plane_rmse": rmse,
        "us": us,
        "vs": vs,
        "residuals": residuals,
    }


# ---------------------------------------------------------------------------
# Step 3: displacement fit. Residuals are normalized to [0, 1]^2 over the
# observed bbox (recorded in the bundle as the mapping), then the canonical
# fbm-hhash detail function is fit by exact least squares -- the same
# candidate logic as inverse.fit_detail: known src params when the frame
# was rendered by the engine, canonical seed + discrete scales otherwise.
# ---------------------------------------------------------------------------


def _r2_or_trivial(pred: List[float], target: List[float]) -> float:
    """R^2, except a truly flat target fit to ~zero error scores 1.0
    (plain R^2 is 0/0 there). A flat target fit badly still scores 0."""
    data_range = max(target) - min(target) if target else 0.0
    if data_range < FLAT_RESIDUAL_EPS:
        rmse = _rmse(pred, target)
        return 1.0 if rmse < FLAT_RESIDUAL_EPS else 0.0
    return _r2_score(pred, target)


def fit_displacement(
    us: List[float],
    vs: List[float],
    residuals: List[float],
    seed: int,
    src: Optional[dict] = None,
) -> Tuple[dict, dict, float, float]:
    """Fit h(u, v) = bias + sum_k w_k * dnoise(...).

    Returns (params, mapping, rmse, r2). params matches the material
    distiller's detail dict so the same runtime mirrors evaluate it.
    mapping maps plane coords -> [0, 1]^2 and is stored in the bundle.
    Deterministic for the seed."""
    if not residuals:
        raise ValueError("fit_displacement: no points to fit")
    if not (len(us) == len(vs) == len(residuals)):
        raise ValueError("fit_displacement: mismatched input lengths")
    # The coordinate frame matters: the noise basis is highly sensitive to
    # it, so when the source mapping is KNOWN (engine-rendered input, src
    # carries the authoring-time bbox) we must evaluate the basis in that
    # frame, not in the bbox observed from this capture. Without it we fall
    # back to the observed bbox and the R^2 score reports the mismatch
    # honestly.
    if src is not None and src.get("mapping") is not None:
        m = src["mapping"]
        u_min, u_max = float(m["uMin"]), float(m["uMax"])
        v_min, v_max = float(m["vMin"]), float(m["vMax"])
    else:
        u_min, u_max = min(us), max(us)
        v_min, v_max = min(vs), max(vs)
    u_span = u_max - u_min if u_max > u_min else 1.0
    v_span = v_max - v_min if v_max > v_min else 1.0
    mapping = {"uMin": u_min, "uMax": u_max, "vMin": v_min, "vMax": v_max}
    u01 = [(x - u_min) / u_span for x in us]
    v01 = [(y - v_min) / v_span for y in vs]

    if src is not None:
        candidates = [(
            float(src["seed"][0]), float(src["seed"][1]),
            float(src["scale"]), int(src["octaves"]),
        )]
    else:
        candidates = [(0.0, 0.0, s, 4)
                      for s in (8.0, 16.0, 24.0, 32.0, 48.0)]
    best = None  # (r2, rmse, params)
    for seed_ox, seed_oy, scale, octaves in candidates:
        rows = [_design_row(x, y, seed_ox, seed_oy, scale, octaves)
                for x, y in zip(u01, v01)]
        w = _solve_least_squares(rows, residuals)
        pred = [sum(rw * x for rw, x in zip(row, w)) for row in rows]
        err = _rmse(pred, residuals)
        r2 = _r2_or_trivial(pred, residuals)
        if best is None or r2 > best[0]:
            best = (r2, err, {
                "seed": [seed_ox, seed_oy],
                "scale": scale,
                "octaves": octaves,
                "weights": w[:6],
                "bias": w[6],
            })
    assert best is not None
    r2, err, params = best
    return params, mapping, err, r2


def height_at(
    uu: float, vv: float, params: dict, mapping: dict,
) -> float:
    """Evaluate the fitted displacement at plane coords (uu, vv)."""
    u_span = mapping["uMax"] - mapping["uMin"] or 1.0
    v_span = mapping["vMax"] - mapping["vMin"] or 1.0
    x = (uu - mapping["uMin"]) / u_span
    y = (vv - mapping["vMin"]) / v_span
    return detail_reference(
        x, y,
        params["seed"][0], params["seed"][1],
        params["scale"], params["octaves"],
        params["weights"], params["bias"],
    )


def heightfield_normal(
    uu: float, vv: float, plane: dict, params: dict, mapping: dict,
    eps: float = 1e-4,
) -> Tuple[float, float, float]:
    """Analytic-ish normal of the fitted heightfield at (uu, vv):
    S(u,v) = O + u*U + v*V + h(u,v)*N; n = normalize(dS/du x dS/dv).
    Derivatives by central differences (the value-noise lattice has no
    cheap closed form, and the foundry is offline)."""
    U = (plane["u"][0], plane["u"][1], plane["u"][2])
    V = (plane["v"][0], plane["v"][1], plane["v"][2])
    N = (plane["normal"][0], plane["normal"][1], plane["normal"][2])
    h0 = height_at(uu, vv, params, mapping)
    hu = (height_at(uu + eps, vv, params, mapping)
          - height_at(uu - eps, vv, params, mapping)) / (2 * eps)
    hv = (height_at(uu, vv + eps, params, mapping)
          - height_at(uu, vv - eps, params, mapping)) / (2 * eps)
    _ = h0
    tu = (U[0] + hu * N[0], U[1] + hu * N[1], U[2] + hu * N[2])
    tv = (V[0] + hv * N[0], V[1] + hv * N[1], V[2] + hv * N[2])
    return _norm3(_cross(tu, tv))


def normal_agreement(
    plane: dict,
    params: dict,
    mapping: dict,
    us: List[float],
    vs: List[float],
    measured: List[Tuple[float, float, float]],
) -> float:
    """Median |cos| between fitted heightfield normals and measured
    G-buffer normals. Absolute value: the plane fit cannot know which
    side of the surface the authoring tool called 'front'."""
    coss = []
    for uu, vv, m in zip(us, vs, measured):
        fn = heightfield_normal(uu, vv, plane, params, mapping)
        coss.append(abs(_dot(fn, m)))
    coss.sort()
    mid = len(coss) // 2
    if len(coss) % 2 == 1:
        return coss[mid]
    return 0.5 * (coss[mid - 1] + coss[mid])


# ---------------------------------------------------------------------------
# Step 4: one-call pipeline + bundle I/O. Mirrors run_foundry's honesty
# contract: quality['passed'] is recorded verbatim; failed fits ship as
# flagged documents, never silently.
# ---------------------------------------------------------------------------


def reconstruct_geometry(
    depth: List[float],
    normals: List[float],
    w: int,
    h: int,
    cam: dict,
    seed: int,
    src: Optional[dict] = None,
) -> dict:
    """Full offline geometry pipeline. Returns the geometry bundle dict
    (not yet JSON-serialized). Raises ValueError when there is nothing
    to fit."""
    points, pnorms = unproject_points(depth, normals, w, h, cam)
    if not points:
        raise ValueError("reconstruct_geometry: no valid depth texels")
    plane = fit_base_plane(points)
    params, mapping, rmse, r2 = fit_displacement(
        plane["us"], plane["vs"], plane["residuals"], seed, src=src)
    nagree = normal_agreement(
        plane, params, mapping, plane["us"], plane["vs"], pnorms)
    cov = len(points) / (w * h)
    quality = {
        "plane_rmse": plane["plane_rmse"],
        "r2": r2,
        "rmse": rmse,
        "normalAgreement": nagree,
        "coverage": cov,
    }
    quality["passed"] = (
        quality["r2"] >= PASS_SCORE
        and cov >= PASS_COVERAGE
        and nagree >= NORMAL_COS_PASS
    )
    return {
        "format": GEOM_FORMAT,
        "kind": GEOM_KIND,
        "plane": {
            "origin": plane["origin"],
            "u": plane["u"],
            "v": plane["v"],
            "normal": plane["normal"],
        },
        "mapping": mapping,
        "displacement": {
            "seed": params["seed"],
            "scale": params["scale"],
            "octaves": params["octaves"],
            "weights": params["weights"],
            "bias": params["bias"],
        },
        "quality": quality,
    }


def validate_geometry_bundle(doc: dict) -> dict:
    """Schema + range check. Raises ValueError on anything malformed."""
    if not isinstance(doc, dict):
        raise ValueError("bundle must be an object")
    for key in ("format", "kind", "plane", "mapping", "displacement",
                "quality"):
        if key not in doc:
            raise ValueError(f"bundle missing required key: {key}")
    if doc["format"] != GEOM_FORMAT:
        raise ValueError(f"unknown geometry bundle format: {doc['format']}")
    if doc["kind"] != GEOM_KIND:
        raise ValueError(f"unknown geometry kind: {doc['kind']!r}")
    for key in ("origin", "u", "v", "normal"):
        v = doc["plane"].get(key)
        if not (isinstance(v, list) and len(v) == 3
                and all(isinstance(x, (int, float)) and math.isfinite(x)
                        for x in v)):
            raise ValueError(f"plane.{key} must be 3 finite numbers")
    for key in ("uMin", "uMax", "vMin", "vMax"):
        if not isinstance(doc["mapping"].get(key), (int, float)):
            raise ValueError(f"mapping.{key} must be a number")
    disp = doc["displacement"]
    if not (isinstance(disp.get("weights"), list)
            and len(disp["weights"]) == MAX_OCTAVES
            and all(isinstance(x, (int, float)) and math.isfinite(x)
                    for x in disp["weights"])):
        raise ValueError("displacement.weights must be 6 finite numbers")
    if not (isinstance(disp.get("octaves"), int)
            and 1 <= disp["octaves"] <= MAX_OCTAVES):
        raise ValueError("displacement.octaves must be an int in 1..6")
    q = doc["quality"]
    for key in ("r2", "coverage", "normalAgreement"):
        v = q.get(key)
        if not (isinstance(v, (int, float)) and 0.0 <= v <= 1.0):
            raise ValueError(f"quality.{key} must be in [0, 1]")
    if not isinstance(q.get("passed"), bool):
        raise ValueError("quality.passed must be a bool")
    return doc
