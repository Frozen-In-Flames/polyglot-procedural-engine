// scene/grid.ts - grid worlds: a level as a cell map plus parameters.
//
// A grid world is data, not geometry: width x depth cells, a cell size, an
// origin and a wall height. Walls are full-height columns over solid cells.
// Raycasts run an exact 2D DDA (Amanatides and Woo) in the ground plane, so
// hit distances are exact face crossings, not marched approximations.
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
  /** Wall height in world units. */
  height: number;
  /** Row-major occupancy: cells[z * width + x], 1 = solid, 0 = open.
   *  Out-of-bounds reads as open (see gridSolid). */
  cells: Uint8Array;
}

export interface GridOpts {
  cellSize?: number;
  origin?: Vec3;
  height?: number;
}

/** An empty grid world (all cells open). */
export function makeGrid(width: number, depth: number, opts: GridOpts = {}): GridWorld {
  return {
    width,
    depth,
    cellSize: opts.cellSize ?? 1,
    origin: opts.origin ?? [0, 0, 0],
    height: opts.height ?? 2,
    cells: new Uint8Array(width * depth),
  };
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
 * Exact grid raycast: slab-test the wall band in y, then DDA in the ground
 * plane. Returns null on a miss (ray leaves the grid, passes over or under
 * the walls, or travels past maxDist without entering a solid cell).
 * The ray direction need not be normalized by the caller for correctness of
 * the cell walk, but depth is measured in ray-parameter units, so pass a
 * unit direction for world-unit depths.
 */
export function raycastGrid(
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

export interface GenerateOpts extends GridOpts {
  /** Probability that an interior cell is solid. Default 0.25. */
  density?: number;
  /** Wall the outer ring of cells. Default true. */
  border?: boolean;
}

/**
 * Seeded grid generation. Cells are visited in row-major order (z rows,
 * x columns) drawing one Pcg32 unit() per interior cell; border cells (when
 * border is on) are solid and draw nothing. Same seed, same world,
 * bit-identical, on every run.
 */
export function generateGrid(
  seed: number,
  width: number,
  depth: number,
  opts: GenerateOpts = {},
): GridWorld {
  const g = makeGrid(width, depth, opts);
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
