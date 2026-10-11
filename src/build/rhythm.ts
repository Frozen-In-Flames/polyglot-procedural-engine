// build/rhythm.ts — rhythm tuning: local rhythmic behavior parameters.
//
// A tuning sets the ember tempo and mote energy inside a disc. Sampling is a
// smooth weighted blend of the global tempo params (read live from the
// field) and every overlapping region, so tunings compose without seams and
// stay bounded: the result is always a convex combination of real inputs.

/** Tool params for tuneRhythm (radius travels with the fluent .with()). */
export interface RhythmOpts {
  /** Local ember cycle period, seconds (> 0). */
  emberTempo: number;
  /** Local mote agitation, 0..1. */
  moteEnergy: number;
}

/** A rhythm region. Plain data, JSON-safe. */
export interface RhythmRegion {
  id: string;
  cx: number;
  cz: number;
  radius: number;
  tempo: number;
  energy: number;
}

/** Blend the global tempo with local regions at (x, z). Pure and bounded. */
export function blendRhythm(
  base: { beatPeriod: number; energy: number },
  regions: RhythmRegion[],
  x: number,
  z: number,
): { beatPeriod: number; energy: number } {
  let w = 1;
  let bp = base.beatPeriod;
  let en = base.energy;
  for (const r of regions) {
    const d = Math.hypot(x - r.cx, z - r.cz);
    if (d < r.radius && r.radius > 0) {
      const f = 0.5 + 0.5 * Math.cos((Math.PI * d) / r.radius);
      w += f;
      bp += f * r.tempo;
      en += f * r.energy;
    }
  }
  return { beatPeriod: bp / w, energy: en / w };
}

/** Normalized, validated rhythm arguments. Throws loudly on bad input. */
export interface ValidRhythm {
  cx: number;
  cz: number;
  radius: number;
  emberTempo: number;
  moteEnergy: number;
}

function finite(n: unknown, what: string): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error(`build: rhythm ${what} must be a finite number`);
  }
  return n;
}

export function validateRhythm(
  center: [number, number],
  radius: number,
  opts: RhythmOpts,
): ValidRhythm {
  if (!Array.isArray(center) || center.length !== 2) {
    throw new Error('build: rhythm center must be [x, z]');
  }
  const cx = finite(center[0], 'center[0]');
  const cz = finite(center[1], 'center[1]');
  const r = finite(radius, 'radius');
  if (r <= 0 || r > 1000) throw new Error('build: rhythm radius must be in (0, 1000]');
  if (!opts || typeof opts !== 'object') throw new Error('build: rhythm opts must be an object');
  const emberTempo = finite(opts.emberTempo, 'emberTempo');
  if (emberTempo <= 0) throw new Error('build: rhythm emberTempo must be > 0');
  const moteEnergy = finite(opts.moteEnergy, 'moteEnergy');
  if (moteEnergy < 0 || moteEnergy > 1) throw new Error('build: rhythm moteEnergy must be in [0, 1]');
  return { cx, cz, radius: r, emberTempo, moteEnergy };
}
