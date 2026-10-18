// physics/particleMesh.ts - renders a ParticleSystem as a dynamic triangle
// soup. Each particle is a small tetrahedron (4 tris, 12 verts, non-indexed)
// whose size shrinks as it dies. Dead slots collapse to a degenerate point
// far below the world so they rasterize nothing.
//
// The geometry is `dynamic`: the renderer re-uploads buffers whenever
// `version` is bumped. The demo bumps it once per frame after stepping.
import type { Geometry } from '../scene/components.js';
import { ParticleSystem } from './particles.js';

// Unit tetrahedron, outward-facing winding (verified by hand).
const TV: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1],
];
const FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2],
];
const VERTS_PER_PARTICLE = 12;
const HIDDEN_Y = -10000;

export function particleGeometry(max: number, generatedBy = 'TypeScript'): Geometry {
  const n = max * VERTS_PER_PARTICLE;
  return {
    positions: new Float32Array(n * 3),
    normals: new Float32Array(n * 3),
    uvs: new Float32Array(n * 2),
    indices: Uint32Array.from({ length: n }, (_, i) => i),
    generatedBy,
    dynamic: true,
    version: 0,
    noCull: true,
  };
}

/** Write the system's live particles into the geometry. Bump geo.version after. */
export function writeParticles(geo: Geometry, sys: ParticleSystem, size: number): void {
  const pos = geo.positions;
  const nrm = geo.normals;
  for (let i = 0; i < sys.max; i++) {
    const base = i * VERTS_PER_PARTICLE * 3;
    if (i < sys.count) {
      const px = sys.pos[i * 3], py = sys.pos[i * 3 + 1], pz = sys.pos[i * 3 + 2];
      const s = size * (0.25 + 0.75 * sys.lifeFrac(i));
      let v = 0;
      for (const [a, b, c] of FACES) {
        const ax = TV[a][0], ay = TV[a][1], az = TV[a][2];
        const bx = TV[b][0], by = TV[b][1], bz = TV[b][2];
        const cx = TV[c][0], cy = TV[c][1], cz = TV[c][2];
        // Face normal.
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        const vs: ReadonlyArray<readonly [number, number, number]> = [
          [ax, ay, az], [bx, by, bz], [cx, cy, cz],
        ];
        for (const [vx, vy, vz] of vs) {
          pos[base + v * 3] = px + vx * s;
          pos[base + v * 3 + 1] = py + vy * s;
          pos[base + v * 3 + 2] = pz + vz * s;
          nrm[base + v * 3] = nx; nrm[base + v * 3 + 1] = ny; nrm[base + v * 3 + 2] = nz;
          v++;
        }
      }
    } else {
      // Collapse dead slots to a far-below point: zero-area triangles.
      for (let v = 0; v < VERTS_PER_PARTICLE; v++) {
        pos[base + v * 3] = 0;
        pos[base + v * 3 + 1] = HIDDEN_Y;
        pos[base + v * 3 + 2] = 0;
        nrm[base + v * 3] = 0; nrm[base + v * 3 + 1] = 1; nrm[base + v * 3 + 2] = 0;
      }
    }
  }
}
