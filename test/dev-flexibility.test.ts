import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  marchScene,
  pinholeRay,
  type Layer,
  type GridLayer,
  type Solid3D,
  type PinholeCam,
  type Ray,
} from '../src/scene/layers.js';
import {
  makeGrid,
  gridSet,
  raycastGrid,
  generateGrid,
  GridLevel,
  type GridWorld,
} from '../src/scene/grid.js';
import { FrameMarcher, DEFAULT_FRAME_PARAMS } from '../src/render/frame.js';
import {
  clamp,
  clamp01,
  lerp,
  remap,
  smoothstep,
  pingpong,
  invFalloff,
  pulse,
  hash01,
  cellIndex,
  inBounds,
} from '../src/dev/math.js';
import type { Vec3 } from '../src/math/vec.js';

// Dev flexibility (v2.0.0): grid worlds, march policy, runtime dials, march
// telemetry, seed-regenerable levels, hookable render stages, write-once dev
// math. Tests are the spec; the implementation must satisfy them.

const CAM: PinholeCam = { pos: [0, 0, 0], target: [0, 0, 1], fovY: Math.PI / 3, aspect: 1 };

function sphereLayer(center: Vec3, r: number, color: Vec3): Solid3D {
  return {
    kind: '3d',
    sdf: (p: Vec3) => Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) - r,
    shade: () => color,
  };
}

/** Grid with the full z=5 row walled, 10x10 cells of size 1, walls 2 high. */
function wallGrid(): GridWorld {
  const g = makeGrid(10, 10, { cellSize: 1, origin: [0, 0, 0], height: 2 });
  for (let x = 0; x < 10; x++) gridSet(g, x, 5, true);
  return g;
}

function gridLayer(g: GridWorld, color: Vec3): GridLayer {
  return { kind: 'grid', grid: g, color: () => color };
}

// ---------------------------------------------------------------------------
// 1. Grid worlds
// ---------------------------------------------------------------------------

test('grid: axis ray hits the known wall face at the exact distance', () => {
  const g = wallGrid();
  const hit = raycastGrid(g, [4.5, 1, 0], [0, 0, 1], 100);
  assert.ok(hit);
  assert.strictEqual(hit.depth, 5);
  assert.strictEqual(hit.cellX, 4);
  assert.strictEqual(hit.cellZ, 5);
  assert.strictEqual(hit.side, 'z');
  assert.deepStrictEqual(hit.point, [4.5, 1, 5]);
});

test('grid: diagonal ray enters the diagonal cell at the exact DDA distance', () => {
  const g = makeGrid(6, 6, { cellSize: 1, origin: [0, 0, 0], height: 2 });
  gridSet(g, 2, 2, true);
  const s = Math.SQRT1_2;
  const hit = raycastGrid(g, [0.5, 1, 0.5], [s, 0, s], 100);
  assert.ok(hit);
  assert.strictEqual(hit.cellX, 2);
  assert.strictEqual(hit.cellZ, 2);
  assert.ok(Math.abs(hit.depth - 1.5 * Math.SQRT2) < 1e-12, `depth ${hit.depth}`);
});

test('grid: ray above the wall band and ray past maxDist both miss', () => {
  const g = wallGrid();
  assert.strictEqual(raycastGrid(g, [4.5, 3, 0], [0, 0, 1], 100), null);
  assert.strictEqual(raycastGrid(g, [4.5, 1, 0], [0, 0, 1], 3), null);
});

