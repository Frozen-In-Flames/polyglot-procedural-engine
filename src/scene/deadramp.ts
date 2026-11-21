// src/scene/deadramp.ts - DeadRamp Base catalog door into the city
// converter (Family 3 integration, 2026-11-21).
//
// A DeadRamp Base build record (data/base-catalog.json in the
// deadramp-base repository) describes one merged build: its modules,
// the byte size and SHA-256 of every source file in its manifest, its
// HTTP surface, and its test counts. This module converts one such
// record into the engine's layout form, the same intermediate form
// GeoJSON, OBJ, and glTF imports land in, so the record can be fitted
// with fitCitySpec and regenerated with buildCity like any other
// city.
//
// The mapping is stated, not hidden: one building per manifest entry,
// placed on a deterministic grid in manifest order; footprint side
// and height both scale with the square root of the entry's byte
// count, so a file four times as large stands twice as wide and
// twice as tall. The record itself is data; the geometry is the
// engine's, generated from the fitted spec.

export interface DeadRampManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface DeadRampBuildRecord {
  groupDir: string;
  title: string;
  package: string;
  manifest: DeadRampManifestEntry[];
  http?: { operationsTotal?: number };
  testCount?: number;
  specCount?: number;
}

export interface LayoutBuilding {
  x: number;
  z: number;
  w: number;
  d: number;
  height: number;
  angle: number;
}

/** Meters of footprint side per square root of byte count. */
export const DEADRAMP_FOOTPRINT_SCALE = 0.09;
/** Meters of height per square root of byte count. */
export const DEADRAMP_HEIGHT_SCALE = 0.16;
/** Grid pitch between neighbouring module buildings, meters. */
export const DEADRAMP_GRID_PITCH_M = 42;

/**
 * Convert one DeadRamp Base build record into a layout object for
 * fitCitySpec. Throws on a record with no manifest entries or a
 * non-positive byte count, matching the converter's rule that
 * degenerate inputs are rejected rather than silently fitted.
 */
export function layoutFromDeadRampBuild(
  record: DeadRampBuildRecord,
): { buildings: LayoutBuilding[] } {
  if (!record || !Array.isArray(record.manifest) || record.manifest.length === 0) {
    throw new Error('layoutFromDeadRampBuild: record has no manifest entries');
  }
  const cols = Math.ceil(Math.sqrt(record.manifest.length));
  const buildings = record.manifest.map((entry, i) => {
    if (!Number.isFinite(entry.bytes) || entry.bytes <= 0) {
      throw new Error(
        `layoutFromDeadRampBuild: manifest entry ${entry.path} has no positive byte count`,
      );
    }
    const root = Math.sqrt(entry.bytes);
    const side = Math.max(4, root * DEADRAMP_FOOTPRINT_SCALE);
    return {
      x: (i % cols) * DEADRAMP_GRID_PITCH_M,
      z: Math.floor(i / cols) * DEADRAMP_GRID_PITCH_M,
      w: side,
      d: side,
      height: Math.max(3, root * DEADRAMP_HEIGHT_SCALE),
      angle: 0,
    };
  });
  return { buildings };
}
