import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {AokanaBitmapStorage} from './bitmap.js';
import {AokanaLegacyBgEncoder} from './compressed-bg-legacy-encode.js';
import {encodeAokanaCompressedBgV2} from './compressed-bg-modern-encode.js';
import type {AokanaDistributedProcessing} from './distributed-processing.js';
import {AokanaRawSurfaceExport} from './raw-surface-export.js';
import type {AokanaSurfaces} from './surfaces.js';
import type {AokanaSystemTicks} from './system-ticks.js';

/** 0323E0: actual packed export, fixed encoder allocation and count-last publication. */
export class AokanaCompressedSurfaceEncoder {
  readonly legacy: AokanaLegacyBgEncoder;
  readonly raw: AokanaRawSurfaceExport;
  constructor(
    readonly surfaces: AokanaSurfaces,
    readonly processing: AokanaDistributedProcessing,
    readonly ticks: AokanaSystemTicks,
  ) {
    this.legacy = new AokanaLegacyBgEncoder(ticks);
    this.raw = new AokanaRawSurfaceExport(surfaces);
  }
  encode(
    output: AokanaBpPointer | null,
    count: AokanaBpPointer | null,
    index: number,
    mode: number,
    quality: number,
  ): number {
    const bitmap = this.surfaces.snapshot(index);
    if (bitmap === null) return 0x8000000a;
    const pixels = Math.imul(bitmap.width, bitmap.height) >>> 0;
    if (pixels > 0x400000) return 0x80000006;
    const format = bitmap.format >>> 0;
    if (format !== 1 && format !== 2) return 0xffffffff;
    const channels = format === 1 ? 3 : 4,
      payload = Math.imul(pixels, channels) >>> 0,
      packed = new Uint8Array(payload + 16),
      header = new DataView(packed.buffer),
      length = {bytes: new Uint8Array(4), offset: 0},
      lengthView = new DataView(length.bytes.buffer);
    header.setUint32(12, 0, true);
    header.setUint16(0, bitmap.width, true);
    header.setUint16(2, bitmap.height, true);
    header.setUint16(4, channels * 8, true);
    header.setUint16(6, 0, true);
    header.setUint16(8, format, true);
    header.setUint16(10, 0, true);
    lengthView.setUint32(0, payload, true);
    this.raw.export({bytes: packed, offset: 16}, length, payload, index);
    const encoded = new AokanaBitmapStorage(
      new Uint8Array((Math.imul(payload, 4) >>> 0) + 48),
      false,
    );
    let status = 0xffffffff;
    if (mode >>> 0 === 0) {
      if (
        this.legacy.encode({bytes: encoded.bytes, offset: 0}, length, {
          bytes: packed,
          offset: 0,
        }) === 0
      ) {
        encoded.written(0, lengthView.getUint32(0, true));
        status = 0;
      }
    } else if (mode >>> 0 === 1) {
      if (quality >>> 0 > 100) status = 0x80000018;
      else {
        const result = encodeAokanaCompressedBgV2(
          packed,
          encoded,
          quality,
          this.processing,
          this.ticks,
        );
        if (result.status === 0) {
          lengthView.setUint32(0, result.length, true);
          status = 0;
        } else if (result.status === 6) status = 0xfffffffe;
        else if (result.status === 8) status = 0x80000008;
      }
    } else status = 0x80000017;
    const size = lengthView.getUint32(0, true);
    if (status === 0 && output !== null) {
      encoded.range(0, size, true);
      const target = pointerView(output, size);
      new Uint8Array(target.buffer, target.byteOffset, size).set(encoded.bytes.subarray(0, size));
    }
    if (count === null)
      throw new Error('Aokana compressed surface encoder writes a null count pointer');
    pointerView(count, 4).setUint32(0, size, true);
    encoded.release();
    return status;
  }
}
