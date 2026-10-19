// game/loop.ts - fixed-timestep game loop with render interpolation.
//
// Simulation advances in fixed ticks of TICK_DT seconds, decoupled from
// the frame rate: each frame banks its elapsed time in an accumulator and
// consumes whole ticks from it. Rendering interpolates between the last
// two simulated states with alpha in [0, 1].
//
// Spiral-of-death guard: a frame banks at most MAX_STEPS ticks of debt;
// anything beyond that is dropped, so one slow frame costs ticks, never
// an unbounded catch-up spiral.
//
// Determinism: the tick callback receives only (dt, tickIndex) with dt
// fixed, so the same sequence of ticks always produces identical state.

/** Fixed simulation step, seconds. */
export const TICK_DT = 1 / 60;

/** Max ticks consumed in one frame before frame debt is dropped. */
export const MAX_STEPS = 5;

export interface LoopState {
  /** Seconds banked toward the next tick. */
  acc: number;
  /** Ticks consumed so far. */
  tick: number;
}

/** Fresh loop state. */
export function makeLoop(): LoopState {
  return { acc: 0, tick: 0 };
}

/**
 * Advance the loop by frameDt seconds, invoking tick(dt, index) once per
 * consumed tick. Returns the render interpolation alpha in [0, 1]:
 * alpha = 0 exactly on a tick boundary, approaching 1 just before the
 * next tick. The caller lerps render state as prev + (curr - prev)*alpha.
 */
export function stepLoop(
  s: LoopState,
  frameDt: number,
  tick: (dt: number, index: number) => void,
  maxSteps: number = MAX_STEPS,
): number {
  const debt = Math.min(Math.max(frameDt, 0), maxSteps * TICK_DT);
  s.acc += debt;
  let n = 0;
  while (n < maxSteps && s.acc >= TICK_DT) {
    tick(TICK_DT, s.tick);
    s.tick += 1;
    s.acc -= TICK_DT;
    n += 1;
  }
  const alpha = s.acc / TICK_DT;
  return alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
}
