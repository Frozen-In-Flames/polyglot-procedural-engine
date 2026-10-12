// Unit tests for V6 step 1: provenance graph over the op log (runs in node).
// (a) creator attribution - first op in total order owns the entity;
// (b) modification history - chronological, across actors;
// (c) queries - queryEntity, entitiesByAuthor, creationOps return exact records;
// (d) idempotency - shuffled/duplicated input builds a deep-equal graph;
// (e) stability - provenanceHash is identical across shuffles;
// (f) edge cases - unknown op names still recorded, state.noop ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOp } from '../src/state/index.js';
import {
  buildProvenance, queryEntity, entitiesByAuthor, creationOps,
  provenanceHash,
} from '../src/own/index.js';
import type { BuildOp, JSONValue } from '../src/state/index.js';

const SEED = 20261012;

/** Tiny deterministic PRNG for a reproducible shuffle. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let seqAlice = 0;
let seqBob = 0;

function mkOp(op: string, actor: 'alice' | 'bob', t: number, payload: JSONValue): BuildOp {
  const seq = actor === 'alice' ? seqAlice++ : seqBob++;
  return createOp(op, actor, seq, SEED, t, payload, seq === 0 ? 'genesis' : actor + '-prev-' + (seq - 1));
}

/** Hand-made log: 2 actors, brush + seed + script, one entity touched by both. */
function handLog(): { ops: BuildOp[]; brushOp: BuildOp; seedOp: BuildOp } {
  seqAlice = 0;
  seqBob = 0;
  const brushOp = mkOp('build.brush', 'alice', 1, {
    id: 'b1', pos: [1, 2, 3], radius: 4, strength: 0.5, heading: 1.2,
  });
  const seedOp = mkOp('build.seed', 'bob', 2, {
    id: 's1', kind: 'spire', pos: [10, 0, 10], seed: 42,
  });
  const scriptOp = mkOp('build.script', 'alice', 3, { name: 'main', body: 'caps.log("hi");' });
  const brushRetouch = mkOp('build.brush', 'bob', 4, {
    id: 'b1', pos: [1, 2, 3], radius: 8, strength: 0.9, heading: 0.1,
  });
  const rhythmOp = mkOp('build.rhythm', 'alice', 5, {
    id: 'r1', target: 'ember', tempo: 1.5, energy: 0.7,
  });
  const noopOp = mkOp('state.noop', 'bob', 6, null);
  const weirdOp = mkOp('build.weather', 'bob', 7, { id: 'w1', gust: 3 });
  return {
    ops: [brushOp, seedOp, scriptOp, brushRetouch, rhythmOp, noopOp, weirdOp],
    brushOp,
    seedOp,
  };
}

// ---------- (a) creator attribution ----------

test('own: first op in total order is the creator', () => {
  const { ops } = handLog();
  const g = buildProvenance(ops);
  assert.equal(g.v, 1);
  assert.equal(g.seed, SEED);
  assert.equal(queryEntity(g, 'b1')?.createdBy, 'alice');
  assert.equal(queryEntity(g, 's1')?.createdBy, 'bob');
  assert.equal(queryEntity(g, 'main')?.createdBy, 'alice');
  assert.equal(queryEntity(g, 'r1')?.createdBy, 'alice');
  assert.deepEqual(queryEntity(g, 'b1')?.createdAt, { t: 1, actor: 'alice', seq: 0 });
  assert.equal(queryEntity(g, 'b1')?.entityKind, 'brush');
  assert.equal(queryEntity(g, 'main')?.entityKind, 'script');
});

test('own: noop ops and unknown entities do not pollute the graph', () => {
  const { ops } = handLog();
  const g = buildProvenance(ops);
  assert.deepEqual(Object.keys(g.entities).sort(), ['b1', 'main', 'r1', 's1', 'w1']);
  assert.equal(queryEntity(g, 'nope'), undefined);
});

