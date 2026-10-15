// input/detect.ts — pick the right input scheme for the device.
// DOM-free: capabilities are collected from an injected environment object,
// so detection is unit-testable in node and the demo passes the real
// navigator/window at startup.
export type SchemeId = 'desktop' | 'touch' | 'xr';
export type SchemeOverride = SchemeId | 'auto';

export interface DeviceCaps {
  /** Number of simultaneous touch points the primary input supports. */
  touchPoints: number;
  /** True when the primary pointer is coarse (finger, not mouse). */
  coarsePointer: boolean;
  /** True when the browser reports an immersive-vr WebXR session. */
  xrImmersiveVr: boolean;
}

/** Minimal structural view of the browser environment we read. */
export interface CapEnv {
  navigator?: {
    maxTouchPoints?: number;
    xr?: { isSessionSupported?: (mode: string) => Promise<boolean> } | null;
  } | null;
  matchMedia?: (query: string) => { matches: boolean };
  ontouchstart?: unknown;
}

export async function collectCaps(env: CapEnv): Promise<DeviceCaps> {
  const nav = env.navigator ?? undefined;
  const maxTouch = nav?.maxTouchPoints;
  const touchPoints = typeof maxTouch === 'number' ? maxTouch : 0;
  const coarsePointer = env.matchMedia
    ? safeMatch(env.matchMedia, '(pointer: coarse)')
    : false;
  let xrImmersiveVr = false;
  try {
    const xrSys = nav?.xr;
    const isSupported = xrSys?.isSessionSupported;
    if (xrSys && typeof isSupported === 'function') {
      xrImmersiveVr = await isSupported.call(xrSys, 'immersive-vr');
    }
  } catch {
    xrImmersiveVr = false;
  }
  // A touch-capable device with zero reported touch points but a touchstart
  // handler still counts as touch (some mobile browsers under-report).
  const hasTouchStart = env.ontouchstart !== undefined;
  return {
    touchPoints: hasTouchStart && touchPoints === 0 ? 1 : touchPoints,
    coarsePointer,
    xrImmersiveVr,
  };
}

function safeMatch(
  matchMedia: (query: string) => { matches: boolean },
  query: string,
): boolean {
  try {
    return matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** Priority: explicit override > XR headset > touch > desktop. */
export function pickScheme(caps: DeviceCaps, override: SchemeOverride): SchemeId {
  if (override !== 'auto') return override;
  if (caps.xrImmersiveVr) return 'xr';
  if (caps.touchPoints > 0 || caps.coarsePointer) return 'touch';
  return 'desktop';
}

/** Human label for the demo UI. */
export function schemeLabel(id: SchemeId): string {
  switch (id) {
    case 'desktop': return 'Desktop';
    case 'touch': return 'Touch';
    case 'xr': return 'XR headset';
  }
}
