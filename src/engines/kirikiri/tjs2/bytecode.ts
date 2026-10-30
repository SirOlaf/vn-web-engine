/**
 * TJS2 bytecode (`TJS2100`, krkrz `tjsByteCodeLoader.cpp` and `ExportByteCode`): a compiled
 * script block in a file. It holds the same instruction words as `CodeBlock` (16 bits each,
 * register and code operands as indices), a shared constant pool, and per context its layout,
 * data area and the members it registers on its parent. Constant arrays and dictionaries
 * cannot be stored (they read back as null objects), and source positions refer to a text the
 * file does not contain, so every instruction reads back as line 1.
 */
import {ContextType, type CodeBlock, type ContextCode, type DataItem} from './code-block.js';

const TAG_TJS2 = 0x32534a54; // "TJS2"
const TAG_100 = 0x00303031; // "100\0"
const TAG_DATA = 0x41544144; // "DATA"
const TAG_OBJS = 0x534a424f; // "OBJS"

const TYPE_VOID = 0;
const TYPE_OBJECT = 1;
const TYPE_INTER_OBJECT = 2;
const TYPE_STRING = 3;
const TYPE_OCTET = 4;
const TYPE_REAL = 5;
const TYPE_BYTE = 6;
const TYPE_SHORT = 7;
const TYPE_INTEGER = 8;
const TYPE_LONG = 9;

/** `IsTJS2ByteCode`: the file starts with `TJS2100\0`. */
export function isTjs2ByteCode(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return v.getUint32(0, true) === TAG_TJS2 && v.getUint32(4, true) === TAG_100;
}

/** `ReadByteCode`: null when the file is not intact bytecode. */
export function readTjs2ByteCode(bytes: Uint8Array, name: string): CodeBlock | null {
  try {
    return read(bytes, name);
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
}

function read(bytes: Uint8Array, name: string): CodeBlock | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o: number) => v.getUint32(o, true);
  const i32 = (o: number) => v.getInt32(o, true);
  if (u32(0) !== TAG_TJS2 || u32(4) !== TAG_100) return null;
  if (u32(8) !== bytes.length) return null;
  if (u32(12) !== TAG_DATA) return null;
  const dataSize = u32(16);

  // ReadDataArea
  let o = 20;
  let count = i32(o);
  o += 4;
  const byteArray: number[] = [];
  for (let i = 0; i < count; i++) byteArray.push(v.getInt8(o + i));
  o += ((count + 3) >> 2) << 2;
  count = i32(o);
  o += 4;
  const shortArray: number[] = [];
  for (let i = 0; i < count; i++, o += 2) shortArray.push(v.getInt16(o, true));
  o += (count & 1) << 1;
  count = i32(o);
  o += 4;
  const longArray: number[] = [];
  for (let i = 0; i < count; i++, o += 4) longArray.push(i32(o));
  count = i32(o);
  o += 4;
  const longLongArray: bigint[] = [];
  for (let i = 0; i < count; i++, o += 8) longLongArray.push(v.getBigInt64(o, true));
  count = i32(o);
  o += 4;
  const doubleArray: number[] = [];
  for (let i = 0; i < count; i++, o += 8) doubleArray.push(v.getFloat64(o, true));
  count = i32(o);
  o += 4;
  const strings: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = i32(o);
    o += 4;
    let s = '';
    for (let j = 0; j < len; j++, o += 2) s += String.fromCharCode(v.getUint16(o, true));
    strings.push(s);
    o += (len & 1) << 1;
  }
  count = i32(o);
  o += 4;
  const octets: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const len = i32(o);
    o += 4;
    octets.push(bytes.slice(o, o + len));
    o += ((len + 3) >> 2) << 2;
  }

  // ReadObjects
  o = 12 + dataSize;
  if (u32(o) !== TAG_OBJS) return null;
  o += 8;
  const topLevel = i32(o);
  const objCount = i32(o + 4);
  o += 8;
  type Partial = Omit<ContextCode, 'members'> & {properties: [number, number][]};
  const objects: Partial[] = [];
  for (let n = 0; n < objCount; n++) {
    if (u32(o) !== TAG_TJS2) throw new RangeError('TJS2 bytecode object tag');
    o += 8;
    const field = () => {
      const x = i32(o);
      o += 4;
      return x;
    };
    const parent = field();
    const nameIndex = field();
    const type = field() as ContextType;
    const maxVariableCount = field();
    const variableReserveCount = field();
    const maxFrameCount = field();
    const funcDeclArgCount = field();
    const funcDeclUnnamedArgArrayBase = field();
    const funcDeclCollapseBase = field();
    const propSetter = field();
    const propGetter = field();
    const superClassGetter = field();
    const srcCount = field();
    o += srcCount * 8;
    const codeSize = field();
    const code = new Int32Array(codeSize);
    for (let i = 0; i < codeSize; i++, o += 2) code[i] = v.getInt16(o, true);
    o += (codeSize & 1) << 1;
    const dataCount = field();
    const data: DataItem[] = [];
    for (let i = 0; i < dataCount; i++, o += 4) {
      const t = v.getInt16(o, true);
      const index = v.getInt16(o + 2, true);
      data.push(dataItem(t, index));
    }
    const scgCount = field();
    const superClassGetterPointers: number[] = [];
    for (let i = 0; i < scgCount; i++) superClassGetterPointers.push(field());
    const propCount = field();
    const properties: [number, number][] = [];
    for (let i = 0; i < propCount; i++) properties.push([field(), field()]);
    objects.push({
      name: nameIndex >= 0 ? (strings[nameIndex] ?? null) : null,
      type,
      parent,
      maxVariableCount,
      variableReserveCount,
      maxFrameCount,
      funcDeclArgCount,
      funcDeclUnnamedArgArrayBase,
      funcDeclCollapseBase,
      propSetter,
      propGetter,
      superClassGetter,
      code,
      data,
      codePositions: new Int32Array(0),
      lines: new Int32Array(0),
      superClassGetterPointers,
      properties,
    });
  }

  function dataItem(type: number, index: number): DataItem {
    switch (type) {
      case TYPE_VOID:
        return {kind: 'void'};
      case TYPE_OBJECT:
        return {kind: 'null'};
      case TYPE_INTER_OBJECT:
        return {kind: 'context', index};
      case TYPE_STRING:
        return {kind: 'string', value: strings[index]!};
      case TYPE_OCTET:
        return {kind: 'octet', value: octets[index]!};
      case TYPE_REAL:
        return {kind: 'real', value: doubleArray[index]!};
      case TYPE_BYTE:
        return {kind: 'integer', value: BigInt(byteArray[index]!)};
      case TYPE_SHORT:
        return {kind: 'integer', value: BigInt(shortArray[index]!)};
      case TYPE_INTEGER:
        return {kind: 'integer', value: BigInt(longArray[index]!)};
      case TYPE_LONG:
        return {kind: 'integer', value: longLongArray[index]!};
      default:
        return {kind: 'void'};
    }
  }

  // Each object's properties are registered on its parent.
  const members: {name: string; context: number}[][] = objects.map(() => []);
  objects.forEach((obj) => {
    for (const [pname, pobj] of obj.properties)
      if (obj.parent >= 0) members[obj.parent]!.push({name: strings[pname]!, context: pobj});
  });
  const contexts: ContextCode[] = objects.map(({properties: _, ...c}, i) => ({
    ...c,
    members: members[i]!,
  }));
  return {name, lineOffset: 0, contexts, topLevel};
}

