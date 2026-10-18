// world/types.ts - zone descriptors, portal descriptors, and the six-domain
// live parameter sets (V4 step 2: world composition).
//
// A zone descriptor is PLAIN JSON. An independent developer authors a zone by
// writing one of these - never by touching engine internals. Descriptors are
// validated on load (parseZoneDescriptor) and rejected loudly when malformed.
//
// Architectural law (Aries, Oct 10, 2026): "local generation, global
// coherence". The descriptor carries a `wind` section, but that section holds
// WEIGHTS, never a seed: per-zone local wind always derives from the shared
// global seeded field (see wind.ts / zones.ts). The descriptor's own `seed`
// drives zone-local generation (terrain shape, biome detail) only - it must
// never become an independent wind seed, or 100 developers' zones would read
// as 100 disconnected breezes instead of one ocean.

/** 3-component vector as plain JSON. */
export type Vec3JSON = [number, number, number];

export interface Bounds3 {
  min: Vec3JSON;
  max: Vec3JSON;
}

/** Per-zone WIND WEIGHTS - not a seed. biasWeight blends the zone's anchored
 *  prevailing wind into the local sample; gustScale scales gust amplitude;
 *  shimmerStrength scales how strongly the wind textures the terrain. */
export interface ZoneWindParams {
  biasWeight: number;      // 0..1
  gustScale: number;       // > 0
  shimmerStrength: number; // >= 0
}

export interface ZoneTerrainParams {
  size: number;          // world units across
  segments: number;      // grid resolution (int > 0)
  height: number;        // vertical exaggeration
  baseFrequency: number; // noise frequency (world units^-1)
  octaves: number;       // noise octaves (int > 0)
  roughness: number;     // 0..1 - high-frequency detail mix
}

export interface ZoneSkyParams {
  horizonHue: number; // 0..1
  zenithHue: number;  // 0..1
  starDensity: number;// 0..1
}

export interface ZoneBiomeParams {
  name: string;
  moteDensity: number; // 0..1
  emberDrift: number;  // multiplier on ember advection speed
}

/** A portal as authored in a zone descriptor (zone-local coordinates). */
export interface PortalDescriptor {
  id: string;
  /** Zone-local position of the portal mouth. */
  position: Vec3JSON;
  /** Trigger radius in world units. */
  radius: number;
  /** Id of the zone this portal leads to. */
  targetZone: string;
  /** Zone-local spawn point in the TARGET zone. */
  targetSpawn: Vec3JSON;
  /** Human label (displayed by hosts, never required). */
  label: string;
}

export interface ZoneDescriptor {
  id: string;
  displayName: string;
  /** Zone-local generation seed (terrain/biome detail). NEVER a wind seed. */
  seed: number;
  /** Where the loader places this zone in world space. */
  placement: { offset: Vec3JSON };
  bounds: Bounds3;
  terrain: ZoneTerrainParams;
  sky: ZoneSkyParams;
  biome: ZoneBiomeParams;
  wind: ZoneWindParams;
  portals: PortalDescriptor[];
  /**
   * Optional validated audio block (V8 §5.3). Absent = today's behavior.
   * Note: this carries a REVERB seed, not a wind seed - the wind-seed ban
   * above is untouched; reverb seeds generate impulse responses, they do
   * not steer the shared wind field.
   */
  audio?: ZoneAudioParams;
}

/**
 * Zone audio parameters (V8 §5.3): a reverb seed plus the zone's generated
 * reverb tail and its named ambient granular bed (wind/water/breath).
 */
export interface ZoneAudioParams {
  /** Reverb seed: the zone's impulse response is generated from this. */
  reverbSeed: number;
  /** Exponential IR decay rate per second (> 0). */
  decay: number;
  /** Progressive IR lowpass damping 0..1. */
  damping: number;
  /** Reverb wet mix 0..1. */
  wet: number;
  /** Named seeded granular bed the zone owns (optional). */
  ambientLayer?: 'wind' | 'water' | 'breath';
}

// ---------------------------------------------------------------------------
// The six live domains (foundry endgame mapping: one lever per language).
// These are the parameter sets the six `field.write.*` capability grants
// mutate at runtime, each with downstream re-derivation of the composed world.
// ---------------------------------------------------------------------------

/** One lever per engine language (see V4-PLAN.md foundry spec). */
export type FieldDomain = 'scene' | 'genesis' | 'biome' | 'tempo' | 'light' | 'presence';

export interface WindParams {
  gain: number;          // global wind force multiplier (> 0)
  gustStrength: number;  // 0..1 - second-harmonic gust amplitude
  playerCoupling: number; // 0..1 - how strongly the player's motion stirs the field (the 7th lever)
}

export interface SceneParams {
  terrainHeight: number;  // multiplier on zone terrain height (> 0)
  shimmerStrength: number;// multiplier on wind shimmer in terrain (>= 0)
  skyHueShift: number;    // hue rotation applied to zone skies
}

