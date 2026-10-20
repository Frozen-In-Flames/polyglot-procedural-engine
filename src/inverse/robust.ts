// inverse/robust.ts - solver upgrades: Huber/IRLS, LM gain ratio,
// sigmoid bounds, Gaussian pyramid, Eikonal regularizer, uncertainty,
// Geman-McClure IRLS.
//
// Huber loss with IRLS weights:
//   rho_delta(r) = r^2/2 for |r| <= delta, else delta(|r| - delta/2),
//   w = min(1, delta/|r|).
// Geman-McClure (redescending, non-convex):
//   rho_c(u) = (c^2/2) u^2/(c^2+u^2),  w(u) = (c^2/(c^2+u^2))^2,
//   u = r/s the scale-normalized residual. The weight redescends to zero:
//   gross outliers are nullified, not merely capped (Huber keeps a constant
//   non-zero influence for large |u|).
// v1.9.2: warm-start direct GM is the only GM path. GNC annealing and
// Huber-then-GM were REMOVED (falsified by the owner's write-up, 150
// trials/cell near starts: 40-43% fail on the hard case vs 7% for direct
// GM; GNC took 47-61 iterations vs 7-20): an API that offers a falsified
// path is a bug. Huber stays as the convex baseline.
// THE robust scale spec (v1.9.2, explicit): every estimator here works in
// the normalized coordinate u = r / s with
//   s = max(sigma, 1.4826 * MAD(r)),
// sigma the caller-supplied noise scale (IrlsOpts.sigmaFloor), re-estimated
// per iteration from the current residuals. Huber and GM share this exact
// rule: Huber's 1.345 kink is in normalized units, not raw data units.
// IRLS Gauss-Newton with per-iteration scale re-estimation:
//   s = max(sigmaFloor, 1.4826 * MAD(r)), backtracking on the robust cost.
// Ground truth for the robust head-to-head:
// docs/oracles/robust_cost_head2head.py (the owner's file); the scale
// convention (weights from u = r/s, gradient from w*r) is the oracle's.
import { solveLinear } from './jit.js';
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

/** Robust estimator kinds for IRLS Gauss-Newton. */
export type RobustKind = 'l2' | 'huber' | 'gm';

/**
 * IRLS weight for the scale-normalized residual u = r/s (oracle's weights()):
 * l2: 1; huber: min(1, 1.345/|u|); gm: (c^2/(c^2+u^2))^2 (redescending).
 */
export function robustWeight(u: number, kind: RobustKind, c = 3.0): number {
  if (kind === 'l2') return 1;
  if (kind === 'huber') return Math.min(1, 1.345 / Math.max(Math.abs(u), 1e-12));
  const c2 = c * c;
  return (c2 / (c2 + u * u)) ** 2;
}

/**
 * Robust cost rho(u) per residual (oracle's rho_cost()): l2: u^2/2;
 * huber: quadratic inside 1.345, linear outside; gm: (c^2/2) u^2/(c^2+u^2),
 * saturating at c^2/2 per residual.
 */
export function robustCost(u: number, kind: RobustKind, c = 3.0): number {
  if (kind === 'l2') return 0.5 * u * u;
  if (kind === 'huber') {
    const a = Math.abs(u);
    const k = 1.345;
    return a <= k ? 0.5 * u * u : k * a - 0.5 * k * k;
  }
  const c2 = c * c;
  return (0.5 * c2 * u * u) / (c2 + u * u);
}

function medianSorted(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : 0.5 * (s[h - 1] + s[h]);
}

/**
 * THE robust scale: s = max(sigma, 1.4826 * MAD(r)).
 *
 * sigma is the caller-supplied noise scale (the prior on the measurement
 * noise; IrlsOpts.sigmaFloor). When the residual MAD is below sigma the
 * caller wins (never divide by an implausibly tiny scale); when it is
 * above, the data wins (the scale adapts to the actual spread). Applied
 * identically to Huber and GM alike: weights and costs always use the
 * normalized residual u = r/s, so Huber's 1.345 kink and GM's c are in
 * normalized units, never raw data units.
 */
export function madScale(r: number[], sigma: number): number {
  const med = medianSorted(r);
  const mad = medianSorted(r.map((v) => Math.abs(v - med)));
  return Math.max(sigma, 1.4826 * mad);
}

