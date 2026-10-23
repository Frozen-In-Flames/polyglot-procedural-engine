// scene/city.ts - inverse city import (v3.1.0).
//
// A user loads a REAL city file (GeoJSON building footprints and
// streets, the shape an OpenStreetMap export produces, or this
// engine's own small layout JSON). The converter fits the file
// ONCE into a CitySpec: a compact bundle of fitted parameters and
// distributions. After the fit the source file is discarded. The
// spec is the only thing retained, and it is all the engine ever
// keeps: zero asset dependence extended to user content. Other
// engines store your mesh; this one stores only the math that
// regenerates it.
//
// What the fit keeps (the math): the extent, the building count
// and density, the footprint area and aspect distributions, the
// height distribution, the orientation field summary (a histogram
// over long-axis directions plus a coherence), the radial density
// profile and its fitted falloff exponent, and street structure
// parameters (total length density, the grid spacing it implies,
// mean street width). What it never keeps: a single source
// coordinate. No footprint polygon, no street polyline, no
// building position is copied into the spec. The retention test
// in the suite walks the serialized spec and asserts exactly
// that, structurally.
//
// Fidelity contract, stated plainly: regeneration from a spec
// produces a procedural SIBLING of the source city, a new city
// carrying the same statistical and structural DNA (the
// distributions and profiles above, graded by the statistics
// oracle in test/city-import.test.ts). It is not a copy: no
// source building stands where it stood, and none should. A user
// who needs the original city needs the original file, which is
// theirs to keep; what they hand the engine, the engine reads
// once and lets go.
//
// Blending: specs fitted from different cities pool into one
// mixture spec (blendCitySpecs): distributions merge as weighted
// mixtures over the union of their bin edges, scalar parameters
// pool by the same weights. The blend regenerates a city that is
// none of the sources and carries their shared DNA. Blends
// operate only on retained specs; the source files are long gone
// by then, which is the point.
//
// Regeneration goes through the engine's own stacks: cityLayers
// exposes the built city as a Solid3D SDF layer for marchScene,
// and cityToGrid rasterizes it into a GridWorld the terrain
// distance field (v2.0.3) marches, the same fast path the Living
// World demo renders through.
//
// Honest limits: footprint orientation and aspect come from a PCA
// on each polygon's vertices (exact for the rectangular stock
// that dominates real cities, approximate for L-shaped plans);
// the street spacing is a grid-model estimate from total street
// length (L/A = 2/s), not a measured block survey; buildings in a
// regeneration may overlap where the fitted distributions say
// their lots collide, because the spec carries statistics, not a
// cadastral map.
import { Pcg32 } from '../math/determinism.js';
import type { Vec3 } from '../math/vec.js';
import { makeGrid, type GridWorld } from './grid.js';
import type { Layer } from './layers.js';

/** CitySpec format version. Specs blend only within a version. */
export const CITY_SPEC_VERSION = 1;

/** Radial rings in the fitted density profile. */
export const CITY_RADIAL_RINGS = 6;

// Canonical histogram bin edges for fitted specs. Regen stats are
// measured against the reference spec's own edges, so these edges
// only need to resolve the distributions honestly.
export const CITY_AREA_EDGES = [0, 150, 300, 550, 900, 1400, 2100, 3000, 4500, 7000];
export const CITY_ASPECT_EDGES = [1, 1.25, 1.6, 2.1, 2.8, 3.8, 5.2];
export const CITY_HEIGHT_EDGES = [0, 6, 10, 15, 22, 32, 45, 65, 90, 130];
export const CITY_ORIENTATION_BINS = 12;

/** Height assumed when a footprint carries no height data (m). */
export const CITY_DEFAULT_HEIGHT_M = 10;
/** Meters per building level when only `building:levels` is given. */
export const CITY_METERS_PER_LEVEL = 3.2;

const R_EARTH = 6371000;
const M_PER_DEG_LAT = (Math.PI * R_EARTH) / 180;

/** A probability histogram: bin edges (n+1) and weights (n), summing to 1. */
export interface HistogramFit {
  edges: number[];
  weights: number[];
}

/** The retained math of one city. See the module header for the contract. */
export interface CitySpec {
  version: number;
  name: string;
  origin: 'fit' | 'layout' | 'blend';
  /** Source spec names, for blends. */
  parents?: string[];
  /** Bounding extent of the source city, meters. */
  extentM: { width: number; depth: number };
  buildingCount: number;
  densityPerKm2: number;
  /** Exact fitted first moments (from raw values at fit time). */
  areaMean: number;
  heightMean: number;
  footprintArea: HistogramFit;
  footprintAspect: HistogramFit;
  height: HistogramFit;
  orientation: {
    bins: number;
    /** Probability per bin over [0, pi). */
    weights: number[];
    /** Center of the dominant bin, radians in [0, pi). */
    dominantRad: number;
    /** 0 = uniform over directions, 1 = a single direction. */
    coherence: number;
  };
  /** Density ratio per radial ring (Chebyshev rings over the
   *  normalized extent), normalized so the ring ratios average 1. */
  radialProfile: number[];
  /** Least-squares slope of ln(density ratio) against ring radius. */
  densityExponent: number;
  streets: {
    present: boolean;
    /** Street length per unit area, km per km^2. */
    lengthDensityPerKm: number;
    /** Grid-model spacing implied by the length density, meters. */
    meanSpacingM: number;
    widthM: number;
  };
}

export interface BuiltBuilding {
  /** Center, meters from the extent center (x east, z south). */
  x: number;
  z: number;
  /** Footprint size: w along the orientation axis, d across it. */
  w: number;
  d: number;
  height: number;
  /** Long-axis orientation, radians in [0, pi). */
  angle: number;
}

