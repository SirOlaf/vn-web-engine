import {dxgiLayout, type DxgiLayout} from '../../../graphics/dxgi-layout.js';
import type {
  D3d11Box,
  D3d11BufferDesc,
  D3d11MappedSubresource,
  D3d11Result,
  D3d11SubresourceData,
  D3d11Texture2DDesc,
  ID3D11Buffer,
  ID3D11Device,
  ID3D11Resource,
  ID3D11Texture2D,
} from '../contract.js';
import {D3d11Lifetime, D3d11Object} from './com.js';

const INVALID = 0x80070057 | 0;
const OUT_OF_MEMORY = 0x8007000e | 0;
const CPU_WRITE = 0x10000,
  CPU_READ = 0x20000;
const MAX_BYTES = 256 * 1024 * 1024;
const CHILD_IID = '1841e5c8-16b0-489b-bcc8-44cfb0d5deae';
const RESOURCE_IID = 'dc8e63f3-d12b-4952-b47b-5e45026a862d';

export interface D3d11ResourceOwner {
  readonly lifetime: D3d11Lifetime;
  readonly device: ID3D11Device;
  resourceDestroyed(resource: D3d11ResourceStorage): void;
  /** Commit pending GPU writes to canonical bytes before a preserving CPU operation. */
  synchronizeResource?(resource: D3d11ResourceStorage): void;
  /** Non-blocking readiness query for Map(DO_NOT_WAIT); absent means canonical bytes are ready. */
  resourceReady?(resource: D3d11ResourceStorage): boolean;
}

interface Level {
  readonly width: number;
  readonly height: number;
  readonly rowPitch: number;
  readonly rows: number;
  bytes: Uint8Array;
  mapped: {readonly type: number; readonly bytes: Uint8Array} | null;
}
interface Access {
  readonly usage: number;
  readonly cpuAccessFlags: number;
  readonly bindFlags: number;
  readonly miscFlags: number;
}
interface CopyRegion {
  readonly offset: number;
  readonly rowBytes: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
}
export interface D3d11CopyPlan {
  readonly source: Level;
  readonly destination: Level;
  readonly from: CopyRegion;
  readonly to: CopyRegion;
}
const uint = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

/** Common usage rules for the supported ordinary buffer/Texture2D storage. */
function validAccess(desc: Access, initialized: boolean): boolean {
  if (
    ![desc.usage, desc.cpuAccessFlags, desc.bindFlags, desc.miscFlags].every(uint) ||
    (desc.cpuAccessFlags & ~(CPU_READ | CPU_WRITE)) !== 0
  )
    return false;
  if (desc.cpuAccessFlags !== 0 && desc.miscFlags !== 0) return false;
  switch (desc.usage) {
    case 0:
      return desc.cpuAccessFlags === 0;
    case 1:
      return initialized && desc.cpuAccessFlags === 0 && (desc.bindFlags & 0xe0) === 0;
    case 2:
      return (
        desc.cpuAccessFlags === CPU_WRITE && desc.bindFlags !== 0 && (desc.bindFlags & 0xf0) === 0
      );
    case 3:
      return desc.bindFlags === 0 && desc.miscFlags === 0;
    default:
      return false;
  }
}

/** Source pitch and extent have already been validated before any storage allocation. */
function copyRows(level: Level, source: D3d11SubresourceData): void {
  for (let row = 0; row < level.rows; row++)
    level.bytes.set(
      source.data.subarray(row * source.rowPitch, row * source.rowPitch + level.rowPitch),
      row * level.rowPitch,
    );
}

/** CPU storage and ownership shared by device resources. Never exposed across the contract. */
export abstract class D3d11ResourceStorage extends D3d11Object implements ID3D11Resource {
  revision = 0;
  private disposed = false;
  /** Descriptor bind flags without the defensive `getDesc()` copy. */
  get bindFlags(): number {
    return this.access.bindFlags;
  }

