// Unit tests for the V10 inverse solvers (runs in node, no browser).
// Every test uses synthetic data with known ground truth. Gradients are
// central finite differences throughout; no autodiff anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gradientDescent, solveLighting, lightCandidates, fitMaterialCoeffs,
  solveLightPosition, FD_EPS,
} from '../src/inverse/solvers.js';

test('solvers: gradient descent minimizes a quadratic exactly per spec', () => {
  // L(theta) = 1/2 * ((theta0 - 3)^2 + (theta1 + 2)^2); minimum at (3, -2).
  // Central differences are exact on quadratics, so the FD gradient here
  // equals the analytic one.
  const L = (t: number[]) => {
    const r0 = t[0] - 3, r1 = t[1] + 2;
    return 0.5 * (r0 * r0 + r1 * r1);
  };
  const { theta, log } = gradientDescent([0, 0], L, { eta: 0.5, maxIter: 500, tol: 1e-14 });
  assert.ok(Math.abs(theta[0] - 3) < 1e-6);
  assert.ok(Math.abs(theta[1] + 2) < 1e-6);
  assert.ok(log.residual < 1e-12);
  assert.ok(log.iterations > 0 && log.iterations <= 500);
  assert.ok(log.history.length >= 2);
  assert.ok(log.history[log.history.length - 1] <= log.history[0]);
});

test('solvers: gradient descent is deterministic', () => {
  const L = (t: number[]) => 0.5 * t[0] * t[0];
  const a = gradientDescent([5], L, { eta: 0.3 });
  const b = gradientDescent([5], L, { eta: 0.3 });
  assert.deepEqual(a.theta, b.theta);
  assert.deepEqual(a.log.history, b.log.history);
});

test('solvers: finite-difference step is documented and sane', () => {
  // FD_EPS sits near the classical central-difference optimum
  // eps_mach^(1/3) ~= 6e-6 for float64, with margin.
  assert.ok(FD_EPS >= 1e-6 && FD_EPS <= 1e-4);
});

