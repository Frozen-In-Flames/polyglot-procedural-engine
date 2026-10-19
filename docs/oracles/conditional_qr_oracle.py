"""
Conditional-QR oracle.

 1. Algorithm error vs kappa(J), float32 and float64.  Reference = float64 lstsq on the SAME rounded inputs, so the number
    isolates the algorithm: normal equations (Cholesky of J^T J) ~ eps*kappa^2, QR ~ eps*kappa.
 2. Trigger rule:  fire QR iff  eps * kappa(J^T J) > tau   (tau = 1e-3), kappa from the p x p information matrix (cheap).
 3. Does the branch fire on the actual problems?  4-param light fit; SH-9 hemisphere; SH-9 narrow caps.
 4. Statistical vs arithmetic error with realistic noise: QR only helps where arithmetic error rivals statistical error.
 5. Ridge: bounds conditioning, but a zero-centered prior biases; a centered prior does not.
 6. Cost: NE vs QR timing (numpy CPU; informational only).
"""
import time
import numpy as np
from scipy.linalg import cho_factor, cho_solve, solve_triangular, LinAlgError

rng = np.random.default_rng(1)
EPS = {np.float32: np.finfo(np.float32).eps, np.float64: np.finfo(np.float64).eps}
TAU = 1e-3
ok_all = True


def report(name, ok, detail=""):
    global ok_all
    ok_all &= bool(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


def solve_ne(J, y):
    try:
        A = J.T @ J
        c = cho_factor(A)
        x = cho_solve(c, J.T @ y)
        return x if np.all(np.isfinite(x)) else None
    except (LinAlgError, ValueError):
        return None


def solve_qr(J, y):
    Q, R = np.linalg.qr(J)
    return solve_triangular(R, Q.T @ y)


def ref(J, y):
    return np.linalg.lstsq(J.astype(np.float64), y.astype(np.float64), rcond=None)[0]


def relerr(x, xr):
    return np.nan if x is None else float(np.linalg.norm(x.astype(np.float64) - xr) / np.linalg.norm(xr))


def make_J(m, p, kappa):
    U, _ = np.linalg.qr(rng.standard_normal((m, p)))
    V, _ = np.linalg.qr(rng.standard_normal((p, p)))
    s = np.logspace(0, -np.log10(kappa), p)
    return U @ np.diag(s) @ V.T


# ---------- 1 + 2 ----------
print("1. algorithm error vs kappa(J): m=2000, p=9, noise-free, error measured against float64 solution of the same rounded data")
print("   kappa     |  float32: NE err    QR err   trigger |  float64: NE err    QR err   trigger")
rows = []
for kappa in (1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9):
    J64 = make_J(2000, 9, kappa)
    x_true = rng.standard_normal(9)
    cells = []
    for dt in (np.float32, np.float64):
        J = J64.astype(dt); y = (J64 @ x_true).astype(dt)
        xr = ref(J, y)
        e_ne, e_qr = relerr(solve_ne(J, y), xr), relerr(solve_qr(J, y), xr)
        kJTJ = np.linalg.cond((J.T @ J).astype(np.float64))
        fire = EPS[dt] * kJTJ > TAU
        cells.append((e_ne, e_qr, fire))
        rows.append((kappa, dt, e_ne, e_qr, fire))
    f = lambda c: f"{c[0]:10.2e} {c[1]:9.2e}   {'FIRE' if c[2] else '  - '}"
    print(f"   {kappa:7.0e}  |  {f(cells[0])}   |  {f(cells[1])}")
for dt in (np.float32, np.float64):
    sub = [(k, ne, qr, fi) for k, d, ne, qr, fi in rows if d is dt]
    missed = [k for k, ne, qr, fi in sub if (np.isnan(ne) or ne > 1e-2) and not fi]
    wasted = [k for k, ne, qr, fi in sub if fi and ne < 1e-5]
    nm = 'float32' if dt is np.float32 else 'float64'
    report(f"2a. {nm}: trigger never misses a case where NE error > 1e-2 (or Cholesky fails)", not missed, f"misses at kappa={missed}" if missed else "")
    report(f"2b. {nm}: trigger never fires where NE error is already < 1e-5", not wasted, f"wasted at kappa={wasted}" if wasted else "")
qr_better = all(np.isnan(ne) or qr <= ne * 1.0001 + 1e-15 for k, d, ne, qr, fi in rows)
report("2c. QR error <= NE error at every kappa tested (both precisions)", qr_better)

# ---------- 3. real problems ----------
N = 64
xs = (np.arange(N) + 0.5) / N * 2 - 1
X, Y = np.meshgrid(xs, xs)
mk = X**2 + Y**2 < 0.95**2
Nrm = np.stack([X[mk], Y[mk], np.sqrt(1 - X[mk]**2 - Y[mk]**2)], 1)
RHO = 0.7


def ldir(az, el):
    return np.array([np.cos(el) * np.sin(az), np.sin(el), np.cos(el) * np.cos(az)])


def jac_light(th):
    az, el, I, A = th
    l = ldir(az, el)
    dl_az = np.array([np.cos(el) * np.cos(az), 0, -np.cos(el) * np.sin(az)])
    dl_el = np.array([-np.sin(el) * np.sin(az), np.cos(el), -np.sin(el) * np.cos(az)])
    nl = Nrm @ l; m = (nl > 0).astype(float)
    return np.stack([RHO * I * m * (Nrm @ dl_az), RHO * I * m * (Nrm @ dl_el), RHO * m * nl, RHO * np.ones_like(nl)], 1)


def Ysh(n):
    x, y, z = n[:, 0], n[:, 1], n[:, 2]
    return np.stack([0.282095 * np.ones_like(x), 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z,
                     0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)], 1)


