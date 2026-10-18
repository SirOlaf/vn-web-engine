/**
 * The tag namespace of a NIF dialect. Tags are interned to small integers; a dialect declares
 * its tags up front so that compiler passes can switch on constant ids.
 */
export class NifTags<Name extends string = string> {
  readonly #names: string[] = [];
  readonly #ids = new Map<string, number>();
  /** Tag ids by name, for the tags declared with the dialect. */
  readonly id: Readonly<Record<Name, number>>;

  constructor(
    readonly dialect: string,
    names: readonly Name[],
  ) {
    const ids = {} as Record<Name, number>;
    for (const name of names) {
      if (this.#ids.has(name)) throw new Error(`NIF dialect ${dialect} declares tag ${name} twice`);
      ids[name] = this.register(name);
    }
    this.id = Object.freeze(ids);
  }

  /** Interns a tag that the dialect did not declare (text input, tools). */
  register(name: string): number {
    if (!isTagName(name)) throw new Error(`Invalid NIF tag name ${JSON.stringify(name)}`);
    let id = this.#ids.get(name);
    if (id === undefined) {
      id = this.#names.length;
      this.#names.push(name);
      this.#ids.set(name, id);
    }
    return id;
  }

  find(name: string): number | undefined {
    return this.#ids.get(name);
  }

  name(id: number): string {
    const name = this.#names[id];
    if (name === undefined)
      throw new RangeError(`NIF tag id ${id} is not in dialect ${this.dialect}`);
    return name;
  }

  get size(): number {
    return this.#names.length;
  }
}

/** Tags are plain ASCII identifiers; directives start with a dot and are not tags. */
export function isTagName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
