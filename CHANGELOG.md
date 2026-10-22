# Changelog

All notable changes to the Polyglot Procedural Engine (PPE). The live demo at
https://frozen-in-flames.github.io/polyglot-procedural-engine/ tracks the latest release.

## [2.0.4] - Wald basin re-map on harder scenes (2026-10-22)

Patch release, step 4 of the road to v3.0.0. The change detector's
operating basin, mapped on scenes harder than the v1.9.1 bake-off
used, with one configuration fix the map indicted. No demo change:
nothing user-facing moved, and the demo is untouched.

**What.** New `test/wald-basin.test.ts` (7 tests) extends the
v1.9.1 scene generator with a specular lobe exponent and a clutter
mode knob (one-sided offsets at fixed density and magnitude, in
place of the legacy value replacement), then measures the default
Wald detector on 8 regimes x jump magnitudes 0.05 to 0.8 rad
(1.6 in three regimes): 100 seeded no-change trials per regime for
false alarms at the chi2 99% operating point, 40 trials per power
cell. In `src/inverse/changedetect.ts`: the Wald form's GM constant
is now `WALD_GM_C = 1.2` for its fit and its sandwich (score forms
keep c = 3.0; explicit `opts.c` still overrides all forms), and a
`covariance: 'naive'` option exists solely as the sandwich's
negative control. Full write-up in docs/change-detection.md.

**Why.** The v1.9.1 doc named the debt in its own limits: Wald
inherits the estimator's basin, so map it again on harder scenes.
The map found the failure the sentence predicted, in a new place.
At the v1.9.1 tuning, combined specular 1.5 + 40% one-sided bright
clutter false-alarms 52% (31/60) at the nominal 1% operating point:
the GM fit roams into a second basin that fits the dirt plateau
(dAz up to 0.73 rad, test statistic up to 10^3), and neither factor
breaks it alone. At c = 1.2 the dirt pixels lose their early pull
on the fit (GM weight at u = 3 falls about thirteenfold), the fit
stays home under the null, and the hole closes. The same map,
post-fix: false alarms 0/100 in seven regimes and 3/100 in the
worst (binomial bound 5/100), 2/100 on held-out seeds, and the 90%
detection boundary moves from 0.3 to 0.2 rad in every regime,
because the looser constant was also diluting the signal's own
moderate residuals (clean 0.2 rad power: 50% at c = 3.0, 100% at
c = 1.2). Power never falls out to 1.6 rad: no warm-start trapping
anywhere on the map.

**Measured pins.** Negative controls: the naive covariance
(V = H^-1, no sandwich) collapses to 25% power at 0.3 rad on all
three asymmetric-clutter regimes against the sandwich's 100%, at
unchanged false alarms, which is the sandwich's reason to exist
measured instead of asserted. Sign-flipped jumps detect at 100%
wherever positive ones do (the statistic is quadratic, magnitude
based). One control does not behave as the generic template
expects, and the release says so plainly: permuting the residuals
does not collapse Wald detection (shuffled changes still alarm
23-37 of 40 at 0.3 rad while shuffled nulls stay at 0 of 40),
because permutation preserves the residual marginals and the
Jacobian columns have nonzero spatial means, so marginal skew
projects coherently onto the parameters. It is pinned as a measured
exception in the test and a limit in the doc, not silently dropped.
Suite: 577/577 green (570 + 7 new), including the GLSL contract
tests; the v1.9.1 bake-off assertions pass unchanged at the new
tuning. Zero new runtime dependencies.

**Back-compat.** `detectChange` callers that pass no `c` get the
Wald form at the new constant; that is the fix, and it is the only
behavior change. Score forms, thresholds, the dof convention, and
every other module are untouched, as are default worlds and the
demo. The pre-fix behavior stays reachable and pinned: pass
`{ c: 3.0 }` and the combined-dirt hole reproduces at 31/60 in the
test suite.

## [2.0.3] - Terrain distance field (2026-10-22)

Patch release, step 3 of the road to v3.0.0. Grid worlds gain a terrain
reading: the per-cell heights as a smooth surface with a true distance
field, and a march policy that sphere-traces it.

**What.** New `src/scene/terrain-field.ts`. `makeGridTerrain(grid)`
builds a `GridTerrainField` over a grid world: one node at each cell
center (a solid cell contributes its per-cell height, an open cell 0),
bilinear between centers, constant extension beyond the outermost
centers. The field answers `heightAt`, `gradientAt`,
`patchSlopeBoundAt`, `nodeHeightAt`, and `distAt`: the conservative
signed distance `gap / sqrt(1 + S^2)`, where S is the maximum over all
patches of the proven per-patch bilinear slope bound
`sqrt(mx^2 + mz^2)` (a refinement of the `sqrt(2) m` form in
`src/geo/terrain-dist.ts`; derivation in the module header, pinned
against dense gradient sampling). `raycastTerrain` is the analytic
raycast against the surface (per-patch quadratic root; machine-precision
agreement with a brute-force gap scan). `marchTerrain` sphere-traces
the field. `MarchOpts.policy` gains `'terrain'`: grid layers march the
field instead of the DDA; SDF layers sphere-trace as before; 2d and
2.5d layers are untouched. The new API rides the package root.

**Why.** v2.0.2 gave every cell its own height, but the only ways to
march a heights world were the exact box DDA (stepped faces, no smooth
surface to step against) and fixed steps. Terrain needs a distance
field: a step-size oracle that is provably safe on slopes. The vertical
gap alone is not one (negative control: on a slope-3 plane, a raw-gap
march's first step lands at t = 5, deep inside a surface whose true
crossing is at 1.77). Dividing the gap by `sqrt(1 + S^2)` with a proven
slope bound is what makes the step a distance bound, so the march can
approach the surface but never cross it.

**Measured pins** (test/terrain-field.test.ts, 15 new tests). Flat and
constant-slope fields are exact to 1e-12, in both the distance and S.
On the pinned generated world (seed 777, S = 5.66): a 60-ray battery
against `raycastTerrain` never overshoots (worst stop 0.0133 short of
the analytic hit, inside the eps band; average 48.8 steps, max 586 on
one grazing ray). On a 41-ray fan through `marchScene`: terrain policy
1453 steps and 41 hits, sphere over the exact box distance
(`gridDistance`) 674 steps and 23 hits, fixed at 0.1 19163 steps and
23 hits; on the 23 rays all three hit, the totals are terrain 789,
sphere 312, fixed 1145. Each terrain step costs one bilinear patch
evaluation, against `gridDistance`'s full 256-cell scan per evaluation
on this world. Negative controls: the raw-gap march tunnels on the
steep plane (above), a sign-flipped field false-hits at t = 0, and the
un-divided gap violates conservativeness next to cliffs in the
dense-sampling test, so the bound is load-bearing. One real defect was
caught and fixed during the build: `gradientAt` returned the interior
patch's edge gradient inside the constant-extension strips, where the
true gradient component is zero; it is pinned by a dedicated strip
test. Suite: 570/570 green.

**Back-compat.** Default worlds and the default policy are
bit-identical to v2.0.2: `'terrain'` is opt-in per `marchScene` call,
grid layers under `'sphere'` and `'fixed'` take the exact DDA as
before (pinned against the v2.0.2 step case), and no existing API
changed shape. The shipped demo does not surface the new policy and is
untouched.

**Honest limits.** The terrain surface is a smoothed reading of the
stepped world, not the box geometry: on the pinned step ray at y = 2.5
the DDA returns 2.5 (the vertical face) and the terrain surface
returns 2.75 (where the ramp crosses); use the DDA for wall-exact
queries. S is a single global bound, so one steep cell shrinks steps
field-wide, and grazing rays against steep faces can need large step
budgets (the 586-step ray above) even though they never overshoot.
The field extends constantly beyond the outermost centers without
bound; maxDist is what fences a terrain ray's search.

## [2.0.2] - Per-cell grid heights (2026-10-20)

Patch release, step 2 of the road to v3.0.0. Grid worlds lose their one
documented v2.0.0 limit: walls are no longer one height per world.

**What.** `GridWorld` gains an optional `heights` array parallel to
`cells`; each solid cell becomes a box of its own height, spanning
`[origin.y, origin.y + heights[i]]`. `raycastGrid` dispatches on it: a
per-cell DDA walk intersects the ray's footprint interval over each
solid cell with the interval where the ray is inside that cell's own y
span, so a ray between two heights passes over the low cell and hits
the tall cell's face, and a descending ray lands on a cell's top face.
New `gridDistance(grid, p)` returns the exact distance to the nearest
wall box (a minimum of exact box distances, so it never overestimates
and sphere tracing it stays correct against the taller geometry).
`gridHeightAt` and `gridSetHeight` round out the API. Generation stays
opt-in: `generateGrid(seed, w, d, { heights: true, heightLevels })`
runs a heights pass after the cell pass, continuing the same Pcg32
stream (one draw per solid cell, levels default to multipliers
[0.5, 1, 1.5, 2] of the base height).

**Why.** One height per world forced every grid level into flat-topped
mazes. Per-cell heights let a dev build stepped, tiered worlds,
rooftops, and mesas from the same seed system and the same few hundred
bytes of level data, with exact raycasts and an exact distance field
that composites with the SDF layers as before.

