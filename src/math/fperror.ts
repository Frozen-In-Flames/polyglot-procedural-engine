// math/fperror.ts - determinism harness: float error model, exact
// summation, ULP distance, FNV-1a goldens, fixed-tree reductions.
//
// Float error model: fl(x op y) = (x op y)(1 + delta), |delta| <= u.
// NaN/infinity policy (defined here, not left implicit):
//   - +0 and -0 are 0 ulps apart (they compare equal).
//   - Infinities of the same sign are 0 ulps apart.
//   - Opposite infinities, and anything vs NaN (including NaN vs NaN),
//     are infinitely far apart.
//   - A finite vs an infinite is infinitely far apart.
// Rationale: ULP distance is only meaningful on finite reals; the policy
// keeps every comparison total and deterministic.

/**
 * FNV-1a 32-bit over UTF-8 bytes. h_0 = 2166136261,
 * h <- (h xor byte) * 16777619, mod 2^32.
 * MUST use Math.imul: (h ^ byte) * 16777619 in float64 exceeds 2^53 and
 * silently loses low bits (the empty-string and "a" vectors cannot catch
 * this; "foobar" = 0xBF9CF968 and the BigInt oracle comparison can).
 */
export function fnv1a_32(s: string): number {
  const bytes = new TextEncoder().encode(s);
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i], 16777619);
  }
  return h >>> 0;
}

/** Kahan compensated summation. */
export function kahanSum(xs: number[]): number {
  let sum = 0, c = 0;
  for (const x of xs) {
    const y = x - c;
    const t = sum + y;
    c = t - sum - y;
    sum = t;
  }
  return sum;
}

/**
 * Knuth 2Sum: returns [s, e] with s = fl(a+b) and a + b = s + e exactly
 * (e is the rounding error). No ordering requirement (6 flops).
 */
export function twoSum(a: number, b: number): [number, number] {
  const s = a + b;
  const ap = s - b;
  const bp = s - ap;
  const e = a - ap + (b - bp);
  return [s, e];
}

/** Bit pattern of a float64 as a BigInt. */
function bits(x: number): bigint {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, x);
  return new DataView(buf).getBigUint64(0);
}

/** Ordered integer key: maps floats to integers preserving order. */
function orderedKey(x: number): bigint {
  const b = bits(x);
  const sign = 1n << 63n;
  // Flip the sign bit for positives, flip all bits for negatives.
  return b & sign ? ~b : b ^ sign;
}

/**
 * ULP distance between two float64 values under the NaN/infinity policy
 * documented at the top of this module. Returns Infinity when the policy
 * says the values are incomparable.
 */
export function ulpDistance(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return a === b ? 0 : Infinity;
  }
  if (a === b) return 0; // catches +0 vs -0
  const ka = orderedKey(a), kb = orderedKey(b);
  const d = ka > kb ? ka - kb : kb - ka;
  return d <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(d) : Infinity;
}

/**
 * Fixed binary-tree reduction: pairwise summation in index order.
 * Deterministic (a pure function of the input array); parallel workers
 * must combine in this same fixed order to reproduce it bit-for-bit.
 */
export function treeSum(xs: number[]): number {
  if (xs.length === 0) return 0;
  let cur = xs.slice();
  while (cur.length > 1) {
    const next: number[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? cur[i] + cur[i + 1] : cur[i]);
    }
    cur = next;
  }
  return cur[0];
}
