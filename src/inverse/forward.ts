// inverse/forward.ts - the V10.2 faithful forward model.
//
// The solver inverts a FORWARD model: rendered samples R(theta) from scene
// parameters theta. This module holds that model and the transfer
// contract around it.
//
// LINEAR-LIGHT CONTRACT: the solver works in linear light. Targets are
// assumed to have gone through the sRGB transfer on the way in, so they
// must be linearized with srgbToLinear before fitting; the resolve step
// below tone-maps with linearToSrgb (the T in yhat = T(sum w R)) so both
// sides of the loss live in the same space. Fitting a gamma-encoded
// target without linearizing gives a different (documented) residual:
// the loss then compares linear renders against curved targets.

import type { Vec3 } from '../math/vec.js';

// ---------------------------------------------------------------------------
// sRGB transfer (piecewise, exact constants).
// ---------------------------------------------------------------------------

/** Linear -> sRGB encode: 12.92*C for C <= 0.0031308, else 1.055*C^(1/2.4) - 0.055. */
export function linearToSrgb(c: number): number {
  const cl = Math.min(1, Math.max(0, c));
  return cl <= 0.0031308 ? 12.92 * cl : 1.055 * Math.pow(cl, 1 / 2.4) - 0.055;
}

/** sRGB -> linear decode (the linearize helper): C/12.92 or ((C+0.055)/1.055)^2.4. */
export function srgbToLinear(c: number): number {
  const cl = Math.min(1, Math.max(0, c));
  return cl <= 0.04045 ? cl / 12.92 : Math.pow((cl + 0.055) / 1.055, 2.4);
}

// ---------------------------------------------------------------------------
// Lanczos resampling for the resolve step.
//
// yhat_j(theta) = T(sum_k w_jk R_k(theta)): rendered linear samples R_k
// are resampled onto the target pixel grid with separable Lanczos weights
// L(x) = sinc(x) sinc(x/a) for |x| < a (support a = 2 or 3), normalized
// to sum to 1, then tone-mapped with T = linearToSrgb.
// ---------------------------------------------------------------------------

/** Lanczos kernel L(x) = sinc(x)*sinc(x/a) for |x| < a, else 0. */
export function lanczos(x: number, a: number): number {
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= a) return 0;
  const pix = Math.PI * x;
  const pixA = (Math.PI * x) / a;
  return (Math.sin(pix) / pix) * (Math.sin(pixA) / pixA);
}

/** 1D Lanczos taps for output position pos (in input-pixel units). */
export function lanczosTaps1D(pos: number, a: number): Array<{ i: number; w: number }> {
  const taps: Array<{ i: number; w: number }> = [];
  const i0 = Math.ceil(pos - a);
  const i1 = Math.floor(pos + a);
  let sum = 0;
  for (let i = i0; i <= i1; i++) {
    const w = lanczos(pos - i, a);
    taps.push({ i, w });
    sum += w;
  }
  // Normalize: weights must sum to 1 (partition of unity).
  for (const t of taps) t.w /= sum;
  return taps;
}

/**
 * Resolve a linear render onto an outW x outH target grid: separable
 * Lanczos resampling, then the sRGB tone map T. Both the render and the
 * taps live in linear light; only the final yhat is encoded.
 */
