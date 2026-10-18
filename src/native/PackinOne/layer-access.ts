/**
 * Layer access shared by PackinOne's image functions: `ObjectCache` and `layerExBase` of
 * layerExDraw (2008), which read a layer's image through the property objects of the `Layer`
 * class (so script overrides of these properties do not apply), and the C runtime's `rand`.
 */
import {VariantSlot} from '../../engines/kirikiri/tjs2/runtime/slot.js';
import {
  asInteger,
  asObject,
  int,
  type Variant,
} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import {
  failed,
  TJS_IGNOREPROP,
  type Dispatch,
  type TvpFunctionExporter,
} from '../tvp-plugin/contract.js';

/** `ObjectCache`: a member object of `Layer`, applied to one layer. */
export class LayerMember {
  readonly #member: Dispatch;
  constructor(
    private readonly ex: TvpFunctionExporter,
    private readonly layer: Dispatch,
    private readonly name: string,
  ) {
    const cls = new VariantSlot();
    ex.TVPExecuteExpression('Layer', null, cls);
    const layerClass = asObject(cls.value);
    const v = new VariantSlot();
    if (!layerClass || failed(layerClass.propGet(TJS_IGNOREPROP, name, v, layerClass))) {
      cls.clear();
      ex.TVPThrowExceptionMessage('FAILED: get property object :%1', name);
    }
    this.#member = asObject(v.value)!;
    this.#member.addRef();
    v.clear();
    cls.clear();
  }
  get(): Variant {
    const v = new VariantSlot();
    if (failed(this.#member.propGet(0, null, v, this.layer)))
      this.ex.TVPThrowExceptionMessage('FAILED: get property value :%1', this.name);
    const r = v.value;
    v.clear();
    return r;
  }
  int(): number {
    return Number(BigInt.asIntN(32, asInteger(this.get())));
  }
  call(args: readonly Variant[]): void {
    if (failed(this.#member.funcCall(0, null, null, args, this.layer)))
      this.ex.TVPThrowExceptionMessage('FAILED: function call :%1', this.name);
  }
  release(): void {
    this.#member.release();
  }
}

/** `layerExBase` with clipping (layerExDraw's `layerExBase.hpp`). */
export class LayerExBase {
  readonly #width: LayerMember;
  readonly #height: LayerMember;
  readonly #buffer: LayerMember;
  readonly #pitch: LayerMember;
  readonly #update: LayerMember;
  readonly #clipLeft: LayerMember;
  readonly #clipTop: LayerMember;
  readonly #clipWidth: LayerMember;
  readonly #clipHeight: LayerMember;
  width = 0;
  height = 0;
  buffer = 0;
  pitch = 0;
  clipLeft = 0;
  clipTop = 0;
  clipWidth = 0;
  clipHeight = 0;

  constructor(
    ex: TvpFunctionExporter,
    readonly layer: Dispatch,
  ) {
    const m = (name: string) => new LayerMember(ex, layer, name);
    this.#width = m('imageWidth');
    this.#height = m('imageHeight');
    this.#buffer = m('mainImageBufferForWrite');
    this.#pitch = m('mainImageBufferPitch');
    this.#update = m('update');
    this.#clipLeft = m('clipLeft');
    this.#clipTop = m('clipTop');
    this.#clipWidth = m('clipWidth');
    this.#clipHeight = m('clipHeight');
  }

  /** `reset`: reads the image and clipping state before each call. */
  reset(): void {
    this.width = this.#width.int();
    this.height = this.#height.int();
    this.buffer = Number(BigInt.asUintN(32, asInteger(this.#buffer.get())));
    this.pitch = this.#pitch.int();
    this.clipLeft = this.#clipLeft.int();
    this.clipTop = this.#clipTop.int();
    this.clipWidth = this.#clipWidth.int();
    this.clipHeight = this.#clipHeight.int();
  }

  /** `redraw`: `update(clipLeft, clipTop, clipWidth, clipHeight)`. */
  redraw(): void {
    this.#update.call([
      this.#clipLeft.get(),
      this.#clipTop.get(),
      this.#clipWidth.get(),
      this.#clipHeight.get(),
    ]);
  }

  dispose(): void {
    for (const m of [
      this.#width,
      this.#height,
      this.#buffer,
      this.#pitch,
      this.#update,
      this.#clipLeft,
      this.#clipTop,
      this.#clipWidth,
      this.#clipHeight,
    ])
      m.release();
  }
}

/** The C runtime's `rand` (MSVC): `seed = seed * 214013 + 2531011`, bits 16–30. */
export class MsvcRand {
  #seed = 1;
  rand(): number {
    this.#seed = (Math.imul(this.#seed, 214013) + 2531011) | 0;
    return (this.#seed >>> 16) & 0x7fff;
  }
}

export const RAND_MAX = 0x7fff;

/** `update(l, t, w, h)` through the layer object (`ncbPropAccessor::FuncCall`). */
export function updateLayer(layer: Dispatch, l: number, t: number, w: number, h: number): void {
  layer.funcCall(0, 'update', null, [int(l), int(t), int(w), int(h)], layer);
}
