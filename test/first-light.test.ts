// Unit tests for V4 step 3: First Light (the game).
// Runs headless in node against MemoryEntityBackend — no renderer, no DOM.
// Covers: shared math (gust front, stillwater ride, thresholds), the step-3
// API fixes (spawn bodies, probe, script-portal adoption, host event tap),
// and the game logic that is testable headless: attunement scoring, the
// gate's resonance condition, lever -> domain wiring, secret-path gating,
// and lever unlock gating.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ScriptRuntime, MemoryEntityBackend,
} from '../src/script/index.js';
import type { Caps, JSONValue } from '../src/script/index.js';
import { sanitizeBody } from '../src/script/sandbox.js';
import {
  GlobalField, ComposedWorld,
} from '../src/world/index.js';
import {
  GAME_SEED, gustFront, stillwaterRide, attuneLevel, ATTUNE_LEVELS,
  SECRET_PORTAL_POS, LEVER_POS,
} from '../games/first-light/shared.js';
import { FIRST_LIGHT_ZONES_JSON } from '../games/first-light/zones.js';
import { playerScript, PLAYER_GRANTS } from '../games/first-light/scripts/player.js';
import { embersScript, EMBER_GRANTS } from '../games/first-light/scripts/embers.js';
import { attunementScript, ATTUNE_GRANTS, scoreAlignment, scoreStillness } from '../games/first-light/scripts/attunement.js';
import { gateScript, GATE_GRANTS } from '../games/first-light/scripts/gate.js';
import { secretScript, SECRET_GRANTS } from '../games/first-light/scripts/secret.js';
import { foundryScript, FOUNDRY_GRANTS } from '../games/first-light/scripts/foundry.js';
import { leverScripts, leverGrants, leverStep } from '../games/first-light/scripts/levers.js';
import { LEVER_SPECS } from '../games/first-light/shared.js';

const SEED = GAME_SEED;

interface Stack {
  field: GlobalField;
  rt: ScriptRuntime;
  world: ComposedWorld;
  backend: MemoryEntityBackend;
  tapped: Array<{ event: string; data: JSONValue }>;
}

function makeStack(): Stack {
  const field = new GlobalField(undefined, SEED);
  const backend = new MemoryEntityBackend();
  const tapped: Array<{ event: string; data: JSONValue }> = [];
  const rt = new ScriptRuntime(SEED, backend, {
    field,
    onEvent: (event, data) => tapped.push({ event, data }),
  });
  const world = new ComposedWorld(field, rt);
  world.loadZones(FIRST_LIGHT_ZONES_JSON);
  return { field, rt, world, backend, tapped };
}

// ---------- shared math ----------

test('first-light: gust front envelope is a slow pulse', () => {
  assert.equal(gustFront(0), 0);
  assert.ok(gustFront(3.15) > 0.99, 'peaks mid-front');
  assert.equal(gustFront(9), 0, 'quiet between fronts');
  assert.equal(gustFront(18), gustFront(0), 'periodic');
  for (let t = 0; t < 18; t += 0.5) {
    const f = gustFront(t);
    assert.ok(f >= 0 && f <= 1, `front(${t}) in [0,1]`);
  }
});

test('first-light: stillwater ride rewards only aligned motion', () => {
  // Aligned with a +z wind during a front: strong ride downwind.
  const [rx, rz] = stillwaterRide(0, 1, 0.2, 3, 1);
  assert.ok(rz > 8, `aligned ride carries far (got ${rz})`);
  assert.ok(Math.abs(rx) < 1, 'ride follows the wind, not the wish');
  // Perpendicular wish: no ride.
  const [qx, qz] = stillwaterRide(1, 0, 0, 3, 1);
  assert.ok(Math.hypot(qx, qz) < 1e-9, 'cross-wind wish gets nothing');
  // No input: nothing.
  assert.deepEqual(stillwaterRide(0, 0, 0, 3, 1), [0, 0]);
  // No front, aligned: weak but nonzero (a breath, not a crossing).
  const [, bz] = stillwaterRide(0, 1, 0, 3, 0);
  assert.ok(bz > 0 && bz < 3, `breath without front is weak (got ${bz})`);
});

