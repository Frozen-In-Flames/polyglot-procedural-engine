// native/gen/gen.cpp — seeded 2D simplex noise + fbm. Public domain style,
// written for the engine (Gustavson-style simplex, reimplemented).
#include "gen.hpp"
#include <cmath>

namespace xrgen {
namespace {

// Permutation built from the seed via a tiny xorshift shuffle.
struct Perm {
  unsigned char p[512];
  explicit Perm(unsigned seed) {
    unsigned char base[256];
    for (int i = 0; i < 256; i++) base[i] = (unsigned char)i;
    unsigned s = seed ? seed : 0x9E3779B9u;
    auto rnd = [&]() {
      s ^= s << 13; s ^= s >> 17; s ^= s << 5;
      return s;
    };
    for (int i = 255; i > 0; i--) {
      unsigned j = rnd() % (unsigned)(i + 1);
      unsigned char t = base[i]; base[i] = base[j]; base[j] = t;
    }
    for (int i = 0; i < 512; i++) p[i] = base[i & 255];
  }
};

struct Grad2 { float x, y; };
const Grad2 GRADS[8] = {
  {1,1},{-1,1},{1,-1},{-1,-1},{1,0},{-1,0},{0,1},{0,-1}
};

float simplex2_impl(float x, float y, const Perm& perm) {
  const float F2 = 0.3660254037844386f; // (sqrt(3)-1)/2
  const float G2 = 0.2113248654051871f; // (3-sqrt(3))/6
  float n0 = 0, n1 = 0, n2 = 0;
  float s = (x + y) * F2;
  int i = (int)(x + s), j = (int)(y + s);
  // floor for negatives
  if (x + s < i) i--; if (y + s < j) j--;
  float t = (i + j) * G2;
  float x0 = x - (i - t), y0 = y - (j - t);
  int i1, j1;
  if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
  float x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
  float x2 = x0 - 1.0f + 2.0f * G2, y2 = y0 - 1.0f + 2.0f * G2;
  int ii = i & 255, jj = j & 255;
  float t0 = 0.5f - x0 * x0 - y0 * y0;
  if (t0 > 0) {
    t0 *= t0;
    const Grad2& g = GRADS[perm.p[ii + perm.p[jj]] & 7];
    n0 = t0 * t0 * (g.x * x0 + g.y * y0);
  }
  float t1 = 0.5f - x1 * x1 - y1 * y1;
  if (t1 > 0) {
    t1 *= t1;
    const Grad2& g = GRADS[perm.p[ii + i1 + perm.p[jj + j1]] & 7];
    n1 = t1 * t1 * (g.x * x1 + g.y * y1);
  }
  float t2 = 0.5f - x2 * x2 - y2 * y2;
  if (t2 > 0) {
    t2 *= t2;
    const Grad2& g = GRADS[perm.p[ii + 1 + perm.p[jj + 1]] & 7];
    n2 = t2 * t2 * (g.x * x2 + g.y * y2);
  }
  return 70.0f * (n0 + n1 + n2); // ~[-1, 1]
}

} // namespace

float simplex2(float x, float y, unsigned seed) {
  Perm perm(seed);
  return simplex2_impl(x, y, perm);
}

float fbm2(float x, float y, unsigned seed, int octaves) {
  Perm perm(seed);
  float sum = 0, amp = 0.5f, freq = 1.0f, norm = 0;
  for (int o = 0; o < octaves; o++) {
    sum += amp * simplex2_impl(x * freq, y * freq, perm);
    norm += amp;
    amp *= 0.5f;
    freq *= 2.03f;
  }
  return sum / norm * 0.5f + 0.5f; // [0, 1]
}

void heightfield(unsigned seed, int w, int h, float features, int octaves, float* out) {
  Perm perm(seed);
  for (int j = 0; j < h; j++) {
    for (int i = 0; i < w; i++) {
      float x = (i / (float)(w - 1)) * features;
      float y = (j / (float)(h - 1)) * features;
      float sum = 0, amp = 0.5f, freq = 1.0f, norm = 0;
      for (int o = 0; o < octaves; o++) {
        sum += amp * simplex2_impl(x * freq, y * freq, perm);
        norm += amp;
        amp *= 0.5f;
        freq *= 2.03f;
      }
      out[j * w + i] = sum / norm * 0.5f + 0.5f;
    }
  }
}

void noise1d(unsigned seed, int n, float* out) {
  Perm perm(seed);
  for (int i = 0; i < n; i++) {
    float x = i / (float)(n - 1) * 8.0f;
    float sum = 0, amp = 0.5f, freq = 1.0f, norm = 0;
    for (int o = 0; o < 4; o++) {
      sum += amp * simplex2_impl(x * freq, 0.37f, perm);
      norm += amp;
      amp *= 0.5f;
      freq *= 2.03f;
    }
    out[i] = sum / norm * 0.5f + 0.5f;
  }
}

// Deterministic integer hash (stable across platforms, no <random> needed).
static unsigned dsp_hash(unsigned x) {
  x ^= x >> 16; x *= 0x7feb352d; x ^= x >> 15; x *= 0x846ca68b; x ^= x >> 16;
  return x;
}

void dsp_voice(unsigned seed, int n, int sampleRate, float* out) {
  // A-minor bass movement, 8th notes at 96 BPM. Note choice is hashed from
  // (seed, noteIndex), so the line is fixed per seed on every platform.
  // Phase runs in double precision: float32 phase audibly drifts over a
  // loop, and doubles keep the TS mirror sample-accurate.
  static const double kScale[8] =
      {55.0, 65.41, 73.42, 82.41, 98.0, 110.0, 130.81, 146.83};
  const double noteDur = 60.0 / 96.0 / 2.0;
  const double sr = (double)sampleRate;
  double phase = 0.0;
  for (int i = 0; i < n; i++) {
    double t = i / sr;
    int note = (int)(t / noteDur);
    unsigned h = dsp_hash(seed + (unsigned)note * 2654435761u);
    double freq = kScale[h % 8];
    double nt = t - (double)note * noteDur;
    phase += freq / sr;
    double s = std::sin(phase * 6.283185307179586);
    double sq = std::tanh(2.5 * s);            // square-ish body
    double env = std::exp(-nt * 6.0);          // pluck decay
    double grit = ((h >> 8) % 1000) / 1000.0 - 0.5; // deterministic grit
    out[i] = (float)((sq * 0.6 + s * 0.3 + grit * 0.1) * env * 0.5);
  }
}

} // namespace xrgen

// ---- WASM C ABI (also usable from native hosts) ----
#if defined(__EMSCRIPTEN__)
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

extern "C" {

EMSCRIPTEN_KEEPALIVE
void xr_heightfield(unsigned seed, int w, int h, float features, int octaves, float* out) {
  xrgen::heightfield(seed, w, h, features, octaves, out);
}

EMSCRIPTEN_KEEPALIVE
void xr_noise1d(unsigned seed, int n, float* out) {
  xrgen::noise1d(seed, n, out);
}

EMSCRIPTEN_KEEPALIVE
float xr_fbm2(float x, float y, unsigned seed, int octaves) {
  return xrgen::fbm2(x, y, seed, octaves);
}

EMSCRIPTEN_KEEPALIVE
void xr_dsp_voice(unsigned seed, int n, int sampleRate, float* out) {
  xrgen::dsp_voice(seed, n, sampleRate, out);
}

} // extern "C"
