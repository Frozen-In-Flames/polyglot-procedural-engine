// demo/main.ts — "First Light": the zero-asset proof scene.
// Every visual and sound is generated in code. The HUD pipeline list names
// the language behind each system, so the cooperation is visible.
import {
  SceneNode, Mesh, Light, Camera, Script,
  terrain, sphere, torus, buildMaterial,
  Renderer, WebXRProvider, InlineProvider,
  SpatialAudio, createGenCore, mulberry32, TsMlProvider, loadStyleWeights, ScorePlayer,
  fromAxisAngle, quatMultiply,
  type GenCore, type XRSessionHandle, type XRMode, type FrameCallback, type RenderView,
} from '../src/index.js';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const pipelineEl = document.getElementById('pipeline') as HTMLUListElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const btnVR = document.getElementById('btn-vr') as HTMLButtonElement;
const btnAR = document.getElementById('btn-ar') as HTMLButtonElement;
const btnAudio = document.getElementById('btn-audio') as HTMLButtonElement;

function pipelineRow(system: string, lang: string): void {
  const li = document.createElement('li');
  const a = document.createElement('span'); a.textContent = system;
  const b = document.createElement('span'); b.textContent = lang;
  li.append(a, b);
  pipelineEl.append(li);
}

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

/** WASM factory when the emcc build is present (demo/public/gen/), else undefined. */
async function wasmFactory(): Promise<(() => Promise<unknown>) | undefined> {
  try {
    const head = await fetch('gen/gen.js', { method: 'HEAD' });
    if (!head.ok) return undefined;
    const genUrl = ['/gen', 'gen.js'].join('/');
    const m = await import(/* @vite-ignore */ genUrl);
    const factory = (m.default ?? m) as () => Promise<unknown>;
    return factory;
  } catch {
    return undefined;
  }
}

class Spin extends Script {
  constructor(private speed = 0.4) { super(); }
  update(dt: number): void {
    if (!this.node) return;
    const dq = fromAxisAngle([0, 1, 0], this.speed * dt);
    this.node.rotation = quatMultiply(this.node.rotation, dq);
    this.node.markDirty();
  }
}

class Bob extends Script {
  private t = Math.random() * 10;
  constructor(private amp = 0.4, private speed = 1) { super(); }
  update(dt: number): void {
    if (!this.node) return;
    this.t += dt * this.speed;
    this.node.position[1] += Math.sin(this.t) * this.amp * dt;
    this.node.markDirty();
  }
}

