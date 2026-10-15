import {PsbResource, type PsbObject} from './psb.js';

/**
 * PSB `RL` run-length compression, as used by E-mote icons (`source.<part>.icon.<n>` with
 * `compress: "RL"`) of the software runtime. Lifted from emoteplayer.dll (SHA-256
 * `53636122…e6779541`): decoder 0x10005630, icon loader 0x10049ab0.
 *
 * The stream is a sequence of packets over units of `unit` bytes (4 for 32-bit pixels, 1 for
 * palette indices):
 * - control byte `c < 0x80`: `c + 1` literal units follow.
 * - control byte `c >= 0x80`: one unit follows and is repeated `(c & 0x7f) + 3` times.
 * Packets continue until the input is consumed exactly; there is no header or terminator. The
 * native decoder allocates `unit * width * height` bytes and checks neither bound; this
 * decoder rejects streams that overrun the output, end inside a packet or leave output unset,
 * which produces identical bytes for every stream the native decoder handles safely.
 *
 * Icon pixels: without `pal`, the decoded (or raw `pixel`) bytes are 32-bit texels copied row
 * by row into a Kirikiri layer buffer, so byte order is B, G, R, A. With `pal`, each decoded
 * byte indexes the `pal` resource's 4-byte entries. `width` and `height` give the size.
 */
export function decodePsbRl(input: Uint8Array, unit: number, outputLength: number): Uint8Array {
  if (!Number.isSafeInteger(unit) || unit <= 0) throw new RangeError(`Invalid RL unit ${unit}`);
  if (!Number.isSafeInteger(outputLength) || outputLength < 0 || outputLength % unit !== 0)
    throw new RangeError(`Invalid RL output length ${outputLength}`);
  const output = new Uint8Array(outputLength);
  let read = 0,
    written = 0;
  while (read < input.length) {
    const control = input[read++]!;
    if (control & 0x80) {
      const count = (control & 0x7f) + 3,
        length = count * unit;
      if (read + unit > input.length) throw new Error(`RL run at ${read - 1} is truncated`);
      if (written + length > outputLength) throw new Error(`RL run at ${read - 1} overruns`);
      const value = input.subarray(read, read + unit);
      for (let i = 0; i < count; i++) output.set(value, written + i * unit);
      read += unit;
      written += length;
    } else {
      const length = (control + 1) * unit;
      if (read + length > input.length) throw new Error(`RL literal at ${read - 1} is truncated`);
      if (written + length > outputLength) throw new Error(`RL literal at ${read - 1} overruns`);
      output.set(input.subarray(read, read + length), written);
      read += length;
      written += length;
    }
  }
  if (written !== outputLength)
    throw new Error(`RL stream produced ${written} of ${outputLength} bytes`);
  return output;
}

/** Decoded E-mote icon: `width * height` texels, bytes B, G, R, A. */
export interface EmoteIconPixels {
  readonly width: number;
  readonly height: number;
  readonly bgra: Uint8Array;
}

function resource(icon: PsbObject, key: string): PsbResource {
  const value = icon[key];
  if (!(value instanceof PsbResource)) throw new Error(`E-mote icon has no "${key}" resource`);
  return value;
}

function dimension(icon: PsbObject, key: string): number {
  const value = icon[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`E-mote icon has an invalid ${key}`);
  return value;
}

/**
 * Pixels of a software-runtime icon (emoteplayer 0x10049ab0): `pixel` decompressed when
 * `compress` is `"RL"` (any other value leaves it raw), then expanded through `pal` if present.
 */
export function decodeEmoteIcon(icon: PsbObject): EmoteIconPixels {
  const width = dimension(icon, 'width'),
    height = dimension(icon, 'height'),
    count = width * height,
    palette = icon.pal === undefined ? null : resource(icon, 'pal').bytes,
    unit = palette === null ? 4 : 1;
  let pixels = resource(icon, 'pixel').bytes;
  if (icon.compress === 'RL') pixels = decodePsbRl(pixels, unit, unit * count);
  else if (pixels.length < unit * count) throw new Error('E-mote icon pixel data is too short');
  if (palette === null) return {width, height, bgra: pixels.slice(0, count * 4)};
  const bgra = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const entry = pixels[i]! * 4;
    if (entry + 4 > palette.length) throw new Error(`E-mote icon palette index ${entry / 4}`);
    bgra.set(palette.subarray(entry, entry + 4), i * 4);
  }
  return {width, height, bgra};
}