  protected constructor(
    readonly owner: D3d11ResourceOwner,
    private readonly access: Access,
    readonly layout: DxgiLayout,
    private readonly dimension: number,
    readonly levels: Level[],
    iid: string,
  ) {
    super(owner.lifetime, [CHILD_IID, RESOURCE_IID, iid], () => {
      this.disposed = true;
      for (const level of levels) {
        level.bytes = new Uint8Array(0);
        level.mapped = null;
      }
      owner.resourceDestroyed(this);
    });
  }

  getDevice(): ID3D11Device {
    this.ensureAlive();
    this.owner.device.addRef();
    return this.owner.device;
  }
  getType(): number {
    return this.dimension;
  }

  /** Borrowed implementation storage; a mapped subresource cannot be consumed by the GPU. */
  storage(subresource: number): Level {
    const level = this.level(subresource);
    this.owner.synchronizeResource?.(this);
    return level;
  }

  private level(subresource: number): Level {
    this.ensureAlive();
    const level = uint(subresource) ? this.levels[subresource] : undefined;
    if (!level || level.mapped) throw new Error('Invalid or mapped D3D11 subresource');
    return level;
  }

  map(subresource: number, type: number, flags: number): D3d11Result<D3d11MappedSubresource> {
    this.ensureAlive();
    const level = uint(subresource) ? this.levels[subresource] : undefined;
    const {usage, cpuAccessFlags: cpu, bindFlags} = this.access;
    if (
      !level ||
      level.mapped ||
      ![0, 0x100000].includes(flags) ||
      !uint(type) ||
      type < 1 ||
      type > 5 ||
      ((type === 1 || type === 3) && !(cpu & CPU_READ)) ||
      (type !== 1 && !(cpu & CPU_WRITE)) ||
      ((type === 4 || type === 5) && usage !== 2) ||
      (type === 5 && (this.dimension !== 1 || !(bindFlags & 3) || (bindFlags & ~3) !== 0)) ||
      ((type === 4 || type === 5) && flags !== 0) ||
      (type === 4 && this.dimension === 3 && subresource !== 0)
    )
      return {hr: INVALID, value: null};
    if (type === 4 && this.dimension === 3 && this.levels.some((entry) => entry.mapped))
      return {hr: INVALID, value: null};
    if (flags === 0x100000 && this.owner.resourceReady?.(this) === false)
      return {hr: 0x887a000a | 0, value: null};
    if (type !== 4) this.owner.synchronizeResource?.(this);
    try {
      // Allocate all replacement storage before modifying any level. WRITE_DISCARD
      // on the top texture mip discards the complete chain; lower mips are undefined.
      const bytes = type === 4 ? new Uint8Array(level.bytes.length) : level.bytes.slice();
      const lower =
        type === 4 && this.dimension === 3
          ? this.levels.slice(1).map((entry) => new Uint8Array(entry.bytes.length))
          : [];
      lower.forEach((data, i) => {
        this.levels[i + 1]!.bytes = data;
      });
      level.mapped = {type, bytes};
      return {
        hr: 0,
        value: {data: bytes, rowPitch: level.rowPitch, depthPitch: level.bytes.length},
      };
    } catch (error) {
      if (error instanceof RangeError) return {hr: OUT_OF_MEMORY, value: null};
      throw error;
    }
  }

  unmap(subresource: number): void {
    this.ensureAlive();
    const level = uint(subresource) ? this.levels[subresource] : undefined;
    if (!level?.mapped) throw new Error('Unmapping an unmapped D3D11 subresource');
    if (level.mapped.type !== 1) {
      level.bytes.set(level.mapped.bytes);
      this.revision++;
    }
    level.mapped = null;
  }

  update(subresource: number, box: D3d11Box | null, data: Uint8Array, rowPitch: number): void {
    const level = this.level(subresource);
    if (empty(box)) return;
    if (
      this.access.usage !== 0 ||
      this.layout.depth ||
      ((this.access.bindFlags & 4) !== 0 && box !== null)
    )
      throw new Error('D3D11 resource cannot be updated');
    const region = this.region(level, box);
    const pitch = this.dimension === 1 ? region.rowBytes : rowPitch;
    if (
      !uint(pitch) ||
      pitch < region.rowBytes ||
      data.byteLength < (region.rows - 1) * pitch + region.rowBytes
    )
      throw new Error('Truncated D3D11 subresource data');
    this.owner.synchronizeResource?.(this);
    for (let row = 0; row < region.rows; row++)
      level.bytes.set(
        data.subarray(row * pitch, row * pitch + region.rowBytes),
        region.offset + row * level.rowPitch,
      );
    this.revision++;
  }

