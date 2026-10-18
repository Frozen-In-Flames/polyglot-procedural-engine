// math/sdf.ts - signed distance field math library. Pure functions, zero assets.
//
// An SdfNode is an immutable description of a distance field. It evaluates
// on the CPU (evalSdf) for tests and gameplay queries, and compiles to GLSL
// (sdfToGlsl) for the WebGL2 raymarching renderer. Scalar parameters may be
// plain numbers or { uniform: name } references, so the Tuning Deck can drive
// the math live without rebuilding the shader.
//
// All techniques here are classical public mathematics; see
// docs/methods-provenance.md.
import type { Vec3 } from './vec.js';
import { NOISE_LIPSCHITZ } from './bandlimit.js';

/** A scalar that is either baked in or driven live by a named uniform. */
export type SdfValue = number | { uniform: string };

export type SdfNode =
  | { kind: 'sphere'; r: SdfValue; c?: Vec3; mat?: number }
  | { kind: 'box'; b: Vec3; c?: Vec3; mat?: number }
  | { kind: 'torus'; R: SdfValue; r: SdfValue; c?: Vec3; mat?: number }
  | { kind: 'capsule'; a: Vec3; b: Vec3; r: SdfValue; mat?: number }
  | { kind: 'plane'; n: Vec3; h: number; mat?: number }
  | { kind: 'union'; children: SdfNode[] }
  | { kind: 'smoothUnion'; k: SdfValue; children: SdfNode[] }
  | { kind: 'polySmin'; k: SdfValue; children: [SdfNode, SdfNode] }
  | { kind: 'subtract'; a: SdfNode; b: SdfNode }
  | { kind: 'intersect'; children: SdfNode[] }
  | { kind: 'repeat'; c: [SdfValue, SdfValue, SdfValue]; child: SdfNode }
  | { kind: 'twist'; k: SdfValue; child: SdfNode }
  | { kind: 'displace'; amp: SdfValue; freq: SdfValue; seed: number; child: SdfNode }
  | { kind: 'translate'; t: Vec3; child: SdfNode }
  | { kind: 'scale'; s: SdfValue; child: SdfNode };

export interface SdfHit {
  d: number;
  mat: number;
}

export type Uniforms = Record<string, number>;

function val(v: SdfValue, u: Uniforms): number {
  return typeof v === 'number' ? v : (u[v.uniform] ?? 0);
}

function sub(p: Vec3, c: Vec3 | undefined): Vec3 {
  return c ? [p[0] - c[0], p[1] - c[1], p[2] - c[2]] : p;
}

// ---------------------------------------------------------------------------
// Seeded 3D value noise (deterministic; the C++/WASM simplex core remains the
// heavy-duty generator, this is the exact, testable TS reference).
// ---------------------------------------------------------------------------

export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = seed ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647 ^ 0x5bf03635);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(xf), v = s(yf), w = s(zf);
  const c000 = hash3(xi, yi, zi, seed), c100 = hash3(xi + 1, yi, zi, seed);
  const c010 = hash3(xi, yi + 1, zi, seed), c110 = hash3(xi + 1, yi + 1, zi, seed);
  const c001 = hash3(xi, yi, zi + 1, seed), c101 = hash3(xi + 1, yi, zi + 1, seed);
  const c011 = hash3(xi, yi + 1, zi + 1, seed), c111 = hash3(xi + 1, yi + 1, zi + 1, seed);
  const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w; // [0, 1]
}

export function fbm3(x: number, y: number, z: number, seed: number, octaves = 4): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq, seed + o * 131);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm; // [0, 1]
}

// ---------------------------------------------------------------------------
// CPU evaluator. Returns distance and winning material id.
// ---------------------------------------------------------------------------

function primitive(n: Extract<SdfNode, { mat?: number }>, d: number): SdfHit {
  return { d, mat: n.mat ?? 0 };
}

function minHit(a: SdfHit, b: SdfHit): SdfHit {
  return a.d <= b.d ? a : b;
}

function sminCpu(a: number, b: number, k: number): number {
  // Exponential smooth-min, stabilized against overflow:
  //   smin = -(1/k) ln(e^{-ka} + e^{-kb}) = min(a,b) - (1/k) ln(1 + e^{-k|a-b|}).
  // Larger k hugs min() tighter (crisper blend); smaller k bulges (softer).
  const kk = Math.max(1e-6, k);
  return Math.min(a, b) - Math.log1p(Math.exp(-kk * Math.abs(a - b))) / kk;
}

