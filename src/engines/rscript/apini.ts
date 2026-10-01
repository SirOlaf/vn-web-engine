import {byteDataView} from '../../core/binary.js';
import {RSCRIPT_1_11, rscriptRevision, type RScriptRevision} from './revision.js';

/**
 * Per-title configuration of a codeX RScript executable (the `APINI` block read by
 * 0x420E30). The block is compiled into the executable's data section; an optional
 * `RsInit.cfg` beside it replaces the whole block. Its layout depends on the engine
 * revision (`RScriptRevision.apini`).
 */
export interface RScriptApini {
  readonly revision: RScriptRevision;
  readonly bytes: Uint8Array;
  readonly title: string;
  /** Save file prefix, e.g. `FRsave`. */
  readonly savePrefix: string;
  /** Save directory relative to the installation. */
  readonly saveDirectory: string;
  readonly directories: {
    readonly scripts: string;
    readonly system: string;
    readonly systemAlternate: string;
    readonly sprites: string;
    readonly faces: string;
    readonly events: string;
    readonly movies: string;
    readonly sounds: string;
    readonly music: string;
    readonly voices: string;
  };
  /** Default font face. */
  readonly fontName: string;
  /** Shift-JIS bytes of the font name and of the sprite and event directories. */
  readonly fontNameBytes: Uint8Array;
  readonly spriteDirectoryBytes: Uint8Array;
  readonly eventDirectoryBytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Multimedia-timer period of the frame tick in milliseconds. */
  readonly tickMilliseconds: number;
  /** Nonzero skips the legacy top menu after the opening movies. */
  readonly skipTopMenu: boolean;
  /** Script started when the top menu is skipped. */
  readonly startScript: number;
  /** Default layer kind assigned by a new game. */
  readonly defaultLayerKind: number;
  /** Nonzero keeps the root surface undimmed behind modal screens. */
  readonly keepBackdropBrightness: boolean;
  /** Pages of the save and load screens. */
  readonly savePageCount: number;
  /** Colours of `^C0`..`^C9`, as 0xRRGGBB (also the text-rendering defaults block). */
  readonly palette: readonly number[];
  readonly textDefaults: Uint8Array;
  /** Choice text colour (0xRRGGBB) and size. */
  readonly choiceTextColor: number;
  readonly choiceTextSize: number;
  /** Size of the save screens' date text. */
  readonly saveDateSize: number;
  /** Message text shadow; 1.9 has no such field and draws none. */
  readonly textShadow: boolean;
  /** Backlog text colour, or null for the message colour (always null in 1.9). */
  readonly backlogColor: number | null;
}

function field(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  const value = bytes.subarray(offset, offset + length);
  const end = value.indexOf(0);
  return end < 0 ? value : value.subarray(0, end);
}
const decoder = new TextDecoder('shift-jis');
function sjis(bytes: Uint8Array, offset: number, length: number): string {
  return decoder.decode(field(bytes, offset, length));
}

export function parseApini(
  block: Uint8Array,
  revision: RScriptRevision = RSCRIPT_1_11,
): RScriptApini {
  const layout = revision.apini;
  if (block.length < layout.size) throw new Error('Truncated RScript APINI block');
  const bytes = block.slice(0, layout.size);
  if (sjis(bytes, 0, 6) !== 'APINI') throw new Error('Not an RScript APINI block');
  const view = byteDataView(bytes);
  const u16 = (offset: number): number => view.getUint16(offset, true);
  const u32 = (offset: number): number => view.getUint32(offset, true);
  const path = (index: number): string => sjis(bytes, layout.directories + 21 * index, 21);
  const width = u32(layout.width),
    height = u32(layout.height);
  if (width < 1 || height < 1 || width > 8192 || height > 8192)
    throw new Error(`Invalid RScript screen size ${width}x${height}`);
  return {
    revision,
    bytes,
    title: sjis(bytes, 6, layout.titleLength),
    savePrefix: sjis(bytes, layout.savePrefix, 30),
    saveDirectory: sjis(bytes, layout.saveDirectory, 21),
    directories: {
      scripts: path(0),
      system: path(1),
      systemAlternate: path(2),
      sprites: path(3),
      faces: path(4),
      events: path(5),
      movies: path(6),
      sounds: path(7),
      music: path(8),
      voices: path(9),
    },
    fontName: sjis(bytes, layout.fontName, 52),
    fontNameBytes: field(bytes, layout.fontName, 32).slice(0, 31),
    spriteDirectoryBytes: field(bytes, layout.directories + 21 * 3, 21).slice(),
    eventDirectoryBytes: field(bytes, layout.directories + 21 * 5, 21).slice(),
    width,
    height,
    tickMilliseconds: Math.max(1, u16(layout.tick)),
    skipTopMenu: u16(layout.skipTopMenu) !== 0,
    startScript: u16(layout.startScript),
    defaultLayerKind: u16(layout.defaultLayerKind),
    keepBackdropBrightness: u16(layout.keepBackdropBrightness) !== 0,
    savePageCount: u16(layout.savePageCount),
    palette: Array.from({length: 10}, (_, i) => u32(layout.palette + 4 * i)),
    textDefaults: bytes.slice(layout.palette, layout.palette + 40),
    choiceTextColor: u32(layout.choiceTextColor),
    choiceTextSize: u16(layout.choiceTextSize),
    saveDateSize: u16(layout.saveDateSize),
    textShadow: layout.textShadow !== null && u16(layout.textShadow) !== 0,
    backlogColor:
      layout.backlogColor !== null && u16(layout.backlogColor)
        ? u32(layout.backlogColor + 2)
        : null,
  };
}

/**
 * Finds the embedded block of an executable's revision: the `APINI` tag must be followed by
 * a plausible screen size.
 */
export function findExecutableApini(executable: Uint8Array): RScriptApini {
  const revision = rscriptRevision(executable);
  const size = revision.apini.size;
  const tag = [0x41, 0x50, 0x49, 0x4e, 0x49, 0];
  for (let i = executable.indexOf(0x41); i >= 0; i = executable.indexOf(0x41, i + 1)) {
    if (i + size > executable.length) break;
    if (!tag.every((b, j) => executable[i + j] === b)) continue;
    try {
      return parseApini(executable.subarray(i, i + size), revision);
    } catch {
      // A stray tag in code or resources; keep searching.
    }
  }
  throw new Error('The executable does not contain an RScript APINI block');
}
