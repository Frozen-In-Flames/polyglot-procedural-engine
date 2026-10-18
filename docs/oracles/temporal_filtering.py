"""
Temporal-filtering reference tests (replaces "check visually for ghosting" with numbers).

 1. EMA variance:  Var(out)/sigma^2 = alpha/(2-alpha)   on a static noisy signal
 2. Ghosting:      bright object moving with NO motion vector for it; history reprojected as static.
                   metric = mean |output - truth| over pixels the object has already left.
                   compare: no clamp / min-max clamp / variance clip (gamma sweep)
 3. Cost of the clamp: residual noise on a static noisy region (what you give up by clamping)
 4. Halton radical inverse start values
 5. Critically damped spring: two steps of dt == one step of 2dt
"""
import numpy as np

rng = np.random.default_rng(3)
ALPHA = 0.1

# ---- 1. EMA variance ----
print("1. EMA variance ratio alpha/(2-alpha)")
for a in (0.05, 0.1, 0.3):
    sigma = 0.2
    x = sigma * rng.standard_normal(400_000)
    out = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc = (1 - a) * acc + a * v
        out[i] = acc
    emp = out[2000:].var() / sigma**2
    print(f"   alpha={a:4.2f}  empirical {emp:.5f}  formula {a/(2-a):.5f}  N_eff={(2-a)/a:.1f}")

# ---- 2/3. Ghosting and clamp cost ----
W, T, OBJ, SPEED = 160, 120, 12, 2


def run(clamp, gamma=1.0, noise=0.0):
    acc = np.zeros(W)
    errs, noise_resid = [], []
    for t in range(T):
        truth = np.zeros(W)
        x0 = 10 + t * SPEED
        truth[x0:x0 + OBJ] = 1.0 if x0 + OBJ < W else 0
        cur = truth + noise * rng.standard_normal(W)
        hist = acc.copy()                      # reprojected history (static: no motion vector for the object)
        if clamp == "minmax":                  # 3-tap neighborhood of the CURRENT frame
            pad = np.pad(cur, 1, mode="edge")
            lo = np.minimum.reduce([pad[:-2], pad[1:-1], pad[2:]])
            hi = np.maximum.reduce([pad[:-2], pad[1:-1], pad[2:]])
            hist = np.clip(hist, lo, hi)
        elif clamp == "varclip":               # mean +/- gamma*sigma over a 5-tap neighborhood
            pad = np.pad(cur, 2, mode="edge")
            st = np.stack([pad[i:i + W] for i in range(5)])
            mu, sd = st.mean(0), st.std(0)
            hist = np.clip(hist, mu - gamma * sd, mu + gamma * sd)
        acc = (1 - ALPHA) * hist + ALPHA * cur
        if t > 20:
            behind = np.zeros(W, bool)
            behind[: max(x0 - 1, 0)] = True    # pixels the object has already left
            behind[:5] = False
            errs.append(np.abs(acc - np.zeros(W))[behind].mean() if behind.any() else 0.0)
    return float(np.mean(errs))


print("\n2. ghosting: mean |output - truth| behind a moving object, no motion vector (lower is better)")
for name, kw in [("no clamp", dict(clamp="none")), ("min/max clamp", dict(clamp="minmax")),
                 ("variance clip g=0.75", dict(clamp="varclip", gamma=0.75)),
                 ("variance clip g=1.0", dict(clamp="varclip", gamma=1.0)),
                 ("variance clip g=1.5", dict(clamp="varclip", gamma=1.5)),
                 ("variance clip g=3.0", dict(clamp="varclip", gamma=3.0))]:
    print(f"   {name:22s} ghost error = {run(**kw):.5f}")

print("\n3. cost: residual noise (std) on a STATIC noisy signal, sigma=0.2 (unclamped = what denoising can reach)")


def static_noise(clamp, gamma=1.0, sigma=0.2, T=3000):
    acc, vals = np.zeros(W), []
    for t in range(T):
        cur = 0.5 + sigma * rng.standard_normal(W)
        hist = acc.copy()
        if clamp == "minmax":
            pad = np.pad(cur, 1, mode="edge")
            hist = np.clip(hist, np.minimum.reduce([pad[:-2], pad[1:-1], pad[2:]]), np.maximum.reduce([pad[:-2], pad[1:-1], pad[2:]]))
        elif clamp == "varclip":
            pad = np.pad(cur, 2, mode="edge")
            st = np.stack([pad[i:i + W] for i in range(5)])
            hist = np.clip(hist, st.mean(0) - gamma * st.std(0), st.mean(0) + gamma * st.std(0))
        acc = (1 - ALPHA) * hist + ALPHA * cur
        if t > 200:
            vals.append(acc[5:-5] - 0.5)
    return float(np.std(np.concatenate(vals)))


print(f"   theoretical unclamped std = {0.2*np.sqrt(ALPHA/(2-ALPHA)):.4f}")
for name, kw in [("no clamp", dict(clamp="none")), ("min/max clamp", dict(clamp="minmax")),
                 ("variance clip g=1.0", dict(clamp="varclip", gamma=1.0)), ("variance clip g=3.0", dict(clamp="varclip", gamma=3.0))]:
    print(f"   {name:22s} std = {static_noise(**kw):.4f}")

# ---- 4. Halton ----
def halton(i, b):
    f, r = 1.0, 0.0
    while i > 0:
        f /= b
        r += f * (i % b)
        i //= b
    return r


h2 = [halton(i, 2) for i in range(1, 5)]
print("\n4. Halton base 2, i=1..4:", h2, " expected [0.5, 0.25, 0.75, 0.125] ->", "PASS" if h2 == [0.5, 0.25, 0.75, 0.125] else "FAIL")

# ---- 5. critically damped spring ----
def spring(x0, v0, target, w, dt):
    e0 = x0 - target
    k = v0 + w * e0
    ex = np.exp(-w * dt)
    return target + (e0 + k * dt) * ex, (v0 - w * k * dt) * ex


w = 7.3
x, v = 1.0, -0.4
a1 = spring(*spring(x, v, 0.2, w, 0.013), 0.2, w, 0.013)
a2 = spring(x, v, 0.2, w, 0.026)
print(f"5. spring: two dt steps vs one 2dt step: dx={abs(a1[0]-a2[0]):.2e} dv={abs(a1[1]-a2[1]):.2e}  ->", "PASS" if max(abs(a1[0]-a2[0]), abs(a1[1]-a2[1])) < 1e-14 else "FAIL")
