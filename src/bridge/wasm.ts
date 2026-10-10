// bridge/wasm.ts — loads the C++ procedural core as WebAssembly and exposes
// it through the GenCore interface. Falls back to the TypeScript noise when
// WASM is unavailable, and says so honestly via languageTag.
import type { GenCore } from './providers.js';
import { fbm2 } from '../geo/rng.js';

interface WasmModule {
  _xr_heightfield(seed: number, w: number, h: number, features: number, octaves: number, outPtr: number): void;
  _xr_noise1d(seed: number, n: number, outPtr: number): void;
  _xr_dsp_voice(seed: number, n: number, sampleRate: number, outPtr: number): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  wasmMemory: WebAssembly.Memory;
}

// Bit-exact TS mirror of xrgen::dsp_voice (unsigned 32-bit arithmetic).
function dspHash(x: number): number {
  x >>>= 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

// Double-precision mirror of xrgen::dsp_voice. Matches the C++ to ~1e-7
// (final float32 store). Verified by /tmp/dsp-check.ts, not by inspection.
function tsDspVoice(seed: number, n: number, sampleRate: number, out: Float32Array): void {
  const scale = [55, 65.41, 73.42, 82.41, 98, 110, 130.81, 146.83];
  const noteDur = 60 / 96 / 2;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const note = Math.floor(t / noteDur);
    const h = dspHash((seed + Math.imul(note, 2654435761)) >>> 0);
    const freq = scale[h % 8];
    const nt = t - note * noteDur;
    phase += freq / sampleRate;
    const s = Math.sin(phase * 2 * Math.PI);
    const sq = Math.tanh(2.5 * s);
    const env = Math.exp(-nt * 6);
    const grit = (((h >>> 8) % 1000) / 1000) - 0.5;
    out[i] = (sq * 0.6 + s * 0.3 + grit * 0.1) * env * 0.5;
  }
}

/** TypeScript fallback: same interface, pure TS noise. */
export class TsGenCore implements GenCore {
  readonly languageTag = 'TypeScript (fallback)';
  readonly ready = true;

  heightfield(seed: number, w: number, h: number, features: number, octaves: number, out: Float32Array): void {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        out[j * w + i] = fbm2((i / (w - 1)) * features, (j / (h - 1)) * features, seed, octaves);
      }
    }
  }

  noise1D(seed: number, n: number, out: Float32Array): void {
    for (let i = 0; i < n; i++) out[i] = fbm2((i / (n - 1)) * 8, 0.37, seed, 4);
  }

  dspVoice(seed: number, n: number, sampleRate: number, out: Float32Array): void {
    tsDspVoice(seed, n, sampleRate, out);
  }
}

export class WasmGenCore implements GenCore {
  readonly languageTag = 'C++ (WASM)';
  readonly ready = true;
  private mod: WasmModule;

  private constructor(mod: WasmModule) {
    this.mod = mod;
  }

  /** Load the emscripten-built module. `factory` is the emcc MODULARIZE export. */
  static async load(factory: () => Promise<unknown>): Promise<WasmGenCore> {
    const mod = (await factory()) as WasmModule;
    return new WasmGenCore(mod);
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

  heightfield(seed: number, w: number, h: number, features: number, octaves: number, out: Float32Array): void {
    this.withBuffer(w * h, (ptr) => this.mod._xr_heightfield(seed, w, h, features, octaves, ptr), out);
  }

  noise1D(seed: number, n: number, out: Float32Array): void {
    this.withBuffer(n, (ptr) => this.mod._xr_noise1d(seed, n, ptr), out);
  }

  dspVoice(seed: number, n: number, sampleRate: number, out: Float32Array): void {
    this.withBuffer(n, (ptr) => this.mod._xr_dsp_voice(seed, n, sampleRate, ptr), out);
  }
}

/** Best available GenCore: WASM first, honest TS fallback otherwise. */
export async function createGenCore(
  wasmFactory?: () => Promise<unknown>,
): Promise<GenCore> {
  if (wasmFactory) {
    try {
      return await WasmGenCore.load(wasmFactory);
    } catch {
      // fall through to TypeScript
    }
  }
  return new TsGenCore();
}
