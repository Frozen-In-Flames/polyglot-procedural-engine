// audio/graph.ts — the mix graph (V8 §1.1).
//
// master → music bus → sfx bus → voice buses. Every driver connects through
// named buses, never straight to the destination. Bus gains are the
// conductor's faders. One DynamicsCompressorNode sits on the master as a
// safety limiter only — not as a sound.
//
// Zero asset dependence: every sample reaching these buses is math evaluated
// at runtime (synth.ts, the DSP core, or Web Audio oscillators).

/** Named buses. 'master' is the sum; the rest are the conductor's faders. */
export type BusName = 'master' | 'music' | 'sfx' | 'voice';

const BUS_NAMES: BusName[] = ['master', 'music', 'sfx', 'voice'];

/** The mix graph: named buses into a limited master. */
export class MixGraph {
  readonly ctx: AudioContext;
  private buses = new Map<BusName, GainNode>();
  private limiter: DynamicsCompressorNode;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    // Safety limiter: brick-wall-ish, fast, transparent. It exists so a
    // hostile script (capability-closure threat model) can be annoying but
    // never clip the user's ears. Not a sound — never driven for color.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;   // dB: only catches real overs
    limiter.knee.value = 0;         // hard knee: limiter, not compressor
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    this.buses.set('master', master);
    this.limiter = limiter;
    for (const name of ['music', 'sfx', 'voice'] as const) {
      const bus = ctx.createGain();
      bus.gain.value = 1;
      bus.connect(master);
      this.buses.set(name, bus);
    }
  }

  /** The named bus node. Conductors and drivers connect here, never to destination. */
  bus(name: BusName): GainNode {
    const b = this.buses.get(name);
    if (!b) throw new Error(`audio: unknown bus '${name}'`);
    return b;
  }

  busNames(): BusName[] {
    return [...BUS_NAMES];
  }

  /**
   * Set a bus gain — the conductor's fader move. Ramps over `rampSec`
   * (default 0.05 s) so per-bar crossfades never click.
   */
  setBusGain(name: BusName, value: number, rampSec = 0.05): void {
    const b = this.bus(name);
    const v = Math.max(0, Math.min(2, value));
    b.gain.setTargetAtTime(v, this.ctx.currentTime, Math.max(0.005, rampSec / 3));
  }

  /** The safety limiter (read-only; its settings are the design). */
  getLimiter(): DynamicsCompressorNode {
    return this.limiter;
  }
}
