"""
Spherical-harmonic (9 coeff) irradiance oracle.

 1. Basis orthonormality (Gauss-Legendre x uniform phi: exact for these polynomials)
 2. A-hat_l derived from the clamped cosine:   A_l = 2π ∫_0^1 x P_l(x) dx      -> π, 2π/3, π/4, 0, -π/24
 3. White furnace:      L = 1 everywhere  ->  E(n) = π,  Lambert output ρE/π = ρ
 4. Band-limited L (l<=2): E_formula(n) == brute-force ∫ L(ω) max(n·ω,0) dω   (Funk-Hecke makes this exact)
 5. Shader-form constants c1..c5 == general formula
 6. Non-band-limited L (narrow sun lobe): how wrong is SH-9, and is irradiance ever negative?
"""
import numpy as np
from numpy.polynomial import legendre as npleg
from scipy.integrate import quad
from scipy.special import eval_legendre

rng = np.random.default_rng(5)
ok_all = True


def report(name, ok, detail=""):
    global ok_all
    ok_all &= bool(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


def Y(n):
    """real SH l<=2, order: 00 | 1-1 10 11 | 2-2 2-1 20 21 22   (x,y,z = n[...,0..2])"""
    x, y, z = n[..., 0], n[..., 1], n[..., 2]
    return np.stack([
        0.282095 * np.ones_like(x),
        0.488603 * y, 0.488603 * z, 0.488603 * x,
        1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y),
    ], -1)


# Gauss-Legendre in z=cosθ, uniform in φ
gx, gw = npleg.leggauss(48)
PHI = (np.arange(96) + 0.5) * (2 * np.pi / 96)
Z, PH = np.meshgrid(gx, PHI, indexing="ij")
W = (gw[:, None] * np.ones_like(PH)) * (2 * np.pi / 96)
S = np.sqrt(1 - Z**2)
DIRS = np.stack([S * np.cos(PH), S * np.sin(PH), Z], -1)  # (48,96,3)

# ---- 1. orthonormality
Yq = Y(DIRS)
G = np.einsum("ijk,ijl,ij->kl", Yq, Yq, W)
report("1. ∫Y_i Y_j dω = δ_ij  (9x9)", np.allclose(G, np.eye(9), atol=2e-6), f"max |G-I| = {np.abs(G - np.eye(9)).max():.1e}  (constants are 6-digit, so ~1e-6 is the floor)")

# ---- 2. A-hat derived
A = [2 * np.pi * quad(lambda x, l=l: x * eval_legendre(l, x), 0, 1)[0] for l in range(5)]
want = [np.pi, 2 * np.pi / 3, np.pi / 4, 0.0, -np.pi / 24]
report("2. derived A_l = (π, 2π/3, π/4, 0, -π/24)", np.allclose(A, want, atol=1e-12), "got " + ", ".join(f"{a:.6f}" for a in A))
print(f"      note A_4/A_0 = {A[4]/A[0]:.4f}: truncating at l=2 drops a term that is only 1/24 of the DC term")
Ahat = np.array([A[0]] + [A[1]] * 3 + [A[2]] * 5)


def E_sh(L, n):
    return (Y(n) * Ahat * L).sum(-1)


# ---- 3. white furnace
Lw = np.zeros(9)
Lw[0] = 4 * np.pi * 0.282095  # ∫ 1·Y00 dω
nn = rng.standard_normal((500, 3)); nn /= np.linalg.norm(nn, axis=1, keepdims=True)
E = E_sh(Lw, nn)
report("3. white furnace E(n) = π for 500 random n", np.allclose(E, np.pi, atol=2e-6), f"max |E-π| = {np.abs(E - np.pi).max():.1e}")
rho = 0.8
report("3b. Lambert output ρE/π = ρ", np.allclose(rho * E / np.pi, rho, atol=2e-6))
report("3c. forgetting /π gives ρπ (wrong by factor π)", abs(rho * E[0] - rho) > 1.0, f"ρE = {rho*E[0]:.4f}")

