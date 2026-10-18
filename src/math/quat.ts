// math/quat.ts - quaternions as [x, y, z, w].
import type { Vec3 } from './vec.js';
import type { Mat4 } from './mat.js';

export type Quat = [number, number, number, number];

export const qIdentity = (): Quat => [0, 0, 0, 1];

export function fromAxisAngle(axis: Vec3, angle: number, out: Quat = qIdentity()): Quat {
  const h = angle / 2;
  const s = Math.sin(h);
  out[0] = axis[0] * s; out[1] = axis[1] * s; out[2] = axis[2] * s; out[3] = Math.cos(h);
  return out;
}

export function multiply(a: Quat, b: Quat, out: Quat = qIdentity()): Quat {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

export function toMat4(q: Quat, out: Mat4 = new Float32Array(16)): Mat4 {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy + wz; out[2] = xz - wy; out[3] = 0;
  out[4] = xy - wz; out[5] = 1 - (xx + zz); out[6] = yz + wx; out[7] = 0;
  out[8] = xz + wy; out[9] = yz - wx; out[10] = 1 - (xx + yy); out[11] = 0;
  out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
  return out;
}

export function slerp(a: Quat, b: Quat, t: number, out: Quat = qIdentity()): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  const s0 = 1 - t, s1 = t;
  if (dot < 0.9995) {
    const omega = Math.acos(dot);
    const so = Math.sin(omega);
    const f0 = Math.sin(s0 * omega) / so, f1 = Math.sin(s1 * omega) / so;
    out[0] = a[0] * f0 + bx * f1; out[1] = a[1] * f0 + by * f1;
    out[2] = a[2] * f0 + bz * f1; out[3] = a[3] * f0 + bw * f1;
  } else {
    out[0] = a[0] * s0 + bx * s1; out[1] = a[1] * s0 + by * s1;
    out[2] = a[2] * s0 + bz * s1; out[3] = a[3] * s0 + bw * s1;
  }
  return out;
}
