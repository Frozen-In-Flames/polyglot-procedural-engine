// math/bandlimit.ts - band-limiting for raymarched procedural detail.
//
// A pixel at ray distance t covers a world-space footprint
//   Delta x(t) = t * delta,   delta = 2 tan(fov/2) / H
// (delta is the angular size of one pixel: the frustum is 2 tan(fov/2)
// wide at distance 1, spread over H rows). Detail finer than ~2 footprints
// aliases (shimmer); the two rules below remove it at the source:
//
//   1. The hit epsilon scales with distance: eps(t) = t * delta. Far
//      surfaces terminate the march earlier (fewer steps) instead of
//      hunting sub-pixel features.
//   2. fBm octaves fade out once their wavelength drops below ~2 pixel
//      footprints: octave frequency f_k = f_0 2^k keeps full weight while
//      f_k <= 1/(4 Delta x) and reaches zero at the Nyquist rate
//      f_k = 1/(2 Delta x). The fade is a smoothstep (zero slope at both
//      joints), not a kinked clamp, so dw_k/dt stays finite and the
//      Lipschitz bound below remains valid.

import { pcgHash32 } from './determinism.js';

/** Angular size of one pixel (radians): frustum width at distance 1 over H. */
export function pixelAngularSize(fovY: number, h: number): number {
  return (2 * Math.tan(fovY / 2)) / h;
}

/** World-space pixel footprint at ray distance t. */
export function footprint(t: number, delta: number): number {
  return t * delta;
}

/** Distance-scaled hit epsilon, floored at the absolute SDF_EPS. */
export function epsForDistance(t: number, delta: number, floor = 1e-3): number {
  return Math.max(floor, t * delta);
}

function smoothstep01(s: number): number {
  const c = Math.min(1, Math.max(0, s));
  return c * c * (3 - 2 * c);
}

/**
 * Fade weights for fBm octaves at footprint dx (world units).
 * f_k = f0 * 2^k. w_k = 1 - smoothstep(s), s = 4 f_k dx - 1, so w_k = 1
 * while f_k <= 1/(4 dx) and w_k = 0 at f_k >= 1/(2 dx). The smoothstep
 * (not a kinked clamp) gives dw_k/dx = 0 at both joints and
 * |dw_k/dx| <= 6 f_k everywhere inside, which keeps the displaced-field
 * Lipschitz bound finite.
 */
export function octaveFadeWeights(f0: number, octaves: number, dx: number): number[] {
  const w: number[] = [];
  for (let k = 0; k < octaves; k++) {
    const fk = f0 * 2 ** k;
    w.push(1 - smoothstep01(4 * fk * dx - 1));
  }
  return w;
}

/**
 * Max |dw_k/dt| from the fade: dx = t * delta, dw_k/dx <= 6 f_k, so
 * |dw_k/dt| <= 6 f_k delta. Used in the displaced Lipschitz bound.
 */
export function fadeSlopeMax(fk: number, delta: number): number {
  return 6 * fk * delta;
}

// ---------------------------------------------------------------------------
// Band-limited value noise on the canonical PCG hash (all new noise uses
// PCG; the legacy hash3 path is untouched). Lattice coordinates are mixed
// into one uint32 and hashed once per corner; fade is the quintic from
// determinism.ts (multiply/add only).
// ---------------------------------------------------------------------------

/** Lattice corner hash (exported so noisegrad.ts uses identical corners). */
export function latticeHash(xi: number, yi: number, zi: number, seed: number): number {
  let m = Math.imul(xi | 0, 374761393) ^ Math.imul(yi | 0, 668265263);
  m = Math.imul(m ^ Math.imul(zi | 0, 1440662683), 1013904223);
  m ^= seed | 0;
  return pcgHash32(m >>> 0) / 4294967296;
}

function quintic(t: number): number {
  return t * t * t * (t * (6 * t - 15) + 10);
}

