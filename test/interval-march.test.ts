// test/interval-march.test.ts - interval Lipschitz guaranteed step
// (v2.0.6). The march's step length is certified against an interval
// bound on the field's gradient over the step's own segment box, so
// the march can approach the zero level set but never cross it, for
// any field whose bound is honest. The pointwise step f(p) / L(p)
// takes the gradient at the current point as the gradient everywhere
// ahead; the battery below fields whose gradients grow along the
// step (a steep inner shell, a gradient that blows up at the
// surface, a cliff in front of flat ground, a twist whose bound
// grows with radius) and counts its overshoots with numbers, against
// analytic or brute-forced ground truth. Negative controls: a halved
// certification bound (boundScale 0.5) overshoots again, the sampled
// bound checker catches an understated provider, and a sign-flipped
// field yields no false hits (a naive marcher false-hits at t = 0 on
// the same field, so the check has teeth).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pcg32 } from '../src/math/determinism.js';
import { evalSdf, type SdfNode } from '../src/math/sdf.js';
import type { Vec3 } from '../src/math/vec.js';
import {
  marchInterval,
  certifyStep,
  sdfIntervalField,
  terrainIntervalField,
  countIntervalBoundViolations,
  segmentBox,
  type IntervalField,
} from '../src/math/interval-march.js';
import {
  makeGrid,
  generateGrid,
  type GridWorld,
} from '../src/scene/grid.js';
import {
  makeGridTerrain,
  raycastTerrain,
  marchTerrain,
  type GridTerrainField,
} from '../src/scene/terrain-field.js';
import {
  marchScene,
  type GridLayer,
  type Layer,
  type MarchStats,
  type Solid3D,
} from '../src/scene/layers.js';
import { FrameMarcher } from '../src/render/frame.js';
import type { Aabb } from '../src/math/lipschitz.js';

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const at = (o: Vec3, d: Vec3, t: number): Vec3 => [
  o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t,
];

// ---------------------------------------------------------------------------
// Fields and ground truth
// ---------------------------------------------------------------------------

/** Smallest positive root of |o + t d - c| = r, or Infinity. */
function sphereRoot(o: Vec3, d: Vec3, c: Vec3, r: number): number {
  const oc: Vec3 = [o[0] - c[0], o[1] - c[1], o[2] - c[2]];
  const b = oc[0] * d[0] + oc[1] * d[1] + oc[2] * d[2];
  const cc = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - r * r;
  const disc = b * b - cc;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : Infinity;
}

/** First crossing of f along the ray by dense scan + bisection: the
 *  independent ground truth for fields with no closed form. */
function bruteHit(f: (p: Vec3) => number, o: Vec3, d: Vec3, maxDist = 20): number {
  if (f(o) <= 0) return NaN;
  let prev = 0;
  for (let t = 5e-4; t < maxDist; t += 5e-4) {
    if (f(at(o, d, t)) <= 0) {
      let lo = prev;
      let hi = t;
      for (let i = 0; i < 60; i++) {
        const m = (lo + hi) / 2;
        if (f(at(o, d, m)) <= 0) hi = m; else lo = m;
      }
      return (lo + hi) / 2;
    }
    prev = t;
  }
  return Infinity;
}

const SPHERE_C: Vec3 = [0.4, 0.1, -0.2];
const sphereField = sdfIntervalField({ kind: 'sphere', r: 1.2, c: SPHERE_C });
const sphereTruth = (o: Vec3, d: Vec3): number => sphereRoot(o, d, SPHERE_C, 1.2);

const TWIST_NODE: SdfNode = {
  kind: 'twist', k: 2.2, child: { kind: 'box', b: [0.9, 0.9, 0.9] },
};
const twistField = sdfIntervalField(TWIST_NODE);
const twistTruth = (o: Vec3, d: Vec3): number =>
  bruteHit((p) => evalSdf(TWIST_NODE, p).d, o, d);

/** Steep-shell field: slope 1 outside radius 2, slope 6 inside,
 *  continuous, zero at radius 11/6. The gradient triples along any
 *  inward step that crosses the shell, which is exactly what a
 *  pointwise bound cannot see from outside. */
const SHELL_C: Vec3 = [0.2, 0, 0.1];
const shellField: IntervalField = {
  f: (p) => {
    const s = Math.hypot(p[0] - SHELL_C[0], p[1] - SHELL_C[1], p[2] - SHELL_C[2]);
    return s >= 2 ? s - 1 : 1 + 6 * (s - 2);
  },
  lipOverBox: (box) => {
    let d2 = 0;
    for (let i = 0; i < 3; i++) {
      const dd = SHELL_C[i] < box.min[i]
        ? box.min[i] - SHELL_C[i]
        : SHELL_C[i] > box.max[i] ? SHELL_C[i] - box.max[i] : 0;
      d2 += dd * dd;
    }
    return Math.sqrt(d2) < 2 ? 6 : 1;
  },
};
const shellTruth = (o: Vec3, d: Vec3): number => sphereRoot(o, d, SHELL_C, 11 / 6);

