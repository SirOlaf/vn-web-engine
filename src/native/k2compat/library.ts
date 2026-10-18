/**
 * `k2compat.dll` (SHA-256 `4a1fca7f…`, the binary part of krkrz Krkr2Compat, built with
 * SimpleBinder): two classes the compatibility scripts use.
 *
 * - `System.ModelessOwnerWindow`: a hidden tool window (class `K2CompatModelessDialogOwner`)
 *   that owns the modeless WIN32Dialog windows; `HWND`, `stayOnTop` (`WS_EX_TOPMOST` of the
 *   extended style, set without `SetWindowPos`), `show(visible)`.
 * - `Window.TouchMouse`: `new Window.TouchMouse(window)` registers a message receiver on the
 *   window that turns mouse messages Windows synthesised from touch (`GetMessageExtraInfo`
 *   signature `0xFF515700`) into `onTouchMouseMove/Down/Up/Click/DblClick` events of the
 *   TouchMouse object and consumes them. The default handlers post the matching window event
 *   (`onMouseMove` …) and feed the window's draw device, as an untouched mouse message does.
 *   `enabled` is mirrored into the window's `touchMouseEnabled` member; the constructor turns
 *   off the tablet press-and-hold gestures of the window (`MicrosoftTabletPenServiceProperty`).
 *
 * SimpleBinder registers each class as a member of its target object (flags
 * `TJS_MEMBERENSURE | TJS_IGNOREPROP`) with a hidden static `_*ClassStore*_` member.
 */
import type {NativeLibraryImplementation} from '../../platform/native-libraries.js';
import type {NativeProcess} from '../../platform/native-process.js';
import {VariantSlot} from '../../engines/kirikiri/tjs2/runtime/slot.js';
import {
  asBoolean,
  asInteger,
  asObject,
  bool,
  int,
  integer,
  obj,
} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import {NativeClassMethod} from '../../engines/kirikiri/tjs2/runtime/native.js';
import {TvpPluginObjects, E_FAIL} from '../../engines/kirikiri/tp-stub/ncbind.js';
import {FORMAT_MESSAGE_FROM_SYSTEM, KERNEL32, type Kernel32Exports} from '../kernel32/contract.js';
import {
  failed,
  NIT_METHOD,
  TJS_E_ACCESSDENYED,
  TJS_E_BADPARAMCOUNT,
  TJS_E_NATIVECLASSCRASH,
  TJS_HIDDENMEMBER,
  TJS_IGNOREPROP,
  TJS_MEMBERENSURE,
  TJS_NIS_GETINSTANCE,
  TJS_NIS_REGISTER,
  TJS_S_OK,
  TJS_STATICMEMBER,
  TVP_PLUGIN,
  TVP_WM_ATTACH,
  TVP_WM_DETACH,
  WRM_REGISTER,
  WRM_UNREGISTER,
  type Dispatch,
  type NativeClassObject,
  type NativeInstance,
  type Out,
  type TvpDrawDeviceInput,
  type TvpFunctionExporter,
  type TvpPluginExports,
  type TvpWindowMessageReceiver,
  type Variant,
} from '../tvp-plugin/contract.js';
import {NativeClassProperty} from '../../engines/kirikiri/tjs2/runtime/native.js';
import {USER32, type User32Exports} from '../user32/contract.js';

const SHA256 = '4a1fca7fe7365227da1a85fa0b47c21aaee8f5ebebbcd6191868dc6b514424f2';
const EXE_INSTANCE = 0x00400000;
const CW_USEDEFAULT = 0x80000000 | 0;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_TOPMOST = 0x08;
const GWL_EXSTYLE = -20;
const OWNER_STYLE = 0x90ca0000 | 0;
const OWNER_CLASS = 'K2CompatModelessDialogOwner';
const TABLET_PROPERTY = 'MicrosoftTabletPenServiceProperty';
const MI_WP_SIGNATURE = 0xff515700;
const SW_HIDE = 0;
const SW_SHOWNOACTIVATE = 4;
const SW_MINIMIZE = 6;
const SW_SHOWNA = 8;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_LBUTTONDBLCLK = 0x0203;
const MK_SHIFT = 0x0004;
const MK_CONTROL = 0x0008;
const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const VK_MBUTTON = 0x04;
const VK_MENU = 0x12;
const SS_SHIFT = 0x01;
const SS_ALT = 0x02;
const SS_CTRL = 0x04;
const SS_LEFT = 0x08;
const SS_RIGHT = 0x10;
const SS_MIDDLE = 0x20;
const TVP_EPT_IMMEDIATE = 0x02;
const TVP_EPT_DISCARDABLE = 0x10;

