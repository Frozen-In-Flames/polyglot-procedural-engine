// inverse/jit.ts - just-in-time inverse rendering: per-frame MAP solves.
//
// "Just in time" = solving for scene parameters per frame under a fixed
// time budget. Ground truth: docs/oracles/test_jit_inverse.py (owner's
// file, run in his sandbox) and docs/jit-inverse-rendering.md.
//
// The toy: Lambertian sphere, known geometry and albedo, unknown light
// (azimuth, elevation, intensity) plus ambient, Gaussian noise.
// theta = (az, el, I, A), y = rho * (A + I * max(n . l(az,el), 0)).
//
// Per-frame MAP Gauss-Newton step (his sign convention, r = y - R):
//   (J^T J / s2 + P^-1) d = J^T r / s2 + P^-1 (thetaPred - theta)
// which, for one step from the prior mean, is exactly the Kalman update.
// Self-contained: own RNG, own small dense linear algebra, own synthetic
// scene. Zero dependencies beyond the language.

export type Vec = number[];
export type Mat = number[][]; // row-major

// ---------------------------------------------------------------------------
// Seeded RNG (deterministic tests; no Math.random anywhere).
// ---------------------------------------------------------------------------
export interface Rng {
  next(): number;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

const spareMap = new WeakMap<Rng, number>();

/** Standard normal via Box-Muller (spare cached per RNG). */
export function randn(rng: Rng): number {
  const sp = spareMap.get(rng);
  if (sp !== undefined) {
    spareMap.delete(rng);
    return sp;
  }
  const u1 = Math.max(rng.next(), 1e-12);
  const u2 = rng.next();
  const r = Math.sqrt(-2 * Math.log(u1));
  spareMap.set(rng, r * Math.sin(2 * Math.PI * u2));
  return r * Math.cos(2 * Math.PI * u2);
}

// ---------------------------------------------------------------------------
// Small dense linear algebra (row-major number[][]).
// ---------------------------------------------------------------------------
export function matVec(A: Mat, x: Vec): Vec {
  return A.map((row) => row.reduce((s, v, j) => s + v * x[j], 0));
}

function cholesky(A: Mat): Mat {
  const n = A.length;
  const L: Mat = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0) throw new Error('cholesky: matrix is not positive definite');
        L[i][j] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

function cholSolve(L: Mat, b: Vec): Vec {
  const n = L.length;
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

/** Solve A x = b for symmetric positive-definite A. */
export function solveSPD(A: Mat, b: Vec): Vec {
  return cholSolve(cholesky(A), b);
}

/** Invert a symmetric positive-definite matrix. */
export function invertSPD(A: Mat): Mat {
  const n = A.length;
  const L = cholesky(A);
  const inv: Mat = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    const e = new Array(n).fill(0);
    e[j] = 1;
    const col = cholSolve(L, e);
    for (let i = 0; i < n; i++) inv[i][j] = col[i];
  }
  return inv;
}

/** General dense solve via Gaussian elimination with partial pivoting. */
export function solveLinear(A: Mat, b: Vec): Vec {
  const n = A.length;
  const Mtx: number[][] = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(Mtx[r][c]) > Math.abs(Mtx[piv][c])) piv = r;
    const tmp = Mtx[c];
    Mtx[c] = Mtx[piv];
    Mtx[piv] = tmp;
    const d = Mtx[c][c] === 0 ? 1e-300 : Mtx[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = Mtx[r][c] / d;
      for (let k = c; k <= n; k++) Mtx[r][k] -= f * Mtx[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = Mtx[r][n];
    for (let k = r + 1; k < n; k++) s -= Mtx[r][k] * x[k];
    const d = Mtx[r][r] === 0 ? 1e-300 : Mtx[r][r];
    x[r] = s / d;
  }
  return x;
}

/** Eigenvalues (descending) of a symmetric matrix via cyclic Jacobi. */
export function symEigenvalues(A: Mat, sweeps = 24): number[] {
  const n = A.length;
  const a: Mat = A.map((row) => row.slice());
  for (let s = 0; s < sweeps; s++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p][q];
        if (Math.abs(apq) < 1e-18) continue;
        const theta = (0.5 * (a[q][q] - a[p][p])) / apq;
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const sn = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - sn * akq;
          a[k][q] = sn * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - sn * aqk;
          a[q][k] = sn * apk + c * aqk;
        }
      }
    }
  }
  return a.map((row, i) => row[i]).sort((x, y) => y - x);
}

