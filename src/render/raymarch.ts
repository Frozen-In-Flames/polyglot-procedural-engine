// render/raymarch.ts - WebGL2 SDF raymarching renderer.
//
// Renders SDF math-worlds directly: no meshes, no textures, no baked
// lighting. Each frame the fragment shader sphere-traces the scene's
// distance field (t_{k+1} = t_k + f(o + t_k d)), shades from the SDF
// gradient, and computes soft shadows plus ambient occlusion from further
// SDF samples. All techniques are classical public mathematics; see
// docs/methods-provenance.md.
//
// The SDF tree compiles to GLSL once (sdfToGlsl); per-frame parameter
// changes ride uniforms, so the Tuning Deck drives the render live with
// no shader rebuilds.
import { sdfToGlsl, type SdfNode, type Uniforms } from '../math/sdf.js';
import type { Vec3 } from '../math/vec.js';

export const RAYMARCH_STEPS = 96;
export const RAYMARCH_EPS = 1e-3;
export const RAYMARCH_MAX_DIST = 100;

export interface RaymarchCamera {
  pos: Vec3;
  target: Vec3;
  fovY: number;
  aspect: number;
}

export interface RaymarchOpts {
  steps?: number;
  maxDist?: number;
  eps?: number;
  /** Sky gradient top/bottom colors. */
  skyTop?: Vec3;
  skyBottom?: Vec3;
  /** Step scale under 1 relaxes the march for displaced fields. */
  stepScale?: number;
}

export interface RaymarchMaterial {
  color: Vec3;
  /** Specular strength 0..1. */
  spec: number;
}

export function cameraBasis(cam: RaymarchCamera): { fwd: Vec3; right: Vec3; up: Vec3 } {
  const f: Vec3 = [
    cam.target[0] - cam.pos[0],
    cam.target[1] - cam.pos[1],
    cam.target[2] - cam.pos[2],
  ];
  const fl = Math.sqrt(f[0] * f[0] + f[1] * f[1] + f[2] * f[2]) || 1;
  const fwd: Vec3 = [f[0] / fl, f[1] / fl, f[2] / fl];
  const up0: Vec3 = [0, 1, 0];
  let rx = fwd[1] * up0[2] - fwd[2] * up0[1];
  let ry = fwd[2] * up0[0] - fwd[0] * up0[2];
  let rz = fwd[0] * up0[1] - fwd[1] * up0[0];
  const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
  const right: Vec3 = [rx / rl, ry / rl, rz / rl];
  const ux = right[1] * fwd[2] - right[2] * fwd[1];
  const uy = right[2] * fwd[0] - right[0] * fwd[2];
  const uz = right[0] * fwd[1] - right[1] * fwd[0];
  return { fwd, right, up: [ux, uy, uz] };
}

/**
 * Build the fragment shader source for an SDF scene. Pure function of the
 * scene plus options: the same input always yields the same shader, which
 * keeps the pipeline deterministic and testable without a GPU.
 */