interface K2Services {
  readonly ex: TvpFunctionExporter;
  readonly user32: User32Exports;
  readonly kernel32: Kernel32Exports;
  readonly process: NativeProcess;
  readonly objects: TvpPluginObjects;
}

function throwLastError(s: K2Services): never {
  const k = s.kernel32;
  return s.ex.TVPThrowExceptionMessage(
    k.FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM, k.GetLastError(), 0x400) ?? '',
  );
}

/** `ModelessOwnerWindow`. */
class ModelessOwnerWindow {
  hwnd: number;
  constructor(private readonly s: K2Services) {
    const u = s.user32;
    if (!u.GetClassInfoExW(EXE_INSTANCE, OWNER_CLASS)) {
      const icon = u.LoadIconW(EXE_INSTANCE, 107);
      const atom = u.RegisterClassExW({
        style: 0x200,
        wndProc: (h, m, w, l) => u.DefWindowProcW(h, m, w, l),
        clsExtra: 0,
        wndExtra: 0,
        instance: EXE_INSTANCE,
        icon,
        cursor: 0,
        background: 0,
        menuName: null,
        className: OWNER_CLASS,
        iconSmall: u.LoadIconW(EXE_INSTANCE, 107),
      });
      if (!atom) throwLastError(s);
    }
    this.hwnd = u.CreateWindowExW(
      WS_EX_TOOLWINDOW,
      OWNER_CLASS,
      '',
      OWNER_STYLE,
      CW_USEDEFAULT,
      CW_USEDEFAULT,
      0,
      0,
      0,
      0,
      EXE_INSTANCE,
      0,
    );
  }
  dispose(): void {
    if (this.hwnd) this.s.user32.DestroyWindow(this.hwnd);
    this.hwnd = 0;
  }
  show(visible: boolean): void {
    const u = this.s.user32;
    if (visible) u.ShowWindow(this.hwnd, SW_SHOWNA);
    u.ShowWindow(this.hwnd, visible ? SW_SHOWNOACTIVATE : SW_MINIMIZE);
    if (!visible) u.ShowWindow(this.hwnd, SW_HIDE);
  }
}

/** `WindowTouchMouse`. */
class WindowTouchMouse {
  hwnd = 0;
  readonly atom: number;
  enabled = true;
  pressed = false;
  doubleClicked = false;
  readonly address: number;
  readonly receiver: TvpWindowMessageReceiver;

