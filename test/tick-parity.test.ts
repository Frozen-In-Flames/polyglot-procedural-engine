// test/tick-parity.test.ts - v2.0.7 cross-language tick parity.
//
// The canonical scenario, serialization, and digest are specified in
// docs/tick-parity.md. This harness runs the same seed and scripted
// inputs through the shipped TypeScript tick (in process), the Python
// port (python/xrgen/ticksim.py, spawned), and the C++ port
// (parity/runner.cpp, compiled with g++ and run), and requires all
// three per-tick digest traces to equal parity/golden.tsv exactly.
//
// Negative controls are asserted as strictly as the parity: a
// perturbed constant, a perturbed seed, and a mismatched input
// script must each produce a trace that disagrees with the golden
// one. A harness that cannot fail would prove nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tickCharacter, makeCharacter } from '../src/game/character.js';
import type {
  CharacterParams,
  CharacterState,
} from '../src/game/character.js';
import { Pcg32 } from '../src/math/determinism.js';
import type { Vec3 } from '../src/math/vec.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const scenario = JSON.parse(
  readFileSync(join(ROOT, 'parity/scenario.json'), 'utf8'),
);
const GOLDEN = readFileSync(join(ROOT, 'parity/golden.tsv'), 'utf8')
  .trim()
  .split('\n');

const SC = scenario.world.sphereCenter as number[];
const SR = scenario.world.sphereRadius as number;
const SQ = scenario.params.slopeLimit as number;

function pick(px: number, py: number, pz: number): [number, Vec3] {
  const dPlane = py;
  const dRamp = 0.5 * py - SQ * (pz - scenario.world.rampThroughZ);
  const dx = px - SC[0], dy = py - SC[1], dz = pz - SC[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const dSphere = len - SR;
  if (dPlane <= dRamp && dPlane <= dSphere) return [dPlane, [0, 1, 0]];
  if (dRamp <= dSphere) return [dRamp, [0, 0.5, -SQ]];
  const inv = 1 / len;
  return [dSphere, [dx * inv, dy * inv, dz * inv]];
}
const fieldF = (p: Vec3) => pick(p[0], p[1], p[2])[0];
const fieldGrad = (p: Vec3) => pick(p[0], p[1], p[2])[1];

const DIRS: [number, number][] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

interface ScriptEntry { move: [number, number]; pressed: boolean; held: boolean }

function runTsTrace(opts: {
  seed?: number;
  perturbGravity?: boolean;
  shiftScript?: boolean;
}): string[] {
  const seed = opts.seed ?? scenario.seed;
  const ticks = scenario.ticks as number;
  const P: CharacterParams = { ...scenario.params };
  if (opts.perturbGravity) P.gravity += 1e-9;
  const dt = 1 / 60;
  const rng = new Pcg32(seed);
  const s0 = rng.next();
  const st: CharacterState = makeCharacter([
    ((s0 % 401) - 200) / 50,
    scenario.spawnY,
    scenario.spawnZ,
  ]);
  const script: ScriptEntry[] = [];
  let holdEnd = -1;
  let move: [number, number] = [0, 0];
  for (let t = 0; t < ticks + 1; t++) {
    const a = rng.next();
    if (t % 20 === 0) {
      if (Math.floor(t / 20) % 3 === 2) move = [0, 1];
      else {
        const k = a % 9;
        move = k === 8 ? [0, 0] : DIRS[k];
      }
    }
    const b = rng.next();
    const pressed = b % 53 === 0;
    if (pressed) holdEnd = t + 1 + (b % 7);
    script.push({ move, pressed, held: t < holdEnd });
  }
  if (opts.shiftScript) {
    for (let t = ticks; t >= 1; t--) script[t] = script[t - 1];
  }
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let h = 14695981039346656037n;
  const PRIME = 1099511628211n;
  const MASK = 0xffffffffffffffffn;
  const feed = (b: number) => { h = ((h ^ BigInt(b)) * PRIME) & MASK; };
  const feedU32 = (v: number) => {
    for (let i = 0; i < 4; i++) feed((v >>> (8 * i)) & 0xff);
  };
  const feedF64 = (v: number) => {
    dv.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) feed(bytes[i]);
  };
  const lines: string[] = [];
  for (let t = 0; t < ticks; t++) {
    const inp = script[t];
    tickCharacter(
      st, P,
      { move: inp.move, jumpPressed: inp.pressed, jumpHeld: inp.held },
      fieldF, fieldGrad, dt,
    );
    feedU32(t);
    feedF64(st.pos[0]); feedF64(st.pos[1]); feedF64(st.pos[2]);
    feedF64(st.vel[0]); feedF64(st.vel[1]); feedF64(st.vel[2]);
    feed(st.grounded ? 1 : 0);
    feedU32(st.coyote); feedU32(st.buffer);
    feed(st.jumpHeld ? 1 : 0);
    lines.push(`${t} ${h.toString(16).padStart(16, '0')}`);
  }
  return lines;
}

