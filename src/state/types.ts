// state/types.ts — shared types for the distributed state graph (V5 step 2).
//
// Every build action a player takes inside a session (brush stroke, rhythm
// tuning, seed planting, script edit) becomes one BuildOp in a per-actor
// op log. Nodes exchange ops directly; there is no server, no leader, no
// voting. Same seed + same op set = same world on every node.

/** JSON-shaped values only: the only data that may cross the node boundary. */
export type JSONValue =
  | null | boolean | number | string
  | JSONValue[] | { [k: string]: JSONValue };

/**
 * The canonical op record. This exact schema is shared with the in-session
 * build tools (src/build/): every tool action is serialized as one BuildOp.
 *
 *  v       schema version (always 1)
 *  op      operation name, e.g. 'build.brush'
 *  actor   stable id of the authoring player/node (compared as a string)
 *  seq     per-actor sequence number, 0-based, no gaps on the honest chain
 *  seed    the session/world seed this op belongs to ("one seed, one ocean")
 *  t       Lamport clock: author's logical time when the op was created
 *  payload op-specific JSON data (validated per op name)
 *  prev    FNV-1a hex of the canonical JSON of the actor's PREVIOUS op
 *          (for seq 0: FNV-1a hex of the literal string 'GENESIS')
 */
export interface BuildOp {
  v: 1;
  op: string;
  actor: string;
  seq: number;
  seed: number;
  t: number;
  payload: JSONValue;
  prev: string;
}

/** Op names the build tools emit. */
export const OP_BUILD_BRUSH = 'build.brush';
export const OP_BUILD_RHYTHM = 'build.rhythm';
export const OP_BUILD_SEED = 'build.seed';
export const OP_BUILD_SCRIPT = 'build.script';
/** Internal op used by tests and keepalives: advances the clock, changes nothing. */
export const OP_STATE_NOOP = 'state.noop';

/** Every op name this module accepts and reduces. */
export const KNOWN_OPS: readonly string[] = Object.freeze([
  OP_BUILD_BRUSH, OP_BUILD_RHYTHM, OP_BUILD_SEED, OP_BUILD_SCRIPT, OP_STATE_NOOP,
]);

/** Where an op sits in the deterministic total order. */
export interface OpRank {
  t: number;
  actor: string;
  seq: number;
}

/** A field-brush stroke: a local shaping of the wind's force/heading. */
export interface BrushStroke {
  id: string;
  pos: [number, number, number];
  radius: number;
  strength: number;
  heading: number; // radians, local flow direction the brush conducts
  lastOp: OpRank;  // rank of the op that last wrote this entry (conflict arbiter)
}

/** A rhythm tuning: ember tempo / mote energy for one named cycle. */
export interface RhythmTuning {
  id: string;
  target: 'ember' | 'mote' | 'gust';
  tempo: number;  // cycles per second
  energy: number; // 0..1
  lastOp: OpRank;
}

/** A planted seed: the math grows it; never a placed asset. */
export interface SeedPlanting {
  id: string;
  kind: string; // procedural kind, e.g. 'spire', 'mote-cluster', 'ridge'
  pos: [number, number, number];
  seed: number; // per-planting seed, derived from the session seed
  lastOp: OpRank;
}

/** A live behavior script edit (runs on the V4 scripting runtime). */
export interface ScriptEntry {
  name: string;
  body: string;
  lastOp: OpRank;
}

/**
 * The reduced world state. Plain JSON-serializable data only: no class
 * instances, no functions, no DOM, no WebGL. Entry arrays are kept sorted
 * by id (brushes/rhythms/seeds) or name (scripts) and appliedOps is kept
 * sorted, so two nodes that applied the same op set always hash identically.
 */
export interface WorldState {
  seed: number;
  lamport: number;
  brushes: BrushStroke[];
  rhythms: RhythmTuning[];
  seeds: SeedPlanting[];
  scripts: ScriptEntry[];
  /** Sorted list of applied op ids ('actor:seq'). Idempotency ledger. */
  appliedOps: string[];
}

/** A cheap-sync checkpoint: full reduced state plus per-actor chain heads. */
export interface StateSnapshot {
  v: 1;
  seed: number;
  state: WorldState;
  /** Per-actor chain head: last accepted seq and its op hash. */
  heads: { [actor: string]: { seq: number; hash: string } };
  lamport: number;
  /** The node's own next seq and chain tip, so authoring continues cleanly. */
  localSeq: number;
  lastHash: string;
}

/** What one merge() call did, per op. Deterministic given the same inputs. */
export interface MergeReport {
  accepted: string[];
  duplicates: string[];
  buffered: string[];
  rejected: Array<{ id: string; reason: string }>;
}
