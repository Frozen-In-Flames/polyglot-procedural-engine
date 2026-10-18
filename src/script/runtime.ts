// script/runtime.ts - the sandboxed execution runtime.
//
// Loads script definitions, hands each a FROZEN capability object, and drives
// them from the engine's main loop. Scripts never see the scene graph, the
// renderer, the DOM, or the backend: they see entity handles, events, a world
// state store, a seeded RNG, and a one-way audio sink.
//
// Determinism: each script instance gets a private mulberry32 stream mixed
// from the runtime seed and the script name, so script randomness matches
// engine randomness and is reproducible across runs.

import { mulberry32 } from '../geo/rng.js';
import { SceneNode } from '../scene/node.js';
import { GlobalField } from '../world/field.js';
import type { PortalLink } from '../world/portals.js';
import type { FieldDomain } from '../world/types.js';
import type {
  Caps, CapabilityName, EntityBackend, EntityHandle, EventCaps, JSONValue, NoteEvent,
  ScriptDef, TimeCaps, TransformData, WorldCaps, AudioCaps, FieldCaps, ProbeCaps,
  PortalSpawnOpts, SpawnBody, SfxSpec, MoodPartial,
} from './api.js';
import { ALL_CAPABILITIES } from './api.js';
import { buildBody } from './bodies.js';
import { Mesh } from '../scene/components.js';
import {
  copyJson, deepFreeze, exportTransform, sanitizeBody, sanitizeNote, sanitizeSfxSpec,
  sanitizeMood, sanitizeTransform, sanitizeVec3, checkFinite,
} from './sandbox.js';

/** Mix a runtime seed with a script name into a 32-bit stream seed. */
function streamSeed(seed: number, name: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 2654435761);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

const DEFAULT_TRANSFORM: TransformData = {
  position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
};

/** In-memory entity backend: no scene graph required (tests, headless). */
export class MemoryEntityBackend implements EntityBackend {
  private next = 1;
  private store = new Map<number, TransformData>();
  /** Body descriptors by entity id (tests assert on spawned bodies). */
  readonly bodies = new Map<number, SpawnBody>();
  spawn(_name: string, initial: TransformData, opts?: { body?: SpawnBody }): number {
    const id = this.next++;
    this.store.set(id, {
      position: [...initial.position] as [number, number, number],
      rotation: [...initial.rotation] as [number, number, number, number],
      scale: [...initial.scale] as [number, number, number],
    });
    if (opts?.body) this.bodies.set(id, opts.body);
    return id;
  }
  destroy(id: number): void { this.store.delete(id); this.bodies.delete(id); }
  getTransform(id: number): TransformData | null {
    const t = this.store.get(id);
    return t ? {
      position: [...t.position] as [number, number, number],
      rotation: [...t.rotation] as [number, number, number, number],
      scale: [...t.scale] as [number, number, number],
    } : null;
  }
  setTransform(id: number, t: TransformData): void {
    if (this.store.has(id)) this.store.set(id, {
      position: [...t.position] as [number, number, number],
      rotation: [...t.rotation] as [number, number, number, number],
      scale: [...t.scale] as [number, number, number],
    });
  }
  exists(id: number): boolean { return this.store.has(id); }
}

/** SceneNode-backed entity backend for the live demo / real hosts.
 *  Lives on the engine side of the wall: scripts never receive a SceneNode.
 *  When a body descriptor is supplied (step 3), the spawned node gets a
 *  visible procedural Mesh built engine-side from the descriptor. */
