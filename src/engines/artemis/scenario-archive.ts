import type {AsbTag} from '../../formats/artemis/asb.js';
import type {
  ArtemisSaveArchiveReader,
  ArtemisSaveArchiveWriter,
} from '../../formats/artemis/save-file.js';
import type {ArtemisClickGlyph} from './click-glyph.js';
import type {ArtemisTweenDescriptor, ArtemisTweenParameter} from './scene-tweens.js';
import {artemisMapOrder} from './save-data.js';
import {
  emptyBlock,
  enter,
  readArtemisSaveObject,
  readArtemisScenarioVariableTable,
  readArtemisScriptBlock,
  readString,
  readTagVector,
  scoped,
  writeArtemisSaveObject,
  writeArtemisScenarioVariables,
  writeArtemisScriptBlock,
  writeString,
  writeTagVector,
  type ArtemisFontFrameCodec,
  type ArtemisSaveObjectState,
  type ArtemisScenarioVariableTable,
} from './scenario-save.js';
import type {ArtemisVariables} from './variables.js';

/** CArtemis::CCaret (script +0xb68 and each call-stack frame) as saved. */
export interface ArtemisCaretRecord {
  readonly file: string;
  readonly index: number;
  /** +0x108 / +0x10c: script run mode c70 and the previous mode c74. */
  readonly runMode: number;
  readonly previousRunMode: number;
  /** Any wait flag (+0x30..+0x33 timed/se waits, +0x5c video wait) is set. */
  readonly waiting: boolean;
  /** +0x80: pending tag queue. */
  readonly queue: readonly AsbTag[];
  /** +0xa8: copy of the tag at the caret index (an empty block past the end). */
  readonly tag: AsbTag;
}
/** A caret as read back: sections 1/2 land in +0x108/+0x10c, wait flags stay clear. */
export interface ArtemisLoadedCaret {
  readonly file: string;
  readonly index: number;
  readonly runMode: number;
  readonly previousRunMode: number;
  readonly queue: readonly AsbTag[];
  readonly tag: AsbTag;
}

/** CArtemis::CIconInfo 0x1400b6440: section 1 byte +8, section 2 string +0x10. */
export interface ArtemisIconInfo {
  readonly present: boolean;
  readonly name: string;
}

export type ArtemisSceneTweenSlot = 'in' | 'out' | 'show' | 'hide';
export type ArtemisBacklogTweenSlot =
  'backlog_down_in' | 'backlog_down_out' | 'backlog_up_in' | 'backlog_up_out';

/** CBackLog serializer 0x14011ef00 (section 0x1f). Pages and line histories are refused:
 * only an unused engine backlog with its tween vectors is represented. */
export interface ArtemisBacklogRecord {
  readonly tweens: Readonly<Record<ArtemisBacklogTweenSlot, readonly ArtemisTweenDescriptor[]>>;
}

