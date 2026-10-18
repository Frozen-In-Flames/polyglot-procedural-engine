// test/geograd.test.ts - geometry gradients, ported from
// docs/oracles/geometry_gradients.py.
//
// 1. Hit point:  dt*/dtheta = -(df/dtheta) / (grad f . d)
// 2. Normal:     dn/dtheta = (I - n n^T)(H d dt*/dtheta + d/dtheta grad f)/||grad f||
// 3. Silhouette (2D disk identities, VALIDATED): coverage derivative =
//    in-pixel arc length; translation derivative = contour (v.n) integral.
//    The 3D silhouette normal-speed derivation is UNVALIDATED (from memory)
//    and flagged as such in src/inverse/geograd.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec3 } from '../src/math/vec.js';
import {
  hitPointGradient, normalGradient, silhouetteDiskTerms,
  type FieldDerivs,
} from '../src/inverse/geograd.js';

// Oracle field: f = sqrt((x/a)^2+(y/b)^2+(z/c)^2) - 1 + k sin(2x) y.
// Deliberately NOT a true SDF (|grad f| != 1) so the 1/|grad f|
// normalization is exercised. Derivatives derived by hand.
function makeField(): FieldDerivs {
  const f = (p: Vec3, th: number[]): number => {
    const [a, b, c, k] = th;
    const s = Math.sqrt((p[0] / a) ** 2 + (p[1] / b) ** 2 + (p[2] / c) ** 2);
    return s - 1 + k * Math.sin(2 * p[0]) * p[1];
  };
  const grad = (p: Vec3, th: number[]): Vec3 => {
    const [a, b, c, k] = th;
    const s = Math.sqrt((p[0] / a) ** 2 + (p[1] / b) ** 2 + (p[2] / c) ** 2);
    return [
      p[0] / (a * a * s) + 2 * k * Math.cos(2 * p[0]) * p[1],
      p[1] / (b * b * s) + k * Math.sin(2 * p[0]),
      p[2] / (c * c * s),
    ];
  };
  const hess = (p: Vec3, th: number[]): number[][] => {
    // Finite-difference Hessian (test reference only; the formula under
    // test takes H as input).
    const h = 1e-5;
    const H: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const pp: Vec3 = [p[0], p[1], p[2]]; pp[i] += h;
      const pm: Vec3 = [p[0], p[1], p[2]]; pm[i] -= h;
      const gp = grad(pp, th), gm = grad(pm, th);
      H[i][j] = (gp[j] - gm[j]) / (2 * h);
    }
    return H;
  };
  const dThetaF = (p: Vec3, th: number[], k: number): number => {
    const [a, b, c] = th;
    const s = Math.sqrt((p[0] / a) ** 2 + (p[1] / b) ** 2 + (p[2] / c) ** 2);
    if (k === 0) return -((p[0] * p[0]) / (a ** 3)) / s;
    if (k === 1) return -((p[1] * p[1]) / (b ** 3)) / s;
    if (k === 2) return -((p[2] * p[2]) / (c ** 3)) / s;
    return Math.sin(2 * p[0]) * p[1]; // k = 3
  };
  const dThetaGrad = (p: Vec3, th: number[], k: number): Vec3 => {
    // Finite differences over theta (test reference only).
    const h = 1e-7;
    const tp = [...th], tm = [...th];
    tp[k] += h; tm[k] -= h;
    const gp = grad(p, tp), gm = grad(p, tm);
    return [(gp[0] - gm[0]) / (2 * h), (gp[1] - gm[1]) / (2 * h), (gp[2] - gm[2]) / (2 * h)];
  };
  return { f, grad, hess, dThetaF, dThetaGrad };
}

// Bisection root finder along the ray (field is monotonic in the bracket).
function hit(field: FieldDerivs, o: Vec3, d: Vec3, th: number[]): number {
  const F = (t: number): number =>
    field.f([o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]], th);
  let lo = 0.5, hi = 3.0;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (F(lo) * F(mid) <= 0) hi = mid; else lo = mid;
  }
  return 0.5 * (lo + hi);
}

