# Frozen In Flames - Polyglot Procedural Engine v3.3.0

## The vecmath core: the classic eight, consolidated

**What is new.** The eight classic game-engine vector primitives
now live in one canonical, tested core instead of being scattered
across the codebase:

1. Dot product - `dot3`
2. Normalize - `norm3`
3. Distance - `distance3` (new to the core)
4. Reflection - `reflect3` (new - it existed nowhere in the engine)
5. Clamp - `clamp`, `clamp3`, `clamp3v` (vector forms new)
6. Vector length - `len3`, plus the named `lengthSquared3`
   companion for sqrt-free comparisons
7. Lerp - `lerp`, `lerp3`
8. Cross product - `cross3`

TypeScript core: `src/math/vec.ts`. Python oracle port, mirroring
the arithmetic operation for operation: `python/xrgen/vecmath.py`.
Reference page: `docs/vector-math.md`, with the equations, the
contract decisions, and a per-primitive map of where the engine
itself uses each one.

**Why it was added.** These eight are the working vocabulary of
every engine mechanic - checking front vs behind, diffuse lighting,
walkable slopes, attack ranges, bounces and ricochets, camera
bases, speed limits. The engine already used them, but as a
canonical copy in one module plus private re-implementations in
four others, with distance homeless and reflection missing.
Scattered math drifts: every private copy is a place a formula can
quietly diverge from the others. One core, imported everywhere,
with identity suites pinning the algebra, removes that class of
bug - and game code built on the engine now gets the same eight
from the same place the engine does.

**Consolidation, with zero behavior change.** Private copies were
deleted and rewired to the core only where the arithmetic was
bit-identical (dot/cross/sub in `src/scene/layers.ts`, dot in
`src/inverse/forward.ts`, cross/dot in `src/physics/collide.ts`,
cross in `src/inverse/geograd.ts`, distance in
`src/audio/spatial.ts`, scalar clamp/lerp re-exported by
`src/dev/math.ts`). Sites on deliberately different rounding paths
were left untouched and are itemized in `docs/vector-math.md`.

**Contracts, decided and documented.** The zero vector normalizes
to the zero vector (the engine's standing convention - documented
and tested, not changed under existing callers). `reflect3`
requires a unit normal and applies the formula exactly as written;
a non-unit normal overshoots, pinned by a negative control. Lerp
does not clamp `t`: extrapolation is the documented behavior, and
the suites pin the extrapolated values.

**Measured.** TypeScript: 659 -> 678 tests, all passing (19 new
identity tests). Python: 91 -> 106 tests, all passing (15 new).
Both suites run the same fixed battery with hand-worked expected
values - that mirror is the cross-language parity check. Every
pre-existing suite passes unmodified; no pinned digest or expected
value changed; the full project build is clean.
