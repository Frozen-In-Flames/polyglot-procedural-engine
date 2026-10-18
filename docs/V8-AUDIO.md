# V8 Design: The Engine Gets Ears (Procedural Audio)

**Status:** built and shipped in v0.8.0 (2026-10-13). Mapped overnight
Oct 13, 2026 per Aries's direction ("map it in more depth overnight, then
build it during day").

## The thesis

Every version so far taught the engine a new sense of *making*: V1 proved the
math renders, V4 proved it plays, V5 proved it builds, V6/V7 proved it owns.
V8 teaches it to *sound*. The Polyglot Procedural Engine already whispers -
a score contract, a seeded DSP bass voice, per-language composers, a pad
driver. V8 turns the whisper into a voice: a full procedural audio engine
where **zero audio files** exist. Every oscillator, every grain, every
reverb tail is math evaluated at runtime, seeded and deterministic, the same
way every pixel already is. The engine's law holds for the ears exactly as
it holds for the eyes: if it can't be expressed as math, it doesn't ship.

The arc sentence for the changelog: *V7 let the user own what they made;
V8 lets them hear it.*

## Design laws honored

- **Zero asset dependence** (public wording). No samples, no impulse
  recordings, no soundfonts. Reverb impulse responses are *generated* from
  seeded noise and decay curves, never captured.
- **The math is never shown directly**, only read through the world like
  wind through water. The player never sees a waveform, a spectrum, or a
  score. In First Light, attunement is *heard* as the world answering -
  felt before understood, exactly like the visual design.
- **Seeded everything.** Same seed plus same playthrough path equals the
  same music. Audio joins the engine's determinism contract; it does not
  get an exemption.
- **Not a competitor to Unity/Unreal** - the bridge between all asset
  stores. V8's score schema stays portable JSON any renderer can play,
  the same way V1's scores already are.
- **Zero new runtime dependencies.** Hard invariant, unchanged since V1:
  the runtime stays pure math. Web Audio is a browser platform API, not a
  dependency. The C++ DSP compiles from the repo's own sources. Python
  stays stdlib-only. Anything heavier lives in the offline foundry, used
  once, whose output is a JSON parameter bundle the runtime evaluates.

---

## 1. Architecture

Audio becomes a first-class engine subsystem, not a demo accessory. The
split of responsibilities follows the existing polyglot contract:

| Layer | Owns | Renders |
|---|---|---|
| TypeScript (`src/audio/`) | Mix graph, spatial graph, conductor, script API | Web Audio (platform API) |
| C++ → WASM (`native/gen/dsp/`) | DSP core: oscillators, FM, granular, physical models, filters, effects | Sample buffers, looped by the host |
| Python (`python/xrgen/`) | Composition and adaptive arrangement (the musical decisions) | Never samples - emits score docs |
| C# / Swift / Kotlin | Per-language adaptive layers (arp+hats, sparkle, sub pulse) | Compose scores; host renders |
| Foundry (`python/xrgen/audio_foundry.py`) | Offline design: IR design, spectrum analysis, long-texture baking | JSON parameter bundles |

### 1.1 TypeScript module layout (`src/audio/`)

Existing files keep their roles; new files are additive:

- `driver.ts` - **unchanged contract.** `ScoreDoc` validation, `ScorePlayer`
  (lookahead scheduler). V8 extends the `ScoreKind` union additively
  (see §5.4); old scores still validate.
- `spatial.ts` - **extended.** `SpatialAudio` gains the emitter registry,
  reverb zones, and occlusion (see §3). `MusicDriver` keeps its
  `update(t, energy)` signature for backward compatibility; the conductor
  (§4) implements a richer driver behind the same interface.
- `graph.ts` - **new.** The mix graph: `master → music bus → sfx bus →
  voice buses`. Every driver connects through named buses, never straight
  to destination. Bus gains are the conductor's faders. One limiter on the
  master (a `DynamicsCompressorNode` used strictly as a safety limiter,
  not as a sound).
