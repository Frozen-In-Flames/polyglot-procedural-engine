// build/seal.ts - the membrane between behavior scripts and the host.
//
// Live behavior scripts run in a fresh vm realm (see compile.ts), so they
// cannot see host globals at all. The one remaining crossing is the
// capability object handed to start/update/stop. A raw host object would
// leak the host realm through its prototype chain (obj.constructor ->
// host Function -> host globals), so every value crossing into a behavior
// script passes through `seal`:
//
//   - 'constructor', '__proto__', and 'prototype' are unreadable and absent;
//   - prototypes are hidden (null) on every extensible target, breaking the
//     constructor chain completely;
//   - sealed functions re-seal their return values, so nothing raw leaks out
//     of a capability call;
//   - sealed objects are read-only: writes, deletes, and construction throw.
//
// What the script CAN do is exactly what the granted capabilities allow -
// the V4 capability-closure guarantee, now with the prototype escape closed.

import type { Caps, EntityHandle, JSONValue, TransformData } from '../script/index.js';

const BLOCKED = new Set(['constructor', '__proto__', 'prototype']);

function isObj(v: unknown): v is object {
  return v !== null && (typeof v === 'object' || typeof v === 'function');
}

/** Deep-copy JSON-shaped data into fresh EXTENSIBLE structures (never frozen,
 *  so the membrane can hide their prototypes). */
function freshCopy(v: JSONValue | undefined): JSONValue | undefined {
  return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as JSONValue);
}

/**
 * Wrap a value in the membrane. Primitives pass through untouched.
 * Idempotent per `seen` map: one raw object maps to one proxy.
 */
export function seal<T>(value: T, seen: WeakMap<object, unknown> = new WeakMap()): T {
  if (!isObj(value)) return value;
  const hit = seen.get(value);
  if (hit !== undefined) return hit as T;
  const proxy = new Proxy(value as object, {
    get(t, p) {
      if (typeof p === 'string' && BLOCKED.has(p)) return undefined;
      return seal(Reflect.get(t, p), seen);
    },
    set() {
      throw new Error('build: sealed objects are read-only for behavior scripts');
    },
    defineProperty() {
      throw new Error('build: sealed objects are read-only for behavior scripts');
    },
    deleteProperty() {
      throw new Error('build: sealed objects are read-only for behavior scripts');
    },
    setPrototypeOf() {
      throw new Error('build: sealed objects are read-only for behavior scripts');
    },
    has(t, p) {
      if (typeof p === 'string' && BLOCKED.has(p)) return false;
      return Reflect.has(t, p);
    },
    getPrototypeOf(t) {
      // Extensible targets (everything the facade builds: fresh literals,
      // fresh copies) report a null prototype, so the constructor chain is
      // gone entirely. Frozen targets cannot legally report null; the
      // facade never hands a frozen object to a script (freshCopy), so
      // this path only triggers if the host itself leaks one - and the
      // get trap above still blocks direct 'constructor' reads.
      return Object.isExtensible(t) ? null : Reflect.getPrototypeOf(t);
    },
    apply(t, thisArg, args) {
      const out = Reflect.apply(t as (...a: unknown[]) => unknown, thisArg, args);
      return seal(out, seen);
    },
    construct() {
      throw new Error('build: behavior scripts cannot construct host objects');
    },
  });
  seen.set(value, proxy);
  return proxy as T;
}

/** The sealed pair a behavior script's start/update/stop receive. */
export interface SealedBehavior {
  caps: unknown;
  self: unknown;
}

/**
 * Build the behavior-facing capability facade for one entity. The facade is
 * made of fresh objects and closures (never the runtime's frozen caps, never
 * raw entity handles): data returned to the script is deep-copied into fresh
 * extensible structures, and entity handles the script did not receive map
 * back to nothing, so destroy() cannot forge authority.
 */
export function sealBehaviorCaps(caps: Caps, self: EntityHandle): SealedBehavior {
  const seen = new WeakMap<object, unknown>();
  // Sealed facade -> raw handle, for destroy(). A facade the script was
  // never given is simply absent here: no confused-deputy destroy.
  const handleBack = new WeakMap<object, EntityHandle>();

  const wrapHandle = (h: EntityHandle | null): unknown => {
    if (!h) return null;
    const facade = {
      name: h.name,
      id: h.id,
      get alive(): boolean {
        return h.alive;
      },
      getTransform: (): unknown => freshCopy(h.getTransform() as unknown as JSONValue),
      setTransform: (t: TransformData): void => {
        h.setTransform(t);
      },
      translate: (dx: number, dy: number, dz: number): void => {
        h.translate(dx, dy, dz);
      },
      setTag: (tag: string): void => {
        h.setTag(tag);
      },
      getTag: (): string => h.getTag(),
      on: (event: string, fn: (data: unknown) => void): unknown => {
        if (typeof fn !== 'function') throw new Error('build: handler must be a function');
        // The runtime invokes this wrapper with raw host data; the script's
        // fn only ever sees the sealed copy.
        return h.on(String(event), (data) => {
          fn(seal(freshCopy(data), seen));
        });
      },
      emit: (event: string, data?: JSONValue): void => {
        h.emit(String(event), data);
      },
    };
    const s = seal(facade, seen);
    handleBack.set(s as object, h);
    return s;
  };

  const facade = {
    capabilities: [...caps.capabilities],
    rng: (): number => caps.rng(),
    time: {
      now: (): number => caps.time.now(),
      delta: (): number => caps.time.delta(),
    },
    world: {
      spawn: (name: string, opts?: {
        position?: [number, number, number];
        rotation?: [number, number, number, number];
        scale?: [number, number, number];
        tag?: string;
      }): unknown =>
        wrapHandle(caps.world.spawn(String(name), opts === undefined ? undefined : {
          position: opts.position, rotation: opts.rotation, scale: opts.scale, tag: opts.tag,
        })),
      find: (name: string): unknown => wrapHandle(caps.world.find(String(name))),
      query: (tag: string): unknown[] => caps.world.query(String(tag)).map((h) => wrapHandle(h)),
      destroy: (handle: unknown): void => {
        const raw = isObj(handle) ? handleBack.get(handle) : undefined;
        if (!raw) throw new Error('build: destroy needs a handle this script was given');
        caps.world.destroy(raw);
      },
    },
    events: {
      on: (event: string, fn: (data: unknown) => void): unknown => {
        if (typeof fn !== 'function') throw new Error('build: handler must be a function');
        return caps.events.on(String(event), (data) => {
          fn(seal(freshCopy(data), seen));
        });
      },
      emit: (event: string, data?: JSONValue): void => {
        caps.events.emit(String(event), data);
      },
    },
    log: (msg: unknown): void => {
      caps.log(String(msg));
    },
    field: {
      wind: (position: [number, number, number], t: number): unknown => {
        const w = caps.field.wind(position, t);
        return [w[0], w[1], w[2]];
      },
      params: (): unknown => freshCopy(caps.field.params()),
    },
  };

  return { caps: seal(facade, seen), self: wrapHandle(self) };
}
