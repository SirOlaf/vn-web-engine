/** Actual shared Vorbis decode for nonvisual diagnostics. No audio graph/device is opened. */
import {artemisVorbisPcm16} from '../dist/engines/artemis/vorbis-pcm.js';
import {ARTEMIS_3179_EXECUTABLE_SHA256} from '../dist/engines/artemis/revision.js';
import {createHash} from 'node:crypto';
import {ArtemisSoundLoader} from '../dist/engines/artemis/sound-loader.js';
import {createNodeBrowserWorker} from './node-browser-worker.mjs';
export function createArtemisSoundDecodeFixture(readFile) {
  const worker = createNodeBrowserWorker(
    new URL('../dist/audio/vorbis-worker.js', import.meta.url),
  );
  const jobs = new Map(),
    sounds = new Map(),
    samples = [];
  let nextJob = 0,
    nextSound = 0,
    closed = false;
  const fail = (error) => {
    for (const job of jobs.values()) job.reject(error);
    jobs.clear();
  };
  worker.onerror = fail;
  worker.onmessageerror = fail;
  worker.onmessage = ({data}) => {
    const job = jobs.get(data.id);
    if (!job) return;
    jobs.delete(data.id);
    if (data.failed) job.reject(Error('Shared Vorbis worker failed'));
    else if (!data.response?.pcm)
      job.reject(Error(data.response?.error ?? 'Invalid Vorbis worker response'));
    else job.resolve(data.response.pcm);
  };
  // Diagnostic Ogg-only registration; this is not an inferred native plugin order.
  const loader = new ArtemisSoundLoader(readFile, [
    {
      extensions: ['ogg'],
      decode: async (source, bufferMode) => {
        if (bufferMode !== 0) throw Error('Unsupported nonvisual buffered sound owner');
        if (![79, 103, 103, 83].every((v, i) => source[i] === v)) return null;
        const bytes = Uint8Array.from(source),
          id = ++nextJob;
        const pcm = await new Promise((resolve, reject) => {
          jobs.set(id, {resolve, reject});
          try {
            worker.postMessage({id, request: bytes}, [bytes.buffer]);
          } catch (error) {
            jobs.delete(id);
            reject(error);
          }
        });
        return {pcm, encodedSha256: createHash('sha256').update(source).digest('hex')};
      },
    },
  ]);
  return {
    prepareEffect: async (file, bufferMode) => {
      if (closed) throw Error('Sound decode fixture closed');
      if (bufferMode !== 0) throw Error('Unsupported nonvisual buffered sound owner');
      const loaded = await loader.load(file, bufferMode);
      if (loaded === null) return 0;
      const {pcm, encodedSha256} = loaded.sound;
      if (closed) throw Error('Sound decode fixture closed during preparation');
      const index = ++nextSound;
      sounds.set(index, {pcm, gains: new Map(), pan: 0});
      samples.push({
        file,
        resolvedFile: loaded.path,
        bufferMode,
        sampleRate: pcm.sampleRate,
        frames: pcm.frames,
        channels: pcm.planes.length,
        encodedSha256,
        pcm16RoundingPolicy: 'nearest-even-explicit-diagnostic',
        pcm16Sha256: createHash('sha256')
          .update(artemisVorbisPcm16(ARTEMIS_3179_EXECUTABLE_SHA256, pcm, 'nearest-even'))
          .digest('hex'),
        pcmSha256: pcm.planes.map((plane) =>
          createHash('sha256')
            .update(new Uint8Array(plane.buffer, plane.byteOffset, plane.byteLength))
            .digest('hex'),
        ),
      });
      return index;
    },
    discardPreparedEffect: (index) => sounds.delete(index),
    stopEffect: (index, milliseconds) => {
      if (milliseconds) throw Error('Unsupported nonvisual sound fade owner');
      sounds.delete(index);
    },
    setEffectGain: (index, scope, gain) => {
      const sound = sounds.get(index);
      if (!sound) throw Error('Missing prepared sound');
      sound.gains.set(scope, gain);
    },
    setEffectPan: (index, pan, milliseconds) => {
      if (milliseconds) throw Error('Unsupported nonvisual sound pan fade');
      const sound = sounds.get(index);
      if (!sound) throw Error('Missing prepared sound');
      sound.pan = pan;
    },
    startEffect: () => {
      throw Error('Unsupported nonvisual sound playback owner');
    },
    summary: () => ({
      soundDecode: 'actual-shared-worker-nonvisual',
      audioGraph: false,
      audioPlayback: false,
      retainedSounds: sounds.size,
      samples,
    }),
    close: async () => {
      closed = true;
      fail(Error('Sound decode fixture closed'));
      sounds.clear();
      await worker.terminate();
    },
  };
}
