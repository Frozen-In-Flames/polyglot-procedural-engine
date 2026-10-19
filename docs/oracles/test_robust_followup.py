# Follow-up to test_robust_costs.py: (a) GM efficiency vs tightness c, (b) hardest condition by c from near starts, (c) NIS change detector under outliers.
# Run: python3 test_robust_followup.py   (imports the scene/solver from test_robust_costs.py by executing its head)
import numpy as np, sys, io, contextlib
src = open('test_robust_costs.py').read()
ns = {'__name__': 'rc', 'sys': sys}
sys.argv = ['x', '1']
head = src[:src.index("METHODS = (")]
exec(compile(head, 'rc_head', 'exec'), ns)
rng, render, jac, make_image, fit, failed, M, SIG = ns['rng'], ns['render'], ns['jac'], ns['make_image'], ns['fit'], ns['failed'], ns['M'], ns['SIG']

def rand_theta():
    return np.array([rng.uniform(0.3, 1.2), rng.uniform(0.2, 0.8), rng.uniform(0.6, 1.1), rng.uniform(0.05, 0.2)])

# (a) statistical efficiency of GM vs c on CLEAN noise (near start): RMS error ratio vs L2
print("(a) clean-noise efficiency vs GM tightness c (RMS error ratio vs L2, per az/el/I/A), near start, 300 trials")
E = {k: [] for k in ("l2", 1.0, 1.5, 3.0, 6.0)}
for _ in range(300):
    th = rand_theta(); y, _ = make_image(th, 0.0, 0.0); th0 = th + np.array([0.05, 0.05, 0.1, 0.03]) * rng.standard_normal(4)
    th0[2] = max(th0[2], 0.2); th0[3] = max(th0[3], 0)
    E["l2"].append(fit(y, th0, "l2")[0] - th)
    for c in (1.0, 1.5, 3.0, 6.0):
        E[c].append(fit(y, th0, "gm", c_final=c)[0] - th)
base = np.sqrt(np.mean(np.array(E["l2"]) ** 2, 0))
for k in (1.0, 1.5, 3.0, 6.0):
    print(f"   GM c={k:3.1f}: {np.round(np.sqrt(np.mean(np.array(E[k])**2, 0)) / base, 2)}")

# (b) hard condition, NEAR start, vs c
print("\n(b) hardest condition (specular 1.0 + clutter 25%), near start, 200 trials, direct GM by c; Huber for reference")
rows = {}
for name in ("huber", 1.0, 1.5, 3.0):
    errs, fails = [], 0
    for _ in range(200):
        th = rand_theta(); y, _ = make_image(th, 1.0, 0.25); th0 = th + np.array([0.05, 0.05, 0.1, 0.03]) * rng.standard_normal(4)
        th0[2] = max(th0[2], 0.2); th0[3] = max(th0[3], 0)
        t, _ = fit(y, th0, "huber") if name == "huber" else fit(y, th0, "gm", c_final=name)
        e = t - th; errs.append(e); fails += failed(e)
    Ea = np.abs(np.array(errs))
    print(f"   {str(name):6s} fail {fails/2:5.1f}%   median |az| {np.median(Ea[:,0]):.4f}   median |I| {np.median(Ea[:,2]):.4f}")

# (c) does the NIS change detector from the JIT test false-alarm on outliers (perfect prediction, no real scene change)?
print("\n(c) NIS z at PERFECT prediction (theta_pred = truth, prior sd 0.03/0.03/0.03/0.03): plain vs trimmed (|u|<3) residuals")
def nis(y, th, Pcov, trim=False):
    r = y - render(th)
    if trim:
        s = max(SIG, 1.4826 * np.median(np.abs(r - np.median(r))))
        keep = np.abs(r) < 3 * s
    else:
        keep = np.ones_like(r, bool)
    Jc = jac(th)[keep]; rk = r[keep]; m = keep.sum()
    Ainf = Jc.T @ Jc / SIG**2 + np.linalg.inv(Pcov)
    q = Jc.T @ rk / SIG**2
    return (float(rk @ rk / SIG**2 - q @ np.linalg.solve(Ainf, q)) - m) / np.sqrt(2 * m)
P = np.eye(4) * 0.03**2
for name, (sp, cl) in {"clean": (0, 0), "specular 0.6": (0.6, 0), "clutter 15%": (0, 0.15), "spec 1.0 + clutter 25%": (1.0, 0.25)}.items():
    z_plain, z_trim = [], []
    for _ in range(50):
        th = rand_theta(); y, _ = make_image(th, sp, cl)
        z_plain.append(nis(y, th, P)); z_trim.append(nis(y, th, P, trim=True))
    print(f"   {name:24s} plain z median {np.median(z_plain):12.1f}   trimmed z median {np.median(z_trim):8.2f}  (alarm threshold 6)")