/** Kind 'S' archive fields in writer 0x140140770 order. */
export interface ArtemisScenarioRecord<Font extends object> {
  /** 1, 0x48: automode allow +0x32 and automode +0x33. */
  readonly automodeAllowed: boolean;
  readonly automode: boolean;
  /** 0x13: +0x38 automode layer per message layer. */
  readonly automodeLayers: ReadonlyMap<string, ArtemisIconInfo>;
  /** 2, 0x49, 0x4a: +0x48 skip allow, +0x49 command skip, +0x4a control skip. */
  readonly skipAllowed: boolean;
  readonly commandSkip: boolean;
  readonly controlSkip: boolean;
  /** 0x24: +0xb38 macro file list. */
  readonly macroFiles: readonly string[];
  /** 0x47: +0xb60 already-read enable. */
  readonly alreadyRead: boolean;
  /** 3 and 4: the caret and the call stack (oldest first). */
  readonly caret: ArtemisCaretRecord;
  readonly callStack: readonly ArtemisCaretRecord[];
  /** 6, 0x33: +0xccb right-click allow, +0xcd0 right-click script. */
  readonly rightClickAllowed: boolean;
  readonly rightClickScript: string;
  /** 7, 8, 5: +0xcf0 byte, +0xcf4, +0xcf8 autosave mode. */
  readonly autosaveFlag: number;
  readonly autosaveValue: number;
  readonly autosave: number;
  /** 9, 0x27: +0x3524 DebugMode, +0x3528 DebugLevel. */
  readonly debugMode: number;
  readonly debugLevel: number;
  /** 0x39, 0x3a, 0x23: automode stop by click / stop, syncse list. */
  readonly stopAutoByClick: boolean;
  readonly stopAutoByStop: boolean;
  readonly syncSe: readonly string[];
  /** 0x44: +0x35b0 skip unread. */
  readonly skipUnread: boolean;
  /** 0x51, 0x52: +0x35b8 string, +0x35d8 u32. */
  readonly field35b8: string;
  readonly field35d8: number;
  /** 0xb, 0xc: current message layer and the chgmsg stack. */
  readonly currentMessageLayer: string;
  readonly messageSelection: readonly string[];
  /** 0x3f: +0x3628 font property. */
  readonly font: Font;
  /** 0xd, 0xe, 0x3b, 0x3c: +0x3730 in, +0x3740 out, +0x3750 show, +0x3760 hide. */
  readonly sceneTweens: Readonly<
    Record<ArtemisSceneTweenSlot, ReadonlyMap<string, readonly ArtemisTweenDescriptor[]>>
  >;
  /** 0xf, 0x10: +0x37b8 byte, +0x37c0 set. */
  readonly hideFlag: boolean;
  readonly hidden: readonly string[];
  /** 0x3e: +0x37d0 backlog message layer name. */
  readonly backlogLayer: string;
  /** 0x34, 0x3d, 0x11: +0x37f0 write backlog, +0x37f1, +0x37f2 backlog allow. */
  readonly writeBacklog: boolean;
  readonly backlogFlag: boolean;
  readonly backlogAllowed: boolean;
  /** 0x25, 0x14: +0x37f8 set, +0x3808 map. */
  readonly backlogNames: readonly string[];
  readonly backlogIcons: ReadonlyMap<string, ArtemisIconInfo>;
  /** 0x12: +0x3818 click glyph per message layer. */
  readonly glyphs: ReadonlyMap<string, Readonly<ArtemisClickGlyph>>;
  /** 0x4f: +0x3880. */
  readonly field3880: number;
  /** 0x38, 0x4e: setonpush maps +0x3890 (no key repeat) and +0x38a0. */
  readonly pushHandlers: readonly [ReadonlyMap<number, AsbTag>, ReadonlyMap<number, AsbTag>];
  /** 0x28..0x31: seton* slots +0x38b0..+0x3c10 (empty blocks when unset). */
  readonly eventSlots: readonly AsbTag[];
  /** 0x53: +0x3c70 window buttons. */
  readonly windowButtons: ReadonlyMap<number, AsbTag>;
  /** 0x4d, 0x21: blocks +0x3c80, +0x3ce0. */
  readonly block3c80: AsbTag;
  readonly block3ce0: AsbTag;
  /** 0x22, 0x26, 0x32, 0x45, 0x46, 0x54, 0x50: strings +0x3d98..+0x3e58. */
  readonly luaEventNames: readonly string[];
  readonly saveObject: ArtemisSaveObjectState<Font>;
  /** 0x41: CArtemisKeyConfig ordinary keys per role. */
  readonly keyRoles: ReadonlyMap<number, readonly number[]>;
  /** 0x40: names of message layers with flag [10]. */
  readonly layeredNames: readonly string[];
  /** 0x1f: present only for saves with transient state. */
  readonly backlog: ArtemisBacklogRecord | null;
}

/** A read archive: absent sections are undefined (the loader keeps the reset value). */
export type ArtemisLoadedScenario<Font extends object> = {
  -readonly [
    K in Exclude<keyof ArtemisScenarioRecord<Font>, 'caret' | 'callStack' | 'saveObject'>
  ]?: ArtemisScenarioRecord<Font>[K];
} & {
  caret?: ArtemisLoadedCaret;
  callStack?: readonly ArtemisLoadedCaret[];
  saveObject: ArtemisSaveObjectState<Font>;
  variables: ArtemisScenarioVariableTable | null;
};

