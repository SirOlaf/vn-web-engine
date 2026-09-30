import type {ByteSource} from '../core/source.js';
import {readSfntFontMetadata, type SfntFontMetadata} from '../formats/sfnt.js';
import type {FileSystem} from '../platform/filesystem.js';
import {beginRuntimeSpan} from '../platform/runtime-performance.js';

/** A font file shipped with the game; faces are in collection order. */
export interface GameDirectoryFont {
  readonly path: string;
  readonly source: ByteSource;
  readonly faces: readonly SfntFontMetadata[];
}

const fontFile = /\.(?:ttf|otf|ttc|otc)$/i;

/**
 * Font files a Windows installer would register with the system, or a game would find
 * beside its executable. Only sfnt headers, directories and metadata tables are read; glyph
 * data stays in the source until a face is used. Unreadable files are skipped. Paths deeper
 * than `maxDepth` directories are ignored, bounding the scan of large installations.
 */
export async function readGameDirectoryFonts(
  files: Iterable<{readonly path: string; readonly source: ByteSource}>,
  maxDepth = 3,
): Promise<GameDirectoryFont[]> {
  const finish = beginRuntimeSpan('text.font.game-directory');
  const found: GameDirectoryFont[] = [];
  try {
    for (const {path, source} of files) {
      if (!fontFile.test(path) || path.split('/').length - 2 > maxDepth) continue;
      try {
        found.push({path, source, faces: await readSfntFontMetadata(source)});
      } catch {
        // Not a usable sfnt; Windows would reject it as a font resource as well.
      }
    }
    return found;
  } finally {
    finish?.({fonts: found.length});
  }
}

/** `readGameDirectoryFonts` over a mounted file system, listing at most `maxDepth` levels. */
export async function findGameDirectoryFonts(
  files: FileSystem,
  root = '/',
  maxDepth = 3,
): Promise<GameDirectoryFont[]> {
  const candidates: {path: string; source: ByteSource}[] = [];
  const visit = async (path: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await files.list(path);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        if (depth < maxDepth) await visit(entry.path, depth + 1);
      } else if (fontFile.test(entry.path)) {
        try {
          candidates.push({path: entry.path, source: await files.open(entry.path)});
        } catch {
          // An unopenable file is skipped like an unreadable one.
        }
      }
    }
  };
  await visit(root, 0);
  return readGameDirectoryFonts(candidates, Infinity);
}
