// XrEngine.Providers — C# audio composer.
//
// C#'s voice in the engine's polyglot audio: it composes the arp + hats
// score in the shared score format (same schema as python/xrgen/audio.py).
// Python writes chords/melody/bass; C# writes the sparkling top layer.
// Any language's renderer can play the result; the demo's ScorePlayer does.
using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace XrEngine.Providers;

/// <summary>One score event. Schema matches the Python composer exactly.
/// V8 (score schema v1.1): the optional attack/decay/filterFreq/reverbSend
/// fields are additive — old renderers ignore them, old documents omit them.
/// Zero asset dependence: every value here is seeded math, never a sample.</summary>
public sealed class ScoreEvent
{
    public double T { get; set; }
    public double Dur { get; set; }
    public double Freq { get; set; }
    public string Kind { get; set; } = "tone";
    public double Gain { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? Attack { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? Decay { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? FilterFreq { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? ReverbSend { get; set; }
}

/// <summary>A loopable score document in the engine's shared format.</summary>
public sealed class ScoreDoc
{
    public string Generator { get; set; } = "XrEngine.Providers.ScoreComposer";
    public string Language { get; set; } = "C#";
    public int Seed { get; set; }
    public double LoopDur { get; set; }
    public List<ScoreEvent> Events { get; set; } = new();
    public string? Regenerate { get; set; }
}

/// <summary>The V8 adaptive state vector (see docs/V8-AUDIO.md §4.1).
/// Language-agnostic: every language's composeAdaptive takes the same vector.</summary>
public sealed class AudioState
{
    /// <summary>Scene intensity, 0..1.</summary>
    public double Energy { get; set; } = 0.5;
    /// <summary>Danger / unresolvedness, 0..1.</summary>
    public double Tension { get; set; } = 0.0;
    /// <summary>Hidden attunement score, 0..100.</summary>
    public double Attunement { get; set; } = 0.0;
    /// <summary>Spectral openness the game wants, 0..1.</summary>
    public double Brightness { get; set; } = 0.5;
    /// <summary>Multiplier on the base bpm, 0.5..2.0.</summary>
    public double Tempo { get; set; } = 1.0;

    public static AudioState Default => new AudioState();

    internal (double Energy, double Tension, double Attunement, double Brightness, double Tempo) Clamped()
    {
        static double C(double v, double lo, double hi) => v < lo ? lo : v > hi ? hi : v;
        return (C(Energy, 0, 1), C(Tension, 0, 1), C(Attunement, 0, 100), C(Brightness, 0, 1), C(Tempo, 0.5, 2.0));
    }
}

/// <summary>Composes the arp + hats layer. Deterministic per seed.</summary>
public sealed class ScoreComposer
{
    public string LanguageTag => "C#";

    // SplitMix64: deterministic on every platform, no System.Random drift.
    private ulong _state;
    private ulong NextU64()
    {
        _state += 0x9E3779B97F4A7C15ul;
        ulong z = _state;
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ul;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBul;
        return z ^ (z >> 31);
    }
    private double NextDouble() => (NextU64() >> 11) / (double)(1ul << 53);

    private static double Freq(double bas, int semis) => bas * Math.Pow(2.0, semis / 12.0);

    public ScoreDoc Compose(int seed, int bars = 4, double bpm = 96.0)
    {
        _state = (ulong)(uint)seed ^ 0xC5A4;
        // Same progression family as the Python composer so layers harmonize.
        int[][] progressions = {
            new[] { 0, -4, -2, 3 },
            new[] { 0, 0, -4, -2 },
        };
        var prog = progressions[NextU64() % 2];
        double beat = 60.0 / bpm, bar = beat * 4;
        var events = new List<ScoreEvent>();

        // Arp: 16ths cycling root-third-fifth-octave, two octaves up.
        int[] arpShape = { 0, 3, 7, 12, 7, 3 };
        for (int b = 0; b < bars; b++)
        {
            int root = prog[b % prog.Length];
            for (int s = 0; s < 16; s++)
            {
                double t = b * bar + s * beat / 4;
                int semis = root + arpShape[(s + b) % arpShape.Length];
                events.Add(new ScoreEvent
                {
                    T = Math.Round(t, 4),
                    Dur = Math.Round(beat * 0.22, 4),
                    Freq = Math.Round(Freq(440.0, semis), 2),
                    Kind = "tone",
                    Gain = 0.08,
                });
            }
        }

        // Hats: 8th-note noise ticks, seeded accents.
        for (int b = 0; b < bars; b++)
        {
            for (int e = 0; e < 8; e++)
            {
                double t = b * bar + e * beat / 2;
                bool accent = NextDouble() < 0.3;
                events.Add(new ScoreEvent
                {
                    T = Math.Round(t, 4),
                    Dur = 0.05,
                    Freq = 6000,
                    Kind = "noise",
                    Gain = accent ? 0.10 : 0.05,
                });
            }
        }

        events.Sort((a, b) => a.T.CompareTo(b.T));
        return new ScoreDoc
        {
            Seed = seed,
            LoopDur = Math.Round(bars * bar, 4),
            Events = events,
        };
    }

    /// <summary>
    /// V8 adaptive composition: C#'s voice (arp + hats) steered by the state
    /// vector. Hats thin out at low energy — each 8th-note slot is kept with
    /// probability = energy, so density follows energy. The arp climbs
    /// octaves with brightness: +0..2 octaves on top of its base shape.
    /// Tempo multiplies the base bpm. Seeded and deterministic per
    /// (seed, state); the base Compose(seed, bars, bpm) is unchanged.
    /// Zero asset dependence: notes and hats are math, never samples.
    /// </summary>
    public ScoreDoc ComposeAdaptive(int seed, int bars, double bpm, AudioState? state)
    {
        state ??= AudioState.Default;
        var (energy, tension, attunement, brightness, tempo) = state.Clamped();
        double bpmEff = bpm * tempo;

        // Distinct stream from Compose so the adaptive layer is its own voice.
        _state = (ulong)(uint)seed ^ 0xC5A4 ^ 0xADA9;
        int[][] progressions = {
            new[] { 0, -4, -2, 3 },
            new[] { 0, 0, -4, -2 },
        };
        var prog = progressions[NextU64() % 2];
        double beat = 60.0 / bpmEff, bar = beat * 4;
        var events = new List<ScoreEvent>();

        // Arp: same 16th shape as Compose, lifted by whole octaves with brightness.
        int octaveLift = (int)Math.Floor(brightness * 2.999) * 12; // 0, 12, or 24 semitones
        int[] arpShape = { 0, 3, 7, 12, 7, 3 };
        for (int b = 0; b < bars; b++)
        {
            int root = prog[b % prog.Length];
            for (int s = 0; s < 16; s++)
            {
                double t = b * bar + s * beat / 4;
                int semis = root + octaveLift + arpShape[(s + b) % arpShape.Length];
                events.Add(new ScoreEvent
                {
                    T = Math.Round(t, 4),
                    Dur = Math.Round(beat * 0.22, 4),
                    Freq = Math.Round(Freq(440.0, semis), 2),
                    Kind = "tone",
                    Gain = 0.08,
                    ReverbSend = Math.Round(brightness, 3),
                });
            }
        }

        // Hats: density follows energy — each 8th slot kept with p = energy.
        for (int b = 0; b < bars; b++)
        {
            for (int e = 0; e < 8; e++)
            {
                if (NextDouble() >= energy) continue; // thinned out
                double t = b * bar + e * beat / 2;
                bool accent = NextDouble() < 0.3;
                events.Add(new ScoreEvent
                {
                    T = Math.Round(t, 4),
                    Dur = 0.05,
                    Freq = 6000,
                    Kind = "noise",
                    Gain = accent ? 0.10 : 0.05,
                });
            }
        }

        events.Sort((a, b) => a.T.CompareTo(b.T));
        return new ScoreDoc
        {
            Seed = seed,
            LoopDur = Math.Round(bars * bar, 4),
            Events = events,
            Regenerate = $"composeAdaptive({seed},{bars},{bpm}) energy={energy:F2} brightness={brightness:F2} tempo={tempo:F2}",
        };
    }

    public string ComposeJson(int seed, int bars = 4, double bpm = 96.0) =>
        JsonSerializer.Serialize(Compose(seed, bars, bpm), new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = true,
        });
}
