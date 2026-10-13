// games/first-light/shared.ts — constants shared by the game's scripts and
// its host. Pure data and pure math: no engine imports, no DOM. Both the
// scripts (which only see their capability object) and the host (which owns
// the renderer) read the same numbers, the way an external developer's game
// code and level data would agree.

/** Game seed: ember scatter, mote fields, gust rhythm. */
export const GAME_SEED = 20261010;

/** Six attunement thresholds, one per engine language (plan order). The
 *  gate opens at the sixth: resonance, not collection. */
export const ATTUNE_LEVELS = [12, 28, 44, 60, 74, 88] as const;
export const ATTUNE_LANGS = [
  'TypeScript', 'C++/WASM', 'Python', 'C#', 'Swift', 'Kotlin',
] as const;
export const ATTUNE_DOMAINS = [
  'scene', 'genesis', 'biome', 'tempo', 'light', 'presence',
] as const;

/** The dark gate (world coordinates; ember-reach local [0,4,-40]). */
export const GATE_POS: [number, number, number] = [-140, 4, -40];
/**
 * The gate's root frequency (Hz). The gate script voices its resonance
 * chord (174.6 / 261.6 / 349.2 / 523.3) on this root; the attunement script
 * publishes it to world state ('gate:rootFreq') so the V8 conductor can
 * retune every layer to a just-intonation lattice on it at resonance.
 */
export const GATE_ROOT_FREQ = 174.6;
/** Player spawn (world): in ember-reach, facing the gate. */
export const PLAYER_SPAWN: [number, number, number] = [-140, 2, -16];

/** The stillwater band (world coordinates, mote-hollow): dark water the
 *  player can barely walk. x in [-60,60], z in [44,64]. The far ledge
 *  portal stands across it, physically present from minute one. */
export const BAND = { x0: -60, x1: 60, z0: 44, z1: 64 };
/** The secret portal mouth (world). */
export const SECRET_PORTAL_POS: [number, number, number] = [30, 4, 60];

/** Nine scattered embers (world coordinates), three per zone. */
export const EMBER_SPAWNS: Array<[number, number, number]> = [
  // ember-reach
  [-170, 3, 10], [-115, 3, 20], [-150, 3, -25],
  // mote-hollow
  [-35, 3, -5], [10, 3, 25], [40, 3, -20],
  // shimmer-flats
  [115, 3, 15], [155, 3, -10], [175, 3, 30],
];

/** Mote fields per zone: [centerX, centerZ, count]. */
export const MOTE_FIELDS: Array<[number, number, number]> = [
  [-140, 0, 30],   // ember-reach
  [0, 0, 45],      // mote-hollow
  [140, 0, 20],    // shimmer-flats
  [0, 240, 40],    // foundry
];

/** Six foundry levers (world coordinates; foundry offset [0,0,240]). */
export const LEVER_POS: Array<[number, number, number]> = [
  [-11.59, 0, 256.9], [-8.49, 0, 251.5], [-3.11, 0, 248.4],
  [3.11, 0, 248.4], [8.49, 0, 251.5], [11.59, 0, 256.9],
];

/** Lever metadata: language label, domain, param key, step, [min, max]. */
export interface LeverSpec {
  label: string;
  domain: 'scene' | 'genesis' | 'biome' | 'tempo' | 'light' | 'presence';
  key: string;
  step: number;
  min: number;
  max: number;
}
export const LEVER_SPECS: LeverSpec[] = [
  { label: 'TypeScript · terrain · sky', domain: 'scene', key: 'terrainHeight', step: 0.15, min: 0.3, max: 2.5 },
  { label: 'C++/WASM · seed · noise', domain: 'genesis', key: 'noiseScale', step: 0.15, min: 0.4, max: 2.5 },
  { label: 'Python · biome · style', domain: 'biome', key: 'paletteShift', step: 0.05, min: 0, max: 1 },
  { label: 'C# · behavior tempo', domain: 'tempo', key: 'beatPeriod', step: 0.25, min: 0.6, max: 4 },
  { label: 'Swift · light · perception', domain: 'light', key: 'timeOfDay', step: 0.05, min: 0, max: 1 },
  { label: 'Kotlin · presence · feel', domain: 'presence', key: 'moveSpeed', step: 0.5, min: 1, max: 8 },
];

/**
 * The gust-front envelope: a slow pulse every 18 seconds, ~6 seconds wide.
 * Returns 0..1. The front is what makes the stillwater crossable — but only
 * for a player moving WITH the local wind while it passes. The front is
 * never announced; it reads in the world's texture (embers surge, the
 * secret portal breathes, terrain shimmer runs).
 */
export function gustFront(t: number): number {
  const period = 18;
  const width = 0.35; // fraction of the period the front lasts
  const ph = ((t % period) + period) % period / period;
  if (ph >= width) return 0;
  const s = Math.sin((ph / width) * Math.PI);
  return s * s;
}

/**
 * Stillwater ride velocity for a wish direction and local wind vector.
 * Returns [vx, vz]: the extra velocity the gust lends. Pure function so the
 * secret-path gating is unit-testable.
 *
 * @param wishX wishZ  player wish direction (any magnitude; 0 = no input)
 * @param windX windZ  local wind vector at the player
 * @param front        gustFront(t), 0..1
 */
export function stillwaterRide(
  wishX: number, wishZ: number,
  windX: number, windZ: number,
  front: number,
): [number, number] {
  const wishMag = Math.hypot(wishX, wishZ);
  const windMag = Math.hypot(windX, windZ);
  if (wishMag < 1e-6 || windMag < 0.3) return [0, 0];
  const align = Math.max(0, (wishX * windX + wishZ * windZ) / (wishMag * windMag));
  const speed = (2 + 10 * front) * align * align;
  return [(windX / windMag) * speed, (windZ / windMag) * speed];
}

/** Attunement level (0..6) for a hidden score. */
export function attuneLevel(score: number): number {
  let level = 0;
  for (const th of ATTUNE_LEVELS) if (score >= th) level++;
  return level;
}