test('grid + SDF composite: the nearer surface wins in one FOV', () => {
  const layers: Layer[] = [
    gridLayer(wallGrid(), [1, 0, 0]),
    sphereLayer([4.5, 1, 3], 1, [0, 1, 0]),
  ];
  // Sphere (front face at depth 2) in front of the grid wall (depth 5).
  const near = marchScene(layers, { origin: [4.5, 1, 0], dir: [0, 0, 1] }, [4.5, 1, 0]);
  assert.strictEqual(near.kind, '3d');
  assert.strictEqual(near.depth, 2);
  // Sphere behind the wall: the grid wins.
  const layers2: Layer[] = [
    gridLayer(wallGrid(), [1, 0, 0]),
    sphereLayer([4.5, 1, 9], 1, [0, 1, 0]),
  ];
  const behind = marchScene(layers2, { origin: [4.5, 1, 0], dir: [0, 0, 1] }, [4.5, 1, 0]);
  assert.strictEqual(behind.kind, 'grid');
  assert.strictEqual(behind.depth, 5);
  // A ray with no sphere in the way hits the grid wall.
  const plain = marchScene(layers, { origin: [0.5, 1, 0], dir: [0, 0, 1] }, [0.5, 1, 0]);
  assert.strictEqual(plain.kind, 'grid');
  assert.strictEqual(plain.depth, 5);
});

// ---------------------------------------------------------------------------
// 2. March policy: sphere (default) vs fixed-step, error measured and pinned
// ---------------------------------------------------------------------------

test('policy: default is sphere tracing and matches policy sphere bit-identically', () => {
  const layers: Layer[] = [sphereLayer([0, 0, 5], 1, [0.5, 0.5, 0.5])];
  const ray: Ray = { origin: [0, 0, 0], dir: [0, 0, 1] };
  const a = marchScene(layers, ray, CAM.pos);
  const b = marchScene(layers, ray, CAM.pos, { policy: 'sphere' });
  assert.strictEqual(a.depth, b.depth);
  assert.deepStrictEqual(a.color, b.color);
});

test('policy: fixed-step error on the axis ray is exactly one partial step', () => {
  const layers: Layer[] = [sphereLayer([0, 0, 5], 1, [0.5, 0.5, 0.5])];
  const ray: Ray = { origin: [0, 0, 0], dir: [0, 0, 1] };
  // True hit at t = 4. Fixed step 0.3 samples 0, 0.3, ..., 3.9 (outside),
  // then 4.2 (inside): reported depth 4.2, error exactly 0.2.
  const fixed = marchScene(layers, ray, CAM.pos, { policy: 'fixed', fixedStep: 0.3, steps: 2000 });
  assert.ok(Math.abs(fixed.depth - 4.2) < 1e-9, `fixed depth ${fixed.depth}`);
  const sphere = marchScene(layers, ray, CAM.pos, { policy: 'sphere' });
  assert.ok(Math.abs(sphere.depth - 4) < 1e-12, `sphere depth ${sphere.depth}`);
});

test('policy: fixed-step error over a ray fan stays inside the published budget', () => {
  const layers: Layer[] = [sphereLayer([0, 0, 5], 1, [0.5, 0.5, 0.5])];
  const step = 0.1;
  let maxFixedErr = 0;
  let maxSphereErr = 0;
  for (let i = 0; i <= 15; i++) {
    const th = -0.19 + (0.38 * i) / 15;
    const dir: Vec3 = [Math.sin(th), 0, Math.cos(th)];
    const ray: Ray = { origin: [0, 0, 0], dir };
    // Analytic ray-sphere: |o + t d - c|^2 = r^2, c = (0,0,5), r = 1.
    const b = -5 * Math.cos(th);
    const disc = b * b - 24;
    assert.ok(disc > 0);
    const tTrue = -b - Math.sqrt(disc);
    const f = marchScene(layers, ray, CAM.pos, { policy: 'fixed', fixedStep: step, steps: 2000 });
    const s = marchScene(layers, ray, CAM.pos, { policy: 'sphere' });
    maxFixedErr = Math.max(maxFixedErr, Math.abs(f.depth - tTrue));
    maxSphereErr = Math.max(maxSphereErr, Math.abs(s.depth - tTrue));
  }
  // Published budget: fixed-step distance error never exceeds one step, and
  // the measurement is real (not vacuously zero). Sphere tracing stays
  // within 0.01 of the analytic surface on this fan.
  assert.ok(maxFixedErr <= step + 1e-9, `max fixed err ${maxFixedErr}`);
  assert.ok(maxFixedErr >= 0.03, `max fixed err ${maxFixedErr} suspiciously small`);
  assert.ok(maxSphereErr <= 0.01, `max sphere err ${maxSphereErr}`);
});

