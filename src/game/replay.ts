// game/replay.ts - deterministic input recording and replay.
//
// A replay log is the seed plus the per-tick input structs. Replaying
// feeds the recorded inputs through the same tick function from a fresh
// initial state; because the tick function is pure (no wall clock, no
// Math.random), the replayed state is bit-identical. Equality is checked
// with the ULP distance from math/fperror: 0 means identical.

import type { CharacterInput } from './character.js';

/** Per-tick input: physics input plus look delta for the camera. */
export interface TickInput extends CharacterInput {
  /** Look delta (yaw, pitch) for this tick; recorded, applied by the camera. */
  look: [number, number];
}

export interface ReplayLog {
  seed: number;
  inputs: TickInput[];
}

/** Fresh log for a recording session. */
export function createLog(seed: number): ReplayLog {
  return { seed, inputs: [] };
}

/** Record one tick of input (copied, so later mutation of the caller's object is safe). */
export function recordTick(log: ReplayLog, input: TickInput): void {
  log.inputs.push({
    move: [input.move[0], input.move[1]],
    jumpPressed: input.jumpPressed,
    jumpHeld: input.jumpHeld,
    look: [input.look[0], input.look[1]],
  });
}

/**
 * Replay a log: build a fresh state with init, feed every recorded input
 * through tick in order, return the final state.
 */
export function replayLog<S>(
  log: ReplayLog,
  init: () => S,
  tick: (s: S, input: TickInput) => void,
): S {
  const s = init();
  for (const input of log.inputs) tick(s, input);
  return s;
}
