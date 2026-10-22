import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeEmissionField,
  emissionQuadrature,
  integrateEmission,
  type EmissionField,
} from '../src/scene/emission-field.js';
import { evalSdf } from '../src/math/sdf.js';
import {
  marchScene,
  type Layer,
  type Ray,
  type Solid3D,
  type EmissionLayer,
} from '../src/scene/layers.js';
import type { Vec3 } from '../src/math/vec.js';

// Emission field layer (v2.0.8): tokamak-geometry emissivity as a
// first-class analytic scene field. Tests are the spec.
//
// Geometry: core circle (the torus axis ring) of major radius R in the
// XZ plane about the center; a point's normalized minor radius is
// rho = (distance from the core circle) / r. The base profile is the
// peaked tokamak form (1 - rho^2)^alpha on rho < 1, exactly zero
// outside. Toroidal and poloidal factors multiply it.

const R = 3;
const r = 1;

/** Point at (rho, theta, phi) by the inverse coordinate map. */
function pointAt(rho: number, theta: number, phi: number, Rr = R, rr = r): Vec3 {
  const radial = Rr + rr * rho * Math.cos(phi);
  return [
    radial * Math.cos(theta),
    rr * rho * Math.sin(phi),
    radial * Math.sin(theta),
  ];
}

/** Closed-form emission at construction parameters (independent path). */
function closedForm(
  I0: number, alpha: number,
  nTor: number, aTor: number, pTor: number,
  aPol: number, pPol: number,
  rho: number, theta: number, phi: number,
): number {
  if (rho >= 1) return 0;
  return (
    I0 * Math.pow(1 - rho * rho, alpha) *
    (1 + aTor * Math.cos(nTor * theta + pTor)) *
    (1 + aPol * Math.cos(phi + pPol))
  );
}

function baseField(): EmissionField {
  return makeEmissionField({
    majorRadius: R, minorRadius: r, intensity: 2.5, profileExponent: 2,
  });
}

test('emission: closed-form profile on a constructed grid', () => {
  const f = makeEmissionField({
    majorRadius: R, minorRadius: r, intensity: 2.5, profileExponent: 2,
    toroidalMode: 3, toroidalAmp: 0.4, toroidalPhase: 0.3,
    poloidalAmp: 0.25, poloidalPhase: -0.7,
  });
  for (const rho of [0, 0.2, 0.5, 0.8, 0.95, 1, 1.4]) {
    for (const theta of [0, 0.7, 2.1, -1.3, 3.0]) {
      for (const phi of [0, 0.9, -2.0, 3.1]) {
        if (rho === 0) continue; // phi is singular on the axis; pinned separately
        const p = pointAt(rho, theta, phi);
        const want = closedForm(2.5, 2, 3, 0.4, 0.3, 0.25, -0.7, rho, theta, phi);
        const got = f.emissionAt(p);
        assert.ok(
          Math.abs(got - want) <= 1e-12 * Math.max(1, Math.abs(want)),
          `rho=${rho} theta=${theta} phi=${phi}: got ${got}, want ${want}`,
        );
      }
    }
  }
});

test('emission: exterior is exactly zero, boundary is exactly zero', () => {
  const f = baseField();
  for (const rho of [1, 1.000001, 1.5, 3, 40]) {
    for (const theta of [0, 1.1, -2.2]) {
      for (const phi of [0, 1.3, -0.6]) {
        assert.equal(f.emissionAt(pointAt(rho, theta, phi)), 0);
      }
    }
  }
  assert.equal(f.profileAt(1), 0);
  assert.equal(f.profileAt(2), 0);
  assert.equal(f.profileAt(0), 1);
});

test('emission: axis is the maximum, base profile falls monotonically in rho', () => {
  const f = makeEmissionField({
    majorRadius: R, minorRadius: r, intensity: 4, profileExponent: 1.7,
  });
  // Axis value at several toroidal angles is exactly the intensity.
  for (const theta of [0, 0.9, 2.4, -1.8]) {
    assert.equal(f.emissionAt(pointAt(0, theta, 0)), 4);
  }
  let prev = Infinity;
  for (let i = 0; i <= 19; i++) {
    const rho = i * 0.05;
    const e = f.emissionAt(pointAt(rho, 0.7, -0.4));
    assert.ok(e < prev, `not strictly falling at rho=${rho}: ${e} !< ${prev}`);
    assert.ok(e <= 4);
    prev = e;
  }
  // No sampled point anywhere in the tube exceeds the axis value.
  for (let i = 0; i < 40; i++) {
    const rho = (i % 10) / 10;
    const theta = i * 1.7;
    const phi = i * 0.9 - 3;
    assert.ok(f.emissionAt(pointAt(rho, theta, phi)) <= 4);
  }
});

