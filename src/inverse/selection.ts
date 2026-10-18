// inverse/selection.ts - model selection and rate-distortion reporting.
//
// Every fit chooses a model complexity (how many primitives, how many
// coefficients). These are the classical, framework-free tools for
// choosing honestly, plus the rate-distortion ledger that turns the
// "KBs of formulas" claim into a point on a curve.

/**
 * Effective sample size for AIC/BIC under the resolve filter. The
 * Lanczos resolve step correlates neighboring pixels over its (2a) x (2a)
 * support window, so n = pixel count overstates the independent samples.
 * Heuristic: n_eff = n_pixels / (2a)^2, floored at 1. Documented here so
 * the choice is visible, not hidden in the arithmetic.
 */
export function effectiveSampleSize(nPixels: number, supportA: number): number {
  return Math.max(1, nPixels / (2 * supportA) ** 2);
}

/** AIC = n ln(RSS/n) + 2k for Gaussian residuals (n effective, k params). */
export function aic(rss: number, n: number, k: number): number {
  return n * Math.log(rss / n) + 2 * k;
}

/** BIC = n ln(RSS/n) + k ln n for Gaussian residuals (n effective). */
export function bic(rss: number, n: number, k: number): number {
  return n * Math.log(rss / n) + k * Math.log(n);
}

/** PSNR = 10 log10(1/MSE), unit-peak signals. */
export function psnr(mse: number): number {
  return 10 * Math.log10(1 / mse);
}

export interface RateReport {
  /** Gzipped theta JSON bytes. */
  bytesTheta: number;
  /** Gzipped shader snippet bytes. */
  bytesShader: number;
  /** Total stored bytes: the artifact size. */
  bytesTotal: number;
  mse: number;
  psnr: number;
}

/**
 * Rate-distortion point: min_theta D(theta) + lambda B(theta), reported
 * as bytes (gzipped theta + gzipped shader snippet) vs PSNR. The byte
 * counts are measured by the caller (node: `gzip -c`) and passed in, so
 * this module stays free of platform I/O.
 */
export function rateReport(bytesTheta: number, bytesShader: number, mse: number): RateReport {
  return {
    bytesTheta,
    bytesShader,
    bytesTotal: bytesTheta + bytesShader,
    mse,
    psnr: psnr(mse),
  };
}

/**
 * L1 proximal soft-threshold for min 1/2 ||r||^2 + lambda ||theta||_1:
 *   theta_i <- sign(theta_i) max(|theta_i| - eta*lambda, 0).
 * Sparsity without a framework: one line per coordinate.
 */
export function softThreshold(theta: number[], etaLambda: number): number[] {
  return theta.map((t) => Math.sign(t) * Math.max(Math.abs(t) - etaLambda, 0) + 0);
}
