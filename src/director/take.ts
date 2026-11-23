// director/take.ts - the take: a directed performance of a seeded
// world, stored as data.
//
// A take is the seed plus a sparse list of timestamped events on
// five channels (camera, light, emission, action, cue). It is NOT a
// video and NOT a per-tick input log (game/replay.ts already does
// dense input replay): it is the director's track sheet. Because
// the world is procedural and deterministic, the seed rebuilds the
// world exactly, and the pure evaluator (director/evaluate.ts)
// turns the track sheet back into the exact performance at any
// tick. A take file is plain JSON, so any port of the engine can
// read it; this module owns the format, its validation, and its
// (de)serialization.
//
// Channels, grounded in what the composed world actually exposes:
//   camera    keyframed {position, yaw, pitch} of the camera rig;
//             interpolated between keyframes.
//   light     keyframed {offset} of the emission light
//             (LivingWorld.moveEmission); interpolated.
//   emission  {on} view switch; held until the next event (step).
//   action    held character input {move, jump}, the sparse
//             counterpart of replay.ts's dense TickInput; held
//             until the next event (step).
//   cue       a named moment {name} (a sound cue, a marker); fires
//             once at its tick, never held or interpolated.

import type { Vec3 } from '../math/vec.js';

export type DirectorChannel = 'camera' | 'light' | 'emission' | 'action' | 'cue';

export interface CameraValue {
  position: Vec3;
  yaw: number;
  pitch: number;
}

export interface LightValue {
  /** Emission light offset (dx, dz), as moveEmission takes it. */
  offset: [number, number];
}

export interface EmissionValue {
  on: boolean;
}

export interface ActionValue {
  /** Wish direction (x, z), as CharacterInput.move takes it. */
  move: [number, number];
  /** Jump level for the held ticks (maps to jumpPressed/jumpHeld). */
  jump: boolean;
}

export interface CueValue {
  name: string;
}

export type DirectorValue =
  | CameraValue
  | LightValue
  | EmissionValue
  | ActionValue
  | CueValue;

export interface DirectorEvent {
  /** Tick the event lands on (integer, >= 0). */
  tick: number;
  channel: DirectorChannel;
  value: DirectorValue;
}

export interface Take {
  format: 'ppe-take';
  version: 1;
  /** World seed: rebuilds the exact world the take was performed in. */
  seed: number;
  /** Ticks per second the event times are counted in. */
  tickRate: number;
  /** Length of the take in ticks; playback stops here. */
  durationTicks: number;
  /** Sorted by (tick, channel); at most one event per (tick, channel). */
  events: DirectorEvent[];
}

export const TAKE_FORMAT = 'ppe-take';
export const TAKE_VERSION = 1;
export const DEFAULT_TICK_RATE = 60;

/** Channel defaults: the state before a channel's first event. */
export const DEFAULT_LIGHT: LightValue = { offset: [0, 0] };
export const DEFAULT_EMISSION: EmissionValue = { on: true };
export const DEFAULT_ACTION: ActionValue = { move: [0, 0], jump: false };

const CHANNELS: readonly string[] = ['camera', 'light', 'emission', 'action', 'cue'];

/** A fresh, empty take for a seed. */
export function createTake(seed: number, tickRate: number = DEFAULT_TICK_RATE): Take {
  return {
    format: TAKE_FORMAT,
    version: TAKE_VERSION,
    seed,
    tickRate,
    durationTicks: 0,
    events: [],
  };
}

/** Canonical event order: by tick, then channel name. */
export function sortEvents(events: DirectorEvent[]): DirectorEvent[] {
  return events.sort((a, b) =>
    a.tick - b.tick || (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isVec(v: unknown, n: number): boolean {
  return Array.isArray(v) && v.length === n && v.every(isFiniteNumber);
}

function validValue(channel: string, v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  switch (channel) {
    case 'camera':
      return isVec(o.position, 3) && isFiniteNumber(o.yaw) && isFiniteNumber(o.pitch);
    case 'light':
      return isVec(o.offset, 2);
    case 'emission':
      return typeof o.on === 'boolean';
    case 'action':
      return isVec(o.move, 2) && typeof o.jump === 'boolean';
    case 'cue':
      return typeof o.name === 'string' && o.name.length > 0;
    default:
      return false;
  }
}

/**
 * Validate an unknown value as a Take. Returns the take (with its
 * events canonically sorted) or throws an Error naming the first
 * problem found. Nothing is coerced: a take that parses is a take
 * the evaluator can run exactly as written.
 */
export function parseTake(data: unknown): Take {
  if (typeof data !== 'object' || data === null) {
    throw new Error('take: not an object');
  }
  const o = data as Record<string, unknown>;
  if (o.format !== TAKE_FORMAT) {
    throw new Error(`take: format must be "${TAKE_FORMAT}"`);
  }
  if (o.version !== TAKE_VERSION) {
    throw new Error(`take: unsupported version ${String(o.version)}`);
  }
  if (!isFiniteNumber(o.seed)) throw new Error('take: seed must be a finite number');
  if (!isFiniteNumber(o.tickRate) || o.tickRate <= 0) {
    throw new Error('take: tickRate must be a positive number');
  }
  if (!Number.isInteger(o.durationTicks) || (o.durationTicks as number) < 0) {
    throw new Error('take: durationTicks must be a non-negative integer');
  }
  if (!Array.isArray(o.events)) throw new Error('take: events must be an array');
  const seen = new Set<string>();
  const events: DirectorEvent[] = o.events.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`take: event ${i} is not an object`);
    }
    const e = raw as Record<string, unknown>;
    if (!Number.isInteger(e.tick) || (e.tick as number) < 0) {
      throw new Error(`take: event ${i} tick must be a non-negative integer`);
    }
    if (typeof e.channel !== 'string' || !CHANNELS.includes(e.channel)) {
      throw new Error(`take: event ${i} has unknown channel ${String(e.channel)}`);
    }
    if (!validValue(e.channel, e.value)) {
      throw new Error(`take: event ${i} (${e.channel}) has an invalid value`);
    }
    const key = `${e.tick}:${e.channel}`;
    if (seen.has(key)) {
      throw new Error(`take: duplicate event at ${key}`);
    }
    seen.add(key);
    return {
      tick: e.tick as number,
      channel: e.channel as DirectorChannel,
      value: e.value as DirectorValue,
    };
  });
  return {
    format: TAKE_FORMAT,
    version: TAKE_VERSION,
    seed: o.seed,
    tickRate: o.tickRate,
    durationTicks: o.durationTicks as number,
    events: sortEvents(events),
  };
}

/** Serialize a take to canonical JSON (events sorted, 2-space indent). */
export function serializeTake(take: Take): string {
  const canonical: Take = { ...take, events: sortEvents([...take.events]) };
  return JSON.stringify(canonical, null, 2);
}

/** Parse a take from its JSON text. Throws on any invalid content. */
export function parseTakeJson(text: string): Take {
  return parseTake(JSON.parse(text));
}
