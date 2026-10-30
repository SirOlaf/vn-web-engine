import type {AudioVoice} from '../../audio/transport.js';
import {BrowserAudioTransport} from '../../audio/transport.js';
import type {PcmClip} from '../../audio/pcm.js';
import type {SseRounding} from '../../core/sse-integer.js';
import {ArtemisEffectVoices} from './effect-voices.js';
import {createArtemisBufferedSoundDecoder} from './buffered-sound-decoder.js';
import {createArtemisSoundLoader} from './sound-loader.js';
import {ArtemisVorbisSource} from './vorbis-source.js';
import {ArtemisWaveSource} from './wave-source.js';
import {ArtemisVorbisPcmDecoder} from './vorbis-pcm-decoder.js';
import {createArtemisRollingVoice} from './browser-rolling-voice.js';
import {artemisRevision} from './revision.js';
import type {ByteSource} from '../../core/source.js';
import {artemisPairedSoundPath} from './paired-sound-path.js';
import {artemisRollingHalfSize} from './rolling-sound-buffer.js';
import {ArtemisVorbisStream, ArtemisVorbisStreamDecoder} from './vorbis-stream-source.js';
import {beginRuntimeSpan} from '../../platform/runtime-performance.js';

/** Native file/codec/voice owner for cached and progressive playback. Engine
 * scheduler ticks pump real device buffers through ArtemisEffectVoices.tick.
 * Cached clips and paired `_a`/`_b` Vorbis files are eagerly decoded in workers. Other
 * progressive Vorbis voices decode while their file is read and start once both ring halves
 * can be filled; decode-error and damaged/chained-stream timing are not claimed equivalent
 * to native libvorbis.
 */
export function createArtemisBrowserSoundVoices(
  hash: string,
  files: {
    read(path: string): Promise<Uint8Array | null>;
    /** The same namespace as `read`, as ranged sources for progressive reads. */
    open(path: string): Promise<ByteSource | null>;
  },
  rounding: SseRounding,
  context?: AudioContext | OfflineAudioContext,
): {
  effects: ArtemisEffectVoices;
  /** Separate BGM manager (script +0x3d60) on the same audio graph. */
  music: ArtemisEffectVoices;
  unlock(): Promise<void>;
  close(): void;
} {
  artemisRevision(hash);
  const readFile = (path: string) => files.read(path);
  const graph = context ?? new AudioContext(),
    clips = new Map<number, PcmClip>(),
    cached = createArtemisBufferedSoundDecoder(hash, readFile, rounding),
    vorbis = new ArtemisVorbisPcmDecoder(hash, rounding),
    streams = new ArtemisVorbisStreamDecoder(hash, rounding),
    rolling = new Set<AudioVoice>(),
    transport = new BrowserAudioTransport(async (_bank, index) => {
      const clip = clips.get(index);
      if (!clip) throw Error('Missing cached Artemis PCM');
      return clip;
    }, graph),
    readAll = (source: ByteSource) => source.read(0, source.size),
    loader = createArtemisSoundLoader<
      ArtemisWaveSource | ArtemisVorbisSource | ArtemisVorbisStream,
      ByteSource
    >(
      hash,
      (path) => files.open(path),
      {
        vorbis: async (source, mode, path) =>
          artemisPairedSoundPath(path) === null
            ? ArtemisVorbisStream.open(
                hash,
                source,
                streams,
                // `start` fills the first half and prefills the second.
                (format) => 2 * artemisRollingHalfSize(format, mode),
              )
            : ArtemisVorbisSource.fromBytes(hash, path, await readAll(source), readFile, (data) =>
                vorbis.decode(data),
              ),
        wave: async (source, _mode, path) =>
          ArtemisWaveSource.fromBytes(hash, path, await readAll(source), readFile),
      },
      // Sources are read-only: every candidate decode reads from offset zero.
      (source) => source,
    );
  let next = 0,
    closed = false;
  // Diagnostic: file lookup to a playable voice, as one span per preparation.
  const prepareVoice = async (file: string, bufferMode: number): Promise<AudioVoice | null> => {
    const finish = beginRuntimeSpan('artemis.sound.prepare', {cached: bufferMode === -1});
    const voice = await prepareSound(file, bufferMode);
    finish?.({found: voice !== null});
    return voice;
  };
  const prepareSound = async (file: string, bufferMode: number): Promise<AudioVoice | null> => {
    if (closed) throw Error('Artemis sound owner closed');
    if (bufferMode === -1) {
      const clip = await cached.decode(file, bufferMode);
      if (closed) throw Error('Artemis sound owner closed during decode');
      if (!clip) return null;
      const index = ++next;
      clips.set(index, clip);
      try {
        return await transport.prepare(0, index, false);
      } finally {
        clips.delete(index);
      }
    }
    const loaded = await loader.load(file, bufferMode);
    if (closed) {
      if (loaded?.sound instanceof ArtemisVorbisStream) loaded.sound.close();
      throw Error('Artemis sound owner closed during decode');
    }
    if (!loaded) return null;
    const sound = loaded.sound;
    const voice = await createArtemisRollingVoice(
      graph,
      sound instanceof ArtemisVorbisStream
        ? {hash, stream: sound, bufferMode}
        : {hash, resource: sound.snapshot(), bufferMode},
    );
    if (closed) {
      voice.dispose();
      throw Error('Artemis sound owner closed during voice preparation');
    }
    const dispose = voice.dispose;
    voice.dispose = () => {
      dispose();
      rolling.delete(voice);
    };
    rolling.add(voice);
    return voice;
  };
  const effects = new ArtemisEffectVoices(hash, {prepareVoice}),
    music = new ArtemisEffectVoices(hash, {prepareVoice});
  return {
    effects,
    music,
    unlock: () => transport.unlock(),
    close: () => {
      if (closed) return;
      closed = true;
      effects.close();
      music.close();
      for (const voice of rolling) voice.dispose();
      cached.close();
      vorbis.close();
      streams.close();
      clips.clear();
      transport.dispose();
    },
  };
}
