// Unit tests for the V4 sandboxed scripting runtime (runs in node).
// (a) functional: spawn/react/determinism/parity; (b) adversarial sandbox
// boundary tests; (c) graduated capability grants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ScriptRuntime, MemoryEntityBackend, SceneEntityBackend,
  floatScript, arpScript, hatsScript, composeArpHats,
  ALL_CAPABILITIES,
} from '../src/script/index.js';
import type { Caps, EntityHandle, JSONValue, ScriptDef } from '../src/script/index.js';
import { SceneNode } from '../src/scene/node.js';
import { graphContains } from '../src/script/sandbox.js';

const SEED = 20261010;

// ---------- helpers ----------

// reach the caps of a loaded script via a probe script that captures them.
function rtCaps(rt: ScriptRuntime): Caps {
  let got: Caps | null = null;
  const probe: ScriptDef = {
    name: 'probe-' + Math.random().toString(36).slice(2),
    start(c) { got = c; },
  };
  // probe shares the runtime's entity space, so world.find sees float's entity
  rt.load(probe);
  const caps = got as unknown as Caps;
  rt.unload(probe.name);
  return caps;
}

// ---------- (a) functional ----------

test('script: float reference spawns an entity and animates it', () => {
  const rt = new ScriptRuntime(SEED, new MemoryEntityBackend(), { onLog: () => {} });
  rt.load(floatScript);
  assert.deepEqual(rt.loadedNames, ['float']);
  const caps = rtCaps(rt);
  const h = caps.world.find('float-ember');
  assert.ok(h && h.alive);
  const y0 = h.getTransform().position[1];
  for (let i = 0; i < 120; i++) rt.update(1 / 60, i / 60);
  const tr = h.getTransform();
  assert.notEqual(tr.position[1], y0, 'bob moved Y');
  const [x, y, z, w] = tr.rotation;
  const len = Math.hypot(x, y, z, w);
  assert.ok(Math.abs(len - 1) < 1e-9, 'spin keeps a unit quaternion');
  assert.equal(rt.errors.length, 0);
});

test('script: determinism - same seed, same run, same behavior (incl. RNG)', () => {
  const wander: ScriptDef = {
    name: 'wander',
    start(c) { c.world.spawn('w', { position: [c.rng() * 10, 0, c.rng() * 10] }); },
    update(c, dt) {
      const h = c.world.find('w')!;
      h.translate((c.rng() - 0.5) * dt, 0, (c.rng() - 0.5) * dt);
    },
  };
  const run = (seed: number): [number, number, number][] => {
    const rt = new ScriptRuntime(seed, new MemoryEntityBackend());
    rt.load(wander);
    const out: [number, number, number][] = [];
    for (let i = 0; i < 90; i++) {
      rt.update(1 / 60, i / 60);
      const h = rtCaps(rt).world.find('w')!;
      out.push([...h.getTransform().position] as [number, number, number]);
    }
    return out;
  };
  const a = run(SEED), b = run(SEED);
  assert.deepEqual(a, b, 'same seed -> identical entity motion across runs');
  assert.notDeepEqual(a, run(SEED + 1), 'different seed -> different motion');
});

test('script: per-script RNG streams are seeded and reproducible', () => {
  const seq = (seed: number, name: string): number[] => {
    const rt = new ScriptRuntime(seed, new MemoryEntityBackend());
    let out: number[] = [];
    rt.load({ name, start(c) { out = [c.rng(), c.rng(), c.rng()]; } });
    return out;
  };
  assert.deepEqual(seq(SEED, 'a'), seq(SEED, 'a'));
  assert.notDeepEqual(seq(SEED, 'a'), seq(SEED, 'b'), 'streams differ per script name');
});

test('script: events - host input reaches scripts, data is isolated', () => {
  const rt = new ScriptRuntime(SEED, new MemoryEntityBackend());
  const seen: JSONValue[] = [];
  rt.load({
    name: 'listener',
    start(c) {
      c.events.on('input:pointer', (d) => {
        (d as { x: number }).x = -999; // hostile mutation must not leak
        seen.push(d);
      });
    },
  });
  const payload = { x: 1, y: 2 };
  rt.emit('input:pointer', payload as JSONValue);
  payload.x = 999; // mutate after emit
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { x: -999, y: 2 }, 'handler saw a copy, isolated from the host original');
});

