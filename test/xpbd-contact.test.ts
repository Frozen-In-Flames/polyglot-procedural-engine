// XPBD contact solver (v2.0.5): measured oracles for stepSpheres /
// stepSphereSdf in src/physics/collide.ts.
//
// Oracles are analytic wherever the physics allows one: the static
// deflection of a compliant contact is alpha * m * |g| exactly, a
// sliding sphere transitions to rolling at v = (5/7) v0, two-sphere
// collisions follow the elastic formulas, and an e = 1 bounce apex
// converges to the drop height as substeps refine. Negative controls
// are first-class: sign-flipped gravity must not settle, and the
// multiplier-free ablation (accumulateLambda: false, classic PBD)
// must miss the deflection oracle by a wide margin, which is what
// proves the XPBD lambda term does the compliance work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stepSphereSdf, stepSpheres, applyContactImpulse, xpbdContact,
  type SphereState,
} from '../src/physics/collide.js';
import type { Vec3 } from '../src/math/vec.js';

const planeF = (p: Vec3) => p[1];
const planeG = (_p: Vec3): Vec3 => [0, 1, 0];
const G: Vec3 = [0, -9.81, 0];
const DT = 1 / 60;

function mk(c: Vec3, v: Vec3, m: number, r: number): SphereState {
  return { c: [...c] as Vec3, v: [...v] as Vec3, w: [0, 0, 0], m, r };
}
const speed = (s: SphereState) => Math.hypot(s.v[0], s.v[1], s.v[2]);

test('xpbd: static deflection matches the alpha*m*g oracle', () => {
  // A compliant contact is a spring of stiffness 1/alpha; at rest
  // it deflects by alpha * m * |g|. Measured relative error is at
  // the 1e-9 level or below; the pin allows 1e-6.
  for (const alpha of [1e-4, 1e-3]) {
    for (const m of [1, 4]) {
      const r = 0.5;
      const s = mk([0, r + 0.3, 0], [0, 0, 0], m, r);
      for (let i = 0; i < 60 * 4; i++) {
        stepSphereSdf(s, planeF, planeG, G, DT, {
          alpha, substeps: 20, e: 0, contactDamping: 0.05,
        });
      }
      const pen = r - s.c[1];
      const oracle = alpha * m * 9.81;
      assert.ok(
        Math.abs(pen - oracle) / oracle < 1e-6,
        `alpha=${alpha} m=${m}: pen ${pen} vs oracle ${oracle}`,
      );
      assert.ok(speed(s) < 1e-6, `settled speed ${speed(s)}`);
    }
  }
  // Rigid limit: alpha = 0 rests on the surface itself.
  const s = mk([0, 0.8, 0], [0, 0, 0], 1, 0.5);
  for (let i = 0; i < 120; i++) {
    stepSphereSdf(s, planeF, planeG, G, DT, { alpha: 0, substeps: 20, e: 0 });
  }
  assert.ok(Math.abs(s.c[1] - 0.5) < 1e-12, `rigid rest y=${s.c[1]}`);
});

test('xpbd: the analytic rest state is an exact fixed point (no damping)', () => {
  // Placed at the oracle deflection with zero velocity and no
  // contact damping, the body must not move: the XPBD fixed point
  // is the physics, not a numerical coincidence.
  const alpha = 1e-3, m = 1, r = 0.5;
  const s = mk([0, r - alpha * m * 9.81, 0], [0, 0, 0], m, r);
  for (let i = 0; i < 60 * 3; i++) {
    stepSphereSdf(s, planeF, planeG, G, DT, { alpha, substeps: 20, e: 0 });
  }
  assert.ok(Math.abs(s.c[1] - (r - alpha * m * 9.81)) < 1e-9);
  assert.ok(speed(s) < 1e-9);
});

