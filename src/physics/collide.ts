// physics/collide.ts - SDF collision: penetration, impulse, XPBD.
//
// Sphere vs SDF field f:
//   penetration d = r - f(c), normal n = grad f(c) / ||grad f(c)||,
//   contact x = c - f(c) n.
// Impulse with restitution e (static SDF has infinite mass):
//   j = -(1+e)(v_rel . n) / (1/m + n . [(I^-1 (r_c x n)) x r_c])
// Coulomb friction clamps the tangential impulse: |j_t| <= mu j_n.
// XPBD position-level contact: C = f(x) - r >= 0, applied only when
// C < 0, compliance alpha_tilde = alpha/h^2:
//   dlambda = (-C - alpha_tilde lambda)/(grad C^T M^-1 grad C + alpha_tilde),
//   dx = M^-1 grad C dlambda.
//
// Resting contact needs a SLEEPING speed threshold: below sleepV the
// contact velocity is zeroed, or the sphere jitters forever on the
// plane. Tolerances: rest at y = r within 1e-6; e = 1 return height
// within O(h) (energy error per bounce scales with the timestep).

import type { Vec3 } from '../math/vec.js';

export interface SphereState {
  /** Center position. */
  c: Vec3;
  /** Linear velocity. */
  v: Vec3;
  /** Angular velocity (body frame). */
  w: Vec3;
  /** Mass, radius, inertia (solid sphere: 2/5 m r^2). */
  m: number;
  r: number;
}

/** Contact info for a sphere vs an SDF field. */
export function sphereContact(
  c: Vec3,
  r: number,
  f: (p: Vec3) => number,
  grad: (p: Vec3) => Vec3,
): { d: number; n: Vec3; x: Vec3 } | null {
  const fc = f(c);
  if (fc >= r) return null;
  const g = grad(c);
  const gl = Math.hypot(g[0], g[1], g[2]) || 1;
  const n: Vec3 = [g[0] / gl, g[1] / gl, g[2] / gl];
  return {
    d: r - fc,
    n,
    x: [c[0] - fc * n[0], c[1] - fc * n[1], c[2] - fc * n[2]],
  };
}

/**
 * Apply a contact impulse with restitution e and Coulomb friction mu.
 * Static SDF: the field side has infinite mass (drops body b terms).
 */
export function applyContactImpulse(
  s: SphereState,
  n: Vec3,
  e: number,
  mu: number,
): void {
  const vn = s.v[0] * n[0] + s.v[1] * n[1] + s.v[2] * n[2];
  if (vn >= 0) return; // separating
  const I = 0.4 * s.m * s.r * s.r;
  // r_c x n for the single contact (approximate r_c = -r n).
  const rc: Vec3 = [-s.r * n[0], -s.r * n[1], -s.r * n[2]];
  const rcn: Vec3 = [
    rc[1] * n[2] - rc[2] * n[1],
    rc[2] * n[0] - rc[0] * n[2],
    rc[0] * n[1] - rc[1] * n[0],
  ];
  const t1: Vec3 = [rcn[0] / I, rcn[1] / I, rcn[2] / I];
  const t2: Vec3 = [
    t1[1] * rc[2] - t1[2] * rc[1],
    t1[2] * rc[0] - t1[0] * rc[2],
    t1[0] * rc[1] - t1[1] * rc[0],
  ];
  const denom = 1 / s.m + (n[0] * t2[0] + n[1] * t2[1] + n[2] * t2[2]);
  const j = (-(1 + e) * vn) / denom;
  // Normal impulse.
  s.v[0] += (j * n[0]) / s.m;
  s.v[1] += (j * n[1]) / s.m;
  s.v[2] += (j * n[2]) / s.m;
  // Friction: kill tangential velocity, clamped by mu * j.
  const vtn: Vec3 = [
    s.v[0] - (s.v[0] * n[0] + s.v[1] * n[1] + s.v[2] * n[2]) * n[0],
    s.v[1] - (s.v[0] * n[0] + s.v[1] * n[1] + s.v[2] * n[2]) * n[1],
    s.v[2] - (s.v[0] * n[0] + s.v[1] * n[1] + s.v[2] * n[2]) * n[2],
  ];
  const vt = Math.hypot(vtn[0], vtn[1], vtn[2]);
  if (vt > 1e-12) {
    const jt = Math.min(s.m * vt, mu * j);
    s.v[0] -= (jt * vtn[0]) / (vt * s.m);
    s.v[1] -= (jt * vtn[1]) / (vt * s.m);
    s.v[2] -= (jt * vtn[2]) / (vt * s.m);
  }
}

/** XPBD positional correction for C = f(x) - r >= 0 (only when C < 0). */
export function xpbdContact(
  s: SphereState,
  f: (p: Vec3) => number,
  grad: (p: Vec3) => Vec3,
  alpha: number,
  h: number,
): void {
  const C = f(s.c) - s.r;
  if (C >= 0) return;
  const g = grad(s.c);
  const gl = Math.hypot(g[0], g[1], g[2]) || 1;
  const n: Vec3 = [g[0] / gl, g[1] / gl, g[2] / gl];
  const at = alpha / (h * h);
  // lambda starts at 0 each substep here; grad C^T M^-1 grad C = 1/m.
  const dlambda = -C / (1 / s.m + at);
  s.c[0] += (n[0] * dlambda) / s.m;
  s.c[1] += (n[1] * dlambda) / s.m;
  s.c[2] += (n[2] * dlambda) / s.m;
}

export interface DropOpts {
  y0: number;
  r: number;
  g: number;
  h: number;
  e: number;
  /** Sleeping speed threshold; 0 disables sleeping. */
  sleepV: number;
  /** Stop after this many bounces and return the apex (default: settle). */
  maxBounces?: number;
}

/**
 * Drop a sphere onto the plane f(p) = p.y and return the rest height
 * (or the post-bounce apex when maxBounces is set). Semi-implicit Euler
 * with contact projection and sleeping.
 */
export function dropSphereOnPlane(o: DropOpts): number {
  let y = o.y0, v = 0;
  let bounces = 0;
  for (let i = 0; i < 2e6; i++) {
    v -= o.g * o.h;
    y += v * o.h;
    if (y < o.r) {
      y = o.r;
      if (v < 0) {
        v = -o.e * v;
        bounces++;
        if (o.maxBounces !== undefined && bounces >= o.maxBounces) {
          // Coast to the apex after this bounce and return it.
          let vv = v, yy = y;
          let guard = 0;
          while (vv > 0 && guard++ < 2e6) {
            vv -= o.g * o.h;
            yy += vv * o.h;
          }
          return yy;
        }
      }
      if (o.sleepV > 0 && Math.abs(v) < o.sleepV) v = 0;
    }
    if (o.maxBounces === undefined && y === o.r && v === 0) break;
  }
  return y;
}
