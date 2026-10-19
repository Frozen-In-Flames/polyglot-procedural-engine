// test/change-detect.test.ts - v1.9.1: outlier-aware change detection.
//
// The honest experiment for the JIT change detector. The v1.8.1 trimmed-NIS
// default false-alarms on outliers at perfect prediction (plain z ~1900-5200;
// trimmed holds clutter but leaks specular: 7.2 alone, 29.6 on spec+clutter),
// and a false alarm forces a cold start where 30-55% of fits fail. Root cause
// (owner): the detector and the estimator disagree about what data is
// trustworthy. Three forms share the estimator's GM weights:
//
//   score-gm:    g = J^T W z, T = g^T (J^T W J)^{-1} g at the prediction,
//                W = GM redescending weights from predicted residuals.
//   score-huber: same statistic, Huber (monotone) weights for DETECTION only;
//                estimation stays redescending GM. Mechanism is coherence,
//                not magnitude: a jump pulls coherently and adds, clutter
//                pulls incoherently and cancels; Huber weights cannot vanish,
//                so the coherent pull survives big jumps.
//   wald:        T = dtheta^T V^{-1} dtheta at the robust solution,
//                dtheta = thetaSol - thetaPred, V = H^{-1} M H^{-1} sandwich
//                (M = Cov of the score), NOT naive H^{-1}.
//
// Bars: false-alarm rate nominal at the 99% threshold for the default form;
// power on true jumps; warm-start breakdown sweep recorded as a table;
// end-to-end track-loss (false alarm -> cold start -> lost track) is the
// acceptance metric, not z.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { irlsGnFit } from '../src/inverse/robust.js';
import {
  mulberry32,
  randn,
  sphereGrid,
  renderLambertN,
  jacLambertN,
  linearInitLight,
  nisChange,
} from '../src/inverse/jit.js';
import {
  detectChange,
  chi2isf99,
  DEFAULT_FORM,
  DetectForm,
} from '../src/inverse/changedetect.js';

const RHO = 0.7;
const SIG = 0.01;
const S2 = SIG * SIG;
const VIEW3 = [0, 0, 1];
const FORMS: DetectForm[] = ['score-gm', 'score-huber', 'wald'];

function makeRng(seed: number) {
  const rng = mulberry32(seed);
  return () => randn(rng);
}
function makeUniform(seed: number) {
  const rng = mulberry32(seed);
  return () => rng.next();
}
function median(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : 0.5 * (s[h - 1] + s[h]);
}

/** Oracle's make_image(): Lambertian + optional specular lobe + clutter. */
function makeImage(
  thTrue: number[],
  normals: number[][],
  specular: number,
  clutter: number,
  seed: number,
): number[] {
  const g = makeRng(seed);
  const uni = makeUniform(seed ^ 0x9e37);
  let y = renderLambertN(thTrue, normals, RHO).map((v) => v + SIG * g());
  if (specular > 0) {
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
      return v + specular * Math.pow(nh, 40);
    });
  }
  if (clutter > 0) {
    const side = Math.sqrt(clutter * Math.PI * 0.95 * 0.95);
    const cx = uni() * 1.2 - 0.6;
    const cy = uni() * 1.2 - 0.6;
    y = y.map((v, i) => {
      const n = normals[i];
      const inside =
        Math.abs(n[0] - cx) < side / 2 && Math.abs(n[1] - cy) < side / 2;
      return inside ? uni() + SIG * g() : v;
    });
  }
  return y.map((v) => Math.min(1, Math.max(0, v)));
}

function randTheta(uni: () => number): number[] {
  return [
    0.3 + 0.9 * uni(),
    0.2 + 0.6 * uni(),
    0.6 + 0.5 * uni(),
    0.05 + 0.15 * uni(),
  ];
}

function clamp4(th: number[]): void {
  th[2] = Math.max(th[2], 0.05);
  th[3] = Math.max(th[3], 0);
}

function failed4(e: number[]): boolean {
  return Math.hypot(e[0], e[1]) > 0.15 || Math.abs(e[2]) > 0.3 || Math.abs(e[3]) > 0.1;
}

const CONDS: Array<[string, number, number]> = [
  ['clean', 0, 0],
  ['clutter 15%', 0, 0.15],
  ['specular 0.6', 0.6, 0],
  ['spec 1.0 + clutter 25%', 1.0, 0.25],
];

