// test/city-import.test.ts - v3.1.0 "Inverse city import": real
// city files in, only the math kept, sibling cities out.
//
// The claim under test is the retention contract of the whole
// feature: a city file (GeoJSON footprints + streets, or the
// engine's own layout JSON) is fitted ONCE into a CitySpec, a
// compact bundle of fitted parameters and distributions. The spec
// is the only thing retained; it must not contain the source's
// geometry. A builder then regenerates a NEW city from the spec
// and a seed alone: a procedural sibling of the source (same
// statistical and structural DNA), never a mesh copy. Specs blend:
// blendCitySpecs pools fitted distributions into a mixture spec
// whose regenerated city is none of the sources.
//
// Oracles and negative controls, each pinned to fail if the
// machinery it grades is removed or lied to:
//   - an independent fit oracle: the test recomputes footprint
//     areas, heights and orientations from the fixture polygons
//     with its own shoelace/PCA code and compares against the fit.
//   - the statistics oracle (checkCityStats): a regenerated city
//     must reproduce its spec's distributions within tolerance.
//     It is itself controlled: stats from a corrupted build must
//     FAIL it, or the oracle is decoration.
//   - determinism: same spec + same seed, identical digest.
//   - a spatially shuffled fixture (footprints rotated 90 degrees
//     and heights re-paired) must fit to a measurably different
//     spec; a blend with the shuffled spec must shift measurably
//     against the unshuffled blend.
//   - degenerate inputs (empty, streets-only, zero-area) are
//     rejected with clear errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fitCitySpec,
  blendCitySpecs,
  buildCity,
  measureCity,
  checkCityStats,
  cityDigest,
  cityLayers,
  cityToGrid,
  specMean,
  CITY_RADIAL_RINGS,
  type CitySpec,
  type HistogramFit,
} from '../src/scene/city.js';
import { marchScene, type Ray } from '../src/scene/layers.js';
import {
  makeGridTerrain,
  raycastTerrain,
} from '../src/scene/terrain-field.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(ROOT, 'test/fixtures', name), 'utf8'));

const CITY_A = loadFixture('city-a.geojson');
const CITY_B = loadFixture('city-b.geojson');

// ---------------------------------------------------------------------------
// Independent oracle helpers (written for the test, not imported
// from the module under test): shoelace area and PCA long axis on
// the raw fixture polygons, in a local meter projection.
// ---------------------------------------------------------------------------
const R_EARTH = 6371000;
const M_PER_DEG_LAT = (Math.PI * R_EARTH) / 180;

interface PolyInfo {
  area: number;
  height: number;
  angle: number; // long-axis orientation, [0, pi)
  cx: number;
  cy: number; // centroid, meters east/north of the fixture mean
}

function independentPolys(doc: any): PolyInfo[] {
  const feats = doc.features.filter(
    (f: any) => f.geometry?.type === 'Polygon',
  );
  let lon0 = 0;
  let lat0 = 0;
  let nv = 0;
  for (const f of feats) {
    for (const [lon, lat] of f.geometry.coordinates[0]) {
      lon0 += lon;
      lat0 += lat;
      nv++;
    }
  }
  lon0 /= nv;
  lat0 /= nv;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const out: PolyInfo[] = [];
  for (const f of feats) {
    const ring = f.geometry.coordinates[0].slice(0, -1);
    const pts = ring.map(([lon, lat]: number[]) => [
      (lon - lon0) * mPerDegLon,
      (lat - lat0) * M_PER_DEG_LAT,
    ]);
    let area2 = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      const cross = x1 * y2 - x2 * y1;
      area2 += cross;
      cx += (x1 + x2) * cross;
      cy += (y1 + y2) * cross;
    }
    const area = Math.abs(area2) / 2;
    cx /= 3 * area2;
    cy /= 3 * area2;
    let cxx = 0;
    let cyy = 0;
    let cxy = 0;
    for (const [x, y] of pts) {
      cxx += (x - cx) * (x - cx);
      cyy += (y - cy) * (y - cy);
      cxy += (x - cx) * (y - cy);
    }
    let angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    if (angle < 0) angle += Math.PI;
    out.push({
      area,
      height: Number(f.properties?.height ?? 0),
      angle,
      cx,
      cy,
    });
  }
  return out;
}

