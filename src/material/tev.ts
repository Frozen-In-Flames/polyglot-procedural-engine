// material/tev.ts - TEV-style functional material compression.
//
// A material as closed-form math, not textures and not neural nets: a chain
// of K combiner stages, each computing C_out = (A - B) * C + D, where every
// slot draws from a fixed input set (previous stage output, a fitted
// constant, or a field term). Parameters = wiring + constants.
//
// The capacity knob is K and the input-set size: small K with restricted
// inputs gives the crisp combiner look; larger K with richer inputs
// approaches full PBR. Same math, different budget; error-vs-K is reported
// rate-distortion style.
//
// Fitting uses damped Gauss-Newton with central finite-difference
// Jacobians (engine convention, FD_EPS 1e-5) and backtracking on the cost.
// Deterministic: no randomness anywhere.
import { finiteJacobian } from '../inverse/conditioning.js';

/** Slot input kinds. Field terms are computed per surface point. */
export type TevInputKind =
  | 'prev'   // previous stage output (0 for the first stage)
  | 'const'  // fitted constant (uses constIndex)
  | 'ndl'    // n dot l
  | 'ndv'    // n dot v
  | 'ndh'    // n dot h
  | 'ndh2'   // (n dot h)^2
  | 'ndh4'   // (n dot h)^4
  | 'sdf'    // SDF field value at the point
  | 'noise'; // noise octave at the point

export interface TevSlot {
  kind: TevInputKind;
  /** Required when kind === 'const'. */
  constIndex?: number;
}

export interface TevStage {
  a: TevSlot;
  b: TevSlot;
  c: TevSlot;
  d: TevSlot;
}

export interface TevSpec {
  stages: TevStage[];
  numConsts: number;
}

/** Per-point shading context feeding the field-term slots. */
export interface TevContext {
  ndl: number;
  ndv: number;
  ndh: number;
  sdf: number;
  noise: number;
}

export interface TevSample {
  ctx: TevContext;
  target: number;
}

const FIELD_KINDS: ReadonlySet<TevInputKind> = new Set([
  'ndl', 'ndv', 'ndh', 'ndh2', 'ndh4', 'sdf', 'noise',
]);

function slotValue(slot: TevSlot, prev: number, consts: number[], ctx: TevContext): number {
  switch (slot.kind) {
    case 'prev': return prev;
    case 'const': {
      const i = slot.constIndex ?? -1;
      if (i < 0 || i >= consts.length) throw new Error(`tev: constIndex ${i} out of range`);
      return consts[i];
    }
    case 'ndl': return ctx.ndl;
    case 'ndv': return ctx.ndv;
    case 'ndh': return ctx.ndh;
    case 'ndh2': return ctx.ndh * ctx.ndh;
    case 'ndh4': { const q = ctx.ndh * ctx.ndh; return q * q; }
    case 'sdf': return ctx.sdf;
    case 'noise': return ctx.noise;
  }
}

/** Evaluate the K-stage chain. Pure function of (spec, consts, ctx). */
export function tevEvaluate(spec: TevSpec, consts: number[], ctx: TevContext): number {
  if (consts.length !== spec.numConsts) {
    throw new Error(`tev: expected ${spec.numConsts} consts, got ${consts.length}`);
  }
  let prev = 0;
  for (const st of spec.stages) {
    const A = slotValue(st.a, prev, consts, ctx);
    const B = slotValue(st.b, prev, consts, ctx);
    const C = slotValue(st.c, prev, consts, ctx);
    const D = slotValue(st.d, prev, consts, ctx);
    prev = (A - B) * C + D;
  }
  return prev;
}

const CYCLED_INPUTS: TevInputKind[] = ['ndl', 'noise', 'ndh2', 'ndv'];

/**
 * Polynomial-chain wiring: even stages add (s += w_i * X_i),
 * odd stages multiply (s = (s - c) * X + d). Alternating add/mul builds
 * polynomials in the cycled field inputs; degree grows with K.
 * Uses 2 consts per stage. The input cycle defaults to a general set;
 * pass the inputs that actually vary for the material at hand.
 */
