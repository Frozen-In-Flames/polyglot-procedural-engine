// native/gen/dsp/dsp.cpp — V8 procedural audio DSP core implementation.
//
// Pure functions of (seed, params). No I/O, no assets, no platform code,
// no third-party libraries — <cmath>, <cstdint>, <cstddef>, <vector> only.
// See dsp.hpp for the contract each function honors.
#include "dsp.hpp"

#include <cmath>
#include <cstddef>
#include <cstdlib>  // malloc/free: no C++ runtime needed, emcc links clean

namespace xrgen {
namespace {

const double kTau = 6.283185307179586;
const double kPi = 3.141592653589793;

// polyBLEP residual for a discontinuity at phase 0. phase in [0,1), dt is
// the phase increment per sample. Returns the correction to ADD to the
// naive waveform.
inline double polyblep(double phase, double dt) {
  if (phase < dt) {
    double t = phase / dt;
    return t + t - t * t - 1.0;
  }
  if (phase > 1.0 - dt) {
    double t = (phase - 1.0) / dt;
    return t * t + t + t + 1.0;
  }
  return 0.0;
}

// One band-limited oscillator sample. phase in [0,1). tri is the
// per-voice triangle integrator state (only touched when wave == 3).
inline double osc_sample(double phase, double dt, int wave, double& tri,
                         double tri_leak) {
  switch (wave) {
    case 1: {  // saw: naive 2p-1, BLEP at the wrap
      return 2.0 * phase - 1.0 - polyblep(phase, dt);
    }
    case 2: {  // square: BLEP at 0 and at the 0.5 edge
      double y = (phase < 0.5) ? 1.0 : -1.0;
      y += polyblep(phase, dt);
      double ph2 = phase + 0.5;
      if (ph2 >= 1.0) ph2 -= 1.0;
      y -= polyblep(ph2, dt);
      return y;
    }
    case 3: {  // triangle: integrate the band-limited square.
      // The band-limited square is zero-mean, so its integral is a bounded
      // triangle at +/-1; tri_leak (per sample, ~1) only eats float-error DC.
      double y = (phase < 0.5) ? 1.0 : -1.0;
      y += polyblep(phase, dt);
      double ph2 = phase + 0.5;
      if (ph2 >= 1.0) ph2 -= 1.0;
      y -= polyblep(ph2, dt);
      tri = tri * tri_leak + y * (2.0 * dt);
      return tri;
    }
    default: {  // sine: exact
      return std::sin(kTau * phase);
    }
  }
}

inline int clamp_rate(int rate) { return rate > 0 ? rate : 44100; }

}  // namespace

void osc(unsigned seed, int n, int rate, float* out, int wave, double freq,
         double detuneCents) {
  if (n <= 0 || out == nullptr) return;
  rate = clamp_rate(rate);
  int w = wave < 0 ? 0 : (wave > 3 ? 3 : wave);
  if (!(freq > 0.0)) {
    for (int i = 0; i < n; i++) out[i] = 0.0f;
    return;
  }
  double nyquist = 0.45 * (double)rate;
  if (freq > nyquist) freq = nyquist;

  SplitMix64 rng(seed);
  double p0 = rng.uniform();  // seeded start phases
  double p1 = rng.uniform();
  // Seeded detune pair: the named detune plus a seeded micro drift so two
  // voices never phase-lock like clones.
  double cents = detuneCents + rng.uniform(-1.5, 1.5);
  double dt0 = freq / (double)rate;
  double dt1 = freq * std::pow(2.0, cents / 1200.0) / (double)rate;
  if (dt1 > 0.45) dt1 = 0.45;

  double tri0 = 0.0, tri1 = 0.0;
  double tri_leak = std::exp(-0.05 / (double)rate);  // 0.05/s DC eater
  for (int i = 0; i < n; i++) {
    double v0 = osc_sample(p0, dt0, w, tri0, tri_leak);
    double v1 = osc_sample(p1, dt1, w, tri1, tri_leak);
    out[i] = (float)(0.5 * (v0 + v1));
    p0 += dt0;
    if (p0 >= 1.0) p0 -= 1.0;
    p1 += dt1;
    if (p1 >= 1.0) p1 -= 1.0;
  }
}

void fm(unsigned seed, int n, int rate, float* out, int carriers,
        const double* ratios, const double* indices) {
  if (n <= 0 || out == nullptr) return;
  rate = clamp_rate(rate);
  int ops = carriers < 2 ? 2 : (carriers > 6 ? 6 : carriers);

  SplitMix64 rng(seed);
  // Seeded fallbacks when the caller passes null (the "seeded ratios" path).
  double rbuf[6], ibuf[6];
  static const double kRatioPool[7] = {0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 2.99};
  if (ratios == nullptr) {
    for (int k = 0; k < ops; k++) rbuf[k] = kRatioPool[rng.next_below(7)];
    ratios = rbuf;
  }
  if (indices == nullptr) {
    for (int k = 0; k < ops; k++) ibuf[k] = rng.uniform(0.5, 6.0);
    indices = ibuf;
  }
  double r[6], idx[6];
  for (int k = 0; k < ops; k++) {
    double rk = ratios[k];
    r[k] = rk < 0.1 ? 0.1 : (rk > 16.0 ? 16.0 : rk);
    double ik = indices[k];
    idx[k] = ik < 0.0 ? 0.0 : (ik > 24.0 ? 24.0 : ik);
  }
  double base = 55.0 * std::pow(2.0, rng.uniform(0.0, 3.0));  // 55..440 Hz
  double atk = rng.uniform(0.003, 0.02);                     // seconds
  double dec = rng.uniform(0.8, 3.5);                        // per second
  double phase[6];
  for (int k = 0; k < ops; k++) phase[k] = rng.uniform();

  double sr = (double)rate;
  for (int i = 0; i < n; i++) {
    double t = (double)i / sr;
    double env = (t < atk) ? t / atk : std::exp(-dec * (t - atk));
    double y[6];
    for (int k = ops - 1; k >= 0; k--) {
      phase[k] += r[k] * base / sr;
      if (phase[k] >= 1.0) phase[k] -= 1.0;  // inc < 1 by the clamps above
      // Modulation depth follows the envelope: brightness tracks loudness.
      double mod = (k + 1 < ops) ? idx[k] * env * y[k + 1] : 0.0;
      y[k] = std::sin(kTau * (phase[k] + mod));
    }
    out[i] = (float)(0.5 * env * y[0]);
  }
}

void grain(unsigned seed, int n, int rate, float* out, int srcLen,
           const float* src, double density, double grainSec,
           double pitchJitter, double panScatter) {
  if (n <= 0 || out == nullptr) return;
  rate = clamp_rate(rate);
  double sr = (double)rate;
  if (src == nullptr || srcLen < 16) {
    for (int i = 0; i < n; i++) out[i] = 0.0f;
    return;
  }
  if (density < 0.01) density = 0.01;
  if (grainSec < 0.005) grainSec = 0.005;
  if (grainSec > 2.0) grainSec = 2.0;
  if (pitchJitter < 0.0) pitchJitter = 0.0;
  if (pitchJitter > 24.0) pitchJitter = 24.0;
  if (panScatter < 0.0) panScatter = 0.0;
  if (panScatter > 1.0) panScatter = 1.0;

  SplitMix64 rng(seed);
  double srcDur = (double)srcLen / sr;
  double gLen = grainSec < srcDur ? grainSec : srcDur;

  struct Grain {
    double pos;  // read position, in source samples
    double rate;  // source samples advanced per output sample
    double age;   // seconds since onset
    double amp;
    double pan;  // equal-power mono gain from the pan position
    bool live;
  };
  Grain grains[64];
  for (int s = 0; s < 64; s++) grains[s].live = false;

  double nextOnset = 0.0;
  double overlap = density * gLen;
  double norm = 0.5 / std::sqrt(overlap > 1.0 ? overlap : 1.0);

  for (int i = 0; i < n; i++) {
    double t = (double)i / sr;
    while (t >= nextOnset) {
      int slot = -1;
      for (int s = 0; s < 64; s++) {
        if (!grains[s].live) {
          slot = s;
          break;
        }
      }
      // Draws happen in a fixed order per spawn so the RNG stream is
      // identical regardless of slot availability.
      double pr = std::pow(2.0, rng.uniform(-pitchJitter, pitchJitter) / 12.0);
      double need = pr * gLen;  // source seconds this grain will traverse
      double start = (need < srcDur) ? rng.uniform(0.0, srcDur - need) : 0.0;
      double pan = rng.uniform(-1.0, 1.0) * panScatter;
      double th = pan * (kPi / 4.0);
      double amp = rng.uniform(0.7, 1.0);
      if (slot >= 0) {
        grains[slot].pos = start * sr;
        grains[slot].rate = pr;
        grains[slot].age = 0.0;
        grains[slot].amp = amp;
        // Equal-power pan rendered to mono: (cos+sin)/sqrt(2) is 1 at
        // center, 1 at the extremes — scatter without level jumps.
        grains[slot].pan = (std::cos(th) + std::sin(th)) / 1.4142135623730951;
        grains[slot].live = true;
      }
      // Seeded Poisson scheduling (seconds — rate independent).
      double u = rng.uniform();
      if (u > 1.0 - 1e-12) u = 1.0 - 1e-12;
      double gap = -std::log(1.0 - u) / density;
      if (gap < 0.001) gap = 0.001;
      nextOnset += gap;
    }
    double mix = 0.0;
    for (int s = 0; s < 64; s++) {
      if (!grains[s].live) continue;
      double tau = grains[s].age / gLen;
      if (tau >= 1.0 || grains[s].pos >= (double)srcLen - 1) {
        grains[s].live = false;
        continue;
      }
      double w = 0.5 - 0.5 * std::cos(kTau * tau);  // Hann window
      double p = grains[s].pos;
      int p0 = (int)p;
      double fr = p - (double)p0;
      int p1 = (p0 + 1 < srcLen) ? p0 + 1 : p0;
      double sv = (double)src[p0] + fr * ((double)src[p1] - (double)src[p0]);
      mix += grains[s].amp * grains[s].pan * w * sv;
      grains[s].pos += grains[s].rate;
      grains[s].age += 1.0 / sr;
    }
    out[i] = (float)(mix * norm);
  }
}

void pluck(unsigned seed, int n, int rate, float* out, double freq,
           double decay) {
  if (n <= 0 || out == nullptr) return;
  rate = clamp_rate(rate);
  if (!(freq >= 20.0)) freq = 20.0;
  double maxF = 0.45 * (double)rate;
  if (freq > maxF) freq = maxF;
  if (!(decay >= 0.05)) decay = 0.05;
  if (decay > 60.0) decay = 60.0;

  double sr = (double)rate;
  double period = sr / freq;  // fractional: exact pitch at any rate
  int L = (int)std::ceil(period) + 2;
  // malloc, not vector: keeps the module free of the C++ runtime so the
  // existing emcc (C-mode) link in build-wasm.sh keeps working.
  double* ring = (double*)std::malloc((size_t)L * sizeof(double));
  if (ring == nullptr) {
    for (int i = 0; i < n; i++) out[i] = 0.0f;
    return;
  }

  SplitMix64 rng(seed);
  for (int k = 0; k < L; k++) ring[k] = rng.uniform(-0.5, 0.5);

  // Per-period loop gain: after `freq` periods (one second) the fundamental
  // has decayed by exp(-decay) — so `decay` is honestly per second.
  double g = std::exp(-decay / freq);
  double wp = 0.0;
  double prevV = 0.0;
  for (int i = 0; i < n; i++) {
    double rp = wp - period;
    while (rp < 0.0) rp += (double)L;
    int i0 = (int)rp;
    double fr = rp - (double)i0;
    int i1 = i0 + 1;
    if (i1 >= L) i1 -= L;
    double v = ring[i0] + fr * (ring[i1] - ring[i0]);
    double y = g * 0.5 * (v + prevV);  // two-tap averaging: the damping
    prevV = v;
    ring[(int)wp] = y;
    out[i] = (float)y;
    wp += 1.0;
    if (wp >= (double)L) wp -= (double)L;
  }
  std::free(ring);
}

void modal(unsigned seed, int n, int rate, float* out, double freq, int modes,
           double decay) {
  if (n <= 0 || out == nullptr) return;
  rate = clamp_rate(rate);
  int m = modes < 1 ? 1 : (modes > 16 ? 16 : modes);
  if (!(freq >= 20.0)) freq = 20.0;
  if (freq > 8000.0) freq = 8000.0;
  if (!(decay >= 0.05)) decay = 0.05;
  if (decay > 60.0) decay = 60.0;

  SplitMix64 rng(seed);
  double B = rng.uniform(0.0, 0.0012);  // stiff-string inharmonicity
  double ratio[16], amp[16], dec[16], phase[16];
  double sumAmp = 0.0;
  for (int k = 0; k < m; k++) {
    double partial = (double)(k + 1);
    ratio[k] = partial * std::sqrt(1.0 + B * partial * partial);
    amp[k] = rng.uniform(0.5, 1.0) / std::pow(partial, 1.5);
    dec[k] = decay * (1.0 + 0.35 * (double)k);
    phase[k] = rng.uniform();
    sumAmp += amp[k];
  }

  double sr = (double)rate;
  for (int i = 0; i < n; i++) {
    double t = (double)i / sr;
    double s = 0.0;
    for (int k = 0; k < m; k++) {
      double env = std::exp(-dec[k] * t);
      if (env < 1e-7) continue;  // inaudible; skipping is deterministic
      phase[k] += ratio[k] * freq / sr;  // double-precision accumulator
      if (phase[k] >= 1.0) phase[k] -= 1.0;
      s += amp[k] * env * std::sin(kTau * phase[k]);
    }
    out[i] = (float)(s / sumAmp);
  }
}

void biquad(unsigned seed, int n, int rate, float* out, const float* in,
            int type, double freq, double q) {
  (void)seed;  // Accepted for export uniformity; the response is fully
               // determined by (type, freq, q). Documented in dsp.hpp.
  if (n <= 0 || out == nullptr) return;
  rate = clamp_rate(rate);
  if (in == nullptr) {
    for (int i = 0; i < n; i++) out[i] = 0.0f;
    return;
  }
  int ty = type < 0 ? 0 : (type > 2 ? 2 : type);
  if (!(freq >= 10.0)) freq = 10.0;
  double maxF = 0.45 * (double)rate;
  if (freq > maxF) freq = maxF;
  if (!(q >= 0.05)) q = 0.05;
  if (q > 24.0) q = 24.0;

  // RBJ cookbook.
  double w0 = kTau * freq / (double)rate;
  double cw = std::cos(w0);
  double sw = std::sin(w0);
  double alpha = sw / (2.0 * q);
  double b0, b1, b2, a0, a1, a2;
  if (ty == 1) {  // highpass
    b0 = (1.0 + cw) / 2.0;
    b1 = -(1.0 + cw);
    b2 = (1.0 + cw) / 2.0;
  } else if (ty == 2) {  // bandpass, constant 0 dB peak gain
    b0 = alpha;
    b1 = 0.0;
    b2 = -alpha;
  } else {  // lowpass
    b0 = (1.0 - cw) / 2.0;
    b1 = 1.0 - cw;
    b2 = (1.0 - cw) / 2.0;
  }
  a0 = 1.0 + alpha;
  a1 = -2.0 * cw;
  a2 = 1.0 - alpha;
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  a1 /= a0;
  a2 /= a0;

  // Transposed direct form II, double state.
  double s1 = 0.0, s2 = 0.0;
  for (int i = 0; i < n; i++) {
    double x = (double)in[i];
    double y = b0 * x + s1;
    s1 = b1 * x - a1 * y + s2;
    s2 = b2 * x - a2 * y;
    out[i] = (float)y;
  }
}

void ladder(unsigned seed, int n, int rate, float* out, const float* in,
            double cutoff, double reso) {
  if (n <= 0 || out == nullptr) return;
  rate = clamp_rate(rate);
  if (in == nullptr) {
    for (int i = 0; i < n; i++) out[i] = 0.0f;
    return;
  }
  if (!(cutoff >= 20.0)) cutoff = 20.0;
  double maxC = 0.45 * (double)rate;
  if (maxC > 18000.0) maxC = 18000.0;
  if (cutoff > maxC) cutoff = maxC;
  if (!(reso >= 0.0)) reso = 0.0;
  if (reso > 1.0) reso = 1.0;

  SplitMix64 rng(seed);
  double sr = (double)rate;
  // Seeded per-stage component tolerance (+/-2%): the "seeded" in the name.
  double a[4];
  for (int k = 0; k < 4; k++) {
    double fc = cutoff * (1.0 + rng.uniform(-0.02, 0.02));
    a[k] = 1.0 - std::exp(-kTau * fc / sr);  // exact per-second coefficient
  }
  double kfb = reso * 4.0;
  if (kfb > 3.95) kfb = 3.95;

  // Four cascaded one-pole stages with global feedback through a
  // tanh-bounded summer. Simplified nonlinear ladder (no oversampling):
  // stable for the clamped ranges above, musical resonance that blooms
  // into self-oscillation as reso -> 1.
  double s[4] = {0.0, 0.0, 0.0, 0.0};
  for (int i = 0; i < n; i++) {
    double x = std::tanh((double)in[i] - kfb * s[3]);
    s[0] += a[0] * (x - s[0]);
    s[1] += a[1] * (s[0] - s[1]);
    s[2] += a[2] * (s[1] - s[2]);
    s[3] += a[3] * (s[2] - s[3]);
    out[i] = (float)s[3];
  }
}

void ir(unsigned seed, int len, int rate, float* out, double decay,
        double damping) {
  if (len <= 0 || out == nullptr) return;
  rate = clamp_rate(rate);
  if (!(decay >= 0.05)) decay = 0.05;
  if (decay > 40.0) decay = 40.0;
  if (!(damping >= 0.0)) damping = 0.0;
  if (damping > 0.99) damping = 0.99;

  SplitMix64 rng(seed);
  double sr = (double)rate;
  double T = (double)len / sr;
  double y = 0.0;
  double peak = 0.0;
  for (int i = 0; i < len; i++) {
    double t = (double)i / sr;
    double frac = (len > 1) ? (double)i / (double)(len - 1) : 0.0;
    // Progressive lowpassing: the smoother coefficient ramps 0 -> damping
    // over the IR, so highs die first like a real room.
    double c = damping * frac;
    double x = rng.uniform(-1.0, 1.0);
    y = x * (1.0 - c) + y * c;
    double v = y * std::exp(-decay * t);
    // 5 ms raised-cosine fade guarantees a click-free tail.
    double tail = (T - t) / 0.005;
    if (tail < 1.0) {
      double tc = tail < 0.0 ? 0.0 : tail;
      v *= 0.5 - 0.5 * std::cos(kPi * tc);
    }
    out[i] = (float)v;
    double av = v < 0.0 ? -v : v;
    if (av > peak) peak = av;
  }
  if (peak > 1e-12) {
    float g = (float)(1.0 / peak);
    for (int i = 0; i < len; i++) out[i] *= g;
  }
}

}  // namespace xrgen

