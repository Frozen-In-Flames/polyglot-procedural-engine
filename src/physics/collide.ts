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
//
// The stepSpheres / stepSphereSdf drivers below are the contact path
// since v2.0.5. The default solver is the full XPBD loop: substeps,
// per-substep Lagrange multiplier accumulation across constraint
// iterations, compliance alpha, and a velocity pass for restitution
// and Coulomb friction (Muller et al., "Detailed Rigid Body
// Simulation with XPBD", 2020). It needs no sleeping threshold: the
// velocity is derived from the solved positions, so a resting body
// derives a resting velocity. The impulse path above stays available
// behind { solver: 'impulse' } for a single sphere vs an SDF.
// See docs/xpbd-contact.md for the measured comparison.

import { cross3 as cross, dot3 as dot, type Vec3 } from '../math/vec.js';

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

// ---------------------------------------------------------------------------
// XPBD contact solver (v2.0.5): the contact path.
//
// Per substep h = dt / substeps (Muller et al. 2020, sections 3.1-3.4):
//   1. v += h g;  x_prev = x;  x += h v          (predict)
//   2. Detect contacts at the predicted positions; record the
//      pre-solve contact-point normal velocity vnPre per contact.
//   3. Gauss-Seidel iterations over the normal constraints
//      C >= 0 with per-contact Lagrange multiplier lambda, reset to 0
//      each substep and accumulated across the iterations of that
//      substep:  dlambda = (-C - alpha_tilde lambda) / (w + alpha_tilde),
//      alpha_tilde = alpha / h^2, w = grad C^T M^-1 grad C.
//   4. v = (x - x_prev) / h                       (velocity update)
//   5. Velocity pass per contact: restitution toward -e * vnPre
//      (suppressed below restThreshold so resting contact does not
//      jitter) and Coulomb friction: the tangential impulse that
//      would stop the contact point is applied in full when it fits
//      under muS * (lambda / h), else clamped to muK * (lambda / h).
//
// For a sphere the normal at a contact passes through the center, so
// the normal constraint carries no angular term (w = 1/m against an
// SDF, 1/ma + 1/mb for a pair). Friction acts at the contact point,
// so it does couple to spin: w here is treated as the world-frame
// angular velocity, which is exact for a sphere (isotropic inertia
// I = 2/5 m r^2); this module tracks no orientation state.
// ---------------------------------------------------------------------------

export type ContactSolverKind = 'xpbd' | 'impulse';

export interface ContactOpts {
  /** Solver for the step. Default 'xpbd'. 'impulse' is the legacy
   *  path (applyContactImpulse + hard projection), single sphere vs
   *  SDF only, reached through stepSphereSdf. */
  solver?: ContactSolverKind;
  /** XPBD substeps per step. Default 20. */
  substeps?: number;
  /** Constraint iterations per substep. Default 1 (XPBD small-steps
   *  style: substeps do the convergence work). */
  iterations?: number;
  /** Contact compliance alpha (m/N); 0 is rigid. Default 0. At rest
   *  on a plane the penetration settles to alpha * m * |g|. */
  alpha?: number;
  /** Static / kinetic Coulomb friction coefficients. Default 0. */
  muS?: number;
  muK?: number;
  /** Restitution coefficient. Default 0. */
  e?: number;
  /** Kelvin-Voigt contact damping: the fraction of the contact's
   *  normal gap rate removed per substep in the velocity pass,
   *  applied only when the restitution branch did not fire for that
   *  contact. Default 0 (pure XPBD: a compliant contact is then a
   *  nearly lossless spring and a dropped body bounces on it for a
   *  long time, which is the published algorithm's real behavior;
   *  real pads dissipate, and this is the dissipation knob). Does
   *  not move the static deflection alpha * m * |g|. */
  contactDamping?: number;
  /** Impact speeds below this get no restitution. Default
   *  2 * |gravity| * h per substep, the scale of one substep of
   *  gravitational velocity gain. */
  restThreshold?: number;
  /** Negative control: false drops the -alpha_tilde * lambda term,
   *  reducing the solve to classic PBD projection whose effective
   *  stiffness depends on the iteration count. Default true. */
  accumulateLambda?: boolean;
}

