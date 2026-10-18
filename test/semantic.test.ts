// Unit tests for semantic world building (runs in node, no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evalTerm, evalSlider, evalSemantics, SEMANTIC_SLIDERS,
  validateSlider, validateSemantics,
  blocks, stackBlocks, sineWarp, demoWorld, demoUniforms, live,
} from '../src/world/semantic.js';
import { evalSdf, collectUniforms } from '../src/math/sdf.js';

test('semantic: evalTerm implements g(u) = a*u^2 + b*u + c0', () => {
  const t = { coeff: 'x', a: 2, b: 3, c0: 5, note: '' };
  assert.equal(evalTerm(t, 0), 5);
  assert.equal(evalTerm(t, 1), 10);
  assert.equal(evalTerm(t, 0.5), 2 * 0.25 + 3 * 0.5 + 5);
});

test('semantic: control clamps to [0,1]', () => {
  const t = { coeff: 'x', a: 1, b: 1, c0: 0, note: '' };
  assert.equal(evalTerm(t, -1), evalTerm(t, 0));
  assert.equal(evalTerm(t, 2), evalTerm(t, 1));
});

test('semantic: every slider documents its coefficients', () => {
  assert.ok(SEMANTIC_SLIDERS.length >= 5);
  for (const s of SEMANTIC_SLIDERS) {
    assert.ok(s.name.length > 0);
    assert.ok(s.description.length > 0);
    assert.ok(s.terms.length > 0);
    for (const t of s.terms) {
      assert.ok(typeof t.a === 'number' && typeof t.b === 'number' && typeof t.c0 === 'number');
      assert.ok(t.note.length > 0, `${s.name}.${t.coeff} needs a note`);
    }
  }
});

test('semantic: Sharpness raises exponential smin k with u', () => {
  const sharp = SEMANTIC_SLIDERS.find(s => s.name === 'Sharpness')!;
  const lo = evalSlider(sharp, 0).uBlendK;
  const hi = evalSlider(sharp, 1).uBlendK;
  // Exponential smin: larger k hugs min() tighter, so crisper at u=1.
  assert.ok(hi > lo, `crisper at u=1: ${hi} > ${lo}`);
  assert.ok(lo >= 1 && hi <= 64);
});

test('semantic: evalSemantics merges bundles', () => {
  const bundle = evalSemantics(SEMANTIC_SLIDERS, { Organicness: 1, Sharpness: 0 });
  assert.ok(bundle.uDisplaceAmp > 0.5);
  assert.ok(bundle.uBlendK < 10);
});

test('semantic: demo world builds and evaluates', () => {
  const world = demoWorld();
  const u = demoUniforms();
  const d = evalSdf(world, [0, 0, 8], u).d;
  assert.ok(d > 0, 'camera start is outside the geometry');
  const inside = evalSdf(world, [0, 1, 0], u).d;
  assert.ok(inside < 2, 'near the pillar is close to surface');
});

test('semantic: demo uniforms cover every uniform the tree references', () => {
  const world = demoWorld();
  const needed = [...collectUniforms(world)];
  const have = demoUniforms();
  for (const n of needed) assert.ok(n in have, `uniform ${n} has a default`);
});

test('semantic: stacked blocks union correctly', () => {
  const w = stackBlocks([blocks.mound(), blocks.arch()], 0.01);
  const d = evalSdf(w, [0, -1.2, 0], demoUniforms()).d;
  assert.ok(d < 0, 'inside the mound');
});

test('semantic: sineWarp changes the field', () => {
  const plain = blocks.pillar().build();
  const warped = sineWarp(plain, 0.5, 1.0);
  const u = demoUniforms();
  const a = evalSdf(plain, [0.6, 2, 0], u).d;
  const b = evalSdf(warped, [0.6, 2, 0], u).d;
  assert.ok(Math.abs(a - b) > 1e-6, 'warp perturbs distances');
});

test('semantic: live() creates uniform references', () => {
  const v = live('uFoo');
  assert.deepEqual(v, { uniform: 'uFoo' });
});

test('semantic: validateSlider catches a folding term', () => {
  const bad = {
    name: 'Bad',
    description: 'folds',
    terms: [{ coeff: 'x', a: 1, b: -1, c0: 0, note: '' }],
  };
  const issues = validateSlider(bad);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].slider, 'Bad');
  assert.equal(issues[0].coeff, 'x');
  // g(u) = u^2 - u folds at u = 0.5; the message says where.
  assert.ok(issues[0].issue.includes('0.500'));
});

test('semantic: validateSlider passes monotone terms', () => {
  const inc = { name: 'I', description: '', terms: [{ coeff: 'x', a: 0.3, b: 0.5, c0: 0, note: '' }] };
  const dec = { name: 'D', description: '', terms: [{ coeff: 'x', a: -0.2, b: -0.1, c0: 1, note: '' }] };
  const flat = { name: 'F', description: '', terms: [{ coeff: 'x', a: 0, b: 2, c0: 0, note: '' }] };
  const edge = { name: 'E', description: '', terms: [{ coeff: 'x', a: 1, b: -2, c0: 0, note: '' }] };
  assert.deepEqual(validateSlider(inc), []);
  assert.deepEqual(validateSlider(dec), []);
  assert.deepEqual(validateSlider(flat), []);
  // derivative zero exactly at u = 1 is still monotone (non-strict).
  assert.deepEqual(validateSlider(edge), []);
});

test('semantic: all shipped sliders validate monotone', () => {
  const issues = validateSemantics(SEMANTIC_SLIDERS);
  assert.deepEqual(issues, []);
});
