// test/gamefeel.test.ts - V10.5 "game feel": fixed-timestep loop, SDF
// capsule character controller, deterministic input replay.
//
// Spec:
//   Loop: accumulator banks frame time; ticks are fixed TICK_DT = 1/60 s;
//   at most MAX_STEPS ticks per frame (spiral-of-death clamp, debt
//   dropped); render alpha = acc / TICK_DT in [0, 1]. Same frame
//   sequence -> same tick stream (deterministic).
//   Character: capsule = two spheres (radius r, centers halfHeight above
//   and below pos, vertical axis) vs the SDF field. Per tick: buffer the
//   jump press; early-release jump cut while ascending; accelerate the
//   horizontal velocity toward the wish velocity; fire a buffered jump on
//   ground or coyote grace; gravity; integrate; resolve penetration at
//   both endpoints along the field gradient (kill into-surface velocity);
//   ground detect at the feet within r + groundEps; slopes with
//   n.y < slopeLimit slide (no stick, gravity + resolve do the work).
//   Coyote time, jump buffering, and the jump cut are tick-count
//   parameters, defined mathematically.
//   Replay: per-tick input structs recorded to a seeded log; replay feeds
//   the log through the identical tick function; final state must be
//   bit-identical (ULP distance 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TICK_DT, MAX_STEPS, makeLoop, stepLoop } from '../src/game/loop.js';
import { makeCharacter, tickCharacter } from '../src/game/character.js';
import type {
  CharacterParams,
  CharacterState,
  CharacterInput,
} from '../src/game/character.js';
import { createLog, recordTick, replayLog } from '../src/game/replay.js';
import type { TickInput } from '../src/game/replay.js';
import { ulpDistance } from '../src/math/fperror.js';
import { Pcg32 } from '../src/math/determinism.js';
import type { Vec3 } from '../src/math/vec.js';

const PLANE_F = (p: Vec3) => p[1];
const PLANE_G = (_p: Vec3): Vec3 => [0, 1, 0];

const P: CharacterParams = {
  radius: 0.4,
  halfHeight: 0.5,
  moveAccel: 40,
  airAccel: 12,
  maxGroundSpeed: 6,
  maxAirSpeed: 4,
  jumpVelocity: 8,
  gravity: 20,
  groundEps: 0.05,
  coyoteTicks: 6,
  bufferTicks: 8,
  slopeLimit: Math.cos(Math.PI / 6), // 30 degrees
  groundFriction: 30,
  jumpCut: 0.5,
};
const REST_Y = P.radius + P.halfHeight; // capsule center at rest on a plane
const NO_INPUT: CharacterInput = { move: [0, 0], jumpPressed: false, jumpHeld: false };

// ---------------------------------------------------------------- loop ---

test('loop: one tick per frame at exactly dt = 1/60', () => {
  const s = makeLoop();
  const seen: number[] = [];
  const alpha = stepLoop(s, TICK_DT, (dt, i) => {
    seen.push(i);
    assert.strictEqual(dt, TICK_DT);
  });
  assert.deepStrictEqual(seen, [0]);
  assert.strictEqual(s.tick, 1);
  assert.strictEqual(alpha, 0);
});

test('loop: a 1/30 frame consumes two ticks', () => {
  const s = makeLoop();
  let n = 0;
  const alpha = stepLoop(s, 1 / 30, () => {
    n++;
  });
  assert.strictEqual(n, 2);
  assert.strictEqual(alpha, 0);
});

test('loop: a half-tick frame banks time, alpha = 0.5', () => {
  const s = makeLoop();
  let n = 0;
  const alpha = stepLoop(s, TICK_DT / 2, () => {
    n++;
  });
  assert.strictEqual(n, 0);
  assert.strictEqual(alpha, 0.5);
  // The next half-tick frame completes the tick.
  const alpha2 = stepLoop(s, TICK_DT / 2, () => {
    n++;
  });
  assert.strictEqual(n, 1);
  assert.strictEqual(alpha2, 0);
});

