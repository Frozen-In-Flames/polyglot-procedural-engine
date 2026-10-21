// Just-in-time inverse rendering (owner-validated math).
//
// Ground truth: docs/oracles/test_jit_inverse.py (the owner's file, run in
// his sandbox). Every check below mirrors a ✔ check there. The owner's F2
// check is the fixed real assertion (7 <= ratio <= 13), not the vacuous
// True he flagged.
//
// "Just in time" = solving for scene parameters per frame under a fixed
// time budget. The toy: Lambertian sphere, known geometry and albedo,
// unknown light (azimuth, elevation, intensity) plus ambient, Gaussian
// noise. theta = (az, el, I, A).
//
// Additional engine work beyond the oracle: (G) a geometry parameter in the
// JIT loop, (H) a model-mismatch stress test, (I) a counted cost model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32, randn, sphereGrid, lightDir, renderLambert, jacLambert,
  renderLambertN, jacLambertN,
  linearInitLight, solveFrame, chi2reduced, mapGnStep, kalmanLinearUpdate,
  nisStatistic, invertSPD, solveSPD, matVec, shBasis9, AHAT9, estimateSH, ridgeSH,
  gramCond, ellipPixels, renderEllipsoid, jacEllipsoid,
  medianTimeMs, subRows,
} from '../src/inverse/jit.js';

const RHO = 0.7;
const SIG = 0.01;
const S2 = SIG * SIG;

function makeRng(seed: number) {
  const rng = mulberry32(seed);
  return () => randn(rng);
}

function makeUniform(seed: number) {
  const rng = mulberry32(seed);
  return () => rng.next();
}

// ---------------------------------------------------------------------------
// A. Analytic Jacobian == central finite differences.
// ---------------------------------------------------------------------------
test('jit: analytic Jacobian matches finite differences', () => {
  const px = sphereGrid(64);
  const th = [0.6, 0.5, 1.2, 0.15];
  const J = jacLambert(th, px, RHO);
  const e = 1e-6;
  let worst = 0;
  for (let k = 0; k < 4; k++) {
    const tp = th.slice(); tp[k] += e;
    const tm = th.slice(); tm[k] -= e;
    const rp = renderLambert(tp, px, RHO);
    const rm = renderLambert(tm, px, RHO);
    for (let j = 0; j < px.count; j++) {
      const fd = (rp[j] - rm[j]) / (2 * e);
      worst = Math.max(worst, Math.abs(J[j][k] - fd));
    }
  }
  // Terminator kink excluded by construction: the owner masks it; here the
  // max over all pixels still clears 1e-5 on this configuration.
  assert.ok(worst < 1e-5, `max diff ${worst}`);
});

// ---------------------------------------------------------------------------
// B. One MAP Gauss-Newton step == Kalman update (linear case, exact).
// ---------------------------------------------------------------------------
test('jit: MAP Gauss-Newton step equals the Kalman update', () => {
  const gauss = makeRng(1234);
  const m = 30, p = 4;
  const Jl: number[][] = [];
  for (let j = 0; j < m; j++) {
    const row: number[] = [];
    for (let k = 0; k < p; k++) row.push(gauss());
    Jl.push(row);
  }
  const Pdiag = [0.5, 0.2, 0.3, 0.4];
  const Pp: number[][] = Pdiag.map((d, i) => Pdiag.map((_, j) => (i === j ? d * d : 0)));
  const tp = [gauss(), gauss(), gauss(), gauss()];
  const tTrue = [gauss(), gauss(), gauss(), gauss()];
  const y = matVec(Jl, tTrue).map((v) => v + 0.1 * gauss());
  const R = 0.01; // R = 0.1^2 I
  const Rfun = (t: number[]) => matVec(Jl, t);
  const Jfun = (_t: number[]) => Jl;

  // Kalman form.
  const k = kalmanLinearUpdate(tp, Pp, y, Jl, R);
  // MAP / information form, one step from the prior mean.
  const Pinv = invertSPD(Pp);
  const g = mapGnStep(tp, tp, Pinv, y, Rfun, Jfun, R);
  const tMap = tp.map((v, i) => v + g.delta[i]);
  const PMap = invertSPD(g.info);

  let wMean = 0, wCov = 0;
  for (let i = 0; i < p; i++) {
    wMean = Math.max(wMean, Math.abs(k.t[i] - tMap[i]));
    for (let j = 0; j < p; j++) wCov = Math.max(wCov, Math.abs(k.P[i][j] - PMap[i][j]));
  }
  assert.ok(wMean < 1e-9, `mean diff ${wMean}`);
  assert.ok(wCov < 1e-9, `covariance diff ${wCov}`);
});

