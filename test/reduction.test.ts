import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitReduction, reduce, expand } from '../src/inverse/reduction.js';

test('reduction: z = V_k^T (theta - theta_bar) round-trips', () => {
  // Examples lie near a 2D subspace of R^4.
  const examples = [
    [1, 0, 0.1, -0.1],
    [0, 1, -0.1, 0.1],
    [1, 1, 0, 0],
    [2, 1, 0.1, -0.1],
    [1, 2, -0.1, 0.1],
  ];
  const names = ['warmth', 'air']; // CURATED MANUAL names, never automatic.
  const red = fitReduction(examples, 2, names);
  assert.deepStrictEqual(red.names, names);
  const theta = [1.5, 0.5, 0.05, -0.05];
  const z = reduce(red, theta);
  assert.strictEqual(z.length, 2);
  const back = expand(red, z);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(back[i] - theta[i]) < 0.2, `dim ${i}: ${back[i]} vs ${theta[i]}`);
  }
});

test('reduction: names are curated, never derived from data', () => {
  const examples = [
    [1, 2], [3, 4], [5, 6],
  ];
  // The API requires explicit names; there is no auto-naming path.
  assert.throws(() => fitReduction(examples, 1, []), /names/);
});
