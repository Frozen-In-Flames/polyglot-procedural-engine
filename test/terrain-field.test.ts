// test/terrain-field.test.ts - terrain distance field over grid worlds
// (v2.0.3). The grid's per-cell heights, read as a bilinear heightfield
// (node at each cell center, solid = its height, open = 0), get a true
// conservative distance: gap / sqrt(1 + S^2) with S the proven per-patch
// bilinear slope bound, maximized over the field. Marching it can never
// overshoot the analytic ray-heightfield intersection, which
// raycastTerrain computes exactly (per-patch quadratic). Negative
// controls: a raw-gap march (no slope division) tunnels on a steep
// plane, a sign-flipped field "hits" at t = 0, and the un-divided gap
// itself violates conservativeness next to cliffs, so the sqrt term is
// load-bearing, not decoration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pcg32 } from '../src/math/determinism.js';
import {
  makeGrid,
  gridSet,
  gridDistance,
  generateGrid,
  type GridWorld,
} from '../src/scene/grid.js';
import {
  makeGridTerrain,
  raycastTerrain,
  marchTerrain,
  type GridTerrainField,
} from '../src/scene/terrain-field.js';
import {
  marchScene,
  pinholeRay,
  type GridLayer,
  type Layer,
  type MarchStats,
  type PinholeCam,
  type Solid3D,
} from '../src/scene/layers.js';
import { FrameMarcher } from '../src/render/frame.js';
import { bilinearSlopeBound, heightfieldDist } from '../src/geo/terrain-dist.js';
import type { Vec3 } from '../src/math/vec.js';

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** All cells solid at one height: a flat heightfield. */
function flatWorld(h: number): GridWorld {
  const g = makeGrid(6, 6, { cellSize: 1, origin: [0, 0, 0], height: h });
  for (let i = 0; i < 36; i++) g.cells[i] = 1;
  g.heights = new Float64Array(36).fill(h);
  return g;
}

/** All cells solid, heights sampling the plane h = ax * x + az * z at the
 *  cell centers, so the bilinear surface reproduces the plane exactly. */
function planeWorld(ax: number, az: number, n = 8): GridWorld {
  const g = makeGrid(n, n, { cellSize: 1, origin: [0, 0, 0], height: 2 });
  const heights = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      g.cells[j * n + i] = 1;
      heights[j * n + i] = ax * (i + 0.5) + az * (j + 0.5);
    }
  }
  g.heights = heights;
  return g;
}

/** The v2.0.2 step scene as terrain: nodes [0, 0, 1, 3, 0, 0]. */
function stepWorld(): GridWorld {
  const g = makeGrid(6, 1, { cellSize: 1, origin: [0, 0, 0], height: 2 });
  gridSet(g, 2, 0, true);
  gridSet(g, 3, 0, true);
  const heights = new Float64Array(6);
  heights[2] = 1;
  heights[3] = 3;
  g.heights = heights;
  return g;
}

/** The pinned generated heights world from v2.0.2 (seed 777). */
function roughWorld(): GridWorld {
  return generateGrid(777, 16, 16, {
    density: 0.3,
    border: true,
    height: 2,
    heights: true,
    heightLevels: [0.5, 1, 1.5, 2],
  });
}

function gridLayer(g: GridWorld): GridLayer {
  return { kind: 'grid', grid: g, color: () => [1, 0, 0] };
}

// ---------------------------------------------------------------------------
// 1. Analytic ground truth: flat and constant-slope fields are exact
// ---------------------------------------------------------------------------

test('terrain field: flat heightfield distance is the exact vertical gap', () => {
  for (const g of [flatWorld(3), makeGrid(6, 6, { cellSize: 1, origin: [0, 0, 0], height: 2 })]) {
    const f = makeGridTerrain(g);
    const top = g.cells.some((c) => c === 1) ? 3 : 0;
    assert.strictEqual(f.slopeBound, 0);
    const rng = new Pcg32(5);
    for (let i = 0; i < 200; i++) {
      const p: Vec3 = [rng.unit() * 8 - 1, rng.unit() * 8 - 2, rng.unit() * 8 - 1];
      assert.strictEqual(f.distAt(p), p[1] - top);
      assert.strictEqual(f.heightAt(p[0], p[2]), top);
    }
  }
});

