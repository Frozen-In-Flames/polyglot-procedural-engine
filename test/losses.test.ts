import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  structuralLoss, textureLoss, wasserstein2Squared, radialPowerSpectrum, hann,
} from '../src/inverse/losses.js';
import { valueNoisePcg } from '../src/math/bandlimit.js';

test('losses: structural loss is half the squared error', () => {
  const yhat = [[1, 2], [3, 4]];
  const y = [[1, 0], [3, 5]];
  assert.equal(structuralLoss(yhat, y), 0.5 * (0 + 4 + 0 + 1));
  assert.equal(structuralLoss(y, y), 0);
});

test('losses: Hann window endpoints are zero, center is one', () => {
  assert.equal(hann(0, 16), 0);
  assert.ok(Math.abs(hann(15, 16)) < 1e-12);
  assert.ok(Math.abs(hann(7.5, 16) - 1) < 1e-9);
});

test('losses: Wasserstein-2 of identical lists is zero', () => {
  assert.equal(wasserstein2Squared([3, 1, 2], [1, 2, 3]), 0);
  // Mean squared difference of sorted lists.
  assert.equal(wasserstein2Squared([0, 2], [1, 1]), 1);
});

test('losses: texture loss of an image with itself is ~zero', () => {
  const img = Array.from({ length: 16 }, (_, y) =>
    Array.from({ length: 16 }, (_, x) => valueNoisePcg(x * 0.3, y * 0.3, 0, 5)),
  );
  assert.ok(textureLoss(img, img) < 1e-9);
});

test('losses: texture loss converges where pixel L2 does not', () => {
  const N = 16;
  const noise = (freq: number, seed: number): number[][] =>
    Array.from({ length: N }, (_, y) =>
      Array.from({ length: N }, (_, x) => valueNoisePcg((x * freq) / N * 4, (y * freq) / N * 4, 0, seed)),
    );
  const target = noise(2, 5);
  const sameStats = noise(2, 9); // same frequency, different phase
  const diffFreq = noise(4, 5); // different frequency
  const texSame = textureLoss(target, sameStats);
  const texDiff = textureLoss(target, diffFreq);
  assert.ok(texSame < texDiff, `texSame=${texSame} texDiff=${texDiff}`);
  // Pixel L2 cannot see through the phase difference: both are large.
  const pixSame = structuralLoss(target, sameStats);
  const pixDiff = structuralLoss(target, diffFreq);
  assert.ok(pixSame > 1, `pixel L2 on same-stats texture should stay large, got ${pixSame}`);
  assert.ok(pixDiff > 1, `pixel L2 on diff-freq texture should stay large, got ${pixDiff}`);
});

test('losses: radial power spectrum distinguishes frequencies', () => {
  const N = 16;
  const img = (freq: number): number[][] =>
    Array.from({ length: N }, (_, y) =>
      Array.from({ length: N }, (_, x) => valueNoisePcg((x * freq) / N * 4, (y * freq) / N * 4, 0, 5)),
    );
  const pLow = radialPowerSpectrum(img(1), 6);
  const pHigh = radialPowerSpectrum(img(4), 6);
  // High-frequency noise puts more energy in the outer rings.
  const highBand = (p: number[]) => p[4] + p[5];
  assert.ok(highBand(pHigh) > highBand(pLow));
});
