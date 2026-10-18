// physics/particles.ts - the engine's physics core (v2).
//
// A seeded particle system: semi-implicit Euler integration, gravity, drag,
// and collision against a heightfield collider (the procedural terrain).
// Pure functions of (seed, params) wherever possible; the system itself is
// deterministic - same seed, same particle paths, on every machine.
//
// v2 runs this in TypeScript. The interface is deliberately narrow
// (spawn/step/collide) so a future C++ port can drop in behind it.

/** Something particles can collide with. The terrain implements this. */
export interface Collider {
  /** Surface height at (x, z). */
  heightAt(x: number, z: number): number;
}

export interface ParticleOptions {
  /** Maximum live particles. */
  max: number;
  /** Gravity, -Y (e.g. -9.8). */
  gravity?: number;
  /** Linear drag per second (0 = none). */
  drag?: number;
  /** Bounce restitution 0..1 (0 = splat, 1 = perfect bounce). */
  restitution?: number;
  /** Horizontal friction kept on bounce 0..1. */
  friction?: number;
}

/** Deterministic RNG for spawning (mulberry32). */
function spawnRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ParticleSystem {
  readonly max: number;
  readonly gravity: number;
  readonly drag: number;
  readonly restitution: number;
  readonly friction: number;
  /** SoA state. Only [0, count) is live. */
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  readonly life: Float32Array;
  readonly maxLife: Float32Array;
  count = 0;
  private rng: () => number;

  constructor(seed: number, opts: ParticleOptions) {
    this.max = opts.max;
    this.gravity = opts.gravity ?? -9.8;
    this.drag = opts.drag ?? 0;
    this.restitution = opts.restitution ?? 0.4;
    this.friction = opts.friction ?? 0.7;
    this.pos = new Float32Array(opts.max * 3);
    this.vel = new Float32Array(opts.max * 3);
    this.life = new Float32Array(opts.max);
    this.maxLife = new Float32Array(opts.max);
    this.rng = spawnRng(seed);
  }

  /** Spawn one particle. Returns false when full. */
  spawn(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    life: number,
  ): boolean {
    if (this.count >= this.max) return false;
    const i = this.count++;
    this.pos[i * 3] = px; this.pos[i * 3 + 1] = py; this.pos[i * 3 + 2] = pz;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    return true;
  }

  /** Spawn with a seeded random spread around a point/velocity. */
  burst(
    px: number, py: number, pz: number,
    spread: number, speed: number, up: number,
    life: number, lifeSpread: number, n: number,
  ): void {
    for (let k = 0; k < n; k++) {
      const a = this.rng() * Math.PI * 2;
      const r = this.rng() * spread;
      this.spawn(
        px + Math.cos(a) * r, py + (this.rng() - 0.5) * spread, pz + Math.sin(a) * r,
        Math.cos(a) * speed * this.rng(), up * (0.5 + this.rng()),
        Math.sin(a) * speed * this.rng(),
        life * (1 - lifeSpread / 2 + this.rng() * lifeSpread),
      );
    }
  }

  /** Advance the simulation. Dead particles are swapped out (order unstable). */
  step(dt: number, collider?: Collider): void {
    const damp = this.drag > 0 ? Math.max(0, 1 - this.drag * dt) : 1;
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i);
        continue; // swapped particle now sits at i; reprocess it
      }
      const ix = i * 3;
      // Semi-implicit Euler: velocity first, then position.
      this.vel[ix + 1] += this.gravity * dt;
      this.vel[ix] *= damp; this.vel[ix + 1] *= damp; this.vel[ix + 2] *= damp;
      this.pos[ix] += this.vel[ix] * dt;
      this.pos[ix + 1] += this.vel[ix + 1] * dt;
      this.pos[ix + 2] += this.vel[ix + 2] * dt;
      if (collider) {
        const h = collider.heightAt(this.pos[ix], this.pos[ix + 2]);
        if (this.pos[ix + 1] < h) {
          this.pos[ix + 1] = h;
          if (this.vel[ix + 1] < 0) {
            this.vel[ix + 1] = -this.vel[ix + 1] * this.restitution;
            this.vel[ix] *= this.friction;
            this.vel[ix + 2] *= this.friction;
            // Resting contact: kill the bounce, keep it sliding.
            if (Math.abs(this.vel[ix + 1]) < 0.35) this.vel[ix + 1] = 0;
          }
        }
      }
      i++;
    }
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i !== last) {
      for (let c = 0; c < 3; c++) {
        this.pos[i * 3 + c] = this.pos[last * 3 + c];
        this.vel[i * 3 + c] = this.vel[last * 3 + c];
      }
      this.life[i] = this.life[last];
      this.maxLife[i] = this.maxLife[last];
    }
  }

  /** Fraction of life remaining for particle i (for fade-out). */
  lifeFrac(i: number): number {
    return this.maxLife[i] > 0 ? this.life[i] / this.maxLife[i] : 0;
  }
}
