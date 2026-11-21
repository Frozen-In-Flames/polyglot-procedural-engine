// test/deadramp-import.test.ts - the DeadRamp Base catalog door.
// The exported build record at demo/public/deadramp/accounting-l2.json
// (exported from data/base-catalog.json in the deadramp-base
// repository) must convert into the city layout form, fit with
// fitCitySpec, and regenerate with buildCity under the suite's own
// statistics oracle. Degenerate records are rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitCitySpec, buildCity, measureCity, checkCityStats } from '../src/scene/city.js';
import { layoutFromDeadRampBuild, type DeadRampBuildRecord } from '../src/scene/deadramp.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const record = JSON.parse(
  readFileSync(join(ROOT, 'demo/public/deadramp/accounting-l2.json'), 'utf8'),
) as DeadRampBuildRecord;

test('deadramp: the exported record is the accounting-l2 build', () => {
  assert.equal(record.groupDir, 'accounting-l2');
  assert.equal(record.manifest.length, 8);
  assert.ok(record.manifest.every((m) => /^[0-9a-f]{64}$/.test(m.sha256)));
});

test('deadramp: record converts, fits, and regenerates under the stats oracle', () => {
  const layout = layoutFromDeadRampBuild(record);
  assert.equal(layout.buildings.length, record.manifest.length);
  const spec = fitCitySpec(layout, { name: `DeadRamp ${record.groupDir}` });
  assert.equal(spec.buildingCount, record.manifest.length);
  const built = buildCity(spec, 20261121);
  const check = checkCityStats(spec, measureCity(built, spec));
  assert.ok(check.pass, `regen failures: ${check.failures.join('; ')}`);
});

test('deadramp: degenerate records are rejected', () => {
  assert.throws(
    () => layoutFromDeadRampBuild({ ...record, manifest: [] }),
    /no manifest entries/,
  );
  assert.throws(
    () =>
      layoutFromDeadRampBuild({
        ...record,
        manifest: [{ path: 'x.py', bytes: 0, sha256: '0'.repeat(64) }],
      }),
    /no positive byte count/,
  );
});