/** cond(Phi) = sqrt(lmax / lmin) of the Gram matrix Phi^T Phi. */
export function gramCond(Phi: Mat): number {
  const p = Phi[0].length;
  const G: Mat = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let j = 0; j < Phi.length; j++) {
    const row = Phi[j];
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) G[a][b] += row[a] * row[b];
  }
  const ev = symEigenvalues(G);
  return Math.sqrt(ev[0] / Math.max(ev[ev.length - 1], 1e-300));
}

// ---------------------------------------------------------------------------
// Synthetic scene: Lambertian sphere on a fixed pixel grid.
// ---------------------------------------------------------------------------
export interface Pixels {
  normals: Vec[];
  count: number;
}

/** N x N grid over [-1,1]^2 masked to radius 0.95; normals of the unit sphere. */
export function sphereGrid(N = 64): Pixels {
  const normals: Vec[] = [];
  for (let iy = 0; iy < N; iy++) {
    const y = ((iy + 0.5) / N) * 2 - 1;
    for (let ix = 0; ix < N; ix++) {
      const x = ((ix + 0.5) / N) * 2 - 1;
      const r2 = x * x + y * y;
      if (r2 < 0.95 * 0.95) normals.push([x, y, Math.sqrt(1 - r2)]);
    }
  }
  return { normals, count: normals.length };
}

export function subRows(rows: Vec[], idx: number[]): Vec[] {
  return idx.map((i) => rows[i]);
}

export function lightDir(az: number, el: number): Vec {
  return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
}

/** y = rho * (A + I * max(n . l(az,el), 0)), theta = (az, el, I, A). */
export function renderLambertN(theta: Vec, normals: Vec[], rho: number): Vec {
  const l = lightDir(theta[0], theta[1]);
  const I = theta[2];
  const A = theta[3];
  return normals.map((n) => {
    const nl = n[0] * l[0] + n[1] * l[1] + n[2] * l[2];
    return rho * (A + I * Math.max(nl, 0));
  });
}

export function renderLambert(theta: Vec, px: Pixels, rho: number): Vec {
  return renderLambertN(theta, px.normals, rho);
}

/** Analytic Jacobian, m x 4. The terminator max(.,0) kink is a subgradient. */
export function jacLambertN(theta: Vec, normals: Vec[], rho: number): Mat {
  const az = theta[0];
  const el = theta[1];
  const I = theta[2];
  const l = lightDir(az, el);
  const dlAz = [Math.cos(el) * Math.cos(az), 0, -Math.cos(el) * Math.sin(az)];
  const dlEl = [-Math.sin(el) * Math.sin(az), Math.cos(el), -Math.sin(el) * Math.cos(az)];
  return normals.map((n) => {
    const nl = n[0] * l[0] + n[1] * l[1] + n[2] * l[2];
    const m = nl > 0 ? 1 : 0;
    const gAz = n[0] * dlAz[0] + n[1] * dlAz[1] + n[2] * dlAz[2];
    const gEl = n[0] * dlEl[0] + n[1] * dlEl[1] + n[2] * dlEl[2];
    return [rho * I * m * gAz, rho * I * m * gEl, rho * m * nl, rho];
  });
}

export function jacLambert(theta: Vec, px: Pixels, rho: number): Mat {
  return jacLambertN(theta, px.normals, rho);
}

/**
 * Closed-form initializer ignoring the clamp: y/rho = A + n . v with
 * v = I * l, solved by least squares; then I = ||v||, l = v / I.
 * Only works for model classes with a linear core like this one.
 */
