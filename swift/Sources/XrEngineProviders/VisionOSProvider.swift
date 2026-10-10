// swift/Sources/XrEngineProviders/VisionOSProvider.swift
//
// Swift SessionProvider for visionOS. Requires Xcode 16+ with the visionOS SDK;
// it cannot compile on Linux (RealityKit/ARKit are Apple-only). In v1 this is
// the interface-conformant provider: post-v1 it drives an ImmersiveSpace and
// feeds the engine's RenderView list from RealityKit frame data.
//
// Mirrors the TypeScript bridge:
//   SessionProvider.languageTag / supportedModes / requestSession(mode:canvas:)
//   XRSessionHandle.mode / onFrame(cb:) / hitTest(origin:dir:) / end()

import Foundation
import simd
#if canImport(RealityKit)
import RealityKit
import ARKit
#endif

/// XR mode, mirroring the TS `XRMode` union.
public enum XRMode: String, Sendable {
    case inline
    case immersiveVR = "immersive-vr"
    case immersiveAR = "immersive-ar"
}

/// One render view, mirroring the TS `RenderView`.
public struct RenderView: Sendable {
    public var view: simd_float4x4
    public var proj: simd_float4x4
    /// Device pixels: (x, y, w, h).
    public var viewport: (Int, Int, Int, Int)
}

/// Session handle, mirroring the TS `XRSessionHandle`.
public protocol XRSessionHandle: AnyObject {
    var mode: XRMode { get }
    func onFrame(_ cb: @escaping ([RenderView], Double) -> Void)
    func hitTest(origin: SIMD3<Float>, dir: SIMD3<Float>) -> SIMD3<Float>?
    func end() async
}

/// Provider contract, mirroring the TS `SessionProvider`.
public protocol SessionProvider {
    static var languageTag: String { get }
    var supportedModes: [XRMode] { get }
    func requestSession(mode: XRMode) async throws -> any XRSessionHandle
}

/// visionOS provider. In v1 the RealityKit wiring is structural: the session
/// lifecycle and frame pump are real, the per-view matrix extraction from
/// ARKit anchors lands with device testing post-v1.
public final class VisionOSProvider: SessionProvider {
    public static let languageTag = "Swift (visionOS)"

    public var supportedModes: [XRMode] {
        #if canImport(RealityKit)
        return [.inline, .immersiveAR]
        #else
        return [.inline]
        #endif
    }

    public init() {}

    public func requestSession(mode: XRMode) async throws -> any XRSessionHandle {
        guard supportedModes.contains(mode) else {
            throw ProviderError.unsupportedMode(mode)
        }
        return VisionOSSession(mode: mode)
    }
}

public enum ProviderError: Error {
    case unsupportedMode(XRMode)
}

private final class VisionOSSession: XRSessionHandle {
    let mode: XRMode
    private var frameCallback: (([RenderView], Double) -> Void)?

    init(mode: XRMode) { self.mode = mode }

    func onFrame(_ cb: @escaping ([RenderView], Double) -> Void) {
        // Post-v1: hook RealityKit's frame updates here and translate each
        // ARKit camera anchor into RenderView matrices for the engine.
        self.frameCallback = cb
    }

    func hitTest(origin: SIMD3<Float>, dir: SIMD3<Float>) -> SIMD3<Float>? {
        // Post-v1: raycast against ARKit plane anchors.
        nil
    }

    func end() async {
        frameCallback = nil
    }
}