Ahat = np.array([np.pi] + [2 * np.pi / 3] * 3 + [np.pi / 4] * 5)


def cap_normals(K, half_angle_deg):
    th = np.radians(half_angle_deg) * np.sqrt(rng.random(K))              # uniform on the cap
    ph = 2 * np.pi * rng.random(K)
    return np.stack([np.sin(th) * np.cos(ph), np.sin(th) * np.sin(ph), np.cos(th)], 1)


def hemi_normals(K):
    v = rng.standard_normal((K, 3)); v /= np.linalg.norm(v, axis=1, keepdims=True); v[:, 2] = np.abs(v[:, 2]); return v


def Phi_of(n):
    return (RHO / np.pi) * Ysh(n) * Ahat


problems = {
    "light fit (4 params), clean": jac_light(np.array([0.6, 0.5, 1.0, 0.15])),
    "SH-9, hemisphere normals": Phi_of(hemi_normals(2000)),
    "SH-9, cap 30°": Phi_of(cap_normals(2000, 30)),
    "SH-9, cap 15°": Phi_of(cap_normals(2000, 15)),
    "SH-9, cap 5°": Phi_of(cap_normals(2000, 5)),
}
print("\n3. does the trigger fire on real problems?  (eps*kappa(J^TJ) vs tau = 1e-3)")
print(f"   {'problem':30s} {'kappa(J)':>10s} {'f32 eps*k(JtJ)':>15s} {'f32':>5s} {'f64 eps*k(JtJ)':>15s} {'f64':>5s}")
fired = {}
for name, J in problems.items():
    k = np.linalg.cond(J)
    v32, v64 = EPS[np.float32] * k**2, EPS[np.float64] * k**2
    fired[name] = (v32 > TAU, v64 > TAU)
    print(f"   {name:30s} {k:10.1f} {v32:15.2e} {'FIRE' if v32 > TAU else '-':>5s} {v64:15.2e} {'FIRE' if v64 > TAU else '-':>5s}")
report("3a. branch stays silent on the 4-param light fit (float32 and float64)", not any(fired["light fit (4 params), clean"]))
report("3b. branch stays silent on SH-9 hemisphere (float32 and float64)", not any(fired["SH-9, hemisphere normals"]))
report("3c. branch fires on at least one narrow-cap SH problem in float32 (so it is not dead code)", any(fired[k][0] for k in fired if "cap" in k))
report("3d. branch never fires in float64 on any of these problems", not any(v[1] for v in fired.values()))

