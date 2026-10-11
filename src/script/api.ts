// script/api.ts — capability-scoped scripting API (V4 step 1).
//
// The engine's platform surface: every game script gets exactly ONE object,
// the capability object `Caps`, and nothing else. There is no raw WebGL, no
// DOM, no SceneNode, no engine internals reachable through it. The object
// graph is closed and frozen; see sandbox.ts and runtime.ts.
//
// Architectural law (Aries, Oct 10, 2026): "local generation, global
// coherence". Step 2 (world composition) will add a READ-ONLY shared
// environmental-field query to this API — a seeded global "wind" field that
// scripted entities sample as (position, time) -> vector, so independently
// built zones read as one coherent ocean. That query is NOT implemented here;
// Caps is deliberately extensible so it can be added later without breaking
// the shape (see the reserved `field` slot in the Caps interface).

/** JSON-shaped values only: the only data that may cross the script boundary. */
export type JSONValue =
  | null | boolean | number | string
  | JSONValue[] | { [k: string]: JSONValue };

/** Transform snapshot. Plain data, copied in and out — never a live reference. */
export interface TransformData {
  position: [number, number, number];
  rotation: [number, number, number, number]; // quaternion xyzw
  scale: [number, number, number];
}

/** One audio note event. Schema matches the engine's shared score format
 *  (see src/audio/driver.ts), so script-composed music plays on any renderer. */
export interface NoteEvent {
  t: number;    // seconds from loop start
  dur: number;  // seconds
  freq: number; // Hz (ignored for noise, which uses a fixed band)
  kind: 'tone' | 'noise';
  gain: number; // 0..1
  pan?: number; // -1..1, optional
}

/**
 * Entity handle. A sealed capability: closures over the engine entity, frozen
 * at creation, no prototype tricks. Scripts hold these, never SceneNodes.
 */
export interface EntityHandle {
  readonly name: string;
  readonly id: number;
  /** Get a COPY of the current transform. Mutating it changes nothing. */
  getTransform(): TransformData;
  /** Set transform from a data snapshot. NaN/Infinity rejected. */
  setTransform(t: TransformData): void;
  /** Move by a delta (convenience over get/set). */
  translate(dx: number, dy: number, dz: number): void;
  /** Tag this entity; tags are how scripts query groups. */
  setTag(tag: string): void;
  /** Current tag. */
  getTag(): string;
  /** Per-entity event handler. Returns an unsubscribe function. */
  on(event: string, handler: (data: JSONValue) => void): () => void;
  /** Emit to this entity's handlers (data is copied). */
  emit(event: string, data?: JSONValue): void;
  /** Is this handle still bound to a live entity? */
  readonly alive: boolean;
}

/** Procedural world state the script owns: entities + a key/value store. */
export interface WorldCaps {
  /** Spawn an entity. Options are plain data. */
  spawn(name: string, opts?: {
    position?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
    tag?: string;
  }): EntityHandle;
  /** Find a live entity by exact name. */
  find(name: string): EntityHandle | null;
  /** All live entities carrying a tag. */
  query(tag: string): EntityHandle[];
  /** Destroy an entity. Handles to it go dead (alive === false). */
  destroy(handle: EntityHandle): void;
  /** Read procedural world state (a copy; missing keys -> undefined). */
  state(key: string): JSONValue | undefined;
  /** Write procedural world state (value is copied in). */
  setState(key: string, value: JSONValue): void;
}

/** Global event bus: input events, game events, cross-script messages. */
export interface EventCaps {
  /** Subscribe. Returns an unsubscribe function. */
  on(event: string, handler: (data: JSONValue) => void): () => void;
  /** Emit. Data is copied; handlers cannot corrupt each other. */
  emit(event: string, data?: JSONValue): void;
}

/** One-way audio sink. Scripts compose; the host plays. */
export interface AudioCaps {
  /** Schedule one note. Validated like an untrusted score event. */
  note(e: NoteEvent): void;
  /** Schedule many at once. */
  notes(es: NoteEvent[]): void;
}

