# V10 "Math-First MVP": the engine's own capability checklist

Version 1.0.0 is the minimum viable product of the Polyglot Procedural
Engine, defined entirely in the engine's own terms. The distinctive claim
is the combination, not novelty in the individual pillars: zero asset
files, a polyglot core (TypeScript, C++, Python, C#, Swift, Kotlin
mirrors), and distillation of solves into closed-form math. SDF
raymarching, least squares, and macro controls are each long-established;
what is new is shipping them together as one artifact where the stored
world is KBs of formulas: theta (the solved parameters) plus the shader
code, and nothing else. Each capability below states what the engine
does, how the math achieves it, its honest limits, and what is future
work. Zero asset dependence throughout: every item is realized in code
at runtime, never by importing a file.

## Measured: KBs of formulas

The whole V10 experience, gzipped, measured 2026-10-18:
- v10 page JS: 11,174 bytes gz
- gen.wasm: 23,304 bytes gz
- Total: 34,478 bytes gz (about 34.5 KB), plus the HTML page (~5 KB)

Re-measure with: `gzip -c dist-demo/assets/v10-*.js dist-demo/gen/gen.wasm | wc -c`

That is the stored artifact: a parameter vector and shader code, small
enough to read, audit, and transmit anywhere.

## 1. SDF math rendering

**What it does.** Worlds are built from signed distance functions,
f: R^3 -> R, with positive values outside a shape, negative inside, and
zero on its surface. The renderer never sees a mesh; it marches rays
through the field and shades the surface it finds.

**How the math achieves it.** The SDF library (`src/math/sdf.ts`) gives
primitives (sphere as ||x|| - r, box, torus, capsule, plane), booleans
(union as min(f1, f2), exponential smooth-min for blends, subtract,
intersect), domain warping (repeat, twist, displacement), and seeded
value-noise/fbm. Rendering is sphere tracing with under-relaxation:
t_{k+1} = t_k + omega * f(o + t_k d), omega = 0.85 (default), iterating
until f(x) < epsilon (a hit) or t exceeds max distance. Epsilon (1e-3),
max distance (100), and max steps (128) are documented constants, and
relaxation exists because warped operators (twist, displacement) can
overestimate the distance and tunnel at omega = 1; see the per-operator
Lipschitz notes in `src/math/sdf.ts`. The same AST compiles to GLSL so
the CPU reference and the GPU shader evaluate the identical field, with
the step scale as a live `uStepScale` uniform the Tuning Deck drives
(uOmega). The raymarcher (`src/render/raymarch.ts`)
returns depth and normal per ray, the normal from central differences of f,
and computes soft shadows and ambient occlusion from the field itself.

**Honest limits.** Raymarching is bounded by the step budget: thin
features smaller than epsilon can be missed, and complex worlds cost
proportionally more steps per pixel. The shader path needs WebGL2.

**Future work.** Spatial acceleration for deep SDF scenes, level-of-detail
selection driven by the field, multi-bounce lighting kept honest about cost.

## 2. Inverse solvers

**What it does.** Given target appearances, the engine solves for the
scene parameters that produce them: light positions and intensities from
target brightness samples, and procedural material coefficients from
target appearances.

**How the math achieves it.** Classical least squares on scene parameters:
L(theta) = 1/2 sum_j (R_j(theta) - y_j)^2 over target constraints y_j and
rendered output R_j parameterized by theta (primitive scales, blend
factors, light positions). The update is gradient descent,
theta^{(t+1)} = theta^{(t)} - eta * grad L(theta), with gradients from
central finite differences (documented step 1e-5, scaled per coordinate);
no autodiff library, no neural pipeline. The shading model inverted is
the raymarcher's own baseline, Lambert R_j = dot(n, l). Every solve is
deterministic and logs iterations, residual, and RMSE, so the solve is
visible, never a black box. Bad fits are reported as failed (RMSE or R^2
gates), never shipped silently. See `src/inverse/solvers.ts` and the V10
section of INVERSE.md.

