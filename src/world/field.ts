// world/field.ts - the live shared environmental field.
//
// GlobalField owns ONE WindField plus the six per-domain parameter sets the
// foundry endgame exposes (one lever per engine language). Changing any
// domain bumps `revision` and notifies listeners, so the composed world
// re-derives downstream: wind gain reshapes ember currents, genesis seed
// reshapes terrain bones, biome blend shifts world character, tempo moves
// behavior rhythm, light moves perception, presence moves physics feel.
//
// This is the mechanical foundation of the foundry endgame ("the player
// becomes the wind"): real engine function, not a game stub. The six
// `field.write.*` capability grants map 1:1 onto setDomain() here.

import { WindField, type PlayerState, type WindSample } from './wind.js';
import {
  defaultFieldParams,
  type FieldDomain, type FieldParams,
  type WindParams, type SceneParams, type GenesisParams,
  type BiomeParams, type TempoParams, type LightParams, type PresenceParams,
} from './types.js';

export type { FieldDomain };

/** Deep-copy of the live params (safe to hand across boundaries). */
export function copyParams(p: FieldParams): FieldParams {
  return JSON.parse(JSON.stringify(p)) as FieldParams;
}

type Listener = (field: GlobalField, domain: FieldDomain | 'wind.seed') => void;

const DOMAIN_KEYS: Record<FieldDomain, string[]> = {
  scene: ['terrainHeight', 'shimmerStrength', 'skyHueShift'],
  // genesis also carries the wind field's global parameters: the deep-
  // generation lever (C++/WASM) owns seeds AND the weather's global gains.
  // Wind params are read live at sample time, so no rebuild is ever needed.
  genesis: ['seed', 'noiseScale', 'noiseOctaves', 'gain', 'gustStrength', 'playerCoupling'],
  biome: ['biomeName', 'moteDensity', 'emberDrift', 'paletteShift'],
  tempo: ['beatPeriod', 'energy', 'swing'],
  light: ['timeOfDay', 'exposure', 'hueRotate'],
  presence: ['gravity', 'moveSpeed', 'drag'],
};

/** Patch keys on the genesis domain that target params.wind, not params.genesis. */
const GENESIS_WIND_KEYS = new Set(['gain', 'gustStrength', 'playerCoupling']);

function checkPatch(domain: FieldDomain, patch: Record<string, unknown>): void {
  const allowed = DOMAIN_KEYS[domain];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) {
      throw new Error(`world: unknown param '${domain}.${k}'`);
    }
    if (k === 'biomeName') {
      if (typeof v !== 'string' || !v) throw new Error(`world: '${domain}.${k}' must be a non-empty string`);
    } else if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`world: '${domain}.${k}' must be a finite number`);
    }
  }
  // Range law per domain - the foundry levers stay inside sane bounds.
  const n = (k: string): number => patch[k] as number;
  const need = (k: string, ok: boolean, msg: string): void => {
    if (k in patch && !ok) throw new Error(`world: '${domain}.${k}' ${msg}`);
  };
  need('gain', n('gain') > 0, 'must be > 0');
  need('gustStrength', n('gustStrength') >= 0 && n('gustStrength') <= 1, 'must be in [0,1]');
  need('playerCoupling', n('playerCoupling') >= 0 && n('playerCoupling') <= 1, 'must be in [0,1]');
  need('terrainHeight', n('terrainHeight') > 0, 'must be > 0');
  need('shimmerStrength', n('shimmerStrength') >= 0, 'must be >= 0');
  need('noiseScale', n('noiseScale') > 0, 'must be > 0');
  need('noiseOctaves', Number.isInteger(n('noiseOctaves')) && n('noiseOctaves') >= 1, 'must be an integer >= 1');
  need('moteDensity', n('moteDensity') >= 0 && n('moteDensity') <= 1, 'must be in [0,1]');
  need('emberDrift', n('emberDrift') > 0, 'must be > 0');
  need('paletteShift', n('paletteShift') >= 0 && n('paletteShift') <= 1, 'must be in [0,1]');
  need('beatPeriod', n('beatPeriod') > 0, 'must be > 0');
  need('energy', n('energy') >= 0 && n('energy') <= 1, 'must be in [0,1]');
  need('swing', n('swing') >= 0 && n('swing') <= 1, 'must be in [0,1]');
  need('timeOfDay', n('timeOfDay') >= 0 && n('timeOfDay') <= 1, 'must be in [0,1]');
  need('exposure', n('exposure') > 0, 'must be > 0');
  need('hueRotate', n('hueRotate') >= 0 && n('hueRotate') <= 1, 'must be in [0,1]');
  need('gravity', n('gravity') > 0, 'must be > 0');
  need('moveSpeed', n('moveSpeed') > 0, 'must be > 0');
  need('drag', n('drag') >= 0 && n('drag') <= 1, 'must be in [0,1]');
}

