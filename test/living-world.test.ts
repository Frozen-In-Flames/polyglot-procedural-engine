// test/living-world.test.ts - v3.0.0 "Living worlds": the campaign's
// systems composed into one world, graded end to end.
//
// One seeded builder (src/scene/living.ts) assembles the v2.0.3
// terrain distance field, v2.0.5 XPBD bodies resting on it, the
// v2.0.8 emission field glowing over it, the v2.0.4-tuned Wald
// watcher, and the v2.0.7-parity character tick as the heartbeat.
// The v2.0.6 interval guaranteed march is the world's view query.
//
// Negative controls, each pinned to fail if the machinery it grades
// is removed or lied to:
//   - sign-flipped gravity in the composed world: nothing settles.
//   - emission disabled at build: the marched color loses exactly
//     the glow and nothing else (the glow in the composed render
//     comes from the layer, not from shading).
//   - an interval march with an understated bound (boundScale 0.5,
//     the v2.0.6 control) overshoots the analytic terrain hit, and
//     the bound-violation checker catches a halved provider.
//   - the watcher's no-change battery: an unchanged world must not
//     alarm beyond the nominal operating point's tolerance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeLivingWorld,
  type LivingWorld,
} from '../src/scene/living.js';
import { raycastTerrain } from '../src/scene/terrain-field.js';
import { marchScene, type Layer } from '../src/scene/layers.js';
import {
  marchInterval,
  terrainIntervalField,
  countIntervalBoundViolations,
  type IntervalField,
} from '../src/math/interval-march.js';
import type { Vec3 } from '../src/math/vec.js';

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const toward = (from: Vec3, to: Vec3): Vec3 =>
  norm([to[0] - from[0], to[1] - from[1], to[2] - from[2]]);

const SEED = 20261022;

/** Run the canonical settle: 1500 ticks (25 s) of heartbeat. */
function settledWorld(seed = SEED): LivingWorld {
  const w = makeLivingWorld({ seed });
  for (let i = 0; i < 1500; i++) w.stepTick();
  return w;
}

test('living: one seed builds the whole composition', () => {
  const a = makeLivingWorld({ seed: SEED });
  const b = makeLivingWorld({ seed: SEED });
  assert.strictEqual(a.digest(), b.digest(), 'same seed, same world');
  const c = makeLivingWorld({ seed: SEED + 1 });
  assert.notStrictEqual(a.digest(), c.digest(), 'seed moves the world');
  assert.ok(a.terrain.slopeBound > 0.5, `slope bound ${a.terrain.slopeBound}`);
  assert.strictEqual(a.bodies.length, 4, 'three singles would be 3; stack makes 4');
  assert.ok(a.emission, 'emission layer present');
  assert.strictEqual(a.tick, 0);
  const layers = a.layers();
  assert.deepStrictEqual(layers.map((l) => l.kind), ['grid', 'emission']);
});

