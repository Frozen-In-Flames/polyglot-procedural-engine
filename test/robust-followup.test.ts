// test/robust-followup.test.ts - v1.8.1: port of
// docs/oracles/test_robust_followup.py (the owner's follow-up to the
// robust-cost head-to-head). Three checks: (a) GM statistical efficiency vs
// tightness c on clean noise; (b) hardest condition, near starts, GM by c;
// (c) NIS change detector under outliers at perfect prediction, plain vs
// trimmed residuals. Trial counts: (a) 100, (b) 48, (c) 50/condition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { irlsGnFit } from '../src/inverse/robust.js';
import {
  nisChange,
  mulberry32,
  randn,
  sphereGrid,
  renderLambertN,
  jacLambertN,
} from '../src/inverse/jit.js';

const RHO = 0.7;
const SIG = 0.01;
const VIEW3 = [0, 0, 1];

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

/** Oracle's make_image(): Lambertian + optional Blinn-Phong specular lobe and clutter rectangle. */
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

/** Oracle's rand_theta(). */
function randTheta(uni: () => number): number[] {
  return [
    0.3 + 0.9 * uni(),
    0.2 + 0.6 * uni(),
    0.6 + 0.5 * uni(),
    0.05 + 0.15 * uni(),
  ];
}

/** Oracle's near-start perturbation, spread [0.05, 0.05, 0.1, 0.03]. */
function nearStart(thTrue: number[], g: () => number): number[] {
  const spread = [0.05, 0.05, 0.1, 0.03];
  const th0 = thTrue.map((v, j) => v + spread[j] * g());
  th0[2] = Math.max(th0[2], 0.2);
  th0[3] = Math.max(th0[3], 0);
  return th0;
}

function clamp4(th: number[]): void {
  th[2] = Math.max(th[2], 0.05);
  th[3] = Math.max(th[3], 0);
}

/** Oracle's failure rule on (az, el, I, A). */
function failed4(e: number[]): boolean {
  return Math.hypot(e[0], e[1]) > 0.15 || Math.abs(e[2]) > 0.3 || Math.abs(e[3]) > 0.1;
}

function fitGm(
  y: number[],
  th0: number[],
  normals: number[][],
  c: number,
): number[] {
  const { theta } = irlsGnFit(
    y,
    th0,
    (th) => renderLambertN(th, normals, RHO),
    (th) => jacLambertN(th, normals, RHO),
    { kind: 'gm', c, clamp: clamp4, sigmaFloor: SIG },
  );
  return theta;
}

// ---------------------------------------------------------------------------
// (a) GM statistical efficiency vs tightness c on CLEAN noise, near starts.
// RMS error ratio vs l2 per parameter; characterizes what robustness costs
// when the data is clean (oracle part (a), 100 trials here vs 300 there).
// ---------------------------------------------------------------------------

