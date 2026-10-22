// test/wald-basin.test.ts - v2.0.4: Wald basin re-map on harder scenes.
//
// docs/change-detection.md (v1.9.1) left one named debt: "Wald inherits
// the estimator's basin... map it again on harder scenes." This file is
// that map. It extends the v1.9.1 scene generator along the factors that
// killed the earlier methods (specular strength and lobe sharpness,
// clutter density, clutter asymmetry: one-sided offsets instead of the
// legacy value replacement) and measures the DEFAULT detector (wald,
// sandwich covariance, chi2 99% threshold, nominal false-alarm rate 1%)
// on a grid of scene regime x azimuth jump magnitude, with a matched
// no-change false-alarm measurement at every regime. Seeded throughout;
// no wall-clock assertions.
//
// What the map found (pre-fix configuration, GM c = 3.0): every regime
// held nominal false alarms except the combined worst case (specular
// 1.5 + 40% one-sided bright clutter), where the Wald fit roamed into
// the dirt basin and false-alarmed 31/60 = 52%. Tightening the Wald
// form's GM constant to WALD_GM_C = 1.2 (fit and sandwich; the score
// forms keep c = 3.0) closed the hole and moved the 90% detection
// boundary from 0.3 to 0.2 rad. Both configurations are pinned below:
// the c = 3.0 hole must still reproduce, or the map has gone blind.
//
// Negative controls:
// - No-change scenes at every grid regime must hold the false-alarm
//   rate within the exact binomial tolerance of the 1% operating point.
// - Naive covariance (V = H^-1 instead of the sandwich) must degrade on
//   the asymmetric-clutter regimes: that is the doc's stated reason the
//   sandwich exists. Measured: its detection at 0.3 rad collapses.
// - Sign-flipped jumps must be detected at the same rate as positive
//   jumps: the Wald statistic is quadratic in dtheta, so the design is
//   magnitude-based, not directional (docs/change-detection.md).
// - Residual shuffle (permuted residuals re-based on the prediction):
//   the generic expectation is that destroying spatial coherence
//   collapses detection to the false-alarm rate. MEASURED EXCEPTION,
//   pinned as such below: it does not collapse for any of the three
//   forms on this scene family. A permuted residual field keeps its
//   marginal distribution, and the Jacobian columns have nonzero spatial
//   means (the ambient column is constant), so marginal skew alone
//   projects coherently onto the parameter directions; the permuted
//   null stays at the false-alarm rate, the permuted change does not
//   fall. The control is run and pinned so a future change to this
//   behavior is a deliberate, documented event, not a silent drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32,
  randn,
  sphereGrid,
  renderLambertN,
  jacLambertN,
} from '../src/inverse/jit.js';
import {
  detectChange,
  WALD_GM_C,
  DEFAULT_FORM,
} from '../src/inverse/changedetect.js';

const RHO = 0.7;
const SIG = 0.01;
const S2 = SIG * SIG;
const VIEW3 = [0, 0, 1];

function makeRng(seed: number) {
  const rng = mulberry32(seed);
  return () => randn(rng);
}
function makeUniform(seed: number) {
  const rng = mulberry32(seed);
  return () => rng.next();
}
function randTheta(uni: () => number): number[] {
  return [
    0.3 + 0.9 * uni(),
    0.2 + 0.6 * uni(),
    0.6 + 0.5 * uni(),
    0.05 + 0.15 * uni(),
  ];
}

interface Regime {
  name: string;
  spec: number;
  pow: number;
  cl: number;
  mode: 'legacy' | 'sym' | 'pos' | 'neg';
}

/**
 * Extended scene generator. Same base as the v1.9.1 oracle (Lambertian
 * sphere + Blinn-Phong lobe + square clutter patch, clamped to [0, 1]),
 * with two knobs the bake-off did not have: the lobe exponent (sharper
 * specular) and the clutter mode. 'legacy' replaces patch pixels with
 * U[0, 1) values (the v1.9.1 form); 'sym' adds a signed offset
 * +/-U[0.3, 0.9]; 'pos' / 'neg' add a one-sided offset of the same
 * magnitude distribution, which isolates asymmetry at fixed density.
 */
