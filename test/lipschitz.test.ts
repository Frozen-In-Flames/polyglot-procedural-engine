import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pcg32 } from '../src/math/determinism.js';
import {
  evalSdf, lipschitzBound, type SdfNode,
} from '../src/math/sdf.js';
import type { Vec3 } from '../src/math/vec.js';
import { localLipschitzBound, countLipschitzViolations } from '../src/math/lipschitz.js';

function randPoint(g: Pcg32, r: number): Vec3 {
  return [(g.unit() * 2 - 1) * r, (g.unit() * 2 - 1) * r, (g.unit() * 2 - 1) * r];
}

test('lipschitz: polySmin matches the polynomial formula', () => {
  // smin(a,b) = min(a,b) - (k/4) h^2, h = max(k-|a-b|,0)/k.
  const node: SdfNode = {
    kind: 'polySmin', k: 0.5,
    children: [{ kind: 'sphere', r: 1 }, { kind: 'sphere', r: 1, c: [0.8, 0, 0] }],
  };
  const p: Vec3 = [0.4, 0.2, 0];
  const a = evalSdf({ kind: 'sphere', r: 1 }, p).d;
  const b = evalSdf({ kind: 'sphere', r: 1, c: [0.8, 0, 0] }, p).d;
  const h = Math.max(0.5 - Math.abs(a - b), 0) / 0.5;
  const expected = Math.min(a, b) - (0.5 / 4) * h * h;
  assert.ok(Math.abs(evalSdf(node, p).d - expected) < 1e-12);
  // Bound stays max(L_a, L_b), never the sum.
  assert.equal(lipschitzBound(node), 1);
});

test('lipschitz: |f(a)-f(b)| <= L ||a-b|| never fails (zero violations)', () => {
  const fields: Array<[string, SdfNode]> = [
    ['sphere', { kind: 'sphere', r: 1 }],
    ['twist', { kind: 'twist', k: 0.8, child: { kind: 'box', b: [1, 1, 1] } }],
    ['displace', { kind: 'displace', amp: 0.2, freq: 1.5, seed: 7, child: { kind: 'sphere', r: 1 } }],
    ['polySmin', {
      kind: 'polySmin', k: 0.4,
      children: [{ kind: 'sphere', r: 1 }, { kind: 'sphere', r: 1, c: [1, 0, 0] }],
    }],
  ];
  for (const [name, f] of fields) {
    const L = lipschitzBound(f, {}, { extent: 4 });
    const v = countLipschitzViolations(f, L, 2000, 4, 1234);
    assert.equal(v, 0, `${name}: ${v} violations against L=${L}`);
  }
});

test('lipschitz: local bound is tighter than the global composed bound', () => {
  const f: SdfNode = { kind: 'twist', k: 1.5, child: { kind: 'sphere', r: 1 } };
  const box = { min: [-1, -1, -1] as Vec3, max: [1, 1, 1] as Vec3 };
  const global = lipschitzBound(f, {}, { extent: 8 });
  const local = localLipschitzBound(f, box);
  assert.ok(local < global, `local=${local} global=${global}`);
  assert.ok(local >= 1);
  // Still zero violations for pairs inside the box.
  const v = countLipschitzViolations(f, local, 2000, 1, 99, box);
  assert.equal(v, 0);
});
