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
// kinds: "tone" | "pad" | "bass" | "noise" (v1.0) plus V8 additions
// "pluck" | "ping" | "riser" | "gust" | "granular" (score schema v1.1).
// "pan" is optional (-1..1). V8 optional event fields: attack (s),
// decay (s), filterFreq (Hz), reverbSend (0..1) — all range-clamped by
// validateScore and ignored by renderers that do not understand them.

export type ScoreKind =
  | 'tone' | 'pad' | 'bass' | 'noise'
  | 'pluck' | 'ping' | 'riser' | 'gust' | 'granular';

export interface AudioEvent {
  t: number;      // seconds from loop start
  dur: number;    // seconds
  freq: number;   // Hz (ignored for noise, which uses a fixed band)
  kind: ScoreKind;
  gain: number;   // 0..1
  pan?: number;   // -1..1, optional
  attack?: number;     // seconds, 0.001..4 — envelope attack (V8)
  decay?: number;      // seconds, 0.001..8 — release tail (V8)
  filterFreq?: number; // Hz, 20..20000 — voice lowpass (V8)
  reverbSend?: number; // 0..1 — per-event reverb send (V8)
}

export interface ScoreDoc {
  generator: string;
  language: string;
  seed: number;
  loop_dur: number;
  events: AudioEvent[];
}

const KINDS: ScoreKind[] = [
  'tone', 'pad', 'bass', 'noise',
  'pluck', 'ping', 'riser', 'gust', 'granular',
];

