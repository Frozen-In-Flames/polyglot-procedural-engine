"""Cross-language tick parity: Python port of the shipped character tick.

Mirrors src/math/determinism.ts (Pcg32) and src/game/character.ts
(tickCharacter) statement for statement, at TICK_DT = 1/60 from
src/game/loop.ts. The canonical scenario, serialization, and digest
are specified in docs/tick-parity.md; parity/scenario.json holds the
parameters. Run as a module to print the golden-trace digests:

    cd python && python3 -m xrgen.ticksim [--seed N] [--ticks N]
        [--perturb-gravity] [--shift-script] [--dump]

--perturb-gravity and --shift-script are negative-control hooks for
test/tick-parity.test.ts: each must change the trace.
"""
import argparse
import json
import math
import os
import struct

_M32 = 0xFFFFFFFF
_PCG_MUL = 747796405
_PCG_INC = 2891336453
_PCG_XSMUL = 277803737


class Pcg32:
    """Stateful PCG32 (RXS-M-XS), bit-exact with the TypeScript one."""

    def __init__(self, seed: int):
        self.s = seed & _M32

    def next(self) -> int:
        self.s = (self.s * _PCG_MUL + _PCG_INC) & _M32
        w = (self.s ^ (self.s >> ((self.s >> 28) + 4))) & _M32
        w = (w * _PCG_XSMUL) & _M32
        return (w ^ (w >> 22)) & _M32


# World: min of plane, ramp, sphere; first-minimum-wins in that order.
_SQRT3_2 = 0.8660254037844386


def world_f(px, py, pz):
    d_plane = py
    d_ramp = 0.5 * py - _SQRT3_2 * (pz - 8.0)
    dx = px - 5.6
    dy = py - 0.9
    dz = pz - 2.6
    d_sphere = math.sqrt(dx * dx + dy * dy + dz * dz) - 0.9
    if d_plane <= d_ramp and d_plane <= d_sphere:
        return d_plane, (0.0, 1.0, 0.0)
    if d_ramp <= d_sphere:
        return d_ramp, (0.0, 0.5, -_SQRT3_2)
    inv = 1.0 / math.sqrt(dx * dx + dy * dy + dz * dz)
    return d_sphere, (dx * inv, dy * inv, dz * inv)


def _len2(x, y):
    return math.sqrt(x * x + y * y)


def _len3(x, y, z):
    return math.sqrt(x * x + y * y + z * z)


def _norm3(x, y, z):
    l = _len3(x, y, z)
    if not l:
        l = 1.0
    return (x / l, y / l, z / l)


class Character:
    def __init__(self, pos):
        self.pos = [pos[0], pos[1], pos[2]]
        self.vel = [0.0, 0.0, 0.0]
        self.grounded = False
        self.coyote = 0
        self.buffer = 0
        self.jump_held = False


def tick_character(st, p, move, jump_pressed, jump_held, dt):
    """One fixed tick. Operation order mirrors tickCharacter exactly."""
    # 1. Buffer the press.
    if jump_pressed:
        st.buffer = p["bufferTicks"]

    # 2. Early-release jump cut.
    if st.jump_held and not jump_held and st.vel[1] > 0:
        st.vel[1] *= p["jumpCut"]
    st.jump_held = jump_held

    # 3. Horizontal control.
    wish_len = _len2(move[0], move[1])
    top_speed = p["maxGroundSpeed"] if st.grounded else p["maxAirSpeed"]
    accel = p["moveAccel"] if st.grounded else p["airAccel"]
    wish_x = 0.0
    wish_z = 0.0
    if wish_len > 1e-12:
        wish_x = (move[0] / wish_len) * top_speed
        wish_z = (move[1] / wish_len) * top_speed
    dx = wish_x - st.vel[0]
    dz = wish_z - st.vel[2]
    dl = _len2(dx, dz)
    max_d = accel * dt
    if dl <= max_d:
        st.vel[0] = wish_x
        st.vel[2] = wish_z
    elif dl > 1e-12:
        st.vel[0] += (dx / dl) * max_d
        st.vel[2] += (dz / dl) * max_d
    if st.grounded and wish_len <= 1e-12:
        sp = _len2(st.vel[0], st.vel[2])
        if sp > 1e-12:
            ns = max(0.0, sp - p["groundFriction"] * dt)
            st.vel[0] *= ns / sp
            st.vel[2] *= ns / sp
        else:
            st.vel[0] = 0.0
            st.vel[2] = 0.0

    # 4. Jump.
    jumped = False
    if st.buffer > 0 and (st.grounded or st.coyote > 0):
        st.vel[1] = p["jumpVelocity"]
        st.grounded = False
        st.coyote = 0
        st.buffer = 0
        jumped = True

    # 5. Gravity.
    if not st.grounded and not jumped:
        st.vel[1] -= p["gravity"] * dt

    # 6. Integrate.
    st.pos[0] += st.vel[0] * dt
    st.pos[1] += st.vel[1] * dt
    st.pos[2] += st.vel[2] * dt

    # 7. Collide: endpoints computed before the loop, as in the original.
    ends = [
        (st.pos[0], st.pos[1] - p["halfHeight"], st.pos[2]),
        (st.pos[0], st.pos[1] + p["halfHeight"], st.pos[2]),
    ]
    for e in ends:
        d, g = world_f(e[0], e[1], e[2])
        if d < p["radius"]:
            n = _norm3(g[0], g[1], g[2])
            push = p["radius"] - d
            st.pos[0] += n[0] * push
            st.pos[1] += n[1] * push
            st.pos[2] += n[2] * push
            vn = st.vel[0] * n[0] + st.vel[1] * n[1] + st.vel[2] * n[2]
            if vn < 0:
                st.vel[0] -= n[0] * vn
                st.vel[1] -= n[1] * vn
                st.vel[2] -= n[2] * vn

    # 8. Ground detect at the feet.
    feet = (st.pos[0], st.pos[1] - p["halfHeight"], st.pos[2])
    d_feet, g_feet = world_f(feet[0], feet[1], feet[2])
    n = _norm3(g_feet[0], g_feet[1], g_feet[2])
    if d_feet <= p["radius"] + p["groundEps"] and n[1] > 0:
        if n[1] >= p["slopeLimit"]:
            st.grounded = True
            st.coyote = p["coyoteTicks"]
        else:
            st.grounded = False
            st.coyote = 0
    else:
        st.grounded = False
        st.coyote = max(0, st.coyote - 1)

    # 9. Decay the unconsumed buffer.
    if st.buffer > 0:
        st.buffer -= 1