export interface GenesisParams {
  seed: number;        // deep-generation seed (reshapes noise fields)
  noiseScale: number;  // multiplier on zone baseFrequency (> 0)
  noiseOctaves: number;// int >= 1
}

export interface BiomeParams {
  biomeName: string;
  moteDensity: number; // 0..1
  emberDrift: number;  // > 0
  paletteShift: number;// 0..1 hue shift on biome palette
}

export interface TempoParams {
  beatPeriod: number; // seconds per behavior cycle (> 0)
  energy: number;     // 0..1 - mote/ember agitation
  swing: number;      // 0..1 - rhythmic offset
}

export interface LightParams {
  timeOfDay: number; // 0..1
  exposure: number;  // > 0
  hueRotate: number;  // 0..1
}

export interface PresenceParams {
  gravity: number;   // world gravity (> 0)
  moveSpeed: number; // player move speed multiplier (> 0)
  drag: number;      // 0..1
}

/** The full live parameter set of the composed world. */
export interface FieldParams {
  globalSeed: number;
  wind: WindParams;
  scene: SceneParams;
  genesis: GenesisParams;
  biome: BiomeParams;
  tempo: TempoParams;
  light: LightParams;
  presence: PresenceParams;
}

/** Defaults: a calm, legible world. Everything is overridden by descriptors
 *  and by the foundry levers at runtime. */
export function defaultFieldParams(globalSeed = 20261010): FieldParams {
  return {
    globalSeed: globalSeed >>> 0,
    wind: { gain: 1.0, gustStrength: 0.35, playerCoupling: 0.5 },
    scene: { terrainHeight: 1.0, shimmerStrength: 1.0, skyHueShift: 0.0 },
    genesis: { seed: 0, noiseScale: 1.0, noiseOctaves: 4 },
    biome: { biomeName: 'ashen', moteDensity: 0.5, emberDrift: 1.0, paletteShift: 0.0 },
    tempo: { beatPeriod: 2.0, energy: 0.5, swing: 0.0 },
    light: { timeOfDay: 0.35, exposure: 1.0, hueRotate: 0.0 },
    presence: { gravity: 9.8, moveSpeed: 4.0, drag: 0.2 },
  };
}

// ---------------------------------------------------------------------------
// Validation: descriptors and domain patches are untrusted input (they come
// from independent developers' JSON files). Reject loudly, never guess.
// ---------------------------------------------------------------------------

function isVec3(v: unknown): v is Vec3JSON {
  return Array.isArray(v) && v.length === 3 &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`world: descriptor '${what}' must be a finite number`);
  }
  return v;
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v) {
    throw new Error(`world: descriptor '${what}' must be a non-empty string`);
  }
  return v;
}

function range(v: number, lo: number, hi: number, what: string): number {
  if (v < lo || v > hi) throw new Error(`world: descriptor '${what}' must be in [${lo}, ${hi}]`);
  return v;
}

function positive(v: number, what: string): number {
  if (v <= 0) throw new Error(`world: descriptor '${what}' must be > 0`);
  return v;
}

function nonNeg(v: number, what: string): number {
  if (v < 0) throw new Error(`world: descriptor '${what}' must be >= 0`);
  return v;
}

function intPositive(v: number, what: string): number {
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`world: descriptor '${what}' must be a positive integer`);
  }
  return v;
}

