// inverse/geograd.ts - geometry gradients for inverse rendering.
//
// At a ray hit f(o + t* d; theta) = 0, the implicit function theorem gives
//   dt*/dtheta = -(d_theta f) / (grad f . d).
// The shading depends on the normal too, so with H the Hessian of f,
//   dn/dtheta = (I - n n^T)(H d dt*/dtheta + d_theta grad f) / ||grad f||.
// The full shading chain is then
//   dc/dtheta = (dc/dp)(dp*/dtheta) + (dc/dn)(dn/dtheta) + dc/dtheta_shade,
// with dp*/dtheta = d dt*/dtheta.
//
// Pixels crossing a silhouette need the boundary term (Reynolds transport):
//   d/dtheta ∫_pixel c dA = ∫ dc/dtheta dA + ∮_sil (c_in - c_out)(v_theta . n_b) dl.
//
// UNVALIDATED (from memory): the 3D silhouette normal-speed derivation.
// The 2D disk coverage identities ARE validated (coverage derivative =
// in-pixel arc length; translation derivative = contour v.n integral).
// The 3D normal speed v_theta . n_b is derived from f = 0, grad f . d = 0
// and MUST be validated numerically before use; it is flagged here and
// in docs/methods-provenance.md.
//
// All techniques are classical public mathematics; see
// docs/methods-provenance.md.

import type { Vec3 } from '../math/vec.js';

/** Field and its derivatives, supplied by the caller. */
export interface FieldDerivs {
  f: (p: Vec3, theta: number[]) => number;
  grad: (p: Vec3, theta: number[]) => Vec3;
  /** 3x3 Hessian of f at (p, theta). */
  hess: (p: Vec3, theta: number[]) => number[][];
  /** df/dtheta_k at (p, theta). */
  dThetaF: (p: Vec3, theta: number[], k: number) => number;
  /** d/dtheta_k grad f at (p, theta). */
  dThetaGrad: (p: Vec3, theta: number[], k: number) => Vec3;
}

/** Hit-point derivative d(t*)/dtheta_k by the implicit function theorem. */
export function hitPointGradient(
  field: FieldDerivs, o: Vec3, d: Vec3, theta: number[], tStar: number, k: number,
): number {
  const p: Vec3 = [o[0] + tStar * d[0], o[1] + tStar * d[1], o[2] + tStar * d[2]];
  const g = field.grad(p, theta);
  const denom = g[0] * d[0] + g[1] * d[1] + g[2] * d[2];
  if (Math.abs(denom) < 1e-12) return NaN; // grazing hit: undefined
  return -field.dThetaF(p, theta, k) / denom;
}

/** Normal derivative dn/dtheta_k. */
export function normalGradient(
  field: FieldDerivs, o: Vec3, d: Vec3, theta: number[], tStar: number, k: number,
): Vec3 {
  const p: Vec3 = [o[0] + tStar * d[0], o[1] + tStar * d[1], o[2] + tStar * d[2]];
  const g = field.grad(p, theta);
  const gl = Math.hypot(g[0], g[1], g[2]) || 1;
  const n: Vec3 = [g[0] / gl, g[1] / gl, g[2] / gl];
  const dt = hitPointGradient(field, o, d, theta, tStar, k);
  const H = field.hess(p, theta);
  const dtg = field.dThetaGrad(p, theta, k);
  // H d dt + d_theta grad f
  const Hd: Vec3 = [
    H[0][0] * d[0] + H[0][1] * d[1] + H[0][2] * d[2],
    H[1][0] * d[0] + H[1][1] * d[1] + H[1][2] * d[2],
    H[2][0] * d[0] + H[2][1] * d[1] + H[2][2] * d[2],
  ];
  const w: Vec3 = [
    Hd[0] * dt + dtg[0],
    Hd[1] * dt + dtg[1],
    Hd[2] * dt + dtg[2],
  ];
  // (I - n n^T) w / ||grad f||
  const nw = n[0] * w[0] + n[1] * w[1] + n[2] * w[2];
  return [
    (w[0] - n[0] * nw) / gl,
    (w[1] - n[1] * nw) / gl,
    (w[2] - n[2] * nw) / gl,
  ];
}

export interface SilhouetteDiskTerms {
  /** Arc length of the circle inside the unit pixel. */
  arcLength: number;
  /** Contour integral of (v.n) dl with v = (1,0) over the inside arc. */
  contourVn: number;
}

/**
 * Validated 2D silhouette terms for a disk in the unit pixel [0,1]^2.
 * d/dr Area(disk ∩ pixel) = arcLength; d/dcx Area = contourVn.
 */
export function silhouetteDiskTerms(cx: number, cy: number, r: number): SilhouetteDiskTerms {
  const M = 200000;
  let arc = 0, vn = 0;
  const dl = (r * 2 * Math.PI) / M;
  for (let i = 0; i < M; i++) {
    const phi = ((i + 0.5) * 2 * Math.PI) / M;
    const px = cx + r * Math.cos(phi), py = cy + r * Math.sin(phi);
    if (px >= 0 && px <= 1 && py >= 0 && py <= 1) {
      arc += dl;
      vn += Math.cos(phi) * dl; // (v.n) with v=(1,0), n=(cos phi, sin phi)
    }
  }
  return { arcLength: arc, contourVn: vn };
}

/**
 * 3D silhouette normal speed (UNVALIDATED, from memory).
 *
 * Derived from the system f = 0, grad f . d = 0 at the silhouette.
 * DO NOT USE in production solves until validated numerically against
 * finite differences of actual silhouette motion. Flagged per the
 * validation ledger.
 */
export function silhouetteNormalSpeed3D(
  field: FieldDerivs, p: Vec3, d: Vec3, theta: number[], k: number,
): number {
  void field; void p; void d; void theta; void k;
  throw new Error(
    'silhouetteNormalSpeed3D is UNVALIDATED (from memory). ' +
    'Validate numerically before use; see docs/methods-provenance.md §5.',
  );
}
