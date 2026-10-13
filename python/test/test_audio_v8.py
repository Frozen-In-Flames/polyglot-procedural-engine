"""Tests for V8 Python audio: AdaptiveComposer, score.py, audio_foundry.py.

Stdlib unittest, run with:  cd python && python3 -m unittest discover -s test

The score-schema check mirrors the TypeScript ``validateScore`` contract
in src/audio/driver.ts as extended by the V8 design (schema v1.1): the
new kinds 'pluck'|'ping'|'riser'|'gust'|'granular' and the optional
fields attack/decay/filterFreq/reverbSend are accepted; the v1.0 fields
keep their exact meanings.
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from xrgen.audio import AdaptiveComposer, AudioComposer
from xrgen.rng import Rng
from xrgen import score as score_lib

# --- validateScore v1.1 contract, mirrored from src/audio/driver.ts ---
_V11_KINDS = ('tone', 'pad', 'bass', 'noise',
              'pluck', 'ping', 'riser', 'gust', 'granular')
_OPTIONAL_FIELDS = ('pan', 'attack', 'decay', 'filterFreq', 'reverbSend')


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate_score_v11(doc):
    """Mirror of the TS validateScore contract at schema v1.1. Throws on bad shape."""
    assert isinstance(doc, dict), "score: not an object"
    loop_dur = doc.get('loop_dur', doc.get('loopDur'))
    assert _is_num(loop_dur) and loop_dur > 0, "score: bad loop_dur"
    assert isinstance(doc.get('events'), list), "score: events not an array"
    for i, e in enumerate(doc['events']):
        assert isinstance(e, dict), "score: event %d not an object" % i
        for f in ('t', 'dur', 'freq', 'gain'):
            assert _is_num(e.get(f)), "score: event %d has non-numeric %s" % (i, f)
        assert e['dur'] > 0 and e['freq'] > 0, "score: event %d out of range" % i
        assert 0 <= e['gain'] <= 1, "score: event %d gain out of range" % i
        assert e.get('kind') in _V11_KINDS, "score: event %d bad kind %r" % (i, e.get('kind'))
        for f in _OPTIONAL_FIELDS:
            if f in e:
                assert _is_num(e[f]), "score: event %d bad %s" % (i, f)
                if f == 'pan':
                    assert -1.0 <= e[f] <= 1.0, "score: event %d pan out of range" % i
                else:
                    assert e[f] >= 0, "score: event %d negative %s" % (i, f)
        if 'filterFreq' in e:
            assert e['filterFreq'] > 0, "score: event %d bad filterFreq" % i
    return True


_STATES = [
    {"energy": 0.0, "tension": 0.0, "attunement": 0, "brightness": 0.0, "tempo": 0.5},
    {"energy": 0.1, "tension": 0.2, "attunement": 10, "brightness": 0.2, "tempo": 0.8},
    {"energy": 0.5, "tension": 0.5, "attunement": 45, "brightness": 0.6, "tempo": 1.0},
    {"energy": 0.8, "tension": 0.7, "attunement": 75, "brightness": 0.9, "tempo": 1.5},
    {"energy": 1.0, "tension": 1.0, "attunement": 100, "brightness": 1.0, "tempo": 2.0},
]


class TestAdaptiveDeterminism(unittest.TestCase):
    def test_same_seed_state_bit_exact(self):
        c = AdaptiveComposer()
        for seed in (7, 42, 1337, 0, 2 ** 40):
            for st in _STATES:
                a = c.compose_adaptive(seed, 4, 96.0, st)
                b = c.compose_adaptive(seed, 4, 96.0, st)
                self.assertEqual(a, b)
                # JSON round-trip is the cross-language wire format.
                self.assertEqual(json.loads(json.dumps(a)),
                                 json.loads(json.dumps(b)))

    def test_different_states_differ(self):
        c = AdaptiveComposer()
        base = {"energy": 0.5, "tension": 0.5, "attunement": 50,
                "brightness": 0.5, "tempo": 1.0}
        ref = c.compose_adaptive(7, 4, 96.0, base)
        for key in base:
            lo, hi = {"energy": (0.0, 1.0), "tension": (0.0, 1.0),
                      "attunement": (0.0, 100.0), "brightness": (0.0, 1.0),
                      "tempo": (0.5, 2.0)}[key]
            alt = dict(base)
            alt[key] = lo if base[key] != lo else hi
            self.assertNotEqual(ref, c.compose_adaptive(7, 4, 96.0, alt),
                                "state key %r has no effect" % key)

    def test_different_seeds_differ(self):
        c = AdaptiveComposer()
        st = _STATES[2]
        docs = [c.compose_adaptive(s, 4, 96.0, st) for s in (7, 8, 9)]
        self.assertEqual(len({json.dumps(d, sort_keys=True) for d in docs}), 3)

    def test_state_clamped(self):
        c = AdaptiveComposer()
        wild = {"energy": 99, "tension": -5, "attunement": 1e6,
                "brightness": -1, "tempo": 0.01}
        sane = {"energy": 1.0, "tension": 0.0, "attunement": 100,
                "brightness": 0.0, "tempo": 0.5}
        self.assertEqual(c.compose_adaptive(7, 4, 96.0, wild),
                         c.compose_adaptive(7, 4, 96.0, sane))

    def test_default_state(self):
        c = AdaptiveComposer()
        a = c.compose_adaptive(7, 4, 96.0)
        b = c.compose_adaptive(7, 4, 96.0, None)
        self.assertEqual(a, b)


class TestLayerModel(unittest.TestCase):
    def test_harmony_gate(self):
        c = AdaptiveComposer()
        low = c.compose_adaptive(7, 4, 96.0,
                                 {"energy": 0.1, "tension": 0.0, "attunement": 0,
                                  "brightness": 0.0, "tempo": 1.0})
        high = c.compose_adaptive(7, 4, 96.0,
                                  {"energy": 0.5, "tension": 0.0, "attunement": 0,
                                   "brightness": 0.0, "tempo": 1.0})
        self.assertFalse(any(e["kind"] == "pad" for e in low["events"]))
        self.assertTrue(any(e["kind"] == "pad" for e in high["events"]))

    def test_song_gate(self):
        c = AdaptiveComposer()
        low = c.compose_adaptive(7, 4, 96.0,
                                 {"energy": 0.8, "tension": 0.0, "attunement": 30,
                                  "brightness": 0.0, "tempo": 1.0})
        high = c.compose_adaptive(7, 4, 96.0,
                                  {"energy": 0.8, "tension": 0.0, "attunement": 60,
                                   "brightness": 0.0, "tempo": 1.0})
        self.assertFalse(any(e["kind"] == "tone" for e in low["events"]))
        self.assertTrue(any(e["kind"] == "tone" for e in high["events"]))

    def test_density_follows_energy(self):
        c = AdaptiveComposer()
        st = {"tension": 0.0, "attunement": 60, "brightness": 0.0, "tempo": 1.0}
        counts = []
        for energy in (0.2, 0.5, 0.9):
            d = c.compose_adaptive(7, 4, 96.0, dict(st, energy=energy))
            counts.append(sum(1 for e in d["events"] if e["kind"] == "tone"))
        self.assertEqual(counts, sorted(counts))
        self.assertGreater(counts[-1], counts[0])

    def test_tempo_scales_loop(self):
        c = AdaptiveComposer()
        st = {"energy": 0.5, "tension": 0.0, "attunement": 0,
              "brightness": 0.0, "tempo": 1.0}
        d1 = c.compose_adaptive(7, 4, 96.0, st)
        d2 = c.compose_adaptive(7, 4, 96.0, dict(st, tempo=2.0))
        self.assertAlmostEqual(d2["loop_dur"], d1["loop_dur"] / 2.0, places=6)

    def test_attunement_thresholds(self):
        # Corrected per games/first-light/shared.ts ATTUNE_LEVELS: the V8
        # design doc's 15/30/45/60/75/90 was wrong; the game is authoritative.
        # The heard levels must stay in sync with the game's level-ups.
        self.assertEqual(list(score_lib.ATTUNEMENT_THRESHOLDS), [12, 28, 44, 60, 74, 88])
        self.assertEqual(score_lib.attunement_level(0), 0)
        self.assertEqual(score_lib.attunement_level(11), 0)
        self.assertEqual(score_lib.attunement_level(12), 1)
        self.assertEqual(score_lib.attunement_level(87), 5)
        self.assertEqual(score_lib.attunement_level(88), 6)
        self.assertEqual(score_lib.attunement_level(100), 6)

    def test_orbit_widens_with_attunement(self):
        rng = Rng(1234)
        narrow = [abs(score_lib.pan_for_orbit(rng, 10)) for _ in range(200)]
        wide = [abs(score_lib.pan_for_orbit(rng, 90)) for _ in range(200)]
        self.assertLess(max(narrow), max(wide))
        self.assertTrue(all(p <= 1.0 for p in narrow + wide))


class TestScoreSchemaV11(unittest.TestCase):
    def test_adaptive_docs_validate(self):
        c = AdaptiveComposer()
        for seed in (7, 42):
            for st in _STATES:
                for bars, bpm in ((2, 90.0), (4, 96.0), (8, 120.0)):
                    doc = c.compose_adaptive(seed, bars, bpm, st)
                    self.assertTrue(validate_score_v11(doc))
                    self.assertEqual(doc["language"], "Python")
                    self.assertEqual(doc["seed"], seed)
                    self.assertEqual(doc["generator"],
                                     "xrgen.audio.AdaptiveComposer")

    def test_static_docs_still_validate(self):
        c = AudioComposer()
        for seed in (7, 42):
            self.assertTrue(validate_score_v11(c.compose(seed, 4, 96.0)))

    def test_events_sorted_and_sane(self):
        c = AdaptiveComposer()
        doc = c.compose_adaptive(7, 4, 96.0, _STATES[3])
        ts = [e["t"] for e in doc["events"]]
        self.assertEqual(ts, sorted(ts))
        self.assertTrue(all(e["t"] < doc["loop_dur"] for e in doc["events"]))

    def test_optional_fields_in_range(self):
        c = AdaptiveComposer()
        doc = c.compose_adaptive(7, 4, 96.0, _STATES[3])
        for e in doc["events"]:
            for f in ("attack", "decay", "filterFreq", "reverbSend"):
                if f in e:
                    self.assertGreaterEqual(e[f], 0)
            if "pan" in e:
                self.assertLessEqual(abs(e["pan"]), 1.0)


class TestRuntimePurity(unittest.TestCase):
    """audio.py and score.py stay stdlib-only; the foundry never leaks in."""

    def _read(self, repo, rel):
        with open(os.path.join(repo, rel)) as f:
            return f.read()

    def _imports_of(self, path):
        with open(path) as f:
            return re.findall(r'^\s*(?:import|from)\s+([a-zA-Z0-9_.]+)',
                              f.read(), re.M)

    def test_no_heavy_imports(self):
        repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        for rel in ("xrgen/audio.py", "xrgen/score.py", "xrgen/__init__.py"):
            mods = self._imports_of(os.path.join(repo, rel))
            for m in mods:
                self.assertNotIn(m.split(".")[0], ("numpy", "scipy"),
                                 "%s imports %s" % (rel, m))
                self.assertNotIn("audio_foundry", m, "%s imports foundry" % rel)

    def test_no_transcendentals_on_decision_path(self):
        repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        src = self._read(repo, "xrgen/score.py")
        self.assertNotIn("math.sin", src)
        self.assertNotIn("math.cos", src)
        self.assertNotIn("math.exp", src)
        self.assertNotIn("math.log", src)

    def test_no_third_eye(self):
        repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        for rel in ("xrgen/audio.py", "xrgen/score.py", "xrgen/audio_foundry.py"):
            self.assertNotIn("third eye", self._read(repo, rel).lower())

    def test_zero_asset_dependence_wording(self):
        repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        for rel in ("xrgen/audio.py", "xrgen/score.py"):
            self.assertIn("zero asset dependence", self._read(repo, rel).lower())


class TestAudioComposerRegression(unittest.TestCase):
    """AudioComposer.compose must be unchanged by the V8 extension."""

    @classmethod
    def setUpClass(cls):
        repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        head_src = subprocess.run(
            ["git", "-C", repo, "show", "HEAD:python/xrgen/audio.py"],
            capture_output=True, text=True, check=True).stdout
        tmp = tempfile.mkdtemp(prefix="xrgen-head-")
        pkg = os.path.join(tmp, "xrgen_head")
        os.mkdir(pkg)
        with open(os.path.join(pkg, "__init__.py"), "w") as f:
            f.write("")
        with open(os.path.join(repo, "xrgen", "rng.py")) as f:
            rng_src = f.read()
        with open(os.path.join(pkg, "rng.py"), "w") as f:
            f.write(rng_src)
        for mod in ("audio.py", "score.py"):
            mod_src = subprocess.run(
                ["git", "-C", repo, "show", "HEAD:python/xrgen/" + mod],
                capture_output=True, text=True, check=True).stdout
            with open(os.path.join(pkg, mod), "w") as f:
                f.write(mod_src)
        sys.path.insert(0, tmp)
        cls.head_audio = importlib.import_module("xrgen_head.audio")

    def test_compose_matches_head(self):
        new = AudioComposer()
        old = self.head_audio.AudioComposer()
        for seed in (7, 42, 1337):
            for bars in (2, 4):
                for bpm in (90.0, 96.0, 128.0):
                    self.assertEqual(new.compose(seed, bars, bpm),
                                     old.compose(seed, bars, bpm),
                                     "compose(%r, %r, %r) changed" % (seed, bars, bpm))


class TestScoreLib(unittest.TestCase):
    def test_state_fingerprint_deterministic(self):
        st = _STATES[2]
        self.assertEqual(score_lib.state_fingerprint(st),
                         score_lib.state_fingerprint(dict(st)))
        self.assertEqual(score_lib.state_fingerprint(None),
                         score_lib.state_fingerprint(score_lib._STATE_DEFAULTS))

    def test_clamp_state_bounds(self):
        st = score_lib.clamp_state({"energy": 5, "tempo": -1})
        self.assertEqual(st["energy"], 1.0)
        self.assertEqual(st["tempo"], 0.5)
        self.assertEqual(st["attunement"], 20.0)  # default fills in

    def test_progression_family_deterministic(self):
        self.assertEqual(score_lib.progression_family(Rng(9)),
                         score_lib.progression_family(Rng(9)))

    def test_voice_lead_smooth(self):
        rng = Rng(5)
        tone = score_lib.voice_lead(rng, 7, (0, 3, 7))
        self.assertEqual(tone, 7)  # closest wins
        tone2 = score_lib.voice_lead(Rng(5), 7, (0, 3, 7))
        self.assertEqual(tone, tone2)  # deterministic

    def test_density_curve_monotone_in_energy(self):
        ds = [score_lib.note_density(e / 10.0) for e in range(11)]
        self.assertEqual(ds, sorted(ds))
        self.assertTrue(all(0.0 < d <= 1.0 for d in ds))

    def test_melody_walk_deterministic(self):
        a = score_lib.melody_walk(Rng(11), 3, 16, score_lib.MINOR_PENTA, 0.8)
        b = score_lib.melody_walk(Rng(11), 3, 16, score_lib.MINOR_PENTA, 0.8)
        self.assertEqual(a, b)
        self.assertEqual(len(a), 16)


class TestAudioFoundry(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.np_spec = importlib.util.find_spec("numpy")

    def test_import_never_from_runtime(self):
        # The foundry module must be importable standalone and must not be
        # pulled in by the runtime modules.
        import xrgen.audio_foundry as f
        self.assertTrue(f.FOUNDRY_FORMAT.startswith("ppe.audio-bundle/"))
        self.assertNotIn("xrgen.audio_foundry", sys.modules["xrgen.audio"].__dict__.get("__name__", "xrgen.audio"))

    @unittest.skipIf(importlib.util.find_spec("numpy") is None, "numpy not installed")
    def test_ir_bundle_deterministic(self):
        import xrgen.audio_foundry as f
        a = f.design_ir_bundle(7, 1.8, 0.6)
        b = f.design_ir_bundle(7, 1.8, 0.6)
        self.assertEqual(a, b)
        self.assertLessEqual(a["seconds"], f.MAX_IR_SECONDS)
        self.assertTrue(all(0.01 <= v <= 0.999 for v in a["damping_alpha"]))

    @unittest.skipIf(importlib.util.find_spec("numpy") is None, "numpy not installed")
    def test_spectrum_analysis_sane(self):
        import xrgen.audio_foundry as f
        s = f.analyze_spectrum(7)
        self.assertGreater(s["spectral_centroid_hz"], 0)
        self.assertGreater(s["rolloff_85_hz"], 0)
        rec = s["recommend"]
        self.assertTrue(200.0 <= rec["filterFreq"] <= 12000.0)
        self.assertTrue(0.0 <= rec["reverbSend"] <= 1.0)

    @unittest.skipIf(importlib.util.find_spec("numpy") is None, "numpy not installed")
    def test_pad_bundle_round_trip(self):
        import xrgen.audio_foundry as f
        bundle = f.bake_pad_bundle(7, 16.0)
        path = os.path.join(tempfile.mkdtemp(), "pad.json")
        f.save_bundle(bundle, path)
        back = f.load_bundle(path)
        self.assertEqual(bundle, back)
        self.assertEqual(f.validate_bundle(back)["kind"], "evolving-pad")

    def test_missing_numpy_message(self):
        import xrgen.audio_foundry as f
        if f._HAS_NUMPY:
            self.skipTest("numpy installed; guard not exercised")
        with self.assertRaises(ImportError) as ctx:
            f.design_ir_bundle(7, 1.8, 0.6)
        self.assertIn("numpy", str(ctx.exception).lower())

    def test_seeded_noise_deterministic(self):
        import xrgen.audio_foundry as f
        a = f.seeded_noise_u64(7, 64)
        b = f.seeded_noise_u64(7, 64)
        self.assertEqual(a, b)
        self.assertTrue(all(-1.0 <= v <= 1.0 for v in a))


if __name__ == "__main__":
    unittest.main()