// ---------------------------------------------------------------------------
// 3. Resolution as runtime dials
// ---------------------------------------------------------------------------

test('dials: default params reproduce direct marchScene results bit-identically', () => {
  const layers: Layer[] = [
    gridLayer(wallGrid(), [1, 0, 0]),
    sphereLayer([0, 0, 5], 1, [0, 1, 0]),
  ];
  const cam: PinholeCam = { pos: [4.5, 1, 0], target: [4.5, 1, 1], fovY: Math.PI / 3, aspect: 1 };
  const m = new FrameMarcher();
  const frame = m.render(cam, layers);
  assert.strictEqual(frame.columns.length, DEFAULT_FRAME_PARAMS.columns);
  for (let i = 0; i < frame.columns.length; i++) {
    const nx = -1 + (2 * i + 1) / frame.columns.length;
    const direct = marchScene(layers, pinholeRay(cam, nx, 0), cam.pos);
    assert.strictEqual(frame.columns[i].depth, direct.depth);
    assert.deepStrictEqual(frame.columns[i].color, direct.color);
    assert.strictEqual(frame.columns[i].kind, direct.kind);
  }
});

test('dials: changing columns and steps changes counts exactly as specified', () => {
  const m = new FrameMarcher({ columns: 7 });
  const flat: Layer[] = [{ kind: '3d', sdf: () => 1, shade: () => [0, 0, 0] }];
  const cam: PinholeCam = { pos: [0, 0, 0], target: [0, 0, 1], fovY: Math.PI / 3, aspect: 1 };
  let frame = m.render(cam, flat);
  assert.strictEqual(frame.columns.length, 7);
  // Constant field f = 1: sphere tracing takes one unit step per iteration
  // and never hits, so per-ray steps equal the step budget exactly.
  m.params.steps = 10;
  frame = m.render(cam, flat);
  assert.strictEqual(frame.telemetry.rays[3].steps, 10);
  m.params.steps = 25;
  frame = m.render(cam, flat);
  assert.strictEqual(frame.telemetry.rays[3].steps, 25);
  // Columns dial is live too: no rebuild, just mutate and render.
  m.params.columns = 3;
  frame = m.render(cam, flat);
  assert.strictEqual(frame.columns.length, 3);
});

test('dials: FOV dial moves off-center hit depth to the formula value', () => {
  // Camera inside the grid looking at the walled row, face at z = 5.
  const layers: Layer[] = [gridLayer(wallGrid(), [1, 0, 0])];
  const cam: PinholeCam = { pos: [4.5, 1, 0], target: [4.5, 1, 1], fovY: Math.PI / 3, aspect: 1 };
  const m = new FrameMarcher({ columns: 3 });
  let frame = m.render(cam, layers);
  // nx = 2/3 column: depth = 5 * sqrt(1 + (nx * tan(fovY/2))^2).
  const expect = (fovY: number) => 5 * Math.sqrt(1 + ((2 / 3) * Math.tan(fovY / 2)) ** 2);
  assert.ok(Math.abs(frame.columns[2].depth - expect(Math.PI / 3)) < 1e-9);
  assert.strictEqual(frame.columns[1].depth, 5); // center column ignores FOV
  m.params.fovY = Math.PI / 2;
  frame = m.render(cam, layers);
  assert.ok(Math.abs(frame.columns[2].depth - expect(Math.PI / 2)) < 1e-9);
  assert.strictEqual(frame.columns[1].depth, 5);
});

// ---------------------------------------------------------------------------
// 4. March telemetry
// ---------------------------------------------------------------------------

test('telemetry: ground truth on the reference sphere (steps, distance, cost)', () => {
  const layers: Layer[] = [sphereLayer([0, 0, 5], 1, [0.5, 0.5, 0.5])];
  const m = new FrameMarcher({ columns: 1 });
  const frame = m.render(CAM, layers);
  const t = frame.telemetry.rays[0];
  // Sphere trace: t=0 eval f=4 (no hit), t=4 eval f=0 (hit): 2 steps,
  // distance exactly 4. Cost = field evals = 2 trace + 6 normal = 8.
  assert.strictEqual(t.steps, 2);
  assert.strictEqual(t.distance, 4);
  assert.strictEqual(t.hit, true);
  assert.strictEqual(t.cost, 8);
});

