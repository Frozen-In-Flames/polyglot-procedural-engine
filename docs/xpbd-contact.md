# XPBD contact (v2.0.5)

The contact path in `src/physics/collide.ts` since v2.0.5.
`stepSpheres` steps a set of spheres against an optional SDF field
and each other; `stepSphereSdf` is the single-body form and carries
the solver switch.

## Formulation

Per substep `h = dt / substeps` (Muller et al., "Detailed Rigid Body
Simulation with XPBD", 2020):

1. `v += h g`, save `x_prev`, predict `x += h v`.
2. Detect contacts at the predicted positions and record each
   contact's pre-solve gap separation rate `vnPre`. SDF contact:
   `C = f(x) - r >= 0`, normal from the field gradient. Pair
   contact: `C = |xb - xa| - (ra + rb) >= 0`, normal along the line
   of centers.
3. Gauss-Seidel iterations over the normal constraints with a
   per-contact Lagrange multiplier, reset to 0 each substep and
   accumulated across the iterations of that substep:
   `dlambda = (-C - alpha_tilde * lambda) / (w + alpha_tilde)`,
   `alpha_tilde = alpha / h^2`, `w = grad C^T M^-1 grad C`
   (1/m against the SDF, 1/ma + 1/mb for a pair; the angular term
   vanishes for spheres because the contact normal passes through
   the center). Corrections are clamped so lambda never goes
   negative (unilateral contact).
4. Velocity update `v = (x - x_prev) / h`. A resting body therefore
   derives a resting velocity; there is no sleeping threshold
   anywhere in this path, unlike the legacy impulse path, which
   needs one (see the collide.ts header).
5. Velocity pass per contact. Restitution drives the gap rate to
   `-e * vnPre`, suppressed when `|vnPre|` is under the rest
   threshold (`2 |g| h` by default) so resting contact does not
   micro-bounce. Contact damping (below) applies on substeps where
   the restitution branch did not fire. Friction applies the
   tangential contact-point impulse that would stop the contact
   point when it fits under `muS * (lambda / h)`, else
   `muK * (lambda / h)`; it acts at the contact point, so it
   couples to spin through `w = I^-1 (rc x p)` with the solid-sphere
   inertia `I = 2/5 m r^2`.

Compliance `alpha` (m/N) makes the contact a spring of stiffness
`1/alpha`. Options: `substeps` (default 20), `iterations`
(default 1; substeps do the convergence work), `alpha`, `muS`,
`muK`, `e`, `restThreshold`, `contactDamping`,
`accumulateLambda` (negative control), `solver`
(`'xpbd'` default, `'impulse'` legacy, single sphere vs SDF only).

## Contact damping (Kelvin-Voigt)

Pure XPBD treats a compliant contact as a nearly lossless spring:
the discrete map's per-substep decay factor for the spring mode is
`sqrt(beta / (1 + beta))` with `beta = alpha * m / h^2`, which is
0.9997 at alpha = 1e-3, m = 1, h = 1/1200. A body dropped on a soft
contact bounces on it for minutes of simulated time. That is the
published algorithm's real behavior, not a bug, but real pads
dissipate. `contactDamping` is the dissipation: per substep it
removes that fraction of the contact's gap rate in the velocity
pass, on substeps where restitution did not fire, so impacts keep
their spring energy and persistent contact settles. It does not
move the static deflection.

## Measured results (test/xpbd-contact.test.ts, 16 tests)

Static deflection, the compliance oracle: at rest on a plane the
penetration is `alpha * m * |g|` exactly. Measured relative error
5e-12 to 5e-9 across alpha in {1e-4, 1e-3} and m in {1, 4} with
contact damping settling the transient, and the analytic rest
state is an exact fixed point of the undamped solver (zero drift
over 3 s). Rigid rest (alpha = 0): over a 60 s horizon the sampled
position drift and residual speed after settle are exactly 0.
Compliant rest over 30 s: deviation 1e-13, speed 2e-13. Two-sphere
stack: rest heights match to 5e-6 at 2 iterations (1e-7 at 8).

Penetration, drop-and-settle battery (falls 0.25 / 1.5 / 4 m,
radii 0.25 / 0.5 / 1, masses 0.5 / 5, plus a spherical-container
cell): post-solve penetration is 0 on the plane, and the deepest
penetration the solver has to resolve stays under 1.6 times one
substep of impact motion in every cell. Head to head at the same
outer step on a 1.5 m fall, the legacy impulse path must resolve
2.87e-2 m of penetration; XPBD at 10 substeps resolves 6.33e-3 m,
a 4.5x reduction, because it reacts every dt/10 instead of dt.

Energy and momentum. An e = 1 bounce returns to the analytic apex
with error shrinking as substeps refine: 6.12e-2 at 1 substep,
5.2e-3 at 4, 2.3e-3 at 16, 8.4e-4 at 32, 2.2e-4 at 64 (roughly
linear in h; not monotone step to step, because the impact phase
lands differently inside a substep, and no monotonicity is
claimed). The apex error is flat across compliance: 8.4e-4 at
alpha = 0 and about 3.0e-3 at alpha in {1e-4, 1e-3, 3e-3}, so the
spring returns the impact energy instead of eating it. An e = 0
drop dissipates exactly the fall energy: final total energy equals
the rest potential to under 1e-9. Two-sphere collisions match the
analytic formulas to about 1e-13: equal masses at e = 1 exchange
velocities, unequal masses follow the textbook result with
momentum and kinetic energy conserved, e = 0 leaves the common
velocity. Friction: a sphere sliding at 3 m/s on mu = 0.35
transitions to rolling at v = (5/7) v0 = 2.142857 (measured error
2e-5) with contact slip 3e-5. Determinism: identical inputs give
bit-identical trajectories (deep equality over a 300-step mixed
scenario run twice).

Negative controls. Sign-flipped gravity: the body leaves the plane
ballistically (y = 20.128, vy = 19.62 after 2 s, against the
analytic 20.12 and 19.62) and the settle predicate reads false, so
the stability pins are not a clamp artifact. Lambda ablation:
with `accumulateLambda: false` the solve degenerates to classic
PBD projection and the settled deflection at 8 iterations is
0.00245 against the oracle 0.01962, an error of 1.7e-2, about 8x
too stiff, while the accumulated solve's error is 6e-14. The
multiplier term is measurably what makes compliance mean the same
thing at every iteration count.

## Legacy defect, documented and pinned

The impulse path's friction (applyContactImpulse) never reads or
writes angular velocity, and it sizes the tangential impulse with
the full mass instead of the contact-point effective mass
(m / 3.5 for a solid sphere), so a sliding sphere is stopped dead
in one impulse and never starts rolling. The behavior is pinned
verbatim in the test suite because the path stays available
behind `{ solver: 'impulse' }`; the XPBD path fixes it, as the
rolling measurement above shows.

## Honest limits

- Spheres only, and the SDF must be a true distance field (unit
  gradient) for the compliance units to be physical; a scaled
  field scales the effective stiffness.
- Angular velocity is treated as world-frame, which is exact for a
  sphere's isotropic inertia; this module tracks no orientation
  state, so spin affects friction but is not integrated into a
  quaternion here (rigid.ts owns orientation).
- A stacked pair keeps a bounded velocity limit cycle of about
  4e-3 m/s at low iteration counts from the alternating pair and
  plane solves. Positions are unaffected (1e-5 or better) and the
  cycle does not grow, but it does not vanish with more
  iterations either; it is pinned as a bound, not hidden.
- Restitution is computed from each substep's pre-solve gap rate,
  so very soft contacts (many substeps inside one impact) blend
  the spring response and the restitution target; the measured
  apex error across compliance (above) is the size of that blend.
