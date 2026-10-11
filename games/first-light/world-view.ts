// games/first-light/world-view.ts — host-side scene construction.
//
// The game is written as an external developer would write it: this module
// is the HOST side (it owns the renderer and the scene graph), built only
// on the engine's public surface (src/index.js + src/world/index.js). It
// never reaches into script internals; scripts never reach into it.

import {
  SceneNode, Mesh, buildMaterial, skyDome, torus,
  type Geometry,
} from '../../src/index.js';
import { ComposedWorld, type Zone } from '../../src/world/index.js';
import { BAND } from './shared.js';

/** Biome base colors, per zone id. */
const BIOME_COLORS: Record<string, [number, number, number]> = {
  'ember-reach': [0.3, 0.13, 0.09],
  'mote-hollow': [0.13, 0.23, 0.15],
  'shimmer-flats': [0.33, 0.36, 0.4],
  'foundry': [0.11, 0.11, 0.15],
};

/** Cheap hue rotation of an RGB triple (radians around the gray axis). */
function hueRotate([r, g, b]: [number, number, number], a: number): [number, number, number] {
  const c = Math.cos(a), s = Math.sin(a);
  // Rodrigues rotation about (1,1,1)/sqrt(3).
  const m = [
    [c + (1 - c) / 3, (1 - c) / 3 - s / Math.sqrt(3), (1 - c) / 3 + s / Math.sqrt(3)],
    [(1 - c) / 3 + s / Math.sqrt(3), c + (1 - c) / 3, (1 - c) / 3 - s / Math.sqrt(3)],
    [(1 - c) / 3 - s / Math.sqrt(3), (1 - c) / 3 + s / Math.sqrt(3), c + (1 - c) / 3],
  ];
  const v: [number, number, number] = [
    m[0][0] * r + m[0][1] * g + m[0][2] * b,
    m[1][0] * r + m[1][1] * g + m[1][2] * b,
    m[2][0] * r + m[2][1] * g + m[2][2] * b,
  ];
  return [Math.max(0, Math.min(1, v[0])), Math.max(0, Math.min(1, v[1])), Math.max(0, Math.min(1, v[2]))];
}

export interface ZoneView {
  zone: Zone;
  node: SceneNode;
  mesh: Mesh;
}

/** Build the visible terrain + sky-side dressing for every loaded zone. */
export function buildZoneViews(world: ComposedWorld, root: SceneNode, t: number): ZoneView[] {
  const views: ZoneView[] = [];
  const fp = world.field.snapshot();
  for (const zid of world.zoneIds) {
    const zone = world.getZone(zid)!;
    const geo: Geometry = zone.buildTerrain(t);
    const base = BIOME_COLORS[zid] ?? [0.2, 0.2, 0.2];
    const color = hueRotate(base, fp.biome.paletteShift * Math.PI * 2);
    const node = new SceneNode(`terrain:${zid}`);
    // Zone terrain sits at its placement offset.
    const o = zone.descriptor.placement.offset;
    node.setPosition(o[0], 0, o[2]);
    const mesh = new Mesh(
      geo,
      buildMaterial({
        baseColor: color,
        effects: ['heightRamp', 'noise'],
        generatedBy: 'TypeScript',
      }),
    );
    node.addComponent(mesh);
    root.addChild(node);
    views.push({ zone, node, mesh });
  }

  // One sky dome follows the camera (host-owned, like the demo).
  const sky = new SceneNode('sky');
  sky.addComponent(new Mesh(
    skyDome(600, 'TypeScript'),
    buildMaterial({ baseColor: [0, 0, 0], effects: ['sky'], generatedBy: 'TypeScript', unlit: true }),
  ));
  root.addChild(sky);

  // The stillwater band: a dark plane over mote-hollow's crossing — still
  // black water, in plain sight from the first minute.
  const band = new SceneNode('stillwater');
  const w = BAND.x1 - BAND.x0, d = BAND.z1 - BAND.z0;
  band.addComponent(new Mesh(
    plane(w, d),
    buildMaterial({ baseColor: [0.015, 0.03, 0.05], effects: [], generatedBy: 'TypeScript', unlit: true }),
  ));
  band.setPosition((BAND.x0 + BAND.x1) / 2, 0.55, (BAND.z0 + BAND.z1) / 2);
  root.addChild(band);

  return views;
}

/** Minimal XZ plane (the engine's parametric plane is X-up at y=0). */
function plane(w: number, d: number): Geometry {
  const hw = w / 2, hd = d / 2;
  return {
    positions: new Float32Array([-hw, 0, -hd, hw, 0, -hd, hw, 0, hd, -hw, 0, hd]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    generatedBy: 'TypeScript',
  };
}

/** Give the loader-spawned portal entities visible rings (host-side, the
 *  way the demo dressed its script-spawned ember: find by name, attach). */
export function dressLoaderPortals(root: SceneNode): void {
  const ring = torus(2.6, 0.3, 32, 12, 'TypeScript');
  const mat = buildMaterial({
    baseColor: [0.3, 0.8, 0.9],
    effects: ['fresnel', 'pulse'],
    generatedBy: 'TypeScript',
  });
  root.traverse((n) => {
    if (!n.name.startsWith('portal:')) return;
    if (n.components.some((c) => c instanceof Mesh)) return;
    n.addComponent(new Mesh(ring, mat));
    // Stand the ring vertical like the script-spawned portals.
    n.rotation = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    n.markDirty();
  });
}
