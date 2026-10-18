// inverse/varpro.ts - variable projection (Golub-Pereyra).
//
// The render is linear in some parameters: yhat = Phi(theta) c.
// Solve the linear part exactly and optimize only the nonlinear theta:
//   c*(theta) = Phi^+ y   (via QR, NOT normal equations)
//   r(theta)  = P_perp y,   P_perp = I - Phi Phi^+.
//
// Golub-Pereyra Jacobian (full, for diagnostics):
//   dr/dtheta_k = -[P_perp D_k Phi^+ + (P_perp D_k Phi^+)^T] y,
//   D_k = dPhi/dtheta_k.
// Kaufman's approximation drops the second term; it is for INSIDE the
// solver loop only (off by 5e-3 to 1e-1 in the oracle).
//
// DESIGN RULE (validated): fit the MERGED coefficient rho*E as ONE
// linear column. Separate albedo/intensity columns make Phi
// rank-deficient; the pseudoinverse then returns an arbitrary min-norm
// split (validated: (0.09, 0.27) for true (0.7, 0.1)), hiding the
// ambiguity instead of removing it. columnRank is asserted at every
// iterate; rankCutoff governs the sigma-ratio zone 1e-7..1e-11 where the
// formula degrades non-monotonically.
//
// All techniques are classical public mathematics; see
// docs/methods-provenance.md.

/** C = A B for matrices. */
function matMul(A: number[][], B: number[][]): number[][] {
  const m = A.length, n = B[0].length, p = B.length;
  const C: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let i = 0; i < m; i++) for (let k = 0; k < p; k++) {
    const aik = A[i][k];
    for (let j = 0; j < n; j++) C[i][j] += aik * B[k][j];
  }
  return C;
}

function transpose(A: number[][]): number[][] {
  return A[0].map((_, j) => A.map(row => row[j]));
}

/**
 * Pseudoinverse via modified Gram-Schmidt QR: Phi = Q R, Phi^+ = R^-1 Q^T.
 * Throws on rank deficiency (use columnRank first).
 */
export function qrPseudoinverse(Phi: number[][]): number[][] {
  const m = Phi.length, n = Phi[0].length;
  // Modified Gram-Schmidt.
  const Q: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
  const R: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const V: number[][] = Phi.map(row => [...row]);
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < k; j++) {
      let dot = 0;
      for (let i = 0; i < m; i++) dot += Q[i][j] * V[i][k];
      R[j][k] = dot;
      for (let i = 0; i < m; i++) V[i][k] -= dot * Q[i][j];
    }
    let nrm = 0;
    for (let i = 0; i < m; i++) nrm += V[i][k] * V[i][k];
    nrm = Math.sqrt(nrm);
    if (nrm < 1e-13) throw new Error(`qrPseudoinverse: rank deficient at column ${k}`);
    R[k][k] = nrm;
    for (let i = 0; i < m; i++) Q[i][k] = V[i][k] / nrm;
  }
  // R^-1 via back-substitution on each column of Q^T.
  const Qt = transpose(Q);
  const Pp: number[][] = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let j = 0; j < m; j++) {
    const b = Qt.map(row => row[j]);
    const x = new Array(n).fill(0);
    for (let k = n - 1; k >= 0; k--) {
      let s = b[k];
      for (let l = k + 1; l < n; l++) s -= R[k][l] * x[l];
      x[k] = s / R[k][k];
    }
    for (let k = 0; k < n; k++) Pp[k][j] = x[k];
  }
  return Pp;
}

/** Numerical column rank via the R diagonal of QR. */
export function columnRank(Phi: number[][], tol = 1e-10): number {
  const m = Phi.length, n = Phi[0].length;
  const V: number[][] = Phi.map(row => [...row]);
  let rank = 0;
  const Qt: number[][] = [];
  for (let k = 0; k < n; k++) {
    for (const q of Qt) {
      let dot = 0;
      for (let i = 0; i < m; i++) dot += q[i] * V[i][k];
      for (let i = 0; i < m; i++) V[i][k] -= dot * q[i];
    }
    let nrm = 0;
    for (let i = 0; i < m; i++) nrm += V[i][k] * V[i][k];
    nrm = Math.sqrt(nrm);
    if (nrm > tol) {
      rank++;
      Qt.push(V.map(row => row[k] / nrm));
    }
  }
  return rank;
}

/**
 * Rank-cutoff policy for the sigma-ratio zone where Golub-Pereyra
 * degrades non-monotonically (validated: 1e-7..1e-11).
 */
export function rankCutoff(sigmaRatio: number): 'ok' | 'regularize' | 'reject' {
  if (!(sigmaRatio > 0)) return 'reject';
  if (sigmaRatio < 1e-11) return 'reject';
  if (sigmaRatio < 1e-7) return 'regularize';
  return 'ok';
}

