# Cross-language tick parity: canonical scenario and serialization

v2.0.7. The engine is polyglot, and its oldest promise is that a seed
means the same thing in every language. Until this release that promise
was verified piecemeal: the PCG hash against published vectors, the
Python foundry against its TypeScript mirror, the C++ core against
itself through WASM. What was never verified end to end is the unit
that actually moves the world: one fixed simulation tick.

This document defines the canonical tick scenario, the canonical
state serialization, and the digest the golden trace is built from.
Parity lives or dies on serialization honesty, so this spec is the
contract; the runners in TypeScript, Python, and C++ are its
implementations, and `test/tick-parity.test.ts` is its enforcement.

## The tick

The tick is the shipped TypeScript character tick,
`tickCharacter` in `src/game/character.ts`, at the shipped fixed step
`TICK_DT = 1 / 60` s from `src/game/loop.ts`. Its operation order is
fixed by that file and is part of this contract: buffer the press,
jump-cut on release edge, horizontal control, jump, gravity,
integrate, collide both capsule endpoints, ground detect, decay the
buffer. The Python port (`python/xrgen/ticksim.py`) and the C++
port (`parity/runner.cpp`) reproduce that order statement for
statement, including its quirks (the collide loop reads endpoint
positions computed before the loop, not updated by pushes inside it).

No other shipped simulation is in scope. The XPBD contact solver and
the particle systems are TypeScript-only today; they have no second
implementation to agree with, and this spec does not pretend
otherwise. The C# / Swift / Kotlin trees ship provider interfaces and
audio drivers, not a tick. The parity claim of this release covers
exactly TypeScript, Python, and C++.

## Canonical scenario

One scenario, defined in `parity/scenario.json`:

- **Seed** 20261022, **ticks** 600 (10 s at 60 Hz).
- **Parameters** are the engine's own tested tuning from
  `test/gamefeel.test.ts`: radius 0.4, halfHeight 0.5, moveAccel 40,
  airAccel 12, maxGroundSpeed 6, maxAirSpeed 4, jumpVelocity 8,
  gravity 20, groundEps 0.05, coyoteTicks 6, bufferTicks 8,
  groundFriction 30, jumpCut 0.5. slopeLimit is the double nearest
  sqrt(3)/2, written as the decimal literal 0.8660254037844386 in
  every language (each language's literal parser is correctly
  rounded, so all three read the identical bit pattern). It is
  deliberately not computed from cos(pi/6) at runtime: libm cos is
  not part of the exact path (see `src/math/determinism.ts`).
- **World** is an analytic SDF, the minimum of three primitives,
  first-minimum-wins in the order plane, ramp, sphere; the gradient
  is the gradient of the winning primitive:
  - plane: f = y, grad (0, 1, 0).
  - ramp: unit normal (0, 0.5, -0.8660254037844386) through
    (0, 0, 8): f = 0.5*y - 0.8660254037844386*(z - 8). Its normal's
    y is 0.5, below slopeLimit: too steep to stand on, so contact
    slides. The character spawns on the flat and the script walks it
    into the ramp toe.
  - sphere: center (5.6, 0.9, 2.6), radius 0.9:
    f = |p - c| - 0.9, grad (p - c)/|p - c|.
- **Spawn**: a Pcg32 stream (the canonical hash of
  `src/math/determinism.ts`) seeded with the scenario seed draws one
  value s0 before tick 0; spawn x = ((s0 mod 401) - 200) / 50,
  spawn position (x, 2.5, -2), so the character falls to the ground
  in the first ticks. Velocity zero, all counters zero.
- **Input script**: the same Pcg32 stream continues, two draws per
  tick, in this order: a, then b. Both draws are consumed every tick
  whether or not they are used, so the stream position is a function
  of the tick alone in every language.
  - The move direction updates only at leg starts (ticks where
    t mod 20 = 0) and persists for the whole 20-tick leg, so the
    walk actually travels instead of jittering in place. At a leg
    start, a is consulted: k = a mod 9; the move is (0, 0) when
    k = 8, else the k-th of (1,0), (1,1), (0,1), (-1,1), (-1,0),
    (-1,-1), (0,-1), (1,-1), raw and unnormalized (the tick
    normalizes). On other ticks a is consumed and ignored.
  - Every third leg (leg index mod 3 = 2) ignores a and walks
    (0, 1), straight at the ramp. This is deliberate choreography in
    the scenario, not an accident of the seed: it guarantees ramp
    contact and sliding are exercised in every run.
  - b drives jumping: when b mod 53 = 0, a jump press fires this
    tick and the button stays held for 1 + (b mod 7) ticks including
    the press tick. jumpHeld is true exactly on those ticks.

