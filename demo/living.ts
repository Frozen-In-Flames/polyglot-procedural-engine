// demo/living.ts - "Living World": the V3 campaign composed, visible.
//
// One seeded world (src/scene/living.ts) does everything on this
// page: the terrain distance field holds XPBD bodies, the interval
// guaranteed march is the camera, the emission ring glows and is
// occluded by the hill, the Wald watcher reads its probes every
// couple of seconds, and the character tick is the heartbeat. The
// render is a CPU march into a 2D canvas at adaptive resolution:
// no new shader stack, just the engine's own composed queries, so
// what you see is exactly what the v3.0.0 suite grades. Controls
// are the V9 unified input rig, same conventions as the V10 demo.
import {
  makeLivingWorld, CameraRig, DesktopScheme, TouchScheme,
  collectCaps, pickScheme, cameraBasis, makeLoop, stepLoop,
  type LivingWorld, type InputScheme, type SchemeId, type Vec3,
  type LoopState,
} from '../src/index.js';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const logEl = document.getElementById('world-log') as HTMLPreElement;
const helpEl = document.getElementById('input-help') as HTMLDivElement;
const btnLight = document.getElementById('btn-light') as HTMLButtonElement;
const btnEmission = document.getElementById('btn-emission') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const policySel = document.getElementById('policy') as HTMLSelectElement;
const schemeSel = document.getElementById('input-scheme') as HTMLSelectElement;

const SEED = 20261022;
const FOV = 1.0;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

// ---------------------------------------------------------------------------
// World + loop
// ---------------------------------------------------------------------------
let world: LivingWorld = makeLivingWorld({ seed: SEED });
let loop: LoopState = makeLoop();
let lightMoved = false;
let emissionOn = true;
let policy: 'interval' | 'terrain' = 'interval';
let watcherText = 'watcher: no reading yet';
let watchCount = 0;

// ---------------------------------------------------------------------------
// Camera: the V9 unified input rig, as in the V10 demo.
// ---------------------------------------------------------------------------
const rig = new CameraRig();
rig.position = [-11.5, 3.6, 4.0];
rig.yaw = -Math.PI / 2;
rig.pitch = -0.04;
const desktopScheme = new DesktopScheme();
const touchScheme = new TouchScheme();
const schemes: Record<string, InputScheme> = { desktop: desktopScheme, touch: touchScheme };
let activeScheme: InputScheme = desktopScheme;

const HINTS: Record<SchemeId, string> = {
  desktop: 'WASD move, mouse look (click scene to lock), drag also looks',
  touch: 'left thumb joystick, right thumb drag to look',
  xr: 'immersive XR is out of scope for this demo build',
};
async function initInput(): Promise<void> {
  try {
    const caps = await collectCaps({
      navigator: navigator as unknown as never,
      matchMedia: window.matchMedia.bind(window),
    } as never);
    const id = pickScheme(caps, 'auto');
    activeScheme = schemes[id] ?? desktopScheme;
    schemeSel.value = id;
    helpEl.textContent = HINTS[id];
  } catch {
    helpEl.textContent = HINTS.desktop;
  }
}
schemeSel.onchange = () => {
  activeScheme = schemes[schemeSel.value] ?? desktopScheme;
  helpEl.textContent = HINTS[schemeSel.value as SchemeId] ?? '';
};
policySel.onchange = () => {
  policy = policySel.value === 'terrain' ? 'terrain' : 'interval';
  setStatus(policy === 'interval'
    ? 'march: interval guaranteed step. Every step is certified against the slope bounds it crosses.'
    : 'march: terrain field policy. Safe steps from the field-wide slope bound.');
};

