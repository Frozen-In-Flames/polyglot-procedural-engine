// Unit tests for the pure-TypeScript SHA-512 (src/own/sha512.ts, runs in node).
// (a) NIST FIPS 180-4 vectors for "" and "abc";
// (b) output shape: exactly 64 bytes;
// (c) cross-check against node:crypto for fixed and random messages, including
//     multi-block inputs and the 55/56 and 111/112/119/120 padding boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha512 } from '../src/own/sha512.js';

const EMPTY_HEX = 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e';
const ABC_HEX = 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f';

const enc = new TextEncoder();

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function refHex(msg: Uint8Array): string {
  return createHash('sha512').update(msg).digest('hex');
}

/** Tiny deterministic PRNG for reproducible random messages. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ---------- (a) NIST vectors ----------

test('sha512: empty message matches the NIST vector', () => {
  assert.equal(hex(sha512(new Uint8Array(0))), EMPTY_HEX);
});

test('sha512: "abc" matches the NIST vector', () => {
  assert.equal(hex(sha512(enc.encode('abc'))), ABC_HEX);
});

// ---------- (b) output shape ----------

test('sha512: returns exactly 64 bytes for short and long inputs', () => {
  for (const len of [0, 1, 55, 56, 112, 128, 1000]) {
    const out = sha512(new Uint8Array(len));
    assert.ok(out instanceof Uint8Array);
    assert.equal(out.length, 64);
  }
});

// ---------- (c) cross-check vs node:crypto ----------

test('sha512: matches node:crypto on fixed boundary lengths', () => {
  const rng = lcg(20261012);
  for (const len of [0, 1, 3, 55, 56, 57, 111, 112, 113, 119, 120, 127, 128, 129, 200, 255, 1000]) {
    const msg = new Uint8Array(len);
    for (let i = 0; i < len; i++) msg[i] = Math.floor(rng() * 256);
    assert.equal(hex(sha512(msg)), refHex(msg), 'mismatch at length ' + len);
  }
});

test('sha512: matches node:crypto on random multi-block messages', () => {
  const rng = lcg(777);
  for (let round = 0; round < 25; round++) {
    const len = 113 + Math.floor(rng() * 2000); // always spans 2+ blocks
    const msg = new Uint8Array(len);
    for (let i = 0; i < len; i++) msg[i] = Math.floor(rng() * 256);
    assert.equal(
      hex(sha512(msg)),
      refHex(msg),
      'mismatch at random length ' + len,
    );
  }
});

test('sha512: one flipped bit changes the digest', () => {
  const rng = lcg(42);
  const msg = new Uint8Array(300);
  for (let i = 0; i < msg.length; i++) msg[i] = Math.floor(rng() * 256);
  const h1 = hex(sha512(msg));
  assert.equal(h1, refHex(msg)); // matches node:crypto before the flip too
  msg[150] ^= 1;
  assert.notEqual(hex(sha512(msg)), h1);
});