function makeImage2(
  thTrue: number[],
  normals: number[][],
  reg: Regime,
  seed: number,
): number[] {
  const g = makeRng(seed);
  const uni = makeUniform(seed ^ 0x9e37);
  let y = renderLambertN(thTrue, normals, RHO).map((v) => v + SIG * g());
  if (reg.spec > 0) {
    const l = [
      Math.cos(thTrue[1]) * Math.sin(thTrue[0]),
      Math.sin(thTrue[1]),
      Math.cos(thTrue[1]) * Math.cos(thTrue[0]),
    ];
    let hx = l[0] + VIEW3[0];
    let hy = l[1] + VIEW3[1];
    let hz = l[2] + VIEW3[2];
    const hl = Math.hypot(hx, hy, hz) || 1;
    hx /= hl; hy /= hl; hz /= hl;
    y = y.map((v, i) => {
      const n = normals[i];
      const nl = n[0] * l[0] + n[1] * l[1] + n[2] * l[2];
      if (nl <= 0) return v;
      const nh = Math.max(n[0] * hx + n[1] * hy + n[2] * hz, 0);
      return v + reg.spec * Math.pow(nh, reg.pow);
    });
  }
  if (reg.cl > 0) {
    const side = Math.sqrt(reg.cl * Math.PI * 0.95 * 0.95);
    const cx = uni() * 1.2 - 0.6;
    const cy = uni() * 1.2 - 0.6;
    y = y.map((v, i) => {
      const n = normals[i];
      const inside =
        Math.abs(n[0] - cx) < side / 2 && Math.abs(n[1] - cy) < side / 2;
      if (!inside) return v;
      if (reg.mode === 'legacy') return uni() + SIG * g();
      const mag = 0.3 + 0.6 * uni();
      const d =
        reg.mode === 'pos'
          ? mag
          : reg.mode === 'neg'
            ? -mag
            : uni() < 0.5
              ? -mag
              : mag;
      return v + d;
    });
  }
  return y.map((v) => Math.min(1, Math.max(0, v)));
}

const REGIMES: Regime[] = [
  { name: 'clean',           spec: 0,   pow: 40,  cl: 0,    mode: 'legacy' },
  { name: 'spec-1.0',        spec: 1.0, pow: 40,  cl: 0,    mode: 'legacy' },
  { name: 'spec-sharp-1.5',  spec: 1.5, pow: 120, cl: 0,    mode: 'legacy' },
  { name: 'clutter-40-sym',  spec: 0,   pow: 40,  cl: 0.40, mode: 'sym' },
  { name: 'clutter-25-asym', spec: 0,   pow: 40,  cl: 0.25, mode: 'pos' },
  { name: 'clutter-40-asym', spec: 0,   pow: 40,  cl: 0.40, mode: 'pos' },
  { name: 'clutter-25-dark', spec: 0,   pow: 40,  cl: 0.25, mode: 'neg' },
  { name: 'spec+asym-worst', spec: 1.5, pow: 40,  cl: 0.40, mode: 'pos' },
];
const ASYM_REGIMES = [4, 5, 6]; // clutter-25-asym, clutter-40-asym, clutter-25-dark
const JUMPS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.8];
const EXTENDED = new Set(['clean', 'clutter-40-asym', 'spec+asym-worst']);

/** Largest alarm count k with P(X > k | n, p) <= tail, exact binomial. */
function maxAlarms(n: number, p: number, tail: number): number {
  let pmf = Math.pow(1 - p, n);
  let cdf = pmf;
  for (let k = 0; k < n; k++) {
    if (1 - cdf <= tail) return k;
    pmf *= ((n - k) / (k + 1)) * (p / (1 - p));
    cdf += pmf;
  }
  return n;
}

const px = sphereGrid(64);
const normals = px.normals;
const R = (th: number[]) => renderLambertN(th, normals, RHO);
const J = (th: number[]) => jacLambertN(th, normals, RHO);
const wald = (
  y: number[],
  th: number[],
  extra?: object,
): boolean =>
  detectChange(y, th, R, J, S2, { form: 'wald', ...extra }).alarm;

