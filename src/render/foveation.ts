// render/foveation.ts - math-side XR cost control.
//
// Performance stays inside the mathematics: no rasterization fallback,
// ever. The raymarcher spends its step budget where the eye resolves
// detail (the fovea) and fewer steps in the periphery, following the
// minimum-angle-of-resolution curve MAR(e) = omega_0 (1 + e/e_2) with
// e_2 ~= 2.3 degrees. The two companion transforms are the math the XR
// path needs for late reprojection and lens undistortion.

import type { Vec3 } from '../math/vec.js';

/** Eccentricity constant e_2 ~= 2.3 degrees (MAR curve knee). */
export const FOVEA_E2_DEG = 2.3;

/**
 * Radial step budget: N_steps(e) = N_0 / (1 + e/e_2), e in degrees from
 * the gaze center. Full budget in the fovea, falling off peripherally.
 */
export function foveatedSteps(eDeg: number, n0: number, e2 = FOVEA_E2_DEG): number {
  return Math.max(1, Math.floor(n0 / (1 + Math.max(0, eDeg) / e2)));
}

/**
 * Eccentricity of a pixel in degrees: angle between the view direction
 * and the ray through (fragX, fragY), from the tangent of half the
 * vertical field of view.
 */
export function eccentricityDeg(
  fragX: number, fragY: number,
  resX: number, resY: number,
  tanFov: number,
): number {
  const cx = (fragX - 0.5 * resX) / resY;
  const cy = (fragY - 0.5 * resY) / resY;
  return Math.atan(Math.hypot(cx, cy) * tanFov) * (180 / Math.PI);
}

/** 3x3 matrix as rows. */
export type Mat3 = [Vec3, Vec3, Vec3];

function mat3VecMul(M: Mat3, v: Vec3): Vec3 {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}

function mat3Inverse(M: Mat3): Mat3 {
  const [a, b, c] = [M[0][0], M[0][1], M[0][2]];
  const [d, e, f] = [M[1][0], M[1][1], M[1][2]];
  const [g, h, i] = [M[2][0], M[2][1], M[2][2]];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const s = 1 / det;
  return [
    [A * s, (c * h - b * i) * s, (b * f - c * e) * s],
    [B * s, (a * i - c * g) * s, (c * d - a * f) * s],
    [C * s, (b * g - a * h) * s, (a * e - b * d) * s],
  ];
}

/**
 * Rotation-only late reprojection: x' ~ K R_delta K^{-1} x. A pixel x
 * rendered under rotation R is reprojected under R R_delta without
 * re-marching, valid when the head motion between frames is mostly
 * rotation (translation needs depth; see the position+rotation form in
 * the XR camera docs).
 */
export function reprojectRotationOnly(x: Vec3, K: Mat3, Rdelta: Mat3): Vec3 {
  return mat3VecMul(K, mat3VecMul(Rdelta, mat3VecMul(mat3Inverse(K), x)));
}

/**
 * Radial lens distortion: r' = r (1 + k_1 r^2 + k_2 r^4). The forward
 * model for undistorting XR lens views; the inverse is solved
 * iteratively at the call site.
 */
export function radialDistort(r: number, k1: number, k2: number): number {
  const r2 = r * r;
  return r * (1 + k1 * r2 + k2 * r2 * r2);
}
