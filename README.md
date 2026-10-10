# xr-engine

Personal procedural VR/AR/MR/XR engine. Zero asset files: every visual and
sound is generated in code at runtime. The point of v1 is the **proof** — all
languages working together to replace assets entirely.

## The polyglot pipeline (v1)

| Language | Role in v1 | Status |
|---|---|---|
| TypeScript | Host: scene graph, procedural materials, WebGL2 renderer, WebXR sessions, orchestration | Working |
| C++ → WASM | Heavy procedural generation (seeded simplex noise, heightfields) called live from TS | Working, tested |
| Python | ML generation: latent sampling, seeded style-MLP transfer over terrain, biome mixture weights; JSON-lines bridge any language can spawn. Audio: composes the chords + melody score | Working, tested; TS mirror verified bit-exact |
| C# (.NET 8) | `ScriptProvider`: scene scripts as C# classes via a name registry. Audio: composes the arp + hats score | Compiles clean (0 warnings); host wiring post-v1 |
| Swift | `VisionOSProvider` (`SessionProvider`) + `VisionAudioDriver` (sparkle-ping score composer) | Interface-conformant; needs Xcode/visionOS SDK to compile |
| Kotlin | `AndroidXRProvider` (`SessionProvider`) + `AndroidXrAudioDriver` (sub-pulse score composer) | Interface-conformant; device wiring post-v1 |

## Layout

- `src/` — TypeScript core: `math/`, `scene/`, `geo/`, `material/`, `render/`,
  `xr/`, `audio/`, `bridge/` (provider interfaces + WASM loader)
- `native/gen/` — C++ procedural core (`gen.hpp`/`gen.cpp`), `build-wasm.sh`
- `dotnet/` — C# ScriptProvider
- `swift/` — visionOS provider
- `kotlin/` — Android XR provider
- `demo/` — "First Light" proof scene with a HUD pipeline overlay naming the
  language behind each system

## Verify

```bash
npm install
npm run build            # type-check the TS core

# unit tests (node)
npx esbuild test/core.test.ts --bundle --platform=node --format=esm --outfile=/tmp/c.mjs && node --test /tmp/c.mjs
npx esbuild test/wasm.test.ts --bundle --platform=node --format=esm --outfile=/tmp/w.mjs && node --test /tmp/w.mjs

# C++ -> WASM (needs emsdk: source ~/emsdk/emsdk_env.sh)
./native/build-wasm.sh

# C# (needs .NET 8 SDK)
dotnet build dotnet/XrEngine.Providers

# demo (dev server with hot reload)
npx vite
```

Open the demo, and the HUD shows the pipeline: terrain heights from C++ (WASM),
everything else from TypeScript, with the C#/Swift/Kotlin providers listed as
ready. Enter VR / Enter AR light up when the device supports WebXR; otherwise
it runs as inline 3D (drag to look, scroll to zoom).

## v1 acceptance

The demo scene renders a procedural world (terrain, gate, orb field, generative
pad audio) with **no asset files on disk or network** — no models, no textures,
no audio files. The only binary fetched is `gen.wasm`, which is compiled code,
not content.
