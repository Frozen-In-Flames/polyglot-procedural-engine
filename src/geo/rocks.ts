// geo/rocks.ts - noise-displaced rocks, seeded scatter.
// A rock is a sphere with radial FBM displacement; normals are recomputed
// as the normalized position (exact for star-shaped rocks, cheap).
import type { Geometry } from '../scene/components.js';
import { sphere } from './parametric.js';
import { fbm2 } from './rng.js';

/** One rock: displaced sphere of `radius`, deterministic per seed. */
export function rock(seed: number, radius = 1, generatedBy = 'TypeScript'): Geometry {
  const g = sphere(radius, 14, 10, generatedBy);
  const p = g.positions;
  const ox = (seed % 1000) * 0.37;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const n = fbm2(x * 1.7 + ox, (y + z) * 1.7 - ox, seed, 3);
    const s = 0.68 + n * 0.62;
    p[i] = x * s;
    p[i + 1] = y * s * 0.78; // squashed, sits naturally
    p[i + 2] = z * s;
  }
  // Recompute normals as normalized positions.
  const nrm = g.normals;
  for (let i = 0; i < p.length; i += 3) {
    const l = Math.hypot(p[i], p[i + 1], p[i + 2]) || 1;
    nrm[i] = p[i] / l; nrm[i + 1] = p[i + 1] / l; nrm[i + 2] = p[i + 2] / l;
  }
  return g;
}

export interface ScatterOptions {
  count: number;
  area: number;      // rocks scattered in [-area, area] on x/z
  minScale: number;
  maxScale: number;
}

/** Deterministic scatter transforms (x, z, scale, rotationY). */
export function scatterRocks(seed: number, opts: ScatterOptions): Array<{
  x: number; z: number; scale: number; rotY: number; seed: number;
}> {
  let s = seed >>> 0;
  const rnd = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [];
  for (let i = 0; i < opts.count; i++) {
    out.push({
      x: (rnd() * 2 - 1) * opts.area,
      z: (rnd() * 2 - 1) * opts.area,
      scale: opts.minScale + rnd() * (opts.maxScale - opts.minScale),
      rotY: rnd() * Math.PI * 2,
      seed: seed + i * 7919,
    });
  }
  return out;
}
