// own/evm.ts - EVM chain adapter (V7, EVM first).
//
// The engine never depends on a chain: ownership is fully off-chain,
// a mint is a signed manifest, and a chain can only ever be a mirror.
// This adapter plugs one user-selected EVM chain into that mirror role:
// the user connects their own wallet, supplies their own RPC endpoint,
// and pays their own gas. The platform stays $0; the chain bill is the
// user's, on the chain they chose. The engine stores no keys, ever.
//
// Zero new dependencies: raw JSON-RPC through a minimal provider
// interface, hand-rolled keccak256 for ABI selectors, BigInt math for
// all money. Works in a browser (window.ethereum) and in node
// (fetchTransport against the user's own RPC URL).
//
// Anchor modes, honestly:
//  (a) contract mode: the user points the adapter at a mint contract
//      exposing `mint(address,string)`. The adapter ABI-encodes the
//      call, the chain assigns the tokenId (parsed from the ERC-721
//      Transfer event logs), and verifyAnchor re-checks the logs.
//  (b) calldata mode: no contract. A 0-value transaction to the user's
//      own account carries the mint id plus license flags in its data
//      field. tokenId is '' in the receipt: no chain record id exists,
//      and the adapter does not invent one. The tx hash itself is the
//      public timestamp of the mint id.
// The full manifest stays off-chain in both modes: copying it is free,
// so the chain carries only what a chain is good for.

import type { MintManifest, LicenseTerms } from './mint.js';
import type { AnchorReceipt, AnchorCost, ChainAdapter } from './chain.js';

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * The smallest usable wallet/RPC surface: one method, like EIP-1193.
 * Anything that can answer `request` works: window.ethereum, a fetch
 * wrapper around the user's own RPC endpoint, or a mock in tests.
 */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  // Minimal injected-wallet shape. No @types package, no new dependency.
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

/**
 * Return the browser's injected wallet provider. Throws a clear error
 * when there is none: the user connects their own wallet; the engine
 * will never inject or store one for them.
 */
export function browserProvider(): Eip1193Provider {
  const eth =
    typeof window !== 'undefined' ? window.ethereum : undefined;
  if (!eth) {
    throw new Error(
      'evm: no injected wallet found (window.ethereum is missing). ' +
        'Connect a wallet, or use fetchTransport with your own RPC endpoint.',
    );
  }
  return eth;
}

/**
 * JSON-RPC transport over the user's own RPC endpoint. The user supplies
 * the URL; nothing is hardcoded here and nothing is sent anywhere else.
 */
export function fetchTransport(rpcUrl: string): Eip1193Provider {
  if (typeof rpcUrl !== 'string' || rpcUrl.trim().length === 0) {
    throw new Error('evm: fetchTransport needs a non-empty RPC URL');
  }
  let id = 0;
  return {
    async request({ method, params }): Promise<unknown> {
      id += 1;
      let res: Response;
      try {
        res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            params: params ?? [],
          }),
        });
      } catch (e) {
        throw new Error(
          `evm: RPC request '${method}' failed to reach the endpoint: ` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
      if (!res.ok) {
        throw new Error(
          `evm: RPC endpoint answered HTTP ${res.status} for '${method}'`,
        );
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new Error(
          `evm: RPC endpoint returned non-JSON for '${method}'`,
        );
      }
      const b = body as { error?: { code?: unknown; message?: unknown }; result?: unknown };
      if (b && typeof b === 'object' && 'error' in b && b.error != null) {
        const msg =
          typeof (b.error as { message?: unknown }).message === 'string'
            ? (b.error as { message: string }).message
            : 'unknown RPC error';
        throw new Error(`evm: RPC error on '${method}': ${msg}`);
      }
      if (b == null || typeof b !== 'object' || !('result' in b)) {
        throw new Error(
          `evm: RPC endpoint returned a malformed response for '${method}'`,
        );
      }
      return b.result;
    },
  };
}

// ---------------------------------------------------------------------------
// keccak256 (Ethereum's Keccak, not NIST SHA3): the function selector and
// the ERC-721 Transfer event topic are defined by it, so an honest ABI
// encoding needs the real thing. Hand-rolled here to keep the zero
// dependency rule; the test suite checks it against published vectors.
// ---------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;

