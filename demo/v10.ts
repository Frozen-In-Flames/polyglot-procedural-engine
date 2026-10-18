// demo/v10.ts - V10 "Math-First MVP" acceptance demo.
//
// The 4-step recipe, live:
//   1. f_world from 4 SDF primitives blended with exponential smin.
//   2. The raymarcher returning depth AND normal per ray.
//   3. Lambert shading R_j = dot(n, l) as the baseline.
//   4. A target ("this region brighter") handed to the inverse solver,
//      which drags light_pos until the render matches; the iteration log
//      below shows the convergence.
// The Tuning Deck (right panel) drives the same world live: raw math
// sliders plus the semantic sliders (Organicness, Sharpness, Warp, ...).
// Zero asset dependence: every pixel is math.
import {
  RaymarchRenderer, ParamRegistry, mountTuningDeck, TUNING_DECK_CSS,
  evalSemantics, SEMANTIC_SLIDERS, demoUniforms,
  marchRay, solveLightPosition, cameraBasis,
  CameraRig, DesktopScheme, TouchScheme, collectCaps, pickScheme,
  type SdfNode, type Uniforms, type Vec3, type InputScheme, type SchemeId,
} from '../src/index.js';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const logEl = document.getElementById('solve-log') as HTMLPreElement;
const deckEl = document.getElementById('deck') as HTMLDivElement;
const btnSolve = document.getElementById('btn-solve') as HTMLButtonElement;
const btnView = document.getElementById('btn-view') as HTMLButtonElement;
const schemeSel = document.getElementById('input-scheme') as HTMLSelectElement;
const helpEl = document.getElementById('input-help') as HTMLDivElement;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

// ---------------------------------------------------------------------------
// Step 1: f_world. Four SDF primitives, exponential smooth-min blends.
// ---------------------------------------------------------------------------
const world: SdfNode = {
  kind: 'union',
  children: [
    {
      kind: 'displace',
      amp: { uniform: 'uDisplaceAmp' },
      freq: { uniform: 'uDisplaceFreq' },
      seed: 7,
      child: {
        kind: 'twist',
        k: { uniform: 'uTwistK' },
        child: {
          kind: 'smoothUnion',
          k: { uniform: 'uBlendK' },
          children: [
            { kind: 'sphere', c: [-1.3, 0.9, 0], r: 1.15, mat: 0 },
            { kind: 'box', c: [1.3, 0.8, 0.2], b: [0.95, 0.8, 0.95], mat: 1 },
            { kind: 'torus', c: [0, 2.4, -0.4], R: 0.85, r: 0.3, mat: 2 },
          ],
        },
      },
    },
    { kind: 'plane', n: [0, 1, 0], h: 0.7, mat: 3 },
  ],
};

// ---------------------------------------------------------------------------
// Step 2: the raymarcher. Depth + normal per ray, nothing baked.
// ---------------------------------------------------------------------------
let renderer: RaymarchRenderer;
try {
  renderer = new RaymarchRenderer(canvas);
} catch (e) {
  setStatus('WebGL2 is required for the raymarch renderer: ' + (e as Error).message);
  throw e;
}
renderer.setScene(world);
renderer.setMaterials([
  { color: [0.85, 0.36, 0.26], spec: 0.25 },
  { color: [0.26, 0.55, 0.85], spec: 0.45 },
  { color: [0.95, 0.74, 0.30], spec: 0.85 },
  { color: [0.33, 0.43, 0.30], spec: 0.0 },
]);

const uniforms: Uniforms = demoUniforms();
renderer.setUniforms(uniforms);

// Step 3: Lambert baseline. The light is a virtual point the solver drags;
// the renderer steers its directional light from the solved position.
let lightPos: Vec3 = [-6, 4, 5];
let lightI = 1.0;
function pushLight(): void {
  const l = Math.hypot(lightPos[0], lightPos[1], lightPos[2]) || 1;
  renderer.setLight(
    [lightPos[0] / l, lightPos[1] / l, lightPos[2] / l],
    [lightI, lightI * 0.95, lightI * 0.88],
  );
}
pushLight();

// ---------------------------------------------------------------------------
// Camera: V9 unified input drives one rig; the rig feeds the raymarcher.
// ---------------------------------------------------------------------------
const rig = new CameraRig();
rig.position = [0, 2.4, 8.2];
rig.yaw = 0;
rig.pitch = -0.08;
const desktopScheme = new DesktopScheme();
const touchScheme = new TouchScheme();
const schemes: Record<string, InputScheme> = { desktop: desktopScheme, touch: touchScheme };
let activeScheme: InputScheme = desktopScheme;

