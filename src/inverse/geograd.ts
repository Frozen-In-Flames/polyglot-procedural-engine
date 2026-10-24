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
// The 2D disk coverage identities ARE validated (coverage derivative =
// in-pixel arc length; translation derivative = contour v.n integral).
// The 3D silhouette normal speed v_theta . n_b is implemented by finite
// differences of Newton-tracked silhouette motion and validated against
// translating/expanding sphere ground truths (speed exactly 1).
// (An older from-memory analytic derivation was never validated and is
// not shipped.)
//
// All techniques are classical public mathematics; see
// docs/methods-provenance.md.

import { cross3, type Vec3 } from '../math/vec.js';

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
 * 3D silhouette normal speed by finite differences of tracked silhouette
 * motion (v1.9.0).
 *
 * The silhouette for view direction d is the contour where f = 0 and
 * grad f . d = 0. The normal speed v_theta . n_b is the speed at which
 * that contour moves (in the image plane, along the contour normal n_b)
 * as theta_k varies. This implementation measures it directly: it
 * Newton-tracks one silhouette point across theta_k +- h and central-
 * differences the normal displacement.
 *
 * Tracking: Newton on the 3-equation system
 *   F(p) = [ f(p), (grad f(p)) . d, (p - p0) . t_c ],
 * where t_c is the contour tangent at the seed point and the third row
 * pins the tracked point so it cannot drift along the contour. The
 * contour normal is n_b = d x t_c, oriented outward (n_b . grad f > 0).
 *
 * Validated against translating and expanding sphere ground truths
 * (speed exactly 1); see test/geograd.test.ts. Returns NaN, documented
 * here, when the seed is not near a silhouette or the Newton re-solve
 * fails to converge: a non-answer, not a throw.
 */
export interface SilhouetteTrackOpts {
  /** Newton iterations for the silhouette re-solve (default 60). */
  newtonIters?: number;
  /** Newton convergence tolerance on |F|_inf (default 1e-10). */
  newtonTol?: number;
  /** Central-difference step over theta_k (default 1e-5). */
  h?: number;
}

/** Solve a 3x3 linear system by Gaussian elimination with pivoting. */
function solve3(A: number[][], b: number[]): Vec3 | null {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) {
      if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    }
    if (Math.abs(M[piv][c]) < 1e-300) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

/**
 * Newton-track the silhouette point near seed for parameters theta.
 * Returns the refined point, or null when the solve fails.
 */
function trackSilhouette(
  field: FieldDerivs,
  seed: Vec3,
  d: Vec3,
  theta: number[],
  tc: Vec3,
  p0: Vec3,
  newtonIters: number,
  newtonTol: number,
): Vec3 | null {
  const p: Vec3 = [seed[0], seed[1], seed[2]];
  for (let it = 0; it < newtonIters; it++) {
    const g = field.grad(p, theta);
    const F = [
      field.f(p, theta),
      g[0] * d[0] + g[1] * d[1] + g[2] * d[2],
      (p[0] - p0[0]) * tc[0] + (p[1] - p0[1]) * tc[1] + (p[2] - p0[2]) * tc[2],
    ];
    if (Math.max(Math.abs(F[0]), Math.abs(F[1]), Math.abs(F[2])) < newtonTol) return p;
    const H = field.hess(p, theta);
    const Hd: Vec3 = [
      H[0][0] * d[0] + H[0][1] * d[1] + H[0][2] * d[2],
      H[1][0] * d[0] + H[1][1] * d[1] + H[1][2] * d[2],
      H[2][0] * d[0] + H[2][1] * d[1] + H[2][2] * d[2],
    ];
    const step = solve3([g, Hd, tc], [-F[0], -F[1], -F[2]]);
    if (!step) return null;
    p[0] += step[0]; p[1] += step[1]; p[2] += step[2];
  }
  return null;
}

export function silhouetteNormalSpeed3D(
  field: FieldDerivs,
  p: Vec3,
  d: Vec3,
  theta: number[],
  k: number,
  opts: SilhouetteTrackOpts = {},
): number {
  const newtonIters = opts.newtonIters ?? 60;
  const newtonTol = opts.newtonTol ?? 1e-10;
  const h = opts.h ?? 1e-5;
  const dl = Math.hypot(d[0], d[1], d[2]) || 1;
  const dn: Vec3 = [d[0] / dl, d[1] / dl, d[2] / dl];
  // Contour tangent at the seed; degenerate unless the seed is near a
  // silhouette (grad f perpendicular to d).
  const g0 = field.grad(p, theta);
  const tcRaw = cross3(g0, dn);
  const tl = Math.hypot(tcRaw[0], tcRaw[1], tcRaw[2]);
  if (tl < 1e-8) return NaN;
  const tc: Vec3 = [tcRaw[0] / tl, tcRaw[1] / tl, tcRaw[2] / tl];
  // Refine the seed at the base parameters.
  const pBase = trackSilhouette(field, p, dn, theta, tc, p, newtonIters, newtonTol);
  if (!pBase) return NaN;
  // Outward contour normal in the image plane.
  const nbRaw = cross3(dn, tc);
  const nl = Math.hypot(nbRaw[0], nbRaw[1], nbRaw[2]) || 1;
  let nb: Vec3 = [nbRaw[0] / nl, nbRaw[1] / nl, nbRaw[2] / nl];
  const gb = field.grad(pBase, theta);
  if (nb[0] * gb[0] + nb[1] * gb[1] + nb[2] * gb[2] < 0) {
    nb = [-nb[0], -nb[1], -nb[2]];
  }
  // Track across theta_k +- h, seeded at the refined base point.
  const tp = theta.slice(); tp[k] += h;
  const tm = theta.slice(); tm[k] -= h;
  const pPlus = trackSilhouette(field, pBase, dn, tp, tc, pBase, newtonIters, newtonTol);
  const pMinus = trackSilhouette(field, pBase, dn, tm, tc, pBase, newtonIters, newtonTol);
  if (!pPlus || !pMinus) return NaN;
  const dx = (pPlus[0] - pMinus[0]) / (2 * h);
  const dy = (pPlus[1] - pMinus[1]) / (2 * h);
  const dz = (pPlus[2] - pMinus[2]) / (2 * h);
  return nb[0] * dx + nb[1] * dy + nb[2] * dz;
}