test('xpbd: resting contact is stable over a 60 s horizon, no sleep threshold', () => {
  // The legacy path needs a sleeping threshold to stop jitter (see
  // the collide.ts header). The XPBD path derives velocity from
  // solved positions, so a resting body derives zero velocity.
  // Measured drift and speed over the last 55 s are exactly 0 for
  // the rigid case; pins allow 1e-12.
  const r = 0.5;
  const s = mk([0, r + 1.0, 0], [0, 0, 0], 2, r);
  let maxDev = 0, maxV = 0;
  for (let i = 0; i < 60 * 60; i++) {
    stepSphereSdf(s, planeF, planeG, G, DT, { alpha: 0, substeps: 20, e: 0 });
    if (i >= 60 * 5) {
      maxDev = Math.max(maxDev, Math.abs(s.c[1] - r));
      maxV = Math.max(maxV, speed(s));
    }
  }
  assert.ok(maxDev < 1e-12, `position drift ${maxDev}`);
  assert.ok(maxV < 1e-12, `residual speed ${maxV}`);
});

test('xpbd: compliant rest is stable over 30 s with contact damping', () => {
  const r = 0.5, m = 2, alpha = 1e-3;
  const s = mk([0, r + 1.0, 0], [0, 0, 0], m, r);
  const yRest = r - alpha * m * 9.81;
  let maxDev = 0, maxV = 0;
  for (let i = 0; i < 60 * 30; i++) {
    stepSphereSdf(s, planeF, planeG, G, DT, {
      alpha, substeps: 20, e: 0, contactDamping: 0.05,
    });
    if (i >= 60 * 5) {
      maxDev = Math.max(maxDev, Math.abs(s.c[1] - yRest));
      maxV = Math.max(maxV, speed(s));
    }
  }
  // Measured: deviation 1e-13, speed 2e-13. Pins allow 1e-9.
  assert.ok(maxDev < 1e-9, `position deviation ${maxDev}`);
  assert.ok(maxV < 1e-9, `residual speed ${maxV}`);
});

test('xpbd: two-sphere stack rests at the analytic heights', () => {
  const a = mk([0, 0.5, 0], [0, 0, 0], 1, 0.5);
  const b = mk([0, 1.7, 0], [0, 0, 0], 1, 0.5);
  for (let i = 0; i < 60 * 10; i++) {
    stepSpheres([a, b], planeF, planeG, G, DT, {
      substeps: 20, iterations: 2, e: 0, contactDamping: 0.05,
    });
  }
  // Measured position error 5e-6 at 2 iterations (1e-7 at 8): the
  // pin is 1e-5. The top sphere keeps a bounded velocity limit
  // cycle of about 4e-3 from the alternating pair/plane solve;
  // pinned as a bound, documented as a limit in docs/xpbd-contact.md.
  assert.ok(Math.abs(a.c[1] - 0.5) < 1e-5, `a.y=${a.c[1]}`);
  assert.ok(Math.abs(b.c[1] - 1.5) < 1e-5, `b.y=${b.c[1]}`);
  assert.ok(speed(a) < 1e-2 && speed(b) < 1e-2,
    `speeds ${speed(a)}, ${speed(b)}`);
});

test('xpbd: drop-and-settle battery keeps penetration bounded by one substep of motion', () => {
  // The penetration a solver must resolve in one substep is bounded
  // by the impact speed times the substep, plus one substep of
  // gravitational gain. Post-solve penetration is zero on a plane.
  for (const fall of [0.25, 1.5, 4]) {
    for (const r of [0.25, 0.5, 1]) {
      for (const m of [0.5, 5]) {
        const s = mk([0, r + fall, 0], [0, 0, 0], m, r);
        const vImpact = Math.sqrt(2 * 9.81 * fall);
        const hSub = DT / 10;
        let maxPen = 0, maxPost = 0;
        for (let i = 0; i < 180; i++) {
          const st = stepSphereSdf(s, planeF, planeG, G, DT, {
            substeps: 10, e: 0,
          });
          maxPen = Math.max(maxPen, st.maxPenetration);
          maxPost = Math.max(maxPost, st.maxPostPenetration);
        }
        assert.ok(maxPost < 1e-9,
          `fall=${fall} r=${r} m=${m}: post penetration ${maxPost}`);
        assert.ok(maxPen < 1.6 * vImpact * hSub,
          `fall=${fall} r=${r} m=${m}: penetration ${maxPen} vs bound ${1.6 * vImpact * hSub}`);
        assert.ok(Math.abs(s.c[1] - r) < 1e-9,
          `fall=${fall} r=${r} m=${m}: rest y=${s.c[1]}`);
      }
    }
  }
  // Curved field: a sphere resting inside a spherical container.
  const bowlF = (p: Vec3) => 30 - Math.hypot(p[0], p[1], p[2]);
  const bowlG = (p: Vec3): Vec3 => {
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    return [-p[0] / l, -p[1] / l, -p[2] / l];
  };
  const s = mk([0, -20, 0], [0, 0, 0], 1, 0.5);
  let maxPen = 0;
  for (let i = 0; i < 360; i++) {
    maxPen = Math.max(maxPen,
      stepSphereSdf(s, bowlF, bowlG, G, DT, { substeps: 10, e: 0 })
        .maxPenetration);
  }
  assert.ok(Math.abs(s.c[1] + 29.5) < 1e-9, `bowl rest y=${s.c[1]}`);
  assert.ok(maxPen < 0.036, `bowl penetration ${maxPen}`);
});

