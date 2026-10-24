"""The canonical vecmath core, Python oracle port (v3.3.0).

Mirror of src/math/vec.ts: the eight classic game-engine vector
primitives -- dot product, normalize, distance, reflection, clamp,
vector length, lerp, cross product -- plus the length_squared
companion for sqrt-free comparisons. Vectors are plain 3-tuples of
floats; stdlib only, float64 throughout.

Every function reproduces the TypeScript arithmetic operation for
operation, in the same order, so the two languages agree to the last
bit on finite inputs (both ride IEEE-754 doubles and the correctly
rounded sqrt). The identity suites test/vecmath.test.ts and
python/test/test_vecmath.py run the SAME fixed battery, with
hand-worked expected values, through both implementations -- that
mirror is the cross-language parity check.

Contracts (stated once in the TS core, repeated here because a port
that drifts from them is a bug, not a variant):
  - norm3 never raises and never invents a direction: the zero
    vector normalizes to the zero vector.
  - reflect3 applies r = v - 2 (v . n) n exactly as written; the
    normal n MUST be unit length (a non-unit n overshoots, it is
    never silently renormalized).
  - lerp/lerp3 do not clamp t: t outside [0, 1] extrapolates.
  - clamp assumes lo <= hi: max(min(x, hi), lo).
"""
import math
from typing import Tuple

Vec3 = Tuple[float, float, float]


def add3(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub3(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def scale3(a: Vec3, s: float) -> Vec3:
    return (a[0] * s, a[1] * s, a[2] * s)


def dot3(a: Vec3, b: Vec3) -> float:
    """Dot product: ax bx + ay by + az bz, summed in that order."""
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross3(a: Vec3, b: Vec3) -> Vec3:
    """Cross product: (ay bz - az by, az bx - ax bz, ax by - ay bx)."""
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def length_squared3(a: Vec3) -> float:
    """Squared length: dot(a, a). The sqrt-free comparison form."""
    return dot3(a, a)


def len3(a: Vec3) -> float:
    """Vector length: sqrt(x^2 + y^2 + z^2), via dot(a, a)."""
    return math.sqrt(dot3(a, a))


def norm3(a: Vec3) -> Vec3:
    """Normalize: v / |v|. Zero vector -> zero vector (see header)."""
    l = len3(a)
    if l == 0.0:
        l = 1.0
    inv = 1.0 / l
    return (a[0] * inv, a[1] * inv, a[2] * inv)


def distance3(a: Vec3, b: Vec3) -> float:
    """Distance between two points: |b - a|."""
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    dz = a[2] - b[2]
    return math.sqrt(dx * dx + dy * dy + dz * dz)


def reflect3(v: Vec3, n: Vec3) -> Vec3:
    """Reflection off the plane with UNIT normal n: v - 2 (v.n) n."""
    d = 2.0 * dot3(v, n)
    return (v[0] - d * n[0], v[1] - d * n[1], v[2] - d * n[2])


def clamp(x: float, lo: float, hi: float) -> float:
    """Scalar clamp: max(min(x, hi), lo). Assumes lo <= hi."""
    return max(lo, min(x, hi))


def clamp3(a: Vec3, lo: float, hi: float) -> Vec3:
    """Component-wise clamp against scalar bounds."""
    return (clamp(a[0], lo, hi), clamp(a[1], lo, hi), clamp(a[2], lo, hi))


def clamp3v(a: Vec3, lo: Vec3, hi: Vec3) -> Vec3:
    """Component-wise clamp against per-axis bounds."""
    return (clamp(a[0], lo[0], hi[0]),
            clamp(a[1], lo[1], hi[1]),
            clamp(a[2], lo[2], hi[2]))


def lerp(a: float, b: float, t: float) -> float:
    """Scalar lerp: a + (b - a) t. t is not clamped (see header)."""
    return a + (b - a) * t


def lerp3(a: Vec3, b: Vec3, t: float) -> Vec3:
    """Vector lerp, component-wise. t is not clamped."""
    return (a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t)
