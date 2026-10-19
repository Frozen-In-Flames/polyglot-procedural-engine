# Game feel (V10.5)

The game-feel layer turns the simulation into something a game can be
built on: a fixed-timestep deterministic loop, a primitive-collider
character controller against the SDF world, and bit-identical input
replay. Everything here is math-first: feel parameters are tick counts
and accelerations, not tuned constants hidden in code.

Public wording for this layer: "zero asset dependence". The world is
the math; the character collides with the field directly.

## 1. Fixed-timestep loop (`src/game/loop.ts`)

`TICK_DT = 1/60` s. Each frame banks its elapsed time in an accumulator
and consumes whole ticks from it. Rendering interpolates between the
last two simulated states with `alpha = acc / TICK_DT` in `[0, 1]`.

Spiral-of-death guard: a frame banks at most `MAX_STEPS = 5` ticks of
debt; anything beyond that is dropped. One slow frame costs ticks,
never an unbounded catch-up spiral.

Determinism: the tick callback receives only `(dt, tickIndex)` with dt
fixed, so the same sequence of ticks always produces identical state.
Pinned by test: identical frame sequences give identical tick streams.

## 2. Capsule character controller (`src/game/character.ts`)

The capsule is two spheres of radius `r` whose centers sit `halfHeight`
above and below the character position; the axis stays vertical. There
are no mesh colliders and no broadphase: the signed distance field is
the collider.

Per tick, in fixed order:

1. Buffer the jump press (`bufferTicks`).
2. Early-release jump cut: on the release edge while ascending,
   upward velocity is multiplied by `jumpCut` (variable jump height).
3. Horizontal control: accelerate the horizontal velocity toward the
   wish velocity (`moveAccel` on ground, `airAccel` in air), capped at
   `maxGroundSpeed` / `maxAirSpeed`. Ground friction (`groundFriction`)
   decelerates with no input.
4. Jump: a buffered press fires on the ground or inside the coyote
   grace (`coyoteTicks`). Takeoff velocity is exactly `jumpVelocity`;
   the impulse replaces gravity on its tick.
5. Gravity, then integrate.
6. Collide: at each endpoint, penetration `d = r - f(p)` is resolved
   by pushing out along the normalized field gradient and killing the
   into-surface velocity component.
7. Ground detect at the feet: `f(feet) <= r + groundEps` with an upward
   normal. Slopes with `n.y >= slopeLimit` are walkable. Steeper
   contact never sticks: grounded stays false, so gravity plus the
   contact resolve slide the character down the tangent.
8. Decay the unconsumed buffer.

Measured behaviors (all pinned by tests in `test/gamefeel.test.ts`):

- A dropped capsule rests at exactly `r + halfHeight`, grounded, zero
  velocity, with no jitter by construction (gravity is off while
  grounded).
- Jump apex follows the discrete model exactly (the jump tick rises
  `v*dt` with no gravity, then `v_k = v - k*g*dt` while positive) and
  sits within one tick of `v^2/2g`.
- Early release cuts the jump short (measured: full hold vs release at
  tick 6 differ by well over the assertion margin).
- Sustained input reaches `maxGroundSpeed` exactly and never exceeds it.
- A wall stops the character at `x = r`: zero penetration over 180
  ticks of walking into it.
- Coyote: a press 4 ticks after leaving a ledge fires; 10 ticks after
  does not (`coyoteTicks = 6`).
- Buffer: a press up to `bufferTicks = 8` before touchdown fires on
  landing.
- A 45-degree slope (limit 30 degrees) slides downhill instead of
  sticking.

## 3. Deterministic input replay (`src/game/replay.ts`)

A replay log is the seed plus the per-tick input structs: move vector,
jump pressed/held, and look delta (recorded for the camera). Replaying
feeds the log through the identical tick function from a fresh initial
state. The tick function is pure (no wall clock, no `Math.random`), so
the replayed state is bit-identical: ULP distance 0 on every position
and velocity component over 240 seeded ticks, plus exact equality of
the discrete flags.

## Parameters

All feel parameters live in `CharacterParams` as named constants; there
are no hidden tunables. The reference values used by the tests:

| parameter | value | meaning |
|---|---|---|
| radius | 0.4 | capsule sphere radius (m) |
| halfHeight | 0.5 | half distance between sphere centers (m) |
| moveAccel | 40 | ground acceleration (m/s^2) |
| airAccel | 12 | air acceleration (m/s^2) |
| maxGroundSpeed | 6 | top ground speed (m/s) |
| maxAirSpeed | 4 | top air speed (m/s) |
| jumpVelocity | 8 | takeoff speed (m/s) |
| gravity | 20 | downward acceleration (m/s^2) |
| groundEps | 0.05 | grounded field-distance band (m) |
| coyoteTicks | 6 | late-jump grace (ticks) |
| bufferTicks | 8 | press survival before landing (ticks) |
| slopeLimit | cos(30 deg) | steepest walkable slope |
| groundFriction | 30 | no-input deceleration (m/s^2) |
| jumpCut | 0.5 | early-release velocity multiplier |

## Validation status

All three systems are validated in the TypeScript identity suite
(`test/gamefeel.test.ts`, 16 tests). Cross-language ports (C++, Python,
C#, Swift, Kotlin) are not yet done: the tick functions are pure
float64 with no platform transcendentals in the hot path, so the port
is mechanical, but it is unclaimed until ported and tested.