test('telemetry: frame aggregate is exactly the sum of per-ray values', () => {
  const layers: Layer[] = [sphereLayer([0, 0, 5], 1, [0.5, 0.5, 0.5])];
  const m = new FrameMarcher({ columns: 5 });
  const frame = m.render(CAM, layers);
  const T = frame.telemetry;
  assert.strictEqual(T.rays.length, 5);
  assert.strictEqual(T.totalSteps, T.rays.reduce((s, r) => s + r.steps, 0));
  assert.strictEqual(T.totalCost, T.rays.reduce((s, r) => s + r.cost, 0));
  assert.strictEqual(T.hits, T.rays.filter((r) => r.hit).length);
  const hitDists = T.rays.filter((r) => r.hit).map((r) => r.distance);
  const mean = hitDists.reduce((s, d) => s + d, 0) / hitDists.length;
  assert.strictEqual(T.meanHitDistance, mean);
  // Center ray is the ground-truth ray even in a multi-column frame.
  assert.strictEqual(T.rays[2].distance, 4);
  assert.strictEqual(T.rays[2].steps, 2);
});

// ---------------------------------------------------------------------------
// 5. Seed-regenerable levels
// ---------------------------------------------------------------------------

test('seeds: same seed generates a bit-identical world, different seeds differ', () => {
  const a = generateGrid(1234, 24, 24, { density: 0.25, border: true });
  const b = generateGrid(1234, 24, 24, { density: 0.25, border: true });
  assert.deepStrictEqual([...a.cells], [...b.cells]);
  const c = generateGrid(4321, 24, 24, { density: 0.25, border: true });
  assert.notDeepStrictEqual([...a.cells], [...c.cells]);
  // Border is always walled when border: true.
  for (let x = 0; x < 24; x++) {
    assert.strictEqual(a.cells[x], 1);
    assert.strictEqual(a.cells[23 * 24 + x], 1);
  }
});

test('seeds: regeneration replaces the world completely', () => {
  const level = new GridLevel(7, 16, 16, { density: 0.3, border: true });
  const before = level.grid;
  level.regenerate(99);
  assert.notStrictEqual(level.grid, before);
  assert.deepStrictEqual([...level.grid.cells], [...generateGrid(99, 16, 16, { density: 0.3, border: true }).cells]);
  assert.strictEqual(level.seed, 99);
  // Regenerating back reproduces the original world exactly.
  level.regenerate(7);
  assert.deepStrictEqual([...level.grid.cells], [...before.cells]);
});

// ---------------------------------------------------------------------------
// 6. Hookable render stages
// ---------------------------------------------------------------------------

test('hooks: a custom shading hook transforms column output exactly', () => {
  const layers: Layer[] = [gridLayer(wallGrid(), [0.25, 0.5, 0.75])];
  const cam: PinholeCam = { pos: [4.5, 1, 0], target: [4.5, 1, 1], fovY: Math.PI / 3, aspect: 1 };
  const m = new FrameMarcher({ columns: 1 });
  const frame = m.render(cam, layers, {
    shadeColumn: (ctx) => [ctx.hit.color[0] * 2, ctx.hit.color[1] * 2, ctx.hit.color[2] * 2],
  });
  assert.deepStrictEqual(frame.columns[0].color, [0.5, 1.0, 1.5]);
});

test('hooks: a custom hit hook overrides hits, and declining keeps the default', () => {
  const empty: Layer[] = [];
  const m = new FrameMarcher({ columns: 1 });
  const forced = m.render(CAM, empty, {
    hitTest: () => ({ depth: 3, color: [1, 0, 0] as Vec3, kind: '3d' as const, layer: 99 }),
  });
  assert.strictEqual(forced.columns[0].depth, 3);
  assert.deepStrictEqual(forced.columns[0].color, [1, 0, 0]);
  const declined = m.render(CAM, empty, { hitTest: () => undefined });
  assert.strictEqual(declined.columns[0].depth, Infinity);
});

