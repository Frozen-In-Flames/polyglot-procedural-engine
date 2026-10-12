// own/flow.ts - the V7 anchoring flow: a UI-agnostic state machine.
//
// The engine never touches a chain on its own. Anchoring is always the
// user's explicit act: they pick a chain, connect their own wallet, see
// the quoted cost, and confirm. This file is the pure logic of that flow:
// states, transitions, and the inviolable ordering that makes it safe.
//
// Inviolable rules:
// - The machine MUST NOT advance past `awaiting-confirm` without an
//   explicit `confirm()` call from the UI layer. The user always sees the
//   cost before anything is submitted: the engine never signs or spends
//   silently.
// - Every transition is recorded with a timestamp so the UI can render
//   the full history.
// - Failure paths disconnect the adapter: no dangling wallet sessions.
// - `reset()` always returns the machine to `idle`.
//
// Pure logic: no DOM, no wallet, no network in this file. The only
// external calls are the ChainAdapter interface methods (injected), so
// this machine works with any present or future chain adapter.

import type { AnchorCost, AnchorReceipt, ChainAdapter } from './chain.js';
import type { MintManifest } from './mint.js';

/**
 * The flow's states, in order:
 * idle -> connecting -> estimating -> awaiting-confirm -> submitting ->
 * confirming -> done, with failed(reason) reachable from any active step.
 */
export type AnchorFlowState =
  | 'idle'
  | 'connecting'
  | 'estimating'
  | 'awaiting-confirm'
  | 'submitting'
  | 'confirming'
  | 'done'
  | 'failed';

/** One recorded state transition, with an ISO-8601 timestamp. */
export interface AnchorTransition {
  state: AnchorFlowState;
  at: string;
  detail?: string;
}

/** Well-known failure reasons (adapters may add their own wording). */
export const FAIL_USER_CANCELLED = 'user cancelled';
export const FAIL_ANCHOR_TIMEOUT = 'anchor timed out before a receipt arrived';
export const FAIL_RECEIPT_UNVERIFIED = 'the receipt did not verify against this mint';
export const FAIL_RECEIPT_WRONG_MINT = 'the receipt names a different mint id';

export interface AnchorFlowOpts {
  /**
   * Milliseconds to wait for the adapter's anchor() before failing.
   * A hung wallet prompt or a stuck transaction must not wedge the UI
   * forever. Default 120000.
   */
  submitTimeoutMs?: number;
  /** Clock for transition timestamps; injectable for tests. Defaults to ISO now. */
  now?: () => string;
}

/**
 * The anchoring flow. Construct with a ChainAdapter (or a factory that
 * makes one), then drive it: start(mint) -> confirm() -> done|failed.
 * Subscribe to transitions for UI rendering.
 */
export class AnchorFlow {
  private readonly makeAdapter: () => ChainAdapter;
  private readonly submitTimeoutMs: number;
  private readonly now: () => string;

  private adapter: ChainAdapter | null = null;
  private connected = false;
  private state: AnchorFlowState = 'idle';
  private manifest: MintManifest | null = null;
  private cost: AnchorCost | null = null;
  private receipt: AnchorReceipt | null = null;
  private failureReason: string | null = null;
  private readonly log: AnchorTransition[] = [];
  private readonly listeners = new Set<(t: AnchorTransition) => void>();

  constructor(adapterOrFactory: ChainAdapter | (() => ChainAdapter), opts?: AnchorFlowOpts) {
    if (typeof adapterOrFactory === 'function') {
      this.makeAdapter = adapterOrFactory;
    } else if (adapterOrFactory && typeof (adapterOrFactory as ChainAdapter).connect === 'function') {
      const a = adapterOrFactory;
      this.makeAdapter = () => a;
    } else {
      throw new Error('flow: need a ChainAdapter or a factory that makes one');
    }
    const t = opts?.submitTimeoutMs;
    this.submitTimeoutMs = t === undefined ? 120000 : t;
    if (!Number.isFinite(this.submitTimeoutMs) || this.submitTimeoutMs <= 0) {
      throw new Error('flow: submitTimeoutMs must be a positive number');
    }
    this.now = opts?.now ?? (() => new Date().toISOString());
  }

  /** Current state. */
  getState(): AnchorFlowState { return this.state; }
  /** The mint being anchored (set once start() accepts it). */
  getManifest(): MintManifest | null { return this.manifest; }
  /** The quoted cost (set when the flow reaches awaiting-confirm). */
  getCost(): AnchorCost | null { return this.cost; }
  /** The anchor receipt (set when the flow reaches done). */
  getReceipt(): AnchorReceipt | null { return this.receipt; }
  /** Why the flow failed (set when the state is failed). */
  getFailureReason(): string | null { return this.failureReason; }
  /** Full transition history, oldest first. */
  getTransitions(): AnchorTransition[] { return [...this.log]; }

