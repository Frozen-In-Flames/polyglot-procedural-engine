// world/semantic.ts - human-readable world building.
//
// Each semantic control u in [0,1] maps through
//   g(u) = a * u^2 + b * u + c0
// to a coefficient bundle c (concrete math variables: SDF uniform values,
// blend factors, repetition counts). The mapping coefficients (a, b, c0)
// are documented per slider below, so the translation from concept to
// math stays transparent and inspectable. No raw equations are hidden.
//
// Composable blocks let creators stack math pieces (e.g. a sine warp on
// a sphere SDF) without touching the underlying formulas.
import type { SdfNode, SdfValue, Uniforms } from '../math/sdf.js';
import type { Vec3 } from '../math/vec.js';

/** One term of a semantic mapping: concrete coefficient = a*u^2 + b*u + c0. */
export interface SemanticTerm {
  /** Concrete coefficient name (matches an SDF uniform or world param). */
  coeff: string;
  a: number;
  b: number;
  c0: number;
  /** Human note: what this coefficient does in the math. */
  note: string;
}

export interface SemanticSlider {
  name: string;
  description: string;
  terms: SemanticTerm[];
}

/** Evaluate one term at control value u in [0,1]. */
export function evalTerm(t: SemanticTerm, u: number): number {
  const x = Math.min(1, Math.max(0, u));
  return t.a * x * x + t.b * x + t.c0;
}

/** Evaluate a whole slider to its coefficient bundle. */
export function evalSlider(s: SemanticSlider, u: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of s.terms) out[t.coeff] = evalTerm(t, u);
  return out;
}

/** Evaluate several sliders and merge the bundles (later wins on clash). */
export function evalSemantics(sliders: SemanticSlider[], values: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sliders) {
    const u = values[s.name] ?? 0.5;
    Object.assign(out, evalSlider(s, u));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Built-in semantic sliders. Each lists its (a, b, c0) mapping openly.
// Coefficient names match the uniforms of the V10 demo SDF world.
// ---------------------------------------------------------------------------

export const SEMANTIC_SLIDERS: SemanticSlider[] = [
  {
    name: 'Organicness',
    description: 'How living the surfaces feel: fbm displacement amplitude and detail frequency.',
    terms: [
      { coeff: 'uDisplaceAmp', a: 0.1, b: 0.5, c0: 0.0, note: 'fbm displacement amplitude in world units' },
      { coeff: 'uDisplaceFreq', a: 1.0, b: 3.0, c0: 1.5, note: 'fbm domain frequency' },
    ],
  },
  {
    name: 'Sharpness',
    description: 'How crisp the blends are: larger exponential smin k hugs min() tighter.',
    terms: [
      { coeff: 'uBlendK', a: 6, b: 24, c0: 2, note: 'exponential smin k; 2 soft up to 32 crisp' },
    ],
  },
  {
    name: 'Warp',
    description: 'How twisted space gets: domain twist rate around the vertical axis.',
    terms: [
      { coeff: 'uTwistK', a: 0.3, b: 0.5, c0: 0.0, note: 'twist radians per world unit of height' },
    ],
  },
  {
    name: 'Spread',
    description: 'How far apart repeated structures sit: repetition cell size.',
    terms: [
      { coeff: 'uCellSize', a: 2.0, b: 4.0, c0: 2.0, note: 'repeat cell size in world units' },
    ],
  },
  {
    name: 'Density',
    description: 'How many structures grow: pillar radius and mound height scale.',
    terms: [
      { coeff: 'uPillarR', a: 0.2, b: 0.8, c0: 0.4, note: 'pillar radius in world units' },
      { coeff: 'uMoundH', a: 0.5, b: 1.5, c0: 1.0, note: 'mound height scale' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Composable blocks. Each block is a named SDF constructor; modifiers wrap
// a block's node. Stack blocks with unionBlocks. All parameters are plain
// data so the Tuning Deck can bind them.
// ---------------------------------------------------------------------------

export interface Block {
  name: string;
  build: () => SdfNode;
}

/** Reference a live uniform by name (cleaner than the cast above for authors). */
export function live(name: string): SdfValue {
  return { uniform: name };
}

export const blocks = {
  /** Mound: a displaced sphere half-buried as a hill. */
  mound(mat = 1): Block {
    return {
      name: 'mound',
      build: () => ({
        kind: 'displace',
        amp: live('uDisplaceAmp'),
        freq: live('uDisplaceFreq'),
        seed: 7,
        child: {
          kind: 'scale',
          s: live('uMoundH'),
          child: { kind: 'sphere', r: 3, c: [0, -1.2, 0], mat },
        },
      }),
    };
  },
  /** Pillar: a twisted capsule column. */
  pillar(mat = 2): Block {
    return {
      name: 'pillar',
      build: () => ({
        kind: 'twist',
        k: live('uTwistK'),
        child: {
          kind: 'capsule',
          a: [0, 0, 0],
          b: [0, 4, 0],
          r: live('uPillarR'),
          mat,
        },
      }),
    };
  },
  /** Arch: a torus standing vertical, half sunk in the ground. */
  arch(mat = 3): Block {
    return {
      name: 'arch',
      build: () => ({
        kind: 'translate',
        t: [0, -1.5, 0],
        child: { kind: 'torus', R: 2.2, r: 0.45, mat },
      }),
    };
  },
  /** Stone field: infinitely repeated rounded boxes. */
  stoneField(mat = 4): Block {
    return {
      name: 'stoneField',
      build: () => ({
        kind: 'repeat',
        c: [live('uCellSize'), 0, live('uCellSize')],
        child: {
          kind: 'translate',
          t: [0, -2.6, 0],
          child: { kind: 'box', b: [0.7, 0.5, 0.7], mat },
        },
      }),
    };
  },
};

/** Stack blocks into one world with a smooth blend between them. */
export function stackBlocks(list: Block[], blendK: SdfValue = live('uBlendK')): SdfNode {
  return { kind: 'smoothUnion', k: blendK, children: list.map(b => b.build()) };
}

/** Modifier: sine warp along Y applied to any node. */
export function sineWarp(node: SdfNode, amp: SdfValue, freq: SdfValue): SdfNode {
  return {
    kind: 'displace',
    amp,
    freq,
    seed: 21,
    child: node,
  };
}

/** Build the V10 demo world: mound + pillar + arch + stone field, smoothly blended. */
export function demoWorld(): SdfNode {
  return stackBlocks([blocks.mound(), blocks.pillar(), blocks.arch(), blocks.stoneField()]);
}

/** Default uniform values for the demo world (the Tuning Deck overwrites live). */
export function demoUniforms(): Uniforms {
  const out: Uniforms = {};
  for (const s of SEMANTIC_SLIDERS) Object.assign(out, evalSlider(s, 0.5));
  return out;
}
