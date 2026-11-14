/**
 * `System` (krkrz `base/SystemIntf.cpp` and the win32 members of
 * `base/win32/SystemImpl.cpp`, `TVPCreateNativeClass_System`). The reference build registers
 * the members of both files except `exeBits` and `osBits`.
 */
import {throwTjsError} from '../../tjs2/runtime/errors.js';
import {
  TJS_E_BADPARAMCOUNT,
  TJS_E_SUSPENDED,
  TJS_MEMBERENSURE,
  TJS_S_OK,
} from '../../tjs2/runtime/interface.js';
import {NativeClass, paramExists} from '../../tjs2/runtime/native.js';
import {VariantSlot} from '../../tjs2/runtime/slot.js';
import type {Suspender} from '../../tjs2/runtime/suspension.js';
import {
  NULL_OBJECT,
  VOID,
  asBoolean,
  asInt32,
  asInteger,
  asObjectClosure,
  asString,
  int,
  integer,
  str,
  type Variant,
} from '../../tjs2/runtime/variant.js';
import {TVP_COMPACT_LEVEL_MAX, type TvpEventSystem} from '../events.js';

/** `GetVersionEx` as the executable sees it (`OSVERSIONINFOEX`). */
export interface WindowsVersionInfo {
  /** `VER_PLATFORM_WIN32s` 0, `_WINDOWS` 1, `_NT` 2. */
  readonly platformId: number;
  readonly major: number;
  readonly minor: number;
  readonly build: number;
  /** `VER_NT_WORKSTATION` 1. */
  readonly productType: number;
  /** `szCSDVersion` (service pack). */
  readonly csdVersion: string;
}

/**
 * `GetVersionEx` of an executable without a compatibility manifest on Windows 8.1 and later:
 * Windows 8 (6.2.9200).
 */
export const UNMANIFESTED_WINDOWS_VERSION: WindowsVersionInfo = {
  platformId: 2,
  major: 6,
  minor: 2,
  build: 9200,
  productType: 1,
  csdVersion: '',
};

/** Screen geometry (`tTVPScreen`): the primary monitor and its work area. */
export interface ScreenMetrics {
  readonly width: number;
  readonly height: number;
  readonly desktopLeft: number;
  readonly desktopTop: number;
  readonly desktopWidth: number;
  readonly desktopHeight: number;
}

/** Platform services behind `System`. Each decides how a native effect appears in the host. */
export interface KirikiriSystemPlatform {
  /** `MessageBox(owner, text, caption, MB_OK | MB_ICONINFORMATION)`. */
  informationBox(text: string, caption: string): Promise<void>;
  /** `ShellExecute(NULL, NULL, target, param, "", SW_SHOWNORMAL) > 32`. */
  shellExecute(target: string, parameters: string): boolean;
  /** `_wsystem(command)`. */
  system(command: string): number;
  /**
   * `GetAsyncKeyState(vk) & (current ? 0x8000 : 1)` after mouse-button swapping, or the
   * joypad state for `VK_PAD_*` (`TVPGetAsyncKeyState`).
   */
  asyncKeyState(vk: number, current: boolean): boolean;
  /**
   * `RegQueryValueEx` of `key\value` under a root: a DWORD (big-endian ones swapped) as a
   * number, `REG_SZ`/`REG_EXPAND_SZ` as a string, null when missing or of another type.
   */
  readRegValue(root: string, key: string, value: string): Promise<number | string | null>;
  /** `CreateMutex(NULL, TRUE, name)` followed by `GetLastError()`. */
  createMutex(name: string): number;
  /** `GetSysColor`. */
  sysColor(index: number): number;
  /** `TVPGetSupportTouchDevice` (`tdIntegratedTouch` …, `tdMouse`, `tdMouseWheel`). */
  touchDevice(): number;
  screen(): ScreenMetrics;
  /** `Application->SetTitle`: the taskbar caption. */
  setApplicationTitle(title: string): void;
  /** `TVPShowVersionForm`: shows the version information; resolves when closed. */
  showVersion(information: string): Promise<void>;
  /** `TVPGetProcessorNum`. */
  readonly processorCount: number;
  readonly version: WindowsVersionInfo;
}

/** The graphic cache settings `System` controls (`GraphicsLoaderIntf.cpp`). */
export interface GraphicCacheControl {
  limit(): bigint;
  setLimit(limit: bigint): void;
  clear(): void;
  /** `TVPTouchImages`: loads images into the cache up to a byte limit and a time limit. */
  touch(storages: readonly string[], limit: bigint, timeout: bigint): void;
}

