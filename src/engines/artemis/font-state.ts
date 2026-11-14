import {artemisRevision} from './revision.js';
import {artemisFontProperties, type ArtemisFontPropertyPatch} from './font-properties.js';

export type ArtemisFontFace = string | readonly number[];
export type ArtemisFontAttributes = Readonly<
  Required<Omit<ArtemisFontPropertyPatch, 'face' | 'rubyface' | 'overflow'>> & {
    face: ArtemisFontFace;
    rubyface: ArtemisFontFace;
  }
>;
/** 193720 uses this exact 13-byte Shift-JIS label even for a UTF-8 game. Retain
 * those bytes until an actual file-font name replaces them; don't invent a web
 * font or reinterpret them as UTF-8. System-font resolution is a separate owner. */
const defaultFace = Object.freeze([
  0x82, 0x6c, 0x82, 0x72, 0x20, 0x83, 0x53, 0x83, 0x56, 0x83, 0x62, 0x83, 0x4e,
]);
export function artemisDefaultFontAttributes(hash: string): ArtemisFontAttributes {
  artemisRevision(hash);
  return Object.freeze({
    left: 0,
    top: 0,
    width: 640,
    height: 480,
    entireanchorx: 0,
    entireanchory: 0,
    anchorcenter: true,
    entirealpha: 1,
    entirexscale: 1,
    entireyscale: 1,
    entirerotate: 0,
    layermode: 'normal',
    visible: true,
    alpha: 1,
    xscale: 1,
    yscale: 1,
    rotate: 0,
    face: defaultFace,
    rubyface: defaultFace,
    size: 24,
    shadow: 0,
    outline: 0,
    rubysize: 8,
    rubyshadow: 0,
    rubyoutline: 0,
    spacetop: 0,
    spacemiddle: 0,
    spacebottom: 0,
    kerning: 0,
    rubykerning: 0,
    color: 0xffffff,
    shadowcolor: 0,
    outlinecolor: 0,
    align: 'left',
    styleBits: 0,
    vertical: false,
    hung: true,
  });
}
/** Native font attributes and the history frame's extra overflow int stay distinct. */
export function artemisPatchFontAttributes(
  hash: string,
  before: ArtemisFontAttributes,
  args: ReadonlyMap<string, string>,
): {readonly font: ArtemisFontAttributes; readonly overflow: number | undefined} {
  artemisRevision(hash);
  const {overflow, ...patch} = artemisFontProperties(args);
  return Object.freeze({font: Object.freeze({...before, ...patch}), overflow});
}

/** One font-stack frame: CFontProperty attributes and the frame's extra +0xd8 int. */
export interface ArtemisFontFrameRecord {
  readonly font: ArtemisFontAttributes;
  readonly overflow: number;
}

type FontField = Exclude<keyof ArtemisFontAttributes, 'face' | 'rubyface'>;
/** CFontProperty serializer 0x1400a9470 order after section 0x23 (format 2): section id,
 * attribute and field width. Faces follow `rotate` as strings with ids 1 and 2. */
const archiveFields: readonly [number, FontField, 'f32' | 'u32' | 'u8'][] = [
  [3, 'left', 'f32'],
  [4, 'top', 'f32'],
  [5, 'width', 'f32'],
  [6, 'height', 'f32'],
  [10, 'entirealpha', 'f32'],
  [7, 'entireanchorx', 'f32'],
  [8, 'entireanchory', 'f32'],
  [9, 'anchorcenter', 'u8'],
  [0xb, 'entirexscale', 'f32'],
  [0xc, 'entireyscale', 'f32'],
  [0xd, 'entirerotate', 'f32'],
  [0xe, 'layermode', 'u32'],
  [0xf, 'visible', 'u8'],
  [0x10, 'alpha', 'f32'],
  [0x11, 'xscale', 'f32'],
  [0x12, 'yscale', 'f32'],
  [0x13, 'rotate', 'f32'],
];
const archiveTail: readonly [number, FontField, 'f32' | 'u32' | 'u8'][] = [
  [0x14, 'size', 'u32'],
  [0x25, 'shadow', 'u32'],
  [0x26, 'outline', 'u32'],
  [0x15, 'rubysize', 'u32'],
  [0x27, 'rubyshadow', 'u32'],
  [0x28, 'rubyoutline', 'u32'],
  [0x16, 'spacetop', 'f32'],
  [0x17, 'spacemiddle', 'f32'],
  [0x18, 'spacebottom', 'f32'],
  [0x21, 'kerning', 'f32'],
  [0x22, 'rubykerning', 'f32'],
  [0x19, 'color', 'u32'],
  [0x1a, 'shadowcolor', 'u32'],
  [0x1b, 'outlinecolor', 'u32'],
  [0x1c, 'align', 'u32'],
  [0x1d, 'styleBits', 'u32'],
  [0x1e, 'vertical', 'u8'],
  [0x1f, 'hung', 'u8'],
];
/** a74d0 enumerations stored at +0x34 and +0xc8. */
const layerModes = {normal: 0, add: 1, multiply: 2, screen: 4} as const;
const aligns = ['left', 'center', 'right', 'equalize'] as const;
const float = new DataView(new ArrayBuffer(4));
const utf8 = new TextDecoder('utf-8', {fatal: true});

