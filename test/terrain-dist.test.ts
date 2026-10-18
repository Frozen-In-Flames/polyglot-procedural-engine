// test/terrain-dist.test.ts - conservative distance for heightfields.
//
// Spec (V10.4 §3): for a surface y = h(x,z) with slope bound
// ||grad h|| <= s and vertical gap g = y - h(x,z),
//   f = g / sqrt(1 + s^2)
// is a conservative distance. Slope bounds: fBm
// s <= A L_N sum_k (2a)^k w_k; bilinear grid s <= sqrt(2) m.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pcg32 } from '../src/math/determinism.js';
import {
  heightfieldDist, fbmSlopeBound, bilinearSlopeBound,
} from '../src/geo/terrain-dist.js';
import { NOISE_LIPSCHITZ_QUINTIC, valueNoisePcg } from '../src/math/bandlimit.js';
import type { Vec3 } from '../src/math/vec.js';

test('terrain: plane y=x gives the exact distance g/sqrt(2)', () => {
  const h = (x: number, _z: number) => x; // slope bound s = 1
  const s = 1;
  const g = new Pcg32(21);
  for (let i = 0; i < 100; i++) {
    const p: Vec3 = [g.unit() * 6 - 3, g.unit() * 6 - 3, g.unit() * 6 - 3];
    const gap = p[1] - h(p[0], p[2]);
    const f = heightfieldDist(h, s, p);
    const exact = gap / Math.SQRT2;
    assert.ok(Math.abs(f - exact) < 1e-12, `f=${f} exact=${exact}`);
  }
});

test('terrain: fBm slope bound has the documented form', () => {
  const A = 0.7, octaves = 4, a = 0.5;
  const s = fbmSlopeBound(A, NOISE_LIPSCHITZ_QUINTIC, a, octaves);
  let sum = 0;
  for (let k = 0; k < octaves; k++) sum += (2 * a) ** k;
  assert.ok(Math.abs(s - A * NOISE_LIPSCHITZ_QUINTIC * sum) < 1e-12);
});

test('terrain: bilinear grid slope bound', () => {
  // A ramp grid: h = x, so neighbor slope m = 1, bound = sqrt(2).
  const n = 8, dx = 0.5;
  const grid: number[][] = [];
  for (let j = 0; j < n; j++) {
    const row: number[] = [];
    for (let i = 0; i < n; i++) row.push(i * dx);
    grid.push(row);
  }
  const s = bilinearSlopeBound(grid, dx);
  assert.ok(Math.abs(s - Math.SQRT2) < 1e-9, `s=${s}`);
});

test('terrain: conservative on a rough field (brute force)', () => {
  // Rough heightfield from value noise; brute-force true distance by
  // dense sampling, then assert f(p) <= true + tol.
  const h = (x: number, z: number) => 2 * valueNoisePcg(x * 0.8, 0, z * 0.8, 99) - 1;
  const s = fbmSlopeBound(1, NOISE_LIPSCHITZ_QUINTIC, 0.5, 1);
  // Dense surface samples over [-4, 4]^2.
  const surf: Vec3[] = [];
  const m = 120;
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) {
    const x = -4 + (8 * i) / (m - 1), z = -4 + (8 * j) / (m - 1);
    surf.push([x, h(x, z), z]);
  }
  const g = new Pcg32(22);
  let violations = 0;
  for (let i = 0; i < 300; i++) {
    const p: Vec3 = [g.unit() * 7 - 3.5, g.unit() * 4 - 1, g.unit() * 7 - 3.5];
    const f = heightfieldDist(h, s, p);
    let dmin = Infinity;
    for (const q of surf) {
      const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (d < dmin) dmin = d;
    }
    if (f > dmin + 0.05) violations++;
  }
  assert.equal(violations, 0);
});
