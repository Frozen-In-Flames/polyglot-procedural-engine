// inverse/changedetect.ts - outlier-aware change detection for the JIT loop.
//
// The v1.8.1 trimmed-NIS default false-alarms on outliers at perfect
// prediction (plain z ~1900-5200; trimmed holds clutter but leaks specular:
// 7.2 alone, 29.6 on spec+clutter), and a false alarm forces a cold start
// where 30-55% of fits fail. Root cause (owner): the detector and the
// estimator disagreed about what data is trustworthy (estimator: GM weights;
// detector: a fixed |u|<3 trim rule). All three forms below share the
// estimator's weights.
//
//   score-gm:    g = J^T psi(u), T = g^T M^{-1} g at the prediction,
//                M = sum psi(u)^2 J J^T the empirical score covariance,
//                psi = GM redescending (psi = w*u) from predicted residuals.
//                chi2(n_params) under H0.
//   score-huber: same statistic, Huber (monotone) psi = clamp(u, -k, k) for
//                DETECTION only; estimation stays redescending GM. Mechanism
//                is coherence, not magnitude: g sums parameter-space pulls,
//                a true jump pulls coherently and adds, clutter pulls
//                incoherently and cancels. (Measured: monotone psi still
//                false-alarms on asymmetric clutter, see docs.)
//   wald:        T = dtheta^T V^{-1} dtheta at the robust solution,
//                dtheta = thetaSol - thetaPred, V = H^{-1} M H^{-1} sandwich
//                with M = sum psi(u)^2 J J^T the score covariance, NOT the
//                naive H^{-1} (which miscalibrates under the contamination we
//                claim robustness to). Nearly free: the JIT loop runs the
//                robust fit every frame anyway. The only form with nominal
//                false alarms under every dirt condition, hence the default.
//
// Ground truth: the owner's power/false-alarm experiment
// (test/change-detect.test.ts); the power test picks the default form.
// API doc: docs/change-detection.md.
import { solveSPD, invertSPD } from './jit.js';
import type { Vec, Mat } from './jit.js';
import { irlsGnFit, robustWeight } from './robust.js';

/** The three detection forms (owner's agreed design). */
export type DetectForm = 'score-gm' | 'score-huber' | 'wald';

export interface DetectOpts {
  /** Which form to use (default DEFAULT_FORM). */
  form?: DetectForm;
  /** GM tuning constant for the score forms (default 3.0). The Wald form
   *  uses WALD_GM_C (1.2) when this is not set; see waldDetect. */
  c?: number;
  /** Huber knee for form 'score-huber' detection weights (default 1.345). */
  huberK?: number;
  /** Robust scale floor; default sqrt(sigma2). */
  sigmaFloor?: number;
  /** IRLS iterations for the Wald form's robust fit (default 40). */
  waldMaxIt?: number;
  /** IRLS tolerance for the Wald form (default 1e-5). */
  waldTol?: number;
  /**
   * Wald covariance form (default 'sandwich'). 'naive' uses V = H^{-1}
   * instead of the sandwich H^{-1} M H^{-1}; it exists only as the
   * control the sandwich is measured against (it miscalibrates under
   * contamination, see docs/change-detection.md and
   * test/wald-basin.test.ts). Never a production setting.
   */
  covariance?: 'sandwich' | 'naive';
}

export interface DetectResult {
  /** Test statistic T (~chi2(dof) under H0). */
  T: number;
  /** Degrees of freedom = n_params. */
  dof: number;
  /** chi2(dof) 99% cutoff. */
  threshold99: number;
  /** T > threshold99. */
  alarm: boolean;
  form: DetectForm;
}

/** Exact chi2 99% quantiles, dof 1..10. */
const CHI2_99 = [
  0, 6.6349, 9.2103, 11.3449, 13.2767, 15.0863, 16.8119, 18.4753, 20.0902,
  21.666, 23.2093,
];

/**
 * 99% quantile of chi2(dof): exact table for dof 1..10, Wilson-Hilferty
 * approximation beyond (within 0.3% at dof 4: 13.30 vs 13.277).
 */
export function chi2isf99(dof: number): number {
  if (Number.isInteger(dof) && dof >= 1 && dof <= 10) return CHI2_99[dof];
  if (dof < 1) throw new Error('chi2isf99: dof must be >= 1');
  const z = 2.3263479; // N(0,1) 99% quantile
  const t = 1 - 2 / (9 * dof) + z * Math.sqrt(2 / (9 * dof));
  return dof * t * t * t;
}

