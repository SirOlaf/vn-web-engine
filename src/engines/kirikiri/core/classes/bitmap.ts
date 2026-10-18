/**
 * `Bitmap` (krkrz `visual/BitmapIntf.cpp`): a free-standing layer bitmap.
 */
import {TjsError, throwTjsError} from '../../tjs2/runtime/errors.js';
import {
  TJS_E_INVALIDPARAM,
  TJS_E_NATIVECLASSCRASH,
  TJS_S_OK,
  type Dispatch,
} from '../../tjs2/runtime/interface.js';
import {
  NativeClass,
  NativeInstanceBase,
  constructNativeInstance,
  getNativeInstance,
} from '../../tjs2/runtime/native.js';
import {asObjectClosure, int, integer, obj, type Variant} from '../../tjs2/runtime/variant.js';
import {invokeAction} from '../events.js';
import {TvpBaseBitmap} from '../visual/base-bitmap.js';
import {BITMAP_CLASS_ID, glmNormal, layerOf, type TvpVisualContext} from '../visual/layer.js';
import {TVP_clNone} from '../visual/layer-types.js';
import {Binder, flag, i32, opt, text, u32} from './binding.js';

/** `tTJSNI_Bitmap`. */
export class BitmapNI extends NativeInstanceBase {
  owner: Dispatch | null = null;
  bitmap: TvpBaseBitmap | null = null;
  loading = false;

  constructor(private readonly ctx: TvpVisualContext) {
    super();
  }

  /** `(file[, colorkey])` loads; `(width, height[, bpp])` creates; none copies the initial bitmap. */
  constructWith(args: readonly Variant[], owner: Dispatch): number | Promise<number> {
    this.owner = owner;
    if (args.length > 0) {
      if (args[0]!.type === 2) {
        const colorkey = args.length > 1 ? u32(args[1]!) : TVP_clNone;
        const r = this.load(text(args[0]!), colorkey);
        if (r instanceof Promise)
          return r.then((meta) => {
            meta?.release();
            return TJS_S_OK;
          });
        r?.release();
      } else if (args.length > 1) {
        const w = u32(args[0]!),
          h = u32(args[1]!);
        const bpp = args.length > 2 ? i32(args[2]!) : 32;
        this.bitmap = new TvpBaseBitmap(this.ctx.fonts, this.ctx.memory, w, h, bpp);
      }
    } else {
      this.bitmap = TvpBaseBitmap.from(this.ctx.temp.initial);
    }
    return TJS_S_OK;
  }

  override invalidate(): void {
    if (this.bitmap) {
      this.bitmap.dispose();
      this.bitmap = null;
    }
  }

