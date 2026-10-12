// Unit tests for the pure-TypeScript Ed25519 (src/own/ed25519.ts, runs in node).
// (a) RFC 8032 Section 7.1 vectors TEST 1..3: exact public key and signature;
// (b) roundtrip: random seeds -> keygen -> sign -> verify;
// (c) tamper: flipped signature/message bytes and wrong keys fail verify;
// (d) cross-check vs node:crypto in both directions (test-only usage);
// (e) malformed input: verify() returns false instead of throwing, and the
//     throwing APIs throw on bad lengths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';
import {
  generateKeypair,
  sign,
  verify,
  toHex,
  fromHex,
} from '../src/own/ed25519.js';

/** Tiny deterministic PRNG for reproducible random test material. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randBytes(rng: () => number, len: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = Math.floor(rng() * 256);
  return b;
}

// RFC 8032 Section 7.1: [seed, publicKey, message, signature] as hex.
const VECTORS: Array<[string, string, string, string]> = [
  [
    '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    '',
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155' +
      '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  ],
  [
    '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    '72',
    '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da' +
      '085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  ],
  [
    'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
    'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    'af82',
    '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac' +
      '18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
  ],
];

// ---------- (a) RFC 8032 vectors ----------

for (let i = 0; i < VECTORS.length; i++) {
  const [seedHex, pubHex, msgHex, sigHex] = VECTORS[i];
  const n = i + 1;
  test(`ed25519: RFC 8032 TEST ${n} derives the published public key`, () => {
    const { publicKey, secretKey } = generateKeypair(fromHex(seedHex));
    assert.equal(toHex(publicKey), pubHex);
    assert.equal(secretKey.length, 64);
    assert.equal(toHex(secretKey.slice(0, 32)), seedHex);
    assert.equal(toHex(secretKey.slice(32, 64)), pubHex);
  });
  test(`ed25519: RFC 8032 TEST ${n} reproduces the published signature`, () => {
    const { secretKey } = generateKeypair(fromHex(seedHex));
    assert.equal(toHex(sign(fromHex(msgHex), secretKey)), sigHex);
  });
  test(`ed25519: RFC 8032 TEST ${n} published signature verifies`, () => {
    assert.equal(verify(fromHex(sigHex), fromHex(msgHex), fromHex(pubHex)), true);
  });
}

// ---------- (b) roundtrip ----------

test('ed25519: random seeds/messages roundtrip through sign and verify', () => {
  const rng = lcg(20261012);
  for (let round = 0; round < 12; round++) {
    const seed = randBytes(rng, 32);
    const { publicKey, secretKey } = generateKeypair(seed);
    assert.equal(publicKey.length, 32);
    assert.equal(secretKey.length, 64);
    const msgLen = [0, 1, 31, 32, 33, 64, 100, 1000][round % 8];
    const msg = randBytes(rng, msgLen);
    const sig = sign(msg, secretKey);
    assert.equal(sig.length, 64);
    assert.equal(verify(sig, msg, publicKey), true);
  }
});

// ---------- (c) tamper ----------

test('ed25519: verify fails on tampered signature, message, or wrong key', () => {
  const rng = lcg(99);
  const seed = randBytes(rng, 32);
  const { publicKey, secretKey } = generateKeypair(seed);
  const msg = randBytes(rng, 200);
  const sig = sign(msg, secretKey);
  assert.equal(verify(sig, msg, publicKey), true);

  const badSig = sig.slice();
  badSig[10] ^= 1;
  assert.equal(verify(badSig, msg, publicKey), false);

  const badSig2 = sig.slice();
  badSig2[63] ^= 0x80; // flip the high bit of S
  assert.equal(verify(badSig2, msg, publicKey), false);

  const badMsg = msg.slice();
  badMsg[199] ^= 1;
  assert.equal(verify(sig, badMsg, publicKey), false);

  const other = generateKeypair(randBytes(rng, 32));
  assert.equal(verify(sig, msg, other.publicKey), false);
});

// ---------- (d) cross-check vs node:crypto ----------

// SPKI DER prefix for an Ed25519 public key (12 bytes), then 32 raw bytes.
const SPKI_PREFIX = '302a300506032b6570032100';
// PKCS8 DER prefix for an Ed25519 private key, then the 32-byte seed.
const PKCS8_PREFIX = '302e020100300506032b657004220420';

function nodePrivateKey(seed: Uint8Array) {
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from(PKCS8_PREFIX, 'hex'),
      Buffer.from(seed),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
}

function nodePublicKeyFromRaw(pub: Uint8Array) {
  return createPublicKey({
    key: Buffer.concat([Buffer.from(SPKI_PREFIX, 'hex'), Buffer.from(pub)]),
    format: 'der',
    type: 'spki',
  });
}

test('ed25519: node:crypto accepts signatures made by our sign()', () => {
  const rng = lcg(31337);
  for (let round = 0; round < 6; round++) {
    const seed = randBytes(rng, 32);
    const { publicKey, secretKey } = generateKeypair(seed);
    const msg = randBytes(rng, 1 + Math.floor(rng() * 300));
    const sig = sign(msg, secretKey);
    const ok = nodeVerify(
      null,
      Buffer.from(msg),
      nodePublicKeyFromRaw(publicKey),
      Buffer.from(sig),
    );
    assert.equal(ok, true, 'node:crypto rejected our signature at round ' + round);
  }
});

test('ed25519: our verify() accepts signatures made by node:crypto', () => {
  const rng = lcg(271828);
  for (let round = 0; round < 6; round++) {
    const seed = randBytes(rng, 32);
    const key = nodePrivateKey(seed);
    const { publicKey } = generateKeypair(seed);
    const msg = randBytes(rng, 1 + Math.floor(rng() * 300));
    const sig = nodeSign(null, Buffer.from(msg), key);
    assert.equal(
      verify(new Uint8Array(sig), msg, publicKey),
      true,
      'our verify rejected a node:crypto signature at round ' + round,
    );
  }
});

// ---------- (e) malformed input ----------

test('ed25519: verify returns false (never throws) on malformed input', () => {
  const rng = lcg(7);
  const { publicKey, secretKey } = generateKeypair(randBytes(rng, 32));
  const msg = randBytes(rng, 16);
  const sig = sign(msg, secretKey);

  assert.equal(verify(new Uint8Array(63), msg, publicKey), false);
  assert.equal(verify(new Uint8Array(65), msg, publicKey), false);
  assert.equal(verify(sig, msg, new Uint8Array(31)), false);
  assert.equal(verify(sig, msg, new Uint8Array(33)), false);
  assert.equal(verify(new Uint8Array(64), msg, publicKey), false); // R = zeros
  assert.equal(verify(randBytes(rng, 64), msg, publicKey), false); // garbage sig
  assert.equal(verify(sig, msg, randBytes(rng, 32)), false); // garbage key
  // S >= L must be rejected.
  const bigS = sig.slice();
  bigS.set(fromHex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'), 32);
  assert.equal(verify(bigS, msg, publicKey), false);
  // Empty message is a legitimate case, not malformed.
  const emptySig = sign(new Uint8Array(0), secretKey);
  assert.equal(verify(emptySig, new Uint8Array(0), publicKey), true);
  // Non-Uint8Array / nullish inputs must not throw either.
  assert.equal(verify(null as never, msg, publicKey), false);
  assert.equal(verify(sig, msg, undefined as never), false);
});

test('ed25519: generateKeypair and sign throw on bad key lengths', () => {
  assert.throws(() => generateKeypair(new Uint8Array(31)), /32 bytes/);
  assert.throws(() => generateKeypair(new Uint8Array(33)), /32 bytes/);
  const { secretKey } = generateKeypair(new Uint8Array(32));
  assert.throws(() => sign(new Uint8Array(1), new Uint8Array(63)), /64 bytes/);
  assert.throws(() => sign(new Uint8Array(1), new Uint8Array(65)), /64 bytes/);
});

test('ed25519: toHex/fromHex roundtrip and fromHex rejects malformed hex', () => {
  const rng = lcg(1234);
  const b = randBytes(rng, 64);
  assert.equal(toHex(fromHex(toHex(b))), toHex(b));
  assert.throws(() => fromHex('abc'), /malformed/); // odd length
  assert.throws(() => fromHex('zz'), /malformed/); // bad chars
  assert.equal(fromHex('').length, 0); // empty string -> empty bytes
  assert.equal(toHex(new Uint8Array(0)), '');
});