export function evalSdf(node: SdfNode, p: Vec3, u: Uniforms = {}): SdfHit {
  switch (node.kind) {
    case 'sphere': {
      const q = sub(p, node.c);
      const d = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]) - val(node.r, u);
      return primitive(node, d);
    }
    case 'box': {
      const q = sub(p, node.c);
      const b = node.b;
      const qx = Math.abs(q[0]) - b[0], qy = Math.abs(q[1]) - b[1], qz = Math.abs(q[2]) - b[2];
      const ax = Math.max(qx, 0), ay = Math.max(qy, 0), az = Math.max(qz, 0);
      const d = Math.sqrt(ax * ax + ay * ay + az * az) + Math.min(Math.max(qx, Math.max(qy, qz)), 0);
      return primitive(node, d);
    }
    case 'torus': {
      const q = sub(p, node.c);
      const R = val(node.R, u), r = val(node.r, u);
      const qx = Math.sqrt(q[0] * q[0] + q[2] * q[2]) - R;
      const d = Math.sqrt(qx * qx + q[1] * q[1]) - r;
      return primitive(node, d);
    }
    case 'capsule': {
      const pa = [p[0] - node.a[0], p[1] - node.a[1], p[2] - node.a[2]];
      const ba = [node.b[0] - node.a[0], node.b[1] - node.a[1], node.b[2] - node.a[2]];
      const baba = ba[0] * ba[0] + ba[1] * ba[1] + ba[2] * ba[2];
      let h = baba > 0 ? (pa[0] * ba[0] + pa[1] * ba[1] + pa[2] * ba[2]) / baba : 0;
      h = Math.min(1, Math.max(0, h));
      const q = [pa[0] - ba[0] * h, pa[1] - ba[1] * h, pa[2] - ba[2] * h];
      const d = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]) - val(node.r, u);
      return primitive(node, d);
    }
    case 'plane': {
      const d = p[0] * node.n[0] + p[1] * node.n[1] + p[2] * node.n[2] + node.h;
      return primitive(node, d);
    }
    case 'union': {
      let best: SdfHit = { d: Infinity, mat: 0 };
      for (const c of node.children) best = minHit(best, evalSdf(c, p, u));
      return best;
    }
    case 'smoothUnion': {
      const k = Math.max(1e-6, val(node.k, u));
      let acc: SdfHit = { d: Infinity, mat: 0 };
      for (const c of node.children) {
        const h = evalSdf(c, p, u);
        if (acc.d === Infinity) { acc = h; continue; }
        const d = sminCpu(acc.d, h.d, k);
        acc = { d, mat: acc.d <= h.d ? acc.mat : h.mat };
      }
      return acc;
    }
    case 'polySmin': {
      // Polynomial smooth-min: h = max(k-|a-b|,0)/k, smin = min(a,b) - (k/4) h^2.
      // Gradient is a convex combination of children's gradients.
      const k = Math.max(1e-9, val(node.k, u));
      const a = evalSdf(node.children[0], p, u);
      const b = evalSdf(node.children[1], p, u);
      const h = Math.max(k - Math.abs(a.d - b.d), 0) / k;
      const d = Math.min(a.d, b.d) - (k / 4) * h * h;
      return { d, mat: a.d <= b.d ? a.mat : b.mat };
    }
    case 'subtract': {
      const a = evalSdf(node.a, p, u);      const b = evalSdf(node.b, p, u);
      return { d: Math.max(a.d, -b.d), mat: a.mat };
    }
    case 'intersect': {
      let best: SdfHit = { d: Infinity, mat: 0 };
      for (const c of node.children) {
        const h = evalSdf(c, p, u);
        if (h.d > best.d) best = h;
      }
      return best.d === Infinity ? { d: Infinity, mat: 0 } : best;
    }
    case 'repeat': {
      const q: Vec3 = [p[0], p[1], p[2]];
      for (let i = 0; i < 3; i++) {
        const c = val(node.c[i], u);
        if (c > 0) q[i] = ((p[i] + 0.5 * c) % c + c) % c - 0.5 * c;
      }
      return evalSdf(node.child, q, u);
    }
    case 'twist': {
      const k = val(node.k, u);
      const c = Math.cos(k * p[1]), s = Math.sin(k * p[1]);
      const q: Vec3 = [c * p[0] - s * p[2], p[1], s * p[0] + c * p[2]];
      return evalSdf(node.child, q, u);
    }
    case 'displace': {
      const amp = val(node.amp, u), freq = val(node.freq, u);
      const n = fbm3(p[0] * freq, p[1] * freq, p[2] * freq, node.seed);
      const h = evalSdf(node.child, p, u);
      // Displacement relaxes the strict distance bound; the raymarcher
      // compensates with under-relaxation (omega < 1). See Lipschitz notes.
      return { d: h.d + amp * (n - 0.5) * 2, mat: h.mat };
    }
    case 'translate':
      return evalSdf(node.child, sub(p, node.t), u);
    case 'scale': {
      const s = val(node.s, u) || 1;
      const h = evalSdf(node.child, [p[0] / s, p[1] / s, p[2] / s], u);
      return { d: h.d * s, mat: h.mat };
    }
  }
}

