// scene/layers.ts - dimensional layering: 2D, 2.5D, 3D and 4D elements
// composite in one field of view through one march.
//
// Dimensionality is a property of how a layer answers "what is the field
// value here", not a separate pipeline:
//   2d   - flat field in billboard space (camera-facing or fixed orientation)
//   2.5d - plane layer { depth, parallaxScale, content2D }; the multiplane
//          effect as arithmetic: content coordinate v = uvP - s * uvC
//   3d   - standard SDF, sphere-traced with the documented march
//          (t_{k+1} = t_k + f(o + t_k d))
//   4d   - time-varying field f(p, t), 3D plus time; evaluated at frame time
//
// One march evaluates every layer and keeps the nearest hit, so occlusion
// falls out of depth order. Craft-material looks ride the v1.6.0 TEV
// material system; layers take color callbacks and never reimplement them.
//
// Emission layers (v2.0.8) are the volumetric exception: an analytic
// tokamak-geometry emissivity field (src/scene/emission-field.ts) that
// owns no surface. marchScene integrates its radiance along the ray up
// to the nearest surface hit and adds it to that hit's color, so
// occlusion still falls out of depth order; standing alone it returns
// its glow at depth Infinity.
//
// Gameplay planes: a PlaneStack is an ordered stack of 2.5D layers the
// player inhabits and hops between. Hopping is a depth translation of the
// player, never a camera trick.
import { sub3, dot3, cross3, lengthSquared3, type Vec2, type Vec3 } from '../math/vec.js';
import type { CharacterState } from '../game/character.js';
import { finiteJacobian } from '../inverse/conditioning.js';
import { irlsGnFit } from '../inverse/robust.js';
import { raycastGrid, type GridWorld } from './grid.js';
import { makeGridTerrain, marchTerrain } from './terrain-field.js';
import { marchInterval, terrainIntervalField } from '../math/interval-march.js';
import {
  emissionQuadrature,
  type EmissionField,
} from './emission-field.js';

export type DimKind = '2d' | '2.5d' | '3d' | '4d' | 'grid' | 'emission';

export interface Ray {
  origin: Vec3;
  dir: Vec3; // normalized
}

export interface PinholeCam {
  pos: Vec3;
  target: Vec3;
  fovY: number;
  aspect: number;
}

export interface LayerHit {
  depth: number; // ray distance; Infinity on a clean miss
  color: Vec3;
  kind: DimKind | 'none';
  layer: number; // index into the scene list; -1 on a miss
}

export interface Layer2D {
  kind: '2d';
  center: Vec3;
  size: Vec2; // full width/height in world units
  /** 2D SDF in uv space, uv in [-1, 1]^2; surface where field2 <= 0. */
  field2: (uv: Vec2) => number;
  color: (uv: Vec2) => Vec3;
  facing: 'camera' | 'fixed';
  fixedNormal?: Vec3; // required when facing === 'fixed'
}

export interface Layer25D {
  kind: '2.5d';
  center: Vec3;
  normal: Vec3; // unit, faces the viewer
  size: Vec2; // physical quad extent in world units
  depth: number; // gameplay plane depth tag
  parallaxScale: number; // content shift per unit camera translation
  /** Content in parallax-shifted uv space; surface where dist <= 0. */
  content: (v: Vec2) => { dist: number; color: Vec3 };
}

export interface Solid3D {
  kind: '3d';
  sdf: (p: Vec3) => number;
  shade: (p: Vec3, n: Vec3) => Vec3;
}

export interface Field4D {
  kind: '4d';
  field: (p: Vec3, t: number) => number;
  shade: (p: Vec3, t: number, n: Vec3) => Vec3;
  time: number; // current frame time
}

export interface GridLayer {
  kind: 'grid';
  /** The cell-map world (src/scene/grid.ts). Walls are columns over
   *  solid cells, each of its own height when the world carries per-cell
   *  heights; raycast exactly by DDA. */
  grid: GridWorld;
  /** Color per wall hit: cell coordinates, the face crossed, hit point. */
  color: (cellX: number, cellZ: number, side: 'x' | 'z', p: Vec3) => Vec3;
}