  copyFrom(
    subresource: number,
    x: number,
    y: number,
    z: number,
    source: D3d11ResourceStorage,
    sourceSubresource: number,
    box: D3d11Box | null,
  ): void {
    const plan = this.copyPlan(subresource, x, y, z, source, sourceSubresource, box);
    if (!plan) return;
    const {destination, source: input, from, to} = plan;
    source.owner.synchronizeResource?.(source);
    this.owner.synchronizeResource?.(this);
    for (let row = 0; row < from.rows; row++)
      destination.bytes.set(
        input.bytes.subarray(
          from.offset + row * input.rowPitch,
          from.offset + row * input.rowPitch + from.rowBytes,
        ),
        to.offset + row * destination.rowPitch,
      );
    this.revision++;
  }

  /** Validate a CPU/GPU copy without synchronizing or changing any bytes. */
  copyPlan(
    subresource: number,
    x: number,
    y: number,
    z: number,
    source: D3d11ResourceStorage,
    sourceSubresource: number,
    box: D3d11Box | null,
  ): D3d11CopyPlan | null {
    const destination = this.level(subresource),
      input = source.level(sourceSubresource);
    if (empty(box)) return null;
    if (this === source && subresource === sourceSubresource)
      throw new Error('Copying a D3D11 subresource onto itself');
    if (
      this.access.usage === 1 ||
      this.owner.lifetime !== source.owner.lifetime ||
      this.dimension !== source.dimension ||
      !this.sameFormat(source) ||
      ![x, y, z].every(uint) ||
      z !== 0
    )
      throw new Error('Incompatible D3D11 resource copy');
    const from = source.region(input, box);
    const toBox = {
      left: x,
      top: y,
      front: 0,
      right: x + from.width,
      bottom: y + from.height,
      back: 1,
    };
    const to = this.region(destination, toBox);
    if (
      this.layout.depth &&
      (box !== null ||
        x !== 0 ||
        y !== 0 ||
        destination.width !== input.width ||
        destination.height !== input.height)
    )
      throw new Error('D3D11 depth copies require a complete subresource');
    return {source: input, destination, from, to};
  }

  copyAllFrom(source: D3d11ResourceStorage): void {
    this.validateWholeCopy(source);
    source.owner.synchronizeResource?.(source);
    for (let i = 0; i < this.levels.length; i++) this.levels[i]!.bytes.set(source.levels[i]!.bytes);
    this.revision++;
  }

  /** Validate a whole CPU/GPU resource copy before any destination is modified. */
  validateWholeCopy(source: D3d11ResourceStorage): void {
    this.ensureAlive();
    source.ensureAlive();
    if (
      this === source ||
      this.access.usage === 1 ||
      this.owner.lifetime !== source.owner.lifetime ||
      this.dimension !== source.dimension ||
      !this.sameFormat(source) ||
      this.levels.length !== source.levels.length ||
      this.levels.some(
        (level, i) =>
          level.width !== source.levels[i]!.width ||
          level.height !== source.levels[i]!.height ||
          level.mapped ||
          source.levels[i]!.mapped,
      )
    )
      throw new Error('Incompatible D3D11 whole-resource copy');
  }

  protected abstract sameFormat(other: D3d11ResourceStorage): boolean;

  private ensureAlive(): void {
    if (this.disposed || this.lifetime.closed) throw new Error('Using a released D3D11 resource');
  }