export class SceneEntityBackend implements EntityBackend {
  private next = 1;
  private nodes = new Map<number, SceneNode>();
  constructor(private root: SceneNode) {}
  spawn(name: string, initial: TransformData, opts?: { body?: SpawnBody }): number {
    const id = this.next++;
    const node = new SceneNode(name)
      .setPosition(initial.position[0], initial.position[1], initial.position[2]);
    node.rotation = [initial.rotation[0], initial.rotation[1], initial.rotation[2], initial.rotation[3]];
    node.scale = [initial.scale[0], initial.scale[1], initial.scale[2]];
    if (opts?.body) {
      const { geometry, material } = buildBody(opts.body);
      node.addComponent(new Mesh(geometry, material));
    }
    node.markDirty();
    this.root.addChild(node);
    this.nodes.set(id, node);
    return id;
  }
  destroy(id: number): void {
    const n = this.nodes.get(id);
    if (n) { n.parent?.removeChild(n); this.nodes.delete(id); }
  }
  getTransform(id: number): TransformData | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    return {
      position: [n.position[0], n.position[1], n.position[2]],
      rotation: [n.rotation[0], n.rotation[1], n.rotation[2], n.rotation[3]],
      scale: [n.scale[0], n.scale[1], n.scale[2]],
    };
  }
  setTransform(id: number, t: TransformData): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.setPosition(t.position[0], t.position[1], t.position[2]);
    n.rotation = [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]];
    n.scale = [t.scale[0], t.scale[1], t.scale[2]];
    n.markDirty();
  }
  exists(id: number): boolean { return this.nodes.has(id); }
}

type Handler = (data: JSONValue) => void;

interface EntityRecord {
  id: number;
  name: string;
  tag: string;
  alive: boolean;
  handlers: Map<string, Set<Handler>>;
  /** Portal link when this entity is a first-class portal (step 2). */
  portal: PortalLink | null;
}

interface ScriptInstance {
  def: ScriptDef;
  caps: Caps;
  errored: boolean;
}

export interface RuntimeOptions {
  onLog?: (scriptName: string, msg: string) => void;
  onError?: (scriptName: string, err: unknown) => void;
  /**
   * Host tap on the script event bus (step 3): called with a COPY of every
   * event a script emits through `caps.events.emit` / `handle.emit`.
   * Lets the host build HUD, progression, and achievement UI on top of
   * script events without breaking the capability wall (host -> script
   * traffic via `emit()` is not re-tapped; the host already knows it).
   */
  onEvent?: (event: string, data: JSONValue) => void;
  /**
   * Terrain-height sampler behind `caps.probe.ground` (step 3). The host
   * wires its composed world's heightfields here; when unset the probe
   * answers 0 (flat plane) so headless tests stay deterministic.
   */
  probe?: (x: number, z: number) => number;
  /**
   * The shared environmental field (step 2). When omitted, the runtime owns
   * one built from the runtime seed - every script's `field` namespace then
   * samples the same global wind. Hosts composing a world pass their
   * GlobalField here so scripts and zones share one ocean.
   */
  field?: GlobalField;
}

export class ScriptRuntime {
  private backend: EntityBackend;
  private instances: ScriptInstance[] = [];
  private entities = new Map<number, EntityRecord>();
  // Engine-side handle -> record link. Authority flows ONLY through this
  // WeakMap: no capability function accepts a raw entity id, so exposing
  // `id` on the handle (per the EntityHandle interface - scripts need
  // per-entity identity for phases, cooldowns, etc.) cannot forge authority
  // over an entity the script was never given (no confused-deputy destroy
  // via a guessed id: recordFor() simply won't resolve a foreign object).
  private handleRecords = new WeakMap<object, EntityRecord>();
  private globalHandlers = new Map<string, Set<{ inst: ScriptInstance; fn: Handler }>>();
  private worldState = new Map<string, JSONValue>();
  private audioSink: NoteEvent[] = [];
  /** One-shot SFX requests (caps.audio.sfx). Host drains, validates, plays. */
  private sfxSink: SfxSpec[] = [];
  /** Accumulated mood partials (caps.audio.mood). Host consumes per frame. */
  private moodState: MoodPartial = {};
  private nowT = 0;
  private lastDt = 0;
  private opts: RuntimeOptions;
  /** The shared environmental field behind caps.field (step 2). */
  readonly field: GlobalField;
  /** Errors caught from script update() calls. update() continues past them. */
  readonly errors: { script: string; err: unknown }[] = [];

  constructor(
    private seed: number,
    backend?: EntityBackend,
    opts?: RuntimeOptions,
  ) {
    this.backend = backend ?? new MemoryEntityBackend();
    this.opts = opts ?? {};
    this.field = this.opts.field ?? new GlobalField(undefined, seed);
  }

  // ---- loading ----

