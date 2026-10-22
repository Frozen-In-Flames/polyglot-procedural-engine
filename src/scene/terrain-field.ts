// scene/terrain-field.ts - terrain distance field over grid worlds (v2.0.3).
//
// A grid world read as a heightfield terrain. Each cell contributes one
// node at its center with the cell's effective height (a solid cell: its
// per-cell height; an open cell: 0, the floor at origin.y). The surface
// between centers is the bilinear interpolation of the node values;
// outside the outermost centers the edge value extends constantly. The
// stepped box world stays the exact geometry for raycastGrid and
// gridDistance; this field is the smooth surface over the same data, for
// marching and for dev-side height queries.
//
// Conservative distance. For a surface y = h(x, z) with slope bound
// ||grad h|| <= S, the vertical gap g = y - h(x, z) gives the classical
// conservative distance |g| / sqrt(1 + S^2) (derivation in
// src/geo/terrain-dist.ts). S here is not eyeballed: within one bilinear
// patch with corner values a, b, c, d over a square of side cs,
//   dh/dx = ((b - a)(1 - v) + (d - c) v) / cs,
//   dh/dz = ((c - a)(1 - u) + (d - b) u) / cs,
// so |dh/dx| <= mx and |dh/dz| <= mz with mx, mz the maxima of the patch's
// edge slopes, and ||grad h||^2, a sum of a convex function of v and a
// convex function of u, attains its patch maximum at a corner, where it
// is at most mx^2 + mz^2. The patch bound is therefore
// sqrt(mx^2 + mz^2), which refines the global sqrt(2) m form of
// bilinearSlopeBound (m = max(mx, mz)). The field's S is the maximum of
// the patch bounds over every patch. A single global S is what makes
// distAt a true distance bound at every point: the nearest surface point
// can lie across a patch boundary, so a purely local patch bound would
// overestimate the distance next to a steep neighbor (a flat patch
// beside a cliff). The price is stated plainly: one steep cell shrinks
// steps across the whole field.
//
// Marching distAt sphere-traces the smooth surface with provably safe
// steps: a step never exceeds the true distance to the surface, so the
// march can approach but never cross it. raycastTerrain is the analytic
// counterpart (per-patch quadratic root), the ground truth the march is
// graded against.
import type { Vec3 } from '../math/vec.js';
import { gridHeightAt, gridSolid, type GridWorld } from './grid.js';

export interface GridTerrainField {
  /** The world this field was built from (node heights are snapshotted
   *  at build time; see makeGridTerrain). */
  grid: GridWorld;
  /** Global slope bound S: the maximum patch bound over the field. */
  slopeBound: number;
  /** Surface height in world y at (x, z): origin.y + interpolated node
   *  height. Defined everywhere; outside the footprint the nearest edge
   *  value extends constantly. */
  heightAt(x: number, z: number): number;
  /** Bilinear gradient (dh/dx, dh/dz) of the surface at (x, z), in
   *  world units per world unit. */
  gradientAt(x: number, z: number): [number, number];
  /** Proven slope bound sqrt(mx^2 + mz^2) of the patch containing
   *  (x, z). Never below the true ||grad h|| anywhere in that patch. */
  patchSlopeBoundAt(x: number, z: number): number;
  /** Conservative signed distance to the terrain surface:
   *  (y - heightAt(x, z)) / sqrt(1 + S^2). Negative below the surface.
   *  Its magnitude never exceeds the true distance to the surface. */
  distAt(p: Vec3): number;
  /** Snapshotted node height of a cell (0 when out of bounds):
   *  the per-cell height for solid cells, else 0. */
  nodeHeightAt(cellX: number, cellZ: number): number;
}

/** Node height of cell (x, z): per-cell height for solid cells, else 0. */
function nodeHeight(g: GridWorld, x: number, z: number): number {
  return gridSolid(g, x, z) ? gridHeightAt(g, x, z) : 0;
}

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * Interpolation indices along one node axis of length n for the clamped
 * fractional coordinate u in [0, n - 1]: the patch [i0, i1] and the
 * fraction across it. For n = 1 the axis is degenerate (i0 = i1, frac 0).
 */
function patchAxis(u: number, n: number): { i0: number; i1: number; frac: number } {
  if (n <= 1) return { i0: 0, i1: 0, frac: 0 };
  const i0 = Math.min(Math.floor(u), n - 2);
  return { i0, i1: i0 + 1, frac: u - i0 };
}