/**
 * `ExportByteCode`: writes a code block as `TJS2100` bytecode. Every code word must fit in 16
 * bits, as natively. Constant arrays and dictionaries are written as null objects.
 */
export function writeTjs2ByteCode(block: CodeBlock): Uint8Array {
  const pool = new ConstantPool();
  const objects: Uint8Array[] = [];
  // Members registered on a context are written as properties of the member's context.
  const properties = new Map<number, {name: string; context: number}[]>();
  block.contexts.forEach((c) => {
    for (const m of c.members) {
      let list = properties.get(m.context);
      if (!list) properties.set(m.context, (list = []));
      list.push(m);
    }
  });
  block.contexts.forEach((c, index) => {
    const w = new Writer();
    w.i32(c.parent);
    w.i32(c.name === null ? -1 : pool.string(c.name));
    w.i32(c.type);
    w.i32(c.maxVariableCount);
    w.i32(c.variableReserveCount);
    w.i32(c.maxFrameCount);
    w.i32(c.funcDeclArgCount);
    w.i32(c.funcDeclUnnamedArgArrayBase);
    w.i32(c.funcDeclCollapseBase);
    w.i32(c.propSetter);
    w.i32(c.propGetter);
    w.i32(c.superClassGetter);
    w.i32(0); // no source positions
    w.i32(c.code.length);
    for (const word of c.code) {
      if (word < -0x8000 || word > 0x7fff)
        throw new RangeError('TJS2 bytecode: code word out of range');
      w.i16(word);
    }
    if (c.code.length & 1) w.i16(0);
    w.i32(c.data.length);
    for (const d of c.data) {
      const [type, i] = pool.data(d);
      w.i16(type);
      w.i16(i);
    }
    w.i32(c.superClassGetterPointers.length);
    for (const p of c.superClassGetterPointers) w.i32(p);
    const props = properties.get(index) ?? [];
    w.i32(props.length);
    for (const p of props) {
      w.i32(pool.string(p.name));
      w.i32(p.context);
    }
    objects.push(w.bytes());
  });
  const data = pool.export();
  const out = new Writer();
  let objSize = 16;
  for (const b of objects) objSize += b.length + 8;
  const dataSize = data.length + 8;
  out.u32(TAG_TJS2);
  out.u32(TAG_100);
  out.u32(8 + 4 + dataSize + objSize);
  out.u32(TAG_DATA);
  out.u32(dataSize);
  out.raw(data);
  out.u32(TAG_OBJS);
  out.u32(objSize);
  out.i32(block.topLevel);
  out.i32(objects.length);
  for (const b of objects) {
    out.u32(TAG_TJS2);
    out.u32(b.length);
    out.raw(b);
  }
  return out.bytes();
}

