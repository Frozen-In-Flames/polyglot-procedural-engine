// Unit tests for V5 step 1: in-session build tools (runs in node).
// (a) brush determinism - same seed+params = identical field samples;
// (b) brush locality - far-field samples bit-identical with/without a brush;
// (c) rhythm tuning - local blend, deterministic;
// (d) entity seeding determinism - same kind+seed = identical body;
// (e) live scripting - a good behavior runs; a malicious one cannot escape;
// (f) op emission - every tool action emits one valid, hash-chained op;
// (g) ingest - a foreign op log replays into an identical local view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptRuntime, MemoryEntityBackend } from '../src/script/index.js';
import { BuildSession } from '../src/build/index.js';
import {
  GENESIS_PREV, opHash, validateOpShape, validatePayload,
} from '../src/state/index.js';

const SEED = 20261010;

interface Harness {
  rt: ScriptRuntime;
  backend: MemoryEntityBackend;
  session: BuildSession;
  logs: string[];
}

function makeHarness(actor = 'tester', onLog?: (name: string, msg: string) => void): Harness {
  const logs: string[] = [];
  const backend = new MemoryEntityBackend();
  const rt = new ScriptRuntime(SEED, backend, {
    onLog: (name, msg) => {
      logs.push(`${name}: ${msg}`);
      onLog?.(name, msg);
    },
  });
  const session = new BuildSession({ runtime: rt, actor, seed: SEED });
  return { rt, backend, session, logs };
}

function gridSamples(s: BuildSession): number[] {
  const out: number[] = [];
  for (let x = -20; x <= 40; x += 10) {
    for (let z = -30; z <= 20; z += 10) {
      for (const t of [0, 1.7, 12.25]) {
        const v = s.sample(x, 1, z, t);
        out.push(v.x, v.y, v.z);
      }
    }
  }
  return out;
}

// ---------- (a) brush determinism ----------

test('build: brush is deterministic: same seed+params, identical samples', () => {
  const a = makeHarness('a');
  const b = makeHarness('b');
  const opts = { direction: [1, 0.5] as [number, number], force: 0.8, gust: 0.4, seed: 99 };
  a.session.applyBrush([10, -5], 12, opts);
  b.session.applyBrush([10, -5], 12, opts);
  assert.deepEqual(gridSamples(a.session), gridSamples(b.session));
  // Derived seeds (no explicit seed) are deterministic too.
  const c = makeHarness('c');
  const d = makeHarness('d');
  c.session.applyBrush([-7, 3], 9, { direction: [-0.3, 1], force: 0.6, gust: 0.9 });
  d.session.applyBrush([-7, 3], 9, { direction: [-0.3, 1], force: 0.6, gust: 0.9 });
  assert.deepEqual(gridSamples(c.session), gridSamples(d.session));
});

// ---------- (b) brush locality ----------

test('build: brush is local: far-field samples are bit-identical', () => {
  const plain = makeHarness('plain');
  const brushed = makeHarness('brushed');
  brushed.session.applyBrush([0, 0], 10, {
    direction: [1, 0], force: 0.9, gust: 0.5, seed: 7,
  });
  for (const [x, z] of [[50, 0], [-40, 33], [11, 0], [0, -25], [7.07, 7.08]]) {
    const p = plain.session.sample(x, 2, z, 3.3);
    const q = brushed.session.sample(x, 2, z, 3.3);
    assert.deepEqual(q, p, `far-field sample at (${x}, ${z}) unchanged`);
  }
  // Inside the disc the brush actually bends the wind.
  const p0 = plain.session.sample(0, 2, 0, 3.3);
  const q0 = brushed.session.sample(0, 2, 0, 3.3);
  assert.notDeepEqual(q0, p0, 'brush bends the wind at its center');
  // The brush is bounded: the offset never exceeds force * (1 + gust/2).
  const off = Math.hypot(q0.x - p0.x, q0.y - p0.y, q0.z - p0.z);
  assert.ok(off <= 0.9 * 1.25 + 1e-9, `offset bounded (got ${off})`);
});

// ---------- (c) rhythm tuning ----------

