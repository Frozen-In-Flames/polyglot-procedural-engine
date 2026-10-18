// state/ops.ts - op construction and validation (V5 step 2).
//
// Validation is pure and deterministic: every node applies the exact same
// rules, so accept/reject decisions never diverge between nodes that saw
// the same ops.

import type { BuildOp, JSONValue } from './types.js';
import {
  KNOWN_OPS, OP_BUILD_BRUSH, OP_BUILD_RHYTHM, OP_BUILD_SEED,
  OP_BUILD_SCRIPT, OP_STATE_NOOP,
} from './types.js';

/** Build an op record. The caller supplies seq/t/prev from its chain state. */
export function createOp(
  op: string,
  actor: string,
  seq: number,
  seed: number,
  t: number,
  payload: JSONValue,
  prev: string,
): BuildOp {
  return { v: 1, op, actor, seq, seed, t, payload, prev };
}

/** Recursively confirm a value is plain JSON (no undefined, functions, NaN). */
function isJSONValue(v: unknown): v is JSONValue {
  if (v === null) return true;
  switch (typeof v) {
    case 'boolean':
    case 'string': return true;
    case 'number': return Number.isFinite(v);
    case 'object':
      if (Array.isArray(v)) return v.every(isJSONValue);
      return Object.values(v as Record<string, unknown>).every(isJSONValue);
    default: return false;
  }
}

function isRecord(v: unknown): v is Record<string, JSONValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every(isNum);
}

/**
 * Structural validation of the op envelope. Returns the typed op or a
 * human-readable reason. Never throws on hostile input.
 */
export function validateOpShape(raw: unknown):
  | { ok: true; op: BuildOp }
  | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'op is not an object' };
  const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
  if (raw.v !== 1) return fail('unsupported op version');
  if (typeof raw.op !== 'string' || raw.op.length === 0) return fail('op name missing');
  if (typeof raw.actor !== 'string' || raw.actor.length === 0) return fail('actor missing');
  if (typeof raw.prev !== 'string' || raw.prev.length === 0) return fail('prev hash missing');
  if (!Number.isInteger(raw.seq) || (raw.seq as number) < 0) return fail('seq must be a non-negative integer');
  if (!Number.isInteger(raw.seed) || (raw.seed as number) < 0) return fail('seed must be a non-negative integer');
  if (!Number.isInteger(raw.t) || (raw.t as number) < 0) return fail('t must be a non-negative integer');
  if (!isJSONValue(raw.payload)) return fail('payload is not valid JSON');
  return {
    ok: true,
    op: {
      v: 1,
      op: raw.op as string,
      actor: raw.actor as string,
      seq: raw.seq as number,
      seed: raw.seed as number,
      t: raw.t as number,
      payload: raw.payload as JSONValue,
      prev: raw.prev as string,
    },
  };
}

/**
 * Per-op payload validation. Returns null when valid, else a reason.
 * Unknown op names are reported here too (belt and suspenders with the node).
 */
export function validatePayload(opName: string, payload: JSONValue): string | null {
  if (!KNOWN_OPS.includes(opName)) return 'unknown op name: ' + opName;
  // Noop carries no data: any valid JSON payload (including null) is fine.
  if (opName === OP_STATE_NOOP) return null;
  if (!isRecord(payload)) return 'payload must be an object';
  const need = (key: string): JSONValue | undefined => payload[key];

  switch (opName) {
    case OP_BUILD_BRUSH: {
      if (typeof need('id') !== 'string' || (need('id') as string).length === 0) return 'build.brush: id must be a non-empty string';
      if (!isVec3(need('pos'))) return 'build.brush: pos must be [x,y,z]';
      if (!isNum(need('radius')) || (need('radius') as number) <= 0) return 'build.brush: radius must be positive';
      if (!isNum(need('strength'))) return 'build.brush: strength must be a number';
      if (!isNum(need('heading'))) return 'build.brush: heading must be a number';
      return null;
    }
    case OP_BUILD_RHYTHM: {
      if (typeof need('id') !== 'string' || (need('id') as string).length === 0) return 'build.rhythm: id must be a non-empty string';
      const target = need('target');
      if (target !== 'ember' && target !== 'mote' && target !== 'gust') return 'build.rhythm: target must be ember, mote, or gust';
      if (!isNum(need('tempo')) || (need('tempo') as number) <= 0) return 'build.rhythm: tempo must be positive';
      if (!isNum(need('energy')) || (need('energy') as number) < 0 || (need('energy') as number) > 1) {
        return 'build.rhythm: energy must be in 0..1';
      }
      return null;
    }
    case OP_BUILD_SEED: {
      if (typeof need('id') !== 'string' || (need('id') as string).length === 0) return 'build.seed: id must be a non-empty string';
      if (typeof need('kind') !== 'string' || (need('kind') as string).length === 0) return 'build.seed: kind must be a non-empty string';
      if (!isVec3(need('pos'))) return 'build.seed: pos must be [x,y,z]';
      if (!Number.isInteger(need('seed')) || (need('seed') as number) < 0) return 'build.seed: seed must be a non-negative integer';
      return null;
    }
    case OP_BUILD_SCRIPT: {
      if (typeof need('name') !== 'string' || (need('name') as string).length === 0) return 'build.script: name must be a non-empty string';
      if (typeof need('body') !== 'string') return 'build.script: body must be a string';
      return null;
    }
    default:
      return 'unknown op name: ' + opName;
  }
}
