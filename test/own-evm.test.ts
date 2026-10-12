// Unit tests for own/evm.ts: the EVM chain adapter (runs in node).
// Everything runs against a mock Eip1193Provider: no real chain, no
// network, $0. Covers:
//  (a) keccak256 against published vectors, and the derived Transfer
//      event topic;
//  (b) buildTokenMetadata shape (name, description, attributes with
//      manifest id / provenanceHash / license flags / authorKey; no
//      image field);
//  (c) estimateCost gas math: BigInt decimal strings, EIP-1559 path and
//      legacy gasPrice path;
//  (d) anchor in contract mode: ABI encoding correctness, receipt
//      parsing, tokenId from Transfer logs;
//  (e) anchor in calldata mode: payload shape, tokenId '' ;
//  (f) verifyAnchor: true on match, false (never throw) on mismatch,
//      missing tx, bad receipt, log mismatch;
//  (g) failure modes: user-rejected send, receipt timeout, malformed
//      RPC responses, connect with no accounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EvmAdapter,
  fetchTransport,
  browserProvider,
  buildTokenMetadata,
  tokenURIFor,
  encodeMintCall,
  encodeCalldataAnchor,
  decodeCalldataAnchor,
  decodeMintCallString,
  keccak256Hex,
  TRANSFER_EVENT_TOPIC,
} from '../src/own/evm.js';
import type { Eip1193Provider } from '../src/own/evm.js';
import type { MintManifest } from '../src/own/mint.js';

/** Deterministic demo manifest (hand-built shape, no signing needed here). */
function demoManifest(): MintManifest {
  return {
    v: 1,
    kind: 'xr-mint',
    id: 'a1b2c3d4',
    author: 'alice',
    authorKey: '11'.repeat(32),
    created: '2026-10-12T01:00:00.000Z',
    seed: 20261012,
    entityIds: ['b1', 's1'],
    provenanceHash: 'deadbeef',
    ops: [],
    license: { use: true, remix: true, commercial: false, resell: false },
    signature: '22'.repeat(64),
  };
}

/** Mock EIP-1193 provider: scripted handlers, records every call. */
class MockProvider implements Eip1193Provider {
  calls: Array<{ method: string; params?: unknown[] }> = [];
  handlers = new Map<string, (params?: unknown[]) => unknown | Promise<unknown>>();

  on(method: string, fn: (params?: unknown[]) => unknown | Promise<unknown>): this {
    this.handlers.set(method, fn);
    return this;
  }

  async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
    this.calls.push({ method, params });
    const h = this.handlers.get(method);
    if (!h) throw new Error(`mock: unhandled method '${method}'`);
    return h(params);
  }
}

const FROM = '0x1111111111111111111111111111111111111111';
const CONTRACT = '0x2222222222222222222222222222222222222222';
const TXHASH = '0x' + 'ab'.repeat(32);

function tokenTopic32(tokenId: bigint): string {
  return '0x' + tokenId.toString(16).padStart(64, '0');
}

function transferLog(tokenId: bigint): Record<string, unknown> {
  return {
    address: CONTRACT,
    topics: [
      TRANSFER_EVENT_TOPIC,
      '0x' + '00'.repeat(12) + '0'.repeat(39) + '1', // from: 0x0 (mint)
      '0x' + '00'.repeat(12) + FROM.slice(2), // to: the user
      tokenTopic32(tokenId),
    ],
    data: '0x',
  };
}

// ---------- (a) keccak256 vectors ----------

