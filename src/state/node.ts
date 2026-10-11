// state/node.ts — one participant in the distributed state graph (V5 step 2).
//
// A StateNode authors ops (local()), ingests remote ops (merge()), and keeps
// the reduced WorldState. Ingest is fully deterministic: structural check,
// known op name, payload schema, session-seed match, per-actor chain check
// (seq continuity + prev hash). Out-of-order ops wait in a pending buffer
// until their predecessor arrives; duplicates are harmless; anything else is
// rejected with a reason in the MergeReport.
//
// TAMPER EVIDENCE: each actor's ops chain by prev = hash(previous op). An op
// whose prev does not match the last accepted op from its actor is rejected.
// Tampering with the PAYLOAD of op N does not change N's own prev, so N may
// still be accepted; but op N+1's prev was computed over the honest N, so
// N+1 fails the chain check and is rejected. The chain halts at the tamper
// point instead of diverging: every node that saw the same ops rejects the
// same way.

import type {
  BuildOp, JSONValue, WorldState, StateSnapshot, MergeReport,
} from './types.js';
import { KNOWN_OPS } from './types.js';
import { GENESIS_PREV, opHash, opId, stateHash } from './hash.js';
import { createOp, validateOpShape, validatePayload } from './ops.js';
import { applyOp, emptyState } from './reduce.js';

interface ChainHead {
  seq: number;
  hash: string;
}

function copyState(s: WorldState): WorldState {
  return JSON.parse(JSON.stringify(s)) as WorldState;
}

export class StateNode {
  readonly seed: number;
  readonly actor: string;

  private lamport = 0;
  private nextSeq = 0;
  private lastHash: string = GENESIS_PREV;
  private state: WorldState;
  private heads = new Map<string, ChainHead>();
  private pending = new Map<string, BuildOp[]>();
  private seen = new Set<string>();

  constructor(seed: number, actor: string) {
    if (!actor || typeof actor !== 'string') {
      throw new Error('state: actor id must be a non-empty string');
    }
    if (!Number.isInteger(seed) || seed < 0) {
      throw new Error('state: seed must be a non-negative integer');
    }
    this.seed = seed;
    this.actor = actor;
    this.state = emptyState(seed);
  }

  /**
   * Author a local op. Assigns the next seq, advances the Lamport clock,
   * links prev to this actor's chain tip, and ingests it locally.
   */
  local(op: string, payload: JSONValue): BuildOp {
    if (!KNOWN_OPS.includes(op)) {
      throw new Error('state: unknown op name: ' + op);
    }
    const reason = validatePayload(op, payload);
    if (reason !== null) throw new Error('state: invalid payload: ' + reason);
    this.lamport += 1;
    const built = createOp(op, this.actor, this.nextSeq, this.seed, this.lamport, payload, this.lastHash);
    this.nextSeq += 1;
    this.lastHash = opHash(built);
    const report = this.merge([built]);
    if (report.rejected.length > 0) {
      throw new Error('state: local op rejected: ' + report.rejected[0].reason);
    }
    return built;
  }

  /**
   * Ingest remote ops: validate, dedupe, chain-check, buffer out-of-order
   * arrivals, and reduce the accepted ones onto the state. Because the
   * reducer is order-independent (see reduce.ts), the resulting state is
   * identical on every node that accepted the same op set, whatever order
   * the ops arrived in.
   */
  merge(ops: BuildOp[]): MergeReport {
    const report: MergeReport = { accepted: [], duplicates: [], buffered: [], rejected: [] };
    for (const raw of ops) {
      const shaped = validateOpShape(raw);
      if (!shaped.ok) {
        report.rejected.push({ id: '?', reason: shaped.reason });
        continue;
      }
      const op = shaped.op;
      const id = opId(op);
      if (this.seen.has(id)) {
        report.duplicates.push(id);
        continue;
      }
      if (op.seed !== this.seed) {
        report.rejected.push({ id, reason: 'foreign seed ' + op.seed + ' (node seed ' + this.seed + ')' });
        continue;
      }
      const payloadReason = validatePayload(op.op, op.payload);
      if (payloadReason !== null) {
        report.rejected.push({ id, reason: payloadReason });
        continue;
      }
      const head = this.heads.get(op.actor) ?? { seq: -1, hash: GENESIS_PREV };
      if (op.seq === head.seq + 1 && op.prev === head.hash) {
        this.accept(op);
        report.accepted.push(id);
        this.drainPending(op.actor, report);
      } else if (op.seq > head.seq + 1) {
        this.buffer(op);
        report.buffered.push(id);
      } else {
        report.rejected.push({ id, reason: 'prev mismatch: chain broken or tampered' });
      }
    }
    return report;
  }

