// kotlin/src/main/kotlin/engine/xr/XrAudioDriver.kt
//
// Kotlin audio driver for the engine's polyglot audio. Same role contract as
// the other languages: given a seed, compose a score in the shared format
// (t/dur/freq/kind/gain events, camelCase JSON). Kotlin's layer is a deep
// sub pulse: slow sine drops on the bar with a seeded wobble, built for
// Android XR's low-end where one clean voice beats ten thin ones.
//
// Pure Kotlin/JVM in v1 (no Android SDK dependency), so the contract compiles
// anywhere with kotlinc; on-device rendering via Oboe lands post-v1.

package engine.xr

/** One score event. Field names match the shared schema exactly. */
data class XrAudioEvent(
    val t: Double,
    val dur: Double,
    val freq: Double,
    val kind: String,   // "tone" | "pad" | "bass" | "noise" (+ v1.1: pluck | ping | riser | gust | granular)
    val gain: Double,
    // Score schema v1.1 optional fields (additive; nulls are omitted by JSON encoders).
    val attack: Double? = null,
    val decay: Double? = null,
    val filterFreq: Double? = null,
    val reverbSend: Double? = null,
)

/** The V8 adaptive state vector (see docs/V8-AUDIO.md §4.1).
 *  Language-agnostic: every language's adaptive composer takes the same vector. */
data class XrAudioState(
    val energy: Double = 0.5,      // 0..1
    val tension: Double = 0.0,     // 0..1
    val attunement: Double = 0.0,  // 0..100
    val brightness: Double = 0.5,  // 0..1
    val tempo: Double = 1.0,       // 0.5..2.0 multiplier on the base bpm
) {
    companion object { val DEFAULT = XrAudioState() }

    /** Range-clamped copy; out-of-range inputs can never break the mix. */
    fun clamped() = XrAudioState(
        energy = energy.coerceIn(0.0, 1.0),
        tension = tension.coerceIn(0.0, 1.0),
        attunement = attunement.coerceIn(0.0, 100.0),
        brightness = brightness.coerceIn(0.0, 1.0),
        tempo = tempo.coerceIn(0.5, 2.0),
    )
}

/** The audio driver contract every language implements. */
interface XrAudioDriver {
    val languageTag: String
    fun compose(seed: Int, bars: Int = 4, bpm: Double = 96.0): List<XrAudioEvent>
    fun loopDur(bars: Int = 4, bpm: Double = 96.0): Double

    /** V8 additive method: adaptive composition. The default implementation
     *  falls back to the static compose, so drivers written before V8 keep
     *  satisfying the contract without changes. */
    fun composeAdaptive(
        seed: Int,
        bars: Int = 4,
        bpm: Double = 96.0,
        state: XrAudioState = XrAudioState.DEFAULT,
    ): List<XrAudioEvent> = compose(seed, bars, bpm)
}

/** SplitMix64 — deterministic on every platform. */
private class SplitMix64(seed: Long) {
    private var state: Long = seed
    fun next(): Long {
        state += -0x61c8864680b583ebL // 0x9E3779B97F4A7C15 as signed
        var z = state
        z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L // 0xBF58476D1CE4E5B9
        z = (z xor (z ushr 27)) * 0x94d049bb133111ebL
        return z xor (z ushr 31)
    }
    fun nextDouble(): Double = (next() ushr 11).toULong().toDouble() / (1L shl 53).toDouble()
}

/** Kotlin's voice: deep sub pulse, one drop per bar with seeded wobble. */
class AndroidXrAudioDriver : XrAudioDriver {
    override val languageTag = "Kotlin"

    override fun loopDur(bars: Int, bpm: Double) = bars * (60.0 / bpm) * 4.0

    override fun compose(seed: Int, bars: Int, bpm: Double): List<XrAudioEvent> {
        val rng = SplitMix64(seed.toLong() xor 0xB0771L)
        val beat = 60.0 / bpm
        val roots = listOf(0, -4, -2, 3) // Am F G C, semitones from A1
        val events = mutableListOf<XrAudioEvent>()
        for (b in 0 until bars) {
            val root = roots[b % roots.size]
            val t = b * beat * 4
            val freq = 55.0 * Math.pow(2.0, root / 12.0)
            // The drop: long sub sine with a wobble whose rate is seeded.
            val wobble = 2.0 + rng.nextDouble() * 4.0
            events.add(XrAudioEvent(
                t = round4(t), dur = round4(beat * 3.5),
                freq = round2(freq), kind = "bass", gain = 0.16,
            ))
            // Wobble ticks marking the LFO, quiet.
            var wt = t
            while (wt < t + beat * 3.5) {
                events.add(XrAudioEvent(
                    t = round4(wt), dur = 0.06, freq = round2(freq * 2),
                    kind = "tone", gain = 0.05,
                ))
                wt += 1.0 / wobble
            }
        }
        return events.sortedBy { it.t }
    }

    /** V8 adaptive composition: Kotlin's sub pulse steered by the state vector.
     *  The pulse enters with tension — silent at zero, full voice at one —
     *  and its drop deepens as tension rises (lower root, longer tail).
     *  Tempo multiplies the base bpm. Seeded and deterministic per
     *  (seed, state); base compose is unchanged. Zero asset dependence:
     *  the drop is math, never a sample. */
    override fun composeAdaptive(
        seed: Int,
        bars: Int,
        bpm: Double,
        state: XrAudioState,
    ): List<XrAudioEvent> {
        val s = state.clamped()
        if (s.tension <= 0.001) return emptyList() // the pulse has not entered yet
        val rng = SplitMix64(seed.toLong() xor 0xB0771L xor 0xADA97EL)
        val bpmEff = bpm * s.tempo
        val beat = 60.0 / bpmEff
        val roots = listOf(0, -4, -2, 3) // Am F G C, semitones from A1
        val events = mutableListOf<XrAudioEvent>()
        for (b in 0 until bars) {
            val root = roots[b % roots.size]
            val t = b * beat * 4
            // The drop deepens as tension rises: root slides down, tail lengthens.
            val deep = 1.0 - 0.3 * s.tension
            val freq = 55.0 * Math.pow(2.0, root / 12.0) * deep
            val dropDur = beat * (3.0 + s.tension)
            events.add(XrAudioEvent(
                t = round4(t), dur = round4(dropDur),
                freq = round2(freq), kind = "bass",
                gain = round4(0.16 * s.tension), // enters with tension
                decay = round2(1.5 + 2.0 * s.tension),
            ))
            // Wobble ticks marking the LFO, riding with the pulse.
            val wobble = 2.0 + rng.nextDouble() * 4.0
            var wt = t
            while (wt < t + dropDur) {
                events.add(XrAudioEvent(
                    t = round4(wt), dur = 0.06, freq = round2(freq * 2),
                    kind = "tone", gain = round4(0.05 * s.tension),
                ))
                wt += 1.0 / wobble
            }
        }
        return events.sortedBy { it.t }
    }

    private fun round4(v: Double) = Math.round(v * 10000) / 10000.0
    private fun round2(v: Double) = Math.round(v * 100) / 100.0
}
