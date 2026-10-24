"""Identity tests for the vecmath oracle port (python/xrgen/vecmath.py).

This suite mirrors test/vecmath.test.ts on the TypeScript side: the
SAME fixed battery, the SAME hand-worked expected values, the SAME
negative controls. Both suites passing on the same numbers is the
cross-language parity check, in the repo's established pattern.
"""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from xrgen.vecmath import (
    clamp,
    clamp3,
    clamp3v,
    cross3,
    distance3,
    dot3,
    len3,
    length_squared3,
    lerp,
    lerp3,
    norm3,
    reflect3,
    sub3,
)

EPS = 1e-12


def _neg(a):
    return (-a[0], -a[1], -a[2])


# Fixed battery, mirrored in test/vecmath.test.ts. Expected values
# are worked from the formulas by hand, not from the code.
BATTERY = [
    # (a, b, dot, cross, lenSqA, dist)
    ((1, 0, 0), (0, 1, 0), 0, (0, 0, 1), 1, math.sqrt(2)),
    ((1, 2, 3), (4, 5, 6), 32, (-3, 6, -3), 14, math.sqrt(27)),
    ((3, 4, 0), (0, 0, 5), 0, (20, -15, 0), 25, math.sqrt(50)),
    ((-1.5, 2.25, 0.75), (0.5, -4, 2), -8.25, (7.5, 3.375, 4.875),
     7.875, math.sqrt(44.625)),
    ((0, 0, 0), (1, 1, 1), 0, (0, 0, 0), 0, math.sqrt(3)),
    ((2, -3, 6), (-7, 8, -9), -92, (-21, -24, -5), 49, math.sqrt(427)),
    ((0.1, 0.2, 0.3), (0.4, 0.5, 0.6), 0.32, (-0.03, 0.06, -0.03),
     0.14, math.sqrt(0.27)),
]


