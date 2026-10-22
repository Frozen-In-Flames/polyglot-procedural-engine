# Interval Lipschitz guaranteed step (v2.0.6)

The marching step in `src/math/interval-march.ts`, exposed for grid
layers as `MarchOpts.policy: 'interval'` and for any field with a
bounds provider as `marchInterval`. Step 6 of the road to v3.0.0.

## The guarantee

A step of length s from p along a ray is conservative when the field
cannot reach zero anywhere on the segment. If L_B is a Lipschitz
bound of f over a box B containing the segment, every point q of the
segment satisfies f(q) >= f(p) - L_B * s, so the step is certified
when

  f(p) > L_B * s,

and a certified step can approach the zero level set but never cross
it. That is the whole guarantee, and it is a statement about the
segment, not about the point: it holds for any field whose provider
bound is honest, including fields whose gradient grows without bound
near the surface.

The pointwise step s = f(p) / L(p), with L(p) the bound at the
current point, makes the same claim with the segment replaced by a
point. It is exact when the gradient ahead equals the gradient here
and overshoots whenever the gradient grows along the step:

- A field with slope 1 outside radius 2 and slope 6 inside (zero at
  radius 11/6): from outside, the pointwise step is the full outer
  gap and lands at radius 1, five sixths of a unit past the surface.
  Measured: pointwise and raw overshoot on 11 of 11 fan rays.
- A field f = k sign(d) sqrt|d| over a sphere's distance d, whose
  gradient blows up at the surface: the pointwise step from distance
  D is about 2D, so it tunnels clean through the sphere and out the
  far side. Measured: pointwise tunnels on 11 of 11 fan rays and
  reports no hit at all; raw reports hits at depths past the truth.