export function resolveImage(
  render: number[][],
  outW: number,
  outH: number,
  a = 2,
  toneMap: (c: number) => number = linearToSrgb,
): number[][] {
  const inH = render.length;
  const inW = render[0].length;
  const out: number[][] = [];
  for (let oy = 0; oy < outH; oy++) {
    const row: number[] = [];
    const py = ((oy + 0.5) / outH) * inH - 0.5;
    const ty = lanczosTaps1D(py, a);
    for (let ox = 0; ox < outW; ox++) {
      const px = ((ox + 0.5) / outW) * inW - 0.5;
      const tx = lanczosTaps1D(px, a);
      let acc = 0;
      for (const wy of ty) {
        const sy = Math.min(inH - 1, Math.max(0, wy.i));
        for (const wx of tx) {
          const sx = Math.min(inW - 1, Math.max(0, wx.i));
          acc += wx.w * wy.w * render[sy][sx];
        }
      }
      row.push(toneMap(acc));
    }
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shading models for the forward path.
// ---------------------------------------------------------------------------

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Lambert baseline: rho * E * max(0, n.l). The V10 solver forward model. */
export function lambert(rho: number, n: Vec3, l: Vec3, E: number): number {
  return rho * E * Math.max(0, dot3(n, l));
}

export interface GgxParams {
  /** Diffuse albedo. */
  rho: number;
  /** Fresnel reflectance at normal incidence. */
  F0: number;
  /** Roughness parameter alpha (floored at 1e-3, no division by zero). */
  alpha: number;
  n: Vec3;
  l: Vec3;
  v: Vec3;
  /** Incident irradiance. */
  E: number;
}

/**
 * Cook-Torrance GGX: f_r = rho/pi + D F V, V = 1/((n.l+s_l)(n.v+s_v)).
 * D(h) = alpha^2 / (pi ((n.h)^2 (alpha^2 - 1) + 1)^2)  (Trowbridge-Reitz)
 * F = F_0 + (1 - F_0)(1 - h.v)^5                        (Schlick)
 * V is the Smith visibility in the finite-at-grazing form (oracle 4):
 *   V = G1(l)G1(v)/(4 (n.l)(n.v)) = 1/((n.l+s_l)(n.v+s_v)),
 *   s_x = sqrt(alpha^2 + (1-alpha^2)(n.x)^2).
 * The V form needs no clamp on n.l or n.v and stays finite at grazing
 * (the G/(4 nl nv) form is 0/0 there). Floors: alpha >= 1e-3 only.
 * Returns outgoing radiance E * f_r * (n.l).
 */
export function cookTorranceGgx(p: GgxParams): number {
  const alpha = Math.max(p.alpha, 1e-3);
  const a2 = alpha * alpha;
  const ndl = dot3(p.n, p.l);
  const ndv = dot3(p.n, p.v);
  const h: Vec3 = [
    p.l[0] + p.v[0],
    p.l[1] + p.v[1],
    p.l[2] + p.v[2],
  ];
  const hl = Math.hypot(h[0], h[1], h[2]) || 1;
  const hn: Vec3 = [h[0] / hl, h[1] / hl, h[2] / hl];
  const ndh = Math.max(dot3(p.n, hn), 0);
  const hdv = Math.max(Math.min(dot3(hn, p.v), 1), 0);
  const denom = ndh * ndh * (a2 - 1) + 1;
  const D = a2 / (Math.PI * denom * denom);
  const F = p.F0 + (1 - p.F0) * (1 - hdv) ** 5;
  const V = smithVisibility(ndl, ndv, alpha);
  // Specular contributes only above the horizon; V is singular at exactly
  // nl = -1 or nv = -1, where the max(ndl, 0) factor already zeroes output.
  const spec = ndl > 0 && ndv > 0 ? D * F * V : 0;
  const fr = p.rho / Math.PI + spec;
  return p.E * fr * Math.max(ndl, 0);
}

/**
 * Smith visibility, finite-at-grazing form (normative per the GGX oracle):
 * V = 1 / ((nl + s_l)(nv + s_v)), s_x = sqrt(a^2 + (1-a^2) x^2).
 * Finite at nl = 0 exactly; no division by nl or nv, no clamp needed.
 */
export function smithVisibility(nl: number, nv: number, alpha: number): number {
  const a = Math.max(alpha, 1e-3);
  const a2 = a * a;
  const sl = Math.sqrt(a2 + (1 - a2) * nl * nl);
  const sv = Math.sqrt(a2 + (1 - a2) * nv * nv);
  return 1 / ((nl + sl) * (nv + sv));
}

/** Smith G1 for one direction (used by the masking identity, oracle 2). */
export function smithG1(nx: number, alpha: number): number {
  const a = Math.max(alpha, 1e-3);
  const s = Math.sqrt(a * a + (1 - a * a) * nx * nx);
  return (2 * nx) / (nx + s);
}

/** GGX normal distribution D. */
export function ggxD(ndh: number, alpha: number): number {
  const a = Math.max(alpha, 1e-3);
  const a2 = a * a;
  const denom = ndh * ndh * (a2 - 1) + 1;
  return a2 / (Math.PI * denom * denom);
}

/**
 * GGX importance-sampling: cos(theta_h) from a uniform variate xi.
 * cosθh = sqrt((1-xi)/(1+(a^2-1)*xi)); reproduces the D(n.h) pdf.
 */
export function sampleGgxCosTheta(xi: number, alpha: number): number {
  const a = Math.max(alpha, 1e-3);
  const a2 = a * a;
  return Math.sqrt((1 - xi) / (1 + (a2 - 1) * xi));
}

// ---------------------------------------------------------------------------
// Spherical-harmonics diffuse environment (9 coefficients, l = 0..2).
//
// E(n) = sum_{l=0..2} sum_{m=-l..l} Ahat_l L_{lm} Y_{lm}(n),
// Ahat_0 = pi, Ahat_1 = 2pi/3, Ahat_2 = pi/4 (irradiance convolution).
// The formula yields IRRADIANCE E; Lambertian outgoing radiance is
// rho * E / pi. Do not be off by pi.
// ---------------------------------------------------------------------------

/** Irradiance convolution constants Ahat_0..2. */
export const SH_AHAT = [Math.PI, (2 * Math.PI) / 3, Math.PI / 4];

/** Real SH basis Y_lm for l = 0..2, order [00, 1-1, 10, 11, 2-2, 2-1, 20, 21, 22]. */
export function shBasis(n: Vec3): number[] {
  const [x, y, z] = n;
  return [
    0.28209479177387814, // Y00 = 1/(2 sqrt(pi))
    0.4886025119029199 * y, // Y1-1
    0.4886025119029199 * z, // Y10
    0.4886025119029199 * x, // Y11
    1.0925484305920792 * x * y, // Y2-2
    1.0925484305920792 * y * z, // Y2-1
    0.31539156525252005 * (3 * z * z - 1), // Y20
    1.0925484305920792 * x * z, // Y21
    0.5462742152960396 * (x * x - y * y), // Y22
  ];
}

/** Irradiance E(n) from 9 SH lighting coefficients. */
export function shIrradiance(n: Vec3, L: number[]): number {
  const Y = shBasis(n);
  return (
    SH_AHAT[0] * L[0] * Y[0] +
    SH_AHAT[1] * (L[1] * Y[1] + L[2] * Y[2] + L[3] * Y[3]) +
    SH_AHAT[2] * (L[4] * Y[4] + L[5] * Y[5] + L[6] * Y[6] + L[7] * Y[7] + L[8] * Y[8])
  );
}

/** Lambertian outgoing radiance under SH lighting: rho * E(n) / pi. */
export function lambertSH(rho: number, n: Vec3, L: number[]): number {
  return (rho * shIrradiance(n, L)) / Math.PI;
}
