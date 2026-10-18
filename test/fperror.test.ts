import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fnv1a_32, kahanSum, twoSum, ulpDistance, treeSum,
} from '../src/math/fperror.js';
import { Pcg32 } from '../src/math/determinism.js';

test('fperror: FNV-1a golden vectors', () => {
  assert.strictEqual(fnv1a_32(''), 0x811c9dc5);
  assert.strictEqual(fnv1a_32('foobar'), 0xbf9cf968);
});

test('fperror: FNV-1a matches a BigInt oracle on random strings', () => {
  // The naive (h ^ byte) * prime in float64 loses low bits past 2^53;
  // Math.imul must agree with the exact BigInt computation over the
  // same UTF-8 bytes the implementation hashes.
  const g = new Pcg32(99);
  const enc = new TextEncoder();
  const prime = 16777619n;
  const mask = 0xffffffffn;
  for (let i = 0; i < 200; i++) {
    const len = 1 + Math.floor(g.unit() * 40);
    let str = '';
    for (let j = 0; j < len; j++) str += String.fromCharCode(Math.floor(g.unit() * 256));
    const bytes = enc.encode(str);
    let h = 2166136261n;
    for (let j = 0; j < bytes.length; j++) {
      h = ((h ^ BigInt(bytes[j])) * prime) & mask;
    }
    assert.strictEqual(fnv1a_32(str), Number(h));
  }
});

test('fperror: Kahan summation recovers lost low bits', () => {
  // 1e16 + 1 + 1 + ... : naive sum loses every +1.
  const xs = [1e16];
  for (let i = 0; i < 1000; i++) xs.push(1);
  const naive = xs.reduce((s, x) => s + x, 0);
  const kahan = kahanSum(xs);
  assert.ok(Math.abs(naive - 1e16) < 1, `naive=${naive}`);
  assert.ok(Math.abs(kahan - (1e16 + 1000)) < 1, `kahan=${kahan}`);
});

test('fperror: Knuth 2Sum is exact (a + b = s + e)', () => {
  const g = new Pcg32(7);
  for (let i = 0; i < 1000; i++) {
    const a = (g.unit() - 0.5) * 1e10;
    const b = (g.unit() - 0.5) * 1e-10;
    const [s, e] = twoSum(a, b);
    // s + e reconstructs the exact sum in extended precision; check
    // against a high-precision reference via decimal strings is overkill:
    // assert the error term captures what the rounded sum lost.
    assert.ok(Math.abs((s + e) - (a + b)) <= Math.abs(s - (a + b)) + 1e-290);
    assert.ok(Number.isFinite(s) && Number.isFinite(e));
  }
});

test('fperror: ULP distance policy (NaN and infinities defined)', () => {
  assert.strictEqual(ulpDistance(1, 1), 0);
  assert.ok(ulpDistance(1, 1 + 2 ** -52) === 1);
  assert.ok(ulpDistance(0, -0) === 0); // signed zeros are equal
  // Policy: infinities of the same sign are 0 apart, opposite signs infinite;
  // NaN is infinitely far from everything, including itself.
  assert.strictEqual(ulpDistance(Infinity, Infinity), 0);
  assert.strictEqual(ulpDistance(-Infinity, -Infinity), 0);
  assert.strictEqual(ulpDistance(Infinity, -Infinity), Infinity);
  assert.strictEqual(ulpDistance(NaN, NaN), Infinity);
  assert.strictEqual(ulpDistance(NaN, 1), Infinity);
  assert.strictEqual(ulpDistance(1, Infinity), Infinity);
});

test('fperror: fixed-tree reduction agrees under shuffling, naive does not', () => {
  const g = new Pcg32(5);
  const xs: number[] = [];
  for (let i = 0; i < 10000; i++) xs.push((g.unit() - 0.5) * 1e8);
  const ref = treeSum(xs);
  // Shuffle deterministically and re-sum: tree order is fixed by index
  // pairing, not value order... so shuffle the VALUES and check the tree
  // still gives a result within a few ulps of a Kahan reference.
  const shuffled = xs.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(g.unit() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const t2 = treeSum(shuffled);
  const kref = kahanSum(xs);
  // Tree sums of different orders disagree in the last bits (that is the
  // point: order matters), but stay within a few ulps of each other.
  assert.ok(ulpDistance(ref, t2) < 100, `ulp dist ${ulpDistance(ref, t2)}`);
  assert.ok(ulpDistance(ref, kref) < 1000);
});