function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['--version'], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

function runPython(args: string[]): string[] {
  const out = execFileSync('python3', ['-m', 'xrgen.ticksim', ...args], {
    cwd: join(ROOT, 'python'),
    encoding: 'utf8',
  });
  return out.trim().split('\n');
}

function buildCpp(): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'ppe-parity-'));
  const bin = join(dir, 'runner');
  try {
    execFileSync('g++', [
      '-std=c++17', '-O2', '-ffp-contract=off',
      '-o', bin, join(ROOT, 'parity/runner.cpp'),
    ], { encoding: 'utf8' });
    return bin;
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
}

function countMatches(a: string[], b: string[]): number {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) n++;
  }
  return n;
}

test('tick parity: TS trace equals the golden trace exactly', () => {
  const ts = runTsTrace({});
  assert.equal(ts.length, GOLDEN.length);
  assert.equal(countMatches(ts, GOLDEN), GOLDEN.length);
  assert.deepEqual(ts, GOLDEN);
});

test('tick parity: Python port trace equals the golden trace exactly', (t) => {
  if (!pythonAvailable()) {
    t.skip('python3 not available');
    return;
  }
  const py = runPython([]);
  assert.equal(py.length, GOLDEN.length);
  assert.equal(countMatches(py, GOLDEN), GOLDEN.length);
  assert.deepEqual(py, GOLDEN);
});

test('tick parity: C++ port trace equals the golden trace exactly', (t) => {
  const bin = buildCpp();
  if (!bin) {
    t.skip('g++ not available');
    return;
  }
  const out = execFileSync(bin, [], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(out.length, GOLDEN.length);
  assert.equal(countMatches(out, GOLDEN), GOLDEN.length);
  assert.deepEqual(out, GOLDEN);
});

test('tick parity: negative control, perturbed constant is caught', (t) => {
  const ts = runTsTrace({ perturbGravity: true });
  assert.notDeepEqual(ts, GOLDEN);
  const bin = buildCpp();
  if (!bin) {
    t.skip('g++ not available');
    return;
  }
  const out = execFileSync(bin, ['--perturb-gravity'], { encoding: 'utf8' })
    .trim().split('\n');
  assert.notDeepEqual(out, GOLDEN);
});

test('tick parity: negative control, perturbed seed is caught', () => {
  const ts = runTsTrace({ seed: scenario.seed + 1 });
  assert.notDeepEqual(ts, GOLDEN);
});

test('tick parity: negative control, mismatched input script is caught', (t) => {
  const ts = runTsTrace({ shiftScript: true });
  assert.notDeepEqual(ts, GOLDEN);
  if (!pythonAvailable()) {
    t.skip('python3 not available');
    return;
  }
  const py = runPython(['--shift-script']);
  assert.notDeepEqual(py, GOLDEN);
});
