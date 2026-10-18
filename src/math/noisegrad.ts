// math/noisegrad.ts - analytic gradients of quintic value noise.
//
// Closes the Lipschitz-table gap for displacement: the displaced field
// f + A n(x) needs a bound on the NOISE gradient, not just the noise.
//
// The noise here is valueNoisePcg (bandlimit.ts): PCG lattice hash,
// quintic fade S(t) = 6t^5-15t^4+10t^3. In k-coefficient form with
// u = S(f_x), v = S(f_y), w = S(f_z):
//   n = k_0+k_1 u+k_2 v+k_3 w+k_4 uv+k_5 uw+k_6 vw+k_7 uvw
//   k_0 = v_000
//   k_1 = v_100-v_000,  k_2 = v_010-v_000,  k_3 = v_001-v_000
//   k_4 = v_000-v_100-v_010+v_110
//   k_5 = v_000-v_100-v_001+v_101
//   k_6 = v_000-v_010-v_001+v_011
//   k_7 = -v_000+v_100+v_010-v_110+v_001-v_101-v_011+v_111
// and
//   dn/dx = S'(f_x)(k_1+k_4 v+k_5 w+k_7 v w),  cyclically for y, z.
//
// Bound: each partial is S' (<= 1.875) times a convex combination of
// corner edge differences, so with R = max edge difference,
//   ||grad N|| <= sqrt(3) * 1.875 * R  ≈  3.25 R.
// For fBm the chain rule gives
//   grad sum_k a^k N(2^k x) = sum_k (2a)^k grad N(2^k x),
// hence L_n <= A * 3.25 * R * sum_k (2a)^k w_k. The octave fade weights
// are treated as constant in the chain rule; that is an approximation,
// documented here (the dw_k/dt slope term is handled separately in
// bandlimit.ts fadeSlopeMax).
//
// All techniques are classical public mathematics; see
// docs/methods-provenance.md.

import type { Vec3 } from './vec.js';
import { latticeHash, octaveFadeWeights } from './bandlimit.js';

/** Quintic fade S(t) = 6t^5-15t^4+10t^3. */
export function quinticS(t: number): number {
  return t * t * t * (t * (6 * t - 15) + 10);
}

/** S'(t) = 30 t^2 (1-t)^2. Max 1.875 at t = 1/2; vanishes at 0 and 1. */
export function quinticSPrime(t: number): number {
  const u = t * (1 - t);
  return 30 * u * u;
}

/** S''(t) = 60 t (2t-1)(t-1). Vanishes at 0, 1/2, and 1. */
export function quinticSDoublePrime(t: number): number {
  return 60 * t * (2 * t - 1) * (t - 1);
}

export interface NoiseSample {
  n: number;
  grad: Vec3;
}

/**
 * Value noise and its analytic gradient, using the identical lattice
 * corners as valueNoisePcg (bandlimit.ts), so n matches it.
 */
export function valueNoisePcgGrad(x: number, y: number, z: number, seed: number): NoiseSample {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = quinticS(fx), v = quinticS(fy), w = quinticS(fz);
  const du = quinticSPrime(fx), dv = quinticSPrime(fy), dw = quinticSPrime(fz);
  const v000 = latticeHash(xi, yi, zi, seed);
  const v100 = latticeHash(xi + 1, yi, zi, seed);
  const v010 = latticeHash(xi, yi + 1, zi, seed);
  const v110 = latticeHash(xi + 1, yi + 1, zi, seed);
  const v001 = latticeHash(xi, yi, zi + 1, seed);
  const v101 = latticeHash(xi + 1, yi, zi + 1, seed);
  const v011 = latticeHash(xi, yi + 1, zi + 1, seed);
  const v111 = latticeHash(xi + 1, yi + 1, zi + 1, seed);
  const k1 = v100 - v000, k2 = v010 - v000, k3 = v001 - v000;
  const k4 = v000 - v100 - v010 + v110;
  const k5 = v000 - v100 - v001 + v101;
  const k6 = v000 - v010 - v001 + v011;
  const k7 = -v000 + v100 + v010 - v110 + v001 - v101 - v011 + v111;
  const n =
    v000 + k1 * u + k2 * v + k3 * w + k4 * u * v + k5 * u * w + k6 * v * w + k7 * u * v * w;
  const gx = du * (k1 + k4 * v + k5 * w + k7 * v * w);
  const gy = dv * (k2 + k4 * u + k6 * w + k7 * u * w);
  const gz = dw * (k3 + k5 * u + k6 * v + k7 * u * v);
  return { n, grad: [gx, gy, gz] };
}

/** Gradient magnitude bound for one noise octave: sqrt(3)*1.875*R. */
export function noiseGradBound(R: number): number {
  return Math.sqrt(3) * 1.875 * R;
}

/**
 * fBm value and analytic gradient by the chain rule:
 *   grad sum_k a^k w_k N(2^k x) = sum_k (a^k w_k)(2^k) grad N(2^k x).
 * Fade weights w_k are treated as constant (documented approximation);
 * use octaveFadeWeights for band-limited weights at footprint dx.
 */
export function fbmBandLimitedGrad(
  x: number, y: number, z: number,
  seed: number, octaves: number, dx: number, f0 = 1, persistence = 0.5,
): NoiseSample {
  const w = octaveFadeWeights(f0, octaves, dx);
  let sum = 0, gx = 0, gy = 0, gz = 0;
  let amp = 1, freq = f0, norm = 0;
  for (let k = 0; k < octaves; k++) {
    if (w[k] > 0) {
      const s = valueNoisePcgGrad(x * freq, y * freq, z * freq, seed + k * 131);
      const c = amp * w[k];
      sum += c * s.n;
      // Chain rule: d/dx N(freq*x) = freq * dN/dX.
      gx += c * freq * s.grad[0];
      gy += c * freq * s.grad[1];
      gz += c * freq * s.grad[2];
      norm += c;
    }
    amp *= persistence;
    freq *= 2;
  }
  if (norm > 0) {
    sum /= norm; gx /= norm; gy /= norm; gz /= norm;
  } else {
    sum = 0.5;
  }
  return { n: sum, grad: [gx, gy, gz] };
}

/**
 * Lipschitz bound on the fBm gradient magnitude:
 *   L_n <= A * 3.25 * R * sum_k (2a)^k w_k.
 * With a = persistence and default weights 1 this is the worst case;
 * pass band-limited weights for the tighter form.
 */
export function fbmGradLipschitz(
  A: number, R: number, persistence: number, octaves: number, weights?: number[],
): number {
  let s = 0;
  for (let k = 0; k < octaves; k++) s += (2 * persistence) ** k * (weights ? weights[k] ?? 1 : 1);
  return A * 3.25 * R * s;
}
