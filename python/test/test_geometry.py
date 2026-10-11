"""Tests for the geometry reconstructor (python/xrgen/geometry.py).

All synthetic: pinhole-camera depth/normal buffers built analytically on
CPU, so everything runs with no GPU and no renderer. The foundry is
offline tooling; these tests prove its math, not any hardware.
"""
import json
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from xrgen.geometry import (
    GEOM_FORMAT,
    NORMAL_COS_PASS,
    fit_base_plane,
    fit_displacement,
    height_at,
    heightfield_normal,
    normal_agreement,
    reconstruct_geometry,
    unproject_points,
    validate_geometry_bundle,
)
from xrgen.inverse import PASS_COVERAGE, PASS_SCORE, detail_reference
from xrgen.rng import Rng


def _cam(w=16, h=16, fov_deg=60.0):
    return {
        "fovY": math.radians(fov_deg),
        "aspect": w / h,
        "pos": [0.0, 0.0, 0.0],
        "forward": [0.0, 0.0, -1.0],
        "up": [0.0, 1.0, 0.0],
    }


def _flat_capture(w=16, h=16, dist=5.0, tilt_deg=0.0):
    """Fronto-parallel (or Y-tilted) plane at distance dist. Returns
    (depth, normals) in foundry layout."""
    cam = _cam(w, h)
    tan_half = math.tan(cam["fovY"] / 2.0)
    a = math.radians(tilt_deg)
    n = (math.sin(a), 0.0, math.cos(a))  # plane normal (world)
    # Plane through P0=(0,0,-dist): t = dot(P0, n) / dot(dir, n).
    p0n = -dist * math.cos(a)
    depth, normals = [], []
    for j in range(h):
        y_ndc = 1.0 - 2.0 * (j + 0.5) / h
        for i in range(w):
            x_ndc = 2.0 * (i + 0.5) / w - 1.0
            d = (x_ndc * tan_half, y_ndc * tan_half, -1.0)
            l = math.sqrt(d[0] ** 2 + d[1] ** 2 + 1.0)
            d = (d[0] / l, d[1] / l, d[2] / l)
            dn = d[0] * n[0] + d[1] * n[1] + d[2] * n[2]
            t = p0n / dn
            depth.append(t)
            normals += [n[0], n[1], n[2]]
    return depth, normals


class TestUnproject(unittest.TestCase):
    def test_center_pixel_hits_plane_center(self):
        w = h = 15
        depth, normals = _flat_capture(w, h, dist=5.0)
        pts, pnrms = unproject_points(depth, normals, w, h, _cam(w, h))
        self.assertEqual(len(pts), w * h)
        c = pts[7 * w + 7]
        self.assertAlmostEqual(c[0], 0.0, places=9)
        self.assertAlmostEqual(c[1], 0.0, places=9)
        self.assertAlmostEqual(c[2], -5.0, places=9)
        self.assertAlmostEqual(pnrms[0][2], 1.0, places=12)

    def test_background_texels_skipped(self):
        w = h = 8
        depth, normals = _flat_capture(w, h)
        depth[0] = 0.0            # cleared background
        depth[1] = float("nan")   # corrupt texel
        normals[2 * 3] = normals[2 * 3 + 1] = normals[2 * 3 + 2] = 0.0
        pts, _ = unproject_points(depth, normals, w, h, _cam(w, h))
        self.assertEqual(len(pts), w * h - 3)

    def test_empty_raises_in_pipeline(self):
        w = h = 8
        with self.assertRaises(ValueError):
            reconstruct_geometry([0.0] * (w * h), [0.0] * (w * h * 3),
                                 w, h, _cam(w, h), seed=1)


