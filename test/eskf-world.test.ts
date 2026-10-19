import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  esfInit, esfPredict, esfUpdate, esfApplyCorrection,
  esfPredictF, esfUpdateH, quatExp, quatToMat3,
} from '../src/xr/camera.js';
import { multiply } from '../src/math/quat.js';
import { mulberry32 } from '../src/geo/rng.js';
import type { Vec3 } from '../src/math/vec.js';
import type { Quat } from '../src/math/quat.js';

// Port of docs/oracles/eskf_oracle.py (world-frame error parametrization).
// Conventions: R = body->world, R_true = Exp(dtheta) R_hat (left/world error),
// bias error db = b_true - b_hat with the bias in the body frame.

// so3Exp via Rodrigues: independent reference for the injection identity.
function so3Exp(v: Vec3): number[][] {
  const th = Math.hypot(v[0], v[1], v[2]);
  const K = [
    [0, -v[2], v[1]],
    [v[2], 0, -v[0]],
    [-v[1], v[0], 0],
  ];
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (th < 1e-12) return I;
  const s = Math.sin(th) / th, c = (1 - Math.cos(th)) / (th * th);
  const K2 = matMul3(K, K);
  return I.map((row, i) => row.map((_, j) => row[j] + s * K[i][j] + c * K2[i][j]));
}

function matMul3(A: number[][], B: number[][]): number[][] {
  return A.map((row, i) =>
    row.map((_, j) => row.reduce((s, _, k) => s + A[i][k] * B[k][j], 0)),
  );
}

function matDiff3(A: number[][], B: number[][]): number {
  let m = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) m = Math.max(m, Math.abs(A[i][j] - B[i][j]));
  }
  return m;
}

function randQuat(rng: () => number): Quat {
  const q: Quat = [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1];
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

// Q1. Quaternion order: R(q1 (x) q2) = R(q1) R(q2).
test('eskf: R(q1 tensor q2) = R(q1) R(q2)', () => {
  const rng = mulberry32(3);
  let worst = 0;
  for (let t = 0; t < 50; t++) {
    const q1 = randQuat(rng), q2 = randQuat(rng);
    worst = Math.max(worst, matDiff3(quatToMat3(multiply(q1, q2)), matMul3(quatToMat3(q1), quatToMat3(q2))));
  }
  assert.ok(worst < 1e-12, `worst ${worst}`);
});

// Q1. World-frame (left) injection: R(Exp(v) tensor q) = Exp(v) R(q).
// The right-multiplied order is detectably different (the order bug).
test('eskf: injection is left multiplication', () => {
  const rng = mulberry32(5);
  let worstOk = 0, worstWrong = 0;
  for (let t = 0; t < 50; t++) {
    const q = randQuat(rng);
    const v: Vec3 = [(rng() - 0.5) * 0.6, (rng() - 0.5) * 0.6, (rng() - 0.5) * 0.6];
    const left = quatToMat3(multiply(quatExp(v), q));
    const want = matMul3(so3Exp(v), quatToMat3(q));
    worstOk = Math.max(worstOk, matDiff3(left, want));
    const wrong = quatToMat3(multiply(q, quatExp(v)));
    worstWrong = Math.max(worstWrong, matDiff3(wrong, want));
  }
  assert.ok(worstOk < 1e-12, `left-mult worst ${worstOk}`);
  assert.ok(worstWrong > 1e-3, `right-mult must differ, worst ${worstWrong}`);
});

// F = [[I, -dt R_hat], [0, I]] against hand-computed values.
// qhat = 90 deg about z: R = [[0,-1,0],[1,0,0],[0,0,1]], dt = 0.02.
test('eskf: world-frame F matrix identity', () => {
  const s = Math.SQRT1_2;
  const q: Quat = [0, 0, s, s];
  const dt = 0.02;
  const F = esfPredictF(q, dt);
  const R = [[0, -1, 0], [1, 0, 0], [0, 0, 1]];
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      let want = 0;
      if (i === j) want = 1;
      else if (i < 3 && j >= 3) want = -dt * R[i][j - 3];
      assert.ok(Math.abs(F[i][j] - want) < 1e-12, `F[${i}][${j}] = ${F[i][j]}, want ${want}`);
    }
  }
  // Discriminating entries: -dt*R, not -dt*I (body frame) and no skew term.
  assert.ok(Math.abs(F[0][4] - 0.02) < 1e-12, `F[0][4] = ${F[0][4]} (sign pins the bias block)`);
  assert.ok(Math.abs(F[0][3]) < 1e-12, `F[0][3] = ${F[0][3]}`);
  assert.ok(Math.abs(F[1][3] + 0.02) < 1e-12, `F[1][3] = ${F[1][3]}`);
});

