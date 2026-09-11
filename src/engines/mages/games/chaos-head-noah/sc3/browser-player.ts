import {BrowserNoahMovies} from './browser-movies.js';
import {BlobSource, HttpSource} from '../../../../../core/source.js';
import {NoahArchives} from '../archives.js';
import {inspectBoot} from './inspector.js';
import {SoundPlayer} from '../../../../../audio/sound-player.js';
import {BrowserAudioTransport} from '../../../../../audio/transport.js';
import {HcaWorkerDecoder} from '../../../../../audio/worker-decoder.js';
import type {CpkArchive} from '../../../../../formats/cri/cpk.js';
import type {PlatformServices} from '../../../../../platform/services.js';

/** NOAH-specific browser transports, shared by the game page and diagnostic player. */
export async function openNoahPlayer(
  services: PlatformServices,
  lookup: (name: string) => CpkArchive | undefined,
  report: (error: unknown) => void,
  presentation: 'diagnostic' | 'game' = 'diagnostic',
  onSidebarAvailability?: (available: boolean) => void,
) {
  const gameArchives = new NoahArchives(lookup);
  const sound = new SoundPlayer(async (id) => {
    const archive = lookup('sysse.cpk');
    if (!archive) throw new Error('Missing sysse.cpk');
    return new BlobSource(new Blob([(await archive.read(id)).slice().buffer]));
  }, report);
  const decoder = new HcaWorkerDecoder(),
    audio = new BrowserAudioTransport(async (bank, id) => {
      const name = ({6: 'voice.cpk', 7: 'se.cpk', 8: 'bgm.cpk'} as Record<number, string>)[bank],
        archive = name ? lookup(name) : undefined;
      if (!archive) throw new Error(`Missing audio archive bank ${bank} (${name ?? 'unknown'})`);
      const bytes = await archive.read(id);
      return decoder.decode({kind: 'blob', blob: new Blob([bytes.slice().buffer])});
    });
  const movies = new BrowserNoahMovies((id) => {
    const {archive, entry} = gameArchives.asset('movie.cpk', id),
      source = archive.source;
    if (entry.size !== entry.storedSize) throw new Error('Compressed movie stream is unsupported');
    if (source instanceof BlobSource)
      return {kind: 'blob', blob: source.blob.slice(entry.offset, entry.offset + entry.storedSize)};
    if (source instanceof HttpSource)
      return {
        kind: 'http',
        url: new URL(source.url, location.href).href,
        size: source.size,
        offset: entry.offset,
        length: entry.storedSize,
      };
    throw new Error('Movie source cannot be transferred to a worker');
  });

  try {
    const textureAssets = {
      size: (bank: number, id: number) => gameArchives.size(bank, id),
      read: (bank: number, id: number) => gameArchives.read(bank, id),
    };
    const result = await inspectBoot(
      services,
      {
        movies,
        audio,
        sound: (id, volume) => sound.play(id, volume),
        textures: textureAssets,
        size: (bank, id) => gameArchives.size(bank === 'script' ? 3 : 4, id),
        script: (id) => gameArchives.read(3, id),
        messages: (id) => gameArchives.read(4, id),
        selectLanguage: (language) => gameArchives.selectLanguage(language),
        manualPageCount: () => gameArchives.resolve('manual.cpk').entries.length,
      },
      sound,
      audio,
      movies,
      presentation,
      onSidebarAvailability,
    );
    return {
      ...result,
      dispose() {
        result.dispose();
        sound.dispose();
        audio.dispose();
        decoder.dispose();
        movies.dispose();
      },
    };
  } catch (error) {
    sound.dispose();
    audio.dispose();
    decoder.dispose();
    movies.dispose();
    throw error;
  }
}
