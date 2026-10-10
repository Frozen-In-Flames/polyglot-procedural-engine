# Changelog

All notable changes to the xr-engine. The live demo at
https://frozen-in-flames.github.io/xr-engine/ tracks the latest release.

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