export interface EmissionLayer {
  kind: 'emission';
  /** The emission field (src/scene/emission-field.ts): tokamak
   *  geometry emissivity, analytic at every point. */
  field: EmissionField;
  /** Constant tint multiplied into the integrated emission.
   *  Default [1, 1, 1]. Ignored when colorAt is given. */
  tint?: Vec3;
  /** Spatial tint field, evaluated per quadrature sample; overrides
   *  tint. This is the layer system's usual color callback, read
   *  volumetrically: radiance is the line integral of
   *  emission(p) * colorAt(p) along the ray. */
  colorAt?: (p: Vec3) => Vec3;
  /** Scalar multiplier on the integrated radiance. Default 1. */
  gain?: number;
}

export type Layer = Layer2D | Layer25D | Solid3D | Field4D | GridLayer | EmissionLayer;

/** March policy.
 *  'sphere': adaptive sphere tracing, t_{k+1} = t_k + f(o + t_k d) (default).
 *  'fixed': fixed-step marching, samples at multiples of fixedStep; the
 *  first sample inside the surface wins. Distance error is bounded by one
 *  step (measured and pinned: see docs/dev-flexibility.md), and features
 *  thinner than the step can be tunneled through. Analytic layers (2d,
 *  2.5d, grid) are exact under either policy.
 *  'terrain' (v2.0.3): grid layers march the terrain distance field
 *  (src/scene/terrain-field.ts) instead of the exact DDA: sphere tracing
 *  over the smooth bilinear surface the per-cell heights define, with
 *  provably safe steps. The terrain surface extends constantly beyond
 *  the outermost cell centers (the field is defined everywhere), so
 *  maxDist is what bounds a terrain ray's search. SDF layers (3d, 4d)
 *  sphere-trace as under 'sphere'; 2d and 2.5d layers are unaffected. The terrain surface is
 *  a smoothed reading of the same world, not the stepped box geometry,
 *  so terrain hits differ from DDA hits wherever a wall face is steep:
 *  the policy is for terrain-style rendering and queries, and the DDA
 *  stays the exact path for walls.
 *  'interval' (v2.0.6): grid layers march the same terrain surface as
 *  'terrain', but every step is certified against the interval
 *  Lipschitz bound over the step's own segment (src/math/interval-
 *  march.ts): the step length is guaranteed conservative from the
 *  slope bounds of the patches the step actually crosses, not from
 *  the field-wide maximum S the 'terrain' policy divides by. The
 *  guarantee matches 'terrain' (the march can approach but never
 *  cross the analytic intersection); steps on tame ground are larger.
 *  Other layer kinds are unaffected (they sphere-trace as under
 *  'sphere'); the guaranteed marcher itself is field-generic and is
 *  exported for SDF trees as marchInterval over sdfIntervalField. */
export type MarchPolicy = 'sphere' | 'fixed' | 'terrain' | 'interval';

/** Opt-in march instrumentation: when supplied, the march counts its work
 *  here. steps = march iterations; evals = field/content evaluations
 *  (analytic layers count 1). This is the raw material of the telemetry
 *  API (src/render/telemetry.ts) and the XR cost model. */
export interface MarchStats {
  steps: number;
  evals: number;
}

export interface MarchOpts {
  steps?: number;
  maxDist?: number;
  eps?: number;
  policy?: MarchPolicy;
  /** Fixed-policy sample spacing in world units. Default 0.1. */
  fixedStep?: number;
  /** Opt-in work counter; undefined (default) changes nothing. */
  stats?: MarchStats;
}

export const MARCH_STEPS = 128;
export const MARCH_EPS = 1e-3;
export const MARCH_MAX_DIST = 100;

