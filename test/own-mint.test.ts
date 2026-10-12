// Unit tests for V6 steps 2-5: mints, rights, registry, chain adapter (runs in node).
// (a) createMint -> verifyMint roundtrip ok;
// (b) tampered ops / signature / license / id -> verifyMint false with a reason,
//     and verifyMint never throws on hostile input;
// (c) rights: LICENSE_OPEN allows all; LICENSE_NONCOMMERCIAL denies commercial;
//     LICENSE_PERSONAL allows only use. RightsGate throws RightsError on deny;
// (d) registry: append/verify roundtrip; duplicate mintId rejected; tampered
//     entry fails verifyRegistry (never throws);
// (e) chain adapter: the interface file carries types only (no runtime imports).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOp } from '../src/state/index.js';
import { buildProvenance } from '../src/own/provenance.js';
import { generateKeypair, toHex } from '../src/own/ed25519.js';
import {
  LICENSE_OPEN, LICENSE_NONCOMMERCIAL, LICENSE_PERSONAL,
  createMint, verifyMint, mintId,
} from '../src/own/mint.js';
import type { MintManifest } from '../src/own/mint.js';
import {
  RightsError, RightsGate, canDo, enforce, describeLicense,
} from '../src/own/rights.js';
import {
  createRegistry, appendEntry, entryFromMint, verifyRegistry,
} from '../src/own/registry.js';
import type { BuildOp, JSONValue } from '../src/state/index.js';

const SEED = 20261012;

function mkOp(op: string, actor: string, seq: number, t: number, payload: JSONValue): BuildOp {
  return createOp(op, actor, seq, SEED, t, payload, seq === 0 ? 'genesis' : actor + '-prev-' + (seq - 1));
}

/** Small deterministic keypair: 32-byte seed with a fixed pattern. */
function demoKeypair() {
  const seedBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seedBytes[i] = (i * 7 + 3) & 0xff;
  return generateKeypair(seedBytes);
}

/** A DIFFERENT deterministic keypair, for "wrong key" cases. */
function otherKeypair() {
  const seedBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seedBytes[i] = (i * 13 + 99) & 0xff;
  return generateKeypair(seedBytes);
}

/** A tiny demo world: one brush stroke, one planted seed, one author. */
function demoWorld() {
  const brushOp = mkOp('build.brush', 'alice', 0, 1, {
    id: 'b1', pos: [1, 2, 3], radius: 4, strength: 0.5, heading: 1.2,
  });
  const seedOp = mkOp('build.seed', 'alice', 1, 2, {
    id: 's1', kind: 'spire', pos: [10, 0, 10], seed: 42,
  });
  const ops = [brushOp, seedOp];
  return { ops, provenance: buildProvenance(ops) };
}

function demoMint(license = LICENSE_OPEN): { manifest: MintManifest; secretKey: Uint8Array } {
  const kp = demoKeypair();
  const { ops, provenance } = demoWorld();
  const manifest = createMint({
    author: 'alice',
    authorKey: toHex(kp.publicKey),
    seed: SEED,
    entityIds: ['b1', 's1'],
    provenance,
    ops,
    license,
    created: '2026-10-12T01:00:00.000Z',
    secretKey: kp.secretKey,
  });
  return { manifest, secretKey: kp.secretKey };
}

// ---------- (a) mint roundtrip ----------

test('mint: createMint -> verifyMint roundtrip ok', () => {
  const { manifest } = demoMint();
  const res = verifyMint(manifest);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.manifest.id, manifest.id);
    assert.equal(res.manifest.author, 'alice');
  }
  assert.equal(mintId(manifest), manifest.id);
});

// ---------- (b) tamper detection ----------

test('mint: tampered ops break the signature', () => {
  const { manifest } = demoMint();
  const tampered = structuredClone(manifest);
  (tampered.ops[0].payload as Record<string, JSONValue>).strength = 999;
  const res = verifyMint(tampered);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /id|signature/);
});