function fieldBits(field: FontField, value: unknown): number {
  if (field === 'layermode') return layerModes[value as keyof typeof layerModes];
  if (field === 'align') return aligns.indexOf(value as (typeof aligns)[number]);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as number;
}
function fieldValue(field: FontField, width: 'f32' | 'u32' | 'u8', bits: number): unknown {
  if (field === 'layermode') {
    const mode = Object.entries(layerModes).find(([, code]) => code === bits);
    if (!mode) throw Error('Unsupported Artemis saved font layermode');
    return mode[0];
  }
  if (field === 'align') {
    if (bits >= aligns.length) throw Error('Unsupported Artemis saved font align');
    return aligns[bits];
  }
  if (width === 'u8') return bits !== 0;
  if (width === 'f32') {
    float.setUint32(0, bits, true);
    return float.getFloat32(0, true);
  }
  return field === 'color' ||
    field === 'shadowcolor' ||
    field === 'outlinecolor' ||
    field === 'styleBits'
    ? bits >>> 0
    : bits | 0;
}

/** Archive writer surface used by the font codec. */
interface FontArchiveWriter {
  section(id: number, scoped?: boolean): void;
  u8(value: number): void;
  u32(value: number): void;
  string(value: Uint8Array): void;
}
interface FontArchiveReader {
  seek(id: number, scoped?: boolean): boolean;
  u8(): number;
  u32(): number;
  string(): Uint8Array;
}

/** CFontProperty::serialize 0x1400a9470 for a font-stack frame. */
export function writeArtemisFontFrame(
  archive: FontArchiveWriter,
  frame: ArtemisFontFrameRecord,
): void {
  const write = ([id, field, width]: readonly [number, FontField, 'f32' | 'u32' | 'u8']) => {
    archive.section(id);
    const value = fieldBits(field, frame.font[field]);
    if (width === 'u8') archive.u8(value);
    else if (width === 'u32') archive.u32(value >>> 0);
    else {
      float.setFloat32(0, value, true);
      archive.u32(float.getUint32(0, true));
    }
  };
  const face = (value: ArtemisFontFace) =>
    typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
  archive.section(0x23);
  archive.u32(2);
  for (const field of archiveFields) write(field);
  archive.section(1);
  archive.string(face(frame.font.face));
  archive.section(2);
  archive.string(face(frame.font.rubyface));
  for (const field of archiveTail) write(field);
  archive.section(0x24);
  archive.u32(frame.overflow >>> 0);
}

/** Reader counterpart: absent sections keep the 193720 defaults; a face that is not
 * valid UTF-8 stays as its bytes. The frame's overflow starts at 0 when absent. */
export function readArtemisFontFrame(
  hash: string,
  archive: FontArchiveReader,
): ArtemisFontFrameRecord {
  const font: Record<string, unknown> = {...artemisDefaultFontAttributes(hash)};
  const read = ([id, field, width]: readonly [number, FontField, 'f32' | 'u32' | 'u8']) => {
    if (archive.seek(id))
      font[field] = fieldValue(field, width, width === 'u8' ? archive.u8() : archive.u32());
  };
  const face = (bytes: Uint8Array): ArtemisFontFace => {
    try {
      return utf8.decode(bytes);
    } catch {
      return Object.freeze([...bytes]);
    }
  };
  for (const field of archiveFields) read(field);
  if (archive.seek(1)) font.face = face(archive.string());
  if (archive.seek(2)) font.rubyface = face(archive.string());
  for (const field of archiveTail) read(field);
  const overflow = archive.seek(0x24) ? archive.u32() | 0 : 0;
  return Object.freeze({font: Object.freeze(font) as ArtemisFontAttributes, overflow});
}
