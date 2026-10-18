import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  foveatedSteps, eccentricityDeg, reprojectRotationOnly, radialDistort,
  FOVEA_E2_DEG, type Mat3,
} from '../src/render/foveation.js';
import type { Vec3 } from '../src/math/vec.js';

test('foveation: full budget in the fovea, falling off peripherally', () => {
  assert.equal(FOVEA_E2_DEG, 2.3);
  assert.equal(foveatedSteps(0, 96), 96);
  assert.equal(foveatedSteps(2.3, 96), 48); // N0 / (1 + 1)
  const mid = foveatedSteps(10, 96);
  const far = foveatedSteps(40, 96);
  assert.ok(mid < 96 && far < mid);
  assert.ok(foveatedSteps(1000, 96) >= 1); // never zero
});

test('foveation: eccentricity is zero at the center', () => {
  assert.equal(eccentricityDeg(320, 240, 640, 480, 1), 0);
  const e = eccentricityDeg(640, 240, 640, 480, 1);
  assert.ok(e > 0);
});

test('foveation: identity reprojection is exact', () => {
  const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const x: Vec3 = [0.3, -0.2, 1];
  const y = reprojectRotationOnly(x, I, I);
  assert.ok(Math.abs(y[0] - x[0]) < 1e-12);
  assert.ok(Math.abs(y[1] - x[1]) < 1e-12);
  assert.ok(Math.abs(y[2] - x[2]) < 1e-12);
});

test('foveation: radial distortion is identity at r=0 and with zero coeffs', () => {
  assert.equal(radialDistort(0, 0.1, 0.01), 0);
  assert.equal(radialDistort(1, 0, 0), 1);
  // r' = r (1 + k1 r^2 + k2 r^4).
  assert.ok(Math.abs(radialDistort(0.5, 0.2, 0.1) - 0.5 * (1 + 0.2 * 0.25 + 0.1 * 0.0625)) < 1e-12);
});
