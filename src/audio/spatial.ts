// audio/spatial.ts — WebAudio spatial graph, synthesized SFX (no audio files),
// and the seam for the procedural music engine (pmve).
import type { Vec3 } from '../math/vec.js';

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

export class SpatialAudio {
  private ctx: AudioContext;
  private master: GainNode;
  private listener: AudioListener;
  music: MusicDriver;

  constructor(music: MusicDriver = new BuiltinPadDriver()) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
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

  /** Move the listener (usually the camera). */
  setListener(pos: Vec3, fwd: Vec3, up: Vec3): void {
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
}
