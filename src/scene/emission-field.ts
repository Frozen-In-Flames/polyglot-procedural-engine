// scene/emission-field.ts - emission field layer (v2.0.8): tokamak
// emissivity as a first-class analytic scene field.
//
// Plasma emission in a tokamak is organized by the torus geometry: a
// core circle (the magnetic axis ring) of major radius R, with the
// emissivity a peaked function of the normalized minor radius
// rho = (distance from the core circle) / r, bright on the axis and
// falling to zero at the plasma boundary rho = 1. This module makes
// that field a thing the engine can sample analytically at any point:
//
//   emission(p) = I0 * (1 - rho^2)^alpha
//                   * (1 + aTor * cos(nTor * theta + phaseTor))
//                   * (1 + aPol * cos(phi + phasePol))   for rho < 1,
//               = 0                                       for rho >= 1,
//
// where theta is the toroidal angle about the main (Y) axis and phi
// the poloidal angle about the core circle. Amplitudes are capped at
// 1 so the variation factors stay in [0, 2] and the product can never
// flip the field's sign. The support is compact and the profile is
// continuous across the boundary for every alpha > 0.
//
// The distance story is exact, and it is the engine's own: with
// q = (|(x, z)| - R, y) in the local frame, the axis distance is
// |q| and distAt(p) = |q| - r is the signed distance to the torus
// surface, the same closed form as the 'torus' node of src/math/
// sdf.ts (graded equal in the tests, and 1-Lipschitz there as any
// true distance must be). So the tube boundary is a marchable SDF
// surface, contains(p) is distAt(p) <= 0, and sphere tracing over
// distAt inherits the usual no-overshoot guarantee.
//
// What the field is not: emission itself is an intensity, not a
// distance; it has no Lipschitz-1 property and nothing here claims
// one. The poloidal angle is singular on the core circle (rho = 0),
// as poloidal coordinates are; emission on the exact axis uses the
// phi = 0 convention, documented at coordsAt.
import type { Vec3 } from '../math/vec.js';

export interface EmissionParams {
  /** Torus center. Default [0, 0, 0]. */
  center?: Vec3;
  /** Major radius R of the core circle. Must be finite and > 0. */
  majorRadius: number;
  /** Minor radius r of the tube. Must satisfy 0 < r < R (a ring
   *  torus with a hole; r >= R self-intersects and is rejected). */
  minorRadius: number;
  /** Peak intensity I0 on the core circle (before variation
   *  factors). Must be finite and >= 0; 0 is a valid, exactly dark
   *  field. */
  intensity: number;
  /** Profile exponent alpha of (1 - rho^2)^alpha. Must be finite
   *  and > 0: alpha <= 0 is rejected because the profile would be
   *  flat or rising toward the boundary and discontinuous there. */
  profileExponent: number;
  /** Toroidal mode number n: the variation repeats n times around
   *  the main axis. Integer >= 0, default 0 (axisymmetric). */
  toroidalMode?: number;
  /** Toroidal variation amplitude in [0, 1], default 0. */
  toroidalAmp?: number;
  /** Toroidal phase in radians, default 0. */
  toroidalPhase?: number;
  /** Poloidal variation amplitude in [0, 1], default 0. Models the
   *  inboard/outboard asymmetry of a real emissivity profile. */
  poloidalAmp?: number;
  /** Poloidal phase in radians, default 0. phi = 0 is the outboard
   *  midplane, phi = pi the inboard midplane. */
  poloidalPhase?: number;
}

/** Resolved parameters, as validated and stored on the field. */
export interface ResolvedEmissionParams {
  center: Vec3;
  majorRadius: number;
  minorRadius: number;
  intensity: number;
  profileExponent: number;
  toroidalMode: number;
  toroidalAmp: number;
  toroidalPhase: number;
  poloidalAmp: number;
  poloidalPhase: number;
}

export interface EmissionCoords {
  /** Normalized minor radius: axisDistance / minorRadius. */
  rho: number;
  /** Distance from the core circle, in world units. */
  axisDistance: number;
  /** Toroidal angle about the main axis, atan2(z, x) in (-pi, pi]. */
  theta: number;
  /** Poloidal angle about the core circle, atan2(y, radial - R) in
   *  (-pi, pi]: 0 outboard, pi inboard, pi/2 top. Singular on the
   *  core circle itself, where it reads 0 by convention. */
  phi: number;
}