test('script: per-entity events and world state store', () => {
  const rt = new ScriptRuntime(SEED, new MemoryEntityBackend());
  let hits = 0;
  rt.load({
    name: 'e',
    start(c) {
      const h = c.world.spawn('ent', { tag: 'mob' });
      h.on('ping', () => { hits++; });
      c.world.setState('score', 41);
      c.events.on('bump', () => c.world.setState('score', 42));
    },
    update(c) {
      const h = c.world.find('ent')!;
      if (hits === 0) h.emit('ping');
    },
  });
  rt.update(1 / 60, 0);
  rt.update(1 / 60, 1 / 60);
  assert.equal(hits, 1);
  const caps = rtCaps(rt);
  assert.equal(caps.world.state('score'), 41);
  caps.world.query('mob').forEach((h) => assert.equal(h.getTag(), 'mob'));
  rt.emit('bump');
  assert.equal(caps.world.state('score'), 42);
});

test('script: audio sink composes the C# arp + hats layers', () => {
  const rt = new ScriptRuntime(SEED, new MemoryEntityBackend(), { onLog: () => {} });
  rt.load(arpScript);
  rt.load(hatsScript);
  const notes = rt.drainAudio();
  assert.equal(notes.length, 64 + 32);
  assert.equal(rt.drainAudio().length, 0, 'drain clears the sink');
  const arpN = notes.filter((n) => n.kind === 'tone').length;
  const hatN = notes.filter((n) => n.kind === 'noise').length;
  assert.equal(arpN, 64);
  assert.equal(hatN, 32);
});

test('script: arp/hats parity with the committed C# ScoreComposer output', () => {
  // Oracle: demo/public/gen/csharp-score.json, generated by dotnet ScoreGen.
  // NOTE on ordering: C# List<T>.Sort is UNSTABLE (introsort), so at tied
  // timestamps the committed file's arp-before-hat vs hat-before-arp order
  // is a sort artifact, not composition. Parity is therefore proven on the
  // event MULTISET: both sides sorted by a total key, then compared field
  // by field. t/dur/kind/gain must match exactly; freq crosses a
  // C# Math.Pow boundary, so it is compared within half a rounding cent.
  const url = new URL('../../demo/public/gen/csharp-score.json', import.meta.url);
  const doc = JSON.parse(readFileSync(url, 'utf8')) as {
    seed: number; loopDur: number;
    events: { t: number; dur: number; freq: number; kind: string; gain: number }[];
  };
  assert.equal(doc.seed, 20261010);
  const { arp, hats } = composeArpHats(20261010);
  const key = (e: { t: number; kind: string; freq: number; gain: number; dur: number }): string =>
    `${e.t.toFixed(4)}|${e.kind}|${e.freq.toFixed(2)}|${e.gain}|${e.dur}`;
  const mine = [...arp, ...hats].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  const theirs = [...doc.events].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  assert.equal(mine.length, theirs.length);
  for (let i = 0; i < theirs.length; i++) {
    const m = mine[i], e = theirs[i];
    assert.equal(key(m).split('|').slice(0, 2).join('|'), key(e).split('|').slice(0, 2).join('|'), `event ${i} t|kind`);
    assert.equal(m.dur, e.dur, `event ${i} dur`);
    assert.equal(m.gain, e.gain, `event ${i} gain`);
    assert.ok(Math.abs(m.freq - e.freq) < 0.005, `event ${i} freq: ${m.freq} vs ${e.freq}`);
  }
});

test('script: unload stops the script and calls stop()', () => {
  const rt = new ScriptRuntime(SEED, new MemoryEntityBackend());
  let ticks = 0, stopped = false;
  rt.load({
    name: 'tmp',
    update() { ticks++; },
    stop() { stopped = true; },
  });
  rt.update(1 / 60, 0);
  rt.unload('tmp');
  rt.update(1 / 60, 1 / 60);
  assert.equal(ticks, 1);
  assert.ok(stopped);
  assert.deepEqual(rt.loadedNames, []);
});

