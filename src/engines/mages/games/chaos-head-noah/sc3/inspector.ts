import {readFile} from '../../../../../platform/filesystem.js';
import {readOptionalNoahCursors} from './browser-cursor.js';
import {captureStartupFrame} from './startup-frame.js';
import type {PlatformServices} from '../../../../../platform/services.js';
import {Sc3Runtime, type Sc3Assets} from './runtime.js';
import {mountLivePlayer} from './live-player.js';
import type {SoundPlayer} from '../../../../../audio/sound-player.js';
import type {BrowserAudioTransport} from '../../../../../audio/transport.js';

/** Live interpreter; offline boot verification remains in the command-line tools. */
export async function inspectBoot(
  services: PlatformServices,
  /** Installation-relative executable path, e.g. `/Game.exe`; only its cursors are read. */
  executablePath: string | undefined,
  assets: Sc3Assets,
  sound?: SoundPlayer,
  audio?: BrowserAudioTransport,
  movies?: import('./browser-movies.js').BrowserNoahMovies,
  presentation: 'diagnostic' | 'game' = 'diagnostic',
  onSidebarAvailability?: (available: boolean) => void,
  onStopped?: (message: string) => void,
): Promise<{
  panel: HTMLElement;
  start(): void;
  setTextMode(mode: 'native' | 'dom'): void;
  relayout(): void;
  dispose(): void;
}> {
  const cursors = await readOptionalNoahCursors(
    executablePath === undefined ? undefined : readFile(services.files, '/game' + executablePath),
  );
  return mountLivePlayer(
    () => {
      movies?.reset();
      let seed = 0x12345678;
      return new Sc3Runtime(services, assets, {
        traceLimit: 2048,
        random15: () => {
          seed = (Math.imul(seed, 214013) + 2531011) >>> 0;
          return (seed >>> 16) & 32767;
        },
      });
    },
    captureStartupFrame,
    async () => {
      sound?.unlock();
      // Activate every device before awaiting: WebKit can require this original gesture.
      await Promise.all([audio?.unlock(), movies?.unlock()]);
    },
    cursors,
    presentation,
    onSidebarAvailability,
    onStopped,
  );
}
