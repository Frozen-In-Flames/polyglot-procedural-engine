// inverse/losses.ts - structural and statistical losses.
//
// Two losses for two jobs (documented contract):
//   L_struct (pixel L2) for smooth structure: where each pixel should be
//   matters, and the forward model can predict it.
//   L_tex (statistics matching, Heeger-Bergen spirit) for stochastic
//   texture (rock, noise, foliage): no pixel can be predicted, but the
//   power spectrum and the value histogram can.
//
// L_struct = 1/2 sum_j ||yhat_j - y_j||^2 over resolved pixels.
//
// L_tex = sum_f (log P_R(f) - log P_y(f))^2
//       + integral_0^1 (F_R^{-1}(q) - F_y^{-1}(q))^2 dq
// P is the radially averaged power spectrum |F{I}|^2 of the Hann-windowed
// image (epsilon inside the log keeps empty bins finite); the second term
// is the mean squared difference of the two sorted pixel lists, i.e. the
// 1-D Wasserstein-2 distance between the value histograms.

/** Structural loss: half the squared pixel error. */
export function structuralLoss(yhat: number[][], y: number[][]): number {
  let s = 0;
  for (let j = 0; j < y.length; j++) {
    for (let i = 0; i < y[j].length; i++) {
      const d = yhat[j][i] - y[j][i];
      s += d * d;
    }
  }
  return 0.5 * s;
}

/** Hann window value at index n of N. */
export function hann(n: number, N: number): number {
  return 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
}

/** Direct 2D DFT power spectrum |F|^2 of a small image (test-scale). */
export function dft2Power(img: number[][]): number[][] {
  const H = img.length;
  const W = img[0].length;
  const power: number[][] = [];
  for (let v = 0; v < H; v++) {
    const row: number[] = [];
    for (let u = 0; u < W; u++) {
      let re = 0, im = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const ang = -2 * Math.PI * ((u * x) / W + (v * y) / H);
          re += img[y][x] * Math.cos(ang);
          im += img[y][x] * Math.sin(ang);
        }
      }
      row.push(re * re + im * im);
    }
    power.push(row);
  }
  return power;
}

/**
 * Radially averaged power spectrum: bins |F|^2 by distance from DC into
 * nbins rings. The image is Hann-windowed (separable) first so spectral
 * leakage from the borders does not dominate the rings.
 */
export function radialPowerSpectrum(img: number[][], nbins: number): number[] {
  const H = img.length;
  const W = img[0].length;
  const win: number[][] = img.map((row, y) =>
    row.map((v, x) => v * hann(y, H) * hann(x, W)),
  );
  const power = dft2Power(win);
  const sums = new Array(nbins).fill(0);
  const counts = new Array(nbins).fill(0);
  const maxR = Math.hypot(W / 2, H / 2);
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      // Shifted frequency coordinates (DC at center).
      const fu = u <= W / 2 ? u : u - W;
      const fv = v <= H / 2 ? v : v - H;
      const r = Math.hypot(fu, fv) / maxR;
      const b = Math.min(nbins - 1, Math.floor(r * nbins));
      sums[b] += power[v][u];
      counts[b] += 1;
    }
  }
  return sums.map((s, b) => (counts[b] > 0 ? s / counts[b] : 0));
}

/** 1-D Wasserstein-2 squared: mean squared difference of sorted lists. */
export function wasserstein2Squared(a: number[], b: number[]): number {
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  const n = Math.min(sa.length, sb.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = sa[i] - sb[i];
    s += d * d;
  }
  return s / Math.max(1, n);
}

/** Texture loss: log power-spectrum ring mismatch + histogram W2. */
export function textureLoss(
  render: number[][],
  target: number[][],
  nbins = 8,
  logEps = 1e-12,
): number {
  const pr = radialPowerSpectrum(render, nbins);
  const py = radialPowerSpectrum(target, nbins);
  let spec = 0;
  for (let b = 0; b < nbins; b++) {
    const d = Math.log(pr[b] + logEps) - Math.log(py[b] + logEps);
    spec += d * d;
  }
  const hist = wasserstein2Squared(render.flat(), target.flat());
  return spec + hist;
}
