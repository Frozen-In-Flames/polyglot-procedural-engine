// script/index.ts — public surface of the V4 scripting runtime.
export type {
  Caps, CapabilityName, WorldCaps, EventCaps, AudioCaps, TimeCaps, ProbeCaps,
  EntityHandle, TransformData, NoteEvent, SfxSpec, SfxKind, MoodPartial, ScriptDef,
  EntityBackend, JSONValue, FieldCaps, PortalSpawnOpts,
  BodyGeometry, BodyMaterial, SpawnBody,
} from './api.js';
export { ALL_CAPABILITIES } from './api.js';
export {
  ScriptRuntime, MemoryEntityBackend, SceneEntityBackend,
} from './runtime.js';
export type { RuntimeOptions } from './runtime.js';
export {
  floatScript, arpScript, hatsScript, referenceScripts,
  composeArpHats, makeSplitMix64, round4Bankers,
} from './refScripts.js';
