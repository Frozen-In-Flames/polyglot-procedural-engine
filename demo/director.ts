// demo/director.ts - "Director Mode": virtual production on the
// Living World. A take is the seed plus a sparse track sheet of
// events (src/director). This page performs three roles:
//
//   LIVE      the Living World as shipped in v3.0.0: fly the
//             camera, move the light, toggle emission, jump.
//   RECORD    the world is rebuilt from the seed and every tick
//             the live performance (camera, light, emission,
//             action) is sampled into a take. Stop, and the take
//             is data: save it, replay it, share it.
//   REPLAY    the world is rebuilt from the take's seed and the
//             pure evaluator performs the sheet tick by tick.
//             Grabbing the camera, the light, the emission switch
//             or the jump during replay PUNCHES IN: that channel's
//             scripted future is truncated and the live
//             performance is written over it, while the other
//             channels keep playing the script.
//
// The proof is on the panel: the world digest at the end of a
// recording and at the end of its replay are the same string,
// because both runs stepped the same world under the same sheet.
import {
  makeLivingWorld, CameraRig, DesktopScheme, TouchScheme,
  collectCaps, pickScheme, cameraBasis, makeLoop, stepLoop, TICK_DT,
  createRecorder, recorderFromTake, sampleCamera, sampleLight,
  sampleEmission, sampleAction, recordCue, punchIn, finishTake,
  createPlayer, play, advance, serializeTake, parseTakeJson,
  type LivingWorld, type InputScheme, type SchemeId, type Vec3,
  type LoopState, type Recorder, type Player, type Take,
  type DirectorChannel, type DirectorState,
} from '../src/index.js';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const logEl = document.getElementById('world-log') as HTMLPreElement;
const helpEl = document.getElementById('input-help') as HTMLDivElement;
const dirEl = document.getElementById('director-status') as HTMLDivElement;
const btnLight = document.getElementById('btn-light') as HTMLButtonElement;
const btnEmission = document.getElementById('btn-emission') as HTMLButtonElement;
const btnJump = document.getElementById('btn-jump') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const btnRecord = document.getElementById('btn-record') as HTMLButtonElement;
const btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
const btnCue = document.getElementById('btn-cue') as HTMLButtonElement;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
const takeFile = document.getElementById('take-file') as HTMLInputElement;
const policySel = document.getElementById('policy') as HTMLSelectElement;
const schemeSel = document.getElementById('input-scheme') as HTMLSelectElement;

const SEED = 20261022;
const FOV = 1.0;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}
function setDir(msg: string): void {
  dirEl.textContent = msg;
}

// ---------------------------------------------------------------------------
// World + director state
// ---------------------------------------------------------------------------
type Mode = 'live' | 'recording' | 'playing';
let mode: Mode = 'live';
let world: LivingWorld = makeLivingWorld({ seed: SEED });
let loop: LoopState = makeLoop();
let lightOffset: [number, number] = [0, 0];
let emissionOn = true;
let policy: 'interval' | 'terrain' = 'interval';
let watcherText = 'watcher: no reading yet';
let watchCount = 0;
let jumpQueued = false;

let rec: Recorder | null = null;
let take: Take | null = null;
let player: Player | null = null;
let punchRec: Recorder | null = null;
const liveChannels = new Set<DirectorChannel>();
let recordEndDigest: string | null = null;
let lastCueText = '';

function rebuildWorld(seed: number): void {
  world = makeLivingWorld({ seed });
  loop = makeLoop();
  watchCount = 0;
  watcherText = 'watcher: no reading yet';
}

// ---------------------------------------------------------------------------
// Camera: the V9 unified input rig, as in the Living World demo.
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

function rigSnapshot(): { position: Vec3; yaw: number; pitch: number } {
  return {
    position: [rig.position[0], rig.position[1], rig.position[2]],
    yaw: rig.yaw,
    pitch: rig.pitch,
  };
}

