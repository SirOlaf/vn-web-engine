/**
 * PackinOne's `savestruct` (wamsoft saveStruct as of 2013-03-12): `Array.save2`,
 * `Array.saveStruct2`, `Array.toStructString` and the static `Dictionary.saveStruct2` /
 * `Dictionary.toStructString`. The text is `saveStruct`'s with reals in hexadecimal plus a
 * decimal comment, octets as `<% xx %>`, hidden members skipped.
 */
import {
  NcbClassInfo,
  ncbInt,
  ncbString,
  type NcbAttachDefinition,
} from '../../engines/kirikiri/tp-stub/ncbind.js';
import {NativeFunction} from '../../engines/kirikiri/tjs2/runtime/native.js';
import {VariantSlot} from '../../engines/kirikiri/tjs2/runtime/slot.js';
import {
  asInteger,
  asObject,
  asString,
  int,
  obj,
  str,
} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import {
  TJS_E_BADPARAMCOUNT,
  TJS_HIDDENMEMBER,
  TJS_IGNOREPROP,
  TJS_S_OK,
  TJS_S_TRUE,
  TJS_STATICMEMBER,
  type Dispatch,
  type TvpFunctionExporter,
  type Variant,
  type VariantResult,
} from '../tvp-plugin/contract.js';
import {FileWriter, StringWriter, type TextWriter} from './writer.js';

/** `Array.count`, read after registration. */
export interface ArrayCount {
  prop: Dispatch | null;
}

function quoteString(s: string, w: TextWriter): void {
  w.write('"');
  for (const ch of s) {
    if (ch === '"') w.write('\\"');
    else if (ch === '\\') w.write('\\\\');
    else w.write(ch);
  }
  w.write('"');
}

function quoteOctet(bytes: Uint8Array, w: TextWriter): void {
  w.write('<% ');
  for (const b of bytes) w.write(b.toString(16).padStart(2, '0') + ' ');
  w.write('%>');
}

export class StructWriter {
  constructor(private readonly count: ArrayCount) {}

  dict(dict: Dispatch, w: TextWriter): void {
    w.write('%[');
    let first = true;
    const caller = new NativeFunction((result, args) => {
      if (args.length > 1) {
        const flag = asInteger(args[1]!);
        if (!(flag & BigInt(TJS_HIDDENMEMBER))) {
          if (first) first = false;
          else {
            w.write(',');
            w.newline();
          }
          quoteString(args[0]!.type === 2 ? args[0]!.value : asString(args[0]!), w);
          w.write('=>');
          this.variant(args[2]!, w);
        }
      }
      result?.set(int(1));
      return TJS_S_OK;
    });
    try {
      dict.enumMembers(TJS_IGNOREPROP, obj(caller), dict);
    } finally {
      caller.release();
    }
    w.write(']');
  }

  arrayCount(array: Dispatch): number {
    const slot = new VariantSlot();
    let n = 0;
    if (this.count.prop && this.count.prop.propGet(0, null, slot, array) >= 0)
      n = Number(BigInt.asIntN(32, asInteger(slot.value)));
    slot.clear();
    return n;
  }

  array(array: Dispatch, w: TextWriter): void {
    w.write('[');
    const n = this.arrayCount(array);
    for (let i = 0; i < n; i++) {
      if (i !== 0) w.write(',');
      const slot = new VariantSlot();
      if (array.propGetByNum(TJS_IGNOREPROP, i, slot, array) === TJS_S_OK)
        this.variant(slot.value, w);
      slot.clear();
    }
    w.write(']');
  }

  variant(v: Variant, w: TextWriter): void {
    switch (v.type) {
      case 1: {
        const o = v.object;
        if (!o) w.write('null');
        else if (o.isInstanceOf(TJS_IGNOREPROP, null, 'Array', o) === TJS_S_TRUE) this.array(o, w);
        else this.dict(o, w);
        return;
      }
      case 2:
        quoteString(v.value, w);
        return;
      case 3:
        quoteOctet(v.value, w);
        return;
      case 4:
        w.write('int ');
        w.writeInteger(v.value);
        return;
      case 5:
        w.write('real ');
        w.writeReal(v.value);
        return;
      default:
        w.write('void');
    }
  }
}

