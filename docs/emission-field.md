# Emission field layer (v2.0.8)

The tokamak-geometry emissivity field in `src/scene/emission-field.ts`,
exposed to the layer system as `EmissionLayer` (`kind: 'emission'`) in
`src/scene/layers.ts`. Step 8 of the road to v3.0.0, the last step
before the v3.0.0 integration.

## The field

Space is organized toroidally about a core circle of major radius R
(the torus axis ring, in the XZ plane about the field center), with
tube minor radius r < R. For a point p, with radial = |(x, z)| in the
local frame:

    axis distance   d_axis = |(radial - R, y)|
    normalized rho  rho    = d_axis / r
    toroidal angle  theta  = atan2(z, x)
    poloidal angle  phi    = atan2(y, radial - R)

    emission(p) = I0 * (1 - rho^2)^alpha
                    * (1 + aTor * cos(nTor * theta + phaseTor))
                    * (1 + aPol * cos(phi + phasePol))    for rho < 1
                = 0                                       for rho >= 1

The base profile is the standard peaked tokamak emissivity form:
maximum I0 on the core circle, strictly monotone falling in rho,
continuous across the boundary, compact support. The toroidal factor
models mode structure around the ring; the poloidal factor models
inboard/outboard asymmetry. Amplitudes are validated into [0, 1], so
each factor stays in [0, 2] and the product can never change sign.

Parameters are validated at construction and invalid ones throw:
non-positive or sign-flipped radii, r >= R (no hole, or a
self-intersecting tube), a non-positive exponent (flat or rising
toward the boundary, and discontinuous there), negative intensity,
amplitudes outside [0, 1], a fractional or negative toroidal mode,
and any non-finite value. There is no silent fallback: a quietly
wrong field would still render, just falsely.

## The distance story

`distAt(p) = d_axis - r` is the exact signed distance to the torus
surface, the same closed form as the `torus` node of
`src/math/sdf.ts`. The suite grades the two equal on a grid to
1e-12 and checks the defining distance property directly: over 2000
deterministic point pairs, |distAt(p) - distAt(q)| never exceeds
|p - q| (1-Lipschitz, as any true distance must be). Consequences
the engine gets for free: `contains(p)` is `distAt(p) <= 0`, and the
tube boundary is a marchable SDF surface (a `Solid3D` layer whose
sdf is `distAt` sphere-traces to the analytic intersection, graded
in the suite).

What is not claimed: the emission intensity itself is not a
distance and has no Lipschitz-1 property; only `distAt` carries
the distance guarantee. The poloidal angle is singular on the core
circle; emission exactly on the axis uses the phi = 0 convention
(pinned in the suite), and with a poloidal amplitude set, values
arbitrarily near the axis vary with the approach angle, as
poloidal coordinates do.

## Integration

`integrateEmission(field, origin, dir, tMax)` midpoint-integrates
the field along a ray segment. The quadrature policy
(`emissionQuadrature`) is shared with the layer compositor: nominal
step r / 16 per minor radius, shrunk so the samples tile [0, tMax]
exactly (no sample ever lands past the segment end, which is what
keeps occluded glow from leaking past a surface), capped at 8192
samples. Graded against the analytic chord integral
I0 * r * 16/15 for alpha = 2 through the tube center: default
quadrature within 5e-3 relative, 512-per-minor quadrature within
1e-5.

As a layer, emission is volumetric and owns no surface.
`marchScene` finds the nearest surface hit as usual, integrates
each emission layer's radiance (per-sample tint via the usual
color callback, or a constant tint, times gain) only as far as
that surface, and adds it to the hit color. Standing alone, a
nonzero glow returns as a hit of kind 'emission' at depth
Infinity; zero glow returns the clean miss. A stack with no
emission layer runs the original path untouched, and a
zero-intensity emission layer is pinned bit-identical in the
suite over a 25-ray fan.

## Limits

- Axis convention: the poloidal singularity above.
- The field is static; time variation belongs to the 4D layer
  machinery if it is ever needed, not to this field.
- Spheres only is a physics constraint, not this field's; the
  field itself is a pure function of position with no state.
- No audio consumer exists for a volumetric visual field in the
  current architecture, so none was bolted on.
- The demo is untouched: it renders the SDF node tree through its
  own GLSL path, and a volumetric emission pass there is a shader
  project of its own, not a modest addition to this release.
