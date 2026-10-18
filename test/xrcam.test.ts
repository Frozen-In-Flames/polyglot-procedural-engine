import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eyeRay, reprojectPoint, type EyeFov,
} from '../src/xr/camera.js';
import { reprojectRotationOnly, type Mat3 } from '../src/render/foveation.js';
import type { Vec3 } from '../src/math/vec.js';

const FOV: EyeFov = { tanL: -0.8, tanR: 0.8, tanD: -0.8, tanU: 0.8 };
const IPD = 0.064;

test('xr: eye ray at center looks down -z, eye origins offset by IPD', () => {
  const L = eyeRay(FOV, IPD, 'left', 0, 0);
  const R = eyeRay(FOV, IPD, 'right', 0, 0);
  assert.ok(Math.abs(L.origin[0] + IPD / 2) < 1e-12);
  assert.ok(Math.abs(R.origin[0] - IPD / 2) < 1e-12);
  assert.ok(Math.abs(L.dir[2] + 1) < 1e-12);
  const l = Math.hypot(L.dir[0], L.dir[1], L.dir[2]);
  assert.ok(Math.abs(l - 1) < 1e-12);
});

test('xr: identity pose change gives x\' = x exactly (up to homogeneous scale)', () => {
  const I3: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const K: Mat3 = [[500, 0, 320], [0, 500, 240], [0, 0, 1]];
  const x: Vec3 = [0.4, -0.2, 1];
  const o: Vec3 = [0, 0, 0];
  const xp = reprojectPoint(x, K, I3, o, K, I3, o, 2.5);
  // Homogeneous: xp = (t/|d|) x, so normalize by the third component.
  assert.ok(Math.abs(xp[0] / xp[2] - x[0] / x[2]) < 1e-12);
  assert.ok(Math.abs(xp[1] / xp[2] - x[1] / x[2]) < 1e-12);
});

test('xr: pure rotation matches the rotation-only formula', () => {
  const ang = 0.1;
  const c = Math.cos(ang), s = Math.sin(ang);
  const R: Mat3 = [[c, -s, 0], [s, c, 0], [0, 0, 1]]; // new orientation
  const Rinv: Mat3 = [[c, s, 0], [-s, c, 0], [0, 0, 1]]; // its inverse
  const I3: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const K: Mat3 = [[500, 0, 320], [0, 500, 240], [0, 0, 1]];
  const x: Vec3 = [0.3, 0.1, 1];
  const o: Vec3 = [0, 0, 0];
  const a = reprojectPoint(x, K, I3, o, K, R, o, 3.0);
  const b = reprojectRotationOnly(x, K, Rinv);
  // Both are homogeneous; compare up to scale.
  const s1 = b[2] / a[2];
  assert.ok(Math.abs(a[0] * s1 - b[0]) < 1e-9);
  assert.ok(Math.abs(a[1] * s1 - b[1]) < 1e-9);
});