export function linearInitLight(y: Vec, px: Pixels, rho: number): Vec {
  const G: Mat = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const b = [0, 0, 0, 0];
  for (let j = 0; j < px.count; j++) {
    const n = px.normals[j];
    const phi = [1, n[0], n[1], n[2]];
    const t = y[j] / rho;
    for (let a = 0; a < 4; a++) {
      b[a] += phi[a] * t;
      for (let c = 0; c < 4; c++) G[a][c] += phi[a] * phi[c];
    }
  }
  const sol = solveSPD(G, b);
  const v = [sol[1], sol[2], sol[3]];
  const I0 = Math.hypot(v[0], v[1], v[2]);
  const l = I0 > 1e-9 ? [v[0] / I0, v[1] / I0, v[2] / I0] : [0, 0, 1];
  return [
    Math.atan2(l[0], l[2]),
    Math.asin(Math.max(-1, Math.min(1, l[1]))),
    I0,
    Math.max(sol[0], 0),
  ];
}

// ---------------------------------------------------------------------------
// Per-frame MAP Gauss-Newton with warm starts and backtracking.
// ---------------------------------------------------------------------------
export interface GnStep {
  delta: Vec;
  /** Information matrix J^T J / s2 + PInv at the linearization point. */
  info: Mat;
}

/**
 * One MAP Gauss-Newton step.
 * (J^T J / s2 + PInv) d = J^T r / s2 + PInv (thetaPred - theta), r = y - R.
 * With theta = thetaPred this is exactly one Kalman (EKF) update step.
 */
export function mapGnStep(
  theta: Vec,
  thetaPred: Vec,
  PInv: Mat,
  y: Vec,
  Rfun: (th: Vec) => Vec,
  Jfun: (th: Vec) => Mat,
  sigma2: number,
): GnStep {
  const p = theta.length;
  const Rv = Rfun(theta);
  const Jm = Jfun(theta);
  const r = y.map((v, j) => v - Rv[j]);
  const info: Mat = Array.from({ length: p }, () => new Array(p).fill(0));
  const g = new Array(p).fill(0);
  for (let j = 0; j < y.length; j++) {
    const row = Jm[j];
    for (let a = 0; a < p; a++) {
      g[a] += (row[a] * r[j]) / sigma2;
      for (let b = 0; b < p; b++) info[a][b] += (row[a] * row[b]) / sigma2;
    }
  }
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < p; b++) info[a][b] += PInv[a][b];
    let pv = 0;
    for (let b = 0; b < p; b++) pv += PInv[a][b] * (thetaPred[b] - theta[b]);
    g[a] += pv;
  }
  return { delta: solveSPD(info, g), info };
}

export interface FrameResult {
  theta: Vec;
  iters: number;
  info: Mat;
}

export interface SolveOpts {
  thetaPred?: Vec;
  P?: Mat;
  tol?: number;
  maxIter?: number;
}

/**
 * MAP Gauss-Newton with backtracking on the MAP cost (port of the owner's
 * solve()). Damped normal equations; stops when the step norm < tol.
 */