const EVENT_SLOT_SECTIONS = [0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31];
const LUA_EVENT_SECTIONS = [0x22, 0x26, 0x32, 0x45, 0x46, 0x54, 0x50];
const SCENE_TWEEN_SECTIONS: readonly [ArtemisSceneTweenSlot, number][] = [
  ['in', 0xd],
  ['out', 0xe],
  ['show', 0x3b],
  ['hide', 0x3c],
];
const BACKLOG_TWEEN_SECTIONS: readonly [ArtemisBacklogTweenSlot, number][] = [
  ['backlog_down_in', 3],
  ['backlog_down_out', 4],
  ['backlog_up_in', 5],
  ['backlog_up_out', 6],
];
const TWEEN_PARAMETERS: readonly ArtemisTweenParameter[] = [
  'left',
  'top',
  'alpha',
  'xscale',
  'yscale',
  'rotate',
  'unknown',
];

const bool = (archive: ArtemisSaveArchiveWriter, id: number, value: boolean) => {
  archive.section(id);
  archive.u8(value ? 1 : 0);
};
const u32 = (archive: ArtemisSaveArchiveWriter, id: number, value: number) => {
  archive.section(id);
  archive.u32(value >>> 0);
};
const text = (archive: ArtemisSaveArchiveWriter, id: number, value: string) => {
  archive.section(id);
  writeString(archive, value);
};
const strings = (archive: ArtemisSaveArchiveWriter, id: number, values: readonly string[]) => {
  archive.section(id);
  archive.u32(values.length);
  for (const value of values) writeString(archive, value);
};
const block = (archive: ArtemisSaveArchiveWriter, id: number, tag: AsbTag) => {
  archive.section(id, true);
  writeArtemisScriptBlock(archive, tag);
  archive.close();
};
const byteOrder = (values: readonly string[]) =>
  artemisMapOrder(new Map(values.map((value) => [value, value]))).map(([value]) => value);

/** CCaret writer 0x1400b5c00: without a wait flag section 1 is the run mode, or the
 * previous mode for modes 5 and above; with one, section 1 is 0 and section 2 the run mode. */
export function writeArtemisCaret(archive: ArtemisSaveArchiveWriter, caret: ArtemisCaretRecord) {
  const [first, second] = caret.waiting
    ? [0, caret.runMode]
    : [caret.runMode >>> 0 < 5 ? caret.runMode : caret.previousRunMode, caret.previousRunMode];
  u32(archive, 1, first);
  u32(archive, 2, second);
  text(archive, 3, caret.file);
  u32(archive, 4, caret.index);
  archive.section(6);
  writeTagVector(archive, caret.queue);
  block(archive, 8, caret.tag);
}
/** CCaret reader 0x1400b5e50. Section 5 (+0x2c, the timed-wait deadline) is accepted by
 * the reader but never written; a nonzero value is refused. */
export function readArtemisCaret(archive: ArtemisSaveArchiveReader): ArtemisLoadedCaret {
  const runMode = archive.seek(1) ? archive.u32() : 0;
  const previousRunMode = archive.seek(2) ? archive.u32() : 0;
  const file = archive.seek(3) ? readString(archive) : '';
  const index = archive.seek(4) ? archive.u32() : 0;
  const queue = archive.seek(6) ? readTagVector(archive) : [];
  let tag = emptyBlock;
  if (archive.seek(8, true)) {
    tag = readArtemisScriptBlock(archive);
    archive.close();
  }
  if (archive.seek(5) && archive.u32()) throw Error('Unsupported Artemis saved caret deadline');
  return {file, index, runMode, previousRunMode, queue, tag};
}

function writeIconMap(
  archive: ArtemisSaveArchiveWriter,
  id: number,
  map: ReadonlyMap<string, ArtemisIconInfo>,
): void {
  archive.section(id);
  const entries = artemisMapOrder(map);
  archive.u32(entries.length);
  for (const [key, icon] of entries) {
    writeString(archive, key);
    scoped(archive, () => {
      bool(archive, 1, icon.present);
      text(archive, 2, icon.name);
    });
  }
}
function readIconMap(archive: ArtemisSaveArchiveReader, id: number) {
  if (!archive.seek(id)) return undefined;
  const map = new Map<string, ArtemisIconInfo>();
  for (let count = archive.u32(); count > 0; count--) {
    const key = readString(archive);
    map.set(
      key,
      enter(archive, () => ({
        present: archive.seek(1) ? archive.u8() !== 0 : false,
        name: archive.seek(2) ? readString(archive) : '',
      })),
    );
  }
  return map;
}

/** CGlyphInfo 0x1400b6020: bytes 1..3 (+8 homing, +9 layer, +0xa rplayer), strings 4/5
 * (+0x10, +0x30), then the two TPoint<int> (+0x50, +0x60) x/y in sections 6..9. */