/** Square-root field: f = k sign(d) sqrt|d| over the sphere distance
 *  d. Its gradient is finite everywhere except at the surface, where
 *  it blows up: the pointwise step from distance D overshoots by a
 *  factor of about 2D / (surface distance) and tunnels clean through. */
const SQRT_C: Vec3 = [-0.3, 0.2, 0];
const SQRT_R = 1.1;
const SQRT_K = 1.5;
const sqrtField: IntervalField = {
  f: (p) => {
    const d = Math.hypot(p[0] - SQRT_C[0], p[1] - SQRT_C[1], p[2] - SQRT_C[2]) - SQRT_R;
    return Math.sign(d) * Math.sqrt(Math.abs(d)) * SQRT_K;
  },
  lipOverBox: (box) => {
    let dm = 0;
    for (let i = 0; i < 3; i++) {
      const dd = SQRT_C[i] < box.min[i]
        ? box.min[i] - SQRT_C[i]
        : SQRT_C[i] > box.max[i] ? SQRT_C[i] - box.max[i] : 0;
      dm += dd * dd;
    }
    let dhi = 0;
    for (const x of [box.min[0], box.max[0]]) {
      for (const y of [box.min[1], box.max[1]]) {
        for (const z of [box.min[2], box.max[2]]) {
          dhi = Math.max(dhi, Math.hypot(x - SQRT_C[0], y - SQRT_C[1], z - SQRT_C[2]));
        }
      }
    }
    const lo = Math.sqrt(dm) - SQRT_R;
    const hi = dhi - SQRT_R;
    const minAbs = lo <= 0 && hi >= 0 ? 0 : Math.min(Math.abs(lo), Math.abs(hi));
    return minAbs === 0 ? Infinity : SQRT_K / (2 * Math.sqrt(minAbs));
  },
};
const sqrtTruth = (o: Vec3, d: Vec3): number => sphereRoot(o, d, SQRT_C, SQRT_R);

/** Seeded fan of rays around a center: aimed rays with jitter, plus
 *  periodic deliberate misses (every missEvery-th ray aims away). */
function fan(
  center: Vec3,
  seed: number,
  n: number,
  missEvery = 0,
): Array<{ o: Vec3; d: Vec3 }> {
  const rng = new Pcg32(seed);
  const rays: Array<{ o: Vec3; d: Vec3 }> = [];
  for (let i = 0; i < n; i++) {
    const th = rng.unit() * Math.PI * 2;
    const ph = Math.acos(rng.unit() * 1.6 - 0.8);
    const R = 5 + rng.unit() * 2;
    const o: Vec3 = [
      center[0] + R * Math.sin(ph) * Math.cos(th),
      center[1] + R * Math.cos(ph),
      center[2] + R * Math.sin(ph) * Math.sin(th),
    ];
    const target: Vec3 = missEvery && i % missEvery === 3
      ? [center[0] + 6, center[1] + 6, center[2]]
      : [
          center[0] + (rng.unit() - 0.5) * 0.7,
          center[1] + (rng.unit() - 0.5) * 0.7,
          center[2] + (rng.unit() - 0.5) * 0.7,
        ];
    rays.push({ o, d: norm([target[0] - o[0], target[1] - o[1], target[2] - o[2]]) });
  }
  return rays;
}

interface Grade {
  overshoots: number;
  tunnels: number;
  hits: number;
  falseHits: number;
  truthHits: number;
  totalSteps: number;
  worstUnder: number;
  worstMargin: number;
  minSlack: number;
}

/** Grade one policy over a ray set against ground truth. An overshoot
 *  is any evaluated sample past the first true intersection, or a
 *  reported hit depth past it; a tunnel is a truth hit the march
 *  never reported. */
function grade(
  field: IntervalField,
  truth: (o: Vec3, d: Vec3) => number,
  rays: Array<{ o: Vec3; d: Vec3 }>,
  policy: 'raw' | 'pointwise' | 'interval',
  opts: { eps?: number; boundScale?: number } = {},
): Grade {
  const g: Grade = {
    overshoots: 0, tunnels: 0, hits: 0, falseHits: 0, truthHits: 0,
    totalSteps: 0, worstUnder: 0, worstMargin: Infinity, minSlack: Infinity,
  };
  for (const { o, d } of rays) {
    const t0 = truth(o, d);
    const m = marchInterval(field, o, d, {
      policy, trace: true, steps: 2000, maxDist: 30, ...opts,
    });
    g.totalSteps += m.steps;
    if (m.minSlack < g.minSlack) g.minSlack = m.minSlack;
    if (!isFinite(t0)) {
      if (isFinite(m.depth)) g.falseHits++;
      continue;
    }
    g.truthHits++;
    const maxT = m.samples && m.samples.length ? Math.max(...m.samples) : 0;
    if (maxT > t0 + 1e-9 || (isFinite(m.depth) && m.depth > t0 + 1e-9)) g.overshoots++;
    if (!isFinite(m.depth)) g.tunnels++;
    if (isFinite(m.depth)) {
      g.hits++;
      g.worstUnder = Math.max(g.worstUnder, t0 - m.depth);
    }
    g.worstMargin = Math.min(g.worstMargin, t0 - maxT);
  }
  return g;
}

// ---------------------------------------------------------------------------
// 1. certifyStep mechanics
// ---------------------------------------------------------------------------

