// math/interval-march.ts - interval Lipschitz guaranteed step (v2.0.6).
//
// A march step is GUARANTEED conservative when the field cannot reach
// zero anywhere on the step's segment. That is a statement about the
// whole segment, so it needs a bound over a region, not at a point:
// if L_B is a certified Lipschitz bound of f over a box B containing
// the segment [p, p + s d], then every q on the segment satisfies
// f(q) >= f(p) - L_B * s. The step is certified when f(p) > L_B * s,
// and a certified step can approach the zero level set but never
// cross it, whatever the field does inside the segment.
//
// The contrast is the pointwise step, t += f(p) / L(p), with L(p) the
// bound over an infinitesimal box at the current point. It is exact
// when the gradient ahead equals the gradient here, and it overshoots
// whenever the gradient grows along the step: steep shells, cliff
// faces in front of flat ground, fields whose gradient blows up near
// the surface. The raw step t += f(p) (the classic sphere trace, the
// engine's 'sphere' policy) is the limiting case L = 1 everywhere.
//
// The algorithm is certify-then-step. Propose the pointwise step
// (fast when the field is tame), then ask the interval bound over the
// proposed segment's own box; while the certification inequality
// fails, halve the step and ask again. Halving shrinks the box, so
// the bound can only stay flat or tighten, and as s -> 0 the test
// tends to f(p) > 0: a certifiable step always exists when the bound
// is finite near p. Every accepted step carries its slack
// f(p) - L_B * s > 0, and the march reports the minimum slack it
// ever accepted as the guarantee's measured margin.
//
// Providers. An IntervalField pairs the field with lipOverBox, a
// certified bound over any axis-aligned box (Infinity is an honest
// answer: the region cannot be bounded, certification just shrinks).
// Two ship here. sdfIntervalField reads SDF node trees through
// localLipschitzBound (lipschitz.ts), the closed-form interval bound
// per operator. terrainIntervalField reads a grid terrain through
// its per-patch slope bounds: over a step, the bound is the maximum
// patch bound under the step's footprint, never the field-wide S of
// v2.0.3 and never just the current patch's bound (the v2.0.3 header
// warns a purely local patch bound overestimates the distance next
// to a steep neighbor; v2.0.6 measures that failure and this fix).
//
// Honest limits. The guarantee is exactly as strong as the provider's
// bound: lipOverBox is a proof obligation per field family, in the
// same way localLipschitzBound's operator table is. countInterval-
// BoundViolations below is the sampled checker for that obligation:
// random point pairs graded against the bound over their own segment
// box. Like countLipschitzViolations it can find violations but
// cannot certify their absence; the closed-form bounds are the proof,
// the checker is the tripwire that catches an understated one.
// boundScale exists to prove that point: it multiplies the bound
// used for certification, and below 1 the guarantee is void by
// construction (negative control, pinned in the suite).

import { evalSdf, type SdfNode, type Uniforms } from './sdf.js';
import { localLipschitzBound, type Aabb } from './lipschitz.js';
import { Pcg32 } from './determinism.js';
import type { Vec3 } from './vec.js';
import type { GridTerrainField } from '../scene/terrain-field.js';

export type { Aabb };

/** A scalar field with a certified Lipschitz bound over any box. */
export interface IntervalField {
  /** Field value at p. The zero level set is the surface. */
  f(p: Vec3): number;
  /**
   * Certified upper bound on ||grad f|| over the box (equivalently,
   * |f(a) - f(b)| <= L ||a - b|| for all a, b in the box). May return
   * Infinity where no finite bound exists; certification treats an
   * infinite bound as "not certifiable at this size" and shrinks.
   */
  lipOverBox(box: Aabb): number;
}

/** The exact axis-aligned box of the segment a -> b. */
export function segmentBox(a: Vec3, b: Vec3): Aabb {
  return {
    min: [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.min(a[2], b[2]),
    ],
    max: [
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
      Math.max(a[2], b[2]),
    ],
  };
}

function inflateBox(box: Aabb, pad: number): Aabb {
  return {
    min: [box.min[0] - pad, box.min[1] - pad, box.min[2] - pad],
    max: [box.max[0] + pad, box.max[1] + pad, box.max[2] + pad],
  };
}

