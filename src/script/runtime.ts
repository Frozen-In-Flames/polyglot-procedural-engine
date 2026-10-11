// script/runtime.ts — the sandboxed execution runtime.
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
import type {
  Caps, CapabilityName, EntityBackend, EntityHandle, EventCaps, JSONValue, NoteEvent,
  ScriptDef, TimeCaps, TransformData, WorldCaps, AudioCaps,
} from './api.js';
import { ALL_CAPABILITIES } from './api.js';
import {
  copyJson, deepFreeze, exportTransform, sanitizeNote, sanitizeTransform, checkFinite,
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
  spawn(_name: string, initial: TransformData): number {
    const id = this.next++;
    this.store.set(id, {
      position: [...initial.position] as [number, number, number],
      rotation: [...initial.rotation] as [number, number, number, number],
      scale: [...initial.scale] as [number, number, number],
    });
    return id;
  }
  destroy(id: number): void { this.store.delete(id); }
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
 *  Lives on the engine side of the wall: scripts never receive a SceneNode. */
export class SceneEntityBackend implements EntityBackend {
  private next = 1;
  private nodes = new Map<number, SceneNode>();
  constructor(private root: SceneNode) {}
  spawn(name: string, initial: TransformData): number {
    const id = this.next++;
    const node = new SceneNode(name)
      .setPosition(initial.position[0], initial.position[1], initial.position[2]);
    node.rotation = [initial.rotation[0], initial.rotation[1], initial.rotation[2], initial.rotation[3]];
    node.scale = [initial.scale[0], initial.scale[1], initial.scale[2]];
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
}

interface ScriptInstance {
  def: ScriptDef;
  caps: Caps;
  errored: boolean;
}

export interface RuntimeOptions {
  onLog?: (scriptName: string, msg: string) => void;
  onError?: (scriptName: string, err: unknown) => void;
}

export class ScriptRuntime {
  private backend: EntityBackend;
  private instances: ScriptInstance[] = [];
  private entities = new Map<number, EntityRecord>();
  // Engine-side handle -> record link. The entity id NEVER appears on the
  // handle object itself: a script cannot forge a handle for an entity it
  // was never given (no confused-deputy destroy via a guessed id).
  private handleRecords = new WeakMap<object, EntityRecord>();
  private globalHandlers = new Map<string, Set<{ inst: ScriptInstance; fn: Handler }>>();
  private worldState = new Map<string, JSONValue>();
  private audioSink: NoteEvent[] = [];
  private nowT = 0;
  private lastDt = 0;
  private opts: RuntimeOptions;
  /** Errors caught from script update() calls. update() continues past them. */
  readonly errors: { script: string; err: unknown }[] = [];

  constructor(
    private seed: number,
    backend?: EntityBackend,
    opts?: RuntimeOptions,
  ) {
    this.backend = backend ?? new MemoryEntityBackend();
    this.opts = opts ?? {};
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
      }) {
        require('world.spawn');
        if (typeof wname !== 'string' || !wname) throw new Error('script: spawn needs a name');
        const initial = sanitizeTransform({
          position: opts?.position ?? [0, 0, 0],
          rotation: opts?.rotation ?? [0, 0, 0, 1],
          scale: opts?.scale ?? [1, 1, 1],
        });
        const id = rt.backend.spawn(wname, initial);
        const rec: EntityRecord = {
          id, name: wname, tag: opts?.tag ?? '', alive: true,
          handlers: new Map(),
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
        const set = rt.globalHandlers.get(String(event));
        if (!set) return;
        const payload = copyJson(data ?? null) as JSONValue;
        for (const h of [...set]) {
          if (h.inst.errored) continue;
          try { h.fn(copyJson(payload) as JSONValue); }
          catch (err) { rt.reportError(h.inst.def.name, err); h.inst.errored = true; }
        }
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
    });

    const caps = deepFreeze({
      capabilities: deepFreeze([...granted] as CapabilityName[]),
      rng: (...a: []) => { require('rng'); return rng(); },
      time,
      world,
      events,
      audio,
      log: (msg: string) => { require('log'); rt.opts.onLog?.(name, String(msg)); },
    }) as Caps;
    return caps;
  }

  private recordFor(handle: EntityHandle): EntityRecord | null {
    return this.handleRecords.get(handle) ?? null;
  }

  /** Build the sealed handle for an entity record. Frozen; closures only. */
  private makeHandle(rec: EntityRecord, require: (cap: CapabilityName) => void): EntityHandle {
    const rt = this;
    const handle = {
      name: rec.name,
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
        const set = rec.handlers.get(String(event));
        if (!set) return;
        const payload = copyJson(data ?? null) as JSONValue;
        for (const fn of [...set]) fn(copyJson(payload) as JSONValue);
      },
    };
    // The handle is frozen so scripts cannot rebind or extend it; the
    // record link lives in a engine-side WeakMap, not on the object.
    const frozen = deepFreeze(handle) as unknown as EntityHandle;
    rt.handleRecords.set(frozen, rec);
    return frozen;
  }
}