/**
 * Build the terrain distance field over a grid world. Node heights and
 * patch bounds are snapshotted at build time; heightAt interpolates the
 * snapshot (a world mutated after the build needs a rebuild to reflect
 * the edit, the same contract as any baked field).
 */
export function makeGridTerrain(g: GridWorld): GridTerrainField {
  const W = g.width;
  const D = g.depth;
  const cs = g.cellSize;
  const ox = g.origin[0];
  const oy = g.origin[1];
  const oz = g.origin[2];

  // Node heights, row-major like cells.
  const nodes = new Float64Array(W * D);
  for (let j = 0; j < D; j++) {
    for (let i = 0; i < W; i++) nodes[j * W + i] = nodeHeight(g, i, j);
  }
  const H = (i: number, j: number): number => nodes[j * W + i];

  // Per-node-cell patch bounds with clamped neighbors: cell (i, j)'s
  // patch has corners (i, j), (i1, j), (i, j1), (i1, j1) with
  // i1 = min(i + 1, W - 1), j1 = min(j + 1, D - 1). Interior cells are
  // the true bilinear patches; the last row and column degenerate to
  // the constant-extension strips, whose true gradients they still
  // bound. The global S is the max over all of them.
  const patchBounds = new Float64Array(W * D);
  let slopeBound = 0;
  for (let j = 0; j < D; j++) {
    const j1 = Math.min(j + 1, D - 1);
    for (let i = 0; i < W; i++) {
      const i1 = Math.min(i + 1, W - 1);
      const a = H(i, j);
      const b = H(i1, j);
      const c = H(i, j1);
      const d = H(i1, j1);
      const mx = Math.max(Math.abs(b - a), Math.abs(d - c)) / cs;
      const mz = Math.max(Math.abs(c - a), Math.abs(d - b)) / cs;
      const bound = Math.hypot(mx, mz);
      patchBounds[j * W + i] = bound;
      if (bound > slopeBound) slopeBound = bound;
    }
  }
  const denom = Math.sqrt(1 + slopeBound * slopeBound);

  /** Clamped fractional node coordinates of a world (x, z). */
  const uv = (x: number, z: number): [number, number] => [
    clamp((x - ox) / cs - 0.5, 0, W - 1),
    clamp((z - oz) / cs - 0.5, 0, D - 1),
  ];

  /** The bilinear patch corners at (x, z) plus the local fractions.
   *  cellI/cellJ name the interpolation patch (the patchAxis patch), so
   *  patchSlopeBoundAt bounds the gradient gradientAt returns; beyond
   *  the outermost centers that patch's bound still covers the
   *  constant-extension strip, whose gradient is the edge gradient with
   *  the clamped component zeroed. */
  const patch = (x: number, z: number) => {
    const rawU = (x - ox) / cs - 0.5;
    const rawV = (z - oz) / cs - 0.5;
    const [u, v] = uv(x, z);
    const ax = patchAxis(u, W);
    const az = patchAxis(v, D);
    return {
      fu: ax.frac,
      fv: az.frac,
      a: H(ax.i0, az.i0),
      b: H(ax.i1, az.i0),
      c: H(ax.i0, az.i1),
      d: H(ax.i1, az.i1),
      cellI: ax.i0,
      cellJ: az.i0,
      uClamped: rawU < 0 || rawU > W - 1,
      vClamped: rawV < 0 || rawV > D - 1,
    };
  };

  const heightAt = (x: number, z: number): number => {
    const { fu, fv, a, b, c, d } = patch(x, z);
    const top = a + (b - a) * fu;
    const bot = c + (d - c) * fu;
    return oy + top + (bot - top) * fv;
  };

  const gradientAt = (x: number, z: number): [number, number] => {
    const { fu, fv, a, b, c, d, uClamped, vClamped } = patch(x, z);
    // In the constant-extension strips the surface does not vary along
    // the clamped axis, so that gradient component is zero there, not
    // the interior patch's edge value.
    const gx = uClamped ? 0 : ((b - a) * (1 - fv) + (d - c) * fv) / cs;
    const gz = vClamped ? 0 : ((c - a) * (1 - fu) + (d - b) * fu) / cs;
    return [gx, gz];
  };

  const patchSlopeBoundAt = (x: number, z: number): number => {
    const { cellI, cellJ } = patch(x, z);
    return patchBounds[cellJ * W + cellI];
  };

  const distAt = (p: Vec3): number => (p[1] - heightAt(p[0], p[2])) / denom;

  const nodeHeightAt = (cellX: number, cellZ: number): number => {
    if (cellX < 0 || cellZ < 0 || cellX >= W || cellZ >= D) return 0;
    return nodes[cellZ * W + cellX];
  };

  return {
    grid: g, slopeBound, heightAt, gradientAt, patchSlopeBoundAt, distAt, nodeHeightAt,
  };
}