**Neural-free, precisely.** No ML framework at runtime. Where the
foundry fits style weights, they ship as baked constants inside the
distillation bundle, never as model files; the small MLP evaluator is
optional and stays off when the bundle has no style weights. The V10
math-first path above (SDF + classical solvers) is neural-free outright:
nothing in it learns, and nothing in it can learn.

**Honest limits.** The lighting model is Lambertian with known sample
positions and normals: no shadows, no interreflection, no specular in the
solve. Light-position solving is non-convex, so the start position matters
and the log must be read. Material fitting only covers models linear in
their parameters.

**Future work.** Shadow-aware and specular-aware solves, multi-light joint
optimization, solver-guided primitive placement.

## 3. Tuning Deck

**What it does.** A parameter panel where every world math parameter gets
real sliders, dials, and curves with live updates. It replaces the
asset-browser/inspector concept entirely: there are no files to inspect,
only numbers that shape the field, so the panel edits the numbers.

**How the math achieves it.** `src/ui/tuning.ts` provides a DOM-agnostic
parameter registry (clamped ranges, steps, change listeners, snapshots)
and piecewise-linear curve parameters, plus a DOM binding that renders
sliders, rotary dials, and draggable curve canvases. Scalar SDF parameters
can be declared as live uniform references, so a slider moves straight
into the compiled shader without recompilation.

**Honest limits.** The deck edits numbers, not structure: it cannot add a
primitive to the AST, only reshape the ones already there. Curve
resolution is bounded by the control-point count.

**Future work.** Structural editing of the SDF AST from the deck, preset
morphing between saved parameter states, MIDI/OSC control binding.

## 4. Semantic world building

**What it does.** Human-readable concepts (Organicness, Sharpness, Warp,
Spread, Density) map transparently onto the underlying math variables, and
composable blocks (mound, pillar, arch, stone field) stack into worlds, so
creators build without touching raw equations.

**How the math achieves it.** Each control u in [0,1] maps through
g(u) = a*u^2 + b*u + c_0 to a coefficient bundle, and the triple
(a, b, c_0) is documented per slider (`src/world/semantic.ts`), so the
translation from concept to math stays inspectable. Blocks are SDF
combinators: stacking is union/smooth-union, distortion is domain warping.

**Honest limits.** Five sliders cover broad strokes, not fine art
direction; the mapping triples are hand-tuned, not learned. Semantics
cannot express structure the block library does not contain.

**Future work.** More sliders and blocks, slider-to-slider coupling rules,
foundry-side search over semantic space with the inverse solvers scoring
matches.

## 5. Scripting

**What it does.** Worlds run behavior: entities move, react, and link
together through scripts written against a capability-gated API.

**How the math achieves it.** `src/script/` runs sandboxed scripts with
explicit grants; scripts sample world fields (wind, portals) and write to
foundry domains through six write grants. Behavior stays procedural:
nothing is keyframed from an imported file.

**Honest limits.** The scripting API is small by design; grant-gating
means a script can only touch what the world offers it.

**Future work.** Visual script graph compiled to the same runtime,
hot-reload of script modules, deeper world-query API.

## 6. Physics

**What it does.** Particles and simple bodies move, collide softly, and
settle under procedural forces.

**How the math achieves it.** `src/physics/` integrates particle systems
on the CPU with deterministic seeds; colliders are analytic shapes from
the math library, so collision queries are closed-form distances, never
mesh tests.

**Honest limits.** No rigid-body engine yet: no stacking, friction, or
joints. Particle counts are CPU-bounded.

**Future work.** A rigid-body solver in the same zero-asset spirit,
GPU particle integration, SDF-native collision for arbitrary worlds.

## 7. Audio

**What it does.** Worlds sound like themselves: synthesized instruments,
spatial placement, and generative scores, all computed at runtime.

**How the math achieves it.** `src/audio/` synthesizes oscillators,
filters, and effects from DSP code, places them in space with HRTF-style
panning, and drives generative scores from seeded procedures. See
docs/V8-AUDIO.md.

**Honest limits.** Synthesis, not sampling: acoustic realism is bounded by
the models, and complex scores cost CPU.

**Future work.** Foundry-baked procedural impulse responses, deeper
generative composition, audio-reactive world parameters through the
Tuning Deck.

