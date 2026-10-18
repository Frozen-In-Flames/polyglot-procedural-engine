import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linearToSrgb, srgbToLinear, lanczos, lanczosTaps1D, resolveImage,
  lambert, cookTorranceGgx, shBasis, shIrradiance, lambertSH, SH_AHAT,
} from '../src/inverse/forward.js';
import type { Vec3 } from '../src/math/vec.js';

test('forward: sRGB encode/decode round-trips within tolerance', () => {
  for (const c of [0, 0.001, 0.0031308, 0.01, 0.18, 0.5, 0.9, 1.0]) {
    const rt = srgbToLinear(linearToSrgb(c));
    assert.ok(Math.abs(rt - c) < 1e-9, `c=${c} rt=${rt}`);
  }
  // Piecewise joint is continuous: 12.92 * 0.0031308 ~= 0.04045.
  assert.ok(Math.abs(linearToSrgb(0.0031308) - 0.04045) < 1e-4);
  assert.ok(Math.abs(srgbToLinear(0.04045) - 0.0031308) < 1e-6);
});

test('forward: Lanczos kernel and normalized taps', () => {
  assert.equal(lanczos(0, 2), 1);
  assert.equal(lanczos(2, 2), 0);
  assert.equal(lanczos(2.5, 2), 0);
  for (const pos of [0.3, 1.0, 2.7, 5.5]) {
    for (const a of [2, 3]) {
      const taps = lanczosTaps1D(pos, a);
      const sum = taps.reduce((s, t) => s + t.w, 0);
      assert.ok(Math.abs(sum - 1) < 1e-12, `pos=${pos} a=${a} sum=${sum}`);
    }
  }
});

test('forward: resolveImage tone-maps a constant linear render', () => {
  const render = Array.from({ length: 8 }, () => new Array(8).fill(0.18));
  const out = resolveImage(render, 4, 4, 2);
  const expected = linearToSrgb(0.18);
  for (const row of out) for (const v of row) {
    assert.ok(Math.abs(v - expected) < 1e-9);
  }
});

test('forward: GGX normal distribution integrates to 1 over the hemisphere', () => {
  // Integral of D(h) (n.h) over h in the hemisphere = 1 (normalization):
  // 2 pi * integral_0^{pi/2} D(theta) cos(theta) sin(theta) dtheta.
  const alpha = 0.25;
  const a2 = alpha * alpha;
  const nT = 400;
  let sum = 0;
  for (let i = 0; i < nT; i++) {
    const theta = ((i + 0.5) / nT) * (Math.PI / 2);
    const ct = Math.cos(theta), st = Math.sin(theta);
    const denom = ct * ct * (a2 - 1) + 1;
    const D = a2 / (Math.PI * denom * denom);
    sum += D * ct * st;
  }
  const integral = sum * ((Math.PI / 2) / nT) * (2 * Math.PI);
  assert.ok(Math.abs(integral - 1) < 0.01, `integral=${integral}`);
});

test('forward: Cook-Torrance floors keep it finite', () => {
  const n: Vec3 = [0, 0, 1], l: Vec3 = [0, 0, 1], v: Vec3 = [0, 0, 1];
  const r = cookTorranceGgx({ rho: 0.5, F0: 0.04, alpha: 0, n, l, v, E: 1 });
  assert.ok(Number.isFinite(r) && r > 0);
  const grazing: Vec3 = [1, 0, 0.001];
  const rg = cookTorranceGgx({ rho: 0.5, F0: 0.04, alpha: 0.3, n, l: grazing, v, E: 1 });
  assert.ok(Number.isFinite(rg) && rg >= 0);
});

test('forward: constant white environment gives E = pi', () => {
  // L = 2 sqrt(pi) on Y00 only (projection of constant 1): E = Ahat_0 L_00 Y_00 = pi.
  const L = [2 * Math.sqrt(Math.PI), 0, 0, 0, 0, 0, 0, 0, 0];
  for (const n of [[0, 0, 1], [1, 0, 0], [0, 1, 0], [0.577, 0.577, 0.577]] as Vec3[]) {
    const dl = Math.hypot(n[0], n[1], n[2]);
    const nn: Vec3 = [n[0] / dl, n[1] / dl, n[2] / dl];
    assert.ok(Math.abs(shIrradiance(nn, L) - Math.PI) < 1e-9);
    // Lambertian out = rho E / pi, not off by pi.
    assert.ok(Math.abs(lambertSH(1, nn, L) - 1) < 1e-9);
  }
  assert.equal(SH_AHAT[0], Math.PI);
});

test('forward: SH basis Y00 is the constant', () => {
  const Y = shBasis([0, 0, 1]);
  assert.ok(Math.abs(Y[0] - 1 / (2 * Math.sqrt(Math.PI))) < 1e-12);
});

test('forward: Lambert baseline matches the solver forward model', () => {
  const n: Vec3 = [0, 0, 1], l: Vec3 = [0, 0, 1];
  assert.equal(lambert(0.5, n, l, 2), 1.0);
  const back: Vec3 = [0, 0, -1];
  assert.equal(lambert(0.5, n, back, 2), 0);
});
