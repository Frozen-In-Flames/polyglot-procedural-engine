"""Cross-language tick parity, Python side (v2.0.7).

The canonical scenario, serialization, and digest are specified in
docs/tick-parity.md. The agreed trace lives in parity/golden.tsv.
This test runs the Python port (xrgen.ticksim) for the first 120
ticks and requires an exact digest match, then requires the
negative controls (perturbed constant, shifted script) to diverge.

Stdlib unittest, run with:  cd python && python3 -m unittest discover -s test
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from xrgen.ticksim import _load_params, run_trace

_GOLDEN_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "..", "parity", "golden.tsv",
)
_TICKS = 120


def _golden(n):
    with open(_GOLDEN_PATH, "r", encoding="utf-8") as fh:
        return [line.rstrip("\n") for line in fh][:n]


class TestTickParity(unittest.TestCase):
    def test_python_trace_matches_golden(self):
        digests, _ = run_trace(20261022, _TICKS, _load_params())
        self.assertEqual(digests, _golden(_TICKS))

    def test_negative_control_perturbed_gravity_diverges(self):
        digests, _ = run_trace(
            20261022, _TICKS, _load_params(), perturb_gravity=True
        )
        self.assertNotEqual(digests, _golden(_TICKS))

    def test_negative_control_shifted_script_diverges(self):
        digests, _ = run_trace(
            20261022, _TICKS, _load_params(), shift_script=True
        )
        self.assertNotEqual(digests, _golden(_TICKS))

    def test_negative_control_perturbed_seed_diverges(self):
        digests, _ = run_trace(20261023, _TICKS, _load_params())
        self.assertNotEqual(digests, _golden(_TICKS))


if __name__ == "__main__":
    unittest.main()