  constructor(
    private readonly s: K2Services,
    /** The TouchMouse object (source and target of the touch events). */
    readonly self: Dispatch,
    readonly window: Dispatch,
  ) {
    this.address = s.process.memory.allocate(0x18, 'WindowTouchMouse');
    this.receiver = (userdata, message) => (userdata ? this.#receive(message) : false);
    this.atom = s.kernel32.GlobalAddAtomW(TABLET_PROPERTY);
    this.#register(true);
    const hwnd = new VariantSlot();
    if (!failed(window.propGet(0, 'HWND', hwnd, window))) {
      this.hwnd = Number(BigInt.asUintN(32, asInteger(hwnd.value)));
      if (this.hwnd) {
        const v = s.user32.GetPropW(this.hwnd, TABLET_PROPERTY);
        s.user32.SetPropW(this.hwnd, TABLET_PROPERTY, v & 0xfffeffe6);
      }
    }
    hwnd.clear();
    const enabled = new VariantSlot();
    if (!failed(self.propGet(TJS_IGNOREPROP, 'enabled', enabled, self)))
      window.propSet(TJS_MEMBERENSURE, 'touchMouseEnabled', enabled.value, window);
    enabled.clear();
  }

  dispose(): void {
    const s = this.s;
    if (this.window.isValid(0, null, this.window) === 1) {
      if (this.hwnd) {
        const v = s.user32.GetPropW(this.hwnd, TABLET_PROPERTY);
        s.user32.SetPropW(this.hwnd, TABLET_PROPERTY, v | 0x10019);
      }
      this.#register(false);
      this.window.deleteMember(TJS_IGNOREPROP, 'touchMouseEnabled', this.window);
    }
    s.kernel32.GlobalDeleteAtom(this.atom);
    s.process.memory.free(this.address, 0x18);
  }

  /** `window.registerMessageReceiver(mode, proc, this)`. */
  #register(register: boolean): boolean {
    const s = this.s;
    const proc = s.process.code.pointerOf(this.receiver);
    const hr = this.window.funcCall(
      0,
      'registerMessageReceiver',
      null,
      [
        int(register ? WRM_REGISTER : WRM_UNREGISTER),
        integer(BigInt(proc)),
        integer(BigInt(this.address)),
      ],
      this.window,
    );
    return !failed(hr);
  }

  /** The shift state of a mouse message (`wParam` keys and the async key state). */
  #shift(wParam: number): number {
    const ex = this.s.ex;
    let r = 0;
    if (wParam & MK_SHIFT) r = SS_SHIFT;
    if (wParam & MK_CONTROL) r |= SS_CTRL;
    if (ex.TVPGetAsyncKeyState(VK_MENU, true)) r |= SS_ALT;
    if (ex.TVPGetAsyncKeyState(VK_LBUTTON, true)) r |= SS_LEFT;
    if (ex.TVPGetAsyncKeyState(VK_RBUTTON, true)) r |= SS_RIGHT;
    if (ex.TVPGetAsyncKeyState(VK_MBUTTON, true)) r |= SS_MIDDLE;
    return r;
  }

  #post(name: string, flags: number, args: number[]): void {
    this.s.ex.TVPPostEvent(
      this.self,
      this.self,
      name,
      0,
      flags,
      args.map((a) => int(a)),
    );
  }

  /** The message receiver: `tTVPWindowMessage` {Msg, WParam, LParam, Result}. */
  #receive(message: number): boolean {
    const s = this.s;
    const dv = new DataView(s.process.memory.u8.buffer);
    const msg = dv.getUint32(message, true);
    const wParam = dv.getUint32(message + 4, true);
    const lParam = dv.getUint32(message + 8, true);
    if (msg > TVP_WM_DETACH) {
      if (msg === TVP_WM_ATTACH) this.hwnd = lParam;
      return false;
    }
    if (msg === TVP_WM_DETACH) {
      this.hwnd = 0;
      return false;
    }
    const touch = (s.user32.GetMessageExtraInfo() & 0xffffff00) >>> 0 === MI_WP_SIGNATURE;
    const x = (lParam << 16) >> 16;
    const y = lParam >> 16;
    if (msg === WM_MOUSEMOVE) {
      if (!touch) return false;
      this.#post('onTouchMouseMove', TVP_EPT_DISCARDABLE, [x, y, this.#shift(wParam)]);
    } else if (msg >= WM_LBUTTONDOWN && msg <= WM_LBUTTONDBLCLK) {
      if (!touch) return false;
      const shift = this.#shift(wParam);
      if (!this.enabled && (msg !== WM_LBUTTONUP || !this.pressed)) return false;
      if (msg === WM_LBUTTONDOWN) {
        this.pressed = true;
        this.doubleClicked = false;
        this.#post('onTouchMouseDown', 0, [x, y, 0, shift]);
      } else if (msg === WM_LBUTTONUP) {
        this.pressed = false;
        if (!this.doubleClicked) this.#post('onTouchMouseClick', 0, [x, y]);
        this.doubleClicked = false;
        this.#post('onTouchMouseUp', 0, [x, y, 0, shift]);
      } else {
        this.pressed = true;
        this.doubleClicked = true;
        this.#post('onTouchMouseDblClick', 0, [x, y]);
        this.#post('onTouchMouseDown', 0, [x, y, 0, shift]);
      }
    } else return false;
    dv.setInt32(message + 12, s.user32.DefWindowProcW(this.hwnd, msg, wParam, lParam), true);
    return true;
  }

  /**
   * The default handlers: post the window's mouse event and pass the input to the window's draw
   * device (`window.drawDevice.interface`). Returns the draw device, or null.
   */
  forward(name: string, flags: number, args: readonly Variant[]): TvpDrawDeviceInput | null {
    const s = this.s;
    const w = this.window;
    s.ex.TVPPostEvent(w, w, name, 0, flags, args);
    const dd = new VariantSlot();
    let device: TvpDrawDeviceInput | null = null;
    if (!failed(w.propGet(0, 'drawDevice', dd, w))) {
      const o = asObject(dd.value);
      dd.clear();
      if (o) {
        const iface = new VariantSlot();
        if (!failed(o.propGet(0, 'interface', iface, o)))
          device = s.process.objects.objectAt<TvpDrawDeviceInput>(Number(asInteger(iface.value)));
        iface.clear();
      }
    }
    dd.clear();
    return device;
  }
}