test('interval certify: a boundary-exact proposal is shrunk, then regrown', () => {
  // On the shell field at radius 5.5 (f = 4.5, pointwise bound 1),
  // the proposal 4.5 crosses the shell: its box bound is 6 and the
  // test fails. One halving certifies (the box at 2.25 ends at
  // radius 3.25, all outer shell), and the regrow ladder recovers
  // to 3.375, whose box still clears the shell boundary at radius
  // 2.125. Pinned with fp tolerance; halvings and bound are exact.
  const p: Vec3 = [SHELL_C[0] + 5.5, SHELL_C[1], SHELL_C[2]];
  const dir: Vec3 = [-1, 0, 0];
  const c = certifyStep(shellField, p, dir, shellField.f(p), shellField.f(p));
  assert.ok(Math.abs(c.step - 3.375) < 1e-9, `step ${c.step}`);
  assert.strictEqual(c.halvings, 1);
  assert.strictEqual(c.bound, 1);
  assert.ok(Math.abs(c.slack - 1.125) < 1e-9, `slack ${c.slack}`);
  // The certified segment is verifiably surface-free, densely sampled.
  for (let i = 0; i <= 1000; i++) {
    const q = at(p, dir, (c.step * i) / 1000);
    assert.ok(shellField.f(q) > 0, `f <= 0 on the certified segment at ${i}`);
  }
  // The rejected proposal was genuinely unsafe: it ends inside.
  assert.ok(shellField.f(at(p, dir, 4.5)) < 0);
});

test('interval certify: certified step is positive and slack is the margin', () => {
  // Aimed at the sphere center: the proposal f lands exactly on the
  // surface, slack 0, so certification must shrink below f and the
  // accepted slack is the guarantee's margin at that step.
  const p: Vec3 = [SPHERE_C[0] + 5.6, SPHERE_C[1], SPHERE_C[2]];
  const dir: Vec3 = [-1, 0, 0];
  const f = sphereField.f(p);
  const c = certifyStep(sphereField, p, dir, f, f);
  assert.ok(c.step < f, `certified ${c.step} must stay under the surface distance ${f}`);
  assert.ok(c.step > f / 2, 'one halving plus regrow lands above f/2');
  assert.ok(c.slack > 0);
  assert.strictEqual(c.slack, f - c.bound * c.step);
});

// ---------------------------------------------------------------------------
// 2. The guarantee battery: interval never overshoots; pointwise does
// ---------------------------------------------------------------------------

test('interval battery: sphere (exact SDF, sanity)', () => {
  const rays = fan(SPHERE_C, 101, 14, 5);
  const gi = grade(sphereField, sphereTruth, rays, 'interval');
  assert.strictEqual(gi.truthHits, 11);
  assert.strictEqual(gi.overshoots, 0);
  assert.strictEqual(gi.tunnels, 0);
  assert.strictEqual(gi.falseHits, 0);
  assert.strictEqual(gi.hits, 11);
  assert.ok(gi.worstMargin >= -1e-9, `worst margin ${gi.worstMargin}`);
  assert.ok(gi.worstUnder <= 2e-3, `worst undershoot ${gi.worstUnder}`);
  assert.ok(gi.minSlack > 0, 'every certified step carried positive slack');
  // On an exact SDF the pointwise and raw steps are already safe;
  // the guarantee costs steps (measured: raw/pointwise avg 3.6,
  // interval 7.4 on this fan), the price of certifying steps that
  // did not need it. Pinned so the cost cannot grow silently.
  const gr = grade(sphereField, sphereTruth, rays, 'raw');
  assert.strictEqual(gr.overshoots, 0);
  assert.ok(gi.totalSteps > gr.totalSteps, 'certification is not free');
  assert.ok(gi.totalSteps <= gr.totalSteps * 3, `interval ${gi.totalSteps} vs raw ${gr.totalSteps}`);
  // Miss rays exit by distance, not by budget. A step clamped to
  // the remaining maxDist is exactly 0 at the boundary and stalls
  // there for the whole budget (the defect this pins; the measured
  // exits are 6 to 9 steps).
  for (const { o, d } of rays) {
    if (isFinite(sphereTruth(o, d))) continue;
    const m = marchInterval(sphereField, o, d, { steps: 2000, maxDist: 30 });
    assert.strictEqual(m.depth, Infinity);
    assert.ok(m.steps <= 32, `miss ray steps ${m.steps}`);
  }
});