/** Convenience: distance only. */
export function sdfDist(node: SdfNode, p: Vec3, u: Uniforms = {}): number {
  return evalSdf(node, p, u).d;
}

// ---------------------------------------------------------------------------
// GLSL code generation. Produces `vec2 map(vec3 p)` (x = distance,
// y = material id) plus helpers. Uniforms referenced by the tree are
// declared; the host sets them per frame.
// ---------------------------------------------------------------------------

export function collectUniforms(node: SdfNode, out: Set<string> = new Set()): Set<string> {
  const grab = (v: SdfValue | undefined) => {
    if (v !== undefined && typeof v !== 'number') out.add(v.uniform);
  };
  switch (node.kind) {
    case 'sphere': grab(node.r); break;
    case 'torus': grab(node.R); grab(node.r); break;
    case 'capsule': grab(node.r); break;
    case 'smoothUnion': grab(node.k); node.children.forEach(c => collectUniforms(c, out)); break;
    case 'polySmin': grab(node.k); collectUniforms(node.children[0], out); collectUniforms(node.children[1], out); break;
    case 'twist': grab(node.k); collectUniforms(node.child, out); break;
    case 'displace': grab(node.amp); grab(node.freq); collectUniforms(node.child, out); break;
    case 'scale': grab(node.s); collectUniforms(node.child, out); break;
    case 'union': case 'intersect': node.children.forEach(c => collectUniforms(c, out)); break;
    case 'subtract': collectUniforms(node.a, out); collectUniforms(node.b, out); break;
    case 'repeat': node.c.forEach(grab); collectUniforms(node.child, out); break;
    case 'translate': collectUniforms(node.child, out); break;
  }
  return out;
}

const SDF_HELPERS_GLSL = `
float sdf_smin(float a, float b, float k){
  float kk = max(k, 1e-6);
  return min(a, b) - log(1.0 + exp(-kk * abs(a - b))) / kk;
}
float sdf_hash(vec3 p){
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float sdf_vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(sdf_hash(i), sdf_hash(i + vec3(1,0,0)), u.x),
                  mix(sdf_hash(i + vec3(0,1,0)), sdf_hash(i + vec3(1,1,0)), u.x), u.y),
             mix(mix(sdf_hash(i + vec3(0,0,1)), sdf_hash(i + vec3(1,0,1)), u.x),
                  mix(sdf_hash(i + vec3(0,1,1)), sdf_hash(i + vec3(1,1,1)), u.x), u.y), u.z);
}
float sdf_fbm(vec3 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * sdf_vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
vec2 sdf_min2(vec2 a, vec2 b){ return a.x <= b.x ? a : b; }
vec2 sdf_max2(vec2 a, vec2 b){ return a.x >= b.x ? a : b; }
`;

function glslVal(v: SdfValue): string {
  return typeof v === 'number' ? `(${v})` : v.uniform;
}

function glslVec(v: Vec3): string {
  return `vec3(${v[0]}, ${v[1]}, ${v[2]})`;
}

function glslVecV(v: [SdfValue, SdfValue, SdfValue]): string {
  return `vec3(${glslVal(v[0])}, ${glslVal(v[1])}, ${glslVal(v[2])})`;
}

let tmpCounter = 0;