export function solveFrame(
  y: Vec,
  thetaInit: Vec,
  R: (th: Vec) => Vec,
  J: (th: Vec) => Mat,
  sigma2: number,
  opts: SolveOpts,
): FrameResult {
  const p = thetaInit.length;
  const tol = opts.tol ?? 1e-4;
  const maxIter = opts.maxIter ?? 30;
  const PInv: Mat | null = opts.P ? invertSPD(opts.P) : null;
  const thetaPred: Vec | null = opts.thetaPred ?? null;

  const cost = (t: Vec): number => {
    const Rv = R(t);
    let c = 0;
    for (let j = 0; j < y.length; j++) {
      const d = y[j] - Rv[j];
      c += (0.5 * d * d) / sigma2;
    }
    if (PInv && thetaPred) {
      const d = t.map((v, i) => v - thetaPred[i]);
      let q = 0;
      for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) q += d[a] * PInv[a][b] * d[b];
      c += 0.5 * q;
    }
    return c;
  };

  const zeroP: Mat = Array.from({ length: p }, () => new Array(p).fill(0));
  let th = thetaInit.slice();
  let info: Mat = zeroP;
  let iters = 0;
  for (let it = 1; it <= maxIter; it++) {
    const Rv = R(th);
    const Jm = J(th);
    const r = y.map((v, j) => v - Rv[j]);
    info = Array.from({ length: p }, () => new Array(p).fill(0));
    const g = new Array(p).fill(0);
    for (let j = 0; j < y.length; j++) {
      const row = Jm[j];
      for (let a = 0; a < p; a++) {
        g[a] += (row[a] * r[j]) / sigma2;
        for (let b = 0; b < p; b++) info[a][b] += (row[a] * row[b]) / sigma2;
      }
    }
    if (PInv && thetaPred) {
      for (let a = 0; a < p; a++) {
        for (let b = 0; b < p; b++) info[a][b] += PInv[a][b];
        let pv = 0;
        for (let b = 0; b < p; b++) pv += PInv[a][b] * (thetaPred[b] - th[b]);
        g[a] += pv;
      }
    }
    const damped: Mat = info.map((row, a) => row.map((v, b) => v + (a === b ? 1e-9 : 0)));
    const d = solveSPD(damped, g);
    const c0 = cost(th);
    let s = 1;
    for (;;) {
      const trial = th.map((v, a) => v + s * d[a]);
      if (cost(trial) <= c0 || s <= 1e-3) break;
      s *= 0.5;
    }
    th = th.map((v, a) => v + s * d[a]);
    iters = it;
    if (Math.max(...d.map((v) => Math.abs(v))) * s < tol) break;
  }
  return { theta: th, iters, info };
}

/** Reduced chi-squared of the residual: ~1.0 at the noise floor. */
export function chi2reduced(y: Vec, theta: Vec, R: (th: Vec) => Vec, sigma: number): number {
  const Rv = R(theta);
  let s = 0;
  for (let j = 0; j < y.length; j++) {
    const d = (y[j] - Rv[j]) / sigma;
    s += d * d;
  }
  return s / y.length;
}

/** Kalman update for a linear model y = Jl t + noise (test B reference). */
export function kalmanLinearUpdate(
  tp: Vec,
  Pp: Mat,
  y: Vec,
  Jl: Mat,
  rVar: number,
): { t: Vec; P: Mat } {
  const m = y.length;
  const p = tp.length;
  // S = Jl Pp Jl^T + rVar I
  const S: Mat = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      let s = i === j ? rVar : 0;
      for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) s += Jl[i][a] * Pp[a][b] * Jl[j][b];
      S[i][j] = s;
    }
  }
  // K = Pp Jl^T S^{-1}: solve S X = (Pp Jl^T)^T columnwise via S^T = S.
  const PJt: Mat = Array.from({ length: p }, () => new Array(m).fill(0));
  for (let a = 0; a < p; a++) for (let j = 0; j < m; j++) {
    let s = 0;
    for (let b = 0; b < p; b++) s += Pp[a][b] * Jl[j][b];
    PJt[a][j] = s;
  }
  const K: Mat = Array.from({ length: p }, () => new Array(m).fill(0));
  for (let a = 0; a < p; a++) {
    const col = solveLinear(S, PJt[a]);
    for (let j = 0; j < m; j++) K[a][j] = col[j];
  }
  const r = y.map((v, j) => {
    let pred = 0;
    for (let a = 0; a < p; a++) pred += Jl[j][a] * tp[a];
    return v - pred;
  });
  const t = tp.map((v, a) => {
    let s = 0;
    for (let j = 0; j < m; j++) s += K[a][j] * r[j];
    return v + s;
  });
  // P = (I - K Jl) Pp
  const KJ: Mat = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let a = 0; a < p; a++) {
    for (let c = 0; c < p; c++) {
      let v = 0;
      for (let j = 0; j < m; j++) v += K[a][j] * Jl[j][c];
      KJ[a][c] = v;
    }
  }
  const P: Mat = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < p; b++) {
      let s = 0;
      for (let c = 0; c < p; c++) s += ((a === c ? 1 : 0) - KJ[a][c]) * Pp[c][b];
      P[a][b] = s;
    }
  }
  return { t, P };
}

