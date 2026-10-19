# Change detection (v1.9.1)

Outlier-aware change detection for the JIT loop. Replaces the trimmed-NIS
default from v1.8.1 as the detection step (trimmed NIS is kept in `jit.ts`
as `nisChange` for back-compat; it false-alarms 100% on spec+clutter at
perfect prediction while the new default holds 0%).

## Problem

At perfect prediction (no scene change), outliers inflate the NIS
statistic: plain z runs ~1900-5200; trimmed (|u|<3) fixes clutter but leaks
specular (z=7.2 alone, 29.6 on spec+clutter). A false alarm forces a cold
start where 30-55% of fits fail. Root cause: the detector and the estimator
disagreed about what data is trustworthy. All three forms below use the
estimator's own robust weights.

## The three forms

Module: `src/inverse/changedetect.ts`. All take
`(y, thetaPred, R, J, sigma2, opts?)` with `R: (th) => Vec`,
`J: (th) => Mat` (m x p), and return `DetectResult`
`{ T, dof, threshold99, alarm, form }`.

**Residual scale (all forms):** `s = max(sigmaFloor, 1.4826 * MAD(r))`,
`r = y - R(thetaPred)`, `sigmaFloor` defaults to `sqrt(sigma2)`.
Normalized residuals `u = r / s`.

**Form 1, `score-gm`:** score test at the prediction.
`g = sum_j psi(u_j) J_j`, `psi(u) = w(u)*u` with GM redescending
`w(u) = (c^2/(c^2+u^2))^2` (c=3.0 default).
`T = g^T M^{-1} g`, `M = sum_j psi(u_j)^2 J_j J_j^T` (empirical score
covariance, sandwich). `dof = p`, alarm when `T > chi2isf99(p)`.

**Form 2, `score-huber`:** same statistic, monotone Huber
`psi(u) = clamp(u, -k, k)` (k=1.345 default) for DETECTION ONLY;
estimation stays redescending GM. Rationale: the mechanism is coherence,
not magnitude. `g` sums parameter-space pulls; a true jump pulls
coherently and adds, clutter pulls incoherently and cancels. Monotone psi
cannot vanish, so the coherent pull survives big jumps where redescending
weights go blind. Measured caveat: monotone psi still false-alarms on
asymmetric clutter (72.5% at 15%), because 15% one-sided contamination is a
real bias no monotone method can reject.

**Form 3, `wald` (default):** Wald test at the robust solution.
Run GM IRLS from the warm start (`irlsGnFit`, c=3.0, 40 iters default) to
get `thetaSol`. `dtheta = thetaSol - thetaPred`.
`V = H^{-1} M H^{-1}` sandwich with `H = sum w_j J_j J_j^T`,
`M = sum psi(u_j)^2 J_j J_j^T`, both at the solution with GM weights
(`w`, `psi` as in form 1). `T = dtheta^T V^{-1} dtheta`, `dof = p`.
The sandwich, not the naive `H^{-1}`, keeps calibration honest under
contamination. Nearly free: the JIT loop runs the robust fit every frame
anyway. Implementation note: `M` must use `psi^2`, not `psi` (a missing
square makes `M` indefinite and Cholesky fails; caught by the test suite).

**Selector:** `detectChange(y, thetaPred, R, J, sigma2, opts?)` with
`opts.form` in `'score-gm' | 'score-huber' | 'wald'`; default
`DEFAULT_FORM = 'wald'`.

**Threshold:** `chi2isf99(dof)` = 99% quantile of chi2(dof); exact table for
dof 1..10 (chi2(4) = 13.277), Wilson-Hilferty beyond. Nominal false-alarm
rate 1%.

## Measured results (test/change-detect.test.ts, 40 trials/condition)

False-alarm % at the 99% threshold, perfect prediction:

| condition            | score-gm | score-huber | wald |
|----------------------|----------|-------------|------|
| clean                | 0.0      | 0.0         | 0.0  |
| clutter 15%          | 0.0      | 72.5        | 0.0  |
| specular 0.6         | 100.0    | 100.0       | 0.0  |
| spec 1.0 + clutter 25% | 100.0  | 92.5        | 0.0  |

Power % on true azimuth jumps:

| jump | clean (gm/huber/wald) | clutter 15% | specular 0.6 |
|------|----------------------|-------------|--------------|
| 0.1  | 100 / 100 / 0        | 100 / 100 / 0 | 100 / 100 / 0 |
| 0.3  | 100 / 100 / 100      | 100 / 100 / 100 | 100 / 100 / 100 |
| 0.8  | 100 / 100 / 100      | 100 / 100 / 100 | 100 / 100 / 100 |

Warm-start breakdown sweep, clean data (power %; breakdown = first jump
with power < 50%):

| jump | score-gm | score-huber | wald |
|------|----------|-------------|------|
| 0.2  | 100      | 100         | 70   |
| 0.5  | 100      | 100         | 100  |
| 1.0  | 100      | 100         | 100  |
| 1.5  | 100      | 100         | 100  |
| 2.0  | 100      | 100         | 93   |

Breakdown point: none in range for any form (warm starts survive to
2.0 rad on this toy; the power boundary was not reached).

End-to-end acceptance: false alarm -> forced cold start -> track loss on
spec+clutter, 40 trials: wald track-loss 0.0% (0/40); legacy trimmed-NIS
false-alarms 100% on the same frames.

## Why wald won

It is the only form with nominal false alarms under every dirt condition.
The reason is structural: it tests the parameter shift at the robust
solution, where the GM fit has already rejected the dirt, instead of
testing residuals at the prediction, where smooth outlier structures
(specular flanks) create coherent pulls that mimic a jump. The score forms
see the flanks as signal; wald sees that the fit did not move. Its power
curve (blind below ~0.15 rad, 100% at 0.3+) matches the actual need: small
jumps are handled by warm-start tracking, detection exists for jumps that
would break it.

## Honest limits

- Toy problem: Lambertian sphere, 4 light parameters, flat-patch clutter,
  Blinn-Phong specular lobe. Numbers will shift on real scenes.
- Wald inherits the estimator's basin: if a warm-started fit traps in the
  old scene on a huge jump, wald sees no shift. Not observed to 2.0 rad
  here; map it again on harder scenes.
- The 99% threshold assumes the chi2 calibration; verified empirically at
  40 trials/condition (expect ~0-1 alarms by chance; observed 0 for wald).
- Score forms are kept behind the selector for the owner's oracle
  comparisons, not for production use.

## Wiring a Python oracle against this API

Sign conventions (match `src/inverse/jit.ts`): residual `r = y - R`,
Jacobian `J` is m x p row-major, `u = r / s` with
`s = max(sigmaFloor, 1.4826 * median(|r - median(r)|))`.
GM: `w(u) = (c^2/(c^2+u^2))^2`, `psi(u) = w(u)*u`, c = 3.0.
Huber: `psi(u) = min(max(u, -k), k)`, k = 1.345.
Score: `g = J^T psi`, `M = J^T diag(psi^2) J`, `T = g^T M^{-1} g`.
Wald: GM IRLS from the warm start (see `irlsGnFit`: per-iteration MAD
scale, backtracking on the robust cost, damping `1e-9*trace(A)*I+1e-12*I`),
then `dtheta`, `H = J^T W J`, `M = J^T diag(psi^2) J` at the solution,
`V = H^{-1} M H^{-1}`, `T = dtheta^T V^{-1} dtheta`.
Compare `T`, `alarm`, and the false-alarm/power rates, not internal
matrix entries (Cholesky vs QR factorizations differ harmlessly).
