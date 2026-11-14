import type {PcmClip} from '../../audio/pcm.js';
import {BrowserAudioTransport} from '../../audio/transport.js';
import {artemisRevision} from './revision.js';
import {ArtemisEffectVoices} from './effect-voices.js';
/** Actual browser PCM voices for the native sound owner. The codec/installation
 * owner supplies decoded PCM and buffer-mode semantics; no filename/codec fallback
 * or simulated sound is supplied here. Offline contexts are for nonaudible tests. */
export function createArtemisBrowserEffectVoices(
  hash: string,
  decode: (file: string, bufferMode: number) => Promise<PcmClip | null>,
  context?: AudioContext | OfflineAudioContext,
): {effects: ArtemisEffectVoices; unlock(): Promise<void>; close(): void} {
  artemisRevision(hash);
  const clips = new Map<number, PcmClip>();
  let next = 0,
    closed = false;
  const transport = new BrowserAudioTransport(async (_bank, id) => {
    const clip = clips.get(id);
    if (!clip) throw Error('Missing prepared Artemis PCM');
    return clip;
  }, context);
  const effects = new ArtemisEffectVoices(hash, {
    prepareVoice: async (file, bufferMode) => {
      const clip = await decode(file, bufferMode);
      if (closed) throw Error('Artemis browser audio closed during decode');
      if (!clip) return null;
      const id = ++next;
      clips.set(id, clip);
      try {
        return await transport.prepare(0, id, false);
      } finally {
        clips.delete(id);
      }
    },
  });
  return {
    effects,
    unlock: () => transport.unlock(),
    close: () => {
      if (closed) return;
      closed = true;
      effects.close();
      clips.clear();
      transport.dispose();
    },
  };
}