- `synth.ts` - **new.** The TypeScript sample-rendering mirror of the C++
  DSP core: renders short voices (plucks, pings, risers) to `AudioBuffer`
  for one-shot SFX. Bit-exact with the C++ double-precision reference
  where the math avoids transcendentals; tolerance-close elsewhere (the
  same honesty boundary INVERSE.md established: `Math.sin` differs 1 ulp
  between CPython and V8, and Web Audio itself is float32).
- `dsp.ts` - **new.** The WASM DSP bridge: loads the compiled DSP module,
  calls `xr_dsp_render_*` exports, wraps the returned samples in looping
  `AudioBufferSourceNodes`. The C++ bass voice (`xr_dsp_voice`) moves
  behind this bridge unchanged.
- `score.ts` - **new.** The conductor (see §4): consumes the game-state
  vector, crossfades the per-language layers, emits the adaptive score.
  Pure functions for the state→layer-gain mapping, so the mapping itself
  is unit-testable without an `AudioContext`.
- `foundry.ts` - **new, host-only.** Loads offline-baked audio bundles
  (generated IRs, long-form texture parameters) and hands them to the
  graph. Never in the hot path; bundles are plain JSON.

### 1.2 C++ DSP core (`native/gen/dsp/`)

New directory beside the existing `gen/` noise core. Same rules as the
noise core: pure functions of `(seed, params)`, no I/O, no assets,
`EMSCRIPTEN_KEEPALIVE` exports for the WASM bridge, same code compilable
to native later.

Exports (each renders `n` mono samples at the given rate into `out`):

- `xr_dsp_osc(seed, n, rate, out, wave, freq, detune)` - polyBLEP
  band-limited oscillator bank (sine/saw/square/triangle). Band-limiting
  matters: naive digital oscillators alias, and aliasing is noise the
  seed didn't order.
- `xr_dsp_fm(seed, n, rate, out, carriers, ratios, indices)` - FM operator
  stacks, 2–6 operators, seeded ratios. All operators derive from the osc
  bank; no tables.
- `xr_dsp_grain(seed, n, rate, out, srcLen, density, ...)` - granular
  engine. The source buffer is itself synthesized (a seeded FM texture
  rendered once into memory), then granulated with seeded grain
  scheduling. **No loaded samples, ever** - the "sample" is math too.
- `xr_dsp_pluck(seed, n, rate, out, freq, decay)` - Karplus-Strong plucked
  string: a delay line excited by a seeded noise burst. Physical, tiny,
  beautiful.
