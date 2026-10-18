# Methods provenance (V10 math-first MVP)

Every method in the V10 build is implemented from first principles using
classical, public-domain techniques. No patented pipeline is copied, and
no third-party technology is embedded.

The claim being made is the combination, not novelty in the pillars:
zero asset files, a polyglot core, and distilling solves into closed-form
math. Each technique below is public-domain prior art; the engine's
contribution is shipping them as one artifact where the stored world is
KBs of formulas (theta plus shader code), never as model files or
imported assets.

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
- Neural-free, precisely: no ML framework at runtime. The runtime can
  evaluate a small MLP (`src/bridge/distill.ts` carries optional
  `heightStyle` weights for TsMlProvider), but learned weights ship as
  baked constants inside the distillation bundle, never as model files,
  and the MLP evaluator is optional and off when the bundle has no style
  weights. The V10 math-first path (SDF + classical solvers) is
  neural-free outright.

## 3. Semantic parameter mapping

- Mapping one human-readable control to a bundle of underlying parameters
  is universal prior art: every synthesizer macro control and audio
  software parameter link does this. No novelty is claimed and none is
  needed. The engine's contribution is applying the pattern to procedural
  world math with transparent, inspectable mappings (each semantic slider
  documents exactly which math variables it drives).

## 4. Determinism audit (V10.2)

Which paths are bit-exact and which are tolerance-checked, recorded so
the claim "deterministic" always points at a mechanism:

- Bit-exact, integer: the PCG RXS-M-XS hash (`src/math/determinism.ts`).
  All arithmetic is mod 2^32 via Math.imul and >>> 0; tested against
  reference vectors from an independent exact implementation of the
  published formulas (test/determinism.test.ts). Width-independent.
- Bit-exact, float64: the Python foundry <-> TypeScript bridge
  (distillDetail bit-exact, tested). Nothing on this path narrows.
- Bit-exact, float32: TS <-> C++/WASM <-> GLSL <-> Swift <-> Kotlin.
  Canonical width is float32; every operation on an exact path is
  wrapped in f32() (Math.fround) so exactness holds at the first
  multiply. "Bit-exact" is meaningless without the width; the width is
  the claim.
- Tolerance-checked: GLSL highp evaluation (float32, tolerance-checked
  per INVERSE.md); Math.sin/cos in domain warps (twist); the polynomial
  sinPoly/cosPoly replacements (|error| <= 1e-9 after range reduction,
  tested) for exact paths that need a transcendental.
- Never bit-exact across languages: anything through libm
  transcendentals without the polynomial replacement, and FMA-fused
  evaluations (FMA changes rounding; exact paths use fixed-order
  polynomials instead).

The canonical cross-language hash is the PCG variant; all new noise
(valueNoisePcg, fbmBandLimited) uses it. The legacy hash3 (Math.imul)
is fine and stays.
