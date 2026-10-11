// state/reduce.ts — the deterministic total order and the pure reducer (V5 step 2).
//
// THE ORDER LAW (the whole conflict-resolution story):
//   There is no central authority, no voting, no leader election. Every node
//   sorts every accepted op by (t, actor, seq): Lamport time first, then the
//   actor id compared as a plain string, then the per-actor sequence number.
//   That total order IS the conflict resolution. Two ops that touch the same
//   target (same brush id, same rhythm id, same script name) both apply; the
//   one that sorts LATER in the total order wins, on every node, every time.
//   Same seed + same op set = same world. 100 developers, one ocean.
//
// The reducer is order-independent by construction: each entry remembers the
// rank of the op that last wrote it, and an incoming op only overwrites when
// it sorts later. Applying ops in ANY arrival order therefore converges to
// the same state as applying them in total order. Applying the same op twice
// is a no-op (the appliedOps ledger). applyOp is pure: no mutation, no I/O,
// no DOM, no WebGL.

import type {
  BuildOp, JSONValue, WorldState, OpRank,
  BrushStroke, RhythmTuning, SeedPlanting, ScriptEntry,
} from './types.js';
import {
  OP_BUILD_BRUSH, OP_BUILD_RHYTHM, OP_BUILD_SEED,
  OP_BUILD_SCRIPT, OP_STATE_NOOP,
} from './types.js';
import { opId } from './hash.js';
import { validatePayload } from './ops.js';

/** Deterministic total order: (t, actor as string, seq). */
export function compareOps(
  a: Pick<BuildOp, 't' | 'actor' | 'seq'>,
  b: Pick<BuildOp, 't' | 'actor' | 'seq'>,
): number {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return 0;
}

/** Sort ops into the canonical total order (returns a new array). */
export function sortOps(ops: BuildOp[]): BuildOp[] {
  return [...ops].sort(compareOps);
}

/** The rank an op carries into the order law. */
export function rankOf(op: Pick<BuildOp, 't' | 'actor' | 'seq'>): OpRank {
  return { t: op.t, actor: op.actor, seq: op.seq };
}

/**
 * Conflict arbiter: does `incoming` sort later than `current` in the total
 * order? If yes, the incoming op wins the target. Equal ranks are impossible
 * for distinct ops (op ids are unique per actor), so ties never occur.
 */
export function opWins(current: OpRank, incoming: OpRank): boolean {
  return compareOps(current, incoming) < 0;
}

/** The empty world for a session seed. */
export function emptyState(seed: number): WorldState {
  return {
    seed,
    lamport: 0,
    brushes: [],
    rhythms: [],
    seeds: [],
    scripts: [],
    appliedOps: [],
  };
}

/** Deep copy via JSON round-trip (state is guaranteed JSON-serializable). */
function copyState(s: WorldState): WorldState {
  return JSON.parse(JSON.stringify(s)) as WorldState;
}

function sortedIds(ids: string[]): string[] {
  return [...ids].sort();
}

/**
 * Pure reduction of one op onto a state. Returns the same state reference
 * when the op changes nothing (already applied, foreign seed, invalid
 * payload); otherwise returns a new state object. Never throws on bad ops.
 */
export function applyOp(state: WorldState, op: BuildOp): WorldState {
  const id = opId(op);
  if (state.appliedOps.includes(id)) return state; // idempotent: already applied
  if (op.seed !== state.seed) return state; // different ocean: not ours
  if (validatePayload(op.op, op.payload) !== null) return state; // malformed: ignore

  const next = copyState(state);
  next.lamport = Math.max(next.lamport, op.t);
  next.appliedOps = sortedIds([...next.appliedOps, id]);
  const rank = rankOf(op);
  const p = op.payload as Record<string, JSONValue>;

  switch (op.op) {
    case OP_BUILD_BRUSH: {
      const bid = p.id as string;
      const entry: BrushStroke = {
        id: bid,
        pos: [...(p.pos as number[])] as [number, number, number],
        radius: p.radius as number,
        strength: p.strength as number,
        heading: p.heading as number,
        lastOp: rank,
      };
      upsertById(next.brushes, entry, bid, rank);
      break;
    }
    case OP_BUILD_RHYTHM: {
      const rid = p.id as string;
      const entry: RhythmTuning = {
        id: rid,
        target: p.target as 'ember' | 'mote' | 'gust',
        tempo: p.tempo as number,
        energy: p.energy as number,
        lastOp: rank,
      };
      upsertById(next.rhythms, entry, rid, rank);
      break;
    }
    case OP_BUILD_SEED: {
      const sid = p.id as string;
      const entry: SeedPlanting = {
        id: sid,
        kind: p.kind as string,
        pos: [...(p.pos as number[])] as [number, number, number],
        seed: p.seed as number,
        lastOp: rank,
      };
      upsertById(next.seeds, entry, sid, rank);
      break;
    }
    case OP_BUILD_SCRIPT: {
      const name = p.name as string;
      const entry: ScriptEntry = { name, body: p.body as string, lastOp: rank };
      const i = next.scripts.findIndex((s) => s.name === name);
      if (i < 0) {
        next.scripts.push(entry);
        next.scripts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      } else if (opWins(next.scripts[i].lastOp, rank)) {
        next.scripts[i] = entry;
      }
      break;
    }
    case OP_STATE_NOOP:
      break; // clock and ledger already advanced above
    default:
      return state; // unknown op: not ours to reduce
  }
  return next;
}

/** Upsert into an id-keyed array, keeping it sorted by id. Later rank wins. */
function upsertById<T extends { id: string; lastOp: OpRank }>(
  arr: T[], entry: T, id: string, rank: OpRank,
): void {
  const i = arr.findIndex((e) => e.id === id);
  if (i < 0) {
    arr.push(entry);
    arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } else if (opWins(arr[i].lastOp, rank)) {
    arr[i] = entry;
  }
}
