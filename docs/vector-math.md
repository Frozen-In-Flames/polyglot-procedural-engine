# Vector math core (v3.3.0)

Eight formulas are the working vocabulary of almost every engine
mechanic: whether something is in front of you, how fast you are
moving, what a bounce does, when a prompt appears. Before v3.3.0
this engine *used* all eight, but they lived scattered - a canonical
copy in one module, private re-implementations in four others, two
of them with no canonical home at all. v3.3.0 makes them one core:

- TypeScript: `src/math/vec.ts` (exported from `src/index.ts`)
- Python oracle port: `python/xrgen/vecmath.py`
- Identity suites: `test/vecmath.test.ts`,
  `python/test/test_vecmath.py` - the same fixed battery of vectors,
  with hand-worked expected values, run through both languages.
  That mirror is the cross-language parity check.

## The eight

### 1. Dot product - `dot3(a, b)`

```
a . b = ax bx + ay by + az bz
```

What it measures: alignment. The sign says front vs behind, the
magnitude (against the lengths) says how aligned. In this engine:
diffuse lighting in the forward shading models
(`src/inverse/forward.ts` - the Lambert term `max(0, n . l)` and the
GGX products `n . v`, `n . h`), ray-plane intersection and in-plane
coordinates for gameplay layers (`src/scene/layers.ts`), and contact
normal velocity in the physics solver (`src/physics/collide.ts`).

### 2. Normalize - `norm3(v)`

```
v-hat = v / |v|
```

A direction with the magnitude removed. In this engine: camera
forward/right vectors and layer normals (`src/scene/layers.ts`), and
- on their own deliberately separate rounding paths, see the audit
below - terrain-gradient normals in `src/game/character.ts` and the
SDF normal estimators in `src/math/normals.ts`.

**Contract:** `norm3` never throws and never invents a direction.
The zero vector normalizes to the zero vector. That has been the
engine's convention since the first version of this module (the
`|| 1` guard); v3.3.0 documents and tests it rather than changing
it under existing callers.

### 3. Distance - `distance3(a, b)`

```
d = |b - a|
```

In this engine: emitter-to-listener distance driving spatial-audio
gain and voice priority, and point-to-zone-center distance for
reverb zones (`src/audio/spatial.ts`, which used to carry the only
private copy).

### 4. Reflection - `reflect3(v, n)`

```
r = v - 2 (v . n) n
```

The bounce primitive: projectiles off shields, balls off walls,
mirror directions. New in v3.3.0 - it had no implementation anywhere
in the engine, and it ships tested ahead of its first call site
because it completes the set game code built on the engine reaches
for.

**Contract:** `n` must be unit length. The formula is applied
exactly as written; a non-unit normal overshoots, and the suites
pin that overshoot as a negative control. Nothing silently
renormalizes your normal for you.

### 5. Clamp - `clamp(x, lo, hi)`, `clamp3`, `clamp3v`

```
clamp(x, min, max) = max(min(x, max), min)
```

Scalar form, plus component-wise vector forms against scalar
bounds (`clamp3`) or per-axis bounds (`clamp3v`). In this engine:
the dev math surface (`src/dev/math.ts`) re-exports the core scalar
clamp since v3.3.0, so game logic written against the dev surface
and engine internals share one implementation. Assumes `lo <= hi`.

### 6. Vector length - `len3(v)`, `lengthSquared3(v)`

```
|v| = sqrt(x^2 + y^2 + z^2)        |v|^2 = v . v
```

