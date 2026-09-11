import {checkRange} from '../../../../../core/binary.js';
import type {NoahState} from './noah-state.js';

export interface CompositionResource {
  readonly bytes: Uint8Array;
  readonly header: Uint8Array;
  /** Native private copy, with the uploaded-buffer offsets already rebased. */
  readonly meshes: Uint8Array;
  readonly geometry: Uint8Array | undefined;
  readonly allocations: readonly number[];
}
interface Ownership {
  next: number;
  resources: Map<number, CompositionResource>;
  buffers: Map<number, Uint8Array>;
}
const owners = new WeakMap<NoahState, Ownership>();
function owner(s: NoahState): Ownership {
  let value = owners.get(s);
  if (!value) {
    value = {next: 0x2000000000, resources: new Map(), buffers: new Map()};
    owners.set(s, value);
  }
  return value;
}
export function compositionResource(s: NoahState, index: number): CompositionResource | undefined {
  return owners.get(s)?.resources.get(index);
}
export function compositionByte(s: NoahState, address: number): number | undefined {
  if (address < 0x2000000000) return undefined;
  const o = owners.get(s);
  if (o)
    for (const [base, bytes] of o.buffers)
      if (address >= base && address < base + bytes.length) return bytes[address - base];
  return undefined;
}
/** 140067480 leaves the vtable, name and padding intact. */
function reset(s: NoahState, base: number): void {
  for (const [offset, size] of [
    [0x28, 2],
    [0x70, 1],
    [0x78, 16],
    [0x88, 8],
    [0x90, 1],
    [0x98, 24],
    [0xc4, 12],
    [0x2a, 1],
    [0x30, 8],
    [0x38, 4],
    [0x40, 24],
    [0x58, 4],
    [0x60, 16],
    [0xb0, 4],
    [0xb8, 10],
    [0xd0, 16],
  ] as const)
    s.zero(base + offset, size);
}
function releaseIndex(s: NoahState, index: number): void {
  const base = 0x1d51200 + index * 0xe0;
  if (s.bytes(base, 1)[0] === 0) return;
  const o = owners.get(s),
    resource = o?.resources.get(index);
  if (resource) {
    for (const pointer of resource.allocations) o!.buffers.delete(pointer);
    o!.resources.delete(index);
  }
  s.put(base, 0, 1);
  s.bytes(base + 0x90, 0x20).set(s.bytes(base + 0x70, 0x20));
  reset(s, base);
}
/** 1400678d0: release and reinitialize one compositor resource. */
export function releaseCompositionResource(s: NoahState, id: number): void {
  let index = (id - 8) >>> 0;
  if (index > 7) index = id | 0;
  releaseIndex(s, index);
}
/** 140067530. CPU-owned buffers replace allocation/Direct3D objects, retaining
 * the native header, descriptor copies, union upload span and offset arithmetic.
 * Parsing for the inspector is deliberately separate: this loader accepts both
 * native vertex formats and empty meshes, including a zero-count header. */
export function loadCompositionResource(s: NoahState, index: number, input: Uint8Array): void {
  const base = 0x1d51200 + index * 0xe0,
    o = owner(s);
  releaseIndex(s, index);
  reset(s, base);
  s.put(base, 1, 1);
  s.put(base + 0x28, 0x0101, 2);
  s.put(base + 0x2a, 0, 1);
  s.put(base + 0x38, input.length);
  s.zero(base + 0xd8, 8);
  checkRange(input.length, 0, 0x60);
  const allocations: number[] = [],
    allocate = (bytes: Uint8Array) => {
      const pointer = o.next;
      o.next += Math.max(64, Math.ceil(bytes.length / 64) * 64);
      o.buffers.set(pointer, bytes);
      allocations.push(pointer);
      return pointer;
    };
  const bytes = Uint8Array.from(input),
    header = bytes.slice(0, 0x60),
    view = new DataView(header.buffer),
    count = view.getUint32(4, true);
  s.put(base + 0x30, allocate(bytes), 8);
  s.put(base + 0x40, allocate(header), 8);
  s.put(base + 0x50, count);
  const format = String.fromCharCode(
    ...header.subarray(0x20, header.indexOf(0, 0x20) < 0 ? header.length : header.indexOf(0, 0x20)),
  );
  const stride = format === 'XFYF0FUFVF' || format === 'XFYFZFUFVF' ? 20 : 0;
  s.put(base + 0xb8, stride ? 0x4112 : 0, 8);
  s.put(base + 0xc0, header[9]!, 2);
  checkRange(bytes.length, 0x60, count * 0x40);
  const meshes = bytes.slice(0x60, 0x60 + count * 0x40),
    table = new DataView(meshes.buffer);
  if (count === 0) {
    o.resources.set(index, {bytes, header, meshes, geometry: undefined, allocations});
    return;
  }
  s.put(base + 0x48, allocate(meshes), 8);
  let vertexMin = 0xffffffff,
    indexMin = 0xffffffff,
    vertexEnd = 0,
    indexEnd = 0;
  for (let i = 0; i < count; i++) {
    const p = i * 64,
      vertices = table.getUint32(p + 16, true),
      v = table.getUint32(p + 20, true),
      indices = table.getUint32(p + 24, true),
      n = table.getUint32(p + 28, true);
    if (vertices) {
      vertexMin = Math.min(vertexMin, v);
      vertexEnd = Math.max(vertexEnd, (Math.imul(vertices, stride) + v) >>> 0);
    }
    if (indices) {
      indexMin = Math.min(indexMin, n);
      indexEnd = Math.max(indexEnd, (Math.imul(indices, header[9]! >>> 3) + n) >>> 0);
    }
  }
  const start = Math.min(vertexMin, indexMin),
    size = (Math.max(vertexEnd, indexEnd) - start) >>> 0;
  const vertexSize = (vertexEnd - vertexMin) >>> 0,
    indexSize = (indexEnd - indexMin) >>> 0;
  s.put(base + 0x54, vertexSize);
  s.put(base + 0x58, indexSize);
  let geometry: Uint8Array | undefined;
  if (vertexSize !== 0) {
    checkRange(bytes.length, start, size);
    geometry = bytes.slice(start, start + size);
    const pointer = allocate(geometry);
    // 14007ae60 returns a dynamic buffer descriptor: byte zero replaces only the
    // low byte of ByteWidth, Usage=2, zero offset, and an owned device identity.
    s.put(base + 0x70, (size & 0xffffff00) | 1);
    s.put(base + 0x74, 2);
    s.zero(base + 0x78, 16);
    s.put(base + 0x88, pointer, 8);
    s.put(base + 0x54, size);
  }
  if (indexSize !== 0) {
    s.put(base + 0x58, size);
    s.bytes(base + 0x90, 32).set(s.bytes(base + 0x70, 32));
  }
  for (let i = 0; i < count; i++) {
    const p = i * 64;
    if (table.getUint32(p + 16, true) !== 0)
      table.setUint32(p + 20, table.getUint32(p + 20, true) - vertexMin, true);
    if (table.getUint32(p + 24, true) !== 0)
      table.setUint32(p + 28, table.getUint32(p + 28, true) - vertexMin, true);
  }
  o.resources.set(index, {bytes, header, meshes, geometry, allocations});
  s.put(base, 1, 1);
}
