// audio/driver.ts — the polyglot audio contract.
//
// Every language contributes audio in the same two shapes:
//
//   Score  — a loopable list of note events (the shared JSON format).
//            Python, C#, Swift, and Kotlin compose scores; any renderer
//            can play them. The demo's ScorePlayer renders them with WebAudio.
//   Voice  — raw DSP samples rendered by a provider. C++ renders its synth
//            voice to WASM and the host loops the buffer.
//
// Score format:
//   {"generator": ..., "language": "Python", "seed": 7, "loop_dur": 10.0,
//    "events": [{"t": 0.0, "dur": 0.5, "freq": 220.0,
//                "kind": "tone", "gain": 0.2, "pan": 0}, ...]}
// kinds: "tone" | "pad" | "bass" | "noise". "pan" is optional (-1..1).

export type ScoreKind = 'tone' | 'pad' | 'bass' | 'noise';

export interface AudioEvent {
  t: number;      // seconds from loop start
  dur: number;    // seconds
  freq: number;   // Hz (ignored for noise, which uses a fixed band)
  kind: ScoreKind;
  gain: number;   // 0..1
  pan?: number;   // -1..1, optional
}

export interface ScoreDoc {
  generator: string;
  language: string;
  seed: number;
  loop_dur: number;
  events: AudioEvent[];
}

const KINDS: ScoreKind[] = ['tone', 'pad', 'bass', 'noise'];

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Validate an untrusted score document (fetched JSON). Throws on bad shape. */
export function validateScore(doc: unknown): ScoreDoc {
  if (typeof doc !== 'object' || doc === null) throw new Error('score: not an object');
  const d = doc as Record<string, unknown>;
  // Accept loop_dur (Python) and loopDur (C# camelCase JSON) alike.
  const loopDur = d['loop_dur'] ?? d['loopDur'];
  if (!isNum(loopDur) || loopDur <= 0) throw new Error('score: bad loop_dur');
  if (!Array.isArray(d['events'])) throw new Error('score: events not an array');
  const events: AudioEvent[] = d['events'].map((e, i) => {
    const ev = e as Record<string, unknown>;
    if (!isNum(ev['t']) || !isNum(ev['dur']) || !isNum(ev['freq']) || !isNum(ev['gain'])) {
      throw new Error(`score: event ${i} has non-numeric fields`);
    }
    if (ev['dur'] <= 0 || ev['freq'] <= 0 || ev['gain'] < 0 || ev['gain'] > 1) {
      throw new Error(`score: event ${i} out of range`);
    }
    if (typeof ev['kind'] !== 'string' || !KINDS.includes(ev['kind'] as ScoreKind)) {
      throw new Error(`score: event ${i} bad kind`);
    }
    const out: AudioEvent = {
      t: ev['t'], dur: ev['dur'], freq: ev['freq'],
      kind: ev['kind'] as ScoreKind, gain: ev['gain'],
    };
    if (isNum(ev['pan'])) out.pan = Math.max(-1, Math.min(1, ev['pan']));
    return out;
  });
  return {
    generator: String(d['generator'] ?? 'unknown'),
    language: String(d['language'] ?? 'unknown'),
    seed: isNum(d['seed']) ? d['seed'] : 0,
    loop_dur: loopDur,
    events,
  };
}

/** Renders a ScoreDoc on WebAudio with a lookahead scheduler. Loops forever. */
export class ScorePlayer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private score: ScoreDoc | null = null;
  private loopStartCtx = 0;
  private nextLoop = 0;
  private noiseBuf: AudioBuffer | null = null;

  constructor(
    private ctx: AudioContext,
    private dest: AudioNode,
  ) {}

  load(doc: unknown): void {
    this.score = validateScore(doc);
  }

  get loaded(): boolean {
    return this.score !== null;
  }

  get languageTag(): string {
    return this.score?.language ?? 'none';
  }

  start(): void {
    if (!this.score || this.timer) return;
    this.loopStartCtx = this.ctx.currentTime + 0.1;
    this.nextLoop = 0;
    this.timer = setInterval(() => this.pump(), 100);
    this.pump();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

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

  private pump(): void {
    const score = this.score;
    if (!score) return;
    // Schedule loops up to 0.4 s ahead.
    while (this.loopStartCtx + this.nextLoop * score.loop_dur < this.ctx.currentTime + 0.4) {
      const base = this.loopStartCtx + this.nextLoop * score.loop_dur;
      for (const e of score.events) this.schedule(e, base + e.t);
      this.nextLoop++;
    }
  }

  private schedule(e: AudioEvent, when: number): void {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, e.gain), when + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, when + e.dur);
    let node: AudioScheduledSourceNode;
    if (e.kind === 'noise') {
      const src = this.ctx.createBufferSource();
      src.buffer = this.ensureNoise();
      src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = 5000;
      src.connect(f); f.connect(g);
      node = src;
    } else {
      const o = this.ctx.createOscillator();
      o.type = e.kind === 'bass' ? 'sine' : e.kind === 'pad' ? 'triangle' : 'square';
      o.frequency.value = e.freq;
      if (e.kind === 'pad') {
        const f = this.ctx.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = 1200;
        o.connect(f); f.connect(g);
      } else {
        o.connect(g);
      }
      node = o;
    }
    if (e.pan !== undefined && Math.abs(e.pan) > 0.01 && 'createStereoPanner' in this.ctx) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = e.pan;
      g.connect(p); p.connect(this.dest);
    } else {
      g.connect(this.dest);
    }
    node.start(when);
    node.stop(when + e.dur + 0.05);
  }
}
