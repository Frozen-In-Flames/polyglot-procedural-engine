// Unit tests for the pure engine core (runs in node, no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v3, add3, cross3, norm3, len3 } from '../src/math/vec.js';
import { identity, multiply, perspective, lookAt, transformPoint } from '../src/math/mat.js';
import { fromAxisAngle, toMat4, qIdentity } from '../src/math/quat.js';
import { SceneNode } from '../src/scene/node.js';
import { sphere, plane } from '../src/geo/parametric.js';
import { terrain } from '../src/geo/terrain.js';
import { fbm2 } from '../src/geo/rng.js';
import { buildMaterial, FRAGMENT_TEMPLATE } from '../src/material/shader.js';

test('vec: cross and normalize', () => {
  const c = cross3([1, 0, 0], [0, 1, 0]);
  assert.deepEqual([...c], [0, 0, 1]);
  const n = norm3([0, 3, 4]);
  assert.ok(Math.abs(len3(n) - 1) < 1e-6);
  assert.deepEqual([...add3(v3(1, 2, 3), v3(4, 5, 6))], [5, 7, 9]);
});

test('mat: identity multiply', () => {
  const a = identity();
  a[12] = 5;
  const b = multiply(a, identity());
  assert.equal(b[12], 5);
  assert.equal(b[0], 1);
});

test('mat: perspective projects forward point into NDC', () => {
  const p = perspective(Math.PI / 2, 1, 0.1, 100);
  const v = transformPoint(p, [0, 0, -1]);
  assert.ok(Math.abs(v[0]) < 1e-6 && Math.abs(v[1]) < 1e-6);
  assert.ok(v[2] > -1 && v[2] < 1);
});

test('mat: lookAt moves eye to origin', () => {
  const m = lookAt([0, 0, 5], [0, 0, 0], [0, 1, 0]);
  const v = transformPoint(m, [0, 0, 5]);
  assert.ok(Math.abs(v[0]) < 1e-6 && Math.abs(v[1]) < 1e-6 && Math.abs(v[2]) < 1e-6);
});

test('quat: 90deg about Y maps +X to -Z', () => {
  const q = fromAxisAngle([0, 1, 0], Math.PI / 2);
  const m = toMat4(q);
  const v = transformPoint(m, [1, 0, 0]);
  assert.ok(Math.abs(v[0]) < 1e-6 && Math.abs(v[1]) < 1e-6 && Math.abs(v[2] + 1) < 1e-6);
});

test('quat: identity is identity matrix', () => {
  const m = toMat4(qIdentity());
  assert.ok(Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[15] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9);
});

test('scene: child world matrix composes with parent', () => {
  const parent = new SceneNode('p').setPosition(2, 0, 0);
  const child = new SceneNode('c').setPosition(1, 0, 0);
  parent.addChild(child);
  parent.updateWorldMatrix(null);
  assert.equal(child.worldMatrix[12], 3);
  assert.equal(parent.worldMatrix[12], 2);
});

test('scene: dirty propagates to children', () => {
  const parent = new SceneNode('p');
  const child = new SceneNode('c').setPosition(1, 0, 0);
  parent.addChild(child);
  parent.updateWorldMatrix(null);
  parent.setPosition(10, 0, 0);
  parent.updateWorldMatrix(null);
  assert.equal(child.worldMatrix[12], 11);
});

test('geo: sphere has expected topology', () => {
  const s = sphere(1, 24, 16);
  assert.equal(s.positions.length / 3, 25 * 17);
  assert.equal(s.indices.length, 24 * 16 * 6);
  assert.equal(s.generatedBy, 'TypeScript');
  const p = plane(2, 4);
  assert.equal(p.positions.length / 3, 25);
});

test('geo: terrain grid + normals are unit-ish', () => {
  const t = terrain({ size: 10, segments: 8, height: 2, sampler: (x, z) => fbm2(x * 0.2, z * 0.2, 7) });
  assert.equal(t.positions.length / 3, 81);
  for (let i = 0; i < 81; i += 9) {
    const nx = t.normals[i * 3], ny = t.normals[i * 3 + 1], nz = t.normals[i * 3 + 2];
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    assert.ok(Math.abs(l - 1) < 1e-4, `normal ${i} len ${l}`);
  }
});

test('material: snippets compose into a valid template', () => {
  const m = buildMaterial({ baseColor: [0.2, 0.4, 0.8], effects: ['noise', 'fresnel', 'grid', 'heightRamp', 'pulse'] });
  assert.ok(m.helpers.includes('xg_noise'));
  assert.ok(m.body.includes('vec3 albedo'));
  assert.ok(m.body.includes('fr'));
  const src = FRAGMENT_TEMPLATE(m.helpers, m.body);
  const mainIdx = src.indexOf('void main()');
  assert.ok(mainIdx > 0);
  assert.ok(src.indexOf('vec3 albedo', mainIdx) > mainIdx, 'albedo declared inside main');
  assert.ok(src.indexOf('xg_noise', mainIdx) < 0 || src.indexOf('float xg_noise') < mainIdx, 'helpers at file scope');
});
