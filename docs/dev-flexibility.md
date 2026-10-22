# Dev flexibility: building games with just math (v2.0.0)

Seven opt-in features that widen how a game dev can build with this engine.
None of them changes a default; all of them are additive. Every number
below is measured by test/dev-flexibility.test.ts.

The lesson behind the release: a renderer can be pure dataflow (samples,
then hits, then columns), the world can be a small set of parameters
instead of stored geometry, and resolution can be a dial instead of an
architecture. Each feature below turns one part of that lesson into a
public surface.

## 1. Grid worlds as a scene type

**What.** A level defined as a cell map: `width x depth` cells, a cell
size, an origin, a wall height. Solid cells are full-height wall columns.
Grid worlds are a layer kind (`kind: 'grid'`) in the dimensional layering
system, so a grid world and SDF solids composite in one field of view
through the same `marchScene` call, nearest hit wins.

**Why.** A grid is the smallest world representation that still plays:
a maze, a dungeon floor, an arena. A dev defines a level as data (a few
hundred bytes of cells) and gets exact rendering plus the whole layer
system on top of it, instead of authoring meshes or choosing between two
engines.

**How.**
```ts
import { makeGrid, gridSet, generateGrid } from '.../src/scene/grid.js';
import { marchScene, type GridLayer } from '.../src/scene/layers.js';

const g = makeGrid(10, 10, { cellSize: 1, origin: [0, 0, 0], height: 2 });
gridSet(g, 4, 5, true);                    // one wall cell, or...
const g2 = generateGrid(1234, 24, 24, { density: 0.25, border: true });

const layer: GridLayer = {
  kind: 'grid',
  grid: g,
  color: (cellX, cellZ, side, p) => side === 'x' ? [0.8, 0.3, 0.3] : [0.6, 0.2, 0.2],
};
const hit = marchScene([layer, /* SDF layers... */], ray, camPos);
```
Raycasts against a grid run an exact DDA (Amanatides and Woo) in the
ground plane, so hit distances are exact face crossings: the test suite
pins an axis hit at exactly 5 and a 45-degree diagonal entry at exactly
1.5 * sqrt(2). `raycastGrid(grid, origin, dir, maxDist)` is public for
dev-side queries (line of sight, projectile sweeps) without a render.

**Per-cell heights (v2.0.2).** A world may carry a `heights` array
parallel to `cells`; each solid cell is then a box of its own height,
spanning `[origin.y, origin.y + heights[i]]`. Stepped tiers, rooftops,
and mesas come from the same cell map. The DDA respects each box: a ray
between two heights passes over the low cell and hits the tall one
(pinned: low top 1, tall top 3, a ray at y = 2 hits the tall face at
exactly 2.5), and a descending ray lands on a cell's top face at the
exact crossing. `gridHeightAt` / `gridSetHeight` read and write single
cell heights; `gridDistance(grid, p)` is the exact distance to the
nearest wall box (a minimum of exact box distances), so it never
overestimates and sphere tracing it never overshoots the analytic DDA
hit; the suite pins both properties on a stepped scene. Back-compat is
a hard rule: a world with no `heights`, or with every solid cell at the
world height, runs the original v2.0.0 code path and produces
bit-identical results, verified by a ray battery against a plain twin.

**Terrain distance field (v2.0.3).** The same per-cell heights also
read as a smooth heightfield terrain. `makeGridTerrain(grid)` (in
`src/scene/terrain-field.ts`) places one node at each cell center
(solid: its height; open: 0), interpolates bilinearly between centers,
and extends the edge value constantly beyond the outermost centers.
Its `distAt(p)` is a true conservative distance to that surface:
the vertical gap divided by `sqrt(1 + S^2)`, with S the maximum of the
proven per-patch bilinear slope bound `sqrt(mx^2 + mz^2)` over the
field (the refinement of the `sqrt(2) m` bound in
`src/geo/terrain-dist.ts`). `raycastTerrain` intersects a ray with
the surface analytically (per-patch quadratic); `marchTerrain`
sphere-traces the field with steps that can approach but never cross
the surface. `MarchOpts.policy: 'terrain'` routes grid layers through
the marcher; the DDA remains the wall-exact path. Measured on the
pinned generated world (seed 777, S = 5.66): over a 41-ray fan the
terrain policy spends 1453 steps for 41 hits, sphere tracing over the
exact box distance spends 674 for 23 hits, and fixed steps at 0.1
spend 19163 for the same 23; each terrain step is one bilinear patch
evaluation, against a full 256-cell scan per box-distance evaluation.
Honest limits: the surface is a smoothed reading of the stepped world
(at y = 2.5 the pinned step ray returns 2.5 from the DDA and 2.75
from the terrain surface), S is one global bound so a single steep
cell shrinks steps field-wide, and grazing rays on steep faces can
need large step budgets even though they never overshoot.

