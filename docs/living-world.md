# Living world (v3.0.0)

The V3 campaign's systems, composed into one world that lives:
terrain, bodies, light, a watcher, and a heartbeat, all from one
seed. This is the integration release: no new physics, no new
fields, only the composition and the evidence that the pieces
still tell the truth when they share a world.

## Composition

`makeLivingWorld({ seed, gravity?, emission? })` in
`src/scene/living.ts` assembles, deterministically:

- **Terrain** (v2.0.3): a 28x28 grid of solid cells carrying
  analytic rolling-hills heights, one Gaussian hill, and a flat
  plaza, exposed as a conservative distance field
  (`GridTerrain.distAt`) with the measured slope bound
  `slopeBound = 1.4832` at the canonical seed.
- **Bodies** (v2.0.5): three spheres dropped on the plaza and a
  two-sphere stack, stepped by the XPBD contact solver against
  the field (three position iterations per substep; the field's
  gradient magnitude is `1 / sqrt(1 + S^2)`, so one pass closes
  only that fraction of a contact's residual).
- **The character** (v2.0.7): `tickCharacter` at the parity-pinned
  60 Hz tick, standing grounded on the plaza as the heartbeat.
- **Emission** (v2.0.8): a tokamak-geometry emission ring standing
  over the hill side of the world, with a live instance the world
  owns and a nominal instance the watcher predicts.
- **The watcher** (v2.0.4): Wald robust change detection at its
  final operating point (GM c = 1.2, canonical T against the 99%
  chi-square threshold), reading 24 probes: 16 on the ring's
  profile slope where a moved light is loudest, 8 on the core
  circle where intensity lives.

The world steps as one (`stepTick`: character first, then bodies)
and answers composed queries: `march` (terrain by the interval
guaranteed march or the field policy, bodies and the character as
analytic spheres, emission glow integrated up to the nearest
surface), `terrainColorAt` (the color story the layers share),
`layers` (the scene-layer assembly of the same state), `watch`
and `observe` (the watcher's detection and its deterministic
noisy observation), and `digest` (an FNV-1a digest of the full
composed state).

## Measured (canonical seed 20261022, pinned in the suite)

| Evidence | Bound | Measured |
|---|---|---|
| Bodies settle and stay | rest within 5e-3, speeds at most 1e-2 | residuals 4e-7 (singles), 3e-6 (stack), stack limit cycle about 5e-3 |
| No tunneling, whole settle | no sink past 1e-3, worst post-solve penetration at most 1e-3 | worst penetration 6.7e-4, at the stack impact |
| Long-horizon rest | drift over 600 further ticks | exactly 0 |
| March vs analytic raycast | no overshoot, undershoot at most 1e-2 | 24 rays, 0 overshoots, worst undershoot 5.6e-3 |
| Occlusion | glow exactly 0 behind terrain; clear view large | 0 behind the hill; magnitude 5.74 clear |
| Watcher, no change | canonical quiet, at most 5/60 alarms | 0/60; canonical T 3.9 vs 11.34 |
| Watcher, light moved (0.30, 0.15) | canonical alarms, at least 19/20 | 20/20; canonical T 29.6 vs 11.34 |
| Digest | bit-identical across runs | identical (initial 8a2262d2aa86660f) |

Negative controls, all failing as required: sign-flipped gravity
settles nothing and the character never grounds; a build-level
dark world changes the marched colors by exactly the occluded
glow and nothing else; an interval-march query whose claimed
slope bound understates the world's real bound is caught by the
bound-violation counter.

## Honest limits

- The character and the bodies share the terrain field but do not
  collide with each other. Character-to-body contact is future
  work, not a hidden behavior.
- Bodies are spheres only, matching the v2.0.5 solver's reach.
- Resting clearance uses the field-wide global slope bound, the
  price v2.0.3 documented for a conservative field.
- The watcher watches the emission light (position and intensity)
  because that is the change its probes can see. Terrain edits and
  body removals are world edits the current probe set does not
  observe; a terrain watcher needs its own probe story.
- The demo renders the composed world by CPU march at adaptive
  resolution with reduced emission quadrature, labeled as such in
  its state panel. The suite grades the full quadrature policy.

## Demo

`demo/living.html` (the `living` entry in the demo build): the
composed world marched live, the V9 unified input rig for the
camera, panels in the established demo conventions. Buttons: Move
the light (the watcher catches it), Emission on/off (the layer
toggle), Reset world (rebuild from the seed). The march policy
switches between the interval guaranteed march and the terrain
field policy.
