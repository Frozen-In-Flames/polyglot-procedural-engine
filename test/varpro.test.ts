// test/varpro.test.ts - variable projection, ported from
// docs/oracles/varpro_jacobian.py.
//
// Design rule (validated): fit the MERGED coefficient rho*E as ONE
// linear column. Never use separate albedo/intensity columns: the
// pseudoinverse then hides the split (arbitrary min-norm solution) and
// the Golub-Pereyra formula's constant-rank assumption breaks.
//   c*(theta) = Phi^+ y (via QR, not normal equations)
//   r(theta)  = P_perp y,  P_perp = I - Phi Phi^+
//   dr/dtheta_k = -[P_perp D_k Phi^+ + (P_perp D_k Phi^+)^T] y  (full GP)
// Kaufman (drop the 2nd term) is for inside the solver loop only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pcg32 } from '../src/math/determinism.js';
import {
  qrPseudoinverse, varproResidual, varproJacobian, varproSolve,
  rankCutoff, columnRank,
} from '../src/inverse/varpro.js';

const T: number[] = [];
for (let i = 0; i < 60; i++) T.push(i / 59);

function relErr(a: number[], b: number[]): number {
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - b[i]) ** 2; den += b[i] ** 2; }
  return Math.sqrt(num) / Math.max(Math.sqrt(den), 1e-300);
}

function fdJacobian(
  PhiFn: (th: number[]) => number[][], th: number[], y: number[], h = 1e-6,
): number[][] {
  const m = y.length, n = th.length;
  const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let k = 0; k < n; k++) {
    const tp = [...th], tm = [...th];
    tp[k] += h; tm[k] -= h;
    const rp = varproResidual(PhiFn, tp, y).r;
    const rm = varproResidual(PhiFn, tm, y).r;
    for (let j = 0; j < m; j++) J[j][k] = (rp[j] - rm[j]) / (2 * h);
  }
  return J;
}

function flat(J: number[][]): number[] {
  return J.flat();
}

test('varpro: case A (full rank) - GP matches FD, Kaufman approximate', () => {
  const Phi = (th: number[]): number[][] =>
    T.map(t => [Math.exp(-th[0] * t), Math.exp(-th[1] * t), 1]);
  const dPhi = (th: number[]): number[][][] => [
    T.map(t => [-t * Math.exp(-th[0] * t), 0, 0]),
    T.map(t => [0, -t * Math.exp(-th[1] * t), 0]),
  ];
  const g = new Pcg32(7);
  const yTrue = Phi([2.0, 5.0]);
  const y = yTrue.map(row => row[0] * 1.0 + row[1] * 0.5 + row[2] * 0.2 + 0.01 * (g.unit() * 2 - 1));
  const th0 = [1.7, 4.2];
  const Jfd = fdJacobian(Phi, th0, y, 1e-4);
  const Jgp = varproJacobian(Phi, dPhi, th0, y, false);
  const Jk = varproJacobian(Phi, dPhi, th0, y, true);
  const eGp = relErr(flat(Jgp), flat(Jfd));
  const eK = relErr(flat(Jk), flat(Jfd));
  assert.ok(eGp < 1e-7, `GP err ${eGp}`);
  assert.ok(eK > eGp, 'Kaufman should be less accurate than full GP here');
  // Full column rank asserted.
  assert.equal(columnRank(Phi(th0)), 3);
});

test('varpro: rank deficiency is detected, not silently solved', () => {
  // Proportional columns [g, s*g]: the merged-coefficient design forbids
  // this; the solver must detect and report it.
  const s = 3.0;
  const Phi = (th: number[]): number[][] =>
    T.map(t => {
      const gv = Math.exp(-th[0] * t) * Math.cos(th[1] * t);
      return [gv, s * gv];
    });
  const th0 = [1.2, 3.6];
  assert.equal(columnRank(Phi(th0)), 1);
  const g = new Pcg32(8);
  const y = T.map(() => g.unit());
  assert.throws(() => varproSolve(Phi, () => [], th0, y), /rank/);
});

test('varpro: rank-cutoff policy in the 1e-7..1e-11 zone', () => {
  // rankCutoff maps a sigma ratio to a policy decision.
  assert.equal(rankCutoff(1e-6), 'ok');
  assert.equal(rankCutoff(1e-8), 'regularize');
  assert.equal(rankCutoff(1e-12), 'reject');
  assert.equal(rankCutoff(0), 'reject');
});

test('varpro: QR pseudoinverse matches the normal-equation solution', () => {
  const g = new Pcg32(9);
  const m = 40, n = 3;
  const Phi: number[][] = [];
  for (let i = 0; i < m; i++) {
    Phi.push([1, g.unit(), g.unit()]);
  }
  const y = Phi.map(row => row[0] * 2 + row[1] * -1 + row[2] * 0.5);
  const Pp = qrPseudoinverse(Phi);
  const c = Pp.map(row => row.reduce((s, v, j) => s + v * y[j], 0));
  assert.ok(Math.abs(c[0] - 2) < 1e-9);
  assert.ok(Math.abs(c[1] + 1) < 1e-9);
  assert.ok(Math.abs(c[2] - 0.5) < 1e-9);
});

test('varpro: solve recovers nonlinear parameters on synthetic data', () => {
  const Phi = (th: number[]): number[][] =>
    T.map(t => [Math.exp(-th[0] * t), 1]);
  const dPhi = (th: number[]): number[][][] => [
    T.map(t => [-t * Math.exp(-th[0] * t), 0]),
  ];
  const yTrue = [2.5];
  const y = T.map(t => yTrue[0] * Math.exp(-2.0 * t) + 0.3);
  const sol = varproSolve(Phi, dPhi, [1.0], y, { maxIter: 60 });
  assert.ok(Math.abs(sol.theta[0] - 2.0) < 0.05, `theta=${sol.theta[0]}`);
  assert.ok(sol.residual < 1e-6, `residual=${sol.residual}`);
});
