import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  marchScene,
  type Layer,
  type GridLayer,
  type Solid3D,
} from '../src/scene/layers.js';
import {
  makeGrid,
  gridSet,
  gridSetHeight,
  gridHeightAt,
  gridDistance,
  raycastGrid,
  generateGrid,
  GridLevel,
  type GridWorld,
} from '../src/scene/grid.js';
import type { Vec3 } from '../src/math/vec.js';

// Per-cell grid heights (v2.0.2): each solid cell is a box of its own
// height. Back-compat is the hard constraint: no heights array, or heights
// uniform at the world height, behaves bit-exactly as v2.0.0. Generation
// of heights is opt-in and leaves the cell stream untouched.

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/** Two adjacent wall cells along x: low (h = 1) at x = 2, tall (h = 3) at
 *  x = 3, in a 6x1 strip. Base world height is 2, so both cells exercise
 *  the per-cell path. */
function stepGrid(): GridWorld {
  const g = makeGrid(6, 1, { cellSize: 1, origin: [0, 0, 0], height: 2 });
  gridSet(g, 2, 0, true);
  gridSet(g, 3, 0, true);
  const heights = new Float64Array(6);
  heights[2] = 1;
  heights[3] = 3;
  g.heights = heights;
  return g;
}

/** The v2.0.0 wall scene (full z = 5 row walled, 10x10, height 2). */
function wallGridTwin(withHeights: boolean): GridWorld {
  const g = makeGrid(10, 10, { cellSize: 1, origin: [0, 0, 0], height: 2 });
  for (let x = 0; x < 10; x++) gridSet(g, x, 5, true);
  if (withHeights) g.heights = new Float64Array(100).fill(2);
  return g;
}

function gridLayer(g: GridWorld, color: Vec3): GridLayer {
  return { kind: 'grid', grid: g, color: () => color };
}

// ---------------------------------------------------------------------------
// 1. Back-compat: uniform heights are bit-identical to no heights
// ---------------------------------------------------------------------------

test('heights: uniform heights reproduce v2.0.0 raycasts bit-exactly', () => {
  const plain = wallGridTwin(false);
  const uniform = wallGridTwin(true);
  const rays: Array<[Vec3, Vec3, number]> = [
    [[4.5, 1, 0], [0, 0, 1], 100], // in-band axis ray, face hit at 5
    [[0.5, 1, 0.5], [Math.SQRT1_2, 0, Math.SQRT1_2], 100], // diagonal
    [[4.5, 6, 0.5], [0, -0.6, 0.8], 100], // descends onto the wall top
    [[4.5, -3, 0.5], [0, 0.6, 0.8], 100], // rises from below into the wall
    [[4.5, 3, 0], [0, 0, 1], 100], // above the band: miss
    [[4.5, 1, 0], [0, 0, 1], 3], // cut by maxDist: miss
    [[4.5, 1, 9.5], [0, 0, -1], 100], // from behind the wall
    [[-2, 1, 5.5], [1, 0, 0], 100], // enters the grid from outside in x
  ];
  for (const [o, d, m] of rays) {
    const a = raycastGrid(plain, o, d, m);
    const b = raycastGrid(uniform, o, d, m);
    assert.deepStrictEqual(b, a, `ray ${o} -> ${d}`);
  }
  // The pinned v2.0.0 numbers still hold on the uniform-heights world.
  const hit = raycastGrid(uniform, [4.5, 1, 0], [0, 0, 1], 100);
  assert.ok(hit);
  assert.strictEqual(hit.depth, 5);
  assert.strictEqual(hit.side, 'z');
});

