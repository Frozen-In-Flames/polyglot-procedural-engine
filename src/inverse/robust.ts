// inverse/robust.ts - solver upgrades: Huber/IRLS, LM gain ratio,
// sigmoid bounds, Gaussian pyramid, Eikonal regularizer, uncertainty.
//
// Huber loss with IRLS weights:
//   rho_delta(r) = r^2/2 for |r| <= delta, else delta(|r| - delta/2),
//   w = min(1, delta/|r|).
// LM step acceptance by gain ratio:
//   rho = (L(theta) - L(theta+delta)) / (0.5 delta^T (lambda D delta - g)),
//   g = J^T r, D = diag(J^T J); accept if rho > 0, shrink lambda when
//   rho is large, grow it when rho is small.
// Bounded parameters via sigmoid: theta = lo + (hi - lo) sigma(phi).
// Coarse-to-fine Gaussian pyramid: sigma_k = sigma_0 2^{-k}.
// Eikonal regularizer: R_E = lambda_E integral (||grad f|| - 1)^2 dx.
// Uncertainty: Cov >= sigma_n^2 (J^T J)^{-1},
//   sigma_n^2_hat = RSS/(n_eff - p),
//   confidence ellipsoid (theta-hat)^T (J^T J/sigma_n^2)(theta-hat) <= chi^2.
// For 8-bit targets the noise floor is quantization: sigma_n = 1/(255 sqrt(12))
// (see conditioning.ts); n_eff < n accounts for the resolve filter
// correlating neighboring pixels (consistent with the AIC effective-n rule).

/** IRLS weight for the Huber loss: w = min(1, delta/|r|). */
export function huberWeight(r: number, delta: number): number {
  const ar = Math.abs(r);
  return ar <= delta ? 1 : delta / ar;
}

/**
 * IRLS line fit y = a x + b under the Huber loss. Returns [a, b].
 * Iterates weighted least squares until the weights settle.
 */
export function irlsSolve(xs: number[], ys: number[], delta: number): [number, number] {
  const n = xs.length;
  let a = 0, b = 0;
  // Ordinary least squares start.
  {
    const sx = xs.reduce((s, x) => s + x, 0);
    const sy = ys.reduce((s, y) => s + y, 0);
    const sxx = xs.reduce((s, x) => s + x * x, 0);
    const sxy = xs.reduce((s, x, i) => s + x * ys[i], 0);
    a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    b = (sy - a * sx) / n;
  }
  for (let iter = 0; iter < 50; iter++) {
    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
    for (let i = 0; i < n; i++) {
      const w = huberWeight(a * xs[i] + b - ys[i], delta);
      sw += w; swx += w * xs[i]; swy += w * ys[i];
      swxx += w * xs[i] * xs[i]; swxy += w * xs[i] * ys[i];
    }
    const na = (sw * swxy - swx * swy) / (sw * swxx - swx * swx);
    const nb = (swy - na * swx) / sw;
    if (Math.abs(na - a) < 1e-12 && Math.abs(nb - b) < 1e-12) {
      a = na; b = nb;
      break;
    }
    a = na; b = nb;
  }
  return [a, b];
}

export interface GainResult {
  rho: number;
  accept: boolean;
}

/**
 * LM gain ratio: rho = (L - Lnew) / (0.5 delta^T (lambda D delta - g)).
 * Accept the step iff rho > 0. Caller shrinks lambda when rho is large
 * (good model: trust Gauss-Newton more) and grows it when rho is small.
 */
export function lmGainAccept(
  L: number,
  Lnew: number,
  delta: number[],
  g: number[],
  D: number[],
  lambda: number,
): GainResult {
  let denom = 0;
  for (let i = 0; i < delta.length; i++) {
    denom += delta[i] * (lambda * D[i] * delta[i] - g[i]);
  }
  denom *= 0.5;
  const rho = denom !== 0 ? (L - Lnew) / denom : 0;
  return { rho, accept: rho > 0 };
}

/** Sigmoid reparametrization: theta = lo + (hi - lo) sigma(phi). */
export function sigmoidBound(phi: number, lo: number, hi: number): number {
  const s = 1 / (1 + Math.exp(-phi));
  return lo + (hi - lo) * s;
}

/** Coarse-to-fine Gaussian pyramid blur sigmas: sigma_k = sigma_0 2^{-k}. */
export function pyramidSigmas(sigma0: number, levels: number): number[] {
  const out: number[] = [];
  for (let k = 0; k <= levels; k++) out.push(sigma0 * 2 ** -k);
  return out;
}

type V3 = [number, number, number];

/**
 * Eikonal regularizer: lambda_E * mean((||grad f|| - 1)^2).
 * Zero for a true SDF; penalizes fields that are not distance-like.
 */
export function eikonalLoss(
  pts: V3[],
  grad: (p: V3) => V3,
  lambdaE: number,
): number {
  let sum = 0;
  for (const p of pts) {
    const g = grad(p);
    const n = Math.hypot(g[0], g[1], g[2]);
    sum += (n - 1) * (n - 1);
  }
  return lambdaE * (sum / Math.max(1, pts.length));
}

export interface Uncertainty {
  /** Estimated noise variance sigma_n^2 = RSS/(n_eff - p). */
  sigma2: number;
  /** Covariance estimate sigma^2 (J^T J)^{-1}. */
  cov: number[][];
}

/**
 * Parameter uncertainty from the normal-equation matrix J^T J.
 * Uses the effective sample count n_eff (<= n) when the resolve filter
 * correlates neighboring pixels; defaults to n.
 */
export function uncertainty(
  JtJ: number[][],
  RSS: number,
  n: number,
  p: number,
  nEff?: number,
): Uncertainty {
  const ne = nEff ?? n;
  const sigma2 = RSS / Math.max(1, ne - p);
  const m = JtJ.length;
  const inv = invertSymmetric(JtJ);
  const cov = inv.map((row) => row.map((v) => sigma2 * v));
  void m;
  return { sigma2, cov };
}

/** Inverse of a small symmetric positive-definite matrix (Gauss-Jordan). */
function invertSymmetric(A: number[][]): number[][] {
  const n = A.length;
  const M = A.map((row, i) =>
    row.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))),
  );
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    }
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-300;
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row) => row.slice(n));
}
