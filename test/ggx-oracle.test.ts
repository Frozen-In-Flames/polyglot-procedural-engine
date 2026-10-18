import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ggxD, smithG1, smithVisibility, sampleGgxCosTheta,
} from '../src/inverse/forward.js';
import { Pcg32 } from '../src/math/determinism.js';
import type { Vec3 } from '../src/math/vec.js';

// Port of docs/oracles/ggx_oracle.py. Identities, not trust.

// Adaptive Simpson quadrature.
function adaptiveSimpson(
  f: (x: number) => number, a: number, b: number, tol: number, maxDepth = 20,
): number {
  const fa = f(a), fb = f(b), m = (a + b) / 2, fm = f(m);
  const whole = ((b - a) / 6) * (fa + 4 * fm + fb);
  const rec = (
    a: number, fa: number, m: number, fm: number, b: number, fb: number,
    whole: number, tol: number, depth: number,
  ): number => {
    const lm = (a + m) / 2, flm = f(lm);
    const rm = (m + b) / 2, frm = f(rm);
    const left = ((m - a) / 6) * (fa + 4 * flm + fm);
    const right = ((b - m) / 6) * (fm + 4 * frm + fb);
    const delta = left + right - whole;
    if (depth <= 0 || Math.abs(delta) < 15 * tol) {
      return left + right + delta / 15;
    }
    return (
      rec(a, fa, lm, flm, m, fm, left, tol / 2, depth - 1) +
      rec(m, fm, rm, frm, b, fb, right, tol / 2, depth - 1)
    );
  };
  return rec(a, fa, m, fm, b, fb, whole, tol, maxDepth);
}

// 1. D normalization: integral of 2*pi*D(x,a)*x over [0,1] = 1 within 1e-8.
test('ggx oracle 1: D normalization', () => {
  for (const a of [0.02, 0.05, 0.1, 0.3, 0.5, 0.8, 1.0]) {
    const f = (x: number): number => 2 * Math.PI * ggxD(x, a) * x;
    // Split at the peak shoulder like the oracle's points=[1-a^2].
    const split = a < 0.9 ? 1 - a * a : 0.5;
    const val =
      adaptiveSimpson(f, 0, split, 1e-10) + adaptiveSimpson(f, split, 1, 1e-10);
    assert.ok(Math.abs(val - 1) < 1e-8, `alpha=${a} got ${val}`);
  }
});

// 2. Smith masking identity: G1(cos tv) * integral D(cos th)*max(vh,0)*sin th = cos tv.
test('ggx oracle 2: Smith masking identity', () => {
  const NT = 800, NP = 400;
  for (const a of [0.2, 0.5, 1.0]) {
    for (const tvDeg of [0, 30, 60, 80]) {
      const tv = (tvDeg * Math.PI) / 180;
      const stv = Math.sin(tv), ctv = Math.cos(tv);
      let sum = 0;
      for (let i = 0; i < NT; i++) {
        const th = ((i + 0.5) / NT) * (Math.PI / 2);
        const cth = Math.cos(th), sth = Math.sin(th);
        const D = ggxD(cth, a);
        for (let j = 0; j < NP; j++) {
          const ph = ((j + 0.5) / NP) * 2 * Math.PI;
          const vh = stv * sth * Math.cos(ph) + ctv * cth;
          if (vh > 0) sum += D * vh * sth;
        }
      }
      const I = sum * ((Math.PI / 2 / NT) * ((2 * Math.PI) / NP));
      const lhs = smithG1(ctv, a) * I;
      assert.ok(Math.abs(lhs - ctv) < 2e-4, `a=${a} tv=${tvDeg} lhs=${lhs} rhs=${ctv}`);
    }
  }
});

// Specular BRDF f_r (F0 configurable), composed from the exported pieces.
function specFR(l: Vec3, v: Vec3, a: number, F0: number): number {
  const nl = l[2], nv = v[2];
  const h: Vec3 = [l[0] + v[0], l[1] + v[1], l[2] + v[2]];
  const hl = Math.hypot(h[0], h[1], h[2]) || 1;
  const hn: Vec3 = [h[0] / hl, h[1] / hl, h[2] / hl];
  const nh = Math.max(hn[2], 0);
  const vh = Math.max(Math.min(hn[0] * v[0] + hn[1] * v[1] + hn[2] * v[2], 1), 0);
  const D = ggxD(nh, a);
  const F = F0 + (1 - F0) * (1 - vh) ** 5;
  return D * F * smithVisibility(nl, nv, a);
}

// 3. Reciprocity: f_r(l,v) = f_r(v,l), worst relative diff < 1e-12.
test('ggx oracle 3: reciprocity', () => {
  const g = new Pcg32(11);
  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const mk = (): Vec3 => {
      let x = g.unit() * 2 - 1, y = g.unit() * 2 - 1, z = g.unit() * 2 - 1;
      const l = Math.hypot(x, y, z) || 1;
      x /= l; y /= l; z /= l;
      z = Math.abs(z) + 0.01;
      const l2 = Math.hypot(x, y, z);
      return [x / l2, y / l2, z / l2];
    };
    const l = mk(), v = mk();
    const a = 0.05 + g.unit() * 0.95;
    const x = specFR(l, v, a, 0.04), y = specFR(v, l, a, 0.04);
    worst = Math.max(worst, Math.abs(x - y) / Math.max(Math.abs(x), 1e-30));
  }
  assert.ok(worst < 1e-12, `worst rel diff ${worst}`);
});

