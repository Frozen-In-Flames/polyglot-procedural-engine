# Robust estimation upgrades (v1.7.0)

Two owner-approved tracks, both validated against the owner's oracle scripts
(docs/oracles/conditional_qr_oracle.py, docs/oracles/robust_cost_head2head.py).

## Why this was added

The v1.5.0 mismatch stress showed unmodeled specular leaves a 0.017 rad
azimuth bias floor that does not shrink with pixels: a bias floor, not noise.
Two questions followed. First, when the model cannot explain some pixels,
should the solver mute them (robust costs) or explain them (richer model)?
Second, the least-squares core squares the condition number; is there a
cheap safeguard for the rare ill-conditioned frame? This release answers both
with measured head-to-heads instead of doctrine.

## 1. Robust costs: l2 vs Huber vs Geman-McClure

All estimators are IRLS Gauss-Newton with per-iteration scale re-estimation
(s = max(sigma, 1.4826 * MAD(r))) and backtracking on the robust cost, exactly
per the oracle. Huber (convex) was already in the engine since v1.2.0; new
are Geman-McClure (redescending, w = (c^2/(c^2+u^2))^2, non-convex).

### The robust scale spec (v1.9.2, explicit)

Every estimator here works in the normalized coordinate u = r / s with
s = max(sigma, 1.4826 * MAD(r)), sigma the caller-supplied noise scale
(IrlsOpts.sigmaFloor, re-estimated per iteration from the current
residuals). Huber and GM share the exact rule: Huber's 1.345 kink is in
normalized units, never raw data units, and GM's c is likewise normalized.
This answers the owner's v1.2.0 question about Huber's scale handling: it
is the same spec as GM's, visible in madScale() and in the IRLS loops.
The 1D Huber line fit (irlsSolve) uses it too and is scale-equivariant:
scaling data and sigma by the same factor scales the fit identically.

Head-to-head on the JIT toy (Lambertian sphere, unknown az/el/I/A; 24
trials, near/far starts; failure = |d(az,el)| > 0.15 rad or |dI| > 0.3 or
|dA| > 0.1):

| condition / start | l2 fail% | huber | gm |
|---|---|---|---|
| clean / near | 0.0 | 0.0 | 0.0 |
| clean / far | 8.3 | <= 8.3 | <= 8.3 |
| specular 0.6 / near | 4.2 | 0.0 | 0.0 |
| specular 0.6 / far | 16.7 | 4.2 | 4.2 |
| clutter 15% / near | 45.8 | 0.0 | 0.0 |
| clutter 15% / far | 50.0 | 4.2 | 4.2 |
| spec 1.0 + clutter 25% / near | 50.0 | 4.2 | 0.0 |
| spec 1.0 + clutter 25% / far | 54.2 | 12.5 | 4.2 |

Median |azimuth| error, hardest condition, far start: l2 0.0740, huber
0.0154, gm 0.0036. Direct GM is the clear winner.

v1.9.2 REMOVAL (not a refinement): the gm-gnc and huber>gm columns are
gone from the table and from the engine. The owner's write-up (150
trials/cell, near starts) falsified them: 40-43% fail on the hard case
vs 7% for warm-start direct GM, 47-61 iterations vs 7-20. fitGncGm and
fitHuberThenGm no longer exist; the fitLayerParams gnc option is gone
and an unknown robust kind throws instead of falling back. A falsified
path is removed, not compared.

GM scale sensitivity (hardest condition, far start, direct GM):
c=1.5: 0.0% fail, med|az| 0.0017; c=3.0: 0.0%, 0.0023; c=6.0: 8.3%,
0.0079; c=12.0: 33.3%, 0.0264. The default c=3.0 is safe; c=1.5 is
marginally better on this problem. The tuning constant matters: too large
a c and GM stops redescending in time.

## 2. Third arm: model the outlier (spec6)