export const ARRAY_ADD = new NcbClassInfo<object>('ArrayAdd');
export const DICT_ADD = new NcbClassInfo<object>('DictAdd');

function fileWriter(ex: TvpFunctionExporter, args: readonly Variant[]): FileWriter {
  const w = new FileWriter(
    ex,
    ncbString(args[0]!),
    args.length > 1 ? ncbInt(args[1]!) !== 0 : false,
    args.length > 2 ? ncbInt(args[2]!) : 0,
  );
  w.hex = true;
  return w;
}

function toStructString(
  writeTo: (w: TextWriter) => void,
  result: VariantResult | null,
  args: readonly Variant[],
): number {
  if (result) {
    const w = new StringWriter(args.length > 0 ? ncbInt(args[0]!) : 0);
    w.hex = true;
    writeTo(w);
    result.set(str(w.buf));
  }
  return TJS_S_OK;
}

/** `NCB_ATTACH_CLASS(ArrayAdd, Array)`. */
export function arrayAdd(ex: TvpFunctionExporter, sw: StructWriter): NcbAttachDefinition<object> {
  return {
    info: ARRAY_ADD,
    tjs2Class: 'Array',
    define: (r) =>
      r
        .rawCallback('save2', (_result, args, objthis) => {
          if (args.length < 1) return TJS_E_BADPARAMCOUNT;
          const w = fileWriter(ex, args);
          const n = sw.arrayCount(objthis);
          for (let i = 0; i < n; i++) {
            const slot = new VariantSlot();
            if (objthis.propGetByNum(TJS_IGNOREPROP, i, slot, objthis) === TJS_S_OK) {
              w.write(
                slot.value.type === 2
                  ? slot.value.value
                  : slot.value.type === 0
                    ? ''
                    : asString(slot.value),
              );
              w.newline();
            }
            slot.clear();
          }
          w.close();
          return TJS_S_OK;
        })
        .rawCallback('saveStruct2', (_result, args, objthis) => {
          if (args.length < 1) return TJS_E_BADPARAMCOUNT;
          const w = fileWriter(ex, args);
          sw.array(objthis, w);
          w.close();
          return TJS_S_OK;
        })
        .rawCallback('toStructString', (result, args, objthis) =>
          toStructString((w) => sw.array(objthis, w), result, args),
        ),
  };
}

/** `NCB_ATTACH_CLASS(DictAdd, Dictionary)`. */
export function dictAdd(ex: TvpFunctionExporter, sw: StructWriter): NcbAttachDefinition<object> {
  return {
    info: DICT_ADD,
    tjs2Class: 'Dictionary',
    define: (r) =>
      r
        .rawCallback(
          'saveStruct2',
          (_result, args, objthis) => {
            if (args.length < 1) return TJS_E_BADPARAMCOUNT;
            const w = fileWriter(ex, args);
            sw.dict(objthis, w);
            w.close();
            return TJS_S_OK;
          },
          TJS_STATICMEMBER,
        )
        .rawCallback(
          'toStructString',
          (result, args, objthis) => toStructString((w) => sw.dict(objthis, w), result, args),
          TJS_STATICMEMBER,
        ),
  };
}

/** `PostRegistCallback`: `Array.count`. */
export function saveStructPostRegist(ex: TvpFunctionExporter, count: ArrayCount): void {
  const array = new VariantSlot();
  ex.TVPExecuteExpression('Array', null, array);
  const cls = asObject(array.value);
  const val = new VariantSlot();
  if (!cls || cls.propGet(TJS_IGNOREPROP, 'count', val, cls) < 0)
    ex.TVPThrowExceptionMessage("can't get Array.count");
  count.prop = asObject(val.value);
  count.prop?.addRef();
  val.clear();
  array.clear();
}

export function saveStructPreUnregist(count: ArrayCount): void {
  count.prop?.release();
  count.prop = null;
}