# ---------- 4. statistical vs arithmetic ----------
print("\n4. realistic noise (0.01): statistical error ||x64 - x_true|| vs arithmetic error ||x32 - x64||  (relative to ||x_true||)")
print(f"   {'problem':22s} {'stat err':>10s} {'NE32 arith':>11s} {'QR32 arith':>11s}   QR payoff?")
x_true = rng.standard_normal(9)
for name in ("SH-9, hemisphere normals", "SH-9, cap 30°", "SH-9, cap 15°", "SH-9, cap 5°"):
    J64 = problems[name]
    stat, ne_a, qr_a = [], [], []
    for _ in range(40):
        y64 = J64 @ x_true + 0.01 * rng.standard_normal(len(J64))
        x64 = np.linalg.lstsq(J64, y64, rcond=None)[0]
        J32, y32 = J64.astype(np.float32), y64.astype(np.float32)
        xne, xqr = solve_ne(J32, y32), solve_qr(J32, y32)
        stat.append(np.linalg.norm(x64 - x_true) / np.linalg.norm(x_true))
        ne_a.append(np.nan if xne is None else np.linalg.norm(xne - x64) / np.linalg.norm(x_true))
        qr_a.append(np.linalg.norm(xqr - x64) / np.linalg.norm(x_true))
    s, n, q = np.median(stat), np.nanmedian(ne_a) if not np.all(np.isnan(ne_a)) else np.nan, np.median(qr_a)
    payoff = "yes: NE arithmetic error is NOT negligible vs statistical" if (np.isnan(n) or n > 0.1 * s) else "no: arithmetic error << statistical error"
    print(f"   {name:22s} {s:10.3e} {n:11.3e} {q:11.3e}   {payoff}")

# ---------- 5. ridge ----------
print("\n5. cap 15°, noise 0.01, float64: plain LS vs ridge toward ZERO vs ridge toward a CENTERED prior (true + 30% error)")
J = problems["SH-9, cap 15°"]
prior_c = x_true * (1 + 0.3 * rng.standard_normal(9))
res = {"plain": [], "zero": [], "centered": []}
lam = 1e-4 * np.linalg.norm(J, 2) ** 2
for _ in range(100):
    y = J @ x_true + 0.01 * rng.standard_normal(len(J))
    res["plain"].append(np.linalg.lstsq(J, y, rcond=None)[0])
    res["zero"].append(np.linalg.solve(J.T @ J + lam * np.eye(9), J.T @ y))
    res["centered"].append(prior_c + np.linalg.solve(J.T @ J + lam * np.eye(9), J.T @ (y - J @ prior_c)))
for k, v in res.items():
    e = np.linalg.norm(np.array(v) - x_true, axis=1) / np.linalg.norm(x_true)
    print(f"   {k:9s} median relative error {np.median(e):8.4f}   (cond of system {np.linalg.cond(J) if k=='plain' else np.sqrt(np.linalg.cond(J.T @ J + lam*np.eye(9))):.1f})")

# ---------- 6. timing ----------
print("\n6. timing, m=3000 (numpy, CPU, informational only; a GPU/WebGL path will differ):")
for p in (4, 9, 16):
    for dt in (np.float64, np.float32):
        J = rng.standard_normal((3000, p)).astype(dt); y = rng.standard_normal(3000).astype(dt)
        t0 = time.perf_counter()
        for _ in range(50): solve_ne(J, y)
        t_ne = (time.perf_counter() - t0) / 50
        t0 = time.perf_counter()
        for _ in range(50): solve_qr(J, y)
        t_qr = (time.perf_counter() - t0) / 50
        print(f"   p={p:2d} {dt.__name__:8s} NE {t_ne*1e6:7.0f} µs   QR {t_qr*1e6:7.0f} µs   QR/NE = {t_qr/t_ne:4.1f}x")

print("\nALL PASS" if ok_all else "\nSOME FAILED")