test('terrain field: constant-slope heightfield distance is the closed form', () => {
  for (const [ax, az] of [[1, 0], [0.5, 0.25], [3, 0]] as const) {
    const f = makeGridTerrain(planeWorld(ax, az));
    const s = Math.hypot(ax, az);
    assert.ok(Math.abs(f.slopeBound - s) < 1e-12, `S=${f.slopeBound} exact=${s}`);
    const rng = new Pcg32(6);
    for (let i = 0; i < 200; i++) {
      // Inside the center hull, where the bilinear surface is the plane.
      const p: Vec3 = [0.5 + rng.unit() * 7, rng.unit() * 10 - 2, 0.5 + rng.unit() * 7];
      const gap = p[1] - (ax * p[0] + az * p[2]);
      const exact = gap / Math.sqrt(1 + s * s);
      assert.ok(Math.abs(f.distAt(p) - exact) < 1e-12, `dist=${f.distAt(p)} exact=${exact}`);
      // And it agrees with the established heightfieldDist on the same S.
      const h = (x: number, z: number) => ax * x + az * z;
      assert.ok(Math.abs(f.distAt(p) - heightfieldDist(h, f.slopeBound, p)) < 1e-12);
    }
  }
});

test('terrain field: the patch bound refines the global bilinear bound', () => {
  // bilinearSlopeBound over the same nodes gives sqrt(2) * m; the patch
  // bound sqrt(mx^2 + mz^2) is never larger, and strictly smaller when
  // the slope is not diagonal.
  const g = planeWorld(0.5, 0.25);
  const f = makeGridTerrain(g);
  const nodes: number[][] = [];
  for (let j = 0; j < g.depth; j++) {
    const row: number[] = [];
    for (let i = 0; i < g.width; i++) row.push(f.nodeHeightAt(i, j));
    nodes.push(row);
  }
  const global = bilinearSlopeBound(nodes, 1);
  assert.ok(f.slopeBound <= global + 1e-12, `S=${f.slopeBound} global=${global}`);
  assert.ok(f.slopeBound < global, 'expected a strict refinement off the diagonal');
});

test('terrain field: patch bounds truly bound the gradient in every patch', () => {
  for (const g of [roughWorld(), planeWorld(0.5, 0.25), stepWorld()]) {
    const f = makeGridTerrain(g);
    // At every sampled point, the gradient magnitude is bounded by the
    // patch bound at that point, and the patch bound never exceeds the
    // global S. The bilinear gradient attains its patch maximum at a
    // corner; the dense random sampling below includes near-corner
    // points, and the corners themselves are the patch nodes, where
    // gradientAt reads the patch on either side, both bounded.
    let globalMax = 0;
    const rng = new Pcg32(23);
    for (let i = 0; i < 4000; i++) {
      const x = rng.unit() * g.width;
      const z = rng.unit() * g.depth;
      const [gx, gz] = f.gradientAt(x, z);
      const mag = Math.hypot(gx, gz);
      const b = f.patchSlopeBoundAt(x, z);
      assert.ok(mag <= b + 1e-12, `|grad|=${mag} > patch bound ${b} at (${x}, ${z})`);
      assert.ok(b <= f.slopeBound + 1e-12);
      if (b > globalMax) globalMax = b;
    }
    assert.ok(Math.abs(globalMax - f.slopeBound) < 1e-9, 'global S is the max patch bound');
  }
});