// ---------- (b) modification history ----------

test('own: modification history is chronological across actors', () => {
  const { ops } = handLog();
  const g = buildProvenance(ops);
  const mods = queryEntity(g, 'b1')?.modifications;
  assert.ok(mods);
  assert.equal(mods.length, 2);
  assert.equal(mods[0].actor, 'alice');
  assert.equal(mods[0].op, 'alice:0');
  assert.equal(mods[0].opName, 'build.brush');
  assert.equal(mods[1].actor, 'bob');
  assert.equal(mods[1].op, 'bob:1');
  assert.deepEqual(mods[1].opRank, { t: 4, actor: 'bob', seq: 1 });
  // chronological in the total order
  for (let i = 1; i < mods.length; i++) {
    assert.ok(mods[i - 1].opRank.t <= mods[i].opRank.t);
  }
  // single-author entity has a one-entry history: the creation record
  const seedMods = queryEntity(g, 's1')?.modifications;
  assert.equal(seedMods?.length, 1);
  assert.equal(seedMods?.[0].actor, 'bob');
});

// ---------- (c) queries ----------

test('own: entitiesByAuthor lists exactly the entities each actor created', () => {
  const { ops } = handLog();
  const g = buildProvenance(ops);
  assert.deepEqual(entitiesByAuthor(g, 'alice').map((e) => e.entityId), ['b1', 'main', 'r1']);
  assert.deepEqual(entitiesByAuthor(g, 'bob').map((e) => e.entityId), ['s1', 'w1']);
  assert.deepEqual(entitiesByAuthor(g, 'cara'), []);
});

test('own: creationOps returns the exact creating op records', () => {
  const { ops, brushOp, seedOp } = handLog();
  const g = buildProvenance(ops);
  assert.deepEqual(creationOps(g, 's1'), [seedOp]);
  assert.deepEqual(creationOps(g, 'b1'), [brushOp]);
  assert.deepEqual(creationOps(g, 'nope'), []);
});

// ---------- (f) edge cases ----------

test('own: unknown op names are recorded with a derived entity kind', () => {
  const { ops } = handLog();
  const g = buildProvenance(ops);
  const w = queryEntity(g, 'w1');
  assert.ok(w);
  assert.equal(w.entityKind, 'weather');
  assert.equal(w.createdBy, 'bob');
  assert.equal(w.ops.length, 1);
});

// ---------- (d)(e) idempotency + hash stability ----------

test('own: shuffled and duplicated ops build a deep-equal graph', () => {
  const { ops } = handLog();
  const g1 = buildProvenance(ops);
  const rng = lcg(7);
  const scrambled = shuffle([...ops, ...ops, ops[0], ops[3]], rng);
  const g2 = buildProvenance(scrambled);
  assert.deepEqual(g2, g1);
  // replays never inflate history
  assert.equal(queryEntity(g2, 'b1')?.modifications.length, 2);
});

test('own: provenanceHash is stable across shuffles and duplicates', () => {
  const { ops } = handLog();
  const h1 = provenanceHash(buildProvenance(ops));
  const rng = lcg(99);
  for (let i = 0; i < 5; i++) {
    const scrambled = shuffle([...ops, ops[2], ops[5]], rng);
    assert.equal(provenanceHash(buildProvenance(scrambled)), h1);
  }
  // different content => different hash
  const { ops: ops2 } = handLog();
  ops2.push(mkOp('build.brush', 'alice', 8, {
    id: 'b2', pos: [0, 0, 0], radius: 1, strength: 1, heading: 0,
  }));
  assert.notEqual(provenanceHash(buildProvenance(ops2)), h1);
});

test('own: empty log builds an empty graph with seed 0', () => {
  const g = buildProvenance([]);
  assert.equal(g.v, 1);
  assert.equal(g.seed, 0);
  assert.deepEqual(g.entities, {});
  assert.equal(typeof provenanceHash(g), 'string');
});
