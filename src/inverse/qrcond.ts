// inverse/qrcond.ts - conditional QR safeguard for least-squares solves.
//
// Normal equations (Cholesky of J^T J) lose precision like eps*kappa(J)^2;
// a QR factorization of J loses only eps*kappa(J). The trigger fires the QR
// branch iff
//   eps * kappa(J^T J) > tau,  tau = 1e-3,
// with kappa estimated from the p x p information matrix (cheap: p << m).
// Ground truth: docs/oracles/conditional_qr_oracle.py (the owner's file).
//
// Honest scope (oracle 3d, float64): on the engine's real problems the
// branch stays silent; ridge already covers the operating range. The branch
// is a tail-end safeguard for rare ill-conditioned frames, not a global
// architecture change.
import { jacobiEigen } from './conditioning.js';

/** Machine epsilon for float64 (TS numbers are float64). */
export const EPS_F64 = Number.EPSILON;

/** Trigger threshold: fire QR iff EPS_F64 * kappa(J^T J) > QR_TAU. */
export const QR_TAU = 1e-3;

/**
 * Condition numbers from the p x p information matrix J^T J:
 * kappaJtJ and kappaJ = sqrt(kappaJtJ). Non-positive eigenvalues (numerical
 * noise around a true null) are excluded from the minimum.
 */
export function condInfo(J: number[][]): {
  kappaJtJ: number;
  kappaJ: number;
} {
  const m = J.length;
  const p = J[0].length;
  const JtJ: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < m; i++) {
    const row = J[i];
    for (let a = 0; a < p; a++) {
      const ra = row[a];
      for (let b = 0; b < p; b++) JtJ[a][b] += ra * row[b];
    }
  }
  const { values } = jacobiEigen(JtJ);
  const pos = values.filter((v) => v > 0);
  const mx = Math.max(...values, 0);
  const mn = pos.length > 0 ? Math.min(...pos) : 0;
  const kappaJtJ = mn > 0 ? mx / mn : Infinity;
  return { kappaJtJ, kappaJ: Math.sqrt(kappaJtJ) };
}

/** Fire the QR branch iff EPS_F64 * kappa(J^T J) > tau. */
export function qrTrigger(
  J: number[][],
  tau = QR_TAU,
): { fire: boolean; kappaJtJ: number } {
  const { kappaJtJ } = condInfo(J);
  return { fire: EPS_F64 * kappaJtJ > tau, kappaJtJ };
}

/**
 * Normal-equation solve via Cholesky of J^T J. Returns null when J^T J is
 * not positive definite or the result is non-finite (the oracle's solve_ne
 * returns None on LinAlgError for the same reason).
 */
export function solveNE(J: number[][], y: number[]): number[] | null {
  const m = J.length;
  const p = J[0].length;
  const A: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < m; i++) {
    const row = J[i];
    const yi = y[i];
    for (let a = 0; a < p; a++) {
      b[a] += row[a] * yi;
      for (let c = 0; c < p; c++) A[a][c] += row[a] * row[c];
    }
  }
  const L: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(s > 0) || !isFinite(s)) return null;
        L[i][j] = Math.sqrt(s);
      } else {
        if (L[j][j] === 0) return null;
        L[i][j] = s / L[j][j];
      }
    }
  }
  const z = new Array(p).fill(0);
  for (let i = 0; i < p; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * z[k];
    z[i] = s / L[i][i];
  }
  const x = new Array(p).fill(0);
  for (let i = p - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < p; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x.every(isFinite) ? x : null;
}

/**
 * QR solve: modified Gram-Schmidt with one reorthogonalization pass on the
 * m x p J, then back-substitution on R x = Q^T y.
 */
export function solveQR(J: number[][], y: number[]): number[] {
  const m = J.length;
  const p = J[0].length;
  const Q: number[][] = [];
  const R: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let k = 0; k < p; k++) {
    let v = J.map((row) => row[k]);
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < k; j++) {
        const qj = Q[j];
        let d = 0;
        for (let i = 0; i < m; i++) d += v[i] * qj[i];
        if (pass === 0) R[j][k] = d;
        else R[j][k] += d;
        for (let i = 0; i < m; i++) v[i] -= d * qj[i];
      }
    }
    const nrm = Math.hypot(...v);
    R[k][k] = nrm;
    Q.push(v.map((x) => x / (nrm || 1e-300)));
  }
  const qty = Q.map((q) => {
    let s = 0;
    for (let i = 0; i < m; i++) s += q[i] * y[i];
    return s;
  });
  const x = new Array(p).fill(0);
  for (let k = p - 1; k >= 0; k--) {
    let s = qty[k];
    for (let j = k + 1; j < p; j++) s -= R[k][j] * x[j];
    x[k] = s / (R[k][k] || 1e-300);
  }
  return x;
}

/**
 * Conditional least squares: the QR branch iff the trigger fires, else the
 * normal equations (falling back to QR if Cholesky fails outright).
 */
export function solveCondQR(
  J: number[][],
  y: number[],
  tau = QR_TAU,
): { x: number[]; fired: boolean; kappaJtJ: number } {
  const { fire, kappaJtJ } = qrTrigger(J, tau);
  if (fire) return { x: solveQR(J, y), fired: true, kappaJtJ };
  const xne = solveNE(J, y);
  if (xne !== null) return { x: xne, fired: false, kappaJtJ };
  return { x: solveQR(J, y), fired: true, kappaJtJ };
}