test('loop: spiral-of-death clamp caps ticks; alpha stays in [0, 1]', () => {
  const s = makeLoop();
  let n = 0;
  const alpha = stepLoop(s, 10, () => {
    n++;
  });
  assert.strictEqual(n, MAX_STEPS);
  assert.ok(alpha >= 0 && alpha <= 1, `alpha=${alpha}`);
  // Negative frame time is treated as zero.
  const s2 = makeLoop();
  let n2 = 0;
  const a2 = stepLoop(s2, -0.5, () => {
    n2++;
  });
  assert.strictEqual(n2, 0);
  assert.strictEqual(a2, 0);
});

test('loop: identical frame sequences give identical tick streams', () => {
  const frames = [1 / 60, 1 / 30, 1 / 120, 1 / 60, 0.1, 1 / 240];
  const run = () => {
    const s = makeLoop();
    const idx: number[] = [];
    let v = 0;
    for (const f of frames) {
      stepLoop(s, f, (dt, i) => {
        idx.push(i);
        v += i * dt;
      });
    }
    return { ticks: s.tick, idx, v };
  };
  const a = run();
  const b = run();
  assert.strictEqual(a.ticks, b.ticks);
  assert.deepStrictEqual(a.idx, b.idx);
  assert.strictEqual(a.v, b.v);
});

// ------------------------------------------------------------ character ---

test('character: dropped capsule rests on the plane at r + halfHeight', () => {
  const st = makeCharacter([0, 5, 0]);
  for (let t = 0; t < 300; t++) tickCharacter(st, P, NO_INPUT, PLANE_F, PLANE_G, TICK_DT);
  assert.ok(Math.abs(st.pos[1] - REST_Y) < 1e-9, `rest y=${st.pos[1]}`);
  assert.ok(st.grounded, 'should be grounded');
  const sp = Math.hypot(st.vel[0], st.vel[1], st.vel[2]);
  assert.ok(sp < 1e-9, `rest speed=${sp}`);
});

test('character: jump apex matches the discrete model, near v^2/2g', () => {
  const st = makeCharacter([0, REST_Y, 0]);
  st.grounded = true; // spawn at rest on the ground
  tickCharacter(
    st,
    P,
    { move: [0, 0], jumpPressed: true, jumpHeld: true },
    PLANE_F,
    PLANE_G,
    TICK_DT,
  );
  assert.strictEqual(st.vel[1], P.jumpVelocity);
  let maxY = st.pos[1];
  const hold: CharacterInput = { move: [0, 0], jumpPressed: false, jumpHeld: true };
  for (let t = 0; t < 300; t++) {
    tickCharacter(st, P, hold, PLANE_F, PLANE_G, TICK_DT);
    if (st.pos[1] > maxY) maxY = st.pos[1];
    if (st.grounded && t > 5) break;
  }
  const apex = maxY - REST_Y;
  // Discrete model: the jump tick rises v*dt with no gravity (the impulse
  // replaces gravity on its tick), then v_k = v - k*g*dt while positive.
  // This is the specified behavior, pinned exactly.
  let expected = 0;
  let vv = P.jumpVelocity;
  expected += vv * TICK_DT;
  vv -= P.gravity * TICK_DT;
  while (vv > 0) {
    expected += vv * TICK_DT;
    vv -= P.gravity * TICK_DT;
  }
  assert.ok(Math.abs(apex - expected) < 1e-9, `apex ${apex} vs discrete ${expected}`);
  // And the discrete model sits within one tick of the continuous theory.
  const theory = (P.jumpVelocity * P.jumpVelocity) / (2 * P.gravity);
  assert.ok(
    Math.abs(expected - theory) <= P.jumpVelocity * TICK_DT + 1e-9,
    `discrete ${expected} vs theory ${theory}`,
  );
  assert.ok(st.grounded, 'should have landed');
});

test('character: releasing jump early cuts the jump short', () => {
  const fly = (releaseTick: number): number => {
    const st = makeCharacter([0, REST_Y, 0]);
    st.grounded = true;
    let maxY = st.pos[1];
    for (let t = 0; t < 300; t++) {
      tickCharacter(
        st,
        P,
        { move: [0, 0], jumpPressed: t === 0, jumpHeld: t < releaseTick },
        PLANE_F,
        PLANE_G,
        TICK_DT,
      );
      if (st.pos[1] > maxY) maxY = st.pos[1];
      if (st.grounded && t > 5) break;
    }
    return maxY - REST_Y;
  };
  const full = fly(1000); // held for the whole flight
  const cut = fly(6); // released at tick 6, still ascending
  assert.ok(cut < full - 0.2, `cut apex ${cut} vs full ${full}`);
});

