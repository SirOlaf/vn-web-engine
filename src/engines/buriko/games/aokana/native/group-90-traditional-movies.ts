import {pop32, push32} from '../bp/state.js';
import type {AokanaDisplayFrames} from './display-frames.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import {AokanaBrowserTraditionalMovieSession} from './movie-traditional-browser-graph.js';
import type {AokanaTraditionalMovieAudioPolicy} from './movie-traditional-audio-policy.js';
import {textBytes} from './text.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

/** 90:F0–F3 and 92:F0 use the separate DirectShow-style fullscreen graph. */
export function createTraditionalMovieSlots(
  session: AokanaBrowserTraditionalMovieSession,
  frames: AokanaDisplayFrames,
  audio: AokanaTraditionalMovieAudioPolicy,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  if (session.audio !== audio || session.fullscreen !== frames.fullscreenMovie)
    throw new Error('Aokana traditional movie callbacks require one graph and frame owner');
  const pointer = (h: AokanaBpOpcodeContext) => h.memory.resolve(h.thread, pop32(h.thread));
  const invalidSize = (h: AokanaBpOpcodeContext, width: number, height: number): Promise<never> =>
    errors.threadFatal(
      h.thread,
      h.diagnostics,
      errors.files.text.encodeWide(
        `無効な動画ウィンドウサイズ [ ${width | 0}, ${height | 0} ] が指定されました`,
        0,
      ),
    );
  const executeCreate = async (h: AokanaBpOpcodeContext, withArchive: boolean): Promise<0> => {
    const height = pop32(h.thread),
      width = pop32(h.thread);
    pop32(h.thread);
    pop32(h.thread);
    const name = pointer(h),
      archive = withArchive ? pointer(h) : null;
    if ((height | 0) <= 0 || (width | 0) <= 0) return invalidSize(h, width, height);
    if (name === null) throw new Error('Aokana traditional movie consumes a null filename');
    const ownedName = {bytes: textBytes(name, true).slice(), offset: 0};
    const ownedArchive =
      archive === null ? null : {bytes: textBytes(archive, true).slice(), offset: 0};
    if (!withArchive) {
      const bytes = ownedName.bytes;
      const source = {bytes, offset: 0};
      const prefix = errors.files.text.encodeWide('指定された動画ファイル [ ', 0),
        suffix = errors.files.text.encodeWide(' ] は存在しません', 0),
        diagnostic = new Uint8Array(prefix.length - 1 + bytes.length - 1 + suffix.length);
      diagnostic.set(prefix.subarray(0, prefix.length - 1));
      diagnostic.set(bytes.subarray(0, bytes.length - 1), prefix.length - 1);
      diagnostic.set(suffix, prefix.length + bytes.length - 2);
      while ((await session.resources.isAvailable(null, source)) === 0)
        await session.resources.requestMediaRetry(diagnostic);
    }
    const duration = await session.start(ownedArchive, ownedName);
    push32(h.thread, duration ?? 0);
    return 0;
  };
  return [
    {
      primary: 0x90,
      secondary: 0xf0,
      nativeAddress: 0x1400d6570,
      name: 'PlayTraditionalFullscreenMovie',
      execute: (h) => executeCreate(h, false),
    },
    {
      primary: 0x90,
      secondary: 0xf1,
      nativeAddress: 0x1400d6540,
      name: 'StopTraditionalFullscreenMovie',
      execute: async (h): Promise<0> => {
        await session.stop();
        await frames.present(1, null, 0, 0);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xf2,
      nativeAddress: 0x1400d6510,
      name: 'IsTraditionalFullscreenMoviePlaying',
      execute: (h) => {
        push32(h.thread, Number(session.isPlaying()));
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xf3,
      nativeAddress: 0x1400d64f0,
      name: 'SetTraditionalFullscreenMovieVolume',
      execute: (h) => {
        audio.setVolume(pop32(h.thread));
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0xf0,
      nativeAddress: 0x1400e3050,
      name: 'PlayArchivedTraditionalFullscreenMovie',
      execute: (h) => executeCreate(h, true),
    },
  ];
}
