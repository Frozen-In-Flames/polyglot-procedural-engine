"""AudioComposer - Python's voice in the engine's polyglot audio.

Python doesn't render samples here; it *composes*. Given a seed it writes a
score (chords, melody, bass) in the engine's shared score format, and any
language's renderer can play it. That split is deliberate: Python owns the
musical decisions (the ML-flavored part - seeded progressions, probabilistic
melody walks), while sample rendering stays wherever the host is fastest.

Score format (shared with C#, Swift, Kotlin, TypeScript):
    {"generator": ..., "language": "Python", "seed": 7, "loop_dur": 16.0,
     "events": [{"t": 0.0, "dur": 0.5, "freq": 220.0,
                 "kind": "tone", "gain": 0.2}, ...]}
kinds: "tone" (lead), "pad" (chord stab), "bass", "noise" (hat/tick).

V8 score schema v1.1 adds kinds "pluck" | "ping" | "riser" | "gust" |
"granular" and optional fields attack, decay, filterFreq, reverbSend.
Zero asset dependence: every note is seeded math, no samples anywhere.
"""
from .rng import Rng
from .score import (
    AIR_BRIGHTNESS_GATE,
    HARMONY_ENERGY_GATE,
    MINOR_PENTA,
    SONG_ATTUNEMENT_GATE,
    clamp_state,
    density_envelope,
    filter_freq_for_brightness,
    harmony_gain_scale,
    melody_walk,
    pan_for_orbit,
    progression_family,
    riser_gain_scale,
    state_fingerprint,
    voice_lead,
)

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


_M64 = (1 << 64) - 1

# Adaptive stream domain-separates from the static composer: same seed,
# different purpose, different stream. Decisions on this path use only the
# Rng and integer/rational arithmetic - never rng.normal() and never
# math.sin/cos - so the decision path stays bit-exact across the
# Python/C#/TypeScript mirrors. Frequencies use 2 ** (semis / 12), the
# same as the static composer.
_ADAPTIVE_XOR = 0xADA971C


