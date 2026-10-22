// parity/runner.cpp - cross-language tick parity: C++ port of the
// shipped character tick.
//
// Mirrors src/math/determinism.ts (Pcg32) and src/game/character.ts
// (tickCharacter) statement for statement, at TICK_DT = 1/60. The
// canonical scenario, serialization, and digest are specified in
// docs/tick-parity.md; constants below mirror parity/scenario.json
// (parity itself polices the copy: any drift splits the digest).
//
// Build (no fast-math, no FMA contraction, so every rounding matches
// the spec's float discipline):
//   g++ -std=c++17 -O2 -ffp-contract=off -o runner parity/runner.cpp
//
// Usage: runner [--seed N] [--ticks N] [--perturb-gravity]
//               [--shift-script] [--dump]

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

// ---------------------------------------------------------------- PCG --
struct Pcg32 {
  uint32_t s;
  explicit Pcg32(uint32_t seed) : s(seed) {}
  uint32_t next() {
    s = s * 747796405u + 2891336453u;
    uint32_t w = s ^ (s >> ((s >> 28) + 4));
    w = w * 277803737u;
    return (w ^ (w >> 22));
  }
};

// --------------------------------------------------------------- world --
const double kSqrt3_2 = 0.8660254037844386;

struct Field {
  double d;
  double gx, gy, gz;
};

// Min of plane, ramp, sphere; first-minimum-wins in that order.
Field worldF(double px, double py, double pz) {
  const double dPlane = py;
  const double dRamp = 0.5 * py - kSqrt3_2 * (pz - 8.0);
  const double dx = px - 5.6;
  const double dy = py - 0.9;
  const double dz = pz - 2.6;
  const double len = std::sqrt(dx * dx + dy * dy + dz * dz);
  const double dSphere = len - 0.9;
  if (dPlane <= dRamp && dPlane <= dSphere) return {dPlane, 0.0, 1.0, 0.0};
  if (dRamp <= dSphere) return {dRamp, 0.0, 0.5, -kSqrt3_2};
  const double inv = 1.0 / len;
  return {dSphere, dx * inv, dy * inv, dz * inv};
}

// ------------------------------------------------------------ character --
struct Params {
  double radius = 0.4;
  double halfHeight = 0.5;
  double moveAccel = 40.0;
  double airAccel = 12.0;
  double maxGroundSpeed = 6.0;
  double maxAirSpeed = 4.0;
  double jumpVelocity = 8.0;
  double gravity = 20.0;
  double groundEps = 0.05;
  int coyoteTicks = 6;
  int bufferTicks = 8;
  double slopeLimit = 0.8660254037844386;
  double groundFriction = 30.0;
  double jumpCut = 0.5;
};

struct State {
  double pos[3];
  double vel[3] = {0.0, 0.0, 0.0};
  bool grounded = false;
  int coyote = 0;
  int buffer = 0;
  bool jumpHeld = false;
};

double len2(double x, double y) { return std::sqrt(x * x + y * y); }
double len3(double x, double y, double z) {
  return std::sqrt(x * x + y * y + z * z);
}

void norm3(double x, double y, double z, double out[3]) {
  double l = len3(x, y, z);
  if (!l) l = 1.0;
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
}

// One fixed tick. Operation order mirrors tickCharacter exactly.
void tickCharacter(State& st, const Params& p, double moveX, double moveZ,
                   bool jumpPressed, bool jumpHeld, double dt) {
  // 1. Buffer the press.
  if (jumpPressed) st.buffer = p.bufferTicks;

  // 2. Early-release jump cut.
  if (st.jumpHeld && !jumpHeld && st.vel[1] > 0) st.vel[1] *= p.jumpCut;
  st.jumpHeld = jumpHeld;

  // 3. Horizontal control.
  const double wishLen = len2(moveX, moveZ);
  const double topSpeed = st.grounded ? p.maxGroundSpeed : p.maxAirSpeed;
  const double accel = st.grounded ? p.moveAccel : p.airAccel;
  double wishX = 0.0;
  double wishZ = 0.0;
  if (wishLen > 1e-12) {
    wishX = (moveX / wishLen) * topSpeed;
    wishZ = (moveZ / wishLen) * topSpeed;
  }
  const double dx = wishX - st.vel[0];
  const double dz = wishZ - st.vel[2];
  const double dl = len2(dx, dz);
  const double maxD = accel * dt;
  if (dl <= maxD) {
    st.vel[0] = wishX;
    st.vel[2] = wishZ;
  } else if (dl > 1e-12) {
    st.vel[0] += (dx / dl) * maxD;
    st.vel[2] += (dz / dl) * maxD;
  }
  if (st.grounded && wishLen <= 1e-12) {
    const double sp = len2(st.vel[0], st.vel[2]);
    if (sp > 1e-12) {
      const double ns = std::max(0.0, sp - p.groundFriction * dt);
      st.vel[0] *= ns / sp;
      st.vel[2] *= ns / sp;
    } else {
      st.vel[0] = 0.0;
      st.vel[2] = 0.0;
    }
  }

  // 4. Jump.
  bool jumped = false;
  if (st.buffer > 0 && (st.grounded || st.coyote > 0)) {
    st.vel[1] = p.jumpVelocity;
    st.grounded = false;
    st.coyote = 0;
    st.buffer = 0;
    jumped = true;
  }

  // 5. Gravity.
  if (!st.grounded && !jumped) st.vel[1] -= p.gravity * dt;

  // 6. Integrate.
  st.pos[0] += st.vel[0] * dt;
  st.pos[1] += st.vel[1] * dt;
  st.pos[2] += st.vel[2] * dt;

  // 7. Collide: endpoints computed before the loop, as in the original.
  const double ends[2][3] = {
      {st.pos[0], st.pos[1] - p.halfHeight, st.pos[2]},
      {st.pos[0], st.pos[1] + p.halfHeight, st.pos[2]},
  };
  for (const auto& e : ends) {
    const Field f = worldF(e[0], e[1], e[2]);
    if (f.d < p.radius) {
      double n[3];
      norm3(f.gx, f.gy, f.gz, n);
      const double push = p.radius - f.d;
      st.pos[0] += n[0] * push;
      st.pos[1] += n[1] * push;
      st.pos[2] += n[2] * push;
      const double vn = st.vel[0] * n[0] + st.vel[1] * n[1] + st.vel[2] * n[2];
      if (vn < 0) {
        st.vel[0] -= n[0] * vn;
        st.vel[1] -= n[1] * vn;
        st.vel[2] -= n[2] * vn;
      }
    }
  }

  // 8. Ground detect at the feet.
  const Field ff = worldF(st.pos[0], st.pos[1] - p.halfHeight, st.pos[2]);
  double n[3];
  norm3(ff.gx, ff.gy, ff.gz, n);
  if (ff.d <= p.radius + p.groundEps && n[1] > 0) {
    if (n[1] >= p.slopeLimit) {
      st.grounded = true;
      st.coyote = p.coyoteTicks;
    } else {
      st.grounded = false;
      st.coyote = 0;
    }
  } else {
    st.grounded = false;
    st.coyote = std::max(0, st.coyote - 1);
  }

  // 9. Decay the unconsumed buffer.
  if (st.buffer > 0) st.buffer -= 1;
}

