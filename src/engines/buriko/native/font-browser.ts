import {readBurikoFontData, type BurikoFontData} from './font-data.js';
import type {SfntFontMetadata} from '../../../formats/sfnt.js';
import {
  queryBrowserLocalFonts,
  readBrowserLocalFontMetadata,
  readBrowserLocalFontRecords,
  type BrowserLocalFontMetadata,
  type BrowserLocalFontRecord,
} from '../../../text/browser-local-fonts.js';
import {getRuntimeProfile} from '../../../platform/runtime-profile.js';
import {burikoCrtWideLower} from './crt-case.js';
import {beginRuntimeSpan, recordRuntimeMetric} from '../../../platform/runtime-performance.js';
import {
  BurikoFontTextCanvas,
  burikoFontCanvas,
  configureBurikoFontCanvas,
  type BurikoFontCanvasStyle,
} from './font-canvas.js';
import {rasterBurikoFontTextOffThread, type BurikoFontWorkerSource} from './font-raster-offload.js';

export interface BurikoBrowserFontParameters {
  readonly face: string;
  /** Native CreateFontW cell height (positive) or em height (negative). */
  readonly height: number;
  readonly width: number;
  readonly weight: number;
  readonly italic: boolean;
  readonly charset: number;
  readonly pitchAndFamily: number;
}

export interface BurikoFontOutline {
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly stride: number;
  readonly bytes: Uint8Array;
}

export interface BurikoFontDib {
  readonly bytes: Uint8Array;
  readonly stride: number;
}

/** Font host surface consumed by the native cache and text controls. */
export interface BurikoFontFace {
  readonly faceName: string;
  readonly familyName: string;
  readonly cssFamily: string;
  readonly averageWidth: number;
  readonly ascent: number;
  readonly emSize: number;
  readonly horizontalScale: number;
  /** CSS weight the face rasterizes with. */
  readonly weight?: number;
  abc(character: number): readonly [number, number, number];
  extent(character: number): number;
  rasterText(text: string, width: number, height: number): BurikoFontDib;
  rasterMonochrome(text: string, width: number, height: number): BurikoFontDib;
  outline(character: number, bits: 2 | 4 | 6): BurikoFontOutline;
  /** Optional off-thread preparation of later `rasterText` results with identical bytes. */
  prefetchText?(texts: readonly string[], width: number, height: number): Promise<void> | null;
}

export interface BurikoFontProvider {
  queryPitch(name: string): Promise<1 | 2 | null>;
  queryCharset(name: string): Promise<number>;
  enumerate(charset: number, japanese: boolean): Promise<string[]>;
  loadResource(bytes: Uint8Array, enumerable: boolean): Promise<number | null>;
  unloadResource(token: number): boolean;
  create(parameters: BurikoBrowserFontParameters): Promise<BurikoFontFace>;
  dispose(): void;
}

interface LoadedFace {
  /** AddFontMemResourceEx fonts cannot be discovered by EnumFontFamiliesEx. */
  readonly enumerable: boolean;
  readonly cssFamily: string;
  readonly descriptors: {readonly weight: string; readonly style: string};
  readonly browserFace: FontFace;
  readonly data: BurikoFontData;
  readonly names: readonly string[];
  readonly family: string;
  readonly fullName: string;
}
interface InstalledFace {
  readonly data: SfntFontMetadata;
  readonly names: readonly string[];
  readonly family: string;
  readonly fullName: string;
}
const charsetBits = new Map([
  [0, 0],
  [2, 31],
  [77, 29],
  [128, 17],
  [129, 19],
  [130, 21],
  [134, 18],
  [136, 20],
  [161, 3],
  [162, 4],
  [163, 8],
  [177, 5],
  [178, 6],
  [186, 7],
  [204, 2],
  [222, 16],
  [238, 1],
  [255, 30],
]);
function supportsCharset(data: SfntFontMetadata, charset: number): boolean {
  if (charset === 1) return true;
  const bit = charsetBits.get(charset);
  return (
    bit !== undefined &&
    data.codePageRanges !== null &&
    ((data.codePageRanges[0] >>> bit) & 1) !== 0
  );
}

function fontSet(): FontFaceSet {
  if (typeof document === 'undefined')
    throw new Error('Buriko browser font backend requires a document font set');
  return document.fonts;
}

