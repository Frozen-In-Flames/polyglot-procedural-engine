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

## 5. Validation ledger (canonical reference)

Every formula below is marked ✔ (validated against an independent
reference: oracle script, published vector, or measured identity) or
○ (implemented from memory, UNVALIDATED, pending an oracle test).
○ items are flagged in code comments wherever they appear.

V10.1/V10.2, validated:
- ✔ Sphere-tracing under-relaxation: warped field tunnels at omega=1.0,
  converges at 0.85 (test/lipschitz.test.ts).
- ✔ Per-operator Lipschitz bounds: zero violations over random pairs;
  measured looseness warp 1.06x, noise displacement 1.48x, twist 2.23x,
  noise-gradient 1.78x. Note: ~2x loose bound costs ~2x the steps, and
  random sampling can FIND violations but cannot CERTIFY a bound.
- ✔ Band-limit fade w_k = 1 - s(clamp(4 f_k Dx - 1, 0, 1)),
  s(x) = 3x^2 - 2x^3, Dx = t delta (smoothstep form, normative).
- ✔ sRGB encode/decode round trip within tolerance.
- ✔ Lanczos weights sum to 1 (separable, normalized).
- ✔ GGX D normalization: integral 2 pi D(x,a) x dx = 1 within 1e-8
  (oracle docs/oracles/ggx_oracle.py, checks 1-6 ported).
- ✔ Smith masking identity within 2e-4; reciprocity within 1e-12;
  visibility V = 1/((nl+s_l)(nv+s_v)) within 1e-9, finite at nl=0
  (normative implementation form).
- ✔ GGX importance sampler moments match quadrature within 2e-3.
- ✔ White furnace (F=1): MC == quadrature, albedo <= 1 + 5 se.
- ✔ SH: constant white environment gives E = pi (rho E / pi output).
- ✔ GBR identity: G transform leaves images identical AND puts a null
  direction in J; albedo-intensity pair gives a near-zero singular value.
- ✔ PCG RXS-M-XS vs published vectors; pcg32(42,54) reproduces six
  vectors; naive multiply disagrees with the BigInt oracle on
  99,934/100,000 inputs (Math.imul required).
- ✔ FNV-1a: "" = 0x811C9DC5, "foobar" = 0xBF9CF968; naive multiply
  disagrees on 19,395/20,000 random strings (Math.imul required).
  The "a" vector (0xE40C292C) does NOT catch the overflow.
- ✔ 34.5 KB gz figure with reproduce command (docs/mvp.md).
- ○ 3D silhouette normal-speed derivation: UNVALIDATED (from memory).
  The 2D disk identities (coverage derivative = in-pixel arc length,
  translation derivative = contour v.n) hold to five digits; the 3D
  normal speed is flagged wherever it appears, pending an oracle.
- ○ Temporal history clamp: PROVISIONAL (toy 1D model only). Ghost
  0.051 unclamped / 0.000 min-max / 0.003 variance-clip gamma=1;
  static-noise cost 0.046 -> 0.075 min-max, 0.053 variance gamma=1,
  gamma=3 matches unclamped. Pending a render test.

V10.3, validated:
- ✔ Tetrahedron normals are O(h) (measured, linear), central
  differences O(h^2); the remembered "quadratic tetrahedron" claim
  did not survive measurement and is not shipped.
- ✔ Rodrigues == quaternion rotation matrix; ||q|| = 1 after 1e6 steps;
  symplectic-Euler pendulum energy bounded.
- ✔ Dropped sphere rests at y = r within 1e-6 (sleeping threshold);
  e = 1 return height within O(h).
- ✔ XR reprojection: identity pose gives x' = x (homogeneous); pure
  rotation matches the rotation-only formula.
- ✔ RBJ biquad DC gain = 1; Doppler approaching gives f_o > f_s.
- ✔ Huber/IRLS downweights outliers; LM gain-ratio accept/reject;
  Eikonal loss zero on a true SDF.
- ✔ 8-bit sigma_n = 1/(255 sqrt(12)); n_eff < n in covariance.
- ✔ Kahan/2Sum/ULP/tree-sum determinism harness; NaN/infinity policy
  defined (infinities same sign: 0 apart; else infinite; NaN: infinite).
- ✔ Rate-distortion: measured vs predicted MSE increase agree.

V10.3, unvalidated (○):
- ○ Error-state filter (quaternion + gyro bias): implemented per the
  canonical equations; oracle against simulated rotations with a known
  gyro bias is INCOMING and will be ported on arrival.
- ○ SH white-environment oracle (E = pi): implemented and tested
  internally; the owner's independent oracle is INCOMING.

DROPPED (do not implement): linear Kalman equations (error-state only),
PCA as automatic semantic sliders (curated manual names only), separate
albedo and intensity coefficients (merged rho*E only).
