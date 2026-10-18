// Unit tests for V4 step 2: world composition (runs in node).
// (a) determinism - same global seed -> identical composed world;
// (b) coherence - independently authored zones share one continuous field;
// (c) portals - transition preserves entity state, lands at target spawn;
// (d) wind field properties - multi-directional, time-varying, deterministic;
// (e) six-domain write re-derivation - foundry levers reorganize the world;
// (f) descriptors - JSON round-trip + validation; (g) script integration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GlobalField, ComposedWorld, Zone, WindField,
  parseZoneDescriptor, loadZoneDescriptors,
  SAMPLE_ZONES, SAMPLE_ZONE_JSON, SAMPLE_ZONE_EMBER_REACH, SAMPLE_ZONE_MOTE_HOLLOW,
} from '../src/world/index.js';
import {
  ScriptRuntime, MemoryEntityBackend,
} from '../src/script/index.js';
import type { Caps, ScriptDef } from '../src/script/index.js';
import type { TransformData } from '../src/script/index.js';
import { terrain } from '../src/geo/terrain.js';

const SEED = 20261010;

interface Stack {
  field: GlobalField;
  rt: ScriptRuntime;
  world: ComposedWorld;
}

/** Two fully independent stacks, same seed, same descriptors. */
function makeStack(seed: number): Stack {
  const field = new GlobalField(undefined, seed);
  const rt = new ScriptRuntime(seed, new MemoryEntityBackend(), { field });
  const world = new ComposedWorld(field, rt);
  world.loadZones(SAMPLE_ZONE_JSON);
  return { field, rt, world };
}

const T0: TransformData = {
  position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
};

// ---------- (a) determinism ----------

test('world: same global seed -> identical composed world', () => {
  const a = makeStack(SEED);
  const b = makeStack(SEED);
  assert.deepEqual(a.world.snapshot(), b.world.snapshot());
  // Field samples on a grid: identical across independent stacks.
  for (let x = -100; x <= 100; x += 25) {
    for (let z = -100; z <= 100; z += 25) {
      const sa = a.field.sampleWorld(x, 0, z, 3.7);
      const sb = b.field.sampleWorld(x, 0, z, 3.7);
      assert.deepEqual(sa, sb, `field sample at (${x}, ${z})`);
    }
  }
  // Terrain heights identical per zone.
  for (const zid of a.world.zoneIds) {
    const za = a.world.getZone(zid)!, zb = b.world.getZone(zid)!;
    const ha = za.heightSampler(), hb = zb.heightSampler();
    for (let x = -40; x <= 40; x += 20) {
      for (let z = -40; z <= 40; z += 20) {
        assert.equal(ha(x, z), hb(x, z), `terrain ${zid} at (${x},${z})`);
      }
    }
  }
  // Different global seed -> different world.
  const c = makeStack(SEED + 1);
  assert.notDeepEqual(a.world.snapshot(), c.world.snapshot());
});

// ---------- (b) coherence ----------

test('world: field is continuous across the portal seam', () => {
  const { world } = makeStack(SEED);
  // The gate-to-reach portal mouth in world space.
  const mouth: [number, number, number] = [-52, 4, 0];
  const seam = world.seamSample('mote-hollow', 'ember-reach', mouth, 12.5);
  assert.ok(seam.identical, 'global field identical through both zones at the seam');
  // Probe several points around the seam, several times.
  for (const t of [0, 7.3, 42]) {
    for (const p of [[-52, 4, 0], [-48, 4, 4], [-56, 4, -4]] as [number, number, number][]) {
      const s = world.seamSample('mote-hollow', 'ember-reach', p, t);
      assert.ok(s.identical, `seam continuous at ${p} t=${t}`);
    }
  }
});

