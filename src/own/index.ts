// own/index.ts - public surface of the V6 ownership module.
//
// V6 thesis: ownership, fully off-chain, $0 budget. Provenance is a pure
// query layer over the V5 op log: no server, no chain, no fees. The math
// grows the world; this module records whose math it was.

export type {
  EntityKind, EntityProvenance, ModificationRecord, ProvenanceGraph,
} from './provenance.js';
export {
  buildProvenance, queryEntity, entitiesByAuthor, creationOps,
  provenanceHash,
} from './provenance.js';

// V6 step 2: the signed mint manifest.
export type { LicenseTerms, MintManifest, CreateMintOpts, MintVerification } from './mint.js';
export {
  LICENSE_OPEN, LICENSE_NONCOMMERCIAL, LICENSE_PERSONAL,
  createMint, verifyMint, mintId,
} from './mint.js';

// V6 step 3: license enforcement.
export type { RightAction } from './rights.js';
export { RightsError, RightsGate, canDo, enforce, describeLicense } from './rights.js';

// V6 step 4: the public registry.
export type { RegistryEntry, SignedRegistry, RegistryKeypair } from './registry.js';
export { createRegistry, appendEntry, entryFromMint, verifyRegistry } from './registry.js';

// V6 step 5: the chain adapter interface V7 will implement (types only).
export type { AnchorReceipt, AnchorCost, ChainAdapter } from './chain.js';
