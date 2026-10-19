// Polyglot Procedural Engine (PPE) public surface (v1).
export * from './math/vec.js';
export * from './math/mat.js';
export { fromAxisAngle, toMat4, slerp, qIdentity, multiply as quatMultiply } from './math/quat.js';
export type { Quat } from './math/quat.js';
export { SceneNode } from './scene/node.js';
export type { Component } from './scene/node.js';
export { Mesh, Light, Camera, Script } from './scene/components.js';
export type { Geometry, Material, LightKind } from './scene/components.js';
export * from './geo/rng.js';
export * from './geo/parametric.js';
export * from './geo/terrain.js';
export { skyDome } from './geo/sky.js';
export { rock, scatterRocks } from './geo/rocks.js';
export { ParticleSystem } from './physics/particles.js';
export type { Collider, ParticleOptions } from './physics/particles.js';
export { particleGeometry, writeParticles } from './physics/particleMesh.js';
export * from './material/shader.js';
export * from './bridge/providers.js';
export { TsGenCore, WasmGenCore, createGenCore } from './bridge/wasm.js';
export { TsMlProvider, loadStyleWeights } from './bridge/python.js';
export type { MlProvider, MlWeights } from './bridge/python.js';
export { Renderer } from './render/renderer.js';
export { WebXRProvider } from './xr/webxr.js';
export { InlineProvider } from './xr/inline.js';
export { SpatialAudio, BuiltinPadDriver } from './audio/spatial.js';
export type { MusicDriver, VoiceSpec, ReverbZoneSpec, CameraPose, RaycastFn, OneShotSpec, EmitterVoiceKind } from './audio/spatial.js';
export { ScorePlayer, validateScore } from './audio/driver.js';
export type { AudioEvent, ScoreDoc, ScoreKind } from './audio/driver.js';
export { MixGraph } from './audio/graph.js';
export type { BusName } from './audio/graph.js';
export { DspBridge, DSP_EXPORTS } from './audio/dsp.js';
export type { DspWasmModule, DspExportName } from './audio/dsp.js';
export {
  Conductor, ATTUNE_THRESHOLDS, attunementLevel, attunementLevelAt,
  layerGains, motionDensity, resonanceActive, resonanceActiveAt,
  justLattice, smoothstep, NEUTRAL_STATE, LAYER_NAMES,
} from './audio/score.js';
export type { ConductorState, ConductorOpts, LayerName } from './audio/score.js';
export { AudioEngine } from './audio/engine.js';
export type { AudioEngineOpts } from './audio/engine.js';
export { parseAudioBundle, loadAudioBundle, bundleIR, bundleTexture } from './audio/foundry.js';
export type { AudioBundle, FoundryIRParams, FoundryTextureParams } from './audio/foundry.js';
export {
  renderSfx, renderVoiceBuffer, renderIR, pluckKS, modalBank, riserFM, gustNoise,
  makeXorShift32,
} from './audio/synth.js';
export type { SfxVoiceKind, SfxRenderOpts } from './audio/synth.js';
export * from './script/index.js';
export * from './input/index.js';
export * from './game/index.js';
export * from './math/sdf.js';
export { RaymarchRenderer, buildRaymarchFragment, cameraBasis } from './render/raymarch.js';
export type { RaymarchCamera, RaymarchOpts, RaymarchMaterial } from './render/raymarch.js';
export { gradientDescent, solveLighting, lightCandidates, fitMaterialCoeffs, solveLightPosition, linearLeastSquares, FD_EPS } from './inverse/solvers.js';
export type { SolveLog, GdOpts, LightSample, SolvedLight, LightingSolution, MaterialFit, LightPosSolution } from './inverse/solvers.js';
export { ParamRegistry, CurveParam, mountTuningDeck, TUNING_DECK_CSS } from './ui/tuning.js';
export type { ParamDef, ParamListener, DeckSection } from './ui/tuning.js';
export { evalTerm, evalSlider, evalSemantics, SEMANTIC_SLIDERS, blocks, live, stackBlocks, sineWarp, demoWorld, demoUniforms } from './world/semantic.js';
export type { SemanticTerm, SemanticSlider, Block } from './world/semantic.js';
export * from './math/noisegrad.js';
export * from './math/conservative.js';
export * from './math/overrelax.js';
export * from './geo/terrain-dist.js';
export * from './inverse/geograd.js';
export * from './inverse/varpro.js';
export * from './render/temporal.js';
export * from './audio/acoustics.js';
