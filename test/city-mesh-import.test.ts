// test/city-mesh-import.test.ts - v3.2.0 mesh front doors.
//
// OBJ and glTF are new entrances into the v3.1.0 converter, not a
// second converter. Each mesh normalizes to footprint polygons
// and heights, then the same fit, retention contract, statistics
// oracle, blending, and regeneration grade it.
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
  type CitySpec,
} from '../src/scene/city.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const fixtureText = (name: string): string =>
  readFileSync(join(ROOT, 'test/fixtures', name), 'utf8');
const fixtureJson = (name: string): any =>
  JSON.parse(readFileSync(join(ROOT, 'test/fixtures', name), 'utf8'));
const fixtureBytes = (name: string): Uint8Array =>
  readFileSync(join(ROOT, 'test/fixtures', name));

const MODELS = fixtureJson('mesh-models.json');
const OBJ_CITY = fixtureText('mesh-city.obj');
const GLTF_CITY = fixtureJson('mesh-city.gltf');
const GLB_CITY = fixtureBytes('mesh-city.glb');
const CROSS_OBJ = fixtureText('cross-city.obj');
const CROSS_GEOJSON = fixtureJson('cross-city.geojson');
const GEOJSON_A = fixtureJson('city-a.geojson');
const SEED = 31007;

const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;
const l1 = (a: number[], b: number[]): number =>
  a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);
const dominantBin = (spec: CitySpec): number =>
  spec.orientation.weights.indexOf(Math.max(...spec.orientation.weights));

function assertKnownCity(spec: CitySpec, model: any[], expectedBin: number): void {
  assert.strictEqual(spec.buildingCount, model.length);
  const areaMean = mean(model.map((b) => b.area));
  const heightMean = mean(model.map((b) => b.h));
  assert.ok(
    Math.abs(spec.areaMean - areaMean) / areaMean <= 0.005,
    `area mean ${spec.areaMean} vs known ${areaMean}`,
  );
  assert.ok(
    Math.abs(spec.heightMean - heightMean) / heightMean <= 0.005,
    `height mean ${spec.heightMean} vs known ${heightMean}`,
  );
  assert.strictEqual(dominantBin(spec), expectedBin);
  assert.ok(spec.orientation.coherence > 0.9, `coherence ${spec.orientation.coherence}`);
  assert.strictEqual(spec.streets.present, false);
}

function assertRegenOracle(spec: CitySpec): void {
  const built = buildCity(spec, SEED);
  const stats = measureCity(built, spec);
  const check = checkCityStats(spec, stats);
  assert.ok(check.pass, `oracle failures: ${check.failures.join('; ')}`);
  // The fixture buildings are rectangular prisms and every fitted
  // value lands in a histogram bin. Stratified regeneration draws
  // the same bin counts, so these three L1 distances are exact
  // zero apart from floating point summation order.
  assert.ok(check.areaL1 <= 1e-9, `area L1 ${check.areaL1}`);
  assert.ok(check.heightL1 <= 1e-9, `height L1 ${check.heightL1}`);
  assert.ok(check.orientationL1 <= 1e-9, `orientation L1 ${check.orientationL1}`);
}

function assertNoSourceGeometry(spec: CitySpec): void {
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
}

test('mesh fit: OBJ groups fit the known city and pass the statistics oracle', () => {
  const spec = fitCitySpec(OBJ_CITY, { name: 'OBJ fixture city' });
  assertKnownCity(spec, MODELS.obj, 1);
  assertRegenOracle(spec);
  assertNoSourceGeometry(spec);
  assert.ok(!JSON.stringify(spec).includes('-160.604074'), 'OBJ coordinate leaked');
});

test('mesh fit: glTF embedded buffer and GLB fit the same known city', () => {
  const fromJson = fitCitySpec(GLTF_CITY, { name: 'glTF fixture city' });
  const fromGlb = fitCitySpec(GLB_CITY, { name: 'glTF fixture city' });
  assertKnownCity(fromJson, MODELS.gltf, 4);
  assertRegenOracle(fromJson);
  assertNoSourceGeometry(fromJson);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(fromGlb)),
    JSON.parse(JSON.stringify(fromJson)),
    'GLB and embedded glTF are two containers for one city and must fit identically',
  );
});

