// geo/parametric.ts — parametric surface generators. Pure functions, no assets.
import type { Geometry } from '../scene/components.js';

export interface ParamOptions {
  nu: number; // segments along u
  nv: number; // segments along v
  generatedBy?: string;
}

interface Builder {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

function newBuilder(): Builder {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

function finish(b: Builder, generatedBy: string): Geometry {
  return {
    positions: new Float32Array(b.positions),
    normals: new Float32Array(b.normals),
    uvs: new Float32Array(b.uvs),
    indices: new Uint32Array(b.indices),
    generatedBy,
  };
}

/**
 * Generic parametric surface: fn(u, v) -> [x, y, z], u/v in [0,1].
 * Normals via central differences.
 */
export function parametric(
  fn: (u: number, v: number) => [number, number, number],
  opts: ParamOptions,
): Geometry {
  const { nu, nv } = opts;
  const b = newBuilder();
  const e = 0.001;
  const p = (u: number, v: number) => fn(u, v);
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, v = j / nv;
      const pt = p(u, v);
      b.positions.push(pt[0], pt[1], pt[2]);
      b.uvs.push(u, v);
      // central-difference normal
      const pu1 = p(Math.min(1, u + e), v), pu0 = p(Math.max(0, u - e), v);
      const pv1 = p(u, Math.min(1, v + e)), pv0 = p(u, Math.max(0, v - e));
      const tu: [number, number, number] = [pu1[0] - pu0[0], pu1[1] - pu0[1], pu1[2] - pu0[2]];
      const tv: [number, number, number] = [pv1[0] - pv0[0], pv1[1] - pv0[1], pv1[2] - pv0[2]];
      let nx = tu[1] * tv[2] - tu[2] * tv[1];
      let ny = tu[2] * tv[0] - tu[0] * tv[2];
      let nz = tu[0] * tv[1] - tu[1] * tv[0];
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l; ny /= l; nz /= l;
      b.normals.push(nx, ny, nz);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, c = a + 1, d = a + nu + 1, e2 = d + 1;
      b.indices.push(a, d, c, c, d, e2);
    }
  }
  return finish(b, opts.generatedBy ?? 'TypeScript');
}

export function plane(size = 1, seg = 1, generatedBy = 'TypeScript'): Geometry {
  return parametric((u, v) => [(u - 0.5) * size, 0, (v - 0.5) * size], { nu: seg, nv: seg, generatedBy });
}

export function sphere(radius = 1, nu = 24, nv = 16, generatedBy = 'TypeScript'): Geometry {
  const g = parametric((u, v) => {
    const theta = u * Math.PI * 2, phi = v * Math.PI;
    return [
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta),
    ];
  }, { nu, nv, generatedBy });
  // Winding fix (Oct 10, 2026): parametric() emits (a, d, c) triangles whose
  // front face points INWARD for this parametrization (verified: at the
  // equator (d-a)x(c-a) = -x while the outward normal is +x). Reverse each
  // triangle so front faces point outward, matching the outward normals.
  // skyDome()'s documented reversal (for viewing from inside) was written
  // against outward-facing sphere() and works correctly once this lands.
  const idx = g.indices;
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = t;
  }
  return g;
}

export function torus(R = 1, r = 0.3, nu = 32, nv = 16, generatedBy = 'TypeScript'): Geometry {
  const g = parametric((u, v) => {
    const a = u * Math.PI * 2, b2 = v * Math.PI * 2;
    return [
      (R + r * Math.cos(b2)) * Math.cos(a),
      r * Math.sin(b2),
      (R + r * Math.cos(b2)) * Math.sin(a),
    ];
  }, { nu, nv, generatedBy });
  // Normal fix (Oct 10, 2026): parametric() emits outward-facing triangles
  // for this parametrization, but its tu×tv central-difference normals point
  // INWARD (verified analytically at the outer equator and numerically:
  // face·normal alignment -0.99). Negate the normals so lighting matches the
  // outward winding. (Flipping the v parametrization instead would invert the
  // winding, so negation is the correct minimal fix.)
  const n = g.normals;
  for (let i = 0; i < n.length; i++) n[i] = -n[i];
  return g;
}