test('heights: generated world with uniform heights matches its plain twin', () => {
  const plain = generateGrid(99, 16, 16, { density: 0.3, border: true });
  const uniform = generateGrid(99, 16, 16, { density: 0.3, border: true });
  uniform.heights = new Float64Array(16 * 16).fill(uniform.height);
  const rays: Array<[Vec3, Vec3]> = [
    [[8.5, 1, 0.5], [0, 0, 1]],
    [[0.5, 1, 8.5], [1, 0, 0]],
    [[8.5, 5, 0.5], [0, -0.6, 0.8]],
    [[2.5, 1, 2.5], [Math.SQRT1_2, 0, Math.SQRT1_2]],
  ];
  for (const [o, d] of rays) {
    assert.deepStrictEqual(raycastGrid(uniform, o, d, 100), raycastGrid(plain, o, d, 100));
  }
  // Composite through marchScene agrees too.
  const layersA: Layer[] = [gridLayer(plain, [1, 0, 0])];
  const layersB: Layer[] = [gridLayer(uniform, [1, 0, 0])];
  const ray = { origin: [8.5, 1, 0.5] as Vec3, dir: [0, 0, 1] as Vec3 };
  const a = marchScene(layersA, ray, ray.origin);
  const b = marchScene(layersB, ray, ray.origin);
  assert.strictEqual(b.depth, a.depth);
  assert.strictEqual(b.kind, a.kind);
});

// ---------------------------------------------------------------------------
// 2. Step cases: the ray reads each cell's own height
// ---------------------------------------------------------------------------

test('heights: ray between two heights passes over the low cell, hits the tall cell exactly', () => {
  const g = stepGrid();
  // y = 2 is above the low top (1) and below the tall top (3).
  const hit = raycastGrid(g, [0.5, 2, 0.5], [1, 0, 0], 100);
  assert.ok(hit);
  assert.strictEqual(hit.depth, 2.5);
  assert.strictEqual(hit.cellX, 3);
  assert.strictEqual(hit.cellZ, 0);
  assert.strictEqual(hit.side, 'x');
  assert.deepStrictEqual(hit.point, [3, 2, 0.5]);
  // Below both tops the same ray stops at the low cell's face.
  const low = raycastGrid(g, [0.5, 0.5, 0.5], [1, 0, 0], 100);
  assert.ok(low);
  assert.strictEqual(low.depth, 1.5);
  assert.strictEqual(low.cellX, 2);
});

test('heights: descending ray lands on the tall top after overflying the low cell', () => {
  const g = stepGrid();
  // Enters the tall footprint at t = 3.125 with y = 3.625 (above its top),
  // crosses y = 3 at t = 2.5 / 0.6 while still over the tall cell (exit at
  // t = 4.375): a top-face hit. Over the low cell y stays in [3.6, 4.4].
  const dir: Vec3 = [0.8, -0.6, 0];
  const hit = raycastGrid(g, [0.5, 5.5, 0.5], dir, 100);
  assert.ok(hit);
  assert.strictEqual(hit.cellX, 3);
  assert.ok(Math.abs(hit.depth - 2.5 / 0.6) < 1e-12, `depth ${hit.depth}`);
  assert.ok(Math.abs(hit.point[1] - 3) < 1e-12, `point y ${hit.point[1]}`);
  assert.ok(hit.point[0] >= 3 && hit.point[0] < 4, `point x ${hit.point[0]}`);
});

test('heights: straight-down rays land on each cell top at the exact distance', () => {
  const g = stepGrid();
  const low = raycastGrid(g, [2.5, 5, 0.5], [0, -1, 0], 100);
  assert.ok(low);
  assert.strictEqual(low.depth, 4);
  assert.deepStrictEqual(low.point, [2.5, 1, 0.5]);
  const tall = raycastGrid(g, [3.5, 5, 0.5], [0, -1, 0], 100);
  assert.ok(tall);
  assert.strictEqual(tall.depth, 2);
  assert.deepStrictEqual(tall.point, [3.5, 3, 0.5]);
});

test('heights: a camera above every height gets no hit', () => {
  const g = stepGrid(); // tallest top is 3
  assert.strictEqual(raycastGrid(g, [0.5, 10, 0.5], [1, 0, 0], 100), null);
  const miss = marchScene([gridLayer(g, [1, 0, 0])], { origin: [0.5, 10, 0.5], dir: [1, 0, 0] }, [0.5, 10, 0.5]);
  assert.strictEqual(miss.kind, 'none');
  assert.strictEqual(miss.depth, Infinity);
});

