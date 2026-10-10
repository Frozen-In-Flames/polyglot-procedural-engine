// XrEngine.Providers — C# audio composer.
//
// C#'s voice in the engine's polyglot audio: it composes the arp + hats
// score in the shared score format (same schema as python/xrgen/audio.py).
// Python writes chords/melody/bass; C# writes the sparkling top layer.
// Any language's renderer can play the result; the demo's ScorePlayer does.
using System;
using System.Collections.Generic;
using System.Text.Json;

namespace XrEngine.Providers;

/// <summary>One score event. Schema matches the Python composer exactly.</summary>
public sealed class ScoreEvent
{
    public double T { get; set; }
    public double Dur { get; set; }
    public double Freq { get; set; }
    public string Kind { get; set; } = "tone";
    public double Gain { get; set; }
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

    public string ComposeJson(int seed, int bars = 4, double bpm = 96.0) =>
        JsonSerializer.Serialize(Compose(seed, bars, bpm), new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = true,
        });
}
