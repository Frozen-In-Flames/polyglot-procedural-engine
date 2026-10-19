// game/character.ts - capsule character controller against an SDF world.
//
// The capsule is two spheres (radius r) whose centers sit halfHeight
// above and below the character position; the axis stays vertical.
// Collision is pure field sampling: penetration d = r - f(p) at each
// endpoint, resolved by pushing out along the normalized field gradient
// and killing the into-surface velocity. No mesh colliders, no
// broadphase: the field is the collider.
//
// Game feel is defined mathematically, in ticks:
//   coyoteTicks - grace ticks in which a jump still fires after leaving
//     the ground.
//   bufferTicks - ticks a jump press survives while airborne, so a press
//     just before touchdown fires on landing.
//   jumpCut - upward-velocity multiplier applied on the release edge of
//     the jump button while ascending (variable jump height).
//
// Ground is the field-distance band f(feet) <= r + groundEps with an
// upward normal. Slopes with n.y >= slopeLimit are walkable; steeper
// contact never sticks: grounded stays false, so gravity plus the
// contact resolve turn into a slide down the tangent.

import type { Vec3 } from '../math/vec.js';

export interface CharacterParams {
  /** Capsule radius (sphere radius at each endpoint). */
  radius: number;
  /** Half the distance between the two sphere centers. */
  halfHeight: number;
  /** Horizontal acceleration toward the wish velocity on the ground. */
  moveAccel: number;
  /** Horizontal acceleration toward the wish velocity in the air. */
  airAccel: number;
  /** Top horizontal speed on the ground. */
  maxGroundSpeed: number;
  /** Top horizontal speed in the air. */
  maxAirSpeed: number;
  /** Takeoff speed. */
  jumpVelocity: number;
  /** Downward acceleration magnitude. */
  gravity: number;
  /** Field-distance band at the feet that counts as grounded. */
  groundEps: number;
  /** Grace ticks to jump after leaving the ground. */
  coyoteTicks: number;
  /** Ticks a jump press stays buffered before landing. */
  bufferTicks: number;
  /** Cosine of the steepest walkable slope; steeper slides. */
  slopeLimit: number;
  /** Horizontal deceleration with no input on the ground. */
  groundFriction: number;
  /** Upward-velocity multiplier on early jump release while ascending. */
  jumpCut: number;
}

export interface CharacterState {
  /** Capsule center (midpoint of the two sphere centers). */
  pos: Vec3;
  /** Linear velocity. */
  vel: Vec3;
  grounded: boolean;
  /** Remaining coyote ticks. */
  coyote: number;
  /** Remaining buffered-jump ticks. */
  buffer: number;
  /** Jump held on the previous tick (release-edge detection). */
  jumpHeld: boolean;
}

export interface CharacterInput {
  /** Wish direction (x, z), world space; need not be unit length. */
  move: [number, number];
  /** Jump pressed this tick (rising edge). */
  jumpPressed: boolean;
  /** Jump held this tick (level). */
  jumpHeld: boolean;
}

/** Fresh character state at a spawn position. */
export function makeCharacter(pos: Vec3): CharacterState {
  return {
    pos: [pos[0], pos[1], pos[2]],
    vel: [0, 0, 0],
    grounded: false,
    coyote: 0,
    buffer: 0,
    jumpHeld: false,
  };
}

function norm3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Advance the character one fixed tick. f is the signed distance field,
 * grad its gradient. The order is fixed and explicit: buffer the press,
 * jump-cut on release edge, horizontal control, jump, gravity, integrate,
 * collide, ground detect, decay the buffer.
 */