function camDir(): Vec3 {
  const cp = Math.cos(rig.pitch);
  return [-Math.sin(rig.yaw) * cp, Math.sin(rig.pitch), -Math.cos(rig.yaw) * cp];
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
btnLight.onclick = () => {
  lightMoved = !lightMoved;
  if (lightMoved) {
    world.moveEmission(0.3, 0.15);
    btnLight.textContent = 'Move the light back';
    setStatus('the light moved (0.30, 0.15). The watcher prediction did not. Watch the world state panel.');
  } else {
    world.moveEmission(0, 0);
    btnLight.textContent = 'Move the light';
    setStatus('the light is back at its nominal place. The watcher should go quiet again.');
  }
};
btnEmission.onclick = () => {
  emissionOn = !emissionOn;
  btnEmission.textContent = emissionOn ? 'Emission on' : 'Emission off';
  btnEmission.classList.toggle('active', emissionOn);
  setStatus(emissionOn
    ? 'emission layer on: the ring glows, and the hill occludes it.'
    : 'emission layer off: same world, no glow. The suite pins this difference exactly.');
};
btnReset.onclick = () => {
  world = makeLivingWorld({ seed: SEED });
  loop = makeLoop();
  lightMoved = false;
  btnLight.textContent = 'Move the light';
  watcherText = 'watcher: no reading yet';
  setStatus('world rebuilt from the seed. The bodies are falling again.');
};

// ---------------------------------------------------------------------------
// Render: CPU march of the composed world into an offscreen canvas.
// ---------------------------------------------------------------------------
const off = document.createElement('canvas');
const offCtx = off.getContext('2d') as CanvasRenderingContext2D;
const viewCtx = canvas.getContext('2d') as CanvasRenderingContext2D;
const RES_LEVELS: Array<[number, number]> = [
  [384, 216], [320, 180], [256, 144], [192, 108],
];
let resIdx = 1;
let img: ImageData | null = null;
let renderMs = 0;
let raysLastFrame = 0;

function ensureSize(): void {
  const [w, h] = RES_LEVELS[resIdx];
  if (off.width !== w || off.height !== h) {
    off.width = w;
    off.height = h;
    img = offCtx.createImageData(w, h);
  }
  const cw = window.innerWidth;
  const ch = window.innerHeight;
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
}

function render(): void {
  ensureSize();
  const [W, H] = RES_LEVELS[resIdx];
  if (!img) return;
  const t0 = performance.now();
  const dir = camDir();
  const target: Vec3 = [
    rig.position[0] + dir[0],
    rig.position[1] + dir[1],
    rig.position[2] + dir[2],
  ];
  const basis = cameraBasis({ pos: rig.position, target, fovY: FOV, aspect: W / H });
  const tanF = Math.tan(FOV / 2);
  const aspect = W / H;
  const data = img.data;
  let k = 0;
  for (let y = 0; y < H; y++) {
    const ny = 1 - (2 * (y + 0.5)) / H;
    for (let x = 0; x < W; x++) {
      const nx = (2 * (x + 0.5)) / W - 1;
      const d: Vec3 = [
        basis.fwd[0] + basis.right[0] * nx * tanF * aspect + basis.up[0] * ny * tanF,
        basis.fwd[1] + basis.right[1] * nx * tanF * aspect + basis.up[1] * ny * tanF,
        basis.fwd[2] + basis.right[2] * nx * tanF * aspect + basis.up[2] * ny * tanF,
      ];
      const dl = Math.hypot(d[0], d[1], d[2]) || 1;
      const view = world.march(
        rig.position,
        [d[0] / dl, d[1] / dl, d[2] / dl],
        {
          policy,
          emission: emissionOn,
          emissionStepsPerMinor: 3,
          emissionMaxSamples: 64,
        },
      );
      for (let c = 0; c < 3; c++) {
        const v = view.color[c];
        data[k++] = Math.round(255 * (v / (1 + v)));
      }
      data[k++] = 255;
    }
  }
  raysLastFrame = W * H;
  offCtx.putImageData(img, 0, 0);
  viewCtx.imageSmoothingEnabled = false;
  viewCtx.drawImage(off, 0, 0, canvas.width, canvas.height);
  renderMs = performance.now() - t0;
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
let frameNo = 0;
let slowFrames = 0;
function hud(): void {
  const [W, H] = RES_LEVELS[resIdx];
  const lines = [
    `tick ${world.tick} (heartbeat 60 Hz)`,
    `bodies settled ${world.settledCount()}/${world.bodies.length}`,
    `character ${world.character.grounded ? 'grounded' : 'airborne'} on the plaza`,
    `light ${lightMoved ? 'MOVED (+0.30, +0.15)' : 'nominal'}`,
    watcherText,
    `digest ${world.digest()}`,
    `render ${W}x${H}, ${raysLastFrame} rays, ${renderMs.toFixed(0)} ms`,
    'demo render uses reduced emission quadrature;',
    'the suite grades the full policy.',
  ];
  logEl.textContent = lines.join('\n');
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
let last = performance.now();
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  activeScheme.poll(rig, dt);
  stepLoop(loop, dt, () => {
    world.stepTick();
  });
  render();
  frameNo++;
  if (frameNo % 90 === 0) {
    watchCount++;
    const res = world.watch(world.observe(31000 + watchCount));
    watcherText = res.alarm
      ? `watcher: ALARM T=${res.T.toFixed(2)} over ${res.threshold99.toFixed(2)} (change detected)`
      : `watcher: quiet T=${res.T.toFixed(2)} under ${res.threshold99.toFixed(2)}`;
  }
  if (frameNo % 6 === 0) hud();
  // Adaptive resolution: keep the march interactive, never silent
  // about it (the current level is always in the state panel).
  if (renderMs > 70) {
    slowFrames++;
    if (slowFrames >= 20 && resIdx < RES_LEVELS.length - 1) {
      resIdx++;
      slowFrames = 0;
    }
  } else {
    slowFrames = 0;
    if (renderMs < 20 && resIdx > 0 && frameNo % 240 === 0) resIdx--;
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Input event wiring (DOM adapters; the schemes stay DOM-free)
// ---------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (activeScheme !== desktopScheme) return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
    e.preventDefault();
  }
  desktopScheme.onKeyDown(e.code);
});
window.addEventListener('keyup', (e) => {
  desktopScheme.onKeyUp(e.code);
});
window.addEventListener('blur', () => desktopScheme.clearKeys());
canvas.addEventListener('click', () => {
  if (activeScheme === desktopScheme && !desktopScheme.pointerLocked) {
    canvas.requestPointerLock?.();
  }
});
document.addEventListener('pointerlockchange', () => {
  desktopScheme.setPointerLocked(document.pointerLockElement === canvas);
});
let dragging = false, lx = 0, ly = 0;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true; lx = e.clientX; ly = e.clientY;
});
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => {
  if (activeScheme !== desktopScheme) return;
  if (desktopScheme.pointerLocked) {
    desktopScheme.onMouseDelta(e.movementX, e.movementY);
  } else if (dragging) {
    desktopScheme.onMouseDelta(e.clientX - lx, e.clientY - ly);
    lx = e.clientX; ly = e.clientY;
  }
});
canvas.addEventListener('wheel', (e) => {
  rig.addZoom(e.deltaY * 0.02);
}, { passive: true });
canvas.addEventListener('touchstart', (e) => {
  if (activeScheme !== touchScheme) return;
  e.preventDefault();
  for (const t of Array.from(e.changedTouches)) {
    touchScheme.onTouchStart(t.identifier, t.clientX, t.clientY, window.innerWidth);
  }
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  if (activeScheme !== touchScheme) return;
  e.preventDefault();
  for (const t of Array.from(e.changedTouches)) {
    touchScheme.onTouchMove(t.identifier, t.clientX, t.clientY);
  }
}, { passive: false });
const endTouch = (e: TouchEvent) => {
  for (const t of Array.from(e.changedTouches)) touchScheme.onTouchEnd(t.identifier);
};
canvas.addEventListener('touchend', endTouch);
canvas.addEventListener('touchcancel', endTouch);

initInput().finally(() => {
  setStatus('ready: the bodies settle in the first seconds. Then move the light and watch the watcher.');
  frame();
});