/** SimpleBinder's native instance holder. */
class InstanceHolder implements NativeInstance {
  instance: {dispose(): void} | null = null;
  construct(): number {
    return TJS_S_OK;
  }
  invalidate(): void {
    this.instance?.dispose();
    this.instance = null;
  }
  destruct(): void {
    this.invalidate();
  }
}

/** A SimpleBinder function or property object (a plugin object). */
class StoreMethod extends NativeClassMethod {
  constructor(
    private readonly objects: TvpPluginObjects,
    process: ConstructorParameters<typeof NativeClassMethod>[0],
  ) {
    super(process);
    objects.count++;
  }
  protected override destruct(): void {
    this.objects.count--;
    super.destruct();
  }
}
class StoreProperty extends NativeClassProperty {
  constructor(
    private readonly objects: TvpPluginObjects,
    get: ConstructorParameters<typeof NativeClassProperty>[0],
    set: ConstructorParameters<typeof NativeClassProperty>[1],
  ) {
    super(get, set);
    objects.count++;
  }
  protected override destruct(): void {
    this.objects.count--;
    super.destruct();
  }
}

interface ClassEntry<T extends {dispose(): void}> {
  readonly name: string;
  /** The path of the object that receives the class (`System`, `Window`). */
  readonly target: string;
  readonly minArgs: number;
  create(args: readonly Variant[], objthis: Dispatch): T;
  members(r: Members<T>): void;
}

interface Members<T> {
  method(
    name: string,
    body: (self: T, args: readonly Variant[], objthis: Dispatch) => number,
  ): void;
  property(
    name: string,
    get: ((self: T) => Variant) | null,
    set: ((self: T, v: Variant) => void) | null,
  ): void;
}

class K2CompatPlugin implements TvpPluginExports {
  readonly objects = new TvpPluginObjects();
  #linkedCount = 0;
  #s: K2Services | null = null;
  readonly #registered: {target: Dispatch; name: string}[] = [];

  constructor(
    private readonly make: (ex: TvpFunctionExporter, objects: TvpPluginObjects) => K2Services,
  ) {}

