// native/gen/gen.hpp — procedural generation core.
//
// Pure functions of (seed, params). No I/O, no assets, no platform code.
// Compiles to WebAssembly for v1 (called live from TypeScript) and to native
// later for the performance core. Same source, both targets.
#pragma once

namespace xrgen {

// Seeded 2D simplex noise in [-1, 1].
float simplex2(float x, float y, unsigned seed);

// Fractal Brownian motion over simplex2, normalized to [0, 1].
float fbm2(float x, float y, unsigned seed, int octaves);

// Fill `out` (w*h) with a heightfield in [0, 1].
// features = approximate number of noise features across the grid.
void heightfield(unsigned seed, int w, int h, float features, int octaves, float* out);

// Fill `out` (n) with 1D fbm noise in [0, 1] (sampled along x at fixed y).
void noise1d(unsigned seed, int n, float* out);

// Render `n` mono samples of a seeded synth voice into `out` ([-1, 1]).
// A plucky sequenced bass: deterministic per seed, pure DSP, no samples.
void dsp_voice(unsigned seed, int n, int sampleRate, float* out);

} // namespace xrgen
