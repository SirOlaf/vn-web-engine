import {readAokanaFontData, type AokanaFontData} from './font-data.js';
import {aokanaCrtWideLower} from './crt-case.js';

export interface AokanaBrowserFontParameters {
  readonly face: string;
  /** Native CreateFontW cell height (positive) or em height (negative). */
  readonly height: number;
  readonly width: number;
  readonly weight: number;
  readonly italic: boolean;
  readonly charset: number;
  readonly pitchAndFamily: number;
}

export interface AokanaFontOutline {
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly stride: number;
  readonly bytes: Uint8Array;
}

export interface AokanaFontDib {
  readonly bytes: Uint8Array;
  readonly stride: number;
}

interface LoadedFace {
  /** AddFontMemResourceEx fonts cannot be discovered by EnumFontFamiliesEx. */
  readonly enumerable: boolean;
  readonly cssFamily: string;
  readonly browserFace: FontFace;
  readonly data: AokanaFontData;
  readonly names: readonly string[];
  readonly family: string;
  readonly fullName: string;
}
interface InstalledFace {
  readonly data: AokanaFontData;
  readonly names: readonly string[];
  readonly family: string;
  readonly fullName: string;
}
interface LocalFontData {
  readonly family: string;
  readonly fullName: string;
  readonly postscriptName: string;
  blob(): Promise<Blob>;
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
function supportsCharset(data: AokanaFontData, charset: number): boolean {
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
    throw new Error('Aokana browser font backend requires a document font set');
  return document.fonts;
}

function context(width: number, height: number): OffscreenCanvasRenderingContext2D {
  if (width < 1 || height < 1 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height))
    throw new RangeError('Aokana font raster dimensions are invalid');
  const canvas = new OffscreenCanvas(width, height);
  const result = canvas.getContext('2d', {willReadFrequently: true});
  if (!result) throw new Error('Aokana browser font raster context is unavailable');
  return result;
}