## 8. Unified input

**What it does.** One camera rig drives every device: desktop WASD plus
mouse, touch joystick plus drag, and XR controllers all steer the same
world.

**How the math achieves it.** `src/input/` detects capabilities, picks a
scheme (desktop, touch, XR), and feeds a single rig. The demo worlds keep
working across devices with zero per-device world code.

**Honest limits.** XR runs through WebXR where the browser supports it;
real-headset verification is an honest open item, not a claimed one.

**Future work.** Real-headset verification pass, haptics hooks, eye-gaze
as a Tuning Deck input.

---

## Acceptance recipe (the demo that proves it)

`demo/v10.html` runs the four steps end to end: (1) an f_world built from
four SDF primitives blended with exponential smin; (2) the raymarcher
returning depth and normal per ray; (3) Lambert shading as the baseline;
(4) a target ("this pixel brighter") handed to the inverse solver, which
drags the light position until the render matches, with the iteration log
showing convergence. The Tuning Deck drives the same world live beside it.

---

## V10.2 "Faithful forward model" (1.1.0)

New shading families, solvers, and subsystems: a minor-version change.
Every claim below points to a test or a reproducible number.

- **Step relaxation from Lipschitz bounds** (`src/math/sdf.ts`): the
  marcher advances t += f/L with omega = 1/L from composed per-operator
  bounds (primitives 1, min/max, twist 1+|k|r_max, displacement
  L_f + A L_N sum (2a)^k w_k), defaulting to 0.85 when no bound is
  known. Explicit omega clamps to 1/L without the `allowUnsafeOmega`
  opt-in. Validated against a brute-force fine-step reference march on
  warped and displaced fields (test/bandlimit.test.ts).
- **Band-limiting** (`src/math/bandlimit.ts`): hit epsilon scales as
  eps(t) = t * delta (delta = 2 tan(fov/2)/H); fBm octaves fade with a
  smoothstep (zero slope at the joints) once past quarter-Nyquist.
  Far surfaces stop shimmering; step counts drop with distance (tested).
- **Forward model and loss** (`src/inverse/forward.ts`,
  `src/inverse/losses.ts`): sRGB transfer contract (fit in linear
  light; encode/decode round-trips tested), Lanczos resolve
  (weights sum to 1, tested), Cook-Torrance GGX with floors (D
  integrates to 1 over the hemisphere, tested), 9-coefficient SH
  diffuse (constant white gives E = pi, tested; Lambertian out is
  rho E / pi), structural L2 plus texture-statistics loss
  (log power-spectrum rings with Hann window + histogram W2; converges
  on noise textures where pixel L2 does not, tested).
- **Conditioning diagnostics** (`src/inverse/conditioning.ts`,
  `src/inverse/solvers.ts`): SVD of the column-normalized
  finite-difference Jacobian at every solution, reported in the solve
  log with warnings on near-zero directions. The albedo-intensity null
  direction and the generalized bas-relief identity are tested as
  identities. Tikhonov mu available as the documented fix.
- **Model selection** (`src/inverse/selection.ts`): AIC/BIC with
  effective sample size (discounted for the resolve filter's
  correlation window, documented), PSNR, L1 proximal soft-threshold,
  and rate-distortion reports (bytes vs PSNR) that extend the KBs of
  formulas measurement.
- **Determinism** (`src/math/determinism.ts`): PCG RXS-M-XS hash
  (Math.imul throughout; reference vectors tested), quintic fade,
  polynomial sin/cos to 1e-9, canonical float32 enforcement via
  f32(). The audit table lives in docs/methods-provenance.md section 4.
- **XR cost control** (`src/render/foveation.ts`,
  `src/render/raymarch.ts`): radial step-budget falloff
  N(e) = N_0/(1+e/2.3deg) in the raymarcher; rotation-only late
  reprojection and radial lens distortion as documented math.
- **Renderer reconciliation**: ambient occlusion and soft shadows now
  match their normative forms exactly
  (AO = clamp(1-k sum 2^-i (h_i-f(p+h_i n))); s = clamp(min k f/t_i)),
  with larger k = harder shadow edges.