test('robust-followup: GM efficiency vs tightness c on clean noise', () => {
  const px = sphereGrid(64);
  const normals = px.normals;
  const trials = 100;
  const cs = [1.0, 1.5, 3.0, 6.0];
  const errsL2: number[][] = [];
  const errsGm = new Map<number, number[][]>();
  for (const c of cs) errsGm.set(c, []);
  for (let tr = 0; tr < trials; tr++) {
    const uni = makeUniform(21000 + tr);
    const thTrue = randTheta(uni);
    const y = makeImage(thTrue, normals, 0, 0, 21100 + tr);
    const th0 = nearStart(thTrue, makeRng(21200 + tr));
    const eL2 = irlsGnFit(
      y,
      th0,
      (th) => renderLambertN(th, normals, RHO),
      (th) => jacLambertN(th, normals, RHO),
      { kind: 'l2', clamp: clamp4, sigmaFloor: SIG },
    ).theta.map((v, j) => v - thTrue[j]);
    errsL2.push(eL2);
    for (const c of cs) {
      const e = fitGm(y, th0, normals, c).map((v, j) => v - thTrue[j]);
      errsGm.get(c)!.push(e);
    }
  }
  const rms = (E: number[][]) =>
    [0, 1, 2, 3].map((j) =>
      Math.sqrt(E.reduce((s, e) => s + e[j] * e[j], 0) / E.length),
    );
  const base = rms(errsL2);
  const ratios = new Map<number, number[]>();
  const lines: string[] = [];
  for (const c of cs) {
    const r = rms(errsGm.get(c)!).map((v, j) => v / base[j]);
    ratios.set(c, r);
    lines.push(
      `      GM c=${c.toFixed(1).padStart(4)}: ` +
        r.map((v) => v.toFixed(2).padStart(5)).join(' '),
    );
  }
  console.log('      RMS error ratio vs l2 per (az, el, I, A):\n' + lines.join('\n'));
  // Tight GM redescends on clean-data residuals too (|u| > 1 is ~32% of
  // Gaussian draws), so it costs real efficiency; loose GM barely
  // downweights anything and sits at l2 efficiency. Measured (100 trials):
  // c=1.0: 1.35-1.68, c=1.5: 1.11-1.34, c=3.0: 0.99-1.06, c=6.0: 0.99-1.01.
  for (const r of ratios.get(6.0)!) {
    assert.ok(r < 1.15, `c=6.0 ratio ${r.toFixed(3)} too far from l2`);
  }
  for (const r of ratios.get(3.0)!) {
    assert.ok(r < 1.15, `c=3.0 ratio ${r.toFixed(3)} costs measurable efficiency`);
  }
  for (const r of ratios.get(1.0)!) {
    assert.ok(r > 1.2, `c=1.0 ratio ${r.toFixed(3)} unexpectedly cheap`);
  }
  for (const r of ratios.get(1.5)!) {
    assert.ok(r > 1.0 && r < 1.4, `c=1.5 ratio ${r.toFixed(3)} out of band`);
  }
  // Efficiency improves monotonically as c loosens.
  const mean = (rs: number[]) => rs.reduce((s, v) => s + v, 0) / rs.length;
  const m1 = mean(ratios.get(1.0)!);
  const m15 = mean(ratios.get(1.5)!);
  const m3 = mean(ratios.get(3.0)!);
  assert.ok(m1 > m15 + 0.05 && m15 > m3 + 0.05, `efficiency not monotonic in c: ${m1.toFixed(2)} ${m15.toFixed(2)} ${m3.toFixed(2)}`);
});

// ---------------------------------------------------------------------------
// (b) Hardest condition (specular 1.0 + clutter 25%), NEAR starts, direct GM
// by c, Huber for reference. Completes the c-sensitivity picture v1.7.0
// started from far starts (oracle part (b), 48 trials here vs 200 there).
// ---------------------------------------------------------------------------

test('robust-followup: hardest condition near starts, GM by c', () => {
  const px = sphereGrid(64);
  const normals = px.normals;
  const trials = 48;
  const rows: string[] = [];
  const failBy = new Map<string, number>();
  const azBy = new Map<string, number>();
  const methods: Array<{ name: string; c: number | null }> = [
    { name: 'huber', c: null },
    { name: 'gm c=1.0', c: 1.0 },
    { name: 'gm c=1.5', c: 1.5 },
    { name: 'gm c=3.0', c: 3.0 },
  ];
  for (const m of methods) {
    let nf = 0;
    const azE: number[] = [];
    const iE: number[] = [];
    for (let tr = 0; tr < trials; tr++) {
      const uni = makeUniform(22100 + tr);
      const thTrue = randTheta(uni);
      const y = makeImage(thTrue, normals, 1.0, 0.25, 22200 + tr);
      const th0 = nearStart(thTrue, makeRng(22300 + tr));
      const theta =
        m.c === null
          ? irlsGnFit(
              y,
              th0,
              (th) => renderLambertN(th, normals, RHO),
              (th) => jacLambertN(th, normals, RHO),
              { kind: 'huber', clamp: clamp4, sigmaFloor: SIG },
            ).theta
          : fitGm(y, th0, normals, m.c);
      const e = theta.map((v, j) => v - thTrue[j]);
      if (failed4(e)) nf++;
      azE.push(Math.abs(e[0]));
      iE.push(Math.abs(e[2]));
    }
    const fp = (100 * nf) / trials;
    failBy.set(m.name, fp);
    azBy.set(m.name, median(azE));
    rows.push(
      `      ${m.name.padEnd(9)} fail ${fp.toFixed(1).padStart(5)}% ` +
        `median|az| ${median(azE).toFixed(4)} median|I| ${median(iE).toFixed(4)}`,
    );
  }
  console.log(rows.join('\n'));
  // Measured (48 trials): huber 16.7% fail; gm 0.0% at every c; tighter c
  // gives smaller median errors (0.0017 < 0.0022 < 0.0044). Direct GM
  // dominates Huber here, and on dirty data tighter redescending wins.
  for (const m of methods) {
    if (m.c !== null) {
      assert.ok(
        failBy.get(m.name)! <= failBy.get('huber')!,
        `${m.name} fail% ${failBy.get(m.name)} worse than huber ${failBy.get('huber')}`,
      );
      assert.ok(failBy.get(m.name)! <= 5, `${m.name}: fail% ${failBy.get(m.name)} too high`);
    }
  }
  assert.ok(
    azBy.get('gm c=1.0')! <= azBy.get('gm c=3.0')!,
    'tighter c should give smaller median|az| on dirty data',
  );
});

