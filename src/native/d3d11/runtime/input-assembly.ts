import {dxgiVertexFormat} from '../../../graphics/dxgi-vertex.js';
import type {D3d11DeviceOwner} from './com.js';
import type {D3d11InputLayout} from './input-layout.js';
import type {D3d11Buffer} from './resources.js';

const uint = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
interface Element {
  readonly format: number;
  /** Element size, or0 for a format that fails when read. */
  readonly bytes: number;
  readonly target: number;
  readonly data: DataView;
  readonly offset: number;
  readonly stride: number;
  readonly relative: number;
  readonly instance: boolean;
}

/** Validated register-to-staging offsets of frozen register lists (linked programs). */
const frozenTargets = new WeakMap<readonly number[], ReadonlyMap<number, number>>();

function registerTargets(registers: readonly number[]): ReadonlyMap<number, number> | null {
  const frozen = Object.isFrozen(registers),
    known = frozen ? frozenTargets.get(registers) : undefined;
  if (known) return known;
  if (
    registers.length > 16 ||
    new Set(registers).size !== registers.length ||
    registers.some((r) => !uint(r) || r >= 32)
  )
    return null;
  const targets = new Map(registers.map((r, i) => [r, i * 4]));
  if (frozen) frozenTargets.set(registers, targets);
  return targets;
}

/** Per-layout elements read for one frozen register list; streams are bound per draw. */
interface Template {
  readonly elements: readonly {
    readonly format: number;
    readonly bytes: number;
    readonly target: number;
    readonly slot: number;
    readonly relative: number;
    readonly instance: boolean;
  }[];
  readonly missing: boolean;
}
const layoutTemplates = new WeakMap<
  readonly number[],
  WeakMap<D3d11InputLayout, Template>
>();

function templateOf(
  layout: D3d11InputLayout,
  registers: readonly number[],
  targets: ReadonlyMap<number, number>,
): Template {
  const frozen = Object.isFrozen(registers),
    templates = frozen ? layoutTemplates.get(registers) : undefined,
    known = templates?.get(layout);
  if (known) return known;
  const template: Template = {
    elements: layout.elements
      .filter((e) => e.register !== null && targets.has(e.register))
      .map((e) => ({
        format: e.format,
        bytes: dxgiVertexFormat(e.format)?.bytes ?? 0,
        target: targets.get(e.register!)!,
        slot: e.inputSlot,
        relative: e.offset,
        instance: e.inputSlotClass === 1,
      })),
    missing: registers.some((r) => !layout.elements.some((e) => e.register === r)),
  };
  if (frozen)
    (templates ?? layoutTemplates.set(registers, new WeakMap()).get(registers)!).set(
      layout,
      template,
    );
  return template;
}

/** A borrowed draw-time view. The immediate context retains its buffers for the whole draw. */
export class D3d11VertexReader {
  private readonly elements: readonly Element[];
  readonly floatsPerVertex: number;

