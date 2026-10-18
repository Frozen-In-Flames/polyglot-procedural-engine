// test/acoustics.test.ts - SDF-derived room acoustics.
//
// 1. SDF Monte Carlo: sphere volume -> (4/3) pi R^3, shell area -> 4 pi R^2.
// 2. Sabine and Eyring RT60 from volume and absorption.
// 3. FDN: Householder mixing is orthogonal (A^T A = I), impulse decays
//    at -60 dB per RT60.
// 4. First-order ambisonics, SN3D/ACN convention (W,Y,Z,X): a source at
//    azimuth 0 (front, +X) lands in the X channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pcg32 } from '../src/math/determinism.js';
import type { SdfNode } from '../src/math/sdf.js';
import {
  estimateVolume, estimateArea, sabineRT60, eyringRT60,
  householderMatrix, FeedbackDelayNetwork, encodeAmbisonic,
} from '../src/audio/acoustics.js';

const SPHERE: SdfNode = { kind: 'sphere', r: 2.0 };
const BOUNDS = { min: [-3, -3, -3] as const, max: [3, 3, 3] as const };

test('acoustics: Monte Carlo volume converges to (4/3) pi R^3', () => {
  const g = new Pcg32(21);
  const v = estimateVolume(SPHERE, BOUNDS, 800000, g);
  const exact = (4 / 3) * Math.PI * 8;
  const rel = Math.abs(v - exact) / exact;
  assert.ok(rel < 0.01, `volume ${v} vs ${exact}`);
});

test('acoustics: Monte Carlo area converges to 4 pi R^2', () => {
  const g = new Pcg32(22);
  const a = estimateArea(SPHERE, BOUNDS, 400000, 0.1, g);
  const exact = 4 * Math.PI * 4;
  const rel = Math.abs(a - exact) / exact;
  assert.ok(rel < 0.05, `area ${a} vs ${exact}`);
});

test('acoustics: Sabine and Eyring RT60', () => {
  const V = 200, S = 180, alpha = 0.2;
  const A = S * alpha;
  const sabine = sabineRT60(V, A);
  const eyring = eyringRT60(V, S, alpha);
  // Sabine: 0.161 V/A. Eyring: 0.161 V/(-S ln(1-alpha)); Eyring < Sabine.
  assert.ok(Math.abs(sabine - (0.161 * V) / A) < 1e-12);
  assert.ok(eyring < sabine, 'Eyring should be below Sabine');
  assert.ok(eyring > 0.5 * sabine, 'but not absurdly so');
  // Small alpha: Eyring -> Sabine.
  const eyringSmall = eyringRT60(V, S, 0.01);
  const sabineSmall = sabineRT60(V, S * 0.01);
  assert.ok(Math.abs(eyringSmall - sabineSmall) / sabineSmall < 0.01);
});

test('acoustics: Householder mixing is orthogonal', () => {
  for (const n of [4, 8, 16]) {
    const A = householderMatrix(n);
    // A^T A = I.
    let worst = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += A[k][i] * A[k][j];
        worst = Math.max(worst, Math.abs(s - (i === j ? 1 : 0)));
      }
    }
    assert.ok(worst < 1e-14, `n=${n} worst ${worst}`);
  }
});

test('acoustics: FDN decays at -60 dB per RT60', () => {
  const rt60 = 1.0;
  const sampleRate = 48000;
  const fdn = new FeedbackDelayNetwork([1789, 1993, 2137, 2371], rt60, sampleRate);
  const n = sampleRate * 2; // 2 seconds
  const out = new Array(n).fill(0);
  // Inject impulse into first delay line, run, measure energy in windows.
  fdn.impulse(1.0);
  for (let i = 0; i < n; i++) out[i] = fdn.tick();
  function energyDb(t0: number, t1: number): number {
    let e = 0;
    for (let i = Math.floor(t0 * sampleRate); i < Math.floor(t1 * sampleRate); i++) e += out[i] * out[i];
    return 10 * Math.log10(e + 1e-30);
  }
  const e1 = energyDb(0.1, 0.3);
  const e2 = energyDb(1.1, 1.3);
  const slope = (e2 - e1) / 1.0; // dB per second; expect -60
  assert.ok(Math.abs(slope + 60) < 6, `decay slope ${slope} dB/s, expected -60`);
});

test('acoustics: ambisonic encode, azimuth 0 lands in X (SN3D/ACN)', () => {
  // SN3D/ACN ordering: (W, Y, Z, X). Source at azimuth 0, elevation 0
  // (front, +X): W=1, Y=0, Z=0, X=1.
  const [w, y, z, x] = encodeAmbisonic(0, 0);
  assert.ok(Math.abs(w - 1) < 1e-15);
  assert.ok(Math.abs(y) < 1e-15, `Y=${y}`);
  assert.ok(Math.abs(z) < 1e-15, `Z=${z}`);
  assert.ok(Math.abs(x - 1) < 1e-15, `X=${x}`);
  // Azimuth 90 deg (left, +Y): Y=1.
  const [, y2, , x2] = encodeAmbisonic(Math.PI / 2, 0);
  assert.ok(Math.abs(y2 - 1) < 1e-12);
  assert.ok(Math.abs(x2) < 1e-12);
});