/** What `System` uses of the core. */
export interface SystemServices {
  readonly events: TvpEventSystem;
  readonly suspender: Suspender;
  readonly platform: KirikiriSystemPlatform;
  readonly graphicCache: GraphicCacheControl;
  getArgument(name: string): string | null;
  setArgument(name: string, value: string): void;
  /** `TVPGetAppPath`. */
  appPath(): string;
  /** `TVPGetPersonalPath`, `TVPGetAppDataPath`, `TVPGetSavedGamesPath` (storage names). */
  personalPath(): string;
  appDataPath(): string;
  savedGamesPath(): string;
  /** `TVPDataPath`. */
  dataPath(): string;
  /** The executable's storage name. */
  exeName(): string;
  /** `TVPGetVersionString`, `TVPGetVersionInformation`. */
  versionString(): string;
  versionInformation(): string;
  /** `Application->GetTitle()` / `SetTitle()`. */
  title(): string;
  setTitle(title: string): void;
  /** `TVPGetTickCount`. */
  tickCount(): number;
  /** `TVPGetRandomBits128`. */
  randomBits128(): Uint8Array;
  /** `TJSAssignMessage`: true when the message id exists. */
  assignMessage(id: string, message: string): boolean;
  /** `TVPTerminateAsync`. */
  terminate(code: number): void;
  /** `TVPTerminateSync`: never returns. */
  exit(code: number): never;
  /** `TVPHeapDump`: logs the process heaps. */
  dumpHeap(): void;
  /** `TVPTerminateOnWindowClose`, `TVPTerminateOnNoWindowStartup`, `TVPDrawThreadNum`. */
  flags: {exitOnWindowClose: boolean; exitOnNoWindowStartup: boolean; drawThreadNum: number};
}

/** `TVPToActualColor`: system colours (high byte set) to `0xRRGGBB`. */
export function toActualColor(color: number, sysColor: (index: number) => number): number {
  color >>>= 0;
  if (color & 0xff000000) {
    // ColorToRGB: negative values are system colours, others pass; result is 0x00BBGGRR.
    const bgr = (color | 0) < 0 ? sysColor(color & 0xff) >>> 0 : color;
    return (((bgr & 0xff) << 16) + (bgr & 0xff00) + ((bgr & 0xff0000) >>> 16)) >>> 0;
  }
  return color;
}

/** `TVPGetOSName` of the reference build (`GetVersionEx`; no Windows 10 name). */
export function osName(v: WindowsVersionInfo): string {
  let name: string;
  if (v.platformId === 0) name = 'Win32s';
  else if (v.platformId === 1) {
    const build = v.build & 0xffff;
    name = build === 95 ? 'Windows 95' : build === 1998 ? 'Windows 98' : 'Win9x';
  } else if (v.platformId !== 2) name = 'Unknown';
  else {
    const workstation = v.productType === 1;
    const nt5 = ['Windows 2000', 'Windows XP', 'Windows Server 2003'];
    const nt6 = [
      ['Windows Vista', 'Windows Server 2008'],
      ['Windows 7', 'Windows Server 2008 R2'],
      ['Windows 8', 'Windows Server 2012'],
      ['Windows 8.1', 'Windows Server 2012 R2'],
    ];
    name =
      (v.major === 5 ? nt5[v.minor] : undefined) ??
      (v.major === 6 ? nt6[v.minor]?.[workstation ? 0 : 1] : undefined) ??
      'Windows NT';
  }
  return `${name} ${v.major}.${v.minor}.${v.build & 0xfff} ` + v.csdVersion;
}

/** `TVPCreateAppLock`: false when the mutex existed. */
export function createAppLock(platform: KirikiriSystemPlatform, name: string): boolean {
  return platform.createMutex(name) === 0;
}

const REG_ROOTS = [
  'HKEY_CLASSES_ROOT',
  'HKEY_CURRENT_CONFIG',
  'HKEY_CURRENT_USER',
  'HKEY_LOCAL_MACHINE',
  'HKEY_USERS',
  'HKEY_PERFORMANCE_DATA',
  'HKEY_DYN_DATA',
];

/** `TVPReadRegValue`: splits `[ROOT\]key\value` (root defaults to `HKEY_CURRENT_USER`). */
export function splitRegistryPath(path: string): {root: string; key: string; value: string} {
  let root = 'HKEY_CURRENT_USER';
  let p = path;
  const found = REG_ROOTS.find((r) => path.startsWith(r));
  if (found) {
    root = found;
    p = path.slice(found.length);
  }
  if (p[0] === '\\') p = p.slice(1);
  const slash = p.lastIndexOf('\\');
  return {root, key: slash < 0 ? '' : p.slice(0, slash), value: p.slice(slash + 1)};
}

