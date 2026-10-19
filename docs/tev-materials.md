# TEV-style functional materials (v1.6.0)

A material as closed-form math instead of texture stacks: a chain of K
combiner stages, each computing

    C_out = (A - B) * C + D

where every slot draws from a fixed input set: the previous stage output,
a fitted constant, or a field term (n.l, n.v, n.h and its powers, the SDF
field value, a noise octave). Parameters = wiring + constants. Nothing
neural anywhere.

## Capacity knob

K and the input-set size are the budget. Small K with restricted inputs
gives the crisp combiner look; larger K with richer inputs approaches full
PBR. Same math, different budget. Error versus K is reported
rate-distortion style below.

## Forward evaluation

`src/material/tev.ts`: `tevEvaluate(spec, consts, ctx)` runs the chain.
`polyChainWiring(k, inputs)` builds an alternating add/mul pattern that
constructs polynomials in the cycled inputs (degree grows with K).
`stripFieldInputs(spec)` replaces every field slot with a fresh constant,
used as the negative-control wiring.

## Inverse fit

`tevFit(spec, samples, theta0, opts)` fits the constants by damped
Gauss-Newton on 1/2 sum (tevEvaluate - target)^2, with central
finite-difference Jacobians (engine convention, 1e-5) and backtracking
line search on the cost. `theta0` is the warm-start slot: pass a previous
solution to continue it. Deterministic; no randomness anywhere.

## Measured results

Reference material (procedural, ground truth exact): spatially varying
albedo as a smoothstep in a noise field, times ambient plus a clamped
diffuse term. 21x21 deterministic grid over (noise, n.l).

| K | params | PSNR (dB) | iterations |
|---|--------|-----------|------------|
| 0 (constant) | 1 | 12.88 | - |
| 2 | 4 | 19.74 | 2 |
| 4 | 8 | 19.88 | 4 |
| 8 | 16 | 20.48 | 5 |

The bar is 20 dB at K=8 (pinned from measurement with margin). The
constant-output and field-stripped wirings both fail the bar, which is the
point: the fit finds structure rather than the optimizer merely running.

## Extrapolation trade-off (honest finding)

Higher K fits better in-sample but extrapolates worse past the training
range, where the true albedo goes flat and the polynomial oscillates.
Held-out noise range, RMSE ratio vs train:

| K | train [0, 0.7] | train [0, 0.8] |
|---|---------------|---------------|
| 4 | 3.68x | 2.42x |
| 6 | 5.83x | 2.06x |
| 8 | 11.28x | 6.49x |

The test pins K=4 trained to 0.8 against a 4x bar (measured 2.42x).
The capacity knob has two edges: in-sample fit and out-of-sample
stability pull in opposite directions as K grows.

## Limits

- The reference is a toy: one scalar channel, no shadows, no
  interreflection, no specular lobe. Real materials will dominate these
  numbers with model error.
- Polynomial chains are poor extrapolators at high K; saturating or
  piecewise stage forms are future work.
- Warm starts help when the target shifts slightly (fewer iterations
  than cold); large scene changes still want the linear re-initializer.
