// render/telemetry.ts - march telemetry: the march reports its own work.
//
// Every marched ray can report how many steps it took, what distance it
// found, and what it cost (field evaluations, the unit the XR cost model
// spends). The frame aggregate is exactly the sum of the per-ray values:
// no sampling, no estimation. A dev (or the cost model) reads the same
// numbers the march actually performed.
//
// Cost convention (src/scene/layers.ts, MarchStats): one unit per field
// evaluation. Sphere/fixed tracing costs one eval per step; a hit on an
// SDF layer costs 6 more for the central-difference normal; analytic
// layers (2d, 2.5d, grid) cost 1 eval and 0 steps.
import type { MarchStats } from '../scene/layers.js';

export interface RayTelemetry {
  /** March iterations spent on this ray (summed over layers tried). */
  steps: number;
  /** Hit distance in world units; Infinity on a miss. */
  distance: number;
  hit: boolean;
  /** Field evaluations spent on this ray. */
  cost: number;
}

export interface FrameTelemetry {
  rays: RayTelemetry[];
  totalSteps: number;
  /** Total field evaluations: the frame's cost in cost-model units. */
  totalCost: number;
  hits: number;
  /** Mean hit distance over hit rays only; 0 when nothing was hit. */
  meanHitDistance: number;
}

/** Build one ray's telemetry from a march stats counter and its result. */
export function rayTelemetry(stats: MarchStats, depth: number): RayTelemetry {
  const hit = Number.isFinite(depth);
  return { steps: stats.steps, distance: depth, hit, cost: stats.evals };
}

/** Aggregate per-ray telemetry. Totals are exact sums, by construction. */
export function summarizeFrame(rays: RayTelemetry[]): FrameTelemetry {
  let totalSteps = 0;
  let totalCost = 0;
  let hits = 0;
  let distSum = 0;
  for (const r of rays) {
    totalSteps += r.steps;
    totalCost += r.cost;
    if (r.hit) {
      hits++;
      distSum += r.distance;
    }
  }
  return {
    rays,
    totalSteps,
    totalCost,
    hits,
    meanHitDistance: hits > 0 ? distSum / hits : 0,
  };
}
