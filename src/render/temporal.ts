// render/temporal.ts - temporal stability for the runtime renderer.
//
// TAA needs jitter, accumulation, and ghost control; UI/animation needs
// responsive smoothing. All filters here are classical public mathematics;
// see docs/methods-provenance.md.
//
// Measured trade (oracle): a bright object moving with no motion vector
// leaves ghost error 0.051 unclamped; min-max history clamp -> 0.000,
// variance clip (gamma=1) -> 0.003. The clamp costs denoising power on
// static noise: unclamped reaches sigma*sqrt(alpha/(2-alpha)); clamping
// raises the residual floor. Both clamps ship; pick per scene.

/** Radical inverse: Halton sequence value for index i (1-based) in base b. */
export function halton(i: number, b: number): number {
  let f = 1, r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
}

/** One EMA step: acc = (1-a)*acc + a*x. */
export function emaUpdate(x: number, acc: number, alpha: number): number {
  return (1 - alpha) * acc + alpha * x;
}

/** Effective sample count of an EMA: N_eff = (2-alpha)/alpha. */
export function effectiveSamples(alpha: number): number {
  return (2 - alpha) / alpha;
}

/**
 * Min-max history clamp: clamp each history sample to the [min,max] of
 * the 3-tap neighborhood of the current frame. Kills ghosting (0.051 ->
 * 0.000 in the oracle) at the cost of denoising power.
 */
export function clampMinMax(hist: number[], cur: number[]): number[] {
  const n = hist.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.min(cur[Math.max(i - 1, 0)], cur[i], cur[Math.min(i + 1, n - 1)]);
    const hi = Math.max(cur[Math.max(i - 1, 0)], cur[i], cur[Math.min(i + 1, n - 1)]);
    out[i] = Math.min(hi, Math.max(lo, hist[i]));
  }
  return out;
}

/**
 * Variance-clip history clamp: clamp to mean +/- gamma*sigma over a
 * 5-tap neighborhood. Softer than min-max (ghost 0.051 -> 0.003 at
 * gamma=1); gamma sweep in the oracle.
 */
export function clampVariance(hist: number[], cur: number[], gamma = 1.0): number[] {
  const n = hist.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, sum2 = 0, cnt = 0;
    for (let j = i - 2; j <= i + 2; j++) {
      const v = cur[Math.min(n - 1, Math.max(0, j))];
      sum += v; sum2 += v * v; cnt++;
    }
    const mu = sum / cnt;
    const sd = Math.sqrt(Math.max(sum2 / cnt - mu * mu, 0));
    out[i] = Math.min(mu + gamma * sd, Math.max(mu - gamma * sd, hist[i]));
  }
  return out;
}

/**
 * Polynomial replacement for e^(-x), x in [0, 2].
 * Determinism-critical paths use this instead of Math.exp so the
 * result is bit-identical across platforms. Degree-20 Taylor polynomial
 * (Horner form); max error 3.8e-14 on [0,2] measured against Math.exp.
 * Typical spring use has w*dt << 1, where the error is far smaller.
 */
export function polyExpNeg(x: number): number {
  // 1/n! with alternating signs, degree 20.
  const c = [
    1.0,
    -1.0,
    0.5,
    -0.16666666666666666,
    0.041666666666666664,
    -0.008333333333333333,
    0.001388888888888889,
    -0.0001984126984126984,
    0.000024801587301587302,
    -0.0000027557319223985893,
    2.755731922398589e-7,
    -2.505210838544172e-8,
    2.08767569878681e-9,
    -1.6059043836821613e-10,
    1.1470745597729725e-11,
    -7.647163731819816e-13,
    4.779477332387385e-14,
    -2.8114572543455206e-15,
    1.5619206968586225e-16,
    -8.22063524662433e-18,
    4.110317623312165e-19,
  ];
  let r = c[20];
  for (let i = 19; i >= 0; i--) r = r * x + c[i];
  return r;
}

export type ExpFn = (x: number) => number;

/**
 * One step of a critically damped spring toward target.
 * Exact solution: x(t) = target + (e0 + k t) e^(-w t) with
 * e0 = x0 - target, k = v0 + w e0. expFn computes e^(-x) from x;
 * pass polyExpNeg in determinism-critical paths.
 */
export function springStep(
  x0: number, v0: number, target: number, w: number, dt: number,
  expFn: ExpFn = (x) => Math.exp(-x),
): [number, number] {
  const e0 = x0 - target;
  const k = v0 + w * e0;
  const ex = expFn(w * dt);
  return [target + (e0 + k * dt) * ex, (v0 - w * k * dt) * ex];
}

/** Adaptive low-pass: alpha = 1/(1 + tau/dt), tau = 1/(2 pi cutoff). */
function smoothingAlpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export interface OneEuroOpts {
  minCutoff?: number;
  beta?: number;
  dCutoff?: number;
}

/**
 * One Euro filter: cutoff = minCutoff + beta*|dHat|, where dHat is the
 * low-passed derivative. Smooth when slow, responsive when fast.
 */
export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xHat = 0;
  private dHat = 0;
  private init = false;

  constructor(opts: OneEuroOpts = {}) {
    this.minCutoff = opts.minCutoff ?? 1.0;
    this.beta = opts.beta ?? 0.0;
    this.dCutoff = opts.dCutoff ?? 1.0;
  }

  update(x: number, dt: number): number {
    if (!this.init) {
      this.xHat = x;
      this.init = true;
      return x;
    }
    const dx = (x - this.xHat) / Math.max(dt, 1e-9);
    this.dHat = smoothingAlpha(this.dCutoff, dt) * dx +
      (1 - smoothingAlpha(this.dCutoff, dt)) * this.dHat;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dHat);
    const a = smoothingAlpha(cutoff, dt);
    this.xHat = a * x + (1 - a) * this.xHat;
    return this.xHat;
  }

  reset(): void {
    this.init = false;
    this.xHat = 0;
    this.dHat = 0;
  }
}