test('solvers: solveLighting recovers known lights from synthetic samples', () => {
  // Ground truth: one warm light east, one cool light overhead.
  const truth = [
    { pos: [6, 3, 0] as [number, number, number], color: [2.0, 1.2, 0.6] as [number, number, number] },
    { pos: [0, 6, 0] as [number, number, number], color: [0.5, 0.7, 1.4] as [number, number, number] },
  ];
  const samples = [];
  const rng = (i: number) => ((i * 2654435761) % 1000) / 1000;
  for (let i = 0; i < 40; i++) {
    const pos: [number, number, number] = [(rng(i) - 0.5) * 6, 0, (rng(i + 50) - 0.5) * 6];
    const normal: [number, number, number] = [0, 1, 0];
    const target: [number, number, number] = [0, 0, 0];
    for (const Lgt of truth) {
      const dx = Lgt.pos[0] - pos[0], dy = Lgt.pos[1] - pos[1], dz = Lgt.pos[2] - pos[2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const cos = Math.max(0, dy / len);
      target[0] += Lgt.color[0] * cos;
      target[1] += Lgt.color[1] * cos;
      target[2] += Lgt.color[2] * cos;
    }
    samples.push({ pos, normal, target });
  }
  const candidates = lightCandidates(8, 6, 3);
  const sol = solveLighting(samples, candidates);
  assert.ok(sol.passed, `rmse ${sol.rmse}`);
  assert.ok(sol.log.iterations > 0);
  // The east candidate should carry most of the warm channel.
  let eastWarm = 0, totalWarm = 0;
  for (const Lgt of sol.lights) {
    totalWarm += Lgt.color[0];
    if (Lgt.position[0] > 3) eastWarm += Lgt.color[0];
  }
  assert.ok(eastWarm / Math.max(1e-9, totalWarm) > 0.5);
});

test('solvers: solveLighting reports residual honestly on impossible targets', () => {
  // Two samples at the same point with opposite normals, both demanding
  // full brightness, while every candidate light sits above the plane.
  // No non-negative intensity assignment can light both sides, so the
  // residual must stay large and the solve must report failure.
  const mk = (normal: [number, number, number]) => ({
    pos: [0, 0, 0] as [number, number, number],
    normal,
    target: [1, 1, 1] as [number, number, number],
  });
  const samples = [mk([0, 1, 0]), mk([0, -1, 0])];
  const sol = solveLighting(samples, lightCandidates(4, 1, 1), { rmsePass: 0.05 });
  assert.ok(!sol.passed);
  assert.ok(sol.rmse > 0.3, `rmse ${sol.rmse} should stay large`);
});

test('solvers: solveLightPosition drags the light to the target (acceptance shape)', () => {
  // Ground truth: one light at [3, 4, 0] with intensity 2 over an
  // up-facing plane. The solver starts across the scene and must drag
  // light_pos until the Lambert render matches.
  const truthPos: [number, number, number] = [3, 4, 0];
  const truthI = 2;
  const samples = [];
  const rng = (i: number) => ((i * 2654435761) % 1000) / 1000;
  for (let i = 0; i < 24; i++) {
    const pos: [number, number, number] = [(rng(i) - 0.5) * 6, 0, (rng(i + 77) - 0.5) * 6];
    const normal: [number, number, number] = [0, 1, 0];
    const dx = truthPos[0] - pos[0], dy = truthPos[1] - pos[1], dz = truthPos[2] - pos[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    samples.push({ pos, normal, target: truthI * Math.max(0, dy / len) });
  }
  const sol = solveLightPosition(
    samples,
    { position: [-2, 5, 1], intensity: 1 },
    { eta: 0.1, maxIter: 2000, rmsePass: 0.05 },
  );
  assert.ok(sol.passed, `rmse ${sol.rmse}, iters ${sol.log.iterations}`);
  const dp = Math.hypot(
    sol.position[0] - truthPos[0], sol.position[1] - truthPos[1], sol.position[2] - truthPos[2]);
  assert.ok(dp < 0.5, `light ended ${dp} from truth`);
  assert.ok(Math.abs(sol.intensity - truthI) < 0.25, `intensity ${sol.intensity}`);
  // The iteration log must show convergence: residual strictly falls
  // from the first logged value to the last.
  const h = sol.log.history;
  assert.ok(h.length >= 2);
  assert.ok(h[h.length - 1] < h[0], `residual ${h[0]} -> ${h[h.length - 1]}`);
});

test('solvers: fitMaterialCoeffs recovers known coefficients with R^2 ~ 1', () => {
  const basis = [(x: number) => 1, (x: number) => x, (x: number) => x * x];
  const samples = [];
  for (let i = 0; i <= 20; i++) {
    const x = i / 10 - 1;
    samples.push({ x, y: 2 + 3 * x - 1.5 * x * x });
  }
  const fit = fitMaterialCoeffs(basis, samples);
  assert.ok(fit.passed);
  assert.ok(Math.abs(fit.coeffs[0] - 2) < 1e-3);
  assert.ok(Math.abs(fit.coeffs[1] - 3) < 1e-3);
  assert.ok(Math.abs(fit.coeffs[2] + 1.5) < 1e-3);
  assert.ok(fit.r2 > 0.999);
});

test('solvers: fitMaterialCoeffs flags a bad basis honestly', () => {
  const basis = [(x: number) => 1];
  const samples = [];
  for (let i = 0; i <= 20; i++) {
    const x = i / 10;
    samples.push({ x, y: Math.sin(x * 6) });
  }
  const fit = fitMaterialCoeffs(basis, samples);
  assert.ok(!fit.passed);
  assert.ok(fit.r2 < 0.7);
});

test('solvers: conditioning diagnostic reports singular values in the log', () => {
  // theta = [rho, E] on pixel = rho*E*(n.l): exact null direction.
  const n = [0, 0, 1];
  const samples = [0.5, 0.8, 0.3].map((s) => ({ n, s }));
  const y = samples.map((sm) => 0.7 * 1.3 * sm.s);
  const L = (theta: number[]): number => {
    let c = 0;
    for (let j = 0; j < samples.length; j++) {
      const r = theta[0] * theta[1] * samples[j].s - y[j];
      c += r * r;
    }
    return 0.5 * c;
  };
  const r = (theta: number[]): number[] =>
    samples.map((sm, j) => theta[0] * theta[1] * sm.s - y[j]);
  const { log } = gradientDescent([0.5, 1.0], L, {
    eta: 0.1, maxIter: 200, tol: 1e-12, residuals: r,
  });
  assert.ok(log.singularValues && log.singularValues.length === 2);
  assert.ok(log.conditionNumber !== undefined && log.conditionNumber > 1e6);
  assert.ok(log.conditioningWarnings && log.conditioningWarnings.length > 0);
});

test('solvers: Tikhonov mu shrinks the solution toward zero', () => {
  const L = (theta: number[]): number => (theta[0] - 5) * (theta[0] - 5);
  const plain = gradientDescent([0], L, { eta: 0.1, maxIter: 500, tol: 1e-14 });
  const reg = gradientDescent([0], L, { eta: 0.1, maxIter: 500, tol: 1e-14, mu: 1 });
  assert.ok(Math.abs(plain.theta[0] - 5) < 1e-6);
  // min (t-5)^2 + t^2 -> t = 2.5.
  assert.ok(Math.abs(reg.theta[0] - 2.5) < 1e-3);
});