export function polyChainWiring(k: number, inputs: TevInputKind[] = CYCLED_INPUTS): TevSpec {
  const stages: TevStage[] = [];
  for (let i = 0; i < k; i++) {
    const x: TevSlot = { kind: inputs[i % inputs.length] };
    if (i % 2 === 0) {
      stages.push({
        a: { kind: 'const', constIndex: 2 * i },
        b: { kind: 'const', constIndex: 2 * i + 1 },
        c: x,
        d: { kind: 'prev' },
      });
    } else {
      stages.push({
        a: { kind: 'prev' },
        b: { kind: 'const', constIndex: 2 * i },
        c: x,
        d: { kind: 'const', constIndex: 2 * i + 1 },
      });
    }
  }
  return { stages, numConsts: 2 * k };
}

/**
 * Replace every field-term slot with a fresh constant. The chain then
 * cannot see the surface at all (output is constant in ctx): the
 * negative-control wiring that must fail any fit-quality bar.
 */
export function stripFieldInputs(spec: TevSpec): TevSpec {
  let next = spec.numConsts;
  const fix = (s: TevSlot): TevSlot =>
    FIELD_KINDS.has(s.kind) ? { kind: 'const', constIndex: next++ } : { ...s };
  const stages = spec.stages.map(st => ({ a: fix(st.a), b: fix(st.b), c: fix(st.c), d: fix(st.d) }));
  return { stages, numConsts: next };
}

/** Dense linear solve by Gaussian elimination with partial pivoting. */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-14) throw new Error('tev: singular normal equations');
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

export interface TevFitLog {
  iterations: number;
  rmse: number;
  history: number[];
}

export interface TevFitOpts {
  maxIter?: number;
  tol?: number;
  /** Damping for the normal equations (J^T J + lambda I). */
  lambda?: number;
}

/**
 * Fit the chain constants by damped Gauss-Newton on
 *   L = 1/2 sum_i (tevEvaluate(spec, theta, ctx_i) - target_i)^2,
 * with central finite-difference Jacobians and backtracking line search.
 * theta0 is the warm-start slot: pass a previous solution to continue it.
 * Deterministic; the log records iterations and final RMSE.
 */
export function tevFit(
  spec: TevSpec,
  samples: TevSample[],
  theta0?: number[],
  opts: TevFitOpts = {},
): { consts: number[]; log: TevFitLog } {
  const n = spec.numConsts;
  const maxIter = opts.maxIter ?? 60;
  const tol = opts.tol ?? 1e-7;
  const lambda = opts.lambda ?? 1e-6;
  let theta = theta0 ? theta0.slice(0, n) : new Array<number>(n).fill(0);
  while (theta.length < n) theta.push(0);

  const residuals = (t: number[]): number[] =>
    samples.map(s => tevEvaluate(spec, t, s.ctx) - s.target);
  const cost = (t: number[]): number => {
    let c = 0;
    for (const r of residuals(t)) c += 0.5 * r * r;
    return c;
  };

  const history: number[] = [];
  let it = 0;
  for (; it < maxIter; it++) {
    const r = residuals(theta);
    const J = finiteJacobian(residuals, theta);
    // Normal equations: (J^T J + lambda I) delta = -J^T r
    const A: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const g = new Array<number>(n).fill(0);
    for (let i = 0; i < samples.length; i++) {
      for (let a = 0; a < n; a++) {
        g[a] += J[i][a] * r[i];
        for (let b = 0; b < n; b++) A[a][b] += J[i][a] * J[i][b];
      }
    }
    for (let a = 0; a < n; a++) A[a][a] += lambda;
    const delta = solveLinear(A, g.map(v => -v));
    const stepNorm = Math.sqrt(delta.reduce((s, d) => s + d * d, 0));
    const c0 = cost(theta);
    let s = 1;
    while (s > 1e-4 && cost(theta.map((t, i) => t + s * delta[i])) > c0) s *= 0.5;
    for (let i = 0; i < n; i++) theta[i] += s * delta[i];
    history.push(cost(theta));
    if (stepNorm * s < tol) { it++; break; }
  }
  const final = residuals(theta);
  const rmse = Math.sqrt(final.reduce((s, r) => s + r * r, 0) / Math.max(1, final.length));
  return { consts: theta, log: { iterations: it, rmse, history } };
}

/** PSNR in dB for a signal range of [0, 1]. */
export function psnr(mse: number): number {
  return 10 * Math.log10(1 / Math.max(mse, 1e-300));
}

/** Root mean square error between paired arrays. */
export function rmse(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) throw new Error('tev: rmse needs nonempty paired arrays');
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) * (a[i] - b[i]);
  return Math.sqrt(s / a.length);
}