test('build: rhythm tuning blends locally and deterministically', () => {
  const a = makeHarness('a');
  const b = makeHarness('b');
  // No regions: the global tempo reads through untouched.
  assert.deepEqual(a.session.sampleRhythm(999, 999), { beatPeriod: 2.0, energy: 0.5 });
  a.session.tuneRhythm([0, 0], 10, { emberTempo: 1.0, moteEnergy: 0.9 });
  b.session.tuneRhythm([0, 0], 10, { emberTempo: 1.0, moteEnergy: 0.9 });
  const ra = a.session.sampleRhythm(0, 0);
  const rb = b.session.sampleRhythm(0, 0);
  assert.deepEqual(ra, rb);
  // At the center the blend is exactly half global, half region.
  assert.equal(ra.beatPeriod, (2.0 + 1.0) / 2);
  assert.equal(ra.energy, (0.5 + 0.9) / 2);
  // Far away the region has no effect.
  assert.deepEqual(a.session.sampleRhythm(500, -500), { beatPeriod: 2.0, energy: 0.5 });
});

// ---------- (d) entity seeding determinism ----------

test('build: seedEntity is deterministic: same kind+seed, identical body', () => {
  const a = makeHarness('a');
  const b = makeHarness('b');
  const ea = a.session.seedEntity('rock-cluster', [5, 1, -3], 4242);
  const eb = b.session.seedEntity('rock-cluster', [5, 1, -3], 4242);
  assert.equal(ea.name, eb.name);
  assert.deepEqual(a.backend.bodies.get(ea.id), b.backend.bodies.get(eb.id));
  // A different seed grows a different body.
  const ec = a.session.seedEntity('rock-cluster', [5, 1, -3], 4243);
  assert.notDeepEqual(a.backend.bodies.get(ea.id), a.backend.bodies.get(ec.id));
  // All three kinds grow.
  for (const kind of ['rock-cluster', 'light-well', 'ember-vent'] as const) {
    const e = a.session.seedEntity(kind, [0, 0, 0], 11);
    assert.ok(a.backend.bodies.get(e.id), `${kind} grew a body`);
  }
  // Unknown kinds are rejected loudly.
  assert.throws(() => a.session.seedEntity('house', [0, 0, 0], 1), /unknown entity kind/);
});

// ---------- (e) live scripting: good behavior runs ----------

test('build: a good behavior script runs against its living entity', () => {
  const { rt, session } = makeHarness();
  const { id } = session.seedEntity('ember-vent', [0, 0, 0], 5);
  const before = rt.hostGetTransform(id)!.position[0];
  session.attachBehavior(id, `
    function update(caps, self, dt, t) {
      self.translate(dt * 2, 0, 0);
      if (t > 0.05) caps.log('ticking');
    }
  `, { name: 'drifter' });
  for (let i = 0; i < 10; i++) rt.update(1 / 60, i / 60);
  const after = rt.hostGetTransform(id)!.position[0];
  assert.ok(after > before, 'behavior moved its entity');
  assert.equal(rt.errors.length, 0);
});

// ---------- (e) live scripting: malicious behavior cannot escape ----------