function selectName(data: SfntFontMetadata, id: number): string | null {
  const records = data.names.filter((name) => name.id === id && name.unicode !== null);
  const english = records.find((name) => name.platform === 3 && name.language === 0x409);
  return (
    english?.unicode ??
    records.find((name) => name.platform === 3)?.unicode ??
    records[0]?.unicode ??
    null
  );
}

/** Concrete replacement for GDI font handles. Browser rasterization is a platform boundary. */
export class BurikoBrowserFontFace implements BurikoFontFace {
  readonly ascent: number;
  readonly descent: number;
  readonly averageWidth: number;
  readonly horizontalScale: number;
  readonly emSize: number;
  private readonly metricsContext: OffscreenCanvasRenderingContext2D;
  private textCanvas: BurikoFontTextCanvas | null = null;
  /** Worker rasters awaiting their first synchronous request, keyed by DIB size and text. */
  private readonly prefetched = new Map<string, BurikoFontDib>();
  constructor(
    readonly parameters: BurikoBrowserFontParameters,
    readonly cssFamily: string,
    readonly faceName: string,
    readonly familyName: string,
    readonly data: SfntFontMetadata | null,
    /** How a raster worker can reproduce `cssFamily`; null keeps rasterization in-thread. */
    readonly workerSource: BurikoFontWorkerSource | null = null,
  ) {
    const probe = burikoFontCanvas(1, 1);
    const height = Math.abs(parameters.height);
    if (height === 0) throw new RangeError('Buriko browser font height is zero');
    const descriptor = `${parameters.italic ? 'italic ' : ''}${parameters.weight} `;
    const family = cssFamily === 'sans-serif' ? cssFamily : JSON.stringify(cssFamily);
    probe.font = `${descriptor}${height}px ${family}`;
    probe.fontKerning = 'none';
    probe.textBaseline = 'alphabetic';
    const preliminary = probe.measureText('Hg');
    const measuredCell = preliminary.fontBoundingBoxAscent + preliminary.fontBoundingBoxDescent;
    if (!Number.isFinite(measuredCell) || measuredCell <= 0)
      throw new Error('Buriko browser does not expose usable font cell metrics');
    const designCell = data ? data.winAscent + data.winDescent : null;
    if (designCell !== null && designCell <= 0)
      throw new RangeError('Buriko supplied font cell metrics are invalid');
    this.emSize =
      parameters.height < 0
        ? height
        : data
          ? (height * data.unitsPerEm) / designCell!
          : (height * height) / measuredCell;
    probe.font = `${descriptor}${this.emSize}px ${family}`;
    const metrics = probe.measureText('Hg');
    this.ascent = data
      ? Math.round((data.winAscent * this.emSize) / data.unitsPerEm)
      : Math.round(metrics.fontBoundingBoxAscent);
    this.descent = data
      ? Math.round((data.winDescent * this.emSize) / data.unitsPerEm)
      : Math.round(metrics.fontBoundingBoxDescent);
    const measuredAverage =
      probe.measureText('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ').width / 52;
    const average =
      data?.averageWidth !== null && data?.averageWidth !== undefined
        ? (data.averageWidth * this.emSize) / data.unitsPerEm
        : measuredAverage;
    if (!Number.isFinite(average) || average <= 0)
      throw new RangeError('Buriko font average advance is invalid');
    this.horizontalScale = parameters.width === 0 ? 1 : parameters.width / average;
    this.averageWidth = Math.round(average * this.horizontalScale);
    this.metricsContext = probe;
  }
  get weight(): number {
    return this.parameters.weight;
  }
  private get canvasStyle(): BurikoFontCanvasStyle {
    return {
      font: this.metricsContext.font,
      horizontalScale: this.horizontalScale,
      ascent: this.ascent,
    };
  }
  abc(character: number): readonly [number, number, number] {
    const metrics = this.metricsContext.measureText(String.fromCharCode(character & 0xffff));
    const a = -metrics.actualBoundingBoxLeft * this.horizontalScale;
    const b =
      (metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight) * this.horizontalScale;
    const c = metrics.width * this.horizontalScale - a - b;
    return [Math.fround(a), Math.fround(b), Math.fround(c)];
  }
  extent(character: number): number {
    return Math.round(
      this.metricsContext.measureText(String.fromCharCode(character & 0xffff)).width *
        this.horizontalScale,
    );
  }
  /** Native NONANTIALIASED_QUALITY DIB path is monochrome before engine supersampling. */
  rasterText(text: string, width: number, height: number): BurikoFontDib {
    const key = `${width}x${height}:${text}`,
      prefetched = this.prefetched.get(key);
    if (prefetched !== undefined) {
      this.prefetched.delete(key);
      recordRuntimeMetric('buriko.text.raster.prefetched', 1);
      return prefetched;
    }
    return (this.textCanvas ??= new BurikoFontTextCanvas(this.canvasStyle)).raster(
      text,
      width,
      height,
    );
  }
  /**
   * Rasterizes `texts` on workers so the following synchronous `rasterText` calls find them.
   * Returns null, without starting work, when this face cannot be reproduced on a worker.
   * Earlier unused results are dropped.
   */
  prefetchText(texts: readonly string[], width: number, height: number): Promise<void> | null {
    this.prefetched.clear();
    if (this.workerSource === null || texts.length === 0) return null;
    const pending = rasterBurikoFontTextOffThread(
      this.cssFamily,
      this.workerSource,
      this.canvasStyle,
      texts,
      width,
      height,
    );
    if (pending === null) return null;
    return pending.then((dibs) => {
      if (dibs === null) return;
      const stride = Math.ceil(width / 4) * 4;
      texts.forEach((text, index) =>
        this.prefetched.set(`${width}x${height}:${text}`, {bytes: dibs[index]!, stride}),
      );
    });
  }
  /** Top-down monochrome DIB boundary used by the separate CDsp mono-font cache. */
  rasterMonochrome(text: string, width: number, height: number): BurikoFontDib {
    const coverage = this.rasterText(text, width, height),
      stride = Math.ceil(width / 32) * 4,
      bytes = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (coverage.bytes[y * coverage.stride + x]! !== 0)
          bytes[y * stride + (x >>> 3)]! |= 0x80 >>> (x & 7);
    return {bytes, stride};
  }
  /** GGO_GRAY2/4/8_BITMAP-shaped result; coverage sampling is supplied by the browser. */
  outline(character: number, bits: 2 | 4 | 6): BurikoFontOutline {
    const text = String.fromCharCode(character & 0xffff);
    const metrics = this.metricsContext.measureText(text);
    const left = Math.floor(-metrics.actualBoundingBoxLeft * this.horizontalScale);
    const right = Math.ceil(metrics.actualBoundingBoxRight * this.horizontalScale);
    const top = Math.ceil(metrics.actualBoundingBoxAscent);
    const bottom = Math.ceil(metrics.actualBoundingBoxDescent);
    const width = Math.max(0, right - left);
    const height = Math.max(0, top + bottom);
    const stride = Math.ceil(width / 4) * 4;
    const bytes = new Uint8Array(stride * height);
    if (width > 0 && height > 0) {
      const target = burikoFontCanvas(width, height);
      configureBurikoFontCanvas(target, this.canvasStyle);
      target.fillText(text, -left / this.horizontalScale, top);
      const rgba = target.getImageData(0, 0, width, height).data;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          bytes[y * stride + x] = Math.round((rgba[(y * width + x) * 4 + 3]! * (1 << bits)) / 255);
    }
    return {width, height, originX: left, originY: top, stride, bytes};
  }
}