test('xpbd: substeps cut the penetration the solver must resolve (vs the impulse path)', () => {
  // Same drop, same outer step: the legacy impulse path integrates
  // the full dt before it can react; XPBD at 10 substeps reacts
  // every dt/10. Measured ratio 4.5x; the pin is 3x.
  const r = 0.5;
  const si = mk([0, r + 1.5, 0], [0, 0, 0], 1, r);
  let maxI = 0;
  for (let i = 0; i < 120; i++) {
    maxI = Math.max(maxI, stepSphereSdf(si, planeF, planeG, G, DT, {
      solver: 'impulse', e: 0,
    }).maxPenetration);
  }
  const sx = mk([0, r + 1.5, 0], [0, 0, 0], 1, r);
  let maxX = 0;
  for (let i = 0; i < 120; i++) {
    maxX = Math.max(maxX, stepSphereSdf(sx, planeF, planeG, G, DT, {
      substeps: 10, e: 0,
    }).maxPenetration);
  }
  assert.ok(maxI > 3 * maxX, `impulse ${maxI} vs xpbd ${maxX}`);
  assert.ok(Math.abs(si.c[1] - r) < 1e-9, 'impulse path still rests');
});

function bounceApex(substeps: number, alpha: number): number {
  const r = 0.5, fall = 1.5;
  const s = mk([0, r + fall, 0], [0, 0, 0], 1, r);
  let bounced = false, apex = 0;
  for (let i = 0; i < 180; i++) {
    const st = stepSphereSdf(s, planeF, planeG, G, DT, { substeps, alpha, e: 1 });
    if (st.contacts > 0) bounced = true;
    if (bounced) apex = Math.max(apex, s.c[1]);
  }
  return apex;
}

test('xpbd: e = 1 bounce apex converges to the analytic height as substeps increase', () => {
  // Analytic apex: e = 1 returns the full fall, apex = r + fall = 2.
  // Measured errors: 6.1e-2 at 1 substep, 8.4e-4 at 32, 2.2e-4 at
  // 64 (roughly linear in h, with impact-phase wiggles; no
  // monotonicity is claimed or pinned).
  const err = (n: number) => Math.abs(bounceApex(n, 0) - 2.0);
  assert.ok(err(32) < 2e-3, `err(32)=${err(32)}`);
  assert.ok(err(64) < 5e-4, `err(64)=${err(64)}`);
  assert.ok(err(64) < err(1) / 20, `err(1)=${err(1)}, err(64)=${err(64)}`);
});

test('xpbd: e = 1 apex holds across compliance (the spring returns the energy)', () => {
  // Measured errors at 32 substeps: 8.4e-4 at alpha = 0 and about
  // 3.0e-3 flat across alpha in {1e-4, 1e-3, 3e-3}. A compliant
  // XPBD contact stores and returns the impact energy instead of
  // eating it the way a penalty or projection hack would.
  for (const alpha of [0, 1e-4, 1e-3, 3e-3]) {
    const err = Math.abs(bounceApex(32, alpha) - 2.0);
    assert.ok(err < 5e-3, `alpha=${alpha}: apex error ${err}`);
  }
});