const HINTS: Record<SchemeId, string> = {
  desktop: 'WASD move, mouse look (click scene to lock)',
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
    helpEl.textContent = HINTS[id];
  } catch {
    helpEl.textContent = HINTS.desktop;
  }
}
schemeSel.onchange = () => {
  activeScheme = schemes[schemeSel.value] ?? desktopScheme;
  helpEl.textContent = HINTS[schemeSel.value as SchemeId] ?? '';
};

function camDir(): Vec3 {
  const cp = Math.cos(rig.pitch);
  return [-Math.sin(rig.yaw) * cp, Math.sin(rig.pitch), -Math.cos(rig.yaw) * cp];
}

// ---------------------------------------------------------------------------
// Tuning Deck: raw math sliders + semantic sliders, both live.
// ---------------------------------------------------------------------------
const style = document.createElement('style');
style.textContent = TUNING_DECK_CSS;
document.head.appendChild(style);

const reg = new ParamRegistry();
reg.define({ name: 'uBlendK', min: 1, max: 40, value: uniforms.uBlendK, step: 0.1, drives: 'exponential smin k' });
reg.define({ name: 'uTwistK', min: -0.8, max: 0.8, value: uniforms.uTwistK, step: 0.01, drives: 'twist radians per unit height' });
reg.define({ name: 'uDisplaceAmp', min: 0, max: 0.8, value: uniforms.uDisplaceAmp, step: 0.01, drives: 'fbm displacement amplitude' });
reg.define({ name: 'uDisplaceFreq', min: 0.5, max: 8, value: uniforms.uDisplaceFreq, step: 0.1, drives: 'fbm domain frequency' });
reg.define({ name: 'uOmega', min: 0.5, max: 1.0, value: 0.85, step: 0.01, drives: 'sphere-tracing relaxation: t += omega * f' });
for (const s of SEMANTIC_SLIDERS) {
  reg.define({ name: 'sem:' + s.name, min: 0, max: 1, value: 0.5, step: 0.01, drives: s.name + ': g(u) = a*u^2 + b*u + c0' });
}
reg.onAnyChange((name, v) => {
  if (name.startsWith('sem:')) {
    const vals: Record<string, number> = {};
    for (const s of SEMANTIC_SLIDERS) vals[s.name] = reg.get('sem:' + s.name);
    const bundle = evalSemantics(SEMANTIC_SLIDERS, vals);
    for (const [k, val] of Object.entries(bundle)) {
      uniforms[k] = val;
      if (reg.has(k)) reg.set(k, val);
    }
  } else if (name === 'uOmega') {
    renderer.setStepScale(v);
  } else {
    uniforms[name] = v;
  }
  renderer.setUniforms(uniforms);
});
mountTuningDeck(deckEl, reg, [
  { title: 'Raw math', params: ['uBlendK', 'uTwistK', 'uDisplaceAmp', 'uDisplaceFreq', 'uOmega'] },
  { title: 'Semantic', params: SEMANTIC_SLIDERS.map(s => 'sem:' + s.name) },
]);

// ---------------------------------------------------------------------------
// View mode: shaded / depth / normal. Proves the raymarcher returns both.
// ---------------------------------------------------------------------------
const views: Array<'shaded' | 'depth' | 'normal'> = ['shaded', 'depth', 'normal'];
let viewIdx = 0;
btnView.onclick = () => {
  viewIdx = (viewIdx + 1) % views.length;
  renderer.setDebug(viewIdx as 0 | 1 | 2);
  btnView.textContent = 'View: ' + views[viewIdx];
};

// ---------------------------------------------------------------------------
// Step 4: the acceptance solve. "This region brighter."
// Samples the current view on the CPU (depth + normal from the same SDF),
// sets targets above the current Lambert brightness, and lets the finite-
// difference optimizer drag light_pos until the render matches.
// ---------------------------------------------------------------------------
let solving = false;

