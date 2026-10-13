// native/gen/dsp/dsp.hpp — V8 procedural audio DSP core.
//
// Pure functions of (seed, params). No I/O, no assets, no platform code.
// Same rules as the noise core (native/gen/): compiles to WebAssembly for
// the TS bridge and to native later for the performance core.
//
// - Double-precision phase accumulators everywhere: float32 phase audibly
//   drifts over a loop; doubles keep the C++ reference bit-exact per seed
//   (the test oracle for the TS mirror in src/audio/synth.ts).
// - All musical quantities are defined in seconds (Hz, per-second decay),
//   never in sample counts, so 44.1 kHz and 48 kHz render the same music
//   on different sample grids.
// - Seeded RNG is SplitMix64, matching python/xrgen/rng.py and the
//   Swift/Kotlin/C# vendored copies. The next_u64() stream is bit-identical
//   across languages; uniform() divides by 2^64 exactly like the Python
//   mirror, so the double stream matches too.
#pragma once

#include <cstdint>

namespace xrgen {

// ---------------------------------------------------------------------------
// SplitMix64 — deterministic seeded RNG (matches python/xrgen/rng.py).
// ---------------------------------------------------------------------------
class SplitMix64 {
 public:
  explicit SplitMix64(uint64_t seed) : state_(seed) {}

