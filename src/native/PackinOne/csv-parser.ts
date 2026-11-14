/**
 * PackinOne's `csvParser` (wamsoft csvParser as of 2011-01-20): the class `CSVParser`, a
 * `tp_stub` native class (`TJS_BEGIN_NATIVE_MEMBERS`) that splits CSV text from a string or a
 * storage into arrays, line by line or through the target's `doLine(fields, lineNo)`.
 *
 * As natively: storage text is read as bytes and decoded per line (ANSI code page, or UTF-8),
 * so a 0xFF byte ends the input (`getc` returns it as `EOF`); a quoted field that does not
 * close continues on the next line with the newline text in between; characters between a
 * closing quote and the next separator are appended to the field. A storage is read
 * completely when it is opened; the call that opens it waits for it.
 */
import {VariantSlot} from '../../engines/kirikiri/tjs2/runtime/slot.js';
import {asInteger, asObject, int, obj, str} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import {CP_ACP, CP_UTF8, type Kernel32Exports} from '../kernel32/contract.js';
import {
  failed,
  NIT_METHOD,
  NIT_PROPERTY,
  TJS_BS_READ,
  TJS_BS_SEEK_SET,
  TJS_E_BADPARAMCOUNT,
  TJS_E_NATIVECLASSCRASH,
  TJS_IGNOREPROP,
  TJS_MEMBERENSURE,
  TJS_NIS_GETINSTANCE,
  TJS_S_OK,
  TJS_S_TRUE,
  type Dispatch,
  type NativeClassObject,
  type NativeInstance,
  type Out,
  type TjsBinaryStream,
  type TvpFunctionExporter,
  type Variant,
  type VariantResult,
} from '../tvp-plugin/contract.js';

const EOF = -1;

interface LineSource {
  addNextLine(line: {text: string}): boolean;
}

/** `IFileStr`. */
class StringSource implements LineSource {
  #pos = 0;
  constructor(private readonly dat: string) {}
  #getc(): number {
    return this.#pos < this.dat.length ? this.dat.charCodeAt(this.#pos++) : EOF;
  }
  /**
   * `endOfLine`: after CR the next character is put back unless it is LF or the text ended
   * with it (so a CR before the last character drops that character, as natively).
   */
  #endOfLine(c: number): boolean {
    const eol = c === 13 || c === 10;
    if (c === 13) {
      const n = this.#getc();
      if (this.#pos < this.dat.length && n !== 10) this.#pos--;
    }
    return eol;
  }
  addNextLine(line: {text: string}): boolean {
    let l = 0;
    let c: number;
    while ((c = this.#getc()) !== EOF && !this.#endOfLine(c)) {
      line.text += String.fromCharCode(c);
      l++;
    }
    return l > 0 || c !== EOF;
  }
}

