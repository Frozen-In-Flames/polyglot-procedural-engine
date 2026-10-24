// test/vecmath.test.ts - v3.3.0: the canonical vecmath core.
//
// Identity suite for the eight classic game-engine vector primitives
// (dot, normalize, distance, reflect, clamp, length, lerp, cross) as
// consolidated in src/math/vec.ts. Oracle style: every identity ships
// with a negative control that would fail if the formula were wrong
// (sign flips, swapped operands, a deliberately broken variant), and
// the fixed battery below is mirrored value-for-value by the Python
// port's suite (python/test/test_vecmath.py) - that mirror IS the
// cross-language parity check, in the repo's established pattern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  v3, add3, sub3, scale3,
  dot3, cross3, len3, lengthSquared3, norm3,
  distance3, reflect3, clamp, clamp3, clamp3v, lerp, lerp3,
  type Vec3,
} from '../src/math/vec.js';

const EPS = 1e-12;
const near = (a: number, b: number, eps = EPS): boolean => Math.abs(a - b) <= eps;
const vecNear = (a: Vec3, b: Vec3, eps = EPS): boolean =>
  near(a[0], b[0], eps) && near(a[1], b[1], eps) && near(a[2], b[2], eps);
const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

// Fixed battery, mirrored in python/test/test_vecmath.py. Expected
// values are worked from the formulas by hand, not from the code.
const BATTERY: { a: Vec3; b: Vec3; dot: number; cross: Vec3; lenSqA: number; dist: number }[] = [
  { a: [1, 0, 0], b: [0, 1, 0], dot: 0, cross: [0, 0, 1], lenSqA: 1, dist: Math.SQRT2 },
  { a: [1, 2, 3], b: [4, 5, 6], dot: 32, cross: [-3, 6, -3], lenSqA: 14, dist: Math.sqrt(27) },
  { a: [3, 4, 0], b: [0, 0, 5], dot: 0, cross: [20, -15, 0], lenSqA: 25, dist: Math.sqrt(50) },
  { a: [-1.5, 2.25, 0.75], b: [0.5, -4, 2], dot: -8.25, cross: [7.5, 3.375, 4.875], lenSqA: 7.875, dist: Math.sqrt(44.625) },
  { a: [0, 0, 0], b: [1, 1, 1], dot: 0, cross: [0, 0, 0], lenSqA: 0, dist: Math.sqrt(3) },
  { a: [2, -3, 6], b: [-7, 8, -9], dot: -92, cross: [-21, -24, -5], lenSqA: 49, dist: Math.sqrt(427) },
  { a: [0.1, 0.2, 0.3], b: [0.4, 0.5, 0.6], dot: 0.32, cross: [-0.03, 0.06, -0.03], lenSqA: 0.14, dist: Math.sqrt(0.27) },
];

test('vecmath: battery matches hand-worked dot, cross, lengthSquared, distance', () => {
  for (const { a, b, dot, cross, lenSqA, dist } of BATTERY) {
    assert.ok(near(dot3(a, b), dot, 1e-9), `dot ${a} . ${b}`);
    assert.ok(vecNear(cross3(a, b), cross, 1e-9), `cross ${a} x ${b}`);
    assert.ok(near(lengthSquared3(a), lenSqA, 1e-9), `lengthSquared ${a}`);
    assert.ok(near(distance3(a, b), dist, 1e-9), `distance ${a} ${b}`);
  }
});

test('vecmath: dot of orthogonal vectors is exactly 0', () => {
  assert.equal(dot3([1, 0, 0], [0, 1, 0]), 0);
  assert.equal(dot3([3, 4, 0], [0, 0, 5]), 0);
  assert.equal(dot3([1, 1, 0], [1, -1, 0]), 0);
});

test('vecmath: dot with a negated vector flips sign (negative control)', () => {
  for (const { a, b } of BATTERY) {
    const d = dot3(a, b);
    assert.ok(near(dot3(a, neg(b)), -d), `dot(a,-b) = -dot(a,b) for ${a} ${b}`);
    assert.ok(near(dot3(neg(a), b), -d), `dot(-a,b) = -dot(a,b) for ${a} ${b}`);
    // The control has teeth: for a non-orthogonal pair the flipped
    // value must actually differ, or the identity above proves nothing.
    if (d !== 0) assert.notEqual(dot3(a, neg(b)), d);
  }
});

test('vecmath: dot(u, u) is lengthSquared(u), and len3 is its root', () => {
  for (const { a } of BATTERY) {
    assert.equal(dot3(a, a), lengthSquared3(a));
    assert.ok(near(len3(a) * len3(a), lengthSquared3(a), 1e-9));
    assert.ok(near(len3(a), Math.sqrt(lengthSquared3(a)), 1e-12));
  }
  // Exact Pythagorean cases.
  assert.equal(len3([3, 4, 0]), 5);
  assert.equal(lengthSquared3([3, 4, 0]), 25);
  assert.equal(len3([2, -3, 6]), 7);
});

