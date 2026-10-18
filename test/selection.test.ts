import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveSampleSize, aic, bic, psnr, rateReport, softThreshold,
} from '../src/inverse/selection.js';

test('selection: effective sample size discounts the resolve support', () => {
  // Lanczos support a=2 correlates over a 4x4 window.
  assert.equal(effectiveSampleSize(1600, 2), 100);
  assert.equal(effectiveSampleSize(100, 3), 100 / 36);
  assert.equal(effectiveSampleSize(1, 2), 1); // floored at 1
});

test('selection: AIC/BIC match the Gaussian formulas', () => {
  const rss = 100, n = 50, k = 3;
  assert.ok(Math.abs(aic(rss, n, k) - (n * Math.log(rss / n) + 2 * k)) < 1e-12);
  assert.ok(Math.abs(bic(rss, n, k) - (n * Math.log(rss / n) + k * Math.log(n))) < 1e-12);
  // BIC penalizes complexity more than AIC for n > e^2.
  assert.ok(bic(rss, n, k) > aic(rss, n, k));
  // Known value: rss=100, n=50, k=3 -> 50 ln 2 + 6.
  assert.ok(Math.abs(aic(rss, n, k) - (50 * Math.log(2) + 6)) < 1e-9);
});

test('selection: PSNR is 10 log10(1/MSE)', () => {
  assert.equal(psnr(0.01), 20);
  assert.ok(Math.abs(psnr(0.001) - 30) < 1e-9);
});

test('selection: soft threshold shrinks toward zero exactly', () => {
  assert.deepEqual(softThreshold([3, -1, 0.5, 0, -0.2], 1), [2, 0, 0, 0, 0]);
  assert.deepEqual(softThreshold([0.3], 0.5), [0]);
});

test('selection: rate report pairs bytes with PSNR', () => {
  const rep = rateReport(120, 880, 0.01);
  assert.equal(rep.bytesTheta, 120);
  assert.equal(rep.bytesShader, 880);
  assert.equal(rep.bytesTotal, 1000);
  assert.equal(rep.mse, 0.01);
  assert.equal(rep.psnr, 20);
});
