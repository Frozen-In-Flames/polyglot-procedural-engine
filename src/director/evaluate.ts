// director/evaluate.ts - the pure heart of Director mode.
//
// evaluate(take, tick) is a pure function of the take and the tick:
// no wall clock, no randomness, no hidden state. That purity is
// what makes a take replayable exactly - the same take evaluated
// at the same tick always yields the same director state, in any
// process, in any port of the engine. Playback is just evaluating
// consecutive ticks and applying the results; recording is writing
// the events evaluation will later read back.
//
// Channel semantics (see take.ts):
//   camera, light   keyframed: linear interpolation between the
//                   surrounding keyframes; before the first and
//                   after the last, the nearest keyframe is held.
//                   Camera is null until its first keyframe (a
//                   take may leave the camera to the viewer).
//   emission,       step: the last event at or before the tick,
//   action          or the channel default before the first event.
//   cue             not part of the state; cuesDue lists the cues
//                   whose tick falls in a playback window.

import { lerp, lerp3 } from '../math/vec.js';
import {
  DEFAULT_ACTION, DEFAULT_EMISSION, DEFAULT_LIGHT,
  type ActionValue, type CameraValue, type CueValue, type DirectorChannel,
  type DirectorEvent, type EmissionValue, type LightValue, type Take,
} from './take.js';

export interface DirectorState {
  camera: CameraValue | null;
  light: LightValue;
  emission: EmissionValue;
  action: ActionValue;
}

function channelEvents(take: Take, channel: DirectorChannel): DirectorEvent[] {
  return take.events.filter((e) => e.channel === channel);
}

/** Interpolated numeric channel: segment search + per-component lerp. */
function evalKeyframed<T extends object>(
  events: DirectorEvent[],
  tick: number,
  mix: (a: T, b: T, t: number) => T,
  copy: (v: T) => T,
): T | null {
  if (events.length === 0) return null;
  const first = events[0];
  const last = events[events.length - 1];
  if (tick <= first.tick) return copy(first.value as T);
  if (tick >= last.tick) return copy(last.value as T);
  for (let i = 0; i + 1 < events.length; i++) {
    const a = events[i];
    const b = events[i + 1];
    if (tick >= a.tick && tick <= b.tick) {
      const span = b.tick - a.tick;
      const t = span === 0 ? 0 : (tick - a.tick) / span;
      return mix(a.value as T, b.value as T, t);
    }
  }
  return copy(last.value as T); // unreachable given the clamps above
}

/** Step channel: last value at or before the tick, else the default. */
function evalStep<T extends object>(
  events: DirectorEvent[],
  tick: number,
  fallback: T,
  copy: (v: T) => T,
): T {
  let current = fallback;
  for (const e of events) {
    if (e.tick > tick) break;
    current = e.value as T;
  }
  return copy(current);
}

const copyCamera = (v: CameraValue): CameraValue => ({
  position: [v.position[0], v.position[1], v.position[2]],
  yaw: v.yaw,
  pitch: v.pitch,
});
const copyLight = (v: LightValue): LightValue => ({ offset: [v.offset[0], v.offset[1]] });
const copyEmission = (v: EmissionValue): EmissionValue => ({ on: v.on });
const copyAction = (v: ActionValue): ActionValue => ({
  move: [v.move[0], v.move[1]],
  jump: v.jump,
});

/**
 * The director state at a tick. Pure: same take, same tick, same
 * state, bit for bit. Returned values are fresh copies; mutating
 * them does not touch the take.
 */
export function evaluate(take: Take, tick: number): DirectorState {
  const camera = evalKeyframed<CameraValue>(
    channelEvents(take, 'camera'),
    tick,
    (a, b, t) => ({
      position: lerp3(a.position, b.position, t),
      yaw: lerp(a.yaw, b.yaw, t),
      pitch: lerp(a.pitch, b.pitch, t),
    }),
    copyCamera,
  );
  const light = evalKeyframed<LightValue>(
    channelEvents(take, 'light'),
    tick,
    (a, b, t) => ({
      offset: [lerp(a.offset[0], b.offset[0], t), lerp(a.offset[1], b.offset[1], t)],
    }),
    copyLight,
  ) ?? copyLight(DEFAULT_LIGHT);
  const emission = evalStep<EmissionValue>(
    channelEvents(take, 'emission'), tick, DEFAULT_EMISSION, copyEmission);
  const action = evalStep<ActionValue>(
    channelEvents(take, 'action'), tick, DEFAULT_ACTION, copyAction);
  return { camera, light, emission, action };
}

/**
 * Cues whose tick falls in (fromTick, toTick], in take order.
 * Playback asks once per advanced tick, so each cue fires exactly
 * once: the window is open at the start, closed at the end.
 */
export function cuesDue(
  take: Take,
  fromTick: number,
  toTick: number,
): Array<{ tick: number; cue: CueValue }> {
  const out: Array<{ tick: number; cue: CueValue }> = [];
  for (const e of take.events) {
    if (e.channel !== 'cue') continue;
    if (e.tick > fromTick && e.tick <= toTick) {
      out.push({ tick: e.tick, cue: { name: (e.value as CueValue).name } });
    }
  }
  return out;
}
