// audio/acoustics.ts - room acoustics derived from SDF geometry.
//
// The SDF gives volume and surface area by Monte Carlo; from those,
// Sabine and Eyring predict RT60; an FDN with Householder mixing
// synthesizes the late reverb; first-order ambisonics spatializes it.
//
// AMBISONIC CONVENTION (the one documented choice): SN3D normalization
// with ACN channel ordering (W, Y, Z, X).
//   W = 1, Y = sin(az) cos(el), Z = sin(el), X = cos(az) cos(el).
// Azimuth 0 = front (+X), azimuth +90 deg = left (+Y), elevation +90 = up.
// (FuMa uses (W,X,Y,Z) with W scaled 1/sqrt(2); we do NOT use FuMa.)
//
// All techniques are classical public mathematics; see
// docs/methods-provenance.md.

import { evalSdf, type SdfNode } from '../math/sdf.js';
import type { Pcg32 } from '../math/determinism.js';

export interface Bounds {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

/**
 * Monte Carlo volume: fraction of uniform samples with f(p) < 0,
 * times the bounding-box volume.
 */
export function estimateVolume(
  node: SdfNode, bounds: Bounds, n: number, rng: Pcg32,
): number {
  const [x0, y0, z0] = bounds.min;
  const [x1, y1, z1] = bounds.max;
  const vol = (x1 - x0) * (y1 - y0) * (z1 - z0);
  let inside = 0;
  for (let i = 0; i < n; i++) {
    const p = [
      x0 + rng.unit() * (x1 - x0),
      y0 + rng.unit() * (y1 - y0),
      z0 + rng.unit() * (z1 - z0),
    ] as [number, number, number];
    if (evalSdf(node, p).d < 0) inside++;
  }
  return (inside / n) * vol;
}

/**
 * Monte Carlo surface area via the coarea formula: the volume of the
 * h-thick shell {|f| < h/2}, divided by h, converges to the area as
 * h -> 0 (bias O(h^2) for smooth surfaces).
 */
export function estimateArea(
  node: SdfNode, bounds: Bounds, n: number, h: number, rng: Pcg32,
): number {
  const [x0, y0, z0] = bounds.min;
  const [x1, y1, z1] = bounds.max;
  const vol = (x1 - x0) * (y1 - y0) * (z1 - z0);
  let shell = 0;
  for (let i = 0; i < n; i++) {
    const p = [
      x0 + rng.unit() * (x1 - x0),
      y0 + rng.unit() * (y1 - y0),
      z0 + rng.unit() * (z1 - z0),
    ] as [number, number, number];
    if (Math.abs(evalSdf(node, p).d) < h / 2) shell++;
  }
  return ((shell / n) * vol) / h;
}

/** Sabine RT60 = 0.161 V / A (metric), A = total absorption in sabins. */
export function sabineRT60(volume: number, absorption: number): number {
  return (0.161 * volume) / absorption;
}

/** Eyring RT60 = 0.161 V / (-S ln(1 - alphaBar)). */
export function eyringRT60(volume: number, surface: number, alphaBar: number): number {
  return (0.161 * volume) / (-surface * Math.log(1 - alphaBar));
}

/**
 * Householder reflection mixing matrix: A = I - (2/n) 1 1^T.
 * Orthogonal by construction (A^T A = I); maximally diffuse.
 */
export function householderMatrix(n: number): number[][] {
  const c = 2 / n;
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0) - c));
}

/**
 * Feedback delay network with Householder mixing and coprime delays.
 * Per-sample feedback gain g = 10^(-3 * delay / (rt60 * sampleRate))
 * gives -60 dB decay per RT60 uniformly across lines.
 */
export class FeedbackDelayNetwork {
  private lines: Float64Array[];
  private pos: number[];
  private delays: number[];
  private mix: number[][];
  private gain: number[];

  constructor(delays: number[], rt60: number, sampleRate: number) {
    this.delays = [...delays];
    this.lines = delays.map(d => new Float64Array(d));
    this.pos = delays.map(() => 0);
    this.mix = householderMatrix(delays.length);
    // Gain per line so each decays 60 dB in rt60 seconds.
    this.gain = delays.map(d => Math.pow(10, (-3 * d) / (rt60 * sampleRate)));
  }

  /** Inject an impulse into the first delay line. */
  impulse(v: number): void {
    this.lines[0][this.pos[0]] += v;
  }

  /** One sample: read heads, mix, write back with gain. Returns the mean. */
  tick(): number {
    const n = this.delays.length;
    const outs = new Array(n);
    for (let i = 0; i < n; i++) outs[i] = this.lines[i][this.pos[i]];
    // y = mix * outs, then write g_i * y_i into each line.
    let mean = 0;
    for (let i = 0; i < n; i++) {
      let y = 0;
      for (let j = 0; j < n; j++) y += this.mix[i][j] * outs[j];
      this.lines[i][this.pos[i]] = this.gain[i] * y;
      this.pos[i] = (this.pos[i] + 1) % this.delays[i];
      mean += outs[i];
    }
    return mean / n;
  }
}

/**
 * First-order ambisonic encode (SN3D, ACN order (W,Y,Z,X)).
 * az: azimuth radians, 0 = front (+X), +pi/2 = left (+Y).
 * el: elevation radians, +pi/2 = up (+Z).
 */
export function encodeAmbisonic(az: number, el: number): [number, number, number, number] {
  const ce = Math.cos(el);
  return [1, Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce];
}
