/**
 * Text streams (krkrz `base/TextStream.cpp`), used by `Scripts.execStorage`, `Array.load`,
 * `saveStruct` and friends.
 *
 * Reading recognises, after an optional byte offset (`oN` in the mode string): UTF-16LE with a
 * BOM; the `FE FE` header of mode 0/1 ciphered and mode 2 zlib-compressed UTF-16; UTF-8 with a
 * BOM; otherwise the default read encoding (`UTF-8`, or `Shift_JIS` = the ANSI code page,
 * chosen by `-readencoding`). Text ends at the first NUL, as the native C strings do.
 *
 * Writing produces UTF-16LE with a BOM, mode 1 ciphered (`c`) or compressed (`z`) text.
 * Compressed text is written as zlib stored blocks: valid for every zlib reader, but larger
 * than the native deflate output.
 */
import {adler32, inflateZlib} from '../../../core/inflate.js';
import {throwTjsError} from '../tjs2/runtime/errors.js';
import {
  TJS_BS_READ,
  TJS_BS_SEEK_SET,
  TJS_BS_UPDATE,
  TJS_BS_WRITE,
  type TjsBinaryStream,
} from '../tjs2/runtime/interface.js';
import type {TjsTextWriter} from '../tjs2/runtime/engine.js';
import {readWholeStream} from './streams.js';

/** The digits after the first `o` of a mode string, as a byte offset. */
function modeOffset(mode: string): number | null {
  const o = mode.indexOf('o');
  if (o < 0) return null;
  const digits = /^[0-9]{0,255}/.exec(mode.slice(o + 1))![0];
  return digits ? Number(digits) : 0;
}

/** UTF-16 code units to a string, kept as they are (lone surrogates included). */
export function unitsToString(units: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < units.length; i += 8192)
    s += String.fromCharCode.apply(
      null,
      Array.from({length: Math.min(8192, units.length - i)}, (_, k) => units[i + k]!),
    );
  return s;
}

function truncateAtNul(s: string): string {
  const z = s.indexOf('\0');
  return z >= 0 ? s.slice(0, z) : s;
}

function utf16le(bytes: Uint8Array, start: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++)
    out.push(bytes[start + i * 2]! | (bytes[start + i * 2 + 1]! << 8));
  return out;
}

/** `TVPUtf8ToWideCharString`: up to 6-byte sequences, truncated to 16 bits; null if invalid. */
export function decodeTvpUtf8(bytes: Uint8Array): string | null {
  let s = '';
  for (let i = 0; i < bytes.length && bytes[i] !== 0;) {
    const c = bytes[i]!;
    let n: number, v: number;
    if (c < 0x80) {
      s += String.fromCharCode(c);
      i++;
      continue;
    } else if (c < 0xc2) return null;
    else if (c < 0xe0) ((n = 2), (v = c & 0x1f));
    else if (c < 0xf0) ((n = 3), (v = c & 0x1f));
    else if (c < 0xf8) ((n = 4), (v = c & 0x07));
    else if (c < 0xfc) ((n = 5), (v = c & 0x03));
    else if (c < 0xfe) ((n = 6), (v = c & 0x01));
    else return null;
    for (let k = 1; k < n; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) return null;
      v = v * 64 + (b & 0x3f);
    }
    s += String.fromCharCode(v & 0xffff);
    i += n;
  }
  return s;
}

export interface TextReadOptions {
  /** `DefaultReadEncoding` (`-readencoding`): `UTF-8` or `Shift_JIS`. */
  readonly encoding: string;
  /** Decodes text in the ANSI code page (`MultiByteToWideChar(CP_ACP)`). */
  readonly decodeAnsi: (bytes: Uint8Array) => string;
}

