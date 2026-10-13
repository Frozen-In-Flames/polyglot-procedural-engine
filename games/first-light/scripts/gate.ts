// games/first-light/scripts/gate.ts — the dark gate.
//
// The visible goal: gather the scattered embers, carry them to the gate.
// The gate BRIGHTENS per ember delivered (visible progress) but OPENS only
// at resonance — attunement level 6 — never for collection alone. At
// resonance the gate answers: light, a chord, and a portal to the foundry
// standing open in the gate's own mouth.

import type { Caps, CapabilityName, ScriptDef, SpawnBody } from '../../../src/script/index.js';
import { GATE_POS } from '../shared.js';

export const GATE_GRANTS: CapabilityName[] = [
  'rng', 'time', 'world.spawn', 'world.query', 'world.state',
  'events', 'audio', 'log', 'field.read', 'probe',
];

const GATE_BODY: SpawnBody = {
  geometry: { kind: 'torus', radius: 3.2, tube: 0.55, detail: 24 },
  material: {
    baseColor: [0.08, 0.12, 0.3] as [number, number, number],
    effects: ['fresnel'] as Array<'fresnel'>,
  },
};
const HEART_BODY: SpawnBody = {
  geometry: { kind: 'sphere', radius: 2.55, detail: 16 },
  material: {
    baseColor: [0.01, 0.015, 0.04] as [number, number, number],
    unlit: true,
  },
};
const SPARK_BODY: SpawnBody = {
  geometry: { kind: 'sphere', radius: 0.16, detail: 6 },
  material: {
    baseColor: [1.0, 0.7, 0.25] as [number, number, number],
    unlit: true,
  },
};
const RING_BODY: SpawnBody = {
  geometry: { kind: 'torus', radius: 4.4, tube: 0.18, detail: 24 },
  material: {
    baseColor: [1.0, 0.62, 0.2] as [number, number, number],
    effects: ['pulse'] as Array<'pulse'>,
    unlit: true,
  },
};

export const gateScript: ScriptDef = {
  name: 'fl:gate',

  start(caps: Caps): void {
    // The torus builder makes a flat ring (hole up); the gate stands
    // vertical, facing whoever approaches down the -z axis. It rises from
    // the ground it stands on (probed live — the terrain is procedural).
    const gy = caps.probe.ground(GATE_POS[0], GATE_POS[2]) + 3.8;
    gateY = gy;
    caps.world.spawn('gate', {
      position: [GATE_POS[0], gy, GATE_POS[2]], tag: 'gate', body: GATE_BODY,
      rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    });
    caps.world.spawn('gate-heart', {
      position: [GATE_POS[0], gy, GATE_POS[2]], tag: 'gate', body: HEART_BODY,
    });
    caps.world.setState('gate:opened', 0);
    caps.events.on('ember:delivered', (data) => {
      const count = (data as { count?: unknown }).count;
      const n = typeof count === 'number' ? count : 0;
      const g = caps.world.find('gate');
      if (g) {
        const tr = g.getTransform();
        const s = 1 + 0.05 * n;
        g.setTransform({ ...tr, scale: [s, s, s] });
      }
      // Visible progress: each delivered ember becomes a spark orbiting
      // the gate — the gate visibly fills with what was brought home.
      for (let k = 0; k < 2; k++) {
        caps.world.spawn(`spark:${n}:${k}`, {
          position: [GATE_POS[0], gateY, GATE_POS[2]],
          tag: 'spark',
          body: SPARK_BODY,
        });
      }
    });
  },

  update(caps: Caps, dt: number, t: number): void {
    // Sparks orbit the gate for a while, then go out.
    for (const s of caps.world.query('spark')) {
      const tr = s.getTransform();
      const age = t - sparkBirth.get(s.id, t);
      if (age > 6) { caps.world.destroy(s); continue; }
      const a = t * 1.8 + s.id;
      const r = 4.2 - age * 0.25;
      s.setTransform({
        position: [
          GATE_POS[0] + Math.cos(a) * r,
          gateY + Math.sin(t * 2.3 + s.id) * 1.2,
          GATE_POS[2] + Math.sin(a) * r,
        ],
        rotation: tr.rotation,
        scale: tr.scale,
      });
    }

    // The gate itself turns slowly, breathing: world-Y spin composed over
    // the quarter-X tilt that stands the ring vertical.
    const g = caps.world.find('gate');
    if (g) {
      const tr = g.getTransform();
      g.setTransform({
        ...tr,
        rotation: gateQuat(t),
      });
    }

    // Resonance: the level the attunement script publishes. Collection
    // alone never opens it — only the sixth threshold.
    const level = (caps.world.state('attune:level') as number | undefined) ?? 0;
    const opened = (caps.world.state('gate:opened') as number | undefined) ?? 0;
    if (level >= 6 && !opened) {
      caps.world.setState('gate:opened', 1);
      // The gate answers: a ring of light, a chord, and the way through.
      // Root frequency of the chord: 174.6 Hz — see GATE_ROOT_FREQ in
      // shared.ts; the V8 conductor resolves its resonance lattice on it.
      caps.world.spawn('gate-ring', {
        position: [GATE_POS[0], gateY, GATE_POS[2]],
        tag: 'gate', body: RING_BODY,
      });
      caps.world.spawn('gate-portal', {
        position: [GATE_POS[0], gateY, GATE_POS[2] + 0.5],
        tag: 'portal',
        rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
        body: {
          geometry: { kind: 'torus', radius: 2.2, tube: 0.28, detail: 24 },
          material: {
            baseColor: [0.5, 0.95, 1.0] as [number, number, number],
            effects: ['pulse'] as Array<'pulse'>,
            unlit: true,
          },
        },
        portal: {
          targetZone: 'foundry',
          targetSpawn: [0, 2, 30],
          radius: 3.5,
          label: 'The Gate -> The Foundry',
        },
      });
      caps.audio.notes([
        { t: 0, dur: 3, freq: 174.6, kind: 'tone', gain: 0.5 },
        { t: 0.15, dur: 3, freq: 261.6, kind: 'tone', gain: 0.5 },
        { t: 0.3, dur: 3, freq: 349.2, kind: 'tone', gain: 0.5 },
        { t: 0.45, dur: 3.5, freq: 523.3, kind: 'tone', gain: 0.55 },
      ]);
      caps.events.emit('gate:opened', {});
    }
    void dt;
  },
};

/** The gate's ground-relative height, resolved at start() via the probe. */
let gateY = GATE_POS[1];

/** Spark birth times (engine-side of the script wall would be nicer; the
 *  map keyed by entity id is the script's own memory — plain and local). */
const sparkBirth = {
  m: new Map<number, number>(),
  get(id: number, t: number): number {
    let b = this.m.get(id);
    if (b === undefined) { b = t; this.m.set(id, t); }
    return b;
  },
};

/**
 * Gate orientation: the ring stands vertical (quarter turn about X),
 * slowly revolving about world Y. q = qY(t*0.25) * qX(PI/2), expanded.
 */
function gateQuat(t: number): [number, number, number, number] {
  const s = Math.SQRT1_2;
  const h = (t * 0.25) / 2;
  const ch = Math.cos(h), sh = Math.sin(h);
  return [s * ch, s * sh, 0, s * ch];
}
