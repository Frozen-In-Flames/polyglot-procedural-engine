// build/session.ts - the in-session build session.
//
// The instrument is the V4 runtime, worn on the hands: every tool invokes
// the capability API (field.read for sampling, world.spawn for seeding, the
// sandboxed runtime for live behaviors) and never touches engine internals.
// Every tool action emits exactly one BuildOp - the schema shared with the
// distributed state graph (src/state/) - so the same op log replays to the
// same world on every node: local generation, global coherence.
//
// Op payloads validate against the state module's validatePayload, so ops
// authored here merge cleanly there. The session also ingests foreign ops
// (the merge path) without emitting, rebuilding its local brushes, rhythm
// regions, seeds, and behaviors from the log alone.

import { ScriptRuntime } from '../script/index.js';
import type { Caps, CapabilityName, EntityHandle, JSONValue } from '../script/index.js';
import type { WindSample } from '../world/wind.js';
import {
  GENESIS_PREV, fnv1aHex, opHash, validateOpShape, validatePayload,
  OP_BUILD_BRUSH, OP_BUILD_RHYTHM, OP_BUILD_SEED, OP_BUILD_SCRIPT,
} from '../state/index.js';
import type { BuildOp } from '../state/index.js';
import {
  createBrushDef, brushOffset, validateBrush,
  type BrushDef, type BrushOpts,
} from './brush.js';
import { blendRhythm, validateRhythm, type RhythmRegion, type RhythmOpts } from './rhythm.js';
import {
  ENTITY_KINDS, bodyForKind, entityNameFor, validateSeed,
  type EntityKind,
} from './entities.js';
import { compileBehavior } from './compile.js';
import { sealBehaviorCaps } from './seal.js';

export interface BuildSessionOptions {
  runtime: ScriptRuntime;
  /** Stable author id for emitted ops. Defaults to 'local-builder'. */
  actor?: string;
  /** Session/world seed carried on every op ("one seed, one ocean").
   *  Defaults to the shared field's global seed. */
  seed?: number;
  /** Called with every emitted op (the state-graph worker taps in here). */
  onOp?: (op: BuildOp) => void;
}

/** Grants for the session's internal instrument script. */
const INSTRUMENT_GRANTS: CapabilityName[] = [
  'rng', 'time', 'world.spawn', 'world.query', 'events', 'log', 'field.read',
];

/**
 * Grants for attached behavior scripts: enough to sense and act (spawn,
 * query, events, log, the shared wind), never the foundry writes - those
 * stay with the top attunement tier.
 */
const BEHAVIOR_GRANTS: CapabilityName[] = [
  'rng', 'time', 'world.spawn', 'world.query', 'events', 'log', 'field.read',
];

let instrumentSeq = 0;

function finite(n: unknown, what: string): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error(`build: ${what} must be a finite number`);
  }
  return n;
}

/** Rebuild a brush def from an op payload (the replay path). */
function brushFromPayload(p: Record<string, JSONValue>): BrushDef | null {
  const pos = p.pos;
  if (!Array.isArray(pos) || pos.length !== 3) return null;
  const id = p.id;
  if (typeof id !== 'string' || !id) return null;
  return createBrushDef(
    id,
    pos[0] as number,
    pos[2] as number,
    p.radius as number,
    p.heading as number,
    p.strength as number,
    (p.gust as number) ?? 0,
    (p.seed as number) ?? 0,
  );
}

/** Rebuild a rhythm region from an op payload (the replay path). */
function rhythmFromPayload(p: Record<string, JSONValue>): RhythmRegion | null {
  const id = p.id;
  if (typeof id !== 'string' || !id) return null;
  const pos = p.pos;
  const cx = Array.isArray(pos) && pos.length === 3 ? (pos[0] as number) : 0;
  const cz = Array.isArray(pos) && pos.length === 3 ? (pos[2] as number) : 0;
  return {
    id,
    cx, cz,
    radius: (p.radius as number) ?? 0,
    tempo: p.tempo as number,
    energy: p.energy as number,
  };
}

export class BuildSession {
  /** Stable author id on every emitted op. */
  readonly actor: string;
  /** Session/world seed on every emitted op. */
  readonly seed: number;
  /** The full local op log, in emission order. */
  readonly ops: BuildOp[] = [];

