// scene/living.ts - living world composition (v3.0.0).
//
// The V3 campaign built its systems one at a time; this module is
// where they compose into a single world, assembled from one seed
// and one config:
//
//   terrain   the grid world's bilinear heightfield read as the
//             conservative distance field of v2.0.3
//             (src/scene/terrain-field.ts), slope bound and all.
//   bodies    XPBD spheres (v2.0.5, src/physics/collide.ts) living
//             on that field: the field is their SDF, its gradient
//             their contact normal. Rest on this field is the
//             v2.0.5 rest condition read in field units: the field
//             value at a resting center equals the radius.
//   view      the interval guaranteed march of v2.0.6
//             (src/math/interval-march.ts) over the same field, so a
//             view query carries the no-overshoot guarantee, plus
//             analytic ray-sphere intersection for the bodies and
//             the character's two collision spheres.
//   glow      the tokamak emission field of v2.0.8
//             (src/scene/emission-field.ts), integrated along the
//             view ray only as far as the nearest surface, so the
//             terrain occludes it exactly as the layer compositor
//             does in marchScene.
//   watcher   the Wald change detector at its v2.0.4 tuning
//             (src/inverse/changedetect.ts, WALD_GM_C = 1.2),
//             watching a fixed ring of emission probes. Its model
//             parameters are the light's placement: (dx, dz,
//             intensity scale) about the nominal world. A moved
//             light is a parameter jump, which is what the Wald
//             statistic is built to catch.
//   heartbeat the character tick of src/game/character.ts, the same
//             tick whose cross-language parity v2.0.7 pinned,
//             stepped at TICK_DT against the same field.
//
// Terrain shape: an analytic height function sampled at the cell
// centers (rolling ground, one steep hill west of the ring, a flat
// plaza the bodies and the character live on). Seed enters through
// the rolling ground's phases, drawn from the canonical Pcg32.
//
// Honest limits of the composition, named here rather than found
// later: the character and the bodies share the terrain field but
// do not collide with each other; the bodies are spheres, the only
// shape the XPBD path carries; resting clearance on this field is
// the field's conservative distance, so on a world with one steep
// cell every body rests at the field-wide clearance (the v2.0.3
// global slope bound is the price of a true distance).
import type { Vec3 } from '../math/vec.js';
import { Pcg32 } from '../math/determinism.js';
import {
  makeGrid,
  type GridWorld,
} from './grid.js';
import {
  makeGridTerrain,
  marchTerrain,
  type GridTerrainField,
} from './terrain-field.js';
import {
  makeEmissionField,
  integrateEmission,
  type EmissionField,
  type EmissionParams,
} from './emission-field.js';
import {
  marchInterval,
  terrainIntervalField,
} from '../math/interval-march.js';
import {
  stepSpheres,
  type SphereState,
  type ContactStepStats,
} from '../physics/collide.js';
import {
  makeCharacter,
  tickCharacter,
  type CharacterInput,
  type CharacterParams,
  type CharacterState,
} from '../game/character.js';
import { TICK_DT } from '../game/loop.js';
import {
  detectChange,
  type DetectResult,
} from '../inverse/changedetect.js';
import type { Layer, EmissionLayer, GridLayer } from './layers.js';

export interface LivingWorldConfig {
  /** World seed. Default 20261022. Drives the terrain phases. */
  seed?: number;
  /** Gravity vector for the XPBD bodies. Default [0, -9.81, 0].
   *  The sign-flip control in the suite runs [0, 9.81, 0]. */
  gravity?: Vec3;
  /** Build the emission layer. Default true. False builds the dark
   *  control world: identical terrain, bodies and heartbeat, no glow. */
  emission?: boolean;
}

/** Character tuning: the shipped game-feel parameters (the same
 *  values the parity scenario and the game-feel suite run). */
export const LIVING_CHARACTER_PARAMS: CharacterParams = {
  radius: 0.4,
  halfHeight: 0.5,
  moveAccel: 40,
  airAccel: 12,
  maxGroundSpeed: 6,
  maxAirSpeed: 4,
  jumpVelocity: 8,
  gravity: 20,
  groundEps: 0.05,
  coyoteTicks: 6,
  bufferTicks: 8,
  slopeLimit: Math.cos(Math.PI / 6),
  groundFriction: 30,
  jumpCut: 0.5,
};

