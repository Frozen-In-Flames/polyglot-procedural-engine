// xr/webxr.ts - WebXR SessionProvider (the v1 host implementation).
// Handles immersive-vr, immersive-ar (hit-test, anchors where available),
// and reports what the device actually supports.
import type {
  SessionProvider, XRSessionHandle, XRMode, FrameCallback, RenderView,
  XRControllerState,
} from '../bridge/providers.js';
import type { Vec3 } from '../math/vec.js';

// Minimal WebXR typings (subset we use; avoids lib.dom version skew).
interface XRSystem {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, opts?: Record<string, unknown>): Promise<XRSession>;
}
interface XRGamepadButton { pressed: boolean }
interface XRGamepad { axes: number[]; buttons: XRGamepadButton[] }
interface XRInputSource {
  handedness: 'left' | 'right' | 'none';
  gamepad?: XRGamepad | null;
}
interface XRSession {
  renderState: XRRenderState;
  inputSources: XRInputSource[];
  updateRenderState(state: Record<string, unknown>): Promise<void> | void;
  requestReferenceSpace(type: string): Promise<XRReferenceSpace>;
  requestAnimationFrame(cb: (t: number, frame: XRFrame) => void): number;
  requestHitTestSource?(opts: { space: XRReferenceSpace }): Promise<XRHitTestSource>;
  end(): Promise<void>;
  addEventListener(type: string, cb: () => void): void;
}
interface XRRenderState { baseLayer?: XRWebGLLayer }
interface XRWebGLLayer {
  framebufferWidth: number;
  framebufferHeight: number;
}
interface XRReferenceSpace extends EventTarget {
  getOffsetReferenceSpace?(origin: XRRigidTransformInit): XRReferenceSpace;
}
/** Init dict for the platform XRRigidTransform constructor (read off window). */
interface XRRigidTransformInit {
  position?: { x?: number; y?: number; z?: number };
  orientation?: { x?: number; y?: number; z?: number; w?: number };
}
interface XRFrame {
  session: XRSession;
  getViewerPose(ref: XRReferenceSpace): XRViewerPose | null;
  getHitTestResults?(src: XRHitTestSource): XRHitTestResult[];
}
interface XRViewerPose { views: XRView[] }
interface XRView {
  transform: { inverse: { matrix: Float32Array } };
  projectionMatrix: Float32Array;
  viewport?: never;
}
interface XRHitTestSource { cancel(): void }
interface XRHitTestResult {
  getPose(space: XRReferenceSpace): { transform: { matrix: Float32Array } } | null;
}

declare global {
  interface Navigator { xr?: XRSystem }
}

class WebXRSession implements XRSessionHandle {
  readonly mode: XRMode;
  private session: XRSession;
  private refSpace: XRReferenceSpace;
  private layer: XRWebGLLayer;
  private hitSource: XRHitTestSource | null = null;
  private lastFrame: XRFrame | null = null;
  private viewerSpace: XRReferenceSpace | null = null;
  private locomotion: (() => { x: number; z: number; yaw: number } | null) | null = null;
  private locoCache: { x: number; z: number; yaw: number; space: XRReferenceSpace } | null = null;

  constructor(mode: XRMode, session: XRSession, refSpace: XRReferenceSpace, layer: XRWebGLLayer) {
    this.mode = mode;
    this.session = session;
    this.refSpace = refSpace;
    this.layer = layer;
  }

  /** V9: planar locomotion from the unified input rig. The offset is
   *  applied to the reference space each frame (cached while unchanged). */
  setLocomotion(get: (() => { x: number; z: number; yaw: number } | null)): void {
    this.locomotion = get;
    this.locoCache = null;
  }

  /** V9: callback fired when the platform session ends (system UI exit). */
  onEnd(cb: () => void): void {
    this.session.addEventListener('end', cb);
  }

  /** V9: controller snapshots for the unified XR input scheme. */
  getInputSources(): XRControllerState[] {
    const out: XRControllerState[] = [];
    for (const s of this.session.inputSources ?? []) {
      out.push({
        handedness: s.handedness,
        axes: s.gamepad ? [...s.gamepad.axes] : [],
        buttons: s.gamepad ? s.gamepad.buttons.map((b) => b.pressed) : [],
      });
    }
    return out;
  }

