"""MlGenerationProvider - the ML-flavored half of procedural generation.

This is where Python earns its place in the engine: not scripting, not
glue, but the learned-function side of content generation.

  * heightfield / noise - same contract as the C++ GenCore (values in
    [0,1], pure functions of seed), so either backend can feed a mesh.
  * latent(seed, dim) - deterministic latent vectors, the way a generative
    model samples its latent space. Drives variation (placement, hue,
    behavior) from one seed.
  * make_style_weights / stylize_forward - a tiny seeded MLP (3 -> 6 -> 1)
    used as a *style transfer* over a heightfield. The weights are the
    "learned parameters"; the forward pass is the model. The TypeScript
    host mirrors the forward pass exactly (see src/bridge/python.ts), so
    Python trains/generates the parameters and every other language can
    evaluate them.
  * biome_weights - softmax over seeded logits: mixture weights, the same
    math an ML classifier outputs.

Everything is stdlib-only and deterministic: same seed, same output,
on any machine, forever.
"""
import math
from typing import List

from .rng import Rng

ARCH = [3, 6, 1]  # stylize MLP: 3 inputs -> 6 tanh -> 1 sigmoid


def _hash2(ix: int, iy: int, seed: int) -> float:
    h = (ix * 374761393 + iy * 668265263 + seed * 2246822519) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 4294967296.0


def _smooth(t: float) -> float:
    return t * t * (3.0 - 2.0 * t)


def _value_noise(x: float, y: float, seed: int) -> float:
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = x - ix, y - iy
    a = _hash2(ix, iy, seed)
    b = _hash2(ix + 1, iy, seed)
    c = _hash2(ix, iy + 1, seed)
    d = _hash2(ix + 1, iy + 1, seed)
    ux, uy = _smooth(fx), _smooth(fy)
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy


def _fbm(x: float, y: float, seed: int, octaves: int) -> float:
    total, amp, freq, norm = 0.0, 0.5, 1.0, 0.0
    for o in range(octaves):
        total += amp * _value_noise(x * freq, y * freq, seed + o * 101)
        norm += amp
        amp *= 0.5
        freq *= 2.03
    return total / norm


def _tanh(x: float) -> float:
    return math.tanh(x)


def _sigmoid(x: float) -> float:
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    e = math.exp(x)
    return e / (1.0 + e)


def make_style_weights(style_seed: int) -> dict:
    """Generate the seeded parameters of the style MLP.

    Xavier-scaled uniforms: the same initialization ML training starts
    from, except here the seed *is* the training - the parameters are
    used directly as a style function.
    """
    rng = Rng(style_seed ^ 0x9E3779B9)

    def mat(rows: int, cols: int) -> List[List[float]]:
        s = math.sqrt(6.0 / (rows + cols))
        return [[rng.uniform(-s, s) for _ in range(cols)] for _ in range(rows)]

    return {
        "arch": list(ARCH),
        "w1": mat(6, 3),
        "b1": [rng.uniform(-0.1, 0.1) for _ in range(6)],
        "w2": mat(1, 6),
        "b2": [rng.uniform(-0.1, 0.1)],
        "style_seed": style_seed,
    }


def stylize_forward(x: List[float], w: dict) -> float:
    """One forward pass of the style MLP. x = [height, u, v], out in [0,1].

    Mirrored exactly by TsMlProvider.stylizeForward in src/bridge/python.ts -
    any change here must change there too (test/test_ml.py cross-checks
    via the bridge, and test/python-mirror checks the TS side).
    """
    hidden = [
        _tanh(
            w["w1"][i][0] * x[0] + w["w1"][i][1] * x[1] + w["w1"][i][2] * x[2]
            + w["b1"][i]
        )
        for i in range(6)
    ]
    y = sum(w["w2"][0][i] * hidden[i] for i in range(6)) + w["b2"][0]
    return _sigmoid(y)


def stylize_field(
    heights: List[float], w: int, h: int, weights: dict, amount: float = 0.45
) -> List[float]:
    """Apply the style MLP per-texel, blended with the original field.

    amount=0 leaves the field untouched; amount=1 replaces it with the
    pure style output. 0.45 keeps the base terrain readable while the
    style reshapes it.
    """
    out = []
    for j in range(h):
        v = j / (h - 1) if h > 1 else 0.0
        for i in range(w):
            u = i / (w - 1) if w > 1 else 0.0
            idx = j * w + i
            s = stylize_forward([heights[idx], u, v], weights)
            out.append((1.0 - amount) * heights[idx] + amount * s)
    return out


def biome_weights(seed: int, n: int) -> List[float]:
    """Softmax over seeded logits - mixture weights, classifier-style."""
    rng = Rng(seed ^ 0x51ED)
    logits = [rng.normal() for _ in range(n)]
    m = max(logits)
    exps = [math.exp(l - m) for l in logits]
    total = sum(exps)
    return [e / total for e in exps]


class MlGenerationProvider:
    """The provider object other languages talk to."""

    language_tag = "Python"

    def heightfield(
        self, seed: int, w: int, h: int, features: float, octaves: int
    ) -> List[float]:
        return [
            _fbm((i / (w - 1)) * features, (j / (h - 1)) * features, seed, octaves)
            for j in range(h)
            for i in range(w)
        ]

    def latent(self, seed: int, dim: int) -> List[float]:
        rng = Rng(seed ^ 0x1A7E57)
        return [rng.normal() for _ in range(dim)]

    def style_weights(self, style_seed: int) -> dict:
        return make_style_weights(style_seed)

    def stylize(
        self, heights: List[float], w: int, h: int, style_seed: int,
        amount: float = 0.45,
    ) -> List[float]:
        return stylize_field(heights, w, h, make_style_weights(style_seed), amount)

    def biomes(self, seed: int, n: int) -> List[float]:
        return biome_weights(seed, n)