test('mint: tampered license breaks verification', () => {
  const { manifest } = demoMint(LICENSE_PERSONAL);
  const tampered = structuredClone(manifest);
  tampered.license.commercial = true;
  const res = verifyMint(tampered);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.reason.length > 0);
});

test('mint: tampered signature fails with a reason', () => {
  const { manifest } = demoMint();
  const tampered = structuredClone(manifest);
  tampered.signature = '00'.repeat(64);
  const res = verifyMint(tampered);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /signature/);
});

test('mint: tampered authorKey fails with a reason', () => {
  const { manifest } = demoMint();
  const tampered = structuredClone(manifest);
  tampered.authorKey = toHex(otherKeypair().publicKey);
  const res = verifyMint(tampered);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.reason.length > 0);
});

test('mint: verifyMint never throws on hostile input', () => {
  for (const hostile of [
    null, undefined, 42, 'mint', [], {},
    { v: 2, kind: 'xr-mint' },
    { v: 1, kind: 'xr-mint', authorKey: 'zzzz' },
    { v: 1, kind: 'xr-mint', author: 'x', authorKey: 'ab'.repeat(32),
      created: 't', seed: 1, entityIds: ['e'], provenanceHash: 'ab'.repeat(4),
      ops: [{}], license: { use: 1 }, id: 'ab'.repeat(4), signature: 'ab'.repeat(64) },
  ]) {
    const res = verifyMint(hostile);
    assert.equal(res.ok, false);
    if (!res.ok) assert.ok(typeof res.reason === 'string' && res.reason.length > 0);
  }
});

test('mint: createMint rejects bad input with descriptive errors', () => {
  const kp = demoKeypair();
  const { ops, provenance } = demoWorld();
  const base = {
    author: 'alice',
    authorKey: toHex(kp.publicKey),
    seed: SEED,
    entityIds: ['b1'],
    provenance,
    ops,
    license: LICENSE_OPEN,
    secretKey: kp.secretKey,
  };
  assert.throws(() => createMint({ ...base, author: '' }), /author/);
  assert.throws(() => createMint({ ...base, authorKey: 'nope' }), /authorKey/);
  assert.throws(() => createMint({ ...base, entityIds: ['ghost'] }), /not in the provenance/);
  assert.throws(() => createMint({ ...base, ops: [] }), /ops/);
  assert.throws(() => createMint({ ...base, license: { use: true } as never }), /license/);
});

// ---------- (c) rights ----------

test('rights: OPEN allows everything', () => {
  const { manifest } = demoMint(LICENSE_OPEN);
  for (const a of ['use', 'remix', 'commercial', 'resell'] as const) {
    assert.equal(canDo(manifest, a), true);
    enforce(manifest, a); // must not throw
  }
  assert.equal(describeLicense(manifest.license), 'open: everything allowed');
});

test('rights: NONCOMMERCIAL denies commercial and resell', () => {
  const { manifest } = demoMint(LICENSE_NONCOMMERCIAL);
  assert.equal(canDo(manifest, 'use'), true);
  assert.equal(canDo(manifest, 'remix'), true);
  assert.equal(canDo(manifest, 'commercial'), false);
  assert.equal(canDo(manifest, 'resell'), false);
  assert.throws(() => enforce(manifest, 'commercial'), RightsError);
});

test('rights: PERSONAL allows only use', () => {
  const { manifest } = demoMint(LICENSE_PERSONAL);
  assert.equal(canDo(manifest, 'use'), true);
  for (const a of ['remix', 'commercial', 'resell'] as const) {
    assert.equal(canDo(manifest, a), false);
  }
  assert.match(describeLicense(manifest.license), /use allowed/);
});

test('rights: RightsError names the action and the license', () => {
  const { manifest } = demoMint(LICENSE_PERSONAL);
  try {
    enforce(manifest, 'remix');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof RightsError);
    assert.match(e.message, /remix/);
    assert.match(e.message, /license/);
    assert.equal(e.action, 'remix');
    assert.equal(e.mintId, manifest.id);
  }
});

