// own/rights.ts - license enforcement over mints (V6 step 3).
//
// A mint's license is a claim the author made; this module is where the
// engine honors it. `canDo` is the pure predicate, `enforce` throws a
// RightsError on denial, and RightsGate puts the checks on the natural
// seams: engine load/clone paths should call gateSpawn before materializing
// a mint's math, gateRemix before accepting a derivative session, and
// gateResell before transferring a mint to another author.
//
// Pure core: no DOM, no WebGL, no node builtins, no new dependencies.

import type { LicenseTerms, MintManifest } from './mint.js';

/** The four rights a license grants or withholds. */
export type RightAction = 'use' | 'remix' | 'commercial' | 'resell';

/** Thrown when a license does not grant the requested action. */
export class RightsError extends Error {
  readonly action: RightAction;
  readonly mintId: string;
  constructor(action: RightAction, manifest: MintManifest) {
    super(
      `rights: '${action}' not granted by the license on mint ` +
      `'${manifest.id}' (license: ${describeLicense(manifest.license)})`,
    );
    this.name = 'RightsError';
    this.action = action;
    this.mintId = manifest.id;
  }
}

/** Pure predicate: does the mint's license grant this action? */
export function canDo(manifest: MintManifest, action: RightAction): boolean {
  return manifest.license[action] === true;
}

/**
 * Enforce a license: returns void on allow, throws RightsError on deny.
 * The message names the action and the license, so logs stay actionable.
 */
export function enforce(manifest: MintManifest, action: RightAction): void {
  if (!canDo(manifest, action)) {
    throw new RightsError(action, manifest);
  }
}

/**
 * One-line human summary of a license. Plain hyphens and commas: no
 * em dashes, per the house style.
 */
export function describeLicense(license: LicenseTerms): string {
  const parts: string[] = [];
  parts.push(license.use ? 'use allowed' : 'use denied');
  parts.push(license.remix ? 'remix allowed' : 'remix denied');
  parts.push(license.commercial ? 'commercial allowed' : 'commercial denied');
  parts.push(license.resell ? 'resell allowed' : 'resell denied');
  if (license.use && license.remix && license.commercial && license.resell) {
    return 'open: everything allowed';
  }
  return parts.join(', ');
}

/**
 * Enforcement gates on the engine's natural seams. Call these before the
 * engine acts on a mint; each returns the manifest on allow and throws
 * RightsError on deny, so a denied load dies before any math is spent.
 *
 *  gateSpawn  engine load/clone paths: a mint's math may only be
 *             materialized when 'use' is granted.
 *  gateRemix  derivative sessions: building on a mint's math requires
 *             'remix'.
 *  gateResell mint transfers: handing a mint to another author requires
 *             'resell'.
 */
export class RightsGate {
  /** Guard engine load/clone of a mint's math. */
  gateSpawn(manifest: MintManifest, _spawnerActor: string): MintManifest {
    enforce(manifest, 'use');
    return manifest;
  }

  /** Guard accepting a derivative session built on a mint's math. */
  gateRemix(manifest: MintManifest): MintManifest {
    enforce(manifest, 'remix');
    return manifest;
  }

  /** Guard transferring a mint to another author. */
  gateResell(manifest: MintManifest): MintManifest {
    enforce(manifest, 'resell');
    return manifest;
  }
}