test('character: sustained input reaches max ground speed, never exceeds it', () => {
  const st = makeCharacter([0, REST_Y, 0]);
  st.grounded = true;
  const input: CharacterInput = { move: [1, 0], jumpPressed: false, jumpHeld: false };
  let peak = 0;
  for (let t = 0; t < 120; t++) {
    tickCharacter(st, P, input, PLANE_F, PLANE_G, TICK_DT);
    const sp = Math.hypot(st.vel[0], st.vel[2]);
    if (sp > peak) peak = sp;
  }
  const end = Math.hypot(st.vel[0], st.vel[2]);
  assert.ok(peak <= P.maxGroundSpeed + 1e-9, `peak ${peak}`);
  assert.ok(Math.abs(end - P.maxGroundSpeed) < 1e-9, `end ${end}`);
});

test('character: ground friction stops a sliding character with no input', () => {
  const st = makeCharacter([0, REST_Y, 0]);
  st.grounded = true;
  st.vel = [5, 0, 0];
  for (let t = 0; t < 120; t++) tickCharacter(st, P, NO_INPUT, PLANE_F, PLANE_G, TICK_DT);
  const sp = Math.hypot(st.vel[0], st.vel[2]);
  assert.ok(sp < 1e-9, `speed ${sp}`);
});

test('character: walking into a wall never penetrates it', () => {
  // Corner field: floor plane plus a wall at x = 0 (free space x > 0).
  // The gradient tie-break prefers the floor exactly at the corner.
  const f = (p: Vec3) => Math.min(p[1], p[0]);
  const grad = (p: Vec3): Vec3 => (p[1] <= p[0] ? [0, 1, 0] : [1, 0, 0]);
  const st = makeCharacter([2, REST_Y, 0]);
  st.grounded = true;
  const input: CharacterInput = { move: [-1, 0], jumpPressed: false, jumpHeld: false };
  let minX = Infinity;
  for (let t = 0; t < 180; t++) {
    tickCharacter(st, P, input, f, grad, TICK_DT);
    if (st.pos[0] < minX) minX = st.pos[0];
  }
  assert.ok(minX >= P.radius - 1e-9, `min x=${minX}`);
});

test('character: coyote time grants a late jump; expired coyote does not', () => {
  // Ledge field: the floor exists only for x < 0.
  const f = (p: Vec3) => (p[0] < 0 ? p[1] : 10);
  const grad = (_p: Vec3): Vec3 => [0, 1, 0];
  const walkInput: CharacterInput = { move: [1, 0], jumpPressed: false, jumpHeld: false };
  const findLeave = (): number => {
    const st = makeCharacter([-2, REST_Y, 0]);
    st.grounded = true;
    for (let t = 0; t < 200; t++) {
      const was = st.grounded;
      tickCharacter(st, P, walkInput, f, grad, TICK_DT);
      if (was && !st.grounded) return t;
    }
    return -1;
  };
  const tryJump = (pressTick: number): boolean => {
    const st = makeCharacter([-2, REST_Y, 0]);
    st.grounded = true;
    for (let t = 0; t < 200; t++) {
      tickCharacter(
        st,
        P,
        { move: [1, 0], jumpPressed: t === pressTick, jumpHeld: t === pressTick },
        f,
        grad,
        TICK_DT,
      );
      if (st.vel[1] === P.jumpVelocity) return true; // the jump fired this tick
    }
    return false;
  };
  const leave = findLeave();
  assert.ok(leave > 0, 'should walk off the ledge');
  assert.ok(tryJump(leave + 4), 'coyote jump should fire inside the grace window');
  assert.ok(!tryJump(leave + 10), 'jump after the grace window must not fire');
});