class AdaptiveComposer:
    """V8 adaptive composer: Python's harmony + song layers, driven by the
    game-state vector ``{"energy", "tension", "attunement", "brightness",
    "tempo"}``.

    Layer model (from the V8 design, §4.2):
      - harmony (Python chords + bass): enters when energy > 0.15
      - song (Python melody): enters when attunement > 40
      - air (sparkle pings): enters when brightness > 0.5, orbit widens
        with attunement
      - risers: rise with tension past 0.5
      - sub pulse: deepens as tension rises
      - gust bed: present at low energy
      - pluck accents: join at high energy
    Density follows energy throughout. The tempo state value multiplies
    the base bpm. Same seed + same state = the same score, bit-exact.
    """
    language_tag = "Python"

    def compose_adaptive(self, seed: int, bars: int = 4, bpm: float = 96.0,
                         state: dict = None) -> dict:
        st = clamp_state(state)
        fp = state_fingerprint(st)
        rng = Rng((seed ^ _ADAPTIVE_XOR ^ fp) & _M64)

        prog = progression_family(rng)
        bpm_eff = bpm * st["tempo"]
        beat = 60.0 / bpm_eff
        bar = beat * 4
        events = []

        energy = st["energy"]
        tension = st["tension"]
        attunement = st["attunement"]
        brightness = st["brightness"]

        harm_on = energy > HARMONY_ENERGY_GATE
        song_on = attunement > SONG_ATTUNEMENT_GATE
        air_on = brightness > AIR_BRIGHTNESS_GATE
        harm_w = harmony_gain_scale(energy)
        ff = round(filter_freq_for_brightness(brightness), 1)

        # --- Harmony: chord pads, one per bar (Python chords + bass) ---
        if harm_on:
            prev_semi = prog[0]
            for b in range(bars):
                root = prog[b % len(prog)]
                t = b * bar
                lead_tone = voice_lead(rng, prev_semi, (root, root + 3, root + 7))
                prev_semi = lead_tone
                for semis in (root, root + 3, root + 7):
                    events.append({
                        "t": round(t, 4), "dur": round(bar * 0.9, 4),
                        "freq": round(_freq(110.0, semis), 2),
                        "kind": "pad", "gain": round(0.10 * harm_w, 4),
                        "filterFreq": ff,
                        "reverbSend": round(0.2 + 0.6 * brightness, 4),
                    })
                # Bass root, quarter notes; sub pulse deepens with tension.
                for q in range(4):
                    tq = t + q * beat
                    events.append({
                        "t": round(tq, 4), "dur": round(beat * 0.42, 4),
                        "freq": round(_freq(55.0, root), 2),
                        "kind": "bass",
                        "gain": round(0.12 * harm_w + 0.06 * tension, 4),
                    })
            # Sub pulse: one clean low voice anchoring the tension layer.
            if tension > 0.35:
                for b in range(bars):
                    root = prog[b % len(prog)]
                    events.append({
                        "t": round(b * bar, 4), "dur": round(bar * 0.45, 4),
                        "freq": round(_freq(41.25, root), 2),
                        "kind": "bass",
                        "gain": round(0.05 + 0.15 * tension, 4),
                        "attack": round(bar * 0.1, 4),
                    })

        # --- Song: sparse pentatonic melody, calls toward the gate ---
        if song_on:
            dens = density_envelope(energy, 0.5)
            degree = 3
            for b in range(bars):
                root = prog[b % len(prog)]
                walk = melody_walk(rng, degree, 8, MINOR_PENTA, dens)
                for eighth, deg in walk:
                    if deg is None:
                        continue  # rest
                    degree = deg
                    t = b * bar + eighth * beat / 2
                    events.append({
                        "t": round(t, 4), "dur": round(beat * 0.45, 4),
                        "freq": round(_freq(220.0, root + MINOR_PENTA[degree]), 2),
                        "kind": "tone", "gain": round(0.10 + 0.10 * energy, 4),
                        "pan": pan_for_orbit(rng, attunement),
                        "reverbSend": round(0.3 + 0.5 * brightness, 4),
                    })

        # --- Air: sparkle pings; the orbit widens with attunement ---
        if air_on:
            n_pings = int(2 + 6 * brightness)
            for i in range(n_pings):
                t = rng.uniform(0.0, bars * bar)
                root = prog[rng.next_u64() % len(prog)]
                semis = root + 12 + MINOR_PENTA[rng.next_u64() % len(MINOR_PENTA)]
                events.append({
                    "t": round(t, 4), "dur": round(beat * 0.6, 4),
                    "freq": round(_freq(220.0, semis), 2),
                    "kind": "ping", "gain": round(0.06 + 0.08 * brightness, 4),
                    "pan": pan_for_orbit(rng, attunement),
                    "filterFreq": ff,
                    "reverbSend": round(0.5 + 0.5 * brightness, 4),
                    "decay": round(beat * 0.6, 4),
                })

        # --- Risers: tension crests at each bar boundary ---
        rw = riser_gain_scale(tension)
        if rw > 0.0:
            for b in range(bars):
                t = b * bar
                events.append({
                    "t": round(t, 4), "dur": round(bar * 0.95, 4),
                    "freq": round(_freq(110.0, prog[b % len(prog)]), 2),
                    "kind": "riser", "gain": round(0.12 * rw, 4),
                    "attack": round(bar * 0.85, 4),
                    "filterFreq": ff,
                    "reverbSend": round(0.4 * rw, 4),
                })

        # --- Gust bed at low energy: the world breathes before it moves ---
        if energy < 0.3:
            for b in range(0, bars, 2):
                events.append({
                    "t": round(b * bar, 4), "dur": round(bar * 1.8, 4),
                    "freq": round(_freq(220.0, prog[b % len(prog)] - 12), 2),
                    "kind": "gust", "gain": round(0.05 + 0.05 * (0.3 - energy), 4),
                    "attack": round(bar * 0.6, 4),
                    "reverbSend": 0.8,
                })

        # --- Pluck accents at high energy ---
        if energy > 0.6:
            for b in range(bars):
                root = prog[b % len(prog)]
                for eighth in range(8):
                    if rng.uniform() < density_envelope(energy, eighth / 8.0) * 0.5:
                        t = b * bar + eighth * beat / 2
                        semis = root + MINOR_PENTA[rng.next_u64() % len(MINOR_PENTA)]
                        events.append({
                            "t": round(t, 4), "dur": round(beat * 0.35, 4),
                            "freq": round(_freq(440.0, semis), 2),
                            "kind": "pluck", "gain": round(0.08 + 0.08 * energy, 4),
                            "decay": round(beat * 0.35, 4),
                            "pan": pan_for_orbit(rng, attunement * 0.5),
                        })

        events.sort(key=lambda e: e["t"])
        return {
            "generator": "xrgen.audio.AdaptiveComposer",
            "language": self.language_tag,
            "seed": seed,
            "loop_dur": round(bars * bar, 4),
            "events": events,
        }
