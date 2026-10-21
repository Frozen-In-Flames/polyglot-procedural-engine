// scene/grid.ts - grid worlds: a level as a cell map plus parameters.
//
// A grid world is data, not geometry: width x depth cells, a cell size, an
// origin and a wall height. Walls are columns over solid cells. Raycasts
// run an exact 2D DDA (Amanatides and Woo) in the ground plane, so
// hit distances are exact face crossings, not marched approximations.
//
// Per-cell heights (v2.0.2): an optional heights array parallel to cells
// makes each solid cell a box of its own height (stepped, tiered worlds).
// A world without the array, or with every solid cell at the world height,
// takes the original uniform code path and behaves bit-exactly as v2.0.0.
//
// Generation is seeded and deterministic: generateGrid walks the cells in
// a fixed order drawing from the engine's canonical Pcg32, so the same
// seed produces a bit-identical world on every run and every port. A
// GridLevel wraps a world with its seed and regenerates in place, which is
// the mid-game reset: new seed, new world, nothing else carried over.
import type { Vec3 } from '../math/vec.js';
import { Pcg32 } from '../math/determinism.js';

export interface GridWorld {
  /** Cells along x. */
  width: number;
  /** Cells along z. */
  depth: number;
  /** World units per cell (square cells). */
  cellSize: number;
  /** World position of the min corner: cell (x, z) spans
   *  [origin.x + x*cellSize, origin.x + (x+1)*cellSize) in x, likewise z.
   *  Walls span y in [origin.y, origin.y + height]. */
  origin: Vec3;
  /** Wall height in world units: the uniform height, and the height of
   *  any solid cell whose per-cell height is not set. */
  height: number;
  /** Row-major occupancy: cells[z * width + x], 1 = solid, 0 = open.
   *  Out-of-bounds reads as open (see gridSolid). */
  cells: Uint8Array;
  /** Optional per-cell wall heights, parallel to cells: the wall over
   *  cell (x, z) spans y in [origin.y, origin.y + heights[z * width + x]].
   *  Only meaningful for solid cells. Undefined (the default) means the
   *  uniform world height everywhere, bit-exactly as v2.0.0. */
  heights?: Float64Array;
}

export interface GridOpts {
  cellSize?: number;
  origin?: Vec3;
  height?: number;
  /** Per-cell heights for makeGrid; copied into the new world. */
  heights?: Float64Array;
}

/** An empty grid world (all cells open). */
export function makeGrid(width: number, depth: number, opts: GridOpts = {}): GridWorld {
  const g: GridWorld = {
    width,
    depth,
    cellSize: opts.cellSize ?? 1,
    origin: opts.origin ?? [0, 0, 0],
    height: opts.height ?? 2,
    cells: new Uint8Array(width * depth),
  };
  if (opts.heights) g.heights = new Float64Array(opts.heights);
  return g;
}

export function gridInBounds(g: GridWorld, x: number, z: number): boolean {
  return x >= 0 && z >= 0 && x < g.width && z < g.depth;
}

/** Occupancy read; out of bounds is open. */
export function gridSolid(g: GridWorld, x: number, z: number): boolean {
  if (!gridInBounds(g, x, z)) return false;
  return g.cells[z * g.width + x] === 1;
}

export function gridSet(g: GridWorld, x: number, z: number, solid: boolean): void {
  if (!gridInBounds(g, x, z)) return;
  g.cells[z * g.width + x] = solid ? 1 : 0;
}

/**
 * Effective wall height of a cell: its per-cell height when the world
 * carries a heights array, else the uniform world height. Out of bounds
 * reads as 0 (no wall).
 */
export function gridHeightAt(g: GridWorld, x: number, z: number): number {
  if (!gridInBounds(g, x, z)) return 0;
  return g.heights ? g.heights[z * g.width + x] : g.height;
}

/**
 * Set one cell's wall height. Allocates the heights array on first use,
 * filled with the world height, so every other cell keeps its current
 * effective height.
 */