test('emission: continuity across the boundary', () => {
  const f = baseField(); // alpha = 2, I0 = 2.5
  const just = f.emissionAt(pointAt(1 - 1e-6, 0.3, 0.8));
  assert.ok(just > 0, 'just inside the boundary the field is positive');
  // (1 - rho^2) at rho = 1 - 1e-6 is about 2e-6; squared, times 2.5.
  assert.ok(just < 2.5 * Math.pow(2.1e-6, 2), `boundary approach too large: ${just}`);
  const nearer = f.emissionAt(pointAt(1 - 1e-9, 0.3, 0.8));
  assert.ok(nearer < just, 'values shrink toward the boundary');
  // Exactly constructed boundary points (axis-aligned, so rho is
  // exactly 1 in floating point) sample exactly zero.
  assert.equal(f.emissionAt([R + r, 0, 0]), 0);
  assert.equal(f.emissionAt([R, r, 0]), 0);
  assert.equal(f.emissionAt([R, -r, 0]), 0);
  assert.equal(f.emissionAt([0, 0, R + r]), 0);
});

test('emission: coordinates recover construction angles', () => {
  const f = baseField();
  for (const [rho, theta, phi] of [
    [0.3, 0.5, 1.1],
    [0.85, -2.0, -0.7],
    [0.55, 2.9, 3.0],
    [0.1, -0.4, -3.0],
  ] as const) {
    const c = f.coordsAt(pointAt(rho, theta, phi));
    assert.ok(Math.abs(c.rho - rho) < 1e-12, `rho: ${c.rho} vs ${rho}`);
    assert.ok(Math.abs(c.theta - theta) < 1e-12, `theta: ${c.theta} vs ${theta}`);
    assert.ok(Math.abs(c.phi - phi) < 1e-12, `phi: ${c.phi} vs ${phi}`);
    assert.ok(Math.abs(c.axisDistance - rho * r) < 1e-12);
  }
});

test('emission: toroidal symmetry is rotation about the main axis', () => {
  const f = makeEmissionField({
    majorRadius: R, minorRadius: r, intensity: 3, profileExponent: 1.5,
    toroidalMode: 3, toroidalAmp: 0.5, toroidalPhase: 0.3,
  });
  const rotY = (p: Vec3, a: number): Vec3 => [
    p[0] * Math.cos(a) - p[2] * Math.sin(a),
    p[1],
    p[0] * Math.sin(a) + p[2] * Math.cos(a),
  ];
  const p = pointAt(0.4, 0.2, 0.9);
  const e0 = f.emissionAt(p);
  // One full toroidal period (2 pi / 3) leaves the field unchanged.
  const ePer = f.emissionAt(rotY(p, (2 * Math.PI) / 3));
  assert.ok(Math.abs(ePer - e0) < 1e-12, `period rotation: ${ePer} vs ${e0}`);
  // A non-period rotation shifts only the toroidal phase term.
  const eShift = f.emissionAt(rotY(p, Math.PI / 3));
  const wantShift = closedForm(3, 1.5, 3, 0.5, 0.3, 0, 0, 0.4, 0.2 + Math.PI / 3, 0.9);
  assert.ok(Math.abs(eShift - wantShift) < 1e-12, `phase shift: ${eShift} vs ${wantShift}`);
  assert.ok(Math.abs(eShift - e0) > 0.1, 'the variation is real, not a no-op');
});