test('living: bodies settle on the terrain field and stay settled', () => {
  const w = makeLivingWorld({ seed: SEED });
  let worstPostPen = 0;
  let minRest = Infinity;
  for (let i = 0; i < 1500; i++) {
    const stats = w.stepTick();
    worstPostPen = Math.max(worstPostPen, stats.maxPostPenetration);
    for (const b of w.bodies) {
      minRest = Math.min(minRest, w.terrain.distAt(b.c) - b.r);
    }
  }
  // No tunneling: no body ever sank more than a millimeter (field
  // units) past the surface reading during the whole settle, and
  // the deepest post-solve penetration the solver ever left behind
  // is the stack impact's transient (measured 6.7e-4; at rest the
  // per-tick value is at the micrometers scale, checked below).
  assert.ok(minRest >= -1e-3, `deepest sink past rest reading ${minRest}`);
  assert.ok(worstPostPen <= 1e-3, `worst post-solve penetration ${worstPostPen}`);
  const restStats = w.stepTick();
  assert.ok(
    restStats.maxPostPenetration <= 1e-5,
    `resting post-solve penetration ${restStats.maxPostPenetration}`,
  );
  // Rest state, terrain-supported bodies: the field value at the
  // center equals the radius (the v2.0.5 rigid-rest condition, read
  // in field units). Measured residuals: 4e-7 on the singles, 3e-6
  // under the stack. Speeds sit at the stack limit-cycle scale or
  // below (singles exactly 0, stack about 5e-3).
  for (const b of w.bodies.slice(0, 3)) {
    const d = w.terrain.distAt(b.c);
    assert.ok(Math.abs(d - b.r) <= 5e-3, `rest field value ${d} vs r ${b.r}`);
  }
  for (const b of w.bodies) {
    const sp = Math.hypot(b.v[0], b.v[1], b.v[2]);
    assert.ok(sp <= 1e-2, `rest speed ${sp}`);
  }
  // The stack's rest condition is the pair separation: exactly the
  // sum of the radii (measured to 1e-6).
  const sep = Math.hypot(
    w.bodies[3].c[0] - w.bodies[2].c[0],
    w.bodies[3].c[1] - w.bodies[2].c[1],
    w.bodies[3].c[2] - w.bodies[2].c[2],
  );
  assert.ok(Math.abs(sep - 1) <= 5e-3, `stack separation ${sep}`);
  assert.strictEqual(w.settledCount(), w.bodies.length);
  // The heartbeat stands on the same field: grounded, feet in band.
  assert.ok(w.character.grounded, 'character grounded at rest');
  const feet: Vec3 = [
    w.character.pos[0],
    w.character.pos[1] - 0.5,
    w.character.pos[2],
  ];
  const fd = w.terrain.distAt(feet);
  assert.ok(Math.abs(fd - 0.4) <= 1e-3, `character feet field value ${fd}`);
  // Long horizon: 600 more ticks (10 s) move nothing that matters.
  const before = w.bodies.map((b) => [...b.c] as Vec3);
  const charBefore = [...w.character.pos] as Vec3;
  for (let i = 0; i < 600; i++) w.stepTick();
  w.bodies.forEach((b, i) => {
    const drift = Math.hypot(
      b.c[0] - before[i][0], b.c[1] - before[i][1], b.c[2] - before[i][2],
    );
    assert.ok(drift <= 1e-3, `body ${i} drift over 10 s: ${drift}`);
  });
  const charDrift = Math.hypot(
    w.character.pos[0] - charBefore[0],
    w.character.pos[1] - charBefore[1],
    w.character.pos[2] - charBefore[2],
  );
  assert.ok(charDrift <= 1e-3, `character drift over 10 s: ${charDrift}`);
});

test('living: marched view agrees with the analytic terrain', () => {
  const w = settledWorld();
  // Battery: rays from two camera posts at terrain points spread over
  // the map (hill flank, open rolling ground, the plaza rim).
  const targets: Vec3[] = [
    [-5.5, 0, 3.5], [-3.5, 0, 1.5], [-8, 0, 6], [0, 0, -2],
    [8, 0, -8], [11, 0, 2], [-10, 0, -6], [2, 0, 10],
  ];
  const posts: Vec3[] = [
    [5.5, 9, -11], [-11, 8, -9], [12, 10, 12],
  ];
  let checked = 0;
  let worstUnder = 0;
  for (const post of posts) {
    for (const t of targets) {
      const ty = w.terrain.heightAt(t[0], t[2]);
      const dir = toward(post, [t[0], ty, t[2]]);
      const analytic = raycastTerrain(w.terrain, post, dir, 100);
      if (!analytic) continue;
      const view = w.march(post, dir);
      assert.ok(
        view.terrainDepth <= analytic.depth + 1e-9,
        `overshoot: march ${view.terrainDepth} past analytic ${analytic.depth}`,
      );
      worstUnder = Math.max(worstUnder, analytic.depth - view.terrainDepth);
      checked++;
    }
  }
  assert.ok(checked >= 18, `battery size ${checked}`);
  // The interval march stops inside the 1e-3 gap band; along these
  // rays that is worth at most a centimeter of depth undershoot.
  assert.ok(worstUnder <= 0.01, `worst undershoot ${worstUnder}`);
});