export function gridSetHeight(g: GridWorld, x: number, z: number, h: number): void {
  if (!gridInBounds(g, x, z)) return;
  if (!g.heights) g.heights = new Float64Array(g.width * g.depth).fill(g.height);
  g.heights[z * g.width + x] = h;
}

/**
 * Exact distance from a point to the grid's wall geometry: the minimum
 * over solid cells of the exact point-to-box distance (each cell is the
 * box [x0, x1] x [origin.y, origin.y + cell height] x [z0, z1]). Zero
 * inside a wall box, Infinity when the world has no solid cells. As a
 * minimum of exact box distances this is a true distance bound: it never
 * overestimates, so sphere tracing it stays correct against the walls,
 * per-cell heights included.
 */
export function gridDistance(g: GridWorld, p: Vec3): number {
  const ox = g.origin[0];
  const oy = g.origin[1];
  const oz = g.origin[2];
  const cs = g.cellSize;
  let best = Infinity;
  for (let z = 0; z < g.depth; z++) {
    for (let x = 0; x < g.width; x++) {
      if (g.cells[z * g.width + x] !== 1) continue;
      const h = gridHeightAt(g, x, z);
      const x0 = ox + x * cs;
      const z0 = oz + z * cs;
      const dx = Math.max(x0 - p[0], 0, p[0] - (x0 + cs));
      const dy = Math.max(oy - p[1], 0, p[1] - (oy + h));
      const dz = Math.max(z0 - p[2], 0, p[2] - (z0 + cs));
      const d = Math.hypot(dx, dy, dz);
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}

export interface GridHit {
  /** Exact ray distance to the face of the solid cell that was entered. */
  depth: number;
  cellX: number;
  cellZ: number;
  /** Which face was crossed: 'x' = a face of constant x, 'z' = constant z. */
  side: 'x' | 'z';
  point: Vec3;
}

/**
 * Exact grid raycast. Returns null on a miss (ray leaves the grid, passes
 * over or under the walls, or travels past maxDist without entering a
 * solid cell). The ray direction need not be normalized by the caller for
 * correctness of the cell walk, but depth is measured in ray-parameter
 * units, so pass a unit direction for world-unit depths.
 *
 * Dispatch: a world with no heights array, or with every solid cell at
 * the uniform world height, runs the original v2.0.0 slab-plus-DDA path
 * bit-exactly. A world with genuinely per-cell heights runs a per-cell
 * box walk (raycastGridPerCell).
 */
export function raycastGrid(
  g: GridWorld,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
): GridHit | null {
  if (heightsAreUniform(g)) return raycastGridUniform(g, origin, dir, maxDist);
  return raycastGridPerCell(g, origin, dir, maxDist);
}

/** True when the per-cell heights, if any, agree with the uniform world
 *  height on every solid cell, so the world is a v2.0.0 uniform world. */
function heightsAreUniform(g: GridWorld): boolean {
  if (!g.heights) return true;
  for (let i = 0; i < g.cells.length; i++) {
    if (g.cells[i] === 1 && g.heights[i] !== g.height) return false;
  }
  return true;
}

/**
 * The v2.0.0 raycast: slab-test the single wall band in y, then DDA in
 * the ground plane. Kept verbatim as the uniform-height path.
 */
function raycastGridUniform(
  g: GridWorld,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
): GridHit | null {
  const ox = g.origin[0];
  const oy = g.origin[1];
  const oz = g.origin[2];
  const cs = g.cellSize;

  // Wall band in y: the ray must be inside [oy, oy + height] while over the
  // grid. Compute the t-interval where it is.
  let tEnter = 0;
  let tExit = maxDist;
  if (Math.abs(dir[1]) < 1e-12) {
    if (origin[1] < oy || origin[1] > oy + g.height) return null;
  } else {
    let ta = (oy - origin[1]) / dir[1];
    let tb = (oy + g.height - origin[1]) / dir[1];
    if (ta > tb) [ta, tb] = [tb, ta];
    tEnter = Math.max(tEnter, ta);
    tExit = Math.min(tExit, tb);
    if (tEnter > tExit) return null;
  }

  // Grid AABB in the ground plane: clamp the working interval to where the
  // ray is actually over the grid, so the DDA starts at the entry face and
  // the width + depth step bound below is genuinely sufficient.
  for (const ax of [0, 2] as const) {
    const lo = ax === 0 ? ox : oz;
    const hi = lo + (ax === 0 ? g.width : g.depth) * cs;
    if (Math.abs(dir[ax]) < 1e-12) {
      if (origin[ax] < lo || origin[ax] > hi) return null;
    } else {
      let ta = (lo - origin[ax]) / dir[ax];
      let tb = (hi - origin[ax]) / dir[ax];
      if (ta > tb) [ta, tb] = [tb, ta];
      tEnter = Math.max(tEnter, ta);
      tExit = Math.min(tExit, tb);
      if (tEnter > tExit) return null;
    }
  }

  // Ground-plane position at tEnter.
  const px = origin[0] + dir[0] * tEnter;
  const pz = origin[2] + dir[2] * tEnter;
  let cx = Math.floor((px - ox) / cs);
  let cz = Math.floor((pz - oz) / cs);

  const stepX = dir[0] > 0 ? 1 : -1;
  const stepZ = dir[2] > 0 ? 1 : -1;
  const tDeltaX = Math.abs(dir[0]) < 1e-12 ? Infinity : cs / Math.abs(dir[0]);
  const tDeltaZ = Math.abs(dir[2]) < 1e-12 ? Infinity : cs / Math.abs(dir[2]);
  // Distance to the first cell boundary along each axis, from the ray origin.
  let tMaxX =
    Math.abs(dir[0]) < 1e-12
      ? Infinity
      : ((dir[0] > 0 ? ox + (cx + 1) * cs : ox + cx * cs) - origin[0]) / dir[0];
  let tMaxZ =
    Math.abs(dir[2]) < 1e-12
      ? Infinity
      : ((dir[2] > 0 ? oz + (cz + 1) * cs : oz + cz * cs) - origin[2]) / dir[2];

  // Starting inside a solid cell: hit at the band entry.
  if (gridSolid(g, cx, cz)) {
    return {
      depth: tEnter,
      cellX: cx,
      cellZ: cz,
      side: Math.abs(dir[0]) >= Math.abs(dir[2]) ? 'x' : 'z',
      point: [px, origin[1] + dir[1] * tEnter, pz],
    };
  }

  // DDA walk. Guard bound: a ray crosses at most width + depth boundaries
  // inside the grid; a few extra steps cover the entry offset.
  const maxIter = g.width + g.depth + 4;
  for (let i = 0; i < maxIter; i++) {
    let t: number;
    let side: 'x' | 'z';
    if (tMaxX < tMaxZ) {
      t = tMaxX;
      tMaxX += tDeltaX;
      cx += stepX;
      side = 'x';
    } else if (tMaxZ < tMaxX) {
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      cz += stepZ;
      side = 'z';
    } else {
      // Exact tie (diagonal through a corner): step both axes.
      t = tMaxX;
      tMaxX += tDeltaX;
      tMaxZ += tDeltaZ;
      cx += stepX;
      cz += stepZ;
      side = 'z';
    }
    if (t > tExit || t > maxDist) return null;
    if (gridSolid(g, cx, cz)) {
      return {
        depth: t,
        cellX: cx,
        cellZ: cz,
        side,
        point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
      };
    }
    if (!gridInBounds(g, cx, cz) && (cx < -1 || cz < -1 || cx > g.width || cz > g.depth)) {
      return null; // walked off the grid and moving away
    }
  }
  return null;
}

/**
 * Per-cell-height raycast: each solid cell is a box of its own height.
 * The ground-plane DDA visits cells in entry order; for each solid cell
 * the ray's footprint interval over that cell is intersected with the
 * t-interval where the ray is inside the box's y span. The first
 * non-empty intersection is the nearest box hit, because footprint
 * intervals are ordered along the walk and each hit lies inside its own
 * cell's interval. A hit at the footprint entry is a side face ('x' or
 * 'z', the step that entered the cell); a hit at the y-interval start is
 * the top face (descending ray) or bottom face (rising ray), reported
 * with the same dominant-axis side convention the uniform path uses for
 * a band entry.
 */
function raycastGridPerCell(
  g: GridWorld,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
): GridHit | null {
  const ox = g.origin[0];
  const oy = g.origin[1];
  const oz = g.origin[2];
  const cs = g.cellSize;

  // Ground-plane AABB interval only: the y band is per cell now, so it
  // moves into the per-cell test below.
  let tEnter = 0;
  let tExit = maxDist;
  for (const ax of [0, 2] as const) {
    const lo = ax === 0 ? ox : oz;
    const hi = lo + (ax === 0 ? g.width : g.depth) * cs;
    if (Math.abs(dir[ax]) < 1e-12) {
      if (origin[ax] < lo || origin[ax] > hi) return null;
    } else {
      let ta = (lo - origin[ax]) / dir[ax];
      let tb = (hi - origin[ax]) / dir[ax];
      if (ta > tb) [ta, tb] = [tb, ta];
      tEnter = Math.max(tEnter, ta);
      tExit = Math.min(tExit, tb);
      if (tEnter > tExit) return null;
    }
  }

  const px = origin[0] + dir[0] * tEnter;
  const pz = origin[2] + dir[2] * tEnter;
  let cx = Math.floor((px - ox) / cs);
  let cz = Math.floor((pz - oz) / cs);

  const stepX = dir[0] > 0 ? 1 : -1;
  const stepZ = dir[2] > 0 ? 1 : -1;
  const tDeltaX = Math.abs(dir[0]) < 1e-12 ? Infinity : cs / Math.abs(dir[0]);
  const tDeltaZ = Math.abs(dir[2]) < 1e-12 ? Infinity : cs / Math.abs(dir[2]);
  let tMaxX =
    Math.abs(dir[0]) < 1e-12
      ? Infinity
      : ((dir[0] > 0 ? ox + (cx + 1) * cs : ox + cx * cs) - origin[0]) / dir[0];
  let tMaxZ =
    Math.abs(dir[2]) < 1e-12
      ? Infinity
      : ((dir[2] > 0 ? oz + (cz + 1) * cs : oz + cz * cs) - origin[2]) / dir[2];

  // The t-interval where the ray is inside the y span of a box of height
  // h, or null when it never is (level ray outside the span).
  const yInterval = (h: number): [number, number] | null => {
    if (Math.abs(dir[1]) < 1e-12) {
      return origin[1] >= oy && origin[1] <= oy + h
        ? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
        : null;
    }
    let ta = (oy - origin[1]) / dir[1];
    let tb = (oy + h - origin[1]) / dir[1];
    if (ta > tb) [ta, tb] = [tb, ta];
    return [ta, tb];
  };

  const dominantSide = (): 'x' | 'z' =>
    Math.abs(dir[0]) >= Math.abs(dir[2]) ? 'x' : 'z';

  let tIn = tEnter;
  let enterSide: 'x' | 'z' | null = null;
  const maxIter = g.width + g.depth + 4;
  for (let i = 0; i <= maxIter; i++) {
    const tOut = Math.min(tMaxX, tMaxZ, tExit);
    if (gridSolid(g, cx, cz)) {
      const yi = yInterval(gridHeightAt(g, cx, cz));
      if (yi) {
        const lo = Math.max(tIn, yi[0]);
        const hi = Math.min(tOut, yi[1]);
        if (lo <= hi) {
          const side = yi[0] > tIn ? dominantSide() : (enterSide ?? dominantSide());
          return {
            depth: lo,
            cellX: cx,
            cellZ: cz,
            side,
            point: [
              origin[0] + dir[0] * lo,
              origin[1] + dir[1] * lo,
              origin[2] + dir[2] * lo,
            ],
          };
        }
      }
    }
    if (i === maxIter) break;
    let t: number;
    if (tMaxX < tMaxZ) {
      t = tMaxX;
      tMaxX += tDeltaX;
      cx += stepX;
      enterSide = 'x';
    } else if (tMaxZ < tMaxX) {
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      cz += stepZ;
      enterSide = 'z';
    } else {
      // Exact tie (diagonal through a corner): step both axes.
      t = tMaxX;
      tMaxX += tDeltaX;
      tMaxZ += tDeltaZ;
      cx += stepX;
      cz += stepZ;
      enterSide = 'z';
    }
    if (t > tExit || t > maxDist) return null;
    tIn = t;
    if (!gridInBounds(g, cx, cz) && (cx < -1 || cz < -1 || cx > g.width || cz > g.depth)) {
      return null; // walked off the grid and moving away
    }
  }
  return null;
}

export interface GenerateOpts extends Omit<GridOpts, 'heights'> {
  /** Probability that an interior cell is solid. Default 0.25. */
  density?: number;
  /** Wall the outer ring of cells. Default true. */
  border?: boolean;
  /** Opt-in per-cell heights. Default false: the generated world has no
   *  heights array and is bit-identical to v2.0.0. When true, a heights
   *  pass runs after the cell pass, continuing the same Pcg32 stream:
   *  one unit() per solid cell in row-major order picks a level from
   *  heightLevels. The cell pass consumes the stream exactly as before,
   *  so toggling heights never reshuffles the maze. */
  heights?: boolean;
  /** Discrete height levels as multipliers of the base world height.
   *  Default [0.5, 1, 1.5, 2]. Open cells always get height 0. */
  heightLevels?: number[];
}

/**
 * Seeded grid generation. Cells are visited in row-major order (z rows,
 * x columns) drawing one Pcg32 unit() per interior cell; border cells (when
 * border is on) are solid and draw nothing. Same seed, same world,
 * bit-identical, on every run. With heights on, the heights pass continues
 * the same stream after the cells (see GenerateOpts.heights).
 */
export function generateGrid(
  seed: number,
  width: number,
  depth: number,
  opts: GenerateOpts = {},
): GridWorld {
  const g = makeGrid(width, depth, {
    cellSize: opts.cellSize,
    origin: opts.origin,
    height: opts.height,
  });
  const density = opts.density ?? 0.25;
  const border = opts.border ?? true;
  const rng = new Pcg32(seed);
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) {
      const edge = x === 0 || z === 0 || x === width - 1 || z === depth - 1;
      if (edge && border) {
        g.cells[z * width + x] = 1;
      } else {
        g.cells[z * width + x] = rng.unit() < density ? 1 : 0;
      }
    }
  }
  if (opts.heights) {
    const levels = opts.heightLevels ?? [0.5, 1, 1.5, 2];
    const heights = new Float64Array(width * depth);
    for (let i = 0; i < width * depth; i++) {
      if (g.cells[i] === 1) {
        const li = Math.min(levels.length - 1, Math.floor(rng.unit() * levels.length));
        heights[i] = g.height * levels[li];
      }
    }
    g.heights = heights;
  }
  return g;
}

/**
 * A level: a grid world plus the seed that made it. regenerate() swaps in
 * a freshly generated world for a new seed, replacing the old world
 * completely (new cells array, nothing carried over).
 */
export class GridLevel {
  seed: number;
  grid: GridWorld;
  private readonly width: number;
  private readonly depth: number;
  private readonly genOpts: GenerateOpts;

  constructor(seed: number, width: number, depth: number, opts: GenerateOpts = {}) {
    this.seed = seed;
    this.width = width;
    this.depth = depth;
    this.genOpts = { ...opts };
    this.grid = generateGrid(seed, width, depth, opts);
  }

  regenerate(seed: number): GridWorld {
    this.seed = seed;
    this.grid = generateGrid(seed, this.width, this.depth, this.genOpts);
    return this.grid;
  }
}
