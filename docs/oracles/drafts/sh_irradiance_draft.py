"""
DRAFT - UNVALIDATED. Cross-check oracle for spherical-harmonic irradiance.
Identities, not trust. For comparison against the owner's validated oracle;
NOT normative spec.

Convention: orthonormal real SH (Sloan "Stupid SH Tricks" Cartesian forms).
Irradiance:  E(n) = sum_{l<=2} Ahat_l L_{lm} Y_{lm}(n),
  Ahat = (pi, 2pi/3, pi/4).  Lambertian output = rho * E / pi.

NOTE on the white-environment coefficient: with orthonormal SH, a unit white
environment (L=1 everywhere) has L_00 = 2*sqrt(pi) (NOT sqrt(pi)/2), since
L_00 = int Y_00 dω = 4*pi/(2*sqrt(pi)). Then E = pi * 2*sqrt(pi) * 1/(2*sqrt(pi)) = pi.
The sqrt(pi)/2 figure in the task note belongs to a different basis normalization.
"""
import numpy as np

rng = np.random.default_rng(21)
ok_all = True


def report(name, ok, detail=""):
    global ok_all
    ok_all &= bool(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


AHAT = {0: np.pi, 1: 2.0 * np.pi / 3.0, 2: np.pi / 4.0}


def make_basis(sign_flip_11=False):
    """9 real SH basis functions through l=2, Cartesian forms. sign_flip_11
    negates Y_11 for the deliberate sign-error variant."""
    s = -1.0 if sign_flip_11 else 1.0
    c0 = 0.28209479177387814    # 1/(2 sqrt(pi))
    c1 = 0.4886025119029199    # sqrt(3/(4 pi))
    c2a = 1.0925484305920792   # sqrt(15/(4 pi)) * ... (xy, yz, xz terms)
    c2b = 0.31539156525252005  # (1/4) sqrt(5/pi)
    c2c = 0.5462742152960396   # (1/2) sqrt(15/(4 pi))
    return [
        (0, lambda x, y, z: np.full_like(x, c0)),
        (1, lambda x, y, z: c1 * y),
        (1, lambda x, y, z: c1 * z),
        (1, lambda x, y, z: s * c1 * x),
        (2, lambda x, y, z: c2a * x * y),
        (2, lambda x, y, z: c2a * y * z),
        (2, lambda x, y, z: c2b * (3 * z * z - 1)),
        (2, lambda x, y, z: c2a * x * z),
        (2, lambda x, y, z: c2c * (x * x - y * y)),
    ]


def fibonacci_sphere(n):
    i = np.arange(n)
    y = 1.0 - 2.0 * (i + 0.5) / n
    r = np.sqrt(np.maximum(1 - y * y, 0))
    phi = i * 2.399963229728653
    return np.stack([r * np.cos(phi), y, r * np.sin(phi)], axis=1)


def irradiance(basis, L, n):
    x, y, z = n[..., 0], n[..., 1], n[..., 2]
    E = np.zeros(n.shape[:-1])
    for (l, Y), c in zip(basis, L):
        E = E + AHAT[l] * c * Y(x, y, z)
    return E


def run_checks(basis_proj, basis_eval, label):
    """basis_proj: used to compute coefficients (the foundry side).
    basis_eval: used to evaluate E(n) (the shader/runtime side).
    A self-consistent sign flip is just a convention; the realistic bug is a
    MISMATCH between the two sides, which is what the mutated run tests."""
    print(f"--- {label} ---")
    # (e) basis orthonormality via quadrature (property of one basis)
    pts = fibonacci_sphere(20000)
    x, y, z = pts[:, 0], pts[:, 1], pts[:, 2]
    vals = np.stack([Y(x, y, z) for _, Y in basis_eval], axis=1)
    G = vals.T @ vals * (4 * np.pi / len(pts))
    err = np.max(np.abs(G - np.eye(9)))
    report("e. orthonormality  int Yi Yj = delta_ij", err < 2e-3, f"max err {err:.2e}")

    # (a) constant white environment: L_00 = 2 sqrt(pi), rest 0 -> E = pi for all n
    L = np.zeros(9)
    L[0] = 2 * np.sqrt(np.pi)
    dirs = fibonacci_sphere(500)
    E = irradiance(basis_eval, L, dirs)
    err = np.max(np.abs(E - np.pi))
    report("a. white env -> E = pi everywhere", err < 1e-9, f"max err {err:.2e}")

    # (b) band-limited reconstruction: project with basis_proj, rebuild with basis_eval
    d1 = np.array([1.0, 2.0, 3.0]); d1 /= np.linalg.norm(d1)
    d2 = np.array([-1.0, 0.5, 2.0]); d2 /= np.linalg.norm(d2)
    f = lambda p: 1.0 + 0.5 * (p @ d1) + 0.4 * (3 * (p @ d2) ** 2 - 1) / 2
    qp = fibonacci_sphere(20000)
    fq = f(qp)
    Lr = np.array([np.sum(fq * Y(qp[:, 0], qp[:, 1], qp[:, 2])) * (4 * np.pi / len(qp)) for _, Y in basis_proj])
    tp = fibonacci_sphere(500)
    fr = np.stack([Y(tp[:, 0], tp[:, 1], tp[:, 2]) for _, Y in basis_eval], axis=1) @ Lr
    err = np.max(np.abs(fr - f(tp)))
    report("b. band-limited f reconstructs from 9 coeffs", err < 5e-3, f"max err {err:.2e}")

    # (c) directional light: L_lm = I Y_lm(d) via basis_proj; E via basis_eval
    I0 = 2.0
    d = np.array([1.0, 1.0, 1.0]); d /= np.linalg.norm(d)
    Ld = np.array([I0 * Y(d[0], d[1], d[2]) for _, Y in basis_proj])
    Ed = irradiance(basis_eval, Ld, d[None, :])[0]
    Em = irradiance(basis_eval, Ld, (-d)[None, :])[0]
    perp = np.array([1.0, -1.0, 0.0]); perp /= np.linalg.norm(perp)
    Ep = irradiance(basis_eval, Ld, perp[None, :])[0]
    report("c1. E(d) = 17/16 I  (addition theorem)", abs(Ed - 17.0 / 16.0 * I0) < 1e-9,
           f"E(d)={Ed:.9f} expected {17.0/16.0*I0:.9f}")
    report("c2. E(d) > E(perp) > E(-d)", (Ed > Ep) and (Ep > Em),
           f"E(d)={Ed:.4f} E(perp)={Ep:.4f} E(-d)={Em:.4f}")


print("== true basis both sides ==")
run_checks(make_basis(), make_basis(), "true / true")
true_ok = ok_all

ok_all = True
print("\n== foundry true, shader Y_11 negated (interface mismatch) ==")
run_checks(make_basis(), make_basis(sign_flip_11=True), "true / flipped")
mismatch_ok = ok_all

print()
report("d. sign-error variant: foundry/shader mismatch makes >=1 check FAIL", not mismatch_ok,
       "oracle would be worthless if it passed" if mismatch_ok else "mutation caught")
report("true basis: all checks pass", true_ok, "")

print("\nALL PASS" if (true_ok and not mismatch_ok) else "\nSOME FAILED")
