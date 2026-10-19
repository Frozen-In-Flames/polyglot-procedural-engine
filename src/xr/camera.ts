// xr/camera.ts - XR cameras and reprojection.
//
// Per-eye ray from signed FOV tangents, u,v in [-1,1]:
//   d_eye = (tan_L + (u+1)/2 (tan_R - tan_L),
//            tan_D + (v+1)/2 (tan_U - tan_D), -1),
//   d = R_eye d_eye / ||d_eye||.
// Eye origins: o_{L/R} = o_head -/+ (IPD/2) R_head e_x.
// Position+rotation reprojection using march depth t:
//   p = o + t d,   x' ~ K' R'^{-1} (p - o').
//
// Tracking uses the ERROR-STATE filter (not the linear Kalman form),
// world-frame (left) error: R_true = Exp(dtheta) R_hat:
//   qhat <- qhat tensor Exp((omega_m - bhat) dt)   (nominal propagation),
//   P <- F P F^T + Q,  F = [[I, -dt R_hat], [0, I]],
//   K = P H^T (H P H^T + R_m)^{-1},  H = [R_hat^T [g_w]_x, 0],
//   qhat <- Exp(dx_theta) tensor qhat,  bhat <- bhat + dx_b,  no reset.
// The linear Kalman equations are dropped per the canonical reference.

import type { Vec3 } from '../math/vec.js';
import { multiply, type Quat } from '../math/quat.js';
import type { Mat3 } from '../render/foveation.js';

export interface EyeFov {
  tanL: number;
  tanR: number;
  tanD: number;
  tanU: number;
}

export interface EyeRay {
  origin: Vec3;
  dir: Vec3;
}

/** Per-eye ray for NDC pixel (u, v) in [-1, 1]. */
export function eyeRay(
  fov: EyeFov,
  ipd: number,
  eye: 'left' | 'right',
  u: number,
  v: number,
  headPos: Vec3 = [0, 0, 0],
  headRight: Vec3 = [1, 0, 0],
): EyeRay {
  const dx = fov.tanL + ((u + 1) / 2) * (fov.tanR - fov.tanL);
  const dy = fov.tanD + ((v + 1) / 2) * (fov.tanU - fov.tanD);
  const dir: Vec3 = [dx, dy, -1];
  const l = Math.hypot(dx, dy, 1);
  const s = eye === 'left' ? -1 : 1;
  return {
    origin: [
      headPos[0] + s * (ipd / 2) * headRight[0],
      headPos[1] + s * (ipd / 2) * headRight[1],
      headPos[2] + s * (ipd / 2) * headRight[2],
    ],
    dir: [dir[0] / l, dir[1] / l, dir[2] / l],
  };
}

function mat3Vec(M: Mat3, v: Vec3): Vec3 {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}

function mat3Inv(M: Mat3): Mat3 {
  const [a, b, c] = M[0];
  const [d, e, f] = M[1];
  const [g, h, i] = M[2];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const s = 1 / (a * A + b * B + c * C);
  return [
    [A * s, (c * h - b * i) * s, (b * f - c * e) * s],
    [B * s, (a * i - c * g) * s, (c * d - a * f) * s],
    [C * s, (b * g - a * h) * s, (a * e - b * d) * s],
  ];
}

/**
 * Reproject pixel x (homogeneous) from pose (K, R, o) to (K', R', o')
 * using the marched depth t. Returns homogeneous x'.
 */
export function reprojectPoint(
  x: Vec3, K: Mat3, R: Mat3, o: Vec3,
  Kp: Mat3, Rp: Mat3, op: Vec3, t: number,
): Vec3 {
  const back = mat3Vec(mat3Inv(K), x);
  const d = mat3Vec(R, back);
  const dl = Math.hypot(d[0], d[1], d[2]) || 1;
  const p: Vec3 = [o[0] + (t * d[0]) / dl, o[1] + (t * d[1]) / dl, o[2] + (t * d[2]) / dl];
  const rel: Vec3 = [p[0] - op[0], p[1] - op[1], p[2] - op[2]];
  return mat3Vec(Kp, mat3Vec(mat3Inv(Rp), rel));
}