// ---------------------------------------------------------------------------
// C. Warm start vs cold start over drifting frames.
// ---------------------------------------------------------------------------
function truth(t: number): number[] {
  return [0.5 + 0.035 * t, 0.6, 1.2, 0.15];
}

test('jit: warm start converges every frame, cold start fails on some', () => {
  const px = sphereGrid(64);
  const M = px.count;
  const gauss = makeRng(777);
  const coldInit = [0.0, 0.3, 1.0, 0.1];
  const Qd = [0.06 * 0.06, 0.03 * 0.03, 0.03 * 0.03, 0.03 * 0.03];
  const Tn = 40;
  const its: Record<string, number[]> = { cold: [], linear: [], warm: [], map: [] };
  const ok: Record<string, boolean[]> = { cold: [], linear: [], warm: [], map: [] };
  let thW: number[] | null = null;
  let thM: number[] | null = null;
  let Pprev: number[][] | null = null;

  for (let t = 0; t < Tn; t++) {
    const tt = truth(t);
    const base = renderLambert(tt, px, RHO);
    const y = base.map((v) => v + SIG * gauss());
    const R = (th: number[]) => renderLambert(th, px, RHO);
    const J = (th: number[]) => jacLambert(th, px, RHO);
    for (const [key, init] of [['cold', coldInit], ['linear', linearInitLight(y, px, RHO)]] as const) {
      const s = solveFrame(y, init, R, J, S2, {});
      if (t > 0) {
        its[key].push(s.iters);
        ok[key].push(chi2reduced(y, s.theta, R, SIG) < 1.2);
      }
    }
    if (thW === null) {
      const s1 = solveFrame(y, linearInitLight(y, px, RHO), R, J, S2, {});
      const s2 = solveFrame(y, linearInitLight(y, px, RHO), R, J, S2, {});
      thW = s1.theta; thM = s2.theta; Pprev = invertSPD(s2.info);
      continue;
    }
    const sw = solveFrame(y, thW, R, J, S2, {});
    thW = sw.theta;
    const Pq: number[][] = Pprev!.map((row, i) => row.map((v, j) => v + (i === j ? Qd[i] : 0)));
    const sm = solveFrame(y, thM!, R, J, S2, { thetaPred: thM!, P: Pq });
    thM = sm.theta; Pprev = invertSPD(sm.info);
    for (const [key, s] of [['warm', sw], ['map', sm]] as const) {
      its[key].push(s.iters);
      ok[key].push(chi2reduced(y, s.theta, R, SIG) < 1.2);
    }
  }

  const mean = (a: number[]) => a.reduce((x, v) => x + v, 0) / a.length;
  // C1: warm start finishes in <= 4 iterations on every frame, no failures.
  assert.ok(Math.max(...its.warm) <= 4, `warm max iters ${Math.max(...its.warm)}`);
  assert.ok(ok.warm.every(Boolean), 'warm had failures');
  // C2: warm == MAP here (same iteration budget, no failures).
  assert.ok(Math.abs(mean(its.warm) - mean(its.map)) < 0.5,
    `warm ${mean(its.warm).toFixed(2)} vs map ${mean(its.map).toFixed(2)}`);
  assert.ok(ok.map.every(Boolean), 'map had failures');
  // C3: a fixed cold init fails on some frames (dead zone / bad minimum).
  const coldFail = 1 - mean(ok.cold.map((v) => (v ? 1 : 0)));
  assert.ok(coldFail > 0, `cold never failed (${(coldFail * 100).toFixed(1)}%)`);
  // C4: the closed-form linear initializer never fails here.
  assert.ok(ok.linear.every(Boolean), 'linear init had failures');
});

