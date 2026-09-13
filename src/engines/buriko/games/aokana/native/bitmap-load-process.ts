import {AokanaLoadProcedure} from './load-procedure.js';
import {AokanaProcedureState} from './procedure.js';
import {AokanaNativeClock} from './clock.js';
import {AokanaResourceLoadingState} from './resource-loading.js';
import {AokanaBitmapCompositor} from './bitmap-compositor.js';
import {AokanaBitmapStorage, allocateAokanaBitmap, type AokanaBitmap} from './bitmap.js';
import {copyAokanaBitmapRows} from './bitmap-copy.js';
import {aokanaPackedBitmapDescriptor, aokanaPackedBitmapFormat, importAokanaPackedBitmap, importAokanaWindowsBitmap} from './bitmap-image.js';
import {aokanaJapaneseNumber, parseAokanaBitmapLayers, type AokanaBitmapLayer} from './bitmap-layer-spec.js';
import {AokanaSurfaces} from './surfaces.js';
import {AokanaNativeText, textBytes} from './text.js';
import {terminatedNativeBytes} from './program-files.js';
import type {AokanaBpOpcodeContext} from './types.js';

/** sprintf preserves each argument's native bytes, including mixed encodings. */
export function aokanaBitmapMessage(text: AokanaNativeText, template: string, values: Uint8Array[]): Uint8Array {
  const parts = template.split('%s'), pieces: Uint8Array[] = [];
  for (let index = 0; index < parts.length; index++) {
    pieces.push(text.encodeWide(parts[index]!, 0).subarray(0, -1));
    if (index < values.length) pieces.push(textBytes({bytes: terminatedNativeBytes(values[index]!), offset: 0}));
  }
  const size = pieces.reduce((sum, piece) => sum + piece.length, 1), result = new Uint8Array(size);
  let at = 0;
  for (const piece of pieces) { result.set(piece, at); at += piece.length; }
  return result;
}

/** DCProcImageSynth (09BBC0): ordered bitmap parts over the common CProcLoad/FIFO owner. */
export abstract class AokanaBitmapSynthesisProcess extends AokanaLoadProcedure {
  private layers: AokanaBitmapLayer[] = [];
  private multiple = false;
  private layerCacheMiss = false;
  private composed: AokanaBitmap | null = null;
  private header: Uint8Array | null = null;

  protected constructor(
    context: AokanaBpOpcodeContext, procedures: AokanaProcedureState, clock: AokanaNativeClock,
    loading: AokanaResourceLoadingState, readonly compositor: AokanaBitmapCompositor,
    archive: Uint8Array | null, name: Uint8Array,
  ) { super(context, procedures, clock, loading, archive, name); }

  protected async initializeLayers(name: Uint8Array): Promise<void> {
    const parsed = parseAokanaBitmapLayers(this.loading.resources.files.text, name);
    if (parsed.result !== 0) {
      const message = aokanaBitmapMessage(this.loading.resources.files.text,
        '指定された合成ファイル名 [ %s ] の第%sパートにファイル名が記述されていません',
        [name, this.loading.resources.files.text.encodeWide(aokanaJapaneseNumber(parsed.part), 0)]);
      if (message.length > 1024) throw new RangeError('Aokana bitmap part diagnostic exceeds native scratch');
      return this.loading.resources.errors.threadFatal(this.context.thread, this.context.diagnostics, message);
    }
    this.layers = parsed.layers;
    this.multiple = this.layers.length > 1;
  }

  protected override advance(): number {
    const layer = this.layers[0];
    if (layer === undefined) return 0x80000001;
    if (layer.needsLoad) {
      const cached = this.loading.cache.read(this.archiveName, layer.name);
      if (cached !== null) { this.output.bytes = cached; this.result.value = cached.length; }
      else this.loading.enqueueOwned(this.output, this.result, this.archiveName, layer.name);
      layer.needsLoad = false;
      this.layerCacheMiss = cached === null && this.loading.cache.enabled;
    }
    if (this.result.value === 0) return 1;
    if (this.result.value >>> 0 === 0xffffffff) return 0x80000002;
    if (!this.multiple) return 0;
    const bytes = this.output.bytes;
    if (bytes === null) throw new Error('Aokana bitmap synthesis has no successful resource bytes');
    if (this.layerCacheMiss)
      this.loading.cache.insert(this.archiveName, layer.name, bytes.subarray(0, this.result.value >>> 0));
    const source = aokanaPackedBitmapDescriptor(bytes);
    if (this.composed === null) {
      this.header = source.header;
      this.composed = allocateAokanaBitmap(source.bitmap.width, source.bitmap.height, source.bitmap.format);
      copyAokanaBitmapRows(this.composed, source.bitmap);
    } else {
      const header = new DataView(source.header.buffer);
      const metadata = header.getUint16(10, true) === 1;
      const x = layer.positioned ? layer.x : metadata ? header.getUint16(12, true) : 0;
      const y = layer.positioned ? layer.y : metadata ? header.getUint16(14, true) : 0;
      this.compositor.draw(this.composed, x, y, source.bitmap, layer.mode, layer.opacity);
    }
    if (source.temporary) source.bitmap.storage!.release();
    this.layers.shift();
    if (this.layers.length !== 0) return 1;
    bytes.set(this.header!);
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (header.getUint16(4, true) === 24) {
      header.setUint16(4, 32, true);
      header.setUint16(8, 7, true);
    }
    const stride = Math.imul(this.composed.width, this.composed.bytesPerPixel);
    const destination: AokanaBitmap = {...this.composed, offset: 16, stride,
      storage: new AokanaBitmapStorage(bytes, true)};
    copyAokanaBitmapRows(destination, this.composed);
    this.result.value = (Math.imul(this.composed.height, stride) + 16) >>> 0;
    return 0;
  }