test('heights: negative control: the step case fails against uniform-height shims', () => {
  // Same cells as stepGrid but heights ignored: a uniform world of the
  // tall height stops the y = 2 ray at the LOW cell (depth 1.5, cell 2),
  // and a uniform world of the low height lets it pass entirely. Both
  // contradict the pinned step result (tall cell, depth 2.5), which
  // proves the step test reads the per-cell heights.
  const cells = (): GridWorld => {
    const g = makeGrid(6, 1, { cellSize: 1, origin: [0, 0, 0], height: 2 });
    gridSet(g, 2, 0, true);
    gridSet(g, 3, 0, true);
    return g;
  };
  const tallShim = cells();
  tallShim.height = 3;
  const shimHit = raycastGrid(tallShim, [0.5, 2, 0.5], [1, 0, 0], 100);
  assert.ok(shimHit);
  assert.strictEqual(shimHit.cellX, 2);
  assert.strictEqual(shimHit.depth, 1.5);
  const lowShim = cells();
  lowShim.height = 1;
  assert.strictEqual(raycastGrid(lowShim, [0.5, 2, 0.5], [1, 0, 0], 100), null);
});

// ---------------------------------------------------------------------------
// 3. The grid distance field: exact box distance, never an overestimate
// ---------------------------------------------------------------------------

test('heights: gridDistance pins exact distances to a stepped wall', () => {
  const g = stepGrid();
  // Above the tall top, centered: pure vertical gap.
  assert.strictEqual(gridDistance(g, [3.5, 5, 0.5]), 2);
  // Level with the tall box, off its x face: pure horizontal gap.
  assert.strictEqual(gridDistance(g, [0.5, 2, 0.5]), Math.hypot(1.5, 1));
  // Inside the low box: zero.
  assert.strictEqual(gridDistance(g, [2.5, 0.5, 0.5]), 0);
  // Diagonal off a corner of the tall box: dx = 1, dy = 1, dz = 1.
  assert.ok(Math.abs(gridDistance(g, [5, 4, 2]) - Math.sqrt(3)) < 1e-12);
  // No solid cells: no surface, infinite distance.
  assert.strictEqual(gridDistance(makeGrid(4, 4), [0, 0, 0]), Infinity);
  // The field at a ray origin never exceeds the analytic hit depth along
  // that ray (the no-overestimate bound sphere tracing relies on).
  const o: Vec3 = [0.5, 2, 0.5];
  const hit = raycastGrid(g, o, [1, 0, 0], 100);
  assert.ok(hit);
  assert.ok(gridDistance(g, o) <= hit.depth);
});

test('heights: sphere tracing the grid field never overshoots the analytic hit', () => {
  const g = stepGrid();
  const layer: Solid3D = { kind: '3d', sdf: (p) => gridDistance(g, p), shade: () => [0, 1, 0] };
  const cases: Array<{ o: Vec3; d: Vec3 }> = [
    { o: [0.5, 2, 0.5], d: [1, 0, 0] }, // overflight into the tall face
    { o: [0.5, 0.5, 0.5], d: [1, 0, 0] }, // into the low face
    { o: [0.5, 5.5, 0.5], d: [0.8, -0.6, 0] }, // onto the tall top
    { o: [2.5, 5, 0.5], d: [0, -1, 0] }, // straight down onto the low top
    { o: [3.5, 5, 0.5], d: [0, -1, 0] }, // straight down onto the tall top
    { o: [5.5, 2, 0.5], d: [-1, 0, 0] }, // tall face from the other side
  ];
  for (const { o, d } of cases) {
    const analytic = raycastGrid(g, o, d, 100);
    assert.ok(analytic, `analytic miss for ${o} -> ${d}`);
    const traced = marchScene([layer], { origin: o, dir: d }, o, { eps: 1e-6 });
    assert.strictEqual(traced.kind, '3d');
    assert.ok(
      traced.depth <= analytic.depth + 1e-9,
      `overshoot: traced ${traced.depth} > analytic ${analytic.depth} for ${o} -> ${d}`,
    );
    assert.ok(
      traced.depth >= analytic.depth - 0.01,
      `traced ${traced.depth} too far short of analytic ${analytic.depth} for ${o} -> ${d}`,
    );
  }
  // A ray that misses analytically also misses under the field.
  const miss = marchScene([layer], { origin: [0.5, 10, 0.5], dir: [1, 0, 0] }, [0.5, 10, 0.5], { eps: 1e-6 });
  assert.strictEqual(miss.depth, Infinity);
});

