// scene/components.ts — Mesh, Light, Camera, Script.
import type { Component, SceneNode } from './node.js';
import type { Vec3 } from '../math/vec.js';
import { v3 } from '../math/vec.js';

export interface Geometry {
  positions: Float32Array; // xyz
  normals: Float32Array; // xyz
  uvs: Float32Array; // uv
  indices: Uint32Array;
  /** Which language module generated this geometry (for the pipeline overlay). */
  generatedBy: string;
}

export interface Material {
  name: string;
  /** GLSL functions for file scope (may be empty). */
  helpers: string;
  /** GLSL statements for the top of main(): must declare `vec3 albedo`.
   *  In scope: vNormal, vWorldPos, vUv, N (normalized), V (view dir),
   *  uniforms uLightDir/uLightColor/uCamPos/uTime + material uniforms. */
  body: string;
  uniforms: Record<string, number | number[]>;
  generatedBy: string;
}

export class Mesh implements Component {
  node: SceneNode | null = null;
  constructor(public geometry: Geometry, public material: Material) {}
}

export type LightKind = 'directional' | 'point';

export class Light implements Component {
  node: SceneNode | null = null;
  color: Vec3 = v3(1, 1, 1);
  intensity = 1;
  constructor(public kind: LightKind = 'directional') {}
}

export class Camera implements Component {
  node: SceneNode | null = null;
  fovY = (60 * Math.PI) / 180;
  near = 0.05;
  far = 1000;
  constructor(public aspect = 16 / 9) {}
}

/** Script hook — the seam the C# ScriptProvider implements against. */
export abstract class Script implements Component {
  node: SceneNode | null = null;
  start(): void {}
  abstract update(dt: number, t: number): void;
}
