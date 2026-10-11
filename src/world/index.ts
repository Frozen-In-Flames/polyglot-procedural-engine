// world/index.ts — public surface of the V4 world-composition module.
export type {
  ZoneDescriptor, PortalDescriptor, Bounds3,
  ZoneWindParams, ZoneTerrainParams, ZoneSkyParams, ZoneBiomeParams,
  FieldDomain, FieldParams,
  WindParams, SceneParams, GenesisParams, BiomeParams,
  TempoParams, LightParams, PresenceParams,
  Vec3JSON,
} from './types.js';
export { parseZoneDescriptor, defaultFieldParams } from './types.js';
export { WindField } from './wind.js';
export type { WindSample, PlayerState } from './wind.js';
export { GlobalField, copyParams } from './field.js';
export { Zone, loadZoneDescriptors } from './zones.js';
export { PortalHandoff } from './portals.js';
export type { PortalLink, PortalRecord, PortalCrossing } from './portals.js';
export { ComposedWorld } from './loader.js';
export {
  SAMPLE_ZONES, SAMPLE_ZONE_JSON,
  SAMPLE_ZONE_EMBER_REACH, SAMPLE_ZONE_MOTE_HOLLOW, SAMPLE_ZONE_SHIMMER_FLATS,
} from './samples.js';