**Back-compat.** Worlds without a heights array, or with every solid
cell at the world height, run the original v2.0.0 code path and are
bit-identical to v2.0.0; the suite verifies this with a ray battery
against plain twins, generated worlds included. Default generation is
untouched (the heights pass runs only on opt-in, after the cell pass),
so existing scenes and the live demo see the same worlds as before.

**Measured pins** (test/grid-heights.test.ts, 12 new tests). Step scene
(low top 1, tall top 3): a ray at y = 2 hits the tall face at exactly
2.5; straight-down rays land at exactly 4 and 2 on the two tops; a
descending ray lands on the tall top at 2.5 / 0.6 after overflying the
low cell; a camera above every height misses. Sphere tracing
`gridDistance` never overshoots the analytic hit on six pinned rays
(and lands within 0.01 of it). A negative control runs the step case
against uniform-height shims and gets the wrong answer both ways (low
cell at 1.5; clean miss), proving the pins read the per-cell heights.
Generation for seed 777 (16x16, density 0.3, base height 2) draws
levels 1, 2, 3, 4 exactly 28, 37, 25, 39 times over 129 solid cells,
cells bit-identical to the no-heights world. Suite: 555/555 green.

## [2.0.1] - Shader compile fix, pinned with contract tests (2026-10-20)

Patch release. The v2.0.0 live demo's raymarch fragment shader failed
compilation in real browsers (the fix itself landed in commit 8aa9af6;
this release packages it with its regression controls).

**Root cause.** Two GLSL ES 3.00 defect classes in the assembled
fragment shader. First, `buildRaymarchFragment` declared the
parameterized SDF uniforms a second time even though `sdfToGlsl`
already declares them inside its own GLSL; duplicate declarations are a
redefinition error. Second, numeric shader options were interpolated
as raw JS numbers, so the default maxDist emitted `t > 100`, a
float-vs-int comparison GLSL ES 3.00 rejects, and baked SDF values had
the same defect. The compile failure threw during module evaluation,
which killed the demo panel and the march loop. The escape reached the
owner because verification stopped at HTTP, grep, and Node checks, and
Node has no GL context.

**Fix.** `buildRaymarchFragment` now declares only the uniform names
the map GLSL does not declare itself, and emits eps and maxDist as
float literals; `sdf.ts` baked values (`glslVal`, plane height) emit as
float literals the same way. The demo pages also gained panel
close/reopen toggles (44px close button, compact Menu pill) so the
overlay panels no longer trap the touch joystick area on phones.

**Controls added.** `test/glsl-contract.test.ts` pins both defect
classes at the source-string level, each checker with a negative
control (planted defects it must catch) and a specificity control
(legal integer GLSL it must not flag). `docs/ship-gate.md` makes the
release verification control explicit: unit suite green, GLSL contract
tests, and a real-browser playthrough required before any release or
demo is reported done. The deployed FX demo bundle is preserved in
`demo/fx-live/` because its TypeScript sources were never committed to
main, so a rebuild from main cannot silently lose the panel. Suite:
543/543 green.

## [2.0.0] - Dev flexibility: building games with just math (2026-10-20)

Seven opt-in features; no default changes. 538/538 suite green (518 prior +
20 new, tests first). Full guide: docs/dev-flexibility.md.

**1. Grid worlds as a scene type** (new src/scene/grid.ts; `kind: 'grid'`
layer in src/scene/layers.ts). What: a level as a cell map (width x depth
cells, cell size, origin, wall height; solid cells are full-height wall
columns), composited by marchScene in one FOV with SDF layers, nearest hit
wins. Why: the smallest world representation that still plays, defined as
data instead of meshes, with the whole layer system on top. How:
`makeGrid` / `gridSet` to author, `generateGrid(seed, ...)` to generate, a
`GridLayer { kind: 'grid', grid, color(cellX, cellZ, side, p) }` to render;
`raycastGrid` is public for dev-side queries. Raycasts run an exact DDA in
the ground plane: axis hit pinned at exactly 5, 45-degree diagonal entry at
exactly 1.5 * sqrt(2); grid + sphere composite pins the nearer surface both
ways.

**2. March policy as a choice** (`MarchOpts.policy` in src/scene/layers.ts).
What: `'sphere'` (default, existing adaptive sphere tracing) or `'fixed'`
(fixed-step marching at `MarchOpts.fixedStep`) for SDF layers; analytic
layers are exact under either. Why: fixed-step has flat predictable cost and
a deliberate retro quantization for grid-flavored games and weak hardware,
with the error published instead of hidden. How: pass
`{ policy: 'fixed', fixedStep: 0.3, steps: 2000 }` to marchScene or set the
FrameMarcher dial. Measured budget (unit sphere at distance 5, 16-ray fan):
fixed step 0.1 max error 0.0984, inside the guaranteed one-step bound;
step 0.3 on the axis ray errs exactly 0.2; sphere tracing max error 0.00214
on the same fan. Honest limit: fixed-step tunnels through features thinner
than the step.

**3. Resolution as runtime dials** (new src/render/frame.ts, `FrameMarcher`).
What: a scanline column renderer owning a live params object: columns,
steps, maxDist, eps, fovY, policy, fixedStep. Mutate a dial, render again,
no rebuild. Why: one game scales across hardware by turning dials, and
quality becomes a runtime decision a dev (or player) can make live. How:
`new FrameMarcher({ columns: 90 })`, `marcher.render(cam, layers)`, then
`marcher.params.columns = 45` and render again. Defaults
(`DEFAULT_FRAME_PARAMS`) reproduce direct marchScene results bit-identically
column for column (pinned); columns and steps dial changes move the counts
exactly as specified (pinned via telemetry on a constant field).

**4. March telemetry API** (new src/render/telemetry.ts; `MarchOpts.stats`
counter in layers). What: per-ray steps, hit distance, and cost (field
evaluations) plus a frame aggregate that is exactly the sum of the per-ray
values. Cost convention: 1 per field eval, +6 for an SDF normal on a hit,
1 for an analytic layer. Why: performance becomes measured instead of
folklore; devs build debug views and auto-quality from the same numbers,
and the XR cost model gets measured inputs. How: read `frame.telemetry`
from any FrameMarcher render, or pass `{ stats }` in MarchOpts to any
marchScene call. Ground truth pinned: one column vs a unit sphere at
distance 5 gives steps 2, distance exactly 4, cost 8; a 90-column frame on
that scene measures 1068 evals, 32 hits.

**5. Seed-regenerable levels** (src/scene/grid.ts). What:
`generateGrid(seed, width, depth, { density, border })` builds a world from
a seed via the canonical Pcg32; `GridLevel.regenerate(newSeed)` replaces
the world completely. Why: a level becomes a shareable number; same seed
is bit-identical on every run and port, so daily-seed and endless modes
are trivial and a mid-game reset carries nothing over. How:
`new GridLevel(7, 16, 16, { density: 0.3, border: true })`, then
`level.regenerate(99)`. Pinned: same seed deep-equals, different seeds
differ, border ring always walled, regeneration equals a fresh generate of
the new seed exactly.

**6. Hookable render stages** (`FrameHooks` in src/render/frame.ts). What:
the render is dataflow (samples, hits, columns) and two hooks expose the
seams: `hitTest(ctx)` may return a LayerHit to override a ray's hit or
undefined to decline; `shadeColumn(ctx)` maps a finished column to its
final color. Both receive full context (index, nx, ray, the engine's own
hit, telemetry). Why: devs insert their own math (custom hit rules,
per-column fog/tinting, stylized shading) without forking the engine. How:
pass hooks as the third argument to `marcher.render(cam, layers, hooks)`.
Pinned: a doubling shade hook doubles colors exactly, a forced hit lands
at exactly its depth, declining or absent hooks leave output identical to
plain rendering.

**7. Write-once dev math blocks** (new src/dev/math.ts, exported from the
package root as the `dev` namespace). What: eleven pure closed-form
functions for game logic: clamp, clamp01, lerp, remap, smoothstep,
pingpong, invFalloff, pulse, hash01, cellIndex, inBounds. Why: the
polyglot promise extends to games built on the engine; blocks are exact
arithmetic or ride canonical exact paths (pulse on the polynomial sine,
hash01 on the PCG hash, smoothstep on the quintic fade), so a dev formula
behaves identically in every port. How: `import { dev } from
'.../src/index.js'` and compose, e.g. `dev.hash01(dev.cellIndex(x, z, w))`
for per-cell deterministic variety. Pinned: reference values
(smoothstep(0, 1, 0.25) = 0.103515625 exactly; hash01(42) =
0.28497612476348877) and a bit-identical determinism sweep over every
function.

Honest limits: the frame marcher renders one horizontal scanline (ny = 0),
not a full framebuffer (the WebGL raymarcher remains the full-frame
renderer); grid walls are one height per world (no per-cell heights yet);
telemetry cost counts field evaluations, not wall-clock time.

## [1.8.1] - Robust-estimation follow-up: GM tightness, NIS under outliers (2026-10-19)

