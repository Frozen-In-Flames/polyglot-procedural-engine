// script/bodies.ts — engine-side construction of spawned bodies.
//
// A SpawnBody is a script-authored DESCRIPTOR (plain JSON, validated at the
// boundary). This module turns it into a real Geometry + Material on the
// engine side of the wall. Scripts never touch builders, geometries, or
// materials directly — they only describe what they want spawned.
//
// Everything here is procedural: parametric surfaces and explicit triangle
// lists. Zero asset files, per the engine's standing law.

import type { Geometry, Material } from '../scene/components.js';
import { parametric, sphere, torus } from '../geo/parametric.js';
import { buildMaterial } from '../material/shader.js';
import type { SpawnBody } from './api.js';
import { sanitizeBody } from './sandbox.js';

/** Build an axis-aligned box centered on the origin from half-extents. */
function boxGeometry(hx: number, hy: number, hz: number): Geometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  // 6 faces: +x, -x, +y, -y, +z, -z. Each face is a quad -> 2 triangles.
  const faces: Array<{ n: [number, number, number]; corners: Array<[number, number, number]> }> = [
    { n: [1, 0, 0], corners: [[hx, -hy, -hz], [hx, -hy, hz], [hx, hy, hz], [hx, hy, -hz]] },
    { n: [-1, 0, 0], corners: [[-hx, -hy, hz], [-hx, -hy, -hz], [-hx, hy, -hz], [-hx, hy, hz]] },
    { n: [0, 1, 0], corners: [[-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, -1, 0], corners: [[-hx, -hy, hz], [hx, -hy, hz], [hx, -hy, -hz], [-hx, -hy, -hz]] },
    { n: [0, 0, 1], corners: [[-hx, -hy, hz], [-hx, hy, hz], [hx, hy, hz], [hx, -hy, hz]] },
    { n: [0, 0, -1], corners: [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]] },
  ];
  for (const f of faces) {
    const base = positions.length / 3;
    const quadUV: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let i = 0; i < 4; i++) {
      positions.push(...f.corners[i]);
      normals.push(...f.n);
      uvs.push(...quadUV[i]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    generatedBy: 'TypeScript',
  };
}

/** Regular octahedron centered on the origin, circumradius r. */
function octahedronGeometry(r: number): Geometry {
  const v: Array<[number, number, number]> = [
    [r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r],
  ];
  // 8 faces, CCW from outside.
  const faces: Array<[number, number, number]> = [
    [0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0],
    [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const [a, b, c] of faces) {
    const base = positions.length / 3;
    const pa = v[a], pb = v[b], pc = v[c];
    // Face normal from the winding.
    const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
    const wx = pc[0] - pa[0], wy = pc[1] - pa[1], wz = pc[2] - pa[2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    for (const p of [pa, pb, pc]) {
      positions.push(...p);
      normals.push(nx, ny, nz);
      uvs.push(0.5, 0.5);
    }
    indices.push(base, base + 1, base + 2);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    generatedBy: 'TypeScript',
  };
}

/** Turn a validated body descriptor into engine-side geometry + material. */
export function buildBody(body: SpawnBody): { geometry: Geometry; material: Material } {
  const clean = sanitizeBody(body);
  const g = clean.geometry;
  const detail = Math.max(3, Math.min(64, Math.round(g.detail ?? 12)));
  let geometry: Geometry;
  switch (g.kind) {
    case 'sphere':
      geometry = sphere(Math.max(0.01, g.radius ?? 0.5), detail, Math.max(3, detail >> 1));
      break;
    case 'torus':
      geometry = torus(
        Math.max(0.05, g.radius ?? 1),
        Math.max(0.01, g.tube ?? 0.2),
        detail * 2, Math.max(4, detail),
      );
      break;
    case 'box': {
      const s = g.size ?? [1, 1, 1];
      geometry = boxGeometry(
        Math.max(0.01, s[0] / 2), Math.max(0.01, s[1] / 2), Math.max(0.01, s[2] / 2));
      break;
    }
    case 'cone': {
      const r = Math.max(0.01, g.radius ?? 0.5);
      const h = Math.max(0.01, (g.size?.[1] ?? 1));
      const seg = Math.max(5, detail);
      geometry = parametric((u, vv) => {
        const theta = u * Math.PI * 2;
        const rr = r * (1 - vv);
        return [rr * Math.cos(theta), vv * h - h / 2, rr * Math.sin(theta)];
      }, { nu: seg, nv: Math.max(2, detail >> 2), generatedBy: 'TypeScript' });
      break;
    }
    case 'prism': {
      const r = Math.max(0.01, g.radius ?? 0.5);
      const h = Math.max(0.01, (g.size?.[1] ?? 1));
      const seg = Math.max(5, detail);
      geometry = parametric((u, vv) => {
        const theta = u * Math.PI * 2;
        return [r * Math.cos(theta), vv * h - h / 2, r * Math.sin(theta)];
      }, { nu: seg, nv: 2, generatedBy: 'TypeScript' });
      break;
    }
    case 'octahedron':
      geometry = octahedronGeometry(Math.max(0.01, g.radius ?? 0.5));
      break;
  }
  const m = clean.material;
  const material = buildMaterial({
    baseColor: m?.baseColor ?? [0.8, 0.8, 0.8],
    effects: (m?.effects ?? []) as Array<'noise' | 'fresnel' | 'grid' | 'heightRamp' | 'pulse' | 'sky'>,
    unlit: m?.unlit ?? false,
    generatedBy: 'TypeScript',
  });
  return { geometry, material };
}
