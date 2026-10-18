// build/brush.ts - the field brush: bend the local wind.
//
// A brush is a PURE function of (seed, params): same seed + same params =
// identical offsets, forever, on every node. The offset layers over the
// global wind field and is exactly zero outside the brush radius (hard
// locality: far-field samples are bit-identical with or without the brush).
//
// Per the lake laws the brush is multi-directional: the heading varies
// across the brush disc (a seeded fbm wobble) and in time (a seeded gust
// oscillation), and the force varies across subsections of the disc (a
// seeded envelope). Bounded: |offset| <= force * (1 + gust / 2).

import { mulberry32, fbm2 } from '../geo/rng.js';
import type { WindSample } from '../world/wind.js';

/** Tool params for applyBrush (radius travels with the fluent .with()). */
export interface BrushOpts {
  /** xz heading the brush bends the wind toward (need not be unit length). */
  direction: [number, number];
  /** 0..1 - how hard the brush bends the local wind. */
  force: number;
  /** 0..1 - extra local gustiness inside the brush. */
  gust: number;
  /** Replay key. When omitted the session derives one from (seed, brush id). */
  seed?: number;
}

/** A brush with its seeded constants resolved. Plain data, JSON-safe. */
export interface BrushDef {
  id: string;
  cx: number;
  cz: number;
  radius: number;
  /** radians - the heading the brush conducts. */
  heading: number;
  force: number;
  gust: number;
  /** Effective uint32 replay seed. */
  seed: number;
  /** Seeded per-brush constants (from mulberry32(seed)). */
  spread: number;
  omega: number;
  phi: number;
}

/** Resolve a brush's seeded constants. Deterministic in (seed). */
export function createBrushDef(
  id: string,
  cx: number,
  cz: number,
  radius: number,
  heading: number,
  force: number,
  gust: number,
  seed: number,
): BrushDef {
  const s = seed >>> 0;
  const rng = mulberry32(s);
  return {
    id, cx, cz, radius, heading, force, gust, seed: s,
    spread: (0.25 + 0.75 * rng()) * Math.PI,
    omega: 0.2 + rng() * 0.8,
    phi: rng() * Math.PI * 2,
  };
}

/**
 * The brush's local offset at (x, y, z, t). Pure in (seed, params, x, y, z,
 * t). Exactly zero at and beyond the radius, so the far field never moves.
 */
export function brushOffset(b: BrushDef, x: number, y: number, z: number, t: number): WindSample {
  const dx = x - b.cx;
  const dz = z - b.cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= b.radius * b.radius) return { x: 0, y: 0, z: 0 };
  const d = Math.sqrt(d2);
  // Cosine falloff: 1 at the center, 0 at the rim, smooth at both ends.
  const f = 0.5 + 0.5 * Math.cos((Math.PI * d) / b.radius);
  // Seeded spatial wobble: the heading is never one direction across the disc.
  const wob = fbm2(x * 0.06, z * 0.06, b.seed);
  // Seeded force envelope: some subsections push hard, others drift.
  const env = 0.55 + 0.45 * fbm2(x * 0.045 + 13.7, z * 0.045 - 7.3, (b.seed ^ 0x5bd1e995) >>> 0);
  const theta =
    b.heading +
    (wob - 0.5) * b.spread +
    b.gust * 0.9 * Math.sin(b.omega * t + b.phi + 2 * Math.PI * wob);
  const mag =
    f * b.force * env * (1 + b.gust * 0.5 * Math.sin(2 * theta + 1.7 * b.omega * t + b.phi));
  return {
    x: mag * Math.cos(theta),
    y: mag * 0.35 * Math.sin(theta + b.phi),
    z: mag * Math.sin(theta),
  };
}

/** Normalized, validated brush arguments. Throws loudly on bad input. */
export interface ValidBrush {
  cx: number;
  cz: number;
  radius: number;
  heading: number;
  force: number;
  gust: number;
}

function finite(n: unknown, what: string): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error(`build: brush ${what} must be a finite number`);
  }
  return n;
}

export function validateBrush(
  center: [number, number],
  radius: number,
  opts: BrushOpts,
): ValidBrush {
  if (!Array.isArray(center) || center.length !== 2) {
    throw new Error('build: brush center must be [x, z]');
  }
  const cx = finite(center[0], 'center[0]');
  const cz = finite(center[1], 'center[1]');
  const r = finite(radius, 'radius');
  if (r <= 0 || r > 1000) throw new Error('build: brush radius must be in (0, 1000]');
  if (!opts || typeof opts !== 'object') throw new Error('build: brush opts must be an object');
  const dir = opts.direction;
  if (!Array.isArray(dir) || dir.length !== 2) {
    throw new Error('build: brush direction must be [dx, dz]');
  }
  const dx = finite(dir[0], 'direction[0]');
  const dz = finite(dir[1], 'direction[1]');
  if (dx === 0 && dz === 0) throw new Error('build: brush direction must be non-zero');
  const force = finite(opts.force, 'force');
  if (force < 0 || force > 1) throw new Error('build: brush force must be in [0, 1]');
  const gust = finite(opts.gust, 'gust');
  if (gust < 0 || gust > 1) throw new Error('build: brush gust must be in [0, 1]');
  if (opts.seed !== undefined) finite(opts.seed, 'seed');
  return { cx, cz, radius: r, heading: Math.atan2(dz, dx), force, gust };
}
