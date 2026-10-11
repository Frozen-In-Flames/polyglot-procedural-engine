// Unit tests for V5 step 2: distributed state graph (runs in node).
// (a) convergence — two nodes receiving the same 50 ops in different orders
//     reach identical stateHash; (b) idempotency — duplicate delivery is
//     harmless; (c) conflict resolution — same-target ops resolve
//     deterministically (same winner on both nodes); (d) snapshots —
//     restore + tail replay converges with full replay; (e) tamper evidence —
//     a forged prev is rejected, and a tampered payload breaks the chain at
//     the next op; (f) rejection rules — unknown ops and foreign seeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StateNode, applyOp, emptyState, stateHash, sortOps, compareOps,
  opId, createOp, GENESIS_PREV,
} from '../src/state/index.js';
import type { BuildOp, JSONValue } from '../src/state/index.js';
import { mulberry32 } from '../src/geo/rng.js';

const SEED = 20261011;

/** Fisher-Yates with a seeded stream: deterministic shuffle. */
function shuffled<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const TARGETS = ['ember', 'mote', 'gust'] as const;

/** Author `count` deterministic build ops across three actors. */
function authorOps(count: number, seed: number): BuildOp[] {
  const rng = mulberry32(seed);
  const authors = ['alice', 'bob', 'cara'].map((a) => new StateNode(seed, a));
  const ops: BuildOp[] = [];
  for (let i = 0; i < count; i++) {
    const author = authors[i % authors.length];
    const kind = i % 5;
    const n = Math.floor(i / 5);
    let op: BuildOp;
    if (kind === 0) {
      op = author.local('build.brush', {
        id: 'brush-' + (i % 7),
        pos: [rng() * 100 - 50, rng() * 20, rng() * 100 - 50],
        radius: 1 + rng() * 9,
        strength: rng() * 2 - 1,
        heading: rng() * Math.PI * 2,
      });
    } else if (kind === 1) {
      op = author.local('build.rhythm', {
        id: 'rhythm-' + (i % 5),
        target: TARGETS[Math.floor(rng() * 3)],
        tempo: 0.5 + rng() * 3,
        energy: rng(),
      });
    } else if (kind === 2) {
      op = author.local('build.seed', {
        id: 'seed-' + n,
        kind: ['spire', 'mote-cluster', 'ridge'][Math.floor(rng() * 3)],
        pos: [rng() * 200 - 100, 0, rng() * 200 - 100],
        seed: Math.floor(rng() * 1e9),
      });
    } else if (kind === 3) {
      op = author.local('build.script', {
        name: 'script-' + (i % 4),
        body: 'caps.log("v' + i + '");',
      });
    } else {
      op = author.local('state.noop', null);
    }
    ops.push(op);
  }
  return ops;
}

// ---------- (a) convergence ----------

test('state: same 50 ops in different orders converge to identical stateHash', () => {
  const ops = authorOps(50, SEED);
  const r1 = new StateNode(SEED, 'replica-1');
  const r2 = new StateNode(SEED, 'replica-2');
  const rep1 = r1.merge(ops);
  const rep2 = r2.merge(shuffled(ops, mulberry32(SEED ^ 0x5bd1e995)));
  assert.equal(rep1.accepted.length, 50, 'replica 1 accepts all 50');
  assert.equal(rep2.accepted.length, 50, 'replica 2 accepts all 50');
  assert.equal(rep2.rejected.length, 0, 'no rejections on reshuffled delivery');
  assert.equal(r1.hash(), r2.hash(), 'stateHash identical');
  assert.deepEqual(r1.currentState, r2.currentState, 'full state identical');
  // The reduced state really holds the builds.
  const s = r1.currentState;
  assert.ok(s.brushes.length > 0 && s.rhythms.length > 0 && s.seeds.length > 0 && s.scripts.length > 0);
  assert.equal(s.appliedOps.length, 50);
});

// ---------- (b) idempotency ----------

test('state: duplicate delivery is harmless', () => {
  const ops = authorOps(20, SEED + 1);
  const node = new StateNode(SEED + 1, 'replica');
  node.merge(ops);
  const before = node.hash();
  const appliedBefore = node.currentState.appliedOps.length;
  const rep = node.merge(ops); // deliver everything again
  assert.equal(rep.accepted.length, 0);
  assert.equal(rep.duplicates.length, 20);
  assert.equal(rep.rejected.length, 0);
  assert.equal(node.hash(), before, 'hash unchanged after duplicates');
  assert.equal(node.currentState.appliedOps.length, appliedBefore);
  // Duplicates inside a single batch are harmless too.
  const rep2 = node.merge([...ops.slice(0, 5), ...ops.slice(0, 5)]);
  assert.equal(rep2.duplicates.length, 10);
  assert.equal(node.hash(), before);
});