/** Clamp an optional numeric field; undefined stays undefined. */
function optClamp(v: unknown, lo: number, hi: number): number | undefined {
  if (v === undefined) return undefined;
  if (!isNum(v)) throw new Error('score: optional audio field not a number');
  return Math.max(lo, Math.min(hi, v));
}

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
    // V8 optional fields: range-clamped, ignored by renderers that predate them.
    const attack = optClamp(ev['attack'], 0.001, 4);
    const decay = optClamp(ev['decay'], 0.001, 8);
    const filterFreq = optClamp(ev['filterFreq'], 20, 20000);
    const reverbSend = optClamp(ev['reverbSend'], 0, 1);
    if (attack !== undefined) out.attack = attack;
    if (decay !== undefined) out.decay = decay;
    if (filterFreq !== undefined) out.filterFreq = filterFreq;
    if (reverbSend !== undefined) out.reverbSend = reverbSend;
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

  /**
   * Optional just-intonation lattice (absolute Hz, ascending). When set,
   * every event's frequency snaps to the nearest lattice degree in log
   * space — this is how the conductor performs the resonance retune (§4.3).
   * Null (default) plays score frequencies as written. Additive: old
   * behavior is exactly the null case.
   */
  lattice: number[] | null = null;

  constructor(
    private ctx: AudioContext,
    private dest: AudioNode,
  ) {}

  /** Snap a frequency to the nearest lattice degree (log-domain nearest). */
  private tuneFreq(f: number): number {
    const lat = this.lattice;
    if (!lat || lat.length === 0 || f <= 0) return f;
    const lf = Math.log2(f);
    let best = lat[0];
    let bestD = Math.abs(Math.log2(lat[0]) - lf);
    for (let i = 1; i < lat.length; i++) {
      const d = Math.abs(Math.log2(lat[i]) - lf);
      if (d < bestD) { bestD = d; best = lat[i]; }
    }
    return best;
  }

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
    const freq = this.tuneFreq(e.freq);
    const attack = e.attack ?? 0.015;
    const decay = Math.min(e.decay ?? 0.06, Math.max(0.01, e.dur * 0.6));
    const peak = Math.max(0.001, e.gain);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + attack);
    g.gain.setValueAtTime(peak, when + Math.max(attack, e.dur - decay));
    g.gain.exponentialRampToValueAtTime(0.0001, when + e.dur + 0.02);
    // Optional voice lowpass (V8 field); old renderers ignore it.
    let tail: AudioNode = g;
    const wireFilter = (type: BiquadFilterType, f: number): BiquadFilterNode => {
      const flt = this.ctx.createBiquadFilter();
      flt.type = type; flt.frequency.value = f;
      flt.connect(tail); tail = flt;
      return flt;
    };
    let node: AudioScheduledSourceNode;
    switch (e.kind) {
      case 'noise':
      case 'gust':
      case 'granular': {
        const src = this.ctx.createBufferSource();
        src.buffer = this.ensureNoise();
        src.loop = true;
        const bp = this.ctx.createBiquadFilter();
        if (e.kind === 'noise') { bp.type = 'highpass'; bp.frequency.value = 5000; }
        else if (e.kind === 'gust') {
          // Swell: bandpass sweeps up through the event, gain swells mid-way.
          bp.type = 'bandpass'; bp.Q.value = 1.2;
          bp.frequency.setValueAtTime(300, when);
          bp.frequency.exponentialRampToValueAtTime(2400, when + e.dur);
        } else {
          // Granular-ish: highpassed noise chopped by a grain-rate LFO on
          // a second gain stage (approximates seeded grains at this layer;
          // true granular voices render in synth.ts / the DSP core).
          bp.type = 'highpass'; bp.frequency.value = 2500;
          const chop = this.ctx.createGain();
          const lfo = this.ctx.createOscillator();
          lfo.type = 'square'; lfo.frequency.value = 14;
          const lfoG = this.ctx.createGain(); lfoG.gain.value = 0.5;
          lfo.connect(lfoG); lfoG.connect(chop.gain);
          chop.gain.value = 0.5;
          src.connect(bp); bp.connect(chop); chop.connect(g);
          lfo.start(when); lfo.stop(when + e.dur + 0.05);
          node = src;
          break;
        }
        src.connect(bp); bp.connect(g);
        node = src;
        break;
      }
      case 'riser': {
        // FM-ish riser: sawtooth sweeping up an octave over the event.
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(freq, when);
        o.frequency.exponentialRampToValueAtTime(freq * 2, when + e.dur);
        wireFilter('lowpass', e.filterFreq ?? 4000);
        o.connect(tail);
        node = o;
        break;
      }
      default: {
        // tone | pad | bass | pluck | ping
        const o = this.ctx.createOscillator();
        if (e.kind === 'bass') o.type = 'sine';
        else if (e.kind === 'pad') o.type = 'triangle';
        else if (e.kind === 'pluck') o.type = 'triangle';
        else if (e.kind === 'ping') o.type = 'sine';
        else o.type = 'square';
        o.frequency.value = freq;
        if (e.kind === 'ping') {
          // Glassy ping: a detuned shimmer partial riding the fundamental.
          const o2 = this.ctx.createOscillator();
          o2.type = 'sine';
          o2.frequency.value = freq * 2.76;
          const g2 = this.ctx.createGain();
          g2.gain.value = 0.25;
          o2.connect(g2); g2.connect(g);
          o2.start(when); o2.stop(when + e.dur + 0.05);
        }
        const lp = e.filterFreq ?? (e.kind === 'pad' ? 1200 : e.kind === 'pluck' ? 3200 : 0);
        if (lp > 0) wireFilter('lowpass', lp);
        o.connect(tail);
        node = o;
        break;
      }
    }
    // Note: reverbSend is accepted by validateScore but not wired here —
    // ScorePlayer is the portable demo renderer; zone reverb lives in the
    // spatial graph (spatial.ts), which owns convolvers.
    if (e.pan !== undefined && Math.abs(e.pan) > 0.01 && 'createStereoPanner' in this.ctx) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = e.pan;
      tail.connect(p); p.connect(this.dest);
    } else {
      tail.connect(this.dest);
    }
    node.start(when);
    node.stop(when + e.dur + 0.05);
  }
}
