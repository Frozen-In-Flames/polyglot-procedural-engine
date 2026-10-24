// math/vec.ts - THE canonical vecmath core. Tuples, no allocation
// inside hot paths where avoidable.
//
// This module is the engine's one home for the eight classic vector
// primitives (v3.3.0; reference: docs/vector-math.md):
//   dot product, normalize, distance, reflection, clamp, vector
//   length, lerp, cross product - plus the lengthSquared companion
//   used for sqrt-free comparisons. New code imports these from here;
//   older modules that grew private copies delegate to this core
//   wherever delegation is bit-exact (see the audit in
//   docs/vector-math.md for what was consolidated and what was
//   deliberately left on its own rounding path).
//
// Contracts that are easy to get wrong, stated once, here:
//   - norm3 NEVER throws and never invents a direction: the zero
//     vector normalizes to the zero vector (the `|| 1` guard below).
//     This is the engine's long-standing convention, kept.
//   - reflect3 applies r = v - 2 (v . n) n exactly as written. The
//     normal n MUST be unit length; a non-unit n overshoots on
//     purpose rather than being silently renormalized.
//   - lerp/lerp3 do NOT clamp t: t outside [0, 1] extrapolates.
//     Callers who want clamping compose with clamp/clamp3.
//   - clamp assumes lo <= hi (his equation: max(min(x, hi), lo)).
// The Python oracle port is python/xrgen/vecmath.py; the identity
// suites test/vecmath.test.ts and python/test/test_vecmath.py run
// the same fixed battery through both.
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];

export function add3(a: Vec3, b: Vec3, out: Vec3 = v3()): Vec3 {
  out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
  return out;
}
export function sub3(a: Vec3, b: Vec3, out: Vec3 = v3()): Vec3 {
  out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
  return out;
}
export function scale3(a: Vec3, s: number, out: Vec3 = v3()): Vec3 {
  out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
  return out;
}
export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross3(a: Vec3, b: Vec3, out: Vec3 = v3()): Vec3 {
  out[0] = a[1] * b[2] - a[2] * b[1];
  out[1] = a[2] * b[0] - a[0] * b[2];
  out[2] = a[0] * b[1] - a[1] * b[0];
  return out;
}
export function len3(a: Vec3): number {
  return Math.sqrt(dot3(a, a));
}
export function norm3(a: Vec3, out: Vec3 = v3()): Vec3 {
  const l = len3(a) || 1;
  return scale3(a, 1 / l, out);
}
export function lerp3(a: Vec3, b: Vec3, t: number, out: Vec3 = v3()): Vec3 {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

// ---------------------------------------------------------------------------
// v3.3.0: the rest of the classic eight, in canonical form. dot3,
// cross3, len3, norm3 and lerp3 above are primitives 1, 8, 6, 2 and 7;
// the additions below are 3 (distance), 4 (reflection), 5 (clamp),
// the scalar half of 7 (lerp), and the lengthSquared companion of 6.
// ---------------------------------------------------------------------------

/** Squared length: dot(a, a). The sqrt-free comparison form of len3. */
export function lengthSquared3(a: Vec3): number {
  return dot3(a, a);
}

/** Distance between two points: |b - a|. */
export function distance3(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Reflection of v off the plane with UNIT normal n:
 * r = v - 2 (v . n) n. n is used exactly as given (see the contract
 * in the header): pass a normalized normal.
 */
export function reflect3(v: Vec3, n: Vec3, out: Vec3 = v3()): Vec3 {
  const d = 2 * dot3(v, n);
  out[0] = v[0] - d * n[0];
  out[1] = v[1] - d * n[1];
  out[2] = v[2] - d * n[2];
  return out;
}

/** Scalar clamp: max(min(x, hi), lo). Assumes lo <= hi. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(x, hi));
}

/** Component-wise clamp of a vector against scalar bounds. */
export function clamp3(a: Vec3, lo: number, hi: number, out: Vec3 = v3()): Vec3 {
  out[0] = clamp(a[0], lo, hi);
  out[1] = clamp(a[1], lo, hi);
  out[2] = clamp(a[2], lo, hi);
  return out;
}

/** Component-wise clamp of a vector against per-axis bounds. */
export function clamp3v(a: Vec3, lo: Vec3, hi: Vec3, out: Vec3 = v3()): Vec3 {
  out[0] = clamp(a[0], lo[0], hi[0]);
  out[1] = clamp(a[1], lo[1], hi[1]);
  out[2] = clamp(a[2], lo[2], hi[2]);
  return out;
}

/** Scalar lerp: a + (b - a) t. t is not clamped (see header). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