`lengthSquared3` is the standard companion: comparisons ("is it
within range?") compare squared lengths and skip the square root.
Before v3.3.0 the squared form existed only as the inline idiom
`dot3(a, a)`; now it has a name. The scalar exact-path lengths in
`src/math/determinism.ts` (`len2`, `len3` over components) are a
different tool for a different job - the cross-language tick-parity
path - and stay where they are.

### 7. Lerp - `lerp(a, b, t)`, `lerp3(a, b, t)`

```
lerp(a, b, t) = a + (b - a) t
```

Scalar and vector forms. In this engine: the dev math surface
re-exports the core scalar `lerp`; `lerp3` has been in the core
since before v3.3.0.

**Contract:** `t` is NOT clamped. `t = 0` gives `a`, `t = 1` gives
`b`, and `t` outside `[0, 1]` extrapolates, exactly per the
formula. Callers who want clamping compose with `clamp`/`clamp3`.
The suites pin the extrapolation values so the behavior cannot
silently change.

### 8. Cross product - `cross3(a, b)`

```
a x b = (ay bz - az by,  az bx - ax bz,  ax by - ay bx)
```

The perpendicular of two vectors, right-handed: `x cross y = z`.
In this engine: camera and plane bases (`src/scene/layers.ts` -
`planeBasis` builds `u = norm(n x up)`, `v = n x u`; the pinhole
ray builds `right = norm(up x fwd)`), contact-point velocity
`v + w x r` in the physics solver (`src/physics/collide.ts`), and
silhouette normal gradients (`src/inverse/geograd.ts`). The Python
foundry builds its unprojection basis the same way
(`python/xrgen/geometry.py`).

## The audit: what was consolidated, what was left, and why

| Primitive | Before v3.3.0 | v3.3.0 |
|---|---|---|
| dot | Core `dot3` + private copies in `layers.ts`, `forward.ts`, `collide.ts` | Copies deleted; all import the core |
| normalize | Core `norm3`; private copies in `layers.ts`, `character.ts`; inline in `normals.ts` | `layers.ts` keeps a wrapper ON the core (below); the other two left, deliberately |
| distance | No core form; private `dist3` in `spatial.ts` | `distance3` added to the core; `spatial.ts` delegates |
| reflection | Absent everywhere | `reflect3` added to the core and the port |
| clamp | Scalar only, on the dev surface; one-line lambdas in input/UI modules | Core `clamp`/`clamp3`/`clamp3v`; dev surface delegates; the UI lambdas noted and left (scalar UI idioms, not vector math) |
| length | Core `len3`; squared form only as inline `dot3(a, a)` | `lengthSquared3` named in the core |
| lerp | Scalar on the dev surface; `lerp3` in the core | Scalar `lerp` added to the core; dev surface delegates |
| cross | Core `cross3` + private copies in `layers.ts`, `collide.ts`, `geograd.ts` | Copies deleted; all import the core |

Deliberately NOT rewired, because zero behavior change is the bar
and each of these sits on a different rounding path whose outputs
are pinned by existing suites:

- `src/scene/layers.ts` still wraps normalize locally: it divides
  component-wise (`a[i] / l`) where the core multiplies by the
  reciprocal (`a[i] * (1 / l)`). The two can differ by an ulp. Its
  wrapper is now built on the core's `lengthSquared3`, but its
  division path is untouched.
- `src/game/character.ts` keeps its own normalize on the
  exact-path scalar length from `src/math/determinism.ts` - the
  cross-language tick-parity path, which forbids `Math.hypot` by
  design.
- `src/math/normals.ts` (SDF normals) and `src/xr/camera.ts` (eye
  rays, reprojection) normalize inline through `Math.hypot`, whose
  rounding differs from the sqrt-of-sum-of-squares path by an ulp
  on ordinary inputs.
- `python/xrgen/geometry.py` keeps its private `_dot`/`_cross`/
  `_norm3`: the foundry's zero-guard contract (a vector shorter
  than 1e-12 normalizes to the zero vector, division form) is its
  own, and the foundry is offline tooling. The new
  `python/xrgen/vecmath.py` is the port of record for the core.

Everything that WAS rewired was bit-identical arithmetic - the
same operations in the same order - and the proof is the suites:
every pre-existing test passes unmodified.
