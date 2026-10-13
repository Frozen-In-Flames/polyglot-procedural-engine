#!/bin/bash
# Builds the C++ procedural core to WebAssembly.
# Requires Emscripten (emsdk). Run: source ~/emsdk/emsdk_env.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p demo/public/gen
emcc native/gen/gen.cpp native/gen/dsp/dsp.cpp -o demo/public/gen/gen.js \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -O3 \
  -s EXPORTED_FUNCTIONS='["_xr_heightfield","_xr_noise1d","_xr_fbm2","_xr_dsp_voice","_xr_dsp_osc","_xr_dsp_fm","_xr_dsp_grain","_xr_dsp_pluck","_xr_dsp_modal","_xr_dsp_biquad","_xr_dsp_ladder","_xr_dsp_ir","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["wasmMemory"]'
echo "WASM build complete: demo/public/gen/"
ls -la demo/public/gen/