test('build: a malicious live script cannot escape the sandbox', () => {
  const { rt, session, logs } = makeHarness();
  const { id } = session.seedEntity('ember-vent', [0, 0, 0], 6);
  const evil = `
    function start(caps, self) {
      const out = [];
      out.push(typeof process === 'undefined' ? 'no-process' : 'process-LEAK');
      out.push(typeof require === 'undefined' ? 'no-require' : 'require-LEAK');
      out.push(typeof globalThis.process === 'undefined' ? 'no-globalThis' : 'globalThis-LEAK');
      try {
        const r = Function('return typeof process')();
        out.push(r === 'undefined' ? 'no-Function-escape' : 'Function-LEAK');
      } catch (e) { out.push('no-Function-escape'); }
      try { caps.constructor('return 1')(); out.push('ctor-LEAK'); }
      catch (e) { out.push('no-ctor'); }
      try { Object.getPrototypeOf(caps).constructor('return 1')(); out.push('proto-LEAK'); }
      catch (e) { out.push('no-proto'); }
      try { Math.random(); out.push('random-LEAK'); }
      catch (e) { out.push('no-random'); }
      try { caps.smuggled = 1; out.push('write-LEAK'); }
      catch (e) { out.push('no-write'); }
      caps.log(out.join(','));
    }
    function update(caps, self, dt, t) {
      try { self.constructor('return 1')(); caps.log('self-LEAK'); }
      catch (e) { caps.log('no-self-ctor'); }
      throw new Error('boom');
    }
  `;
  session.attachBehavior(id, evil, { name: 'evil' });
  assert.equal(rt.errors.length, 0, 'start() survived');
  rt.update(1 / 60, 1 / 60);
  // The throw was captured by the runtime; the session kept running.
  assert.equal(rt.errors.length, 1);
  assert.match(String((rt.errors[0].err as Error).message), /boom/);
  const startLog = logs.find((l) => l.startsWith('evil: no-process'));
  assert.ok(startLog, 'evil start() reported its probes');
  assert.ok(!startLog.includes('LEAK'), `no escape succeeded: ${startLog}`);
  for (const token of [
    'no-process', 'no-require', 'no-globalThis', 'no-Function-escape',
    'no-ctor', 'no-proto', 'no-random', 'no-write',
  ]) {
    assert.ok(startLog.includes(token), `probe contained: ${token}`);
  }
  assert.ok(logs.some((l) => l.includes('no-self-ctor')), 'handle prototype escape blocked');
  // The engine is unharmed: a fresh behavior still attaches and runs.
  const { id: id2 } = session.seedEntity('light-well', [0, 0, 0], 7);
  session.attachBehavior(id2, 'function update(caps, self, dt, t) { self.translate(dt, 0, 0); }', {
    name: 'good',
  });
  const x0 = rt.hostGetTransform(id2)!.position[0];
  for (let i = 0; i < 5; i++) rt.update(1 / 60, i / 60);
  assert.ok(rt.hostGetTransform(id2)!.position[0] > x0, 'engine still runs behaviors');
  assert.equal(rt.errors.length, 1, 'only the evil script errored');
});

// ---------- (f) op emission ----------

test('build: every tool action emits one valid, hash-chained op', () => {
  const { session } = makeHarness('aries');
  const brushId = session.applyBrush([1, 2], 8, {
    direction: [0, 1], force: 0.5, gust: 0.2, seed: 5,
  });
  const regionId = session.tuneRhythm([3, 4], 10, { emberTempo: 1.5, moteEnergy: 0.6 });
  const planted = session.seedEntity('light-well', [0, 1, 0], 77);
  const bname = session.attachBehavior(
    planted.id, 'function update(caps, self, dt, t) {}', { name: 'calm' },
  );
  assert.equal(session.ops.length, 4);
  assert.deepEqual(
    session.ops.map((o) => o.op),
    ['build.brush', 'build.rhythm', 'build.seed', 'build.script'],
  );
  session.ops.forEach((op, i) => {
    assert.ok(validateOpShape(op).ok, `op ${i} envelope valid`);
    assert.equal(validatePayload(op.op, op.payload), null, `op ${i} payload valid`);
    assert.equal(op.v, 1);
    assert.equal(op.actor, 'aries');
    assert.equal(op.seq, i, 'seq is 0-based with no gaps');
    assert.equal(op.seed, SEED);
    assert.ok(Number.isInteger(op.t) && op.t > 0, 'lamport t advances');
    if (i > 0) assert.ok(op.t > session.ops[i - 1].t, 't strictly increases');
  });
  assert.equal(session.ops[0].prev, GENESIS_PREV, 'first op chains from GENESIS');
  for (let i = 1; i < session.ops.length; i++) {
    assert.equal(session.ops[i].prev, opHash(session.ops[i - 1]), `op ${i} chains to op ${i - 1}`);
  }
  // Payloads carry the tool params as JSON.
  const brush = session.ops[0].payload as Record<string, unknown>;
  assert.equal(brush.id, brushId);
  assert.deepEqual(brush.pos, [1, 0, 2]);
  assert.equal(brush.radius, 8);
  assert.equal(brush.strength, 0.5);
  const rhythm = session.ops[1].payload as Record<string, unknown>;
  assert.equal(rhythm.id, regionId);
  assert.equal(rhythm.tempo, 1.5);
  assert.equal(rhythm.energy, 0.6);
  const seed = session.ops[2].payload as Record<string, unknown>;
  assert.equal(seed.id, planted.name);
  assert.equal(seed.kind, 'light-well');
  const script = session.ops[3].payload as Record<string, unknown>;
  assert.equal(script.name, bname);
  assert.equal(script.entity, planted.name);
  assert.equal(typeof script.body, 'string');
});

