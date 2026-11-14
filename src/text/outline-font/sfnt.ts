/** sfnt container: table directory, font header and the horizontal/vertical metric tables, read
 * with the rules of FreeType 2.4.8's `sfnt` module (`ttload.c`, `ttmtx.c`, `sfobjs.c`).
 */

/** FreeType error codes that the font loader reports. */
export const enum FontErrorCode {
  UnknownFileFormat = 0x02,
  InvalidFileFormat = 0x03,
  InvalidArgument = 0x06,
  UnimplementedFeature = 0x07,
  InvalidTable = 0x08,
  ArrayTooLarge = 0x0a,
  InvalidGlyphIndex = 0x10,
  InvalidGlyphFormat = 0x12,
  InvalidOutline = 0x14,
  InvalidComposite = 0x15,
  TooManyHints = 0x16,
  InvalidSizeHandle = 0x24,
  InvalidStreamOperation = 0x55,
  TooFewArguments = 0x81,
  StackOverflow = 0x82,
  TableMissing = 0x8e,
  HorizHeaderMissing = 0x8f,
  LocationsMissing = 0x90,
  HmtxTableMissing = 0x93,
  InvalidHorizMetrics = 0x95,
  InvalidPPem = 0x97,
  InvalidVertMetrics = 0x98,
  SyntaxError = 0xa0,
  StackUnderflow = 0xa1,
  RasterOverflow = 0x62,
}

export class FontError extends Error {
  constructor(readonly code: number) {
    super('Font error ' + code);
  }
}

export const tag = (s: string): number =>
  ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>>
  0;

/** Big-endian reads that fail like an FT stream read past the end of the file. */
export class Bytes {
  constructor(readonly data: Uint8Array) {}
  get length(): number {
    return this.data.length;
  }
  check(offset: number, size: number): void {
    if (offset < 0 || offset + size > this.data.length)
      throw new FontError(FontErrorCode.InvalidStreamOperation);
  }
  u8(o: number): number {
    this.check(o, 1);
    return this.data[o]!;
  }
  u16(o: number): number {
    this.check(o, 2);
    return (this.data[o]! << 8) | this.data[o + 1]!;
  }
  i16(o: number): number {
    return (this.u16(o) << 16) >> 16;
  }
  u32(o: number): number {
    this.check(o, 4);
    return (
      ((this.data[o]! << 24) |
        (this.data[o + 1]! << 16) |
        (this.data[o + 2]! << 8) |
        this.data[o + 3]!) >>>
      0
    );
  }
  i32(o: number): number {
    return this.u32(o) | 0;
  }
}

export interface TableEntry {
  readonly tag: number;
  readonly offset: number;
  readonly length: number;
}

/** Long horizontal or vertical metrics (`hmtx`/`vmtx`) in FreeType's array layout. */
export interface MetricTable {
  readonly advances: Uint16Array;
  readonly bearings: Int16Array;
  readonly shorts: Int16Array;
}

export class Sfnt {
  readonly bytes: Bytes;
  readonly formatTag: number;
  readonly faceCount: number;
  readonly tables: readonly TableEntry[];
  // head
  readonly headFlags: number;
  readonly unitsPerEm: number;
  readonly bbox: readonly [number, number, number, number];
  readonly indexToLocFormat: number;
  // maxp
  readonly numGlyphs: number;
  readonly maxSizeOfInstructions: number;
  readonly maxComponentDepth: number;
  // root metrics
  readonly ascender: number;
  readonly descender: number;
  readonly height: number;
  readonly maxAdvanceWidth: number;
  readonly maxAdvanceHeight: number;
  readonly underlinePosition: number;
  readonly underlineThickness: number;
  readonly verticalInfo: boolean;
  readonly horizontal: MetricTable;
  readonly vertical: MetricTable | null;
  readonly cmap: TableEntry | null;

