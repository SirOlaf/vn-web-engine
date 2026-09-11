import {checkRange} from '../../../../../core/binary.js';

/** Immutable asset identity; label operands address the original file, never rewritten code. */
export class Sc3Script {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  constructor(
    readonly assetId: number,
    bytes: Uint8Array,
  ) {
    this.bytes = Uint8Array.from(bytes);
    this.view = new DataView(this.bytes.buffer);
    checkRange(bytes.length, 0, 16);
    if (this.u32(0) !== 0x00334353) throw new Error('Expected SC3 magic');
    for (const offset of [this.u32(4), this.u32(8)]) checkRange(bytes.length, offset, 0);
    this.label(0);
  }
  u8(offset: number): number {
    checkRange(this.bytes.length, offset, 1);
    return this.view.getUint8(offset);
  }
  u16(offset: number): number {
    checkRange(this.bytes.length, offset, 2);
    return this.view.getUint16(offset, true);
  }
  u32(offset: number): number {
    checkRange(this.bytes.length, offset, 4);
    return this.view.getUint32(offset, true);
  }
  label(index: number): number {
    // Native arithmetic wraps before the unsigned byte offset is widened.
    const target = this.u32((Math.imul(index, 4) + 12) >>> 0);
    checkRange(this.bytes.length, target, 1);
    return target;
  }
}

export class MesScript {
  readonly bytes: Uint8Array;
  readonly byId = new Map<number, number>();
  constructor(bytes: Uint8Array) {
    this.bytes = Uint8Array.from(bytes);
    checkRange(bytes.length, 0, 16);
    const v = new DataView(this.bytes.buffer);
    if (v.getUint32(0, true) !== 0x0053454d) throw new Error('Expected MES magic');
    const count = v.getUint32(8, true);
    checkRange(bytes.length, 16, count * 8);
    for (let i = 0; i < count; i++) {
      const id = v.getInt32(16 + i * 8, true);
      // 1400517b0 uses ordered-map insert, retaining the first duplicate.
      if (!this.byId.has(id)) this.byId.set(id, i);
    }
  }
}