export function buildRaymarchFragment(
  mapGlsl: string,
  sdfUniforms: string[],
  opts: RaymarchOpts = {},
): string {
  const steps = opts.steps ?? RAYMARCH_STEPS;
  const maxDist = opts.maxDist ?? RAYMARCH_MAX_DIST;
  const eps = opts.eps ?? RAYMARCH_EPS;
  const stepScale = opts.stepScale ?? 1.0;
  const skyTop = opts.skyTop ?? [0.12, 0.2, 0.35];
  const skyBottom = opts.skyBottom ?? [0.02, 0.03, 0.06];
  const uniDecls = sdfUniforms.map(n => `uniform float ${n};`).join('\n');
  return `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uResolution;
uniform vec3 uCamPos;
uniform vec3 uCamFwd;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uTanFov;
uniform float uAspect;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uMatColor[8];
uniform float uMatSpec[8];
uniform int uDebug;
${uniDecls}
${mapGlsl}

vec3 sdfNormal(vec3 p){
  const float e = ${eps};
  float dx = map(p + vec3(e, 0.0, 0.0)).x - map(p - vec3(e, 0.0, 0.0)).x;
  float dy = map(p + vec3(0.0, e, 0.0)).x - map(p - vec3(0.0, e, 0.0)).x;
  float dz = map(p + vec3(0.0, 0.0, e)).x - map(p - vec3(0.0, 0.0, e)).x;
  return normalize(vec3(dx, dy, dz));
}

float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float k){
  float res = 1.0;
  float t = mint;
  for (int i = 0; i < 24; i++){
    float h = map(ro + rd * t).x;
    if (h < 0.001) return 0.0;
    res = min(res, k * h / t);
    t += h;
    if (t > maxt) break;
  }
  return clamp(res, 0.0, 1.0);
}

float ambientOcclusion(vec3 p, vec3 n){
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 5; i++){
    float h = 0.01 + 0.12 * float(i) / 4.0;
    float d = map(p + n * h).x;
    occ += (h - d) * sca;
    sca *= 0.95;
  }
  return clamp(1.0 - 2.0 * occ, 0.0, 1.0);
}

vec2 raymarch(vec3 ro, vec3 rd){
  float t = 0.0;
  float m = 0.0;
  for (int i = 0; i < ${steps}; i++){
    vec3 p = ro + rd * t;
    vec2 h = map(p);
    if (h.x < ${eps}) return vec2(t, h.y);
    t += h.x * ${stepScale};
    m = h.y;
    if (t > ${maxDist}) break;
  }
  return vec2(-1.0, m);
}

void main(){
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution) / uResolution.y;
  vec3 rd = normalize(uv.x * uCamRight + uv.y * uCamUp + (1.0 / uTanFov) * uCamFwd);
  vec3 ro = uCamPos;
  vec2 res = raymarch(ro, rd);
  vec3 col;
  if (res.x > 0.0){
    vec3 p = ro + rd * res.x;
    vec3 n = sdfNormal(p);
    if (uDebug == 1){
      float d = clamp(res.x / 40.0, 0.0, 1.0);
      col = vec3(d);
    } else if (uDebug == 2){
      col = n * 0.5 + 0.5;
    } else {
    int mi = int(res.y + 0.5);
    vec3 albedo = uMatColor[mi];
    float specAmt = uMatSpec[mi];
    vec3 l = normalize(uLightDir);
    float dif = max(dot(n, l), 0.0);
    float sh = softShadow(p + n * 0.02, l, 0.02, 24.0, 8.0);
    float ao = ambientOcclusion(p, n);
    vec3 h = normalize(l - rd);
    float spec = pow(max(dot(n, h), 0.0), 48.0) * specAmt;
    vec3 skyAmb = mix(vec3(${skyBottom[0]}, ${skyBottom[1]}, ${skyBottom[2]}),
                      vec3(${skyTop[0]}, ${skyTop[1]}, ${skyTop[2]}), n.y * 0.5 + 0.5);
    col = albedo * (skyAmb * 0.6 * ao + uLightColor * dif * sh) + uLightColor * spec * sh;
    float fog = 1.0 - exp(-0.008 * res.x);
    col = mix(col, vec3(${skyTop[0]}, ${skyTop[1]}, ${skyTop[2]}) * 0.5, fog);
    }
  } else {
    float t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
    col = mix(vec3(${skyBottom[0]}, ${skyBottom[1]}, ${skyBottom[2]}),
              vec3(${skyTop[0]}, ${skyTop[1]}, ${skyTop[2]}), t);
    float sun = pow(max(dot(rd, normalize(uLightDir)), 0.0), 600.0);
    col += uLightColor * sun * 2.0;
  }
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  outColor = vec4(col, 1.0);
}
`;
}

