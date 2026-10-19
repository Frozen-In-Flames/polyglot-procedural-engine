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

This is the consolidated set, trimmed to what the engine uses. Status marks: ✔ means I ran it against an independent reference, ○ means it's from memory and still untested.

---

## 1. Geometry

**Field:** $f:\mathbb R^3\to\mathbb R$ with $|f(\mathbf x)|\le \operatorname{dist}(\mathbf x,\partial\Omega)$, negative inside. A field that never overestimates distance is all the marcher needs.

**Primitives:** sphere $\|\mathbf p\|-r$. Box, with $\mathbf q=|\mathbf p|-\mathbf b$: $\ \|\max(\mathbf q,0)\|+\min(\max(q_x,q_y,q_z),0)$.

**Operators:** union $\min(a,b)$, intersect $\max(a,b)$, subtract $\max(a,-b)$, and

$$\operatorname{smin}(a,b)=\min(a,b)-\tfrac k4h^2,\quad h=\tfrac{\max(k-|a-b|,0)}{k}$$

**Lipschitz bounds** ✔ (zero violations on all five compositions):

| Operator | $L$ |
|---|---|
| $\min,\max$ | $\max(L_a,L_b)$ |
| sum | $L_a+L_b$ |
| warp $f(\mathbf x+\mathbf w)$ | $L_f(1+L_w)$ |
| displace $f+A\,n$ | $L_f+A\,L_n$ |
| twist $kz$ | $L_f(1+k\,r_{\max})$ |

**Noise** ✔, with $S(t)=6t^5-15t^4+10t^3$ and $S'(t)=30t^2(1-t)^2$:

$$\|\nabla N\|\le\sqrt3\cdot1.875\,R,\qquad L_n=A\sqrt3\cdot1.875\,R\sum_k(2a)^kw_k$$

**Terrain** ○: $\ f=\dfrac{y-h(x,z)}{\sqrt{1+s^2}}$, where $s$ is the slope bound.

---

## 2. Rendering

**March** ✔ (the step form; the safe over-relaxation variant is ○):

$$t_{k+1}=t_k+\frac{f(\mathbf o+t_k\mathbf d)}{L},\qquad \text{hit when } f<\varepsilon(t)=t\,\delta,\quad \delta=\frac{2\tan(\text{fov}/2)}{H}$$

**Normal** (tetrahedron, $h=\varepsilon(t)$) ○: $\ \mathbf n\propto\sum_{i=1}^4\mathbf s_i\,f(\mathbf p+h\mathbf s_i)$

**Shadow and AO** ○:

$$s=\operatorname{clamp}\Big(\min_i\tfrac{k\,f(\mathbf p+t_i\mathbf l)}{t_i},0,1\Big),\qquad \text{AO}=\operatorname{clamp}\Big(1-k\sum_i2^{-i}\big(h_i-f(\mathbf p+h_i\mathbf n)\big),0,1\Big)$$

**Shading** ○: Lambert $\rho/\pi$, and GGX:

$$f_r=\frac\rho\pi+\frac{DFG}{4(\mathbf n\cdot\mathbf l)(\mathbf n\cdot\mathbf v)},\quad D=\frac{\alpha^2}{\pi((\mathbf n\cdot\mathbf h)^2(\alpha^2-1)+1)^2}$$

**Environment light** ○: $\ E(\mathbf n)=\sum_{l\le2}\hat A_lL_{lm}Y_{lm}(\mathbf n)$ with $\hat A=(\pi,\tfrac{2\pi}3,\tfrac\pi4)$, and output $\rho E/\pi$.

**Band-limit** ○: $\ w_k=1-s\big(\operatorname{clamp}(4f_k\Delta x-1,0,1)\big)$, $\ s(x)=3x^2-2x^3$, $\ \Delta x=t\delta$.

**Display** ○: linear to sRGB is $12.92\,C$ for $C\le0.0031308$, else $1.055\,C^{1/2.4}-0.055$.

**Stereo** ○: $\ \mathbf o_{L/R}=\mathbf o_{\text{head}}\mp\tfrac{\text{IPD}}2R\mathbf e_x$, $\ \mathbf d=R\,\mathbf d_{\text{eye}}/\|\mathbf d_{\text{eye}}\|$.

**Reprojection** ○: $\ \mathbf p=\mathbf o+t\mathbf d$, $\ \mathbf x'\sim K'R'^{-1}(\mathbf p-\mathbf o')$.

---

## 3. Solving

**Loss and step:**

$$\mathcal L=\tfrac12\sum_j(\hat y_j-y_j)^2,\qquad (J^\top J+\lambda\operatorname{diag}(J^\top J))\,\delta=-J^\top r$$

