import {pointerView, type AokanaBpMemory, type AokanaBpPointer} from '../bp/memory.js';
import {aokanaWindowCenteredPosition, aokanaWindowPositionAllowed} from './browser-main-window.js';
import type {AokanaDisplayAdapters} from './display-adapters.js';
import {aokanaNamedBitByteCount, type AokanaNamedBitArrays} from './named-bit-arrays.js';
import type {AokanaProgramResources} from './program-resources.js';
import {AokanaResourceFileServices} from './resource-file-services.js';
import {AokanaUndefinedResourceRead} from './resource-memory.js';
import {decodeAokanaSdc, encodeAokanaSdc} from './sdc.js';
import type {AokanaStringLists} from './string-lists.js';
import {textLength} from './text.js';

const reserved = 0x80000000;
const gdbName = new TextEncoder().encode('BGI.gdb\0');
const pointer = (bytes: Uint8Array, offset = 0): AokanaBpPointer => ({bytes, offset});
function copy(target: AokanaBpPointer, source: AokanaBpPointer, length: number): void {
  const input = pointerView(source, length),
    output = pointerView(target, length);
  new Uint8Array(output.buffer, output.byteOffset, length).set(
    new Uint8Array(input.buffer, input.byteOffset, length),
  );
}

function modernSignature(bytes: Uint8Array): boolean {
  const expected = 'BURIKO GDB 3.00\0';
  for (let i = 0; i < expected.length; i++) {
    if (i >= bytes.length)
      throw new AokanaUndefinedResourceRead(
        'Aokana GDB signature reads beyond its decoded allocation',
      );
    if (bytes[i] !== expected.charCodeAt(i)) return false;
  }
  return true;
}

/** C3C20/C3A00's separate1E8CE0 allocation. Bank0 remains the existing1E9080 BP arena. */
export class AokanaPersistentMemory {
  readonly bytes = new Uint8Array(0x100000);
  write(offset: number, source: AokanaBpPointer | null, length: number): void {
    if (source === null) throw new RangeError('Aokana persistent write consumed a null source');
    copy(pointer(this.bytes, offset), source, length);
  }
  read(output: AokanaBpPointer | null, offset: number, length: number): void {
    if (output === null) throw new RangeError('Aokana persistent read consumed a null destination');
    copy(output, pointer(this.bytes, offset), length);
  }
}

export interface AokanaGdbLoadResult {
  readonly status: 0 | 0x80000001 | 0x80000002;
  /** E8040's stack pair is unwritten on early failure; never invent zero coordinates. */
  readonly position: readonly [number, number] | null;
}

/** C1540/C1940 operate on the actual BP prefix, persistence allocation, registries and root. */
export class AokanaPersistence {
  readonly output: AokanaResourceFileServices;
  constructor(
    readonly resources: AokanaProgramResources,
    readonly memory: AokanaBpMemory,
    readonly persistent: AokanaPersistentMemory,
    readonly strings: AokanaStringLists,
    readonly bits: AokanaNamedBitArrays,
    readonly adapters: AokanaDisplayAdapters,
    readonly readSystemTime: () => Date = () => new Date(),
  ) {
    this.output = new AokanaResourceFileServices(resources);
  }

  get root() {
    return this.resources.errors.saveRoot;
  }
  private position(x: number, y: number): readonly [number, number] {
    return aokanaWindowPositionAllowed(this.adapters.display, x, y)
      ? [x, y]
      : aokanaWindowCenteredPosition(this.adapters.display);
  }

  async load(): Promise<AokanaGdbLoadResult> {
    const path = this.root.path(gdbName),
      measured = await this.resources.size(null, path);
    if (measured === 0) return {status: 0x80000001, position: null};
    const bytes = new Uint8Array(measured),
      initialized = new Uint8Array(measured);
    await this.resources.load(null, path, true, {bytes, initialized});
    // Native reads the original measured caller allocation; unused trailing bytes are not read.
    const requireWritten = (start: number, length: number): void => {
      pointerView(pointer(bytes, start), length);
      if (initialized.subarray(start, start + length).some((value) => value === 0))
        throw new AokanaUndefinedResourceRead(
          'Aokana GDB loader consumes unwritten measured storage',
        );
    };
    requireWritten(24, 4);
    const magic = 'SDC FORMAT 1.00\0';
    let valid = true;
    for (let i = 0; i < magic.length; i++) {
      requireWritten(i, 1);
      if (bytes[i] !== magic.charCodeAt(i)) {
        valid = false;
        break;
      }
    }
    if (valid) {
      requireWritten(16, 16);
      requireWritten(32, new DataView(bytes.buffer).getUint32(20, true));
    }
    return this.restore(bytes);
  }