  constructor(data: Uint8Array, faceIndex: number) {
    const b = (this.bytes = new Bytes(data));
    // sfnt_open_font
    const format = b.u32(0);
    if (
      format !== 0x00010000 &&
      format !== tag('ttcf') &&
      format !== tag('OTTO') &&
      format !== tag('true') &&
      format !== tag('typ1') &&
      format !== 0x00020000
    )
      throw new FontError(FontErrorCode.UnknownFileFormat);
    let offset = 0,
      count = 1;
    if (format === tag('ttcf')) {
      count = b.i32(8);
      if (count === 0) throw new FontError(FontErrorCode.InvalidTable);
      if (count >>> 0 > Math.floor(data.length / 32))
        throw new FontError(FontErrorCode.ArrayTooLarge);
      if (faceIndex >= count) throw new FontError(FontErrorCode.InvalidArgument);
      offset = b.u32(12 + 4 * faceIndex);
    } else if (faceIndex >= count) throw new FontError(FontErrorCode.InvalidArgument);
    this.faceCount = count;
    this.tables = readTableDirectory(b, offset);
    this.formatTag = b.u32(offset);
    if (this.formatTag === tag('ttcf')) throw new FontError(FontErrorCode.UnknownFileFormat);

    // sfnt_load_face: head
    const hasOutline = !!this.find('glyf') || !!this.find('CFF ');
    if (!hasOutline) throw new FontError(FontErrorCode.UnimplementedFeature);
    const head = this.find('head');
    if (!head) throw new FontError(FontErrorCode.TableMissing);
    b.check(head.offset, 54);
    this.headFlags = b.u16(head.offset + 16);
    this.unitsPerEm = b.u16(head.offset + 18);
    this.bbox = [
      b.i16(head.offset + 36),
      b.i16(head.offset + 38),
      b.i16(head.offset + 40),
      b.i16(head.offset + 42),
    ];
    this.indexToLocFormat = b.i16(head.offset + 50);
    if (this.unitsPerEm === 0) throw new FontError(FontErrorCode.InvalidTable);

    // maxp (errors leave the profile zeroed)
    let numGlyphs = 0,
      maxSizeOfInstructions = 0,
      maxComponentDepth = 0;
    const maxp = this.find('maxp');
    if (maxp && maxp.offset + 6 <= data.length) {
      const version = b.u32(maxp.offset);
      numGlyphs = b.u16(maxp.offset + 4);
      if (version >= 0x10000 && maxp.offset + 32 <= data.length) {
        maxSizeOfInstructions = b.u16(maxp.offset + 26);
        maxComponentDepth = Math.min(b.u16(maxp.offset + 30), 100);
      }
    }
    this.numGlyphs = numGlyphs;
    this.maxSizeOfInstructions = maxSizeOfInstructions;
    this.maxComponentDepth = maxComponentDepth;

    this.cmap = this.find('cmap');

    // post (optional)
    let underlinePosition = 0,
      underlineThickness = 0;
    const post = this.find('post');
    if (post && post.offset + 32 <= data.length) {
      underlinePosition = b.i16(post.offset + 8);
      underlineThickness = b.i16(post.offset + 10);
    }

    // hhea + hmtx (required), vhea + vmtx (optional)
    const hhea = this.readMetricHeader('hhea');
    if (!hhea) {
      if (this.formatTag === tag('true')) throw new FontError(FontErrorCode.UnimplementedFeature);
      throw new FontError(FontErrorCode.HorizHeaderMissing);
    }
    const horizontal = this.readMetrics('hmtx', hhea.numberOfMetrics, false);
    if (!horizontal) throw new FontError(FontErrorCode.HmtxTableMissing);
    this.horizontal = horizontal;
    const vhea = this.readMetricHeader('vhea');
    this.vertical = vhea ? this.readMetrics('vmtx', vhea.numberOfMetrics, true) : null;
    this.verticalInfo = !!this.vertical;

    // OS/2: any read error marks the table missing.
    let os2: {
      typoAscender: number;
      typoDescender: number;
      typoLineGap: number;
      winAscent: number;
      winDescent: number;
    } | null = null;
    const os2Entry = this.find('OS/2');
    if (os2Entry && os2Entry.offset + 78 <= data.length) {
      const o = os2Entry.offset,
        version = b.u16(o);
      const extra = version >= 2 ? 18 : version >= 1 ? 8 : 0;
      if (o + 78 + extra <= data.length)
        os2 = {
          typoAscender: b.i16(o + 68),
          typoDescender: b.i16(o + 70),
          typoLineGap: b.i16(o + 72),
          winAscent: b.u16(o + 74),
          winDescent: b.u16(o + 76),
        };
    }

    // Root metrics (sfnt_load_face, then FT_Open_Face's sign and vertical fixes).
    let ascender = hhea.ascender,
      descender = hhea.descender,
      height = ((ascender - descender + hhea.lineGap) << 16) >> 16;
    if (!(ascender || descender) && os2) {
      if (os2.typoAscender || os2.typoDescender) {
        ascender = os2.typoAscender;
        descender = os2.typoDescender;
        height = ((ascender - descender + os2.typoLineGap) << 16) >> 16;
      } else {
        ascender = (os2.winAscent << 16) >> 16;
        descender = (-((os2.winDescent << 16) >> 16) << 16) >> 16;
        height = (ascender - descender) & 0xffff;
        height = (height << 16) >> 16;
      }
    }
    this.ascender = ascender;
    this.descender = descender;
    this.maxAdvanceWidth = hhea.maxAdvance;
    let maxAdvanceHeight = ((vhea && this.verticalInfo ? vhea.maxAdvance : height) << 16) >> 16;
    this.underlinePosition = ((underlinePosition - Math.trunc(underlineThickness / 2)) << 16) >> 16;
    this.underlineThickness = underlineThickness;
    if (height < 0) height = (-height << 16) >> 16;
    if (!this.verticalInfo) maxAdvanceHeight = height;
    this.height = height;
    this.maxAdvanceHeight = maxAdvanceHeight;
  }