  private region(level: Level, box: D3d11Box | null): CopyRegion {
    const b = box ?? {left: 0, top: 0, front: 0, right: level.width, bottom: level.height, back: 1};
    const {blockWidth: bw, blockHeight: bh, blockBytes: bytes} = this.layout;
    if (
      ![b.left, b.top, b.front, b.right, b.bottom, b.back].every(uint) ||
      b.front !== 0 ||
      b.back !== 1 ||
      b.left >= b.right ||
      b.top >= b.bottom ||
      b.right > level.width ||
      b.bottom > level.height ||
      b.left % bw !== 0 ||
      b.top % bh !== 0 ||
      (b.right % bw !== 0 && b.right !== level.width) ||
      (b.bottom % bh !== 0 && b.bottom !== level.height)
    )
      throw new Error('Invalid D3D11 subresource box');
    return {
      offset: (b.top / bh) * level.rowPitch + (b.left / bw) * bytes,
      rowBytes: Math.ceil((b.right - b.left) / bw) * bytes,
      rows: Math.ceil((b.bottom - b.top) / bh),
      width: b.right - b.left,
      height: b.bottom - b.top,
    };
  }
}

function empty(box: D3d11Box | null): boolean {
  return box !== null && (box.left >= box.right || box.top >= box.bottom || box.front >= box.back);
}

export class D3d11Buffer extends D3d11ResourceStorage implements ID3D11Buffer {
  constructor(
    owner: D3d11ResourceOwner,
    private readonly desc: D3d11BufferDesc,
    level: Level,
  ) {
    super(
      owner,
      desc,
      {blockWidth: 1, blockHeight: 1, blockBytes: 1, depth: false},
      1,
      [level],
      '48570b85-d1ee-4fcd-a250-eb350722b037',
    );
  }
  getDesc(): D3d11BufferDesc {
    return {...this.desc};
  }
  protected sameFormat(other: D3d11ResourceStorage): boolean {
    return other instanceof D3d11Buffer;
  }
}

export class D3d11Texture2D extends D3d11ResourceStorage implements ID3D11Texture2D {
  /** `zeroCreated`: created without initial data, so revision 0 bytes are all zero. */
  constructor(
    owner: D3d11ResourceOwner,
    private readonly desc: D3d11Texture2DDesc,
    layout: DxgiLayout,
    levels: Level[],
    readonly zeroCreated = false,
  ) {
    super(owner, desc, layout, 3, levels, '6f15aaf2-d208-4e89-9ab4-489535d34f9c');
  }
  /** Descriptor format without the defensive `getDesc()` copy. */
  get format(): number {
    return this.desc.format;
  }
  getDesc(): D3d11Texture2DDesc {
    return {...this.desc, sampleDesc: {...this.desc.sampleDesc}};
  }
  protected sameFormat(other: D3d11ResourceStorage): boolean {
    return other instanceof D3d11Texture2D && this.desc.format === other.desc.format;
  }
}

/** Supported ordinary vertex/index/constant buffers, with no structured/raw/stream-output binding. */
export function createBufferStorage(
  owner: D3d11ResourceOwner,
  desc: D3d11BufferDesc,
  initial: D3d11SubresourceData | null,
  validateOnly = false,
): D3d11Result<D3d11Buffer> {
  if (
    !validAccess(desc, initial !== null) ||
    !uint(desc.byteWidth) ||
    desc.byteWidth === 0 ||
    (desc.bindFlags & ~7) !== 0 ||
    desc.miscFlags !== 0 ||
    !uint(desc.structureByteStride) ||
    desc.structureByteStride !== 0 ||
    ((desc.bindFlags & 4) !== 0 &&
      (desc.bindFlags !== 4 || desc.byteWidth % 16 !== 0 || desc.byteWidth > 65536)) ||
    (initial !== null && initial.data.length < desc.byteWidth)
  )
    return {hr: INVALID, value: null};
  if (desc.byteWidth > MAX_BYTES) return {hr: OUT_OF_MEMORY, value: null};
  if (validateOnly) return {hr: 1, value: null};
  let bytes: Uint8Array;
  try {
    // Copying straight from the initial data skips zero-filling a buffer that is overwritten.
    bytes = initial
      ? Uint8Array.prototype.slice.call(initial.data, 0, desc.byteWidth)
      : new Uint8Array(desc.byteWidth);
  } catch (error) {
    if (error instanceof RangeError) return {hr: OUT_OF_MEMORY, value: null};
    throw error;
  }
  return {
    hr: 0,
    value: new D3d11Buffer(
      owner,
      {...desc},
      {width: desc.byteWidth, height: 1, rowPitch: desc.byteWidth, rows: 1, bytes, mapped: null},
    ),
  };
}

