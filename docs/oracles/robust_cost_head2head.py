"""
Robust-cost head-to-head on the JIT toy problem (Lambertian sphere, unknown az, el, I, A).

Outlier sources the Lambertian model cannot explain:
  specular : Blinn-Phong lobe added on lit pixels, clipped at 1.0 (saturation)
  clutter  : a flat occluder rectangle with a random constant brightness
Estimators (all IRLS Gauss-Newton, backtracking on the robust cost, scale s = max(sigma, 1.4826 MAD(r)) re-estimated each iteration):
  l2        : w = 1
  huber     : w = min(1, 1.345/|u|),  u = r/s
  gm        : w = (c^2/(c^2+u^2))^2,  rho = (c^2/2) u^2/(c^2+u^2)          (redescending, non-convex)
  gm-gnc    : gm with c annealed from 50 down to c_final (graduated non-convexity)
  huber>gm  : converge Huber, then continue with gm
Starts: 'near' (small perturbation of truth) and 'far' (large perturbation).
Failure = |(az,el) error| > 0.15 rad, or |I error| > 0.3, or |A error| > 0.1.
"""
import sys
import numpy as np

rng = np.random.default_rng(42)
N = 64
xs = (np.arange(N) + 0.5) / N * 2 - 1
X, Y = np.meshgrid(xs, xs)
mask = X**2 + Y**2 < 0.95**2
nx, ny = X[mask], Y[mask]
Nrm = np.stack([nx, ny, np.sqrt(1 - nx**2 - ny**2)], 1)
M = len(nx)
RHO, SIG = 0.7, 0.01
VIEW = np.array([0.0, 0.0, 1.0])


def ldir(az, el):
    return np.array([np.cos(el) * np.sin(az), np.sin(el), np.cos(el) * np.cos(az)])


def render(th):
    az, el, I, A = th
    return RHO * (A + I * np.maximum(Nrm @ ldir(az, el), 0))


def jac(th):
    az, el, I, A = th
    l = ldir(az, el)
    dl_az = np.array([np.cos(el) * np.cos(az), 0, -np.cos(el) * np.sin(az)])
    dl_el = np.array([-np.sin(el) * np.sin(az), np.cos(el), -np.sin(el) * np.cos(az)])
    nl = Nrm @ l
    m = (nl > 0).astype(float)
    return np.stack([RHO * I * m * (Nrm @ dl_az), RHO * I * m * (Nrm @ dl_el), RHO * m * nl, RHO * np.ones_like(nl)], 1)


def make_image(th, specular, clutter):
    y = render(th) + SIG * rng.standard_normal(M)
    if specular > 0:
        l = ldir(th[0], th[1]); h = l + VIEW; h /= np.linalg.norm(h)
        y = y + specular * np.maximum(Nrm @ h, 0) ** 40 * (Nrm @ l > 0)
    frac = 0.0
    if clutter > 0:
        side = np.sqrt(clutter * np.pi * 0.95**2)                      # rectangle area ~ clutter * sphere area
        cx, cy = rng.uniform(-0.6, 0.6, 2)
        inside = (np.abs(nx - cx) < side / 2) & (np.abs(ny - cy) < side / 2)
        y = np.where(inside, rng.uniform(0, 1) + SIG * rng.standard_normal(M), y)
        frac = inside.mean()
    return np.clip(y, 0, 1.0), frac


def rho_cost(u, kind, c):
    if kind == "l2":
        return 0.5 * np.sum(u * u)
    if kind == "huber":
        k = 1.345
        a = np.abs(u)
        return np.sum(np.where(a <= k, 0.5 * u * u, k * a - 0.5 * k * k))
    return np.sum(0.5 * c * c * u * u / (c * c + u * u))                 # gm


def weights(u, kind, c):
    if kind == "l2":
        return np.ones_like(u)
    if kind == "huber":
        return np.minimum(1.0, 1.345 / np.maximum(np.abs(u), 1e-12))
    return (c * c / (c * c + u * u)) ** 2


def irls(y, th0, kind, c=3.0, max_it=40, tol=1e-5):
    th = th0.copy()
    n_it = 0
    for _ in range(max_it):
        r = y - render(th)
        s = max(SIG, 1.4826 * np.median(np.abs(r - np.median(r))))
        u = r / s
        w = weights(u, kind, c)
        Jc = jac(th)
        A = Jc.T @ (Jc * w[:, None])
        g = Jc.T @ (w * r)
        d = np.linalg.solve(A + 1e-9 * np.trace(A) * np.eye(4) + 1e-12 * np.eye(4), g)
        c0, st = rho_cost(u, kind, c), 1.0
        while rho_cost((y - render(th + st * d)) / s, kind, c) > c0 and st > 1e-3:
            st *= 0.5
        th = th + st * d
        th[2] = max(th[2], 0.05); th[3] = max(th[3], 0.0)
        n_it += 1
        if np.linalg.norm(st * d) < tol:
            break
    return th, n_it


