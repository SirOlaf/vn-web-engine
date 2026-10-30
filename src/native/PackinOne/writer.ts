/**
 * The text writers of wamsoft's json plugin (`Writer.hpp`, 2013) that saveStruct uses: a
 * string writer and a file writer that flushes every 1024 characters, in UTF-8 or the ANSI
 * code page. Reals in `hex` mode are written in hexadecimal followed by the decimal value in a
 * C comment.
 */
import {
  integerToString,
  realToHexString,
  realToString,
} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import {
  TJS_BS_WRITE,
  type TjsBinaryStream,
  type TvpFunctionExporter,
} from '../tvp-plugin/contract.js';

export abstract class TextWriter {
  readonly newlineText: string;
  indent = 0;
  hex = false;
  constructor(newlineType = 0) {
    this.newlineText = newlineType === 1 ? '\n' : '\r\n';
  }
  abstract write(text: string): void;
  writeReal(num: number): void {
    if (this.hex) this.write(`${realToHexString(num)} /* ${realToString(num)} */`);
    else this.write(realToString(num));
  }
  writeInteger(num: bigint): void {
    this.write(integerToString(num));
  }
  newline(): void {
    this.write(this.newlineText);
    for (let i = 0; i < this.indent; i++) this.write(' ');
  }
}

/** `IStringWriter`. */
export class StringWriter extends TextWriter {
  buf = '';
  write(text: string): void {
    this.buf += text;
  }
}

/** `IFileWriter`: `close` flushes the rest and closes the stream. */
export class FileWriter extends TextWriter {
  #buf = '';
  readonly #stream: TjsBinaryStream | null;
  constructor(
    private readonly ex: TvpFunctionExporter,
    filename: string,
    private readonly utf = false,
    newlineType = 0,
  ) {
    super(newlineType);
    const s = ex.TVPCreateStream(filename, TJS_BS_WRITE);
    // A write stream opens synchronously.
    this.#stream = s instanceof Promise ? null : s;
  }
  #output(): void {
    if (this.#stream) {
      const bytes = this.utf
        ? new TextEncoder().encode(this.#buf)
        : this.ex.TJSNarrowString(this.#buf);
      this.#stream.write(bytes);
    }
    this.#buf = '';
  }
  write(text: string): void {
    if (!this.#stream) return;
    this.#buf += text;
    if (this.#buf.length >= 1024) this.#output();
  }
  close(): void {
    if (!this.#stream) return;
    if (this.#buf.length > 0) this.#output();
    this.#stream.destruct();
  }
}