- `xr_dsp_modal(seed, n, rate, out, freq, modes, decay)` - modal resonator
  bank: damped sine modes at seeded inharmonic ratios. Bells, plates,
  glass. (The engine's own soundtrack wants glass.)
- `xr_dsp_biquad(...)`, `xr_dsp_ladder(...)` - filter suite for voices
  and the occlusion path.
- `xr_dsp_ir(seed, len, rate, out, decay, damping)` - **generated impulse
  responses**: seeded noise shaped by exponential decay and progressive
  lowpassing. This is how reverb zones get their tails without a single
  recorded room.
- `xr_dsp_voice(...)` - the existing seeded bass voice, kept as-is.

Phase accumulators run in double precision (the existing `dsp_voice`
already does this: float32 phase audibly drifts over a loop). The TS
mirror in `synth.ts` matches the double-precision reference; the
float32 Web Audio render is tolerance-close by declared boundary.

### 1.3 Python (`python/xrgen/`)

Python keeps its established role: **it composes; it never renders.**

- `audio.py` - extended, not rewritten. `AudioComposer` keeps its exact
  signature (`compose(seed, bars, bpm)`); V8 adds `AdaptiveComposer`,
  which takes the same seed plus a state vector and returns a score doc
  in the shared format. The adaptive decisions (which layers, what
  density, what brightness) are seeded functions of `(seed, stateVec)`.
- `score.py` - **new.** The arrangement library the adaptive composer
  uses: progression families, voice-leading helpers, density curves. All
  pure functions of `(rng, params)`; the TS mirror covers the
  determinism-critical subset, following the existing `rng.py` mirror
  pattern.
- `audio_foundry.py` - **new, offline only.** May use numpy/scipy once:
  designs reverb IR parameter sets, analyzes spectra of candidate
  textures, bakes long evolving pads into parameter bundles. Output is
  JSON the runtime evaluates. Two-sided design, exactly like the visual
  foundry: the foundry may use anything once; the runtime stays pure.

### 1.4 Provider drivers (C# / Swift / Kotlin)

Each language keeps its voice and gains adaptivity. The `XrAudioDriver`
contract grows one method (additive; old drivers still satisfy the base):

- Base (unchanged): `compose(seed, bars, bpm) -> score events`.
- V8 addition: `composeAdaptive(seed, bars, bpm, state) -> score events`,
  where `state` is the small language-agnostic state vector
  `{energy, tension, attunement, brightness, tempo}` (see §4.1).
- C#: the arp+hats layer gains density control - hats thin out at low
  energy, the arp climbs octaves with brightness.
- Swift: the sparkle pings gain the orbit - pan paths widen with
  attunement, so the listener *hears* the space open up.
- Kotlin: the sub pulse stays the anchor - one clean voice on the
  low end, its drop deepening as tension rises.

On-device rendering (AVAudioEnvironmentNode, Oboe) stays post-V8, as
previously declared. The contract is the deliverable; the wiring follows
the platform.

### 1.5 Data flow (one frame)

```
game state → conductor (score.ts) → layer gains + state vector
     → per-language composers → score docs → ScorePlayer → music bus
     → entity emitters → spatial graph (panners, zones, occlusion)
     → master → ears
```

Scripts never touch nodes. They push notes and state through the caps;
the host owns every `AudioNode`. One-way, like V4's audio sink.

---

## 2. Synthesis

All synthesis is seeded and deterministic. Every voice is a pure function
of `(seed, params, time)`; there is no randomness the seed doesn't own.
The engine's existing SplitMix64 (already vendored in Swift, Kotlin, C#,
and Python's `rng.py`) is the single RNG everywhere audio needs one.

### 2.1 Oscillator bank

polyBLEP band-limited oscillators (sine, saw, square, triangle). No
wavetables - a wavetable is an asset wearing a trench coat. Detune pairs
are seeded (±cents from the seed), giving the wide unison the engine's
own music leans on. Double-precision phase accumulators; the audible
difference over a loop is the difference between a voice that holds and
a voice that wanders.

### 2.2 FM synthesis

2–6 operator stacks with seeded carrier:modulator ratios and indices.
FM is the cheapest way to get acoustic complexity from almost no code -
a bell is two operators, a reed is three. The modal bank (§2.4) and FM
share the operator core; V8 does not build the same sine twice.

### 2.3 Granular textures

Grains are windows over procedurally generated source buffers. The
pipeline is: seed → FM/texture render (once, into memory) → seeded grain
scheduler → cloud. Grain rate, size, pitch jitter, and pan scatter are
all seeded functions, so the cloud is identical every run. This is how
the engine does wind, water, and breath without a single field
recording: the "field" is a function.

### 2.4 Physical modeling

- **Karplus-Strong plucked string**: a delay line excited by a seeded
  noise burst, feedback-filtered. One page of code, infinite guitars.
- **Modal resonator bank**: damped sine modes at seeded inharmonic
  ratios - bells, plates, glass. Tuned by the seed, played by the score.

### 2.5 Filters and effects

Biquad suite plus a seeded ladder filter for voices; tempo-synced delay
(delay times derived from the score's bpm, never free-running); chorus
from seeded LFOs on the detune pairs. Reverb is convolution with
*generated* IRs (see §3.2) - the only convolution in the engine, and the
impulse never came from a microphone.

### 2.6 The determinism contract

| Path | Guarantee |
|---|---|
| Composition decisions (which notes, which layers) | Bit-exact across Python/C#/TS mirrors (no transcendentals on this path) |
| C++ DSP double-precision reference | Bit-exact per seed (the test oracle) |
| TS `synth.ts` mirror | Bit-exact where transcendental-free; else tolerance-close (≤1 ulp drift documented per function) |
| Web Audio float32 render | Tolerance-close by declared boundary (the platform quantizes; we don't pretend otherwise) |
| Same seed + same state trajectory | Same music, every run, every platform |

---

## 3. Spatial audio

### 3.1 Emitters

Sound lives in the scene graph. An emitter binds a voice to an entity;
per frame the host writes the entity's world transform into the
emitter's `PannerNode` (HRTF model, already in use). Emitters are
created and destroyed through the host API, never by scripts directly -
scripts request (`audio.sfx`), the host places. Distance models are
per-emitter (`inverse`, `linear`, `exponential`) with seeded rolloff
curves where the design wants them.

Voice budget: 32 concurrent voices, priority-stealed by (loudness ×
proximity). The number is documented, not magic - low-end devices get
the same mix decisions, just fewer of them.

### 3.2 Reverb zones

Zones are volumes (box or sphere) carrying a **reverb seed**. On first
entry the host generates the zone's impulse response via `xr_dsp_ir`
(seeded noise, exponential decay, progressive damping) and caches it per
seed - generating once, convolving forever. The zone descriptor carries
`{seed, decay, damping, wet}`; sends are per-emitter, so a voice can
stand half in a cavern and half in the open. Zone boundaries crossfade
over ~0.5 s; no clicks, no pops, no seams.

### 3.3 Occlusion

A ray from emitter to listener against the world's colliders yields an
occlusion factor in [0,1]; the factor drives a lowpass on the emitter's
path (20 kHz open → ~400 Hz fully occluded) plus a small gain dip.
Cheap, continuous, and honest: walls muffle. The occlusion query reuses
the engine's existing collider set - no new physics, no new deps.

---

## 4. Adaptive music: the conductor

This is the heart of V8. The engine does not loop a track; it *performs*
one, continuously, from the game state.

### 4.1 The state vector

Every frame (sampled per beat, applied per bar - see §9.2) the host
builds a small language-agnostic vector:

```
{ energy,      // [0,1]  scene intensity (already exists in MusicDriver)
  tension,     // [0,1]  danger / unresolvedness
  attunement,  // [0,100] First Light's hidden score; other games map their own
  brightness,  // [0,1]  spectral openness the game wants
  tempo        // multiplier on the base bpm, [0.5, 2.0] }
```

Games write into this vector through the caps (`audio.mood(partial)` -
one-way, merged by the host). The engine never requires a game to
provide it: defaults are the current static behavior, so every existing
scene keeps sounding exactly as it does today.

### 4.2 The layer model

Each language's voice is a **layer** with an intensity curve over the
state vector:

| Layer | Voice | Enters with |
|---|---|---|
| Foundation | C++ DSP bass voice | Always (the floor) |
| Harmony | Python chords + bass | energy > 0.15 |
| Pulse | Kotlin sub pulse | tension rising |
| Motion | C# arp + hats | energy > 0.4, density follows energy |
| Air | Swift sparkle pings | brightness > 0.5, orbit widens with attunement |
| Song | Python melody | attunement > 40 |

Crossfades are per-bar gain ramps, never hard cuts. A layer that leaves
finishes its bar; a layer that enters fades in over one bar. The music
breathes instead of switching.

### 4.3 First Light: attunement heard as resonance (the key beat)

First Light's hidden attunement score (0–100, six thresholds at
12/28/44/60/74/88 - the game's ATTUNE_LEVELS in games/first-light/shared.ts,
which the conductor mirrors so the heard levels stay in sync with the
level-ups; gate opens only at level 6) becomes the conductor's
deepest input. The design law is *felt before understood*: the game
never names attunement, shows no numbers - and V8 extends that law to
the ears. As the player learns to move *with* the wind, the world
answers in sound:

- **Level 1 (15):** the sub pulse enters. The world gains a heartbeat.
- **Level 2 (30):** the pad filter opens with brightness. The air
  clears; the player hears further.
- **Level 3 (45):** the arp layer fades in, tempo-locked to the wind's
  rhythm regions. Motion has a melody now.
- **Level 4 (60):** the sparkle orbit widens - pings circle the
  listener, the space itself feels larger.
- **Level 5 (75):** the Python melody enters, sparse, pentatonic,
  calling toward the gate's direction (panned by the gate's bearing).
- **Level 6 (90) - resonance:** every layer retunes to a just-intonation
  lattice on the gate's root. The beating between detuned voices -
  present all game as texture - resolves into consonance. The world
  literally tunes itself when the player does. The gate opens, and the
  opening is *heard* before it is seen.

Decay works the same path in reverse: fight the wind and the layers
thin out, the tuning loosens. The ear learns the mechanic the eyes
never explain. This is the V8 demo moment, and it needs no UI: a
scripted playthrough that reaches resonance is the acceptance test you
can hear with your eyes closed.

### 4.4 Determinism

Same seed + same state trajectory = same performance. The state
trajectory is gameplay, so two identical playthroughs sound identical
and two different ones don't - exactly like the visuals. The conductor's
state→gain mapping is pure functions, unit-tested without an
`AudioContext`.

---

## 5. Public API

V4's conventions hold: game code touches only the public surface; every
gap becomes an engine API fix, not a workaround. Scripts get
capabilities, never nodes.

### 5.1 Host API (`AudioEngine`)

```ts
audio.addEmitter(entityId, voiceSpec)   // voice follows the entity
audio.removeEmitter(id)
audio.setReverbZone({center, radius, seed, decay, damping, wet})
audio.setListenerFromCamera(camera)    // per frame
audio.conductor.update(dt, stateVec)   // per frame; samples per beat, applies per bar
audio.setVoiceBudget(n)                // default 32
```

### 5.2 Script caps (additive to V4)

```ts
caps.audio.notes(events)     // existing one-way note sink, unchanged
caps.audio.note(e)           // existing single note, unchanged
caps.audio.sfx({kind, pos, gain})  // NEW: positional one-shot (pluck, ping, riser, gust)
caps.audio.mood({energy?, tension?, brightness?, tempo?})  // NEW: one-way adaptive state push
```

Threat model unchanged from V4: capability-closure. Scripts compose and
request; the host validates (schema-checked, range-clamped), places, and
plays. A hostile script can be annoying; it cannot break the mix -
gains clamp, voice budget holds, the master limiter stands.

### 5.3 Zone descriptors

`ZoneDescriptor` gains an optional, validated `audio` block:

```json
"audio": { "reverbSeed": 1207, "decay": 1.8, "damping": 0.6,
           "wet": 0.35, "ambientLayer": "wind" }
```

Validated on load like every other zone field; absent means today's
behavior. The `ambientLayer` names a seeded granular bed (wind, water,
breath) the zone owns.

### 5.4 Score schema v1.1 (backward compatible)

`ScoreKind` grows additively: `'tone' | 'pad' | 'bass' | 'noise'` keep
their exact meanings; V8 adds `'pluck' | 'ping' | 'riser' | 'gust' |
'granular'`. `validateScore` accepts both; old documents validate
unchanged. New optional event fields: `attack`, `decay`, `filterFreq`,
`reverbSend` - all range-clamped, all ignored by old renderers.

---

## 6. Constraints

1. **Zero new runtime dependencies.** No npm audio packages, no WASM
   blobs from outside the repo, no sample packs, no soundfonts. The
   `package.json` dependency list does not grow.
2. **Browser platform APIs only** for the TS host (Web Audio). If it
   isn't in the browser, the host doesn't use it.
3. **C++ compiles from repo sources only.** The DSP core is new files
   under `native/gen/dsp/`, same toolchain as the noise core.
4. **Python stays stdlib-only.** numpy/scipy may appear in
   `audio_foundry.py`, which is offline-only and never imported by the
   runtime path.
5. **Two-sided foundry design** (per INVERSE.md): the foundry may use
   anything once; its output is JSON parameter bundles; the runtime
   evaluates bundles with the same zero-dep engine.
6. **Performance budget:** the audio thread must never block the frame.
   All DSP renders ahead-of-time into buffers (voices) or on the
   lookahead scheduler (scores). No per-frame sample computation on the
   main thread beyond node parameter updates.

---

## 7. Testing and definition of done

### 7.1 Test plan (per language, existing conventions)

- **TypeScript** (`test/audio-v8.test.ts`, runs under the existing
  `npm test` pipeline): score schema v1.1 validation (new kinds, new
  optional fields, old docs still pass); SplitMix64 determinism vectors;
  conductor state→gain mapping (pure functions, no AudioContext);
  reverb-zone IR determinism (same seed → identical IR); occlusion factor
  math; voice-budget stealing order; `synth.ts` vs C++ reference vectors
  (tolerance assertions with documented ulp bounds).
- **C++** (extends `test/wasm.test.ts`): render determinism - same seed
  → bit-identical samples across runs; double-precision phase stability
  over long renders; EMSCRIPTEN_KEEPALIVE exports present and callable.
- **Python** (`test_audio_v8.py`, stdlib unittest like the existing
  suite): `AdaptiveComposer` determinism per (seed, stateVec); score docs
  validate under the TS `validateScore` contract (schema conformance is
  the cross-language test); bit-exactness of the mirrored decision path
  vs the TS mirror.
- **Cross-language:** every language's composer output (Python, C#,
  Swift, Kotlin) must validate under `validateScore`. This is the
  polyglot contract test - it already exists in spirit; V8 makes it
  explicit.
