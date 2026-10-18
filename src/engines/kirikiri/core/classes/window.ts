/**
 * `Window` (krkrz `visual/WindowIntf.cpp` and the win32 members of
 * `visual/win32/WindowImpl.cpp`) and its default draw device class `BasicDrawDevice`
 * (`visual/win32/BasicDrawDevice.cpp`). Members are those of the reference build: no
 * `beginMove`, `setLayerPos`, `layerLeft`, `layerTop`, `innerSunken` or `showScrollBars`
 * (built without `USE_OBSOLETE_FUNCTIONS`).
 */
import {TjsError, throwTjsError} from '../../tjs2/runtime/errors.js';
import {
  TJS_E_BADPARAMCOUNT,
  TJS_E_INVALIDPARAM,
  TJS_E_NATIVECLASSCRASH,
  TJS_E_SUSPENDED,
  TJS_S_OK,
  type Dispatch,
} from '../../tjs2/runtime/interface.js';
import {
  NativeClass,
  NativeInstanceBase,
  constructNativeInstance,
} from '../../tjs2/runtime/native.js';
import {
  NULL_OBJECT,
  VOID,
  asObject,
  asObjectClosure,
  bool,
  int,
  integer,
  obj,
  real,
  str,
  type Variant,
} from '../../tjs2/runtime/variant.js';
import {invokeAction} from '../events.js';
import {TvpBasicDrawDevice} from '../visual/draw-device.js';
import {layerOf, type LayerNI} from '../visual/layer.js';
import type {TvpMemory} from '../visual/memory.js';
import {WindowNI, type TvpWindowContext, type TvpWindowList} from '../visual/window.js';
import type {TjsEngine} from '../../tjs2/runtime/engine.js';
import type {TvpLog} from '../log.js';
import {Binder, f64, flag, i32, opt, text} from './binding.js';

/** `tTJSNI_BasicDrawDevice`. */
export class BasicDrawDeviceNI extends NativeInstanceBase {
  device: TvpBasicDrawDevice | null;

  constructor(
    private readonly memory: TvpMemory,
    log: TvpLog,
    getCommandLine: (name: string) => string | null,
  ) {
    super();
    this.device = new TvpBasicDrawDevice(log, getCommandLine);
  }

  override invalidate(): void {
    if (this.device) {
      this.device.destruct();
      this.memory.releaseHandle(this.device);
      this.device = null;
    }
  }
}

export function createBasicDrawDeviceClass(
  memory: TvpMemory,
  log: TvpLog,
  getCommandLine: (name: string) => string | null,
): NativeClass {
  const cls = new NativeClass(
    'BasicDrawDevice',
    () => new BasicDrawDeviceNI(memory, log, getCommandLine),
  );
  const b = new Binder<BasicDrawDeviceNI>(cls);
  cls.emptyFinalize();
  cls.constructorMethod((_result, args, objthis) => {
    const r = constructNativeInstance(cls, args, objthis);
    return typeof r === 'number' ? r : TJS_S_OK;
  });
  b.method('recreate', 0, (ni) => ni.device?.recreate());
  b.prop('interface', (ni) => integer(BigInt(ni.device ? memory.handleOf(ni.device) : 0)));
  return cls;
}

function ownerOf(l: LayerNI | null): Variant {
  return l && l.owner ? obj(l.owner, l.owner) : NULL_OBJECT;
}