export interface TerrainHit {
  /** Exact ray distance to the terrain surface. */
  depth: number;
  point: Vec3;
  /** Cell under the hit point (clamped into the grid). */
  cellX: number;
  cellZ: number;
  /** Dominant slope axis at the hit: 'x' when |dh/dx| >= |dh/dz|. */
  side: 'x' | 'z';
}

/**
 * Analytic raycast against the terrain surface: the walk visits the
 * bilinear patches in ray order and solves the gap quadratic in each,
 * so the first root is the exact ray-heightfield intersection. The
 * surface includes the constant extension beyond the outermost centers
 * (heightAt is defined everywhere), so a ray can meet the plateau
 * outside the footprint; maxDist bounds the search. Returns null when
 * the ray never crosses the surface within maxDist, or starts at or
 * below it (the field is a march oracle for rays approaching from
 * above).
 */
export function raycastTerrain(
  f: GridTerrainField,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
): TerrainHit | null {
  const g = f.grid;
  const cs = g.cellSize;
  const ox = g.origin[0];
  const oz = g.origin[2];
  const W = g.width;
  const D = g.depth;
  const tEnter = 0;
  const tExit = maxDist;

  const gapAt = (t: number): number =>
    origin[1] + dir[1] * t -
    f.heightAt(origin[0] + dir[0] * t, origin[2] + dir[2] * t);
  if (gapAt(tEnter) <= 0) return null; // starts at or below the surface

  // Breakpoints: every t where the fractional node coordinate u or v
  // crosses an integer (patch boundary or clamp bound 0 / n - 1).
  const u0 = (origin[0] - ox) / cs - 0.5;
  const du = dir[0] / cs;
  const v0 = (origin[2] - oz) / cs - 0.5;
  const dv = dir[2] / cs;
  const breaks: number[] = [tEnter, tExit];
  const addBreaks = (c0: number, dc: number, n: number): void => {
    if (Math.abs(dc) < 1e-15) return;
    const ca = c0 + dc * tEnter;
    const cb = c0 + dc * tExit;
    const lo = Math.ceil(Math.min(ca, cb));
    const hi = Math.floor(Math.max(ca, cb));
    for (let k = lo; k <= hi; k++) {
      if (k < 0 || k > n - 1) continue;
      const t = (k - c0) / dc;
      if (t > tEnter && t < tExit) breaks.push(t);
    }
  };
  addBreaks(u0, du, W);
  addBreaks(v0, dv, D);
  breaks.sort((a, b) => a - b);

  const finish = (t: number): TerrainHit => {
    const point: Vec3 = [
      origin[0] + dir[0] * t,
      origin[1] + dir[1] * t,
      origin[2] + dir[2] * t,
    ];
    const [gx, gz] = f.gradientAt(point[0], point[2]);
    return {
      depth: t,
      point,
      cellX: clamp(Math.floor((point[0] - ox) / cs), 0, W - 1),
      cellZ: clamp(Math.floor((point[2] - oz) / cs), 0, D - 1),
      side: Math.abs(gx) >= Math.abs(gz) ? 'x' : 'z',
    };
  };

  // Per segment the patch is constant and u, v (clamped) are affine in
  // t, so the gap is a quadratic in the segment parameter.
  for (let s = 0; s + 1 < breaks.length; s++) {
    const ta = breaks[s];
    const tb = breaks[s + 1];
    const tm = (ta + tb) / 2;
    const xm = origin[0] + dir[0] * tm;
    const zm = origin[2] + dir[2] * tm;
    // Patch corners at the segment midpoint (the field's own patch).
    const uMid = clamp((xm - ox) / cs - 0.5, 0, W - 1);
    const vMid = clamp((zm - g.origin[2]) / cs - 0.5, 0, D - 1);
    const axx = patchAxis(uMid, W);
    const azz = patchAxis(vMid, D);
    const H = (i: number, j: number): number => f.nodeHeightAt(i, j);
    const a = H(axx.i0, azz.i0);
    const b = H(axx.i1, azz.i0);
    const c = H(axx.i0, azz.i1);
    const d = H(axx.i1, azz.i1);
    // Effective (clamped) node coordinates at the segment ends; affine
    // across the segment because no clamp bound is crossed inside it.
    const ua = clamp(u0 + du * ta, 0, W - 1);
    const ub = clamp(u0 + du * tb, 0, W - 1);
    const va = clamp(v0 + dv * ta, 0, D - 1);
    const vb = clamp(v0 + dv * tb, 0, D - 1);
    const segLen = tb - ta;
    // Fractions as affine functions of tau in [0, segLen].
    const fu0 = ua - axx.i0;
    const fu1 = (ub - ua) / segLen;
    const fv0 = va - azz.i0;
    const fv1 = (vb - va) / segLen;
    // h(tau) = A + B Fu + C Fv + E Fu Fv; gap = y - origin.y - h.
    const A = a;
    const B = b - a;
    const C = c - a;
    const E = a - b - c + d;
    // Expand Fu Fv and powers into gap(tau) = q2 tau^2 + q1 tau + q0.
    const yA = origin[1] + dir[1] * ta - g.origin[1];
    const h0 = A + B * fu0 + C * fv0 + E * fu0 * fv0;
    const h1 = B * fu1 + C * fv1 + E * (fu0 * fv1 + fu1 * fv0);
    const h2 = E * fu1 * fv1;
    const q2 = -h2;
    const q1 = dir[1] - h1;
    const q0 = yA - h0;
    let root: number | null = null;
    if (Math.abs(q2) < 1e-14) {
      if (Math.abs(q1) > 1e-14) {
        const r = -q0 / q1;
        if (r > 0 && r <= segLen) root = r;
      }
    } else {
      const disc = q1 * q1 - 4 * q2 * q0;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        const q = -0.5 * (q1 + (q1 >= 0 ? sq : -sq));
        const r1 = q / q2;
        const r2 = q !== 0 ? q0 / q : Infinity;
        for (const r of [r1, r2]) {
          if (r > 0 && r <= segLen && (root === null || r < root)) root = r;
        }
      }
    }
    if (root !== null) return finish(ta + root);
  }
  return null;
}

