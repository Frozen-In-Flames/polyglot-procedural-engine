import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropSphereOnPlane } from '../src/physics/collide.js';

test('collide: sphere dropped on a plane rests at y = r within 1e-6', () => {
  // Resting contact needs a sleeping speed threshold, or it jitters forever.
  const r = 0.5;
  const y = dropSphereOnPlane({ y0: 2.0, r, g: 9.81, h: 1e-3, e: 0, sleepV: 1e-4 });
  assert.ok(Math.abs(y - r) < 1e-6, `rest y=${y}, r=${r}`);
});

test('collide: e = 1 bounce returns near the start height (tolerance O(h))', () => {
  const r = 0.5, h = 1e-3, y0 = 2.0;
  const yTop = dropSphereOnPlane({ y0, r, g: 9.81, h, e: 1, sleepV: 0, maxBounces: 1 });
  // Energy error per bounce is O(h); tolerance scales with the timestep.
  assert.ok(Math.abs(yTop - y0) < 50 * h, `return height ${yTop} vs ${y0}`);
});