export interface ContactStepStats {
  /** Substeps actually run (1 for the impulse path). */
  substeps: number;
  /** Contacts detected across all substeps. */
  contacts: number;
  /** Deepest penetration the solver had to resolve (pre-solve). */
  maxPenetration: number;
  /** Deepest penetration left after the position solve. */
  maxPostPenetration: number;
}

type SdfFn = (p: Vec3) => number;

interface ContactRec {
  a: number;
  /** Second body index, or -1 for the SDF. */
  b: number;
  n: Vec3;
  /** Contact-point offset from a's center. */
  rcA: Vec3;
  /** Contact-point offset from b's center (zero for the SDF). */
  rcB: Vec3;
  /** Pre-solve contact-point normal velocity (b relative to a). */
  vnPre: number;
  lambda: number;
}

/** Contact-point velocity of a body: v + w x rc. */
function pointVel(s: SphereState, rc: Vec3): Vec3 {
  const t = cross(s.w, rc);
  return [s.v[0] + t[0], s.v[1] + t[1], s.v[2] + t[2]];
}
function inertia(s: SphereState): number {
  return 0.4 * s.m * s.r * s.r;
}

/** Step a set of spheres against an optional SDF and each other. */
export function stepSpheres(
  bodies: SphereState[],
  f: SdfFn | null,
  grad: ((p: Vec3) => Vec3) | null,
  gravity: Vec3,
  dt: number,
  opts: ContactOpts = {},
): ContactStepStats {
  const solver = opts.solver ?? 'xpbd';
  if (solver === 'impulse') {
    throw new Error(
      "solver 'impulse' is the legacy single-sphere path; use stepSphereSdf",
    );
  }
  const substeps = Math.max(1, Math.floor(opts.substeps ?? 20));
  const iterations = Math.max(1, Math.floor(opts.iterations ?? 1));
  const alpha = opts.alpha ?? 0;
  const muS = opts.muS ?? 0;
  const muK = opts.muK ?? 0;
  const e = opts.e ?? 0;
  const damping = opts.contactDamping ?? 0;
  const accumulate = opts.accumulateLambda ?? true;
  const h = dt / substeps;
  const at = alpha / (h * h);
  const gMag = Math.hypot(gravity[0], gravity[1], gravity[2]);
  const restTh = opts.restThreshold ?? 2 * gMag * h;
  const stats: ContactStepStats = {
    substeps, contacts: 0, maxPenetration: 0, maxPostPenetration: 0,
  };
  const prev: Vec3[] = bodies.map((s) => [s.c[0], s.c[1], s.c[2]]);

  for (let sub = 0; sub < substeps; sub++) {
    // 1. Integrate forces, save positions, predict.
    for (let i = 0; i < bodies.length; i++) {
      const s = bodies[i];
      prev[i] = [s.c[0], s.c[1], s.c[2]];
      s.v[0] += gravity[0] * h;
      s.v[1] += gravity[1] * h;
      s.v[2] += gravity[2] * h;
      s.c[0] += s.v[0] * h;
      s.c[1] += s.v[1] * h;
      s.c[2] += s.v[2] * h;
    }
    // 2. Detect contacts at the predicted positions.
    const contacts: ContactRec[] = [];
    if (f !== null && grad !== null) {
      for (let i = 0; i < bodies.length; i++) {
        const s = bodies[i];
        const ct = sphereContact(s.c, s.r, f, grad);
        if (ct === null) continue;
        stats.contacts++;
        stats.maxPenetration = Math.max(stats.maxPenetration, ct.d);
        const rcA: Vec3 = [ct.x[0] - s.c[0], ct.x[1] - s.c[1], ct.x[2] - s.c[2]];
        contacts.push({
          a: i, b: -1, n: ct.n, rcA, rcB: [0, 0, 0],
          vnPre: dot(pointVel(s, rcA), ct.n), lambda: 0,
        });
      }
    }
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const A = bodies[i], B = bodies[j];
        const dx = B.c[0] - A.c[0], dy = B.c[1] - A.c[1], dz = B.c[2] - A.c[2];
        const dist = Math.hypot(dx, dy, dz);
        const rSum = A.r + B.r;
        if (dist >= rSum) continue;
        stats.contacts++;
        stats.maxPenetration = Math.max(stats.maxPenetration, rSum - dist);
        const n: Vec3 = dist > 1e-12
          ? [dx / dist, dy / dist, dz / dist]
          : [0, 1, 0];
        const rcA: Vec3 = [n[0] * A.r, n[1] * A.r, n[2] * A.r];
        const rcB: Vec3 = [-n[0] * B.r, -n[1] * B.r, -n[2] * B.r];
        const rv = pointVel(B, rcB), lv = pointVel(A, rcA);
        const vnPre = dot(
          [rv[0] - lv[0], rv[1] - lv[1], rv[2] - lv[2]], n,
        );
        contacts.push({ a: i, b: j, n, rcA, rcB, vnPre, lambda: 0 });
      }
    }
    // vnPre is the gap separation rate in both cases: for the SDF
    // it is (contact velocity of a) . n with n out of the field, for
    // a pair it is (vb - va) . n with n from a to b. Both read
    // negative when the gap is closing.
    // 3. Position solve: XPBD normal constraints, lambda accumulated.
    for (let it = 0; it < iterations; it++) {
      for (const ct of contacts) {
        const A = bodies[ct.a];
        let C: number, n: Vec3, wq: number;
        if (ct.b < 0) {
          if (f === null || grad === null) continue;
          C = f(A.c) - A.r;
          const g = grad(A.c);
          const gl = Math.hypot(g[0], g[1], g[2]) || 1;
          n = [g[0] / gl, g[1] / gl, g[2] / gl];
          wq = 1 / A.m;
        } else {
          const B = bodies[ct.b];
          const dx = B.c[0] - A.c[0], dy = B.c[1] - A.c[1], dz = B.c[2] - A.c[2];
          const dist = Math.hypot(dx, dy, dz);
          C = dist - (A.r + B.r);
          n = dist > 1e-12 ? [dx / dist, dy / dist, dz / dist] : ct.n;
          wq = 1 / A.m + 1 / B.m;
        }
        if (C >= 0 && ct.lambda === 0) continue;
        let dl = accumulate
          ? (-C - at * ct.lambda) / (wq + at)
          : -C / (wq + at);
        if (ct.lambda + dl < 0) dl = -ct.lambda; // unilateral
        if (dl === 0) continue;
        ct.lambda += dl;
        ct.n = n;
        if (ct.b < 0) {
          A.c[0] += (n[0] * dl) / A.m;
          A.c[1] += (n[1] * dl) / A.m;
          A.c[2] += (n[2] * dl) / A.m;
        } else {
          const B = bodies[ct.b];
          A.c[0] -= (n[0] * dl) / A.m;
          A.c[1] -= (n[1] * dl) / A.m;
          A.c[2] -= (n[2] * dl) / A.m;
          B.c[0] += (n[0] * dl) / B.m;
          B.c[1] += (n[1] * dl) / B.m;
          B.c[2] += (n[2] * dl) / B.m;
        }
      }
    }
    for (const ct of contacts) {
      const A = bodies[ct.a];
      let C: number;
      if (ct.b < 0) {
        if (f === null) continue;
        C = f(A.c) - A.r;
      } else {
        const B = bodies[ct.b];
        C = Math.hypot(B.c[0] - A.c[0], B.c[1] - A.c[1], B.c[2] - A.c[2])
          - (A.r + B.r);
      }
      if (C < 0) {
        stats.maxPostPenetration = Math.max(stats.maxPostPenetration, -C);
      }
    }
    // 4. Velocity update from the solved positions.
    for (let i = 0; i < bodies.length; i++) {
      const s = bodies[i];
      s.v[0] = (s.c[0] - prev[i][0]) / h;
      s.v[1] = (s.c[1] - prev[i][1]) / h;
      s.v[2] = (s.c[2] - prev[i][2]) / h;
    }
    // 5. Velocity pass: restitution, contact damping, friction.
    // Gap separation rate of a contact at current velocities: for
    // the SDF it is (velocity of a) . n with n out of the field; for
    // a pair, (vb - va) . n with n from a to b. Negative = closing.
    const gapRate = (ct: ContactRec, n: Vec3): number => {
      const A = bodies[ct.a];
      if (ct.b < 0) return dot(A.v, n);
      const B = bodies[ct.b];
      return dot([B.v[0] - A.v[0], B.v[1] - A.v[1], B.v[2] - A.v[2]], n);
    };
    // Change a contact's gap rate by dvn, split by inverse mass.
    // The SDF normal points out of the field toward a, the pair
    // normal from a to b, so the distribution signs differ.
    const applyGapDv = (ct: ContactRec, n: Vec3, dvn: number): void => {
      const A = bodies[ct.a];
      if (ct.b < 0) {
        A.v[0] += n[0] * dvn;
        A.v[1] += n[1] * dvn;
        A.v[2] += n[2] * dvn;
        return;
      }
      const B = bodies[ct.b];
      const invA = 1 / A.m, invB = 1 / B.m, wsum = invA + invB;
      A.v[0] -= n[0] * dvn * (invA / wsum);
      A.v[1] -= n[1] * dvn * (invA / wsum);
      A.v[2] -= n[2] * dvn * (invA / wsum);
      B.v[0] += n[0] * dvn * (invB / wsum);
      B.v[1] += n[1] * dvn * (invB / wsum);
      B.v[2] += n[2] * dvn * (invB / wsum);
    };
    for (const ct of contacts) {
      const A = bodies[ct.a];
      const B = ct.b >= 0 ? bodies[ct.b] : null;
      // Refresh geometry at the solved positions.
      let n = ct.n, rcA = ct.rcA, rcB = ct.rcB;
      if (B === null) {
        if (f !== null && grad !== null) {
          const now = sphereContact(A.c, A.r, f, grad);
          if (now !== null) {
            n = now.n;
            rcA = [now.x[0] - A.c[0], now.x[1] - A.c[1], now.x[2] - A.c[2]];
          }
        }
      } else {
        const dx = B.c[0] - A.c[0], dy = B.c[1] - A.c[1], dz = B.c[2] - A.c[2];
        const dist = Math.hypot(dx, dy, dz);
        if (dist > 1e-12) {
          n = [dx / dist, dy / dist, dz / dist];
          rcA = [n[0] * A.r, n[1] * A.r, n[2] * A.r];
          rcB = [-n[0] * B.r, -n[1] * B.r, -n[2] * B.r];
        }
      }
      const invA = 1 / A.m, invB = B !== null ? 1 / B.m : 0;
      // Restitution: drive the gap separation rate to -e * vnPre.
      // Contact damping (Kelvin-Voigt): on substeps where the
      // restitution branch did not fire, remove a fraction of the
      // current gap rate instead. Impacts keep the spring's energy;
      // persistent contact dissipates.
      if (e > 0 && ct.vnPre < -restTh) {
        applyGapDv(ct, n, -e * ct.vnPre - gapRate(ct, n));
      } else if (damping > 0) {
        applyGapDv(ct, n, -damping * gapRate(ct, n));
      }
      // Friction: tangential contact-point impulse, Coulomb clamped
      // by this substep's normal impulse lambda / h.
      if ((muS > 0 || muK > 0) && ct.lambda > 0) {
        const pvA = pointVel(A, rcA);
        const pvB = B !== null ? pointVel(B, rcB) : ([0, 0, 0] as Vec3);
        const rv: Vec3 = [pvB[0] - pvA[0], pvB[1] - pvA[1], pvB[2] - pvA[2]];
        const rvn = dot(rv, n);
        const vt: Vec3 = [
          rv[0] - rvn * n[0], rv[1] - rvn * n[1], rv[2] - rvn * n[2],
        ];
        const speed = Math.hypot(vt[0], vt[1], vt[2]);
        if (speed > 1e-12) {
          const t: Vec3 = [vt[0] / speed, vt[1] / speed, vt[2] / speed];
          // Generalized inverse mass along t at the contact point.
          let wqT = invA + invB;
          const uA = cross(rcA, t);
          const IA = inertia(A);
          const spinA = cross(
            [uA[0] / IA, uA[1] / IA, uA[2] / IA], rcA,
          );
          wqT += dot(spinA, t);
          if (B !== null) {
            const uB = cross(rcB, t);
            const IB = inertia(B);
            const spinB = cross(
              [uB[0] / IB, uB[1] / IB, uB[2] / IB], rcB,
            );
            wqT += dot(spinB, t);
          }
          const pN = ct.lambda / h;
          const pNeed = speed / wqT;
          const p = pNeed <= muS * pN ? pNeed : muK * pN;
          if (p > 0) {
            // Impulse +t*p on a, -t*p on b reduces the relative
            // tangential velocity along t (t points along rv_t).
            A.v[0] += t[0] * p * invA;
            A.v[1] += t[1] * p * invA;
            A.v[2] += t[2] * p * invA;
            const twA = cross(rcA, [t[0] * p, t[1] * p, t[2] * p]);
            A.w[0] += twA[0] / IA;
            A.w[1] += twA[1] / IA;
            A.w[2] += twA[2] / IA;
            if (B !== null) {
              B.v[0] -= t[0] * p * invB;
              B.v[1] -= t[1] * p * invB;
              B.v[2] -= t[2] * p * invB;
              const twB = cross(rcB, [-t[0] * p, -t[1] * p, -t[2] * p]);
              const IB = inertia(B);
              B.w[0] += twB[0] / IB;
              B.w[1] += twB[1] / IB;
              B.w[2] += twB[2] / IB;
            }
          }
        }
      }
    }
  }
  return stats;
}

