// Pure-TypeScript Ed25519 (RFC 8032), ref10-style extended-coordinate
// arithmetic. Zero dependencies beyond the in-tree SHA-512: typed arrays
// and BigInt only, so it runs identically in browsers and in Node.js.
// Built for the V6 off-chain provenance mints: signed manifests that
// anyone can verify, no chain, no new runtime dependencies, zero budget.
//
// Field ops reduce mod p after every multiply/add so intermediates stay
// small; scalar math is plain BigInt mod the group order L.

import { sha512 } from './sha512.js';

const P = (1n << 255n) - 19n; // field prime 2^255 - 19
const L = (1n << 252n) + 27742317777372353535851937790883648493n; // group order
const D = mod(-121665n * modInv(121666n)); // curve constant d
const IY = modPow(2n, (P - 1n) >> 2n); // sqrt(-1) mod p
// Base point B: x odd, y = 4/5 mod p.
const BX = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const BY = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;

/** Extended twisted-Edwards coordinates (X, Y, Z, T): x = X/Z, y = Y/Z. */
type Pt = [bigint, bigint, bigint, bigint];

const IDENT: Pt = [0n, 1n, 1n, 0n];
const BASE: Pt = [BX, BY, 1n, mod(BX * BY)];

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function modPow(base: bigint, exp: bigint): bigint {
  let b = mod(base);
  let e = exp;
  let out = 1n;
  while (e > 0n) {
    if (e & 1n) out = mod(out * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return out;
}

function modInv(a: bigint): bigint {
  return modPow(a, P - 2n);
}

// Point addition on extended coordinates (Hisil et al.).
function ptAdd(p1: Pt, p2: Pt): Pt {
  const A = mod((p1[1] - p1[0]) * (p2[1] - p2[0]));
  const B = mod((p1[1] + p1[0]) * (p2[1] + p2[0]));
  const C = mod(p1[3] * 2n * D * p2[3]);
  const Dd = mod(p1[2] * 2n * p2[2]);
  const E = mod(B - A);
  const F = mod(Dd - C);
  const G = mod(Dd + C);
  const H = mod(B + A);
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}

// Point doubling on extended coordinates (a = -1 for Ed25519).
function ptDouble(p: Pt): Pt {
  const A = mod(p[0] * p[0]);
  const B = mod(p[1] * p[1]);
  const C = mod(2n * p[2] * p[2]);
  const Dd = mod(-A);
  const E = mod((p[0] + p[1]) * (p[0] + p[1]) - A - B);
  const G = mod(Dd + B);
  const F = mod(G - C);
  const H = mod(Dd - B);
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}

function ptNeg(p: Pt): Pt {
  return [mod(-p[0]), p[1], p[2], mod(-p[3])];
}

function isIdentity(p: Pt): boolean {
  return mod(p[0]) === 0n && mod(p[1] - p[2]) === 0n;
}

// 4-bit window table for the fixed base: table[i] = i * B.
const BASE_TABLE: Pt[] = (() => {
  const t: Pt[] = [IDENT, BASE];
  for (let i = 2; i < 16; i++) t.push(ptAdd(t[i - 1], BASE));
  return t;
})();

/** Fixed-base scalar multiply s * B, s < L. */
function scalarMultBase(s: bigint): Pt {
  let q: Pt = IDENT;
  for (let w = 63; w >= 0; w--) {
    for (let k = 0; k < 4; k++) q = ptDouble(q);
    const idx = Number((s >> BigInt(w * 4)) & 15n);
    if (idx !== 0) q = ptAdd(q, BASE_TABLE[idx]);
  }
  return q;
}

/** Variable-base scalar multiply s * p, s < L (plain double-and-add). */
function scalarMult(p: Pt, s: bigint): Pt {
  let q: Pt = IDENT;
  for (let b = 252; b >= 0; b--) {
    q = ptDouble(q);
    if ((s >> BigInt(b)) & 1n) q = ptAdd(q, p);
  }
  return q;
}

function encodePoint(p: Pt): Uint8Array {
  const zi = modInv(p[2]);
  const x = mod(p[0] * zi);
  let y = mod(p[1] * zi);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(y & 255n);
    y >>= 8n;
  }
  out[31] |= Number(x & 1n) << 7;
  return out;
}

function decodePoint(enc: Uint8Array): Pt {
  const sign = (enc[31] >> 7) & 1;
  const raw = enc.slice();
  raw[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(raw[i]);
  if (y >= P) throw new Error('ed25519: y out of range');
  const y2 = mod(y * y);
  const x2 = mod(mod(y2 - 1n) * modInv(mod(D * y2 + 1n)));
  let x = modPow(x2, (P + 3n) >> 3n);
  if (mod(x * x - x2) !== 0n) {
    x = mod(x * IY);
    if (mod(x * x - x2) !== 0n) throw new Error('ed25519: not on curve');
  }
  if (Number(x & 1n) !== sign) x = P - x;
  return [x, y, 1n, mod(x * y)];
}

function leToBig(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

function bigToLe32(v: bigint): Uint8Array {
  let x = v;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(x & 255n);
    x >>= 8n;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** RFC 8032 scalar clamping of the first 32 bytes of SHA-512(seed). */
function clampScalar(h: Uint8Array): bigint {
  const b = h.slice(0, 32);
  b[0] &= 248;
  b[31] &= 127;
  b[31] |= 64;
  return leToBig(b);
}

export function generateKeypair(seed: Uint8Array): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error('ed25519: seed must be exactly 32 bytes');
  }
  const h = sha512(seed);
  const s = clampScalar(h);
  const publicKey = encodePoint(scalarMultBase(s));
  return { publicKey, secretKey: concat(seed, publicKey) };
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 64) {
    throw new Error('ed25519: secret key must be exactly 64 bytes');
  }
  if (!(message instanceof Uint8Array)) {
    throw new Error('ed25519: message must be a Uint8Array');
  }
  const h = sha512(secretKey.slice(0, 32));
  const s = clampScalar(h);
  const prefix = h.slice(32, 64);
  const pub = encodePoint(scalarMultBase(s));
  const r = leToBig(sha512(concat(prefix, message))) % L;
  const R = encodePoint(scalarMultBase(r));
  const k = leToBig(sha512(concat(R, pub, message))) % L;
  const S = (r + k * s) % L;
  return concat(R, bigToLe32(S));
}

export function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    if (
      !(signature instanceof Uint8Array) ||
      !(publicKey instanceof Uint8Array) ||
      !(message instanceof Uint8Array) ||
      signature.length !== 64 ||
      publicKey.length !== 32
    ) {
      return false;
    }
    const R = decodePoint(signature.slice(0, 32));
    const A = decodePoint(publicKey);
    const S = leToBig(signature.slice(32, 64));
    if (S >= L) return false;
    const k =
      leToBig(sha512(concat(signature.slice(0, 32), publicKey, message))) % L;
    // Check S*B - k*A - R == identity.
    const lhs = ptAdd(scalarMultBase(S), ptNeg(scalarMult(A, k)));
    return isIdentity(ptAdd(lhs, ptNeg(R)));
  } catch {
    return false;
  }
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('ed25519: malformed hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
