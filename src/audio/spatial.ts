// audio/spatial.ts - WebAudio spatial graph, synthesized SFX (no audio files),
// and the seam for the procedural music engine (pmve).
//
// V8 extensions (additive): emitter registry (voices bound to entities),
// reverb zones (generated IRs, cached per seed), occlusion from a
// host-supplied raycast (no new physics deps), and a 32-voice budget with
// (loudness x proximity) priority stealing. Zero asset dependence throughout.
import type { Vec3 } from '../math/vec.js';
import { renderSfx, renderIR, type SfxVoiceKind } from './synth.js';

/** Generative music driver seam. The pmve package implements this post-v1;
 *  v1 ships a tiny built-in driver so the demo has sound. */
export interface MusicDriver {
  readonly languageTag: string;
  /** Called per frame; energy in [0,1] reflects scene intensity. */
  update(t: number, energy: number): void;
  setEnabled(on: boolean): void;
}

/** Minimal built-in driver: slow evolving pad from detuned saws + filter.
 *  Everything synthesized; replaces the pmve driver until it lands. */
export class BuiltinPadDriver implements MusicDriver {
  readonly languageTag = 'TypeScript (builtin pad)';
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private oscs: OscillatorNode[] = [];
  private filter: BiquadFilterNode | null = null;
  private enabled = false;
  private lastChord = -1;

  private ensure(): void {
    if (this.ctx) return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.0;
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 900;
    this.filter.connect(this.master);
    this.master.connect(this.ctx.destination);
    // A minor-ish pad: root + fifth + ninth, detuned pairs.
    const freqs = [110, 110 * 1.005, 164.81, 165.2, 246.94, 247.5];
    for (const f of freqs) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.value = 0.05;
      o.connect(g); g.connect(this.filter);
      o.start();
      this.oscs.push(o);
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) {
      this.ensure();
      void this.ctx?.resume();
      this.master?.gain.setTargetAtTime(0.5, this.ctx!.currentTime, 1.5);
    } else {
      if (this.ctx && this.master) {
        this.master.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.4);
      }
    }
  }

  update(t: number, energy: number): void {
    if (!this.enabled || !this.ctx || !this.filter || !this.master) return;
    // Slow chord drift: retune the root every 16 s through a small progression.
    const step = Math.floor(t / 16) % 4;
    if (step !== this.lastChord) {
      this.lastChord = step;
      const roots = [110, 87.31, 98, 130.81]; // A2 F2 G2 C3
      const now = this.ctx.currentTime;
      this.oscs[0].frequency.setTargetAtTime(roots[step], now, 2);
      this.oscs[1].frequency.setTargetAtTime(roots[step] * 1.005, now, 2);
    }
    this.filter.frequency.setTargetAtTime(500 + energy * 2200, this.ctx.currentTime, 0.5);
  }
}

/** Voice kinds an emitter can carry. Pitched SFX render via synth.ts. */
export type EmitterVoiceKind = SfxVoiceKind | 'tone' | 'noise';

/** What voice an emitter carries. The host places; scripts only request. */
export interface VoiceSpec {
  kind: EmitterVoiceKind;
  freq?: number;   // Hz for pitched voices (default 440)
  gain?: number;   // 0..1 (default 0.5)
  seed?: number;   // determinism seed (default 1)
  loop?: boolean;  // loop the voice (default true for emitters)
  distanceModel?: 'inverse' | 'linear' | 'exponential';
}

/** A reverb zone: a volume carrying a reverb seed (§3.2). */
export interface ReverbZoneSpec {
  center: Vec3;
  radius: number;  // world units, > 0
  seed: number;    // IR seed - generated once per seed, convolved forever
  decay: number;   // exponential decay rate per second, > 0
  damping: number; // progressive lowpass damping 0..1
  wet: number;     // zone return wet mix 0..1
}

/** Host-supplied occlusion query: 0 = open air, 1 = fully blocked. */
export type RaycastFn = (from: Vec3, to: Vec3) => number;

/** Minimal camera pose for the listener. */
export interface CameraPose {
  position: Vec3;
  forward: Vec3;
  up: Vec3;
}

/** One-shot SFX request (host side; scripts go through caps.audio.sfx). */
export interface OneShotSpec {
  kind: SfxVoiceKind;
  pos: Vec3;
  gain: number;   // 0..1
  seed?: number;
  freq?: number;
}

interface Emitter {
  id: string;
  entityId: string | number;
  pos: Vec3;
  baseGain: number;
  source: AudioScheduledSourceNode;
  voiceGain: GainNode;
  occFilter: BiquadFilterNode;
  occDip: GainNode;
  panner: PannerNode;
  sends: Map<string, GainNode>; // per-zone reverb sends
}