  private runtime: ScriptRuntime;
  private caps: Caps;
  private instrumentName: string;
  private onOp?: (op: BuildOp) => void;
  private lamport = 0;
  private nextSeq = 0;
  private brushes = new Map<string, BrushDef>();
  private regions = new Map<string, RhythmRegion>();
  private brushCount = 0;
  private regionCount = 0;
  private behaviorCount = 0;
  private _instrument: Instrument | null = null;

  constructor(opts: BuildSessionOptions) {
    if (!opts || !opts.runtime) throw new Error('build: a session needs a runtime');
    this.runtime = opts.runtime;
    this.actor = opts.actor ?? 'local-builder';
    if (!this.actor) throw new Error('build: actor must be a non-empty string');
    const s = opts.seed ?? this.runtime.field.snapshot().globalSeed;
    if (!Number.isInteger(s) || s < 0) {
      throw new Error('build: session seed must be a non-negative integer');
    }
    this.seed = s;
    this.onOp = opts.onOp;
    // The instrument's own capability object: the tools below invoke these
    // capabilities, never engine internals.
    this.instrumentName = `__build-instrument-${instrumentSeq++}`;
    this.caps = this.runtime.load({ name: this.instrumentName }, { grants: INSTRUMENT_GRANTS });
  }

  /** Unload the instrument script. The built world outlives the session. */
  dispose(): void {
    this.runtime.unload(this.instrumentName);
  }

  /** The fluent, gestural surface: brush.at(x, z).with({...}), etc. */
  get instrument(): Instrument {
    if (!this._instrument) this._instrument = new Instrument(this);
    return this._instrument;
  }

  // ------------------------------------------------------------------
  // Sampling: what the world reads. Pure in (seed, ops, x, y, z, t).
  // ------------------------------------------------------------------

  /** Wind at (x, y, z, t): the shared global field plus every brush layered
   *  over it. Invokes the field.read capability for the base sample. */
  sample(x: number, y: number, z: number, t: number): WindSample {
    const base = this.caps.field.wind([finite(x, 'x'), finite(y, 'y'), finite(z, 'z')], finite(t, 't'));
    let ox = 0, oy = 0, oz = 0;
    for (const b of this.brushes.values()) {
      const o = brushOffset(b, x, y, z, t);
      ox += o.x;
      oy += o.y;
      oz += o.z;
    }
    return { x: base[0] + ox, y: base[1] + oy, z: base[2] + oz };
  }

  /** Local rhythmic behavior params at (x, z): the global tempo blended
   *  with every overlapping rhythm region. */
  sampleRhythm(x: number, z: number): { beatPeriod: number; energy: number } {
    const params = this.caps.field.params() as unknown as {
      tempo: { beatPeriod: number; energy: number };
    };
    return blendRhythm(params.tempo, [...this.regions.values()], x, z);
  }

  /** Live brushes, by id. */
  get brushIds(): string[] { return [...this.brushes.keys()]; }

  /** Live rhythm regions, by id. */
  get rhythmIds(): string[] { return [...this.regions.keys()]; }

  // ------------------------------------------------------------------
  // Tools. Each emits exactly one BuildOp.
  // ------------------------------------------------------------------

  /**
   * Bend the local wind inside a disc: a seeded, bounded, deterministic
   * offset layered over the global field. Returns the brush id.
   */
  applyBrush(center: [number, number], radius: number, opts: BrushOpts): string {
    const v = validateBrush(center, radius, opts);
    const id = `brush-${this.brushCount++}`;
    // The replay key: explicit when the builder gives one, otherwise derived
    // from (session seed, brush id) - deterministic either way, and always
    // recorded on the op so replay never depends on the derivation.
    const seed = opts.seed === undefined
      ? parseInt(fnv1aHex(`${this.seed}:${id}`), 16) >>> 0
      : opts.seed >>> 0;
    this.brushes.set(id, createBrushDef(id, v.cx, v.cz, v.radius, v.heading, v.force, v.gust, seed));
    this.emitOp(OP_BUILD_BRUSH, {
      id,
      pos: [v.cx, 0, v.cz],
      radius: v.radius,
      strength: v.force,
      heading: v.heading,
      gust: v.gust,
      seed,
    });
    return id;
  }

