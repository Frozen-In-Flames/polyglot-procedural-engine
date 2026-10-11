// script/sandbox.ts — the machinery that keeps the capability graph closed.
//
// THREAT MODEL (be honest): V4 guarantees CAPABILITY-CLOSURE, not
// malicious-actor containment. That means: a script cannot reach the
// renderer, the scene graph, the DOM, or any engine internals THROUGH the
// capability object — the graph is frozen and contains no internal
// references. It does NOT mean a hostile script cannot do hostile things
// with the full JavaScript language itself (e.g. `Function('return this')()`
// still reaches the global scope). Full realm isolation (worker/iframe with
// a fresh global) is future work, explicitly out of V4 scope. Treat the
// runtime as protection against buggy or curious scripts, not adversaries.

import type { JSONValue, TransformData } from './api.js';

/** Recursively freeze an object graph. Cycles are guarded. */
export function deepFreeze<T>(obj: T, seen = new Set<object>()): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (seen.has(obj)) return obj;
  seen.add(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const v = (obj as Record<string, unknown>)[key];
    if (v !== null && typeof v === 'object') deepFreeze(v, seen);
  }
  return Object.freeze(obj);
}

/** Structured-clone-lite for JSONValue: copies in, so later mutation by the
 *  script cannot corrupt engine-side state (and vice versa). */
export function copyJson(v: JSONValue | undefined): JSONValue | undefined {
  if (v === undefined || v === null) return v;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((e) => copyJson(e) as JSONValue);
  const out: { [k: string]: JSONValue } = {};
  for (const k of Object.keys(v)) {
    const e = copyJson((v as { [k: string]: JSONValue })[k]);
    if (e !== undefined) out[k] = e;
  }
  return out;
}

/** Finite-number guard for transform components. Throws on NaN/Infinity. */
export function checkFinite(n: number, what: string): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error(`script: ${what} must be a finite number`);
  }
  return n;
}

/** Validate and normalize an incoming transform snapshot. Returns a fresh,
 *  plain, frozen object the engine may hold without aliasing script memory. */
export function sanitizeTransform(t: TransformData): TransformData {
  if (t === null || typeof t !== 'object') throw new Error('script: transform must be an object');
  const pos = t.position, rot = t.rotation, scl = t.scale;
  if (!Array.isArray(pos) || pos.length !== 3) throw new Error('script: position must be [x,y,z]');
  if (!Array.isArray(rot) || rot.length !== 4) throw new Error('script: rotation must be [x,y,z,w]');
  if (!Array.isArray(scl) || scl.length !== 3) throw new Error('script: scale must be [x,y,z]');
  const out: TransformData = {
    position: [checkFinite(pos[0], 'position[0]'), checkFinite(pos[1], 'position[1]'), checkFinite(pos[2], 'position[2]')],
    rotation: [checkFinite(rot[0], 'rotation[0]'), checkFinite(rot[1], 'rotation[1]'), checkFinite(rot[2], 'rotation[2]'), checkFinite(rot[3], 'rotation[3]')],
    scale: [checkFinite(scl[0], 'scale[0]'), checkFinite(scl[1], 'scale[1]'), checkFinite(scl[2], 'scale[2]')],
  };
  return deepFreeze(out);
}

/** Copy an engine-side transform out to the script as frozen plain data. */
export function exportTransform(t: TransformData): TransformData {
  return deepFreeze({
    position: [t.position[0], t.position[1], t.position[2]] as [number, number, number],
    rotation: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]] as [number, number, number, number],
    scale: [t.scale[0], t.scale[1], t.scale[2]] as [number, number, number],
  });
}

/** Validate a note event the way validateScore treats untrusted score docs. */
export function sanitizeNote(e: {
  t: number; dur: number; freq: number; kind: string; gain: number; pan?: number;
}): { t: number; dur: number; freq: number; kind: 'tone' | 'noise'; gain: number; pan?: number } {
  if (e === null || typeof e !== 'object') throw new Error('script: note must be an object');
  const t = checkFinite(e.t, 'note.t');
  const dur = checkFinite(e.dur, 'note.dur');
  const freq = checkFinite(e.freq, 'note.freq');
  const gain = checkFinite(e.gain, 'note.gain');
  if (dur <= 0 || freq <= 0 || gain < 0 || gain > 1) throw new Error('script: note out of range');
  if (e.kind !== 'tone' && e.kind !== 'noise') throw new Error('script: note.kind must be tone|noise');
  const out: { t: number; dur: number; freq: number; kind: 'tone' | 'noise'; gain: number; pan?: number } =
    { t, dur, freq, kind: e.kind, gain };
  if (e.pan !== undefined) out.pan = Math.max(-1, Math.min(1, checkFinite(e.pan, 'note.pan')));
  return deepFreeze(out);
}

/** Assert a value graph reachable from `root` contains none of the given
 *  constructor identities (used by tests to prove no internals leak). */
export function graphContains(root: unknown, ctors: Function[], seen = new Set<object>()): Function | null {
  if (root === null || (typeof root !== 'object' && typeof root !== 'function')) return null;
  const o = root as object;
  if (seen.has(o)) return null;
  seen.add(o);
  for (const c of ctors) {
    try { if (root instanceof (c as new (...a: never[]) => unknown)) return c; } catch { /* ignore */ }
  }
  if (typeof root === 'function') return null; // don't walk into closures
  for (const k of Object.getOwnPropertyNames(o)) {
    try {
      const hit = graphContains((o as Record<string, unknown>)[k], ctors, seen);
      if (hit) return hit;
    } catch { /* getters that throw are not traversable; skip */ }
  }
  return null;
}
