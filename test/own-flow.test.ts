// Unit tests for own/flow.ts: the V7 anchoring flow state machine (runs in node).
// Driven by a mock ChainAdapter, so no wallet, no chain, no network.
// (a) happy path: idle -> connecting -> estimating -> awaiting-confirm ->
//     submitting -> confirming -> done, with cost and receipt captured;
// (b) the inviolable gate: start() ends at awaiting-confirm and only
//     confirm() advances past it; confirm()/cancel() throw elsewhere;
// (c) user-cancel at awaiting-confirm: anchor never called, adapter disconnected;
// (d) connect failure, estimate failure: failed(reason), adapter disconnected;
// (e) anchor rejection (user denied in wallet): failed, adapter disconnected;
// (f) receipt timeout: a hung anchor() fails after submitTimeoutMs, disconnected;
// (g) verifyAnchor false: failed, not done;
// (h) reset() returns to idle and clears; every transition has a timestamp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOp } from '../src/state/index.js';
import { buildProvenance } from '../src/own/provenance.js';
import { generateKeypair, toHex } from '../src/own/ed25519.js';
import { LICENSE_OPEN, createMint } from '../src/own/mint.js';
import type { MintManifest } from '../src/own/mint.js';
import type { AnchorCost, AnchorReceipt, ChainAdapter } from '../src/own/chain.js';
import {
  AnchorFlow, FAIL_USER_CANCELLED, FAIL_ANCHOR_TIMEOUT,
  type AnchorFlowState, type AnchorTransition,
} from '../src/own/flow.js';
import type { BuildOp, JSONValue } from '../src/state/index.js';

const SEED = 20261012;

function mkOp(op: string, actor: string, seq: number, t: number, payload: JSONValue): BuildOp {
  return createOp(op, actor, seq, SEED, t, payload, seq === 0 ? 'genesis' : actor + '-prev-' + (seq - 1));
}

function demoKeypair() {
  const seedBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seedBytes[i] = (i * 7 + 3) & 0xff;
  return generateKeypair(seedBytes);
}

/** A real signed mint the mock adapter can "anchor". */
function demoMint(): MintManifest {
  const ops = [
    mkOp('build.brush', 'alice', 0, 1, { id: 'b1', pos: [1, 2, 3] }),
    mkOp('build.seed', 'alice', 1, 2, { id: 's1', kind: 'spire', pos: [4, 0, 5], seed: 7 }),
  ];
  const kp = demoKeypair();
  return createMint({
    author: 'alice',
    authorKey: toHex(kp.publicKey),
    seed: SEED,
    entityIds: ['s1'],
    provenance: buildProvenance(ops),
    ops,
    license: LICENSE_OPEN,
    secretKey: kp.secretKey,
  });
}

interface MockBehavior {
  connectError?: string;
  estimateError?: string;
  anchorError?: string;
  /** When true, anchor() never settles (tests the timeout). */
  anchorHangs?: boolean;
  /** When false, verifyAnchor() reports the receipt as bogus. */
  verifyOk?: boolean;
  receiptOverrides?: Partial<AnchorReceipt>;
}

/** A controllable fake ChainAdapter that records every call. */
class MockAdapter implements ChainAdapter {
  readonly chainId = 'eip155:1';
  readonly chainName = 'Mockchain';
  calls: string[] = [];
  disconnected = false;
  constructor(private behavior: MockBehavior = {}) {}

