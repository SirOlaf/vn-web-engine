import type {ID3D11Device, ID3D11DeviceContext} from '../../../d3d11/contract.js';
import type {EmoteScalarVertexGrid} from '../interfaces.js';
import {emoteGridColors} from './vertex-colors.js';

/** Private native mesh record, input-layout row 4 / vertex shader 1. */
export interface EmoteD3d11Mesh {
  readonly vertices: Uint8Array;
  readonly vertexCount: number;
  readonly topology: 4 | 5;
}

/** Reusable packing storage. Draw creation copies the vertices into its own buffer. */
export interface EmoteD3d11MeshScratch {
  bytes: Uint8Array;
}

const f32 = Math.fround;
const MAX_MESH_BYTES = 64 * 1024 * 1024;

/**
 * 0x18005b5a0 / 0x18005c3d0, DLL SHA-256
 * 80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051.
 * Uses the native non-indexed allocation mode (+0x68), with 20-byte XY/BGRA/UV
 * vertices. Corners are packed AARRGGBB in top-left/right, bottom-left/right order.
 * Geometry remains private to the library; no vertex representation enters its ABI.
 */
export function packEmoteD3d11Mesh(
  grid: EmoteScalarVertexGrid,
  corners: Uint32Array,
  left: number,
  top: number,
  width: number,
  height: number,
  textureWidth: number,
  textureHeight: number,
  scratch?: EmoteD3d11MeshScratch,
): EmoteD3d11Mesh {
  const {cols, rows, points} = grid;
  const across = cols + 1,
    down = rows + 1,
    pointCount = across * down,
    quad = cols === 1 && rows === 1,
    vertexCount = quad ? 4 : cols * rows * 6,
    byteLength = vertexCount * 20;
  if (
    !Number.isSafeInteger(cols) ||
    !Number.isSafeInteger(rows) ||
    cols < 0 ||
    rows < 0 ||
    !Number.isSafeInteger(pointCount) ||
    points.length < pointCount * 2 ||
    corners.length < 4
  )
    throw new RangeError('Invalid E-mote mesh grid');
  if (
    !Number.isSafeInteger(vertexCount) ||
    byteLength + (quad || vertexCount === 0 ? 0 : (pointCount + across + down) * 4) > MAX_MESH_BYTES
  )
    throw new RangeError('E-mote mesh exceeds 64 MiB allocation limit');
  // Every packed byte is written below, so reused storage needs no clearing.
  let vertices: Uint8Array;
  if (scratch) {
    if (scratch.bytes.byteLength < byteLength)
      scratch.bytes = new Uint8Array(Math.max(byteLength, scratch.bytes.byteLength * 2));
    vertices = scratch.bytes.subarray(0, byteLength);
  } else vertices = new Uint8Array(byteLength);
  if (vertexCount === 0) return {vertices, vertexCount, topology: 4};
  left = f32(left);
  top = f32(top);
  width = f32(width);
  height = f32(height);
  textureWidth = f32(textureWidth);
  textureHeight = f32(textureHeight);
  // Five words per vertex, in the platform order of the position view below.
  const words = new Uint32Array(vertices.buffer, 0, vertexCount * 5),
    floats = new Float32Array(vertices.buffer, 0, vertexCount * 5),
    positions = new Uint32Array(points.buffer, points.byteOffset, points.length);
  let offset = 0;
  const put = (point: number, color: number, u: number, v: number): void => {
    // MOV32 preserves source position bits, including negative zero and NaN payloads.
    words[offset] = positions[point * 2]!;
    words[offset + 1] = positions[point * 2 + 1]!;
    words[offset + 2] = color;
    floats[offset + 3] = u;
    floats[offset + 4] = v;
    offset += 5;
  };
  if (quad) {
    const u0 = f32(left / textureWidth),
      u1 = f32(f32(left + width) / textureWidth),
      v0 = f32(top / textureHeight),
      v1 = f32(f32(top + height) / textureHeight);
    put(0, corners[0]!, u0, v0);
    put(2, corners[2]!, u0, v1);
    put(1, corners[1]!, u1, v0);
    put(3, corners[3]!, u1, v1);
    return {vertices, vertexCount, topology: 5};
  }
  const colors = emoteGridColors(corners, cols, rows),
    us = new Float32Array(across),
    vs = new Float32Array(down),
    su = f32(1 / textureWidth),
    sv = f32(1 / textureHeight),
    fc = f32(cols),
    fr = f32(rows);
  for (let i = 0; i < across; i++) us[i] = f32(f32(f32(f32(f32(i) * width) / fc) + left) * su);
  for (let j = 0; j < down; j++) vs[j] = f32(f32(f32(f32(f32(j) * height) / fr) + top) * sv);
  for (let j = 0; j < rows; j++) {
    const v0 = vs[j]!,
      v1 = vs[j + 1]!;
    for (let i = 0; i < cols; i++) {
      const a = j * across + i,
        b = a + across,
        u0 = us[i]!,
        u1 = us[i + 1]!;
      put(a, colors[a]!, u0, v0);
      put(b, colors[b]!, u0, v1);
      put(a + 1, colors[a + 1]!, u1, v0);
      put(a + 1, colors[a + 1]!, u1, v0);
      put(b, colors[b]!, u0, v1);
      put(b + 1, colors[b + 1]!, u1, v1);
    }
  }
  return {vertices, vertexCount, topology: 4};
}

const STRIDES: readonly number[] = Object.freeze([20]),
  OFFSETS: readonly number[] = Object.freeze([0]);

/** Native default vertex-buffer creation, binding and Draw; shader/output state is caller-owned. */
export function drawEmoteD3d11Mesh(
  device: ID3D11Device,
  context: ID3D11DeviceContext,
  mesh: EmoteD3d11Mesh,
): void {
  if (mesh.vertexCount === 0) return;
  const result = device.createBuffer(
    {
      byteWidth: mesh.vertices.byteLength,
      usage: 0,
      bindFlags: 1,
      cpuAccessFlags: 0,
      miscFlags: 0,
      structureByteStride: 0,
    },
    {data: mesh.vertices, rowPitch: 0, slicePitch: 0},
  );
  if (result.hr !== 0 || !result.value)
    throw new Error(`E-mote vertex buffer creation failed: ${result.hr}`);
  const buffer = result.value;
  try {
    context.iaSetVertexBuffers(0, [buffer], STRIDES, OFFSETS);
    context.iaSetPrimitiveTopology(mesh.topology);
    context.draw(mesh.vertexCount, 0);
  } finally {
    buffer.release();
  }
}
