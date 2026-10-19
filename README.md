# Polyglot Procedural Engine

**PPE** - a personal procedural VR/AR/MR/XR engine. Zero asset files: every visual
and sound is generated in code at runtime. The math builds the world; there is
zero asset dependence.

> **Why the name:** this project was formerly called "XR Engine." It was renamed
> to Polyglot Procedural Engine to match its unique value proposition: a
> polyglot core (TypeScript, C++, Python, C#, Swift, Kotlin) where every visual
> and sound is procedural, with zero asset files.

## Current state (v1.4.1, October 2026)

The V10 "math-first" series is shipped, v1.0.0 through v1.4.1:

- **v1.0.0** - Math-first MVP: SDF library (CPU + GLSL codegen), WebGL2 raymarcher, inverse solvers, tuning deck, semantic sliders.
- **v1.0.1** - Under-relaxed sphere tracing, per-operator Lipschitz docs, solver upgrade paths.
- **v1.1.0** - Faithful forward model (linear-light discipline, sRGB contract, Lanczos resolve), band-limiting, texture-statistics loss, Cook-Torrance + SH lighting, determinism audit.
- **v1.2.0** - Lipschitz operator table, tetrahedron normals, rigid-body dynamics, SDF collision + XPBD, XR per-eye reprojection, procedural audio DSP, robust solvers (Huber/IRLS, LM gain ratio), GGX reference renderer, determinism harness.
- **v1.3.0** - Noise-derivative Lipschitz bound, conservative-primitive audit, heightfield terrain distance, cost model + safe over-relaxation, geometry gradients, VARPRO variable projection, temporal stability, SDF-derived acoustics.
- **v1.4.0** - Game feel: fixed-timestep (1/60) loop, SDF capsule character controller, deterministic input replay (bit-identical).
- **v1.4.1** - Validation deltas: world-frame error-state filter (no reset), SH irradiance clamped at zero, GGX visibility-form audit.

**Tests:** 443/443 TypeScript tests green (identity suite; tests are written before implementation, and a version tags only when the suite is green). Python suite 87/87 at v1.0.0.

**Validation:** every formula is marked ✔ (validated against an independent reference) or ○ (from memory, untested) in `docs/methods-provenance.md` §5, the canonical ledger. Owner-supplied oracle scripts live in `docs/oracles/`; the ○ marks are the open validation list, worked in priority order.

**Honest limits:** not tested on a real headset yet. A few derivations remain ○ (3D silhouette normal speed, cross-language ports of newer modules) and are marked wherever they appear; unvalidated code paths throw rather than run.

## The polyglot pipeline

| Language | Role | Status |
|---|---|---|
| TypeScript | Host: scene graph, procedural materials, WebGL2 renderer, WebXR sessions, orchestration | Working |
| C++ → WASM | Heavy procedural generation (seeded simplex noise, heightfields) called live from TS | Working, tested |
| Python | Foundry-side: generation runs offline here only; the runtime never loads a model. Weights ship as baked constants in the distillation bundle, evaluated optionally by the runtime's small MLP path when present, off when not. JSON-lines bridge any language can spawn. Audio: composes the chords + melody score | Working, tested; TS mirror verified bit-exact |
| C# (.NET 8) | `ScriptProvider`: scene scripts as C# classes via a name registry. Audio: composes the arp + hats score | Compiles clean (0 warnings); host wiring post-v1 |
| Swift | `VisionOSProvider` (`SessionProvider`) + `VisionAudioDriver` (sparkle-ping score composer) | Interface-conformant; needs Xcode/visionOS SDK to compile |
| Kotlin | `AndroidXRProvider` (`SessionProvider`) + `AndroidXrAudioDriver` (sub-pulse score composer) | Interface-conformant; device wiring post-v1 |

## Layout

- `src/` - TypeScript core: `math/`, `scene/`, `geo/`, `material/`, `render/`,
  `xr/`, `audio/`, `game/` (fixed-timestep loop, character controller, replay),
  `inverse/` (solvers, forward model), `bridge/` (provider interfaces + WASM loader)
- `test/` - identity suite (443 tests), including oracle ports
- `docs/` - `methods-provenance.md` (validation ledger), `oracles/` (owner-supplied reference scripts), `mvp.md`, per-version design notes
- `native/gen/` - C++ procedural core (`gen.hpp`/`gen.cpp`), `build-wasm.sh`
- `dotnet/` - C# ScriptProvider
- `swift/` - visionOS provider
- `kotlin/` - Android XR provider
- `demo/` - "First Light" proof scene

## Verify

```bash
npm install
npm test               # full identity suite (443 tests), must be green
npm run build          # type-check the TS core

# C++ -> WASM (needs emsdk: source ~/emsdk/emsdk_env.sh)
./native/build-wasm.sh

# C# (needs .NET 8 SDK)
dotnet build dotnet/XrEngine.Providers

# demo (dev server with hot reload)
npx vite
```

## Demo

Live demo: https://frozen-in-flames.github.io/polyglot-procedural-engine/

The demo scene renders a procedural world with **no asset files on disk or network** - no models, no textures, no audio files. The only binary fetched is `gen.wasm`, which is compiled code, not content.

## Inverse rendering (active research)

Just-in-time inverse rendering, solving for scene parameters per frame under a fixed time budget, is active research in this repo. The owner's validation document is `docs/jit-inverse-rendering.md`; the reference script is `docs/oracles/test_jit_inverse.py`. Validated so far on a synthetic Lambertian-sphere toy: the per-frame MAP Gauss-Newton step (matches the Kalman update to 1e-13), warm-start convergence, innovation-based change detection, pixel subsampling against the Cramer-Rao bound, and one-shot SH light estimation. Timing, geometry parameters, and model-mismatch stress tests are open work. Nothing here is claimed beyond what the document states.

## License

Apache-2.0. See LICENSE.
