import type {ByteSource} from '../../core/source.js';
import {readPeVersionStrings} from '../../formats/pe/version-info.js';

export interface MagesExecutableCandidate {
  /** Installation-relative path, e.g. `/Game.exe`. */
  readonly path: string;
  readonly source: ByteSource;
}

const MAX_EXECUTABLE_SIZE = 512 * 1024 * 1024;

/** Root-folder `.exe` files; the MAGES launcher never runs from a subdirectory. */
export function isMagesExecutablePath(path: string): boolean {
  return /^\/[^/]+\.exe$/i.test(path);
}

/** Storefront builds rename the image (GOG `Game.exe`, Steam `Game_Steam.exe`) but keep
 * the build's version resource: `OriginalFilename`/`InternalName` Game.exe, company MAGES. */
function isMagesVersionResource(bytes: Uint8Array): boolean {
  let versions: ReturnType<typeof readPeVersionStrings>;
  try {
    versions = readPeVersionStrings(bytes);
  } catch {
    return false; // Uninstallers and helpers may carry malformed or no resources.
  }
  return versions.some(
    ({values}) =>
      values.OriginalFilename?.toLowerCase() === 'game.exe' ||
      values.InternalName?.toLowerCase() === 'game.exe' ||
      /^MAGES\b/i.test(values.CompanyName?.trim() ?? ''),
  );
}

/** Select the game executable among root-folder candidates, or none when absent.
 * `Game.exe` is taken as-is; any other name must be identified by its version resource. */
export async function selectMagesExecutable<T extends MagesExecutableCandidate>(
  files: Iterable<T>,
): Promise<T | undefined> {
  const candidates = [...files].filter((file) => isMagesExecutablePath(file.path));
  const canonical = candidates.find((file) => file.path.toLowerCase() === '/game.exe');
  if (canonical) return canonical;
  const identified: T[] = [];
  for (const file of candidates) {
    if (file.source.size > MAX_EXECUTABLE_SIZE) continue;
    if (isMagesVersionResource(await file.source.read(0, file.source.size))) identified.push(file);
  }
  if (identified.length <= 1) return identified[0];
  throw new Error(
    `Multiple game executables were found: ${identified.map(({path}) => path.slice(1)).join(', ')}. Select only the one you launch the game with.`,
  );
}
