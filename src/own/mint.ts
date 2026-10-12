// own/mint.ts - the signed ownership manifest (V6 step 2).
//
// V6 thesis: ownership, fully off-chain, $0 budget. A mint is a JSON
// manifest signed with Ed25519: the math that grows the world, plus a
// license, plus proof that the named author minted it. Anyone can verify a
// mint with nothing but the manifest itself: no server, no chain, no fees.
//
// The id is content-addressed: FNV-1a hex of the canonical JSON of the
// unsigned form. The signature covers the same canonical bytes, so any
// tampering with ops, license, authorship, or seed breaks verification.
//
// Pure core: no DOM, no WebGL, no node builtins, no new dependencies.

import { canonicalJSON, fnv1aHex } from '../state/hash.js';
import type { BuildOp, JSONValue } from '../state/types.js';
import type { ProvenanceGraph } from './provenance.js';
import { provenanceHash } from './provenance.js';
import { fromHex, sign, toHex, verify } from './ed25519.js';

/** What the holder of a mint is allowed to do with the minted math. */
export interface LicenseTerms {
  /** Load the math into the engine and play with it. */
  use: boolean;
  /** Build new work on top of it. */
  remix: boolean;
  /** Make money from it. */
  commercial: boolean;
  /** Sell or transfer the mint itself. */
  resell: boolean;
}

/** Everything allowed: the math stays free. */
export const LICENSE_OPEN: LicenseTerms = Object.freeze({
  use: true, remix: true, commercial: true, resell: true,
}) as LicenseTerms;

/** Personal use and remixing only: no money may change hands. */
export const LICENSE_NONCOMMERCIAL: LicenseTerms = Object.freeze({
  use: true, remix: true, commercial: false, resell: false,
}) as LicenseTerms;

/** Look and play, but keep it to yourself: no remixing, no selling. */
export const LICENSE_PERSONAL: LicenseTerms = Object.freeze({
  use: true, remix: false, commercial: false, resell: false,
}) as LicenseTerms;

/**
 * A signed ownership claim over a set of built entities. Plain JSON, so a
 * mint can travel anywhere: copy-pasted into a forum post, attached to a
 * world file, or stored in the public registry (see registry.ts).
 */
export interface MintManifest {
  v: 1;
  kind: 'xr-mint';
  /** Content id: FNV-1a hex of the canonical JSON of the unsigned form. */
  id: string;
  /** Human-readable author name. */
  author: string;
  /** Author's Ed25519 public key, hex. This is what the signature binds. */
  authorKey: string;
  /** ISO-8601 creation time. */
  created: string;
  /** The session seed the minted math was grown from. */
  seed: number;
  /** Entity ids this mint claims, in canonical (sorted) order. */
  entityIds: string[];
  /** provenanceHash of the graph this mint was built from. */
  provenanceHash: string;
  /** The exact build ops backing the claim, in canonical order. */
  ops: BuildOp[];
  license: LicenseTerms;
  /** Ed25519 signature over the canonical bytes of the unsigned form, hex. */
  signature: string;
}

/** The unsigned projection of a manifest: everything except id/signature. */
interface UnsignedMint {
  v: 1;
  kind: 'xr-mint';
  author: string;
  authorKey: string;
  created: string;
  seed: number;
  entityIds: string[];
  provenanceHash: string;
  ops: BuildOp[];
  license: LicenseTerms;
}

function toUnsigned(m: MintManifest | UnsignedMint): UnsignedMint {
  return {
    v: 1,
    kind: 'xr-mint',
    author: m.author,
    authorKey: m.authorKey,
    created: m.created,
    seed: m.seed,
    entityIds: [...m.entityIds],
    provenanceHash: m.provenanceHash,
    ops: m.ops,
    license: { ...m.license },
  };
}

/** Recompute the content id of a manifest (or an unsigned form of one). */
export function mintId(manifest: MintManifest): string {
  return fnv1aHex(canonicalJSON(toUnsigned(manifest) as unknown as JSONValue));
}

/** Canonical signing bytes: the UTF-8 of the canonical JSON of the form. */
function signingBytes(u: UnsignedMint): Uint8Array {
  return new TextEncoder().encode(canonicalJSON(u as unknown as JSONValue));
}

export interface CreateMintOpts {
  author: string;
  /** Author's Ed25519 public key, hex (32 bytes when decoded). */
  authorKey: string;
  seed: number;
  /** Entity ids claimed. Must all exist in provenance. */
  entityIds: string[];
  provenance: ProvenanceGraph;
  /** The build ops backing the claim. Validated as JSON-serializable. */
  ops: BuildOp[];
  license: LicenseTerms;
  created?: string;
  /** 64-byte Ed25519 secret key (seed + public key, as generateKeypair returns). */
  secretKey: Uint8Array;
}

/**
 * Build and sign a mint. The unsigned form gets its content id, the id is
 * part of what is signed, and the signature is attached. Throws a
 * descriptive error on bad input; the returned manifest always passes
 * verifyMint.
 */
