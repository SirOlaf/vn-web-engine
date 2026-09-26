import {randomByteGenerator} from '../../../formats/buriko/binary.js';
import {pointerView, type BurikoBpMemory, type BurikoBpPointer} from '../bp/memory.js';
import type {BurikoProgramResources} from './program-resources.js';
import {BurikoResourceFileServices} from './resource-file-services.js';
import {BurikoUndefinedResourceRead} from './resource-memory.js';
import {textBytes} from './text.js';

interface SaveRecord {
  bytes: Uint8Array;
  initialized: Uint8Array;
  status: number;
}
/** BB650–BBA30, sharing current BP1E9080 and SaveRoot1E8D70. */
export class BurikoSaveSlots {
  /** C1C30 / imported DAT1C9774. Preserve the raw DWORD. */
  cipher = 1;
  readonly output: BurikoResourceFileServices;
  constructor(
    readonly resources: BurikoProgramResources,
    readonly memory: BurikoBpMemory,
    readonly readLocalTime: () => Date = () => new Date(),
  ) {
    this.output = new BurikoResourceFileServices(resources);
  }
  private path(slot: number): Uint8Array {
    const value = slot | 0;
    const filename = `BGI${value < 0 ? '-' : ''}${Math.abs(value).toString().padStart(4, '0')}.cad`;
    return this.resources.errors.saveRoot.path(new TextEncoder().encode(filename + '\0'));
  }
  private require(record: SaveRecord, offset: number, length: number): Uint8Array {
    if (offset + length > record.bytes.length)
      throw new RangeError('Buriko save record exceeds native allocation');
    if (record.initialized.subarray(offset, offset + length).some((v) => v === 0))
      throw new BurikoUndefinedResourceRead('Buriko save record consumes unwritten decoded bytes');
    return record.bytes.subarray(offset, offset + length);
  }
  private async record(slot: number, validate: boolean): Promise<SaveRecord> {
    const size = this.memory.globalMemory.length,
      bytes = new Uint8Array((size + 64) >>> 0),
      initialized = new Uint8Array(bytes.length),
      result = await this.resources.load(null, this.path(slot), false, {bytes, initialized}),
      record = {
        bytes,
        initialized,
        status: result.result === bytes.length ? 0 : result.result === 0 ? 1 : 2,
      };
    if (record.status === 0 && validate && this.cipher !== 0) {
      const seed = this.require(record, 14, 2),
        payload = this.require(record, 64, size),
        next = randomByteGenerator(
          new DataView(seed.buffer, seed.byteOffset, 2).getUint16(0, true),
        );
      let sum = 0,
        xor = 0;
      for (let i = 0; i < payload.length; i++) {
        const value = payload[i]!;
        sum = (sum + value) & 255;
        xor ^= value;
        payload[i] = (value - next()) & 255;
      }
      const checksum = this.require(record, 56, 2);
      if (checksum[0] !== sum || checksum[1] !== xor) record.status = 3;
    }
    return record;
  }
  async header(destination: BurikoBpPointer | null, slot: number): Promise<number> {
    const record = await this.record(slot, false);
    if (record.status === 0) {
      if (destination === null)
        throw new RangeError('Buriko save header consumed a null destination');
      const output = pointerView(destination, 64);
      new Uint8Array(output.buffer, output.byteOffset, 64).set(this.require(record, 0, 64));
    }
    return record.status;
  }
  async validate(slot: number): Promise<number> {
    return (await this.record(slot, true)).status;
  }
  async load(slot: number): Promise<number> {
    const record = await this.record(slot, true);
    if (record.status === 0)
      this.memory.globalMemory.set(this.require(record, 64, this.memory.globalMemory.length));
    return record.status;
  }
  async save(slot: number, comment: BurikoBpPointer): Promise<number> {
    const size = this.memory.globalMemory.length,
      bytes = new Uint8Array((size + 64) >>> 0),
      view = new DataView(bytes.buffer),
      value = this.readLocalTime();
    if (!Number.isFinite(value.getTime()))
      throw new Error('Buriko save local-time host returned an invalid date');
    const words = [
      value.getFullYear(),
      value.getMonth() + 1,
      value.getDay(),
      value.getDate(),
      value.getHours(),
      value.getMinutes(),
      value.getSeconds(),
      value.getMilliseconds(),
    ];
    for (let i = 0; i < words.length; i++) view.setUint16(i * 2, words[i]!, true);
    const name = textBytes(comment, true);
    if (name.length > bytes.length - 16)
      throw new RangeError('Buriko save comment exceeds native record');
    bytes.set(name, 16);
    bytes.set(this.memory.globalMemory, 64);
    if (this.cipher !== 0) {
      const next = randomByteGenerator(view.getUint16(14, true));
      bytes[56] = 0;
      bytes[57] = 0;
      for (let i = 64; i < bytes.length; i++) {
        const encrypted = (bytes[i]! + next()) & 255;
        bytes[i] = encrypted;
        bytes[56] = (bytes[56]! + encrypted) & 255;
        bytes[57] = bytes[57]! ^ encrypted;
      }
      bytes[58] = next();
      bytes[59] = next();
      bytes[60] = 1;
    }
    const path = this.path(slot);
    return Number(
      (await this.output.write({bytes: path, offset: 0}, {bytes, offset: 0}, bytes.length)) ===
        bytes.length,
    );
  }
}
