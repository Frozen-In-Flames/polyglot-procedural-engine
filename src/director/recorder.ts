// director/recorder.ts - writing a take by performing it.
//
// The recorder samples live state (the camera rig, the light, the
// switches, the character input) once per tick and writes a
// keyframe only when a channel actually moved: interpolated
// channels compare against the last written keyframe with a small
// epsilon, step channels write on change. The result is a sparse
// track sheet that evaluate() reads back as the performance.
//
// Punch-in is the virtual-production move: during playback of an
// existing take, the director grabs a channel and performs it
// live. punchIn truncates that channel's scripted future (events
// after the punch tick) and the following samples write the new
// performance in its place. Other channels keep playing the
// script untouched.

import {
  createTake, sortEvents,
  type ActionValue, type CameraValue, type DirectorChannel, type DirectorValue,
  type EmissionValue, type LightValue, type Take,
} from './take.js';

export interface Recorder {
  take: Take;
  /** Last keyframe value written per channel (the epsilon reference). */
  last: Partial<Record<DirectorChannel, DirectorValue>>;
}

/** A recorder over a fresh take for a seed. */
export function createRecorder(seed: number, tickRate?: number): Recorder {
  return { take: createTake(seed, tickRate), last: {} };
}

/** A recorder that punches into an existing take (a copy; the
 *  caller's take is not mutated until they adopt recorder.take). */
export function recorderFromTake(take: Take): Recorder {
  const copy: Take = {
    ...take,
    events: take.events.map((e) => ({ ...e, value: e.value })),
  };
  return { take: copy, last: {} };
}

function upsert(rec: Recorder, tick: number, channel: DirectorChannel, value: DirectorValue): void {
  const events = rec.take.events;
  const existing = events.findIndex((e) => e.tick === tick && e.channel === channel);
  if (existing >= 0) events[existing] = { tick, channel, value };
  else events.push({ tick, channel, value });
  rec.last[channel] = value;
}

function near(a: number[], b: number[], eps: number): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= eps);
}

/** Sample the camera. Writes a keyframe on first sample, or when
 *  position/yaw/pitch moved past eps since the last keyframe. */
export function sampleCamera(rec: Recorder, tick: number, value: CameraValue, eps = 1e-4): void {
  const prev = rec.last.camera as CameraValue | undefined;
  if (prev
    && near(prev.position, value.position, eps)
    && Math.abs(prev.yaw - value.yaw) <= eps
    && Math.abs(prev.pitch - value.pitch) <= eps) return;
  upsert(rec, tick, 'camera', {
    position: [value.position[0], value.position[1], value.position[2]],
    yaw: value.yaw,
    pitch: value.pitch,
  });
}

/** Sample the light offset. Same epsilon rule as the camera. */
export function sampleLight(rec: Recorder, tick: number, value: LightValue, eps = 1e-4): void {
  const prev = rec.last.light as LightValue | undefined;
  if (prev && near(prev.offset, value.offset, eps)) return;
  upsert(rec, tick, 'light', { offset: [value.offset[0], value.offset[1]] });
}

/** Sample the emission switch. Writes only on change. */
export function sampleEmission(rec: Recorder, tick: number, value: EmissionValue): void {
  const prev = rec.last.emission as EmissionValue | undefined;
  if (prev && prev.on === value.on) return;
  upsert(rec, tick, 'emission', { on: value.on });
}

/** Sample the held character input. Writes only on change. */
export function sampleAction(rec: Recorder, tick: number, value: ActionValue): void {
  const prev = rec.last.action as ActionValue | undefined;
  if (prev && prev.jump === value.jump
    && prev.move[0] === value.move[0] && prev.move[1] === value.move[1]) return;
  upsert(rec, tick, 'action', { move: [value.move[0], value.move[1]], jump: value.jump });
}

/** Record a cue at a tick. Cues always write (they are moments). */
export function recordCue(rec: Recorder, tick: number, name: string): void {
  rec.take.events.push({ tick, channel: 'cue', value: { name } });
  sortEvents(rec.take.events);
}

/**
 * Punch in on a channel at a tick: drop that channel's events
 * after the tick, and forget its last-written value so the next
 * sample always writes. The scripted past (events at or before
 * the tick) is kept; the performed future replaces the rest.
 */
export function punchIn(rec: Recorder, channel: DirectorChannel, tick: number): void {
  rec.take.events = rec.take.events.filter(
    (e) => !(e.channel === channel && e.tick > tick));
  delete rec.last[channel];
}

/** Close the take at a duration and sort its events canonically. */
export function finishTake(rec: Recorder, durationTicks: number): Take {
  rec.take.durationTicks = durationTicks;
  rec.take.events = sortEvents(rec.take.events);
  return rec.take;
}
