// script/refScripts.ts — reference scripts proving the runtime path.
//
// These port the C# ScriptProvider behaviors (dotnet/XrEngine.Providers)
// through the new sandboxed runtime:
//   - floatScript  ~ FloatScript  (bob + spin; behavioral port)
//   - arpScript    ~ ScoreComposer arp layer  (BIT-EXACT port)
//   - hatsScript   ~ ScoreComposer hats layer (BIT-EXACT port)
//
// Bit-exactness for arp/hats: the C# composer uses SplitMix64, not the
// engine's mulberry32, so the reference scripts carry their own SplitMix64
// (BigInt, exact 64-bit ops) and mirror the C# algorithm statement for
// statement, including C#'s banker's rounding (MidpointRounding.ToEven) on
// the time grid. The parity test compares the composed events against the
// committed C# output (demo/public/gen/csharp-score.json).

import type { NoteEvent, ScriptDef } from './api.js';

// ---------- SplitMix64, bit-identical to dotnet/XrEngine.Providers/AudioScore.cs ----------

const U64 = (1n << 64n) - 1n;

export function makeSplitMix64(seed: number): { nextU64(): bigint; nextDouble(): number } {
  let state = (BigInt(seed >>> 0) ^ 0xC5A4n) & U64; // (ulong)(uint)seed ^ 0xC5A4
  const nextU64 = (): bigint => {
    state = (state + 0x9E3779B97F4A7C15n) & U64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & U64;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & U64;
    return z ^ (z >> 31n);
  };
  const nextDouble = (): number => Number(nextU64() >> 11n) / 2 ** 53;
  return { nextU64, nextDouble };
}

/** C# Math.Round(x, 4) == banker's rounding (ToEven). The score time grid
 *  lands exactly on midpoints (k/32 s -> xxxx.5 at 1e-4), so Math.round
 *  (half away from zero) would disagree with the C# output. */
export function round4Bankers(x: number): number {
  const m = x * 10000;
  const f = Math.floor(m);
  const d = m - f;
  let r: number;
  if (d < 0.5) r = f;
  else if (d > 0.5) r = f + 1;
  else r = f % 2 === 0 ? f : f + 1;
  return r / 10000;
}

const freq = (base: number, semis: number): number => base * Math.pow(2, semis / 12);

/** Compose the arp + hats event stream exactly like C# ScoreComposer.Compose.
 *  Returns { arp, hats } separately so they can be two scripts; the RNG
 *  draw order (progression pick, then hats in b/e order) matches C#. */
export function composeArpHats(seed: number, bars = 4, bpm = 96): { arp: NoteEvent[]; hats: NoteEvent[] } {
  const rng = makeSplitMix64(seed);
  const progressions = [[0, -4, -2, 3], [0, 0, -4, -2]];
  const prog = progressions[Number(rng.nextU64() % 2n)];
  const beat = 60 / bpm;
  const bar = beat * 4;
  const arp: NoteEvent[] = [];
  const hats: NoteEvent[] = [];

  // Arp: 16ths cycling root-third-fifth-octave, two octaves up. No RNG.
  const arpShape = [0, 3, 7, 12, 7, 3];
  for (let b = 0; b < bars; b++) {
    const root = prog[b % prog.length];
    for (let s = 0; s < 16; s++) {
      const t = b * bar + (s * beat) / 4;
      const semis = root + arpShape[(s + b) % arpShape.length];
      arp.push({
        t: round4Bankers(t),
        dur: round4Bankers(beat * 0.22),
        freq: Math.round(freq(440, semis) * 100) / 100,
        kind: 'tone',
        gain: 0.08,
      });
    }
  }

  // Hats: 8th-note noise ticks, seeded accents. One RNG draw each, in order.
  for (let b = 0; b < bars; b++) {
    for (let e = 0; e < 8; e++) {
      const t = b * bar + (e * beat) / 2;
      const accent = rng.nextDouble() < 0.3;
      hats.push({
        t: round4Bankers(t),
        dur: 0.05,
        freq: 6000,
        kind: 'noise',
        gain: accent ? 0.1 : 0.05,
      });
    }
  }
  return { arp, hats };
}

// ---------- reference scripts ----------

/** Port of C# FloatScript: gentle bob + Y spin. Spawns and owns its entity. */
export const floatScript: ScriptDef = {
  name: 'float',
  start(caps) {
    caps.world.spawn('float-ember', { position: [0, 4, -2], tag: 'fx' });
    caps.world.setState('float/t0', 0);
  },
  update(caps, dt) {
    const h = caps.world.find('float-ember');
    if (!h || !h.alive) return;
    const t0 = ((caps.world.state('float/t0') as number) ?? 0) + dt;
    caps.world.setState('float/t0', t0);
    const tr = h.getTransform();
    // Bob along Y (mirrors FloatScript: sin(t0*1.7) * amp * dt * 4, amp=0.25).
    const y = tr.position[1] + Math.sin(t0 * 1.7) * 0.25 * dt * 4;
    // Spin about Y: q = q * dq, dq = (0, sin(h), 0, cos(h)), h = 0.6*dt*0.5.
    const hh = 0.6 * dt * 0.5;
    const s = Math.sin(hh), c = Math.cos(hh);
    const [x, qy, z, w] = tr.rotation;
    h.setTransform({
      position: [tr.position[0], y, tr.position[2]],
      rotation: [x * c - z * s, w * s + qy * c, x * s + z * c, w * c - qy * s],
      scale: tr.scale,
    });
  },
};

const SCORE_SEED = 20261010; // matches the committed C# score (gen/csharp-score.json)

/** Arp layer as a script: composes on start, feeds the audio sink. */
export const arpScript: ScriptDef = {
  name: 'arp',
  start(caps) {
    const { arp } = composeArpHats(SCORE_SEED);
    caps.audio.notes(arp);
    caps.world.setState('arp/count', arp.length);
  },
};

/** Hats layer as a script: composes on start, feeds the audio sink. */
export const hatsScript: ScriptDef = {
  name: 'hats',
  start(caps) {
    const { hats } = composeArpHats(SCORE_SEED);
    caps.audio.notes(hats);
    caps.world.setState('hats/count', hats.length);
  },
};

/** All reference scripts, for hosts that want the full set. */
export const referenceScripts: ScriptDef[] = [floatScript, arpScript, hatsScript];