  /** A deep copy of the current reduced state. */
  get currentState(): WorldState {
    return copyState(this.state);
  }

  /** Convergence proof for this node's current state. */
  hash(): string {
    return stateHash(this.state);
  }

  /** Current Lamport clock. */
  get clock(): number {
    return this.lamport;
  }

  /**
   * Cheap-sync checkpoint: the full reduced state plus per-actor chain
   * heads, so a node can restore() and then merge just the tail of the log.
   */
  snapshot(): StateSnapshot {
    const heads: StateSnapshot['heads'] = {};
    const actors = [...this.heads.keys()].sort();
    for (const a of actors) heads[a] = { ...this.heads.get(a)! };
    return {
      v: 1,
      seed: this.seed,
      state: copyState(this.state),
      heads,
      lamport: this.lamport,
      localSeq: this.nextSeq,
      lastHash: this.lastHash,
    };
  }

  /**
   * Restore a checkpoint, then continue merging the tail. Restored state is
   * deep-copied in; the pending buffer is cleared. Throws on seed mismatch.
   */
  restore(snap: StateSnapshot): void {
    if (!snap || snap.v !== 1) throw new Error('state: bad snapshot version');
    if (snap.seed !== this.seed) {
      throw new Error('state: snapshot seed ' + snap.seed + ' does not match node seed ' + this.seed);
    }
    this.state = copyState(snap.state);
    this.heads = new Map<string, ChainHead>();
    for (const a of Object.keys(snap.heads).sort()) {
      this.heads.set(a, { ...snap.heads[a] });
    }
    this.lamport = snap.lamport;
    this.nextSeq = snap.localSeq;
    this.lastHash = snap.lastHash;
    this.pending = new Map<string, BuildOp[]>();
    this.seen = new Set<string>(this.state.appliedOps);
  }

  private accept(op: BuildOp): void {
    this.heads.set(op.actor, { seq: op.seq, hash: opHash(op) });
    this.seen.add(opId(op));
    this.state = applyOp(this.state, op);
    if (op.t > this.lamport) this.lamport = op.t;
  }

  private buffer(op: BuildOp): void {
    const list = this.pending.get(op.actor) ?? [];
    if (!list.some((p) => p.seq === op.seq)) {
      list.push(op);
      list.sort((a, b) => a.seq - b.seq);
      this.pending.set(op.actor, list);
    }
  }

  private drainPending(actor: string, report: MergeReport): void {
    for (;;) {
      const head = this.heads.get(actor) ?? { seq: -1, hash: GENESIS_PREV };
      const list = this.pending.get(actor);
      if (!list || list.length === 0) return;
      const next = list[0];
      if (next.seq !== head.seq + 1) return; // still a gap ahead
      list.shift();
      if (list.length === 0) this.pending.delete(actor);
      const id = opId(next);
      if (next.prev === head.hash) {
        this.accept(next);
        report.accepted.push(id);
      } else {
        // The buffered op's chain does not continue from the head:
        // tampered or forked. Reject it; later ops in the buffer will
        // fail the same check deterministically.
        report.rejected.push({ id, reason: 'prev mismatch: chain broken or tampered' });
      }
    }
  }
}