- A terrain cliff (flat approach, one slope-5 ramp): the local patch
  bound on the flat is 0, so the pointwise step is the full vertical
  gap at every sample, 0, 2, 4, 6, and the sample at 6 is inside the
  ramp's top, 0.6 past the analytic crossing at 5.4. This is the
  failure the v2.0.3 terrain header warns about ("a purely local
  patch bound would overestimate the distance next to a steep
  neighbor"), now measured, and the interval policy is its fix.
- The existing raw step (the 'sphere' policy's rule, s = f) on a
  twist scene whose bound grows with radius: overshoots on 6 of 10
  fan rays, worst sample 0.0797 past the brute-forced truth.

The interval march overshoots on none of these: 0 overshoots across
every battery, worst sample margin at or inside the true surface,
hit error one-sided (undershoot only), worst undershoot 6.4e-4 over
the SDF batteries and 2.3e-3 over the 60-ray rough-terrain fan
against the analytic raycast (the global-S march of v2.0.3 measured
0.0133 on the same fan). Every accepted step's slack
f(p) - L_B * s is positive by construction, and the march reports
the minimum slack it accepted.

## Algorithm: certify-then-step

1. Propose the pointwise step f(p) / L(p), with L(p) the provider's
   bound over a hair-sized box at p. The proposal is a heuristic;
   nothing about the guarantee rides on it.
2. Certify the proposal against the bound over the proposed
   segment's own box (inflated by a relative hair so endpoint
   rounding cannot put part of the segment outside the box). Accept
   when f(p) exceeds bound * step by a small relative guard.
3. On failure, halve and retest. Halving shrinks the box, so the
   bound can only tighten, and as s -> 0 the test tends to f(p) > 0:
   a certifiable step exists whenever the bound is finite near p.
4. After a certification, regrow by 1.5 (at most twice) and keep the
   largest certified step. The pointwise proposal is typically
   boundary-exact (slack near zero), so the first test usually fails
   on the guard alone; regrowth buys back most of that halving tax,
   and it also captures steps whose segment bound is smaller than
   the point's (stepping off a steep patch onto flat ground). Every
   grown step passes the same test against its own box.

Steps are deliberately not clamped to the remaining maxDist: a
clamp makes the step exactly 0 at the boundary and stalls the march
(the unclamped form, shared with sphereTrace and marchTerrain, steps
past and exits; a certified step landing past maxDist still proves
no crossing on the way, so the miss is exact).

## Providers (the proof obligations)

An `IntervalField` pairs f with `lipOverBox`, a certified bound over
any axis-aligned box; Infinity is an honest answer and certification
simply shrinks. Two ship:

- `sdfIntervalField(node)`: values from `evalSdf`, bounds from
  `localLipschitzBound`, the closed-form per-operator interval bound
  of `src/math/lipschitz.ts`. Node families the bound does not cover
  read as Infinity (uncertifiable), never as a guess.
- `terrainIntervalField(field)`: the field is the vertical gap
  y - h(x, z) with gradient (-dh/dx, 1, -dh/dz), so the bound over a
  box is sqrt(1 + S_B^2) with S_B the maximum per-patch slope bound
  under the box's footprint (the v2.0.3 patch bounds). The march
  steps the same gap the 'terrain' policy steps, priced by the slope
  the step crosses instead of the world's worst slope.

`countIntervalBoundViolations` is the sampled tripwire for the
obligation: random point pairs graded against the bound over their
own segment box. Honest providers measure 0 violations in 4000
pairs; the shell field with its bound halved measures 293; a
pointwise bound passed off as an interval bound measures 166. Like
every sampled checker in this codebase it finds violations, it does
not prove their absence; the closed-form bounds are the proof.

## Cost (measured, pinned in the suite)

Steps per ray, totals over each fan. The guarantee is the product;
the cost is reported, not hidden.

Rough terrain fan (60 rays, the v2.0.3 fan, seed 13), all at the
1e-3 gap band unless noted:

| policy | steps | overshoots | worst undershoot |
| --- | --- | --- | --- |
| pointwise (local patch bound) | 1916 | 12 of 60 | n/a (crosses) |
| interval (this release) | 2930 | 0 | 0.0023 |
| global-S terrain, matched band | 3456 | 0 | (v2.0.3: 0.0133 at its band) |
| global-S terrain, shipped band | 2925 | 0 | 0.0133 |

The interval march ties the shipped global march's step count while
stopping in a band sqrt(1 + S^2) = 5.7x tighter, and beats it by
about 15% at matched bands. Interval bound queries on the fan:
14356 (about 4.9 per step); they are counted in the scene stats as
evals, so the policy is not flattered by hiding them. On the cliff
ray the interval march takes 11 steps to the global march's 16.

SDF scene fan (41 aimed rays, twist + two spheres, all policies hit
all rays): raw 308 steps, pointwise 2124, interval 2301 steps plus
8116 bound queries. On a twist-bearing scene the bound is
radius-dominated, so bound-based stepping is intrinsically expensive
in the far field, and certification adds only about 8% over
pointwise; raw is 7.5x cheaper and, per the twist battery, wrong on
most rays. On an exact sphere SDF the same shape holds in miniature:
raw 3.6 avg steps, interval 7.4, the price of certifying steps that
did not need it.

## Negative controls (all pinned)

- `boundScale: 0.5` (the certification bound deliberately halved):
  the overshoots return, 12 of 12 shell fan rays and the cliff ray
  at depth 5.4706 against the analytic 5.4. Same marcher, same
  fields; only the bound's honesty changed.
- The bound checker catches understated providers (above).
- Sign-flipped fields: every battery ray reports startedInside with
  no hit. A naive marcher on the same flipped terrain field
  false-hits at t = 0 (the v2.0.3 failure mode), so the control has
  teeth.
- Determinism: the full battery re-run is bit-identical (depths,
  step counts, evals, bound queries, traces).

## Honest limits

- The bound is over the segment's axis-aligned box, not the segment
  itself. Diagonal segments in fields whose bound grows with radius
  (twist) pay for box corners the segment never visits; the far
  field of a twist scene is where the certified march costs most.
- The guarantee is exactly as strong as the provider's bound. For
  SDF trees that is the `localLipschitzBound` operator table; a node
  family it does not cover is uncertifiable (Infinity) and the
  march stalls to a miss rather than guessing.
- eps is a band on the field value, as elsewhere in the engine: the
  stop point is strictly outside the surface with f < eps, so the
  depth error is one-sided and at most the field's eps-to-distance
  conversion along the ray.
- Grazing rays still crawl: certification prevents crossing, it
  does not make near-tangent approaches cheap. Step budgets remain
  the caller's control.
- Scene integration is grid layers (policy 'interval'); SDF layers
  still sphere-trace in scenes, and devs holding a node tree call
  `marchInterval` over `sdfIntervalField` directly. The demo does
  not expose the new policy, so it is untouched and the ship gate's
  browser playthrough does not apply to this release.
