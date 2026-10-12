// games/workshop/behavior-browser.ts - browser-local behavior compilation.
//
// HONEST DIFFERENCE: src/build/compile.ts compiles behavior scripts inside
// a fresh node:vm realm (host-only, Node). The browser cannot run node:vm,
// so this module compiles the same plain-JS contract (start/update/stop
// functions receiving sealed (caps, self)) with a browser-local Function
// constructor: Math.random is shadowed by a throwing stub, Math and JSON
// are frozen copies, and the script receives only the sealed capability
// facade plus its own entity handle. The op payload carries the identical
// source text either way, so the state-graph story holds: any node holding
// the op can compile and run the same script on its own host.
//
// The behavior sources used here are authored with the page (not
// adversarial input); the sandboxing is defense in the same spirit as
// compile.ts, not the same mechanism.

import { sealBehaviorCaps } from '../../src/build/index.js';
import type { SealedBehavior } from '../../src/build/index.js';
import type { Caps, ScriptDef } from '../../src/index.js';
import type { EntityHandle } from '../../src/script/index.js';

export interface BehaviorFns {
  start?: (caps: unknown, self: unknown) => void;
  update?: (caps: unknown, self: unknown, dt: number, t: number) => void;
  stop?: (caps: unknown, self: unknown) => void;
}

function frozenMathStub(): Math {
  const m = Object.create(Math) as Record<string, unknown> & Math;
  m.random = () => {
    throw new Error('build: Math.random is unavailable; use caps.rng()');
  };
  return Object.freeze(m) as Math;
}

/**
 * Compile a behavior source with the browser-local realm. Same contract as
 * compile.ts: the source may define start(caps, self), update(caps, self,
 * dt, t), stop(caps, self). Throws loudly on malformed sources.
 */
export function compileBehaviorBrowser(source: string, name: string): BehaviorFns {
  if (typeof source !== 'string' || !source) {
    throw new Error(`workshop: behavior '${name}' source must be a non-empty string`);
  }
  const math = frozenMathStub();
  const json = Object.freeze({ ...JSON });
  let fns: BehaviorFns;
  try {
    const factory = new Function(
      'Math',
      'JSON',
      `'use strict';\n${source}\n;return {\n` +
        `  start: typeof start === 'function' ? start : undefined,\n` +
        `  update: typeof update === 'function' ? update : undefined,\n` +
        `  stop: typeof stop === 'function' ? stop : undefined,\n` +
        `};\n`,
    ) as (m: Math, j: JSON) => BehaviorFns;
    fns = factory(math, json);
  } catch (err) {
    throw new Error(`workshop: behavior '${name}' failed to compile: ${(err as Error).message}`);
  }
  if (!fns || typeof fns !== 'object') {
    throw new Error(`workshop: behavior '${name}' did not evaluate to a script`);
  }
  return fns;
}

/**
 * Attach a behavior source to a living entity: compile it browser-locally,
 * seal (caps, self) through the real membrane, load it into the runtime,
 * and return the sealed ScriptDef. The op emission stays with the caller
 * so the op log keeps the session's exact chain.
 */
export function makeBehaviorDef(
  name: string,
  source: string,
  handle: EntityHandle,
): ScriptDef {
  const fns = compileBehaviorBrowser(source, name);
  let sealed: SealedBehavior | null = null;
  const getSealed = (caps: Caps): SealedBehavior => {
    if (!sealed) sealed = sealBehaviorCaps(caps, handle);
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
      fn(s.caps, s.self, dt, t);
    } catch (err) {
      throw new Error(`workshop: behavior '${name}' threw in ${phase}: ${(err as Error).message}`);
    }
  };
  return {
    name,
    start: (caps) => invoke(fns.start, caps, 0, 0, 'start'),
    update: (caps, dt, t) => invoke(fns.update, caps, dt, t, 'update'),
    stop: (caps) => invoke(fns.stop, caps, 0, 0, 'stop'),
  };
}