export interface BuiltCity {
  name: string;
  seed: number;
  extentM: { width: number; depth: number };
  buildings: BuiltBuilding[];
}

export interface CityStats {
  count: number;
  densityPerKm2: number;
  areaWeights: number[];
  aspectWeights: number[];
  heightWeights: number[];
  orientationWeights: number[];
  radialProfile: number[];
  areaMean: number;
  heightMean: number;
}

export interface CityTolerances {
  areaL1: number;
  heightL1: number;
  orientationL1: number;
  meanRelErr: number;
}

export const CITY_DEFAULT_TOLERANCES: CityTolerances = {
  areaL1: 0.3,
  heightL1: 0.3,
  orientationL1: 0.35,
  meanRelErr: 0.12,
};

export interface CityCheck {
  pass: boolean;
  failures: string[];
  areaL1: number;
  heightL1: number;
  orientationL1: number;
  /** Worst radial-ring deviation, raw ratio units. */
  radialMaxErr: number;
  countErr: number;
}

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

/** Index of the bin holding v (clamped into the outer bins). */
function binIndex(edges: number[], v: number): number {
  let lo = 0;
  let hi = edges.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (v < edges[mid]) hi = mid;
    else lo = mid;
  }
  return lo;
}

function histogramOf(values: number[], edges: number[]): HistogramFit {
  const weights = new Array(edges.length - 1).fill(0);
  for (const v of values) weights[binIndex(edges, v)] += 1;
  const total = values.length || 1;
  return { edges: [...edges], weights: weights.map((w) => w / total) };
}

/** Bin center of bin i: the plain midpoint, every bin. */
function binCenter(h: HistogramFit, i: number): number {
  return (h.edges[i] + h.edges[i + 1]) / 2;
}

/** Mean of a histogram under the within-bin uniform convention
 *  (mass at bin centers). Fitted specs also carry exact means;
 *  this estimator is what mixtures and hand-written specs use. */
export function specMean(h: HistogramFit): number {
  let m = 0;
  for (let i = 0; i < h.weights.length; i++) m += h.weights[i] * binCenter(h, i);
  return m;
}

const sum = (a: number[]): number => a.reduce((s, v) => s + v, 0);

/** Re-express a histogram on a new edge set, distributing each
 *  bin's mass over the bins it overlaps, proportional to overlap
 *  (the within-bin uniform convention). */
function rebinHistogram(h: HistogramFit, edges: number[]): HistogramFit {
  const out = new Array(edges.length - 1).fill(0);
  for (let i = 0; i < h.weights.length; i++) {
    const a = h.edges[i];
    const b = h.edges[i + 1];
    const w = h.weights[i];
    if (w === 0) continue;
    for (let j = 0; j < edges.length - 1; j++) {
      const lo = Math.max(a, edges[j]);
      const hi = Math.min(b, edges[j + 1]);
      if (hi > lo) out[j] += (w * (hi - lo)) / (b - a);
    }
  }
  const t = sum(out) || 1;
  return { edges: [...edges], weights: out.map((v) => v / t) };
}

function unionEdges(a: number[], b: number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

// ---------------------------------------------------------------------------
// Sampling (stratified: per-attribute quantiles, shuffled)
// ---------------------------------------------------------------------------

/** n stratified quantiles in (0, 1), deterministically shuffled.
 *  Stratification pins each sampled histogram to within one count
 *  of its target at every bin, which is what lets the statistics
 *  oracle run at honest tolerances instead of sampling-noise ones. */
function stratifiedQuantiles(rng: Pcg32, n: number): number[] {
  const q = new Array<number>(n);
  for (let i = 0; i < n; i++) q[i] = (i + rng.unit()) / n;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng.unit() * (i + 1));
    [q[i], q[j]] = [q[j], q[i]];
  }
  return q;
}

/** Map a quantile through a histogram's inverse CDF. */
function invertHistogram(h: HistogramFit, q: number): number {
  let cum = 0;
  for (let i = 0; i < h.weights.length; i++) {
    const w = h.weights[i];
    if (w <= 0) continue;
    if (q <= cum + w || i === h.weights.length - 1) {
      const frac = Math.min(1, Math.max(0, (q - cum) / w));
      const lo = h.edges[i];
      return lo + frac * (h.edges[i + 1] - lo);
    }
    cum += w;
  }
  return h.edges[h.edges.length - 1];
}

function sampleHistogram(h: HistogramFit, rng: Pcg32, n: number): number[] {
  return stratifiedQuantiles(rng, n).map((q) => invertHistogram(h, q));
}

/** Sample an orientation in [0, pi) from bin weights, stratified. */
function sampleOrientations(
  bins: number,
  weights: number[],
  rng: Pcg32,
  n: number,
): number[] {
  const edges = Array.from({ length: bins + 1 }, (_, i) => (i * Math.PI) / bins);
  return sampleHistogram({ edges, weights }, rng, n);
}

// ---------------------------------------------------------------------------
// Source parsing (the one read of the user's file)
// ---------------------------------------------------------------------------

interface Footprint {
  /** Centroid in the spec frame (x east, z south), meters,
   *  recentered on the extent center before the fit returns. */
  cx: number;
  cz: number;
  area: number;
  aspect: number;
  /** Long-axis orientation in [0, pi), spec frame. */
  angle: number;
  height: number;
}

interface StreetSeg {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  width: number;
}

function shoelace(pts: Array<[number, number]>): { area: number; cx: number; cy: number } {
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const cross = x1 * y2 - x2 * y1;
    a2 += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  return { area: Math.abs(a2) / 2, cx: cx / (3 * a2), cy: cy / (3 * a2) };
}

