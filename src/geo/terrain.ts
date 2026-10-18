// geo/terrain.ts - heightfield terrain. The height sampler is injected so the
// C++ WASM noise core can drive it; the TS fallback noise works too.
import type { Geometry } from '../scene/components.js';

export type HeightSampler = (x: number, z: number) => number;

export interface TerrainOptions {
  size: number; // world units across
  segments: number; // grid resolution
  height: number; // vertical exaggeration
  sampler: HeightSampler; // returns [0,1]
  generatedBy?: string; // which language computed the heights
  /**
   * Wind texture (V4 step 2 - "terrain is the water"). Optional hook that
   * lets the shared wind field write its structure into the land itself:
   * a directional ripple added to heights, plus a lean applied to normals
   * along the local wind. The pattern reads on the ground the player
   * walks on, not just on particles.
   */
  shimmer?: WindShimmer;
}

/**
 * Wind-texture callbacks for a terrain build. ripple() adds a directional
 * height perturbation; leanX()/leanZ() tilt the surface normal along the
 * local wind vector (the grass-and-water lean).
 */
export interface WindShimmer {
  ripple(x: number, z: number): number;
  leanX(x: number, z: number): number;
  leanZ(x: number, z: number): number;
}

export function terrain(opts: TerrainOptions): Geometry {
  const { size, segments, height, sampler } = opts;
  const generatedBy = opts.generatedBy ?? 'TypeScript';
  const shimmer = opts.shimmer;
  const n = segments + 1;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const heights = new Float32Array(n * n);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i / segments - 0.5) * size;
      const z = (j / segments - 0.5) * size;
      let h = sampler(x, z) * height;
      // Wind texture on the water: the ripple is baked into the heights so
      // the wind's structure is literally in the ground.
      if (shimmer) h += shimmer.ripple(x, z);
      const k = j * n + i;
      heights[k] = h;
      positions[k * 3] = x;
      positions[k * 3 + 1] = h;
      positions[k * 3 + 2] = z;
      uvs[k * 2] = i / segments;
      uvs[k * 2 + 1] = j / segments;
    }
  }
  // Normals from heightfield gradients.
  const step = size / segments;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = (i / segments - 0.5) * size;
      const z = (j / segments - 0.5) * size;
      const hl = heights[j * n + Math.max(0, i - 1)];
      const hr = heights[j * n + Math.min(n - 1, i + 1)];
      const hd = heights[Math.max(0, j - 1) * n + i];
      const hu = heights[Math.min(n - 1, j + 1) * n + i];
      let nx = (hl - hr) / (2 * step);
      let nz = (hd - hu) / (2 * step);
      // Lean: tilt the normal along the local wind, like grass bent by it.
      if (shimmer) {
        nx += shimmer.leanX(x, z);
        nz += shimmer.leanZ(x, z);
      }
      const ny = 1;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l; nz /= l;
      normals[k * 3] = nx;
      normals[k * 3 + 1] = ny / l;
      normals[k * 3 + 2] = nz;
    }
  }
  const indices = new Uint32Array(segments * segments * 6);
  let t = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i, b2 = a + 1, c = a + n, d = c + 1;
      indices[t++] = a; indices[t++] = c; indices[t++] = b2;
      indices[t++] = b2; indices[t++] = c; indices[t++] = d;
    }
  }
  return { positions, normals, uvs, indices, generatedBy };
}
