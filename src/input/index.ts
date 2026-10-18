// input/index.ts - unified input system (V9): one camera rig, every device.
export { CameraRig, ZERO_INTENT } from './rig.js';
export type { MoveIntent, RigMode } from './rig.js';
export { collectCaps, pickScheme, schemeLabel } from './detect.js';
export type { SchemeId, SchemeOverride, DeviceCaps, CapEnv } from './detect.js';
export { DesktopScheme, TouchScheme, XRInputScheme } from './schemes.js';
export type { InputScheme } from './schemes.js';
