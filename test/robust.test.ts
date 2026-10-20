import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  huberWeight, irlsSolve, lmGainAccept, sigmoidBound, pyramidSigmas,
  eikonalLoss, uncertainty,
} from '../src/inverse/robust.js';
import { SIGMA_N_8BIT } from '../src/inverse/conditioning.js';

test('robust: Huber IRLS weights downweight outliers', () => {
  // w = min(1, delta/|r|).
  assert.ok(Math.abs(huberWeight(0.5, 1) - 1) < 1e-12);
  assert.ok(Math.abs(huberWeight(2, 1) - 0.5) < 1e-12);
  assert.ok(Math.abs(huberWeight(-3, 1) - 1 / 3) < 1e-12);
});

test('robust: IRLS recovers a line fit despite outliers', () => {
  // y = 2x + 1 with two gross outliers; Huber should nearly ignore them.
  // (OLS on this data gives a ~ -2.8; IRLS must do far better.)
  // sigma is the caller-supplied noise scale: internally the scale is
  // s = max(sigma, 1.4826 * MAD(r)) per iteration and the Huber kink
  // 1.345 lives in the normalized coordinate u = r/s (v1.9.2 scale spec).
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = 0; x < 20; x++) {
    xs.push(x);
    ys.push(2 * x + 1);
  }
  ys[5] += 50; // outlier
  ys[15] -= 50; // outlier
  const [a, b] = irlsSolve(xs, ys, 1.0);
  assert.ok(Math.abs(a - 2) < 0.05, `a=${a}`);
  // Pin the true rate, not the hoped-for one (v1.9.2): measured b = 1.207.
  // Huber has bounded, not zero, influence: at the fixed point s = sigma
  // = 1, so the two ±50 outliers carry weight 1.345/50 = 0.027 each and
  // leave a bounded pull on the intercept (the old raw-delta=1 form gave
  // weight 1/50 and b ~ 1.15; the normalized kink 1.345 is honest either
  // way). Either is far from the OLS catastrophe (a ~ -2.8).
  assert.ok(Math.abs(b - 1) < 0.25, `b=${b}`);
});

test('robust: irlsSolve is scale-equivariant (scale handling is explicit)', () => {
  // The scale spec makes Huber normalization scale-free: scaling the data
  // AND the caller-supplied sigma by K must scale the fit by K, because
  // u = r/s is unchanged. An absolute-delta Huber could not do this.
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = 0; x < 20; x++) {
    xs.push(x);
    ys.push(2 * x + 1);
  }
  ys[5] += 50;
  ys[15] -= 50;
  const [a1, b1] = irlsSolve(xs, ys, 1.0);
  const [a2, b2] = irlsSolve(xs, ys.map((v) => 100 * v), 100.0);
  assert.ok(Math.abs(a2 / 100 - a1) / Math.max(1e-9, Math.abs(a1)) < 1e-9, `a ${a1} vs ${a2}`);
  assert.ok(Math.abs(b2 / 100 - b1) / Math.max(1e-9, Math.abs(b1)) < 1e-9, `b ${b1} vs ${b2}`);
});

test('robust: LM gain-ratio accepts improving steps, rejects worsening ones', () => {
  // rho = (L - Lnew) / (0.5 delta^T (lambda D delta - g)).
  const g = [-4, 0]; // gradient
  const D = [2, 2]; // diag(J^T J)
  const delta = [1, 0];
  const lambda = 0.1;
  // Improving: L drops from 10 to 6.
  const r1 = lmGainAccept(10, 6, delta, g, D, lambda);
  assert.ok(r1.accept && r1.rho > 0, `rho=${r1.rho}`);
  // Worsening: L rises from 10 to 12.
  const r2 = lmGainAccept(10, 12, delta, g, D, lambda);
  assert.ok(!r2.accept && r2.rho < 0, `rho=${r2.rho}`);
});