// 4. Visibility simplification: G1(l)G1(v)/(4 nl nv) == 1/((nl+s_l)(nv+s_v)).
test('ggx oracle 4: visibility form', () => {
  const g = new Pcg32(12);
  let worst = 0;
  for (let i = 0; i < 100000; i++) {
    const nl = 1e-4 + g.unit() * (1 - 1e-4);
    const nv = 1e-4 + g.unit() * (1 - 1e-4);
    const a = 0.02 + g.unit() * 0.98;
    const lhs = (smithG1(nl, a) * smithG1(nv, a)) / (4 * nl * nv);
    const rhs = smithVisibility(nl, nv, a);
    worst = Math.max(worst, Math.abs(lhs - rhs) / rhs);
  }
  assert.ok(worst < 1e-9, `worst rel diff ${worst}`);
  // 4b. Finite at nl = 0 exactly (the G/(4 nl nv) form is 0/0 there).
  const v0 = smithVisibility(0, 0.5, 0.3);
  assert.ok(Number.isFinite(v0), `V(0, 0.5, 0.3) = ${v0}`);
});

// 5. Importance sampler reproduces the D(n.h) pdf (moments k=1,2,5).
test('ggx oracle 5: sampler moments', () => {
  const g = new Pcg32(13);
  const N = 1000000;
  for (const a of [0.1, 0.4, 0.9]) {
    const samp = new Array(N);
    for (let i = 0; i < N; i++) samp[i] = sampleGgxCosTheta(g.unit(), a);
    for (const k of [1, 2, 5]) {
      let mean = 0;
      for (let i = 0; i < N; i++) mean += samp[i] ** k;
      mean /= N;
      const exact = adaptiveSimpson(
        (x) => 2 * Math.PI * ggxD(x, a) * x * x ** k, 0, 1, 1e-9,
      );
      assert.ok(Math.abs(mean - exact) < 2e-3, `a=${a} k=${k} MC=${mean} exact=${exact}`);
    }
  }
});

// 6. Directional albedo (F=1): MC == brute-force quadrature, and <= 1.
test('ggx oracle 6: directional albedo (white furnace)', () => {
  const g = new Pcg32(14);
  const NMC = 500000;
  const NQ = 500;
  for (const a of [0.3, 0.5, 0.8, 1.0]) {
    for (const cv of [1.0, 0.7, 0.3]) {
      const sv = Math.sqrt(1 - cv * cv);
      // MC with pdf p_l = D(n.h)/(4 v.h).
      let sum = 0, sum2 = 0;
      for (let i = 0; i < NMC; i++) {
        const xi1 = g.unit(), xi2 = g.unit();
        const ch = sampleGgxCosTheta(xi2, a);
        const sh = Math.sqrt(Math.max(0, 1 - ch * ch));
        const phi = 2 * Math.PI * xi1;
        const hx = sh * Math.cos(phi), hy = sh * Math.sin(phi);
        const vh = hx * sv + ch * cv;
        const lx = 2 * vh * hx - sv, ly = 2 * vh * hy, lz = 2 * vh * ch - cv;
        const nl = lz;
        const w =
          nl > 0 && vh > 0
            ? (smithG1(nl, a) * smithG1(cv, a) * vh) / (cv * ch)
            : 0;
        void lx; void ly;
        sum += w;
        sum2 += w * w;
      }
      const m = sum / NMC;
      const se = Math.sqrt(Math.max(0, sum2 / NMC - m * m) / NMC);
      // Brute-force quadrature.
      let q = 0;
      for (let i = 0; i < NQ; i++) {
        const t = ((i + 0.5) / NQ) * (Math.PI / 2);
        const st = Math.sin(t), ct = Math.cos(t);
        for (let j = 0; j < NQ; j++) {
          const p = ((j + 0.5) / NQ) * 2 * Math.PI;
          const lx = st * Math.cos(p), ly = st * Math.sin(p), lz = ct;
          // h = normalize(l + v), v = (sv, 0, cv).
          let hx = lx + sv, hy = ly, hz = lz + cv;
          const hl = Math.hypot(hx, hy, hz) || 1;
          hx /= hl; hy /= hl; hz /= hl;
          // f_r (F=1) via the V form: D * V; albedo integrand f_r * nl.
          const fr = ggxD(Math.max(hz, 0), a) * smithVisibility(lz, cv, a);
          q += fr * lz * st;
        }
      }
      q *= (Math.PI / 2 / NQ) * ((2 * Math.PI) / NQ);
      const tol = Math.max(5 * se, 2e-3);
      assert.ok(Math.abs(m - q) < tol, `a=${a} cv=${cv} MC=${m} quad=${q} tol=${tol}`);
      assert.ok(m <= 1 + 5 * se, `a=${a} cv=${cv} albedo=${m} > 1`);
    }
  }
});
