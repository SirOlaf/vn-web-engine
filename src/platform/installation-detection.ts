import type {ByteSource} from '../core/source.js';

/** A file of a chosen installation, by its path below the installation root. */
export interface InstallationProbeFile {
  readonly path: string;
  readonly source: ByteSource;
}

/** Recognizes the installations an engine can run from markers in their files. */
export type InstallationRecognizer = (files: readonly InstallationProbeFile[]) => Promise<boolean>;

/** Header reads per marker; a folder holds few archives of one engine. */
const PROBE_LIMIT = 16;

function bytes(signature: string | readonly number[]): readonly number[] {
  return typeof signature === 'string'
    ? Array.from(signature, (char) => char.charCodeAt(0))
    : signature;
}

/** The file starts with one of the signatures. */
export async function startsWithSignature(
  source: ByteSource,
  signatures: readonly (string | readonly number[])[],
): Promise<boolean> {
  const expected = signatures.map(bytes);
  const length = Math.min(source.size, Math.max(...expected.map((value) => value.length)));
  const header = await source.read(0, length);
  return expected.some(
    (value) => value.length <= header.length && value.every((byte, i) => header[i] === byte),
  );
}

/** Some file whose path matches `name` starts with one of the signatures. */
export async function hasSignedFile(
  files: readonly InstallationProbeFile[],
  name: RegExp,
  signatures: readonly (string | readonly number[])[],
): Promise<boolean> {
  const candidates = files.filter((file) => name.test(file.path)).slice(0, PROBE_LIMIT);
  for (const file of candidates) {
    try {
      if (await startsWithSignature(file.source, signatures)) return true;
    } catch {
      // An unreadable file is not a marker.
    }
  }
  return false;
}

/** The ids whose recognizer accepts the files, in candidate order. */
export async function detectInstallation<T>(
  files: readonly InstallationProbeFile[],
  candidates: readonly {readonly id: T; readonly recognize: InstallationRecognizer}[],
): Promise<T[]> {
  const found: T[] = [];
  for (const candidate of candidates)
    if (await candidate.recognize(files)) found.push(candidate.id);
  return found;
}
