import type {AudioVoice} from '../../audio/transport.js';
import {PcmClipRenderer} from '../../audio/pcm-clip-renderer.js';
import type {SseRounding} from '../../core/sse-integer.js';
import {ArtemisEffectVoices} from './effect-voices.js';
import {createArtemisBufferedSoundDecoder} from './buffered-sound-decoder.js';
import {createArtemisSoundLoader} from './sound-loader.js';
import {ArtemisVorbisPcmDecoder} from './vorbis-pcm-decoder.js';
import {ArtemisVorbisSource} from './vorbis-source.js';
import {ArtemisWaveSource} from './wave-source.js';
import {ArtemisRollingAudioProcessor} from './rolling-audio-processor.js';
import type {ArtemisPcmResource} from './pcm-resource.js';
import {artemisRevision} from './revision.js';

interface RenderVoice extends AudioVoice {
  render(output: Float32Array[]): void;
}
function rollingVoice(
  hash: string,
  resource: ArtemisPcmResource,
  bufferMode: number,
  outputRate: number,
): RenderVoice {
  let next = 0,
    loop = false,
    started = false,
    disposed = false,
    position = 0,
    finished = false,
    gain = 0,
    left = 1,
    right = 1,
    failure: Error | null = null;
  const processor = new ArtemisRollingAudioProcessor(
    {hash, resource, bufferMode},
    outputRate,
    (event) => {
      if (event.kind === 'error') {
        failure = Error(event.message);
        finished = true;
      } else {
        position = event.position;
        finished = event.finished;
      }
    },
  );
  const command = (data: Parameters<ArtemisRollingAudioProcessor['receive']>[0]['command']) => {
    if (disposed) return;
    if (failure) throw failure;
    processor.receive({id: ++next, command: data});
    if (failure) throw failure;
  };
  const total = (item: ArtemisPcmResource): number =>
    item.declaredSize + (item.paired ? total(item.paired) : 0);
  return {
    sampleRate: resource.format.sampleRate,
    sampleCount: total(resource) / resource.format.blockAlign,
    loopStart: resource.paired ? resource.declaredSize / resource.format.blockAlign : 0,
    position: () => position,
    ended: () => finished,
    pause: (paused) => {
      if (disposed) return;
      if (!paused && !started) {
        command({kind: 'start', loop});
        started = true;
      } else command({kind: 'pause', paused});
    },
    setLoop: (value) => {
      if (typeof value !== 'boolean') throw Error('Invalid offline PCM loop flag');
      if (started && value !== loop) throw Error('Unsupported live offline rolling loop change');
      loop = value;
    },
    stop: () => {
      command({kind: 'stop'});
      started = false;
    },
    pump: () => {
      if (started && !finished) command({kind: 'pump'});
    },
    volume: (value) => {
      if (!Number.isFinite(value)) throw Error('Invalid offline PCM gain');
      gain = Math.max(0, Math.min(1, value));
    },
    stereoBalance: (a, b) => {
      if (![a, b].every((value) => Number.isFinite(value) && value >= 0 && value <= 1))
        throw Error('Invalid offline PCM balance');
      left = a;
      right = b;
    },
    render: (output) => {
      for (const plane of output) plane.fill(0);
      if (disposed) return;
      processor.render(output);
      if (failure) throw failure;
      for (let channel = 0; channel < output.length; channel++)
        for (let i = 0; i < output[channel]!.length; i++)
          output[channel]![i] = output[channel]![i]! * gain * (channel === 0 ? left : right);
    },
    dispose: () => {
      if (disposed) return;
      if (!failure) processor.receive({id: ++next, command: {kind: 'dispose'}});
      disposed = true;
    },
  };
}

/** Non-device PCM backend for diagnostics/export. Actual codec resources and
 * the same native ring processor produce every sample; rendering drives position.
 * The host supplies device-rate frame counts and scheduler ticks explicitly.
 */
export function createArtemisOfflineSoundVoices(
  hash: string,
  readFile: (path: string) => Promise<Uint8Array | null>,
  rounding: SseRounding,
  outputRate: number,
): {
  effects: ArtemisEffectVoices;
  /** Separate BGM manager (script +0x3d60); voices share the output mix. */
  music: ArtemisEffectVoices;
  render(frames: number): Float32Array[];
  close(): void;
} {
  artemisRevision(hash);
  if (!Number.isInteger(outputRate) || outputRate <= 0)
    throw Error('Invalid offline output sample rate');
  const cached = createArtemisBufferedSoundDecoder(hash, readFile, rounding),
    vorbis = new ArtemisVorbisPcmDecoder(hash, rounding),
    voices = new Set<RenderVoice>(),
    loader = createArtemisSoundLoader<ArtemisWaveSource | ArtemisVorbisSource>(hash, readFile, {
      vorbis: (bytes, _mode, path) =>
        ArtemisVorbisSource.fromBytes(hash, path, bytes, readFile, (data) => vorbis.decode(data)),
      wave: (bytes, _mode, path) => ArtemisWaveSource.fromBytes(hash, path, bytes, readFile),
    });
  let closed = false;
  const prepareVoice = async (file: string, bufferMode: number): Promise<RenderVoice | null> => {
    let voice: RenderVoice;
    if (bufferMode === -1) {
      const clip = await cached.decode(file, bufferMode);
      if (!clip) return null;
      voice = new PcmClipRenderer(clip, outputRate);
    } else {
      const source = await loader.load(file, bufferMode);
      if (!source) return null;
      voice = rollingVoice(hash, source.sound.snapshot(), bufferMode, outputRate);
    }
    if (closed) {
      voice.dispose();
      throw Error('Offline sound owner closed during preparation');
    }
    const dispose = voice.dispose.bind(voice);
    voice.dispose = () => {
      dispose();
      voices.delete(voice);
    };
    voices.add(voice);
    return voice;
  };
  const effects = new ArtemisEffectVoices(hash, {prepareVoice}),
    music = new ArtemisEffectVoices(hash, {prepareVoice});
  return {
    effects,
    music,
    render: (frames) => {
      if (closed) throw Error('Offline sound owner closed');
      if (!Number.isInteger(frames) || frames < 0)
        throw Error('Invalid offline render frame count');
      const output = [new Float32Array(frames), new Float32Array(frames)],
        block = [new Float32Array(frames), new Float32Array(frames)];
      for (const voice of voices) {
        voice.render(block);
        for (let channel = 0; channel < 2; channel++)
          for (let i = 0; i < frames; i++)
            output[channel]![i] = output[channel]![i]! + block[channel]![i]!;
      }
      return output;
    },
    close: () => {
      if (closed) return;
      closed = true;
      effects.close();
      music.close();
      cached.close();
      vorbis.close();
    },
  };
}
