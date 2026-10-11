// games/first-light/scripts/player.ts — the first-person walker.
//
// Perception-tier grants only: no field.write. The player reads the wind,
// never rewrites it. Movement: wish direction latched from host input
// events, speed from the live presence domain, ground from the probe.
// In the stillwater band, walking nearly stops — the only way across is the
// gust ride (see shared.stillwaterRide): move WITH the local wind while a
// gust front passes.

import type { Caps, CapabilityName, ScriptDef, SpawnBody } from '../../../src/script/index.js';
import {
  BAND, PLAYER_SPAWN, gustFront, stillwaterRide,
} from '../shared.js';

export const PLAYER_GRANTS: CapabilityName[] = [
  'rng', 'time', 'world.spawn', 'world.query', 'world.state',
  'events', 'audio', 'log', 'field.read', 'probe',
];

const WORLD_MIN_X = -210, WORLD_MAX_X = 210;
const WORLD_MIN_Z = -70, WORLD_MAX_Z = 300;

function inBand(x: number, z: number): boolean {
  return x > BAND.x0 && x < BAND.x1 && z > BAND.z0 && z < BAND.z1;
}

export const playerScript: ScriptDef = {
  name: 'fl:player',

  start(caps: Caps): void {
    // Transform-only: first person has no visible body. The host finds the
    // player by name to seat the camera.
    caps.world.spawn('player', { position: [...PLAYER_SPAWN], tag: 'player' });
    caps.world.setState('input:wish', [0, 0]);
    caps.world.setState('player:vel', [0, 0, 0]);
    caps.world.setState('player:pos', [...PLAYER_SPAWN]);
    caps.world.setState('player:stride', 0);
    caps.events.on('input:move', (data) => {
      const d = data as { x?: unknown; z?: unknown };
      const x = typeof d.x === 'number' ? d.x : 0;
      const z = typeof d.z === 'number' ? d.z : 0;
      caps.world.setState('input:wish', [x, z]);
    });
  },

  update(caps: Caps, dt: number, t: number): void {
    const h = caps.world.find('player');
    if (!h) return;
    const tr = h.getTransform();
    const wish = (caps.world.state('input:wish') ?? [0, 0]) as [number, number];
    const params = caps.field.params() as {
      presence: { moveSpeed: number };
    };
    const speed = params.presence.moveSpeed;

    let vx = wish[0] * speed;
    let vz = wish[1] * speed;
    const x = tr.position[0], z = tr.position[2];

    if (inBand(x, z)) {
      // Stillwater: walking nearly stops; a base current pushes back toward
      // the near shore. The gust ride is the only way across.
      vx *= 0.12;
      vz *= 0.12;
      vz -= 2.2;
      const w = caps.field.wind([x, tr.position[1], z], t);
      const [rx, rz] = stillwaterRide(wish[0], wish[1], w[0], w[2], gustFront(t));
      vx += rx;
      vz += rz;
    }

    let nx = x + vx * dt;
    let nz = z + vz * dt;
    nx = Math.max(WORLD_MIN_X, Math.min(WORLD_MAX_X, nx));
    nz = Math.max(WORLD_MIN_Z, Math.min(WORLD_MAX_Z, nz));
    const ground = caps.probe.ground(nx, nz);
    h.setTransform({
      position: [nx, ground + 1.7, nz],
      rotation: tr.rotation,
      scale: tr.scale,
    });

    // Publish embodied state for the attunement script and the host's wake
    // feed. Stride accumulates distance: the learned rhythm phase.
    const stepLen = Math.hypot(vx * dt, vz * dt);
    const stride = ((caps.world.state('player:stride') as number | undefined) ?? 0) + stepLen;
    caps.world.setState('player:vel', [vx, vz, Math.hypot(vx, vz)]);
    caps.world.setState('player:pos', [nx, ground + 1.7, nz]);
    caps.world.setState('player:stride', stride);
    void t;
  },
};