/** Windows-bundled families that Japanese and English titles commonly request. */
const commonInstalledFamilies = new Set(
  [
    'MS Gothic',
    'MS PGothic',
    'MS UI Gothic',
    'MS Mincho',
    'MS PMincho',
    'Meiryo',
    'Meiryo UI',
    'Yu Gothic',
    'Yu Gothic UI',
    'Yu Mincho',
    'Segoe UI',
    'Arial',
    'Times New Roman',
    'Courier New',
    'Tahoma',
    'Verdana',
    'Microsoft Sans Serif',
  ].map((family) => family.toLowerCase()),
);

function installedFace({
  data,
  family,
  fullName,
  postscriptName,
}: BrowserLocalFontMetadata): InstalledFace {
  return {
    data,
    family,
    fullName,
    names: [
      family,
      fullName,
      postscriptName,
      ...data.names
        .filter((name) => [1, 4, 6, 16, 21].includes(name.id) && name.unicode !== null)
        .map((name) => name.unicode!),
    ],
  };
}

export class BurikoBrowserFonts implements BurikoFontProvider {
  private readonly resources = new Map<number, readonly LoadedFace[]>();
  private readonly localFaces = new Map<string, FontFace | null>();
  private nextResource = 1;
  private nextFamily = 1;
  /** Complete installed catalog (native profile). */
  private installed: Promise<readonly InstalledFace[]> | null = null;
  private localRecords: Promise<readonly BrowserLocalFontRecord[]> | null = null;
  private readonly recordFaces = new Map<
    BrowserLocalFontRecord,
    Promise<readonly InstalledFace[]>
  >();
  /**
   * GDI answers EnumFontFamiliesEx from its resident font table; a browser can only rebuild it
   * by reading every installed font file, which takes many seconds on hosts with large font
   * collections. Browser optimized therefore reads only common system families and records
   * whose browser-reported names equal the queried name. Other installed fonts are absent
   * from enumeration and from pitch/charset queries, though local() rendering can still
   * select them.
   */
  private installedFonts(name?: string): Promise<readonly InstalledFace[]> {
    if (this.installed) return this.installed;
    if (getRuntimeProfile() === 'browser-optimized') return this.selectedInstalledFonts(name);
    return (this.installed = readBrowserLocalFontMetadata().then((faces) =>
      faces.map(installedFace),
    ));
  }
  private async selectedInstalledFonts(name?: string): Promise<readonly InstalledFace[]> {
    const records = await (this.localRecords ??= queryBrowserLocalFonts());
    const folded = name?.toLowerCase();
    const selected = records.filter(
      (record) =>
        commonInstalledFamilies.has(record.family.toLowerCase()) ||
        (folded !== undefined &&
          [record.family, record.fullName, record.postscriptName].some(
            (candidate) => candidate.toLowerCase() === folded,
          )),
    );
    const unread = selected.filter((record) => !this.recordFaces.has(record));
    if (unread.length !== 0) {
      const pending = readBrowserLocalFontRecords(unread);
      unread.forEach((record, index) =>
        this.recordFaces.set(
          record,
          pending.then((results) => results[index]!.map(installedFace)),
        ),
      );
    }
    return (await Promise.all(selected.map((record) => this.recordFaces.get(record)!))).flat();
  }
  async inspect(name: string, enumerableOnly = false): Promise<InstalledFace | LoadedFace | null> {
    const resource = this.candidates(name).find((face) => !enumerableOnly || face.enumerable);
    if (resource) return resource;
    const folded = name.toLowerCase();
    return (
      (await this.installedFonts(name)).find((face) =>
        face.names.some((candidate) => candidate.toLowerCase() === folded),
      ) ?? null
    );
  }
  private async matchingFamily(
    name: string,
  ): Promise<{face: InstalledFace | LoadedFace; charset: number} | null> {
    // 06b0a0 and 06b320 decode directly into LOGFONTW::lfFaceName[32].
    if (name.length > 31)
      throw new RangeError('Buriko font pitch query overwrites its native LOGFONT stack object');
    const available: (InstalledFace | LoadedFace)[] = [
      ...(await this.installedFonts(name)),
      ...[...this.resources.values()].flat().filter((face) => face.enumerable),
    ];
    const folded = burikoCrtWideLower(name);
    for (const charset of [128, 136, 134, 0])
      for (const face of available) {
        if (!supportsCharset(face.data, charset)) continue;
        const names = [
          face.family,
          ...face.data.names
            .filter((record) => [1, 16, 21].includes(record.id) && record.unicode !== null)
            .map((record) => record.unicode!),
        ];
        // 0696d0's callback uses the fixed CRT C locale, even though the host's
        // family filtering can use a broader case comparison.
        if (names.some((candidate) => burikoCrtWideLower(candidate) === folded))
          return {face, charset};
      }
    return null;
  }
  async queryPitch(name: string): Promise<1 | 2 | null> {
    const matched = await this.matchingFamily(name);
    return matched === null ? null : matched.face.data.fixedPitch ? 1 : 2;
  }
  async queryCharset(name: string): Promise<number> {
    return (await this.matchingFamily(name))?.charset ?? 1;
  }
  async enumerate(charset: number, japanese: boolean): Promise<string[]> {
    charset &= 255;
    const available: (InstalledFace | LoadedFace)[] = [
      ...(await this.installedFonts()),
      ...[...this.resources.values()].flat().filter((face) => face.enumerable),
    ];
    const result: string[] = [];
    const names = new Set<string>();
    for (const face of available) {
      if (!supportsCharset(face.data, charset)) continue;
      const localized = japanese
        ? face.data.names.find(
            (name) => name.id === 1 && name.platform === 3 && name.language === 0x411,
          )?.unicode
        : null;
      const name = localized ?? face.family;
      // DEFAULT_CHARSET suppresses repeated family names; explicit charsets retain styles.
      if (charset === 1 && names.has(name.toLowerCase())) continue;
      names.add(name.toLowerCase());
      result.push(name);
    }
    return result;
  }
  async loadResource(bytes: Uint8Array, enumerable: boolean): Promise<number | null> {
    let data: readonly BurikoFontData[];
    try {
      data = readBurikoFontData(bytes);
    } catch {
      return null;
    }
    const loaded: LoadedFace[] = [];
    try {
      for (const face of data) {
        const family = selectName(face, 1) ?? selectName(face, 16);
        const fullName = selectName(face, 4) ?? family;
        if (family === null || fullName === null)
          throw new RangeError('Buriko resource font has no usable family name');
        const cssFamily = `BurikoResourceFont${this.nextFamily++}`;
        const descriptors = {weight: String(face.weight), style: face.italic ? 'italic' : 'normal'};
        const browserFace = new FontFace(cssFamily, face.bytes.slice().buffer, descriptors);
        await browserFace.load();
        fontSet().add(browserFace);
        loaded.push({
          data: face,
          cssFamily,
          descriptors,
          browserFace,
          family,
          fullName,
          enumerable,
          names: face.names
            .filter((name) => [1, 4, 6, 16, 21].includes(name.id) && name.unicode !== null)
            .map((name) => name.unicode!),
        });
      }
    } catch {
      for (const face of loaded) fontSet().delete(face.browserFace);
      return null;
    }
    const token = this.nextResource++;
    this.resources.set(token, loaded);
    return token;
  }
  unloadResource(token: number): boolean {
    const faces = this.resources.get(token);
    if (!faces) return false;
    for (const face of faces) fontSet().delete(face.browserFace);
    this.resources.delete(token);
    return true;
  }
  private candidates(name: string): LoadedFace[] {
    const folded = name.toLowerCase();
    return [...this.resources.values()]
      .flat()
      .filter((face) => face.names.some((candidate) => candidate.toLowerCase() === folded));
  }
  async create(parameters: BurikoBrowserFontParameters): Promise<BurikoBrowserFontFace> {
    const finishCreate = beginRuntimeSpan('buriko.font.create');
    let source = 0;
    try {
      const candidates = this.candidates(parameters.face);
      candidates.sort(
        (a, b) =>
          Number(a.data.italic !== parameters.italic) * 1000 +
          Math.abs(a.data.weight - parameters.weight) -
          (Number(b.data.italic !== parameters.italic) * 1000 +
            Math.abs(b.data.weight - parameters.weight)),
      );
      const selected = candidates[0];
      if (selected) {
        source = 1;
        return new BurikoBrowserFontFace(
          parameters,
          selected.cssFamily,
          selected.fullName,
          selected.family,
          selected.data,
          {kind: 'bytes', bytes: selected.data.bytes, descriptors: selected.descriptors},
        );
      }
      const key = parameters.face.toLowerCase();
      if (!this.localFaces.has(key)) {
        const cssFamily = `BurikoLocalFont${this.nextFamily++}`;
        const face = new FontFace(cssFamily, `local(${JSON.stringify(parameters.face)})`);
        try {
          const finishLocalLoad = beginRuntimeSpan('buriko.font.local-face-load');
          try {
            await face.load();
          } finally {
            finishLocalLoad?.();
          }
          fontSet().add(face);
          this.localFaces.set(key, face);
        } catch {
          this.localFaces.set(key, null);
        }
      }
      const local = this.localFaces.get(key);
      if (local) {
        source = 2;
        const metadata = await this.inspect(parameters.face);
        return new BurikoBrowserFontFace(
          parameters,
          local.family,
          metadata?.fullName ?? parameters.face,
          metadata?.family ?? parameters.face,
          metadata?.data ?? null,
        );
      }
      // GDI can select a fallback face. The platform equivalent is the browser's sans-serif family.
      source = 3;
      return new BurikoBrowserFontFace(parameters, 'sans-serif', 'sans-serif', 'sans-serif', null, {
        kind: 'generic',
      });
    } finally {
      finishCreate?.({source});
    }
  }
  dispose(): void {
    for (const token of this.resources.keys()) this.unloadResource(token);
    for (const face of this.localFaces.values()) if (face) fontSet().delete(face);
    this.localFaces.clear();
    this.installed = this.localRecords = null;
    this.recordFaces.clear();
  }
}
