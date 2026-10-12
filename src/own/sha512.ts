// Pure-TypeScript SHA-512 (FIPS 180-4). Zero dependencies: typed arrays only,
// so it runs identically in browsers and in Node.js. Written for the V6
// off-chain provenance work: Ed25519 signatures hash with SHA-512.
// Round constants are the fractional parts of the cube roots of the first
// 80 primes, scaled by 2^64; the initial hash state uses the square roots
// of the first 8 primes the same way. Each 64-bit word is a hi/lo pair.

const K = new Uint32Array([
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f,
  0xe9b5dba5, 0x8189dbbc, 0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019,
  0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118, 0xd807aa98, 0xa3030242,
  0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
  0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235,
  0xc19bf174, 0xcf692694, 0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3,
  0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65, 0x2de92c6f, 0x592b0275,
  0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
  0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f,
  0xbf597fc7, 0xbeef0ee4, 0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725,
  0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70, 0x27b70a85, 0x46d22ffc,
  0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
  0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6,
  0x92722c85, 0x1482353b, 0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001,
  0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30, 0xd192e819, 0xd6ef5218,
  0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
  0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99,
  0x34b0bcb5, 0xe19b48a8, 0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb,
  0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3, 0x748f82ee, 0x5defb2fc,
  0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915,
  0xc67178f2, 0xe372532b, 0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207,
  0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178, 0x06f067aa, 0x72176fba,
  0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
  0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc,
  0x431d67c4, 0x9c100d4c, 0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a,
  0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
]);

const H_INIT = new Uint32Array([
  0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b,
  0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
  0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f,
  0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179,
]);

// Scratch pairs, reused so the hot loop allocates nothing.
const RA = new Uint32Array(2);
const RB = new Uint32Array(2);
const RC = new Uint32Array(2);

/** r = x + y, each a 64-bit [hi, lo] pair at the given offsets. */
function add64(r: Uint32Array, ri: number, x: Uint32Array, xi: number, y: Uint32Array, yi: number): void {
  const lo = x[xi + 1] + y[yi + 1];
  r[ri + 1] = lo >>> 0;
  r[ri] = (x[xi] + y[yi] + (lo >= 0x100000000 ? 1 : 0)) >>> 0;
}

/** r = ROTR_n(x). */
function rotr64(r: Uint32Array, x: Uint32Array, xi: number, n: number): void {
  const hi = x[xi];
  const lo = x[xi + 1];
  if (n < 32) {
    r[0] = ((hi >>> n) | (lo << (32 - n))) >>> 0;
    r[1] = ((lo >>> n) | (hi << (32 - n))) >>> 0;
  } else {
    const m = n - 32;
    r[0] = ((lo >>> m) | (hi << (32 - m))) >>> 0;
    r[1] = ((hi >>> m) | (lo << (32 - m))) >>> 0;
  }
}

/** r = (x >>> n), logical right shift of a 64-bit pair. */
function shr64(r: Uint32Array, x: Uint32Array, xi: number, n: number): void {
  r[0] = x[xi] >>> n;
  r[1] = ((x[xi + 1] >>> n) | (x[xi] << (32 - n))) >>> 0;
}

