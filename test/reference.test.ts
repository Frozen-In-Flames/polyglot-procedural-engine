import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whiteFurnace } from '../src/render/reference.js';

test('reference: white furnace never exceeds 1 (single-scatter GGX)', () => {
  for (const a of [0.1, 0.3, 0.5]) {
    const { mean, se } = whiteFurnace(a, 1.0, 200000, 21);
    assert.ok(mean <= 1 + 5 * se, `a=${a} E=${mean} se=${se}`);
    assert.ok(mean > 0.5, `a=${a} E=${mean} unexpectedly low`);
  }
  // At a=0.8 single-scatter loses most energy; pin it below 1, above 0.2.
  const { mean, se } = whiteFurnace(0.8, 1.0, 200000, 21);
  assert.ok(mean <= 1 + 5 * se, `a=0.8 E=${mean} se=${se}`);
  assert.ok(mean > 0.2, `a=0.8 E=${mean} unexpectedly low`);
});

test('reference: albedo falls below 1 at high roughness (no multiple scattering)', () => {
  // Documented expectation: single-scatter GGX loses energy at high
  // roughness; the reference does NOT compensate, so the test pins the
  // shortfall rather than hiding it.
  const { mean, se } = whiteFurnace(1.0, 1.0, 200000, 22);
  assert.ok(mean < 1 - 5 * se, `a=1 E=${mean} should be well below 1`);
  assert.ok(mean > 0.3, `a=1 E=${mean} unexpectedly low`);
});