function writeGlyph(archive: ArtemisSaveArchiveWriter, glyph: Readonly<ArtemisClickGlyph>) {
  bool(archive, 1, glyph.homing);
  bool(archive, 2, glyph.layer);
  bool(archive, 3, glyph.rplayer);
  text(archive, 4, glyph.layerName);
  text(archive, 5, glyph.rplayerName);
  u32(archive, 6, glyph.left);
  u32(archive, 7, glyph.top);
  u32(archive, 8, glyph.rpleft);
  u32(archive, 9, glyph.rptop);
}
function readGlyph(archive: ArtemisSaveArchiveReader): ArtemisClickGlyph {
  const byte = (id: number) => (archive.seek(id) ? archive.u8() !== 0 : false);
  const word = (id: number) => (archive.seek(id) ? archive.u32() | 0 : 0);
  const name = (id: number) => (archive.seek(id) ? readString(archive) : '');
  return {
    homing: byte(1),
    layer: byte(2),
    rplayer: byte(3),
    layerName: name(4),
    rplayerName: name(5),
    left: word(6),
    top: word(7),
    rpleft: word(8),
    rptop: word(9),
  };
}

/** 0x140122c60 CTweenInfo vector: section(id), u32 count, each element in a scoped
 * section written by CTweenInfoSerializer 0x14013e5c0: section 10 u32 1, then 5 parameter
 * (+0), 8 entire byte (+4), 4 ease (+8), 3 diff float bits (+0xc), 7 time (+0x10),
 * 6 delay (+0x14), 9 random delay byte (+0x18), 2 the always-zero +0x1c, 1 outgoing (+0x20). */
function writeTweens(
  archive: ArtemisSaveArchiveWriter,
  id: number,
  tweens: readonly ArtemisTweenDescriptor[],
): void {
  archive.section(id);
  writeTweenVector(archive, tweens);
}
function writeTweenVector(
  archive: ArtemisSaveArchiveWriter,
  tweens: readonly ArtemisTweenDescriptor[],
): void {
  const bits = new DataView(new ArrayBuffer(4));
  archive.u32(tweens.length);
  for (const tween of tweens)
    scoped(archive, () => {
      u32(archive, 10, 1);
      u32(archive, 5, TWEEN_PARAMETERS.indexOf(tween.parameter));
      bool(archive, 8, tween.entire);
      u32(archive, 4, tween.ease);
      bits.setFloat32(0, tween.diff, true);
      u32(archive, 3, bits.getUint32(0, true));
      u32(archive, 7, tween.time);
      u32(archive, 6, tween.delay);
      bool(archive, 9, tween.randomDelay);
      u32(archive, 2, 0);
      bool(archive, 1, tween.outgoing);
    });
}
function readTweenVector(archive: ArtemisSaveArchiveReader): ArtemisTweenDescriptor[] {
  const bits = new DataView(new ArrayBuffer(4));
  const tweens: ArtemisTweenDescriptor[] = [];
  for (let count = archive.u32(); count > 0; count--)
    tweens.push(
      enter(archive, () => {
        if (!archive.seek(10) || archive.u32() !== 1)
          throw Error('Unsupported Artemis saved tween serializer');
        const word = (id: number) => (archive.seek(id) ? archive.u32() : 0);
        const byte = (id: number) => (archive.seek(id) ? archive.u8() !== 0 : false);
        const parameter = TWEEN_PARAMETERS[word(5)];
        if (!parameter || word(2)) throw Error('Unsupported Artemis saved tween');
        bits.setUint32(0, word(3), true);
        return Object.freeze({
          parameter,
          entire: byte(8),
          ease: word(4),
          diff: bits.getFloat32(0, true),
          time: word(7) | 0,
          delay: word(6) | 0,
          randomDelay: byte(9),
          outgoing: byte(1),
        });
      }),
    );
  return tweens;
}
/** 0x140146ae0 map<string, CTweenInfo vector>. */
function writeTweenMap(
  archive: ArtemisSaveArchiveWriter,
  id: number,
  map: ReadonlyMap<string, readonly ArtemisTweenDescriptor[]>,
): void {
  archive.section(id);
  const entries = artemisMapOrder(map);
  archive.u32(entries.length);
  for (const [key, tweens] of entries) {
    // Key and vector are written with section id 0 (unnamed, unscoped).
    writeString(archive, key);
    writeTweenVector(archive, tweens);
  }
}
function readTweenMap(archive: ArtemisSaveArchiveReader, id: number) {
  if (!archive.seek(id)) return undefined;
  const map = new Map<string, ArtemisTweenDescriptor[]>();
  for (let count = archive.u32(); count > 0; count--) {
    const key = readString(archive);
    map.set(key, readTweenVector(archive));
  }
  return map;
}