/** No-change alarm count for a regime on the FA seed family. */
function faCount(ri: number, trials: number, extra?: object): number {
  const reg = REGIMES[ri];
  let alarms = 0;
  for (let tr = 0; tr < trials; tr++) {
    const th = randTheta(makeUniform(51000 + ri * 1000 + tr));
    const y = makeImage2(th, normals, reg, 52000 + ri * 1000 + tr);
    if (wald(y, th, extra)) alarms++;
  }
  return alarms;
}

/** Detection count for (regime, jump) on the power seed family. */
function powerCount(
  ri: number,
  ji: number,
  dj: number,
  trials: number,
  extra?: object,
  sign = 1,
): number {
  const reg = REGIMES[ri];
  let hits = 0;
  for (let tr = 0; tr < trials; tr++) {
    const th = randTheta(makeUniform(53000 + ri * 10000 + ji * 100 + tr));
    const thJ = th.slice();
    thJ[0] += sign * dj;
    const y = makeImage2(thJ, normals, reg, 54000 + ri * 10000 + ji * 100 + tr);
    if (wald(y, th, extra)) hits++;
  }
  return hits;
}

// ---------------------------------------------------------------------------
// A. False alarms at the operating point, every regime, post-fix config.
// ---------------------------------------------------------------------------

test('wald basin: false alarms hold at the 1% operating point in every regime', () => {
  assert.strictEqual(DEFAULT_FORM, 'wald', 'basin map is for the default form');
  assert.strictEqual(WALD_GM_C, 1.2, 'Wald GM tuning pinned by the basin map');
  const trials = 100;
  const bound = maxAlarms(trials, 0.01, 0.001);
  const lines: string[] = [];
  REGIMES.forEach((reg, ri) => {
    const alarms = faCount(ri, trials);
    lines.push(`      ${reg.name.padEnd(16)} alarms ${alarms}/${trials}`);
    assert.ok(
      alarms <= bound,
      `${reg.name}: ${alarms}/${trials} false alarms exceeds the binomial ` +
        `tolerance (${bound}) of the 1% operating point`,
    );
  });
  console.log(
    `      false alarms at the 99% threshold, no-change scenes (bound ${bound}/${trials}):\n` +
      lines.join('\n'),
  );
});

// ---------------------------------------------------------------------------
// B. The pre-fix hole must still reproduce (the map can still see it).
// ---------------------------------------------------------------------------

test('wald basin: pre-fix tuning (c = 3.0) still shows the combined-dirt hole', () => {
  const ri = REGIMES.findIndex((r) => r.name === 'spec+asym-worst');
  const trials = 60;
  const alarms = faCount(ri, trials, { c: 3.0 });
  console.log(
    `      spec+asym-worst false alarms at c = 3.0: ${alarms}/${trials} ` +
      `(post-fix config: see test A)`,
  );
  assert.ok(
    alarms / trials >= 0.25,
    `expected the c = 3.0 hole (measured 52%) to reproduce, got ${alarms}/${trials}; ` +
      'the map or the generator has changed',
  );
});

// ---------------------------------------------------------------------------
// C. Fresh-seed generalization: the fix is not tuned to the map's seeds.
// ---------------------------------------------------------------------------

test('wald basin: worst-regime false alarms hold on held-out seeds', () => {
  const reg = REGIMES[REGIMES.findIndex((r) => r.name === 'spec+asym-worst')];
  const trials = 100;
  const bound = maxAlarms(trials, 0.01, 0.001);
  let alarms = 0;
  for (let tr = 0; tr < trials; tr++) {
    const th = randTheta(makeUniform(91000 + tr));
    const y = makeImage2(th, normals, reg, 92000 + tr);
    if (wald(y, th)) alarms++;
  }
  console.log(`      spec+asym-worst, held-out seeds: alarms ${alarms}/${trials}`);
  assert.ok(
    alarms <= bound,
    `held-out seeds: ${alarms}/${trials} false alarms exceeds bound ${bound}`,
  );
});