export interface VarproResult {
  r: number[];
  c: number[];
  residual: number;
}

/** Reduced residual r(theta) = P_perp y and the linear solution c*. */
export function varproResidual(
  PhiFn: (th: number[]) => number[][], theta: number[], y: number[],
): VarproResult {
  const Phi = PhiFn(theta);
  const Pp = qrPseudoinverse(Phi); // throws on rank deficiency
  const c = Pp.map(row => row.reduce((s, v, j) => s + v * y[j], 0));
  const r = y.map((yj, i) => yj - Phi[i].reduce((s, v, k) => s + v * c[k], 0));
  const residual = 0.5 * r.reduce((s, v) => s + v * v, 0);
  return { r, c, residual };
}

/**
 * Golub-Pereyra Jacobian of the reduced residual.
 * kaufman = true drops the transposed term (solver loop only).
 */
export function varproJacobian(
  PhiFn: (th: number[]) => number[][],
  dPhiFn: (th: number[]) => number[][][],
  theta: number[],
  y: number[],
  kaufman = false,
): number[][] {
  const Phi = PhiFn(theta);
  const Pp = qrPseudoinverse(Phi);
  // P_perp = I - Phi Phi^+
  const PhiPp = matMul(Phi, Pp);
  const m = Phi.length;
  const Pm: number[][] = Array.from({ length: m }, (_, i) =>
    Array.from({ length: m }, (_, j) => (i === j ? 1 : 0) - PhiPp[i][j]));
  const cols: number[][] = [];
  for (const Dk of dPhiFn(theta)) {
    const A = matMul(matMul(Pm, Dk), Pp); // P_perp D_k Phi^+
    const Ay = A.map(row => row.reduce((s, v, j) => s + v * y[j], 0));
    if (kaufman) {
      cols.push(Ay.map(v => -v));
    } else {
      const At = transpose(A);
      const Aty = At.map(row => row.reduce((s, v, j) => s + v * y[j], 0));
      cols.push(Ay.map((v, i) => -(v + Aty[i])));
    }
  }
  // Return as m x ncols.
  return Array.from({ length: m }, (_, i) => cols.map(col => col[i]));
}

export interface VarproSolveOpts {
  maxIter?: number;
  tol?: number;
  lambda?: number;
}

export interface VarproSolution {
  theta: number[];
  c: number[];
  residual: number;
  iterations: number;
}

/**
 * Solve the separable problem: LM on theta with the Kaufman Jacobian
 * inside the loop, full GP available for diagnostics. Asserts full
 * column rank at every iterate.
 */
export function varproSolve(
  PhiFn: (th: number[]) => number[][],
  dPhiFn: (th: number[]) => number[][][],
  theta0: number[],
  y: number[],
  opts: VarproSolveOpts = {},
): VarproSolution {
  const maxIter = opts.maxIter ?? 100;
  const tol = opts.tol ?? 1e-10;
  let lambda = opts.lambda ?? 1e-3;
  let theta = [...theta0];
  const n = theta.length;
  let { r, c, residual } = varproResidual(PhiFn, theta, y);
  let iterations = 0;
  for (let it = 0; it < maxIter; it++) {
    const Phi = PhiFn(theta);
    const rk = columnRank(Phi);
    if (rk < Phi[0].length) {
      throw new Error(`varproSolve: rank deficient at iterate ${it} (rank ${rk} < ${Phi[0].length}); merge collinear columns`);
    }
    const J = varproJacobian(PhiFn, dPhiFn, theta, y, true); // Kaufman in the loop
    // J^T J + lambda diag(J^T J), solve for delta.
    const Jt = transpose(J);
    const JtJ = matMul(Jt, J);
    const Jtr = Jt.map(row => row.reduce((s, v, j) => s + v * r[j], 0));
    const A: number[][] = JtJ.map((row, i) =>
      row.map((v, j) => (i === j ? v * (1 + lambda) : v)));
    const b = Jtr.map(v => -v);
    const delta = solveSymmetric(A, b);
    const tNext = theta.map((v, i) => v + delta[i]);
    const next = varproResidual(PhiFn, tNext, y);
    if (next.residual < residual) {
      theta = tNext; r = next.r; c = next.c; residual = next.residual;
      lambda = Math.max(lambda / 10, 1e-12);
    } else {
      lambda = Math.min(lambda * 10, 1e12);
    }
    iterations = it + 1;
    let dnorm = 0;
    for (const d of delta) dnorm += d * d;
    if (Math.sqrt(dnorm) < tol) break;
    void n;
  }
  return { theta, c, residual, iterations };
}

/** Solve a symmetric positive-definite system via Cholesky. */
function solveSymmetric(A: number[][], b: number[]): number[] {
  const n = b.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-300)) : s / L[j][j];
    }
  }
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}