test('living: emission glow is occluded by the terrain', () => {
  const w = settledWorld();
  const center = w.emissionCenter();
  // West post: the hill stands between the camera and the ring.
  const west: Vec3 = [-11.5, 3.3, 4.0];
  const westView = w.march(west, toward(west, center));
  assert.ok(
    Number.isFinite(westView.depth) && westView.kind === 'terrain',
    'west ray ends on the hill',
  );
  assert.deepStrictEqual(
    westView.glow, [0, 0, 0],
    'glow behind the hill is exactly zero: no light leaks through ground',
  );
  // South post: open line to the ring.
  const south: Vec3 = [5.5, 3.3, -11];
  const southView = w.march(south, toward(south, center));
  const glowMag = Math.hypot(...southView.glow);
  assert.ok(glowMag > 0.4, `south glow ${glowMag}`);
  // Cross-check against the v2.0.8 layer compositor on the same ray:
  // marchScene over the world's own layers must find the same glow
  // (its terrain depth comes from its own interval march of the same
  // field, so agreement is within the march band, not bit-exact).
  const layers = w.layers();
  const withGlow = marchScene(layers, { origin: south, dir: toward(south, center) }, south, { policy: 'interval' });
  const noGlow = marchScene(
    layers.filter((l: Layer) => l.kind !== 'emission'),
    { origin: south, dir: toward(south, center) }, south, { policy: 'interval' },
  );
  const sceneGlow: Vec3 = [
    withGlow.color[0] - noGlow.color[0],
    withGlow.color[1] - noGlow.color[1],
    withGlow.color[2] - noGlow.color[2],
  ];
  for (let i = 0; i < 3; i++) {
    const diff = Math.abs(sceneGlow[i] - southView.glow[i]);
    assert.ok(
      diff <= 0.1 * Math.max(1, Math.abs(southView.glow[i])),
      `glow channel ${i}: world ${southView.glow[i]} vs layers ${sceneGlow[i]}`,
    );
  }
});

test('living: the watcher detects a moved light and stays quiet otherwise', () => {
  const w = makeLivingWorld({ seed: SEED });
  // No-change battery at the v2.0.4 operating point (Wald form,
  // chi2 99% threshold, nominal 1%): 60 seeded noise draws on the
  // unchanged world must stay within binomial tolerance (<= 5).
  let alarms = 0;
  for (let t = 0; t < 60; t++) {
    if (w.watch(w.observe(10_000 + t)).alarm) alarms++;
  }
  assert.ok(alarms <= 5, `no-change alarms ${alarms}/60`);
  assert.ok(!w.watch(w.observe(777)).alarm, 'canonical no-change trial is quiet');
  // Scripted change: the light moves 0.3 in x and 0.15 in z (a third
  // of the tube's minor radius). The watcher prediction stays at the
  // nominal world, so the move must read as a change.
  const moved = w.moveEmission(0.3, 0.15);
  assert.ok(moved);
  const canonical = w.watch(w.observe(777));
  assert.ok(canonical.alarm, `moved light alarms (T=${canonical.T})`);
  assert.ok(canonical.T > canonical.threshold99);
  let detected = 0;
  for (let t = 0; t < 20; t++) {
    if (w.watch(w.observe(20_000 + t)).alarm) detected++;
  }
  assert.ok(detected >= 19, `change detected ${detected}/20`);
});

test('living: the composed digest is bit-identical across runs', () => {
  const script = (w: LivingWorld): void => {
    for (let i = 0; i < 900; i++) {
      // A scripted walk segment exercises the heartbeat mid-run.
      const input = i >= 300 && i < 360
        ? { move: [1, 0] as [number, number], jumpPressed: i === 330, jumpHeld: i >= 330 && i < 345 }
        : undefined;
      w.stepTick(input);
    }
  };
  const a = makeLivingWorld({ seed: SEED });
  const b = makeLivingWorld({ seed: SEED });
  script(a);
  script(b);
  assert.strictEqual(a.digest(), b.digest());
  assert.deepStrictEqual(
    a.bodies.map((x) => x.c),
    b.bodies.map((x) => x.c),
  );
  assert.deepStrictEqual(a.character.pos, b.character.pos);
  assert.strictEqual(a.tick, 900);
});

