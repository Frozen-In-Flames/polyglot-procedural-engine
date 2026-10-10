// geo/sky.ts — procedural sky dome. No textures, no cubemaps: a gradient +
// hashed stars evaluated per-pixel in the 'sky' material effect.
import type { Geometry } from '../scene/components.js';
import { sphere } from './parametric.js';

/** Inverted sphere (front faces point inward) for the sky. */
export function skyDome(radius = 600, generatedBy = 'TypeScript'): Geometry {
  const g = sphere(radius, 40, 20, generatedBy);
  // Reverse triangle winding so we see the inside of the sphere.
  const idx = g.indices;
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = t;
  }
  // Normals point inward too (unused by the unlit sky material, but correct).
  for (let i = 0; i < g.normals.length; i++) g.normals[i] = -g.normals[i];
  return g;
}