export interface CertifiedStep {
  /** The certified step length: f stays positive on the whole segment. */
  step: number;
  /** The bound the step was certified against (after boundScale). */
  bound: number;
  /** f(p) - bound * step at acceptance. Positive for a certified step. */
  slack: number;
  /** Halvings the certification needed (0 when the proposal certified). */
  halvings: number;
  /** lipOverBox calls the certification made (shrinks plus regrows). */
  queries: number;
}

/**
 * Certify a proposed step from p along the unit direction dir, where
 * fAtP = f(p) > 0. The proposed segment's box is inflated by a
 * relative hair so floating-point rounding in the endpoint cannot
 * put a point of the true segment outside the bounded box. A step is
 * accepted when fAtP exceeds bound * step by a small relative guard,
 * so the certified inequality survives the arithmetic that checks it.
 *
 * The pointwise proposal is typically boundary-exact (slack near
 * zero when the segment's bound equals the point's), so the first
 * test usually fails on the guard alone and the ladder halves. After
 * a halved step certifies, the ladder regrows by 1.5 (at most twice,
 * and likewise after a first-try certification, where the segment's
 * bound can be smaller than the point's, e.g. stepping off a steep
 * patch onto flat ground) and keeps the largest certified step.
 * Every returned step, grown or not, passed the same test against
 * its own segment box; growth never weakens the guarantee, it only
 * spends extra bound queries to buy back the halving tax.
 *
 * boundScale multiplies the provider's bound before the test; the
 * default 1 is the honest bound, anything below 1 understates it and
 * voids the guarantee (the suite's negative control runs at 0.5).
 */
export function certifyStep(
  field: IntervalField,
  p: Vec3,
  dir: Vec3,
  fAtP: number,
  proposed: number,
  boundScale = 1,
): CertifiedStep {
  let queries = 0;
  const test = (s: number): { bound: number; slack: number; ok: boolean } => {
    queries++;
    const end: Vec3 = [p[0] + dir[0] * s, p[1] + dir[1] * s, p[2] + dir[2] * s];
    const extent = Math.max(
      1,
      Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]),
      Math.abs(end[0]), Math.abs(end[1]), Math.abs(end[2]),
    );
    const box = inflateBox(segmentBox(p, end), 1e-12 * extent);
    const bound = boundScale * field.lipOverBox(box);
    const slack = fAtP - bound * s;
    return {
      bound,
      slack,
      ok: Number.isFinite(bound) && slack > bound * s * 1e-12 + 1e-15,
    };
  };
  let s = Number.isFinite(proposed) && proposed > 0 ? proposed : fAtP;
  let halvings = 0;
  let r = test(s);
  while (!r.ok && halvings < 64) {
    s *= 0.5;
    halvings++;
    r = test(s);
  }
  if (!r.ok) {
    // 64 halvings without certification: the bound is infinite or
    // the field is pathological at p. Return the smallest tried step
    // uncertified; the march will exhaust its budget and report a
    // miss rather than a wrong hit, and slack reports the failure.
    return { step: s, bound: r.bound, slack: r.slack, halvings, queries };
  }
  let best = { step: s, bound: r.bound, slack: r.slack };
  for (let g = 0; g < 2; g++) {
    const grown = test(best.step * 1.5);
    if (!grown.ok) break;
    best = { step: best.step * 1.5, bound: grown.bound, slack: grown.slack };
  }
  return { step: best.step, bound: best.bound, slack: best.slack, halvings, queries };
}

/** March policy for marchInterval.
 *  'interval': certify-then-step (the guarantee above).
 *  'pointwise': step f(p) / L(p), L(p) the bound over a tiny box at p.
 *    No certification: the contrast the guarantee is measured against.
 *  'raw': step f(p), the classic sphere trace rule (the engine's
 *    'sphere' policy), included so the same fields can be graded
 *    under the current policy's step rule without a scene graph. */
export type IntervalPolicy = 'interval' | 'pointwise' | 'raw';

