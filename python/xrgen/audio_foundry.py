"""audio_foundry.py - OFFLINE-ONLY audio design tooling for V8.

The two-sided foundry design: this module may use numpy/scipy ONCE, at
design time, to design reverb IR parameter sets, analyze spectra of
candidate textures, and bake long evolving pads into JSON parameter
bundles. Its output is JSON the runtime evaluates with the zero-dependency
engine.

HARD RULE: this module must NEVER be imported by the runtime path.
``audio.py``, ``score.py``, and ``__init__.py`` must not import it.

Zero asset dependence: no samples, no recorded impulse responses, no
soundfonts. Every IR and texture described here is generated from seeded
math; the bundles record *parameters*, not audio.
"""
import json
import math

try:
    import numpy as _np
    _HAS_NUMPY = True
except ImportError:  # pragma: no cover
    _np = None
    _HAS_NUMPY = False

try:
    import scipy  # noqa: F401  (optional; only used for window helpers if present)
    _HAS_SCIPY = True
except ImportError:  # pragma: no cover
    _HAS_SCIPY = False

FOUNDRY_FORMAT = "ppe.audio-bundle/1"
MAX_IR_SECONDS = 1.5  # per the V8 design: seeded decay makes 1.5 s feel larger


def _require_numpy():
    if not _HAS_NUMPY:
        raise ImportError(
            "audio_foundry needs numpy, which is not installed in this "
            "environment. Install it (pip install numpy) and re-run this "
            "offline tooling. The runtime path (audio.py, score.py) stays "
            "stdlib-only and is unaffected."
        )


def _seeded_u64(seed: int, stream: int) -> int:
    """SplitMix64-style integer stream; no floats, no transcendentals."""
    m = (1 << 64) - 1
    h = (seed ^ (stream * 0x9E3779B97F4A7C15)) & m
    h = (h + 0x9E3779B97F4A7C15) & m
    z = h
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & m
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & m
    return z ^ (z >> 31)


def seeded_noise_u64(seed: int, n: int) -> list:
    """Deterministic uniform noise in [-1, 1] from integer arithmetic.

    Mirrors the SplitMix64 family so the foundry's analysis agrees with
    the runtime's Rng on the decision path.
    """
    out = []
    for i in range(n):
        z = _seeded_u64(seed, i)
        out.append((z / 18446744073709551616.0) * 2.0 - 1.0)
    return out