test('interval battery: twist overshoots the raw policy, never the interval', () => {
  const rays = fan([0, 0, 0], 202, 12, 5);
  const gi = grade(twistField, twistTruth, rays, 'interval', { eps: 1e-4 });
  assert.strictEqual(gi.truthHits, 10);
  assert.strictEqual(gi.overshoots, 0);
  assert.strictEqual(gi.tunnels, 0);
  assert.strictEqual(gi.hits, 10);
  assert.ok(gi.worstUnder <= 1e-3, `worst undershoot ${gi.worstUnder}`);
  assert.ok(gi.minSlack > 0);
  // The current policy's step rule (raw f) tunnels past the twisted
  // surface on 6 of the 10 hit rays, worst 0.0797 past the truth:
  // the bound grows with radius and the raw step never divides.
  const gr = grade(twistField, twistTruth, rays, 'raw', { eps: 1e-4 });
  assert.ok(gr.overshoots >= 4, `raw overshoots ${gr.overshoots}`);
  assert.ok(gr.worstMargin <= -0.05, `raw worst margin ${gr.worstMargin}`);
  // Pointwise happens to stay safe on this fan (its bound at the
  // point already prices the local radius), at 48.5 avg steps vs
  // the interval march's 51.8: certification is nearly free when
  // the pointwise bound is already honest.
  const gp = grade(twistField, twistTruth, rays, 'pointwise', { eps: 1e-4 });
  assert.strictEqual(gp.overshoots, 0);
  assert.ok(gi.totalSteps <= gp.totalSteps * 1.5, `interval ${gi.totalSteps} vs pointwise ${gp.totalSteps}`);
});

test('interval battery: steep shell defeats pointwise and raw, never interval', () => {
  const hand: Array<{ o: Vec3; d: Vec3 }> = [
    { o: [SHELL_C[0] + 5.6, SHELL_C[1], SHELL_C[2]], d: [-1, 0, 0] },
  ];
  const rays = [...hand, ...fan(SHELL_C, 303, 12, 5)];
  const gi = grade(shellField, shellTruth, rays, 'interval');
  assert.strictEqual(gi.overshoots, 0);
  assert.strictEqual(gi.tunnels, 0);
  assert.strictEqual(gi.falseHits, 0);
  assert.strictEqual(gi.hits, gi.truthHits);
  assert.ok(gi.worstUnder <= 2e-3, `worst undershoot ${gi.worstUnder}`);
  assert.ok(gi.minSlack > 0);
  // Pointwise and raw both overshoot on every hit ray of this fan
  // (11 of 11 in the measured run): from outside the shell the local
  // bound is 1, the step is the full gap, and the surface inside the
  // shell is five sixths closer than the step assumes. Worst sample
  // lands 0.8333 past the true surface (exactly the hand ray's
  // first-step landing, radius 1 against the zero at 11/6).
  for (const pol of ['pointwise', 'raw'] as const) {
    const g = grade(shellField, shellTruth, rays, pol);
    assert.strictEqual(g.overshoots, g.truthHits, `${pol} overshoots ${g.overshoots}/${g.truthHits}`);
    assert.ok(g.worstMargin <= -0.8, `${pol} worst margin ${g.worstMargin}`);
  }
  // The hand ray makes the mechanism exact: pointwise's first step
  // is the full outer gap 4.6, landing at radius 1, deep inside.
  const m = marchInterval(shellField, hand[0].o, hand[0].d, { policy: 'pointwise', trace: true });
  assert.ok(m.samples && m.samples[1] > shellTruth(hand[0].o, hand[0].d) + 0.5);
});

test('interval battery: sqrt field tunnels pointwise clean through', () => {
  const hand: Array<{ o: Vec3; d: Vec3 }> = [
    { o: [SQRT_C[0] + 5.6, SQRT_C[1], SQRT_C[2]], d: [-1, 0, 0] },
  ];
  const rays = [...hand, ...fan(SQRT_C, 404, 12, 5)];
  const gi = grade(sqrtField, sqrtTruth, rays, 'interval');
  assert.strictEqual(gi.overshoots, 0);
  assert.strictEqual(gi.tunnels, 0);
  assert.strictEqual(gi.hits, gi.truthHits);
  assert.ok(gi.worstUnder <= 1e-3, `worst undershoot ${gi.worstUnder}`);
  assert.ok(gi.minSlack > 0);
  // Pointwise tunnels on every hit ray: the step f / L(p) grows
  // like 2 * (distance to surface) as the gradient shallows away
  // from the surface, so it jumps the whole sphere and marches out
  // the far side, never reporting a hit. Raw reports hits, but at
  // depths past the truth (it lands inside, where f < eps reads as
  // a hit). Both are the failure the guarantee exists to remove.
  const gp = grade(sqrtField, sqrtTruth, rays, 'pointwise');
  assert.strictEqual(gp.tunnels, gp.truthHits, `pointwise tunnels ${gp.tunnels}/${gp.truthHits}`);
  assert.strictEqual(gp.hits, 0);
  const gr = grade(sqrtField, sqrtTruth, rays, 'raw');
  assert.strictEqual(gr.overshoots, gr.truthHits);
  assert.ok(gr.worstMargin <= -0.4, `raw worst margin ${gr.worstMargin}`);
});

// ---------------------------------------------------------------------------
// 3. Terrain: the cliff, the rough fan, the cost table
// ---------------------------------------------------------------------------

/** Flat west half (open cells, height 0), solid east half at height
 *  5: one bilinear ramp of slope 5 between the center columns. */
function cliffWorld(): GridWorld {
  const g = makeGrid(12, 6, { cellSize: 1, origin: [0, 0, 0], height: 2 });
  const heights = new Float64Array(12 * 6);
  for (let j = 0; j < 6; j++) {
    for (let i = 6; i < 12; i++) {
      g.cells[j * 12 + i] = 1;
      heights[j * 12 + i] = 5;
    }
  }
  g.heights = heights;
  return g;
}