function normalAt(field: FieldDerivs, o: Vec3, d: Vec3, th: number[]): Vec3 {
  const t = hit(field, o, d, th);
  const p: Vec3 = [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
  const g = field.grad(p, th);
  const l = Math.hypot(g[0], g[1], g[2]) || 1;
  return [g[0] / l, g[1] / l, g[2] / l];
}

const O: Vec3 = [0.35, 0.2, -3.0];
const D0: Vec3 = (() => {
  const d: Vec3 = [0.02, -0.03, 1.0];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
})();
const TH0 = [1.3, 0.9, 1.1, 0.15];

test('geograd: dt*/dtheta matches re-solved central differences', () => {
  const field = makeField();
  const tStar = hit(field, O, D0, TH0);
  let worst = 0;
  for (let k = 0; k < 4; k++) {
    const analytic = hitPointGradient(field, O, D0, TH0, tStar, k);
    const h = 1e-5;
    const tp = [...TH0], tm = [...TH0];
    tp[k] += h; tm[k] -= h;
    const fd = (hit(field, O, D0, tp) - hit(field, O, D0, tm)) / (2 * h);
    const rel = Math.abs(analytic - fd) / Math.max(Math.abs(fd), 1e-12);
    worst = Math.max(worst, rel);
  }
  assert.ok(worst < 1e-6, `worst rel err ${worst}`);
});

test('geograd: dn/dtheta matches re-solved central differences', () => {
  const field = makeField();
  const tStar = hit(field, O, D0, TH0);
  let worst = 0;
  for (let k = 0; k < 4; k++) {
    const analytic = normalGradient(field, O, D0, TH0, tStar, k);
    const h = 1e-5;
    const tp = [...TH0], tm = [...TH0];
    tp[k] += h; tm[k] -= h;
    const np = normalAt(field, O, D0, tp), nm = normalAt(field, O, D0, tm);
    const fd: Vec3 = [(np[0] - nm[0]) / (2 * h), (np[1] - nm[1]) / (2 * h), (np[2] - nm[2]) / (2 * h)];
    const rel = Math.hypot(fd[0] - analytic[0], fd[1] - analytic[1], fd[2] - analytic[2]) /
      Math.max(Math.hypot(...fd), 1e-12);
    worst = Math.max(worst, rel);
  }
  assert.ok(worst < 1e-4, `worst rel err ${worst}`);
});

test('geograd: silhouette disk identities (2D, validated)', () => {
  // d/dr Area(disk ∩ pixel) = arc length of circle inside the pixel;
  // d/dcx Area = contour integral of (v.n) dl with v = (1,0).
  for (const [cx, cy, r] of [[0.4, 0.5, 0.35], [0.9, 0.2, 0.5], [1.1, 0.5, 0.45], [0.5, 0.5, 0.3]] as const) {
    const { arcLength, contourVn } = silhouetteDiskTerms(cx, cy, r);
    const h = 1e-4;
    const dAdr = (diskCoverage(cx, cy, r + h) - diskCoverage(cx, cy, r - h)) / (2 * h);
    const dAdcx = (diskCoverage(cx + h, cy, r) - diskCoverage(cx - h, cy, r)) / (2 * h);
    assert.ok(Math.abs(dAdr - arcLength) < 5e-3, `dA/dr ${dAdr} vs arc ${arcLength}`);
    assert.ok(Math.abs(dAdcx - contourVn) < 5e-3, `dA/dcx ${dAdcx} vs contour ${contourVn}`);
  }
});

// Midpoint-rule disk coverage in the unit pixel (oracle reference).
function diskCoverage(cx: number, cy: number, r: number, N = 200000): number {
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / N;
    const half = Math.sqrt(Math.max(r * r - (x - cx) ** 2, 0));
    const lo = Math.min(1, Math.max(0, cy - half));
    const hi = Math.min(1, Math.max(0, cy + half));
    sum += hi - lo;
  }
  return sum / N;
}