The script exercises ground acceleration, friction stops, airborne
control, buffered jumps, coyote time, jump cuts, ramp sliding, and
sphere contact. Measured on the canonical run: grounded on 175 of
600 ticks, 9 jump takeoffs, ramp contact on 52 ticks, sphere
contact on 4 ticks. No wall clock, no environment input.

## Canonical state serialization

After each tick, the post-tick state is serialized as a 62-byte
block, concatenated in tick order:

| Bytes | Field | Encoding |
|---|---|---|
| 0..3 | tick index | uint32 little-endian |
| 4..11 | pos.x | float64 bits, little-endian |
| 12..19 | pos.y | float64 bits |
| 20..27 | pos.z | float64 bits |
| 28..35 | vel.x | float64 bits |
| 36..43 | vel.y | float64 bits |
| 44..51 | vel.z | float64 bits |
| 52 | grounded | uint8, 0 or 1 |
| 53..56 | coyote | int32 little-endian |
| 57..60 | buffer | int32 little-endian |
| 61 | jumpHeld | uint8, 0 or 1 |

Floats are serialized as their raw IEEE 754 binary64 bit patterns.
There is no decimal formatting anywhere in the contract, so no
formatting choice can hide or manufacture a divergence. Endianness
is little-endian by definition here, independent of host.

## Digest

The trace digest is FNV-1a 64 over the concatenated blocks,
cumulative: h starts at 14695981039346656037 (0xcbf29ce484222325);
for each byte, h = (h xor byte) * 1099511628211 (0x100000001b3)
mod 2^64. The per-tick digest printed by every runner is h after
that tick's block, as 16 lowercase hex digits. Because the hash is
cumulative, the first tick where two traces disagree is exactly
where their digests split, and they never rejoin by accident.
`parity/golden.tsv` holds the agreed 600 digests.

## Float discipline

The exact path uses only IEEE 754 binary64 operations whose results
are correctly rounded by definition: addition, subtraction,
multiplication, division, and square root, in the order the shipped
tick performs them. Integer work (Pcg32, script derivation) is exact
in every language.

Lengths were the one exception, and measuring them is what this
release did first. The tick originally called libm `hypot`, and the
three hypot implementations do not agree: with w = (1/sqrt(2))*4,
V8's Math.hypot(w, w) returns exactly 4, while CPython, glibc, and
the sum-of-squares form return 3.9999999999999996, a 1 ulp split on
the very first tick; glibc and CPython hypot then split from each
other at tick 221 of the trace. hypot is not correctly rounded and
no tolerance argument makes three different answers one answer, so
hypot left the tick path. As of v2.0.7 the tick computes lengths
with the canonical forms in `src/math/determinism.ts` (`len2`,
`len3`: sqrt of the sum of squares, fixed summation order), and
both ports do the same. That is a deliberate, documented change to
shipped behavior: tick lengths can differ from the pre-v2.0.7 hypot
values by at most 1 ulp, in exchange for being the same value in
every language. With the change, the three traces are bit-identical
on all 600 ticks: the measured cross-language deviation is exactly
zero, not a tolerance. If a future change reintroduces a libm
transcendental or a differently ordered reduction, the digest split
will show the exact tick, and the response is to root-cause it,
not to widen a tolerance. The C++ runner is built with
`-ffp-contract=off` so no fused multiply-add can reorder a
rounding, and without fast-math flags of any kind.

## Negative controls

The harness must prove it can fail. `test/tick-parity.test.ts`
runs, and requires divergence for, each of these:

- **Perturbed constant**: one runner re-runs with gravity offset by
  1e-9. The traces must disagree with the golden trace.
- **Perturbed seed**: the seed plus one. The traces must disagree.
- **Mismatched script**: the input script shifted by one tick. The
  traces must disagree.

A parity suite whose controls pass vacuously would be worse than
none; these are asserted as strictly as the parity itself.