// ---------------------------------------------------------------------------
// Punch-in: grab a channel during replay and perform it live.
// ---------------------------------------------------------------------------
function punch(channel: DirectorChannel): void {
  if (mode !== 'playing' || !player || !take || liveChannels.has(channel)) return;
  liveChannels.add(channel);
  if (!punchRec) punchRec = recorderFromTake(take);
  punchIn(punchRec, channel, player.tick);
  setDir(`director: punched in on ${channel} at tick ${player.tick}. ` +
    'Its scripted future is replaced by what you perform now; the other channels keep the script.');
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
btnLight.onclick = () => {
  const moved = lightOffset[0] !== 0 || lightOffset[1] !== 0;
  lightOffset = moved ? [0, 0] : [0.3, 0.15];
  btnLight.textContent = moved ? 'Move the light' : 'Move the light back';
  if (mode === 'playing') {
    punch('light');
    world.moveEmission(lightOffset[0], lightOffset[1]);
  } else {
    world.moveEmission(lightOffset[0], lightOffset[1]);
    setStatus(moved
      ? 'the light is back at its nominal place. The watcher should go quiet again.'
      : 'the light moved (0.30, 0.15). The watcher prediction did not. Watch the world state panel.');
  }
};
btnEmission.onclick = () => {
  emissionOn = !emissionOn;
  btnEmission.textContent = emissionOn ? 'Emission on' : 'Emission off';
  btnEmission.classList.toggle('active', emissionOn);
  if (mode === 'playing') punch('emission');
  else setStatus(emissionOn
    ? 'emission layer on: the ring glows, and the hill occludes it.'
    : 'emission layer off: same world, no glow. The suite pins this difference exactly.');
};
btnJump.onclick = () => {
  if (mode === 'playing') punch('action');
  jumpQueued = true;
};
btnReset.onclick = () => {
  if (mode !== 'live') stopSession();
  rebuildWorld(SEED);
  lightOffset = [0, 0];
  btnLight.textContent = 'Move the light';
  setStatus('world rebuilt from the seed. The bodies are falling again.');
};

function stopSession(): void {
  mode = 'live';
  rec = null;
  player = null;
  punchRec = null;
  liveChannels.clear();
  btnRecord.textContent = '● Record take';
  btnPlay.textContent = '▶ Replay take';
}

btnRecord.onclick = () => {
  if (mode === 'recording' && rec) {
    take = finishTake(rec, world.tick);
    recordEndDigest = world.digest();
    stopSession();
    btnPlay.disabled = false;
    btnSave.disabled = false;
    setDir(`director: take recorded, ${take.events.length} events over ${take.durationTicks} ticks. ` +
      `End digest ${recordEndDigest}. Replay it: the same digest must come back.`);
    return;
  }
  if (mode !== 'live') return;
  rebuildWorld(SEED);
  rec = createRecorder(SEED);
  mode = 'recording';
  btnRecord.textContent = '■ Stop recording';
  setDir('director: recording. Fly the camera, move the light, jump, mark cues. ' +
    'Every tick is sampled into the track sheet.');
};

btnPlay.onclick = () => {
  if (mode === 'playing') { stopSession(); setDir('director: replay stopped.'); return; }
  if (mode !== 'live' || !take) return;
  rebuildWorld(take.seed);
  player = createPlayer(take);
  play(player);
  punchRec = null;
  liveChannels.clear();
  mode = 'playing';
  btnPlay.textContent = '■ Stop replay';
  setDir(`director: replaying ${take.events.length} events over ${take.durationTicks} ticks. ` +
    'Grab the camera, the light, the emission switch or the jump to punch in.');
};

btnCue.onclick = () => {
  if (mode === 'recording' && rec) {
    recordCue(rec, world.tick, 'mark');
    setDir(`director: cue marked at tick ${world.tick}.`);
  } else if (mode === 'playing') {
    setDir('director: cues fire from the sheet during replay; mark new ones while recording.');
  } else {
    setDir('director: cues are marked while recording.');
  }
};

btnSave.onclick = () => {
  if (!take) return;
  const blob = new Blob([serializeTake(take)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ppe-take.json';
  a.click();
  URL.revokeObjectURL(a.href);
};

takeFile.addEventListener('change', async () => {
  const f = takeFile.files?.[0];
  if (!f) return;
  try {
    take = parseTakeJson(await f.text());
    recordEndDigest = null;
    btnPlay.disabled = false;
    btnSave.disabled = false;
    setDir(`director: take loaded, ${take.events.length} events over ${take.durationTicks} ticks, ` +
      `seed ${take.seed}. Replay performs it from a fresh world.`);
  } catch (err) {
    setDir('director: that file is not a valid take: ' + (err as Error).message);
  }
});

// ---------------------------------------------------------------------------
// Cue sound: a short synth blip, created on first use (a click has
// always happened by then, so the AudioContext may start).
// ---------------------------------------------------------------------------
let audioCtx: AudioContext | null = null;
function blip(): void {
  try {
    audioCtx ??= new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.2);
  } catch { /* sound is a courtesy; the cue still lands in the status line */ }
}

// ---------------------------------------------------------------------------
// Render: CPU march of the composed world, as in the Living World.
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
        { policy, emission: emissionOn, emissionStepsPerMinor: 3, emissionMaxSamples: 64 },
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
    `mode ${mode.toUpperCase()} · tick ${world.tick} (heartbeat 60 Hz)`,
    `bodies settled ${world.settledCount()}/${world.bodies.length}`,
    `character ${world.character.grounded ? 'grounded' : 'airborne'} on the plaza`,
    `light ${lightOffset[0] !== 0 || lightOffset[1] !== 0 ? `MOVED (+${lightOffset[0].toFixed(2)}, +${lightOffset[1].toFixed(2)})` : 'nominal'}`,
    watcherText,
    `digest ${world.digest()}`,
    ...(mode === 'playing' && player
      ? [`playhead ${player.tick}/${take?.durationTicks ?? 0}${liveChannels.size ? ` · live: ${[...liveChannels].join(', ')}` : ''}`]
      : []),
    ...(mode === 'recording' && rec
      ? [`events so far ${rec.take.events.length}`]
      : []),
    ...(lastCueText ? [lastCueText] : []),
    `render ${W}x${H}, ${raysLastFrame} rays, ${renderMs.toFixed(0)} ms`,
    'demo render uses reduced emission quadrature;',
    'the suite grades the full policy.',
  ];
  logEl.textContent = lines.join('\n');
}