export interface EmissionField {
  /** The validated parameters this field was built from. */
  params: ResolvedEmissionParams;
  center: Vec3;
  majorRadius: number;
  minorRadius: number;
  /** Toroidal coordinates of a world point (center-relative). */
  coordsAt(p: Vec3): EmissionCoords;
  /** The base profile (1 - rho^2)^alpha on rho < 1, else 0. */
  profileAt(rho: number): number;
  /** Emission intensity at a world point. Exactly 0 outside the
   *  tube (rho >= 1) and everywhere when intensity is 0. */
  emissionAt(p: Vec3): number;
  /** Exact signed distance to the torus surface: negative inside
   *  the tube, zero on it, positive outside. Identical to the
   *  'torus' node of src/math/sdf.ts. */
  distAt(p: Vec3): number;
  /** Containment: distAt(p) <= 0. */
  contains(p: Vec3): boolean;
}

function fail(msg: string): never {
  throw new Error(`makeEmissionField: ${msg}`);
}

function finite(name: string, v: number): number {
  if (!Number.isFinite(v)) fail(`${name} must be finite, got ${v}`);
  return v;
}

/**
 * Build an emission field. Every parameter is validated up front and
 * an invalid configuration throws: there is no silent fallback,
 * because a quietly wrong field (a sign-flipped exponent rising
 * toward the boundary, a negative radius mirrored into a valid one)
 * would still render, just falsely.
 */
export function makeEmissionField(params: EmissionParams): EmissionField {
  const center: Vec3 = params.center
    ? [params.center[0], params.center[1], params.center[2]]
    : [0, 0, 0];
  for (const c of center) finite('center', c);
  const R = finite('majorRadius', params.majorRadius);
  const r = finite('minorRadius', params.minorRadius);
  const I0 = finite('intensity', params.intensity);
  const alpha = finite('profileExponent', params.profileExponent);
  const nTor = params.toroidalMode ?? 0;
  const aTor = params.toroidalAmp ?? 0;
  const pTor = finite('toroidalPhase', params.toroidalPhase ?? 0);
  const aPol = params.poloidalAmp ?? 0;
  const pPol = finite('poloidalPhase', params.poloidalPhase ?? 0);
  finite('toroidalAmp', aTor);
  finite('poloidalAmp', aPol);

  if (R <= 0) fail(`majorRadius must be > 0, got ${R}`);
  if (r <= 0) fail(`minorRadius must be > 0, got ${r}`);
  if (r >= R) {
    fail(`minorRadius must be < majorRadius (ring torus with a hole), got r=${r}, R=${R}`);
  }
  if (I0 < 0) fail(`intensity must be >= 0, got ${I0}`);
  if (alpha <= 0) {
    fail(`profileExponent must be > 0 (the profile must fall to zero at the boundary), got ${alpha}`);
  }
  if (!Number.isInteger(nTor) || nTor < 0) {
    fail(`toroidalMode must be an integer >= 0, got ${nTor}`);
  }
  if (aTor < 0 || aTor > 1) fail(`toroidalAmp must be in [0, 1], got ${aTor}`);
  if (aPol < 0 || aPol > 1) fail(`poloidalAmp must be in [0, 1], got ${aPol}`);

  const resolved: ResolvedEmissionParams = {
    center: [center[0], center[1], center[2]],
    majorRadius: R,
    minorRadius: r,
    intensity: I0,
    profileExponent: alpha,
    toroidalMode: nTor,
    toroidalAmp: aTor,
    toroidalPhase: pTor,
    poloidalAmp: aPol,
    poloidalPhase: pPol,
  };

  const coordsAt = (p: Vec3): EmissionCoords => {
    const x = p[0] - center[0];
    const y = p[1] - center[1];
    const z = p[2] - center[2];
    const radial = Math.hypot(x, z);
    const dr = radial - R;
    const axisDistance = Math.hypot(dr, y);
    return {
      rho: axisDistance / r,
      axisDistance,
      theta: Math.atan2(z, x),
      phi: Math.atan2(y, dr),
    };
  };

  const profileAt = (rho: number): number => {
    if (rho >= 1) return 0;
    const t = 1 - rho * rho;
    return Math.pow(t, alpha);
  };

  const emissionAt = (p: Vec3): number => {
    if (I0 === 0) return 0;
    const c = coordsAt(p);
    if (c.rho >= 1) return 0;
    const tor = 1 + aTor * Math.cos(nTor * c.theta + pTor);
    const pol = 1 + aPol * Math.cos(c.phi + pPol);
    return I0 * profileAt(c.rho) * tor * pol;
  };

  const distAt = (p: Vec3): number => coordsAt(p).axisDistance - r;

  const contains = (p: Vec3): boolean => distAt(p) <= 0;

  return {
    params: resolved, center, majorRadius: R, minorRadius: r,
    coordsAt, profileAt, emissionAt, distAt, contains,
  };
}

