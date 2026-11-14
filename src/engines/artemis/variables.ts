import type {ApplicationArgumentsHost} from '../../platform/application-arguments.js';
import type {WindowDisplayGeometry} from '../../platform/window-display.js';
import type {AsbTag} from '../../formats/artemis/asb.js';
import type {GdiEnumeratedFamily} from '../../text/gdi-font-families.js';
import type {ArtemisExpressionValue} from './expression.js';
import {artemisLayerInfoFields, type ArtemisLayerInfo} from './layer-info.js';
import type {ArtemisFontFrameRecord} from './font-state.js';
import {artemisFontText, artemisTagText} from './message-tags.js';
import {crc32} from '../../core/crc32.js';
import {artemisRevision} from './revision.js';

const encoder = new TextEncoder();
const empty = new Uint8Array();
/** System names whose only native writers are runtime paths (no startup initializer), so a
 * missing name follows the ordinary query path. s.clickskip: c0560 run modes 1/3/4, 2 and 7
 * set it to integer 1 through 0x1400b0940. */
const lazySystemVariables = new Set(['s.clickskip']);
function unsupportedSystem(name: string): boolean {
  return (name.startsWith('s.') || name.startsWith('ini.')) && !lazySystemVariables.has(name);
}
/** MSVC `atoi`: leading whitespace, optional sign, decimal digits; saturates at int32. */
function atoi(text: string): number {
  const match = /^[\t\n\v\f\r ]*([+-]?)(\d*)/.exec(text)!;
  let value = 0;
  for (const digit of match[2]!) value = Math.min(value * 10 + Number(digit), 0x80000000);
  return match[1] === '-' ? -value : Math.min(value, 0x7fffffff);
}
function literal(name: string): void {
  if (!name || /[\0\s$+*/()=]/.test(name))
    throw new Error(`Unsupported Artemis variable expression ${name}`);
}

export interface ArtemisVariableHost {
  /** Exact revision identity for confirmed absent system fields; omission keeps strict guards. */
  readonly executableSha256?: string;
  /** Only supplied for revisions with the native nesting query. */
  messageLayerIndentationDepth?(): number;
  /** Logical stage dimensions; supplied by the configuration/rendering owner. */
  stageSize(): {width: number; height: number};
  windowDisplay?(): WindowDisplayGeometry;
  applicationArguments?: ApplicationArgumentsHost;
  /** Selected message layer (stage +0xa0) text extents: virtual +0x140 width (widest line
   * up to the current one), +0x148 height and +0x150 last-line width, as floats. */
  messageLayerMeasure?(): {
    readonly width: number;
    readonly height: number;
    readonly lineWidth: number;
  };
  /** Wall clock in milliseconds since the Unix epoch (CRT `_time64`); local calendar fields
   * follow the host time zone like `_localtime64`. Defaults to `Date.now`. */
  now?(): number;
  /** The scene actor of layer `id` (CArtemisLayer find-by-id 0x1401857c0, then the node's
   * current actor), or undefined when no layer has that id. */
  layerInfo?(id: string): ArtemisLayerInfo | undefined;
  /** Save object (script +0xd0) histories of message layer `id`: undefined without a
   * +0x08 entry; otherwise its text commands and, with `fonts`, its +0x18 font frames. */
  messageTags?(
    id: string,
    fonts: boolean,
  ):
    | {readonly fonts: readonly ArtemisFontFrameRecord[]; readonly tags: readonly AsbTag[]}
    | undefined;
  /** CArtemisPackFile 0x1401193d0 opened on `path` with GameDataPath as the current
   * directory and read whole (0x14017f7c0); null when it does not open. */
  readPackFile?(path: string): Promise<Uint8Array | null>;
  /** The same open with SaveDataPath as the current directory. */
  readSaveFile?(path: string): Promise<Uint8Array | null>;
  /** EnumFontFamiliesExW over DEFAULT_CHARSET (0x140182040). */
  fontFamilies?(): Promise<readonly GdiEnumeratedFamily[]>;
}
const messageLayerExtents = {
  get_message_layer_width: 'width',
  get_message_layer_height: 'height',
  get_message_layer_line_width: 'lineWidth',
} as const;

/** `system` values the native var handler (0x1400e56a0) compares, in its order. Any other
 * value, including an absent `system` (an empty string), falls through and writes nothing. */
