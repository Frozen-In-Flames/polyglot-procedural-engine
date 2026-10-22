# Change detection (v1.9.1, basin re-mapped v2.0.4)

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
Run GM IRLS from the warm start (`irlsGnFit`, 40 iters default) to
get `thetaSol`. `dtheta = thetaSol - thetaPred`.
`V = H^{-1} M H^{-1}` sandwich with `H = sum w_j J_j J_j^T`,
`M = sum psi(u_j)^2 J_j J_j^T`, both at the solution with GM weights
(`w`, `psi` as in form 1). `T = dtheta^T V^{-1} dtheta`, `dof = p`.
The sandwich, not the naive `H^{-1}`, keeps calibration honest under
contamination. Nearly free: the JIT loop runs the robust fit every frame
anyway. Implementation note: `M` must use `psi^2`, not `psi` (a missing
square makes `M` indefinite and Cholesky fails; caught by the test suite).
Tuning (v2.0.4): the Wald form's GM constant is `WALD_GM_C = 1.2` for
both its fit and its sandwich, tightened from the v1.9.1 value of 3.0
by the basin re-map below; the score forms keep c = 3.0, and an
explicit `opts.c` still overrides every form uniformly.

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

## Basin re-map (v2.0.4, test/wald-basin.test.ts)

The v1.9.1 limits named the debt: wald inherits the estimator's basin,
so map it again on harder scenes. The re-map extends the generator
along the factors that killed the earlier methods: specular strength
1.5 (bake-off maximum 1.0) with a sharper lobe (exponent 120 vs 40),
clutter density to 40% (bake-off maximum 25%), and clutter asymmetry
as a controlled factor (one-sided offsets +U[0.3, 0.9] or the negative,
at fixed density and magnitude distribution, instead of the legacy
value replacement). Eight regimes, azimuth jumps 0.05 to 0.8 rad
(1.2 and 1.6 in three regimes), 100 no-change trials per regime for
false alarms, 40 trials per power cell, all seeded. Operating point
unchanged: the chi2 99% threshold, nominal false-alarm rate 1%
(binomial tolerance at n = 100: at most 5 alarms).

**The hole (pre-fix configuration, GM c = 3.0).** Every regime held
nominal false alarms except the combined worst case (specular 1.5 +
40% one-sided bright clutter): 31/60 = 52% false alarms, pinned in
the test suite so the hole stays reproducible. Neither factor breaks
it alone (specular 1.5 alone: 0/30; 40% one-sided clutter alone:
1/30). Diagnosis: in the failing trials the GM fit leaves the warm
start entirely (dAz up to 0.73 rad, dI up to 1.1) and settles in a
second basin that fits the dirt plateau; the sandwich at that
solution is tight, so T reaches 10^3. It is the estimator's basin
flipping under combined contamination, exactly the failure mode this
section's predecessor predicted. More IRLS iterations do not help
(the far solution is a genuine attractor); removing the [0, 1] clamp
helps only partly (9/30).

**The fix.** The Wald form's GM constant goes from 3.0 to 1.2
(`WALD_GM_C`, fit and sandwich; score forms unchanged). At c = 3.0
the dirt pixels keep enough weight in the first IRLS steps to pull
the fit across the basin boundary; at c = 1.2 their weight is
suppressed about thirteenfold at u = 3, the fit stays home under the null,
and the coherent signal still pulls it out under a real jump. This
was not a one-axis trade: small-jump power also rose (clean 0.2 rad:
50% at c = 3.0, 100% at c = 1.2), because the looser constant was
diluting the signal's own moderate residuals too. The tightened
constant was validated on held-out seeds before being pinned
(worst regime, disjoint seed family: 2/100 false alarms).

**The map after the fix.** False alarms per 100 no-change trials:
0 in seven regimes, 3 in spec+asym-worst (bound 5). Detection % by
jump (rad):

| regime           | 0.05 | 0.10 | 0.15 | 0.20 | 0.30 | 0.50 | 0.80 | 1.20 | 1.60 |
|------------------|------|------|------|------|------|------|------|------|------|
| clean            | 0    | 18   | 78   | 100  | 100  | 100  | 100  | 100  | 100  |
| spec-1.0         | 0    | 20   | 75   | 100  | 100  | 100  | 100  |      |      |
| spec-sharp-1.5   | 0    | 5    | 73   | 100  | 100  | 100  | 100  |      |      |
| clutter-40-sym   | 0    | 20   | 68   | 95   | 100  | 100  | 100  |      |      |
| clutter-25-asym  | 0    | 33   | 78   | 95   | 100  | 100  | 100  |      |      |
| clutter-40-asym  | 0    | 43   | 85   | 100  | 100  | 100  | 100  | 100  | 100  |
| clutter-25-dark  | 0    | 20   | 68   | 98   | 100  | 100  | 100  |      |      |
| spec+asym-worst  | 5    | 70   | 100  | 100  | 100  | 100  | 100  | 100  | 100  |