/** `IFileStorage` over the storage's bytes. */
class StorageSource implements LineSource {
  #pos = 0;
  constructor(
    private readonly bytes: Uint8Array,
    private readonly decode: (bytes: Uint8Array) => string,
  ) {}
  /** `getc` on a `char` buffer: bytes are signed, so 0xFF reads as `EOF`. */
  #getc(): number {
    if (this.#pos < this.bytes.length) {
      const b = this.bytes[this.#pos++]!;
      return b >= 0x80 ? b - 0x100 : b;
    }
    return EOF;
  }
  #eof(): boolean {
    return this.#pos >= this.bytes.length;
  }
  #endOfLine(c: number): boolean {
    const eol = c === 13 || c === 10;
    if (c === 13) {
      const n = this.#getc();
      if (!this.#eof() && n !== 10) this.#pos--;
    }
    return eol;
  }
  addNextLine(line: {text: string}): boolean {
    const mb: number[] = [];
    let c: number;
    while ((c = this.#getc()) !== EOF && !this.#endOfLine(c)) mb.push(c & 0xff);
    if (mb.length > 0 || c !== EOF) {
      line.text += this.decode(Uint8Array.from(mb));
      return true;
    }
    return false;
  }
}

/** `NI_CSVParser`. */
class CsvParserInstance implements NativeInstance {
  target: Dispatch | null = null;
  file: LineSource | null = null;
  lineNo = 0;
  separator = ',';
  newline = '\r\n';
  readonly line = {text: ''};

  construct(args: readonly Variant[]): number {
    if (args.length > 0) {
      this.target = asObject(args[0]!);
      this.target?.addRef();
      if (args.length > 1) {
        this.separator = String.fromCharCode(
          Number(BigInt.asIntN(32, asInteger(args[1]!))) & 0xffff,
        );
        if (args.length > 2) this.newline = args[2]!.type === 2 ? args[2]!.value : '';
      }
    }
    return TJS_S_OK;
  }
  invalidate(): void {
    this.file = null;
    this.target?.release();
    this.target = null;
  }
  destruct(): void {
    this.file = null;
  }

  #at(j: number): string {
    return j < this.line.text.length ? this.line.text[j]! : '\0';
  }

  /** `split`. */
  split(fields: Dispatch): void {
    const line = this.line;
    if (line.text.length === 0) return;
    let i = 0;
    let j: number;
    let cnt = 0;
    const find = (ch: string, start: number) => {
      let k = start;
      for (; k < line.text.length; k++) if (line.text[k] === ch) return k;
      return k;
    };
    do {
      let fld = '';
      if (i < line.text.length && line.text[i] === '"') {
        ++i;
        j = i;
        let closed = false;
        do {
          for (; j < line.text.length; j++) {
            if (this.#at(j) === '"' && this.#at(++j) !== '"') {
              let k = find(this.separator, j);
              if (k > line.text.length) k = line.text.length;
              for (k -= j; k-- > 0;) fld += this.#at(j++);
              closed = true;
              break;
            }
            fld += this.#at(j);
          }
          if (closed) break;
          fld += this.newline;
        } while (this.file?.addNextLine(line));
      } else {
        j = find(this.separator, i);
        if (j > line.text.length) j = line.text.length;
        fld = line.text.slice(i, j);
      }
      fields.propSetByNum(TJS_MEMBERENSURE, cnt++, str(fld), fields);
      i = j + 1;
    } while (j < line.text.length);
  }

  /** `getNextLine`. */
  getNextLine(ex: TvpFunctionExporter, result: VariantResult | null): boolean {
    if (!this.file) return false;
    this.line.text = '';
    if (this.file.addNextLine(this.line)) {
      this.lineNo++;
      const fields = ex.TJSCreateArrayObject();
      this.split(fields);
      result?.set(obj(fields, fields));
      fields.release();
      return true;
    }
    this.file = null;
    return false;
  }

  /** `parse`. */
  parse(ex: TvpFunctionExporter, objthis: Dispatch): void {
    const target = this.target ?? objthis;
    if (!this.file || target.isValid(TJS_IGNOREPROP, 'doLine', target) !== TJS_S_TRUE) return;
    const m = new VariantSlot();
    if (failed(target.propGet(TJS_IGNOREPROP, 'doLine', m, target)))
      ex.TVPThrowExceptionMessage("can't get member:doLine");
    const method = asObject(m.value);
    const fields = new VariantSlot();
    try {
      while (this.getNextLine(ex, fields)) {
        method?.funcCall(0, null, null, [fields.value, int(this.lineNo)], target);
      }
    } finally {
      fields.clear();
      m.clear();
    }
    this.file = null;
  }
}

/** Reads a whole storage, then runs `then` (`TVPCreateIStream` at `initStorage`). */
function openStorage(
  ex: TvpFunctionExporter,
  name: string,
  then: (bytes: Uint8Array) => number,
): number {
  let opened: TjsBinaryStream | Promise<TjsBinaryStream>;
  try {
    opened = ex.TVPCreateStream(name, TJS_BS_READ);
  } catch {
    return ex.TVPThrowExceptionMessage('cannot open : ' + name);
  }
  const read = async (stream: TjsBinaryStream) => {
    const size = stream.getSize();
    await stream.prefetch(0, size);
    stream.seek(0, TJS_BS_SEEK_SET);
    const bytes = stream.read(size);
    stream.destruct();
    return bytes;
  };
  return ex.suspend(
    Promise.resolve(opened).then(read, () => ex.TVPThrowExceptionMessage('cannot open : ' + name)),
    then,
  );
}

