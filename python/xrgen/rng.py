"""Deterministic seeded RNG. SplitMix64 - stable across runs and platforms,
so a seed means the same stream whether this runs here, embedded in C++,
or mirrored in TypeScript."""
import math

_M64 = (1 << 64) - 1


class Rng:
    def __init__(self, seed: int):
        self.state = seed & _M64

    def next_u64(self) -> int:
        self.state = (self.state + 0x9E3779B97F4A7C15) & _M64
        z = self.state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & _M64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & _M64
        return z ^ (z >> 31)

    def uniform(self, lo: float = 0.0, hi: float = 1.0) -> float:
        return lo + (hi - lo) * (self.next_u64() / 18446744073709551616.0)

    def normal(self) -> float:
        """Standard normal via Box-Muller."""
        u1 = max(self.uniform(), 1e-12)
        u2 = self.uniform()
        return math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)