class Writer {
  #buf = new Uint8Array(256);
  #view = new DataView(this.#buf.buffer);
  #n = 0;
  #reserve(n: number): void {
    if (this.#n + n <= this.#buf.length) return;
    const b = new Uint8Array(Math.max(this.#buf.length * 2, this.#n + n));
    b.set(this.#buf.subarray(0, this.#n));
    this.#buf = b;
    this.#view = new DataView(b.buffer);
  }
  u8(x: number): void {
    this.#reserve(1);
    this.#view.setUint8(this.#n++, x);
  }
  i16(x: number): void {
    this.#reserve(2);
    this.#view.setInt16(this.#n, x, true);
    this.#n += 2;
  }
  i32(x: number): void {
    this.#reserve(4);
    this.#view.setInt32(this.#n, x, true);
    this.#n += 4;
  }
  u32(x: number): void {
    this.#reserve(4);
    this.#view.setUint32(this.#n, x, true);
    this.#n += 4;
  }
  i64(x: bigint): void {
    this.#reserve(8);
    this.#view.setBigInt64(this.#n, x, true);
    this.#n += 8;
  }
  f64(x: number): void {
    this.#reserve(8);
    this.#view.setFloat64(this.#n, x, true);
    this.#n += 8;
  }
  raw(b: Uint8Array): void {
    this.#reserve(b.length);
    this.#buf.set(b, this.#n);
    this.#n += b.length;
  }
  align4(): void {
    while (this.#n & 3) this.u8(0);
  }
  bytes(): Uint8Array {
    return this.#buf.slice(0, this.#n);
  }
}

/** `tjsConstArrayData`: the shared constant pool. */
class ConstantPool {
  readonly #bytes: number[] = [];
  readonly #shorts: number[] = [];
  readonly #ints: number[] = [];
  readonly #longs: bigint[] = [];
  readonly #doubles: number[] = [];
  readonly #strings: string[] = [];
  readonly #octets: Uint8Array[] = [];
  readonly #index = new Map<string, number>();

  #put<T>(list: T[], key: string, value: T): number {
    let i = this.#index.get(key);
    if (i === undefined) {
      i = list.length;
      list.push(value);
      this.#index.set(key, i);
    }
    return i;
  }

  string(s: string): number {
    return this.#put(this.#strings, `s${s}`, s);
  }

  data(d: DataItem): [number, number] {
    switch (d.kind) {
      case 'void':
        return [TYPE_VOID, 0];
      case 'null':
        return [TYPE_OBJECT, 0];
      case 'array':
      case 'dictionary':
        return [TYPE_OBJECT, -1];
      case 'context':
        return [TYPE_INTER_OBJECT, d.index];
      case 'string':
        return [TYPE_STRING, this.string(d.value)];
      case 'octet':
        return [TYPE_OCTET, this.#put(this.#octets, `o${Array.from(d.value).join(',')}`, d.value)];
      case 'real': {
        const b = new DataView(new ArrayBuffer(8));
        b.setFloat64(0, d.value);
        return [TYPE_REAL, this.#put(this.#doubles, `d${b.getBigUint64(0)}`, d.value)];
      }
      case 'integer': {
        const x = d.value;
        if (x >= -128n && x <= 127n) return [TYPE_BYTE, this.#put(this.#bytes, `b${x}`, Number(x))];
        if (x >= -32768n && x <= 32767n)
          return [TYPE_SHORT, this.#put(this.#shorts, `h${x}`, Number(x))];
        if (x >= -2147483648n && x <= 2147483647n)
          return [TYPE_INTEGER, this.#put(this.#ints, `i${x}`, Number(x))];
        return [TYPE_LONG, this.#put(this.#longs, `l${x}`, x)];
      }
    }
  }

  export(): Uint8Array {
    const w = new Writer();
    w.i32(this.#bytes.length);
    for (const b of this.#bytes) w.u8(b & 0xff);
    w.align4();
    w.i32(this.#shorts.length);
    for (const s of this.#shorts) w.i16(s);
    w.align4();
    w.i32(this.#ints.length);
    for (const x of this.#ints) w.i32(x);
    w.i32(this.#longs.length);
    for (const x of this.#longs) w.i64(x);
    w.i32(this.#doubles.length);
    for (const x of this.#doubles) w.f64(x);
    w.i32(this.#strings.length);
    for (const s of this.#strings) {
      w.i32(s.length);
      for (let i = 0; i < s.length; i++) w.i16(s.charCodeAt(i));
      if (s.length & 1) w.i16(0);
    }
    w.i32(this.#octets.length);
    for (const o of this.#octets) {
      w.i32(o.length);
      w.raw(o);
      w.align4();
    }
    return w.bytes();
  }
}
