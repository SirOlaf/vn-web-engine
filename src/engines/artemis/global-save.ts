import {
  ArtemisSaveArchiveReader,
  ArtemisSaveArchiveWriter,
  type ArtemisSaveFile,
} from '../../formats/artemis/save-file.js';
import type {ArtemisVariables} from './variables.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});

/** Script field +0xb50: per-file sets of read caret tag indices (std::map of
 * unordered_set<int>), persisted in saveg.dat section 1. The frame loop marks them
 * (`ArtemisScript` host `beforeCaretTag`). */
export class ArtemisReadHistory {
  private readonly files = new Map<string, Set<number>>();
  entries(): [string, number[]][] {
    return [...this.files].map(([file, values]) => [file, [...values]]);
  }
  /** 0x1400ebb70 (map operator[]) then the set lookup: the file entry is created. */
  has(file: string, value: number): boolean {
    return this.entry(file).has(value >>> 0);
  }
  add(file: string, value: number): void {
    this.entry(file).add(value >>> 0);
  }
  private entry(file: string): Set<number> {
    let values = this.files.get(file);
    if (!values) this.files.set(file, (values = new Set()));
    return values;
  }
  /** Loaded file entry (native writers never repeat a file). */
  set(file: string, values: readonly number[]): void {
    this.files.set(file, new Set(values.map((value) => value >>> 0)));
  }
  clear(): void {
    this.files.clear();
  }
}

/** 0x14013ec90: section id, uint32 count, then name/value strings for the prefix. */
function writeVariables(
  archive: ArtemisSaveArchiveWriter,
  variables: ArtemisVariables,
  prefix: string,
  section: number,
): void {
  const entries = variables.globalEntries(prefix);
  archive.section(section);
  archive.u32(entries.length);
  for (const [name, value] of entries) {
    archive.string(encoder.encode(name));
    archive.string(value);
  }
}

/** 0x14013ef10 reads at the current offset; restored values do not mark g. dirty. */
function readVariables(archive: ArtemisSaveArchiveReader, variables: ArtemisVariables): void {
  for (let count = archive.u32(); count > 0; count--) {
    const name = decoder.decode(archive.string());
    variables.restore(name, archive.string());
  }
}

/** saveg.dat archive written by 0x14013f390: section 1 read history (uint32 count; file
 * string, uint32 count, uint32 values), then section 2 g. variables. */
export function writeArtemisGlobalArchive(
  history: ArtemisReadHistory,
  variables: ArtemisVariables,
): Uint8Array {
  const archive = new ArtemisSaveArchiveWriter();
  archive.section(1);
  const entries = history.entries();
  archive.u32(entries.length);
  for (const [file, values] of entries) {
    archive.string(encoder.encode(file));
    archive.u32(values.length);
    for (const value of values) archive.u32(value);
  }
  writeVariables(archive, variables, 'g.', 2);
  return archive.finish();
}

/** system.dat archive: section 1 s. variables. */
export function writeArtemisSystemArchive(variables: ArtemisVariables): Uint8Array {
  const archive = new ArtemisSaveArchiveWriter();
  writeVariables(archive, variables, 's.', 1);
  return archive.finish();
}

/** 0x14013fde0 archive dispatch for kinds G and X. G replaces the read history when
 * section 1 exists, then reads variables at the current offset; X reads variables from
 * the start. Scenario archives (S, 0x140141b10) belong to the scenario load owner. Other
 * kinds are ignored, as natively. */
export function readArtemisSaveArchive(
  file: ArtemisSaveFile,
  history: ArtemisReadHistory,
  variables: ArtemisVariables,
): void {
  const archive = new ArtemisSaveArchiveReader(file.archive);
  if (file.kind === 'G') {
    if (archive.seek(1)) {
      history.clear();
      for (let count = archive.u32(); count > 0; count--) {
        const name = decoder.decode(archive.string());
        const values: number[] = [];
        for (let count = archive.u32(); count > 0; count--) values.push(archive.u32());
        history.set(name, values);
      }
    }
    readVariables(archive, variables);
  } else if (file.kind === 'X') readVariables(archive, variables);
  else if (file.kind === 'S') throw new Error('Unsupported Artemis scenario save load');
}
