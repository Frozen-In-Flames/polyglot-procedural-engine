// state/hash.ts — canonical JSON + FNV-1a hashing (V5 step 2).
//
// Two nodes prove convergence by comparing stateHash: FNV-1a over the
// canonical JSON of the reduced state. The same bytes in, the same hash out,
// on every node, every time. No dependencies; TextEncoder is a platform
// builtin, not DOM/WebGL.

import type { BuildOp, JSONValue, WorldState } from './types.js';

/**
 * Canonical JSON: object keys sorted recursively, no whitespace, arrays in
 * order. Throws on non-finite numbers (they are rejected before hashing).
 */
export function canonicalJSON(v: JSONValue): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) {
        throw new Error('state: non-finite number cannot be canonicalized');
      }
      return JSON.stringify(v);
    case 'string': return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) {
        return '[' + v.map(canonicalJSON).join(',') + ']';
      }
      const keys = Object.keys(v).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(v[k])).join(',') + '}';
    }
    default:
      throw new Error('state: value is not JSON-serializable');
  }
}

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const utf8 = new TextEncoder();

/** FNV-1a 32-bit over UTF-8 bytes, rendered as 8 lowercase hex chars. */
export function fnv1aHex(s: string): string {
  const bytes = utf8.encode(s);
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, FNV_PRIME);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The `prev` value every actor's first op (seq 0) must carry. */
export const GENESIS_PREV: string = fnv1aHex('GENESIS');

/** Stable identity of an op across nodes: 'actor:seq'. */
export function opId(op: Pick<BuildOp, 'actor' | 'seq'>): string {
  return op.actor + ':' + op.seq;
}

/**
 * Content hash of an op: FNV-1a over its canonical JSON. This is what the
 * NEXT op's `prev` must equal, chaining each actor's ops into a tamper-
 * evident sequence. Any change to an op's bytes changes its hash, so a
 * tampered op N is caught when op N+1's prev fails to match.
 */
export function opHash(op: BuildOp): string {
  return fnv1aHex(canonicalJSON(op as unknown as JSONValue));
}

/**
 * Convergence proof: FNV-1a over the canonical JSON of the reduced state.
 * Two nodes with the same op set produce byte-identical canonical JSON and
 * therefore identical hashes, regardless of the order the ops arrived in.
 */
export function stateHash(state: WorldState): string {
  return fnv1aHex(canonicalJSON(state as unknown as JSONValue));
}