// ---------- (c) conflict resolution ----------

test('state: conflicting ops on the same target resolve deterministically', () => {
  // Same Lamport t on both authors: the actor string breaks the tie,
  // so 'zed' sorts later and wins on every node.
  const amy = new StateNode(SEED + 2, 'amy');
  const zed = new StateNode(SEED + 2, 'zed');
  const opAmy = amy.local('build.rhythm', { id: 'tide', target: 'ember', tempo: 100, energy: 0.5 });
  const opZed = zed.local('build.rhythm', { id: 'tide', target: 'ember', tempo: 140, energy: 0.9 });
  assert.equal(opAmy.t, opZed.t, 'test setup: tied Lamport time');
  assert.ok(compareOps(opAmy, opZed) < 0, 'amy sorts before zed');

  const r1 = new StateNode(SEED + 2, 'r1');
  const r2 = new StateNode(SEED + 2, 'r2');
  r1.merge([opAmy, opZed]);
  r2.merge([opZed, opAmy]); // opposite arrival order
  const w1 = r1.currentState.rhythms.find((r) => r.id === 'tide')!;
  const w2 = r2.currentState.rhythms.find((r) => r.id === 'tide')!;
  assert.equal(w1.tempo, 140, 'later-in-order op wins on node 1');
  assert.equal(w2.tempo, 140, 'same winner on node 2 despite arrival order');
  assert.equal(r1.hash(), r2.hash());

  // Different Lamport times: the later time wins regardless of arrival order.
  const earlyNode = new StateNode(SEED + 3, 'zed');
  const lateNode = new StateNode(SEED + 3, 'amy');
  const e0 = earlyNode.local('state.noop', null);
  const opEarly = earlyNode.local('build.brush', { id: 'b', pos: [0, 0, 0], radius: 1, strength: 1, heading: 0 });
  const l0 = lateNode.local('state.noop', null);
  const l1 = lateNode.local('state.noop', null);
  const l2 = lateNode.local('state.noop', null);
  const opLate = lateNode.local('build.brush', { id: 'b', pos: [9, 9, 9], radius: 5, strength: -1, heading: 3 });
  assert.ok(opLate.t > opEarly.t, 'test setup: strictly later Lamport time');
  const q1 = new StateNode(SEED + 3, 'q1');
  const q2 = new StateNode(SEED + 3, 'q2');
  q1.merge([e0, opEarly, l0, l1, l2, opLate]);
  q2.merge([l0, l1, l2, opLate, e0, opEarly]);
  const b1 = q1.currentState.brushes.find((b) => b.id === 'b')!;
  const b2 = q2.currentState.brushes.find((b) => b.id === 'b')!;
  assert.deepEqual(b1.pos, [9, 9, 9]);
  assert.deepEqual(b2.pos, [9, 9, 9]);
  assert.equal(q1.hash(), q2.hash());
});

// ---------- (d) snapshots ----------

test('state: restore(snapshot) + tail replay converges with full replay', () => {
  // One continuous set of 50 ops from three authors (chains stay valid).
  const authors = ['alice', 'bob', 'cara'].map((a) => new StateNode(SEED + 4, a));
  const all: BuildOp[] = [];
  for (let i = 0; i < 50; i++) {
    const author = authors[i % authors.length];
    if (i % 3 === 0) {
      all.push(author.local('build.brush', {
        id: 'b' + i, pos: [i, 0, -i], radius: 2, strength: 0.5, heading: i * 0.1,
      }));
    } else if (i % 3 === 1) {
      all.push(author.local('build.rhythm', {
        id: 'r' + i, target: 'ember', tempo: 1 + i * 0.1, energy: 0.5,
      }));
    } else {
      all.push(author.local('state.noop', { i }));
    }
  }

  const full = new StateNode(SEED + 4, 'full');
  full.merge(all);
  const fullHash = full.hash();

  const head = new StateNode(SEED + 4, 'head');
  head.merge(all.slice(0, 30));
  const snap = head.snapshot();

  const resumed = new StateNode(SEED + 4, 'resumed');
  resumed.restore(snap);
  const rep = resumed.merge(all.slice(30));
  assert.equal(rep.accepted.length, 20, 'tail of 20 accepted after restore');
  assert.equal(rep.rejected.length, 0);
  assert.equal(resumed.hash(), fullHash, 'snapshot + tail converges with full replay');

  // A restored node keeps authoring cleanly on its own chain.
  const op = resumed.local('build.rhythm', { id: 'after', target: 'gust', tempo: 2, energy: 0.5 });
  assert.equal(op.seq, 0);
  assert.equal(op.prev, GENESIS_PREV);

  // Full-snapshot restore is identical too.
  const clone = new StateNode(SEED + 4, 'clone');
  clone.restore(full.snapshot());
  assert.equal(clone.hash(), fullHash);
});