// ---------------------------------------------------------------------------
// D. NIS change detection: flag the jump, re-lock, no false alarms.
// ---------------------------------------------------------------------------
test('jit: NIS flags a scene jump on the first frame and re-locks', () => {
  const px = sphereGrid(64);
  const M = px.count;
  const gauss = makeRng(4242);
  const R = (th: number[]) => renderLambert(th, px, RHO);
  const J = (th: number[]) => jacLambert(th, px, RHO);
  const Pq0 = [0.06 * 0.06, 0.03 * 0.03, 0.03 * 0.03, 0.03 * 0.03];
  let thEst = truth(0);
  let Pest: number[][] = [0.05 * 0.05, 0.05 * 0.05, 0.05 * 0.05, 0.05 * 0.05]
    .map((d, i, a) => a.map((_, j) => (i === j ? d : 0)));
  const zs: number[] = [];
  let resetInfo = '';

  for (let t = 1; t < 30; t++) {
    const tt = truth(t).slice();
    if (t >= 20) { tt[0] = -0.8; tt[2] = 0.6; }
    const y = R(tt).map((v) => v + SIG * gauss());
    const Pq: number[][] = Pest.map((row, i) => row.map((v, j) => v + (i === j ? Pq0[i] : 0)));
    const z = (nisStatistic(y, thEst, Pq, R, J, S2) - M) / Math.sqrt(2 * M);
    zs.push(z);
    if (z > 6) {
      const s = solveFrame(y, linearInitLight(y, px, RHO), R, J, S2, {});
      const err = Math.max(...s.theta.map((v, i) => Math.abs(v - tt[i])));
      resetInfo = `chi2 ${chi2reduced(y, s.theta, R, SIG).toFixed(2)} err ${err.toFixed(4)}`;
      thEst = s.theta;
      Pest = invertSPD(s.info);
    } else {
      const s = solveFrame(y, thEst, R, J, S2, { thetaPred: thEst, P: Pq });
      thEst = s.theta;
      Pest = invertSPD(s.info);
    }
  }
  const before = zs.slice(0, 19);
  const at = zs[19];
  const after = zs.slice(20);
  assert.ok(Math.max(...before) < 6, `false alarm: max z ${Math.max(...before).toFixed(2)}`);
  assert.ok(at > 6, `jump not flagged: z = ${at.toFixed(1)}`);
  assert.ok(resetInfo !== '', 'no reset happened');
  assert.ok(Math.max(...after) < 6, `alarms after reset: ${Math.max(...after).toFixed(2)}`);
});

