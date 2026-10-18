// render/reference.ts - reference renderer (validation module).
//
// Rendering equation: L_o = L_e + integral f_r L_i (n . w_i) dw_i.
// GGX importance sampling: phi = 2 pi xi_1,
//   cos theta_h = sqrt((1 - xi_2)/(1 + (alpha^2 - 1) xi_2)),
//   p_l = D(h)(n.h)/(4 (v.h)).
// White-furnace test: E(v) approx (1/N) sum f_r (n . l_i)/p_l(l_i) <= 1.
// Single-scatter GGX only: at high roughness the estimate falls below 1
// because multiple scattering is not compensated. That shortfall is
// documented and pinned by test, not hidden.

import { ggxD, smithVisibility, sampleGgxCosTheta } from '../inverse/forward.js';
import { Pcg32 } from '../math/determinism.js';

export interface FurnaceResult {
  mean: number;
  se: number;
}

/**
 * White-furnace directional albedo for GGX with F0 (F=1 when F0=1).
 * v = +z, white environment L_i = 1, L_e = 0.
 */
export function whiteFurnace(
  alpha: number,
  F0: number,
  nSamples: number,
  seed: number,
): FurnaceResult {
  const g = new Pcg32(seed);
  let sum = 0, sum2 = 0;
  for (let i = 0; i < nSamples; i++) {
    const xi1 = g.unit(), xi2 = g.unit();
    const ch = sampleGgxCosTheta(xi2, alpha);
    const sh = Math.sqrt(Math.max(0, 1 - ch * ch));
    const phi = 2 * Math.PI * xi1;
    const hx = sh * Math.cos(phi), hy = sh * Math.sin(phi);
    // v = +z, so vh = ch; l = 2*vh*h - v.
    const vh = ch;
    const lx = 2 * vh * hx, ly = 2 * vh * hy, lz = 2 * vh * ch - 1;
    const nl = lz;
    let w = 0;
    if (nl > 0 && vh > 0) {
      const D = ggxD(ch, alpha);
      const F = F0 + (1 - F0) * (1 - vh) ** 5;
      const V = smithVisibility(nl, 1, alpha);
      const fr = D * F * V;
      const pl = (D * ch) / (4 * vh);
      w = (fr * nl) / pl;
    }
    sum += w;
    sum2 += w * w;
  }
  const mean = sum / nSamples;
  const se = Math.sqrt(Math.max(0, sum2 / nSamples - mean * mean) / nSamples);
  return { mean, se };
}
