// kotlin/src/main/kotlin/engine/xr/XrProvider.kt
//
// Kotlin SessionProvider for Android XR. Pure Kotlin/JVM in v1 (no Android SDK
// dependency), so the contract compiles anywhere with kotlinc; device wiring
// against the OpenXR mobile loader lands post-v1 with on-device testing.
//
// Mirrors the TypeScript bridge:
//   SessionProvider.languageTag / supportedModes / requestSession(mode)
//   XRSessionHandle.mode / onFrame(cb) / hitTest(origin, dir) / end()

package engine.xr

/** XR mode, mirroring the TS `XRMode` union. */
enum class XRMode(val id: String) {
    INLINE("inline"),
    IMMERSIVE_VR("immersive-vr"),
    IMMERSIVE_AR("immersive-ar");
}

/** One render view, mirroring the TS `RenderView`. */
data class RenderView(
    val view: FloatArray,          // 4x4 column-major view matrix
    val proj: FloatArray,          // 4x4 column-major projection matrix
    val viewport: IntArray,        // device px: x, y, w, h
) {
    override fun equals(other: Any?): Boolean = super.equals(other)
    override fun hashCode(): Int = super.hashCode()
}

/** 3D vector. */
data class Vec3(val x: Float, val y: Float, val z: Float)

/** Session handle, mirroring the TS `XRSessionHandle`. */
interface XRSessionHandle {
    val mode: XRMode
    fun onFrame(cb: (views: List<RenderView>, timeSeconds: Double) -> Unit)
    fun hitTest(origin: Vec3, dir: Vec3): Vec3?
    suspend fun end()
}

/** Provider contract, mirroring the TS `SessionProvider`. */
interface SessionProvider {
    val languageTag: String
    val supportedModes: List<XRMode>
    suspend fun requestSession(mode: XRMode): XRSessionHandle
}

class UnsupportedModeException(mode: XRMode) :
    IllegalArgumentException("Mode not supported: ${mode.id}")

/**
 * Android XR provider. In v1 the OpenXR wiring is structural: the session
 * lifecycle is real, view-matrix extraction from XrFrame lands with device
 * testing post-v1.
 */
class AndroidXRProvider : SessionProvider {
    override val languageTag: String = "Kotlin (Android XR)"

    // v1: inline always; immersive modes light up once the OpenXR mobile
    // loader is linked and a headset is present.
    override val supportedModes: List<XRMode> = listOf(XRMode.INLINE)

    override suspend fun requestSession(mode: XRMode): XRSessionHandle {
        if (mode !in supportedModes) throw UnsupportedModeException(mode)
        return AndroidXRSession(mode)
    }
}

private class AndroidXRSession(override val mode: XRMode) : XRSessionHandle {
    private var frameCallback: ((List<RenderView>, Double) -> Unit)? = null

    override fun onFrame(cb: (views: List<RenderView>, timeSeconds: Double) -> Unit) {
        // Post-v1: pump the OpenXR frame loop here and translate each
        // XrView into RenderView matrices for the engine.
        frameCallback = cb
    }

    override fun hitTest(origin: Vec3, dir: Vec3): Vec3? {
        // Post-v1: raycast against OpenXR plane/trackable anchors.
        return null
    }

    override suspend fun end() {
        frameCallback = null
    }
}