/** 0x140146cc0 map<int, CScriptBlock> in ascending signed key order. */
function writeIntBlockMap(
  archive: ArtemisSaveArchiveWriter,
  id: number,
  map: ReadonlyMap<number, AsbTag>,
): void {
  archive.section(id);
  const entries = [...map].sort(([a], [b]) => a - b);
  archive.u32(entries.length);
  for (const [key, tag] of entries) {
    archive.u32(key >>> 0);
    scoped(archive, () => writeArtemisScriptBlock(archive, tag));
  }
}
function readIntBlockMap(archive: ArtemisSaveArchiveReader, id: number) {
  if (!archive.seek(id)) return undefined;
  const map = new Map<number, AsbTag>();
  for (let count = archive.u32(); count > 0; count--) {
    const key = archive.u32() | 0;
    map.set(
      key,
      enter(archive, () => readArtemisScriptBlock(archive)),
    );
  }
  return map;
}

/** CArtemisKeyConfig 0x1400f4f90 (section 1 inside scoped section 0x41). */
function writeKeyRoles(
  archive: ArtemisSaveArchiveWriter,
  roles: ReadonlyMap<number, readonly number[]>,
): void {
  archive.section(0x41, true);
  archive.section(1);
  const entries = [...roles].sort(([a], [b]) => a - b);
  archive.u32(entries.length);
  for (const [role, keys] of entries) {
    archive.u32(role >>> 0);
    const sorted = [...new Set(keys)].sort((a, b) => a - b);
    archive.u32(sorted.length);
    for (const key of sorted) archive.u32(key >>> 0);
  }
  archive.close();
}
function readKeyRoles(archive: ArtemisSaveArchiveReader) {
  if (!archive.seek(0x41, true)) return undefined;
  const roles = new Map<number, number[]>();
  if (archive.seek(1))
    for (let count = archive.u32(); count > 0; count--) {
      const role = archive.u32() | 0;
      const keys: number[] = [];
      for (let size = archive.u32(); size > 0; size--) keys.push(archive.u32() | 0);
      roles.set(role, keys);
    }
  archive.close();
  return roles;
}

function writeBacklog(archive: ArtemisSaveArchiveWriter, backlog: ArtemisBacklogRecord) {
  archive.section(0x1f, true);
  // Page deque (7), tag-deque history (1) and tag-vector history (2): all empty.
  u32(archive, 7, 0);
  u32(archive, 1, 0);
  u32(archive, 2, 0);
  for (const [slot, id] of BACKLOG_TWEEN_SECTIONS) writeTweens(archive, id, backlog.tweens[slot]);
  archive.close();
}
function readBacklog(archive: ArtemisSaveArchiveReader): ArtemisBacklogRecord | undefined {
  if (!archive.seek(0x1f, true)) return undefined;
  for (const id of [7, 1, 2])
    if (archive.seek(id) && archive.u32()) throw Error('Unsupported Artemis saved backlog pages');
  const tweens = Object.fromEntries(
    BACKLOG_TWEEN_SECTIONS.map(([slot, id]) => [
      slot,
      archive.seek(id) ? readTweenVector(archive) : [],
    ]),
  ) as Record<ArtemisBacklogTweenSlot, ArtemisTweenDescriptor[]>;
  archive.close();
  return {tweens};
}

/** Writer 0x140140770: every section in native order. The font codec serializes both the
 * +0x3628 font property and the saved font frames. */
