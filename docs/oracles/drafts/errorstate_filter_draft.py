"""
DRAFT - UNVALIDATED. Cross-check oracle for the error-state attitude filter.
Identities, not trust. For comparison against the owner's validated oracle;
NOT normative spec.

Error-state EKF: nominal quaternion qhat (body->world), gyro bias bhat.
  propagate: qhat <- qhat (x) exp((wm - bhat) dt)
  error state: [dtheta (attitude), db (bias)], P 6x6
  Fc = [[-[what]x, -I],[0, 0]], Fd ~= I + Fc dt
  update with unit gravity vector z (accel, body frame):
      h = R(qhat)^T g_w,  H = [[h]x, 0],  K = P H^T (H P H^T + R)^-1
  correct: qhat <- qhat (x) exp(dtheta), bhat <- bhat + db, P <- (I-KH) P
"""
import numpy as np

rng = np.random.default_rng(5)
ok_all = True


def report(name, ok, detail=""):
    global ok_all
    ok_all &= bool(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


# ---------- quaternion utils, [w,x,y,z], body -> world ----------
def qmul(a, b):
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b
    return np.array([w1*w2 - x1*x2 - y1*y2 - z1*z2,
                     w1*x2 + x1*w2 + y1*z2 - z1*y2,
                     w1*y2 - x1*z2 + y1*w2 + z1*x2,
                     w1*z2 + x1*y2 - y1*x2 + z1*w2])


def qconj(q):
    return np.array([q[0], -q[1], -q[2], -q[3]])


def rotvec_to_quat(phi):
    th = np.linalg.norm(phi)
    if th < 1e-12:
        return np.array([1.0, 0, 0, 0])
    return np.concatenate([[np.cos(th / 2)], np.sin(th / 2) * phi / th])


def quat_to_mat(q):
    w, x, y, z = q
    return np.array([
        [1 - 2*(y*y + z*z), 2*(x*y - z*w),     2*(x*z + y*w)],
        [2*(x*y + z*w),     1 - 2*(x*x + z*z), 2*(y*z - x*w)],
        [2*(x*z - y*w),     2*(y*z + x*w),     1 - 2*(x*x + y*y)]])


def skew(v):
    return np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])


def quat_angle(q):
    """rotation angle of q in [0, pi]"""
    return 2 * np.arccos(np.clip(abs(q[0]), -1, 1))


def rpy_error(qh, qt):
    """attitude error as rotation vector of (qh* x qt), z-up world: yaw is z"""
    dq = qmul(qconj(qh), qt)
    if dq[0] < 0:
        dq = -dq
    ang = 2 * np.arccos(np.clip(dq[0], -1, 1))
    if ang < 1e-12:
        return np.zeros(3)
    return ang * dq[1:] / np.linalg.norm(dq[1:])


G_W = np.array([0.0, 0.0, 1.0])  # "up" measured by the accel at rest, z-up world


def eskf_step(qh, bh, P, wm, z, dt, sig_g, sig_b, sig_a, sign_flip=False):
    what = wm - bh if not sign_flip else wm + bh
    qh = qmul(qh, rotvec_to_quat(what * dt))
    qh /= np.linalg.norm(qh)
    Fc = np.zeros((6, 6))
    Fc[:3, :3] = -skew(what)
    Fc[:3, 3:] = -np.eye(3)
    Fd = np.eye(6) + Fc * dt
    Qd = np.diag([sig_g**2 * dt] * 3 + [sig_b**2 * dt] * 3)
    P = Fd @ P @ Fd.T + Qd
    R = quat_to_mat(qh)
    h = R.T @ G_W
    h /= np.linalg.norm(h)
    H = np.zeros((3, 6))
    H[:, :3] = skew(h)
    Rm = sig_a ** 2 * np.eye(3)
    S = H @ P @ H.T + Rm
    K = P @ H.T @ np.linalg.solve(S, np.eye(3))
    dx = K @ (z - h)
    qh = qmul(qh, rotvec_to_quat(dx[:3]))
    qh /= np.linalg.norm(qh)
    bh = bh + dx[3:]
    P = (np.eye(6) - K @ H) @ P
    return qh, bh, P