/** Single-sample typed textures; the array order is mip + arraySlice*mipLevels. */
export function createTexture2DStorage(
  owner: D3d11ResourceOwner,
  desc: D3d11Texture2DDesc,
  initial: readonly D3d11SubresourceData[] | null,
  validateOnly = false,
): D3d11Result<D3d11Texture2D> {
  const layout = dxgiLayout(desc.format);
  if (
    !layout ||
    !validAccess(desc, initial !== null) ||
    ![desc.width, desc.height, desc.mipLevels, desc.arraySize].every(uint) ||
    desc.width < 1 ||
    desc.width > 16384 ||
    desc.height < 1 ||
    desc.height > 16384 ||
    desc.arraySize < 1 ||
    desc.arraySize > 2048 ||
    desc.sampleDesc.count !== 1 ||
    desc.sampleDesc.quality !== 0 ||
    (desc.bindFlags & ~0x68) !== 0 ||
    (desc.miscFlags & ~1) !== 0 ||
    (layout.depth && (desc.bindFlags & ~0x40) !== 0) ||
    (!layout.depth && (desc.bindFlags & 0x40) !== 0) ||
    (layout.blockWidth > 1 &&
      ((desc.bindFlags & ~8) !== 0 || desc.width % 4 !== 0 || desc.height % 4 !== 0)) ||
    (desc.miscFlags === 1 &&
      (desc.usage !== 0 ||
        layout.depth ||
        layout.blockWidth !== 1 ||
        (desc.bindFlags & 0x28) !== 0x28)) ||
    (desc.usage === 2 && desc.arraySize !== 1) ||
    (desc.usage === 3 && layout.depth)
  )
    return {hr: INVALID, value: null};
  const maxMips = 1 + Math.floor(Math.log2(Math.max(desc.width, desc.height)));
  const mipLevels = desc.mipLevels === 0 ? maxMips : desc.mipLevels;
  if (mipLevels > maxMips || (initial !== null && initial.length !== mipLevels * desc.arraySize))
    return {hr: INVALID, value: null};
  const specs: {width: number; height: number; rowPitch: number; rows: number}[] = [];
  let total = 0;
  for (let array = 0; array < desc.arraySize; array++)
    for (let mip = 0; mip < mipLevels; mip++) {
      const width = Math.max(1, desc.width >> mip),
        height = Math.max(1, desc.height >> mip);
      const rowPitch = Math.ceil(width / layout.blockWidth) * layout.blockBytes,
        rows = Math.ceil(height / layout.blockHeight);
      total += rowPitch * rows;
      if (total > MAX_BYTES) return {hr: OUT_OF_MEMORY, value: null};
      const input = initial?.[specs.length];
      if (
        input &&
        (!uint(input.rowPitch) ||
          !uint(input.slicePitch) ||
          input.rowPitch < rowPitch ||
          input.data.length < (rows - 1) * input.rowPitch + rowPitch)
      )
        return {hr: INVALID, value: null};
      specs.push({width, height, rowPitch, rows});
    }
  if (validateOnly) return {hr: 1, value: null};
  let levels: Level[];
  try {
    levels = specs.map((spec, i): Level => {
      const level = {...spec, bytes: new Uint8Array(spec.rowPitch * spec.rows), mapped: null};
      if (initial) copyRows(level, initial[i]!);
      return level;
    });
  } catch (error) {
    if (error instanceof RangeError) return {hr: OUT_OF_MEMORY, value: null};
    throw error;
  }
  return {
    hr: 0,
    value: new D3d11Texture2D(
      owner,
      {...desc, mipLevels, sampleDesc: {...desc.sampleDesc}},
      layout,
      levels,
      initial === null,
    ),
  };
}