test('(a) keccak256 matches published vectors', () => {
  // Empty input vector.
  assert.equal(
    keccak256Hex(new Uint8Array(0)),
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
  // The Transfer event topic is a widely published keccak256 value.
  assert.equal(
    TRANSFER_EVENT_TOPIC,
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  );
  // Selector is the first 4 bytes of keccak256('mint(address,string)').
  const full = keccak256Hex(new TextEncoder().encode('mint(address,string)'));
  const encoded = encodeMintCall(FROM, 'xr-manifest:a1b2c3d4');
  assert.ok(encoded.startsWith('0x' + full.slice(0, 8)));
});

// ---------- (b) token metadata ----------

test('(b) buildTokenMetadata shape', () => {
  const m = demoManifest();
  const meta = buildTokenMetadata(m);
  assert.equal(meta.name, 'XR Mint a1b2c3d4');
  assert.ok(typeof meta.description === 'string' && (meta.description as string).includes('alice'));
  assert.ok(!('image' in meta), 'no image field: the math is the work');
  assert.equal(meta.external_url, 'xr-manifest:a1b2c3d4');
  const attrs = meta.attributes as Array<{ trait_type: string; value: unknown }>;
  const byTrait = Object.fromEntries(attrs.map((a) => [a.trait_type, a.value]));
  assert.equal(byTrait.mint_id, 'a1b2c3d4');
  assert.equal(byTrait.provenance_hash, 'deadbeef');
  assert.equal(byTrait.author_key, '11'.repeat(32));
  assert.equal(byTrait.license_use, true);
  assert.equal(byTrait.license_remix, true);
  assert.equal(byTrait.license_commercial, false);
  assert.equal(byTrait.license_resell, false);
  assert.equal(byTrait.entity_count, 2);
  assert.equal(tokenURIFor(m), 'xr-manifest:a1b2c3d4');
});

// ---------- (c) estimateCost gas math ----------

function accountMock(): MockProvider {
  return new MockProvider().on('eth_requestAccounts', () => [FROM]);
}

test('(c) estimateCost legacy path: BigInt decimal string, no floats', async () => {
  const provider = accountMock()
    .on('eth_estimateGas', () => '0x5208') // 21000
    .on('eth_feeHistory', () => {
      throw new Error('eth_feeHistory: method not found');
    })
    .on('eth_gasPrice', () => '0x3b9aca00'); // 1 gwei
  const adapter = new EvmAdapter({
    chainId: 'eip155:1',
    chainName: 'Ethereum',
    transport: provider,
    feeToken: 'ETH',
  });
  await adapter.connect();
  const cost = await adapter.estimateCost(demoManifest());
  assert.equal(cost.feeToken, 'ETH');
  // 21000 * 1e9 = 21000000000000, as a pure decimal string.
  assert.equal(cost.amount, '21000000000000');
  assert.match(cost.amount, /^[0-9]+$/);
});

test('(c) estimateCost EIP-1559 path: maxFeePerGas = 2*base + tip', async () => {
  const provider = accountMock()
    .on('eth_estimateGas', () => '0x5208') // 21000
    .on('eth_feeHistory', () => ({ baseFeePerGas: ['0x3b9aca00', '0x77359400'] })) // 1, 2 gwei
    .on('eth_maxPriorityFeePerGas', () => '0x3b9aca00'); // 1 gwei
  const adapter = new EvmAdapter({
    chainId: 'eip155:137',
    chainName: 'Polygon',
    transport: provider,
    feeToken: 'MATIC',
  });
  await adapter.connect();
  const cost = await adapter.estimateCost(demoManifest());
  assert.equal(cost.feeToken, 'MATIC');
  // 21000 * (2*2e9 + 1e9) = 21000 * 5e9 = 105000000000000
  assert.equal(cost.amount, '105000000000000');
});

test('(c) estimateCost requires connect() first', async () => {
  const adapter = new EvmAdapter({
    chainId: 'eip155:1',
    chainName: 'Ethereum',
    transport: accountMock(),
  });
  await assert.rejects(adapter.estimateCost(demoManifest()), /not connected/);
});

// ---------- (d) contract-mode anchor ----------

function contractMocks(tokenId: bigint): MockProvider {
  const provider = accountMock()
    .on('eth_sendTransaction', () => TXHASH)
    .on('eth_getTransactionReceipt', () => ({
      status: '0x1',
      logs: [transferLog(tokenId)],
    }));
  return provider;
}

test('(d) anchor contract mode: encodes mint(address,string), parses tokenId', async () => {
  const provider = contractMocks(7n);
  const adapter = new EvmAdapter({
    chainId: 'eip155:1',
    chainName: 'Ethereum',
    transport: provider,
    contractAddress: CONTRACT,
  });
  await adapter.connect();
  const receipt = await adapter.anchor(demoManifest());
  assert.equal(receipt.chainId, 'eip155:1');
  assert.equal(receipt.txHash, TXHASH);
  assert.equal(receipt.tokenId, '7');
  assert.equal(receipt.manifestId, 'a1b2c3d4');
  assert.ok(!Number.isNaN(Date.parse(receipt.anchoredAt)), 'anchoredAt is ISO-8601');

  // The sent data really is mint(address, 'xr-manifest:<id>').
  const sendCall = provider.calls.find((c) => c.method === 'eth_sendTransaction');
  assert.ok(sendCall);
  const tx = (sendCall.params as unknown[])[0] as { to: string; data: string; value: string };
  assert.equal(tx.to.toLowerCase(), CONTRACT);
  assert.equal(tx.value, '0x0');
  assert.equal(decodeMintCallString(tx.data), 'xr-manifest:a1b2c3d4');
  // Recipient is the user's own account, padded into the address word.
  const body = tx.data.slice(2).toLowerCase();
  assert.equal(body.slice(8, 8 + 64), '0'.repeat(24) + FROM.slice(2).toLowerCase());
});

test('(d) anchor contract mode: throws when no Transfer log is emitted', async () => {
  const provider = accountMock()
    .on('eth_sendTransaction', () => TXHASH)
    .on('eth_getTransactionReceipt', () => ({ status: '0x1', logs: [] }));
  const adapter = new EvmAdapter({
    chainId: 'eip155:1',
    chainName: 'Ethereum',
    transport: provider,
    contractAddress: CONTRACT,
    receiptTimeoutMs: 50,
    receiptPollMs: 10,
  });
  await adapter.connect();
  await assert.rejects(adapter.anchor(demoManifest()), /no ERC-721 Transfer log/);
});

test('(d) anchor contract mode: throws when the tx reverts', async () => {
  const provider = accountMock()
    .on('eth_sendTransaction', () => TXHASH)
    .on('eth_getTransactionReceipt', () => ({ status: '0x0', logs: [] }));
  const adapter = new EvmAdapter({
    chainId: 'eip155:1',
    chainName: 'Ethereum',
    transport: provider,
    contractAddress: CONTRACT,
  });
  await adapter.connect();
  await assert.rejects(adapter.anchor(demoManifest()), /reverted/);
});

// ---------- (e) calldata-mode anchor ----------

test('(e) anchor calldata mode: 0-value tx to self, tokenId is empty', async () => {
  const provider = accountMock()
    .on('eth_sendTransaction', () => TXHASH)
    .on('eth_getTransactionReceipt', () => ({ status: '0x1', logs: [] }));
  const adapter = new EvmAdapter({
    chainId: 'eip155:10',
    chainName: 'Optimism',
    transport: provider,
  });
  await adapter.connect();
  const receipt = await adapter.anchor(demoManifest());
  assert.equal(receipt.tokenId, '', 'calldata mode has no chain record id');
  assert.equal(receipt.manifestId, 'a1b2c3d4');

  const sendCall = provider.calls.find((c) => c.method === 'eth_sendTransaction');
  const tx = (sendCall!.params as unknown[])[0] as { to: string; data: string; value: string };
  assert.equal(tx.to.toLowerCase(), FROM.toLowerCase());
  assert.equal(tx.value, '0x0');
  assert.equal(decodeCalldataAnchor(tx.data), 'a1b2c3d4');
  // The payload is self-describing: prefix, id, license flags.
  const expected = encodeCalldataAnchor(demoManifest());
  assert.equal(tx.data, expected);
});

// ---------- (f) verifyAnchor ----------

function verifyMocks(tokenId: bigint, dataForTx: string): MockProvider {
  return new MockProvider()
    .on('eth_getTransactionByHash', () => ({ input: dataForTx }))
    .on('eth_getTransactionReceipt', () => ({
      status: '0x1',
      logs: [transferLog(tokenId)],
    }));
}

test('(f) verifyAnchor contract mode: true on match', async () => {
  const m = demoManifest();
  const data = encodeMintCall(FROM, tokenURIFor(m));
  const adapter = new EvmAdapter({
    chainId: 'eip155:1',
    chainName: 'Ethereum',
    transport: verifyMocks(7n, data),
    contractAddress: CONTRACT,
  });
  const receipt = {
    chainId: 'eip155:1',
    txHash: TXHASH,
    tokenId: '7',
    anchoredAt: '2026-10-12T01:00:00.000Z',
    manifestId: 'a1b2c3d4',
  };
  assert.equal(await adapter.verifyAnchor(receipt, m), true);
});

test('(f) verifyAnchor: false, never throws, on every mismatch', async () => {
  const m = demoManifest();
  const data = encodeMintCall(FROM, tokenURIFor(m));
  const adapter = new EvmAdapter({
    chainId: 'eip155:1',
    chainName: 'Ethereum',
    transport: verifyMocks(7n, data),
    contractAddress: CONTRACT,
  });
  const good = {
    chainId: 'eip155:1',
    txHash: TXHASH,
    tokenId: '7',
    anchoredAt: '2026-10-12T01:00:00.000Z',
    manifestId: 'a1b2c3d4',
  };
  assert.equal(await adapter.verifyAnchor({ ...good, chainId: 'eip155:999' }, m), false);
  assert.equal(await adapter.verifyAnchor({ ...good, tokenId: '8' }, m), false);
  assert.equal(await adapter.verifyAnchor({ ...good, manifestId: 'ffffffff' }, m), false);
  assert.equal(await adapter.verifyAnchor({ ...good, txHash: '0xdead' }, m), false);

  // Tx exists but anchors a different id.
  const otherData = encodeMintCall(FROM, 'xr-manifest:ffffffff');
  const adapter2 = new EvmAdapter({
    chainId: 'eip155:1',
    chainName: 'Ethereum',
    transport: verifyMocks(7n, otherData),
    contractAddress: CONTRACT,
  });
  assert.equal(await adapter2.verifyAnchor(good, m), false);

  // Tx missing entirely.
  const adapter3 = new EvmAdapter({
    chainId: 'eip155:1',
    chainName: 'Ethereum',
    transport: new MockProvider()
      .on('eth_getTransactionByHash', () => null)
      .on('eth_getTransactionReceipt', () => null),
    contractAddress: CONTRACT,
  });
  assert.equal(await adapter3.verifyAnchor(good, m), false);

  // Logs do not carry the claimed tokenId.
  const adapter4 = new EvmAdapter({
    chainId: 'eip155:1',
    chainName: 'Ethereum',
    transport: verifyMocks(42n, data),
    contractAddress: CONTRACT,
  });
  assert.equal(await adapter4.verifyAnchor(good, m), false);
});

test('(f) verifyAnchor calldata mode: true on match, false on wrong id', async () => {
  const m = demoManifest();
  const adapter = new EvmAdapter({
    chainId: 'eip155:10',
    chainName: 'Optimism',
    transport: new MockProvider().on('eth_getTransactionByHash', () => ({
      input: encodeCalldataAnchor(m),
    })),
  });
  const receipt = {
    chainId: 'eip155:10',
    txHash: TXHASH,
    tokenId: '',
    anchoredAt: '2026-10-12T01:00:00.000Z',
    manifestId: 'a1b2c3d4',
  };
  assert.equal(await adapter.verifyAnchor(receipt, m), true);

  const wrong = new EvmAdapter({
    chainId: 'eip155:10',
    chainName: 'Optimism',
    transport: new MockProvider().on('eth_getTransactionByHash', () => ({
      input: '0xdeadbeef',
    })),
  });
  assert.equal(await wrong.verifyAnchor(receipt, m), false);
});

// ---------- (g) failure modes ----------

test('(g) anchor: user rejection surfaces as a rejected promise', async () => {
  const provider = accountMock().on('eth_sendTransaction', () => {
    throw new Error('User denied transaction signature.');
  });
  const adapter = new EvmAdapter({
    chainId: 'eip155:1',
    chainName: 'Ethereum',
    transport: provider,
  });
  await adapter.connect();
  await assert.rejects(adapter.anchor(demoManifest()), /User denied/);
});

test('(g) anchor: receipt timeout rejects with a clear message', async () => {
  const provider = accountMock()
    .on('eth_sendTransaction', () => TXHASH)
    .on('eth_getTransactionReceipt', () => null); // never mines
  const adapter = new EvmAdapter({
    chainId: 'eip155:1',
    chainName: 'Ethereum',
    transport: provider,
    receiptTimeoutMs: 60,
    receiptPollMs: 10,
  });
  await adapter.connect();
  await assert.rejects(adapter.anchor(demoManifest()), /no receipt.*after 60ms/);
});

test('(g) anchor: malformed tx hash from the node rejects', async () => {
  const provider = accountMock()
    .on('eth_sendTransaction', () => 'not-a-hash')
    .on('eth_getTransactionReceipt', () => null);
  const adapter = new EvmAdapter({
    chainId: 'eip155:1',
    chainName: 'Ethereum',
    transport: provider,
  });
  await adapter.connect();
  await assert.rejects(adapter.anchor(demoManifest()), /bad hash/);
});

test('(g) connect: wallet with no accounts rejects', async () => {
  const provider = new MockProvider().on('eth_requestAccounts', () => []);
  const adapter = new EvmAdapter({
    chainId: 'eip155:1',
    chainName: 'Ethereum',
    transport: provider,
  });
  await assert.rejects(adapter.connect(), /no usable account/);
  await assert.rejects(adapter.anchor(demoManifest()), /not connected/);
});

test('(g) constructor validates config', () => {
  const transport = accountMock();
  assert.throws(
    () =>
      new EvmAdapter({
        chainId: '',
        chainName: 'Ethereum',
        transport,
      }),
    /chainId/,
  );
  assert.throws(
    () =>
      new EvmAdapter({
        chainId: 'eip155:1',
        chainName: 'Ethereum',
        transport,
        contractAddress: '0xnotanaddress',
      }),
    /not a 0x address/,
  );
});

test('(g) disconnect clears the account', async () => {
  const adapter = new EvmAdapter({
    chainId: 'eip155:1',
    chainName: 'Ethereum',
    transport: accountMock(),
  });
  await adapter.connect();
  assert.equal(adapter.account, FROM.toLowerCase());
  await adapter.disconnect();
  assert.equal(adapter.account, undefined);
});

test('(g) fetchTransport rejects on a non-JSON answer without network', async () => {
  // No network here: an unreachable endpoint must reject, not hang silently.
  const t = fetchTransport('http://127.0.0.1:1/');
  await assert.rejects(t.request({ method: 'eth_chainId' }), /failed to reach/);
});

test('(g) browserProvider throws when no wallet is injected', () => {
  // In node there is no window at all.
  assert.throws(() => browserProvider(), /no injected wallet/);
});
