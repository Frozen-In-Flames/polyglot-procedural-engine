# FIRST LIGHT

A playable first-person game built **only** on the Polyglot Procedural Engine (PPE) public API
(`src/script`, `src/world`, and the engine's public surface). No engine
internals, no workarounds: every gap the game needed became a documented
API fix in `src/` instead. This is the V4 proof: an external developer
could write exactly this.

## Run it

```sh
cd games/first-light
npx tsc -p tsconfig.json   # typecheck (extends the repo root config)
npx vite build             # -> dist/ (self-contained bundle, no deps)
```

Then serve `dist/` over HTTP, or open `dist/index.html` directly. (The
game needs WebGL2; headless Chromium works with SwiftShader.)

The full check from the repo root:

```sh
npx tsc && npm test && npx vite build
```

## Controls

| Input | Action |
|---|---|
| `W A S D` | walk (Shift = run) |
| mouse drag | look |
| `E` | interact: grab / release an ember, grab / release a lever |
| `←` `→` | adjust a held lever |
| `#debug` | URL hash enables the debug hook (`window.__fl`: teleport, setLevel, scene graph, error log) |

## The arc

**1. Perception game.** You wake in ember-reach, a rust-red windland.
Nine embers drift on the wind. Walk into one to take it; carry it to the
dark gate on the northern hill; press `E` to set it down. Each delivered
ember kindles the gate a little brighter — visible progress.

But the gate does not open for embers. It opens for **attunement**: a
hidden score the game never shows, never names, never hints at. There is
no UI for it, no numbers, no tutorial. The world simply starts to answer
differently as you learn to move *with* it instead of through it.

**2. Secret path.** From the first minute, a pale ring stands in
mote-hollow, out over a gap in the terrain. It is not locked by a key or
a switch. It is crossed the way wind crosses: wait for a gust front,
move with it, let it carry you further than your legs can. On the far
side: the foundry.

**3. The foundry.** Six pedestals, six levers, each labeled with the
language signature that generated its domain:

- **TypeScript** — terrain · sky (scene)
- **C++/WASM** — seed · noise (genesis)
- **Python** — biome · style (biome)
- **C#** — behavior tempo (tempo)
- **Swift** — light · perception (light)
- **Kotlin** — presence · physics feel (presence)

Grab a lever with `E`, push it with `←`/`→`, and the composed world
re-derives downstream, live: the terrain rebuilds, the sky shifts, the
wind field re-seeds. And the seventh lever is you — your movement stirs
the wind field (the engine's player wake), and in the foundry the world
answers your body: sprint in a circle and watch the motes scatter.

## The attunement mechanic (exact)

Attunement is a hidden 0–100 score kept by `scripts/attunement.ts`. It
rewards **embodied prediction** — three concrete mechanics:

- **A — ride the wind.** Your velocity aligned with the local wind vector
  scores, scaled by wind strength. Walking downwind on a strong gust
  pays; fighting the wind drains.
- **B — read the current.** Standing where an ember current *will* carry
  an ember within the next few seconds scores — the script advects each
  ember forward along the wind field and checks whether your position is
  near its future path. You learn the currents by watching the embers.
- **C — stillness in the gust.** Holding still as a gust front passes
  over you scores. The gust fronts are visible (dust brightens, motes
  surge); the reward is for not flinching.

Decay is constant and small; misalignment and sprinting against the wind
drain faster. Six thresholds (15/30/45/60/75/90) emit `attune:level`
events. Each level wakes one more foundry lever and brightens the world's
answer a notch. The gate opens **only** at level 6 (resonance), no matter
how many embers were delivered.

The host listens for `attune:level` (via the engine's `onEvent` tap) to
drive captions and lever loading; the game UI never shows the score.

## Layout

```
games/first-light/
  index.html        entry page (title, hint pill, captions, foundry panel)
  main.ts           host: renderer, input, camera, HUD, zone views,
                    lever progression, portal crossings, #debug hook
  world-view.ts     host-side dressing: zone terrains, sky, portal rings
  zones.ts          the four zone descriptors (3 sample zones + foundry)
  shared.ts         shared constants, gustFront(), attuneLevel()
  scripts/
    player.ts       walker (WASD, gravity, terrain clamp, stillwater ride)
    embers.ts       9 wind-advected embers; pickup / carry / deliver
    motes.ts        ~135 wind-blown motes; they part around the walker
    attunement.ts   the hidden score (A/B/C mechanics above)
    gate.ts         the dark gate; brightens per ember, opens at level 6
    secret.ts       the plain-sight portal; gust-gated crossing
    foundry.ts      6 pedestals, E grab/release, wake rings
    levers.ts       6 lever scripts, one field.write.<domain> grant each
  tsconfig.json     extends root, noEmit (typecheck only)
  vite.config.ts    builds dist/ from index.html
```

## API surface used (and only this)

- `src/script`: `ScriptRuntime.load(def, { grants })`, the frozen caps
  object (`world.spawn` **with procedural `body` descriptors**,
  `world.find/query/destroy/state`, `field.wind`, `caps.probe.ground`,
  `events.on/emit`, `audio.note`, `time`, `rng`, `log`), tiered grants
  including the six `field.write.*` domain grants.
- `src/world`: `ComposedWorld`, `GlobalField` (`setDomain`, revision),
  `ZoneDescriptor` validation, `PortalHandoff`, the three sample zones,
  player-wake via `field.setPlayerState`.
- Engine public surface: scene graph, renderer, materials, math.

## Design law, honored

- **Wind correction.** The wind field is the authority everything else
  reads: embers advect along it, motes ride it, attunement measures your
  alignment with it, the secret path is crossed by it, the foundry
  re-seeds it. Nothing moves against the field's say-so.
- **Felt before understood.** Attunement has no UI, no numbers, no hints
  anywhere in the perception game. The gate brightens (felt progress)
  but opens on resonance (felt mastery).
- **Plain sight.** The secret portal stands visible from minute one. No
  key, no lock — only the skill of moving with a gust.
- **Phase distinction.** Perception phase: the math is never shown in any
  form. Foundry phase: real controls with readouts, and the generative
  order visibly reorganizes downstream of every lever.
- **Endgame: resonance, then authorship.** The gate opens at attunement
  6 — resonance, not collection — and what waits beyond is not a prize
  but the foundry: the tools that made the world, handed over.
- **Six levers + the 7th.** One lever per language/domain, each writing
  its domain live through top-tier grants; the 7th lever is the player's
  own body stirring the field, legible in the foundry's wake rings.
- **Architectural law.** Game code lives here, in `games/first-light/`,
  and touches only the public API. Every engine gap became an API fix in
  `src/`, listed in the repo CHANGELOG.