test('hooks: no hooks means output identical to plain rendering', () => {
  const layers: Layer[] = [
    gridLayer(wallGrid(), [1, 0, 0]),
    sphereLayer([0, 0, 5], 1, [0, 1, 0]),
  ];
  const m = new FrameMarcher({ columns: 9 });
  const plain = m.render(CAM, layers);
  const hooked = m.render(CAM, layers, {});
  assert.deepStrictEqual(
    hooked.columns.map((c) => ({ depth: c.depth, color: c.color, kind: c.kind })),
    plain.columns.map((c) => ({ depth: c.depth, color: c.color, kind: c.kind })),
  );
});

// ---------------------------------------------------------------------------
// 7. Write-once dev math blocks
// ---------------------------------------------------------------------------

test('dev math: reference values', () => {
  assert.strictEqual(clamp(5, 0, 3), 3);
  assert.strictEqual(clamp01(-0.5), 0);
  assert.strictEqual(clamp01(2), 1);
  assert.strictEqual(clamp01(0.25), 0.25);
  assert.strictEqual(lerp(2, 6, 0.25), 3);
  assert.strictEqual(remap(5, 0, 10, 0, 100), 50);
  assert.strictEqual(smoothstep(0, 1, 0.25), 0.103515625);
  assert.strictEqual(smoothstep(0, 1, 0.5), 0.5);
  assert.strictEqual(smoothstep(2, 4, 3), 0.5);
  assert.strictEqual(smoothstep(0, 1, -1), 0);
  assert.strictEqual(smoothstep(0, 1, 2), 1);
  assert.strictEqual(pingpong(0.5, 2), 0.5);
  assert.strictEqual(pingpong(3, 2), 1);
  assert.strictEqual(pingpong(5, 2), 1);
  assert.strictEqual(invFalloff(0), 1);
  assert.strictEqual(invFalloff(1), 0.5);
  assert.strictEqual(invFalloff(3), 0.1);
  assert.strictEqual(pulse(0, 1), 0.5);
  assert.ok(Math.abs(pulse(0.25, 1) - 1) < 1e-9);
  assert.ok(Math.abs(pulse(0.5, 1) - 0.5) < 1e-9);
  assert.strictEqual(cellIndex(3, 2, 10), 23);
  assert.strictEqual(inBounds(3, 2, 10, 10), true);
  assert.strictEqual(inBounds(10, 2, 10, 10), false);
  assert.strictEqual(inBounds(-1, 0, 10, 10), false);
});

test('dev math: hash01 is pinned, in range, and deterministic', () => {
  // Pinned reference: pcgHash32(42) = 1223963391; (h >>> 8) * 2^-24.
  assert.strictEqual(hash01(42), (1223963391 >>> 8) * 2 ** -24);
  for (const n of [0, 1, 2, 7, 42, 1000, 2 ** 31 - 1]) {
    const v = hash01(n);
    assert.ok(v >= 0 && v < 1, `hash01(${n}) = ${v}`);
  }
});

test('dev math: every function is bit-identical across repeated runs', () => {
  const fns: Array<[string, (x: number) => number]> = [
    ['clamp01', (x) => clamp01(x)],
    ['smoothstep', (x) => smoothstep(0, 1, x)],
    ['pingpong', (x) => pingpong(x, 2)],
    ['invFalloff', (x) => invFalloff(x)],
    ['pulse', (x) => pulse(x, 1)],
    ['hash01', (x) => hash01(x | 0)],
    ['lerp', (x) => lerp(-3, 7, x)],
    ['remap', (x) => remap(x, -1, 1, 0, 255)],
  ];
  const inputs = [-2.5, -0.25, 0, 0.1, 0.333, 0.5, 0.75, 1, 1.7, 42.25];
  for (const [name, f] of fns) {
    for (const x of inputs) {
      assert.strictEqual(f(x), f(x), `${name}(${x}) not deterministic`);
    }
  }
});
