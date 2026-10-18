// math/conservative.ts - conservative-primitive audit.
//
// The marcher only needs |f| <= true distance (weaker than an exact
// SDF). This module records, per primitive and operator, which side of
// that line each one stands on, and provides the audit harness that
// checks it: for random query points p,
//   f(p) <= min_q ||p - q|| + tol
// over densely sampled surface points q. Exact rows additionally satisfy
// ||grad f|| ≈ 1 near the surface.
//
// AUDIT TABLE (status: 'exact' | 'conservative' | 'conditional'):
//   sphere ||p||-r                                        exact
//   box  ||max(q,0)||+min(max(qx,qy,qz),0), q=|p|-b        exact
//   capsule ||p-a-h(b-a)||-r, h=clamp(...)                exact
//   torus ||(||p_xz||-R, p_y)||-r                        exact
//   offset f-r, shell |f|-t                              exact
//   union min(a,b), intersect max(a,b),                  conservative
//   subtract max(a,-b)                                   (outside)
//   non-uniform scale f(S^-1 p)*min_i s_i                conservative
//     (from ||S x|| >= min_i s_i ||x||)
//   repetition f(p - s round(p/s))                       conditional:
//     exact only if shapes stay inside their cell, else min over neighbors
//   polar repeat                                          conditional: same
//
// All techniques are classical public mathematics; see
// docs/methods-provenance.md.

import { evalSdf, type SdfNode, type Uniforms } from './sdf.js';
import type { Vec3 } from './vec.js';
import { Pcg32 } from './determinism.js';

export type ConservativeStatus = 'exact' | 'conservative' | 'conditional';

export interface AuditRow {
  op: string;
  formula: string;
  status: ConservativeStatus;
  note: string;
}

/** The documented audit table. Every primitive/operator in the SDF
 *  library appears here; anything missing is a gap, not an assumption. */
export const AUDIT_TABLE: AuditRow[] = [
  { op: 'sphere', formula: '||p|| - r', status: 'exact', note: 'closed-form distance' },
  { op: 'box', formula: '||max(q,0)|| + min(max(qx,qy,qz),0), q = |p| - b', status: 'exact', note: 'closed-form distance' },
  { op: 'capsule', formula: '||p - a - h(b-a)|| - r, h = clamp((p-a).(b-a)/||b-a||^2, 0, 1)', status: 'exact', note: 'closed-form distance' },
  { op: 'torus', formula: '||(||p_xz|| - R, p_y)|| - r', status: 'exact', note: 'closed-form distance' },
  { op: 'plane', formula: 'n.p - h', status: 'exact', note: 'closed-form distance' },
  { op: 'offset', formula: 'f - r', status: 'exact', note: 'shifts the level set exactly' },
  { op: 'shell', formula: '|f| - t', status: 'exact', note: 'exact for exact f' },
  { op: 'union', formula: 'min(a, b)', status: 'conservative', note: 'min of underestimates is an underestimate outside' },
  { op: 'intersect', formula: 'max(a, b)', status: 'conservative', note: 'max of underestimates is an underestimate outside' },
  { op: 'subtract', formula: 'max(a, -b)', status: 'conservative', note: 'conservative outside the result' },
  { op: 'polySmin', formula: 'min(a,b) - (k/4) h^2', status: 'conservative', note: 'below min(a,b), hence conservative' },
  { op: 'smoothUnion', formula: '-(1/k) ln(e^{-ka} + e^{-kb})', status: 'conservative', note: 'below min(a,b), hence conservative' },
  { op: 'scale3', formula: 'f(S^-1 p) * min_i s_i', status: 'conservative', note: 'from ||S x|| >= min_i s_i ||x||' },
  { op: 'repeat', formula: 'f(p - s round(p/s))', status: 'conditional', note: 'exact only if shapes stay inside their cell, else min over neighbors' },
  { op: 'polarRepeat', formula: "theta' = mod(theta + pi/n, 2pi/n) - pi/n", status: 'conditional', note: 'same cell caveat as repeat' },
  { op: 'twist', formula: 'f(R(kz) p)', status: 'exact', note: 'rigid rotation of the domain preserves distance' },
  { op: 'translate', formula: 'f(p - t)', status: 'exact', note: 'rigid translation preserves distance' },
  { op: 'displace', formula: 'f + A n(p)', status: 'conservative', note: 'not a distance; bounded by the Lipschitz machinery' },
];

export interface AuditResult {
  violations: number;
  checked: number;
  maxOverestimate: number;
}

/**
 * Audit a field against densely sampled surface points: count query
 * points where f(p) exceeds the sampled true distance by more than tol.
 * Deterministic (seeded). Zero violations is the expected result for
 * every row of the audit table.
 */
export function auditConservative(
  node: SdfNode,
  surface: Vec3[],
  queries: number,
  radius: number,
  seed: number,
  tol = 1e-6,
  u: Uniforms = {},
): AuditResult {
  const g = new Pcg32(seed);
  let violations = 0, checked = 0, maxOver = 0;
  for (let i = 0; i < queries; i++) {
    const p: Vec3 = [
      (g.unit() * 2 - 1) * radius,
      (g.unit() * 2 - 1) * radius,
      (g.unit() * 2 - 1) * radius,
    ];
    const f = evalSdf(node, p, u).d;
    let dmin = Infinity;
    for (const q of surface) {
      const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (d < dmin) dmin = d;
    }
    checked++;
    const over = f - dmin;
    if (over > maxOver) maxOver = over;
    if (over > tol) violations++;
  }
  return { violations, checked, maxOverestimate: maxOver };
}

/** Central-difference gradient magnitude, for the ||grad f|| ≈ 1 check. */
export function gradMagnitude(node: SdfNode, p: Vec3, h = 1e-4, u: Uniforms = {}): number {
  const dx = evalSdf(node, [p[0] + h, p[1], p[2]], u).d - evalSdf(node, [p[0] - h, p[1], p[2]], u).d;
  const dy = evalSdf(node, [p[0], p[1] + h, p[2]], u).d - evalSdf(node, [p[0], p[1] - h, p[2]], u).d;
  const dz = evalSdf(node, [p[0], p[1], p[2] + h], u).d - evalSdf(node, [p[0], p[1], p[2] - h], u).d;
  return Math.hypot(dx, dy, dz) / (2 * h);
}