function emitNode(node: SdfNode, pExpr: string): { code: string; out: string } {
  const t = `r${tmpCounter++}`;
  const mat = (n: { mat?: number }) => `${n.mat ?? 0}.0`;
  switch (node.kind) {
    case 'sphere': {
      const q = node.c ? `(${pExpr} - ${glslVec(node.c)})` : pExpr;
      return { code: `vec2 ${t} = vec2(length(${q}) - ${glslVal(node.r)}, ${mat(node)});`, out: t };
    }
    case 'box': {
      const q = node.c ? `abs(${pExpr} - ${glslVec(node.c)}) - ${glslVec(node.b)}` : `abs(${pExpr}) - ${glslVec(node.b)}`;
      return {
        code: `vec3 ${t}q = ${q};\nvec2 ${t} = vec2(length(max(${t}q, 0.0)) + min(max(${t}q.x, max(${t}q.y, ${t}q.z)), 0.0), ${mat(node)});`,
        out: t,
      };
    }
    case 'torus': {
      const q = node.c ? `(${pExpr} - ${glslVec(node.c)})` : pExpr;
      return {
        code: `vec2 ${t}x = vec2(length(${q}.xz) - ${glslVal(node.R)}, ${q}.y);\nvec2 ${t} = vec2(length(${t}x) - ${glslVal(node.r)}, ${mat(node)});`,
        out: t,
      };
    }
    case 'capsule': {
      const a = glslVec(node.a), b = glslVec(node.b);
      return {
        code: `vec3 ${t}pa = ${pExpr} - ${a};\nvec3 ${t}ba = ${b} - ${a};\nfloat ${t}h = clamp(dot(${t}pa, ${t}ba) / max(dot(${t}ba, ${t}ba), 1e-8), 0.0, 1.0);\nvec2 ${t} = vec2(length(${t}pa - ${t}ba * ${t}h) - ${glslVal(node.r)}, ${mat(node)});`,
        out: t,
      };
    }
    case 'plane': {
      const n = glslVec(node.n);
      return { code: `vec2 ${t} = vec2(dot(${pExpr}, ${n}) + (${node.h}), ${mat(node)});`, out: t };
    }
    case 'union': {
      const parts = node.children.map(c => emitNode(c, pExpr));
      const code = parts.map(x => x.code).join('\n');
      const folded = parts.map(x => x.out).reduce((a, b) => `sdf_min2(${a}, ${b})`);
      return { code: `${code}\nvec2 ${t} = ${folded};`, out: t };
    }
    case 'smoothUnion': {
      const parts = node.children.map(c => emitNode(c, pExpr));
      const code = parts.map(x => x.code).join('\n');
      const k = glslVal(node.k);
      let acc = parts[0].out;
      for (let i = 1; i < parts.length; i++) {
        const b = parts[i].out;
        acc = `vec2(sdf_smin(${acc}.x, ${b}.x, ${k}), ${acc}.x <= ${b}.x ? ${acc}.y : ${b}.y)`;
      }
      return { code: `${code}\nvec2 ${t} = ${acc};`, out: t };
    }
    case 'subtract': {
      const a = emitNode(node.a, pExpr), b = emitNode(node.b, pExpr);
      return { code: `${a.code}\n${b.code}\nvec2 ${t} = vec2(max(${a.out}.x, -${b.out}.x), ${a.out}.y);`, out: t };
    }
    case 'polySmin': {
      const pa = emitNode(node.children[0], pExpr), pb = emitNode(node.children[1], pExpr);
      const pk = glslVal(node.k);
      const pcode = pa.code + '\n' + pb.code;
      return { code: `${pcode}\nfloat ${t}h = max(${pk} - abs(${pa.out}.x - ${pb.out}.x), 0.0) / ${pk};\nvec2 ${t} = vec2(min(${pa.out}.x, ${pb.out}.x) - (${pk} / 4.0) * ${t}h * ${t}h, ${pa.out}.x <= ${pb.out}.x ? ${pa.out}.y : ${pb.out}.y);`, out: t };
    }
    case 'intersect': {
      const parts = node.children.map(c => emitNode(c, pExpr));
      const code = parts.map(x => x.code).join('\n');
      const folded = parts.map(x => x.out).reduce((a, b) => `sdf_max2(${a}, ${b})`);
      return { code: `${code}\nvec2 ${t} = ${folded};`, out: t };
    }
    case 'repeat': {
      const c = glslVecV(node.c);
      const qp = `${t}qp`;
      const inner = emitNode(node.child, qp);
      return {
        code: `vec3 ${qp} = ${pExpr};\n${[0, 1, 2].map(i => `if (${c}[${i}] > 0.0) ${qp}[${i}] = mod(${qp}[${i}] + 0.5 * ${c}[${i}], ${c}[${i}]) - 0.5 * ${c}[${i}];`).join('\n')}\n${inner.code}\nvec2 ${t} = ${inner.out};`,
        out: t,
      };
    }
    case 'twist': {
      const qp = `${t}qp`;
      const inner = emitNode(node.child, qp);
      return {
        code: `float ${t}c = cos(${glslVal(node.k)} * ${pExpr}.y);\nfloat ${t}s = sin(${glslVal(node.k)} * ${pExpr}.y);\nvec3 ${qp} = vec3(${t}c * ${pExpr}.x - ${t}s * ${pExpr}.z, ${pExpr}.y, ${t}s * ${pExpr}.x + ${t}c * ${pExpr}.z);\n${inner.code}\nvec2 ${t} = ${inner.out};`,
        out: t,
      };
    }
    case 'displace': {
      const inner = emitNode(node.child, pExpr);
      return {
        code: `${inner.code}\nvec2 ${t} = vec2(${inner.out}.x + ${glslVal(node.amp)} * (sdf_fbm(${pExpr} * ${glslVal(node.freq)} + ${node.seed}.0) - 0.5) * 2.0, ${inner.out}.y);`,
        out: t,
      };
    }
    case 'translate': {
      const inner = emitNode(node.child, `(${pExpr} - ${glslVec(node.t)})`);
      return { code: inner.code + `\nvec2 ${t} = ${inner.out};`, out: t };
    }
    case 'scale': {
      const inner = emitNode(node.child, `(${pExpr} / ${glslVal(node.s)})`);
      return { code: `${inner.code}\nvec2 ${t} = vec2(${inner.out}.x * ${glslVal(node.s)}, ${inner.out}.y);`, out: t };
    }
  }
}

