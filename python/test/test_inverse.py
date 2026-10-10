"""Tests for the inverse-rendering foundry (python/xrgen/inverse.py).

All synthetic: checker G-buffers and known-parameter detail functions, so
everything runs on CPU with no GPU, no DLSS, and no renderer. The foundry
is offline tooling; these tests prove its math, not any hardware.
"""
import math
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from xrgen.inverse import (
    BUNDLE_FORMAT,
    coverage,
    detail_reference,
    fit_detail,
    fit_height_style,
    fit_material,
    fit_quality_score,
    load_gbuffer_bundle,
    make_bundle,
    run_foundry,
    save_gbuffer_bundle,
    splat_to_uv,
    srgb_to_linear,
    strip_lighting,
    texel_mean_color,
    validate_bundle,
)


def _checker_capture(w=8, h=8, tex_w=4, tex_h=4):
    """Synthetic capture: UV ramps linearly across the frame, depth is
    constant, frame is a UV-space checker so splat placement is checkable."""
    frame, uv, depth, shading = [], [], [], []
    for j in range(h):
        for i in range(w):
            u = (i + 0.5) / w
            v = (j + 0.5) / h
            # Checker in UV space: white where (floor(u*tex_w)+floor(v*tex_h)) even.
            on = ((int(u * tex_w) + int(v * tex_h)) % 2) == 0
            c = 0.9 if on else 0.1
            frame += [c, c, c]
            uv += [u, v]
            depth.append(5.0)
            shading += [0.8, 0.8, 0.8]
    return {
        "width": w, "height": h,
        "frame": frame, "uv": uv, "depth": depth, "shading": shading,
    }


class TestSplat(unittest.TestCase):
    def test_checker_lands_on_right_texels(self):
        cap = _checker_capture()
        accum, counts = splat_to_uv(
            cap["frame"], cap["uv"], cap["depth"],
            cap["width"], cap["height"], 4, 4)
        self.assertEqual(len(counts), 16)
        self.assertAlmostEqual(coverage(counts), 1.0)
        # Texel (0,0) covers u in [0,.25), v in [0,.25): checker says white.
        self.assertGreater(accum[0], 0.5)
        # Texel (1,0): u in [.25,.5): checker says black.
        self.assertLess(accum[3], 0.5)

    def test_nearest_depth_wins(self):
        # Two pixels, same UV, different depth: nearer (smaller) wins.
        w = h = 2
        frame = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
                 0.0, 0.0, 1.0, 1.0, 1.0, 1.0]
        uv = [0.5, 0.5] * 4
        depth = [2.0, 1.0, 3.0, 4.0]
        accum, counts = splat_to_uv(frame, uv, depth, w, h, 1, 1)
        # Pixel 1 (green, depth 1.0) is nearest.
        self.assertEqual(counts[0], 1)
        self.assertAlmostEqual(accum[0], 0.0)
        self.assertAlmostEqual(accum[1], 1.0)
        self.assertAlmostEqual(accum[2], 0.0)

    def test_uv_outside_range_ignored(self):
        frame = [1.0, 1.0, 1.0]
        uv = [1.5, -0.2]
        depth = [1.0]
        _, counts = splat_to_uv(frame, uv, depth, 1, 1, 4, 4)
        self.assertAlmostEqual(coverage(counts), 0.0)

    def test_mean_color(self):
        accum = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
        r, g, b = texel_mean_color(accum, [1, 1])
        self.assertAlmostEqual(r, 0.5)
        self.assertAlmostEqual(g, 0.5)
        self.assertAlmostEqual(b, 0.0)


class TestLightingStrip(unittest.TestCase):
    def test_albedo_recovery(self):
        # observed = albedo * shading -> strip must return albedo.
        albedo_true = [0.6, 0.3, 0.15]
        shading = [0.8, 0.8, 0.8]
        observed = [a * s for a, s in zip(albedo_true, shading)]
        alb, valid = strip_lighting(observed, shading, [1])
        self.assertTrue(valid[0])
        for got, want in zip(alb, albedo_true):
            self.assertAlmostEqual(got, want, places=9)

    def test_near_black_shading_flagged(self):
        observed = [0.5, 0.5, 0.5]
        shading = [1e-6, 0.8, 0.8]
        alb, valid = strip_lighting(observed, shading, [1])
        self.assertFalse(valid[0], "near-zero shading must not divide")

    def test_unlit_shading_is_identity(self):
        observed = [0.4, 0.5, 0.6]
        shading = [1.0, 1.0, 1.0]
        alb, valid = strip_lighting(observed, shading, [1])
        self.assertTrue(valid[0])
        for got, want in zip(alb, observed):
            self.assertAlmostEqual(got, want, places=9)

    def test_srgb_to_linear_endpoints(self):
        self.assertAlmostEqual(srgb_to_linear(0.0), 0.0)
        self.assertAlmostEqual(srgb_to_linear(1.0), 1.0, places=9)
        self.assertLess(srgb_to_linear(0.5), 0.5)