function median(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : 0.5 * (s[h - 1] + s[h]);
}

/** Robust scale s = max(sigmaFloor, 1.4826 * MAD(r)) (same rule as nisChange). */
function robustScale(r: number[], sigma2: number, sigmaFloor?: number): number {
  const med = median(r);
  const mad = median(r.map((v) => Math.abs(v - med)));
  return Math.max(sigmaFloor ?? Math.sqrt(sigma2), 1.4826 * mad);
}

function matMul(A: Mat, B: Mat): Mat {
  const n = A.length;
  const p = B[0].length;
  const m = B.length;
  const C: Mat = Array.from({ length: n }, () => new Array(p).fill(0));
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < m; k++) {
      const aik = A[i][k];
      for (let j = 0; j < p; j++) C[i][j] += aik * B[k][j];
    }
  }
  return C;
}

/** Symmetrize and ridge a matrix relative to its own scale so Cholesky succeeds. */
function pdSafe(A: Mat, rel = 1e-9): Mat {
  const n = A.length;
  let vmax = 0;
  const S: Mat = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      const v = 0.5 * (A[a][b] + A[b][a]);
      S[a][b] = v;
      if (a === b && Math.abs(v) > vmax) vmax = Math.abs(v);
    }
  }
  const eps = rel * Math.max(vmax, 1e-300);
  for (let a = 0; a < n; a++) S[a][a] += eps;
  return S;
}

/** Add a tiny ridge to the diagonal for numerical safety. */
function ridged(A: Mat, eps = 1e-12): Mat {
  return A.map((row, i) => row.map((v, j) => v + (i === j ? eps : 0)));
}

/**
 * Score test at the prediction: g = J^T psi(u), T = g^T M^{-1} g with
 * M = sum psi(u)^2 J J^T the empirical score covariance (sandwich).
 * weightKind 'gm' uses redescending GM psi (psi = w*u, w = (c^2/(c^2+u^2))^2);
 * 'huber' uses monotone Huber psi = clamp(u, -k, k) for detection only.
 * Residuals are scale-normalized (u = r/s) so T is scale-free and ~chi2(p)
 * under H0. The sandwich M (not J^T W J) is what keeps the calibration
 * honest: with Huber weights, clutter contributes bounded nonzero psi, and
 * only M accounts for that variance.
 */
export function scoreDetect(
  y: Vec,
  thetaPred: Vec,
  R: (th: Vec) => Vec,
  J: (th: Vec) => Mat,
  sigma2: number,
  weightKind: 'gm' | 'huber',
  opts?: DetectOpts,
): DetectResult {
  const c = opts?.c ?? 3.0;
  const k = opts?.huberK ?? 1.345;
  const p = thetaPred.length;
  const Rv = R(thetaPred);
  const Jm = J(thetaPred);
  const m = y.length;
  const s = robustScale(
    y.map((v, j) => v - Rv[j]),
    sigma2,
    opts?.sigmaFloor,
  );
  const g = new Array(p).fill(0);
  const M: Mat = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let j = 0; j < m; j++) {
    const u = (y[j] - Rv[j]) / s;
    const psi =
      weightKind === 'gm'
        ? robustWeight(u, 'gm', c) * u
        : Math.max(-k, Math.min(k, u));
    const psi2 = psi * psi;
    const row = Jm[j];
    for (let a = 0; a < p; a++) {
      g[a] += psi * row[a];
      const pra = psi2 * row[a];
      for (let b = 0; b < p; b++) M[a][b] += pra * row[b];
    }
  }
  const MinvG = solveSPD(pdSafe(M), g);
  let T = 0;
  for (let a = 0; a < p; a++) T += g[a] * MinvG[a];
  const thr = chi2isf99(p);
  return {
    T,
    dof: p,
    threshold99: thr,
    alarm: T > thr,
    form: weightKind === 'gm' ? 'score-gm' : 'score-huber',
  };
}