// ---- WASM C ABI (also usable from native hosts) ----
#if defined(__EMSCRIPTEN__)
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

extern "C" {

EMSCRIPTEN_KEEPALIVE
void xr_dsp_osc(unsigned seed, int n, int rate, float* out, int wave,
                double freq, double detuneCents) {
  xrgen::osc(seed, n, rate, out, wave, freq, detuneCents);
}

EMSCRIPTEN_KEEPALIVE
void xr_dsp_fm(unsigned seed, int n, int rate, float* out, int carriers,
               const double* ratios, const double* indices) {
  xrgen::fm(seed, n, rate, out, carriers, ratios, indices);
}

EMSCRIPTEN_KEEPALIVE
void xr_dsp_grain(unsigned seed, int n, int rate, float* out, int srcLen,
                  const float* src, double density, double grainSec,
                  double pitchJitter, double panScatter) {
  xrgen::grain(seed, n, rate, out, srcLen, src, density, grainSec, pitchJitter,
               panScatter);
}

EMSCRIPTEN_KEEPALIVE
void xr_dsp_pluck(unsigned seed, int n, int rate, float* out, double freq,
                  double decay) {
  xrgen::pluck(seed, n, rate, out, freq, decay);
}

EMSCRIPTEN_KEEPALIVE
void xr_dsp_modal(unsigned seed, int n, int rate, float* out, double freq,
                  int modes, double decay) {
  xrgen::modal(seed, n, rate, out, freq, modes, decay);
}

EMSCRIPTEN_KEEPALIVE
void xr_dsp_biquad(unsigned seed, int n, int rate, float* out, const float* in,
                   int type, double freq, double q) {
  xrgen::biquad(seed, n, rate, out, in, type, freq, q);
}

EMSCRIPTEN_KEEPALIVE
void xr_dsp_ladder(unsigned seed, int n, int rate, float* out, const float* in,
                   double cutoff, double reso) {
  xrgen::ladder(seed, n, rate, out, in, cutoff, reso);
}

EMSCRIPTEN_KEEPALIVE
void xr_dsp_ir(unsigned seed, int len, int rate, float* out, double decay,
               double damping) {
  xrgen::ir(seed, len, rate, out, decay, damping);
}

}  // extern "C"