/** Read-only frame clock. Scripts never see performance.now() or Date. */
export interface TimeCaps {
  now(): number;   // engine time t (seconds)
  delta(): number; // last frame dt (seconds)
}

/**
 * Graduated capability names. A script is loaded with a GRANT SET (a subset
 * of these); every caps namespace checks its grant before acting. This is the
 * shape the First Light endgame needs: six attunement thresholds, one per
 * engine language, each granting authorship over that language's domain
 * (scene / generation / world character / behavior-rules / perception /
 * presence), up to the foundry capstone where the top tier decomposes into
 * six per-domain write controls (field.write.*). The game worker defines the
 * tiers; the runtime only needs this grant mechanism, which it has. Default
 * grant set = everything (current behavior); restricted sets make authorship
 * progressive.
 */
export type CapabilityName =
  | 'rng'
  | 'time'
  | 'world.spawn'   // spawn / destroy entities
  | 'world.query'   // find / query / transform access
  | 'world.state'   // procedural world-state store
  | 'events'        // global + per-entity event bus
  | 'audio'         // one-way audio sink
  | 'log'
  | 'field.read'    // step 2: sample the shared environmental ("wind") field
  // Endgame foundry: six per-domain write controls, one per engine language.
  // The game UI comes later; the capability shape already expresses them.
  | 'field.write.scene'     // TypeScript: terrain/sky scene parameters
  | 'field.write.genesis'   // C++/WASM: seed/noise reshape
  | 'field.write.biome'     // Python: biome/style blend
  | 'field.write.tempo'     // C#: behavior tempo
  | 'field.write.light'     // Swift: light/perception
  | 'field.write.presence'; // Kotlin: presence/physics feel

/** All capabilities: the default (full-authorship) grant set. */
export const ALL_CAPABILITIES: readonly CapabilityName[] = Object.freeze([
  'rng', 'time', 'world.spawn', 'world.query', 'world.state', 'events', 'audio',
  'log', 'field.read',
  'field.write.scene', 'field.write.genesis', 'field.write.biome',
  'field.write.tempo', 'field.write.light', 'field.write.presence',
] as const);

/**
 * The ONE object a script ever receives. Frozen. Every member is frozen.
 *
 * Reserved extension point: step 2 adds the environmental-field query here
 * as a `field` namespace — read-only sampling for lower tiers, and the six
 * per-domain write controls (field.write.scene/genesis/biome/tempo/light/
 * presence) for the endgame foundry tier. New members are additive
 * namespaces — the existing shape never changes.
 */
export interface Caps {
  /** Capabilities this script instance was granted (see CapabilityName). */
  readonly capabilities: readonly CapabilityName[];
  readonly rng: () => number; // seeded stream, unique per script instance
  readonly time: TimeCaps;
  readonly world: WorldCaps;
  readonly events: EventCaps;
  readonly audio: AudioCaps;
  readonly log: (msg: string) => void;
  // Step 2 (world composition): readonly environmental-field query goes here.
}

/** A script definition: what an external developer writes. */
export interface ScriptDef {
  /** Registry name (also seeds the script's private RNG stream). */
  name: string;
  /** Called once when the script is loaded. */
  start?: (caps: Caps) => void;
  /** Called every frame. */
  update?: (caps: Caps, dt: number, t: number) => void;
  /** Called when the script is unloaded. */
  stop?: (caps: Caps) => void;
}

/**
 * Engine-side entity backend. The runtime drives scripts through this seam;
 * the default in-memory backend needs no scene graph (tests), the demo
 * supplies a SceneNode-backed one. The backend is NEVER exposed to scripts.
 */
export interface EntityBackend {
  spawn(name: string, initial: TransformData): number; // returns entity id
  destroy(id: number): void;
  getTransform(id: number): TransformData | null; // null once destroyed
  setTransform(id: number, t: TransformData): void;
  exists(id: number): boolean;
}