  constructor(
    owner: D3d11DeviceOwner,
    layout: D3d11InputLayout,
    registers: readonly number[],
    buffers: readonly (D3d11Buffer | null)[],
    strides: readonly number[],
    offsets: readonly number[],
  ) {
    const targets = registerTargets(registers);
    if (!layout.live || layout.lifetime !== owner.lifetime || !targets)
      throw new Error('Invalid D3D11 input assembler layout');
    const views = new Map<number, DataView>(),
      template = templateOf(layout, registers, targets);
    const elements: Element[] = [];
    for (const e of template.elements) {
      const buffer = buffers[e.slot] ?? null,
        stride = strides[e.slot],
        offset = offsets[e.slot];
      if (!uint(stride!) || stride! > 2048 || !uint(offset!))
        throw new Error('Invalid D3D11 vertex stream bounds');
      if (!buffer)
        throw new Error('Unbound D3D11 vertex streams are outside the supported input subset');
      if (
        !buffer.live ||
        buffer.lifetime !== owner.lifetime ||
        !(buffer.bindFlags & 1) ||
        buffer.levels[0]!.mapped
      )
        throw new Error('Invalid D3D11 vertex stream');
      let data = views.get(e.slot);
      if (!data) {
        const bytes = buffer.levels[0]!.bytes;
        views.set(e.slot, (data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
      }
      elements.push({
        format: e.format,
        bytes: e.bytes,
        target: e.target,
        data,
        offset: offset!,
        stride: stride!,
        relative: e.relative,
        instance: e.instance,
      });
    }
    if (template.missing) throw new Error('Missing D3D11 vertex input');
    this.elements = elements;
    this.floatsPerVertex = registers.length * 4;
  }

  /** Instance0 input registers receive float4 values at a caller-selected float stride. */
  read(vertex: number, output: Float32Array, destination = 0, registerStride = 4): void {
    const span =
      this.floatsPerVertex === 0 ? 0 : (this.floatsPerVertex / 4 - 1) * registerStride + 4;
    if (
      !uint(vertex) ||
      !Number.isSafeInteger(destination) ||
      destination < 0 ||
      !Number.isSafeInteger(registerStride) ||
      registerStride < 4 ||
      !Number.isSafeInteger(span) ||
      destination > output.length - span
    )
      throw new RangeError('Invalid D3D11 vertex read');
    // Inline fetchDxgiVertexElement: the span check above bounds every destination.
    for (const e of this.elements) {
      if (!e.bytes) throw new Error(`Unsupported DXGI vertex format ${e.format}`);
      const address = (e.offset + Math.imul(e.stride, e.instance ? 0 : vertex) + e.relative) >>> 0,
        data = e.data,
        at = destination + (e.target / 4) * registerStride;
      if (address < e.offset || address > data.byteLength - e.bytes) {
        output[at] = output[at + 1] = output[at + 2] = 0;
        output[at + 3] = e.format === 87 ? 0 : 1;
      } else if (e.format === 87) {
        const color = data.getUint32(address, true);
        output[at] = ((color >>> 16) & 255) / 255;
        output[at + 1] = ((color >>> 8) & 255) / 255;
        output[at + 2] = (color & 255) / 255;
        output[at + 3] = (color >>> 24) / 255;
      } else {
        output[at] = data.getFloat32(address, true);
        output[at + 1] = data.getFloat32(address + 4, true);
        output[at + 2] = e.format === 6 ? data.getFloat32(address + 8, true) : 0;
        output[at + 3] = 1;
      }
    }
  }

  /** Planar draw staging: register `r` of draw slot `i` is the float4 at `(r * count + i) * 4`.
   * Slot `i` reads vertex `(start + i)`, or its index when `indices` is bound, plus `base`;
   * index values equal to `cut` skip their slot, which keeps its previous contents. `slots`
   * is caller scratch for the per-slot vertices. */
  readDraw(
    output: Float32Array,
    count: number,
    start: number,
    base: number,
    indices: D3d11IndexReader | null,
    cut: number,
    slots: Float64Array,
  ): void {
    if (
      !uint(count) ||
      !uint(start) ||
      !Number.isInteger(base) ||
      count * this.floatsPerVertex > output.length ||
      count > slots.length
    )
      throw new RangeError('Invalid D3D11 vertex read');
    let drawn = false;
    for (let i = 0; i < count; i++) {
      let vertex = (start + i) >>> 0;
      if (indices) {
        vertex = indices.read(vertex);
        if (vertex === cut) {
          slots[i] = -1;
          continue;
        }
      }
      slots[i] = (vertex + base) >>> 0;
      drawn = true;
    }
    if (!drawn) return;
    // Element-major fetchDxgiVertexElement; the bound check above covers every slot.
    const registerStride = count * 4;
    for (const e of this.elements) {
      if (!e.bytes) throw new Error(`Unsupported DXGI vertex format ${e.format}`);
      const data = e.data,
        first = e.offset,
        last = data.byteLength - e.bytes,
        stride = e.instance ? 0 : e.stride,
        relative = e.relative,
        bgra = e.format === 87,
        z = e.format === 6;
      if (((data.byteOffset | first | stride | relative) & 3) === 0) {
        // Word-aligned streams: the same little-endian words through typed views.
        const floats = new Float32Array(data.buffer, data.byteOffset, data.byteLength >>> 2),
          words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2);
        for (let i = 0, at = (e.target / 4) * registerStride; i < count; i++, at += 4) {
          const vertex = slots[i]!;
          if (vertex < 0) continue;
          const address = (first + Math.imul(stride, vertex) + relative) >>> 0;
          if (address < first || address > last) {
            output[at] = output[at + 1] = output[at + 2] = 0;
            output[at + 3] = bgra ? 0 : 1;
          } else if (bgra) {
            const color = words[address >>> 2]!;
            output[at] = ((color >>> 16) & 255) / 255;
            output[at + 1] = ((color >>> 8) & 255) / 255;
            output[at + 2] = (color & 255) / 255;
            output[at + 3] = (color >>> 24) / 255;
          } else {
            const w = address >>> 2;
            output[at] = floats[w]!;
            output[at + 1] = floats[w + 1]!;
            output[at + 2] = z ? floats[w + 2]! : 0;
            output[at + 3] = 1;
          }
        }
        continue;
      }
      for (let i = 0, at = (e.target / 4) * registerStride; i < count; i++, at += 4) {
        const vertex = slots[i]!;
        if (vertex < 0) continue;
        const address = (first + Math.imul(stride, vertex) + relative) >>> 0;
        if (address < first || address > last) {
          output[at] = output[at + 1] = output[at + 2] = 0;
          output[at + 3] = bgra ? 0 : 1;
        } else if (bgra) {
          const color = data.getUint32(address, true);
          output[at] = ((color >>> 16) & 255) / 255;
          output[at + 1] = ((color >>> 8) & 255) / 255;
          output[at + 2] = (color & 255) / 255;
          output[at + 3] = (color >>> 24) / 255;
        } else {
          output[at] = data.getFloat32(address, true);
          output[at + 1] = data.getFloat32(address + 4, true);
          output[at + 2] = z ? data.getFloat32(address + 8, true) : 0;
          output[at + 3] = 1;
        }
      }
    }
  }
}

/** Native16/32-bit index reads, with wrapping addresses and zero out-of-bounds values. */
export class D3d11IndexReader {
  private readonly data: DataView;
  private readonly width: number;
  constructor(
    owner: D3d11DeviceOwner,
    buffer: D3d11Buffer,
    format: number,
    private readonly offset: number,
  ) {
    if (
      !buffer.live ||
      buffer.lifetime !== owner.lifetime ||
      !(buffer.bindFlags & 2) ||
      buffer.levels[0]!.mapped ||
      ![42, 57].includes(format) ||
      !uint(offset) ||
      offset % (format === 42 ? 4 : 2)
    )
      throw new Error('Invalid D3D11 index stream');
    const bytes = buffer.levels[0]!.bytes;
    this.data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.width = format === 42 ? 4 : 2;
  }
  read(index: number): number {
    if (!uint(index)) throw new RangeError('Invalid D3D11 index read');
    const address = (this.offset + Math.imul(index, this.width)) >>> 0;
    if (address < this.offset || address > this.data.byteLength - this.width) return 0;
    return this.width === 4
      ? this.data.getUint32(address, true)
      : this.data.getUint16(address, true);
  }
}