# ---- 4. band-limited L vs brute-force cosine integral
Lrand = rng.standard_normal(9)
NT, NP = 700, 1400
Tt = (np.arange(NT) + 0.5) * (np.pi / NT)
Pp = (np.arange(NP) + 0.5) * (2 * np.pi / NP)
TT, PP = np.meshgrid(Tt, Pp, indexing="ij")
Wd = np.sin(TT) * (np.pi / NT) * (2 * np.pi / NP)
Wdirs = np.stack([np.sin(TT) * np.cos(PP), np.sin(TT) * np.sin(PP), np.cos(TT)], -1)
Lw_dirs = (Y(Wdirs) * Lrand).sum(-1)
worst = 0.0
for _ in range(20):
    n = rng.standard_normal(3); n /= np.linalg.norm(n)
    brute = np.sum(Lw_dirs * np.maximum(Wdirs @ n, 0) * Wd)
    worst = max(worst, abs(brute - E_sh(Lrand, n)))
report("4. band-limited L: formula == brute force (20 random n)", worst < 5e-4, f"worst abs diff {worst:.1e}  (grid limit; cosine kink)")

# ---- 5. shader-form constants
c1, c2, c3, c4, c5 = 0.429043, 0.511664, 0.743125, 0.886227, 0.247708
L00, L1m1, L10, L11, L2m2, L2m1, L20, L21, L22 = Lrand


def E_shader(n):
    x, y, z = n
    return (c1 * L22 * (x * x - y * y) + c3 * L20 * z * z + c4 * L00 - c5 * L20
            + 2 * c1 * (L2m2 * x * y + L21 * x * z + L2m1 * y * z) + 2 * c2 * (L11 * x + L1m1 * y + L10 * z))


worst = 0.0
for _ in range(2000):
    n = rng.standard_normal(3); n /= np.linalg.norm(n)
    worst = max(worst, abs(E_shader(n) - E_sh(Lrand, n)))
report("5. shader-form (c1..c5) == general formula", worst < 1e-5, f"worst abs diff {worst:.1e}")
derived = dict(c1=A[2] * 0.546274, c2=A[1] * 0.488603 / 2, c3=3 * A[2] * 0.315392, c4=A[0] * 0.282095, c5=A[2] * 0.315392)
listed = dict(c1=c1, c2=c2, c3=c3, c4=c4, c5=c5)
for k_ in listed:
    report(f"5b. {k_} listed vs derived from A_l and Y constants", abs(derived[k_] - listed[k_]) < 2e-6, f"listed {listed[k_]:.6f} derived {derived[k_]:.6f}")

# ---- 6. non-band-limited L: unit-power sun lobe.  Findings recorded as checks, not assumed.
kappa = 60.0
sun = np.array([0.3, 0.2, 0.93]); sun /= np.linalg.norm(sun)
Lsun = np.exp(kappa * (Wdirs @ sun - 1)); Lsun /= np.sum(Lsun * Wd)           # unit total power
Lcoef = np.einsum("ijk,ij,ij->k", Y(Wdirs), Lsun, Wd)
nn = rng.standard_normal((4000, 3)); nn /= np.linalg.norm(nn, axis=1, keepdims=True)
brute = np.array([np.sum(Lsun * np.maximum(Wdirs @ n, 0) * Wd) for n in nn[:80]])
mask = brute > 0.05 * brute.max()
HANN = np.array([1, .75, .75, .75, .25, .25, .25, .25, .25])
stats = {}
for name, w in (("none", np.ones(9)), ("hann", HANN)):
    e = E_sh(Lcoef * w, nn)
    rel = np.abs(E_sh(Lcoef * w, nn[:80]) - brute)[mask] / brute[mask]
    stats[name] = (e.min(), e.max(), np.median(rel), rel.max())
    print(f"6. window={name:5s} Emin={e.min():+.4f} Emax={e.max():.4f} Emin/Emax={e.min()/e.max():+.4f}  rel err median {np.median(rel):.3f} max {rel.max():.3f}")
report("6a. SH-9 irradiance of a sharp lobe goes NEGATIVE (undershoot is real, < 5% of peak)",
       stats["none"][0] < 0 and abs(stats["none"][0]) < 0.05 * stats["none"][1], "policy: clamp E at 0")
report("6b. Hann window makes irradiance error WORSE (do not window irradiance)",
       stats["hann"][2] > stats["none"][2] and stats["hann"][0] <= stats["none"][0], f"median rel err {stats['none'][2]:.3f} -> {stats['hann'][2]:.3f}")
report("6c. SH-9 is a poor fit for a sharp light: max rel err in lit-ish regions > 20%", stats["none"][3] > 0.2, f"max {stats['none'][3]:.2f}  (use SH for soft sky, keep sun as an analytic light)")

print("\nALL PASS" if ok_all else "\nSOME FAILED")