  /** Load a script: build its frozen capability object, call start().
   *  `opts.grants` restricts the capability set (graduated authorship tiers);
   *  the default is ALL_CAPABILITIES. */
  load(def: ScriptDef, opts?: { grants?: CapabilityName[] }): Caps {
    if (!def || typeof def.name !== 'string' || !def.name) {
      throw new Error('script: def needs a non-empty name');
    }
    if (this.instances.some((i) => i.def.name === def.name)) {
      throw new Error(`script: '${def.name}' is already loaded`);
    }
    const grants = opts?.grants ?? ALL_CAPABILITIES;
    const inst: ScriptInstance = { def, caps: null as unknown as Caps, errored: false };
    inst.caps = this.buildCaps(inst, grants);
    this.instances.push(inst);
    try {
      def.start?.(inst.caps);
    } catch (err) {
      this.reportError(def.name, err);
      inst.errored = true;
    }
    return inst.caps;
  }

  /** Unload a script by name: calls stop(), destroys its entities. */
  unload(name: string): void {
    const i = this.instances.findIndex((x) => x.def.name === name);
    if (i < 0) return;
    const [inst] = this.instances.splice(i, 1);
    try { inst.def.stop?.(inst.caps); } catch (err) { this.reportError(name, err); }
    for (const [ev, set] of this.globalHandlers) {
      for (const h of [...set]) if (h.inst === inst) set.delete(h);
      if (set.size === 0) this.globalHandlers.delete(ev);
    }
    for (const rec of this.entities.values()) {
      if (rec.alive) { /* entities outlive scripts; hosts may adopt them */ }
    }
  }

  get loadedNames(): string[] { return this.instances.map((i) => i.def.name); }

  // ---- main loop ----

  /** Drive every loaded script one frame. Continues past per-script errors. */
  update(dt: number, t: number): void {
    this.lastDt = dt;
    this.nowT = t;
    for (const inst of this.instances) {
      if (inst.errored) continue;
      try {
        inst.def.update?.(inst.caps, dt, t);
      } catch (err) {
        this.reportError(inst.def.name, err);
        inst.errored = true;
      }
    }
  }

  // ---- host -> script events (input, XR, game signals) ----

  /** Emit a host-side event into all subscribed scripts. */
  emit(event: string, data?: JSONValue): void {
    const set = this.globalHandlers.get(event);
    if (!set) return;
    const payload = copyJson(data ?? null) as JSONValue;
    for (const h of [...set]) {
      if (h.inst.errored) continue;
      try { h.fn(copyJson(payload) as JSONValue); }
      catch (err) { this.reportError(h.inst.def.name, err); h.inst.errored = true; }
    }
  }

  // ---- audio sink ----

  /** Host drains composed notes (e.g. into a ScorePlayer loop). Clears the sink. */
  drainAudio(): NoteEvent[] {
    const out = this.audioSink;
    this.audioSink = [];
    return out;
  }

  get pendingAudio(): number { return this.audioSink.length; }

  /** Host drains one-shot SFX requests (validates, places, plays). Clears the sink. */
  drainSfx(): SfxSpec[] {
    const out = this.sfxSink;
    this.sfxSink = [];
    return out;
  }

  get pendingSfx(): number { return this.sfxSink.length; }

  /**
   * Host consumes accumulated mood partials (one-way adaptive state push).
   * Returns the merged partial since the last call and clears it.
   */
  consumeMood(): MoodPartial {
    const out = this.moodState;
    this.moodState = {};
    return out;
  }

  // ---- host-side entity access (world loader, portals) ----
  //
  // These bypass capability grants: they are for the ENGINE side of the
  // wall (the world loader spawning portals, the handoff moving travelers),
  // never for scripts. Scripts keep using caps.world.

  /**
   * Host-side spawn. Used by the world loader for portal entities (and any
   * other engine-owned entity). Returns the engine entity id.
   */
  spawnHost(
    name: string,
    initial: TransformData,
    opts?: { tag?: string; portal?: PortalSpawnOpts; body?: SpawnBody },
  ): number {
    if (typeof name !== 'string' || !name) throw new Error('host: spawn needs a name');
    const clean = sanitizeTransform(initial);
    const body = opts?.body === undefined ? undefined : sanitizeBody(opts.body);
    const id = this.backend.spawn(name, clean, body ? { body } : undefined);
    this.entities.set(id, {
      id, name, tag: opts?.tag ?? '', alive: true,
      handlers: new Map(),
      portal: this.sanitizePortalOpts(opts?.portal),
    });
    return id;
  }

