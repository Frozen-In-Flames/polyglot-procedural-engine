// build/entities.ts - entity seeding: plant a seed and the math grows it.
//
// There are no assets to place, so seeding never positions a mesh. It
// derives a procedural body descriptor from (kind, seed) - geometry kind,
// proportions, and material are all fixed by the seed - and grows the
// entity through the script spawn capability. Same kind + same seed =
// the same entity on every node, forever.

import { mulberry32 } from '../geo/rng.js';
import type { SpawnBody } from '../script/api.js';

/** The seedable entity kinds. */
export const ENTITY_KINDS = ['rock-cluster', 'light-well', 'ember-vent'] as const;

/** A kind of thing the math can grow. */
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** Deterministic entity name for (kind, seed). */
export function entityNameFor(kind: EntityKind, seed: number): string {
  return `${kind}-${(seed >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * The procedural body a seed grows into. Pure in (kind, seed): every
 * proportion and color jitters from mulberry32(seed), so the body replays
 * identically without storing anything but the seed.
 */
export function bodyForKind(kind: EntityKind, seed: number): SpawnBody {
  const rng = mulberry32(seed >>> 0);
  switch (kind) {
    case 'rock-cluster': {
      const r = 1 + rng() * 2.5;
      const g = 0.3 + rng() * 0.12;
      return {
        geometry: { kind: 'octahedron', radius: r, detail: 1 },
        material: {
          baseColor: [g, g * 0.96, g * 0.92],
          effects: ['noise'],
        },
      };
    }
    case 'light-well': {
      const r = 0.8 + rng() * 1.2;
      const h = 3 + rng() * 4;
      const warm = 0.75 + rng() * 0.25;
      return {
        geometry: { kind: 'prism', radius: r, size: [r, h, r], detail: 3 },
        material: {
          baseColor: [warm, warm * (0.82 + rng() * 0.1), warm * 0.6],
          effects: ['fresnel', 'pulse'],
          unlit: true,
        },
      };
    }
    case 'ember-vent': {
      const r = 0.6 + rng() * 1.0;
      const h = 1.5 + rng() * 2;
      return {
        geometry: { kind: 'cone', radius: r, size: [r, h, r], detail: 3 },
        material: {
          baseColor: [0.85 + rng() * 0.15, 0.22 + rng() * 0.18, 0.06 + rng() * 0.08],
          effects: ['pulse', 'noise'],
          unlit: true,
        },
      };
    }
  }
}

/** Normalized, validated seeding arguments. Throws loudly on bad input. */
export interface ValidSeed {
  kind: EntityKind;
  position: [number, number, number];
  seed: number;
}

function finite(n: unknown, what: string): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error(`build: seed ${what} must be a finite number`);
  }
  return n;
}

export function validateSeed(
  kind: string,
  position: [number, number, number],
  seed: number,
): ValidSeed {
  if (!(ENTITY_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`build: unknown entity kind '${kind}' (kinds: ${ENTITY_KINDS.join(', ')})`);
  }
  if (!Array.isArray(position) || position.length !== 3) {
    throw new Error('build: seed position must be [x, y, z]');
  }
  const p: [number, number, number] = [
    finite(position[0], 'position[0]'),
    finite(position[1], 'position[1]'),
    finite(position[2], 'position[2]'),
  ];
  const s = finite(seed, 'seed');
  if (!Number.isInteger(s) || s < 0) {
    throw new Error('build: seed must be a non-negative integer');
  }
  return { kind: kind as EntityKind, position: p, seed: s };
}
