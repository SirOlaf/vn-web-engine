/**
 * `Layer` (krkrz `visual/LayerIntf.cpp`, `tTJSNC_Layer`): the members of the reference build
 * (the 2021 sources' members less `copy9Patch` and `releaseTouchCapture`).
 */
import {throwTjsError, tjsMessage} from '../../tjs2/runtime/errors.js';
import {
  TJS_E_BADPARAMCOUNT,
  TJS_E_INVALIDPARAM,
  TJS_E_NATIVECLASSCRASH,
  TJS_E_SUSPENDED,
  TJS_S_OK,
  type Dispatch,
} from '../../tjs2/runtime/interface.js';
import {NativeClass, constructNativeInstance} from '../../tjs2/runtime/native.js';
import {
  NULL_OBJECT,
  VOID,
  asObjectClosure,
  bool,
  int,
  integer,
  obj,
  str,
  type Variant,
} from '../../tjs2/runtime/variant.js';
import {invokeAction} from '../events.js';
import type {TvpBaseBitmap} from '../visual/base-bitmap.js';
import {TvpRect} from '../visual/complex-rect.js';
import {LayerNI, layerOf, type TvpVisualContext} from '../visual/layer.js';
import {TVP_clNone, omAlpha, omAuto} from '../visual/layer-types.js';
import {bitmapOf} from './bitmap.js';
import {Binder, f64, flag, i32, opt, text, u32} from './binding.js';

function ownerOf(l: LayerNI | null): Variant {
  return l && l.owner ? obj(l.owner, l.owner) : NULL_OBJECT;
}

/** A layer argument (`TVPSpecifyLayer` when it is not a layer). */
function layerArg(v: Variant): LayerNI {
  const clo = asObjectClosure(v);
  const l = clo.object ? layerOf(clo.object) : null;
  if (!l) throwTjsError('TVPSpecifyLayer');
  return l;
}

interface SourceImage {
  main: TvpBaseBitmap | null;
  province: TvpBaseBitmap | null;
  automode: number;
}

/** A Layer or Bitmap source argument; null objects give no image. */
function sourceArg(v: Variant): SourceImage {
  const clo = asObjectClosure(v);
  const out: SourceImage = {main: null, province: null, automode: omAlpha};
  if (!clo.object) return out;
  const lay = layerOf(clo.object);
  if (lay) {
    out.main = lay.getMainImage();
    out.province = lay.getProvinceImage();
    out.automode = lay.getOperationModeFromType();
  }
  if (!out.main) {
    const bmp = bitmapOf(clo.object);
    if (bmp) out.main = out.province = bmp.bitmap;
  }
  return out;
}

function rectArgs(a: readonly Variant[], i: number): TvpRect {
  const r = new TvpRect(i32(a[i]!), i32(a[i + 1]!), i32(a[i + 2]!), i32(a[i + 3]!));
  r.right = (r.right + r.left) | 0;
  r.bottom = (r.bottom + r.top) | 0;
  return r;
}