  /** Host-side: live entities as plain records (id, name, tag). */
  hostEntities(): { id: number; name: string; tag: string }[] {
    const out: { id: number; name: string; tag: string }[] = [];
    for (const rec of this.entities.values()) {
      if (rec.alive) out.push({ id: rec.id, name: rec.name, tag: rec.tag });
    }
    return out;
  }

  /** Host-side: the portal link on an entity, if it is a portal. */
  portalLink(id: number): PortalLink | null {
    const rec = this.entities.get(id);
    return rec && rec.alive ? rec.portal : null;
  }

  /**
   * Host-side: a sealed handle for a live entity by id (engine side of the
   * wall). Used by the V5 in-session build tools to bind behavior scripts
   * to entities the builder chose. Returns null when the id is not a live
   * entity. Grants are not checked here: this is the host, not a script.
   */
  hostHandle(id: number): EntityHandle | null {
    const rec = this.entities.get(id);
    if (!rec || !rec.alive) return null;
    return this.makeHandle(rec, () => undefined);
  }

  hostGetTransform(id: number): TransformData | null {
    const rec = this.entities.get(id);
    if (!rec || !rec.alive) return null;
    return this.backend.getTransform(id);
  }

  hostSetTransform(id: number, t: TransformData): void {
    const rec = this.entities.get(id);
    if (!rec || !rec.alive) return;
    this.backend.setTransform(id, sanitizeTransform(t));
  }

  // ---- internals ----

  private reportError(name: string, err: unknown): void {
    this.errors.push({ script: name, err });
    this.opts.onError?.(name, err);
  }