function roughWorld(): GridWorld {
  return generateGrid(777, 16, 16, {
    density: 0.3, border: true, height: 2, heights: true,
    heightLevels: [0.5, 1, 1.5, 2],
  });
}

test('interval terrain: the cliff ray, pointwise overshoots by a full step', () => {
  const f = makeGridTerrain(cliffWorld());
  assert.strictEqual(f.slopeBound, 5);
  const tf = terrainIntervalField(f);
  const o: Vec3 = [0.5, 2, 2.5];
  const d: Vec3 = [1, 0, 0];
  const a = raycastTerrain(f, o, d, 100);
  assert.ok(a);
  assert.ok(Math.abs(a.depth - 5.4) < 1e-9, `analytic=${a.depth}`);
  // Pointwise (and raw): the local patch bound on the flat approach
  // is 0, so the step is the full vertical gap, 2, every time:
  // samples 0, 2, 4, 6, and the sample at 6 is inside the ramp's top,
  // a false hit 0.6 past the true crossing. This is the v2.0.3
  // header's warning, measured: a local patch bound overestimates
  // the distance next to a steep neighbor.
  for (const pol of ['pointwise', 'raw'] as const) {
    const m = marchInterval(tf, o, d, { policy: pol, steps: 4096 });
    assert.strictEqual(m.depth, 6, `${pol} depth ${m.depth}`);
  }
  // Interval: certified against every patch the step crosses. It
  // reaches the same eps band as the global-S march in fewer steps
  // (11 vs 16 measured) and never samples past 5.4.
  const mi = marchInterval(tf, o, d, { steps: 4096, trace: true });
  assert.ok(mi.depth <= 5.4 + 1e-9 && mi.depth >= 5.39, `interval depth ${mi.depth}`);
  assert.ok(mi.samples && Math.max(...mi.samples) <= 5.4 + 1e-9);
  assert.ok(mi.steps <= 16, `interval steps ${mi.steps}`);
  assert.ok(mi.minSlack > 0);
  const mg = marchTerrain(f, o, d, { steps: 4096 });
  assert.ok(mg.depth <= 5.4 + 1e-9 && mg.depth >= 5.39, `global depth ${mg.depth}`);
});

test('interval terrain: rough fan guarantee and matched-band cost', () => {
  const f = makeGridTerrain(roughWorld());
  const tf = terrainIntervalField(f);
  const S = f.slopeBound;
  // Same ray fan as the v2.0.3 march test (seed 13).
  const rng = new Pcg32(13);
  let rays = 0;
  let iSteps = 0, gMatched = 0, gDefault = 0, pSteps = 0;
  let pOvers = 0, iHits = 0, worstUnder = 0;
  for (let i = 0; i < 60; i++) {
    const o: Vec3 = [1 + rng.unit() * 14, 6 + rng.unit() * 4, 1 + rng.unit() * 14];
    const d = norm([rng.unit() - 0.5, -(0.5 + rng.unit() * 0.5), rng.unit() - 0.5]);
    const a = raycastTerrain(f, o, d, 100);
    assert.ok(a, 'battery rays all hit analytically');
    rays++;
    const mi = marchInterval(tf, o, d, { steps: 4096, trace: true });
    assert.ok(isFinite(mi.depth), 'interval march must hit within budget');
    iHits++;
    iSteps += mi.steps;
    const maxT = mi.samples && mi.samples.length ? Math.max(...mi.samples) : 0;
    assert.ok(maxT <= a.depth + 1e-9, `overshoot: sample ${maxT} past analytic ${a.depth}`);
    assert.ok(mi.depth <= a.depth + 1e-9);
    worstUnder = Math.max(worstUnder, a.depth - mi.depth);
    const mp = marchInterval(tf, o, d, { policy: 'pointwise', steps: 4096, trace: true });
    pSteps += mp.steps;
    const maxP = mp.samples && mp.samples.length ? Math.max(...mp.samples) : 0;
    if (maxP > a.depth + 1e-9 || (isFinite(mp.depth) && mp.depth > a.depth + 1e-9)) pOvers++;
    // The v2.0.3 global-S march at the same 1e-3 gap band (its eps
    // is on distAt, so the matched eps divides by sqrt(1 + S^2)),
    // and at its shipped default band.
    gMatched += marchTerrain(f, o, d, { steps: 8192, eps: 1e-3 / Math.sqrt(1 + S * S) }).steps;
    gDefault += marchTerrain(f, o, d, { steps: 8192 }).steps;
  }
  assert.strictEqual(rays, 60);
  assert.strictEqual(iHits, 60);
  // Measured on this fan: interval 2930 steps at the 1e-3 gap band,
  // global-S 3456 at the same band and 2925 at its looser shipped
  // band, pointwise 1916 with 12 overshoots. The interval march ties
  // the shipped global march's step count while stopping in a band
  // sqrt(1 + S^2) tighter, and beats it at matched bands, because
  // its bound is the slope the step crosses, not the world's worst.
  assert.ok(iSteps >= 2400 && iSteps <= 3600, `interval steps ${iSteps}`);
  assert.ok(iSteps < gMatched, `interval ${iSteps} vs global matched ${gMatched}`);
  assert.ok(iSteps <= gDefault * 1.15, `interval ${iSteps} vs global default ${gDefault}`);
  assert.ok(pSteps < iSteps, 'pointwise is cheaper, and pays for it below');
  assert.ok(pOvers >= 8, `pointwise overshoots ${pOvers} of 60`);
  assert.ok(worstUnder <= 0.005, `worst undershoot ${worstUnder} (global-S measured 0.0133 in v2.0.3)`);
});