/** PCA long axis + extents of a polygon given in (x, north) meters. */
function pcaFrame(
  pts: Array<[number, number]>,
  cx: number,
  cy: number,
): { angleNorth: number; w: number; d: number } {
  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (const [x, y] of pts) {
    cxx += (x - cx) * (x - cx);
    cyy += (y - cy) * (y - cy);
    cxy += (x - cx) * (y - cy);
  }
  let a = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  if (a < 0) a += Math.PI;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  let mnU = Infinity;
  let mxU = -Infinity;
  let mnV = Infinity;
  let mxV = -Infinity;
  for (const [x, y] of pts) {
    const dx = x - cx;
    const dy = y - cy;
    const u = dx * ca + dy * sa;
    const v = -dx * sa + dy * ca;
    if (u < mnU) mnU = u;
    if (u > mxU) mxU = u;
    if (v < mnV) mnV = v;
    if (v > mxV) mxV = v;
  }
  return { angleNorth: a, w: mxU - mnU, d: mxV - mnV };
}

function numOr(v: unknown, fallback: number): number {
  const n =
    typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function heightOf(props: Record<string, unknown> | undefined): number {
  if (!props) return CITY_DEFAULT_HEIGHT_M;
  const h = numOr(props.height, NaN);
  if (Number.isFinite(h) && h > 0 && h < 2000) return h;
  const levels = numOr(props['building:levels'], NaN);
  if (Number.isFinite(levels) && levels > 0) {
    return levels * CITY_METERS_PER_LEVEL;
  }
  return CITY_DEFAULT_HEIGHT_M;
}

interface ParsedCity {
  footprints: Footprint[];
  streets: StreetSeg[];
  extentM: { width: number; depth: number };
  layout: boolean;
}

/** Clip a segment to the extent rect (Liang-Barsky); meters of
 *  length inside, 0 when fully outside. */
function clippedLength(
  s: StreetSeg,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): number {
  let t0 = 0;
  let t1 = 1;
  const dx = s.x2 - s.x1;
  const dz = s.z2 - s.z1;
  const p = [-dx, dx, -dz, dz];
  const q = [s.x1 - minX, maxX - s.x1, s.z1 - minZ, maxZ - s.z1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return 0;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return 0;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return 0;
        if (r < t1) t1 = r;
      }
    }
  }
  return Math.hypot(dx, dz) * (t1 - t0);
}

function parseGeoJson(doc: Record<string, unknown>): ParsedCity {
  // Collect features from FeatureCollection / Feature / bare geometry.
  let features: Array<Record<string, unknown>> = [];
  if (doc.type === 'FeatureCollection' && Array.isArray(doc.features)) {
    features = doc.features as Array<Record<string, unknown>>;
  } else if (doc.type === 'Feature') {
    features = [doc];
  } else if (typeof doc.type === 'string' && 'coordinates' in doc) {
    features = [{ type: 'Feature', geometry: doc, properties: {} }];
  }
  // Projection origin: mean of every polygon vertex.
  let lon0 = 0;
  let lat0 = 0;
  let nv = 0;
  const polys: Array<{ ring: Array<[number, number]>; props: any }> = [];
  const lines: Array<{ pts: Array<[number, number]>; props: any }> = [];
  for (const f of features) {
    const geom = (f.geometry ?? null) as Record<string, unknown> | null;
    if (!geom) continue;
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const coords = geom.coordinates as unknown;
    if (geom.type === 'Polygon' && Array.isArray(coords)) {
      const ring = (coords as number[][][])[0].map(
        (c) => [c[0], c[1]] as [number, number],
      );
      polys.push({ ring, props });
      for (const [lon, lat] of ring) {
        lon0 += lon;
        lat0 += lat;
        nv++;
      }
    } else if (geom.type === 'MultiPolygon' && Array.isArray(coords)) {
      for (const poly of coords as number[][][][]) {
        const ring = poly[0].map((c) => [c[0], c[1]] as [number, number]);
        polys.push({ ring, props });
        for (const [lon, lat] of ring) {
          lon0 += lon;
          lat0 += lat;
          nv++;
        }
      }
    } else if (geom.type === 'LineString' && Array.isArray(coords)) {
      lines.push({
        pts: (coords as number[][]).map((c) => [c[0], c[1]] as [number, number]),
        props,
      });
    } else if (geom.type === 'MultiLineString' && Array.isArray(coords)) {
      for (const line of coords as number[][][]) {
        lines.push({
          pts: line.map((c) => [c[0], c[1]] as [number, number]),
          props,
        });
      }
    }
  }
  if (polys.length === 0) {
    throw new Error(
      'fitCitySpec: no building footprints found (expected GeoJSON Polygon features)',
    );
  }
  lon0 /= nv;
  lat0 /= nv;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const toM = (lon: number, lat: number): [number, number] => [
    (lon - lon0) * mPerDegLon,
    -(lat - lat0) * M_PER_DEG_LAT, // z = south
  ];
  const footprints: Footprint[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const { ring, props } of polys) {
    const mPts = ring.map(([lon, lat]) => {
      const [x, z] = toM(lon, lat);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      return [x, -z] as [number, number]; // PCA in (x, north)
    });
    const { area, cx, cy } = shoelace(mPts);
    if (!(area > 0.01)) {
      throw new Error(
        'fitCitySpec: degenerate footprint (zero-area polygon) in the source file',
      );
    }
    const frame = pcaFrame(mPts, cx, cy);
    const long = Math.max(frame.w, frame.d);
    const short = Math.min(frame.w, frame.d);
    // Long-axis angle in the spec frame: the PCA axis in (x, north)
    // maps to (x, z = -north); take the axis direction as-is when
    // the long side follows the PCA axis, or rotated 90 degrees
    // when the long side is the cross axis.
    let angleNorth = frame.angleNorth;
    if (frame.d > frame.w) angleNorth += Math.PI / 2;
    let angle = Math.atan2(Math.sin(angleNorth), Math.cos(angleNorth)) * -1;
    angle = ((angle % Math.PI) + Math.PI) % Math.PI;
    footprints.push({
      cx,
      cz: -cy,
      area,
      aspect: short > 0 ? long / short : 1,
      angle,
      height: heightOf(props),
    });
  }
  const width = maxX - minX;
  const depth = maxZ - minZ;
  if (!(width > 0 && depth > 0)) {
    throw new Error('fitCitySpec: degenerate city extent (zero width or depth)');
  }
  const ccx = (minX + maxX) / 2;
  const ccz = (minZ + maxZ) / 2;
  for (const f of footprints) {
    f.cx -= ccx;
    f.cz -= ccz;
  }
  const streets: StreetSeg[] = [];
  for (const { pts, props } of lines) {
    const w = numOr(props.width, 12);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, z1] = toM(pts[i][0], pts[i][1]);
      const [x2, z2] = toM(pts[i + 1][0], pts[i + 1][1]);
      streets.push({ x1: x1 - ccx, z1: z1 - ccz, x2: x2 - ccx, z2: z2 - ccz, width: w });
    }
  }
  return { footprints, streets, extentM: { width, depth }, layout: false };
}

