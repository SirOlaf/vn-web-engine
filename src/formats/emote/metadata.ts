import type {PsbObject} from '../kirikiri/psb.js';
import type {EmoteDiagnosticSink} from '../kirikiri/emote-fields.js';
import {EMOTE_DRIVER_X64_SHA256} from '../kirikiri/psb-filter.js';
import {readEmoteMetadata as readSharedMetadata} from '../kirikiri/emote-metadata.js';

export {
  EMOTE_DEFAULT_IMMEDIATE,
  type EmoteX64Metadata as EmoteMetadata,
  type EmoteCharaProfile,
  type EmoteOrbitControl,
  type EmoteDisabledControl,
  type EmoteVec3,
  type EmoteBustControl,
  type EmotePendulumControl,
  type EmoteEyeControl,
  type EmoteEyebrowControl,
  type EmoteMouthControl,
  type EmoteTransitionControl,
  type EmoteSelectorControl,
  type EmoteClampControl,
  type EmoteVariableMatch,
  type EmoteTimeline,
  type EmoteTimelineVariable,
  type EmoteTimelineFrame,
  type EmoteVariableFrames,
} from '../kirikiri/emote-metadata.js';

/** The x64 binding uses the same reader, selected by its exact DLL identity. */
export function readEmoteMetadata(object: PsbObject, diagnostics: EmoteDiagnosticSink) {
  return readSharedMetadata(object, diagnostics, EMOTE_DRIVER_X64_SHA256);
}