export function createLayerClass(ctx: TvpVisualContext): NativeClass {
  const cls = new NativeClass('Layer', () => new LayerNI(ctx));
  const b = new Binder<LayerNI>(cls);
  const suspender = ctx.engine.suspender;
  cls.emptyFinalize();
  cls.constructorMethod((_result, args, objthis) => {
    const r = constructNativeInstance(cls, args, objthis);
    return typeof r === 'number' ? r : TJS_S_OK;
  });

  // --- methods -------------------------------------------------------------------------------
  b.method('moveBefore', 1, (ni, a) => ni.moveBefore(layerArg(a[0]!)));
  b.method('moveBehind', 1, (ni, a) => ni.moveBehind(layerArg(a[0]!)));
  b.method('bringToBack', 0, (ni) => ni.bringToBack());
  b.method('bringToFront', 0, (ni) => ni.bringToFront());
  b.method('saveLayerImage', 1, (ni, a) => ni.saveLayerImage(text(a[0]!), opt(a, 1, text, 'bmp')));
  b.method('loadImages', 1, (ni, a, r) => {
    const key = opt(a, 1, u32, TVP_clNone);
    const finish = (meta: Dispatch | null) => {
      try {
        r?.set(meta ? obj(meta, meta) : obj(null));
      } finally {
        meta?.release();
      }
      return TJS_S_OK;
    };
    const meta = ni.loadImages(text(a[0]!), key);
    return meta instanceof Promise ? suspender.suspend(meta, finish) : finish(meta);
  });
  b.method('loadProvinceImage', 1, (ni, a) => {
    const p = ni.loadProvinceImage(text(a[0]!));
    return p instanceof Promise ? suspender.suspend(p, () => TJS_S_OK) : TJS_S_OK;
  });
  b.method(
    'getMainPixel',
    2,
    (ni, a, r) => void r?.set(integer(BigInt(ni.getMainPixel(i32(a[0]!), i32(a[1]!))))),
  );
  b.method('setMainPixel', 3, (ni, a) => ni.setMainPixel(i32(a[0]!), i32(a[1]!), i32(a[2]!) >>> 0));
  b.method(
    'getMaskPixel',
    2,
    (ni, a, r) => void r?.set(int(ni.getMaskPixel(i32(a[0]!), i32(a[1]!)))),
  );
  b.method('setMaskPixel', 3, (ni, a) => ni.setMaskPixel(i32(a[0]!), i32(a[1]!), i32(a[2]!)));
  b.method(
    'getProvincePixel',
    2,
    (ni, a, r) => void r?.set(int(ni.getProvincePixel(i32(a[0]!), i32(a[1]!)))),
  );
  b.method('setProvincePixel', 3, (ni, a) =>
    ni.setProvincePixel(i32(a[0]!), i32(a[1]!), i32(a[2]!)),
  );
  b.method('getLayerAt', 2, (ni, a, r) => {
    const lay = ni.getMostFrontChildAt(
      i32(a[0]!),
      i32(a[1]!),
      opt(a, 2, flag, false),
      opt(a, 3, flag, false),
    );
    r?.set(ownerOf(lay));
  });
  b.method('setPos', 2, (ni, a) => {
    if (a.length === 4 && a[2]!.type !== 0 && a[3]!.type !== 0) ni.setBounds(rectArgs(a, 0));
    else ni.setPosition(i32(a[0]!), i32(a[1]!));
  });
  b.method('setSize', 2, (ni, a) => ni.setSize(i32(a[0]!) >>> 0, i32(a[1]!) >>> 0));
  b.method('setSizeToImageSize', 0, (ni) => ni.setSize(ni.getImageWidth(), ni.getImageHeight()));
  b.method('setImagePos', 2, (ni, a) => ni.setImagePosition(i32(a[0]!), i32(a[1]!)));
  b.method('setImageSize', 2, (ni, a) => ni.setImageSize(i32(a[0]!) >>> 0, i32(a[1]!) >>> 0));
  b.method('independMainImage', 0, (ni, a) => ni.independMainImage(opt(a, 0, flag, true)));
  b.method('independProvinceImage', 0, (ni, a) => ni.independProvinceImage(opt(a, 0, flag, true)));
  b.method('setClip', 0, (ni, a) => {
    if (a.length === 0) ni.resetClip();
    else {
      if (a.length < 4) return TJS_E_BADPARAMCOUNT;
      ni.setClip(i32(a[0]!), i32(a[1]!), i32(a[2]!), i32(a[3]!));
    }
  });
  b.method('fillRect', 5, (ni, a) => ni.fillRect(rectArgs(a, 0), u32(a[4]!)));
  b.method('colorRect', 5, (ni, a) =>
    ni.colorRect(rectArgs(a, 0), u32(a[4]!), opt(a, 5, i32, 255)),
  );
  b.method('drawText', 4, (ni, a) =>
    ni.drawText(
      i32(a[0]!),
      i32(a[1]!),
      text(a[2]!),
      u32(a[3]!),
      opt(a, 4, i32, 255),
      opt(a, 5, flag, true),
      opt(a, 6, i32, 0),
      opt(a, 7, u32, 0),
      opt(a, 8, i32, 0),
      opt(a, 9, i32, 0),
      opt(a, 10, i32, 0),
    ),
  );
  b.method('drawGlyph', 4, (ni) => ni.drawGlyph());
  b.method('piledCopy', 7, (ni, a) => {
    const src = layerArg(a[2]!);
    ni.piledCopy(i32(a[0]!), i32(a[1]!), src, rectArgs(a, 3));
  });
  b.method('copyRect', 7, (ni, a) => {
    const s = sourceArg(a[2]!);
    if (!s.main && !s.province) throwTjsError('TVPSpecifyLayerOrBitmap');
    ni.copyRect(i32(a[0]!), i32(a[1]!), s.main, s.province, rectArgs(a, 3));
  });
  b.method('operateRect', 7, (ni, a) => {
    const s = sourceArg(a[2]!);
    if (!s.main) throwTjsError('TVPSpecifyLayerOrBitmap');
    let mode = opt(a, 7, i32, omAuto);
    if (a.length >= 10 && a[9]!.type !== 0)
      ctx.log.add(
        tjsMessage('TVPHoldDestinationAlphaParameterIsNowDeprecated', 'Layer.operateRect', '10'),
      );
    if (mode === omAuto) mode = s.automode;
    ni.operateRect(i32(a[0]!), i32(a[1]!), s.main, rectArgs(a, 3), mode, opt(a, 8, i32, 255));
  });
  b.method('stretchCopy', 9, (ni, a) => {
    if (!sourceArg(a[4]!).main) throwTjsError('TVPSpecifyLayerOrBitmap');
    ni.stretchCopy();
  });
  b.method('operateStretch', 9, (ni, a) => {
    if (!sourceArg(a[4]!).main) throwTjsError('TVPSpecifyLayerOrBitmap');
    ni.operateStretch();
  });
  b.method('affineCopy', 12, (ni, a) => {
    if (!sourceArg(a[0]!).main) throwTjsError('TVPSpecifyLayerOrBitmap');
    ni.affineCopy();
  });
  b.method('operateAffine', 12, (ni, a) => {
    if (!sourceArg(a[0]!).main) throwTjsError('TVPSpecifyLayerOrBitmap');
    ni.operateAffine();
  });
  b.method('doBoxBlur', 0, (ni) => ni.doBoxBlur());
  b.method('adjustGamma', 0, (ni, a) =>
    ni.adjustGamma({
      RGamma: opt(a, 0, f64, 1),
      RFloor: opt(a, 1, i32, 0),
      RCeil: opt(a, 2, i32, 255),
      GGamma: opt(a, 3, f64, 1),
      GFloor: opt(a, 4, i32, 0),
      GCeil: opt(a, 5, i32, 255),
      BGamma: opt(a, 6, f64, 1),
      BFloor: opt(a, 7, i32, 0),
      BCeil: opt(a, 8, i32, 255),
    }),
  );
  b.method('doGrayScale', 0, (ni) => ni.doGrayScale());
  b.method('flipLR', 0, (ni) => ni.lrFlip());
  b.method('flipUD', 0, (ni) => ni.udFlip());
  b.method('convertType', 1, (ni, a) => ni.convertLayerType(i32(a[0]!)));
  b.method('update', 0, (ni, a) => {
    if (a.length < 1) ni.updateByScript();
    else {
      if (a.length < 4) return TJS_E_BADPARAMCOUNT;
      ni.updateByScript(rectArgs(a, 0));
    }
  });
  b.method('setCursorPos', 2, (ni, a) => ni.setCursorPos(i32(a[0]!), i32(a[1]!)));
  b.method('releaseCapture', 0, (ni) => ni.releaseCapture());
  b.method('focus', 0, (ni, a, r) => {
    const direction = a.length >= 1 ? flag(a[0]!) : true;
    const ok = ni.setFocus(direction);
    r?.set(int(ok ? 1 : 0));
  });
  b.method('focusPrev', 0, (ni, _a, r) => void r?.set(ownerOf(ni.focusPrev())));
  b.method('focusNext', 0, (ni, _a, r) => void r?.set(ownerOf(ni.focusNext())));
  b.method('setMode', 0, (ni) => ni.setMode());
  b.method('removeMode', 0, (ni) => ni.removeMode());
  b.method('setAttentionPos', 2, (ni, a) => ni.setAttentionPoint(i32(a[0]!), i32(a[1]!)));
  b.method('beginTransition', 1, (ni, a) => {
    const name = text(a[0]!);
    const withchildren = opt(a, 1, flag, true);
    let transsrc: LayerNI | null = null;
    if (a.length >= 3 && a[2]!.type !== 0) {
      const clo = asObjectClosure(a[2]!);
      if (clo.object) {
        transsrc = layerOf(clo.object);
        if (!transsrc) throwTjsError('TVPSpecifyLayer');
      }
    }
    if (!transsrc) throwTjsError('TVPSpecifyLayer');
    const options = a.length >= 4 && a[3]!.type !== 0 ? asObjectClosure(a[3]!) : NULL_OBJECT;
    ni.startTransition(name, withchildren, transsrc, options);
  });
  b.method('stopTransition', 0, (ni) => ni.stopTransition());
  b.method('assignImages', 1, (ni, a) => ni.assignImages(layerArg(a[0]!)));
  b.method('dump', 0, (ni) => ni.dumpStructure());
  b.method('copyToBitmapFromMainImage', 1, (ni, a) => {
    const clo = asObjectClosure(a[0]!);
    if (!clo.object) return TJS_S_OK;
    const dst = bitmapOf(clo.object);
    if (!dst) return TJS_E_INVALIDPARAM;
    if (!ni.mainImage) throwTjsError('TVPNotDrawableLayerType');
    dst.copyFrom(ni.mainImage);
  });
  b.method('copyFromBitmapToMainImage', 1, (ni, a) => {
    const clo = asObjectClosure(a[0]!);
    if (!clo.object) return TJS_S_OK;
    const src = bitmapOf(clo.object);
    if (!src) return TJS_E_INVALIDPARAM;
    ni.assignMainImageWithUpdate(src.bitmap);
  });

  // --- events --------------------------------------------------------------------------------
  /**
   * `TVP_ACTION_INVOKE_BEGIN(argnum, name)` … `END`: calls the action owner's `action` with an
   * event object (its result is ignored), then runs `after` (the default behaviour).
   */
  const event = (
    name: string,
    argnum: number,
    members: string[],
    after?: (ni: LayerNI, a: readonly Variant[]) => number,
  ) =>
    cls.method(name, (result, args, objthis) => {
      const ni = b.ni(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      const then = () => (after ? after(ni, args) : TJS_S_OK);
      if (ni.actionOwner.object) {
        if (args.length < argnum) return TJS_E_BADPARAMCOUNT;
        const padded =
          args.length >= members.length
            ? args
            : [...args, ...Array(members.length - args.length).fill(VOID)];
        const hr = invokeAction(
          ctx.engine,
          ni.actionOwner,
          'action',
          name,
          objthis,
          result,
          padded,
          members,
        );
        if (hr === TJS_E_SUSPENDED)
          return suspender.defer((inner) => {
            if ('error' in inner) throw inner.error;
            return then();
          });
      }
      return then();
    });
  b.method('onHitTest', 3, (ni, a) => ni.setHitTestWork(flag(a[2]!)));
  event('onClick', 2, ['x', 'y']);
  event('onDoubleClick', 2, ['x', 'y']);
  event('onMouseDown', 4, ['x', 'y', 'button', 'shift']);
  event('onMouseUp', 4, ['x', 'y', 'button', 'shift']);
  event('onMouseMove', 3, ['x', 'y', 'shift']);
  event('onMouseEnter', 0, []);
  event('onMouseLeave', 0, []);
  event('onTouchDown', 5, ['x', 'y', 'cx', 'cy', 'id']);
  event('onTouchUp', 5, ['x', 'y', 'cx', 'cy', 'id']);
  event('onTouchMove', 5, ['x', 'y', 'cx', 'cy', 'id']);
  event('onTouchScaling', 5, ['startdistance', 'currentdistance', 'cx', 'cy', 'flag']);
  event('onTouchRotate', 6, ['startangle', 'currentangle', 'distance', 'cx', 'cy', 'flag']);
  event('onMultiTouch', 0, []);
  event('onBlur', 1, ['focused']);
  event('onFocus', 1, ['blurred', 'direction']);
  event('onNodeEnabled', 0, []);
  event('onNodeDisabled', 0, []);
  event('onKeyDown', 3, ['key', 'shift', 'process'], (ni, a) =>
    a.length < 3 || flag(a[2]!) ? ni.defaultKeyDown(i32(a[0]!), i32(a[1]!)) : TJS_S_OK,
  );
  event('onKeyUp', 3, ['key', 'shift', 'process'], (ni, a) =>
    a.length < 3 || flag(a[2]!) ? ni.defaultKeyUp(i32(a[0]!), i32(a[1]!)) : TJS_S_OK,
  );
  event('onKeyPress', 2, ['key', 'process'], (ni, a) => {
    if (!(a.length < 2 || flag(a[1]!))) return TJS_S_OK;
    const p = text(a[0]!);
    return ni.defaultKeyPress(p.length ? p.charCodeAt(0) : 0);
  });
  event('onMouseWheel', 4, ['shift', 'delta', 'x', 'y']);
  const setFocusWork = (ni: LayerNI, a: readonly Variant[]): number => {
    const v = a[0]!;
    if (v.type !== 0) {
      const clo = asObjectClosure(v);
      if (clo.object) {
        const src = layerOf(clo.object);
        if (!src) throwTjsError('TVPSpecifyLayer');
        ni.focusWork = src;
      } else ni.focusWork = null;
    } else ni.focusWork = null;
    return TJS_S_OK;
  };
  event('onSearchPrevFocusable', 1, ['layer'], setFocusWork);
  event('onSearchNextFocusable', 1, ['layer'], setFocusWork);
  event('onBeforeFocus', 3, ['layer', 'blurred', 'direction'], setFocusWork);
  event('onPaint', 0, []);
  event('onTransitionCompleted', 2, ['dest', 'src']);

  // --- properties ----------------------------------------------------------------------------
  b.prop(
    'parent',
    (ni) => ownerOf(ni.parent),
    (ni, v) => {
      const clo = asObjectClosure(v);
      let parent: LayerNI | null = null;
      if (clo.object) {
        parent = layerOf(clo.object);
        if (!parent) throwTjsError('TVPSpecifyLayer');
      }
      ni.setParent(parent);
    },
  );
  b.prop('children', (ni) => {
    const d = ni.getChildrenArrayObject();
    return obj(d, d);
  });
  b.prop(
    'order',
    (ni) => int(ni.getOrderIndex()),
    (ni, v) => ni.setOrderIndex(i32(v)),
  );
  b.prop(
    'absolute',
    (ni) => int(ni.getAbsoluteOrderIndex()),
    (ni, v) => ni.setAbsoluteOrderIndex(i32(v)),
  );
  b.prop(
    'absoluteOrderMode',
    (ni) => int(ni.absoluteOrderMode ? 1 : 0),
    (ni, v) => ni.setAbsoluteOrderMode(flag(v)),
  );
  b.prop(
    'visible',
    (ni) => bool(ni.visible),
    (ni, v) => ni.setVisible(flag(v)),
  );
  b.prop(
    'cached',
    (ni) => bool(ni.cached),
    (ni, v) => ni.setCached(flag(v)),
  );
  b.prop('nodeVisible', (ni) => bool(ni.getNodeVisible()));
  b.prop(
    'opacity',
    (ni) => int(ni.opacity),
    (ni, v) => ni.setOpacity(i32(v)),
  );
  b.prop('window', (ni) => {
    const lto = ni.layerTreeOwner;
    const d = lto ? lto.getOwnerNoAddRef() : null;
    return obj(d, d);
  });
  b.prop('isPrimary', (ni) => int(ni.isPrimary ? 1 : 0));
  b.prop(
    'left',
    (ni) => int(ni.left),
    (ni, v) => ni.setLeft(i32(v)),
  );
  b.prop(
    'top',
    (ni) => int(ni.top),
    (ni, v) => ni.setTop(i32(v)),
  );
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
  b.prop(
    'imageLeft',
    (ni) => integer(BigInt(ni.getImageLeft())),
    (ni, v) => ni.setImageLeft(i32(v)),
  );
  b.prop(
    'imageTop',
    (ni) => integer(BigInt(ni.getImageTop())),
    (ni, v) => ni.setImageTop(i32(v)),
  );
  b.prop(
    'imageWidth',
    (ni) => integer(BigInt(ni.getImageWidth())),
    (ni, v) => ni.setImageWidth(u32(v)),
  );
  b.prop(
    'imageHeight',
    (ni) => integer(BigInt(ni.getImageHeight())),
    (ni, v) => ni.setImageHeight(u32(v)),
  );
  b.prop(
    'type',
    (ni) => int(ni.type),
    (ni, v) => ni.setType(i32(v)),
  );
  b.prop(
    'face',
    (ni) => int(ni.face),
    (ni, v) => ni.setFace(i32(v)),
  );
  b.prop(
    'holdAlpha',
    (ni) => int(ni.holdAlpha ? 1 : 0),
    (ni, v) => void (ni.holdAlpha = i32(v) !== 0),
  );
  const clipProp = (
    name: string,
    get: (r: TvpRect) => number,
    set: (ni: LayerNI, n: number) => void,
  ) =>
    b.prop(
      name,
      (ni) => integer(BigInt(get(ni.clipRect))),
      (ni, v) => set(ni, i32(v)),
    );
  clipProp(
    'clipLeft',
    (r) => r.left,
    (ni, n) => ni.setClipLeft(n),
  );
  clipProp(
    'clipTop',
    (r) => r.top,
    (ni, n) => ni.setClipTop(n),
  );
  clipProp(
    'clipWidth',
    (r) => r.width,
    (ni, n) => ni.setClipWidth(n),
  );
  clipProp(
    'clipHeight',
    (r) => r.height,
    (ni, n) => ni.setClipHeight(n),
  );
  b.prop(
    'imageModified',
    (ni) => int(ni.imageModified ? 1 : 0),
    (ni, v) => void (ni.imageModified = flag(v)),
  );
  b.prop(
    'hitType',
    (ni) => int(ni.hitType),
    (ni, v) => void (ni.hitType = i32(v)),
  );
  b.prop(
    'hitThreshold',
    (ni) => int(ni.hitThreshold),
    (ni, v) => void (ni.hitThreshold = i32(v)),
  );
  b.prop(
    'cursor',
    (ni) => int(ni.cursor),
    (ni, v) => {
      if (v.type === 2) ni.setCursorByStorage(text(v));
      else ni.setCursorByNumber(i32(v));
    },
  );
  b.prop(
    'cursorX',
    (ni) => int(ni.getCursorX()),
    (ni, v) => ni.setCursorX(i32(v)),
  );
  b.prop(
    'cursorY',
    (ni) => int(ni.getCursorY()),
    (ni, v) => ni.setCursorY(i32(v)),
  );
  b.prop(
    'hint',
    (ni) => str(ni.hint),
    (ni, v) => ni.setHint(text(v)),
  );
  b.prop(
    'showParentHint',
    (ni) => bool(ni.showParentHint),
    (ni, v) => void (ni.showParentHint = flag(v)),
  );
  b.prop(
    'ignoreHintSensing',
    (ni) => bool(ni.ignoreHintSensing),
    (ni, v) => void (ni.ignoreHintSensing = flag(v)),
  );
  b.prop(
    'focusable',
    (ni) => bool(ni.focusable),
    (ni, v) => ni.setFocusable(flag(v)),
  );
  b.prop('prevFocusable', (ni) => ownerOf(ni.getPrevFocusable()));
  b.prop('nextFocusable', (ni) => ownerOf(ni.getNextFocusable()));
  b.prop(
    'joinFocusChain',
    (ni) => bool(ni.joinFocusChain),
    (ni, v) => void (ni.joinFocusChain = flag(v)),
  );
  b.prop('nodeFocusable', (ni) => bool(ni.getNodeFocusable()));
  b.prop('focused', (ni) => int(ni.focused ? 1 : 0));
  b.prop(
    'enabled',
    (ni) => bool(ni.enabled),
    (ni, v) => ni.setEnabled(flag(v)),
  );
  b.prop('nodeEnabled', (ni) => bool(ni.getNodeEnabled()));
  b.prop(
    'attentionLeft',
    (ni) => int(ni.attentionLeft),
    (ni, v) => ni.setAttentionLeft(i32(v)),
  );
  b.prop(
    'attentionTop',
    (ni) => int(ni.attentionTop),
    (ni, v) => ni.setAttentionTop(i32(v)),
  );
  b.prop(
    'useAttention',
    (ni) => bool(ni.useAttention),
    (ni, v) => ni.setUseAttention(flag(v)),
  );
  b.prop(
    'imeMode',
    (ni) => int(ni.imeMode),
    (ni, v) => ni.setImeMode(i32(v)),
  );
  b.prop(
    'callOnPaint',
    (ni) => bool(ni.callOnPaint),
    (ni, v) => void (ni.callOnPaint = flag(v)),
  );
  b.prop('font', (ni) => {
    const d = ni.getFontObject();
    return obj(d, d);
  });
  b.prop(
    'name',
    (ni) => str(ni.name),
    (ni, v) => void (ni.name = text(v)),
  );
  b.prop(
    'neutralColor',
    (ni) => integer(BigInt(ni.neutralColor >>> 0)),
    (ni, v) => void (ni.neutralColor = u32(v)),
  );
  b.prop(
    'hasImage',
    (ni) => int(ni.hasImage ? 1 : 0),
    (ni, v) => ni.setHasImage(flag(v)),
  );
  b.prop('mainImageBuffer', (ni) => integer(BigInt(ni.getMainImagePixelBuffer())));
  b.prop('mainImageBufferForWrite', (ni) => integer(BigInt(ni.getMainImagePixelBufferForWrite())));
  b.prop('mainImageBufferPitch', (ni) => int(ni.getMainImagePixelBufferPitch()));
  b.prop('provinceImageBuffer', (ni) => integer(BigInt(ni.getProvinceImagePixelBuffer())));
  b.prop('provinceImageBufferForWrite', (ni) =>
    integer(BigInt(ni.getProvinceImagePixelBufferForWrite())),
  );
  b.prop('provinceImageBufferPitch', (ni) => int(ni.getProvinceImagePixelBufferPitch()));
  return cls;
}