// ---------------------------------------------------------------------------
// A. False-alarm rates at perfect prediction (no real change).
// ---------------------------------------------------------------------------

test('change-detect: false-alarm rates at perfect prediction', () => {
  // Calibration sanity: chi2(4) 99% = 13.277.
  assert.ok(Math.abs(chi2isf99(4) - 13.277) < 0.05, `chi2isf99(4) = ${chi2isf99(4)}`);
  const px = sphereGrid(64);
  const normals = px.normals;
  const R = (th: number[]) => renderLambertN(th, normals, RHO);
  const J = (th: number[]) => jacLambertN(th, normals, RHO);
  const trials = 40;
  const lines: string[] = [];
  for (const [name, sp, cl] of CONDS) {
    const row: string[] = [];
    for (const form of FORMS) {
      let alarms = 0;
      for (let tr = 0; tr < trials; tr++) {
        const uni = makeUniform(31100 + tr);
        const th = randTheta(uni);
        const y = makeImage(th, normals, sp, cl, 31200 + tr);
        const res = detectChange(y, th, R, J, S2, { form });
        assert.strictEqual(res.dof, 4, 'dof must be n_params');
        assert.strictEqual(res.form, form, 'form passthrough');
        if (res.alarm) alarms++;
      }
      const rate = alarms / trials;
      row.push(`${form}=${(100 * rate).toFixed(1)}%`);
      if (form === DEFAULT_FORM) {
        assert.ok(
          rate <= 0.05,
          `default form false-alarms ${(100 * rate).toFixed(1)}% on ${name} (nominal 1%)`,
        );
      }
    }
    lines.push(`      ${name.padEnd(24)} ${row.join('  ')}`);
  }
  console.log('      false-alarm % at 99% threshold, perfect prediction:\n' + lines.join('\n'));
});

// ---------------------------------------------------------------------------
// B. Detection power on true scene jumps, with and without dirt.
// ---------------------------------------------------------------------------

test('change-detect: power on true jumps', () => {
  const px = sphereGrid(64);
  const normals = px.normals;
  const R = (th: number[]) => renderLambertN(th, normals, RHO);
  const J = (th: number[]) => jacLambertN(th, normals, RHO);
  const jumps = [0.1, 0.3, 0.8];
  const conds: Array<[string, number, number]> = [
    ['clean', 0, 0],
    ['clutter 15%', 0, 0.15],
    ['specular 0.6', 0.6, 0],
  ];
  const trials = 30;
  const lines: string[] = [];
  for (const dj of jumps) {
    for (const [name, sp, cl] of conds) {
      const row: string[] = [];
      for (const form of FORMS) {
        let hits = 0;
        for (let tr = 0; tr < trials; tr++) {
          const uni = makeUniform(32100 + tr);
          const th = randTheta(uni);
          const thJ = th.slice();
          thJ[0] += dj;
          const y = makeImage(thJ, normals, sp, cl, 32200 + tr);
          const res = detectChange(y, th, R, J, S2, { form });
          if (res.alarm) hits++;
        }
        const power = hits / trials;
        row.push(`${form}=${(100 * power).toFixed(0)}%`);
        if (form === DEFAULT_FORM && dj === 0.3 && name === 'clean') {
          assert.ok(power >= 0.8, `default form power ${(100 * power).toFixed(0)}% on clean 0.3 rad jump`);
        }
        if (form === DEFAULT_FORM && dj === 0.3 && name !== 'clean') {
          assert.ok(power >= 0.5, `default form power ${(100 * power).toFixed(0)}% on ${name} 0.3 rad jump`);
        }
      }
      lines.push(`      jump ${dj.toFixed(1)} ${name.padEnd(14)} ${row.join('  ')}`);
    }
  }
  console.log('      power % at 99% threshold:\n' + lines.join('\n'));
});

// ---------------------------------------------------------------------------
// C. Warm-start breakdown sweep: grow the jump until each form goes blind.
// The breakdown point is the power boundary, not a bug to patch.
// ---------------------------------------------------------------------------