test('vecmath: cross is anti-commutative (negative control: swapped order negates)', () => {
  for (const { a, b } of BATTERY) {
    const ab = cross3(a, b);
    const ba = cross3(b, a);
    assert.ok(vecNear(ba, neg(ab)), `b x a = -(a x b) for ${a} ${b}`);
    if (ab[0] !== 0 || ab[1] !== 0 || ab[2] !== 0) {
      assert.ok(!vecNear(ba, ab), `cross must change under swap for ${a} ${b}`);
    }
  }
});

test('vecmath: cross is perpendicular to both inputs', () => {
  for (const { a, b } of BATTERY) {
    const c = cross3(a, b);
    assert.ok(near(dot3(c, a), 0, 1e-9), `cross . a = 0 for ${a} ${b}`);
    assert.ok(near(dot3(c, b), 0, 1e-9), `cross . b = 0 for ${a} ${b}`);
  }
});

test('vecmath: right-hand rule on the basis vectors', () => {
  assert.deepEqual([...cross3([1, 0, 0], [0, 1, 0])], [0, 0, 1]);
  assert.deepEqual([...cross3([0, 1, 0], [0, 0, 1])], [1, 0, 0]);
  assert.deepEqual([...cross3([0, 0, 1], [1, 0, 0])], [0, 1, 0]);
  // And the left-handed (wrong) answers are rejected by the same checks.
  assert.notDeepEqual([...cross3([1, 0, 0], [0, 1, 0])], [0, 0, -1]);
});

test('vecmath: normalize gives unit length and preserves direction', () => {
  const vs: Vec3[] = [[0, 3, 4], [1, 2, 3], [-1.5, 2.25, 0.75], [2, -3, 6], [0.1, 0.2, 0.3]];
  for (const v of vs) {
    const n = norm3(v);
    assert.ok(near(len3(n), 1, 1e-12), `|norm(${v})| = 1`);
    // Direction preserved: cross(v, v-hat) is the zero vector.
    assert.ok(vecNear(cross3(v, n), [0, 0, 0], 1e-9), `cross(v, norm(v)) = 0 for ${v}`);
    // Same ray, not the opposite one: dot(v, v-hat) = |v| > 0.
    assert.ok(near(dot3(v, n), len3(v), 1e-9), `dot(v, norm(v)) = |v| for ${v}`);
  }
  assert.ok(vecNear(norm3([0, 3, 4]), [0, 0.6, 0.8]));
});

test('vecmath: normalize of the zero vector is the zero vector (documented contract)', () => {
  // Contract (docs/vector-math.md): norm3 never throws and never
  // invents a direction; the zero vector normalizes to itself. This is
  // the engine's long-standing convention (the `|| 1` guard), kept.
  assert.deepEqual([...norm3([0, 0, 0])], [0, 0, 0]);
});

test('vecmath: distance is symmetric, zero on identical points, equals |b - a|', () => {
  for (const { a, b } of BATTERY) {
    assert.equal(distance3(a, a), 0);
    assert.ok(near(distance3(a, b), distance3(b, a)), `symmetry ${a} ${b}`);
    assert.ok(near(distance3(a, b), len3(sub3(b, a))), `distance = |b-a| ${a} ${b}`);
    assert.ok(near(distance3(a, b), len3(sub3(a, b))), `distance = |a-b| ${a} ${b}`);
  }
  assert.equal(distance3([0, 0, 0], [3, 4, 0]), 5);
  assert.equal(distance3([1, 1, 1], [1, 1, 1]), 0);
});

test('vecmath: reflect across a coordinate plane flips only the normal component', () => {
  assert.deepEqual([...reflect3([1, -1, 0], [0, 1, 0])], [1, 1, 0]);
  assert.deepEqual([...reflect3([2, 3, 4], [0, 0, 1])], [2, 3, -4]);
  assert.deepEqual([...reflect3([2, 3, 4], [1, 0, 0])], [-2, 3, 4]);
  // Tangential components untouched, normal component negated, for a
  // general v against the floor plane.
  const v: Vec3 = [0.6, -0.8, 0];
  assert.ok(vecNear(reflect3(v, [0, 1, 0]), [0.6, 0.8, 0]));
});

