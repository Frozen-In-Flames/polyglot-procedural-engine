// inverse/reduction.ts - parameter reduction for sliders.
//
// z = V_k^T (theta - theta_bar), V from the SVD of CENTERED example
// parameters. Sliders built on reduced coordinates get CURATED MANUAL
// names: the caller supplies them explicitly. There is deliberately NO
// automatic PCA-to-slider naming; a data-derived label would masquerade
// as a semantic one.

import { jacobiEigen } from './conditioning.js';

export interface Reduction {
  /** Mean of the examples (theta_bar). */
  mean: number[];
  /** Top-k right singular vectors (p x k), columns of V_k. */
  V: number[][];
  /** Curated manual slider names, one per reduced coordinate. */
  names: string[];
}

/**
 * Fit the reduction on example parameter vectors. names.length must
 * equal k; an empty or mismatched list is a loud error, not a fallback
 * to automatic naming.
 */
export function fitReduction(
  examples: number[][],
  k: number,
  names: string[],
): Reduction {
  if (names.length !== k) {
    throw new Error(
      `reduction: need ${k} curated manual names, got ${names.length}; ` +
        `automatic PCA-to-slider naming is not implemented by design`,
    );
  }
  const n = examples.length;
  const p = examples[0].length;
  const mean = new Array(p).fill(0);
  for (const ex of examples) {
    for (let j = 0; j < p; j++) mean[j] += ex[j];
  }
  for (let j = 0; j < p; j++) mean[j] /= n;
  // Covariance of centered examples (p x p); V = its eigenvectors.
  const C: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const ex of examples) {
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < p; j++) {
        C[i][j] += (ex[i] - mean[i]) * (ex[j] - mean[j]);
      }
    }
  }
  const { values, vectors } = jacobiEigen(C);
  const order = values.map((_, i) => i).sort((a, b) => values[b] - values[a]);
  // jacobiEigen returns eigenvectors as COLUMNS: vectors[j][c] is the
  // j-th component of the c-th eigenvector.
  const V: number[][] = Array.from({ length: p }, () => new Array(k).fill(0));
  for (let j = 0; j < p; j++) {
    for (let c = 0; c < k; c++) {
      V[j][c] = vectors[j][order[c]];
    }
  }
  return { mean, V, names };
}

/** Reduce: z = V_k^T (theta - theta_bar). */
export function reduce(red: Reduction, theta: number[]): number[] {
  const k = red.names.length;
  const z = new Array(k).fill(0);
  for (let c = 0; c < k; c++) {
    for (let j = 0; j < theta.length; j++) {
      z[c] += red.V[j][c] * (theta[j] - red.mean[j]);
    }
  }
  return z;
}

/** Expand: theta approx theta_bar + V_k z. */
export function expand(red: Reduction, z: number[]): number[] {
  const p = red.mean.length;
  const theta = red.mean.slice();
  for (let j = 0; j < p; j++) {
    for (let c = 0; c < z.length; c++) theta[j] += red.V[j][c] * z[c];
  }
  return theta;
}
