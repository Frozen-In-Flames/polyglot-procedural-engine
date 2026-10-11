// world/zones.ts — zone descriptors become live zones.
//
// A Zone is local generation bound to global coherence:
//  - terrain / sky / biome visuals derive from the zone descriptor's OWN
//    seed and params (the developer's local authorship), modulated by the
//    live six-domain field params (scene/genesis/biome levers);
//  - the zone's WIND derives ONLY from the shared GlobalField — the
//    descriptor's wind section contributes weights (biasWeight, gustScale,
//    shimmerStrength), never structure. There is no per-zone wind seed
//    anywhere in this file; parseZoneDescriptor rejects one at the door.
//
// Local wind form:
//
//   localWind(p_local, t) =
//       global(p_world, t) * gustScale
//     + anchorMean * biasWeight
//
// where p_world = p_local + placement.offset and anchorMean is the global
// field averaged over a ring of 8 probes around the zone anchor at t = 0 —
// i.e. the zone's prevailing wind, read off the global ocean, then cached
// per field revision. Two zones at the same world point read the same
// global vector; their local winds differ only by authored weights. That is
// "the lake changing under you" with one ocean underneath.

import { fbm2 } from '../geo/rng.js';
import type { Geometry } from '../scene/components.js';
import { terrain, type WindShimmer } from '../geo/terrain.js';
import { GlobalField } from './field.js';
import {
  parseZoneDescriptor,
  type ZoneDescriptor, type Vec3JSON,
} from './types.js';
import type { WindSample } from './wind.js';

export { parseZoneDescriptor };
export type { ZoneDescriptor };

const ANCHOR_PROBES = 8;
const ANCHOR_RADIUS = 24;

export class Zone {
  readonly descriptor: ZoneDescriptor;
  readonly field: GlobalField;
  /** Field revision the cached derivations were built against. */
  private derivedRevision = -1;
  private anchorMean: WindSample = { x: 0, y: 0, z: 0 };
  private terrainSeed = 0;
  private terrainGeo: Geometry | null = null;

  constructor(descriptor: ZoneDescriptor, field: GlobalField) {
    this.descriptor = descriptor;
    this.field = field;
    this.rederive();
  }