  /** File-load C1540, distinct from C13C0's caller-selected append/merge restore service. */
  restore(encoded: Uint8Array): AokanaGdbLoadResult {
    pointerView(pointer(encoded), 28); // C1540 reads decoded size before testing SDC signature.
    const decoded = decodeAokanaSdc(encoded);
    if (decoded === null) {
      if (pointerView(pointer(encoded)).getUint32(24, true) === 0)
        throw new AokanaUndefinedResourceRead('Aokana GDB compares a zero-size decoded allocation');
      return {status: 0x80000002, position: null};
    }
    const view = pointerView(pointer(decoded)),
      at = (offset: number) => pointer(decoded, offset);
    if (modernSignature(decoded)) {
      if (view.getUint32(16, true) !== decoded.length) return {status: 0x80000002, position: null};
      const position = this.position(view.getInt32(20, true), view.getInt32(24, true)),
        firstSize = view.getUint32(28, true);
      copy(pointer(this.memory.globalMemory), at(32), firstSize);
      let offset = 32 + firstSize;
      const secondSize = view.getUint32(offset, true);
      offset += 4;
      copy(pointer(this.persistent.bytes), at(offset), secondSize);
      if (secondSize < 0x100000) this.persistent.bytes.fill(0, secondSize);
      offset += secondSize;
      this.strings.replace(reserved, view.getUint32(offset, true), at(offset + 4));
      offset += 4 + this.strings.copyAll(null, reserved);
      this.bits.clear();
      this.bits.replacePacked(at(offset));
      return {status: 0, position};
    }
    if (decoded.length < 0x70408) return {status: 0x80000002, position: null};
    const compact =
      view.getUint8(0x60408) !== 0 &&
      textLength(at(0x60408)) < 24 &&
      view.getUint32(0x60420, true) > 0 &&
      view.getUint32(0x60424, true) === 0;
    const position = this.position(view.getInt32(0, true), view.getInt32(4, true));
    copy(pointer(this.memory.globalMemory), at(8), 0x400);
    copy(pointer(this.persistent.bytes), at(0x408), 0x40000);
    this.persistent.bytes.fill(0, 0x40000);
    this.strings.replace(reserved, 0, null);
    for (let i = 0; i < (compact ? 0x1000 : 0x4000); i++) {
      const offset = 0x40408 + i * 32;
      if (view.getUint8(offset) !== 0) this.strings.append(reserved, at(offset));
    }
    this.bits.clear();
    const records = compact ? 0x60408 : 0xc0408,
      payload = compact ? 0x70408 : 0xd0408;
    let sum = 0;
    for (let i = 0; i < 0x800; i++) {
      const offset = records + i * 32,
        count = view.getUint32(offset + 24, true);
      if (count !== 0) {
        this.bits.replaceData(at(offset), count, at(payload + view.getUint32(offset + 28, true)));
        sum = (sum + aokanaNamedBitByteCount(count)) >>> 0;
      }
    }
    return {status: decoded.length === payload + sum ? 0 : 0x80000002, position};
  }

  async save(): Promise<0 | 1> {
    const stringBytes = this.strings.copyAll(null, reserved),
      bitBytes = this.bits.copyPacked(null),
      length = (0x100428 + stringBytes + bitBytes) >>> 0,
      bytes = new Uint8Array(length),
      view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('BURIKO GDB 3.00\0'));
    view.setUint32(16, length, true);
    const [x, y] = this.adapters.readWindowRectangle();
    view.setInt32(20, x, true);
    view.setInt32(24, y, true);
    view.setUint32(28, 0x400, true);
    copy(pointer(bytes, 32), pointer(this.memory.globalMemory), 0x400);
    view.setUint32(0x420, 0x100000, true);
    copy(pointer(bytes, 0x424), pointer(this.persistent.bytes), 0x100000);
    view.setUint32(0x100424, this.strings.count(reserved), true);
    this.strings.copyAll(pointer(bytes, 0x100428), reserved);
    this.bits.copyPacked(pointer(bytes, 0x100428 + stringBytes));
    const encoded = encodeAokanaSdc(bytes, this.readSystemTime().getUTCMilliseconds());
    if (encoded === null) {
      const errorPath = this.root.path(new TextEncoder().encode('BGIError.txt\0'));
      await this.output.write(pointer(errorPath), pointer(bytes), length);
      await this.resources.errors.show(
        this.resources.files.text.encodeWide('SDCエンコーディングに失敗しました', 1),
      );
    }
    const path = this.root.path(gdbName),
      count = encoded?.length ?? 0;
    const written = await this.output.write(
      pointer(path),
      encoded === null ? null : pointer(encoded),
      count,
    );
    return written === count ? 1 : 0;
  }
}