/** Compile an SDF tree to a GLSL `vec2 map(vec3 p)` function (x = distance, y = material id). */
export function sdfToGlsl(node: SdfNode): { glsl: string; uniforms: string[] } {
  tmpCounter = 0;
  const uniforms = [...collectUniforms(node)].sort();
  const decls = uniforms.map(n => `uniform float ${n};`).join('\n');
  const body = emitNode(node, 'p');
  const glsl = `${SDF_HELPERS_GLSL}\n${decls}\nvec2 map(vec3 p){\n${body.code}\nreturn ${body.out};\n}`;
  return { glsl, uniforms };
}

// ---------------------------------------------------------------------------
// CPU sphere tracer (reference marcher for tests and gameplay queries).
//
// The march implements the spec exactly: t_{k+1} = t_k + f(o + t_k d),
// iterating until f(x) < epsilon (hit) or t exceeds the max distance.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-operator Lipschitz bounds and step relaxation.
//
// Sphere tracing is safe when the step never exceeds the true distance.
// The V10.2 marcher advances t_{k+1} = t_k + f(o + t_k d) / L, i.e. the
// user-facing omega is defined as omega = 1 / L, computed from the
// per-operator bounds below and defaulting to the V10.1 value 0.85 when
// no bound is known. omega is clamped to at most 1/L; exceeding it needs
// the explicit allowUnsafeOmega opt-in, so a slider can never silently
// reintroduce tunneling.
//
// GLOBAL vs LOCAL: the composed bound multiplies through deep trees and
// is safe but pessimistic (more steps than needed). Where a tighter local
// bound is computable it is documented per operator; the marcher uses the
// global composed bound because it is one number valid for the whole
// march, cheap to compute once, and the reference-march test validates
// that it never tunnels on warped or displaced fields.
//
// Per-operator bounds (L_f = bound of the child field):
// - Primitives (sphere, box, torus, capsule, plane): 1 (true SDF).
// - union/intersect/subtract (min/max): max(L_a, L_b).
// - smoothUnion (polynomial smin): max(L_a, L_b). The blend gradient is a
//   convex combination of the children's gradients, so the bound stays
//   max(L_a, L_b), never the sum.
// - translate: L_f. Uniform scale s: L_f (f(p/s)*s is the exact field).
// - twist (angle k*y): L_f * (1 + |k| * r_max). LOCAL form at point p:
//   L(p) = L_f * (1 + |k| * sqrt(px^2 + pz^2)). The global bound needs
//   r_max, the largest radial distance in the marched box: a bounded-region
//   requirement, documented here. Default extent 8 world units.
// - displace (f + A * noise): L_f + A * L_N * sum_k c_k g_k w_k with the
//   octave amplitudes c_k, frequencies g_k, fade weights w_k, and base
//   noise Lipschitz L_N (see bandlimit.ts lipschitzDisplace). When the
//   fade is distance-driven, the slope term A * sum_k c_k |dw_k/dt| is
//   added (finite: the smoothstep fade has zero slope at its joints).
// - repeat: L_f, valid only while the repeated primitive stays strictly
//   inside its cell (documented assumption).
// ---------------------------------------------------------------------------

