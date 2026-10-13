"""score.py — the arrangement library for V8 adaptive composition.

Pure functions of (rng, params): progression families, voice-leading
helpers, density curves, state quantization. Standard library only —
this sits on the runtime path, so no numpy, no scipy, no transcendentals
on the decision path (the composition decisions must stay bit-exact
across the Python/C#/TypeScript mirrors; only freqs may use
``2 ** (semis / 12)``, matching the existing composer).

Zero asset dependence: every arrangement choice is seeded math; there
are no samples, tables, or recordings anywhere in this module.
"""
from .rng import Rng

_M64 = (1 << 64) - 1

# Progression families, as semitone offsets from the key root (one chord
# per bar, four-bar cycles). Entries are roots relative to the root.
PROGRESSION_FAMILIES = [
    [0, -4, -2, 3],    # Am F G C
    [0, 0, -4, -2],    # Am Am F G
    [-4, -2, 0, 3],    # F G Am C
    [0, 3, -4, -2],    # Am C F G
    [-2, 0, 3, -4],    # G Am C F
    [0, -7, -4, 3],    # Am Em F C
]

MINOR_PENTA = [0, 3, 5, 7, 10, 12, 15]  # minor pentatonic, semitones

# First Light attunement thresholds (six levels). These MUST match the game's
# ATTUNE_LEVELS in games/first-light/shared.ts — the heard levels stay in
# sync with the game's level-ups. (The V8 design doc's 15/30/45/60/75/90 was
# wrong; the game is the source of truth.)
ATTUNEMENT_THRESHOLDS = (12, 28, 44, 60, 74, 88)

# Layer entry gates from the V8 layer model.
HARMONY_ENERGY_GATE = 0.15   # harmony (Python chords + bass) enters
MOTION_ENERGY_GATE = 0.40    # motion density is full above this
AIR_BRIGHTNESS_GATE = 0.50   # air (sparkle pings) enters
SONG_ATTUNEMENT_GATE = 40    # song (Python melody) enters

_STATE_DEFAULTS = {
    "energy": 0.5,
    "tension": 0.2,
    "attunement": 20.0,
    "brightness": 0.5,
    "tempo": 1.0,
}
_STATE_BOUNDS = {
    "energy": (0.0, 1.0),
    "tension": (0.0, 1.0),
    "attunement": (0.0, 100.0),
    "brightness": (0.0, 1.0),
    "tempo": (0.5, 2.0),
}


def clamp_state(state) -> dict:
    """Clamp a state vector into its documented ranges, filling defaults."""
    state = dict(_STATE_DEFAULTS) if state is None else dict(state)
    out = {}
    for key, default in _STATE_DEFAULTS.items():
        lo, hi = _STATE_BOUNDS[key]
        try:
            v = float(state.get(key, default))
        except (TypeError, ValueError):
            v = default
        out[key] = lo if v < lo else hi if v > hi else v
    return out


def _quantize(v: float, lo: float, hi: float, steps: int) -> int:
    return int(round((v - lo) / (hi - lo) * steps))


def state_fingerprint(state) -> int:
    """Deterministic u64 fingerprint of a clamped state vector.

    Integer arithmetic only — no floats, no transcendentals — so the same
    state always folds into the same seed bits on every platform.
    """
    st = clamp_state(state)
    qs = [
        _quantize(st["energy"], 0.0, 1.0, 65535),
        _quantize(st["tension"], 0.0, 1.0, 65535),
        _quantize(st["attunement"], 0.0, 100.0, 10000),
        _quantize(st["brightness"], 0.0, 1.0, 65535),
        _quantize(st["tempo"], 0.5, 2.0, 3000),
    ]
    h = 0x9E3779B97F4A7C15
    for q in qs:
        h = ((h ^ q) * 0xBF58476D1CE4E5B9) & _M64
    # SplitMix64-style finalizer, integer ops only.
    h ^= h >> 30
    h = (h * 0xBF58476D1CE4E5B9) & _M64
    h ^= h >> 27
    h = (h * 0x94D049BB133111EB) & _M64
    return h ^ (h >> 31)


def progression_family(rng: Rng):
    """Pick one progression family (list of four bar roots, semitones)."""
    return PROGRESSION_FAMILIES[rng.next_u64() % len(PROGRESSION_FAMILIES)]


def attunement_level(attunement: float) -> int:
    """First Light attunement level 0..6 from the six thresholds."""
    level = 0
    for thr in ATTUNEMENT_THRESHOLDS:
        if attunement >= thr:
            level += 1
    return level


def note_density(energy: float) -> float:
    """Base per-subdivision event probability; density follows energy."""
    energy = 0.0 if energy < 0.0 else 1.0 if energy > 1.0 else energy
    return 0.20 + 0.80 * energy


def density_envelope(energy: float, pos: float) -> float:
    """Density scaled by position-in-bar (pos in [0,1)); swells with energy.

    Linear only — no transcendentals on the decision path.
    """
    pos = 0.0 if pos < 0.0 else 1.0 if pos > 1.0 else pos
    return note_density(energy) * (0.60 + 0.40 * pos)


def harmony_gain_scale(energy: float) -> float:
    """Layer crossfade weight for harmony: 0 below the gate, 1 at full."""
    w = (energy - HARMONY_ENERGY_GATE) / (1.0 - HARMONY_ENERGY_GATE)
    return 0.0 if w < 0.0 else 1.0 if w > 1.0 else w


def voice_lead(rng: Rng, prev_semi: int, chord_tones) -> int:
    """Pick the chord tone closest to the previous voice (semitones).

    Ties break by seeded draw, so voice leading is smooth and
    deterministic per (seed, state).
    """
    tones = list(chord_tones)
    best = tones[0]
    best_d = abs(best - prev_semi)
    tied = [best]
    for tone in tones[1:]:
        d = abs(tone - prev_semi)
        if d < best_d:
            best, best_d, tied = tone, d, [tone]
        elif d == best_d:
            tied.append(tone)
    if len(tied) == 1:
        return tied[0]
    return tied[rng.next_u64() % len(tied)]


def melody_walk(rng: Rng, start_degree: int, steps: int, scale,
                density: float) -> list:
    """Seeded pentatonic walk with density-driven rests.

    Returns a list of ``(step_index, degree_or_None)``; ``None`` is a rest.
    Steps are integer semitone degrees into ``scale``.
    """
    out = []
    degree = start_degree
    lo, hi = 0, len(scale) - 1
    for i in range(steps):
        if rng.uniform() < density:
            move = [-2, -1, -1, 0, 1, 1, 2][rng.next_u64() % 7]
            degree += move
            degree = lo if degree < lo else hi if degree > hi else degree
            out.append((i, degree))
        else:
            out.append((i, None))
    return out


def filter_freq_for_brightness(brightness: float, base: float = 400.0,
                               span: float = 5600.0) -> float:
    """Spectral openness in Hz from brightness; linear, always positive."""
    b = 0.0 if brightness < 0.0 else 1.0 if brightness > 1.0 else brightness
    return base + span * b


def pan_for_orbit(rng: Rng, attunement: float) -> float:
    """Seeded stereo pan whose spread widens with attunement (the orbit)."""
    spread = attunement / 100.0  # 0..1
    return round(rng.uniform(-1.0, 1.0) * spread, 4)


def riser_gain_scale(tension: float) -> float:
    """Riser layer weight; rises linearly past the tension midpoint."""
    w = (tension - 0.5) * 2.0
    return 0.0 if w < 0.0 else 1.0 if w > 1.0 else w
