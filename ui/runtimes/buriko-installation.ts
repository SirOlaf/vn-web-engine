import {sha256} from '../../src/core/sha256.js';
import type {ByteSource} from '../../src/core/source.js';
import {readPeVersionStrings} from '../../src/formats/pe/version-info.js';
import {recoverMinidumpPeImage} from '../../src/formats/minidump.js';
import type {InstallationFile} from '../../src/platform/installation-cache.js';
import {readBurikoCursorResource} from '../../src/engines/buriko/native/cursor-shapes.js';
import {burikoEngineVersion} from '../../src/engines/buriko/native/engine-version.js';
import {readBurikoBootProductIdentity} from '../../src/engines/buriko/native/boot-metadata-source.js';
import {legacyAokanaProfile} from '../game-profiles/aokana.js';
import type {BurikoSavedGame} from '../player/buriko-library.js';

export interface BurikoExecutable {
  readonly executableName: string;
  readonly title: string;
  readonly cursor: Uint8Array | null;
  readonly productIdentity: Uint8Array | null;
  readonly savedGame: BurikoSavedGame;
  readonly startupError: string | null;
  /** Optional binary metadata failures are diagnostic data, never a launch gate. */
  readonly metadataNotes: readonly string[];
  readonly interpreterVersion: string | null;
  readonly compatibilityVersion: string | null;
}

const hash = async (bytes: Uint8Array): Promise<string> =>
  Array.from(await sha256(bytes), (value) => value.toString(16).padStart(2, '0')).join('');

/** Stable fallback save identity from boot content, independent of executable patches and dumps.
 * This versioned digest chain bounds memory while including every source byte. */