export interface IrlsOpts {
  kind: RobustKind;
  /** GM tuning constant (default 3.0). */
  c?: number;
  /** Max Gauss-Newton iterations (default 40). */
  maxIt?: number;
  /** Step-norm stopping tolerance (default 1e-5). */
  tol?: number;
  /** Noise floor for the robust scale, e.g. the sensor sigma. */
  sigmaFloor: number;
  /** Parameter bounds applied after each step, e.g. I >= 0.05. */
  clamp?: (th: number[]) => void;
}

export interface IrlsResult {
  theta: number[];
  iters: number;
}

/**
 * IRLS Gauss-Newton with per-iteration scale re-estimation and backtracking
 * on the robust cost. Faithful port of the oracle's irls(): the step solves
 * (J^T W J + damp) d = J^T (w .* r) with the oracle's damping
 * 1e-9*trace(A)*I + 1e-12*I, then backtracks on the robust cost.
 */
export function irlsGnFit(
  y: number[],
  theta0: number[],
  render: (th: number[]) => number[],
  jac: (th: number[]) => number[][],
  opts: IrlsOpts,
): IrlsResult {
  const kind = opts.kind;
  const c = opts.c ?? 3.0;
  const maxIt = opts.maxIt ?? 40;
  const tol = opts.tol ?? 1e-5;
  const th = theta0.slice();
  const p = th.length;
  const m = y.length;
  let iters = 0;
  for (let it = 0; it < maxIt; it++) {
    const yh = render(th);
    const r = new Array(m);
    for (let i = 0; i < m; i++) r[i] = y[i] - yh[i];
    const s = madScale(r, opts.sigmaFloor);
    const w = new Array(m);
    for (let i = 0; i < m; i++) w[i] = robustWeight(r[i] / s, kind, c);
    const J = jac(th);
    const A: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
    const g = new Array(p).fill(0);
    for (let i = 0; i < m; i++) {
      const wi = w[i];
      const ri = r[i];
      const row = J[i];
      const wir = wi * ri;
      for (let a = 0; a < p; a++) {
        g[a] += row[a] * wir;
        const ra = row[a] * wi;
        for (let b = 0; b < p; b++) A[a][b] += ra * row[b];
      }
    }
    let tr = 0;
    for (let a = 0; a < p; a++) tr += A[a][a];
    for (let a = 0; a < p; a++) A[a][a] += 1e-9 * tr + 1e-12;
    const d = solveLinear(A, g);
    const costAt = (st: number): number => {
      const t2 = th.map((v, a) => v + st * d[a]);
      const r2 = render(t2);
      let sum = 0;
      for (let i = 0; i < m; i++) sum += robustCost((y[i] - r2[i]) / s, kind, c);
      return sum;
    };
    let c0 = 0;
    for (let i = 0; i < m; i++) c0 += robustCost(r[i] / s, kind, c);
    let st = 1;
    while (costAt(st) > c0 && st > 1e-3) st *= 0.5;
    for (let a = 0; a < p; a++) th[a] += st * d[a];
    if (opts.clamp) opts.clamp(th);
    iters++;
    let step = 0;
    for (let a = 0; a < p; a++) step += (st * d[a]) * (st * d[a]);
    if (Math.sqrt(step) < tol) break;
  }
  return { theta: th, iters };
}

/**
 * IRLS line fit y = a x + b under the Huber loss. Returns [a, b].
 *
 * The scale is explicit (v1.9.2): sigma is the caller-supplied noise
 * scale; each iteration sets s = max(sigma, 1.4826 * MAD(r)) and weights
 * w = min(1, 1.345 * s / |r|) (Huber in the normalized coordinate
 * u = r/s). The fit is scale-equivariant: scaling data and sigma by the
 * same factor scales the fit identically.
 */
export function irlsSolve(xs: number[], ys: number[], sigma: number): [number, number] {
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
    const r = xs.map((x, i) => a * x + b - ys[i]);
    const s = madScale(r, sigma);
    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
    for (let i = 0; i < n; i++) {
      const w = robustWeight(r[i] / s, 'huber');
      sw += w; swx += w * xs[i]; swy += w * ys[i];
      swxx += w * xs[i] * xs[i]; swxy += w * xs[i] * ys[i];
    }
    const na = (sw * swxy - swx * swy) / (sw * swxx - swx * swx);
    const nb = (swy - na * swx) / sw;
    const settled =
      Math.abs(na - a) <= 1e-12 * Math.max(1, Math.abs(na)) &&
      Math.abs(nb - b) <= 1e-12 * Math.max(1, Math.abs(nb));
    if (settled) {
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