class TestBasePlane(unittest.TestCase):
    def test_fronto_parallel(self):
        depth, normals = _flat_capture()
        pts, _ = unproject_points(depth, normals, 16, 16, _cam())
        plane = fit_base_plane(pts)
        self.assertEqual(plane["axis"], 2)
        self.assertLess(plane["plane_rmse"], 1e-6)
        nx, ny, nz = plane["normal"]
        self.assertAlmostEqual(abs(nz), 1.0, places=9)
        self.assertAlmostEqual(plane["origin"][2], -5.0, places=6)
        self.assertLess(max(abs(r) for r in plane["residuals"]), 1e-9)

    def test_steep_tilt_fits_exact_plane(self):
        depth, normals = _flat_capture(tilt_deg=65.0)
        pts, _ = unproject_points(depth, normals, 16, 16, _cam())
        plane = fit_base_plane(pts)
        # Either dominant axis describes the same plane; what matters is
        # the fit is exact and the normal is right.
        self.assertLess(plane["plane_rmse"], 1e-6)
        nx, ny, nz = plane["normal"]
        self.assertAlmostEqual(abs(nx), math.sin(math.radians(65.0)), places=6)
        self.assertAlmostEqual(abs(nz), math.cos(math.radians(65.0)), places=6)
        self.assertAlmostEqual(ny, 0.0, places=9)


class TestDisplacementFit(unittest.TestCase):
    def _known(self, n=64):
        rng = Rng(77)
        ox, oy = 3.7, 9.1
        scale, octaves = 16.0, 4
        weights = [rng.uniform(-0.4, 0.4) for _ in range(6)]
        bias = 0.05
        us = [rng.uniform(0, 10) for _ in range(n)]
        vs = [rng.uniform(0, 10) for _ in range(n)]
        # Ground truth lives in the fitter's normalized frame: the fit is
        # exact only when the data truly follows the model in that frame.
        u_min, u_max = min(us), max(us)
        v_min, v_max = min(vs), max(vs)
        res = [detail_reference((u - u_min) / (u_max - u_min),
                                (v - v_min) / (v_max - v_min),
                                ox, oy, scale, octaves, weights, bias)
               for u, v in zip(us, vs)]
        return us, vs, res, ox, oy, scale, octaves, weights, bias

    def test_known_params_recovered_exactly(self):
        us, vs, res, ox, oy, scale, octaves, weights, bias = self._known(64)
        params, mapping, rmse, r2 = fit_displacement(
            us, vs, res, seed=1,
            src={"seed": [ox, oy], "scale": scale, "octaves": octaves})
        self.assertGreater(r2, 1.0 - 1e-9)
        self.assertLess(rmse, 1e-9)
        # Only the active octaves are identifiable; inactive ones correctly
        # come back ~0 (they cannot affect the target by construction).
        for got, want in zip(params["weights"][:octaves], weights[:octaves]):
            self.assertAlmostEqual(got, want, places=9)
        for got in params["weights"][octaves:]:
            self.assertAlmostEqual(got, 0.0, places=9)
        self.assertAlmostEqual(params["bias"], bias, places=9)
        # Mapping round-trips through height_at.
        uu = (us[0] + us[1]) / 2
        vv = (vs[0] + vs[1]) / 2
        self.assertAlmostEqual(
            height_at(uu, vv, params, mapping),
            detail_reference((uu - mapping["uMin"]) /
                             (mapping["uMax"] - mapping["uMin"]),
                             (vv - mapping["vMin"]) /
                             (mapping["vMax"] - mapping["vMin"]),
                             ox, oy, scale, octaves, weights, bias),
            places=9)

    def test_flat_residual_scores_trivially_perfect(self):
        us = [float(i) for i in range(10)]
        vs = [float(i) for i in range(10)]
        params, mapping, rmse, r2 = fit_displacement(
            us, vs, [0.0] * 10, seed=1,
            src={"seed": [0, 0], "scale": 16.0, "octaves": 4})
        self.assertEqual(r2, 1.0)
        self.assertLess(rmse, 1e-9)

    def test_foreign_seed_reports_honest_low_r2(self):
        # Random smooth field the canonical seed cannot explain: the gate
        # must see a low score, never a silently confident fit.
        rng = Rng(913)
        us = [rng.uniform(0, 1) for _ in range(200)]
        vs = [rng.uniform(0, 1) for _ in range(200)]
        res = [math.sin(u * 40.0) * math.cos(v * 40.0) for u, v in zip(us, vs)]
        _, _, _, r2 = fit_displacement(us, vs, res, seed=1, src=None)
        self.assertLess(r2, PASS_SCORE)


