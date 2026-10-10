# Why this engine exists: the problems it solves

Every mainstream 3D engine, Unity, Unreal, Godot, is built around the same
core assumption: **a game is a collection of asset files.** Models, textures,
audio clips, animations. The engine's job is to import them, manage them,
compress them, stream them, and render them. Everything else, the editor,
the asset store, the import pipeline, the multi-gigabyte installs, exists
to serve that assumption.

This engine inverts it: **a world is a function.** Geometry, materials,
sound, and behavior are computed from seeds and math at runtime. There are
no asset files because there is nothing to store. That one inversion solves
several problems the industry treats as permanent.

## 1. The asset pipeline disappears

A conventional project spends a large fraction of its budget producing and
managing assets: modeling, texturing, licensing stock content, fixing broken
imports, waiting on builds that reprocess gigabytes of files. Here the
"content team" is a seeded function. The First Light demo renders terrain, a
gate, an orb field, shaders, and generative audio from roughly 35 KB of code
and compiled WASM. There is no import step, no library folder, no broken
reference ever.

## 2. No commercial ceiling

Asset-centric engines are businesses first. Their pricing, revenue shares,
runtime fees, and platform terms are load-bearing walls around your project.
A math function has no licensing department. Simplex noise, fractals, signed
distance fields, and the wave equation cannot be deprecated, re-licensed, or
bought out from under you. The engine answers to its owner, not a vendor.

## 3. Languages stop being silos

Unity is C#. Unreal is C++. Godot is GDScript. Each engine ties you to one
language and its ecosystem. This engine treats languages as swappable
modules behind narrow interfaces:

- `GenCore`: pure generation functions. C++ implements it, compiled to
  WebAssembly, called live from the host. Same source compiles native later.
- `MlProvider`: learned-function generation. Python implements it, a seeded
  neural net used as style transfer, latent sampling, mixture weights.
  TypeScript mirrors the math bit-exactly, so Python-generated parameters
  evaluate on any platform.
- `ScriptProvider`: scene behavior. C# implements it against a registry.
- `SessionProvider`: XR sessions. Swift implements it for visionOS, Kotlin
  for Android XR, TypeScript/WebXR hosts v1.

Each language does what it is best at. C++ crunches numbers. Python does ML.
C# scripts. Swift and Kotlin own their native platforms. TypeScript
orchestrates in the browser. No single language covers Quest, visionOS,
Android XR, PC VR, and the web, but the combination does, and the demo's
pipeline overlay shows each language's live contribution on screen.

## 4. Distribution weight collapses

A Unity or Unreal XR build ships megabytes to gigabytes and needs an
install. This engine's demo is ~24 KB of JavaScript plus ~10 KB of WASM,
loaded from a static page. It runs in any browser with WebXR: Quest
browser, desktop, phone AR, with zero install. The engine doesn't get
lighter than "there is nothing to download."

## 5. Determinism is free

Every generator is a pure function of (seed, params). The same seed builds
the same world on every machine, forever. That gives reproducible builds,
trivial multiplayer state sync (send seeds, not meshes), and testable
content, properties asset pipelines can only approximate with version
control and checksums.

## How it differs, technically, from what came before

| | Unity / Unreal / Godot | This engine |
|---|---|---|
| Source of truth | Asset files on disk | Seeded functions in code |
| Content scaling | More artists, more files | Larger seeds, deeper functions |
| Language model | One blessed language | Polyglot: interfaces, not ecosystems |
| Heavy compute | Native plugins per platform | C++ compiled once to WASM, runs everywhere |
| ML content | External tools, imported results | Python provider in the loop, parameters evaluated natively |
| Determinism | Best effort | Structural: pure functions throughout |
| Install size | MB to GB | KB |
| Vendor relationship | Licensee | None |

## Honest limits

This is v1, a proof, not a feature competitor. There is no visual editor,
no physics engine, no multiplayer netcode, no console deployment. Those are
real gaps. The bet is that they are easier to close in an engine with no
asset pipeline than in one built around it, because every system added here
is a function, not a file format.

Assets are obsolete. Math is innovation.
