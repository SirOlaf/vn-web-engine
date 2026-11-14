import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisFontFrameRecord} from './font-state.js';
import {artemisFloatText} from './layer-info.js';
import {artemisMapOrder} from './save-data.js';

const encoder = new TextEncoder();
const COMMA = 0x2c,
  BACKSLASH = 0x5c;

/** 0x1400a0340 with code page 2 (UTF-8): whether a match at `position` starts a character.
 * The walk advances a multibyte character by its length plus one more byte, and accepts
 * any position it walks past without meeting it; the scan ends at the first NUL. */
function startsCharacter(bytes: readonly number[], position: number): boolean {
  const end = bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0);
  for (let index = 0; index < end; index++) {
    const byte = bytes[index]!;
    if (byte < 0x80) {
      if (index === position) return true;
      continue;
    }
    let trailing = 0;
    for (let bit = 0x40; byte & bit; bit >>= 1) trailing++;
    for (let step = 0; step <= trailing; step++, index++) if (index === position) return step === 0;
  }
  return true;
}

/** 0x1400a0340(value, ",", "\\,", code page 2): every comma that starts a character gains a
 * backslash. */
function escapeCommas(value: Uint8Array): Uint8Array {
  const bytes = [...value];
  for (let from = 0; ;) {
    const position = bytes.indexOf(COMMA, from);
    if (position < 0) return Uint8Array.from(bytes);
    if (!startsCharacter(bytes, position)) {
      from = position + 1;
      continue;
    }
    bytes.splice(position, 0, BACKSLASH);
    from = position + 2;
  }
}

function concat(parts: readonly (Uint8Array | string)[]): Uint8Array {
  const chunks = parts.map((part) => (typeof part === 'string' ? encoder.encode(part) : part));
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** CScriptBlock text 0x1400a2400: the tag name, then `,key,value` for each argument in
 * std::map key order, the value's commas escaped. */
export function artemisTagText(tag: AsbTag): Uint8Array {
  const parts: (Uint8Array | string)[] = [tag.name];
  for (const [key, value] of artemisMapOrder(tag.args))
    parts.push(`,${key},`, escapeCommas(tag.bytes?.get(key) ?? encoder.encode(value)));
  return concat(parts);
}

const floatText = (value: number) => artemisFloatText(Math.fround(value));

const layerModes = new Set(['normal', 'add', 'multiply', 'screen']);
const styles: readonly [number, string][] = [
  [8, 'bold'],
  [0x10, 'italic'],
  [0x20, 'underline'],
  [0x40, 'strikeout'],
];

/** CFontProperty text 0x1400a5c70. Floats are float32 products (alphas times 255, scales
 * times 100), the six sizes unsigned, overflow signed, colors `0x%X`. Faces are not
 * escaped; style names are joined by `\,`. */
export function artemisFontText(frame: ArtemisFontFrameRecord): Uint8Array {
  const font = frame.font;
  const product = (value: number, factor: number) => Math.fround(Math.fround(value) * factor);
  const face = (value: string | readonly number[]) =>
    typeof value === 'string' ? encoder.encode(value) : Uint8Array.from(value);
  const parts: (Uint8Array | string)[] = ['font'];
  const field = (key: string, text: string) => parts.push(`,${key},${text}`);
  for (const key of ['left', 'top', 'width', 'height'] as const) field(key, floatText(font[key]));
  field('entirealpha', floatText(product(font.entirealpha, 255)));
  for (const key of ['entireanchorx', 'entireanchory', 'entirerotate'] as const)
    field(key, floatText(font[key]));
  field('alpha', floatText(product(font.alpha, 255)));
  field('rotate', floatText(font.rotate));
  for (const key of ['size', 'shadow', 'outline', 'rubysize', 'rubyshadow', 'rubyoutline'] as const)
    field(key, String(font[key] >>> 0));
  for (const key of ['spacetop', 'spacemiddle', 'spacebottom', 'kerning', 'rubykerning'] as const)
    field(key, floatText(font[key]));
  field('overflow', String(frame.overflow | 0));
  for (const key of ['entirexscale', 'entireyscale', 'xscale', 'yscale'] as const)
    field(key, floatText(product(font[key], 100)));
  for (const key of ['color', 'shadowcolor', 'outlinecolor'] as const)
    field(key, '0x' + (font[key] >>> 0).toString(16).toUpperCase());
  parts.push(',face,', face(font.face), ',rubyface,', face(font.rubyface));
  for (const key of ['anchorcenter', 'visible', 'vertical', 'hung'] as const)
    field(key, font[key] ? '1' : '0');
  if (!layerModes.has(font.layermode)) throw new Error('Unsupported Artemis font layermode');
  field('layermode', font.layermode);
  field('align', font.align);
  parts.push(
    ',style,' +
      styles
        .filter(([bit]) => font.styleBits & bit)
        .map(([, name]) => name)
        .join('\\,'),
  );
  return concat(parts);
}
