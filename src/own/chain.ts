// own/chain.ts - CHAIN ADAPTER INTERFACE ONLY (V6 step 5, V7 implements).
//
// The engine never depends on a chain. Ownership is fully off-chain: a
// mint is a signed manifest and the registry is a signed list, both
// verifiable by anyone with nothing but the bytes. A chain can only ever
// be a mirror: an optional, user-selected place to anchor a hash so a
// mint's existence is timestamped in public.
//
// ChainAdapter is the thin plug V7 will build one-per-chain (EVM first,
// then whatever the user picks). The engine calls nothing here by
// itself; the user brings their own adapter, connects their own wallet,
// and pays their own gas. The platform stays $0; the chain bill is the
// user's, on the chain they chose.
//
// This file is types only: no runtime code, no imports, no wallet, no
// network. A V7 adapter must verify its own network calls and surface
// errors as rejected promises, never as silent fallbacks.

import type { MintManifest } from './mint.js';

/** Proof that a mint's id was anchored on a chain, returned by the adapter. */
export interface AnchorReceipt {
  /** Chain identifier, e.g. 'eip155:1' or the chain's own naming. */
  chainId: string;
  /** The transaction hash that carried the anchor. */
  txHash: string;
  /** Token or record id the chain assigned the anchor, if any. */
  tokenId: string;
  /** ISO-8601 time the anchor was confirmed. */
  anchoredAt: string;
  /** The mint id this receipt anchors. Must equal the manifest's id. */
  manifestId: string;
}

/** Cost estimate for anchoring one mint, quoted by the adapter. */
export interface AnchorCost {
  /** Fee token symbol, e.g. 'ETH'. */
  feeToken: string;
  /** Amount as a decimal string (never a float: precision matters). */
  amount: string;
}

/**
 * The contract between the engine and any chain. V7 implements this per
 * chain. Notes for implementers:
 *
 * - connect() opens the user's wallet/session; the engine stores no keys.
 * - estimateCost() quotes gas in the fee token BEFORE anchor() is called,
 *   so the user always sees the price before they pay it.
 * - anchor() writes the mint id (and only the mint id plus the license
 *   summary) to the chain; the full manifest stays off-chain, where it
 *   is free to copy.
 * - verifyAnchor() re-reads the chain and confirms the receipt's txHash
 *   really anchors the manifest's id. It must return false, not throw,
 *   when the receipt does not match.
 */
export interface ChainAdapter {
  readonly chainId: string;
  readonly chainName: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  estimateCost(manifest: MintManifest): Promise<AnchorCost>;
  anchor(manifest: MintManifest): Promise<AnchorReceipt>;
  verifyAnchor(receipt: AnchorReceipt, manifest: MintManifest): Promise<boolean>;
}
