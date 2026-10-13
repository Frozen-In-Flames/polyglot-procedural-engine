// games/first-light/scripts/attunement.ts — the hidden score.
//
// THE game. Attunement rewards EMBODIED PREDICTION — the body learning the
// wind's rhythms before the mind names them — and it is never shown, never
// counted, never hinted. Three concrete mechanics:
//
//   A. velocity aligned with the local wind vector (move WITH the air);
//   B. positioned where an ember current will carry an ember within seconds
//      (stand where the wind is taking the ember, and it comes to you);
//   C. holding still as a gust front passes (feel the wave go through).
//
// Six thresholds (one per engine language) unlock the foundry's six levers
// progressively; the sixth is resonance — the gate opens. The score lives
// in world state where only scripts can read it. No UI. No numbers. Ever.

import type { Caps, CapabilityName, ScriptDef } from '../../../src/script/index.js';
import { ATTUNE_LANGS, GATE_ROOT_FREQ, attuneLevel } from '../shared.js';

export const ATTUNE_GRANTS: CapabilityName[] = [
  'time', 'world.query', 'world.state', 'events', 'log', 'field.read', 'audio',
];

/**
 * V8 one-way adaptive-state push. The host-side `mood` method on the
 * audio caps is defined by the engine's V8 build (the src/audio/score.ts
 * conductor reads it); the interface here documents the exact payload
 * contract. Scripts push state; the host owns every node. Attunement is
 * data only — never shown, never logged, never counted in any UI.
 */
interface MoodPush {
  attunement?: number;  // 0..100 hidden score (First Light's own scale)
  energy?: number;      // 0..1 scene intensity
  tension?: number;     // 0..1 danger / unresolvedness
  brightness?: number;  // 0..1 spectral openness the game wants
  tempo?: number;       // multiplier on the base bpm, 0.5..2
}
/** The audio caps with the V8 mood push (guarded — see the call site). */
type MoodAudio = { mood?: (p: MoodPush) => void };

/** Pure scoring step for mechanic A (testable): returns the score delta. */
export function scoreAlignment(
  vx: number, vz: number, speed: number,
  windX: number, windZ: number,
): number {
  if (speed < 1.5) return 0;
  const wm = Math.hypot(windX, windZ);
  if (wm < 0.5) return 0;
  const a = (vx * windX + vz * windZ) / (speed * wm);
  if (a > 0.65) return 0.45 * a;
  if (a < -0.5) return -0.12;
  return 0;
}

/** Pure scoring step for mechanic C (testable). */
export function scoreStillness(
  windSpeed: number, windowMax: number, playerSpeed: number, dt: number,
): number {
  if (windowMax > 1.5 && windSpeed > 0.85 * windowMax && playerSpeed < 0.6) {
    return 0.5 * dt;
  }
  return 0;
}