// ---------------------------------------------------------------------------
// 4. Generation: opt-in, deterministic, cells untouched
// ---------------------------------------------------------------------------

test('heights: generation is opt-in and the cell stream is bit-identical either way', () => {
  const off = generateGrid(777, 16, 16, { density: 0.3, border: true });
  assert.strictEqual(off.heights, undefined);
  const on = generateGrid(777, 16, 16, { density: 0.3, border: true, heights: true });
  const onHeights = on.heights;
  assert.ok(onHeights);
  // Toggling heights does not reshuffle the maze: the heights pass
  // continues the seed stream after the cell pass.
  assert.deepStrictEqual([...on.cells], [...off.cells]);
  // Every solid cell draws a level from base * {0.5, 1, 1.5, 2}; open
  // cells carry 0. Distribution pinned for this seed (measured).
  const levels = [1, 2, 3, 4];
  const counts = new Map<number, number>();
  for (let i = 0; i < on.cells.length; i++) {
    if (on.cells[i] === 1) {
      const h: number = onHeights[i];
      assert.ok(levels.includes(h), `height ${h} not in the level set`);
      counts.set(h, (counts.get(h) ?? 0) + 1);
    } else {
      assert.strictEqual(onHeights[i], 0);
    }
  }
  assert.deepStrictEqual(
    [...counts.entries()].sort((a, b) => a[0] - b[0]),
    [[1, 28], [2, 37], [3, 25], [4, 39]],
  );
});

test('heights: same seed with heights on is bit-identical, levels included', () => {
  const a = generateGrid(4242, 24, 24, { density: 0.25, border: true, heights: true });
  const b = generateGrid(4242, 24, 24, { density: 0.25, border: true, heights: true });
  assert.deepStrictEqual([...a.cells], [...b.cells]);
  assert.deepStrictEqual([...a.heights!], [...b.heights!]);
  // More than one distinct height among solid cells (not vacuous).
  const distinct = new Set<number>();
  for (let i = 0; i < a.cells.length; i++) if (a.cells[i] === 1) distinct.add(a.heights![i]);
  assert.ok(distinct.size >= 3, `only ${distinct.size} distinct heights`);
  // A level: GridLevel carries the opt-in through regeneration.
  const level = new GridLevel(11, 16, 16, { density: 0.3, border: true, heights: true });
  const firstHeights = [...level.grid.heights!];
  level.regenerate(12);
  assert.notDeepStrictEqual([...level.grid.heights!], firstHeights);
  level.regenerate(11);
  assert.deepStrictEqual([...level.grid.heights!], firstHeights);
});

test('heights: gridHeightAt and gridSetHeight round-trip through raycasts', () => {
  const g = makeGrid(4, 1, { cellSize: 1, origin: [0, 0, 0], height: 2 });
  assert.strictEqual(gridHeightAt(g, 1, 0), 2); // uniform fallback
  assert.strictEqual(gridHeightAt(g, 9, 9), 0); // out of bounds: no wall
  gridSet(g, 1, 0, true);
  gridSetHeight(g, 1, 0, 5);
  assert.strictEqual(gridHeightAt(g, 1, 0), 5);
  assert.ok(g.heights);
  // A horizontal ray at y = 4 now hits the raised cell...
  const hit = raycastGrid(g, [0.5, 4, 0.5], [1, 0, 0], 100);
  assert.ok(hit);
  assert.strictEqual(hit.cellX, 1);
  assert.strictEqual(hit.depth, 0.5);
  // ...where the same world at the default height misses at y = 4.
  const plain = makeGrid(4, 1, { cellSize: 1, origin: [0, 0, 0], height: 2 });
  gridSet(plain, 1, 0, true);
  assert.strictEqual(raycastGrid(plain, [0.5, 4, 0.5], [1, 0, 0], 100), null);
});