test('script: SceneEntityBackend drives real SceneNodes', () => {
  const root = new SceneNode('root');
  const rt = new ScriptRuntime(SEED, new SceneEntityBackend(root), { onLog: () => {} });
  rt.load(floatScript);
  rt.update(1 / 60, 0);
  let found: SceneNode | null = null;
  root.traverse((n) => { if (n.name === 'float-ember') found = n; });
  assert.ok(found, 'entity spawned as a real scene node');
  assert.equal((found as SceneNode).parent, root);
});

// ---------- (c) graduated capability grants ----------

test('script: restricted grants deny ungranted capabilities', () => {
  const rt = new ScriptRuntime(SEED, new MemoryEntityBackend());
  const caps = rt.load({ name: 'low' }, { grants: ['rng', 'time', 'log'] });
  assert.deepEqual([...caps.capabilities].sort(), ['log', 'rng', 'time']);
  assert.throws(() => caps.audio.note({ t: 0, dur: 0.1, freq: 440, kind: 'tone', gain: 0.1 }),
    /capability 'audio' not granted/);
  assert.throws(() => caps.world.spawn('x'), /capability 'world.spawn' not granted/);
  assert.throws(() => caps.events.on('e', () => {}), /capability 'events' not granted/);
  assert.throws(() => caps.world.state('k'), /capability 'world.state' not granted/);
  // granted ones still work
  assert.ok(caps.rng() >= 0 && caps.rng() < 1);
  assert.equal(typeof caps.time.now(), 'number');
});

test('script: default grant set is full authorship', () => {
  const rt = new ScriptRuntime(SEED, new MemoryEntityBackend());
  const caps = rt.load({ name: 'full' });
  assert.deepEqual([...caps.capabilities].sort(), [...ALL_CAPABILITIES].sort());
  const h = caps.world.spawn('x');
  assert.ok(h.alive);
});

test('script: foundry tier shape - six per-domain write grants exist', () => {
  const domains = ['scene', 'genesis', 'biome', 'tempo', 'light', 'presence'] as const;
  for (const d of domains) {
    const cap = `field.write.${d}` as const;
    assert.ok((ALL_CAPABILITIES as readonly string[]).includes(cap), cap);
  }
  assert.ok((ALL_CAPABILITIES as readonly string[]).includes('field.read'));
});

// ---------- (b) adversarial sandbox boundary tests ----------
//
// Threat model (honest): these prove CAPABILITY-CLOSURE - nothing reachable
// through the capability object graph leads to engine internals. They do NOT
// prove containment of a malicious actor wielding the full JS language
// (Function('return this')() etc.); full realm isolation is future work.

function hostileCaps(): { rt: ScriptRuntime; caps: Caps; handle: EntityHandle } {
  const rt = new ScriptRuntime(SEED, new MemoryEntityBackend());
  let caps: Caps | null = null;
  let handle: EntityHandle | null = null;
  rt.load({
    name: 'hostile',
    start(c) {
      caps = c;
      handle = c.world.spawn('victim', { position: [1, 2, 3] });
    },
  });
  return { rt, caps: caps!, handle: handle! };
}

test('sandbox: capability object graph is frozen and closed', () => {
  const { rt, caps, handle } = hostileCaps();
  for (const obj of [caps, caps.world, caps.events, caps.audio, caps.time]) {
    assert.ok(Object.isFrozen(obj), 'caps namespace frozen');
  }
  assert.ok(Object.isFrozen(handle), 'entity handle frozen');
  assert.throws(() => { (caps as unknown as Record<string, unknown>).world = null; },
    TypeError, 'cannot rebind a frozen caps member');
  assert.throws(() => { (handle as unknown as Record<string, unknown>).name = 'pwned'; },
    TypeError, 'cannot rebind a frozen handle member');
  // No engine internals reachable through the graph (no SceneNode, no
  // backend, no runtime, no renderer). Closures are not traversed.
  const hit = graphContains(caps, [SceneNode, MemoryEntityBackend, SceneEntityBackend, ScriptRuntime]);
  assert.equal(hit, null, `no internals leak through caps (found ${hit?.name})`);
  const hitH = graphContains(handle, [SceneNode, MemoryEntityBackend, ScriptRuntime]);
  assert.equal(hitH, null, 'no internals leak through the handle');
  rt.unload('hostile');
});

