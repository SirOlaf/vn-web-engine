/**
 * Interning tables shared by NIF buffers: strings (identifiers, symbols and string literals),
 * numbers that do not fit inline, source file names and packed source positions.
 *
 * Buffers that exchange trees (for example a parsed and an analysed stage of one compilation)
 * share one pool, so token payloads stay valid when subtrees are copied between them.
 */
export class NifPool {
  readonly #strings: string[] = [''];
  readonly #stringIds = new Map<string, number>([['', 0]]);
  readonly #floats: number[] = [];
  readonly #bigints: bigint[] = [];
  readonly #files: string[] = [''];
  readonly #fileIds = new Map<string, number>();
  /** Out-of-line positions: file, line and column per entry. */
  readonly #aside: number[] = [];

  intern(text: string): number {
    let id = this.#stringIds.get(text);
    if (id === undefined) {
      id = this.#strings.length;
      this.#strings.push(text);
      this.#stringIds.set(text, id);
    }
    return id;
  }

  string(id: number): string {
    const text = this.#strings[id];
    if (text === undefined) throw new RangeError(`NIF string id ${id} is not in the pool`);
    return text;
  }

  addFloat(value: number): number {
    this.#floats.push(value);
    return this.#floats.length - 1;
  }

  float(id: number): number {
    const value = this.#floats[id];
    if (value === undefined) throw new RangeError(`NIF float id ${id} is not in the pool`);
    return value;
  }

  addBigInt(value: bigint): number {
    this.#bigints.push(value);
    return this.#bigints.length - 1;
  }

  bigint(id: number): bigint {
    const value = this.#bigints[id];
    if (value === undefined) throw new RangeError(`NIF integer id ${id} is not in the pool`);
    return value;
  }

  /** File ids start at 1; 0 means "no file". */
  file(name: string): number {
    let id = this.#fileIds.get(name);
    if (id === undefined) {
      id = this.#files.length;
      this.#files.push(name);
      this.#fileIds.set(name, id);
    }
    return id;
  }

  fileName(id: number): string {
    const name = this.#files[id];
    if (name === undefined) throw new RangeError(`NIF file id ${id} is not in the pool`);
    return name;
  }

  /**
   * Packs a source position into 32 bits. Inline layout: bit 0 clear, file in bits 1–9,
   * line in bits 10–24, column in bits 25–31. Positions outside those ranges go to a side
   * table (bit 0 set, index above it). Lines start at 1, so 0 is never a valid position.
   */
  position(file: number, line: number, column: number): number {
    if (line < 1) throw new RangeError(`NIF line ${line} is not positive`);
    if (file < 0x200 && line < 0x8000 && column >= 0 && column < 0x80)
      return ((column << 25) | (line << 10) | (file << 1)) >>> 0;
    const index = this.#aside.length / 3;
    this.#aside.push(file, line, column);
    return ((index << 1) | 1) >>> 0;
  }

  /** Writes `[file, line, column]` of a packed position into `out`; zeros for no position. */
  unpack(info: number, out: [number, number, number]): [number, number, number] {
    if (info === 0) {
      out[0] = out[1] = out[2] = 0;
    } else if (info & 1) {
      const base = (info >>> 1) * 3;
      out[0] = this.#aside[base]!;
      out[1] = this.#aside[base + 1]!;
      out[2] = this.#aside[base + 2]!;
    } else {
      out[0] = (info >>> 1) & 0x1ff;
      out[1] = (info >>> 10) & 0x7fff;
      out[2] = info >>> 25;
    }
    return out;
  }
}

export const NO_POSITION = 0;