/** Parse and validate a zone descriptor from untrusted JSON. */
export function parseZoneDescriptor(json: unknown): ZoneDescriptor {
  if (typeof json !== 'object' || json === null) {
    throw new Error('world: zone descriptor must be an object');
  }
  const d = json as Record<string, unknown>;
  const id = str(d.id, 'id');
  const displayName = str(d.displayName, 'displayName');
  const seed = num(d.seed, 'seed') >>> 0;

  const placement = d.placement as Record<string, unknown> | undefined;
  if (!placement || !isVec3(placement.offset)) {
    throw new Error('world: descriptor placement.offset must be a [x,y,z] triple');
  }

  const bounds = d.bounds as Record<string, unknown> | undefined;
  if (!bounds || !isVec3(bounds.min) || !isVec3(bounds.max)) {
    throw new Error('world: descriptor bounds.min/max must be [x,y,z] triples');
  }

  const t = d.terrain as Record<string, unknown> | undefined;
  if (!t) throw new Error('world: descriptor needs a terrain section');
  const terrain: ZoneTerrainParams = {
    size: positive(num(t.size, 'terrain.size'), 'terrain.size'),
    segments: intPositive(num(t.segments, 'terrain.segments'), 'terrain.segments'),
    height: nonNeg(num(t.height, 'terrain.height'), 'terrain.height'),
    baseFrequency: positive(num(t.baseFrequency, 'terrain.baseFrequency'), 'terrain.baseFrequency'),
    octaves: intPositive(num(t.octaves, 'terrain.octaves'), 'terrain.octaves'),
    roughness: range(num(t.roughness, 'terrain.roughness'), 0, 1, 'terrain.roughness'),
  };

  const s = d.sky as Record<string, unknown> | undefined;
  if (!s) throw new Error('world: descriptor needs a sky section');
  const sky: ZoneSkyParams = {
    horizonHue: range(num(s.horizonHue, 'sky.horizonHue'), 0, 1, 'sky.horizonHue'),
    zenithHue: range(num(s.zenithHue, 'sky.zenithHue'), 0, 1, 'sky.zenithHue'),
    starDensity: range(num(s.starDensity, 'sky.starDensity'), 0, 1, 'sky.starDensity'),
  };

  const b = d.biome as Record<string, unknown> | undefined;
  if (!b) throw new Error('world: descriptor needs a biome section');
  const biome: ZoneBiomeParams = {
    name: str(b.name, 'biome.name'),
    moteDensity: range(num(b.moteDensity, 'biome.moteDensity'), 0, 1, 'biome.moteDensity'),
    emberDrift: positive(num(b.emberDrift, 'biome.emberDrift'), 'biome.emberDrift'),
  };

  const w = d.wind as Record<string, unknown> | undefined;
  if (!w) throw new Error('world: descriptor needs a wind section (weights, never a seed)');
  if ('seed' in w) {
    // The law, enforced: a zone must never carry its own wind seed.
    throw new Error(`world: zone '${id}' carries a wind.seed - forbidden. ` +
      'Per-zone wind derives from the global field; the descriptor may only weight it.');
  }
  const wind: ZoneWindParams = {
    biasWeight: range(num(w.biasWeight, 'wind.biasWeight'), 0, 1, 'wind.biasWeight'),
    gustScale: positive(num(w.gustScale, 'wind.gustScale'), 'wind.gustScale'),
    shimmerStrength: nonNeg(num(w.shimmerStrength, 'wind.shimmerStrength'), 'wind.shimmerStrength'),
  };

  if (!Array.isArray(d.portals)) {
    throw new Error('world: descriptor portals must be an array');
  }
  const seenPortalIds = new Set<string>();
  const portals: PortalDescriptor[] = (d.portals as unknown[]).map((p, i) => {
    if (typeof p !== 'object' || p === null) {
      throw new Error(`world: zone '${id}' portal[${i}] must be an object`);
    }
    const pd = p as Record<string, unknown>;
    const pid = str(pd.id, `portals[${i}].id`);
    if (seenPortalIds.has(pid)) {
      throw new Error(`world: zone '${id}' has a duplicate portal id '${pid}'`);
    }
    seenPortalIds.add(pid);
    if (!isVec3(pd.position)) {
      throw new Error(`world: zone '${id}' portal '${pid}' position must be a [x,y,z] triple`);
    }
    if (!isVec3(pd.targetSpawn)) {
      throw new Error(`world: zone '${id}' portal '${pid}' targetSpawn must be a [x,y,z] triple`);
    }
    return {
      id: pid,
      position: pd.position,
      radius: positive(num(pd.radius, `portals[${i}].radius`), `portals[${i}].radius`),
      targetZone: str(pd.targetZone, `portals[${i}].targetZone`),
      targetSpawn: pd.targetSpawn,
      label: typeof pd.label === 'string' ? pd.label : '',
    };
  });

  return {
    id, displayName, seed,
    placement: { offset: placement.offset },
    bounds: { min: bounds.min, max: bounds.max },
    terrain, sky, biome, wind, portals,
    ...(d.audio === undefined ? {} : { audio: parseZoneAudio(d.audio, id) }),
  };
}

const AMBIENT_LAYERS = ['wind', 'water', 'breath'] as const;

/** Parse and validate the optional zone audio block (V8 §5.3). */
function parseZoneAudio(json: unknown, zoneId: string): ZoneAudioParams {
  if (typeof json !== 'object' || json === null) {
    throw new Error(`world: zone '${zoneId}' audio must be an object`);
  }
  const a = json as Record<string, unknown>;
  const out: ZoneAudioParams = {
    reverbSeed: num(a.reverbSeed, 'audio.reverbSeed') >>> 0,
    decay: positive(num(a.decay, 'audio.decay'), 'audio.decay'),
    damping: range(num(a.damping, 'audio.damping'), 0, 1, 'audio.damping'),
    wet: range(num(a.wet, 'audio.wet'), 0, 1, 'audio.wet'),
  };
  if (a.ambientLayer !== undefined) {
    if (typeof a.ambientLayer !== 'string' ||
        !(AMBIENT_LAYERS as readonly string[]).includes(a.ambientLayer)) {
      throw new Error(`world: zone '${zoneId}' audio.ambientLayer must be wind|water|breath`);
    }
    out.ambientLayer = a.ambientLayer as ZoneAudioParams['ambientLayer'];
  }
  return out;
}
