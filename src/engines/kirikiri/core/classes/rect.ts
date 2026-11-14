/**
 * `Rect` (krkrz `visual/RectItf.cpp`). The rectangle lives in the core memory once
 * `nativeArray` (its address) has been read, so plugins can address it.
 */
import {TJS_E_INVALIDPARAM, TJS_S_OK, type Dispatch} from '../../tjs2/runtime/interface.js';
import {
  NativeClass,
  NativeInstanceBase,
  constructNativeInstance,
  getNativeInstance,
  registerNativeClass,
} from '../../tjs2/runtime/native.js';
import {asObjectClosure, int, integer, type Variant} from '../../tjs2/runtime/variant.js';
import {TvpRect, intersectRect, unionRect} from '../visual/complex-rect.js';
import type {TvpMemory} from '../visual/memory.js';
import {Binder, i32} from './binding.js';

export const RECT_CLASS_ID = registerNativeClass('Rect');

/** `tTJSNI_Rect`. */
export class RectNI extends NativeInstanceBase {
  #a = new Int32Array(4);
  #address = 0;

  constructor(private readonly memory: TvpMemory) {
    super();
  }

  override construct(args: readonly Variant[]): number {
    if (args.length === 1) {
      const clo = asObjectClosure(args[0]!);
      if (!clo.object) return TJS_E_INVALIDPARAM;
      const src = getNativeInstance<RectNI>(clo.object, RECT_CLASS_ID);
      if (!src) return TJS_E_INVALIDPARAM;
      this.#a.set(src.#a);
    } else if (args.length === 4) {
      for (let i = 0; i < 4; i++) this.#a[i] = i32(args[i]!);
    }
    return TJS_S_OK;
  }

  override invalidate(): void {
    if (this.#address) {
      const copy = Int32Array.from(this.#a);
      this.memory.free(this.#address, 16);
      this.#address = 0;
      this.#a = copy;
    }
  }

  get rect(): TvpRect {
    const a = this.#a;
    return new TvpRect(a[0]!, a[1]!, a[2]!, a[3]!);
  }

  set rect(r: TvpRect) {
    this.#a[0] = r.left;
    this.#a[1] = r.top;
    this.#a[2] = r.right;
    this.#a[3] = r.bottom;
  }

  get array(): Int32Array {
    return this.#a;
  }

  /** The address of `left, top, right, bottom` (`Rect.array`). */
  nativeArray(): number {
    if (!this.#address) {
      this.#address = this.memory.allocate(16, 'Rect');
      const view = new Int32Array(this.memory.memory.buffer, this.#address, 4);
      view.set(this.#a);
      this.#a = view;
    }
    return this.#address;
  }
}

export function createRectClass(memory: TvpMemory): NativeClass {
  const cls = new NativeClass('Rect', () => new RectNI(memory));
  const b = new Binder<RectNI>(cls);
  const other = (v: Variant): RectNI | null | undefined => {
    const clo = asObjectClosure(v);
    if (!clo.object) return undefined;
    return getNativeInstance<RectNI>(clo.object, RECT_CLASS_ID);
  };
  const withOther =
    (op: (self: TvpRect, o: TvpRect, ni: RectNI) => boolean) =>
    (ni: RectNI, args: readonly Variant[], result: {set(v: Variant): void} | null) => {
      const o = other(args[0]!);
      if (o === undefined) return TJS_S_OK;
      if (!o) return TJS_E_INVALIDPARAM;
      const ret = op(ni.rect, o.rect, ni);
      result?.set(int(ret ? 1 : 0));
      return TJS_S_OK;
    };
  cls.emptyFinalize();
  cls.constructorMethod((_result, args, objthis) => {
    const r = constructNativeInstance(cls, args, objthis);
    return typeof r === 'number' ? r : TJS_S_OK;
  });
  b.method('isEmpty', 0, (ni, _a, result) => void result?.set(int(ni.rect.isEmpty() ? 1 : 0)));
  b.method('setSize', 2, (ni, args) => {
    const r = ni.rect;
    r.setSize(i32(args[0]!), i32(args[1]!));
    ni.rect = r;
  });
  b.method('setOffset', 2, (ni, args) => {
    const r = ni.rect;
    r.setOffsets(i32(args[0]!), i32(args[1]!));
    ni.rect = r;
  });
  b.method('addOffset', 2, (ni, args) => {
    const r = ni.rect;
    r.addOffsets(i32(args[0]!), i32(args[1]!));
    ni.rect = r;
  });
  b.method('clear', 0, (ni) => void (ni.rect = new TvpRect()));
  b.method('set', 4, (ni, args) => {
    ni.rect = new TvpRect(i32(args[0]!), i32(args[1]!), i32(args[2]!), i32(args[3]!));
  });
  b.method(
    'clip',
    1,
    withOther((self, o, ni) => {
      const ret = intersectRect(self, self, o);
      ni.rect = self;
      return ret;
    }),
  );
  b.method(
    'union',
    1,
    withOther((self, o, ni) => {
      const ret = unionRect(self, self, o);
      ni.rect = self;
      return ret;
    }),
  );
  b.method(
    'intersects',
    1,
    withOther((self, o) => self.intersectsWith(o)),
  );
  b.method(
    'included',
    1,
    withOther((self, o) => self.includedIn(o)),
  );
  b.method('includedPos', 2, (ni, args, result) => {
    const r = ni.rect;
    const x = i32(args[0]!),
      y = i32(args[1]!);
    result?.set(int(r.left <= x && x < r.right && r.top <= y && y < r.bottom ? 1 : 0));
  });
  b.method(
    'equal',
    1,
    withOther((self, o) => self.equals(o)),
  );
  const edge = (i: number) =>
    b.prop(
      ['left', 'top', 'right', 'bottom'][i]!,
      (ni) => int(ni.array[i]!),
      (ni, v) => void (ni.array[i] = i32(v)),
    );
  b.prop(
    'width',
    (ni) => int(ni.rect.width),
    (ni, v) => void (ni.array[2] = (ni.array[0]! + i32(v)) | 0),
  );
  b.prop(
    'height',
    (ni) => int(ni.rect.height),
    (ni, v) => void (ni.array[3] = (ni.array[1]! + i32(v)) | 0),
  );
  for (let i = 0; i < 4; i++) edge(i);
  b.prop('nativeArray', (ni) => integer(BigInt(ni.nativeArray())));
  return cls;
}

/** `TVPCreateRectObject`: a new Rect (owned by the caller). */
export function createRectObject(cls: NativeClass, r: TvpRect): Dispatch {
  const out = {value: null as Dispatch | null};
  cls.createNew(0, null, out, [int(r.left), int(r.top), int(r.right), int(r.bottom)], cls);
  return out.value!;
}
