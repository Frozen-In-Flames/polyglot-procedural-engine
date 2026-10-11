// games/first-light/zones.ts — the game's zone set as plain JSON documents,
// the way independent developers author them. The three linked sample zones
// come straight from the engine's world module (untouched); the fourth, the
// foundry, is authored here by the game — same format, same validation, no
// engine internals.

import { SAMPLE_ZONE_JSON } from '../../src/world/index.js';
import type { ZoneDescriptor } from '../../src/world/index.js';

/** The foundry: the authorship room. Calm local weights (a workshop, not a
 *  storm), dense motes so the player's wake reads in the air, one return
 *  portal to mote-hollow. */
export const FOUNDRY_ZONE: ZoneDescriptor = {
  id: 'foundry',
  displayName: 'The Foundry',
  seed: 60013,
  placement: { offset: [0, 0, 240] },
  bounds: { min: [-50, 0, -50], max: [50, 30, 50] },
  terrain: {
    size: 100, segments: 40, height: 4,
    baseFrequency: 0.05, octaves: 3, roughness: 0.3,
  },
  sky: { horizonHue: 0.58, zenithHue: 0.66, starDensity: 0.4 },
  biome: { name: 'foundry', moteDensity: 0.9, emberDrift: 0.5 },
  // Still air, gentle gusts: the room answers the levers and the body, not
  // the weather. Moderate shimmer so lever changes read in the ground.
  wind: { biasWeight: 0.4, gustScale: 0.8, shimmerStrength: 0.9 },
  portals: [
    {
      id: 'return-to-hollow',
      position: [0, 3, -40],
      radius: 4,
      targetZone: 'mote-hollow',
      targetSpawn: [30, 3, 10],
      label: 'The Foundry -> Mote Hollow',
    },
  ],
};

/** The full game world: three sample zones plus the foundry, as independent
 *  JSON documents (the round-trip a real multi-developer pipeline does). */
export const FIRST_LIGHT_ZONES_JSON: unknown[] = [
  ...SAMPLE_ZONE_JSON,
  JSON.parse(JSON.stringify(FOUNDRY_ZONE)) as unknown,
];