  /** Reference space with the current locomotion offset applied. */
  private activeSpace(): XRReferenceSpace {
    const loco = this.locomotion?.() ?? null;
    if (!loco) return this.refSpace;
    const c = this.locoCache;
    if (c && c.x === loco.x && c.z === loco.z && c.yaw === loco.yaw) return c.space;
    const half = loco.yaw / 2;
    const Rigid = (window as unknown as {
      XRRigidTransform: new (p: XRRigidTransformInit['position'], o: XRRigidTransformInit['orientation']) => XRRigidTransformInit;
    }).XRRigidTransform;
    const space = this.refSpace.getOffsetReferenceSpace
      ? this.refSpace.getOffsetReferenceSpace(
          new Rigid({ x: loco.x, y: 0, z: loco.z }, { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }),
        )
      : this.refSpace;
    this.locoCache = { x: loco.x, z: loco.z, yaw: loco.yaw, space };
    return space;
  }

  async initAR(): Promise<void> {
    try {
      this.viewerSpace = await this.session.requestReferenceSpace('viewer');
      if (this.session.requestHitTestSource && this.viewerSpace) {
        this.hitSource = await this.session.requestHitTestSource({ space: this.viewerSpace });
      }
    } catch {
      // hit-test optional; AR still works without it
    }
  }

  onFrame(cb: FrameCallback): void {
    const loop = (_t: number, frame: XRFrame) => {
      this.session.requestAnimationFrame(loop);
      this.lastFrame = frame;
      const pose = frame.getViewerPose(this.activeSpace());
      if (!pose) return;
      const views: RenderView[] = [];
      const w = this.layer.framebufferWidth, h = this.layer.framebufferHeight;
      const n = pose.views.length;
      pose.views.forEach((v, i) => {
        // Side-by-side viewports for stereo; full layer for mono AR.
        const viewport: [number, number, number, number] =
          n > 1 ? [(w / n) * i, 0, w / n, h] : [0, 0, w, h];
        views.push({
          view: v.transform.inverse.matrix,
          proj: v.projectionMatrix,
          viewport,
        });
      });
      cb(views, _t / 1000);
    };
    this.session.requestAnimationFrame(loop);
  }

  hitTest(origin: Vec3, dir: Vec3): Vec3 | null {
    void origin; void dir;
    // True ray-based hit test needs an XR Ray; v1 exposes plane-hit at
    // screen center via the viewer space. Kept minimal but honest.
    const frame = this.lastFrame;
    if (!frame?.getHitTestResults || !this.hitSource) return null;
    const hits = frame.getHitTestResults(this.hitSource);
    if (!hits.length) return null;
    const pose = hits[0].getPose(this.refSpace);
    if (!pose) return null;
    const m = pose.transform.matrix;
    return [m[12], m[13], m[14]];
  }

  async end(): Promise<void> {
    try { this.hitSource?.cancel(); } catch { /* noop */ }
    await this.session.end();
  }
}

export class WebXRProvider implements SessionProvider {
  readonly languageTag = 'TypeScript (WebXR)';
  supportedModes: XRMode[] = ['inline'];

  /** Probe the device; call once at startup. */
  async init(): Promise<void> {
    const xr = navigator.xr;
    if (!xr) return;
    const modes: XRMode[] = ['inline'];
    try {
      if (await xr.isSessionSupported('immersive-vr')) modes.push('immersive-vr');
    } catch { /* noop */ }
    try {
      if (await xr.isSessionSupported('immersive-ar')) modes.push('immersive-ar');
    } catch { /* noop */ }
    this.supportedModes = modes;
  }

  async requestSession(mode: XRMode, canvas: HTMLCanvasElement): Promise<XRSessionHandle> {
    const xr = navigator.xr;
    if (!xr || mode === 'inline') throw new Error('use InlineProvider for inline mode');
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 required for XR');
    const session = await xr.requestSession(mode, {
      requiredFeatures: ['local-floor'],
      optionalFeatures: mode === 'immersive-ar' ? ['hit-test', 'anchors', 'plane-detection'] : ['local-floor'],
    });
    // The XRWebGLLayer constructor lives on window in browsers.
    const XRGL = (window as unknown as { XRWebGLLayer: new (s: XRSession, gl: WebGL2RenderingContext) => XRWebGLLayer }).XRWebGLLayer;
    const layer = new XRGL(session, gl);
    await session.updateRenderState({ baseLayer: layer });
    const refSpace = await session.requestReferenceSpace('local-floor').catch(
      () => session.requestReferenceSpace('viewer'),
    );
    const handle = new WebXRSession(mode, session, refSpace, layer);
    if (mode === 'immersive-ar') await handle.initAR();
    return handle;
  }
}