class TestDetailReference(unittest.TestCase):
    def test_deterministic(self):
        kw = dict(seed_ox=3.0, seed_oy=-7.0, scale=24.0, octaves=4,
                  weights=[0.5, 0.25, 0.125, 0.0625, 0.0, 0.0], bias=1.0)
        a = detail_reference(0.31, 0.77, **kw)
        b = detail_reference(0.31, 0.77, **kw)
        self.assertEqual(a, b)

    def test_bias_only_is_flat(self):
        v1 = detail_reference(0.1, 0.2, 0.0, 0.0, 24.0, 4,
                              [0.0] * 6, 1.0)
        v2 = detail_reference(0.9, 0.8, 0.0, 0.0, 24.0, 4,
                              [0.0] * 6, 1.0)
        self.assertAlmostEqual(v1, 1.0)
        self.assertAlmostEqual(v2, 1.0)

    def test_varies_spatially(self):
        kw = dict(seed_ox=1.0, seed_oy=2.0, scale=24.0, octaves=4,
                  weights=[0.5, 0.25, 0.125, 0.0625, 0.0, 0.0], bias=1.0)
        vals = [detail_reference(i / 16.0, 0.5, **kw) for i in range(16)]
        self.assertGreater(max(vals) - min(vals), 1e-3)


def _synthetic_albedo(tex_w=16, tex_h=16, seed=777):
    """Albedo generated from KNOWN detail params, so the fitter has a
    ground truth to recover."""
    params = {
        "seed": [11.0, -23.0],
        "scale": 24.0,
        "octaves": 4,
        "weights": [0.45, 0.3, 0.15, 0.1, 0.0, 0.0],
        "bias": 1.0,
    }
    base = (0.55, 0.35, 0.2)
    albedo, valid = [], []
    for tj in range(tex_h):
        v = (tj + 0.5) / tex_h
        for ti in range(tex_w):
            u = (ti + 0.5) / tex_w
            d = detail_reference(u, v, params["seed"][0], params["seed"][1],
                                 params["scale"], params["octaves"],
                                 params["weights"], params["bias"])
            albedo += [base[0] * d, base[1] * d, base[2] * d]
            valid.append(True)
    return albedo, valid, base, params


class TestFitter(unittest.TestCase):
    def test_fit_recovers_known_params(self):
        # The real loop: the frame was rendered by the engine itself,
        # so the source detail params are KNOWN. Least squares against
        # the true basis must recover them near-exactly.
        albedo, valid, base, params = _synthetic_albedo()
        src = {"seed": params["seed"], "scale": params["scale"],
               "octaves": params["octaves"]}
        material, quality = fit_material(albedo, valid, 16, 16, seed=4242,
                                         src=src)
        # Base color is defined as the mean albedo color.
        mean_r = sum(albedo[0::3]) / 256
        self.assertAlmostEqual(material["baseColor"][0], mean_r, places=9)
        # Near-perfect fit on the true basis.
        self.assertGreater(quality["score"], 0.99)
        self.assertTrue(quality["passed"])
        # Weights match ground truth up to the (base, bias, weights)
        # scale ambiguity: target is normalized by mean detail, so each
        # weight is scaled by one constant factor. Ratios must agree.
        got_w = material["detail"]["weights"]
        ratios = [g / w for g, w in zip(got_w[:4], params["weights"][:4])]
        for r in ratios:
            self.assertAlmostEqual(r, ratios[0], delta=1e-6)
        self.assertAlmostEqual(material["detail"]["bias"],
                               ratios[0], delta=1e-3)
        # Reconstruction through the reference function matches.
        d = material["detail"]
        err = 0.0
        n = 0
        for tj in range(16):
            v = (tj + 0.5) / 16
            for ti in range(16):
                u = (ti + 0.5) / 16
                t = tj * 16 + ti
                m = detail_reference(u, v, d["seed"][0], d["seed"][1],
                                     d["scale"], d["octaves"],
                                     d["weights"], d["bias"])
                for k in range(3):
                    err += (material["baseColor"][k] * m
                            - albedo[t * 3 + k]) ** 2
                    n += 1
        self.assertLess(math.sqrt(err / n), 1e-6)

    def test_foreign_input_scored_honestly(self):
        # No source params (foreign input): the fitter uses a canonical
        # seed and the R^2 score must report the mismatch honestly
        # instead of pretending the random seed was "discovered".
        albedo, valid, _, _ = _synthetic_albedo()
        _, quality = fit_material(albedo, valid, 16, 16, seed=4242,
                                  src=None)
        self.assertLess(quality["score"], 0.5,
                        "unknown seed cannot be fit; score must say so")
        self.assertFalse(quality["passed"])

    def test_flat_map_scores_zero(self):
        albedo = [0.5, 0.5, 0.5] * 64
        valid = [True] * 64
        material, quality = fit_material(albedo, valid, 8, 8, seed=1)
        self.assertEqual(quality["score"], 0.0)
        self.assertFalse(quality["passed"])

    def test_hard_edges_flagged(self):
        # A painted logo (hard step edge) is not fittable noise: the
        # fitter must report low quality, not silently ship.
        albedo, valid = [], []
        for tj in range(16):
            for ti in range(16):
                on = ti >= 8
                c = 0.9 if on else 0.1
                albedo += [c, c, c]
                valid.append(True)
        _, quality = fit_material(albedo, valid, 16, 16, seed=9)
        self.assertFalse(quality["passed"],
                         f"hard edges must not pass, score={quality['score']}")

    def test_fit_deterministic(self):
        albedo, valid, _, base_params = _synthetic_albedo()
        src = {"seed": base_params["seed"], "scale": base_params["scale"],
               "octaves": base_params["octaves"]}
        m1, _ = fit_material(albedo, valid, 16, 16, seed=31337, src=src)
        m2, _ = fit_material(albedo, valid, 16, 16, seed=31337, src=src)
        self.assertEqual(m1, m2)

    def test_quality_score_bounds(self):
        self.assertEqual(fit_quality_score(0.0, 0.0, 1.0), 0.0)
        self.assertAlmostEqual(fit_quality_score(0.0, 1.0, 1.0), 1.0)
        s = fit_quality_score(0.5, 1.0, 1.0)
        self.assertTrue(0.0 <= s <= 1.0)

    def test_height_style_fit(self):
        # Synthetic height detail from a known style seed: search should
        # find a good fit (score by rmse, not seed equality).
        from xrgen.ml import make_style_weights, stylize_forward
        w, h = 12, 12
        truth = make_style_weights(20261010)
        detail = []
        for j in range(h):
            v = j / (h - 1)
            for i in range(w):
                u = i / (w - 1)
                detail.append(stylize_forward([0.5, u, v], truth))
        ws, err = fit_height_style(detail, w, h, seed=555, candidates=24)
        self.assertEqual(ws["arch"], [3, 6, 1])
        data_range = max(detail) - min(detail)
        self.assertLess(err / data_range, 0.25)

    def test_height_style_known_seed_reproduces(self):
        # Engine-rendered input: the style seed is known, so the
        # weights must come back exactly (verification mode).
        from xrgen.ml import make_style_weights, stylize_forward
        w, h = 12, 12
        truth = make_style_weights(20261010)
        detail = []
        for j in range(h):
            v = j / (h - 1)
            for i in range(w):
                u = i / (w - 1)
                detail.append(stylize_forward([0.5, u, v], truth))
        ws, err = fit_height_style(detail, w, h, seed=555,
                                   src_style_seed=20261010)
        self.assertEqual(ws["w1"], truth["w1"])
        self.assertEqual(ws["w2"], truth["w2"])