// ---------------------------------------------------------------------------
// D. The detection map: power over jump magnitude in every regime.
// ---------------------------------------------------------------------------

test('wald basin: detection boundary is 0.2 rad in every regime', () => {
  const trials = 40;
  const lines: string[] = ['      regime           ' + JUMPS.map((d) => d.toFixed(2).padStart(6)).join('') + '   1.20  1.60'];
  REGIMES.forEach((reg, ri) => {
    const jumps = EXTENDED.has(reg.name) ? [...JUMPS, 1.2, 1.6] : JUMPS;
    const rates: number[] = [];
    jumps.forEach((dj, ji) => {
      rates.push(powerCount(ri, ji, dj, trials) / trials);
    });
    lines.push(
      `      ${reg.name.padEnd(16)} ` +
        rates.map((r) => `${(100 * r).toFixed(0)}%`.padStart(6)).join(''),
    );
    console.log(lines[lines.length - 1]);
    const at = (dj: number) => rates[jumps.indexOf(dj)];
    // Blind floor: sub-0.1 rad jumps are the warm-start tracker's job.
    // The 0.1 rad ceiling is asserted on the clean regime only: dirt
    // regimes can legitimately exceed it, because the unmodeled
    // specular lobe moves with the light and adds change energy on top
    // of the Lambertian change (spec+asym-worst measures 70% at 0.1 rad
    // while holding 3/100 false alarms; that is sensitivity, not
    // miscalibration, and the map reports it instead of pinning it away).
    assert.ok(at(0.05) <= 0.1, `${reg.name}: power ${(100 * at(0.05)).toFixed(0)}% at 0.05 rad, expected <= 10%`);
    if (reg.name === 'clean') {
      assert.ok(at(0.1) <= 0.45, `${reg.name}: power ${(100 * at(0.1)).toFixed(0)}% at 0.1 rad, expected <= 45%`);
    }
    // The boundary claim: >= 90% detection at 0.2 rad (85% asserted,
    // one trial of Monte Carlo slack on the pinned seeds).
    assert.ok(at(0.2) >= 0.85, `${reg.name}: power ${(100 * at(0.2)).toFixed(0)}% at 0.2 rad, expected >= 85%`);
    assert.ok(at(0.3) >= 0.925, `${reg.name}: power ${(100 * at(0.3)).toFixed(0)}% at 0.3 rad, expected >= 92.5%`);
    // No warm-start trapping: power never falls as the jump grows past
    // the boundary, out to 1.6 rad where swept.
    assert.ok(
      at(0.8) >= at(0.3) - 0.05,
      `${reg.name}: power falls from ${(100 * at(0.3)).toFixed(0)}% at 0.3 to ${(100 * at(0.8)).toFixed(0)}% at 0.8 rad (trapping?)`,
    );
    if (EXTENDED.has(reg.name)) {
      assert.ok(at(1.6) >= 0.95, `${reg.name}: power ${(100 * at(1.6)).toFixed(0)}% at 1.6 rad, expected >= 95%`);
    }
  });
  console.log('      detection % by azimuth jump (rad):\n' + lines.join('\n'));
});

// ---------------------------------------------------------------------------
// E. Negative control: naive covariance must degrade on asymmetric clutter.
// ---------------------------------------------------------------------------

test('wald basin: naive covariance collapses on asymmetric clutter (sandwich control)', () => {
  const trials = 40;
  const ji = JUMPS.indexOf(0.3);
  const lines: string[] = [];
  for (const ri of ASYM_REGIMES) {
    const reg = REGIMES[ri];
    const sandwich = powerCount(ri, ji, 0.3, trials) / trials;
    const naive = powerCount(ri, ji, 0.3, trials, { covariance: 'naive' }) / trials;
    lines.push(
      `      ${reg.name.padEnd(16)} power at 0.3 rad: sandwich ${(100 * sandwich).toFixed(0)}%  naive ${(100 * naive).toFixed(0)}%`,
    );
    assert.ok(sandwich >= 0.925, `${reg.name}: sandwich power ${(100 * sandwich).toFixed(0)}% at 0.3 rad`);
    assert.ok(
      naive <= 0.4,
      `${reg.name}: naive-covariance power ${(100 * naive).toFixed(0)}% at 0.3 rad should collapse (measured 23-30%); ` +
        'the sandwich-vs-naive contrast is gone',
    );
  }
  console.log(lines.join('\n'));
});

