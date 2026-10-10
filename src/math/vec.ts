// math/vec.ts — vector ops. Tuples, no allocation inside hot paths where avoidable.
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];

export function add3(a: Vec3, b: Vec3, out: Vec3 = v3()): Vec3 {
  out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
  return out;
}
export function sub3(a: Vec3, b: Vec3, out: Vec3 = v3()): Vec3 {
  out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
  return out;
}
export function scale3(a: Vec3, s: number, out: Vec3 = v3()): Vec3 {
  out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
  return out;
}
export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross3(a: Vec3, b: Vec3, out: Vec3 = v3()): Vec3 {
  out[0] = a[1] * b[2] - a[2] * b[1];
  out[1] = a[2] * b[0] - a[0] * b[2];
  out[2] = a[0] * b[1] - a[1] * b[0];
  return out;
}
export function len3(a: Vec3): number {
  return Math.sqrt(dot3(a, a));
}
export function norm3(a: Vec3, out: Vec3 = v3()): Vec3 {
  const l = len3(a) || 1;
  return scale3(a, 1 / l, out);
}
export function lerp3(a: Vec3, b: Vec3, t: number, out: Vec3 = v3()): Vec3 {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}
