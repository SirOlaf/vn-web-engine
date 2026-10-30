import type {AsbTag} from '../../formats/artemis/asb.js';
import type {
  ArtemisSaveArchiveReader,
  ArtemisSaveArchiveWriter,
} from '../../formats/artemis/save-file.js';
import type {ArtemisMusicHistory} from './music.js';
import type {ArtemisVariables} from './variables.js';
import {artemisMapOrder, type ArtemisSaveDataSnapshot} from './save-data.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});

/** Save-object part of a kind 'S' archive (sections 0x18..0x1d of writer 0x140140770). */
export interface ArtemisSaveObjectState<Font extends object> {
  readonly data: ArtemisSaveDataSnapshot<Font>;
  readonly layerCommands: ReadonlyMap<string, readonly AsbTag[]>;
  readonly music: ArtemisMusicHistory;
}

/** Serializer of one font-stack frame (the script +0x3708 deque element, vtbl+8). */
export interface ArtemisFontFrameCodec<Font extends object> {
  write(archive: ArtemisSaveArchiveWriter, frame: Readonly<Font>): void;
  read(archive: ArtemisSaveArchiveReader): Font;
}

/** 0x14009d150: unnamed section, u32 length, bytes. */
export function writeString(archive: ArtemisSaveArchiveWriter, value: string): void {
  archive.string(encoder.encode(value));
}
export function readString(archive: ArtemisSaveArchiveReader): string {
  return decoder.decode(archive.string());
}

/** CScriptBlock 0x1400a2a50: section 2 u32 line, section 3 name, section 4 u32 count and
 * key/value strings in std::map order. */
export function writeArtemisScriptBlock(archive: ArtemisSaveArchiveWriter, tag: AsbTag): void {
  archive.section(2);
  archive.u32(tag.sourceLine >>> 0);
  archive.section(3);
  writeString(archive, tag.name);
  archive.section(4);
  const args = artemisMapOrder(tag.args);
  archive.u32(args.length);
  for (const [key, value] of args) {
    const bytes = tag.bytes?.get(key);
    writeString(archive, key);
    if (bytes) archive.string(bytes);
    else writeString(archive, value);
  }
}
/** Sections missing from the block keep the empty constructor values. */
export function readArtemisScriptBlock(archive: ArtemisSaveArchiveReader): AsbTag {
  const line = archive.seek(2) ? archive.u32() | 0 : 0;
  const name = archive.seek(3) ? readString(archive) : '';
  const args = new Map<string, string>();
  if (archive.seek(4))
    for (let count = archive.u32(); count > 0; count--) {
      const key = readString(archive);
      args.set(key, readString(archive));
    }
  return {kind: 'tag', name, sourceLine: line, args};
}

/** Scoped unnamed object section: 0x140008940(archive, 0, 1) … 0x1400a2290. */
export function scoped(archive: ArtemisSaveArchiveWriter, write: () => void): void {
  archive.section(0, true);
  write();
  archive.close();
}
export function enter<T>(archive: ArtemisSaveArchiveReader, read: () => T): T {
  archive.seek(0, true);
  const value = read();
  archive.close();
  return value;
}

/** 0x140123c70: u32 count, each block scoped. */
export function writeTagVector(archive: ArtemisSaveArchiveWriter, tags: readonly AsbTag[]): void {
  archive.u32(tags.length);
  for (const tag of tags) scoped(archive, () => writeArtemisScriptBlock(archive, tag));
}
export function readTagVector(archive: ArtemisSaveArchiveReader): AsbTag[] {
  const tags: AsbTag[] = [];
  for (let count = archive.u32(); count > 0; count--)
    tags.push(enter(archive, () => readArtemisScriptBlock(archive)));
  return tags;
}

