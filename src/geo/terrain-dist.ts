// geo/terrain-dist.ts - conservative distance for heightfields.
//
// For a surface y = h(x,z) with slope bound ||grad h|| <= s and vertical
// gap g = y - h(x,z):
//   f = g / sqrt(1 + s^2)
// is a conservative distance (|f| <= true distance).
//
// Derivation: minimize rho^2 + (g - s rho)^2 over horizontal offset rho
// (the surface can rise at most s per unit horizontal). The minimum is
// g^2/(1+s^2) at rho = s g/(1+s^2), so the distance is >= |g|/sqrt(1+s^2).
//
// Slope bounds:
//   fBm height: s <= A L_N sum_k (2a)^k w_k (grows with octave count
//     when a = 1/2; pass band-limited weights for the tighter form).
//   Bilinear grid: s <= sqrt(2) m, m = largest neighbor slope
//     |Δh|/Δx over the grid.
//
// All techniques are classical public mathematics; see
// docs/methods-provenance.md.

import type { Vec3 } from '../math/vec.js';

/** Conservative distance to the heightfield y = h(x,z). */
export function heightfieldDist(
  h: (x: number, z: number) => number,
  slopeBound: number,
  p: Vec3,
): number {
  const g = p[1] - h(p[0], p[2]);
  return g / Math.sqrt(1 + slopeBound * slopeBound);
}

/**
 * Slope bound for fBm displacement: s <= A L_N sum_k (2a)^k w_k.
 * A = amplitude, L_N = base noise Lipschitz, a = persistence,
 * w_k = octave fade weights (default 1).
 */
export function fbmSlopeBound(
  A: number, noiseL: number, persistence: number, octaves: number, weights?: number[],
): number {
  let s = 0;
  for (let k = 0; k < octaves; k++) s += (2 * persistence) ** k * (weights ? weights[k] ?? 1 : 1);
  return A * noiseL * s;
}

/**
 * Slope bound for a bilinear height grid: s <= sqrt(2) m where m is the
 * largest |Δh|/Δx over all grid neighbors.
 */
export function bilinearSlopeBound(grid: number[][], dx: number): number {
  let m = 0;
  const rows = grid.length;
  for (let j = 0; j < rows; j++) {
    const cols = grid[j].length;
    for (let i = 0; i < cols; i++) {
      if (i + 1 < cols) m = Math.max(m, Math.abs(grid[j][i + 1] - grid[j][i]) / dx);
      if (j + 1 < rows) m = Math.max(m, Math.abs(grid[j + 1][i] - grid[j][i]) / dx);
    }
  }
  return Math.SQRT2 * m;
}
