// games/first-light/main.ts — FIRST LIGHT, the game host.
//
// Written as an external developer would write it: the host owns the
// renderer, the scene graph, input, and HUD chrome, and touches ONLY the
// engine's public surface (src/index.js, src/world/index.js, src/script).
// All game LOGIC lives in scripts/ behind the capability wall. The host
// never reads script state directly — scripts publish through the event
// bus, which the host taps via RuntimeOptions.onEvent.
//
// Design law honored here:
// - Perception phase: NO attunement UI, no numbers, no hints. One fading
//   controls line, nothing more.
// - Foundry phase: levers are labeled with their language signatures and
//   show live values — authorship is explicit work with real controls.
// - The wind is never visualized: embers lean, motes cluster, shimmer
//   shifts. The host draws the world, never the math.

import {
  SceneNode, Mesh, Light, Camera,
  Renderer, InlineProvider,
  buildMaterial, skyDome,
  fromAxisAngle, quatMultiply,
  ScriptRuntime, SceneEntityBackend,
  type FrameCallback, type RenderView, type JSONValue, type ScriptDef,
} from '../../src/index.js';
import { ComposedWorld, GlobalField } from '../../src/world/index.js';
import { FIRST_LIGHT_ZONES_JSON } from './zones.js';
import { buildZoneViews, dressLoaderPortals, type ZoneView } from './world-view.js';
import { playerScript, PLAYER_GRANTS } from './scripts/player.js';
import { embersScript, EMBER_GRANTS } from './scripts/embers.js';
import { motesScript, MOTE_GRANTS } from './scripts/motes.js';
import { attunementScript, ATTUNE_GRANTS } from './scripts/attunement.js';
import { gateScript, GATE_GRANTS } from './scripts/gate.js';
import { secretScript, SECRET_GRANTS } from './scripts/secret.js';
import { foundryScript, FOUNDRY_GRANTS } from './scripts/foundry.js';
import { leverScripts, leverGrants } from './scripts/levers.js';
import { GAME_SEED, LEVER_POS, LEVER_SPECS } from './shared.js';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const titleEl = document.getElementById('title') as HTMLDivElement;
const hintEl = document.getElementById('hint') as HTMLDivElement;
const captionEl = document.getElementById('caption') as HTMLDivElement;
const foundryEl = document.getElementById('foundry') as HTMLDivElement;
const leverListEl = document.getElementById('lever-list') as HTMLUListElement;
const btnAudio = document.getElementById('btn-audio') as HTMLButtonElement;

// Error surface for headless verification (and honest failure in general).
const errors: string[] = [];
(window as unknown as { __flErrors: string[] }).__flErrors = errors;
window.addEventListener('error', (e) => errors.push('error: ' + e.message));
window.addEventListener('unhandledrejection', (e) =>
  errors.push('rejection: ' + String((e as PromiseRejectionEvent).reason)));

/** Tiny one-way note bus: scripts compose, the host plays. */
class NoteBus {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  enabled = false;
  ensure(): void {
    if (!this.ctx) {
      const AC = window.AudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.4;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }
  play(notes: Array<{ t: number; dur: number; freq: number; kind: string; gain: number }>): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime;
    for (const n of notes) {
      try {
        const o = this.ctx.createOscillator();
        o.type = n.kind === 'noise' ? 'sawtooth' : 'sine';
        o.frequency.value = Math.max(20, Math.min(8000, n.freq));
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0 + n.t);
        g.gain.linearRampToValueAtTime(Math.max(0.0001, n.gain * 0.5), t0 + n.t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.t + Math.max(0.05, n.dur));
        o.connect(g); g.connect(this.master);
        o.start(t0 + n.t); o.stop(t0 + n.t + Math.max(0.05, n.dur) + 0.05);
      } catch { /* a bad note never breaks the frame */ }
    }
  }
}

