// games/workshop/main.ts - WORKSHOP: the V5 session proof.
//
// A live build session where the world is shaped while standing in it,
// captured as screenshots. One zone of terrain, one sky dome, and an ember
// particle system whose velocity samples the session's effective wind:
// the global WindField sample PLUS the sum of brushOffset() over the
// applied ops, read from the op log (the honest causal chain). The wind
// itself is never drawn: no vectors, no overlays, no numbers of the field.
// Its structure reads only in the embers' lean.
//
// The scripted session runs on a timeline driven by window.__wsPhase(n).
// Every phase applies real BuildSession instrument actions, and every
// action emits a real BuildOp, so the op log replays to the same world on
// every node. Deterministic: fixed session seed, fixed tool seeds, seeded
// particles on a fixed-step clock.
//
// Phase 5 (the behavior script) is compiled with the browser-local realm
// in behavior-browser.ts - compile.ts needs node:vm, which the browser
// cannot run. The op payload carries the identical source text, and the
// op is emitted byte-identical to BuildSession.emitOp (same fields, same
// chain), so the state-graph story holds.

import {
  SceneNode, Mesh, Light, Camera,
  Renderer, InlineProvider,
  buildMaterial, skyDome, terrain,
  mulberry32, fbm2,
  ParticleSystem, particleGeometry, writeParticles,
  fromAxisAngle, quatMultiply,
  ScriptRuntime, SceneEntityBackend,
  type FrameCallback, type RenderView, type ScriptDef, type CapabilityName,
  type EntityHandle,
} from '../../src/index.js';
import { GlobalField } from '../../src/world/index.js';
import { BuildSession, OP_BUILD_SCRIPT } from '../../src/build/index.js';
import {
  StateNode, GENESIS_PREV, opHash,
  validateOpShape, validatePayload,
  type BuildOp, type JSONValue,
} from '../../src/state/index.js';
// V7 anchoring panel: pure flow logic (statically bundled) plus the
// chain adapter interface. The concrete adapter module is dynamic-imported
// ONLY when the user opens the panel, so it never enters the core bundle.
import { AnchorFlow } from '../../src/own/flow.js';
import type { ChainAdapter } from '../../src/own/chain.js';
// Type-only: erased at compile, so the concrete adapter module still
// loads exclusively through the dynamic import below.
import type { EvmAdapterConfig, Eip1193Provider } from '../../src/own/evm.js';
import { buildProvenance } from '../../src/own/provenance.js';
import {
  LICENSE_OPEN, createMint, verifyMint,
  type MintManifest,
} from '../../src/own/mint.js';
import { generateKeypair, toHex } from '../../src/own/ed25519.js';
import { makeBehaviorDef } from './behavior-browser.js';

/** Fixed session seed: one seed, one ocean. */
const WS_SEED = 20261011;

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const titleEl = document.getElementById('title') as HTMLDivElement;
const captionEl = document.getElementById('caption') as HTMLDivElement;
const convEl = document.getElementById('convergence') as HTMLDivElement;
const nodeLocalEl = document.getElementById('node-local') as HTMLDivElement;
const nodeRemoteEl = document.getElementById('node-remote') as HTMLDivElement;
const verdictEl = document.getElementById('node-verdict') as HTMLDivElement;

// Error surface for headless verification (and honest failure in general).
const errors: string[] = [];
(window as unknown as { __wsErrors: string[] }).__wsErrors = errors;
window.addEventListener('error', (e) => errors.push('error: ' + e.message));
window.addEventListener('unhandledrejection', (e) =>
  errors.push('rejection: ' + String((e as PromiseRejectionEvent).reason)));
// Console errors count too: zero console errors is the acceptance bar.
{
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    errors.push('console.error: ' + args.map((a) => String(a)).join(' '));
    orig(...args);
  };
}

// ---- Terrain: one zone, fixed math ----
const TERR = { size: 140, segments: 96, height: 10 };
const terrSampler = (x: number, z: number): number =>
  0.35 + 0.65 * fbm2(x * 0.035, z * 0.035, WS_SEED ^ 0x7e44, 4);
const groundAt = (x: number, z: number): number => terrSampler(x, z) * TERR.height;

// ---- Ember field layout ----
const EMBER_COUNT = 320;
const EMBER_CENTER: [number, number] = [0, 12];
const EMBER_R = 26;
const EMBER_SIZE = 0.14;
const SIM_H = 1 / 120;