/** 0x140146e00 map<string, tag vector> and 0x1401469c0 map<string, CScriptBlock>. */
function writeTagVectorMap(
  archive: ArtemisSaveArchiveWriter,
  id: number,
  map: ReadonlyMap<string, readonly AsbTag[]>,
): void {
  archive.section(id);
  const entries = artemisMapOrder(map);
  archive.u32(entries.length);
  for (const [key, tags] of entries) {
    writeString(archive, key);
    writeTagVector(archive, tags);
  }
}
function readTagVectorMap(archive: ArtemisSaveArchiveReader, id: number): Map<string, AsbTag[]> {
  const map = new Map<string, AsbTag[]>();
  if (!archive.seek(id)) return map;
  for (let count = archive.u32(); count > 0; count--) {
    const key = readString(archive);
    map.set(key, readTagVector(archive));
  }
  return map;
}
function writeBlockMap(
  archive: ArtemisSaveArchiveWriter,
  id: number,
  map: ReadonlyMap<string, AsbTag | null>,
): void {
  archive.section(id);
  const entries = artemisMapOrder(map);
  archive.u32(entries.length);
  for (const [key, tag] of entries) {
    writeString(archive, key);
    scoped(archive, () => writeArtemisScriptBlock(archive, tag ?? emptyBlock));
  }
}
function readBlockMap(archive: ArtemisSaveArchiveReader, id: number): Map<string, AsbTag> {
  const map = new Map<string, AsbTag>();
  if (!archive.seek(id)) return map;
  for (let count = archive.u32(); count > 0; count--) {
    const key = readString(archive);
    map.set(
      key,
      enter(archive, () => readArtemisScriptBlock(archive)),
    );
  }
  return map;
}
export const emptyBlock: AsbTag = {kind: 'tag', name: '', sourceLine: 0, args: new Map()};

/** Writer 0x140140770 sections for the save object (script +0xd0), in native order:
 * 0x18 +0x08 text, 0x19 +0x18 font frames, 0x42/0x43/0x4b/0x4c +0x28/+0x38/+0x48/+0x58,
 * 0x1a +0x68 layer commands, 0x35 +0x78 se, 0x1c +0x88 BGM flag and, when set, 0x1d the
 * scoped +0x90 BGM block. */
export function writeArtemisSaveObject<Font extends object>(
  archive: ArtemisSaveArchiveWriter,
  state: ArtemisSaveObjectState<Font>,
  fonts: ArtemisFontFrameCodec<Font>,
): void {
  const {data} = state;
  writeTagVectorMap(archive, 0x18, data.text);
  archive.section(0x19);
  const frames = artemisMapOrder(data.fonts);
  archive.u32(frames.length);
  for (const [key, list] of frames) {
    writeString(archive, key);
    // 0x140123ba0 deque<object>.
    archive.u32(list.length);
    for (const frame of list) scoped(archive, () => fonts.write(archive, frame));
  }
  writeBlockMap(archive, 0x42, data.retainedIndent);
  writeBlockMap(archive, 0x43, data.pendingIndent);
  writeBlockMap(archive, 0x4b, data.retainedProhibit);
  writeBlockMap(archive, 0x4c, data.pendingProhibit);
  writeTagVectorMap(archive, 0x1a, state.layerCommands);
  writeBlockMap(archive, 0x35, data.effects);
  archive.section(0x1c);
  archive.u8(state.music.playing ? 1 : 0);
  if (state.music.playing) {
    archive.section(0x1d, true);
    writeArtemisScriptBlock(archive, state.music.tag);
    archive.close();
  }
}

/** Loader 0x140141b10 reads of the same sections; a missing section keeps the reset
 * (empty) value. Se entries are read back as blocks; an empty name is a non-loop entry. */
export function readArtemisSaveObject<Font extends object>(
  archive: ArtemisSaveArchiveReader,
  fonts: ArtemisFontFrameCodec<Font>,
): ArtemisSaveObjectState<Font> {
  const text = readTagVectorMap(archive, 0x18);
  const fontFrames = new Map<string, Font[]>();
  if (archive.seek(0x19))
    for (let count = archive.u32(); count > 0; count--) {
      const key = readString(archive);
      const list: Font[] = [];
      for (let frames = archive.u32(); frames > 0; frames--)
        list.push(enter(archive, () => fonts.read(archive)));
      fontFrames.set(key, list);
    }
  const retainedIndent = readBlockMap(archive, 0x42),
    pendingIndent = readBlockMap(archive, 0x43),
    retainedProhibit = readBlockMap(archive, 0x4b),
    pendingProhibit = readBlockMap(archive, 0x4c);
  const layerCommands = readTagVectorMap(archive, 0x1a);
  const effects = new Map<string, AsbTag | null>(
    [...readBlockMap(archive, 0x35)].map(([key, tag]) => [
      key,
      tag.name || tag.args.size ? tag : null,
    ]),
  );
  let music: ArtemisMusicHistory = {playing: false, tag: emptyBlock};
  if (archive.seek(0x1c) && archive.u8()) {
    let tag = emptyBlock;
    if (archive.seek(0x1d, true)) {
      tag = readArtemisScriptBlock(archive);
      archive.close();
    }
    music = {playing: true, tag};
  }
  return {
    data: {
      text,
      fonts: fontFrames,
      retainedIndent,
      pendingIndent,
      retainedProhibit,
      pendingProhibit,
      effects,
    },
    layerCommands,
    music,
  };
}