test('living control: sign-flipped gravity settles nothing', () => {
  const w = makeLivingWorld({ seed: SEED, gravity: [0, 9.81, 0] });
  const startY = w.bodies.map((b) => b.c[1]);
  for (let i = 0; i < 240; i++) w.stepTick();
  assert.strictEqual(w.settledCount(), 0, 'nothing reads as settled');
  w.bodies.forEach((b, i) => {
    assert.ok(
      b.c[1] > startY[i] + 1,
      `body ${i} rose under flipped gravity: ${startY[i]} -> ${b.c[1]}`,
    );
    assert.ok(Math.abs(b.v[1]) > 1, `body ${i} still accelerating: v=${b.v[1]}`);
  });
});

test('living control: disabling the emission layer removes exactly the glow', () => {
  const lit = settledWorld();
  const dark = makeLivingWorld({ seed: SEED, emission: false });
  for (let i = 0; i < 1500; i++) dark.stepTick();
  const center = lit.emissionCenter();
  const south: Vec3 = [5.5, 3.3, -11];
  const dir = toward(south, center);
  const a = lit.march(south, dir);
  const b = dark.march(south, dir);
  assert.deepStrictEqual(b.glow, [0, 0, 0], 'dark world has no glow');
  assert.ok(Math.hypot(...a.glow) > 0.4, 'lit world glows on the same ray');
  assert.strictEqual(
    a.terrainDepth, b.terrainDepth,
    'terrain view is untouched by the layer toggle',
  );
  assert.notDeepStrictEqual(a.color, b.color, 'the composed colors differ');
  // The bodies and heartbeat do not care about the layer either:
  // same seed, same physics, bit-identical state.
  assert.deepStrictEqual(
    dark.bodies.map((x) => x.c),
    lit.bodies.map((x) => x.c),
  );
});

test('living control: an understated interval bound is caught', () => {
  const w = makeLivingWorld({ seed: SEED });
  const field = terrainIntervalField(w.terrain);
  // The tripwire from v2.0.6: a provider that halves its bound is
  // caught by the sampled violation checker over the world region.
  const liar: IntervalField = {
    f: field.f,
    lipOverBox: (box) => 0.5 * field.lipOverBox(box),
  };
  const region = { min: [-13, 0, -13] as Vec3, max: [13, 6, 13] as Vec3 };
  assert.strictEqual(countIntervalBoundViolations(field, region, 400, 42), 0);
  assert.ok(
    countIntervalBoundViolations(liar, region, 400, 42) > 0,
    'halved bound produces violations',
  );
  // And at the march level: with boundScale 0.5 the guaranteed march
  // loses its guarantee on the hill flank battery (samples land past
  // the analytic hit), where the honest march never does.
  const post: Vec3 = [5.5, 9, -11];
  let honestOvershoots = 0;
  let liarOvershoots = 0;
  const targets: Vec3[] = [[-5.5, 0, 3.5], [-3.5, 0, 1.5], [-8, 0, 6], [-4, 0, 5]];
  for (const t of targets) {
    const ty = w.terrain.heightAt(t[0], t[2]);
    const dir = toward(post, [t[0], ty, t[2]]);
    const analytic = raycastTerrain(w.terrain, post, dir, 100);
    if (!analytic) continue;
    const honest = marchInterval(field, post, dir, { trace: true });
    const lying = marchInterval(field, post, dir, { trace: true, boundScale: 0.5 });
    if (honest.samples && Math.max(...honest.samples) > analytic.depth + 1e-9) honestOvershoots++;
    if (lying.samples && Math.max(...lying.samples) > analytic.depth + 1e-9) liarOvershoots++;
  }
  assert.strictEqual(honestOvershoots, 0, 'honest bound never overshoots');
  assert.ok(liarOvershoots >= 1, `understated bound overshoots (${liarOvershoots})`);
});