const WORLD_W = 28;
const WORLD_D = 28;
const WORLD_ORIGIN: Vec3 = [-14, 0, -14];
const HILL: [number, number] = [-5.5, 3.5];
const PLAZA: [number, number] = [4.5, -6.0];
const PLAZA_HEIGHT = 0.85;

/** Nominal emission parameters of the canonical world. */
export const LIVING_EMISSION_PARAMS: EmissionParams = {
  center: [5.5, 3.4, 4.0],
  majorRadius: 2.7,
  minorRadius: 0.95,
  intensity: 2.2,
  profileExponent: 1.5,
  toroidalMode: 3,
  toroidalAmp: 0.25,
  toroidalPhase: 0.7,
  poloidalAmp: 0.2,
  poloidalPhase: 0.4,
};

/** Constant tint of the glow in composed views. */
export const LIVING_EMISSION_TINT: Vec3 = [1.0, 0.55, 0.25];

/** Watcher noise scale (observation sigma, absolute intensity). */
export const LIVING_WATCH_SIGMA = 0.02;

const IDLE_INPUT: CharacterInput = {
  move: [0, 0],
  jumpPressed: false,
  jumpHeld: false,
};

const BODY_COLORS: Vec3[] = [
  [0.85, 0.36, 0.26],
  [0.26, 0.55, 0.85],
  [0.95, 0.74, 0.3],
  [0.62, 0.4, 0.85],
];
const CHARACTER_COLOR: Vec3 = [0.3, 0.85, 0.55];
const LIGHT_DIR: Vec3 = (() => {
  const l = Math.hypot(-0.4, 0.8, 0.45);
  return [-0.4 / l, 0.8 / l, 0.45 / l];
})();

export interface LivingView {
  /** Nearest surface distance (terrain, body or character), or
   *  Infinity when the ray leaves the world. */
  depth: number;
  /** What the ray met first: a surface kind, 'emission' when only
   *  glow was met, 'none' on a clean miss. */
  kind: 'terrain' | 'body' | 'character' | 'emission' | 'none';
  /** Composed color: surface color plus occluded glow. */
  color: Vec3;
  /** The glow alone (zero when the layer is disabled or occluded). */
  glow: Vec3;
  /** Terrain-only march depth under the view policy, Infinity on a
   *  terrain miss. Graded against raycastTerrain in the suite. */
  terrainDepth: number;
  /** Surface point when depth is finite. */
  point?: Vec3;
}

export interface LivingMarchOpts {
  /** Terrain march policy. Default 'interval' (the guaranteed step). */
  policy?: 'interval' | 'terrain';
  /** Certification bound multiplier for the interval policy.
   *  Default 1 (honest). Below 1 voids the guarantee (control only). */
  boundScale?: number;
  /** Hit epsilon. Default 1e-3. */
  eps?: number;
  /** Max view distance. Default 100. */
  maxDist?: number;
  /** Emission quadrature density override (demo frame budgets).
   *  Default: the field module's shared policy. */
  emissionStepsPerMinor?: number;
  /** Emission quadrature sample cap override. */
  emissionMaxSamples?: number;
  /** View-level emission switch. Default true. False renders the
   *  composed view without the glow (the demo's layer toggle). The
   *  build-level dark world (config.emission false) is the stronger
   *  control and is what the suite grades. */
  emission?: boolean;
}