test('world: local wind derives from the global field, never a zone seed', () => {
  const field = new GlobalField(undefined, SEED);
  // Two zones at the SAME placement, different local seeds.
  const mk = (seed: number, gustScale: number): Zone => {
    const d = JSON.parse(JSON.stringify(SAMPLE_ZONE_EMBER_REACH)) as typeof SAMPLE_ZONE_EMBER_REACH;
    d.id = `z-${seed}`; d.seed = seed; d.wind.gustScale = gustScale;
    return new Zone(parseZoneDescriptor(d), field);
  };
  const za = mk(111, 1.0), zb = mk(222, 1.4);
  const p: [number, number, number] = [10, 2, -7];
  // Same world point -> same GLOBAL sample regardless of zone seed.
  assert.deepEqual(za.globalWindAt(p, 5), zb.globalWindAt(p, 5));
  // Local winds differ only by the authored weight, in the exact law's form:
  // local = global * gustScale + anchorMean * biasWeight.
  const g = za.globalWindAt(p, 5);
  const la = za.localWind(p, 5), lb = zb.localWind(p, 5);
  const pa = za.prevailingWind, pb = zb.prevailingWind;
  assert.ok(Math.abs(la.x - (g.x * 1.0 + pa.x * za.descriptor.wind.biasWeight)) < 1e-12);
  assert.ok(Math.abs(lb.x - (g.x * 1.4 + pb.x * zb.descriptor.wind.biasWeight)) < 1e-12);
  // And the prevailing winds match: same placement, same global field.
  assert.deepEqual(pa, pb);
});

// ---------- (c) portals ----------

test('world: portal transition preserves entity, lands at target spawn', () => {
  const { field, rt, world } = makeStack(SEED);
  const seen: string[] = [];
  const probe: ScriptDef = {
    name: 'probe',
    start(c: Caps) {
      c.world.setState('player1:hp', 100);
      c.events.on('portal:exit', (d) => { seen.push('exit:' + (d as { fromZone: string }).fromZone); });
      c.events.on('portal:enter', (d) => { seen.push('enter:' + (d as { toZone: string }).toZone); });
    },
  };
  rt.load(probe);
  // Traveler at the mote-hollow gate-to-reach mouth (world [-52,4,0], r=4).
  const id = rt.spawnHost('player1', {
    ...T0, position: [-52, 4, 0],
  }, { tag: 'player' });
  const before = rt.hostGetTransform(id)!;
  assert.deepEqual(before.position, [-52, 4, 0]);

  const crossings = world.update(1 / 60, 10.0);
  assert.equal(crossings.length, 1);
  const c = crossings[0];
  assert.equal(c.fromZone, 'mote-hollow');
  assert.equal(c.toZone, 'ember-reach');
  assert.equal(c.entityId, id, 'same entity id - identity preserved, not recreated');
  assert.equal(c.entityName, 'player1');
  // Arrival: ember-reach offset [-140,0,0] + targetSpawn [52,4,0].
  assert.deepEqual(c.arrival, [-88, 4, 0]);
  const after = rt.hostGetTransform(id)!;
  assert.deepEqual(after.position, [-88, 4, 0]);
  assert.deepEqual(after.rotation, before.rotation, 'rotation preserved');
  // State continuity: world-state survived the crossing (same runtime).
  let hp: unknown = null;
  rt.load({
    name: 'reader', start(cc: Caps) { hp = cc.world.state('player1:hp'); },
  });
  assert.equal(hp, 100);
  // Events fired on both sides.
  assert.deepEqual(seen, ['exit:mote-hollow', 'enter:ember-reach']);
  assert.equal(world.portalHandoff.crossingCount(id), 1);
  void field;
});

test('world: crossing cooldown prevents instant re-trigger at arrival', () => {
  const { rt, world } = makeStack(SEED);
  const id = rt.spawnHost('player1', { ...T0, position: [-52, 4, 0] }, { tag: 'player' });
  // Arrival point [-88,4,0] is exactly the return portal mouth - cooldown
  // must hold it for CROSSING_COOLDOWN seconds.
  const c1 = world.update(1 / 60, 20.0);
  assert.equal(c1.length, 1);
  const c2 = world.update(1 / 60, 20.0 + 0.5);
  assert.equal(c2.length, 0, 'no instant bounce-back');
  const c3 = world.update(1 / 60, 20.0 + 2.0);
  assert.equal(c3.length, 1, 'return trip works after cooldown');
  assert.equal(c3[0].toZone, 'mote-hollow');
  assert.deepEqual(rt.hostGetTransform(id)!.position, [-52, 4, 0]);
  assert.equal(world.portalHandoff.crossingCount(id), 2);
});

test('world: dangling portal links never teleport', () => {
  const field = new GlobalField(undefined, SEED);
  const rt = new ScriptRuntime(SEED, new MemoryEntityBackend(), { field });
  const world = new ComposedWorld(field, rt);
  const d = JSON.parse(JSON.stringify(SAMPLE_ZONE_EMBER_REACH)) as typeof SAMPLE_ZONE_EMBER_REACH;
  d.portals[0].targetZone = 'nowhere';
  world.loadZones([d]);
  const id = rt.spawnHost('player1', { ...T0, position: [-88, 4, 0] }, { tag: 'player' });
  const out = world.update(1 / 60, 0);
  assert.equal(out.length, 0);
  assert.deepEqual(rt.hostGetTransform(id)!.position, [-88, 4, 0], 'traveler unmoved');
});