test('xpbd: e = 0 dissipates exactly the fall energy and no more', () => {
  const m = 2, r = 0.5;
  const s = mk([0, r + 1.5, 0], [0, 0, 0], m, r);
  const e0 = m * 9.81 * (r + 1.5);
  for (let i = 0; i < 240; i++) {
    stepSphereSdf(s, planeF, planeG, G, DT, { substeps: 20, e: 0 });
  }
  const ke = 0.5 * m * speed(s) ** 2;
  const eFinal = ke + m * 9.81 * s.c[1];
  assert.ok(ke < 1e-9, `residual kinetic energy ${ke}`);
  assert.ok(Math.abs(eFinal - m * 9.81 * r) < 1e-9,
    `final energy ${eFinal} vs rest potential ${m * 9.81 * r}`);
  assert.ok(eFinal < e0, 'energy decreased');
});

test('xpbd: two-sphere collisions match the analytic elastic and inelastic limits', () => {
  const run = (m1: number, v1: number, m2: number, v2: number, e: number) => {
    const a = mk([0, 0, 0], [v1, 0, 0], m1, 0.5);
    const b = mk([1.0, 0, 0], [v2, 0, 0], m2, 0.5);
    for (let i = 0; i < 30; i++) {
      stepSpheres([a, b], null, null, [0, 0, 0], DT, { substeps: 10, e });
    }
    return [a, b] as const;
  };
  // Equal masses, e = 1: velocities exchange.
  {
    const [a, b] = run(1, 2, 1, -2, 1);
    assert.ok(Math.abs(a.v[0] + 2) < 1e-9, `a.v=${a.v[0]}`);
    assert.ok(Math.abs(b.v[0] - 2) < 1e-9, `b.v=${b.v[0]}`);
  }
  // Unequal masses, e = 1: the textbook formulas, with momentum
  // and kinetic energy conserved to the same tolerance.
  {
    const [a, b] = run(1, 3, 2, -1, 1);
    assert.ok(Math.abs(a.v[0] - (-7 / 3)) < 1e-9, `a.v=${a.v[0]}`);
    assert.ok(Math.abs(b.v[0] - 5 / 3) < 1e-9, `b.v=${b.v[0]}`);
    const p = 1 * a.v[0] + 2 * b.v[0];
    assert.ok(Math.abs(p - 1) < 1e-9, `momentum ${p}`);
    const ke = 0.5 * a.v[0] ** 2 + 0.5 * 2 * b.v[0] ** 2;
    assert.ok(Math.abs(ke - 5.5) < 1e-9, `kinetic energy ${ke}`);
  }
  // e = 0: common velocity (here zero), momentum conserved.
  {
    const [a, b] = run(1, 2, 1, -2, 0);
    assert.ok(Math.abs(a.v[0]) < 1e-9 && Math.abs(b.v[0]) < 1e-9,
      `common velocity ${a.v[0]}, ${b.v[0]}`);
  }
});

test('xpbd: friction transitions a sliding sphere to rolling at (5/7) v0', () => {
  // Analytic rolling limit for a solid sphere: friction at the
  // contact point spins the body up until the contact point stops,
  // at v = (5/7) v0 and omega_z = -(5/7) v0 / r. This only works
  // if friction couples to spin, which the legacy impulse path
  // cannot do (pinned as a defect below).
  const r = 0.5, v0 = 3;
  const s = mk([0, r, 0], [v0, 0, 0], 1, r);
  for (let i = 0; i < 150; i++) {
    stepSphereSdf(s, planeF, planeG, G, DT, {
      substeps: 20, muS: 0.35, muK: 0.35, e: 0,
    });
  }
  // Measured: vx error 2e-5, slip 3e-5. Pins allow 1e-2 / 1e-3.
  assert.ok(Math.abs(s.v[0] - (5 / 7) * v0) < 1e-2, `vx=${s.v[0]}`);
  assert.ok(Math.abs(s.w[2] - (-(5 / 7) * v0 / r)) < 1e-2, `wz=${s.w[2]}`);
  assert.ok(Math.abs(s.v[0] + s.w[2] * r) < 1e-3,
    `contact slip ${s.v[0] + s.w[2] * r}`);
});

test('xpbd: identical inputs give bit-identical trajectories', () => {
  const run = (): number[] => {
    const a = mk([0, 0.5, 0], [1, 0, 0], 1, 0.5);
    const b = mk([0, 3.2, 0], [0, 0, 0], 2, 0.5);
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      stepSpheres([a, b], planeF, planeG, G, DT, {
        substeps: 12, iterations: 2, e: 0.4, muS: 0.3, muK: 0.25,
        alpha: 1e-4, contactDamping: 0.02,
      });
      out.push(...a.c, ...a.v, ...a.w, ...b.c, ...b.v, ...b.w);
    }
    return out;
  };
  assert.deepStrictEqual(run(), run());
});

