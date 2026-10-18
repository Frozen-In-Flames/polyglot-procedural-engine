// audio/score.ts - the conductor (V8 §4).
//
// The engine does not loop a track; it performs one, continuously, from the
// game state. A small language-agnostic state vector drives per-language
// layers with per-bar crossfades. The state→gain mapping is pure functions,
// unit-testable without an AudioContext (§4.4).
//
// In First Light the hidden attunement score is HEARD: six levels add
// layers until resonance retunes every voice to a just-intonation lattice
// on the gate's root. Felt before understood - the game never names it.

import { ScorePlayer } from './driver.js';
import { MixGraph } from './graph.js';
import type { MusicDriver } from './spatial.js';

/** The game-state vector (§4.1). Games write into it through the caps
 *  (audio.mood); the engine never requires it - defaults preserve today's
 *  static behavior for existing scenes. */
export interface ConductorState {
  energy: number;     // [0,1] scene intensity
  tension: number;    // [0,1] danger / unresolvedness
  attunement: number; // [0,100] hidden score (First Light's wind attunement)
  brightness: number; // [0,1] spectral openness the game wants
  tempo: number;      // multiplier on the base bpm, [0.5, 2.0]
}

/** Attunement thresholds: six levels; the gate opens only at level 6.
 *  Mirrors First Light's ATTUNE_LEVELS (games/first-light/shared.ts) - the
 *  heard levels must sync with the game's level-ups, so this is the game's
 *  table, not the design doc's. Other games pass custom thresholds to the
 *  Conductor constructor. */
export const ATTUNE_THRESHOLDS = [12, 28, 44, 60, 74, 88];

/**
 * Attunement level 0..6: the count of thresholds reached.
 * Boundaries: 11→0, 12→1, 87→5, 88→6, 100→6.
 */
export function attunementLevel(attunement: number): number {
  return attunementLevelAt(attunement, ATTUNE_THRESHOLDS);
}

/** Level against an explicit threshold table (ascending). Pure. */
export function attunementLevelAt(attunement: number, thresholds: readonly number[]): number {
  let level = 0;
  for (const t of thresholds) {
    if (attunement >= t) level++;
    else break;
  }
  return level;
}

/** Per-language layers (§4.2). */
export type LayerName = 'foundation' | 'harmony' | 'pulse' | 'motion' | 'air' | 'song';

export const LAYER_NAMES: LayerName[] = ['foundation', 'harmony', 'pulse', 'motion', 'air', 'song'];

/** Smoothstep ramp: 0 below `a`, 1 above `b`, smooth between. No cliffs. */
export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Pure state→layer-gain mapping (§4.2, §4.4). No AudioContext needed.
 * foundation always 1 (the floor); every other layer ramps in smoothly:
 * harmony with energy > 0.15, pulse follows tension, motion ramps in with
 * energy > 0.4 (density follows energy), air ramps in with brightness > 0.5,
 * song enters with attunement > 40.
 */
export function layerGains(state: ConductorState): Record<LayerName, number> {
  return {
    foundation: 1,
    harmony: smoothstep(0.15, 0.35, state.energy),
    pulse: smoothstep(0.05, 0.5, state.tension),
    motion: smoothstep(0.4, 0.7, state.energy),
    air: smoothstep(0.5, 0.8, state.brightness),
    song: smoothstep(40, 55, state.attunement),
  };
}

/**
 * Motion-layer density 0..1 (the C# arp+hats layer thins/thickens with
 * energy past its entry point). Companion to layerGains, kept separate so
 * the gain map stays exactly the tested shape.
 */
export function motionDensity(state: ConductorState): number {
  return smoothstep(0.4, 1.0, state.energy);
}

/** Resonance: attunement at the top threshold - every layer retunes to the
 *  lattice. True iff attunement >= 88 (the last entry of ATTUNE_THRESHOLDS). */
export function resonanceActive(state: ConductorState): boolean {
  return state.attunement >= ATTUNE_THRESHOLDS[ATTUNE_THRESHOLDS.length - 1];
}