  async connect(): Promise<void> {
    this.calls.push('connect');
    if (this.behavior.connectError) throw new Error(this.behavior.connectError);
  }
  async disconnect(): Promise<void> {
    this.calls.push('disconnect');
    this.disconnected = true;
  }
  async estimateCost(_manifest: MintManifest): Promise<AnchorCost> {
    this.calls.push('estimateCost');
    if (this.behavior.estimateError) throw new Error(this.behavior.estimateError);
    return { feeToken: 'ETH', amount: '0.00042' };
  }
  async anchor(manifest: MintManifest): Promise<AnchorReceipt> {
    this.calls.push('anchor');
    if (this.behavior.anchorError) throw new Error(this.behavior.anchorError);
    if (this.behavior.anchorHangs) return new Promise<AnchorReceipt>(() => undefined);
    return {
      chainId: this.chainId,
      txHash: '0xdeadbeef',
      tokenId: 'tok-7',
      anchoredAt: new Date().toISOString(),
      manifestId: manifest.id,
      ...this.behavior.receiptOverrides,
    };
  }
  async verifyAnchor(_receipt: AnchorReceipt, _manifest: MintManifest): Promise<boolean> {
    this.calls.push('verifyAnchor');
    return this.behavior.verifyOk ?? true;
  }
}

function states(log: AnchorTransition[]): AnchorFlowState[] {
  return log.map((t) => t.state);
}

test('happy path reaches done with cost and receipt, in order', async () => {
  const adapter = new MockAdapter();
  const flow = new AnchorFlow(adapter);
  const seen: AnchorTransition[] = [];
  flow.onTransition((t) => seen.push(t));

  const mint = demoMint();
  await flow.start(mint);
  assert.equal(flow.getState(), 'awaiting-confirm');
  assert.deepEqual(flow.getCost(), { feeToken: 'ETH', amount: '0.00042' });
  assert.equal(flow.getManifest()?.id, mint.id);

  await flow.confirm();
  assert.equal(flow.getState(), 'done');
  const receipt = flow.getReceipt();
  assert.ok(receipt);
  assert.equal(receipt.txHash, '0xdeadbeef');
  assert.equal(receipt.tokenId, 'tok-7');
  assert.equal(receipt.chainId, 'eip155:1');
  assert.equal(receipt.manifestId, mint.id);

  assert.deepEqual(states(seen), [
    'connecting', 'estimating', 'awaiting-confirm',
    'submitting', 'confirming', 'done',
  ]);
  // Every transition carries an ISO-8601 timestamp.
  for (const t of seen) {
    assert.match(t.state, /^[a-z-]+$/);
    assert.ok(!Number.isNaN(Date.parse(t.at)), `bad timestamp: ${t.at}`);
  }
  // The estimate call happened before confirm; anchor only after.
  assert.ok(adapter.calls.indexOf('estimateCost') < adapter.calls.indexOf('anchor'));
});

test('the gate: start() stops at awaiting-confirm; nothing submits without confirm()', async () => {
  const adapter = new MockAdapter();
  const flow = new AnchorFlow(adapter);
  await flow.start(demoMint());
  assert.equal(flow.getState(), 'awaiting-confirm');
  assert.ok(!adapter.calls.includes('anchor'), 'anchor must not run before confirm()');
  // A tick of time with no confirm() must not advance the machine.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(flow.getState(), 'awaiting-confirm');
  assert.ok(!adapter.calls.includes('anchor'));
});

test('confirm() and cancel() throw outside their valid states', async () => {
  const flow = new AnchorFlow(new MockAdapter());
  await assert.rejects(flow.confirm(), /awaiting-confirm/);
  await assert.rejects(flow.cancel(), /awaiting-confirm/);
  await assert.rejects(flow.start(demoMint()).then(() => flow.start(demoMint())), /idle/);
});

test('user-cancel at awaiting-confirm: nothing submitted, adapter disconnected', async () => {
  const adapter = new MockAdapter();
  const flow = new AnchorFlow(adapter);
  await flow.start(demoMint());
  await flow.cancel();
  assert.equal(flow.getState(), 'failed');
  assert.equal(flow.getFailureReason(), FAIL_USER_CANCELLED);
  assert.ok(!adapter.calls.includes('anchor'), 'anchor must not run after cancel');
  assert.ok(adapter.disconnected, 'failure paths must disconnect');
});