// ---------- (d) wind field properties ----------

test('world: wind is multi-directional, never one direction', () => {
  const f = new WindField(SEED, {
    gain: 1, gustStrength: 0.35, playerCoupling: 0,
  });
  const vecs: { x: number; y: number; z: number }[] = [];
  for (let x = -120; x <= 120; x += 20) {
    for (let z = -120; z <= 120; z += 20) {
      vecs.push(f.sample(x, 0, z, 0));
    }
  }
  // Not constant: magnitudes vary across subsections.
  const mags = vecs.map((v) => Math.hypot(v.x, v.y, v.z));
  const mean = mags.reduce((a, b) => a + b, 0) / mags.length;
  const variance = mags.reduce((a, b) => a + (b - mean) ** 2, 0) / mags.length;
  assert.ok(variance > 1e-6, `force varies across subsections (var=${variance})`);
  assert.ok(Math.max(...mags) > 2 * Math.min(...mags), 'force levels differ across the world');
  // Multi-directional: headings spread, not a single heading.
  let maxAngle = 0;
  for (let i = 0; i < vecs.length; i += 7) {
    for (let j = i + 7; j < vecs.length; j += 7) {
      const a = vecs[i], b = vecs[j];
      const la = Math.hypot(a.x, a.z) || 1, lb = Math.hypot(b.x, b.z) || 1;
      const cosang = Math.max(-1, Math.min(1, (a.x * b.x + a.z * b.z) / (la * lb)));
      maxAngle = Math.max(maxAngle, Math.acos(cosang));
    }
  }
  assert.ok(maxAngle > Math.PI / 3, `headings spread widely (max ${maxAngle.toFixed(2)} rad)`);
});

test('world: wind is time-varying and deterministic', () => {
  const f = new WindField(SEED, {
    gain: 1, gustStrength: 0.35, playerCoupling: 0.5,
  });
  const p = { x: 37, y: 2, z: -91 };
  const s0 = f.sample(p.x, p.y, p.z, 0);
  const s1 = f.sample(p.x, p.y, p.z, 30);
  assert.notDeepEqual(s0, s1, 'field changes over time');
  assert.deepEqual(f.sample(p.x, p.y, p.z, 30), s1, 'same (p, t) -> identical vector');
  // Player wake (7th lever): motion stirs the field locally, deterministically.
  f.setPlayerState({ position: [37, 2, -91], speed: 6, rhythm: 0.25 });
  const w0 = f.sample(p.x, p.y, p.z, 30);
  assert.notDeepEqual(w0, s1, 'player motion perturbs the local field');
  assert.deepEqual(f.sample(p.x, p.y, p.z, 30), w0, 'wake is deterministic');
  f.setPlayerState(null);
  assert.deepEqual(f.sample(p.x, p.y, p.z, 30), s1, 'clearing player state restores the field');
});

// ---------- (e) six-domain write re-derivation ----------

test('world: six foundry levers re-derive the world deterministically', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['scene', { terrainHeight: 1.5 }],
    ['genesis', { seed: 99 }],
    ['genesis', { gain: 2.0 }], // wind's global gain rides the genesis lever
    ['biome', { moteDensity: 0.9 }],
    ['tempo', { energy: 0.9 }],
    ['light', { timeOfDay: 0.9 }],
    ['presence', { gravity: 3.7 }],
  ];
  for (const [domain, patch] of cases) {
    const f1 = new GlobalField(undefined, SEED);
    const f2 = new GlobalField(undefined, SEED);
    const rev = f1.revision;
    const snap1 = f1.setDomain(domain as 'scene', patch);
    assert.equal(f1.revision, rev + 1, `${domain}: revision bumps`);
    f2.setDomain(domain as 'scene', patch);
    assert.deepEqual(f1.snapshot(), f2.snapshot(), `${domain}: same patch -> identical params`);
    assert.deepEqual(snap1, f2.snapshot());
    assert.throws(
      () => f1.setDomain(domain as 'scene', { bogusKey: 1 }),
      /unknown param/, `${domain}: unknown keys rejected`,
    );
  }
  // No-op patch: revision does NOT bump.
  const f = new GlobalField(undefined, SEED);
  const rev = f.revision;
  f.setDomain('tempo', { energy: 0.5 });
  assert.equal(f.revision, rev, 'identical values -> no spurious revision');
});

