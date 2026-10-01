import type {GscOpcodeLayouts} from '../../formats/rscript/gsc.js';
import {readPeVersionStrings} from '../../formats/pe/version-info.js';
import {RSCRIPT_1_11_LAYOUTS, RSCRIPT_1_9_LAYOUTS} from './vm/layouts.js';

/**
 * Offsets of `APINI` fields read by the engine. 1.9 has a 31-byte title, so every later
 * field sits 20 bytes earlier; its block ends with fields that 1.11 moved behind new ones.
 */
export interface RScriptApiniLayout {
  readonly size: number;
  readonly titleLength: number;
  readonly savePrefix: number;
  readonly saveDirectory: number;
  /** Scripts, system, system alternate, sprites, faces, events, movies, sounds, music, voices. */
  readonly directories: number;
  readonly fontName: number;
  readonly width: number;
  readonly height: number;
  readonly tick: number;
  readonly skipTopMenu: number;
  readonly startScript: number;
  readonly defaultLayerKind: number;
  readonly keepBackdropBrightness: number;
  readonly savePageCount: number;
  /** Ten 0xRRGGBB colours for `^C0`..`^C9`. */
  readonly palette: number;
  readonly choiceTextColor: number;
  readonly choiceTextSize: number;
  readonly saveDateSize: number;
  /** Message text shadow flag; absent from 1.9. */
  readonly textShadow: number | null;
  /** Backlog text colour flag followed by the colour; absent from 1.9. */
  readonly backlogColor: number | null;
}

/**
 * A codeX RScript engine revision: the layouts of its data blocks and bytecode. Native
 * address comments in this engine refer to 1.11.0.3; 1.9 differences are stated where the
 * revision is consulted.
 */
export interface RScriptRevision {
  /** The executable's FileVersion, dotted. */
  readonly version: '1.9.0.0' | '1.11.0.3';
  readonly apini: RScriptApiniLayout;
  readonly layouts: GscOpcodeLayouts;
  /** The configuration block written to the system save. */
  readonly configSize: number;
  /** Configuration offset of a field given by its 1.11 offset, or -1 when the revision lacks it. */
  configOffset(offset: number): number;
  /** The scene block that slots and snapshots copy as a unit. */
  readonly sceneSize: number;
  /** Scene offset of a field given by its 1.11 offset, or -1 when the revision lacks it. */
  sceneOffset(offset: number): number;
  /** Sound-effect channels in the scene (the music and voice streams are separate). */
  readonly soundChannels: number;
  /**
   * Message text boxes on screen. 1.9 keeps four box records but shows one full-screen text
   * box, and its box opcodes ignore the selector (0x42DD50).
   */
  readonly textBoxes: 1 | 4;
  /** Skipping plays and stops sound effects without their fade (1.11 sub_428D50). */
  readonly skipCancelsSoundFade: boolean;
  /** Slot header size and where the page text starts in it; 1.9 stores no background word. */
  readonly slotHeaderSize: number;
  readonly slotTextOffset: number;
  readonly slotBackground: boolean;
}

/** RScript 1.11.0.3: the Fairytale Requiem, Symphony and Encore executables. */
export const RSCRIPT_1_11: RScriptRevision = Object.freeze({
  version: '1.11.0.3',
  apini: Object.freeze({
    size: 0x230,
    titleLength: 51,
    savePrefix: 57,
    saveDirectory: 87,
    directories: 108,
    fontName: 360,
    width: 412,
    height: 416,
    tick: 420,
    skipTopMenu: 422,
    startScript: 424,
    defaultLayerKind: 434,
    keepBackdropBrightness: 436,
    savePageCount: 438,
    palette: 440,
    choiceTextColor: 484,
    choiceTextSize: 494,
    saveDateSize: 496,
    textShadow: 500,
    backlogColor: 502,
  }),
  layouts: RSCRIPT_1_11_LAYOUTS,
  configSize: 0x872,
  configOffset: (offset: number) => offset,
  sceneSize: 0x996c,
  sceneOffset: (offset: number) => offset,
  soundChannels: 3,
  textBoxes: 4,
  skipCancelsSoundFade: true,
  slotHeaderSize: 0x68,
  slotTextOffset: 22,
  slotBackground: true,
});

/** 1.11 scene offsets where 1.9's message state begins and ends. */
const MESSAGE_1_11 = {start: 0x523c, end: 0x8c60} as const;

/**
 * 1.11 text box record fields (offset, size) and their 1.9 offsets. 1.9 records are 68 bytes
 * without the name plate, ruby and spacing fields (0x42FEB0..0x430170).
 */
