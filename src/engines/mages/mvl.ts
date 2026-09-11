import {ascii, checkRange} from '../../core/binary.js';
export interface MvlMesh {
  name: string;
  width: number;
  height: number;
  vertices: Float32Array;
  indices: Uint16Array;
  vertexOffset: number;
  indexOffset: number;
}
export interface Mvl {
  meshes: MvlMesh[];
  byName: Map<string, MvlMesh>;
}
/** Native 140067530/140067a30: MVL1 is an indexed geometry table, not bytecode. */
export function parseMvl(bytes: Uint8Array): Mvl {
  checkRange(bytes.length, 0, 96);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes.subarray(0, 4)) !== 'MVL1') throw new Error('Invalid MVL1 signature');
  const count = v.getUint32(4, true);
  if (!count || count > 16384) throw new Error('Invalid MVL mesh count');
  if (
    v.getUint32(8, true) !== 4096 ||
    ascii(bytes.subarray(32, 42)) !== 'XFYF0FUFVF' ||
    bytes[42] !== 0
  )
    throw new Error('Unsupported MVL vertex/index format');
  const tableEnd = 96 + count * 64;
  checkRange(bytes.length, 96, count * 64);
  const meshes: MvlMesh[] = [],
    byName = new Map<string, MvlMesh>(),
    buffers = new Map<string, Float32Array>();
  for (let i = 0; i < count; i++) {
    const p = 96 + i * 64,
      width = v.getUint32(p, true),
      height = v.getUint32(p + 4, true);
    if (!width || !height || width > 16384 || height > 16384)
      throw new Error('Invalid MVL dimensions');
    if (v.getUint32(p + 8, true) !== 0x01000104 || v.getUint32(p + 12, true) !== 0)
      throw new Error('Unsupported MVL primitive/flags');
    const vertexCount = v.getUint32(p + 16, true),
      vertexOffset = v.getUint32(p + 20, true),
      indexCount = v.getUint32(p + 24, true),
      indexOffset = v.getUint32(p + 28, true);
    if (
      !vertexCount ||
      vertexCount > 65536 ||
      indexCount % 3 ||
      vertexOffset < tableEnd ||
      indexOffset < tableEnd
    )
      throw new Error('Invalid MVL geometry counts/offsets');
    checkRange(bytes.length, vertexOffset, vertexCount * 20);
    checkRange(bytes.length, indexOffset, indexCount * 2);
    const nameBytes = bytes.subarray(p + 32, p + 64),
      end = nameBytes.indexOf(0);
    if (end < 1 || nameBytes.subarray(0, end).some((b) => b < 32 || b > 126))
      throw new Error('Invalid MVL mesh name');
    const name = ascii(nameBytes.subarray(0, end));
    if (byName.has(name)) throw new Error(`Duplicate MVL mesh ${name}`);
    const key = `${vertexOffset}/${vertexCount}`;
    let vertices = buffers.get(key);
    if (!vertices) {
      vertices = new Float32Array(vertexCount * 5);
      for (let j = 0; j < vertices.length; j++) {
        const value = v.getFloat32(vertexOffset + j * 4, true);
        if (!Number.isFinite(value)) throw new Error('Nonfinite MVL vertex');
        vertices[j] = value;
      }
      for (let j = 0; j < vertexCount; j++)
        if (
          vertices[j * 5 + 2] !== 0 ||
          Math.abs(vertices[j * 5]!) > 32768 ||
          Math.abs(vertices[j * 5 + 1]!) > 32768 ||
          vertices[j * 5 + 3]! < 0 ||
          vertices[j * 5 + 3]! > 1 ||
          vertices[j * 5 + 4]! < 0 ||
          vertices[j * 5 + 4]! > 1
        )
          throw new Error('Unsupported MVL coordinates');
      buffers.set(key, vertices);
    }
    const indices = new Uint16Array(indexCount);
    for (let j = 0; j < indexCount; j++) {
      const n = v.getUint16(indexOffset + j * 2, true);
      if (n >= vertexCount) throw new Error('MVL index exceeds vertex buffer');
      indices[j] = n;
    }
    const mesh = {name, width, height, vertices, indices, vertexOffset, indexOffset};
    meshes.push(mesh);
    byName.set(name, mesh);
  }
  return {meshes, byName};
}
export interface CharacterExpression {
  base: MvlMesh;
  mouths: MvlMesh[];
  eyes: MvlMesh[];
}
/** Native 140067f10: draw base, selected L suffix, selected E suffix, in that order. */
export function characterExpressions(mvl: Mvl): CharacterExpression[] {
  return mvl.meshes
    .filter((m) => !/[LE][1-5]$/.test(m.name))
    .map((base) => ({
      base,
      mouths: [1, 2, 3, 4, 5].flatMap((n) => mvl.byName.get(`${base.name}L${n}`) ?? []),
      eyes: [1, 2, 3, 4, 5].flatMap((n) => mvl.byName.get(`${base.name}E${n}`) ?? []),
    }));
}
export function composeCharacter(expression: CharacterExpression, mouth = 0, eyes = 0): MvlMesh[] {
  const result = [expression.base];
  for (const [parts, index] of [
    [expression.mouths, mouth],
    [expression.eyes, eyes],
  ] as const) {
    if (!Number.isInteger(index) || index < -1 || index >= parts.length)
      throw new Error('Invalid character part selection');
    if (index >= 0) result.push(parts[index]!);
  }
  return result;
}