The basin boundary (first jump with at least 90% detection) is
0.2 rad in every regime, one grid step inside the v1.9.1 figure of
0.3 rad, and power never falls as the jump grows to 1.6 rad: no
warm-start trapping anywhere on the map. Two readings worth noting.
First, dirt regimes detect small jumps better than clean (70% at
0.1 rad in spec+asym-worst): the unmodeled specular lobe moves with
the light, adding change energy on top of the Lambertian change.
That is sensitivity, not miscalibration, as long as the matched
false-alarm cell holds, and it does. Second, the elevated
small-jump power is regime-specific, so the blind-floor claim
(detector blind below ~0.15 rad) is now stated for the clean
regime only.

**Negative controls (all pinned).** Naive covariance
(`opts.covariance = 'naive'`, V = H^{-1}; the option exists only as
this control): on all three asymmetric-clutter regimes its power at
0.3 rad collapses to 25% against the sandwich's 100%, at unchanged
false alarms. That asymmetry-only collapse is the sandwich's reason
to exist, now measured on the harder map instead of asserted.
Sign-flipped jumps: -0.3 rad is detected at 100% wherever +0.3 rad
is, confirming the design's magnitude-based (quadratic) reading.
Residual shuffle: see the limits below.

## Honest limits

- Toy problem: Lambertian sphere, 4 light parameters, flat-patch clutter,
  Blinn-Phong specular lobe. Numbers will shift on real scenes.
- Wald inherits the estimator's basin. The v2.0.4 re-map (above)
  found where that bites: not trapping on huge jumps (power holds to
  1.6 rad), but roaming under the null when strong specular and
  heavy one-sided clutter combine, at the v1.9.1 tuning. Tightening
  the Wald GM constant to 1.2 closed the measured hole; combined
  contamination beyond the mapped regimes (past 40% clutter, past
  1.5 specular) is still unmapped territory, and the basin claim
  extends exactly as far as the map, no further.
- The residual-shuffle control does not behave as a null for any of
  the three forms on this scene family (pinned as a measured
  exception in test/wald-basin.test.ts). Permuting the residuals
  preserves their marginal distribution, and the Jacobian columns
  have nonzero spatial means (the ambient column is constant), so
  marginal skew alone projects coherently onto the parameter
  directions: shuffled changed scenes still alarm (23-37 of 40 at
  0.3 rad) while shuffled null scenes stay at the false-alarm rate
  (0 of 40). The detector's coherence claim therefore rests on the
  matched no-change cells at every grid point, the naive-covariance
  collapse, and the sign-flip symmetry, not on the shuffle. A
  detector that must also survive spatially scrambled input needs a
  statistic built for misspecification, which this one is not.
- WALD_GM_C = 1.2 was selected on this scene family and validated
  on held-out seeds within it. It is a measured constant, not a
  universal one; a different scene family re-opens the question.
- The 99% threshold assumes the chi2 calibration; verified empirically at
  40 trials/condition (expect ~0-1 alarms by chance; observed 0 for wald).
- Score forms are kept behind the selector for the owner's oracle
  comparisons, not for production use.

## Wiring a Python oracle against this API

Sign conventions (match `src/inverse/jit.ts`): residual `r = y - R`,
Jacobian `J` is m x p row-major, `u = r / s` with
`s = max(sigmaFloor, 1.4826 * median(|r - median(r)|))`.
GM: `w(u) = (c^2/(c^2+u^2))^2`, `psi(u) = w(u)*u`, c = 3.0 for the
score forms; the Wald form uses c = 1.2 (`WALD_GM_C`) since v2.0.4
for both its fit and its sandwich, unless `opts.c` overrides all
forms uniformly.
Huber: `psi(u) = min(max(u, -k), k)`, k = 1.345.
Score: `g = J^T psi`, `M = J^T diag(psi^2) J`, `T = g^T M^{-1} g`.
Wald: GM IRLS from the warm start (see `irlsGnFit`: per-iteration MAD
scale, backtracking on the robust cost, damping `1e-9*trace(A)*I+1e-12*I`),
then `dtheta`, `H = J^T W J`, `M = J^T diag(psi^2) J` at the solution,
`V = H^{-1} M H^{-1}`, `T = dtheta^T V^{-1} dtheta`.
Compare `T`, `alarm`, and the false-alarm/power rates, not internal
matrix entries (Cholesky vs QR factorizations differ harmlessly).