const VERT_SRC = `#version 300 es
layout(location = 0) in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Raymarch shader compile failed: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

const DEFAULT_MATERIALS: RaymarchMaterial[] = [
  { color: [0.55, 0.5, 0.45], spec: 0.1 },
  { color: [0.45, 0.36, 0.28], spec: 0.15 },
  { color: [0.5, 0.42, 0.38], spec: 0.3 },
  { color: [0.36, 0.44, 0.5], spec: 0.5 },
  { color: [0.4, 0.4, 0.42], spec: 0.2 },
  { color: [0.55, 0.5, 0.45], spec: 0.1 },
  { color: [0.55, 0.5, 0.45], spec: 0.1 },
  { color: [0.55, 0.5, 0.45], spec: 0.1 },
];

/** WebGL2 SDF raymarching renderer. One compiled shader per scene. */
export class RaymarchRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private uniCache = new Map<string, WebGLUniformLocation | null>();
  private vao: WebGLVertexArrayObject | null = null;
  private sdfUniformNames: string[] = [];
  private uniforms: Uniforms = {};
  private materials: RaymarchMaterial[] = DEFAULT_MATERIALS;
  private lightDir: Vec3 = [0.5, 0.8, 0.3];
  private lightColor: Vec3 = [1.0, 0.95, 0.88];

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false });
    if (!gl) throw new Error('WebGL2 not available for the raymarch renderer');
    this.gl = gl;
  }

  /** Compile the scene's SDF to a shader. Structure changes recompile;
   *  parameter changes ride uniforms (see setUniforms). */
  setScene(root: SdfNode, opts: RaymarchOpts = {}): void {
    const gl = this.gl;
    const { glsl, uniforms } = sdfToGlsl(root);
    this.sdfUniformNames = uniforms;
    const frag = buildRaymarchFragment(glsl, uniforms, opts);
    const program = gl.createProgram()!;
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Raymarch program link failed: ' + gl.getProgramInfoLog(program));
    }
    if (this.program) gl.deleteProgram(this.program);
    this.program = program;
    this.uniCache.clear();
    if (!this.vao) {
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    }
  }

  setUniforms(u: Uniforms): void {
    Object.assign(this.uniforms, u);
  }

  setMaterials(mats: RaymarchMaterial[]): void {
    this.materials = mats;
  }

  setLight(dir: Vec3, color: Vec3): void {
    this.lightDir = dir;
    this.lightColor = color;
  }

  /** 0 = shaded, 1 = depth, 2 = normal. Shows the raymarcher really
   *  returns depth and normal, not just a pretty picture. */
  private debugMode = 0;

  setDebug(mode: 0 | 1 | 2): void {
    this.debugMode = mode;
  }

  private uni(name: string): WebGLUniformLocation | null {
    let loc = this.uniCache.get(name);
    if (loc === undefined) {
      loc = this.gl.getUniformLocation(this.program!, name);
      this.uniCache.set(name, loc);
    }
    return loc ?? null;
  }

  resize(w: number, h: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
  }

  render(cam: RaymarchCamera): void {
    const gl = this.gl;
    if (!this.program) throw new Error('setScene() before render()');
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    const { fwd, right, up } = cameraBasis(cam);
    const tanFov = Math.tan(cam.fovY / 2);
    const set3 = (n: string, v: Vec3) => gl.uniform3f(this.uni(n), v[0], v[1], v[2]);
    const set1 = (n: string, v: number) => gl.uniform1f(this.uni(n), v);
    gl.uniform2f(this.uni('uResolution'), this.canvas.width, this.canvas.height);
    set3('uCamPos', cam.pos);
    set3('uCamFwd', fwd);
    set3('uCamRight', right);
    set3('uCamUp', up);
    set1('uTanFov', tanFov);
    set1('uAspect', cam.aspect);
    const ld = this.lightDir;
    const ll = Math.sqrt(ld[0] * ld[0] + ld[1] * ld[1] + ld[2] * ld[2]) || 1;
    set3('uLightDir', [ld[0] / ll, ld[1] / ll, ld[2] / ll]);
    set3('uLightColor', this.lightColor);
    const colors = new Float32Array(24);
    const specs = new Float32Array(8);
    for (let i = 0; i < 8; i++) {
      const m = this.materials[i] ?? DEFAULT_MATERIALS[0];
      colors[i * 3] = m.color[0]; colors[i * 3 + 1] = m.color[1]; colors[i * 3 + 2] = m.color[2];
      specs[i] = m.spec;
    }
    gl.uniform3fv(this.uni('uMatColor'), colors);
    gl.uniform1fv(this.uni('uMatSpec'), specs);
    gl.uniform1i(this.uni('uDebug'), this.debugMode);
    for (const n of this.sdfUniformNames) set1(n, this.uniforms[n] ?? 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
