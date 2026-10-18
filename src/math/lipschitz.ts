// math/lipschitz.ts - Lipschitz bookkeeping for SDF operators.
//
// The march needs |f| <= true distance (weaker than an exact SDF); every
// row below preserves it. The global composed bound (lipschitzBound in
// sdf.ts) is safe but pessimistic: bounds multiply through deep trees.
// Where a tighter LOCAL bound is computable over the box X containing the
// next ray segment, localLipschitzBound gives it; the marcher can then
// step t_{k+1} = t_k + f(p_k)/L_X.
//
// OPERATOR BOUNDS TABLE (L_f = child bound):
//   rigid transform f(Rx+t)      : L_f
//   uniform scale s f(x/s)       : L_f
//   min / max (union/intersect)  : max(L_a, L_b)
//   subtract max(a,-b)           : max(L_a, L_b)
//   sum f+g                      : L_a + L_b
//   displacement f + A n(x)      : L_f + A L_n   (octave form in bandlimit.ts)
//   domain warp f(x+w(x))        : L_f (1 + L_w)
//   twist by k about z           : L_f (1 + k r_max), r_max = largest radial
//                                  distance in the marched box (bounded-region
//                                  requirement, documented)
//   polynomial smooth-min        : max(L_a, L_b) (gradient is a convex
//                                  combination of children's gradients)
//   exponential smooth-min       : max(L_a, L_b) (1-Lipschitz blend)
//
// Honest note: random sampling can FIND violations of a claimed bound but
// cannot CERTIFY one; the zero-violation tests below are evidence, not proof.

import { evalSdf, lipschitzBound, type SdfNode, type Uniforms } from './sdf.js';
import type { Vec3 } from './vec.js';
import { Pcg32 } from './determinism.js';

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** Largest radial (x/z) distance from the y axis inside the box. */
export function maxRadiusInBox(box: Aabb): number {
  const xs = [box.min[0], box.max[0]];
  const zs = [box.min[2], box.max[2]];
  let m = 0;
  for (const x of xs) for (const z of zs) m = Math.max(m, Math.hypot(x, z));
  return m;
}

/**
 * Local Lipschitz bound over an axis-aligned box. Tighter than the global
 * composed bound wherever the bound localizes (twist radius); identical
 * elsewhere. This is the interval-arithmetic bound L_X = sup ||grad f||
 * over X, computed in closed form per operator.
 */
export function localLipschitzBound(node: SdfNode, box: Aabb, u: Uniforms = {}): number {
  switch (node.kind) {
    case 'sphere':
    case 'box':
    case 'torus':
    case 'capsule':
    case 'plane':
      return 1;
    case 'union':
    case 'intersect':
    case 'subtract':
    case 'smoothUnion':
    case 'polySmin': {
      const kids: SdfNode[] =
        node.kind === 'subtract' ? [node.a, node.b] : node.children;
      let m = 0;
      for (const c of kids) m = Math.max(m, localLipschitzBound(c, box, u));
      return m;
    }
    case 'translate':
    case 'scale':
    case 'repeat':
      return localLipschitzBound(node.child, box, u);
    case 'twist': {
      const lc = localLipschitzBound(node.child, box, u);
      const k = Math.abs(typeof node.k === 'number' ? node.k : (u[node.k.uniform] ?? 0));
      return lc * (1 + k * maxRadiusInBox(box));
    }
    case 'displace':
      // Noise bound does not localize usefully; use the composed form.
      return lipschitzBound(node, u);
    default:
      return NaN;
  }
}

/**
 * Count violations of |f(a)-f(b)| <= L ||a-b|| over random point pairs.
 * Deterministic (seeded). Zero is the expected result; a nonzero count
 * names the field and the bound as broken.
 */
export function countLipschitzViolations(
  node: SdfNode,
  L: number,
  pairs: number,
  radius: number,
  seed: number,
  box?: Aabb,
): number {
  const g = new Pcg32(seed);
  const rnd = (r: number): Vec3 => [
    (g.unit() * 2 - 1) * r,
    (g.unit() * 2 - 1) * r,
    (g.unit() * 2 - 1) * r,
  ];
  const inBox = (p: Vec3): boolean =>
    !box ||
    (p[0] >= box.min[0] && p[0] <= box.max[0] &&
      p[1] >= box.min[1] && p[1] <= box.max[1] &&
      p[2] >= box.min[2] && p[2] <= box.max[2]);
  let violations = 0;
  for (let i = 0; i < pairs; i++) {
    const a = rnd(radius), b = rnd(radius);
    if (!inBox(a) || !inBox(b)) continue;
    const fa = evalSdf(node, a).d;
    const fb = evalSdf(node, b).d;
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (Math.abs(fa - fb) > L * dist * (1 + 1e-9) + 1e-12) violations++;
  }
  return violations;
}