// ---------- (g) ingest: foreign op log replays identically ----------

test('build: ingest replays a foreign op log into an identical local view', () => {
  const a = makeHarness('a');
  const b = makeHarness('b');
  a.session.applyBrush([10, -5], 12, { direction: [1, 0.5], force: 0.8, gust: 0.4, seed: 99 });
  a.session.tuneRhythm([0, 0], 10, { emberTempo: 1.0, moteEnergy: 0.9 });
  const planted = a.session.seedEntity('ember-vent', [4, 2, -1], 31337);
  a.session.attachBehavior(planted.id, 'function start(caps, self) { caps.log("replayed"); }', {
    name: 'replayed-behavior',
  });
  for (const op of a.session.ops) {
    assert.ok(b.session.ingest(op), `ingested ${op.op}`);
  }
  // Same brushes, regions, samples, rhythm, entities, behaviors.
  assert.deepEqual(b.session.brushIds, a.session.brushIds);
  assert.deepEqual(b.session.rhythmIds, a.session.rhythmIds);
  assert.deepEqual(gridSamples(b.session), gridSamples(a.session));
  assert.deepEqual(
    b.session.sampleRhythm(0, 0),
    a.session.sampleRhythm(0, 0),
  );
  const found = b.rt.hostEntities().find((e) => e.name === planted.name);
  assert.ok(found, 'seeded entity replayed');
  assert.ok(b.rt.loadedNames.includes('replayed-behavior'), 'behavior replayed');
  // Idempotent: replaying the log again changes nothing.
  const before = gridSamples(b.session);
  for (const op of a.session.ops) b.session.ingest(op);
  assert.deepEqual(gridSamples(b.session), before);
  // Foreign seeds and malformed ops are refused.
  assert.equal(b.session.ingest({ v: 1, op: 'build.brush', actor: 'x', seq: 0, seed: SEED + 1, t: 1, payload: {}, prev: GENESIS_PREV }), false);
  assert.equal(b.session.ingest(null), false);
});

// ---------- validation ----------

test('build: bad tool input is rejected loudly', () => {
  const { session } = makeHarness();
  assert.throws(() => session.applyBrush([0, 0], -3, { direction: [1, 0], force: 0.5, gust: 0 }), /radius/);
  assert.throws(() => session.applyBrush([0, 0], 5, { direction: [0, 0], force: 0.5, gust: 0 }), /non-zero/);
  assert.throws(() => session.applyBrush([0, 0], 5, { direction: [1, 0], force: 2, gust: 0 }), /force/);
  assert.throws(() => session.tuneRhythm([0, 0], 5, { emberTempo: 0, moteEnergy: 0.5 }), /emberTempo/);
  assert.throws(() => session.attachBehavior(424242, 'function start() {}'), /no live entity/);
  assert.throws(() => session.attachBehavior(1, ''), /non-empty string/);
});

// ---------- the fluent instrument ----------

test('build: the fluent instrument delegates to the session tools', () => {
  const { rt, session } = makeHarness();
  const brushId = session.instrument.brush.at(4, 5).with({
    direction: [1, 1], force: 0.7, gust: 0.1, radius: 9, seed: 3,
  });
  assert.ok(brushId.startsWith('brush-'));
  const regionId = session.instrument.rhythm.at(0, 0).with({
    emberTempo: 2.0, moteEnergy: 0.4, radius: 15,
  });
  assert.ok(regionId.startsWith('rhythm-'));
  const planted = session.instrument.seed('ember-vent').at(1, 2, 3).plant(555);
  assert.ok(planted.id > 0 && planted.name.includes('ember-vent'));
  const name = session.instrument.behavior.on(planted.id).attach(
    'function update(caps, self, dt, t) { self.translate(0, dt, 0); }',
  );
  assert.ok(name.startsWith('behavior-'));
  assert.equal(session.ops.length, 4);
  const y0 = rt.hostGetTransform(planted.id)!.position[1];
  for (let i = 0; i < 5; i++) rt.update(1 / 60, i / 60);
  assert.ok(rt.hostGetTransform(planted.id)!.position[1] > y0, 'fluent behavior runs');
  session.dispose();
});