test('rights: RightsGate allows on grant, throws on deny', () => {
  const open = demoMint(LICENSE_OPEN).manifest;
  const personal = demoMint(LICENSE_PERSONAL).manifest;
  const gate = new RightsGate();
  assert.equal(gate.gateSpawn(open, 'bob'), open);
  assert.equal(gate.gateRemix(open), open);
  assert.equal(gate.gateResell(open), open);
  assert.equal(gate.gateSpawn(personal, 'bob'), personal);
  assert.throws(() => gate.gateRemix(personal), RightsError);
  assert.throws(() => gate.gateResell(personal), RightsError);
});

// ---------- (d) registry ----------

test('registry: create/append/verify roundtrip', () => {
  const kp = demoKeypair();
  const regKeypair = {
    publicKey: toHex(kp.publicKey),
    secretKey: kp.secretKey,
  };
  const reg0 = createRegistry(regKeypair);
  assert.equal(verifyRegistry(reg0, regKeypair.publicKey), true);

  const { manifest } = demoMint();
  const entry = entryFromMint(manifest, '2026-10-12T01:00:00.000Z');
  const reg1 = appendEntry(reg0, entry, kp.secretKey);
  assert.equal(verifyRegistry(reg1, regKeypair.publicKey), true);
  assert.equal(reg1.entries.length, 1);
  assert.equal(reg1.entries[0].mintId, manifest.id);
  // Appending does not mutate the input registry.
  assert.equal(reg0.entries.length, 0);
});

test('registry: entries stay sorted by mintId', () => {
  const kp = demoKeypair();
  const regKeypair = { publicKey: toHex(kp.publicKey), secretKey: kp.secretKey };
  let reg = createRegistry(regKeypair);
  const mints = [demoMint().manifest, demoMint(LICENSE_PERSONAL).manifest];
  for (const m of mints) reg = appendEntry(reg, entryFromMint(m), kp.secretKey);
  const ids = reg.entries.map((e) => e.mintId);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(verifyRegistry(reg, regKeypair.publicKey), true);
});

test('registry: duplicate mintId rejected', () => {
  const kp = demoKeypair();
  const regKeypair = { publicKey: toHex(kp.publicKey), secretKey: kp.secretKey };
  const reg0 = createRegistry(regKeypair);
  const entry = entryFromMint(demoMint().manifest);
  const reg1 = appendEntry(reg0, entry, kp.secretKey);
  assert.throws(() => appendEntry(reg1, entry, kp.secretKey), /duplicate/);
});

test('registry: tampered entry fails verification, never throws', () => {
  const kp = demoKeypair();
  const regKeypair = { publicKey: toHex(kp.publicKey), secretKey: kp.secretKey };
  const reg1 = appendEntry(createRegistry(regKeypair), entryFromMint(demoMint().manifest), kp.secretKey);
  const tampered = structuredClone(reg1);
  tampered.entries[0].author = 'mallory';
  assert.equal(verifyRegistry(tampered, regKeypair.publicKey), false);
  // Wrong operator key also fails.
  assert.equal(verifyRegistry(reg1, toHex(otherKeypair().publicKey)), false);
  // Hostile input never throws.
  for (const hostile of [null, 'x', 42, {}, { v: 1, entries: 'nope', signature: 'zz' }]) {
    assert.equal(verifyRegistry(hostile, regKeypair.publicKey), false);
  }
});

// ---------- (e) chain adapter is types only ----------

test('chain: adapter file has no runtime imports (types only)', () => {
  // Read from the repo source tree: the test runner's cwd is the repo root.
  const src = readFileSync(join(process.cwd(), 'src/own/chain.ts'), 'utf8');
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (t.startsWith('import ')) {
      assert.ok(
        t.startsWith('import type '),
        `chain.ts must not have runtime imports, found: ${t}`,
      );
    }
  }
  assert.match(src, /interface ChainAdapter/);
  assert.match(src, /interface AnchorReceipt/);
});
