// demo/import.ts - "Inverse City Import": a real city file in,
// only the math kept, a sibling city back out.
//
// The flow on this page is the v3.2.0 contract, exercised live:
// fitCitySpec reads the uploaded file ONCE, here in the browser,
// and returns a CitySpec (fitted distributions and structure
// parameters). The file object is dropped the moment the fit
// returns; the page holds no reference to the parsed geometry,
// makes no network call with it, and offers no way to get it
// back, because there is nothing to get back. The preview then
// marches a city regenerated from the spec alone (buildCity)
// through the engine's terrain distance field, the same stack
// the suite raycasts in test/city-import.test.ts, and the side
// panel grades the regenerated city against the spec with the
// suite's own statistics oracle (checkCityStats).
//
// Kept specs can also be blended: blendCitySpecs pools fitted
// specs into one mixture spec, and the blend regenerates a city
// that is none of the sources. Blends read specs, never files.
import {
  fitCitySpec, blendCitySpecs, buildCity, measureCity, checkCityStats,
  cityDigest, cityToGrid, specMean, makeGridTerrain, marchTerrain,
  cameraBasis, CameraRig, DesktopScheme, TouchScheme, collectCaps,
  pickScheme, CITY_DEFAULT_TOLERANCES,
  type CitySpec, type BuiltCity, type GridTerrainField, type Vec3,
  type InputScheme, type SchemeId,
} from '../src/index.js';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const logEl = document.getElementById('city-log') as HTMLPreElement;
const helpEl = document.getElementById('input-help') as HTMLDivElement;
const statsBody = document.getElementById('stats-body') as HTMLTableSectionElement;
const dropEl = document.getElementById('drop') as HTMLDivElement;
const fileEl = document.getElementById('file') as HTMLInputElement;
const seedEl = document.getElementById('seed') as HTMLInputElement;
const btnSample = document.getElementById('btn-sample') as HTMLButtonElement;
const btnDownload = document.getElementById('btn-download') as HTMLButtonElement;
const btnSibling = document.getElementById('btn-sibling') as HTMLButtonElement;
const btnBlend = document.getElementById('btn-blend') as HTMLButtonElement;
const specListEl = document.getElementById('spec-list') as HTMLUListElement;
const schemeSel = document.getElementById('input-scheme') as HTMLSelectElement;

const FOV = 1.0;
const LIGHT: Vec3 = (() => {
  const l = Math.hypot(-0.4, 0.8, 0.45);
  return [-0.4 / l, 0.8 / l, 0.45 / l];
})();

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

// ---------------------------------------------------------------------------
// State: kept specs only. Files never outlive the fit call below.
// ---------------------------------------------------------------------------
interface KeptSpec {
  spec: CitySpec;
  sourceBytes: number | null;
}
const kept: KeptSpec[] = [];
let current: CitySpec | null = null;
let built: BuiltCity | null = null;
let field: GridTerrainField | null = null;
let maxH = 1;
let sourceBytes: number | null = null;

function seed(): number {
  const s = Math.floor(Number(seedEl.value));
  return Number.isFinite(s) ? s : 31007;
}

function frameCamera(): void {
  if (!built) return;
  const R = Math.max(built.extentM.width, built.extentM.depth);
  rig.position = [-R * 0.58, R * 0.4 + maxH * 0.6, R * 0.58];
  const target: Vec3 = [0, maxH * 0.2, 0];
  const d: Vec3 = [
    target[0] - rig.position[0],
    target[1] - rig.position[1],
    target[2] - rig.position[2],
  ];
  const dl = Math.hypot(d[0], d[1], d[2]) || 1;
  const dir: Vec3 = [d[0] / dl, d[1] / dl, d[2] / dl];
  rig.yaw = Math.atan2(-dir[0], -dir[2]);
  rig.pitch = Math.asin(Math.max(-1, Math.min(1, dir[1])));
}

function regenerate(): void {
  if (!current) return;
  built = buildCity(current, seed());
  maxH = Math.max(1, ...built.buildings.map((b) => b.height));
  const cell = Math.max(1.5, Math.max(built.extentM.width, built.extentM.depth) / 170);
  field = makeGridTerrain(cityToGrid(built, cell));
  frameCamera();
  renderStats();
}