test('first-light: attunement thresholds map to six levels', () => {
  assert.equal(attuneLevel(0), 0);
  ATTUNE_LEVELS.forEach((th, i) => {
    assert.equal(attuneLevel(th), i + 1, `threshold ${th} -> level ${i + 1}`);
    assert.equal(attuneLevel(th - 0.5), i, `just below ${th} stays level ${i}`);
  });
  assert.equal(attuneLevel(100), 6);
});

test('first-light: scoring primitives', () => {
  assert.ok(scoreAlignment(3, 0, 3, 4, 0) > 0.3, 'downwind motion scores');
  assert.equal(scoreAlignment(0, 0, 0, 4, 0), 0, 'standing still scores nothing');
  assert.ok(scoreAlignment(-3, 0, 3, 4, 0) < 0, 'fighting the wind costs');
  assert.ok(scoreStillness(4, 4.2, 0.2, 0.5) > 0, 'still in a gust scores');
  assert.equal(scoreStillness(4, 4.2, 3, 0.5), 0, 'moving through it does not');
  assert.equal(scoreStillness(1, 4.2, 0.2, 0.5), 0, 'calm air does not');
});

// ---------- API fix: spawn bodies ----------

test('first-light: sanitizeBody validates procedural bodies', () => {
  const good = sanitizeBody({
    geometry: { kind: 'sphere', radius: 0.5, detail: 8 },
    material: { baseColor: [1, 0.5, 0], effects: ['pulse'], unlit: true },
  });
  assert.equal(good.geometry.kind, 'sphere');
  assert.throws(() => sanitizeBody({ geometry: { kind: 'dragon' } } as never), /kind/);
  assert.throws(
    () => sanitizeBody({ geometry: { kind: 'sphere' }, material: { baseColor: [2, 0, 0] } } as never),
    /baseColor/,
  );
  assert.throws(() => sanitizeBody(null as never), /object/);
});

test('first-light: scripts spawn visible bodies through the API', () => {
  const { rt, backend } = makeStack();
  const caps = rt.load({
    name: 't:body',
    start(c: Caps) {
      c.world.spawn('orb', {
        body: { geometry: { kind: 'sphere', radius: 1 }, material: { baseColor: [1, 0, 0] } },
      });
      c.world.spawn('ghost', {});
    },
  });
  void caps;
  const orb = rt.hostEntities().find((e) => e.name === 'orb')!;
  const ghost = rt.hostEntities().find((e) => e.name === 'ghost')!;
  assert.equal(backend.bodies.get(orb.id)?.geometry.kind, 'sphere');
  assert.equal(backend.bodies.get(ghost.id), undefined, 'no body -> transform-only');
  // Grant-gated: without world.spawn the spawn throws.
  const rt2 = makeStack().rt;
  const c2 = rt2.load({ name: 't:nogrant' }, { grants: ['log'] });
  assert.throws(() => c2.world.spawn('x', {}), /world.spawn/);
});

// ---------- API fix: probe ----------

test('first-light: probe answers ground height, grant-gated', () => {
  const field = new GlobalField(undefined, SEED);
  const rt = new ScriptRuntime(SEED, new MemoryEntityBackend(), {
    field,
    probe: () => 7.5,
  });
  const caps = rt.load({ name: 't:probe' }); // default = all capabilities
  assert.equal(caps.probe.ground(10, 20), 7.5);
  const rt2 = new ScriptRuntime(SEED, new MemoryEntityBackend(), { field });
  const c2 = rt2.load({ name: 't:probe2' });
  assert.equal(c2.probe.ground(0, 0), 0, 'unset probe answers 0');
  const c3 = rt.load({ name: 't:probe3' }, { grants: ['log'] });
  assert.throws(() => c3.probe.ground(0, 0), /probe/);
});

// ---------- API fix: host event tap ----------

test('first-light: host taps script-originated events only', () => {
  const { rt, tapped } = makeStack();
  const caps = rt.load({
    name: 't:tap',
    start(c: Caps) {
      c.events.on('ping', () => {});
      c.events.emit('ping', { n: 1 });
    },
  });
  void caps;
  rt.emit('host:ping', {}); // host -> scripts: not tapped
  assert.ok(tapped.some((e) => e.event === 'ping' && (e.data as { n: number }).n === 1));
  assert.ok(!tapped.some((e) => e.event === 'host:ping'), 'host traffic is not re-tapped');
  // The tap gets a copy: mutating it cannot corrupt script state.
  tapped.length = 0;
});

// ---------- attunement: the hidden score ----------