export function writeArtemisScenarioArchive<Font extends object>(
  archive: ArtemisSaveArchiveWriter,
  record: ArtemisScenarioRecord<Font>,
  variables: ArtemisVariables,
  fonts: ArtemisFontFrameCodec<Font>,
): void {
  if (record.luaEventNames.length !== LUA_EVENT_SECTIONS.length)
    throw Error('Artemis scenario save requires seven Lua event names');
  if (record.eventSlots.length !== EVENT_SLOT_SECTIONS.length)
    throw Error('Artemis scenario save requires ten event slots');
  bool(archive, 1, record.automodeAllowed);
  bool(archive, 0x48, record.automode);
  writeIconMap(archive, 0x13, record.automodeLayers);
  bool(archive, 2, record.skipAllowed);
  bool(archive, 0x49, record.commandSkip);
  bool(archive, 0x4a, record.controlSkip);
  strings(archive, 0x24, record.macroFiles);
  bool(archive, 0x47, record.alreadyRead);
  archive.section(3, true);
  writeArtemisCaret(archive, record.caret);
  archive.close();
  archive.section(4);
  archive.u32(record.callStack.length);
  for (const frame of record.callStack) scoped(archive, () => writeArtemisCaret(archive, frame));
  bool(archive, 6, record.rightClickAllowed);
  text(archive, 0x33, record.rightClickScript);
  archive.section(7);
  archive.u8(record.autosaveFlag);
  u32(archive, 8, record.autosaveValue);
  u32(archive, 5, record.autosave);
  u32(archive, 9, record.debugMode);
  u32(archive, 0x27, record.debugLevel);
  bool(archive, 0x39, record.stopAutoByClick);
  bool(archive, 0x3a, record.stopAutoByStop);
  strings(archive, 0x23, record.syncSe);
  bool(archive, 0x44, record.skipUnread);
  text(archive, 0x51, record.field35b8);
  u32(archive, 0x52, record.field35d8);
  text(archive, 0xb, record.currentMessageLayer);
  strings(archive, 0xc, record.messageSelection);
  archive.section(0x3f, true);
  fonts.write(archive, record.font);
  archive.close();
  for (const [slot, id] of SCENE_TWEEN_SECTIONS)
    writeTweenMap(archive, id, record.sceneTweens[slot]);
  bool(archive, 0xf, record.hideFlag);
  strings(archive, 0x10, byteOrder(record.hidden));
  text(archive, 0x3e, record.backlogLayer);
  bool(archive, 0x34, record.writeBacklog);
  bool(archive, 0x3d, record.backlogFlag);
  bool(archive, 0x11, record.backlogAllowed);
  strings(archive, 0x25, byteOrder(record.backlogNames));
  writeIconMap(archive, 0x14, record.backlogIcons);
  archive.section(0x12);
  const glyphs = artemisMapOrder(record.glyphs);
  archive.u32(glyphs.length);
  for (const [key, glyph] of glyphs) {
    writeString(archive, key);
    scoped(archive, () => writeGlyph(archive, glyph));
  }
  u32(archive, 0x4f, record.field3880);
  writeIntBlockMap(archive, 0x38, record.pushHandlers[0]);
  writeIntBlockMap(archive, 0x4e, record.pushHandlers[1]);
  EVENT_SLOT_SECTIONS.forEach((id, index) => block(archive, id, record.eventSlots[index]!));
  writeIntBlockMap(archive, 0x53, record.windowButtons);
  block(archive, 0x4d, record.block3c80);
  block(archive, 0x21, record.block3ce0);
  LUA_EVENT_SECTIONS.forEach((id, index) => text(archive, id, record.luaEventNames[index]!));
  writeArtemisSaveObject(archive, record.saveObject, fonts);
  writeKeyRoles(archive, record.keyRoles);
  writeArtemisScenarioVariables(archive, variables);
  strings(archive, 0x40, record.layeredNames);
  if (record.backlog) writeBacklog(archive, record.backlog);
}