  /** `BindUtil` path resolution: dotted names from the global object. */
  #resolve(path: string): Dispatch | null {
    const ex = this.#s!.ex;
    let o: Dispatch = ex.TVPGetScriptDispatch();
    for (const part of path.split('.')) {
      if (!part) continue;
      const slot = new VariantSlot();
      const hr = o.propGet(0, part, slot, o);
      const next = hr >= 0 ? asObject(slot.value) : null;
      if (next) next.addRef();
      slot.clear();
      o.release();
      if (!next) return null;
      o = next;
    }
    return o;
  }

  #bind<T extends {dispose(): void}>(entry: ClassEntry<T>): boolean {
    const s = this.#s!;
    const ex = s.ex;
    const target = this.#resolve(entry.target);
    if (!target) return false;
    let id = -1;
    const cls: NativeClassObject = ex.TJSCreateNativeClassForPlugin(
      entry.name,
      () => new InstanceHolder(),
    );
    id = ex.TJSRegisterNativeClass(entry.name);
    ex.TJSNativeClassSetClassID(cls, id);
    const instance = (o: Dispatch | null): T | null => {
      if (!o) return null;
      const p: Out<NativeInstance | null> = {value: null};
      if (failed(o.nativeInstanceSupport(TJS_NIS_GETINSTANCE, id, p))) return null;
      return ((p.value as InstanceHolder | null)?.instance as T | null) ?? null;
    };
    // The class store: a hidden static member that keeps the binding.
    const store = new StoreMethod(s.objects, () => TJS_S_OK);
    cls.propSet(
      TJS_MEMBERENSURE | TJS_IGNOREPROP | TJS_HIDDENMEMBER | TJS_STATICMEMBER,
      '_*ClassStore*_',
      obj(store),
      cls,
    );
    store.release();
    ex.TJSNativeClassRegisterNCM(
      cls,
      'finalize',
      ex.TJSCreateNativeClassMethod(() => TJS_S_OK),
      entry.name,
      NIT_METHOD,
      0,
    );
    ex.TJSNativeClassRegisterNCM(
      cls,
      entry.name,
      ex.TJSCreateNativeClassConstructor((_result, args, objthis) => {
        if (args.length < entry.minArgs) return TJS_E_BADPARAMCOUNT;
        if (!objthis) return TJS_E_NATIVECLASSCRASH;
        const p: Out<NativeInstance | null> = {value: null};
        if (failed(objthis.nativeInstanceSupport(TJS_NIS_GETINSTANCE, id, p)) || !p.value) {
          p.value = new InstanceHolder();
          objthis.nativeInstanceSupport(TJS_NIS_REGISTER, id, p);
        }
        (p.value as InstanceHolder).instance = entry.create(args, objthis);
        return TJS_S_OK;
      }),
      entry.name,
      NIT_METHOD,
      0,
    );
    const flags = TJS_MEMBERENSURE | TJS_IGNOREPROP;
    entry.members({
      method: (name, body) => {
        const m = new StoreMethod(s.objects, (result, args, objthis) => {
          const self = instance(objthis);
          if (!self) return TJS_E_NATIVECLASSCRASH;
          return body(self, args, objthis);
        });
        cls.propSet(flags, name, obj(m), cls);
        m.release();
      },
      property: (name, get, set) => {
        const p = new StoreProperty(
          s.objects,
          get
            ? (result, objthis) => {
                const self = instance(objthis);
                if (!self) return TJS_E_NATIVECLASSCRASH;
                result.set(get(self));
                return TJS_S_OK;
              }
            : () => TJS_E_ACCESSDENYED,
          set
            ? (value, objthis) => {
                const self = instance(objthis);
                if (!self) return TJS_E_NATIVECLASSCRASH;
                set(self, value);
                return TJS_S_OK;
              }
            : () => TJS_E_ACCESSDENYED,
        );
        cls.propSet(flags, name, obj(p), cls);
        p.release();
      },
    });
    const hr = target.propSet(flags, entry.name, obj(cls), target);
    cls.release();
    if (failed(hr)) {
      target.release();
      return false;
    }
    this.#registered.push({target, name: entry.name});
    return true;
  }

  v2Link(exporter: TvpFunctionExporter): number {
    const s = (this.#s = this.make(exporter, this.objects));
    const ex = s.ex;
    const owner: ClassEntry<ModelessOwnerWindow> = {
      name: 'ModelessOwnerWindow',
      target: 'System',
      minArgs: 0,
      create: () => new ModelessOwnerWindow(s),
      members: (r) => {
        r.property(
          'stayOnTop',
          (w) => bool((s.user32.GetWindowLongW(w.hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) !== 0),
          (w, v) => {
            const ex2 = s.user32.GetWindowLongW(w.hwnd, GWL_EXSTYLE) & ~WS_EX_TOPMOST;
            s.user32.SetWindowLongW(w.hwnd, GWL_EXSTYLE, asBoolean(v) ? ex2 | WS_EX_TOPMOST : ex2);
          },
        );
        r.method('show', (w, args) => {
          if (args.length < 1) return TJS_E_BADPARAMCOUNT;
          w.show(asBoolean(args[0]!));
          return TJS_S_OK;
        });
        r.property('HWND', (w) => int(w.hwnd), null);
      },
    };
    const touch: ClassEntry<WindowTouchMouse> = {
      name: 'TouchMouse',
      target: 'Window',
      minArgs: 1,
      create: (args, objthis) => {
        const window = asObject(args[0]!);
        if (!window)
          return ex.TVPThrowExceptionMessage(ex.TJSGetMessageMapMessage('TJSNullAccess'));
        return new WindowTouchMouse(s, objthis, window);
      },
      members: (r) => {
        const xy = (args: readonly Variant[], n: number) =>
          args.slice(0, n).map((a) => Number(BigInt.asIntN(32, asInteger(a))));
        r.method('onTouchMouseDblClick', (t, args) => {
          if (args.length < 2) return TJS_S_OK;
          const [x, y] = xy(args, 2);
          t.forward('onDoubleClick', TVP_EPT_IMMEDIATE, args.slice(0, 2))?.onDoubleClick(x!, y!);
          return TJS_S_OK;
        });
        r.method('onTouchMouseClick', (t, args) => {
          if (args.length < 2) return TJS_S_OK;
          const [x, y] = xy(args, 2);
          t.forward('onClick', TVP_EPT_IMMEDIATE, args.slice(0, 2))?.onClick(x!, y!);
          return TJS_S_OK;
        });
        r.method('onTouchMouseUp', (t, args) => {
          if (args.length < 4) return TJS_S_OK;
          const [x, y, mb, shift] = xy(args, 4);
          t.forward('onMouseUp', TVP_EPT_IMMEDIATE, args.slice(0, 4))?.onMouseUp(
            x!,
            y!,
            mb!,
            shift!,
          );
          return TJS_S_OK;
        });
        r.method('onTouchMouseDown', (t, args) => {
          if (args.length < 4) return TJS_S_OK;
          const [x, y, mb, shift] = xy(args, 4);
          t.forward('onMouseDown', TVP_EPT_IMMEDIATE, args.slice(0, 4))?.onMouseDown(
            x!,
            y!,
            mb!,
            shift!,
          );
          return TJS_S_OK;
        });
        r.method('onTouchMouseMove', (t, args) => {
          if (args.length < 3) return TJS_S_OK;
          const [x, y, shift] = xy(args, 3);
          t.forward(
            'onMouseMove',
            TVP_EPT_IMMEDIATE | TVP_EPT_DISCARDABLE,
            args.slice(0, 3),
          )?.onMouseMove(x!, y!, shift!);
          return TJS_S_OK;
        });
        r.property(
          'enabled',
          (t) => bool(t.enabled),
          (t, v) => {
            t.enabled = asBoolean(v);
          },
        );
      },
    };
    if (!this.#bind(owner) || !this.#bind(touch)) return E_FAIL;
    this.#linkedCount = this.objects.count;
    return TJS_S_OK;
  }

  v2Unlink(): number {
    if (this.objects.count > this.#linkedCount) return E_FAIL;
    for (const {target, name} of this.#registered.splice(0)) {
      target.deleteMember(0, name, target);
      target.release();
    }
    this.#s = null;
    return TJS_S_OK;
  }
}

export const K2COMPAT: NativeLibraryImplementation<TvpPluginExports> = {
  contract: TVP_PLUGIN,
  identities: [{kind: 'image', sha256: SHA256}],
  imports: [
    {contract: KERNEL32, binding: 'static'},
    {contract: USER32, binding: 'static'},
  ],
  link(context) {
    const user32 = context.staticImport(USER32);
    const kernel32 = context.staticImport(KERNEL32);
    const process: NativeProcess = context.process;
    return {
      exports: new K2CompatPlugin((ex, objects) => ({ex, user32, kernel32, process, objects})),
    };
  },
};