function fmt(v: number, digits = 1): string {
  return v.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function renderStats(): void {
  if (!current || !built) return;
  const stats = measureCity(built, current);
  const check = checkCityStats(current, stats);
  const domOf = (w: number[]): number =>
    w.indexOf(Math.max(...w));
  const specDeg = (current.orientation.dominantRad * 180) / Math.PI;
  const regenBin = domOf(stats.orientationWeights);
  const regenDeg =
    (((regenBin + 0.5) * Math.PI) / current.orientation.bins) * (180 / Math.PI);
  const row = (label: string, a: string, b: string, cls = ''): string =>
    `<tr><td>${label}</td><td>${a}</td><td class="${cls}">${b}</td></tr>`;
  statsBody.innerHTML = [
    row('Buildings', String(current.buildingCount), String(stats.count)),
    row('Density / km²', fmt(current.densityPerKm2, 0), fmt(stats.densityPerKm2, 0)),
    row('Mean footprint m²', fmt(current.areaMean, 0), fmt(stats.areaMean, 0)),
    row('Mean height m', fmt(current.heightMean), fmt(stats.heightMean)),
    row('Dominant orientation', `${fmt(specDeg, 0)}°`, `${fmt(regenDeg, 0)}°`),
    row('Area L1 (tolerance)', fmt(CITY_DEFAULT_TOLERANCES.areaL1, 2), fmt(check.areaL1, 3)),
    row('Height L1 (tolerance)', fmt(CITY_DEFAULT_TOLERANCES.heightL1, 2), fmt(check.heightL1, 3)),
    row('Orientation L1 (tolerance)', fmt(CITY_DEFAULT_TOLERANCES.orientationL1, 2), fmt(check.orientationL1, 3)),
    row(
      'Statistics oracle',
      'targets',
      check.pass ? 'PASS' : `FAIL: ${check.failures.join('; ')}`,
      check.pass ? 'pass' : 'fail',
    ),
  ].join('');
  const specBytes = JSON.stringify(current).length;
  const lines = [
    `spec: ${current.name} (${current.origin})`,
    current.parents ? `parents: ${current.parents.join(' + ')}` : '',
    `extent ${fmt(current.extentM.width, 0)} x ${fmt(current.extentM.depth, 0)} m`,
    `seed ${built.seed} · digest ${cityDigest(built)}`,
    sourceBytes !== null
      ? `source file ${sourceBytes.toLocaleString('en-US')} bytes, read once and discarded`
      : 'source: blended from kept specs (files long gone)',
    `CitySpec kept: ${specBytes.toLocaleString('en-US')} bytes of math`,
    `histogram mean check: area ${fmt(specMean(current.footprintArea), 0)} m², height ${fmt(specMean(current.height), 1)} m`,
  ].filter(Boolean);
  logEl.textContent = lines.join('\n');
}

function renderSpecList(): void {
  if (kept.length === 0) {
    specListEl.innerHTML = '<li class="tag">none yet: convert a city to keep its math</li>';
  } else {
    specListEl.innerHTML = '';
    kept.forEach((entry, i) => {
      const li = document.createElement('li');
      if (current === entry.spec) li.className = 'current';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.idx = String(i);
      cb.onchange = updateBlendButton;
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = entry.spec.name;
      nm.title = 'Show this spec';
      nm.onclick = () => selectSpec(entry);
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = `${entry.spec.origin} · ${entry.spec.buildingCount} bldgs`;
      li.append(cb, nm, tag);
      specListEl.append(li);
    });
  }
  updateBlendButton();
}

function checkedSpecs(): CitySpec[] {
  const out: CitySpec[] = [];
  specListEl.querySelectorAll('input[type="checkbox"]').forEach((el) => {
    const cb = el as HTMLInputElement;
    if (cb.checked) out.push(kept[Number(cb.dataset.idx)].spec);
  });
  return out;
}

function updateBlendButton(): void {
  btnBlend.disabled = checkedSpecs().length < 2;
}

function selectSpec(entry: KeptSpec): void {
  current = entry.spec;
  sourceBytes = entry.sourceBytes;
  btnDownload.disabled = false;
  btnSibling.disabled = false;
  regenerate();
  renderSpecList();
}

function keepSpec(spec: CitySpec, bytes: number | null): void {
  const entry: KeptSpec = { spec, sourceBytes: bytes };
  kept.push(entry);
  selectSpec(entry);
}

// ---------------------------------------------------------------------------
// Conversion: the one read of the user's file.
// ---------------------------------------------------------------------------
async function convertData(data: unknown, name: string, bytes: number): Promise<void> {
  try {
    const spec = fitCitySpec(data, { name });
    // The source value goes out of scope here. Only the spec is kept.
    keepSpec(spec, bytes);
    setStatus(
      `Converted ${name}. The file is discarded; the CitySpec below is all that is kept, and the preview is a sibling regenerated from it.`,
    );
  } catch (err) {
    setStatus(`Could not fit that file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function convertText(text: string, name: string, bytes: number): Promise<void> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    setStatus('That file is not valid JSON, so there is nothing to fit. A GeoJSON export is JSON with footprint polygons.');
    return;
  }
  await convertData(doc, name, bytes);
}

async function convertFile(file: File): Promise<void> {
  const lower = file.name.toLowerCase();
  const name =
    file.name.replace(/\.(geojson|json|obj|gltf|glb)$/i, '') || 'Imported city';
  try {
    if (lower.endsWith('.glb')) {
      await convertData(await file.arrayBuffer(), name, file.size);
    } else if (lower.endsWith('.obj')) {
      await convertData(await file.text(), name, file.size);
    } else if (lower.endsWith('.gltf')) {
      const text = await file.text();
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        setStatus('That glTF file is not valid JSON, so there is nothing to fit.');
        return;
      }
      await convertData(doc, name, file.size);
    } else {
      await convertText(await file.text(), name, file.size);
    }
  } catch (err) {
    setStatus(`Could not read that file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

dropEl.onclick = () => fileEl.click();
dropEl.onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === ' ') fileEl.click();
};
fileEl.onchange = () => {
  const f = fileEl.files?.[0];
  fileEl.value = '';
  if (f) void convertFile(f);
};
for (const ev of ['dragover', 'dragenter']) {
  dropEl.addEventListener(ev, (e) => {
    e.preventDefault();
    dropEl.classList.add('over');
  });
}
for (const ev of ['dragleave', 'drop']) {
  dropEl.addEventListener(ev, (e) => {
    e.preventDefault();
    dropEl.classList.remove('over');
  });
}
dropEl.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) void convertFile(f);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function loadSample(): Promise<void> {
  try {
    const res = await fetch('./sample-city.geojson');
    if (!res.ok) throw new Error(`sample fetch ${res.status}`);
    const text = await res.text();
    await convertText(text, 'Sample city (downtown grid)', text.length);
  } catch (err) {
    setStatus(`Sample city failed to load: ${err instanceof Error ? err.message : String(err)}`);
  }
}
btnSample.onclick = () => void loadSample();

btnDownload.onclick = () => {
  if (!current) return;
  const blob = new Blob([JSON.stringify(current, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${current.name.replace(/[^\w\- ]+/g, '').trim() || 'city'}.cityspec.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

btnSibling.onclick = () => {
  seedEl.value = String(seed() + 1);
  regenerate();
  setStatus(`Sibling regenerated from the same spec with seed ${seedEl.value}. Same math, new city: check the digest in the state panel.`);
};
seedEl.onchange = () => regenerate();

btnBlend.onclick = () => {
  const specs = checkedSpecs();
  if (specs.length < 2) return;
  try {
    const blend = blendCitySpecs(specs);
    keepSpec(blend, null);
    setStatus(
      `Blended ${specs.length} kept specs into one. The preview is a new city that is none of the sources; it carries their pooled distributions.`,
    );
  } catch (err) {
    setStatus(`Blend failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ---------------------------------------------------------------------------
// Camera: the V9 unified input rig, same conventions as Living World.
// ---------------------------------------------------------------------------
const rig = new CameraRig();
rig.position = [-160, 120, 160];
rig.yaw = Math.PI / 4;
rig.pitch = -0.42;
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

function camDir(): Vec3 {
  const cp = Math.cos(rig.pitch);
  return [-Math.sin(rig.yaw) * cp, Math.sin(rig.pitch), -Math.cos(rig.yaw) * cp];
}

// ---------------------------------------------------------------------------
// Render: CPU march of the regenerated city through the terrain
// distance field, adaptive resolution, as in the Living World demo.
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
  const maxDist = built
    ? 5 * Math.max(built.extentM.width, built.extentM.depth)
    : 1200;
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
      const rd: Vec3 = [d[0] / dl, d[1] / dl, d[2] / dl];
      let r = 0.03;
      let g = 0.04;
      let b = 0.07;
      if (field) {
        const hit = marchTerrain(field, rig.position, rd, {
          maxDist,
          steps: 400,
        });
        if (Number.isFinite(hit.depth) && hit.point) {
          const p = hit.point;
          const grad = field.gradientAt(p[0], p[2]);
          let nxv = -grad[0];
          let nyv = 1;
          let nzv = -grad[1];
          const nl = Math.hypot(nxv, nyv, nzv) || 1;
          nxv /= nl; nyv /= nl; nzv /= nl;
          const lam = Math.max(
            0,
            nxv * LIGHT[0] + nyv * LIGHT[1] + nzv * LIGHT[2],
          );
          const s = 0.32 + 0.68 * lam;
          const h = field.heightAt(p[0], p[2]);
          if (h <= 0.05) {
            r = 0.14 * s; g = 0.14 * s; b = 0.16 * s;
          } else {
            const t = Math.min(1, h / maxH);
            r = (0.35 + 0.45 * t) * s;
            g = (0.38 + 0.4 * t) * s;
            b = (0.48 + 0.3 * t) * s;
          }
        } else {
          const t = Math.max(0, rd[1]);
          r = 0.05 + 0.1 * t; g = 0.07 + 0.11 * t; b = 0.12 + 0.14 * t;
        }
      }
      data[k++] = Math.round(255 * (r / (1 + r)));
      data[k++] = Math.round(255 * (g / (1 + g)));
      data[k++] = Math.round(255 * (b / (1 + b)));
      data[k++] = 255;
    }
  }
  offCtx.putImageData(img, 0, 0);
  viewCtx.imageSmoothingEnabled = false;
  viewCtx.drawImage(off, 0, 0, canvas.width, canvas.height);
  renderMs = performance.now() - t0;
}

let frameNo = 0;
let slowFrames = 0;
let last = performance.now();
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  activeScheme.poll(rig, dt);
  render();
  frameNo++;
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
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
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
  setStatus('ready: loading the bundled sample city so the preview has a city in it. Your own file converts the same way.');
  frame();
  void loadSample();
});