export function createSystemClass(services: SystemServices): NativeClass {
  const {events, platform} = services;
  const cls = new NativeClass('System', () => throwTjsError('TVPCannotCreateInstance'));
  const done = (result: VariantSlot | null, v: Variant) => (result?.set(v), TJS_S_OK);
  const getter =
    (f: () => Variant) =>
    (result: VariantSlot): number => (result.set(f()), TJS_S_OK);

  cls.emptyFinalize();
  cls.constructorMethod(() => TJS_S_OK);

  // --- SystemIntf.cpp ---------------------------------------------------------------------
  cls.staticMethod('terminate', (_result, args) => {
    services.terminate(args.length > 0 ? asInt32(args[0]!) : 0);
    return TJS_S_OK;
  });
  cls.staticMethod('exit', (_result, args) =>
    services.exit(args.length > 0 ? asInt32(args[0]!) : 0),
  );
  cls.staticMethod('addContinuousHandler', (_result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    events.addContinuousHandler(asObjectClosure(args[0]!));
    return TJS_S_OK;
  });
  cls.staticMethod('removeContinuousHandler', (_result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    events.removeContinuousHandler(asObjectClosure(args[0]!));
    return TJS_S_OK;
  });
  cls.staticMethod('toActualColor', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    if (!result) return TJS_S_OK;
    const color = toActualColor(asInt32(args[0]!), (i) => platform.sysColor(i));
    return done(result, int(color | 0));
  });
  cls.staticMethod('clearGraphicCache', () => (services.graphicCache.clear(), TJS_S_OK));
  cls.staticMethod('touchImages', (_result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    const array = asObjectClosure(args[0]!);
    const storages: string[] = [];
    const val = new VariantSlot();
    for (let count = 0; ; count++) {
      if (!array.object) break;
      if (array.object.propGetByNum(0, count, val, array.objthis ?? array.object) < 0) break;
      if (val.value.type === 0) break;
      storages.push(asString(val.value));
    }
    val.clear();
    const limit = paramExists(args, 1) ? asInteger(args[1]!) : 0n;
    const timeout = paramExists(args, 2) ? asInteger(args[2]!) : 0n;
    services.graphicCache.touch(storages, limit, BigInt.asUintN(64, timeout));
    return TJS_S_OK;
  });
  cls.staticMethod('createUUID', (result) => {
    const uuid = services.randomBits128().slice(0, 16);
    uuid[8] = (uuid[8]! & 0x3f) | 0x80;
    uuid[6] = (uuid[6]! & 0x0f) | 0x40;
    const h = Array.from(uuid, (b) => b.toString(16).padStart(2, '0')).join('');
    const text = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    return done(result, str(text));
  });
  cls.staticMethod('assignMessage', (result, args) => {
    if (args.length < 2) return TJS_E_BADPARAMCOUNT;
    const res = services.assignMessage(asString(args[0]!), asString(args[1]!));
    return done(result, int(res ? 1 : 0));
  });
  cls.staticMethod('doCompact', (_result, args) => {
    const level = paramExists(args, 0) ? asInt32(args[0]!) : TVP_COMPACT_LEVEL_MAX;
    return events.deliverCompactEvent(level);
  });
  cls.staticProperty('versionString', {get: getter(() => str(services.versionString()))});
  cls.staticProperty('versionInformation', {
    get: getter(() => str(services.versionInformation())),
  });
  cls.staticProperty('eventDisabled', {
    get: getter(() => int(events.systemEventDisabled ? 1 : 0)),
    set: (value) => events.setSystemEventDisabled(asBoolean(value)),
  });
  cls.staticProperty('graphicCacheLimit', {
    get: getter(() => integer(BigInt.asIntN(32, services.graphicCache.limit()))),
    set: (value) => (
      services.graphicCache.setLimit(BigInt.asUintN(64, BigInt(asInt32(value)))),
      TJS_S_OK
    ),
  });
  cls.staticProperty('platformName', {get: getter(() => str('Win32'))});
  cls.staticProperty('osName', {get: getter(() => str(osName(platform.version)))});
  cls.staticProperty('exitOnWindowClose', {
    get: getter(() => int(services.flags.exitOnWindowClose ? 1 : 0)),
    set: (value) => ((services.flags.exitOnWindowClose = asInt32(value) !== 0), TJS_S_OK),
  });
  cls.staticProperty('drawThreadNum', {
    get: getter(() => int(services.flags.drawThreadNum)),
    set: (value) => ((services.flags.drawThreadNum = asInt32(value)), TJS_S_OK),
  });
  cls.staticProperty('processorNum', {get: getter(() => int(platform.processorCount))});
  cls.staticProperty('exitOnNoWindowStartup', {
    get: getter(() => int(services.flags.exitOnNoWindowStartup ? 1 : 0)),
    set: (value) => ((services.flags.exitOnNoWindowStartup = asInt32(value) !== 0), TJS_S_OK),
  });
  // The default handlers: null objects.
  for (const name of ['exceptionHandler', 'onActivate', 'onDeactivate'])
    cls.propSet(TJS_MEMBERENSURE, name, NULL_OBJECT, cls);

  // --- SystemImpl.cpp ---------------------------------------------------------------------
  cls.staticMethod('inform', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    const text = asString(args[0]!);
    const caption = paramExists(args, 1) ? asString(args[1]!) : 'Information';
    return services.suspender.suspend(platform.informationBox(text, caption), () => {
      result?.clear();
      return TJS_S_OK;
    });
  });
  cls.staticMethod('getTickCount', (result) =>
    result ? done(result, integer(BigInt(services.tickCount()))) : TJS_S_OK,
  );
  cls.staticMethod('getKeyState', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    const code = asInt32(args[0]!) >>> 0;
    const current = args.length >= 2 ? asInt32(args[1]!) !== 0 : true;
    return done(result, int(platform.asyncKeyState(code, current) ? 1 : 0));
  });
  cls.staticMethod('shellExecute', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    const target = asString(args[0]!);
    const param = args.length >= 2 ? asString(args[1]!) : '';
    return done(result, int(platform.shellExecute(target, param) ? 1 : 0));
  });
  cls.staticMethod('system', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    const ret = platform.system(asString(args[0]!));
    const hr = events.deliverCompactEvent(TVP_COMPACT_LEVEL_MAX);
    const finish = () => done(result, int(ret));
    return hr === TJS_E_SUSPENDED ? services.suspender.defer(() => finish()) : finish();
  });
  cls.staticMethod('readRegValue', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    if (!result) return TJS_S_OK;
    const path = asString(args[0]!);
    if (path === '') return (result.clear(), TJS_S_OK);
    const {root, key, value} = splitRegistryPath(path);
    return services.suspender.suspend(platform.readRegValue(root, key, value), (v) => {
      if (v === null) result.clear();
      else result.set(typeof v === 'number' ? integer(BigInt(v)) : str(v));
      return TJS_S_OK;
    });
  });
  cls.staticMethod('getArgument', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    if (!result) return TJS_S_OK;
    const v = services.getArgument(asString(args[0]!));
    return done(result, v === null ? VOID : str(v));
  });
  cls.staticMethod('setArgument', (_result, args) => {
    if (args.length < 2) return TJS_E_BADPARAMCOUNT;
    services.setArgument(asString(args[0]!), asString(args[1]!));
    return TJS_S_OK;
  });
  cls.staticMethod('createAppLock', (result, args) => {
    if (args.length < 1) return TJS_E_BADPARAMCOUNT;
    if (!result) return TJS_S_OK;
    return done(result, int(createAppLock(platform, asString(args[0]!)) ? 1 : 0));
  });
  cls.staticMethod('dumpHeap', () => (services.dumpHeap(), TJS_S_OK));
  cls.staticMethod('nullpo', () => {
    // `*(int *)0 = 0`: an access violation ends the process.
    throw new Error('System.nullpo: access violation writing address 0x00000000');
  });
  cls.staticMethod('showVersion', () =>
    services.suspender.suspend(platform.showVersion(services.versionInformation()), () => TJS_S_OK),
  );
  cls.staticProperty('exePath', {get: getter(() => str(services.appPath()))});
  cls.staticProperty('personalPath', {get: getter(() => str(services.personalPath()))});
  cls.staticProperty('appDataPath', {get: getter(() => str(services.appDataPath()))});
  cls.staticProperty('dataPath', {get: getter(() => str(services.dataPath()))});
  cls.staticProperty('exeName', {get: getter(() => str(services.exeName()))});
  cls.staticProperty('savedGamesPath', {get: getter(() => str(services.savedGamesPath()))});
  cls.staticProperty('title', {
    get: getter(() => str(services.title())),
    set: (value) => (services.setTitle(asString(value)), TJS_S_OK),
  });
  const screen = (f: (s: ReturnType<KirikiriSystemPlatform['screen']>) => number) =>
    getter(() => int(f(platform.screen())));
  cls.staticProperty('screenWidth', {get: screen((s) => s.width)});
  cls.staticProperty('screenHeight', {get: screen((s) => s.height)});
  cls.staticProperty('desktopLeft', {get: screen((s) => s.desktopLeft)});
  cls.staticProperty('desktopTop', {get: screen((s) => s.desktopTop)});
  cls.staticProperty('desktopWidth', {get: screen((s) => s.desktopWidth)});
  cls.staticProperty('desktopHeight', {get: screen((s) => s.desktopHeight)});
  cls.staticProperty('touchDevice', {get: getter(() => int(platform.touchDevice()))});
  return cls;
}
