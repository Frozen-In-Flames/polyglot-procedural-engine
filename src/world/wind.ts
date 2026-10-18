// world/wind.ts - the shared global seeded procedural vector field.
//
// THE WIND, mathematically. One global field for the whole composed world,
// deterministic from a single seed. It is NEVER one direction: four layered
// directional flows, each rotating its heading across space at its own
// wavelength and oscillating in time at its own frequency, with spatially
// varying force (a seeded fbm envelope) and a second-harmonic gust term.
//
//   W(p, t) = gain * Σ_k  env_k(p) * gust_k(p, t) * dir_k(p, t)   (+ player wake)
//
//   env_k(p)  = A_k * (0.45 + 0.55 * fbm2(p.xz * κk/2, envSeed_k))
//               - force varies across subsections of the world
//   θ_k(p,t)  = κk * (u_k · p) + ωk * t + φk
//               - heading rotates across space (wavelength λk = 2π/κk) and
//                 drifts in time; different axes u_k per layer, so the wind
//                 is multi-directional at every point
//   gust_k    = 1 + gustStrength * sin(2θ_k + κk * (v_k · p))
//               - v_k perpendicular to u_k: gusts arrive crosswise to the
//                 local heading, like chop on a lake
//   dir_k     = u_k * cos θ_k + w_k * sin θ_k,  y += 0.35 * sin(θ_k + π/2)
//               - u_k, w_k an orthonormal horizontal pair; the y term is the
//                 field's vertical breathing
//
// Everything seeded: λk ∈ {14, 22, 34, 52}, ωk ∈ {0.05, 0.11, 0.19, 0.31},
// axes, amplitudes, phases, envelope seeds - all drawn from mulberry32
// mixed with the global seed. Same seed → identical field, forever.
//
// THE WIND CORRECTION (Aries, Oct 10, 2026): the wind itself is never
// visualized. Scripts may SAMPLE it (position, time) -> vector through the
// read-only `field.wind` capability, and the world carries its structure in
// texture - terrain shimmer, ember lean, mote clustering - but no overlay,
// no number, no highlight ever renders the field directly.

import { mulberry32, fbm2 } from '../geo/rng.js';
import type { WindParams } from './types.js';

export interface WindSample {
  x: number; y: number; z: number;
}

interface WindLayer {
  ux: number; uz: number;   // horizontal flow axis (unit)
  wx: number; wz: number;   // perpendicular horizontal axis (unit)
  kappa: number;            // 2π / wavelength
  omega: number;            // temporal frequency (rad/s)
  phase: number;
  amp: number;
  envSeed: number;          // seed for the spatial force envelope
  vertPhase: number;
}

/** Player embodied state: the 7th lever. Where the player stands, how fast
 *  they move, and the rhythm they've learned stir the field locally. */
export interface PlayerState {
  position: [number, number, number];
  speed: number;   // world units / second
  rhythm: number;  // 0..1 - the learned cycle phase the player is moving on
}

const WAVELENGTHS = [14, 22, 34, 52];
const FREQUENCIES = [0.05, 0.11, 0.19, 0.31];
const LAYER_COUNT = 4;

export class WindField {
  private layers: WindLayer[] = [];
  private seed: number;
  private params: WindParams;
  private player: PlayerState | null = null;

  constructor(globalSeed: number, params: WindParams) {
    this.seed = globalSeed >>> 0;
    this.params = { ...params };
    this.buildLayers();
  }

  /** Rebuild the layer stack (called when the seed changes). */
  rebuild(globalSeed: number, params: WindParams): void {
    this.seed = globalSeed >>> 0;
    this.params = { ...params };
    this.buildLayers();
  }

  /** Live-update wind params without reseeding (foundry lever). */
  setParams(params: WindParams): void {
    this.params = { ...params };
  }

  get windParams(): WindParams { return { ...this.params }; }
  get globalSeed(): number { return this.seed; }

  /** The 7th lever: the player's embodied state stirs the field. Host-driven
   *  (game samples it); deterministic given the inputs. */
  setPlayerState(p: PlayerState | null): void {
    this.player = p ? {
      position: [p.position[0], p.position[1], p.position[2]],
      speed: p.speed, rhythm: p.rhythm,
    } : null;
  }

  get playerState(): PlayerState | null {
    return this.player ? {
      position: [...this.player.position] as [number, number, number],
      speed: this.player.speed, rhythm: this.player.rhythm,
    } : null;
  }

  private buildLayers(): void {
    const rng = mulberry32((this.seed ^ 0x9e3779b9) >>> 0);
    const lambdas = [...WAVELENGTHS];
    const omegas = [...FREQUENCIES];
    // Fisher–Yates with the seeded stream: deterministic per-layer assignment.
    for (let i = lambdas.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [lambdas[i], lambdas[j]] = [lambdas[j], lambdas[i]];
      [omegas[i], omegas[j]] = [omegas[j], omegas[i]];
    }
    this.layers = [];
    for (let k = 0; k < LAYER_COUNT; k++) {
      const a = rng() * Math.PI * 2; // flow axis angle
      this.layers.push({
        ux: Math.cos(a), uz: Math.sin(a),
        wx: -Math.sin(a), wz: Math.cos(a),
        kappa: (Math.PI * 2) / lambdas[k],
        omega: omegas[k],
        phase: rng() * Math.PI * 2,
        amp: 0.6 + rng() * 1.0,
        envSeed: (this.seed + k * 7919) >>> 0,
        vertPhase: rng() * Math.PI * 2,
      });
    }
  }

  /** Sample the field: (position, time) -> vector. Pure function of the
   *  seed, params, player state, position, and time. */
  sample(x: number, y: number, z: number, t: number): WindSample {
    const { gain, gustStrength, playerCoupling } = this.params;
    let vx = 0, vy = 0, vz = 0;
    for (const L of this.layers) {
      const s = L.ux * x + L.uz * z + 0.15 * y;
      const cross = L.wx * x + L.wz * z;
      const theta = L.kappa * s + L.omega * t + L.phase;
      // Spatially varying force: the envelope makes some subsections push
      // hard while others drift - never uniform across the world.
      const env = L.amp * (0.45 + 0.55 * fbm2(
        x * L.kappa * 0.5, z * L.kappa * 0.5, L.envSeed));
      const gust = 1 + gustStrength * Math.sin(2 * theta + L.kappa * cross);
      const w = env * gust;
      const c = Math.cos(theta), sn = Math.sin(theta);
      vx += w * (L.ux * c + L.wx * sn);
      vz += w * (L.uz * c + L.wz * sn);
      vy += w * 0.35 * Math.sin(theta + L.vertPhase);
    }
    // Player wake: the 7th lever. Motion stirs the field within ~30 units;
    // the learned rhythm phase-shifts the local gusts.
    if (this.player && playerCoupling > 0 && this.player.speed > 1e-6) {
      const dx = x - this.player.position[0];
      const dy = y - this.player.position[1];
      const dz = z - this.player.position[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      const wake = playerCoupling * Math.min(1, this.player.speed / 8) *
        Math.exp(-d2 / 900);
      if (wake > 1e-9) {
        const ph = this.player.rhythm * Math.PI * 2;
        vx += wake * Math.cos(ph);
        vz += wake * Math.sin(ph);
        vy += wake * 0.5 * Math.sin(2 * ph);
      }
    }
    return { x: vx * gain, y: vy * gain, z: vz * gain };
  }
}