// ---- Camera: one fixed cinematic framing (well above the terrain: the
// land rolls 4.4..9.3 high on this seed, so the eye sits at 14) ----
const CAM_POS: [number, number, number] = [0, 14, 48];
const CAM_TARGET: [number, number, number] = [0, 5, -6];

// ---- Phase captions (no em dashes, ever) ----
const CAPTIONS = [
  'the world as the seed made it',
  'the brush bends the wind',
  'a seed becomes stone',
  'the rhythm quickens',
  'the stone learns to breathe',
  'two builders, one ocean',
];

// The live behavior script: a gentle pulse. This exact source text rides
// on the emitted op so any node holding the log can compile the same math.
const BREATH_SOURCE = [
  'function start(caps, self) {',
  '  caps.log("breath attached");',
  '}',
  'function update(caps, self, dt, t) {',
  '  var tr = self.getTransform();',
  '  var s = 1 + 0.045 * Math.sin(t * 2.2);',
  '  self.setTransform({ position: tr.position, rotation: tr.rotation, scale: [s, s, s] });',
  '}',
].join('\n');

const BEHAVIOR_GRANTS: CapabilityName[] = [
  'rng', 'time', 'world.spawn', 'world.query', 'events', 'log', 'field.read',
];

async function main(): Promise<void> {
  const root = new SceneNode('root');
  const field = new GlobalField(undefined, WS_SEED);
  const backend = new SceneEntityBackend(root);
  const runtime = new ScriptRuntime(WS_SEED, backend, {
    field,
    probe: groundAt,
    onEvent: () => undefined,
    onError: (name, err) => errors.push(`script ${name}: ${String(err)}`),
  });
  const session = new BuildSession({ runtime, actor: 'local-builder', seed: WS_SEED });

  // ---- Terrain mesh ----
  const terrGeo = terrain({
    size: TERR.size, segments: TERR.segments, height: TERR.height,
    sampler: terrSampler, generatedBy: 'TypeScript',
  });
  const terrNode = new SceneNode('terrain:workshop');
  terrNode.addComponent(new Mesh(
    terrGeo,
    buildMaterial({
      baseColor: [0.16, 0.12, 0.13],
      effects: ['heightRamp', 'noise'],
      generatedBy: 'TypeScript',
    }),
  ));
  root.addChild(terrNode);

  // ---- Sky dome follows the camera ----
  const sky = new SceneNode('sky');
  sky.addComponent(new Mesh(
    skyDome(600, 'TypeScript'),
    buildMaterial({ baseColor: [0, 0, 0], effects: ['sky'], generatedBy: 'TypeScript', unlit: true }),
  ));
  sky.setPosition(CAM_POS[0], 0, CAM_POS[2]);
  root.addChild(sky);

  // ---- Sun: raking light so the terrain reads in diffuse ----
  const sun = new SceneNode('sun').setPosition(-60, 80, 40);
  const sunLight = new Light('directional');
  sunLight.color = [1.0, 0.9, 0.78];
  sunLight.intensity = 1.15;
  sun.addComponent(sunLight);
  {
    const d: [number, number, number] = [-0.35, -0.8, -0.5];
    const il = 1 / Math.hypot(d[0], d[1], d[2]);
    const dn: [number, number, number] = [d[0] * il, d[1] * il, d[2] * il];
    const ax: [number, number, number] = [-dn[1], dn[0], 0];
    const al = Math.hypot(ax[0], ax[1]) || 1;
    sun.rotation = fromAxisAngle(
      [ax[0] / al, ax[1] / al, 0],
      Math.acos(Math.max(-1, Math.min(1, dn[2]))),
    );
    sun.markDirty();
  }
  root.addChild(sun);

  // ---- Camera (fixed) ----
  const camNode = new SceneNode('camera').setPosition(CAM_POS[0], CAM_POS[1], CAM_POS[2]);
  const camera = new Camera(16 / 9);
  camNode.addComponent(camera);
  root.addChild(camNode);
  {
    const dx = CAM_TARGET[0] - CAM_POS[0];
    const dy = CAM_TARGET[1] - CAM_POS[1];
    const dz = CAM_TARGET[2] - CAM_POS[2];
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    camNode.rotation = quatMultiply(
      fromAxisAngle([0, 1, 0], yaw),
      fromAxisAngle([1, 0, 0], pitch),
    );
    camNode.markDirty();
  }

  // ---- Ember particle system (host-owned) ----
  // Storage is the engine's ParticleSystem; integration is ours, so every
  // velocity sample goes through the session's effective wind
  // (global field + brush offsets from the op log). Fixed-step clock for
  // determinism.
  const embers = new ParticleSystem(WS_SEED ^ 0xe1be5, { max: EMBER_COUNT });
  const emberPhase = new Float32Array(EMBER_COUNT);
  let emberRng = mulberry32(WS_SEED ^ 0xe1be5);
  const spawnEmber = (i: number): void => {
    const a = emberRng() * Math.PI * 2;
    const r = Math.sqrt(emberRng()) * EMBER_R;
    const x = EMBER_CENTER[0] + Math.cos(a) * r;
    const z = EMBER_CENTER[1] + Math.sin(a) * r;
    const life = 5 + emberRng() * 5;
    embers.pos[i * 3] = x;
    embers.pos[i * 3 + 1] = groundAt(x, z) + 0.6 + emberRng() * 3.5;
    embers.pos[i * 3 + 2] = z;
    embers.vel[i * 3] = 0; embers.vel[i * 3 + 1] = 0; embers.vel[i * 3 + 2] = 0;
    embers.life[i] = life;
    embers.maxLife[i] = life;
    emberPhase[i] = emberRng() * Math.PI * 2;
  };
  for (let i = 0; i < EMBER_COUNT; i++) spawnEmber(i);
  embers.count = EMBER_COUNT;

  let tSim = 0;
  const stepEmbers = (h: number): void => {
    tSim += h;
    for (let i = 0; i < EMBER_COUNT; i++) {
      embers.life[i] -= h;
      if (embers.life[i] <= 0) { spawnEmber(i); continue; }
      const ix = i * 3;
      const x = embers.pos[ix], y = embers.pos[ix + 1], z = embers.pos[ix + 2];
      // The honest causal chain: global WindField sample + every brush
      // offset from the applied ops, read from the session's op log.
      const w = session.sample(x, y, z, tSim);
      const rhy = session.sampleRhythm(x, z);
      const bob = Math.sin((2 * Math.PI * tSim) / rhy.beatPeriod + emberPhase[i]);
      const vx = w.x * 1.7;
      const vz = w.z * 1.7;
      const vy = 0.85 + w.y * 0.5 + bob * 0.55;
      embers.pos[ix] = x + vx * h;
      embers.pos[ix + 1] = y + vy * h;
      embers.pos[ix + 2] = z + vz * h;
      const floor = groundAt(embers.pos[ix], embers.pos[ix + 2]) + 0.3;
      if (embers.pos[ix + 1] < floor) embers.pos[ix + 1] = floor;
    }
  };

  const emberGeo = particleGeometry(EMBER_COUNT, 'TypeScript');
  const emberNode = new SceneNode('embers');
  emberNode.addComponent(new Mesh(
    emberGeo,
    buildMaterial({
      baseColor: [1.0, 0.5, 0.14],
      effects: ['pulse'],
      generatedBy: 'TypeScript',
      unlit: true,
    }),
  ));
  root.addChild(emberNode);

  // ---- Renderer ----
  const renderer = new Renderer(canvas);
  const onResize = () => renderer.resize(canvas.clientWidth, canvas.clientHeight);
  window.addEventListener('resize', onResize);
  onResize();

  // ---- Captions ----
  let captionTimer = 0;
  function showCaption(text: string): void {
    captionEl.textContent = text;
    captionEl.style.opacity = '1';
    captionTimer = 4.5;
  }

  // The scripted build session: six phases; the timeline driver below
  // advances `phase`, and the settle hook reads it back.
  let phase = 0;

  // ---- Deterministic settle (headless capture) ----
  // Rebuild the ember field as a pure function of (session seed, applied
  // ops, n): exactly n * SETTLE_S seconds of fixed-step sim, integrated in
  // identical steps every run. The live page advances the same sim with
  // the wall clock; the settle re-derives the identical settled state so
  // screenshots are reproducible bit-for-bit. Freezes the wall-clock
  // advance afterwards; the next __wsPhase unfreezes.
  const SETTLE_S = 2.5;
  let frozen = false;
  const resetEmbers = (): void => {
    tSim = 0;
    emberRng = mulberry32(WS_SEED ^ 0xe1be5);
    for (let i = 0; i < EMBER_COUNT; i++) spawnEmber(i);
    embers.count = EMBER_COUNT;
  };
  (window as unknown as { __wsSettle: (n: number) => void }).__wsSettle = (n: number) => {
    frozen = true;
    resetEmbers();
    const steps = Math.round((n * SETTLE_S) / SIM_H);
    for (let s = 0; s < steps; s++) stepEmbers(SIM_H);
    if (phase >= 1) showCaption(CAPTIONS[phase - 1]);
    // Snap the title to its rested state: the live fade is wall-clock and
    // would otherwise differ between captures.
    titleEl.style.transition = 'none';
    titleEl.style.opacity = '0.85';
  };

  // ---- The scripted build session: six phases, each a real instrument
  // action emitting a real BuildOp. Idempotent: re-running a phase is a
  // no-op, so __wsPhase(n) can drive the timeline forward to any phase.
  // Advancing unfreezes the wall-clock sim after a deterministic settle.
  const applied = [false, false, false, false, false, false];
  let rockEntityId = -1;

  const phaseFns: Array<() => void> = [
    // 01-pristine: the world as the seed made it. Nothing to do.
    () => undefined,
    // 02-brush: bend the wind in a disc; the embers lean inside it.
    () => {
      session.instrument.brush.at(10, 0).with({
        direction: [1, 0.12], force: 0.9, gust: 0.5, radius: 10, seed: 0xb205,
      });
    },
    // 03-seed: plant a rock-cluster; the math grows the stone.
    () => {
      const gy = groundAt(-12, 8);
      const planted = session.instrument.seed('rock-cluster').at(-12, gy + 1.0, 8).plant(0x20cc07);
      rockEntityId = planted.id;
    },
    // 04-rhythm: the rhythm quickens over the ember field.
    () => {
      session.instrument.rhythm.at(0, 10).with({
        emberTempo: 0.9, moteEnergy: 0.85, radius: 16,
      });
    },
    // 05-behavior: the stone learns to breathe. Compiled browser-locally
    // (see behavior-browser.ts); the op is emitted byte-identical to
    // BuildSession.emitOp: same fields, same chain position.
    () => {
      const handle: EntityHandle | null = runtime.hostHandle(rockEntityId);
      if (!handle) throw new Error('workshop: seeded rock entity is gone');
      const name = `behavior-${rockEntityId}-0`;
      const def: ScriptDef = makeBehaviorDef(name, BREATH_SOURCE, handle);
      runtime.load(def, { grants: BEHAVIOR_GRANTS });
      const seq = session.ops.length;
      const prev = seq === 0 ? GENESIS_PREV : opHash(session.ops[seq - 1]);
      const payload: JSONValue = { name, body: BREATH_SOURCE, entity: handle.name };
      if (validatePayload(OP_BUILD_SCRIPT, payload) !== null) {
        throw new Error('workshop: behavior op payload failed validation');
      }
      const op: BuildOp = {
        v: 1, op: OP_BUILD_SCRIPT, actor: session.actor, seq,
        seed: session.seed, t: seq + 1, payload, prev,
      };
      const shape = validateOpShape(op);
      if (!shape.ok) throw new Error('workshop: behavior op failed shape check: ' + shape.reason);
      session.ops.push(op);
    },
    // 06-convergence: two StateNodes, one local, one simulated remote that
    // received the same ops in shuffled order. Same seed + same op set =
    // same state, whatever the arrival order. The hashes must match.
    () => {
      const local = new StateNode(WS_SEED, 'workshop-local');
      const remote = new StateNode(WS_SEED, 'workshop-remote');
      local.merge(session.ops);
      const shuffled = [...session.ops];
      const srng = mulberry32(WS_SEED ^ 0xc0e);
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(srng() * (i + 1));
        const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
      }
      remote.merge(shuffled);
      const hL = local.hash();
      const hR = remote.hash();
      const n = session.ops.length;
      nodeLocalEl.innerHTML = '';
      nodeLocalEl.append(
        'workshop-local', document.createElement('br'),
        `${n} ops`, document.createElement('br'),
      );
      const h1 = document.createElement('span'); h1.className = 'h'; h1.textContent = hL;
      nodeLocalEl.append('state ', h1);
      nodeRemoteEl.innerHTML = '';
      nodeRemoteEl.append(
        'workshop-remote (shuffled)', document.createElement('br'),
        `${n} ops`, document.createElement('br'),
      );
      const h2 = document.createElement('span'); h2.className = 'h'; h2.textContent = hR;
      nodeRemoteEl.append('state ', h2);
      verdictEl.textContent = hL === hR
        ? 'IDENTICAL · two builders, one ocean'
        : 'DIVERGED · this should not happen';
      convEl.style.display = 'block';
    },
  ];

  const applyPhase = (n: number): void => {
    frozen = false;
    if (!applied[n - 1]) {
      applied[n - 1] = true;
      phaseFns[n - 1]();
    }
    showCaption(CAPTIONS[n - 1]);
  };
  (window as unknown as { __wsPhase: (n: number) => void }).__wsPhase = (n: number) => {
    const target = Math.max(1, Math.min(6, Math.floor(n)));
    while (phase < target) { phase += 1; applyPhase(phase); }
  };
  (window as unknown as { __ws: unknown }).__ws = {
    errors: () => [...errors],
    phase: () => phase,
    opCount: () => session.ops.length,
    ground: (x: number, z: number) => groundAt(x, z),
    simTime: () => tSim,
  };

  // ---- V7 opt-in anchoring panel ----
  // The concrete chain adapter is loaded ONLY when the user opens this
  // panel: a dynamic import, never in the core bundle path. The module
  // shape below matches src/own/evm.ts (the parallel V7 workstream):
  // an EvmAdapter class taking EvmAdapterConfig, plus browserProvider()
  // and fetchTransport() helpers. Only these three are assumed.
  const ADAPTER_MODULE_PATH = '../../src/own/evm.js';
  interface EvmAdapterModule {
    EvmAdapter: new (cfg: EvmAdapterConfig) => ChainAdapter;
    browserProvider: () => Eip1193Provider;
    fetchTransport: (rpcUrl: string) => Eip1193Provider;
  }
  let adapterModulePromise: Promise<EvmAdapterModule> | null = null;
  function loadAdapterModule(): Promise<EvmAdapterModule> {
    if (!adapterModulePromise) {
      const path: string = ADAPTER_MODULE_PATH;
      // @vite-ignore keeps the concrete adapter out of the core bundle:
      // it resolves at runtime, only after the user opts in.
      adapterModulePromise = (import(/* @vite-ignore */ path) as Promise<EvmAdapterModule>)
        .catch((e: unknown) => {
          adapterModulePromise = null;
          throw e;
        });
    }
    return adapterModulePromise;
  }

  const CHAIN_NAMES: Record<string, string> = {
    'eip155:1': 'Ethereum',
    custom: 'Custom EVM',
  };

  const chipEl = document.getElementById('anchor-chip') as HTMLDivElement;
  const panelEl = document.getElementById('anchor-panel') as HTMLDivElement;
  const authorInput = document.getElementById('anchor-author') as HTMLInputElement;
  const mintBtn = document.getElementById('anchor-mint') as HTMLButtonElement;
  const mintInfo = document.getElementById('anchor-mint-info') as HTMLParagraphElement;
  const chainStep = document.getElementById('anchor-chain-step') as HTMLDivElement;
  const chainSel = document.getElementById('anchor-chain') as HTMLSelectElement;
  const rpcInput = document.getElementById('anchor-rpc') as HTMLInputElement;
  const contractInput = document.getElementById('anchor-contract') as HTMLInputElement;
  const chainIdLabel = document.getElementById('anchor-chainid-label') as HTMLLabelElement;
  const chainIdInput = document.getElementById('anchor-chainid') as HTMLInputElement;
  const connectBtn = document.getElementById('anchor-connect') as HTMLButtonElement;
  const costEl = document.getElementById('anchor-cost') as HTMLDivElement;
  const confirmBtn = document.getElementById('anchor-confirm') as HTMLButtonElement;
  const cancelBtn = document.getElementById('anchor-cancel') as HTMLButtonElement;
  const stepsEl = document.getElementById('anchor-steps') as HTMLUListElement;
  const msgEl = document.getElementById('anchor-msg') as HTMLDivElement;
  const receiptEl = document.getElementById('anchor-receipt') as HTMLDivElement;
  const closeBtn = document.getElementById('anchor-close') as HTMLButtonElement;

  let currentMint: MintManifest | null = null;
  let flow: AnchorFlow | null = null;

  function panelMsg(text: string, ok = false): void {
    msgEl.textContent = text;
    msgEl.className = ok ? 'ok' : '';
  }

  function showReceipt(): void {
    const r = flow?.getReceipt();
    if (!r) return;
    receiptEl.innerHTML = '';
    const rows: Array<[string, string]> = [
      ['tx hash', r.txHash],
      ['chain', r.chainId],
      ['token id', r.tokenId],
      ['mint id', r.manifestId],
      ['anchored at', r.anchoredAt],
    ];
    for (const [k, v] of rows) {
      const div = document.createElement('div');
      const ks = document.createElement('span');
      ks.className = 'k';
      ks.textContent = k + ': ';
      div.append(ks, v);
      receiptEl.appendChild(div);
    }
    panelMsg('anchored. The receipt above is your on chain timestamp; the full math stays off chain.', true);
    confirmBtn.style.display = 'none';
    cancelBtn.style.display = 'none';
    closeBtn.style.display = 'block';
  }

  chipEl.addEventListener('click', () => {
    panelEl.style.display = 'block';
    // Lazy-load the adapter module on first open; say plainly if it fails.
    void loadAdapterModule().catch(() => {
      panelMsg('the adapter module failed to load. Your mint still works off chain; anchoring needs the module.');
    });
  });

  chainSel.addEventListener('change', () => {
    const custom = chainSel.value === 'custom';
    chainIdLabel.style.display = custom ? 'block' : 'none';
    chainIdInput.style.display = custom ? 'block' : 'none';
  });

  // Step 1: mint the session's current work off chain (free, $0).
  mintBtn.addEventListener('click', () => {
    panelMsg('');
    try {
      const ops = session.ops;
      if (ops.length === 0) {
        throw new Error('shape the world first: advance a phase so there is math to mint');
      }
      const provenance = buildProvenance(ops);
      const entityIds = Object.keys(provenance.entities);
      if (entityIds.length === 0) {
        throw new Error('the session has ops but no entities to claim yet');
      }
      const author = authorInput.value.trim() || 'workshop-builder';
      const seedBytes = new Uint8Array(32);
      crypto.getRandomValues(seedBytes);
      const kp = generateKeypair(seedBytes);
      const manifest = createMint({
        author,
        authorKey: toHex(kp.publicKey),
        seed: WS_SEED,
        entityIds,
        provenance,
        ops,
        license: LICENSE_OPEN,
        secretKey: kp.secretKey,
      });
      const check = verifyMint(manifest);
      if (!check.ok) throw new Error('mint self-check failed: ' + check.reason);
      currentMint = manifest;
      mintInfo.textContent =
        'minted ' + manifest.id + ' (' + entityIds.length + ' entities, signature verified)';
      mintInfo.style.color = '#4ade80';
      chainStep.style.display = 'block';
      panelMsg('mint ready. Pick a chain and connect your wallet when you want to anchor it.', true);
    } catch (e) {
      errors.push('anchor mint: ' + (e as Error).message);
      panelMsg((e as Error).message);
    }
  });

  // Step 2: connect the wallet and get the cost quote. Stops at
  // awaiting-confirm: nothing is submitted until the user confirms.
  connectBtn.addEventListener('click', async () => {
    panelMsg('');
    if (!currentMint) { panelMsg('mint your current work first'); return; }
    const preset = chainSel.value;
    let chainId = preset;
    if (preset === 'custom') {
      chainId = chainIdInput.value.trim();
      if (!chainId) {
        panelMsg('for a custom chain, enter its chain id (for example eip155:137). The panel never guesses it for you.');
        return;
      }
    }
    connectBtn.disabled = true;
    try {
      const mod = await loadAdapterModule();
      // No bundled endpoints: the wallet is the user's own (browser
      // wallet by default), or the RPC URL they paste themselves.
      const rpcUrl = rpcInput.value.trim();
      const transport = rpcUrl ? mod.fetchTransport(rpcUrl) : mod.browserProvider();
      const cfg: EvmAdapterConfig = {
        chainId,
        chainName: CHAIN_NAMES[preset] ?? 'Custom EVM',
        transport,
      };
      const contract = contractInput.value.trim();
      if (contract) cfg.contractAddress = contract;
      const adapter = new mod.EvmAdapter(cfg);
      flow = new AnchorFlow(adapter);
      stepsEl.innerHTML = '';
      flow.onTransition((t) => {
        const li = document.createElement('li');
        li.textContent = t.state + (t.detail ? ' · ' + t.detail : '');
        li.className = t.state === 'failed' ? 'bad' : (t.state === 'done' ? 'hit' : '');
        stepsEl.appendChild(li);
        if (t.state === 'awaiting-confirm') {
          const cost = flow?.getCost();
          if (cost) {
            costEl.textContent = 'cost: ' + cost.amount + ' ' + cost.feeToken;
            confirmBtn.style.display = 'block';
            cancelBtn.style.display = 'block';
            panelMsg(
              'This is the quoted gas cost. Confirming submits the anchor and spends ' +
              cost.amount + ' ' + cost.feeToken +
              ' from your wallet. The engine never spends without this confirmation.',
              true,
            );
          }
        } else if (t.state === 'done') {
          showReceipt();
        } else if (t.state === 'failed') {
          panelMsg(flow?.getFailureReason() ?? 'anchor failed');
          confirmBtn.style.display = 'none';
          cancelBtn.style.display = 'none';
          closeBtn.style.display = 'block';
        }
      });
      await flow.start(currentMint);
    } catch (e) {
      errors.push('anchor connect: ' + (e as Error).message);
      panelMsg((e as Error).message);
      connectBtn.disabled = false;
    }
  });

  // Step 3: the explicit, informed confirm. The flow machine cannot
  // reach this state any other way.
  confirmBtn.addEventListener('click', async () => {
    if (!flow) return;
    confirmBtn.disabled = true;
    cancelBtn.style.display = 'none';
    panelMsg('submitting. Your wallet may ask for a signature; nothing is final until the chain confirms.', true);
    try {
      await flow.confirm();
    } catch (e) {
      panelMsg((e as Error).message);
    }
    confirmBtn.disabled = false;
  });

  cancelBtn.addEventListener('click', async () => {
    if (!flow) return;
    await flow.cancel();
    panelMsg('cancelled. Nothing was submitted.', true);
    confirmBtn.style.display = 'none';
    cancelBtn.style.display = 'none';
    closeBtn.style.display = 'block';
  });

  closeBtn.addEventListener('click', async () => {
    if (flow) {
      try { await flow.reset(); } catch { /* already idle */ }
    }
    flow = null;
    panelEl.style.display = 'none';
    connectBtn.disabled = false;
    confirmBtn.style.display = 'none';
    cancelBtn.style.display = 'none';
    closeBtn.style.display = 'none';
    costEl.textContent = '';
    panelMsg('');
    receiptEl.innerHTML = '';
    stepsEl.innerHTML = '';
  });

  // ---- Frame loop ----
  const inline = new InlineProvider(camNode, camera);
  let lastT = performance.now();
  let acc = 0;

  const frame: FrameCallback = (views: RenderView[], t: number) => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;

    // Fixed-step ember clock: the same simTime always means the same sky.
    // Frozen after a deterministic settle (headless capture).
    if (!frozen) {
      acc += dt;
      let steps = 0;
      while (acc >= SIM_H && steps < 24) { stepEmbers(SIM_H); acc -= SIM_H; steps += 1; }
      if (steps >= 24) acc = 0;
    } else {
      acc = 0;
    }

    runtime.update(dt, tSim);
    writeParticles(emberGeo, embers, EMBER_SIZE);
    emberGeo.version = (emberGeo.version ?? 0) + 1;

    root.updateWorldMatrix(null);
    root.update(dt, tSim);
    renderer.render(root, camera, camNode, views, tSim);

    if (captionTimer > 0) {
      captionTimer -= dt;
      if (captionTimer <= 0) captionEl.style.opacity = '0';
    }
  };

  const current = await inline.requestSession('inline', canvas);
  current.onFrame(frame);

  setTimeout(() => { titleEl.style.opacity = '0.85'; }, 100);
  (window as unknown as { __wsReady: boolean }).__wsReady = true;
}

void main().catch((e) => {
  errors.push('boot: ' + (e as Error).message);
  const el = document.getElementById('err');
  if (el) { el.style.display = 'block'; el.textContent = 'boot failed: ' + (e as Error).message; }
});
