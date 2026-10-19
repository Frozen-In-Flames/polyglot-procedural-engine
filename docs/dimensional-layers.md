# Dimensional layering: 2D, 2.5D, 3D, 4D in one field of view

## Idea
One scene holds elements of every dimensionality. A flat figure (2D), parallaxing
backdrop planes (2.5D), raymarched solid geometry (3D), and time-evolving fields
(4D) all composite in the same field of view through one field evaluation.
Developers tag each element with its dimensionality; the engine handles the rest.

## Why it fits this engine
The core is already a field evaluator. Dimensionality is a property of how an
element answers "what is the field value here", not a separate pipeline:

- 2D: a flat field in billboard space, facing the camera (or fixed orientation).
  The 3D query reduces to a 2D SDF plus a TEV material.
- 2.5D: a plane layer at depth d with parallax scale s. Content is 2D within the
  layer; the layer drifts against camera motion at rate s. The multiplane effect
  as arithmetic, not as stacked glass.
- 3D: the standard SDF, raymarched as today. Unchanged.
- 4D: a time-varying field f(p, t), meaning 3D plus time. The field itself
  evolves; it is evaluated at the current frame time. The temporal stability
  rules from v1.3.0 apply. A literal fourth spatial dimension is out of scope.

## FOV compositing
The camera ray marches one unified field. 2D billboards contribute as
depth-constrained samples where the ray meets the billboard plane. 2.5D layers
contribute at their plane depths with parallax-adjusted coordinates. 3D marches
normally. 4D evaluates at time t. One loop, no separate passes; occlusion falls
out of the march order.

## Inverse rendering across dimensions
The solvers do not care about dimensionality. A 2D sprite tint, a 2.5D layer
parallax rate, a 3D light azimuth, a 4D field evolution rate are all just
parameters in theta. Same Gauss-Newton, same NIS gating, same robust costs.
The forward model carries the dimensionality; the inverse machinery is uniform.

## API sketch (finalized at build)
- `layer2D(spec)`: billboard element { field2D, material, facing }
- `layer25D(spec)`: plane layer { depth, parallaxScale, content2D }
- `solid3D(spec)`: existing SDF geometry (unchanged)
- `field4D(spec)`: time-varying field { field(p, t), timeSource }
- A scene composes a list of layers; the marcher evaluates them in depth order.

## Validation (tests before implementation)
- A mixed scene renders with correct occlusion across dimensionalities.
- Parallax: a 2.5D layer at known depth and scale moves the expected pixels
  under camera translation (exact arithmetic check).
- 4D: a time-varying field matches analytic evolution across frames; ghosting
  stays within the v1.3.0 bounds.
- Inverse: joint fit of a 2D parameter and a 3D parameter from one image
  sequence; both recover to stated tolerances.
- Negative controls: a 2D element with wrong facing fails its render test;
  a 2.5D layer with parallax 0 reads as static under camera motion
  (proves the parallax path is live, not decorative).

## Discrete gameplay layers (VR-capable plane play)
Beyond visual parallax, layers can be gameplay planes: a fixed stack of depth
planes (three is the classic count) that the player character inhabits and hops
between. Each plane is a 2.5D layer with its own content and collision; hopping
is a depth translation of the player, not a camera trick. In VR the planes stop
being a visual effect and become navigable space: the player moves through real
depth between planes while the headset tracks true head position. Craft-style
material looks (cardboard, felt, sponge) for layer content ride on the v1.6.0
TEV material system as fixed combiner chains.

## Limits (honest)- 4D means 3D plus time. Literal fourth spatial dimension is not in scope.
- Mixed-march performance is unmeasured until built.
- Per-object mixed aesthetics (flat vs full shading) ride on the v1.6.0 TEV
  material system; the layering API does not reimplement materials.