test('first-light: moving with the wind raises attunement; fighting it lowers it', () => {
  const { field, rt } = makeStack();
  // NOTE: playerScript is deliberately NOT loaded here — it would overwrite
  // the pinned player:vel each frame. The attunement script only reads.
  const ecaps = rt.load(embersScript, { grants: EMBER_GRANTS });
  const acaps = rt.load(attunementScript, { grants: ATTUNE_GRANTS });
  void ecaps;
  // Pin the player somewhere and align velocity with the sampled wind.
  const px = -140, pz = -10;
  let t = 42;
  const w0 = field.sampleWorld(px, 2, pz, t);
  const wm0 = Math.hypot(w0.x, w0.z);
  assert.ok(wm0 > 0.5, 'test site has real wind');
  acaps.world.setState('player:pos', [px, 2, pz]);
  const alignVel = (tt: number, sign: 1 | -1): void => {
    const w = field.sampleWorld(px, 2, pz, tt);
    const wm = Math.hypot(w.x, w.z) || 1;
    acaps.world.setState('player:vel', [sign * (w.x / wm) * 4, sign * (w.z / wm) * 4, 4]);
  };
  for (let k = 0; k < 4; k++) { alignVel(t, 1); rt.update(0.5, t); t += 0.5; }
  const up = acaps.world.state('attune:score') as number;
  assert.ok(up > 0.5, `aligned motion scores (got ${up})`);

  // Now fight the same wind, re-aimed every tick (the wind turns).
  for (let k = 0; k < 4; k++) { alignVel(t, -1); rt.update(0.5, t); t += 0.5; }
  const down = acaps.world.state('attune:score') as number;
  assert.ok(down < up, `fighting the wind costs (was ${up}, now ${down})`);
});

test('first-light: attunement levels emit once per threshold, never shown', () => {
  const { field, rt, tapped } = makeStack();
  const acaps = rt.load(attunementScript, { grants: ATTUNE_GRANTS });
  // Drive the score through mechanic A, re-aiming at the wind every tick.
  acaps.world.setState('player:pos', [-140, 2, -10]);
  let t = 100;
  for (let k = 0; k < 200 && (acaps.world.state('attune:level') as number) < 1; k++) {
    const w = field.sampleWorld(-140, 2, -10, t);
    const wm = Math.hypot(w.x, w.z) || 1;
    acaps.world.setState('player:vel', [(w.x / wm) * 4, (w.z / wm) * 4, 4]);
    rt.update(0.5, t);
    t += 0.5;
  }
  const level = acaps.world.state('attune:level') as number;
  assert.ok(level >= 1, 'level rises with sustained aligned motion');
  const emissions = tapped.filter((e) => e.event === 'attune:level');
  assert.equal(emissions.length, level, 'one emission per threshold crossed');
  // The score itself is never emitted anywhere.
  assert.ok(!tapped.some((e) => JSON.stringify(e.data).includes('attune:score')));
});

// ---------- gate: resonance, not collection ----------

test('first-light: the gate opens at resonance (level 6), never before', () => {
  const { rt, tapped } = makeStack();
  const gcaps = rt.load(gateScript, { grants: GATE_GRANTS });
  rt.update(0.016, 1);
  assert.ok(!tapped.some((e) => e.event === 'gate:opened'), 'closed at level 0');
  gcaps.world.setState('attune:level', 5);
  rt.update(0.016, 2);
  assert.ok(!tapped.some((e) => e.event === 'gate:opened'), ' FIVE embers-worth of level still closed');
  gcaps.world.setState('attune:level', 6);
  rt.update(0.016, 3);
  assert.ok(tapped.some((e) => e.event === 'gate:opened'), 'resonance opens it');
  const portal = rt.hostEntities().find((e) => e.name === 'gate-portal');
  assert.ok(portal, 'the way through stands in the gate mouth');
  assert.equal(rt.portalLink(portal!.id)?.targetZone, 'foundry');
});

test('first-light: delivered embers brighten the gate visibly', () => {
  const { rt } = makeStack();
  const pcaps = rt.load(playerScript, { grants: PLAYER_GRANTS });
  const ecaps = rt.load(embersScript, { grants: EMBER_GRANTS });
  const gcaps = rt.load(gateScript, { grants: GATE_GRANTS });
  void pcaps; void ecaps;
  const before = gcaps.world.find('gate')!.getTransform().scale[0];
  // Carry one ember home through the public event flow.
  ecaps.events.emit('ember:delivered', { count: 1 });
  const after = gcaps.world.find('gate')!.getTransform().scale[0];
  assert.ok(after > before, 'the gate grows with each delivered ember');
  assert.ok(rt.hostEntities().some((e) => e.tag === 'spark'), 'sparks orbit the gate');
});