test('interval cost: SDF scene fan, the guarantee priced in steps', () => {
  const node: SdfNode = {
    kind: 'union',
    children: [
      { kind: 'twist', k: 2.2, child: { kind: 'box', b: [0.9, 0.9, 0.9] } },
      { kind: 'sphere', r: 0.8, c: [2.2, 0.3, 0.5] },
      { kind: 'sphere', r: 0.6, c: [-1.8, -0.4, 1.2] },
    ],
  };
  const field = sdfIntervalField(node);
  const rng = new Pcg32(43);
  const totals = { raw: 0, pointwise: 0, interval: 0, intervalBQ: 0 };
  let hits = 0;
  for (let i = 0; i < 41; i++) {
    const th = rng.unit() * Math.PI * 2;
    const ph = Math.acos(rng.unit() * 1.4 - 0.7);
    const R = 6 + rng.unit() * 2;
    const o: Vec3 = [
      R * Math.sin(ph) * Math.cos(th),
      R * Math.cos(ph) + 1,
      R * Math.sin(ph) * Math.sin(th),
    ];
    const target: Vec3 = [
      (rng.unit() - 0.5) * 1.4,
      (rng.unit() - 0.5) * 1.4,
      (rng.unit() - 0.5) * 1.4,
    ];
    const d = norm([target[0] - o[0], target[1] - o[1], target[2] - o[2]]);
    for (const pol of ['raw', 'pointwise', 'interval'] as const) {
      const m = marchInterval(field, o, d, { policy: pol, steps: 8192, maxDist: 100 });
      totals[pol] += m.steps;
      if (pol === 'interval') totals.intervalBQ += m.boundQueries;
      if (pol === 'raw' && isFinite(m.depth)) hits++;
    }
    // Cross-check: marchInterval 'raw' is the same step rule as the
    // scene marcher's 'sphere' policy, so their depths agree exactly.
    const layer: Layer[] = [{
      kind: '3d', sdf: (p: Vec3) => evalSdf(node, p).d, shade: () => [0, 1, 0],
    } satisfies Solid3D];
    const hs = marchScene(layer, { origin: o, dir: d }, o, { policy: 'sphere', steps: 8192 });
    const mr = marchInterval(field, o, d, { policy: 'raw', steps: 8192, maxDist: 100 });
    assert.strictEqual(hs.depth, mr.depth, `ray ${i}: scene ${hs.depth} vs raw ${mr.depth}`);
  }
  assert.strictEqual(hits, 41);
  // Measured: raw 308 steps, pointwise 2124, interval 2301 steps
  // plus 8116 bound queries. On a twist-bearing scene the bound is
  // radius-dominated, so bound-based stepping is intrinsically
  // expensive here and certification adds only about 8% over
  // pointwise; raw is 7.5x cheaper and, per the twist battery,
  // wrong on most rays. The release sells the guarantee.
  assert.ok(totals.raw >= 200 && totals.raw <= 450, `raw ${totals.raw}`);
  assert.ok(totals.pointwise >= 1400 && totals.pointwise <= 3000, `pointwise ${totals.pointwise}`);
  assert.ok(totals.interval >= 1500 && totals.interval <= 3200, `interval ${totals.interval}`);
  assert.ok(totals.interval >= totals.pointwise, 'certification never beats pointwise on steps here');
  assert.ok(totals.interval <= totals.raw * 10, 'and stays within an order of magnitude of raw');
});

// ---------------------------------------------------------------------------
// 4. The bound checker: an understated bound is detectable
// ---------------------------------------------------------------------------

test('interval checker: honest providers pass, understated ones are caught', () => {
  const region: Aabb = { min: [-4, -4, -4], max: [4, 4, 4] };
  // Honest providers: zero violations over 4000 seeded pairs each,
  // every pair graded against the bound over its own segment box.
  assert.strictEqual(countIntervalBoundViolations(shellField, region, 4000, 7), 0);
  assert.strictEqual(countIntervalBoundViolations(sphereField, region, 4000, 8), 0);
  assert.strictEqual(countIntervalBoundViolations(twistField, region, 4000, 9), 0);
  // Sabotage 1: the same field with its bound halved. The checker
  // finds it immediately (293 violations in the measured run): an
  // understated interval bound is a detectable defect, not a
  // silent one.
  const halved: IntervalField = {
    f: shellField.f,
    lipOverBox: (b) => 0.5 * shellField.lipOverBox(b),
  };
  const vHalf = countIntervalBoundViolations(halved, region, 4000, 7);
  assert.ok(vHalf > 100, `halved-bound violations ${vHalf}`);
  // Sabotage 2: a pointwise bound passed off as an interval bound
  // (the bound at the segment's center, whatever the segment's
  // size). Pairs straddling the shell expose it (166 measured).
  const pointy: IntervalField = {
    f: shellField.f,
    lipOverBox: (b) => {
      const c: Vec3 = [
        (b.min[0] + b.max[0]) / 2,
        (b.min[1] + b.max[1]) / 2,
        (b.min[2] + b.max[2]) / 2,
      ];
      const r = 1e-9;
      return shellField.lipOverBox({
        min: [c[0] - r, c[1] - r, c[2] - r],
        max: [c[0] + r, c[1] + r, c[2] + r],
      });
    },
  };
  const vPointy = countIntervalBoundViolations(pointy, region, 4000, 7);
  assert.ok(vPointy > 50, `pointwise-as-interval violations ${vPointy}`);
  // segmentBox is the exact box of its segment.
  assert.deepStrictEqual(segmentBox([1, -2, 3], [-4, 5, 0]), {
    min: [-4, -2, 0], max: [1, 5, 3],
  });
});

