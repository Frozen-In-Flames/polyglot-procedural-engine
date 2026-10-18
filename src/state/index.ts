// state/index.ts - public surface of the V5 distributed-state-graph module.
//
// THE ORDER LAW (conflict resolution without authority):
//   There is no central server, no leader, no voting. Every node accepts ops
//   into per-actor hash-chained logs, then the total order sorts everything
//   by (t, actor, seq): Lamport time first, actor id compared as a plain
//   string, per-actor sequence number last. THAT ORDER IS THE RESOLUTION.
//   When two ops touch the same target, the one that sorts later wins, on
//   every node, every time. Same seed + same op set = same world. That is
//   how 100 developers share one ocean: local generation, global coherence.
//
// Guarantees:
//   - Idempotent: applying the same op twice changes nothing (appliedOps
//     ledger of 'actor:seq' ids).
//   - Order-independent: each entry remembers its winning op's rank, so ops
//     reduce to the same state whatever order they arrive in.
//   - Tamper-evident: per-actor prev chains; a broken chain is rejected and
//     the break is visible in the MergeReport.
//   - Cheap sync: snapshot()/restore() capture full state + chain heads, so
//     a node can catch up from a checkpoint plus the tail of the log.
//   - Pure core: hash, order, validation, and reduction are pure functions
//     with zero DOM/WebGL access. Only StateNode holds mutable session state.

export type {
  JSONValue, BuildOp, OpRank,
  BrushStroke, RhythmTuning, SeedPlanting, ScriptEntry,
  WorldState, StateSnapshot, MergeReport,
} from './types.js';
export {
  OP_BUILD_BRUSH, OP_BUILD_RHYTHM, OP_BUILD_SEED, OP_BUILD_SCRIPT,
  OP_STATE_NOOP, KNOWN_OPS,
} from './types.js';
export { canonicalJSON, fnv1aHex, GENESIS_PREV, opId, opHash, stateHash } from './hash.js';
export { createOp, validateOpShape, validatePayload } from './ops.js';
export { compareOps, sortOps, rankOf, opWins, emptyState, applyOp } from './reduce.js';
export { StateNode } from './node.js';