def simulate(omega_fn, b_true, T, dt, q0_true, q0_hat, sig_g, sig_b, sig_a,
             meas_noise=0.0, sign_flip=False):
    n = int(T / dt)
    qh = q0_hat.copy()
    bh = np.zeros(3)
    P = np.diag([0.1**2] * 3 + [0.05**2] * 3)
    qt = q0_true.copy()
    for i in range(n):
        t = i * dt
        w = omega_fn(t)
        qt = qmul(qt, rotvec_to_quat(w * dt))
        qt /= np.linalg.norm(qt)
        wm = w + b_true + (meas_noise * rng.standard_normal(3) if meas_noise else 0)
        z = quat_to_mat(qt).T @ G_W
        z = z / np.linalg.norm(z)
        if meas_noise:
            z = z + meas_noise * rng.standard_normal(3)
            z /= np.linalg.norm(z)
        qh, bh, P = eskf_step(qh, bh, P, wm, z, dt, sig_g, sig_b, sig_a, sign_flip)
    return qh, bh, P, qt


DT = 0.01
B_TRUE = np.array([0.02, -0.015, 0.01])

# ---- (a) known rotation about x + known constant bias: bias must converge ----
print("a. bias convergence under rotation about x")
qh, bh, P, qt = simulate(lambda t: np.array([0.5, 0.0, 0.0]), B_TRUE, 30.0, DT,
                         np.array([1.0, 0, 0, 0]), np.array([1.0, 0, 0, 0]),
                         0.002, 1e-5, 0.01, meas_noise=0.002)
err_b = np.linalg.norm(bh - B_TRUE)
err_a = quat_angle(qmul(qconj(qh), qt))
report("a1. |bhat - b_true| small", err_b < 0.01, f"err {err_b:.4f} rad/s")
report("a2. attitude error small", err_a < 0.03, f"err {err_a:.4f} rad")

# ---- (b) yaw observability: static, no bias, initial rpy error ----
print("b. yaw unobservable with gravity-only updates")
q0t = np.array([1.0, 0, 0, 0])
q0h = rotvec_to_quat(np.array([0.1, 0.1, 0.5]))
qh, bh, P, qt = simulate(lambda t: np.zeros(3), np.zeros(3), 15.0, DT,
                         q0t, q0h, 0.002, 1e-5, 0.01, meas_noise=0.002)
e = rpy_error(qh, qt)
report("b1. roll/pitch converge", np.linalg.norm(e[:2]) < 0.03, f"err {np.linalg.norm(e[:2]):.4f}")
report("b2. yaw does NOT converge (unobservable)", abs(e[2]) > 0.2, f"yaw err {abs(e[2]):.4f}")

# ---- (c) excitation: multi-axis rotation improves bias observability ----
print("c. excitation improves bias estimate")
qh1, bh1, _, _ = simulate(lambda t: np.array([0.5, 0.0, 0.0]), B_TRUE, 30.0, DT,
                          np.array([1.0, 0, 0, 0]), np.array([1.0, 0, 0, 0]),
                          0.002, 1e-5, 0.01, meas_noise=0.002)
qh2, bh2, _, _ = simulate(lambda t: 0.5 * np.array([np.cos(0.21 * t), np.sin(0.21 * t), 0.3]),
                          B_TRUE, 30.0, DT,
                          np.array([1.0, 0, 0, 0]), np.array([1.0, 0, 0, 0]),
                          0.002, 1e-5, 0.01, meas_noise=0.002)
e1, e2 = np.linalg.norm(bh1 - B_TRUE), np.linalg.norm(bh2 - B_TRUE)
report("c. multi-axis bias err < single-axis bias err", e2 < e1,
       f"single {e1:.4f} multi {e2:.4f}")

# ---- (d) sign-error variant: flip bias-correction sign in propagation ----
print("d. sign flip in (wm - bhat) must break the filter")
qh, bh, P, qt = simulate(lambda t: np.array([0.5, 0.0, 0.0]), B_TRUE, 30.0, DT,
                         np.array([1.0, 0, 0, 0]), np.array([1.0, 0, 0, 0]),
                         0.002, 1e-5, 0.01, meas_noise=0.002, sign_flip=True)
err_b = np.linalg.norm(bh - B_TRUE)
err_a = quat_angle(qmul(qconj(qh), qt))
report("d. flipped sign -> bias estimate wrong", (err_b > 0.05) or (err_a > 0.5),
       f"bias err {err_b:.4f} att err {err_a:.4f}")

print("\nALL PASS" if ok_all else "\nSOME FAILED")