def fit(y, th0, method, c_final=3.0):
    if method in ("l2", "huber"):
        return irls(y, th0, method)
    if method == "gm":
        return irls(y, th0, "gm", c=c_final)
    if method == "gm-gnc":
        th, tot, c = th0.copy(), 0, 50.0
        while True:
            th, n = irls(y, th, "gm", c=c, max_it=6)
            tot += n
            if c <= c_final:
                break
            c = max(c_final, c * 0.7)
        th, n = irls(y, th, "gm", c=c_final)
        return th, tot + n
    if method == "huber>gm":
        th, n1 = irls(y, th0, "huber")
        th, n2 = irls(y, th, "gm", c=c_final)
        return th, n1 + n2
    raise ValueError(method)


def failed(e):
    return np.hypot(e[0], e[1]) > 0.15 or abs(e[2]) > 0.3 or abs(e[3]) > 0.1


METHODS = ("l2", "huber", "gm", "gm-gnc", "huber>gm")
CONDS = {
    "clean (noise only)": dict(specular=0.0, clutter=0.0),
    "specular 0.6": dict(specular=0.6, clutter=0.0),
    "clutter 15%": dict(specular=0.0, clutter=0.15),
    "specular 1.0 + clutter 25%": dict(specular=1.0, clutter=0.25),
}
STARTS = {"near": np.array([0.05, 0.05, 0.1, 0.03]), "far": np.array([0.5, 0.3, 0.4, 0.1])}
TRIALS = int(sys.argv[1]) if len(sys.argv) > 1 else 150

results = {}
for cname, ckw in CONDS.items():
    for sname, spread in STARTS.items():
        per = {m: dict(err=[], fail=0, it=[]) for m in METHODS}
        for _ in range(TRIALS):
            th_true = np.array([rng.uniform(0.3, 1.2), rng.uniform(0.2, 0.8), rng.uniform(0.6, 1.1), rng.uniform(0.05, 0.2)])
            y, _frac = make_image(th_true, **ckw)
            th0 = th_true + spread * rng.standard_normal(4)
            th0[2] = max(th0[2], 0.2); th0[3] = max(th0[3], 0.0)
            for m in METHODS:
                th, n = fit(y, th0, m)
                e = th - th_true
                per[m]["err"].append(e); per[m]["fail"] += failed(e); per[m]["it"].append(n)
        results[(cname, sname)] = per

for (cname, sname), per in results.items():
    print(f"\n{cname:28s} start={sname}   ({TRIALS} trials)")
    print(f"   {'method':10s} {'fail%':>6s} {'med|az|':>9s} {'med|el|':>9s} {'med|I|':>8s} {'med|A|':>8s} {'iters':>6s}")
    for m in METHODS:
        E = np.abs(np.array(per[m]["err"]))
        print(f"   {m:10s} {100*per[m]['fail']/TRIALS:6.1f} {np.median(E[:,0]):9.4f} {np.median(E[:,1]):9.4f} {np.median(E[:,2]):8.4f} {np.median(E[:,3]):8.4f} {np.mean(per[m]['it']):6.1f}")

# efficiency under clean noise (near start): RMS error ratio against L2
per = results[("clean (noise only)", "near")]
rms = {m: np.sqrt(np.mean(np.array(per[m]["err"]) ** 2, 0)) for m in METHODS}
print("\nstatistical efficiency, clean noise, near start: RMS error ratio vs L2 (1.00 = as good as L2) per (az, el, I, A):")
for m in METHODS:
    print(f"   {m:10s} {np.round(rms[m] / rms['l2'], 2)}")

# GM scale sensitivity, direct GM, far start, hardest condition
print("\nGM scale sensitivity (direct GM, specular 1.0 + clutter 25%, far start): c_final in units of the scale s")
hard = CONDS["specular 1.0 + clutter 25%"]
for c in (1.5, 3.0, 6.0, 12.0):
    errs, fails = [], 0
    for _ in range(TRIALS):
        th_true = np.array([rng.uniform(0.3, 1.2), rng.uniform(0.2, 0.8), rng.uniform(0.6, 1.1), rng.uniform(0.05, 0.2)])
        y, _ = make_image(th_true, **hard)
        th0 = th_true + STARTS["far"] * rng.standard_normal(4); th0[2] = max(th0[2], 0.2); th0[3] = max(th0[3], 0.0)
        th, _ = fit(y, th0, "gm", c_final=c)
        e = th - th_true; errs.append(e); fails += failed(e)
    E = np.abs(np.array(errs))
    print(f"   c={c:5.1f}  fail {100*fails/TRIALS:5.1f}%   median |az| {np.median(E[:,0]):.4f}   median |I| {np.median(E[:,2]):.4f}")