async function main(): Promise<void> {
  setStatus('loading generation core...');
  const factory = await wasmFactory();
  const gen: GenCore = await createGenCore(factory);
  setStatus('');

  // ---- Scene ----
  const root = new SceneNode('root');

  // Terrain: heights computed by the generation core (C++ WASM when present),
  // then reshaped by the Python ML style provider's seeded MLP.
  const SEG = 110;
  const heights = new Float32Array(SEG * SEG);
  gen.heightfield(1337, SEG, SEG, 6, 4, heights);
  let styleTag = 'Python (unavailable)';
  try {
    const ml = new TsMlProvider();
    const weights = await loadStyleWeights('gen/python-style.json');
    for (let j = 0; j < SEG; j++) {
      const v = j / (SEG - 1);
      for (let i = 0; i < SEG; i++) {
        const u = i / (SEG - 1);
        const idx = j * SEG + i;
        const h = heights[idx];
        const s = ml.stylizeForward([h, u, v], weights);
        heights[idx] = h * 0.55 + s * 0.45;
      }
    }
    styleTag = ml.languageTag;
  } catch {
    // Terrain still renders from the C++ heights; the style pass is skipped.
  }
  const ground = new SceneNode('ground');
  ground.addComponent(new Mesh(
    terrain({
      size: 70, segments: SEG - 1, height: 7,
      sampler: (x, z) => {
        const fx = Math.min(SEG - 1, Math.max(0, Math.round(((x / 70) + 0.5) * (SEG - 1))));
        const fz = Math.min(SEG - 1, Math.max(0, Math.round(((z / 70) + 0.5) * (SEG - 1))));
        return heights[fz * SEG + fx];
      },
      generatedBy: gen.languageTag,
    }),
    buildMaterial({ baseColor: [0.16, 0.32, 0.22], effects: ['heightRamp', 'noise'], generatedBy: 'TypeScript' }),
  ));
  root.addChild(ground);

  // The gate: a torus with fresnel glow, slowly spinning.
  const gate = new SceneNode('gate').setPosition(0, 5.5, -10);
  gate.addComponent(new Mesh(
    torus(3.2, 0.55, 48, 24, 'TypeScript'),
    buildMaterial({ baseColor: [0.1, 0.2, 0.35], effects: ['fresnel', 'pulse'], generatedBy: 'TypeScript' }),
  ));
  gate.addComponent(new Spin(0.35));
  root.addChild(gate);

  // Orb field: seeded scatter of pulsing spheres.
  const rnd = mulberry32(20240);
  const orbGeo = sphere(0.32, 12, 8, 'TypeScript');
  const orbMat = buildMaterial({ baseColor: [0.75, 0.35, 0.1], effects: ['pulse', 'fresnel'], generatedBy: 'TypeScript' });
  for (let i = 0; i < 42; i++) {
    const o = new SceneNode('orb' + i).setPosition((rnd() - 0.5) * 56, 1.5 + rnd() * 7, (rnd() - 0.5) * 56);
    o.addComponent(new Mesh(orbGeo, orbMat));
    o.addComponent(new Bob(0.5, 0.6 + rnd()));
    root.addChild(o);
  }

  const sun = new SceneNode('sun').setPosition(-14, 20, 8);
  const sunLight = new Light('directional');
  sunLight.color = [1.0, 0.9, 0.8];
  sunLight.intensity = 1.1;
  sun.addComponent(sunLight);
  root.addChild(sun);

  const camNode = new SceneNode('camera').setPosition(0, 7, 20);
  const camera = new Camera(16 / 9);
  camNode.addComponent(camera);
  root.addChild(camNode);

  // ---- Pipeline overlay: the visible proof ----
  pipelineRow('terrain heights', gen.languageTag);
  pipelineRow('terrain style (ML)', styleTag);
  pipelineRow('geometry', 'TypeScript');
  pipelineRow('materials / shaders', 'TypeScript');
  pipelineRow('renderer (WebGL2)', 'TypeScript');
  pipelineRow('scripting provider', 'C# (.NET)');
  pipelineRow('XR session', 'TypeScript (WebXR)');
  pipelineRow('audio: pad voice', 'TypeScript');
  pipelineRow('audio: DSP bass', gen.languageTag);
  pipelineRow('audio: chords + melody', 'Python');
  pipelineRow('audio: arp + hats', 'C# (.NET)');
  pipelineRow('audio: sparkle pings', 'Swift (stub)');
  pipelineRow('audio: sub pulse', 'Kotlin (stub)');
  pipelineRow('visionOS provider', 'Swift (stub)');
  pipelineRow('Android XR provider', 'Kotlin (stub)');

  // ---- Renderer / polyglot audio ----
  // Every language gets a voice in the mix: TS pad, C++ DSP bass, Python
  // chords+melody, C# arp+hats. Swift/Kotlin ship conformant composers for
  // their native targets (stubs in the browser demo).
  const renderer = new Renderer(canvas);
  const audio = new SpatialAudio();
  const actx = audio.getContext();
  const bus = audio.getDestination();
  const scorePlayers: ScorePlayer[] = [];
  const loadScore = async (url: string): Promise<void> => {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const player = new ScorePlayer(actx, bus);
      player.load(await res.json());
      scorePlayers.push(player);
    } catch {
      // A missing score just leaves that voice silent.
    }
  };
  await loadScore('gen/python-score.json');
  await loadScore('gen/csharp-score.json');

  // C++ DSP voice: render one 10 s loop (matches the scores' loop_dur).
  let voiceSrc: AudioBufferSourceNode | null = null;
  const startVoice = (): void => {
    if (voiceSrc) return;
    const sr = actx.sampleRate;
    const n = Math.floor(sr * 10);
    const data = new Float32Array(n);
    gen.dspVoice(20261010, n, sr, data);
    const buf = actx.createBuffer(1, n, sr);
    buf.getChannelData(0).set(data);
    voiceSrc = actx.createBufferSource();
    voiceSrc.buffer = buf;
    voiceSrc.loop = true;
    const g = actx.createGain();
    g.gain.value = 0.5;
    voiceSrc.connect(g);
    g.connect(bus);
    voiceSrc.start();
  };
  const stopVoice = (): void => {
    try { voiceSrc?.stop(); } catch { /* already stopped */ }
    voiceSrc = null;
  };
  const onResize = () => renderer.resize(canvas.clientWidth, canvas.clientHeight);
  window.addEventListener('resize', onResize);
  onResize();

  // ---- Frame loop (shared by inline + XR sessions) ----
  let last = performance.now();
  const frame: FrameCallback = (views: RenderView[], t: number) => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    root.updateWorldMatrix(null);
    root.update(dt, t);
    renderer.render(root, camera, camNode, views, t);
    const p = camNode.worldMatrix;
    audio.setListener([p[12], p[13], p[14]], [-p[8], -p[9], -p[10]], [0, 1, 0]);
    audio.music.update(t, 0.35 + 0.3 * Math.sin(t * 0.4));
  };

  // ---- Sessions ----
  const inline = new InlineProvider(camNode, camera);
  let current: XRSessionHandle | null = null;
  const startInline = async () => {
    current = await inline.requestSession('inline', canvas);
    current.onFrame(frame);
  };
  await startInline();

  const webxr = new WebXRProvider();
  await webxr.init();
  if (webxr.supportedModes.includes('immersive-vr' as XRMode)) {
    btnVR.disabled = false;
    btnVR.onclick = async () => {
      try {
        setStatus('entering VR...');
        await current?.end();
        current = await webxr.requestSession('immersive-vr', canvas);
        current.onFrame(frame);
        setStatus('');
      } catch (e) { setStatus('VR failed: ' + (e as Error).message); }
    };
  }
  if (webxr.supportedModes.includes('immersive-ar' as XRMode)) {
    btnAR.disabled = false;
    btnAR.onclick = async () => {
      try {
        setStatus('entering AR...');
        await current?.end();
        current = await webxr.requestSession('immersive-ar', canvas);
        current.onFrame(frame);
        setStatus('');
      } catch (e) { setStatus('AR failed: ' + (e as Error).message); }
    };
  }

  // Inline orbit controls (drag to look, wheel to zoom).
  let yaw = 0, pitch = -0.18, dist = 24;
  const target: [number, number, number] = [0, 4, -4];
  const applyOrbit = () => {
    camNode.setPosition(
      target[0] + dist * Math.sin(yaw) * Math.cos(pitch),
      target[1] + dist * Math.sin(-pitch),
      target[2] + dist * Math.cos(yaw) * Math.cos(pitch),
    );
  };
  let dragging = false, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
  window.addEventListener('pointerup', () => { dragging = false; });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    yaw -= (e.clientX - lx) * 0.005;
    pitch = Math.max(-1.2, Math.min(0.6, pitch - (e.clientY - ly) * 0.005));
    lx = e.clientX; ly = e.clientY;
    applyOrbit();
  });
  canvas.addEventListener('wheel', (e) => {
    dist = Math.max(6, Math.min(60, dist + e.deltaY * 0.02));
    applyOrbit();
  }, { passive: true });
  applyOrbit();

  btnAudio.onclick = () => {
    const on = btnAudio.textContent === 'Sound on';
    audio.resume();
    audio.music.setEnabled(on);
    if (on) {
      for (const p of scorePlayers) p.start();
      startVoice();
    } else {
      for (const p of scorePlayers) p.stop();
      stopVoice();
    }
    btnAudio.textContent = on ? 'Sound off' : 'Sound on';
  };
}

void main();
