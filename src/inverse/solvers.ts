// inverse/solvers.ts - honest, small inverse solvers.
//
// Classical least-squares optimization on scene parameters, NOT neural
// pipelines and NOT differentiable-rendering frameworks. See
// docs/methods-provenance.md and the V10 section of INVERSE.md.
//
// SHADOWS AND SOLVER SMOOTHNESS (documented behavior):
// The V10 raymarcher shades with penumbra-style soft shadows computed from
// the field itself (smooth, continuous). The solvers below, however, use
// the unshadowed Lambert baseline R_j = I * max(0, dot(n, l)) as their
// forward model: shadow discontinuities therefore never enter a solve
// loop and finite differences stay well-behaved. If shadows ever enter a
// solve loop, they must be the soft penumbra form: hard shadow edges are
// step discontinuities whose finite-difference gradients are unbounded.
//
// FINITE-DIFFERENCE COST: every gradient step costs 2n value evaluations
// (central differences), i.e. one extra render per parameter per step.
// That cost is the documented reason geometry-scale solves need the
// implicit-function-theorem upgrade path (differentiate the surface
// constraint f(x(theta), theta) = 0 instead of re-rendering): re-rendering
// stops scaling when theta has hundreds of entries.
//
// The acceptance spec, implemented exactly:
//
//   Least-squares cost  L(theta) = 1/2 sum_j (R_j(theta) - y_j)^2
//   over target pixels/constraints y_j and rendered output R_j
//   parameterized by scene variables theta (primitive scales, blend
//   factors, light positions).
//
//   Update by gradient descent:
//     theta^{(t+1)} = theta^{(t)} - eta * grad L(theta).
//
// Deterministic and inspectable: no randomness anywhere, every solve logs
// iterations and residual so the solve is visible, never a black box.
import type { Vec3 } from '../math/vec.js';

export interface SolveLog {
  /** Iterations actually run. */
  iterations: number;
  /** Final cost L(theta). */
  residual: number;
  /** Root mean square error: sqrt(2 * residual / nConstraints). */
  rmse: number;
  /** Residual sampled every logEvery steps (plus the final value). */
  history: number[];
}

export interface GdOpts {
  /** Learning rate. Built-in solvers compute a stable value from the
   *  problem data when omitted; the conservative fallback is 0.01. */
  eta?: number;
  maxIter?: number;
  /** Stop when the cost improvement per step drops below tol. */
  tol?: number;
  logEvery?: number;
  /** Optional constraint projection applied after each update, e.g.
   *  non-negativity for light intensities (documented per solver). */
  project?: (theta: number[]) => number[];
}

/** Finite-difference step for gradient estimation, documented choice:
 *  central differences have truncation error O(h^2) and rounding error
 *  O(eps_mach / h) for float64 (eps_mach ~= 2.2e-16), so the classical
 *  optimum is h ~= eps_mach^(1/3) ~= 6e-6. We use 1e-5, scaled
 *  per-coordinate by max(1, |theta_i|), leaving margin on flat landscapes.
 *  No autodiff library is used anywhere: 2n value evaluations per gradient,
 *  fully inspectable. */
export const FD_EPS = 1e-5;

function finiteGrad(
  L: (theta: number[]) => number,
  theta: number[],
  eps: number = FD_EPS,
): number[] {
  const n = theta.length;
  const grad = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const h = eps * Math.max(1, Math.abs(theta[i]));
    const tp = theta.slice(); tp[i] = theta[i] + h;
    const tm = theta.slice(); tm[i] = theta[i] - h;
    grad[i] = (L(tp) - L(tm)) / (2 * h);
  }
  return grad;
}

/**
 * Generic gradient-descent driver for the spec cost:
 *   theta^{(t+1)} = theta^{(t)} - eta * grad L(theta),
 * with grad L estimated by central finite differences of the value
 * function L alone. Deterministic, inspectable, no randomness.
 */
