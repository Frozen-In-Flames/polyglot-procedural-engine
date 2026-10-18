// Unit tests for the Tuning Deck core (runs in node, no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParamRegistry, CurveParam } from '../src/ui/tuning.js';

test('tuning: define/get/set round-trips', () => {
  const r = new ParamRegistry();
  r.define({ name: 'warp', min: 0, max: 1, value: 0.25 });
  assert.equal(r.get('warp'), 0.25);
  r.set('warp', 0.9);
  assert.equal(r.get('warp'), 0.9);
});

test('tuning: values clamp to [min, max]', () => {
  const r = new ParamRegistry();
  r.define({ name: 'k', min: 0.02, max: 0.8, value: 0.5 });
  r.set('k', 99);
  assert.equal(r.get('k'), 0.8);
  r.set('k', -5);
  assert.equal(r.get('k'), 0.02);
});

test('tuning: step quantization', () => {
  const r = new ParamRegistry();
  r.define({ name: 's', min: 0, max: 1, value: 0, step: 0.25 });
  r.set('s', 0.3);
  assert.equal(r.get('s'), 0.25);
});

test('tuning: listeners fire on change only', () => {
  const r = new ParamRegistry();
  r.define({ name: 'a', min: 0, max: 10, value: 1 });
  let calls = 0;
  r.onChange('a', () => { calls++; });
  r.set('a', 1);
  assert.equal(calls, 0);
  r.set('a', 2);
  assert.equal(calls, 1);
});

test('tuning: snapshot and reset', () => {
  const r = new ParamRegistry();
  r.define({ name: 'x', min: 0, max: 1, value: 0.2 });
  r.define({ name: 'y', min: 0, max: 1, value: 0.8 });
  r.set('x', 0.9);
  assert.deepEqual(r.snapshot(), { x: 0.9, y: 0.8 });
  r.reset();
  assert.deepEqual(r.snapshot(), { x: 0.2, y: 0.8 });
});

test('tuning: unknown param throws', () => {
  const r = new ParamRegistry();
  assert.throws(() => r.get('nope'), /unknown param/);
});

test('tuning: curve eval is piecewise linear', () => {
  const c = new CurveParam([{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: 1, y: 0 }]);
  assert.equal(c.eval(0), 0);
  assert.equal(c.eval(0.25), 0.5);
  assert.equal(c.eval(0.5), 1);
  assert.equal(c.eval(0.75), 0.5);
  assert.equal(c.eval(1), 0);
});

test('tuning: curve clamps out-of-range input', () => {
  const c = new CurveParam();
  assert.equal(c.eval(-2), 0);
  assert.equal(c.eval(2), 1);
});

test('tuning: curve points stay sorted and bounded', () => {
  const c = new CurveParam([{ x: 0.9, y: 0.9 }]);
  c.addPoint(0.1, 2.5);
  assert.ok(c.points[0].x <= c.points[1].x);
  assert.ok(c.points.every(p => p.y <= 1));
  c.movePoint(0, -1, -1);
  assert.ok(c.points[0].x >= 0 && c.points[0].y >= 0);
});
