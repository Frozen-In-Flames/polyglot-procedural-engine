// material/shader.ts — compose GLSL fragment snippets into procedural materials.
// No texture files: every visual is math evaluated per-pixel.
import type { Material } from '../scene/components.js';

export type EffectKind = 'noise' | 'fresnel' | 'grid' | 'heightRamp' | 'pulse' | 'sky';

export interface MaterialSpec {
  baseColor: [number, number, number];
  effects: EffectKind[];
  /** Which language module authored this material (pipeline overlay). */
  generatedBy?: string;
  /** Skip lighting: output albedo directly (sky, glow sprites). */
  unlit?: boolean;
}

const NOISE_GLSL = `
// hash + value noise (generated snippet)
float xg_hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float xg_noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(xg_hash(i), xg_hash(i + vec2(1,0)), u.x),
             mix(xg_hash(i + vec2(0,1)), xg_hash(i + vec2(1,1)), u.x), u.y);
}
`;

export function buildMaterial(spec: MaterialSpec): Material {
  const gen = spec.generatedBy ?? 'TypeScript';
  const [r, g, b] = spec.baseColor;
  let helpers = '';
  let body = `  vec3 albedo = vec3(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)});\n`;
  const uniforms: Record<string, number | number[]> = {};

  for (const fx of spec.effects) {
    switch (fx) {
      case 'noise':
        helpers += NOISE_GLSL;
        body += `  albedo *= 0.75 + 0.5 * xg_noise(vUv * 24.0 + uTime * 0.05);\n`;
        break;
      case 'fresnel':
        body += `  float fr = pow(1.0 - abs(dot(N, V)), 2.5);\n`;
        body += `  albedo += fr * vec3(0.35, 0.75, 1.0);\n`;
        break;
      case 'grid':
        body += `  vec2 gp = abs(fract(vUv * 32.0) - 0.5);\n`;
        body += `  float gl = smoothstep(0.48, 0.5, max(gp.x, gp.y));\n`;
        body += `  albedo = mix(albedo, vec3(0.1, 0.9, 1.0), gl * 0.85);\n`;
        break;
      case 'heightRamp':
        body += `  float hh = clamp(vWorldPos.y * 0.12 + 0.5, 0.0, 1.0);\n`;
        body += `  albedo = mix(albedo * 0.45, albedo * 1.25 + vec3(0.06, 0.05, 0.02), hh);\n`;
        break;
      case 'pulse':
        uniforms.uTime = 0;
        body += `  albedo *= 0.85 + 0.15 * sin(uTime * 2.0 + vWorldPos.x * 0.8 + vWorldPos.z * 0.6);\n`;
        break;
      case 'sky': {
        helpers += NOISE_GLSL;
        body += `  vec3 sd = normalize(vWorldPos - uCamPos);\n`;
        body += `  float sh = clamp(sd.y, -1.0, 1.0);\n`;
        body += `  albedo = mix(vec3(0.10, 0.15, 0.26), vec3(0.012, 0.035, 0.09), smoothstep(-0.08, 0.6, sh));\n`;
        body += `  albedo += vec3(0.10, 0.07, 0.10) * pow(1.0 - abs(sh), 6.0);\n`;
        body += `  vec2 sp = sd.xz / (abs(sd.y) + 0.4);\n`;
        body += `  vec2 cell = floor(sp * 160.0);\n`;
        body += `  float hstar = xg_hash(cell);\n`;
        body += `  float star = step(0.997, hstar);\n`;
        body += `  float tw = 0.55 + 0.45 * sin(uTime * 2.5 + hstar * 43.0);\n`;
        body += `  albedo += star * tw * smoothstep(0.03, 0.35, sh) * vec3(0.85, 0.92, 1.0);\n`;
        break;
      }
    }
  }

  return {
    name: `proc-${spec.unlit ? 'unlit-' : ''}${spec.effects.join('+') || 'flat'}`,
    helpers,
    body,
    uniforms,
    generatedBy: gen,
    unlit: spec.unlit ?? false,
  };
}

/** Full fragment shader template. Helpers go at file scope, body at the top
 *  of main() where N, V, and albedo are in scope. Unlit materials output
 *  albedo directly (sky, glow). */
export const FRAGMENT_TEMPLATE = (helpers: string, body: string, unlit = false) => `
precision mediump float;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec2 vUv;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uCamPos;
uniform float uTime;
${helpers}
void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorldPos);
${body}
${unlit
  ? `  gl_FragColor = vec4(albedo, 1.0);`
  : `  float diff = max(dot(N, -uLightDir), 0.0);
  vec3 H = normalize(-uLightDir + V);
  float spec = pow(max(dot(N, H), 0.0), 42.0) * 0.35;
  vec3 col = albedo * (0.28 + 0.85 * diff) * uLightColor + spec * uLightColor;
  gl_FragColor = vec4(col, 1.0);`}
}
`;

export const VERTEX_SHADER = `
precision mediump float;
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uProj;
varying vec3 vNormal;
varying vec3 vWorldPos;
varying vec2 vUv;
void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWorldPos = wp.xyz;
  vNormal = mat3(uModel) * aNormal;
  vUv = aUv;
  gl_Position = uProj * uView * wp;
}
`;
