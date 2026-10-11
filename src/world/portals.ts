// world/portals.ts — portals as first-class entities + handoff logic.
//
// A portal is an ENTITY (it has a transform, a tag, an id) whose record
// carries a PortalLink: where it leads and where the traveler lands.
// Portals are spawned two ways:
//   1. by the world loader, from the zone descriptor's portal list, or
//   2. by a SCRIPT through its `world` capability:
//        caps.world.spawn('my-gate', { position, tag: 'portal',
//          portal: { targetZone: 'mote-hollow', targetSpawn: [x,y,z],
//                    radius: 3, label: '...' } })
//     (the `portal` spawn option is the minimal step-2 extension to the
//     runtime API — additive, no redesign).
//
// Handoff semantics (crossPortal):
//   - the traveler's ENTITY SURVIVES: same id, same name, same tag —
//     identity is never re-created, so handles and per-entity handlers
//     stay valid across the transition;
//   - transform is re-seated at the target zone's spawn (target zone offset
//     + targetSpawn), rotation/scale preserved;
//   - procedural world-state persists (same runtime), so state continuity is
//     structural; the loader additionally records the crossing;
//   - `portal:exit` fires on the source side, `portal:enter` on arrival —
//     scripts subscribe to these like any other event;
//   - a per-entity cooldown prevents immediate re-triggering when the
//     target spawn sits inside another portal's radius.

import type { ScriptRuntime } from '../script/runtime.js';
import type { TransformData } from '../script/api.js';
import type { Zone } from './zones.js';
import type { Vec3JSON } from './types.js';

/** Where a portal leads. Stored engine-side on the entity record. */
export interface PortalLink {
  targetZone: string;
  targetSpawn: Vec3JSON;
  radius: number;
  label: string;
}

/** A live portal: its entity, its source zone, and its link. */
export interface PortalRecord {
  entityId: number;
  zoneId: string;
  zone: Zone;
  /** Zone-local position of the mouth (from the descriptor). */
  localPosition: Vec3JSON;
  link: PortalLink;
}

/** What happened when a traveler crossed. */
export interface PortalCrossing {
  portalEntityId: number;
  portalLabel: string;
  fromZone: string;
  toZone: string;
  entityId: number;
  entityName: string;
  /** World-space arrival point. */
  arrival: Vec3JSON;
  /** How many times this entity has crossed (state continuity proof). */
  crossings: number;
}

const TRAVELER_TAGS = new Set(['player', 'traveler']);
const CROSSING_COOLDOWN = 1.0; // seconds

export class PortalHandoff {
  private crossings = new Map<number, number>(); // entityId -> count
  private lastCross = new Map<number, number>(); // entityId -> time

  /** Traveler tags the handoff watches. Hosts may extend this set. */
  readonly travelerTags: Set<string> = new Set(TRAVELER_TAGS);

  /** Per-entity crossing counts (continuity record). */
  crossingCount(entityId: number): number {
    return this.crossings.get(entityId) ?? 0;
  }

  /**
   * Check every portal against every traveler entity; cross whoever stands
   * inside a portal mouth. Returns the crossings that happened this frame.
   */
  update(
    rt: ScriptRuntime,
    portals: PortalRecord[],
    zones: Map<string, Zone>,
    t: number,
  ): PortalCrossing[] {
    const out: PortalCrossing[] = [];
    const travelers = rt.hostEntities().filter((e) => this.travelerTags.has(e.tag));
    if (travelers.length === 0 || portals.length === 0) return out;
    for (const p of portals) {
      const mouth = p.zone.toWorld(p.localPosition);
      for (const tr of travelers) {
        const last = this.lastCross.get(tr.id);
        if (last !== undefined && t - last < CROSSING_COOLDOWN) continue;
        const tf = rt.hostGetTransform(tr.id);
        if (!tf) continue;
        const dx = tf.position[0] - mouth[0];
        const dy = tf.position[1] - mouth[1];
        const dz = tf.position[2] - mouth[2];
        if (dx * dx + dy * dy + dz * dz <= p.link.radius * p.link.radius) {
          const c = this.cross(rt, p, tr.id, tr.name, tf, zones, t);
          if (c) out.push(c);
        }
      }
    }
    return out;
  }

  private cross(
    rt: ScriptRuntime,
    portal: PortalRecord,
    entityId: number,
    entityName: string,
    tf: TransformData,
    zones: Map<string, Zone>,
    t: number,
  ): PortalCrossing | null {
    const target = zones.get(portal.link.targetZone);
    if (!target) return null; // dangling link: no silent teleport
    const fromZone = portal.zoneId;
    rt.emit('portal:exit', {
      portal: portal.link.label || `portal-${portal.entityId}`,
      fromZone,
      entity: entityName,
    });
    const arrival = target.toWorld(portal.link.targetSpawn);
    rt.hostSetTransform(entityId, {
      position: arrival,
      rotation: tf.rotation,
      scale: tf.scale,
    });
    const n = (this.crossings.get(entityId) ?? 0) + 1;
    this.crossings.set(entityId, n);
    this.lastCross.set(entityId, t);
    rt.emit('portal:enter', {
      portal: portal.link.label || `portal-${portal.entityId}`,
      toZone: portal.link.targetZone,
      entity: entityName,
      crossings: n,
    });
    return {
      portalEntityId: portal.entityId,
      portalLabel: portal.link.label,
      fromZone,
      toZone: portal.link.targetZone,
      entityId,
      entityName,
      arrival,
      crossings: n,
    };
  }
}