function parseLayout(doc: Record<string, unknown>): ParsedCity {
  const list = doc.buildings as Array<Record<string, unknown>>;
  const footprints: Footprint[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const b of list) {
    const x = numOr(b.x, NaN);
    const z = numOr(b.z, NaN);
    const w = numOr(b.w, NaN);
    const d = numOr(b.d, NaN);
    const height = numOr(b.height, CITY_DEFAULT_HEIGHT_M);
    if (!(Number.isFinite(x) && Number.isFinite(z) && w > 0 && d > 0)) {
      throw new Error('fitCitySpec: layout buildings need finite x, z and positive w, d');
    }
    let angle = numOr(b.angle, 0);
    angle = ((angle % Math.PI) + Math.PI) % Math.PI;
    footprints.push({
      cx: x,
      cz: z,
      area: w * d,
      aspect: Math.max(w, d) / Math.min(w, d),
      angle,
      height,
    });
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const lx = (sx * w) / 2;
      const lz = (sz * d) / 2;
      const px = x + lx * ca - lz * sa;
      const pz = z + lx * sa + lz * ca;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (pz < minZ) minZ = pz;
      if (pz > maxZ) maxZ = pz;
    }
  }
  const streets: StreetSeg[] = [];
  if (Array.isArray(doc.streets)) {
    for (const s of doc.streets as Array<Record<string, unknown>>) {
      const pts = (s.points as number[][]) ?? [];
      const w = numOr(s.width, 12);
      for (let i = 0; i + 1 < pts.length; i++) {
        streets.push({
          x1: pts[i][0],
          z1: pts[i][1],
          x2: pts[i + 1][0],
          z2: pts[i + 1][1],
          width: w,
        });
      }
    }
  }
  return {
    footprints,
    streets,
    extentM: { width: maxX - minX, depth: maxZ - minZ },
    layout: true,
  };
}

// ---------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------

/** Chebyshev radial ring of a point in the normalized extent. */
function ringOf(x: number, z: number, width: number, depth: number): number {
  const r = Math.max(Math.abs(x) / (width / 2), Math.abs(z) / (depth / 2));
  return Math.min(CITY_RADIAL_RINGS - 1, Math.floor(r * CITY_RADIAL_RINGS));
}

const RING_FRAC = Array.from(
  { length: CITY_RADIAL_RINGS },
  (_, k) => ((k + 1) ** 2 - k ** 2) / CITY_RADIAL_RINGS ** 2,
);

function radialProfileOf(
  pts: Array<{ cx: number; cz: number }>,
  width: number,
  depth: number,
): { profile: number[]; exponent: number } {
  const counts = new Array(CITY_RADIAL_RINGS).fill(0);
  for (const p of pts) counts[ringOf(p.cx, p.cz, width, depth)]++;
  const n = pts.length || 1;
  const profile = counts.map((c, k) => c / n / RING_FRAC[k]);
  const mean = sum(profile) / CITY_RADIAL_RINGS;
  const norm = profile.map((v) => v / (mean || 1));
  // Least-squares slope of ln(ratio) vs ring-center radius.
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let m = 0;
  for (let k = 0; k < CITY_RADIAL_RINGS; k++) {
    if (norm[k] <= 0) continue;
    const x = (k + 0.5) / CITY_RADIAL_RINGS;
    const y = Math.log(norm[k]);
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
    m++;
  }
  const exponent =
    m >= 2 ? (m * sxy - sx * sy) / (m * sxx - sx * sx) : 0;
  return { profile: norm, exponent };
}

function orientationSummary(angles: number[]): CitySpec['orientation'] {
  const bins = CITY_ORIENTATION_BINS;
  const weights = new Array(bins).fill(0);
  for (const a of angles) {
    const bin = Math.min(bins - 1, Math.floor((a / Math.PI) * bins));
    weights[bin] += 1;
  }
  const n = angles.length || 1;
  for (let i = 0; i < bins; i++) weights[i] /= n;
  const dom = weights.indexOf(Math.max(...weights));
  return {
    bins,
    weights,
    dominantRad: ((dom + 0.5) * Math.PI) / bins,
    coherence: (weights[dom] - 1 / bins) / (1 - 1 / bins),
  };
}

