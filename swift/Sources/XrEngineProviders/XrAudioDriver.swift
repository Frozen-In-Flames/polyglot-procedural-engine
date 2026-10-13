// swift/Sources/XrEngineProviders/XrAudioDriver.swift
//
// Swift audio driver for the engine's polyglot audio. Same role contract as
// the other languages: given a seed, compose a score in the shared format
// (t/dur/freq/kind/gain events, camelCase JSON). Swift's layer is a spatial
// sparkle: high pentatonic pings with per-event pan, meant to move around
// the listener in visionOS via AVAudioEnvironmentNode post-v1.
//
// Requires Xcode 16+ to compile (Foundation only here, so the contract is
// checkable with swiftc where available); device audio wiring lands post-v1.

import Foundation

/// One score event. Field names match the shared schema exactly.
public struct XrAudioEvent: Codable, Sendable {
    public var t: Double
    public var dur: Double
    public var freq: Double
    public var kind: String
    public var gain: Double
    public var pan: Double  // -1 left … 1 right; Swift-only extension, ignored by other renderers
    // Score schema v1.1 optional fields (additive; nils are omitted from JSON).
    public var attack: Double?
    public var decay: Double?
    public var filterFreq: Double?
    public var reverbSend: Double?

    public init(t: Double, dur: Double, freq: Double, kind: String, gain: Double, pan: Double = 0,
                attack: Double? = nil, decay: Double? = nil, filterFreq: Double? = nil, reverbSend: Double? = nil) {
        self.t = t; self.dur = dur; self.freq = freq
        self.kind = kind; self.gain = gain; self.pan = pan
        self.attack = attack; self.decay = decay
        self.filterFreq = filterFreq; self.reverbSend = reverbSend
    }
}

/// The V8 adaptive state vector (see docs/V8-AUDIO.md §4.1).
/// Language-agnostic: every language's adaptive composer takes the same vector.
public struct XrAudioState: Codable, Sendable {
    public var energy: Double      // 0..1
    public var tension: Double     // 0..1
    public var attunement: Double  // 0..100
    public var brightness: Double  // 0..1
    public var tempo: Double       // 0.5..2.0 multiplier on the base bpm

    public init(energy: Double = 0.5, tension: Double = 0, attunement: Double = 0,
                brightness: Double = 0.5, tempo: Double = 1.0) {
        self.energy = energy; self.tension = tension; self.attunement = attunement
        self.brightness = brightness; self.tempo = tempo
    }

    public static var `default`: XrAudioState { XrAudioState() }

    /// Range-clamped copy; out-of-range inputs can never break the mix.
    public func clamped() -> XrAudioState {
        XrAudioState(
            energy: min(1, max(0, energy)),
            tension: min(1, max(0, tension)),
            attunement: min(100, max(0, attunement)),
            brightness: min(1, max(0, brightness)),
            tempo: min(2.0, max(0.5, tempo))
        )
    }
}

/// The audio driver contract every language implements.
public protocol XrAudioDriver: Sendable {
    var languageTag: String { get }
    func compose(seed: UInt32, bars: Int, bpm: Double) -> [XrAudioEvent]
    func loopDur(bars: Int, bpm: Double) -> Double
}

/// V8 additive extension: adaptive composition. The default implementation
/// falls back to the static compose, so drivers written before V8 keep
/// satisfying the contract without changes.
public extension XrAudioDriver {
    func composeAdaptive(seed: UInt32, bpm: Double, state: XrAudioState) -> [XrAudioEvent] {
        compose(seed: seed, bars: 4, bpm: bpm)
    }
}

/// Swift's voice: seeded pentatonic sparkle pings with drifting pan.
public struct VisionAudioDriver: XrAudioDriver {
    public let languageTag = "Swift"
    public init() {}

    public func loopDur(bars: Int, bpm: Double) -> Double {
        Double(bars) * (60.0 / bpm) * 4.0
    }

    public func compose(seed: UInt32, bars: Int = 4, bpm: Double = 96.0) -> [XrAudioEvent] {
        var rng = SplitMix64(seed: UInt64(seed) ^ 0x5A1F7)
        let penta = [0, 3, 5, 7, 10, 12, 15, 19, 24]
        let beat = 60.0 / bpm
        var events: [XrAudioEvent] = []
        var degree = 4
        for b in 0..<bars {
            for s in 0..<16 {
                let t = Double(b) * beat * 4 + Double(s) * beat / 4
                if rng.nextDouble() < 0.45 { continue }  // airy rests
                degree += [-2, -1, 1, 2][Int(rng.next() % 4)]
                degree = max(0, min(penta.count - 1, degree))
                let freq = 880.0 * pow(2.0, Double(penta[degree]) / 12.0)
                // Pan drifts with a slow seeded LFO so pings orbit the listener.
                let pan = sin(Double(seed) * 0.01 + t * 0.7)
                events.append(XrAudioEvent(
                    t: (t * 10000).rounded() / 10000,
                    dur: (beat * 0.3 * 10000).rounded() / 10000,
                    freq: (freq * 100).rounded() / 100,
                    kind: "tone",
                    gain: 0.07,
                    pan: (pan * 100).rounded() / 100
                ))
            }
        }
        return events.sorted { $0.t < $1.t }
    }

    /// V8 adaptive composition: Swift's sparkle voice steered by the state
    /// vector. The pan orbit widens with attunement — narrow (±0.15) when the
    /// listener is unaligned, full-circle (±1.0) at resonance — so the space
    /// is *heard* opening up. Ping density follows brightness: sparse at
    /// low brightness, a full shower at high. Tempo multiplies the base bpm.
    /// Seeded and deterministic per (seed, state). Zero asset dependence:
    /// every ping is math, never a sample.
    public func composeAdaptive(seed: UInt32, bpm: Double, state: XrAudioState) -> [XrAudioEvent] {
        let s = state.clamped()
        let bpmEff = bpm * s.tempo
        var rng = SplitMix64(seed: UInt64(seed) ^ 0x5A1F7 ^ 0xADA97E)
        let penta = [0, 3, 5, 7, 10, 12, 15, 19, 24]
        let beat = 60.0 / bpmEff
        let keepProb = 0.15 + 0.85 * s.brightness   // density follows brightness
        let panWidth = 0.15 + 0.85 * (s.attunement / 100.0)  // orbit widens with attunement
        var events: [XrAudioEvent] = []
        var degree = 4
        for b in 0..<4 {
            for i in 0..<16 {
                let t = Double(b) * beat * 4 + Double(i) * beat / 4
                if rng.nextDouble() >= keepProb { continue }  // thinned by brightness
                degree += [-2, -1, 1, 2][Int(rng.next() % 4)]
                degree = max(0, min(penta.count - 1, degree))
                let freq = 880.0 * pow(2.0, Double(penta[degree]) / 12.0)
                let pan = panWidth * sin(Double(seed) * 0.01 + t * 0.7)
                events.append(XrAudioEvent(
                    t: (t * 10000).rounded() / 10000,
                    dur: (beat * 0.3 * 10000).rounded() / 10000,
                    freq: (freq * 100).rounded() / 100,
                    kind: "ping",   // score schema v1.1 kind
                    gain: 0.07,
                    pan: (pan * 100).rounded() / 100,
                    reverbSend: (s.attunement / 100.0 * 100).rounded() / 100
                ))
            }
        }
        return events.sorted { $0.t < $1.t }
    }
}

/// SplitMix64 — deterministic on every platform.
private struct SplitMix64 {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
    mutating func nextDouble() -> Double {
        Double(next() >> 11) / Double(1 << 53)
    }
}