export function createMint(opts: CreateMintOpts): MintManifest {
  const { author, authorKey, seed, entityIds, provenance, ops, license } = opts;

  if (typeof author !== 'string' || author.trim().length === 0) {
    throw new Error('mint: author must be a non-empty string');
  }
  let keyBytes: Uint8Array;
  try {
    keyBytes = fromHex(authorKey);
  } catch {
    throw new Error('mint: authorKey must be valid lowercase hex');
  }
  if (keyBytes.length !== 32) {
    throw new Error('mint: authorKey must decode to exactly 32 bytes');
  }
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new Error('mint: seed must be a finite number');
  }
  if (!Array.isArray(entityIds) || entityIds.length === 0) {
    throw new Error('mint: entityIds must be a non-empty array');
  }
  for (const id of entityIds) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('mint: every entity id must be a non-empty string');
    }
    if (!(id in (provenance.entities ?? {}))) {
      throw new Error(`mint: entity '${id}' is not in the provenance graph`);
    }
  }
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error('mint: ops must be a non-empty array');
  }
  // Ops must be JSON-clean: anything that fails canonical JSON is rejected.
  try {
    canonicalJSON(ops as unknown as JSONValue);
  } catch {
    throw new Error('mint: ops must be JSON-serializable');
  }
  if (
    typeof license !== 'object' || license === null ||
    typeof license.use !== 'boolean' ||
    typeof license.remix !== 'boolean' ||
    typeof license.commercial !== 'boolean' ||
    typeof license.resell !== 'boolean'
  ) {
    throw new Error('mint: license must have boolean use/remix/commercial/resell');
  }
  if (!(opts.secretKey instanceof Uint8Array) || opts.secretKey.length !== 64) {
    throw new Error('mint: secretKey must be a 64-byte Ed25519 secret key');
  }

  const unsigned: UnsignedMint = {
    v: 1,
    kind: 'xr-mint',
    author,
    authorKey: authorKey.toLowerCase(),
    created: opts.created ?? new Date().toISOString(),
    seed,
    entityIds: [...new Set(entityIds)].sort(),
    provenanceHash: provenanceHash(provenance),
    ops: ops.map((op) => JSON.parse(canonicalJSON(op as unknown as JSONValue)) as BuildOp),
    license: {
      use: license.use, remix: license.remix,
      commercial: license.commercial, resell: license.resell,
    },
  };

  const id = fnv1aHex(canonicalJSON(unsigned as unknown as JSONValue));
  const signature = toHex(sign(signingBytes(unsigned), opts.secretKey));

  // Paranoia that costs nothing: the thing we just made must verify.
  const manifest: MintManifest = { ...unsigned, id, signature };
  const check = verifyMint(manifest);
  if (!check.ok) {
    throw new Error(`mint: self-check failed: ${check.reason}`);
  }
  return manifest;
}

export type MintVerification =
  | { ok: true; manifest: MintManifest }
  | { ok: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function hexOf(v: unknown, bytes: number): v is string {
  return typeof v === 'string' &&
    v.length === bytes * 2 &&
    /^[0-9a-f]+$/.test(v);
}

/**
 * Verify a mint manifest. Runs the full gauntlet: structural shape, id
 * recomputation (content-addressing), then the Ed25519 signature over the
 * canonical bytes with the author key embedded in the manifest. Never
 * throws on hostile input: garbage in, `{ ok: false, reason }` out.
 */
export function verifyMint(manifest: unknown): MintVerification {
  if (!isRecord(manifest)) return { ok: false, reason: 'not an object' };
  if (manifest.v !== 1) return { ok: false, reason: 'unsupported version' };
  if (manifest.kind !== 'xr-mint') return { ok: false, reason: 'wrong kind' };
  if (!nonEmpty(manifest.author)) return { ok: false, reason: 'missing author' };
  if (!hexOf(manifest.authorKey, 32)) return { ok: false, reason: 'bad authorKey' };
  if (!nonEmpty(manifest.created)) return { ok: false, reason: 'missing created' };
  if (typeof manifest.seed !== 'number' || !Number.isFinite(manifest.seed)) {
    return { ok: false, reason: 'bad seed' };
  }
  if (!Array.isArray(manifest.entityIds) || manifest.entityIds.length === 0) {
    return { ok: false, reason: 'entityIds must be a non-empty array' };
  }
  for (const id of manifest.entityIds) {
    if (!nonEmpty(id)) return { ok: false, reason: 'bad entity id' };
  }
  if (!hexOf(manifest.provenanceHash, 4)) {
    return { ok: false, reason: 'bad provenanceHash' };
  }
  if (!Array.isArray(manifest.ops) || manifest.ops.length === 0) {
    return { ok: false, reason: 'ops must be a non-empty array' };
  }
  const lic = manifest.license;
  if (
    !isRecord(lic) ||
    typeof lic.use !== 'boolean' ||
    typeof lic.remix !== 'boolean' ||
    typeof lic.commercial !== 'boolean' ||
    typeof lic.resell !== 'boolean'
  ) {
    return { ok: false, reason: 'bad license' };
  }
  if (!hexOf(manifest.id, 4)) return { ok: false, reason: 'bad id' };
  if (!hexOf(manifest.signature, 64)) return { ok: false, reason: 'bad signature' };

  const m = manifest as unknown as MintManifest;
  const unsigned = toUnsigned(m);

  // Content id must match the bytes being signed.
  if (mintId(m) !== m.id) {
    return { ok: false, reason: 'id does not match manifest content' };
  }

  const ok = verify(
    fromHex(m.signature),
    signingBytes(unsigned),
    fromHex(m.authorKey),
  );
  if (!ok) return { ok: false, reason: 'signature does not verify' };
  return { ok: true, manifest: m };
}
