// test/director.test.ts - v3.4.0 Director mode: takes of a seeded
// world, graded end to end.
//
// A take is the seed plus a sparse track sheet of events (camera,
// light, emission, action, cue). The claims graded here:
//   - the format round-trips exactly and rejects malformed takes;
//   - the evaluator is pure and exact: interpolated keyframes hit
//     hand-computed midpoints, step channels hold, cue windows
//     have pinned edges;
//   - the determinism oracle: two fresh worlds from the take's
//     seed, stepped tick by tick under the evaluated track sheet,
//     produce identical digests at every checkpoint;
//   - the recorder writes a sparse sheet that evaluates back to
//     the performed path, and punch-in replaces only the grabbed
//     channel's future.
//
// Negative controls, each pinned to fail if the machinery lies:
//   - one mutated action event in the sheet moves the final world
//     digest (the replay is reading the sheet, not coasting);
//   - one mutated light event moves the evaluated light and the
//     world's emission center;
//   - a duplicate (tick, channel) event and a non-finite value
//     are rejected by the parser, not silently absorbed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTake, parseTake, parseTakeJson, serializeTake,
  evaluate, cuesDue,
  createRecorder, recorderFromTake, sampleCamera, sampleLight,
  sampleEmission, sampleAction, recordCue, punchIn, finishTake,
  createPlayer, play, pause, seek, advance,
  type Take,
} from '../src/director/index.js';
import { makeLivingWorld } from '../src/scene/living.js';

const SEED = 20261022;

function sampleTake(): Take {
  const take = createTake(SEED);
  take.durationTicks = 600;
  take.events = [
    { tick: 0, channel: 'camera', value: { position: [-11.5, 3.6, 4.0], yaw: -Math.PI / 2, pitch: -0.04 } },
    { tick: 300, channel: 'camera', value: { position: [-5.5, 5.6, 4.0], yaw: -Math.PI / 2 + 0.6, pitch: 0.16 } },
    { tick: 0, channel: 'light', value: { offset: [0, 0] } },
    { tick: 300, channel: 'light', value: { offset: [0.3, 0.15] } },
    { tick: 50, channel: 'action', value: { move: [0, 1], jump: false } },
    { tick: 100, channel: 'action', value: { move: [0, 1], jump: true } },
    { tick: 101, channel: 'action', value: { move: [0, 1], jump: false } },
    { tick: 200, channel: 'action', value: { move: [0, 0], jump: false } },
    { tick: 120, channel: 'cue', value: { name: 'bell' } },
    { tick: 240, channel: 'cue', value: { name: 'bell' } },
  ];
  return take;
}

test('format: round-trip is exact and canonically sorted', () => {
  const take = sampleTake();
  const back = parseTakeJson(serializeTake(take));
  assert.deepEqual(back, parseTake(take));
  const ticks = back.events.map((e) => e.tick);
  assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b));
});

test('format: malformed takes are rejected, not absorbed', () => {
  const take = sampleTake();
  assert.throws(() => parseTake({ ...take, format: 'video' }), /format/);
  assert.throws(() => parseTake({ ...take, version: 2 }), /version/);
  const dup = sampleTake();
  dup.events = [...dup.events, { tick: 0, channel: 'light', value: { offset: [1, 1] } }];
  assert.throws(() => parseTake(dup), /duplicate/);
  const nan = sampleTake();
  nan.events = [{ tick: 0, channel: 'light', value: { offset: [Number.POSITIVE_INFINITY, 0] } }];
  assert.throws(() => parseTake(nan), /invalid value/);
  const badChannel = sampleTake();
  badChannel.events = [{ tick: 0, channel: 'weather', value: {} } as never];
  assert.throws(() => parseTake(badChannel), /unknown channel/);
});