export function createWindowClass(
  engine: TjsEngine,
  ctx: TvpWindowContext,
  list: TvpWindowList,
  memory: TvpMemory,
): NativeClass {
  const cls = new NativeClass('Window', () => new WindowNI(ctx, list));
  const b = new Binder<WindowNI>(cls);
  const suspender = engine.suspender;
  cls.emptyFinalize();
  cls.constructorMethod((_result, args, objthis) => {
    const r = constructNativeInstance(cls, args, objthis);
    return typeof r === 'number' ? r : TJS_S_OK;
  });

  b.method('close', 0, (ni) => ni.close());
  b.method('bringToFront', 0, (ni) => ni.bringToFront());
  b.method('update', 0, (ni, a) => {
    // As natively, the type is read from the first argument when two are given.
    const type = a.length >= 2 && a[1]!.type !== 0 ? i32(a[0]!) : 0;
    return ni.update(type);
  });
  b.method('showModal', 0, () => {
    throw new TjsError('Window.showModal: modal windows are not available');
  });
  b.method('setMaskRegion', 0, () => {});
  b.method('removeMaskRegion', 0, () => {});
  b.method('add', 1, (ni, a) => ni.add(asObjectClosure(a[0]!)));
  b.method('remove', 1, (ni, a) => ni.remove(asObjectClosure(a[0]!)));
  b.method('setSize', 2, (ni, a) => ni.setSize(i32(a[0]!), i32(a[1]!)));
  b.method('setMinSize', 2, (ni, a) => ni.setMinSize(i32(a[0]!), i32(a[1]!)));
  b.method('setMaxSize', 2, (ni, a) => ni.setMaxSize(i32(a[0]!), i32(a[1]!)));
  b.method('setPos', 2, (ni, a) => ni.setPosition(i32(a[0]!), i32(a[1]!)));
  b.method('setInnerSize', 2, (ni, a) => ni.setInnerSize(i32(a[0]!), i32(a[1]!)));
  b.method('setZoom', 2, (ni, a) => ni.setZoom(i32(a[0]!), i32(a[1]!)));
  b.method('hideMouseCursor', 0, (ni) => ni.hideMouseCursor());
  b.method('postInputEvent', 1, (ni, a) =>
    ni.postInputEvent(text(a[0]!), a.length >= 2 ? asObject(a[1]!) : null),
  );

  /** `TVP_ACTION_INVOKE_BEGIN(argnum, name, objthis)` … `END(objthis)`: the window's `action`. */
  const event = (name: string, argnum: number, members: string[]) =>
    cls.method(name, (result, args, objthis) => {
      if (args.length < argnum) return TJS_E_BADPARAMCOUNT;
      const padded =
        args.length >= members.length
          ? args
          : [...args, ...Array(members.length - args.length).fill(VOID)];
      const hr = invokeAction(
        engine,
        obj(objthis, objthis),
        'action',
        name,
        objthis,
        result,
        padded,
        members,
      );
      return hr === TJS_E_SUSPENDED ? hr : TJS_S_OK;
    });
  event('onResize', 0, []);
  event('onMouseEnter', 0, []);
  event('onMouseLeave', 0, []);
  event('onClick', 2, ['x', 'y']);
  event('onDoubleClick', 2, ['x', 'y']);
  event('onMouseDown', 4, ['x', 'y', 'button', 'shift']);
  event('onMouseUp', 4, ['x', 'y', 'button', 'shift']);
  event('onMouseMove', 3, ['x', 'y', 'shift']);
  event('onMouseWheel', 4, ['shift', 'delta', 'x', 'y']);
  event('onTouchDown', 5, ['x', 'y', 'cx', 'cy', 'id']);
  event('onTouchUp', 5, ['x', 'y', 'cx', 'cy', 'id']);
  event('onTouchMove', 5, ['x', 'y', 'cx', 'cy', 'id']);
  event('onTouchScaling', 5, ['startdistance', 'currentdistance', 'cx', 'cy', 'flag']);
  event('onTouchRotate', 6, ['startangle', 'currentangle', 'distance', 'cx', 'cy', 'flag']);
  event('onMultiTouch', 0, []);
  event('onKeyDown', 2, ['key', 'shift']);
  event('onKeyUp', 2, ['key', 'shift']);
  event('onKeyPress', 1, ['key']);
  event('onFileDrop', 1, ['files']);
  b.method('onCloseQuery', 0, (ni, a) => ni.onCloseQueryCalled(i32(a[0]!) !== 0));
  event('onPopupHide', 0, []);
  event('onActivate', 0, []);
  event('onDeactivate', 0, []);
  event('onDisplayRotate', 5, ['orientation', 'angle', 'bpp', 'width', 'height']);

  b.prop(
    'visible',
    (ni) => bool(ni.visible),
    (ni, v) => ni.setVisible(flag(v)),
  );
  b.prop(
    'caption',
    (ni) => str(ni.caption),
    (ni, v) => ni.setCaption(text(v)),
  );
  const intProp = (
    name: string,
    get: (ni: WindowNI) => number,
    set: (ni: WindowNI, n: number) => void,
  ) =>
    b.prop(
      name,
      (ni) => int(get(ni)),
      (ni, v) => set(ni, i32(v)),
    );
  intProp(
    'width',
    (ni) => ni.width,
    (ni, n) => ni.setWidth(n),
  );
  intProp(
    'height',
    (ni) => ni.height,
    (ni, n) => ni.setHeight(n),
  );
  intProp(
    'minWidth',
    (ni) => ni.minWidth,
    (ni, n) => ni.setMinWidth(n),
  );
  intProp(
    'minHeight',
    (ni) => ni.minHeight,
    (ni, n) => ni.setMinHeight(n),
  );
  intProp(
    'maxWidth',
    (ni) => ni.maxWidth,
    (ni, n) => ni.setMaxWidth(n),
  );
  intProp(
    'maxHeight',
    (ni) => ni.maxHeight,
    (ni, n) => ni.setMaxHeight(n),
  );
  intProp(
    'left',
    (ni) => ni.left,
    (ni, n) => ni.setLeft(n),
  );
  intProp(
    'top',
    (ni) => ni.top,
    (ni, n) => ni.setTop(n),
  );
  b.prop(
    'focusable',
    (ni) => int(ni.focusable ? 1 : 0),
    (ni, v) => ni.setFocusable(i32(v) !== 0),
  );
  intProp(
    'innerWidth',
    (ni) => ni.innerWidth,
    (ni, n) => ni.setInnerWidth(n),
  );
  intProp(
    'innerHeight',
    (ni) => ni.innerHeight,
    (ni, n) => ni.setInnerHeight(n),
  );
  intProp(
    'zoomNumer',
    (ni) => ni.zoomNumer,
    (ni, n) => ni.setZoomNumer(n),
  );
  intProp(
    'zoomDenom',
    (ni) => ni.zoomDenom,
    (ni, n) => ni.setZoomDenom(n),
  );
  intProp(
    'borderStyle',
    (ni) => ni.borderStyle,
    (ni, n) => ni.setBorderStyle(n),
  );
  b.prop(
    'stayOnTop',
    (ni) => bool(ni.stayOnTop),
    (ni, v) => ni.setStayOnTop(flag(v)),
  );
  b.prop(
    'useMouseKey',
    (ni) => bool(ni.useMouseKey),
    (ni, v) => ni.setUseMouseKey(flag(v)),
  );
  b.prop(
    'trapKey',
    (ni) => bool(ni.trapKey),
    (ni, v) => ni.setTrapKey(flag(v)),
  );
  intProp(
    'imeMode',
    (ni) => ni.defaultImeMode,
    (ni, n) => ni.setDefaultImeMode(n),
  );
  intProp(
    'mouseCursorState',
    (ni) => ni.mouseCursorState,
    (ni, n) => ni.setMouseCursorState(n),
  );
  b.prop(
    'fullScreen',
    (ni) => bool(ni.fullScreen),
    (ni, v) => ni.setFullScreen(i32(v) !== 0),
  );
  cls.property('mainWindow', {
    get: (result) => {
      const w = list.mainWindow;
      result.set(w && w.owner ? obj(w.owner, w.owner) : NULL_OBJECT);
      return TJS_S_OK;
    },
  });
  b.prop(
    'focusedLayer',
    (ni) => ownerOf(ni.drawDevice!.getFocusedLayer()),
    (ni, v) => {
      let to: LayerNI | null = null;
      if (v.type !== 0) {
        const clo = asObjectClosure(v);
        if (clo.object) {
          to = layerOf(clo.object);
          if (!to) throwTjsError('TVPSpecifyLayer');
        }
      }
      ni.drawDevice!.setFocusedLayer(to);
    },
  );
  b.prop('primaryLayer', (ni) => {
    const pri = ni.drawDevice!.getPrimaryLayer();
    if (!pri) throwTjsError('TVPWindowHasNoLayer');
    return ownerOf(pri);
  });
  b.prop(
    'waitVSync',
    (ni) => int(ni.waitVSync ? 1 : 0),
    (ni, v) => void (ni.waitVSync = i32(v) !== 0),
  );
  b.prop('layerTreeOwnerInterface', (ni) => integer(BigInt(memory.handleOf(ni.layerTreeOwner))));

  // --- win32 members (TVPCreateNativeClass_Window) ---------------------------------------------
  b.method('findFullScreenCandidates', 5, () => {});
  b.method('registerMessageReceiver', 3, (ni, a) =>
    ni.registerMessageReceiver(i32(a[0]!), i32(a[1]!), i32(a[2]!)),
  );
  b.method('getTouchPoint', 1, () => TJS_E_INVALIDPARAM);
  b.method('getTouchVelocity', 4, (_ni, _a, r) => void r?.set(int(0)));
  b.method('getMouseVelocity', 3, (_ni, _a, r) => void r?.set(int(0)));
  b.method('resetMouseVelocity', 0, () => {});
  b.prop('HWND', (ni) => integer(BigInt(ni.hwndHandle)));
  b.prop(
    'drawDevice',
    (ni) => ni.drawDeviceObject,
    (ni, v) => ni.setDrawDeviceObject(v),
  );
  b.prop(
    'touchScaleThreshold',
    (ni) => real(ni.touchScaleThreshold),
    (ni, v) => void (ni.touchScaleThreshold = f64(v)),
  );
  b.prop(
    'touchRotateThreshold',
    (ni) => real(ni.touchRotateThreshold),
    (ni, v) => void (ni.touchRotateThreshold = f64(v)),
  );
  b.prop('touchPointCount', () => int(0));
  intProp(
    'hintDelay',
    (ni) => ni.hintDelay,
    (ni, n) => ni.setHintDelay(n),
  );
  b.prop(
    'enableTouch',
    (ni) => int(ni.enableTouch ? 1 : 0),
    (ni, v) => ni.setEnableTouch(i32(v) !== 0),
  );
  b.prop('displayOrientation', () => int(0));
  b.prop('displayRotate', () => int(-1));
  return cls;
}