async function bootContentIdentity(source: ByteSource): Promise<string> {
  const encode = new TextEncoder();
  let digest = await sha256(encode.encode(`buriko-boot-identity-v1:${source.size}`));
  for (let offset = 0; offset < source.size; offset += 1024 * 1024) {
    const length = Math.min(1024 * 1024, source.size - offset);
    const bytes = await source.read(offset, length);
    if (bytes.length !== length) throw new Error('The boot archive could not be read completely.');
    const block = new Uint8Array(digest.length + bytes.length);
    block.set(digest);
    block.set(bytes, digest.length);
    digest = await sha256(block);
  }
  return `boot-${Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/** The old engine embeds its complete named-mutex string in the executable. */
function embeddedProductIdentity(bytes: Uint8Array): string | null {
  const text = new TextDecoder('latin1').decode(bytes);
  const identities = new Set(
    Array.from(
      text.matchAll(/Buriko General Interpreter for ([ -~]{1,255}) is executing\.\0/g),
      (match) => match[1]!,
    ).filter((value) => !value.includes('%')),
  );
  return identities.size === 1 ? [...identities][0]! : null;
}

/** Select the interpreter, retaining launchers and installers as mounted files. */
export async function inspectBurikoInstallation(
  files: readonly InstallationFile[],
  folderTitle?: string,
): Promise<BurikoExecutable> {
  const boot = files.find((file) => file.path.toLowerCase() === '/system.arc');
  if (boot === undefined) throw new Error('The selected installation has no system.arc.');
  const candidates = files.filter((file) => /^\/[^/]+\.exe$/i.test(file.path));
  candidates.sort(
    (left, right) =>
      Number(right.path.toLowerCase() === '/bgi.exe') -
      Number(left.path.toLowerCase() === '/bgi.exe'),
  );
  if (candidates.length === 0)
    throw new Error(
      'The selected installation has no executable in its root folder. Add the game’s executable or select the complete game folder.',
    );
  const inspected = [];
  for (const file of candidates) {
    if (file.source.size > 512 * 1024 * 1024) continue;
    const bytes = await file.source.read(0, file.source.size);
    let versions: ReturnType<typeof readPeVersionStrings> = [];
    try {
      versions = readPeVersionStrings(bytes);
    } catch {
      /* Auxiliary executables may be protected or unrelated. */
    }
    const version = versions[0]?.values;
    const isInterpreter =
      versions.some(
        ({values}) =>
          /BURIKO General Interpreter/i.test(values.FileDescription ?? '') ||
          values.InternalName?.toLowerCase() === 'ethornell',
      ) || embeddedProductIdentity(bytes) !== null;
    if (isInterpreter) {
      inspected.push({file, bytes, version, isInterpreter});
      if (file.path.toLowerCase() === '/bgi.exe') break;
    }
  }
  const preferred = inspected.find(
    ({file, isInterpreter}) => file.path.toLowerCase() === '/bgi.exe' && isInterpreter,
  );
  const engines = inspected.filter(({isInterpreter}) => isInterpreter);
  const chosen = preferred ?? (engines.length === 1 ? engines[0] : undefined);
  if (!chosen)
    throw new Error(
      engines.length > 1
        ? `Multiple BGI interpreters were found: ${engines.map(({file}) => file.path.slice(1)).join(', ')}. Select files containing only the intended game interpreter.`
        : 'No identifiable BGI / Ethornell interpreter was found in the selected folder.',
    );
  const executableName = chosen.file.path.slice(1);
  const digest = await hash(chosen.bytes);
  const legacy = digest === legacyAokanaProfile.executableSha256 ? legacyAokanaProfile : null;
  let identity = legacy?.productIdentity ?? embeddedProductIdentity(chosen.bytes);
  const errors: string[] = [];
  const fileVersion = chosen.version?.FileVersion ?? '';
  const interpreterVersion = /\bVersion\s*:\s*(\d+(?:\.\d+)+)/i.exec(fileVersion)?.[1] ?? null;
  const compatibilityVersion =
    /\bCompatibility\s*:\s*(\d+(?:\.\d+)+)/i.exec(fileVersion)?.[1] ?? null;
  if (identity === null) {
    try {
      const version = burikoEngineVersion(interpreterVersion, compatibilityVersion);
      const inferred = await readBurikoBootProductIdentity(boot.source, version.bpAbi);
      if (inferred !== null) identity = new TextDecoder('ascii').decode(inferred);
    } catch (error) {
      errors.push(
        `Optional boot metadata could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // Adding/removing an optional dump must not change the installation's save namespace.
  const persistentIdentity = identity;
  const productTitle = chosen.version?.ProductName?.trim();
  const title = productTitle || folderTitle || executableName.replace(/\.exe$/i, '');
  let cursorError: string | null = null;
  let dumpError: string | null = null;
  let cursor: Uint8Array | null = null;
  try {
    cursor = readBurikoCursorResource(chosen.bytes);
  } catch (error) {
    cursorError = error instanceof Error ? error.message : String(error);
  }
  if (identity === null || cursorError !== null) {
    const dumpPath = chosen.file.path.replace(/\.exe$/i, '.dmp').toLowerCase();
    const dumps = files.filter((file) => file.path.toLowerCase() === dumpPath);
    if (dumps.length > 1) dumpError = 'Multiple matching process dumps were selected.';
    else if (dumps.length === 1) {
      try {
        const recovered = await recoverMinidumpPeImage(
          dumps[0]!.source,
          chosen.bytes,
          executableName,
        );
        if (recovered === null)
          throw new Error('The selected interpreter is absent from its process dump.');
        identity ??= embeddedProductIdentity(recovered);
        if (cursor === null || cursorError !== null) {
          cursor = readBurikoCursorResource(recovered);
          cursorError = null;
        }
      } catch (error) {
        dumpError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  if (identity === null)
    errors.push(
      'The interpreter’s native product identity could not be read. This executable may be packed or use an unsupported metadata layout.',
    );
  if (cursorError !== null)
    errors.push(`The interpreter’s cursor resources could not be read: ${cursorError}.`);
  if (dumpError !== null) errors.push(`Process dump metadata recovery failed: ${dumpError}`);
  const startupError = null;
  const id =
    persistentIdentity === null
      ? await bootContentIdentity(boot.source)
      : `product-${await hash(new TextEncoder().encode(persistentIdentity))}`;
  const savedGame: BurikoSavedGame = legacy ?? {id, title, namespace: ['buriko', id, 'default']};
  return {
    executableName,
    title,
    cursor,
    savedGame,
    startupError,
    metadataNotes: errors,
    interpreterVersion,
    compatibilityVersion,
    productIdentity: identity === null ? null : new TextEncoder().encode(identity + '\0'),
  };
}