test('world: lever changes visibly reorganize downstream systems', () => {
  const { field, world } = makeStack(SEED);
  const zone = world.getZone('shimmer-flats')!;
  // Wind gain doubles current magnitudes (ember currents shift).
  const p: [number, number, number] = [20, 2, 10];
  const m0 = Math.hypot(...Object.values(zone.localWind(p, 3)));
  field.setDomain('genesis', { gain: 2 });
  const m1 = Math.hypot(...Object.values(zone.localWind(p, 3)));
  assert.ok(Math.abs(m1 / m0 - 2) < 1e-9, `wind gain doubles local currents (${m0} -> ${m1})`);
  // Genesis seed reshapes terrain bones.
  const seedBefore = zone.summarize().terrainSeed;
  field.setDomain('genesis', { seed: 777 });
  zone.sync();
  assert.notEqual(zone.summarize().terrainSeed, seedBefore);
  // Scene terrainHeight rescales built terrain.
  const g1 = zone.buildTerrain(0);
  let max1 = 0;
  for (let i = 0; i < g1.positions.length; i += 3) max1 = Math.max(max1, g1.positions[i + 1]);
  field.setDomain('scene', { terrainHeight: 2 });
  const g2 = zone.buildTerrain(0);
  let max2 = 0;
  for (let i = 0; i < g2.positions.length; i += 3) max2 = Math.max(max2, g2.positions[i + 1]);
  assert.ok(max2 > max1 * 1.5, `terrain height rescales geometry (${max1} -> ${max2})`);
});

// ---------- terrain is the water ----------

test('world: terrain carries the wind texture (shimmer + lean)', () => {
  const { world } = makeStack(SEED);
  const zone = world.getZone('shimmer-flats')!;
  const sampler = zone.heightSampler();
  const d = zone.descriptor.terrain;
  const withWind = terrain({
    size: d.size, segments: 16, height: d.height,
    sampler, shimmer: zone.windShimmer(4.0),
  });
  const withoutWind = terrain({
    size: d.size, segments: 16, height: d.height, sampler,
  });
  // Ripple: heights differ where the wind blows.
  let diff = 0;
  for (let i = 0; i < withWind.positions.length; i += 3) {
    diff = Math.max(diff, Math.abs(withWind.positions[i + 1] - withoutWind.positions[i + 1]));
  }
  assert.ok(diff > 1e-6, `wind ripple perturbs heights (max Δ=${diff})`);
  // Lean: normals tilt along the local wind on average.
  let align = 0, n = 0;
  const size = d.size, segs = 16;
  for (let j = 0; j <= segs; j++) {
    for (let i = 0; i <= segs; i++) {
      const k = (j * (segs + 1) + i) * 3;
      const x = (i / segs - 0.5) * size, z = (j / segs - 0.5) * size;
      const w = zone.localWind([x, 0, z], 4.0);
      const wm = Math.hypot(w.x, w.z);
      if (wm < 1e-6) continue;
      align += (withWind.normals[k] * w.x + withWind.normals[k + 2] * w.z) / wm;
      n++;
    }
  }
  assert.ok(align / n > 0, `normals lean along the wind (avg alignment ${align / n})`);
});

// ---------- (f) descriptors ----------

test('world: descriptors round-trip through JSON; validation is strict', () => {
  const raw = JSON.parse(JSON.stringify(SAMPLE_ZONE_EMBER_REACH)) as unknown;
  const parsed = parseZoneDescriptor(raw);
  assert.equal(parsed.id, 'ember-reach');
  assert.equal(parsed.portals.length, 1);
  // A wind.seed is forbidden by the architectural law - rejected at the door.
  const bad = JSON.parse(JSON.stringify(SAMPLE_ZONE_EMBER_REACH)) as Record<string, unknown>;
  (bad.wind as Record<string, unknown>).seed = 123;
  assert.throws(() => parseZoneDescriptor(bad), /wind\.seed.*forbidden/);
  // Other malformations rejected loudly.
  const missing = JSON.parse(JSON.stringify(SAMPLE_ZONE_EMBER_REACH)) as Record<string, unknown>;
  delete missing.biome;
  assert.throws(() => parseZoneDescriptor(missing), /biome section/);
  const dup = JSON.parse(JSON.stringify(SAMPLE_ZONE_MOTE_HOLLOW)) as typeof SAMPLE_ZONE_MOTE_HOLLOW;
  dup.portals[1].id = dup.portals[0].id;
  assert.throws(() => parseZoneDescriptor(dup), /duplicate portal id/);
  // loadZoneDescriptors binds every zone to the one shared field.
  const field = new GlobalField(undefined, SEED);
  const zones = loadZoneDescriptors(SAMPLE_ZONE_JSON, field);
  assert.equal(zones.length, 3);
  for (const z of zones) assert.equal(z.field, field);
});

