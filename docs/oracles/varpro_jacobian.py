"""
VARPRO Jacobian reference test.

Checks the Golub-Pereyra residual Jacobian against central finite differences:

    r(theta)        = P_perp(theta) y,   P_perp = I - Phi Phi^+
    dr/dtheta_k     = -[ P_perp D_k Phi^+ + (P_perp D_k Phi^+)^T ] y     (full GP)
    Kaufman approx  = -[ P_perp D_k Phi^+ ] y                            (drop 2nd term)

Cases:
  A. full column rank                      -> GP exact, Kaufman approximate
  B. constant rank deficiency              -> (albedo, intensity as two proportional columns)
  C. rank drops at a point in theta        -> where the formula should be expected to fail
"""
import numpy as np

rng = np.random.default_rng(7)


def residual(Phi_fn, theta, y):
    Phi = Phi_fn(theta)
    return y - Phi @ np.linalg.pinv(Phi) @ y  # P_perp y


def jac_fd(Phi_fn, theta, y, h=1e-6):
    J = np.zeros((len(y), len(theta)))
    for k in range(len(theta)):
        e = np.zeros_like(theta)
        e[k] = h
        J[:, k] = (residual(Phi_fn, theta + e, y) - residual(Phi_fn, theta - e, y)) / (2 * h)
    return J


def jac_gp(Phi_fn, dPhi_fn, theta, y, kaufman=False):
    Phi = Phi_fn(theta)
    Pp = np.linalg.pinv(Phi)
    Pperp = np.eye(len(y)) - Phi @ Pp
    cols = []
    for Dk in dPhi_fn(theta):
        A = Pperp @ Dk @ Pp
        cols.append(-(A @ y if kaufman else (A + A.T) @ y))
    return np.stack(cols, axis=1)


def relerr(a, b):
    return np.linalg.norm(a - b) / max(np.linalg.norm(b), 1e-300)


t = np.linspace(0, 1, 60)


def report(name, J_ref, J_gp, J_k):
    print(f"  {name:34s} GP err = {relerr(J_gp, J_ref):9.2e}   Kaufman err = {relerr(J_k, J_ref):9.2e}")


print("A. full column rank: Phi = [exp(-a t), exp(-b t), 1]")
Phi_A = lambda th: np.stack([np.exp(-th[0] * t), np.exp(-th[1] * t), np.ones_like(t)], 1)
dPhi_A = lambda th: [
    np.stack([-t * np.exp(-th[0] * t), 0 * t, 0 * t], 1),
    np.stack([0 * t, -t * np.exp(-th[1] * t), 0 * t], 1),
]
th = np.array([2.0, 5.0])
y = Phi_A(th) @ np.array([1.0, 0.5, 0.2]) + 0.01 * rng.standard_normal(len(t))
th0 = np.array([1.7, 4.2])  # evaluate away from the optimum so r != 0
report("full rank", jac_fd(Phi_A, th0, y), jac_gp(Phi_A, dPhi_A, th0, y), jac_gp(Phi_A, dPhi_A, th0, y, True))

print("B. constant rank deficiency: columns [g(theta), s*g(theta)]  (albedo, intensity kept separate)")
s = 3.0
g = lambda th: np.exp(-th[0] * t) * np.cos(th[1] * t)
dg = lambda th: [-t * np.exp(-th[0] * t) * np.cos(th[1] * t), -t * np.exp(-th[0] * t) * np.sin(th[1] * t)]
Phi_B = lambda th: np.stack([g(th), s * g(th)], 1)
dPhi_B = lambda th: [np.stack([d, s * d], 1) for d in dg(th)]
th = np.array([1.5, 4.0])
yB = Phi_B(th) @ np.array([0.7, 0.1]) + 0.01 * rng.standard_normal(len(t))
th0 = np.array([1.2, 3.6])
Phi = Phi_B(th0)
sv = np.linalg.svd(Phi, compute_uv=False)
print(f"  singular values of Phi: {sv[0]:.3f}, {sv[1]:.2e}  (rank 1 of 2)")
report("constant rank deficient", jac_fd(Phi_B, th0, yB), jac_gp(Phi_B, dPhi_B, th0, yB), jac_gp(Phi_B, dPhi_B, th0, yB, True))
c_min_norm = np.linalg.pinv(Phi) @ yB
print(f"  recovered (albedo, intensity) = {c_min_norm.round(4)}   <- arbitrary min-norm split; only the sum rho*(1 + s*E) is determined")

print("C. rank drops at theta=0: Phi = [g1, g1 + theta*w(phi)], w rotating in the complement of g1; d/dphi")
m = len(t)
g1 = np.zeros(m); g1[0] = 1.0
u = np.zeros(m); u[1] = 1.0
v = np.zeros(m); v[2] = 1.0
w = lambda ph: np.cos(ph) * u + np.sin(ph) * v
dw = lambda ph: -np.sin(ph) * u + np.cos(ph) * v
Phi_C = lambda p: np.stack([g1, g1 + p[0] * w(p[1])], 1)
dPhi_C = lambda p: [np.stack([0 * g1, p[0] * dw(p[1])], 1)]  # derivative wrt phi only
yC = rng.standard_normal(m)
for th_val in [1e-1, 1e-3, 1e-5, 1e-7, 1e-9, 1e-11]:
    p0 = np.array([th_val, 0.6])
    sv = np.linalg.svd(Phi_C(p0), compute_uv=False)
    # FD wrt phi only (column 1 of the full FD Jacobian)
    J_ref = jac_fd(Phi_C, p0, yC, h=1e-6)[:, 1:2]
    e = relerr(jac_gp(Phi_C, dPhi_C, p0, yC), J_ref)
    print(f"  theta = {th_val:8.0e}   sigma_min/sigma_max = {sv[1]/sv[0]:9.2e}   GP err = {e:9.2e}   |J_ref| = {np.linalg.norm(J_ref):.3f}")