test('xpbd negative control: sign-flipped gravity does not settle', () => {
  // The stability tests above would be vacuous if the solver
  // clamped bodies to the surface. With gravity pointing away
  // from the plane the body must leave ballistically: after 2 s
  // the analytic state is y = r + g t^2 / 2 = 20.12, vy = 19.62.
  const s = mk([0, 0.5, 0], [0, 0, 0], 1, 0.5);
  for (let i = 0; i < 120; i++) {
    stepSphereSdf(s, planeF, planeG, [0, 9.81, 0], DT, {
      substeps: 20, e: 0,
    });
  }
  assert.ok(s.c[1] > 19.5, `y=${s.c[1]}`);
  assert.ok(Math.abs(s.v[1] - 19.62) < 0.1, `vy=${s.v[1]}`);
  // The settle predicate used above (rest height, ~zero speed)
  // must read false here.
  assert.ok(!(Math.abs(s.c[1] - 0.5) < 1e-6 && speed(s) < 1e-6));
});

test('xpbd negative control: dropping lambda accumulation degrades compliance to PBD', () => {
  // With accumulateLambda: false the -alpha_tilde * lambda term is
  // gone and each iteration re-projects from scratch: classic PBD,
  // whose effective stiffness depends on the iteration count. At 8
  // iterations the settled deflection lands about 8x too stiff
  // (measured error 1.7e-2 against the oracle 1.962e-2), while the
  // accumulated solve lands on the oracle (measured error 6e-14).
  const settle = (accumulate: boolean) => {
    const s = mk([0, 0.8, 0], [0, 0, 0], 2, 0.5);
    for (let i = 0; i < 240; i++) {
      stepSphereSdf(s, planeF, planeG, G, DT, {
        alpha: 1e-3, substeps: 20, iterations: 8, e: 0,
        contactDamping: 0.05, accumulateLambda: accumulate,
      });
    }
    return 0.5 - s.c[1];
  };
  const oracle = 1e-3 * 2 * 9.81;
  const errAcc = Math.abs(settle(true) - oracle);
  const errAbl = Math.abs(settle(false) - oracle);
  assert.ok(errAcc < 1e-9, `accumulated error ${errAcc}`);
  assert.ok(errAbl > 0.25 * oracle, `ablated error ${errAbl}`);
});

test('collide legacy pins: impulse friction is rotation-blind (documented defect), primitives unchanged', () => {
  // Defect, documented rather than silently fixed: the legacy
  // impulse path's friction never reads or writes w, and it sizes
  // the tangential impulse with the full mass instead of the
  // contact-point effective mass m / 3.5, so a sliding sphere is
  // stopped dead in one impulse and never starts rolling. The
  // XPBD path fixes this (rolling test above); the legacy path is
  // pinned as-is because it stays available verbatim behind
  // { solver: 'impulse' }.
  const s = mk([0, 0.5, 0], [3, -1, 0], 2, 0.5);
  applyContactImpulse(s, [0, 1, 0], 0, 10);
  assert.deepStrictEqual([...s.w], [0, 0, 0], 'w untouched');
  assert.ok(Math.abs(s.v[0]) < 1e-12, `tangential velocity killed: ${s.v[0]}`);
  assert.ok(Math.abs(s.v[1]) < 1e-12, `normal velocity killed: ${s.v[1]}`);
  // The single-shot XPBD primitive is unchanged: alpha = 0 projects
  // a penetrating sphere exactly onto the surface.
  const p = mk([0, 0.4, 0], [0, 0, 0], 2, 0.5);
  xpbdContact(p, planeF, planeG, 0, 1 / 240);
  assert.ok(Math.abs(p.c[1] - 0.5) < 1e-12, `projected y=${p.c[1]}`);
  // The impulse solver is single-body only, by explicit error.
  assert.throws(
    () => stepSpheres([mk([0, 1, 0], [0, 0, 0], 1, 0.5)],
      planeF, planeG, G, DT, { solver: 'impulse' }),
    /single-sphere/,
  );
});