test('character: a jump pressed before landing fires on touchdown', () => {
  const st = makeCharacter([0, REST_Y + 1.0, 0]); // 1 m above rest, falling
  let pressed = false;
  let fired = false;
  for (let t = 0; t < 120; t++) {
    // Press once, shortly before the expected touchdown (buffer = 8 ticks).
    const feetY = st.pos[1] - P.halfHeight;
    const press = !pressed && !st.grounded && st.vel[1] < 0 && feetY < 0.75;
    if (press) pressed = true;
    tickCharacter(
      st,
      P,
      { move: [0, 0], jumpPressed: press, jumpHeld: press },
      PLANE_F,
      PLANE_G,
      TICK_DT,
    );
    if (pressed && !fired && st.vel[1] === P.jumpVelocity) fired = true;
  }
  assert.ok(pressed, 'should have pressed while falling');
  assert.ok(fired, 'buffered jump should fire on touchdown');
});

test('character: slopes steeper than the limit slide instead of sticking', () => {
  const S = 1; // 45-degree slope descending toward +x; n.y = 1/sqrt(2)
  const nrm = Math.sqrt(1 + S * S);
  const f = (p: Vec3) => (p[1] + S * p[0]) / nrm;
  const grad = (_p: Vec3): Vec3 => [S / nrm, 1 / nrm, 0];
  // Rest the capsule on the slope: feet at distance r along the normal.
  const st = makeCharacter([0, P.halfHeight + P.radius * Math.SQRT2, 0]);
  const x0 = st.pos[0];
  for (let t = 0; t < 60; t++) tickCharacter(st, P, NO_INPUT, f, grad, TICK_DT);
  assert.ok(st.vel[0] > 1, `slide speed=${st.vel[0]}`);
  assert.ok(st.pos[0] > x0 + 0.5, `slid to x=${st.pos[0]}`);
});

// ---------------------------------------------------------------- replay ---

test('replay: 240 seeded ticks replay to bit-identical state (ULP 0)', () => {
  const fresh = (): CharacterState => makeCharacter([0, 5, 0]);
  const apply = (s: CharacterState, inp: TickInput) =>
    tickCharacter(s, P, inp, PLANE_F, PLANE_G, TICK_DT);
  const log = createLog(1234);
  const g = new Pcg32(99);
  const live = fresh();
  let held = false;
  for (let t = 0; t < 240; t++) {
    const pressed = g.unit() < 0.05;
    held = pressed ? true : g.unit() < 0.8 ? held : false;
    const input: TickInput = {
      move: [g.unit() * 2 - 1, g.unit() * 2 - 1],
      jumpPressed: pressed,
      jumpHeld: held,
      look: [g.unit() * 0.1 - 0.05, g.unit() * 0.1 - 0.05],
    };
    recordTick(log, input);
    apply(live, input);
  }
  const replayed = replayLog(log, fresh, apply);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < 3; i++) {
    pairs.push([live.pos[i], replayed.pos[i]]);
    pairs.push([live.vel[i], replayed.vel[i]]);
  }
  for (const [a, b] of pairs) {
    assert.strictEqual(ulpDistance(a, b), 0, `ulp(${a}, ${b})`);
  }
  assert.strictEqual(replayed.grounded, live.grounded);
  assert.strictEqual(replayed.coyote, live.coyote);
  assert.strictEqual(replayed.buffer, live.buffer);
  assert.strictEqual(replayed.jumpHeld, live.jumpHeld);
});

test('replay: log records inputs faithfully; empty log replays to init', () => {
  const log = createLog(7);
  const a: TickInput = { move: [1, 0], jumpPressed: true, jumpHeld: true, look: [0.1, -0.2] };
  const b: TickInput = { move: [0, -1], jumpPressed: false, jumpHeld: false, look: [0, 0] };
  recordTick(log, a);
  recordTick(log, b);
  assert.strictEqual(log.inputs.length, 2);
  assert.deepStrictEqual(log.inputs[0], a);
  assert.deepStrictEqual(log.inputs[1], b);
  // Mutating the caller's object after recording must not corrupt the log.
  a.move[0] = 999;
  assert.strictEqual(log.inputs[0].move[0], 1);
  const out = replayLog(createLog(0), () => makeCharacter([1, 2, 3]), () => {});
  assert.deepStrictEqual(out.pos, [1, 2, 3]);
});