const nativeVarSystems = new Set([
  'var_exist',
  'delete',
  'array',
  'random',
  'length',
  'find',
  'substr',
  'implode',
  'explode',
  'convert_encoding',
  'to_utf8',
  'to_sjis',
  'character_reference_to_utf8',
  'url_encode',
  'url_decode',
  'base64_encode',
  'hmac_sha1_base64',
  'date',
  'unixtime',
  'os',
  'screen_width',
  'screen_height',
  'fullscreen',
  'minimize',
  'get_message_layer_width',
  'get_message_layer_height',
  'get_message_layer_line_width',
  'get_message_layer_indent_nest',
  'get_message_tags',
  'get_backlog_size',
  'get_backlog_tags',
  'get_layer_info',
  'get_sound_info',
  'file_exists',
  'file_exist',
  'file_update_time',
  'file_crc',
  'get_exe_parameter',
  'get_font',
]);

/** Literal byte-string variables with current-local/global lookup; expressions require a separate evaluator. */
/** 0x1400a0040 encoding 2: each byte from a lead byte with n further high bits set skips n
 * bytes; counting stops at the first NUL. */
function utf8Characters(bytes: Uint8Array): number {
  const end = bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0);
  let count = 0;
  for (let index = 0; index < end; count++) {
    const byte = bytes[index]!;
    let skip = 0;
    if (byte & 0x80) for (let bit = 0x40; byte & bit; bit >>= 1) skip++;
    index += skip + 1;
    if (index > end) throw new Error('Artemis var length source ends inside a character');
  }
  return count;
}
/** Bytes up to the first NUL: the native string functions walk C strings. */
function cString(bytes: Uint8Array): Uint8Array {
  const end = bytes.indexOf(0);
  return end < 0 ? bytes : bytes.subarray(0, end);
}
/** 0x1400a18f0: A-Z, a-z, 0-9, `-`, `.`, `_` and `~` stay; any other byte is `%%%02X` of
 * its unsigned value. */
