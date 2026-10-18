import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pixelAngularSize, footprint, epsForDistance, octaveFadeWeights,
  fadeSlopeMax, fbmBandLimited, valueNoisePcg, lipschitzDisplace,
  NOISE_LIPSCHITZ,
} from '../src/math/bandlimit.js';
import { marchRay, evalSdf, type SdfNode } from '../src/math/sdf.js';

test('bandlimit: pixel angular size and footprint', () => {
  // fov 90 deg, H = 100: delta = 2*tan(45deg)/100 = 0.02.
  assert.ok(Math.abs(pixelAngularSize(Math.PI / 2, 100) - 0.02) < 1e-12);
  assert.equal(footprint(10, 0.02), 0.2);
  assert.equal(epsForDistance(10, 0.02), 0.2);
  assert.equal(epsForDistance(0, 0.02), 1e-3); // floored
});

test('bandlimit: fade weights are 1 below quarter-Nyquist, 0 at Nyquist', () => {
  const w = octaveFadeWeights(1, 4, 0.1); // f = 1,2,4,8; 1/(4dx)=2.5, 1/(2dx)=5
  assert.equal(w[0], 1); // f=1 <= 2.5
  assert.equal(w[1], 1); // f=2 <= 2.5
  assert.ok(w[2] > 0 && w[2] < 1); // f=4 in the fade band
  assert.equal(w[3], 0); // f=8 >= 5
  // Smoothstep joints: weights in [0,1], monotone in dx.
  const wFar = octaveFadeWeights(1, 4, 0.2);
  for (let k = 0; k < 4; k++) {
    assert.ok(wFar[k] <= w[k] + 1e-12);
    assert.ok(w[k] >= 0 && w[k] <= 1);
  }
});

test('bandlimit: band-limited fbm kills far octaves, keeps near ones', () => {
  const near = fbmBandLimited(3.7, 1.2, 8.4, 11, 4, 0.001);
  const far = fbmBandLimited(3.7, 1.2, 8.4, 11, 4, 10);
  assert.ok(near >= 0 && near <= 1);
  assert.equal(far, 0.5); // no active octaves: neutral value
  // Near footprint keeps all octaves: differs from the neutral value.
  assert.ok(Math.abs(near - 0.5) > 1e-6);
});

test('bandlimit: pcg value noise is deterministic and in [0,1]', () => {
  const a = valueNoisePcg(1.5, 2.5, 3.5, 9);
  assert.equal(a, valueNoisePcg(1.5, 2.5, 3.5, 9));
  assert.ok(a >= 0 && a <= 1);
  assert.notEqual(a, valueNoisePcg(1.5, 2.5, 3.5, 10));
});

test('bandlimit: displace bound matches L_f + A L_N sum (2a)^k w_k', () => {
  const a = 0.5;
  const L = lipschitzDisplace({
    childL: 1, amp: 2, noiseL: NOISE_LIPSCHITZ,
    octaveAmp: [1, a, a * a, a * a * a],
    octaveFreq: [1, 2, 4, 8],
    weights: [1, 1, 1, 1],
  });
  const expected = 1 + 2 * NOISE_LIPSCHITZ * (1 + 2 * a + 4 * a * a + 8 * a ** 3);
  assert.ok(Math.abs(L - expected) < 1e-9);
});

test('bandlimit: distance-scaled epsilon drops the step count with distance', () => {
  const s: SdfNode = { kind: 'sphere', r: 1 };
  // Grazing ray: the fixed-epsilon march takes many shrinking steps.
  const ro: [number, number, number] = [0.99, 0, 10];
  const rd: [number, number, number] = [0, 0, -1];
  const fine = marchRay(s, ro, rd, {}, { maxSteps: 500 });
  const bl = marchRay(s, ro, rd, {}, { maxSteps: 500, pixelAngle: 0.02 });
  assert.ok(fine.hit && bl.hit);
  assert.ok(bl.steps < fine.steps, `bl=${bl.steps} fine=${fine.steps}`);
});

test('bandlimit: relaxed march agrees with a fine-step reference march', () => {
  // Brute-force reference: fixed tiny steps, no relaxation.
  function fineMarch(node: SdfNode, ro: number[], rd: number[], maxDist: number): number {
    let t = 0;
    const step = 0.002;
    while (t < maxDist) {
      const p: [number, number, number] = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
      if (evalSdf(node, p).d < 1e-3) return t;
      t += step;
    }
    return -1;
  }
  const fields: SdfNode[] = [
    { kind: 'twist', k: 1.5, child: { kind: 'box', b: [1, 1, 1] } },
    { kind: 'displace', amp: 0.2, freq: 1.5, seed: 7, child: { kind: 'sphere', r: 1 } },
    {
      kind: 'twist', k: 1.0,
      child: { kind: 'displace', amp: 0.15, freq: 2.0, seed: 3, child: { kind: 'sphere', r: 1 } },
    },
  ];
  const rays: Array<[number[], number[]]> = [
    [[3, 1, 0.5], [-1, -0.2, -0.1]],
    [[0, 4, 0.3], [0.1, -1, 0]],
    [[-2.5, 0.5, 2], [0.8, -0.1, -0.6]],
  ];
  for (const f of fields) {
    for (const [ro, rd] of rays) {
      const dl = Math.hypot(rd[0], rd[1], rd[2]);
      const d: [number, number, number] = [rd[0] / dl, rd[1] / dl, rd[2] / dl];
      const ref = fineMarch(f, ro, d, 12);
      const m = marchRay(f, ro as [number, number, number], d, {}, { maxSteps: 2000, maxDist: 12 });
      if (ref < 0) {
        assert.equal(m.hit, false);
      } else {
        assert.ok(m.hit, 'relaxed march must not tunnel where the reference hits');
        assert.ok(Math.abs(m.dist - ref) < 0.1, `dist ${m.dist} vs ref ${ref}`);
      }
    }
  }
});

test('bandlimit: fade slope bound is finite', () => {
  assert.ok(Number.isFinite(fadeSlopeMax(8, 0.02)));
  assert.equal(fadeSlopeMax(8, 0), 0);
});
