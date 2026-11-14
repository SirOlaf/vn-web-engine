/** `MMotionPlayer` (clip): see `clip/clip.ts`. */
export {
  EmoteClip,
  computeMatrix,
  createEmoteClip,
  emoteClipFactory,
  type EmoteClipOptions,
} from './clip/clip.js';
export {EmoteClipUnsupportedError} from './clip/frame.js';

/** Scalar binding of the exact x64 image over the shared clip phases. */
export {
  EmoteMotionClip,
  EmoteResource,
  emoteScalarClipFactory,
  EMOTE_RAD_TO_DEG,
  type EmoteScalarClipFactoryOptions,
} from './clip/scalar.js';