// H = [R_hat^T [g_w]_x, 0] against hand-computed values; yaw column is zero.
test('eskf: world-frame H matrix identity, yaw column zero', () => {
  // Identity attitude, g = +z: H[:3,:3] = skew([0,0,1]).
  const H0 = esfUpdateH([0, 0, 0, 1], [0, 0, 1]);
  const want0 = [[0, -1, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 6; j++) {
      assert.ok(Math.abs(H0[i][j] - want0[i][j]) < 1e-12, `H[${i}][${j}] = ${H0[i][j]}`);
    }
  }
  // 90 deg about z: H[:3,:3] = R^T skew(u) = [[1,0,0],[0,1,0],[0,0,0]].
  const s = Math.SQRT1_2;
  const H1 = esfUpdateH([0, 0, s, s], [0, 0, 1]);
  const want1 = [[1, 0, 0], [0, 1, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      assert.ok(Math.abs(H1[i][j] - want1[i][j]) < 1e-12, `H[${i}][${j}] = ${H1[i][j]}`);
    }
  }
  // Gravity cannot see world yaw, independent of the estimate: column 2 is zero.
  const rng = mulberry32(9);
  for (let t = 0; t < 20; t++) {
    const H = esfUpdateH(randQuat(rng), [0, 0, 1]);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(H[i][2]) < 1e-12, `yaw column H[${i}][2] = ${H[i][2]}`);
    }
  }
});

// Injection: q <- Exp(dtheta) tensor q, b <- b + db (signs pinned).
test('eskf: correction injection formulas', () => {
  const s = esfInit();
  esfApplyCorrection(s, [0.1, 0, 0], [0.01, -0.02, 0.03]);
  const want: Quat = [Math.sin(0.05), 0, 0, Math.cos(0.05)];
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(s.q[i] - want[i]) < 1e-12, `q[${i}] = ${s.q[i]}`);
  }
  assert.ok(Math.abs(s.b[0] - 0.01) < 1e-15 && Math.abs(s.b[1] + 0.02) < 1e-15 && Math.abs(s.b[2] - 0.03) < 1e-15);
  // Non-identity: the rotation composes on the left.
  const s2 = esfInit();
  const rng = mulberry32(13);
  const q0 = randQuat(rng);
  s2.q = q0;
  const dv: Vec3 = [0.05, -0.03, 0.02];
  esfApplyCorrection(s2, dv, [0, 0, 0]);
  const got = quatToMat3(s2.q);
  const wantR = matMul3(so3Exp(dv), quatToMat3(q0));
  assert.ok(matDiff3(got, wantR) < 1e-12, 'R(q_new) = Exp(dtheta) R(q_old)');
});

// Behavioral sign check: a +x tilt must be corrected toward +x, not away.
// A sign-flipped H would drive the estimate the wrong way and fail here.
test('eskf: update corrects a tilted estimate toward truth', () => {
  const qTrue = quatExp([0.1, 0, 0]);
  const Rt = quatToMat3(qTrue);
  const z: Vec3 = [Rt[2][0], Rt[2][1], Rt[2][2]]; // R_true^T u, u = +z
  const s = esfInit();
  for (let i = 0; i < 6; i++) s.P[i][i] = i < 3 ? 0.01 : 1e-8;
  const dotBefore = Math.abs(s.q[3] * qTrue[3]); // s.q = identity
  const tiltBefore = 2 * Math.acos(Math.min(1, dotBefore));
  assert.ok(Math.abs(tiltBefore - 0.1) < 1e-9, `tilt before = ${tiltBefore}`);
  esfUpdate(s, z, [0, 0, 1], 1e-8);
  assert.ok(s.q[0] > 0, `correction must rotate +x, got q[0] = ${s.q[0]}`);
  const dot = Math.abs(s.q[0] * qTrue[0] + s.q[1] * qTrue[1] + s.q[2] * qTrue[2] + s.q[3] * qTrue[3]);
  const tiltAfter = 2 * Math.acos(Math.min(1, dot));
  assert.ok(tiltAfter < tiltBefore, `tilt ${tiltBefore} -> ${tiltAfter}`);
  assert.ok(tiltAfter < 0.01, `tilt after = ${tiltAfter}`);
});

// Predict propagates the nominal quaternion and the world-frame covariance.
test('eskf: predict integrates the gyro and propagates P with F', () => {
  const s = esfInit();
  for (let i = 0; i < 6; i++) s.P[i][i] = 1e-4;
  esfPredict(s, [0, 0, 1], 0.1, 0, 0);
  // 0.1 rad about z: q = [0, 0, sin(0.05), cos(0.05)].
  assert.ok(Math.abs(s.q[2] - Math.sin(0.05)) < 1e-12, `q = ${s.q}`);
  assert.ok(Math.abs(s.q[3] - Math.cos(0.05)) < 1e-12);
  // P = F P F^T with the world-frame F: diagonal entries are non-decreasing
  // (the -dt*R_hat cross block only adds non-negative terms).
  for (let i = 0; i < 6; i++) {
    assert.ok(Number.isFinite(s.P[i][i]) && s.P[i][i] >= 1e-4, `P[${i}][${i}] = ${s.P[i][i]}`);
  }
});