const BOX_FIELDS_1_9: readonly (readonly [number, number, number])[] = [
  [0, 0, 4],
  [4, 4, 4],
  [8, 8, 4],
  [12, 12, 4],
  [24, 16, 4],
  [28, 20, 4],
  [32, 24, 4],
  [36, 28, 4],
  [48, 32, 2],
  [50, 34, 2],
  [52, 36, 2],
  [54, 38, 2],
  [56, 40, 2],
  [58, 42, 2],
  [70, 44, 2],
  [72, 46, 2],
  [74, 48, 2],
  [76, 52, 4],
  [80, 56, 4],
  [88, 60, 4],
  [92, 64, 4],
];
function boxField19(field: number): number {
  for (const [from, to, size] of BOX_FIELDS_1_9)
    if (field >= from && field < from + size) return to + field - from;
  return -1;
}

/**
 * 1.9 offset of a 1.11 message state field, relative to the message state. 1.9 has four
 * 68-byte box records, one 16-byte text source (script, text and a speaker flag, no name),
 * the same page record, and a backlog of 120-byte entries: kind, box, source, page.
 */
function messageField19(field: number): number {
  if (field < 20) return field;
  if (field < 404) {
    const box = Math.trunc((field - 20) / 96),
      offset = boxField19((field - 20) % 96);
    return offset < 0 ? -1 : 20 + 68 * box + offset;
  }
  if (field < 452) {
    const source = field - 404;
    if (source < 2) return 292 + source;
    if (source >= 4 && source < 8) return 300 + source - 4;
    return -1;
  }
  if (field < 484) return 308 + field - 452;
  const entry = Math.trunc((field - 484) / 144),
    offset = (field - 484) % 144,
    base = 340 + 120 * entry;
  if (offset < 4) return base + offset;
  if (offset < 100) {
    const box = boxField19(offset - 4);
    return box < 0 ? -1 : base + 4 + box;
  }
  if (offset < 102) return base + 72 + offset - 100;
  if (offset >= 104 && offset < 108) return base + 80 + offset - 104;
  if (offset >= 112) return base + 88 + offset - 112;
  return -1;
}

/**
 * RScript 1.9.0.0 (dispatcher 0x41BD00, scene word_482A70, configuration dword_482214).
 * One sound-effect record replaces 1.11's three, so later scene fields sit 12 bytes
 * earlier; the message state is 2544 bytes smaller, so fields after it sit 2556 earlier.
 * The configuration block lacks 1.11's system words and ends with message settings after
 * the font name (`MessageSettings19`).
 */
export const RSCRIPT_1_9: RScriptRevision = Object.freeze({
  version: '1.9.0.0',
  apini: Object.freeze({
    size: 0x214,
    titleLength: 31,
    savePrefix: 37,
    saveDirectory: 67,
    directories: 88,
    fontName: 340,
    width: 392,
    height: 396,
    tick: 400,
    skipTopMenu: 402,
    startScript: 404,
    defaultLayerKind: 414,
    keepBackdropBrightness: 416,
    savePageCount: 418,
    palette: 420,
    choiceTextColor: 464,
    choiceTextSize: 474,
    saveDateSize: 476,
    textShadow: null,
    backlogColor: null,
  }),
  layouts: RSCRIPT_1_9_LAYOUTS,
  configSize: 0x85a,
  configOffset(offset: number): number {
    // The words up to 0x3B are shared; 1.9 lacks the 40 bytes of system words at 1.11's
    // 0x3C, so the system strings and the font name sit 0x28 bytes earlier (0x482250).
    if (offset < 0x3c) return offset;
    if (offset >= 0x64) return offset - 0x28;
    return -1;
  },
  sceneSize: 0x8f70,
  sceneOffset(offset: number): number {
    if (offset < 0x0a) return offset;
    // Sound-effect records 1 and 2 do not exist.
    if (offset < 0x16) return -1;
    if (offset < MESSAGE_1_11.start) return offset - 12;
    if (offset < MESSAGE_1_11.end) {
      const field = messageField19(offset - MESSAGE_1_11.start);
      return field < 0 ? -1 : MESSAGE_1_11.start - 12 + field;
    }
    return offset - 2556;
  },
  soundChannels: 1,
  textBoxes: 1,
  skipCancelsSoundFade: false,
  slotHeaderSize: 0x66,
  slotTextOffset: 20,
  slotBackground: false,
});

/** Engine revisions by the executable's FileVersion. */
const REVISIONS = [RSCRIPT_1_9, RSCRIPT_1_11];

/** The executable's FileVersion ("1, 11, 0, 3") as dotted numbers, or null. */
export function rscriptFileVersion(executable: Uint8Array): string | null {
  try {
    for (const table of readPeVersionStrings(executable)) {
      const version = table.values['FileVersion'];
      if (version)
        return version
          .split(/[,.]/)
          .map((part) => part.trim())
          .join('.');
    }
  } catch {
    // Executables without a readable version resource are not identified.
  }
  return null;
}

/** The revision an executable's code implements; unknown revisions are rejected. */
export function rscriptRevision(executable: Uint8Array): RScriptRevision {
  const version = rscriptFileVersion(executable);
  const revision = REVISIONS.find((candidate) => candidate.version === version);
  if (!revision)
    throw new Error(
      `Unsupported codeX RScript revision ${version ?? '(unknown)'}. Its native layouts must be verified before launch.`,
    );
  return revision;
}