- **Acceptance:** a scripted First Light playthrough reaching attunement
  level 6 produces the resonance retune (asserted on the conductor's
  layer/tuning state, not by listening - the test is deaf, the demo is
  not).

### 7.2 Definition of done for V8

- `npx tsc` clean; TS suite green (target: 200+ tests); Python suite
  green (55 + new audio tests); C# compiles; Swift/Kotlin contracts
  compile where toolchains exist.
- Zero new runtime dependencies (`package.json` unchanged).
- First Light plays end-to-end with adaptive audio; the six attunement
  levels are audibly distinct; resonance retunes the lattice.
- Demo updated with an audio toggle and the pipeline overlay names the
  language behind each layer (the V1 visible-pipeline tradition).
- CHANGELOG entry, release notes, `docs/V8-AUDIO.md` (this file) marked
  built.
- Honest-unverified list updated (real-headset audio, on-device
  AVAudioEnvironmentNode/Oboe wiring, long-session drift).

---

## 8. Migration: V7 → V8

- **Version:** `0.8.0`. The minor bump is honest: additive API, no
  breaking changes. Score schema v1.1 is backward compatible; the old
  `MusicDriver.update(t, energy)` path keeps working; existing scenes
  sound exactly as before until a game opts into the conductor.
- **Repo changes:** `src/audio/*` (new + extended), `native/gen/dsp/`
  (new), `python/xrgen/audio.py` + `score.py` + `audio_foundry.py`,
  provider drivers (additive method), `games/first-light/scripts/`
  (attunement → `audio.mood` wiring, foundry lever → brightness), demo
  overlay, tests, docs.