class TestBundle(unittest.TestCase):
    def _good_bundle(self):
        albedo, valid, _, _ = _synthetic_albedo(tex_w=8, tex_h=8)
        material, quality = fit_material(albedo, valid, 8, 8, seed=7)
        return make_bundle("test-mat", 7, material, quality,
                           provenance={"teacher": "synthetic"})

    def test_roundtrip_validates(self):
        doc = self._good_bundle()
        self.assertEqual(validate_bundle(doc)["format"], BUNDLE_FORMAT)

    def test_missing_key_rejected(self):
        doc = self._good_bundle()
        del doc["material"]
        with self.assertRaises(ValueError):
            validate_bundle(doc)

    def test_bad_basecolor_rejected(self):
        doc = self._good_bundle()
        doc["material"]["baseColor"] = [2.0, 0.0, 0.0]
        with self.assertRaises(ValueError):
            validate_bundle(doc)

    def test_bad_weights_rejected(self):
        doc = self._good_bundle()
        doc["material"]["detail"]["weights"] = [0.1] * 5
        with self.assertRaises(ValueError):
            validate_bundle(doc)

    def test_failed_fit_still_validates(self):
        # A flagged bundle is a valid document: failure is recorded,
        # not hidden.
        albedo = [0.5, 0.5, 0.5] * 64
        valid = [True] * 64
        material, quality = fit_material(albedo, valid, 8, 8, seed=1)
        self.assertFalse(quality["passed"])
        doc = make_bundle("flat-mat", 1, material, quality)
        validate_bundle(doc)
        self.assertFalse(doc["quality"]["passed"])

    def test_gbuffer_bundle_io_roundtrip(self):
        cap = _checker_capture()
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "cap")
            save_gbuffer_bundle(p, cap["width"], cap["height"], cap["frame"],
                                cap["uv"], cap["depth"], cap["shading"])
            back = load_gbuffer_bundle(p)
        self.assertEqual(back["width"], cap["width"])
        for key in ("frame", "uv", "depth", "shading"):
            self.assertEqual(len(back[key]), len(cap[key]))
            for a, b in zip(back[key], cap[key]):
                self.assertAlmostEqual(a, b, places=5)

    def test_run_foundry_end_to_end(self):
        cap = _checker_capture()
        doc = run_foundry(cap, "checker-mat", seed=99, tex_w=4, tex_h=4)
        validate_bundle(doc)
        self.assertEqual(doc["asset"], "checker-mat")
        self.assertIn("score", doc["quality"])
        # Checker is hard edges: must be flagged, not passed.
        self.assertFalse(doc["quality"]["passed"])


if __name__ == "__main__":
    unittest.main()
