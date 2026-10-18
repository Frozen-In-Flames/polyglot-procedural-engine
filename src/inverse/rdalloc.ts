// inverse/rdalloc.ts - rate-distortion allocation for quantized theta.
//
// Quantizing theta_i with step D_i adds variance D_i^2/12 (uniform
// quantization noise). Image MSE increase:
//   dD approx (1/n) sum_i s_i D_i^2 / 12,  s_i = ||dr/dtheta_i||^2.
// Equal budget share: D_i = sqrt(12 n D / (p s_i)),
//   b_i = log2((theta_hi - theta_lo)/D_i).
// Correlated columns: quantize in the SVD basis (dtheta = V dz):
//   dD approx (1/12n) sum_k sigma_k^2 dz_k^2.

/** Sensitivities s_i = ||dr/dtheta_i||^2 from the Jacobian J (m x p). */
export function sensitivities(J: number[][]): number[] {
  const m = J.length;
  const p = J[0].length;
  const s = new Array(p).fill(0);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < p; j++) s[j] += J[i][j] * J[i][j];
  }
  return s;
}

/**
 * Equal-budget step sizes: D_i = sqrt(12 n D / (p s_i)) for a target
 * total MSE increase D. Optionally also returns bit counts b_i for
 * parameter ranges [lo, hi].
 */
export function equalBudgetSteps(
  s: number[],
  n: number,
  p: number,
  D: number,
  ranges?: Array<[number, number]>,
): { steps: number[]; bits: number[] } {
  const steps = s.map((si) => Math.sqrt((12 * n * D) / (p * Math.max(si, 1e-300))));
  const bits = ranges
    ? ranges.map(([lo, hi], i) => Math.log2((hi - lo) / steps[i]))
    : steps.map(() => 0);
  return { steps, bits };
}

/** Predicted MSE increase: (1/n) sum_i s_i D_i^2 / 12. */
export function predictedMSEIncrease(s: number[], D: number[], n: number): number {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i] * D[i] * D[i];
  return sum / (12 * n);
}

/** Uniform quantization: round each theta_i to a multiple of D_i. */
export function quantize(theta: number[], D: number[]): number[] {
  return theta.map((t, i) => Math.round(t / D[i]) * D[i]);
}