### CHANGELOG entry draft (for [0.8.0])

```md
## [0.8.0] - V8 (2026-10-__)

The engine gets ears. V7 let the user own what they made; V8 lets them
hear it. A full procedural audio engine with zero audio files: every
oscillator, grain, and reverb tail is math evaluated at runtime, seeded
and deterministic like every pixel already was.

### DSP core (`native/gen/dsp/`, `src/audio/synth.ts`, `src/audio/dsp.ts`)

New C++ DSP core beside the noise core: polyBLEP oscillator bank, FM
operator stacks, granular engine (grains from synthesized sources -
the "sample" is math too), Karplus-Strong plucks, modal resonator
bells, filter suite, and generated impulse responses. Same rules as
everything else: pure functions of (seed, params), double-precision
phase, EMSCRIPTEN_KEEPALIVE exports. TypeScript mirror renders voices
to buffers; the WASM bridge loops them.

### The conductor (`src/audio/score.ts`, `src/audio/graph.ts`)

The engine no longer loops a track; it performs one. A game-state
vector (energy, tension, attunement, brightness, tempo) drives
per-language layers with per-bar crossfades. In First Light, the hidden
attunement score is heard: six levels add layers until resonance
retunes every voice to a just-intonation lattice on the gate's root.
The world tunes itself when the player does - felt before understood.

### Spatial audio (`src/audio/spatial.ts` extended)

Entity-bound emitters on the scene graph, reverb zones with generated
IRs (seeded, cached per zone), occlusion from the existing colliders.
32-voice budget with priority stealing, documented.

### Verification

[test counts], `tsc` clean, zero new runtime dependencies.
Honestly remaining: real-headset audio, on-device provider wiring,
long-session drift.
```

