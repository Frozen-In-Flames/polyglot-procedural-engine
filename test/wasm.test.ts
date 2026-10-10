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