test('change-detect: warm-start breakdown sweep', () => {
  const px = sphereGrid(64);
  const normals = px.normals;
  const R = (th: number[]) => renderLambertN(th, normals, RHO);
  const J = (th: number[]) => jacLambertN(th, normals, RHO);
  const deltas = [0.2, 0.5, 1.0, 1.5, 2.0];
  const trials = 30;
  const lines: string[] = ['      jump | ' + FORMS.map((f) => f.padStart(11)).join(' ')];
  const breakdown = new Map<DetectForm, string>();
  let maxPower02 = 0;
  for (const form of FORMS) {
    let bp = 'none in range';
    const powers: number[] = [];
    for (const dj of deltas) {
      let hits = 0;
      for (let tr = 0; tr < trials; tr++) {
        const uni = makeUniform(33100 + tr);
        const th = randTheta(uni);
        const thJ = th.slice();
        thJ[0] += dj;
        const y = makeImage(thJ, normals, 0, 0, 33200 + tr);
        if (detectChange(y, th, R, J, S2, { form }).alarm) hits++;
      }
      const power = hits / trials;
      powers.push(power);
      if (bp === 'none in range' && power < 0.5) bp = `~${dj.toFixed(1)} rad`;
      if (dj === 0.2) {
        maxPower02 = Math.max(maxPower02, power);
      }
    }
    breakdown.set(form, bp);
    void powers;
  }
  // Recompute per-delta rows for the printed table.
  for (const dj of deltas) {
    const row: string[] = [];
    for (const form of FORMS) {
      let hits = 0;
      for (let tr = 0; tr < trials; tr++) {
        const uni = makeUniform(33100 + tr);
        const th = randTheta(uni);
        const thJ = th.slice();
        thJ[0] += dj;
        const y = makeImage(thJ, normals, 0, 0, 33200 + tr);
        if (detectChange(y, th, R, J, S2, { form }).alarm) hits++;
      }
      row.push(`${(100 * hits / trials).toFixed(0)}%`.padStart(11));
    }
    lines.push(`      ${dj.toFixed(1).padStart(4)} | ${row.join(' ')}`);
  }
  lines.push(
    '      breakdown (power < 50%): ' +
      FORMS.map((f) => `${f}=${breakdown.get(f)}`).join('  '),
  );
  // Non-vacuous: at least one form must detect the small jump well.
  assert.ok(maxPower02 >= 0.8, `no form detects a 0.2 rad jump (best ${(100 * maxPower02).toFixed(0)}%); check is vacuous`);
  console.log(lines.join('\n'));
});

// ---------------------------------------------------------------------------
// D. End-to-end acceptance: false alarm -> forced cold start -> track loss.
// This rate, not z, is the acceptance criterion.
// ---------------------------------------------------------------------------

test('change-detect: end-to-end track-loss rate under dirt', () => {
  const px = sphereGrid(64);
  const normals = px.normals;
  const R = (th: number[]) => renderLambertN(th, normals, RHO);
  const J = (th: number[]) => jacLambertN(th, normals, RHO);
  const P = [0, 1, 2, 3].map((i, _, a) => a.map((_, j) => (i === j ? 0.03 * 0.03 : 0)));
  const trials = 40;
  let lost = 0;
  let oldAlarms = 0;
  for (let tr = 0; tr < trials; tr++) {
    const uni = makeUniform(34100 + tr);
    const th = randTheta(uni);
    const y = makeImage(th, normals, 1.0, 0.25, 34200 + tr);
    // Legacy trimmed-NIS behavior on the same frame, for the report line.
    if (nisChange(y, th, P, R, J, S2, 3).z > 6) oldAlarms++;
    const res = detectChange(y, th, R, J, S2, { form: DEFAULT_FORM });
    if (res.alarm) {
      const th0 = linearInitLight(y, px, RHO);
      const fit = irlsGnFit(y, th0, R, J, { kind: 'gm', c: 3.0, clamp: clamp4, sigmaFloor: SIG });
      if (failed4(fit.theta.map((v, j) => v - th[j]))) lost++;
    }
  }
  const lossRate = lost / trials;
  console.log(
    `      default form (${DEFAULT_FORM}): track-loss ${(100 * lossRate).toFixed(1)}% ` +
      `(${lost}/${trials}); legacy trimmed-NIS false-alarms ${(100 * oldAlarms / trials).toFixed(1)}% on the same frames`,
  );
  assert.ok(lossRate <= 0.05, `track-loss rate ${(100 * lossRate).toFixed(1)}% too high`);
});