Owner follow-up oracle (docs/oracles/test_robust_followup.py) ported to TS;
495/495 suite green (492 prior + 3 new, tests first). Three findings.
(a) GM statistical efficiency vs tightness c on clean noise: c=3.0 and c=6.0
cost nothing measurable vs l2, but tight c=1.0 costs 35-68% efficiency (it
redescends on clean Gaussian residuals too); efficiency improves
monotonically as c loosens. (b) Hardest condition from near starts: direct
GM gets 0.0% failures at every c vs 16.7% for Huber, and tighter c gives
smaller median errors on dirty data. Together: tight c wins on dirty data
and costs on clean data; c=3.0 stays the balanced default. (c) NIS change
detector at perfect prediction: plain residuals false-alarm massively under
outliers (z in the thousands); trimmed residuals (|r| < 3s) cut the
false-alarm z by 250-350x and hold the band on clutter, but the smooth
flanks of the specular lobe leak through (z=7.78 on specular, 32.99 on
spec+clutter). Trimming is now the default in the JIT change-detector path
(nisChange/nisStatistic, src/inverse/jit.ts); the v1.5.0 true-jump
detection still passes with it. Honest limits: Lambertian toy; 100/48/50
trials per check; trimmed NIS does not fully solve smooth outlier
structures.

## [1.8.0] - Dimensional layering: 2D, 2.5D, 3D, 4D in one field of view (2026-10-19)

New module src/scene/layers.ts: every scene element declares a dimensionality
and all composite through one raymarch loop. layer2D (billboard flat fields),
layer25D (plane layers with parallax as exact arithmetic, pinned to 1e-12),
solid3D (existing SDF path, unchanged), field4D (time-varying fields; 4D means
3D plus time). Discrete gameplay layers: a PlaneStack of depth planes the
player inhabits and hops between as pure depth translation. Inverse solvers
stay uniform across dimensions (a sprite tint and a light azimuth are both just
parameters). 492/492 suite green (476 prior + 16 new, tests first).
Honest limits: 4D ghosting bound holds only under the v1.3.0 steady-state
measurement; the layer fitter is not yet wired to the robust costs;
PlaneStack has no character-controller coupling yet; mixed-march performance
unmeasured.

## [1.7.0] - Robust estimation upgrades (2026-10-19)

Owner validation tracks (docs/oracles/conditional_qr_oracle.py,
docs/oracles/robust_cost_head2head.py) ported to TS; 476/476 suite green
(460 prior + 16 new). Two questions answered with measured head-to-heads.
(1) Mute vs explain: Geman-McClure (redescending) joins Huber (convex) as
IRLS Gauss-Newton options, plus GNC-annealed GM and huber-then-GM. On the
JIT toy with specular/clutter outliers, direct GM wins outright (4.2% fail
vs 54.2% for l2 on the hardest far case; median |az| 0.0036 vs 0.0740);
GNC and huber>gm do not beat direct GM here. The third arm models the
specular lobe with validated GGX pieces instead of muting it: it halves
l2's bias floor but loses to GM muting, because the saturation clip is
unmodeled. Lesson pinned: explain beats mute only when the explanation is
complete. (2) Conditional QR safeguard: fire the QR branch iff
eps*kappa(J^T J) > 1e-3. Silent on the light fit, SH-9 hemisphere, and
30/15deg caps; fires on the ill-conditioned 5deg cap; QR error <= NE error
across kappa(J) = 1e1..1e12. Honest finding: at realistic noise the
narrow-cap problems are statistically unidentifiable anyway, so the real
remedy there is the centered ridge prior (verified: centered beats
zero-centered), not the factorization. The QR branch is confirmed not dead
code and confirmed rarely needed.
Honest limits: Lambertian toy, Blinn-Phong generator vs GGX third arm,
24 trials per cell (owner runs 150); tau = 1e-3 pre-chosen, untuned.

## [1.6.0] - TEV functional materials (2026-10-19)

Closed-form material compression: a chain of K combiner stages,
C_out = (A - B) * C + D, with slots drawn from previous-stage output,
fitted constants, or field terms (n.l, n.v, n.h powers, SDF value, noise
octave). Nothing neural. Tests written before implementation; the identity
suite is green before the tag. Design note in docs/tev-materials.md.

- **Forward evaluator** (`src/material/tev.ts`): `tevEvaluate` runs the
  K-stage chain; `polyChainWiring` builds an alternating add/mul pattern
  (polynomials in the cycled inputs, degree grows with K).
- **Inverse fit** (`tevFit`): damped Gauss-Newton with central
  finite-difference Jacobians and backtracking; warm-start slot for
  continuing a previous solution.
- **Measured**: K=8 reaches 20.48 dB PSNR against a 20 dB bar on the
  procedural reference (K=0 constant: 12.88 dB). Negative controls pass:
  constant output and field-stripped wiring both fail the bar.
- **Honest finding**: higher K fits better in-sample but extrapolates
  worse past the training range (K=8: 11.3x train error held-out vs
  K=4: 2.4x); the extrapolation test pins K=4 against a 4x bar.
## [1.5.0] - JIT inverse rendering (2026-10-19)

Owner validation track (docs/oracles/test_jit_inverse.py) ported to TS with real
assertions; 453/453 suite green (443 prior + 10 new). New module src/inverse/jit.ts:
per-frame MAP Gauss-Newton steps equal to Kalman updates (TS agrees with owner's
Python to < 1e-9), warm starts (3.18 iters, 0 failures over 39 drifting frames vs
cold 9.23 iters, 23% failed), NIS change detection (z > 6 flags the jump on the
first frame, re-solve re-locks), subsampling error within 30% of the Cramer-Rao
1/sqrt(m) bound, one-shot SH-9 solve (hemisphere cond 24.3, noise scales x10.1 per
x10), geometry parameters (ellipsoid squash, analytic Jacobian) in the JIT loop,
model-mismatch stress (unmodeled specular leaves a 0.017 rad bias floor, not
noise), and measured timing (~4 ms/frame on the toy, linear in pixels).
Honest limits: Lambertian-only toy with matched generator; timing measured on the
toy in Node, not a device frame budget.

## [1.4.1] - V10.5 spec deltas (2026-10-19)

Owner validation oracles (SH, error-state filter) applied as spec deltas;
GGX already clean. Tests written before implementation; the identity suite
is green before the tag. Zero new dependencies.

- **Error-state filter, world-frame form** (`src/xr/camera.ts`): replaced
  the body-frame (right-error) filter with the world-frame (left) error
  form per the owner oracle. F = [[I, -dt R_hat], [0, I]],
  H = [R_hat^T [g_w]_x, 0], injection qhat <- Exp(dx_theta) tensor qhat,
  bhat <- bhat + dx_b, no reset Jacobian and no reset step. The body-frame
  form was overconfident (mean NEES 20 vs ~6); the world-frame form holds
  NEES inside the 99% band. New exports: quatExp, quatToMat3,
  esfPredictF, esfUpdateH, esfApplyCorrection. 7 tests.
- **SH irradiance** (`src/inverse/forward.ts`): E(n) clamped at 0 at the
  output (sharp-lobe Gibbs undershoot reaches ~3% of peak); no windowing
  anywhere on irradiance (audit clean). Policy documented in code: SH-9
  for soft sky and diffuse environment only, sharp lights stay analytic.
  Added shIrradianceRaw, SH_C shader constants, and shIrradianceShader
  (polynomial form, matches the general form exactly). 6 tests.
- **GGX audit**: the visibility form V = 1/((nl+s_l)(nv+s_v)) is the only
  form in every specular path (cookTorranceGgx, reference renderer); no
  leftover clamps on n.l / n.v. No code change; the v1.2.0 oracle port
  already covers it.

## [1.4.0] - V10.5 "Game feel" (2026-10-19)

Three game systems, math-first, zero new dependencies (minor version per
semver). Tests written before implementation; the identity suite is green
before the tag. New docs in docs/game-feel.md; the README is untouched
pending the authorized catch-up.

- **Fixed-timestep loop** (`src/game/loop.ts`): accumulator, fixed
  dt = 1/60 s, spiral-of-death clamp (max 5 ticks per frame, debt
  dropped), render interpolation alpha in [0, 1]. Identical frame
  sequences give identical tick streams. 5 tests.
- **Capsule character controller** (`src/game/character.ts`): two-sphere
  capsule vs the SDF field, penetration resolved along the field
  gradient, ground band r + groundEps, walkable slopes n.y >= slopeLimit
  with steeper slopes sliding via gravity plus contact resolve. Coyote
  ticks, jump buffering, and early-release jump cut defined
  mathematically in ticks; jump apex pinned to the exact discrete model.
  9 tests.
- **Deterministic input replay** (`src/game/replay.ts`): seeded per-tick
  input log (move, jump pressed/held, look delta) replayed through the
  identical tick function; final state bit-identical (ULP 0). 2 tests.

## [1.3.0] - V10.4 "Integrate all" (2026-10-18)

Eight integrated subsystems (minor version per semver). Tests written
before implementation; the identity suite is green before the tag. The
validation ledger in docs/methods-provenance.md marks every formula as
validated or unvalidated; the two incoming owner oracles (SH
white-environment E=pi, error-state filter vs simulated gyro bias) do
not block the tag and will be ported on arrival.