/**
 * Normalized innovation squared (change-detection statistic), Woodbury form:
 * NIS = r^T r / s2 - q^T Ainf^{-1} q, q = J^T r / s2,
 * Ainf = J^T J / s2 + P^{-1}.  z = (NIS - m) / sqrt(2m); flag when z > 6.
 */
export function nisStatistic(
  y: Vec,
  thetaPred: Vec,
  P: Mat,
  Rfun: (th: Vec) => Vec,
  Jfun: (th: Vec) => Mat,
  sigma2: number,
): number {
  const p = thetaPred.length;
  const Rv = Rfun(thetaPred);
  const Jm = Jfun(thetaPred);
  const r = y.map((v, j) => v - Rv[j]);
  const PInv = invertSPD(P);
  const Ainf: Mat = Array.from({ length: p }, () => new Array(p).fill(0));
  const q = new Array(p).fill(0);
  let r2 = 0;
  for (let j = 0; j < y.length; j++) {
    r2 += r[j] * r[j];
    const row = Jm[j];
    for (let a = 0; a < p; a++) {
      q[a] += (row[a] * r[j]) / sigma2;
      for (let b = 0; b < p; b++) Ainf[a][b] += (row[a] * row[b]) / sigma2;
    }
  }
  for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) Ainf[a][b] += PInv[a][b];
  const w = solveSPD(Ainf, q);
  let qMq = 0;
  for (let a = 0; a < p; a++) qMq += q[a] * w[a];
  return r2 / sigma2 - qMq;
}

// ---------------------------------------------------------------------------
// Spherical harmonics (9 coefficients, orthonormal basis).
// ---------------------------------------------------------------------------
export function shBasis9(n: Vec): Vec {
  const x = n[0];
  const y = n[1];
  const z = n[2];
  return [
    0.282095,
    0.488603 * y,
    0.488603 * z,
    0.488603 * x,
    1.092548 * x * y,
    1.092548 * y * z,
    0.315392 * (3 * z * z - 1),
    1.092548 * x * z,
    0.546274 * (x * x - y * y),
  ];
}

/** A-hat from the clamped cosine (owner's SH oracle): (pi, 2pi/3, pi/4). */
export const AHAT9: Vec = [
  Math.PI,
  (2 * Math.PI) / 3,
  (2 * Math.PI) / 3,
  (2 * Math.PI) / 3,
  Math.PI / 4,
  Math.PI / 4,
  Math.PI / 4,
  Math.PI / 4,
  Math.PI / 4,
];

/** Closed-form one-shot solve: (Phi^T Phi)^{-1} Phi^T y. */
export function estimateSH(Phi: Mat, y: Vec): Vec {
  const p = Phi[0].length;
  const G: Mat = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let j = 0; j < Phi.length; j++) {
    const row = Phi[j];
    for (let a = 0; a < p; a++) {
      b[a] += row[a] * y[j];
      for (let c = 0; c < p; c++) G[a][c] += row[a] * row[c];
    }
  }
  return solveSPD(G, b);
}

/** Ridge solve toward a center: (Phi^T Phi + l I)^{-1} (Phi^T y + l center). */
export function ridgeSH(Phi: Mat, y: Vec, lambda: number, center: Vec): Vec {
  const p = Phi[0].length;
  const G: Mat = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let j = 0; j < Phi.length; j++) {
    const row = Phi[j];
    for (let a = 0; a < p; a++) {
      b[a] += row[a] * y[j];
      for (let c = 0; c < p; c++) G[a][c] += row[a] * row[c];
    }
  }
  for (let a = 0; a < p; a++) {
    G[a][a] += lambda;
    b[a] += lambda * center[a];
  }
  return solveSPD(G, b);
}

