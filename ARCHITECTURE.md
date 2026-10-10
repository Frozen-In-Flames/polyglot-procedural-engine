# XR Engine — Architecture (v1, due Nov 10 2026)

Personal engine for Aries. Not a company product. One vision, sliced so v1 actually ships.

## The vision

A VR/AR/MR/XR engine with **zero asset files**. No imported models, textures, or
audio. Every visual and sound is generated in code at runtime: parametric geometry,
shader-written materials, synthesized audio. If it can't be expressed as math, it
doesn't ship.

Long-term the core is polyglot: each language does what it's best at and the engine
scales to every platform natively.

| Language | Role (post-v1 slices) |
|---|---|
| TypeScript | v1 core: scene, procedural gen, WebXR runtime (this slice) |
| C++ | Performance core: software rasterizer fallback, DSP, physics |
| C# | Unity bridge: run engine scenes inside Unity for console/PC targets |
| Swift | visionOS native target (RealityKit/compositor bridge) |
| Kotlin | Android XR native target (OpenXR loader, Quest-class devices) |
| JavaScript | Already covered by TS; plain-JS embed for web pages |

## v1 scope (Nov 10): the polyglot proof

The whole point of v1 is to **demonstrate the languages working together to
replace assets**. So v1 is polyglot from day one, not TypeScript-only:

| Language | v1 role — real, working, in the demo |
|---|---|
| TypeScript | Host: scene graph, procedural materials, WebGL2 renderer, WebXR sessions, orchestration. Runs everywhere with a browser (Quest browser, desktop, phone AR). |
| C++ → WASM | Heavy procedural generation compiled to WebAssembly and called live from TypeScript: seeded noise fields, terrain heightfields, geometry synthesis. Measurably faster than JS, proving why the number-crunching lives here. |
| C# | Scripting provider implementing the engine's `ScriptProvider` interface (Unity-bridgeable later). Compiles as a .NET library in v1; wired to a runtime host post-v1. |
| Swift | visionOS provider stub implementing the `SessionProvider` interface against RealityKit types. Compiles where the Swift toolchain exists; full compositor wiring post-v1. |
| Kotlin | Android XR provider stub implementing `SessionProvider` against OpenXR mobile bindings. Same deal: compiles now, wires later. |

The demo scene labels which language generated what (a small "pipeline" overlay:
"terrain: C++, materials: TypeScript, ..."), so anyone watching *sees* the
cooperation. That visible pipeline IS the v1 deliverable, as much as the world itself.

### Modules

**TypeScript (`src/`):**
- **math** — vec2/3/4, mat4, quat. No dependencies. Column-major, WebGL convention.
- **scene** — node graph (parent/child transforms), component model
  (Mesh, Light, Camera, Script). Deterministic update order.
- **geo** — procedural geometry generators. Nothing loaded from disk:
  parametric surfaces (planes, spheres, tori, tubes along curves), heightfield
  terrain from seeded noise (noise itself computed in the C++ WASM module),
  particle clouds, fractal structures, text as signed-distance glyphs rendered
  to canvas at runtime (still generated, not an asset).
- **material** — procedural shader materials. Shader source is generated from
  node-composed snippets (color ramps, noise, fresnel, grid, wireframe).
- **render** — thin WebGL2 renderer owned by the engine (no Three.js): command
  list, frustum culling, forward lighting (1 dir + 4 point in v1). Exposes the
  `Renderer` interface so future C++/Vulkan or Swift/Metal backends slot in.
- **xr** — WebXR session manager: `immersive-vr`, `immersive-ar` (hit-test,
  anchors, plane detection where available), controller + hand input abstraction,
  graceful fallback to inline magic-window 3D when no headset is present.
  Exposes the `SessionProvider` interface the Swift/Kotlin providers implement.
- **audio** — WebAudio spatial graph (HRTF panning), synthesized SFX (no audio
  files), and the integration seam for the procedural music engine (`pmve`):
  engine scenes can drive generative music parameters per-frame.
- **bridge** — the FFI seams: WASM loader for the C++ module, `ScriptProvider`
  interface for C#, `SessionProvider` interface for Swift/Kotlin.

**C++ (`native/`)** — `gen/` procedural generation core: seeded simplex noise,
heightfield synthesis, mesh synthesis (grid/radial). Compiled to WASM for v1
(same code compiles to native later for the performance core). Pure functions of
(seed, params) — no I/O, no assets.

**C# (`dotnet/`)** — `ScriptProvider` implementation: scene scripts as C# classes
implementing the engine's script interface. v1: compiles, unit-tested against a
mock host.

**Swift (`swift/`)** — `VisionOSProvider`: `SessionProvider` conformance using
RealityKit/ARKit types. v1: compiles under the Swift toolchain; session wiring
is post-v1.

**Kotlin (`kotlin/`)** — `AndroidXRProvider`: `SessionProvider` against OpenXR
mobile bindings. v1: compiles; device wiring post-v1.

### The demo (`demo/`)

One scene that proves the thesis: a procedural world (terrain from the C++ WASM
noise core, structures, particles, reactive shader materials, generative music
hook) with zero asset files, plus the pipeline overlay naming the language
behind each system. Runs in VR, in AR (places the world on your floor via
hit-test), and on desktop as fallback. This is the acceptance test for v1.

## Non-goals for v1

Editor UI, multiplayer, physics beyond simple colliders, shadows,
post-processing stack, full native wiring of the Swift/Kotlin providers. Those
are post-v1 slices, prioritized after v1 proves the loop.