export const attunementScript: ScriptDef = {
  name: 'fl:attunement',

  start(caps: Caps): void {
    caps.world.setState('attune:score', 0);
    caps.world.setState('attune:level', 0);
    // The gate's root frequency, published up front: the V8 conductor reads
    // it for the resonance retune (just-intonation lattice on this root
    // when attunement hits level 6). Data only, like everything else here.
    caps.world.setState('gate:rootFreq', GATE_ROOT_FREQ);
  },

  update(caps: Caps, dt: number, t: number): void {
    let score = (caps.world.state('attune:score') as number | undefined) ?? 0;
    let level = (caps.world.state('attune:level') as number | undefined) ?? 0;
    const vel = (caps.world.state('player:vel') as [number, number, number] | undefined) ?? [0, 0, 0];
    const ppos = (caps.world.state('player:pos') as [number, number, number] | undefined) ?? [0, 0, 0];
    const [vx, vz, speed] = vel;

    // --- A: move with the air (0.5 s ticks) ---
    thisAcc.a += dt;
    if (thisAcc.a >= 0.5) {
      thisAcc.a = 0;
      const w = caps.field.wind([ppos[0], ppos[1], ppos[2]], t);
      score += scoreAlignment(vx, vz, speed, w[0], w[2]);
    }

    // --- B: stand where the current delivers (2 s ticks) ---
    thisAcc.b += dt;
    if (thisAcc.b >= 2) {
      thisAcc.b = 0;
      if (speed < 2.5) {
        const params = caps.field.params() as { biome: { emberDrift: number } };
        const drift = params.biome.emberDrift;
        for (const e of caps.world.query('ember')) {
          const last = thisAcc.cool.get(e.id) ?? -Infinity;
          if (t - last < 6) continue;
          const ep = e.getTransform().position;
          // Advect the ember forward 4 s through the field: where is the
          // current taking it?
          let fx = ep[0], fy = ep[1], fz = ep[2];
          for (let k = 1; k <= 4; k++) {
            const w = caps.field.wind([fx, fy, fz], t + k);
            fx += w[0] * drift * 0.9;
            fz += w[2] * drift * 0.9;
            fy += w[1] * drift * 0.5;
          }
          const d = Math.hypot(ppos[0] - fx, ppos[2] - fz);
          if (d < 7) {
            score += 0.35;
            thisAcc.cool.set(e.id, t);
          }
        }
      }
    }

    // --- C: hold still as a gust front passes (continuous) ---
    const w0 = caps.field.wind([ppos[0], ppos[1], ppos[2]], t);
    const wmag = Math.hypot(w0[0], w0[2]);
    thisAcc.window.push(wmag);
    if (thisAcc.window.length > 40) thisAcc.window.shift();
    const wmax = Math.max(...thisAcc.window);
    score += scoreStillness(wmag, wmax, speed, dt);

    score = Math.max(0, Math.min(100, score));
    const newLevel = attuneLevel(score);
    if (newLevel > level) {
      level = newLevel;
      caps.world.setState('attune:level', level);
      // The host hears this tap and wakes the corresponding foundry lever.
      // The player is told nothing.
      caps.events.emit('attune:level', { level, lang: ATTUNE_LANGS[level - 1] });
      if (newLevel >= 6) {
        // Resonance: re-publish the gate's root frequency at the moment
        // the retune happens, so the conductor resolves the lattice on it.
        caps.world.setState('gate:rootFreq', GATE_ROOT_FREQ);
      }
    }
    caps.world.setState('attune:score', score);

    // --- V8: the world answers in sound. One-way mood push, every frame.
    // Attunement stays a data-only input to the conductor: the player hears
    // the world change and is told nothing. Derived values:
    //
    //   energy     = wind intensity (relative to the recent window) plus
    //                player intensity (speed / max moveSpeed); the player
    //                moving with the air is what the music swells with.
    //   tension    = fighting the wind (moving against the air) plus
    //                unresolvedness: how far the run sits from resonance.
    //   brightness = the Swift light lever's live value (foundry:val:4 =
    //                timeOfDay 0..1) — the player's own authorship opens
    //                the air, so the sparkle layer follows their hand.
    const windMax = Math.max(0.5, wmax);
    const windIntensity = Math.min(1, wmag / windMax);
    const playerIntensity = Math.min(1, speed / 8); // lever max moveSpeed
    const energy = 0.6 * windIntensity + 0.4 * playerIntensity;
    const wm2 = Math.hypot(w0[0], w0[2]);
    let fight = 0;
    if (speed >= 1.5 && wm2 >= 0.5) {
      const a = (w0[0] * vx + w0[2] * vz) / (speed * wm2);
      fight = a < -0.5 ? 1 : a < 0.65 ? 0.4 : 0;
    }
    const unresolved = level >= 6 ? 0 : (1 - score / 100) * 0.7 + (1 - level / 6) * 0.3;
    const tension = Math.min(1, 0.65 * fight + 0.35 * unresolved);
    const lightVal = (caps.world.state('foundry:val:4') as number | undefined) ?? 0.5;
    const brightness = Math.max(0, Math.min(1, lightVal));
    // Guarded: the engine worker's runtime mood() has not landed yet, and
    // the runtime builds the audio caps from note/notes only. The guard
    // drops away once it does; until then the conductor simply keeps its
    // defaults and nothing here changes game behavior.
    const moodAudio = caps.audio as unknown as MoodAudio;
    if (typeof moodAudio.mood === 'function') {
      moodAudio.mood.call(caps.audio, { attunement: score, energy, tension, brightness });
    }
  },
};

/** Per-instance accumulators live outside caps (closure state is fine — the
 *  script def object is the instance here since the game loads it once). */
const thisAcc = {
  a: 0,
  b: 0,
  window: [] as number[],
  cool: new Map<number, number>(),
};
