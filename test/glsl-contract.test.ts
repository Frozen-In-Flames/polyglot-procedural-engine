import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sdfToGlsl, type SdfNode } from '../src/math/sdf.js';
import { buildRaymarchFragment } from '../src/render/raymarch.js';

// GLSL contract tests (v2.0.1). The v2.0.0 demo shipped a fragment shader
// that failed compilation in every real browser: buildRaymarchFragment
// declared the parameterized SDF uniforms a second time (a redefinition
// error in GLSL ES 3.00), and numeric options were interpolated as raw JS
// numbers, so the default maxDist emitted `t > 100`, a float-vs-int
// comparison GLSL ES 3.00 rejects. The compile failure threw during module
// evaluation, which killed the demo panel and the march loop. Node has no
// GL context, so HTTP/grep/Node checks were blind to it. These tests pin
// the two defect classes at the source-string level, and each checker
// ships a negative control (planted defects it must catch) plus a
// specificity control (legal integer GLSL it must not flag).

/** Names declared more than once as `uniform <type> <name>`. */
function duplicateUniforms(glsl: string): string[] {
  const counts = new Map<string, number>();
  for (const m of glsl.matchAll(/uniform\s+\w+(?:\s*\[\s*\d+\s*\])?\s+(\w+)\s*(?:\[\s*\d+\s*\])?\s*;/g)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
}

/** Float scalar names: declared floats (incl. uniforms and parameters). */
function floatScalars(glsl: string): Set<string> {
  const out = new Set<string>();
  for (const m of glsl.matchAll(/\bfloat\s+(\w+)/g)) out.add(m[1]);
  return out;
}

/** Vector variable names; their .x/.y/.z/.w members are floats. */
function vectorVars(glsl: string): Set<string> {
  const out = new Set<string>();
  for (const m of glsl.matchAll(/\bvec[234]\s+(\w+)/g)) out.add(m[1]);
  return out;
}

const INT_LITERAL = '-?\\d+';
const isBareInt = (s: string): boolean => /^-?\d+$/.test(s);

/**
 * Defects where a float meets a raw integer literal in a way GLSL ES 3.00
 * rejects: a float initialized from a bare int, a float compared against a
 * bare int, or a bare int in parentheses used as an arithmetic operand
 * (the baked-value form `length(q) - (2)`). Integer-only GLSL (loop
 * counters, int uniforms, constructors, conversions) is legal and ignored.
 */
function intLiteralDefects(glsl: string): string[] {
  const defects: string[] = [];
  const floats = floatScalars(glsl);
  const vecs = vectorVars(glsl);
  const isFloatExpr = (expr: string): boolean => {
    const base = expr.split('.')[0];
    if (floats.has(expr) || floats.has(base)) return true;
    return expr.includes('.') && vecs.has(base);
  };
  // float x = 100; / const float e = 1;
  for (const m of glsl.matchAll(new RegExp(`(?:const\\s+)?float\\s+\\w+\\s*=\\s*(${INT_LITERAL})\\s*;`, 'g'))) {
    defects.push(`float initialized from int literal: ${m[0].trim()}`);
  }
  // floatExpr <op> 100  and  100 <op> floatExpr
  const cmp = '(?:>=|<=|==|!=|>|<)';
  for (const m of glsl.matchAll(new RegExp(`([A-Za-z_]\\w*(?:\\.\\w+)?)\\s*${cmp}\\s*(${INT_LITERAL})(?![\\d.])`, 'g'))) {
    if (isFloatExpr(m[1])) defects.push(`float compared against int literal: ${m[0].trim()}`);
  }
  for (const m of glsl.matchAll(new RegExp(`(?<![\\w.])(${INT_LITERAL})\\s*${cmp}\\s*([A-Za-z_]\\w*(?:\\.\\w+)?)`, 'g'))) {
    if (isFloatExpr(m[2])) defects.push(`float compared against int literal: ${m[0].trim()}`);
  }
  // (2) used as an arithmetic operand: the pre-fix baked-value form.
  for (const m of glsl.matchAll(new RegExp(`[+\\-*/]\\s*\\(\\s*(${INT_LITERAL})\\s*\\)`, 'g'))) {
    defects.push(`baked int literal as operand: ${m[0].trim()}`);
  }
  for (const m of glsl.matchAll(new RegExp(`(?<![\\w])\\(\\s*(${INT_LITERAL})\\s*\\)\\s*[+\\-*/]`, 'g'))) {
    defects.push(`baked int literal as operand: ${m[0].trim()}`);
  }
  return defects;
}

// The v10 demo world (demo/v10.ts, Step 1): parameterized nodes throughout,
// so uBlendK, uTwistK, uDisplaceAmp, uDisplaceFreq all reach the shader.
const demoWorld: SdfNode = {
  kind: 'union',
  children: [
    {
      kind: 'displace',
      amp: { uniform: 'uDisplaceAmp' },
      freq: { uniform: 'uDisplaceFreq' },
      seed: 7,
      child: {
        kind: 'twist',
        k: { uniform: 'uTwistK' },
        child: {
          kind: 'smoothUnion',
          k: { uniform: 'uBlendK' },
          children: [
            { kind: 'sphere', c: [-1.3, 0.9, 0], r: 1.15, mat: 0 },
            { kind: 'box', c: [1.3, 0.8, 0.2], b: [0.95, 0.8, 0.95], mat: 1 },
            { kind: 'torus', c: [0, 2.4, -0.4], R: 0.85, r: 0.3, mat: 2 },
          ],
        },
      },
    },
    { kind: 'plane', n: [0, 1, 0], h: 0.7, mat: 3 },
  ],
};

test('glsl: each parameterized uniform is declared exactly once in the assembled fragment', () => {
  const { glsl, uniforms } = sdfToGlsl(demoWorld);
  assert.deepEqual(uniforms, ['uBlendK', 'uDisplaceAmp', 'uDisplaceFreq', 'uTwistK']);
  const frag = buildRaymarchFragment(glsl, uniforms);
  for (const name of uniforms) {
    const decls = frag.match(new RegExp(`uniform float ${name};`, 'g'));
    assert.equal(decls?.length, 1, `${name} declared ${decls?.length ?? 0} times`);
  }
  assert.deepEqual(duplicateUniforms(frag), []);
});

test('glsl: no float is compared against or initialized from a raw int literal', () => {
  const { glsl, uniforms } = sdfToGlsl(demoWorld);
  const frag = buildRaymarchFragment(glsl, uniforms);
  assert.deepEqual(intLiteralDefects(frag), []);
  assert.deepEqual(intLiteralDefects(glsl), []);
  // The exact lines that killed the v2.0.0 demo: default maxDist is the
  // integer 100, and eps must survive an integer caller value too.
  assert.ok(frag.includes('t > 100.0'), 'maxDist emitted as a float literal');
  const intOpts = buildRaymarchFragment(glsl, uniforms, { eps: 1, maxDist: 50 });
  assert.ok(intOpts.includes('const float e = 1.0;'), 'eps emitted as a float literal');
  assert.ok(intOpts.includes('h.x < 1.0'), 'eps comparison uses a float literal');
  assert.ok(intOpts.includes('t > 50.0'), 'maxDist emitted as a float literal');
  assert.deepEqual(intLiteralDefects(intOpts), []);
});

test('glsl: baked integer sdf values are emitted as float literals', () => {
  const baked: SdfNode = {
    kind: 'union',
    children: [
      { kind: 'sphere', r: 2, mat: 0 },
      { kind: 'torus', R: 3, r: 1, mat: 1 },
      { kind: 'capsule', a: [0, 0, 0], b: [0, 2, 0], r: 1, mat: 2 },
      { kind: 'plane', n: [0, 1, 0], h: 2, mat: 3 },
      { kind: 'scale', s: 2, child: { kind: 'sphere', r: 1 } },
    ],
  };
  const { glsl } = sdfToGlsl(baked);
  assert.ok(glsl.includes('- (2.0)'), 'sphere radius baked as float');
  assert.ok(glsl.includes('- (3.0)'), 'torus R baked as float');
  assert.ok(glsl.includes('+ (2.0)'), 'plane height baked as float');
  assert.deepEqual(intLiteralDefects(glsl), []);
  assert.deepEqual(duplicateUniforms(glsl), []);
});

test('glsl: checkers catch planted defects (negative control)', () => {
  const { glsl, uniforms } = sdfToGlsl(demoWorld);
  const frag = buildRaymarchFragment(glsl, uniforms);
  // Planted duplicate declaration, the v2.0.0 redefinition defect.
  assert.deepEqual(duplicateUniforms(frag + '\nuniform float uBlendK;'), ['uBlendK']);
  // Planted float-vs-int comparison, both operand orders.
  assert.equal(intLiteralDefects('float t = 0.0;\nif (t > 100) { break; }').length, 1);
  assert.equal(intLiteralDefects('float t = 0.0;\nif (100 < t) { break; }').length, 1);
  // Planted float initialized from a bare int.
  assert.equal(intLiteralDefects('const float e = 1;').length, 1);
  // Planted baked int operand, the pre-fix glslVal form.
  assert.equal(intLiteralDefects('vec2 r0 = vec2(length(p) - (2), 1.0);').length, 1);
});

test('glsl: checkers ignore legal integer GLSL (specificity control)', () => {
  const legal = [
    'uniform int uDebug;',
    'uniform vec3 uMatColor[8];',
    'for (int i = 0; i < 24; i++) { if (uDebug == 1) { break; } }',
    'vec3 a = vec3(1, 0, 0);',
    'float b = float(96);',
    'int mi = int(3.0);',
    'float c = a.x * 2.0;',
  ].join('\n');
  assert.deepEqual(intLiteralDefects(legal), []);
  assert.deepEqual(duplicateUniforms(legal), []);
  assert.ok(isBareInt('100') && !isBareInt('100.0'));
});