Accept the step if the gain ratio $\varrho=\dfrac{\mathcal L(\theta)-\mathcal L(\theta+\delta)}{\frac12\delta^\top(\lambda D\delta-g)}>0$ ○.

**Geometry gradients** ✔ (match finite differences to about $10^{-10}$):

$$\frac{\partial t^*}{\partial\theta}=-\frac{\partial_\theta f}{\nabla f\cdot\mathbf d},\qquad \frac{d\mathbf n}{d\theta}=\frac{(I-\mathbf n\mathbf n^\top)\big(H\mathbf d\,\tfrac{\partial t^*}{\partial\theta}+\partial_\theta\nabla f\big)}{\|\nabla f\|}$$

**Silhouette term** (2D coverage identity ✔, 3D derivation ○):

$$\oint(c_{\text{in}}-c_{\text{out}})(\mathbf v_\theta\!\cdot\mathbf n_b)\,d\ell$$

**Variable projection** ✔, with $\hat y=\Phi(\theta)\mathbf c$ and constant-rank $\Phi$:

$$\mathbf c=\Phi^+y,\quad r=P^\perp y,\quad \frac{\partial r}{\partial\theta_k}=-\big[P^\perp D_k\Phi^++(P^\perp D_k\Phi^+)^\top\big]y$$

Fit the merged coefficient $\rho E$, not $\rho$ and $E$ separately.

**Diagnostics** ○: normalize the columns of $J$, then $J^\top J=V\Sigma^2V^\top$ and $\operatorname{Cov}\approx\sigma_n^2(J^\top J)^{-1}$. For an 8-bit target use $\sigma_n=\tfrac1{255\sqrt{12}}$ and $n_{\text{eff}}<n$.

**Regularization and bounds** ○: $\ \min\|r\|^2+\mu\|\Gamma\theta\|^2$, and $\ \theta=\theta_{lo}+(\theta_{hi}-\theta_{lo})\,\sigma(\phi)$.

**Texture loss** ○: log power spectrum plus the sorted-pixel Wasserstein term.

---

## 4. Interface and size

**Slider map** ○: $\ \mathbf c=\mathbf a u^2+\mathbf b u+\mathbf c_0$, clamped and checked for monotonicity.

**Parameter reduction** ○: $\ \mathbf z=V_k^\top(\theta-\bar\theta)$, with $V$ from the SVD of centered example parameters. The sliders need curated names.

**Size curve** ○: $\ \Delta_i=\sqrt{\tfrac{12\,n\,D}{p\,s_i}}$, $\ b_i=\log_2\tfrac{\theta_{hi,i}-\theta_{lo,i}}{\Delta_i}$, and AIC $=n\ln\tfrac{\text{RSS}}n+2k$.

---

## 5. XR and motion

**Rotation:** $q=(\cos\tfrac\theta2,\sin\tfrac\theta2\mathbf n)$ and $\mathbf v'=q\mathbf vq^*$ ○. Slerp is $\tfrac{\sin((1-u)\Omega)}{\sin\Omega}q_0+\tfrac{\sin(u\Omega)}{\sin\Omega}q_1$ ○.

**Tracking filter** (error-state, untested) ○:

$$\hat q\leftarrow\hat q\otimes\exp((\omega_m-\hat b)\Delta t),\qquad P\leftarrow FPF^\top+Q,\qquad K=PH^\top(HPH^\top+R_m)^{-1}$$

**Contact against the field** ○: penetration when $f(\mathbf c)<r$, with $\mathbf n=\nabla f/\|\nabla f\|$ and contact point $\mathbf c-f(\mathbf c)\mathbf n$.

**Temporal:**
- EMA $C_t=(1-\alpha)\tilde C_{t-1}+\alpha c_t$ has $N_{\text{eff}}=\tfrac{2-\alpha}\alpha$ ✔.
- Critically damped spring: $e(t)=(e_0+(v_0+\omega e_0)t)e^{-\omega t}$ ✔.
- Halton radical inverse ✔.
- History clamp is a trade: $\gamma=1$ cut ghost error from 0.051 to 0.003 at the cost of about 15% more noise ✔ (toy 1D model).

---

## 6. Determinism

$$\text{FNV: } h\leftarrow\text{imul}(h\oplus b,\,16777619)\ \ ✔,\qquad \text{PCG hash: all multiplies via imul}\ \ ✔$$

$$u=(h\gg8)\,2^{-24}\ \ ○,\qquad \text{ulp}(a,b)=|\text{key}(a)-\text{key}(b)|\ \ ✔$$

---

## Dropped from earlier lists

- The linear Kalman equations, replaced by the error-state filter above.
- PCA as automatic semantic sliders, replaced by PCA plus manual naming.
- Separate albedo and intensity coefficients, replaced by the merged coefficient.