test('sandbox: handle exposes no forgeable identity', () => {
  const { handle } = hostileCaps();
  const keys = Object.getOwnPropertyNames(handle).sort();
  assert.deepEqual(keys, ['alive', 'emit', 'getTag', 'getTransform', 'id', 'name', 'on', 'setTag', 'setTransform', 'translate']);
  for (const k of keys) assert.ok(!k.startsWith('_'), `no private-looking key: ${k}`);
  assert.equal(Object.getPrototypeOf(handle), Object.prototype);
  // The numeric id is informational only: no capability function accepts a
  // raw id, so copying it onto a forged object grants nothing - authority
  // flows exclusively through the engine-side WeakMap-bound handle object
  // (see 'forged handles cannot destroy entities' below).
});

test('sandbox: forged handles cannot destroy entities (no confused deputy)', () => {
  const { rt, caps } = hostileCaps();
  const before = caps.world.query('').length;
  assert.doesNotThrow(() => caps.world.destroy({} as unknown as EntityHandle));
  assert.doesNotThrow(() => caps.world.destroy(null as unknown as EntityHandle));
  assert.equal(caps.world.query('').length, before, 'nothing destroyed');
  assert.doesNotThrow(() => caps.world.destroy({ alive: false } as unknown as EntityHandle));
  rt.unload('hostile');
});

test('sandbox: transform snapshots are copies, validated on the way in', () => {
  const { caps, handle } = hostileCaps();
  const t = handle.getTransform();
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.position));
  assert.throws(() => { (t.position as unknown as number[])[0] = 999; }, TypeError,
    'frozen snapshot cannot be mutated through');
  assert.equal(handle.getTransform().position[0], 1, 'mutating the snapshot changes nothing');
  assert.throws(() => handle.setTransform({
    position: [NaN, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
  }), /finite/);
  assert.throws(() => handle.setTransform({
    position: [Infinity, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
  }), /finite/);
  assert.equal(caps.world.find('victim')!.getTransform().position[0], 1);
});

test('sandbox: world state and event payloads are copied across the boundary', () => {
  const { caps } = hostileCaps();
  const original = { nested: { v: 1 } };
  caps.world.setState('k', original as unknown as JSONValue);
  original.nested.v = 999;
  assert.deepEqual(caps.world.state('k'), { nested: { v: 1 } });
  const stored = caps.world.state('k') as { nested: { v: number } };
  stored.nested.v = 999;
  assert.deepEqual(caps.world.state('k'), { nested: { v: 1 } }, 'read path also copies');
});

test('sandbox: audio sink validates like an untrusted score doc', () => {
  const { caps } = hostileCaps();
  assert.throws(() => caps.audio.note({ t: 0, dur: 0.1, freq: 440, kind: 'bass' as 'tone', gain: 0.1 }), /kind/);
  assert.throws(() => caps.audio.note({ t: 0, dur: 0.1, freq: 440, kind: 'tone', gain: 2 }), /range/);
  assert.throws(() => caps.audio.note({ t: 0, dur: -1, freq: 440, kind: 'tone', gain: 0.1 }), /range/);
});

test('sandbox: dead handles fail loudly, double-destroy is safe', () => {
  const { caps } = hostileCaps();
  const h = caps.world.find('victim')!;
  caps.world.destroy(h);
  assert.equal(h.alive, false);
  assert.throws(() => h.getTransform(), /dead/);
  assert.doesNotThrow(() => caps.world.destroy(h));
  assert.equal(caps.world.find('victim'), null);
});
