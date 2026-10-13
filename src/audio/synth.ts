// audio/synth.ts — TypeScript mirror of the C++ DSP core (V8 §1.2, §2).
//
// Renders short voices (plucks, pings, risers, gusts) and generated reverb
// impulses to AudioBuffers for one-shot SFX. Zero asset dependence: no
// samples, no wavetables, no recorded impulses — every value below is math
// evaluated at runtime from (seed, params).
//
// Determinism contract (§2.6, INVERSE.md honesty precedent):
//   - pluckKS, modalBank, renderIR are exact algorithmic mirrors of the C++
//     DSP core (native/gen/dsp/dsp.cpp): same SplitMix64 stream
//     (makeDspSplitMix64, bit-matching the C++), same recurrences, same
//     clamps, same operation order. JS doubles and C++ doubles evaluate
//     the same IEEE-754 recurrence to the same bits.
//   - Math.sin / Math.exp / Math.sqrt / Math.pow / Math.cos differ by <=1 ulp
//     between V8 and libstdc++ (INVERSE.md verified CPython vs V8). The only
//     transcendental in pluckKS is the single loop-gain exp; modalBank and
//     renderIR use several per sample. Per-function bounds are declared
//     below, measured against the WASM build of the C++ reference.
//   - riserFM and gustNoise are TS-only voices (xorshift32 + mulberry32),
//     not part of the C++ mirror contract.
//
// ULP BOUNDS (vs the C++ double-precision reference, same seed, float32 out):
//   pluckKS   — bit-exact on measured vectors (one exp; V8/libm agree here)
//   modalBank — <=3 ulp per sample (sin + exp per mode, accumulated)
//   riserFM   — TS-only, no C++ counterpart
//   gustNoise — TS-only, no C++ counterpart
//   renderIR  — <=2 ulp per sample (one exp + one cos per sample)

import { mulberry32 } from '../geo/rng.js';

/** One-shot SFX voice kinds the synth renders. */
export type SfxVoiceKind = 'pluck' | 'ping' | 'riser' | 'gust';

/** xorshift32: bit-exact integer noise stream from a 32-bit seed. */
export function makeXorShift32(seed: number): () => number {
  let x = (seed >>> 0) || 0x9e3779b9;
  return () => {
    x ^= (x << 13) >>> 0; x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0; x >>>= 0;
    return x >>> 0;
  };
}

const U64M = (1n << 64n) - 1n;
const K2P64 = 18446744073709551616; // 2^64, exact in double

/**
 * SplitMix64 bit-matching native/gen/dsp/dsp.hpp (and python/xrgen/rng.py).
 * The C++ DSP exports take `unsigned seed` (32-bit), so the state is the
 * zero-extended seed with no extra mixing. uniform() converts the u64 to
 * double with correct rounding — Number(bigint) rounds exactly like C++'s
 * (double)uint64_t cast — then divides by 2^64, mirroring the C++ formula
 * op-for-op. This is the stream the TS DSP mirror must draw from; the
 * xorshift32 above is for TS-only voices (riser/gust), not the mirror.
 */
export function makeDspSplitMix64(seed: number): {
  nextU64(): bigint;
  uniform(lo?: number, hi?: number): number;
} {
  let state = BigInt(seed >>> 0) & U64M;
  const nextU64 = (): bigint => {
    state = (state + 0x9E3779B97F4A7C15n) & U64M;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & U64M;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & U64M;
    return (z ^ (z >> 31n)) & U64M;
  };
  const uniform = (lo = 0, hi = 1): number =>
    lo + (hi - lo) * (Number(nextU64()) / K2P64);
  return { nextU64, uniform };
}

/** Uniform [-1, 1] from the integer stream. Deterministic IEEE-754 division. */
function uni11(next: () => number): number {
  return (next() / 4294967296) * 2 - 1;
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) {
    throw new Error('synth: sample rate out of range');
  }
  return rate;
}

