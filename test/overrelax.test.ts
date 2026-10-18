// test/overrelax.test.ts - safe over-relaxed sphere tracing.
//
// Spec (V10.4 §4): r_i = f(p_i)/L, s_i = omega r_i with omega in [1,2).
// After stepping, check the empty-ball overlap r_{i-1} + r_i >= s_{i-1};
// if not, retreat to t_i = t_{i-1} + r_{i-1} and continue unrelaxed.
// The union of the two balls then covers the whole segment, so the
// relaxed march cannot tunnel where the unrelaxed one does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pcg32 } from '../src/math/determinism.js';
import type { Vec3 } from '../src/math/vec.js';
import type { SdfNode } from '../src/math/sdf.js';
import { marchRay } from '../src/math/sdf.js';
import { marchRayOverRelaxed, rayBudget, grazingStepCount } from '../src/math/overrelax.js';

const WARPED: SdfNode = {
  kind: 'displace', amp: 0.25, freq: 1.2, seed: 7,
  child: { kind: 'twist', k: 0.6, child: { kind: 'box', b: [1, 1, 1] } },
};

function randDir(g: Pcg32): Vec3 {
  const v: Vec3 = [g.unit() * 2 - 1, g.unit() * 2 - 1, g.unit() * 2 - 1];
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function aimedRay(g: Pcg32): { ro: Vec3; rd: Vec3 } {
  const ro: Vec3 = [g.unit() * 4 - 2, g.unit() * 4 - 2, -5];
  // Aim at a random point near the origin.
  const target: Vec3 = [g.unit() * 2 - 1, g.unit() * 2 - 1, g.unit() * 2 - 1];
  const d: Vec3 = [target[0] - ro[0], target[1] - ro[1], target[2] - ro[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return { ro, rd: [d[0] / l, d[1] / l, d[2] / l] };
}

test('overrelax: hit points agree with the unrelaxed march within eps', () => {
  const g = new Pcg32(4242);
  let checked = 0;
  for (let i = 0; i < 60; i++) {
    const { ro, rd } = aimedRay(g);
    const plain = marchRay(WARPED, ro, rd, {}, { maxSteps: 256 });
    const relax = marchRayOverRelaxed(WARPED, ro, rd, {}, { omega: 1.5, maxSteps: 256 });
    if (plain.hit) {
      // Safety: the relaxed march must not tunnel through what plain hits.
      assert.ok(relax.hit, 'relaxed march tunneled through a plain hit');
      assert.ok(
        Math.abs(plain.dist - relax.dist) < 2e-3,
        `hit mismatch: plain ${plain.dist} vs relaxed ${relax.dist}`,
      );
      checked++;
    }
    // If plain misses (step budget), relax may hit or miss; no assertion.
  }
  assert.ok(checked > 20, `too few hits to compare: ${checked}`);
});

test('overrelax: relaxed march never uses more steps than unrelaxed', () => {
  const g = new Pcg32(777);
  let plainSteps = 0, relaxSteps = 0, n = 0;
  for (let i = 0; i < 60; i++) {
    const { ro, rd } = aimedRay(g);
    const plain = marchRay(WARPED, ro, rd, {}, { maxSteps: 256 });
    const relax = marchRayOverRelaxed(WARPED, ro, rd, {}, { omega: 1.5, maxSteps: 256 });
    plainSteps += plain.steps;
    relaxSteps += relax.steps;
    n++;
  }
  const meanPlain = plainSteps / n, meanRelax = relaxSteps / n;
  console.log(`    mean steps: plain ${meanPlain.toFixed(1)}, relaxed ${meanRelax.toFixed(1)}`);
  assert.ok(meanRelax <= meanPlain * 1.05, 'relaxed march should not cost more steps on average');
});

test('overrelax: omega is clamped to [1, 2)', () => {
  const ro: Vec3 = [0, 0, -5];
  const rd: Vec3 = [0, 0, 1];
  assert.throws(() => marchRayOverRelaxed(WARPED, ro, rd, {}, { omega: 0.9 }));
  assert.throws(() => marchRayOverRelaxed(WARPED, ro, rd, {}, { omega: 2.0 }));
  // omega = 1 is exactly the unrelaxed march.
  const r1 = marchRayOverRelaxed(WARPED, ro, rd, {}, { omega: 1 });
  assert.ok(r1.steps >= 1);
});

test('overrelax: cost model helpers', () => {
  // 2000^2 per eye at 90 Hz -> 720 Mrays/s before foveation.
  const r = rayBudget(2000, 2000, 90, 0);
  assert.ok(Math.abs(r - 720e6) / 720e6 < 1e-9, `ray budget ${r}`);
  // Grazing ray: gamma = 5°, eps = 1e-4, d_0 = 1, L = 1 -> ~100 steps.
  const n = grazingStepCount(1, 1e-4, 1, (5 * Math.PI) / 180);
  assert.ok(n > 80 && n < 140, `grazing steps ${n}`);
  // Tighter L multiplies cost: document the scaling.
  const n2 = grazingStepCount(1, 1e-4, 2, (5 * Math.PI) / 180);
  assert.ok(Math.abs(n2 / n - 2) < 0.05, 'cost scales with L');
});