export interface TerrainMarchOpts {
  /** Step budget. Default 128 (mirrors MARCH_STEPS). */
  steps?: number;
  /** Hit epsilon on the field value. Default 1e-3 (mirrors MARCH_EPS). */
  eps?: number;
  /** Max march distance. Default 100 (mirrors MARCH_MAX_DIST). */
  maxDist?: number;
}

export interface TerrainMarchResult {
  /** Hit distance, or Infinity on a miss. Never past the analytic hit:
   *  every step is a true distance bound, so the march cannot overshoot. */
  depth: number;
  /** March iterations taken. */
  steps: number;
  /** Field evaluations taken (one per iteration). */
  evals: number;
  /** Hit point when depth is finite. */
  point?: Vec3;
}

/**
 * Sphere-trace the terrain distance field: t advances by distAt, a true
 * distance bound, so the march approaches the surface from above and
 * stops at the first sample inside eps, never beyond the analytic
 * ray-heightfield intersection.
 */
export function marchTerrain(
  f: GridTerrainField,
  origin: Vec3,
  dir: Vec3,
  opts: TerrainMarchOpts = {},
): TerrainMarchResult {
  const steps = opts.steps ?? 128;
  const eps = opts.eps ?? 1e-3;
  const maxDist = opts.maxDist ?? 100;
  let t = 0;
  let evals = 0;
  for (let i = 0; i < steps; i++) {
    const p: Vec3 = [
      origin[0] + dir[0] * t,
      origin[1] + dir[1] * t,
      origin[2] + dir[2] * t,
    ];
    const d = f.distAt(p);
    evals++;
    if (d < eps) return { depth: t, steps: i + 1, evals, point: p };
    t += d;
    if (t > maxDist) return { depth: Infinity, steps: i + 1, evals };
  }
  return { depth: Infinity, steps, evals };
}