test('evaluator: interpolated keyframes hit hand-computed values', () => {
  const take = sampleTake();
  const mid = evaluate(take, 150);
  // Halfway between the tick-0 and tick-300 keyframes. Position
  // and light are exact in binary here; the angle midpoints are
  // pinned to 1e-12 (lerp's a + (b - a) * t lands one ULP off the
  // hand-typed literal, which is float noise, not drift).
  assert.deepEqual(mid.camera?.position, [-8.5, 4.6, 4.0]);
  assert.ok(Math.abs((mid.camera?.yaw ?? 0) - (-Math.PI / 2 + 0.3)) < 1e-12);
  assert.ok(Math.abs((mid.camera?.pitch ?? 0) - 0.06) < 1e-12);
  assert.deepEqual(mid.light.offset, [0.15, 0.075]);
  // Clamps: before the first keyframe holds it, after the last holds it.
  assert.deepEqual(evaluate(take, 0).camera?.position, [-11.5, 3.6, 4.0]);
  assert.deepEqual(evaluate(take, 600).light.offset, [0.3, 0.15]);
});

test('evaluator: step channels hold, defaults precede the first event', () => {
  const take = sampleTake();
  assert.deepEqual(evaluate(take, 0).action, { move: [0, 0], jump: false });
  assert.deepEqual(evaluate(take, 75).action, { move: [0, 1], jump: false });
  assert.deepEqual(evaluate(take, 100).action, { move: [0, 1], jump: true });
  assert.deepEqual(evaluate(take, 150).action, { move: [0, 1], jump: false });
  assert.equal(evaluate(take, 0).emission.on, true);
});

test('evaluator: cue window is open at the start, closed at the end', () => {
  const take = sampleTake();
  assert.deepEqual(cuesDue(take, 119, 120).map((c) => c.cue.name), ['bell']);
  assert.deepEqual(cuesDue(take, 120, 120), []);
  assert.deepEqual(cuesDue(take, 120, 240).map((c) => c.tick), [240]);
  assert.deepEqual(cuesDue(take, 0, 600).map((c) => c.tick), [120, 240]);
});

test('evaluator: pure - repeat calls agree and the take is untouched', () => {
  const take = sampleTake();
  const before = serializeTake(take);
  const a = evaluate(take, 150);
  const b = evaluate(take, 150);
  assert.deepEqual(a, b);
  a.light.offset[0] = 999; // mutating the result must not reach the take
  assert.equal(evaluate(take, 150).light.offset[0], 0.15);
  assert.equal(serializeTake(take), before);
});

/** Step a fresh world under the sheet for N ticks; digests at checkpoints. */
function runUnderSheet(take: Take, ticks: number, checkpoints: number[]): string[] {
  const world = makeLivingWorld({ seed: take.seed });
  const digests: string[] = [];
  for (let tick = 1; tick <= ticks; tick++) {
    const st = evaluate(take, tick);
    world.moveEmission(st.light.offset[0], st.light.offset[1]);
    world.stepTick({
      move: st.action.move,
      jumpPressed: st.action.jump,
      jumpHeld: st.action.jump,
    });
    if (checkpoints.includes(tick)) digests.push(world.digest());
  }
  return digests;
}

test('oracle: two worlds under one sheet digest identically', () => {
  const take = sampleTake();
  const checkpoints = [200, 400, 600];
  const a = runUnderSheet(take, 600, checkpoints);
  const b = runUnderSheet(take, 600, checkpoints);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
});

test('oracle negative control: one mutated action event moves the digest', () => {
  const take = sampleTake();
  const baseline = runUnderSheet(take, 600, [600]);
  const mutated = sampleTake();
  mutated.events = mutated.events.map((e) =>
    e.tick === 100 && e.channel === 'action'
      ? { ...e, value: { move: [0, 1], jump: false } }
      : e);
  const after = runUnderSheet(mutated, 600, [600]);
  assert.notDeepEqual(after, baseline);
});

test('oracle negative control: one mutated light event moves light and center', () => {
  const take = sampleTake();
  const mutated = sampleTake();
  mutated.events = mutated.events.map((e) =>
    e.tick === 300 && e.channel === 'light'
      ? { ...e, value: { offset: [-0.4, 0.15] } }
      : e);
  assert.notDeepEqual(evaluate(mutated, 300).light, evaluate(take, 300).light);
  const w1 = makeLivingWorld({ seed: SEED });
  const w2 = makeLivingWorld({ seed: SEED });
  const a = evaluate(take, 300).light;
  const b = evaluate(mutated, 300).light;
  w1.moveEmission(a.offset[0], a.offset[1]);
  w2.moveEmission(b.offset[0], b.offset[1]);
  assert.notDeepEqual(w2.emissionCenter(), w1.emissionCenter());
});

