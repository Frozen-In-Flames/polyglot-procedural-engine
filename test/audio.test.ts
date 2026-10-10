// Tests the shared score format: validation of untrusted score JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScore } from '../src/audio/driver.js';

const good = {
  generator: 'test',
  language: 'Python',
  seed: 7,
  loop_dur: 10.0,
  events: [
    { t: 0, dur: 0.5, freq: 220, kind: 'tone', gain: 0.2 },
    { t: 0.5, dur: 0.05, freq: 6000, kind: 'noise', gain: 0.05, pan: -0.5 },
  ],
};

test('validateScore accepts a good score', () => {
  const doc = validateScore(good);
  assert.equal(doc.language, 'Python');
  assert.equal(doc.events.length, 2);
  assert.equal(doc.events[1].pan, -0.5);
});

test('validateScore accepts the real generated scores', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['python-score.json', 'csharp-score.json']) {
    const doc = validateScore(JSON.parse(readFileSync(
      `/home/hatch/workspace/xr-engine/demo/public/gen/${f}`, 'utf8')));
    assert.ok(doc.events.length > 0, f);
    assert.ok(doc.loop_dur > 0, f);
  }
});

test('validateScore rejects bad shapes', () => {
  assert.throws(() => validateScore(null), /not an object/);
  assert.throws(() => validateScore({ ...good, loop_dur: -1 }), /loop_dur/);
  assert.throws(() => validateScore({ ...good, events: [{ t: 0, dur: 0.5, freq: 220, kind: 'laser', gain: 0.2 }] }), /kind/);
  assert.throws(() => validateScore({ ...good, events: [{ t: 0, dur: 0.5, freq: 220, kind: 'tone', gain: 2 }] }), /range/);
  assert.throws(() => validateScore({ ...good, events: 'nope' }), /not an array/);
});

test('validateScore clamps pan', () => {
  const doc = validateScore({
    ...good,
    events: [{ t: 0, dur: 0.5, freq: 220, kind: 'tone', gain: 0.2, pan: 5 }],
  });
  assert.equal(doc.events[0].pan, 1);
});
