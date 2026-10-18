// math/overrelax.ts - safe over-relaxed sphere tracing.
//
// COST MODEL (documented here so perf claims point at formulas):
//   Ray budget:  R_dot = 2 W H f_r (1 - rho_fov) rays/s
//     (two eyes, W x H pixels, f_r frames/s, rho_fov = foveation saving).
//     Example: 2000^2 per eye at 90 Hz -> 720 Mrays/s before foveation.
//   Grazing-ray cost: a ray descending at angle gamma toward a plane
//   multiplies its height by (1 - sin gamma / L) per step, so
//     N ≈ ln(d_0/eps) / -ln(1 - sin gamma/L) ≈ L ln(d_0/eps) / gamma.
//     Example: gamma = 5°, eps = 1e-4, d_0 = 1, L = 1 -> ~100 steps.
//   Grazing rays dominate cost, and L > 1 multiplies it: this is why
//   tight local Lipschitz bounds matter (see lipschitz.ts).
//
// SAFE OVER-RELAXATION: step s_i = omega r_i with r_i = f(p_i)/L and
// omega in [1, 2). After stepping, check the empty-ball overlap
//   r_{i-1} + r_i >= s_{i-1};
// if the balls do not overlap, retreat to t_i = t_{i-1} + r_{i-1} and
// continue unrelaxed from there. The union of the two balls then covers
// the whole segment, so the relaxed march cannot tunnel where the
// unrelaxed one does not. omega = 1 is exactly the unrelaxed march.
//
// All techniques are classical public mathematics; see
// docs/methods-provenance.md.

import { evalSdf, sdfNormal, lipschitzBound, type SdfNode, type Uniforms, type MarchResult } from './sdf.js';
import type { Vec3 } from './vec.js';
import { SDF_EPS, SDF_MAX_DIST, SDF_MAX_STEPS } from './sdf.js';

/** Rays per second before foveation savings. */
export function rayBudget(w: number, h: number, fps: number, foveationSaving: number): number {
  return 2 * w * h * fps * (1 - foveationSaving);
}

/** Expected step count for a ray descending at angle gamma to a plane. */
export function grazingStepCount(d0: number, eps: number, L: number, gamma: number): number {
  const per = 1 - Math.sin(gamma) / L;
  if (per <= 0 || per >= 1) return Infinity;
  return Math.log(d0 / eps) / -Math.log(per);
}

export interface OverRelaxOpts {
  maxSteps?: number;
  maxDist?: number;
  eps?: number;
  /** Over-relaxation factor in [1, 2). 1 = unrelaxed march. */
  omega?: number;
  /** Explicit Lipschitz bound (skips lipschitzBound). */
  lipschitz?: number;
  /** Radial extent for the twist bound. Default 8. */
  extent?: number;
}

export interface OverRelaxResult extends MarchResult {
  /** Steps that used the relaxed stride (vs retreats). */
  relaxedSteps: number;
  /** Steps where the overlap check failed and we retreated. */
  retreats: number;
}

/**
 * Sphere tracing with safe over-relaxation. The ray direction must be
 * unit length (asserted at entry, as in marchRay).
 */
export function marchRayOverRelaxed(
  node: SdfNode, ro: Vec3, rd: Vec3, u: Uniforms = {}, opts: OverRelaxOpts = {},
): OverRelaxResult {
  const rl = Math.hypot(rd[0], rd[1], rd[2]);
  if (Math.abs(rl - 1) > 1e-6) {
    throw new Error(`marchRayOverRelaxed: ray direction must be unit length, got |d| = ${rl}`);
  }
  const omega = opts.omega ?? 1.5;
  if (!(omega >= 1 && omega < 2)) {
    throw new Error(`marchRayOverRelaxed: omega must be in [1, 2), got ${omega}`);
  }
  const maxSteps = opts.maxSteps ?? SDF_MAX_STEPS;
  const maxDist = opts.maxDist ?? SDF_MAX_DIST;
  const eps = opts.eps ?? SDF_EPS;
  const L = opts.lipschitz ?? lipschitzBound(node, u, { extent: opts.extent });
  if (!(Number.isFinite(L) && (L as number) > 0)) {
    throw new Error(
      'marchRayOverRelaxed: need a finite Lipschitz bound to over-relax safely; ' +
      'pass opts.lipschitz or use marchRay for the under-relaxed fallback',
    );
  }
  const bound = L as number;

  let t = 0;
  let relaxedSteps = 0, retreats = 0;
  // Previous step's ball, for the overlap check.
  let prevR = 0, prevT = 0;
  let havePrev = false;

  for (let i = 0; i < maxSteps; i++) {
    const p: Vec3 = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
    const h = evalSdf(node, p, u);
    if (h.d < eps) {
      return {
        hit: true, dist: t, mat: h.mat, pos: p,
        normal: sdfNormal(node, p, u), steps: i + 1, relaxedSteps, retreats,
      };
    }
    const r = h.d / bound;
    if (havePrev) {
      const sPrev = omega * prevR;
      if (prevR + r >= sPrev) {
        // Balls overlap: the relaxed stride was safe.
        relaxedSteps++;
      } else {
        // No overlap: retreat to the unrelaxed landing and continue.
        t = prevT + prevR;
        retreats++;
        havePrev = false;
        continue;
      }
    }
    prevR = r;
    prevT = t;
    havePrev = true;
    t += omega * r;
    if (t > maxDist) break;
  }
  const miss: Vec3 = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
  return { hit: false, dist: t, mat: 0, pos: miss, normal: null, steps: maxSteps, relaxedSteps, retreats };
}