test('recorder: a performed path writes a sparse sheet that replays it', () => {
  const rec = createRecorder(SEED);
  // Camera glides linearly for 60 ticks, then holds still for 60.
  for (let tick = 0; tick <= 120; tick++) {
    const x = tick <= 60 ? -11.5 + tick * 0.1 : -5.5;
    sampleCamera(rec, tick, { position: [x, 3.6, 4.0], yaw: -1.5, pitch: -0.04 });
    sampleLight(rec, tick, { offset: [0, 0] });
    sampleEmission(rec, tick, { on: true });
  }
  const take = finishTake(rec, 120);
  const camEvents = take.events.filter((e) => e.channel === 'camera');
  // The glide needs keyframes along it; the still stretch adds none
  // beyond its first frame. Light and emission never changed: one
  // keyframe each.
  assert.ok(camEvents.length >= 2 && camEvents.length < 70,
    `camera keyframes: ${camEvents.length}`);
  assert.equal(take.events.filter((e) => e.channel === 'light').length, 1);
  assert.equal(take.events.filter((e) => e.channel === 'emission').length, 1);
  // The sheet evaluates back onto the performed path.
  assert.ok(Math.abs((evaluate(take, 30).camera?.position[0] ?? 0) - (-8.5)) < 0.2);
  assert.equal(evaluate(take, 120).camera?.position[0], -5.5);
});

test('recorder: punch-in replaces only the grabbed channel future', () => {
  const take = sampleTake();
  const rec = recorderFromTake(take);
  punchIn(rec, 'camera', 100);
  const after = finishTake(rec, 600);
  const cams = after.events.filter((e) => e.channel === 'camera');
  assert.deepEqual(cams.map((e) => e.tick), [0]); // the tick-300 keyframe is gone
  // Other channels are untouched.
  assert.equal(after.events.filter((e) => e.channel === 'light').length, 2);
  assert.equal(after.events.filter((e) => e.channel === 'cue').length, 2);
  // And the caller's original take was not mutated.
  assert.equal(take.events.filter((e) => e.channel === 'camera').length, 2);
});

test('recorder: cues and step changes land on their ticks', () => {
  const rec = createRecorder(SEED);
  sampleAction(rec, 0, { move: [0, 0], jump: false });
  sampleAction(rec, 10, { move: [0, 0], jump: false }); // no change, no event
  sampleAction(rec, 20, { move: [1, 0], jump: false });
  recordCue(rec, 15, 'mark');
  const take = finishTake(rec, 30);
  assert.deepEqual(
    take.events.map((e) => `${e.tick}:${e.channel}`),
    ['0:action', '15:cue', '20:action']);
});

test('player: fixed-step advance, cues fire exactly once, end clamps', () => {
  const take = sampleTake();
  const player = createPlayer(take);
  // Paused: nothing moves.
  assert.equal(advance(player, 1).ticksAdvanced, 0);
  play(player);
  let cuesSeen: number[] = [];
  // Advance in uneven frames totalling past the first cue.
  for (let i = 0; i < 40; i++) {
    const r = advance(player, 1 / 30); // 2 ticks per frame at 60 Hz
    cuesSeen.push(...r.cues.map((c) => c.tick));
  }
  assert.equal(player.tick, 80);
  assert.equal(cuesSeen.length, 0); // first cue is at 120
  for (let i = 0; i < 40; i++) {
    const r = advance(player, 1 / 30);
    cuesSeen.push(...r.cues.map((c) => c.tick));
  }
  assert.deepEqual(cuesSeen, [120]);
  // Seek drops banked time and lands exactly.
  const st = seek(player, 300);
  assert.equal(player.tick, 300);
  assert.deepEqual(st.light.offset, [0.3, 0.15]);
  assert.equal(advance(player, 0).ticksAdvanced, 0);
  // Running to the end ends playback; further advances no-op.
  play(player);
  advance(player, 100);
  assert.equal(player.tick, 600);
  assert.equal(player.ended, true);
  assert.equal(advance(player, 1).ticksAdvanced, 0);
  pause(player);
});
