import {PsbResource, type PsbObject, type PsbValue} from './psb.js';

/**
 * PSB field access with the conversions of the E-mote runtime's PSB object layer.
 * Addresses refer to `emotedriver.dll` SHA-256 `a3b693b6…5e70b3a86`:
 * key lookup 0x10052530, float 0x100521d0, int 0x10052140, bool 0x100520a0, string 0x10052290,
 * null test 0x10052010, type classes at 0x100713e8.
 */

/** A condition under which the native loader aborts or rejects the file. */
export class EmoteModelError extends Error {
  override name = 'EmoteModelError';
}

export const isPsbObject = (value: PsbValue | undefined): value is PsbObject =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof PsbResource);

export const has = (object: PsbObject, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

/** A strict key read. The native loader aborts with this message when the key is absent. */
export function field(object: PsbObject, key: string, path: string): PsbValue {
  const value = object[key];
  if (value === undefined)
    throw new EmoteModelError(`psb: undefined object key '${key}' is referenced. (${path})`);
  return value;
}

const fail = (kind: string, path: string): never => {
  throw new EmoteModelError(`psb: can't convert value to ${kind}. (${path})`);
};

/** Bool, integer and float values convert; null, strings, lists and objects abort. */
export function toFloat(value: PsbValue, path: string): number {
  if (typeof value === 'number') return Math.fround(value);
  if (typeof value === 'bigint') return Math.fround(Number(value));
  if (typeof value === 'boolean') return value ? 1 : 0;
  return fail('float', path);
}

/** As `toFloat`; floats truncate toward zero (`_ftol`) and integers wrap to 32 bits. */
export function toInt(value: PsbValue, path: string): number {
  if (typeof value === 'number') return Math.trunc(value) | 0;
  if (typeof value === 'bigint') return Number(BigInt.asIntN(32, value));
  if (typeof value === 'boolean') return value ? 1 : 0;
  return fail('int', path);
}

/** Nonzero numbers are true. */
export function toBool(value: PsbValue, path: string): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  return fail('bool', path);
}

export function toText(value: PsbValue, path: string): string {
  if (typeof value === 'string') return value;
  return fail('string', path);
}

export function toList(value: PsbValue, path: string): readonly PsbValue[] {
  if (Array.isArray(value)) return value as readonly PsbValue[];
  return fail('list', path);
}

export function toObject(value: PsbValue, path: string): PsbObject {
  if (isPsbObject(value)) return value;
  return fail('object', path);
}

export function toResource(value: PsbValue, path: string): PsbResource {
  if (value instanceof PsbResource) return value;
  return fail('resource', path);
}

/** Strict typed reads: the key must exist and convert. */
export const floatField = (o: PsbObject, key: string, path: string): number =>
  toFloat(field(o, key, path), `${path}.${key}`);
export const intField = (o: PsbObject, key: string, path: string): number =>
  toInt(field(o, key, path), `${path}.${key}`);
export const boolField = (o: PsbObject, key: string, path: string): boolean =>
  toBool(field(o, key, path), `${path}.${key}`);
export const textField = (o: PsbObject, key: string, path: string): string =>
  toText(field(o, key, path), `${path}.${key}`);
export const listField = (o: PsbObject, key: string, path: string): readonly PsbValue[] =>
  toList(field(o, key, path), `${path}.${key}`);
export const objectField = (o: PsbObject, key: string, path: string): PsbObject =>
  toObject(field(o, key, path), `${path}.${key}`);

/** A strict key whose value may be null (`parameterize`, easing references). */
export function nullableIntField(o: PsbObject, key: string, path: string): number | null {
  const value = field(o, key, path);
  return value === null ? null : toInt(value, `${path}.${key}`);
}

export const floatList = (values: readonly PsbValue[], path: string): readonly number[] =>
  Object.freeze(values.map((v, i) => toFloat(v, `${path}[${i}]`)));

/**
 * Keys present in the data that the runtime's loader does not read, kept as raw PSB values.
 * Returns a frozen object, empty when every key was consumed.
 */
export function unreadKeys(
  object: PsbObject,
  consumed: ReadonlySet<string>,
): Readonly<Record<string, PsbValue>> {
  let out: Record<string, PsbValue> | undefined;
  for (const key in object)
    if (!consumed.has(key))
      (out ??= Object.create(null) as Record<string, PsbValue>)[key] = object[key]!;
  return Object.freeze(out ?? EMPTY);
}
const EMPTY: Record<string, PsbValue> = Object.freeze(Object.create(null));

/** Collects conditions that the native loader would abort or warn on but that are tolerated. */
export class EmoteDiagnostics {
  private readonly byText = new Map<
    string,
    {kind: EmoteDiagnostic['kind']; path: string; text: string; count: number}
  >();
  /** Repeated conditions with the same text are counted; the first path is kept. */
  add(kind: EmoteDiagnostic['kind'], path: string, text: string): void {
    const id = `${kind}\0${text}`,
      entry = this.byText.get(id);
    if (entry) entry.count++;
    else this.byText.set(id, {kind, path, text, count: 1});
  }
  get entries(): readonly EmoteDiagnostic[] {
    return Object.freeze([...this.byText.values()].map((e) => Object.freeze({...e})));
  }
}

export interface EmoteDiagnostic {
  /**
   * `abort`: `emotedriver.dll` aborts when it reaches this data (missing key or wrong type).
   * `message`: it formats a warning and continues.
   */
  readonly kind: 'abort' | 'message';
  /** First occurrence. */
  readonly path: string;
  readonly text: string;
  readonly count: number;
}