  private buildCaps(inst: ScriptInstance, grants: readonly CapabilityName[]): Caps {
    const rt = this;
    const name = inst.def.name;
    const granted = new Set<CapabilityName>(grants);
    const require = (cap: CapabilityName): void => {
      if (!granted.has(cap)) throw new Error(`script: capability '${cap}' not granted to '${name}'`);
    };
    const rng = mulberry32(streamSeed(this.seed, name));

    const time: TimeCaps = deepFreeze({
      now: () => { require('time'); return rt.nowT; },
      delta: () => { require('time'); return rt.lastDt; },
    });

    const world: WorldCaps = deepFreeze({
      spawn(wname: string, opts?: {
        position?: [number, number, number];
        rotation?: [number, number, number, number];
        scale?: [number, number, number];
        tag?: string;
        portal?: PortalSpawnOpts;
        body?: SpawnBody;
      }) {
        require('world.spawn');
        if (typeof wname !== 'string' || !wname) throw new Error('script: spawn needs a name');
        const initial = sanitizeTransform({
          position: opts?.position ?? [0, 0, 0],
          rotation: opts?.rotation ?? [0, 0, 0, 1],
          scale: opts?.scale ?? [1, 1, 1],
        });
        const body = opts?.body === undefined ? undefined : sanitizeBody(opts.body);
        const id = rt.backend.spawn(wname, initial, body ? { body } : undefined);
        const rec: EntityRecord = {
          id, name: wname, tag: opts?.tag ?? '', alive: true,
          handlers: new Map(),
          portal: rt.sanitizePortalOpts(opts?.portal),
        };
        rt.entities.set(id, rec);
        return rt.makeHandle(rec, require);
      },
      find(wname: string): EntityHandle | null {
        require('world.query');
        for (const rec of rt.entities.values()) {
          if (rec.alive && rec.name === wname) return rt.makeHandle(rec, require);
        }
        return null;
      },
      query(tag: string): EntityHandle[] {
        require('world.query');
        const out: EntityHandle[] = [];
        for (const rec of rt.entities.values()) {
          if (rec.alive && rec.tag === tag) out.push(rt.makeHandle(rec, require));
        }
        return deepFreeze(out);
      },
      destroy(handle: EntityHandle): void {
        require('world.spawn');
        const rec = rt.recordFor(handle);
        if (!rec || !rec.alive) return;
        rec.alive = false;
        rt.backend.destroy(rec.id);
        rt.entities.delete(rec.id);
      },
      state(key: string): JSONValue | undefined {
        require('world.state');
        return copyJson(rt.worldState.get(String(key)));
      },
      setState(key: string, value: JSONValue): void {
        require('world.state');
        rt.worldState.set(String(key), copyJson(value) as JSONValue);
      },
    });

    const events: EventCaps = deepFreeze({
      on(event: string, handler: (data: JSONValue) => void): () => void {
        require('events');
        if (typeof handler !== 'function') throw new Error('script: handler must be a function');
        const ev = String(event);
        let set = rt.globalHandlers.get(ev);
        if (!set) { set = new Set(); rt.globalHandlers.set(ev, set); }
        const entry = { inst, fn: handler };
        set.add(entry);
        return () => { set!.delete(entry); };
      },
      emit(event: string, data?: JSONValue): void {
        require('events');
        const ev = String(event);
        const payload = copyJson(data ?? null) as JSONValue;
        const set = rt.globalHandlers.get(ev);
        if (set) {
          for (const h of [...set]) {
            if (h.inst.errored) continue;
            try { h.fn(copyJson(payload) as JSONValue); }
            catch (err) { rt.reportError(h.inst.def.name, err); h.inst.errored = true; }
          }
        }
        // Host tap: the host observes script-originated traffic (HUD,
        // progression). A copy; the host cannot reach back through it.
        rt.opts.onEvent?.(ev, copyJson(payload) as JSONValue);
      },
    });

    const audio: AudioCaps = deepFreeze({
      note(e: NoteEvent): void {
        require('audio');
        rt.audioSink.push(sanitizeNote(e as unknown as {
          t: number; dur: number; freq: number; kind: string; gain: number; pan?: number;
        }) as NoteEvent);
      },
      notes(es: NoteEvent[]): void {
        if (!Array.isArray(es)) throw new Error('script: notes needs an array');
        for (const e of es) (audio as AudioCaps).note(e);
      },
      // V8 §5.2: positional one-shot request - validated, range-clamped;
      // the host places and plays. Scripts compose/request, never touch nodes.
      sfx(spec: SfxSpec): void {
        require('audio');
        rt.sfxSink.push(sanitizeSfxSpec(spec as unknown as {
          kind: string; pos: unknown; gain: number; seed?: number; freq?: number;
        }) as SfxSpec);
      },
      // V8 §5.2: one-way adaptive state push - merged by the host, clamped.
      mood(partial: MoodPartial): void {
        require('audio');
        const clean = sanitizeMood(partial as unknown as {
          energy?: number; tension?: number; brightness?: number; tempo?: number;
        });
        rt.moodState = { ...rt.moodState, ...clean };
      },
    });

    const caps = deepFreeze({
      capabilities: deepFreeze([...granted] as CapabilityName[]),
      rng: (...a: []) => { require('rng'); return rng(); },
      time,
      world,
      events,
      audio,
      log: (msg: string) => { require('log'); rt.opts.onLog?.(name, String(msg)); },
      field: rt.buildFieldCaps(require),
      probe: rt.buildProbeCaps(require),
    }) as Caps;
    return caps;
  }

  /** The `probe` capability namespace (step 3): host-registered environment
   *  queries for embodied play. The default sampler answers 0 (flat plane)
   *  so headless tests stay deterministic without a host. */
  private buildProbeCaps(require: (cap: CapabilityName) => void): ProbeCaps {
    const rt = this;
    const sampler = rt.opts.probe ?? (() => 0);
    const probe = deepFreeze({
      ground(x: number, z: number): number {
        require('probe');
        const h = sampler(checkFinite(x, 'probe.ground x'), checkFinite(z, 'probe.ground z'));
        return checkFinite(h, 'probe.ground result');
      },
    });
    return probe as ProbeCaps;
  }

