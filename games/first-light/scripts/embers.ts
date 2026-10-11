// games/first-light/scripts/embers.ts — the scattered embers.
//
// Nine embers drift on the shared wind (advected through caps.field.wind,
// so ember currents ARE the wind's visible texture), bob on the live tempo
// domain, and lean along the local wind. Walk into one to pick it up; carry
// it to the dark gate to deliver it. In the stillwater band, embers surge
// with the gust front — the crossing reads in their motion before the body
// ever attempts it.

import type { Caps, CapabilityName, ScriptDef, SpawnBody } from '../../../src/script/index.js';
import { BAND, EMBER_SPAWNS, GATE_POS, gustFront } from '../shared.js';

export const EMBER_GRANTS: CapabilityName[] = [
  'rng', 'time', 'world.spawn', 'world.query', 'world.state',
  'events', 'audio', 'log', 'field.read', 'probe',
];

const EMBER_BODY: SpawnBody = {
  geometry: { kind: 'sphere', radius: 0.32, detail: 10 },
  material: {
    baseColor: [1.0, 0.45, 0.12] as [number, number, number],
    effects: ['pulse'] as Array<'pulse'>,
    unlit: true,
  },
};

function inBand(x: number, z: number): boolean {
  return x > BAND.x0 && x < BAND.x1 && z > BAND.z0 && z < BAND.z1;
}

export const embersScript: ScriptDef = {
  name: 'fl:embers',

  start(caps: Caps): void {
    for (let i = 0; i < EMBER_SPAWNS.length; i++) {
      const s = EMBER_SPAWNS[i];
      caps.world.spawn(`ember:${i}`, {
        position: [s[0], s[1], s[2]],
        tag: 'ember',
        body: EMBER_BODY,
      });
    }
    caps.world.setState('embers:delivered', 0);
    caps.world.setState('embers:phase', 0);
  },

  update(caps: Caps, dt: number, t: number): void {
    const player = caps.world.find('player');
    const ppos = player ? player.getTransform().position : null;
    const params = caps.field.params() as {
      biome: { emberDrift: number };
      tempo: { beatPeriod: number };
    };
    const drift = params.biome.emberDrift;
    const beat = params.tempo.beatPeriod;
    const front = gustFront(t);

    const free = caps.world.query('ember');
    const carried = caps.world.query('ember-carried');
    let delivered = (caps.world.state('embers:delivered') as number | undefined) ?? 0;

    // Free embers: advect on the wind, bob on the tempo, lean with the air.
    for (const e of free) {
      const tr = e.getTransform();
      const [x, y, z] = tr.position;
      const w = caps.field.wind([x, y, z], t);
      let nx = x + w[0] * drift * dt * 0.9;
      let nz = z + w[2] * drift * dt * 0.9;
      if (inBand(x, z)) {
        // The front surges through the stillwater: embers stream across,
        // showing the crossing before the player attempts it.
        nz += front * 8 * dt;
      }
      const ground = caps.probe.ground(nx, nz);
      const phase = (e.id * 2.399) % (Math.PI * 2);
      // Hover: embers ride the air at a hand's height above the ground,
      // bobbing on the world's tempo, lifted slightly by the wind's breath.
      const ny = ground + 1.2
        + Math.sin((2 * Math.PI * t) / beat + phase) * 0.45
        + Math.max(-0.5, Math.min(0.5, w[1] * drift * 0.25));
      // Lean: stretch along the horizontal wind.
      const wm = Math.hypot(w[0], w[2]);
      const lean = wm > 1e-6 ? Math.min(0.45, wm * 0.12) : 0;
      const dx = wm > 1e-6 ? w[0] / wm : 1;
      const dz = wm > 1e-6 ? w[2] / wm : 0;
      e.setTransform({
        position: [nx, ny, nz],
        rotation: tr.rotation,
        scale: [1 + lean * Math.abs(dx), 1 - lean * 0.4, 1 + lean * Math.abs(dz)],
      });

      // Pickup.
      if (ppos) {
        const d = Math.hypot(ppos[0] - nx, ppos[2] - nz);
        if (d < 2.4) {
          e.setTag('ember-carried');
          caps.audio.note({ t: 0, dur: 0.5, freq: 660, kind: 'tone', gain: 0.35 });
          caps.events.emit('ember:picked', { ember: e.name });
        }
      }
    }

    // Carried embers orbit the player.
    if (ppos) {
      let i = 0;
      for (const e of carried) {
        const a = t * 1.4 + i * 2.1;
        e.setTransform({
          position: [
            ppos[0] + Math.cos(a) * 1.5,
            ppos[1] + 0.4 + Math.sin(t * 2 + i) * 0.25,
            ppos[2] + Math.sin(a) * 1.5,
          ],
          rotation: [0, 0, 0, 1],
          scale: [0.8, 0.8, 0.8],
        });
        // Delivery at the dark gate.
        const d = Math.hypot(ppos[0] - GATE_POS[0], ppos[2] - GATE_POS[2]);
        if (d < 5) {
          caps.world.destroy(e);
          delivered += 1;
          caps.world.setState('embers:delivered', delivered);
          caps.audio.note({
            t: 0, dur: 1.4,
            freq: 220 * Math.pow(2, delivered / 12),
            kind: 'tone', gain: 0.5,
          });
          caps.events.emit('ember:delivered', { count: delivered });
        }
        i++;
      }
    }
    void dt;
  },
};