class VecmathTest(unittest.TestCase):
    def assertVecNear(self, a, b, eps=EPS):
        for x, y in zip(a, b):
            self.assertAlmostEqual(x, y, delta=eps)

    def test_battery_matches_hand_worked_values(self):
        for a, b, dot, cross, len_sq_a, dist in BATTERY:
            self.assertAlmostEqual(dot3(a, b), dot, delta=1e-9)
            self.assertVecNear(cross3(a, b), cross, 1e-9)
            self.assertAlmostEqual(length_squared3(a), len_sq_a, delta=1e-9)
            self.assertAlmostEqual(distance3(a, b), dist, delta=1e-9)

    def test_dot_orthogonal_is_zero(self):
        self.assertEqual(dot3((1, 0, 0), (0, 1, 0)), 0)
        self.assertEqual(dot3((3, 4, 0), (0, 0, 5)), 0)
        self.assertEqual(dot3((1, 1, 0), (1, -1, 0)), 0)

    def test_dot_negation_flips_sign_negative_control(self):
        for a, b, *_ in BATTERY:
            d = dot3(a, b)
            self.assertAlmostEqual(dot3(a, _neg(b)), -d, delta=EPS)
            self.assertAlmostEqual(dot3(_neg(a), b), -d, delta=EPS)
            if d != 0:
                self.assertNotEqual(dot3(a, _neg(b)), d)

    def test_dot_self_is_length_squared(self):
        for a, *_ in BATTERY:
            self.assertEqual(dot3(a, a), length_squared3(a))
            self.assertAlmostEqual(len3(a), math.sqrt(length_squared3(a)),
                                   delta=EPS)
        self.assertEqual(len3((3, 4, 0)), 5)
        self.assertEqual(length_squared3((3, 4, 0)), 25)
        self.assertEqual(len3((2, -3, 6)), 7)

    def test_cross_anticommutative_negative_control(self):
        for a, b, *_ in BATTERY:
            ab = cross3(a, b)
            ba = cross3(b, a)
            self.assertVecNear(ba, _neg(ab))
            if any(c != 0 for c in ab):
                self.assertNotEqual(ba, ab)

    def test_cross_perpendicular_to_both_inputs(self):
        for a, b, *_ in BATTERY:
            c = cross3(a, b)
            self.assertAlmostEqual(dot3(c, a), 0, delta=1e-9)
            self.assertAlmostEqual(dot3(c, b), 0, delta=1e-9)

    def test_cross_right_hand_rule(self):
        self.assertEqual(cross3((1, 0, 0), (0, 1, 0)), (0, 0, 1))
        self.assertEqual(cross3((0, 1, 0), (0, 0, 1)), (1, 0, 0))
        self.assertEqual(cross3((0, 0, 1), (1, 0, 0)), (0, 1, 0))
        self.assertNotEqual(cross3((1, 0, 0), (0, 1, 0)), (0, 0, -1))

    def test_normalize_unit_length_and_direction(self):
        for v in [(0, 3, 4), (1, 2, 3), (-1.5, 2.25, 0.75),
                  (2, -3, 6), (0.1, 0.2, 0.3)]:
            n = norm3(v)
            self.assertAlmostEqual(len3(n), 1, delta=EPS)
            self.assertVecNear(cross3(v, n), (0, 0, 0), 1e-9)
            self.assertAlmostEqual(dot3(v, n), len3(v), delta=1e-9)
        self.assertVecNear(norm3((0, 3, 4)), (0, 0.6, 0.8))

    def test_normalize_zero_vector_contract(self):
        # Documented contract: zero normalizes to zero, never raises.
        self.assertEqual(norm3((0, 0, 0)), (0.0, 0.0, 0.0))

    def test_distance_properties(self):
        for a, b, *_ in BATTERY:
            self.assertEqual(distance3(a, a), 0)
            self.assertAlmostEqual(distance3(a, b), distance3(b, a),
                                   delta=EPS)
            self.assertAlmostEqual(distance3(a, b), len3(sub3(b, a)),
                                   delta=EPS)
        self.assertEqual(distance3((0, 0, 0), (3, 4, 0)), 5)

    def test_reflect_flips_only_normal_component(self):
        self.assertEqual(reflect3((1, -1, 0), (0, 1, 0)), (1, 1, 0))
        self.assertEqual(reflect3((2, 3, 4), (0, 0, 1)), (2, 3, -4))
        self.assertEqual(reflect3((2, 3, 4), (1, 0, 0)), (-2, 3, 4))

    def test_reflect_involution_and_length(self):
        normals = [(0, 1, 0), (1, 0, 0), (0, 0, 1),
                   norm3((1, 2, 3)), norm3((-2, 1, 0.5))]
        for n in normals:
            for v in [(1, 2, 3), (0.6, -0.8, 0), (-1.5, 2.25, 0.75),
                      (3, 4, 0)]:
                r = reflect3(v, n)
                self.assertAlmostEqual(len3(r), len3(v), delta=1e-9)
                self.assertVecNear(reflect3(r, n), v, 1e-9)

    def test_reflect_non_unit_normal_negative_control(self):
        # Contract: n must be unit. n = 2y-hat must overshoot, proving
        # reflect3 does not secretly renormalize.
        r = reflect3((1, -1, 0), (0, 2, 0))
        self.assertNotEqual(r, (1, 1, 0))
        self.assertGreater(abs(len3(r) - len3((1, -1, 0))), 1e-9)

    def test_lerp_endpoints_midpoint_extrapolation(self):
        self.assertEqual(lerp(2, 10, 0), 2)
        self.assertEqual(lerp(2, 10, 1), 10)
        self.assertEqual(lerp(2, 10, 0.5), 6)
        self.assertEqual(lerp(-4, 4, 0.25), -2)
        # Extrapolation is the documented contract: t is not clamped.
        self.assertEqual(lerp(2, 10, 2), 18)
        self.assertEqual(lerp(2, 10, -1), -6)
        self.assertEqual(lerp3((0, 0, 0), (4, 8, 12), 0), (0, 0, 0))
        self.assertEqual(lerp3((0, 0, 0), (4, 8, 12), 1), (4, 8, 12))
        self.assertEqual(lerp3((0, 0, 0), (4, 8, 12), 0.5), (2, 4, 6))
        self.assertEqual(lerp3((0, 0, 0), (4, 8, 12), 2), (8, 16, 24))
        self.assertEqual(lerp3((1, 2, 3), (4, 5, 6), 0.5), (2.5, 3.5, 4.5))

    def test_clamp_scalar_and_vector(self):
        self.assertEqual(clamp(-3, 0, 10), 0)
        self.assertEqual(clamp(5, 0, 10), 5)
        self.assertEqual(clamp(42, 0, 10), 10)
        self.assertEqual(clamp(2.5, -1, 1), 1)
        self.assertEqual(clamp(-2.5, -1, 1), -1)
        self.assertEqual(clamp3((-5, 0.5, 99), 0, 1), (0, 0.5, 1))
        self.assertEqual(clamp3((-1, -2, -3), -1.5, 1.5), (-1, -1.5, -1.5))
        self.assertEqual(clamp3v((5, -5, 0.25), (0, -1, 0), (4, 1, 0.5)),
                         (4, -1, 0.25))


if __name__ == "__main__":
    unittest.main()
