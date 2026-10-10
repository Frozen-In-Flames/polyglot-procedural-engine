# V3 Inverse Rendering: the foundry and the runtime

## The one rule

**Two-sided design.** The FOUNDRY runs once, offline, and may use DLSS
frames, a local GPU, or Colab. The RUNTIME (the engine, the end user) has
**zero** dependencies on NVIDIA, Google Colab, DLSS, or any ML framework.
Once the engine has the math, no more DLSS is required. Anything that
would make the player need NVIDIA or Google is a design violation.

## How it works

1. **Capture.** The engine renders its own scene plus G-buffers: per-pixel
   UV, view depth, world normals, and shading-without-albedo (the engine's
   own lighting equation evaluated with albedo = 1, so dividing by it is
   exact). See `Renderer.captureGBuffer()` in `src/render/renderer.ts`
   (foundry-only, flag-gated, needs `EXT_color_buffer_float`).
2. **Super-resolve.** The frame goes through DLSS or any reconstruction
   tech, or a plain high-res render. Linear space in, linear space out;
   `srgb_to_linear()` in `python/xrgen/inverse.py` handles sRGB inputs.
3. **Reproject.** `splat_to_uv()` lands each screen pixel in the asset's
   texture space, nearest-depth wins. The shading buffer is splatted with
   the same winner selection so the next step divides matching texels.
4. **Strip lighting.** `strip_lighting()`: albedo = observed / shading, in
   linear space. Near-black shading is flagged invalid, never divided.
5. **Distill.** `fit_material()` fits the engine's own procedural detail
   function to the recovered albedo by exact least squares (the model is
   linear in its weights). `fit_height_style()` reuses the style-MLP form
   the runtime already mirrors. Output is a plain JSON bundle.
6. **Run.** `loadDistillationBundle()` + `applyDistillationBundle()` in
   `src/bridge/distill.ts` turn the bundle into a `MaterialSpec` with the
   `distill` effect. The fragment shader evaluates the fitted detail from
   uniforms. No textures, no ML, no vendor SDKs.

## The honest parts

- **A noise seed cannot be discovered by search.** Noise fields from
  different seeds are uncorrelated, so random search over seed offsets is
  hopeless (verified, then removed). When the input frame was rendered by
  the engine itself, the source detail parameters come from the material
  spec and the fit is near-exact (R^2 > 0.99 on synthetic data). For
  foreign inputs the fitter uses a canonical seed and the R^2 score
  reports the mismatch honestly.
- **Bad fits are flagged, never silently shipped.** `quality.passed`
  requires R^2 >= 0.70 and coverage >= 0.50. A failed fit is still a
  valid bundle document; the failure is recorded in it.
- **Base color and bias are confounded** (their product is what renders),
  so the fitter reports mean albedo as base color. Reconstruction is
  exact; parameter identity with the source is not promised.
- **Bit-exactness boundary.** Python float64 and the TS float64 reference
  (`distillDetail()`) agree bit-exactly (unit-tested). This required a
  polynomial cell hash with no transcendental functions: `Math.sin`
  differs by 1 ulp between CPython and V8 (verified), which would have
  broken exactness. The GLSL evaluation is float32 (`highp`) and is
  therefore tolerance-close, not bit-exact, which matches the engine's
  existing accuracy boundary for shader math.

## Execution paths

- **Official path: your own computer GPU.** Clone the repo, capture
  G-buffers from the demo, super-resolve, run
  `python/xrgen/inverse.py::run_foundry`. `xrgen` is stdlib-only; nothing
  to install.
- **Fallback: free Colab.** `docs/colab/v3-distillation.ipynb` runs the
  same foundry on Colab's free tier, for users without a high-end machine.

## Files

- `python/xrgen/inverse.py` — the foundry (splat, strip, fit, bundle).
- `python/test/test_inverse.py` — foundry tests, all synthetic, CPU-only.
- `src/render/gbuffer.ts` — G-buffer shaders and buffer layout.
- `src/render/renderer.ts` — `captureGBuffer()` (foundry-only).
- `src/material/shader.ts` — the `distill` material effect.
- `src/bridge/distill.ts` — bundle validation, application, TS reference.
- `test/inverse.test.ts` — runtime-side tests incl. the bit-exact check.
- `docs/colab/v3-distillation.ipynb` — Colab fallback notebook.

## Status

V3 pipeline built and tested on synthetic data (CPU). Real DLSS frame
capture needs an RTX setup and a GPU; those steps are marked UNVERIFIED
until run on real hardware. Nothing here changes V2's shipped code paths:
the G-buffer capture and the `distill` effect are additive and flag-gated.