  protected fatal(template: string, name = this.name): Promise<never> {
    const message = aokanaBitmapMessage(this.loading.resources.files.text, template, [this.archive, name]);
    if (message.length > 256) throw new RangeError('Aokana bitmap diagnostic exceeds native scratch');
    return this.loading.resources.errors.threadFatal(this.context.thread, this.context.diagnostics, message);
  }

  override dispose(): void {
    this.layers.length = 0;
    this.composed?.storage?.release();
    this.composed = null;
    super.dispose();
  }
}

/** CProcLoadBitmap 07B4B0 / 07B2E0 installs through the shared native surface table. */
export class AokanaLoadBitmapProcess extends AokanaBitmapSynthesisProcess {
  private constructor(
    context: AokanaBpOpcodeContext, procedures: AokanaProcedureState, clock: AokanaNativeClock,
    loading: AokanaResourceLoadingState, readonly surfaces: AokanaSurfaces,
    readonly index: number, archive: Uint8Array | null, name: Uint8Array,
  ) { super(context, procedures, clock, loading, surfaces.compositor, archive, name); }

  static async create(
    context: AokanaBpOpcodeContext, procedures: AokanaProcedureState, clock: AokanaNativeClock,
    loading: AokanaResourceLoadingState, surfaces: AokanaSurfaces,
    index: number, archive: Uint8Array | null, name: Uint8Array,
  ): Promise<AokanaLoadBitmapProcess> {
    const process = new AokanaLoadBitmapProcess(context, procedures, clock, loading, surfaces, index, archive, name);
    await process.initializeLayers(name);
    return process;
  }

  protected async complete(): Promise<number> {
    if (this.output.bytes === null) throw new Error('Aokana bitmap loader has no successful resource bytes');
    const status = importAokanaWindowsBitmap(this.surfaces, this.index, this.output.bytes);
    if (status === 0x80000001) {
      const packed = importAokanaPackedBitmap(this.surfaces, this.index, this.output.bytes);
      if (packed === 1) return this.fatal('指定されたファイル [ %s : %s ] はBGではない、もしくはサポート外の形式のデータです');
      if (packed === 2) return this.loading.resources.errors.threadFatal(this.context.thread, this.context.diagnostics,
        this.loading.resources.files.text.encodeWide('何らかの要因によりメモリが確保できません', 0));
    } else {
      const templates: Record<number, string> = {
        0x80000002: '指定されたBMPファイル [ %s : %s ] はWindows用のデータではありません',
        0x80000003: '指定されたBMPファイル [ %s : %s ] はサポート外のプレーン数のデータです',
        0x80000004: '指定されたBMPファイル [ %s : %s ] はサポート外のビットカウントのデータです',
        0x80000005: '指定されたBMPファイル [ %s : %s ] は圧縮されているので扱えません',
        0x80000006: '指定されたBMPファイル [ %s : %s ] は無効なサイズのデータです',
      };
      if (templates[status] !== undefined) return this.fatal(templates[status]);
    }
    return 1;
  }
}

/** DCProcPreloadBmp 09D1E0 / 09D120 records the loaded header/payload in 27C780. */
export class AokanaPreloadBitmapProcess extends AokanaBitmapSynthesisProcess {
  static async create(
    context: AokanaBpOpcodeContext, procedures: AokanaProcedureState, clock: AokanaNativeClock,
    loading: AokanaResourceLoadingState, compositor: AokanaBitmapCompositor,
    archive: Uint8Array | null, name: Uint8Array,
  ): Promise<AokanaPreloadBitmapProcess> {
    const process = new AokanaPreloadBitmapProcess(context, procedures, clock, loading, compositor, archive, name);
    await process.initializeLayers(name);
    return process;
  }

  protected async complete(): Promise<number> {
    if (this.output.bytes === null) throw new Error('Aokana bitmap preloader has no successful resource bytes');
    if (aokanaPackedBitmapFormat(this.output.bytes) === -1)
      return this.fatal('指定されたファイル [ %s : %s ] はBGではない、もしくはサポート外の形式のデータです');
    this.loading.preloaded.insert(this.archiveName, this.name, this.output.bytes.subarray(0, this.result.value >>> 0));
    return 1;
  }
}