function urlEncode(source: Uint8Array): Uint8Array {
  const result: number[] = [];
  for (const byte of source) {
    if (/[A-Za-z0-9._~-]/.test(String.fromCharCode(byte))) result.push(byte);
    else
      for (const char of `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
        result.push(char.charCodeAt(0));
  }
  return Uint8Array.from(result);
}
/** 0x1400a1a10: `+` is a space; `%` takes the next two bytes as `strtol(.., 16)`, stored
 * as one byte; other bytes stay. A `%` without two following bytes reads past the native
 * string. */
function urlDecode(source: Uint8Array): Uint8Array {
  const result: number[] = [];
  for (let index = 0; index < source.length; index++) {
    const byte = source[index]!;
    if (byte === 0x2b) result.push(0x20);
    else if (byte === 0x25) {
      if (index + 2 >= source.length)
        throw new Error('Unsupported Artemis url_decode escape at the end of the source');
      result.push(strtol16(source.subarray(index + 1, index + 3)) & 255);
      index += 2;
    } else result.push(byte);
  }
  return Uint8Array.from(result);
}
/** MSVC `strtol(text, 0, 16)` of a short NUL-free string: leading whitespace, a sign, an
 * optional `0x` and hexadecimal digits; no digits read 0. */
function strtol16(bytes: Uint8Array): number {
  const match = /^[\t\n\v\f\r ]*([+-]?)(?:0[xX](?=[0-9A-Fa-f]))?([0-9A-Fa-f]*)/.exec(
    String.fromCharCode(...bytes),
  )!;
  const value = match[2] ? parseInt(match[2], 16) : 0;
  return match[1] === '-' ? -value : value;
}
/** Optional flags the var handler tests with 0x1400f3c00: present and not "0". */
const flag = (args: ReadonlyMap<string, string>, key: string) =>
  args.has(key) && args.get(key) !== '0';

export class ArtemisVariables {
  private readonly absentSystemVariables: ReadonlySet<string>;
  private readonly emote: boolean;
  constructor(private readonly host?: ArtemisVariableHost) {
    const revision = host?.executableSha256 ? artemisRevision(host.executableSha256) : null;
    this.absentSystemVariables = new Set(revision?.absentSystemVariables ?? []);
    this.emote = revision?.emote ?? false;
  }
  private unsupportedSystem(name: string): boolean {
    return unsupportedSystem(name) && !this.absentSystemVariables.has(name);
  }
  private dirty = false;
  get globalDirty(): boolean {
    return this.dirty;
  }
  clearGlobalDirty(): void {
    this.dirty = false;
  }
  private readonly global = new Map<string, Uint8Array>();
  private readonly locals: Map<string, Uint8Array>[] = [];
  /** Stored values created by 0x140157fa0 as CVariant integers; any write replaces them. */
  private readonly integers = new WeakSet<Uint8Array>();
  pushLocal(): void {
    this.locals.push(new Map());
  }
  popLocal(): void {
    if (!this.locals.length) throw new Error('Artemis local scope underflow');
    this.locals.pop();
  }
  /** Non-inserting native named-variable lookup; callers may distinguish absence
   * from an empty byte string. System expressions still require their own owner. */
  lookup(name: string): Uint8Array | undefined {
    literal(name);
    const value = this.locals.at(-1)?.get(name) ?? this.global.get(name);
    return value === undefined ? undefined : Uint8Array.from(value);
  }
  read(name: string): Uint8Array {
    literal(name);
    const local = this.locals.at(-1);
    const value = local?.get(name) ?? this.global.get(name);
    if (!value && this.unsupportedSystem(name))
      throw new Error(`Unsupported native Artemis variable ${name}`);
    return (value ?? empty).slice();
  }
  /** Literal expression leaf 0x140157fa0: absent names are created as integer zero. */
  queryLiteral(name: string): Uint8Array {
    literal(name);
    if (!this.locals.at(-1)?.has(name) && !this.global.has(name)) {
      if (this.unsupportedSystem(name))
        throw new Error(`Unsupported native Artemis variable ${name}`);
      this.write(name, '0');
      this.integers.add(this.global.get(name)!);
    }
    return this.read(name);
  }
  /** Expression leaf value: query-created zeros are integers, stored data is a string. */
  expressionValue(name: string): ArtemisExpressionValue {
    const bytes = this.queryLiteral(name);
    const stored = this.locals.at(-1)?.get(name) ?? this.global.get(name)!;
    return this.integers.has(stored) ? {kind: 'integer', value: 0} : {kind: 'string', bytes};
  }
  write(name: string, value: Uint8Array | string, local = false): void {
    literal(name);
    const target = local && this.locals.length ? this.locals.at(-1)! : this.global;
    const bytes = typeof value === 'string' ? encoder.encode(value) : value.slice();
    const old = target.get(name);
    if (
      target === this.global &&
      name.startsWith('g.') &&
      (!old || old.length !== bytes.length || old.some((byte, index) => byte !== bytes[index]))
    )
      this.dirty = true;
    target.set(name, bytes);
  }
  /** Save serialization (0x14013ec90): global entries whose name starts with prefix, as
   * their stored strings. Native order follows MSVC hash iteration; readers do not depend
   * on it. */
  globalEntries(prefix: string): [string, Uint8Array][] {
    return [...this.global]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, value]) => [name, value.slice()]);
  }
  /** Save load (0x14013ef10): find-or-insert and the value's string setter, bypassing the
   * table setter, so the global dirty flag is unchanged. */
  restore(name: string, value: Uint8Array): void {
    this.global.set(name, value.slice());
  }
  /** Scenario save 0x1400aff10: every variable not starting with "g.", "s." or "t.", for
   * the global table and then each local frame (oldest first). */
  scenarioEntries(): {
    readonly global: [string, Uint8Array][];
    readonly locals: [string, Uint8Array][][];
  } {
    const entries = (table: Map<string, Uint8Array>): [string, Uint8Array][] =>
      [...table]
        .filter(([name]) => !['g.', 's.', 't.'].some((prefix) => name.startsWith(prefix)))
        .map(([name, value]) => [name, value.slice()]);
    return {global: entries(this.global), locals: this.locals.map(entries)};
  }
  /** Scenario load 0x1400b0370: the reset tail, then find-or-insert with the string setter
   * (no dirty mark); local frames are replaced by the saved frames. */
  restoreScenario(
    global: readonly (readonly [string, Uint8Array])[],
    locals: readonly (readonly (readonly [string, Uint8Array])[])[],
  ): void {
    this.resetScenario();
    for (const [name, value] of global) this.global.set(name, value.slice());
    this.locals.length = 0;
    for (const frame of locals)
      this.locals.push(new Map(frame.map(([name, value]) => [name, value.slice()])));
  }
  /** Variables virtual +0x38 (0x1400b0bd0), the reset tag tail: every global variable
   * except g. and s. names is erased. Local scopes are separate and unchanged. */
  resetScenario(): void {
    for (const name of [...this.global.keys()])
      if (!name.startsWith('g.') && !name.startsWith('s.')) this.global.delete(name);
  }
  delete(name: string, local = false): void {
    literal(name);
    const target = local && this.locals.length ? this.locals.at(-1)! : this.global;
    if (target.has(name)) target.delete(name);
    else for (const key of target.keys()) if (key.startsWith(name + '.')) target.delete(key);
  }
  private unixTime(): number {
    return Math.floor((this.host?.now?.() ?? Date.now()) / 1000);
  }
  /** The `var` tag (0x1400e56a0). File queries settle once the file is read. */
  dispatch(tag: AsbTag): boolean | Promise<boolean> {
    if (tag.name !== 'var') return false;
    const p = tag.args,
      name = p.get('name');
    if (name === undefined) throw new Error('Missing Artemis var name');
    const local = p.has('writelocal') && p.get('writelocal') !== '0';
    // The native handler gives data precedence over system queries.
    if (p.has('data')) this.write(name, tag.bytes?.get('data') ?? p.get('data')!, local);
    // Rev.3258 0x140108a20 answers the E-mote capability with integer 1.
    else if (p.get('system') === 'is_emote' && this.emote) this.write(name, '1', local);
    else if (!nativeVarSystems.has(p.get('system') ?? '')) return true;
    else if (p.get('system') === 'get_message_layer_indent_nest') {
      // Earlier revisions do not recognize this system name and write nothing.
      if (this.host?.messageLayerIndentationDepth)
        this.write(name, String(this.host.messageLayerIndentationDepth()), local);
    } else if (p.get('system') === 'delete') this.delete(name, local);
    else if (p.get('system') === 'get_exe_parameter') {
      if (!this.host?.applicationArguments)
        throw new Error('Artemis application argument provider is not configured');
      for (const [key, value] of this.host.applicationArguments.readApplicationArguments())
        this.write(`${name}.${key}`, value, local);
    } else if (p.get('system') === 'os') this.write(name, 'windows', local);
    else if (p.get('system') === 'fullscreen') {
      if (!this.host?.windowDisplay)
        throw new Error('Artemis window display provider is not configured');
      this.write(name, this.host.windowDisplay().fullscreen ? '1' : '0', local);
    } else if (p.get('system') === 'screen_width' || p.get('system') === 'screen_height') {
      if (!this.host) throw new Error('Artemis stage size provider is not configured');
      const size = this.host.stageSize();
      const value = p.get('system') === 'screen_width' ? size.width : size.height;
      if (!Number.isInteger(value) || value < 1 || value > 0x7fffffff)
        throw new Error('Invalid Artemis stage size');
      this.write(name, String(value), local);
    } else if (Object.hasOwn(messageLayerExtents, p.get('system') ?? '')) {
      // e56a0 stores (int)float through the integer setter.
      if (!this.host?.messageLayerMeasure)
        throw new Error('Artemis message layer measure provider is not configured');
      const key = messageLayerExtents[p.get('system') as keyof typeof messageLayerExtents];
      const value = Math.trunc(this.host.messageLayerMeasure()[key]);
      if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
        throw new Error('Unsupported Artemis message layer extent');
      this.write(name, String(value), local);
    } else if (p.get('system') === 'length') {
      // e56a0: mode absent or "0" stores the byte size of source; mode "1" counts UTF-8
      // characters with 0x1400a0040 (encoding 2); any other mode writes nothing.
      const mode = p.get('mode');
      if (mode !== undefined && mode !== '0' && mode !== '1') return true;
      if (!p.has('source')) throw new Error('Missing Artemis var source');
      const source = tag.bytes?.get('source') ?? new TextEncoder().encode(p.get('source')!);
      this.write(name, String(mode === '1' ? utf8Characters(source) : source.length | 0), local);
    } else if (p.get('system') === 'get_layer_info') {
      // e56a0 with `id`: 0x140116ee0 writes the actor's fields below `name.`; an unknown id
      // writes nothing. `style` only selects the keys of the id-less enumeration.
      if (!p.has('id')) throw new Error('Unsupported Artemis layer enumeration');
      if (!this.host?.layerInfo) throw new Error('Artemis layer info provider is not configured');
      const info = this.host.layerInfo(p.get('id')!);
      if (info)
        for (const [key, value] of artemisLayerInfoFields(info))
          this.write(`${name}.${key}`, value, local);
    } else if (p.get('system') === 'get_message_tags') {
      // e56a0: `name.N` from 0, the font frames first when `allfont` is present and not
      // "0", then the text commands; `name.size` is the count. An absent `id` reads "".
      if (!this.host?.messageTags)
        throw new Error('Artemis message tag history provider is not configured');
      const fonts = p.has('allfont') && p.get('allfont') !== '0';
      const history = this.host.messageTags(p.get('id') ?? '', fonts);
      if (!history) return true;
      const values = [...history.fonts.map(artemisFontText), ...history.tags.map(artemisTagText)];
      values.forEach((value, index) => this.write(`${name}.${index}`, value, local));
      this.write(`${name}.size`, String(values.length), local);
    } else if (p.get('system') === 'unixtime')
      // 0x14019a970 `_time64`, stored through the 32-bit integer setter.
      this.write(name, String(this.unixTime() | 0), local);
    else if (p.get('system') === 'date') {
      // 0x14019a980: `_localtime64` of the 32-bit `unixtime` argument (atoi) or the clock.
      const seconds = p.has('unixtime') ? atoi(p.get('unixtime')!) >>> 0 : this.unixTime() >>> 0;
      const date = new Date(seconds * 1000);
      const fields: [string, number][] = [
        ['year', date.getFullYear()],
        ['month', date.getMonth() + 1],
        ['day', date.getDate()],
        ['hour', date.getHours()],
        ['minute', date.getMinutes()],
        ['second', date.getSeconds()],
      ];
      for (const [field, value] of fields) this.write(`${name}.${field}`, String(value), local);
    } else if (p.get('system') === 'url_encode' || p.get('system') === 'url_decode') {
      const source = cString(tag.bytes?.get('source') ?? encoder.encode(p.get('source') ?? ''));
      this.write(
        name,
        p.get('system') === 'url_encode' ? urlEncode(source) : urlDecode(source),
        local,
      );
    } else if (p.get('system') === 'file_exists' || p.get('system') === 'file_exist')
      return this.fileExists(p, name, local);
    else if (p.get('system') === 'file_crc') return this.fileCrc(p, name, local);
    else if (p.get('system') === 'get_font') return this.fonts(p, name, local);
    else throw new Error(`Unsupported native Artemis var system ${p.get('system') ?? ''}`);
    return true;
  }
  /** `file_exists`/`file_exist`: 1 when `file` opens as a pack file, otherwise 0; `save`
   * (present and not "0") opens it with SaveDataPath as the current directory. */
  private async fileExists(
    p: ReadonlyMap<string, string>,
    name: string,
    local: boolean,
  ): Promise<boolean> {
    const read = flag(p, 'save') ? this.host?.readSaveFile : this.host?.readPackFile;
    if (!read) throw new Error('Artemis pack file provider is not configured');
    const bytes = await read.call(this.host, p.get('file') ?? '');
    this.write(name, bytes ? '1' : '0', local);
    return true;
  }
  /** `file_crc`: the CRC-32 of the pack file `file` as `%x`, `%X` with `caps`, prefixed by
   * `0x` with `zerox`; an empty string when it does not open. */
  private async fileCrc(
    p: ReadonlyMap<string, string>,
    name: string,
    local: boolean,
  ): Promise<boolean> {
    if (!this.host?.readPackFile) throw new Error('Artemis pack file provider is not configured');
    const bytes = await this.host.readPackFile(p.get('file') ?? '');
    if (!bytes) {
      this.write(name, '', local);
      return true;
    }
    const hex = crc32(bytes).toString(16);
    this.write(
      name,
      (flag(p, 'zerox') ? '0x' : '') + (flag(p, 'caps') ? hex.toUpperCase() : hex),
      local,
    );
    return true;
  }
  /** `get_font`: the TrueType Shift-JIS families (fixed pitch with `monospace`), sorted
   * by their UTF-8 bytes and listed once, as `name.N` with `name.size` the count. `@`
   * vertical faces are listed only with `vertical`, the others only without it. Names are
   * stored as UTF-8 (script text mode 2). */
  private async fonts(
    p: ReadonlyMap<string, string>,
    name: string,
    local: boolean,
  ): Promise<boolean> {
    if (!this.host?.fontFamilies) throw new Error('Artemis font family provider is not configured');
    const monospace = flag(p, 'monospace'),
      vertical = flag(p, 'vertical');
    // Callback 0x140182710 with the flags 0x140182040 receives from the var handler.
    const names = new Map<string, Uint8Array>();
    for (const family of await this.host.fontFamilies())
      if (family.fontType === 4 && family.charset === 0x80 && (!monospace || family.fixedPitch))
        names.set(family.name, encoder.encode(family.name));
    const sorted = [...names.values()].sort(compareBytes);
    let count = 0;
    for (const bytes of sorted)
      if ((bytes[0] === 0x40) === vertical) this.write(`${name}.${count++}`, bytes, local);
    this.write(`${name}.size`, String(count), local);
    return true;
  }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++)
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  return left.length - right.length;
}