function selectName(data: AokanaFontData, id: number): string | null {
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
export class AokanaBrowserFontFace {
  readonly ascent: number;
  readonly descent: number;
  readonly averageWidth: number;
  readonly horizontalScale: number;
  readonly emSize: number;
  private readonly metricsContext: OffscreenCanvasRenderingContext2D;
  constructor(
    readonly parameters: AokanaBrowserFontParameters,
    readonly cssFamily: string,
    readonly faceName: string,
    readonly familyName: string,
    readonly data: AokanaFontData | null,
  ) {
    const probe = context(1, 1);
    const height = Math.abs(parameters.height);
    if (height === 0) throw new RangeError('Aokana browser font height is zero');
    const descriptor = `${parameters.italic ? 'italic ' : ''}${parameters.weight} `;
    const family = cssFamily === 'sans-serif' ? cssFamily : JSON.stringify(cssFamily);
    probe.font = `${descriptor}${height}px ${family}`;
    probe.fontKerning = 'none';
    probe.textBaseline = 'alphabetic';
    const preliminary = probe.measureText('Hg');
    const measuredCell = preliminary.fontBoundingBoxAscent + preliminary.fontBoundingBoxDescent;
    if (!Number.isFinite(measuredCell) || measuredCell <= 0)
      throw new Error('Aokana browser does not expose usable font cell metrics');
    const designCell = data ? data.winAscent + data.winDescent : null;
    if (designCell !== null && designCell <= 0)
      throw new RangeError('Aokana supplied font cell metrics are invalid');
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
      throw new RangeError('Aokana font average advance is invalid');
    this.horizontalScale = parameters.width === 0 ? 1 : parameters.width / average;
    this.averageWidth = Math.round(average * this.horizontalScale);
    this.metricsContext = probe;
  }
  private configure(target: OffscreenCanvasRenderingContext2D): void {
    target.font = this.metricsContext.font;
    target.fontKerning = 'none';
    target.textBaseline = 'alphabetic';
    target.fillStyle = '#000';
    target.scale(this.horizontalScale, 1);
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
  rasterText(text: string, width: number, height: number): AokanaFontDib {
    const target = context(width, height);
    this.configure(target);
    target.fillText(text, 0, this.ascent);
    const rgba = target.getImageData(0, 0, width, height).data;
    const stride = Math.ceil(width / 4) * 4;
    const bytes = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        bytes[y * stride + x] = rgba[(y * width + x) * 4 + 3]! >= 128 ? 255 : 0;
    return {bytes, stride};
  }
  /** GGO_GRAY2/4/8_BITMAP-shaped result; coverage sampling is supplied by the browser. */
  outline(character: number, bits: 2 | 4 | 6): AokanaFontOutline {
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
      const target = context(width, height);
      this.configure(target);
      target.fillText(text, -left / this.horizontalScale, top);
      const rgba = target.getImageData(0, 0, width, height).data;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          bytes[y * stride + x] = Math.round((rgba[(y * width + x) * 4 + 3]! * (1 << bits)) / 255);
    }
    return {width, height, originX: left, originY: top, stride, bytes};
  }
}

export class AokanaBrowserFonts {
  private readonly resources = new Map<number, readonly LoadedFace[]>();
  private readonly localFaces = new Map<string, FontFace | null>();
  private nextResource = 1;
  private nextFamily = 1;
  private installed: Promise<readonly InstalledFace[]> | null = null;
  private installedFonts(): Promise<readonly InstalledFace[]> {
    return (this.installed ??= (async () => {
      const host = globalThis as typeof globalThis & {
        queryLocalFonts?: () => Promise<readonly LocalFontData[]>;
      };
      if (!host.queryLocalFonts) return [];
      let records: readonly LocalFontData[];
      try {
        records = await host.queryLocalFonts();
      } catch {
        return [];
      }
      const faces: InstalledFace[] = [];
      for (const record of records) {
        try {
          const blob = await record.blob();
          for (const data of readAokanaFontData(new Uint8Array(await blob.arrayBuffer())))
            faces.push({
              data,
              family: record.family,
              fullName: record.fullName,
              names: [
                record.family,
                record.fullName,
                record.postscriptName,
                ...data.names
                  .filter((name) => [1, 4, 6, 16, 21].includes(name.id) && name.unicode !== null)
                  .map((name) => name.unicode!),
              ],
            });
        } catch {
          /* The browser cannot expose usable metadata for this installed face. */
        }
      }
      return faces;
    })());
  }
  async inspect(name: string, enumerableOnly = false): Promise<InstalledFace | LoadedFace | null> {
    const resource = this.candidates(name).find((face) => !enumerableOnly || face.enumerable);
    if (resource) return resource;
    const folded = name.toLowerCase();
    return (
      (await this.installedFonts()).find((face) =>
        face.names.some((candidate) => candidate.toLowerCase() === folded),
      ) ?? null
    );
  }
  private async matchingFamily(
    name: string,
  ): Promise<{face: InstalledFace | LoadedFace; charset: number} | null> {
    // 06b0a0 and 06b320 decode directly into LOGFONTW::lfFaceName[32].
    if (name.length > 31)
      throw new RangeError('Aokana font pitch query overwrites its native LOGFONT stack object');
    const available: (InstalledFace | LoadedFace)[] = [
      ...(await this.installedFonts()),
      ...[...this.resources.values()].flat().filter((face) => face.enumerable),
    ];
    const folded = aokanaCrtWideLower(name);
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
        if (names.some((candidate) => aokanaCrtWideLower(candidate) === folded))
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
    let data: readonly AokanaFontData[];
    try {
      data = readAokanaFontData(bytes);
    } catch {
      return null;
    }
    const loaded: LoadedFace[] = [];
    try {
      for (const face of data) {
        const family = selectName(face, 1) ?? selectName(face, 16);
        const fullName = selectName(face, 4) ?? family;
        if (family === null || fullName === null)
          throw new RangeError('Aokana resource font has no usable family name');
        const cssFamily = `AokanaResourceFont${this.nextFamily++}`;
        const browserFace = new FontFace(cssFamily, face.bytes.slice().buffer, {
          weight: String(face.weight),
          style: face.italic ? 'italic' : 'normal',
        });
        await browserFace.load();
        fontSet().add(browserFace);
        loaded.push({
          data: face,
          cssFamily,
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
  async create(parameters: AokanaBrowserFontParameters): Promise<AokanaBrowserFontFace> {
    const candidates = this.candidates(parameters.face);
    candidates.sort(
      (a, b) =>
        Number(a.data.italic !== parameters.italic) * 1000 +
        Math.abs(a.data.weight - parameters.weight) -
        (Number(b.data.italic !== parameters.italic) * 1000 +
          Math.abs(b.data.weight - parameters.weight)),
    );
    const selected = candidates[0];
    if (selected)
      return new AokanaBrowserFontFace(
        parameters,
        selected.cssFamily,
        selected.fullName,
        selected.family,
        selected.data,
      );
    const key = parameters.face.toLowerCase();
    if (!this.localFaces.has(key)) {
      const cssFamily = `AokanaLocalFont${this.nextFamily++}`;
      const face = new FontFace(cssFamily, `local(${JSON.stringify(parameters.face)})`);
      try {
        await face.load();
        fontSet().add(face);
        this.localFaces.set(key, face);
      } catch {
        this.localFaces.set(key, null);
      }
    }
    const local = this.localFaces.get(key);
    if (local) {
      const metadata = await this.inspect(parameters.face);
      return new AokanaBrowserFontFace(
        parameters,
        local.family,
        metadata?.fullName ?? parameters.face,
        metadata?.family ?? parameters.face,
        metadata?.data ?? null,
      );
    }
    // GDI can select a fallback face. The platform equivalent is the browser's sans-serif family.
    return new AokanaBrowserFontFace(parameters, 'sans-serif', 'sans-serif', 'sans-serif', null);
  }
  dispose(): void {
    for (const token of this.resources.keys()) this.unloadResource(token);
    for (const face of this.localFaces.values()) if (face) fontSet().delete(face);
    this.localFaces.clear();
  }
}