const MISS: LayerHit = { depth: Infinity, color: [0, 0, 0], kind: 'none', layer: -1 };

// sub3/dot3/cross3 come from the canonical vecmath core
// (src/math/vec.ts, v3.3.0); the private copies that used to live
// here were bit-identical and are gone. norm3 stays a local wrapper
// ON the core: it divides component-wise (a[i] / l) where the core's
// norm3 multiplies by the reciprocal, and the two can differ by an
// ulp - this module's outputs are pinned, so its rounding path is
// not swapped under it.
function norm3(a: Vec3): Vec3 {
  const l = Math.sqrt(lengthSquared3(a)) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Orthonormal basis for a plane with the given normal. */
function planeBasis(n: Vec3): { u: Vec3; v: Vec3 } {
  const up: Vec3 = Math.abs(n[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
  const u = norm3(cross3(n, up));
  const v = cross3(n, u);
  return { u, v };
}

/** Ray through normalized device coords nx, ny in [-1, 1]. */
export function pinholeRay(cam: PinholeCam, nx: number, ny: number): Ray {
  const fwd = norm3(sub3(cam.target, cam.pos));
  const right = norm3(cross3([0, 1, 0], fwd));
  const up = cross3(fwd, right);
  const t = Math.tan(cam.fovY / 2);
  const dir = norm3([
    fwd[0] + right[0] * nx * t * cam.aspect + up[0] * ny * t,
    fwd[1] + right[1] * nx * t * cam.aspect + up[1] * ny * t,
    fwd[2] + right[2] * nx * t * cam.aspect + up[2] * ny * t,
  ]);
  return { origin: [cam.pos[0], cam.pos[1], cam.pos[2]], dir };
}

/**
 * Parallax-shifted content coordinate for a 2.5D layer.
 * v = uvP - s * uvC: under camera translation the sampled content shifts by
 * exactly s times the planar camera delta. s = 0 reads static.
 */
export function parallaxUV(layer: Layer25D, p: Vec3, camPos: Vec3): Vec2 {
  const n = norm3(layer.normal);
  const { u, v } = planeBasis(n);
  const rel = sub3(p, layer.center);
  const relC = sub3(camPos, layer.center);
  const s = layer.parallaxScale;
  return [
    dot3(rel, u) - s * dot3(relC, u),
    dot3(rel, v) - s * dot3(relC, v),
  ];
}

function rayPlane(origin: Vec3, dir: Vec3, center: Vec3, normal: Vec3): number {
  const n = norm3(normal);
  const dn = dot3(dir, n);
  if (dn >= 0) return Infinity; // backface or parallel: no front hit
  const t = dot3(sub3(center, origin), n) / dn;
  return t > 0 ? t : Infinity;
}

function at(ray: Ray, t: number): Vec3 {
  return [
    ray.origin[0] + ray.dir[0] * t,
    ray.origin[1] + ray.dir[1] * t,
    ray.origin[2] + ray.dir[2] * t,
  ];
}

function intersectLayer2D(layer: Layer2D, ray: Ray, camPos: Vec3, index: number): LayerHit {
  const n = layer.facing === 'camera'
    ? norm3(sub3(camPos, layer.center))
    : norm3(layer.fixedNormal ?? [0, 0, -1]);
  const t = rayPlane(ray.origin, ray.dir, layer.center, n);
  if (!isFinite(t)) return MISS;
  const p = at(ray, t);
  const { u, v } = planeBasis(n);
  const rel = sub3(p, layer.center);
  const uv: Vec2 = [
    dot3(rel, u) / (layer.size[0] / 2),
    dot3(rel, v) / (layer.size[1] / 2),
  ];
  if (Math.abs(uv[0]) > 1 || Math.abs(uv[1]) > 1) return MISS;
  if (layer.field2(uv) > 0) return MISS;
  return { depth: t, color: layer.color(uv), kind: '2d', layer: index };
}

function intersectLayer25D(layer: Layer25D, ray: Ray, camPos: Vec3, index: number): LayerHit {
  const t = rayPlane(ray.origin, ray.dir, layer.center, layer.normal);
  if (!isFinite(t)) return MISS;
  const p = at(ray, t);
  const n = norm3(layer.normal);
  const { u, v } = planeBasis(n);
  const rel = sub3(p, layer.center);
  const qu: Vec2 = [dot3(rel, u), dot3(rel, v)];
  if (Math.abs(qu[0]) > layer.size[0] / 2 || Math.abs(qu[1]) > layer.size[1] / 2) return MISS;
  const c = layer.content(parallaxUV(layer, p, camPos));
  if (c.dist > 0) return MISS;
  return { depth: t, color: c.color, kind: '2.5d', layer: index };
}

/**
 * March a field under the selected policy.
 * 'sphere' (default): t_{k+1} = t_k + f(o + t_k d), adaptive.
 * 'fixed': samples at t = k * fixedStep; the first sample with f < eps is
 * the hit. Error vs the true surface is at most one step along the ray
 * (plus the eps band); features thinner than the step can be missed.
 * 'terrain' behaves as 'sphere' for field layers; it only changes how
 * grid layers intersect (see intersectGridLayerTerrain).
 */
function sphereTrace(
  field: (p: Vec3) => number,
  ray: Ray,
  opts: MarchOpts = {},
): number {
  const steps = opts.steps ?? MARCH_STEPS;
  const eps = opts.eps ?? MARCH_EPS;
  const maxDist = opts.maxDist ?? MARCH_MAX_DIST;
  const stats = opts.stats;
  if ((opts.policy ?? 'sphere') === 'fixed') {
    const step = opts.fixedStep ?? 0.1;
    let t = 0;
    for (let i = 0; i < steps; i++) {
      if (stats) stats.steps++;
      const f = field(at(ray, t));
      if (f < eps) return t;
      t += step;
      if (t > maxDist) return Infinity;
    }
    return Infinity;
  }
  let t = 0;
  for (let i = 0; i < steps; i++) {
    if (stats) stats.steps++;
    const p = at(ray, t);
    const f = field(p);
    if (f < eps) return t;
    t += f;
    if (t > maxDist) return Infinity;
  }
  return Infinity;
}

function centralNormal(field: (p: Vec3) => number, p: Vec3): Vec3 {
  const h = 1e-4;
  const dx = field([p[0] + h, p[1], p[2]]) - field([p[0] - h, p[1], p[2]]);
  const dy = field([p[0], p[1] + h, p[2]]) - field([p[0], p[1] - h, p[2]]);
  const dz = field([p[0], p[1], p[2] + h]) - field([p[0], p[1], p[2] - h]);
  return norm3([dx, dy, dz]);
}

function intersectSolid3D(layer: Solid3D, ray: Ray, index: number, opts: MarchOpts): LayerHit {
  const stats = opts.stats;
  const field = stats
    ? (p: Vec3) => {
        stats.evals++;
        return layer.sdf(p);
      }
    : layer.sdf;
  const t = sphereTrace(field, ray, opts);
  if (!isFinite(t)) return MISS;
  const p = at(ray, t);
  const n = centralNormal(field, p);
  return { depth: t, color: layer.shade(p, n), kind: '3d', layer: index };
}

function intersectField4D(layer: Field4D, ray: Ray, index: number, opts: MarchOpts): LayerHit {
  const stats = opts.stats;
  const raw = (p: Vec3) => layer.field(p, layer.time);
  const field = stats
    ? (p: Vec3) => {
        stats.evals++;
        return raw(p);
      }
    : raw;
  const t = sphereTrace(field, ray, opts);
  if (!isFinite(t)) return MISS;
  const p = at(ray, t);
  const n = centralNormal(field, p);
  return { depth: t, color: layer.shade(p, layer.time, n), kind: '4d', layer: index };
}

function intersectGridLayer(layer: GridLayer, ray: Ray, index: number, opts: MarchOpts): LayerHit {
  if ((opts.policy ?? 'sphere') === 'terrain') {
    return intersectGridLayerTerrain(layer, ray, index, opts);
  }
  if ((opts.policy ?? 'sphere') === 'interval') {
    return intersectGridLayerInterval(layer, ray, index, opts);
  }
  const hit = raycastGrid(layer.grid, ray.origin, ray.dir, opts.maxDist ?? MARCH_MAX_DIST);
  if (!hit) return MISS;
  return {
    depth: hit.depth,
    color: layer.color(hit.cellX, hit.cellZ, hit.side, hit.point),
    kind: 'grid',
    layer: index,
  };
}

/**
 * Terrain-policy grid intersection: sphere-trace the grid's terrain
 * distance field. The field is rebuilt per call (a snapshot of the
 * world's node heights and patch bounds), so in-place world edits are
 * always honored; devs marching many rays against a static world can
 * call marchTerrain on their own makeGridTerrain snapshot instead.
 * The color callback receives the cell under the hit point and the
 * dominant slope axis there as the side.
 */
function intersectGridLayerTerrain(
  layer: GridLayer,
  ray: Ray,
  index: number,
  opts: MarchOpts,
): LayerHit {
  const field = makeGridTerrain(layer.grid);
  const res = marchTerrain(field, ray.origin, ray.dir, opts);
  if (opts.stats) {
    opts.stats.steps += res.steps;
    opts.stats.evals += res.evals;
  }
  if (!isFinite(res.depth) || !res.point) return MISS;
  return terrainLayerHit(layer, field, index, res.depth, res.point);
}

/**
 * Interval-policy grid intersection: march the terrain surface with
 * the interval Lipschitz guaranteed step (src/math/interval-march.ts).
 * Same surface and hit contract as the 'terrain' policy; the step
 * bound comes from the patches under each step instead of the
 * field-wide slope maximum, so tame stretches march faster while the
 * no-overshoot guarantee is unchanged. Bound queries count as evals
 * in the stats: they are scene evaluation work and the policy is not
 * flattered by hiding them.
 */
function intersectGridLayerInterval(
  layer: GridLayer,
  ray: Ray,
  index: number,
  opts: MarchOpts,
): LayerHit {
  const field = makeGridTerrain(layer.grid);
  const res = marchInterval(terrainIntervalField(field), ray.origin, ray.dir, {
    steps: opts.steps,
    eps: opts.eps,
    maxDist: opts.maxDist,
  });
  if (opts.stats) {
    opts.stats.steps += res.steps;
    opts.stats.evals += res.evals + res.boundQueries;
  }
  if (!isFinite(res.depth) || !res.point) return MISS;
  return terrainLayerHit(layer, field, index, res.depth, res.point);
}

/** Shared terrain hit shaping: cell under the hit point, dominant
 *  slope axis as the side, the layer's color callback. */
function terrainLayerHit(
  layer: GridLayer,
  field: ReturnType<typeof makeGridTerrain>,
  index: number,
  depth: number,
  point: Vec3,
): LayerHit {
  const g = layer.grid;
  const cs = g.cellSize;
  const cellX = Math.min(
    g.width - 1,
    Math.max(0, Math.floor((point[0] - g.origin[0]) / cs)),
  );
  const cellZ = Math.min(
    g.depth - 1,
    Math.max(0, Math.floor((point[2] - g.origin[2]) / cs)),
  );
  const [gx, gz] = field.gradientAt(point[0], point[2]);
  const side: 'x' | 'z' = Math.abs(gx) >= Math.abs(gz) ? 'x' : 'z';
  return {
    depth,
    color: layer.color(cellX, cellZ, side, point),
    kind: 'grid',
    layer: index,
  };
}

/**
 * Integrated emission of one emission layer along a ray segment
 * [0, tMax]: midpoint quadrature on the field module's shared policy
 * (emissionQuadrature), so the compositor and integrateEmission read
 * the same nodes. Radiance = gain * integral of emission(p) tinted
 * per sample. Sample count is added to stats.evals when supplied.
 */
function emissionGlow(
  layer: EmissionLayer,
  ray: Ray,
  tMax: number,
  stats?: MarchStats,
): Vec3 {
  const { step, samples } = emissionQuadrature(layer.field, tMax);
  if (samples === 0) return [0, 0, 0];
  if (stats) stats.evals += samples;
  const gain = layer.gain ?? 1;
  const tint: Vec3 = layer.tint ?? [1, 1, 1];
  const acc: Vec3 = [0, 0, 0];
  for (let i = 0; i < samples; i++) {
    const p = at(ray, (i + 0.5) * step);
    const e = layer.field.emissionAt(p);
    if (e === 0) continue;
    const w = e * step * gain;
    const c = layer.colorAt ? layer.colorAt(p) : tint;
    acc[0] += w * c[0];
    acc[1] += w * c[1];
    acc[2] += w * c[2];
  }
  return acc;
}

function intersectEmissionLayer(
  layer: EmissionLayer,
  ray: Ray,
  index: number,
  opts: MarchOpts,
): LayerHit {
  // Volumetric layers never win depth: standing alone, the hit is the
  // glow integrated to maxDist, reported at depth Infinity (no
  // surface). In marchScene the same integral, bounded by the
  // nearest surface, is added onto that surface's hit instead.
  const color = emissionGlow(layer, ray, opts.maxDist ?? MARCH_MAX_DIST, opts.stats);
  return { depth: Infinity, color, kind: 'emission', layer: index };
}

/** One evaluation pass over every layer; the nearest hit wins. */
export function intersectLayer(
  layer: Layer,
  ray: Ray,
  camPos: Vec3,
  index = 0,
  opts: MarchOpts = {},
): LayerHit {
  switch (layer.kind) {
    case '2d':
      if (opts.stats) opts.stats.evals++;
      return intersectLayer2D(layer, ray, camPos, index);
    case '2.5d':
      if (opts.stats) opts.stats.evals++;
      return intersectLayer25D(layer, ray, camPos, index);
    case '3d': return intersectSolid3D(layer, ray, index, opts);
    case '4d': return intersectField4D(layer, ray, index, opts);
    case 'grid':
      if (opts.stats) opts.stats.evals++;
      return intersectGridLayer(layer, ray, index, opts);
    case 'emission':
      return intersectEmissionLayer(layer, ray, index, opts);
  }
}

/**
 * Composite a full layer stack in depth order. Occlusion falls out of the march.
 *
 * Emission layers are volumetric, so they composite differently: the
 * nearest surface hit is found as usual, then each emission layer's
 * radiance is integrated along the ray only as far as that surface
 * (emission behind the nearest surface is occluded) and added to the
 * hit color. With no surface hit, a nonzero total glow returns as a
 * hit of kind 'emission' at depth Infinity; zero total glow returns
 * the clean miss, so a zero-intensity emission layer leaves every
 * hit bit-identical, and a stack with no emission layer runs the
 * original path untouched.
 */
export function marchScene(
  layers: Layer[],
  ray: Ray,
  camPos: Vec3,
  opts: MarchOpts = {},
): LayerHit {
  let best: LayerHit = MISS;
  const glowLayers: Array<{ layer: EmissionLayer; index: number }> = [];
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (l.kind === 'emission') {
      glowLayers.push({ layer: l, index: i });
      continue;
    }
    const h = intersectLayer(l, ray, camPos, i, opts);
    if (h.depth < best.depth) best = h;
  }
  if (glowLayers.length === 0) return best;
  const maxDist = opts.maxDist ?? MARCH_MAX_DIST;
  const tEnd = Math.min(best.depth, maxDist);
  const glow: Vec3 = [0, 0, 0];
  for (const g of glowLayers) {
    const c = emissionGlow(g.layer, ray, tEnd, opts.stats);
    glow[0] += c[0];
    glow[1] += c[1];
    glow[2] += c[2];
  }
  if (best.depth === Infinity) {
    if (glow[0] === 0 && glow[1] === 0 && glow[2] === 0) return MISS;
    return { depth: Infinity, color: glow, kind: 'emission', layer: glowLayers[0].index };
  }
  return {
    depth: best.depth,
    color: [best.color[0] + glow[0], best.color[1] + glow[1], best.color[2] + glow[2]],
    kind: best.kind,
    layer: best.layer,
  };
}

// ---------------------------------------------------------------------------
// Discrete gameplay layers: plane stacks the player hops between
// ---------------------------------------------------------------------------

export interface PlaneStack {
  /** Ordered by depth; the player inhabits one plane at a time. */
  planes: Layer25D[];
}

export interface PlayerOnPlanes {
  plane: number;
  uv: Vec2; // in-plane position; untouched by hops
}

/** Hop between gameplay planes: a pure depth translation of the player. */
export function hopPlane(stack: PlaneStack, s: PlayerOnPlanes, dir: 1 | -1): PlayerOnPlanes {
  const n = stack.planes.length;
  const plane = Math.min(n - 1, Math.max(0, s.plane + dir));
  return { plane, uv: [s.uv[0], s.uv[1]] };
}

/**
 * Hop the character between gameplay planes: a pure depth translation of
 * the character itself, not a camera trick and not just an index change.
 * The character position moves by exactly the planes' center separation
 * (for axis-aligned stacks, a pure z translation of the depth-tag
 * separation; hopDistance is its magnitude). Velocity, grounded state and
 * the in-plane uv are untouched: translation only. A clamped hop (already
 * at the end of the stack) moves nothing.
 */
export function hopCharacterPlane(
  stack: PlaneStack,
  st: CharacterState,
  s: PlayerOnPlanes,
  dir: 1 | -1,
): PlayerOnPlanes {
  const next = hopPlane(stack, s, dir);
  if (next.plane === s.plane) return next; // clamped: no motion
  const from = stack.planes[s.plane];
  const to = stack.planes[next.plane];
  st.pos[0] += to.center[0] - from.center[0];
  st.pos[1] += to.center[1] - from.center[1];
  st.pos[2] += to.center[2] - from.center[2];
  return next;
}

/** World-space distance covered by a hop: the planes' depth separation. */
export function hopDistance(stack: PlaneStack, from: number, to: number): number {
  return Math.abs(stack.planes[to].depth - stack.planes[from].depth);
}

/** Solid content at a plane uv: the per-plane collision query. */
export function planeContentAt(stack: PlaneStack, plane: number, uv: Vec2): boolean {
  return stack.planes[plane].content(uv).dist <= 0;
}

// ---------------------------------------------------------------------------
// Inverse rendering is uniform across dimensions: one Gauss-Newton fit
// ---------------------------------------------------------------------------

function solveDense(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    }
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-300;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-300));
}