/**
 * GM tuning constant for the Wald form's fit and sandwich (v2.0.4).
 * The v1.9.1 bake-off set c = 3.0 for every form; the harder-scene
 * basin re-map (test/wald-basin.test.ts, docs/change-detection.md)
 * found that at c = 3.0 the Wald fit roams into the dirt basin under
 * combined strong specular + 40% one-sided clutter (false alarms 52%
 * at the nominal 1% operating point) and is blind below ~0.3 rad.
 * At c = 1.2 the same map holds nominal false alarms in every regime
 * (worst cell 2/100 on held-out seeds) and the 90% detection boundary
 * moves from 0.3 to 0.2 rad. The score forms keep c = 3.0: their
 * tuning is the owner's oracle contract, and they are not the default.
 */
export const WALD_GM_C = 1.2;

/**
 * Wald test at the robust solution: fit GM IRLS from the warm start, then
 * T = dtheta^T V^{-1} dtheta with dtheta = thetaSol - thetaPred and the
 * sandwich V = H^{-1} M H^{-1}, M = sum psi(u)^2 J J^T the score covariance
 * at the solution (psi = w*u with GM weights). The sandwich, not the naive
 * H^{-1}, keeps the calibration honest under contamination.
 */
export function waldDetect(
  y: Vec,
  thetaPred: Vec,
  R: (th: Vec) => Vec,
  J: (th: Vec) => Mat,
  sigma2: number,
  opts?: DetectOpts,
): DetectResult {
  const c = opts?.c ?? WALD_GM_C;
  const p = thetaPred.length;
  const fit = irlsGnFit(y, thetaPred, R, J, {
    kind: 'gm',
    c,
    sigmaFloor: opts?.sigmaFloor ?? Math.sqrt(sigma2),
    maxIt: opts?.waldMaxIt ?? 40,
    tol: opts?.waldTol ?? 1e-5,
  });
  const thS = fit.theta;
  const dth = thS.map((v, a) => v - thetaPred[a]);
  const Rv = R(thS);
  const Jm = J(thS);
  const m = y.length;
  const s = robustScale(
    y.map((v, j) => v - Rv[j]),
    sigma2,
    opts?.sigmaFloor,
  );
  const H: Mat = Array.from({ length: p }, () => new Array(p).fill(0));
  const M: Mat = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let j = 0; j < m; j++) {
    const u = (y[j] - Rv[j]) / s;
    const w = robustWeight(u, 'gm', c);
    const psi = w * u;
    const psi2 = psi * psi;
    const row = Jm[j];
    for (let a = 0; a < p; a++) {
      const wra = w * row[a];
      const sra = psi2 * row[a];
      for (let b = 0; b < p; b++) {
        H[a][b] += wra * row[b];
        M[a][b] += sra * row[b];
      }
    }
  }
  // V = H^{-1} M H^{-1} (congruence preserves positive semidefiniteness;
  // pdSafe repairs rounding asymmetry with a scale-relative ridge).
  // The 'naive' control skips the meat: V = H^{-1}.
  const Hinv = invertSPD(pdSafe(H));
  const V =
    opts?.covariance === 'naive' ? Hinv : matMul(matMul(Hinv, M), Hinv);
  const Vinv = invertSPD(pdSafe(V));
  const VinvD = Vinv.map((row) => row.reduce((t, v, b) => t + v * dth[b], 0));
  let T = 0;
  for (let a = 0; a < p; a++) T += dth[a] * VinvD[a];
  const thr = chi2isf99(p);
  return { T, dof: p, threshold99: thr, alarm: T > thr, form: 'wald' };
}

/** Selector over the three forms (default: DEFAULT_FORM). */
export function detectChange(
  y: Vec,
  thetaPred: Vec,
  R: (th: Vec) => Vec,
  J: (th: Vec) => Mat,
  sigma2: number,
  opts?: DetectOpts,
): DetectResult {
  const form = opts?.form ?? DEFAULT_FORM;
  if (form === 'wald') return waldDetect(y, thetaPred, R, J, sigma2, opts);
  return scoreDetect(y, thetaPred, R, J, sigma2, form === 'score-gm' ? 'gm' : 'huber', opts);
}

/**
 * Default form, chosen by the power/false-alarm experiment in
 * test/change-detect.test.ts: 'wald' is the only form with nominal
 * false-alarm rates under every dirt condition (score-gm false-alarms
 * 100% on specular; score-huber false-alarms on clutter and specular).
 * Why it wins is documented in docs/change-detection.md.
 */
export const DEFAULT_FORM: DetectForm = 'wald';