const l1 = (a: number[], b: number[]): number =>
  a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);

const SEED = 31007;

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------
test('city fit: fixture A fits to the independent oracle', () => {
  const spec = fitCitySpec(CITY_A, { name: 'Fixture A' });
  const polys = independentPolys(CITY_A as any);
  assert.strictEqual(spec.buildingCount, polys.length);
  assert.strictEqual(spec.origin, 'fit');
  const areaMean = polys.reduce((s, p) => s + p.area, 0) / polys.length;
  const fitAreaMean = spec.areaMean;
  assert.ok(
    Math.abs(fitAreaMean - areaMean) / areaMean <= 0.02,
    `area mean fit ${fitAreaMean} vs oracle ${areaMean}`,
  );
  const heightMean =
    polys.reduce((s, p) => s + p.height, 0) / polys.length;
  const fitHeightMean = spec.heightMean;
  assert.ok(
    Math.abs(fitHeightMean - heightMean) / heightMean <= 0.02,
    `height mean fit ${fitHeightMean} vs oracle ${heightMean}`,
  );
  // Density is positive and the extent wraps the footprints.
  assert.ok(spec.densityPerKm2 > 100, `density ${spec.densityPerKm2}`);
  assert.ok(spec.extentM.width > 300 && spec.extentM.depth > 250);
  // Streets: present, and the fitted spacing is the same order as
  // the fixture's 84 m block pitch (grid estimator, documented).
  assert.ok(spec.streets.present);
  assert.ok(
    spec.streets.meanSpacingM > 40 && spec.streets.meanSpacingM < 130,
    `spacing ${spec.streets.meanSpacingM}`,
  );
  // Orientation: fixture A's grid is rotated -8 degrees and its
  // buildings elongate along the block-depth axis (grid + 90 = 82
  // degrees in east/north), which is 98 degrees in the spec frame
  // (z = -north): bin 6 of 12. Measured on the fitted spec:
  // weights[6] = 0.76, coherence 0.73.
  const w = spec.orientation.weights;
  const dom = w.indexOf(Math.max(...w));
  assert.strictEqual(dom, 6, `dominant orientation bin ${dom}`);
  assert.ok(spec.orientation.coherence > 0.3, `coherence ${spec.orientation.coherence}`);
  // Radial profile is normalized (ring ratios average to 1).
  const profMean =
    spec.radialProfile.reduce((s, v) => s + v, 0) / CITY_RADIAL_RINGS;
  assert.ok(Math.abs(profMean - 1) <= 1e-9, `profile mean ${profMean}`);
});

test('city fit: engine layout JSON fits the same way', () => {
  const layout = {
    buildings: [
      { x: 0, z: 0, w: 20, d: 14, height: 30, angle: 0.3 },
      { x: 40, z: 10, w: 16, d: 16, height: 12 },
      { x: -35, z: -20, w: 26, d: 10, height: 22, angle: 1.2 },
    ],
  };
  const spec = fitCitySpec(layout, { name: 'Layout' });
  assert.strictEqual(spec.buildingCount, 3);
  assert.ok(Math.abs(specMean(spec.height) - 64 / 3) <= 2);
  assert.ok(spec.extentM.width >= 66 && spec.extentM.depth >= 30);
  // And the layout-fitted spec regenerates and passes its oracle.
  const built = buildCity(spec, SEED);
  const check = checkCityStats(spec, measureCity(built, spec));
  assert.ok(check.pass, `layout regen failures: ${check.failures.join('; ')}`);
});

