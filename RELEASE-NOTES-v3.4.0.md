# Frozen In Flames - Polyglot Procedural Engine v3.4.0

## Director mode: takes of a seeded world

**What is new.** Real-time virtual production for the engine's
procedural worlds. A performance of a world is captured as a
*take*: the world seed plus a sparse track sheet of timestamped
events, stored as plain JSON (`ppe-take` format, version 1).

The sheet has five channels, each grounded in a surface the
composed Living World already exposes:

1. **Camera** - keyframed position, yaw, and pitch of the camera
   rig; linear interpolation between keyframes.
2. **Light** - keyframed offset of the emission light (the same
   offset `LivingWorld.moveEmission` applies); interpolated.
3. **Emission** - the glow layer's on/off switch; held until the
   next event.
4. **Action** - held character input (wish direction and jump),
   the sparse counterpart of the dense per-tick input log in
   `game/replay.ts`; held until the next event.
5. **Cue** - a named moment (a sound cue, a marker); fires once
   at its tick.

Four components, all in `src/director/`:

- **Format and validation** (`take.ts`): a take that parses is a
  take the evaluator can run exactly as written. Unknown
  channels, duplicate events, and non-finite numbers are
  rejected, never coerced or absorbed.
- **A pure evaluator** (`evaluate.ts`): the director state at a
  tick is a function of the take and the tick only. Playback is
  evaluating consecutive ticks; nothing about the host (frame
  rate, wall clock, process) can change the result.
- **A recorder** (`recorder.ts`): sampling a live performance
  once per tick writes keyframes only when a channel actually
  moves, so a take file stays small. Its `punchIn` operation
  truncates one channel's scripted future.
- **A player** (`player.ts`): a fixed-step playhead at the
  take's tick rate. It touches no world; hosts apply the
  evaluated state, which keeps playback identical everywhere.

The new **Director demo page** (live at the demo URL below)
performs all of it on the Living World: record a take while
flying the camera and moving the light; replay it from a fresh
world; grab the camera, the light, the emission switch, or the
jump mid-replay to punch in and re-perform that one channel
while the others keep the script; save and load takes as JSON.
The state panel prints the world digest at the end of a
recording and at the end of its replay. For an unedited take
the two strings are identical.

**Why it was added.** The engine's founding claim is zero asset
dependence: a world is mathematics, regenerated from a seed.
v3.0.0 composed the campaign's systems into one living world,
and input replay already proved that a deterministic world can
be re-run bit for bit. Direction is the next layer of the same
claim. A conventional virtual-production take is a video file:
large, fixed, and separable from the world it depicts only by
rebuilding that world by hand. A PPE take is the performance
itself, as data - small enough to read, exact enough to grade,
and editable by performing over it, because the world it plays
in is rebuilt from the seed every time. Reactor proved this
shape for music (the song file plus a seed is the visual
performance); v3.4.0 brings it to worlds.

**Verification.** A new suite, `test/director.test.ts` (13
tests), grades the format (round-trip exactness; a rejection
battery), the evaluator (hand-computed interpolation midpoints;
step and cue-window edges pinned), the recorder (a performed
path evaluates back onto itself; punch-in replaces only the
grabbed channel), and the headline claim as a determinism
oracle: two fresh living worlds stepped 600 ticks under one
track sheet produce identical digests at ticks 200, 400, and
600. Negative controls pin the machinery to the claim: mutating
one action event in the sheet moves the final world digest;
mutating one light event moves the evaluated light and the
world's emission center; mutating an evaluated result does not
reach back into the take. Totals: TypeScript 681 to 694 tests,
all passing (the base includes the CI, conductor-sync, and
DeadRamp Building work that landed on main ahead of this
release); Python 106 tests, unchanged, all passing; the
project build is clean. The shipped demo page was additionally
verified end to end in a browser: a take recorded live in the
page replayed to the identical digest.

**Demo.** https://frozen-in-flames.github.io/polyglot-procedural-engine/director.html

Developed by Aries Drake Hilton.