test('connect failure: failed with the adapter reason, never estimated', async () => {
  const adapter = new MockAdapter({ connectError: 'no wallet found' });
  const flow = new AnchorFlow(adapter);
  await flow.start(demoMint());
  assert.equal(flow.getState(), 'failed');
  assert.match(flow.getFailureReason() ?? '', /no wallet found/);
  assert.ok(!adapter.calls.includes('estimateCost'));
  assert.ok(!adapter.calls.includes('anchor'));
});

test('estimate failure: failed, adapter disconnected', async () => {
  const adapter = new MockAdapter({ estimateError: 'rpc is down' });
  const flow = new AnchorFlow(adapter);
  await flow.start(demoMint());
  assert.equal(flow.getState(), 'failed');
  assert.match(flow.getFailureReason() ?? '', /rpc is down/);
  assert.ok(adapter.disconnected, 'failure paths must disconnect');
  assert.ok(!adapter.calls.includes('anchor'));
});

test('anchor rejection (user denied in wallet): failed, adapter disconnected', async () => {
  const adapter = new MockAdapter({ anchorError: 'user denied transaction signature' });
  const flow = new AnchorFlow(adapter);
  await flow.start(demoMint());
  await flow.confirm();
  assert.equal(flow.getState(), 'failed');
  assert.match(flow.getFailureReason() ?? '', /user denied/);
  assert.ok(adapter.disconnected, 'failure paths must disconnect');
  assert.equal(flow.getReceipt(), null);
});

test('receipt timeout: a hung anchor fails after submitTimeoutMs', async () => {
  const adapter = new MockAdapter({ anchorHangs: true });
  const flow = new AnchorFlow(adapter, { submitTimeoutMs: 60 });
  await flow.start(demoMint());
  await flow.confirm();
  assert.equal(flow.getState(), 'failed');
  assert.equal(flow.getFailureReason(), `anchor failed: ${FAIL_ANCHOR_TIMEOUT}`);
  assert.ok(adapter.disconnected, 'failure paths must disconnect');
});

test('verifyAnchor false: failed, never done', async () => {
  const adapter = new MockAdapter({ verifyOk: false });
  const flow = new AnchorFlow(adapter);
  await flow.start(demoMint());
  await flow.confirm();
  assert.equal(flow.getState(), 'failed');
  assert.match(flow.getFailureReason() ?? '', /did not verify/);
  assert.equal(flow.getReceipt(), null);
});

test('receipt for a different mint id: failed', async () => {
  const adapter = new MockAdapter({ receiptOverrides: { manifestId: 'wrong-id' } });
  const flow = new AnchorFlow(adapter);
  await flow.start(demoMint());
  await flow.confirm();
  assert.equal(flow.getState(), 'failed');
  assert.match(flow.getFailureReason() ?? '', /different mint id/);
});

test('reset() returns to idle and clears everything', async () => {
  const adapter = new MockAdapter({ anchorError: 'denied' });
  const flow = new AnchorFlow(adapter);
  await flow.start(demoMint());
  await flow.confirm();
  assert.equal(flow.getState(), 'failed');
  await flow.reset();
  assert.equal(flow.getState(), 'idle');
  assert.equal(flow.getManifest(), null);
  assert.equal(flow.getCost(), null);
  assert.equal(flow.getReceipt(), null);
  assert.equal(flow.getFailureReason(), null);
  // The flow is reusable after reset.
  const adapter2 = new MockAdapter();
  const flow2 = new AnchorFlow(adapter2);
  await flow2.start(demoMint());
  assert.equal(flow2.getState(), 'awaiting-confirm');
});

test('adapter factory injection works the same as an instance', async () => {
  const adapter = new MockAdapter();
  const flow = new AnchorFlow(() => adapter);
  await flow.start(demoMint());
  await flow.confirm();
  assert.equal(flow.getState(), 'done');
});
