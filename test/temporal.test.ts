// test/temporal.test.ts - temporal stability, ported from
// docs/oracles/temporal_filtering.py.
//
// 1. EMA variance: Var(out)/sigma^2 = alpha/(2-alpha), N_eff=(2-alpha)/alpha
// 2. Ghosting behind a moving object: no clamp / min-max / variance clip
// 3. Clamp cost: residual noise on a static signal
// 4. Halton radical inverse (bases 2, 3)
// 5. Critically damped spring: two dt steps == one 2dt step
// 6. One Euro filter: adaptive cutoff
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pcg32 } from '../src/math/determinism.js';
import {
  halton, emaUpdate, effectiveSamples, clampMinMax, clampVariance,
  springStep, polyExpNeg, OneEuroFilter,
} from '../src/render/temporal.js';

function gaussian(g: Pcg32): number {
  // Box-Muller.
  let u = 0, v = 0;
  while (u === 0) u = g.unit();
  while (v === 0) v = g.unit();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

test('temporal: EMA variance ratio alpha/(2-alpha)', () => {
  for (const a of [0.05, 0.1, 0.3]) {
    const g = new Pcg32(3);
    const sigma = 0.2;
    let acc = 0;
    const out: number[] = [];
    for (let i = 0; i < 400000; i++) {
      acc = emaUpdate(sigma * gaussian(g), acc, a);
      if (i >= 2000) out.push(acc);
    }
    const mean = out.reduce((s, v) => s + v, 0) / out.length;
    const variance = out.reduce((s, v) => s + (v - mean) ** 2, 0) / out.length;
    const emp = variance / sigma ** 2;
    const formula = a / (2 - a);
    assert.ok(Math.abs(emp - formula) / formula < 0.02, `alpha=${a}: emp ${emp} vs ${formula}`);
    assert.ok(Math.abs(effectiveSamples(a) - (2 - a) / a) < 1e-12);
  }
});

const W = 160, T = 120, OBJ = 12, SPEED = 2, ALPHA = 0.1;

function ghostRun(clamp: 'none' | 'minmax' | 'varclip', gamma = 1.0): number {
  const g = new Pcg32(11);
  void g;
  const acc = new Array(W).fill(0);
  const errs: number[] = [];
  for (let t = 0; t < T; t++) {
    const truth = new Array(W).fill(0);
    const x0 = 10 + t * SPEED;
    if (x0 + OBJ < W) truth.fill(1, x0, x0 + OBJ);
    const cur = [...truth]; // no noise: pure ghosting measurement
    let hist = [...acc];
    if (clamp === 'minmax') hist = clampMinMax(hist, cur);
    else if (clamp === 'varclip') hist = clampVariance(hist, cur, gamma);
    for (let i = 0; i < W; i++) acc[i] = (1 - ALPHA) * hist[i] + ALPHA * cur[i];
    if (t > 20) {
      let sum = 0, n = 0;
      const end = Math.min(Math.max(x0 - 1, 0), W);
      for (let i = 5; i < end; i++) { sum += Math.abs(acc[i]); n++; }
      if (n > 0) errs.push(sum / n);
    }
  }
  return errs.reduce((s, v) => s + v, 0) / errs.length;
}

test('temporal: ghosting reduced by history clamping', () => {
  const none = ghostRun('none');
  const mm = ghostRun('minmax');
  const vc = ghostRun('varclip', 1.0);
  console.log(`    ghost: none=${none.toFixed(4)} minmax=${mm.toFixed(4)} varclip=${vc.toFixed(4)}`);
  // Oracle documents: 0.051 -> 0.000 / 0.003.
  assert.ok(none > 0.04, `no-clamp ghost ${none} should be large`);
  assert.ok(mm < 0.005, `minmax ghost ${mm} should be ~0`);
  assert.ok(vc < 0.01, `varclip ghost ${vc} should be small`);
});

function staticNoise(clamp: 'none' | 'minmax' | 'varclip', gamma = 1.0, sigma = 0.2): number {
  const g = new Pcg32(13);
  const acc = new Array(W).fill(0);
  const vals: number[] = [];
  for (let t = 0; t < 3000; t++) {
    const cur = Array.from({ length: W }, () => 0.5 + sigma * gaussian(g));
    let hist = [...acc];
    if (clamp === 'minmax') hist = clampMinMax(hist, cur);
    else if (clamp === 'varclip') hist = clampVariance(hist, cur, gamma);
    for (let i = 0; i < W; i++) acc[i] = (1 - ALPHA) * hist[i] + ALPHA * cur[i];
    if (t > 200) for (let i = 5; i < W - 5; i++) vals.push(acc[i] - 0.5);
  }
  const variance = vals.reduce((s, v) => s + v * v, 0) / vals.length;
  return Math.sqrt(variance);
}

test('temporal: clamp cost on static noise is documented', () => {
  const theory = 0.2 * Math.sqrt(ALPHA / (2 - ALPHA));
  const none = staticNoise('none');
  const mm = staticNoise('minmax');
  const vc = staticNoise('varclip', 1.0);
  console.log(`    static std: theory=${theory.toFixed(4)} none=${none.toFixed(4)} minmax=${mm.toFixed(4)} varclip=${vc.toFixed(4)}`);
  assert.ok(Math.abs(none - theory) / theory < 0.05, 'unclamped should reach theory');
  assert.ok(mm >= none * 0.9, 'clamp should not denoise better than theory');
});

test('temporal: Halton radical inverse', () => {
  const h2 = [1, 2, 3, 4].map(i => halton(i, 2));
  assert.deepEqual(h2, [0.5, 0.25, 0.75, 0.125]);
  // Base 3: 1/3, 2/3, 1/9, 4/9.
  assert.ok(Math.abs(halton(1, 3) - 1 / 3) < 1e-15);
  assert.ok(Math.abs(halton(2, 3) - 2 / 3) < 1e-15);
  assert.ok(Math.abs(halton(3, 3) - 1 / 9) < 1e-15);
});

test('temporal: critically damped spring, two dt steps == one 2dt step', () => {
  const w = 7.3;
  const [x1, v1] = springStep(1.0, -0.4, 0.2, w, 0.013);
  const [xa, va] = springStep(x1, v1, 0.2, w, 0.013);
  const [xb, vb] = springStep(1.0, -0.4, 0.2, w, 0.026);
  assert.ok(Math.abs(xa - xb) < 1e-14, `dx=${Math.abs(xa - xb)}`);
  assert.ok(Math.abs(va - vb) < 1e-14, `dv=${Math.abs(va - vb)}`);
});

test('temporal: polynomial exp replacement is accurate and deterministic', () => {
  // polyExpNeg approximates e^(-x) for x in [0, 2] (typical w*dt range).
  let worst = 0;
  for (let i = 0; i <= 200; i++) {
    const x = (i / 200) * 2;
    worst = Math.max(worst, Math.abs(polyExpNeg(x) - Math.exp(-x)));
  }
  assert.ok(worst < 1e-9, `worst poly exp err ${worst}`);
  // Deterministic: same input, same output, no platform exp involved.
  assert.equal(polyExpNeg(0.5), polyExpNeg(0.5));
  // Spring with polynomial exp stays close to exact.
  const [xp] = springStep(1.0, -0.4, 0.2, 7.3, 0.013, polyExpNeg);
  const [xe] = springStep(1.0, -0.4, 0.2, 7.3, 0.013, (x) => Math.exp(-x));
  assert.ok(Math.abs(xp - xe) < 1e-9);
});

test('temporal: One Euro filter adapts cutoff to speed', () => {
  const f = new OneEuroFilter({ minCutoff: 1.0, beta: 0.5, dCutoff: 1.0 });
  // Slow drift: heavy smoothing.
  let slow = 0;
  for (let i = 0; i < 200; i++) slow = f.update(0.001 * i, 0.016);
  const slowOut = slow;
  // Fast step: follows quickly.
  const f2 = new OneEuroFilter({ minCutoff: 1.0, beta: 0.5, dCutoff: 1.0 });
  for (let i = 0; i < 200; i++) f2.update(0, 0.016);
  const fastOut = f2.update(1.0, 0.016);
  assert.ok(slowOut < 0.2, `slow should be smoothed: ${slowOut}`);
  assert.ok(fastOut > 0.05, `fast step should pass: ${fastOut}`);
});