export interface IntervalMarchOpts {
  /** Step budget. Default 512. */
  steps?: number;
  /** Hit epsilon on the field value. Default 1e-3. */
  eps?: number;
  /** Max march distance. Default 100. */
  maxDist?: number;
  policy?: IntervalPolicy;
  /** Certification bound multiplier. Default 1 (honest). Below 1
   *  understates the bound and voids the guarantee (control only). */
  boundScale?: number;
  /** Record every sample distance, including the 0 start. */
  trace?: boolean;
}

export interface IntervalMarchResult {
  /** Hit distance, or Infinity on a miss. Under 'interval' with an
   *  honest bound this is never past the first true intersection:
   *  every accepted step is certified, so the stop point is strictly
   *  outside the surface and the error is one-sided (undershoot). */
  depth: number;
  /** March iterations taken (samples evaluated). */
  steps: number;
  /** Field evaluations taken (one per iteration). */
  evals: number;
  /** lipOverBox calls taken (proposals plus certifications). */
  boundQueries: number;
  /** f(origin) <= 0: the ray starts inside the field, no hit is
   *  reported (the analytic oracles share this contract). A sign-
   *  flipped field therefore produces no false hits, only this flag. */
  startedInside: boolean;
  /** Minimum certified slack over the march ('interval' only; NaN
   *  otherwise). Positive whenever a step was certified. */
  minSlack: number;
  /** Sample distances when opts.trace is set, starting with 0. */
  samples?: number[];
  /** Hit point when depth is finite. */
  point?: Vec3;
}

/**
 * March a ray against an IntervalField under the selected policy.
 * Deterministic: same field, ray and options give bit-identical
 * depths, step counts and traces.
 */
export function marchInterval(
  field: IntervalField,
  origin: Vec3,
  dir: Vec3,
  opts: IntervalMarchOpts = {},
): IntervalMarchResult {
  const steps = opts.steps ?? 512;
  const eps = opts.eps ?? 1e-3;
  const maxDist = opts.maxDist ?? 100;
  const policy = opts.policy ?? 'interval';
  const boundScale = opts.boundScale ?? 1;
  const samples: number[] | undefined = opts.trace ? [] : undefined;
  let evals = 0;
  let boundQueries = 0;
  let minSlack = Infinity;
  let t = 0;
  for (let i = 0; i < steps; i++) {
    const p: Vec3 = [
      origin[0] + dir[0] * t,
      origin[1] + dir[1] * t,
      origin[2] + dir[2] * t,
    ];
    const f = field.f(p);
    evals++;
    if (samples) samples.push(t);
    if (i === 0 && f <= 0) {
      return {
        depth: Infinity, steps: 0, evals, boundQueries,
        startedInside: true, minSlack: NaN, samples,
      };
    }
    if (f < eps) {
      return {
        depth: t, steps: i + 1, evals, boundQueries,
        startedInside: false,
        minSlack: policy === 'interval' && minSlack !== Infinity ? minSlack : NaN,
        samples, point: p,
      };
    }
    // Proposal: the pointwise step, f / L(p), with L(p) the bound
    // over a hair-sized box at p (the pointwise limit of the same
    // provider the interval policy certifies against). A zero or
    // non-finite pointwise bound falls back to the raw step f; the
    // certification, not the proposal, carries the guarantee.
    const r = 1e-9 * (1 + Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])));
    const lp = field.lipOverBox({
      min: [p[0] - r, p[1] - r, p[2] - r],
      max: [p[0] + r, p[1] + r, p[2] + r],
    });
    boundQueries++;
    let s = Number.isFinite(lp) && lp > 0 ? f / lp : f;
    if (!(s > 0)) s = f;
    if (policy === 'pointwise') {
      // No certification: the step is taken on the point's word alone.
    } else if (policy === 'raw') {
      s = f;
    } else {
      const c = certifyStep(field, p, dir, f, s, boundScale);
      boundQueries += c.queries;
      s = c.step;
      if (c.slack < minSlack) minSlack = c.slack;
    }
    // The step is deliberately not clamped to the remaining distance:
    // clamping makes it exactly 0 at t = maxDist and the march stalls
    // there until the budget exhausts (the unclamped form, shared with
    // sphereTrace and marchTerrain, steps past and exits; a certified
    // step that lands past maxDist still proves no crossing on the
    // way, so reporting a miss is exact, not approximate).
    t += s;
    if (t > maxDist) {
      return {
        depth: Infinity, steps: i + 1, evals, boundQueries,
        startedInside: false,
        minSlack: policy === 'interval' && minSlack !== Infinity ? minSlack : NaN,
        samples,
      };
    }
  }
  return {
    depth: Infinity, steps, evals, boundQueries,
    startedInside: false,
    minSlack: policy === 'interval' && minSlack !== Infinity ? minSlack : NaN,
    samples,
  };
}

