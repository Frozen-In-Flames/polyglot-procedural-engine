// audio/foundry.ts - host-only loader for offline-baked audio JSON bundles.
//
// Two-sided design (INVERSE.md): the foundry (python/xrgen/audio_foundry.py)
// may use anything once, offline; its output is a plain JSON parameter
// bundle; the runtime evaluates the bundle with the same zero-dependency
// engine. This module only parses and validates bundles - never in the hot
// path. IRs are generated at load from the bundle's seeds via synth.ts,
// never recorded.

/** Generated-IR parameter set: a reverb tail described, not recorded. */
export interface FoundryIRParams {
  /** Stable name for cache keys and logs. */
  name: string;
  /** Seed for renderIR - same seed, same tail, every run. */
  seed: number;
  /** Tail length seconds (cap 1.5 per the V8 design). */
  lenSec: number;
  /** Exponential decay rate per second. */
  decay: number;
  /** Progressive lowpass damping 0..1. */
  damping: number;
  /** Wet mix 0..1 the zone should use. */
  wet: number;
}

/** Seeded granular-bed texture parameters (wind / water / breath). */
export interface FoundryTextureParams {
  name: string;
  seed: number;
  kind: 'wind' | 'water' | 'breath';
  /** Texture length seconds (2–4 s per the V8 design). */
  durSec: number;
  /** Grain density 0..1. */
  density: number;
  /** Spectral brightness 0..1. */
  brightness: number;
}

/** An offline-baked audio bundle: plain JSON, evaluated by the runtime. */
export interface AudioBundle {
  name: string;
  version: number;
  irs: FoundryIRParams[];
  textures: FoundryTextureParams[];
}

const TEXTURE_KINDS = ['wind', 'water', 'breath'] as const;

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function num(v: unknown, what: string): number {
  if (!isNum(v)) throw new Error(`foundry: bundle '${what}' must be a finite number`);
  return v;
}

function range(v: unknown, lo: number, hi: number, what: string): number {
  const n = num(v, what);
  if (n < lo || n > hi) throw new Error(`foundry: bundle '${what}' out of range [${lo}, ${hi}]`);
  return n;
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`foundry: bundle '${what}' must be a non-empty string`);
  return v;
}

function parseIR(e: unknown, i: number): FoundryIRParams {
  if (typeof e !== 'object' || e === null) throw new Error(`foundry: irs[${i}] must be an object`);
  const d = e as Record<string, unknown>;
  return {
    name: str(d.name, `irs[${i}].name`),
    seed: num(d.seed, `irs[${i}].seed`) >>> 0,
    lenSec: range(d.lenSec, 0.05, 1.5, `irs[${i}].lenSec`),
    decay: range(d.decay, 0.1, 40, `irs[${i}].decay`),
    damping: range(d.damping, 0, 1, `irs[${i}].damping`),
    wet: range(d.wet, 0, 1, `irs[${i}].wet`),
  };
}

function parseTexture(e: unknown, i: number): FoundryTextureParams {
  if (typeof e !== 'object' || e === null) throw new Error(`foundry: textures[${i}] must be an object`);
  const d = e as Record<string, unknown>;
  const kind = d.kind;
  if (typeof kind !== 'string' || !(TEXTURE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`foundry: textures[${i}].kind must be wind|water|breath`);
  }
  return {
    name: str(d.name, `textures[${i}].name`),
    seed: num(d.seed, `textures[${i}].seed`) >>> 0,
    kind: kind as FoundryTextureParams['kind'],
    durSec: range(d.durSec, 0.5, 8, `textures[${i}].durSec`),
    density: range(d.density, 0, 1, `textures[${i}].density`),
    brightness: range(d.brightness, 0, 1, `textures[${i}].brightness`),
  };
}

/**
 * Parse and validate an offline-baked audio bundle from untrusted JSON.
 * Throws loudly on malformed bundles - a bad bundle never reaches the graph.
 */
export function parseAudioBundle(json: unknown): AudioBundle {
  if (typeof json !== 'object' || json === null) {
    throw new Error('foundry: bundle must be an object');
  }
  const d = json as Record<string, unknown>;
  if (!Array.isArray(d.irs)) throw new Error('foundry: bundle needs an irs array');
  if (!Array.isArray(d.textures)) throw new Error('foundry: bundle needs a textures array');
  const seen = new Set<string>();
  const irs = (d.irs as unknown[]).map((e, i) => {
    const ir = parseIR(e, i);
    if (seen.has(ir.name)) throw new Error(`foundry: duplicate IR name '${ir.name}'`);
    seen.add(ir.name);
    return ir;
  });
  const textures = (d.textures as unknown[]).map((e, i) => {
    const t = parseTexture(e, i);
    if (seen.has(t.name)) throw new Error(`foundry: duplicate texture name '${t.name}'`);
    seen.add(t.name);
    return t;
  });
  return {
    name: str(d.name, 'name'),
    version: Math.max(1, Math.floor(num(d.version ?? 1, 'version'))),
    irs,
    textures,
  };
}

/** Alias: "load" reads the same way - the bundle is plain JSON either way. */
export const loadAudioBundle = parseAudioBundle;

/** Find an IR parameter set by name (undefined when absent). */
export function bundleIR(bundle: AudioBundle, name: string): FoundryIRParams | undefined {
  return bundle.irs.find((ir) => ir.name === name);
}

/** Find a texture parameter set by name (undefined when absent). */
export function bundleTexture(bundle: AudioBundle, name: string): FoundryTextureParams | undefined {
  return bundle.textures.find((t) => t.name === name);
}