/** Fit a city file into its CitySpec. The input is read once here;
 *  nothing in the returned spec is copied geometry (see header).
 *  Throws with a plain-language message on unsupported or
 *  degenerate input. */
export function fitCitySpec(
  input: unknown,
  opts: { name?: string } = {},
): CitySpec {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  ) {
    throw new Error('fitCitySpec: unsupported city input (expected a GeoJSON document or a layout object)');
  }
  const doc = input as Record<string, unknown>;
  const isLayout =
    Array.isArray(doc.buildings) && typeof doc.type !== 'string';
  const parsed = isLayout ? parseLayout(doc) : parseGeoJson(doc);
  const { footprints, streets, extentM } = parsed;
  if (footprints.length === 0) {
    throw new Error('fitCitySpec: no building footprints found');
  }
  const areaM2 = extentM.width * extentM.depth;
  const streetLen = streets.reduce(
    (s, seg) =>
      s +
      clippedLength(
        seg,
        -extentM.width / 2,
        extentM.width / 2,
        -extentM.depth / 2,
        extentM.depth / 2,
      ),
    0,
  );
  const lengthDensityPerKm = (streetLen * 1000) / areaM2;
  const { profile, exponent } = radialProfileOf(
    footprints,
    extentM.width,
    extentM.depth,
  );
  const spec: CitySpec = {
    version: CITY_SPEC_VERSION,
    name: opts.name ?? 'Untitled city',
    origin: parsed.layout ? 'layout' : 'fit',
    extentM,
    buildingCount: footprints.length,
    densityPerKm2: (footprints.length / areaM2) * 1e6,
    areaMean: sum(footprints.map((f) => f.area)) / footprints.length,
    heightMean: sum(footprints.map((f) => f.height)) / footprints.length,
    footprintArea: histogramOf(
      footprints.map((f) => f.area),
      CITY_AREA_EDGES,
    ),
    footprintAspect: histogramOf(
      footprints.map((f) => f.aspect),
      CITY_ASPECT_EDGES,
    ),
    height: histogramOf(
      footprints.map((f) => f.height),
      CITY_HEIGHT_EDGES,
    ),
    orientation: orientationSummary(footprints.map((f) => f.angle)),
    radialProfile: profile,
    densityExponent: exponent,
    streets: {
      present: streets.length > 0,
      lengthDensityPerKm,
      meanSpacingM: streetLen > 0 ? (2 * areaM2) / streetLen : 0,
      widthM:
        streets.length > 0
          ? sum(streets.map((s) => s.width)) / streets.length
          : 0,
    },
  };
  return spec;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateHistogram(h: HistogramFit, label: string): void {
  if (
    !h ||
    !Array.isArray(h.edges) ||
    !Array.isArray(h.weights) ||
    h.edges.length !== h.weights.length + 1 ||
    h.weights.length === 0
  ) {
    throw new Error(`city spec: ${label} histogram is malformed`);
  }
  for (let i = 1; i < h.edges.length; i++) {
    if (!(h.edges[i] > h.edges[i - 1])) {
      throw new Error(`city spec: ${label} histogram edges are not increasing`);
    }
  }
  const t = sum(h.weights);
  if (!h.weights.every((w) => Number.isFinite(w) && w >= 0) || Math.abs(t - 1) > 1e-6) {
    throw new Error(`city spec: ${label} weights must be non-negative and sum to 1 (got ${t})`);
  }
}

/** Structural honesty gate shared by build and blend: a spec that
 *  cannot be sampled from is refused here, never sampled anyway. */
export function validateCitySpec(spec: CitySpec): void {
  if (!spec || typeof spec !== 'object') {
    throw new Error('city spec: not an object');
  }
  if (spec.version !== CITY_SPEC_VERSION) {
    throw new Error(`city spec: unsupported version ${spec.version}`);
  }
  if (
    !(spec.extentM?.width > 0) ||
    !(spec.extentM?.depth > 0) ||
    !Number.isFinite(spec.extentM.width) ||
    !Number.isFinite(spec.extentM.depth)
  ) {
    throw new Error('city spec: extent must be positive and finite');
  }
  if (!Number.isInteger(spec.buildingCount) || spec.buildingCount < 1) {
    throw new Error('city spec: buildingCount must be a positive integer');
  }
  validateHistogram(spec.footprintArea, 'footprintArea');
  validateHistogram(spec.footprintAspect, 'footprintAspect');
  validateHistogram(spec.height, 'height');
  const o = spec.orientation;
  if (
    !o ||
    !Array.isArray(o.weights) ||
    o.weights.length !== o.bins ||
    Math.abs(sum(o.weights) - 1) > 1e-6
  ) {
    throw new Error('city spec: orientation weights must match bins and sum to 1');
  }
  if (
    !Array.isArray(spec.radialProfile) ||
    spec.radialProfile.length !== CITY_RADIAL_RINGS ||
    !spec.radialProfile.every((v) => Number.isFinite(v) && v >= 0)
  ) {
    throw new Error('city spec: radialProfile is malformed');
  }
}

// ---------------------------------------------------------------------------
// Regeneration
// ---------------------------------------------------------------------------

/** Regenerate a sibling city from a spec and a seed alone.
 *  Deterministic: the same spec and seed always produce the same
 *  city (grade with cityDigest). Attribute draws are stratified,
 *  so the realized distributions sit within one count of the
 *  spec's targets at every bin; positions are ring-stratified by
 *  the radial profile and snapped to the fitted street spacing
 *  when the snap keeps the building inside its sampled ring. */