## 2. March policy as a choice

**What.** `MarchOpts.policy`: `'sphere'` (default) is the existing
adaptive sphere tracing, `t_{k+1} = t_k + f(o + t_k d)`. `'fixed'` marches
in fixed steps of `MarchOpts.fixedStep`, first sample inside the surface
wins. `'terrain'` (v2.0.3) marches grid layers over the terrain distance
field (see feature 1) instead of the exact DDA; SDF layers sphere-trace
as under `'sphere'`. The policy applies per scene; analytic layers (2d,
2.5d) are exact under every policy, and grid layers are exact under
`'sphere'` and `'fixed'`.

**Why.** Sphere tracing is exact but its cost varies with the field.
Fixed-step marching has a flat, predictable cost and a deliberate retro
quantization: for grid-flavored games and weak hardware, chunky-by-choice
with a published error beats exact-but-unpredictable. The dev picks per
scene by passing different opts; nothing is forced.

**How.**
```ts
marchScene(layers, ray, camPos, { policy: 'fixed', fixedStep: 0.3, steps: 2000 });
```

**Published error budget** (reference scene: unit sphere at distance 5,
measured by the test suite over a 16-ray fan, angles to 0.19 rad):
- fixed step 0.1: max distance error **0.0984**, inside the guaranteed
  bound of one step (0.1). On the axis ray with step 0.3 the error is
  exactly 0.2 (reported 4.2 vs true 4.0).
- sphere tracing on the same fan: max error **0.00214**.
Honest limit: fixed-step marching can tunnel through features thinner
than the step. That is the price of the flat cost, and it is why the mode
is opt-in with the number published instead of a silent default.

## 3. Resolution as runtime dials

**What.** `FrameMarcher` (src/render/frame.ts) renders a scanline of
columns over a layer scene and owns a live `params` object: `columns`,
`steps`, `maxDist`, `eps`, `fovY`, `policy`, `fixedStep`. Mutate any dial
and render again; there is no rebuild step.

**Why.** One game should scale from a phone to a headset by turning
dials, not by forking renderers. Live dials also make quality a runtime
decision: a dev can trade columns for frame rate while the game runs, or
hand the dials to the player.

**How.**
```ts
import { FrameMarcher } from '.../src/render/frame.js';
const m = new FrameMarcher({ columns: 90 });
let frame = m.render(cam, layers);
m.params.columns = 45;        // half the rays, same scene, same code path
frame = m.render(cam, layers);
m.params.fovY = Math.PI / 2;  // wider view, effective next frame
```
Defaults (`DEFAULT_FRAME_PARAMS`: 90 columns, 128 steps, max distance 100,
eps 1e-3, fovY pi/3, policy 'sphere') reproduce direct `marchScene` calls
bit-identically, column for column; the suite pins that, plus exact count
changes when the columns and steps dials move.

## 4. March telemetry API

**What.** Every frame rendered by `FrameMarcher` carries `FrameTelemetry`:
per-ray `steps`, `distance`, `hit`, and `cost` (field evaluations), plus
frame aggregates (`totalSteps`, `totalCost`, `hits`, `meanHitDistance`)
that are exactly the sums of the per-ray values. Lower level,
`MarchOpts.stats` is an opt-in counter any `marchScene` call can fill.
Cost convention: one unit per field evaluation; a hit on an SDF layer
adds 6 for the central-difference normal; analytic layers cost 1.

**Why.** Performance stops being folklore. A dev reads what the march
actually spent, builds debug views from the same numbers (a top-down ray
fan is just the per-ray distances plotted), drives auto-quality from
them, and the XR cost model gets measured inputs instead of estimates.

**How.**
```ts
const frame = marcher.render(cam, layers);
frame.telemetry.totalCost;        // field evals this frame
frame.telemetry.rays[0];          // { steps, distance, hit, cost }
```
Ground truth, pinned by tests: one column against a unit sphere at
distance 5 returns steps 2, distance exactly 4, cost 8 (2 trace evals +
6 normal evals). A full 90-column frame against that sphere costs 1068
field evals with 32 hits, measured.

## 5. Seed-regenerable levels

**What.** `generateGrid(seed, width, depth, { density, border })` builds
a grid world from a seed using the engine's canonical Pcg32, and
`GridLevel` wraps a world with its seed and a `regenerate(newSeed)`
method that replaces the world completely.

**Why.** A level becomes a number. Same seed, bit-identical world, on
every run and every port, so seeds are shareable, daily-seed and endless
modes are trivial, and a mid-game reset is one call with nothing carried
over from the old world.