/** Default under-relaxation for sphere tracing. See the Lipschitz notes. */
export const SDF_OMEGA = 0.85;

/** Options for lipschitzBound. */
export interface LipschitzOpts {
  /** Largest radial distance the bound must hold inside (twist needs it).
   *  Default 8 world units; documented bounded-region requirement. */
  extent?: number;
  /** Angular pixel size, for the fade slope term when band-limiting. */
  pixelAngle?: number;
}

/**
 * Composed Lipschitz bound for an SDF tree (global, safe, pessimistic).
 * Returns NaN when the tree contains an operator with no known bound;
 * the marcher then falls back to SDF_OMEGA. Uniform-valued parameters
 * are read from u (missing uniforms read as 0).
 */
export function lipschitzBound(node: SdfNode, u: Uniforms = {}, opts: LipschitzOpts = {}): number {
  const extent = opts.extent ?? 8;
  switch (node.kind) {
    case 'sphere':
    case 'box':
    case 'torus':
    case 'capsule':
    case 'plane':
      return 1;
    case 'union':
    case 'intersect':
    case 'smoothUnion':
    case 'polySmin': {
      let m = 0;
      for (const c of node.children) {
        const l = lipschitzBound(c, u, opts);
        if (!Number.isFinite(l)) return NaN;
        m = Math.max(m, l);
      }
      return m;
    }
    case 'subtract': {
      const la = lipschitzBound(node.a, u, opts);
      const lb = lipschitzBound(node.b, u, opts);
      if (!Number.isFinite(la) || !Number.isFinite(lb)) return NaN;
      return Math.max(la, lb);
    }
    case 'translate':
      return lipschitzBound(node.child, u, opts);
    case 'scale':
      return lipschitzBound(node.child, u, opts);
    case 'repeat':
      // Documented assumption: the repeated primitive stays in its cell.
      return lipschitzBound(node.child, u, opts);
    case 'twist': {
      const lc = lipschitzBound(node.child, u, opts);
      if (!Number.isFinite(lc)) return NaN;
      const k = Math.abs(val(node.k, u));
      return lc * (1 + k * extent);
    }
    case 'displace': {
      const lc = lipschitzBound(node.child, u, opts);
      if (!Number.isFinite(lc)) return NaN;
      const amp = Math.abs(val(node.amp, u));
      const freq = Math.abs(val(node.freq, u));
      // fbm3 structure: 4 octaves, amplitude 0.5^k / 1.875, frequency
      // 2.03^k, output in [0,1], centered and scaled by 2 in evalSdf.
      const norm1875 = 1.875;
      let s = 0;
      for (let k = 0; k < 4; k++) s += ((0.5 ** k) / norm1875) * 2.03 ** k;
      return lc + amp * 2 * NOISE_LIPSCHITZ * freq * s;
    }
    default:
      return NaN;
  }
}
/** Hit threshold: the march stops when f(x) < SDF_EPS. Small enough to be
 *  visually exact at scene scale, large enough to terminate on grazing rays. */
export const SDF_EPS = 1e-3;
/** March give-up distance: rays that travel this far without a hit miss. */
export const SDF_MAX_DIST = 100;
/** Hard iteration cap: guarantees termination even where the field is
 *  nearly flat (e.g. far from all geometry). */
export const SDF_MAX_STEPS = 128;

export interface MarchResult {
  hit: boolean;
  dist: number;
  mat: number;
  pos: Vec3;
  /** Surface normal at the hit (central differences of f), null on miss. */
  normal: Vec3 | null;
  steps: number;
}

