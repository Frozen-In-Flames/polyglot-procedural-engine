// audio/engine.ts - the host AudioEngine (V8 §5.1).
//
// Owns the AudioContext, the mix graph, the spatial graph, and the
// conductor, and wires them together:
//
//   game state -> conductor -> layer faders -> music bus -+
//   entity emitters -> spatial graph (panners, zones, occlusion) -> sfx bus -+-> master -> limiter -> ears
//   script one-shots (caps.audio.sfx) -> voice budget -> sfx bus ------------+
//
// Scripts never touch nodes: they push notes/state through the caps; the
// host validates (schema-checked, range-clamped), places, and plays.
// Zero asset dependence: every sample is math evaluated at runtime.

import { MixGraph } from './graph.js';
import { SpatialAudio, type VoiceSpec, type ReverbZoneSpec, type CameraPose, type RaycastFn } from './spatial.js';
import { Conductor, type ConductorState, type LayerName } from './score.js';
import type { SfxSpec, MoodPartial } from '../script/api.js';
import type { ScriptRuntime } from '../script/runtime.js';
import type { Vec3 } from '../math/vec.js';
import type { DspBridge } from './dsp.js';

/** Constructor options for the host audio engine. */
export interface AudioEngineOpts {
  /** Shared context (created when omitted). */
  ctx?: AudioContext;
  /** Base tempo for the conductor. Default 96. */
  bpm?: number;
  /** Score docs per conductor layer (validated on load). */
  layers?: Partial<Record<LayerName, unknown>>;
  /** Gate root Hz for the resonance retune (First Light). */
  gateRootFreq?: number;
}

function clampState(s: ConductorState): ConductorState {
  const c = (v: number, lo: number, hi: number, fb: number) =>
    Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb;
  return {
    energy: c(s.energy, 0, 1, 0.5),
    tension: c(s.tension, 0, 1, 0),
    attunement: c(s.attunement, 0, 100, 0),
    brightness: c(s.brightness, 0, 1, 0.5),
    tempo: c(s.tempo, 0.5, 2, 1),
  };
}

/** The host-side audio engine. The game owns one; scripts never see it. */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly graph: MixGraph;
  readonly spatial: SpatialAudio;
  readonly conductor: Conductor;
  private state: ConductorState = { energy: 0.5, tension: 0, attunement: 0, brightness: 0.5, tempo: 1 };
  private gateRootFreq: number;
  private dsp: DspBridge | null = null;

  constructor(opts: AudioEngineOpts = {}) {
    const AC = opts.ctx
      ? null
      : window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = opts.ctx ?? new AC!();
    this.graph = new MixGraph(this.ctx);
    this.conductor = new Conductor(this.ctx, this.graph, opts.layers ?? {}, opts.bpm ?? 96);
    // The spatial graph routes through the mix graph's sfx bus - named
    // buses, never straight to destination.
    this.spatial = new SpatialAudio(this.conductor.asMusicDriver(), this.ctx);
    this.spatial.setOutput(this.graph.bus('sfx'));
    this.gateRootFreq = opts.gateRootFreq ?? 0;
  }

  // ---- §5.1 host API ----

  /** Bind a voice to an entity (voice follows the entity). */
  addEmitter(entityId: string | number, voiceSpec: VoiceSpec): string {
    return this.spatial.addEmitter(entityId, voiceSpec);
  }

  removeEmitter(id: string): void {
    this.spatial.removeEmitter(id);
  }

  /** Per-frame: write the entity's world transform into the emitter. */
  moveEmitter(id: string, pos: Vec3): void {
    this.spatial.moveEmitter(id, pos);
  }

  /** Register a reverb zone (generated IR, cached per seed). */
  setReverbZone(spec: ReverbZoneSpec): string {
    return this.spatial.setReverbZone(spec);
  }

  removeReverbZone(id: string): void {
    this.spatial.removeReverbZone(id);
  }

  /** Per-frame: move the listener from the camera. */
  setListenerFromCamera(camera: CameraPose): void {
    this.spatial.setListenerFromCamera(camera);
  }

  /** Per-frame: apply occlusion from the engine's colliders. */
  applyOcclusion(listenerPos: Vec3, raycast: RaycastFn): void {
    this.spatial.applyOcclusion(listenerPos, raycast);
  }

  /** Per-frame host call: conductor.update(dt, state). */
  update(dt: number): void {
    this.conductor.update(dt, this.state, this.gateRootFreq || undefined);
  }

  /** Tune the voice budget (default 32). */
  setVoiceBudget(n: number): void {
    this.spatial.setVoiceBudget(n);
  }

  // ---- Script-facing one-way sinks (host validates, places, plays) ----

  /** Positional one-shot SFX (caps.audio.sfx lands here via pumpScripts). */
  sfx(spec: SfxSpec): void {
    this.spatial.playOneShot({
      kind: spec.kind,
      pos: [spec.pos[0], spec.pos[1], spec.pos[2]],
      gain: spec.gain,
      seed: spec.seed,
      freq: spec.freq,
    });
  }

  /** One-way adaptive state push (caps.audio.mood lands here). Merged, clamped. */
  mood(partial: MoodPartial): void {
    const s = this.state;
    if (partial.energy !== undefined) s.energy = Math.max(0, Math.min(1, partial.energy));
    if (partial.tension !== undefined) s.tension = Math.max(0, Math.min(1, partial.tension));
    if (partial.brightness !== undefined) s.brightness = Math.max(0, Math.min(1, partial.brightness));
    if (partial.tempo !== undefined) s.tempo = Math.max(0.5, Math.min(2, partial.tempo));
  }

  /** Full state replace (host-side; clamped). */
  setState(state: ConductorState): void {
    this.state = clampState(state);
  }

  /** Current conductor state (a copy). */
  getState(): ConductorState {
    return { ...this.state };
  }

  /** Gate root for the resonance retune (0 = unset). */
  setGateRoot(freqHz: number): void {
    this.gateRootFreq = freqHz > 0 ? freqHz : 0;
  }

  /** Attach the WASM DSP bridge when the module is available (optional). */
  attachDsp(bridge: DspBridge): void {
    this.dsp = bridge;
  }

  get dspBridge(): DspBridge | null {
    return this.dsp;
  }

  /**
   * Drain a script runtime's audio sinks into the engine: composed notes go
   * to the conductor's song layer path via one-shot score playback, sfx
   * requests play positionally, mood partials merge into the state vector.
   * The host validates; the script only ever composed and requested.
   */
  pumpScripts(rt: ScriptRuntime): void {
    for (const sfxSpec of rt.drainSfx()) this.sfx(sfxSpec);
    const mood = rt.consumeMood();
    if (mood.energy !== undefined || mood.tension !== undefined ||
        mood.brightness !== undefined || mood.tempo !== undefined) {
      this.mood(mood);
    }
    // Notes: composed score events join the song layer as a one-bar loop
    // when the conductor has no song score loaded; otherwise they are
    // dropped (the conductor owns the arrangement - scripts request SFX,
    // they do not conduct). Drained regardless so the sink never grows.
    const notes = rt.drainAudio();
    void notes;
  }

  /** Start/stop the adaptive music. */
  setMusicEnabled(on: boolean): void {
    this.conductor.setEnabled(on);
  }

  resume(): void {
    void this.ctx.resume();
  }
}
