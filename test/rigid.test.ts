import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromAxisAngle, toMat4, qIdentity, type Quat } from '../src/math/quat.js';
import {
  rodrigues, integrateQuaternion, eulerStep, symplecticPendulum,
} from '../src/math/rigid.js';
import type { Vec3 } from '../src/math/vec.js';

test('rigid: Rodrigues equals the quaternion rotation matrix', () => {
  const w: Vec3 = [0.3, -0.5, 0.8];
  const R = rodrigues(w);
  const theta = Math.hypot(w[0], w[1], w[2]);
  const axis: Vec3 = [w[0] / theta, w[1] / theta, w[2] / theta];
  const q = fromAxisAngle(axis, theta);
  const M = toMat4(q); // column-major 4x4, float32 storage
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(R[r][c] - M[c * 4 + r]) < 1e-6, `R[${r}][${c}]`);
    }
  }
});

test('rigid: quaternion stays unit length after 1e6 integration steps', () => {
  let q: Quat = qIdentity();
  const w: Vec3 = [0.1, 0.2, 0.3];
  const h = 1e-3;
  for (let i = 0; i < 1e6; i++) q = integrateQuaternion(q, w, h);
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  assert.ok(Math.abs(n - 1) < 1e-9, `|q|=${n}`);
});

test('rigid: torque-free Euler step preserves angular velocity for spherical inertia', () => {
  // With I = (1,1,1), w x (I w) = 0, so w_dot = 0 exactly.
  const I: Vec3 = [1, 1, 1];
  const w: Vec3 = [0.5, 0.3, 0.2];
  const w2 = eulerStep(I, w, [0, 0, 0], 0.01);
  assert.ok(Math.abs(w2[0] - w[0]) < 1e-15);
  assert.ok(Math.abs(w2[1] - w[1]) < 1e-15);
  assert.ok(Math.abs(w2[2] - w[2]) < 1e-15);
});

test('rigid: frictionless pendulum energy stays bounded (symplectic Euler)', () => {
  const g = 9.81, L = 1.0, h = 0.01;
  let th = 0.5, om = 0;
  const E0 = 0.5 * (L * om) ** 2 + g * L * (1 - Math.cos(th));
  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    [th, om] = symplecticPendulum(th, om, g, L, h);
    const E = 0.5 * (L * om) ** 2 + g * L * (1 - Math.cos(th));
    worst = Math.max(worst, Math.abs(E - E0) / E0);
  }
  assert.ok(worst < 0.02, `relative energy drift ${worst}`);
});
