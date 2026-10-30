import type {PsbFile, PsbValue} from '../kirikiri/psb.js';
import {EMOTE_DRIVER_X64_SHA256} from '../kirikiri/psb-filter.js';
import {
  readEmoteModel as readSharedModel,
  walkEmoteLayers as walkSharedLayers,
  type EmoteX64Layer,
} from '../kirikiri/emote-model.js';
export {EmoteModelError, type EmoteDiagnostic} from '../kirikiri/emote-fields.js';
export {
  type EmoteX64Model as EmoteModel,
  EMOTE_MOTION_VERSION,
  EMOTE_DRIVER_SPECS,
  type EmoteScreenSize,
  type EmoteX64Source as EmoteSource,
  type EmoteTexture,
  type EmoteMipLevel,
  type EmoteX64Icon as EmoteIcon,
  type EmoteEasingCurve,
  type EmoteEasingSegment,
  type EmoteX64Object as EmoteObject,
  type EmoteX64Motion as EmoteMotion,
  type EmoteBounds,
  type EmoteParameter,
  EmoteLayerType,
  EMOTE_SOURCE_LAYER_TYPES,
  type EmoteX64Layer as EmoteLayer,
  type EmoteX64LayerMesh as EmoteLayerMesh,
  type EmoteMeshCombinator,
  type EmoteParticleSettings,
  type EmoteX64Frame as EmoteFrame,
  EmoteContentMask,
  type EmoteX64FrameContent as EmoteFrameContent,
  type EmoteFrameMesh,
  type EmoteFrameMotion,
} from '../kirikiri/emote-model.js';

/** Compatibility entry point for the exact x64 driver image. */
export function readEmoteModel(input: PsbFile | PsbValue) {
  return readSharedModel(input, EMOTE_DRIVER_X64_SHA256);
}

export function* walkEmoteLayers(
  layers: readonly EmoteX64Layer[],
  depth = 0,
): Generator<{layer: EmoteX64Layer; depth: number}> {
  yield* walkSharedLayers(layers, depth) as Generator<{layer: EmoteX64Layer; depth: number}>;
}
