// games/first-light/scripts/foundry.ts — the six levers' pedestals.
//
// The authorship room's furniture. Six pedestals, one per engine language,
// spawned by the game (perception-tier grants — foundry.ts itself cannot
// write any domain). The six LEVER scripts (levers.ts) carry the top-tier
// write grants and are loaded progressively as attunement crosses its six
// thresholds; each wakes its pedestal with a ring of light and answers the
// player's hand through caps.field.set.

import type { Caps, CapabilityName, ScriptDef, SpawnBody } from '../../../src/script/index.js';
import { LEVER_POS } from '../shared.js';

export const FOUNDRY_GRANTS: CapabilityName[] = [
  'rng', 'time', 'world.spawn', 'world.query', 'world.state',
  'events', 'audio', 'log', 'field.read', 'probe',
];

export const foundryScript: ScriptDef = {
  name: 'fl:foundry',

  start(caps: Caps): void {
    for (let i = 0; i < LEVER_POS.length; i++) {
      const [x, , z] = LEVER_POS[i];
      const ground = caps.probe.ground(x, z);
      // Pedestal: dark stone box.
      caps.world.spawn(`lever-base:${i}`, {
        position: [x, ground + 1.1, z],
        tag: 'lever',
        body: {
          geometry: { kind: 'box', size: [1.7, 2.2, 1.7], detail: 1 },
          material: {
            baseColor: [0.16, 0.15, 0.2] as [number, number, number],
            effects: ['noise'] as Array<'noise'>,
          },
        },
      });
      // Handle: a dim amber sphere that the lever script will raise/lower.
      // Dormant until its threshold: present, unlit, waiting.
      caps.world.spawn(`lever-handle:${i}`, {
        position: [x, ground + 2.6, z],
        tag: 'lever',
        body: {
          geometry: { kind: 'sphere', radius: 0.55, detail: 12 },
          material: {
            baseColor: [0.45, 0.28, 0.1] as [number, number, number],
            unlit: true,
          },
        },
      });
    }
    caps.world.setState('foundry:held', -1);
    caps.events.on('input:interact', () => {
      const held = (caps.world.state('foundry:held') as number | undefined) ?? -1;
      if (held >= 0) {
        // Release.
        caps.world.setState('foundry:held', -1);
        caps.events.emit('lever:released', {});
        return;
      }
      // Grab the nearest awake lever within reach.
      const ppos = (caps.world.state('player:pos') as [number, number, number] | undefined);
      if (!ppos) return;
      let best = -1, bestD = 4.5;
      for (let i = 0; i < LEVER_POS.length; i++) {
        const awake = (caps.world.state(`foundry:unlocked:${i}`) as number | undefined) ?? 0;
        if (!awake) continue;
        const [x, , z] = LEVER_POS[i];
        const d = Math.hypot(ppos[0] - x, ppos[2] - z);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) {
        caps.world.setState('foundry:held', best);
        caps.events.emit('lever:grabbed', { index: best });
        caps.audio.note({ t: 0, dur: 0.4, freq: 392, kind: 'tone', gain: 0.3 });
      }
    });
  },

  update(caps: Caps, _dt: number, _t: number): void {
    // Pedestals are static; the lever scripts drive their own handles.
    // This update exists so the script stays loaded and responsive.
    void caps; void _dt; void _t;
  },
};
