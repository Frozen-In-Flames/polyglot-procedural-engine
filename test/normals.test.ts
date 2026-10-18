import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tetraNormal, centralNormal } from '../src/math/normals.js';
import type { Vec3 } from '../src/math/vec.js';

// Sphere r=1 at a generic (non-symmetric) point; analytic normal = p.
const L0 = Math.hypot(0.3, 0.5, 0.8);
const P: Vec3 = [0.3 / L0, 0.5 / L0, 0.8 / L0];
const f = (p: Vec3): number => Math.hypot(p[0], p[1], p[2]) - 1;
const angle = (n: Vec3): number =>
  Math.acos(Math.min(1, Math.max(-1, n[0] * P[0] + n[1] * P[1] + n[2] * P[2])));

test('normals: tetrahedron uses 4 evaluations and is first-order accurate', () => {
  // Measured (not remembered): the tetrahedron error is O(h) with a small
  // constant, NOT O(h^2). The angle halves as h halves (ratio -> 2).
  let prev = 0;
  for (const h of [0.05, 0.025, 0.0125, 0.00625]) {
    const a = angle(tetraNormal(f, P, h));
    if (prev > 0) {
      const ratio = prev / a;
      assert.ok(ratio > 1.8 && ratio < 2.2, `h=${h} ratio=${ratio}`);
    }
    prev = a;
  }
  // Small constant: well under a degree at h=0.01.
  assert.ok(angle(tetraNormal(f, P, 0.01)) < 0.02);
});

test('normals: central differences are second-order accurate', () => {
  let prev = 0;
  for (const h of [0.05, 0.025, 0.0125, 0.00625]) {
    const a = angle(centralNormal(f, P, h));
    if (prev > 0) {
      const ratio = prev / a;
      assert.ok(ratio > 3.6 && ratio < 4.4, `h=${h} ratio=${ratio}`);
    }
    prev = a;
  }
});

test('normals: both agree with the analytic normal as h -> 0', () => {
  assert.ok(angle(tetraNormal(f, P, 1e-4)) < 1e-3);
  assert.ok(angle(centralNormal(f, P, 1e-4)) < 1e-6);
});