export class GlobalField {
  private params: FieldParams;
  private windField: WindField;
  private listeners = new Set<Listener>();
  /** Bumped on every mutation. Derived views cache against it. */
  revision = 0;

  constructor(params?: Partial<FieldParams>, globalSeed?: number) {
    this.params = defaultFieldParams(globalSeed ?? 20261010);
    if (params) this.merge(params);
    this.windField = new WindField(this.params.globalSeed, this.params.wind);
  }

  private merge(patch: Partial<FieldParams>): void {
    if (patch.globalSeed !== undefined) {
      if (!Number.isFinite(patch.globalSeed)) throw new Error('world: globalSeed must be finite');
      this.params.globalSeed = patch.globalSeed >>> 0;
    }
    (Object.keys(DOMAIN_KEYS) as FieldDomain[]).forEach((d) => {
      const sub = (patch as Record<string, unknown>)[d] as Record<string, unknown> | undefined;
      if (sub) Object.assign(this.params[d], sub);
    });
  }

  /** Current params (a copy - mutating it changes nothing). */
  snapshot(): FieldParams { return copyParams(this.params); }

  /** The live wind field. Zones sample through this; it is the single
   *  source of wind truth for the whole composed world. */
  get wind(): WindField { return this.windField; }

  /** Sample the GLOBAL field in world coordinates. Every zone derives from
   *  this call - that is the whole coherence guarantee. */
  sampleWorld(x: number, y: number, z: number, t: number): WindSample {
    return this.windField.sample(x, y, z, t);
  }

  /**
   * Foundry write: patch one domain's live parameters. Validates, merges,
   * bumps revision, rebuilds what the domain owns (wind/genesis reseed the
   * wind field and terrain derivation), and notifies listeners so composed
   * zones re-derive. Returns the new full snapshot.
   */
  setDomain(domain: FieldDomain, patch: Record<string, unknown>): FieldParams {
    checkPatch(domain, patch);
    const before = JSON.stringify(this.params[domain]) + JSON.stringify(this.params.wind);
    if (domain === 'genesis') {
      // Split the patch: wind.* keys go to params.wind, the rest to params.genesis.
      // Wind params are read live at sample time - no field rebuild needed.
      // (genesis.seed reshapes zone terrain/noise; zones re-derive from the
      // revision bump. The wind field itself is seeded by globalSeed only.)
      for (const [k, v] of Object.entries(patch)) {
        if (GENESIS_WIND_KEYS.has(k)) {
          (this.params.wind as unknown as Record<string, unknown>)[k] = v;
        } else {
          (this.params.genesis as unknown as Record<string, unknown>)[k] = v;
        }
      }
      // Push the new wind params into the live field (it keeps its own copy).
      this.windField.setParams(this.params.wind);
    } else {
      Object.assign(this.params[domain], patch);
    }
    if (JSON.stringify(this.params[domain]) + JSON.stringify(this.params.wind) !== before) {
      this.revision++;
      this.notify(domain);
    }
    return this.snapshot();
  }

  /** Reseed the entire global field (genesis-level change). */
  setGlobalSeed(seed: number): FieldParams {
    if (!Number.isFinite(seed)) throw new Error('world: globalSeed must be finite');
    this.params.globalSeed = seed >>> 0;
    this.windField.rebuild(this.params.globalSeed, this.params.wind);
    this.revision++;
    this.notify('wind.seed');
    return this.snapshot();
  }

  /**
   * The 7th lever: feed the player's embodied state into the field.
   *
   * Player state is a LIVE sample-time input to the wind field (the wake
   * term is evaluated per sample), not a derivation parameter - so it does
   * NOT bump the field revision. Bumping it here used to invalidate every
   * zone's derivations each frame, forcing needless terrain rebuilds in
   * hosts that re-derive on revision changes (and letting the player's
   * momentary position leak into the anchor-mean probes).
   */
  setPlayerState(p: PlayerState | null): void {
    this.windField.setPlayerState(p);
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(domain: FieldDomain | 'wind.seed'): void {
    for (const fn of [...this.listeners]) fn(this, domain);
  }
}

// Re-export the param types for consumers.
export type {
  FieldParams, WindParams, SceneParams, GenesisParams,
  BiomeParams, TempoParams, LightParams, PresenceParams,
};