/** Value noise in [0, 1] on the PCG lattice hash, quintic fade. */
export function valueNoisePcg(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = quintic(xf), v = quintic(yf), w = quintic(zf);
  const c000 = latticeHash(xi, yi, zi, seed);
  const c100 = latticeHash(xi + 1, yi, zi, seed);
  const c010 = latticeHash(xi, yi + 1, zi, seed);
  const c110 = latticeHash(xi + 1, yi + 1, zi, seed);
  const c001 = latticeHash(xi, yi, zi + 1, seed);
  const c101 = latticeHash(xi + 1, yi, zi + 1, seed);
  const c011 = latticeHash(xi, yi + 1, zi + 1, seed);
  const c111 = latticeHash(xi + 1, yi + 1, zi + 1, seed);
  const x00 = c000 + (c100 - c000) * u;
  const x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u;
  const x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

/**
 * Band-limited fBm: n(x) = sum_k a^k w_k N(2^k x), weights from
 * octaveFadeWeights at footprint dx. Octaves past Nyquist contribute
 * exactly zero, so far detail cannot shimmer.
 */
export function fbmBandLimited(
  x: number, y: number, z: number,
  seed: number, octaves: number, dx: number, f0 = 1, persistence = 0.5,
): number {
  const w = octaveFadeWeights(f0, octaves, dx);
  let sum = 0, amp = 1, freq = f0, norm = 0;
  for (let k = 0; k < octaves; k++) {
    if (w[k] > 0) {
      sum += amp * w[k] * valueNoisePcg(x * freq, y * freq, z * freq, seed + k * 131);
      norm += amp * w[k];
    }
    amp *= persistence;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0.5;
}

// ---------------------------------------------------------------------------
// Lipschitz bounds for displaced fields.
//
// A displaced field f_d(p) = f(p) + A m(p) with octave noise
// m(p) = sum_k c_k w_k N(g_k p), |N| <= 1, has
//   L <= L_f + A * L_N * sum_k c_k g_k w_k
// (each octave contributes amplitude c_k times frequency g_k times the
// base noise Lipschitz L_N). For the spec's canonical fBm
// (c_k = a^k, g_k = 2^k) this is L_f + A L_N sum_k (2a)^k w_k.
// The fade contributes a slope term along the ray: with |dw_k/dt| <=
// fadeSlopeMax(f_k, delta) and |N| <= 1,
//   L_slope <= A * sum_k c_k |dw_k/dt|.
// ---------------------------------------------------------------------------

/** Base value-noise Lipschitz constant for the legacy smoothstep-fade
 *  noise (valueNoise3/fbm3): per-component slope <= 1.5, so
 *  |grad N| <= 1.5 sqrt(3). */
export const NOISE_LIPSCHITZ = 1.5 * Math.sqrt(3);

/** Same for the quintic-fade PCG noise (valueNoisePcg): per-component
 *  slope <= 1.875, so |grad N| <= 1.875 sqrt(3). */
export const NOISE_LIPSCHITZ_QUINTIC = 1.875 * Math.sqrt(3);

export interface DisplaceBoundOpts {
  /** Lipschitz bound of the undisplaced field. */
  childL: number;
  /** Displacement amplitude A. */
  amp: number;
  /** Base noise Lipschitz constant (NOISE_LIPSCHITZ for value noise). */
  noiseL: number;
  /** Per-octave relative amplitudes c_k. */
  octaveAmp: number[];
  /** Per-octave relative frequencies g_k. */
  octaveFreq: number[];
  /** Fade weights w_k (default all 1). */
  weights?: number[];
  /** Extra slope term from dw_k/dt (default 0). */
  slopeExtra?: number;
}

/** Lipschitz bound for f + A * sum_k c_k w_k N(g_k p). */
export function lipschitzDisplace(o: DisplaceBoundOpts): number {
  const w = o.weights;
  let s = 0;
  for (let k = 0; k < o.octaveAmp.length; k++) {
    s += o.octaveAmp[k] * o.octaveFreq[k] * (w ? w[k] ?? 1 : 1);
  }
  return o.childL + o.amp * o.noiseL * s + (o.slopeExtra ?? 0);
}