export interface FitOpts {
  iters?: number;
  /** Plain-path damping (only used with robust: 'l2'). */
  lambda?: number;
  tol?: number;
  /**
   * Robust cost for the fit. Default 'gm': IRLS Geman-McClure with
   * per-iteration MAD scale re-estimation (src/inverse/robust.ts),
   * warm-started from theta0. 'huber' selects Huber IRLS. 'l2' selects
   * the original plain damped Gauss-Newton.
   */
  robust?: 'gm' | 'huber' | 'l2';
  /** GM tuning constant (default 3.0). */
  gmC?: number;
  /** Noise floor for the MAD robust scale (default 1e-6). */
  sigmaFloor?: number;
}

export interface FitResult {
  theta: number[];
  iters: number;
  finalCost: number;
}

/**
 * Dimension-uniform fit, now on the robust cost machinery.
 *
 * Default (robust: 'gm'): IRLS Gauss-Newton under the Geman-McClure cost
 * with per-iteration MAD scale re-estimation and backtracking, using
 * central-difference Jacobians (the engine FD convention) and
 * warm-started from theta0: each IRLS stage continues from the previous
 * iterate, so a refit from a nearby solution converges in a few steps.
 * On clean data GM matches plain Gauss-Newton; on outlier-contaminated
 * observations it redescends the gross residuals instead of being pulled
 * by them. The forward model carries the dimensionality; the solver never
 * sees it: a 2D tint and a 3D light azimuth are both just entries of theta.
 *
 * robust: 'l2' keeps the original plain damped Gauss-Newton on
 * 1/2 ||render(theta) - y||^2, for baselines and exact reproducibility.
 * finalCost is always the plain 1/2 ||r||^2 at the solution, so robust
 * and plain fits compare on the same scale.
 *
 * v1.9.2: the gnc option (graduated non-convexity) and the hybrid
 * Huber-then-GM path were removed, falsified by the owner's write-up
 * (40-43% fail on the hard case vs 7% for warm-start direct GM). An
 * unknown robust kind now throws instead of falling back silently.
 */
