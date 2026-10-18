"""
Geometry-gradient reference tests.

 1. Implicit-function-theorem hit point:   dt*/dtheta = -(df/dtheta) / (grad f . d)
 2. Normal derivative:                     dn/dtheta = (1/|grad f|) (I - n n^T) (H d dt*/dtheta + d/dtheta grad f)
 3. Silhouette boundary term (disk coverage):
        d/dr   Area(disk ∩ pixel) = arc length of the circle inside the pixel
        d/dcx  Area(disk ∩ pixel) = ∮_inside (v . n) dl,   v = (1,0)

Derivatives for 1-2 come from sympy (exact), reference values from re-solving the
ray hit at theta +/- h (central differences).  Field is deliberately NOT a true SDF
(|grad f| != 1) so the 1/|grad f| normalization is exercised.
"""
import numpy as np
import sympy as sp
from scipy.optimize import brentq

# ---------- 1 & 2: parametric implicit surface ----------
x, y, z, a, b, c, k = sp.symbols("x y z a b c k", real=True)
P = sp.Matrix([x, y, z])
TH = [a, b, c, k]
# ellipsoid-like level set with a twist-free bulge term: non-unit gradient, smooth near the hit
f_expr = sp.sqrt((x / a) ** 2 + (y / b) ** 2 + (z / c) ** 2) - 1 + k * sp.sin(2 * x) * y
grad_expr = sp.Matrix([sp.diff(f_expr, v) for v in (x, y, z)])
H_expr = sp.hessian(f_expr, (x, y, z))
args = (x, y, z, a, b, c, k)
f_fn = sp.lambdify(args, f_expr, "numpy")
g_fn = sp.lambdify(args, grad_expr, "numpy")
H_fn = sp.lambdify(args, H_expr, "numpy")
ft_fn = [sp.lambdify(args, sp.diff(f_expr, th), "numpy") for th in TH]
gt_fn = [sp.lambdify(args, sp.Matrix([sp.diff(grad_expr[i], th) for i in range(3)]), "numpy") for th in TH]

o = np.array([0.35, 0.2, -3.0])
d = np.array([0.02, -0.03, 1.0])
d /= np.linalg.norm(d)
theta0 = np.array([1.3, 0.9, 1.1, 0.15])


def hit(theta):
    F = lambda t: f_fn(*(o + t * d), *theta)
    return brentq(F, 0.5, 3.0, xtol=1e-15, rtol=1e-15)


def normal(theta):
    p = o + hit(theta) * d
    g = np.array(g_fn(*p, *theta), float).ravel()
    return g / np.linalg.norm(g)


tstar = hit(theta0)
p = o + tstar * d
g = np.array(g_fn(*p, *theta0), float).ravel()
Hm = np.array(H_fn(*p, *theta0), float)
n = g / np.linalg.norm(g)

print("1/2. hit-point and normal derivatives (analytic vs central difference)")
print(f"   t* = {tstar:.6f},  |grad f| = {np.linalg.norm(g):.4f}  (not 1, so normalization matters)")
worst_t = worst_n = 0.0
for i, name in enumerate("a b c k".split()):
    ft = float(ft_fn[i](*p, *theta0))
    dt = -ft / float(g @ d)
    gt = np.array(gt_fn[i](*p, *theta0), float).ravel()
    dn = (np.eye(3) - np.outer(n, n)) @ (Hm @ d * dt + gt) / np.linalg.norm(g)
    h = 1e-5
    e = np.zeros(4)
    e[i] = h
    dt_fd = (hit(theta0 + e) - hit(theta0 - e)) / (2 * h)
    dn_fd = (normal(theta0 + e) - normal(theta0 - e)) / (2 * h)
    et = abs(dt - dt_fd) / max(abs(dt_fd), 1e-12)
    en = np.linalg.norm(dn - dn_fd) / max(np.linalg.norm(dn_fd), 1e-12)
    worst_t, worst_n = max(worst_t, et), max(worst_n, en)
    print(f"   d/d{name}:  dt* analytic {dt:+.6f} vs FD {dt_fd:+.6f} (rel {et:.1e})   dn rel err {en:.1e}")
print(f"   worst rel err: dt* {worst_t:.1e}, dn {worst_n:.1e}")

# FD step sweep: error should fall ~h^2 then rise from roundoff (confirms it's the FD, not the formula, that limits accuracy)
print("   dn/da FD step sweep (analytic fixed):")
i = 0
ft = float(ft_fn[i](*p, *theta0)); dt = -ft / float(g @ d)
gt = np.array(gt_fn[i](*p, *theta0), float).ravel()
dn = (np.eye(3) - np.outer(n, n)) @ (Hm @ d * dt + gt) / np.linalg.norm(g)
for h in [1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7]:
    e = np.zeros(4); e[i] = h
    dn_fd = (normal(theta0 + e) - normal(theta0 - e)) / (2 * h)
    print(f"     h={h:.0e}  err={np.linalg.norm(dn - dn_fd):.2e}")

# ---------- 3: silhouette boundary term, disk coverage in a unit pixel ----------
print("\n3. silhouette term: disk coverage derivative vs boundary integral")


def coverage(cx, cy, r, N=4_000_000):
    # integrate the clipped vertical chord over x in [0,1] (midpoint rule)
    xs = (np.arange(N) + 0.5) / N
    half = np.sqrt(np.maximum(r * r - (xs - cx) ** 2, 0.0))
    lo = np.clip(cy - half, 0, 1)
    hi = np.clip(cy + half, 0, 1)
    return float(np.sum(hi - lo) / N)


def arc_terms(cx, cy, r, M=4_000_000):
    # integrate over the circle: angle phi, point inside pixel?  accumulate arc length and v.n
    phi = (np.arange(M) + 0.5) * (2 * np.pi / M)
    px, py = cx + r * np.cos(phi), cy + r * np.sin(phi)
    inside = (px >= 0) & (px <= 1) & (py >= 0) & (py <= 1)
    dl = r * (2 * np.pi / M)
    return float(np.sum(inside) * dl), float(np.sum(np.cos(phi)[inside]) * dl)  # (arc length, v.n integral)


for (cx, cy, r) in [(0.4, 0.5, 0.35), (0.9, 0.2, 0.5), (1.1, 0.5, 0.45), (0.5, 0.5, 0.3)]:
    arc, vn = arc_terms(cx, cy, r)
    h = 1e-4
    dA_dr = (coverage(cx, cy, r + h) - coverage(cx, cy, r - h)) / (2 * h)
    dA_dcx = (coverage(cx + h, cy, r) - coverage(cx - h, cy, r)) / (2 * h)
    print(f"   disk(c=({cx},{cy}), r={r}):  dA/dr {dA_dr:.5f} vs arc {arc:.5f} | dA/dcx {dA_dcx:+.5f} vs contour v.n {vn:+.5f}")
