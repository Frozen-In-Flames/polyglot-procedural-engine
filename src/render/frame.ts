// render/frame.ts - the frame marcher: a scanline of columns over a layer
// scene, with resolution as live dials and hookable stages.
//
// The render is dataflow: rays (samples) -> hits -> columns. FrameMarcher
// owns a params object (the dials): columns, steps, field of view, max
// distance, epsilon, march policy. Mutate a dial and render again; nothing
// recompiles, nothing rebuilds. Defaults reproduce marchScene with default
// MarchOpts exactly, column for column.
//
// Hooks let a dev insert their own math at two stages without forking:
// hitTest can override the hit for a ray (return undefined to decline),
// shadeColumn maps a finished column's hit to its final color.
import type { Vec3 } from '../math/vec.js';
import {
  marchScene,
  pinholeRay,
  MARCH_STEPS,
  MARCH_EPS,
  MARCH_MAX_DIST,
  type Layer,
  type LayerHit,
  type MarchOpts,
  type MarchPolicy,
  type MarchStats,
  type PinholeCam,
  type Ray,
} from '../scene/layers.js';
import {
  rayTelemetry,
  summarizeFrame,
  type FrameTelemetry,
  type RayTelemetry,
} from './telemetry.js';

export interface FrameParams {
  /** Rays per frame (the scanline resolution). */
  columns: number;
  /** March step budget per ray (dial for MarchOpts.steps). */
  steps: number;
  /** Max march distance. */
  maxDist: number;
  /** Hit epsilon. */
  eps: number;
  /** Vertical field of view in radians; overrides the camera's at render. */
  fovY: number;
  policy: MarchPolicy;
  /** Sample spacing for policy 'fixed'. */
  fixedStep: number;
}

export const DEFAULT_FRAME_PARAMS: FrameParams = {
  columns: 90,
  steps: MARCH_STEPS,
  maxDist: MARCH_MAX_DIST,
  eps: MARCH_EPS,
  fovY: Math.PI / 3,
  policy: 'sphere',
  fixedStep: 0.1,
};

export interface Column {
  /** Normalized device x in [-1, 1] this column was cast at. */
  nx: number;
  depth: number;
  color: Vec3;
  kind: LayerHit['kind'];
  layer: number;
  telemetry: RayTelemetry;
}

export interface Frame {
  columns: Column[];
  telemetry: FrameTelemetry;
}

export interface HitHookCtx {
  index: number;
  nx: number;
  ray: Ray;
  /** The hit the engine computed; the hook's fallback and reference. */
  defaultHit: LayerHit;
}

export interface ShadeHookCtx {
  index: number;
  nx: number;
  ray: Ray;
  hit: LayerHit;
  telemetry: RayTelemetry;
}

export interface FrameHooks {
  /** Return a hit to override the engine's for this ray, or
   *  undefined/null to keep the engine's hit. */
  hitTest?: (ctx: HitHookCtx) => LayerHit | null | undefined;
  /** Map a finished column to its final color. */
  shadeColumn?: (ctx: ShadeHookCtx) => Vec3;
}

/**
 * Scanline frame renderer over a layer scene. One horizontal row of
 * columns through the camera's center (ny = 0): the column view of the
 * world, and the unit the dials, telemetry and hooks all speak in.
 */
export class FrameMarcher {
  params: FrameParams;

  constructor(params: Partial<FrameParams> = {}) {
    this.params = { ...DEFAULT_FRAME_PARAMS, ...params };
  }

  render(cam: PinholeCam, layers: Layer[], hooks: FrameHooks = {}): Frame {
    const p = this.params;
    const effCam: PinholeCam = { ...cam, fovY: p.fovY };
    const marchOpts: MarchOpts = {
      steps: p.steps,
      maxDist: p.maxDist,
      eps: p.eps,
      policy: p.policy,
      fixedStep: p.fixedStep,
    };
    const columns: Column[] = [];
    const rays: RayTelemetry[] = [];
    for (let i = 0; i < p.columns; i++) {
      const nx = -1 + (2 * i + 1) / p.columns;
      const ray = pinholeRay(effCam, nx, 0);
      const stats: MarchStats = { steps: 0, evals: 0 };
      let hit = marchScene(layers, ray, cam.pos, { ...marchOpts, stats });
      if (hooks.hitTest) {
        const override = hooks.hitTest({ index: i, nx, ray, defaultHit: hit });
        if (override != null) hit = override;
      }
      const tele = rayTelemetry(stats, hit.depth);
      let color = hit.color;
      if (hooks.shadeColumn) {
        color = hooks.shadeColumn({ index: i, nx, ray, hit, telemetry: tele });
      }
      columns.push({ nx, depth: hit.depth, color, kind: hit.kind, layer: hit.layer, telemetry: tele });
      rays.push(tele);
    }
    return { columns, telemetry: summarizeFrame(rays) };
  }
}
