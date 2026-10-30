/** Actual PCM voices/rendering for nonvisual control-flow diagnostics. */
import {createHash} from 'node:crypto';
import {createArtemisOfflineSoundVoices} from '../dist/engines/artemis/offline-sound-voices.js';
import {artemisRuntimeSound} from '../dist/engines/artemis/runtime-sound.js';
export function createArtemisOfflineSoundFixture(hash, readFile) {
  const files = [],
    samples = [],
    outputHashes = [createHash('sha256'), createHash('sha256')];
  const owner = createArtemisOfflineSoundVoices(
    hash,
    async (path) => {
      const data = await readFile(path);
      if (data !== null)
        files.push({
          path,
          bytes: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
        });
      return data;
    },
    'nearest-even',
    48000,
  );
  let lastTick = 1,
    renderedFrames = 0,
    peak = 0,
    closed = false;
  const advanceToTick = (tick) => {
    if (closed) throw Error('Offline sound fixture closed');
    let delta = (tick - lastTick) >>> 0;
    if (delta > 60000) throw Error('Probe offline PCM clock-step budget exceeded');
    while (delta > 0) {
      const milliseconds = Math.min(delta, 16),
        frames = milliseconds * 48;
      if (renderedFrames + frames > 2000000000)
        throw Error('Probe offline PCM frame budget exceeded');
      lastTick = (lastTick + milliseconds) >>> 0;
      owner.effects.tick(lastTick);
      owner.music.tick(lastTick);
      const output = owner.render(frames);
      output.forEach((plane, channel) => {
        outputHashes[channel].update(
          new Uint8Array(plane.buffer, plane.byteOffset, plane.byteLength),
        );
        for (const sample of plane) peak = Math.max(peak, Math.abs(sample));
      });
      renderedFrames += frames;
      delta -= milliseconds;
    }
  };
  const sound = artemisRuntimeSound(owner, advanceToTick);
  return {
    ...sound,
    prepareEffect: async (file, bufferMode) => {
      const index = await sound.prepareEffect(file, bufferMode);
      samples.push({file, bufferMode, index});
      return index;
    },
    prepareMusic: async (file, bufferMode) => {
      const index = await sound.prepareMusic(file, bufferMode);
      samples.push({music: true, file, bufferMode, index});
      return index;
    },
    summary: () => ({
      soundDecode: 'actual-codec-native-PCM16',
      offlinePcmRendering: true,
      audioGraph: false,
      audioPlayback: false,
      audioDeviceOutput: false,
      clock: 'explicit-diagnostic',
      pcm16RoundingPolicy: 'nearest-even-explicit-diagnostic',
      outputRate: 48000,
      renderedFrames,
      peak,
      pcmSha256: outputHashes.map((hash) => hash.copy().digest('hex')),
      retainedSounds: owner.effects.count,
      retainedMusic: owner.music.count,
      files,
      samples,
    }),
    close: async () => {
      if (!closed) {
        closed = true;
        owner.close();
      }
    },
  };
}