**How.**
```ts
import { GridLevel } from '.../src/scene/grid.js';
const level = new GridLevel(7, 16, 16, { density: 0.3, border: true });
level.grid;              // the world for seed 7
level.regenerate(99);    // a brand-new world, seed 99
level.regenerate(7);     // back to the seed-7 world, bit-identical
```
The suite pins: same seed deep-equals across calls, different seeds
differ, border cells are always walled when `border` is on, and
regeneration reproduces a fresh `generateGrid` of the new seed exactly.

**Height generation (v2.0.2, opt-in).** `generateGrid(seed, w, d,
{ heights: true })` adds per-cell heights. The heights pass continues
the same Pcg32 stream after the cell pass (one draw per solid cell, in
row-major order, picking from `heightLevels`, default multipliers
[0.5, 1, 1.5, 2] of the base height), so toggling heights never
reshuffles the maze: the cells are bit-identical with the option on or
off, and the heights are bit-identical across runs of the same seed.
Pinned for seed 777 (16x16, density 0.3, base height 2): the 129 solid
cells draw levels 1, 2, 3, 4 exactly 28, 37, 25, and 39 times. Default
generation (no `heights` option) is bit-identical to v2.0.0 worlds;
existing scenes and the live demo are untouched.

## 6. Hookable render stages

**What.** The frame render is dataflow (samples, hits, columns), and
`FrameMarcher.render` accepts two hooks: `hitTest` runs at the hit stage
and may override the engine's hit for a ray (return a `LayerHit`), or
decline by returning undefined; `shadeColumn` runs at the column stage
and maps a finished column's hit to its final color.

**Why.** Devs should be able to insert their own math (custom hit rules,
portals, per-column fog and tinting, stylized shading) without forking
the engine. Hooks are the sanctioned seam: full context in (ray, index,
the engine's own hit), a value out.

**How.**
```ts
const frame = marcher.render(cam, layers, {
  hitTest: (ctx) => ctx.nx < -0.9
    ? { depth: 3, color: [1, 0, 0], kind: '3d', layer: 99 }
    : undefined,                       // decline: keep the engine hit
  shadeColumn: (ctx) => ctx.hit.color.map(c => c * 0.5) as Vec3,  // dim all
});
```
The suite pins: a doubling shade hook doubles column colors exactly, a
forced hit replaces a miss at exactly the given depth, a declining hook
and an absent hook both leave output identical to plain rendering.

## 7. Write-once dev math blocks

**What.** `src/dev/math.ts`: eleven small pure functions for game logic:
`clamp`, `clamp01`, `lerp`, `remap`, `smoothstep`, `pingpong`,
`invFalloff`, `pulse`, `hash01`, `cellIndex`, `inBounds`. Closed-form,
loop-free, no state. Also exported from the package root as the `dev`
namespace.

**Why.** The polyglot promise should extend to the games, not stop at
the engine. Anything built from these blocks behaves identically in
every port, because each block is exact arithmetic or rides the engine's
canonical exact paths: `pulse` uses the polynomial sine (libm sine
differs across platforms), `hash01` uses the canonical PCG hash,
`smoothstep` is the quintic fade.

**How.**
```ts
import { dev } from '.../src/index.js';        // or src/dev/math.js directly
const t = dev.smoothstep(0, 1, health);        // 0.103515625 at health 0.25
const flicker = dev.pulse(time, 2);            // [0, 1], bit-identical everywhere
const shade = dev.hash01(dev.cellIndex(x, z, w));  // per-cell deterministic variety
```
Every function carries a reference-value test (for example
`smoothstep(0, 1, 0.25)` is exactly 0.103515625 and `hash01(42)` is the
pinned PCG value 0.28497612476348877), and a determinism test runs each
function over an input table twice demanding bit-identical outputs.

## Honest limits

- The frame marcher renders one horizontal scanline of columns (ny = 0);
  it is the column view the dials and telemetry speak in, not a full 2D
  framebuffer. The WebGL raymarcher remains the full-frame renderer.
- Fixed-step marching tunnels through features thinner than the step
  (see feature 2); sphere tracing stays the default.
- Grid walls are vertical cell boxes: since v2.0.2 each cell carries its
  own height, but there are no slopes, overhangs, or roofs within a
  cell; a cell is open or solid at one height. The v2.0.3 terrain field
  reads the same heights as a smooth surface for marching and queries,
  but the boxes remain the exact geometry.
- Telemetry cost counts field evaluations, not wall-clock time; it is the
  cost-model unit, comparable across scenes and ports, not a profiler.
