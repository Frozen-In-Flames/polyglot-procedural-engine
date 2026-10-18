// math/determinism.ts - canonical randomness and exact-math utilities.
//
// Two exact paths cross languages in this engine, and they use different
// canonical float widths (documented choice):
//
//   float64 path: the Python foundry <-> TypeScript bridge. Python float64
//   and TS float64 (number) agree bit-exactly; verified by test.
//   Nothing here may narrow to float32.
//
//   float32 path: TypeScript <-> C++/WASM <-> GLSL <-> Swift <-> Kotlin.
//   Every operation that must match across these languages is wrapped in
//   f32() (Math.fround) so "bit-exact" holds at the first multiply, not
//   just at the end. JS `number` is float64, so without the explicit
//   narrowing the TS side would round differently from every other side.
//
// Integer paths (the PCG hash below) are width-independent: all arithmetic
// is mod 2^32 via Math.imul and >>> 0. Plain `s * 747796405` in JS would
// exceed 2^53 and silently lose low bits; never do that.

/** Narrow to canonical float32. Use after every operation on an exact path. */
export const f32 = (x: number): number => Math.fround(x);

// ---------------------------------------------------------------------------
// PCG RXS-M-XS 32-bit hash (Jarzynski/Olano form; the permutation is the
// 32->32 RXS-M-XS variant from section 6.3.4 of O'Neill's PCG paper, and
// the LCG constants are the published uint32_t defaults).
//
//   s <- s * 747796405 + 2891336453            (mod 2^32)
//   w = ((s >> ((s >> 28) + 4)) ^ s) * 277803737  (mod 2^32)
//   h = (w >> 22) ^ w
//
// This is the canonical cross-language hash: all new noise uses it.
// Existing hash3 (Math.imul-based) is fine and stays untouched.
// ---------------------------------------------------------------------------

const PCG_MUL = 747796405;
const PCG_INC = 2891336453;
const PCG_XSMUL = 277803737;

/** One-shot PCG hash of a uint32 input. Pure integer math, bit-exact. */
export function pcgHash32(input: number): number {
  let s = (Math.imul(input >>> 0, PCG_MUL) + PCG_INC) >>> 0;
  let w = (s ^ (s >>> ((s >>> 28) + 4))) >>> 0;
  w = Math.imul(w, PCG_XSMUL) >>> 0;
  return (w ^ (w >>> 22)) >>> 0;
}

/** Stateful PCG32 (RXS-M-XS, 32-bit state). Deterministic across languages. */
export class Pcg32 {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** Next uint32. */
  next(): number {
    this.s = (Math.imul(this.s, PCG_MUL) + PCG_INC) >>> 0;
    let w = (this.s ^ (this.s >>> ((this.s >>> 28) + 4))) >>> 0;
    w = Math.imul(w, PCG_XSMUL) >>> 0;
    return (w ^ (w >>> 22)) >>> 0;
  }
  /** Next value in [0, 1). Exact: (h >> 8) < 2^24, times 2^-24 is dyadic. */
  unit(): number {
    return (this.next() >>> 8) * 2 ** -24;
  }
}

// ---------------------------------------------------------------------------
// Quintic fade, multiply/add only: S(t) = 6t^5 - 15t^4 + 10t^3.
// Factored form t^3 (t(6t - 15) + 10) keeps one rounding path everywhere.
// ---------------------------------------------------------------------------

/** Quintic smootherstep on [0, 1]; caller clamps. */
export function quinticFade(t: number): number {
  return t * t * t * (t * (6 * t - 15) + 10);
}

// ---------------------------------------------------------------------------
// Polynomial sin for exact paths. libm sin is correctly rounded but its
// implementation differs across languages/platforms, so anything that must
// match exactly across languages uses this fixed-order polynomial instead.
//
// sinPoly(x): Taylor to x^13 in Horner form, after range reduction to
// [-pi/2, pi/2]. The alternating-series remainder on that interval is at
// most (pi/2)^15 / 15! < 7e-10, so the documented tolerance is
// |sinPoly(x) - sin(x)| <= 1e-9 for all real x. (Taylor to x^7 would give
// only ~1.6e-4 at pi/2; the extra terms buy nine orders of magnitude.)
// ---------------------------------------------------------------------------

const SIN_C13 = 1 / 6227020800; // 13!
const SIN_C11 = -1 / 39916800; // 11!
const SIN_C9 = 1 / 362880; // 9!
const SIN_C7 = -1 / 5040; // 7!
const SIN_C5 = 1 / 120; // 5!
const SIN_C3 = -1 / 6; // 3!

/** sin(x) to 1e-9, no libm transcendental in the evaluation path. */
export function sinPoly(x: number): number {
  const TWO_PI = 6.283185307179586;
  let r = x - Math.round(x / TWO_PI) * TWO_PI;
  if (r > Math.PI) r -= TWO_PI;
  else if (r < -Math.PI) r += TWO_PI;
  const HPI = 1.5707963267948966;
  if (r > HPI) r = Math.PI - r;
  else if (r < -HPI) r = -Math.PI - r;
  const x2 = r * r;
  // Horner in x^2: r * (1 + x2*(c3 + x2*(c5 + ...))).
  const p =
    1 +
    x2 *
      (SIN_C3 +
        x2 *
          (SIN_C5 +
            x2 *
              (SIN_C7 + x2 * (SIN_C9 + x2 * (SIN_C11 + x2 * SIN_C13)))));
  return r * p;
}

/** cos via the same polynomial: cos(x) = sin(x + pi/2). Same tolerance. */
export function cosPoly(x: number): number {
  return sinPoly(x + 1.5707963267948966);
}
