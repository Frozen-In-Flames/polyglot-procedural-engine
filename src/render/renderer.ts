// render/renderer.ts — thin WebGL2 renderer owned by the engine.
// Implements the Renderer interface; future C++/Vulkan or Swift/Metal
// backends implement the same draw contract.
import type { Mat4 } from '../math/mat.js';
import { multiply } from '../math/mat.js';
import type { RenderView } from '../bridge/providers.js';
import type { SceneNode } from '../scene/node.js';
import { Mesh, Light, Camera, type Geometry, type Material } from '../scene/components.js';
import { VERTEX_SHADER, FRAGMENT_TEMPLATE } from '../material/shader.js';
import { GBUFFER_VERTEX, GBUFFER_FRAGMENT, type GBufferData } from './gbuffer.js';

interface GLProgram {
  program: WebGLProgram;
  attribs: { pos: number; normal: number; uv: number };
  uniforms: Record<string, WebGLUniformLocation | null>;
}

interface GLGeometry {
  vao: WebGLVertexArrayObject;
  indexCount: number;
  boundRadius: number;
  boundCenter: [number, number, number];
  /** For dynamic geometries: GPU buffers + last uploaded version. */
  dynamic?: {
    posBuf: WebGLBuffer;
    normBuf: WebGLBuffer;
    uvBuf: WebGLBuffer;
    version: number;
  };
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export class Renderer {
  private gl: WebGL2RenderingContext;
  private programs = new Map<string, GLProgram>();
  private geometries = new WeakMap<Geometry, GLGeometry>();
  private viewProj = new Float32Array(16);

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }

  resize(w: number, h: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
  }

