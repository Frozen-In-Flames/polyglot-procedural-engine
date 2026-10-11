# Changelog

All notable changes to the xr-engine. The live demo at
https://frozen-in-flames.github.io/xr-engine/ tracks the latest release.

## [Unreleased] — V4 step 1 in progress (2026-10-10)

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
written by strangers against ONE frozen capability object — no WebGL, no
DOM, no engine internals.

### Added
- `src/script/` — the sandboxed execution runtime:
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
    handles are sealed closures (no forgeable identity — entity ids live in
    an engine-side WeakMap, never on the handle). `MemoryEntityBackend` for
    tests, `SceneEntityBackend` for live scenes. Threat model, stated
    honestly: V4 guarantees capability-closure, not malicious-actor
    containment; full realm isolation is future work.
  - `refScripts.ts`: the C# `ScriptProvider` behaviors ported as reference
    scripts — `floatScript` (bob+spin, behavioral port of `FloatScript`) and
    `arpScript`/`hatsScript` (bit-exact ports of `ScoreComposer`: own
    SplitMix64 via BigInt, C# banker's rounding on the time grid).
- `test/script.test.ts`: 17 tests — functional (spawn/react/determinism/
  events/state/audio sink/unload), C# parity (composed events vs the
  committed `gen/csharp-score.json`: exact on t/dur/kind/gain, ±0.005 on
  freq across the Math.Pow boundary), graduated grants, and adversarial
  sandbox-boundary tests (frozen graph, no internals reachable, forged
  handles, snapshot isolation, input validation).
- Demo: 19th pipeline overlay row — `script runtime (sandbox)` — and the
  `float` reference script driving a visible ember in the live scene.

### API gaps found (for step 3, First Light)
- Scripts cannot attach geometry/materials — `spawn` creates transform-only
  entities; visible bodies are host-side. A game needs `world.spawn` with a
  procedural-geometry/material descriptor, or a mesh-authoring capability.
- No per-entity behavior attachment: behaviors are per-script (one
  update fn), not per-entity. A game wants `handle.onUpdate(fn)` or
  behavior components.
- No physics/renderer queries through caps (raycasts, colliders, picking) —
  input is host-injected events only.
- Audio is one-way: scripts cannot read playback position or loop phase.
- No timers/async through caps (deliberate for determinism, but a game will
  want a deterministic scheduler).

## [0.3.0] — V3 (2026-10-10)

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

## [0.2.0] — V2 (2026-10-10)

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

## [0.1.0] — V1 (2026-10-10)

First public release. Live demo: https://frozen-in-flames.github.io/xr-engine/

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
