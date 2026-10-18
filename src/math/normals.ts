// math/normals.ts - SDF normal estimation.
//
// Two estimators, one interface:
//   tetraNormal: 4 evaluations, n proportional to sum_i s_i f(p + h s_i),
//     s_i in {(1,-1,-1),(-1,-1,1),(-1,1,-1),(1,1,1)}. First-order accurate
//     (measured: angle halves as h halves), small constant, cheap.
//   centralNormal: 6 evaluations, central differences. Second-order
//     accurate (measured: angle quarters as h halves). Kept for
//     comparison and for paths where accuracy beats cost.
// h defaults to the distance-scaled epsilon eps(t) = t * delta.

import type { Vec3 } from './vec.js';

const TET: Vec3[] = [
  [1, -1, -1],
  [-1, -1, 1],
  [-1, 1, -1],
  [1, 1, 1],
];

/** Tetrahedron normal: 4 field evaluations. */
export function tetraNormal(f: (p: Vec3) => number, p: Vec3, h: number): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  for (const s of TET) {
    const v = f([p[0] + h * s[0], p[1] + h * s[1], p[2] + h * s[2]]);
    nx += s[0] * v;
    ny += s[1] * v;
    nz += s[2] * v;
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** Central-difference normal: 6 field evaluations, second-order. */
export function centralNormal(f: (p: Vec3) => number, p: Vec3, h: number): Vec3 {
  const dx =
    f([p[0] + h, p[1], p[2]]) - f([p[0] - h, p[1], p[2]]);
  const dy =
    f([p[0], p[1] + h, p[2]]) - f([p[0], p[1] - h, p[2]]);
  const dz =
    f([p[0], p[1], p[2] + h]) - f([p[0], p[1], p[2] - h]);
  const l = Math.hypot(dx, dy, dz) || 1;
  return [dx / l, dy / l, dz / l];
}