export function tickCharacter(
  st: CharacterState,
  p: CharacterParams,
  input: CharacterInput,
  f: (pt: Vec3) => number,
  grad: (pt: Vec3) => Vec3,
  dt: number,
): void {
  // 1. Buffer the press.
  if (input.jumpPressed) st.buffer = p.bufferTicks;

  // 2. Early-release jump cut: release edge while ascending.
  if (st.jumpHeld && !input.jumpHeld && st.vel[1] > 0) {
    st.vel[1] *= p.jumpCut;
  }
  st.jumpHeld = input.jumpHeld;

  // 3. Horizontal control: accelerate toward the wish velocity.
  const wishLen = Math.hypot(input.move[0], input.move[1]);
  const topSpeed = st.grounded ? p.maxGroundSpeed : p.maxAirSpeed;
  const accel = st.grounded ? p.moveAccel : p.airAccel;
  let wishX = 0;
  let wishZ = 0;
  if (wishLen > 1e-12) {
    wishX = (input.move[0] / wishLen) * topSpeed;
    wishZ = (input.move[1] / wishLen) * topSpeed;
  }
  const dx = wishX - st.vel[0];
  const dz = wishZ - st.vel[2];
  const dl = Math.hypot(dx, dz);
  const maxD = accel * dt;
  if (dl <= maxD) {
    st.vel[0] = wishX;
    st.vel[2] = wishZ;
  } else if (dl > 1e-12) {
    st.vel[0] += (dx / dl) * maxD;
    st.vel[2] += (dz / dl) * maxD;
  }
  // Friction when grounded with no wish.
  if (st.grounded && wishLen <= 1e-12) {
    const sp = Math.hypot(st.vel[0], st.vel[2]);
    if (sp > 1e-12) {
      const ns = Math.max(0, sp - p.groundFriction * dt);
      st.vel[0] *= ns / sp;
      st.vel[2] *= ns / sp;
    } else {
      st.vel[0] = 0;
      st.vel[2] = 0;
    }
  }

  // 4. Jump: buffered press plus ground or coyote grace.
  let jumped = false;
  if (st.buffer > 0 && (st.grounded || st.coyote > 0)) {
    st.vel[1] = p.jumpVelocity;
    st.grounded = false;
    st.coyote = 0;
    st.buffer = 0;
    jumped = true;
  }

  // 5. Gravity (the jump impulse replaces gravity on its tick).
  if (!st.grounded && !jumped) st.vel[1] -= p.gravity * dt;

  // 6. Integrate.
  st.pos[0] += st.vel[0] * dt;
  st.pos[1] += st.vel[1] * dt;
  st.pos[2] += st.vel[2] * dt;

  // 7. Collide: resolve each endpoint against the field.
  const ends: Vec3[] = [
    [st.pos[0], st.pos[1] - p.halfHeight, st.pos[2]],
    [st.pos[0], st.pos[1] + p.halfHeight, st.pos[2]],
  ];
  for (const e of ends) {
    const d = f(e);
    if (d < p.radius) {
      const n = norm3(grad(e));
      const push = p.radius - d;
      st.pos[0] += n[0] * push;
      st.pos[1] += n[1] * push;
      st.pos[2] += n[2] * push;
      const vn = st.vel[0] * n[0] + st.vel[1] * n[1] + st.vel[2] * n[2];
      if (vn < 0) {
        st.vel[0] -= n[0] * vn;
        st.vel[1] -= n[1] * vn;
        st.vel[2] -= n[2] * vn;
      }
    }
  }

  // 8. Ground detect at the feet. Steeper than slopeLimit never sticks:
  // grounded stays false, so gravity plus the contact resolve slide the
  // character down the tangent instead.
  const feet: Vec3 = [st.pos[0], st.pos[1] - p.halfHeight, st.pos[2]];
  const n = norm3(grad(feet));
  if (f(feet) <= p.radius + p.groundEps && n[1] > 0) {
    if (n[1] >= p.slopeLimit) {
      st.grounded = true;
      st.coyote = p.coyoteTicks;
    } else {
      st.grounded = false;
      st.coyote = 0;
    }
  } else {
    st.grounded = false;
    st.coyote = Math.max(0, st.coyote - 1);
  }

  // 9. Decay the unconsumed buffer.
  if (st.buffer > 0) st.buffer -= 1;
}