export function gradientDescent(
  theta0: number[],
  L: (theta: number[]) => number,
  opts: GdOpts = {},
): { theta: number[]; log: SolveLog } {
  const eta = opts.eta ?? 0.01;
  const maxIter = opts.maxIter ?? 500;
  const tol = opts.tol ?? 1e-9;
  const logEvery = opts.logEvery ?? 25;
  const project = opts.project;
  let theta = theta0.slice();
  if (project) theta = project(theta);
  let prev = L(theta);
  const history: number[] = [prev];
  let iterations = 0;
  for (let i = 0; i < maxIter; i++) {
    const grad = finiteGrad(L, theta);
    for (let k = 0; k < theta.length; k++) theta[k] -= eta * grad[k];
    if (project) theta = project(theta);
    const cur = L(theta);
    iterations = i + 1;
    if ((i + 1) % logEvery === 0) history.push(cur);
    if (Math.abs(prev - cur) < tol) break;
    prev = cur;
    if (!isFinite(cur)) break;
  }
  const final = L(theta);
  history.push(final);
  const n = Math.max(1, theta0.length);
  return {
    theta,
    log: { iterations, residual: final, rmse: Math.sqrt((2 * final) / n), history },
  };
}

// ---------------------------------------------------------------------------
// Linear-model helpers shared by the built-in solvers.
// R(theta) = A theta with A an (m x n) design matrix. The value function is
// L(theta) = 1/2 ||A theta - y||^2; the gradient is still estimated by the
// same finite differences as everything else, so all solvers share one
// optimization path and one log format. Stable eta from the Frobenius norm
// (an upper bound on the largest eigenvalue of A^T A, so eta = 0.9 / ||A||_F^2
// cannot diverge).
// ---------------------------------------------------------------------------

export function designStats(A: number[][]): { frobSq: number; rows: number; cols: number } {
  let frobSq = 0;
  for (const row of A) for (const v of row) frobSq += v * v;
  return { frobSq, rows: A.length, cols: A.length ? A[0].length : 0 };
}

export function linearLeastSquares(
  A: number[][],
  y: number[],
  opts: GdOpts = {},
): { theta: number[]; log: SolveLog } {
  const { frobSq, cols } = designStats(A);
  const eta = opts.eta ?? (frobSq > 0 ? 0.9 / frobSq : 0.01);
  const L = (theta: number[]): number => {
    let value = 0;
    for (let j = 0; j < A.length; j++) {
      let r = -y[j];
      for (let k = 0; k < cols; k++) r += A[j][k] * theta[k];
      value += 0.5 * r * r;
    }
    return value;
  };
  return gradientDescent(new Array<number>(cols).fill(0), L, { ...opts, eta });
}