// ---------- secret path: plain sight, embodied crossing ----------

test('first-light: the secret portal is stitched in from minute one', () => {
  const { rt, world } = makeStack();
  rt.load(secretScript, { grants: SECRET_GRANTS });
  assert.equal(world.portalRecords.length, 5, 'five loader portals before adoption');
  world.update(0.016, 1); // adoption runs here
  const rec = world.portalRecords.find((p) => p.link.targetZone === 'foundry'
    && Math.abs(p.zone.toWorld(p.localPosition)[0] - SECRET_PORTAL_POS[0]) < 1);
  assert.ok(rec, 'script-spawned portal adopted into the stitched set');
  // It fires: a traveler in the mouth arrives in the foundry.
  rt.load(playerScript, { grants: PLAYER_GRANTS });
  const player = rt.hostEntities().find((e) => e.name === 'player')!;
  rt.hostSetTransform(player.id, {
    position: [...SECRET_PORTAL_POS],
    rotation: [0, 0, 0, 1], scale: [1, 1, 1],
  });
  const crossings = world.update(0.016, 5);
  assert.equal(crossings.length, 1);
  assert.equal(crossings[0].toZone, 'foundry');
  const tf = rt.hostGetTransform(player.id)!;
  assert.ok(Math.abs(tf.position[2] - 210) < 1, 'arrives at the foundry spawn');
});

// ---------- levers: graduated authorship ----------

test('first-light: lever writes its domain live through its one grant', () => {
  const { field, rt } = makeStack();
  const idx = 3; // C# -> tempo.beatPeriod
  const spec = LEVER_SPECS[idx];
  const before = field.snapshot().tempo.beatPeriod;
  const lcaps = rt.load(leverScripts[idx], { grants: leverGrants(idx) });
  lcaps.world.setState('foundry:held', idx);
  lcaps.events.emit('input:adjust', { d: 1 });
  const after = field.snapshot().tempo.beatPeriod;
  assert.equal(after, before + spec.step, 'one step on the tempo lever');
  assert.equal(field.revision, 1, 'the world re-derives');
  // Without the write grant the same gesture is refused.
  const rt2 = makeStack().rt;
  const denied = rt2.load(leverScripts[idx], {
    grants: ['rng', 'time', 'world.spawn', 'world.query', 'world.state', 'events', 'log', 'field.read', 'probe'],
  });
  assert.equal(rt2.errors.length, 0, 'starts fine without the write grant');
  denied.world.setState('foundry:held', idx);
  denied.events.emit('input:adjust', { d: 1 });
  assert.equal(rt2.errors.length, 1, 'ungranted write is refused, not silently run');
  assert.ok(String(rt2.errors[0].err).includes('field.write.tempo'));
});

test('first-light: leverStep clamps to its range', () => {
  const spec = LEVER_SPECS[2]; // Python, paletteShift 0..1 step 0.05
  assert.equal(leverStep(spec, 0.5, 1), 0.55);
  assert.equal(leverStep(spec, 1, 1), 1, 'clamps at max');
  assert.equal(leverStep(spec, 0, -1), 0, 'clamps at min');
});

test('first-light: dormant levers cannot be grabbed; awake ones can', () => {
  const { rt } = makeStack();
  rt.load(playerScript, { grants: PLAYER_GRANTS });
  const fcaps = rt.load(foundryScript, { grants: FOUNDRY_GRANTS });
  const [lx, , lz] = LEVER_POS[0];
  fcaps.world.setState('player:pos', [lx, 2, lz]);
  fcaps.events.emit('input:interact', {});
  assert.equal(fcaps.world.state('foundry:held'), -1, 'dormant lever ignores the hand');
  fcaps.world.setState('foundry:unlocked:0', 1);
  fcaps.events.emit('input:interact', {});
  assert.equal(fcaps.world.state('foundry:held'), 0, 'awake lever is grabbed');
  fcaps.events.emit('input:interact', {});
  assert.equal(fcaps.world.state('foundry:held'), -1, 'E releases');
});