  /**
   * Tune the local rhythm inside a disc: ember tempo and mote energy blend
   * smoothly over the global tempo. Returns the region id.
   */
  tuneRhythm(center: [number, number], radius: number, opts: RhythmOpts): string {
    const v = validateRhythm(center, radius, opts);
    const id = `rhythm-${this.regionCount++}`;
    this.regions.set(id, {
      id, cx: v.cx, cz: v.cz, radius: v.radius, tempo: v.emberTempo, energy: v.moteEnergy,
    });
    // The state graph names one primary cycle per tuning ('ember' carries
    // the tempo knob); the local disc rides along as extras for replay.
    this.emitOp(OP_BUILD_RHYTHM, {
      id,
      target: 'ember',
      tempo: v.emberTempo,
      energy: v.moteEnergy,
      pos: [v.cx, 0, v.cz],
      radius: v.radius,
    });
    return id;
  }

  /**
   * Plant a seed and let the math grow it: the body derives from (kind,
   * seed) and the entity grows through the world.spawn capability. Never
   * places an asset; there are none. Returns the entity id and name.
   */
  seedEntity(
    kind: string,
    position: [number, number, number],
    seed: number,
  ): { id: number; name: string } {
    const v = validateSeed(kind, position, seed);
    // Deterministic name; disambiguate only when the name is taken.
    let name = entityNameFor(v.kind, v.seed);
    for (let n = 2; this.caps.world.find(name); n++) {
      name = `${entityNameFor(v.kind, v.seed)}-${n}`;
    }
    const handle = this.caps.world.spawn(name, {
      position: v.position,
      body: bodyForKind(v.kind, v.seed),
      tag: 'seeded',
    });
    this.emitOp(OP_BUILD_SEED, { id: name, kind: v.kind, pos: [...v.position], seed: v.seed });
    return { id: handle.id, name };
  }

  /**
   * Compile a behavior source in a fresh realm and attach it to a living
   * entity through the V4 sandbox/runtime. The membrane (seal.ts) plus the
   * realm boundary hold: a bad script cannot escape, and a throwing script
   * is captured by the runtime without taking the session down. Returns the
   * behavior name.
   */
  attachBehavior(entityId: number, scriptSource: string, opts?: { name?: string }): string {
    if (typeof scriptSource !== 'string' || !scriptSource) {
      throw new Error('build: script source must be a non-empty string');
    }
    const handle = this.runtime.hostHandle(entityId);
    if (!handle) throw new Error(`build: no live entity with id ${entityId}`);
    const name = opts?.name ?? `behavior-${entityId}-${this.behaviorCount++}`;
    if (!name) throw new Error('build: behavior name must be a non-empty string');
    const def = compileBehavior(scriptSource, name, (caps) => sealBehaviorCaps(caps, handle));
    this.runtime.load(def, { grants: BEHAVIOR_GRANTS });
    this.emitOp(OP_BUILD_SCRIPT, { name, body: scriptSource, entity: handle.name });
    return name;
  }

  // ------------------------------------------------------------------
  // Op log: emission (local tools) and ingestion (foreign ops, no emission).
  // ------------------------------------------------------------------

  /** Emit one op for a local tool action. The chain is hash-linked and the
   *  payload self-validates, so anything emitted here merges cleanly. */
  private emitOp(op: string, payload: JSONValue): BuildOp {
    const seq = this.nextSeq++;
    this.lamport += 1;
    const prev = seq === 0 ? GENESIS_PREV : opHash(this.ops[this.ops.length - 1]);
    const full: BuildOp = {
      v: 1, op, actor: this.actor, seq, seed: this.seed, t: this.lamport, payload, prev,
    };
    const shape = validateOpShape(full);
    if (!shape.ok) throw new Error(`build: emitted a malformed op: ${shape.reason}`);
    const bad = validatePayload(op, payload);
    if (bad !== null) throw new Error(`build: emitted a malformed payload: ${bad}`);
    this.ops.push(full);
    this.onOp?.(full);
    return full;
  }

