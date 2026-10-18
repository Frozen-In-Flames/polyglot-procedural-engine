// inverse/conditioning.ts - conditioning diagnostics for solved parameters.
//
// After a solve, the finite-difference Jacobian J = dr/dtheta at the
// solution is decomposed (J = U Sigma V^T) and the singular values are
// reported in the solve log. Near-zero singular values mean unidentifiable
// parameter combinations: the data cannot tell them apart, and the solve
// log must say so loudly instead of shipping a confident-looking theta.
//
// DOCUMENTED AMBIGUITIES (exact null directions in J):
// - Albedo vs light intensity: only the product rho * E * (n.l) is
//   visible, so (rho, E) -> (s*rho, E/s) leaves every pixel unchanged:
//   an exact null vector, sigma = 0 up to finite-difference noise.
// - Generalized bas-relief: with b = rho n (scaled normal) and light
//   vector s, the transform b' = G^{-T} b, s' = G s leaves
//   b'^T s' = b^T s for G = [[1,0,0],[0,1,0],[mu,nu,lambda]], lambda != 0.
//   The GBR parameters (mu, nu, lambda) are invisible: null directions.
//
// THE FIX (documented): Tikhonov regularization,
//   min ||r(theta)||^2 + mu ||Gamma theta||^2,
// with optional mu (Gamma = I by default; pass a scale vector for a
// diagonal Gamma). The mu parameter rides GdOpts.

/** Jacobi eigenvalue decomposition of a symmetric n x n matrix. */
export function jacobiEigen(A: number[][]): { values: number[]; vectors: number[][] } {
  const n = A.length;
  const a = A.map((row) => row.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        off += Math.abs(a[p][q]);
        if (Math.abs(a[p][q]) > 1e-15) {
          const app = a[p][p], aqq = a[q][q], apq = a[p][q];
          const theta = (aqq - app) / (2 * apq);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1);
          const s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = a[k][p], akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[k][q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = a[p][k], aqk = a[q][k];
            a[p][k] = c * apk - s * aqk;
            a[q][k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = v[k][p], vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq;
            v[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    if (off < 1e-14) break;
  }
  return { values: a.map((row, i) => row[i]), vectors: v };
}

/**
 * Singular values of J (m x n) via the eigen-decomposition of J^T J.
 * Columns are normalized to unit norm first: raw column scales (albedo
 * in the thousands, angles in radians) are not rank deficiency, so the
 * diagnostic separates scaling from true null directions. Returns the
 * singular values of the NORMALIZED Jacobian plus the column scales.
 */
export function singularValues(J: number[][]): { sigma: number[]; scales: number[] } {
  const m = J.length;
  const n = J[0].length;
  const scales: number[] = [];
  const Jn: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < m; i++) s += J[i][j] * J[i][j];
    s = Math.sqrt(s);
    scales.push(s);
  }
  const maxScale = Math.max(...scales, 0);
  for (let j = 0; j < n; j++) {
    // Degenerate columns (invisible parameters) stay zero: normalizing
    // finite-difference noise would manufacture a fake direction.
    if (scales[j] < FD_INVISIBLE_FLOOR * Math.max(1, maxScale)) continue;
    for (let i = 0; i < m; i++) Jn[i][j] = J[i][j] / scales[j];
  }
  // JtJ = Jn^T Jn (n x n, symmetric).
  const JtJ: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < m; i++) {
    for (let p = 0; p < n; p++) {
      for (let q = 0; q < n; q++) JtJ[p][q] += Jn[i][p] * Jn[i][q];
    }
  }
  const { values, vectors } = jacobiEigen(JtJ);
  const order = values
    .map((v, i) => i)
    .sort((a, b) => values[b] - values[a]);
  return {
    sigma: order.map((i) => Math.sqrt(Math.max(0, values[i]))),
    scales,
  };
}

export interface ConditioningReport {
  /** Singular values of the column-normalized Jacobian, descending. */
  sigma: number[];
  /** Condition number kappa = sigma_max / sigma_min. */
  kappa: number;
  /** Column scales removed before the SVD. */
  scales: number[];
  /** Loud warnings for near-zero directions (empty when healthy). */
  warnings: string[];
}

/** Absolute Jacobian-column floor below which a parameter is declared
 *  invisible. Central differences on O(1) residuals have a rounding floor
 *  ~eps_mach/h ~= 2e-11; this is ~50x above it, with margin. */
export const FD_INVISIBLE_FLOOR = 1e-9;

/** Diagnose J: singular values, condition number, null-direction warnings. */
export function diagnoseConditioning(J: number[][], tol = 1e-8): ConditioningReport {
  const { sigma, scales } = singularValues(J);
  const smax = sigma[0] ?? 0;
  const smin = sigma[sigma.length - 1] ?? 0;
  const kappa = smin > 0 ? smax / smin : Infinity;
  const warnings: string[] = [];
  scales.forEach((s, j) => {
    if (s < FD_INVISIBLE_FLOOR) {
      warnings.push(
        `parameter ${j} has no measurable effect on the residuals ` +
          `(zero Jacobian column): invisible parameter, check the ` +
          `albedo-intensity and bas-relief ambiguity notes`,
      );
    }
  });
  sigma.forEach((s, i) => {
    if (smax > 0 && s / smax < tol) {
      warnings.push(
        `near-zero singular value sigma[${i}] = ${s.toExponential(2)} ` +
          `(relative ${(s / smax).toExponential(1)}): unidentifiable parameter ` +
          `combination; see the albedo-intensity and bas-relief ambiguity notes`,
      );
    }
  });
  return { sigma, kappa, scales, warnings };
}

/**
 * Finite-difference Jacobian of residuals r(theta) at theta (m x n).
 * Central differences, same documented step as the gradient driver.
 */
export function finiteJacobian(
  r: (theta: number[]) => number[],
  theta: number[],
  eps = 1e-5,
): number[][] {
  const n = theta.length;
  const r0 = r(theta);
  const m = r0.length;
  const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    const h = eps * Math.max(1, Math.abs(theta[j]));
    const tp = theta.slice(); tp[j] = theta[j] + h;
    const tm = theta.slice(); tm[j] = theta[j] - h;
    const rp = r(tp), rm = r(tm);
    for (let i = 0; i < m; i++) J[i][j] = (rp[i] - rm[i]) / (2 * h);
  }
  return J;
}

/**
 * Quantization noise floor for 8-bit targets. A uniform [0,1] target
 * quantized to 8 bits has variance 1/12 LSB^2, so sigma_n = 1/(255 sqrt(12)).
 * Solver diagnostics use this as the noise floor, and the effective
 * sample count n_eff (< n, consistent with the AIC effective-n rule)
 * wherever the resolve filter correlates neighboring pixels.
 */
export const SIGMA_N_8BIT = 1 / (255 * Math.sqrt(12));
