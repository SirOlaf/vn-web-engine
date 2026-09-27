import {byteDataView} from '../../core/binary.js';

/** Size of the `APINI` block read by 0x420E30 from RsInit.cfg or embedded in the executable. */
export const APINI_SIZE = 0x230;

/**
 * Per-title configuration of a codeX RScript executable. The block is compiled into the
 * executable's data section; an optional `RsInit.cfg` beside it replaces all 0x230 bytes.
 * Offsets are those read by the native code relative to the block (dword_4A2BA8).
 */
export interface RScriptApini {
  readonly bytes: Uint8Array;
  /** Window title (+6). */
  readonly title: string;
  /** Save file prefix, e.g. `FRsave` (+57). */
  readonly savePrefix: string;
  /** Save directory relative to the installation (+87). */
  readonly saveDirectory: string;
  readonly directories: {
    readonly scripts: string; // +108
    readonly system: string; // +129
    readonly systemAlternate: string; // +150
    readonly sprites: string; // +171
    readonly faces: string; // +192
    readonly events: string; // +213
    readonly movies: string; // +234
    readonly sounds: string; // +255
    readonly music: string; // +276
    readonly voices: string; // +297
  };
  /** Default font face (+360). */
  readonly fontName: string;
  readonly width: number; // +412
  readonly height: number; // +416
  /** Multimedia-timer period of the frame tick in milliseconds (+420). */
  readonly tickMilliseconds: number;
  /** Nonzero skips the legacy top menu after the opening movies (+422). */
  readonly skipTopMenu: boolean;
  /** Script started when the top menu is skipped (+424). */
  readonly startScript: number;
  /** Default layer kind assigned by a new game (+434). */
  readonly defaultLayerKind: number;
  /** Nonzero keeps the root surface undimmed behind modal screens (+436). */
  readonly keepBackdropBrightness: boolean;
  /** Text-rendering defaults copied into text sprites (+440, 0x28 bytes). */
  readonly textDefaults: Uint8Array;
  /** Screen-specific fields are read from the raw block as those screens need them. */
  u16(offset: number): number;
  u32(offset: number): number;
}

function sjis(bytes: Uint8Array, offset: number, length: number): string {
  const field = bytes.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return new TextDecoder('shift-jis').decode(end < 0 ? field : field.subarray(0, end));
}

export function parseApini(block: Uint8Array): RScriptApini {
  if (block.length < APINI_SIZE) throw new Error('Truncated RScript APINI block');
  const bytes = block.slice(0, APINI_SIZE);
  if (sjis(bytes, 0, 6) !== 'APINI') throw new Error('Not an RScript APINI block');
  const view = byteDataView(bytes);
  const path = (offset: number): string => sjis(bytes, offset, 21);
  const width = view.getUint32(412, true),
    height = view.getUint32(416, true);
  if (width < 1 || height < 1 || width > 8192 || height > 8192)
    throw new Error(`Invalid RScript screen size ${width}x${height}`);
  return {
    bytes,
    title: sjis(bytes, 6, 51),
    savePrefix: sjis(bytes, 57, 30),
    saveDirectory: path(87),
    directories: {
      scripts: path(108),
      system: path(129),
      systemAlternate: path(150),
      sprites: path(171),
      faces: path(192),
      events: path(213),
      movies: path(234),
      sounds: path(255),
      music: path(276),
      voices: path(297),
    },
    fontName: sjis(bytes, 360, 52),
    width,
    height,
    tickMilliseconds: Math.max(1, view.getUint16(420, true)),
    skipTopMenu: view.getUint16(422, true) !== 0,
    startScript: view.getUint16(424, true),
    defaultLayerKind: view.getUint16(434, true),
    keepBackdropBrightness: view.getUint16(436, true) !== 0,
    textDefaults: bytes.slice(440, 480),
    u16: (offset) => view.getUint16(offset, true),
    u32: (offset) => view.getUint32(offset, true),
  };
}

/** Finds the embedded block: the `APINI` tag must be followed by a plausible screen size. */
export function findExecutableApini(executable: Uint8Array): RScriptApini {
  const tag = [0x41, 0x50, 0x49, 0x4e, 0x49, 0];
  for (let i = executable.indexOf(0x41); i >= 0; i = executable.indexOf(0x41, i + 1)) {
    if (i + APINI_SIZE > executable.length) break;
    if (!tag.every((b, j) => executable[i + j] === b)) continue;
    try {
      return parseApini(executable.subarray(i, i + APINI_SIZE));
    } catch {
      // A stray tag in code or resources; keep searching.
    }
  }
  throw new Error('The executable does not contain an RScript APINI block');
}