- **Noise derivatives** (`src/math/noisegrad.ts`): analytic 3D
  value-noise gradient, fBm chain rule, ||grad N|| bound with
  brute-force verification. 5 tests.
- **Conservative audit** (`src/math/conservative.ts`, scale3 in
  `src/math/sdf.ts`): every node audited against |f| <= true distance.
  7 tests.
- **Terrain distance** (`src/geo/terrain-dist.ts`): conservative
  heightfield distance. 4 tests.
- **Cost model + safe over-relaxation** (`src/math/overrelax.ts`):
  R_dot = 2WH f_r (1-rho_fov), grazing N = L ln(d0/eps)/gamma; 33%
  fewer steps, zero tunneling. 4 tests.
- **Geometry gradients** (`src/inverse/geograd.ts`): dt*/dtheta,
  dn/dtheta, 2D silhouette identities; 3D normal speed UNVALIDATED and
  throws. 3 tests.
- **VARPRO** (`src/inverse/varpro.ts`): merged rho*E, QR, Golub-Pereyra
  + Kaufman, rank cutoff policy. 5 tests.
- **Temporal stability** (`src/render/temporal.ts`): Halton, EMA,
  history clamps (ghost 0.051 -> 0.000/0.003), One Euro, spring with
  polynomial exp. 7 tests.
- **Acoustics** (`src/audio/acoustics.ts`): Monte Carlo volume/area,
  Sabine/Eyring, FDN, SN3D/ACN ambisonics. 6 tests.

## [1.2.0] - V10.3 "Add all: to the engine" (2026-10-18)

New subsystems (minor version per semver). Tests written before
implementation; the identity suite is green before the tag. The
validation ledger in docs/methods-provenance.md marks every formula
as validated or unvalidated.

- **Lipschitz bookkeeping** (`src/math/lipschitz.ts`): per-operator
  bounds table (rigid, scale, min/max, sum, displacement, warp, twist
  with bounded-region r_max, polynomial smooth-min); tighter local
  bounds via interval arithmetic over the ray-segment box;
  violation counting over random pairs. Measured looseness: warp
  1.06x, noise displacement 1.48x, twist 2.23x, noise-gradient 1.78x.
- **Normals** (`src/math/normals.ts`): tetrahedron technique (4
  evaluations, measured O(h), not the remembered O(h^2)) and central
  differences (O(h^2)) kept for comparison.
- **Rigid bodies** (`src/math/rigid.ts`): Rodrigues exponential map,
  quaternion integration (unit after 1e6 steps), Euler equations,
  symplectic Euler (pendulum energy bounded).
- **SDF collision** (`src/physics/collide.ts`): penetration, impulse
  with restitution, Coulomb friction, XPBD contact; dropped sphere
  rests at y = r within 1e-6 (sleeping threshold); e = 1 return
  height within O(h).
- **XR cameras** (`src/xr/camera.ts`): per-eye FOV tangents and IPD
  origins, position+rotation reprojection from march depth, plus the
  error-state attitude filter (quaternion + gyro bias; the linear
  Kalman form is dropped). Error-state gyro-bias oracle incoming.
- **Procedural audio** (`src/audio/theory.ts`): equal temperament,
  additive synthesis, RBJ low-pass biquad (DC gain 1), Karplus-Strong,
  PolyBLEP saw, Woodworth ITD, distance gain, Doppler, occlusion via
  the soft-shadow march.
- **Solver upgrades** (`src/inverse/robust.ts`): Huber/IRLS, LM
  gain-ratio acceptance, sigmoid bounds, Gaussian pyramid,
  Eikonal regularizer, uncertainty with 8-bit sigma_n = 1/(255 sqrt(12))
  and effective n. Parameter reduction z = V_k^T (theta - theta_bar)
  with curated manual names only (`src/inverse/reduction.ts`).
- **Reference renderer** (`src/render/reference.ts`): rendering
  equation with GGX importance sampling; white-furnace test never
  exceeds 1, falls below 1 at high roughness (documented, no
  multiple-scattering compensation).
- **Determinism harness** (`src/math/fperror.ts`): Kahan and Knuth
  2Sum, ULP distance with a defined NaN/infinity policy, FNV-1a
  goldens ("" and "foobar" = 0xBF9CF968, BigInt oracle), fixed-tree
  reductions.
- **Rate-distortion allocation** (`src/inverse/rdalloc.ts`):
  D_i = sqrt(12 n D/(p s_i)), b_i from ranges, SVD-basis form;
  measured vs predicted MSE increase agree.
- **GGX oracle port** (`test/ggx-oracle.test.ts`,
  `docs/oracles/ggx_oracle.py`): all six identities (D normalization,
  Smith masking, reciprocity, visibility V form, sampler moments,
  directional albedo). The V form 1/((nl+s_l)(nv+s_v)) is now the
  normative Cook-Torrance implementation (finite at grazing).

## [1.1.0] - V10.2 "Faithful forward model" (2026-10-18)

New shading families, solvers, and subsystems (minor version per semver).
Every claim points to a test or a reproducible number; the identity suite
is green before the tag.

- **Step relaxation from Lipschitz bounds** (`src/math/sdf.ts`):
  t_{k+1} = t_k + f/L; omega = 1/L from composed per-operator bounds,
  0.85 when no bound is known; explicit omega clamps to 1/L without the
  `allowUnsafeOmega` opt-in. Unit-length ray direction asserted at
  marcher entry. Validated against a fine-step reference march on
  warped and displaced fields.
- **Band-limiting** (`src/math/bandlimit.ts`): distance-scaled hit
  epsilon eps(t) = t * delta; smoothstep fBm octave fade (zero slope at
  the joints, finite dw/dt); displaced-noise bound
  L <= L_f + A L_N sum (2a)^k w_k; PCG-based value noise for all new
  noise paths.
- **Forward model and loss** (`src/inverse/forward.ts`,
  `src/inverse/losses.ts`): sRGB transfer contract with linearize
  helper (fit in linear light); Lanczos resolve with weights summing
  to 1; Cook-Torrance GGX (floored alpha, n.l, n.v; D integrates to 1);
  9-coefficient SH diffuse (constant white gives E = pi; Lambertian
  out = rho E / pi); structural L2 + texture-statistics loss (Hann
  window, epsilon in log spectrum, histogram W2).
- **Conditioning** (`src/inverse/conditioning.ts`, `src/inverse/solvers.ts`):
  SVD of the column-normalized finite-difference Jacobian at each
  solution, singular values/condition number/warnings in the solve log;
  albedo-intensity and generalized bas-relief null directions tested as
  identities; Tikhonov mu; LM exact step and the hit-point gradient
  dt*/dtheta documented as the upgrade path.
- **Model selection** (`src/inverse/selection.ts`): AIC/BIC with
  effective sample size (resolve-filter correlation discounted and
  documented), PSNR, L1 proximal soft-threshold, rate-distortion
  reports (gzipped bytes vs PSNR).
- **Determinism** (`src/math/determinism.ts`): PCG RXS-M-XS hash with
  Math.imul throughout (published reference vectors), quintic fade,
  polynomial sin/cos to 1e-9, canonical float32 via f32(); audit table
  in docs/methods-provenance.md.
- **XR costs** (`src/render/foveation.ts`, `src/render/raymarch.ts`):
  foveated radial step-budget falloff in the shader; rotation-only late
  reprojection and radial lens distortion as documented math; AO and
  soft shadows reconciled to their normative forms.

## [1.0.1] - V10.1 (2026-10-18)

Verified technical-review adoptions, all additive. No behavior removed;
every V10 capability and test still stands.

- **Sphere-tracing safety** (`src/math/sdf.ts`): under-relaxation
  t += omega * f, omega default 0.85 (`SDF_OMEGA`), `stepScale` kept as
  an alias. Per-operator Lipschitz documentation: primitives, union,
  intersect, subtract, translate, and uniform scale preserve the true
  SDF bound; exponential smin is a safe lower bound for 1-Lipschitz
  children; twist, displacement, and repeat can overestimate and tunnel
  at omega = 1. Unit-tested: a twisted thin slab that tunnels at
  omega = 1.0 converges at omega = 0.85. GPU side (`src/render/raymarch.ts`):
  the step scale is now a live `uStepScale` uniform with `setStepScale()`,
  defaulting to 0.85; demo Tuning Deck exposes `uOmega` (0.5 to 1.0).
- **Slider monotonicity** (`src/world/semantic.ts`): every
  g(u) = a*u^2 + b*u + c_0 mapping is validated for monotonicity on
  [0,1] at build time (fold-back iff b * (2a + b) < 0); u is clamped,
  and fold-backs fail loudly with a console warning naming slider and
  coefficient. All five shipped sliders validate monotone; tests cover
  folding, monotone, and edge cases.
- **Solver upgrade path** (`src/inverse/solvers.ts`): Levenberg-Marquardt
  documented as the upgrade path for the sum-of-squares solvers, with
  the math sketched (Gauss-Newton, damping schedule, dual numbers for
  framework-free Jacobians). The working gradient-descent solvers are
  unchanged. Header documents solver smoothness: solvers use the
  unshadowed Lambert baseline, so shadow discontinuities never enter a
  solve; finite-difference cost (one extra render per parameter per step)
  is recorded as the reason geometry-scale solves need the
  implicit-function-theorem path.
