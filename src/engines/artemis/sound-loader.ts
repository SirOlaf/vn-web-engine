import {artemisRevision} from './revision.js';

export interface ArtemisSoundCodec<S, F = Uint8Array> {
  /** Case-sensitive native plugin extensions, in registration order. */
  readonly extensions: readonly string[];
  /** The resolved path preserves native source-filename access (including paired files).
   * Null is a decode miss; exceptions are host failures and must propagate. */
  decode(file: F, bufferMode: number, resolvedPath: string): Promise<S | null>;
}

/** b9e80 installs Vorbis (f6970) before WAVE (f6a80). Codec bodies and
 * buffer-mode ownership remain mandatory caller services, not silent fallbacks. */
export function createArtemisSoundLoader<S, F = Uint8Array>(
  hash: string,
  readFile: (path: string) => Promise<F | null>,
  decoders: {
    readonly vorbis: ArtemisSoundCodec<S, F>['decode'];
    readonly wave: ArtemisSoundCodec<S, F>['decode'];
  },
  copy?: (file: F) => F,
): ArtemisSoundLoader<S, F> {
  const {soundLoaderRewinds} = artemisRevision(hash);
  return new ArtemisSoundLoader(
    readFile,
    [
      {extensions: ['ogg', 'OGG'], decode: decoders.vorbis},
      {extensions: ['wav', 'WAV'], decode: decoders.wave},
    ],
    copy,
    soundLoaderRewinds,
  );
}
export interface ArtemisLoadedSound<S> {
  readonly path: string;
  readonly sound: S;
}

/** Rev.3179 0x140190290 (Rev.3139 0x14018e760): preferred suffix, sniff exact file, append
 * suffixes. The caller supplies the installation's actual registered codecs and order.
 * Each decode receives an independent file starting at native file offset zero: a copy of
 * the bytes, or, for a loader over read-only sources (`F`), the same source. Rev.3179 seeks
 * the exact file back to zero before each further loader. Without that rewind (`rewinds`
 * false, Rev.3139) a further loader would continue where the failed one stopped; that
 * position belongs to the codec, so such a retry is refused instead of decoded from zero.
 */
export class ArtemisSoundLoader<S, F = Uint8Array> {
  private readonly codecs: readonly ArtemisSoundCodec<S, F>[];
  constructor(
    private readonly readFile: (path: string) => Promise<F | null>,
    codecs: readonly ArtemisSoundCodec<S, F>[],
    private readonly copy: (file: F) => F = (file) => Uint8Array.from(file as Uint8Array) as F,
    private readonly rewinds = true,
  ) {
    this.codecs = codecs.map((codec) => ({
      extensions: [...codec.extensions],
      decode: (bytes, bufferMode, path) => codec.decode(bytes, bufferMode, path),
    }));
  }
  async load(name: string, bufferMode: number): Promise<ArtemisLoadedSound<S> | null> {
    if (!Number.isInteger(bufferMode) || bufferMode < -2147483648 || bufferMode > 2147483647)
      throw new Error('Artemis sound buffer mode must be int32');
    // This entry receives a native char pointer, not a length-bearing CString.
    name = name.split('\0', 1)[0]!;
    const decode = (codec: ArtemisSoundCodec<S, F>, file: F, path: string) =>
      codec.decode(this.copy(file), bufferMode, path);
    const opened = await this.readFile(name);
    if (opened !== null) {
      const exact = opened;
      let failed = false;
      const decodeExact = async (codec: ArtemisSoundCodec<S, F>) => {
        if (failed && !this.rewinds)
          throw new Error(
            `Unsupported Artemis sound lookup ${name}: a further loader without the rewind`,
          );
        const sound = await decode(codec, exact, name);
        failed ||= sound === null;
        return sound;
      };
      const basename = name.slice(name.lastIndexOf('\\') + 1);
      const dot = basename.lastIndexOf('.');
      const extension = dot < 0 ? '' : basename.slice(dot + 1);
      if (extension)
        for (const codec of this.codecs)
          if (codec.extensions.includes(extension)) {
            const sound = await decodeExact(codec);
            if (sound !== null) return {path: name, sound};
          }
      for (const codec of this.codecs) {
        const sound = await decodeExact(codec);
        if (sound !== null) return {path: name, sound};
      }
    }
    for (const codec of this.codecs)
      for (const extension of codec.extensions) {
        const path = `${name}.${extension}`;
        const file = await this.readFile(path);
        if (file === null) continue;
        const sound = await decode(codec, file, path);
        if (sound !== null) return {path, sound};
      }
    return null;
  }
}
