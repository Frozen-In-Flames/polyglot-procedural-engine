// games/first-light/scripts/secret.ts — the stillwater crossing.
//
// PLAIN SIGHT: the portal to the foundry stands across the dark water from
// minute one — no unlock, no reveal, no tool. Crossing it is pure embodied
// skill: the band barely lets the player walk, and the only way across is
// to move WITH the local wind while a gust front passes (the ride lives in
// the player script; the front's envelope in shared.gustFront). The portal
// breathes with the front — the rhythm is visible, never explained.

import type { Caps, CapabilityName, ScriptDef, SpawnBody } from '../../../src/script/index.js';
import { SECRET_PORTAL_POS, gustFront } from '../shared.js';

export const SECRET_GRANTS: CapabilityName[] = [
  'rng', 'time', 'world.spawn', 'world.query', 'world.state',
  'events', 'log', 'field.read', 'probe',
];

export const secretScript: ScriptDef = {
  name: 'fl:secret',

  start(caps: Caps): void {
    // The way through, present from the first minute. The loader adopts it
    // into the stitched set (script-portal auto-adoption, step-3 API fix).
    caps.world.spawn('secret-portal', {
      position: [...SECRET_PORTAL_POS],
      tag: 'portal',
      rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      body: {
        geometry: { kind: 'torus', radius: 2.6, tube: 0.3, detail: 24 },
        material: {
          baseColor: [0.25, 0.85, 0.8] as [number, number, number],
          effects: ['fresnel', 'pulse'] as Array<'fresnel' | 'pulse'>,
        },
      },
      portal: {
        targetZone: 'foundry',
        targetSpawn: [0, 2, -30],
        radius: 3.5,
        label: 'Stillwater Ledge -> The Foundry',
      },
    });
  },

  update(caps: Caps, dt: number, t: number): void {
    // The portal breathes with the gust front: the crossing rhythm reads in
    // the ring itself — in plain sight, unexplained.
    const p = caps.world.find('secret-portal');
    if (p) {
      const tr = p.getTransform();
      const s = 1 + 0.1 * gustFront(t);
      p.setTransform({ ...tr, scale: [s, s, s] });
    }
    void dt;
  },
};
