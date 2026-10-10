"""Tests for the Python ML generation provider.

Mirrors the bar the C++ core cleared: deterministic for a seed, values in
range, real variance across seeds — plus a bridge round-trip proving the
JSON protocol C++/C#/TS will speak.
"""
import json
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from xrgen.ml import (
    MlGenerationProvider,
    biome_weights,
    make_style_weights,
    stylize_forward,
)
from xrgen.audio import AudioComposer

P = MlGenerationProvider()
HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "..", "xrgen", "bridge.py")


class TestMlProvider(unittest.TestCase):
    def test_heightfield_range(self):
        out = P.heightfield(1337, 16, 16, 6.0, 4)
        self.assertEqual(len(out), 256)
        self.assertTrue(all(0.0 <= v <= 1.0 for v in out))

    def test_heightfield_deterministic(self):
        a = P.heightfield(99, 8, 8, 4.0, 3)
        b = P.heightfield(99, 8, 8, 4.0, 3)
        self.assertEqual(a, b)

    def test_heightfield_varies_by_seed(self):
        a = P.heightfield(1, 8, 8, 4.0, 3)
        b = P.heightfield(2, 8, 8, 4.0, 3)
        diff = sum(abs(x - y) for x, y in zip(a, b)) / len(a)
        self.assertGreater(diff, 0.01, "different seeds must differ")

    def test_heightfield_has_variance(self):
        out = P.heightfield(7, 16, 16, 6.0, 4)
        mean = sum(out) / len(out)
        var = sum((v - mean) ** 2 for v in out) / len(out)
        self.assertGreater(var, 1e-4, "field must not be flat")

    def test_latent_deterministic(self):
        self.assertEqual(P.latent(5, 8), P.latent(5, 8))
        self.assertNotEqual(P.latent(5, 8), P.latent(6, 8))

    def test_style_weights_deterministic(self):
        a = make_style_weights(42)
        b = make_style_weights(42)
        self.assertEqual(a["w1"], b["w1"])
        self.assertEqual(a["arch"], [3, 6, 1])

    def test_stylize_forward_range(self):
        w = make_style_weights(42)
        for x in ([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.5, 0.25, 0.75]):
            v = stylize_forward(x, w)
            self.assertTrue(0.0 < v < 1.0, f"sigmoid output out of range: {v}")

    def test_stylize_changes_but_keeps_range(self):
        base = P.heightfield(1337, 12, 12, 6.0, 4)
        out = P.stylize(base, 12, 12, 20261010)
        self.assertEqual(len(out), len(base))
        self.assertTrue(all(0.0 <= v <= 1.0 for v in out))
        diff = sum(abs(a - b) for a, b in zip(base, out)) / len(base)
        self.assertGreater(diff, 1e-4, "style must reshape the field")

    def test_biomes_softmax(self):
        w = biome_weights(11, 4)
        self.assertEqual(len(w), 4)
        self.assertAlmostEqual(sum(w), 1.0, places=9)
        self.assertTrue(all(v > 0 for v in w))

    def test_compose_deterministic(self):
        c = AudioComposer()
        a = c.compose(20261010)
        b = c.compose(20261010)
        self.assertEqual(a, b)

    def test_compose_schema(self):
        doc = AudioComposer().compose(7)
        self.assertEqual(doc["language"], "Python")
        self.assertGreater(doc["loop_dur"], 0)
        self.assertTrue(len(doc["events"]) > 0)
        kinds = {"tone", "pad", "bass", "noise"}
        prev_t = -1.0
        for e in doc["events"]:
            self.assertIn(e["kind"], kinds)
            self.assertGreater(e["freq"], 0)
            self.assertGreater(e["dur"], 0)
            self.assertTrue(0.0 <= e["gain"] <= 1.0)
            self.assertGreaterEqual(e["t"], prev_t, "events must be time-sorted")
            self.assertLess(e["t"], doc["loop_dur"], "events must fit the loop")
            prev_t = e["t"]

    def test_compose_varies_by_seed(self):
        a = AudioComposer().compose(1)["events"]
        b = AudioComposer().compose(2)["events"]
        self.assertNotEqual(
            [e["freq"] for e in a], [e["freq"] for e in b])

    def test_bridge_compose_op(self):
        proc = subprocess.Popen(
            [sys.executable, BRIDGE],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            text=True, bufsize=1,
        )
        try:
            proc.stdin.write(json.dumps({"op": "compose", "params": {"seed": 7}}) + "\n")
            proc.stdin.flush()
            res = json.loads(proc.stdout.readline())
            self.assertTrue(res["ok"])
            self.assertEqual(res["result"]["language"], "Python")
            self.assertTrue(len(res["result"]["events"]) > 0)
        finally:
            proc.stdin.close()
            proc.wait(timeout=10)

    def test_bridge_roundtrip(self):
        """The JSON protocol every other language will speak actually works."""
        proc = subprocess.Popen(
            [sys.executable, BRIDGE],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            text=True, bufsize=1,
        )
        def call(op, params):
            proc.stdin.write(json.dumps({"op": op, "params": params}) + "\n")
            proc.stdin.flush()
            return json.loads(proc.stdout.readline())
        try:
            ping = call("ping", {})
            self.assertTrue(ping["ok"])
            self.assertEqual(ping["result"]["language"], "Python")

            direct = P.heightfield(1337, 4, 4, 6.0, 4)
            via = call("heightfield", {"seed": 1337, "w": 4, "h": 4, "features": 6.0, "octaves": 4})
            self.assertTrue(via["ok"])
            self.assertEqual(via["result"], direct)

            bad = call("nope", {})
            self.assertFalse(bad["ok"])
        finally:
            proc.stdin.close()
            proc.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