/** Step one sphere against an SDF. The solver switch lives here. */
export function stepSphereSdf(
  s: SphereState,
  f: SdfFn,
  grad: (p: Vec3) => Vec3,
  gravity: Vec3,
  dt: number,
  opts: ContactOpts = {},
): ContactStepStats {
  if ((opts.solver ?? 'xpbd') === 'impulse') {
    // Legacy path: semi-implicit Euler at the full step, impulse
    // with restitution and friction, then hard projection. No
    // substeps, no compliance, friction that never reaches w (the
    // documented defect the XPBD path fixes). Kept for comparison
    // and for callers who need the old response exactly.
    const stats: ContactStepStats = {
      substeps: 1, contacts: 0, maxPenetration: 0, maxPostPenetration: 0,
    };
    s.v[0] += gravity[0] * dt;
    s.v[1] += gravity[1] * dt;
    s.v[2] += gravity[2] * dt;
    s.c[0] += s.v[0] * dt;
    s.c[1] += s.v[1] * dt;
    s.c[2] += s.v[2] * dt;
    const ct = sphereContact(s.c, s.r, f, grad);
    if (ct !== null) {
      stats.contacts = 1;
      stats.maxPenetration = ct.d;
      applyContactImpulse(s, ct.n, opts.e ?? 0, opts.muK ?? 0);
      s.c[0] += ct.n[0] * ct.d;
      s.c[1] += ct.n[1] * ct.d;
      s.c[2] += ct.n[2] * ct.d;
    }
    return stats;
  }
  return stepSpheres([s], f, grad, gravity, dt, opts);
}