export function buildCity(spec: CitySpec, seed: number): BuiltCity {
  validateCitySpec(spec);
  if (!Number.isInteger(seed)) {
    throw new Error(`buildCity: seed must be an integer, got ${seed}`);
  }
  const rng = new Pcg32(seed);
  const n = spec.buildingCount;
  const areas = sampleHistogram(spec.footprintArea, rng, n);
  const aspects = sampleHistogram(spec.footprintAspect, rng, n);
  const heights = sampleHistogram(spec.height, rng, n);
  const angles = sampleOrientations(
    spec.orientation.bins,
    spec.orientation.weights,
    rng,
    n,
  );
  // Ring assignment from the radial profile, stratified.
  const masses = spec.radialProfile.map((r, k) => r * RING_FRAC[k]);
  const massTotal = sum(masses) || 1;
  const ringCdf: number[] = [];
  {
    let c = 0;
    for (const m of masses) {
      c += m / massTotal;
      ringCdf.push(c);
    }
  }
  const ringQs = stratifiedQuantiles(rng, n);
  const spacing =
    spec.streets.present && spec.streets.meanSpacingM >= 20
      ? spec.streets.meanSpacingM
      : 0;
  const buildings: BuiltBuilding[] = [];
  for (let i = 0; i < n; i++) {
    let ring = ringCdf.findIndex((c) => ringQs[i] <= c);
    if (ring < 0) ring = CITY_RADIAL_RINGS - 1;
    const rIn = ring / CITY_RADIAL_RINGS;
    const rOut = (ring + 1) / CITY_RADIAL_RINGS;
    let nx = 0;
    let nz = 0;
    for (let tries = 0; tries < 64; tries++) {
      nx = rng.unit() * 2 - 1;
      nz = rng.unit() * 2 - 1;
      const r = Math.max(Math.abs(nx), Math.abs(nz));
      if (r >= rIn && r < rOut) break;
      if (tries === 63) {
        // Deterministic fallback: place on the ring midline.
        const t = Math.max(rIn + 1e-6, Math.min(rOut - 1e-6, r));
        const s = Math.max(Math.abs(nx), Math.abs(nz)) || 1;
        nx = (nx / s) * t;
        nz = (nz / s) * t;
      }
    }
    let x = nx * (spec.extentM.width / 2);
    let z = nz * (spec.extentM.depth / 2);
    if (spacing > 0) {
      const sx = Math.round(x / spacing) * spacing + (rng.unit() - 0.5) * spacing * 0.5;
      const sz = Math.round(z / spacing) * spacing + (rng.unit() - 0.5) * spacing * 0.5;
      if (
        ringOf(sx, sz, spec.extentM.width, spec.extentM.depth) === ring &&
        Math.abs(sx) < spec.extentM.width / 2 &&
        Math.abs(sz) < spec.extentM.depth / 2
      ) {
        x = sx;
        z = sz;
      }
    }
    const area = areas[i];
    const aspect = Math.max(1, aspects[i]);
    buildings.push({
      x,
      z,
      w: Math.sqrt(area * aspect),
      d: Math.sqrt(area / aspect),
      height: heights[i],
      angle: angles[i],
    });
  }
  return {
    name: spec.name,
    seed,
    extentM: { ...spec.extentM },
    buildings,
  };
}

/** FNV-1a digest of a built city (same construction as the living
 *  world's digest): bit-identical for identical spec and seed. */
