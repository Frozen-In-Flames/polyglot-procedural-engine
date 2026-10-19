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
per the oracle. Huber (convex) was already in the engine since v1.2.0; new are
Geman-McClure (redescending, w = (c^2/(c^2+u^2))^2, non-convex), GNC-annealed
GM (c: 50 -> 3), and huber-then-GM sequential.

Head-to-head on the JIT toy (Lambertian sphere, unknown az/el/I/A; 24
trials, near/far starts; failure = |d(az,el)| > 0.15 rad or |dI| > 0.3 or
|dA| > 0.1):

| condition / start | l2 fail% | huber | gm | gm-gnc | huber>gm |
|---|---|---|---|---|---|
| clean / near | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| clean / far | 8.3 | <= 8.3 | <= 8.3 | <= 8.3 | <= 8.3 |
| specular 0.6 / near | 4.2 | 0.0 | 0.0 | 0.0 | 0.0 |
| specular 0.6 / far | 16.7 | 4.2 | 4.2 | 12.5 | 4.2 |
| clutter 15% / near | 45.8 | 0.0 | 0.0 | 0.0 | 0.0 |
| clutter 15% / far | 50.0 | 4.2 | 4.2 | 8.3 | 4.2 |
| spec 1.0 + clutter 25% / near | 50.0 | 4.2 | 0.0 | 4.2 | 4.2 |
| spec 1.0 + clutter 25% / far | 54.2 | 12.5 | 4.2 | 12.5 | 12.5 |

Median |azimuth| error, hardest condition, far start: l2 0.0740, huber
0.0154, gm 0.0036. Direct GM is the clear winner. Honest negatives: GNC
annealing and huber-then-GM do NOT beat direct GM here (12.5% vs 4.2%
fail on the hardest far case); the extra machinery is kept for problems
with worse basins, not used by default.

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

## Limits

- The head-to-head is the Lambertian toy; the specular generator is
  Blinn-Phong while the third arm fits GGX, and neither models the
  saturation clip. Real scenes add shadows and interreflection that will
  dominate these numbers.
- 24 trials per cell (the owner runs 150 in his oracle); the TS port is a
  structural check with deterministic seeds.
- GM is non-convex: on clean/far starts every estimator, including l2,
  occasionally strands at the terminator kink (2/24 for l2). Robustness
  does not cost accuracy on clean data (no method worse than l2 there).
- The QR trigger threshold tau = 1e-3 is the owner's pre-chosen value,
  untuned on real data.