// ---------------------------------------------------------------------------
// Geometry parameter: ellipsoid squash in the JIT loop.
//
// Unit sphere stretched along z by c: surface point for pixel (x, y) is
// (x, y, s / c) with s = sqrt(1 - x^2 - y^2); normal = w / ||w||.
// theta5 = (az, el, I, A, c). Analytic Jacobian via the chain rule.
// ---------------------------------------------------------------------------
export interface EllipPx {
  xs: number[];
  ys: number[];
  ss: number[];
  count: number;
}

export function ellipPixels(N = 64): EllipPx {
  const xs: number[] = [];
  const ys: number[] = [];
  const ss: number[] = [];
  for (let iy = 0; iy < N; iy++) {
    const y = ((iy + 0.5) / N) * 2 - 1;
    for (let ix = 0; ix < N; ix++) {
      const x = ((ix + 0.5) / N) * 2 - 1;
      const r2 = x * x + y * y;
      if (r2 < 0.95 * 0.95) {
        xs.push(x);
        ys.push(y);
        ss.push(Math.sqrt(1 - r2));
      }
    }
  }
  return { xs, ys, ss, count: xs.length };
}

export function renderEllipsoid(theta5: Vec, px: EllipPx, rho: number): Vec {
  const l = lightDir(theta5[0], theta5[1]);
  const I = theta5[2];
  const A = theta5[3];
  const c = theta5[4];
  const out = new Array(px.count);
  for (let j = 0; j < px.count; j++) {
    const wz = px.ss[j] / c;
    const L = Math.hypot(px.xs[j], px.ys[j], wz);
    const nl = (px.xs[j] * l[0] + px.ys[j] * l[1] + wz * l[2]) / L;
    out[j] = rho * (A + I * Math.max(nl, 0));
  }
  return out;
}

export function jacEllipsoid(theta5: Vec, px: EllipPx, rho: number): Mat {
  const az = theta5[0];
  const el = theta5[1];
  const I = theta5[2];
  const c = theta5[4];
  const l = lightDir(az, el);
  const dlAz = [Math.cos(el) * Math.cos(az), 0, -Math.cos(el) * Math.sin(az)];
  const dlEl = [-Math.sin(el) * Math.sin(az), Math.cos(el), -Math.sin(el) * Math.cos(az)];
  const out: Mat = new Array(px.count);
  for (let j = 0; j < px.count; j++) {
    const x = px.xs[j];
    const y = px.ys[j];
    const s = px.ss[j];
    const wz = s / c;
    const L2 = x * x + y * y + wz * wz;
    const L = Math.sqrt(L2);
    const nx = x / L;
    const ny = y / L;
    const nz = wz / L;
    const nl = nx * l[0] + ny * l[1] + nz * l[2];
    const m = nl > 0 ? 1 : 0;
    const gAz = nx * dlAz[0] + ny * dlAz[1] + nz * dlAz[2];
    const gEl = nx * dlEl[0] + ny * dlEl[1] + nz * dlEl[2];
    // dn/dc: w = (x, y, s/c), dw/dc = (0, 0, -s/c^2), n = w / L.
    const dwz = -s / (c * c);
    const wDotDw = wz * dwz;
    const dnz = dwz / L - wz * (wDotDw / (L2 * L));
    const dnx = -x * (wDotDw / (L2 * L));
    const dny = -y * (wDotDw / (L2 * L));
    const dnl = dnx * l[0] + dny * l[1] + dnz * l[2];
    out[j] = [rho * I * m * gAz, rho * I * m * gEl, rho * m * nl, rho, rho * I * m * dnl];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timing.
// ---------------------------------------------------------------------------
export function medianTimeMs(fn: () => void, reps: number): number {
  const ts: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(reps / 2)];
}