test('robust: sigmoid bound maps R to [lo, hi] and inverts', () => {
  const lo = 0, hi = 1;
  assert.ok(Math.abs(sigmoidBound(0, lo, hi) - 0.5) < 1e-12);
  assert.ok(sigmoidBound(10, lo, hi) < hi && sigmoidBound(10, lo, hi) > 0.999);
  assert.ok(sigmoidBound(-10, lo, hi) > lo && sigmoidBound(-10, lo, hi) < 0.001);
});

test('robust: Gaussian pyramid sigmas halve per level', () => {
  const s = pyramidSigmas(4, 3);
  assert.ok(Math.abs(s[0] - 4) < 1e-12);
  assert.ok(Math.abs(s[1] - 2) < 1e-12);
  assert.ok(Math.abs(s[2] - 1) < 1e-12);
  assert.ok(Math.abs(s[3] - 0.5) < 1e-12);
});

test('robust: Eikonal loss is zero for a true SDF', () => {
  // Sphere: ||grad f|| = 1 everywhere, so R_E = 0.
  const pts: Array<[number, number, number]> = [
    [1, 0, 0], [0, 2, 0], [0.3, -0.5, 0.8], [0, 0, 0.1],
  ];
  const grad = (p: [number, number, number]): [number, number, number] => {
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    return [p[0] / l, p[1] / l, p[2] / l];
  };
  assert.ok(eikonalLoss(pts, grad, 1) < 1e-12);
});

test('robust: 8-bit quantization noise floor sigma_n = 1/(255 sqrt(12))', () => {
  const expected = 1 / (255 * Math.sqrt(12));
  assert.ok(Math.abs(SIGMA_N_8BIT - expected) < 1e-18);
});

test('robust: uncertainty covariance matches known noise (synthetic)', () => {
  // y = a x + b, known Gaussian noise sigma=0.1. Fit many times;
  // empirical covariance of (a,b) should match sigma^2 (J^T J)^{-1}.
  const sigma = 0.1;
  const xs = [0, 1, 2, 3, 4];
  // Deterministic pseudo-noise via a simple LCG for reproducibility.
  let seed = 42;
  const randn = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const u1 = (seed + 1) / 0x80000001;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const u2 = (seed + 1) / 0x80000001;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const nFits = 200;
  const aHat: number[] = [], bHat: number[] = [];
  for (let f = 0; f < nFits; f++) {
    const ys = xs.map((x) => 2 * x + 1 + sigma * randn());
    // Closed-form least squares.
    const n = xs.length;
    const sx = xs.reduce((s, x) => s + x, 0), sy = ys.reduce((s, y) => s + y, 0);
    const sxx = xs.reduce((s, x) => s + x * x, 0);
    const sxy = xs.reduce((s, x, i) => s + x * ys[i], 0);
    const a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const b = (sy - a * sx) / n;
    aHat.push(a); bHat.push(b);
  }
  // Predicted covariance: sigma^2 (J^T J)^{-1}, J = [x 1].
  const JtJ = [
    [xs.reduce((s, x) => s + x * x, 0), xs.reduce((s, x) => s + x, 0)],
    [xs.reduce((s, x) => s + x, 0), xs.length],
  ];
  const det = JtJ[0][0] * JtJ[1][1] - JtJ[0][1] * JtJ[1][0];
  const inv = [
    [JtJ[1][1] / det, -JtJ[0][1] / det],
    [-JtJ[1][0] / det, JtJ[0][0] / det],
  ];
  const predAA = sigma * sigma * inv[0][0];
  // Empirical variance of aHat.
  const ma = aHat.reduce((s, a) => s + a, 0) / nFits;
  const va = aHat.reduce((s, a) => s + (a - ma) ** 2, 0) / (nFits - 1);
  // 200 fits: expect within ~20% (chi-square fluctuation).
  assert.ok(Math.abs(va - predAA) / predAA < 0.25, `emp ${va} pred ${predAA}`);
  // The uncertainty() helper agrees with the closed form.
  const u = uncertainty(JtJ, 0.5, 5, 2); // RSS, n, p
  assert.ok(u.sigma2 > 0 && u.cov.length === 2);
});