  private getProgram(mat: Material): GLProgram {
    let p = this.programs.get(mat.name);
    if (p) return p;
    const gl = this.gl;
    const program = gl.createProgram()!;
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_TEMPLATE(mat.helpers, mat.body, mat.unlit ?? false)));
    // Fixed attribute locations so VAOs can be shared across programs.
    gl.bindAttribLocation(program, 0, 'aPos');
    gl.bindAttribLocation(program, 1, 'aNormal');
    gl.bindAttribLocation(program, 2, 'aUv');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(program));
    }
    const uni = (n: string) => gl.getUniformLocation(program, n);
    p = {
      program,
      attribs: {
        pos: gl.getAttribLocation(program, 'aPos'),
        normal: gl.getAttribLocation(program, 'aNormal'),
        uv: gl.getAttribLocation(program, 'aUv'),
      },
      uniforms: {
        uModel: uni('uModel'), uView: uni('uView'), uProj: uni('uProj'),
        uLightDir: uni('uLightDir'), uLightColor: uni('uLightColor'),
        uCamPos: uni('uCamPos'), uTime: uni('uTime'),
      },
    };
    // Cache material-specific uniform locations lazily on first use.
    this.programs.set(mat.name, p);
    return p;
  }

  private getGeometry(g: Geometry): GLGeometry {
    let gg = this.geometries.get(g);
    if (gg) return gg;
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const usage = g.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;
    const mkBuf = (data: Float32Array, loc: number, size: number) => {
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      return buf;
    };
    // Attribute locations are fixed by compile order in getProgram; bind
    // generically: query from any compiled program, else assume 0,1,2.
    const posBuf = mkBuf(g.positions, 0, 3);
    const normBuf = mkBuf(g.normals, 1, 3);
    const uvBuf = mkBuf(g.uvs, 2, 2);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    // Bounding sphere.
    let cx = 0, cy = 0, cz = 0;
    const n = g.positions.length / 3;
    for (let i = 0; i < n; i++) {
      cx += g.positions[i * 3]; cy += g.positions[i * 3 + 1]; cz += g.positions[i * 3 + 2];
    }
    cx /= n; cy /= n; cz /= n;
    let r = 0;
    for (let i = 0; i < n; i++) {
      const dx = g.positions[i * 3] - cx, dy = g.positions[i * 3 + 1] - cy, dz = g.positions[i * 3 + 2] - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > r) r = d;
    }
    gg = { vao, indexCount: g.indices.length, boundRadius: r, boundCenter: [cx, cy, cz] };
    if (g.dynamic) {
      gg.dynamic = { posBuf, normBuf, uvBuf, version: g.version ?? 0 };
    }
    this.geometries.set(g, gg);
    return gg;
  }

  /** Re-upload a dynamic geometry's buffers when its version changed. */
  private syncDynamic(g: Geometry, gg: GLGeometry): void {
    const dyn = gg.dynamic;
    if (!dyn || !g.dynamic) return;
    const v = g.version ?? 0;
    if (v === dyn.version) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, dyn.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, g.positions);
    gl.bindBuffer(gl.ARRAY_BUFFER, dyn.normBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, g.normals);
    gl.bindBuffer(gl.ARRAY_BUFFER, dyn.uvBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, g.uvs);
    dyn.version = v;
  }

  /** Collect renderable meshes + lights. Exported for tests/debug. */
  collect(root: SceneNode): { meshes: Mesh[]; lights: Light[]; cameras: Camera[] } {
    const meshes: Mesh[] = [], lights: Light[] = [], cameras: Camera[] = [];
    root.traverse((n) => {
      if (!n.visible) return;
      for (const c of n.components) {
        if (c instanceof Mesh) meshes.push(c);
        else if (c instanceof Light) lights.push(c);
        else if (c instanceof Camera) cameras.push(c);
      }
    });
    return { meshes, lights, cameras };
  }

  render(root: SceneNode, camera: Camera, camNode: SceneNode, views: RenderView[], time: number): void {
    const gl = this.gl;
    const { meshes, lights } = this.collect(root);
    const { dir: ldir, color: lc } = this.lighting(lights);
    const [lx, ly, lz] = ldir;
    const camPos: [number, number, number] = [camNode.worldMatrix[12], camNode.worldMatrix[13], camNode.worldMatrix[14]];

    gl.clearColor(0.02, 0.03, 0.06, 1);
    gl.enable(gl.SCISSOR_TEST);
    for (const view of views) {
      const [vx, vy, vw, vh] = view.viewport;
      gl.viewport(vx, vy, vw, vh);
      gl.scissor(vx, vy, vw, vh);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      multiply(view.proj, view.view, this.viewProj);

      for (const mesh of meshes) {
        const prog = this.getProgram(mesh.material);
        const geo = this.getGeometry(mesh.geometry);
        this.syncDynamic(mesh.geometry, geo);
        // Frustum cull: bounding sphere vs clip space (skipped for noCull).
        if (!mesh.geometry.noCull && !this.sphereInFrustum(geo, mesh.node!.worldMatrix)) continue;
        gl.useProgram(prog.program);
        gl.bindVertexArray(geo.vao);
        const u = prog.uniforms;
        gl.uniformMatrix4fv(u.uModel, false, mesh.node!.worldMatrix);
        gl.uniformMatrix4fv(u.uView, false, view.view);
        gl.uniformMatrix4fv(u.uProj, false, view.proj);
        gl.uniform3f(u.uLightDir, lx, ly, lz);
        gl.uniform3f(u.uLightColor, lc[0], lc[1], lc[2]);
        gl.uniform3f(u.uCamPos, camPos[0], camPos[1], camPos[2]);
        gl.uniform1f(u.uTime, time);
        for (const [name, val] of Object.entries(mesh.material.uniforms)) {
          const loc = gl.getUniformLocation(prog.program, name);
          if (!loc) continue;
          if (typeof val === 'number') gl.uniform1f(loc, val);
          else if (Array.isArray(val)) {
            if (val.length === 2) gl.uniform2f(loc, val[0], val[1]);
            else if (val.length === 3) gl.uniform3f(loc, val[0], val[1], val[2]);
            else if (val.length === 4) gl.uniform4f(loc, val[0], val[1], val[2], val[3]);
            else gl.uniform1fv(loc, val);
          }
        }
        gl.drawElements(gl.TRIANGLES, geo.indexCount, gl.UNSIGNED_INT, 0);
      }
    }
    gl.bindVertexArray(null);
  }

  /** Directional light in world space + effective color. Shared by the
   *  main render and the foundry G-buffer capture so both agree. */
  private lighting(lights: Light[]): { dir: [number, number, number]; color: [number, number, number] } {
    const dir = lights.find((l) => l.kind === 'directional');
    let lx = -0.4, ly = -1, lz = -0.25;
    let lc: [number, number, number] = [1, 1, 1];
    if (dir && dir.node) {
      const m = dir.node.worldMatrix;
      lx = m[8]; ly = m[9]; lz = m[10];
      const il = 1 / (Math.sqrt(lx * lx + ly * ly + lz * lz) || 1);
      lx *= il; ly *= il; lz *= il;
      lc = [dir.color[0] * dir.intensity, dir.color[1] * dir.intensity, dir.color[2] * dir.intensity];
    }
    return { dir: [lx, ly, lz], color: lc };
  }

  /** Foundry-only G-buffer capture for the V3 inverse pipeline.
   *
   *  NOT part of the hot render path: call it explicitly, once per asset,
   *  offline. Renders UV/depth, normals, and shading-without-albedo to
   *  float targets and reads them back for python/xrgen/inverse.py.
   *  Requires EXT_color_buffer_float. Throws a clear error without it.
   */
  captureGBuffer(root: SceneNode, camera: Camera, camNode: SceneNode, view: RenderView): GBufferData {
    const gl = this.gl;
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('captureGBuffer requires EXT_color_buffer_float');
    }
    const W = this.canvas.width, H = this.canvas.height;
    const { meshes, lights } = this.collect(root);
    const { dir: ldir, color: lc } = this.lighting(lights);
    const camPos: [number, number, number] = [camNode.worldMatrix[12], camNode.worldMatrix[13], camNode.worldMatrix[14]];

    // Compile the G-buffer program.
    const program = gl.createProgram()!;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('G-buffer shader compile failed: ' + gl.getShaderInfoLog(sh));
      }
      gl.attachShader(program, sh);
    };
    compile(gl.VERTEX_SHADER, GBUFFER_VERTEX);
    compile(gl.FRAGMENT_SHADER, GBUFFER_FRAGMENT);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('G-buffer program link failed: ' + gl.getProgramInfoLog(program));
    }
    const uni = (n: string) => gl.getUniformLocation(program, n);
    const uModel = uni('uModel'), uView = uni('uView'), uProj = uni('uProj');
    const uLightDir = uni('uLightDir'), uLightColor = uni('uLightColor');
    const uCamPos = uni('uCamPos'), uUnlit = uni('uUnlit');

    // Three RGBA32F targets.
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const texs: WebGLTexture[] = [];
    for (let i = 0; i < 3; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, H, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
      texs.push(tex);
    }
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('G-buffer framebuffer incomplete');
    }

    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.uniformMatrix4fv(uView, false, view.view);
    gl.uniformMatrix4fv(uProj, false, view.proj);
    gl.uniform3f(uLightDir, ldir[0], ldir[1], ldir[2]);
    gl.uniform3f(uLightColor, lc[0], lc[1], lc[2]);
    gl.uniform3f(uCamPos, camPos[0], camPos[1], camPos[2]);
    for (const mesh of meshes) {
      const geo = this.getGeometry(mesh.geometry);
      this.syncDynamic(mesh.geometry, geo);
      gl.bindVertexArray(geo.vao);
      gl.uniformMatrix4fv(uModel, false, mesh.node!.worldMatrix);
      gl.uniform1f(uUnlit, mesh.material.unlit ? 1 : 0);
      gl.drawElements(gl.TRIANGLES, geo.indexCount, gl.UNSIGNED_INT, 0);
    }

    const read = (attachment: number) => {
      const out = new Float32Array(W * H * 4);
      gl.readBuffer(attachment);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, out);
      return out;
    };
    const uvDepth = read(gl.COLOR_ATTACHMENT0);
    const normal = read(gl.COLOR_ATTACHMENT1);
    const shading = read(gl.COLOR_ATTACHMENT2);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    for (const t of texs) gl.deleteTexture(t);
    gl.deleteProgram(program);
    return { width: W, height: H, uvDepth, normal, shading };
  }

  private sphereInFrustum(geo: GLGeometry, model: Mat4): boolean {
    // Model-space center -> world -> clip.
    const [cx, cy, cz] = geo.boundCenter;
    const wx = model[0] * cx + model[4] * cy + model[8] * cz + model[12];
    const wy = model[1] * cx + model[5] * cy + model[9] * cz + model[13];
    const wz = model[2] * cx + model[6] * cy + model[10] * cz + model[14];
    const m = this.viewProj;
    const x = m[0] * wx + m[4] * wy + m[8] * wz + m[12];
    const y = m[1] * wx + m[5] * wy + m[9] * wz + m[13];
    const z = m[2] * wx + m[6] * wy + m[10] * wz + m[14];
    const w = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
    if (w <= 0.001) return false;
    // Conservative radius: max model scale axis * bounding radius.
    const sx = Math.sqrt(model[0] * model[0] + model[1] * model[1] + model[2] * model[2]);
    const sy = Math.sqrt(model[4] * model[4] + model[5] * model[5] + model[6] * model[6]);
    const sz = Math.sqrt(model[8] * model[8] + model[9] * model[9] + model[10] * model[10]);
    const r = geo.boundRadius * Math.max(sx, sy, sz);
    return (
      x > -w - r && x < w + r &&
      y > -w - r && y < w + r &&
      z > -w - r && z < w + r
    );
  }
}