export function fitLayerParams(
  render: (theta: number[]) => number[],
  theta0: number[],
  y: number[],
  opts: FitOpts = {},
): FitResult {
  const kind = opts.robust ?? 'gm';
  // v1.9.2: an unknown robust kind is a rejection, not a fallback.
  // (The falsified gm-gnc / huber>gm hybrid paths were removed outright;
  // silently treating them as GM would hide a stale caller.)
  if (kind !== 'gm' && kind !== 'huber' && kind !== 'l2') {
    throw new Error(`fitLayerParams: unknown robust kind '${kind}'`);
  }
  if (kind === 'l2') return fitPlainDampedGN(render, theta0, y, opts);
  const jac = (th: number[]): number[][] => finiteJacobian(render, th);
  const irlsOpts = {
    kind,
    c: opts.gmC ?? 3.0,
    maxIt: opts.iters ?? 40,
    tol: opts.tol ?? 1e-5,
    sigmaFloor: opts.sigmaFloor ?? 1e-6,
  };
  const r = irlsGnFit(y, theta0, render, jac, irlsOpts);
  const yh = render(r.theta);
  let cost = 0;
  for (let i = 0; i < y.length; i++) cost += 0.5 * (yh[i] - y[i]) ** 2;
  return { theta: r.theta, iters: r.iters, finalCost: cost };
}

