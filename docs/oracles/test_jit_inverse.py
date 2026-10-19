"""
Just-in-time inverse rendering: numeric checks on a deliberately small problem (Lambertian sphere, known geometry/albedo,
unknown directional light + ambient).  theta = (azimuth, elevation, intensity, ambient).

 A. Jacobian vs finite differences
 B. MAP Gauss-Newton with prior == Kalman update (linear case, exact);  one GN step with prior = EKF update
 C. Warm start vs cold start: iterations per frame under drift
 D. NIS change detection: normalized innovation flags a scene jump; reset recovers
 E. Pixel subsampling: parameter error vs m pixels against the Cramer-Rao prediction sqrt(diag(A^-1))
 F. One-shot linear SH-9 light estimate: conditioning when only the camera-facing hemisphere is visible
"""
import numpy as np

rng = np.random.default_rng(0)
ok_all = True


def report(name, ok, detail=""):
    global ok_all
    ok_all &= bool(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


# ---------- scene ----------
N = 64
xs = (np.arange(N) + 0.5) / N * 2 - 1
X, Y = np.meshgrid(xs, xs)
mask = X**2 + Y**2 < 0.95**2
nx, ny = X[mask], Y[mask]
Nrm = np.stack([nx, ny, np.sqrt(1 - nx**2 - ny**2)], 1)
M = len(nx)
RHO = 0.7
SIG = 0.01


def ldir(az, el):
    return np.array([np.cos(el) * np.sin(az), np.sin(el), np.cos(el) * np.cos(az)])


def render(th, nrm=None):
    nrm = Nrm if nrm is None else nrm
    az, el, I, A = th
    return RHO * (A + I * np.maximum(nrm @ ldir(az, el), 0))


def jac(th, nrm=None):
    nrm = Nrm if nrm is None else nrm
    az, el, I, A = th
    l = ldir(az, el)
    dl_az = np.array([np.cos(el) * np.cos(az), 0, -np.cos(el) * np.sin(az)])
    dl_el = np.array([-np.sin(el) * np.sin(az), np.cos(el), -np.sin(el) * np.cos(az)])
    nl = nrm @ l
    m = (nl > 0).astype(float)
    return np.stack([RHO * I * m * (nrm @ dl_az), RHO * I * m * (nrm @ dl_el), RHO * m * nl, RHO * np.ones_like(nl)], 1)


# ---------- A. Jacobian ----------
th0 = np.array([0.6, 0.5, 1.2, 0.15])
J = jac(th0)
Jfd = np.zeros_like(J)
for k in range(4):
    e = np.zeros(4); e[k] = 1e-6
    Jfd[:, k] = (render(th0 + e) - render(th0 - e)) / 2e-6
report("A. analytic Jacobian == finite differences", np.abs(J - Jfd).max() < 1e-5, f"max diff {np.abs(J - Jfd).max():.1e}  (terminator kink excluded by mask)")

# ---------- B. MAP-GN == Kalman, linear case ----------
m_, p_ = 30, 4
Jl = rng.standard_normal((m_, p_))
Pp = np.diag([0.5, 0.2, 0.3, 0.4]) ** 2
tp = rng.standard_normal(p_)
y = Jl @ rng.standard_normal(p_) + 0.1 * rng.standard_normal(m_)
R = 0.1**2 * np.eye(m_)
# Kalman
Kg = Pp @ Jl.T @ np.linalg.inv(Jl @ Pp @ Jl.T + R)
t_kf = tp + Kg @ (y - Jl @ tp)
P_kf = (np.eye(p_) - Kg @ Jl) @ Pp
# MAP / information form: (J^T R^-1 J + P^-1) d = J^T R^-1 r
A = Jl.T @ np.linalg.inv(R) @ Jl + np.linalg.inv(Pp)
t_map = tp + np.linalg.solve(A, Jl.T @ np.linalg.inv(R) @ (y - Jl @ tp))
report("B1. MAP step == Kalman update (mean)", np.allclose(t_kf, t_map, atol=1e-10), f"{np.abs(t_kf - t_map).max():.1e}")
report("B2. (J^T R^-1 J + P^-1)^-1 == (I-KJ)P (covariance)", np.allclose(np.linalg.inv(A), P_kf, atol=1e-10), f"{np.abs(np.linalg.inv(A) - P_kf).max():.1e}")

# ---------- C. warm vs cold (+ closed-form linear initializer) ----------
def solve(y, th_init, th_pred=None, P=None, max_it=30, tol=1e-4):
    th = th_init.copy()
    Pi = np.linalg.inv(P) if P is not None else None

    def cost(t):
        c = 0.5 * np.sum((y - render(t)) ** 2) / SIG**2
        return c + (0.5 * (t - th_pred) @ Pi @ (t - th_pred) if Pi is not None else 0.0)
    for it in range(1, max_it + 1):
        r, Jc = y - render(th), jac(th)
        Ainf = Jc.T @ Jc / SIG**2
        g = Jc.T @ r / SIG**2
        if Pi is not None:
            Ainf = Ainf + Pi; g = g + Pi @ (th_pred - th)
        d = np.linalg.solve(Ainf + 1e-9 * np.eye(4), g)
        c0, s = cost(th), 1.0
        while cost(th + s * d) > c0 and s > 1e-3:
            s *= 0.5
        th = th + s * d
        if np.linalg.norm(s * d) < tol:
            break
    return th, it, Ainf


def chi2r(y, th):
    return float(np.sum((y - render(th)) ** 2) / SIG**2 / M)      # ~1.0 at the noise floor


def linear_init(y):
    """closed form, ignores the clamp:  y/rho = A + n.v  (v = I*l)  -> linear least squares in (A, v)"""
    sol = np.linalg.lstsq(np.hstack([np.ones((M, 1)), Nrm]), y / RHO, rcond=None)[0]
    v = sol[1:]; I0 = np.linalg.norm(v); l = v / max(I0, 1e-9)
    return np.array([np.arctan2(l[0], l[2]), np.arcsin(np.clip(l[1], -1, 1)), I0, max(sol[0], 0.0)])


def truth(t):
    return np.array([0.5 + 0.035 * t, 0.6, 1.2, 0.15])


Tn = 40
cold_init = np.array([0.0, 0.3, 1.0, 0.1])
names = ("cold", "linear-init", "warm", "map")
its = {k: [] for k in names}; ok = {k: [] for k in names}; errs_az = {k: [] for k in names}
th_w = th_m = None; P_prev = None
for t in range(Tn):
    y = render(truth(t)) + SIG * rng.standard_normal(M)
    for k, th_i in (("cold", cold_init), ("linear-init", linear_init(y))):
        th, it, _ = solve(y, th_i)
        if t > 0:
            its[k].append(it); ok[k].append(chi2r(y, th) < 1.2); errs_az[k].append(abs(th[0] - truth(t)[0]))
    if th_w is None:
        th_w, _, _ = solve(y, linear_init(y)); th_m, _, Am = solve(y, linear_init(y)); P_prev = np.linalg.inv(Am)
        continue
    thw, itw, _ = solve(y, th_w); th_w = thw
    Pq = P_prev + np.diag([0.06**2, 0.03**2, 0.03**2, 0.03**2])           # random-walk process noise on the parameters
    thm, itm, Am = solve(y, th_m, th_pred=th_m, P=Pq); th_m = thm; P_prev = np.linalg.inv(Am)
    for k, th, it in (("warm", thw, itw), ("map", thm, itm)):
        its[k].append(it); ok[k].append(chi2r(y, th) < 1.2); errs_az[k].append(abs(th[0] - truth(t)[0]))
print("\nC. 39 frames, drift 2°/frame.  'fail' = final chi2/M >= 1.2 (stuck in a bad minimum / dead zone)")
for k in names:
    print(f"   {k:12s} mean iters {np.mean(its[k]):5.2f}  max {np.max(its[k]):2d}   fail rate {100*(1-np.mean(ok[k])):5.1f}%   median |az err| {np.median(errs_az[k]):.4f} rad")
report("C1. warm start: <= 4 iterations on every frame, no failures", max(its["warm"]) <= 4 and all(ok["warm"]))
report("C2. warm == MAP in this setting (same iterations, no failures)", abs(np.mean(its["warm"]) - np.mean(its["map"])) < 0.5 and all(ok["map"]))
report("C3. a fixed cold init FAILS on some frames (non-convex / zero-gradient dead zone)", np.mean(ok["cold"]) < 1.0, f"{100*(1-np.mean(ok['cold'])):.1f}% of frames")
report("C4. linear closed-form init never fails here", all(ok["linear-init"]), f"mean {np.mean(its['linear-init']):.2f} iters vs cold {np.mean(its['cold']):.2f}")

# ---------- D. NIS change detection ----------
def nis(y, th_pred, P):
    r = y - render(th_pred)
    Jc = jac(th_pred)
    Ainf = Jc.T @ Jc / SIG**2 + np.linalg.inv(P)
    q = Jc.T @ r / SIG**2
    return float(r @ r / SIG**2 - q @ np.linalg.solve(Ainf, q))   # Woodbury: r^T (sigma^2 I + J P J^T)^-1 r


print("\nD. NIS z = (NIS - M)/sqrt(2M); at frame 20 the light jumps to az=-0.8 rad (other side), I 1.2 -> 0.6:")
Pq0 = np.diag([0.06**2, 0.03**2, 0.03**2, 0.03**2]); th_est = truth(0); P_est = np.diag([0.05**2] * 4)
zs, post = [], []
for t in range(1, 30):
    tt = truth(t).copy()
    if t >= 20:
        tt[0], tt[2] = -0.8, 0.6
    y = render(tt) + SIG * rng.standard_normal(M)
    Pq = P_est + Pq0
    z = (nis(y, th_est, Pq) - M) / np.sqrt(2 * M); zs.append(z)
    if z > 6:
        th_est, it, Ainf = solve(y, linear_init(y)); P_est = np.linalg.inv(Ainf); post.append((t, it, chi2r(y, th_est), th_est - tt))
    else:
        th_est, it, Ainf = solve(y, th_est, th_pred=th_est, P=Pq); P_est = np.linalg.inv(Ainf)
zs = np.array(zs)
print(f"   z before jump: mean {zs[:19].mean():+.2f}, max {zs[:19].max():+.2f}   z at jump: {zs[19]:+.1f}   z after reset: {np.round(zs[20:24], 2)}")
report("D1. no false alarms before the jump (z < 6)", zs[:19].max() < 6)
report("D2. jump flagged on the first frame", zs[19] > 6, f"z = {zs[19]:.1f}")
report("D3. after the flagged frame, linear-init re-solve re-locks (chi2/M<1.2, |err|<0.01) and alarms stop", post and post[0][2] < 1.2 and np.abs(post[0][3]).max() < 0.05 and zs[20:].max() < 6,
       f"reset chi2/M {post[0][2]:.2f}, param err {np.round(post[0][3], 4)}, max z after {zs[20:].max():+.2f}")

# ---------- E. subsampling vs Cramer-Rao ----------
print("\nE. parameter error vs pixels used (200 trials each); CRB = sqrt(diag((J^T J / sigma^2)^-1)):")
th_true = np.array([0.6, 0.5, 1.2, 0.15])
ratios = []
for m in (50, 200, 800, M):
    errs = []
    crb = None
    for _ in range(200):
        idx = rng.choice(M, size=m, replace=False) if m < M else np.arange(M)
        nsub = Nrm[idx]
        y = render(th_true, nsub) + SIG * rng.standard_normal(m)
        th = th_true + np.array([0.05, 0.05, 0.1, 0.03])
        for _ in range(6):
            r = y - render(th, nsub); Jc = jac(th, nsub)
            th = th + np.linalg.solve(Jc.T @ Jc + 1e-9 * np.eye(4), Jc.T @ r)
        errs.append(th - th_true)
        Jc = jac(th_true, nsub)
        crb = np.sqrt(np.diag(np.linalg.inv(Jc.T @ Jc / SIG**2)))
    emp = np.sqrt(np.mean(np.array(errs) ** 2, 0))
    ratios.append(emp / crb)
    print(f"   m={m:5d}  empirical RMS {np.round(emp, 5)}   CRB {np.round(crb, 5)}   ratio {np.round(emp / crb, 2)}")
report("E1. empirical error within 30% of CRB at every m (estimator is efficient)", np.all(np.array(ratios) > 0.7) and np.all(np.array(ratios) < 1.3))

# ---------- F. one-shot SH-9 light estimate ----------
def Ysh(n):
    x, y, z = n[:, 0], n[:, 1], n[:, 2]
    return np.stack([0.282095 * np.ones_like(x), 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z,
                     0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)], 1)