// ---------------------------------------------------------------------------
// (c) NIS change detector under outliers at PERFECT prediction (no real
// scene change): plain residuals vs trimmed (|r| < 3s). If trimmed holds the
// z < 6 band where plain false-alarms, the trimmed computation becomes the
// default in the JIT change-detector path (oracle part (c), 50 trials).
// ---------------------------------------------------------------------------

test('robust-followup: NIS trimmed vs plain at perfect prediction', () => {
  const px = sphereGrid(64);
  const normals = px.normals;
  const M = normals.length;
  const R = (th: number[]) => renderLambertN(th, normals, RHO);
  const J = (th: number[]) => jacLambertN(th, normals, RHO);
  const P = [0, 1, 2, 3].map((i, _, a) =>
    a.map((_, j) => (i === j ? 0.03 * 0.03 : 0)),
  );
  const conds: Array<[string, number, number]> = [
    ['clean', 0, 0],
    ['specular 0.6', 0.6, 0],
    ['clutter 15%', 0, 0.15],
    ['spec 1.0 + clutter 25%', 1.0, 0.25],
  ];
  const trials = 50;
  const medPlain = new Map<string, number>();
  const medTrim = new Map<string, number>();
  const lines: string[] = [];
  for (const [name, sp, cl] of conds) {
    const zp: number[] = [];
    const zt: number[] = [];
    for (let tr = 0; tr < trials; tr++) {
      const uni = makeUniform(23100 + tr);
      const th = randTheta(uni);
      const y = makeImage(th, normals, sp, cl, 23200 + tr);
      zp.push(nisChange(y, th, P, R, J, SIG * SIG, 0).z);
      zt.push(nisChange(y, th, P, R, J, SIG * SIG, 3).z);
    }
    medPlain.set(name, median(zp));
    medTrim.set(name, median(zt));
    lines.push(
      `      ${name.padEnd(24)} plain z median ${median(zp).toFixed(1).padStart(10)} ` +
        `trimmed z median ${median(zt).toFixed(2).padStart(8)}`,
    );
  }
  console.log(lines.join('\n') + '\n      (alarm threshold z > 6)');
  // Sanity: no false alarm on clean data either way.
  assert.ok(Math.abs(medPlain.get('clean')!) < 6, 'plain false-alarms on clean data');
  assert.ok(Math.abs(medTrim.get('clean')!) < 6, 'trimmed false-alarms on clean data');
  // Trimming strictly reduces the false-alarm z on every outlier condition
  // (measured: 1995 -> 7.78, 5950 -> 1.57, 11577 -> 32.99).
  for (const [name] of conds) {
    if (name === 'clean') continue;
    assert.ok(
      medTrim.get(name)! < medPlain.get(name)!,
      `trimming did not help on ${name}`,
    );
  }
  // Clutter trims cleanly: the trimmed detector fully holds the band.
  assert.ok(Math.abs(medTrim.get('clutter 15%')!) < 6, 'trimmed false-alarms on clutter');
  // Plain must false-alarm massively on the outlier conditions, proving the
  // check is not vacuous.
  for (const [name] of conds) {
    if (name === 'clean') continue;
    assert.ok(
      medPlain.get(name)! >= 6,
      `plain NIS did not false-alarm on ${name}; check is vacuous`,
    );
  }
  // Honest limitation, pinned: the smooth flanks of the specular lobe
  // (|r| just under 3s) pass the trim and leave systematic bias, so the
  // trimmed z stays above the band on specular (7.78) and spec+clutter
  // (32.99). Trimming is 250-350x better than plain but not a complete fix
  // for smooth outlier structures; documented in docs/robust-estimation.md.
  console.log(
    '      NOTE: trimmed z on specular 0.6 = ' +
      medTrim.get('specular 0.6')!.toFixed(2) +
      ', spec+clutter = ' +
      medTrim.get('spec 1.0 + clutter 25%')!.toFixed(2) +
      ' (smooth-flank leakage, see docs)',
  );
  void M;
});