  /**
   * Subscribe to transitions (state, timestamp, detail). Returns an
   * unsubscribe function. The subscriber is called synchronously on
   * every transition.
   */
  onTransition(cb: (t: AnchorTransition) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /**
   * Begin the flow: connect the wallet, then quote the cost, then stop
   * at awaiting-confirm. Only valid from idle. Nothing is submitted here:
   * the UI must call confirm() after showing the user the cost.
   */
  async start(manifest: MintManifest): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`flow: start() only valid from idle, not '${this.state}'`);
    }
    if (!manifest || typeof manifest.id !== 'string') {
      throw new Error('flow: start() needs a mint manifest');
    }
    this.manifest = manifest;
    this.adapter = this.makeAdapter();

    this.enter('connecting');
    try {
      await this.adapter.connect();
      this.connected = true;
    } catch (err) {
      await this.fail(`wallet connection failed: ${messageOf(err)}`);
      return;
    }

    this.enter('estimating');
    try {
      this.cost = await this.adapter.estimateCost(manifest);
    } catch (err) {
      await this.fail(`cost estimate failed: ${messageOf(err)}`);
      return;
    }

    // The inviolable stop: no path out of here except confirm(), cancel(),
    // or reset(). The user sees the cost before anything is submitted.
    this.enter('awaiting-confirm', costSummary(this.cost));
  }

  /**
   * The user saw the cost and said yes. Only valid from awaiting-confirm:
   * this is the single gate the machine cannot pass on its own.
   */
  async confirm(): Promise<void> {
    if (this.state !== 'awaiting-confirm') {
      throw new Error(`flow: confirm() only valid from awaiting-confirm, not '${this.state}'`);
    }
    const adapter = this.adapter;
    const manifest = this.manifest;
    if (!adapter || !manifest) {
      await this.fail('flow: no adapter or manifest (this should not happen)');
      return;
    }

    this.enter('submitting');
    let receipt: AnchorReceipt;
    try {
      receipt = await withTimeout(
        adapter.anchor(manifest),
        this.submitTimeoutMs,
        new Error(FAIL_ANCHOR_TIMEOUT),
      );
    } catch (err) {
      await this.fail(`anchor failed: ${messageOf(err)}`);
      return;
    }

    // The receipt must name the mint we asked to anchor. The adapter
    // contract requires it; check anyway, because money is involved.
    if (receipt.manifestId !== manifest.id) {
      await this.fail(FAIL_RECEIPT_WRONG_MINT);
      return;
    }

    this.enter('confirming', `tx ${receipt.txHash}`);
    let verified: boolean;
    try {
      verified = await adapter.verifyAnchor(receipt, manifest);
    } catch (err) {
      await this.fail(`receipt verification failed: ${messageOf(err)}`);
      return;
    }
    if (!verified) {
      await this.fail(FAIL_RECEIPT_UNVERIFIED);
      return;
    }

    this.receipt = receipt;
    this.enter('done', `tx ${receipt.txHash}`);
    // Stay connected on success: the user may anchor another mint.
  }

  /**
   * The user changed their mind before confirming. Only valid from
   * awaiting-confirm. Nothing was submitted, so there is nothing to undo;
   * the wallet session is closed as a courtesy.
   */
  async cancel(): Promise<void> {
    if (this.state !== 'awaiting-confirm') {
      throw new Error(`flow: cancel() only valid from awaiting-confirm, not '${this.state}'`);
    }
    await this.fail(FAIL_USER_CANCELLED);
  }

  /**
   * Back to idle from any state. Closes the wallet session if one is
   * open, and clears the manifest, cost, receipt, and failure reason.
   */
  async reset(): Promise<void> {
    await this.disconnectQuiet();
    this.manifest = null;
    this.cost = null;
    this.receipt = null;
    this.failureReason = null;
    this.enter('idle');
  }

  private enter(state: AnchorFlowState, detail?: string): void {
    this.state = state;
    const t: AnchorTransition = { state, at: this.now() };
    if (detail !== undefined) t.detail = detail;
    this.log.push(t);
    for (const cb of this.listeners) {
      try { cb(t); } catch { /* a listener must never break the flow */ }
    }
  }

  /** Failure paths always land here: record, disconnect, stop. */
  private async fail(reason: string): Promise<void> {
    this.failureReason = reason;
    await this.disconnectQuiet();
    this.enter('failed', reason);
  }

  /** Best-effort disconnect: adapter.disconnect() may itself throw. */
  private async disconnectQuiet(): Promise<void> {
    if (this.connected && this.adapter) {
      try { await this.adapter.disconnect(); } catch { /* already failing */ }
    }
    this.connected = false;
    this.adapter = null;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function costSummary(cost: AnchorCost): string {
  return `${cost.amount} ${cost.feeToken}`;
}

/**
 * Race a promise against a timeout. The underlying promise is NOT
 * cancelled (promises cannot be); on timeout we fail the flow and
 * disconnect, and any late settlement is ignored.
 */
function withTimeout<T>(p: Promise<T>, ms: number, timeoutError: Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
