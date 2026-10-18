# Methods provenance (V10 math-first MVP)

Every method in the V10 build is implemented from first principles using
classical, public-domain techniques. No patented pipeline is copied, and
no third-party technology is embedded.

## 1. SDF primitives, operators, and raymarching

- Signed distance fields as implicit surface representations: public
  mathematics, in continuous use since the 1980s and 1990s.
- Sphere tracing (advancing along a ray by the SDF value, which is a safe
  step bound): published by Hart in 1996 ("Sphere tracing: a geometric
  method for the antialiased ray tracing of implicit surfaces"). A
  long-established technique, implemented here from the published
  mathematics.
- Primitives (sphere, box, torus, capsule, plane): closed-form distance
  functions from standard analytic geometry.
- Boolean composition: min/max combination; smooth blending via the
  polynomial smooth-minimum formulation, a standard public-domain
  construction.
- Domain repetition and warping: coordinate transforms applied before
  distance evaluation; standard procedural-graphics practice, public
  domain.
- Value noise and fractal Brownian motion: lattice-hash noise techniques
  from the 1980s, public domain.
- Soft shadows and SDF ambient occlusion: derived from repeated SDF
  sampling along rays; standard public techniques.

The raymarcher is written from the mathematics above. It copies no
patented rendering pipeline.

## 2. Inverse solvers

- The V10 inverse solvers are classical numerical optimization applied to
  scene parameters: linear least squares (Legendre/Gauss, 1805, public
  domain) and gradient descent (Cauchy, 1847, public domain).
- They solve for light parameters and procedural material coefficients
  against rendered samples. They are not neural networks, not
  differentiable-rendering frameworks, and use no learned priors. They
  therefore do not touch neural inverse-rendering patent families, which
  cover learned and differentiable pipelines.
- The two-sided foundry/runtime split is the engine's own architecture,
  documented in INVERSE.md: heavy compute may run once offline in the
  foundry; the runtime keeps zero new dependencies.

## 3. Semantic parameter mapping

- Mapping one human-readable control to a bundle of underlying parameters
  is universal prior art: every synthesizer macro control and audio
  software parameter link does this. No novelty is claimed and none is
  needed. The engine's contribution is applying the pattern to procedural
  world math with transparent, inspectable mappings (each semantic slider
  documents exactly which math variables it drives).
