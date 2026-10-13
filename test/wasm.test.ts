// Tests the TS<->WASM bridge end to end in node.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('wasm bridge: C++ heightfield via WasmGenCore', async (t) => {
  const genUrl = new URL('file:///home/hatch/workspace/xr-engine/demo/public/gen/gen.js');
  const { WasmGenCore } = await import('../src/bridge/wasm.js');
  let factory: (() => Promise<unknown>) | undefined;
  try {
    const m = await import(genUrl.href);
    factory = () => (m.default ?? m)();
  } catch {
    t.skip('WASM build not present; run native/build-wasm.sh');
    return;
  }
  const core = await WasmGenCore.load(factory);
  assert.equal(core.languageTag, 'C++ (WASM)');
  assert.equal(core.ready, true);
  const n = 16 * 16;
  const out = new Float32Array(n);
  core.heightfield(42, 16, 16, 5, 4, out);
  assert.ok(out.every((v) => v >= 0 && v <= 1), 'range [0,1]');
  const out2 = new Float32Array(n);
  core.heightfield(42, 16, 16, 5, 4, out2);
  assert.ok(out.every((v, i) => v === out2[i]), 'deterministic');
  const out3 = new Float32Array(n);
  core.noise1D(7, n, out3);
  assert.ok(out3.every((v) => v >= 0 && v <= 1), 'noise1d range');
  // C++ DSP voice: deterministic, in [-1,1], real signal.
  const vlen = 4410;
  const v1 = new Float32Array(vlen);
  const v2 = new Float32Array(vlen);
  core.dspVoice(7, vlen, 44100, v1);
  core.dspVoice(7, vlen, 44100, v2);
  assert.ok(v1.every((v) => v >= -1 && v <= 1), 'dsp range [-1,1]');
  assert.ok(v1.every((v, i) => v === v2[i]), 'dsp deterministic');
  const energy = v1.reduce((a, v) => a + Math.abs(v), 0) / vlen;
  assert.ok(energy > 0.01, 'dsp has signal');
  const v3 = new Float32Array(vlen);
  core.dspVoice(8, vlen, 44100, v3);
  assert.ok(v1.some((v, i) => v !== v3[i]), 'dsp varies by seed');

  // The bridge must not write outside `out`.
  const guard = new Float32Array(n + 8).fill(-1);
  const view = guard.subarray(4, 4 + n);
  core.heightfield(42, 16, 16, 5, 4, view);
  assert.ok(guard.slice(0, 4).every((v) => v === -1), 'no underflow write');
  assert.ok(guard.slice(4 + n).every((v) => v === -1), 'no overflow write');
});

// V8 ("the engine gets ears"): the C++ DSP core (native/gen/dsp/,
// docs/V8-AUDIO.md §1.2). EMSCRIPTEN_KEEPALIVE exports must be present and
// callable; renders must be deterministic (same seed → bit-identical
// samples, docs/V8-AUDIO.md §2.6); double-precision phase must stay stable
// over long renders. Follows the existing skip pattern when the WASM build
// itself is absent — but a PRESENT build without the V8 exports is a
// contract mismatch and fails (rebuild via native/build-wasm.sh).
test('wasm dsp core (V8): xr_dsp_* exports present, callable, deterministic', async (t) => {
  const genUrl = new URL('file:///home/hatch/workspace/xr-engine/demo/public/gen/gen.js');
  let m: any;
  try {
    m = await import(genUrl.href);
  } catch {
    t.skip('WASM build not present; run native/build-wasm.sh');
    return;
  }
  const mod = await (m.default ?? m)();

  // §1.2 export list (xr_dsp_voice is covered by the test above).
  const expected = [
    '_xr_dsp_osc',
    '_xr_dsp_fm',
    '_xr_dsp_grain',
    '_xr_dsp_pluck',
    '_xr_dsp_modal',
    '_xr_dsp_biquad',
    '_xr_dsp_ladder',
    '_xr_dsp_ir',
  ];
  const missing = expected.filter((e) => typeof mod[e] !== 'function');
  assert.equal(
    missing.length,
    0,
    `V8 contract (docs/V8-AUDIO.md §1.2): WASM module missing KEEPALIVE exports: ${missing.join(', ')}. ` +
      `Rebuild with the V8 DSP core (native/gen/dsp/) via native/build-wasm.sh.`,
  );

  // Render helper: every V8 DSP export renders n mono samples at `rate`
  // into `out` (the out pointer is the 4th C++ argument for all of them).
  const render = (fn: string, seed: number, n: number, rate: number, ...rest: number[]): Float32Array => {
    const out = new Float32Array(n);
    const ptr = mod._malloc(n * 4);
    try {
      mod[fn](seed, n, rate, ptr, ...rest);
      const mem = new Float32Array(mod.wasmMemory.buffer);
      out.set(mem.subarray(ptr >> 2, (ptr >> 2) + n));
    } finally {
      mod._free(ptr);
    }
    return out;
  };

  // Fully-specified signatures (§1.2) get full render-determinism checks.
  // xr_dsp_fm / _grain / _biquad / _ladder carry '...' argument lists in the
  // spec (buffer pointers the test must not guess at); for those,
  // present-and-callable above is the honest boundary.
  const cases: Array<[string, number, number, number, number[]]> = [
    ['_xr_dsp_osc', 7, 1024, 44100, [1, 220.0, 4.0]], // wave=saw, freq, detune cents
    ['_xr_dsp_pluck', 7, 2048, 44100, [440.0, 0.995]], // freq, decay
    ['_xr_dsp_modal', 7, 2048, 44100, [330.0, 6, 0.999]], // freq, modes, decay
    ['_xr_dsp_ir', 11, 2048, 44100, [1.8, 0.6]], // decay, damping
  ];
  for (const [fn, seed, n, rate, rest] of cases) {
    const a = render(fn, seed, n, rate, ...rest);
    const b = render(fn, seed, n, rate, ...rest);
    assert.ok(a.every((v, i) => v === b[i]), `${fn}: same seed → bit-identical samples`);
    assert.ok(a.every(Number.isFinite), `${fn}: all samples finite`);
    const energy = a.reduce((s, v) => s + Math.abs(v), 0) / n;
    assert.ok(energy > 1e-6, `${fn}: renders a real signal (mean |x| = ${energy})`);
    const c = render(fn, seed + 1, n, rate, ...rest);
    assert.ok(a.some((v, i) => v !== c[i]), `${fn}: output varies with seed`);
  }

  // Double-precision phase stability over long renders (§7.1): a 4-second
  // oscillator render must be bit-identical across runs and free of
  // NaN/Inf drift — float32 phase would audibly wander over a loop.
  const long1 = render('_xr_dsp_osc', 7, 44100 * 4, 44100, 0, 110.0, 0.0);
  const long2 = render('_xr_dsp_osc', 7, 44100 * 4, 44100, 0, 110.0, 0.0);
  assert.ok(long1.every((v, i) => v === long2[i]), 'long render: bit-identical across runs');
  assert.ok(long1.every(Number.isFinite), 'long render: no NaN/Inf drift (double-precision phase)');
});