test('mesh fit: OBJ negative indices and an ungrouped mesh form one building', () => {
  // A 20 by 10 prism, 12 m high. Faces use negative indices, the
  // relative form many OBJ exporters emit.
  const obj = [
    'v -10 0 -5', 'v 10 0 -5', 'v 10 0 5', 'v -10 0 5',
    'v -10 12 -5', 'v 10 12 -5', 'v 10 12 5', 'v -10 12 5',
    'f -8 -5 -6 -7', 'f -4 -1 -2 -3',
    'f -8 -7 -3 -4', 'f -7 -6 -2 -3',
    'f -6 -5 -1 -2', 'f -5 -8 -4 -1',
  ].join('\n');
  const spec = fitCitySpec(obj, { name: 'Relative index prism' });
  assert.strictEqual(spec.buildingCount, 1);
  assert.ok(Math.abs(spec.areaMean - 200) <= 1e-9);
  assert.ok(Math.abs(spec.heightMean - 12) <= 1e-9);
  assert.ok(Math.abs(spec.extentM.width - 20) <= 1e-9);
  assert.ok(Math.abs(spec.extentM.depth - 10) <= 1e-9);
});

test('mesh cross-format: one logical city in GeoJSON and OBJ agrees', () => {
  const geo = fitCitySpec(CROSS_GEOJSON, { name: 'Cross city GeoJSON' });
  const obj = fitCitySpec(CROSS_OBJ, { name: 'Cross city OBJ' });
  assert.strictEqual(obj.buildingCount, MODELS.cross.length);
  assert.strictEqual(geo.buildingCount, obj.buildingCount);
  // Stated tolerance: counts exact, height mean within 0.5 percent,
  // footprint area mean within 1 percent. The area allowance covers
  // the GeoJSON local tangent projection and decimal coordinate
  // rounding; it is not a fit tolerance.
  assert.ok(
    Math.abs(geo.heightMean - obj.heightMean) / obj.heightMean <= 0.005,
    `height means GeoJSON ${geo.heightMean} vs OBJ ${obj.heightMean}`,
  );
  assert.ok(
    Math.abs(geo.areaMean - obj.areaMean) / obj.areaMean <= 0.01,
    `area means GeoJSON ${geo.areaMean} vs OBJ ${obj.areaMean}`,
  );
});

test('mesh blend: an OBJ spec blends and regenerates with a GeoJSON spec', () => {
  const obj = fitCitySpec(OBJ_CITY, { name: 'OBJ fixture city' });
  const geo = fitCitySpec(GEOJSON_A, { name: 'Fixture A' });
  const blend = blendCitySpecs([obj, geo]);
  assert.strictEqual(blend.origin, 'blend');
  assert.deepStrictEqual(blend.parents, ['OBJ fixture city', 'Fixture A']);
  const built = buildCity(blend, SEED);
  const check = checkCityStats(blend, measureCity(built, blend));
  assert.ok(check.pass, `cross-format blend failures: ${check.failures.join('; ')}`);
  assert.ok(check.areaL1 <= 0.3 && check.heightL1 <= 0.3 && check.orientationL1 <= 0.35);
});

test('mesh controls: shuffled vertices move orientation and collapsed heights name height', () => {
  const spec = fitCitySpec(OBJ_CITY, { name: 'OBJ fixture city' });
  const rotated = OBJ_CITY.split('\n').map((line) => {
    if (!line.startsWith('v ')) return line;
    const [, x, y, z] = line.split(/\s+/).map(Number);
    return `v ${z} ${y} ${-x}`;
  }).join('\n');
  const shuffled = fitCitySpec(rotated, { name: 'OBJ fixture city rotated' });
  assert.ok(
    l1(spec.orientation.weights, shuffled.orientation.weights) >= 0.5,
    'rotating every mesh vertex must move the fitted orientation',
  );
  assert.notStrictEqual(dominantBin(shuffled), dominantBin(spec));

  const collapsed = OBJ_CITY.split('\n').map((line) => {
    if (!line.startsWith('v ')) return line;
    const p = line.split(/\s+/);
    return `v ${p[1]} 0 ${p[3]}`;
  }).join('\n');
  assert.throws(() => fitCitySpec(collapsed), /height/);
});

test('mesh controls: empty, garbage, and external-buffer inputs are refused plainly', () => {
  assert.throws(() => fitCitySpec(''), /no vertices|unsupported/);
  assert.throws(() => fitCitySpec('plain text with an obj name'), /no vertices/);
  const external = JSON.parse(JSON.stringify(GLTF_CITY));
  external.buffers[0].uri = 'mesh-city.bin';
  assert.throws(() => fitCitySpec(external), /external buffer/);
  assert.throws(
    () => fitCitySpec(external),
    /binary \.glb|embed the buffer/,
  );
});