  /** The `field` capability namespace (step 2): read-only wind sampling
   *  for the lower tiers, six per-domain foundry writes for the top tier. */
  private buildFieldCaps(require: (cap: CapabilityName) => void): FieldCaps {
    const rt = this;
    const field = deepFreeze({
      wind(position: [number, number, number], time: number): [number, number, number] {
        require('field.read');
        const p = sanitizeVec3(position, 'field.wind position');
        const t = checkFinite(time, 'field.wind time');
        const s = rt.field.sampleWorld(p[0], p[1], p[2], t);
        return deepFreeze([s.x, s.y, s.z]) as [number, number, number];
      },
      params(): JSONValue {
        require('field.read');
        return copyJson(rt.field.snapshot() as unknown as JSONValue) as JSONValue;
      },
      set(
        domain: 'scene' | 'genesis' | 'biome' | 'tempo' | 'light' | 'presence',
        patch: { [k: string]: JSONValue },
      ): JSONValue {
        const grant = `field.write.${domain}` as CapabilityName;
        require(grant);
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new Error('script: field.set patch must be an object');
        }
        const snap = rt.field.setDomain(domain as FieldDomain, patch as Record<string, unknown>);
        return copyJson(snap as unknown as JSONValue) as JSONValue;
      },
    });
    return field as FieldCaps;
  }

  /** Validate script-supplied portal link options (spawn path). */
  private sanitizePortalOpts(opts: PortalSpawnOpts | undefined): PortalLink | null {
    if (opts === undefined) return null;
    if (opts === null || typeof opts !== 'object') {
      throw new Error('script: portal opts must be an object');
    }
    if (typeof opts.targetZone !== 'string' || !opts.targetZone) {
      throw new Error('script: portal.targetZone must be a non-empty string');
    }
    const targetSpawn = sanitizeVec3(opts.targetSpawn, 'portal.targetSpawn');
    const radius = opts.radius === undefined ? 3 : checkFinite(opts.radius, 'portal.radius');
    if (radius <= 0) throw new Error('script: portal.radius must be > 0');
    const label = opts.label === undefined ? '' : String(opts.label);
    return { targetZone: opts.targetZone, targetSpawn, radius, label };
  }

  private recordFor(handle: EntityHandle): EntityRecord | null {
    return this.handleRecords.get(handle) ?? null;
  }

  /** Build the sealed handle for an entity record. Frozen; closures only. */
  private makeHandle(rec: EntityRecord, require: (cap: CapabilityName) => void): EntityHandle {
    const rt = this;
    const handle = {
      name: rec.name,
      id: rec.id,
      get alive(): boolean { return rec.alive; },
      getTransform(): TransformData {
        require('world.query');
        const t = rt.backend.getTransform(rec.id);
        if (!t || !rec.alive) throw new Error(`script: entity '${rec.name}' is dead`);
        return exportTransform(t);
      },
      setTransform(t: TransformData): void {
        require('world.query');
        if (!rec.alive) throw new Error(`script: entity '${rec.name}' is dead`);
        rt.backend.setTransform(rec.id, sanitizeTransform(t));
      },
      translate(dx: number, dy: number, dz: number): void {
        require('world.query');
        const cur = (handle as EntityHandle).getTransform();
        (handle as EntityHandle).setTransform({
          position: [
            cur.position[0] + checkFinite(dx, 'dx'),
            cur.position[1] + checkFinite(dy, 'dy'),
            cur.position[2] + checkFinite(dz, 'dz'),
          ],
          rotation: cur.rotation,
          scale: cur.scale,
        });
      },
      setTag(tag: string): void { require('world.query'); rec.tag = String(tag); },
      getTag(): string { require('world.query'); return rec.tag; },
      on(event: string, handler: (data: JSONValue) => void): () => void {
        require('events');
        if (typeof handler !== 'function') throw new Error('script: handler must be a function');
        const ev = String(event);
        let set = rec.handlers.get(ev);
        if (!set) { set = new Set(); rec.handlers.set(ev, set); }
        set.add(handler);
        return () => { set!.delete(handler); };
      },
      emit(event: string, data?: JSONValue): void {
        require('events');
        const ev = String(event);
        const set = rec.handlers.get(ev);
        const payload = copyJson(data ?? null) as JSONValue;
        if (set) {
          for (const fn of [...set]) fn(copyJson(payload) as JSONValue);
        }
        // Host tap (same as the global bus): the host observes
        // script-originated traffic. Entity handlers run unguarded by
        // grants here as before; the tap itself is host-side.
        rt.opts.onEvent?.(`entity:${rec.name}:${ev}`, copyJson(payload) as JSONValue);
      },
    };
    // The handle is frozen so scripts cannot rebind or extend it; the
    // record link lives in a engine-side WeakMap, not on the object.
    const frozen = deepFreeze(handle) as unknown as EntityHandle;
    rt.handleRecords.set(frozen, rec);
    return frozen;
  }
}