// ---------- (e) tamper evidence ----------

test('state: tampered prev chain is detected and rejected', () => {
  const vic = new StateNode(SEED + 5, 'vic');
  const o1 = vic.local('build.rhythm', { id: 'r1', target: 'ember', tempo: 100, energy: 0.5 });
  const o2 = vic.local('build.rhythm', { id: 'r2', target: 'mote', tempo: 120, energy: 0.6 });
  const o3 = vic.local('build.rhythm', { id: 'r3', target: 'gust', tempo: 140, energy: 0.7 });

  // Case 1: forged prev on the expected next seq -> rejected immediately.
  const forged: BuildOp = { ...o2, prev: 'deadbeef' };
  const n1 = new StateNode(SEED + 5, 'n1');
  const rep1 = n1.merge([o1, forged]);
  assert.equal(rep1.accepted.length, 1);
  assert.equal(rep1.rejected.length, 1);
  assert.ok(rep1.rejected[0].reason.includes('prev mismatch'));
  assert.equal(n1.currentState.appliedOps.length, 1);

  // Case 2: payload tampered in transit. The tampered op's own prev still
  // matches, so it is accepted; but o3's prev was computed over the honest
  // o2, so the chain breaks AT o3 and o3 is rejected. Tampering is visible.
  const tampered: BuildOp = { ...o2, payload: { ...(o2.payload as Record<string, JSONValue>), tempo: 999 } };
  const n2 = new StateNode(SEED + 5, 'n2');
  const rep2 = n2.merge([o1, tampered, o3]);
  assert.deepEqual(rep2.accepted, [opId(o1), opId(tampered)]);
  assert.equal(rep2.rejected.length, 1);
  assert.equal(rep2.rejected[0].id, opId(o3));
  assert.equal(n2.currentState.appliedOps.length, 2);

  // Honest control: the untampered chain converges everywhere.
  const honest = new StateNode(SEED + 5, 'honest');
  const repH = honest.merge([o1, o2, o3]);
  assert.equal(repH.accepted.length, 3);
  assert.equal(honest.hash(), vic.hash(), 'honest replay matches the author');
  assert.notEqual(n2.hash(), honest.hash(), 'tampered chain diverges from honest');
});

// ---------- (f) rejection rules ----------

test('state: unknown ops and foreign seeds are rejected', () => {
  const node = new StateNode(SEED + 6, 'replica');
  const before = node.hash();

  const bogus = createOp('bogus.op', 'mallory', 0, SEED + 6, 1, { x: 1 }, GENESIS_PREV);
  const rep1 = node.merge([bogus]);
  assert.equal(rep1.rejected.length, 1);
  assert.ok(rep1.rejected[0].reason.includes('unknown op'));

  const foreign = createOp('state.noop', 'mallory', 0, SEED + 999, 1, null, GENESIS_PREV);
  const rep2 = node.merge([foreign]);
  assert.equal(rep2.rejected.length, 1);
  assert.ok(rep2.rejected[0].reason.includes('foreign seed'));

  const malformed = { v: 1, op: 'state.noop' }; // missing actor/seq/seed/t/prev
  const rep3 = node.merge([malformed as unknown as BuildOp]);
  assert.equal(rep3.rejected.length, 1);

  assert.equal(node.hash(), before, 'rejections change nothing');
  assert.equal(node.currentState.appliedOps.length, 0);
});

// ---------- pure-function checks ----------

test('state: applyOp is pure and idempotent', () => {
  const s0 = emptyState(SEED + 7);
  const author = new StateNode(SEED + 7, 'amy');
  const op = author.local('build.brush', { id: 'b1', pos: [1, 2, 3], radius: 2, strength: 0.5, heading: 1 });
  const s1 = applyOp(s0, op);
  assert.notEqual(s1, s0, 'apply returns a new state');
  assert.equal(s0.appliedOps.length, 0, 'input state not mutated');
  assert.equal(s1.brushes.length, 1);
  const s2 = applyOp(s1, op);
  assert.equal(s2, s1, 'second apply is a no-op returning the same reference');
  assert.equal(stateHash(s1), stateHash(s2));

  // sortOps implements the documented total order (t, actor, seq).
  const a = createOp('state.noop', 'zed', 0, 1, 5, null, GENESIS_PREV);
  const b = createOp('state.noop', 'amy', 0, 1, 5, null, GENESIS_PREV);
  const c = createOp('state.noop', 'amy', 1, 1, 5, null, GENESIS_PREV);
  const d = createOp('state.noop', 'amy', 0, 1, 4, null, GENESIS_PREV);
  const sorted = sortOps([a, b, c, d]).map(opId);
  assert.deepEqual(sorted, [opId(d), opId(b), opId(c), opId(a)]);
});