// ---------------------------------------------------------------------------
// 5. Negative controls: sabotaged certification, sign flip
// ---------------------------------------------------------------------------

test('interval controls: boundScale 0.5 voids the guarantee, measurably', () => {
  // With the certification bound halved, certified steps double
  // where the true gradient is steepest, and the overshoots return:
  // every shell fan ray (12 of 12 measured) and the cliff ray
  // (depth 5.4706 against the analytic 5.4). Same marcher, same
  // fields; only the bound's honesty changed, which is the point:
  // the guarantee is the bound, and the control proves the suite
  // can tell the difference.
  const rays = fan(SHELL_C, 303, 12);
  const g = grade(shellField, shellTruth, rays, 'interval', { boundScale: 0.5 });
  assert.ok(g.overshoots >= 6, `sabotaged overshoots ${g.overshoots}/${g.truthHits}`);
  const f = makeGridTerrain(cliffWorld());
  const tf = terrainIntervalField(f);
  const m = marchInterval(tf, [0.5, 2, 2.5], [1, 0, 0], { boundScale: 0.5, steps: 4096 });
  assert.ok(m.depth > 5.44, `sabotaged cliff depth ${m.depth} vs analytic 5.4`);
  // And the honest run on the same inputs stays inside (control
  // specificity: the sabotage, not the scene, causes the failure).
  const honest = marchInterval(tf, [0.5, 2, 2.5], [1, 0, 0], { steps: 4096 });
  assert.ok(honest.depth <= 5.4 + 1e-9);
});

test('interval controls: sign-flipped fields produce no false hits', () => {
  // Negate the field value, keep the bound. Every ray now starts
  // with f < 0, and the marcher reports startedInside with no hit,
  // on every battery ray: the guarantee machinery never engages,
  // so there is nothing to false-hit with.
  const cases: Array<[IntervalField, Array<{ o: Vec3; d: Vec3 }>]> = [
    [shellField, fan(SHELL_C, 303, 6)],
    [sqrtField, fan(SQRT_C, 404, 6)],
    [sphereField, fan(SPHERE_C, 101, 6)],
  ];
  for (const [field, rays] of cases) {
    const flipped: IntervalField = { f: (p) => -field.f(p), lipOverBox: field.lipOverBox };
    for (const { o, d } of rays) {
      const m = marchInterval(flipped, o, d, { steps: 100 });
      assert.strictEqual(m.depth, Infinity);
      assert.strictEqual(m.startedInside, true);
    }
  }
  const f = makeGridTerrain(cliffWorld());
  const tf = terrainIntervalField(f);
  const flippedT: IntervalField = { f: (p) => -tf.f(p), lipOverBox: tf.lipOverBox };
  const mt = marchInterval(flippedT, [0.5, 2, 2.5], [1, 0, 0], { steps: 100 });
  assert.strictEqual(mt.depth, Infinity);
  assert.strictEqual(mt.startedInside, true);
  // Teeth: a naive marcher (pointwise steps, hit when f < eps, the
  // pre-guarantee contract) false-hits at t = 0 on the same flipped
  // terrain field, exactly the v2.0.3 sign-flip failure mode. If
  // this ever reads otherwise, the control scene stopped exercising
  // the failure.
  const naive = (): number => {
    let t = 0;
    for (let i = 0; i < 100; i++) {
      const p = at([0.5, 2, 2.5], [1, 0, 0], t);
      const v = flippedT.f(p);
      if (v < 1e-3) return t;
      t += v / flippedT.lipOverBox(segmentBox(p, p));
      if (t > 100) return Infinity;
    }
    return Infinity;
  };
  assert.strictEqual(naive(), 0);
});

// ---------------------------------------------------------------------------
// 6. Determinism
// ---------------------------------------------------------------------------