/** Loader 0x140141b10 section reads, decoded without applying them. */
export function readArtemisScenarioArchive<Font extends object>(
  archive: ArtemisSaveArchiveReader,
  fonts: ArtemisFontFrameCodec<Font>,
): ArtemisLoadedScenario<Font> {
  const byte = (id: number) => (archive.seek(id) ? archive.u8() !== 0 : undefined);
  const word = (id: number) => (archive.seek(id) ? archive.u32() : undefined);
  const name = (id: number) => (archive.seek(id) ? readString(archive) : undefined);
  const list = (id: number) => {
    if (!archive.seek(id)) return undefined;
    const values: string[] = [];
    for (let count = archive.u32(); count > 0; count--) values.push(readString(archive));
    return values;
  };
  const tag = (id: number) => {
    if (!archive.seek(id, true)) return undefined;
    const value = readArtemisScriptBlock(archive);
    archive.close();
    return value;
  };
  const loaded: Partial<ArtemisLoadedScenario<Font>> = {};
  loaded.automodeAllowed = byte(1);
  loaded.automode = byte(0x48);
  loaded.automodeLayers = readIconMap(archive, 0x13);
  loaded.skipAllowed = byte(2);
  loaded.commandSkip = byte(0x49);
  loaded.controlSkip = byte(0x4a);
  loaded.macroFiles = list(0x24);
  loaded.alreadyRead = byte(0x47);
  if (archive.seek(3, true)) {
    loaded.caret = readArtemisCaret(archive);
    archive.close();
  }
  if (archive.seek(4)) {
    const frames: ArtemisLoadedCaret[] = [];
    for (let count = archive.u32(); count > 0; count--)
      frames.push(enter(archive, () => readArtemisCaret(archive)));
    loaded.callStack = frames;
  }
  loaded.rightClickAllowed = byte(6);
  loaded.rightClickScript = name(0x33);
  loaded.autosaveFlag = archive.seek(7) ? archive.u8() : undefined;
  loaded.autosaveValue = word(8);
  loaded.autosave = word(5);
  loaded.debugMode = word(9);
  loaded.debugLevel = word(0x27);
  loaded.stopAutoByClick = byte(0x39);
  loaded.stopAutoByStop = byte(0x3a);
  loaded.syncSe = list(0x23);
  loaded.skipUnread = byte(0x44);
  loaded.field35b8 = name(0x51);
  loaded.field35d8 = word(0x52);
  loaded.currentMessageLayer = name(0xb);
  loaded.messageSelection = list(0xc);
  if (archive.seek(0x3f, true)) {
    loaded.font = fonts.read(archive);
    archive.close();
  }
  const tweens: Partial<Record<ArtemisSceneTweenSlot, Map<string, ArtemisTweenDescriptor[]>>> = {};
  for (const [slot, id] of SCENE_TWEEN_SECTIONS) {
    const map = readTweenMap(archive, id);
    if (map) tweens[slot] = map;
  }
  if (Object.keys(tweens).length)
    loaded.sceneTweens = {
      in: tweens.in ?? new Map(),
      out: tweens.out ?? new Map(),
      show: tweens.show ?? new Map(),
      hide: tweens.hide ?? new Map(),
    };
  loaded.hideFlag = byte(0xf);
  loaded.hidden = list(0x10);
  loaded.backlogLayer = name(0x3e);
  loaded.writeBacklog = byte(0x34);
  loaded.backlogFlag = byte(0x3d);
  loaded.backlogAllowed = byte(0x11);
  loaded.backlogNames = list(0x25);
  loaded.backlogIcons = readIconMap(archive, 0x14);
  if (archive.seek(0x12)) {
    const glyphs = new Map<string, ArtemisClickGlyph>();
    for (let count = archive.u32(); count > 0; count--) {
      const key = readString(archive);
      glyphs.set(
        key,
        enter(archive, () => readGlyph(archive)),
      );
    }
    loaded.glyphs = glyphs;
  }
  loaded.field3880 = word(0x4f);
  const push0 = readIntBlockMap(archive, 0x38),
    push1 = readIntBlockMap(archive, 0x4e);
  if (push0 || push1) loaded.pushHandlers = [push0 ?? new Map(), push1 ?? new Map()];
  const slots = EVENT_SLOT_SECTIONS.map(tag);
  if (slots.some((slot) => slot)) loaded.eventSlots = slots.map((slot) => slot ?? emptyBlock);
  loaded.windowButtons = readIntBlockMap(archive, 0x53);
  loaded.block3c80 = tag(0x4d);
  loaded.block3ce0 = tag(0x21);
  const events = LUA_EVENT_SECTIONS.map(name);
  if (events.some((event) => event !== undefined))
    loaded.luaEventNames = events.map((event) => event ?? '');
  loaded.saveObject = readArtemisSaveObject(archive, fonts);
  loaded.keyRoles = readKeyRoles(archive);
  loaded.variables = readArtemisScenarioVariableTable(archive);
  loaded.layeredNames = list(0x40);
  loaded.backlog = readBacklog(archive);
  for (const key of Object.keys(loaded) as (keyof typeof loaded)[])
    if (loaded[key] === undefined) delete loaded[key];
  return loaded as ArtemisLoadedScenario<Font>;
}