/** Expression quote set (CCompute +0x38) after script initialization: "'" only. */
const QUOTES = [0x27];

type VariableEntries = readonly (readonly [string, Uint8Array])[];
/** CArtemisVariables serializer 0x1400aff10 for one table: section 1 the quote set (u32
 * count, a byte per element), section 2 the variables (u32 count, name/value strings),
 * section 3 the local frames (u32 count, each frame serialized the same way in a scoped
 * section; a frame's own quote set is empty). */
function writeVariableTable(
  archive: ArtemisSaveArchiveWriter,
  quotes: readonly number[],
  entries: VariableEntries,
  locals: readonly VariableEntries[],
): void {
  archive.section(1);
  archive.u32(quotes.length);
  for (const quote of quotes) archive.u8(quote);
  archive.section(2);
  archive.u32(entries.length);
  for (const [name, value] of entries) {
    writeString(archive, name);
    archive.string(value);
  }
  archive.section(3);
  archive.u32(locals.length);
  for (const frame of locals) scoped(archive, () => writeVariableTable(archive, [], frame, []));
}
interface VariableTable {
  quotes: number[] | null;
  entries: [string, Uint8Array][];
  locals: VariableTable[] | null;
}
/** 0x1400b0370 sections; null marks an absent quote set or frame list. */
function readVariableTable(archive: ArtemisSaveArchiveReader): VariableTable {
  let quotes: number[] | null = null;
  if (archive.seek(1)) {
    quotes = [];
    for (let count = archive.u32(); count > 0; count--) quotes.push(archive.u8());
  }
  const entries: [string, Uint8Array][] = [];
  if (archive.seek(2))
    for (let count = archive.u32(); count > 0; count--) {
      const name = readString(archive);
      entries.push([name, archive.string()]);
    }
  let locals: VariableTable[] | null = null;
  if (archive.seek(3)) {
    locals = [];
    for (let count = archive.u32(); count > 0; count--)
      locals.push(enter(archive, () => readVariableTable(archive)));
  }
  return {quotes, entries, locals};
}

/** Scoped section 0x1e of writer 0x140140770: the script variables (script+0xb0)+0x68. */
export function writeArtemisScenarioVariables(
  archive: ArtemisSaveArchiveWriter,
  variables: ArtemisVariables,
): void {
  const {global, locals} = variables.scenarioEntries();
  archive.section(0x1e, true);
  writeVariableTable(archive, QUOTES, global, locals);
  archive.close();
}
export interface ArtemisScenarioVariableTable {
  readonly global: readonly (readonly [string, Uint8Array])[];
  readonly locals: readonly (readonly (readonly [string, Uint8Array])[])[];
}
/** Loader read of section 0x1e; null when the section is absent. A quote set other than
 * the initialized one is refused: the expression evaluator has a fixed "'" quote. */
export function readArtemisScenarioVariableTable(
  archive: ArtemisSaveArchiveReader,
): ArtemisScenarioVariableTable | null {
  if (!archive.seek(0x1e, true)) return null;
  const table = readVariableTable(archive);
  archive.close();
  const sameQuotes = (quotes: number[] | null) =>
    quotes === null || (quotes.length === QUOTES.length && quotes.every((q, i) => q === QUOTES[i]));
  if (!sameQuotes(table.quotes)) throw new Error('Unsupported Artemis saved expression quotes');
  for (const frame of table.locals ?? [])
    if (frame.quotes?.length || frame.locals?.length)
      throw new Error('Unsupported Artemis saved local variable frame');
  // Native destroys the current frames before checking section 3 and clears the deque only
  // when it exists; an archive without it would leave dangling frames.
  if (!table.locals) throw new Error('Unsupported Artemis saved variables without local frames');
  return {global: table.entries, locals: table.locals.map((frame) => frame.entries)};
}
export function readArtemisScenarioVariables(
  archive: ArtemisSaveArchiveReader,
  variables: ArtemisVariables,
): void {
  const table = readArtemisScenarioVariableTable(archive);
  if (table) variables.restoreScenario(table.global, table.locals);
}