  #check(): TvpBaseBitmap {
    if (this.loading) throwTjsError('TVPCurrentlyAsyncLoadBitmap');
    if (!this.bitmap) throwTjsError('TVPNotDrawableLayerType');
    return this.bitmap;
  }

  getPixel(x: number, y: number): number {
    return this.ctx.colors.fromActual(this.#check().getPoint(x, y) & 0xffffff) >>> 0;
  }

  setPixel(x: number, y: number, color: number): void {
    this.#check().setPointMain(x, y, this.ctx.colors.toActual(color));
  }

  getMaskPixel(x: number, y: number): number {
    return (this.#check().getPoint(x, y) & 0xff000000) >>> 24;
  }

  setMaskPixel(x: number, y: number, mask: number): void {
    this.#check().setPointMask(x, y, mask);
  }

  independ(copy: boolean): void {
    if (this.loading) throwTjsError('TVPCurrentlyAsyncLoadBitmap');
    if (!this.bitmap) return;
    if (copy) this.bitmap.independ();
    else this.bitmap.independNoCopy();
  }

  /** `Load`: the meta information (owned by the caller); a promise while the storage is read. */
  load(name: string, colorkey: number): Dispatch | null | Promise<Dispatch | null> {
    if (this.loading) throwTjsError('TVPCurrentlyAsyncLoadBitmap');
    if (!this.bitmap) this.bitmap = TvpBaseBitmap.from(this.ctx.temp.initial);
    const loader = this.ctx.graphics;
    if (!loader) throw new TjsError('The graphics loader is not available');
    const r = loader.load(this.bitmap, name, colorkey, 0, 0, glmNormal);
    return r instanceof Promise ? r.then((g) => g.metainfo) : r.metainfo;
  }

  setSize(width: number, height: number, keepImage = true): void {
    const bmp = this.bitmap;
    if (!bmp) throwTjsError('TVPNotDrawableLayerType');
    if (width === bmp.width && height === bmp.height) return;
    if (!width || !height) throwTjsError('TVPCannotCreateEmptyLayerImage');
    if (keepImage) bmp.setSizeWithFill(width, height, 0);
    else bmp.setSize(width, height, false);
  }

  get width(): number {
    return this.#check().width;
  }

  setWidth(w: number): void {
    const bmp = this.#check();
    if (w !== bmp.width) bmp.setSizeWithFill(w, bmp.height, 0);
  }

  get height(): number {
    return this.#check().height;
  }

  setHeight(h: number): void {
    const bmp = this.#check();
    if (h !== bmp.height) bmp.setSizeWithFill(bmp.width, h, 0);
  }

  get pixelBuffer(): number {
    return this.bitmap ? this.bitmap.scanLine(0) : 0;
  }

  get pixelBufferForWrite(): number {
    return this.bitmap ? this.bitmap.scanLineForWrite(0) : 0;
  }

  get pixelBufferPitch(): number {
    return this.bitmap ? this.bitmap.pitchBytes : 0;
  }

  /** `CopyFrom`: shares the source's bits. */
  copyFrom(src: TvpBaseBitmap): void {
    this.bitmap!.assign(src);
  }
}

export function bitmapOf(object: Dispatch | null): BitmapNI | null {
  return getNativeInstance<BitmapNI>(object, BITMAP_CLASS_ID);
}

export function createBitmapClass(ctx: TvpVisualContext): NativeClass {
  const cls = new NativeClass('Bitmap', () => new BitmapNI(ctx));
  const b = new Binder<BitmapNI>(cls);
  const suspender = ctx.engine.suspender;
  cls.emptyFinalize();
  cls.constructorMethod((_result, args, objthis) => {
    if (!objthis) return TJS_E_NATIVECLASSCRASH;
    const ni = cls.instanceOf<BitmapNI>(objthis);
    if (!ni) return TJS_E_NATIVECLASSCRASH;
    const r = ni.constructWith(args, objthis);
    return r instanceof Promise ? suspender.suspend(r, (code) => code) : r;
  });
  b.method(
    'getPixel',
    2,
    (ni, a, r) => void r?.set(integer(BigInt(ni.getPixel(i32(a[0]!), i32(a[1]!))))),
  );
  b.method('setPixel', 3, (ni, a) => ni.setPixel(i32(a[0]!), i32(a[1]!), i32(a[2]!) >>> 0));
  b.method(
    'getMaskPixel',
    2,
    (ni, a, r) => void r?.set(int(ni.getMaskPixel(i32(a[0]!), i32(a[1]!)))),
  );
  b.method('setMaskPixel', 3, (ni, a) => ni.setMaskPixel(i32(a[0]!), i32(a[1]!), i32(a[2]!)));
  b.method('independ', 0, (ni, a) => ni.independ(opt(a, 0, flag, true)));
  b.method('setSize', 2, (ni, a) => {
    if (ni.loading) throwTjsError('TVPCurrentlyAsyncLoadBitmap');
    ni.setSize(i32(a[0]!) >>> 0, i32(a[1]!) >>> 0);
  });
  b.method('copyFrom', 1, (ni, a) => {
    if (ni.loading) throwTjsError('TVPCurrentlyAsyncLoadBitmap');
    const clo = asObjectClosure(a[0]!);
    if (!clo.object) return TJS_S_OK;
    const src = bitmapOf(clo.object);
    if (!src) return TJS_E_INVALIDPARAM;
    ni.copyFrom(src.bitmap!);
  });
  b.method('save', 1, (ni) => {
    if (ni.loading) throwTjsError('TVPCurrentlyAsyncLoadBitmap');
    if (!ni.bitmap) throwTjsError('TVPNotDrawableLayerType');
    throw new TjsError('Bitmap.save: image encoders are not available');
  });
  b.method('load', 1, (ni, a, r) => {
    const key = opt(a, 1, u32, TVP_clNone);
    const finish = (meta: Dispatch | null) => {
      r?.set(meta ? obj(meta, meta) : obj(null));
      meta?.release();
      return TJS_S_OK;
    };
    const meta = ni.load(text(a[0]!), key);
    return meta instanceof Promise ? suspender.suspend(meta, finish) : finish(meta);
  });
  b.method('loadAsync', 1, (ni) => {
    if (ni.loading) throwTjsError('TVPCurrentlyAsyncLoadBitmap');
    throw new TjsError('Bitmap.loadAsync: asynchronous loading is not available');
  });
  b.method('onLoaded', 4, (_ni, a, r, objthis) => {
    // As natively, the event takes the action owner of a Layer instance.
    const lay = layerOf(objthis);
    if (!lay) return TJS_E_NATIVECLASSCRASH;
    if (!lay.actionOwner.object) return TJS_S_OK;
    return invokeAction(ctx.engine, lay.actionOwner, 'action', 'onLoaded', objthis, r, a, [
      'meta',
      'async',
      'error',
      'message',
    ]);
  });
  b.prop(
    'width',
    (ni) => integer(BigInt(ni.width)),
    (ni, v) => ni.setWidth(u32(v)),
  );
  b.prop(
    'height',
    (ni) => integer(BigInt(ni.height)),
    (ni, v) => ni.setHeight(u32(v)),
  );
  b.prop('buffer', (ni) => {
    if (ni.loading) throwTjsError('TVPCurrentlyAsyncLoadBitmap');
    return integer(BigInt(ni.pixelBuffer));
  });
  b.prop('bufferForWrite', (ni) => {
    if (ni.loading) throwTjsError('TVPCurrentlyAsyncLoadBitmap');
    return integer(BigInt(ni.pixelBufferForWrite));
  });
  b.prop('bufferPitch', (ni) => {
    if (ni.loading) throwTjsError('TVPCurrentlyAsyncLoadBitmap');
    return int(ni.pixelBufferPitch);
  });
  b.prop('loading', (ni) => int(ni.loading ? 1 : 0));
  return cls;
}
