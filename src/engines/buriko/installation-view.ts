import type {ByteSource} from '../../core/source.js';
import {readBurikoHvlCatalog} from '../../formats/buriko/hvl.js';
import {filePath} from '../../platform/filesystem.js';
import {burikoRegistryFold} from './native/registry-case.js';

interface SourceFile {
  readonly path: string;
  readonly source: ByteSource;
}
export interface BurikoInstallationView<T extends SourceFile> {
  readonly kind: 'installed' | 'disc';
  readonly files: readonly T[];
  readonly catalogPath: string | null;
  readonly excludedPaths: readonly string[];
}

function catalogPath(name: string): string {
  const relative = name.replaceAll('\\', '/');
  if (
    !relative ||
    relative.startsWith('/') ||
    /[\x00-\x1f\x7f:<>"|?*]/.test(relative) ||
    relative
      .split('/')
      .some(
        (part) =>
          !part || part === '.' || part === '..' || part.trim() !== part || part.endsWith('.'),
      )
  )
    throw new Error(`Unsafe BURIKO HVL relative filename: ${JSON.stringify(name)}`);
  return filePath('/' + relative);
}

/** A browser disc view mounts source handles; it never executes or copies an installer.
 * Disc detection uses the engine's matching <stem>ForInstalling.exe / <stem>.hvl pair.
 * The explicit disc policy exposes the integrity catalog, its listed files and the
 * selected main interpreter. Unlisted disc files stay outside the runtime mount.
 * Installed folders keep their complete tree, including unknown resource formats. */
export async function burikoInstallationView<T extends SourceFile>(
  files: readonly T[],
  executablePath: string,
): Promise<BurikoInstallationView<T>> {
  const byPath = new Map<string, T>();
  for (const file of files) {
    const key = burikoRegistryFold(filePath(file.path));
    if (byPath.has(key)) throw new Error(`Duplicate BURIKO installation path: ${file.path}`);
    byPath.set(key, file);
  }
  const executable = byPath.get(burikoRegistryFold(filePath(executablePath)));
  if (executable === undefined)
    throw new Error('The selected BURIKO interpreter is absent from the installation');
  const catalogs = files.flatMap((file) => {
    const installer = /^\/([^/]+)ForInstalling\.exe$/i.exec(file.path);
    if (!installer) return [];
    const catalog = byPath.get(burikoRegistryFold(`/${installer[1]}.hvl`));
    return catalog ? [{installer: file, catalog}] : [];
  });
  if (catalogs.length === 0)
    return {kind: 'installed', files, catalogPath: null, excludedPaths: []};
  if (catalogs.length !== 1) throw new Error('Multiple BURIKO disc integrity catalogs were found');
  const {installer, catalog} = catalogs[0]!;
  if (executable === installer)
    throw new Error('Select the main BURIKO game interpreter instead of the disc installer');
  const {entries} = await readBurikoHvlCatalog(catalog.source),
    included = new Set<string>();
  for (const entry of entries) {
    const path = catalogPath(entry.name),
      key = burikoRegistryFold(path);
    if (included.has(key)) throw new Error(`Duplicate BURIKO HVL relative filename: ${entry.name}`);
    if (!byPath.has(key)) throw new Error(`The BURIKO disc catalog file is missing: ${entry.name}`);
    included.add(key);
  }
  if (!included.has(burikoRegistryFold('/system.arc')))
    throw new Error('The BURIKO disc integrity catalog does not include system.arc');
  included.add(burikoRegistryFold(executable.path));
  included.add(burikoRegistryFold(catalog.path));
  return {
    kind: 'disc',
    files: files.filter((file) => included.has(burikoRegistryFold(file.path))),
    catalogPath: catalog.path,
    excludedPaths: files
      .filter((file) => !included.has(burikoRegistryFold(file.path)))
      .map((file) => file.path),
  };
}