test('vecmath: reflect is an involution and preserves length (unit normal)', () => {
  const normals: Vec3[] = [[0, 1, 0], [1, 0, 0], [0, 0, 1], norm3([1, 2, 3]), norm3([-2, 1, 0.5])];
  const vs: Vec3[] = [[1, 2, 3], [0.6, -0.8, 0], [-1.5, 2.25, 0.75], [3, 4, 0]];
  for (const n of normals) {
    for (const v of vs) {
      const r = reflect3(v, n);
      assert.ok(near(len3(r), len3(v), 1e-9), `|reflect(v)| = |v| for ${v} off ${n}`);
      assert.ok(vecNear(reflect3(r, n), v, 1e-9), `reflect twice = original for ${v} off ${n}`);
    }
  }
});

test('vecmath: reflect negative control - a non-unit normal breaks the involution', () => {
  // The contract says n must be unit. Feeding n = 2y-hat must NOT
  // silently behave like a reflection: the formula overshoots, which
  // is exactly what the identity tests above would catch if reflect3
  // secretly renormalized (or if the formula lost its factor of 2).
  const r = reflect3([1, -1, 0], [0, 2, 0]);
  assert.ok(!vecNear(r, [1, 1, 0], 1e-9));
  assert.ok(!near(len3(r), len3([1, -1, 0]), 1e-9));
});

test('vecmath: lerp endpoints are exact and the midpoint is the mean', () => {
  assert.equal(lerp(2, 10, 0), 2);
  assert.equal(lerp(2, 10, 1), 10);
  assert.equal(lerp(2, 10, 0.5), 6);
  assert.equal(lerp(-4, 4, 0.25), -2);
  assert.deepEqual([...lerp3([0, 0, 0], [4, 8, 12], 0)], [0, 0, 0]);
  assert.deepEqual([...lerp3([0, 0, 0], [4, 8, 12], 1)], [4, 8, 12]);
  assert.deepEqual([...lerp3([0, 0, 0], [4, 8, 12], 0.5)], [2, 4, 6]);
  assert.deepEqual([...lerp3([1, 2, 3], [4, 5, 6], 0.5)], [2.5, 3.5, 4.5]);
});

test('vecmath: lerp extrapolates - t is NOT clamped (documented contract)', () => {
  // Contract: lerp/lerp3 are the raw a + (b - a) t; callers who want
  // clamping compose with clamp. t = 2 and t = -1 must overshoot.
  assert.equal(lerp(2, 10, 2), 18);
  assert.equal(lerp(2, 10, -1), -6);
  assert.deepEqual([...lerp3([0, 0, 0], [4, 8, 12], 2)], [8, 16, 24]);
  assert.deepEqual([...lerp3([0, 0, 0], [4, 8, 12], -0.5)], [-2, -4, -6]);
});

test('vecmath: clamp below, inside, above - exact', () => {
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(42, 0, 10), 10);
  assert.equal(clamp(0, 0, 10), 0);
  assert.equal(clamp(10, 0, 10), 10);
  assert.equal(clamp(2.5, -1, 1), 1);
  assert.equal(clamp(-2.5, -1, 1), -1);
  assert.equal(clamp(0.25, -1, 1), 0.25);
});

test('vecmath: clamp3 clamps each component against scalar bounds', () => {
  assert.deepEqual([...clamp3([-5, 0.5, 99], 0, 1)], [0, 0.5, 1]);
  assert.deepEqual([...clamp3([1, 2, 3], 0, 10)], [1, 2, 3]);
  assert.deepEqual([...clamp3([-1, -2, -3], -1.5, 1.5)], [-1, -1.5, -1.5]);
});

test('vecmath: clamp3v clamps each component against per-axis bounds', () => {
  assert.deepEqual([...clamp3v([5, -5, 0.25], [0, -1, 0], [4, 1, 0.5])], [4, -1, 0.25]);
  assert.deepEqual([...clamp3v([1, 2, 3], [0, 0, 0], [10, 10, 10])], [1, 2, 3]);
});

test('vecmath: out-parameter forms write into the caller buffer', () => {
  const out = v3();
  assert.equal(cross3([1, 0, 0], [0, 1, 0], out), out);
  assert.deepEqual([...out], [0, 0, 1]);
  assert.equal(reflect3([1, -1, 0], [0, 1, 0], out), out);
  assert.deepEqual([...out], [1, 1, 0]);
  assert.equal(clamp3([9, -9, 0.5], 0, 1, out), out);
  assert.deepEqual([...out], [1, 0, 0.5]);
  // add3/sub3/scale3 unchanged, for the record.
  assert.deepEqual([...add3(v3(1, 1, 1), v3(1, 2, 3))], [2, 3, 4]);
  assert.deepEqual([...sub3(v3(1, 2, 3), v3(1, 1, 1))], [0, 1, 2]);
  assert.deepEqual([...scale3(v3(1, -2, 3), 2)], [2, -4, 6]);
});
