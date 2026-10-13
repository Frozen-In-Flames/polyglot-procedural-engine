# Polyglot Procedural Engine (PPE) — Architecture (v1, due Nov 10 2026)

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
| Python | ML core: trained generative models for content (terrain/style/texture synthesis), CV tooling for AR; serves parameters to every native target |
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
| C++ → WASM | Heavy procedural generation compiled to WebAssembly and called live from TypeScript: seeded noise fields, terrain heightfields, geometry synthesis. Audio: renders the seeded DSP bass voice (`xr_dsp_voice`) straight to samples. Measurably faster than JS, proving why the number-crunching lives here. |
| Python | ML generation: the seeded style MLP that reshapes the demo's terrain, latent sampling, biome mixture weights. Audio: composes the chords + melody score (`xrgen/audio.py`). Ships as `python/xrgen` (stdlib-only) with a JSON-lines bridge every language can spawn; TypeScript mirrors the forward pass bit-exactly so Python-generated weights evaluate anywhere. |
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
- **script** (V4) — sandboxed execution runtime: the platform surface. Scripts
  get exactly ONE frozen capability object (`Caps`): seeded RNG, read-only
  clock, entity spawn/query/transform, procedural world-state store, event
  bus, one-way audio sink. Sealed entity handles, graduated capability grants
  (tiered authorship; top tier decomposes into six per-domain
  `field.write.*` grants, one per engine language), and the `field`
  namespace: read-only shared wind-field sampling (`field.read`) plus the
  six per-domain foundry writes. Threat model:
  capability-closure, not malicious-actor containment. Reference scripts
  port the C# `ScriptProvider` behaviors (float bob+spin; bit-exact arp+hats
  composition).
- **games/first-light** (V4 step 3) — the proof game: a first-person
  perception game (gather embers, hidden attunement score, a gust-gated
  secret portal) plus a foundry endgame (six in-world levers, one per
  language/domain, writing live through `field.write.*` grants; the
  player's own motion stirs the field — the 7th lever). Written as an
  external developer would write it: game code lives in
  `games/first-light/` and touches only the public API (`src/script`,
  `src/world`, engine public surface). Every engine gap became an API fix
  in `src/` instead of a workaround: procedural `body` descriptors on
  `world.spawn` (visible things, zero assets), script-portal
  auto-adoption in `ComposedWorld`, `caps.probe.ground` terrain sampling,
  `RuntimeOptions.onEvent` host event tap. Renderer fix: frustum culling
  no longer drops meshes whose bounding sphere contains the camera.
  `GlobalField.setPlayerState` no longer bumps the field revision
  (player state is a live sample-time input, not a derivation parameter).
  See `games/first-light/README.md`.
- **build** (V5) — in-session build tools: the instrument, not an
  editor. Field brushes (seeded, bounded, multi-directional local wind
  offsets, pure functions of seed and params), rhythm tuning (convex blend of
  global tempo with local regions), entity seeding (`rock-cluster`,
  `light-well`, `ember-vent` grown from seeds, never placed), live behavior
  scripting (fresh `node:vm` realm on the host, `Math.random` throws,
  Proxy-membraned capability facades). Fluent `Instrument` API; every action
  emits one `BuildOp` on the shared op schema.
- **state** (V5) — distributed state graph: operation-based deterministic
  replication with no central authority. Hash-chained op log, total order
  (t, actor, seq) as the conflict-resolution law, idempotent apply,
  snapshot/restore, `stateHash` convergence proofs. One seed, one ocean:
  foreign-seed ops are rejected.
- **own** (V6) — off-chain ownership, $0 budget, zero new dependencies.
  Provenance graph (pure functions over the op log: entity to author to
  creation ops, content-hashed, idempotent). Signed minting: Ed25519
  manifests (vendored pure-TypeScript Ed25519 + SHA-512, RFC 8032 verified,
  cross-checked against Node crypto), portable JSON, verifiable by anyone,
  no chain, no gas. Rights: license terms (`use`/`remix`/`commercial`/
  `resell`) enforced by `RightsGate` at the spawn/remix/resell seams.
  Registry: append-only signed list (`registry/registry.json`), hosted
  free. V7 adds the chain layer: `evm.ts` implements `ChainAdapter` with
  raw JSON-RPC and zero new dependencies (EIP-1193 connect, EIP-1559/legacy
  gas quotes as decimal strings, ERC-721-style metadata from the manifest,
  contract-mint and calldata anchor modes, `verifyAnchor` re-reads the
  chain); `flow.ts` is a UI-agnostic anchoring state machine that cannot
  pass cost confirmation without explicit user confirm; the workshop demo
  has an opt-in anchor panel that lazy-loads the adapter. The core
  `src/own/index.ts` surface stays chain-free. Platform spends $0; the
  user pays their own gas only on explicit opt-in. Chain adapter: types-only interface for V7 (`ChainAdapter`,
  `AnchorReceipt`); the engine never depends on a chain.
- **games/workshop** (V5 step 3) — the session proof: a scripted live build
  session on the public surface only (terrain zone, sky, 320 wind-driven
  embers). Six deterministic phases with byte-identical screenshots:
  pristine, brush bends the wind, seed becomes stone, rhythm quickens,
  stone learns to breathe, two builders one ocean (two StateNodes, shuffled
  delivery, identical stateHash). Zero console errors.
- **world** (V4 step 2) — world composition over one shared seeded wind
  field. Zone descriptors are plain JSON (seed + generator params + bounds +
  wind weights + portals), validated on load; per-zone wind derives from the
  global field, never a per-zone seed. `GlobalField` holds the field plus the
  six live domain parameters (scene/genesis/biome/tempo/light/presence — the
  foundry levers, one per language) with revision-tracked downstream
  re-derivation. `ComposedWorld` stitches independently authored zones via
  first-class portal entities (handoff preserves entity identity and state).
  Terrain carries the wind's texture through the `shimmer` hook (directional
  ripple + normal lean): terrain is the water. Scripts sample the field via
  `caps.field.wind` (`field.read` grant) and write domains via
  `caps.field.set` (`field.write.*` grants); `world.spawn` accepts portal
  link options.

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