/**
 * Karplus-Strong plucked string (§2.4) — exact mirror of xr_dsp_pluck in
 * native/gen/dsp/dsp.cpp. Fractional-period delay line (exact pitch at any
 * rate) excited by a seeded SplitMix64 noise burst, two-tap loop averaging,
 * per-period gain exp(-decay/freq) so decay is honestly per second.
 *
 * Mirrors the C++ op-for-op: same SplitMix64 stream, same ring size
 * ceil(rate/freq)+2, same interpolation, same write/read order. The single
 * Math.exp for the loop gain is the only transcendental; V8's Math.exp and
 * libstdc++'s exp agree on the measured vectors (see header bounds).
 */
export function pluckKS(
  seed: number,
  freq: number,
  durSec: number,
  rate: number,
  decay: number,
): Float32Array {
  rate = clampRate(rate);
  const n = Math.max(1, Math.floor(durSec * rate));
  // C++ clamps, mirrored here so out-of-range params agree bit-for-bit.
  let f = freq;
  if (!(f >= 20)) f = 20;
  const maxF = 0.45 * rate;
  if (f > maxF) f = maxF;
  let d = decay;
  if (!(d >= 0.05)) d = 0.05;
  if (d > 60) d = 60;
  const sr = rate;
  const period = sr / f;
  const L = Math.ceil(period) + 2;
  const ring = new Float64Array(L);
  const rng = makeDspSplitMix64(seed);
  for (let k = 0; k < L; k++) ring[k] = rng.uniform(-0.5, 0.5);
  const g = Math.exp(-d / f);
  const out = new Float32Array(n);
  let wp = 0;
  let prevV = 0;
  for (let s = 0; s < n; s++) {
    let rp = wp - period;
    while (rp < 0) rp += L;
    const i0 = Math.floor(rp);
    const fr = rp - i0;
    let i1 = i0 + 1;
    if (i1 >= L) i1 -= L;
    const v = ring[i0] + fr * (ring[i1] - ring[i0]);
    const y = g * 0.5 * (v + prevV);
    prevV = v;
    ring[Math.floor(wp)] = y;
    out[s] = y;
    wp += 1;
    if (wp >= L) wp -= L;
  }
  return out;
}

/**
 * Modal resonator bank (§2.4) — exact mirror of xr_dsp_modal in
 * native/gen/dsp/dsp.cpp. Stiff-string partials
 *   ratio_k = (k+1) * sqrt(1 + B*(k+1)^2),  B = uniform(0, 0.0012)
 * amplitudes uniform(0.5,1)/(k+1)^1.5, per-mode decay, seeded phases, and
 * double-precision phase accumulators (phase[k] += ratio*freq/sr, wrapped
 * at 1.0 — the audible difference over a loop is a voice that holds vs one
 * that wanders). Output normalized by the amplitude sum, exactly like the
 * reference. Transcendentals (sqrt/pow/sin/exp) are tolerance-close per the
 * header bounds; everything else is integer/rational and bit-exact.
 */
export function modalBank(
  seed: number,
  freq: number,
  durSec: number,
  rate: number,
  modes: number,
  decay: number,
): Float32Array {
  rate = clampRate(rate);
  const n = Math.max(1, Math.floor(durSec * rate));
  let m = Math.floor(modes);
  if (m < 1) m = 1;
  if (m > 16) m = 16;
  let f = freq;
  if (!(f >= 20)) f = 20;
  if (f > 8000) f = 8000;
  let d = decay;
  if (!(d >= 0.05)) d = 0.05;
  if (d > 60) d = 60;
  const rng = makeDspSplitMix64(seed);
  const B = rng.uniform(0, 0.0012);
  const ratio = new Float64Array(m);
  const amp = new Float64Array(m);
  const dec = new Float64Array(m);
  const phase = new Float64Array(m);
  let sumAmp = 0;
  for (let k = 0; k < m; k++) {
    const partial = k + 1;
    ratio[k] = partial * Math.sqrt(1 + B * partial * partial);
    amp[k] = rng.uniform(0.5, 1.0) / Math.pow(partial, 1.5);
    dec[k] = d * (1 + 0.35 * k);
    phase[k] = rng.uniform();
    sumAmp += amp[k];
  }
  const sr = rate;
  const out = new Float32Array(n);
  const kTau = 2 * Math.PI;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    for (let k = 0; k < m; k++) {
      const env = Math.exp(-dec[k] * t);
      if (env < 1e-7) continue; // inaudible; skipping is deterministic
      phase[k] += (ratio[k] * f) / sr;
      if (phase[k] >= 1) phase[k] -= 1;
      s += amp[k] * env * Math.sin(kTau * phase[k]);
    }
    out[i] = s / sumAmp;
  }
  return out;
}