/**
 * IntervalField over an SDF node tree: values from evalSdf, bounds
 * from localLipschitzBound, the closed-form per-operator interval
 * bound. A node family the bound does not cover reads as Infinity
 * (uncertifiable), never as a guessed number.
 */
export function sdfIntervalField(node: SdfNode, u: Uniforms = {}): IntervalField {
  return {
    f: (p: Vec3) => evalSdf(node, p, u).d,
    lipOverBox: (box: Aabb) => {
      const L = localLipschitzBound(node, box, u);
      return Number.isNaN(L) ? Infinity : L;
    },
  };
}

/**
 * IntervalField over a grid terrain: the field is the vertical gap
 * y - h(x, z), whose gradient is (-dh/dx, 1, -dh/dz), so a box bound
 * is sqrt(1 + S_B^2) with S_B the maximum per-patch slope bound over
 * the patches under the box's footprint. The march therefore steps
 * the same gap marchTerrain steps, but against the slope the step
 * actually crosses instead of the field-wide maximum.
 */
export function terrainIntervalField(field: GridTerrainField): IntervalField {
  const g = field.grid;
  const cs = g.cellSize;
  const ox = g.origin[0];
  const oz = g.origin[2];
  const W = g.width;
  const D = g.depth;
  return {
    f: (p: Vec3) => p[1] - field.heightAt(p[0], p[2]),
    lipOverBox: (box: Aabb) => {
      const uLo = (box.min[0] - ox) / cs - 0.5;
      const uHi = (box.max[0] - ox) / cs - 0.5;
      const vLo = (box.min[2] - oz) / cs - 0.5;
      const vHi = (box.max[2] - oz) / cs - 0.5;
      const clampI = (v: number, n: number): number =>
        Math.max(0, Math.min(n - 1, Math.floor(v)));
      const i0 = clampI(uLo, W);
      const i1 = clampI(uHi, W);
      const j0 = clampI(vLo, D);
      const j1 = clampI(vHi, D);
      let S = 0;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const b = field.patchSlopeBoundAt(ox + (i + 0.5) * cs, oz + (j + 0.5) * cs);
          if (b > S) S = b;
        }
      }
      return Math.sqrt(1 + S * S);
    },
  };
}

/**
 * Count violations of the interval bound itself: random point pairs
 * in the region, each graded against the bound over the pair's own
 * segment box, exactly the bound a march step between them would be
 * certified against. Zero is the expected result for an honest
 * provider; a nonzero count names the provider as understated.
 * Segments whose bound is infinite are skipped (an infinite bound
 * refuses certification, it cannot be violated). Deterministic
 * (seeded). Like every sampled checker here, this finds violations;
 * it cannot prove their absence.
 */
export function countIntervalBoundViolations(
  field: IntervalField,
  box: Aabb,
  pairs: number,
  seed: number,
): number {
  const g = new Pcg32(seed);
  const rnd = (): Vec3 => [
    box.min[0] + g.unit() * (box.max[0] - box.min[0]),
    box.min[1] + g.unit() * (box.max[1] - box.min[1]),
    box.min[2] + g.unit() * (box.max[2] - box.min[2]),
  ];
  let violations = 0;
  for (let i = 0; i < pairs; i++) {
    const a = rnd();
    const b = rnd();
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (dist === 0) continue;
    const L = field.lipOverBox(segmentBox(a, b));
    if (!Number.isFinite(L)) continue;
    const fa = field.f(a);
    const fb = field.f(b);
    if (Math.abs(fa - fb) > L * dist * (1 + 1e-9) + 1e-12) violations++;
  }
  return violations;
}