def design_ir_bundle(seed: int, decay: float, damping: float,
                     seconds: float = MAX_IR_SECONDS,
                     rate: int = 48000) -> dict:
    """Design a reverb IR *parameter set* for a zone reverb seed.

    The runtime generates the actual impulse from these parameters
    (seeded noise shaped by an exponential decay envelope with
    progressive lowpass damping); the bundle records the parameters and
    a short envelope preview table, never samples.

    Returns a JSON-serializable dict with ``format`` == FOUNDRY_FORMAT.
    """
    _require_numpy()
    seconds = min(max(seconds, 0.1), MAX_IR_SECONDS)
    n = int(seconds * rate)
    t = _np.arange(n) / rate
    envelope = _np.exp(-t * decay).astype(_np.float64)
    # Progressive damping: one-pole lowpass coefficient schedule that
    # tightens over the tail. Recorded as 64 control points the runtime
    # interpolates linearly (no transcendentals needed to evaluate).
    ctrl = 64
    alpha = _np.linspace(1.0 - damping, 1.0 - damping * 0.1, ctrl)
    alpha = _np.clip(alpha, 0.01, 0.999)
    return {
        "format": FOUNDRY_FORMAT,
        "kind": "reverb-ir-params",
        "seed": int(seed),
        "rate": int(rate),
        "seconds": round(float(seconds), 4),
        "decay": float(decay),
        "damping": float(damping),
        "envelope_preview": [round(float(v), 6) for v in envelope[:: max(1, n // 256)]],
        "damping_alpha": [round(float(v), 6) for v in alpha],
        "energy": round(float(_np.sum(envelope ** 2) / n), 6),
    }


def analyze_spectrum(seed: int, seconds: float = 4.0, rate: int = 48000,
                     base_freq: float = 110.0, harmonics: int = 8) -> dict:
    """Analyze a candidate seeded texture's spectrum (offline, numpy FFT).

    Synthesizes a deterministic harmonic-stack texture from the seed,
    measures its spectrum, and reports design recommendations
    (suggested filterFreq, reverbSend, layer gain) as plain numbers the
    runtime can use directly.
    """
    _require_numpy()
    n = int(seconds * rate)
    t = _np.arange(n) / rate
    sig = _np.zeros(n, dtype=_np.float64)
    for h in range(1, harmonics + 1):
        amp = 1.0 / h
        # Seeded per-harmonic phase from integer stream (phase in cycles).
        phase = (_seeded_u64(seed, h) / 18446744073709551616.0)
        sig += amp * _np.sin(2.0 * math.pi * (base_freq * h * t + phase))
    # Seeded amplitude wobble: slow, deterministic, no stored LFO tables.
    wob = _np.array(seeded_noise_u64(seed ^ 0x7708, n // 64),
                    dtype=_np.float64)
    wob = _np.repeat(wob, 64)[:n]
    sig = sig * (0.75 + 0.25 * wob)
    spec = _np.abs(_np.fft.rfft(sig))
    freqs = _np.fft.rfftfreq(n, 1.0 / rate)
    total = float(_np.sum(spec)) or 1.0
    centroid = float(_np.sum(freqs * spec) / total)
    bandwidth = float(math.sqrt(_np.sum(((freqs - centroid) ** 2) * spec) / total))
    # Spectral rolloff: frequency below which 85% of energy sits.
    cumsum = _np.cumsum(spec)
    rolloff = float(freqs[int(_np.searchsorted(cumsum, 0.85 * total))])
    crest = float(_np.max(_np.abs(sig)) / (math.sqrt(float(_np.mean(sig ** 2))) or 1.0))
    return {
        "format": FOUNDRY_FORMAT,
        "kind": "texture-spectrum",
        "seed": int(seed),
        "rate": int(rate),
        "seconds": round(float(seconds), 4),
        "base_freq": float(base_freq),
        "harmonics": int(harmonics),
        "spectral_centroid_hz": round(centroid, 2),
        "spectral_bandwidth_hz": round(bandwidth, 2),
        "rolloff_85_hz": round(rolloff, 2),
        "crest_factor": round(crest, 3),
        "recommend": {
            "filterFreq": round(min(12000.0, max(200.0, rolloff)), 1),
            "reverbSend": round(min(1.0, max(0.0, (bandwidth / 8000.0))), 3),
            "layerGain": round(min(0.5, max(0.05, 1.0 / crest)), 3),
        },
    }


def bake_pad_bundle(seed: int, seconds: float = 32.0,
                    chords=((0, 3, 7), (-4, 0, 3), (-2, 1, 5), (3, 7, 10)),
                    base_freq: float = 110.0) -> dict:
    """Bake a long evolving pad into a JSON parameter bundle.

    The runtime evaluates the bundle: per-segment chord roots, per-voice
    semitone offsets, gain/filter envelopes as linear control points.
    No audio is stored - only the numbers the engine's own oscillators
    need to re-perform the pad deterministically.
    """
    _require_numpy()
    seg_seconds = 8.0
    n_seg = max(1, int(math.ceil(seconds / seg_seconds)))
    segments = []
    for s in range(n_seg):
        chord = chords[s % len(chords)]
        voices = []
        for v, semis in enumerate(chord):
            freq = base_freq * (2.0 ** (semis / 12.0))
            detune_cents = ((_seeded_u64(seed, s * 16 + v) % 2001) - 1000) / 100.0
            voices.append({
                "semis": int(semis),
                "freq": round(float(freq), 3),
                "detune_cents": round(float(detune_cents), 2),
            })
        # Linear gain swell per segment, seeded depth.
        depth = (_seeded_u64(seed ^ 0x9EED, s) % 1001) / 1000.0
        segments.append({
            "t0": round(s * seg_seconds, 3),
            "t1": round(min(seconds, (s + 1) * seg_seconds), 3),
            "chord": [int(x) for x in chord],
            "voices": voices,
            "gain_points": [round(0.10 + 0.06 * depth, 4),
                            round(0.16 - 0.04 * depth, 4)],
            "filter_points": [800.0, 2400.0],
        })
    return {
        "format": FOUNDRY_FORMAT,
        "kind": "evolving-pad",
        "seed": int(seed),
        "seconds": round(float(seconds), 3),
        "base_freq": float(base_freq),
        "segments": segments,
    }


def save_bundle(bundle: dict, path: str) -> str:
    """Write a bundle to JSON; returns the path."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(bundle, f, indent=2)
        f.write("\n")
    return path


def load_bundle(path: str) -> dict:
    """Load a bundle; validates the format tag."""
    with open(path, "r", encoding="utf-8") as f:
        bundle = json.load(f)
    if bundle.get("format") != FOUNDRY_FORMAT:
        raise ValueError("not a PPE audio bundle: %r" % (path,))
    return bundle


def validate_bundle(bundle: dict) -> dict:
    """Structural check on a bundle (offline tooling, stdlib only)."""
    if not isinstance(bundle, dict):
        raise ValueError("bundle: not an object")
    if bundle.get("format") != FOUNDRY_FORMAT:
        raise ValueError("bundle: bad format tag")
    if bundle.get("kind") not in ("reverb-ir-params", "texture-spectrum",
                                  "evolving-pad"):
        raise ValueError("bundle: unknown kind")
    return bundle


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description="PPE V8 audio foundry (offline)")
    sub = p.add_subparsers(dest="cmd", required=True)
    ir = sub.add_parser("ir", help="design a reverb IR parameter set")
    ir.add_argument("--seed", type=int, required=True)
    ir.add_argument("--decay", type=float, required=True)
    ir.add_argument("--damping", type=float, required=True)
    ir.add_argument("--out", required=True)
    sp = sub.add_parser("spectrum", help="analyze a candidate texture")
    sp.add_argument("--seed", type=int, required=True)
    sp.add_argument("--out", required=True)
    pad = sub.add_parser("pad", help="bake an evolving pad bundle")
    pad.add_argument("--seed", type=int, required=True)
    pad.add_argument("--seconds", type=float, default=32.0)
    pad.add_argument("--out", required=True)
    args = p.parse_args(argv)
    if args.cmd == "ir":
        bundle = design_ir_bundle(args.seed, args.decay, args.damping)
    elif args.cmd == "spectrum":
        bundle = analyze_spectrum(args.seed)
    else:
        bundle = bake_pad_bundle(args.seed, args.seconds)
    save_bundle(bundle, args.out)
    print(args.out)


if __name__ == "__main__":
    main()