class TestFullPipeline(unittest.TestCase):
    def _heightfield_capture(self, w=16, h=16):
        """Two-pass synthetic with known displacement, defined in the
        foundry's own plane-coordinate frame so the src contract is
        exact: pass 1 (flat) fixes the plane basis + mapping; pass 2
        ray-marches z = -5 + h(uu, vv) and builds analytic normals."""
        cam = _cam(w, h)
        flat_depth, flat_normals = _flat_capture(w, h, dist=5.0)
        pts, _ = unproject_points(flat_depth, flat_normals, w, h, cam)
        plane1 = fit_base_plane(pts)
        O, U, V = plane1["origin"], plane1["u"], plane1["v"]
        mapping = {
            "uMin": min(plane1["us"]), "uMax": max(plane1["us"]),
            "vMin": min(plane1["vs"]), "vMax": max(plane1["vs"]),
        }
        ox, oy, scale, octaves = 2.3, 7.9, 12.0, 3
        rng = Rng(4242)
        weights = [rng.uniform(-0.12, 0.12) for _ in range(6)]
        bias = 0.02
        params = {"seed": [ox, oy], "scale": scale, "octaves": octaves,
                  "weights": weights, "bias": bias}

        def h_uv(uu, vv):
            x01 = (uu - mapping["uMin"]) / (mapping["uMax"] - mapping["uMin"])
            y01 = (vv - mapping["vMin"]) / (mapping["vMax"] - mapping["vMin"])
            return detail_reference(x01, y01, ox, oy, scale, octaves,
                                    weights, bias)

        def h_world(x, y, z):
            dx, dy, dz = x - O[0], y - O[1], z - O[2]
            uu = dx * U[0] + dy * U[1] + dz * U[2]
            vv = dx * V[0] + dy * V[1] + dz * V[2]
            return h_uv(uu, vv)

        tan_half = math.tan(cam["fovY"] / 2.0)
        depth, normals = [], []
        for j in range(h):
            y_ndc = 1.0 - 2.0 * (j + 0.5) / h
            for i in range(w):
                x_ndc = 2.0 * (i + 0.5) / w - 1.0
                d = (x_ndc * tan_half, y_ndc * tan_half, -1.0)
                l = math.sqrt(d[0] ** 2 + d[1] ** 2 + 1.0)
                d = (d[0] / l, d[1] / l, d[2] / l)
                t = 5.0 / (-d[2])
                for _ in range(30):
                    x, y, z = t * d[0], t * d[1], t * d[2]
                    t = (5.0 - h_world(x, y, z)) / (-d[2])
                x, y, z = t * d[0], t * d[1], t * d[2]
                depth.append(t)
                e = 1e-4
                hx = (h_world(x + e, y, z) - h_world(x - e, y, z)) / (2 * e)
                hy = (h_world(x, y + e, z) - h_world(x, y - e, z)) / (2 * e)
                nl = math.sqrt(hx * hx + hy * hy + 1.0)
                normals += [-hx / nl, -hy / nl, 1.0 / nl]
        return depth, normals, cam, params, mapping

    def test_heightfield_passes(self):
        w = h = 16
        depth, normals, cam, src_params, src_mapping = self._heightfield_capture(w, h)
        src_params = dict(src_params, mapping=src_mapping)
        src = {"seed": src_params["seed"], "scale": src_params["scale"],
               "octaves": src_params["octaves"],
               "mapping": src_params["mapping"]}
        bundle = reconstruct_geometry(
            depth, normals, w, h, cam, seed=99, src=src)
        validate_geometry_bundle(bundle)
        q = bundle["quality"]
        self.assertTrue(q["passed"], f"quality: {q}")
        self.assertGreater(q["r2"], 0.95)
        self.assertGreater(q["normalAgreement"], 0.98)
        self.assertLess(q["plane_rmse"], 0.2)
        for got, want in zip(bundle["displacement"]["weights"][:3],
                             src_params["weights"][:3]):
            self.assertAlmostEqual(got, want, delta=0.02)
        # Deterministic: same seed, same bundle.
        again = reconstruct_geometry(
            depth, normals, w, h, cam, seed=99, src=src)
        self.assertEqual(json.dumps(bundle, sort_keys=True),
                         json.dumps(again, sort_keys=True))

    def test_flat_plane_passes_trivially(self):
        w = h = 12
        depth, normals = _flat_capture(w, h, dist=5.0)
        bundle = reconstruct_geometry(depth, normals, w, h, _cam(w, h),
                                      seed=5)
        q = bundle["quality"]
        self.assertTrue(q["passed"], f"quality: {q}")
        self.assertEqual(q["r2"], 1.0)
        self.assertGreater(q["normalAgreement"], 0.999)

    def test_noise_field_fails(self):
        w = h = 16
        rng = Rng(31337)
        depth = [5.0 + rng.uniform(-1.0, 1.0) for _ in range(w * h)]
        normals = []
        for _ in range(w * h):
            th, ph = rng.uniform(0, 6.283), rng.uniform(-1, 1)
            s = math.sqrt(1 - ph * ph)
            normals += [s * math.cos(th), s * math.sin(th), ph]
        bundle = reconstruct_geometry(depth, normals, w, h, _cam(w, h),
                                      seed=5)
        self.assertFalse(bundle["quality"]["passed"])
        self.assertLess(bundle["quality"]["r2"], PASS_SCORE)

    def test_scrambled_normals_fail_normal_gate(self):
        w = h = 12
        depth, normals = _flat_capture(w, h, dist=5.0)
        rng = Rng(777)
        bad = []
        for _ in range(w * h):
            th = rng.uniform(0, 6.283)
            bad += [math.cos(th), math.sin(th), 0.0]
        bundle = reconstruct_geometry(depth, bad, w, h, _cam(w, h), seed=5)
        q = bundle["quality"]
        self.assertFalse(q["passed"])
        self.assertLess(q["normalAgreement"], NORMAL_COS_PASS)

    def test_low_coverage_fails(self):
        w = h = 16
        depth, normals = _flat_capture(w, h, dist=5.0)
        # Keep only 10% of texels valid.
        for k in range(w * h):
            if k % 10 != 0:
                depth[k] = 0.0
        bundle = reconstruct_geometry(depth, normals, w, h, _cam(w, h),
                                      seed=5)
        self.assertFalse(bundle["quality"]["passed"])
        self.assertLess(bundle["quality"]["coverage"], PASS_COVERAGE)


class TestBundleValidation(unittest.TestCase):
    def _good(self):
        w = h = 8
        depth, normals = _flat_capture(w, h, dist=5.0)
        return reconstruct_geometry(depth, normals, w, h, _cam(w, h), seed=1)

    def test_round_trip(self):
        b = self._good()
        self.assertIs(validate_geometry_bundle(b), b)
        self.assertEqual(b["format"], GEOM_FORMAT)

    def test_malformed(self):
        b = self._good()
        del b["displacement"]
        with self.assertRaises(ValueError):
            validate_geometry_bundle(b)
        b2 = self._good()
        b2["format"] = "xr-geom/999"
        with self.assertRaises(ValueError):
            validate_geometry_bundle(b2)
        b3 = self._good()
        b3["quality"]["passed"] = "yes"
        with self.assertRaises(ValueError):
            validate_geometry_bundle(b3)


if __name__ == "__main__":
    unittest.main()