// ---------------------------------------------------------------------------
// F. Negative control: sign-flipped jumps (the statistic is quadratic).
// ---------------------------------------------------------------------------

test('wald basin: sign-flipped jumps are detected symmetrically', () => {
  const trials = 40;
  const ji = JUMPS.indexOf(0.3);
  for (const ri of [0, 3, 4]) {
    const reg = REGIMES[ri];
    const pos = powerCount(ri, ji, 0.3, trials) / trials;
    const neg = powerCount(ri, ji, 0.3, trials, undefined, -1) / trials;
    console.log(
      `      ${reg.name.padEnd(16)} power at +0.3: ${(100 * pos).toFixed(0)}%  at -0.3: ${(100 * neg).toFixed(0)}%`,
    );
    assert.ok(neg >= 0.9, `${reg.name}: power ${(100 * neg).toFixed(0)}% at -0.3 rad, expected >= 90%`);
    assert.ok(
      Math.abs(neg - pos) <= 0.125,
      `${reg.name}: sign asymmetry ${(100 * Math.abs(neg - pos)).toFixed(0)} points between -0.3 and +0.3 rad`,
    );
  }
});

// ---------------------------------------------------------------------------
// G. Residual-shuffle control: measured exception, pinned (see header).
// ---------------------------------------------------------------------------

test('wald basin: residual shuffle does not collapse wald (documented exception)', () => {
  const trials = 40;
  const ji = JUMPS.indexOf(0.3);
  const permutedResidual = (y: number[], thPred: number[], seed: number): number[] => {
    const Rp = R(thPred);
    const res = y.map((v, j) => v - Rp[j]);
    const uni = makeUniform(seed);
    const idx = res.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(uni() * (i + 1));
      const tmp = idx[i];
      idx[i] = idx[j];
      idx[j] = tmp;
    }
    return Rp.map((v, j) => v + res[idx[j]]);
  };
  for (const ri of [0, 4, 7]) {
    const reg = REGIMES[ri];
    let plain = 0;
    let shufChange = 0;
    let shufNull = 0;
    for (let tr = 0; tr < trials; tr++) {
      const th = randTheta(makeUniform(53000 + ri * 10000 + ji * 100 + tr));
      const thJ = th.slice();
      thJ[0] += 0.3;
      const yC = makeImage2(thJ, normals, reg, 54000 + ri * 10000 + ji * 100 + tr);
      const yN = makeImage2(th, normals, reg, 54000 + ri * 10000 + ji * 100 + tr);
      if (wald(yC, th)) plain++;
      if (wald(permutedResidual(yC, th, 888000 + tr), th)) shufChange++;
      if (wald(permutedResidual(yN, th, 888000 + tr), th)) shufNull++;
    }
    console.log(
      `      ${reg.name.padEnd(16)} at 0.3 rad: plain ${plain}/${trials}  ` +
        `shuffled-change ${shufChange}/${trials}  shuffled-null ${shufNull}/${trials}`,
    );
    assert.ok(plain / trials >= 0.925, `${reg.name}: unshuffled power should be >= 92.5%`);
    // The permuted null stays at the false-alarm rate: the shuffle
    // itself manufactures no alarms.
    assert.ok(shufNull <= 2, `${reg.name}: shuffled-null alarms ${shufNull}/${trials}, expected <= 2`);
    // The pinned exception: the shuffled change does NOT collapse
    // (measured 0.45-0.9 across regimes). If a future detector change
    // makes it collapse, that is an improvement to document here, not
    // a silent pass: this assertion failing is the notification.
    assert.ok(
      shufChange / trials >= 0.4,
      `${reg.name}: shuffled-change detection ${(100 * shufChange / trials).toFixed(0)}% fell below the pinned ` +
        'exception band; update the v2.0.4 shuffle finding in docs/change-detection.md',
    );
  }
});
