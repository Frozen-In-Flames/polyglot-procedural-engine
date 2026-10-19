import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pinholeRay,
  intersectLayer,
  marchScene,
  parallaxUV,
  hopPlane,
  hopDistance,
  planeContentAt,
  fitLayerParams,
  type PinholeCam,
  type Ray,
  type Layer2D,
  type Layer25D,
  type Solid3D,
  type Field4D,
  type PlaneStack,
} from '../src/scene/layers.js';
import { clampMinMax } from '../src/render/temporal.js';
import { tevEvaluate, polyChainWiring } from '../src/material/tev.js';

// Dimensional layering: 2D billboards, 2.5D parallax planes, 3D SDF solids and
// 4D time-varying fields composite in one field of view through one march.
// Tests are the spec; the implementation must satisfy them.

const CAM: PinholeCam = { pos: [0, 0, 0], target: [0, 0, 1], fovY: Math.PI / 3, aspect: 1 };
const TAN = Math.tan(Math.PI / 6); // tan(fovY/2)

function approx(a: number, b: number, tol = 1e-9): void {
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ~= ${b} (tol ${tol})`);
}

const circle2 = (r: number) => (uv: [number, number]) =>
  Math.hypot(uv[0], uv[1]) - r;

function billboard(over: Partial<Layer2D> = {}): Layer2D {
  return {
    kind: '2d',
    center: [0, 0, 5],
    size: [2, 2],
    field2: circle2(0.5),
    color: () => [1, 0, 0],
    facing: 'camera',
    ...over,
  };
}

function planeLayer(over: Partial<Layer25D> = {}): Layer25D {
  return {
    kind: '2.5d',
    center: [0, 0, 10],
    normal: [0, 0, -1],
    size: [8, 8],
    depth: 10,
    parallaxScale: 0.5,
    content: () => ({ dist: -1, color: [0, 1, 0] }),
    ...over,
  };
}

function sphereSolid(center: [number, number, number] = [0, 0, 8], r = 1): Solid3D {
  return {
    kind: '3d',
    sdf: (p) => Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) - r,
    shade: () => [0.5, 0.5, 0.5],
  };
}

// ---------------------------------------------------------------------------
// 2D billboards
// ---------------------------------------------------------------------------

test('2d: centered ray hits the billboard at the plane depth', () => {
  const ray = pinholeRay(CAM, 0, 0);
  const hit = intersectLayer(billboard(), ray, CAM.pos);
  assert.equal(hit.kind, '2d');
  approx(hit.depth, 5, 1e-9);
  assert.deepEqual(hit.color, [1, 0, 0]);
});

test('2d: ray outside the 2D field misses', () => {
  const ray = pinholeRay(CAM, 0.9, 0); // uv.x far outside the r=0.5 circle
  const hit = intersectLayer(billboard(), ray, CAM.pos);
  assert.equal(hit.depth, Infinity);
});

test('2d NEGATIVE: fixed facing pointed away from the camera never hits', () => {
  const away = billboard({ facing: 'fixed', fixedNormal: [0, 0, 1] });
  const toward = billboard({ facing: 'fixed', fixedNormal: [0, 0, -1] });
  const ray = pinholeRay(CAM, 0, 0);
  assert.equal(intersectLayer(away, ray, CAM.pos).depth, Infinity);
  const hit = intersectLayer(toward, ray, CAM.pos);
  assert.equal(hit.kind, '2d');
  approx(hit.depth, 5, 1e-9);
});

// ---------------------------------------------------------------------------
// 2.5D parallax planes
// ---------------------------------------------------------------------------

test('2.5d: parallax shift is exact arithmetic under camera translation', () => {
  const layer = planeLayer({ parallaxScale: 0.5 });
  const p: [number, number, number] = [1.5, -0.5, 10];
  const c1: [number, number, number] = [0, 0, 0];
  const c2: [number, number, number] = [2, 0, 0];
  const v1 = parallaxUV(layer, p, c1);
  const v2 = parallaxUV(layer, p, c2);
  // v = uvP - s * uvC, so the shift is exactly -s * planar(camDelta).
  approx(v2[0] - v1[0], -0.5 * 2, 1e-12);
  approx(v2[1] - v1[1], 0, 1e-12);
});

test('2.5d: plane hit depth is the analytic ray-plane distance', () => {
  const ray = pinholeRay(CAM, 0.1, 0);
  const hit = intersectLayer(planeLayer(), ray, CAM.pos);
  assert.equal(hit.kind, '2.5d');
  const expected = 10 / ray.dir[2];
  approx(hit.depth, expected, 1e-9);
});

test('2.5d NEGATIVE: zero parallax reads static under camera motion', () => {
  const layer = planeLayer({ parallaxScale: 0 });
  const p: [number, number, number] = [1.5, -0.5, 10];
  const v1 = parallaxUV(layer, p, [0, 0, 0]);
  const v2 = parallaxUV(layer, p, [3, -2, 5]);
  approx(v1[0], v2[0], 1e-12);
  approx(v1[1], v2[1], 1e-12);
  // And through the compositor: identical color for the same content ray.
  const ray = pinholeRay(CAM, 0.1, 0);
  const h1 = marchScene([layer], ray, [0, 0, 0]);
  const h2 = marchScene([layer], ray, [3, -2, 5]);
  assert.deepEqual(h1.color, h2.color);
});

// ---------------------------------------------------------------------------
// 3D solids (existing SDF path, unchanged behavior)
// ---------------------------------------------------------------------------

test('3d: sphere-traced solid hits at the analytic depth', () => {
  const ray = pinholeRay(CAM, 0, 0);
  const hit = intersectLayer(sphereSolid(), ray, CAM.pos);
  assert.equal(hit.kind, '3d');
  approx(hit.depth, 7, 2e-3); // sphere-trace eps 1e-3
});

// ---------------------------------------------------------------------------
// Mixed-scene occlusion across dimensionalities, one march
// ---------------------------------------------------------------------------

test('mixed: one march resolves 2d / 2.5d / 3d by depth order', () => {
  const bb = billboard({ size: [0.5, 0.5] }); // covers |nx| < 0.0865
  const layer: Layer25D = planeLayer({
    center: [0, 0, 6],
    size: [4, 4],
    parallaxScale: 0,
    // Opaque everywhere except a hole |v| < 0.5 the sphere shows through.
    content: (v) => (Math.hypot(v[0], v[1]) < 0.5
      ? { dist: 1, color: [0, 0, 0] }
      : { dist: -1, color: [0, 1, 0] }),
  });
  const sph = sphereSolid();
  const layers = [bb, layer, sph];

  const hBill = marchScene(layers, pinholeRay(CAM, 0, 0), CAM.pos);
  assert.equal(hBill.kind, '2d');
  approx(hBill.depth, 5, 1e-9);

  // Through the layer hole: billboard missed (|nx|=0.1 -> x=0.29 > 0.25),
  // layer hole (|v|=0.35 < 0.5), sphere hit.
  const hSph = marchScene(layers, pinholeRay(CAM, 0.1, 0), CAM.pos);
  assert.equal(hSph.kind, '3d');
  assert.ok(hSph.depth > 6.9 && hSph.depth < 7.1, `sphere depth ${hSph.depth}`);

  // Off to the side: billboard missed, opaque layer region hit.
  const hLay = marchScene(layers, pinholeRay(CAM, 0.3, 0), CAM.pos);
  assert.equal(hLay.kind, '2.5d');
  approx(hLay.depth, 6 / pinholeRay(CAM, 0.3, 0).dir[2], 1e-9);
});

test('mixed: empty scene is a clean miss', () => {
  const hit = marchScene([], pinholeRay(CAM, 0, 0), CAM.pos);
  assert.equal(hit.depth, Infinity);
  assert.equal(hit.layer, -1);
});

// ---------------------------------------------------------------------------
// 4D: time-varying fields
// ---------------------------------------------------------------------------

function growingSphere(t: number): Field4D {
  const r = 1 + 0.4 * t;
  return {
    kind: '4d',
    time: t,
    field: (p, tt) => Math.hypot(p[0], p[1], p[2] - 8) - (1 + 0.4 * tt),
    shade: () => [0.4, 0.4, 0.9],
  };
}

test('4d: hit depth matches analytic evolution across frames', () => {
  const ray = pinholeRay(CAM, 0, 0);
  const h0 = intersectLayer(growingSphere(0), ray, CAM.pos);
  const h2 = intersectLayer(growingSphere(2), ray, CAM.pos);
  assert.equal(h0.kind, '4d');
  approx(h0.depth, 8 - 1.0, 2e-3);
  approx(h2.depth, 8 - 1.8, 2e-3);
});

test('4d: ghosting stays within the v1.3.0 min-max bound', () => {
  // Steady-state measurement with the v1.3.0 methodology, rendered through
  // a 4D layer: a sphere (r 0.17) translates across a row of 80 rays at the
  // same relative speed as the v1.3.0 toy (0.0125 row-widths/frame) for 120
  // frames. Each frame the history is EMA-accumulated (alpha 0.1) with or
  // without the min-max clamp; the ghost is the leftover energy in the
  // vacated trail behind the sphere, averaged once steady (t > 20).
  const ALPHA = 0.1;
  const T = 120;
  const N = 80;
  const ROW = 4.62; // world width of the ray fan at the sphere depth
  const nxs: number[] = [];
  for (let i = 0; i < N; i++) nxs.push(-0.5 + 1.0 * (i / (N - 1)));
  const frame = (t: number): number[] => {
    const layer: Field4D = {
      kind: '4d',
      time: t,
      field: (p, tt) => Math.hypot(p[0] - (-2.6 + 0.0125 * ROW * tt), p[1], p[2] - 8) - 0.17,
      shade: (_p, _tt, n) => {
        const d = 0.3 + 0.7 * Math.max(0, -n[2]);
        return [d, d, d];
      },
    };
    return nxs.map((nx) => intersectLayer(layer, pinholeRay(CAM, nx, 0), CAM.pos).color[0]);
  };
  const ghostRun = (clamp: boolean): number => {
    const acc = new Array(N).fill(0);
    const errs: number[] = [];
    for (let t = 0; t < T; t++) {
      const cur = frame(t);
      const hist = clamp ? clampMinMax(acc, cur) : [...acc];
      for (let i = 0; i < N; i++) acc[i] = (1 - ALPHA) * hist[i] + ALPHA * cur[i];
      if (t > 20) {
        let lit = cur.findIndex((v) => v > 0);
        if (lit < 0) lit = N;
        const end = Math.min(Math.max(lit - 1, 0), N);
        if (end > 2) {
          let sum = 0;
          for (let i = 2; i < end; i++) sum += Math.abs(acc[i]);
          errs.push(sum / (end - 2));
        }
      }
    }
    return errs.reduce((s, v) => s + v, 0) / errs.length;
  };
  const ghostNone = ghostRun(false);
  const ghostMM = ghostRun(true);
  assert.ok(ghostNone > 0.04, `unclamped ghost ${ghostNone} should be large`);
  assert.ok(ghostMM < 0.005, `min-max ghost ${ghostMM} exceeds the v1.3.0 bound 0.005`);
});

// ---------------------------------------------------------------------------
// Discrete gameplay layers: plane stacks the player hops between
// ---------------------------------------------------------------------------

function threePlanes(): PlaneStack {
  const mk = (depth: number): Layer25D =>
    planeLayer({ center: [0, 0, depth], depth, parallaxScale: 0.3 });
  return { planes: [mk(2), mk(6), mk(10)] };
}

test('planes: hopping is a depth translation of the player, not a camera trick', () => {
  const stack = threePlanes();
  const s0 = { plane: 1, uv: [0.2, 0.3] as [number, number] };
  const s1 = hopPlane(stack, s0, 1);
  assert.equal(s1.plane, 2);
  assert.deepEqual(s1.uv, [0.2, 0.3]); // in-plane position untouched
  approx(hopDistance(stack, 1, 2), 4, 1e-12); // |10 - 6|
  const s2 = hopPlane(stack, s1, -1);
  assert.equal(s2.plane, 1);
});

test('planes: hops clamp at the ends of the stack', () => {
  const stack = threePlanes();
  const top = hopPlane(stack, { plane: 2, uv: [0, 0] }, 1);
  assert.equal(top.plane, 2);
  const bottom = hopPlane(stack, { plane: 0, uv: [0, 0] }, -1);
  assert.equal(bottom.plane, 0);
});

test('planes: per-plane content query for collision', () => {
  const stack = threePlanes();
  stack.planes[1] = planeLayer({
    center: [0, 0, 6],
    depth: 6,
    content: (v) => (Math.hypot(v[0], v[1]) < 1
      ? { dist: -1, color: [1, 1, 0] }
      : { dist: 1, color: [0, 0, 0] }),
  });
  assert.equal(planeContentAt(stack, 1, [0.2, 0.1]), true);
  assert.equal(planeContentAt(stack, 1, [5, 5]), false);
});

// ---------------------------------------------------------------------------
// Inverse rendering is uniform across dimensions: joint 2D + 3D fit
// ---------------------------------------------------------------------------

test('inverse: one Gauss-Newton fit recovers a 2D tint and a 3D light azimuth', () => {
  const A_TRUE = 0.9;
  const PHI_TRUE = 0.6;
  // Light placed on the camera side (l_z < 0) so the visible hemisphere is lit.
  const lightDir = (phi: number): [number, number, number] => {
    const l: [number, number, number] = [Math.sin(phi), 0.35, -Math.cos(phi)];
    const n = Math.hypot(l[0], l[1], l[2]);
    return [l[0] / n, l[1] / n, l[2] / n];
  };
  // theta = [tint a, azimuth phi]. Billboard rays see only a, sphere rays
  // see only phi: the Jacobian is block-diagonal by construction.
  const render = (theta: number[]): number[] => {
    const [a, phi] = theta;
    const bb: Layer2D = billboard({
      size: [0.8, 0.8],
      field2: () => -1,
      color: () => [a * 0.8, a * 0.2, a * 0.2],
    });
    const l = lightDir(phi);
    const sph: Solid3D = {
      kind: '3d',
      sdf: (p) => Math.hypot(p[0], p[1], p[2] - 8) - 1,
      shade: (_p, n) => {
        const d = Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2]);
        return [0.7 * d, 0.7 * d, 0.7 * d];
      },
    };
    const out: number[] = [];
    for (const nx of [0, -0.07, 0.07]) {
      const h = marchScene([bb, sph], pinholeRay(CAM, nx, 0), CAM.pos);
      out.push(h.color[0], h.color[1], h.color[2]);
    }
    for (const nx of [-0.19, -0.16, 0.16, 0.19]) {
      const h = marchScene([bb, sph], pinholeRay(CAM, nx, 0), CAM.pos);
      out.push(h.color[0], h.color[1], h.color[2]);
    }
    return out;
  };
  const y = render([A_TRUE, PHI_TRUE]);
  const fit = fitLayerParams(render, [0.5, 0.2], y, { iters: 25, lambda: 1e-3 });
  approx(fit.theta[0], A_TRUE, 0.02);
  approx(fit.theta[1], PHI_TRUE, 0.02);
  assert.ok(fit.finalCost < 1e-6, `final cost ${fit.finalCost} should be ~0 noiseless`);
});

// ---------------------------------------------------------------------------
// Craft looks ride the v1.6.0 TEV system; layers do not reimplement materials
// ---------------------------------------------------------------------------

test('materials: a layer color can be a TEV combiner evaluation', () => {
  const spec = polyChainWiring(2);
  const consts = new Array(spec.numConsts).fill(0.25);
  const v = tevEvaluate(spec, consts, { ndl: 0.8, ndv: 0.8, ndh: 0.9, sdf: 0.5, noise: 0.3 });
  const bb = billboard({ field2: () => -1, color: () => [v, v, v] });
  const hit = marchScene([bb], pinholeRay(CAM, 0, 0), CAM.pos);
  approx(hit.color[0], v, 1e-12);
  approx(hit.color[1], v, 1e-12);
  approx(hit.color[2], v, 1e-12);
});
