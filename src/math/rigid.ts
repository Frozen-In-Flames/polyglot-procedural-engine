// math/rigid.ts - rotations and rigid-body integration (extends quat.ts).
//
// Rodrigues exponential map: R = I + (sin theta/theta)[w]_x
//   + ((1-cos theta)/theta^2)[w]_x^2, theta = ||w||.
// Orientation integration (world-frame w):
//   q_{n+1} = normalize(q_n + (h/2)(0,w) tensor q_n).
// Euler equations (body frame): I w_dot + w x (I w) = tau.
// Symplectic Euler: v_{n+1} = v_n + h a(x_n), x_{n+1} = x_n + h v_{n+1}.

import { multiply, type Quat } from './quat.js';
import type { Vec3 } from './vec.js';

export type Mat3x3 = [[number, number, number], [number, number, number], [number, number, number]];

/** Skew-symmetric cross-product matrix [w]_x. */
function skew(w: Vec3): Mat3x3 {
  return [
    [0, -w[2], w[1]],
    [w[2], 0, -w[0]],
    [-w[1], w[0], 0],
  ];
}

/** Rodrigues exponential map: rotation matrix for axis-angle vector w. */
export function rodrigues(w: Vec3): Mat3x3 {
  const theta = Math.hypot(w[0], w[1], w[2]);
  if (theta < 1e-12) {
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  }
  const K = skew(w);
  const s = Math.sin(theta) / theta;
  const c = (1 - Math.cos(theta)) / (theta * theta);
  // K^2 = K*K; R = I + s*K + c*K^2.
  const K2: Mat3x3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) K2[i][j] += K[i][k] * K[k][j];
    }
  }
  const R: Mat3x3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      R[i][j] = (i === j ? 1 : 0) + s * K[i][j] + c * K2[i][j];
    }
  }
  return R;
}

/** One orientation-integration step; result is renormalized. */
export function integrateQuaternion(q: Quat, w: Vec3, h: number): Quat {
  // (0, w) tensor q.
  const wq: Quat = [w[0], w[1], w[2], 0];
  const prod = multiply(wq, q);
  const next: Quat = [
    q[0] + (h / 2) * prod[0],
    q[1] + (h / 2) * prod[1],
    q[2] + (h / 2) * prod[2],
    q[3] + (h / 2) * prod[3],
  ];
  const n = Math.hypot(next[0], next[1], next[2], next[3]) || 1;
  return [next[0] / n, next[1] / n, next[2] / n, next[3] / n];
}

/**
 * Euler-equation step (body frame, explicit): I w_dot = tau - w x (I w).
 * I = principal inertias [Ix, Iy, Iz].
 */
export function eulerStep(I: Vec3, w: Vec3, tau: Vec3, h: number): Vec3 {
  const Iw: Vec3 = [I[0] * w[0], I[1] * w[1], I[2] * w[2]];
  // w x (I w).
  const cross: Vec3 = [
    w[1] * Iw[2] - w[2] * Iw[1],
    w[2] * Iw[0] - w[0] * Iw[2],
    w[0] * Iw[1] - w[1] * Iw[0],
  ];
  return [
    w[0] + (h * (tau[0] - cross[0])) / I[0],
    w[1] + (h * (tau[1] - cross[1])) / I[1],
    w[2] + (h * (tau[2] - cross[2])) / I[2],
  ];
}

/** Symplectic Euler for a simple pendulum: returns [theta, omega]. */
export function symplecticPendulum(
  theta: number, omega: number, g: number, L: number, h: number,
): [number, number] {
  const om1 = omega + h * (-(g / L) * Math.sin(theta));
  const th1 = theta + h * om1;
  return [th1, om1];
}