function rotl64(v: bigint, n: number): bigint {
  if (n === 0) return v & MASK64;
  const b = BigInt(n);
  return (((v << b) | (v >> (64n - b))) & MASK64);
}

/** Rotation offsets r[x][y] of the Keccak state, indexed [x * 5 + y]. */
const KECCAK_ROT = [
  0, 36, 3, 41, 18,
  1, 44, 10, 45, 2,
  62, 6, 43, 15, 61,
  28, 55, 25, 21, 56,
  27, 20, 39, 8, 14,
] as const;

const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
] as const;

function keccakF1600(a: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // Theta.
    const c: bigint[] = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) {
      c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    }
    const d: bigint[] = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) a[x + 5 * y] ^= d[x];
    }
    // Rho + pi combined: walk the 5x5 cycle, rotating each lane by
    // the source lane's offset.
    let x = 1;
    let y = 0;
    let current = a[x + 5 * y];
    for (let t = 0; t < 24; t++) {
      const X = y;
      const Y = (2 * x + 3 * y) % 5;
      const next = a[X + 5 * Y];
      a[X + 5 * Y] = rotl64(current, KECCAK_ROT[x * 5 + y]);
      current = next;
      x = X;
      y = Y;
    }
    // Chi.
    const b = a.slice();
    for (let yy = 0; yy < 5; yy++) {
      for (let xx = 0; xx < 5; xx++) {
        a[xx + 5 * yy] =
          b[xx + 5 * yy] ^
          ((~b[(xx + 1) % 5 + 5 * yy] & MASK64) & b[(xx + 2) % 5 + 5 * yy]);
      }
    }
    // Iota.
    a[0] ^= KECCAK_RC[round];
  }
}

/**
 * keccak256 of bytes, as a hex string without the 0x prefix. This is
 * Ethereum's Keccak-256 (pad 0x01), not NIST SHA3-256 (pad 0x06).
 */
