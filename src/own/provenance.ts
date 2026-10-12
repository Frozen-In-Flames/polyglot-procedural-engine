// own/provenance.ts - queryable provenance graph over an op log (V6 step 1).
//
// V6 thesis: ownership, fully off-chain, $0 budget. Every build action a
// player takes (brush stroke, rhythm tuning, seed planting, script edit) is
// already one BuildOp in a hash-chained per-actor log (V5). This module
// answers "who made this, and who touched it since?" as pure functions over
// that log: who created each entity, in what order everyone modified it,
// and a stable content hash over the whole graph so two nodes can agree on
// ownership claims without a server.
//
// The math grows the world; this module records whose math it was.
//
// Pure core: no DOM, no WebGL, no node builtins, no new dependencies.

import type { BuildOp, JSONValue, OpRank } from '../state/types.js';
import {
  OP_BUILD_BRUSH, OP_BUILD_RHYTHM, OP_BUILD_SEED,
  OP_BUILD_SCRIPT, OP_STATE_NOOP,
} from '../state/types.js';
import { canonicalJSON, fnv1aHex, opId } from '../state/hash.js';
import { sortOps } from '../state/reduce.js';

/**
 * What kind of entity an op touched. The four canonical kinds come from the
 * build op names; ops with unknown names still get recorded, with a kind
 * derived from the op name (see entityTarget).
 */
export type EntityKind = string;

/** One entry in an entity's modification history, in total-order sequence. */
export interface ModificationRecord {
  /** Authoring actor. */
  actor: string;
  /** Op identity ('actor:seq'), matching the V5 appliedOps ledger. */
  op: string;
  /** Where the op sits in the deterministic total order. */
  opRank: OpRank;
  /** Op name, e.g. 'build.brush'. */
  opName: string;
}

/**
 * Provenance of one entity. Plain JSON-serializable data only, so the whole
 * graph is itself JSON-serializable and content-addressable.
 *
 *  entityId     the id (or script name) the ops carried
 *  entityKind   'brush' | 'rhythm' | 'seed' | 'script' (or derived for unknown ops)
 *  createdBy    actor of the first op (in total order) that touched the entity
 *  createdAt    rank of that first op
 *  modifications every op that touched the entity, chronological; the first
 *               entry IS the creation record
 *  ops          the actual BuildOp records behind the modifications,
 *               chronological; kept so queries can return them verbatim
 */
export interface EntityProvenance {
  entityId: string;
  entityKind: EntityKind;
  createdBy: string;
  createdAt: OpRank;
  modifications: ModificationRecord[];
  ops: BuildOp[];
}

/**
 * The provenance graph. Plain JSON-serializable: `entities` keys are entity
 * ids in sorted order, so two nodes that saw the same op set build
 * byte-identical graphs.
 */
export interface ProvenanceGraph {
  v: 1;
  /** Session seed: the seed of the earliest op in total order (0 when empty). */
  seed: number;
  entities: Record<string, EntityProvenance>;
}

/** Op name -> canonical entity kind. */
const KIND_BY_OP: Record<string, EntityKind> = {
  [OP_BUILD_BRUSH]: 'brush',
  [OP_BUILD_RHYTHM]: 'rhythm',
  [OP_BUILD_SEED]: 'seed',
  [OP_BUILD_SCRIPT]: 'script',
};

/** An entity an op touched, or null when the op touches nothing attributable. */
interface EntityTarget {
  kind: EntityKind;
  id: string;
}

function asRecord(v: JSONValue): Record<string, JSONValue> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, JSONValue>)
    : null;
}

function nonEmptyString(v: JSONValue | undefined): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Which entity an op touched. Known build ops read their id/name from the
 * payload. Unknown op names are still recorded: the kind is derived from
 * the op name ('build.weather' -> 'weather', anything else -> the op name
 * itself) and the id falls back from payload.id / payload.name to the op
 * name, so every op lands on a deterministic entity key.
 * `state.noop` and ops that identify no entity return null.
 */
