import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jacobiEigen, singularValues, diagnoseConditioning, finiteJacobian,
} from '../src/inverse/conditioning.js';

type V3 = [number, number, number];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
// Deterministic normal samples.
const NORMALS: V3[] = (
  [
    [0, 0, 1], [0.5, 0, 0.866], [-0.5, 0.3, 0.812], [0.2, -0.6, 0.775],
    [0, 0.8, 0.6], [-0.7, -0.2, 0.684], [0.9, 0.1, 0.424], [0.1, 0.1, 0.99],
  ] as V3[]
).map(norm);
const LIGHT = norm([0.3, 0.4, 0.85]);

test('conditioning: jacobiEigen diagonalizes a symmetric matrix', () => {
  const { values } = jacobiEigen([[2, 1], [1, 2]]);
  const s = [...values].sort((a, b) => a - b);
  assert.ok(Math.abs(s[0] - 1) < 1e-9 && Math.abs(s[1] - 3) < 1e-9);
});

test('conditioning: singular values of a diagonal Jacobian', () => {
  // Columns are normalized before the SVD, so sigma is [1, 1] and the
  // raw column scales [3, 1] are reported separately.
  const J = [[3, 0], [0, 0], [0, 1]];
  const { sigma, scales } = singularValues(J);
  assert.ok(Math.abs(sigma[0] - 1) < 1e-9);
  assert.ok(Math.abs(sigma[1] - 1) < 1e-9);
  assert.ok(Math.abs(scales[0] - 3) < 1e-9);
  assert.ok(Math.abs(scales[1] - 1) < 1e-9);
});

test('conditioning: albedo-intensity pair gives a near-zero singular value', () => {
  // pixel = rho * E * max(0, n.s): only the product is visible, so
  // (rho, E) -> (s rho, E/s) is an exact null direction.
  const y = NORMALS.map((n) => 0.7 * 1.3 * Math.max(0, dot(n, LIGHT)));
  const r = (theta: number[]): number[] =>
    NORMALS.map((n, j) => theta[0] * theta[1] * Math.max(0, dot(n, LIGHT)) - y[j]);
  const J = finiteJacobian(r, [0.7, 1.3]);
  const rep = diagnoseConditioning(J);
  assert.equal(rep.sigma.length, 2);
  assert.ok(rep.sigma[1] / rep.sigma[0] < 1e-8, `sigma=${rep.sigma}`);
  assert.ok(rep.warnings.length > 0);
  assert.ok(rep.kappa > 1e8);
});

test('conditioning: GBR transform leaves images identical with null directions', () => {
  const rho = 0.8;
  const G = (mu: number, nu: number, lam: number) => ({
    fwd: (v: V3): V3 => [v[0], v[1], mu * v[0] + nu * v[1] + lam * v[2]],
    invT: (v: V3): V3 => [v[0] - (mu / lam) * v[2], v[1] - (nu / lam) * v[2], v[2] / lam],
  });
  const pixel = (mu: number, nu: number, lam: number, j: number): number => {
    const g = G(mu, nu, lam);
    const b: V3 = [rho * NORMALS[j][0], rho * NORMALS[j][1], rho * NORMALS[j][2]];
    return Math.max(0, dot(g.invT(b), g.fwd(LIGHT)));
  };
  // Identity: the G transform changes nothing in the image.
  for (let j = 0; j < NORMALS.length; j++) {
    assert.ok(Math.abs(pixel(0, 0, 1, j) - pixel(0.3, -0.2, 1.5, j)) < 1e-12);
  }
  // ...so the GBR parameters are invisible: null singular directions.
  const y = NORMALS.map((_, j) => pixel(0, 0, 1, j));
  const r = (theta: number[]): number[] =>
    NORMALS.map((_, j) => pixel(theta[0], theta[1], theta[2], j) - y[j]);
  const J = finiteJacobian(r, [0.3, -0.2, 1.5]);
  const rep = diagnoseConditioning(J);
  assert.ok(rep.warnings.length > 0, 'expected null-direction warnings');
  assert.ok(rep.sigma.every((s) => s / (rep.sigma[0] || 1) < 1e-6 || rep.sigma[0] === 0));
});
