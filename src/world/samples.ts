// world/samples.ts - sample zone descriptors authored as independent
// developers would: plain JSON, no engine internals.
//
// All three share nothing but the global seed (set on the GlobalField at
// load time). Their local character differs - gust weights, shimmer, biome,
// terrain bones - but every wind sample derives from the same global field,
// so crossing a portal reads as the lake changing, not a loading screen
// into randomness.
//
// Layout (world units): the three zones sit side by side on the x axis,
// portals chaining ember-reach <-> mote-hollow <-> shimmer-flats.

import type { ZoneDescriptor } from './types.js';

export const SAMPLE_ZONE_EMBER_REACH: ZoneDescriptor = {
  id: 'ember-reach',
  displayName: 'Ember Reach',
  seed: 9107,
  placement: { offset: [-140, 0, 0] },
  bounds: { min: [-60, 0, -60], max: [60, 40, 60] },
  terrain: {
    size: 120, segments: 48, height: 9,
    baseFrequency: 0.045, octaves: 4, roughness: 0.65,
  },
  sky: { horizonHue: 0.06, zenithHue: 0.62, starDensity: 0.25 },
  biome: { name: 'ashen', moteDensity: 0.7, emberDrift: 1.35 },
  // Restless air: gusts amplified, weak prevailing bias - the wind feels
  // gusty and changeable here. Strong terrain shimmer.
  wind: { biasWeight: 0.2, gustScale: 1.35, shimmerStrength: 1.2 },
  portals: [
    {
      id: 'gate-to-hollow',
      position: [52, 4, 0],
      radius: 4,
      targetZone: 'mote-hollow',
      targetSpawn: [-52, 4, 0],
      label: 'Ember Reach -> Mote Hollow',
    },
  ],
};

export const SAMPLE_ZONE_MOTE_HOLLOW: ZoneDescriptor = {
  id: 'mote-hollow',
  displayName: 'Mote Hollow',
  seed: 44021,
  placement: { offset: [0, 0, 0] },
  bounds: { min: [-60, 0, -60], max: [60, 40, 60] },
  terrain: {
    size: 120, segments: 48, height: 6,
    baseFrequency: 0.06, octaves: 3, roughness: 0.4,
  },
  sky: { horizonHue: 0.13, zenithHue: 0.58, starDensity: 0.55 },
  biome: { name: 'hollow', moteDensity: 0.9, emberDrift: 0.7 },
  // Sheltered air: the anchored prevailing wind dominates, gusts damped -
  // motes hang and drift in slow sheets. Gentle shimmer.
  wind: { biasWeight: 0.65, gustScale: 0.7, shimmerStrength: 0.5 },
  portals: [
    {
      id: 'gate-to-reach',
      position: [-52, 4, 0],
      radius: 4,
      targetZone: 'ember-reach',
      targetSpawn: [52, 4, 0],
      label: 'Mote Hollow -> Ember Reach',
    },
    {
      id: 'gate-to-flats',
      position: [52, 4, 0],
      radius: 4,
      targetZone: 'shimmer-flats',
      targetSpawn: [-52, 4, 0],
      label: 'Mote Hollow -> Shimmer Flats',
    },
  ],
};

export const SAMPLE_ZONE_SHIMMER_FLATS: ZoneDescriptor = {
  id: 'shimmer-flats',
  displayName: 'Shimmer Flats',
  seed: 17233,
  placement: { offset: [140, 0, 0] },
  bounds: { min: [-60, 0, -60], max: [60, 40, 60] },
  terrain: {
    size: 120, segments: 48, height: 3.5,
    baseFrequency: 0.03, octaves: 3, roughness: 0.25,
  },
  sky: { horizonHue: 0.5, zenithHue: 0.66, starDensity: 0.1 },
  biome: { name: 'flats', moteDensity: 0.35, emberDrift: 1.0 },
  // Open water: near-unity weights - the global ocean reads almost raw
  // here - with the strongest terrain shimmer, so the wind's structure is
  // legible in the ground itself.
  wind: { biasWeight: 0.35, gustScale: 1.0, shimmerStrength: 1.8 },
  portals: [
    {
      id: 'gate-to-hollow',
      position: [-52, 4, 0],
      radius: 4,
      targetZone: 'mote-hollow',
      targetSpawn: [52, 4, 0],
      label: 'Shimmer Flats -> Mote Hollow',
    },
  ],
};

/** The three sample zones as independent JSON documents (the round-trip a
 *  real multi-developer pipeline performs). */
export const SAMPLE_ZONE_JSON: unknown[] = [
  JSON.parse(JSON.stringify(SAMPLE_ZONE_EMBER_REACH)) as unknown,
  JSON.parse(JSON.stringify(SAMPLE_ZONE_MOTE_HOLLOW)) as unknown,
  JSON.parse(JSON.stringify(SAMPLE_ZONE_SHIMMER_FLATS)) as unknown,
];

export const SAMPLE_ZONES: ZoneDescriptor[] = [
  SAMPLE_ZONE_EMBER_REACH,
  SAMPLE_ZONE_MOTE_HOLLOW,
  SAMPLE_ZONE_SHIMMER_FLATS,
];
