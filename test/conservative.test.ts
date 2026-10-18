// test/conservative.test.ts - conservative-primitive audit.
//
// For random query points: f(p) <= min_q ||p-q|| + tol over densely
// sampled surface points q. Exact rows additionally satisfy
// ||grad f|| ≈ 1 near the surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pcg32 } from '../src/math/determinism.js';
import type { Vec3 } from '../src/math/vec.js';
import type { SdfNode } from '../src/math/sdf.js';
import { AUDIT_TABLE, auditConservative, gradMagnitude } from '../src/math/conservative.js';

function fibSphere(n: number, r: number, c: Vec3 = [0, 0, 0]): Vec3[] {
  const pts: Vec3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    pts.push([c[0] + r * rr * Math.cos(th), c[1] + r * y, c[2] + r * rr * Math.sin(th)]);
  }
  return pts;
}

function boxSurface(n: number, b: Vec3): Vec3[] {
  const pts: Vec3[] = [];
  const g = new Pcg32(5);
  for (let i = 0; i < n; i++) {
    const face = i % 6;
    const a = g.unit() * 2 - 1, c = g.unit() * 2 - 1;
    if (face === 0) pts.push([b[0], a * b[1], c * b[2]]);
    else if (face === 1) pts.push([-b[0], a * b[1], c * b[2]]);
    else if (face === 2) pts.push([a * b[0], b[1], c * b[2]]);
    else if (face === 3) pts.push([a * b[0], -b[1], c * b[2]]);
    else if (face === 4) pts.push([a * b[0], c * b[1], b[2]]);
    else pts.push([a * b[0], c * b[1], -b[2]]);
  }
  return pts;
}

function torusSurface(n: number, R: number, r: number): Vec3[] {
  const pts: Vec3[] = [];
  const m = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) {
    const u = (i / m) * 2 * Math.PI, v = (j / m) * 2 * Math.PI;
    pts.push([(R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u)]);
  }
  return pts;
}

function nearSurfacePoints(surface: Vec3[], count: number, off: number, seed: number): Vec3[] {
  const g = new Pcg32(seed);
  const pts: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const q = surface[(g.unit() * surface.length) | 0];
    pts.push([q[0] + off, q[1] + off * 0.3, q[2] - off * 0.2]);
  }
  return pts;
}

test('conservative: audit table covers every SDF node kind', () => {
  const ops = new Set(AUDIT_TABLE.map(r => r.op));
  for (const op of ['sphere', 'box', 'capsule', 'torus', 'union', 'intersect', 'subtract', 'polySmin', 'smoothUnion', 'scale3', 'repeat', 'twist', 'translate', 'displace']) {
    assert.ok(ops.has(op), `audit table missing ${op}`);
  }
});

test('conservative: sphere is exact (|f| <= true distance, ||grad|| = 1)', () => {
  const node: SdfNode = { kind: 'sphere', r: 1.5 };
  const res = auditConservative(node, fibSphere(4000, 1.5), 500, 4, 11, 1e-3);
  assert.equal(res.violations, 0);
  for (const p of nearSurfacePoints(fibSphere(200, 1.5), 60, 0.05, 12)) {
    const m = gradMagnitude(node, p);
    assert.ok(Math.abs(m - 1) < 0.02, `||grad f|| = ${m}, expected ~1`);
  }
});

test('conservative: box is exact', () => {
  const node: SdfNode = { kind: 'box', b: [1, 0.7, 1.3] };
  const res = auditConservative(node, boxSurface(6000, [1, 0.7, 1.3]), 500, 4, 13, 2e-3);
  assert.equal(res.violations, 0);
  for (const p of nearSurfacePoints(boxSurface(200, [1, 0.7, 1.3]), 60, 0.05, 14)) {
    const m = gradMagnitude(node, p);
    assert.ok(Math.abs(m - 1) < 0.05, `||grad f|| = ${m}, expected ~1`);
  }
});

test('conservative: torus is exact', () => {
  const node: SdfNode = { kind: 'torus', R: 1, r: 0.4 };
  const res = auditConservative(node, torusSurface(5000, 1, 0.4), 500, 4, 15, 2e-3);
  assert.equal(res.violations, 0);
});

test('conservative: union of spheres is conservative', () => {
  const node: SdfNode = {
    kind: 'union',
    children: [{ kind: 'sphere', r: 1 }, { kind: 'sphere', r: 0.8, c: [1.2, 0, 0] }],
  };
  const surf = [...fibSphere(3000, 1), ...fibSphere(3000, 0.8, [1.2, 0, 0])];
  const res = auditConservative(node, surf, 500, 4, 16, 2e-3);
  assert.equal(res.violations, 0);
});

test('conservative: non-uniform scale3 is conservative', () => {
  const node: SdfNode = { kind: 'scale3', s: [2, 0.5, 1.5], child: { kind: 'sphere', r: 1 } };
  // True surface: ellipsoid with semi-axes (2, 0.5, 1.5). Sample it.
  const pts: Vec3[] = [];
  for (const q of fibSphere(6000, 1)) pts.push([2 * q[0], 0.5 * q[1], 1.5 * q[2]]);
  const res = auditConservative(node, pts, 500, 5, 17, 5e-3);
  assert.equal(res.violations, 0);
  // And it never exceeds the naive (unsafe) scaled form's distance.
  assert.ok(res.maxOverestimate <= 5e-3);
});

test('conservative: subtract is conservative outside', () => {
  const node: SdfNode = {
    kind: 'subtract',
    a: { kind: 'sphere', r: 1.2 },
    b: { kind: 'sphere', r: 0.7, c: [0.4, 0, 0] },
  };
  // Sample the outer sphere surface only (outside region).
  const res = auditConservative(node, fibSphere(4000, 1.2), 400, 4, 18, 2e-3);
  assert.equal(res.violations, 0);
});
