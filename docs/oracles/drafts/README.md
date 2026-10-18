# Draft oracles — UNVALIDATED

These are **independent draft** oracle scripts written for cross-checking
against the owner's validated oracles, which arrive tomorrow. They are:

- `sh_irradiance_draft.py` — spherical-harmonic irradiance identities
  (basis orthonormality, white environment gives E = pi, band-limited
  reconstruction, directional-light addition-theorem identity, deliberate
  sign-error variant).
- `errorstate_filter_draft.py` — error-state attitude filter checks
  (gyro-bias convergence under known rotation, yaw unobservability with
  gravity-only updates, multi-axis excitation improving bias estimates,
  deliberate sign-error variant).

Rules:

1. These are **DRAFTS, written from memory, NOT run against an independent
   reference**. Do not treat them as normative spec.
2. When the owner's oracles arrive, diff behavior: where they disagree,
   the owner's validated version wins unless a bug is found in it.
3. Do not port these drafts into the engine test suite as-is. Port only
   after reconciliation with the owner's versions.
4. The `report()` PASS/FAIL lines are self-checks, not engine tests.