export function cityDigest(built: BuiltCity): string {
  const parts: string[] = [
    `name=${built.name}`,
    `seed=${built.seed}`,
    `n=${built.buildings.length}`,
  ];
  for (const b of built.buildings) {
    parts.push(
      [b.x, b.z, b.w, b.d, b.height, b.angle]
        .map((v) => v.toPrecision(17))
        .join(','),
    );
  }
  const s = parts.join('|');
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------
// Measurement and the statistics oracle
// ---------------------------------------------------------------------------

/** Measure a built city against a reference spec's binning. */
export function measureCity(built: BuiltCity, ref: CitySpec): CityStats {
  const bs = built.buildings;
  const n = bs.length || 1;
  const weightsOf = (values: number[], edges: number[]): number[] =>
    histogramOf(values, edges).weights;
  const binWeights = (values: number[], bins: number, max: number): number[] => {
    const w = new Array(bins).fill(0);
    for (const v of values) {
      w[Math.min(bins - 1, Math.floor((v / max) * bins))] += 1;
    }
    return w.map((c) => c / n);
  };
  const { profile } = radialProfileOf(
    bs.map((b) => ({ cx: b.x, cz: b.z })),
    built.extentM.width,
    built.extentM.depth,
  );
  return {
    count: bs.length,
    densityPerKm2: (bs.length / (built.extentM.width * built.extentM.depth)) * 1e6,
    areaWeights: weightsOf(bs.map((b) => b.w * b.d), ref.footprintArea.edges),
    aspectWeights: weightsOf(
      bs.map((b) => Math.max(b.w, b.d) / Math.min(b.w, b.d)),
      ref.footprintAspect.edges,
    ),
    heightWeights: weightsOf(bs.map((b) => b.height), ref.height.edges),
    orientationWeights: binWeights(
      bs.map((b) => b.angle),
      ref.orientation.bins,
      Math.PI,
    ),
    radialProfile: profile,
    areaMean: sum(bs.map((b) => b.w * b.d)) / n,
    heightMean: sum(bs.map((b) => b.height)) / n,
  };
}

/** The statistics oracle: does a measured city reproduce its
 *  spec's fitted distributions? Radial rings carry a per-ring
 *  allowance that widens where the expected building count is
 *  small (an honest Poisson-scale allowance, not a fudge: a ring
 *  expecting two buildings cannot testify to a tenth of a ratio). */
export function checkCityStats(
  spec: CitySpec,
  stats: CityStats,
  tol: CityTolerances = CITY_DEFAULT_TOLERANCES,
): CityCheck {
  const failures: string[] = [];
  const l1Of = (a: number[], b: number[]): number =>
    a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0);
  const areaL1 = l1Of(spec.footprintArea.weights, stats.areaWeights);
  const heightL1 = l1Of(spec.height.weights, stats.heightWeights);
  const orientationL1 = l1Of(spec.orientation.weights, stats.orientationWeights);
  if (areaL1 > tol.areaL1) {
    failures.push(`footprint area histogram L1 ${areaL1.toFixed(3)} exceeds ${tol.areaL1}`);
  }
  if (heightL1 > tol.heightL1) {
    failures.push(`height histogram L1 ${heightL1.toFixed(3)} exceeds ${tol.heightL1}`);
  }
  if (orientationL1 > tol.orientationL1) {
    failures.push(`orientation histogram L1 ${orientationL1.toFixed(3)} exceeds ${tol.orientationL1}`);
  }
  if (stats.count !== spec.buildingCount) {
    failures.push(
      `building count ${stats.count} differs from spec count ${spec.buildingCount}`,
    );
  }
  const specHeightMean = specMean(spec.height);
  if (
    Math.abs(stats.heightMean - specHeightMean) / specHeightMean >
    tol.meanRelErr
  ) {
    failures.push(
      `height mean ${stats.heightMean.toFixed(2)} vs spec ${specHeightMean.toFixed(2)} beyond ${(tol.meanRelErr * 100).toFixed(0)}%`,
    );
  }
  const specAreaMean = specMean(spec.footprintArea);
  if (Math.abs(stats.areaMean - specAreaMean) / specAreaMean > tol.meanRelErr) {
    failures.push(
      `footprint area mean ${stats.areaMean.toFixed(1)} vs spec ${specAreaMean.toFixed(1)} beyond ${(tol.meanRelErr * 100).toFixed(0)}%`,
    );
  }
  let radialMaxErr = 0;
  for (let k = 0; k < CITY_RADIAL_RINGS; k++) {
    const err = Math.abs(spec.radialProfile[k] - stats.radialProfile[k]);
    radialMaxErr = Math.max(radialMaxErr, err);
    const expected = spec.buildingCount * (spec.radialProfile[k] * RING_FRAC[k]);
    const allowance = 0.3 + 1.2 / (expected + 1);
    if (err > allowance) {
      failures.push(
        `radial ring ${k} ratio off by ${err.toFixed(2)} (allowance ${allowance.toFixed(2)})`,
      );
    }
  }
  return {
    pass: failures.length === 0,
    failures,
    areaL1,
    heightL1,
    orientationL1,
    radialMaxErr,
    countErr: Math.abs(stats.count - spec.buildingCount),
  };
}

// ---------------------------------------------------------------------------
// Blending
// ---------------------------------------------------------------------------

/** Pool fitted specs into one mixture spec. Weights default to
 *  each source's building count (pooling the underlying cities);
 *  explicit weights are normalized. Distributions merge as
 *  weighted mixtures over the union of bin edges; scalars pool by
 *  the same weights; the blended count follows from the pooled
 *  density over the blended extent. Operates only on specs: the
 *  source files were discarded at fit time. */
export function blendCitySpecs(specs: CitySpec[], weights?: number[]): CitySpec {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error('blendCitySpecs: at least one spec is required');
  }
  for (const s of specs) validateCitySpec(s);
  if (specs.some((s) => s.version !== specs[0].version)) {
    throw new Error('blendCitySpecs: cannot blend specs of different versions');
  }
  if (specs.some((s) => s.orientation.bins !== specs[0].orientation.bins)) {
    throw new Error('blendCitySpecs: orientation bin counts differ');
  }
  let w: number[];
  if (weights === undefined) {
    w = specs.map((s) => s.buildingCount);
  } else {
    if (weights.length !== specs.length) {
      throw new Error(
        `blendCitySpecs: weights length ${weights.length} does not match ${specs.length} specs`,
      );
    }
    w = [...weights];
  }
  if (w.some((v) => !(v > 0)) || !w.every(Number.isFinite)) {
    throw new Error('blendCitySpecs: weights must be positive and finite');
  }
  const wTotal = sum(w);
  const wn = w.map((v) => v / wTotal);
  const pool = (f: (s: CitySpec) => number): number =>
    specs.reduce((acc, s, i) => acc + wn[i] * f(s), 0);
  const mixHist = (pick: (s: CitySpec) => HistogramFit): HistogramFit => {
    let edges = pick(specs[0]).edges;
    for (const s of specs) edges = unionEdges(edges, pick(s).edges);
    const out = new Array(edges.length - 1).fill(0);
    specs.forEach((s, i) => {
      const rebinned = rebinHistogram(pick(s), edges);
      rebinned.weights.forEach((v, j) => {
        out[j] += wn[i] * v;
      });
    });
    const t = sum(out) || 1;
    return { edges, weights: out.map((v) => v / t) };
  };
  const width = pool((s) => s.extentM.width);
  const depth = pool((s) => s.extentM.depth);
  const density = pool((s) => s.densityPerKm2);
  const orientationWeights = specs[0].orientation.weights.map((_, bin) =>
    pool((s) => s.orientation.weights[bin]),
  );
  const oTotal = sum(orientationWeights) || 1;
  const oWeights = orientationWeights.map((v) => v / oTotal);
  const dom = oWeights.indexOf(Math.max(...oWeights));
  const bins = specs[0].orientation.bins;
  const profileRaw = Array.from({ length: CITY_RADIAL_RINGS }, (_, k) =>
    pool((s) => s.radialProfile[k]),
  );
  const profileMean = sum(profileRaw) / CITY_RADIAL_RINGS || 1;
  const lengthDensity = pool((s) => s.streets.lengthDensityPerKm);
  return {
    version: CITY_SPEC_VERSION,
    name: specs.map((s) => s.name).join(' + '),
    origin: 'blend',
    parents: specs.map((s) => s.name),
    extentM: { width, depth },
    buildingCount: Math.max(1, Math.round((density * width * depth) / 1e6)),
    densityPerKm2: density,
    areaMean: pool((s) => s.areaMean),
    heightMean: pool((s) => s.heightMean),
    footprintArea: mixHist((s) => s.footprintArea),
    footprintAspect: mixHist((s) => s.footprintAspect),
    height: mixHist((s) => s.height),
    orientation: {
      bins,
      weights: oWeights,
      dominantRad: ((dom + 0.5) * Math.PI) / bins,
      coherence: (oWeights[dom] - 1 / bins) / (1 - 1 / bins),
    },
    radialProfile: profileRaw.map((v) => v / profileMean),
    densityExponent: pool((s) => s.densityExponent),
    streets: {
      present: specs.some((s) => s.streets.present),
      lengthDensityPerKm: lengthDensity,
      meanSpacingM: lengthDensity > 0 ? 2000 / lengthDensity : 0,
      widthM: pool((s) => s.streets.widthM),
    },
  };
}

