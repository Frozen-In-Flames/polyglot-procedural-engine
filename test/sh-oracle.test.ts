import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shBasis, shIrradiance, shIrradianceRaw, shIrradianceShader,
  lambertSH, SH_AHAT, SH_C,
} from '../src/inverse/forward.js';
import { mulberry32 } from '../src/geo/rng.js';
import type { Vec3 } from '../src/math/vec.js';

// Port of docs/oracles/sh_oracle.py. Identities, not trust.

function randomUnit(rng: () => number): Vec3 {
  const z = rng() * 2 - 1;
  const phi = rng() * 2 * Math.PI;
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  return [s * Math.cos(phi), s * Math.sin(phi), z];
}

// 1. Orthonormality: integral of Y_i Y_j over the sphere = delta_ij.
// Deterministic midpoint grid in (z, phi); the oracle's Gauss-Legendre
// 48-point rule reaches 1e-6, the midpoint grid pins it to 1e-3.
test('sh oracle 1: basis orthonormality', () => {
  const NZ = 96, NP = 192;
  const G = Array.from({ length: 9 }, () => new Array(9).fill(0));
  const w = (2 / NZ) * ((2 * Math.PI) / NP);
  for (let iz = 0; iz < NZ; iz++) {
    const z = -1 + ((iz + 0.5) / NZ) * 2;
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    for (let ip = 0; ip < NP; ip++) {
      const phi = ((ip + 0.5) / NP) * 2 * Math.PI;
      const Y = shBasis([s * Math.cos(phi), s * Math.sin(phi), z]);
      for (let i = 0; i < 9; i++) {
        for (let j = 0; j < 9; j++) G[i][j] += Y[i] * Y[j] * w;
      }
    }
  }
  let worst = 0;
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < 9; j++) {
      worst = Math.max(worst, Math.abs(G[i][j] - (i === j ? 1 : 0)));
    }
  }
  assert.ok(worst < 1e-3, `max |G - I| = ${worst}`);
});

// 2. Ahat_l derived from the clamped cosine: A_l = 2 pi integral_0^1 x P_l(x) dx.
test('sh oracle 2: Ahat constants', () => {
  const want = [Math.PI, (2 * Math.PI) / 3, Math.PI / 4];
  for (let l = 0; l < 3; l++) {
    assert.ok(Math.abs(SH_AHAT[l] - want[l]) < 1e-12, `Ahat_${l} = ${SH_AHAT[l]}`);
  }
  const legendre = (l: number, x: number): number =>
    l === 0 ? 1 : l === 1 ? x : (3 * x * x - 1) / 2;
  for (let l = 0; l < 3; l++) {
    const N = 1000, h = 1 / N;
    const f = (x: number): number => x * legendre(l, x);
    let s = f(0) + f(1);
    for (let i = 1; i < N; i++) s += (i % 2 === 1 ? 4 : 2) * f(i * h);
    const derived = 2 * Math.PI * (s * h / 3);
    assert.ok(Math.abs(derived - want[l]) < 1e-12, `derived A_${l} = ${derived}`);
  }
});

// 3. White furnace: L = 1 everywhere -> E(n) = pi, Lambert output rho E / pi = rho.
test('sh oracle 3: white furnace', () => {
  const Y00 = 1 / (2 * Math.sqrt(Math.PI));
  const L = [4 * Math.PI * Y00, 0, 0, 0, 0, 0, 0, 0, 0];
  const dirs: Vec3[] = [
    [0, 0, 1], [1, 0, 0], [0, 1, 0],
    [0.5773502691896258, 0.5773502691896258, 0.5773502691896258],
    [-0.6, 0.2, 0.7745966692414834],
  ];
  for (const n of dirs) {
    assert.ok(Math.abs(shIrradiance(n, L) - Math.PI) < 1e-9, `E = ${shIrradiance(n, L)}`);
  }
  const rho = 0.8;
  for (const n of dirs) {
    assert.ok(Math.abs(lambertSH(rho, n, L) - rho) < 1e-9);
    // Forgetting the /pi is wrong by a factor of pi (the formula's negative control).
    assert.ok(Math.abs(rho * shIrradiance(n, L) - rho) > 1.0);
  }
});

