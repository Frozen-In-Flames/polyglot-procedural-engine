// world/loader.ts - the composed world loader.
//
// Takes an array of zone descriptors authored INDEPENDENTLY (plain JSON from
// different developers), validates each, instantiates zones against ONE
// shared GlobalField, spawns portal entities, and stitches everything into
// a single coherent world.
//
// Field continuity across seams is structural, not negotiated: every zone
// samples the same GlobalField instance, so the wind at a seam point is
// identical no matter which zone's coordinates you arrive in. Crossing a
// portal feels like the lake changing - local weights shift (gustScale,
// biasWeight, shimmer), the ocean underneath does not.
//
// The loader is engine-side (host privilege): it spawns portal entities via
// ScriptRuntime.spawnHost and drives crossing checks from the main loop.
// Scripts participate through the public API: they spawn/link their own
// portals via caps.world.spawn(..., { portal: {...} }) and observe
// 'portal:exit' / 'portal:enter' events.

import type { ScriptRuntime, TransformData } from '../script/index.js';
import { GlobalField } from './field.js';
import { Zone, loadZoneDescriptors } from './zones.js';
import { PortalHandoff, type PortalRecord, type PortalCrossing } from './portals.js';
import type { ZoneDescriptor, Vec3JSON } from './types.js';

export class ComposedWorld {
  readonly field: GlobalField;
  readonly rt: ScriptRuntime;
  private zones = new Map<string, Zone>();
  private portals: PortalRecord[] = [];
  private handoff = new PortalHandoff();
  /** Zone ids in load order (deterministic). */
  readonly loadOrder: string[] = [];
  /** Entity roster size the last time adoptScriptPortals ran. */
  private lastRosterSize = -1;

  constructor(field: GlobalField, rt: ScriptRuntime) {
    this.field = field;
    this.rt = rt;
  }

  /**
   * Load and stitch zones. Each descriptor is validated; duplicate zone ids
   * are rejected. Portal entities are spawned into the runtime (tag
   * 'portal'); dangling portal links (target zone not loaded) are kept but
   * never fire - crossPortal refuses silent teleports.
   */
  loadZones(descriptors: unknown[]): Zone[] {
    // loadZoneDescriptors validates each descriptor (a bad one fails the
    // whole load loudly) and binds every zone to the ONE shared field.
    const loaded = loadZoneDescriptors(descriptors, this.field);
    for (const zone of loaded) {
      if (this.zones.has(zone.descriptor.id)) {
        throw new Error(`world: duplicate zone id '${zone.descriptor.id}'`);
      }
      this.zones.set(zone.descriptor.id, zone);
      this.loadOrder.push(zone.descriptor.id);
    }
    // Spawn portal entities for every descriptor portal, in load order.
    for (const zone of loaded) {
      const zid = zone.descriptor.id;
      for (const pd of zone.descriptor.portals) {
        const worldPos = zone.toWorld(pd.position);
        const initial: TransformData = {
          position: worldPos,
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        };
        const entityId = this.rt.spawnHost(`portal:${zid}:${pd.id}`, initial, {
          tag: 'portal',
          portal: {
            targetZone: pd.targetZone,
            targetSpawn: pd.targetSpawn,
            radius: pd.radius,
            label: pd.label || `${zid} -> ${pd.targetZone}`,
          },
        });
        this.portals.push({
          entityId,
          zoneId: zid,
          zone,
          localPosition: pd.position,
          link: {
            targetZone: pd.targetZone,
            targetSpawn: pd.targetSpawn,
            radius: pd.radius,
            label: pd.label || `${zid} -> ${pd.targetZone}`,
          },
        });
      }
    }
    return loaded;
  }

  getZone(id: string): Zone | null {
    return this.zones.get(id) ?? null;
  }

  get zoneIds(): string[] { return [...this.loadOrder]; }

  get portalRecords(): readonly PortalRecord[] { return this.portals; }

  get portalHandoff(): PortalHandoff { return this.handoff; }

  /** Drive portal crossings for one frame. Returns crossings this frame. */
  update(_dt: number, t: number): PortalCrossing[] {
    // Zones re-derive lazily on field revision changes (sync() in localWind
    // etc.), but portal mouths follow zone placement which is static - no
    // per-frame zone work needed here beyond the handoff.
    this.adoptScriptPortals();
    return this.handoff.update(this.rt, this.portals, this.zones, t);
  }

  /**
   * Adopt portals spawned by SCRIPTS (step-3 API fix). A script links a
   * portal through its `world` capability; the link lands on the entity
   * record, but the loader's stitched set never saw it - so the handoff
   * ignored script-spawned portals entirely. This scan picks up every live
   * entity tagged 'portal' carrying a link and stitches it in, bound to
   * the nearest zone (mouth coordinates are re-expressed zone-local so the
   * handoff's seam math keeps working). Runs at the top of update(); it is
   * O(entity count) only when the entity roster changed.
   */
  adoptScriptPortals(): void {
    const roster = this.rt.hostEntities();
    if (roster.length === this.lastRosterSize) return;
    this.lastRosterSize = roster.length;
    const known = new Set(this.portals.map((p) => p.entityId));
    for (const e of roster) {
      if (e.tag !== 'portal' || known.has(e.id)) continue;
      const link = this.rt.portalLink(e.id);
      if (!link) continue;
      const tf = this.rt.hostGetTransform(e.id);
      if (!tf) continue;
      const zone = this.nearestZone(tf.position);
      if (!zone) continue;
      this.portals.push({
        entityId: e.id,
        zoneId: zone.descriptor.id,
        zone,
        localPosition: zone.toLocal(tf.position),
        link,
      });
      known.add(e.id);
    }
  }

  /** Nearest zone to a world point, by placement offset (2D). */
  private nearestZone(p: Vec3JSON): Zone | null {
    let best: Zone | null = null;
    let bestD = Infinity;
    for (const z of this.zones.values()) {
      const o = z.descriptor.placement.offset;
      const dx = p[0] - o[0], dz = p[2] - o[2];
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = z; }
    }
    return best;
  }

  /**
   * Seam continuity probe: sample the GLOBAL field at the same world point
   * through two different zones. Must be bit-identical - this is the
   * multi-developer coherence guarantee made testable.
   */
  seamSample(zoneA: string, zoneB: string, worldPoint: Vec3JSON, t: number): {
    a: { x: number; y: number; z: number };
    b: { x: number; y: number; z: number };
    identical: boolean;
  } {
    const za = this.zones.get(zoneA);
    const zb = this.zones.get(zoneB);
    if (!za || !zb) throw new Error('world: seamSample needs two loaded zones');
    const a = za.globalWindAt(za.toLocal(worldPoint), t);
    const b = zb.globalWindAt(zb.toLocal(worldPoint), t);
    return {
      a, b,
      identical: a.x === b.x && a.y === b.y && a.z === b.z,
    };
  }

  /** Deterministic summary of the composed world (tests, snapshots). */
  snapshot(): Record<string, unknown> {
    return {
      globalSeed: this.field.snapshot().globalSeed,
      fieldRevision: this.field.revision,
      zones: this.loadOrder.map((id) => this.zones.get(id)!.summarize()),
      portals: this.portals.map((p) => ({
        entityId: p.entityId,
        zoneId: p.zoneId,
        worldPosition: p.zone.toWorld(p.localPosition),
        targetZone: p.link.targetZone,
        targetSpawn: [...p.link.targetSpawn],
        radius: p.link.radius,
      })),
    };
  }
}

// Re-export the descriptor type for consumers (value import above is enough
// for the bundler; this keeps the public surface explicit).
export type { ZoneDescriptor };
