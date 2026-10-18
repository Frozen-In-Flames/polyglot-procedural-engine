// audio/dsp.ts - the WASM DSP bridge (V8 §1.1).
//
// Loads the compiled DSP module (native/gen/dsp/, built from repo sources
// only) and calls the xr_dsp_* exports, wrapping returned samples in looping
// AudioBufferSourceNodes. The existing xr_dsp_voice path from
// src/bridge/wasm.ts keeps working: DspBridge wraps the same export through
// the same malloc/free discipline rather than replacing it.
//
// NOTE (Oct 13, 2026): native/gen/dsp/ has not landed yet - only the
// long-standing _xr_dsp_voice export exists in the built module. The bridge
// therefore treats every render export as optional: `available()` reports
// which exports the loaded module actually carries, render methods throw a
// clear error naming the missing export, and hosts fall back to the
// deterministic TS mirror (synth.ts) when an export is absent. No silent
// substitution, no pretending.

/** The WASM module surface the DSP bridge needs. Render exports are
 *  optional: present once native/gen/dsp/ lands, absent until then. */
export interface DspWasmModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  wasmMemory: WebAssembly.Memory;
  /** The existing seeded bass voice (kept; the bridge wraps it, unchanged). */
  _xr_dsp_voice(seed: number, n: number, sampleRate: number, outPtr: number): void;
  _xr_dsp_osc?(seed: number, n: number, rate: number, outPtr: number, wave: number, freq: number, detune: number): void;
  _xr_dsp_fm?(seed: number, n: number, rate: number, outPtr: number, carriers: number, ratiosPtr: number, indicesPtr: number): void;
  _xr_dsp_grain?(seed: number, n: number, rate: number, outPtr: number, srcLen: number, density: number): void;
  _xr_dsp_pluck?(seed: number, n: number, rate: number, outPtr: number, freq: number, decay: number): void;
  _xr_dsp_modal?(seed: number, n: number, rate: number, outPtr: number, freq: number, modes: number, decay: number): void;
  _xr_dsp_biquad?(seed: number, n: number, rate: number, outPtr: number, type: number, freq: number, q: number): void;
  _xr_dsp_ladder?(seed: number, n: number, rate: number, outPtr: number, cutoff: number, reso: number): void;
  _xr_dsp_ir?(seed: number, n: number, rate: number, outPtr: number, decay: number, damping: number): void;
}

/** Export names the bridge knows, in §1.2 order. */
export const DSP_EXPORTS = [
  'xr_dsp_osc', 'xr_dsp_fm', 'xr_dsp_grain', 'xr_dsp_pluck', 'xr_dsp_modal',
  'xr_dsp_biquad', 'xr_dsp_ladder', 'xr_dsp_ir', 'xr_dsp_voice',
] as const;

export type DspExportName = (typeof DSP_EXPORTS)[number];

/** Bridge over the compiled DSP module. */
export class DspBridge {
  private mod: DspWasmModule;

  private constructor(mod: DspWasmModule) {
    this.mod = mod;
  }

  /** Load from an emscripten MODULARIZE factory (same shape as WasmGenCore). */
  static async load(factory: () => Promise<unknown>): Promise<DspBridge> {
    const mod = (await factory()) as DspWasmModule;
    if (typeof mod._malloc !== 'function' || typeof mod._xr_dsp_voice !== 'function') {
      throw new Error('dsp: module does not expose the DSP surface (_malloc/_xr_dsp_voice)');
    }
    return new DspBridge(mod);
  }

  /** Which xr_dsp_* exports this module actually carries. */
  available(): DspExportName[] {
    return (DSP_EXPORTS as readonly string[]).filter(
      (name) => typeof (this.mod as unknown as Record<string, unknown>)['_' + name] === 'function',
    ) as DspExportName[];
  }

  /** True when the named export is callable on the loaded module. */
  has(name: DspExportName): boolean {
    return typeof (this.mod as unknown as Record<string, unknown>)['_' + name] === 'function';
  }

  private withBuffer(n: number, fn: (ptr: number) => void, out: Float32Array): void {
    const ptr = this.mod._malloc(n * 4);
    try {
      fn(ptr);
      // Fresh view each call: the buffer can move when memory grows.
      const mem = new Float32Array(this.mod.wasmMemory.buffer);
      out.set(mem.subarray(ptr >> 2, (ptr >> 2) + n));
    } finally {
      this.mod._free(ptr);
    }
  }

  private need(name: DspExportName): void {
    if (!this.has(name)) {
      throw new Error(
        `dsp: module does not export _${name} yet (native/gen/dsp/ not compiled in); ` +
        'use the synth.ts TS mirror instead',
      );
    }
  }

  // ---- The existing voice path, wrapped unchanged (bridge/wasm.ts compatible) ----

  /** The seeded bass voice, same semantics as WasmGenCore.dspVoice. */
  renderVoice(seed: number, n: number, sampleRate: number, out: Float32Array): void {
    this.withBuffer(n, (ptr) => this.mod._xr_dsp_voice(seed, n, sampleRate, ptr), out);
  }

  // ---- §1.2 render exports (optional until native/gen/dsp/ lands) ----

  renderPluck(seed: number, n: number, rate: number, freq: number, decay: number, out: Float32Array): void {
    this.need('xr_dsp_pluck');
    this.withBuffer(n, (ptr) => this.mod._xr_dsp_pluck!(seed, n, rate, ptr, freq, decay), out);
  }

  renderModal(seed: number, n: number, rate: number, freq: number, modes: number, decay: number, out: Float32Array): void {
    this.need('xr_dsp_modal');
    this.withBuffer(n, (ptr) => this.mod._xr_dsp_modal!(seed, n, rate, ptr, freq, modes, decay), out);
  }

  renderIR(seed: number, n: number, rate: number, decay: number, damping: number, out: Float32Array): void {
    this.need('xr_dsp_ir');
    this.withBuffer(n, (ptr) => this.mod._xr_dsp_ir!(seed, n, rate, ptr, decay, damping), out);
  }

  renderOsc(seed: number, n: number, rate: number, wave: number, freq: number, detune: number, out: Float32Array): void {
    this.need('xr_dsp_osc');
    this.withBuffer(n, (ptr) => this.mod._xr_dsp_osc!(seed, n, rate, ptr, wave, freq, detune), out);
  }

  // ---- Host helpers: samples -> looping buffer sources ----

  /** Wrap rendered samples in a looping AudioBufferSourceNode (music beds). */
  loopSource(ctx: BaseAudioContext, samples: Float32Array, rate?: number): AudioBufferSourceNode {
    const sr = rate ?? ctx.sampleRate;
    const buf = ctx.createBuffer(1, samples.length, sr);
    buf.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    return src;
  }

  /** Render the bass voice and return it as a looping source (one call). */
  voiceLoop(ctx: BaseAudioContext, seed: number, durSec: number): AudioBufferSourceNode {
    const n = Math.max(1, Math.floor(durSec * ctx.sampleRate));
    const samples = new Float32Array(n);
    this.renderVoice(seed, n, ctx.sampleRate, samples);
    return this.loopSource(ctx, samples);
  }
}
