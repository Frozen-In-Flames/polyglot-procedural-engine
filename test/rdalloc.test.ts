import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sensitivities, equalBudgetSteps, predictedMSEIncrease, quantize,
} from '../src/inverse/rdalloc.js';
import { Pcg32 } from '../src/math/determinism.js';

test('rdalloc: measured MSE increase matches the predicted dD', () => {
  // Linear model r = A theta - y. Quantize theta with steps D_i;
  // measured ||A(dtheta)||^2/n should match (1/n) sum s_i D_i^2/12.
  const g = new Pcg32(31);
  const n = 200, p = 20;
  const A: number[][] = Array.from({ length: n }, () =>
    Array.from({ length: p }, () => (g.unit() - 0.5) * 2),
  );
  const theta = Array.from({ length: p }, () => (g.unit() - 0.5) * 4);
  const s = sensitivities(A); // s_i = ||A_{:,i}||^2
  const Dtarget = 1e-4;
  const { steps: D } = equalBudgetSteps(s, n, p, Dtarget);
  const tq = quantize(theta, D);
  // Measured: ||A (tq - theta)||^2 / n.
  let num = 0;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let j = 0; j < p; j++) r += A[i][j] * (tq[j] - theta[j]);
    num += r * r;
  }
  const measured = num / n;
  const pred = predictedMSEIncrease(s, D, n);
  const rel = Math.abs(measured - pred) / pred;
  assert.ok(rel < 0.3, `measured=${measured} predicted=${pred} rel=${rel}`);
});

test('rdalloc: equal budget gives each parameter the same MSE share', () => {
  const s = [4, 1, 9, 0.25];
  const n = 100, p = 4, D = 0.01;
  const { steps } = equalBudgetSteps(s, n, p, D);
  // s_i * D_i^2 should be equal across i.
  const shares = steps.map((d, i) => s[i] * d * d);
  for (let i = 1; i < shares.length; i++) {
    assert.ok(Math.abs(shares[i] - shares[0]) / shares[0] < 1e-9);
  }
  // And the total predicted increase equals D.
  assert.ok(Math.abs(predictedMSEIncrease(s, steps, n) - D) / D < 1e-9);
});

test('rdalloc: bit counts from step sizes', () => {
  const { bits } = equalBudgetSteps([1], 10, 1, 0.01, [[-1, 1]]);
  // b = log2((hi-lo)/D_i); D_i = sqrt(12*n*D/(p*s)) = sqrt(1.2) ~ 1.095
  assert.ok(bits[0] > 0 && bits[0] < 2, `bits=${bits[0]}`);
});