// ---------- (g) script integration ----------

test('world: scripts sample the wind through caps.field (grant-gated)', () => {
  const field = new GlobalField(undefined, SEED);
  const rt = new ScriptRuntime(SEED, new MemoryEntityBackend(), { field });
  let sampled: [number, number, number] | null = null;
  let paramsSeen = false;
  rt.load({
    name: 'reader',
    start(c: Caps) {
      sampled = c.field.wind([10, 0, -5], 2.5);
      paramsSeen = typeof (c.field.params() as { globalSeed: number }).globalSeed === 'number';
      assert.ok(Object.isFrozen(c.field), 'field namespace frozen');
      assert.ok(Object.isFrozen(sampled), 'wind sample frozen');
    },
  }, { grants: ['field.read', 'log'] });
  const expect = field.sampleWorld(10, 0, -5, 2.5);
  assert.deepEqual(sampled, [expect.x, expect.y, expect.z]);
  assert.ok(paramsSeen);
  rt.load({ name: 'denied', start(c: Caps) { c.field.wind([0, 0, 0], 0); } },
    { grants: ['log'] });
  assert.equal(rt.errors.length, 1);
  assert.match(String(rt.errors[0].err), /capability 'field.read' not granted/);
});

test('world: scripts write foundry domains through the six write grants', () => {
  const field = new GlobalField(undefined, SEED);
  const rt = new ScriptRuntime(SEED, new MemoryEntityBackend(), { field });
  const rev = field.revision;
  rt.load({
    name: 'foundry',
    start(c: Caps) {
      const snap = c.field.set('tempo', { energy: 0.95 }) as { tempo: { energy: number } };
      assert.equal(snap.tempo.energy, 0.95);
      assert.throws(() => c.field.set('light', { exposure: 2 }),
        /capability 'field.write.light' not granted/);
      assert.throws(() => c.field.set('tempo', { bogus: 1 }), /unknown param/);
    },
  }, { grants: ['field.write.tempo', 'log'] });
  assert.equal(field.revision, rev + 1);
  assert.equal(field.snapshot().tempo.energy, 0.95);
});

test('world: scripts spawn and link portals through world.spawn', () => {
  const { rt, world } = makeStack(SEED);
  let portalEntityId = -1;
  rt.load({
    name: 'gatekeeper',
    start(c: Caps) {
      const h = c.world.spawn('dev-gate', {
        position: [0, 5, 0], tag: 'portal',
        portal: { targetZone: 'shimmer-flats', targetSpawn: [0, 4, 0], radius: 2.5, label: 'dev gate' },
      });
      assert.equal(h.getTag(), 'portal');
      assert.throws(() => c.world.spawn('bad-gate', {
        portal: { targetZone: '', targetSpawn: [0, 0, 0] },
      }), /targetZone/);
    },
  });
  for (const e of rt.hostEntities()) {
    if (e.name === 'dev-gate') portalEntityId = e.id;
  }
  assert.ok(portalEntityId > 0);
  const link = rt.portalLink(portalEntityId);
  assert.deepEqual(link, {
    targetZone: 'shimmer-flats', targetSpawn: [0, 4, 0],
    radius: 2.5, label: 'dev gate',
  });
  // A script-spawned portal is NOT part of the loader's stitched set, but
  // the link record is intact engine-side for hosts to adopt.
  assert.ok(!world.portalRecords.some((p) => p.entityId === portalEntityId));
  rt.load({ name: 'nog', start(c: Caps) { c.world.spawn('x'); } }, { grants: ['log'] });
  assert.ok(rt.errors.some((e) => /capability 'world.spawn' not granted/.test(String(e.err))));
});
