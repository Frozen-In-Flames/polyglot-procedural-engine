// director/player.ts - playback of a take.
//
// The player holds only a playhead. advance() banks frame time in
// an accumulator (the same fixed-step discipline as game/loop.ts),
// moves the playhead whole ticks at the take's tick rate, and for
// each tick asks the pure evaluator for the state and cuesDue for
// the cues in the window just crossed. Applying the state to a
// world and a camera rig is the caller's job: the player never
// touches a world, which keeps playback itself testable headlessly
// and identical in every host.

import { cuesDue, evaluate, type DirectorState } from './evaluate.js';
import type { CueValue, Take } from './take.js';

export interface Player {
  take: Take;
  /** Current playhead tick. */
  tick: number;
  /** Seconds banked toward the next tick. */
  acc: number;
  playing: boolean;
  /** Set once the playhead reaches durationTicks; advance() then no-ops. */
  ended: boolean;
}

export interface AdvanceResult {
  /** Director state at the playhead after advancing. */
  state: DirectorState;
  /** Cues crossed by this advance, in order, each exactly once. */
  cues: Array<{ tick: number; cue: CueValue }>;
  /** Ticks the playhead moved during this advance. */
  ticksAdvanced: number;
}

/** A fresh player at tick 0, paused. */
export function createPlayer(take: Take): Player {
  return { take, tick: 0, acc: 0, playing: false, ended: false };
}

export function play(player: Player): void {
  if (!player.ended) player.playing = true;
}

export function pause(player: Player): void {
  player.playing = false;
}

/** Move the playhead directly. Clears the ended flag when the
 *  target is before the end; banked time is dropped so a seek
 *  never bursts catch-up ticks. */
export function seek(player: Player, tick: number): DirectorState {
  const target = Math.max(0, Math.min(Math.floor(tick), player.take.durationTicks));
  player.tick = target;
  player.acc = 0;
  player.ended = target >= player.take.durationTicks;
  if (player.ended) player.playing = false;
  return evaluate(player.take, player.tick);
}

/**
 * Advance playback by frameDt seconds of wall time. When paused
 * or ended, returns the current state with no cues and no motion.
 * Cues are collected per crossed tick window, so a slow frame
 * that crosses several ticks still fires each cue exactly once,
 * in order.
 */
export function advance(player: Player, frameDt: number): AdvanceResult {
  const state0 = evaluate(player.take, player.tick);
  if (!player.playing || player.ended) {
    return { state: state0, cues: [], ticksAdvanced: 0 };
  }
  const step = 1 / player.take.tickRate;
  player.acc += Math.max(0, frameDt);
  const cues: Array<{ tick: number; cue: CueValue }> = [];
  let advanced = 0;
  while (player.acc >= step && player.tick < player.take.durationTicks) {
    const from = player.tick;
    player.tick += 1;
    player.acc -= step;
    advanced += 1;
    cues.push(...cuesDue(player.take, from, player.tick));
  }
  if (player.tick >= player.take.durationTicks) {
    player.ended = true;
    player.playing = false;
    player.acc = 0;
  }
  return { state: evaluate(player.take, player.tick), cues, ticksAdvanced: advanced };
}
