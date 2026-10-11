// games/first-light/scripts/motes.ts — the drifting motes.
//
// Motes are the air made visible: advected through caps.field.wind, they
// cluster and stream with the wind's spatial structure — differently in
// different subsections, per the wind correction. In the foundry they hang
// dense, so the player's wake (the 7th lever) reads as a visible stirring.

import type { Caps, CapabilityName, ScriptDef, SpawnBody } from '../../../src/script/index.js';
import { MOTE_FIELDS } from '../shared.js';

export const MOTE_GRANTS: CapabilityName[] = [
  'rng', 'time', 'world.spawn', 'world.query', 'world.state',
  'events', 'log', 'field.read', 'probe',
];

const MOTE_BODY: SpawnBody = {
  geometry: { kind: 'sphere', radius: 0.09, detail: 6 },
  material: {
    baseColor: [0.65, 0.82, 1.0] as [number, number, number],
    unlit: true,
  },
};

interface MoteHome { cx: number; cz: number }

export const motesScript: ScriptDef = {
  name: 'fl:motes',

  start(caps: Caps): void {
    for (const [cx, cz, count] of MOTE_FIELDS) {
      for (let i = 0; i < count; i++) {
        const x = cx + (caps.rng() - 0.5) * 100;
        const z = cz + (caps.rng() - 0.5) * 100;
        caps.world.spawn(`mote:${cx}:${cz}:${i}`, {
          position: [x, 2 + caps.rng() * 8, z],
          tag: 'mote',
          body: MOTE_BODY,
        });
      }
    }
  },

  update(caps: Caps, dt: number, t: number): void {
    const player = caps.world.find('player');
    const ppos = player ? player.getTransform().position : null;
    for (const m of caps.world.query('mote')) {
      const tr = m.getTransform();
      const [x, y, z] = tr.position;
      // Home field from the entity name: 'mote:<cx>:<cz>:<i>'.
      const parts = m.name.split(':');
      const cx = Number(parts[1]) || 0;
      const cz = Number(parts[2]) || 0;
      const w = caps.field.wind([x, y, z], t);
      let nx = x + w[0] * dt * 0.6;
      let ny = y + w[1] * dt * 0.4 + Math.sin(t * 0.9 + x * 0.1) * dt * 0.3;
      let nz = z + w[2] * dt * 0.6;
      // Keep motes out of the player's face: a mote inside the near plane
      // smears across the whole frame. They part around the walker.
      if (ppos) {
        const dx = nx - ppos[0], dz = nz - ppos[2];
        const d = Math.hypot(dx, dz);
        if (d < 2 && d > 1e-6) {
          const push = (2 - d) * 3 * dt;
          nx += (dx / d) * push;
          nz += (dz / d) * push;
        }
      }
      // Wrap inside the home box so fields stay populated.
      if (nx < cx - 55) nx += 110; else if (nx > cx + 55) nx -= 110;
      if (nz < cz - 55) nz += 110; else if (nz > cz + 55) nz -= 110;
      const ground = caps.probe.ground(nx, nz);
      ny = Math.max(ground + 0.3, Math.min(ground + 14, ny));
      m.setTransform({ position: [nx, ny, nz], rotation: tr.rotation, scale: tr.scale });
    }
    void dt;
  },
};
