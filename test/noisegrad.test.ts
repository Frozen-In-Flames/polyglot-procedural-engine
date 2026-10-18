// test/noisegrad.test.ts - analytic gradients of quintic value noise.
//
// Spec (V10.4 §1): S(t) = 6t^5-15t^4+10t^3, S'(t) = 30t^2(1-t)^2,
// S''(t) = 60t(2t-1)(t-1). 3D value noise in k-coefficient form:
//   n = k_0+k_1 u+k_2 v+k_3 w+k_4 uv+k_5 uw+k_6 vw+k_7 uvw
// with u = S(f_x) etc., and
//   dn/dx = S'(f_x)(k_1+k_4 v+k_5 w+k_7 v w), cyclically.
// Bound: ||grad N|| <= sqrt(3)*1.875*R, R = max corner edge difference;
// fBm: L_n <= A*3.25*R*sum_k (2a)^k w_k.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pcg32 } from '../src/math/determinism.js';
import {
  quinticS, quinticSPrime, quinticSDoublePrime,
  valueNoisePcgGrad, fbmBandLimitedGrad,
  noiseGradBound, fbmGradLipschitz,
} from '../src/math/noisegrad.js';
import { valueNoisePcg } from '../src/math/bandlimit.js';
import type { Vec3 } from '../src/math/vec.js';

test('noisegrad: quintic fade values and derivatives', () => {
  assert.ok(Math.abs(quinticS(0)) < 1e-15);
  assert.ok(Math.abs(quinticS(1) - 1) < 1e-15);
  assert.ok(Math.abs(quinticS(0.5) - 0.5) < 1e-15);
  // S' and S'' vanish at the lattice points (smooth join).
  assert.ok(Math.abs(quinticSPrime(0)) < 1e-15);
  assert.ok(Math.abs(quinticSPrime(1)) < 1e-15);
  assert.ok(Math.abs(quinticSDoublePrime(0)) < 1e-15);
  assert.ok(Math.abs(quinticSDoublePrime(1)) < 1e-15);
  // Max slope at the midpoint.
  assert.ok(Math.abs(quinticSPrime(0.5) - 1.875) < 1e-12);
});

test('noisegrad: gradient value matches valueNoisePcg', () => {
  const g = new Pcg32(1234);
  for (let i = 0; i < 50; i++) {
    const x = g.unit() * 8 - 4, y = g.unit() * 8 - 4, z = g.unit() * 8 - 4;
    const seed = (i * 7919) | 0;
    const { n } = valueNoisePcgGrad(x, y, z, seed);
    const ref = valueNoisePcg(x, y, z, seed);
    assert.ok(Math.abs(n - ref) < 1e-12, `value mismatch at sample ${i}`);
  }
});

test('noisegrad: analytic gradient agrees with central differences to O(h^2)', () => {
  const g = new Pcg32(99);
  for (let i = 0; i < 20; i++) {
    const x = g.unit() * 6 - 3, y = g.unit() * 6 - 3, z = g.unit() * 6 - 3;
    const seed = 4242;
    const { grad } = valueNoisePcgGrad(x, y, z, seed);
    const errs: number[] = [];
    for (const h of [1e-3, 5e-4, 2.5e-4]) {
      const fd: Vec3 = [
        (valueNoisePcg(x + h, y, z, seed) - valueNoisePcg(x - h, y, z, seed)) / (2 * h),
        (valueNoisePcg(x, y + h, z, seed) - valueNoisePcg(x, y - h, z, seed)) / (2 * h),
        (valueNoisePcg(x, y, z + h, seed) - valueNoisePcg(x, y, z - h, seed)) / (2 * h),
      ];
      const e = Math.hypot(fd[0] - grad[0], fd[1] - grad[1], fd[2] - grad[2]);
      errs.push(e);
    }
    // Second-order: halving h quarters the error (allow 0.15..0.4 for noise).
    for (let k = 1; k < errs.length; k++) {
      const ratio = errs[k] / Math.max(errs[k - 1], 1e-300);
      assert.ok(ratio > 0.1 && ratio < 0.45, `O(h^2) failed at sample ${i}: ratio ${ratio}`);
    }
  }
});

test('noisegrad: brute-force max ||grad N|| never exceeds the bound', () => {
  const g = new Pcg32(777);
  const R = 1; // corner values in [0,1], so every edge difference <= 1.
  const bound = noiseGradBound(R);
  assert.ok(Math.abs(bound - Math.sqrt(3) * 1.875 * R) < 1e-12);
  let maxSeen = 0;
  for (let i = 0; i < 20000; i++) {
    const x = g.unit() * 10 - 5, y = g.unit() * 10 - 5, z = g.unit() * 10 - 5;
    const { grad } = valueNoisePcgGrad(x, y, z, i);
    const m = Math.hypot(grad[0], grad[1], grad[2]);
    if (m > maxSeen) maxSeen = m;
    assert.ok(m <= bound * (1 + 1e-9), `bound violated: ${m} > ${bound}`);
  }
  // The bound is not vacuous: samples reach a good fraction of it.
  assert.ok(maxSeen > bound * 0.3, `bound suspiciously loose: max ${maxSeen}`);
});

test('noisegrad: fBm gradient obeys the chain-rule bound', () => {
  const g = new Pcg32(31337);
  const octaves = 4, persistence = 0.5, dx = 0.01, f0 = 1;
  const bound = fbmGradLipschitz(1, 1, persistence, octaves);
  // sum_k (2*0.5)^k = 4 for 4 octaves; 3.25*4 = 13.
  assert.ok(Math.abs(bound - 3.25 * 4) < 1e-9);
  for (let i = 0; i < 2000; i++) {
    const x = g.unit() * 6 - 3, y = g.unit() * 6 - 3, z = g.unit() * 6 - 3;
    const { grad } = fbmBandLimitedGrad(x, y, z, 55, octaves, dx, f0, persistence);
    const m = Math.hypot(grad[0], grad[1], grad[2]);
    assert.ok(m <= bound * (1 + 1e-9) + 1e-9, `fBm grad bound violated: ${m}`);
  }
});