// ---------------------------------------------------------------------------
// Engine-stack composition
// ---------------------------------------------------------------------------

function boxSdf(b: BuiltBuilding, p: Vec3): number {
  const dx = p[0] - b.x;
  const dz = p[2] - b.z;
  const ca = Math.cos(b.angle);
  const sa = Math.sin(b.angle);
  const lx = dx * ca + dz * sa;
  const lz = -dx * sa + dz * ca;
  const qx = Math.abs(lx) - b.w / 2;
  const qy = Math.abs(p[1] - b.height / 2) - b.height / 2;
  const qz = Math.abs(lz) - b.d / 2;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const oz = Math.max(qz, 0);
  return (
    Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0)
  );
}

const CITY_LIGHT: Vec3 = (() => {
  const l = Math.hypot(-0.4, 0.8, 0.45);
  return [-0.4 / l, 0.8 / l, 0.45 / l];
})();

/** The built city as engine layers: one Solid3D whose field is the
 *  ground plane unioned with every building box, shaded by height
 *  under the engine's usual demo light. March it with marchScene. */
export function cityLayers(built: BuiltCity): Layer[] {
  const maxH = Math.max(1, ...built.buildings.map((b) => b.height));
  const sdf = (p: Vec3): number => {
    let d = p[1];
    for (const b of built.buildings) {
      const bd = boxSdf(b, p);
      if (bd < d) d = bd;
    }
    return d;
  };
  const layer: Layer = {
    kind: '3d',
    sdf,
    shade: (p: Vec3, n: Vec3): Vec3 => {
      const lam = Math.max(
        0,
        n[0] * CITY_LIGHT[0] + n[1] * CITY_LIGHT[1] + n[2] * CITY_LIGHT[2],
      );
      const s = 0.32 + 0.68 * lam;
      // Near the ground plane and not on a box: street surface.
      let onBox = false;
      for (const b of built.buildings) {
        if (boxSdf(b, p) <= 0.02) {
          onBox = true;
          break;
        }
      }
      if (!onBox && p[1] <= 0.02) return [0.14 * s, 0.14 * s, 0.16 * s];
      const t = Math.min(1, p[1] / maxH);
      return [
        (0.35 + 0.45 * t) * s,
        (0.38 + 0.4 * t) * s,
        (0.48 + 0.3 * t) * s,
      ];
    },
  };
  return [layer];
}

/** Rasterize a built city into a GridWorld of per-cell heights
 *  (the tallest building covering each cell center), ready for
 *  makeGridTerrain: the demo's fast render path, and the same
 *  field the suite raycasts. Ground cells carry height 0. */
export function cityToGrid(built: BuiltCity, cellSize: number): GridWorld {
  const W = Math.max(1, Math.ceil(built.extentM.width / cellSize));
  const D = Math.max(1, Math.ceil(built.extentM.depth / cellSize));
  const heights = new Float64Array(W * D);
  const grid = makeGrid(W, D, {
    cellSize,
    origin: [-built.extentM.width / 2, 0, -built.extentM.depth / 2],
    height: 0,
    heights,
  });
  grid.cells.fill(1);
  for (let j = 0; j < D; j++) {
    for (let i = 0; i < W; i++) {
      const x = -built.extentM.width / 2 + (i + 0.5) * cellSize;
      const z = -built.extentM.depth / 2 + (j + 0.5) * cellSize;
      let h = 0;
      for (const b of built.buildings) {
        const dx = x - b.x;
        const dz = z - b.z;
        const ca = Math.cos(b.angle);
        const sa = Math.sin(b.angle);
        const lx = dx * ca + dz * sa;
        const lz = -dx * sa + dz * ca;
        if (Math.abs(lx) <= b.w / 2 && Math.abs(lz) <= b.d / 2 && b.height > h) {
          h = b.height;
        }
      }
      heights[j * W + i] = h;
    }
  }
  grid.heights = heights;
  return grid;
}