  /** Zone-local -> world coordinates. */
  toWorld(p: Vec3JSON): Vec3JSON {
    const o = this.descriptor.placement.offset;
    return [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
  }

  /** World -> zone-local coordinates. */
  toLocal(p: Vec3JSON): Vec3JSON {
    const o = this.descriptor.placement.offset;
    return [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  }

  /** Recompute everything derived from the live field params. Called on
   *  construction and whenever the field revision moves (foundry writes). */
  rederive(): void {
    const fp = this.field.snapshot();
    const d = this.descriptor;
    // Zone-local generation seed: the developer's seed XOR the live genesis
    // seed, so the genesis lever reshapes the land's bones deterministically.
    this.terrainSeed = (d.seed ^ fp.genesis.seed) >>> 0;
    // The zone's prevailing wind: read off the GLOBAL field, never invented.
    const o = d.placement.offset;
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < ANCHOR_PROBES; i++) {
      const a = (i / ANCHOR_PROBES) * Math.PI * 2;
      const s = this.field.sampleWorld(
        o[0] + Math.cos(a) * ANCHOR_RADIUS,
        o[1],
        o[2] + Math.sin(a) * ANCHOR_RADIUS,
        0,
      );
      mx += s.x; my += s.y; mz += s.z;
    }
    this.anchorMean = {
      x: mx / ANCHOR_PROBES, y: my / ANCHOR_PROBES, z: mz / ANCHOR_PROBES,
    };
    this.terrainGeo = null; // rebuilt lazily — geometry follows the math
    this.derivedRevision = this.field.revision;
  }

  /** Keep derivations fresh against foundry writes. Returns true if a
   *  re-derivation happened. */
  sync(): boolean {
    if (this.derivedRevision !== this.field.revision) {
      this.rederive();
      return true;
    }
    return false;
  }

  /** The zone's prevailing wind vector (global field, anchored). A copy. */
  get prevailingWind(): WindSample { return { ...this.anchorMean }; }

  /**
   * Local wind at a ZONE-LOCAL position and time. Global structure, local
   * weights: the same world point sampled through two zones' localWind
   * differs only by authored weights — the underlying ocean is identical.
   */
  localWind(p: Vec3JSON, t: number): WindSample {
    this.sync();
    const w = this.toWorld(p);
    const g = this.field.sampleWorld(w[0], w[1], w[2], t);
    const { biasWeight, gustScale } = this.descriptor.wind;
    return {
      x: g.x * gustScale + this.anchorMean.x * biasWeight,
      y: g.y * gustScale + this.anchorMean.y * biasWeight,
      z: g.z * gustScale + this.anchorMean.z * biasWeight,
    };
  }

  /** Raw global field at a zone-local position (the coherence primitive —
   *  identical for every zone at the same world point). */
  globalWindAt(p: Vec3JSON, t: number): WindSample {
    const w = this.toWorld(p);
    return this.field.sampleWorld(w[0], w[1], w[2], t);
  }

  // ------------------------------------------------------------------
  // Terrain: the water. The heightfield carries the wind's visible texture
  // (shimmer ripple + normal lean along the local wind), so the pattern
  // reads on the land itself, not just on particles.
  // ------------------------------------------------------------------

  /** Height sampler for this zone's terrain (zone-local x/z -> [0,1]). */
  heightSampler(): (x: number, z: number) => number {
    const d = this.descriptor;
    const fp = this.field.snapshot();
    const freq = d.terrain.baseFrequency * fp.genesis.noiseScale;
    const octaves = Math.min(d.terrain.octaves, fp.genesis.noiseOctaves);
    const seed = this.terrainSeed;
    const rough = d.terrain.roughness;
    return (x, z) => {
      const base = fbm2(x * freq, z * freq, seed, octaves);
      const detail = fbm2(x * freq * 4.1, z * freq * 4.1, seed ^ 0x5bd1e995, 2);
      return base * (1 - rough * 0.5) + detail * (rough * 0.5);
    };
  }

  /** Wind shimmer hook for the terrain builder: a directional ripple whose
   *  wavelength and heading follow the LOCAL wind at bake time t, plus a
   *  normal lean along the wind. Strength scales with the scene lever and
   *  the zone's authored shimmerStrength. */
  windShimmer(t: number): WindShimmer {
    const d = this.descriptor;
    const fp = this.field.snapshot();
    const strength = fp.scene.shimmerStrength * d.wind.shimmerStrength;
    const wavelength = 9; // world units — the water's texture scale
    const k = (Math.PI * 2) / wavelength;
    const amp = 0.05 * strength * d.terrain.height * fp.scene.terrainHeight;
    const lean = 0.12 * strength;
    const windAt = (x: number, z: number): WindSample =>
      this.localWind([x, 0, z], t);
    return {
      ripple: (x, z) => {
        if (strength <= 0) return 0;
        const w = windAt(x, z);
        const mag = Math.hypot(w.x, w.z);
        if (mag < 1e-9) return 0;
        const dx = w.x / mag, dz = w.z / mag;
        const phase = k * (dx * x + dz * z) + 0.8 * t * Math.min(2, mag);
        return amp * Math.min(2, mag) * Math.sin(phase);
      },
      leanX: (x, z) => {
        const w = windAt(x, z);
        const mag = Math.hypot(w.x, w.z);
        return mag < 1e-9 ? 0 : lean * Math.min(1.5, mag) * (w.x / mag);
      },
      leanZ: (x, z) => {
        const w = windAt(x, z);
        const mag = Math.hypot(w.x, w.z);
        return mag < 1e-9 ? 0 : lean * Math.min(1.5, mag) * (w.z / mag);
      },
    };
  }

  /** Build (or rebuild) this zone's terrain geometry with wind texture. */
  buildTerrain(t = 0): Geometry {
    const d = this.descriptor;
    const fp = this.field.snapshot();
    this.terrainGeo = terrain({
      size: d.terrain.size,
      segments: d.terrain.segments,
      height: d.terrain.height * fp.scene.terrainHeight,
      sampler: this.heightSampler(),
      shimmer: this.windShimmer(t),
      generatedBy: 'TypeScript',
    });
    return this.terrainGeo;
  }

  get terrainGeometry(): Geometry | null { return this.terrainGeo; }

  /** Sky tint for this zone, hue-shifted by the light lever. */
  skyTint(): { horizonHue: number; zenithHue: number; starDensity: number } {
    const fp = this.field.snapshot();
    const s = this.descriptor.sky;
    const shift = (h: number): number => (h + fp.scene.skyHueShift + fp.light.hueRotate) % 1;
    return {
      horizonHue: shift(s.horizonHue),
      zenithHue: shift(s.zenithHue),
      starDensity: s.starDensity,
    };
  }

  /** Deterministic summary for tests / snapshots. */
  summarize(): Record<string, unknown> {
    return {
      id: this.descriptor.id,
      offset: [...this.descriptor.placement.offset],
      prevailingWind: [this.anchorMean.x, this.anchorMean.y, this.anchorMean.z],
      terrainSeed: this.terrainSeed,
      sky: this.skyTint(),
      revision: this.derivedRevision,
    };
  }
}

/** Load zones from untrusted JSON descriptors (each validated). */
export function loadZoneDescriptors(
  json: unknown[],
  field: GlobalField,
): Zone[] {
  return json.map((j) => new Zone(parseZoneDescriptor(j), field));
}