// 4. Band-limited L: formula == brute-force cosine integral (Funk-Hecke makes it exact).
test('sh oracle 4: formula matches brute-force irradiance', () => {
  const rng = mulberry32(7);
  const L = Array.from({ length: 9 }, () => rng() * 2 - 1);
  const NT = 90, NP = 180;
  const dirs: Vec3[] = [];
  const wgts: number[] = [];
  const lums: number[] = [];
  for (let it = 0; it < NT; it++) {
    const th = ((it + 0.5) / NT) * Math.PI;
    const st = Math.sin(th), ct = Math.cos(th);
    for (let ip = 0; ip < NP; ip++) {
      const phi = ((ip + 0.5) / NP) * 2 * Math.PI;
      const w: Vec3 = [st * Math.cos(phi), st * Math.sin(phi), ct];
      const Y = shBasis(w);
      let lw = 0;
      for (let k = 0; k < 9; k++) lw += L[k] * Y[k];
      dirs.push(w);
      wgts.push(st * (Math.PI / NT) * (2 * Math.PI / NP));
      lums.push(lw);
    }
  }
  const rngN = mulberry32(11);
  let worst = 0;
  for (let t = 0; t < 6; t++) {
    const n = randomUnit(rngN);
    let brute = 0;
    for (let k = 0; k < dirs.length; k++) {
      const d = dirs[k];
      const c = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
      if (c > 0) brute += lums[k] * c * wgts[k];
    }
    const formula = shIrradianceRaw(n, L);
    worst = Math.max(worst, Math.abs(brute - formula));
  }
  assert.ok(worst < 5e-3, `worst |brute - formula| = ${worst} (grid limit; cosine kink)`);
});

// 5. Shader-form constants c1..c5 match the general formula.
test('sh oracle 5: shader constants and shader form', () => {
  const listed = { c1: 0.429043, c2: 0.511664, c3: 0.743125, c4: 0.886227, c5: 0.247708 };
  for (const k of ['c1', 'c2', 'c3', 'c4', 'c5'] as const) {
    assert.ok(Math.abs(SH_C[k] - listed[k]) < 2e-6, `${k}: derived ${SH_C[k]} vs listed ${listed[k]}`);
  }
  const rng = mulberry32(21);
  let worst = 0;
  for (let t = 0; t < 20; t++) {
    const n = randomUnit(rng);
    const L = Array.from({ length: 9 }, () => rng() * 2 - 1);
    worst = Math.max(worst, Math.abs(shIrradianceShader(n, L) - shIrradianceRaw(n, L)));
  }
  assert.ok(worst < 1e-12, `worst |shader - general| = ${worst}`);
});

// 6. Sharp-lobe undershoot: raw goes negative (Gibbs), the clamped output never does.
test('sh oracle 6: irradiance clamped at 0 on a sharp lobe', () => {
  const sun: Vec3 = [0.3, 0.2, 0.93];
  const sl = Math.hypot(sun[0], sun[1], sun[2]);
  const s: Vec3 = [sun[0] / sl, sun[1] / sl, sun[2] / sl];
  const kappa = 60;
  // Project the lobe onto the 9 basis functions on a deterministic grid.
  const NT = 90, NP = 180;
  const L = new Array(9).fill(0);
  for (let it = 0; it < NT; it++) {
    const th = ((it + 0.5) / NT) * Math.PI;
    const st = Math.sin(th), ct = Math.cos(th);
    for (let ip = 0; ip < NP; ip++) {
      const phi = ((ip + 0.5) / NP) * 2 * Math.PI;
      const w: Vec3 = [st * Math.cos(phi), st * Math.sin(phi), ct];
      const lobe = Math.exp(kappa * (w[0] * s[0] + w[1] * s[1] + w[2] * s[2] - 1));
      const Y = shBasis(w);
      const wt = st * (Math.PI / NT) * (2 * Math.PI / NP);
      for (let k = 0; k < 9; k++) L[k] += Y[k] * lobe * wt;
    }
  }
  // Scan the raw and clamped irradiance over directions.
  let minRaw = Infinity, maxRaw = -Infinity, minClamped = Infinity;
  const NS = 60, NPS = 120;
  for (let iz = 0; iz < NS; iz++) {
    const z = -1 + ((iz + 0.5) / NS) * 2;
    const sz = Math.sqrt(Math.max(0, 1 - z * z));
    for (let ip = 0; ip < NPS; ip++) {
      const phi = ((ip + 0.5) / NPS) * 2 * Math.PI;
      const n: Vec3 = [sz * Math.cos(phi), sz * Math.sin(phi), z];
      const raw = shIrradianceRaw(n, L);
      minRaw = Math.min(minRaw, raw);
      maxRaw = Math.max(maxRaw, raw);
      minClamped = Math.min(minClamped, shIrradiance(n, L));
    }
  }
  assert.ok(minRaw < 0, `undershoot exists: min raw = ${minRaw}`);
  assert.ok(Math.abs(minRaw) < 0.05 * maxRaw, `undershoot < 5% of peak: ${minRaw} vs ${maxRaw}`);
  assert.ok(minClamped >= 0, `clamped min = ${minClamped}`);
});