// ---------------------------------------------------------------------------
// Error-state attitude filter, WORLD-frame (left) error.
// R_true = Exp(dtheta) R_hat; bias error db = b_true - b_hat (bias in the
// body frame). State: qhat (unit quaternion), bhat (gyro bias), P (6x6 error
// covariance for [dtheta, db]). Predict:
//   qhat <- qhat tensor Exp((omega_m - bhat) dt)
//   P <- F P F^T + Q,  F = [[I, -dt R_hat], [0, I]]
// Update with a body-frame vector measurement z of the known world
// reference g_w, predicted h = R_hat^T g_w:
//   K = P H^T (H P H^T + R_m)^{-1},  H = [R_hat^T [g_w]_x, 0],
//   dx = K (z - h); qhat <- Exp(dx_theta) tensor qhat; bhat <- bhat + dx_b.
// No reset Jacobian and no reset step: the world-frame error needs none.
// ---------------------------------------------------------------------------

/** Exponential map: rotation vector -> unit quaternion [x, y, z, w]. */
export function quatExp(wdt: Vec3): Quat {
  const th = Math.hypot(wdt[0], wdt[1], wdt[2]);
  if (th < 1e-12) return [0, 0, 0, 1];
  const s = Math.sin(th / 2) / th;
  return [wdt[0] * s, wdt[1] * s, wdt[2] * s, Math.cos(th / 2)];
}

/** Rotation matrix (3x3, body to world) for quaternion q = [x, y, z, w]. */
export function quatToMat3(q: Quat): Mat3 {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

function skew3(v: Vec3): number[][] {
  return [
    [0, -v[2], v[1]],
    [v[2], 0, -v[0]],
    [-v[1], v[0], 0],
  ];
}

/**
 * World-frame error transition: F = [[I, -dt R_hat], [0, I]] (6x6).
 * The attitude error lives in the world frame, so the bias block couples
 * through -dt R_hat, not -dt I.
 */
export function esfPredictF(q: Quat, dt: number): number[][] {
  const R = quatToMat3(q);
  const F: number[][] = Array.from({ length: 6 }, (_, i) =>
    Array.from({ length: 6 }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) F[i][j + 3] = -dt * R[i][j];
  }
  return F;
}

/**
 * World-frame measurement Jacobian: H = [R_hat^T [g_w]_x, 0] (3x6).
 * The yaw column (world z) is exactly zero: gravity cannot observe world
 * yaw, independent of the estimate.
 */
export function esfUpdateH(q: Quat, g_w: Vec3): number[][] {
  const R = quatToMat3(q);
  const sk = skew3(g_w);
  const H: number[][] = Array.from({ length: 3 }, () => new Array(6).fill(0));
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      H[i][j] = R[0][i] * sk[0][j] + R[1][i] * sk[1][j] + R[2][i] * sk[2][j];
    }
  }
  return H;
}

/**
 * Apply the error-state correction (world-frame / left error):
 * qhat <- Exp(dtheta) tensor qhat, bhat <- bhat + db. No reset step.
 */
export function esfApplyCorrection(s: EsfState, dtheta: Vec3, db: Vec3): void {
  s.q = multiply(quatExp(dtheta), s.q);
  const n = Math.hypot(s.q[0], s.q[1], s.q[2], s.q[3]) || 1;
  s.q = [s.q[0] / n, s.q[1] / n, s.q[2] / n, s.q[3] / n];
  s.b = [s.b[0] + db[0], s.b[1] + db[1], s.b[2] + db[2]];
}

export interface EsfState {
  q: Quat;
  b: Vec3;
  P: number[][];
}

export function esfInit(): EsfState {
  const P = Array.from({ length: 6 }, (_, i) =>
    Array.from({ length: 6 }, (_, j) => (i === j ? 1e-4 : 0)),
  );
  return { q: [0, 0, 0, 1], b: [0, 0, 0], P };
}

function matMul6(A: number[][], B: number[][]): number[][] {
  const C = Array.from({ length: 6 }, () => new Array(6).fill(0));
  for (let i = 0; i < 6; i++) {
    for (let k = 0; k < 6; k++) {
      const aik = A[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < 6; j++) C[i][j] += aik * B[k][j];
    }
  }
  return C;
}

function matT6(A: number[][]): number[][] {
  return Array.from({ length: 6 }, (_, i) =>
    Array.from({ length: 6 }, (_, j) => A[j][i]),
  );
}