/** Resonance against an explicit threshold table (the top entry). Pure. */
export function resonanceActiveAt(state: ConductorState, thresholds: readonly number[]): boolean {
  return thresholds.length > 0 && state.attunement >= thresholds[thresholds.length - 1];
}

/** Just-intonation lattice frequencies on a root (§4.3: the world tunes itself). */
export function justLattice(rootFreq: number): number[] {
  if (!(rootFreq > 0) || !Number.isFinite(rootFreq)) {
    throw new Error('conductor: justLattice needs a positive finite root');
  }
  return [1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 15 / 8, 2].map((r) => rootFreq * r);
}

/** Conductor options. */
export interface ConductorOpts {
  /** Base tempo. Default 96. */
  bpm?: number;
  /**
   * Custom attunement thresholds (ascending). Defaults to ATTUNE_THRESHOLDS,
   * which mirrors First Light's ATTUNE_LEVELS - the heard levels must sync
   * with the game's level-ups. Other games pass their own table; resonance
   * is attunement >= the table's last entry.
   */
  thresholds?: number[];
}

function normalizeThresholds(input: number[] | undefined): number[] {
  if (input === undefined) return [...ATTUNE_THRESHOLDS];
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('conductor: thresholds must be a non-empty array');
  }
  const ts = input.map((t, i) => {
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      throw new Error(`conductor: threshold[${i}] must be a finite number`);
    }
    return t;
  });
  for (let i = 1; i < ts.length; i++) {
    if (!(ts[i] > ts[i - 1])) throw new Error('conductor: thresholds must be ascending');
  }
  return ts;
}
/** Neutral state: today's static behavior for scenes that opt out. */
export const NEUTRAL_STATE: ConductorState = Object.freeze({
  energy: 0.5, tension: 0, attunement: 0, brightness: 0.5, tempo: 1,
});

/**
 * The conductor. Owns one ScorePlayer per layer; each player's output runs
 * through a per-layer gain (the fader) into the graph's music bus.
 *
 * Timing (§9.2 recommendation): state is SAMPLED per beat, layer changes
 * are APPLIED per bar with a one-bar crossfade ramp. A layer that leaves
 * finishes its bar - gains only ever change at bar lines, never mid-bar.
 */
export class Conductor {
  private graph: MixGraph;
  private players = new Map<LayerName, ScorePlayer>();
  private faders = new Map<LayerName, GainNode>();
  private bpm: number;
  /** This conductor's attunement table (defaults to ATTUNE_THRESHOLDS). */
  private thresholds: number[];
  private acc = 0;          // accumulated engine time
  private nextBeat = 0;     // next beat-sample boundary
  private nextBar = 0;      // next bar-apply boundary
  private pending: ConductorState = { ...NEUTRAL_STATE };
  private resonating = false;
  private resonanceRoot = 0;
  private enabled = false;

  /** Last per-bar gain targets (test seam: the acceptance test asserts here). */
  readonly targets: Record<LayerName, number> = {
    foundation: 1, harmony: 0, pulse: 0, motion: 0, air: 0, song: 0,
  };

  /**
   * @param ctx  shared WebAudio context
   * @param graph the mix graph (players feed the 'music' bus via faders)
   * @param layers score docs per layer (untrusted JSON accepted - validated)
   * @param bpmOrOpts base tempo (number, legacy) or full options - bpm plus
   *   optional custom attunement thresholds for games other than First Light
   */
  constructor(
    private ctx: AudioContext,
    graph: MixGraph,
    layers: Partial<Record<LayerName, unknown>>,
    bpmOrOpts: number | ConductorOpts = 96,
  ) {
    this.graph = graph;
    const opts: ConductorOpts = typeof bpmOrOpts === 'number' ? { bpm: bpmOrOpts } : bpmOrOpts;
    this.bpm = opts.bpm !== undefined && opts.bpm > 0 ? opts.bpm : 96;
    this.thresholds = normalizeThresholds(opts.thresholds);
    const musicBus = graph.bus('music');
    for (const name of LAYER_NAMES) {
      const doc = layers[name];
      if (doc === undefined) continue;
      const fader = ctx.createGain();
      fader.gain.value = 0;
      fader.connect(musicBus);
      this.faders.set(name, fader);
      const player = new ScorePlayer(ctx, fader);
      player.load(doc);
      this.players.set(name, player);
    }
  }