// ---------------------------------------------------------------------------
// Per-tick direction: what each mode does inside a world tick.
// ---------------------------------------------------------------------------
function tickLive(): void {
  world.stepTick({ move: [0, 0], jumpPressed: jumpQueued, jumpHeld: jumpQueued });
  jumpQueued = false;
}

function tickRecording(): void {
  world.stepTick({ move: [0, 0], jumpPressed: jumpQueued, jumpHeld: jumpQueued });
  if (rec) {
    const t = world.tick;
    sampleCamera(rec, t, rigSnapshot());
    sampleLight(rec, t, { offset: lightOffset });
    sampleEmission(rec, t, { on: emissionOn });
    sampleAction(rec, t, { move: [0, 0], jump: jumpQueued });
  }
  jumpQueued = false;
}

let lastAppliedCamera: DirectorState['camera'] = null;
function tickPlaying(): void {
  if (!player || !take) { tickLive(); return; }
  const before = rigSnapshot();
  const res = advance(player, TICK_DT);
  const st = res.state;
  // Cues: sound + a line in the panel.
  for (const c of res.cues) {
    lastCueText = `cue "${c.cue.name}" fired at tick ${c.tick}`;
    blip();
  }
  // Camera punch-in detection: the scheme poll already ran this
  // frame; if the rig no longer matches what the sheet last
  // applied, the user grabbed it.
  if (!liveChannels.has('camera') && lastAppliedCamera) {
    const moved = Math.abs(before.position[0] - lastAppliedCamera.position[0]) > 1e-3
      || Math.abs(before.position[1] - lastAppliedCamera.position[1]) > 1e-3
      || Math.abs(before.position[2] - lastAppliedCamera.position[2]) > 1e-3
      || Math.abs(before.yaw - lastAppliedCamera.yaw) > 1e-3
      || Math.abs(before.pitch - lastAppliedCamera.pitch) > 1e-3;
    if (moved) punch('camera');
  }
  if (!liveChannels.has('camera') && st.camera) {
    rig.position = [st.camera.position[0], st.camera.position[1], st.camera.position[2]];
    rig.yaw = st.camera.yaw;
    rig.pitch = st.camera.pitch;
    lastAppliedCamera = st.camera;
  }
  if (!liveChannels.has('light')) {
    if (st.light.offset[0] !== lightOffset[0] || st.light.offset[1] !== lightOffset[1]) {
      lightOffset = [st.light.offset[0], st.light.offset[1]];
      world.moveEmission(lightOffset[0], lightOffset[1]);
      btnLight.textContent = lightOffset[0] !== 0 || lightOffset[1] !== 0
        ? 'Move the light back' : 'Move the light';
    }
  }
  if (!liveChannels.has('emission')) {
    emissionOn = st.emission.on;
    btnEmission.textContent = emissionOn ? 'Emission on' : 'Emission off';
    btnEmission.classList.toggle('active', emissionOn);
  }
  // Performed channels are sampled into the punch recorder.
  if (punchRec) {
    const t = player.tick;
    if (liveChannels.has('camera')) sampleCamera(punchRec, t, rigSnapshot());
    if (liveChannels.has('light')) sampleLight(punchRec, t, { offset: lightOffset });
    if (liveChannels.has('emission')) sampleEmission(punchRec, t, { on: emissionOn });
    if (liveChannels.has('action')) {
      sampleAction(punchRec, t, { move: [0, 0], jump: jumpQueued });
    }
  }
  const action = liveChannels.has('action')
    ? { move: [0, 0] as [number, number], jump: jumpQueued }
    : st.action;
  world.stepTick({
    move: action.move,
    jumpPressed: action.jump,
    jumpHeld: action.jump,
  });
  jumpQueued = false;
  if (player.ended) {
    const replayDigest = world.digest();
    if (punchRec && take) {
      take = finishTake(punchRec, take.durationTicks);
      punchRec = null;
      setDir(`director: replay ended with a punch-in performance. The take now carries the new performance ` +
        `(${take.events.length} events). End digest ${replayDigest}. Save it to keep the edit.`);
    } else {
      setDir(recordEndDigest
        ? `director: replay ended. Digest ${replayDigest} ${replayDigest === recordEndDigest
          ? 'MATCHES the recording exactly. Same seed, same sheet, same world.'
          : 'differs from the recording digest: the sheet performed differs from what was recorded.'}`
        : `director: replay ended. Digest ${replayDigest}.`);
    }
    mode = 'live';
    player = null;
    liveChannels.clear();
    btnPlay.textContent = '▶ Replay take';
  }
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
    if (mode === 'recording') tickRecording();
    else if (mode === 'playing') tickPlaying();
    else tickLive();
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
  setStatus('ready: the bodies settle in the first seconds. Record a take of whatever you do next.');
  frame();
});
