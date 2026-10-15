// bridge/providers.ts — the seams other languages implement.
//
// TypeScript is the v1 host. Each provider interface below has a concrete
// implementation in its language's directory:
//   ScriptProvider  -> dotnet/  (C#)
//   SessionProvider -> swift/   (Swift, visionOS) and kotlin/ (Kotlin, Android XR)
//   GenCore        -> native/  (C++ -> WASM in v1, native post-v1)
import type { SceneNode } from '../scene/node.js';
import type { Vec3 } from '../math/vec.js';

/** Procedural generation core. Pure functions of (seed, params). */
export interface GenCore {
  /** Human-readable tag for the pipeline overlay, e.g. "C++ (WASM)". */
  readonly languageTag: string;
  /** Fill `out` (length w*h) with heightfield values in [0,1]. */
  heightfield(seed: number, w: number, h: number, features: number, octaves: number, out: Float32Array): void;
  /** Fill `out` (length n) with 1D noise in [0,1]. */
  noise1D(seed: number, n: number, out: Float32Array): void;
  /** Render `n` mono synth-voice samples into `out` ([-1,1]). Pure DSP. */
  dspVoice(seed: number, n: number, sampleRate: number, out: Float32Array): void;
  /** True once the backend is ready (WASM compiled/instantiated). */
  readonly ready: boolean;
}

/** Scene scripting. C# implements this via dotnet/. */
export interface ScriptProvider {
  readonly languageTag: string;
  /** Create a script instance bound to a node. */
  create(name: string, node: SceneNode): ScriptHandle;
}

export interface ScriptHandle {
  start(): void;
  update(dt: number, t: number): void;
  dispose(): void;
}

export type XRMode = 'inline' | 'immersive-vr' | 'immersive-ar';

/** Per-frame callback from a session. */
export type FrameCallback = (views: RenderView[], time: number) => void;

export interface RenderView {
  view: Float32Array; // view matrix
  proj: Float32Array; // projection matrix
  viewport: [number, number, number, number]; // device px
}

/** XR session abstraction. WebXR is the v1 host implementation;
 *  Swift (visionOS) and Kotlin (Android XR) conform post-v1. */
export interface SessionProvider {
  readonly languageTag: string;
  readonly supportedModes: XRMode[];
  requestSession(mode: XRMode, canvas: HTMLCanvasElement): Promise<XRSessionHandle>;
}

export interface XRSessionHandle {
  readonly mode: XRMode;
  /** Register the per-frame callback. The session drives the loop. */
  onFrame(cb: FrameCallback): void;
  /** AR hit test against real-world surfaces using the latest frame.
   *  Returns null when unsupported or no hit. */
  hitTest?(origin: Vec3, dir: Vec3): Vec3 | null;
  /** Controller snapshots for the V9 unified input system. Empty for
   *  inline sessions. */
  getInputSources?(): XRControllerState[];
  /** Locomotion provider for the V9 unified input system: the session
   *  applies the returned planar offset (x, z, yaw) to its reference
   *  space each frame. Null disables. Only meaningful for XR sessions. */
  setLocomotion?(get: (() => { x: number; z: number; yaw: number } | null)): void;
  /** Fired when the platform XR session ends (system UI exit). */
  onEnd?(cb: () => void): void;
  end(): Promise<void>;
}

/** Minimal controller snapshot shared by the V9 input schemes. Mirrors
 *  input/XRInputScheme's XRControllerState without importing it (the
 *  bridge stays dependency-light). */
export interface XRControllerState {
  handedness: 'left' | 'right' | 'none';
  axes: number[];
  buttons: boolean[];
}