  // The raw 64-bit stream. Bit-identical to Rng.next_u64() in rng.py and
  // to the Swift/Kotlin/C# vendored copies.
  uint64_t next_u64() {
    uint64_t z = (state_ += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
  }

  // Uniform double in [lo, hi). Matches rng.py's uniform(): the u64 is
  // converted to double (correct rounding, same as CPython) and divided
  // by 2^64.
  double uniform(double lo = 0.0, double hi = 1.0) {
    static const double k2p64 = 18446744073709551616.0;
    return lo + (hi - lo) * ((double)next_u64() / k2p64);
  }

  // Uniform integer in [0, n).
  uint64_t next_below(uint64_t n) { return next_u64() % n; }

 private:
  uint64_t state_;
};

// ---------------------------------------------------------------------------
// DSP voices. Each renders n mono float samples in [-1, 1] (soft-bounded)
// into `out`. `rate` is the sample rate in Hz. All are pure functions of
// (seed, params): same seed + same params + same rate => bit-identical
// samples, on every platform.
// ---------------------------------------------------------------------------

// polyBLEP band-limited oscillator bank with a seeded detune pair.
// wave: 0 = sine, 1 = saw, 2 = square, 3 = triangle.
// Two voices are mixed: voice 0 at `freq`, voice 1 at
// freq * 2^((detuneCents + seeded_micro_drift) / 1200), where the seeded
// micro drift is uniform in [-1.5, +1.5] cents (the "detune pairs are
// seeded" law from the V8 spec). Both voices start at seeded phases.
// Band-limited via polyBLEP (saw/square) and integrated polyBLEP square
// (triangle); the sine is exact. No wavetables.
void osc(unsigned seed, int n, int rate, float* out, int wave, double freq,
         double detuneCents);

// 2-6 operator FM stacks, serial cascade (each operator phase-modulates the
// one below it; the top operator is unmodulated). `carriers` is the operator
// count, clamped to [2, 6]. `ratios[k]` is operator k's frequency ratio to
// the carrier base; `indices[k]` is the depth (in phase cycles) at which
// operator k+1 modulates operator k (indices[ops-1] unused).
// The seed owns what the caller doesn't pass: if `ratios` is null, ratios
// are drawn seeded from {0.5, 1, 1.5, 2, 3, 4, 2.99}; if `indices` is null,
// indices are drawn seeded uniform in [0.5, 6]. The seed also sets the
// carrier base frequency (log-uniform 55-440 Hz) and a seeded
// attack/decay envelope (attack 3-20 ms, exponential decay 0.8-3.5 /s),
// with modulation depth following the envelope (DX-style).
// All operators derive from the osc bank's sine; no tables.
void fm(unsigned seed, int n, int rate, float* out, int carriers,
        const double* ratios, const double* indices);

// Granular engine over a caller-supplied source buffer. The source is
// itself synthesized by the caller (e.g. an FM texture rendered once into
// memory) — NO loaded samples ever reach this function; it only reads the
// float buffer it is handed.
// Grains are scheduled with seeded Poisson timing at `density` grains/sec,
// each of `grainSec` seconds with a Hann window, start offset uniform over
// the source, playback rate 2^(uniform(-pitchJitter, +pitchJitter)/12)
// semitones, amplitude uniform in [0.7, 1.0].
// `panScatter` in [0, 1]: per-grain equal-power pan position, rendered to
// the mono mix as (cos+sin)/sqrt(2) so scatter stays audible as seeded
// gain microstructure (the TS spatial layer applies the same seed for real
// panning). Output is normalized by 1/sqrt(max(1, density*grainSec)) so
// cloud density doesn't change loudness.
void grain(unsigned seed, int n, int rate, float* out, int srcLen,
           const float* src, double density, double grainSec,
           double pitchJitter, double panScatter);

// Karplus-Strong plucked string: a fractional delay line (so the pitch is
// exactly `freq` Hz at any rate) excited by a seeded noise burst, with a
// two-tap averaging lowpass in the feedback loop. The per-period loop gain
// is exp(-decay / freq), so the fundamental decays at exactly `decay`
// per second; the averaging filter damps higher partials faster, like a
// real string. One page of code, infinite guitars.
void pluck(unsigned seed, int n, int rate, float* out, double freq,
           double decay);

// Modal resonator bank: `modes` damped sine modes (clamped to [1, 16]) at
// seeded inharmonic ratios — stiff-string partials
// f_k = (k+1) * freq * sqrt(1 + B*(k+1)^2) with seeded B in [0, 0.0012].
// Mode amplitudes fall as 1/(k+1)^1.5 with seeded jitter; mode k decays at
// decay*(1+0.35k) per second (higher modes die faster). Bells, plates,
// glass. Output is normalized by the sum of mode amplitudes (bounded).
void modal(unsigned seed, int n, int rate, float* out, double freq, int modes,
           double decay);

// Biquad suite (RBJ cookbook, double-precision coefficients, transposed
// direct form II). type: 0 = lowpass, 1 = highpass, 2 = bandpass
// (constant 0 dB peak gain). `freq` is clamped to [10, 0.45*rate] Hz,
// `q` to [0.05, 24]. The filter is fully determined by (type, freq, q);
// `seed` is accepted for export uniformity and reserved for future
// voice-variation — it does not change the response.
void biquad(unsigned seed, int n, int rate, float* out, const float* in,
            int type, double freq, double q);

// Seeded 4-pole ladder filter for voices: four cascaded one-pole lowpass
// stages with global feedback and a tanh-bounded feedback summer.
// `cutoff` in Hz (clamped to [20, min(18000, 0.45*rate)]), `reso` in
// [0, 1] maps to feedback gain reso*4 (self-oscillation near 1, like the
// hardware). Each stage's cutoff carries a seeded +/-2% component
// tolerance — the "seeded" in the name, and why two voices with different
// seeds don't phase-cancel like clones. Simplified model (no
// oversampling): stable and musical, documented as such.
void ladder(unsigned seed, int n, int rate, float* out, const float* in,
            double cutoff, double reso);

// GENERATED impulse responses — never captured from a microphone. Seeded
// white noise shaped by an exponential decay envelope (exp(-decay*t),
// `decay` per second) and progressive lowpassing: a one-pole smoother
// whose coefficient ramps 0 -> `damping` over the IR, so highs die first
// like a real room. A 5 ms raised-cosine fade guarantees a click-free
// tail; the IR is peak-normalized to 1.0. This is how reverb zones get
// tails with zero audio files.
void ir(unsigned seed, int len, int rate, float* out, double decay,
        double damping);

}  // namespace xrgen