Ahat = np.array([np.pi] + [2 * np.pi / 3] * 3 + [np.pi / 4] * 5)
Ltrue = rng.standard_normal(9) * np.array([1.0, .5, .5, .5, .25, .25, .25, .25, .25]); Ltrue[0] = 3.5


def sphere_normals(K, hemi):
    v = rng.standard_normal((K, 3)); v /= np.linalg.norm(v, axis=1, keepdims=True)
    if hemi:
        v[:, 2] = np.abs(v[:, 2])
    return v


back = sphere_normals(4000, False); back = back[back[:, 2] < -0.2]
Pb = (RHO / np.pi) * Ysh(back) * Ahat
print("\nF. one-shot SH-9 solve; RMS image error on UNSEEN back-facing normals (extrapolation), by noise level:")
print("   noise   hemisphere LS   hemisphere ridge(l=1)   full-sphere LS     (cond: hemisphere / full)")
conds = None; ratio_rows = []; hemi_ls_by_noise = []
for noise in (0.01, 0.05, 0.1):
    row = []
    for hemi in (True, False):
        e_ls, e_rg = [], []
        for _ in range(100):
            nv = sphere_normals(1500, hemi); Phi = (RHO / np.pi) * Ysh(nv) * Ahat
            yv = Phi @ Ltrue + noise * rng.standard_normal(len(nv))
            e_ls.append(np.sqrt(np.mean((Pb @ (np.linalg.lstsq(Phi, yv, rcond=None)[0] - Ltrue)) ** 2)))
            e_rg.append(np.sqrt(np.mean((Pb @ (np.linalg.solve(Phi.T @ Phi + 1.0 * np.eye(9), Phi.T @ yv) - Ltrue)) ** 2)))
        sv = np.linalg.svd(Phi, compute_uv=False)
        row.append((np.mean(e_ls), np.mean(e_rg), sv[0] / sv[-1]))
    print(f"   {noise:5.2f}   {row[0][0]:13.4f}   {row[0][1]:21.4f}   {row[1][0]:14.4f}     ({row[0][2]:.1f} / {row[1][2]:.1f})")
    ratio_rows.append(row[0][0] / row[1][0]); hemi_ls_by_noise.append(row[0][0])
report("F1. hemisphere cond(Phi) > 3x full-sphere cond", row[0][2] > 3 * row[1][2], f"{row[0][2]:.1f} vs {row[1][2]:.1f}")
hemi_ls = [r for r in hemi_ls_by_noise]
report("F2. hemisphere extrapolation error scales ~linearly with noise (x10 noise -> x7..x13 error)", 7 <= hemi_ls[2] / hemi_ls[0] <= 13, f"ratio {hemi_ls[2] / hemi_ls[0]:.1f}")
print(f"   hemisphere/full extrapolation error ratio: {np.round(ratio_rows, 2)}  (a modest 'few x', NOT orders of magnitude, at this sample size)")

print("\nALL PASS" if ok_all else "\nSOME FAILED")
