"""AudioComposer — Python's voice in the engine's polyglot audio.

Python doesn't render samples here; it *composes*. Given a seed it writes a
score (chords, melody, bass) in the engine's shared score format, and any
language's renderer can play it. That split is deliberate: Python owns the
musical decisions (the ML-flavored part — seeded progressions, probabilistic
melody walks), while sample rendering stays wherever the host is fastest.

Score format (shared with C#, Swift, Kotlin, TypeScript):
    {"generator": ..., "language": "Python", "seed": 7, "loop_dur": 16.0,
     "events": [{"t": 0.0, "dur": 0.5, "freq": 220.0,
                 "kind": "tone", "gain": 0.2}, ...]}
kinds: "tone" (lead), "pad" (chord stab), "bass", "noise" (hat/tick).
"""
from .rng import Rng

# A-minor-ish progression as semitone offsets from A2 (110 Hz).
_PROGRESSIONS = [
    [0, -4, -2, 3],    # Am F G C
    [0, 0, -4, -2],    # Am Am F G
    [-4, -2, 0, 3],    # F G Am C
    [0, 3, -4, -2],    # Am C F G
]
_PENTA = [0, 3, 5, 7, 10, 12, 15]  # minor pentatonic, semitones


def _freq(base: float, semis: int) -> float:
    return base * (2.0 ** (semis / 12.0))


class AudioComposer:
    language_tag = "Python"

    def compose(self, seed: int, bars: int = 4, bpm: float = 96.0) -> dict:
        rng = Rng(seed ^ 0xA071C)
        prog = _PROGRESSIONS[rng.next_u64() % len(_PROGRESSIONS)]
        beat = 60.0 / bpm
        bar = beat * 4
        events = []

        # Pad stabs: root + third + fifth per bar.
        for b in range(bars):
            root = prog[b % len(prog)]
            t = b * bar
            for semis in (root, root + 3, root + 7):
                events.append({
                    "t": round(t, 4), "dur": round(bar * 0.9, 4),
                    "freq": round(_freq(110.0, semis), 2),
                    "kind": "pad", "gain": 0.10,
                })

        # Melody: a seeded walk on the pentatonic, 8th notes, some rests.
        degree = 3
        for b in range(bars):
            for eighth in range(8):
                t = b * bar + eighth * beat / 2
                if rng.uniform() < 0.25:
                    continue  # rest
                degree += [-2, -1, -1, 0, 1, 1, 2][rng.next_u64() % 7]
                degree = max(0, min(len(_PENTA) - 1, degree))
                root = prog[b % len(prog)]
                events.append({
                    "t": round(t, 4), "dur": round(beat * 0.45, 4),
                    "freq": round(_freq(220.0, root + _PENTA[degree]), 2),
                    "kind": "tone", "gain": 0.16,
                })

        # Bass: root 8ths, deterministic.
        for b in range(bars):
            root = prog[b % len(prog)]
            for eighth in range(8):
                t = b * bar + eighth * beat / 2
                events.append({
                    "t": round(t, 4), "dur": round(beat * 0.4, 4),
                    "freq": round(_freq(55.0, root), 2),
                    "kind": "bass", "gain": 0.14,
                })

        events.sort(key=lambda e: e["t"])
        return {
            "generator": "xrgen.audio.AudioComposer",
            "language": self.language_tag,
            "seed": seed,
            "loop_dur": round(bars * bar, 4),
            "events": events,
        }
