import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tevEvaluate, polyChainWiring, stripFieldInputs, tevFit, psnr, rmse,
  type TevSpec, type TevContext, type TevSample,
} from '../src/material/tev.js';

// TEV functional material compression: a chain of K combiner stages
// C_out = (A - B) * C + D compresses a PBR material into closed-form math.
// Tests are the spec; the implementation must satisfy them.

// ---------------------------------------------------------------------------
// Reference material: procedural, ground truth exact. A spatially varying
// albedo (smoothstep in a noise field) times an ambient + clamped diffuse
// term. The clamp kink and the smoothstep shoulder are what the chain
// must earn with stages; no small-K chain matches them exactly.
// ---------------------------------------------------------------------------

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function referenceMaterial(ctx: TevContext): number {
  const rho = 0.35 + 0.65 * smoothstep(0.3, 0.7, ctx.noise);
  return rho * (0.15 + 0.85 * Math.max(ctx.ndl, 0));
}

function makeCtx(noise: number, ndl: number): TevContext {
  return { ndl, ndv: 0.8, ndh: 0.9, sdf: 0.5, noise };
}

/** Deterministic grid over (noise, ndl). No RNG anywhere. */
function gridSamples(nNoise: number, nNdl: number, noiseLo: number, noiseHi: number): TevSample[] {
  const out: TevSample[] = [];
  for (let i = 0; i < nNoise; i++) {
    const noise = noiseLo + ((i + 0.5) / nNoise) * (noiseHi - noiseLo);
    for (let j = 0; j < nNdl; j++) {
      const ndl = -1 + ((j + 0.5) / nNdl) * 2;
      const ctx = makeCtx(noise, ndl);
      out.push({ ctx, target: referenceMaterial(ctx) });
    }
  }
  return out;
}

function fitPsnr(spec: TevSpec, samples: TevSample[], theta0?: number[]) {
  const { consts, log } = tevFit(spec, samples, theta0);
  let se = 0;
  for (const s of samples) {
    const e = tevEvaluate(spec, consts, s.ctx) - s.target;
    se += e * e;
  }
  return { db: psnr(se / samples.length), iters: log.iterations, consts };
}

// Bars below are pinned from measured fit quality with margin; see docs/tev-materials.md.
const PSNR_BAR_DB = 20;      // K=8 chain must clear this
const EXTRAP_FACTOR = 4;     // held-out RMSE <= this multiple of train RMSE

// 1. Stage evaluator matches hand-computed values on fixed wirings.
test('tev evaluator: hand-computed single stage', () => {
  const spec: TevSpec = {
    numConsts: 3,
    stages: [{ a: { kind: 'const', constIndex: 0 }, b: { kind: 'const', constIndex: 1 }, c: { kind: 'ndl' }, d: { kind: 'const', constIndex: 2 } }],
  };
  const got = tevEvaluate(spec, [2, 1, 0.5], makeCtx(0.3, 0.6));
  assert.ok(Math.abs(got - 1.1) < 1e-12, `got ${got}, want 1.1`); // (2-1)*0.6+0.5
});

test('tev evaluator: two-stage chain threads prev through', () => {
  const spec: TevSpec = {
    numConsts: 2,
    stages: [
      { a: { kind: 'const', constIndex: 0 }, b: { kind: 'const', constIndex: 1 }, c: { kind: 'ndl' }, d: { kind: 'prev' } },
      { a: { kind: 'prev' }, b: { kind: 'const', constIndex: 0 }, c: { kind: 'noise' }, d: { kind: 'const', constIndex: 1 } },
    ],
  };
  // stage1: (3-1)*0.6 + 0 = 1.2 ; stage2: (1.2-3)*0.3 + 1 = 0.46
  const got = tevEvaluate(spec, [3, 1], makeCtx(0.3, 0.6));
  assert.ok(Math.abs(got - 0.46) < 1e-12, `got ${got}, want 0.46`);
});

// 2. Fit quality improves with K and clears the bar at K=8.
test('tev fit: PSNR improves with K and clears the bar', () => {
  const samples = gridSamples(21, 21, 0, 1);
  const r2 = fitPsnr(polyChainWiring(2), samples);
  const r4 = fitPsnr(polyChainWiring(4), samples);
  const r8 = fitPsnr(polyChainWiring(8), samples);
  assert.ok(r4.db > r2.db, `PSNR should improve: K=2 ${r2.db.toFixed(2)} dB, K=4 ${r4.db.toFixed(2)} dB`);
  assert.ok(r8.db > r4.db, `PSNR should improve: K=4 ${r4.db.toFixed(2)} dB, K=8 ${r8.db.toFixed(2)} dB`);
  assert.ok(r8.db >= PSNR_BAR_DB, `K=8 PSNR ${r8.db.toFixed(2)} dB < bar ${PSNR_BAR_DB} dB`);
});

// 3. Negative control: K=0 (constant output) MUST fail the PSNR bar.
test('tev negative control: constant output fails the bar', () => {
  const samples = gridSamples(21, 21, 0, 1);
  const mean = samples.reduce((a, s) => a + s.target, 0) / samples.length;
  let se = 0;
  for (const s of samples) se += (mean - s.target) * (mean - s.target);
  const db = psnr(se / samples.length);
  assert.ok(db < PSNR_BAR_DB, `constant fit PSNR ${db.toFixed(2)} dB should be below bar ${PSNR_BAR_DB} dB`);
});

// 4. Negative control: a wiring with no field structure MUST fail the bar.
// Proves the fit finds structure rather than the optimizer merely running.
test('tev negative control: field-stripped wiring fails the bar', () => {
  const samples = gridSamples(21, 21, 0, 1);
  const stripped = stripFieldInputs(polyChainWiring(8));
  const r = fitPsnr(stripped, samples);
  assert.ok(r.db < PSNR_BAR_DB, `stripped-wiring PSNR ${r.db.toFixed(2)} dB should be below bar ${PSNR_BAR_DB} dB`);
});

// 5. Extrapolation: held-out noise range stays within a stated multiple of train error.
test('tev extrapolation: unseen noise range generalizes', () => {
  const train = gridSamples(15, 21, 0, 0.7);
  const heldOut = gridSamples(7, 21, 0.7, 1.0);
  const spec = polyChainWiring(8);
  const { consts } = tevFit(spec, train);
  const err = (ss: TevSample[]) => rmse(ss.map(s => tevEvaluate(spec, consts, s.ctx)), ss.map(s => s.target));
  const trainErr = err(train), heldErr = err(heldOut);
  assert.ok(heldErr <= EXTRAP_FACTOR * trainErr,
    `held-out RMSE ${heldErr.toFixed(4)} > ${EXTRAP_FACTOR}x train RMSE ${trainErr.toFixed(4)}`);
});

// 6. Warm start converges in fewer iterations than a cold start.
test('tev fit: warm start beats cold start', () => {
  const spec = polyChainWiring(8);
  const base = gridSamples(15, 15, 0, 1);
  const cold = fitPsnr(spec, base);
  // Perturb the reference slightly (brighter ambient) and refit.
  const shifted = base.map(s => ({ ctx: s.ctx, target: s.target + 0.05 }));
  const warm = fitPsnr(spec, shifted, cold.consts);
  const cold2 = fitPsnr(spec, shifted);
  assert.ok(warm.iters < cold2.iters,
    `warm start ${warm.iters} iters should beat cold start ${cold2.iters} iters`);
});