/** The original plain damped Gauss-Newton (v1.8.0 behavior, kept for 'l2'). */
function fitPlainDampedGN(
  render: (theta: number[]) => number[],
  theta0: number[],
  y: number[],
  opts: FitOpts,
): FitResult {
  const iters = opts.iters ?? 25;
  const lambda = opts.lambda ?? 1e-3;
  const tol = opts.tol ?? 1e-8;
  const n = theta0.length;
  let theta = theta0.slice();
  let cost = Infinity;
  let done = 0;
  for (let it = 0; it < iters; it++) {
    const r = render(theta).map((v, i) => v - y[i]);
    cost = 0.5 * r.reduce((s, v) => s + v * v, 0);
    const J = finiteJacobian(render, theta);
    const m = r.length;
    // A = J^T J + lambda I, g = J^T r
    const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const g = new Array(n).fill(0);
    for (let i = 0; i < m; i++) {
      for (let a = 0; a < n; a++) {
        g[a] += J[i][a] * r[i];
        for (let b = 0; b < n; b++) A[a][b] += J[i][a] * J[i][b];
      }
    }
    for (let a = 0; a < n; a++) A[a][a] += lambda;
    const step = solveDense(A, g);
    const norm = Math.sqrt(step.reduce((s, v) => s + v * v, 0));
    theta = theta.map((v, i) => v - step[i]);
    done = it + 1;
    if (norm < tol) break;
  }
  return { theta, iters: done, finalCost: cost };
}