// ---------------------------------------------------------------------------
// Line integration: radiance along a ray segment, for volumetric
// consumers (the layer compositor in src/scene/layers.ts, tools).
// ---------------------------------------------------------------------------

/** Default quadrature density: midpoint samples per minor radius. */
export const EMISSION_STEPS_PER_MINOR = 16;
/** Default cap on quadrature samples per integral. */
export const EMISSION_MAX_SAMPLES = 8192;

export interface EmissionIntegrateOpts {
  /** Midpoint samples per minor radius. Default 16. */
  stepsPerMinor?: number;
  /** Hard cap on samples; the step grows to fit. Default 8192. */
  maxSamples?: number;
}

export interface EmissionQuadrature {
  /** Sample spacing along the ray, in world units. */
  step: number;
  /** Number of midpoint samples covering [0, tMax]. */
  samples: number;
}

/**
 * The deterministic quadrature policy shared by integrateEmission
 * and the layer compositor: nominal step = minorRadius /
 * stepsPerMinor, then the step is shrunk to tMax / samples so the
 * samples tile [0, tMax] exactly and no sample ever lands past the
 * segment end (a compositor integrating up to an occluding surface
 * must not leak emission from behind it). Only the sample cap
 * enlarges the step. A pure function of the field and tMax, so
 * every consumer integrates on the same nodes.
 */
export function emissionQuadrature(
  field: EmissionField,
  tMax: number,
  opts: EmissionIntegrateOpts = {},
): EmissionQuadrature {
  const per = opts.stepsPerMinor ?? EMISSION_STEPS_PER_MINOR;
  const cap = opts.maxSamples ?? EMISSION_MAX_SAMPLES;
  if (!Number.isFinite(tMax) || tMax <= 0) return { step: 0, samples: 0 };
  let samples = Math.max(1, Math.ceil(tMax / (field.minorRadius / per)));
  if (samples > cap) samples = cap;
  return { step: tMax / samples, samples };
}

export interface EmissionIntegral {
  /** Integrated emission along the segment, intensity x length. */
  value: number;
  /** Midpoint samples taken. */
  samples: number;
  /** Sample spacing used. */
  step: number;
}

/**
 * Midpoint-integrate emissionAt along origin + t * dir for t in
 * [0, tMax]. dir is used as given (callers pass unit directions, so
 * t is world distance). The integrand has compact support, so the
 * samples outside the tube contribute exact zeros; accuracy is
 * graded against the analytic chord integral in the tests.
 */
export function integrateEmission(
  field: EmissionField,
  origin: Vec3,
  dir: Vec3,
  tMax: number,
  opts: EmissionIntegrateOpts = {},
): EmissionIntegral {
  const { step, samples } = emissionQuadrature(field, tMax, opts);
  if (samples === 0) return { value: 0, samples: 0, step: 0 };
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const t = (i + 0.5) * step;
    sum += field.emissionAt([
      origin[0] + dir[0] * t,
      origin[1] + dir[1] * t,
      origin[2] + dir[2] * t,
    ]);
  }
  return { value: sum * step, samples, step };
}
