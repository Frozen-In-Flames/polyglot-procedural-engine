// render/gbuffer.ts - foundry-only G-buffer capture for the V3 inverse
// pipeline. Renders UV, view depth, normals, and shading-without-albedo
// so python/xrgen/inverse.py can reproject a super-resolved frame into
// texture space and strip lighting (albedo = observed / shading).
//
// This is NOT part of the hot render path: it is a separate,
// explicitly-invoked capture used once per asset, offline. It requires
// EXT_color_buffer_float. Nothing here runs at game runtime.

/** One capture: flat row-major float buffers, W*H texels each. */
export interface GBufferData {
  width: number;
  height: number;
  /** xyzw per texel: u, v, view-space depth (nearer is smaller), 1. */
  uvDepth: Float32Array;
  /** xyzw per texel: packed world normal (*0.5+0.5), 1. */
  normal: Float32Array;
  /** xyzw per texel: engine lighting equation evaluated with
   *  albedo = 1 (exactly 1 for unlit materials), 1. Linear space. */
  shading: Float32Array;
}

/** Manifest format the Python foundry reads (see inverse.save_gbuffer_bundle
 *  for the matching writer; the TS side writes these buffers to disk with
 *  a small node script, docs/colab/v3-distillation.ipynb documents it). */
export const GBUFFER_FORMAT = 'xr-gbuffer/1';

/** Vertex shader: world position, world normal, UV varyings. Uses the same
 *  attribute locations (0,1,2) as the main renderer so VAOs are shared. */
export const GBUFFER_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uProj;
out vec3 vNormal;
out vec3 vWorldPos;
out vec2 vUv;
void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWorldPos = wp.xyz;
  vNormal = mat3(uModel) * aNormal;
  vUv = aUv;
  gl_Position = uProj * uView * wp;
}
`;

/** Fragment shader: three render targets. The shading math replicates
 *  FRAGMENT_TEMPLATE's lit branch with albedo = vec3(1), so dividing the
 *  observed frame by RT2 recovers albedo exactly (up to float precision).
 *  Unlit materials write shading = 1 (their output IS albedo). */
export const GBUFFER_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorldPos;
in vec2 vUv;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uCamPos;
uniform float uUnlit;
layout(location = 0) out vec4 gUvDepth;
layout(location = 1) out vec4 gNormal;
layout(location = 2) out vec4 gShading;
void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorldPos);
  float viewDepth = length(vWorldPos - uCamPos);
  gUvDepth = vec4(vUv, viewDepth, 1.0);
  gNormal = vec4(N * 0.5 + 0.5, 1.0);
  float diff = max(dot(N, -uLightDir), 0.0);
  vec3 H = normalize(-uLightDir + V);
  float spec = pow(max(dot(N, H), 0.0), 42.0) * 0.35;
  vec3 shade = (0.28 + 0.85 * diff) * uLightColor + spec * uLightColor;
  gShading = vec4(mix(shade, vec3(1.0), uUnlit), 1.0);
}
`;