test('terrain field: gradient is the clamped gradient in the extension strips', () => {
  // Beyond the outermost centers the surface is constant along the
  // clamped axis: the gradient component there is exactly 0 (an early
  // version returned the interior patch's edge gradient instead, which
  // exceeded the strip's own patch bound; this pin keeps that out).
  const f = makeGridTerrain(roughWorld());
  for (const z of [0.3, 4.2, 8.8, 15.1]) {
    for (const x of [-1, 0.2, 15.9, 20]) {
      const [gx, gz] = f.gradientAt(x, z);
      assert.strictEqual(gx, 0, `gx at (${x}, ${z})`);
      assert.ok(Math.hypot(gx, gz) <= f.patchSlopeBoundAt(x, z) + 1e-12);
    }
    for (const x of [0.3, 7.7, 15.2]) {
      const [, gz] = f.gradientAt(x, 15.9);
      assert.strictEqual(gz, 0);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Conservativeness against dense sampling, with the bound-drop control
// ---------------------------------------------------------------------------

test('terrain field: distance never exceeds the true distance (dense sampling)', () => {
  const g = roughWorld();
  const f = makeGridTerrain(g);
  // Dense surface samples over the footprint.
  const surf: Vec3[] = [];
  const m = 161;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      const x = (16 * i) / (m - 1);
      const z = (16 * j) / (m - 1);
      surf.push([x, f.heightAt(x, z), z]);
    }
  }
  const sampledDist = (p: Vec3): number => {
    let dmin = Infinity;
    for (const q of surf) {
      const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (d < dmin) dmin = d;
    }
    return dmin;
  };
  const rng = new Pcg32(29);
  let gapViolations = 0;
  for (let i = 0; i < 200; i++) {
    const x = rng.unit() * 16;
    const z = rng.unit() * 16;
    const h = f.heightAt(x, z);
    const above = i % 2 === 0;
    const p: Vec3 = [x, above ? h + 0.05 + rng.unit() * 5 : h - 0.05 - rng.unit() * 2, z];
    const dTrue = sampledDist(p);
    // The field's distance is conservative: never above the true
    // distance (sampled distance only overestimates it, hence the
    // sampling slack), on both sides of the surface.
    assert.ok(
      Math.abs(f.distAt(p)) <= dTrue + 0.03,
      `|dist|=${Math.abs(f.distAt(p))} > sampled true ${dTrue} at ${p}`,
    );
    // Control: the raw vertical gap, with no slope division, is NOT a
    // distance bound next to the cliffs. If this count ever reads 0 the
    // control scene stopped exercising the failure.
    const gap = Math.abs(p[1] - h);
    if (gap > dTrue + 0.05) gapViolations++;
  }
  assert.ok(gapViolations > 0, 'raw gap must violate somewhere: the sqrt term is load-bearing');
});

// ---------------------------------------------------------------------------
// 3. Analytic raycast: closed forms and an independent brute force
// ---------------------------------------------------------------------------

test('terrain raycast: closed-form hits on flat, plane, and step scenes', () => {
  // Vertical ray onto a flat field: depth is the vertical gap exactly.
  {
    const f = makeGridTerrain(flatWorld(3));
    const hit = raycastTerrain(f, [2.2, 9, 3.7], [0, -1, 0], 100);
    assert.ok(hit);
    assert.strictEqual(hit.depth, 6);
  }
  // Descending ray onto a plane: root of the gap line, exact.
  {
    const f = makeGridTerrain(planeWorld(1, 0));
    const o: Vec3 = [1, 6, 4];
    const d = norm([0, -1, 0]);
    const hit = raycastTerrain(f, o, d, 100);
    assert.ok(hit);
    assert.ok(Math.abs(hit.depth - (6 - 1)) < 1e-12); // surface at x=1 is y=1
  }
  // Horizontal ray over the step world: the terrain surface crosses
  // y = 2 where the bilinear ramp between the h=1 and h=3 centers
  // passes 2, at x = 3 exactly, so the depth from x = 0 is 3. (The
  // integration test below uses y = 2.5, where the smooth surface and
  // the stepped box face genuinely part ways.)
  {
    const f = makeGridTerrain(stepWorld());
    assert.strictEqual(f.slopeBound, 3);
    const hit = raycastTerrain(f, [0, 2, 0.5], [1, 0, 0], 100);
    assert.ok(hit);
    assert.ok(Math.abs(hit.depth - 3) < 1e-9, `depth=${hit.depth}`);
    // Vertical ray over the tall cell lands on its center height.
    const down = raycastTerrain(f, [3.5, 6, 0.5], [0, -1, 0], 100);
    assert.ok(down);
    assert.strictEqual(down.depth, 3);
  }
});

test('terrain raycast: agrees with a brute-force gap scan on the rough world', () => {
  const f = makeGridTerrain(roughWorld());
  const brute = (o: Vec3, d: Vec3): number => {
    const gap = (t: number) =>
      o[1] + d[1] * t - f.heightAt(o[0] + d[0] * t, o[2] + d[2] * t);
    if (gap(0) <= 0) return NaN;
    for (let t = 1e-3; t < 100; t += 1e-3) {
      if (gap(t) <= 0) {
        let lo = t - 1e-3;
        let hi = t;
        for (let i = 0; i < 60; i++) {
          const mid = (lo + hi) / 2;
          if (gap(mid) <= 0) hi = mid; else lo = mid;
        }
        return (lo + hi) / 2;
      }
    }
    return Infinity;
  };
  const rng = new Pcg32(11);
  let checked = 0;
  for (let i = 0; i < 40; i++) {
    const o: Vec3 = [1 + rng.unit() * 14, 6 + rng.unit() * 4, 1 + rng.unit() * 14];
    const d = norm([rng.unit() - 0.5, -(0.4 + rng.unit() * 0.6), rng.unit() - 0.5]);
    const a = raycastTerrain(f, o, d, 100);
    const b = brute(o, d);
    if (a === null) {
      assert.ok(!isFinite(b), `analytic miss but brute hit at ${b}`);
      continue;
    }
    assert.ok(isFinite(b), 'analytic hit but brute miss');
    checked++;
    assert.ok(Math.abs(a.depth - b) < 1e-9, `analytic=${a.depth} brute=${b}`);
  }
  assert.strictEqual(checked, 40);
});

// ---------------------------------------------------------------------------
// 4. Marching: never overshoots, lands in the eps band, measured steps
// ---------------------------------------------------------------------------

test('terrain march: never overshoots the analytic hit on the rough world', () => {
  const f = makeGridTerrain(roughWorld());
  const rng = new Pcg32(13);
  let rays = 0;
  let totalSteps = 0;
  let maxSteps = 0;
  let worstUnder = 0;
  for (let i = 0; i < 60; i++) {
    const o: Vec3 = [1 + rng.unit() * 14, 6 + rng.unit() * 4, 1 + rng.unit() * 14];
    const d = norm([rng.unit() - 0.5, -(0.5 + rng.unit() * 0.5), rng.unit() - 0.5]);
    const a = raycastTerrain(f, o, d, 100);
    assert.ok(a, 'battery rays all hit analytically');
    const m = marchTerrain(f, o, d, { steps: 4096 });
    assert.ok(isFinite(m.depth), 'march must hit within the generous budget');
    rays++;
    totalSteps += m.steps;
    maxSteps = Math.max(maxSteps, m.steps);
    // The safety property: the march stops at or before the true hit.
    assert.ok(m.depth <= a.depth + 1e-9, `overshoot: march=${m.depth} analytic=${a.depth}`);
    worstUnder = Math.max(worstUnder, a.depth - m.depth);
    // The hit contract: the stop point is inside the eps band.
    assert.ok(m.point && f.distAt(m.point) < 1e-3);
  }
  assert.strictEqual(rays, 60);
  // Measured on this battery (avg 48.8, max 586, worst undershoot
  // 0.0133): the max is one grazing ray against a steep face, the known
  // cost of a global slope bound, pinned here so it cannot regress
  // silently.
  assert.ok(worstUnder <= 0.02, `worst undershoot ${worstUnder}`);
  assert.ok(totalSteps / rays <= 60, `avg steps ${totalSteps / rays}`);
  assert.ok(maxSteps <= 600, `max steps ${maxSteps}`);
});

test('terrain march: measured step counts vs sphere and fixed on the same fan', () => {
  const g = roughWorld();
  const layersTerrain: Layer[] = [gridLayer(g)];
  const layersBox: Layer[] = [{
    kind: '3d',
    sdf: (p: Vec3) => gridDistance(g, p),
    shade: () => [0, 1, 0],
  } satisfies Solid3D];
  const rng = new Pcg32(17);
  let tSteps = 0, sSteps = 0, fSteps = 0;
  let tHits = 0, sHits = 0, fHits = 0;
  for (let i = 0; i < 41; i++) {
    const o: Vec3 = [2 + rng.unit() * 12, 7, 2 + rng.unit() * 12];
    const d = norm([rng.unit() - 0.5, -0.75, rng.unit() - 0.5]);
    const ray = { origin: o, dir: d };
    const st: MarchStats = { steps: 0, evals: 0 };
    const ss: MarchStats = { steps: 0, evals: 0 };
    const sf: MarchStats = { steps: 0, evals: 0 };
    const ht = marchScene(layersTerrain, ray, o, { policy: 'terrain', steps: 100000, stats: st });
    const hs = marchScene(layersBox, ray, o, { policy: 'sphere', steps: 100000, stats: ss });
    const hf = marchScene(layersBox, ray, o, {
      policy: 'fixed', fixedStep: 0.1, steps: 100000, stats: sf,
    });
    tSteps += st.steps; sSteps += ss.steps; fSteps += sf.steps;
    if (isFinite(ht.depth)) tHits++;
    if (isFinite(hs.depth)) sHits++;
    if (isFinite(hf.depth)) fHits++;
  }
  // Measured on this fan: terrain 1453 steps / 41 hits, sphere over the
  // exact box distance 674 / 23, fixed at 0.1 19163 / 23 (its total is
  // dominated by miss rays marching to maxDist). The terrain field has a
  // floor everywhere, so it hits rays the box world lets escape; on the
  // 23 rays all three hit, the totals are terrain 789, sphere 312,
  // fixed 1145. Assertions carry margin around the measured values.
  assert.strictEqual(tHits, 41);
  assert.strictEqual(sHits, 23);
  assert.strictEqual(fHits, 23);
  assert.ok(tSteps > 1200 && tSteps < 1700, `terrain steps ${tSteps}`);
  assert.ok(sSteps > 500 && sSteps < 850, `sphere steps ${sSteps}`);
  assert.ok(fSteps > 15000, `fixed steps ${fSteps}`);
  assert.ok(tSteps * 8 < fSteps, 'terrain must beat fixed by a wide margin');
  assert.ok(tSteps <= sSteps * 3, 'terrain stays in the sphere step-count class');
});

// ---------------------------------------------------------------------------
// 5. Negative controls: sabotaged variants must fail
// ---------------------------------------------------------------------------

test('terrain march: negative controls (raw gap tunnels, sign flip false-hits)', () => {
  const f = makeGridTerrain(planeWorld(3, 0, 12));
  const o: Vec3 = [1, 8, 6];
  const d = norm([Math.SQRT1_2, -Math.SQRT1_2, 0]);
  const a = raycastTerrain(f, o, d, 100);
  assert.ok(a);
  assert.ok(Math.abs(a.depth - 1.7677669529663693) < 1e-9, `analytic=${a.depth}`);
  // The true march approaches from above and stops in the eps band.
  const m = marchTerrain(f, o, d, { steps: 512 });
  assert.ok(m.depth <= a.depth + 1e-9 && m.depth >= a.depth - 0.01, `march=${m.depth}`);

  // Sabotage 1: step by the raw vertical gap, no slope division. On a
  // slope-3 plane a 45-degree ray's first step is the full gap (5),
  // which lands it deep inside the surface: a false hit at t = 5, past
  // the true surface at 1.77. Tunneling, demonstrated.
  const rawGapMarch = (): number => {
    let t = 0;
    for (let i = 0; i < 10000; i++) {
      const p: Vec3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
      const gap = p[1] - f.heightAt(p[0], p[2]);
      if (gap < 1e-3) return t;
      t += gap;
      if (t > 100) return Infinity;
    }
    return Infinity;
  };
  const raw = rawGapMarch();
  assert.ok(raw > a.depth + 1, `raw-gap march must overshoot: got ${raw}, analytic ${a.depth}`);

  // Sabotage 2: sign-flipped distance. Every sample reads as inside the
  // surface, so the march "hits" at t = 0, nowhere near the true hit.
  const flipped: GridTerrainField = { ...f, distAt: (p: Vec3) => -f.distAt(p) };
  const fm = marchTerrain(flipped, o, d, { steps: 512 });
  assert.strictEqual(fm.depth, 0);
  assert.ok(a.depth > 1.5, 'the flipped hit at 0 is a false hit');
});

// ---------------------------------------------------------------------------
// 6. Integration: policy dispatch, back-compat, composition, frame dial
// ---------------------------------------------------------------------------

test('terrain integration: grid layers are exact DDA under sphere and fixed, terrain under terrain', () => {
  const layers: Layer[] = [gridLayer(stepWorld())];
  // Ray at y = 2.5 from x = 0.5: the DDA hits the tall box face (x = 3)
  // at depth 2.5; the terrain surface crosses y = 2.5 where the bilinear
  // ramp between the h = 1 and h = 3 centers reaches 2.5, at x = 3.25,
  // depth 2.75. The two surfaces genuinely differ on this ray, so the
  // pins prove the dispatch reads the policy.
  const ray = { origin: [0.5, 2.5, 0.5] as Vec3, dir: [1, 0, 0] as Vec3 };
  for (const opts of [{}, { policy: 'sphere' as const }, { policy: 'fixed' as const }]) {
    const hit = marchScene(layers, ray, ray.origin, opts);
    assert.strictEqual(hit.depth, 2.5);
    assert.strictEqual(hit.kind, 'grid');
  }
  const analytic = raycastTerrain(makeGridTerrain(stepWorld()), ray.origin, ray.dir, 100);
  assert.ok(analytic && Math.abs(analytic.depth - 2.75) < 1e-9, `analytic=${analytic?.depth}`);
  const hit = marchScene(layers, ray, ray.origin, { policy: 'terrain', steps: 512 });
  assert.strictEqual(hit.kind, 'grid');
  assert.ok(hit.depth <= 2.75 + 1e-9 && hit.depth >= 2.75 - 0.02, `terrain depth=${hit.depth}`);
  // Stats flow through the march: steps counted, evals at least steps.
  const stats: MarchStats = { steps: 0, evals: 0 };
  marchScene(layers, ray, ray.origin, { policy: 'terrain', steps: 512, stats });
  const direct = marchTerrain(makeGridTerrain(stepWorld()), ray.origin, ray.dir, { steps: 512 });
  assert.strictEqual(stats.steps, direct.steps);
  assert.ok(stats.evals >= stats.steps);
});

test('terrain integration: SDF layers still sphere-trace and occlude under terrain policy', () => {
  const sphere: Solid3D = {
    kind: '3d',
    sdf: (p: Vec3) => Math.hypot(p[0] - 1.5, p[1] - 2, p[2] - 0.5) - 0.5,
    shade: () => [0, 1, 0],
  };
  const layers: Layer[] = [gridLayer(stepWorld()), sphere];
  const ray = { origin: [0, 2, 0.5] as Vec3, dir: [1, 0, 0] as Vec3 };
  // The sphere surface sits at depth 1.0, in front of the terrain hit
  // at 3.0: under terrain policy the composite still returns the sphere.
  const hit = marchScene(layers, ray, ray.origin, { policy: 'terrain', steps: 512 });
  assert.strictEqual(hit.kind, '3d');
  assert.ok(Math.abs(hit.depth - 1) < 0.01, `depth=${hit.depth}`);
});

test('terrain integration: frame marcher policy dial drives the terrain path', () => {
  const layers: Layer[] = [gridLayer(roughWorld())];
  const cam: PinholeCam = { pos: [8, 7, -4], target: [8, 0, 8], fovY: Math.PI / 3, aspect: 1 };
  const m = new FrameMarcher({ columns: 12 });
  m.params.policy = 'terrain';
  const frame = m.render(cam, layers);
  assert.strictEqual(frame.columns.length, 12);
  assert.ok(frame.telemetry.totalSteps > 0);
  let hits = 0;
  for (let i = 0; i < frame.columns.length; i++) {
    const nx = -1 + (2 * i + 1) / frame.columns.length;
    const direct = marchScene(layers, pinholeRay(cam, nx, 0), cam.pos, {
      policy: 'terrain',
      steps: m.params.steps,
      maxDist: m.params.maxDist,
      eps: m.params.eps,
    });
    assert.strictEqual(frame.columns[i].depth, direct.depth);
    if (isFinite(frame.columns[i].depth)) hits++;
  }
  assert.ok(hits > 0, 'the terrain frame must hit somewhere');
});

test('terrain field: deterministic across rebuilds', () => {
  const g = roughWorld();
  const f1 = makeGridTerrain(g);
  const f2 = makeGridTerrain(g);
  assert.strictEqual(f1.slopeBound, f2.slopeBound);
  const rng = new Pcg32(31);
  for (let i = 0; i < 200; i++) {
    const p: Vec3 = [rng.unit() * 16, rng.unit() * 10 - 2, rng.unit() * 16];
    assert.strictEqual(f1.distAt(p), f2.distAt(p));
    assert.strictEqual(f1.heightAt(p[0], p[2]), f2.heightAt(p[0], p[2]));
  }
  const o: Vec3 = [3, 8, 3];
  const d = norm([0.3, -1, 0.2]);
  assert.deepStrictEqual(marchTerrain(f1, o, d), marchTerrain(f2, o, d));
});
