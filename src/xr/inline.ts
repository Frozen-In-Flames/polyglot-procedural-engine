// xr/inline.ts — desktop fallback: renders the scene camera to the canvas
// with a normal requestAnimationFrame loop. Same SessionProvider seam.
import type {
  SessionProvider, XRSessionHandle, XRMode, FrameCallback, RenderView,
} from '../bridge/providers.js';
import type { SceneNode } from '../scene/node.js';
import { Camera } from '../scene/components.js';
import { perspective, lookAt } from '../math/mat.js';
import { v3 } from '../math/vec.js';

class InlineSession implements XRSessionHandle {
  readonly mode: XRMode = 'inline';
  private raf = 0;
  private running = false;
  private view = new Float32Array(16);
  private proj = new Float32Array(16);

  constructor(
    private canvas: HTMLCanvasElement,
    private camNode: SceneNode,
    private camera: Camera,
  ) {}

  onFrame(cb: FrameCallback): void {
    if (this.running) return;
    this.running = true;
    const loop = (t: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const w = this.canvas.width, h = this.canvas.height;
      this.camera.aspect = w / Math.max(1, h);
      perspective(this.camera.fovY, this.camera.aspect, this.camera.near, this.camera.far, this.proj);
      const p = this.camNode.worldMatrix;
      const px = p[12], py = p[13], pz = p[14];
      // Camera looks along its local -Z axis.
      const dx = -p[8], dy = -p[9], dz = -p[10];
      lookAt([px, py, pz], [px + dx, py + dy, pz + dz], v3(0, 1, 0), this.view);
      const views: RenderView[] = [{ view: this.view, proj: this.proj, viewport: [0, 0, w, h] }];
      cb(views, t / 1000);
    };
    this.raf = requestAnimationFrame(loop);
  }

  async end(): Promise<void> {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}

export class InlineProvider implements SessionProvider {
  readonly languageTag = 'TypeScript (inline)';
  readonly supportedModes: XRMode[] = ['inline'];

  constructor(private camNode: SceneNode, private camera: Camera) {
    if (!(camera instanceof Camera)) throw new Error('InlineProvider needs a Camera');
  }

  async requestSession(_mode: XRMode, canvas: HTMLCanvasElement): Promise<XRSessionHandle> {
    void _mode;
    return new InlineSession(canvas, this.camNode, this.camera);
  }
}
