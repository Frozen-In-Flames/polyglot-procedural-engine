// audio/theory.ts - procedural audio: tuning, synthesis, biquads, spatial.
//
// Equal temperament: f = 440 * 2^((m-69)/12).
// Additive: s(t) = sum_k a_k sin(2 pi f_k t + phi_k).
// RBJ low-pass biquad: w0 = 2 pi f0/Fs, alpha = sin(w0)/(2Q);
//   b0 = b2 = (1-cos w0)/2, b1 = 1 - cos w0,
//   a0 = 1 + alpha, a1 = -2 cos w0, a2 = 1 - alpha;
//   y[n] = (b0 x[n] + b1 x[n-1] + b2 x[n-2] - a1 y[n-1] - a2 y[n-2]) / a0.
// Karplus-Strong: y[n] = (y[n-N] + y[n-N-1])/2, f approx Fs/(N + 1/2).
// PolyBLEP saw: phase t in [0,1), increment dt: saw = 2t - 1 - blep(t).
// Woodworth ITD = (a/c)(theta + sin theta), a = 0.0875 m, c = 343 m/s.
// Distance gain g = r0/max(r, r0).
// Doppler f_o = f_s (c - v_L)/(c - v_S), v_L/v_S radial velocities
//   (positive = receding from the other party).
// Occlusion reuses the soft-shadow march listener-to-source as the
// transmission gain s in [0,1] (see render/raymarch.ts softShadow).

/** MIDI note m to frequency (Hz). */
export function equalTemperament(m: number): number {
  return 440 * 2 ** ((m - 69) / 12);
}

export interface Partial {
  a: number;
  f: number;
  phi: number;
}

/** Additive synthesis: sum of sinusoidal partials at time t (seconds). */
export function additive(partials: Partial[], t: number, _Fs: number): number {
  void _Fs;
  let s = 0;
  for (const p of partials) s += p.a * Math.sin(2 * Math.PI * p.f * t + p.phi);
  return s;
}

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

export interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export const biquadState = (): BiquadState => ({ x1: 0, x2: 0, y1: 0, y2: 0 });

/** RBJ low-pass biquad coefficients. */
export function rbjLowpass(f0: number, Q: number, Fs: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * f0) / Fs;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  return {
    b0: (1 - cosW0) / 2,
    b1: 1 - cosW0,
    b2: (1 - cosW0) / 2,
    a0: 1 + alpha,
    a1: -2 * cosW0,
    a2: 1 - alpha,
  };
}

/** One biquad sample (direct form I). */
export function applyBiquad(c: BiquadCoeffs, x: number, s: BiquadState): number {
  const y = (c.b0 * x + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2) / c.a0;
  s.x2 = s.x1;
  s.x1 = x;
  s.y2 = s.y1;
  s.y1 = y;
  return y;
}

/** Karplus-Strong sounding frequency for delay length N. */
export function karplusStrongFreq(N: number, Fs: number): number {
  return Fs / (N + 0.5);
}

/**
 * One Karplus-Strong step: y[n] = (y[n-N] + y[n-N-1]) / 2.
 * `line` is the delay line, `pos` the write position (advances by 1).
 */
export function karplusStrongStep(line: Float64Array, pos: number): number {
  const N = line.length;
  const a = line[((pos - N) % N + N) % N];
  const b = line[((pos - N - 1) % N + N) % N];
  const y = 0.5 * (a + b);
  line[pos % N] = y;
  return y;
}

/** PolyBLEP residual for phase t in [0,1) with increment dt. */
function blep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return 2 * x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + 2 * x + 1;
  }
  return 0;
}

/** Anti-aliased saw: 2t - 1 - blep(t). */
export function polyBlepSaw(t: number, dt: number): number {
  return 2 * t - 1 - blep(t, dt);
}

/** Woodworth interaural time difference (seconds), theta = azimuth. */
export function woodworthITD(theta: number): number {
  const a = 0.0875, c = 343;
  return (a / c) * (theta + Math.sin(theta));
}

/** Distance gain: 1 inside r0, 1/r beyond. */
export function distanceGain(r: number, r0: number): number {
  return r0 / Math.max(r, r0);
}

/**
 * Doppler shift. f_o = f_s (c - v_L)/(c - v_S).
 * Sign convention (dictated by the formula):
 *   v_S > 0 means the source moves TOWARD the listener,
 *   v_L > 0 means the listener moves AWAY from the source.
 * Approaching source (v_S > 0) gives f_o > f_s; receding gives f_o < f_s.
 */
export function doppler(f_s: number, v_L: number, v_S: number): number {
  const c = 343;
  return f_s * ((c - v_L) / (c - v_S));
}