- **Framing honesty** (`docs/mvp.md`, `docs/methods-provenance.md`):
  the distinctive claim is now the combination (zero asset files,
  polyglot core, distilling solves into closed-form math), not pillar
  novelty. "KBs of formulas" is measured: the V10 experience is
  34,478 bytes gzipped (11,174 page JS + 23,304 gen.wasm, plus ~5 KB
  HTML), with the reproduce command in the docs. Neural-free stated
  precisely: no ML framework at runtime; style weights ship as baked
  constants in the distillation bundle and the MLP evaluator is off
  when the bundle has none; the V10 math-first path is neural-free
  outright. README's style-MLP line reconciled: ML tooling lives
  foundry-side (Python) per the two-sided design.

## [1.0.0] - V10 (2026-10-18)

The math-first MVP. The engine is defined by its own capability checklist
now (see docs/mvp.md): SDF math rendering, inverse solvers, the Tuning
Deck, semantic world building, scripting, physics, audio, and unified
input. Zero asset dependence throughout: every pixel is math.

- **SDF math library** (`src/math/sdf.ts`): primitives (sphere as
  ||x|| - r, box, torus, capsule, plane), booleans (union as min(f1,f2),
  exponential smooth-min, subtract, intersect), domain warping (repeat,
  twist, displacement), seeded value-noise/fbm. Sphere tracing per spec:
  t_{k+1} = t_k + f(o + t_k d) until f(x) < epsilon (1e-3) or t exceeds max
  distance (100). The same AST compiles to GLSL, so CPU and GPU evaluate
  the identical field.
- **SDF raymarching renderer** (`src/render/raymarch.ts`): WebGL2 fragment
  raymarcher returning depth and normal per ray (normals via central
  differences of f), with soft shadows and ambient occlusion computed from
  the field itself. Shaded/depth/normal debug views.
- **Inverse solvers** (`src/inverse/solvers.ts`): classical least squares
  plus gradient descent, finite-difference gradients (documented 1e-5
  step), no autodiff, no neural pipelines. Inverse lighting (intensities
  and colors), inverse light position (drags light_pos until the render
  matches, the acceptance-demo solver), inverse material fit with honest
  R^2 gating. Every solve logs iterations and residual; bad fits report
  failure, never silently. Documented limits: Lambertian baseline, known
  sample geometry, no shadows in the solve.
- **Tuning Deck** (`src/ui/tuning.ts`): parameter panel with sliders, dials,
  and curve editors driving world math live. Replaces the
  asset-browser/inspector concept: there are no files, only numbers.
- **Semantic world building** (`src/world/semantic.ts`): Organicness,
  Sharpness, Warp, Spread, Density, each mapping u in [0,1] through
  g(u) = a*u^2 + b*u + c_0 to coefficient bundles, with (a, b, c_0)
  documented per slider. Composable SDF blocks (mound, pillar, arch,
  stone field).
- **docs/mvp.md**: the engine's own MVP capability checklist, each item
  with what it does, how the math achieves it, honest limits, and future
  work. **docs/methods-provenance.md**: IP hygiene ledger recording that
  every V10 method is classical public mathematics implemented from first
  principles.
- **Acceptance demo** (`demo/v10.html`, live on GitHub Pages): the 4-step
  recipe end to end - SDF world, raymarch, Lambert, then the inverse
  solver dragging the light to a "brighter" target with the iteration log
  showing convergence. Tuning Deck drives it live; V9 input schemes drive
  the camera.
- Full suite green: 272/272 TypeScript (226 baseline plus 46 new),
  87/87 Python. Zero new runtime dependencies.

Honest limits: raymarching is bounded by the step budget (features below
epsilon can be missed); the lighting solver inverts the Lambert baseline
only; no rigid-body engine yet; real-headset XR verification stays an
honest open item.

## [0.9.0] - V9 (2026-10-15)

Controls work on all device types. V9 adds a unified input system: one camera
rig that every input scheme drives, with no per-device camera hacks.

- **CameraRig** (`src/input/rig.ts`): owns position plus yaw/pitch and writes
  the scene camera node each frame. Two modes: free-fly (default) and orbit
  (the classic drag-to-orbit view, kept as an alternative; WASD pans the
  orbit target).
- **Desktop scheme**: WASD plus arrow-key fallback to move, mouse look via
  pointer lock (click the scene), drag deltas as fallback, Q/E and Space for
  down/up, scroll to zoom in orbit mode.
- **Touch scheme**: left-half virtual joystick to move with an on-screen
  joystick overlay, right-half drag to look. Auto-shown on touch devices.
- **XR scheme**: WebXR session support with controller input. Left
  thumbstick moves, right thumbstick turns and rises/sinks, trigger rises.
  Look comes from the headset in immersive mode. Locomotion reaches the
  renderer through a reference-space offset, and the demo auto-switches to
  the XR scheme on session start and back on session end.
- **Auto-detection** with manual override: the demo picks desktop, touch, or
  XR from device capabilities and offers a visible Controls selector plus
  on-screen help listing the active scheme's controls.
- Zero new runtime dependencies. Full suite green: 226/226 (200 existing
  plus 26 new input tests, no network in tests).

Honest limits: WebXR locomotion and controller input are implemented against
the WebXR spec and unit-tested with injected controller snapshots, but have
not been verified on a real headset yet. Pointer lock requires a user click
and is unavailable in some embedded browsers, where drag look remains.

## [0.8.0] - V8 (2026-10-13)

The engine gets ears - zero audio files. V7 let the user own what they made;
V8 lets them hear it. A full procedural audio engine with zero asset
dependence: every oscillator, grain, and reverb tail is math evaluated at
runtime, seeded and deterministic, like every pixel already was.

### Per-language contributions