### Release notes outline

1. The one-liner: *the engine gets ears - zero audio files.*
2. Per-language: what each language now contributes (the pipeline
   overlay tradition - name every language).
3. The First Light resonance moment: describe the six levels, the
   retune, the gate. No UI, no numbers - the demo is the proof.
4. Verification numbers and the honest-unverified list.
5. The arc sentence: *see it (V1), play it (V4), build it (V5), own it
   (V6/V7), hear it (V8).*

---

## 9. Open questions

1. **Per-beat sampling vs per-bar application for the conductor.**
   *Recommendation:* sample state per beat, apply layer changes per bar.
   Per-beat application would churn the mix; per-bar keeps musicality
   while staying responsive. Revisit if playtesting says the lag reads
   as unresponsiveness.
2. **Bit-exactness boundary for rendered audio.** *Recommendation:*
   bit-exact for composition decisions and the C++ double reference;
   tolerance-close (documented ulp bounds) for the TS mirror and the
   float32 Web Audio render. Follows the INVERSE.md precedent; do not
   promise what the platform can't keep.
3. **Reverb IR length cap.** *Recommendation:* 1.5 s max, cached per
   zone seed. Longer tails cost memory per zone and the seeded decay
   design makes 1.5 s feel larger than it is.
4. **Demo vehicle.** *Recommendation:* First Light is the proof - it
   already owns the attunement arc. No new demo scene; extend the
   pipeline overlay to name the audio layers per language instead.
5. **Native (non-WASM) DSP.** *Recommendation:* V8 stays WASM-only for
   the DSP core. The C++ is written portable (same as the noise core)
   so native compilation is a later slice, not a redesign.
6. **Sample-rate independence.** *Recommendation:* all seeded content
   defined in seconds (phase per second, decay per second), never in
   samples. The renderer adapts to the context's rate; the seed's music
   doesn't change between 44.1 kHz and 48 kHz. Document and test both.
7. **Voice budget number.** *Recommendation:* 32 concurrent voices with
   (loudness × proximity) priority stealing. Documented, tunable via
   `setVoiceBudget`. Low-end gets the same decisions, fewer voices.
8. **Should scripts hear the mix (analysis)?** *Recommendation:* no.
   The caps stay one-way (compose/request, never analyze). Analysis
   would break the capability-closure threat model and invite
   feedback-loop pathologies. If a game needs reactivity, it reacts to
   game state, not to the waveform.
9. **Granular source buffer length.** *Recommendation:* 2–4 s synthesized
   textures, rendered once per seed and shared across grain voices.
   Longer sources cost memory; the seeded scheduler makes short sources
   feel endless.