export function keccak256Hex(bytes: Uint8Array): string {
  const RATE = 136; // 1088-bit rate for the 256-bit output.
  const state = new Array<bigint>(25).fill(0n);
  const msg = new Uint8Array(bytes);
  const blocks = Math.max(1, Math.ceil((msg.length + 1) / RATE));
  const padded = new Uint8Array(blocks * RATE);
  padded.set(msg);
  padded[msg.length] = 0x01;
  padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let k = 0; k < 8; k++) {
        lane |= BigInt(padded[off + i * 8 + k]) << BigInt(8 * k);
      }
      state[i] ^= lane;
    }
    keccakF1600(state);
  }
  let out = '';
  for (let i = 0; i < 4; i++) {
    // Lanes serialize little-endian: the least significant byte first.
    let lane = state[i];
    for (let k = 0; k < 8; k++) {
      out += (lane & 0xffn).toString(16).padStart(2, '0');
      lane >>= 8n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small hex / ABI helpers
// ---------------------------------------------------------------------------

function isHexAddress(v: unknown): v is string {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}

function isHexQuantity(v: unknown): v is string {
  return typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v);
}

function hexToBigInt(hex: string, what: string): bigint {
  if (!isHexQuantity(hex)) {
    throw new Error(`evm: expected a hex quantity for ${what}, got '${hex}'`);
  }
  return BigInt(hex);
}

function bigIntToHex(v: bigint): string {
  return '0x' + v.toString(16);
}

function pad32(hexNoPrefix: string): string {
  return hexNoPrefix.toLowerCase().padStart(64, '0');
}

function utf8ToHex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function hexToUtf8(hex: string): string {
  if (!/^0x[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('evm: cannot decode non-hex bytes');
  }
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/** ERC-721 Transfer(address,address,uint256) event topic. */
export const TRANSFER_EVENT_TOPIC =
  '0x' + keccak256Hex(new TextEncoder().encode('Transfer(address,address,uint256)'));

/** The mint function the contract mode speaks to. */
const MINT_SIGNATURE = 'mint(address,string)';
const MINT_SELECTOR = keccak256Hex(new TextEncoder().encode(MINT_SIGNATURE)).slice(0, 8);

/** Calldata-mode data prefix: the anchor payload is plainly readable. */
const CALLDATA_PREFIX = 'xr-own:';

function licenseFlags(license: LicenseTerms): string {
  return (
    'L' +
    (license.use ? '1' : '0') +
    (license.remix ? '1' : '0') +
    (license.commercial ? '1' : '0') +
    (license.resell ? '1' : '0')
  );
}

/**
 * ABI-encode `mint(address,string)` for a contract-mode anchor. Returns
 * the full data payload (selector + encoded args).
 */
export function encodeMintCall(to: string, tokenURI: string): string {
  if (!isHexAddress(to)) {
    throw new Error(`evm: mint recipient '${to}' is not a 0x address`);
  }
  const addrWord = pad32(to.slice(2));
  const uriBytes = new TextEncoder().encode(tokenURI);
  // The string tail starts after the two head words: offset is 64 bytes.
  const offsetWord = pad32((64).toString(16));
  const lenWord = pad32(uriBytes.length.toString(16));
  const words = Math.ceil(uriBytes.length / 32);
  let dataWord = '';
  for (const b of uriBytes) dataWord += b.toString(16).padStart(2, '0');
  dataWord = dataWord.padEnd(words * 64, '0');
  return '0x' + MINT_SELECTOR + addrWord + offsetWord + lenWord + dataWord;
}

/**
 * Build the calldata-mode anchor payload: the mint id plus the license
 * flags, hex-encoded so the chain record is self-describing.
 */
export function encodeCalldataAnchor(manifest: MintManifest): string {
  return '0x' + utf8ToHex(CALLDATA_PREFIX + manifest.id + ':' + licenseFlags(manifest.license));
}

/** Decode a calldata-mode payload back to its mint id, or null. */
export function decodeCalldataAnchor(data: string): string | null {
  let text: string;
  try {
    text = hexToUtf8(data);
  } catch {
    return null;
  }
  if (!text.startsWith(CALLDATA_PREFIX)) return null;
  const rest = text.slice(CALLDATA_PREFIX.length).split(':');
  return rest[0] ?? null;
}

/**
 * Decode the string argument of a `mint(address,string)` call, or null
 * when the data is not such a call.
 */
export function decodeMintCallString(data: string): string | null {
  try {
    if (!/^0x[0-9a-fA-F]+$/.test(data)) return null;
    const body = data.slice(2).toLowerCase();
    if (!body.startsWith(MINT_SELECTOR)) return null;
    // Head (after the 4-byte selector): address word, offset word, then
    // at head + offset: length word + string bytes.
    const head = body.slice(8);
    if (head.length < 128) return null;
    const offsetBytes = parseInt(head.slice(64, 128), 16);
    if (!Number.isFinite(offsetBytes) || offsetBytes < 0 || offsetBytes > 1024) return null;
    const lenPos = offsetBytes * 2;
    const len = parseInt(head.slice(lenPos, lenPos + 64), 16);
    if (!Number.isFinite(len) || len < 0 || len > 4096) return null;
    const start = lenPos + 64;
    const raw = head.slice(start, start + len * 2);
    if (raw.length !== len * 2) return null;
    return hexToUtf8('0x' + raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token metadata
// ---------------------------------------------------------------------------

/**
 * Build ERC-721-style metadata JSON for a mint manifest. There is no
 * image field: the minted thing is the math itself, and the manifest
 * (name, author, provenance, license) IS the description. The tokenURI
 * that references this metadata is `xr-manifest:<id>`; the full manifest
 * stays off-chain where copying it is free, and the chain holds only
 * the id. `image` is omitted honestly rather than pointing at a
 * placeholder.
 */
export function buildTokenMetadata(manifest: MintManifest): Record<string, unknown> {
  const attrs: Array<Record<string, unknown>> = [
    { trait_type: 'mint_id', value: manifest.id },
    { trait_type: 'provenance_hash', value: manifest.provenanceHash },
    { trait_type: 'author_key', value: manifest.authorKey },
    { trait_type: 'license_use', value: manifest.license.use },
    { trait_type: 'license_remix', value: manifest.license.remix },
    { trait_type: 'license_commercial', value: manifest.license.commercial },
    { trait_type: 'license_resell', value: manifest.license.resell },
    { trait_type: 'seed', value: manifest.seed, display_type: 'number' },
    { trait_type: 'entity_count', value: manifest.entityIds.length, display_type: 'number' },
  ];
  return {
    name: `XR Mint ${manifest.id}`,
    description:
      `A Frozen In Flames ownership mint by ${manifest.author}: ` +
      `signed math grown from seed ${manifest.seed}, ` +
      `covering ${manifest.entityIds.length} entit${manifest.entityIds.length === 1 ? 'y' : 'ies'}. ` +
      `The full manifest stays off-chain; this token anchors its id on chain.`,
    attributes: attrs,
    external_url: `xr-manifest:${manifest.id}`,
  };
}

/** The tokenURI recorded for a mint: a pointer to the off-chain manifest. */
export function tokenURIFor(manifest: MintManifest): string {
  return `xr-manifest:${manifest.id}`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface EvmAdapterConfig {
  /** Chain id, e.g. 'eip155:1'. Never hardcoded: the user picks the chain. */
  chainId: string;
  /** Human-readable chain name, e.g. 'Ethereum'. */
  chainName: string;
  /**
   * The wallet/RPC surface. In a browser pass browserProvider(); in node
   * pass fetchTransport('https://<your own RPC endpoint>'). No endpoint
   * is ever hardcoded by the engine.
   */
  transport: Eip1193Provider;
  /** Optional mint contract address; enables contract mode when set. */
  contractAddress?: string;
  /** Fee token symbol for cost quotes. Defaults to 'ETH'. */
  feeToken?: string;
  /** How long to wait for a mined receipt. Defaults to 120000 ms. */
  receiptTimeoutMs?: number;
  /** Poll interval while waiting for a receipt. Defaults to 2000 ms. */
  receiptPollMs?: number;
}

interface EvmTxParams {
  from: string;
  to: string;
  value: string;
  data: string;
}

/**
 * EVM implementation of ChainAdapter. The user brings their own wallet
 * and RPC endpoint and pays their own gas; the engine never touches keys.
 */
export class EvmAdapter implements ChainAdapter {
  readonly chainId: string;
  readonly chainName: string;
  private readonly transport: Eip1193Provider;
  private readonly contractAddress?: string;
  private readonly feeToken: string;
  private readonly receiptTimeoutMs: number;
  private readonly receiptPollMs: number;
  private from?: string;

  constructor(config: EvmAdapterConfig) {
    if (!config || typeof config !== 'object') {
      throw new Error('evm: adapter config is required');
    }
    if (typeof config.chainId !== 'string' || config.chainId.length === 0) {
      throw new Error('evm: config.chainId must be a non-empty string');
    }
    if (typeof config.chainName !== 'string' || config.chainName.length === 0) {
      throw new Error('evm: config.chainName must be a non-empty string');
    }
    if (!config.transport || typeof config.transport.request !== 'function') {
      throw new Error('evm: config.transport must be an Eip1193Provider');
    }
    if (config.contractAddress !== undefined && !isHexAddress(config.contractAddress)) {
      throw new Error(`evm: config.contractAddress '${config.contractAddress}' is not a 0x address`);
    }
    this.chainId = config.chainId;
    this.chainName = config.chainName;
    this.transport = config.transport;
    this.contractAddress = config.contractAddress?.toLowerCase();
    this.feeToken = config.feeToken ?? 'ETH';
    this.receiptTimeoutMs = config.receiptTimeoutMs ?? 120000;
    this.receiptPollMs = config.receiptPollMs ?? 2000;
  }

  /** The connected account, if connect() has run. */
  get account(): string | undefined {
    return this.from;
  }

  /** Ask the provider a JSON-RPC question; every chain error surfaces. */
  private async rpc(method: string, params?: unknown[]): Promise<unknown> {
    let result: unknown;
    try {
      result = await this.transport.request({ method, params });
    } catch (e) {
      if (e instanceof Error) throw e;
      throw new Error(`evm: transport failed on '${method}': ${String(e)}`);
    }
    return result;
  }

  private requireAccount(): string {
    if (!this.from) {
      throw new Error('evm: not connected: call connect() first');
    }
    return this.from;
  }

  async connect(): Promise<void> {
    const accounts = (await this.rpc('eth_requestAccounts')) as unknown;
    if (!Array.isArray(accounts) || accounts.length === 0 || !isHexAddress(accounts[0])) {
      throw new Error('evm: wallet returned no usable account');
    }
    this.from = (accounts[0] as string).toLowerCase();
  }

  async disconnect(): Promise<void> {
    this.from = undefined;
  }

  /** Build the exact transaction anchor() would send, without sending it. */
  private buildAnchorTx(manifest: MintManifest): EvmTxParams {
    const from = this.requireAccount();
    if (this.contractAddress) {
      return {
        from,
        to: this.contractAddress,
        value: '0x0',
        data: encodeMintCall(from, tokenURIFor(manifest)),
      };
    }
    return {
      from,
      to: from,
      value: '0x0',
      data: encodeCalldataAnchor(manifest),
    };
  }

  /**
   * Quote the anchor before the user pays it. Prefers EIP-1559 fee data
   * (eth_feeHistory plus eth_maxPriorityFeePerGas); when the chain does
   * not speak 1559 it quotes legacy via eth_gasPrice. The amount is the
   * fee-token decimal string in its smallest unit (wei), computed with
   * BigInt, never floats. For 1559 the quote uses maxFeePerGas, so it is
   * an upper bound: the user may pay less.
   */
  async estimateCost(manifest: MintManifest): Promise<AnchorCost> {
    const tx = this.buildAnchorTx(manifest);
    const gasRaw = await this.rpc('eth_estimateGas', [tx]);
    const gas = hexToBigInt(gasRaw as string, 'gas estimate');

    let maxFeePerGas: bigint;
    let feeHistory: unknown = null;
    try {
      feeHistory = await this.rpc('eth_feeHistory', ['0x1', 'latest', [50]]);
    } catch {
      feeHistory = null; // legacy chain: fall through to eth_gasPrice below
    }
    if (isFeeHistory(feeHistory)) {
      const baseFees = feeHistory.baseFeePerGas;
      const baseFee = hexToBigInt(baseFees[baseFees.length - 1], 'base fee');
      let priorityFee: bigint;
      try {
        const prio = await this.rpc('eth_maxPriorityFeePerGas');
        priorityFee = hexToBigInt(prio as string, 'priority fee');
      } catch {
        // The node will not quote a tip: use a modest default of 1 gwei
        // rather than fail the quote. This is stated, not silent.
        priorityFee = 1_000_000_000n;
      }
      maxFeePerGas = baseFee * 2n + priorityFee;
    } else {
      const priceRaw = await this.rpc('eth_gasPrice');
      maxFeePerGas = hexToBigInt(priceRaw as string, 'gas price');
    }

    return { feeToken: this.feeToken, amount: (gas * maxFeePerGas).toString() };
  }

  /**
   * Anchor the mint's id on chain. Contract mode mints through the
   * configured contract and reads the tokenId from the ERC-721 Transfer
   * logs; calldata mode writes a 0-value tx to the user's own account
   * with the mint id in its data (tokenId is then honestly '').
   */
  async anchor(manifest: MintManifest): Promise<AnchorReceipt> {
    const tx = this.buildAnchorTx(manifest);
    const txHashRaw = await this.rpc('eth_sendTransaction', [tx]);
    if (typeof txHashRaw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHashRaw)) {
      throw new Error(`evm: eth_sendTransaction returned a bad hash: '${String(txHashRaw)}'`);
    }
    const txHash = txHashRaw.toLowerCase();
    const receipt = await this.waitForReceipt(txHash);
    if (!isTxReceipt(receipt)) {
      throw new Error(`evm: receipt for ${txHash} is malformed`);
    }
    if (receipt.status !== '0x1') {
      throw new Error(`evm: anchor transaction ${txHash} reverted on chain`);
    }

    let tokenId = '';
    if (this.contractAddress) {
      const found = tokenIdFromLogs(receipt.logs, this.contractAddress);
      if (found === null) {
        throw new Error(
          `evm: contract ${this.contractAddress} confirmed tx ${txHash} ` +
            'but emitted no ERC-721 Transfer log: no tokenId to report',
        );
      }
      tokenId = found;
    }

    return {
      chainId: this.chainId,
      txHash,
      tokenId,
      anchoredAt: new Date().toISOString(),
      manifestId: manifest.id,
    };
  }

  /**
   * Re-read the chain and confirm the receipt really anchors the
   * manifest's id. Returns false on any mismatch (wrong chain, wrong
   * id, missing or non-decoding tx, logs not matching in contract
   * mode); it never throws for a non-match. Only transport failures
   * reject, with a clear message.
   */
  async verifyAnchor(receipt: AnchorReceipt, manifest: MintManifest): Promise<boolean> {
    if (!receipt || typeof receipt !== 'object') return false;
    if (receipt.chainId !== this.chainId) return false;
    if (receipt.manifestId !== manifest.id) return false;
    if (typeof receipt.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(receipt.txHash)) {
      return false;
    }

    const tx = (await this.rpc('eth_getTransactionByHash', [receipt.txHash])) as unknown;
    if (tx === null || tx === undefined) return false;
    if (typeof tx !== 'object' || tx === null) return false;
    const data = (tx as { input?: unknown; data?: unknown }).input ??
      (tx as { data?: unknown }).data;
    if (typeof data !== 'string') return false;

    if (this.contractAddress) {
      if (decodeMintCallString(data) !== tokenURIFor(manifest)) return false;
      const rc = (await this.rpc('eth_getTransactionReceipt', [receipt.txHash])) as unknown;
      if (!isTxReceipt(rc) || rc.status !== '0x1') return false;
      const found = tokenIdFromLogs(rc.logs, this.contractAddress);
      if (found === null || found !== receipt.tokenId) return false;
    } else {
      if (decodeCalldataAnchor(data) !== manifest.id) return false;
    }
    return true;
  }

  /** Poll eth_getTransactionReceipt until the tx mines or time runs out. */
  private async waitForReceipt(txHash: string): Promise<unknown> {
    const start = Date.now();
    for (;;) {
      const receipt = await this.rpc('eth_getTransactionReceipt', [txHash]);
      if (receipt !== null && receipt !== undefined) return receipt;
      if (Date.now() - start >= this.receiptTimeoutMs) {
        throw new Error(
          `evm: no receipt for ${txHash} after ${this.receiptTimeoutMs}ms: ` +
            'the transaction may still mine later; check the hash on an explorer',
        );
      }
      await sleep(this.receiptPollMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FeeHistoryResult {
  baseFeePerGas: string[];
}

function isFeeHistory(v: unknown): v is FeeHistoryResult {
  if (typeof v !== 'object' || v === null) return false;
  const fees = (v as { baseFeePerGas?: unknown }).baseFeePerGas;
  return (
    Array.isArray(fees) &&
    fees.length > 0 &&
    fees.every((f) => isHexQuantity(f))
  );
}

interface TxLog {
  address?: unknown;
  topics?: unknown;
}

interface TxReceiptShape {
  status: string;
  logs: TxLog[];
}

function isTxReceipt(v: unknown): v is TxReceiptShape {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as { status?: unknown; logs?: unknown };
  return typeof r.status === 'string' && Array.isArray(r.logs);
}

/**
 * Find the ERC-721 Transfer event from the mint contract and read the
 * minted tokenId (the indexed third topic). Null when no such log.
 */
function tokenIdFromLogs(logs: TxLog[], contractAddress: string): string | null {
  for (const log of logs) {
    if (typeof log !== 'object' || log === null) continue;
    const addr = (log as { address?: unknown }).address;
    if (typeof addr !== 'string' || addr.toLowerCase() !== contractAddress) continue;
    const topics = (log as { topics?: unknown }).topics;
    if (!Array.isArray(topics) || topics.length < 4) continue;
    if (typeof topics[0] !== 'string' || topics[0].toLowerCase() !== TRANSFER_EVENT_TOPIC) continue;
    if (typeof topics[3] !== 'string' || !isHexQuantity(topics[3])) continue;
    return BigInt(topics[3] as string).toString(10);
  }
  return null;
}