Instead of muting the specular pixels, the toy forward model is extended
with a specular lobe built from the engine's validated GGX pieces
(theta = (az, el, I, A, ks, alpha);
y = rho*(A + I*max(n.l,0)) + ks*D(ndh,alpha)*V(nl,nv,alpha)*max(nl,0),
F0 absorbed into ks). The generator is a Blinn-Phong lobe, so this is
approximate modeling, not a matched fit.

| condition / start | l2 med|az| | spec6 med|az| | spec6 fail% |
|---|---|---|---|
| specular 0.6 / near | 0.0358 | 0.0121 | 0.0 |
| specular 0.6 / far | 0.0391 | 0.0123 | 8.3 |
| spec 1.0 + clutter 25% / near | 0.0735 | 0.0404 | 33.3 |
| spec 1.0 + clutter 25% / far | 0.0740 | 0.0404 | 29.2 |

Modeling beats naive l2 (bias floor roughly halved) but LOSES to direct GM
muting (0.0027-0.0036). The lobe is detected (median recovered ks 0.52 vs
generator amplitude 0.6; alpha 0.28; 6-param kappa(JtJ) 2.4e2,
well-conditioned), so identifiability is not the problem. The gap is the
unmodeled saturation clip at 1.0: approximate modeling plus an unmodeled
clip loses to aggressive muting. Lesson: explain beats mute only when the
explanation is complete; future work is modeling the clip.

## 3. Conditional QR safeguard

Trigger: fire the QR branch iff eps * kappa(J^T J) > 1e-3, kappa from the
p x p information matrix (cheap). Measured (float64):

- Silent on the 4-param light fit and SH-9 hemisphere.
- Silent on SH-9 caps at 30deg (kappa(JtJ) ~7e6) and 15deg (~2e9).
- FIRES on the 5deg cap (kappa(JtJ) ~1.3e13, stable across seeds, 3x
  above the trigger boundary). The oracle's seed-1 draw sat just below the
  boundary; the boundary is where a safeguard should honestly fire.
- Synthetic sweep kappa(J) = 1e1..1e12: QR error <= NE error everywhere;
  the trigger never misses a case with NE error > 1e-2 and never fires
  where NE error is already < 1e-5.
- float32 emulation (Math.fround): on hemisphere NE and QR tie at 6.6e-9;
  on the 5deg cap QR (1.5e1) beats NE (2.1e1) with rounded inputs.
- Deeper finding: at realistic noise (0.01) the narrow-cap SH problems are
  statistically unidentifiable (relative statistical error ~5e2 on the 5deg
  cap), so solver precision is moot there; the real remedy is the centered
  ridge prior (section 4), not the factorization. The QR branch is
  confirmed not dead code and confirmed rarely needed: exactly the
  tail-end safeguard it was designed to be.

Ridge check (oracle section 5, cap 15deg, 24 trials): centered prior beats
zero-centered prior (median relative error printed in the test log); the
zero-centered prior biases, the centered one does not.

### v1.9.2: the fired branch solves the stacked ridge system

When the trigger fires, the solver now QR-factorizes the stacked system
[J; sqrt(lambda) I] against [y - J c; 0] and shifts back by the center c
(solveQRStacked), instead of QR on J alone. This is the numerically safe
way to apply the centered ridge prior on exactly the frames where
conditioning is bad; normal equations would square the condition number
of an already ill-conditioned J. Default lambda = 0 reduces to the plain
QR answer (all existing trigger behavior and tests unchanged); a caller
with a prior passes lambda and center.

Measured through the production path (cap 15deg, noise 0.01, lambda =
1e-4 ||J||_2^2, prior = truth with 30% error, 24 trials): plain QR median
relative error 5.24, centered stacked QR 0.20 (26x better; the oracle's
normal-equation numbers were 6.8 plain vs 0.10 centered). Stacked QR is
bit-compatible with the explicit ridge normal equations
(rel err < 1e-9) and with lambda = 0 equals plain QR (rel err < 1e-12).

## 4. v1.8.1 follow-up: GM tightness, hardest-condition near starts, NIS under outliers