- **TypeScript** (`src/audio/`): the mix graph (`graph.ts` - master, music,
  SFX, and voice buses; bus gains are the conductor's faders), the extended
  spatial graph (`spatial.ts` - entity-bound emitters, reverb zones,
  occlusion), the conductor (`score.ts` - game-state vector to per-language
  layer gains as pure, unit-testable functions), the WASM DSP bridge
  (`dsp.ts`), the TypeScript sample-rendering mirror of the C++ core
  (`synth.ts`), and the offline foundry bundle loader (`foundry.ts`). Web
  Audio is a browser platform API, not a dependency.
- **C++ → WASM** (`native/gen/dsp/`): the DSP core - polyBLEP oscillator
  bank, FM operator stacks, granular engine (grains over synthesized
  sources, never loaded samples), Karplus-Strong plucks, modal resonator
  bells, filter suite, and generated impulse responses. Pure functions of
  (seed, params), double-precision phase, EMSCRIPTEN_KEEPALIVE exports,
  same toolchain as the noise core.
- **Python** (`python/xrgen/`): composition keeps its role - it composes,
  never renders. `AdaptiveComposer` (seed plus state vector to score doc),
  the `score.py` arrangement library (progression families, voice-leading,
  density curves; TypeScript mirrors the determinism-critical subset), and
  the offline `audio_foundry.py` (IR design, spectrum analysis, long-texture
  baking into JSON parameter bundles).
- **C#**: the arp + hats layer gains density control - hats thin out at low
  energy, the arp climbs octaves with brightness.
- **Swift**: the sparkle pings gain the orbit - pan paths widen with
  attunement, so the listener hears the space open up.
- **Kotlin**: the sub pulse stays the anchor - one clean voice on the low
  end, its drop deepening as tension rises.

### The conductor (`src/audio/score.ts`, `src/audio/graph.ts`)

The engine no longer loops a track; it performs one. A game-state vector
(energy, tension, attunement, brightness, tempo) drives per-language layers
with per-bar crossfades. Layers enter and leave whole - nothing hard-cuts;
the music breathes. Scripts push state one-way through the caps
(`caps.audio.mood(partial)`); the host validates, owns every node, and
plays.

### First Light: the resonance moment

The hidden attunement score - six thresholds, one per engine language -
becomes the conductor's deepest input, and it is heard, never shown. Level
by level the world answers: the sub pulse enters (the world gains a
heartbeat); the pad filter opens with brightness (the air clears); the arp
fades in tempo-locked to the wind's rhythm regions; the sparkle orbit
widens (the space itself feels larger); a sparse pentatonic melody enters,
calling toward the gate; and at resonance every layer retunes to a
just-intonation lattice on the gate's root (174.6 Hz). The beating between
detuned voices - present all game as texture - resolves into consonance.
The world tunes itself when the player does, and the opening is heard
before it is seen. Fight the wind and the path runs in reverse: the layers
thin out, the tuning loosens. The ear learns the mechanic the eyes never
explain. No UI, no numbers - a scripted playthrough reaching resonance is
the acceptance test you can hear with your eyes closed. The attunement
script pushes `{attunement, energy, tension, brightness}` every frame and
publishes the gate's root frequency through world state (`gate:rootFreq`).

### Score schema v1.1 (backward compatible)

`ScoreKind` grows additively (`pluck | ping | riser | gust | granular`);
old documents validate unchanged. New optional event fields, all
range-clamped: `attack`, `decay`, `filterFreq`, `reverbSend`.

### Spatial audio (`src/audio/spatial.ts` extended)

Entity-bound emitters on the scene graph, reverb zones with generated IRs
(seeded, cached per zone), occlusion from the existing colliders. 32-voice
budget with (loudness × proximity) priority stealing, documented.

### Verification

Verification: TS suite - 200 tests green (24 new audio-v8 tests); Python
suite - 87 tests green (32 new audio-v8 tests); C++ DSP renders - native
determinism suite all-pass plus WASM smoke test of all 8 xr_dsp_* exports;
`tsc` clean; zero new runtime dependencies.
Honestly remaining: real-headset audio, on-device provider wiring
(AVAudioEnvironmentNode, Oboe), long-session drift.

### The arc

See it (V1), play it (V4), build it (V5), own it (V6/V7), hear it (V8).

## [0.7.0] - V7 (2026-10-12)

Bring your own chain. V6 built the complete ownership system off-chain;
V7 lets the user anchor it on-chain wherever they choose. The engine stays
chain-agnostic the way it stays NVIDIA-agnostic: the platform spends $0,
the user pays their own gas only when they choose to mint on-chain, and
if the RPC is down the engine and all off-chain ownership keep working.

### EVM adapter (`src/own/evm.ts`)

Implements the V6 `ChainAdapter` interface with raw JSON-RPC and zero new
dependencies. EIP-1193 wallet connect (the engine stores no keys, ever),
gas estimation with EIP-1559 and legacy support quoted as decimal strings
before anything is submitted. ERC-721-style metadata is built from the
manifest; the token URI points at the manifest content hash while the full
manifest stays off-chain where copying is free. Two honest anchor modes:
contract mint (hand-rolled Keccak-256 and ABI encoding, validated against
published vectors; tokenId parsed from Transfer logs, never invented) and
calldata anchoring (a 0-value transaction to self carrying the mint id, for
use with no contract). `verifyAnchor` re-reads the chain and returns false
on mismatch instead of throwing. Kept out of `src/own/index.ts`: the core
surface stays chain-free and the adapter loads only when the user opts in.

### Platform-easy anchoring flow (`src/own/flow.ts`, workshop panel)

A UI-agnostic state machine (`idle` to `connecting` to `estimating` to
`awaiting-confirm` to `submitting` to `confirming` to `done`/`failed`) that
cannot advance past cost confirmation without an explicit user confirm:
the user always sees the price before paying it. The workshop demo gains
an opt-in "anchor on chain" panel (chain picker, wallet connect, cost
display, receipt view) that lazy-loads the adapter through a dynamic
import only when opened. Nothing is signed or spent silently, ever.

### Verification

175/175 TypeScript tests green (32 new: 20 EVM adapter, 12 flow),
55/55 Python tests green, `tsc` clean, zero new runtime dependencies.
Adapter tests run against a mock JSON-RPC transport: no real chain, no
real gas, $0. Honestly remaining: a real on-chain anchor (needs the user's
own wallet and their own gas), real headset test, real DLSS frame capture.

## [0.6.0] - V6 (2026-10-12)

Ownership, fully off-chain, at $0. V5 made building real; V6 makes owning
real. The arc: V1 proved the math, V4 proved the game, V5 proved the
building, V6 proves the ownership. See it, play it, build it, own it.

### Provenance graph (`src/own/provenance.ts`)

Every entity traces to its author and the operations that created it. Pure
functions over the V5 op log: entity to author to creation ops to
modification history, content-hashed, idempotent under replay and shuffle.
The world remembers whose hands shaped it.

### Signed minting, off-chain (`src/own/mint.ts`, `ed25519.ts`, `sha512.ts`)

A mint is a signed manifest: author, author key, creation ops, content hash,
license terms, timestamp. Ed25519 signatures from a vendored pure-TypeScript
implementation (zero new dependencies, runs identically in browser and
node), verified against RFC 8032 test vectors and cross-checked both ways
against Node's built-in crypto. Portable JSON, verifiable by anyone, no
chain, no gas. `verifyMint` never throws on hostile input.

### Rights the runtime respects (`src/own/rights.ts`)

License terms (`use`, `remix`, `commercial`, `resell`) travel in the
manifest, with presets `LICENSE_OPEN`, `LICENSE_NONCOMMERCIAL`,
`LICENSE_PERSONAL`. `RightsGate` enforces them at the spawn/remix/resell
seams: a license that is not enforced is a badge.

### Public registry (`src/own/registry.ts`, `registry/registry.json`)

Append-only signed list of minted works, hosted free in the repo. Entries
sorted by mint id for deterministic bytes; duplicate mint ids rejected;
the registry signature covers the whole list.

### Chain adapter interface (`src/own/chain.ts`, designed, NOT built)

Types only: `ChainAdapter` (`connect`, `estimateCost`, `anchor`,
`verifyAnchor`) plus `AnchorReceipt`. The engine never depends on a chain;
V7 implements one adapter per chain, the user picks, the user pays their
own gas, the platform stays $0.

### Verification

- `npx tsc` clean, `npm test` 143/143 green (48 new V6 tests: 9
  provenance, 6 SHA-512, 16 Ed25519, 17 mint/rights/registry).
- Zero new runtime dependencies. No node builtins in the runtime modules.
- Not in V6: anything on-chain, wallet code, a marketplace.

## [0.5.0] - V5 (2026-10-11)

Build inside the play session. V4 proved a player can become a dev; V5 makes
every session a dev session. Not an editor, an instrument: you do not
construct the world, you play it.

### In-session build tools (`src/build/`)

The instrument worn on the hands, invoking only the V4 capability API:

- **Field brush**: bend the local wind. Seeded, bounded, deterministic local
  offsets layered over the global field, multi-directional with varying
  force. Pure function of (seed, params); cosine falloff, hard zero at the
  radius edge.
- **Rhythm tuning**: blend the live global tempo with overlapping local
  regions (convex combination, always bounded).
- **Entity seeding**: `rock-cluster`, `light-well`, `ember-vent`. Plant a
  seed and the math grows the entity. Never places an asset; there are none.
- **Live behavior scripting**: compile and attach behavior scripts to living
  entities in-session. Fresh `node:vm` realm on the host (empty global, no
  process/require/fetch/timers, `Math.random` throws per the Cause-and-Effect
  law, Math/JSON frozen, 500ms compile timeout), Proxy membrane sealing
  capability facades. Malicious scripts contained, engine keeps running.
- **Fluent Instrument API**: `brush.at(x,z).with({...})`,
  `seed(kind).at(x,y,z).plant(seed)`, `behavior.on(id).attach(src)`.
  Every action emits one BuildOp on the shared op schema.

### Distributed state graph (`src/state/`)

Operation-based deterministic replication. No central authority.

- Hash-chained op log (`prev` = FNV-1a of the previous op); `GENESIS_PREV`
  starts every actor chain.
- The total order **(t, actor, seq)** - Lamport time, actor id, per-actor
  sequence - IS the conflict resolution. Two ops on the same target both
  apply; the later in the order wins on every node, every time.
- Idempotent apply, snapshot/restore, `stateHash` convergence proofs.
- Session-membership rule: foreign-seed ops rejected, one seed one ocean.

### Session proof (`games/workshop/`)

A live build session on the public surface only: one terrain zone, sky dome,
320 ember particles sampling the wind (global field + brush offsets from the
op log, the honest causal chain). Six deterministic phases, byte-identical
screenshots across runs: pristine world, the brush bends the wind, a seed
becomes stone, the rhythm quickens, the stone learns to breathe, two
builders one ocean (two StateNodes, shuffled delivery, identical stateHash).
Zero console errors.

95/95 TypeScript tests, 55/55 Python tests, zero new runtime dependencies.

## [0.4.0] - V4 step 3 in progress (2026-10-10)

FIRST LIGHT: one real game, built as an external developer would build it
- game code lives in `games/first-light/` and touches ONLY the public API
(`src/script`, `src/world`, engine public surface). Every gap the game
needed became a documented API fix in `src/`, not a workaround. The V4
proof: the platform holds.

### The game

First-person walker across the three sample zones, linked by portals.
Visible goal: gather wind-blown embers, carry them to the dark gate.
Hidden goal: **attunement** - a hidden 0–100 score rewarding embodied
prediction (A: velocity aligned with the local wind; B: standing where an
ember current will carry an ember within seconds; C: holding still as a
gust front passes). Felt, never explained: no UI, no numbers, no hints.
The gate brightens per ember delivered but OPENS only at attunement
level 6 (resonance, not collection). A plain-sight portal in mote-hollow
- crossable only by moving with a gust - leads to the foundry: six
in-world levers (TypeScript=scene, C++/WASM=genesis, Python=biome,
C#=tempo, Swift=light, Kotlin=presence), each writing its domain live
through top-tier grants while the composed world re-derives downstream.
The 7th lever is the player's own body stirring the field, legible in
the foundry's wake rings.

`games/first-light/`: `main.ts` (host), `world-view.ts` (dressing),
`zones.ts` (3 sample zones + foundry), `shared.ts`, 8 scripts
(player/embers/motes/attunement/gate/secret/foundry/levers), own
tsconfig + vite build. `test/first-light.test.ts`: 16 tests -
attunement scoring up/down, level emissions, gate open condition, ember
delivery brightening, secret-portal adoption + crossing, lever→domain
wiring + grant denial, portal auto-adoption, probe, onEvent tap.
Verified in headless Chromium (SwiftShader): boot, movement, gate
resonance, secret-portal crossing, lever adjust (C# tempo 2.0→2.75),
zero console errors; screenshots in `games/first-light/dist-shots/`.

### API fixes (in `src/`, all additive)

- `world.spawn` accepts procedural **`body` descriptors**
  (`SpawnBody`: sphere/box/cone/torus/octahedron/prism + material:
  baseColor/effects/unlit). New `src/script/bodies.ts` (engine-side
  builder - one geometry/material path for every backend),
  `sanitizeBody()` in the sandbox (dims clamped, effects allow-listed,
  `generatedBy` forced to the script name for provenance), `spawn` in both
  backends extended (`SceneEntityBackend` attaches a `Mesh`,
  `MemoryEntityBackend` records bodies for tests). Rationale: scripts
  could place invisible transforms only; a game needs visible things, and
  procedural descriptors keep the zero-asset law (no meshes smuggled in).
- **Script-portal auto-adoption**: `ComposedWorld.adoptScriptPortals()`
  scans runtime entities tagged `portal` carrying links and stitches them
  into the loader's portal set (nearest zone), running in `update()` when
  the roster changes. Closes the step-2 gap entry.
- **`caps.probe.ground(x, z)`**: host-registered terrain sampler, new
  `probe` capability (added to `ALL_CAPABILITIES`). Scripts keep the
  player/embers/motes/gate planted on procedural ground without reading
  engine internals.
- **`RuntimeOptions.onEvent`**: host tap on script-originated events
  (HUD/progression feed); host→script traffic is not re-tapped.
- **`EntityHandle.id` now populated** by `makeHandle` (the interface
  promised it; the runtime never set it).
- `renderer.ts` **`sphereInFrustum` fix**: meshes whose bounding-sphere
  center sat behind the camera were culled even when the camera was
  *inside* the sphere - the normal case for a walker on a 120-unit
  terrain, which rendered as missing ground. Now: center-behind-camera
  culls only when the camera is strictly outside the sphere.
- `GlobalField.setPlayerState` **no longer bumps the field revision**:
  player state is a live sample-time input to the wind field, not a
  derivation parameter. Bumping it invalidated every zone's derivations
  each frame (and leaked the player's momentary position into the
  anchor-mean probes). The 7th lever still works - the wake is evaluated
  per sample.

### Fixed
- Gate/portal torus rings now stand vertical (quarter-X rotation); the
  gate revolves slowly about world Y.
- Motes part around the walker (a mote inside the near plane smeared
  across the frame).
- The sun is aimed from the front-top so camera-facing slopes read in
  diffuse instead of ambient + a specular streak.

## [0.4.0] - V4 step 2 in progress (2026-10-10)

World composition: independently authored zones stitch into one coherent
world over a single shared seeded wind field. Local generation, global
coherence - the architectural law made mechanical.

### Added
- `src/world/` - zone descriptors, portals, the composed world loader, and
  the shared wind field:
  - `types.ts`: `ZoneDescriptor` (seed + generator params + bounds + wind
    weights + portal list) as PLAIN JSON - an independent developer authors
    a zone without touching engine internals. `parseZoneDescriptor`
    validates strictly and REJECTS any `wind.seed`: per-zone wind derives
    from the global field, never from an independent per-zone seed (the law,
    enforced at the door). The six live domain parameter sets
    (`scene/genesis/biome/tempo/light/presence`, one lever per language).
  - `wind.ts`: the global seeded procedural vector field -
    `W(p,t) = gain * Σ_k env_k(p) * gust_k(p,t) * dir_k(p,t)`, four layers,
    each with its own wavelength (14/22/34/52 units), temporal frequency,
    flow axis, amplitude, phase, and fbm force envelope, all drawn from
    mulberry32 mixed with the global seed. Multi-directional at every point,
    force varying across subsections, time-varying, bit-deterministic. The
    player's embodied state (position/speed/rhythm) stirs the field locally
    - the 7th lever - deterministically.
  - `field.ts`: `GlobalField` owns one `WindField` plus the six live domain
    params. `setDomain()` validates, merges, bumps `revision`, and notifies
    listeners: the foundry endgame's mechanical foundation. Wind's global
    gains ride the `genesis` lever (deep generation owns the weather).
  - `zones.ts`: `Zone` binds a descriptor to the shared field. Local wind =
    `global(p_world, t) * gustScale + anchorMean * biasWeight`, where
    `anchorMean` is the global field averaged over a probe ring at the zone
    anchor - the zone's prevailing wind read off the ocean, never invented.
    Terrain/sky derive from the zone seed XOR the live genesis seed, so the
    levers reshape them deterministically.
  - `portals.ts` / `loader.ts`: portals as first-class entities
    (transform + tag + engine-side `PortalLink`); `ComposedWorld` validates
    and stitches descriptor arrays, spawns portal entities, and drives
    handoff - the traveler keeps its entity id/name/tag, lands at the
    target zone's spawn, world-state persists, `portal:exit`/`portal:enter`
    fire, and a cooldown prevents bounce-back. Dangling links never
    teleport. Seam continuity is structural: every zone samples the same
    `GlobalField`, so `seamSample()` is bit-identical across zones.
  - `samples.ts`: three sample zones (ember-reach, mote-hollow,
    shimmer-flats) with distinct local character over one ocean, chained by
    portals.
- Terrain is the water: `src/geo/terrain.ts` gained an optional `shimmer`
  hook - a directional ripple baked into heights plus a normal lean along
  the local wind - and `Zone.buildTerrain()`/`windShimmer()` drive it from
  the field, so the wind's structure reads on the land itself.
- Script runtime extensions (minimal, additive - no redesign):
  - `Caps.field`: `wind(position, time)` read-only sample (`field.read`
    grant), `params()` live parameter copy, `set(domain, patch)` foundry
    write (matching `field.write.<domain>` grant).
  - `world.spawn` accepts `portal: { targetZone, targetSpawn, radius?,
    label? }` - scripts spawn/link first-class portals through their
    `world` capability.
  - Host-side `ScriptRuntime` methods for the loader: `spawnHost`,
    `hostEntities`, `hostGetTransform`/`hostSetTransform`, `portalLink`;
    `RuntimeOptions.field` lets hosts share one `GlobalField` between
    scripts and zones (default: built from the runtime seed).
- `test/world.test.ts`: 15 tests - determinism (independent stacks, same
  seed: identical snapshots, field samples, terrain), seam coherence,
  local-wind derivation law, portal transition (identity/state/events/
  cooldown/dangling links), wind multi-directionality + time variance +
  player wake, six-domain re-derivation (revision bumps, downstream effects,
  determinism), terrain wind texture, descriptor validation, script
  integration (grant-gated read/write, script-spawned portals).

### Fixed
- `sphere()` in `src/geo/parametric.ts` had inverted triangle winding
  (faces pointed inward while normals pointed outward): demo orbs and
  `rock()` rendered inside-out under culling, and `skyDome()`'s documented
  winding reversal double-inverted, rendering zero sky fragments from
  inside. One-line winding correction in `sphere()`; verified numerically
  (face·stored-normal avg +0.99 for sphere, +0.995 for skyDome). Found while
  verifying: `torus()` has the opposite inconsistency (outward winding,
  inward normals - correct culling, inverted lighting); left untouched for
  the rendering-closeouts lane.

### API gaps found (for step 3, First Light)
- (carried from step 1) spawn can't attach geometry/materials - CLOSED in
  step 3 via procedural `body` descriptors; behaviors are per-script not
  per-entity - unchanged (scripts coordinate via events/state);
  no physics/renderer queries - PARTLY closed via `caps.probe.ground`
  (terrain sampling); audio one-way - unchanged; no deterministic
  scheduler - unchanged.
- (new) Portal entities spawned by scripts are not auto-adopted into the
  loader's stitched set - CLOSED in step 3 via
  `ComposedWorld.adoptScriptPortals()`.

## [0.4.0] - V4 step 1 (2026-10-10)

### Rendering closeouts (stretch, parallel lane)
- `python/xrgen/geometry.py`: geometry-reconstruction prototype
  (stdlib-only, the other half of inverse rendering). `unproject_points()`
  turns depth/normal G-buffers into world points; `fit_base_plane()`
  finds the dominant plane (smallest perpendicular RMSE over the three
  axis trials); `fit_displacement()` fits the canonical fbm-hhash detail
  function to the residuals by exact least squares, reusing
  `inverse._dnoise`, so the already-mirrored runtime detail evaluator
  needs no new mirror. `reconstruct_geometry()` emits an `xr-geom/1`
  JSON bundle. Quality gate: displacement R² >= 0.70, coverage >= 0.50,
  and median |cos| >= 0.95 between fitted-analytic and measured normals;
  bad fits are flagged, never silently shipped. 15 synthetic CPU tests
  in `python/test/test_geometry.py`, all green.
- `Renderer.captureGBuffer()` now EXECUTED on real WebGL2 (headless
  Chromium 152, SwiftShader): `EXT_color_buffer_float` present, shaders
  compiled, 3x RGBA32F targets rendered and read back. Analytic quad
  probe: coverage exactly as predicted, depth err 7.8e-7, shading err
  1.4e-6, normals exact, UV err 2.4e-5; unlit materials write shading
  exactly 1.0. Details in INVERSE.md.
- Real DLSS frame capture: no `nvidia-smi`, no RTX hardware on this
  machine. Not attempted, not faked; remains UNVERIFIED by design.
- Found by the G-buffer execution (verified, fix pending in `src/geo`):
  `sphere()` has inverted triangle winding, so with `CULL_FACE` enabled
  spheres render inside-out (measured nearest depth 5.555 vs 4.63
  analytic; harness-side reversal measures 4.637). Affects demo orbs and
  `rock()`; `skyDome()`'s winding reversal double-inverts, so the sky
  dome renders zero fragments from inside -- the demo sky gradient and
  stars are currently invisible. One-line winding fix pending.

Sandboxed scripting runtime: the engine becomes a platform. Game logic is
written by strangers against ONE frozen capability object - no WebGL, no
DOM, no engine internals.

### Added
- `src/script/` - the sandboxed execution runtime:
  - `api.ts`: the capability API. `Caps` is the single object a script ever
    receives: seeded `rng` (mulberry32, mixed per script so script
    determinism matches engine determinism), read-only `time`, `world`
    (spawn/find/query/destroy + a procedural world-state store), `events`
    (global + per-entity bus; host injects input), `audio` (one-way note
    sink in the shared score schema), `log`. All JSONValue across the
    boundary, copied both ways. Graduated `CapabilityName` grants
    (`world.spawn`, `world.query`, `world.state`, `events`, `audio`, …) so
    authorship can be tiered later; the endgame foundry top tier decomposes
    into six per-domain write grants (`field.write.scene/genesis/biome/
    tempo/light/presence`, one per engine language). A `field` namespace is
    reserved for step 2's read-only environmental ("wind") field query.
  - `runtime.ts`: `ScriptRuntime` loads defs, builds each a frozen Caps,
    drives them from the main loop, and drains composed audio. Entity
    handles are sealed closures (no forgeable identity - entity ids live in
    an engine-side WeakMap, never on the handle). `MemoryEntityBackend` for
    tests, `SceneEntityBackend` for live scenes. Threat model, stated
    honestly: V4 guarantees capability-closure, not malicious-actor
    containment; full realm isolation is future work.
  - `refScripts.ts`: the C# `ScriptProvider` behaviors ported as reference
    scripts - `floatScript` (bob+spin, behavioral port of `FloatScript`) and
    `arpScript`/`hatsScript` (bit-exact ports of `ScoreComposer`: own
    SplitMix64 via BigInt, C# banker's rounding on the time grid).
- `test/script.test.ts`: 17 tests - functional (spawn/react/determinism/
  events/state/audio sink/unload), C# parity (composed events vs the
  committed `gen/csharp-score.json`: exact on t/dur/kind/gain, ±0.005 on
  freq across the Math.Pow boundary), graduated grants, and adversarial
  sandbox-boundary tests (frozen graph, no internals reachable, forged
  handles, snapshot isolation, input validation).
- Demo: 19th pipeline overlay row - `script runtime (sandbox)` - and the
  `float` reference script driving a visible ember in the live scene.

### API gaps found (for step 3, First Light)
- Scripts cannot attach geometry/materials - `spawn` creates transform-only
  entities; visible bodies are host-side. A game needs `world.spawn` with a
  procedural-geometry/material descriptor, or a mesh-authoring capability.
- No per-entity behavior attachment: behaviors are per-script (one
  update fn), not per-entity. A game wants `handle.onUpdate(fn)` or
  behavior components.
- No physics/renderer queries through caps (raycasts, colliders, picking) -
  input is host-injected events only.
- Audio is one-way: scripts cannot read playback position or loop phase.
- No timers/async through caps (deliberate for determinism, but a game will
  want a deterministic scheduler).

## [0.3.0] - V3 (2026-10-10)

Inverse rendering: distill super-resolved frames into procedural math.
Two-sided design: the foundry runs once, offline; the runtime keeps zero
dependencies on NVIDIA, Google Colab, DLSS, or any ML framework.

### Added
- `python/xrgen/inverse.py`: foundry module (stdlib-only). `splat_to_uv()`
  reprojects screen pixels into texture space (nearest-depth wins);
  `strip_lighting()` recovers albedo as observed / shading in linear space;
  `fit_material()` / `fit_height_style()` distill recovered detail into the
  engine's own procedural params by least squares. `make_bundle()` emits a
  plain JSON bundle, the only thing that crosses to the runtime.
- Distillation quality gate: R² (variance explained). Bad fits are recorded
  as failed, never silently shipped.
- `src/render/gbuffer.ts` + `Renderer.captureGBuffer()`: foundry-only
  UV/depth/normal/shading capture, flag-gated, out of the hot path.
- New `distill` material effect in the shader builder.
- `src/bridge/distill.ts`: bundle validation, `applyDistillationBundle()`,
  and a float64 TypeScript reference with a bit-exact Python mirror check.
- `INVERSE.md`: the two-sided design, the zero-dependency invariant, and
  both execution paths (own GPU is the official foundry; free Colab is the
  fallback).
- `docs/colab/v3-distillation.ipynb`: Colab fallback notebook.
- README: V3 section stating the execution paths in plain words.

### Design notes
- Detail function uses a polynomial hash, not sin-hash: `Math.sin` differs
  by 1 ulp between CPython and V8, which would break the bit-exact mirror.
- The fitter takes source detail params as input (known: the engine
  rendered the frame). Seed discovery by random search was tested and
  fails; foreign inputs use a canonical seed and the R² score reports the
  mismatch honestly.
- Base color / bias confound is documented: reconstruction is exact,
  parameter identity is not promised.

### Verification
- Python: 40/40 pass (26 new inverse-rendering tests, all synthetic/CPU).
  Also green on Colab's free T4 (15 GB VRAM).
- TypeScript: 28/28 pass, including the bit-exact Python↔TS mirror check.
- `tsc` and `vite build` clean. End-to-end foundry on synthetic data:
  R² = 0.908, passed; hard-edge checker correctly flagged as failed fit.

### Not yet verified
- Real DLSS frame capture (needs an RTX setup).
- The G-buffer GL code path (no WebGL on the build machine; type-checked
  only).
- Neural inverse rendering remains optional future work, not the core path.

## [0.2.0] - V2 (2026-10-10)

Engine depth: physics core, richer procedural generation.

### Added
- `src/physics/particles.ts`: seeded particle system (semi-implicit Euler,
  gravity, drag, terrain-heightfield collision with bounce + friction).
- Renderer: dynamic geometry path (`Geometry.dynamic` + version counter) so
  per-frame systems like particles can update GPU buffers.
- `src/geo/sky.ts`: procedural sky dome (gradient + hashed stars, no textures).
- New `sky` material effect in the shader builder.
- `src/geo/rocks.ts`: noise-displaced rocks, seeded scatter on the terrain.
- Demo: ember risers from the gate, falling motes that bounce on the terrain,
  sky dome, rock field. Pipeline overlay labels the new systems.

## [0.1.0] - V1 (2026-10-10)

First public release. Live demo: https://frozen-in-flames.github.io/polyglot-procedural-engine/

### What shipped
- TypeScript host: scene graph, procedural materials, WebGL2 renderer, WebXR
  sessions (VR/AR), inline desktop fallback, spatial WebAudio.
- C++ → WASM generation core: seeded simplex noise, FBM, heightfields, 1D
  noise, plus a seeded DSP bass voice (`xr_dsp_voice`).
- Python `xrgen`: ML generation (seeded style-MLP terrain transfer, latent
  sampling, biome weights) and the chords + melody score composer; JSON-lines
  bridge; bit-exact TypeScript mirrors.
- C#: `ScriptProvider` (compiles clean) and the arp + hats score composer.
- Swift: `VisionOSProvider` + `VisionAudioDriver` (interface-conformant).
- Kotlin: `AndroidXRProvider` + `AndroidXrAudioDriver` (interface-conformant).
- "First Light" demo with a pipeline overlay labeling which language
  generated what. Zero asset files.
- WHY.md: problems solved and technical differentiation.

### Bug fixes
- Demo build used absolute asset paths (`/assets/...`): broke on file:// and
  subpath hosting. Fixed with relative Vite `base: './'`.
- WASM loader used a `HEAD` fetch probe, then a bare `'gen/gen.js'`
  specifier: failed on file:// and resolved against the bundle URL in
  `assets/` instead of the page. Now resolves `gen/gen.js` against
  `document.baseURI` at runtime with no build-time resolution.
- `validateScore` rejected the C# score's camelCase `loopDur`; now accepts
  both `loop_dur` and `loopDur`.
- C++ DSP voice ran phase accumulation in float32, which drifted audibly and
  broke the TS mirror (max diff 0.11). Moved to float64: mirror is bit-exact.
- TypeScript `latent()` consumed the sin half of Box-Muller pairs, diverging
  from Python's cos-only `Rng.normal()`. Fixed to match exactly.
