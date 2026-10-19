// inverse/specmodel.ts - third arm of the robust head-to-head: model the
// outlier instead of muting it.
//
// The JIT toy forward model is extended with a specular lobe built from the
// engine's validated GGX pieces (ggxD, smithVisibility: the finite-at-grazing
// visibility form, no clamps). theta = (az, el, I, A, ks, alpha):
//   y = rho*(A + I*max(n.l,0)) + ks * D(ndh,alpha) * V(nl,nv,alpha) * max(nl,0).
// F0 is absorbed into ks (documented approximation). The generator in the
// head-to-head oracle is a Blinn-Phong lobe, so this is approximate modeling
// of the outlier, not a matched fit: the experiment is whether explaining
// beats muting.
//
// Jacobian: analytic Lambertian columns (the first four, shared with the
// 4-param model) plus central finite differences for (ks, alpha), the engine
// FD convention.
import { ggxD, smithVisibility } from './forward.js';
import { lightDir, jacLambertN } from './jit.js';

/**
 * Six-parameter forward model: Lambertian plus a GGX specular lobe.
 * View direction is fixed at +z (the JIT toy camera).
 */
export function renderLambertGgx6(
  theta: number[],
  normals: number[][],
  rho: number,
): number[] {
  const az = theta[0];
  const el = theta[1];
  const I = theta[2];
  const A = theta[3];
  const ks = theta[4];
  const alpha = Math.max(theta[5], 1e-3);
  const l = lightDir(az, el);
  let hx = l[0];
  let hy = l[1];
  let hz = l[2] + 1;
  const hl = Math.hypot(hx, hy, hz) || 1;
  hx /= hl;
  hy /= hl;
  hz /= hl;
  return normals.map((n) => {
    const nl = n[0] * l[0] + n[1] * l[1] + n[2] * l[2];
    const lam = rho * (A + I * Math.max(nl, 0));
    if (ks === 0 || nl <= 0) return lam;
    const ndh = Math.max(n[0] * hx + n[1] * hy + n[2] * hz, 0);
    const nv = n[2];
    const spec = ks * ggxD(ndh, alpha) * smithVisibility(nl, nv, alpha) * nl;
    return lam + spec;
  });
}

/**
 * Jacobian of the 6-param model. Columns 2-3 (I, A) are analytic: the
 * specular lobe does not depend on I or A (ks absorbs them). Columns 0-1
 * (az, el) move the lobe, so they join ks and alpha in central differences
 * (engine FD convention, 1e-5 relative step).
 */
export function jacSpec6N(
  theta: number[],
  normals: number[][],
  rho: number,
  eps = 1e-5,
): number[][] {
  const J4 = jacLambertN(theta, normals, rho);
  const m = normals.length;
  const J: number[][] = Array.from({ length: m }, (_, i) => [
    0,
    0,
    J4[i][2],
    J4[i][3],
    0,
    0,
  ]);
  for (const k of [0, 1, 4, 5]) {
    const h = eps * Math.max(1, Math.abs(theta[k]));
    const tp = theta.slice();
    tp[k] = theta[k] + h;
    const tm = theta.slice();
    tm[k] = theta[k] - h;
    const rp = renderLambertGgx6(tp, normals, rho);
    const rm = renderLambertGgx6(tm, normals, rho);
    for (let i = 0; i < m; i++) J[i][k] = (rp[i] - rm[i]) / (2 * h);
  }
  return J;
}
