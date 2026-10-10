# Python — ML generation provider

Python is the engine's ML brain. It doesn't script scenes and it doesn't do
glue: it owns the *learned-function* side of procedural generation.

## What it generates

| Op | What | Why it's ML |
|---|---|---|
| `heightfield` | Seeded heightfield in [0,1], same contract as the C++ `GenCore` | Interchangeable generation backend |
| `latent` | Deterministic latent vectors | How generative models sample variation from one seed |
| `style_weights` / `stylize` | A tiny seeded MLP (3 → 6 → 1) applied as **style transfer** over a heightfield | The weights are the "learned parameters"; the seed is the training |
| `biomes` | Softmax over seeded logits | Mixture weights, classifier-style |
| `compose` | Seeded score: chords, pentatonic melody, bassline | Python composes, any language renders |

Python's audio role is composition, not sample rendering: it writes scores
in the engine's shared format (`src/audio/driver.ts`), and the host renders
them. The demo plays `demo/public/gen/python-score.json` through the
`ScorePlayer`. Same format is written by the C# `ScoreComposer`
(`dotnet/XrEngine.Providers/AudioScore.cs`), the Swift `VisionAudioDriver`,
and the Kotlin `AndroidXrAudioDriver`.

Standard library only. No numpy, no torch — it has to run embedded next to
C++ and spawned next to C# without a packaging story.

## How other languages call it

**JSON-lines RPC over stdio** — the one protocol every language speaks:

```bash
cd python && python3 -m xrgen.bridge
{"op": "ping", "params": {}}
{"op": "heightfield", "params": {"seed": 1337, "w": 4, "h": 4, "features": 6.0, "octaves": 4}}
{"op": "style_weights", "params": {"style_seed": 20261010}}
```

- **TypeScript (Node/tooling):** spawn the bridge as a child process, one
  JSON object per line. In the browser, TS evaluates Python-generated
  weights with the exact mirror in `src/bridge/python.ts` (`TsMlProvider`).
- **C#:** `System.Diagnostics.Process` with redirected stdin/stdout, same
  line protocol.
- **C++:** `popen("python3 -m xrgen.bridge")` or embed via the Python C API
  and import `xrgen.ml` directly.
- **Swift / Kotlin:** call the bridge from the host app process on-device,
  or pre-generate parameters at build time like the demo does.

## The demo's Python contribution

`demo/scripts/gen-style-params.py` runs the real provider and writes
`demo/public/gen/python-style.json` — the seeded MLP weights. The demo
loads them at runtime and applies the style over the C++-generated terrain.
Regenerate any time:

```bash
python3 demo/scripts/gen-style-params.py
```

## Tests

```bash
cd python && python3 -m unittest discover -s test
```