// ---------------------------------------------------------------------------
// E. Subsampling: error follows the Cramer-Rao 1/sqrt(m) rate.
// ---------------------------------------------------------------------------
test('jit: subsampled error stays within 30 percent of the Cramer-Rao bound', () => {
  const px = sphereGrid(64);
  const M = px.count;
  const thTrue = [0.6, 0.5, 1.2, 0.15];
  for (const m of [50, 200, 800, M]) {
    const gauss = makeRng(9000 + m);
    const uni = makeUniform(9100 + m);
    const trials = 80;
    const ratios: number[][] = [];
    for (let tr = 0; tr < trials; tr++) {
      const idx = new Set<number>();
      if (m < M) {
        while (idx.size < m) idx.add(Math.floor(uni() * M));
      } else {
        for (let j = 0; j < M; j++) idx.add(j);
      }
      const sub = subRows(px.normals, [...idx]);
      const y = renderLambertN(thTrue, sub, RHO).map((v) => v + SIG * gauss());
      let th = [thTrue[0] + 0.05, thTrue[1] + 0.05, thTrue[2] + 0.1, thTrue[3] + 0.03];
      for (let it = 0; it < 6; it++) {
        const Rv = renderLambertN(th, sub, RHO);
        const Jm = jacLambertN(th, sub, RHO);
        const r = y.map((v, j) => v - Rv[j]);
        const A: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
        const g = [0, 0, 0, 0];
        for (let j = 0; j < m; j++) {
          for (let a = 0; a < 4; a++) {
            g[a] += Jm[j][a] * r[j];
            for (let b = 0; b < 4; b++) A[a][b] += Jm[j][a] * Jm[j][b];
          }
        }
        for (let a = 0; a < 4; a++) A[a][a] += 1e-9;
        const d = solveSPD(A, g);
        th = th.map((v, a) => v + d[a]);
      }
      // CRB from this trial's subset at truth.
      const Jt = jacLambertN(thTrue, sub, RHO);
      const info: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
      for (let j = 0; j < sub.length; j++) {
        for (let a = 0; a < 4; a++) {
          for (let b = 0; b < 4; b++) info[a][b] += (Jt[j][a] * Jt[j][b]) / S2;
        }
      }
      const cov = invertSPD(info);
      const crb = [0, 1, 2, 3].map((a) => Math.sqrt(Math.max(cov[a][a], 1e-30)));
      ratios.push(th.map((v, a) => Math.abs(v - thTrue[a]) / crb[a]));
    }
    for (let a = 0; a < 4; a++) {
      const mean = ratios.reduce((s, r) => s + r[a], 0) / trials;
      assert.ok(mean > 0.7 && mean < 1.3, `m=${m} param ${a}: mean ratio ${mean.toFixed(2)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// F. One-shot SH-9 light solve: conditioning, noise scaling, ridge centering.
// ---------------------------------------------------------------------------
function gaussNormals(rng: () => number, k: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < k; i++) {
    const v = [rng(), rng(), rng()];
    const L = Math.hypot(v[0], v[1], v[2]) || 1;
    out.push([v[0] / L, v[1] / L, v[2] / L]);
  }
  return out;
}

test('jit: one-shot SH solve sees hemisphere conditioning and noise scaling', () => {
  const gauss = makeRng(5150);
  const Ltrue = [3.5, 0.5, -0.5, 0.5, 0.25, -0.25, 0.25, 0.25, -0.25].map((v, i) => i === 0 ? 3.5 : v * gauss() * 2);
  const backAll = gaussNormals(gauss, 4000).filter((n) => n[2] < -0.2);
  const Pb = backAll.map((n) => shBasis9(n).map((y, k) => (RHO / Math.PI) * y * AHAT9[k]));

  const extrap = (Lh: number[]) => {
    let s = 0;
    for (let j = 0; j < backAll.length; j++) {
      let d = 0;
      for (let k = 0; k < 9; k++) d += Pb[j][k] * (Lh[k] - Ltrue[k]);
      s += d * d;
    }
    return Math.sqrt(s / backAll.length);
  };
  const conds: number[] = [];
  const hemiErr: number[] = [];
  for (const noise of [0.01, 0.1]) {
    for (const hemi of [true, false]) {
      const errs: number[] = [];
      let lastPhi: number[][] = [];
      for (let tr = 0; tr < 30; tr++) {
        let nv = gaussNormals(gauss, 1500);
        if (hemi) nv = nv.map((n) => [n[0], n[1], Math.abs(n[2])]);
        const Phi = nv.map((n) => shBasis9(n).map((y, k) => (RHO / Math.PI) * y * AHAT9[k]));
        const y = Phi.map((row) => row.reduce((s, v, k) => s + v * Ltrue[k], 0) + noise * gauss());
        const Lh = estimateSH(Phi, y);
        errs.push(extrap(Lh));
        lastPhi = Phi;
      }
      const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
      if (hemi) hemiErr.push(mean);
      conds.push(gramCond(lastPhi));
    }
  }
  // F1: hemisphere conditioning is much worse than full sphere.
  assert.ok(conds[0] > 3 * conds[1], `hemi cond ${conds[0].toFixed(1)} vs full ${conds[1].toFixed(1)}`);
  // F2: extrapolation error scales ~linearly with noise (x10 -> x7..x13).
  const ratio = hemiErr[1] / hemiErr[0];
  assert.ok(ratio >= 7 && ratio <= 13, `noise scaling ratio ${ratio.toFixed(1)}`);
});

test('jit: SH ridge prior must be centered on a nominal environment, not zero', () => {
  const gauss = makeRng(6161);
  const Ltrue = [3.5, 0.2, -0.15, 0.1, 0.05, -0.05, 0.08, 0.03, -0.04];
  const backAll = gaussNormals(gauss, 4000).filter((n) => n[2] < -0.2);
  const Pb = backAll.map((n) => shBasis9(n).map((y, k) => (RHO / Math.PI) * y * AHAT9[k]));
  const extrap = (Lh: number[]) => {
    let s = 0;
    for (let j = 0; j < backAll.length; j++) {
      let d = 0;
      for (let k = 0; k < 9; k++) d += Pb[j][k] * (Lh[k] - Ltrue[k]);
      s += d * d;
    }
    return Math.sqrt(s / backAll.length);
  };
  const errs0: number[] = [];
  const errsN: number[] = [];
  const Lnom = [3.5, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let tr = 0; tr < 30; tr++) {
    const nv = gaussNormals(gauss, 1500).map((n) => [n[0], n[1], Math.abs(n[2])]);
    const Phi = nv.map((n) => shBasis9(n).map((y, k) => (RHO / Math.PI) * y * AHAT9[k]));
    const y = Phi.map((row) => row.reduce((s, v, k) => s + v * Ltrue[k], 0) + 0.01 * gauss());
    errs0.push(extrap(ridgeSH(Phi, y, 1.0, [0, 0, 0, 0, 0, 0, 0, 0, 0])));
    errsN.push(extrap(ridgeSH(Phi, y, 1.0, Lnom)));
  }
  const m0 = errs0.reduce((a, b) => a + b, 0) / errs0.length;
  const mN = errsN.reduce((a, b) => a + b, 0) / errsN.length;
  // Ridge toward zero shrinks the large DC term and is far worse.
  assert.ok(m0 > 5 * mN, `ridge-zero ${m0.toFixed(3)} vs ridge-nominal ${mN.toFixed(4)}`);
});

// ---------------------------------------------------------------------------
// G. Geometry parameter (ellipsoid squash) in the warm-started JIT loop.
// ---------------------------------------------------------------------------
test('jit: ellipsoid squash joins the per-frame solve with an analytic Jacobian', () => {
  const px = ellipPixels(64);
  const th5 = [0.6, 0.5, 1.2, 0.15, 1.0];
  const J = jacEllipsoid(th5, px, RHO);
  const e = 1e-6;
  const tp = th5.slice(); tp[4] += e;
  const tm = th5.slice(); tm[4] -= e;
  const rp = renderEllipsoid(tp, px, RHO);
  const rm = renderEllipsoid(tm, px, RHO);
  let worst = 0;
  for (let j = 0; j < px.count; j++) {
    worst = Math.max(worst, Math.abs(J[j][4] - (rp[j] - rm[j]) / (2 * e)));
  }
  assert.ok(worst < 1e-5, `squash-column FD diff ${worst}`);

  // Warm-started drift in azimuth and squash: no failures.
  const gauss = makeRng(7171);
  const R = (th: number[]) => renderEllipsoid(th, px, RHO);
  const JJ = (th: number[]) => jacEllipsoid(th, px, RHO);
  let thW = [0.5, 0.6, 1.2, 0.15, 1.0];
  let fails = 0;
  let maxIt = 0;
  for (let t = 0; t < 15; t++) {
    const tt = [0.5 + 0.03 * t, 0.6, 1.2, 0.15, 1.0 + 0.01 * t];
    const y = R(tt).map((v) => v + SIG * gauss());
    const s = solveFrame(y, thW, R, JJ, S2, {});
    thW = s.theta;
    maxIt = Math.max(maxIt, s.iters);
    if (chi2reduced(y, s.theta, R, SIG) >= 1.2) fails++;
  }
  assert.ok(fails === 0, `${fails} failed frames`);
  assert.ok(maxIt <= 6, `max iters ${maxIt}`);
});

// ---------------------------------------------------------------------------
// H. Model-mismatch stress: unmodeled specular biases the Lambertian fit.
// ---------------------------------------------------------------------------
test('jit: unmodeled specular dominates noise (bias floor, not 1/sqrt(m))', () => {
  const px = sphereGrid(64);
  const thTrue = [0.6, 0.5, 1.2, 0.15];
  // Generator: Lambertian plus an unmodeled specular lobe the fitter never sees.
  const gen = (th: number[], sub: number[][], ks: number): number[] => {
    const l = lightDir(th[0], th[1]);
    const h = [l[0], l[1], l[2] + 1];
    const hl = Math.hypot(h[0], h[1], h[2]) || 1;
    return sub.map((n) => {
      const nl = n[0] * l[0] + n[1] * l[1] + n[2] * l[2];
      const lam = RHO * (th[3] + th[2] * Math.max(nl, 0));
      if (ks === 0) return lam;
      const nh = (n[0] * h[0] + n[1] * h[1] + n[2] * h[2]) / hl;
      return lam + ks * Math.pow(Math.max(nh, 0), 32);
    });
  };

  const trials = 12;
  const errAt = (m: number, ks: number) => {
    const errs: number[] = [];
    for (let tr = 0; tr < trials; tr++) {
      const gauss = makeRng(8100 + tr * 131 + m);
      const uni = makeUniform(8200 + tr * 131 + m);
      const idx = new Set<number>();
      while (idx.size < m) idx.add(Math.floor(uni() * px.count));
      const sub = subRows(px.normals, [...idx]);
      const Rs = (th: number[]) => renderLambertN(th, sub, RHO);
      const Js = (th: number[]) => jacLambertN(th, sub, RHO);
      const y = gen(thTrue, sub, ks).map((v) => v + SIG * gauss());
      // Fit with the Lambertian-only model on the same subset.
      const li = linearInitLight(y, { normals: sub, count: sub.length }, RHO);
      const s = solveFrame(y, li, Rs, Js, S2, {});
      errs.push(Math.abs(s.theta[0] - thTrue[0]));
    }
    errs.sort((a, b) => a - b);
    return errs[Math.floor(trials / 2)];
  };

  const matched200 = errAt(200, 0);
  const matched2000 = errAt(2000, 0);
  const mis200 = errAt(200, 0.3);
  const mis2000 = errAt(2000, 0.3);
  // Matched case is at the noise floor and small.
  assert.ok(matched2000 < 0.02, `matched err ${matched2000.toFixed(4)}`);
  // Mismatch leaves an absolute bias floor well above the noise floor...
  assert.ok(mis2000 > 0.005, `mismatch bias ${mis2000.toFixed(4)} too small to be a stress`);
  assert.ok(mis2000 > 3 * matched2000, `mismatch ${mis2000.toFixed(4)} vs matched ${matched2000.toFixed(4)}`);
  // ...and it does not shrink like 1/sqrt(m): a bias floor, not noise.
  assert.ok(mis2000 / mis200 > 0.7, `scaling ${mis2000.toFixed(4)}/${mis200.toFixed(4)}`);
});

// ---------------------------------------------------------------------------
// I. Per-frame cost scales linearly in m, asserted on counted model
// evaluations (deterministic units), not wall-clock time. This test used
// to assert a timer ratio t(4m)/t(m) ~ 4; that oracle measured machine
// load, not scaling, and failed intermittently under VM load (observed
// ratio 2.26x) while the scaling itself never changed. The replacement
// counts the exact pixel values solveFrame consumes: per-frame work
// W(m) = (evaluations per pixel) x m, where the evaluations-per-pixel
// factor is a property of the solver, independent of m and of load.
// ---------------------------------------------------------------------------
test('jit: per-frame cost scales linearly with pixel count (counted evaluations, not wall-clock)', () => {
  const px = sphereGrid(64);
  const M = px.count;
  const thTrue = [0.6, 0.5, 1.2, 0.15];
  const P = thTrue.length;

  // Counted solve harness: wraps R and J and accumulates the exact
  // number of scalar pixel values the solver consumes (render values
  // plus Jacobian entries). `cap` selects the fixed-budget path: solve
  // on at most `cap` pixels no matter how large the frame is.
  const workAt = (m: number, cap?: number) => {
    const uni = makeUniform(9300 + m);
    const idx = new Set<number>();
    while (idx.size < m) idx.add(Math.floor(uni() * M));
    let rows = [...idx];
    if (cap !== undefined) rows = rows.slice(0, cap);
    const sub = subRows(px.normals, rows);
    const n = sub.length;
    let counted = 0;
    const Rs = (th: number[]) => {
      const v = renderLambertN(th, sub, RHO);
      counted += v.length;
      return v;
    };
    const Js = (th: number[]) => {
      const Jm = jacLambertN(th, sub, RHO);
      counted += Jm.length * P;
      return Jm;
    };
    const gauss = makeRng(9400 + m);
    let total = 0;
    const FRAMES = 20;
    for (let f = 0; f < FRAMES; f++) {
      const y = renderLambertN(thTrue, sub, RHO).map((v) => v + SIG * gauss());
      const init = linearInitLight(y, { normals: sub, count: sub.length }, RHO);
      counted = 0;
      solveFrame(y, init, Rs, Js, S2, {});
      total += counted;
    }
    const perFrame = total / FRAMES;
    return { pixels: n, perFrame, evalsPerPixel: perFrame / n };
  };

  // The scaling assertion, factored out so the negative control below
  // runs the identical check on a path where it must fail.
  const assertLinear = (
    small: { perFrame: number; evalsPerPixel: number },
    big: { perFrame: number; evalsPerPixel: number },
  ) => {
    const ratio = big.perFrame / small.perFrame;
    // Measured exactly: work ratio 3.5821 (not 4.0000, because the
    // noisier quarter-size problem averages slightly more GN iterations
    // and backtracks per frame). Counts are seed-deterministic; the
    // band absorbs iteration-count jitter only, never machine load.
    assert.ok(ratio > 3.2 && ratio < 4.4, `counted work ratio 4x pixels: ${ratio.toFixed(4)}`);
    const cRatio = big.evalsPerPixel / small.evalsPerPixel;
    // Measured exactly: 0.8955 (21.00 vs 23.45 evals per pixel).
    assert.ok(cRatio > 0.8 && cRatio < 1.1, `evals per pixel drifted with m: ${cRatio.toFixed(4)}`);
  };

  const quarter = workAt(Math.floor(M / 4));
  const full = workAt(M);
  assert.equal(quarter.pixels, Math.floor(M / 4));
  assert.equal(full.pixels, M);
  assertLinear(quarter, full);

  // Negative control: on the fixed-budget path both frame sizes solve
  // on exactly 128 pixels, so counted work follows the cap, not m
  // (measured capped ratio 0.9524), and the identical scaling assertion
  // must reject it. If this control ever stops throwing, the assertion
  // above has no teeth.
  const capQ = workAt(Math.floor(M / 4), 128);
  const capF = workAt(M, 128);
  assert.equal(capQ.pixels, 128);
  assert.equal(capF.pixels, 128);
  assert.throws(() => assertLinear(capQ, capF), /counted work ratio/);

  // Wall-clock sanity only, never the scaling claim: the toy frame fits
  // a generous budget. Median of 5 batches of 20 frames; the bound is
  // set far above the observed solve time so load cannot trip it.
  const gaussT = makeRng(9191);
  const R = (th: number[]) => renderLambert(th, px, RHO);
  const J = (th: number[]) => jacLambert(th, px, RHO);
  const frames: { y: number[]; init: number[] }[] = [];
  for (let f = 0; f < 20; f++) {
    const y = R(thTrue).map((v) => v + SIG * gaussT());
    frames.push({ y, init: linearInitLight(y, px, RHO) });
  }
  const batchMs = medianTimeMs(() => {
    for (const fr of frames) solveFrame(fr.y, fr.init, R, J, S2, {});
  }, 5);
  assert.ok(batchMs / 20 < 250, `sanity: full frame ${(batchMs / 20).toFixed(1)}ms over generous budget`);
});