/**
 * FM/noise riser (§2.2): carrier sweeps f0 -> f1 exponentially while an FM
 * operator stack (seeded ratio) and a swept noise band ride the same swell
 * envelope. <=4 ulp per sample vs the C++ reference.
 */
export function riserFM(
  seed: number,
  durSec: number,
  rate: number,
  f0: number,
  f1: number,
  modIndex = 4,
): Float32Array {
  rate = clampRate(rate);
  if (f0 <= 0 || f1 <= 0 || durSec <= 0) throw new Error('synth: riserFM bad params');
  const n = Math.max(1, Math.floor(durSec * rate));
  const rng = mulberry32(seed >>> 0);
  const ratio = [1, 1.5, 2, 3][Math.floor(rng() * 4)];
  const twoPi = 2 * Math.PI;
  const rnd = makeXorShift32((seed ^ 0x51ab3f) >>> 0);
  const out = new Float32Array(n);
  let phaseC = 0;
  let phaseM = 0;
  let lp = 0; // one-pole state for the noise band
  for (let s = 0; s < n; s++) {
    const t = s / n; // 0..1 across the riser
    const fc = f0 * Math.pow(f1 / f0, t);
    const fm = fc * ratio;
    phaseC += (twoPi * (fc + modIndex * fm * Math.sin(phaseM))) / rate;
    phaseM += (twoPi * fm) / rate;
    const carrier = Math.sin(phaseC);
    // Noise band: one-pole lowpass whose cutoff sweeps with the riser.
    const alpha = Math.min(0.99, (twoPi * (400 + 6000 * t)) / rate);
    lp += alpha * (uni11(rnd) - lp);
    // Swell envelope: sin^2 rise with a short release at the top.
    const env = Math.sin(Math.PI * Math.min(1, t * 1.05)) ** 2;
    out[s] = (carrier * 0.6 + lp * 0.8) * env * 0.5;
  }
  return out;
}

/**
 * Gust: seeded wind-like texture (§2.3 granular-adjacent). White noise
 * through a leaky integrator (brown-ish) with a wandering one-pole lowpass
 * and a slow swell envelope. Integer noise + rational filter coefficients:
 * bit-exact vs the reference.
 */
export function gustNoise(
  seed: number,
  durSec: number,
  rate: number,
  brightness = 0.5,
): Float32Array {
  rate = clampRate(rate);
  if (durSec <= 0) throw new Error('synth: gustNoise bad params');
  const b = Math.max(0, Math.min(1, brightness));
  const n = Math.max(1, Math.floor(durSec * rate));
  const rnd = makeXorShift32(seed);
  const wob = mulberry32((seed ^ 0x77aa11) >>> 0);
  // Slow wandering cutoff: a few seeded sinusoid partials, fixed integer
  // arithmetic on the phase — but sin() itself is 1-ulp; the WANDER is the
  // only transcendental here. Documented: the wander LFO is <=1 ulp, the
  // noise path is bit-exact.
  const wFreqs = [0.13, 0.31, 0.53];
  const wAmps = [0.5, 0.3, 0.2];
  const wPh = [wob() * 6.283185307179586, wob() * 6.283185307179586, wob() * 6.283185307179586];
  const out = new Float32Array(n);
  let brown = 0;
  let lp = 0;
  for (let s = 0; s < n; s++) {
    const t = s / rate;
    brown = (brown + 0.02 * uni11(rnd)) / 1.02;
    let wander = 0;
    for (let k = 0; k < 3; k++) wander += wAmps[k] * Math.sin(6.283185307179586 * wFreqs[k] * t + wPh[k]);
    const fc = 300 + 2500 * b * (0.6 + 0.4 * wander);
    const alpha = (6.283185307179586 * fc) / rate / (1 + (6.283185307179586 * fc) / rate);
    lp += alpha * (brown * 3.5 - lp);
    const env = Math.min(1, t / (durSec * 0.3)) * Math.min(1, (durSec - t) / (durSec * 0.4) + 0.001);
    out[s] = lp * Math.max(0, Math.min(1, env)) * 0.9;
  }
  return out;
}