test('emission: poloidal factor and the axis convention', () => {
  const f = makeEmissionField({
    majorRadius: R, minorRadius: r, intensity: 2, profileExponent: 1,
    poloidalAmp: 0.5, poloidalPhase: 0,
  });
  // Inboard (phi = pi) vs outboard (phi = 0) at the same rho and theta.
  const out = f.emissionAt(pointAt(0.5, 0.4, 0));
  const inb = f.emissionAt(pointAt(0.5, 0.4, Math.PI));
  const prof = Math.pow(1 - 0.25, 1);
  assert.ok(Math.abs(out - 2 * prof * 1.5) < 1e-12);
  assert.ok(Math.abs(inb - 2 * prof * 0.5) < 1e-12);
  // On the axis the poloidal angle is singular; the field uses phi = 0,
  // so the axis value carries the factor (1 + aPol cos(pPol)) = 1.5.
  assert.ok(Math.abs(f.emissionAt(pointAt(0, 0.4, 0)) - 2 * 1.5) < 1e-12);
});

test('emission: distAt is the exact torus signed distance', () => {
  const f = baseField();
  const node = { kind: 'torus', R, r } as const;
  // Agreement with the engine SDF library's torus node on a grid.
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 7; j++) {
      for (let k = 0; k < 7; k++) {
        const p: Vec3 = [-5 + i * 1.7, -3 + j * 1.1, -5 + k * 1.7];
        const want = evalSdf(node, p, {}).d;
        assert.ok(Math.abs(f.distAt(p) - want) < 1e-12, `distAt mismatch at ${p}`);
      }
    }
  }
  // Sign and surface: rho = 1 points are on the surface; distAt is the
  // signed offset (rho - 1) * r along the minor circle.
  for (const [rho, want] of [[0, -1], [0.5, -0.5], [1, 0], [1.5, 0.5], [2.5, 1.5]] as const) {
    const d = f.distAt(pointAt(rho, 0.8, -1.9));
    assert.ok(Math.abs(d - want) < 1e-12, `rho=${rho}: distAt ${d}, want ${want}`);
    assert.equal(f.contains(pointAt(rho, 0.8, -1.9)), want <= 0);
  }
});

test('emission: distAt is 1-Lipschitz (true distance evidence)', () => {
  const f = baseField();
  // Deterministic LCG pairs in a box around the torus.
  let s = 123456789;
  const rnd = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < 2000; i++) {
    const p: Vec3 = [rnd() * 12 - 6, rnd() * 8 - 4, rnd() * 12 - 6];
    const q: Vec3 = [rnd() * 12 - 6, rnd() * 8 - 4, rnd() * 12 - 6];
    const dpq = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    assert.ok(
      Math.abs(f.distAt(p) - f.distAt(q)) <= dpq + 1e-9,
      `Lipschitz violated: |${f.distAt(p)} - ${f.distAt(q)}| > ${dpq}`,
    );
  }
});

test('emission: invalid parameters are rejected (negative controls)', () => {
  const good = { majorRadius: R, minorRadius: r, intensity: 1, profileExponent: 1.5 };
  const bad: Array<[string, object]> = [
    ['sign-flipped major radius', { ...good, majorRadius: -R }],
    ['zero major radius', { ...good, majorRadius: 0 }],
    ['sign-flipped minor radius', { ...good, minorRadius: -r }],
    ['zero minor radius', { ...good, minorRadius: 0 }],
    ['minor equals major (no hole)', { ...good, minorRadius: R }],
    ['minor exceeds major (self-intersecting tube)', { ...good, minorRadius: R + 1 }],
    ['sign-flipped profile exponent', { ...good, profileExponent: -2 }],
    ['zero profile exponent (boundary jump)', { ...good, profileExponent: 0 }],
    ['negative intensity', { ...good, intensity: -0.5 }],
    ['toroidal amp above 1 (would flip sign)', { ...good, toroidalAmp: 1.2 }],
    ['poloidal amp above 1', { ...good, poloidalAmp: 2 }],
    ['negative amp', { ...good, poloidalAmp: -0.2 }],
    ['fractional toroidal mode', { ...good, toroidalMode: 1.5 }],
    ['negative toroidal mode', { ...good, toroidalMode: -1 }],
    ['NaN center', { ...good, center: [NaN, 0, 0] }],
    ['infinite phase', { ...good, toroidalPhase: Infinity }],
  ];
  for (const [name, params] of bad) {
    assert.throws(() => makeEmissionField(params as never), Error, name);
  }
  assert.doesNotThrow(() => makeEmissionField(good));
});