async function main(): Promise<void> {
  const root = new SceneNode('root');
  const field = new GlobalField(undefined, GAME_SEED);

  // Host tap on the script event bus: progression, captions, lever UI.
  const leverLoaded = new Array<boolean>(leverScripts.length).fill(false);
  // Which lever the player currently holds (mirrored from the scripts'
  // lever:grabbed / lever:released events for adjust-key routing).
  let holdingLever = -1;
  const onEvent = (event: string, data: JSONValue): void => {
    if (event === 'attune:level') {
      const level = (data as { level?: unknown }).level;
      if (typeof level === 'number') {
        for (let i = 0; i < level && i < leverScripts.length; i++) {
          if (!leverLoaded[i]) {
            leverLoaded[i] = true;
            scripts.load(leverScripts[i], { grants: leverGrants(i) });
          }
        }
      }
    } else if (event === 'gate:opened') {
      showCaption('the gate is open');
    } else if (event === 'lever:moved') {
      const d = data as { index?: unknown; value?: unknown };
      renderLeverList(
        typeof d.index === 'number' ? d.index : -1,
        typeof d.value === 'number' ? d.value : NaN,
      );
    } else if (event === 'lever:grabbed') {
      const d = data as { index?: unknown };
      if (typeof d.index === 'number') {
        holdingLever = d.index;
        renderLeverList(d.index, NaN);
      }
    } else if (event === 'lever:released') {
      holdingLever = -1;
      renderLeverList(-1, NaN);
    }
  };

  // Ground probe: the composed world's heightfields, for the walker.
  const groundAt = (x: number, z: number): number => {
    let best = 0;
    let found = false;
    for (const zid of world.zoneIds) {
      const zone = world.getZone(zid)!;
      const d = zone.descriptor;
      const lx = x - d.placement.offset[0];
      const lz = z - d.placement.offset[2];
      const half = d.terrain.size / 2;
      if (Math.abs(lx) > half || Math.abs(lz) > half) continue;
      const fp = field.snapshot();
      const h = zone.heightSampler()(lx, lz)
        * d.terrain.height * fp.scene.terrainHeight;
      if (!found || h > best) { best = h; found = true; }
    }
    return found ? best : 0;
  };

  const scripts = new ScriptRuntime(GAME_SEED, new SceneEntityBackend(root), {
    field,
    probe: groundAt,
    onEvent,
    onError: (name, err) => errors.push(`script ${name}: ${String(err)}`),
  });
  const world = new ComposedWorld(field, scripts);
  world.loadZones(FIRST_LIGHT_ZONES_JSON);

  // ---- Scene ----
  const zoneViews: ZoneView[] = buildZoneViews(world, root, 0);
  dressLoaderPortals(root);

  const sun = new SceneNode('sun').setPosition(-60, 80, 40);
  const sunLight = new Light('directional');
  sunLight.color = [1.0, 0.9, 0.78];
  sunLight.intensity = 1.15;
  sun.addComponent(sunLight);
  // Aim the sun: the renderer reads the light's travel direction from the
  // node's +Z axis. Light should rake across the camera-facing slopes
  // (down, forward, slightly from the left) so the terrain reads in
  // diffuse, not just the specular glint.
  {
    const d: [number, number, number] = [-0.35, -0.8, -0.5];
    const il = 1 / Math.hypot(d[0], d[1], d[2]);
    const dn: [number, number, number] = [d[0] * il, d[1] * il, d[2] * il];
    // Rotate +Z onto dn: axis = Z x dn, angle = acos(dn.z).
    const ax: [number, number, number] = [-dn[1], dn[0], 0];
    const al = Math.hypot(ax[0], ax[1]) || 1;
    sun.rotation = fromAxisAngle(
      [ax[0] / al, ax[1] / al, 0],
      Math.acos(Math.max(-1, Math.min(1, dn[2]))),
    );
    sun.markDirty();
  }
  root.addChild(sun);

  const camNode = new SceneNode('camera').setPosition(-140, 4, -16);
  const camera = new Camera(16 / 9);
  camNode.addComponent(camera);
  root.addChild(camNode);

  // ---- Game scripts (perception tier; levers load progressively) ----
  scripts.load(playerScript, { grants: PLAYER_GRANTS });
  scripts.load(embersScript, { grants: EMBER_GRANTS });
  scripts.load(motesScript, { grants: MOTE_GRANTS });
  scripts.load(attunementScript, { grants: ATTUNE_GRANTS });
  scripts.load(gateScript, { grants: GATE_GRANTS });
  scripts.load(secretScript, { grants: SECRET_GRANTS });
  scripts.load(foundryScript, { grants: FOUNDRY_GRANTS });

  // ---- Renderer ----
  const renderer = new Renderer(canvas);
  const notes = new NoteBus();
  const onResize = () => renderer.resize(canvas.clientWidth, canvas.clientHeight);
  window.addEventListener('resize', onResize);
  onResize();

  // ---- Input ----
  const keys = new Set<string>();
  let yaw = 0; // facing -z: the gate stands at z=-40, the player at z=-16.
  let pitch = -0.06;
  let lastWish = '';

  const wishFromKeys = (): [number, number] => {
    const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0)
      - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    let s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    if (holdingLever < 0) {
      s += (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0);
    }
    // Camera space -> world space.
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const wx = fx * f + rx * s;
    const wz = fz * f + rz * s;
    const m = Math.hypot(wx, wz);
    return m > 1 ? [wx / m, wz / m] : [wx, wz];
  };
  const pushWish = (): void => {
    const [x, z] = wishFromKeys();
    const key = `${x.toFixed(3)},${z.toFixed(3)}`;
    if (key !== lastWish) {
      lastWish = key;
      scripts.emit('input:move', { x, z });
    }
  };

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    notes.ensure();
    if (e.code === 'KeyE') {
      scripts.emit('input:interact', {});
    } else if (e.code === 'ArrowLeft' && holdingLever >= 0) {
      scripts.emit('input:adjust', { d: -1 });
      e.preventDefault();
    } else if (e.code === 'ArrowRight' && holdingLever >= 0) {
      scripts.emit('input:adjust', { d: 1 });
      e.preventDefault();
    } else if (e.code.startsWith('Arrow')) {
      e.preventDefault();
    }
    pushWish();
  });
  window.addEventListener('keyup', (e) => {
    keys.delete(e.code);
    pushWish();
  });

  // Drag to look.
  let dragging = false, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; lx = e.clientX; ly = e.clientY;
    notes.ensure();
  });
  window.addEventListener('pointerup', () => { dragging = false; });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    yaw -= (e.clientX - lx) * 0.004;
    pitch = Math.max(-1.1, Math.min(0.7, pitch - (e.clientY - ly) * 0.004));
    lx = e.clientX; ly = e.clientY;
    pushWish();
  });

  btnAudio.onclick = () => {
    notes.ensure();
    notes.enabled = !notes.enabled;
    btnAudio.textContent = notes.enabled ? 'Sound off' : 'Sound on';
  };

  // ---- HUD helpers ----
  let captionTimer = 0;
  function showCaption(text: string): void {
    captionEl.textContent = text;
    captionEl.style.opacity = '1';
    captionTimer = 4;
  }
  function renderLeverList(active: number, value: number): void {
    leverListEl.innerHTML = '';
    for (let i = 0; i < LEVER_SPECS.length; i++) {
      const li = document.createElement('li');
      const awake = leverLoaded[i];
      const spec = LEVER_SPECS[i];
      let val = 'dormant';
      if (awake) {
        // Live values arrive on the lever:moved event; otherwise 'awake'.
        val = i === active && !Number.isNaN(value) ? value.toFixed(2) : 'awake';
      }
      li.textContent = `${awake ? '●' : '○'} ${spec.label} · ${val}`;
      li.className = !awake ? 'dormant' : i === active ? 'active' : '';
      leverListEl.append(li);
    }
  }

  // ---- Frame loop ----
  const inline = new InlineProvider(camNode, camera);
  let playerId = -1;
  let lastRevision = field.revision;
  let lastT = performance.now();
  let strideAcc = 0;
  let lastPlayerPos: [number, number, number] | null = null;
  let hintTimer = 12;

  const findPlayer = (): void => {
    if (playerId >= 0) return;
    const e = scripts.hostEntities().find((x) => x.name === 'player');
    if (e) playerId = e.id;
  };

  const frame: FrameCallback = (views: RenderView[], t: number) => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    findPlayer();

    scripts.update(dt, t);
    const crossings = world.update(dt, t);
    for (const c of crossings) {
      if (c.entityName === 'player') {
        const zone = world.getZone(c.toZone);
        showCaption(zone ? zone.descriptor.displayName : c.toZone);
      }
    }

    // Camera: first person at the player's eye.
    if (playerId >= 0) {
      const tf = scripts.hostGetTransform(playerId);
      if (tf) {
        const [px, py, pz] = tf.position;
        camNode.setPosition(px, py, pz);
        const yq = fromAxisAngle([0, 1, 0], yaw);
        const pq = fromAxisAngle([1, 0, 0], pitch);
        camNode.rotation = quatMultiply(yq, pq);
        camNode.markDirty();

        // The 7th lever: feed embodied state into the field. The world
        // answers the body — in the foundry this is legible as the motes
        // stirring around a moving player.
        if (lastPlayerPos) {
          const dx = px - lastPlayerPos[0];
          const dz = pz - lastPlayerPos[2];
          const stepLen = Math.hypot(dx, dz);
          const speed = dt > 0 ? stepLen / dt : 0;
          strideAcc += stepLen;
          field.setPlayerState({
            position: [px, py, pz],
            speed,
            rhythm: (strideAcc / 2.2) % 1,
          });
        }
        lastPlayerPos = [px, py, pz];

        // Sky follows the camera; sun follows the light domain.
        root.traverse((n) => {
          if (n.name === 'sky') n.setPosition(px, 0, pz);
        });
        const lp = field.snapshot().light;
        sunLight.intensity = 0.55 + 0.9 * lp.exposure * (0.5 + 0.5 * Math.sin(lp.timeOfDay * Math.PI));
        sunLight.color = [
          1.0,
          0.72 + 0.22 * Math.sin(lp.timeOfDay * Math.PI),
          0.5 + 0.4 * Math.sin(lp.timeOfDay * Math.PI),
        ];

        // Foundry proximity UI: authorship phase shows real controls.
        updateFoundryUI(px, pz);
      }
    }

    // Downstream re-derivation made visible: when a lever moves a domain,
    // the terrain re-bakes from the new math.
    if (field.revision !== lastRevision) {
      lastRevision = field.revision;
      for (const zv of zoneViews) {
        zv.mesh.geometry = zv.zone.buildTerrain(t);
      }
    }

    // Audio: drain what the scripts composed.
    notes.play(scripts.drainAudio());

    root.updateWorldMatrix(null);
    root.update(dt, t);
    renderer.render(root, camera, camNode, views, t);

    if (captionTimer > 0) {
      captionTimer -= dt;
      if (captionTimer <= 0) captionEl.style.opacity = '0';
    }
    if (hintTimer > 0) {
      hintTimer -= dt;
      if (hintTimer <= 0) hintEl.style.opacity = '0';
    }
  };

  /** Show the foundry panel near awake levers; hide it elsewhere. */
  function updateFoundryUI(px: number, pz: number): void {
    let near = -1;
    let best = 6;
    for (let i = 0; i < LEVER_POS.length; i++) {
      if (!leverLoaded[i]) continue;
      const d = Math.hypot(px - LEVER_POS[i][0], pz - LEVER_POS[i][2]);
      if (d < best) { best = d; near = i; }
    }
    if (near >= 0) {
      foundryEl.style.display = 'block';
      if (leverListEl.children.length === 0) renderLeverList(-1, NaN);
    } else {
      foundryEl.style.display = 'none';
    }
  }

  const current = await inline.requestSession('inline', canvas);
  current.onFrame(frame);

  // ---- Hash-gated debug hooks (headless verification only; inert in play) ----
  if (location.hash === '#debug') {
    const debugScript: ScriptDef = {
      name: 'fl:debug',
      start(caps) {
        caps.events.on('debug:cmd', (data) => {
          const d = data as { op?: unknown; level?: unknown; x?: unknown; z?: unknown };
          if (d.op === 'set-level' && typeof d.level === 'number') {
            const lv = Math.max(0, Math.min(6, Math.floor(d.level)));
            const thresholds = [0, 12, 28, 44, 60, 74, 88];
            caps.world.setState('attune:score', thresholds[lv]);
            caps.world.setState('attune:level', lv);
            caps.events.emit('attune:level', { level: lv, lang: 'debug' });
          } else if (d.op === 'teleport' && typeof d.x === 'number' && typeof d.z === 'number') {
            const p = caps.world.find('player');
            if (p) {
              const tr = p.getTransform();
              const g = caps.probe.ground(d.x, d.z);
              p.setTransform({ ...tr, position: [d.x, g + 1.7, d.z] });
            }
          }
        });
      },
    };
    scripts.load(debugScript, { grants: ['events', 'world.query', 'world.state', 'probe'] });
    (window as unknown as { __fl: unknown }).__fl = {
      teleport: (x: number, z: number) => scripts.emit('debug:cmd', { op: 'teleport', x, z }),
      setLevel: (level: number) => scripts.emit('debug:cmd', { op: 'set-level', level }),
      look: (y: number, p: number) => { yaw = y; pitch = p; pushWish(); },
      scene: () => {
        const out: Record<string, unknown> = {};
        const e = scripts.hostEntities().find((x) => x.name === 'player');
        const tf = e ? scripts.hostGetTransform(e.id) : null;
        out.player = tf ? [...tf.position] : null;
        out.camera = [...camNode.position];
        out.terrainNodes = zoneViews.map((zv) => ({
          zone: zv.zone.descriptor.id,
          pos: [...zv.node.position],
          worldY: zv.node.worldMatrix[13],
        }));
        out.revision = field.revision;
        return out;
      },
      pos: () => {
        const e = scripts.hostEntities().find((x) => x.name === 'player');
        const tf = e ? scripts.hostGetTransform(e.id) : null;
        return tf ? [...tf.position] : null;
      },
      errors: () => [...errors],
    };
  }

  // Fade the title; the hint fades on its own timer.
  setTimeout(() => { titleEl.style.opacity = '0.85'; }, 100);
  setStatusReady();
}

function setStatusReady(): void {
  (window as unknown as { __flReady: boolean }).__flReady = true;
}

void main().catch((e) => {
  errors.push('boot: ' + (e as Error).message);
  const el = document.getElementById('err');
  if (el) { el.style.display = 'block'; el.textContent = 'boot failed: ' + (e as Error).message; }
});