/** Sphere tracing on the CPU: march by the SDF value until epsilon-close.
 *
 *  Step relaxation (V10.2): t_{k+1} = t_k + f(o + t_k d) / L, where L is
 *  the Lipschitz bound from lipschitzBound(). The user-facing omega is
 *  defined as omega = 1/L and defaults to it; when no bound is known it
 *  defaults to SDF_OMEGA (0.85). An explicit omega is clamped to at most
 *  1/L unless allowUnsafeOmega is set: without the opt-in, no caller can
 *  silently reintroduce tunneling. stepScale is kept as an alias for
 *  omega. The ray direction must be unit length (asserted at entry).
 *  pixelAngle enables band-limiting: the hit epsilon scales as
 *  eps(t) = t * pixelAngle (see bandlimit.ts). */
export function marchRay(
  node: SdfNode, ro: Vec3, rd: Vec3, u: Uniforms = {},
  opts: {
    maxSteps?: number; maxDist?: number; eps?: number;
    omega?: number; stepScale?: number;
    /** Explicit Lipschitz bound (skips lipschitzBound). */
    lipschitz?: number;
    /** Radial extent for the twist bound. Default 8. */
    extent?: number;
    /** Opt in to omega above 1/L. Without it, omega clamps to 1/L. */
    allowUnsafeOmega?: boolean;
    /** Angular pixel size (radians) for distance-scaled epsilon. */
    pixelAngle?: number;
  } = {},
): MarchResult {
  const rl = Math.hypot(rd[0], rd[1], rd[2]);
  if (Math.abs(rl - 1) > 1e-6) {
    throw new Error(`marchRay: ray direction must be unit length, got |d| = ${rl}`);
  }
  const maxSteps = opts.maxSteps ?? SDF_MAX_STEPS;
  const maxDist = opts.maxDist ?? SDF_MAX_DIST;
  const baseEps = opts.eps ?? SDF_EPS;
  const L = opts.lipschitz ?? lipschitzBound(node, u, { extent: opts.extent });
  const boundKnown = Number.isFinite(L) && (L as number) > 0;
  const omegaCap = boundKnown ? Math.min(1, 1 / (L as number)) : SDF_OMEGA;
  let omega = opts.omega ?? opts.stepScale ?? omegaCap;
  if (!opts.allowUnsafeOmega && omega > omegaCap) {
    console.warn(
      `[sdf] omega ${omega} exceeds 1/L = ${omegaCap.toFixed(4)}; clamped ` +
        `(pass allowUnsafeOmega to opt in to tunneling risk)`,
    );
    omega = omegaCap;
  }
  let t = 0;
  for (let i = 0; i < maxSteps; i++) {
    const eps = opts.pixelAngle != null ? Math.max(baseEps, t * opts.pixelAngle) : baseEps;
    const p: Vec3 = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
    const h = evalSdf(node, p, u);
    if (h.d < eps) {
      return { hit: true, dist: t, mat: h.mat, pos: p, normal: sdfNormal(node, p, u), steps: i + 1 };
    }
    t += h.d * omega;
    if (t > maxDist) break;
  }
  const miss: Vec3 = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
  return { hit: false, dist: t, mat: 0, pos: miss, normal: null, steps: maxSteps };
}

/**
 * SDF normal via central differences of f:
 *   n = normalize( (f(p+e_x)-f(p-e_x)), (f(p+e_y)-f(p-e_y)), (f(p+e_z)-f(p-e_z)) ).
 * Six field evaluations; exact for the discrete field, no tetrahedron bias.
 */
export function sdfNormal(node: SdfNode, p: Vec3, u: Uniforms = {}, eps = 1e-4): Vec3 {
  const e = eps;
  const dx = evalSdf(node, [p[0] + e, p[1], p[2]], u).d - evalSdf(node, [p[0] - e, p[1], p[2]], u).d;
  const dy = evalSdf(node, [p[0], p[1] + e, p[2]], u).d - evalSdf(node, [p[0], p[1] - e, p[2]], u).d;
  const dz = evalSdf(node, [p[0], p[1], p[2] + e], u).d - evalSdf(node, [p[0], p[1], p[2] - e], u).d;
  const n: Vec3 = [dx, dy, dz];
  const l = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}
