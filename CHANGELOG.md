# Changelog

All notable changes to the xr-engine. The live demo at
https://frozen-in-flames.github.io/xr-engine/ tracks the latest release.

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