test('emission: zero intensity samples exactly zero everywhere', () => {
  const f = makeEmissionField({
    majorRadius: R, minorRadius: r, intensity: 0, profileExponent: 2,
    toroidalMode: 2, toroidalAmp: 0.9, poloidalAmp: 0.9,
  });
  for (let i = 0; i < 200; i++) {
    const rho = (i % 20) / 10;
    const p = pointAt(rho, i * 1.31, i * 0.77 - 2);
    assert.equal(f.emissionAt(p), 0, `nonzero at ${p}`);
  }
  const ray: Ray = { origin: [R, 0, -10], dir: [0, 0, 1] };
  assert.equal(integrateEmission(f, ray.origin, ray.dir, 20).value, 0);
});

test('emission: line integral matches the analytic chord', () => {
  // Ray along +y through the tube center at (R, 0, 0): rho = |y| / r
  // along the chord, so the integral is I0 * r * int_{-1}^{1} (1-u^2)^2 du
  // = I0 * r * 16/15 for alpha = 2.
  const f = makeEmissionField({
    majorRadius: R, minorRadius: r, intensity: 3, profileExponent: 2,
  });
  const origin: Vec3 = [R, -10, 0];
  const dir: Vec3 = [0, 1, 0];
  const want = 3 * r * (16 / 15);
  const coarse = integrateEmission(f, origin, dir, 20);
  assert.ok(
    Math.abs(coarse.value - want) / want < 5e-3,
    `default quadrature: ${coarse.value} vs analytic ${want}`,
  );
  const fine = integrateEmission(f, origin, dir, 20, { stepsPerMinor: 512 });
  assert.ok(
    Math.abs(fine.value - want) / want < 1e-5,
    `fine quadrature: ${fine.value} vs analytic ${want}`,
  );
  // A ray that never enters the tube integrates to exactly zero.
  const miss = integrateEmission(f, [0, 50, 0], [0, 0, 1], 20);
  assert.equal(miss.value, 0);
  // Quadrature bookkeeping is deterministic and capped.
  const q = emissionQuadrature(f, 20);
  assert.ok(q.samples > 0 && q.step > 0);
  const cap = emissionQuadrature(f, 1e7, { maxSamples: 100 });
  assert.equal(cap.samples, 100);
});

test('emission: determinism, bit-identical samples across instances', () => {
  const mk = (): EmissionField => makeEmissionField({
    center: [0.5, -0.25, 1],
    majorRadius: 2.2, minorRadius: 0.7, intensity: 1.8, profileExponent: 2.6,
    toroidalMode: 4, toroidalAmp: 0.3, toroidalPhase: 0.11,
    poloidalAmp: 0.45, poloidalPhase: -0.2,
  });
  const a = mk();
  const b = mk();
  const samplesA: number[] = [];
  const samplesB: number[] = [];
  for (let i = 0; i < 300; i++) {
    const p: Vec3 = [
      ((i * 37) % 90) / 10 - 4.5,
      ((i * 53) % 60) / 10 - 3,
      ((i * 91) % 90) / 10 - 4.5,
    ];
    samplesA.push(a.emissionAt(p), a.distAt(p));
    samplesB.push(b.emissionAt(p), b.distAt(p));
  }
  assert.deepEqual(samplesA, samplesB);
  const i1 = integrateEmission(a, [3.4, 0, -8], [0, 0, 1], 16);
  const i2 = integrateEmission(b, [3.4, 0, -8], [0, 0, 1], 16);
  assert.deepEqual(i1, i2);
});

const sphereLayer = (center: Vec3, radius: number, color: Vec3): Solid3D => ({
  kind: '3d',
  sdf: (p: Vec3) => Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) - radius,
  shade: () => color,
});

