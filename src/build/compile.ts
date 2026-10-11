// build/compile.ts — compile live behavior scripts in a fresh realm.
//
// Host-only (node): uses the node:vm builtin, zero new dependencies. A
// behavior source is plain JavaScript defining any of:
//
//   function start(caps, self) { ... }        // once, on attach
//   function update(caps, self, dt, t) { ... } // every frame
//   function stop(caps, self) { ... }         // on unload
//
// `caps` is the sealed behavior capability facade (see seal.ts) and `self`
// is the sealed handle of the entity the script is attached to.
//
// What the script CANNOT see: the vm context starts empty — no process, no
// require, no fetch, no timers, no host globalThis. Math.random is replaced
// with a throwing stub (Cause and Effect: no hidden randomness; scripts use
// caps.rng()), and Math/JSON are frozen. Combined with the membrane in
// seal.ts, a bad script cannot escape: hostile calls throw inside the
// realm, and the V4 runtime's per-script error capture keeps a throwing
// script from taking the session down with it.

import * as vm from 'node:vm';
import type { Caps, ScriptDef } from '../script/index.js';
import type { SealedBehavior } from './seal.js';

/** Max behavior source size: bounds compile cost. */
export const MAX_BEHAVIOR_BYTES = 65536;

interface BehaviorFns {
  start?: (caps: unknown, self: unknown) => void;
  update?: (caps: unknown, self: unknown, dt: number, t: number) => void;
  stop?: (caps: unknown, self: unknown) => void;
}

/** Build the fresh realm for one behavior script. */
function makeRealm(): vm.Context {
  const ctx = vm.createContext({});
  // Strip nondeterminism and lock the shared intrinsics. If any of this
  // fails the compile fails loudly rather than running half-sandboxed.
  vm.runInContext(
    `'use strict';
    Object.defineProperty(Math, 'random', {
      value: function () { throw new Error('build: Math.random is unavailable; use caps.rng()'); },
      writable: false, enumerable: false, configurable: false,
    });
    Object.freeze(Math);
    Object.freeze(JSON);`,
    ctx,
  );
  return ctx;
}

/**
 * Compile a behavior source into a V4 ScriptDef. `sealFor` builds the sealed
 * (caps, self) pair from the live V4 caps at load time. Throws on hostile
 * or malformed sources; never returns a half-built def.
 */
export function compileBehavior(
  source: string,
  name: string,
  sealFor: (caps: Caps) => SealedBehavior,
): ScriptDef {
  if (typeof source !== 'string' || !source) {
    throw new Error('build: behavior source must be a non-empty string');
  }
  if (source.length > MAX_BEHAVIOR_BYTES) {
    throw new Error(`build: behavior source exceeds ${MAX_BEHAVIOR_BYTES} bytes`);
  }
  if (typeof name !== 'string' || !name) {
    throw new Error('build: behavior name must be a non-empty string');
  }

  const ctx = makeRealm();
  const wrapped =
    `'use strict';\n(function () {\n${source}\n;return {\n` +
    `  start: typeof start === 'function' ? start : undefined,\n` +
    `  update: typeof update === 'function' ? update : undefined,\n` +
    `  stop: typeof stop === 'function' ? stop : undefined,\n` +
    `};\n})()`;
  let fns: BehaviorFns;
  try {
    fns = vm.runInContext(wrapped, ctx, { timeout: 500 }) as BehaviorFns;
  } catch (err) {
    throw new Error(`build: behavior '${name}' failed to compile: ${(err as Error).message}`);
  }
  if (!fns || typeof fns !== 'object') {
    throw new Error(`build: behavior '${name}' did not evaluate to a script`);
  }

  let sealed: SealedBehavior | null = null;
  const getSealed = (caps: Caps): SealedBehavior => {
    if (!sealed) sealed = sealFor(caps);
    return sealed;
  };
  const invoke = (
    fn: ((caps: unknown, self: unknown, dt: number, t: number) => void) | undefined,
    caps: Caps,
    dt: number,
    t: number,
    phase: string,
  ): void => {
    if (!fn) return;
    const s = getSealed(caps);
    try {
      // Host -> realm call. Arguments crossing in are membrane-sealed;
      // anything the script throws is caught and reported per phase.
      Reflect.apply(fn, undefined, [s.caps, s.self, dt, t]);
    } catch (err) {
      throw new Error(`build: behavior '${name}' threw in ${phase}: ${(err as Error).message}`);
    }
  };

  return {
    name,
    start: (caps) => invoke(fns.start, caps, 0, 0, 'start'),
    update: (caps, dt, t) => invoke(fns.update, caps, dt, t, 'update'),
    stop: (caps) => invoke(fns.stop, caps, 0, 0, 'stop'),
  };
}