  /**
   * Apply a foreign op (the state-graph merge path): rebuild the local
   * brushes, regions, seeds, and behaviors from the log alone, emitting
   * nothing. Returns true when the op applied. Idempotent: replaying the
   * same log twice changes nothing the second time.
   */
  ingest(raw: unknown): boolean {
    const shape = validateOpShape(raw);
    if (!shape.ok) return false;
    const op = shape.op;
    if (op.seed !== this.seed) return false; // different ocean: not ours
    if (validatePayload(op.op, op.payload) !== null) return false;
    if (op.t > this.lamport) this.lamport = op.t;
    const p = op.payload as Record<string, JSONValue>;
    switch (op.op) {
      case OP_BUILD_BRUSH: {
        const def = brushFromPayload(p);
        if (!def) return false;
        this.brushes.set(def.id, def);
        return true;
      }
      case OP_BUILD_RHYTHM: {
        const region = rhythmFromPayload(p);
        if (!region) return false;
        this.regions.set(region.id, region);
        return true;
      }
      case OP_BUILD_SEED: {
        const name = p.id as string;
        const kind = p.kind as string;
        if (!(ENTITY_KINDS as readonly string[]).includes(kind)) return false;
        if (!this.caps.world.find(name)) {
          const pos = p.pos as [number, number, number];
          this.caps.world.spawn(name, {
            position: pos,
            body: bodyForKind(kind as EntityKind, p.seed as number),
            tag: 'seeded',
          });
        }
        return true;
      }
      case OP_BUILD_SCRIPT: {
        const name = p.name as string;
        if (this.runtime.loadedNames.includes(name)) return true; // already live
        const entityName = p.entity as string | undefined;
        const found: EntityHandle | null =
          typeof entityName === 'string' ? this.caps.world.find(entityName) : null;
        if (!found) return false;
        const rawHandle = this.runtime.hostHandle(found.id);
        if (!rawHandle) return false;
        const def = compileBehavior(
          p.body as string, name, (caps) => sealBehaviorCaps(caps, rawHandle),
        );
        this.runtime.load(def, { grants: BEHAVIOR_GRANTS });
        return true;
      }
      default:
        return false;
    }
  }
}

// ------------------------------------------------------------------
// The fluent instrument: gestural, not menus.
//   session.instrument.brush.at(x, z).with({ direction, force, gust, radius, seed? })
//   session.instrument.rhythm.at(x, z).with({ emberTempo, moteEnergy, radius })
//   session.instrument.seed('rock-cluster').at(x, y, z).plant(seed)
//   session.instrument.behavior.on(entityId).attach(source, { name? })
// ------------------------------------------------------------------

export class Instrument {
  constructor(private session: BuildSession) {}
  /** The field brush: shape currents, not menus. */
  get brush(): BrushInstrument { return new BrushInstrument(this.session); }
  /** Rhythm tuning: local ember tempo and mote energy. */
  get rhythm(): RhythmInstrument { return new RhythmInstrument(this.session); }
  /** Entity seeding: plant a seed and the math grows it. */
  seed(kind: string): SeedInstrument { return new SeedInstrument(this.session, kind); }
  /** Live behavior scripting on a living entity. */
  get behavior(): BehaviorInstrument { return new BehaviorInstrument(this.session); }
}

export class BrushInstrument {
  constructor(private session: BuildSession) {}
  at(x: number, z: number): BrushTarget {
    return new BrushTarget(this.session, finite(x, 'x'), finite(z, 'z'));
  }
}

export class BrushTarget {
  constructor(
    private session: BuildSession,
    private x: number,
    private z: number,
  ) {}
  with(opts: BrushOpts & { radius: number }): string {
    return this.session.applyBrush([this.x, this.z], opts.radius, opts);
  }
}

export class RhythmInstrument {
  constructor(private session: BuildSession) {}
  at(x: number, z: number): RhythmTarget {
    return new RhythmTarget(this.session, finite(x, 'x'), finite(z, 'z'));
  }
}

export class RhythmTarget {
  constructor(
    private session: BuildSession,
    private x: number,
    private z: number,
  ) {}
  with(opts: RhythmOpts & { radius: number }): string {
    return this.session.tuneRhythm([this.x, this.z], opts.radius, opts);
  }
}

export class SeedInstrument {
  constructor(private session: BuildSession, private kind: string) {}
  at(x: number, y: number, z: number): SeedTarget {
    return new SeedTarget(this.session, this.kind, finite(x, 'x'), finite(y, 'y'), finite(z, 'z'));
  }
}

export class SeedTarget {
  constructor(
    private session: BuildSession,
    private kind: string,
    private x: number,
    private y: number,
    private z: number,
  ) {}
  plant(seed: number): { id: number; name: string } {
    return this.session.seedEntity(this.kind, [this.x, this.y, this.z], seed);
  }
}

export class BehaviorInstrument {
  constructor(private session: BuildSession) {}
  on(entityId: number): BehaviorTarget {
    return new BehaviorTarget(this.session, finite(entityId, 'entityId'));
  }
}

export class BehaviorTarget {
  constructor(private session: BuildSession, private entityId: number) {}
  attach(scriptSource: string, opts?: { name?: string }): string {
    return this.session.attachBehavior(this.entityId, scriptSource, opts);
  }
}