test('emission layer: glow without a surface, occlusion by one', () => {
  const f = makeEmissionField({
    majorRadius: R, minorRadius: r, intensity: 3, profileExponent: 2,
  });
  const glow: EmissionLayer = { kind: 'emission', field: f, tint: [1, 0.5, 0.25] };
  const ray: Ray = { origin: [R, 0, -10], dir: [0, 0, 1] };
  // No surface: the hit is pure glow, depth stays Infinity.
  const open = marchScene([glow], ray, ray.origin);
  assert.equal(open.kind, 'emission');
  assert.equal(open.depth, Infinity);
  assert.ok(open.color[0] > 0 && open.color[1] > 0 && open.color[2] > 0);
  // Tint ratios survive integration.
  assert.ok(Math.abs(open.color[1] / open.color[0] - 0.5) < 1e-12);
  assert.ok(Math.abs(open.color[2] / open.color[0] - 0.25) < 1e-12);
  // A sphere in front, outside the tube: all glow is behind it, so the
  // hit is the sphere's shade exactly.
  const ball = sphereLayer([R, 0, -4], 1, [0.2, 0.4, 0.6]);
  const blocked = marchScene([ball, glow], ray, ray.origin);
  assert.equal(blocked.kind, '3d');
  assert.deepEqual(blocked.color, [0.2, 0.4, 0.6]);
  // A sphere whose near surface sits inside the tube: the glow in
  // front of it survives, the rest is occluded. Checked against a
  // fine reference integral bounded by the hit depth.
  const partial = sphereLayer([R, 0, 0.5], 0.8, [0.2, 0.4, 0.6]);
  const part = marchScene([partial, glow], ray, ray.origin);
  assert.equal(part.kind, '3d');
  assert.ok(part.color[0] > 0.2 && part.color[0] < 0.2 + open.color[0]);
  let ref = 0;
  const h = r / 4096;
  const depth = part.depth;
  for (let t = h / 2; t < depth; t += h) {
    ref += f.emissionAt([R, 0, -10 + t]) * h;
  }
  assert.ok(
    Math.abs(part.color[0] - (0.2 + ref)) / ref < 0.02,
    `occluded glow: layer ${part.color[0]}, shade + fine reference ${0.2 + ref}`,
  );
});

test('emission layer: zero intensity leaves a scene bit-identical', () => {
  const dead = makeEmissionField({
    majorRadius: R, minorRadius: r, intensity: 0, profileExponent: 2,
    toroidalMode: 3, toroidalAmp: 0.8, poloidalAmp: 0.8,
  });
  const deadLayer: EmissionLayer = { kind: 'emission', field: dead, tint: [3, 2, 1], gain: 5 };
  const ball = sphereLayer([1, 0.5, 6], 2, [0.3, 0.6, 0.9]);
  const base: Layer[] = [ball];
  const withDead: Layer[] = [ball, deadLayer];
  for (let i = 0; i < 25; i++) {
    const a = (i / 24 - 0.5) * 1.2;
    const ray: Ray = { origin: [0, 0, -6], dir: [Math.sin(a), 0.1 * Math.sin(i), Math.cos(a)] };
    const dl = Math.hypot(ray.dir[0], ray.dir[1], ray.dir[2]);
    ray.dir = [ray.dir[0] / dl, ray.dir[1] / dl, ray.dir[2] / dl];
    const h0 = marchScene(base, ray, ray.origin);
    const h1 = marchScene(withDead, ray, ray.origin);
    assert.deepEqual(h1, h0, `ray ${i} changed by a zero-intensity emission layer`);
  }
});

test('emission field: marching consumes distAt as an SDF surface', () => {
  const f = baseField();
  const shell: Solid3D = { kind: '3d', sdf: (p) => f.distAt(p), shade: () => [1, 0, 0] };
  const ray: Ray = { origin: [R, 0, -10], dir: [0, 0, 1] };
  const hit = marchScene([shell], ray, ray.origin);
  // Along this ray distAt = sqrt(R^2 + z^2) - R - r... the boundary is
  // where sqrt(9 + z^2) = R + r = 4, so z = -sqrt(7) and depth = 10 - sqrt(7).
  const want = 10 - Math.sqrt(7);
  assert.equal(hit.kind, '3d');
  assert.ok(Math.abs(hit.depth - want) < 3e-3, `marched depth ${hit.depth}, analytic ${want}`);
  const p: Vec3 = [R, 0, -10 + hit.depth];
  assert.ok(Math.abs(f.distAt(p)) < 2e-3, 'hit point sits on the field boundary');
});
