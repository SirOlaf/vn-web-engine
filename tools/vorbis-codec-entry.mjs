// Pin this internal entry alongside the package version. The high-level wrapper's
// codec-parser is unused; our shared runtime owns Ogg framing and worker lifecycle.
export {Decoder as VorbisPacketDecoder} from '../node_modules/@wasm-audio-decoders/ogg-vorbis/src/OggVorbisDecoder.js';