function rSquared(A: number[][], y: number[], theta: number[]): number {
  const mean = y.reduce((a, b) => a + b, 0) / Math.max(1, y.length);
  let ssTot = 0, ssRes = 0;
  for (let j = 0; j < A.length; j++) {
    let r = 0;
    for (let k = 0; k < theta.length; k++) r += A[j][k] * theta[k];
    ssTot += (y[j] - mean) * (y[j] - mean);
    ssRes += (y[j] - r) * (y[j] - r);
  }
  return ssTot > 0 ? 1 - ssRes / ssTot : (ssRes === 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// (a) Inverse lighting. Solves light intensities (and per-channel colors)
// from target brightness samples.
//
// Model (documented limits): Lambertian surfaces, known sample positions
// and normals, no shadows, no interreflection. The shading model is the
// raymarcher's baseline: R_j = dot(n_j, l_j) clamped at zero, with l_j the
// unit vector from the sample to the light. Candidate light positions are
// fixed by the caller; the solver finds non-negative intensities per color
// channel. Negative intensity is unphysical, so each update is projected
// onto theta >= 0 (documented extension of the plain update).
// ---------------------------------------------------------------------------

export interface LightSample {
  pos: Vec3;
  normal: Vec3;
  /** Desired outgoing radiance. */
  target: [number, number, number];
}

export interface SolvedLight {
  position: Vec3;
  /** Solved intensity per channel. */
  color: [number, number, number];
}

export interface LightingSolution {
  lights: SolvedLight[];
  /** RMSE over all samples and channels. */
  rmse: number;
  log: SolveLog;
  /** True when the residual is small enough to trust. */
  passed: boolean;
}

function lambertRow(sample: LightSample, candidates: Vec3[]): number[] {
  const row: number[] = [];
  for (const c of candidates) {
    const dx = c[0] - sample.pos[0], dy = c[1] - sample.pos[1], dz = c[2] - sample.pos[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const n = sample.normal;
    const cos = (n[0] * dx + n[1] * dy + n[2] * dz) / len;
    row.push(Math.max(0, cos));
  }
  return row;
}

export function solveLighting(
  samples: LightSample[],
  candidates: Vec3[],
  opts: { maxIter?: number; tol?: number; rmsePass?: number } = {},
): LightingSolution {
  const A = samples.map(s => lambertRow(s, candidates));
  const nonNeg = (theta: number[]) => theta.map(v => Math.max(0, v));
  const channels: number[][] = [[], [], []];
  const thetas: number[][] = [[], [], []];
  let totalSq = 0;
  const logs: SolveLog[] = [];
  for (let ch = 0; ch < 3; ch++) {
    const y = samples.map(s => s.target[ch]);
    const { theta, log } = linearLeastSquares(A, y, {
      maxIter: opts.maxIter ?? 2000,
      tol: opts.tol ?? 1e-12,
      project: nonNeg,
    });
    thetas[ch] = theta;
    logs.push(log);
    totalSq += 2 * log.residual;
  }
  for (let ch = 0; ch < 3; ch++) channels[ch] = thetas[ch];
  const lights: SolvedLight[] = candidates.map((c, i) => ({
    position: [c[0], c[1], c[2]],
    color: [channels[0][i], channels[1][i], channels[2][i]],
  }));
  const rmse = Math.sqrt(totalSq / Math.max(1, samples.length * 3));
  const iterations = Math.max(...logs.map(l => l.iterations));
  const history = logs[0] ? logs[0].history : [];
  const rmsePass = opts.rmsePass ?? 0.05;
  return {
    lights,
    rmse,
    log: { iterations, residual: totalSq / 2, rmse, history },
    passed: rmse <= rmsePass,
  };
}

/** Candidate light positions on a sphere shell (caller chooses count). */
export function lightCandidates(count: number, radius: number, height: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / Math.max(1, count)) * Math.PI * 2;
    out.push([Math.cos(a) * radius, height, Math.sin(a) * radius]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// (b) Inverse material fit. Solves procedural material coefficients that
// are linear in the parameters: R_j(theta) = sum_k theta_k * b_k(x_j).
// Reports R^2 honestly; fits below 0.70 are flagged failed, never shipped
// silently (same quality-gate language as the V3 foundry).
// ---------------------------------------------------------------------------

export interface MaterialFit {
  coeffs: number[];
  r2: number;
  passed: boolean;
  log: SolveLog;
}

export function fitMaterialCoeffs(
  basis: Array<(x: number) => number>,
  samples: Array<{ x: number; y: number }>,
  opts: { maxIter?: number; tol?: number; r2Pass?: number } = {},
): MaterialFit {
  const A = samples.map(s => basis.map(b => b(s.x)));
  const y = samples.map(s => s.y);
  const { theta, log } = linearLeastSquares(A, y, {
    maxIter: opts.maxIter ?? 2000,
    tol: opts.tol ?? 1e-12,
  });
  const r2 = rSquared(A, y, theta);
  const r2Pass = opts.r2Pass ?? 0.7;
  return { coeffs: theta, r2, passed: r2 >= r2Pass, log };
}

// ---------------------------------------------------------------------------
// (c) Inverse light position. The acceptance-demo solver: theta is one
// light's position and intensity, theta = [px, py, pz, I], and the rendered
// output is the Lambert baseline R_j(theta) = I * max(0, dot(n_j, l_j)),
// with l_j the unit vector from sample j to the light. Finite-difference
// gradients drag light_pos toward whatever makes the render match the
// targets. Non-convex in general (the max(0, .) kink and the 1/r geometry),
// so the start position matters and the log must be read, not assumed.
// ---------------------------------------------------------------------------

export interface LightPosSolution {
  position: Vec3;
  intensity: number;
  rmse: number;
  passed: boolean;
  log: SolveLog;
}

export function solveLightPosition(
  samples: Array<{ pos: Vec3; normal: Vec3; target: number }>,
  init: { position: Vec3; intensity: number },
  opts: { eta?: number; maxIter?: number; tol?: number; rmsePass?: number; logEvery?: number } = {},
): LightPosSolution {
  const render = (theta: number[]): number[] => {
    const p: Vec3 = [theta[0], theta[1], theta[2]];
    const I = Math.max(0, theta[3]);
    return samples.map(s => {
      const dx = p[0] - s.pos[0], dy = p[1] - s.pos[1], dz = p[2] - s.pos[2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const cos = (s.normal[0] * dx + s.normal[1] * dy + s.normal[2] * dz) / len;
      return I * Math.max(0, cos);
    });
  };
  const L = (theta: number[]): number => {
    const r = render(theta);
    let s = 0;
    for (let j = 0; j < r.length; j++) {
      const d = r[j] - samples[j].target;
      s += 0.5 * d * d;
    }
    return s;
  };
  const { theta, log } = gradientDescent(
    [init.position[0], init.position[1], init.position[2], init.intensity],
    L,
    {
      eta: opts.eta ?? 0.1,
      maxIter: opts.maxIter ?? 2000,
      tol: opts.tol ?? 1e-10,
      logEvery: opts.logEvery ?? 50,
      project: t => [t[0], t[1], t[2], Math.max(0, t[3])],
    },
  );
  const rmse = Math.sqrt((2 * log.residual) / Math.max(1, samples.length));
  const rmsePass = opts.rmsePass ?? 0.05;
  return {
    position: [theta[0], theta[1], theta[2]],
    intensity: Math.max(0, theta[3]),
    rmse,
    passed: rmse <= rmsePass,
    log,
  };
}

// ---------------------------------------------------------------------------
// UPGRADE PATH (documented, not implemented): Levenberg-Marquardt.
//
// The shipped solvers above use plain gradient descent because it is
// simple, robust, and fully inspectable. For sum-of-squares costs
// L(theta) = 1/2 ||r(theta)||^2 there is a strictly better classical
// upgrade that still needs no framework:
//
//   Gauss-Newton models r(theta + d) ~= r + J d with J = dr/dtheta and
//   solves (J^T J) d = -J^T r each step: quadratic convergence near the
//   solution, but it can diverge far away or on rank-deficient J.
//
//   Levenberg-Marquardt damps it: (J^T J + lambda I) d = -J^T r.
//   Large lambda gives short gradient-descent-like steps (robust far from
//   the solution); small lambda recovers Gauss-Newton (fast near it).
//   Lambda adapts by the gain ratio rho = actual / predicted reduction:
//   rho near 1 lowers lambda, rho small or negative raises it.
//
//   Jacobians without any framework: dual numbers. Represent each scalar
//   as (value, derivative) with e^2 = 0; evaluating the residual
//   r(theta + e * e_i) yields (r, J e_i) exactly by forward-mode automatic
//   differentiation written in a dozen lines. No autodiff library, no
//   neural pipeline, still classical numerical optimization.
//
// When to take this path: geometry-scale solves, where finite differences
// cost one extra render per parameter per step (see the header note) and
// the implicit-function-theorem gradient makes each evaluation precious.
// Until then, gradient descent stays: it converges, it is honest about
// local minima, and every step is readable.
// ---------------------------------------------------------------------------