test('city fit: degenerate inputs are rejected with clear errors', () => {
  assert.throws(
    () => fitCitySpec({ type: 'FeatureCollection', features: [] }),
    /no building footprints/,
  );
  assert.throws(
    () =>
      fitCitySpec({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { highway: 'residential' },
            geometry: {
              type: 'LineString',
              coordinates: [[0, 0], [1, 1]],
            },
          },
        ],
      }),
    /no building footprints/,
  );
  assert.throws(() => fitCitySpec(null), /unsupported city input/);
  assert.throws(
    () =>
      fitCitySpec({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { height: 9 },
            geometry: {
              type: 'Polygon',
              coordinates: [[[10, 10], [10, 10], [10, 10], [10, 10]]],
            },
          },
        ],
      }),
    /degenerate/,
  );
});

// ---------------------------------------------------------------------------
// Retention contract
// ---------------------------------------------------------------------------
test('city spec: retains no source geometry (the discard contract)', () => {
  const spec = fitCitySpec(CITY_A, { name: 'Fixture A' });
  const json = JSON.stringify(spec);
  // No fixture coordinate values survive into the spec: sample raw
  // lon/lat strings straight out of the fixture file.
  const raw = JSON.stringify(CITY_A);
  for (const probe of ['-97.7431', '30.2672', '-97.7315', '30.2580']) {
    if (raw.includes(probe)) {
      assert.ok(!json.includes(probe), `spec leaked coordinate ${probe}`);
    }
  }
  // Structural: no nested coordinate arrays anywhere. A polygon
  // ring is an array of [number, number] pairs of length >= 3;
  // the spec may hold flat number arrays (histograms) and pairs
  // (extent), never a list of pairs.
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      const isPairList =
        v.length >= 3 &&
        v.every(
          (e) =>
            Array.isArray(e) &&
            e.length === 2 &&
            e.every((n) => typeof n === 'number'),
        );
      assert.ok(!isPairList, `pair list (geometry?) at ${path}`);
      v.forEach((e, i) => walk(e, `${path}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [k, e] of Object.entries(v)) walk(e, `${path}.${k}`);
    }
  };
  walk(spec, 'spec');
});

// ---------------------------------------------------------------------------
// Regeneration: statistics oracle + determinism
// ---------------------------------------------------------------------------
test('city regen: statistics oracle passes on both fixtures', () => {
  for (const [doc, nm] of [[CITY_A, 'A'], [CITY_B, 'B']] as const) {
    const spec = fitCitySpec(doc, { name: `Fixture ${nm}` });
    const built = buildCity(spec, SEED);
    assert.strictEqual(built.buildings.length, spec.buildingCount);
    const stats = measureCity(built, spec);
    const check = checkCityStats(spec, stats);
    assert.ok(
      check.pass,
      `fixture ${nm} oracle failures: ${check.failures.join('; ')} ` +
        `(areaL1 ${check.areaL1.toFixed(3)}, heightL1 ${check.heightL1.toFixed(3)}, ` +
        `orientL1 ${check.orientationL1.toFixed(3)}, radialMax ${check.radialMaxErr.toFixed(3)})`,
    );
    // Sibling, not copy: no regenerated building center coincides
    // with a source centroid (the fit kept no positions to copy).
    const polys = independentPolys(doc as any);
    // Source centroids live in a north-up frame; the spec frame is
    // z = -north. Compare in spec frame.
    let collisions = 0;
    for (const b of built.buildings) {
      for (const p of polys) {
        if (Math.abs(b.x - p.cx) < 1e-9 && Math.abs(b.z + p.cy) < 1e-9) {
          collisions++;
        }
      }
    }
    assert.strictEqual(collisions, 0, 'regen copied a source position');
  }
});

test('city regen: determinism digest, seed makes a sibling', () => {
  const spec = fitCitySpec(CITY_A, { name: 'Fixture A' });
  const a = buildCity(spec, 4242);
  const b = buildCity(spec, 4242);
  assert.strictEqual(cityDigest(a), cityDigest(b), 'same spec+seed, same city');
  const c = buildCity(spec, 4243);
  assert.notStrictEqual(cityDigest(a), cityDigest(c), 'new seed, new sibling');
  // The sibling still passes the oracle: variation is inside the
  // fitted distributions, not outside them.
  const check = checkCityStats(spec, measureCity(c, spec));
  assert.ok(check.pass, `sibling oracle failures: ${check.failures.join('; ')}`);
});

test('city regen: composes through the engine layer and terrain stacks', () => {
  const spec = fitCitySpec(CITY_A, { name: 'Fixture A' });
  const built = buildCity(spec, SEED);
  const tallest = built.buildings.reduce((m, b) =>
    b.height > m.height ? b : m,
  );
  const origin: [number, number, number] = [
    tallest.x,
    tallest.height + 50,
    tallest.z,
  ];
  const ray: Ray = { origin, dir: [0, -1, 0] };
  const hit = marchScene(cityLayers(built), ray, origin);
  assert.strictEqual(hit.kind, '3d');
  assert.ok(
    Math.abs(hit.depth - 50) <= 0.75,
    `layer march depth ${hit.depth} vs expected 50`,
  );
  const field = makeGridTerrain(cityToGrid(built, 4));
  const tHit = raycastTerrain(field, origin, [0, -1, 0], 200);
  assert.ok(tHit, 'terrain raycast missed the city');
  assert.ok(
    Math.abs(tHit.depth - 50) <= 1.5,
    `terrain depth ${tHit?.depth} vs expected 50`,
  );
  // A ray over empty ground at the extent corner reads the ground
  // plane through the layer stack (depth to y = 0).
  const corner: [number, number, number] = [
    built.extentM.width / 2 - 1,
    80,
    built.extentM.depth / 2 - 1,
  ];
  const gHit = marchScene(cityLayers(built), { origin: corner, dir: [0, -1, 0] }, corner);
  assert.ok(Math.abs(gHit.depth - 80) <= 0.75, `ground depth ${gHit.depth}`);
});

// ---------------------------------------------------------------------------
// Statistics oracle negative control: the oracle must be able to fail
// ---------------------------------------------------------------------------
test('city oracle: corrupted distributions fail the statistics oracle', () => {
  const spec = fitCitySpec(CITY_A, { name: 'Fixture A' });
  const built = buildCity(spec, SEED);
  const stats = measureCity(built, spec);
  // Corrupt the spec: claim every building is in the tallest
  // height bin. The honest regen must now FAIL against it.
  const corrupt: CitySpec = {
    ...spec,
    height: {
      edges: spec.height.edges,
      weights: spec.height.weights.map((_, i, a) =>
        i === a.length - 1 ? 1 : 0,
      ),
    },
  };
  const check = checkCityStats(corrupt, stats);
  assert.strictEqual(check.pass, false, 'oracle waved a corrupted spec through');
  assert.ok(
    check.failures.some((f) => f.includes('height')),
    `failures should name height: ${check.failures.join('; ')}`,
  );
  // Corrupt the count: halve the claimed density of buildings.
  const corruptCount: CitySpec = {
    ...spec,
    buildingCount: Math.floor(spec.buildingCount / 2),
  };
  const check2 = checkCityStats(corruptCount, stats);
  assert.strictEqual(check2.pass, false);
  assert.ok(check2.failures.some((f) => f.includes('count')));
  // And an invalid spec (weights that do not sum to 1) is refused
  // at build time, not silently sampled.
  const invalid: CitySpec = {
    ...spec,
    footprintArea: {
      edges: spec.footprintArea.edges,
      weights: spec.footprintArea.weights.map(() => 0),
    },
  };
  assert.throws(() => buildCity(invalid, SEED), /weights/);
});

// ---------------------------------------------------------------------------
// Shuffle negative control
// ---------------------------------------------------------------------------
test('city fit: a spatially shuffled fixture fits measurably differently', () => {
  const spec = fitCitySpec(CITY_A, { name: 'Fixture A' });
  // Shuffle: rotate every footprint 90 degrees about the fixture
  // centroid in lon/lat space and re-pair heights across the set.
  const doc = JSON.parse(JSON.stringify(CITY_A)) as any;
  const feats = doc.features.filter(
    (f: any) => f.geometry?.type === 'Polygon',
  );
  let lon0 = 0;
  let lat0 = 0;
  let nv = 0;
  for (const f of feats) {
    for (const [lon, lat] of f.geometry.coordinates[0]) {
      lon0 += lon;
      lat0 += lat;
      nv++;
    }
  }
  lon0 /= nv;
  lat0 /= nv;
  const heights = feats.map((f: any) => f.properties.height);
  feats.forEach((f: any, i: number) => {
    f.geometry.coordinates[0] = f.geometry.coordinates[0].map(
      ([lon, lat]: number[]) => [
        lon0 - (lat - lat0),
        lat0 + (lon - lon0),
      ],
    );
    f.properties.height = heights[(i + Math.floor(feats.length / 2)) % feats.length];
  });
  const shuffled = fitCitySpec(doc, { name: 'Fixture A shuffled' });
  const dOrient = l1(spec.orientation.weights, shuffled.orientation.weights);
  assert.ok(
    dOrient >= 0.5,
    `orientation L1 between fit and shuffled fit ${dOrient}`,
  );
  // The regenerated cities differ where the spec differs: the
  // dominant orientation of the shuffled sibling sits in a
  // different bin than the true sibling's.
  const domOf = (s: CitySpec): number => {
    const st = measureCity(buildCity(s, SEED), s);
    return st.orientationWeights.indexOf(Math.max(...st.orientationWeights));
  };
  assert.notStrictEqual(domOf(shuffled), domOf(spec));
});

// ---------------------------------------------------------------------------
// Blending
// ---------------------------------------------------------------------------
function handSpec(over: Partial<CitySpec>): CitySpec {
  const base: CitySpec = {
    version: 1,
    name: 'hand',
    origin: 'fit',
    extentM: { width: 400, depth: 300 },
    buildingCount: 50,
    densityPerKm2: 400,
    areaMean: 100,
    heightMean: 15,
    footprintArea: { edges: [0, 100, 200], weights: [0.5, 0.5] },
    footprintAspect: { edges: [1, 2, 3], weights: [0.5, 0.5] },
    height: { edges: [0, 10, 20], weights: [0.5, 0.5] },
    orientation: {
      bins: 12,
      weights: Array.from({ length: 12 }, (_, i) => (i === 0 ? 1 : 0)),
      dominantRad: 0,
      coherence: 1,
    },
    radialProfile: Array.from({ length: CITY_RADIAL_RINGS }, () => 1),
    densityExponent: 0,
    streets: { present: true, lengthDensityPerKm: 20, meanSpacingM: 100, widthM: 12 },
  };
  return { ...base, ...over };
}

test('city blend: pooled mixture over mismatched histogram edges', () => {
  const x = handSpec({
    name: 'X',
    footprintArea: { edges: [0, 100, 200], weights: [0.5, 0.5] },
  });
  const y = handSpec({
    name: 'Y',
    footprintArea: { edges: [0, 50, 200], weights: [0.2, 0.8] },
  });
  const blend = blendCitySpecs([x, y], [1, 1]);
  assert.strictEqual(blend.origin, 'blend');
  assert.deepStrictEqual(blend.parents, ['X', 'Y']);
  // Mixture mean of the rebinned pool: X mean 100, Y mean 105,
  // equal weights: 102.5 (exact under the within-bin uniform
  // convention both the rebin and specMean use).
  const m = specMean(blend.footprintArea);
  assert.ok(Math.abs(m - 102.5) <= 0.75, `blend area mean ${m}`);
  // Total probability is conserved by the rebin.
  const total = blend.footprintArea.weights.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) <= 1e-9, `blend weights sum ${total}`);
});

test('city blend: Texas blend of two fixtures sits inside the envelope', () => {
  const a = fitCitySpec(CITY_A, { name: 'Fixture A' });
  const b = fitCitySpec(CITY_B, { name: 'Fixture B' });
  const blend = blendCitySpecs([a, b]);
  // Envelope oracle: every blended first moment lies between the
  // sources' moments (a mixture cannot escape the convex hull).
  const between = (v: number, p: number, q: number): boolean =>
    v >= Math.min(p, q) - 1e-9 && v <= Math.max(p, q) + 1e-9;
  assert.ok(
    between(blend.heightMean, a.heightMean, b.heightMean),
    `blend height mean ${blend.heightMean} not between ${a.heightMean} and ${b.heightMean}`,
  );
  assert.ok(between(blend.areaMean, a.areaMean, b.areaMean));
  assert.ok(between(blend.densityPerKm2, a.densityPerKm2, b.densityPerKm2));
  // The blend is a spec like any other: it regenerates, passes its
  // own oracle, and its regenerated height mean stays within the
  // sources' regenerated envelope (statistical DNA from both).
  const regenBlend = measureCity(buildCity(blend, SEED), blend);
  const check = checkCityStats(blend, regenBlend);
  assert.ok(check.pass, `blend oracle failures: ${check.failures.join('; ')}`);
  const regenA = measureCity(buildCity(a, SEED), a);
  const regenB = measureCity(buildCity(b, SEED), b);
  const lo = Math.min(regenA.heightMean, regenB.heightMean);
  const hi = Math.max(regenA.heightMean, regenB.heightMean);
  assert.ok(
    regenBlend.heightMean >= lo * 0.85 && regenBlend.heightMean <= hi * 1.15,
    `blend regen height mean ${regenBlend.heightMean} outside [${lo}, ${hi}]`,
  );
  // A blend of a spec with itself is the spec (mixture identity).
  const self = blendCitySpecs([a, a]);
  assert.ok(Math.abs(self.heightMean - a.heightMean) <= 1e-9);
  assert.ok(Math.abs(specMean(self.height) - specMean(a.height)) <= 1e-9);
  assert.strictEqual(self.buildingCount, a.buildingCount);
});

test('city blend: blending with a shuffled spec shifts the blend (negative control)', () => {
  const a = fitCitySpec(CITY_A, { name: 'Fixture A' });
  const b = fitCitySpec(CITY_B, { name: 'Fixture B' });
  const doc = JSON.parse(JSON.stringify(CITY_A)) as any;
  const feats = doc.features.filter(
    (f: any) => f.geometry?.type === 'Polygon',
  );
  let lon0 = 0;
  let lat0 = 0;
  let nv = 0;
  for (const f of feats) {
    for (const [lon, lat] of f.geometry.coordinates[0]) {
      lon0 += lon;
      lat0 += lat;
      nv++;
    }
  }
  lon0 /= nv;
  lat0 /= nv;
  feats.forEach((f: any) => {
    f.geometry.coordinates[0] = f.geometry.coordinates[0].map(
      ([lon, lat]: number[]) => [lon0 - (lat - lat0), lat0 + (lon - lon0)],
    );
  });
  const shuffled = fitCitySpec(doc, { name: 'Fixture A shuffled' });
  const honest = blendCitySpecs([a, b]);
  const shifted = blendCitySpecs([shuffled, b]);
  const d = l1(honest.orientation.weights, shifted.orientation.weights);
  assert.ok(d >= 0.2, `blend orientation shift ${d}`);
  // Blend validation: mismatched weights and empty input refuse.
  assert.throws(() => blendCitySpecs([a, b], [1]), /weights/);
  assert.throws(() => blendCitySpecs([]), /at least one/);
});
