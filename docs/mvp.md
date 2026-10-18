# V10 "Math-First MVP": the engine's own capability checklist

Version 1.0.0 is the minimum viable product of the Polyglot Procedural
Engine, defined entirely in the engine's own terms. Each capability below
states what the engine does, how the math achieves it, its honest limits,
and what is future work. Zero asset dependence throughout: every item is
realized in code at runtime, never by importing a file.

## 1. SDF math rendering

**What it does.** Worlds are built from signed distance functions,
f: R^3 -> R, with positive values outside a shape, negative inside, and
zero on its surface. The renderer never sees a mesh; it marches rays
through the field and shades the surface it finds.

**How the math achieves it.** The SDF library (`src/math/sdf.ts`) gives
primitives (sphere as ||x|| - r, box, torus, capsule, plane), booleans
(union as min(f1, f2), exponential smooth-min for blends, subtract,
intersect), domain warping (repeat, twist, displacement), and seeded
value-noise/fbm. Rendering is sphere tracing: t_{k+1} = t_k + f(o + t_k d),
iterating until f(x) < epsilon (a hit) or t exceeds max distance. Epsilon
(1e-3), max distance (100), and max steps (128) are documented constants,
and the same AST compiles to GLSL so the CPU reference and the GPU shader
evaluate the identical field. The raymarcher (`src/render/raymarch.ts`)
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
