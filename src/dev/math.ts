// dev/math.ts - the write-once dev math surface.
//
// Small, pure, closed-form building blocks for game logic: no loops, no
// state, no libm transcendentals where exactness matters. Every function
// is written once and behaves identically in every language port, because
// each one is either exact arithmetic or built from the engine's
// canonical exact paths (pcgHash32, sinPoly, quinticFade in
// src/math/determinism.ts). A dev's custom formula assembled from these
// blocks runs the same everywhere, which is the polyglot promise extended
// from the engine to the games built on it.
import { pcgHash32, quinticFade, sinPoly } from '../math/determinism.js';

/** Clamp x into [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Clamp x into [0, 1]. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Linear interpolation: a at t = 0, b at t = 1. t is not clamped. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Map x from [inLo, inHi] onto [outLo, outHi], unclamped. */
export function remap(x: number, inLo: number, inHi: number, outLo: number, outHi: number): number {
  return outLo + ((x - inLo) / (inHi - inLo)) * (outHi - outLo);
}

/**
 * Quintic smoothstep between edges e0 and e1: 0 below e0, 1 above e1,
 * with zero slope at both ends (the quintic fade S(t) = 6t^5 - 15t^4 +
 * 10t^3 on the clamped parameter).
 */
export function smoothstep(e0: number, e1: number, x: number): number {
  return quinticFade(clamp01((x - e0) / (e1 - e0)));
}

/** Triangle wave on [0, len]: rises to len, falls back, period 2*len. */
export function pingpong(x: number, len: number): number {
  const period = 2 * len;
  const m = x - period * Math.floor(x / period);
  return m <= len ? m : period - m;
}

/** Inverse-quadratic falloff: 1 / (1 + d^2). 1 at d = 0, 0.5 at d = 1. */
export function invFalloff(d: number): number {
  return 1 / (1 + d * d);
}

const TWO_PI = 6.283185307179586;

/**
 * Smooth pulse in [0, 1]: 0.5 + 0.5 * sin(2 pi freq t), evaluated on the
 * canonical polynomial sine, so the waveform is bit-identical across ports
 * (libm sine is not).
 */
export function pulse(t: number, freq: number): number {
  return 0.5 + 0.5 * sinPoly(TWO_PI * freq * t);
}

/**
 * Deterministic hash of an integer into [0, 1), from the canonical PCG
 * hash: same n, same value, every run, every language. For seeded variety
 * in game logic (per-cell, per-enemy, per-day variation).
 */
export function hash01(n: number): number {
  return (pcgHash32(n) >>> 8) * 2 ** -24;
}

/** Row-major cell index: z * width + x (the grid world's layout). */
export function cellIndex(x: number, z: number, width: number): number {
  return z * width + x;
}

/** True when (x, z) names a cell inside a width x depth grid. */
export function inBounds(x: number, z: number, width: number, depth: number): boolean {
  return x >= 0 && z >= 0 && x < width && z < depth;
}
