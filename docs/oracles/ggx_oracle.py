"""
GGX / Cook-Torrance oracle.  Identities, not trust:

 1. D normalization:           ∫ D(h)(n·h) dω = 1                         (closed form = 1 as well)
 2. Smith masking identity:    G1(v) ∫ D(h) max(v·h,0) dω = n·v
 3. Reciprocity:               f_r(l,v) = f_r(v,l)
 4. Visibility simplification: G1(l)G1(v)/(4 nl nv) = 1/((nl+s_l)(nv+s_v)),  s_x = sqrt(a²+(1-a²)nx²)
                               -> finite at grazing, no division by nl or nv, no clamp needed
 5. Importance sampler:        cosθh = sqrt((1-ξ)/(1+(a²-1)ξ)) reproduces the D(n·h) pdf
 6. Directional albedo (F=1):  MC with pdf p_l = D(n·h)/(4 v·h)  ==  brute-force quadrature,  and  <= 1
"""
import numpy as np
from scipy.integrate import quad

rng = np.random.default_rng(11)
ok_all = True


def report(name, ok, detail=""):
    global ok_all
    ok_all &= bool(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


D = lambda c, a: a * a / (np.pi * (c * c * (a * a - 1) + 1) ** 2)
s_of = lambda x, a: np.sqrt(a * a + (1 - a * a) * x * x)
G1 = lambda x, a: 2 * x / (x + s_of(x, a))

# ---- 1. normalization
for a in [0.02, 0.05, 0.1, 0.3, 0.5, 0.8, 1.0]:
    val, err = quad(lambda x: 2 * np.pi * D(x, a) * x, 0, 1, points=[1 - a**2, 1 - a**4] if a < 0.9 else None, limit=800)
    report(f"1. ∫D(n·h)dω = 1   alpha={a:<5}", abs(val - 1) < 1e-8, f"got {val:.12f}")

# ---- 2. Smith masking identity (v in x-z plane)
th = (np.arange(4000) + 0.5) / 4000 * (np.pi / 2)
ph = (np.arange(2000) + 0.5) / 2000 * 2 * np.pi
TH, PH = np.meshgrid(th, ph, indexing="ij")
for a in [0.2, 0.5, 1.0]:
    for tv_deg in [0, 30, 60, 80]:
        tv = np.radians(tv_deg)
        vh = np.sin(tv) * np.sin(TH) * np.cos(PH) + np.cos(tv) * np.cos(TH)
        I = np.sum(D(np.cos(TH), a) * np.maximum(vh, 0) * np.sin(TH)) * (np.pi / 2 / 4000) * (2 * np.pi / 2000)
        lhs = G1(np.cos(tv), a) * I
        report(f"2. G1(v)∫D max(v·h,0) = n·v  a={a} θv={tv_deg:2d}°", abs(lhs - np.cos(tv)) < 2e-4, f"lhs {lhs:.6f} rhs {np.cos(tv):.6f}")

# ---- 3. reciprocity, 4. visibility form
def unit(v):
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def spec(l, v, a, F0=0.04):
    n = np.array([0.0, 0.0, 1.0])
    h = unit(l + v)
    nl, nv, nh, vh = l @ n, v @ n, h @ n, np.sum(v * h, -1)
    F = F0 + (1 - F0) * (1 - vh) ** 5
    return D(nh, a) * F * G1(nl, a) * G1(nv, a) / (4 * nl * nv)


worst = 0.0
for _ in range(20000):
    l = unit(rng.standard_normal(3)); l[2] = abs(l[2]) + 0.01; l = unit(l)
    v = unit(rng.standard_normal(3)); v[2] = abs(v[2]) + 0.01; v = unit(v)
    a = rng.uniform(0.05, 1)
    x, y = spec(l, v, a), spec(v, l, a)
    worst = max(worst, abs(x - y) / max(abs(x), 1e-30))
report("3. reciprocity f_r(l,v)=f_r(v,l), 20k random", worst < 1e-12, f"worst rel diff {worst:.1e}")

worst = 0.0
for _ in range(100000):
    nl, nv, a = rng.uniform(1e-4, 1), rng.uniform(1e-4, 1), rng.uniform(0.02, 1)
    lhs = G1(nl, a) * G1(nv, a) / (4 * nl * nv)
    rhs = 1 / ((nl + s_of(nl, a)) * (nv + s_of(nv, a)))
    worst = max(worst, abs(lhs - rhs) / rhs)
report("4. V = G/(4 nl nv) == 1/((nl+s_l)(nv+s_v))", worst < 1e-9, f"worst rel diff {worst:.1e}")
a = 0.3
vis0 = 1 / ((0.0 + s_of(0.0, a)) * (0.5 + s_of(0.5, a)))
report("4b. visibility finite at nl = 0 exactly", np.isfinite(vis0), f"V = {vis0:.4f}  (the G/(4 nl nv) form is 0/0 there)")

# ---- 5. sampler distribution: compare sampled E[(n·h)^k] to quadrature under pdf D(n·h)
for a in [0.1, 0.4, 0.9]:
    xi = rng.random(2_000_000)
    ch = np.sqrt((1 - xi) / (1 + (a * a - 1) * xi))
    for k in (1, 2, 5):
        exact = quad(lambda x: 2 * np.pi * D(x, a) * x * x**k, 0, 1, points=[1 - a**2, 1 - a**4] if a < 0.9 else None, limit=800)[0]
        report(f"5. sampler moment E[(n·h)^{k}] a={a}", abs(ch.__pow__(k).mean() - exact) < 2e-3, f"MC {np.mean(ch**k):.5f} vs exact {exact:.5f}")

# ---- 6. directional albedo, F=1
def albedo_mc(cv, a, N=2_000_000):
    sv = np.sqrt(1 - cv * cv)
    v = np.array([sv, 0, cv])
    xi1, xi2 = rng.random(N), rng.random(N)
    ch = np.sqrt((1 - xi2) / (1 + (a * a - 1) * xi2)); sh = np.sqrt(1 - ch * ch); phi = 2 * np.pi * xi1
    h = np.stack([sh * np.cos(phi), sh * np.sin(phi), ch], -1)
    vh = h @ v
    l = 2 * vh[:, None] * h - v
    nl = l[:, 2]
    w = np.where((nl > 0) & (vh > 0), G1(nl, a) * G1(cv, a) * vh / (cv * ch), 0.0)  # f_r*nl/p_l with F=1
    return w.mean(), w.std() / np.sqrt(N)


def albedo_quad(cv, a, N=2500):
    sv = np.sqrt(1 - cv * cv); v = np.array([sv, 0, cv])
    t = (np.arange(N) + 0.5) / N * (np.pi / 2); p = (np.arange(N) + 0.5) / N * 2 * np.pi
    T, P = np.meshgrid(t, p, indexing="ij")
    l = np.stack([np.sin(T) * np.cos(P), np.sin(T) * np.sin(P), np.cos(T)], -1)
    h = unit(l + v); nh = h[..., 2]
    nl = l[..., 2]
    f = D(nh, a) / ((nl + s_of(nl, a)) * (cv + s_of(cv, a)))      # specular f_r, F=1, via the V form
    return np.sum(f * nl * np.sin(T)) * (np.pi / 2 / N) * (2 * np.pi / N)


print("\n   albedo table (F=1, single-scatter GGX): rows = alpha, cols = cos(θv)")
for a in [0.3, 0.5, 0.8, 1.0]:
    row = []
    for cv in [1.0, 0.7, 0.3]:
        m, se = albedo_mc(cv, a)
        q = albedo_quad(cv, a)
        row.append(f"{m:.4f}")
        report(f"6. albedo MC==quad  a={a} cosθv={cv}", abs(m - q) < max(5 * se, 2e-3) and m <= 1 + 5 * se, f"MC {m:.4f}±{se:.4f} quad {q:.4f}")
    print(f"      a={a}: " + "  ".join(row))

print("\nALL PASS" if ok_all else "\nSOME FAILED")
