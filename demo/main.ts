// demo/main.ts — "First Light": the zero-asset proof scene.
// Every visual and sound is generated in code. The HUD pipeline list names
// the language behind each system, so the cooperation is visible.
import {
  SceneNode, Mesh, Light, Camera, Script,
  terrain, sphere, torus, buildMaterial,
  Renderer, WebXRProvider, InlineProvider,
  SpatialAudio, createGenCore, mulberry32, TsMlProvider, loadStyleWeights, ScorePlayer,
  ParticleSystem, particleGeometry, writeParticles, skyDome, rock, scatterRocks,
  type Collider, type Geometry,
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

/** WASM factory when the emcc build is present (demo/public/gen/), else undefined.
 *  Tries the import directly instead of a HEAD probe: works on http(s),
 *  file://, and subpath hosting alike. */
async function wasmFactory(): Promise<(() => Promise<unknown>) | undefined> {
  try {
    // Absolute URL built at runtime (bundlers leave it alone), resolved
    // against the page — not the bundle in assets/ — so it works on
    // http(s), file://, and subpath hosting alike.
    const genUrl = new URL('gen/' + 'gen.js', document.baseURI).href;
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

/** Drives a ParticleSystem: emit, step the physics, rewrite the mesh. */
class ParticleDriver extends Script {
  constructor(
    private sys: ParticleSystem,
    private geo: Geometry,
    private size: number,
    private emit: (s: ParticleSystem) => void,
    private collider?: Collider,
  ) { super(); }
  update(dt: number): void {
    this.emit(this.sys);
    this.sys.step(Math.min(dt, 1 / 30), this.collider);
    writeParticles(this.geo, this.sys, this.size);
    this.geo.version = (this.geo.version ?? 0) + 1;
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
  // Named sampler: shared by the terrain mesh, the physics collider, and rocks.
  const sampleHeight = (x: number, z: number): number => {
    const fx = Math.min(SEG - 1, Math.max(0, Math.round(((x / 70) + 0.5) * (SEG - 1))));
    const fz = Math.min(SEG - 1, Math.max(0, Math.round(((z / 70) + 0.5) * (SEG - 1))));
    return heights[fz * SEG + fx] * 7;
  };
  const terrainCollider: Collider = { heightAt: (x, z) => sampleHeight(x, z) };
  const ground = new SceneNode('ground');
  ground.addComponent(new Mesh(
    terrain({
      size: 70, segments: SEG - 1, height: 7,
      sampler: (x, z) => sampleHeight(x, z) / 7,
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

  // Sky dome: gradient + hashed stars, no textures. Unlit.
  const sky = new SceneNode('sky');
  sky.addComponent(new Mesh(
    skyDome(600, 'TypeScript'),
    buildMaterial({ baseColor: [0, 0, 0], effects: ['sky'], generatedBy: 'TypeScript', unlit: true }),
  ));
  root.addChild(sky);

  // Rocks: noise-displaced, seeded scatter resting on the terrain.
  const rockMat = buildMaterial({ baseColor: [0.38, 0.36, 0.33], effects: ['noise'], generatedBy: 'TypeScript' });
  const rockGeos = [rock(11, 1), rock(77, 1), rock(1234, 1)];
  for (const r of scatterRocks(4242, { count: 42, area: 30, minScale: 0.35, maxScale: 1.5 })) {
    const node = new SceneNode('rock').setPosition(r.x, sampleHeight(r.x, r.z) - 0.15, r.z);
    node.scale = [r.scale, r.scale, r.scale];
    node.rotation = fromAxisAngle([0, 1, 0], r.rotY);
    node.addComponent(new Mesh(rockGeos[r.seed % rockGeos.length], rockMat));
    root.addChild(node);
  }

  // Physics: ember risers from the gate (buoyant) and falling motes that
  // bounce on the terrain collider.
  const emberSys = new ParticleSystem(9001, { max: 420, gravity: 1.6, drag: 0.7 });
  const emberGeo = particleGeometry(420, 'TypeScript');
  const emberMat = buildMaterial({ baseColor: [1.0, 0.42, 0.1], effects: [], generatedBy: 'TypeScript', unlit: true });
  const emberNode = new SceneNode('embers');
  emberNode.addComponent(new Mesh(emberGeo, emberMat));
  emberNode.addComponent(new ParticleDriver(
    emberSys, emberGeo, 0.09,
    (s) => s.burst(0, 4.6, -10, 2.2, 0.7, 2.2, 3.2, 0.5, 3),
  ));
  root.addChild(emberNode);

  const moteSys = new ParticleSystem(1337, { max: 320, gravity: -9.8, drag: 0.05, restitution: 0.55 });
  const moteGeo = particleGeometry(320, 'TypeScript');
  const moteMat = buildMaterial({ baseColor: [0.65, 0.85, 1.0], effects: [], generatedBy: 'TypeScript', unlit: true });
  const moteNode = new SceneNode('motes');
  moteNode.addComponent(new Mesh(moteGeo, moteMat));
  const moteRnd = mulberry32(555);
  moteNode.addComponent(new ParticleDriver(
    moteSys, moteGeo, 0.06,
    (s) => {
      for (let k = 0; k < 2; k++) {
        s.spawn((moteRnd() - 0.5) * 60, 15 + moteRnd() * 8, (moteRnd() - 0.5) * 60,
          0, -1 - moteRnd() * 2, 0, 14);
      }
    },
    terrainCollider,
  ));
  root.addChild(moteNode);

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
  pipelineRow('physics: particles', 'TypeScript');
  pipelineRow('sky dome', 'TypeScript');
  pipelineRow('rocks', 'TypeScript');

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
