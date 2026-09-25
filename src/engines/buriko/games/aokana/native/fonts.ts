import {AokanaBrowserFonts, type AokanaFontProvider} from './font-browser.js';
import {
  AokanaFontRaster,
  AokanaFontRasterSettings,
  aokanaFontGeometry,
  validateAokanaFont,
  validateAokanaFontTransform,
  type AokanaFontTransform,
} from './font-raster.js';
import {AokanaNativeText} from './text.js';

export interface AokanaFontRecord {
  readonly id: number;
  readonly name: Uint8Array;
  readonly size: number;
  readonly widthPercent: number;
  readonly bold: number;
  readonly italic: number;
  raster: AokanaFontRaster | null;
  initializationResult: number;
  field44: number;
  field48: number;
  averageWidthThreshold: number;
}
interface FontMapping {
  readonly name: Uint8Array;
  alias: Uint8Array | null;
  fallback: Uint8Array | null;
  charset: number;
}
interface FontTransformEntry {
  name: Uint8Array;
  value: AokanaFontTransform;
}
interface FontCacheEntry {
  readonly name: Uint8Array;
  readonly size: number;
  readonly widthPercent: number;
  readonly bold: number;
  capacity: number;
}

function rawName(bytes: Uint8Array): Uint8Array {
  const end = bytes.indexOf(0);
  return bytes.slice(0, end < 0 ? bytes.length : end);
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function copiedRecordName(
  name: Uint8Array,
  allocationSize: number,
  fields: readonly number[],
): Uint8Array {
  if (name.length + 1 > allocationSize)
    throw new RangeError('Aokana font name writes outside native record allocation');
  const storage = new Uint8Array(allocationSize);
  storage.set(name);
  const view = new DataView(storage.buffer);
  fields.forEach((value, index) => view.setInt32(96 + index * 4, value, true));
  const end = storage.indexOf(0);
  if (end < 0 || end >= 96 + fields.length * 4)
    throw new Error('Aokana font name reads undefined native record fields');
  return storage.slice(0, end);
}

/** CFontManager and the executable's raw-name/alias registries share this title-local owner. */
export class AokanaNativeFonts {
  readonly rasterSettings = new AokanaFontRasterSettings();
  readonly records: AokanaFontRecord[] = [];
  readonly registeredNames: {readonly bytes: Uint8Array; readonly wide: string}[] = [];
  private readonly mappings: FontMapping[] = [];
  private readonly transforms: FontTransformEntry[] = [];
  private readonly cacheOverrides: FontCacheEntry[] = [];
  private defaultCacheCapacity = 256;
  private defaultFallback: Uint8Array | null = null;
  constructor(
    readonly text: AokanaNativeText,
    readonly browser: AokanaFontProvider = new AokanaBrowserFonts(),
  ) {}

  private decode(bytes: Uint8Array): string {
    const terminated = new Uint8Array(bytes.length + 1);
    terminated.set(bytes);
    return this.text.decodeAuto({bytes: terminated, offset: 0});
  }
  private mapping(name: Uint8Array): FontMapping | undefined {
    return this.mappings.find((mapping) => equal(mapping.name, name));
  }
  private updateMapping(name: Uint8Array): FontMapping {
    const current = this.mapping(name);
    if (current) return current;
    const added: FontMapping = {name: name.slice(), alias: null, fallback: null, charset: -1};
    this.mappings.unshift(added);
    return added;
  }
  setAlias(name: Uint8Array, alias: Uint8Array | null): void {
    this.updateMapping(rawName(name)).alias = alias === null ? null : rawName(alias);
  }
  setFallback(name: Uint8Array | null, fallback: Uint8Array | null): void {
    if (name === null) this.defaultFallback = fallback === null ? null : rawName(fallback);
    else this.updateMapping(rawName(name)).fallback = fallback === null ? null : rawName(fallback);
  }
  setCharset(name: Uint8Array, charset: number): void {
    this.updateMapping(rawName(name)).charset = charset | 0;
  }
  /** 06b3b0 checks the explicit raw-name mapping before enumerating host families. */
  async charset(input: Uint8Array): Promise<number> {
    const name = rawName(input),
      mapped = this.mapping(name)?.charset;
    return mapped !== undefined && mapped !== -1
      ? mapped
      : this.browser.queryCharset(this.decode(name));
  }
  private fallback(name: Uint8Array): Uint8Array {
    const selected = this.mapping(name)?.fallback;
    if (selected) return selected;
    if (this.defaultFallback === null) this.defaultFallback = new TextEncoder().encode('Segoe UI');
    return this.defaultFallback;
  }
  registerName(input: Uint8Array, charsetSelector: number): number {
    const bytes = rawName(input);
    const charset = [128, 0, 134, 136][charsetSelector];
    if (charset !== undefined) this.setCharset(bytes, charset);
    const wide = this.decode(bytes);
    const found = this.registeredNames.findIndex((record) => record.wide === wide);
    if (found >= 0) return found;
    this.registeredNames.push({bytes, wide});
    return this.registeredNames.length - 1;
  }
  name(index: number): Uint8Array | null {
    return this.registeredNames[index >>> 0]?.bytes ?? null;
  }
  cacheCapacity(name: Uint8Array, size: number, widthPercent: number, bold: number): number {
    return (
      this.cacheOverrides.find(
        (entry) =>
          equal(entry.name, name) &&
          entry.size === size &&
          entry.widthPercent === widthPercent &&
          (entry.bold !== 0) === (bold !== 0),
      )?.capacity ?? this.defaultCacheCapacity
    );
  }
  setCacheCapacity(
    input: Uint8Array | null,
    size: number,
    widthPercent: number,
    bold: number,
    capacity: number,
  ): number {
    if (input === null) {
      this.defaultCacheCapacity = capacity | 0;
      return 0;
    }
    if ((size - 4) >>> 0 > 0xc4) return 0x80000002;
    if ((widthPercent - 25) >>> 0 > 0xaf) return 0x80000003;
    if ((capacity | 0) < 2) return 0x80000001;
    const name = rawName(input);
    const found = this.cacheOverrides.find(
      (entry) =>
        equal(entry.name, name) &&
        entry.size === size &&
        entry.widthPercent === widthPercent &&
        (entry.bold !== 0) === (bold !== 0),
    );
    if (found) found.capacity = capacity | 0;
    else
      this.cacheOverrides.unshift({
        name: copiedRecordName(name, 0x88, [size, widthPercent, bold]),
        size,
        widthPercent,
        bold,
        capacity: capacity | 0,
      });
    return 0;
  }
  private async initialize(
    record: AokanaFontRecord,
    input: Uint8Array,
    initialAttempt: boolean,
    fallbackPath: readonly Uint8Array[] = [],
  ): Promise<number> {
    const capacity = this.cacheCapacity(record.name, record.size, record.widthPercent, record.bold);
    if (capacity < 2) return 0x80000001;
    const valid = validateAokanaFont(input.length, record.size, record.widthPercent, false);
    if (valid !== 0) return valid;
    const transform = initialAttempt
      ? (this.transforms.find((entry) => equal(entry.name, record.name))?.value ?? null)
      : null;
    const geometry = aokanaFontGeometry(
      record.size,
      record.widthPercent,
      transform,
      this.rasterSettings,
    );
    const faceName = this.decode(input);
    const mapping = this.mapping(input);
    const pitch =
      this.rasterSettings.preserveVariablePitch !== 0
        ? await this.browser.queryPitch(faceName)
        : null;
    const charset =
      mapping && mapping.charset !== -1
        ? mapping.charset
        : await this.browser.queryCharset(faceName);
    let face;
    try {
      face = await this.browser.create({
        face: faceName,
        height: geometry.fontHeight,
        width: pitch === 2 ? 0 : geometry.fontWidth,
        weight: record.bold === 0 ? 100 : 700,
        italic: record.italic !== 0,
        charset,
        pitchAndFamily: pitch ?? 0,
      });
    } catch {
      return 0x80000004;
    }
    // 06ab30 only retries an explicit alias mismatch; an unmapped host fallback is accepted.
    if (
      faceName !== face.faceName &&
      faceName !== face.familyName &&
      mapping?.alias !== null &&
      mapping?.alias !== undefined &&
      this.decode(mapping.alias) !== face.faceName
    ) {
      const fallback = this.fallback(input);
      if (fallbackPath.some((name) => equal(name, fallback)) || equal(input, fallback))
        throw new Error('Aokana native font alias fallback recurses indefinitely');
      return this.initialize(record, fallback, false, [...fallbackPath, input]);
    }
    record.raster = new AokanaFontRaster(geometry, face, this.rasterSettings, capacity);
    record.averageWidthThreshold =
      Math.trunc(Math.imul(face.averageWidth, 7) / 10) >> this.rasterSettings.sampleShift;
    return 0;
  }
  async get(
    input: Uint8Array | null,
    size: number,
    widthPercent: number,
    bold: number,
    italic = 0,
  ): Promise<{result: number; id: number}> {
    if (input === null) {
      if (
        this.records.length !== 0 ||
        this.cacheOverrides.length !== 0 ||
        this.transforms.length !== 0
      )
        throw new Error('Aokana font lookup compares a null native name');
      return {result: this.defaultCacheCapacity < 2 ? 0x80000001 : 0x80000004, id: 0};
    }
    const name = rawName(input);
    size |= 0;
    widthPercent |= 0;
    bold |= 0;
    italic |= 0;
    const existing = this.records.find(
      (record) =>
        equal(record.name, name) &&
        record.size === size &&
        record.widthPercent === widthPercent &&
        record.bold === bold &&
        record.italic === italic,
    );
    if (existing) return {result: 0, id: existing.id};
    const record: AokanaFontRecord = {
      id: ((this.records.at(-1)?.id ?? 0) + 1) | 0,
      name,
      size,
      widthPercent,
      bold,
      italic,
      raster: null,
      initializationResult: 0,
      field44: 0,
      field48: 0,
      averageWidthThreshold: Math.trunc(Math.imul(size, 7) / 10),
    };
    const result = await this.initialize(record, name, true);
    record.initializationResult = result;
    if (result !== 0) return {result, id: 0};
    this.records.push(record);
    return {result: 0, id: record.id};
  }

  /** Formatting in 074F30 owns a temporary font/cache rather than publishing a manager record. */
  async createTransient(
    input: Uint8Array,
    size: number,
    widthPercent: number,
    bold: number,
    italic: number,
  ): Promise<{result: number; record: AokanaFontRecord | null}> {
    const name = rawName(input);
    const record: AokanaFontRecord = {
      id: 0,
      name,
      size: size | 0,
      widthPercent: widthPercent | 0,
      bold: bold | 0,
      italic: italic | 0,
      raster: null,
      initializationResult: 0,
      field44: 0,
      field48: 0,
      averageWidthThreshold: Math.trunc(Math.imul(size, 7) / 10),
    };
    const result = await this.initialize(record, name, true);
    record.initializationResult = result;
    if (result !== 0) {
      record.raster?.clear();
      record.raster = null;
      return {result, record: null};
    }
    return {result: 0, record};
  }

  releaseTransient(record: AokanaFontRecord): void {
    if (record.id !== 0)
      throw new Error('Aokana font manager releases a published record as transient');
    record.raster?.clear();
    record.raster = null;
  }

  find(id: number): AokanaFontRecord | null {
    return this.records.find((record) => record.id === (id | 0)) ?? null;
  }
  /** Native replacement constructs a fresh CFontDx, including its spacing fields. */
  private async replaceRaster(record: AokanaFontRecord): Promise<void> {
    record.raster?.clear();
    record.raster = null;
    record.field44 = 0;
    record.field48 = 0;
    record.initializationResult = await this.initialize(record, record.name, true);
  }
  async rebuild(): Promise<void> {
    for (const record of this.records) await this.replaceRaster(record);
  }
  async setTransform(
    input: Uint8Array | (() => Uint8Array),
    transform: AokanaFontTransform,
  ): Promise<number> {
    const result = validateAokanaFontTransform(transform);
    if (result !== 0) return result;
    const name = rawName(typeof input === 'function' ? input() : input);
    const existing = this.transforms.find((entry) => equal(entry.name, name));
    if (!existing) {
      this.transforms.unshift({
        name: copiedRecordName(name, 0x80, transform),
        value: [...transform],
      });
      return 0;
    }
    if (existing.value.every((value, index) => value === transform[index])) return 0;
    const geometryChanged = existing.value
      .slice(0, 4)
      .some((value, index) => value !== transform[index]);
    existing.value = [...transform];
    existing.name = copiedRecordName(existing.name, 0x80, transform);
    if (geometryChanged)
      for (const record of this.records)
        if (equal(record.name, name)) await this.replaceRaster(record);
    if (!geometryChanged)
      for (const record of this.records)
        if (equal(record.name, name)) record.raster?.setExtra(transform[4]);
    return 0;
  }
  setExtra(input: Uint8Array, value: number): number {
    const result = validateAokanaFontTransform([0, 0, 0, 0, value]);
    if (result !== 0) return result;
    const entry = this.transforms.find((entry) => equal(entry.name, rawName(input)));
    if (!entry) return 0x80000008;
    entry.value = [entry.value[0], entry.value[1], entry.value[2], entry.value[3], value | 0];
    for (const record of this.records)
      if (equal(record.name, entry.name)) record.raster?.setExtra(value);
    return 0;
  }
  async setRasterFields(
    name: Uint8Array,
    size: number,
    widthPercent: number,
    bold: number,
    field44: number,
    field48: number,
  ): Promise<number> {
    const result = await this.get(name, size, widthPercent, bold);
    if (result.result === 0) {
      const record = this.find(result.id)!;
      record.field44 = field44 | 0;
      record.field48 = field48 | 0;
    }
    return result.result;
  }
  /** 14003f8d0 replaces CFontManager while the separate global name registry survives. */
  resetManager(): void {
    for (const record of this.records) record.raster?.clear();
    this.records.length = 0;
    this.transforms.length = 0;
    this.cacheOverrides.length = 0;
    this.defaultCacheCapacity = 256;
  }
  /** 1400be3e0 followed by 14006b660. */
  clearNamesAndMappings(): void {
    this.registeredNames.length = 0;
    this.mappings.length = 0;
    this.defaultFallback = null;
  }
  dispose(): void {
    this.resetManager();
    this.clearNamesAndMappings();
    this.browser.dispose();
  }
}