function entityTarget(op: BuildOp): EntityTarget | null {
  if (op.op === OP_STATE_NOOP) return null;
  const kind = KIND_BY_OP[op.op];
  const rec = asRecord(op.payload);
  if (kind !== undefined) {
    // Scripts are keyed by name; everything else is keyed by id.
    const id = kind === 'script'
      ? nonEmptyString(rec?.name)
      : nonEmptyString(rec?.id);
    return id === null ? null : { kind, id };
  }
  const derivedKind = op.op.startsWith('build.') ? op.op.slice('build.'.length) : op.op;
  const id = nonEmptyString(rec?.id) ?? nonEmptyString(rec?.name) ?? op.op;
  return { kind: derivedKind, id };
}

/**
 * Walk an op log and build the provenance graph. Deterministic by
 * construction:
 *   - ops are sorted into the (t, actor, seq) total order first, so
 *     out-of-order arrival changes nothing;
 *   - replayed ops are idempotent: the first occurrence of an op id
 *     ('actor:seq') wins and later copies are skipped;
 *   - entity keys are stored in sorted order.
 */
export function buildProvenance(ops: BuildOp[]): ProvenanceGraph {
  const ordered = sortOps(ops);
  const seen = new Set<string>();
  const byId = new Map<string, EntityProvenance>();

  for (const op of ordered) {
    const id = opId(op);
    if (seen.has(id)) continue; // replayed op: identical op id already recorded
    seen.add(id);
    const target = entityTarget(op);
    if (target === null) continue;
    let entry = byId.get(target.id);
    if (entry === undefined) {
      entry = {
        entityId: target.id,
        entityKind: target.kind,
        createdBy: op.actor,
        createdAt: { t: op.t, actor: op.actor, seq: op.seq },
        modifications: [],
        ops: [],
      };
      byId.set(target.id, entry);
    }
    entry.modifications.push({
      actor: op.actor,
      op: id,
      opRank: { t: op.t, actor: op.actor, seq: op.seq },
      opName: op.op,
    });
    entry.ops.push(op);
  }

  // Deterministic key order: insert entities sorted by id.
  const entities: Record<string, EntityProvenance> = {};
  for (const key of [...byId.keys()].sort()) {
    entities[key] = byId.get(key) as EntityProvenance;
  }

  return {
    v: 1,
    seed: ordered.length > 0 ? ordered[0].seed : 0,
    entities,
  };
}

/** Provenance for one entity id, or undefined when nothing touched it. */
export function queryEntity(
  graph: ProvenanceGraph,
  entityId: string,
): EntityProvenance | undefined {
  return graph.entities[entityId];
}

/**
 * All entities created by one actor, in sorted entity-id order.
 * Creation is authorship: the first op in total order that touched the entity.
 */
export function entitiesByAuthor(
  graph: ProvenanceGraph,
  actor: string,
): EntityProvenance[] {
  return Object.keys(graph.entities)
    .sort()
    .map((id) => graph.entities[id])
    .filter((e) => e.createdBy === actor);
}

/**
 * The actual op records that created an entity: the ops touching it at its
 * earliest rank in the total order. Normally exactly one op; empty when the
 * entity is unknown. Returns the stored records verbatim.
 */
export function creationOps(
  graph: ProvenanceGraph,
  entityId: string,
): BuildOp[] {
  const entry = graph.entities[entityId];
  if (entry === undefined || entry.ops.length === 0) return [];
  const first = entry.modifications[0].opRank;
  return entry.ops.filter((op) =>
    op.t === first.t && op.actor === first.actor && op.seq === first.seq,
  );
}

/**
 * Stable content hash of the whole graph: FNV-1a over the canonical JSON.
 * Two nodes that saw the same op set get the same hash whatever order the
 * ops arrived in, so ownership claims can be compared off-chain with one
 * string.
 */
export function provenanceHash(graph: ProvenanceGraph): string {
  return fnv1aHex(canonicalJSON(graph as unknown as JSONValue));
}
