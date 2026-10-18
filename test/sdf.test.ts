// Unit tests for the SDF math library (runs in node, no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evalSdf, sdfDist, marchRay, sdfNormal, sdfToGlsl, collectUniforms,
  hash3, valueNoise3, fbm3, lipschitzBound,
  SDF_EPS, SDF_MAX_DIST, SDF_MAX_STEPS, SDF_OMEGA,
  type SdfNode,
} from '../src/math/sdf.js';

test('sdf: sphere distances are exact', () => {
  const s: SdfNode = { kind: 'sphere', r: 1 };
  assert.equal(sdfDist(s, [1, 0, 0]), 0);
  assert.equal(sdfDist(s, [0, 0, 0]), -1);
  assert.ok(Math.abs(sdfDist(s, [0, 3, 4]) - 4) < 1e-9);
});

test('sdf: box distance at face and corner', () => {
  const b: SdfNode = { kind: 'box', b: [1, 1, 1] };
  assert.ok(Math.abs(sdfDist(b, [2, 0, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(sdfDist(b, [0, 0, 0]) + 1) < 1e-9);
});

test('sdf: plane distance', () => {
  const p: SdfNode = { kind: 'plane', n: [0, 1, 0], h: 0 };
  assert.equal(sdfDist(p, [5, 2, -3]), 2);
});

test('sdf: union takes the minimum', () => {
  const u: SdfNode = {
    kind: 'union',
    children: [
      { kind: 'sphere', r: 1, c: [-2, 0, 0] },
      { kind: 'sphere', r: 1, c: [2, 0, 0] },
    ],
  };
  assert.ok(sdfDist(u, [0, 0, 0]) > 0);
  assert.ok(Math.abs(sdfDist(u, [-2, 0, 0]) + 1) < 1e-9);
});

test('sdf: smooth union never exceeds hard union', () => {
  const su: SdfNode = {
    kind: 'smoothUnion', k: 0.5,
    children: [
      { kind: 'sphere', r: 1, c: [-0.8, 0, 0] },
      { kind: 'sphere', r: 1, c: [0.8, 0, 0] },
    ],
  };
  const hard: SdfNode = {
    kind: 'union',
    children: [
      { kind: 'sphere', r: 1, c: [-0.8, 0, 0] },
      { kind: 'sphere', r: 1, c: [0.8, 0, 0] },
    ],
  };
  for (const p of [[0, 0, 0], [0, 0.5, 0], [-0.8, 0.9, 0]] as const) {
    assert.ok(sdfDist(su, [p[0], p[1], p[2]]) <= sdfDist(hard, [p[0], p[1], p[2]]) + 1e-9);
  }
});

test('sdf: subtract carves the hole', () => {
  const s: SdfNode = {
    kind: 'subtract',
    a: { kind: 'sphere', r: 2 },
    b: { kind: 'sphere', r: 1 },
  };
  assert.ok(sdfDist(s, [0, 0, 0]) > 0);
  assert.ok(Math.abs(sdfDist(s, [0, 0, 1.5]) + 0.5) < 1e-9);
});

test('sdf: repeat is periodic', () => {
  const r: SdfNode = {
    kind: 'repeat',
    c: [4, 0, 4],
    child: { kind: 'sphere', r: 1 },
  };
  const a = sdfDist(r, [0, 0, 0]);
  const b = sdfDist(r, [4, 0, 0]);
  const c = sdfDist(r, [0, 0, -8]);
  assert.ok(Math.abs(a - b) < 1e-9 && Math.abs(a - c) < 1e-9);
});

test('sdf: twist with k=0 is identity', () => {
  const t: SdfNode = { kind: 'twist', k: 0, child: { kind: 'sphere', r: 1 } };
  const s: SdfNode = { kind: 'sphere', r: 1 };
  assert.ok(Math.abs(sdfDist(t, [1, 2, 3]) - sdfDist(s, [1, 2, 3])) < 1e-9);
});

test('sdf: uniforms override plain values', () => {
  const s: SdfNode = { kind: 'sphere', r: { uniform: 'uR' } };
  assert.ok(Math.abs(sdfDist(s, [3, 0, 0], { uR: 1 }) - 2) < 1e-9);
  assert.ok(Math.abs(sdfDist(s, [3, 0, 0], { uR: 2 }) - 1) < 1e-9);
  assert.deepEqual([...collectUniforms(s)].sort(), ['uR']);
});

test('sdf: noise is deterministic and bounded', () => {
  const a = valueNoise3(1.7, 2.3, 0.5, 42);
  const b = valueNoise3(1.7, 2.3, 0.5, 42);
  assert.equal(a, b);
  assert.ok(a >= 0 && a <= 1);
  const f = fbm3(1.7, 2.3, 0.5, 42);
  assert.ok(f >= 0 && f <= 1);
  assert.ok(Math.abs(hash3(1, 2, 3, 9) - hash3(1, 2, 3, 9)) === 0);
});

test('sdf: marchRay hits the analytic sphere surface', () => {
  const s: SdfNode = { kind: 'sphere', r: 1 };
  const m = marchRay(s, [0, 0, 5], [0, 0, -1]);
  assert.ok(m.hit);
  assert.ok(Math.abs(m.dist - 4) < 1e-2);
  assert.ok(m.steps < SDF_MAX_STEPS);
});

test('sdf: marchRay returns depth AND normal on hit', () => {
  const s: SdfNode = { kind: 'sphere', r: 1 };
  const m = marchRay(s, [0, 0, 5], [0, 0, -1]);
  assert.ok(m.hit);
  assert.ok(m.normal !== null);
  // Hit point is near [0,0,1]; normal points outward (+z).
  assert.ok(Math.abs(m.normal![2] - 1) < 1e-3);
  assert.ok(Math.abs(m.normal![0]) < 1e-3 && Math.abs(m.normal![1]) < 1e-3);
  const miss = marchRay(s, [0, 0, 5], [0, 1, 0], {}, { maxDist: 10 });
  assert.ok(!miss.hit && miss.normal === null);
});

test('sdf: exponential smin tends to min() as k grows', () => {
  const u: SdfNode = {
    kind: 'smoothUnion',
    k: 200,
    children: [
      { kind: 'sphere', r: 1, c: [-0.5, 0, 0] },
      { kind: 'sphere', r: 1, c: [0.5, 0, 0] },
    ],
  };
  const p: [number, number, number] = [0, 0.9, 0];
  const soft = evalSdf(u, p).d;
  const d1 = evalSdf({ kind: 'sphere', r: 1, c: [-0.5, 0, 0] }, p).d;
  const d2 = evalSdf({ kind: 'sphere', r: 1, c: [0.5, 0, 0] }, p).d;
  assert.ok(Math.abs(soft - Math.min(d1, d2)) < 1e-2);
  assert.ok(soft <= Math.min(d1, d2) + 1e-9);
});

test('sdf: marchRay misses cleanly past max distance', () => {
  const s: SdfNode = { kind: 'sphere', r: 1 };
  const m = marchRay(s, [0, 0, 5], [0, 1, 0], {}, { maxDist: 10 });
  assert.ok(!m.hit);
  assert.ok(m.dist >= 10);
});

test('sdf: spec constants are documented and sane', () => {
  assert.equal(SDF_EPS, 1e-3);
  assert.equal(SDF_MAX_DIST, 100);
  assert.equal(SDF_MAX_STEPS, 128);
});

test('sdf: normal of sphere points outward', () => {
  const s: SdfNode = { kind: 'sphere', r: 1 };
  const n = sdfNormal(s, [1, 0, 0]);
  assert.ok(Math.abs(n[0] - 1) < 1e-3 && Math.abs(n[1]) < 1e-3 && Math.abs(n[2]) < 1e-3);
});

test('sdf: material ids propagate', () => {
  const u: SdfNode = {
    kind: 'union',
    children: [
      { kind: 'sphere', r: 1, c: [-2, 0, 0], mat: 3 },
      { kind: 'sphere', r: 1, c: [2, 0, 0], mat: 5 },
    ],
  };
  assert.equal(evalSdf(u, [-2, 0, 0]).mat, 3);
  assert.equal(evalSdf(u, [2, 0, 0]).mat, 5);
});

test('sdf: glsl codegen emits map() with helpers and uniforms', () => {
  const node: SdfNode = {
    kind: 'smoothUnion',
    k: { uniform: 'uBlendK' },
    children: [
      { kind: 'sphere', r: { uniform: 'uR' }, mat: 1 },
      { kind: 'box', b: [1, 1, 1], mat: 2 },
    ],
  };
  const { glsl, uniforms } = sdfToGlsl(node);
  assert.ok(glsl.includes('vec2 map(vec3 p)'));
  assert.ok(glsl.includes('sdf_smin'));
  assert.ok(glsl.includes('uniform float uBlendK;'));
  assert.ok(glsl.includes('uniform float uR;'));
  assert.deepEqual(uniforms, ['uBlendK', 'uR']);
});

test('sdf: glsl codegen is deterministic', () => {
  const node: SdfNode = { kind: 'torus', R: 2, r: 0.5 };
  assert.equal(sdfToGlsl(node).glsl, sdfToGlsl(node).glsl);
});

test('sdf: under-relaxed march converges where omega=1 tunnels (twisted slab)', () => {
  // Twist stretches the domain (local Lipschitz ~1 + |k| * radius), so the
  // field overestimates and a full step jumps clean over this thin slab.
  // omega = 0.85 shrinks every step and the march converges instead.
  // The omega=1 case needs the explicit unsafe opt-in: without it, omega
  // clamps to 1/L and the march is safe by construction.
  const f: SdfNode = { kind: 'twist', k: 2.0, child: { kind: 'box', b: [2, 0.06, 2] } };
  const ro: [number, number, number] = [3.20398, -2.605153, 0.466583];
  const rd: [number, number, number] = [-0.409412, 0.905501, 0.111582];
  const tunneled = marchRay(f, ro, rd, {}, { omega: 1.0, maxSteps: 600, allowUnsafeOmega: true });
  assert.equal(tunneled.hit, false);
  const relaxed = marchRay(f, ro, rd, {}, { omega: 0.85, maxSteps: 600 });
  assert.equal(relaxed.hit, true);
  assert.ok(relaxed.dist < 10);
});

test('sdf: omega clamps to 1/L without the unsafe opt-in', () => {
  const f: SdfNode = { kind: 'twist', k: 2.0, child: { kind: 'box', b: [2, 0.06, 2] } };
  const ro: [number, number, number] = [3.20398, -2.605153, 0.466583];
  const rd: [number, number, number] = [-0.409412, 0.905501, 0.111582];
  // L = 1 * (1 + 2*8) = 17, so 1/L < 0.06: the clamped march is safe.
  const safe = marchRay(f, ro, rd, {}, { omega: 1.0, maxSteps: 600 });
  assert.equal(safe.hit, true);
});

test('sdf: default omega is 1/L from the Lipschitz bound', () => {
  const s: SdfNode = { kind: 'sphere', r: 1 };
  // L = 1 for a sphere, so the default march uses omega = 1.
  const a = marchRay(s, [0, 0, 5], [0, 0, -1]);
  const b = marchRay(s, [0, 0, 5], [0, 0, -1], {}, { omega: 1 });
  assert.ok(a.hit && b.hit);
  assert.equal(a.steps, b.steps);
  // An explicit tighter omega still works (and stepScale stays an alias).
  const c = marchRay(s, [0, 0, 5], [0, 0, -1], {}, { stepScale: 0.85 });
  assert.ok(c.hit && c.steps > a.steps);
  assert.equal(SDF_OMEGA, 0.85);
});

test('sdf: marchRay asserts unit-length ray direction', () => {
  const s: SdfNode = { kind: 'sphere', r: 1 };
  assert.throws(() => marchRay(s, [0, 0, 5], [0, 0, -2]), /unit length/);
});

test('sdf: lipschitzBound composes per-operator bounds', () => {
  const s: SdfNode = { kind: 'sphere', r: 1 };
  assert.equal(lipschitzBound(s), 1);
  const u: SdfNode = { kind: 'union', children: [s, { kind: 'box', b: [1, 1, 1] }] };
  assert.equal(lipschitzBound(u), 1);
  const tw: SdfNode = { kind: 'twist', k: 2.0, child: s };
  assert.equal(lipschitzBound(tw, {}, { extent: 8 }), 17);
  const d: SdfNode = { kind: 'displace', amp: 0.5, freq: 1.0, seed: 7, child: s };
  const ld = lipschitzBound(d);
  assert.ok(ld > 1 && Number.isFinite(ld));
});
