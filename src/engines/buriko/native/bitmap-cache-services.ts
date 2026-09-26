import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoBitmapLoading} from './bitmap-loading.js';
import type {BurikoBitmapRegistration} from './bitmap-registration.js';
import {burikoPackedBitmapFormat} from './bitmap-image.js';
import {parseBurikoBitmapLayers} from './bitmap-layer-spec.js';
import {codecView} from './codec-storage.js';
import {copyText, textBytes, writeText} from './text.js';

export class BurikoBitmapCacheServices {
  constructor(
    readonly loading: BurikoBitmapLoading,
    readonly registration: BurikoBitmapRegistration,
  ) {
    if (loading.resources !== registration.loading || loading.surfaces !== registration.surfaces)
      throw new Error('Buriko bitmap services require shared loading/cache/surface owners');
  }
  async allocateHeader(
    index: number,
    archive: Uint8Array | null,
    name: Uint8Array,
  ): Promise<number> {
    const operationAllocator = this.loading.surfaces.allocator,
      operationActor = operationAllocator.currentActor;
    const runAsActor = <T>(operation: () => T): T =>
      operationAllocator.withActor(operationActor, operation);

    const bytes = new Uint8Array(48),
      initialized = new Uint8Array(48),
      read = await this.loading.resources.ranges.read({bytes, offset: 0}, archive, name, 0, 48);
    if (read.result !== 0) return read.result === 2 || read.result === 3 ? 0x8000000d : 0xffffffff;
    if (read.size === null || read.size < 0 || read.size > 48)
      throw new Error('Buriko header range has no bounded initialized byte count');
    initialized.fill(1, 0, read.size);
    const pointer = {bytes, offset: 0, initialized},
      word = (at: number) => codecView(pointer, at, 2).getUint16(0, true),
      signature = new TextEncoder().encode('CompressedBG___\0');
    let compressed = true;
    for (let i = 0; i < signature.length; i++)
      if (codecView(pointer, i, 1).getUint8(0) !== signature[i]) {
        compressed = false;
        break;
      }
    const header = compressed ? 16 : 0;
    if (!compressed) {
      if (word(0) === 0 || word(2) === 0) return 0x8000000d;
      const bits = Number(codecView(pointer, 4, 8).getBigUint64(0, true) & 0xffffn);
      if ((bits !== 8 && bits !== 24 && bits !== 32) || word(6) > 1) return 0x8000000d;
    }
    const format = burikoPackedBitmapFormat(bytes.subarray(header), initialized.subarray(header)),
      width = word(header),
      height = word(header + 2),
      surfaces = this.loading.surfaces;
    if (runAsActor(() => surfaces.allocateChecked(index, width, height, format)) !== 0)
      return 0x80000009;
    if (word(header + 10) === 1)
      runAsActor(() => surfaces.setMetadata(index, word(header + 12), word(header + 14)));
    runAsActor(() => surfaces.fill(index, 0));
    return 0;
  }
  async groupAvailable(
    output: BurikoBpPointer | null,
    archive: BurikoBpPointer | null,
    description: BurikoBpPointer | null,
  ): Promise<0 | 1> {
    if (description === null) throw new Error('Buriko bitmap group parser consumes null');
    const text = this.loading.resources.resources.files.text,
      parsed = parseBurikoBitmapLayers(text, textBytes(description));
    if (parsed.result !== 0) {
      if (output !== null)
        writeText(output, text.encodeWide('#' + String(parsed.part - 1).padStart(3, '0'), 0));
      return 0;
    }
    const archiveBytes = archive === null ? null : textBytes(archive).slice();
    for (const layer of parsed.layers)
      if (!(await this.loading.resources.ranges.isAvailable(archiveBytes, layer.name))) {
        if (output !== null) copyText(output, {bytes: layer.name, offset: 0});
        return 0;
      }
    return 1;
  }
}