/** `Create_NC_CSVParser`: the class object, owned by the caller. */
export function createCsvParserClass(
  ex: TvpFunctionExporter,
  kernel32: Kernel32Exports,
): NativeClassObject {
  let classId = -1;
  const cls = ex.TJSCreateNativeClassForPlugin('CSVParser', () => new CsvParserInstance());
  classId = ex.TJSRegisterNativeClass('CSVParser');
  ex.TJSNativeClassSetClassID(cls, classId);
  const ni = (objthis: Dispatch | null): CsvParserInstance | null => {
    if (!objthis) return null;
    const p: Out<NativeInstance | null> = {value: null};
    if (failed(objthis.nativeInstanceSupport(TJS_NIS_GETINSTANCE, classId, p))) return null;
    return p.value as CsvParserInstance | null;
  };
  const decoder = (utf8: boolean) => (bytes: Uint8Array) =>
    kernel32.MultiByteToWideChar(utf8 ? CP_UTF8 : CP_ACP, bytes) ?? '';
  const initStorage = (
    self: CsvParserInstance,
    args: readonly Variant[],
    then: () => number,
  ): number =>
    openStorage(ex, args[0]!.type === 2 ? args[0]!.value : '', (bytes) => {
      self.file = new StorageSource(
        bytes,
        decoder(args.length > 1 && Number(BigInt.asIntN(32, asInteger(args[1]!))) !== 0),
      );
      self.lineNo = 0;
      return then();
    });
  const init = (self: CsvParserInstance, text: Variant) => {
    self.file = new StringSource(text.type === 2 ? text.value : '');
    self.lineNo = 0;
  };
  const method = (
    body: (
      self: CsvParserInstance,
      result: VariantResult | null,
      args: readonly Variant[],
      objthis: Dispatch,
    ) => number,
  ) =>
    ex.TJSCreateNativeClassMethod((result, args, objthis) => {
      const self = ni(objthis);
      if (!self || !objthis) return TJS_E_NATIVECLASSCRASH;
      return body(self, result, args, objthis);
    });
  const register = (name: string, dsp: Dispatch, type = NIT_METHOD) =>
    ex.TJSNativeClassRegisterNCM(cls, name, dsp, 'CSVParser', type, 0);

  register(
    'finalize',
    ex.TJSCreateNativeClassMethod(() => TJS_S_OK),
  );
  register(
    'CSVParser',
    ex.TJSCreateNativeClassConstructor((_result, args, objthis) => {
      const self = ni(objthis);
      if (!self) return TJS_E_NATIVECLASSCRASH;
      return self.construct(args);
    }),
  );
  register(
    'init',
    method((self, _result, args) => {
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      init(self, args[0]!);
      return TJS_S_OK;
    }),
  );
  register(
    'initStorage',
    method((self, _result, args) => {
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      self.file = null;
      return initStorage(self, args, () => TJS_S_OK);
    }),
  );
  register(
    'getNextLine',
    method((self, result) => {
      self.getNextLine(ex, result);
      return TJS_S_OK;
    }),
  );
  register(
    'parse',
    method((self, _result, args, objthis) => {
      if (args.length > 0) init(self, args[0]!);
      self.parse(ex, objthis);
      return TJS_S_OK;
    }),
  );
  register(
    'parseStorage',
    method((self, _result, args, objthis) => {
      const run = () => {
        self.parse(ex, objthis);
        return TJS_S_OK;
      };
      if (args.length > 0) {
        self.file = null;
        return initStorage(self, args, run);
      }
      return run();
    }),
  );
  register(
    'currentLineNumber',
    ex.TJSCreateNativeClassProperty((result, objthis) => {
      const self = ni(objthis);
      if (!self) return TJS_E_NATIVECLASSCRASH;
      result.set(int(self.lineNo));
      return TJS_S_OK;
    }, null),
    NIT_PROPERTY,
  );
  return cls;
}