test('interval march: deterministic, bit-identical across runs', () => {
  const f = makeGridTerrain(roughWorld());
  const tf = terrainIntervalField(f);
  const run = (): unknown => {
    const out: unknown[] = [];
    for (const [field, rays] of [
      [shellField, fan(SHELL_C, 303, 8)] as const,
      [sqrtField, fan(SQRT_C, 404, 8)] as const,
    ]) {
      for (const { o, d } of rays) {
        const m = marchInterval(field, o, d, { trace: true, steps: 2000, maxDist: 30 });
        out.push([m.depth, m.steps, m.evals, m.boundQueries, m.samples]);
      }
    }
    const rng = new Pcg32(13);
    for (let i = 0; i < 10; i++) {
      const o: Vec3 = [1 + rng.unit() * 14, 6 + rng.unit() * 4, 1 + rng.unit() * 14];
      const d = norm([rng.unit() - 0.5, -(0.5 + rng.unit() * 0.5), rng.unit() - 0.5]);
      const m = marchInterval(tf, o, d, { steps: 4096, trace: true });
      out.push([m.depth, m.steps, m.evals, m.boundQueries, m.samples]);
    }
    return out;
  };
  assert.deepStrictEqual(run(), run());
});

// ---------------------------------------------------------------------------
// 7. Integration: MarchPolicy 'interval' dispatch and back-compat
// ---------------------------------------------------------------------------

function gridLayer(g: GridWorld): GridLayer {
  return { kind: 'grid', grid: g, color: () => [1, 0, 0] };
}

function stepWorld(): GridWorld {
  const g = makeGrid(6, 1, { cellSize: 1, origin: [0, 0, 0], height: 2 });
  g.cells[2] = 1;
  g.cells[3] = 1;
  const heights = new Float64Array(6);
  heights[2] = 1;
  heights[3] = 3;
  g.heights = heights;
  return g;
}

test('interval integration: policy dispatch, defaults unchanged', () => {
  const layers: Layer[] = [gridLayer(stepWorld())];
  const ray = { origin: [0.5, 2.5, 0.5] as Vec3, dir: [1, 0, 0] as Vec3 };
  // Default and sphere/fixed stay the exact DDA (pinned in v2.0.3,
  // re-pinned here against the new dispatch branch).
  for (const opts of [{}, { policy: 'sphere' as const }, { policy: 'fixed' as const }]) {
    const hit = marchScene(layers, ray, ray.origin, opts);
    assert.strictEqual(hit.depth, 2.5);
    assert.strictEqual(hit.kind, 'grid');
  }
  // Interval reads the terrain surface like 'terrain' (crossing at
  // 2.75 on this ray) and agrees with it to the eps band.
  const analytic = raycastTerrain(makeGridTerrain(stepWorld()), ray.origin, ray.dir, 100);
  assert.ok(analytic && Math.abs(analytic.depth - 2.75) < 1e-9);
  const hi = marchScene(layers, ray, ray.origin, { policy: 'interval', steps: 4096 });
  assert.strictEqual(hi.kind, 'grid');
  assert.ok(hi.depth <= 2.75 + 1e-9 && hi.depth >= 2.75 - 0.02, `interval depth ${hi.depth}`);
  const ht = marchScene(layers, ray, ray.origin, { policy: 'terrain', steps: 4096 });
  assert.ok(Math.abs(hi.depth - ht.depth) <= 0.02, `interval ${hi.depth} vs terrain ${ht.depth}`);
  // Stats flow: steps counted, evals at least the field evaluations.
  const stats: MarchStats = { steps: 0, evals: 0 };
  marchScene(layers, ray, ray.origin, { policy: 'interval', steps: 4096, stats });
  assert.ok(stats.steps > 0 && stats.evals >= stats.steps, JSON.stringify(stats));
  // The cliff world through the full scene path.
  const cliffLayers: Layer[] = [gridLayer(cliffWorld())];
  const hc = marchScene(
    cliffLayers, { origin: [0.5, 2, 2.5], dir: [1, 0, 0] }, [0.5, 2, 2.5],
    { policy: 'interval', steps: 4096 },
  );
  assert.strictEqual(hc.kind, 'grid');
  assert.ok(hc.depth <= 5.4 + 1e-9 && hc.depth >= 5.39, `cliff scene depth ${hc.depth}`);
  // FrameMarcher carries the policy dial end to end.
  const fm = new FrameMarcher({ policy: 'interval', steps: 4096, columns: 12 });
  const frame = fm.render(
    { pos: [0.5, 2.5, 0.5], target: [6, 2.5, 0.5], fovY: Math.PI / 3, aspect: 1 },
    layers,
  );
  assert.ok(frame.columns.some((c) => c.kind === 'grid' && isFinite(c.depth)));
});

test('interval integration: terrain policy result is unchanged by the refactor', () => {
  // The terrain branch's hit shaping was factored into a shared
  // helper for the interval branch; its observable result on the
  // v2.0.3 pinned ray is byte-identical to the pre-refactor march.
  const f: GridTerrainField = makeGridTerrain(stepWorld());
  const direct = marchTerrain(f, [0.5, 2.5, 0.5], [1, 0, 0], { steps: 512 });
  const layers: Layer[] = [gridLayer(stepWorld())];
  const via = marchScene(
    layers, { origin: [0.5, 2.5, 0.5], dir: [1, 0, 0] }, [0.5, 2.5, 0.5],
    { policy: 'terrain', steps: 512 },
  );
  assert.strictEqual(via.depth, direct.depth);
});