  /** Start all layer players (the loop begins; faders rise on the first bar). */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      void this.ctx.resume();
      for (const p of this.players.values()) p.start();
    } else {
      for (const p of this.players.values()) p.stop();
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Per-frame host call. Samples the state vector per beat, applies layer
   * gain changes per bar (one-bar crossfade ramps), and retunes to the
   * just lattice on the gate's root while resonance holds.
   */
  update(dt: number, state: ConductorState, gateRootFreq?: number): void {
    if (!this.enabled || !(dt > 0)) return;
    const tempo = Math.max(0.5, Math.min(2, state.tempo || 1));
    const beatDur = 60 / (this.bpm * tempo);
    const barDur = beatDur * 4;
    if (this.nextBeat === 0 && this.nextBar === 0 && this.acc === 0) {
      this.nextBeat = beatDur;
      this.nextBar = barDur;
    }
    this.acc += dt;
    // Sample per beat: the freshest state waits for the next bar line.
    while (this.acc >= this.nextBeat) {
      this.pending = { ...state };
      this.nextBeat += beatDur;
    }
    // Apply per bar: gains ramp over one bar; leaving layers finish theirs.
    while (this.acc >= this.nextBar) {
      this.applyBar(this.pending, barDur, gateRootFreq);
      this.nextBar += barDur;
    }
  }

  private applyBar(state: ConductorState, barDur: number, gateRootFreq?: number): void {
    const gains = layerGains(state);
    const now = this.ctx.currentTime;
    for (const name of LAYER_NAMES) {
      this.targets[name] = gains[name];
      const fader = this.faders.get(name);
      if (fader) fader.gain.setTargetAtTime(gains[name], now, Math.max(0.05, barDur / 3));
    }
    // Resonance: retune every layer to the just lattice on the gate's root.
    // The beating between detuned voices resolves into consonance - the
    // world tunes itself when the player does. Uses this conductor's own
    // threshold table so custom games resonate on their own top level.
    const res = resonanceActiveAt(state, this.thresholds);
    const root = gateRootFreq ?? 0;
    if (res && root > 0 && (!this.resonating || root !== this.resonanceRoot)) {
      const lattice = justLattice(root);
      for (const p of this.players.values()) p.lattice = lattice;
      this.resonating = true;
      this.resonanceRoot = root;
    } else if (!res && this.resonating) {
      for (const p of this.players.values()) p.lattice = null;
      this.resonating = false;
      this.resonanceRoot = 0;
    }
  }

  /** Whether the lattice retune is currently holding. */
  get inResonance(): boolean {
    return this.resonating;
  }

  /** This conductor's attunement threshold table (a copy). */
  getThresholds(): number[] {
    return [...this.thresholds];
  }

  /** Attunement level against this conductor's own table. */
  levelOf(attunement: number): number {
    return attunementLevelAt(attunement, this.thresholds);
  }

  /** Per-layer players (read-only view; the host never touches nodes). */
  getPlayers(): ReadonlyMap<LayerName, ScorePlayer> {
    return this.players;
  }

  /**
   * Backward compatibility: a MusicDriver-shaped wrapper so old
   * update(t, energy) callers keep working. Energy maps onto the state
   * vector; everything else rests at neutral.
   */
  asMusicDriver(): MusicDriver {
    const conductor = this;
    let lastT = -1;
    return {
      languageTag: 'TypeScript (conductor)',
      update(t: number, energy: number): void {
        const dt = lastT < 0 ? 1 / 60 : Math.max(0, Math.min(0.5, t - lastT));
        lastT = t;
        conductor.update(dt, {
          energy: Math.max(0, Math.min(1, energy)),
          tension: 0, attunement: 0, brightness: 0.5, tempo: 1,
        });
      },
      setEnabled(on: boolean): void {
        conductor.setEnabled(on);
      },
    };
  }
}