  /** `tt_face_lookup_table`: the first entry with the tag and a nonzero length. */
  find(name: string): TableEntry | null {
    const t = tag(name);
    for (const entry of this.tables) if (entry.tag === t && entry.length !== 0) return entry;
    return null;
  }

  private readMetricHeader(name: 'hhea' | 'vhea') {
    const entry = this.find(name);
    if (!entry) return null;
    this.bytes.check(entry.offset, 36);
    const b = this.bytes,
      o = entry.offset;
    return {
      ascender: b.i16(o + 4),
      descender: b.i16(o + 6),
      lineGap: b.i16(o + 8),
      maxAdvance: b.u16(o + 10),
      numberOfMetrics: b.u16(o + 34),
    };
  }

  /** `tt_face_load_hmtx` (array variant used with FT_CONFIG_OPTION_OLD_INTERNALS). */
  private readMetrics(
    name: 'hmtx' | 'vmtx',
    numberOfMetrics: number,
    vertical: boolean,
  ): MetricTable | null {
    const entry = this.find(name);
    if (!entry) return null;
    const b = this.bytes,
      length = entry.length;
    const numLongs = Math.min(numberOfMetrics, Math.floor(length / 4));
    const numShorts = this.numGlyphs - numLongs,
      numShortsChecked = Math.floor((length - numLongs * 4) / 2);
    if (numShorts < 0)
      throw new FontError(
        vertical ? FontErrorCode.InvalidVertMetrics : FontErrorCode.InvalidHorizMetrics,
      );
    b.check(entry.offset, length);
    const advances = new Uint16Array(numLongs),
      bearings = new Int16Array(numLongs),
      shorts = new Int16Array(numShorts);
    let p = entry.offset;
    for (let i = 0; i < numLongs; i++, p += 4) {
      advances[i] = b.u16(p);
      bearings[i] = b.i16(p + 2);
    }
    const checked = Math.min(numShorts, numShortsChecked);
    for (let i = 0; i < checked; i++, p += 2) shorts[i] = b.i16(p);
    if (numShorts > numShortsChecked && numShortsChecked > 0)
      shorts.fill(shorts[numShortsChecked - 1]!, checked);
    return {advances, bearings, shorts};
  }

  /** `tt_face_get_metrics`: [bearing, advance] for a glyph. */
  metrics(vertical: boolean, glyph: number): [number, number] {
    const table = vertical ? this.vertical : this.horizontal;
    const k = table?.advances.length ?? 0;
    if (!table || k === 0 || glyph >= this.numGlyphs) return [0, 0];
    if (glyph < k) return [table.bearings[glyph]!, table.advances[glyph]!];
    return [table.shorts[glyph - k]!, table.advances[k - 1]!];
  }
}

/** `check_table_dir` and `tt_face_load_font_dir`. */
function readTableDirectory(b: Bytes, offset: number): TableEntry[] {
  const numTables = b.u16(offset + 4);
  const raw: TableEntry[] = [];
  for (let n = 0; n < numTables; n++) {
    const p = offset + 12 + n * 16;
    if (p + 16 > b.length) break;
    raw.push({tag: b.u32(p), offset: b.u32(p + 8), length: b.u32(p + 12)});
  }
  let valid = 0,
    hasHead = false,
    hasSing = false,
    hasMeta = false;
  for (const t of raw) {
    if (t.offset + t.length > b.length) continue;
    valid++;
    if (t.tag === tag('head') || t.tag === tag('bhed')) {
      hasHead = true;
      if (t.length < 0x36) throw new FontError(FontErrorCode.TableMissing);
      if (b.u32(t.offset + 12) !== 0x5f0f3cf5) throw new FontError(FontErrorCode.TableMissing);
    } else if (t.tag === tag('SING')) hasSing = true;
    else if (t.tag === tag('META')) hasMeta = true;
  }
  if (valid === 0) throw new FontError(FontErrorCode.UnknownFileFormat);
  if (!hasHead && !(hasSing && hasMeta)) throw new FontError(FontErrorCode.TableMissing);
  // The directory keeps the valid tables among the first `valid` entries.
  return raw.slice(0, valid).filter((t) => t.offset + t.length <= b.length);
}
