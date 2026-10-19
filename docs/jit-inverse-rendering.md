# Just-in-time inverse rendering (owner validation document)

I'll check the new pieces numerically rather than answering from memory, since several of my earlier formulas needed correction. "Just in time" here means solving for scene parameters per frame under a fixed time budget. The core claims to test are warm-started MAP Gauss-Newton, change detection, pixel subsampling, and one-shot light estimation.

One check I wrote, F2, was a vacuous `True`, a fake PASS. I'm turning it into a real assertion so the file doesn't claim more than it tests.

Just-in-time inverse rendering reduces to one small statistical problem per frame, solved from a warm start under a time budget. ✔ marks what I ran in `test_jit_inverse.py`, and ○ is from memory or arithmetic. The test is a toy: a Lambertian sphere with known geometry and albedo, unknown light direction, intensity and ambient, and Gaussian noise.

## 1. The per-frame solve is a MAP step (✔)

With state θ, residual r = y − R(θ), Jacobian J, pixel noise σ², and the previous frame's posterior as the prior:

$$\Big(\tfrac{J^\top J}{\sigma^2}+P_{\text{pred}}^{-1}\Big)\delta=\tfrac{J^\top r}{\sigma^2}+P_{\text{pred}}^{-1}(\theta_{\text{pred}}-\theta),\qquad P^+=\Big(\tfrac{J^\top J}{\sigma^2}+P_{\text{pred}}^{-1}\Big)^{-1}$$

$$\theta_{\text{pred}}=\theta^+_{t-1},\qquad P_{\text{pred}}=P^+_{t-1}+Q$$

This is exactly the Kalman update in the linear case (matches to 1e-13), so a single Gauss-Newton step with a prior is an EKF step. The information matrix $J^\top J$ you accumulate anyway gives the posterior covariance for free. Backtracking on the MAP cost keeps steps from making things worse (○, not tested separately).

## 2. Initialization decides whether the solve works (✔)

| Start | Iterations | Failed frames |
|---|---|---|
| Fixed cold init | 9.0 (max 22) | **28%** |
| Closed-form linear init | 4.6 | 0% |
| Warm start from the previous frame | 3.1 (max 4) | 0% |

A fixed cold start fails when the light direction lands in a zero-gradient region. The closed-form initializer ignores the clamp and solves $y/\rho=A+\mathbf n\cdot\mathbf v$ for $(A,\mathbf v)$ by least squares, then sets $I=\|\mathbf v\|$ and $\mathbf l=\mathbf v/I$. It only works for model classes with a linear core like this one.

## 3. Detect scene changes with the innovation (✔)

$$\text{NIS}=\tfrac{r^\top r}{\sigma^2}-\tfrac{1}{\sigma^4}r^\top J\Big(P^{-1}+\tfrac{J^\top J}{\sigma^2}\Big)^{-1}J^\top r,\qquad z=\tfrac{\text{NIS}-m}{\sqrt{2m}}$$

Before a scene jump the maximum z was +2.5, and at the jump z was 2637. After the flagged frame I re-solved from the linear init, and the estimate re-locked with no further alarms. A threshold of z > 6 is generous, since the mean z before the jump was +0.96.

## 4. Subsampling and cost (✔ efficiency, ○ cost)

With m sampled pixels the error follows $\sqrt{\operatorname{diag}\big((J^\top J/\sigma^2)^{-1}\big)}$. Empirical-to-predicted ratios were 0.94 to 1.14 at m = 50 through 2,892, so subsampling loses nothing beyond the 1/√m rate. The cost model is arithmetic, not measured:

$$\text{cost/frame}\approx n_{\text{iter}}\cdot m\cdot(p+1)\cdot(\text{steps}\cdot c_f),\qquad \text{solve}=O(p^3)$$

Forward-mode derivatives cost about (p+1) forward renders per sampled pixel.

## 5. One-shot linear solves (✔)

SH lighting is linear in the 9 coefficients, so $y=\tfrac\rho\pi\hat A\circ Y(\mathbf n)\cdot L$ solves directly:
- **Observability:** only normals you've seen are constrained. A camera-facing hemisphere gives cond 24 against 4 for the full sphere, with extrapolation error about 5–6× worse.
- **Noise:** that error scales linearly with noise (×8.4 for ×10 noise).
- **Ridge priors:** ridge toward zero was terrible (error 0.22 against 0.004), because it shrinks the large DC term. Center any prior on a nominal environment.

## 6. Earlier verified pieces that carry over

- **Variable projection** for the linear coefficients (✔ at constant rank).
- **Hit-point and normal gradients** for geometry parameters (✔), plus the silhouette term (✔ in 2D only).
- **Band-limiting** so fits are consistent across resolutions (○).
- **Huber IRLS** and the bounded-parameter sigmoid (○).

## What this doesn't establish

- Real-time timing was not measured. The cost line is arithmetic.
- Geometry parameters weren't solved here, only light, so the silhouette difficulty from earlier hasn't been exercised in a JIT loop.
- The model matches the data generator exactly. Real scenes add shadows, interreflection, and specular error, which will dominate the noise-limited numbers above.
- I chose the z > 6 threshold and the 1.2 failure cutoff before running, but I haven't tuned them against real data.

## Remaining work

Geometry parameters in the JIT loop, a model-mismatch stress test (specular versus shadows), and the timing model to ensure the inverse rendering is clean across the oracle updates.