Ground truth: docs/oracles/test_robust_followup.py (the owner's follow-up;
it imports the head of robust_cost_head2head.py).

### GM statistical efficiency vs tightness c (clean noise, near starts)

RMS error ratio vs l2 per (az, el, I, A), 100 trials:

| c | az | el | I | A |
|---|---|---|---|---|
| 1.0 | 1.46 | 1.68 | 1.35 | 1.61 |
| 1.5 | 1.17 | 1.34 | 1.11 | 1.27 |
| 3.0 | 0.99 | 1.06 | 0.99 | 1.05 |
| 6.0 | 0.99 | 1.00 | 0.99 | 1.01 |

Tight GM redescends on clean-data residuals too (|u| > 1 is about 32% of
Gaussian draws), so c=1.0 costs 35-68% efficiency. The default c=3.0 costs
nothing measurable; c=6.0 sits at l2 efficiency. This corrects the v1.7.0
note that "robustness does not cost accuracy on clean data": it does not
at the default, but it does if c is too tight.

### Hardest condition, near starts, GM by c (Huber reference)

specular 1.0 + clutter 25%, 48 trials:

| method | fail% | median|az| | median|I| |
|---|---|---|---|
| huber | 16.7 | 0.0139 | 0.0231 |
| gm c=1.0 | 0.0 | 0.0017 | 0.0084 |
| gm c=1.5 | 0.0 | 0.0022 | 0.0106 |
| gm c=3.0 | 0.0 | 0.0044 | 0.0181 |

Direct GM dominates Huber here (0.0% vs 16.7% fail), and on dirty data
tighter redescending wins: median errors shrink as c tightens. Together
with the efficiency table this is the complete c story: tight c wins on
dirty data and costs on clean data; c=3.0 is the balanced default.

### NIS change detector under outliers (perfect prediction)

Median z over 50 trials at theta_pred = truth (no real scene change),
alarm threshold z > 6:

| condition | plain z | trimmed (|u|<3) z |
|---|---|---|
| clean | 0.2 | -0.78 |
| specular 0.6 | 1995.0 | 7.78 |
| clutter 15% | 5950.6 | 1.57 |
| spec 1.0 + clutter 25% | 11577.6 | 32.99 |

Trimming (|r| < 3s, s = max(sigma, 1.4826*MAD)) cuts the false-alarm z by
250-350x and fully holds the band on clutter, but the smooth flanks of the
specular lobe (|r| just under 3s) pass the trim and leave systematic bias,
so trimmed z stays above the band on specular (7.78) and spec+clutter
(32.99). Trimming is now the default in the JIT change-detector path
(nisChange/nisStatistic in src/inverse/jit.ts, trimK = 3; pass 0 for the
legacy plain computation): it strictly dominates plain on false alarms,
and the v1.5.0 true-jump detection still passes with it. Honest
limitation: trimming does not fully solve smooth outlier structures;
future work is a tighter trim schedule or modeling the specular lobe
including the saturation clip.

## Limits

- The head-to-head is the Lambertian toy; the specular generator is
  Blinn-Phong while the third arm fits GGX, and neither models the
  saturation clip. Real scenes add shadows and interreflection that will
  dominate these numbers.
- 24 trials per cell (the owner runs 150 in his oracle); the TS port is a
  structural check with deterministic seeds. The v1.8.1 follow-up uses
  100/48/50 trials for checks (a)/(b)/(c).
- GM is non-convex: on clean/far starts every estimator, including l2,
  occasionally strands at the terminator kink (2/24 for l2).
- Tight GM (c=1.0) costs 35-68% statistical efficiency on clean data
  (v1.8.1 check (a)); the default c=3.0 does not. Robustness is not free
  if c is too tight.
- Trimmed NIS still false-alarms (marginally) on smooth specular
  outliers: median z 7.78 on specular 0.6, 32.99 on spec+clutter, vs the
  z > 6 alarm threshold (v1.8.1 check (c)).
- The QR trigger threshold tau = 1e-3 is the owner's pre-chosen value,
  untuned on real data.
