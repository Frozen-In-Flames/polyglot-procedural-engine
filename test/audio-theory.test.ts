import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  equalTemperament, additive, rbjLowpass, applyBiquad,
  karplusStrongFreq, polyBlepSaw, woodworthITD, distanceGain, doppler,
} from '../src/audio/theory.js';

test('audio: equal temperament A4 = 440 Hz', () => {
  assert.ok(Math.abs(equalTemperament(69) - 440) < 1e-9);
  assert.ok(Math.abs(equalTemperament(60) - 261.6255653005986) < 1e-6); // C4
});

test('audio: RBJ low-pass DC gain is 1', () => {
  const c = rbjLowpass(1000, 0.7071, 48000);
  const dc = (c.b0 + c.b1 + c.b2) / (c.a0 + c.a1 + c.a2);
  assert.ok(Math.abs(dc - 1) < 1e-12, `DC gain ${dc}`);
});

test('audio: biquad stateful filtering converges to DC gain', () => {
  const c = rbjLowpass(1000, 0.7071, 48000);
  const st = { x1: 0, x2: 0, y1: 0, y2: 0 };
  let y = 0;
  for (let i = 0; i < 5000; i++) y = applyBiquad(c, 1, st);
  assert.ok(Math.abs(y - 1) < 1e-3, `settled ${y}`);
});

test('audio: Karplus-Strong frequency ~ Fs/(N+1/2)', () => {
  const Fs = 48000, N = 100;
  const f = karplusStrongFreq(N, Fs);
  assert.ok(Math.abs(f - Fs / (N + 0.5)) < 1e-9);
});

test('audio: PolyBLEP saw matches naive saw away from the discontinuity', () => {
  const dt = 0.01;
  // Mid-phase, far from the wrap: no correction applied.
  assert.ok(Math.abs(polyBlepSaw(0.5, dt) - (2 * 0.5 - 1)) < 1e-12);
  // Bounded everywhere, including at the wrap.
  for (const t of [0, 0.001, 0.999, 1 - 1e-9]) {
    const s = polyBlepSaw(t, dt);
    assert.ok(Number.isFinite(s) && Math.abs(s) <= 2, `t=${t} s=${s}`);
  }
});

test('audio: approaching source raises observed frequency (Doppler)', () => {
  const fs = 440;
  // Source approaching at 10 m/s (v_S > 0 = toward listener), listener still.
  const fo = doppler(fs, 0, 10);
  assert.ok(fo > fs, `fo=${fo}`);
  // Receding: f_o < f_s.
  assert.ok(doppler(fs, 0, -10) < fs);
});

test('audio: Woodworth ITD is zero on-axis and positive to the side', () => {
  assert.ok(Math.abs(woodworthITD(0)) < 1e-12);
  const itd = woodworthITD(Math.PI / 2);
  assert.ok(itd > 0 && itd < 0.001, `ITD=${itd}`);
});

test('audio: distance gain is 1 inside r0 and falls as 1/r', () => {
  assert.ok(Math.abs(distanceGain(0.5, 1) - 1) < 1e-12);
  assert.ok(Math.abs(distanceGain(4, 1) - 0.25) < 1e-12);
});

test('audio: additive synthesis sums partials', () => {
  const s = additive([{ a: 1, f: 440, phi: 0 }, { a: 0.5, f: 880, phi: 0 }], 0, 48000);
  // At t=0 both sines are 0.
  assert.ok(Math.abs(s) < 1e-12);
  const s2 = additive([{ a: 1, f: 440, phi: 0 }], 1 / (4 * 440), 48000);
  assert.ok(Math.abs(s2 - 1) < 1e-9);
});