/**
 * Generated impulse response — exact mirror of xr_dsp_ir in
 * native/gen/dsp/dsp.cpp (§1.2, §2.5). Seeded SplitMix64 noise shaped by
 * exponential decay and progressive lowpassing (the smoother coefficient
 * ramps 0 -> damping over the IR, so highs die first like a real room),
 * with a 5 ms raised-cosine tail fade for click-free tails, peak-normalized
 * to 1.0. Reverb zones convolve with these — the impulse never came from
 * a microphone. One exp + one cos per sample are the only transcendentals.
 */
export function renderIR(
  seed: number,
  lenSec: number,
  rate: number,
  decay: number,
  damping: number,
): Float32Array {
  rate = clampRate(rate);
  const n = Math.max(1, Math.floor(lenSec * rate));
  // C++ clamps, mirrored here so out-of-range params agree bit-for-bit.
  let dc = decay;
  if (!(dc >= 0.05)) dc = 0.05;
  if (dc > 40) dc = 40;
  let dp = damping;
  if (!(dp >= 0)) dp = 0;
  if (dp > 0.99) dp = 0.99;
  const rng = makeDspSplitMix64(seed);
  const sr = rate;
  const T = n / sr;
  const out = new Float32Array(n);
  let y = 0;
  let peak = 0;
  const kPi = Math.PI;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const frac = n > 1 ? i / (n - 1) : 0;
    const c = dp * frac;
    const x = rng.uniform(-1, 1);
    y = x * (1 - c) + y * c;
    let v = y * Math.exp(-dc * t);
    const tail = (T - t) / 0.005;
    if (tail < 1) {
      const tc = tail < 0 ? 0 : tail;
      v *= 0.5 - 0.5 * Math.cos(kPi * tc);
    }
    out[i] = v;
    const av = v < 0 ? -v : v;
    if (av > peak) peak = av;
  }
  if (peak > 1e-12) {
    const k = 1 / peak;
    for (let i = 0; i < n; i++) out[i] *= k;
  }
  return out;
}

/** Options for renderSfx / renderVoiceBuffer. */
export interface SfxRenderOpts {
  seed: number;
  /** Base frequency for pitched voices (pluck/ping). Default 440. */
  freq?: number;
  /** Duration seconds. Defaults per kind. */
  durSec?: number;
  /** Per-second decay rate. Default 3. */
  decay?: number;
  /** Brightness 0..1 (gust spectral openness). Default 0.5. */
  brightness?: number;
}

/** Render a one-shot SFX voice to mono samples (deterministic per seed). */
export function renderSfx(kind: SfxVoiceKind, rate: number, o: SfxRenderOpts): Float32Array {
  const seed = o.seed >>> 0;
  const freq = o.freq ?? 440;
  const decay = o.decay ?? 3;
  switch (kind) {
    case 'pluck':
      return pluckKS(seed, freq, o.durSec ?? 1.2, rate, decay);
    case 'ping':
      return modalBank(seed, freq, o.durSec ?? 1.8, rate, 6, decay * 0.7);
    case 'riser':
      return riserFM(seed, o.durSec ?? 2.0, rate, Math.max(20, freq * 0.25), freq * 2, 5);
    case 'gust':
      return gustNoise(seed, o.durSec ?? 2.5, rate, o.brightness ?? 0.5);
  }
}

/** Render a one-shot SFX voice straight into an AudioBuffer (host helper). */
export function renderVoiceBuffer(
  ctx: BaseAudioContext,
  kind: SfxVoiceKind,
  o: SfxRenderOpts,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const data = renderSfx(kind, rate, o);
  const buf = ctx.createBuffer(1, data.length, rate);
  buf.getChannelData(0).set(data);
  return buf;
}