/** Decodes a whole text storage the way `tTVPTextReadStream` reads it. */
export function decodeTextStorage(
  name: string,
  bytes: Uint8Array,
  mode: string,
  options: TextReadOptions,
): string | Promise<string> {
  const ofs = modeOffset(mode) ?? 0;
  let p = ofs;
  const m0 = bytes[p],
    m1 = bytes[p + 1];
  p += 2;
  if (m0 === 0xff && m1 === 0xfe) return truncateAtNul(unitsToString(chars(bytes, p)));
  if (m0 === 0xfe && m1 === 0xfe) {
    const cryptMode = bytes[p++];
    if (cryptMode !== 0 && cryptMode !== 1 && cryptMode !== 2)
      throwTjsError('TVPUnsupportedCipherMode', name);
    if (bytes[p] !== 0xff || bytes[p + 1] !== 0xfe) throwTjsError('TVPUnsupportedCipherMode', name);
    p += 2;
    if (cryptMode !== 2) {
      const units = chars(bytes, p).map((ch) =>
        cryptMode === 0
          ? ch >= 0x20
            ? ch ^ (((ch & 0xfe) << 8) ^ 1)
            : ch
          : ((ch & 0xaaaa) >> 1) | ((ch & 0x5555) << 1),
      );
      return truncateAtNul(unitsToString(units));
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const compressed = view.getBigUint64(p, true);
    const uncompressed = view.getBigUint64(p + 8, true);
    if (compressed > 0xffffffffn || uncompressed > 0xffffffffn)
      throwTjsError('TVPUnsupportedCipherMode', name);
    p += 16;
    const data = bytes.subarray(p, p + Number(compressed));
    return inflateZlib(data, Number(uncompressed)).then(
      (out) => truncateAtNul(unitsToString(utf16le(out, 0, out.length >> 1))),
      () => throwTjsError('TVPUnsupportedCipherMode', name),
    );
  }
  if (m0 === 0xef && m1 === 0xbb && bytes[p] === 0xbf) {
    const text = decodeTvpUtf8(bytes.subarray(p + 1));
    if (text === null) throwTjsError('TJSNarrowToWideConversionError');
    return text;
  }
  const raw = bytes.subarray(ofs);
  const z = raw.indexOf(0);
  const body = z >= 0 ? raw.subarray(0, z) : raw;
  if (options.encoding === 'UTF-8') {
    const text = decodeTvpUtf8(body);
    if (text === null) throwTjsError('TJSNarrowToWideConversionError');
    return text;
  }
  if (options.encoding === 'Shift_JIS') return options.decodeAnsi(body);
  return throwTjsError('TVPUnsupportedEncoding', options.encoding);
}

function chars(bytes: Uint8Array, start: number): number[] {
  return utf16le(bytes, start, Math.max(0, (bytes.length - start) >> 1));
}

/** `TVPCreateTextStreamForRead` + `Read(all)`: opens, reads and decodes a text storage. */
export function readTextStorage(
  open: (name: string, flags: number) => TjsBinaryStream | Promise<TjsBinaryStream>,
  name: string,
  mode: string,
  options: TextReadOptions,
): string | Promise<string> {
  const finish = (stream: TjsBinaryStream) => {
    const decode = (bytes: Uint8Array) => {
      stream.destruct();
      return decodeTextStorage(name, bytes, mode, options);
    };
    const bytes = readWholeStream(stream);
    return bytes instanceof Promise ? bytes.then(decode) : decode(bytes);
  };
  const stream = open(name, TJS_BS_READ);
  return stream instanceof Promise ? stream.then(finish) : finish(stream);
}

/** zlib with stored (uncompressed) deflate blocks. */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const start = b * 65535,
      len = Math.min(65535, data.length - start);
    out[o++] = b === blocks - 1 ? 1 : 0;
    out[o++] = len & 0xff;
    out[o++] = len >> 8;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >> 8) & 0xff;
    out.set(data.subarray(start, start + len), o);
    o += len;
  }
  const a = adler32(data);
  out[o++] = a >>> 24;
  out[o++] = (a >>> 16) & 0xff;
  out[o++] = (a >>> 8) & 0xff;
  out[o++] = a & 0xff;
  return out;
}

/**
 * `tTVPTextWriteStream`. The storage stream is opened synchronously (writes never fetch); the
 * text is encoded on `close`.
 */
export function openTextWriteStorage(
  open: (name: string, flags: number) => TjsBinaryStream | Promise<TjsBinaryStream>,
  name: string,
  mode: string,
): TjsTextWriter {
  let cryptMode = -1;
  let compressionLevel = -1;
  const c = mode.indexOf('c');
  if (c >= 0) {
    cryptMode = 1;
    const d = mode.charCodeAt(c + 1);
    if (d >= 0x30 && d <= 0x39) cryptMode = d - 0x30;
  }
  const z = mode.indexOf('z');
  if (z >= 0) {
    cryptMode = 2;
    const d = mode.charCodeAt(z + 1);
    if (d >= 0x30 && d <= 0x39) compressionLevel = d - 0x30;
  }
  void compressionLevel;
  if (cryptMode !== -1 && cryptMode !== 1 && cryptMode !== 2)
    throwTjsError('TVPUnsupportedModeString', 'unsupported cipher mode');
  const ofs = modeOffset(mode);
  const opened = open(name, ofs !== null ? TJS_BS_UPDATE : TJS_BS_WRITE);
  if (opened instanceof Promise) throwTjsError('TVPCannotOpenStorage', name);
  const stream = opened;
  if (ofs !== null) stream.seek(ofs, TJS_BS_SEEK_SET);
  if (cryptMode === 1 || cryptMode === 2) stream.write(Uint8Array.of(0xfe, 0xfe, cryptMode));
  stream.write(Uint8Array.of(0xff, 0xfe));
  const units: number[] = [];
  return {
    write(text: string) {
      for (let i = 0; i < text.length; i++) {
        let ch = text.charCodeAt(i);
        if (cryptMode === 1) ch = ((ch & 0xaaaa) >> 1) | ((ch & 0x5555) << 1);
        units.push(ch);
      }
    },
    close() {
      const raw = new Uint8Array(units.length * 2);
      units.forEach((u, i) => {
        raw[i * 2] = u & 0xff;
        raw[i * 2 + 1] = u >> 8;
      });
      if (cryptMode === 2) {
        const packed = zlibStored(raw);
        const sizes = new DataView(new ArrayBuffer(16));
        sizes.setBigUint64(0, BigInt(packed.length), true);
        sizes.setBigUint64(8, BigInt(raw.length), true);
        stream.write(new Uint8Array(sizes.buffer));
        stream.write(packed);
      } else stream.write(raw);
      stream.destruct();
    },
  };
}
