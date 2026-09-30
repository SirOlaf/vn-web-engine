/**
 * Headless font provider for tools/probe-buriko.mjs. Font catalog queries use the production
 * provider (game-directory fonts; Node has no installed-font access). Faces are metric-only:
 * no glyph is rasterized, and every distinct face request is reported with the source the
 * browser player would select.
 */
import {BurikoBrowserFonts} from '../dist/engines/buriko/native/font-browser.js';
import {readBurikoFontData} from '../dist/engines/buriko/native/font-data.js';
import {readGameDirectoryFonts} from '../dist/text/game-directory-fonts.js';

function selectName(data, id) {
  const records = data.names.filter((name) => name.id === id && name.unicode !== null);
  return (
    records.find((name) => name.platform === 3 && name.language === 0x409)?.unicode ??
    records.find((name) => name.platform === 3)?.unicode ??
    records[0]?.unicode ??
    null
  );
}

class MetricFace {
  constructor(parameters, faceName, familyName, data) {
    const height = Math.abs(parameters.height);
    if (height === 0) throw new RangeError('Buriko probe font height is zero');
    const cell = data ? data.winAscent + data.winDescent : height;
    this.emSize =
      parameters.height < 0 ? height : data ? (height * data.unitsPerEm) / cell : height;
    const unit = data ? this.emSize / data.unitsPerEm : 1;
    this.ascent = Math.round(data ? data.winAscent * unit : height * 0.86);
    const average = data?.averageWidth ? data.averageWidth * unit : this.emSize / 2;
    this.horizontalScale = parameters.width === 0 ? 1 : parameters.width / average;
    this.averageWidth = Math.round(average * this.horizontalScale);
    this.weight = parameters.weight;
    this.faceName = faceName;
    this.familyName = familyName;
    this.cssFamily = 'probe';
  }
  advance(character) {
    // Full-width for CJK and full-width forms, half-width otherwise.
    const wide = character >= 0x2e80 && !(character >= 0xff61 && character <= 0xff9f);
    return (wide ? this.emSize : this.emSize / 2) * this.horizontalScale;
  }
  abc(character) {
    const advance = this.advance(character & 0xffff);
    return [0, Math.fround(advance), 0];
  }
  extent(character) {
    return Math.round(this.advance(character & 0xffff));
  }
  rasterText(_text, width, height) {
    const stride = Math.ceil(width / 4) * 4;
    return {bytes: new Uint8Array(stride * height), stride};
  }
  rasterMonochrome(_text, width, height) {
    const stride = Math.ceil(width / 32) * 4;
    return {bytes: new Uint8Array(stride * height), stride};
  }
  outline() {
    return {width: 0, height: 0, originX: 0, originY: 0, stride: 0, bytes: new Uint8Array(0)};
  }
}

export class ProbeFontProvider {
  /** @param report called once per distinct request with a JSON-serializable record. */
  /** @param files every selected installation file, including unmounted disc files. */
  constructor(files, report) {
    this.catalog = new BurikoBrowserFonts({directoryFonts: () => readGameDirectoryFonts(files)});
    this.report = report;
    this.resources = new Map();
    this.nextResource = 1;
    this.reported = new Set();
  }
  once(record) {
    const key = JSON.stringify(record);
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.report(record);
  }
  queryPitch(name) {
    return this.catalog.queryPitch(name);
  }
  queryCharset(name) {
    return this.catalog.queryCharset(name);
  }
  async enumerate(charset, japanese) {
    const names = await this.catalog.enumerate(charset, japanese);
    this.once({event: 'font-enumerate', charset, japanese, count: names.length});
    return names;
  }
  async loadResource(bytes, enumerable) {
    let faces;
    try {
      faces = readBurikoFontData(bytes).map((data) => ({
        data,
        family: selectName(data, 1) ?? selectName(data, 16),
        fullName: selectName(data, 4),
        names: data.names
          .filter((name) => [1, 4, 6, 16, 21].includes(name.id) && name.unicode !== null)
          .map((name) => name.unicode),
      }));
    } catch {
      this.once({event: 'font-resource', result: 'unreadable', size: bytes.length});
      return null;
    }
    const token = this.nextResource++;
    this.resources.set(token, faces);
    this.once({
      event: 'font-resource',
      enumerable,
      size: bytes.length,
      families: faces.map((face) => face.family),
    });
    return token;
  }
  unloadResource(token) {
    return this.resources.delete(token);
  }
  async create(parameters) {
    const folded = parameters.face.toLowerCase();
    const resource = [...this.resources.values()]
      .flat()
      .find((face) => face.names.some((name) => name.toLowerCase() === folded));
    const located = resource
      ? {source: 'resource', family: resource.family, fullName: resource.fullName}
      : await this.catalog.locate(parameters);
    let data = resource?.data ?? null;
    if (located?.source === 'directory') {
      const faces = (await this.catalog.inspect(parameters.face)) ?? null;
      data = faces?.data ?? null;
    }
    this.once({
      event: 'font-create',
      face: parameters.face,
      weight: parameters.weight,
      italic: parameters.italic,
      charset: parameters.charset,
      source: located?.source ?? 'fallback',
      ...(located ? {family: located.family} : {}),
      ...(located?.source === 'directory' ? {path: located.path} : {}),
    });
    return new MetricFace(
      parameters,
      located?.fullName ?? 'sans-serif',
      located?.family ?? 'sans-serif',
      data,
    );
  }
  dispose() {
    this.catalog.dispose();
  }
}