/** Hash a message. Returns exactly 64 bytes. */
export function sha512(message: Uint8Array): Uint8Array {
  const ml = message.length;
  // Room for the 0x80 byte plus the 16-byte big-endian bit length.
  const total = Math.ceil((ml + 17) / 128) * 128;
  const buf = new Uint8Array(total);
  buf.set(message);
  buf[ml] = 0x80;
  const bits = ml * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 4, bits >>> 0, false);
  dv.setUint32(total - 8, Math.floor(bits / 0x100000000), false);

  const H = new Uint32Array(H_INIT);
  const W = new Uint32Array(160); // 80 64-bit words as hi/lo pairs
  const V = new Uint32Array(16); // working variables a..h as hi/lo pairs

  for (let off = 0; off < total; off += 128) {
    for (let t = 0; t < 16; t++) {
      W[t * 2] = dv.getUint32(off + t * 8, false);
      W[t * 2 + 1] = dv.getUint32(off + t * 8 + 4, false);
    }
    for (let t = 16; t < 80; t++) {
      const w = t * 2;
      // s0 = ROTR1(W[t-15]) ^ ROTR8(W[t-15]) ^ SHR7(W[t-15])
      rotr64(RA, W, w - 30, 1);
      rotr64(RB, W, w - 30, 8);
      shr64(RC, W, w - 30, 7);
      const s0hi = (RA[0] ^ RB[0] ^ RC[0]) >>> 0;
      const s0lo = (RA[1] ^ RB[1] ^ RC[1]) >>> 0;
      // s1 = ROTR19(W[t-2]) ^ ROTR61(W[t-2]) ^ SHR6(W[t-2])
      rotr64(RA, W, w - 4, 19);
      rotr64(RB, W, w - 4, 61);
      shr64(RC, W, w - 4, 6);
      const s1hi = (RA[0] ^ RB[0] ^ RC[0]) >>> 0;
      const s1lo = (RA[1] ^ RB[1] ^ RC[1]) >>> 0;
      // W[t] = W[t-16] + s0 + W[t-7] + s1
      let hi = W[w - 32] + s0hi + W[w - 14] + s1hi;
      let lo = W[w - 31] + s0lo + W[w - 13] + s1lo;
      hi += Math.floor(lo / 0x100000000);
      W[w] = hi >>> 0;
      W[w + 1] = lo >>> 0;
    }

    V.set(H);
    for (let t = 0; t < 80; t++) {
      const k = t * 2;
      // S1 = ROTR14(e) ^ ROTR18(e) ^ ROTR41(e)
      rotr64(RA, V, 8, 14);
      rotr64(RB, V, 8, 18);
      rotr64(RC, V, 8, 41);
      const s1hi = (RA[0] ^ RB[0] ^ RC[0]) >>> 0;
      const s1lo = (RA[1] ^ RB[1] ^ RC[1]) >>> 0;
      // ch = (e & f) ^ (~e & g)
      const ehi = V[8];
      const elo = V[9];
      const chHi = ((ehi & V[10]) ^ (~ehi & V[12])) >>> 0;
      const chLo = ((elo & V[11]) ^ (~elo & V[13])) >>> 0;
      // T1 = h + S1 + ch + K[t] + W[t]
      let t1hi = V[14] + s1hi + chHi + K[k] + W[k];
      let t1lo = V[15] + s1lo + chLo + K[k + 1] + W[k + 1];
      t1hi += Math.floor(t1lo / 0x100000000);
      const T1hi = t1hi >>> 0;
      const T1lo = t1lo >>> 0;
      // S0 = ROTR28(a) ^ ROTR34(a) ^ ROTR39(a)
      rotr64(RA, V, 0, 28);
      rotr64(RB, V, 0, 34);
      rotr64(RC, V, 0, 39);
      const s0hi = (RA[0] ^ RB[0] ^ RC[0]) >>> 0;
      const s0lo = (RA[1] ^ RB[1] ^ RC[1]) >>> 0;
      // maj = (a & b) ^ (a & c) ^ (b & c)
      const ahi = V[0];
      const alo = V[1];
      const majHi = ((ahi & V[2]) ^ (ahi & V[4]) ^ (V[2] & V[4])) >>> 0;
      const majLo = ((alo & V[3]) ^ (alo & V[5]) ^ (V[3] & V[5])) >>> 0;
      // T2 = S0 + maj
      let t2hi = s0hi + majHi;
      let t2lo = s0lo + majLo;
      t2hi += Math.floor(t2lo / 0x100000000);
      // rotate: h=g, g=f, f=e, e=d+T1, d=c, c=b, b=a, a=T1+T2
      V[14] = V[12]; V[15] = V[13];
      V[12] = V[10]; V[13] = V[11];
      V[10] = V[8]; V[11] = V[9];
      let ehi2 = V[6] + T1hi;
      let elo2 = V[7] + T1lo;
      ehi2 += Math.floor(elo2 / 0x100000000);
      V[8] = ehi2 >>> 0; V[9] = elo2 >>> 0;
      V[6] = V[4]; V[7] = V[5];
      V[4] = V[2]; V[5] = V[3];
      V[2] = V[0]; V[3] = V[1];
      let ahi2 = T1hi + (t2hi >>> 0);
      let alo2 = T1lo + (t2lo >>> 0);
      ahi2 += Math.floor(alo2 / 0x100000000);
      V[0] = ahi2 >>> 0; V[1] = alo2 >>> 0;
    }
    for (let i = 0; i < 16; i += 2) {
      add64(H, i, H, i, V, i);
    }
  }

  const out = new Uint8Array(64);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    odv.setUint32(i * 8, H[i * 2], false);
    odv.setUint32(i * 8 + 4, H[i * 2 + 1], false);
  }
  return out;
}