/** Predict with gyro measurement omega_m over dt. */
export function esfPredict(s: EsfState, omega_m: Vec3, dt: number, qVar: number, bVar: number): void {
  const w: Vec3 = [omega_m[0] - s.b[0], omega_m[1] - s.b[1], omega_m[2] - s.b[2]];
  // Nominal propagation (frame-independent): qhat <- qhat tensor Exp(w_hat dt).
  s.q = multiply(s.q, quatExp([w[0] * dt, w[1] * dt, w[2] * dt]));
  const n = Math.hypot(s.q[0], s.q[1], s.q[2], s.q[3]) || 1;
  s.q = [s.q[0] / n, s.q[1] / n, s.q[2] / n, s.q[3] / n];
  // World-frame F = [[I, -dt R_hat], [0, I]]; P <- F P F^T + Q.
  const F = esfPredictF(s.q, dt);
  const FP = matMul6(F, s.P);
  const FPFt = matMul6(FP, matT6(F));
  for (let i = 0; i < 6; i++) {
    FPFt[i][i] += (i < 3 ? qVar : bVar) * dt;
  }
  s.P = FPFt;
}

/** Rotate a vector by quaternion q (body to world). */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  // v' = q v q*.
  const qv: Quat = [v[0], v[1], v[2], 0];
  const qc: Quat = [-q[0], -q[1], -q[2], q[3]];
  const t = multiply(q, qv);
  const r = multiply(t, qc);
  return [r[0], r[1], r[2]];
}

/**
 * Update with a body-frame vector measurement z of the known world
 * reference g_w (unit). R_m = measurement variance (isotropic).
 * K = P H^T (H P H^T + R_m)^{-1}.
 */
export function esfUpdate(s: EsfState, z: Vec3, g_w: Vec3, rVar: number): void {
  // Predicted measurement h = R(qhat)^T g_w.
  const qc: Quat = [-s.q[0], -s.q[1], -s.q[2], s.q[3]];
  const h = quatRotate(qc, g_w);
  // World-frame H = [R_hat^T [g_w]_x, 0] (3x6).
  const H = esfUpdateH(s.q, g_w);
  // S = H P H^T + R_m I (3x3).
  const HP: number[][] = Array.from({ length: 3 }, () => new Array(6).fill(0));
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 6; j++) {
      for (let k = 0; k < 6; k++) HP[i][j] += H[i][k] * s.P[k][j];
    }
  }
  const S: number[][] = Array.from({ length: 3 }, () => new Array(3).fill(0));
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 6; k++) S[i][j] += HP[i][k] * H[j][k];
      if (i === j) S[i][j] += rVar;
    }
  }
  const Si = mat3InvF(S);
  // K = P H^T S^{-1} (6x3).
  const PHt: number[][] = Array.from({ length: 6 }, () => new Array(3).fill(0));
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 6; k++) PHt[i][j] += s.P[i][k] * H[j][k];
    }
  }
  const K: number[][] = Array.from({ length: 6 }, () => new Array(3).fill(0));
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) K[i][j] += PHt[i][k] * Si[k][j];
    }
  }
  const res: Vec3 = [z[0] - h[0], z[1] - h[1], z[2] - h[2]];
  const dx = new Array(6).fill(0);
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 3; j++) dx[i] += K[i][j] * res[j];
  }
  // Apply (world-frame / left error): qhat <- Exp(dx_theta) tensor qhat,
  // bhat <- bhat + dx_b. No reset step.
  esfApplyCorrection(s, [dx[0], dx[1], dx[2]], [dx[3], dx[4], dx[5]]);
  // P <- (I - K H) P.
  const KH: number[][] = Array.from({ length: 6 }, () => new Array(6).fill(0));
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      for (let k = 0; k < 3; k++) KH[i][j] += K[i][k] * H[k][j];
    }
  }
  const IKH: number[][] = Array.from({ length: 6 }, (_, i) =>
    Array.from({ length: 6 }, (_, j) => (i === j ? 1 : 0) - KH[i][j]),
  );
  s.P = matMul6(IKH, s.P);
}

/** Inverse of a 3x3 given as nested arrays. */
function mat3InvF(M: number[][]): number[][] {
  const [a, b, c] = M[0];
  const [d, e, f] = M[1];
  const [g, h, i] = M[2];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const s = 1 / (a * A + b * B + c * C);
  return [
    [A * s, (c * h - b * i) * s, (b * f - c * e) * s],
    [B * s, (a * i - c * g) * s, (c * d - a * f) * s],
    [C * s, (b * g - a * h) * s, (a * e - b * d) * s],
  ];
}