// ------------------------------------------------------------- digest --
struct Fnva {
  uint64_t h = 14695981039346656037ull;
  void byte(uint8_t b) { h = (h ^ b) * 1099511628211ull; }
  void u32(uint32_t v) {
    for (int i = 0; i < 4; i++) byte((v >> (8 * i)) & 0xff);
  }
  void i32(int32_t v) { u32(static_cast<uint32_t>(v)); }
  void f64(double v) {
    uint64_t bits;
    std::memcpy(&bits, &v, 8);
    for (int i = 0; i < 8; i++) byte((bits >> (8 * i)) & 0xff);
  }
  void u8(uint8_t v) { byte(v); }
};

struct Input {
  double moveX, moveZ;
  bool pressed, held;
};

} // namespace

int main(int argc, char** argv) {
  uint32_t seed = 20261022;
  int ticks = 600;
  bool perturbGravity = false;
  bool shiftScript = false;
  bool dump = false;
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    if (a == "--seed" && i + 1 < argc) seed = std::stoul(argv[++i]);
    else if (a == "--ticks" && i + 1 < argc) ticks = std::stoi(argv[++i]);
    else if (a == "--perturb-gravity") perturbGravity = true;
    else if (a == "--shift-script") shiftScript = true;
    else if (a == "--dump") dump = true;
  }

  Params params;
  if (perturbGravity) params.gravity += 1e-9;
  const double dt = 1.0 / 60.0;

  Pcg32 rng(seed);
  const uint32_t s0 = rng.next();
  State st;
  st.pos[0] = (static_cast<int>(s0 % 401) - 200) / 50.0;
  st.pos[1] = 2.5;
  st.pos[2] = -2.0;

  const double dirs[8][2] = {{1, 0}, {1, 1}, {0, 1}, {-1, 1},
                             {-1, 0}, {-1, -1}, {0, -1}, {1, -1}};
  std::vector<Input> script;
  long holdEnd = -1;
  double curMoveX = 0.0;
  double curMoveZ = 0.0;
  for (int t = 0; t < ticks + 1; t++) {
    const uint32_t a = rng.next();
    if (t % 20 == 0) {
      if ((t / 20) % 3 == 2) {
        curMoveX = 0.0;
        curMoveZ = 1.0;
      } else {
        const int k = a % 9;
        curMoveX = k == 8 ? 0.0 : dirs[k][0];
        curMoveZ = k == 8 ? 0.0 : dirs[k][1];
      }
    }
    Input in;
    in.moveX = curMoveX;
    in.moveZ = curMoveZ;
    const uint32_t b = rng.next();
    in.pressed = (b % 53) == 0;
    if (in.pressed) holdEnd = t + 1 + (b % 7);
    in.held = t < holdEnd;
    script.push_back(in);
  }
  if (shiftScript) {
    for (int t = ticks; t >= 1; t--) script[t] = script[t - 1];
  }

  Fnva fnv;
  for (int t = 0; t < ticks; t++) {
    const Input& in = script[t];
    tickCharacter(st, params, in.moveX, in.moveZ, in.pressed, in.held, dt);
    fnv.u32(static_cast<uint32_t>(t));
    fnv.f64(st.pos[0]);
    fnv.f64(st.pos[1]);
    fnv.f64(st.pos[2]);
    fnv.f64(st.vel[0]);
    fnv.f64(st.vel[1]);
    fnv.f64(st.vel[2]);
    fnv.u8(st.grounded ? 1 : 0);
    fnv.i32(st.coyote);
    fnv.i32(st.buffer);
    fnv.u8(st.jumpHeld ? 1 : 0);
    if (dump) {
      std::printf("%d %.17g %.17g %.17g %.17g %.17g %.17g %d %d %d %d\n", t,
                  st.pos[0], st.pos[1], st.pos[2], st.vel[0], st.vel[1],
                  st.vel[2], st.grounded ? 1 : 0, st.coyote, st.buffer,
                  st.jumpHeld ? 1 : 0);
    } else {
      std::printf("%d %016llx\n", t, (unsigned long long)fnv.h);
    }
  }
  return 0;
}
