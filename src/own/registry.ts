// own/registry.ts - the public record of mints (V6 step 4).
//
// The registry is the off-chain answer to "what mints exist and who says
// so?": a signed, append-only list of mint ids, their authors, and their
// licenses. The registry operator signs the whole list with their own
// Ed25519 key; anyone can verify the signature and therefore the list.
//
// Entries are kept sorted by mintId, so the same set of entries always
// serializes to the same bytes: deterministic signatures, easy gossip
// between nodes, no server required.
//
// Pure core: no DOM, no WebGL, no node builtins, no new dependencies.

import { canonicalJSON } from '../state/hash.js';
import type { JSONValue } from '../state/types.js';
import { fromHex, sign, toHex, verify } from './ed25519.js';
import type { LicenseTerms, MintManifest } from './mint.js';

/** One public record in the registry. */
export interface RegistryEntry {
  mintId: string;
  authorKey: string;
  author: string;
  registeredAt: string;
  license: LicenseTerms;
}

/** A signed registry: version, sorted entries, and the operator's signature. */
export interface SignedRegistry {
  v: 1;
  entries: RegistryEntry[];
  /** Ed25519 signature over canonical JSON of {v, entries}, hex. */
  signature: string;
}

export interface RegistryKeypair {
  publicKey: string;
  secretKey: Uint8Array;
}

function signingForm(registry: SignedRegistry): { v: 1; entries: RegistryEntry[] } {
  return { v: 1, entries: registry.entries };
}

function signingBytes(reg: SignedRegistry): Uint8Array {
  return new TextEncoder().encode(
    canonicalJSON(signingForm(reg) as unknown as JSONValue),
  );
}

/** Create an empty registry, signed by the operator's keypair. */
export function createRegistry(keypair: RegistryKeypair): SignedRegistry {
  const reg: SignedRegistry = { v: 1, entries: [], signature: '' };
  reg.signature = toHex(sign(signingBytes(reg), keypair.secretKey));
  return reg;
}

/**
 * Build a registry entry from a verified mint manifest. The caller should
 * have run verifyMint first; this helper just projects the public fields.
 */
export function entryFromMint(
  manifest: MintManifest,
  registeredAt?: string,
): RegistryEntry {
  return {
    mintId: manifest.id,
    authorKey: manifest.authorKey,
    author: manifest.author,
    registeredAt: registeredAt ?? new Date().toISOString(),
    license: { ...manifest.license },
  };
}

/**
 * Append an entry and re-sign. Entries stay sorted by mintId, so the same
 * set always signs to the same bytes. Throws on a duplicate mintId or a
 * malformed registry; never mutates the input.
 */
export function appendEntry(
  registry: SignedRegistry,
  entry: RegistryEntry,
  secretKey: Uint8Array,
): SignedRegistry {
  if (
    typeof registry !== 'object' || registry === null ||
    registry.v !== 1 || !Array.isArray(registry.entries)
  ) {
    throw new Error('registry: malformed registry');
  }
  if (
    typeof entry !== 'object' || entry === null ||
    typeof entry.mintId !== 'string' || entry.mintId.length === 0 ||
    typeof entry.authorKey !== 'string' || entry.authorKey.length === 0 ||
    typeof entry.author !== 'string' || entry.author.length === 0
  ) {
    throw new Error('registry: malformed entry');
  }
  if (registry.entries.some((e) => e.mintId === entry.mintId)) {
    throw new Error(`registry: duplicate mintId '${entry.mintId}'`);
  }
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 64) {
    throw new Error('registry: secretKey must be a 64-byte Ed25519 secret key');
  }
  const next: SignedRegistry = {
    v: 1,
    entries: [...registry.entries, { ...entry }].sort((a, b) =>
      a.mintId < b.mintId ? -1 : a.mintId > b.mintId ? 1 : 0,
    ),
    signature: '',
  };
  next.signature = toHex(sign(signingBytes(next), secretKey));
  return next;
}

/**
 * Verify a registry against the operator's public key (hex). Checks the
 * shape, the sort order, and the Ed25519 signature. Never throws: hostile
 * input just fails.
 */
export function verifyRegistry(registry: unknown, publicKey: string): boolean {
  try {
    if (
      typeof registry !== 'object' || registry === null ||
      (registry as SignedRegistry).v !== 1 ||
      !Array.isArray((registry as SignedRegistry).entries) ||
      typeof (registry as SignedRegistry).signature !== 'string'
    ) {
      return false;
    }
    const reg = registry as SignedRegistry;
    // Entries must be sorted by mintId: order is part of the signed bytes.
    for (let i = 1; i < reg.entries.length; i++) {
      if (reg.entries[i - 1].mintId >= reg.entries[i].mintId) return false;
    }
    const pub = fromHex(publicKey);
    if (pub.length !== 32) return false;
    return verify(fromHex(reg.signature), signingBytes(reg), pub);
  } catch {
    return false;
  }
}