function sampleView(): Array<{ pos: Vec3; normal: Vec3; target: number }> {
  const dir = camDir();
  const target: Vec3 = [rig.position[0] + dir[0], rig.position[1] + dir[1], rig.position[2] + dir[2]];
  const basis = cameraBasis({ pos: rig.position, target, fovY: 1.0, aspect: canvas.width / canvas.height });
  const tanF = Math.tan(0.5);
  const aspect = canvas.width / Math.max(1, canvas.height);
  const l = Math.hypot(lightPos[0], lightPos[1], lightPos[2]) || 1;
  const lightDir: Vec3 = [lightPos[0] / l, lightPos[1] / l, lightPos[2] / l];
  const out: Array<{ pos: Vec3; normal: Vec3; target: number }> = [];
  for (let gy = 0; gy < 5; gy++) {
    for (let gx = 0; gx < 7; gx++) {
      const nx = ((gx / 6) - 0.5) * 0.9;
      const ny = ((gy / 4) - 0.5) * 0.9;
      const d: Vec3 = [
        basis.fwd[0] + basis.right[0] * nx * tanF * aspect + basis.up[0] * ny * tanF,
        basis.fwd[1] + basis.right[1] * nx * tanF * aspect + basis.up[1] * ny * tanF,
        basis.fwd[2] + basis.right[2] * nx * tanF * aspect + basis.up[2] * ny * tanF,
      ];
      const dl = Math.hypot(d[0], d[1], d[2]) || 1;
      const m = marchRay(world, rig.position, [d[0] / dl, d[1] / dl, d[2] / dl], uniforms);
      if (!m.hit || !m.normal) continue;
      const n = m.normal;
      const bright = Math.max(0, n[0] * lightDir[0] + n[1] * lightDir[1] + n[2] * lightDir[2]);
      out.push({ pos: m.pos, normal: n, target: Math.min(1, bright * 1.7 + 0.12) });
    }
  }
  return out;
}

function renderLog(init: Vec3, sol: ReturnType<typeof solveLightPosition>): void {
  const h = sol.log.history;
  const lines: string[] = [];
  lines.push(`target: brighten the framed region (${sol.log.iterations} samples of the solve)`);
  lines.push(`start light_pos: [${init.map(v => v.toFixed(2)).join(', ')}]`);
  lines.push(`solved light_pos: [${sol.position.map(v => v.toFixed(2)).join(', ')}]  I=${sol.intensity.toFixed(3)}`);
  lines.push(`iterations: ${sol.log.iterations}   residual: ${h[0].toExponential(3)} -> ${h[h.length - 1].toExponential(3)}`);
  lines.push(`rmse: ${sol.rmse.toFixed(5)}   verdict: ${sol.passed ? 'MATCHED' : 'NOT MATCHED (see residual)'}`);
  lines.push('iteration log (residual per 50 steps):');
  for (let i = 0; i < h.length; i++) {
    lines.push(`  step ${(i * 50).toString().padStart(4)}  residual ${h[i].toExponential(4)}`);
  }
  logEl.textContent = lines.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

btnSolve.onclick = () => {
  if (solving) return;
  solving = true;
  btnSolve.disabled = true;
  setStatus('sampling the view on the CPU (depth + normal from the SDF)...');
  setTimeout(() => {
    try {
      const samples = sampleView();
      if (samples.length < 6) {
        setStatus('no surface in the frame: move the camera toward the world and retry.');
        solving = false;
        btnSolve.disabled = false;
        return;
      }
      setStatus(`solving: dragging light_pos over ${samples.length} samples...`);
      setTimeout(() => {
        const initPos: Vec3 = [lightPos[0], lightPos[1], lightPos[2]];
        const sol = solveLightPosition(
          samples,
          { position: initPos, intensity: lightI },
          { eta: 0.1, maxIter: 2000 },
        );
        renderLog(initPos, sol);
        // Animate the drag: light_pos eases from start to solved.
        const fromP = initPos, toP = sol.position;
        const fromI = lightI, toI = sol.intensity;
        const t0 = performance.now();
        const dur = 1600;
        const tick = () => {
          const t = Math.min(1, (performance.now() - t0) / dur);
          const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          lightPos = [
            fromP[0] + (toP[0] - fromP[0]) * e,
            fromP[1] + (toP[1] - fromP[1]) * e,
            fromP[2] + (toP[2] - fromP[2]) * e,
          ];
          lightI = fromI + (toI - fromI) * e;
          pushLight();
          if (t < 1) requestAnimationFrame(tick);
          else {
            setStatus(sol.passed ? 'solve converged: render matches the target.' : 'solve finished with residual: check the log.');
            solving = false;
            btnSolve.disabled = false;
          }
        };
        tick();
      }, 30);
    } catch (e) {
      setStatus('solve failed: ' + (e as Error).message);
      solving = false;
      btnSolve.disabled = false;
    }
  }, 30);
};

// ---------------------------------------------------------------------------
// Frame loop.
// ---------------------------------------------------------------------------
function resize(): void {
  renderer.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
resize();

let last = performance.now();
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  activeScheme.poll(rig, dt);
  const dir = camDir();
  renderer.render({
    pos: rig.position,
    target: [rig.position[0] + dir[0], rig.position[1] + dir[1], rig.position[2] + dir[2]],
    fovY: 1.0,
    aspect: canvas.width / Math.max(1, canvas.height),
  });
  requestAnimationFrame(frame);
}

initInput().finally(() => {
  setStatus('ready: drag the Tuning Deck, or run the inverse-lighting solve.');
  frame();
});