export interface LivingWorld {
  readonly seed: number;
  readonly grid: GridWorld;
  readonly terrain: GridTerrainField;
  /** The live emission field, or null in the dark control world. */
  readonly emission: EmissionField | null;
  readonly bodies: SphereState[];
  readonly character: CharacterState;
  /** Fixed ticks stepped so far (the heartbeat count). */
  readonly tick: number;
  /** Advance one fixed tick: character first (the heartbeat), then
   *  the XPBD bodies. Returns the bodies' step statistics. */
  stepTick(input?: CharacterInput): ContactStepStats;
  /** The layer stack of this world (grid + emission) for consumers
   *  who march with the v2.0.8 compositor instead. */
  layers(): Layer[];
  /** Composed view query against the current state. */
  march(origin: Vec3, dir: Vec3, opts?: LivingMarchOpts): LivingView;
  /** Current emission center (the nominal center when dark). */
  emissionCenter(): Vec3;
  /** Move the live light by (dx, dz) from nominal. Returns false in
   *  the dark world. The watcher's prediction does not move: this is
   *  the scripted change the watcher exists to catch. */
  moveEmission(dx: number, dz: number): boolean;
  /** Sample the live world through the watcher's probes, with
   *  seeded Gaussian observation noise. */
  observe(noiseSeed: number): number[];
  /** Run the Wald detector on an observation vector against the
   *  nominal world prediction, at the v2.0.4 operating point. */
  watch(y: number[]): DetectResult;
  /** Bodies currently reading as settled (rest band + speed cap). */
  settledCount(): number;
  /** Deterministic digest of the composed state. Bit-identical
   *  across runs of the same seed and script. */
  digest(): string;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function buildGrid(seed: number): GridWorld {
  const rng = new Pcg32(seed);
  const p1 = rng.unit() * Math.PI * 2;
  const p2 = rng.unit() * Math.PI * 2;
  const p3 = rng.unit() * Math.PI * 2;
  const g = makeGrid(WORLD_W, WORLD_D, {
    cellSize: 1,
    origin: [...WORLD_ORIGIN] as Vec3,
    height: 2,
  });
  const heights = new Float64Array(WORLD_W * WORLD_D);
  for (let j = 0; j < WORLD_D; j++) {
    for (let i = 0; i < WORLD_W; i++) {
      const x = WORLD_ORIGIN[0] + (i + 0.5);
      const z = WORLD_ORIGIN[2] + (j + 0.5);
      let h =
        0.55 +
        0.35 * Math.sin(0.32 * x + p1) * Math.cos(0.27 * z + p2) +
        0.18 * Math.sin(0.11 * x - 0.13 * z + p3);
      const dh = Math.hypot(x - HILL[0], z - HILL[1]);
      h += 3.6 * Math.exp(-(dh * dh) / (2 * 1.7 * 1.7));
      const dp = Math.hypot(x - PLAZA[0], z - PLAZA[1]);
      const w = 1 - smoothstep(3.2, 4.6, dp);
      h = h * (1 - w) + PLAZA_HEIGHT * w;
      g.cells[j * WORLD_W + i] = 1;
      heights[j * WORLD_W + i] = h;
    }
  }
  g.heights = heights;
  return g;
}

/** Exact ray-sphere distance (smallest positive root), or Infinity. */
function raySphere(origin: Vec3, dir: Vec3, c: Vec3, r: number): number {
  const ox = origin[0] - c[0];
  const oy = origin[1] - c[1];
  const oz = origin[2] - c[2];
  const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const t0 = -b - sq;
  if (t0 > 0) return t0;
  const t1 = -b + sq;
  return t1 > 0 ? t1 : Infinity;
}

export function makeLivingWorld(config: LivingWorldConfig = {}): LivingWorld {
  const seed = config.seed ?? 20261022;
  if (!Number.isInteger(seed)) {
    throw new Error(`makeLivingWorld: seed must be an integer, got ${seed}`);
  }
  const gravity: Vec3 = config.gravity
    ? [config.gravity[0], config.gravity[1], config.gravity[2]]
    : [0, -9.81, 0];
  const withEmission = config.emission ?? true;

  const grid = buildGrid(seed);
  const terrain = makeGridTerrain(grid);
  const denom = Math.sqrt(1 + terrain.slopeBound * terrain.slopeBound);

  // The field as an SDF for physics and the character: value from
  // distAt, gradient the closed form of that quotient.
  const fieldF = (p: Vec3): number => terrain.distAt(p);
  const fieldGrad = (p: Vec3): Vec3 => {
    const [gx, gz] = terrain.gradientAt(p[0], p[2]);
    return [-gx / denom, 1 / denom, -gz / denom];
  };

  const restY = (x: number, z: number, r: number): number =>
    terrain.heightAt(x, z) + r * denom;

  const mkBody = (x: number, z: number, r: number, m: number, drop: number): SphereState => ({
    c: [x, restY(x, z, r) + drop, z],
    v: [0, 0, 0],
    w: [0, 0, 0],
    m,
    r,
  });
  const bodies: SphereState[] = [
    mkBody(3.2, -6.2, 0.45, 1, 1.2),
    mkBody(5.8, -5.2, 0.6, 2, 1.6),
    mkBody(4.4, -7.6, 0.5, 1, 1.0),
    mkBody(4.4, -7.6, 0.5, 1, 3.2),
  ];

  const P = LIVING_CHARACTER_PARAMS;
  const character = makeCharacter([
    PLAZA[0],
    terrain.heightAt(PLAZA[0], PLAZA[1]) + P.radius * denom + P.halfHeight,
    PLAZA[1],
  ]);

  // Emission: the live field (moves under moveEmission) and the
  // nominal parameters the watcher predicts from.
  const nominalParams: EmissionParams = { ...LIVING_EMISSION_PARAMS };
  let liveEmission: EmissionField | null = withEmission
    ? makeEmissionField(nominalParams)
    : null;

  // Watcher probes: fixed world points. A ring at rho = 0.7 on the
  // outboard midplane, where the profile's slope is steep: a moved
  // light changes every one of these coherently (brighter on the
  // side it moves toward, dimmer opposite), and that coherent
  // pattern is exactly what the (dx, dz) Jacobian spans. A ring on
  // the core circle itself (rho = 0) pins the intensity scale: the
  // profile is flat there, but the toroidal and poloidal variation
  // factors still read the light's placement.
  const nc: Vec3 = nominalParams.center ?? [0, 0, 0];
  const probes: Vec3[] = [];
  for (let k = 0; k < 16; k++) {
    const th = (k / 16) * Math.PI * 2;
    const rr = nominalParams.majorRadius + 0.7 * nominalParams.minorRadius;
    probes.push([nc[0] + rr * Math.cos(th), nc[1], nc[2] + rr * Math.sin(th)]);
  }
  for (let k = 0; k < 8; k++) {
    const th = (k / 8) * Math.PI * 2 + Math.PI / 8;
    probes.push([
      nc[0] + nominalParams.majorRadius * Math.cos(th),
      nc[1],
      nc[2] + nominalParams.majorRadius * Math.sin(th),
    ]);
  }

  const modelField = (theta: number[]): EmissionField =>
    makeEmissionField({
      ...nominalParams,
      center: [nc[0] + theta[0], nc[1], nc[2] + theta[1]],
      intensity: nominalParams.intensity * theta[2],
    });
  const modelR = (theta: number[]): number[] => {
    const f = modelField(theta);
    return probes.map((p) => f.emissionAt(p));
  };
  const modelJ = (theta: number[]): number[][] => {
    const out: number[][] = probes.map(() => [0, 0, 0]);
    for (let k = 0; k < 3; k++) {
      const h = 1e-5 * Math.max(1, Math.abs(theta[k]));
      const tp = theta.slice();
      tp[k] += h;
      const tm = theta.slice();
      tm[k] -= h;
      const rp = modelR(tp);
      const rm = modelR(tm);
      for (let i = 0; i < probes.length; i++) {
        out[i][k] = (rp[i] - rm[i]) / (2 * h);
      }
    }
    return out;
  };

  let tick = 0;

  const terrainColorAt = (p: Vec3): Vec3 => {
    const h = terrain.heightAt(p[0], p[2]);
    const t = clamp01(h / 4.4);
    const [gx, gz] = terrain.gradientAt(p[0], p[2]);
    const shade = 0.45 + 0.55 / (1 + 0.3 * Math.hypot(gx, gz));
    return [
      (0.15 + (0.58 - 0.15) * t) * shade,
      (0.32 + (0.5 - 0.32) * t) * shade,
      (0.19 + (0.4 - 0.19) * t) * shade,
    ];
  };

  const world: LivingWorld = {
    seed,
    grid,
    terrain,
    get emission() {
      return liveEmission;
    },
    bodies,
    character,
    get tick() {
      return tick;
    },

    stepTick(input?: CharacterInput): ContactStepStats {
      tickCharacter(
        character, P, input ?? IDLE_INPUT, fieldF, fieldGrad, TICK_DT,
      );
      const stats = stepSpheres(bodies, fieldF, fieldGrad, gravity, TICK_DT, {
        substeps: 20,
        // Three Gauss-Seidel iterations, not the default one: the
        // terrain field's gradient magnitude is 1 / sqrt(1 + S^2),
        // not 1, so each position pass closes only that fraction of
        // a contact's residual. Measured at rest (field units): one
        // iteration leaves a 3e-6 penetration on a single body,
        // three leave 4e-7; the coupled two-body stack keeps 3e-6
        // and the bounded velocity limit cycle v2.0.5 pinned. All
        // of it is graded in the suite.
        iterations: 3,
        alpha: 0,
        e: 0,
        muS: 0.7,
        muK: 0.6,
      });
      tick++;
      return stats;
    },

    layers(): Layer[] {
      const gridLayer: GridLayer = {
        kind: 'grid',
        grid,
        color: (_cx, _cz, _side, p) => terrainColorAt(p),
      };
      if (!liveEmission) return [gridLayer];
      const emissionLayer: EmissionLayer = {
        kind: 'emission',
        field: liveEmission,
        tint: [...LIVING_EMISSION_TINT] as Vec3,
      };
      return [gridLayer, emissionLayer];
    },

    march(origin: Vec3, dir: Vec3, opts: LivingMarchOpts = {}): LivingView {
      const maxDist = opts.maxDist ?? 100;
      const eps = opts.eps ?? 1e-3;
      let terrainDepth = Infinity;
      if ((opts.policy ?? 'interval') === 'interval') {
        const res = marchInterval(terrainIntervalField(terrain), origin, dir, {
          eps,
          maxDist,
          boundScale: opts.boundScale ?? 1,
        });
        terrainDepth = res.depth;
      } else {
        terrainDepth = marchTerrain(terrain, origin, dir, {
          eps,
          maxDist,
        }).depth;
      }
      let depth = terrainDepth;
      let kind: LivingView['kind'] =
        terrainDepth === Infinity ? 'none' : 'terrain';
      let point: Vec3 | undefined =
        terrainDepth === Infinity
          ? undefined
          : [
              origin[0] + dir[0] * terrainDepth,
              origin[1] + dir[1] * terrainDepth,
              origin[2] + dir[2] * terrainDepth,
            ];
      let base: Vec3 = point ? terrainColorAt(point) : [0, 0, 0];
      // Bodies and the character's collision spheres, analytically.
      const shadeSphere = (c: Vec3, r: number, color: Vec3, at: Vec3): Vec3 => {
        const nx = (at[0] - c[0]) / r;
        const ny = (at[1] - c[1]) / r;
        const nz = (at[2] - c[2]) / r;
        const lam = Math.max(
          0,
          nx * LIGHT_DIR[0] + ny * LIGHT_DIR[1] + nz * LIGHT_DIR[2],
        );
        const s = 0.3 + 0.7 * lam;
        return [color[0] * s, color[1] * s, color[2] * s];
      };
      bodies.forEach((b, i) => {
        const t = raySphere(origin, dir, b.c, b.r);
        if (t < depth) {
          depth = t;
          kind = 'body';
          point = [
            origin[0] + dir[0] * t,
            origin[1] + dir[1] * t,
            origin[2] + dir[2] * t,
          ];
          base = shadeSphere(b.c, b.r, BODY_COLORS[i % BODY_COLORS.length], point);
        }
      });
      const ends: Vec3[] = [
        [
          character.pos[0],
          character.pos[1] - P.halfHeight,
          character.pos[2],
        ],
        [
          character.pos[0],
          character.pos[1] + P.halfHeight,
          character.pos[2],
        ],
      ];
      for (const e of ends) {
        const t = raySphere(origin, dir, e, P.radius);
        if (t < depth) {
          depth = t;
          kind = 'character';
          point = [
            origin[0] + dir[0] * t,
            origin[1] + dir[1] * t,
            origin[2] + dir[2] * t,
          ];
          base = shadeSphere(e, P.radius, CHARACTER_COLOR, point);
        }
      }
      // Glow, integrated only as far as the nearest surface: the
      // terrain (and everything on it) occludes the ring.
      let glow: Vec3 = [0, 0, 0];
      if (liveEmission && (opts.emission ?? true)) {
        const tEnd = Math.min(depth, maxDist);
        const integral = integrateEmission(liveEmission, origin, dir, tEnd, {
          stepsPerMinor: opts.emissionStepsPerMinor,
          maxSamples: opts.emissionMaxSamples,
        });
        glow = [
          integral.value * LIVING_EMISSION_TINT[0],
          integral.value * LIVING_EMISSION_TINT[1],
          integral.value * LIVING_EMISSION_TINT[2],
        ];
      }
      if (depth === Infinity) {
        if (glow[0] === 0 && glow[1] === 0 && glow[2] === 0) {
          return { depth, kind: 'none', color: [0, 0, 0], glow, terrainDepth };
        }
        return { depth, kind: 'emission', color: glow, glow, terrainDepth };
      }
      return {
        depth,
        kind,
        color: [base[0] + glow[0], base[1] + glow[1], base[2] + glow[2]],
        glow,
        terrainDepth,
        point,
      };
    },

    emissionCenter(): Vec3 {
      const c = liveEmission ? liveEmission.center : nc;
      return [c[0], c[1], c[2]];
    },

    moveEmission(dx: number, dz: number): boolean {
      if (!liveEmission) return false;
      liveEmission = makeEmissionField({
        ...nominalParams,
        center: [nc[0] + dx, nc[1], nc[2] + dz],
      });
      return true;
    },

    observe(noiseSeed: number): number[] {
      const rng = new Pcg32(noiseSeed);
      const gauss = (): number => {
        const u1 = Math.max(rng.unit(), 2 ** -24);
        const u2 = rng.unit();
        return (
          Math.sqrt(-2 * Math.log(u1)) *
          Math.cos(2 * Math.PI * u2)
        );
      };
      return probes.map(
        (p) =>
          (liveEmission ? liveEmission.emissionAt(p) : 0) +
          LIVING_WATCH_SIGMA * gauss(),
      );
    },

    watch(y: number[]): DetectResult {
      return detectChange(
        y,
        [0, 0, 1],
        modelR,
        modelJ,
        LIVING_WATCH_SIGMA * LIVING_WATCH_SIGMA,
      );
    },

    settledCount(): number {
      // Settled = slow, and supported: resting on the terrain (the
      // field value at the center equals the radius, the v2.0.5
      // rest condition in field units) or resting on a body that is
      // itself settled (the stack). Support propagates to a fixed
      // point so a tower of any height reads correctly.
      const slow = bodies.map(
        (b) => Math.hypot(b.v[0], b.v[1], b.v[2]) <= 1e-2,
      );
      const settled = bodies.map(
        (b, i) =>
          slow[i] && Math.abs(terrain.distAt(b.c) - b.r) <= 5e-3,
      );
      let changed = true;
      while (changed) {
        changed = false;
        for (let i = 0; i < bodies.length; i++) {
          if (settled[i] || !slow[i]) continue;
          for (let j = 0; j < bodies.length; j++) {
            if (!settled[j] || bodies[j].c[1] >= bodies[i].c[1]) continue;
            const d = Math.hypot(
              bodies[i].c[0] - bodies[j].c[0],
              bodies[i].c[1] - bodies[j].c[1],
              bodies[i].c[2] - bodies[j].c[2],
            );
            if (Math.abs(d - (bodies[i].r + bodies[j].r)) <= 5e-3) {
              settled[i] = true;
              changed = true;
            }
          }
        }
      }
      return settled.filter(Boolean).length;
    },

    digest(): string {
      const parts: string[] = [`seed=${seed}`, `tick=${tick}`];
      for (const b of bodies) {
        parts.push(
          b.c.map((v) => v.toPrecision(17)).join(','),
          b.v.map((v) => v.toPrecision(17)).join(','),
        );
      }
      parts.push(
        character.pos.map((v) => v.toPrecision(17)).join(','),
        character.vel.map((v) => v.toPrecision(17)).join(','),
        character.grounded ? 'g1' : 'g0',
        `coyote=${character.coyote}`,
        `buffer=${character.buffer}`,
      );
      const c = world.emissionCenter();
      parts.push(c.map((v) => v.toPrecision(17)).join(','));
      const s = parts.join('|');
      let h1 = 0xcbf29ce484222325n;
      const prime = 0x100000001b3n;
      const mask = 0xffffffffffffffffn;
      for (let i = 0; i < s.length; i++) {
        h1 ^= BigInt(s.charCodeAt(i));
        h1 = (h1 * prime) & mask;
      }
      return h1.toString(16).padStart(16, '0');
    },
  };
  return world;
}