interface ActiveVoice {
  stop: () => void;
  priority: number;
}

function dist3(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class SpatialAudio {
  private ctx: AudioContext;
  private master: GainNode;
  private listener: AudioListener;
  private listenerPos: Vec3 = [0, 0, 0];
  music: MusicDriver;

  // ---- V8 state ----
  private emitters = new Map<string, Emitter>();
  private zones = new Map<string, { spec: ReverbZoneSpec; convolver: ConvolverNode; wet: GainNode }>();
  private irCache = new Map<string, AudioBuffer>();
  private nextEmitter = 1;
  private nextZone = 1;
  private noiseBuf: AudioBuffer | null = null;
  private voiceBudget = 32;
  private activeVoices = new Map<string, ActiveVoice>();
  private nextVoice = 1;

  constructor(music: MusicDriver = new BuiltinPadDriver(), ctx?: AudioContext) {
    if (ctx) {
      this.ctx = ctx;
    } else {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    this.listener = this.ctx.listener;
    this.music = music;
  }

  resume(): void {
    void this.ctx.resume();
  }

  /** The shared WebAudio context, so every language's audio renders together. */
  getContext(): AudioContext {
    return this.ctx;
  }

  /** The master bus every driver connects through. */
  getDestination(): AudioNode {
    return this.master;
  }

  /**
   * Reroute this graph's output into a mix-graph bus (V8). Default is the
   * context destination (standalone behavior, unchanged).
   */
  setOutput(node: AudioNode): void {
    this.master.disconnect();
    this.master.connect(node);
  }

  /** Move the listener (usually the camera). */
  setListener(pos: Vec3, fwd: Vec3, up: Vec3): void {
    this.listenerPos = [pos[0], pos[1], pos[2]];
    const t = this.ctx.currentTime;
    this.listener.positionX.setTargetAtTime(pos[0], t, 0.05);
    this.listener.positionY.setTargetAtTime(pos[1], t, 0.05);
    this.listener.positionZ.setTargetAtTime(pos[2], t, 0.05);
    this.listener.forwardX.setTargetAtTime(fwd[0], t, 0.05);
    this.listener.forwardY.setTargetAtTime(fwd[1], t, 0.05);
    this.listener.forwardZ.setTargetAtTime(fwd[2], t, 0.05);
    this.listener.upX.setTargetAtTime(up[0], t, 0.05);
    this.listener.upY.setTargetAtTime(up[1], t, 0.05);
    this.listener.upZ.setTargetAtTime(up[2], t, 0.05);
  }

  /** Move the listener from a camera pose (per frame). */
  setListenerFromCamera(camera: CameraPose): void {
    this.setListener(camera.position, camera.forward, camera.up);
  }

  /** Synthesized blip at a world position. No audio files. */
  blip(pos: Vec3, freq = 660, dur = 0.15): void {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.5, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.positionX.setValueAtTime(pos[0], t);
    p.positionY.setValueAtTime(pos[1], t);
    p.positionZ.setValueAtTime(pos[2], t);
    o.connect(g); g.connect(p); p.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // ------------------------------------------------------------------
  // V8: emitter registry (§3.1). Emitters bind a voice to an entity; the
  // host moves them per frame. Created/destroyed through the host API -
  // scripts request via caps.audio.sfx, the host places.
  // ------------------------------------------------------------------

  private ensureNoise(): AudioBuffer {
    if (!this.noiseBuf) {
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      let s = 0x12345678;
      for (let i = 0; i < len; i++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        d[i] = ((s >>> 0) % 2000) / 1000 - 1;
      }
    }
    return this.noiseBuf;
  }

  /** Bind a voice to an entity. Returns the emitter id. */
  addEmitter(entityId: string | number, voiceSpec: VoiceSpec): string {
    const id = `emitter-${this.nextEmitter++}`;
    const kind = voiceSpec.kind;
    const freq = voiceSpec.freq ?? 440;
    const gain = Math.max(0, Math.min(1, voiceSpec.gain ?? 0.5));
    const seed = (voiceSpec.seed ?? 1) >>> 0;
    const loop = voiceSpec.loop ?? true;

    const voiceGain = this.ctx.createGain();
    voiceGain.gain.value = gain;
    const occFilter = this.ctx.createBiquadFilter();
    occFilter.type = 'lowpass';
    occFilter.frequency.value = 20000; // open air
    const occDip = this.ctx.createGain();
    occDip.gain.value = 1;
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = voiceSpec.distanceModel ?? 'inverse';

    voiceGain.connect(occFilter);
    occFilter.connect(occDip);
    occDip.connect(panner);
    panner.connect(this.master);

    let source: AudioScheduledSourceNode;
    if (kind === 'tone') {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      o.connect(voiceGain);
      o.start();
      source = o;
    } else if (kind === 'noise') {
      const s = this.ctx.createBufferSource();
      s.buffer = this.ensureNoise();
      s.loop = true;
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 4000;
      s.connect(hp); hp.connect(voiceGain);
      s.start();
      source = s;
    } else {
      // pluck | ping | riser | gust: rendered by the TS DSP mirror, seeded.
      const data = renderSfx(kind, this.ctx.sampleRate, { seed, freq });
      const buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
      buf.getChannelData(0).set(data);
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.loop = loop;
      s.connect(voiceGain);
      s.start();
      source = s;
    }

    const emitter: Emitter = {
      id, entityId, pos: [0, 0, 0], baseGain: gain,
      source, voiceGain, occFilter, occDip, panner,
      sends: new Map(),
    };
    // Wire per-zone reverb sends (start dry; moveEmitter ramps on entry).
    for (const [zoneId, zone] of this.zones) {
      const send = this.ctx.createGain();
      send.gain.value = 0;
      occDip.connect(send);
      send.connect(zone.convolver);
      emitter.sends.set(zoneId, send);
    }
    this.emitters.set(id, emitter);
    return id;
  }

  /** Destroy an emitter and release its voice. */
  removeEmitter(id: string): void {
    const e = this.emitters.get(id);
    if (!e) return;
    try { e.source.stop(); } catch { /* already stopped */ }
    e.panner.disconnect();
    for (const send of e.sends.values()) send.disconnect();
    this.emitters.delete(id);
  }

  /** Per-frame: write the entity's world transform into the panner. */
  moveEmitter(id: string, pos: Vec3): void {
    const e = this.emitters.get(id);
    if (!e) return;
    e.pos = [pos[0], pos[1], pos[2]];
    const t = this.ctx.currentTime;
    e.panner.positionX.setTargetAtTime(pos[0], t, 0.03);
    e.panner.positionY.setTargetAtTime(pos[1], t, 0.03);
    e.panner.positionZ.setTargetAtTime(pos[2], t, 0.03);
    // Zone membership: ramp the per-zone send over ~0.5 s at boundaries.
    for (const [zoneId, zone] of this.zones) {
      const send = e.sends.get(zoneId);
      if (!send) continue;
      const inside = dist3(pos, zone.spec.center) <= zone.spec.radius ? 1 : 0;
      send.gain.setTargetAtTime(inside, t, 0.167); // ~0.5 s crossfade
    }
  }

  /** Emitter ids currently registered (test seam). */
  emitterIds(): string[] {
    return [...this.emitters.keys()];
  }

  // ------------------------------------------------------------------
  // V8: reverb zones (§3.2). Zones carry a reverb seed; the IR is generated
  // once per seed via synth.renderIR and cached - generating once,
  // convolving forever. Zone boundaries crossfade over ~0.5 s.
  // ------------------------------------------------------------------

  /** Register a reverb zone. Returns the zone id. */
  setReverbZone(spec: ReverbZoneSpec): string {
    if (!(spec.radius > 0)) throw new Error('audio: reverb zone radius must be positive');
    if (!(spec.decay > 0)) throw new Error('audio: reverb zone decay must be positive');
    const wet = Math.max(0, Math.min(1, spec.wet));
    const damping = Math.max(0, Math.min(1, spec.damping));
    const id = `zone-${this.nextZone++}`;
    const convolver = this.ctx.createConvolver();
    convolver.buffer = this.irFor(spec.seed >>> 0, spec.decay, damping);
    const wetGain = this.ctx.createGain();
    wetGain.gain.value = wet;
    convolver.connect(wetGain);
    wetGain.connect(this.master);
    const full: ReverbZoneSpec = {
      center: [spec.center[0], spec.center[1], spec.center[2]],
      radius: spec.radius, seed: spec.seed >>> 0,
      decay: spec.decay, damping, wet,
    };
    this.zones.set(id, { spec: full, convolver, wet: wetGain });
    // Existing emitters get a (dry-starting) send into the new zone.
    for (const e of this.emitters.values()) {
      const send = this.ctx.createGain();
      send.gain.value = 0;
      e.occDip.connect(send);
      send.connect(convolver);
      e.sends.set(id, send);
    }
    return id;
  }

  /** Remove a reverb zone. */
  removeReverbZone(id: string): void {
    const z = this.zones.get(id);
    if (!z) return;
    z.convolver.disconnect();
    z.wet.disconnect();
    for (const e of this.emitters.values()) {
      const send = e.sends.get(id);
      if (send) { send.disconnect(); e.sends.delete(id); }
    }
    this.zones.delete(id);
  }

  /** Generated IR, cached per seed (IR length capped at 1.5 s per §9 Q3). */
  private irFor(seed: number, decay: number, damping: number): AudioBuffer {
    const key = `${seed}:${decay.toFixed(4)}:${damping.toFixed(4)}`;
    const hit = this.irCache.get(key);
    if (hit) return hit;
    const rate = this.ctx.sampleRate;
    const lenSec = Math.max(0.2, Math.min(1.5, 3 / decay));
    const data = renderIR(seed, lenSec, rate, decay, damping);
    const buf = this.ctx.createBuffer(1, data.length, rate);
    buf.getChannelData(0).set(data);
    this.irCache.set(key, buf);
    return buf;
  }

  // ------------------------------------------------------------------
  // V8: occlusion (§3.3). The raycast is supplied by the host (the engine's
  // existing colliders) - no new physics, no new deps.
  // ------------------------------------------------------------------

  /**
   * Occlusion factor in [0,1] for an emitter→listener ray. Pure function of
   * the host's raycast answer (0 = open, 1 = fully blocked), clamped.
   */
  occlusionFactor(emitterPos: Vec3, listenerPos: Vec3, raycast: RaycastFn): number {
    const raw = raycast(emitterPos, listenerPos);
    if (!Number.isFinite(raw)) return 0;
    return Math.max(0, Math.min(1, raw));
  }

  /**
   * Per-frame: apply occlusion to every emitter - lowpass 20 kHz → ~400 Hz
   * plus a gain dip. Walls muffle.
   */
  applyOcclusion(listenerPos: Vec3, raycast: RaycastFn): void {
    const t = this.ctx.currentTime;
    for (const e of this.emitters.values()) {
      const occ = this.occlusionFactor(e.pos, listenerPos, raycast);
      const fc = 20000 * Math.pow(400 / 20000, occ); // log sweep 20k -> 400
      e.occFilter.frequency.setTargetAtTime(fc, t, 0.05);
      e.occDip.gain.setTargetAtTime(1 - 0.5 * occ, t, 0.05);
    }
  }

  // ------------------------------------------------------------------
  // V8: voice budget (§3.1). 32 concurrent one-shot voices, priority-stolen
  // by (loudness x proximity). Documented, tunable via setVoiceBudget.
  // ------------------------------------------------------------------

  /** Set the concurrent one-shot voice budget (default 32). */
  setVoiceBudget(n: number): void {
    const v = Math.floor(n);
    if (!(v >= 1)) throw new Error('audio: voice budget must be >= 1');
    this.voiceBudget = v;
  }

  getVoiceBudget(): number {
    return this.voiceBudget;
  }

  /**
   * Play a positional one-shot SFX through the voice budget. When the
   * budget is full, the quietest-and-farthest voice is stolen.
   */
  playOneShot(spec: OneShotSpec): string {
    const id = `voice-${this.nextVoice++}`;
    const gain = Math.max(0, Math.min(1, spec.gain));
    const data = renderSfx(spec.kind, this.ctx.sampleRate, {
      seed: (spec.seed ?? 1) >>> 0,
      freq: spec.freq ?? 440,
    });
    const t = this.ctx.currentTime;
    const buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
    buf.getChannelData(0).set(data);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.positionX.setValueAtTime(spec.pos[0], t);
    p.positionY.setValueAtTime(spec.pos[1], t);
    p.positionZ.setValueAtTime(spec.pos[2], t);
    src.connect(g); g.connect(p); p.connect(this.master);
    const dist = dist3(spec.pos, this.listenerPos);
    const priority = gain * (1 / (1 + dist)); // loudness x proximity
    // Steal when over budget: drop the lowest-priority active voice.
    while (this.activeVoices.size >= this.voiceBudget) {
      let worstId: string | null = null;
      let worst = Infinity;
      for (const [vid, v] of this.activeVoices) {
        if (v.priority < worst) { worst = v.priority; worstId = vid; }
      }
      if (worstId === null || worst >= priority) break;
      this.activeVoices.get(worstId)?.stop();
      this.activeVoices.delete(worstId);
    }
    const rec: ActiveVoice = {
      priority,
      stop: () => { try { src.stop(); } catch { /* done */ } },
    };
    this.activeVoices.set(id, rec);
    src.onended = () => {
      if (this.activeVoices.get(id) === rec) this.activeVoices.delete(id);
      src.disconnect(); g.disconnect(); p.disconnect();
    };
    src.start(t);
    return id;
  }

  /** Stop a one-shot voice early (no-op when already finished). */
  stopVoice(id: string): void {
    const v = this.activeVoices.get(id);
    if (v) { v.stop(); this.activeVoices.delete(id); }
  }

  /** Active one-shot voice count (test seam). */
  activeVoiceCount(): number {
    return this.activeVoices.size;
  }
}