_DIRS = [
    (1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (-1.0, 1.0),
    (-1.0, 0.0), (-1.0, -1.0), (0.0, -1.0), (1.0, -1.0),
]

_FNV_OFFSET = 14695981039346656037
_FNV_PRIME = 1099511628211
_M64 = 0xFFFFFFFFFFFFFFFF


def _serialize(tick, st):
    out = struct.pack("<I", tick)
    for v in st.pos:
        out += struct.pack("<d", v)
    for v in st.vel:
        out += struct.pack("<d", v)
    out += struct.pack("<B", 1 if st.grounded else 0)
    out += struct.pack("<i", st.coyote)
    out += struct.pack("<i", st.buffer)
    out += struct.pack("<B", 1 if st.jump_held else 0)
    return out


def run_trace(seed, ticks, params, perturb_gravity=False, shift_script=False):
    """Returns (digest lines, state lines) for the canonical scenario."""
    p = dict(params)
    if perturb_gravity:
        p["gravity"] = p["gravity"] + 1e-9
    dt = 1.0 / 60.0
    rng = Pcg32(seed)
    s0 = rng.next()
    spawn_x = ((s0 % 401) - 200) / 50.0
    st = Character((spawn_x, 2.5, -2.0))

    # Pre-generate the input script so --shift-script can offset it.
    # Two draws per tick, always consumed. The move direction updates
    # only at leg starts (t % 20 == 0) and persists for the leg, so the
    # walk actually travels; the a-draw on other ticks is consumed and
    # ignored, keeping the stream position language-independent.
    script = []
    hold_end = -1
    move = (0.0, 0.0)
    for t in range(ticks + 1):
        a = rng.next()
        if t % 20 == 0:
            if (t // 20) % 3 == 2:
                move = (0.0, 1.0)
            else:
                k = a % 9
                move = (0.0, 0.0) if k == 8 else _DIRS[k]
        b = rng.next()
        pressed = (b % 53) == 0
        if pressed:
            hold_end = t + 1 + (b % 7)
        script.append((move, pressed, t < hold_end))
    if shift_script:
        script = [script[0]] + script[:-1]

    h = _FNV_OFFSET
    digests = []
    states = []
    for t in range(ticks):
        move, pressed, held = script[t]
        tick_character(st, p, move, pressed, held, dt)
        for byte in _serialize(t, st):
            h = ((h ^ byte) * _FNV_PRIME) & _M64
        digests.append("%d %016x" % (t, h))
        states.append(
            "%d %r %r %r %r %r %r %d %d %d %d"
            % (
                t,
                st.pos[0], st.pos[1], st.pos[2],
                st.vel[0], st.vel[1], st.vel[2],
                1 if st.grounded else 0, st.coyote, st.buffer,
                1 if st.jump_held else 0,
            )
        )
    return digests, states


def _load_params():
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "..", "..", "parity", "scenario.json")
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)["params"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=20261022)
    ap.add_argument("--ticks", type=int, default=600)
    ap.add_argument("--perturb-gravity", action="store_true")
    ap.add_argument("--shift-script", action="store_true")
    ap.add_argument("--dump", action="store_true")
    args = ap.parse_args()
    digests, states = run_trace(
        args.seed,
        args.ticks,
        _load_params(),
        perturb_gravity=args.perturb_gravity,
        shift_script=args.shift_script,
    )
    lines = states if args.dump else digests
    print("\n".join(lines))


if __name__ == "__main__":
    main()
