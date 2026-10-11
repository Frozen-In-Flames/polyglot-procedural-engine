// build/index.ts — public surface of the V5 in-session build tools.
//
// Instruments, not menus: the field brush, rhythm tuning, entity seeding,
// and live behavior scripting, all as invocations of the V4 scripting
// capability API. Every tool action emits one BuildOp (the schema shared
// with the distributed state graph in src/state/).

// The op schema is canonical in src/state; the build tools emit it.
export type { BuildOp, JSONValue } from '../state/index.js';
export {
  OP_BUILD_BRUSH, OP_BUILD_RHYTHM, OP_BUILD_SEED, OP_BUILD_SCRIPT,
} from '../state/index.js';

export { BuildSession } from './session.js';
export type { BuildSessionOptions } from './session.js';
export {
  Instrument,
  BrushInstrument, BrushTarget,
  RhythmInstrument, RhythmTarget,
  SeedInstrument, SeedTarget,
  BehaviorInstrument, BehaviorTarget,
} from './session.js';

export { createBrushDef, brushOffset, validateBrush } from './brush.js';
export type { BrushDef, BrushOpts, ValidBrush } from './brush.js';

export { blendRhythm, validateRhythm } from './rhythm.js';
export type { RhythmRegion, RhythmOpts, ValidRhythm } from './rhythm.js';

export { ENTITY_KINDS, entityNameFor, bodyForKind, validateSeed } from './entities.js';
export type { EntityKind, ValidSeed } from './entities.js';

export { compileBehavior, MAX_BEHAVIOR_BYTES } from './compile.js';
export { seal, sealBehaviorCaps } from './seal.js';
export type { SealedBehavior } from './seal.js';
